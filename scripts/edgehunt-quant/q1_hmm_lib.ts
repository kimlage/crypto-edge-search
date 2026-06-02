/**
 * Q1-HMM — Gaussian HMM regime-switching timer (library).
 *
 * Strictly causal: at each decision day t we infer the regime using ONLY information up to t.
 * Two leakage sources are both closed:
 *   (1) state inference — forward/filtered probability (no Viterbi smoothing over future).
 *   (2) PARAMETER leakage — the HMM (means/vols/transition matrix) is refit on a TRAILING/EXPANDING
 *       window ending at t. Fitting once on the full sample then "filtering causally" still leaks,
 *       because the learned regime means saw the future. We refit on a schedule (every `refitEvery`
 *       days) using only past data, then filter forward from the last refit to t.
 *
 * Risk-on/risk-off labelling is also causal: the long state = the state with the higher in-sample
 * mean return (computed from the trailing fit window only), broken ties by lower vol.
 */

import fs from "node:fs";

const ROOT = ".";

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function loadBtcDaily(): DailyBar[] {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8"));
  return (j as DailyBar[]).filter((b) => b.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

// ----------------------------------------------------------------- math utils

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
export const ANN = Math.sqrt(365);
export function annSharpe(dailySh: number): number {
  return dailySh * ANN;
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
// Gaussian draw (Box-Muller) from a uniform rng
export function gauss(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ----------------------------------------------------------------- features

export interface Series {
  dates: string[];
  close: number[];
  ret: number[]; // log return ret[t] = log(close[t]/close[t-1]); ret[0]=0
  rv: number[]; // trailing realized vol (std of last `rvWin` rets) ending at t; causal
  fwdRet: number[]; // log return t -> t+1; last = NaN
}

export function buildSeries(bars: DailyBar[], rvWin = 14): Series {
  const dates = bars.map((b) => b.date);
  const close = bars.map((b) => b.close);
  const T = close.length;
  const ret = new Array(T).fill(0);
  for (let t = 1; t < T; t++) ret[t] = Math.log(close[t] / close[t - 1]);
  const rv = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    if (t + 1 < rvWin) continue;
    const w = ret.slice(t - rvWin + 1, t + 1);
    rv[t] = std(w);
  }
  const fwdRet = new Array(T).fill(NaN);
  for (let t = 0; t < T - 1; t++) fwdRet[t] = Math.log(close[t + 1] / close[t]);
  return { dates, close, ret, rv, fwdRet };
}

// ----------------------------------------------------------------- Gaussian HMM
//
// Observation = 2D vector [ret, log(rv)] (rv is strictly positive). Diagonal-covariance Gaussian
// emissions. Baum-Welch EM. Returns parameters; filtering done separately for causality.

export interface HmmParams {
  K: number;
  dim: number;
  pi: number[]; // K
  A: number[][]; // KxK transition
  mu: number[][]; // K x dim
  var_: number[][]; // K x dim (diagonal)
}

function logGauss(x: number[], mu: number[], var_: number[]): number {
  let lp = 0;
  for (let d = 0; d < x.length; d++) {
    const v = Math.max(var_[d], 1e-8);
    lp += -0.5 * (Math.log(2 * Math.PI * v) + ((x[d] - mu[d]) ** 2) / v);
  }
  return lp;
}

function logSumExp(arr: number[]): number {
  const m = Math.max(...arr);
  if (!Number.isFinite(m)) return -Infinity;
  let s = 0;
  for (const a of arr) s += Math.exp(a - m);
  return m + Math.log(s);
}

// k-means++-ish init on ret dimension, sorted by mean ret so state ordering is stable
function initParams(obs: number[][], K: number, rng: () => number): HmmParams {
  const dim = obs[0].length;
  const n = obs.length;
  // sort observations by first dim (ret), split into K quantile buckets
  const idx = obs.map((_, i) => i).sort((a, b) => obs[a][0] - obs[b][0]);
  const mu: number[][] = [];
  const var_: number[][] = [];
  for (let k = 0; k < K; k++) {
    const lo = Math.floor((k * n) / K);
    const hi = Math.floor(((k + 1) * n) / K);
    const bucket = idx.slice(lo, hi).map((i) => obs[i]);
    const m: number[] = [];
    const v: number[] = [];
    for (let d = 0; d < dim; d++) {
      const col = bucket.map((o) => o[d]);
      m.push(mean(col));
      v.push(Math.max(std(col) ** 2, 1e-6));
    }
    mu.push(m);
    var_.push(v);
  }
  const A: number[][] = [];
  for (let i = 0; i < K; i++) {
    const row = new Array(K).fill((1 - 0.9) / (K - 1 || 1));
    row[i] = 0.9;
    A.push(row);
  }
  const pi = new Array(K).fill(1 / K);
  return { K, dim, pi, A, mu, var_ };
}

export function fitHmm(
  obs: number[][],
  K: number,
  opts: { maxIter?: number; seed?: number; nInit?: number } = {},
): HmmParams {
  const maxIter = opts.maxIter ?? 60;
  const nInit = opts.nInit ?? 3;
  let bestLL = -Infinity;
  let bestParams: HmmParams | null = null;
  for (let init = 0; init < nInit; init++) {
    const rng = mkRng((opts.seed ?? 12345) + init * 101);
    let p = initParams(obs, K, rng);
    let prevLL = -Infinity;
    for (let iter = 0; iter < maxIter; iter++) {
      const { ll, params } = emStep(obs, p);
      p = params;
      if (Number.isFinite(ll) && Math.abs(ll - prevLL) < 1e-5 * Math.abs(prevLL || 1)) {
        prevLL = ll;
        break;
      }
      prevLL = ll;
    }
    if (prevLL > bestLL) {
      bestLL = prevLL;
      bestParams = p;
    }
  }
  return bestParams!;
}

// One Baum-Welch EM step in log-space. Returns updated params and the log-likelihood.
function emStep(obs: number[][], p: HmmParams): { ll: number; params: HmmParams } {
  const { K, dim } = p;
  const T = obs.length;
  const logA = p.A.map((r) => r.map((x) => Math.log(Math.max(x, 1e-12))));
  const logPi = p.pi.map((x) => Math.log(Math.max(x, 1e-12)));
  // emission log-prob
  const logB: number[][] = obs.map((x) => {
    const row = new Array(K);
    for (let k = 0; k < K; k++) row[k] = logGauss(x, p.mu[k], p.var_[k]);
    return row;
  });
  // forward
  const logAlpha: number[][] = Array.from({ length: T }, () => new Array(K).fill(-Infinity));
  for (let k = 0; k < K; k++) logAlpha[0][k] = logPi[k] + logB[0][k];
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < K; j++) {
      const terms = new Array(K);
      for (let i = 0; i < K; i++) terms[i] = logAlpha[t - 1][i] + logA[i][j];
      logAlpha[t][j] = logSumExp(terms) + logB[t][j];
    }
  }
  const ll = logSumExp(logAlpha[T - 1]);
  // backward
  const logBeta: number[][] = Array.from({ length: T }, () => new Array(K).fill(-Infinity));
  for (let k = 0; k < K; k++) logBeta[T - 1][k] = 0;
  for (let t = T - 2; t >= 0; t--) {
    for (let i = 0; i < K; i++) {
      const terms = new Array(K);
      for (let j = 0; j < K; j++) terms[j] = logA[i][j] + logB[t + 1][j] + logBeta[t + 1][j];
      logBeta[t][i] = logSumExp(terms);
    }
  }
  // gamma
  const logGamma: number[][] = Array.from({ length: T }, () => new Array(K).fill(-Infinity));
  for (let t = 0; t < T; t++) {
    const row = new Array(K);
    for (let k = 0; k < K; k++) row[k] = logAlpha[t][k] + logBeta[t][k];
    const norm = logSumExp(row);
    for (let k = 0; k < K; k++) logGamma[t][k] = row[k] - norm;
  }
  // xi accumulation for transition
  const xiNum: number[][] = Array.from({ length: K }, () => new Array(K).fill(-Infinity));
  for (let t = 0; t < T - 1; t++) {
    const terms: { i: number; j: number; v: number }[] = [];
    let normTerms: number[] = [];
    for (let i = 0; i < K; i++)
      for (let j = 0; j < K; j++) {
        const v = logAlpha[t][i] + logA[i][j] + logB[t + 1][j] + logBeta[t + 1][j];
        terms.push({ i, j, v });
        normTerms.push(v);
      }
    const norm = logSumExp(normTerms);
    for (const { i, j, v } of terms) {
      const lx = v - norm;
      xiNum[i][j] = logSumExp([xiNum[i][j], lx]);
    }
  }
  // M-step
  const newPi = logGamma[0].map((lg) => Math.exp(lg));
  const newA: number[][] = [];
  for (let i = 0; i < K; i++) {
    // denom = sum_t gamma[t][i] for t in 0..T-2
    const denomTerms = [];
    for (let t = 0; t < T - 1; t++) denomTerms.push(logGamma[t][i]);
    const denom = logSumExp(denomTerms);
    const row = [];
    for (let j = 0; j < K; j++) row.push(Math.exp(xiNum[i][j] - denom));
    const rs = row.reduce((s, x) => s + x, 0) || 1;
    newA.push(row.map((x) => x / rs));
  }
  const newMu: number[][] = [];
  const newVar: number[][] = [];
  for (let k = 0; k < K; k++) {
    const gw = logGamma.map((g) => Math.exp(g[k]));
    const gsum = gw.reduce((s, x) => s + x, 0) || 1e-12;
    const m = new Array(dim).fill(0);
    for (let t = 0; t < T; t++) for (let d = 0; d < dim; d++) m[d] += gw[t] * obs[t][d];
    for (let d = 0; d < dim; d++) m[d] /= gsum;
    const v = new Array(dim).fill(0);
    for (let t = 0; t < T; t++)
      for (let d = 0; d < dim; d++) v[d] += gw[t] * (obs[t][d] - m[d]) ** 2;
    for (let d = 0; d < dim; d++) v[d] = Math.max(v[d] / gsum, 1e-7);
    newMu.push(m);
    newVar.push(v);
  }
  return { ll, params: { K, dim, pi: newPi, A: newA, mu: newMu, var_: newVar } };
}

// Causal filtered state probability at the LAST observation of `obs`, given params.
// Returns the filtered posterior P(state_t | obs_1..t) for the final t.
export function filterLast(obs: number[][], p: HmmParams): number[] {
  const { K } = p;
  const T = obs.length;
  const logA = p.A.map((r) => r.map((x) => Math.log(Math.max(x, 1e-12))));
  const logPi = p.pi.map((x) => Math.log(Math.max(x, 1e-12)));
  let logAlpha = new Array(K);
  for (let k = 0; k < K; k++) logAlpha[k] = logPi[k] + logGauss(obs[0], p.mu[k], p.var_[k]);
  for (let t = 1; t < T; t++) {
    const next = new Array(K);
    for (let j = 0; j < K; j++) {
      const terms = new Array(K);
      for (let i = 0; i < K; i++) terms[i] = logAlpha[i] + logA[i][j];
      next[j] = logSumExp(terms) + logGauss(obs[t], p.mu[j], p.var_[j]);
    }
    logAlpha = next;
  }
  const norm = logSumExp(logAlpha);
  return logAlpha.map((x) => Math.exp(x - norm));
}
