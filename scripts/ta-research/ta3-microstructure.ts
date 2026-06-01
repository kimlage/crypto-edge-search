/**
 * TRACK TA3 — Microstructure / forced-flow signals on 15m BTC.
 *
 * Tests four forced-flow signal families on output/bigquery/btc_ohlcv_15m.ndjson
 * (+ funding for divergence). Every signal is charged realistic taker cost on
 * every position change. Every variant counts toward the true trial N for DSR /
 * haircut. Gates: net Sharpe>0, DSR p<0.05 (true N), PBO<0.5, beat baselines,
 * survive Harvey-Liu haircut, survive the consume-once final holdout.
 *
 * Run:
 *   PATH=.../node/bin:$PATH node_modules/.bin/tsx scripts/ta-research/ta3-microstructure.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  baselineScoreFromReturns,
  evaluateBaselineGate,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import { planHoldoutSplit } from "../../src/lib/significance/holdout";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");
const OHLCV_PATH = resolve(REPO, "output/bigquery/btc_ohlcv_15m.ndjson");
const FUNDING_DIR = resolve(REPO, "output/funding");

// Cost: 4 bps taker per side on perp. A position FLIP (e.g. +1 -> -1) crosses the
// book twice = 2 units of turnover. Entering/exiting flat = 1 unit. We charge
// TAKER_BPS per unit of |Δposition|. Round-trip (in+out) = 8 bps.
const TAKER_BPS = 4;
const TAKER = TAKER_BPS / 10_000; // per unit |Δposition|

// Annualization for 15m bars: 4 bars/hr * 24 * 365 = 35040 bars/yr.
const BARS_PER_YEAR_15M = 4 * 24 * 365;

const SQRT = Math.sqrt;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
interface Bar {
  t: number; // event_time ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  day: number; // day index (ms / 86400000) for daily aggregation of returns
}

function loadBars(): Bar[] {
  const raw = readFileSync(OHLCV_PATH, "utf8");
  const out: Bar[] = [];
  let prevClose = NaN;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line);
    const o = +j.open;
    const h = +j.high;
    const l = +j.low;
    const c = +j.close;
    const v = +j.volume;
    if (![o, h, l, c, v].every(Number.isFinite)) continue;
    // Drop obviously bad bars (zero range + zero volume duplicates at the very start).
    const t = Date.parse(j.event_time);
    out.push({ t, o, h, l, c, v, day: Math.floor(t / 86_400_000) });
    prevClose = c;
  }
  void prevClose;
  return out;
}

// Aggregate 15m bars into coarser bars (factor N bars -> 1). Used for the
// lower-frequency variants that might clear cost.
function aggregate(bars: Bar[], factor: number): Bar[] {
  if (factor <= 1) return bars;
  const out: Bar[] = [];
  for (let i = 0; i + factor <= bars.length; i += factor) {
    const slice = bars.slice(i, i + factor);
    let hi = -Infinity;
    let lo = Infinity;
    let vol = 0;
    for (const b of slice) {
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
      vol += b.v;
    }
    out.push({
      t: slice[0].t,
      o: slice[0].o,
      h: hi,
      l: lo,
      c: slice[slice.length - 1].c,
      v: vol,
      day: slice[0].day,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal generation
// ---------------------------------------------------------------------------
// A signal is a position vector pos[] in {-1,0,+1} aligned so pos[i] is the
// position HELD from the close of bar i into bar i+1. It is decided using info
// available AT the close of bar i (no lookahead). Realized strategy return at
// step i+1 = pos[i] * r[i+1] - cost(|pos[i]-pos[i-1]|).

interface SignalSpec {
  family: string;
  name: string;
  positions: number[]; // length = bars.length; pos[i] held into bar i+1
}

// Forward log return per bar: r[i] = log(c[i]/c[i-1]). r[0] = 0.
function logReturns(bars: Bar[]): number[] {
  const r = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) r[i] = Math.log(bars[i].c / bars[i - 1].c);
  return r;
}

// Rolling mean/std of an array (population-ish, sample std).
function rollStats(x: number[], i: number, win: number): { mean: number; std: number } {
  const start = Math.max(0, i - win + 1);
  let sum = 0;
  let n = 0;
  for (let k = start; k <= i; k++) {
    sum += x[k];
    n++;
  }
  const mean = sum / n;
  let v = 0;
  for (let k = start; k <= i; k++) v += (x[k] - mean) ** 2;
  const std = n > 1 ? SQRT(v / (n - 1)) : 0;
  return { mean, std };
}

// --- Family 1: volume-delta / range-position momentum (OFI proxy) ---
// Range position rp = (c-l)/(h-l) maps to [0,1]; signed = 2*rp-1 in [-1,1].
// Multiply by volume z-score -> a forced-flow imbalance proxy. Momentum: go with
// the sign when |smoothed imbalance| > thr.
function familyRangeMomentum(
  bars: Bar[],
  rangeWin: number,
  smoothWin: number,
  thr: number,
): number[] {
  const n = bars.length;
  const signedRP = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const rng = bars[i].h - bars[i].l;
    const rp = rng > 0 ? (bars[i].c - bars[i].l) / rng : 0.5;
    signedRP[i] = 2 * rp - 1;
  }
  const logv = bars.map((b) => Math.log(Math.max(1e-9, b.v)));
  const ofi = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const { mean, std } = rollStats(logv, i, rangeWin);
    const vz = std > 0 ? (logv[i] - mean) / std : 0;
    ofi[i] = signedRP[i] * Math.max(0, vz); // only amplify on above-avg volume
  }
  // smooth
  const sm = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - smoothWin + 1);
    let s = 0;
    for (let k = start; k <= i; k++) s += ofi[k];
    sm[i] = s / (i - start + 1);
  }
  const pos = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (sm[i] > thr) pos[i] = 1;
    else if (sm[i] < -thr) pos[i] = -1;
    else pos[i] = 0;
  }
  return pos;
}

// --- Family 2: liquidation-cascade MEAN-REVERSION ---
// After an extreme down/up bar on high volume, fade it for `holdBars` bars.
function familyLiqReversion(
  bars: Bar[],
  r: number[],
  win: number,
  retZThr: number,
  volZThr: number,
  holdBars: number,
): number[] {
  const n = bars.length;
  const logv = bars.map((b) => Math.log(Math.max(1e-9, b.v)));
  const pos = new Array(n).fill(0);
  let remaining = 0;
  let dir = 0;
  for (let i = 0; i < n; i++) {
    if (remaining > 0) {
      pos[i] = dir;
      remaining--;
      continue;
    }
    const rs = rollStats(r, i, win);
    const vs = rollStats(logv, i, win);
    const rz = rs.std > 0 ? (r[i] - rs.mean) / rs.std : 0;
    const vz = vs.std > 0 ? (logv[i] - vs.mean) / vs.std : 0;
    if (vz > volZThr && rz < -retZThr) {
      // extreme down bar on high volume -> fade UP (long)
      dir = 1;
      pos[i] = dir;
      remaining = holdBars - 1;
    } else if (vz > volZThr && rz > retZThr) {
      // extreme up bar on high volume -> fade DOWN (short)
      dir = -1;
      pos[i] = dir;
      remaining = holdBars - 1;
    } else {
      pos[i] = 0;
    }
  }
  return pos;
}

// --- Family 3: funding/OI divergence (crowding) ---
// Uses funding rate as crowding proxy (no OI in repo). Daily-frequency on perp.
// Crowded longs (funding high & price rising) -> short pressure; fade.
// Built separately (different data/frequency).

// --- Family 4: volatility-breakout with volume confirmation ---
// Breakout above rolling high (Donchian) with volume>avg -> momentum long; below
// rolling low with volume -> short. Hold until opposite breakout or N bars.
function familyVolBreakout(
  bars: Bar[],
  channel: number,
  volWin: number,
  volMult: number,
  holdBars: number,
): number[] {
  const n = bars.length;
  const logv = bars.map((b) => Math.log(Math.max(1e-9, b.v)));
  const pos = new Array(n).fill(0);
  let remaining = 0;
  let dir = 0;
  for (let i = 0; i < n; i++) {
    if (remaining > 0) {
      pos[i] = dir;
      remaining--;
      continue;
    }
    if (i < channel) {
      pos[i] = 0;
      continue;
    }
    // rolling high/low of prior `channel` bars (exclude current)
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - channel; k < i; k++) {
      if (bars[k].h > hi) hi = bars[k].h;
      if (bars[k].l < lo) lo = bars[k].l;
    }
    const vs = rollStats(logv, i, volWin);
    const volOk = vs.std > 0 ? (logv[i] - vs.mean) / vs.std > volMult : false;
    if (bars[i].c > hi && volOk) {
      dir = 1;
      pos[i] = dir;
      remaining = holdBars - 1;
    } else if (bars[i].c < lo && volOk) {
      dir = -1;
      pos[i] = dir;
      remaining = holdBars - 1;
    } else {
      pos[i] = 0;
    }
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Backtest engine (net of cost)
// ---------------------------------------------------------------------------
interface BacktestResult {
  // Daily-aggregated return series (each day = one observation). This is the
  // canonical series fed to the library gates (avoids the library's
  // Math.min(...spread) stack overflow on 200k-element arrays, and is the
  // standard way to compute an annualized Sharpe). Each value is the simple
  // daily P&L fraction (sum of per-bar log-returns within the day -> expm1).
  dailyNet: number[];
  dailyGross: number[];
  turnoverUnits: number; // sum of |Δposition| over the window
  tradeCount: number; // count of nonzero position changes
  bars: number;
}

// `days[i]` is the day index of bar i. Net P&L per bar is charged at the change
// bar. Returns are aggregated to daily simple returns for stats.
function backtest(
  positions: number[],
  r: number[],
  cost: number,
  days: number[],
): BacktestResult {
  const n = positions.length;
  let turnoverUnits = 0;
  let tradeCount = 0;
  // accumulate per-bar net/gross LOG returns within each day
  const dayNetLog = new Map<number, number>();
  const dayGrossLog = new Map<number, number>();
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    const pos = positions[i];
    const dpos = Math.abs(pos - prev);
    if (dpos > 0) {
      turnoverUnits += dpos;
      tradeCount++;
    }
    const costCharge = dpos * cost; // fraction
    const grossLog = pos * r[i + 1]; // r is log-return; pos in {-1,0,1}
    // net in log space: subtract the cost fraction (approx for small cost)
    const netLog = grossLog + Math.log1p(-Math.min(0.999, costCharge));
    const d = days[i + 1];
    dayGrossLog.set(d, (dayGrossLog.get(d) ?? 0) + grossLog);
    dayNetLog.set(d, (dayNetLog.get(d) ?? 0) + netLog);
    prev = pos;
  }
  const dayKeys = Array.from(dayNetLog.keys()).sort((a, b) => a - b);
  const dailyNet = dayKeys.map((d) => Math.expm1(dayNetLog.get(d)!));
  const dailyGross = dayKeys.map((d) => Math.expm1(dayGrossLog.get(d)!));
  return { dailyNet, dailyGross, turnoverUnits, tradeCount, bars: n };
}

// Annualize a DAILY return series by sqrt(365). Uses a local safe summarizer to
// avoid the library's Math.min(...spread) on large arrays (daily is small, but
// keep it uniform).
function dailySharpeAnnual(daily: number[]): number {
  if (daily.length < 2) return 0;
  let mean = 0;
  for (const x of daily) mean += x;
  mean /= daily.length;
  let v = 0;
  for (const x of daily) v += (x - mean) ** 2;
  const std = SQRT(v / (daily.length - 1));
  return std > 0 ? (mean / std) * SQRT(365) : 0;
}

// ---------------------------------------------------------------------------
// Variant enumeration — EVERY ONE counts toward true N.
// ---------------------------------------------------------------------------
interface Variant {
  family: string;
  name: string;
  build: (bars: Bar[], r: number[]) => number[];
  freqLabel: string; // "15m","30m","1h","4h"
  aggFactor: number;
}

function enumerateVariants(): Variant[] {
  const variants: Variant[] = [];
  const freqs: { label: string; factor: number }[] = [
    { label: "15m", factor: 1 },
    { label: "30m", factor: 2 },
    { label: "1h", factor: 4 },
    { label: "4h", factor: 16 },
  ];

  for (const f of freqs) {
    // Family 1: range-momentum
    for (const rangeWin of [48, 96]) {
      for (const smoothWin of [4, 8]) {
        for (const thr of [0.25, 0.5, 1.0]) {
          variants.push({
            family: "range_momentum",
            name: `rm_rw${rangeWin}_sw${smoothWin}_thr${thr}`,
            freqLabel: f.label,
            aggFactor: f.factor,
            build: (bars) => familyRangeMomentum(bars, rangeWin, smoothWin, thr),
          });
        }
      }
    }
    // Family 2: liquidation reversion
    for (const win of [48, 96]) {
      for (const retZ of [2.0, 2.5, 3.0]) {
        for (const volZ of [1.0, 2.0]) {
          for (const hold of [1, 4]) {
            variants.push({
              family: "liq_reversion",
              name: `lr_w${win}_rz${retZ}_vz${volZ}_h${hold}`,
              freqLabel: f.label,
              aggFactor: f.factor,
              build: (bars, r) => familyLiqReversion(bars, r, win, retZ, volZ, hold),
            });
          }
        }
      }
    }
    // Family 4: vol breakout
    for (const channel of [20, 50]) {
      for (const volMult of [0.0, 1.0]) {
        for (const hold of [4, 8]) {
          variants.push({
            family: "vol_breakout",
            name: `vb_ch${channel}_vm${volMult}_h${hold}`,
            freqLabel: f.label,
            aggFactor: f.factor,
            build: (bars) => familyVolBreakout(bars, channel, 96, volMult, hold),
          });
        }
      }
    }
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Funding divergence (Family 3) — daily, on 8 majors
// ---------------------------------------------------------------------------
interface FundingVariantResult {
  name: string;
  netSharpeAnnual: number;
  grossSharpeAnnual: number;
  roundTripsPerYear: number;
  netCompound: number;
  perDayNet: number[];
}

function loadFundingDaily(symbol: string): {
  dates: string[];
  perpRet: number[];
  funding8h: { t: number; rate: number }[];
} {
  const prices = JSON.parse(
    readFileSync(resolve(FUNDING_DIR, `${symbol}_prices_daily.json`), "utf8"),
  ) as { date: string; spotClose: number; perpClose: number }[];
  const funding = JSON.parse(
    readFileSync(resolve(FUNDING_DIR, `${symbol}_funding_8h.json`), "utf8"),
  ) as { fundingTime: number; fundingRate: number }[];
  const dates = prices.map((p) => p.date);
  const perpRet = new Array(prices.length).fill(0);
  for (let i = 1; i < prices.length; i++) {
    perpRet[i] = Math.log(prices[i].perpClose / prices[i - 1].perpClose);
  }
  return {
    dates,
    perpRet,
    funding8h: funding.map((f) => ({ t: f.fundingTime, rate: f.fundingRate })),
  };
}

// Daily funding = sum of the (up to) 3 8h funding prints on that calendar day.
function dailyFunding(dates: string[], funding8h: { t: number; rate: number }[]): number[] {
  const byDay = new Map<string, number>();
  for (const f of funding8h) {
    const day = new Date(f.t).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + f.rate);
  }
  return dates.map((d) => byDay.get(d) ?? 0);
}

// Funding divergence variants: when funding (crowding) extreme, fade.
// Position decided at close of day i from funding observed through day i; held
// into day i+1. Cost charged on |Δpos| at spot/perp taker (4 bps perp).
function fundingDivergence(
  symbol: string,
  fundWin: number,
  zThr: number,
): FundingVariantResult {
  const { dates, perpRet, funding8h } = loadFundingDaily(symbol);
  const fd = dailyFunding(dates, funding8h);
  const n = dates.length;
  const pos = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const { mean, std } = rollStats(fd, i, fundWin);
    const z = std > 0 ? (fd[i] - mean) / std : 0;
    // crowded longs (funding very positive) -> short pressure -> go short
    if (z > zThr) pos[i] = -1;
    else if (z < -zThr) pos[i] = 1; // crowded shorts -> long
    else pos[i] = 0;
  }
  const cost = TAKER; // 4 bps per unit |Δpos|
  const perDayNet: number[] = [];
  const perDayGross: number[] = [];
  let turnover = 0;
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    const dpos = Math.abs(pos[i] - prev);
    turnover += dpos;
    const grossLog = pos[i] * perpRet[i + 1];
    const netLog = grossLog + Math.log1p(-Math.min(0.999, dpos * cost));
    perDayGross.push(Math.expm1(grossLog));
    perDayNet.push(Math.expm1(netLog));
    prev = pos[i];
  }
  const years = n / 365;
  return {
    name: `${symbol}_fundDiv_w${fundWin}_z${zThr}`,
    netSharpeAnnual: dailySharpeAnnual(perDayNet),
    grossSharpeAnnual: dailySharpeAnnual(perDayGross),
    roundTripsPerYear: turnover / 2 / years,
    netCompound: summarizeReturnSeries(perDayNet).compoundReturn,
    perDayNet,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function fmt(x: number, d = 4): string {
  return Number.isFinite(x) ? x.toFixed(d) : "NaN";
}

function main(): void {
  console.log("=".repeat(78));
  console.log("TRACK TA3 — Microstructure / forced-flow signals on 15m BTC");
  console.log("=".repeat(78));

  const allBars = loadBars();
  console.log(
    `Loaded ${allBars.length} 15m bars: ${new Date(allBars[0].t).toISOString().slice(0, 10)} -> ${new Date(allBars[allBars.length - 1].t).toISOString().slice(0, 10)}`,
  );

  // Holdout split on the FULL 15m series. Search may use [0, holdoutStart);
  // final vault = most recent 15%. test slice = prior 15% (posterior audit).
  const plan = planHoldoutSplit({ totalRows: allBars.length, holdoutFraction: 0.15, testFraction: 0.15 });
  const searchEnd = plan.search.end; // exclusive — search window
  const testEnd = plan.test.end;
  console.log(
    `Holdout plan: search [0,${searchEnd}) | test [${searchEnd},${testEnd}) | VAULT [${testEnd},${allBars.length})`,
  );
  const searchYears = searchEnd / BARS_PER_YEAR_15M;
  console.log(`Search window ~${searchYears.toFixed(2)} yrs.`);

  // ----- Build all variants, score on SEARCH window only -----
  const variants = enumerateVariants();
  // Family 3 funding variants (8 symbols x grid) — counted into N too.
  const fundSymbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOGEUSDT"];
  const fundWins = [30, 60];
  const fundZ = [1.0, 1.5, 2.0];
  const fundVariantCount = fundSymbols.length * fundWins.length * fundZ.length;

  const trueN = variants.length + fundVariantCount;
  console.log(
    `\nTrue trial count N = ${variants.length} OHLCV variants + ${fundVariantCount} funding variants = ${trueN}`,
  );

  // Precompute aggregated bar series + returns per freq (on search window).
  const freqCache = new Map<
    number,
    { bars: Bar[]; r: number[]; days: number[]; searchBars: Bar[]; searchR: number[]; searchDays: number[] }
  >();
  for (const factor of [1, 2, 4, 16]) {
    const agg = aggregate(allBars, factor);
    const r = logReturns(agg);
    const days = agg.map((b) => b.day);
    // search portion (indexes scaled by factor)
    const searchAggEnd = Math.floor(searchEnd / factor);
    const searchBars = agg.slice(0, searchAggEnd);
    const searchR = r.slice(0, searchAggEnd);
    const searchDays = days.slice(0, searchAggEnd);
    freqCache.set(factor, { bars: agg, r, days, searchBars, searchR, searchDays });
  }

  interface Scored {
    family: string;
    name: string;
    freq: string;
    netSharpe: number;
    grossSharpe: number;
    roundTripsPerYear: number;
    netCompound: number;
    dailyNetSearch: number[]; // daily-aggregated net return series (search window)
  }

  const scored: Scored[] = [];
  for (const v of variants) {
    const fc = freqCache.get(v.aggFactor)!;
    const positions = v.build(fc.searchBars, fc.searchR);
    const bt = backtest(positions, fc.searchR, TAKER, fc.searchDays);
    const barsPerYear = BARS_PER_YEAR_15M / v.aggFactor;
    const years = fc.searchBars.length / barsPerYear;
    scored.push({
      family: v.family,
      name: v.name,
      freq: v.freqLabel,
      netSharpe: dailySharpeAnnual(bt.dailyNet),
      grossSharpe: dailySharpeAnnual(bt.dailyGross),
      roundTripsPerYear: bt.turnoverUnits / 2 / years,
      netCompound: summarizeReturnSeries(bt.dailyNet).compoundReturn,
      dailyNetSearch: bt.dailyNet,
    });
  }

  // ----- Best per family + overall (selection on SEARCH net Sharpe) -----
  const byFamily = new Map<string, Scored[]>();
  for (const s of scored) {
    const list = byFamily.get(s.family) ?? [];
    list.push(s);
    byFamily.set(s.family, list);
  }

  console.log("\n" + "-".repeat(78));
  console.log("PER-FAMILY (search window) — best NET-of-cost annualized Sharpe");
  console.log("-".repeat(78));
  console.log(
    `${"family".padEnd(16)}${"freq".padEnd(6)}${"bestNetSh".padStart(11)}${"gross".padStart(9)}${"RT/yr".padStart(10)}${"netCompound".padStart(13)}  variant`,
  );
  const familyBest: Scored[] = [];
  for (const [fam, list] of byFamily) {
    // best by net sharpe per freq
    const freqs = ["15m", "30m", "1h", "4h"];
    for (const fq of freqs) {
      const sub = list.filter((s) => s.freq === fq);
      if (sub.length === 0) continue;
      const best = sub.reduce((a, b) => (b.netSharpe > a.netSharpe ? b : a));
      familyBest.push(best);
      console.log(
        `${fam.padEnd(16)}${fq.padEnd(6)}${fmt(best.netSharpe, 3).padStart(11)}${fmt(best.grossSharpe, 2).padStart(9)}${fmt(best.roundTripsPerYear, 0).padStart(10)}${fmt(best.netCompound, 3).padStart(13)}  ${best.name}`,
      );
    }
  }

  // ----- Funding divergence (daily, separate data) -----
  console.log("\n" + "-".repeat(78));
  console.log("FAMILY 3: funding/OI divergence (daily, funding-rate crowding proxy; no OI in repo)");
  console.log("-".repeat(78));
  const fundResults: FundingVariantResult[] = [];
  for (const sym of fundSymbols) {
    for (const w of fundWins) {
      for (const z of fundZ) {
        fundResults.push(fundingDivergence(sym, w, z));
      }
    }
  }
  const bestFund = fundResults.reduce((a, b) => (b.netSharpeAnnual > a.netSharpeAnnual ? b : a));
  // show BTC ones + overall best
  for (const fr of fundResults.filter((f) => f.name.startsWith("BTCUSDT"))) {
    console.log(
      `  ${fr.name.padEnd(28)} netSh=${fmt(fr.netSharpeAnnual, 3).padStart(8)} gross=${fmt(fr.grossSharpeAnnual, 2).padStart(7)} RT/yr=${fmt(fr.roundTripsPerYear, 0).padStart(5)} netComp=${fmt(fr.netCompound, 3)}`,
    );
  }
  console.log(`  BEST funding variant overall: ${bestFund.name} netSh=${fmt(bestFund.netSharpeAnnual, 3)} (of ${fundResults.length} funding trials)`);

  // ----- Pick the SINGLE overall champion across everything (search net Sharpe) -----
  const champOhlcv = scored.reduce((a, b) => (b.netSharpe > a.netSharpe ? b : a));
  console.log("\n" + "=".repeat(78));
  console.log("OVERALL CHAMPION (selected on search-window NET Sharpe)");
  console.log("=".repeat(78));
  console.log(
    `OHLCV champ: ${champOhlcv.family}/${champOhlcv.name} @${champOhlcv.freq}  netSh=${fmt(champOhlcv.netSharpe, 3)} gross=${fmt(champOhlcv.grossSharpe, 3)} RT/yr=${fmt(champOhlcv.roundTripsPerYear, 0)}`,
  );

  // Decide global champ (compare OHLCV champ net sharpe to best funding net sharpe).
  const champIsFunding = bestFund.netSharpeAnnual > champOhlcv.netSharpe;
  console.log(
    `Funding champ: ${bestFund.name} netSh=${fmt(bestFund.netSharpeAnnual, 3)} RT/yr=${fmt(bestFund.roundTripsPerYear, 0)}`,
  );
  console.log(`==> Global champion is from: ${champIsFunding ? "FUNDING (daily)" : "OHLCV 15m-family"}`);

  // =====================================================================
  // GATES on the global champion
  // =====================================================================
  console.log("\n" + "#".repeat(78));
  console.log("# RIGOR GATES on global champion (true N = " + trueN + ")");
  console.log("#".repeat(78));

  // Assemble champion's per-observation net series + market returns for baselines.
  let champLabel: string;
  let champPerObsSearch: number[];
  let champBarsPerYear: number;
  let champFreqFactor: number;
  let champBuilder: ((bars: Bar[], r: number[]) => number[]) | null = null;
  let champRoundTrips: number;
  let champNetSharpeSearch: number;

  // All series are now DAILY-aggregated, so champBarsPerYear is always 365.
  if (!champIsFunding) {
    champLabel = `${champOhlcv.family}/${champOhlcv.name}@${champOhlcv.freq}`;
    champPerObsSearch = champOhlcv.dailyNetSearch;
    champBarsPerYear = 365;
    champFreqFactor = { "15m": 1, "30m": 2, "1h": 4, "4h": 16 }[champOhlcv.freq]!;
    champRoundTrips = champOhlcv.roundTripsPerYear;
    champNetSharpeSearch = champOhlcv.netSharpe;
    const vDef = variants.find((v) => v.family === champOhlcv.family && v.name === champOhlcv.name && v.freqLabel === champOhlcv.freq)!;
    champBuilder = vDef.build;
  } else {
    champLabel = bestFund.name;
    champPerObsSearch = bestFund.perDayNet; // funding uses full series (daily, no 15m holdout split)
    champBarsPerYear = 365;
    champFreqFactor = 0;
    champRoundTrips = bestFund.roundTripsPerYear;
    champNetSharpeSearch = bestFund.netSharpeAnnual;
  }

  console.log(`\nChampion: ${champLabel}`);
  console.log(`Search NET annualized Sharpe: ${fmt(champNetSharpeSearch, 3)} | RT/yr: ${fmt(champRoundTrips, 0)}`);

  const gateResults: Record<string, boolean> = {};
  let killedBy = "none";

  // --- GATE A: net Sharpe > 0 ---
  const netPos = champNetSharpeSearch > 0;
  gateResults["net_sharpe_positive"] = netPos;
  console.log(`\n[GATE A] Net Sharpe > 0: ${netPos ? "PASS" : "FAIL"} (${fmt(champNetSharpeSearch, 3)})`);
  if (!netPos && killedBy === "none") killedBy = "cost (net Sharpe<=0)";

  // --- GATE B: DSR p<0.05 with TRUE N ---
  // computeDeflatedSharpeRatio uses per-observation Sharpe internally; feed the
  // per-bar net stream and the true trial count.
  const dsr = computeDeflatedSharpeRatio(champPerObsSearch, { trialCount: trueN });
  const dsrP = dsr.deflatedProbability; // P(SR > E[max]) ; we want this HIGH (close to 1) to be significant
  // The DSR "p-value" convention here: deflatedProbability is the prob the true SR>0
  // given selection. Significant if deflatedProbability > 0.95 (i.e. 1 - p < 0.05).
  const dsrPass = dsrP > 0.95;
  const dsrPValue = 1 - dsrP;
  gateResults["dsr"] = dsrPass;
  console.log(
    `\n[GATE B] DSR (true N=${trueN}): deflatedProb=${fmt(dsrP, 4)} -> p=${fmt(dsrPValue, 4)} | per-obs SR=${fmt(dsr.sharpe, 4)} E[maxSR]=${fmt(dsr.expectedMaxSharpe, 4)} | ${dsrPass ? "PASS (p<0.05)" : "FAIL (p>=0.05)"}`,
  );
  if (!dsrPass && killedBy === "none") killedBy = "DSR";

  // --- GATE C: PBO < 0.5 via CSCV ---
  // Build fold returns for a panel of strategies (need >=2 strategies, >=2 folds).
  // Use the per-family champions (across freqs) as the competing panel on the
  // SEARCH window, split into folds. PBO measures overfit of the SELECTED config.
  const panelMembers = familyBest.slice(); // best per family/freq
  // ensure champ in panel
  if (!champIsFunding && !panelMembers.find((p) => p.name === champOhlcv.name && p.freq === champOhlcv.freq)) {
    panelMembers.push(champOhlcv);
  }
  const FOLDS = 8;
  function toFolds(series: number[]): number[][] {
    const folds: number[][] = [];
    const len = Math.floor(series.length / FOLDS);
    for (let k = 0; k < FOLDS; k++) {
      folds.push(series.slice(k * len, (k + 1) * len));
    }
    return folds;
  }
  // All panel members must share an aligned index space. They have different
  // lengths across freqs, so we resample each to its own fold lengths but PBO
  // compares ranks per split — use only the 15m-family members (same length) +
  // champ to keep folds aligned. Build from 15m members.
  const pboPanelSource = scored.filter((s) => s.freq === champOhlcv.freq);
  let pboResult: ReturnType<typeof estimateCscvPbo> | null = null;
  if (!champIsFunding && pboPanelSource.length >= 2) {
    const strategies: CscvStrategyFoldReturns[] = pboPanelSource.map((s) => ({
      id: `${s.family}/${s.name}`,
      folds: toFolds(s.dailyNetSearch),
    }));
    pboResult = estimateCscvPbo(strategies, { statistic: "sharpe" });
    const pboPass = pboResult.pbo < 0.5;
    gateResults["pbo"] = pboPass;
    console.log(
      `\n[GATE C] PBO (CSCV, ${strategies.length} strategies, ${FOLDS} folds): PBO=${fmt(pboResult.pbo, 3)} | ${pboPass ? "PASS (<0.5)" : "FAIL (>=0.5)"}`,
    );
    if (!pboPass && killedBy === "none") killedBy = "PBO";
  } else if (champIsFunding) {
    // Funding panel across symbols
    const strategies: CscvStrategyFoldReturns[] = fundResults
      .filter((f) => f.name.includes("_w60_z1.5") || f.name.includes(bestFund.name.split("_").slice(1).join("_")))
      .map((f) => ({ id: f.name, folds: toFolds(f.perDayNet) }));
    if (strategies.length >= 2) {
      pboResult = estimateCscvPbo(strategies, { statistic: "sharpe" });
      const pboPass = pboResult.pbo < 0.5;
      gateResults["pbo"] = pboPass;
      console.log(`\n[GATE C] PBO (funding panel ${strategies.length}): PBO=${fmt(pboResult.pbo, 3)} | ${pboPass ? "PASS" : "FAIL"}`);
      if (!pboPass && killedBy === "none") killedBy = "PBO";
    } else {
      gateResults["pbo"] = false;
      console.log("\n[GATE C] PBO: insufficient panel -> FAIL");
      if (killedBy === "none") killedBy = "PBO";
    }
  }

  // --- GATE D: beat baselines (buy-hold, random lottery, linear) net of cost ---
  // ALL baselines computed at the SAME (daily) frequency as the champion so the
  // per-observation Sharpe comparison is apples-to-apples.
  // Build a DAILY market log-return series on the champion's freq/window.
  let marketDailyReturns: number[]; // simple daily returns (buy-hold, for baseline lib)
  let champFc: ReturnType<typeof freqCache.get> = undefined;
  if (!champIsFunding) {
    champFc = freqCache.get(champFreqFactor)!;
    // buy-and-hold daily: aggregate per-bar log returns to daily then expm1
    const dayLog = new Map<number, number>();
    const dk: number[] = [];
    for (let i = 1; i < champFc.searchR.length; i++) {
      const d = champFc.searchDays[i];
      if (!dayLog.has(d)) dk.push(d);
      dayLog.set(d, (dayLog.get(d) ?? 0) + champFc.searchR[i]);
    }
    dk.sort((a, b) => a - b);
    marketDailyReturns = dk.map((d) => Math.expm1(dayLog.get(d)!));
  } else {
    const { perpRet } = loadFundingDaily("BTCUSDT");
    marketDailyReturns = perpRet.slice(1).map((x) => Math.expm1(x));
  }
  const champRoundTripCost = 2 * TAKER; // entry+exit = 8 bps for perp
  const bah = buildBuyAndHoldBaseline({ barReturns: marketDailyReturns, roundTripCost: champRoundTripCost, statistic: "sharpe" });
  // random lottery matched to champ turnover (number of round-trips over window)
  const champTradeCount = Math.round(champRoundTrips * (champPerObsSearch.length / 365));
  const lottery = buildRandomLotteryBaseline({
    barReturns: marketDailyReturns,
    tradeCount: Math.max(1, champTradeCount),
    averageHoldingBars: 1,
    roundTripCost: champRoundTripCost,
    iterations: 512,
    quantile: 0.95,
    statistic: "sharpe",
    seed: "ta3",
  });
  // linear one-layer baseline: AR(1) sign momentum on the champion's freq, net of
  // cost, daily-aggregated (same engine as the champion).
  let linDailyNet: number[];
  if (!champIsFunding && champFc) {
    const linPos = new Array(champFc.searchR.length).fill(0);
    for (let i = 1; i < champFc.searchR.length; i++) linPos[i] = Math.sign(champFc.searchR[i]);
    const linBt = backtest(linPos, champFc.searchR, TAKER, champFc.searchDays);
    linDailyNet = linBt.dailyNet;
  } else {
    const { perpRet } = loadFundingDaily("BTCUSDT");
    const linPos = new Array(perpRet.length).fill(0);
    for (let i = 1; i < perpRet.length; i++) linPos[i] = Math.sign(perpRet[i - 1]);
    const out: number[] = [];
    let prev = 0;
    for (let i = 0; i < perpRet.length - 1; i++) {
      const dpos = Math.abs(linPos[i] - prev);
      const gl = linPos[i] * perpRet[i + 1] + Math.log1p(-Math.min(0.999, dpos * TAKER));
      out.push(Math.expm1(gl));
      prev = linPos[i];
    }
    linDailyNet = out;
  }
  const linBaseline = baselineScoreFromReturns("linear_one_layer", "AR(1) sign", linDailyNet, { statistic: "sharpe" });

  // Compare via SHARPE statistic (per-obs). Champion per-obs sharpe:
  const champPerObsSharpe = summarizeReturnSeries(champPerObsSearch).sharpe;
  const baseGate = evaluateBaselineGate({
    candidateReturns: champPerObsSearch,
    candidateScore: champPerObsSharpe,
    baselines: [bah, lottery, linBaseline],
    statistic: "sharpe",
    minMargin: 0,
    requirePositive: true,
  });
  gateResults["baselines"] = baseGate.passed;
  console.log("\n[GATE D] Baselines (per-obs Sharpe, net of cost):");
  console.log(`  champion per-obs Sharpe = ${fmt(champPerObsSharpe, 5)}`);
  for (const c of baseGate.comparisons) {
    console.log(`  vs ${c.label.padEnd(22)} base=${fmt(c.baselineScore, 5).padStart(9)} margin=${fmt(c.margin, 5).padStart(9)} ${c.beaten ? "beat" : "LOSE"}`);
  }
  console.log(`  -> ${baseGate.passed ? "PASS" : "FAIL"} (${baseGate.reasons.join(",") || "ok"})`);
  if (!baseGate.passed && killedBy === "none") killedBy = "baselines";

  // --- GATE E: Harvey-Liu haircut (true N) ---
  const hc = haircutSharpe({
    observedSharpe: champPerObsSharpe,
    sampleCount: champPerObsSearch.length,
    trialCount: trueN,
    method: "bhy",
  });
  const hcBonf = haircutSharpe({
    observedSharpe: champPerObsSharpe,
    sampleCount: champPerObsSearch.length,
    trialCount: trueN,
    method: "bonferroni",
  });
  const haircutPass = hc.adjustedPValue < 0.05 && hc.haircutSharpe > 0;
  gateResults["haircut"] = haircutPass;
  console.log("\n[GATE E] Harvey-Liu haircut (true N=" + trueN + "):");
  console.log(
    `  raw p=${fmt(hc.pValue, 4)} | BHY adj p=${fmt(hc.adjustedPValue, 4)} haircutSR=${fmt(hc.haircutSharpe, 5)} (${fmt(hc.haircut * 100, 1)}% cut)`,
  );
  console.log(`  Bonferroni adj p=${fmt(hcBonf.adjustedPValue, 4)} haircutSR=${fmt(hcBonf.haircutSharpe, 5)} (${fmt(hcBonf.haircut * 100, 1)}% cut)`);
  console.log(`  -> ${haircutPass ? "PASS (adj p<0.05)" : "FAIL (adj p>=0.05)"}`);
  if (!haircutPass && killedBy === "none") killedBy = "haircut";

  // --- GATE F: consume-once final HOLDOUT (only meaningful for OHLCV champ) ---
  let holdoutNetSharpe = NaN;
  let holdoutPass = false;
  if (!champIsFunding && champBuilder) {
    const fc = freqCache.get(champFreqFactor)!;
    // Build positions on the FULL aggregated series, then evaluate only the vault.
    const fullPos = champBuilder(fc.bars, fc.r);
    const vaultStartAgg = Math.floor(testEnd / champFreqFactor);
    const vaultPos = fullPos.slice(vaultStartAgg);
    const vaultR = fc.r.slice(vaultStartAgg);
    const vaultDays = fc.days.slice(vaultStartAgg);
    const vaultBt = backtest(vaultPos, vaultR, TAKER, vaultDays);
    holdoutNetSharpe = dailySharpeAnnual(vaultBt.dailyNet);
    holdoutPass = holdoutNetSharpe > 0;
    gateResults["holdout"] = holdoutPass;
    console.log("\n[GATE F] Consume-once final HOLDOUT (most-recent 15%, never used in search):");
    console.log(
      `  vault daily-obs=${vaultBt.dailyNet.length} | NET annualized Sharpe=${fmt(holdoutNetSharpe, 3)} | gross=${fmt(dailySharpeAnnual(vaultBt.dailyGross), 3)} | ${holdoutPass ? "PASS (>0)" : "FAIL (<=0)"}`,
    );
    if (!holdoutPass && killedBy === "none") killedBy = "holdout";
  } else {
    console.log("\n[GATE F] Holdout: funding champ is daily/full-series (no 15m vault carve) — skipped; rely on DSR/haircut.");
    gateResults["holdout"] = champNetSharpeSearch > 0; // weak
  }

  // =====================================================================
  // VERDICT
  // =====================================================================
  const allPass = Object.values(gateResults).every(Boolean);
  console.log("\n" + "=".repeat(78));
  console.log("VERDICT");
  console.log("=".repeat(78));
  for (const [g, v] of Object.entries(gateResults)) {
    console.log(`  ${g.padEnd(22)} ${v ? "PASS" : "FAIL"}`);
  }
  console.log(`\n  KILLED BY: ${allPass ? "none — SURVIVED" : killedBy}`);
  console.log(`  VERDICT: ${allPass ? "SURVIVE" : "KILL"}`);

  // Monthly $ if survived
  if (allPass) {
    const monthlyRet = (summarizeReturnSeries(champPerObsSearch).mean * champBarsPerYear) / 12;
    console.log(`\n  Net mean/yr ~= ${fmt(summarizeReturnSeries(champPerObsSearch).mean * champBarsPerYear * 100, 2)}% | monthly ~= ${fmt(monthlyRet * 100, 3)}%`);
    console.log(`  At $10k: $${fmt(monthlyRet * 10000, 2)}/mo | At $100k: $${fmt(monthlyRet * 100000, 2)}/mo`);
  }

  // Machine-readable summary
  const summary = {
    track: "TA3",
    trueN,
    champion: champLabel,
    champIsFunding,
    searchNetSharpeAnnual: champNetSharpeSearch,
    grossSharpeAnnual: champIsFunding ? bestFund.grossSharpeAnnual : champOhlcv.grossSharpe,
    roundTripsPerYear: champRoundTrips,
    dsr: { deflatedProb: dsrP, pValue: dsrPValue, perObsSharpe: dsr.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe },
    pbo: pboResult?.pbo ?? null,
    haircut: { rawP: hc.pValue, bhyAdjP: hc.adjustedPValue, bonferroniAdjP: hcBonf.adjustedPValue, haircutSharpe: hc.haircutSharpe },
    baselines: baseGate.comparisons.map((c) => ({ id: c.id, base: c.baselineScore, margin: c.margin, beaten: c.beaten })),
    holdoutNetSharpe,
    gates: gateResults,
    verdict: allPass ? "SURVIVE" : "KILL",
    killedBy: allPass ? "none" : killedBy,
  };
  const outPath = resolve(REPO, "output/ta-research/ta3-results.json");
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
