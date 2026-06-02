/**
 * Q8-EFFRATIO library: TSMOM + Kaufman Efficiency-Ratio / ADX trend-strength meta-gate.
 *
 * Data: daily BTC bars aggregated from the committed 15m ndjson (output/edgehunt-quant/btc_daily.json).
 * Causality: position[t] is computed STRICTLY from info available at the close of day t (lookback
 * windows end at t). It earns fwdRet[t] = log(close[t+1]/close[t]). Last day has no fwdRet.
 *
 * Cost: 4 bps taker per side (COST_PER_SIDE), applied on |pos[t]-pos[t-1]| turnover.
 */
import fs from "node:fs";

export const ROOT = ".";
export const COST_PER_SIDE = 0.0004;
export const ANN = Math.sqrt(365);

export interface Daily {
  date: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  fwdRet: number[]; // log close[t]->close[t+1]; last = NaN
  logRet: number[]; // log close[t-1]->close[t]; first = NaN (realized daily return)
}

export function loadDaily(): Daily {
  const raw = JSON.parse(
    fs.readFileSync(`${ROOT}/output/edgehunt-quant/btc_daily.json`, "utf8"),
  ) as { date: string; open: number; high: number; low: number; close: number; volume: number }[];
  const D: Daily = {
    date: raw.map((b) => b.date),
    open: raw.map((b) => b.open),
    high: raw.map((b) => b.high),
    low: raw.map((b) => b.low),
    close: raw.map((b) => b.close),
    volume: raw.map((b) => b.volume),
    fwdRet: [],
    logRet: [],
  };
  const T = D.close.length;
  for (let t = 0; t < T; t++) {
    D.fwdRet.push(t + 1 < T ? Math.log(D.close[t + 1] / D.close[t]) : NaN);
    D.logRet.push(t > 0 ? Math.log(D.close[t] / D.close[t - 1]) : NaN);
  }
  return D;
}

// ---------------------------------------------------------------- math
export function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
export function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
export function sharpeDaily(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
export function annSharpe(dailySharpe: number): number {
  return dailySharpe * ANN;
}
export function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- indicators (strictly causal)

/** Kaufman Efficiency Ratio over window w, ending at t (uses close[t-w..t]). */
export function efficiencyRatio(close: number[], w: number): number[] {
  const T = close.length;
  const out = new Array(T).fill(NaN);
  for (let t = w; t < T; t++) {
    const change = Math.abs(close[t] - close[t - w]);
    let vol = 0;
    for (let k = t - w + 1; k <= t; k++) vol += Math.abs(close[k] - close[k - 1]);
    out[t] = vol > 1e-12 ? change / vol : 0;
  }
  return out;
}

/** Wilder ADX over window w, ending at t. Uses high/low/close up to t (causal). */
export function adx(high: number[], low: number[], close: number[], w: number): number[] {
  const T = close.length;
  const tr = new Array(T).fill(NaN);
  const plusDM = new Array(T).fill(NaN);
  const minusDM = new Array(T).fill(NaN);
  for (let t = 1; t < T; t++) {
    const up = high[t] - high[t - 1];
    const dn = low[t - 1] - low[t];
    plusDM[t] = up > dn && up > 0 ? up : 0;
    minusDM[t] = dn > up && dn > 0 ? dn : 0;
    tr[t] = Math.max(
      high[t] - low[t],
      Math.abs(high[t] - close[t - 1]),
      Math.abs(low[t] - close[t - 1]),
    );
  }
  // Wilder smoothing
  const atr = new Array(T).fill(NaN);
  const sPlus = new Array(T).fill(NaN);
  const sMinus = new Array(T).fill(NaN);
  const out = new Array(T).fill(NaN);
  // seed at index w (sum of first w values from index 1..w)
  if (T <= w + 1) return out;
  let trSum = 0,
    pSum = 0,
    mSum = 0;
  for (let k = 1; k <= w; k++) {
    trSum += tr[k];
    pSum += plusDM[k];
    mSum += minusDM[k];
  }
  atr[w] = trSum;
  sPlus[w] = pSum;
  sMinus[w] = mSum;
  const dx = new Array(T).fill(NaN);
  for (let t = w + 1; t < T; t++) {
    atr[t] = atr[t - 1] - atr[t - 1] / w + tr[t];
    sPlus[t] = sPlus[t - 1] - sPlus[t - 1] / w + plusDM[t];
    sMinus[t] = sMinus[t - 1] - sMinus[t - 1] / w + minusDM[t];
    const pdi = atr[t] > 1e-12 ? (100 * sPlus[t]) / atr[t] : 0;
    const mdi = atr[t] > 1e-12 ? (100 * sMinus[t]) / atr[t] : 0;
    const denom = pdi + mdi;
    dx[t] = denom > 1e-12 ? (100 * Math.abs(pdi - mdi)) / denom : 0;
  }
  // ADX = Wilder smoothing of DX over w, seeded at index 2w
  const seedEnd = 2 * w;
  if (T <= seedEnd) return out;
  let dxSum = 0;
  for (let k = w + 1; k <= seedEnd; k++) dxSum += dx[k];
  out[seedEnd] = dxSum / w;
  for (let t = seedEnd + 1; t < T; t++) {
    out[t] = (out[t - 1] * (w - 1) + dx[t]) / w;
  }
  return out;
}

/** TSMOM raw signal: sign of trailing log return over lookback L, ending at t. */
export function tsmomSignal(close: number[], L: number, allowShort: boolean): number[] {
  const T = close.length;
  const out = new Array(T).fill(NaN);
  for (let t = L; t < T; t++) {
    const r = Math.log(close[t] / close[t - L]);
    out[t] = r > 0 ? 1 : allowShort ? -1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------- backtest
export interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number;
  nDays: number;
  longShare: number;
}

/** Run a position array over [startIdx,endIdx). pos[t] earns fwdRet[t]. */
export function runPositions(
  D: Daily,
  position: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0;
  let expSum = 0;
  let longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = D.fwdRet[t];
    const pos = Number.isFinite(position[t]) ? position[t] : 0;
    if (!Number.isFinite(fr)) continue;
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
    dailyNet,
    dailyGross,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    nDays: n,
    longShare: n ? longCount / n : 0,
  };
}
