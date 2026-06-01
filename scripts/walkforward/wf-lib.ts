/**
 * TRACK WF-B — Walk-forward ADAPTIVE indicator strategy library.
 *
 * Pure, deterministic building blocks:
 *  - data loading (daily perp closes for the 6 majors)
 *  - 3 indicator families (Bollinger mean-reversion, Donchian breakout, MA-cross)
 *  - a position generator with STRICT CAUSALITY (signal at bar i uses only [.. i])
 *  - a cost-aware backtester that charges taker fees on every position change
 *  - phase-randomization + block-shuffle surrogates that preserve vol/autocorr
 *
 * No I/O except readFileSync of the committed price JSON. No network, no paid data.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
export const ASSETS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"] as const;
export type Asset = (typeof ASSETS)[number];

/** Taker fee per side for a perp (4 bps). Charged on every position change. */
export const TAKER_FEE_PER_SIDE = 0.0004;

export interface DailyBar {
  date: string;
  close: number; // perp close
}

export interface AssetSeries {
  asset: Asset;
  bars: DailyBar[];
  /** close-to-close simple returns, aligned so ret[i] is the return realized over bar i (close[i]/close[i-1]-1). ret[0] = 0. */
  returns: number[];
}

export function loadAsset(asset: Asset): AssetSeries {
  const path = join(REPO_ROOT, "output", "funding", `${asset}USDT_prices_daily.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<{
    date: string;
    perpClose: number;
    spotClose: number;
  }>;
  const bars: DailyBar[] = raw
    .filter((r) => Number.isFinite(r.perpClose) && r.perpClose > 0)
    .map((r) => ({ date: r.date, close: r.perpClose }));
  const returns = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i += 1) {
    returns[i] = bars[i].close / bars[i - 1].close - 1;
  }
  return { asset, bars, returns };
}

export function loadAllAssets(): AssetSeries[] {
  return ASSETS.map(loadAsset);
}

// ---------------------------------------------------------------------------
// Indicator families. Each produces a TARGET POSITION in {-1, 0, +1} per bar,
// computed with STRICT CAUSALITY: position to hold over bar i (i.e. earning
// returns[i]) is decided from closes up to and including bar i-1.
//
// We encode "decide at close of bar i-1, hold over bar i" by computing a
// signal array sig[] where sig[i] is the position to APPLY to returns[i].
// ---------------------------------------------------------------------------

export type Family = "bollinger" | "donchian" | "ma_cross";

export interface ParamConfig {
  family: Family;
  /** integer params describing the config; meaning depends on family */
  a: number; // lookback / fast
  b: number; // z-threshold*10 (bollinger) | slow (ma_cross) | unused (donchian)
}

export function paramKey(p: ParamConfig): string {
  return `${p.family}:${p.a}:${p.b}`;
}

/** Build the full param grid per family. */
export function buildParamGrid(): ParamConfig[] {
  const grid: ParamConfig[] = [];
  // Bollinger mean-reversion: lookback n in {10,20,30,40,50}, z in {1.0..3.0 step .5}
  for (const n of [10, 20, 30, 40, 50]) {
    for (const z10 of [10, 15, 20, 25, 30]) {
      grid.push({ family: "bollinger", a: n, b: z10 });
    }
  }
  // Donchian breakout: channel n in {10,15,20,30,40,55}
  for (const n of [10, 15, 20, 30, 40, 55]) {
    grid.push({ family: "donchian", a: n, b: 0 });
  }
  // MA-cross trend: fast in {5,10,20}, slow in {30,50,100,150}
  for (const fast of [5, 10, 20]) {
    for (const slow of [30, 50, 100, 150]) {
      if (fast < slow) grid.push({ family: "ma_cross", a: fast, b: slow });
    }
  }
  return grid;
}

export function gridForFamily(family: Family): ParamConfig[] {
  return buildParamGrid().filter((p) => p.family === family);
}

/**
 * Compute the per-bar target position for an entire price path under a config.
 * sig[i] in {-1,0,+1} is the position to apply to returns[i] (i.e. decided from
 * closes[0..i-1]). The first `warmup` bars are flat (0) because the indicator is
 * undefined. STRICTLY CAUSAL: never reads close[i] or later when setting sig[i].
 */
export function computeSignal(closes: number[], p: ParamConfig): number[] {
  const n = closes.length;
  const sig = new Array<number>(n).fill(0);
  if (p.family === "bollinger") {
    const win = p.a;
    const zThresh = p.b / 10;
    // state machine: enter long when price < lower band, short when > upper band,
    // exit (flat) when price crosses back through the mean. Decided at close[i-1].
    let pos = 0;
    for (let i = 1; i < n; i += 1) {
      // decide position for bar i using closes up to i-1
      const end = i; // exclusive upper bound -> uses indices [i-win .. i-1]
      if (end - win >= 0) {
        let sum = 0;
        for (let k = end - win; k < end; k += 1) sum += closes[k];
        const mean = sum / win;
        let varSum = 0;
        for (let k = end - win; k < end; k += 1) varSum += (closes[k] - mean) ** 2;
        const sd = Math.sqrt(varSum / win);
        const last = closes[i - 1];
        if (sd > 0) {
          const z = (last - mean) / sd;
          if (pos === 0) {
            if (z <= -zThresh) pos = 1;
            else if (z >= zThresh) pos = -1;
          } else if (pos === 1) {
            if (z >= 0) pos = 0; // reverted to mean -> exit
          } else if (pos === -1) {
            if (z <= 0) pos = 0;
          }
        }
      }
      sig[i] = pos;
    }
  } else if (p.family === "donchian") {
    const win = p.a;
    let pos = 0;
    for (let i = 1; i < n; i += 1) {
      const end = i; // indices [i-win .. i-1]
      if (end - win >= 0) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let k = end - win; k < end; k += 1) {
          if (closes[k] > hi) hi = closes[k];
          if (closes[k] < lo) lo = closes[k];
        }
        const last = closes[i - 1];
        // breakout long above prior-channel high, short below prior-channel low.
        if (last >= hi) pos = 1;
        else if (last <= lo) pos = -1;
        // otherwise hold previous position (channel trend-following)
      }
      sig[i] = pos;
    }
  } else {
    // ma_cross
    const fast = p.a;
    const slow = p.b;
    let pos = 0;
    // rolling sums for efficiency
    for (let i = 1; i < n; i += 1) {
      const end = i; // indices [.. i-1]
      if (end - slow >= 0) {
        let fs = 0;
        for (let k = end - fast; k < end; k += 1) fs += closes[k];
        let ss = 0;
        for (let k = end - slow; k < end; k += 1) ss += closes[k];
        const fma = fs / fast;
        const sma = ss / slow;
        pos = fma > sma ? 1 : fma < sma ? -1 : pos;
      }
      sig[i] = pos;
    }
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Cost-aware backtest over a slice [from, to). Returns per-bar NET returns and
// turnover. Position is applied to returns[i]; the cost is charged whenever the
// applied position changes from the previous bar (|Δpos| * feePerSide), since a
// flip from +1 to -1 is two sides.
// ---------------------------------------------------------------------------

export interface BacktestResult {
  netReturns: number[]; // per-bar net-of-cost returns for the slice
  grossReturns: number[];
  positions: number[]; // applied position per bar
  turnover: number; // sum of |Δpos| over slice
  costPaid: number; // total fee fraction paid over slice
  tradeCount: number; // number of position changes (entries+flips)
}

/**
 * Backtest a precomputed signal over slice [from, to) of a returns array.
 * `priorPos` is the position carried in from the previous slice (for continuity
 * of cost accounting across concatenated OOS slices).
 */
export function backtestSlice(
  returns: number[],
  sig: number[],
  from: number,
  to: number,
  priorPos: number,
  feePerSide = TAKER_FEE_PER_SIDE,
): BacktestResult {
  const netReturns: number[] = [];
  const grossReturns: number[] = [];
  const positions: number[] = [];
  let turnover = 0;
  let costPaid = 0;
  let tradeCount = 0;
  let prev = priorPos;
  for (let i = from; i < to; i += 1) {
    const pos = sig[i];
    const dPos = Math.abs(pos - prev);
    const cost = dPos * feePerSide;
    if (dPos > 0) tradeCount += 1;
    turnover += dPos;
    costPaid += cost;
    const gross = pos * returns[i];
    grossReturns.push(gross);
    netReturns.push(gross - cost);
    positions.push(pos);
    prev = pos;
  }
  return { netReturns, grossReturns, positions, turnover, costPaid, tradeCount, };
}

// ---------------------------------------------------------------------------
// In-sample scoring: pick the param that maximizes net-of-cost Sharpe over the
// in-sample window. STRICT CAUSALITY enforced by the caller (window indices).
// ---------------------------------------------------------------------------

export interface ParamScore {
  config: ParamConfig;
  sharpe: number;
  compound: number;
  tradeCount: number;
}

export function scoreParamInSample(
  closes: number[],
  returns: number[],
  p: ParamConfig,
  from: number,
  to: number,
): ParamScore {
  // recompute signal once over full closes (causal), score the [from,to) slice
  const sig = computeSignal(closes, p);
  const bt = backtestSlice(returns, sig, from, to, 0);
  const mean = avg(bt.netReturns);
  const sd = std(bt.netReturns, mean);
  const sharpe = sd > 1e-12 ? mean / sd : 0;
  return {
    config: p,
    sharpe,
    compound: compound(bt.netReturns),
    tradeCount: bt.tradeCount,
  };
}

// ---------------------------------------------------------------------------
// Surrogate generators. Both preserve the in-sample return distribution / serial
// dependence at coarse scale while destroying the precise structure exploited by
// the indicators.
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let v = state;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Phase-randomized surrogate of a return series (Theiler 1992): FFT the returns,
 * randomize the phases, invert. Preserves the power spectrum (hence the full
 * linear autocorrelation) and variance, but destroys nonlinear/structural
 * predictability. Rebuilds a price path from the surrogate returns.
 */
export function phaseRandomizedCloses(
  closes: number[],
  seed: number,
): number[] {
  const n = closes.length;
  const rets = new Array<number>(n - 1);
  for (let i = 1; i < n; i += 1) rets[i - 1] = Math.log(closes[i] / closes[i - 1]);
  const m = rets.length;
  const mean = avg(rets);
  const centered = rets.map((r) => r - mean);
  // real FFT via naive DFT (m ~ a few hundred, fine for a one-off study)
  const re = new Array<number>(m).fill(0);
  const im = new Array<number>(m).fill(0);
  for (let k = 0; k < m; k += 1) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < m; t += 1) {
      const ang = (-2 * Math.PI * k * t) / m;
      sr += centered[t] * Math.cos(ang);
      si += centered[t] * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  const mag = re.map((r, k) => Math.hypot(r, im[k]));
  const rng = makeRng(seed);
  // randomize phases, keep conjugate symmetry so the inverse is real
  const phase = new Array<number>(m).fill(0);
  for (let k = 1; k <= Math.floor(m / 2); k += 1) {
    const ph = (rng() * 2 - 1) * Math.PI;
    phase[k] = ph;
    phase[m - k] = -ph;
  }
  if (m % 2 === 0) phase[m / 2] = 0;
  const surrRe = mag.map((a, k) => a * Math.cos(phase[k]));
  const surrIm = mag.map((a, k) => a * Math.sin(phase[k]));
  const out = new Array<number>(m).fill(0);
  for (let t = 0; t < m; t += 1) {
    let s = 0;
    for (let k = 0; k < m; k += 1) {
      const ang = (2 * Math.PI * k * t) / m;
      s += surrRe[k] * Math.cos(ang) - surrIm[k] * Math.sin(ang);
    }
    out[t] = s / m + mean;
  }
  // rebuild closes
  const surrCloses = new Array<number>(n);
  surrCloses[0] = closes[0];
  for (let i = 1; i < n; i += 1) surrCloses[i] = surrCloses[i - 1] * Math.exp(out[i - 1]);
  return surrCloses;
}

/**
 * Stationary block-bootstrap surrogate: resample blocks of log-returns (block
 * length ~ sqrt(n)) and rebuild a price path. Preserves short-range autocorr and
 * the marginal distribution, destroys long-range structure. Cheaper than FFT.
 */
export function blockShuffledCloses(
  closes: number[],
  seed: number,
  blockLen?: number,
): number[] {
  const n = closes.length;
  const rets = new Array<number>(n - 1);
  for (let i = 1; i < n; i += 1) rets[i - 1] = Math.log(closes[i] / closes[i - 1]);
  const m = rets.length;
  const bl = blockLen ?? Math.max(2, Math.round(Math.sqrt(m)));
  const rng = makeRng(seed);
  const out: number[] = [];
  while (out.length < m) {
    const start = Math.floor(rng() * m);
    for (let o = 0; o < bl && out.length < m; o += 1) {
      out.push(rets[(start + o) % m]);
    }
  }
  const surr = new Array<number>(n);
  surr[0] = closes[0];
  for (let i = 1; i < n; i += 1) surr[i] = surr[i - 1] * Math.exp(out[i - 1]);
  return surr;
}

// ---------------------------------------------------------------------------
// small stats helpers
// ---------------------------------------------------------------------------
export function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
export function std(xs: number[], mean?: number): number {
  if (xs.length < 2) return 0;
  const m = mean ?? avg(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, v));
}
export function compound(xs: number[]): number {
  let lr = 0;
  for (const x of xs) {
    if (x <= -1) return -1;
    lr += Math.log1p(x);
  }
  return Math.expm1(lr);
}
export function annualizedSharpe(perBarSharpe: number, barsPerYear = 365): number {
  return perBarSharpe * Math.sqrt(barsPerYear);
}
/** lag-1 autocorrelation of a series */
export function autocorr1(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = avg(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) den += (xs[i] - m) ** 2;
  for (let i = 1; i < n; i += 1) num += (xs[i] - m) * (xs[i - 1] - m);
  return den > 0 ? num / den : 0;
}
