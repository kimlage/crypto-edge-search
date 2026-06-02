/**
 * D1-03 Supertrend (ATR-band stop-and-reverse trend overlay) — strongest honest version.
 *
 * Belief (folklore): Supertrend gives the "cleanest" trend flip. Long while close is above the
 * lower ATR band; flip short/flat when it crosses below the upper band, and vice versa.
 *
 * Strongest honest mechanism we can defend: Supertrend is a volatility-scaled trend channel
 * (Keltner/Donchian hybrid). The only honest source of edge over buy-&-hold is time-series
 * momentum (TSMOM) realized through a low-turnover, vol-aware filter. We give it every fair
 * advantage:
 *   - 8 majors (cross-sectional diversification of an idiosyncratic-noise overlay).
 *   - long/flat AND long/short variants.
 *   - vol-target the per-coin position so the book is risk-balanced (TSMOM is strongest vol-scaled).
 *   - equal-risk aggregate across coins -> a single daily book return.
 *   - causal everything (ATR, bands, flips use only past+current close; positions act next day).
 *
 * Costs: 4 bps taker per side charged on every change of signed position size (turnover).
 *
 * Gates (committed harness, src/lib/training/statistical-validation.ts):
 *   - Net-of-cost annualized Sharpe; monthly % and $ at $100k.
 *   - Key control BASELINE: must beat buy-&-hold (long-beta) on the SAME book of coins, net of a
 *     one-time entry cost — this is the decisive control for any trend overlay.
 *   - Deflated Sharpe @ HONEST N (= every config tried across the full sweep).
 *   - Block-bootstrap CI on mean daily net return.
 *   - CSCV/PBO across all swept configs.
 *   - RIGHT surrogate null (vol-preserving): stationary block-bootstrap of each coin's daily LOG
 *     RETURNS (block length ~ 20d preserves vol clustering / GARCH-like structure & fat tails),
 *     rebuild the price path, RECOMPUTE Supertrend on the surrogate, re-run the full book net of
 *     cost. If the overlay "works" on vol-preserving surrogates, the edge is a path artifact.
 *
 * Honest N counts the full Cartesian sweep {atrPeriod x multiplier x side x volTarget x emaConfirm}.
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
  return raw.filter(
    (b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0,
  );
}

// align all symbols on a common date axis (union of dates; per-coin gaps left as null)
const perSym: Record<string, Bar[]> = {};
for (const s of SYMBOLS) perSym[s] = loadSymbol(s);
const allDates = Array.from(
  new Set(SYMBOLS.flatMap((s) => perSym[s].map((b) => b.date))),
).sort();
const DATES = allDates;
const T = DATES.length;
const dateIdx = new Map(DATES.map((d, i) => [d, i]));

// barAt[sym][t] = Bar | null
const barAt: Record<string, (Bar | null)[]> = {};
for (const s of SYMBOLS) {
  const arr: (Bar | null)[] = Array<Bar | null>(T).fill(null);
  for (const b of perSym[s]) {
    const i = dateIdx.get(b.date);
    if (i != null) arr[i] = b;
  }
  barAt[s] = arr;
}

// daily log return per symbol on the common axis (close-to-close where both available)
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

// ----------------------- Supertrend (causal) -----------------------

function ema(prev: number, x: number, period: number): number {
  const k = 2 / (period + 1);
  return prev + k * (x - prev);
}

/**
 * Causal Supertrend signed signal in {+1, 0, -1} per bar, computed on a coin's bar series.
 * Returns position array aligned to the bar array (null where no bar). Position at index t is the
 * signal FORMED at the close of t; it is applied to the t->t+1 return (no look-ahead).
 */
function supertrendSignal(
  bars: (Bar | null)[],
  atrPeriod: number,
  mult: number,
  side: "longflat" | "longshort",
  emaConfirm: number, // 0 = off; else require close above/below EMA(emaConfirm) to allow long/short
): (number | null)[] {
  const n = bars.length;
  const sig: (number | null)[] = Array<number | null>(n).fill(null);

  let atr = NaN; // Wilder ATR
  let prevClose = NaN;
  let finalUpper = NaN;
  let finalLower = NaN;
  let trendUp = true; // current Supertrend direction
  let emaVal = NaN;
  let warm = 0;

  for (let t = 0; t < n; t++) {
    const b = bars[t];
    if (!b) {
      // gap: hold previous state, emit null (no position when no bar)
      continue;
    }
    // true range
    let tr: number;
    if (!Number.isFinite(prevClose)) tr = b.high - b.low;
    else
      tr = Math.max(
        b.high - b.low,
        Math.abs(b.high - prevClose),
        Math.abs(b.low - prevClose),
      );
    // Wilder ATR
    if (!Number.isFinite(atr)) atr = tr;
    else atr = (atr * (atrPeriod - 1) + tr) / atrPeriod;

    // EMA confirm filter
    if (emaConfirm > 0) {
      if (!Number.isFinite(emaVal)) emaVal = b.close;
      else emaVal = ema(emaVal, b.close, emaConfirm);
    }

    const hl2 = (b.high + b.low) / 2;
    const basicUpper = hl2 + mult * atr;
    const basicLower = hl2 - mult * atr;

    // final bands (causal recursion)
    if (!Number.isFinite(finalUpper)) {
      finalUpper = basicUpper;
      finalLower = basicLower;
    } else {
      finalUpper =
        basicUpper < finalUpper || prevClose > finalUpper
          ? basicUpper
          : finalUpper;
      finalLower =
        basicLower > finalLower || prevClose < finalLower
          ? basicLower
          : finalLower;
    }

    // trend flip on close cross
    if (trendUp) {
      if (b.close < finalLower) trendUp = false;
    } else {
      if (b.close > finalUpper) trendUp = true;
    }

    warm++;
    prevClose = b.close;

    if (warm <= atrPeriod + 1) {
      sig[t] = 0; // warmup
      continue;
    }

    let s = 0;
    if (trendUp) s = 1;
    else s = side === "longshort" ? -1 : 0;

    // EMA confirm: suppress long if below EMA, suppress short if above EMA
    if (emaConfirm > 0 && Number.isFinite(emaVal)) {
      if (s > 0 && b.close < emaVal) s = 0;
      if (s < 0 && b.close > emaVal) s = 0;
    }
    sig[t] = s;
  }
  return sig;
}

// trailing realized vol of a coin's log returns up to (and including) t-1, annualized->daily target use
function trailingVol(s: string, t: number, win: number): number {
  const r = logret[s];
  const vals: number[] = [];
  for (let k = Math.max(1, t - win); k < t; k++) {
    const v = r[k];
    if (v != null) vals.push(v);
  }
  if (vals.length < 10) return NaN;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varr =
    vals.reduce((a, x) => a + (x - m) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(Math.max(0, varr));
}

// ----------------------- book backtest -----------------------

interface Config {
  atrPeriod: number;
  mult: number;
  side: "longflat" | "longshort";
  volTarget: number; // per-coin annualized vol target (0 = no vol scaling, raw signed unit)
  emaConfirm: number;
  volWin: number;
}

interface BookResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number[];
  nActiveDays: number;
}

const VOL_CAP = 3; // cap per-coin leverage from vol-scaling

/**
 * Run the equal-risk book. signalFn(sym) returns the per-bar signed signal array (aligned to the
 * common date axis) for that symbol. We size each coin's position by vol-target, average across
 * coins available that day, and net costs on position changes.
 */
function runBook(
  cfg: Config,
  signalBySym: Record<string, (number | null)[]>,
): BookResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  const turnoverArr: number[] = [];

  // previous applied signed weight per coin
  const prevW: Record<string, number> = {};
  for (const s of SYMBOLS) prevW[s] = 0;

  const dailyTargetVol = cfg.volTarget / Math.sqrt(365);

  for (let t = 1; t < T; t++) {
    // form desired weights using signal at t-1 (acts on t-1 -> t return), vol-scaled by info up to t-1
    let grossBook = 0;
    let turnover = 0;
    let activeCoins = 0;
    const newW: Record<string, number> = {};

    for (const s of SYMBOLS) {
      const sigArr = signalBySym[s];
      const sig = sigArr[t - 1];
      const r = logret[s][t];
      let w = 0;
      if (sig != null && sig !== 0) {
        if (cfg.volTarget > 0) {
          const v = trailingVol(s, t, cfg.volWin);
          if (Number.isFinite(v) && v > 1e-9) {
            w = sig * Math.min(VOL_CAP, dailyTargetVol / v);
          } else {
            w = 0;
          }
        } else {
          w = sig;
        }
      }
      newW[s] = w;
      // turnover from change in signed weight
      turnover += Math.abs(w - (prevW[s] ?? 0));
      // gross book return contribution (simple return approx via logret for small daily moves)
      if (r != null && w !== 0) grossBook += w * (Math.exp(r) - 1);
      if (w !== 0) activeCoins++;
    }

    // normalize the book to average exposure across the 8 coins (equal-risk budget)
    const denom = SYMBOLS.length;
    const grossNorm = grossBook / denom;
    const turnoverNorm = turnover / denom;
    const cost = turnoverNorm * COST_PER_SIDE;

    dailyGross.push(grossNorm);
    dailyNet.push(grossNorm - cost);
    turnoverArr.push(turnoverNorm);

    for (const s of SYMBOLS) prevW[s] = newW[s];
    void activeCoins;
  }

  return {
    dailyNet,
    dailyGross,
    turnover: turnoverArr,
    nActiveDays: dailyNet.length,
  };
}

// buy-and-hold book baseline: equal-weight long the same 8 coins, vol-scaled identically, one-time entry cost
function buyHoldBook(cfg: Config): BookResult {
  const flatSig: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS) {
    const arr: (number | null)[] = Array<number | null>(T).fill(null);
    let started = false;
    for (let t = 0; t < T; t++) {
      if (barAt[s][t]) started = true;
      arr[t] = started ? 1 : 0;
    }
    flatSig[s] = arr;
  }
  return runBook(cfg, flatSig);
}

function annualizeSharpe(dailySharpe: number): number {
  return dailySharpe * Math.sqrt(365);
}

// ----------------------- HONEST N sweep -----------------------

const atrPeriods = [7, 10, 14, 21];
const mults = [1.5, 2, 3];
const sides: Config["side"][] = ["longflat", "longshort"];
const volTargets = [0, 0.4]; // raw signed, and vol-targeted
const emaConfirms = [0, 100, 200];
const volWin = 30;

const configs: Config[] = [];
for (const ap of atrPeriods)
  for (const m of mults)
    for (const sd of sides)
      for (const vt of volTargets)
        for (const ec of emaConfirms)
          configs.push({
            atrPeriod: ap,
            mult: m,
            side: sd,
            volTarget: vt,
            emaConfirm: ec,
            volWin,
          });

const HONEST_N = configs.length;

// precompute signals per config (cache by signal-determining params only)
function signalsFor(cfg: Config): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS) {
    out[s] = supertrendSignal(
      barAt[s],
      cfg.atrPeriod,
      cfg.mult,
      cfg.side,
      cfg.emaConfirm,
    );
  }
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
  const sigs = signalsFor(cfg);
  const res = runBook(cfg, sigs);
  const sNet = summarizeReturnSeries(res.dailyNet);
  const sGross = summarizeReturnSeries(res.dailyGross);
  const avgTurnover =
    res.turnover.reduce((a, b) => a + b, 0) /
    Math.max(1, res.turnover.filter((x) => x > 0).length);
  return {
    cfg,
    label: `atr${cfg.atrPeriod}_m${cfg.mult}_${cfg.side}_vt${cfg.volTarget}_ema${cfg.emaConfirm}`,
    res,
    netSharpeAnn: annualizeSharpe(sNet.sharpe),
    grossSharpeAnn: annualizeSharpe(sGross.sharpe),
    meanDailyNet: sNet.mean,
    avgTurnover,
  };
});

scored.sort((a, b) => b.netSharpeAnn - a.netSharpeAnn);
const best = scored[0];

// ----------------------- buy-and-hold baseline (key control) -----------------------
// Compare against buy-&-hold using the SAME vol-target as best config (so risk is matched).
const bhCfg: Config = { ...best.cfg, side: "longflat" };
const bh = buyHoldBook(bhCfg);
const bhNet = summarizeReturnSeries(bh.dailyNet);
const bhSharpeAnn = annualizeSharpe(bhNet.sharpe);

// also a raw equal-weight long (no vol scaling) buy-&-hold for context
const bhRawCfg: Config = { ...best.cfg, side: "longflat", volTarget: 0 };
const bhRaw = buyHoldBook(bhRawCfg);
const bhRawSharpeAnn = annualizeSharpe(summarizeReturnSeries(bhRaw.dailyNet).sharpe);

// ----------------------- gates on best config -----------------------
const bestNet = best.res.dailyNet;
const nDays = bestNet.length;
const yearsCovered = nDays / 365;

const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });

// Deflated Sharpe vs buy-&-hold benchmark Sharpe (does it beat long-beta after deflation?)
const dsrVsBH = computeDeflatedSharpeRatio(bestNet, {
  trialCount: HONEST_N,
  benchmarkSharpe: bhNet.sharpe, // daily-scale benchmark
});

const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 15,
  confidenceLevel: 0.95,
  seed: "supertrend-best",
});

// excess over buy-&-hold: paired daily difference (book net - bh net), bootstrap its mean > 0
const excess: number[] = [];
for (let i = 0; i < bestNet.length; i++) excess.push(bestNet[i] - bh.dailyNet[i]);
const bbExcess = blockBootstrapConfidenceInterval(excess, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 15,
  confidenceLevel: 0.95,
  seed: "supertrend-excess",
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

// ----------------------- RIGHT surrogate null: vol-preserving block bootstrap -----------------------
// Stationary block bootstrap of each coin's daily LOG RETURNS (block ~20d preserves vol clustering
// & fat tails). Rebuild price path, RECOMPUTE Supertrend on the surrogate, re-run the full book net
// of cost for the BEST config. Observed net Sharpe must beat this distribution.

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

// stationary bootstrap indices (Politis-Romano) over a coin's valid-return index list
function stationaryBootstrap(
  validIdx: number[],
  length: number,
  meanBlock: number,
  rng: () => number,
): number[] {
  const out: number[] = [];
  const m = validIdx.length;
  if (m === 0) return out;
  let pos = Math.floor(rng() * m);
  for (let i = 0; i < length; i++) {
    out.push(validIdx[pos]);
    if (rng() < 1 / meanBlock) pos = Math.floor(rng() * m);
    else pos = (pos + 1) % m;
  }
  return out;
}

/**
 * Build a surrogate Bar series for a coin: resample its daily log returns (vol-preserving), then
 * reconstruct OHLC. We keep the realized intrabar geometry (high/low/open offsets relative to close)
 * attached to each sampled return-day so ATR/TR keeps a realistic shape; only the SEQUENCE (and thus
 * any genuine trend/serial structure) is destroyed while vol clustering is preserved by blocks.
 */
function surrogateBars(sym: string, rng: () => number): (Bar | null)[] {
  const arr = barAt[sym];
  // collect valid consecutive-day indices (where logret defined) plus geometry ratios
  const validIdx: number[] = [];
  for (let t = 1; t < T; t++) if (logret[sym][t] != null) validIdx.push(t);
  if (validIdx.length < 50) return Array<Bar | null>(T).fill(null);

  // geometry per index: ratios of (open,high,low) to close, in log space relative to that day's close
  const geom = validIdx.map((t) => {
    const b = arr[t]!;
    return {
      r: logret[sym][t]!,
      hi: Math.log(b.high / b.close),
      lo: Math.log(b.low / b.close),
      op: Math.log(b.open / b.close),
    };
  });

  const firstBar = arr[validIdx[0] - 1] ?? arr[validIdx[0]]!;
  const startPrice = firstBar.close;
  const sampled = stationaryBootstrap(
    geom.map((_, i) => i),
    validIdx.length,
    20,
    rng,
  );

  const out: (Bar | null)[] = Array<Bar | null>(T).fill(null);
  let close = startPrice;
  // place surrogate bars on the same calendar slots as the valid indices (preserve length/timing)
  for (let i = 0; i < validIdx.length; i++) {
    const t = validIdx[i];
    const g = geom[sampled[i]];
    close = close * Math.exp(g.r);
    const c = close;
    const high = c * Math.exp(g.hi);
    const low = c * Math.exp(g.lo);
    const open = c * Math.exp(g.op);
    out[t] = {
      date: DATES[t],
      open: Math.max(1e-9, open),
      high: Math.max(high, c, open),
      low: Math.min(low, c, open),
      close: c,
    };
  }
  return out;
}

// surrogate book: recompute supertrend on surrogate bars; reuse REAL logret? No — we must use the
// surrogate's own returns for the book, because the signal is computed on the surrogate path.
function surrogateBookSharpe(cfg: Config, seed: number): number {
  const surBars: Record<string, (Bar | null)[]> = {};
  const surLogret: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS) {
    const rng = mkRng(seed + s.charCodeAt(0) * 131 + s.charCodeAt(1) * 17);
    const sb = surrogateBars(s, rng);
    surBars[s] = sb;
    const r: (number | null)[] = Array<number | null>(T).fill(null);
    for (let t = 1; t < T; t++) {
      // surrogate bars are placed on valid slots; compute close/close where both present
      // find previous present bar
      const cur = sb[t];
      if (!cur) continue;
      // previous present
      let p = t - 1;
      while (p >= 0 && !sb[p]) p--;
      if (p >= 0 && sb[p]) r[t] = Math.log(cur.close / sb[p]!.close);
    }
    surLogret[s] = r;
  }

  // build signals + book inline using surrogate series (local copies of logret-dependent funcs)
  const sigs: Record<string, (number | null)[]> = {};
  for (const s of SYMBOLS)
    sigs[s] = supertrendSignal(surBars[s], cfg.atrPeriod, cfg.mult, cfg.side, cfg.emaConfirm);

  // inline runBook using surLogret + surBars trailing vol
  const dailyNet: number[] = [];
  const prevW: Record<string, number> = {};
  for (const s of SYMBOLS) prevW[s] = 0;
  const dailyTargetVol = cfg.volTarget / Math.sqrt(365);

  function surTrailingVol(s: string, t: number, win: number): number {
    const r = surLogret[s];
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

  for (let t = 1; t < T; t++) {
    let grossBook = 0;
    let turnover = 0;
    const newW: Record<string, number> = {};
    for (const s of SYMBOLS) {
      const sig = sigs[s][t - 1];
      const r = surLogret[s][t];
      let w = 0;
      if (sig != null && sig !== 0) {
        if (cfg.volTarget > 0) {
          const v = surTrailingVol(s, t, cfg.volWin);
          if (Number.isFinite(v) && v > 1e-9) w = sig * Math.min(VOL_CAP, dailyTargetVol / v);
        } else w = sig;
      }
      newW[s] = w;
      turnover += Math.abs(w - (prevW[s] ?? 0));
      if (r != null && w !== 0) grossBook += w * (Math.exp(r) - 1);
    }
    const denom = SYMBOLS.length;
    const cost = (turnover / denom) * COST_PER_SIDE;
    dailyNet.push(grossBook / denom - cost);
    for (const s of SYMBOLS) prevW[s] = newW[s];
  }
  return annualizeSharpe(summarizeReturnSeries(dailyNet).sharpe);
}

const N_SURR = 200;
const surr: number[] = [];
for (let i = 0; i < N_SURR; i++) {
  surr.push(surrogateBookSharpe(best.cfg, 7000 + i * 9973));
}
surr.sort((a, b) => a - b);
const surrMean = surr.reduce((a, b) => a + b, 0) / surr.length;
const surrP = (surr.filter((s) => s >= best.netSharpeAnn).length + 1) / (N_SURR + 1);
const surr95 = surr[Math.floor(N_SURR * 0.95)];

// ----------------------- monthly $ -----------------------
const monthlyPct = best.meanDailyNet * 30;
const monthlyAt100k = monthlyPct * 100000;

function round(x: number, d = 3): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

// ----------------------- verdict -----------------------
const passDSR = dsr.deflatedProbability > 0.95;
const passDSRvsBH = dsrVsBH.deflatedProbability > 0.95;
const passBootstrap = bb.lower > 0;
const passExcessVsBH = bbExcess.lower > 0;
const passPBO = pbo.pbo < 0.5;
const passSurrogate = surrP < 0.05;
const beatsBH = best.netSharpeAnn > bhSharpeAnn;

const gatesPassed = [
  passDSR,
  passDSRvsBH,
  passBootstrap,
  passExcessVsBH,
  passPBO,
  passSurrogate,
  beatsBH,
];
const allPass = gatesPassed.every(Boolean);

// binding gate = first failing
const gateNames = [
  ["deflatedSharpe@N", passDSR],
  ["deflatedSharpe-vs-buyHold", passDSRvsBH],
  ["bootstrapMeanNet>0", passBootstrap],
  ["excess-vs-buyHold>0", passExcessVsBH],
  ["cscvPBO<0.5", passPBO],
  ["surrogateNull-p<0.05", passSurrogate],
  ["beats-buy&hold-Sharpe", beatsBH],
] as const;
const binding = gateNames.find(([, p]) => !p)?.[0] ?? "none";

const report = {
  hypothesis: "D1-03 Supertrend (ATR-band trend overlay), 8-major equal-risk book",
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
  baselineBuyHold: {
    netSharpeAnnual_volMatched: round(bhSharpeAnn),
    netSharpeAnnual_rawEW: round(bhRawSharpeAnn),
    beatsBuyHold: beatsBH,
  },
  gates: {
    deflatedSharpe: {
      trialCount: dsr.trialCount,
      sharpeDaily: round(dsr.sharpe, 4),
      expectedMaxSharpeDaily: round(dsr.expectedMaxSharpe, 4),
      deflatedProbability: round(dsr.deflatedProbability, 4),
      pass: passDSR,
    },
    deflatedSharpeVsBuyHold: {
      benchmarkSharpeDaily: round(bhNet.sharpe, 4),
      deflatedProbability: round(dsrVsBH.deflatedProbability, 4),
      pass: passDSRvsBH,
    },
    blockBootstrapMeanDailyNet: {
      estimate: bb.estimate,
      lower: bb.lower,
      upper: bb.upper,
      pass: passBootstrap,
    },
    excessOverBuyHold: {
      estimate: bbExcess.estimate,
      lower: bbExcess.lower,
      upper: bbExcess.upper,
      pass: passExcessVsBH,
    },
    cscvPbo: { pbo: round(pbo.pbo, 4), medianLogit: round(pbo.medianLogit, 4), pass: passPBO },
    surrogateNull_volPreserving: {
      observedNetSharpeAnn: round(best.netSharpeAnn),
      surrogateMeanSharpe: round(surrMean),
      surrogate95th: round(surr95),
      pValue: round(surrP, 4),
      nSurrogates: N_SURR,
      pass: passSurrogate,
    },
  },
  verdict: allPass ? "SURVIVE/PROMISING" : "KILL",
  bindingGate: binding,
  topConfigs: scored.slice(0, 12).map((s) => ({
    label: s.label,
    netSharpe: round(s.netSharpeAnn),
    grossSharpe: round(s.grossSharpeAnn),
    avgTurnover: round(s.avgTurnover, 4),
  })),
};

fs.mkdirSync(`${ROOT}/output/edgehunt-D1`, { recursive: true });
fs.writeFileSync(
  `${ROOT}/output/edgehunt-D1/supertrend-report.json`,
  JSON.stringify(report, null, 2),
);

console.log(JSON.stringify(report, null, 2));
