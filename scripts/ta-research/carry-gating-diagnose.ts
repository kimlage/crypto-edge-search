/**
 * TRACK TA1 — Diagnostic companion to carry-gating.ts.
 *
 * Sharper questions:
 *  (A) Does ANY gating rule that ACTUALLY deploys carry (on-fraction meaningfully
 *      >0) beat always-on carry net-of-cost AND beat risk-free, IN-SAMPLE and on
 *      the consume-once holdout?
 *  (B) Does gating dodge the Feb-Apr 2026 negative-funding months month-by-month?
 *  (C) Honest re-statement of the winner so we don't reward a degenerate
 *      "sit in risk-free 95% of the time" rule that merely avoids carry.
 *
 * Reuses the same causal carry book, cost model, and committed gates.
 */

import * as fs from "fs";
import * as path from "path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
} from "../../src/lib/statistical-validation";

const ROOT = process.cwd().endsWith("crypto-edge-search")
  ? process.cwd()
  : path.resolve(process.cwd(), "crypto-edge-search");
const FUND_DIR = path.join(ROOT, "output/funding");
const OUT_DIR = path.join(ROOT, "output/ta-research");

const SPOT_TAKER_BPS = 10;
const PERP_TAKER_BPS = 4;
const TOGGLE_ONE_WAY_BPS = SPOT_TAKER_BPS + PERP_TAKER_BPS; // 14 bps
const RISK_FREE_APR = 0.045;
const PERIODS_PER_YEAR = 1095.75;
const RF_PER_PERIOD = RISK_FREE_APR / PERIODS_PER_YEAR;
const ANNUALIZE_SHARPE = Math.sqrt(PERIODS_PER_YEAR);

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "BNBUSDT"];

interface FundingPt { fundingTime: number; fundingRate: number; }
interface PricePt { date: string; spotClose: number; perpClose: number; }
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};

interface BookPeriod { t: number; date: string; month: string; carryRet: number; meanFunding: number; meanPremium: number; }

function buildBook(): BookPeriod[] {
  const perSym = new Map<string, Map<number, { f: number; prem: number; date: string }>>();
  const allTimes = new Set<number>();
  for (const sym of SYMBOLS) {
    const fund: FundingPt[] = JSON.parse(fs.readFileSync(path.join(FUND_DIR, `${sym}_funding_8h.json`), "utf8"));
    const prices: PricePt[] = JSON.parse(fs.readFileSync(path.join(FUND_DIR, `${sym}_prices_daily.json`), "utf8"));
    const premByDate = new Map<string, number>();
    for (const p of prices) if (p.spotClose > 0) premByDate.set(p.date, p.perpClose / p.spotClose - 1);
    const m = new Map<number, { f: number; prem: number; date: string }>();
    for (const f of fund) {
      const date = new Date(f.fundingTime).toISOString().slice(0, 10);
      const prem = premByDate.get(date);
      if (prem === undefined) continue;
      m.set(f.fundingTime, { f: f.fundingRate, prem, date });
      allTimes.add(f.fundingTime);
    }
    perSym.set(sym, m);
  }
  const times = [...allTimes].sort((a, b) => a - b);
  const book: BookPeriod[] = [];
  for (const t of times) {
    const fs2: number[] = [], pr: number[] = [];
    let date = "";
    for (const sym of SYMBOLS) {
      const x = perSym.get(sym)!.get(t);
      if (!x) continue;
      fs2.push(x.f); pr.push(x.prem); date = x.date;
    }
    if (!fs2.length) continue;
    book.push({ t, date, month: date.slice(0, 7), carryRet: mean(fs2), meanFunding: mean(fs2), meanPremium: mean(pr) });
  }
  return book;
}

function trailing(arr: number[], i: number, win: number) { return arr.slice(Math.max(0, i - win), i); }

type GateFn = (i: number) => boolean;

function applyGate(book: BookPeriod[], gate: GateFn) {
  const net: number[] = [], gross: number[] = [];
  let prevOn = false, toggles = 0, onCount = 0;
  const onFlags: boolean[] = [];
  for (let i = 0; i < book.length; i++) {
    const on = gate(i);
    const base = on ? book[i].carryRet : RF_PER_PERIOD;
    let cost = 0;
    if (on !== prevOn) { cost = TOGGLE_ONE_WAY_BPS / 10_000; toggles++; }
    gross.push(base); net.push(base - cost); onFlags.push(on);
    if (on) onCount++; prevOn = on;
  }
  return { net, gross, toggles, fracOn: onCount / book.length, onFlags };
}
function alwaysOnNet(book: BookPeriod[]) {
  return book.map((b, i) => (i === 0 ? b.carryRet - TOGGLE_ONE_WAY_BPS / 10_000 : b.carryRet));
}
const annRet = (r: number[]) => mean(r) * PERIODS_PER_YEAR;
const annSharpe = (r: number[]) => summarizeReturnSeries(r).sharpe * ANNUALIZE_SHARPE;

// Monthly aggregation of a net series
function monthly(book: BookPeriod[], net: number[]) {
  const byM = new Map<string, number>();
  for (let i = 0; i < book.length; i++) byM.set(book[i].month, (byM.get(book[i].month) ?? 0) + net[i]);
  return byM;
}

function main() {
  const book = buildBook();
  const fundingArr = book.map((b) => b.meanFunding);

  // The ONE gate that beats always-on with real carry exposure (from search):
  // funding LEVEL, lookback 120, threshold 0.00005 -> ON when trailing-40d mean
  // funding > 0.5bp/8h. This is the only "real" candidate; the others just sit
  // in risk-free.
  const bestRealGate: GateFn = (i) => {
    const past = trailing(fundingArr, i, 120);
    if (past.length < 3) return false;
    return mean(past) > 0.00005;
  };

  const splitIdx = Math.floor(book.length * 0.8);
  const holdBook = book.slice(splitIdx);

  const fullRun = applyGate(book, bestRealGate);
  const ao = alwaysOnNet(book);
  const rf = book.map(() => RF_PER_PERIOD);

  console.log("=== BEST REAL-EXPOSURE GATE: funding_level lb120 th0.00005 (ON iff trailing-40d funding > 0.5bp/8h) ===");
  console.log(`Full sample (${book[0].date}..${book[book.length-1].date}):`);
  console.log(`  gated     net annRet ${(annRet(fullRun.net) * 100).toFixed(2)}%  Sharpe ${annSharpe(fullRun.net).toFixed(2)}  on% ${(fullRun.fracOn * 100).toFixed(0)}  toggles ${fullRun.toggles}`);
  console.log(`  always-on net annRet ${(annRet(ao) * 100).toFixed(2)}%  Sharpe ${annSharpe(ao).toFixed(2)}`);
  console.log(`  risk-free net annRet ${(annRet(rf) * 100).toFixed(2)}%`);

  // Holdout slices (consume-once)
  const gHold = fullRun.net.slice(splitIdx);
  const aoHold = ao.slice(splitIdx);
  const rfHold = rf.slice(splitIdx);
  console.log(`\nHoldout (${holdBook[0].date}..${holdBook[holdBook.length-1].date}):`);
  console.log(`  gated     net annRet ${(annRet(gHold) * 100).toFixed(2)}%  Sharpe ${annSharpe(gHold).toFixed(2)}  on% ${(mean(fullRun.onFlags.slice(splitIdx).map(b=>b?1:0))*100).toFixed(0)}`);
  console.log(`  always-on net annRet ${(annRet(aoHold) * 100).toFixed(2)}%  Sharpe ${annSharpe(aoHold).toFixed(2)}`);
  console.log(`  risk-free net annRet ${(annRet(rfHold) * 100).toFixed(2)}%`);

  // ----- (B) Month-by-month: does gating dodge the bad months? -----
  const mG = monthly(book, fullRun.net);
  const mAO = monthly(book, ao);
  console.log(`\n=== Month-by-month NET % (last 16 months): gated vs always-on ===`);
  console.log(`  month    gated%   alwaysOn%   gate ON?`);
  const months = [...mAO.keys()].sort().slice(-16);
  for (const mo of months) {
    // fraction of month the gate was ON
    let on = 0, tot = 0;
    for (let i = 0; i < book.length; i++) if (book[i].month === mo) { tot++; if (fullRun.onFlags[i]) on++; }
    const onPct = tot ? (on / tot) * 100 : 0;
    console.log(`  ${mo}  ${((mG.get(mo) ?? 0) * 100).toFixed(3).padStart(7)}  ${((mAO.get(mo) ?? 0) * 100).toFixed(3).padStart(8)}     ${onPct.toFixed(0).padStart(3)}%`);
  }

  // ----- (C) Honest comparison: gated EXCESS over always-on -----
  // Per-period difference (gated - always-on), is it reliably positive?
  const diff = fullRun.net.map((x, i) => x - ao[i]);
  const dStats = summarizeReturnSeries(diff);
  const dsrDiff = computeDeflatedSharpeRatio(diff, { trialCount: 69, benchmarkSharpe: 0 });
  console.log(`\n=== Gated MINUS always-on (per-period edge of gating itself) ===`);
  console.log(`  mean diff/period ${(dStats.mean * 1e4).toFixed(3)} bps  annualized ${(annRet(diff) * 100).toFixed(2)}%  Sharpe(ann) ${(dStats.sharpe * ANNUALIZE_SHARPE).toFixed(2)}`);
  console.log(`  DSR of the gating-vs-alwaysOn edge (N=69): deflatedProb ${dsrDiff.deflatedProbability.toFixed(3)} => p ${(1 - dsrDiff.deflatedProbability).toExponential(2)}`);

  // ----- Excess over risk-free for the gated book, full sample -----
  const exc = fullRun.net.map((x) => x - RF_PER_PERIOD);
  console.log(`\n  Gated EXCESS over risk-free, full sample: annualized ${(annRet(exc) * 100).toFixed(2)}%  Sharpe(ann) ${(summarizeReturnSeries(exc).sharpe * ANNUALIZE_SHARPE).toFixed(2)}`);
  const excHold = gHold.map((x) => x - RF_PER_PERIOD);
  console.log(`  Gated EXCESS over risk-free, HOLDOUT:     annualized ${(annRet(excHold) * 100).toFixed(2)}%  Sharpe(ann) ${(summarizeReturnSeries(excHold).sharpe * ANNUALIZE_SHARPE).toFixed(2)}`);
}

main();
