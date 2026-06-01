/**
 * Strictly-causal walk-forward adaptive engine + the four honest benchmarks.
 *
 * The adaptive method: walk a re-opt cursor t across the timeline. At each step,
 * select the param that maximized net Sharpe on the TRAILING in-sample window
 * [t - trainBars, t), then trade the OOS slice [t, t + oosBars) with it. Roll t
 * forward by oosBars. Concatenate all OOS slices => the adaptive OOS return path.
 *
 * Causality: param at step t uses ONLY closes[< t] (the trailing window ends at
 * t-1). Trading the slice uses positions decided at each bar's close applied to
 * the NEXT bar (engine lags). The first OOS bar's position was decided at close
 * of t-1 (a past close), but its RETURN (bar t) is out-of-sample and never
 * influenced the selection. Implemented with range-limited rolling evaluators
 * (lib.evalWindow) so each step is O(window), not O(full series).
 */

import {
  type Family,
  type Bar,
  paramGrid,
  evalWindow,
  sharpeOf,
  autocorr,
} from "./lib";

export interface MetaConfig {
  family: Family;
  trainBars: number; // trailing in-sample window length
  oosBars: number; // OOS slice length (re-opt cadence == oosBars)
}

export interface WalkForwardOutput {
  netReturns: number[];
  grossReturns: number[];
  chosenParams: number[];
  stepBars: number[];
  turnoverUnits: number;
  changeEvents: number;
  firstBar: number;
  lastBar: number;
}

export type ParamPicker = (
  scores: { param: number; sharpe: number }[],
  rng: () => number,
) => number;

export const pickBest: ParamPicker = (scores) => {
  let best = scores[0];
  for (const s of scores) if (s.sharpe > best.sharpe) best = s;
  return best.param;
};

export const pickRandom: ParamPicker = (scores, rng) =>
  scores[Math.floor(rng() * scores.length)].param;

function sharpeFromSums(sum: number, sumsq: number, count: number): number {
  if (count < 2) return 0;
  const mean = sum / count;
  const variance = (sumsq - count * mean * mean) / (count - 1);
  const sd = Math.sqrt(Math.max(0, variance));
  return sd > 1e-12 ? mean / sd : 0;
}

/**
 * Strictly-causal walk-forward over closes within [rangeStart, rangeEnd). First
 * re-opt cursor = rangeStart + trainBars. Each step selects on the trailing
 * window [t-trainBars, t) (only past data) and trades [t, min(t+oosBars, end)).
 */
export function runWalkForward(
  closes: readonly number[],
  cfg: MetaConfig,
  rangeStart: number,
  rangeEnd: number,
  costPerSide: number,
  picker: ParamPicker,
  rng: () => number,
): WalkForwardOutput {
  const grid = paramGrid(cfg.family);
  const netReturns: number[] = [];
  const grossReturns: number[] = [];
  const chosenParams: number[] = [];
  const stepBars: number[] = [];
  let turnoverUnits = 0;
  let changeEvents = 0;
  let firstBar = -1;
  let lastBar = -1;

  let t = rangeStart + cfg.trainBars;
  while (t < rangeEnd) {
    const winStart = t - cfg.trainBars;
    const scores: { param: number; sharpe: number }[] = [];
    for (const param of grid) {
      // score net Sharpe on trailing window [winStart, t): returns indexed by
      // bars [winStart+1, t). Uses only closes[< t]. No future leakage.
      const ev = evalWindow(cfg.family, closes, param, winStart + 1, t, costPerSide, false);
      scores.push({ param, sharpe: sharpeFromSums(ev.sum, ev.sumsq, ev.count) });
    }
    const chosen = picker(scores, rng);
    chosenParams.push(chosen);
    stepBars.push(t);

    const sliceEnd = Math.min(t + cfg.oosBars, rangeEnd);
    const ev = evalWindow(cfg.family, closes, chosen, t, sliceEnd, costPerSide, true);
    for (const x of ev.netReturns) netReturns.push(x);
    for (const x of ev.grossReturns) grossReturns.push(x);
    turnoverUnits += ev.turnoverUnits;
    changeEvents += ev.changeEvents;
    if (firstBar < 0) firstBar = t;
    lastBar = sliceEnd;

    t = sliceEnd;
  }

  return {
    netReturns,
    grossReturns,
    chosenParams,
    stepBars,
    turnoverUnits,
    changeEvents,
    firstBar,
    lastBar,
  };
}

/**
 * Honest fixed-param baseline: lock the param on the FIRST trailing in-sample
 * window (at rangeStart+trainBars), then trade the SAME OOS span without ever
 * changing it. Peeks at NO future data.
 */
export function runFixedParam(
  closes: readonly number[],
  cfg: MetaConfig,
  rangeStart: number,
  rangeEnd: number,
  costPerSide: number,
): { netReturns: number[]; param: number; turnoverUnits: number; changeEvents: number } {
  const grid = paramGrid(cfg.family);
  const t0 = rangeStart + cfg.trainBars;
  const winStart = t0 - cfg.trainBars;
  let bestParam = grid[0];
  let bestSharpe = -Infinity;
  for (const param of grid) {
    const ev = evalWindow(cfg.family, closes, param, winStart + 1, t0, costPerSide, false);
    const s = sharpeFromSums(ev.sum, ev.sumsq, ev.count);
    if (s > bestSharpe) {
      bestSharpe = s;
      bestParam = param;
    }
  }
  const ev = evalWindow(cfg.family, closes, bestParam, t0, rangeEnd, costPerSide, true);
  return {
    netReturns: ev.netReturns,
    param: bestParam,
    turnoverUnits: ev.turnoverUnits,
    changeEvents: ev.changeEvents,
  };
}

/** Buy-and-hold over [start, end) (pays one entry cost on the first bar). */
export function runBuyHold(
  closes: readonly number[],
  start: number,
  end: number,
  costPerSide: number,
): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i += 1) {
    if (i < 1) continue;
    let r = closes[i] / closes[i - 1] - 1;
    if (out.length === 0) r -= costPerSide;
    out.push(r);
  }
  return out;
}

/**
 * Q1 diagnostic: does the trailing-best param drift trackably? Compute the
 * trailing-best param at each re-opt step and report autocorrelation + the
 * step-to-step change distribution. High autocorr => persistent/trackable drift;
 * ~0 => random jumps (no exploitable drift signal).
 */
export function paramDriftDiagnostic(
  closes: readonly number[],
  family: Family,
  trainBars: number,
  stepBars: number,
  rangeStart: number,
  rangeEnd: number,
  costPerSide: number,
): {
  paramSeries: number[];
  lag1Autocorr: number;
  lag2Autocorr: number;
  lag4Autocorr: number;
  meanAbsStep: number;
  changedFraction: number;
} {
  const grid = paramGrid(family);
  const paramSeries: number[] = [];
  let t = rangeStart + trainBars;
  while (t < rangeEnd) {
    const winStart = t - trainBars;
    let bestParam = grid[0];
    let bestSharpe = -Infinity;
    for (const param of grid) {
      const ev = evalWindow(family, closes, param, winStart + 1, t, costPerSide, false);
      const s = sharpeFromSums(ev.sum, ev.sumsq, ev.count);
      if (s > bestSharpe) {
        bestSharpe = s;
        bestParam = param;
      }
    }
    paramSeries.push(bestParam);
    t += stepBars;
  }
  let changes = 0;
  let absStep = 0;
  for (let i = 1; i < paramSeries.length; i += 1) {
    const d = Math.abs(paramSeries[i] - paramSeries[i - 1]);
    absStep += d;
    if (d > 0) changes += 1;
  }
  const denom = Math.max(1, paramSeries.length - 1);
  return {
    paramSeries,
    lag1Autocorr: autocorr(paramSeries, 1),
    lag2Autocorr: autocorr(paramSeries, 2),
    lag4Autocorr: autocorr(paramSeries, 4),
    meanAbsStep: absStep / denom,
    changedFraction: changes / denom,
  };
}

export type { Bar };
