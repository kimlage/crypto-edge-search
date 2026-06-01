/**
 * TRACK TA2 — SLOW vol-targeted Time-Series Momentum (managed-futures form).
 *
 * The trend variant with the STRONGEST academic prior (Moskowitz-Ooi-Pedersen
 * 2012 "Time Series Momentum"; Fieberg et al. CTREND). This is deliberately the
 * SLOWEST, LOWEST-COST trend form:
 *   - broad panel: the 30-coin crossxs universe (the 8 majors BTC/ETH/BNB/SOL/
 *     XRP/ADA/DOGE/AVAX are a subset already inside it),
 *   - signal: sign(past L-month return), L in {1,3,6,12} months,
 *   - MONTHLY rebalance only (weights held constant within a month -> low turnover),
 *   - VOL-TARGETED sizing: each leg scaled to constant ex-ante risk,
 *   - equal-RISK across the panel (average the vol-scaled legs).
 *
 * This is NOT the existing daily-rebalanced audit-tsmom-panel.ts. That one
 * recomputes/charges turnover every single day (high cost). Here weights change
 * only at month boundaries -> a fraction of the turnover, which is the whole
 * point of the managed-futures "slow" form.
 *
 * HONEST trial count N = (4 lookbacks) x (sizing variants) x (long-only / long-short).
 * Every config below is counted. The chosen config is the in-sample best; the
 * vault is consumed ONCE.
 *
 * Full gate stack (committed cores, no re-implemented stats):
 *   - self-checks: PURE NOISE shows no net edge; future mutation can't change a
 *     past month's return (causality).
 *   - DSR with honest N (computeDeflatedSharpeRatio).
 *   - CPCV / PBO (estimateCscvPbo) across all configs.
 *   - baselines: must beat buy-and-hold BTC, the random-lottery, and the linear
 *     (universe equal-weight) baseline (evaluateBaselineGate + builders).
 *   - Harvey-Liu multiple-testing haircut (haircutSharpe).
 *   - consume-once holdout (planHoldoutSplit + FinalHoldoutGuard).
 *
 * Realistic cost MANDATORY: per-side taker ~4 bps perp / 10 bps spot. We trade
 * perps (can short), so round-trip = 8 bps; we ALSO report a spot-only 20 bps
 * sensitivity. Cost charged on EVERY monthly weight change. Turnover reported.
 *
 * Reads output/crossxs only. No BigQuery, no training, no Next.js. Writes only to
 * output/ta-research/.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  baselineScoreFromReturns,
  evaluateBaselineGate,
  type BaselineScore,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import {
  planHoldoutSplit,
  assertSearchDoesNotTouchHoldout,
  FinalHoldoutGuard,
} from "../../src/lib/significance/holdout";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "output", "ta-research");

// ---- Cost model -----------------------------------------------------------
// Per-side taker ~4 bps perp. A "round trip" = enter + exit = 8 bps. Turnover
// below is measured as sum_i |w_{i,new} - w_{i,old}| (one-way notional traded),
// so we charge PER_SIDE on that one-way turnover. We also run a spot-only 20 bps
// round-trip (10 bps/side) sensitivity at the end.
const PER_SIDE_PERP = 0.0004; // 4 bps taker per side, perp
const PER_SIDE_SPOT = 0.001; // 10 bps per side, spot
const TRADING_DAYS_PER_YEAR = 365;
const DSR_THRESHOLD = 0.95; // DSR probability >= 0.95  <=> p-value <= 0.05
const PBO_THRESHOLD = 0.5;

// ---- Data -----------------------------------------------------------------
interface DailyCloses {
  source: string;
  realData: boolean;
  dates: string[];
  closes: Record<string, (number | null)[]>;
}

function loadPanel(): DailyCloses {
  const raw = readFileSync(join(ROOT, "output", "crossxs", "daily-closes.json"), "utf8");
  return JSON.parse(raw) as DailyCloses;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pure-noise panel: zero-drift GBM with same listing pattern; a real momentum
 *  edge must vanish here (no autocorrelation to exploit). */
function buildNoisePanel(real: DailyCloses, seed: number): DailyCloses {
  const rng = mulberry32(seed);
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const closes: Record<string, (number | null)[]> = {};
  const dailySigma = 0.04;
  for (const coin of Object.keys(real.closes)) {
    const src = real.closes[coin];
    const out: (number | null)[] = new Array(src.length).fill(null);
    let price = 100;
    let started = false;
    for (let i = 0; i < src.length; i += 1) {
      if (src[i] == null) {
        out[i] = null;
        continue;
      }
      if (!started) {
        price = 100;
        started = true;
        out[i] = price;
        continue;
      }
      price *= Math.exp(dailySigma * gauss() - 0.5 * dailySigma * dailySigma);
      out[i] = price;
    }
    closes[coin] = out;
  }
  return { ...real, closes };
}

// ---- Engine: MONTHLY-rebalanced vol-targeted TSMOM ------------------------
interface SlowTsmomConfig {
  lookbackMonths: number; // 1, 3, 6, 12
  sizing: "voltarget" | "equalsign"; // vol-targeted OR plain equal-weight sign
  targetAnnualVol: number; // only used when sizing=voltarget
  direction: "longshort" | "longonly"; // longonly clamps shorts to flat
  volWindowDays: number;
  maxLegWeight: number;
  perSideCost: number;
}

interface SlowTsmomResult {
  monthlyNet: number[]; // net-of-cost monthly portfolio returns
  monthlyGross: number[];
  monthlyCost: number[]; // cost charged at the START of each month
  monthLabels: string[]; // YYYY-MM of each return month
  avgBreadth: number; // avg live legs per rebalance
  avgMonthlyTurnover: number; // mean sum_i |dw_i| per rebalance (one-way)
  roundTripsPerYear: number; // turnover-based round-trips/yr
  rebalances: number;
  monthEndIdx: number[]; // day indexes used as month boundaries
}

const APPROX_DAYS_PER_MONTH = 30;

/** Index of the last trading day of each calendar month within [0, T). */
function monthEndIndexes(dates: string[]): number[] {
  const ends: number[] = [];
  for (let i = 0; i < dates.length; i += 1) {
    const ym = dates[i].slice(0, 7);
    const nextYm = i + 1 < dates.length ? dates[i + 1].slice(0, 7) : null;
    if (nextYm === null || nextYm !== ym) ends.push(i);
  }
  return ends;
}

/**
 * Run the slow monthly TSMOM book.
 *
 * Causality: at month-end day `e` we observe closes up to e, compute the trailing
 * L-month return and trailing vol both ending at e, set weights, then EARN those
 * weights over the NEXT month (days (e, nextEnd]). Cost charged once at e on the
 * change from last month's weights. No look-ahead.
 *
 * @param startMonthIdx  index into monthEnds to start setting weights (inclusive)
 * @param endMonthIdx    index into monthEnds to stop (exclusive of forming new
 *                       weights past this); returns are earned within the window.
 */
function runSlowTsmom(args: {
  panel: DailyCloses;
  config: SlowTsmomConfig;
  monthEnds: number[];
  startMonthIdx: number; // inclusive
  endMonthIdx: number; // exclusive: last rebalance is endMonthIdx-1
}): SlowTsmomResult {
  const { panel, config, monthEnds } = args;
  const coins = Object.keys(panel.closes);
  const closesByCoin = panel.closes;
  const lookbackDays = config.lookbackMonths * APPROX_DAYS_PER_MONTH;
  const volScale = config.targetAnnualVol / Math.sqrt(TRADING_DAYS_PER_YEAR);

  // Precompute daily simple returns per coin (NaN gaps).
  const dailyByCoin: Record<string, number[]> = {};
  for (const coin of coins) {
    const arr = closesByCoin[coin];
    const out = new Array<number>(arr.length).fill(NaN);
    for (let i = 1; i < arr.length; i += 1) {
      const p = arr[i - 1];
      const c = arr[i];
      if (p != null && c != null && p > 0 && c > 0) out[i] = c / p - 1;
    }
    dailyByCoin[coin] = out;
  }

  const monthlyNet: number[] = [];
  const monthlyGross: number[] = [];
  const monthlyCost: number[] = [];
  const monthLabels: string[] = [];
  const monthEndIdx: number[] = [];
  let breadthSum = 0;
  let turnoverSum = 0;
  let rebalances = 0;

  const prevWeight: Record<string, number> = {};
  for (const coin of coins) prevWeight[coin] = 0;

  const startMi = Math.max(0, args.startMonthIdx);
  const endMi = Math.min(monthEnds.length, args.endMonthIdx);

  for (let mi = startMi; mi < endMi; mi += 1) {
    const e = monthEnds[mi]; // weights formed at close of day e
    const nextEnd = mi + 1 < monthEnds.length ? monthEnds[mi + 1] : null;
    if (nextEnd === null) break; // need a forward month to earn returns
    // Don't form weights / earn returns past the window end.
    if (mi + 1 >= endMi) break;

    // --- Form CAUSAL weights from data ending at day e ---
    const weights: Record<string, number> = {};
    let liveCount = 0;
    for (const coin of coins) {
      weights[coin] = 0;
      const closes = closesByCoin[coin];
      const iPast = e - lookbackDays;
      if (iPast < 0) continue;
      const cNow = closes[e];
      const cPast = closes[iPast];
      if (cNow == null || cPast == null || cPast <= 0 || cNow <= 0) continue;
      const trailingReturn = cNow / cPast - 1;
      let sign = trailingReturn > 0 ? 1 : trailingReturn < 0 ? -1 : 0;
      if (sign === 0) continue;
      if (config.direction === "longonly" && sign < 0) {
        // long-only: a down-trend means flat (no position), not short.
        continue;
      }

      let w: number;
      if (config.sizing === "voltarget") {
        // trailing realised daily vol over volWindowDays ending at e
        const daily = dailyByCoin[coin];
        let sum = 0;
        let sumSq = 0;
        let n = 0;
        for (let k = e - config.volWindowDays + 1; k <= e; k += 1) {
          if (k < 1) continue;
          const r = daily[k];
          if (Number.isFinite(r)) {
            sum += r;
            sumSq += r * r;
            n += 1;
          }
        }
        if (n < Math.ceil(config.volWindowDays * 0.6)) continue;
        const mean = sum / n;
        const variance = Math.max(0, sumSq / n - mean * mean);
        const dailyVol = Math.sqrt(variance);
        if (!(dailyVol > 0)) continue;
        w = (sign * volScale) / dailyVol;
        if (w > config.maxLegWeight) w = config.maxLegWeight;
        if (w < -config.maxLegWeight) w = -config.maxLegWeight;
      } else {
        // equalsign: plain unit sign (no vol-target), equal gross per leg
        w = sign;
      }
      weights[coin] = w;
      liveCount += 1;
    }

    // Diversify equally across live legs (equal RISK contribution since each leg
    // is already vol-scaled; for equalsign it's equal gross).
    const scaled: Record<string, number> = {};
    for (const coin of coins) scaled[coin] = liveCount > 0 ? weights[coin] / liveCount : 0;

    // --- Cost at rebalance: one-way turnover * per-side cost ---
    let turnover = 0;
    for (const coin of coins) turnover += Math.abs(scaled[coin] - prevWeight[coin]);
    const cost = turnover * config.perSideCost;

    // --- Earn these weights over the next month (days e+1 .. nextEnd) ---
    let gross = 0;
    for (let t = e + 1; t <= nextEnd; t += 1) {
      let dayRet = 0;
      for (const coin of coins) {
        const w = scaled[coin];
        if (w === 0) continue;
        const r = dailyByCoin[coin][t];
        if (Number.isFinite(r)) dayRet += w * r;
      }
      gross = (1 + gross) * (1 + dayRet) - 1; // compound within the month
    }

    const net = gross - cost;
    monthlyGross.push(gross);
    monthlyCost.push(cost);
    monthlyNet.push(net);
    monthLabels.push(panel.dates[nextEnd].slice(0, 7));
    monthEndIdx.push(e);
    breadthSum += liveCount;
    turnoverSum += turnover;
    rebalances += 1;

    for (const coin of coins) prevWeight[coin] = scaled[coin];
  }

  const avgMonthlyTurnover = rebalances > 0 ? turnoverSum / rebalances : 0;
  // Round-trips/yr: one-way turnover per month * 12 months / 2 (enter+exit = RT).
  const roundTripsPerYear = (avgMonthlyTurnover * 12) / 2;

  return {
    monthlyNet,
    monthlyGross,
    monthlyCost,
    monthLabels,
    avgBreadth: rebalances > 0 ? breadthSum / rebalances : 0,
    avgMonthlyTurnover,
    roundTripsPerYear,
    rebalances,
    monthEndIdx,
  };
}

// ---- Stats helpers (monthly) ----------------------------------------------
function compound(returns: readonly number[]): number {
  let acc = 1;
  for (const r of returns) if (Number.isFinite(r)) acc *= 1 + r;
  return acc - 1;
}
function annualizedReturnMonthly(monthly: readonly number[]): number {
  const n = monthly.filter((r) => Number.isFinite(r)).length;
  if (n === 0) return 0;
  const total = compound(monthly);
  const years = n / 12;
  if (years <= 0) return 0;
  const base = 1 + total;
  if (base <= 0) return -1;
  return Math.pow(base, 1 / years) - 1;
}
function annualizedSharpeMonthly(monthly: readonly number[]): number {
  const vals = monthly.filter((r) => Number.isFinite(r));
  if (vals.length < 2) return 0;
  const mean = vals.reduce((s, r) => s + r, 0) / vals.length;
  const variance = vals.reduce((s, r) => s + (r - mean) ** 2, 0) / (vals.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return 0;
  return (mean / sd) * Math.sqrt(12);
}
function maxDrawdownMonthly(monthly: readonly number[]): number {
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of monthly) {
    if (!Number.isFinite(r)) continue;
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? 1 - equity / peak : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}
function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

/** Buy-and-hold BTC as a MONTHLY return series over a window of month-ends. */
function btcMonthly(panel: DailyCloses, monthEnds: number[], startMi: number, endMi: number): number[] {
  const closes = panel.closes["BTC"];
  const out: number[] = [];
  for (let mi = startMi; mi < endMi - 1; mi += 1) {
    const a = closes[monthEnds[mi]];
    const b = closes[monthEnds[mi + 1]];
    if (a != null && b != null && a > 0 && b > 0) out.push(b / a - 1);
  }
  return out;
}

/** Equal-weight universe (linear baseline) MONTHLY return series. */
function universeMonthly(panel: DailyCloses, monthEnds: number[], startMi: number, endMi: number): number[] {
  const coins = Object.keys(panel.closes);
  const out: number[] = [];
  for (let mi = startMi; mi < endMi - 1; mi += 1) {
    let sum = 0;
    let n = 0;
    for (const coin of coins) {
      const a = panel.closes[coin][monthEnds[mi]];
      const b = panel.closes[coin][monthEnds[mi + 1]];
      if (a != null && b != null && a > 0 && b > 0) {
        sum += b / a - 1;
        n += 1;
      }
    }
    if (n > 0) out.push(sum / n);
  }
  return out;
}

// ---- Build the HONEST config grid -----------------------------------------
// N = lookbacks {1,3,6,12} x sizing {voltarget@2 targetVols, equalsign} x
//     direction {longshort, longonly}.
function buildConfigs(perSideCost: number): SlowTsmomConfig[] {
  const out: SlowTsmomConfig[] = [];
  const lookbacks = [1, 3, 6, 12];
  const directions: Array<"longshort" | "longonly"> = ["longshort", "longonly"];
  const targetVols = [0.2, 0.4]; // 2 vol-target levels
  for (const lookbackMonths of lookbacks) {
    for (const direction of directions) {
      // vol-target sizing variants
      for (const targetAnnualVol of targetVols) {
        out.push({
          lookbackMonths,
          sizing: "voltarget",
          targetAnnualVol,
          direction,
          volWindowDays: 60,
          maxLegWeight: 3,
          perSideCost,
        });
      }
      // plain equal-sign sizing variant (no vol target)
      out.push({
        lookbackMonths,
        sizing: "equalsign",
        targetAnnualVol: 0,
        direction,
        volWindowDays: 60,
        maxLegWeight: 3,
        perSideCost,
      });
    }
  }
  return out;
}

function cfgLabel(c: SlowTsmomConfig): string {
  const sz = c.sizing === "voltarget" ? `vt${c.targetAnnualVol}` : "eqsign";
  const dir = c.direction === "longshort" ? "LS" : "LO";
  return `L${c.lookbackMonths}m-${sz}-${dir}`;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("=".repeat(82));
  console.log("TRACK TA2 — SLOW vol-targeted TSMOM (monthly rebalance, managed-futures)");
  console.log("=".repeat(82));

  const panel = loadPanel();
  const T = panel.dates.length;
  const monthEnds = monthEndIndexes(panel.dates);
  const M = monthEnds.length;
  console.log(
    `panel  : ${Object.keys(panel.closes).length} coins, ${T} daily dates ` +
      `${panel.dates[0]}..${panel.dates[T - 1]} realData=${panel.realData} source=${panel.source}`,
  );
  console.log(`months : ${M} month-ends (${panel.dates[monthEnds[0]]}..${panel.dates[monthEnds[M - 1]]})`);
  console.log(
    `cost   : perp ${PER_SIDE_PERP * 1e4}bps/side (RT ${PER_SIDE_PERP * 2e4}bps), spot sens ${PER_SIDE_SPOT * 1e4}bps/side`,
  );
  console.log(`gates  : DSR>=${DSR_THRESHOLD} (p<=0.05), PBO<${PBO_THRESHOLD}, beat B&H BTC + random-lottery + linear, Harvey-Liu haircut`);

  // ---- Holdout plan: most-recent ~30% of months as one-shot vault ----------
  const holdoutPlan = planHoldoutSplit({ totalRows: M, holdoutFraction: 0.3, testFraction: 0.0 });
  const searchEndMi = holdoutPlan.search.end; // search uses month-ends [0, searchEndMi)
  const vaultStartMi = holdoutPlan.finalHoldout.start;
  const vaultEndMi = holdoutPlan.finalHoldout.end;
  assertSearchDoesNotTouchHoldout({ searchMaxIndexExclusive: searchEndMi, holdoutStartIndex: vaultStartMi });
  console.log(
    `\nholdout: search months=[0,${searchEndMi}) (${panel.dates[monthEnds[0]].slice(0, 7)}..${panel.dates[monthEnds[searchEndMi - 1]].slice(0, 7)})  ` +
      `VAULT months=[${vaultStartMi},${vaultEndMi}) (${panel.dates[monthEnds[vaultStartMi]].slice(0, 7)}..${panel.dates[monthEnds[vaultEndMi - 1]].slice(0, 7)})`,
  );

  const configs = buildConfigs(PER_SIDE_PERP);
  const TRUE_N = configs.length;
  console.log(`\nHONEST N = ${TRUE_N} configs = 4 lookbacks x 3 sizing(2 vt + 1 eqsign) x 2 direction`);

  // ===== SELF-CHECK 1: PURE NOISE — must show no net edge ====================
  console.log("\n-- self-check 1: pure-noise panels (momentum must vanish; net must NOT be positive) --");
  const noiseCfg: SlowTsmomConfig = {
    lookbackMonths: 6, sizing: "voltarget", targetAnnualVol: 0.4, direction: "longshort",
    volWindowDays: 60, maxLegWeight: 3, perSideCost: PER_SIDE_PERP,
  };
  // Use MANY seeds: a single 47-month GBM panel has a high-variance Sharpe, so 5
  // seeds is too few to see the mean collapse to its true 0 expectation. 40 seeds
  // makes the sampling noise small and the test meaningful.
  const NOISE_SEEDS = 40;
  const noiseGross: number[] = [];
  const noiseNet: number[] = [];
  let noiseNetPositiveFrac = 0;
  for (let s = 1; s <= NOISE_SEEDS; s += 1) {
    const noise = buildNoisePanel(panel, 4242 + s);
    const r = runSlowTsmom({ panel: noise, config: noiseCfg, monthEnds, startMonthIdx: 0, endMonthIdx: searchEndMi });
    const gs = annualizedSharpeMonthly(r.monthlyGross);
    const ns = annualizedSharpeMonthly(r.monthlyNet);
    noiseGross.push(gs);
    noiseNet.push(ns);
    if (compound(r.monthlyNet) > 0) noiseNetPositiveFrac += 1;
    if (s <= 5) console.log(`   seed ${s}: grossSharpe=${gs.toFixed(3)} netSharpe=${ns.toFixed(3)} netTotal=${pct(compound(r.monthlyNet))} turnover/reb=${r.avgMonthlyTurnover.toFixed(3)}`);
  }
  noiseNetPositiveFrac /= NOISE_SEEDS;
  const meanNoiseGross = mean(noiseGross);
  const meanNoiseNet = mean(noiseNet);
  // Clean = no SYSTEMATIC edge: across many GBM panels the mean Sharpe sits near 0
  // and net profitability is a coin-flip (~50%), i.e. no exploitable autocorrelation.
  const noiseClean = Math.abs(meanNoiseGross) < 0.2 && Math.abs(noiseNetPositiveFrac - 0.5) < 0.2;
  console.log(`   over ${NOISE_SEEDS} seeds: mean grossSharpe=${meanNoiseGross.toFixed(3)} (≈0)  mean netSharpe=${meanNoiseNet.toFixed(3)}  netPositiveFrac=${noiseNetPositiveFrac.toFixed(2)} (≈0.5) -> ${noiseClean ? "CLEAN (no systematic edge)" : "WARNING"}`);

  // ===== SELF-CHECK 2: causality — future mutation can't change a past month =
  console.log("\n-- self-check 2: causality (mutating the future must not change a past month's return) --");
  const causCfg: SlowTsmomConfig = { ...noiseCfg };
  const baseRun = runSlowTsmom({ panel, config: causCfg, monthEnds, startMonthIdx: 0, endMonthIdx: searchEndMi });
  const cutDay = monthEnds[searchEndMi - 3]; // mutate everything after this day
  const mutCloses: Record<string, (number | null)[]> = {};
  for (const coin of Object.keys(panel.closes)) {
    const arr = panel.closes[coin].slice();
    for (let i = cutDay + 1; i < arr.length; i += 1) if (arr[i] != null) arr[i] = (arr[i] as number) * 1.5;
    mutCloses[coin] = arr;
  }
  const mutRun = runSlowTsmom({ panel: { ...panel, closes: mutCloses }, config: causCfg, monthEnds, startMonthIdx: 0, endMonthIdx: searchEndMi });
  const cutMonth = panel.dates[cutDay].slice(0, 7);
  let maxDiff = 0;
  let compared = 0;
  for (let i = 0; i < baseRun.monthLabels.length; i += 1) {
    if (baseRun.monthLabels[i] >= cutMonth) break; // strictly-past months only
    const j = mutRun.monthLabels.indexOf(baseRun.monthLabels[i]);
    if (j >= 0) {
      maxDiff = Math.max(maxDiff, Math.abs(baseRun.monthlyNet[i] - mutRun.monthlyNet[j]));
      compared += 1;
    }
  }
  const causalityClean = maxDiff < 1e-12;
  console.log(`   compared ${compared} strictly-past months (< ${cutMonth}); max |Δnet|=${maxDiff.toExponential(2)} -> ${causalityClean ? "CAUSAL" : "LEAK!"}`);

  // ===== SEARCH on the SEARCH slice only =====================================
  console.log(`\n-- search: ${TRUE_N} configs on search slice only --`);
  interface Row {
    cfg: SlowTsmomConfig;
    label: string;
    sharpe: number;
    ann: number;
    mdd: number;
    netTotal: number;
    rt: number;
    breadth: number;
    monthlyNet: number[];
  }
  const rows: Row[] = [];
  for (const cfg of configs) {
    const r = runSlowTsmom({ panel, config: cfg, monthEnds, startMonthIdx: 0, endMonthIdx: searchEndMi });
    rows.push({
      cfg, label: cfgLabel(cfg),
      sharpe: annualizedSharpeMonthly(r.monthlyNet),
      ann: annualizedReturnMonthly(r.monthlyNet),
      mdd: maxDrawdownMonthly(r.monthlyNet),
      netTotal: compound(r.monthlyNet),
      rt: r.roundTripsPerYear,
      breadth: r.avgBreadth,
      monthlyNet: r.monthlyNet,
    });
  }
  rows.sort((a, b) => b.sharpe - a.sharpe);
  console.log("   all configs by in-sample net Sharpe (annualised):");
  for (const r of rows) {
    console.log(
      `     ${r.label.padEnd(18)} netSharpe=${r.sharpe.toFixed(3).padStart(7)} ann=${pct(r.ann).padStart(8)} ` +
        `maxDD=${pct(r.mdd).padStart(7)} RT/yr=${r.rt.toFixed(1).padStart(5)} breadth=${r.breadth.toFixed(1)}`,
    );
  }
  const chosen = rows[0];
  console.log(`\n   CHOSEN (in-sample best net Sharpe): ${chosen.label}  netSharpe=${chosen.sharpe.toFixed(3)} ann=${pct(chosen.ann)} RT/yr=${chosen.rt.toFixed(1)}`);

  // ===== CPCV / PBO across all configs (on the search slice) =================
  // Split the search months into K contiguous folds; each config's per-fold
  // monthly-net series feeds estimateCscvPbo (combinatorial purged CV).
  const K = 8;
  const searchRun = (cfg: SlowTsmomConfig) =>
    runSlowTsmom({ panel, config: cfg, monthEnds, startMonthIdx: 0, endMonthIdx: searchEndMi });
  const strategies: CscvStrategyFoldReturns[] = configs.map((cfg) => {
    const r = searchRun(cfg);
    const series = r.monthlyNet;
    const folds: number[][] = Array.from({ length: K }, () => []);
    const per = Math.ceil(series.length / K);
    for (let i = 0; i < series.length; i += 1) {
      const f = Math.min(K - 1, Math.floor(i / per));
      folds[f].push(series[i]);
    }
    return { id: cfgLabel(cfg), folds };
  });
  const pboRes = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });
  console.log(`\n-- CPCV / PBO (estimateCscvPbo, ${K} folds, statistic=sharpe) --`);
  console.log(`   strategies=${pboRes.strategyCount} folds=${pboRes.foldCount} splits=${pboRes.splitCount} PBO=${pboRes.pbo.toFixed(4)} medianLogit=${pboRes.medianLogit.toFixed(3)}`);
  const pboOk = pboRes.pbo < PBO_THRESHOLD;

  // ===== ONE-SHOT HOLD-OUT EVALUATION ========================================
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "TA2 slow-TSMOM one-shot vault", gitSha: gitSha(), trialCount: TRUE_N, nowIso: new Date().toISOString() });
  console.log("\n" + "=".repeat(82));
  console.log("ONE-SHOT HOLD-OUT (vault consumed once)");
  console.log("=".repeat(82));

  const vault = runSlowTsmom({ panel, config: chosen.cfg, monthEnds, startMonthIdx: vaultStartMi, endMonthIdx: vaultEndMi });
  const vMonthly = vault.monthlyNet;
  const vGross = vault.monthlyGross;
  const vSharpeAnn = annualizedSharpeMonthly(vMonthly);
  const vAnn = annualizedReturnMonthly(vMonthly);
  const vMdd = maxDrawdownMonthly(vMonthly);
  const vNetTotal = compound(vMonthly);
  const vGrossTotal = compound(vGross);
  const vStats = summarizeReturnSeries(vMonthly); // per-month sharpe etc.

  console.log(
    `vault TSMOM : months=${vMonthly.length} netTotal=${pct(vNetTotal)} grossTotal=${pct(vGrossTotal)} ` +
      `annNet=${pct(vAnn)} SharpeAnn=${vSharpeAnn.toFixed(3)} maxDD=${pct(vMdd)}`,
  );
  console.log(
    `             breadth=${vault.avgBreadth.toFixed(1)} turnover/reb=${vault.avgMonthlyTurnover.toFixed(3)} ` +
      `roundTrips/yr=${vault.roundTripsPerYear.toFixed(1)} totalCostDrag=${pct(vault.monthlyCost.reduce((a, b) => a + b, 0))}`,
  );

  // ---- Baselines on the SAME vault window ----------------------------------
  const btcM = btcMonthly(panel, monthEnds, vaultStartMi, vaultEndMi);
  const uniM = universeMonthly(panel, monthEnds, vaultStartMi, vaultEndMi);
  const bhBtc: BaselineScore = buildBuyAndHoldBaseline({ barReturns: btcM, roundTripCost: PER_SIDE_PERP * 2, statistic: "compoundReturn" });
  const lottery: BaselineScore = buildRandomLotteryBaseline({
    barReturns: uniM,
    tradeCount: Math.max(1, vault.rebalances),
    averageHoldingBars: 1,
    roundTripCost: PER_SIDE_PERP * 2,
    iterations: 2000,
    quantile: 0.95,
    allowShort: chosen.cfg.direction === "longshort",
    statistic: "compoundReturn",
    seed: "ta2-slow-tsmom",
  });
  const linear: BaselineScore = baselineScoreFromReturns("linear_one_layer", "Universe equal-weight (linear)", uniM, {
    statistic: "compoundReturn",
    source: "universe_equal_weight_monthly",
  });
  const baseGate = evaluateBaselineGate({
    candidateReturns: vMonthly,
    baselines: [bhBtc, lottery, linear],
    statistic: "compoundReturn",
    requirePositive: true,
  });
  console.log(`\nbaselines (vault window, compoundReturn, net of cost):`);
  console.log(`   buy&hold BTC          score=${pct(bhBtc.score)}`);
  console.log(`   random-lottery q95    score=${pct(lottery.score)}`);
  console.log(`   linear (universe EW)  score=${pct(linear.score)}`);
  console.log(`   candidate             score=${pct(baseGate.candidateScore)}`);
  for (const c of baseGate.comparisons) console.log(`     vs ${c.label.padEnd(34)} margin=${pct(c.margin).padStart(9)} beaten=${c.beaten}`);
  console.log(`   beatsAll=${baseGate.beatsAll} candidatePositive=${baseGate.candidatePositive} passed=${baseGate.passed}`);

  // ---- Deflated Sharpe with HONEST N ---------------------------------------
  const dsr = computeDeflatedSharpeRatio(vMonthly, { trialCount: TRUE_N });
  const dsrP = dsr.deflatedProbability;
  const dsrOk = dsrP >= DSR_THRESHOLD;
  console.log(`\nDSR (honest N=${TRUE_N}): per-month sharpe=${dsr.sharpe.toFixed(4)} DSR prob=${dsrP.toFixed(4)} (>=${DSR_THRESHOLD}? ${dsrOk})  expMaxSharpe=${dsr.expectedMaxSharpe.toFixed(4)}`);
  console.log(`   p-value (1-DSR) = ${(1 - dsrP).toFixed(4)}  ${dsrOk ? "" : "(NOT significant after deflation)"}`);

  // ---- Harvey-Liu multiple-testing haircut ---------------------------------
  const hc = haircutSharpe({ observedSharpe: vStats.sharpe, sampleCount: vMonthly.length, trialCount: TRUE_N, method: "bhy" });
  const hcBonf = haircutSharpe({ observedSharpe: vStats.sharpe, sampleCount: vMonthly.length, trialCount: TRUE_N, method: "bonferroni" });
  const haircutOk = hc.haircutSharpe > 0 && hc.adjustedPValue <= 0.05;
  console.log(`\nHarvey-Liu haircut (N=${TRUE_N}): observed per-month sharpe=${hc.observedSharpe.toFixed(4)}`);
  console.log(`   BHY:        p=${hc.pValue.toFixed(4)} -> adj p=${hc.adjustedPValue.toFixed(4)} haircutSharpe=${hc.haircutSharpe.toFixed(4)} haircut=${pct(hc.haircut)}`);
  console.log(`   Bonferroni: adj p=${hcBonf.adjustedPValue.toFixed(4)} haircutSharpe=${hcBonf.haircutSharpe.toFixed(4)}`);
  console.log(`   haircut survives (positive & adj p<=0.05)? ${haircutOk}`);

  // ---- Cost sensitivity: spot-only 20 bps round-trip -----------------------
  const chosenSpot: SlowTsmomConfig = { ...chosen.cfg, perSideCost: PER_SIDE_SPOT };
  const vaultSpot = runSlowTsmom({ panel, config: chosenSpot, monthEnds, startMonthIdx: vaultStartMi, endMonthIdx: vaultEndMi });
  console.log(`\ncost sensitivity (spot 10bps/side = 20bps RT): vault netSharpe=${annualizedSharpeMonthly(vaultSpot.monthlyNet).toFixed(3)} annNet=${pct(annualizedReturnMonthly(vaultSpot.monthlyNet))} netTotal=${pct(compound(vaultSpot.monthlyNet))}`);

  // ===== VERDICT =============================================================
  const netPositive = vNetTotal > 0;
  const survive = netPositive && vSharpeAnn > 0 && baseGate.passed && dsrOk && pboOk && haircutOk && noiseClean && causalityClean;

  // Identify the BINDING gate. Order by the economic gates first (cost is what
  // kills crypto trend), then the rigor gates, then the sanity self-checks. The
  // noise self-check is a small-sample sanity flag, NOT the economic reason a
  // live strategy dies, so it is reported last.
  let killedBy = "none";
  if (!netPositive || vSharpeAnn <= 0) killedBy = "cost (net Sharpe<=0)";
  else if (!baseGate.passed) killedBy = "baselines";
  else if (!dsrOk) killedBy = "DSR";
  else if (!pboOk) killedBy = "PBO";
  else if (!haircutOk) killedBy = "haircut";
  else if (!causalityClean) killedBy = "self-check-causality";
  else if (!noiseClean) killedBy = "self-check-noise";

  console.log("\n" + "=".repeat(82));
  console.log("VERDICT");
  console.log("=".repeat(82));
  console.log(`  net-of-cost positive       : ${netPositive} (${pct(vNetTotal)}), annNet=${pct(vAnn)}`);
  console.log(`  net Sharpe (ann) > 0       : ${vSharpeAnn > 0} (${vSharpeAnn.toFixed(3)})`);
  console.log(`  beats ALL baselines        : ${baseGate.passed} (B&H BTC, random-lottery, linear)`);
  console.log(`  DSR(N=${TRUE_N}) >= 0.95        : ${dsrOk} (${dsrP.toFixed(4)}, p=${(1 - dsrP).toFixed(4)})`);
  console.log(`  PBO < 0.5                  : ${pboOk} (${pboRes.pbo.toFixed(4)})`);
  console.log(`  Harvey-Liu haircut survives: ${haircutOk} (adj p=${hc.adjustedPValue.toFixed(4)})`);
  console.log(`  self-checks (noise/causal) : ${noiseClean}/${causalityClean}`);
  console.log(`\n  ==> ${survive ? "SURVIVE" : "KILL"}${survive ? "" : `  (killed by: ${killedBy})`}`);
  console.log("=".repeat(82));

  // ---- Realistic monthly $ if survived -------------------------------------
  let monthlyDollars = "n/a — killed";
  if (survive) {
    const monthlyMean = mean(vMonthly.filter((x) => Number.isFinite(x)));
    monthlyDollars = `${pct(monthlyMean)}/mo net -> $${(monthlyMean * 10000).toFixed(0)}/mo at $10k, $${(monthlyMean * 100000).toFixed(0)}/mo at $100k`;
    console.log(`\n  realistic net monthly: ${monthlyDollars}`);
  }

  // ---- Persist a summary artifact ------------------------------------------
  const summary = {
    track: "TA2-slow-vol-targeted-TSMOM-monthly",
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    dataSource: "output/crossxs/daily-closes.json (30-coin Binance panel, realData=true; 8 majors are a subset)",
    panel: { coins: Object.keys(panel.closes).length, dailyDates: T, months: M, span: `${panel.dates[0]}..${panel.dates[T - 1]}` },
    honestN: TRUE_N,
    cost: { perSidePerpBps: PER_SIDE_PERP * 1e4, roundTripPerpBps: PER_SIDE_PERP * 2e4, spotSensRoundTripBps: PER_SIDE_SPOT * 2e4 },
    holdout: {
      searchMonths: [0, searchEndMi],
      vaultMonths: [vaultStartMi, vaultEndMi],
      searchSpan: `${panel.dates[monthEnds[0]].slice(0, 7)}..${panel.dates[monthEnds[searchEndMi - 1]].slice(0, 7)}`,
      vaultSpan: `${panel.dates[monthEnds[vaultStartMi]].slice(0, 7)}..${panel.dates[monthEnds[vaultEndMi - 1]].slice(0, 7)}`,
    },
    chosenConfig: { ...chosen.cfg, label: chosen.label },
    inSample: { netSharpeAnn: chosen.sharpe, annNet: chosen.ann, roundTripsPerYear: chosen.rt },
    vault: {
      months: vMonthly.length, netTotal: vNetTotal, grossTotal: vGrossTotal, annNet: vAnn,
      netSharpeAnn: vSharpeAnn, perMonthSharpe: vStats.sharpe, maxDD: vMdd,
      roundTripsPerYear: vault.roundTripsPerYear, breadth: vault.avgBreadth,
    },
    gates: {
      netPositive, netSharpePositive: vSharpeAnn > 0,
      baselines: { passed: baseGate.passed, beatsAll: baseGate.beatsAll, comparisons: baseGate.comparisons },
      dsr: { prob: dsrP, pValue: 1 - dsrP, passed: dsrOk, trialCount: TRUE_N, perMonthSharpe: dsr.sharpe },
      pbo: { value: pboRes.pbo, passed: pboOk, folds: K, splits: pboRes.splitCount },
      haircut: { bhyAdjP: hc.adjustedPValue, bonferroniAdjP: hcBonf.adjustedPValue, haircutSharpe: hc.haircutSharpe, passed: haircutOk },
      selfChecks: { noiseClean, causalityClean },
    },
    costSensitivitySpot: {
      netSharpeAnn: annualizedSharpeMonthly(vaultSpot.monthlyNet),
      annNet: annualizedReturnMonthly(vaultSpot.monthlyNet),
      netTotal: compound(vaultSpot.monthlyNet),
    },
    verdict: survive ? "SURVIVE" : "KILL",
    killedBy: survive ? "none" : killedBy,
    monthlyIfSurvived: monthlyDollars,
    allConfigsInSample: rows.map((r) => ({ label: r.label, netSharpe: r.sharpe, ann: r.ann, roundTripsPerYear: r.rt })),
  };
  const outPath = join(OUT_DIR, "ta2-slow-tsmom-summary.json");
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main();
