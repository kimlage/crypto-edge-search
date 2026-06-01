/**
 * TRACK WF-A — Test the PREMISE of adaptive (walk-forward) indicator re-optimization.
 *
 * HYPOTHESIS (user's): markets are non-stationary, so the OPTIMAL indicator
 * parameter DRIFTS over time; a fixed param decays; therefore you must ADAPT
 * (walk-forward re-optimization) to recover edge.
 *
 * This script tests that premise DIRECTLY and HONESTLY, before building any
 * strategy. It answers four decisive questions:
 *   Q1 Does the rolling-optimal param drift TRACKABLY (persistent/autocorrelated)
 *      or jump randomly?
 *   Q2 Does adaptive WF-OOS beat buy-and-hold, net of cost, on a consume-once holdout?
 *   Q3 Does it beat an HONEST fixed-param baseline (param locked on first window)?
 *   Q4 Does the SAME machinery produce 'edge' on phase-randomized/block-shuffled
 *      surrogates (=> artifact)?
 *
 * Methodology is strictly causal: at each monthly step t, the param is chosen
 * using ONLY the trailing 365d window ending at t; we then trade the next OOS
 * month [t, t+h] with that param; roll forward. Costs charged on every position
 * change (taker ~4bps/side perp => 8bps round trip on a flip). The adaptation's
 * extra turnover is measured against a fixed param.
 *
 * Uses committed gates from src/lib/training/.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/statistical-validation";
import { planHoldoutSplit } from "../../src/lib/significance/holdout";
import { buildBuyAndHoldBaseline } from "../../src/lib/significance/baselines";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT_DIR = resolve(ROOT, "output", "walkforward");

// ---- Cost model: taker ~4bps/side perp. A flip (e.g. +1 -> -1) crosses the
// book twice => 8bps. We charge cost proportional to |position change|.
const COST_PER_SIDE = 0.0004; // 4 bps
const ANNUALIZE = Math.sqrt(365);

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface Series {
  symbol: string;
  dates: string[];
  close: number[];
  ret: number[]; // simple daily returns aligned to close[i] (ret[0] = 0)
}

function loadCrossxs(): Series[] {
  const raw = JSON.parse(
    readFileSync(resolve(ROOT, "output", "crossxs", "daily-closes.json"), "utf8"),
  ) as { dates: string[]; closes: Record<string, number[]> };
  const dates = raw.dates;
  const out: Series[] = [];
  // Focus set: BTC, ETH + a couple alts (SOL, BNB). All have full history here.
  for (const sym of ["BTC", "ETH", "SOL", "BNB"]) {
    const close = raw.closes[sym];
    if (!close || close.length !== dates.length) continue;
    const ret = close.map((c, i) => (i === 0 ? 0 : c / close[i - 1] - 1));
    out.push({ symbol: sym, dates, close, ret });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Indicator families. Each family enumerates a param grid; for a given param it
// produces a target position in {-1,0,+1} for each bar i computed CAUSALLY from
// close[0..i] (decision made at close i, return realized over bar i+1).
// ---------------------------------------------------------------------------

type PositionFn = (close: number[]) => Int8Array; // position[i] = desired pos entering bar i+1

interface Family {
  name: string;
  params: { id: string; fn: PositionFn }[];
}

function sma(close: number[], n: number): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < close.length; i++) {
    sum += close[i];
    if (i >= n) sum -= close[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function rollingStd(close: number[], n: number, mean: Float64Array): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  for (let i = n - 1; i < close.length; i++) {
    let s = 0;
    const m = mean[i];
    for (let j = i - n + 1; j <= i; j++) s += (close[j] - m) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

// MA-cross: long when fast SMA > slow SMA, short otherwise (trend following).
function maCrossFamily(): Family {
  const params: Family["params"] = [];
  const combos: [number, number][] = [];
  for (const f of [5, 10, 20, 30])
    for (const s of [50, 75, 100, 150, 200]) if (f < s) combos.push([f, s]);
  for (const [f, s] of combos) {
    params.push({
      id: `ma_${f}_${s}`,
      fn: (close) => {
        const fast = sma(close, f);
        const slow = sma(close, s);
        const pos = new Int8Array(close.length);
        for (let i = 0; i < close.length; i++) {
          if (Number.isNaN(fast[i]) || Number.isNaN(slow[i])) pos[i] = 0;
          else pos[i] = fast[i] > slow[i] ? 1 : -1;
        }
        return pos;
      },
    });
  }
  return { name: "ma_cross", params };
}

// Donchian breakout: long if close == max of last n; short if close == min of last n.
function donchianFamily(): Family {
  const params: Family["params"] = [];
  for (const n of [10, 20, 30, 40, 55, 75, 100]) {
    params.push({
      id: `donch_${n}`,
      fn: (close) => {
        const pos = new Int8Array(close.length);
        for (let i = 0; i < close.length; i++) {
          if (i < n) {
            pos[i] = 0;
            continue;
          }
          let hi = -Infinity;
          let lo = Infinity;
          for (let j = i - n; j < i; j++) {
            if (close[j] > hi) hi = close[j];
            if (close[j] < lo) lo = close[j];
          }
          if (close[i] >= hi) pos[i] = 1;
          else if (close[i] <= lo) pos[i] = -1;
          else pos[i] = i > 0 ? pos[i - 1] : 0; // hold previous between bands
        }
        return pos;
      },
    });
  }
  return { name: "donchian", params };
}

// Bollinger: mean-reversion. Long when close < lower band, short when > upper band.
function bollingerFamily(): Family {
  const params: Family["params"] = [];
  for (const n of [10, 20, 30, 50])
    for (const k of [1.5, 2.0, 2.5, 3.0]) {
      params.push({
        id: `boll_${n}_${k}`,
        fn: (close) => {
          const mean = sma(close, n);
          const sd = rollingStd(close, n, mean);
          const pos = new Int8Array(close.length);
          for (let i = 0; i < close.length; i++) {
            if (Number.isNaN(mean[i]) || Number.isNaN(sd[i]) || sd[i] === 0) {
              pos[i] = 0;
              continue;
            }
            const upper = mean[i] + k * sd[i];
            const lower = mean[i] - k * sd[i];
            if (close[i] < lower) pos[i] = 1;
            else if (close[i] > upper) pos[i] = -1;
            else pos[i] = i > 0 ? pos[i - 1] : 0;
          }
          return pos;
        },
      });
    }
  return { name: "bollinger", params };
}

// RSI threshold: mean-reversion. Long when RSI < thr, short when RSI > 100-thr.
function rsiSeries(close: number[], n: number): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1];
    const gain = Math.max(0, ch);
    const loss = Math.max(0, -ch);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i === n) {
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function rsiFamily(): Family {
  const params: Family["params"] = [];
  for (const n of [7, 14, 21])
    for (const thr of [20, 25, 30, 35, 40]) {
      params.push({
        id: `rsi_${n}_${thr}`,
        fn: (close) => {
          const rsi = rsiSeries(close, n);
          const pos = new Int8Array(close.length);
          for (let i = 0; i < close.length; i++) {
            if (Number.isNaN(rsi[i])) {
              pos[i] = 0;
              continue;
            }
            if (rsi[i] < thr) pos[i] = 1;
            else if (rsi[i] > 100 - thr) pos[i] = -1;
            else pos[i] = i > 0 ? pos[i - 1] : 0;
          }
          return pos;
        },
      });
    }
  return { name: "rsi", params };
}

// MACD spans: trend. Long when MACD line > signal line.
function emaSeries(close: number[], span: number): Float64Array {
  const out = new Float64Array(close.length).fill(NaN);
  const alpha = 2 / (span + 1);
  let prev = close[0];
  out[0] = close[0];
  for (let i = 1; i < close.length; i++) {
    prev = alpha * close[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function macdFamily(): Family {
  const params: Family["params"] = [];
  const combos: [number, number, number][] = [];
  for (const f of [8, 12, 16])
    for (const s of [21, 26, 35])
      for (const sig of [9]) if (f < s) combos.push([f, s, sig]);
  for (const [f, s, sig] of combos) {
    params.push({
      id: `macd_${f}_${s}_${sig}`,
      fn: (close) => {
        const ef = emaSeries(close, f);
        const es = emaSeries(close, s);
        const macd = ef.map((v, i) => v - es[i]);
        // signal = EMA of macd
        const signal = new Float64Array(close.length);
        const alpha = 2 / (sig + 1);
        let prev = macd[0];
        signal[0] = macd[0];
        for (let i = 1; i < close.length; i++) {
          prev = alpha * macd[i] + (1 - alpha) * prev;
          signal[i] = prev;
        }
        const pos = new Int8Array(close.length);
        const warm = s + sig;
        for (let i = 0; i < close.length; i++) {
          if (i < warm) pos[i] = 0;
          else pos[i] = macd[i] > signal[i] ? 1 : -1;
        }
        return pos;
      },
    });
  }
  return { name: "macd", params };
}

function allFamilies(): Family[] {
  return [
    maCrossFamily(),
    donchianFamily(),
    bollingerFamily(),
    rsiFamily(),
    macdFamily(),
  ];
}

// ---------------------------------------------------------------------------
// Backtest a position series over a return series, charging cost on position
// change. Returns the per-bar net strategy return aligned to ret indexes.
// position[i] is the desired position entering bar i+1, so PnL = position[i]*ret[i+1].
// ---------------------------------------------------------------------------

function strategyReturns(
  position: Int8Array,
  ret: number[],
  range: { start: number; end: number },
  carryPos = 0,
): { net: number[]; gross: number[]; turnover: number; finalPos: number } {
  const net: number[] = [];
  const gross: number[] = [];
  let prevPos = carryPos;
  let turnover = 0;
  for (let i = range.start; i < range.end; i++) {
    const pos = position[i]; // decided at close i
    const r = ret[i + 1]; // realized over next bar
    if (r === undefined || !Number.isFinite(r)) continue;
    const change = Math.abs(pos - prevPos);
    const cost = change * COST_PER_SIDE;
    turnover += change;
    gross.push(pos * r);
    net.push(pos * r - cost);
    prevPos = pos;
  }
  return { net, gross, turnover, finalPos: prevPos };
}

// Score a param on a trailing window [start,end): in-sample Sharpe net of cost.
function scoreParamOnWindow(
  position: Int8Array,
  ret: number[],
  start: number,
  end: number,
): number {
  const { net } = strategyReturns(position, ret, { start, end });
  const s = summarizeReturnSeries(net);
  return s.sharpe;
}

// ---------------------------------------------------------------------------
// Walk-forward engine. Strict causality.
// trainBars = trailing window (in-sample) used to pick the param.
// oosBars   = OOS slice traded after the decision; also the re-opt cadence.
// Returns the adaptive OOS equity return series and diagnostics.
// ---------------------------------------------------------------------------

interface WFResult {
  adaptiveNet: number[];
  adaptiveGross: number[];
  fixedNet: number[]; // param locked on FIRST window
  randomNet: number[]; // random param each step
  bestParamIdx: number[]; // chosen param index per step (for autocorr/drift)
  stepStartIdx: number[];
  oosBoundaries: number[]; // index in adaptiveNet where each step starts
  adaptiveTurnover: number;
  fixedTurnover: number;
  persistenceWins: number;
  persistenceTrials: number;
  persistenceDelta: number[]; // (best-trailing OOS sharpe) - (mean random OOS sharpe) per step
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walkForward(
  family: Family,
  ret: number[],
  close: number[],
  opts: {
    trainBars: number;
    oosBars: number;
    rangeStart: number; // first index usable for trading
    rangeEnd: number; // exclusive, last index usable for trading return
    seed: number;
  },
): WFResult {
  // Precompute positions for every param across the FULL series once (causal per bar).
  const positions = family.params.map((p) => p.fn(close));
  const rng = mulberry32(opts.seed);

  const adaptiveNet: number[] = [];
  const adaptiveGross: number[] = [];
  const fixedNet: number[] = [];
  const randomNet: number[] = [];
  const bestParamIdx: number[] = [];
  const stepStartIdx: number[] = [];
  const oosBoundaries: number[] = [];
  const persistenceDelta: number[] = [];

  let adaptivePrevPos = 0;
  let fixedPrevPos = 0;
  let fixedParamIdx = -1;
  let adaptiveTurnover = 0;
  let fixedTurnover = 0;
  let persistenceWins = 0;
  let persistenceTrials = 0;

  // First decision point: need trainBars of history before rangeStart, and we
  // step by oosBars. t = the close index at which we decide (end of train window).
  let t = Math.max(opts.rangeStart, opts.trainBars);
  while (t + opts.oosBars <= opts.rangeEnd) {
    const trainStart = t - opts.trainBars;
    const trainEnd = t; // exclusive end of in-sample (decide at close t-1 ... use up to t)
    // Pick best param on trailing window [trainStart, trainEnd) net of cost.
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let pi = 0; pi < positions.length; pi++) {
      const sc = scoreParamOnWindow(positions[pi], ret, trainStart, trainEnd);
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = pi;
      }
    }
    if (fixedParamIdx < 0) fixedParamIdx = bestIdx; // lock on FIRST window, honest

    const oosStart = t;
    const oosEnd = t + opts.oosBars;

    // ADAPTIVE: trade chosen param over OOS, carrying position across boundary.
    const adapt = strategyReturns(
      positions[bestIdx],
      ret,
      { start: oosStart, end: oosEnd },
      adaptivePrevPos,
    );
    adaptivePrevPos = adapt.finalPos;
    adaptiveTurnover += adapt.turnover;
    oosBoundaries.push(adaptiveNet.length);
    adaptiveNet.push(...adapt.net);
    adaptiveGross.push(...adapt.gross);

    // FIXED: trade the first-window param over the same OOS.
    const fixed = strategyReturns(
      positions[fixedParamIdx],
      ret,
      { start: oosStart, end: oosEnd },
      fixedPrevPos,
    );
    fixedPrevPos = fixed.finalPos;
    fixedTurnover += fixed.turnover;
    fixedNet.push(...fixed.net);

    // RANDOM: pick a random param each step (controls 'pick best on trailing').
    const randIdx = Math.floor(rng() * positions.length);
    const rand = strategyReturns(positions[randIdx], ret, { start: oosStart, end: oosEnd });
    randomNet.push(...rand.net);

    // PERSISTENCE test: does the trailing-best OOS Sharpe beat the AVERAGE OOS
    // Sharpe of randomly chosen params on the SAME OOS slice?
    const bestOosSharpe = summarizeReturnSeries(adapt.net).sharpe;
    let sumRand = 0;
    const NR = 20;
    for (let r = 0; r < NR; r++) {
      const ri = Math.floor(rng() * positions.length);
      const rr = strategyReturns(positions[ri], ret, { start: oosStart, end: oosEnd });
      sumRand += summarizeReturnSeries(rr.net).sharpe;
    }
    const meanRandOos = sumRand / NR;
    persistenceDelta.push(bestOosSharpe - meanRandOos);
    persistenceTrials++;
    if (bestOosSharpe > meanRandOos) persistenceWins++;

    bestParamIdx.push(bestIdx);
    stepStartIdx.push(oosStart);
    t += opts.oosBars;
  }

  return {
    adaptiveNet,
    adaptiveGross,
    fixedNet,
    randomNet,
    bestParamIdx,
    stepStartIdx,
    oosBoundaries,
    adaptiveTurnover,
    fixedTurnover,
    persistenceWins,
    persistenceTrials,
    persistenceDelta,
  };
}

// ---------------------------------------------------------------------------
// Time-series diagnostics
// ---------------------------------------------------------------------------

function autocorr(x: number[], lag: number): number {
  const n = x.length;
  if (n <= lag + 1) return NaN;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) den += (x[i] - mean) ** 2;
  for (let i = 0; i < n - lag; i++) num += (x[i] - mean) * (x[i + lag] - mean);
  return den === 0 ? NaN : num / den;
}

// Fraction of consecutive steps where the chosen param is UNCHANGED (stickiness).
function stickiness(idx: number[]): number {
  if (idx.length < 2) return NaN;
  let same = 0;
  for (let i = 1; i < idx.length; i++) if (idx[i] === idx[i - 1]) same++;
  return same / (idx.length - 1);
}

// Surrogate: stationary block bootstrap of returns preserving vol & short-range
// autocorr, destroying long-range structure. Reconstruct a close path.
function blockShuffleReturns(ret: number[], blockLen: number, rng: () => number): number[] {
  const n = ret.length;
  const out: number[] = [ret[0]];
  // sample blocks from ret[1..]
  while (out.length < n) {
    const start = 1 + Math.floor(rng() * (n - 1));
    for (let k = 0; k < blockLen && out.length < n; k++) {
      out.push(ret[1 + ((start - 1 + k) % (n - 1))]);
    }
  }
  return out.slice(0, n);
}

function closeFromReturns(ret: number[], p0: number): number[] {
  const close = new Array(ret.length);
  close[0] = p0;
  for (let i = 1; i < ret.length; i++) close[i] = close[i - 1] * (1 + ret[i]);
  return close;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sharpeAnn(returns: number[]): number {
  return summarizeReturnSeries(returns).sharpe * ANNUALIZE;
}

function main(): void {
  const series = loadCrossxs();
  const families = allFamilies();

  // META-PARAMETER GRID (the new multiple-testing surface for DSR N).
  const trainOptions = [365, 547, 730]; // trailing window lengths (days)
  const oosOptions = [21, 42, 63]; // re-opt cadence / OOS horizon (days)
  const metaConfigs: { trainBars: number; oosBars: number }[] = [];
  for (const tr of trainOptions) for (const oo of oosOptions) metaConfigs.push({ trainBars: tr, oosBars: oo });
  // True trial N = metaConfigs x families x assets (each is a distinct adaptive config audited).
  const trialCount = metaConfigs.length * families.length * series.length;

  const log: string[] = [];
  const say = (s = "") => {
    log.push(s);
    // eslint-disable-next-line no-console
    console.log(s);
  };

  say("=".repeat(78));
  say("TRACK WF-A — PREMISE TEST: does the optimal indicator param drift trackably,");
  say("and does walk-forward adaptation recover edge net of cost?");
  say("=".repeat(78));
  say(`Assets: ${series.map((s) => s.symbol).join(", ")}  (daily, real Binance closes)`);
  say(`Span: ${series[0].dates[0]} -> ${series[0].dates[series[0].dates.length - 1]} (${series[0].dates.length} bars)`);
  say(`Indicator families: ${families.map((f) => `${f.name}(${f.params.length})`).join(", ")}`);
  say(`Meta-grid: trainBars={${trainOptions.join(",")}} x oosBars={${oosOptions.join(",")}} = ${metaConfigs.length} configs`);
  say(`Cost: ${COST_PER_SIDE * 1e4}bps/side on every position change. Annualize sqrt(365).`);
  say(`HONEST trial N for DSR = metaConfigs(${metaConfigs.length}) x families(${families.length}) x assets(${series.length}) = ${trialCount}`);
  say("");

  // -----------------------------------------------------------------------
  // CONSUME-ONCE HOLDOUT. Reserve last ~18% of timeline. We pick our meta-config
  // on the SEARCH portion, then score the holdout exactly once.
  // -----------------------------------------------------------------------
  const N = series[0].dates.length;
  const plan = planHoldoutSplit({ totalRows: N, holdoutFraction: 0.18, testFraction: 0.0 });
  const searchEnd = plan.search.end; // index dividing search vs holdout
  const holdoutStart = plan.finalHoldout.start;
  say(`Holdout split: search=[0,${searchEnd}) holdout=[${holdoutStart},${N}) (last ${(((N - holdoutStart) / N) * 100).toFixed(0)}% reserved, scored once)`);
  say(`Holdout dates: ${series[0].dates[holdoutStart]} -> ${series[0].dates[N - 1]}`);
  say("");

  // =======================================================================
  // Q1 — DRIFT / PERSISTENCE DIAGNOSTICS on the SEARCH portion.
  // For each (asset, family, meta-config) we record the rolling-optimal param
  // index time series and measure autocorr / stickiness / persistence.
  // =======================================================================
  say("-".repeat(78));
  say("Q1  ROLLING-OPTIMAL PARAM: drift trackable, or random jumps?  (search portion)");
  say("-".repeat(78));

  interface DriftRow {
    asset: string;
    family: string;
    trainBars: number;
    oosBars: number;
    ac1: number;
    ac2: number;
    stick: number;
    persistWinRate: number;
    persistMeanDelta: number; // OOS sharpe (best-trailing) - (random), per step, raw (not annualized)
    nSteps: number;
  }
  const driftRows: DriftRow[] = [];

  // For Q1 we use the canonical meta-config (365 train / 21 oos) per task spec,
  // but also aggregate persistence across all configs for robustness.
  for (const s of series) {
    for (const fam of families) {
      for (const mc of metaConfigs) {
        const wf = walkForward(fam, s.ret, s.close, {
          trainBars: mc.trainBars,
          oosBars: mc.oosBars,
          rangeStart: 0,
          rangeEnd: searchEnd,
          seed: 12345 + fam.name.length + mc.trainBars + mc.oosBars,
        });
        if (wf.bestParamIdx.length < 8) continue;
        driftRows.push({
          asset: s.symbol,
          family: fam.name,
          trainBars: mc.trainBars,
          oosBars: mc.oosBars,
          ac1: autocorr(wf.bestParamIdx.map(Number), 1),
          ac2: autocorr(wf.bestParamIdx.map(Number), 2),
          stick: stickiness(wf.bestParamIdx),
          persistWinRate: wf.persistenceWins / Math.max(1, wf.persistenceTrials),
          persistMeanDelta:
            wf.persistenceDelta.reduce((a, b) => a + b, 0) / Math.max(1, wf.persistenceDelta.length),
          nSteps: wf.bestParamIdx.length,
        });
      }
    }
  }

  // Aggregate Q1
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const finite = (xs: number[]) => xs.filter((x) => Number.isFinite(x));
  const ac1All = finite(driftRows.map((r) => r.ac1));
  const ac2All = finite(driftRows.map((r) => r.ac2));
  const stickAll = finite(driftRows.map((r) => r.stick));
  const persistWR = finite(driftRows.map((r) => r.persistWinRate));
  const persistDelta = finite(driftRows.map((r) => r.persistMeanDelta));

  say(`Configs analyzed: ${driftRows.length} (asset x family x meta-config)`);
  say(`Param-index AUTOCORRELATION lag1: mean=${mean(ac1All).toFixed(3)} | lag2: mean=${mean(ac2All).toFixed(3)}`);
  say(`  (1.0 = perfectly persistent/trackable; ~0 = jumps randomly; AR with no memory ~ 0)`);
  say(`Param STICKINESS (P[param unchanged next step]): mean=${mean(stickAll).toFixed(3)}`);
  say(`PERSISTENCE TEST — trailing-best beats random param in NEXT OOS slice:`);
  say(`  win-rate across steps: mean=${(mean(persistWR) * 100).toFixed(1)}%  (50% = no skill)`);
  say(`  mean OOS-Sharpe edge (best-trailing minus random), raw daily: ${mean(persistDelta).toFixed(4)}`);
  say(`  => annualized edge proxy: ${(mean(persistDelta) * ANNUALIZE).toFixed(3)} Sharpe`);

  // Per-family breakdown
  say("");
  say("  Per-family (averaged over assets & meta-configs):");
  for (const fam of families) {
    const rows = driftRows.filter((r) => r.family === fam.name);
    say(
      `    ${fam.name.padEnd(10)} ac1=${mean(finite(rows.map((r) => r.ac1))).toFixed(3)}  stick=${mean(finite(rows.map((r) => r.stick))).toFixed(3)}  persistWR=${(mean(finite(rows.map((r) => r.persistWinRate))) * 100).toFixed(0)}%  persistDelta=${mean(finite(rows.map((r) => r.persistMeanDelta))).toFixed(4)}`,
    );
  }
  say("");

  // =======================================================================
  // Q2/Q3 — Pick the meta-config on SEARCH (by adaptive net Sharpe pooled over
  // assets & families), then score HOLDOUT once. Compare to buy&hold and fixed.
  // =======================================================================
  say("-".repeat(78));
  say("Q2/Q3  SELECT meta-config on SEARCH, then CONSUME-ONCE HOLDOUT scoring");
  say("-".repeat(78));

  function poolWF(
    rangeStart: number,
    rangeEnd: number,
    mc: { trainBars: number; oosBars: number },
  ): {
    adaptive: number[];
    fixed: number[];
    random: number[];
    adaptTurn: number;
    fixedTurn: number;
    bhReturns: number[];
  } {
    const adaptive: number[] = [];
    const fixed: number[] = [];
    const random: number[] = [];
    const bhReturns: number[] = [];
    let adaptTurn = 0;
    let fixedTurn = 0;
    for (const s of series) {
      for (const fam of families) {
        const wf = walkForward(fam, s.ret, s.close, {
          trainBars: mc.trainBars,
          oosBars: mc.oosBars,
          rangeStart,
          rangeEnd,
          seed: 999 + fam.name.length + mc.trainBars + mc.oosBars + s.symbol.length,
        });
        adaptive.push(...wf.adaptiveNet);
        fixed.push(...wf.fixedNet);
        random.push(...wf.randomNet);
        adaptTurn += wf.adaptiveTurnover;
        fixedTurn += wf.fixedTurnover;
      }
      // buy & hold over the same traded range (one per asset, not per family)
      const firstTradeStart = Math.max(rangeStart, 365);
      const bh = buildBuyAndHoldBaseline({
        barReturns: s.ret.slice(firstTradeStart, rangeEnd),
        roundTripCost: COST_PER_SIDE * 2,
      });
      void bh; // score computed separately; collect raw bars for pooled sharpe
      const bars = s.ret.slice(firstTradeStart, rangeEnd);
      bhReturns.push(...[bars[0] - COST_PER_SIDE, ...bars.slice(1)]);
    }
    return { adaptive, fixed, random, adaptTurn, fixedTurn, bhReturns };
  }

  // SELECT meta-config on search by pooled adaptive net Sharpe.
  let bestMC = metaConfigs[0];
  let bestMCScore = -Infinity;
  const mcScores: { mc: typeof metaConfigs[number]; sharpe: number }[] = [];
  for (const mc of metaConfigs) {
    const r = poolWF(0, searchEnd, mc);
    const sh = sharpeAnn(r.adaptive);
    mcScores.push({ mc, sharpe: sh });
    if (sh > bestMCScore) {
      bestMCScore = sh;
      bestMC = mc;
    }
  }
  say(`Meta-config search Sharpe (pooled adaptive, annualized):`);
  for (const m of mcScores)
    say(`    train=${m.mc.trainBars} oos=${m.mc.oosBars}: adaptive Sharpe=${m.sharpe.toFixed(3)}`);
  say(`  SELECTED meta-config: train=${bestMC.trainBars} oos=${bestMC.oosBars} (best on search)`);
  say("");

  // SCORE HOLDOUT ONCE with the selected meta-config.
  const ho = poolWF(holdoutStart, N, bestMC);
  const adaptStats = summarizeReturnSeries(ho.adaptive);
  const fixedStats = summarizeReturnSeries(ho.fixed);
  const randStats = summarizeReturnSeries(ho.random);
  const bhStats = summarizeReturnSeries(ho.bhReturns);

  const adaptSharpe = adaptStats.sharpe * ANNUALIZE;
  const fixedSharpe = fixedStats.sharpe * ANNUALIZE;
  const randSharpe = randStats.sharpe * ANNUALIZE;
  const bhSharpe = bhStats.sharpe * ANNUALIZE;

  say("HOLDOUT (consume-once) results, pooled over assets x families, net of cost:");
  say(`  ADAPTIVE  walk-forward : Sharpe=${adaptSharpe.toFixed(3)}  mean/bar=${adaptStats.mean.toExponential(2)}  compound=${(adaptStats.compoundReturn * 100).toFixed(1)}%  n=${adaptStats.sampleCount}`);
  say(`  FIXED     (first window): Sharpe=${fixedSharpe.toFixed(3)}  mean/bar=${fixedStats.mean.toExponential(2)}  compound=${(fixedStats.compoundReturn * 100).toFixed(1)}%`);
  say(`  RANDOM    param/step    : Sharpe=${randSharpe.toFixed(3)}  compound=${(randStats.compoundReturn * 100).toFixed(1)}%`);
  say(`  BUY & HOLD              : Sharpe=${bhSharpe.toFixed(3)}  compound=${(bhStats.compoundReturn * 100).toFixed(1)}%`);
  say("");
  say(`  Turnover on holdout: adaptive=${ho.adaptTurn.toFixed(0)} units vs fixed=${ho.fixedTurn.toFixed(0)} units`);
  const extraTurn = ho.adaptTurn - ho.fixedTurn;
  const extraCost = extraTurn * COST_PER_SIDE;
  say(`  EXTRA turnover caused by ADAPTING vs fixed: ${extraTurn.toFixed(0)} units => extra cost ${(extraCost * 100).toFixed(2)}% of notional-bar-units`);
  say(`  Adaptive beats buy&hold? ${adaptSharpe > bhSharpe ? "YES" : "NO"}   beats fixed? ${adaptSharpe > fixedSharpe ? "YES" : "NO"}   beats random? ${adaptSharpe > randSharpe ? "YES" : "NO"}`);
  say("");

  // DSR on the pooled adaptive holdout series with HONEST trial N.
  const dsr = computeDeflatedSharpeRatio(ho.adaptive, { trialCount });
  say(`Deflated Sharpe (holdout adaptive, trialCount=${trialCount}):`);
  say(`  raw daily Sharpe=${dsr.sharpe.toFixed(4)}  expectedMaxSharpe(noise)=${dsr.expectedMaxSharpe.toFixed(4)}`);
  say(`  DSR probability (P[skill > selection luck])=${dsr.deflatedProbability.toFixed(4)}  (need > 0.95)`);
  const dsrPValue = 1 - dsr.deflatedProbability;
  say(`  DSR p-value=${dsrPValue.toFixed(4)}`);
  say("");

  // =======================================================================
  // Q4 — SURROGATE / PLACEBO. Run the EXACT same machinery on block-shuffled
  // surrogate price series (preserve vol & short autocorr, destroy structure).
  // If the machinery 'finds edge' on surrogates, real edge is artifact.
  // =======================================================================
  say("-".repeat(78));
  say("Q4  SURROGATE / PLACEBO — same machinery on block-shuffled noise");
  say("-".repeat(78));
  const NSURR = 30;
  const surrSharpes: number[] = [];
  const surrPersistDelta: number[] = [];
  const surrBeatBH: number[] = [];
  const rngS = mulberry32(20260531);
  for (let s = 0; s < NSURR; s++) {
    const surrAdaptive: number[] = [];
    const surrBH: number[] = [];
    for (const ser of series) {
      // build surrogate close on the FULL series, then run WF on holdout range
      const surrRet = blockShuffleReturns(ser.ret, 10, rngS);
      const surrClose = closeFromReturns(surrRet, ser.close[0]);
      for (const fam of families) {
        const wf = walkForward(fam, surrRet, surrClose, {
          trainBars: bestMC.trainBars,
          oosBars: bestMC.oosBars,
          rangeStart: holdoutStart,
          rangeEnd: N,
          seed: 7000 + s * 13 + fam.name.length,
        });
        surrAdaptive.push(...wf.adaptiveNet);
        surrPersistDelta.push(
          wf.persistenceDelta.reduce((a, b) => a + b, 0) / Math.max(1, wf.persistenceDelta.length),
        );
      }
      const firstTradeStart = Math.max(holdoutStart, 365);
      const bars = surrRet.slice(firstTradeStart, N);
      surrBH.push(...[bars[0] - COST_PER_SIDE, ...bars.slice(1)]);
    }
    const sa = sharpeAnn(surrAdaptive);
    surrSharpes.push(sa);
    surrBeatBH.push(sa > sharpeAnn(surrBH) ? 1 : 0);
  }
  surrSharpes.sort((a, b) => a - b);
  const surrMean = mean(surrSharpes);
  const surrP95 = surrSharpes[Math.floor(0.95 * (surrSharpes.length - 1))];
  const surrPersistMean = mean(finite(surrPersistDelta));
  say(`Surrogates: ${NSURR} block-shuffled realizations (block=10), same WF machinery.`);
  say(`  Surrogate ADAPTIVE holdout Sharpe: mean=${surrMean.toFixed(3)}  p95=${surrP95.toFixed(3)}  max=${surrSharpes[surrSharpes.length - 1].toFixed(3)}`);
  say(`  Surrogate persistence delta (best-trailing minus random OOS sharpe): mean=${surrPersistMean.toFixed(4)}`);
  say(`  Fraction of surrogates where adaptive beat surrogate buy&hold: ${(mean(surrBeatBH) * 100).toFixed(0)}%`);
  // Empirical placebo p-value for the REAL adaptive holdout Sharpe.
  const placeboP =
    (surrSharpes.filter((x) => x >= adaptSharpe).length + 1) / (surrSharpes.length + 1);
  say(`  Placebo p-value for REAL adaptive Sharpe (${adaptSharpe.toFixed(3)}) vs surrogate dist: ${placeboP.toFixed(3)}`);
  say(`  => Machinery ${surrMean > 0.3 || surrPersistMean > 0.02 ? "DOES manufacture apparent edge on noise (artifact risk HIGH)" : "shows ~no edge on noise (good)"}`);
  say("");

  // =======================================================================
  // VERDICT
  // =======================================================================
  say("=".repeat(78));
  say("VERDICT");
  say("=".repeat(78));
  const q1Trackable = mean(ac1All) > 0.2 || mean(stickAll) > 0.5;
  const q1PersistReal = mean(persistWR) > 0.55 && mean(persistDelta) > 0;
  const q2BeatsBH = adaptSharpe > bhSharpe;
  const q3BeatsFixed = adaptSharpe > fixedSharpe;
  const q4NoSurrEdge = surrMean < 0.3 && surrPersistMean < 0.02 && placeboP > 0.1;
  const dsrPass = dsr.deflatedProbability > 0.95;

  say(`Q1 trackable drift?         ${q1Trackable ? "PARTIAL/YES" : "NO"}  (ac1=${mean(ac1All).toFixed(3)}, stick=${mean(stickAll).toFixed(3)})`);
  say(`Q1 persistence real (net)?  ${q1PersistReal ? "YES" : "NO"}  (winRate=${(mean(persistWR) * 100).toFixed(0)}%, delta=${mean(persistDelta).toFixed(4)})`);
  say(`Q2 adaptive > buy&hold?     ${q2BeatsBH ? "YES" : "NO"}  (${adaptSharpe.toFixed(2)} vs ${bhSharpe.toFixed(2)})`);
  say(`Q3 adaptive > fixed?        ${q3BeatsFixed ? "YES" : "NO"}  (${adaptSharpe.toFixed(2)} vs ${fixedSharpe.toFixed(2)})`);
  say(`Q4 surrogate ~no edge?      ${q4NoSurrEdge ? "YES" : "NO"}  (surrMean=${surrMean.toFixed(2)}, placeboP=${placeboP.toFixed(2)})`);
  say(`DSR > 0.95?                 ${dsrPass ? "YES" : "NO"}  (DSR=${dsr.deflatedProbability.toFixed(3)})`);
  say("");

  const survive = q2BeatsBH && q3BeatsFixed && q4NoSurrEdge && dsrPass && q1PersistReal;
  let verdict: "SURVIVE" | "KILL" | "PARTIAL";
  if (survive) verdict = "SURVIVE";
  else if (!q2BeatsBH && !q3BeatsFixed && !q1PersistReal) verdict = "KILL";
  else verdict = "PARTIAL";
  say(`>>> VERDICT: ${verdict}`);
  say("");
  say("Interpretation:");
  if (verdict === "KILL") {
    say("  The premise does NOT hold in the data. The rolling-optimal param does not");
    say("  persist usefully: picking the trailing-best param does not beat a random");
    say("  param OOS, adaptive does not beat buy&hold or an honest fixed param, and the");
    say("  in-sample optimum is selection luck (DSR fails). Adaptation cannot rescue TA");
    say("  here because best-param is essentially unpredictable from its own past.");
  } else if (verdict === "PARTIAL") {
    say("  Mixed. There is SOME structure (see Q1) but it does not convert into a holdout");
    say("  edge that beats buy&hold AND fixed AND survives the surrogate/DSR gates net of");
    say("  cost. Not promotable.");
  } else {
    say("  Adaptation adds real OOS value: trackable drift, persistence net of cost,");
    say("  beats buy&hold and fixed, surrogate shows no edge, DSR passes.");
  }

  // Persist artifacts
  const result = {
    generatedAt: new Date().toISOString(),
    assets: series.map((s) => s.symbol),
    span: [series[0].dates[0], series[0].dates[series[0].dates.length - 1]],
    families: families.map((f) => ({ name: f.name, params: f.params.length })),
    metaGrid: { trainOptions, oosOptions, configs: metaConfigs.length },
    trialCount,
    holdout: { searchEnd, holdoutStart, holdoutDates: [series[0].dates[holdoutStart], series[0].dates[N - 1]] },
    q1: {
      ac1Mean: mean(ac1All),
      ac2Mean: mean(ac2All),
      stickinessMean: mean(stickAll),
      persistenceWinRate: mean(persistWR),
      persistenceMeanDelta: mean(persistDelta),
      perFamily: families.map((fam) => {
        const rows = driftRows.filter((r) => r.family === fam.name);
        return {
          family: fam.name,
          ac1: mean(finite(rows.map((r) => r.ac1))),
          stickiness: mean(finite(rows.map((r) => r.stick))),
          persistWinRate: mean(finite(rows.map((r) => r.persistWinRate))),
          persistDelta: mean(finite(rows.map((r) => r.persistMeanDelta))),
        };
      }),
    },
    selectedMetaConfig: bestMC,
    holdoutScores: {
      adaptiveSharpe: adaptSharpe,
      fixedSharpe,
      randomSharpe: randSharpe,
      buyHoldSharpe: bhSharpe,
      adaptiveCompound: adaptStats.compoundReturn,
      fixedCompound: fixedStats.compoundReturn,
      buyHoldCompound: bhStats.compoundReturn,
      adaptiveTurnover: ho.adaptTurn,
      fixedTurnover: ho.fixedTurn,
      extraTurnover: extraTurn,
      extraCost,
    },
    dsr: {
      sharpe: dsr.sharpe,
      expectedMaxSharpe: dsr.expectedMaxSharpe,
      deflatedProbability: dsr.deflatedProbability,
      pValue: dsrPValue,
      trialCount,
    },
    surrogate: {
      n: NSURR,
      meanSharpe: surrMean,
      p95Sharpe: surrP95,
      persistDeltaMean: surrPersistMean,
      placeboPValue: placeboP,
      fractionBeatBH: mean(surrBeatBH),
    },
    verdict,
  };
  writeFileSync(resolve(OUT_DIR, "premise-test-result.json"), JSON.stringify(result, null, 2));
  writeFileSync(resolve(OUT_DIR, "premise-test-log.txt"), log.join("\n"));
  say(`Artifacts: ${resolve(OUT_DIR, "premise-test-result.json")}`);
  say(`           ${resolve(OUT_DIR, "premise-test-log.txt")}`);
}

main();
