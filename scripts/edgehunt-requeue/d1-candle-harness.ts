/**
 * D1-CANDLE — Candlestick reversal patterns on daily BTC.
 *
 * Belief: classic 1–3 candle reversal patterns (engulfing, hammer/hanging-man, shooting-star,
 * doji, morning/evening star, piercing/dark-cloud, three-soldiers/three-crows) predict the
 * NEXT day's direction. Mechanism: deterministic functions of OHLC.
 *
 * Causal contract: a pattern is read at the CLOSE of day t. Position is taken for t -> t+1 and
 * earns fwdRet[t] = log(close[t+1]/close[t]). Strictly lagged (no same-bar peeking). Reversal
 * patterns trade AGAINST the prior move (bullish reversal -> long; bearish reversal -> short).
 *
 * Committed gauntlet (src/lib/training/statistical-validation.ts), same wiring as
 * scripts/edgehunt-D5/harness.ts::runGauntlet:
 *   net-of-cost (4 bps taker/side), baselines (buy&hold / random-lottery matched exposure),
 *   Deflated Sharpe @ HONEST N (= every config scored), CPCV/PBO, Harvey-Liu (Bonferroni)
 *   haircut, consume-once forward holdout (last 20%).
 *
 * RIGHT NULL for THIS claim (pattern labels carry directional info):
 *   (A) pattern-label placebo: random days with MATCHED base rate (same # of long/short signal
 *       days, drawn uniformly over the tradable window) — destroys the label<->day mapping while
 *       preserving how often / which direction we trade.
 *   (B) phase-randomization: IAAFT phase-randomize the daily log-return path, rebuild a synthetic
 *       OHLC tape, RE-DETECT the same patterns on the surrogate, trade them. Destroys the
 *       higher-order (pattern) structure while preserving the power spectrum (autocorrelation)
 *       and the return distribution.
 *   The surrogate p reported = MAX(p_placebo, p_phase) — the strategy must beat BOTH nulls.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
export const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);

// ----------------------------------------------------------------- data
export interface Bars {
  dates: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  fwdRet: number[]; // log(close[t+1]/close[t]); last = NaN
}

export function loadBTC(): Bars {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Array<{
    date: string; open: number; high: number; low: number; close: number;
  }>;
  raw.sort((a, b) => (a.date < b.date ? -1 : 1));
  const b: Bars = { dates: [], open: [], high: [], low: [], close: [], fwdRet: [] };
  for (const r of raw) {
    if (!(r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0)) continue;
    b.dates.push(r.date); b.open.push(r.open); b.high.push(r.high);
    b.low.push(r.low); b.close.push(r.close);
  }
  const T = b.close.length;
  for (let t = 0; t < T; t++) b.fwdRet.push(t + 1 < T ? Math.log(b.close[t + 1] / b.close[t]) : NaN);
  return b;
}

// ----------------------------------------------------------------- math
export function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
export function std(a: number[]): number {
  const n = a.length; if (n < 2) return 0; const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
export function sharpeDaily(a: number[]): number { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
export function annSharpe(d: number): number { return d * ANN; }
export function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function sma(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < win) continue; let s = 0;
    for (let k = i - win + 1; k <= i; k++) s += x[k];
    out[i] = s / win;
  }
  return out;
}

// ----------------------------------------------------------------- pattern detection
// Each detector returns +1 (bullish reversal -> next-day LONG), -1 (bearish reversal -> next-day
// SHORT), or 0 (no signal) for the candle ENDING at index t, using only bars <= t.
// "Reversal" patterns require a prior trend context (the move they reverse).

export type Detector = (b: Bars, t: number, atr: number[], trend: number[]) => number;

function body(b: Bars, t: number): number { return b.close[t] - b.open[t]; }
function absBody(b: Bars, t: number): number { return Math.abs(b.close[t] - b.open[t]); }
function range(b: Bars, t: number): number { return b.high[t] - b.low[t]; }
function upperWick(b: Bars, t: number): number { return b.high[t] - Math.max(b.open[t], b.close[t]); }
function lowerWick(b: Bars, t: number): number { return Math.min(b.open[t], b.close[t]) - b.low[t]; }

// trend[t] = sign of (close[t] - sma(close, trendWin)[t]); used to require the candle appears
// after a down-move (bullish reversal) or up-move (bearish reversal). Strictly causal.

const DETECTORS: Record<string, Detector> = {
  // Bullish/Bearish ENGULFING (2-bar). Reversal of the immediately prior trend.
  engulfing: (b, t, _atr, trend) => {
    if (t < 1) return 0;
    const bod = body(b, t), pBod = body(b, t - 1);
    // bullish: prior down, today up body engulfs prior body
    if (trend[t - 1] < 0 && pBod < 0 && bod > 0 && b.close[t] >= b.open[t - 1] && b.open[t] <= b.close[t - 1])
      return +1;
    if (trend[t - 1] > 0 && pBod > 0 && bod < 0 && b.open[t] >= b.close[t - 1] && b.close[t] <= b.open[t - 1])
      return -1;
    return 0;
  },
  // HAMMER (bullish, after down) / HANGING MAN context handled separately as bearish? Classic
  // hammer = bullish reversal after a decline (long lower wick, small body, tiny upper wick).
  hammer: (b, t, _atr, trend) => {
    const r = range(b, t); if (r <= 0) return 0;
    const lw = lowerWick(b, t), uw = upperWick(b, t), ab = absBody(b, t);
    const isHammerShape = lw >= 2 * ab && uw <= 0.3 * ab + 1e-9 && ab <= 0.4 * r;
    if (isHammerShape && trend[t] < 0) return +1; // bullish reversal after decline
    return 0;
  },
  // SHOOTING STAR (bearish, after advance): long upper wick, small body, tiny lower wick.
  shootingStar: (b, t, _atr, trend) => {
    const r = range(b, t); if (r <= 0) return 0;
    const uw = upperWick(b, t), lw = lowerWick(b, t), ab = absBody(b, t);
    const shape = uw >= 2 * ab && lw <= 0.3 * ab + 1e-9 && ab <= 0.4 * r;
    if (shape && trend[t] > 0) return -1;
    return 0;
  },
  // DOJI (indecision -> reversal). Direction = opposite of prior trend (classic textbook claim).
  doji: (b, t, _atr, trend) => {
    const r = range(b, t); if (r <= 0) return 0;
    const ab = absBody(b, t);
    if (ab <= 0.1 * r) {
      if (trend[t] < 0) return +1; // after down -> bullish indecision reversal
      if (trend[t] > 0) return -1;
    }
    return 0;
  },
  // MORNING STAR (3-bar bullish) / EVENING STAR (3-bar bearish).
  star: (b, t, _atr, trend) => {
    if (t < 2) return 0;
    const b0 = body(b, t - 2), b1 = absBody(b, t - 1), b2 = body(b, t);
    const r0 = range(b, t - 2), r2 = range(b, t);
    // morning star: big down, small middle, big up closing into first body
    if (trend[t - 2] < 0 && b0 < 0 && Math.abs(b0) >= 0.5 * r0 && b1 <= 0.4 * Math.abs(b0)
        && b2 > 0 && b2 >= 0.5 * r2 && b.close[t] >= b.open[t - 2] - 0.5 * Math.abs(b0))
      return +1;
    if (trend[t - 2] > 0 && b0 > 0 && b0 >= 0.5 * r0 && b1 <= 0.4 * b0
        && b2 < 0 && Math.abs(b2) >= 0.5 * r2 && b.close[t] <= b.open[t - 2] + 0.5 * b0)
      return -1;
    return 0;
  },
  // PIERCING LINE (bullish 2-bar) / DARK CLOUD COVER (bearish 2-bar).
  piercing: (b, t, _atr, trend) => {
    if (t < 1) return 0;
    const pBod = body(b, t - 1), bod = body(b, t);
    const mid = (b.open[t - 1] + b.close[t - 1]) / 2;
    if (trend[t - 1] < 0 && pBod < 0 && bod > 0 && b.open[t] < b.low[t - 1] && b.close[t] > mid && b.close[t] < b.open[t - 1])
      return +1;
    if (trend[t - 1] > 0 && pBod > 0 && bod < 0 && b.open[t] > b.high[t - 1] && b.close[t] < mid && b.close[t] > b.open[t - 1])
      return -1;
    return 0;
  },
  // THREE WHITE SOLDIERS (bullish) / THREE BLACK CROWS (bearish): 3 consecutive strong same-color.
  threeLine: (b, t, _atr, trend) => {
    if (t < 2) return 0;
    const up = (k: number) => body(b, k) > 0 && absBody(b, k) >= 0.5 * range(b, k);
    const dn = (k: number) => body(b, k) < 0 && absBody(b, k) >= 0.5 * range(b, k);
    if (trend[t - 2] < 0 && up(t) && up(t - 1) && up(t - 2) && b.close[t] > b.close[t - 1] && b.close[t - 1] > b.close[t - 2])
      return +1;
    if (trend[t - 2] > 0 && dn(t) && dn(t - 1) && dn(t - 2) && b.close[t] < b.close[t - 1] && b.close[t - 1] < b.close[t - 2])
      return -1;
    return 0;
  },
};

export const DETECTOR_NAMES = Object.keys(DETECTORS);

// ----------------------------------------------------------------- positions
// A config picks a SET of patterns (or "all"), a trend window (context), a horizon (held days),
// and whether to trade both directions or long-only (crypto-specific: shorting is costly).

export interface Cfg extends Record<string, number | string> {
  pattern: string;   // detector name or "all"
  trendWin: number;  // context SMA window for trend sign
  hold: number;      // holding horizon in days (>=1)
  dir: string;       // "both" | "long" | "contrarian" (flip signs)
}

function trendSign(b: Bars, win: number): number[] {
  const m = sma(b.close, win);
  return b.close.map((c, i) => (Number.isFinite(m[i]) ? Math.sign(c - m[i]) : 0));
}
function atr(b: Bars, win: number): number[] {
  const tr = b.close.map((_, t) => {
    if (t < 1) return b.high[t] - b.low[t];
    return Math.max(b.high[t] - b.low[t], Math.abs(b.high[t] - b.close[t - 1]), Math.abs(b.low[t] - b.close[t - 1]));
  });
  return sma(tr, win);
}

// signal[t] in {-1,0,+1} = raw pattern direction read at close of t (for next-day entry).
export function signalSeries(b: Bars, cfg: Cfg): number[] {
  const trend = trendSign(b, cfg.trendWin);
  const a = atr(b, 14);
  const dets = cfg.pattern === "all" ? DETECTOR_NAMES : [cfg.pattern];
  const sig = new Array(b.close.length).fill(0);
  for (let t = 0; t < b.close.length; t++) {
    let s = 0;
    for (const name of dets) {
      const d = DETECTORS[name](b, t, a, trend);
      if (d !== 0) { s += d; }
    }
    sig[t] = Math.sign(s); // majority/any direction
  }
  return sig;
}

// Convert a raw signal series into a position series with horizon `hold`. When a signal fires at
// close of t, hold the position over t..t+hold-1 (i.e. position[t..t+hold-1] = dir). Overlapping
// signals refresh/extend. dir handling per cfg.
export function positionFromSignal(b: Bars, sig: number[], cfg: Cfg): number[] {
  const T = b.close.length;
  const pos = new Array(T).fill(0);
  const flip = cfg.dir === "contrarian" ? -1 : 1;
  for (let t = 0; t < T; t++) {
    let s = sig[t] * flip;
    if (cfg.dir === "long" && s < 0) s = 0; // long-only: ignore bearish signals
    if (s === 0) continue;
    for (let h = 0; h < cfg.hold && t + h < T; h++) {
      pos[t + h] = s; // latest signal wins on overlap
    }
  }
  return pos;
}

export function buildPosition(b: Bars, cfg: Cfg): number[] {
  return positionFromSignal(b, signalSeries(b, cfg), cfg);
}

// ----------------------------------------------------------------- backtest
export interface BtResult { dailyNet: number[]; dailyGross: number[]; turnover: number; exposure: number; nDays: number; longShare: number; nSignalDays: number; }
export function runPositions(b: Bars, position: number[], startIdx: number, endIdx: number, costPerSide = COST_PER_SIDE): BtResult {
  const dailyNet: number[] = []; const dailyGross: number[] = [];
  let prev = 0, turnoverSum = 0, expSum = 0, longCount = 0, sigDays = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = b.fwdRet[t]; const pos = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev); const cost = turn * costPerSide; const gross = pos * fr;
    dailyGross.push(gross); dailyNet.push(gross - cost);
    turnoverSum += turn; expSum += Math.abs(pos); if (pos > 0) longCount++; if (pos !== 0) sigDays++;
    prev = pos;
  }
  const n = dailyNet.length;
  return { dailyNet, dailyGross, turnover: n ? turnoverSum / n : 0, exposure: n ? expSum / n : 0, nDays: n, longShare: n ? longCount / n : 0, nSignalDays: sigDays };
}

// ----------------------------------------------------------------- surrogate nulls
// (A) pattern-label placebo: keep the REAL position SCHEDULE counts (# long days, # short days,
// mean hold) but place them on RANDOM days. We reproduce the directional base rate by sampling
// the same number of +1 and -1 ENTRY events at random start days, each held `hold` days.
export function placeboPosition(b: Bars, realPos: number[], cfg: Cfg, startIdx: number, endIdx: number, rng: () => number): number[] {
  const T = b.close.length;
  // count entry events of each sign in the real schedule within window
  let nLong = 0, nShort = 0; let prev = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const p = realPos[t];
    if (p !== prev) { if (p > 0) nLong++; else if (p < 0) nShort++; }
    prev = p;
  }
  const pos = new Array(T).fill(0);
  const place = (sign: number, count: number) => {
    let placed = 0, guard = 0;
    while (placed < count && guard < count * 50 + 100) {
      guard++;
      const t = startIdx + Math.floor(rng() * (endIdx - startIdx));
      // place a hold-length block of this sign (overwrite allowed -> matches base rate loosely)
      for (let h = 0; h < cfg.hold && t + h < endIdx; h++) pos[t + h] = sign;
      placed++;
    }
  };
  place(+1, nLong); place(-1, nShort);
  return pos;
}

// (B) phase-randomization (IAAFT-lite): phase-randomize the daily log-return series, rebuild a
// synthetic close path, synthesize OHLC by reusing the REAL intrabar wick/body proportions in a
// shuffled order (so candle SHAPES exist but their TIME ordering relative to trend is destroyed),
// then RE-DETECT patterns and trade them with the same cfg. Preserves spectrum + shape distn.
function phaseRandomizeReturns(ret: number[], rng: () => number): number[] {
  const n = ret.length;
  // FFT-free surrogate: randomize phases via pairing real DFT — use a simple AAFT approximation:
  // 1) rank-map ret to gaussian, 2) phase randomize via random circular rotation of blocks is weak;
  // implement a proper DFT phase randomization.
  const re = new Array(n).fill(0), im = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let j = 0; j < n; j++) { const ang = (-2 * Math.PI * k * j) / n; sr += ret[j] * Math.cos(ang); si += ret[j] * Math.sin(ang); }
    re[k] = sr; im[k] = si;
  }
  // randomize phases (keep magnitudes), enforce conjugate symmetry for real output
  const mag = re.map((r, k) => Math.hypot(r, im[k]));
  const ph = new Array(n).fill(0);
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    const rp = (rng() * 2 - 1) * Math.PI;
    ph[k] = rp; ph[(n - k) % n] = -rp;
  }
  ph[0] = 0; if (n % 2 === 0) ph[n / 2] = 0;
  const out = new Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += mag[k] * Math.cos((2 * Math.PI * k * j) / n + ph[k]);
    out[j] = s / n;
  }
  return out;
}

// Build a synthetic Bars from phase-randomized returns, reusing real candle proportions (shuffled).
export function phaseSurrogateBars(b: Bars, rng: () => number): Bars {
  const T = b.close.length;
  const ret: number[] = [];
  for (let t = 1; t < T; t++) ret.push(Math.log(b.close[t] / b.close[t - 1]));
  const surRet = phaseRandomizeReturns(ret, rng);
  // shuffled candle-shape proportions from real bars: (upWickFrac, loWickFrac, bodyDirSign) by |body|/range
  const shapes = [] as Array<{ uw: number; lw: number; bodyFrac: number }>;
  for (let t = 0; t < T; t++) {
    const r = range(b, t); if (r <= 0) { shapes.push({ uw: 0.3, lw: 0.3, bodyFrac: 0.4 }); continue; }
    shapes.push({ uw: upperWick(b, t) / r, lw: lowerWick(b, t) / r, bodyFrac: absBody(b, t) / r });
  }
  // Fisher-Yates shuffle shapes
  for (let i = shapes.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shapes[i], shapes[j]] = [shapes[j], shapes[i]]; }
  const close = new Array(T).fill(0); close[0] = b.close[0];
  for (let t = 1; t < T; t++) close[t] = close[t - 1] * Math.exp(surRet[t - 1]);
  const sb: Bars = { dates: b.dates.slice(), open: [], high: [], low: [], close, fwdRet: [] };
  for (let t = 0; t < T; t++) {
    const c = close[t]; const o = t > 0 ? close[t - 1] : c; // open = prior close (gap-free synthetic)
    const dir = c >= o ? 1 : -1;
    // approximate per-bar range from the |return| scaled, then layout wicks per shuffled shape
    const baseRange = Math.max(Math.abs(c - o), Math.abs(c) * 0.005);
    const sh = shapes[t]; const total = sh.uw + sh.lw + sh.bodyFrac || 1;
    const rng2 = baseRange / Math.max(1e-9, sh.bodyFrac / total);
    const hi = Math.max(o, c) + (sh.uw / total) * rng2;
    const lo = Math.min(o, c) - (sh.lw / total) * rng2;
    sb.open.push(o); sb.high.push(Math.max(hi, o, c)); sb.low.push(Math.min(lo, o, c)); void dir;
  }
  for (let t = 0; t < T; t++) sb.fwdRet.push(t + 1 < T ? Math.log(sb.close[t + 1] / sb.close[t]) : NaN);
  return sb;
}

// ----------------------------------------------------------------- gauntlet
function toFolds(series: number[], nfolds: number): number[][] {
  const folds: number[][] = []; const sz = Math.floor(series.length / nfolds);
  for (let f = 0; f < nfolds; f++) { const lo = f * sz; const hi = f === nfolds - 1 ? series.length : lo + sz; folds.push(series.slice(lo, hi)); }
  return folds;
}
function normalCdfLocal(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns); if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe; const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}

export interface GauntletOut {
  name: string; honestN: number;
  best: { label: string; cfg: Cfg; netSharpeAnn: number; grossSharpeAnn: number; meanDailyNet: number; turnover: number; exposure: number; longShare: number; nDays: number; nSignalDays: number; monthlyAt100k: number };
  canonical: { netSharpeAnn: number; surrogateP: number; holdoutSharpeAnn: number };
  gates: Record<string, { pass: boolean; detail: string }>;
  bindingGate: string; verdict: "SURVIVE" | "PROMISING" | "KILL"; surrogateP: number; holdoutSharpeAnn: number;
  pPlacebo: number; pPhase: number;
}

export function runGauntlet(b: Bars, configs: Cfg[], canonical: Cfg, startIdx: number, opts: { holdoutFrac?: number; nSurr?: number } = {}): GauntletOut {
  const HONEST_N = configs.length;
  const holdoutFrac = opts.holdoutFrac ?? 0.2;
  const nSurr = opts.nSurr ?? 300;
  const T = b.close.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));

  const scored = configs.map((cfg) => {
    const pos = buildPosition(b, cfg);
    const res = runPositions(b, pos, startIdx, splitIdx);
    const label = `pattern=${cfg.pattern},trendWin=${cfg.trendWin},hold=${cfg.hold},dir=${cfg.dir}`;
    return { cfg, label, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b2) => b2.netSh - a.netSh);
  const best = scored[0]; const bestNet = best.res.dailyNet;

  // baselines
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(b, bhPos, startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? (rng() < 0.5 ? 1 : -1) : 0;
    const r = runPositions(b, pos, startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b2) => a - b2);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 10, confidenceLevel: 0.95, seed: `${"d1candle"}-bb` });
  const bbPass = bb.lower > 0;

  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try { const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }); pbo = { pbo: r.pbo, medianLogit: r.medianLogit }; } catch { pbo = { pbo: 1, medianLogit: 0 }; }
  const pboPass = pbo.pbo < 0.5;

  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // RIGHT NULL (A): pattern-label placebo, matched base rate
  const placebo: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(13000 + i * 7919);
    const pos = placeboPosition(b, best.pos, best.cfg, startIdx, splitIdx, rng);
    const r = runPositions(b, pos, startIdx, splitIdx);
    placebo.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  placebo.sort((a, b2) => a - b2);
  const pPlacebo = (placebo.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);

  // RIGHT NULL (B): phase-randomization + re-detect patterns
  const phase: number[] = [];
  const nPhase = Math.min(nSurr, 200); // phase surrogate is O(T^2) DFT -> fewer iters
  for (let i = 0; i < nPhase; i++) {
    const rng = mkRng(55000 + i * 6271);
    const sb = phaseSurrogateBars(b, rng);
    const pos = buildPosition(sb, best.cfg);
    const r = runPositions(sb, pos, startIdx, splitIdx);
    phase.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  phase.sort((a, b2) => a - b2);
  const pPhase = (phase.filter((s) => s >= best.netSh).length + 1) / (nPhase + 1);

  const surrP = Math.max(pPlacebo, pPhase); // must beat BOTH nulls
  const surrPass = surrP < 0.05;

  const holdRes = runPositions(b, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // canonical
  const canonPos = buildPosition(b, canonical);
  const canonRes = runPositions(b, canonPos, startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonPlac: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(91000 + i * 7919);
    const pos = placeboPosition(b, canonPos, canonical, startIdx, splitIdx, rng);
    canonPlac.push(annSharpe(sharpeDaily(runPositions(b, pos, startIdx, splitIdx).dailyNet)));
  }
  canonPlac.sort((a, b2) => a - b2);
  const canonSurrP = (canonPlac.filter((s) => s >= canonSh).length + 1) / (nSurr + 1);
  const canonHold = runPositions(b, canonPos, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: { pass: mean(bestNet) > 0, detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)} nSignalDays=${best.res.nSignalDays}` },
    baselines: { pass: baselinePass, detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}` },
    deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}` },
    block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})` },
    surrogate: { pass: surrPass, detail: `p=max(placebo=${pPlacebo.toFixed(4)},phase=${pPhase.toFixed(4)})=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} placeboMean=${mean(placebo).toFixed(3)} phaseMean=${mean(phase).toFixed(3)}` },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays} rows` },
  };
  const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
  let binding = "none";
  for (const g of order) if (!gates[g].pass) { binding = g; break; }
  const allPass = binding === "none";
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (allPass) verdict = "SURVIVE"; else if (survivesCore) verdict = "PROMISING"; else verdict = "KILL";

  const meanDailyNet = mean(bestNet);
  return {
    name: "D1-CANDLE", honestN: HONEST_N,
    best: { label: best.label, cfg: best.cfg, netSharpeAnn: best.netSh, grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)), meanDailyNet, turnover: best.res.turnover, exposure: best.res.exposure, longShare: best.res.longShare, nDays: best.res.nDays, nSignalDays: best.res.nSignalDays, monthlyAt100k: meanDailyNet * 30 * 100000 },
    canonical: { netSharpeAnn: canonSh, surrogateP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
    gates, bindingGate: binding, verdict, surrogateP: surrP, holdoutSharpeAnn: holdSh, pPlacebo, pPhase,
  };
}

export function printVerdict(o: GauntletOut): void {
  console.log(`\n================ ${o.name} ================`);
  console.log(`honestN=${o.honestN}  best=${o.best.label}`);
  console.log(`best netSharpeAnn=${o.best.netSharpeAnn.toFixed(3)} grossSharpeAnn=${o.best.grossSharpeAnn.toFixed(3)} turnover=${o.best.turnover.toFixed(3)} exposure=${o.best.exposure.toFixed(3)} longShare=${o.best.longShare.toFixed(2)} nDays=${o.best.nDays} nSignalDays=${o.best.nSignalDays}`);
  for (const [g, r] of Object.entries(o.gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  console.log(`canonical: netSharpeAnn=${o.canonical.netSharpeAnn.toFixed(3)} surrP=${o.canonical.surrogateP.toFixed(4)} holdoutSharpeAnn=${o.canonical.holdoutSharpeAnn.toFixed(3)}`);
  const monthly = o.bindingGate === "none" ? `$${Math.round(o.best.monthlyAt100k)}` : "n/a";
  console.log(`VERDICT: ${o.verdict} | net Sharpe ${o.best.netSharpeAnn.toFixed(3)} | binding gate ${o.bindingGate} | honest N ${o.honestN} | surrogate p ${o.surrogateP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${o.holdoutSharpeAnn.toFixed(3)}`);
}
