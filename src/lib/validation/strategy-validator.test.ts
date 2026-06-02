/**
 * Tests for the composed anti-overfitting gauntlet (`validateStrategy`) and its
 * surrogate/placebo null generators.
 *
 * Coverage (per the remediation review docs/PROJECT_REVIEW.md H3/H4/H5/M1/M2):
 *   1. HOLDOUT ISOLATION — mutating the most-recent vault rows must NOT change any
 *      in-sample gate's detail; only Gate 7 (holdout) may move. (fixes the H3 leak)
 *   2. PURE NOISE KILLs — a seeded mean-zero series cannot be certified.
 *   3. PLANTED EDGE → expected verdict — a genuine cross-sectional (rotation) edge,
 *      whose structure the surrogate nulls destroy, reaches a PASS.
 *   4. DETERMINISM — two identical calls return byte-identical verdicts.
 *   5. DSR trialCount flip — raising the honest N flips a borderline DSR PASS→KILL.
 *   6. PBO SKIP — with no genuine strategies×folds matrix the PBO gate is skipped
 *      (passed:true, skipped:true), never a confident self-vs-zero PASS. (fixes H5)
 *   7. SURROGATE GENERATORS — phase randomization preserves variance + lag-1
 *      autocorrelation; the block bootstrap preserves the marginal mean. (M1)
 *   8. FFT PERF — the surrogate completes on a realistic-length series in well under
 *      a second (the naive O(n²) DFT timed out >5min). (M2)
 *
 * Audit-driven additions:
 *   9.  BLOCK-BOOTSTRAP GATE — a new gate between deflated_sharpe and cpcv_pbo;
 *       PASSes iff the resampled CI lower bound > 0, exposes ci.lower/ci.upper, and is
 *       vault-invariant (scored on the in-sample slice).
 *  10.  SCIENTIFIC VERDICT — planted-edge(+baselines)→SURVIVE, DSR-family-only-fail→
 *       PROMISING, noise→KILL, no-baselines→INDETERMINATE (capped below SURVIVE).
 *  11.  GATE STATUS — every gate carries PASS|FAIL|SKIP|ADVISORY alongside `passed`;
 *       a skipped PBO is SKIP (not a confident PASS).
 *  12.  STRICT BASELINES — with no baselines, strict mode FAILs (→INDETERMINATE)
 *       while the default stays ADVISORY/passed:true for back-compat.
 */

import { describe, expect, it } from "vitest";

import {
  validateStrategy,
  phaseRandomize,
  blockBootstrap,
  type GateOutcome,
  type StrategyValidatorVerdict,
} from "./strategy-validator";
import { DEFAULT_TAKER_MODEL } from "../cost/execution-cost-model";

// --- deterministic helpers ---------------------------------------------------

/** mulberry32, matching the harness's own seeded RNG so tests are reproducible. */
function seededRandom(seed: number | string): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function gaussian(rnd: () => number): number {
  const u1 = Math.max(1e-12, rnd());
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function variance(values: readonly number[]): number {
  const m = mean(values);
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
}

/** Lag-1 autocorrelation (the linear structure phase randomization must preserve). */
function lag1Autocorr(values: readonly number[]): number {
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) den += (values[i] - m) ** 2;
  for (let i = 1; i < values.length; i += 1) num += (values[i] - m) * (values[i - 1] - m);
  return den > 0 ? num / den : 0;
}

function gate(verdict: StrategyValidatorVerdict, id: GateOutcome["id"]): GateOutcome {
  const g = verdict.perGate.find((entry) => entry.id === id);
  if (!g) throw new Error(`gate ${id} not found`);
  return g;
}

// --- series builders ---------------------------------------------------------

/** Mean-zero seeded Gaussian noise — must never be certified. */
function makeNoise(n: number, sigma: number, seed: string): number[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, () => gaussian(rnd) * sigma);
}

/** Borderline-Sharpe series whose DSR flips PASS→KILL as the honest N rises. */
function makeBorderlineSharpe(n: number, drift: number, vol: number, seed: string): number[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, () => drift + gaussian(rnd) * vol);
}

/**
 * A genuine PURE relative-value / rotation edge. Every asset's unconditional mean
 * is ~0 (so its phase/block single-asset surrogates score ~0), but at each step the
 * strategy is long the transient winner and short the transient loser, harvesting a
 * real cross-sectional spread. A cross-sectional shuffle (which reassigns paths to
 * assets) destroys the rotation, so the surrogate nulls all collapse to ~0 and the
 * real sleeve beats them — the gauntlet correctly certifies it.
 */
function makeRotationEdge(
  n: number,
  nAssets: number,
  edge: number,
  noise: number,
  seed: string,
): { sleeve: number[]; panel: number[][] } {
  const rnd = seededRandom(seed);
  const panel: number[][] = Array.from({ length: nAssets }, () => [] as number[]);
  const sleeve: number[] = [];
  for (let t = 0; t < n; t += 1) {
    const winner = Math.floor(rnd() * nAssets);
    let loser = Math.floor(rnd() * nAssets);
    if (loser === winner) loser = (loser + 1) % nAssets;
    let sleeveReturn = 0;
    for (let a = 0; a < nAssets; a += 1) {
      let ret = (rnd() - 0.5) * noise;
      if (a === winner) ret += edge;
      if (a === loser) ret -= edge;
      panel[a].push(ret);
      if (a === winner) sleeveReturn += ret;
      if (a === loser) sleeveReturn -= ret;
    }
    sleeve.push(sleeveReturn / 2);
  }
  return { sleeve, panel };
}

// --- tests -------------------------------------------------------------------

describe("validateStrategy — holdout isolation (H3)", () => {
  it("mutating the vault rows does not change any in-sample gate detail", () => {
    const rnd = seededRandom("holdout-iso");
    const base = Array.from({ length: 600 }, () => 0.002 + (rnd() - 0.5) * 0.004);

    const options = {
      trialCount: 1,
      statistic: "sharpe" as const,
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 60 },
    };
    const before = validateStrategy(base, options);

    // The vault is the most-recent 15% (default holdoutFraction). With 600 rows the
    // split carves search 70% / test 15% / holdout 15% → vault is [510, 600).
    const vaultStart = 510;
    const mutated = [...base];
    for (let i = vaultStart; i < base.length; i += 1) mutated[i] = -5; // catastrophic
    const after = validateStrategy(mutated, options);

    const inSampleGates: GateOutcome["id"][] = [
      "net_of_cost",
      "baselines",
      "deflated_sharpe",
      "cpcv_pbo",
      "haircut",
      "surrogate",
    ];
    for (const id of inSampleGates) {
      expect(gate(after, id).detail, `in-sample gate ${id} must be vault-invariant`).toEqual(
        gate(before, id).detail,
      );
      expect(gate(after, id).passed).toBe(gate(before, id).passed);
    }

    // The holdout gate, by contrast, MUST react to the mutated vault.
    expect(gate(after, "holdout").detail).not.toEqual(gate(before, "holdout").detail);
    expect(gate(after, "holdout").passed).toBe(false);
    expect(gate(before, "holdout").passed).toBe(true);
  });

  it("the in-sample net stat is scored on the search slice, not the full series", () => {
    // Construct a series whose in-sample slice is strongly positive but whose vault
    // is catastrophically negative. If gates leaked the vault, net_of_cost would see
    // the blended (negative) series; with the fix it sees only the positive slice.
    // (A whiff of noise keeps the in-sample Sharpe finite/positive.)
    const rnd = seededRandom("insample-pos");
    const inSample = Array.from({ length: 510 }, () => 0.003 + (rnd() - 0.5) * 0.0005);
    const vault = Array.from({ length: 90 }, () => -0.5);
    const series = [...inSample, ...vault];
    const verdict = validateStrategy(series, {
      trialCount: 1,
      statistic: "compoundReturn",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 40 },
    });
    // net_of_cost (Gate 1) must be positive — it never saw the -0.5 vault. With the
    // old leak, the blended series mean is negative and Gate 1 would KILL here.
    expect(gate(verdict, "net_of_cost").passed).toBe(true);
    expect(gate(verdict, "net_of_cost").detail.netScore as number).toBeGreaterThan(0);
    // The in-sample net score must reflect ONLY the positive slice (~510 rows),
    // never the -0.5 vault rows.
    expect(gate(verdict, "net_of_cost").detail.sampleCount as number).toBe(510);
    // Gate 7 (holdout) DID see the vault and must KILL it.
    expect(gate(verdict, "holdout").passed).toBe(false);
    expect(gate(verdict, "holdout").detail.vaultScore as number).toBeLessThan(0);
    expect(verdict.verdict).toBe("KILL");
  });
});

describe("validateStrategy — verdicts", () => {
  it("KILLs a pure-noise series", () => {
    const noise = makeNoise(600, 0.01, "pure-noise-42");
    const verdict = validateStrategy(noise, {
      trialCount: 50,
      statistic: "sharpe",
      surrogate: { iterations: 100 },
    });
    expect(verdict.verdict).toBe("KILL");
    // The binding gate must be a real gate (not vacuously surrogate-only); noise is
    // killed early by the net/surrogate stack.
    expect(verdict.bindingGate).not.toBeNull();
  });

  it("certifies a genuine cross-sectional rotation edge (planted edge → PASS)", () => {
    const { sleeve, panel } = makeRotationEdge(700, 6, 0.01, 0.01, "rotation-55");
    const verdict = validateStrategy(sleeve, {
      trialCount: 2,
      statistic: "mean",
      cost: { takerPerSide: 0 },
      surrogate: {
        iterations: 200,
        crossSectional: true,
        panel: { assetReturns: panel },
        seed: "rotation-surrogate",
      },
      minDeflatedProbability: 0.95,
    });
    expect(verdict.verdict).toBe("PASS");
    expect(verdict.bindingGate).toBeNull();
    // The surrogate (the methodological hero) is the gate that proves it is real:
    // the real score must crush the null.
    const surrogate = gate(verdict, "surrogate");
    expect(surrogate.passed).toBe(true);
    expect(surrogate.detail.placeboP as number).toBeLessThanOrEqual(0.05);
    expect(surrogate.detail.realScore as number).toBeGreaterThan(
      Math.abs(surrogate.detail.phaseMean as number),
    );
  });

  it("is deterministic across two identical calls", () => {
    const series = makeBorderlineSharpe(500, 0.0015, 0.01, "determinism");
    const options = {
      trialCount: 10,
      statistic: "sharpe" as const,
      surrogate: { iterations: 80, seed: "det-surrogate" },
      seed: "det",
    };
    const a = validateStrategy(series, options);
    const b = validateStrategy(series, options);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("validateStrategy — deflated Sharpe honesty", () => {
  it("flips a borderline DSR PASS→KILL when the honest trialCount rises", () => {
    // A short, moderate-Sharpe series: honest at N=1 (no multiple-testing penalty),
    // but the expected-max-Sharpe deflation overtakes it once N>1.
    const series = makeBorderlineSharpe(80, 0.0035, 0.02, "dsr-c");

    const atN1 = validateStrategy(series, {
      trialCount: 1,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      minDeflatedProbability: 0.95,
      surrogate: { iterations: 20 },
    });
    const atN5 = validateStrategy(series, {
      trialCount: 5,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      minDeflatedProbability: 0.95,
      surrogate: { iterations: 20 },
    });

    // Same series, same data, only the honest trial count changed.
    expect(gate(atN1, "deflated_sharpe").passed).toBe(true);
    expect(gate(atN5, "deflated_sharpe").passed).toBe(false);
    // The deflated probability must strictly drop as N rises (more deflation).
    expect(gate(atN5, "deflated_sharpe").detail.deflatedProbability as number).toBeLessThan(
      gate(atN1, "deflated_sharpe").detail.deflatedProbability as number,
    );
    // ... and once the DSR fails it is the binding (earliest-failing) constraint.
    expect(atN5.bindingGate).toBe("deflated_sharpe");
  });
});

describe("validateStrategy — PBO gate is non-binding without a genuine matrix (H5)", () => {
  it("skips the PBO gate (passed+skipped) instead of a confident self-vs-zero PASS", () => {
    const series = makeBorderlineSharpe(400, 0.001, 0.01, "pbo-skip");
    const verdict = validateStrategy(series, {
      trialCount: 1,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 20 },
    });
    const pbo = gate(verdict, "cpcv_pbo");
    expect(pbo.passed).toBe(true);
    // status is SKIP — a non-confident, non-binding skip, NOT a confident PASS.
    expect(pbo.status).toBe("SKIP");
    expect(pbo.detail.skipped).toBe(true);
    expect(pbo.detail.derived).toBe(false);
    // No confident numeric PBO is reported — it is explicitly non-binding.
    expect(pbo.detail.pbo).toBeNull();
    expect(pbo.reason.toLowerCase()).toContain("skip");
  });

  it("evaluates a genuine strategies×folds matrix when supplied", () => {
    const folds = Array.from({ length: 8 }, (_, f) =>
      Array.from({ length: 50 }, (_, i) => 0.001 + ((i + f) % 3) * 0.0005),
    );
    const weakFolds = folds.map((fold) => fold.map((v) => v * 0.2 - 0.0005));
    const verdict = validateStrategy(folds.flat(), {
      trialCount: 1,
      statistic: "mean",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 20 },
      cpcv: {
        strategies: [
          { id: "candidate", folds },
          { id: "weak", folds: weakFolds },
        ],
      },
    });
    const pbo = gate(verdict, "cpcv_pbo");
    expect(pbo.detail.skipped).toBe(false);
    expect(pbo.detail.pbo).not.toBeNull();
    // A genuine matrix produces a confident PASS/FAIL status, never SKIP.
    expect(["PASS", "FAIL"]).toContain(pbo.status);
    expect(typeof pbo.detail.foldCount).toBe("number");
    expect(pbo.detail.foldCount as number).toBe(8);
  });
});

describe("validateStrategy — block-bootstrap CI gate", () => {
  it("sits between deflated_sharpe and cpcv_pbo in the documented chain", () => {
    const series = makeBorderlineSharpe(400, 0.001, 0.01, "bb-order");
    const verdict = validateStrategy(series, {
      trialCount: 1,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 20 },
    });
    const ids = verdict.perGate.map((g) => g.id);
    // Full documented chain order.
    expect(ids).toEqual([
      "net_of_cost",
      "baselines",
      "deflated_sharpe",
      "block_bootstrap",
      "cpcv_pbo",
      "haircut",
      "surrogate",
      "holdout",
    ]);
    // ...and specifically AFTER deflated_sharpe, BEFORE cpcv_pbo.
    expect(ids.indexOf("block_bootstrap")).toBeGreaterThan(ids.indexOf("deflated_sharpe"));
    expect(ids.indexOf("block_bootstrap")).toBeLessThan(ids.indexOf("cpcv_pbo"));
  });

  it("PASSes a robust positive edge (CI lower bound > 0) and exposes ci.lower/ci.upper", () => {
    // A strong, low-noise positive drift: the block-bootstrap CI lower bound must
    // stay strictly above zero.
    const rnd = seededRandom("bb-robust");
    const series = Array.from({ length: 500 }, () => 0.003 + (rnd() - 0.5) * 0.0008);
    const verdict = validateStrategy(series, {
      trialCount: 1,
      statistic: "compoundReturn",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 20 },
    });
    const bb = gate(verdict, "block_bootstrap");
    expect(bb.passed).toBe(true);
    expect(bb.status).toBe("PASS");
    // ci.lower / ci.upper are exposed in detail and bracket the estimate.
    const lower = bb.detail.lower as number;
    const upper = bb.detail.upper as number;
    expect(lower).toBeGreaterThan(0);
    expect(upper).toBeGreaterThanOrEqual(lower);
    expect(bb.detail.estimate as number).toBeGreaterThanOrEqual(lower);
    expect(bb.detail.estimate as number).toBeLessThanOrEqual(upper);
  });

  it("FAILs a mean-zero series whose CI straddles zero", () => {
    const noise = makeNoise(500, 0.01, "bb-straddle");
    const verdict = validateStrategy(noise, {
      trialCount: 1,
      statistic: "mean",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 20 },
    });
    const bb = gate(verdict, "block_bootstrap");
    expect(bb.passed).toBe(false);
    expect(bb.status).toBe("FAIL");
    // The lower bound is at or below zero — the edge is not robust to resampling.
    expect(bb.detail.lower as number).toBeLessThanOrEqual(0);
  });

  it("is vault-invariant — mutating the holdout does not move the block-bootstrap CI", () => {
    const rnd = seededRandom("bb-vault");
    const base = Array.from({ length: 600 }, () => 0.002 + (rnd() - 0.5) * 0.004);
    const options = {
      trialCount: 1,
      statistic: "sharpe" as const,
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 40 },
    };
    const before = validateStrategy(base, options);
    const mutated = [...base];
    for (let i = 510; i < base.length; i += 1) mutated[i] = -5;
    const after = validateStrategy(mutated, options);
    expect(gate(after, "block_bootstrap").detail).toEqual(gate(before, "block_bootstrap").detail);
    expect(gate(after, "block_bootstrap").passed).toBe(gate(before, "block_bootstrap").passed);
  });
});

describe("validateStrategy — scientificVerdict mapping", () => {
  // Helper: a flat market the rotation sleeve handily beats, so the baselines gate
  // can be supplied & PASSED (a prerequisite for SURVIVE).
  function weakMarket(n: number, seed: string): number[] {
    const rnd = seededRandom(seed);
    return Array.from({ length: n }, () => -0.0005 + (rnd() - 0.5) * 0.001);
  }

  it("planted-edge with baselines → SURVIVE (all gates pass, SKIPs allowed)", () => {
    const { sleeve, panel } = makeRotationEdge(700, 6, 0.01, 0.01, "rotation-55");
    const verdict = validateStrategy(sleeve, {
      trialCount: 2,
      statistic: "mean",
      cost: { takerPerSide: 0 },
      baselines: {
        marketReturns: weakMarket(700, "survive-mkt"),
        equalWeightReturns: Array.from({ length: 700 }, () => 0),
      },
      surrogate: {
        iterations: 200,
        crossSectional: true,
        panel: { assetReturns: panel },
        seed: "rotation-surrogate",
      },
      minDeflatedProbability: 0.95,
    });
    expect(verdict.verdict).toBe("PASS");
    expect(verdict.scientificVerdict).toBe("SURVIVE");
    // The PBO gate is SKIPped (no matrix) yet SURVIVE is still reached — SKIPs are allowed.
    expect(gate(verdict, "cpcv_pbo").status).toBe("SKIP");
    expect(gate(verdict, "baselines").status).toBe("PASS");
  });

  it("fails ONLY a DSR-family gate while core gates pass → PROMISING (not SURVIVE)", () => {
    // Same genuine rotation edge, but the Harvey-Liu haircut bar is set so tight the
    // haircut gate (a multiple-testing / DSR-family gate) fails — while net_of_cost,
    // baselines, surrogate, and holdout all still pass. That is PROMISING, not KILL.
    const { sleeve, panel } = makeRotationEdge(700, 6, 0.01, 0.01, "rotation-55");
    const verdict = validateStrategy(sleeve, {
      trialCount: 2,
      statistic: "mean",
      cost: { takerPerSide: 0 },
      baselines: {
        marketReturns: weakMarket(700, "promising-mkt"),
        equalWeightReturns: Array.from({ length: 700 }, () => 0),
      },
      maxHaircut: 0.01, // tighter than the ~0.94 haircut → haircut gate FAILS
      surrogate: {
        iterations: 200,
        crossSectional: true,
        panel: { assetReturns: panel },
        seed: "rotation-surrogate",
      },
      minDeflatedProbability: 0.95,
    });
    // Binary verdict is KILL (haircut is the binding gate)...
    expect(verdict.verdict).toBe("KILL");
    expect(verdict.bindingGate).toBe("haircut");
    // ...but the richer scientific verdict recognizes it is only a DSR-family failure.
    expect(verdict.scientificVerdict).toBe("PROMISING");
    expect(gate(verdict, "haircut").status).toBe("FAIL");
    expect(gate(verdict, "net_of_cost").status).toBe("PASS");
    expect(gate(verdict, "surrogate").status).toBe("PASS");
    expect(gate(verdict, "holdout").status).toBe("PASS");
  });

  it("pure noise → KILL", () => {
    const noise = makeNoise(600, 0.01, "pure-noise-42");
    const verdict = validateStrategy(noise, {
      trialCount: 50,
      statistic: "sharpe",
      surrogate: { iterations: 100 },
    });
    expect(verdict.verdict).toBe("KILL");
    expect(verdict.scientificVerdict).toBe("KILL");
  });

  it("baselines absent (non-strict) caps the scientific verdict below SURVIVE", () => {
    // The very same planted edge that SURVIVEs WITH baselines cannot reach SURVIVE
    // without them: the baselines gate is ADVISORY (passed:true, non-binding) but the
    // scientific verdict is capped at INDETERMINATE.
    const { sleeve, panel } = makeRotationEdge(700, 6, 0.01, 0.01, "rotation-55");
    const verdict = validateStrategy(sleeve, {
      trialCount: 2,
      statistic: "mean",
      cost: { takerPerSide: 0 },
      surrogate: {
        iterations: 200,
        crossSectional: true,
        panel: { assetReturns: panel },
        seed: "rotation-surrogate",
      },
      minDeflatedProbability: 0.95,
    });
    // Binary verdict stays PASS (ADVISORY baselines is non-binding, back-compat)...
    expect(verdict.verdict).toBe("PASS");
    expect(gate(verdict, "baselines").status).toBe("ADVISORY");
    expect(gate(verdict, "baselines").passed).toBe(true);
    expect(gate(verdict, "baselines").reason).toContain("not certified");
    // ...but scientificVerdict is NOT SURVIVE — it is INDETERMINATE without baselines.
    expect(verdict.scientificVerdict).toBe("INDETERMINATE");
  });
});

describe("validateStrategy — strict baselines", () => {
  it("with NO baselines supplied, strict mode is a hard FAIL → INDETERMINATE", () => {
    const { sleeve, panel } = makeRotationEdge(700, 6, 0.01, 0.01, "rotation-55");
    const verdict = validateStrategy(sleeve, {
      trialCount: 2,
      statistic: "mean",
      cost: { takerPerSide: 0 },
      strictBaselines: true,
      surrogate: {
        iterations: 200,
        crossSectional: true,
        panel: { assetReturns: panel },
        seed: "rotation-surrogate",
      },
      minDeflatedProbability: 0.95,
    });
    const baselines = gate(verdict, "baselines");
    // Strict: the baselines gate does NOT vacuously certify — it FAILs.
    expect(baselines.status).toBe("FAIL");
    expect(baselines.passed).toBe(false);
    // It is the binding gate (first non-passing) and the scientific verdict is INDETERMINATE.
    expect(verdict.bindingGate).toBe("baselines");
    expect(verdict.scientificVerdict).toBe("INDETERMINATE");
  });

  it("defaults to non-strict (ADVISORY, passed:true) for back-compat", () => {
    const series = makeBorderlineSharpe(400, 0.001, 0.01, "strict-default");
    const verdict = validateStrategy(series, {
      trialCount: 1,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 20 },
    });
    const baselines = gate(verdict, "baselines");
    // Default (no strictBaselines): ADVISORY, passed:true — the legacy vacuous-pass
    // back-compat behavior, so existing PASS verdicts are unchanged.
    expect(baselines.status).toBe("ADVISORY");
    expect(baselines.passed).toBe(true);
  });
});

describe("surrogate generators preserve their analytic invariants (M1)", () => {
  it("phase randomization preserves variance and lag-1 autocorrelation", () => {
    // An AR(1) series has clear linear (lag-1) structure the phase null must keep.
    const rnd = seededRandom("phase-src");
    const series: number[] = [];
    let prev = 0;
    for (let i = 0; i < 512; i += 1) {
      prev = 0.6 * prev + gaussian(rnd) * 0.01;
      series.push(prev);
    }
    const surrogate = phaseRandomize(series, seededRandom("phase-rng"));

    expect(surrogate).toHaveLength(series.length);
    // Variance preserved to within numerical tolerance.
    expect(variance(surrogate) / variance(series)).toBeCloseTo(1, 2);
    // Lag-1 autocorrelation preserved (the power spectrum is held fixed).
    expect(lag1Autocorr(surrogate)).toBeCloseTo(lag1Autocorr(series), 1);
    // Mean is preserved (DC term held), so a carry edge would NOT be discriminated
    // by phase — this is exactly why the surrogate defaults to Sharpe.
    expect(mean(surrogate)).toBeCloseTo(mean(series), 6);
  });

  it("the block bootstrap preserves the marginal mean", () => {
    const rnd = seededRandom("block-src");
    const series = Array.from({ length: 480 }, () => 0.0008 + gaussian(rnd) * 0.01);
    const means: number[] = [];
    const blockRng = seededRandom("block-rng");
    for (let it = 0; it < 200; it += 1) {
      means.push(mean(blockBootstrap(series, 16, blockRng)));
    }
    // The average resampled mean must converge to the source marginal mean.
    expect(mean(means)).toBeCloseTo(mean(series), 3);
    // Every resample has the same length as the source.
    expect(blockBootstrap(series, 16, blockRng)).toHaveLength(series.length);
  });

  it("defaults the surrogate's internal statistic to Sharpe when the outer is compoundReturn", () => {
    // A pure return-premium scored on compoundReturn would land at placeboP≈0.5 if
    // the surrogate also scored compoundReturn (the nulls preserve the mean). The
    // fix re-scores the surrogate on Sharpe, which the surrogate can actually test.
    const series = makeBorderlineSharpe(300, 0.0012, 0.01, "carry-default");
    const verdict = validateStrategy(series, {
      trialCount: 1,
      statistic: "compoundReturn",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 60 },
    });
    expect(gate(verdict, "surrogate").detail.statistic).toBe("sharpe");
  });
});

describe("validateStrategy — leverage-aware costModel (dated-futures leak fix)", () => {
  it("a financing-heavy levered model materially lowers the net-of-cost statistic", () => {
    // Same deterministic series and seed for every call; only the cost treatment
    // changes. The baseline charges ZERO turnover cost (cost.takerPerSide: 0), so the
    // ONLY thing the levered model adds is the risk-free financing carry — sized to
    // the FULL 2.95x levered notional, NOT to one unit. That is the dated-futures leak
    // fix: charging RF on the real ~2.95x notional collapses the net edge.
    const series = makeBorderlineSharpe(500, 0.0015, 0.01, "leverage-carry");
    const base = {
      trialCount: 1,
      statistic: "compoundReturn" as const,
      // Zero-turnover baseline so the financing carry is the only differentiator.
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 20 },
      seed: "lev",
    };

    // (1) WITHOUT a costModel: the default turnover path.
    const without = validateStrategy(series, base);
    // The default path is reproducible — two no-costModel calls are byte-identical.
    const withoutAgain = validateStrategy(series, base);
    expect(JSON.stringify(without)).toBe(JSON.stringify(withoutAgain));

    // (2) WITH a financing-heavy, leverage-aware model on a flat-LONG book at 2.95x.
    const positions = Array.from({ length: series.length }, () => 1); // flat long
    const withModel = validateStrategy(series, {
      ...base,
      costModel: { ...DEFAULT_TAKER_MODEL, riskFreeApr: 0.05 }, // 5%/yr RF on the long leg
      costModelLeverage: 2.95, // the audit's ~2.95x dated-futures leverage
      costModelPositions: positions,
      costModelPeriodsPerYear: 365,
    });

    // The real net statistic for statistic:"compoundReturn" lives in detail.netScore
    // (alongside detail.netSharpe) on the net_of_cost gate.
    const netWithout = gate(without, "net_of_cost").detail.netScore as number;
    const netWith = gate(withModel, "net_of_cost").detail.netScore as number;

    // The levered financing bites: the net statistic is MATERIALLY lower WITH the model.
    expect(netWith).toBeLessThan(netWithout);
    // "Materially" — the 2.95x RF carry erases a large fraction of the net edge,
    // not a rounding-level sliver.
    expect(netWithout - netWith).toBeGreaterThan(0.1);

    // The model path was genuinely taken: turnover is the model's traded notional
    // (~2.95 to establish the levered book), not the default per-period trade count (500).
    expect(gate(withModel, "net_of_cost").detail.turnover as number).toBeLessThan(10);
    expect(gate(without, "net_of_cost").detail.turnover as number).toBeGreaterThan(100);

    // It is the LEVERAGE that bites: the same model at 1x leverage charges the RF carry
    // on one unit, so it lands strictly between the no-model and the 2.95x-levered net.
    const withModelLev1 = validateStrategy(series, {
      ...base,
      costModel: { ...DEFAULT_TAKER_MODEL, riskFreeApr: 0.05 },
      costModelLeverage: 1,
      costModelPositions: positions,
      costModelPeriodsPerYear: 365,
    });
    const netLev1 = gate(withModelLev1, "net_of_cost").detail.netScore as number;
    expect(netLev1).toBeLessThan(netWithout);
    expect(netWith).toBeLessThan(netLev1);
  });
});

describe("surrogate FFT performance (M2)", () => {
  it("runs the surrogate gate on a realistic-length series in well under a second", () => {
    const rnd = seededRandom("perf");
    // 3288 ≈ the real 3-years-of-8h-funding window that hung the naive O(n²) DFT.
    const series = Array.from({ length: 3288 }, () => 0.0005 + (rnd() - 0.5) * 0.02);
    const start = Date.now();
    const verdict = validateStrategy(series, {
      trialCount: 4,
      statistic: "sharpe",
      surrogate: { iterations: 200 },
    });
    const elapsed = Date.now() - start;
    // 8 gates now: the block_bootstrap gate sits between deflated_sharpe and cpcv_pbo.
    expect(verdict.perGate).toHaveLength(8);
    // Generous bound; in practice this completes in a few hundred ms.
    expect(elapsed).toBeLessThan(5_000);
  });
});
