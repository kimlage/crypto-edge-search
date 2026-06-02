/**
 * CALIBRATION BATTERY — KNOWN FALSE POSITIVES (the gauntlet must NOT over-certify).
 *
 * A test harness that only ever says KILL is useless; one that ever says SURVIVE
 * to a non-edge is dangerous. This file is the second half of that calibration:
 * it feeds the COMMITTED `validateStrategy` / `validateStrategyFamily` a battery of
 * things that LOOK like edges to a naive backtest but are not, and asserts that the
 * gauntlet refuses to certify each one (scientificVerdict ∈ {KILL, INDETERMINATE},
 * never SURVIVE/PROMISING). The companion file `planted-edges.test.ts` proves the
 * other direction — that real, correctly-tested edges are NOT under-killed.
 *
 * Every case is seeded and deterministic; every margin is deliberately well clear of
 * the decision boundary (no knife-edge) so the battery is robust, not lucky.
 *
 * WHAT EACH CASE PROVES
 * ---------------------
 *   1. PURE SEEDED NOISE — a mean-zero Gaussian series has no edge of any kind. It must
 *      die (the net/surrogate/bootstrap stack rejects it), proving the gauntlet does not
 *      reward an in-sample fluctuation. scientificVerdict must be KILL.
 *
 *   2. AR(1) AUTOCORRELATION ARTIFACT — a mean-zero series with strong linear (lag-1)
 *      autocorrelation but NO exploitable directional edge. Phase randomization PRESERVES
 *      the power spectrum (hence the autocorrelation), so the surrogate null reproduces
 *      the artifact and the placebo p-value cannot clear the bar. This proves the
 *      surrogate gate is not fooled by linear autocorrelation masquerading as structure.
 *
 *   3. BETA-IN-DISGUISE (long-only sleeve on a rising market) — a sleeve that is just
 *      passive market exposure dressed up as a "strategy". On a rising synthetic market
 *      its raw return looks great, but it must LOSE to the matched-exposure buy-and-hold
 *      baseline (you are paying a manager for what an index fund gives free). The
 *      baselines gate must FAIL → KILL. This proves the gauntlet strips closet beta.
 *
 *   4. SAME-BAR (h=0) LOOK-AHEAD — a signal that peeks at the SAME bar's return earns a
 *      gorgeous in-sample curve. Its strictly-lagged (h=1, tradable) version has no such
 *      foreknowledge and must DIE. This proves that once look-ahead is removed — the only
 *      honest way to trade it — the edge evaporates, so the gauntlet never certifies a
 *      leak. (The leaked h=0 version is shown to look strong, as a contrast.)
 *
 *   5. GRID-BEST-OF-NOISE (family-wise) — search a grid of N configs over a pure-noise
 *      panel and keep the best. Its naive single-config p-value looks "significant", but
 *      the honest family-wise MAX-statistic null (validateStrategyFamily) shows the real
 *      grid-best does NOT clear surr95 of the surrogate grid-maxima — it is merely the
 *      luckiest of N. This proves the family-wise correction kills data-snooped winners.
 */

import { describe, expect, it } from "vitest";

import {
  validateStrategy,
  type ScientificVerdict,
} from "../../src/lib/validation/strategy-validator";
import {
  validateStrategyFamily,
  type StrategyFamily,
} from "../../src/lib/validation/strategy-family-validator";
import { summarizeReturnSeries } from "../../src/lib/statistical-validation";

// --- deterministic helpers (mulberry32, matching the harness's own seeded RNG) ----

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

/** The set of verdicts that mean "NOT certified as a real edge". */
const NOT_CERTIFIED: readonly ScientificVerdict[] = ["KILL", "INDETERMINATE"];

// --- series builders ----------------------------------------------------------

/** Mean-zero seeded Gaussian noise — no edge of any kind. */
function makeNoise(n: number, sigma: number, seed: string): number[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, () => gaussian(rnd) * sigma);
}

/**
 * A mean-zero AR(1) process: x_t = phi·x_{t-1} + shock. Strong linear autocorrelation
 * (the power spectrum is colored), but the unconditional mean is ~0, so there is no
 * directional edge to harvest — only the kind of linear structure phase randomization
 * is designed to reproduce. We center it so the marginal mean stays ~0.
 */
function makeAr1(n: number, phi: number, sigma: number, seed: string): number[] {
  const rnd = seededRandom(seed);
  const raw: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    prev = phi * prev + gaussian(rnd) * sigma;
    raw.push(prev);
  }
  const m = raw.reduce((s, v) => s + v, 0) / raw.length;
  return raw.map((v) => v - m);
}

/**
 * A rising synthetic market: small positive drift + noise, so buy-and-hold genuinely
 * makes money over the window. A "beta-in-disguise" sleeve that is just long this
 * market (minus a tiny implementation drag) should LOSE to a matched-exposure B&H.
 */
function makeRisingMarket(n: number, drift: number, sigma: number, seed: string): number[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, () => drift + gaussian(rnd) * sigma);
}

// --- 1. pure seeded noise -----------------------------------------------------

describe("known-false-positive #1 — pure seeded noise must NOT be certified", () => {
  it("KILLs a mean-zero Gaussian series (no edge to find)", () => {
    const noise = makeNoise(700, 0.01, "kfp-noise-101");
    const verdict = validateStrategy(noise, {
      trialCount: 25,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 200, seed: "kfp-noise-surrogate" },
      seed: "kfp-noise",
    });

    expect(verdict.verdict).toBe("KILL");
    expect(NOT_CERTIFIED).toContain(verdict.scientificVerdict);
    // A real gate must do the killing — not a vacuous fall-through.
    expect(verdict.bindingGate).not.toBeNull();
  });
});

// --- 2. AR(1) autocorrelation artifact ----------------------------------------

describe("known-false-positive #2 — AR(1) autocorrelation artifact must NOT be certified", () => {
  it("the surrogate (phase) null reproduces the linear structure ⇒ KILL", () => {
    // Strong lag-1 autocorrelation, zero mean: looks 'structured' but has no edge.
    const ar1 = makeAr1(700, 0.7, 0.01, "kfp-ar1-202");
    const verdict = validateStrategy(ar1, {
      trialCount: 10,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 200, seed: "kfp-ar1-surrogate" },
      seed: "kfp-ar1",
    });

    expect(verdict.verdict).toBe("KILL");
    expect(NOT_CERTIFIED).toContain(verdict.scientificVerdict);
    // The surrogate gate must NOT be fooled: phase randomization preserves the
    // autocorrelation, so the placebo p-value cannot clear the 5% bar. (The series
    // may die at an earlier gate too; we assert the hero gate specifically is not a
    // false PASS.)
    const surrogate = verdict.perGate.find((g) => g.id === "surrogate")!;
    expect(surrogate.passed).toBe(false);
    expect(surrogate.detail.placeboP as number).toBeGreaterThan(0.05);
  });
});

// --- 3. beta-in-disguise long-only sleeve -------------------------------------

describe("known-false-positive #3 — beta-in-disguise must lose to matched-exposure B&H", () => {
  it("a long-only market sleeve FAILs the baselines gate ⇒ KILL", () => {
    // The market rises (drift > 0), so the sleeve's RAW return looks attractive...
    const market = makeRisingMarket(700, 0.0015, 0.01, "kfp-beta-303");
    // ...but the sleeve is just that market minus a tiny, honest implementation drag,
    // i.e. pure closet beta. A matched-exposure buy-and-hold (the SAME market) gets the
    // beta for free, so the sleeve must lose to it.
    const drag = 0.0002;
    const sleeve = market.map((r) => r - drag);

    // Sanity: the sleeve really does make money on its own (so this is a genuine
    // false-positive trap, not a trivially-negative series).
    expect(summarizeReturnSeries(sleeve).compoundReturn).toBeGreaterThan(0);

    const verdict = validateStrategy(sleeve, {
      trialCount: 1,
      statistic: "compoundReturn",
      cost: { takerPerSide: 0 },
      // Matched-exposure baseline: hold the SAME market the sleeve is secretly tracking.
      baselines: { marketReturns: market, roundTripCost: 0 },
      surrogate: { iterations: 120, seed: "kfp-beta-surrogate" },
      seed: "kfp-beta",
    });

    // It is the BASELINES gate that exposes the closet beta.
    const baselines = verdict.perGate.find((g) => g.id === "baselines")!;
    expect(baselines.status).toBe("FAIL");
    expect(baselines.passed).toBe(false);
    expect(verdict.bindingGate).toBe("baselines");
    expect(verdict.verdict).toBe("KILL");
    expect(verdict.scientificVerdict).toBe("KILL");
  });
});

// --- 4. same-bar (h=0) look-ahead ---------------------------------------------

describe("known-false-positive #4 — same-bar look-ahead dies once strictly lagged", () => {
  it("the leaked h=0 signal looks strong but its tradable h=1 version is KILLed", () => {
    // A market with NO real autocorrelation — any apparent edge from trading it must
    // come from foreknowledge, not from structure.
    const rnd = seededRandom("kfp-lookahead-404");
    const market = Array.from({ length: 700 }, () => gaussian(rnd) * 0.01);

    // LEAKED (h=0) signal: trade in the SAME bar's direction → sign(r_t)·r_t = |r_t|.
    // This is impossible to trade (you cannot know r_t when you place the bar-t trade),
    // but it produces a beautiful, strictly-positive in-sample curve (every bar wins).
    const leaked = market.map((r) => Math.sign(r) * r); // = |r|, always ≥ 0
    // STRICTLY-LAGGED (h=1) version: use only YESTERDAY's sign on today's return —
    // the only honest, tradable form. With no autocorrelation this is ~mean-zero noise.
    const tradable = market.map((r, t) =>
      t === 0 ? 0 : Math.sign(market[t - 1]!) * r,
    );

    // Contrast: the leaked version is conspicuously, strictly positive every bar (the
    // trap), while the tradable version is mean-zero noise. The leaked Sharpe is the
    // half-normal mean/std (~1.3) and its compound return is strongly positive; the
    // tradable one's compound return is not — quantifying the look-ahead illusion.
    const leakedStats = summarizeReturnSeries(leaked);
    const tradableStats = summarizeReturnSeries(tradable);
    expect(leakedStats.positiveRate).toBe(1); // h=0 wins on literally every bar
    expect(leakedStats.sharpe).toBeGreaterThan(1); // beautiful in-sample curve
    expect(leakedStats.compoundReturn).toBeGreaterThan(0);
    // The leak is the ONLY source of the edge: the tradable version is far weaker.
    expect(tradableStats.sharpe).toBeLessThan(leakedStats.sharpe - 1);

    const verdict = validateStrategy(tradable, {
      trialCount: 5,
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      surrogate: { iterations: 200, seed: "kfp-lookahead-surrogate" },
      seed: "kfp-lookahead",
    });

    // The tradable, leak-free version has no edge → KILL.
    expect(verdict.verdict).toBe("KILL");
    expect(NOT_CERTIFIED).toContain(verdict.scientificVerdict);
    expect(verdict.bindingGate).not.toBeNull();
  });
});

// --- 5. grid-best-of-noise (family-wise) --------------------------------------

describe("known-false-positive #5 — grid-best-of-noise dies under the family-wise null", () => {
  // A panel of independent (signal ⟂ return) assets: searching any rotation grid over
  // it can only ever find the luckiest of N. The cross-sectional shuffle null draws
  // surrogate grid-maxima from that SAME luckiest-of-N distribution.
  interface Panel {
    signal: number[][];
    ret: number[][];
  }
  interface RotationConfig {
    threshold: number;
  }

  function makeNoisePanel(n: number, nAssets: number, vol: number, seed: string): Panel {
    const rnd = seededRandom(seed);
    const signal: number[][] = Array.from({ length: nAssets }, () => [] as number[]);
    const ret: number[][] = Array.from({ length: nAssets }, () => [] as number[]);
    for (let t = 0; t < n; t += 1) {
      for (let a = 0; a < nAssets; a += 1) {
        signal[a]!.push(gaussian(rnd)); // signal ⟂ return: pure noise grid
        ret[a]!.push(gaussian(rnd) * vol);
      }
    }
    return { signal, ret };
  }

  function shufflePanel(panel: Panel, seed: number): Panel {
    const rnd = seededRandom(seed);
    const nAssets = panel.ret.length;
    const idx = Array.from({ length: nAssets }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    return {
      signal: panel.signal.map((s) => [...s]),
      ret: idx.map((i) => [...panel.ret[i]!]),
    };
  }

  function rotationReturns(panel: Panel, config: RotationConfig): number[] {
    const nAssets = panel.ret.length;
    const n = panel.ret[0]?.length ?? 0;
    const out: number[] = [];
    for (let t = 0; t < n; t += 1) {
      let sum = 0;
      let count = 0;
      for (let a = 0; a < nAssets; a += 1) {
        if ((panel.signal[a]![t] ?? 0) > config.threshold) {
          sum += panel.ret[a]![t] ?? 0;
          count += 1;
        }
      }
      out.push(count > 0 ? sum / count : 0);
    }
    return out;
  }

  function rotationGrid(nConfigs: number): RotationConfig[] {
    return Array.from({ length: nConfigs }, (_, i) => ({ threshold: i / (nConfigs * 2) }));
  }

  it("the real grid-best does NOT clear surr95 of the surrogate grid-maxima ⇒ KILL", () => {
    const nAssets = 8;
    const nConfigs = 24;
    const panel = makeNoisePanel(600, nAssets, 0.01, "kfp-grid-505");
    const family: StrategyFamily<Panel, RotationConfig> = {
      id: "kfp-grid-best-of-noise",
      configs: rotationGrid(nConfigs),
      buildReturns: rotationReturns,
      makeSurrogatePanel: shufflePanel,
    };

    const verdict = validateStrategyFamily(panel, family, {
      iterations: 200,
      statistic: "sharpe",
      seed: "kfp-grid-surrogate",
    });

    // The family-wise max-stat correction refuses to certify: real best < surr95(max).
    expect(verdict.passed).toBe(false);
    expect(verdict.honestN).toBe(nConfigs);
    expect(verdict.realBestStat).toBeLessThanOrEqual(verdict.surr95 + 1e-12);
    expect(verdict.surrogateMaxP).toBeGreaterThan(0.05);

    // ...and the naive single-config p of that same lucky winner UNDERSTATES the risk
    // (it ignores the search), which is exactly why the family-wise null is required.
    const best = verdict.realScores[0]!;
    const rnd = seededRandom("kfp-grid-naive-null");
    const singleConfigNull: number[] = [];
    for (let it = 0; it < 200; it += 1) {
      const surrogate = shufflePanel(panel, (rnd() * 2 ** 32) >>> 0);
      singleConfigNull.push(summarizeReturnSeries(rotationReturns(surrogate, best.config)).sharpe);
    }
    const naiveP =
      singleConfigNull.filter((s) => s >= best.stat - 1e-12).length / singleConfigNull.length;
    expect(naiveP).toBeLessThan(verdict.surrogateMaxP);
  });
});
