/**
 * CALIBRATION BATTERY — PLANTED EDGES (the gauntlet must NOT under-kill).
 *
 * The companion of `known-false-positives.test.ts`. A gauntlet that KILLs everything
 * is just as broken as one that certifies noise — it would have no power to recognize
 * a real edge if one existed. This file plants GENUINE edges, tests each with the
 * RIGHT committed gate, and asserts each reaches a non-KILL verdict. Together the two
 * files bracket the gauntlet's decision boundary: it neither over-certifies the
 * false-positive battery nor under-certifies these true positives.
 *
 * The key discipline ("test it the RIGHT way") is itself part of the calibration:
 *   - a SEARCHED grid must be judged family-wise (validateStrategyFamily), because its
 *     winner was chosen by taking a maximum over N configs;
 *   - a single, PRE-REGISTERED (N=1) hypothesis is judged by the single-series
 *     gauntlet (validateStrategy) at an honest trialCount of 1, with real baselines.
 * Using the wrong test would either under-kill (naive single-config p on a grid) or
 * needlessly over-kill (family-wise penalty on a thing that was never searched).
 *
 * Every case is seeded and deterministic; every effect size is chosen with a safe,
 * non-knife-edge margin so the result is robust to the surrogate RNG, not lucky.
 *
 * WHAT EACH CASE PROVES
 * ---------------------
 *   1. GENUINE CROSS-SECTIONAL ROTATION (family-wise) — a grid searched over a panel
 *      whose signal genuinely predicts each asset's return. Judged by the family-wise
 *      MAX-statistic null (validateStrategyFamily), the real grid-best STRICTLY clears
 *      surr95 of the surrogate grid-maxima, because the cross-sectional shuffle destroys
 *      the predictor→return link for EVERY config (including the lucky maximum). This
 *      proves the family-wise gate has power: it passes a real searched edge while (per
 *      the companion file) killing a searched non-edge.
 *
 *   2. PRE-REGISTERED (N=1) TIMING SIGNAL — a single, NOT-searched timing rule with a
 *      real, strictly-lagged drift, supplied with matched baselines (a market it beats,
 *      an equal-weight panel). At an honest trialCount of 1 (no multiple-testing
 *      penalty to pay, because nothing was searched) it must reach a non-KILL verdict
 *      (SURVIVE, or at least PROMISING) — it survives net-of-cost, beats its baselines,
 *      beats the surrogate null, and confirms out-of-sample on the consume-once holdout.
 *      This proves the single-series gauntlet does not reflexively kill a real, honestly
 *      pre-registered edge.
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

/** A non-KILL scientific verdict is the success bar for a planted single-series edge. */
const NON_KILL: readonly ScientificVerdict[] = ["SURVIVE", "PROMISING"];

// --- 1. genuine cross-sectional rotation edge (family-wise) --------------------

describe("planted edge #1 — genuine cross-sectional rotation passes the family-wise null", () => {
  // A panel carries, per asset, a per-period PREDICTOR and a per-period RETURN. The
  // edge lives in the predictor→return LINK (ret = beta·signal + noise), so a rotation
  // rule that goes long high-signal assets harvests a real cross-sectional spread. The
  // cross-sectional shuffle null re-pairs each asset's signal with an unrelated asset's
  // returns, destroying the link, so EVERY config (incl. the grid-max) collapses to ~0.
  interface Panel {
    signal: number[][];
    ret: number[][];
  }
  interface RotationConfig {
    threshold: number;
  }

  function makePlantedPanel(
    n: number,
    nAssets: number,
    beta: number,
    vol: number,
    seed: string,
  ): Panel {
    const rnd = seededRandom(seed);
    const signal: number[][] = Array.from({ length: nAssets }, () => [] as number[]);
    const ret: number[][] = Array.from({ length: nAssets }, () => [] as number[]);
    for (let t = 0; t < n; t += 1) {
      for (let a = 0; a < nAssets; a += 1) {
        const s = gaussian(rnd);
        signal[a]!.push(s);
        ret[a]!.push(beta * s + gaussian(rnd) * vol); // genuine predictor→return link
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

  it("the real grid-best STRICTLY clears surr95 of the surrogate grid-maxima ⇒ PASS", () => {
    const nAssets = 8;
    const nConfigs = 12;
    // beta=0.014 vs vol=0.01 ⇒ a comfortably real predictor (safe, non-knife-edge margin).
    const panel = makePlantedPanel(600, nAssets, 0.014, 0.01, "planted-rotation-606");
    const family: StrategyFamily<Panel, RotationConfig> = {
      id: "planted-rotation-sweep",
      configs: rotationGrid(nConfigs),
      buildReturns: rotationReturns,
      makeSurrogatePanel: shufflePanel,
    };

    const verdict = validateStrategyFamily(panel, family, {
      iterations: 200,
      statistic: "sharpe",
      seed: "planted-rotation-surrogate",
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.honestN).toBe(nConfigs);
    // The real grid-best STRICTLY clears the family-wise bar...
    expect(verdict.realBestStat).toBeGreaterThan(verdict.surr95);
    // ...and no surrogate grid-max reaches it (family-wise p well under 5%).
    expect(verdict.surrogateMaxP).toBeLessThan(0.05);
  });
});

// --- 2. pre-registered (N=1) timing signal with real drift + baselines ---------

describe("planted edge #2 — pre-registered N=1 timing signal reaches a non-KILL verdict", () => {
  /**
   * A genuine, NOT-searched timing edge. At each step exactly one asset is the "active"
   * one, known STRICTLY BEFORE the bar (last bar's state, so no look-ahead), and that
   * asset carries a real positive drift this bar. The pre-registered rule is "be long
   * the active asset", harvesting only its drift. Because this is ONE pre-registered
   * hypothesis (not a grid), the honest trialCount is 1.
   *
   * WHY THE EDGE IS CROSS-SECTIONAL (and tested with a panel + cross-sectional null):
   *   The single-series phase/block surrogate preserves a realized sleeve's marginal
   *   distribution — hence its mean AND variance, hence its Sharpe — so it cannot, by
   *   construction, discriminate a one-asset realized P&L (phaseMean ≈ realScore for
   *   ANY series). The HONEST null for a timing edge must destroy the alignment between
   *   the timing signal and the asset paths. We therefore supply the asset panel and a
   *   cross-sectional shuffle null (the same construction the committed rotation test
   *   uses): the shuffle re-pairs the timing with the wrong asset paths, collapsing the
   *   sleeve to ~0 on every draw, so the real, aligned sleeve crushes the null.
   */
  function makeTimingEdge(
    n: number,
    nAssets: number,
    drift: number,
    vol: number,
    seed: string,
  ): { sleeve: number[]; panel: number[][]; market: number[] } {
    const rnd = seededRandom(seed);
    const panel: number[][] = Array.from({ length: nAssets }, () => [] as number[]);
    const sleeve: number[] = [];
    const market: number[] = [];
    let active = 0;
    let prevActive = 0; // the active asset known at the START of the bar (strictly lagged)
    for (let t = 0; t < n; t += 1) {
      let sleeveRet = 0;
      let mkt = 0;
      for (let a = 0; a < nAssets; a += 1) {
        // The active asset (chosen LAST bar) carries the real drift THIS bar; trading on
        // prevActive is therefore leak-free.
        let r = gaussian(rnd) * vol;
        if (a === prevActive) r += drift;
        panel[a]!.push(r);
        mkt += r;
        if (a === prevActive) sleeveRet = r;
      }
      sleeve.push(sleeveRet);
      market.push(mkt / nAssets);
      // Slowly rotate which asset is active (a persistent regime).
      if (rnd() > 0.9) active = Math.floor(rnd() * nAssets);
      prevActive = active;
    }
    return { sleeve, panel, market };
  }

  it("at honest N=1 with matched baselines it is SURVIVE or PROMISING (not KILL)", () => {
    // Long window so the OOS holdout vault is substantial; a comfortably real drift
    // relative to vol (safe margin, not knife-edge).
    const n = 1200;
    const { sleeve, panel, market } = makeTimingEdge(n, 5, 0.012, 0.008, "planted-timing-707");

    const verdict = validateStrategy(sleeve, {
      trialCount: 1, // PRE-REGISTERED: a single hypothesis, no search ⇒ honest N = 1
      statistic: "sharpe",
      cost: { takerPerSide: 0 },
      // Matched baselines: the underlying market (buy-and-hold over the equal-weight
      // panel) and a flat equal-weight sleeve. The timing edge beats passive exposure
      // because it concentrates into the asset that is actually drifting.
      baselines: {
        marketReturns: market,
        equalWeightReturns: Array.from({ length: n }, () => 0),
        roundTripCost: 0,
      },
      // The honest null for a timing edge: destroy the signal→asset alignment via a
      // cross-sectional shuffle of the asset panel (a single-series phase/block null
      // cannot discriminate a realized one-asset P&L — it preserves its Sharpe).
      surrogate: {
        iterations: 200,
        crossSectional: true,
        panel: { assetReturns: panel },
        seed: "planted-timing-surrogate",
      },
      minDeflatedProbability: 0.95,
      seed: "planted-timing",
    });

    // The verdict must be a NON-KILL: the gauntlet recognizes a real, pre-registered edge.
    expect(NON_KILL).toContain(verdict.scientificVerdict);

    // The CORE gates a real edge must clear all pass (these are what separate SURVIVE/
    // PROMISING from KILL):
    const byId = (id: string) => verdict.perGate.find((g) => g.id === id)!;
    expect(byId("net_of_cost").status).toBe("PASS"); // genuinely net-positive
    expect(byId("baselines").status).toBe("PASS"); // beats matched-exposure B&H + EW
    expect(byId("surrogate").status).toBe("PASS"); // beats the timing-destroying null
    expect(byId("holdout").status).toBe("PASS"); // confirmed out-of-sample (the vault)

    // The surrogate (the hero) must show the real edge crushing the null, not a coin flip.
    expect(byId("surrogate").detail.placeboP as number).toBeLessThanOrEqual(0.05);
  });
});
