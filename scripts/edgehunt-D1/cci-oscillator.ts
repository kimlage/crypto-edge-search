/**
 * D1-06 Commodity Channel Index (CCI) — strongest honest version + the gauntlet.
 *
 * Belief (Lambert 1980): CCI > +100 = trend-confirming long; CCI < -100 = oversold reversal.
 *
 * Strongest honest mechanism: CCI is a z-scored oscillator of the typical price
 *   TP = (H+L+C)/3
 *   CCI = (TP - SMA(TP, n)) / (0.015 * meanAbsDev(TP, n))
 * The 0.015 constant just rescales so ~70-80% of values sit in [-100, +100]; algebraically CCI is
 * a (mean-absolute-deviation) z-score of TP about its own SMA. That makes it a near-cousin of RSI
 * and the Stochastic oscillator — both already KILLED in TA4. The honest job here is:
 *   (a) build the best version we can (both polarities: trend-follow CCI extremes AND revert them),
 *   (b) KEY CONTROL: compute the same-grid killed RSI book and show whether CCI BEATS it,
 *   (c) INHERIT-THE-KILL: report the correlation of the CCI signal to the RSI signal. If corr ~ 1,
 *       CCI is a monotone reparameterization of an already-dead oscillator and inherits TA4's KILL.
 *
 * Everything causal. 8 majors, equal-risk book, vol-scaled, long/flat + long/short, 4 bps taker
 * charged on every change of signed position size.
 *
 * Gates (committed harness, src/lib/training/statistical-validation.ts):
 *   - Net-of-cost annualized Sharpe; monthly % and $ at $100k.
 *   - Deflated Sharpe @ HONEST N (= every config tried across the full sweep).
 *   - Block-bootstrap CI on mean daily net return (> 0).
 *   - CSCV/PBO across all swept configs.
 *   - KEY CONTROL: must BEAT the killed RSI book (paired excess > 0, deflated-vs-RSI-Sharpe).
 *   - INHERIT-THE-KILL: corr(CCI signal, RSI signal). corr ~ 1 => inherits TA4 RSI KILL.
 *   - RIGHT surrogate null x2:
 *       (1) phase-randomization of each coin's log returns (destroys nonlinear/serial structure,
 *           preserves the power spectrum / linear autocorrelation & marginal vol), recompute CCI;
 *       (2) vol-preserving stationary block-bootstrap of log returns (preserves vol clustering /
 *           fat tails), rebuild OHLC, recompute CCI on the surrogate, re-run the full book.
 *     Observed net Sharpe must beat BOTH surrogate distributions.
 *
 * Honest N counts the full Cartesian sweep {period x threshold x mode x side x volTarget}.
 */

import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004; // 4 bps taker
const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"];

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

function loadSymbol(sym: string): Bar[] {
  const raw = JSON.parse(
    fs.readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`, "utf8"),
  ) as Bar[];
  return raw.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
}

// align all symbols on a common date axis
const perSym: Record<string, Bar[]> = {};
for (const s of SYMBOLS) perSym[s] = loadSymbol(s);
const allDates = Array.from(
  new Set(SYMBOLS.flatMap((s) => perSym[s].map((b) => b.date))),
).sort();
const DATES = allDates;
const T = DATES.length;
const dateIdx = new Map(DATES.map((d, i) => [d, i]));

const barAt: Record<string, (Bar | null)[]> = {};
for (const s of SYMBOLS) {
  const arr: (Bar | null)[] = Array<Bar | null>(T).fill(null);
  for (const b of perSym[s]) {
    const i = dateIdx.get(b.date);
    if (i != null) arr[i] = b;
  }
  barAt[s] = arr;
}

const logret: Record<string, (number | null)[]> = {};
for (const s of SYMBOLS) {
  const r: (number | null)[] = Array<number | null>(T).fill(null);
  const arr = barAt[s];
  for (let t = 1; t < T; t++) {
    const a = arr[t - 1];
    const b = arr[t];
    if (a && b && a.close > 0 && b.close > 0) r[t] = Math.log(b.close / a.close);
  }
  logret[s] = r;
}

// ----------------------- Causal CCI -----------------------
/**
 * Causal CCI per bar. Uses only bars up to and including t (trailing window of length n of present
 * bars). Signal at index t is FORMED at the close of t and applied to t->t+1 return (no look-ahead).
 * Returns the raw CCI value array (null until n present bars accumulated / where no bar).
 */
function cciSeries(bars: (Bar | null)[], period: number): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = Array<number | null>(n).fill(null);
  const tpWin: number[] = []; // trailing window of typical prices (present bars only)
  for (let t = 0; t < n; t++) {
    const b = bars[t];
    if (!b) {
      out[t] = null;
      continue;
    }
    const tp = (b.high + b.low + b.close) / 3;
    tpWin.push(tp);
    if (tpWin.length > period) tpWin.shift();
    if (tpWin.length < period) {
      out[t] = null;
      continue;
    }
    const sma = tpWin.reduce((a, x) => a + x, 0) / period;
    let mad = 0;
    for (const x of tpWin) mad += Math.abs(x - sma);
    mad /= period;
    if (mad < 1e-12) {
      out[t] = 0;
      continue;
    }
    out[t] = (tp - sma) / (0.015 * mad);
  }
  return out;
}

// ----------------------- Causal RSI (key control: the already-killed oscillator) -----------------------
function rsiSeries(bars: (Bar | null)[], period: number): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = Array<number | null>(n).fill(null);
  let avgGain = NaN;
  let avgLoss = NaN;
  let prevClose = NaN;
  let warm = 0;
  for (let t = 0; t < n; t++) {
    const b = bars[t];
    if (!b) {
      out[t] = null;
      continue;
    }
    if (!Number.isFinite(prevClose)) {
      prevClose = b.close;
      out[t] = null;
      continue;
    }
    const ch = b.close - prevClose;
    const gain = Math.max(0, ch);
    const loss = Math.max(0, -ch);
    if (!Number.isFinite(avgGain)) {
      avgGain = gain;
      avgLoss = loss;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    prevClose = b.close;
    warm++;
    if (warm < period) {
      out[t] = null;
      continue;
    }
    const rs = avgLoss < 1e-12 ? 100 : avgGain / avgLoss;
    out[t] = 100 - 100 / (1 + rs);
  }
  return out;
}

// ----------------------- signal mapping -----------------------
type Mode = "trend" | "revert";
type Side = "longflat" | "longshort";

/**
 * Map a CCI value series -> signed position signal {+1,0,-1}.
 *  trend mode: long when CCI > +thr; short when CCI < -thr.
 *  revert mode: long when CCI < -thr (oversold bounce); short when CCI > +thr (overbought fade).
 * Side longflat suppresses shorts.
 */
function cciSignal(
  cci: (number | null)[],
  thr: number,
  mode: Mode,
  side: Side,
): (number | null)[] {
  const n = cci.length;
  const out: (number | null)[] = Array<number | null>(n).fill(null);
  let pos = 0;
  for (let t = 0; t < n; t++) {
    const v = cci[t];
    if (v == null) {
      out[t] = null;
      continue;
    }
    // hysteresis: hold until crossing zero (typical CCI usage) for stability
    let desired = pos;
    if (mode === "trend") {
      if (v > thr) desired = 1;
      else if (v < -thr) desired = -1;
      else if (pos === 1 && v < 0) desired = 0;
      else if (pos === -1 && v > 0) desired = 0;
    } else {
      // revert
      if (v < -thr) desired = 1;
      else if (v > thr) desired = -1;
      else if (pos === 1 && v > 0) desired = 0;
      else if (pos === -1 && v < 0) desired = 0;
    }
    if (desired < 0 && side === "longflat") desired = 0;
    pos = desired;
    out[t] = pos;
  }
  return out;
}

// RSI signal on the same convention for the control book (RSI 30/70 style, both modes/sides).
function rsiSignal(
  rsi: (number | null)[],
  lo: number,
  hi: number,
  mode: Mode,
  side: Side,
): (number | null)[] {
  const n = rsi.length;
  const out: (number | null)[] = Array<number | null>(n).fill(null);
  let pos = 0;
  for (let t = 0; t < n; t++) {
    const v = rsi[t];
    if (v == null) {
      out[t] = null;
      continue;
    }
    let desired = pos;
    if (mode === "trend") {
      if (v > hi) desired = 1;
      else if (v < lo) desired = -1;
      else if (pos === 1 && v < 50) desired = 0;
      else if (pos === -1 && v > 50) desired = 0;
    } else {
      if (v < lo) desired = 1;
      else if (v > hi) desired = -1;
      else if (pos === 1 && v > 50) desired = 0;
      else if (pos === -1 && v < 50) desired = 0;
    }
    if (desired < 0 && side === "longflat") desired = 0;
    pos = desired;
    out[t] = pos;
  }
  return out;
}

// ----------------------- trailing vol -----------------------
function trailingVolFrom(
  r: (number | null)[],
  t: number,
  win: number,
): number {
  const vals: number[] = [];
  for (let k = Math.max(1, t - win); k < t; k++) {
    const v = r[k];
    if (v != null) vals.push(v);
  }
  if (vals.length < 10) return NaN;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varr = vals.reduce((a, x) => a + (x - m) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(Math.max(0, varr));
}

// ----------------------- book backtest -----------------------
interface Config {
  period: number;
  thr: number;
  mode: Mode;
  side: Side;
  volTarget: number;
  volWin: number;
}
interface BookResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number[];
}
const VOL_CAP = 3;

function runBookGeneric(
  cfg: Config,
  signalBySym: Record<string, (number | null)[]>,
  lr: Record<string, (number | null)[]>,
): BookResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  const turnoverArr: number[] = [];
  const prevW: Record<string, number> = {};
  for (const s of SYMBOLS) prevW[s] = 0;
  const dailyTargetVol = cfg.volTarget / Math.sqrt(365);

  for (let t = 1; t < T; t++) {
    let grossBook = 0;
    let turnover = 0;
    const newW: Record<string, number> = {};
    for (const s of SYMBOLS) {
      const sig = signalBySym[s][t - 1];
      const r = lr[s][t];
      let w = 0;
      if (sig != null && sig !== 0) {
        if (cfg.volTarget > 0) {
          const v = trailingVolFrom(lr[s], t, cfg.volWin);
          if (Number.isFinite(v) && v > 1e-9)
            w = sig * Math.min(VOL_CAP, dailyTargetVol / v);
        } else w = sig;
      }
      newW[s] = w;
      turnover += Math.abs(w - (prevW[s] ?? 0));
      if (r != null && w !== 0) grossBook += w * (Math.exp(r) - 1);
    }
    const denom = SYMBOLS.length;
    const grossNorm = grossBook / denom;
    const cost = (turnover / denom) * COST_PER_SIDE;
    dailyGross.push(grossNorm);
    dailyNet.push(grossNorm - cost);
    turnoverArr.push(turnover / denom);
    for (const s of SYMBOLS) prevW[s] = newW[s];
  }
  return { dailyNet, dailyGross, turnover: turnoverArr };
}

function annualizeSharpe(dailySharpe: number): number {
  return dailySharpe * Math.sqrt(365);
}

// ----------------------- HONEST N sweep (CCI) -----------------------
const periods = [14, 20, 30, 50];
const thresholds = [80, 100, 150, 200];
const modes: Mode[] = ["trend", "revert"];
const sides: Side[] = ["longflat", "longshort"];
const volTargets = [0, 0.4];
const volWin = 30;

const configs: Config[] = [];
for (const p of periods)
  for (const thr of thresholds)
    for (const md of modes)
      for (const sd of sides)
        for (const vt of volTargets)
          configs.push({ period: p, thr, mode: md, side: sd, volTarget: vt, volWin });

const HONEST_N = configs.length;

// cache CCI value series per period
const cciCache: Record<number, Record<string, (number | null)[]>> = {};
for (const p of periods) {
  cciCache[p] = {};
  for (const s of SYMBOLS) cciCache[p][s] = cciSeries(barAt[s], p);
}

function cciSignalsFor(cfg: Config): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS)
    out[s] = cciSignal(cciCache[cfg.period][s], cfg.thr, cfg.mode, cfg.side);
  return out;
}

interface Scored {
  cfg: Config;
  label: string;
  res: BookResult;
  netSharpeAnn: number;
  grossSharpeAnn: number;
  meanDailyNet: number;
  avgTurnover: number;
}

const scored: Scored[] = configs.map((cfg) => {
  const sigs = cciSignalsFor(cfg);
  const res = runBookGeneric(cfg, sigs, logret);
  const sNet = summarizeReturnSeries(res.dailyNet);
  const sGross = summarizeReturnSeries(res.dailyGross);
  const activeTurns = res.turnover.filter((x) => x > 0);
  const avgTurnover =
    activeTurns.reduce((a, b) => a + b, 0) / Math.max(1, activeTurns.length);
  return {
    cfg,
    label: `cci_p${cfg.period}_thr${cfg.thr}_${cfg.mode}_${cfg.side}_vt${cfg.volTarget}`,
    res,
    netSharpeAnn: annualizeSharpe(sNet.sharpe),
    grossSharpeAnn: annualizeSharpe(sGross.sharpe),
    meanDailyNet: sNet.mean,
    avgTurnover,
  };
});
scored.sort((a, b) => b.netSharpeAnn - a.netSharpeAnn);
const best = scored[0];

// ----------------------- KEY CONTROL: same-grid killed RSI book -----------------------
// Build an analogous RSI sweep (same N-ish grid) and find its best net book. CCI must beat it.
// RSI thresholds mapped from CCI extremes: use {lo,hi} pairs around 50.
const rsiPeriods = [14, 20, 30, 50];
const rsiBands: Array<[number, number]> = [
  [20, 80],
  [30, 70],
  [10, 90],
  [25, 75],
];
let bestRsi: { label: string; res: BookResult; netSharpeAnn: number } | null =
  null;
const rsiCache: Record<number, Record<string, (number | null)[]>> = {};
for (const p of rsiPeriods) {
  rsiCache[p] = {};
  for (const s of SYMBOLS) rsiCache[p][s] = rsiSeries(barAt[s], p);
}
for (const p of rsiPeriods)
  for (const [lo, hi] of rsiBands)
    for (const md of modes)
      for (const sd of sides)
        for (const vt of volTargets) {
          const cfg: Config = {
            period: p,
            thr: 0,
            mode: md,
            side: sd,
            volTarget: vt,
            volWin,
          };
          const sigs: Record<string, (number | null)[]> = {};
          for (const s of SYMBOLS)
            sigs[s] = rsiSignal(rsiCache[p][s], lo, hi, md, sd);
          const res = runBookGeneric(cfg, sigs, logret);
          const sh = annualizeSharpe(summarizeReturnSeries(res.dailyNet).sharpe);
          if (!bestRsi || sh > bestRsi.netSharpeAnn)
            bestRsi = {
              label: `rsi_p${p}_${lo}/${hi}_${md}_${sd}_vt${vt}`,
              res,
              netSharpeAnn: sh,
            };
        }
const rsiBest = bestRsi!;

// ----------------------- INHERIT-THE-KILL: corr(CCI signal, RSI signal) -----------------------
// On the BEST CCI config, compute the matched RSI signal (same period, comparable bands) and report
// the Pearson correlation of the per-coin per-day signed signals (pooled). corr ~ 1 => CCI inherits
// TA4's RSI KILL (it's a monotone reparameterization of the same oscillator).
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let sa = 0,
    sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n,
    mb = sb / n;
  let cov = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma,
      db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va < 1e-12 || vb < 1e-12) return NaN;
  return cov / Math.sqrt(va * vb);
}

// matched RSI bands for the best CCI config: revert<->oversold/overbought map naturally.
// CCI thr 100 ~ RSI 70/30; thr 150 ~ 80/20; thr 200 ~ 90/10; thr 80 ~ 65/35.
function matchedRsiBand(thr: number): [number, number] {
  if (thr >= 200) return [10, 90];
  if (thr >= 150) return [20, 80];
  if (thr >= 100) return [30, 70];
  return [35, 65];
}

// (a) signal-level corr (signed positions, pooled across coins/time)
const cciSigBest = cciSignalsFor(best.cfg);
const [mlo, mhi] = matchedRsiBand(best.cfg.thr);
const pooledCci: number[] = [];
const pooledRsi: number[] = [];
for (const s of SYMBOLS) {
  const rs = rsiSeries(barAt[s], best.cfg.period);
  const rsig = rsiSignal(rs, mlo, mhi, best.cfg.mode, best.cfg.side);
  for (let t = 0; t < T; t++) {
    const c = cciSigBest[s][t];
    const r = rsig[t];
    if (c != null && r != null) {
      pooledCci.push(c);
      pooledRsi.push(r);
    }
  }
}
const sigCorr = pearson(pooledCci, pooledRsi);

// (b) raw oscillator-value corr (CCI value vs RSI value), the deeper "z-score cousin" check
const pooledCciVal: number[] = [];
const pooledRsiVal: number[] = [];
for (const s of SYMBOLS) {
  const cv = cciCache[best.cfg.period][s];
  const rv = rsiSeries(barAt[s], best.cfg.period);
  for (let t = 0; t < T; t++) {
    if (cv[t] != null && rv[t] != null) {
      pooledCciVal.push(cv[t]!);
      pooledRsiVal.push(rv[t]!);
    }
  }
}
const valCorr = pearson(pooledCciVal, pooledRsiVal);

// ----------------------- gates on best config -----------------------
const bestNet = best.res.dailyNet;
const nDays = bestNet.length;
const yearsCovered = nDays / 365;

const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const dsrVsRsi = computeDeflatedSharpeRatio(bestNet, {
  trialCount: HONEST_N,
  benchmarkSharpe: summarizeReturnSeries(rsiBest.res.dailyNet).sharpe,
});

const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 15,
  confidenceLevel: 0.95,
  seed: "cci-best",
});

// paired excess vs killed RSI book
const excess: number[] = [];
const rsiNet = rsiBest.res.dailyNet;
for (let i = 0; i < bestNet.length; i++)
  excess.push(bestNet[i] - (rsiNet[i] ?? 0));
const bbExcess = blockBootstrapConfidenceInterval(excess, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 15,
  confidenceLevel: 0.95,
  seed: "cci-excess-vs-rsi",
});

const NFOLDS = 6;
function toFolds(series: number[]): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / NFOLDS);
  for (let f = 0; f < NFOLDS; f++) {
    const lo = f * sz;
    const hi = f === NFOLDS - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}
const pbo = estimateCscvPbo(
  scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet) })),
  { statistic: "sharpe", trainFraction: 0.5 },
);

// ----------------------- RNG -----------------------
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------- SURROGATE 1: phase randomization -----------------------
// Phase-randomize each coin's log-return series: FFT -> randomize phases -> inverse FFT. Preserves
// the power spectrum (linear autocorrelation) & marginal variance, destroys nonlinear/serial
// (trend) structure that an oscillator could exploit. Rebuild OHLC (flat-ish intrabar from |r|),
// recompute CCI, re-run the BEST config book.
function dft(re: number[], im: number[], inverse: boolean): void {
  const n = re.length;
  const outRe = new Array(n).fill(0);
  const outIm = new Array(n).fill(0);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++) {
    let sr = 0,
      si = 0;
    for (let j = 0; j < n; j++) {
      const ang = (sign * 2 * Math.PI * k * j) / n;
      const c = Math.cos(ang),
        s = Math.sin(ang);
      sr += re[j] * c - im[j] * s;
      si += re[j] * s + im[j] * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  for (let k = 0; k < n; k++) {
    re[k] = inverse ? outRe[k] / n : outRe[k];
    im[k] = inverse ? outIm[k] / n : outIm[k];
  }
}

function phaseRandReturns(
  series: number[],
  rng: () => number,
): number[] {
  const n = series.length;
  if (n < 8) return series.slice();
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const re = series.map((x) => x - mean);
  const im = new Array(n).fill(0);
  dft(re, im, false);
  // randomize phases, preserve magnitudes, keep conjugate symmetry for a real signal
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    const ph = 2 * Math.PI * rng();
    re[k] = mag * Math.cos(ph);
    im[k] = mag * Math.sin(ph);
    const mirror = n - k;
    if (mirror !== k && mirror < n) {
      re[mirror] = re[k];
      im[mirror] = -im[k];
    }
  }
  if (n % 2 === 0) im[half] = 0; // Nyquist real
  dft(re, im, true);
  return re.map((x) => x + mean);
}

// Build surrogate OHLC from a return series: reconstruct close path; create a mild symmetric
// intrabar range proportional to |r| so CCI's typical-price MAD has a realistic scale.
function barsFromReturns(
  startPrice: number,
  rets: number[],
  slots: number[],
): (Bar | null)[] {
  const out: (Bar | null)[] = Array<Bar | null>(T).fill(null);
  let close = startPrice;
  for (let i = 0; i < slots.length; i++) {
    const prev = close;
    close = close * Math.exp(rets[i]);
    const t = slots[i];
    const rng = Math.abs(rets[i]);
    const high = Math.max(prev, close) * Math.exp(0.5 * rng);
    const low = Math.min(prev, close) * Math.exp(-0.5 * rng);
    out[t] = {
      date: DATES[t],
      open: prev,
      high,
      low,
      close,
    };
  }
  return out;
}

function bookSharpeOnBars(
  cfg: Config,
  surBars: Record<string, (Bar | null)[]>,
): number {
  const surLogret: Record<string, (number | null)[]> = {};
  const sigs: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS) {
    const sb = surBars[s];
    const r: (number | null)[] = Array<number | null>(T).fill(null);
    let p = -1;
    for (let t = 0; t < T; t++) {
      if (sb[t]) {
        if (p >= 0 && sb[p]) r[t] = Math.log(sb[t]!.close / sb[p]!.close);
        p = t;
      }
    }
    surLogret[s] = r;
    sigs[s] = cciSignal(cciSeries(sb, cfg.period), cfg.thr, cfg.mode, cfg.side);
  }
  const res = runBookGeneric(cfg, sigs, surLogret);
  return annualizeSharpe(summarizeReturnSeries(res.dailyNet).sharpe);
}

function phaseSurrogateSharpe(cfg: Config, seed: number): number {
  const surBars: Record<string, (Bar | null)[]> = {};
  for (const s of SYMBOLS) {
    const rng = mkRng(seed + s.charCodeAt(0) * 131 + s.charCodeAt(1) * 17);
    const validIdx: number[] = [];
    for (let t = 1; t < T; t++) if (logret[s][t] != null) validIdx.push(t);
    if (validIdx.length < 50) {
      surBars[s] = Array<Bar | null>(T).fill(null);
      continue;
    }
    const rets = validIdx.map((t) => logret[s][t]!);
    const surRets = phaseRandReturns(rets, rng);
    const start = barAt[s][validIdx[0] - 1]?.close ?? barAt[s][validIdx[0]]!.close;
    surBars[s] = barsFromReturns(start, surRets, validIdx);
  }
  return bookSharpeOnBars(cfg, surBars);
}

// ----------------------- SURROGATE 2: vol-preserving stationary block-bootstrap -----------------------
function stationaryBootstrap(
  m: number,
  length: number,
  meanBlock: number,
  rng: () => number,
): number[] {
  const out: number[] = [];
  if (m === 0) return out;
  let pos = Math.floor(rng() * m);
  for (let i = 0; i < length; i++) {
    out.push(pos);
    if (rng() < 1 / meanBlock) pos = Math.floor(rng() * m);
    else pos = (pos + 1) % m;
  }
  return out;
}

function blockSurrogateSharpe(cfg: Config, seed: number): number {
  const surBars: Record<string, (Bar | null)[]> = {};
  for (const s of SYMBOLS) {
    const rng = mkRng(seed + s.charCodeAt(0) * 131 + s.charCodeAt(1) * 17);
    const validIdx: number[] = [];
    for (let t = 1; t < T; t++) if (logret[s][t] != null) validIdx.push(t);
    if (validIdx.length < 50) {
      surBars[s] = Array<Bar | null>(T).fill(null);
      continue;
    }
    // geometry per valid index (intrabar shape relative to close), preserve fat tails & vol blocks
    const geom = validIdx.map((t) => {
      const b = barAt[s][t]!;
      return {
        r: logret[s][t]!,
        hi: Math.log(b.high / b.close),
        lo: Math.log(b.low / b.close),
        op: Math.log(b.open / b.close),
      };
    });
    const sampled = stationaryBootstrap(geom.length, geom.length, 20, rng);
    const start = barAt[s][validIdx[0] - 1]?.close ?? barAt[s][validIdx[0]]!.close;
    const out: (Bar | null)[] = Array<Bar | null>(T).fill(null);
    let close = start;
    for (let i = 0; i < validIdx.length; i++) {
      const t = validIdx[i];
      const g = geom[sampled[i]];
      close = close * Math.exp(g.r);
      const c = close;
      out[t] = {
        date: DATES[t],
        open: Math.max(1e-9, c * Math.exp(g.op)),
        high: Math.max(c * Math.exp(g.hi), c),
        low: Math.min(c * Math.exp(g.lo), c),
        close: c,
      };
    }
    surBars[s] = out;
  }
  return bookSharpeOnBars(cfg, surBars);
}

const N_SURR = 200;
const phaseSurr: number[] = [];
const blockSurr: number[] = [];
for (let i = 0; i < N_SURR; i++) {
  phaseSurr.push(phaseSurrogateSharpe(best.cfg, 3000 + i * 7919));
  blockSurr.push(blockSurrogateSharpe(best.cfg, 5000 + i * 9973));
}
phaseSurr.sort((a, b) => a - b);
blockSurr.sort((a, b) => a - b);
const phaseMean = phaseSurr.reduce((a, b) => a + b, 0) / phaseSurr.length;
const blockMean = blockSurr.reduce((a, b) => a + b, 0) / blockSurr.length;
const phaseP =
  (phaseSurr.filter((s) => s >= best.netSharpeAnn).length + 1) / (N_SURR + 1);
const blockP =
  (blockSurr.filter((s) => s >= best.netSharpeAnn).length + 1) / (N_SURR + 1);
const surrP = Math.max(phaseP, blockP); // must beat the more permissive null

// ----------------------- monthly $ -----------------------
const monthlyPct = best.meanDailyNet * 30;
const monthlyAt100k = monthlyPct * 100000;

function round(x: number, d = 3): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

// ----------------------- inherit-the-kill verdict logic -----------------------
const INHERIT_KILL = Math.abs(sigCorr) > 0.9; // CCI signal ~ RSI signal => inherits TA4 RSI KILL

// ----------------------- gate evaluation -----------------------
const passDSR = dsr.deflatedProbability > 0.95;
const passDSRvsRsi = dsrVsRsi.deflatedProbability > 0.95;
const passBootstrap = bb.lower > 0;
const passBeatsRsiExcess = bbExcess.lower > 0;
const passPBO = pbo.pbo < 0.5;
const passSurrogate = surrP < 0.05;
const beatsRsi = best.netSharpeAnn > rsiBest.netSharpeAnn;
const notInherited = !INHERIT_KILL;

const gateNames = [
  ["inherit-the-kill: corr(CCI,RSI)<=0.9", notInherited],
  ["beats-killed-RSI-Sharpe", beatsRsi],
  ["excess-vs-RSI>0", passBeatsRsiExcess],
  ["deflatedSharpe@N", passDSR],
  ["deflatedSharpe-vs-RSI", passDSRvsRsi],
  ["bootstrapMeanNet>0", passBootstrap],
  ["cscvPBO<0.5", passPBO],
  ["surrogateNull-p<0.05", passSurrogate],
] as const;
const allPass = gateNames.every(([, p]) => p);
const binding = gateNames.find(([, p]) => !p)?.[0] ?? "none";

let verdict: "SURVIVE" | "PROMISING" | "KILL";
if (INHERIT_KILL) verdict = "KILL";
else if (allPass) verdict = "SURVIVE";
else if (
  best.netSharpeAnn > 0.5 &&
  beatsRsi &&
  surrP < 0.1 &&
  best.grossSharpeAnn > 0
)
  verdict = "PROMISING";
else verdict = "KILL";

const report = {
  hypothesis: "D1-06 CCI (z-scored typical-price oscillator), 8-major equal-risk book",
  universe: { coins: SYMBOLS, dates: T, from: DATES[0], to: DATES[T - 1] },
  honestN: HONEST_N,
  realisticCostPerSide: COST_PER_SIDE,
  best: {
    label: best.label,
    cfg: best.cfg,
    netSharpeAnnual: round(best.netSharpeAnn),
    grossSharpeAnnual: round(best.grossSharpeAnn),
    meanDailyNet: best.meanDailyNet,
    monthlyPctOfNotional: round(monthlyPct * 100),
    monthlyAt100k: round(monthlyAt100k),
    daysActive: nDays,
    yearsCovered: round(yearsCovered),
    avgTurnoverPerDay: round(best.avgTurnover, 4),
  },
  keyControl_killedRSI: {
    rsiBestLabel: rsiBest.label,
    rsiBestNetSharpeAnnual: round(rsiBest.netSharpeAnn),
    cciBeatsRSI: beatsRsi,
  },
  inheritTheKill: {
    signalCorr_cci_vs_rsi: round(sigCorr, 4),
    oscillatorValueCorr_cci_vs_rsi: round(valCorr, 4),
    inheritsRSIKill: INHERIT_KILL,
    note:
      "CCI = MAD z-score of typical price; |corr|>0.9 of the signed signal => monotone reparam of the already-killed RSI => inherits TA4 RSI KILL.",
  },
  gates: {
    deflatedSharpe: {
      trialCount: dsr.trialCount,
      sharpeDaily: round(dsr.sharpe, 4),
      expectedMaxSharpeDaily: round(dsr.expectedMaxSharpe, 4),
      deflatedProbability: round(dsr.deflatedProbability, 4),
      pass: passDSR,
    },
    deflatedSharpeVsRSI: {
      deflatedProbability: round(dsrVsRsi.deflatedProbability, 4),
      pass: passDSRvsRsi,
    },
    bootstrapMeanNet: {
      lower: bb.lower,
      mean: bb.mean,
      upper: bb.upper,
      pass: passBootstrap,
    },
    excessVsRSI: {
      lower: bbExcess.lower,
      mean: bbExcess.mean,
      upper: bbExcess.upper,
      pass: passBeatsRsiExcess,
    },
    cscvPBO: { pbo: round(pbo.pbo, 4), pass: passPBO },
    surrogateNull: {
      phase: {
        mean: round(phaseMean),
        p95: round(phaseSurr[Math.floor(N_SURR * 0.95)]),
        p: round(phaseP, 4),
      },
      block: {
        mean: round(blockMean),
        p95: round(blockSurr[Math.floor(N_SURR * 0.95)]),
        p: round(blockP, 4),
      },
      combinedP: round(surrP, 4),
      pass: passSurrogate,
    },
  },
  verdict,
  bindingGate: binding,
  topConfigs: scored.slice(0, 8).map((s) => ({
    label: s.label,
    netSharpe: round(s.netSharpeAnn),
    grossSharpe: round(s.grossSharpeAnn),
    avgTurnover: round(s.avgTurnover, 4),
  })),
};

fs.mkdirSync(`${ROOT}/output/edgehunt-D1`, { recursive: true });
fs.writeFileSync(
  `${ROOT}/output/edgehunt-D1/cci-report.json`,
  JSON.stringify(report, null, 2),
);

console.log(JSON.stringify(report, null, 2));
console.log(
  `\nVERDICT: ${verdict} | net Sharpe ${round(best.netSharpeAnn)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${round(surrP, 4)} | monthly@$100k ${monthlyAt100k > 0 ? "$" + round(monthlyAt100k) : "$" + round(monthlyAt100k)} | corr(CCI,RSI) ${round(sigCorr, 3)}`,
);
