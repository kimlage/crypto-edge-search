// Q9-LOWVOL — Cross-sectional low-volatility anomaly engine.
// Sort 30-coin panel by trailing realized vol; long low-vol / short high-vol,
// dollar-neutral + beta-neutral. Net of taker cost (4 bps/side).
//
// All data is on-disk $0 (output/crossxs/daily-closes.json). 30 coins, daily,
// 2020-06-02 .. 2026-05-31. Survivorship-biased universe (upper bound).
import { readFileSync } from "node:fs";

export const COST_PER_SIDE = 0.0004; // 4 bps taker per side
export const TRADING_DAYS = 365; // crypto trades every day

export interface Panel {
  dates: string[];
  symbols: string[];
  // close[t][i] price for symbol i at day t; NaN if not yet listed
  close: number[][];
  // logret[t][i] daily log return; NaN if either endpoint missing
  ret: number[][];
}

export function loadPanel(): Panel {
  const dc = JSON.parse(
    readFileSync("output/crossxs/daily-closes.json", "utf8"),
  ) as { dates: string[]; closes: Record<string, (number | null)[]> };
  const symbols = Object.keys(dc.closes);
  const dates = dc.dates;
  const T = dates.length;
  const N = symbols.length;
  const close: number[][] = Array.from({ length: T }, () => new Array(N).fill(NaN));
  for (let i = 0; i < N; i++) {
    const arr = dc.closes[symbols[i]];
    for (let t = 0; t < T; t++) {
      const v = arr[t];
      close[t][i] = v != null && v > 0 ? v : NaN;
    }
  }
  const ret: number[][] = Array.from({ length: T }, () => new Array(N).fill(NaN));
  for (let t = 1; t < T; t++) {
    for (let i = 0; i < N; i++) {
      const a = close[t - 1][i];
      const b = close[t][i];
      ret[t][i] = Number.isFinite(a) && Number.isFinite(b) ? Math.log(b / a) : NaN;
    }
  }
  return { dates, symbols, close, ret };
}

export function mean(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}
export function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / (a.length - 1));
}
export function sharpeAnn(daily: number[]): number {
  const m = mean(daily);
  const s = std(daily);
  return s > 1e-12 ? (m / s) * Math.sqrt(TRADING_DAYS) : 0;
}

export function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// trailing realized vol (stddev of daily log returns) over `win` days ending at t-1 (causal).
function trailingVol(P: Panel, t: number, i: number, win: number): number {
  const r: number[] = [];
  for (let k = t - win; k < t; k++) {
    if (k < 1) return NaN;
    const v = P.ret[k][i];
    if (!Number.isFinite(v)) return NaN;
    r.push(v);
  }
  if (r.length < win) return NaN;
  return std(r);
}

// trailing beta of coin i vs equal-weight market over `betaWin` days ending at t-1 (causal).
function trailingBeta(
  P: Panel,
  t: number,
  i: number,
  mkt: number[],
  betaWin: number,
): number {
  const xi: number[] = [];
  const xm: number[] = [];
  for (let k = t - betaWin; k < t; k++) {
    if (k < 1) return NaN;
    const ri = P.ret[k][i];
    const rm = mkt[k];
    if (!Number.isFinite(ri) || !Number.isFinite(rm)) return NaN;
    xi.push(ri);
    xm.push(rm);
  }
  if (xi.length < betaWin) return NaN;
  const mm = mean(xm);
  let cov = 0;
  let varm = 0;
  for (let k = 0; k < xm.length; k++) {
    cov += (xi[k] - mean(xi)) * (xm[k] - mm);
    varm += (xm[k] - mm) * (xm[k] - mm);
  }
  return varm > 1e-12 ? cov / varm : NaN;
}

// equal-weight market daily return (across listed coins).
export function marketReturn(P: Panel): number[] {
  const T = P.dates.length;
  const mkt = new Array(T).fill(NaN);
  for (let t = 1; t < T; t++) {
    const vals: number[] = [];
    for (let i = 0; i < P.symbols.length; i++) {
      const v = P.ret[t][i];
      if (Number.isFinite(v)) vals.push(v);
    }
    mkt[t] = vals.length > 0 ? mean(vals) : NaN;
  }
  return mkt;
}

export interface Config {
  volWin: number; // trailing vol lookback (days)
  betaWin: number; // trailing beta lookback (days)
  holdDays: number; // rebalance interval (days)
  frac: number; // fraction of universe in each leg (e.g. 0.3 => long bottom 30%, short top 30%)
  betaNeutral: boolean; // scale legs to zero net beta
  gross: number; // gross leverage (sum |w| = gross); legs each gross/2 in dollar terms
}

export interface RunResult {
  dailyNet: number[]; // per-day net portfolio return (sized to gross exposure)
  dailyGross: number[];
  turnoverPerRebal: number;
  avgNetBeta: number; // realized book beta vs market (ex-ante target ~0)
  nRebals: number;
  avgLongVol: number;
  avgShortVol: number;
  weights: (number[] | null)[]; // weights held entering each day (for shuffle null)
}

// Build per-day target weights. Weights for day t are decided at t (using info up to t-1)
// and earn P.ret[t]. Rebalance every holdDays; weights held constant between rebalances
// (drift ignored for simplicity — weights are re-imposed, turnover charged at rebalance).
export function buildWeights(
  P: Panel,
  cfg: Config,
  mkt: number[],
  startIdx: number,
  endIdx: number,
): (number[] | null)[] {
  const T = P.dates.length;
  const N = P.symbols.length;
  const W: (number[] | null)[] = new Array(T).fill(null);
  let current: number[] | null = null;
  let lastRebal = -1;
  for (let t = startIdx; t < endIdx; t++) {
    const due = lastRebal < 0 || t - lastRebal >= cfg.holdDays;
    if (due) {
      // rank eligible coins by trailing vol
      const elig: { i: number; vol: number; beta: number }[] = [];
      for (let i = 0; i < N; i++) {
        const vol = trailingVol(P, t, i, cfg.volWin);
        if (!Number.isFinite(vol)) continue;
        const beta = trailingBeta(P, t, i, mkt, cfg.betaWin);
        if (!Number.isFinite(beta)) continue;
        elig.push({ i, vol, beta });
      }
      if (elig.length >= 6) {
        elig.sort((a, b) => a.vol - b.vol);
        const k = Math.max(1, Math.floor(elig.length * cfg.frac));
        const longs = elig.slice(0, k); // low vol
        const shorts = elig.slice(elig.length - k); // high vol
        const w = new Array(N).fill(0);
        // dollar-neutral: each leg sums to +/- 1 (notional) before beta-neutral rescale
        const wl = 1 / longs.length;
        const ws = 1 / shorts.length;
        for (const e of longs) w[e.i] += wl;
        for (const e of shorts) w[e.i] -= ws;
        if (cfg.betaNeutral) {
          // scale legs so net beta = 0 while keeping dollar exposure balanced as best possible.
          // betaL = mean beta of longs, betaS = mean beta of shorts.
          const betaL = mean(longs.map((e) => e.beta));
          const betaS = mean(shorts.map((e) => e.beta));
          // we want a*betaL - b*betaS = 0 with a (long $) and b (short $).
          // keep total gross constant: a + b = 1 (then rescale to gross). a*betaL = b*betaS.
          // => a = betaS/(betaL+betaS) ... guard signs.
          const denom = betaL + betaS;
          let a = 0.5;
          let b = 0.5;
          if (Math.abs(denom) > 1e-9 && betaL > 0 && betaS > 0) {
            a = betaS / denom;
            b = betaL / denom;
          }
          for (const e of longs) w[e.i] = a * wl;
          for (const e of shorts) w[e.i] = -b * ws;
        }
        // scale to gross leverage: sum|w| = gross
        let s = 0;
        for (const v of w) s += Math.abs(v);
        if (s > 1e-12) {
          const sc = cfg.gross / s;
          for (let i = 0; i < N; i++) w[i] *= sc;
        }
        current = w;
        lastRebal = t;
      }
    }
    W[t] = current ? current.slice() : null;
  }
  return W;
}

export function runWeights(
  P: Panel,
  W: (number[] | null)[],
  mkt: number[],
  startIdx: number,
  endIdx: number,
  cfg: Config,
): RunResult {
  const N = P.symbols.length;
  const dailyGross: number[] = [];
  const dailyNet: number[] = [];
  let prevW: number[] | null = null;
  let turnoverSum = 0;
  let rebals = 0;
  const netBetas: number[] = [];
  const longVols: number[] = [];
  const shortVols: number[] = [];
  for (let t = startIdx; t < endIdx; t++) {
    const w = W[t];
    if (!w) continue;
    // gross return of the book on day t
    let g = 0;
    for (let i = 0; i < N; i++) {
      if (w[i] === 0) continue;
      const r = P.ret[t][i];
      if (Number.isFinite(r)) g += w[i] * r;
    }
    // turnover cost only when weights changed (rebalance)
    let changed = false;
    let turn = 0;
    if (!prevW) {
      changed = true;
      for (let i = 0; i < N; i++) turn += Math.abs(w[i]);
    } else {
      for (let i = 0; i < N; i++) {
        const d = Math.abs(w[i] - prevW[i]);
        if (d > 1e-12) changed = true;
        turn += d;
      }
    }
    let cost = 0;
    if (changed) {
      cost = turn * COST_PER_SIDE; // turn = sum |Δw|; each side charged once
      turnoverSum += turn;
      rebals++;
    }
    dailyGross.push(g);
    dailyNet.push(g - cost);
    prevW = w;
  }
  // realized book beta diagnostic
  const bookRet = dailyNet;
  const mktSlice: number[] = [];
  let bi = 0;
  for (let t = startIdx; t < endIdx; t++) {
    if (!W[t]) continue;
    mktSlice.push(mkt[t]);
  }
  const beta = ols_beta(bookRet, mktSlice);
  return {
    dailyNet,
    dailyGross,
    turnoverPerRebal: rebals > 0 ? turnoverSum / rebals : 0,
    avgNetBeta: beta,
    nRebals: rebals,
    avgLongVol: mean(longVols),
    avgShortVol: mean(shortVols),
    weights: W,
  };
}

function ols_beta(y: number[], x: number[]): number {
  const n = Math.min(y.length, x.length);
  const ys: number[] = [];
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(y[i]) && Number.isFinite(x[i])) {
      ys.push(y[i]);
      xs.push(x[i]);
    }
  }
  if (ys.length < 3) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) * (xs[i] - mx);
  }
  return varx > 1e-12 ? cov / varx : NaN;
}

export { ols_beta, trailingVol, trailingBeta };
