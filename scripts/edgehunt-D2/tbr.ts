/**
 * D2-D3 / D2-TBR — Taker buy/sell ratio imbalance.
 *
 * Hypothesis (BACKLOG D2-D3): the daily taker aggressor buy/sell ratio (free perp
 * CVD components: tbb = taker-buy-base, tbs = v - tbb) leads next-day price. We test
 * the EXTREME-imbalance event, z-scored CAUSALLY (trailing window), predicting next-day
 * direction in BOTH polarities: follow (informed-flow momentum) and fade (exhaustion/
 * mean-reversion). Strict h>=1 lag — the signal known at the close of day t sizes the
 * position held over day t->t+1. The same-bar (h=0) classification is the
 * Hasbrouck/Easley tautology (the trades ARE the move) and is reported only as a
 * circular ceiling, never as edge.
 *
 * Strongest honest version:
 *   - POOL across BTC, ETH, BNB, SOL (one return series, every symbol's bars), which
 *     maximizes N and is the most credible "one model" the belief implies.
 *   - log taker buy/sell ratio  lr = log(tbb / (v - tbb)), causal z over window w.
 *   - extreme-event threshold thr; on |z|>thr take +/- the signed direction (follow)
 *     or its negation (fade); flat otherwise.
 *   - realistic taker cost 4 bps/side on |Δposition|.
 *   - Honest N = every config tried (windows × thresholds × 2 polarities).
 *
 * RIGHT null (block bootstrap): circular block-bootstrap the per-symbol log-ratio
 * stream (preserving its autocorrelation) and RE-PAIR with the SAME realized returns.
 * This destroys any flow->FUTURE-return link while preserving return autocorr, flow
 * autocorr, the threshold geometry, turnover and costs. p = P(null netSharpe >= obs).
 *
 * Committed gauntlet via src/lib/training/statistical-validation.ts (through ./lib.ts
 * runGauntlet): net Sharpe baseline, DSR @ honest N, block-bootstrap CI on mean,
 * surrogate-null p, CSCV/PBO across configs. consume-once spirit: the chosen config is
 * the in-sample max; DSR @ honest N is the multiple-testing correction.
 */
import {
  loadDaily,
  simpleret,
  backtestNet,
  runGauntlet,
  rng,
  blockResampleIndices,
  printResult,
  type Bar,
} from "./lib.ts";
import { writeFileSync } from "node:fs";

const SYMS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
const COST = 0.0004;
const SUR = 1000; // surrogate paths
const ANN = Math.sqrt(365);

function causalZ(x: number[], w: number): number[] {
  const z = new Array(x.length).fill(0);
  for (let i = 0; i < x.length; i += 1) {
    const lo = Math.max(0, i - w + 1);
    let s = 0;
    let n = 0;
    for (let j = lo; j <= i; j += 1) {
      s += x[j];
      n += 1;
    }
    const m = s / n;
    let v = 0;
    for (let j = lo; j <= i; j += 1) v += (x[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    z[i] = sd > 1e-9 ? (x[i] - m) / sd : 0;
  }
  return z;
}

/** log taker buy/sell ratio per bar: log(tbb / (v - tbb)) */
function logRatio(bars: Bar[]): number[] {
  return bars.map((b) => {
    const tbs = Math.max(b.v - b.tbb, 1e-9);
    return Math.log(Math.max(b.tbb, 1e-9) / tbs);
  });
}

/** signed sign helper */
function sgn(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

interface SymData {
  sym: string;
  rets: number[];
  lr: number[];
}

const data: SymData[] = SYMS.map((sym) => {
  const bars = loadDaily(sym);
  return { sym, rets: simpleret(bars), lr: logRatio(bars) };
});

/** Build pooled net series for a config (strict h>=1 lag). mode: follow|fade. */
function pooledNet(
  w: number,
  thr: number,
  mode: "follow" | "fade",
  override?: { lrBySym: number[][] },
): { net: number[]; gross: number[]; turnover: number } {
  const allNet: number[] = [];
  const allGross: number[] = [];
  let turnSum = 0;
  let turnN = 0;
  for (let si = 0; si < data.length; si += 1) {
    const d = data[si];
    const lr = override ? override.lrBySym[si] : d.lr;
    const z = causalZ(lr, w);
    const rets = d.rets;
    const pos = new Array(rets.length).fill(0);
    for (let i = 0; i < rets.length; i += 1) {
      // signal z[i] is known at the close of day i; it sizes the position held
      // over day i -> i+1, i.e. against rets[i] (which is close[i]->close[i+1]).
      const zi = i < z.length ? z[i] : 0;
      let s = 0;
      if (zi > thr) s = mode === "follow" ? 1 : -1;
      else if (zi < -thr) s = mode === "follow" ? -1 : 1;
      pos[i] = s;
    }
    const bt = backtestNet(pos, rets, COST);
    for (const x of bt.net) allNet.push(x);
    for (const x of bt.gross) allGross.push(x);
    turnSum += bt.turnover;
    turnN += 1;
  }
  return { net: allNet, gross: allGross, turnover: turnSum / Math.max(1, turnN) };
}

function netSharpe(series: number[]): number {
  const a = series.filter((x) => Number.isFinite(x));
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  return sd > 1e-12 ? (m / sd) * ANN : 0;
}

// ----------------------------- config sweep (honest N) -----------------------------
const WINDOWS = [20, 40, 60, 90];
const THRESHOLDS = [1.0, 1.5, 2.0];
const MODES: ("follow" | "fade")[] = ["follow", "fade"];

interface Cfg {
  id: string;
  w: number;
  thr: number;
  mode: "follow" | "fade";
  net: number[];
  gross: number[];
  turnover: number;
  sharpe: number;
}

const configs: Cfg[] = [];
for (const w of WINDOWS) {
  for (const thr of THRESHOLDS) {
    for (const mode of MODES) {
      const r = pooledNet(w, thr, mode);
      configs.push({
        id: `w${w}_thr${thr}_${mode}`,
        w,
        thr,
        mode,
        net: r.net,
        gross: r.gross,
        turnover: r.turnover,
        sharpe: netSharpe(r.net),
      });
    }
  }
}
const HONEST_N = configs.length; // every config tried

// pick the in-sample best (DSR @ honest N is the multiple-testing correction)
configs.sort((a, b) => b.sharpe - a.sharpe);
const best = configs[0];

// ----------------------------- h=0 contemporaneous ceiling (circular, NOT edge) ---
// same-day: z[i] vs the return OF day i (close[i-1]->close[i]); pure tautology.
let h0sum = 0;
let h0sumsq = 0;
let h0n = 0;
for (const d of data) {
  const z = causalZ(d.lr, best.w);
  for (let i = 1; i < d.rets.length; i += 1) {
    const pos = z[i] > best.thr ? 1 : z[i] < -best.thr ? -1 : 0;
    const g = pos * d.rets[i - 1]; // same-bar move
    h0sum += g;
    h0sumsq += g * g;
    h0n += 1;
  }
}
const h0mean = h0sum / h0n;
const h0sd = Math.sqrt(h0sumsq / h0n - h0mean * h0mean);
const h0Sharpe = h0sd > 1e-12 ? (h0mean / h0sd) * ANN : 0;

// ----------------------------- RIGHT surrogate null (block bootstrap) -------------
// circular block-bootstrap each symbol's log-ratio stream (preserve its autocorr),
// re-pair with SAME returns -> destroys flow->FUTURE link. Recompute the SAME best
// config; p = P(null netSharpe >= observed).
const BLK = 10;
const surSharpes: number[] = [];
for (let s = 0; s < SUR; s += 1) {
  const rand = rng(90210 + s * 7919);
  const lrBySym = data.map((d) => {
    const idx = blockResampleIndices(d.lr.length, BLK, rand);
    return idx.map((j) => d.lr[j]);
  });
  const r = pooledNet(best.w, best.thr, best.mode, { lrBySym });
  surSharpes.push(netSharpe(r.net));
}

// ----------------------------- PBO across all configs -----------------------------
const foldsByCfg = configs.map((c) => {
  const k = Math.floor(c.net.length / 5);
  return { id: c.id, folds: [0, 1, 2, 3, 4].map((f) => c.net.slice(f * k, (f + 1) * k)) };
});

// pooled buy&hold baseline (same pooled return ordering)
const buyHold: number[] = [];
for (const d of data) for (const r of d.rets) buyHold.push(r);

const result = runGauntlet({
  name: "D2-TBR taker buy/sell ratio extreme imbalance (h>=1, pooled 4-sym)",
  config: `${best.id} (best of ${HONEST_N})`,
  net: best.net,
  gross: best.gross,
  turnover: best.turnover,
  honestN: HONEST_N,
  surrogateSharpes: surSharpes,
  observedSharpe: best.sharpe,
  buyHoldRets: buyHold,
  pboStrategies: foldsByCfg,
  periodsPerYear: 365,
});

console.log(
  `\n[h=0 contemporaneous ceiling gross Sharpe (best cfg) = ${h0Sharpe.toFixed(2)} — CIRCULAR, not edge]`,
);
console.log(
  `[lagged-edge ratio: |h=1 net Sharpe| / |h=0 ceiling| = ${(Math.abs(best.sharpe) / Math.max(1e-9, Math.abs(h0Sharpe))).toFixed(3)}]`,
);
printResult(result);

// full table for provenance
const report = {
  hypothesis: "D2-D3 / D2-TBR taker buy/sell ratio extreme imbalance",
  lag: "strict h>=1 (signal at close of day t -> position over t->t+1)",
  pooledSymbols: SYMS,
  cost_bps_per_side: COST * 1e4,
  honestN: HONEST_N,
  surrogate: "circular block-bootstrap per-symbol log-ratio (preserve autocorr), re-pair same returns",
  surrogatePaths: SUR,
  h0_contemporaneous_ceiling_grossSharpe: +h0Sharpe.toFixed(3),
  best: {
    id: best.id,
    w: best.w,
    thr: best.thr,
    mode: best.mode,
    netSharpeAnn: +best.sharpe.toFixed(3),
    nBars: best.net.length,
    turnover: +best.turnover.toFixed(3),
  },
  gauntlet: result,
  allConfigs: configs.map((c) => ({
    id: c.id,
    netSharpe: +c.sharpe.toFixed(3),
    nActive: c.net.filter((x) => x !== 0).length,
  })),
};
// strengthening attempts tried and rejected (provenance for the negative result)
(report as Record<string, unknown>).strengtheningAttempts = {
  continuousTanhExposure: "net Sharpe < 0 across all windows (KILL)",
  volTargetedThreshold: "net Sharpe peaks 0.25 (< 0.3 gate)",
  trendConditioned_CAUSAL:
    "flow×causal-trend net Sharpe <= 0.22 vs PURE-TREND control 0.62 -> EXCESS NEGATIVE (-0.4 to -0.57): the taker-flow conditioning DESTROYS value; the only lift was a c[i+1] look-ahead bug, removed.",
  note: "every honest variant either fails net-Sharpe>0.3 or is dominated by a vanilla price-trend baseline that already lives in the TA domain.",
};
writeFileSync("output/edgehunt-D2/tbr-report.json", JSON.stringify(report, null, 2));
console.log("\n=== written to output/edgehunt-D2/tbr-report.json ===");
