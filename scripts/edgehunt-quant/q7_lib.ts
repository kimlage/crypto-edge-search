/**
 * Q7-VOLREGIME shared lib (maps to docs/BACKLOG.md D3-A4 "Realized-vol regime switching").
 *
 * Hypothesis under test: does a previously-killed stand-alone signal (TSMOM or RSI) revive when
 * GATED to a realized-vol regime ("momentum in calm, reversion in crisis")?
 *
 * Data: committed $0 BTC 15m OHLCV (output/bigquery/btc_ohlcv_15m.ndjson), aggregated to DAILY
 * bars (>100k -> aggregate before gates). Daily is the right horizon for TSMOM/RSI regime work and
 * keeps honest-N tractable.
 *
 * THE RIGHT NULL for a vol-clustering / vol-conditioned timing strategy (lab-documented traps):
 *   (a) GARCH(1,1) surrogate: re-simulate returns that preserve the vol-clustering dynamics but
 *       carry ZERO return edge (i.i.d. standardized innovations). If the gated signal's edge is an
 *       artifact of vol clustering + regime labeling, it survives on the surrogate too.
 *   (b) MATCHED-EXPOSURE control: the *ungated* killed signal, scaled to the SAME average |exposure|
 *       as the gated book. A vol gate that merely sits out of high-vol days is just de-risking; to
 *       count as alpha it must beat the same signal deployed at matched exposure (and beat B&H).
 *
 * Causality: position at close t (signals use info <= t), earn close-to-close log return t -> t+1.
 * Cost: 4 bps taker per side on turnover (COST_PER_SIDE).
 */
import fs from "node:fs";

export const ROOT = ".";
export const COST_PER_SIDE = 0.0004; // 4 bps taker/side
export const ANN_DAILY = Math.sqrt(365);

// ----------------------------------------------------------------- daily bars
export interface DailyBars {
  dates: string[]; // YYYY-MM-DD ascending
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  ret: number[]; // log return close[t-1]->close[t]; ret[0]=NaN  (CONTEMPORANEOUS daily return)
  fwdRet: number[]; // log return close[t]->close[t+1]; last=NaN (what a position at t earns)
}

export function loadDailyBTC(): DailyBars {
  const path = `${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`;
  const lines = fs.readFileSync(path, "utf8").split("\n");
  // aggregate 15m -> daily by event_date
  const map = new Map<string, { o: number; h: number; l: number; c: number; ts: string }>();
  for (const ln of lines) {
    if (!ln) continue;
    let r: any;
    try {
      r = JSON.parse(ln);
    } catch {
      continue;
    }
    const d = r.event_date as string;
    const o = Number(r.open),
      h = Number(r.high),
      l = Number(r.low),
      c = Number(r.close);
    if (!(c > 0)) continue;
    const cur = map.get(d);
    if (!cur) {
      map.set(d, { o, h, l, c, ts: r.event_time });
    } else {
      // first bar of day already set o; keep running high/low; last bar sets close
      if (h > cur.h) cur.h = h;
      if (l < cur.l) cur.l = l;
      if (r.event_time >= cur.ts) {
        cur.c = c;
        cur.ts = r.event_time;
      }
    }
  }
  const dates = [...map.keys()].sort();
  const B: DailyBars = { dates: [], open: [], high: [], low: [], close: [], ret: [], fwdRet: [] };
  for (const d of dates) {
    const m = map.get(d)!;
    B.dates.push(d);
    B.open.push(m.o);
    B.high.push(m.h);
    B.low.push(m.l);
    B.close.push(m.c);
  }
  const T = B.close.length;
  for (let t = 0; t < T; t++) {
    B.ret.push(t > 0 ? Math.log(B.close[t] / B.close[t - 1]) : NaN);
    B.fwdRet.push(t + 1 < T ? Math.log(B.close[t + 1] / B.close[t]) : NaN);
  }
  return B;
}

// ----------------------------------------------------------------- math
export function mean(a: number[]): number {
  let s = 0,
    n = 0;
  for (const v of a)
    if (Number.isFinite(v)) {
      s += v;
      n++;
    }
  return n ? s / n : 0;
}
export function std(a: number[]): number {
  const f = a.filter(Number.isFinite);
  const n = f.length;
  if (n < 2) return 0;
  const m = mean(f);
  return Math.sqrt(f.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
}
export function sharpeDaily(a: number[]): number {
  const f = a.filter(Number.isFinite);
  const s = std(f);
  return s > 1e-12 ? mean(f) / s : 0;
}
export function annSharpe(dailySharpe: number): number {
  return dailySharpe * ANN_DAILY;
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
// Box-Muller standard normal from a uniform rng
export function randn(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ----------------------------------------------------------------- features (all causal, use info <= t)
// trailing realized vol (std of daily log returns over window ending at t)
export function realizedVol(ret: number[], win: number): number[] {
  const out = new Array(ret.length).fill(NaN);
  for (let t = 0; t < ret.length; t++) {
    if (t < win) continue;
    const w: number[] = [];
    for (let k = t - win + 1; k <= t; k++) if (Number.isFinite(ret[k])) w.push(ret[k]);
    if (w.length < win) continue;
    out[t] = std(w);
  }
  return out;
}
// trailing percentile rank (0..1) of x[t] within trailing window -> regime label is causal
export function trailingPctRank(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let t = 0; t < x.length; t++) {
    if (t < win) continue;
    const cur = x[t];
    if (!Number.isFinite(cur)) continue;
    let cnt = 0,
      n = 0;
    for (let k = t - win + 1; k <= t; k++) {
      if (!Number.isFinite(x[k])) continue;
      n++;
      if (x[k] <= cur) cnt++;
    }
    if (n >= Math.min(60, win)) out[t] = cnt / n;
  }
  return out;
}
// TSMOM raw signal: sign of trailing log return over lookback L (the classic killed signal)
export function tsmomSignal(close: number[], L: number): number[] {
  const out = new Array(close.length).fill(NaN);
  for (let t = 0; t < close.length; t++) {
    if (t < L) continue;
    out[t] = Math.log(close[t] / close[t - L]); // raw momentum; sign used for direction
  }
  return out;
}
// RSI (Wilder) over window L; causal
export function rsi(close: number[], L: number): number[] {
  const out = new Array(close.length).fill(NaN);
  let avgG = NaN,
    avgL = NaN;
  for (let t = 1; t < close.length; t++) {
    const ch = close[t] - close[t - 1];
    const g = Math.max(0, ch),
      l = Math.max(0, -ch);
    if (t <= L) {
      avgG = Number.isFinite(avgG) ? avgG + g : g;
      avgL = Number.isFinite(avgL) ? avgL + l : l;
      if (t === L) {
        avgG /= L;
        avgL /= L;
        out[t] = avgL < 1e-12 ? 100 : 100 - 100 / (1 + avgG / avgL);
      }
    } else {
      avgG = (avgG * (L - 1) + g) / L;
      avgL = (avgL * (L - 1) + l) / L;
      out[t] = avgL < 1e-12 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }
  return out;
}

// ----------------------------------------------------------------- backtest
export interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number; // mean |pos|
  nDays: number;
  longShare: number;
}
export function runPositions(
  B: DailyBars,
  position: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0,
    turnoverSum = 0,
    expSum = 0,
    longCount = 0,
    n = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = B.fwdRet[t];
    let pos = position[t];
    if (!Number.isFinite(fr)) continue;
    if (!Number.isFinite(pos)) pos = 0;
    const turn = Math.abs(pos - prev);
    const cost = turn * costPerSide;
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - cost);
    turnoverSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    prev = pos;
    n++;
  }
  return {
    dailyNet,
    dailyGross,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    nDays: n,
    longShare: n ? longCount / n : 0,
  };
}

// ----------------------------------------------------------------- GARCH(1,1) surrogate
// Fit a simple GARCH(1,1) to demeaned daily returns by a coarse grid MLE, then simulate paths that
// preserve vol clustering but carry ZERO return edge (innovations i.i.d., mean 0). Returns a NEW
// close-price path so that EVERY downstream feature (RV regime, TSMOM, RSI) is recomputed on it.
export interface Garch11 {
  omega: number;
  alpha: number;
  beta: number;
  mu: number;
  uncondVar: number;
}
export function fitGarch11(ret: number[]): Garch11 {
  const r = ret.filter(Number.isFinite);
  const mu = mean(r);
  const e = r.map((x) => x - mu);
  const varAll = mean(e.map((x) => x * x));
  // coarse grid search over (alpha,beta) with omega pinned to target uncond var
  let best = { ll: -Infinity, alpha: 0.08, beta: 0.9 };
  for (let alpha = 0.02; alpha <= 0.2; alpha += 0.02) {
    for (let beta = 0.7; beta <= 0.96; beta += 0.02) {
      if (alpha + beta >= 0.999) continue;
      const omega = varAll * (1 - alpha - beta);
      if (omega <= 0) continue;
      let h = varAll,
        ll = 0;
      for (let t = 0; t < e.length; t++) {
        const x = e[t];
        ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(h) + (x * x) / h);
        h = omega + alpha * x * x + beta * h;
      }
      if (ll > best.ll) best = { ll, alpha, beta };
    }
  }
  const omega = varAll * (1 - best.alpha - best.beta);
  return { omega, alpha: best.alpha, beta: best.beta, mu, uncondVar: varAll };
}
// Simulate a surrogate close-price path of length T (matching B) with ZERO return edge.
// We keep mu=0 (no drift) so the surrogate has no directional edge to exploit; only vol clustering.
// (Using mu=B&H drift would HELP a long-biased book; zero-drift is the conservative correct null
//  for whether the GATE adds timing alpha beyond vol clustering.)
export function simulateGarchCloses(
  g: Garch11,
  startClose: number,
  T: number,
  rng: () => number,
): number[] {
  const closes = new Array(T).fill(startClose);
  let h = g.uncondVar;
  let logp = Math.log(startClose);
  for (let t = 1; t < T; t++) {
    const z = randn(rng);
    const eps = Math.sqrt(h) * z; // zero-mean innovation
    logp += eps; // mu = 0: no return edge
    closes[t] = Math.exp(logp);
    h = g.omega + g.alpha * eps * eps + g.beta * h;
  }
  return closes;
}
// build a surrogate DailyBars from a simulated close path (open/high/low set to close; only
// close-based features are used by Q7 signals so OHLC detail is irrelevant here)
export function barsFromCloses(template: DailyBars, closes: number[]): DailyBars {
  const T = closes.length;
  const B: DailyBars = {
    dates: template.dates.slice(0, T),
    open: closes.slice(),
    high: closes.slice(),
    low: closes.slice(),
    close: closes.slice(),
    ret: new Array(T).fill(NaN),
    fwdRet: new Array(T).fill(NaN),
  };
  for (let t = 0; t < T; t++) {
    B.ret[t] = t > 0 ? Math.log(closes[t] / closes[t - 1]) : NaN;
    B.fwdRet[t] = t + 1 < T ? Math.log(closes[t + 1] / closes[t]) : NaN;
  }
  return B;
}
