/**
 * TARGET 2 — Cross-sectional momentum done RIGHT (market-neutral, vol-scaled,
 * dollar-neutral). Read-only audit; writes nothing; starts no training loop.
 *
 * This fixes E1's long-only / survivorship "leveraged-bull" artifact. Instead of
 * holding the top-momentum coins long (which in a survivorship-biased liquid-today
 * universe is just a leveraged beta bet on coins that happened to survive), we run
 * a CROSS-SECTIONAL long/short:
 *   - LONG the top tercile by K-week trailing momentum,
 *   - SHORT the bottom tercile,
 *   - each leg VOL-SCALED (inverse trailing vol weights),
 *   - each leg normalized to 0.5 gross so the book is DOLLAR-NEUTRAL (net ~0).
 * The portfolio return is therefore (mostly) market-beta-neutral: it pays only if
 * the momentum CROSS-SECTION (winners minus losers) has edge, not if crypto went up.
 *
 * CAUSALITY: the signal at rebalance t uses only weekly returns with index <= t-1
 * (momentum = product of returns over weeks [t-K, t-1]; trailing vol over the same
 * window). The realized P&L is the week-t return. Pre-listing weeks are `null` and
 * a coin is only eligible when it has a full K-week history AND a vol window.
 *
 * COST: 28 bps round-trip default (spot USDT both legs). Turnover-charged: each
 * rebalance pays (roundTrip/2) on the L1 change of weights vs the drifted book.
 *
 * METHOD (mirrors scripts/audit-population-significance.ts wiring):
 *   1) Transparent, causal rule. Log turnover.
 *   2) Self-check: PURE-NOISE panel must show ~no edge; a FUTURE-DATA mutation
 *      (scrambling returns AFTER the decision week) must not change an earlier
 *      decision (causality).
 *   3) Search K in {2,4,8,12} on the SEARCH slice only. Record TRUE N.
 *   4) Reserve most-recent ~24 months as a one-shot hold-out (consume-once guard).
 *      Evaluate the chosen K ONCE through evaluatePromotion.
 *   5) Apply 50% McLean-Pontiff decay haircut. PROMOTE only if on the hold-out:
 *      net>0, beats baselines, DSR(true N)>=0.95, MinBTL ok, haircut>0.
 *
 * Pure reuse of the committed rigour cores — no statistics reimplemented here.
 *
 * Run:
 *   PATH=.../node/bin:$PATH node_modules/.bin/tsx scripts/audit-crossxs-neutral.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import {
  planHoldoutSplit,
  assertSearchDoesNotTouchHoldout,
  FinalHoldoutGuard,
} from "../src/lib/significance/holdout";
import { effectiveTrialCount, evaluateMinBtl } from "../src/lib/significance/trial-count";
import { summarizeReturnSeries } from "../src/lib/statistical-validation";

// --------------------------------------------------------------------------
// Data
// --------------------------------------------------------------------------

interface WeeklyReturns {
  source: string;
  realData: boolean;
  weeks: string[];
  weeklyRet: Record<string, (number | null)[]>;
}

const ROOT = process.cwd();
const ROUND_TRIP = 0.0028; // 28 bps spot USDT, both legs (per cost-realism rule)
const HAIRCUT = 0.5; // McLean & Pontiff (2016) ~50% post-publication decay
const K_GRID = [2, 4, 8, 12] as const;
const DSR_THRESHOLD = 0.95;

function loadWeekly(): WeeklyReturns {
  const path = join(ROOT, "output", "crossxs", "weekly-returns.json");
  return JSON.parse(readFileSync(path, "utf8")) as WeeklyReturns;
}

// --------------------------------------------------------------------------
// Deterministic PRNG (for noise self-check only; the strategy itself is
// fully deterministic given the panel).
// --------------------------------------------------------------------------

function mulberry32(seedStr: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i += 1) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --------------------------------------------------------------------------
// Strategy engine — market-neutral, vol-scaled, dollar-neutral X-sectional MOM.
// --------------------------------------------------------------------------

interface StrategyResult {
  /** Net-of-cost weekly portfolio returns, one per rebalanced week. */
  netReturns: number[];
  /** Gross (pre-cost) weekly returns, aligned to netReturns. */
  grossReturns: number[];
  /** Per-week one-way turnover (sum |dw|/2 ... actually sum|dw| total notional traded). */
  turnoverPerWeek: number[];
  /** Per-week net market exposure (sum of signed weights) — should be ~0. */
  netExposurePerWeek: number[];
  /** Per-week count of names in each leg. */
  legSizePerWeek: number[];
  weekIndexes: number[]; // global week index of each realized return
  avgTurnover: number;
  rebalanceCount: number;
}

/**
 * Build inverse-vol, dollar-neutral target weights at rebalance time `t`,
 * using ONLY returns with index in [t-K, t-1] (and a trailing vol window of the
 * same K). Returns a map symbol -> signed weight (long positive, short negative),
 * with sum(|w|)=1 and sum(w)~0 (each leg 0.5 gross).
 */
function targetWeights(
  weekly: WeeklyReturns,
  symbols: string[],
  t: number,
  K: number,
): Map<string, number> {
  const weights = new Map<string, number>();
  if (t - K < 0) return weights;

  // Eligible = full window of finite returns over [t-K, t-1].
  type Row = { sym: string; mom: number; vol: number };
  const rows: Row[] = [];
  for (const sym of symbols) {
    const series = weekly.weeklyRet[sym]!;
    let ok = true;
    const window: number[] = [];
    for (let i = t - K; i < t; i += 1) {
      const r = series[i];
      if (r === null || !Number.isFinite(r)) {
        ok = false;
        break;
      }
      window.push(r);
    }
    if (!ok || window.length < K) continue;
    // Momentum = compound return over the window (log-sum then expm1).
    let logSum = 0;
    for (const r of window) logSum += Math.log1p(Math.max(-0.999999, r));
    const mom = Math.expm1(logSum);
    // Trailing vol = sample std of the window returns (same causal window).
    const mean = window.reduce((s, x) => s + x, 0) / window.length;
    const variance =
      window.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, window.length - 1);
    const vol = Math.sqrt(Math.max(1e-8, variance));
    rows.push({ sym, mom, vol });
  }

  // Need enough names to form non-trivial terciles.
  if (rows.length < 6) return weights;

  rows.sort((a, b) => b.mom - a.mom); // best momentum first
  const tercile = Math.max(1, Math.floor(rows.length / 3));
  const longs = rows.slice(0, tercile);
  const shorts = rows.slice(rows.length - tercile);

  // Inverse-vol raw weights per leg, then normalize each leg to 0.5 gross.
  const longInv = longs.map((r) => ({ sym: r.sym, w: 1 / r.vol }));
  const shortInv = shorts.map((r) => ({ sym: r.sym, w: 1 / r.vol }));
  const longSum = longInv.reduce((s, x) => s + x.w, 0);
  const shortSum = shortInv.reduce((s, x) => s + x.w, 0);
  if (longSum <= 0 || shortSum <= 0) return weights;

  for (const { sym, w } of longInv) weights.set(sym, 0.5 * (w / longSum));
  for (const { sym, w } of shortInv) weights.set(sym, -0.5 * (w / shortSum));
  return weights;
}

function runStrategy(
  weekly: WeeklyReturns,
  K: number,
  startWeek: number,
  endWeek: number, // exclusive
): StrategyResult {
  const symbols = Object.keys(weekly.weeklyRet);
  const netReturns: number[] = [];
  const grossReturns: number[] = [];
  const turnoverPerWeek: number[] = [];
  const netExposurePerWeek: number[] = [];
  const legSizePerWeek: number[] = [];
  const weekIndexes: number[] = [];

  // Previous DRIFTED weights at the moment of rebalance (after last week's returns
  // moved the book). For a weekly rebalance to fresh targets, turnover is the L1
  // distance between the new target and the drifted previous book.
  let prevDrifted = new Map<string, number>();

  for (let t = Math.max(startWeek, K); t < endWeek; t += 1) {
    const target = targetWeights(weekly, symbols, t, K);
    if (target.size === 0) {
      // Flat week: no eligible book. Reset drift; no return contribution.
      prevDrifted = new Map();
      continue;
    }

    // Turnover = total notional traded to move from drifted prev book to target.
    const allNames = new Set<string>([...target.keys(), ...prevDrifted.keys()]);
    let turnover = 0;
    for (const name of allNames) {
      const tw = target.get(name) ?? 0;
      const pw = prevDrifted.get(name) ?? 0;
      turnover += Math.abs(tw - pw);
    }
    // Cost: each unit of notional traded crosses the spread once -> roundTrip/2 per
    // unit of |dw| (a full position open+close over its life pays roundTrip total).
    const cost = turnover * (ROUND_TRIP / 2);

    // Realize week-t returns on the target book.
    let gross = 0;
    let netExposure = 0;
    const drifted = new Map<string, number>();
    for (const [name, w] of target) {
      const r = weekly.weeklyRet[name]![t];
      const rv = r === null || !Number.isFinite(r) ? 0 : r;
      gross += w * rv;
      netExposure += w;
      // Drift the weight by its own return for next week's turnover comparison.
      drifted.set(name, w * (1 + rv));
    }

    const net = gross - cost;
    netReturns.push(net);
    grossReturns.push(gross);
    turnoverPerWeek.push(turnover);
    netExposurePerWeek.push(netExposure);
    legSizePerWeek.push(target.size);
    weekIndexes.push(t);
    prevDrifted = drifted;
  }

  const avgTurnover =
    turnoverPerWeek.length > 0
      ? turnoverPerWeek.reduce((s, x) => s + x, 0) / turnoverPerWeek.length
      : 0;

  return {
    netReturns,
    grossReturns,
    turnoverPerWeek,
    netExposurePerWeek,
    legSizePerWeek,
    weekIndexes,
    avgTurnover,
    rebalanceCount: netReturns.length,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function pct(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(3)}%`;
}

function annualizeFromWeekly(weeklyReturns: number[]): { apr: number; maxDD: number } {
  if (weeklyReturns.length === 0) return { apr: 0, maxDD: 0 };
  let logSum = 0;
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of weeklyReturns) {
    logSum += Math.log1p(Math.max(-0.999999, r));
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const totalLog = logSum;
  const years = weeklyReturns.length / 52;
  const apr = years > 0 ? Math.expm1(totalLog / years) : 0;
  return { apr, maxDD };
}

/** Buy & hold of an equal-weight long-only basket over the window (the relevant
 *  market baseline for a crypto book), net of one round trip. */
function universeBuyHoldWeekly(
  weekly: WeeklyReturns,
  startWeek: number,
  endWeek: number,
): number[] {
  const symbols = Object.keys(weekly.weeklyRet);
  const out: number[] = [];
  for (let t = startWeek; t < endWeek; t += 1) {
    let sum = 0;
    let n = 0;
    for (const s of symbols) {
      const r = weekly.weeklyRet[s]![t];
      if (r !== null && Number.isFinite(r)) {
        sum += r;
        n += 1;
      }
    }
    out.push(n > 0 ? sum / n : 0);
  }
  return out;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main(): void {
  const weekly = loadWeekly();
  const W = weekly.weeks.length;

  console.log("=".repeat(80));
  console.log("TARGET 2 — CROSS-SECTIONAL MOMENTUM, MARKET-NEUTRAL / VOL-SCALED / DOLLAR-NEUTRAL");
  console.log("=".repeat(80));
  console.log(`panel        : ${Object.keys(weekly.weeklyRet).length} coins, ${W} weeks ` +
    `(${weekly.weeks[0]} -> ${weekly.weeks[W - 1]}), source=${weekly.source} realData=${weekly.realData}`);
  console.log(`rule         : long top-tercile / short bottom-tercile by K-week MOM,`);
  console.log(`               inverse-vol weights, each leg 0.5 gross => dollar-neutral.`);
  console.log(`cost         : ${(ROUND_TRIP * 1e4).toFixed(0)} bps round-trip, turnover-charged (roundTrip/2 per |dw|).`);
  console.log(`K grid       : {${K_GRID.join(", ")}} weeks`);

  // --- Hold-out plan: most-recent ~24 months reserved as the one-shot vault. ----
  // 24 months ~ 104 weeks. With W=301, that is ~0.345 fraction. We carve via the
  // committed planHoldoutSplit with no posterior `test` block (testFraction=0) so
  // the vault is exactly the most-recent block; the search owns everything older.
  const holdoutFraction = 104 / W;
  const plan = planHoldoutSplit({ totalRows: W, holdoutFraction, testFraction: 0 });
  const searchEnd = plan.search.end; // exclusive
  const holdoutStart = plan.finalHoldout.start;
  const holdoutEnd = plan.finalHoldout.end;

  console.log("\n-- Hold-out plan (consume-once vault = most-recent ~24 months) --");
  console.log(`  search weeks : [0, ${searchEnd}) -> ${weekly.weeks[0]} .. ${weekly.weeks[searchEnd - 1]}`);
  console.log(`  vault weeks  : [${holdoutStart}, ${holdoutEnd}) -> ${weekly.weeks[holdoutStart]} .. ${weekly.weeks[holdoutEnd - 1]}`);

  // ============================================================================
  // STEP 2 — SELF-CHECKS (no hallucination + causality)
  // ============================================================================
  console.log("\n" + "-".repeat(80));
  console.log("SELF-CHECK 1 — pure-noise panel must NOT show edge");
  console.log("-".repeat(80));
  // Build a noise panel matching the eligibility mask (so terciles still form) but
  // with i.i.d. gaussian returns (no cross-sectional momentum structure).
  const rng = mulberry32("crossxs-noise-v1");
  const noisePanel: WeeklyReturns = {
    source: "synthetic-noise",
    realData: false,
    weeks: weekly.weeks,
    weeklyRet: {},
  };
  for (const sym of Object.keys(weekly.weeklyRet)) {
    const orig = weekly.weeklyRet[sym]!;
    noisePanel.weeklyRet[sym] = orig.map((v) =>
      v === null ? null : gaussian(rng) * 0.06, // ~6% weekly vol, zero mean, i.i.d.
    );
  }
  for (const K of K_GRID) {
    const res = runStrategy(noisePanel, K, K, searchEnd);
    const stats = summarizeReturnSeries(res.netReturns);
    console.log(
      `  K=${String(K).padStart(2)}  noise net compound=${pct(stats.compoundReturn)} ` +
        `mean/wk=${pct(stats.mean)} sharpe=${stats.sharpe.toFixed(3)} n=${res.rebalanceCount}`,
    );
  }
  console.log("  PASS criterion: noise compound/mean ~ 0 and |sharpe| small (no manufactured edge).");

  console.log("\n" + "-".repeat(80));
  console.log("SELF-CHECK 2 — causality: mutating FUTURE returns must not change an earlier decision");
  console.log("-".repeat(80));
  // Decision week to probe (inside the search slice). Capture the target book,
  // then scramble all returns at weeks > probe and re-derive the SAME book.
  const probe = Math.min(searchEnd - 1, 120);
  const Kprobe = 8;
  const symbols = Object.keys(weekly.weeklyRet);
  const before = targetWeights(weekly, symbols, probe, Kprobe);
  const mutated: WeeklyReturns = {
    source: weekly.source,
    realData: weekly.realData,
    weeks: weekly.weeks,
    weeklyRet: {},
  };
  const rng2 = mulberry32("future-mutation-v1");
  for (const sym of symbols) {
    const orig = weekly.weeklyRet[sym]!;
    mutated.weeklyRet[sym] = orig.map((v, i) => {
      if (i <= probe) return v; // keep the causal past identical
      return v === null ? null : gaussian(rng2); // corrupt the future
    });
  }
  const after = targetWeights(mutated, symbols, probe, Kprobe);
  let maxDelta = 0;
  const names = new Set<string>([...before.keys(), ...after.keys()]);
  for (const n of names) {
    maxDelta = Math.max(maxDelta, Math.abs((before.get(n) ?? 0) - (after.get(n) ?? 0)));
  }
  const causal = maxDelta < 1e-12;
  console.log(`  probe week   : idx ${probe} (${weekly.weeks[probe]}), K=${Kprobe}`);
  console.log(`  book size    : before=${before.size} after=${after.size}`);
  console.log(`  max |dw|     : ${maxDelta.toExponential(3)}`);
  console.log(`  causal       : ${causal ? "YES (identical book — no future leakage)" : "NO — LEAK!"}`);

  if (!causal) {
    console.log("\nABORT: causality self-check failed; the rule leaks future data.");
    process.exit(1);
  }

  // ============================================================================
  // STEP 3 — SEARCH on the SEARCH slice only; pick best K; record TRUE N.
  // ============================================================================
  console.log("\n" + "-".repeat(80));
  console.log("SEARCH — choose best K on the SEARCH slice ONLY (vault untouched)");
  console.log("-".repeat(80));
  // Anti-leakage assertion: the search must never read into the vault.
  assertSearchDoesNotTouchHoldout({ searchMaxIndexExclusive: searchEnd, holdoutStartIndex: holdoutStart });

  interface SearchRow {
    K: number;
    n: number;
    compound: number;
    meanWk: number;
    sharpe: number;
    apr: number;
    maxDD: number;
    avgTurnover: number;
    avgNetExposure: number;
  }
  const searchRows: SearchRow[] = [];
  for (const K of K_GRID) {
    const res = runStrategy(weekly, K, K, searchEnd);
    const stats = summarizeReturnSeries(res.netReturns);
    const ann = annualizeFromWeekly(res.netReturns);
    const avgNet =
      res.netExposurePerWeek.reduce((s, x) => s + x, 0) / Math.max(1, res.netExposurePerWeek.length);
    searchRows.push({
      K,
      n: res.rebalanceCount,
      compound: stats.compoundReturn,
      meanWk: stats.mean,
      sharpe: stats.sharpe,
      apr: ann.apr,
      maxDD: ann.maxDD,
      avgTurnover: res.avgTurnover,
      avgNetExposure: avgNet,
    });
    console.log(
      `  K=${String(K).padStart(2)}  net=${pct(stats.compoundReturn)} ` +
        `mean/wk=${pct(stats.mean)} sharpe=${stats.sharpe.toFixed(3)} ` +
        `APR=${pct(ann.apr)} maxDD=${pct(ann.maxDD)} ` +
        `turn=${res.avgTurnover.toFixed(3)} netExp=${avgNet.toFixed(4)} n=${res.rebalanceCount}`,
    );
  }

  // Pick best K by in-sample Sharpe (the canonical selection statistic). TRUE N is
  // the number of distinct configs we evaluated against the search slice.
  const trueN = effectiveTrialCount({ explicitTrialCount: K_GRID.length });
  const chosen = [...searchRows].sort((a, b) => b.sharpe - a.sharpe)[0]!;
  console.log(
    `\n  -> chosen K = ${chosen.K} (best in-sample Sharpe=${chosen.sharpe.toFixed(3)}). TRUE N = ${trueN} configs.`,
  );

  // ============================================================================
  // STEP 4 — ONE-SHOT hold-out evaluation through evaluatePromotion.
  // ============================================================================
  console.log("\n" + "-".repeat(80));
  console.log("HOLD-OUT — evaluate the chosen K ONCE on the vault (consume-once)");
  console.log("-".repeat(80));
  const guard = new FinalHoldoutGuard();
  guard.consume({
    reason: `crossxs-neutral K=${chosen.K} one-shot holdout`,
    trialCount: trueN,
    nowIso: new Date().toISOString(),
  });

  // Run the chosen strategy on the vault window. To prime the K-week lookback at
  // the vault boundary we let the engine read returns from holdoutStart-K, but the
  // FIRST realized return is at index >= holdoutStart (so realized P&L is strictly
  // out-of-sample; the lookback window is just the trailing signal, which is the
  // legitimate causal past). We enforce realized-return start == holdoutStart.
  const holdoutRes = runStrategy(weekly, chosen.K, holdoutStart, holdoutEnd);
  const holdoutStats = summarizeReturnSeries(holdoutRes.netReturns);
  const holdoutAnn = annualizeFromWeekly(holdoutRes.netReturns);
  const firstRealized = holdoutRes.weekIndexes[0];
  const avgNetExp =
    holdoutRes.netExposurePerWeek.reduce((s, x) => s + x, 0) /
    Math.max(1, holdoutRes.netExposurePerWeek.length);

  console.log(`  vault realized weeks : ${holdoutRes.rebalanceCount} ` +
    `(first realized idx=${firstRealized} = ${weekly.weeks[firstRealized ?? holdoutStart]})`);
  console.log(`  net compound         : ${pct(holdoutStats.compoundReturn)}`);
  console.log(`  mean / week          : ${pct(holdoutStats.mean)}  sharpe=${holdoutStats.sharpe.toFixed(3)}`);
  console.log(`  APR / maxDD          : ${pct(holdoutAnn.apr)} / ${pct(holdoutAnn.maxDD)}`);
  console.log(`  avg turnover / netExp: ${holdoutRes.avgTurnover.toFixed(3)} / ${avgNetExp.toFixed(4)} (netExp~0 => dollar-neutral)`);

  // Build the universe buy&hold baseline over the EXACT realized vault weeks, so
  // the baseline gate compares against the actual market the book ran against.
  const realizedStart = firstRealized ?? holdoutStart;
  const universeBH = universeBuyHoldWeekly(weekly, realizedStart, holdoutEnd);
  const bhStats = summarizeReturnSeries(universeBH);
  console.log(`  universe B&H (equal-wt long): net(1RT) compound=${pct(bhStats.compoundReturn - ROUND_TRIP)} ` +
    `mean/wk=${pct(bhStats.mean)}`);

  // The promotion evaluator builds buy&hold + random-lottery baselines from
  // barReturns (here: the universe equal-weight weekly returns) and gates the
  // candidate's per-period return series against them, plus MinBTL, DSR(N), haircut.
  const promo = evaluatePromotion({
    candidateId: `crossxs-neutral-K${chosen.K}`,
    candidateReturns: holdoutRes.netReturns,
    sampleCount: holdoutRes.rebalanceCount,
    trialCount: trueN,
    barReturns: universeBH, // market reference for buy&hold / lottery
    roundTripCost: ROUND_TRIP,
    averageHoldingBars: 1, // weekly rebalance
    baselineStatistic: "compoundReturn",
    thresholds: { dsrThreshold: DSR_THRESHOLD, haircutMethod: "bonferroni" },
    seed: "crossxs-neutral-target2",
  });

  console.log("\n-- Promotion gates (hold-out, true N) --");
  console.log(`  baselines    : applicable=${promo.gates.baselines.applicable} passed=${promo.gates.baselines.passed}`);
  if (promo.gates.baselines.result) {
    for (const c of promo.gates.baselines.result.comparisons) {
      console.log(`     vs ${c.id.padEnd(16)}: baseline=${pct(c.baselineScore)} margin=${pct(c.margin)} beaten=${c.beaten}`);
    }
    console.log(`     candidate score : ${pct(promo.gates.baselines.result.candidateScore)} positive=${promo.gates.baselines.result.candidatePositive}`);
  }
  console.log(`  MinBTL       : passed=${promo.gates.minBtl.passed} reason=${promo.gates.minBtl.result.reason} ` +
    `(need n>=${promo.gates.minBtl.result.minSampleForObservedSharpe}, have ${promo.gates.minBtl.result.sampleCount})`);
  console.log(`  DeflatedSharpe: passed=${promo.gates.deflatedSharpe.passed} ` +
    `prob=${promo.gates.deflatedSharpe.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}) ` +
    `sharpe=${promo.gates.deflatedSharpe.sharpe.toFixed(3)} N=${promo.gates.deflatedSharpe.trialCount}`);
  console.log(`  haircut      : passed=${promo.gates.haircut.passed} ` +
    `haircutSharpe=${promo.gates.haircut.result.haircutSharpe.toFixed(4)} (method=${promo.gates.haircut.result.method ?? "bonferroni"})`);
  console.log(`  gatesPassed  : ${promo.summary.gatesPassed}/${promo.summary.gatesApplicable}`);
  console.log(`  promotable   : ${promo.promotable}`);
  if (promo.reasons.length > 0) console.log(`  fail reasons : ${promo.reasons.join("; ")}`);

  // ============================================================================
  // STEP 5 — McLean-Pontiff 50% decay haircut + final verdict.
  // ============================================================================
  console.log("\n" + "-".repeat(80));
  console.log("McLEAN-PONTIFF DECAY HAIRCUT (50%) + FINAL VERDICT");
  console.log("-".repeat(80));
  const haircutMeanWk = holdoutStats.mean * (1 - HAIRCUT);
  const haircutCompound = Math.expm1(Math.log1p(Math.max(-0.999999, holdoutStats.compoundReturn)) * (1 - HAIRCUT));
  const haircutApr = Math.expm1(Math.log1p(Math.max(-0.999999, holdoutAnn.apr)) * (1 - HAIRCUT));
  const haircutPositive = haircutMeanWk > 0;
  console.log(`  raw hold-out mean/wk   : ${pct(holdoutStats.mean)}  -> 50%-decayed: ${pct(haircutMeanWk)}`);
  console.log(`  raw hold-out compound  : ${pct(holdoutStats.compoundReturn)} -> 50%-decayed: ${pct(haircutCompound)}`);
  console.log(`  raw hold-out APR       : ${pct(holdoutAnn.apr)} -> 50%-decayed: ${pct(haircutApr)}`);
  console.log(`  haircut still positive : ${haircutPositive}`);

  const netPositive = holdoutStats.compoundReturn > 0;
  const beatsBaseline = promo.gates.baselines.passed;
  const dsrOk = promo.gates.deflatedSharpe.passed;
  const minBtlOk = promo.gates.minBtl.passed;

  const promote =
    netPositive && beatsBaseline && dsrOk && minBtlOk && haircutPositive && promo.gates.haircut.passed;

  console.log("\n  Decision checklist (ALL must be true to PROMOTE):");
  console.log(`    net-of-cost positive on hold-out : ${netPositive}`);
  console.log(`    beats baseline (B&H/lottery)     : ${beatsBaseline}`);
  console.log(`    DSR(true N=${trueN}) >= ${DSR_THRESHOLD}            : ${dsrOk}`);
  console.log(`    MinBTL ok                        : ${minBtlOk}`);
  console.log(`    Harvey-Liu haircut Sharpe > 0    : ${promo.gates.haircut.passed}`);
  console.log(`    McLean-Pontiff 50% decay > 0     : ${haircutPositive}`);

  console.log("\n" + "=".repeat(80));
  console.log(`VERDICT: ${promote ? "PROMOTE" : "KILL"}`);
  console.log("=".repeat(80));

  // Machine-readable tail for the structured result.
  console.log("\nRESULT_JSON " + JSON.stringify({
    chosenK: chosen.K,
    trueN,
    searchSharpeByK: Object.fromEntries(searchRows.map((r) => [r.K, Number(r.sharpe.toFixed(4))])),
    searchAprByK: Object.fromEntries(searchRows.map((r) => [r.K, Number((r.apr).toFixed(4))])),
    holdout: {
      weeks: holdoutRes.rebalanceCount,
      netCompound: Number(holdoutStats.compoundReturn.toFixed(5)),
      meanWk: Number(holdoutStats.mean.toFixed(6)),
      sharpe: Number(holdoutStats.sharpe.toFixed(4)),
      apr: Number(holdoutAnn.apr.toFixed(4)),
      maxDD: Number(holdoutAnn.maxDD.toFixed(4)),
      avgTurnover: Number(holdoutRes.avgTurnover.toFixed(4)),
      avgNetExposure: Number(avgNetExp.toFixed(5)),
    },
    gates: {
      baselines: promo.gates.baselines.passed,
      minBtl: promo.gates.minBtl.passed,
      deflatedSharpe: promo.gates.deflatedSharpe.passed,
      deflatedProb: Number(promo.gates.deflatedSharpe.deflatedProbability.toFixed(4)),
      haircut: promo.gates.haircut.passed,
    },
    haircut50: { meanWk: Number(haircutMeanWk.toFixed(6)), positive: haircutPositive },
    promote,
    guardConsumed: guard.isConsumed(),
  }));
}

main();
