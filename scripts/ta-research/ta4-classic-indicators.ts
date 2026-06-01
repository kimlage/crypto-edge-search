/**
 * TRACK TA4 — Classic technical indicators, tested DEFINITIVELY.
 *
 * Builds canonical TA signals (RSI, MACD cross, Bollinger mean-reversion + breakout,
 * MA cross golden/death, ADX-gated trend, Donchian breakout, Stochastic) on the 8
 * majors daily (perp closes). For each indicator: long/flat and long/short variants
 * over a small grid of standard params.
 *
 * HONEST N = total number of (indicator x param x variant) combos evaluated. That
 * true N is fed into the Deflated Sharpe Ratio (the multiple-testing trap retail TA
 * falls into). Net of realistic perp taker cost (4 bps per position change), we run
 * the full gate stack: DSR p<0.05, PBO<0.5, beats buy-and-hold + random-lottery +
 * linear baseline, survives the Harvey-Liu haircut, and a consume-once holdout.
 *
 * A config "survives" only if AFTER cost: net Sharpe>0, DSR p<0.05 at honest N,
 * PBO<0.5, beats all baselines, survives haircut, and confirms out-of-sample on the
 * untouched holdout. KILL is an honest, valuable outcome — no survivor is manufactured.
 *
 * Run:
 *   tsx scripts/ta-research/ta4-classic-indicators.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  baselineScoreFromReturns,
  buildRandomLotteryBaseline,
  evaluateBaselineGate,
  type BaselineScore,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import { planHoldoutSplit, FinalHoldoutGuard } from "../../src/lib/significance/holdout";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const FUNDING_DIR = join(REPO, "output", "funding");
const OUT_DIR = join(REPO, "output", "ta-research");

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"] as const;

// Realistic perp taker cost charged on EVERY position change (turnover-weighted).
// 4 bps per side. A change from +1 -> -1 turns over 2 units => 8 bps. Flat->long = 4 bps.
const PERP_TAKER_BPS = 4;
const COST_PER_UNIT_TURNOVER = PERP_TAKER_BPS / 10_000; // 0.0004 per unit of |Δposition|

const TRADING_DAYS_PER_YEAR = 365; // crypto trades 24/7; daily bars

// Holdout: most-recent 15% untouched vault; 15% posterior test; 70% search.
const HOLDOUT_FRACTION = 0.15;
const TEST_FRACTION = 0.15;

// ----------------------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------------------

interface DailyRow {
  date: string;
  perpClose: number;
}

function loadSymbol(sym: string): DailyRow[] {
  const path = join(FUNDING_DIR, `${sym}USDT_prices_daily.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<{
    date: string;
    spotClose: number;
    perpClose: number;
  }>;
  return raw
    .filter((r) => Number.isFinite(r.perpClose) && r.perpClose > 0)
    .map((r) => ({ date: r.date, perpClose: r.perpClose }));
}

// ----------------------------------------------------------------------------
// Indicator primitives (all causal: value at index i uses only data <= i)
// ----------------------------------------------------------------------------

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      // seed with SMA of first `period` values
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function rollingStd(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j];
    mean /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

// Wilder RSI
function rsi(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch >= 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD line and signal line
function macd(
  closes: number[],
  fast: number,
  slow: number,
  signal: number,
): { macdLine: (number | null)[]; signalLine: (number | null)[] } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? (emaFast[i] as number) - (emaSlow[i] as number) : null,
  );
  // signal = EMA of macdLine over its valid region
  const validIdx = macdLine.map((v, i) => (v !== null ? i : -1)).filter((i) => i >= 0);
  const signalLine: (number | null)[] = new Array(closes.length).fill(null);
  if (validIdx.length >= signal) {
    const k = 2 / (signal + 1);
    let prev: number | null = null;
    let count = 0;
    for (const i of validIdx) {
      count++;
      if (count < signal) continue;
      if (prev === null) {
        let s = 0;
        for (let j = count - signal; j < count; j++) s += macdLine[validIdx[j]] as number;
        prev = s / signal;
      } else {
        prev = (macdLine[i] as number) * k + prev * (1 - k);
      }
      signalLine[i] = prev;
    }
  }
  return { macdLine, signalLine };
}

// Wilder ADX, +DI, -DI from OHLC. We only have closes, so approximate true range
// with |close_t - close_{t-1}| and directional movement from close deltas. This is
// a close-only ADX proxy (standard when only closes are available).
function adxCloseOnly(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n <= period * 2) return out;
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = closes[i] - closes[i - 1];
    plusDM[i] = up > 0 ? up : 0;
    minusDM[i] = up < 0 ? -up : 0;
    tr[i] = Math.abs(up);
  }
  // Wilder smoothing
  const smPlus: number[] = new Array(n).fill(0);
  const smMinus: number[] = new Array(n).fill(0);
  const smTr: number[] = new Array(n).fill(0);
  let p = 0;
  let m = 0;
  let t = 0;
  for (let i = 1; i <= period; i++) {
    p += plusDM[i];
    m += minusDM[i];
    t += tr[i];
  }
  smPlus[period] = p;
  smMinus[period] = m;
  smTr[period] = t;
  for (let i = period + 1; i < n; i++) {
    smPlus[i] = smPlus[i - 1] - smPlus[i - 1] / period + plusDM[i];
    smMinus[i] = smMinus[i - 1] - smMinus[i - 1] / period + minusDM[i];
    smTr[i] = smTr[i - 1] - smTr[i - 1] / period + tr[i];
  }
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (smTr[i] === 0) {
      dx[i] = 0;
      continue;
    }
    const pdi = (100 * smPlus[i]) / smTr[i];
    const mdi = (100 * smMinus[i]) / smTr[i];
    const denom = pdi + mdi;
    dx[i] = denom === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / denom;
  }
  // ADX = Wilder smoothing of DX over period
  const firstDx = period;
  const adxStart = firstDx + period;
  if (adxStart >= n) return out;
  let adxPrev = 0;
  for (let i = firstDx; i < firstDx + period; i++) adxPrev += dx[i] as number;
  adxPrev /= period;
  out[adxStart - 1] = adxPrev;
  for (let i = adxStart; i < n; i++) {
    adxPrev = (adxPrev * (period - 1) + (dx[i] as number)) / period;
    out[i] = adxPrev;
  }
  return out;
}

// Stochastic %K (close-only proxy: highest/lowest close over period)
function stochastic(closes: number[], period: number, smoothK: number): (number | null)[] {
  const n = closes.length;
  const rawK: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (closes[j] > hi) hi = closes[j];
      if (closes[j] < lo) lo = closes[j];
    }
    rawK[i] = hi === lo ? 50 : (100 * (closes[i] - lo)) / (hi - lo);
  }
  // smooth K with SMA
  if (smoothK <= 1) return rawK;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1 + smoothK - 1; i < n; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - smoothK + 1; j <= i; j++) {
      if (rawK[j] === null) {
        ok = false;
        break;
      }
      s += rawK[j] as number;
    }
    if (ok) out[i] = s / smoothK;
  }
  return out;
}

// Highest/lowest over a trailing window (for Donchian / Bollinger breakout). Uses
// values up to and INCLUDING i (the channel "as of" close i). Signal uses prior bar's
// channel to avoid same-bar leakage (handled in signal generation).
function rollingMax(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let hi = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] > hi) hi = values[j];
    out[i] = hi;
  }
  return out;
}
function rollingMin(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] < lo) lo = values[j];
    out[i] = lo;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Signal generation
// ----------------------------------------------------------------------------

// A signal config produces a desired position series (target position for the NEXT
// day, decided on close of day i). Position values: +1 long, 0 flat, -1 short.
// `variant`: "longflat" clamps shorts to 0; "longshort" keeps -1.

type Variant = "longflat" | "longshort";

interface IndicatorConfig {
  id: string;
  indicator: string;
  params: Record<string, number>;
  variant: Variant;
  // Given closes, return desired position decided at close[i] (to be held i->i+1).
  // null means "no data yet / stay flat".
  positions: (closes: number[]) => (number | null)[];
}

function applyVariant(pos: number, variant: Variant): number {
  if (variant === "longflat") return pos > 0 ? 1 : 0;
  return pos;
}

// Build all configs. The grids are STANDARD textbook params (this is the honest N).
function buildConfigs(): IndicatorConfig[] {
  const configs: IndicatorConfig[] = [];
  const variants: Variant[] = ["longflat", "longshort"];

  // 1) RSI oversold/overbought (mean reversion). Long when RSI < lower, short when > upper.
  const rsiPeriods = [7, 14, 21];
  const rsiBands: Array<[number, number]> = [
    [30, 70],
    [25, 75],
    [20, 80],
  ];
  for (const period of rsiPeriods) {
    for (const [lower, upper] of rsiBands) {
      for (const variant of variants) {
        configs.push({
          id: `RSI_p${period}_${lower}-${upper}_${variant}`,
          indicator: "RSI",
          params: { period, lower, upper },
          variant,
          positions: (closes) => {
            const r = rsi(closes, period);
            return r.map((v) => {
              if (v === null) return null;
              if (v < lower) return applyVariant(1, variant);
              if (v > upper) return applyVariant(-1, variant);
              return 0;
            });
          },
        });
      }
    }
  }

  // 2) MACD cross. Long when macdLine > signalLine, short when below.
  const macdGrids: Array<[number, number, number]> = [
    [12, 26, 9],
    [8, 21, 5],
    [5, 35, 5],
  ];
  for (const [fast, slow, signal] of macdGrids) {
    for (const variant of variants) {
      configs.push({
        id: `MACD_${fast}-${slow}-${signal}_${variant}`,
        indicator: "MACD",
        params: { fast, slow, signal },
        variant,
        positions: (closes) => {
          const { macdLine, signalLine } = macd(closes, fast, slow, signal);
          return closes.map((_, i) => {
            if (macdLine[i] === null || signalLine[i] === null) return null;
            const diff = (macdLine[i] as number) - (signalLine[i] as number);
            return applyVariant(diff > 0 ? 1 : -1, variant);
          });
        },
      });
    }
  }

  // 3) Bollinger band mean-reversion. Long when close < lower band, short when > upper.
  const bbPeriods = [14, 20, 30];
  const bbMult = [1.5, 2.0, 2.5];
  for (const period of bbPeriods) {
    for (const mult of bbMult) {
      for (const variant of variants) {
        configs.push({
          id: `BBmr_p${period}_m${mult}_${variant}`,
          indicator: "Bollinger_MeanRev",
          params: { period, mult },
          variant,
          positions: (closes) => {
            const mid = sma(closes, period);
            const sd = rollingStd(closes, period);
            return closes.map((c, i) => {
              if (mid[i] === null || sd[i] === null) return null;
              const upper = (mid[i] as number) + mult * (sd[i] as number);
              const lower = (mid[i] as number) - mult * (sd[i] as number);
              if (c < lower) return applyVariant(1, variant);
              if (c > upper) return applyVariant(-1, variant);
              return 0;
            });
          },
        });
      }
    }
  }

  // 4) Bollinger band breakout (momentum). Long when close > upper, short when < lower.
  for (const period of bbPeriods) {
    for (const mult of bbMult) {
      for (const variant of variants) {
        configs.push({
          id: `BBbo_p${period}_m${mult}_${variant}`,
          indicator: "Bollinger_Breakout",
          params: { period, mult },
          variant,
          positions: (closes) => {
            const mid = sma(closes, period);
            const sd = rollingStd(closes, period);
            return closes.map((c, i) => {
              if (mid[i] === null || sd[i] === null) return null;
              const upper = (mid[i] as number) + mult * (sd[i] as number);
              const lower = (mid[i] as number) - mult * (sd[i] as number);
              if (c > upper) return applyVariant(1, variant);
              if (c < lower) return applyVariant(-1, variant);
              return 0;
            });
          },
        });
      }
    }
  }

  // 5) Moving-average cross (golden/death). Long when fast SMA > slow SMA.
  const maGrids: Array<[number, number]> = [
    [10, 50],
    [20, 50],
    [50, 200],
    [9, 21],
  ];
  for (const [fast, slow] of maGrids) {
    for (const variant of variants) {
      configs.push({
        id: `MAcross_${fast}-${slow}_${variant}`,
        indicator: "MA_Cross",
        params: { fast, slow },
        variant,
        positions: (closes) => {
          const f = sma(closes, fast);
          const s = sma(closes, slow);
          return closes.map((_, i) => {
            if (f[i] === null || s[i] === null) return null;
            return applyVariant((f[i] as number) > (s[i] as number) ? 1 : -1, variant);
          });
        },
      });
    }
  }

  // 6) ADX-gated trend. Trade MA-cross direction only when ADX > threshold (trend present).
  const adxPeriods = [14];
  const adxThresh = [20, 25, 30];
  const adxMa: Array<[number, number]> = [
    [20, 50],
    [10, 50],
  ];
  for (const aPeriod of adxPeriods) {
    for (const thr of adxThresh) {
      for (const [fast, slow] of adxMa) {
        for (const variant of variants) {
          configs.push({
            id: `ADXtrend_a${aPeriod}t${thr}_${fast}-${slow}_${variant}`,
            indicator: "ADX_Trend",
            params: { adxPeriod: aPeriod, threshold: thr, fast, slow },
            variant,
            positions: (closes) => {
              const a = adxCloseOnly(closes, aPeriod);
              const f = sma(closes, fast);
              const s = sma(closes, slow);
              return closes.map((_, i) => {
                if (a[i] === null || f[i] === null || s[i] === null) return null;
                if ((a[i] as number) < thr) return 0; // no trend => flat
                return applyVariant((f[i] as number) > (s[i] as number) ? 1 : -1, variant);
              });
            },
          });
        }
      }
    }
  }

  // 7) Donchian breakout. Long when close >= prior N-day high, short when <= prior N-day low.
  const donchian = [10, 20, 55];
  for (const period of donchian) {
    for (const variant of variants) {
      configs.push({
        id: `Donchian_p${period}_${variant}`,
        indicator: "Donchian",
        params: { period },
        variant,
        positions: (closes) => {
          // channel as of PRIOR bar (i-1) to make the breakout at bar i meaningful
          const hi = rollingMax(closes, period);
          const lo = rollingMin(closes, period);
          return closes.map((c, i) => {
            if (i === 0 || hi[i - 1] === null || lo[i - 1] === null) return null;
            if (c >= (hi[i - 1] as number)) return applyVariant(1, variant);
            if (c <= (lo[i - 1] as number)) return applyVariant(-1, variant);
            return 0;
          });
        },
      });
    }
  }

  // 8) Stochastic oscillator (mean reversion). Long when %K < lower, short when > upper.
  const stochPeriods = [14, 21];
  const stochSmooth = [3];
  const stochBands: Array<[number, number]> = [
    [20, 80],
    [10, 90],
  ];
  for (const period of stochPeriods) {
    for (const sk of stochSmooth) {
      for (const [lower, upper] of stochBands) {
        for (const variant of variants) {
          configs.push({
            id: `Stoch_p${period}s${sk}_${lower}-${upper}_${variant}`,
            indicator: "Stochastic",
            params: { period, smoothK: sk, lower, upper },
            variant,
            positions: (closes) => {
              const k = stochastic(closes, period, sk);
              return k.map((v) => {
                if (v === null) return null;
                if (v < lower) return applyVariant(1, variant);
                if (v > upper) return applyVariant(-1, variant);
                return 0;
              });
            },
          });
        }
      }
    }
  }

  return configs;
}

// ----------------------------------------------------------------------------
// Backtest: net-of-cost daily returns for a config on one symbol
// ----------------------------------------------------------------------------

interface SymbolSeries {
  symbol: string;
  closes: number[];
  // daily simple return r[i] = close[i]/close[i-1]-1, aligned so r[i] is the return
  // earned from holding from close[i-1] to close[i].
  ret: number[];
}

function buildSymbolSeries(sym: string): SymbolSeries {
  const rows = loadSymbol(sym);
  const closes = rows.map((r) => r.perpClose);
  const ret: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) ret[i] = closes[i] / closes[i - 1] - 1;
  return { symbol: sym, closes, ret };
}

// Given desired positions (decided at close[i], held i->i+1), produce net daily
// returns over [startIdx, endIdx). Position at day i earns ret[i+1]. Cost charged on
// |pos[i] - pos[i-1]| (turnover) at the moment the position changes (attributed to
// the day the new position starts earning).
interface BacktestResult {
  netReturns: number[]; // one per held day in window
  grossReturns: number[];
  positions: number[];
  turnoverUnits: number; // sum of |Δpos| within window
  daysHeld: number;
}

function backtestWindow(
  series: SymbolSeries,
  desired: (number | null)[],
  startIdx: number,
  endIdx: number,
): BacktestResult {
  const net: number[] = [];
  const gross: number[] = [];
  const positions: number[] = [];
  let turnover = 0;
  // position carried into day i (what we hold from close[i] to close[i+1])
  // We need prior position to compute turnover. Initialize from the bar just before
  // the window using the same desired series (so cost at the boundary is realistic).
  let prevPos = startIdx > 0 && desired[startIdx - 1] !== null ? (desired[startIdx - 1] as number) : 0;
  for (let i = startIdx; i < endIdx; i++) {
    const d = desired[i];
    const pos = d === null ? prevPos : d; // if no signal yet, hold prior (usually flat)
    const turn = Math.abs(pos - prevPos);
    turnover += turn;
    const cost = turn * COST_PER_UNIT_TURNOVER;
    // return earned holding pos from close[i] to close[i+1] => ret[i+1]
    const g = i + 1 < series.ret.length ? pos * series.ret[i + 1] : 0;
    gross.push(g);
    net.push(g - cost);
    positions.push(pos);
    prevPos = pos;
  }
  return {
    netReturns: net,
    grossReturns: gross,
    positions,
    turnoverUnits: turnover,
    daysHeld: net.length,
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

function annualizedSharpe(dailySharpe: number): number {
  return dailySharpe * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function main() {
  const allSeries = SYMBOLS.map((s) => buildSymbolSeries(s));
  const minLen = Math.min(...allSeries.map((s) => s.closes.length));

  // Holdout split on the time axis (same boundaries for all symbols, by index).
  const plan = planHoldoutSplit({
    totalRows: minLen,
    holdoutFraction: HOLDOUT_FRACTION,
    testFraction: TEST_FRACTION,
  });
  // The SEARCH (config selection) only sees [0, search.end). We hold the most-recent
  // block ([test.start..] = test + finalHoldout) entirely out of selection, then
  // confirm the chosen config on the finalHoldout vault (consume-once).
  const searchEnd = plan.search.end;
  const holdoutStart = plan.finalHoldout.start;
  const holdoutEnd = plan.finalHoldout.end;

  const configs = buildConfigs();
  const N = configs.length; // HONEST trial count

  console.log("=".repeat(78));
  console.log("TRACK TA4 — Classic technical indicators, definitive test");
  console.log("=".repeat(78));
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Days per symbol (aligned): ${minLen}`);
  console.log(
    `Holdout plan: search=[0,${searchEnd}) test=[${plan.test.start},${plan.test.end}) ` +
      `vault=[${holdoutStart},${holdoutEnd})`,
  );
  console.log(`Perp taker cost: ${PERP_TAKER_BPS} bps per unit turnover (round trip = ${2 * PERP_TAKER_BPS} bps)`);
  console.log(`HONEST trial count N (indicator x param x variant combos): ${N}`);
  console.log("");

  // Evaluate each config on the SEARCH window, pooled across all 8 symbols. The pooled
  // net return series is the concatenation of per-symbol net daily returns (each symbol
  // contributes |window| days). This is the candidate's net-of-cost return series.
  interface Evaluated {
    config: IndicatorConfig;
    pooledNet: number[];
    pooledGross: number[];
    dailySharpeNet: number;
    dailySharpeGross: number;
    annSharpeNet: number;
    annSharpeGross: number;
    compoundNet: number;
    turnoverUnits: number;
    daysHeld: number;
    roundTripsPerYear: number;
    // per-symbol net windows for PBO folds
    perSymbolNet: number[][];
  }

  const evaluated: Evaluated[] = configs.map((config) => {
    const pooledNet: number[] = [];
    const pooledGross: number[] = [];
    const perSymbolNet: number[][] = [];
    let turnover = 0;
    let days = 0;
    for (const series of allSeries) {
      const desired = config.positions(series.closes);
      const bt = backtestWindow(series, desired, 0, searchEnd);
      pooledNet.push(...bt.netReturns);
      pooledGross.push(...bt.grossReturns);
      perSymbolNet.push(bt.netReturns);
      turnover += bt.turnoverUnits;
      days += bt.daysHeld;
    }
    const statNet = summarizeReturnSeries(pooledNet);
    const statGross = summarizeReturnSeries(pooledGross);
    // Honest compound: average of EACH symbol's own compounded return (a single account
    // per symbol), NOT the concatenation compounded sequentially (which would explode).
    const compoundNet =
      perSymbolNet.reduce((acc, s) => acc + summarizeReturnSeries(s).compoundReturn, 0) /
      Math.max(1, perSymbolNet.length);
    // turnover units per year: total |Δpos| over total symbol-days, scaled to a year.
    // A round trip = 2 units of turnover (enter + exit). Report round-trips/yr per symbol.
    const symbolDays = days; // total symbol-days across 8 symbols
    const turnoverPerSymbolYear = (turnover / symbolDays) * TRADING_DAYS_PER_YEAR;
    const roundTripsPerYear = turnoverPerSymbolYear / 2;
    return {
      config,
      pooledNet,
      pooledGross,
      dailySharpeNet: statNet.sharpe,
      dailySharpeGross: statGross.sharpe,
      annSharpeNet: annualizedSharpe(statNet.sharpe),
      annSharpeGross: annualizedSharpe(statGross.sharpe),
      compoundNet,
      turnoverUnits: turnover,
      daysHeld: days,
      roundTripsPerYear,
      perSymbolNet,
    };
  });

  // Rank by net daily Sharpe (the selection criterion the searcher would use).
  evaluated.sort((a, b) => b.dailySharpeNet - a.dailySharpeNet);

  console.log("Top 12 configs by NET daily Sharpe (search window, pooled across 8 majors):");
  console.log(
    "  rank  config".padEnd(56) +
      "netSh(ann)  grossSh(ann)  compNet%   RT/yr",
  );
  evaluated.slice(0, 12).forEach((e, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}    ${e.config.id.padEnd(46)}` +
        `${e.annSharpeNet.toFixed(2).padStart(7)}   ${e.annSharpeGross.toFixed(2).padStart(8)}    ` +
        `${(e.compoundNet * 100).toFixed(1).padStart(7)}  ${e.roundTripsPerYear.toFixed(0).padStart(6)}`,
    );
  });
  console.log("");

  const best = evaluated[0];

  // ----- GATE 1: Deflated Sharpe at HONEST N on the search-window pooled net returns -----
  const dsr = computeDeflatedSharpeRatio(best.pooledNet, { trialCount: N, benchmarkSharpe: 0 });
  const dsrPValue = 1 - dsr.deflatedProbability; // P that true Sharpe <= deflated bar
  // (deflatedProbability is P(Sharpe > expectedMax under null); survival needs it HIGH.)
  const dsrPass = dsr.deflatedProbability >= 0.95; // i.e. p-value < 0.05

  // ----- GATE 2: PBO (CSCV) over per-symbol folds, all configs as strategies -----
  // Each symbol's search-window net returns is a "fold"; PBO asks whether the config
  // that's best in-sample (train folds) stays good out-of-sample (test folds).
  const strategies: CscvStrategyFoldReturns[] = evaluated.map((e) => ({
    id: e.config.id,
    folds: e.perSymbolNet,
  }));
  const pbo = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });
  const pboPass = pbo.pbo < 0.5;

  // ----- GATE 3: Baselines (must beat buy-and-hold + random-lottery + linear) -----
  // Compare on MEAN daily net return. Mean is additive, so it is NOT distorted by
  // pooling 8 symbols into one concatenated series (unlike compound, which would
  // compound 8x768 days sequentially and explode). Mean daily net edge is the honest
  // per-symbol-day P&L proxy and is the same units for candidate and all baselines.
  const BASELINE_STAT = "mean" as const;
  const bhPooled: number[] = [];
  const marketBarsPooled: number[] = [];
  for (const series of allSeries) {
    // bar returns over the search window = ret[i+1] for i in [0, searchEnd)
    const bars: number[] = [];
    for (let i = 0; i < searchEnd; i++) bars.push(i + 1 < series.ret.length ? series.ret[i + 1] : 0);
    marketBarsPooled.push(...bars);
    // Per-symbol long-and-hold net of one round trip (entry+exit), entry cost on bar 0.
    const series2 = bars.length > 0 ? [bars[0] - 2 * COST_PER_UNIT_TURNOVER, ...bars.slice(1)] : [];
    bhPooled.push(...series2);
  }

  // Random lottery: match candidate turnover. Trades ~ turnover units / 2 (round trips).
  const candidateRoundTrips = Math.max(1, Math.round(best.turnoverUnits / 2));
  const randomLottery = buildRandomLotteryBaseline({
    barReturns: marketBarsPooled,
    tradeCount: candidateRoundTrips,
    averageHoldingBars: Math.max(1, Math.round(best.daysHeld / candidateRoundTrips)),
    roundTripCost: 2 * COST_PER_UNIT_TURNOVER,
    iterations: 2000,
    quantile: 0.95,
    allowShort: true,
    statistic: BASELINE_STAT,
    seed: "ta4-random-lottery",
  });

  // Linear one-layer baseline: a single-feature linear predictor on the pooled search
  // window — predict next-day return from yesterday's return (momentum). Position =
  // sign of prediction, net of cost. This is the DLinear-style trivial baseline.
  const linearNet = buildLinearBaselineNet(allSeries, searchEnd);

  const baselines: BaselineScore[] = [
    baselineScoreFromReturns("buy_and_hold", "Buy-and-hold (pooled)", bhPooled, {
      statistic: BASELINE_STAT,
    }),
    randomLottery,
    baselineScoreFromReturns("linear_one_layer", "Linear one-layer (momentum)", linearNet, {
      statistic: BASELINE_STAT,
    }),
  ];

  const baselineGate = evaluateBaselineGate({
    candidateReturns: best.pooledNet,
    baselines,
    statistic: BASELINE_STAT,
    minMargin: 0,
    requirePositive: true,
  });
  const baselinePass = baselineGate.passed;

  // Definitive census: how many of the 94 configs beat passive buy-and-hold on mean
  // daily net return? (the cost-free benchmark every active TA strategy must justify)
  const bhMean = summarizeReturnSeries(bhPooled).mean;
  const beatBh = evaluated.filter((e) => summarizeReturnSeries(e.pooledNet).mean > bhMean).length;
  console.log(
    `Census: ${beatBh}/${N} configs beat passive buy-and-hold on mean daily net return ` +
      `(buy-and-hold mean=${bhMean.toFixed(5)}/day).`,
  );
  console.log("");

  // ----- GATE 4: Harvey-Liu haircut at HONEST N (Bonferroni / BHY) -----
  const hcBonf = haircutSharpe({
    observedSharpe: best.dailySharpeNet,
    sampleCount: best.pooledNet.length,
    trialCount: N,
    method: "bonferroni",
  });
  const hcBhy = haircutSharpe({
    observedSharpe: best.dailySharpeNet,
    sampleCount: best.pooledNet.length,
    trialCount: N,
    method: "bhy",
  });
  // survives if adjusted p-value < 0.05 AND haircut Sharpe stays > 0
  const haircutPass = hcBhy.adjustedPValue < 0.05 && hcBhy.haircutSharpe > 0;

  // ----- GATE 5: Consume-once HOLDOUT (final vault, never seen by selection) -----
  const guard = new FinalHoldoutGuard();
  // Evaluate the SELECTED best config on the untouched vault, pooled across symbols.
  const holdoutNet: number[] = [];
  const holdoutPerSymbol: number[][] = [];
  for (const series of allSeries) {
    const desired = best.config.positions(series.closes);
    const bt = backtestWindow(series, desired, holdoutStart, holdoutEnd);
    holdoutNet.push(...bt.netReturns);
    holdoutPerSymbol.push(bt.netReturns);
  }
  guard.consume({
    reason: "ta4-classic-indicators-final-verdict",
    trialCount: N,
    nowIso: new Date().toISOString(),
  });
  const holdoutStat = summarizeReturnSeries(holdoutNet);
  const holdoutAnnSharpe = annualizedSharpe(holdoutStat.sharpe);
  // Honest per-symbol-averaged compound (not the exploded concatenation compound).
  const holdoutCompound =
    holdoutPerSymbol.reduce((acc, s) => acc + summarizeReturnSeries(s).compoundReturn, 0) /
    Math.max(1, holdoutPerSymbol.length);
  const holdoutPass = holdoutStat.sharpe > 0 && holdoutCompound > 0;

  // ----------------------------------------------------------------------------
  // Verdict
  // ----------------------------------------------------------------------------
  const gates = [
    { name: "net Sharpe > 0", pass: best.dailySharpeNet > 0 },
    { name: "DSR p < 0.05 (honest N)", pass: dsrPass },
    { name: "PBO < 0.5", pass: pboPass },
    { name: "beats all baselines", pass: baselinePass },
    { name: "survives Harvey-Liu haircut", pass: haircutPass },
    { name: "holdout confirms (Sharpe>0 & compound>0)", pass: holdoutPass },
  ];
  const survived = gates.every((g) => g.pass);
  const firstFail = gates.find((g) => !g.pass);

  console.log("=".repeat(78));
  console.log(`SELECTED BEST (net of cost): ${best.config.id}`);
  console.log("=".repeat(78));
  console.log(`  Net daily Sharpe:    ${best.dailySharpeNet.toFixed(4)}  (annualized ${best.annSharpeNet.toFixed(3)})`);
  console.log(`  Gross daily Sharpe:  ${best.dailySharpeGross.toFixed(4)}  (annualized ${best.annSharpeGross.toFixed(3)})`);
  console.log(`  Net compound (search, pooled): ${(best.compoundNet * 100).toFixed(2)}%`);
  console.log(`  Round-trips / year (per symbol): ${best.roundTripsPerYear.toFixed(1)}`);
  console.log(`  Pooled sample (symbol-days): ${best.pooledNet.length}`);
  console.log("");
  console.log("GATE RESULTS:");
  console.log(`  [${best.dailySharpeNet > 0 ? "PASS" : "FAIL"}] net Sharpe > 0`);
  console.log(
    `  [${dsrPass ? "PASS" : "FAIL"}] Deflated Sharpe @ N=${N}: deflatedProb=${dsr.deflatedProbability.toFixed(4)} ` +
      `=> DSR p-value=${dsrPValue.toFixed(4)} (expectedMaxSharpe=${dsr.expectedMaxSharpe.toFixed(4)}, obs=${dsr.sharpe.toFixed(4)})`,
  );
  console.log(`  [${pboPass ? "PASS" : "FAIL"}] PBO (CSCV): ${pbo.pbo.toFixed(4)} over ${pbo.splitCount} splits, ${pbo.strategyCount} strategies, ${pbo.foldCount} folds`);
  console.log(`  [${baselinePass ? "PASS" : "FAIL"}] Baselines (compound, net):`);
  for (const c of baselineGate.comparisons) {
    console.log(
      `        ${c.beaten ? "beat" : "LOSE"} vs ${c.label}: candidate=${baselineGate.candidateScore.toFixed(4)} ` +
        `baseline=${c.baselineScore.toFixed(4)} margin=${c.margin.toFixed(4)}`,
    );
  }
  console.log(
    `  [${haircutPass ? "PASS" : "FAIL"}] Harvey-Liu haircut @ N=${N}: ` +
      `raw p=${hcBhy.pValue.toExponential(3)}, BHY adj p=${hcBhy.adjustedPValue.toFixed(4)}, ` +
      `haircut Sharpe=${hcBhy.haircutSharpe.toFixed(4)} (Bonferroni adj p=${hcBonf.adjustedPValue.toFixed(4)})`,
  );
  console.log(
    `  [${holdoutPass ? "PASS" : "FAIL"}] Holdout vault [${holdoutStart},${holdoutEnd}): ` +
      `net Sharpe=${holdoutStat.sharpe.toFixed(4)} (ann ${holdoutAnnSharpe.toFixed(3)}), ` +
      `compound(per-sym avg)=${(holdoutCompound * 100).toFixed(2)}%, n=${holdoutNet.length}`,
  );
  console.log("");
  console.log("=".repeat(78));
  console.log(`VERDICT: ${survived ? "SURVIVE" : "KILL"}`);
  if (!survived && firstFail) console.log(`KILLED BY GATE: ${firstFail.name}`);
  console.log("=".repeat(78));

  // Realistic monthly $ ONLY if survived.
  let monthly = "n/a — killed";
  if (survived) {
    // monthly net return ~ mean daily net * 30 (per symbol, equal-weight across 8)
    const meanDaily = summarizeReturnSeries(best.pooledNet).mean;
    const monthlyPct = meanDaily * 30;
    monthly =
      `${(monthlyPct * 100).toFixed(2)}%/mo => $${(monthlyPct * 10000).toFixed(0)} on $10k, ` +
      `$${(monthlyPct * 100000).toFixed(0)} on $100k`;
    console.log(`Realistic monthly (net): ${monthly}`);
  }

  // Write artifact.
  const artifact = {
    track: "TA4",
    generatedAt: new Date().toISOString(),
    dataSource: "output/funding/*_prices_daily.json (perpClose, 8 majors, 2023-06..2026-05)",
    symbols: SYMBOLS,
    daysPerSymbol: minLen,
    perpTakerBps: PERP_TAKER_BPS,
    honestTrialCount: N,
    configsBeatingBuyAndHold: beatBh,
    holdoutPlan: plan,
    best: {
      id: best.config.id,
      indicator: best.config.indicator,
      params: best.config.params,
      variant: best.config.variant,
      netDailySharpe: best.dailySharpeNet,
      netAnnualSharpe: best.annSharpeNet,
      grossAnnualSharpe: best.annSharpeGross,
      compoundNetSearch: best.compoundNet,
      roundTripsPerYear: best.roundTripsPerYear,
      pooledSampleDays: best.pooledNet.length,
    },
    gates: {
      netSharpePositive: best.dailySharpeNet > 0,
      dsr: {
        trialCount: N,
        observedSharpe: dsr.sharpe,
        expectedMaxSharpe: dsr.expectedMaxSharpe,
        deflatedProbability: dsr.deflatedProbability,
        pValue: dsrPValue,
        pass: dsrPass,
      },
      pbo: { value: pbo.pbo, splits: pbo.splitCount, strategies: pbo.strategyCount, folds: pbo.foldCount, pass: pboPass },
      baselines: {
        candidateCompound: baselineGate.candidateScore,
        comparisons: baselineGate.comparisons,
        pass: baselinePass,
      },
      haircut: {
        method: "bhy",
        rawP: hcBhy.pValue,
        bhyAdjustedP: hcBhy.adjustedPValue,
        bonferroniAdjustedP: hcBonf.adjustedPValue,
        haircutSharpe: hcBhy.haircutSharpe,
        pass: haircutPass,
      },
      holdout: {
        window: [holdoutStart, holdoutEnd],
        netSharpe: holdoutStat.sharpe,
        netAnnualSharpe: holdoutAnnSharpe,
        compound: holdoutCompound,
        n: holdoutNet.length,
        pass: holdoutPass,
      },
    },
    verdict: survived ? "SURVIVE" : "KILL",
    killedByGate: survived ? "none" : firstFail?.name ?? "unknown",
    monthlyIfSurvived: monthly,
    topConfigs: evaluated.slice(0, 15).map((e) => ({
      id: e.config.id,
      netAnnualSharpe: e.annSharpeNet,
      grossAnnualSharpe: e.annSharpeGross,
      compoundNet: e.compoundNet,
      roundTripsPerYear: e.roundTripsPerYear,
    })),
  };
  const outPath = join(OUT_DIR, "ta4-classic-indicators-result.json");
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact written: ${outPath}`);
}

// Linear one-layer baseline: standardize yesterday's return (single feature) over the
// search window per symbol, fit a 1-D least-squares slope to next-day return, take the
// in-sample sign of prediction as position, net of cost. Trivial DLinear-style baseline.
function buildLinearBaselineNet(allSeries: SymbolSeries[], searchEnd: number): number[] {
  const pooled: number[] = [];
  for (const series of allSeries) {
    const feats: number[] = [];
    const targets: number[] = [];
    for (let i = 1; i < searchEnd && i + 1 < series.ret.length; i++) {
      feats.push(series.ret[i]); // yesterday's return as of close i
      targets.push(series.ret[i + 1]);
    }
    if (feats.length < 10) continue;
    const mx = feats.reduce((a, b) => a + b, 0) / feats.length;
    const my = targets.reduce((a, b) => a + b, 0) / targets.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < feats.length; i++) {
      sxy += (feats[i] - mx) * (targets[i] - my);
      sxx += (feats[i] - mx) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const intercept = my - slope * mx;
    // position = sign of predicted next-day return, held i->i+1
    let prevPos = 0;
    for (let i = 1; i < searchEnd && i + 1 < series.ret.length; i++) {
      const pred = slope * series.ret[i] + intercept;
      const pos = pred > 0 ? 1 : pred < 0 ? -1 : 0;
      const turn = Math.abs(pos - prevPos);
      const cost = turn * COST_PER_UNIT_TURNOVER;
      pooled.push(pos * series.ret[i + 1] - cost);
      prevPos = pos;
    }
  }
  return pooled;
}

main();
