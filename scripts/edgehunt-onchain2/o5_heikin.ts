/**
 * O5-HEIKIN — Heikin-Ashi trend-transform timer (BACKLOG D1-09).
 *
 * Belief: stay long while Heikin-Ashi (HA) candles are bullish (green, no/short lower wick),
 * flat otherwise. Daily BTC. Long-flat only (no shorts).
 *
 * Documented trap (CLAUDE.md / BACKLOG D1 #5): long-flat price-transform overlays (HA/Renko)
 * ALWAYS post 1.5+ Sharpe on a rising asset. To survive, the rule MUST:
 *   (1) out-Sharpe its OWN buy&hold after deflation  (baselines gate: best.netSh > bhSh), AND
 *   (2) beat a VOL/SPECTRUM-PRESERVING surrogate-recompute null:
 *        phase-randomize the daily log-return path (preserves variance + power spectrum, i.e.
 *        all linear autocorrelation, destroys the nonlinear/asymmetric trend structure HA claims
 *        to exploit), rebuild a synthetic OHLC path, RECOMPUTE Heikin-Ashi on it, re-derive the
 *        long-flat positions, and earn them on the SAME phase-randomized forward returns.
 *   If HA on a same-spectrum/same-vol surrogate posts the same Sharpe, the edge is pure path/beta.
 *
 * Data: TRUE daily OHLC aggregated from output/bigquery/btc_ohlcv_15m.ndjson (Binance, 2017-08+).
 * This is the honest source for HA (HA needs real O/H/L/C; close-as-OHLC would be a degraded proxy).
 *
 * Causality: HA candle for day t uses only bars up to the close of day t. Position from the HA
 * state at close t is held over t -> t+1 (earns fwdRet[t]). On-chain features are not used here;
 * this is a pure price-transform timer, so the only lag concern is the >=close-t HA computation.
 *
 * Honest N: every (signal variant x parameter) config in the grid is a trial. DSR/Bonferroni
 * deflate against the full grid count.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);

// ---------------------------------------------------------------- math utils
function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
function annSharpe(d: number): number {
  return d * ANN;
}
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

// ---------------------------------------------------------------- daily OHLC
interface OHLC {
  dates: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  fwdRet: number[]; // log close[t]->close[t+1]; last = NaN
}

function loadDailyOHLC(): OHLC {
  const raw = fs.readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`, "utf8").trim().split("\n");
  // aggregate 15m -> daily by event_date (UTC). Bars are sorted ascending already.
  const byDay = new Map<string, { o: number; h: number; l: number; c: number; firstT: string; lastT: string }>();
  for (const ln of raw) {
    if (!ln) continue;
    const r = JSON.parse(ln);
    const d = r.event_date as string;
    const o = +r.open, h = +r.high, l = +r.low, c = +r.close;
    if (!(c > 0)) continue;
    const cur = byDay.get(d);
    if (!cur) {
      byDay.set(d, { o, h, l, c, firstT: r.event_time, lastT: r.event_time });
    } else {
      if (r.event_time < cur.firstT) { cur.o = o; cur.firstT = r.event_time; }
      if (r.event_time > cur.lastT) { cur.c = c; cur.lastT = r.event_time; }
      if (h > cur.h) cur.h = h;
      if (l < cur.l) cur.l = l;
    }
  }
  const dates = [...byDay.keys()].sort();
  // drop the last (possibly partial) day to avoid a truncated bar
  // (we still drop the very last index from fwdRet anyway)
  const out: OHLC = { dates: [], open: [], high: [], low: [], close: [], fwdRet: [] };
  for (const d of dates) {
    const b = byDay.get(d)!;
    out.dates.push(d);
    out.open.push(b.o);
    out.high.push(b.h);
    out.low.push(b.l);
    out.close.push(b.c);
  }
  const T = out.close.length;
  for (let t = 0; t < T; t++) {
    out.fwdRet.push(t + 1 < T ? Math.log(out.close[t + 1] / out.close[t]) : NaN);
  }
  return out;
}

// ---------------------------------------------------------------- Heikin-Ashi
interface HA {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
}
// Causal HA: haClose[t] = (o+h+l+c)/4 of REAL bar t; haOpen[t] = (haOpen[t-1]+haClose[t-1])/2.
// Uses only info up to the close of day t. Seed haOpen[0] = (open[0]+close[0])/2.
function heikinAshi(o: number[], h: number[], l: number[], c: number[]): HA {
  const T = c.length;
  const ho = new Array(T).fill(NaN);
  const hc = new Array(T).fill(NaN);
  const hh = new Array(T).fill(NaN);
  const hl = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    hc[t] = (o[t] + h[t] + l[t] + c[t]) / 4;
    if (t === 0) ho[t] = (o[t] + c[t]) / 2;
    else ho[t] = (ho[t - 1] + hc[t - 1]) / 2;
    hh[t] = Math.max(h[t], ho[t], hc[t]);
    hl[t] = Math.min(l[t], ho[t], hc[t]);
  }
  return { open: ho, high: hh, low: hl, close: hc };
}

// ---------------------------------------------------------------- position rules
// Build long-flat position[t] in {0,1} from HA candles, computed at close of day t.
// Variants:
//   "green"     : long iff haClose[t] > haOpen[t]            (basic green candle)
//   "nowick"    : long iff green AND lower wick small (haLow[t] >= haOpen[t]*(1-wickTol))
//   "streak"    : long iff >= k consecutive green HA candles (incl t)
//   "ema"       : long iff haClose[t] > EMA(haClose, span)[t]  (HA + trend filter)
// Each variant has a parameter sweep. Honest N = sum of grid sizes across variants.
type Cfg = { variant: string; p: number };

function emaArr(x: number[], span: number): number[] {
  const a = 2 / (span + 1);
  const out = new Array(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) { out[i] = prev; continue; }
    prev = Number.isFinite(prev) ? a * v + (1 - a) * prev : v;
    out[i] = prev;
  }
  return out;
}

function positionsFromHA(ha: HA, cfg: Cfg): number[] {
  const T = ha.close.length;
  const pos = new Array(T).fill(0);
  if (cfg.variant === "green") {
    for (let t = 0; t < T; t++) pos[t] = ha.close[t] > ha.open[t] ? 1 : 0;
  } else if (cfg.variant === "nowick") {
    const tol = cfg.p; // fractional lower-wick tolerance, e.g. 0 = no lower wick at all
    for (let t = 0; t < T; t++) {
      const green = ha.close[t] > ha.open[t];
      const lowerWickOk = ha.low[t] >= ha.open[t] * (1 - tol);
      pos[t] = green && lowerWickOk ? 1 : 0;
    }
  } else if (cfg.variant === "streak") {
    const k = Math.round(cfg.p);
    let run = 0;
    for (let t = 0; t < T; t++) {
      run = ha.close[t] > ha.open[t] ? run + 1 : 0;
      pos[t] = run >= k ? 1 : 0;
    }
  } else if (cfg.variant === "ema") {
    const span = Math.round(cfg.p);
    const e = emaArr(ha.close, span);
    for (let t = 0; t < T; t++) pos[t] = Number.isFinite(e[t]) && ha.close[t] > e[t] && ha.close[t] > ha.open[t] ? 1 : 0;
  }
  return pos;
}

// ---------------------------------------------------------------- backtest core
interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number;
  nDays: number;
  longShare: number;
}
function runPositions(
  fwdRet: number[],
  position: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0, turnoverSum = 0, expSum = 0, longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = fwdRet[t];
    const pos = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev);
    const cost = turn * costPerSide;
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - cost);
    turnoverSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    prev = pos;
  }
  const n = dailyNet.length;
  return {
    dailyNet, dailyGross,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    nDays: n,
    longShare: n ? longCount / n : 0,
  };
}

// ---------------------------------------------------------------- surrogate
// VOL/SPECTRUM-PRESERVING surrogate-recompute null.
// Phase-randomize the daily log-return series of the REAL close: preserves variance and the full
// power spectrum (=> all linear autocorrelation), destroys nonlinear/asymmetric trend asymmetry.
// Rebuild a synthetic close path, derive synthetic O/H/L from the real bar's intraday geometry
// (so HA has real wick structure to chew on), RECOMPUTE HA, re-derive positions, and earn them on
// the SAME surrogate forward returns. This is the documented "recompute HA on each surrogate" null.
function phaseRandomize(x: number[], rng: () => number): number[] {
  // x: real-valued series (daily log returns). FFT -> randomize phases -> IFFT (real part).
  const n = x.length;
  const re = x.slice();
  const im = new Array(n).fill(0);
  fft(re, im, false);
  // randomize phases while preserving magnitudes; keep DC real, enforce conjugate symmetry
  for (let k = 1; k < Math.floor(n / 2) + 1; k++) {
    const mag = Math.hypot(re[k], im[k]);
    const ph = 2 * Math.PI * rng();
    const nr = mag * Math.cos(ph);
    const ni = mag * Math.sin(ph);
    re[k] = nr; im[k] = ni;
    const j = (n - k) % n;
    re[j] = nr; im[j] = -ni; // conjugate symmetry => real output
  }
  fft(re, im, true);
  return re.slice(0, n);
}

// iterative radix-2 FFT with Bluestein fallback for non-powers-of-2
function fft(re: number[], im: number[], inverse: boolean): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) === 0) {
    fftRadix2(re, im, inverse);
  } else {
    fftBluestein(re, im, inverse);
  }
}
function fftRadix2(re: number[], im: number[], inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function fftBluestein(re: number[], im: number[], inverse: boolean): void {
  const n = re.length;
  let m = 1; while (m < 2 * n + 1) m <<= 1;
  const cosT = new Array(n), sinT = new Array(n);
  const ar = new Array(m).fill(0), ai = new Array(m).fill(0);
  const br = new Array(m).fill(0), bi = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    const j = (i * i) % (2 * n);
    const ang = (inverse ? Math.PI : -Math.PI) * j / n;
    cosT[i] = Math.cos(ang); sinT[i] = Math.sin(ang);
    ar[i] = re[i] * cosT[i] - im[i] * sinT[i];
    ai[i] = re[i] * sinT[i] + im[i] * cosT[i];
  }
  br[0] = cosT[0]; bi[0] = sinT[0];
  for (let i = 1; i < n; i++) { br[i] = br[m - i] = cosT[i]; bi[i] = bi[m - i] = sinT[i]; }
  fftRadix2(ar, ai, false); fftRadix2(br, bi, false);
  for (let i = 0; i < m; i++) {
    const tr = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = tr;
  }
  fftRadix2(ar, ai, true);
  for (let i = 0; i < n; i++) {
    re[i] = ar[i] * cosT[i] - ai[i] * sinT[i];
    im[i] = ar[i] * sinT[i] + ai[i] * cosT[i];
  }
}

// Build a surrogate OHLC + fwdRet by phase-randomizing daily log returns, preserving the real
// intraday geometry (relative O/H/L offsets vs close) so HA sees real wick structure.
function buildSurrogateOHLC(real: OHLC, rng: () => number): OHLC {
  const T = real.close.length;
  // real daily close-to-close log returns (length T-1 valid)
  const lr: number[] = [];
  for (let t = 1; t < T; t++) lr.push(Math.log(real.close[t] / real.close[t - 1]));
  const surrLr = phaseRandomize(lr, rng);
  // rebuild close path from the same start price
  const close = new Array(T);
  close[0] = real.close[0];
  for (let t = 1; t < T; t++) close[t] = close[t - 1] * Math.exp(surrLr[t - 1]);
  // preserve each real bar's intraday geometry: scale (open,high,low) by the surrogate/real close ratio
  const open = new Array(T), high = new Array(T), low = new Array(T);
  for (let t = 0; t < T; t++) {
    const k = close[t] / real.close[t];
    open[t] = real.open[t] * k;
    high[t] = real.high[t] * k;
    low[t] = real.low[t] * k;
  }
  const fwdRet = new Array(T);
  for (let t = 0; t < T; t++) fwdRet[t] = t + 1 < T ? Math.log(close[t + 1] / close[t]) : NaN;
  return { dates: real.dates, open, high, low, close, fwdRet };
}

// ---------------------------------------------------------------- gauntlet
function normalCdfLocal(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
function toFolds(series: number[], nfolds: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / nfolds);
  for (let f = 0; f < nfolds; f++) {
    const lo = f * sz;
    const hi = f === nfolds - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}

function main() {
  const real = loadDailyOHLC();
  const T = real.close.length;
  const startIdx = 30; // warmup for EMA/streak
  const tradableEnd = T - 1;
  const holdoutFrac = 0.2;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));
  const nSurr = 300;

  // ---- config grid (HONEST N = every config) ----
  const configs: Cfg[] = [];
  configs.push({ variant: "green", p: 0 });
  for (const tol of [0, 0.001, 0.002, 0.005]) configs.push({ variant: "nowick", p: tol });
  for (const k of [1, 2, 3, 4]) configs.push({ variant: "streak", p: k });
  for (const span of [5, 10, 20, 30, 50]) configs.push({ variant: "ema", p: span });
  const HONEST_N = configs.length;
  const canonical: Cfg = { variant: "green", p: 0 }; // pre-registered: basic green-candle long-flat

  const realHA = heikinAshi(real.open, real.high, real.low, real.close);

  // score every config IN-SAMPLE on net Sharpe
  const scored = configs.map((cfg) => {
    const pos = positionsFromHA(realHA, cfg);
    const res = runPositions(real.fwdRet, pos, startIdx, splitIdx);
    return { cfg, label: `${cfg.variant}:${cfg.p}`, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // ---- baselines: own buy&hold, random-lottery ----
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(real.fwdRet, bhPos, startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
    const r = runPositions(real.fwdRet, pos, startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  // KEY GATE per BACKLOG: must out-Sharpe its OWN buy&hold (after the DSR deflation below too)
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // ---- DSR @ honest N ----
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;
  // DSR-vs-own-B&H: deflate the EXCESS return over buy&hold, @ honest N (the strategy must have a
  // deflated-significant Sharpe on its return STREAM RELATIVE to just being long).
  const excess = bestNet.map((r, i) => r - (bh.dailyNet[i] ?? 0));
  const dsrExcess = computeDeflatedSharpeRatio(excess, { trialCount: HONEST_N });
  const dsrExcessPass = dsrExcess.deflatedProbability > 0.95 && mean(excess) > 0;

  // ---- block bootstrap CI ----
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "o5heikin-bb",
  });
  const bbPass = bb.lower > 0;

  // ---- CSCV/PBO ----
  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try {
    const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch { pbo = { pbo: 1, medianLogit: 0 }; }
  const pboPass = pbo.pbo < 0.5;

  // ---- Harvey-Liu Bonferroni haircut ----
  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---- RIGHT surrogate: vol/spectrum-preserving + RECOMPUTE HA on each surrogate ----
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const sur = buildSurrogateOHLC(real, rng);
    const surHA = heikinAshi(sur.open, sur.high, sur.low, sur.close);
    const pos = positionsFromHA(surHA, best.cfg);
    const r = runPositions(sur.fwdRet, pos, startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;
  const surr95 = surr[Math.floor(nSurr * 0.95)];
  const surrMean = mean(surr);

  // ---- consume-once forward holdout ----
  const holdRes = runPositions(real.fwdRet, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  // holdout B&H for context
  const holdBh = runPositions(real.fwdRet, bhPos, splitIdx, tradableEnd);
  const holdBhSh = annSharpe(sharpeDaily(holdBh.dailyNet));
  const holdoutPass = holdSh > 0 && holdSh > holdBhSh; // OOS must also beat OOS buy&hold

  // ---- canonical (N=1) ----
  const canonPos = positionsFromHA(realHA, canonical);
  const canonRes = runPositions(real.fwdRet, canonPos, startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    const sur = buildSurrogateOHLC(real, rng);
    const surHA = heikinAshi(sur.open, sur.high, sur.low, sur.close);
    const pos = positionsFromHA(surHA, canonical);
    const r = runPositions(sur.fwdRet, pos, startIdx, splitIdx);
    canonSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);

  // ---- gates in binding order ----
  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: { pass: mean(bestNet) > 0, detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)}` },
    baselines: { pass: baselinePass, detail: `bestNetSh=${best.netSh.toFixed(3)} vs OWN_B&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}` },
    deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}` },
    dsr_vs_bh: { pass: dsrExcessPass, detail: `DSR(excess vs B&H) p=${dsrExcess.deflatedProbability.toFixed(4)} meanExcessDaily=${mean(excess).toExponential(3)}` },
    block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})` },
    surrogate: { pass: surrPass, detail: `volPreservingSurrogateP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${surrMean.toFixed(3)} surr95=${surr95.toFixed(3)}` },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} vs OOS_B&H=${holdBhSh.toFixed(3)} over ${holdRes.nDays} rows` },
  };
  const order = ["net_of_cost", "baselines", "deflated_sharpe", "dsr_vs_bh", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
  let binding = "none";
  for (const g of order) if (!gates[g].pass) { binding = g; break; }
  const allPass = binding === "none";
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (allPass) verdict = "SURVIVE";
  else if (survivesCore) verdict = "PROMISING";
  else verdict = "KILL";

  const meanDailyNet = mean(bestNet);
  const monthlyAt100k = meanDailyNet * 30 * 100000;

  // ---- report ----
  console.log(`\n================ O5-HEIKIN ================`);
  console.log(`dataset: TRUE daily OHLC from 15m Binance, ${real.dates[startIdx]}..${real.dates[tradableEnd - 1]}  T=${T} startIdx=${startIdx} splitIdx=${splitIdx} (IS=${splitIdx - startIdx}d, OOS=${tradableEnd - splitIdx}d)`);
  console.log(`honestN=${HONEST_N}  best=${best.label}`);
  console.log(`best netSharpeAnn=${best.netSh.toFixed(3)} grossSharpeAnn=${annSharpe(sharpeDaily(best.res.dailyGross)).toFixed(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)} longShare=${best.res.longShare.toFixed(2)} nDays=${best.res.nDays}`);
  console.log(`OWN buy&hold IS netSharpeAnn=${bhSh.toFixed(3)}`);
  for (const g of order) console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
  console.log(`canonical(green): netSharpeAnn=${canonSh.toFixed(3)} surrP=${canonSurrP.toFixed(4)}`);
  const monthly = binding === "none" ? `$${Math.round(monthlyAt100k)}` : "n/a";
  const out = {
    name: "O5-HEIKIN", honestN: HONEST_N, best: { ...best.cfg, label: best.label, netSharpeAnn: best.netSh, grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)), turnover: best.res.turnover, exposure: best.res.exposure, longShare: best.res.longShare, nDays: best.res.nDays, monthlyAt100k },
    ownBuyHoldSharpe: bhSh, gates, bindingGate: binding, verdict, surrogateP: surrP, holdoutSharpeAnn: holdSh, holdoutBhSharpe: holdBhSh,
    canonical: { netSharpeAnn: canonSh, surrogateP: canonSurrP },
  };
  fs.writeFileSync(`${ROOT}/output/edgehunt-onchain2/result_o5_heikin.json`, JSON.stringify(out, null, 2));
  console.log(`VERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly} | confidence`);
}

main();
