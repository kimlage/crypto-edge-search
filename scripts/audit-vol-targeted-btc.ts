/**
 * TARGET 3 — VOL-TARGETED BTC (Moreira & Muir 2017, "Volatility-Managed
 * Portfolios"). Scale BTC exposure by (target_vol / trailing_realized_vol),
 * capped, on the local daily BTC history. The documented mechanism: volatility
 * is persistent but the conditional Sharpe is not proportional to it, so cutting
 * exposure when realized vol is high (and levering up when it is low) raises the
 * unconditional Sharpe relative to buy-and-hold.
 *
 * This script is TRANSPARENT and CAUSAL: the exposure weight applied to day t's
 * return uses ONLY realized vol estimated from returns strictly <= t-1. It charges
 * a realistic round-trip cost on turnover (|w_t - w_{t-1}|), logs turnover, runs
 * the mandatory self-checks (pure-noise => no edge; future mutation => no change to
 * an earlier decision), picks the single best config on a SEARCH slice only (true
 * N recorded), reserves the most-recent ~24 months as a one-shot hold-out, and
 * evaluates the chosen config ONCE through the committed promotion evaluator. A 50%
 * McLean-Pontiff decay haircut is applied to the hold-out edge before the verdict.
 *
 * Pure reuse of the rigour cores (no statistics reimplemented):
 *   holdout.ts            planHoldoutSplit, FinalHoldoutGuard
 *   promotion-evaluator.ts evaluatePromotion
 *   statistical-validation.ts summarizeReturnSeries, computeDeflatedSharpeRatio
 *   trial-count.ts        effectiveTrialCount
 *
 * No BigQuery, no training loop, no edits to shared files. Reads only
 * output/bigquery/btc_ohlcv_15m.ndjson.
 *
 * Run:
 *   PATH=.../node/bin:$PATH node_modules/.bin/tsx scripts/audit-vol-targeted-btc.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { planHoldoutSplit, FinalHoldoutGuard } from "../src/lib/significance/holdout";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
} from "../src/lib/statistical-validation";
import { effectiveTrialCount } from "../src/lib/significance/trial-count";

// ---------------------------------------------------------------------------
// Cost model. BTC spot is the instrument (vol-targeting a long position). A
// modest, realistic round-trip applied to the CHANGE in exposure each day.
// 28 bps round-trip default per the method. Turnover is low for vol-targeting,
// so cost is not the binding constraint — we still charge it honestly.
// ---------------------------------------------------------------------------
const ROUND_TRIP_COST = 0.0028; // 28 bps, charged on |Δ weight|
const TRADING_DAYS_PER_YEAR = 365; // crypto trades 7 days/week
const ANNUALIZE = Math.sqrt(TRADING_DAYS_PER_YEAR);

// ---------------------------------------------------------------------------
// 1) Load 15m candles -> causal DAILY closes (UTC day). The daily close is the
//    last 15m close whose bar closed on/before the UTC day boundary, so no future
//    information leaks into the daily bar.
// ---------------------------------------------------------------------------
interface DailyBar {
  date: string; // YYYY-MM-DD (UTC)
  close: number;
}

function loadDailyClosesFromBtc15m(): DailyBar[] {
  const path = join("output", "bigquery", "btc_ohlcv_15m.ndjson");
  if (!existsSync(path)) {
    throw new Error(`missing BTC data: ${path}`);
  }
  // Keep the LAST close seen for each UTC date — the daily settlement.
  const lastCloseByDate = new Map<string, number>();
  const order: string[] = [];
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const close = obj.close;
    const eventTime = obj.event_time;
    if (typeof close !== "number" || !Number.isFinite(close)) continue;
    if (typeof eventTime !== "string") continue;
    const date = eventTime.slice(0, 10); // UTC YYYY-MM-DD from ISO event_time
    if (!lastCloseByDate.has(date)) order.push(date);
    lastCloseByDate.set(date, close);
  }
  order.sort(); // ISO date strings sort chronologically
  return order.map((date) => ({ date, close: lastCloseByDate.get(date)! }));
}

function dailyLogReturns(bars: readonly DailyBar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]!.close;
    const curr = bars[i]!.close;
    out.push(prev > 0 ? Math.log(curr / prev) : 0);
  }
  return out;
}

function logToSimple(logR: number): number {
  return Math.expm1(logR);
}

// ---------------------------------------------------------------------------
// 2) The rule. Config = { lookback, targetVolAnnual, cap }. The weight applied
//    on day t (i.e. earning return r_t, the i-th daily return) is computed from
//    realized vol over the `lookback` returns ENDING at t-1 (strictly causal).
//    w_t = clamp(targetVolDaily / realizedVolDaily(<= t-1), 0, cap).
//    Net return_t = w_t * r_t  -  cost * |w_t - w_{t-1}|.
// ---------------------------------------------------------------------------
interface VolTargetConfig {
  lookback: number; // trading days for realized-vol estimate
  targetVolAnnual: number; // e.g. 0.60 = 60% annualized target
  cap: number; // max leverage / exposure (>=1 means can lever)
}

interface StrategyResult {
  netReturns: number[]; // per-day simple net returns, aligned to retIndex window
  weights: number[];
  turnoverSum: number;
  tradingDays: number;
}

/**
 * Run the vol-targeted rule over a slice of daily LOG returns `logRet` that is
 * positionally aligned: logRet[i] is the return earned going from day i to i+1.
 * `startIdx` is the first return index we actually trade (we need `lookback`
 * prior returns to estimate vol causally). Returns the net simple-return series
 * for indexes [startIdx, end).
 */
function runVolTarget(
  logRet: readonly number[],
  config: VolTargetConfig,
  startIdx: number,
  endIdx: number,
): StrategyResult {
  const targetVolDaily = config.targetVolAnnual / ANNUALIZE;
  const netReturns: number[] = [];
  const weights: number[] = [];
  let prevWeight = 0;
  let turnoverSum = 0;

  for (let i = startIdx; i < endIdx; i += 1) {
    // Realized vol from returns ending at i-1 (strictly before the return r_i
    // we are about to earn). Window = [i-lookback, i-1].
    const from = i - config.lookback;
    if (from < 0) {
      // not enough history; should not happen if startIdx chosen correctly
      weights.push(prevWeight);
      netReturns.push(0);
      continue;
    }
    let sumSq = 0;
    for (let k = from; k < i; k += 1) {
      const v = logRet[k]!;
      sumSq += v * v;
    }
    const realizedVolDaily = Math.sqrt(sumSq / config.lookback);
    let weight =
      realizedVolDaily > 1e-9 ? targetVolDaily / realizedVolDaily : config.cap;
    if (weight > config.cap) weight = config.cap;
    if (weight < 0) weight = 0;

    const grossSimple = logToSimple(logRet[i]!); // r_i (the return earned this day)
    const turnover = Math.abs(weight - prevWeight);
    turnoverSum += turnover;
    const net = weight * grossSimple - ROUND_TRIP_COST * turnover;
    netReturns.push(net);
    weights.push(weight);
    prevWeight = weight;
  }

  return {
    netReturns,
    weights,
    turnoverSum,
    tradingDays: endIdx - startIdx,
  };
}

/** Buy-and-hold net of a single round-trip cost over the same window. */
function buyHoldNetReturns(
  logRet: readonly number[],
  startIdx: number,
  endIdx: number,
): number[] {
  const out: number[] = [];
  for (let i = startIdx; i < endIdx; i += 1) {
    let r = logToSimple(logRet[i]!);
    if (i === startIdx) r -= ROUND_TRIP_COST; // entry cost once
    out.push(r);
  }
  return out;
}

function annualizedSharpe(returns: readonly number[]): number {
  const s = summarizeReturnSeries(returns);
  return s.sharpe * ANNUALIZE;
}

function compound(returns: readonly number[]): number {
  return summarizeReturnSeries(returns).compoundReturn;
}

function annualizedReturn(returns: readonly number[]): number {
  const comp = compound(returns);
  const years = returns.length / TRADING_DAYS_PER_YEAR;
  if (years <= 0) return 0;
  return Math.pow(1 + comp, 1 / years) - 1;
}

function maxDrawdown(returns: readonly number[]): number {
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ---------------------------------------------------------------------------
// Search grid (records the TRUE N tried).
// ---------------------------------------------------------------------------
const LOOKBACKS = [10, 15, 20, 30, 45, 60, 90]; // realized-vol windows (days)
const TARGET_VOLS = [0.4, 0.5, 0.6, 0.7, 0.8, 1.0]; // annualized vol targets
const CAPS = [1.0, 1.5, 2.0]; // long-only, capped exposure

function buildGrid(): VolTargetConfig[] {
  const grid: VolTargetConfig[] = [];
  for (const lookback of LOOKBACKS) {
    for (const targetVolAnnual of TARGET_VOLS) {
      for (const cap of CAPS) {
        grid.push({ lookback, targetVolAnnual, cap });
      }
    }
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Self-checks (mandatory).
// ---------------------------------------------------------------------------

/** A) Pure-noise: on shuffled/IID-Gaussian "BTC" with no vol-clustering, the rule
 *  should NOT produce a meaningful positive Sharpe edge over buy&hold. We use a
 *  Gaussian series with the same daily mean/sd but no serial vol structure — the
 *  Moreira-Muir mechanism has nothing to exploit, so the vol-target edge should
 *  collapse toward zero. */
function selfCheckPureNoise(
  realLogRet: readonly number[],
  config: VolTargetConfig,
  startIdx: number,
  endIdx: number,
): { volTargetSharpe: number; buyHoldSharpe: number; edge: number } {
  const slice = realLogRet.slice(startIdx, endIdx);
  const s = summarizeReturnSeries(slice);
  const mean = s.mean;
  const sd = s.stdDev;
  // Seeded gaussian (Box-Muller) — IID, so no vol clustering for the rule to time.
  let state = 0x1234abcd >>> 0;
  const rng = () => {
    state += 0x6d2b79f5;
    let v = state;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4_294_967_296;
  };
  const gauss = () => {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  // Build a noise log-return series the same length as the full real series so
  // indexing is identical; we only read [0, endIdx).
  const noise: number[] = [];
  for (let i = 0; i < realLogRet.length; i += 1) noise.push(mean + sd * gauss());

  const vt = runVolTarget(noise, config, startIdx, endIdx);
  const bh = buyHoldNetReturns(noise, startIdx, endIdx);
  const volTargetSharpe = annualizedSharpe(vt.netReturns);
  const buyHoldSharpe = annualizedSharpe(bh);
  return { volTargetSharpe, buyHoldSharpe, edge: volTargetSharpe - buyHoldSharpe };
}

/** B) Causality: mutating FUTURE returns (after a decision point) must not change
 *  the weight chosen at an EARLIER day. We pick a decision index, record its
 *  weight, corrupt every return strictly after it, recompute, and assert the
 *  earlier weight is unchanged. */
function selfCheckCausality(
  realLogRet: readonly number[],
  config: VolTargetConfig,
  startIdx: number,
  endIdx: number,
): { decisionIdx: number; weightBefore: number; weightAfter: number; identical: boolean } {
  const decisionIdx = Math.floor((startIdx + endIdx) / 2);
  const baseline = runVolTarget(realLogRet, config, startIdx, endIdx);
  const localIdx = decisionIdx - startIdx;
  const weightBefore = baseline.weights[localIdx]!;

  // Corrupt all returns strictly AFTER the decision day's earned return.
  const mutated = realLogRet.slice();
  for (let i = decisionIdx + 1; i < mutated.length; i += 1) {
    mutated[i] = (mutated[i]! + 0.5) * -3; // gross future-data mutation
  }
  const mutatedRun = runVolTarget(mutated, config, startIdx, endIdx);
  const weightAfter = mutatedRun.weights[localIdx]!;
  return {
    decisionIdx,
    weightBefore,
    weightAfter,
    identical: weightBefore === weightAfter,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function main(): void {
  const line = "=".repeat(80);
  console.log(line);
  console.log("TARGET 3 — VOL-TARGETED BTC (Moreira-Muir 2017) — honest causal audit");
  console.log(line);

  const bars = loadDailyClosesFromBtc15m();
  const logRet = dailyLogReturns(bars);
  console.log(`daily bars        : ${bars.length} (${bars[0]!.date} -> ${bars[bars.length - 1]!.date})`);
  console.log(`daily log returns : ${logRet.length}`);
  console.log(`cost model        : ${ROUND_TRIP_COST * 10000} bps round-trip on |Δweight|; annualize=${TRADING_DAYS_PER_YEAR}d`);

  // --- Hold-out split on the DAILY-RETURN index space ---------------------
  // Reserve the most-recent ~24 months. With ~365 trading days/yr, 24 months is
  // ~730 days. Use planHoldoutSplit's fraction to carve search vs hold-out. We
  // set holdoutFraction so the vault is ~24 months; testFraction=0 (we use a
  // single one-shot vault, the search owns the rest).
  const targetHoldoutDays = 730; // ~24 months
  const holdoutFraction = Math.min(0.45, targetHoldoutDays / logRet.length);
  const plan = planHoldoutSplit({
    totalRows: logRet.length,
    holdoutFraction,
    testFraction: 0,
  });
  console.log(`\n-- Hold-out plan (consume-once vault = most recent ~24 months) --`);
  console.log(`  search window  : returns [${plan.search.start}, ${plan.search.end}) = ${plan.search.rows} days`);
  console.log(`  final hold-out : returns [${plan.finalHoldout.start}, ${plan.finalHoldout.end}) = ${plan.finalHoldout.rows} days`);

  const maxLookback = Math.max(...LOOKBACKS);
  // The search may only read returns strictly before the hold-out start.
  const searchStart = maxLookback; // need lookback history before first traded day
  const searchEnd = plan.search.end; // exclusive; never touches the vault
  if (searchEnd - searchStart < 200) {
    throw new Error("search window too short");
  }

  // --- SEARCH: pick the single best config by annualized Sharpe -----------
  const grid = buildGrid();
  const trueN = grid.length;
  console.log(`\n-- Search (config grid) --`);
  console.log(`  TRUE N (configs tried): ${trueN}  [lookbacks ${LOOKBACKS.length} x targetVols ${TARGET_VOLS.length} x caps ${CAPS.length}]`);

  let best: { config: VolTargetConfig; sharpe: number; comp: number; turnover: number } | null = null;
  const searchSharpes: number[] = [];
  for (const config of grid) {
    const run = runVolTarget(logRet, config, searchStart, searchEnd);
    const sharpe = annualizedSharpe(run.netReturns);
    searchSharpes.push(sharpe);
    if (best === null || sharpe > best.sharpe) {
      best = {
        config,
        sharpe,
        comp: compound(run.netReturns),
        turnover: run.turnoverSum / run.tradingDays,
      };
    }
  }
  const chosen = best!.config;

  // Buy&hold on the same search window (the baseline to beat).
  const bhSearch = buyHoldNetReturns(logRet, searchStart, searchEnd);
  console.log(`  best config    : lookback=${chosen.lookback}d targetVol=${fmtPct(chosen.targetVolAnnual)} cap=${chosen.cap}x`);
  console.log(`  search SR (ann): vol-target=${best!.sharpe.toFixed(3)}  buy&hold=${annualizedSharpe(bhSearch).toFixed(3)}`);
  console.log(`  search comp ret: vol-target=${fmtPct(best!.comp)}  buy&hold=${fmtPct(compound(bhSearch))}`);
  console.log(`  avg daily turnover (|Δw|): ${best!.turnover.toFixed(4)} -> ~${(best!.turnover * TRADING_DAYS_PER_YEAR).toFixed(1)}x/yr`);

  // --- SELF-CHECKS on the chosen config (search window) -------------------
  console.log(`\n-- Self-checks (chosen config) --`);
  const noise = selfCheckPureNoise(logRet, chosen, searchStart, searchEnd);
  const noisePass = noise.edge < 0.10; // no meaningful Sharpe edge over buy&hold on IID noise
  console.log(`  A) pure-noise (IID, no vol-clustering):`);
  console.log(`       vol-target SR=${noise.volTargetSharpe.toFixed(3)}  buy&hold SR=${noise.buyHoldSharpe.toFixed(3)}  edge=${noise.edge.toFixed(3)}`);
  console.log(`       => ${noisePass ? "PASS" : "FAIL"} (edge < 0.10 expected; mechanism needs real vol clustering)`);
  const causal = selfCheckCausality(logRet, chosen, searchStart, searchEnd);
  console.log(`  B) causality (mutate future returns after a decision):`);
  console.log(`       decision idx=${causal.decisionIdx} weight before=${causal.weightBefore.toFixed(5)} after=${causal.weightAfter.toFixed(5)}`);
  console.log(`       => ${causal.identical ? "PASS" : "FAIL"} (earlier decision unchanged by future data)`);

  // --- ONE-SHOT HOLD-OUT EVALUATION ---------------------------------------
  const guard = new FinalHoldoutGuard();
  guard.consume({
    reason: "vol-targeted-btc final hold-out (chosen config)",
    trialCount: trueN,
    nowIso: new Date().toISOString(),
  });

  const hoStart = plan.finalHoldout.start;
  const hoEnd = plan.finalHoldout.end;
  // The vol estimate at the first hold-out day reads `lookback` returns ending at
  // hoStart-1 — those live in the search window, which is fine (only the search
  // SELECTION must not see the vault; using prior history to compute today's vol
  // is standard and causal). We start trading at hoStart.
  const hoRun = runVolTarget(logRet, chosen, hoStart, hoEnd);
  const hoBuyHold = buyHoldNetReturns(logRet, hoStart, hoEnd);

  const hoVtStats = summarizeReturnSeries(hoRun.netReturns);
  const hoSharpeAnn = hoVtStats.sharpe * ANNUALIZE;
  const hoComp = hoVtStats.compoundReturn;
  const hoApr = annualizedReturn(hoRun.netReturns);
  const hoDD = maxDrawdown(hoRun.netReturns);
  const bhComp = compound(hoBuyHold);
  const bhSharpeAnn = annualizedSharpe(hoBuyHold);
  const bhApr = annualizedReturn(hoBuyHold);
  const bhDD = maxDrawdown(hoBuyHold);

  console.log(`\n${line}`);
  console.log(`HOLD-OUT (one-shot, consumed=${guard.isConsumed()}) — most recent ~24 months`);
  console.log(line);
  console.log(`  hold-out days        : ${hoRun.netReturns.length} (${bars[hoStart + 1]!.date} -> ${bars[hoEnd]!.date})`);
  console.log(`  vol-target  : SR(ann)=${hoSharpeAnn.toFixed(3)}  comp=${fmtPct(hoComp)}  APR=${fmtPct(hoApr)}  maxDD=${fmtPct(hoDD)}`);
  console.log(`  buy&hold    : SR(ann)=${bhSharpeAnn.toFixed(3)}  comp=${fmtPct(bhComp)}  APR=${fmtPct(bhApr)}  maxDD=${fmtPct(bhDD)}`);
  console.log(`  avg daily turnover (|Δw|): ${(hoRun.turnoverSum / hoRun.tradingDays).toFixed(4)}`);

  // Per-bar market simple returns for the baseline gate inside evaluatePromotion.
  const hoBarReturns = hoBuyHold.map((r, i) => (i === 0 ? r + ROUND_TRIP_COST : r));

  // Average holding bars for the random-lottery turnover match: a vol-target
  // strategy is effectively always-in but rebalances; approximate holding by
  // inverse of average daily turnover (bounded).
  const avgTurnover = hoRun.turnoverSum / hoRun.tradingDays;
  const avgHoldingBars = Math.max(1, Math.round(avgTurnover > 1e-6 ? 1 / avgTurnover : hoRun.netReturns.length));

  const promo = evaluatePromotion({
    candidateId: `vol-target-L${chosen.lookback}-tv${chosen.targetVolAnnual}-cap${chosen.cap}`,
    candidateReturns: hoRun.netReturns,
    sampleCount: hoRun.netReturns.length,
    trialCount: effectiveTrialCount({ explicitTrialCount: trueN, floor: trueN }),
    barReturns: hoBarReturns,
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: avgHoldingBars,
    seed: "vol-target-btc",
  });

  // Deflated Sharpe on the hold-out series at the TRUE N (explicit print).
  const dsr = computeDeflatedSharpeRatio(hoRun.netReturns, { trialCount: trueN });

  console.log(`\n-- Promotion gates (evaluatePromotion, true N=${trueN}) --`);
  const g = promo.gates;
  console.log(`  baselines   applicable=${g.baselines.applicable} passed=${g.baselines.passed}`);
  if (g.baselines.result) {
    for (const c of g.baselines.result.comparisons) {
      console.log(`     vs ${c.id.padEnd(16)} baseline=${fmtPct(c.baselineScore)} margin=${fmtPct(c.margin)} beaten=${c.beaten}`);
    }
    console.log(`     candidate score=${fmtPct(g.baselines.result.candidateScore)} positive=${g.baselines.result.candidatePositive}`);
  }
  console.log(`  deflatedSR  passed=${g.deflatedSharpe.passed} prob=${g.deflatedSharpe.deflatedProbability.toFixed(4)} (thr=${g.deflatedSharpe.threshold}) SR(per-day)=${g.deflatedSharpe.sharpe.toFixed(4)}`);
  console.log(`  minBTL      passed=${g.minBtl.passed} reason=${g.minBtl.result.reason} (sample=${g.minBtl.result.sampleCount}, needs>=${g.minBtl.result.minSampleForObservedSharpe})`);
  console.log(`  haircut     passed=${g.haircut.passed} haircutSharpe=${g.haircut.result.haircutSharpe.toFixed(4)}`);
  console.log(`  DSR(true N) deflatedProbability=${dsr.deflatedProbability.toFixed(4)}`);
  console.log(`  gatesPassed=${promo.summary.gatesPassed}/${promo.summary.gatesApplicable} promotable=${promo.promotable}`);
  if (promo.reasons.length > 0) console.log(`  reasons: ${promo.reasons.join("; ")}`);

  // --- 50% McLean-Pontiff decay haircut on the hold-out edge --------------
  const grossEdgeApr = hoApr - bhApr; // vs buy&hold baseline
  const haircutEdgeApr = grossEdgeApr * 0.5;
  const grossEdgeSharpe = hoSharpeAnn - bhSharpeAnn;
  const haircutEdgeSharpe = grossEdgeSharpe * 0.5;
  console.log(`\n-- McLean-Pontiff 50% decay haircut (on hold-out edge vs buy&hold) --`);
  console.log(`  gross APR edge   = ${fmtPct(grossEdgeApr)}  -> post-haircut = ${fmtPct(haircutEdgeApr)}`);
  console.log(`  gross SR  edge   = ${grossEdgeSharpe.toFixed(3)}  -> post-haircut = ${haircutEdgeSharpe.toFixed(3)}`);

  // --- VERDICT ------------------------------------------------------------
  // Baseline to beat = buy&hold BTC net of costs. PROMOTE only if on hold-out:
  // net positive, beats buy&hold, DSR(true N)>=0.95, MinBTL ok, haircut>0.
  const netPositive = hoComp > 0;
  const beatsBuyHold = hoSharpeAnn > bhSharpeAnn && haircutEdgeSharpe > 0; // Sharpe is the documented improvement
  const dsrOk = dsr.deflatedProbability >= 0.95;
  const minBtlOk = g.minBtl.passed;
  const haircutOk = g.haircut.passed && haircutEdgeSharpe > 0;

  const selfChecksOk = noisePass && causal.identical;
  const promote = selfChecksOk && netPositive && beatsBuyHold && dsrOk && minBtlOk && haircutOk;

  console.log(`\n${line}`);
  console.log("VERDICT");
  console.log(line);
  console.log(`  self-checks (noise+causality) : ${selfChecksOk ? "PASS" : "FAIL"}`);
  console.log(`  net positive (hold-out)       : ${netPositive} (comp=${fmtPct(hoComp)})`);
  console.log(`  beats buy&hold (Sharpe, +hc)  : ${beatsBuyHold} (vt SR=${hoSharpeAnn.toFixed(3)} vs bh SR=${bhSharpeAnn.toFixed(3)})`);
  console.log(`  DSR(true N)>=0.95             : ${dsrOk} (${dsr.deflatedProbability.toFixed(4)})`);
  console.log(`  MinBTL ok                     : ${minBtlOk}`);
  console.log(`  haircut>0                     : ${haircutOk}`);
  console.log(`  => ${promote ? "PROMOTE" : "KILL"}`);
  console.log(line);
}

main();
