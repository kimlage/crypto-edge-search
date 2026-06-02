/**
 * Shared D2 edge-hunt engine: data loading, backtest, and the committed gauntlet.
 *
 * Gauntlet (net-of-cost, honest N) uses the committed validators in
 * src/lib/training/statistical-validation.ts:
 *   - summarizeReturnSeries  (net Sharpe, ann.)
 *   - computeDeflatedSharpeRatio (DSR @ honest N = trialCount)
 *   - blockBootstrapConfidenceInterval (CI on Sharpe; preserves autocorr)
 *   - estimateCscvPbo (PBO across configs)
 * Plus a strategy-specific SURROGATE null built per hypothesis.
 *
 * COST: taker 4 bps / side. Cost charged on |Δposition| each bar.
 * For order-flow: only the strictly-LAGGED (h>=1) signal is allowed; the
 * same-bar (h=0) flow is circular (the trades ARE the move) and reported
 * separately as a sanity ceiling, never as the edge.
 */
import { readFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation.ts";

export const COST_PER_SIDE = 0.0004; // 4 bps taker
const OUT = "output/edgehunt-D2";

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tbb: number; // taker buy base
  n: number;
}

export function loadDaily(sym = "BTCUSDT"): Bar[] {
  const f =
    sym === "BTCUSDT"
      ? `${OUT}/btc_daily_flow.json`
      : `${OUT}/${sym}_daily_flow.json`;
  return JSON.parse(readFileSync(f, "utf8")) as Bar[];
}
export function load15m(): Bar[] {
  return JSON.parse(readFileSync(`${OUT}/btc_15m_flow.json`, "utf8")) as Bar[];
}

export function logret(bars: Bar[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < bars.length; i += 1) r.push(Math.log(bars[i].c / bars[i - 1].c));
  return r;
}
export function simpleret(bars: Bar[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < bars.length; i += 1) r.push(bars[i].c / bars[i - 1].c - 1);
  return r;
}

/** signed taker flow per bar: buy - sell = 2*tbb - v */
export function signedFlow(bars: Bar[]): number[] {
  return bars.map((b) => 2 * b.tbb - b.v);
}
/** normalized order-flow imbalance per bar in [-1,1] */
export function ofImbalance(bars: Bar[]): number[] {
  return bars.map((b) => (b.v > 0 ? (2 * b.tbb - b.v) / b.v : 0));
}

/**
 * Backtest a positions array (target exposure in [-1,1]) against next-bar
 * returns. positions[i] is the position HELD over bar i->i+1, decided using
 * info available at/before time i (the caller must enforce the lag).
 * Returns net (after-cost) per-bar P&L series.
 */
export function backtestNet(
  positions: number[],
  rets: number[],
  costPerSide = COST_PER_SIDE,
): { net: number[]; gross: number[]; turnover: number } {
  const n = Math.min(positions.length, rets.length);
  const net: number[] = [];
  const gross: number[] = [];
  let prev = 0;
  let turn = 0;
  for (let i = 0; i < n; i += 1) {
    const pos = positions[i];
    const dpos = Math.abs(pos - prev);
    turn += dpos;
    const g = pos * rets[i];
    const c = dpos * costPerSide;
    gross.push(g);
    net.push(g - c);
    prev = pos;
  }
  return { net, gross, turnover: turn / Math.max(1, n) };
}

const ANN_DAILY = Math.sqrt(365);
export function annSharpe(series: number[], periodsPerYear = 365): number {
  const s = summarizeReturnSeries(series);
  return s.sharpe * Math.sqrt(periodsPerYear);
}

export interface GateResult {
  name: string;
  config: string;
  nBars: number;
  honestN: number;
  netSharpeAnn: number;
  grossSharpeAnn: number;
  netMeanBp: number;
  turnover: number;
  // baselines
  buyHoldSharpe: number;
  excessOverBH: number;
  // DSR @ honest N
  dsrProb: number;
  dsrZ: number;
  // block-bootstrap CI on per-bar mean (compoundReturn proxy via mean)
  bootLowerSharpe: number;
  bootUpperSharpe: number;
  // surrogate null
  surrogateP: number;
  surrogateMeanSharpe: number;
  // PBO across configs
  pbo: number | null;
  // verdict
  pass: boolean;
  bindingGate: string;
  monthlyAt100k: number | null;
}

/**
 * Run the committed gauntlet on a chosen strategy's net series, given:
 *  - net: net-of-cost per-bar returns of the CHOSEN config
 *  - honestN: total number of configs tried (DSR trialCount)
 *  - surrogateSharpes: ann. net Sharpe of the strategy recomputed on each
 *    surrogate (null) path -> p = P(null >= observed)
 *  - foldReturns: per-config per-fold net returns for PBO (>=2 configs)
 *  - buyHoldRets: market returns over same window (baseline)
 *  - periodsPerYear
 */
export function runGauntlet(opts: {
  name: string;
  config: string;
  net: number[];
  gross: number[];
  turnover: number;
  honestN: number;
  surrogateSharpes: number[];
  observedSharpe: number;
  buyHoldRets: number[];
  pboStrategies?: { id: string; folds: number[][] }[];
  periodsPerYear?: number;
}): GateResult {
  const ppy = opts.periodsPerYear ?? 365;
  const annS = Math.sqrt(ppy);
  const stats = summarizeReturnSeries(opts.net);
  const gstats = summarizeReturnSeries(opts.gross);
  const netSharpeAnn = stats.sharpe * annS;
  const grossSharpeAnn = gstats.sharpe * annS;

  const bh = summarizeReturnSeries(opts.buyHoldRets);
  const buyHoldSharpe = bh.sharpe * annS;

  const dsr = computeDeflatedSharpeRatio(opts.net, {
    benchmarkSharpe: 0,
    trialCount: opts.honestN,
  });

  const boot = blockBootstrapConfidenceInterval(opts.net, {
    statistic: "mean",
    iterations: 2000,
    confidenceLevel: 0.95,
    seed: `${opts.name}-boot`,
  });
  // convert mean CI to ann sharpe CI scale
  const bootLowerSharpe =
    stats.stdDev > 1e-12 ? (boot.lower / stats.stdDev) * annS : 0;
  const bootUpperSharpe =
    stats.stdDev > 1e-12 ? (boot.upper / stats.stdDev) * annS : 0;

  // surrogate p-value
  const sur = opts.surrogateSharpes.filter((x) => Number.isFinite(x));
  const ge = sur.filter((x) => x >= opts.observedSharpe).length;
  const surrogateP = (ge + 1) / (sur.length + 1);
  const surrogateMeanSharpe =
    sur.length > 0 ? sur.reduce((a, b) => a + b, 0) / sur.length : 0;

  let pbo: number | null = null;
  if (opts.pboStrategies && opts.pboStrategies.length >= 2) {
    try {
      const res = estimateCscvPbo(
        opts.pboStrategies.map((s) => ({ id: s.id, folds: s.folds })),
        { statistic: "mean", trainFraction: 0.5 },
      );
      pbo = res.pbo;
    } catch {
      pbo = null;
    }
  }

  // GATES (net-of-cost). Binding gate = first that fails.
  const gates: [string, boolean][] = [
    ["net-sharpe>0.3", netSharpeAnn > 0.3],
    ["beats-buyhold", netSharpeAnn > buyHoldSharpe],
    ["boot-CI-lower>0", bootLowerSharpe > 0],
    ["DSR@N>0.95", dsr.deflatedProbability > 0.95],
    ["surrogate-p<0.05", surrogateP < 0.05],
    ["PBO<0.5", pbo === null ? true : pbo < 0.5],
  ];
  let bindingGate = "ALL-PASS";
  let pass = true;
  for (const [g, ok] of gates) {
    if (!ok) {
      bindingGate = g;
      pass = false;
      break;
    }
  }

  // monthly $ on $100k if it survives: mean per-bar * bars-per-month * 100k
  const barsPerMonth = ppy / 12;
  const monthlyAt100k = pass
    ? Math.round(stats.mean * barsPerMonth * 100000)
    : null;

  return {
    name: opts.name,
    config: opts.config,
    nBars: opts.net.length,
    honestN: opts.honestN,
    netSharpeAnn,
    grossSharpeAnn,
    netMeanBp: stats.mean * 1e4,
    turnover: opts.turnover,
    buyHoldSharpe,
    excessOverBH: netSharpeAnn - buyHoldSharpe,
    dsrProb: dsr.deflatedProbability,
    dsrZ: dsr.zScore,
    bootLowerSharpe,
    bootUpperSharpe,
    surrogateP,
    surrogateMeanSharpe,
    pbo,
    pass,
    bindingGate,
    monthlyAt100k,
  };
}

/** seeded RNG (mulberry32) for surrogate reproducibility */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** circular block bootstrap of an index series, preserving autocorr structure */
export function blockResampleIndices(
  n: number,
  blockLen: number,
  rand: () => number,
): number[] {
  const idx: number[] = [];
  while (idx.length < n) {
    const start = Math.floor(rand() * n);
    for (let k = 0; k < blockLen && idx.length < n; k += 1) {
      idx.push((start + k) % n);
    }
  }
  return idx;
}

export function printResult(r: GateResult): void {
  console.log(
    JSON.stringify(
      {
        name: r.name,
        config: r.config,
        nBars: r.nBars,
        honestN: r.honestN,
        netSharpe: +r.netSharpeAnn.toFixed(3),
        grossSharpe: +r.grossSharpeAnn.toFixed(3),
        netMeanBp: +r.netMeanBp.toFixed(2),
        turnover: +r.turnover.toFixed(3),
        buyHoldSharpe: +r.buyHoldSharpe.toFixed(3),
        bootLowerSharpe: +r.bootLowerSharpe.toFixed(3),
        dsrProb: +r.dsrProb.toFixed(4),
        surrogateP: +r.surrogateP.toFixed(4),
        pbo: r.pbo === null ? null : +r.pbo.toFixed(3),
        pass: r.pass,
        bindingGate: r.bindingGate,
        monthlyAt100k: r.monthlyAt100k,
      },
      null,
      0,
    ),
  );
}
