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
 */

import { describe, expect, it } from "vitest";

import {
  validateStrategy,
  phaseRandomize,
  blockBootstrap,
  type GateOutcome,
  type StrategyValidatorVerdict,
} from "./strategy-validator";

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
    expect(typeof pbo.detail.foldCount).toBe("number");
    expect(pbo.detail.foldCount as number).toBe(8);
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
    expect(verdict.perGate).toHaveLength(7);
    // Generous bound; in practice this completes in a few hundred ms.
    expect(elapsed).toBeLessThan(5_000);
  });
});
