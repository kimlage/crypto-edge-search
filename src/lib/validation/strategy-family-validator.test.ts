/**
 * Tests for the FAMILY-WISE MAX-statistic surrogate (`validateStrategyFamily`).
 *
 * This is the gate that flipped three "promising" leads to KILL, so the two load-
 * bearing tests are a planted/null PAIR that prove the correction actually bites:
 *
 *   1. PLANTED EDGE → PASS — a rotation family over a panel whose predictor genuinely
 *      moves each asset's return. The grid-best (a real cross-sectional rotation rule)
 *      clears the surrogate grid-MAX, because the surrogate (a cross-sectional shuffle
 *      that re-pairs each asset's signal with an unrelated asset's returns) destroys
 *      the predictor→return link, so EVERY config — including the lucky maximum —
 *      collapses to ~0 on every draw.
 *
 *   2. PURE-NOISE FAMILY → KILL — a family of N configs over a pure-noise panel. The
 *      real grid-best is just the luckiest of N, and the surrogate grid-MAXIMA are
 *      drawn from the SAME luckiest-of-N distribution, so the real best does NOT clear
 *      surr95. This is the case a naive single-best-config p-value would WRONGLY pass.
 *
 *   3. NAIVE-vs-FAMILY contrast — on that same noise family the luckiest config's
 *      OWN single-config surrogate p-value looks "significant", proving the family-
 *      wise max-correction is what saves us.
 *
 *   4. DETERMINISM, honestN bookkeeping, statistic/quantile plumbing, edge cases.
 */

import { describe, expect, it } from "vitest";

import {
  validateStrategyFamily,
  type StrategyFamily,
} from "./strategy-family-validator";
import { summarizeReturnSeries } from "../statistical-validation";

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

// --- panel + family types under test -----------------------------------------

/**
 * A panel carries, per asset, a per-period PREDICTOR path and a per-period RETURN
 * path. A cross-sectional rotation strategy reads the predictor and goes long the
 * asset(s) it ranks highest. This is the realistic shape: the edge lives in the
 * predictor→return LINK, not in any single marginal.
 */
interface Panel {
  /** signal[asset][t] — the (lagged) cross-sectional predictor. */
  signal: number[][];
  /** ret[asset][t] — the asset's per-period return. */
  ret: number[][];
}
/** A config = a rotation rule: go long any asset whose signal exceeds `threshold`. */
interface RotationConfig {
  threshold: number;
}

/**
 * Cross-sectional shuffle surrogate (the rotation null). Keep every asset's marginal
 * RETURN path and every asset's marginal SIGNAL path, but permute WHICH asset's
 * returns line up with which asset's signals. This DESTROYS the genuine predictor→
 * return link (so a real rotation edge collapses) while preserving every marginal
 * distribution. Deterministic in (panel, seed).
 */
function shufflePanel(panel: Panel, seed: number): Panel {
  const rnd = seededRandom(seed);
  const nAssets = panel.ret.length;
  const idx = Array.from({ length: nAssets }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  // Re-pair: asset a keeps its OWN signal but inherits a permuted asset's returns.
  return {
    signal: panel.signal.map((s) => [...s]),
    ret: idx.map((i) => [...panel.ret[i]!]),
  };
}

/**
 * buildReturns for a rotation config: at each step, equal-weight long every asset
 * whose lagged signal exceeds `threshold` (flat if none qualify). The sleeve return
 * is the mean of the selected assets' returns. When the signal genuinely predicts the
 * return this harvests a real cross-sectional spread; under the shuffle null the
 * predictor points at unrelated returns and the sleeve collapses to ~0.
 */
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

/** The full searched grid: a sweep of rotation thresholds (honest N = thresholds). */
function rotationGrid(nConfigs: number): RotationConfig[] {
  // thresholds from ~0 up: searching the selectivity of the rotation rule.
  return Array.from({ length: nConfigs }, (_, i) => ({ threshold: i / (nConfigs * 2) }));
}

/**
 * PLANTED panel: the signal genuinely predicts each asset's SAME-PERIOD return
 * (ret = beta·signal + noise), so a rotation rule that goes long high-signal assets
 * harvests a real cross-sectional edge. The shuffle null breaks the per-asset signal→
 * return pairing, so EVERY config — including the lucky grid-max — collapses to ~0.
 */
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
      ret[a]!.push(beta * s + gaussian(rnd) * vol);
    }
  }
  return { signal, ret };
}

/**
 * PURE-NOISE panel: signal and returns are independent (beta = 0). No config has any
 * real edge; the grid-best is purely the luckiest of N.
 */
function makeNoisePanel(n: number, nAssets: number, vol: number, seed: string): Panel {
  return makePlantedPanel(n, nAssets, 0, vol, seed);
}

// --- tests -------------------------------------------------------------------

describe("validateStrategyFamily — planted vs noise (the decisive pair)", () => {
  it("PASSES a planted family whose grid-best reads a real cross-sectional signal", () => {
    const nAssets = 8;
    const nConfigs = 12;
    // beta=0.012 vs vol=0.01 ⇒ the predictor genuinely moves returns; a rotation rule
    // that goes long high-signal assets harvests a real cross-sectional spread.
    const panel = makePlantedPanel(600, nAssets, 0.012, 0.01, "planted-edge");
    const family: StrategyFamily<Panel, RotationConfig> = {
      id: "rotation-sweep-planted",
      configs: rotationGrid(nConfigs),
      buildReturns: rotationReturns,
      makeSurrogatePanel: shufflePanel,
    };

    const verdict = validateStrategyFamily(panel, family, {
      iterations: 200,
      statistic: "sharpe",
      seed: "planted-surrogate",
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.honestN).toBe(nConfigs);
    // The real grid-best must STRICTLY clear the surrogate grid-MAX bar.
    expect(verdict.realBestStat).toBeGreaterThan(verdict.surr95);
    // Family-wise p must be below the 5% bar (no surrogate max reaches the real edge).
    expect(verdict.surrogateMaxP).toBeLessThan(0.05);
  });

  it("KILLs a pure-noise family — the real best is just the luckiest of N", () => {
    const nAssets = 8;
    const nConfigs = 20;
    const panel = makeNoisePanel(600, nAssets, 0.01, "pure-noise-family");
    const family: StrategyFamily<Panel, RotationConfig> = {
      id: "rotation-sweep-noise",
      configs: rotationGrid(nConfigs),
      buildReturns: rotationReturns,
      makeSurrogatePanel: shufflePanel,
    };

    const verdict = validateStrategyFamily(panel, family, {
      iterations: 200,
      statistic: "sharpe",
      seed: "noise-surrogate",
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.honestN).toBe(nConfigs);
    // The real grid-best does NOT clear the family-wise surr95 of the maxima...
    expect(verdict.realBestStat).toBeLessThanOrEqual(verdict.surr95 + 1e-12);
    // ... and the family-wise p-value is NOT significant.
    expect(verdict.surrogateMaxP).toBeGreaterThan(0.05);
    expect(verdict.reason.toLowerCase()).toContain("kill");
  });

  it("the SAME noise family would look 'significant' under a naive single-best-config p (why the max-stat matters)", () => {
    const nAssets = 8;
    const nConfigs = 20;
    const panel = makeNoisePanel(600, nAssets, 0.01, "pure-noise-family");
    const family: StrategyFamily<Panel, RotationConfig> = {
      id: "rotation-sweep-noise",
      configs: rotationGrid(nConfigs),
      buildReturns: rotationReturns,
      makeSurrogatePanel: shufflePanel,
    };
    const verdict = validateStrategyFamily(panel, family, {
      iterations: 200,
      statistic: "sharpe",
      seed: "noise-surrogate",
    });

    // The luckiest config's REAL score, scored against a per-config (NOT max) null:
    // for each surrogate draw rebuild ONLY the winning config and collect its own
    // single-config surrogate scores. This is the WRONG, naive test the audit caught.
    const best = verdict.realScores[0]!;
    const rnd = seededRandom("naive-null");
    const singleConfigNull: number[] = [];
    for (let it = 0; it < 200; it += 1) {
      const surrogate = shufflePanel(panel, (rnd() * 2 ** 32) >>> 0);
      singleConfigNull.push(
        summarizeReturnSeries(rotationReturns(surrogate, best.config)).sharpe,
      );
    }
    const naiveGe = singleConfigNull.filter((s) => s >= best.stat - 1e-12).length;
    const naiveP = naiveGe / singleConfigNull.length;

    // The naive per-config p is SMALLER (more "significant") than the honest family-
    // wise p — the very illusion that flipped three leads. The family-wise max-stat
    // correctly does NOT pass; the naive single-config p understates the search risk.
    expect(naiveP).toBeLessThan(verdict.surrogateMaxP);
    expect(verdict.passed).toBe(false);
  });
});

describe("validateStrategyFamily — plumbing & invariants", () => {
  it("is deterministic across two identical calls", () => {
    const panel = makePlantedPanel(300, 6, 0.003, 0.01, "det-panel");
    const family: StrategyFamily<Panel, RotationConfig> = {
      id: "det",
      configs: rotationGrid(6),
      buildReturns: rotationReturns,
      makeSurrogatePanel: shufflePanel,
    };
    const opts = { iterations: 120, statistic: "sharpe" as const, seed: "det-seed" };
    const a = validateStrategyFamily(panel, family, opts);
    const b = validateStrategyFamily(panel, family, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("reports honestN = configs.length and collects `iterations` grid-maxima", () => {
    const nConfigs = 9;
    const panel = makeNoisePanel(200, 6, 0.01, "bookkeeping");
    const verdict = validateStrategyFamily(
      panel,
      {
        id: "bk",
        configs: rotationGrid(nConfigs),
        buildReturns: rotationReturns,
        makeSurrogatePanel: shufflePanel,
      },
      { iterations: 137 },
    );
    expect(verdict.honestN).toBe(nConfigs);
    expect(verdict.iterations).toBe(137);
    expect(verdict.surrogateMaxima).toHaveLength(137);
    // surrogateMaxima are returned ascending.
    for (let i = 1; i < verdict.surrogateMaxima.length; i += 1) {
      expect(verdict.surrogateMaxima[i]!).toBeGreaterThanOrEqual(
        verdict.surrogateMaxima[i - 1]!,
      );
    }
    // realScores are returned best-first.
    for (let i = 1; i < verdict.realScores.length; i += 1) {
      expect(verdict.realScores[i - 1]!.stat).toBeGreaterThanOrEqual(
        verdict.realScores[i]!.stat,
      );
    }
  });

  it("honors the chosen statistic and quantile bar", () => {
    const panel = makePlantedPanel(400, 6, 0.005, 0.01, "stat-quantile");
    const family: StrategyFamily<Panel, RotationConfig> = {
      id: "sq",
      configs: rotationGrid(6),
      buildReturns: rotationReturns,
      makeSurrogatePanel: shufflePanel,
    };
    const onMean = validateStrategyFamily(panel, family, {
      iterations: 150,
      statistic: "mean",
      quantile: 0.99,
      seed: "sq-seed",
    });
    expect(onMean.statistic).toBe("mean");
    expect(onMean.quantile).toBe(0.99);
    // surr95 here is the 99th percentile of the maxima; raising the bar can only make
    // it harder, never easier, than the 95th percentile on the same draws.
    const at95 = validateStrategyFamily(panel, family, {
      iterations: 150,
      statistic: "mean",
      quantile: 0.95,
      seed: "sq-seed",
    });
    expect(onMean.surr95).toBeGreaterThanOrEqual(at95.surr95 - 1e-12);
  });

  it("throws on an empty grid (honest N must be ≥ 1)", () => {
    expect(() =>
      validateStrategyFamily(
        makeNoisePanel(50, 3, 0.01, "empty"),
        {
          id: "empty",
          configs: [],
          buildReturns: rotationReturns,
          makeSurrogatePanel: shufflePanel,
        },
        { iterations: 10 },
      ),
    ).toThrow(/non-empty/);
  });

  it("rebuilds EVERY config on each surrogate panel (grid-max, not single-config)", () => {
    // Spy: count how many times buildReturns runs on a surrogate panel. With N configs
    // and K iterations it must be N*K surrogate rebuilds (+ N real-panel rebuilds).
    const nAssets = 5;
    const nConfigs = 7;
    const iterations = 30;
    const panel = makeNoisePanel(100, nAssets, 0.01, "spy");
    const seenAssetCounts = new Set<number>();
    let buildCalls = 0;
    const verdict = validateStrategyFamily(
      panel,
      {
        id: "spy",
        configs: rotationGrid(nConfigs),
        buildReturns: (p: Panel, c: RotationConfig) => {
          buildCalls += 1;
          seenAssetCounts.add(p.ret.length);
          return rotationReturns(p, c);
        },
        makeSurrogatePanel: shufflePanel,
      },
      { iterations },
    );
    // N real-panel scorings + N*iterations surrogate scorings.
    expect(buildCalls).toBe(nConfigs + nConfigs * iterations);
    expect(verdict.surrogateMaxima).toHaveLength(iterations);
    // Every panel passed to buildReturns had the full asset count (a coherent grid).
    expect([...seenAssetCounts]).toEqual([nAssets]);
  });
});
