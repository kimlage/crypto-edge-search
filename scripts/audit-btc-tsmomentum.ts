/**
 * Experiment 3 — does the simplest DOCUMENTED low-turnover trend rule on BTC
 * survive the rigor gates on real local data?
 *
 * Pipeline (all causal, no fetch — reads the committed local 15m OHLCV):
 *   1. Load output/bigquery/btc_ohlcv_15m.ndjson (~306k 15m candles, 2017-2026).
 *   2. Aggregate 15m -> DAILY and WEEKLY closes locally (last 15m close of each
 *      UTC day / ISO week = causal close-to-close bars).
 *   3. For each (timeframe) x (rule in {tsmom-long-flat, tsmom-long-short, xover})
 *      x (lookback grid), compute NET returns net of a stated round-trip cost.
 *      Log turnover. Count total configs tried = TRUE N.
 *   4. Carve a consume-once final hold-out = most-recent ~24 months (planHoldoutSplit).
 *      Select the BEST config on the SEARCH slice only (no hold-out leakage).
 *   5. Run the winner through evaluatePromotion with trialCount = TRUE N,
 *      barReturns = BTC buy&hold returns at that timeframe. Report DSR(true N),
 *      MinBTL, beats-buy&hold?, haircut, and the one-shot hold-out NET result.
 *   6. Apply McLean-Pontiff decay realism: haircut in-sample Sharpe ~50% and
 *      require the post-2021 / hold-out slice to survive.
 *
 * Reuses (no re-implemented stats): evaluatePromotion, planHoldoutSplit,
 * FinalHoldoutGuard, computeDeflatedSharpeRatio, summarizeReturnSeries,
 * evaluateMinBtl, buildBuyAndHoldBaseline, computeNetEdge.
 *
 * Usage:
 *   tsx scripts/audit-btc-tsmomentum.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import {
  buyAndHoldReturns,
  compound,
  movingAverageCrossover,
  timeSeriesMomentum,
  type TrendRuleResult,
  type TrendSide,
} from "../src/lib/reorientation/timeseries-momentum";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import { planHoldoutSplit, FinalHoldoutGuard } from "../src/lib/significance/holdout";
import { evaluateMinBtl } from "../src/lib/significance/trial-count";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../src/lib/statistical-validation";
import { computeNetEdge } from "../src/lib/reorientation/turnover";

const ROUND_TRIP_COST = 0.0028; // 28 bps; spot BTC realistic costs are LOWER, this is conservative.
const DSR_THRESHOLD = 0.95;
const DECAY_HAIRCUT = 0.5; // McLean-Pontiff ~50% in-sample Sharpe haircut.

interface Bar {
  ts: number; // epoch ms of bar open
  close: number;
}

const NDJSON = join("output", "bigquery", "btc_ohlcv_15m.ndjson");

async function loadAggregated(): Promise<{ daily: Bar[]; weekly: Bar[]; raw15m: number }> {
  if (!existsSync(NDJSON)) {
    throw new Error(`local OHLCV not found at ${NDJSON}`);
  }
  // Causal aggregation: the close of a calendar bucket is the LAST 15m close
  // whose event_time falls inside that bucket. Buckets keyed by UTC day / ISO week.
  const dayMap = new Map<string, Bar>();
  const weekMap = new Map<string, Bar>();
  let count = 0;

  const rl = createInterface({ input: createReadStream(NDJSON, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const close = typeof obj.close === "number" ? obj.close : Number(obj.close);
    const eventTime = typeof obj.event_time === "string" ? obj.event_time : null;
    if (!Number.isFinite(close) || !eventTime) continue;
    const d = new Date(eventTime);
    const ts = d.getTime();
    if (!Number.isFinite(ts)) continue;
    count += 1;

    // UTC day key
    const dayKey = eventTime.slice(0, 10); // YYYY-MM-DD
    const dayPrev = dayMap.get(dayKey);
    if (!dayPrev || ts >= dayPrev.ts) dayMap.set(dayKey, { ts, close });

    // ISO week key (UTC): year + week number
    const weekKey = isoWeekKey(d);
    const weekPrev = weekMap.get(weekKey);
    if (!weekPrev || ts >= weekPrev.ts) weekMap.set(weekKey, { ts, close });
  }

  const daily = [...dayMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, bar]) => bar);
  const weekly = [...weekMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, bar]) => bar);
  return { daily, weekly, raw15m: count };
}

function isoWeekKey(date: Date): string {
  // UTC ISO-8601 week. Copy to avoid mutation.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type RuleKind = "tsmom-long-flat" | "tsmom-long-short" | "xover-long-flat" | "xover-long-short";

interface Config {
  rule: RuleKind;
  lookback?: number;
  fast?: number;
  slow?: number;
  label: string;
}

function buildGrid(): Config[] {
  const configs: Config[] = [];
  // TS-momentum lookbacks (in bars of the timeframe). Classic horizons.
  const tsLookbacks = [5, 10, 20, 30, 40, 50, 60, 90, 120];
  for (const L of tsLookbacks) {
    configs.push({ rule: "tsmom-long-flat", lookback: L, label: `tsmom-LF(L=${L})` });
    configs.push({ rule: "tsmom-long-short", lookback: L, label: `tsmom-LS(L=${L})` });
  }
  // MA crossover (fast,slow) pairs — documented combos.
  const pairs: Array<[number, number]> = [
    [5, 20], [10, 30], [10, 50], [20, 50], [20, 100], [50, 100], [50, 200], [10, 100], [30, 90],
  ];
  for (const [fast, slow] of pairs) {
    configs.push({ rule: "xover-long-flat", fast, slow, label: `xover-LF(${fast}/${slow})` });
    configs.push({ rule: "xover-long-short", fast, slow, label: `xover-LS(${fast}/${slow})` });
  }
  return configs;
}

function runConfig(closes: readonly number[], cfg: Config): TrendRuleResult {
  const side: TrendSide = cfg.rule.endsWith("long-short") ? "long-short" : "long-flat";
  if (cfg.rule.startsWith("tsmom")) {
    return timeSeriesMomentum({ closes, lookback: cfg.lookback!, side, roundTripCost: ROUND_TRIP_COST });
  }
  return movingAverageCrossover({ closes, fast: cfg.fast!, slow: cfg.slow!, side, roundTripCost: ROUND_TRIP_COST });
}

interface Scored {
  cfg: Config;
  searchNet: number;
  searchGross: number;
  trades: number;
  turnover: number;
  exposure: number;
  avgHoldingBars: number;
  searchSharpe: number;
  result: TrendRuleResult; // over the SEARCH slice
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function annualizedSharpe(perBarSharpe: number, barsPerYear: number): number {
  return perBarSharpe * Math.sqrt(barsPerYear);
}

async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("EXPERIMENT 3 — BTC time-series momentum / trend rule @ DAILY & WEEKLY");
  console.log("real local data: " + NDJSON);
  console.log("=".repeat(80));

  const { daily, weekly, raw15m } = await loadAggregated();
  console.log(`\nLoaded ${raw15m} 15m candles -> ${daily.length} daily bars, ${weekly.length} weekly bars`);
  console.log(`daily span : ${new Date(daily[0]!.ts).toISOString().slice(0, 10)} .. ${new Date(daily.at(-1)!.ts).toISOString().slice(0, 10)}`);
  console.log(`weekly span: ${new Date(weekly[0]!.ts).toISOString().slice(0, 10)} .. ${new Date(weekly.at(-1)!.ts).toISOString().slice(0, 10)}`);
  console.log(`round-trip cost assumption: ${(ROUND_TRIP_COST * 1e4).toFixed(0)} bps (0.0028) — conservative; spot BTC is typically lower.`);

  const grid = buildGrid();
  const timeframes: Array<{ name: string; bars: Bar[]; barsPerYear: number; holdoutFraction: number }> = [
    // ~24-month hold-out: daily total ~2200 -> 24/(span months). Use planHoldoutSplit fractions.
    { name: "daily", bars: daily, barsPerYear: 365, holdoutFraction: 24 / monthsSpan(daily) },
    { name: "weekly", bars: weekly, barsPerYear: 52, holdoutFraction: 24 / monthsSpan(weekly) },
  ];

  for (const tf of timeframes) {
    console.log("\n" + "#".repeat(80));
    console.log(`TIMEFRAME: ${tf.name.toUpperCase()}  (${tf.bars.length} bars, ${grid.length} configs in grid)`);
    console.log("#".repeat(80));

    const closesAll = tf.bars.map((b) => b.close);
    // Consume-once final hold-out = most recent ~24 months; test=0 so search owns the rest.
    const plan = planHoldoutSplit({
      totalRows: closesAll.length,
      holdoutFraction: Math.min(0.5, Math.max(0.05, tf.holdoutFraction)),
      testFraction: 0,
    });
    // closes index alignment: bar returns start at index 1. Search uses closes[0..searchEnd),
    // hold-out uses closes[searchEnd-? .. end). We split on CLOSES so the hold-out return
    // series is close-to-close within the hold-out, with one bar of overlap for the first return.
    const searchEnd = plan.search.end; // exclusive close index for search
    const searchCloses = closesAll.slice(0, searchEnd);
    // hold-out close-to-close: include the last search close as the anchor for the first hold-out return.
    const holdoutCloses = closesAll.slice(Math.max(0, searchEnd - 1));
    const holdoutStartIso = new Date(tf.bars[searchEnd]?.ts ?? tf.bars.at(-1)!.ts).toISOString().slice(0, 10);

    console.log(`\nhold-out plan: search=${searchCloses.length} closes, finalHoldout=${plan.finalHoldout.rows} bars (~24mo), holdout starts ${holdoutStartIso}`);
    console.log(`SELECTION happens on SEARCH slice ONLY (no hold-out leakage). TRUE N = ${grid.length} configs.`);

    // --- Score every config on the SEARCH slice ---
    const scored: Scored[] = grid.map((cfg) => {
      const res = runConfig(searchCloses, cfg);
      const stats = summarizeReturnSeries(res.netReturns);
      return {
        cfg,
        searchNet: compound(res.netReturns),
        searchGross: compound(res.grossReturns),
        trades: res.tradeCount,
        turnover: res.totalTurnover,
        exposure: res.exposure,
        avgHoldingBars: res.avgHoldingBars,
        searchSharpe: stats.sharpe,
        result: res,
      };
    });

    // Buy&hold over the SEARCH slice (the benchmark the rule must beat).
    const bhSearch = compound(buyAndHoldReturns(searchCloses));
    console.log(`\nbuy&hold NET over search slice: ${pct(bhSearch)}  (one round trip charged)`);

    // Rank by search NET return (the selection objective).
    const ranked = [...scored].sort((a, b) => b.searchNet - a.searchNet);
    console.log("\n-- top 8 configs by SEARCH net return --");
    console.log("  config".padEnd(26) + "net".padStart(10) + "gross".padStart(10) + "trades".padStart(8) + "turnov".padStart(9) + "expos".padStart(8) + "shrp/bar".padStart(10));
    for (const s of ranked.slice(0, 8)) {
      console.log(
        "  " + s.cfg.label.padEnd(24) +
        pct(s.searchNet).padStart(10) +
        pct(s.searchGross).padStart(10) +
        String(s.trades).padStart(8) +
        s.turnover.toFixed(0).padStart(9) +
        pct(s.exposure).padStart(8) +
        s.searchSharpe.toFixed(4).padStart(10),
      );
    }
    const beatsBH = ranked.filter((s) => s.searchNet > bhSearch);
    console.log(`\nconfigs beating buy&hold NET on search slice: ${beatsBH.length}/${grid.length}`);

    const best = ranked[0]!;
    console.log(`\n-- BEST config (selected on search slice): ${best.cfg.label} --`);
    const netEdge = computeNetEdge({ grossReturn: best.searchGross, tradeCount: best.trades, roundTripCost: ROUND_TRIP_COST });
    console.log(`  search net=${pct(best.searchNet)} gross=${pct(best.searchGross)} trades=${best.trades} turnover=${best.turnover.toFixed(0)} exposure=${pct(best.exposure)} avgHold=${best.avgHoldingBars.toFixed(1)} bars`);
    console.log(`  netEdgePerTrade=${pct(netEdge.netEdgePerTrade)} grossEdgePerTrade=${pct(netEdge.grossEdgePerTrade)} edgeBeatsCost=${netEdge.edgeBeatsCost}`);
    console.log(`  per-bar Sharpe=${best.searchSharpe.toFixed(4)}  annualized~${annualizedSharpe(best.searchSharpe, tf.barsPerYear).toFixed(3)}`);

    // --- Promotion gate on the SEARCH slice, with TRUE N = grid.length ---
    const promo = evaluatePromotion({
      candidateId: `${tf.name}:${best.cfg.label}`,
      candidateReturns: best.result.netReturns,
      sampleCount: best.result.netReturns.length,
      trialCount: grid.length, // TRUE N: every config tried
      barReturns: buyAndHoldReturns(searchCloses),
      roundTripCost: ROUND_TRIP_COST,
      averageHoldingBars: Math.max(1, Math.round(best.avgHoldingBars)),
      thresholds: { dsrThreshold: DSR_THRESHOLD, haircutMethod: "bonferroni" },
      seed: `exp3-${tf.name}`,
    });

    const minBtl = evaluateMinBtl({
      trialCount: grid.length,
      sampleCount: best.result.netReturns.length,
      observedSharpe: best.searchSharpe,
    });
    const dsr = computeDeflatedSharpeRatio(best.result.netReturns, { trialCount: grid.length });

    console.log("\n-- RIGOR GATES on search slice (TRUE N = " + grid.length + ") --");
    console.log(`  baselines (beat buy&hold + random lottery, net, positive): applicable=${promo.gates.baselines.applicable} passed=${promo.gates.baselines.passed}`);
    if (promo.gates.baselines.result) {
      for (const c of promo.gates.baselines.result.comparisons) {
        console.log(`     vs ${c.id.padEnd(16)} baseline=${pct(c.baselineScore)} margin=${pct(c.margin)} beaten=${c.beaten}`);
      }
    }
    console.log(`  Deflated Sharpe (true N): prob=${dsr.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}? ${promo.gates.deflatedSharpe.passed})  sharpe=${dsr.sharpe.toFixed(4)} expMaxNull=${dsr.expectedMaxSharpe.toFixed(4)}`);
    console.log(`  MinBTL: sufficientLength=${minBtl.sufficientLength} reason=${minBtl.reason} need>=${minBtl.minSampleForObservedSharpe} obs=${minBtl.sampleCount} expMaxNullSharpe/bar=${minBtl.expectedMaxNullSharpe.toFixed(4)}`);
    console.log(`  Haircut (Bonferroni, true N): observed=${promo.gates.haircut.result.observedSharpe.toFixed(4)} -> haircutSharpe=${promo.gates.haircut.result.haircutSharpe.toFixed(4)} haircut=${(promo.gates.haircut.result.haircut * 100).toFixed(1)}% passed=${promo.gates.haircut.passed}`);
    console.log(`  gatesPassed=${promo.summary.gatesPassed}/${promo.summary.gatesApplicable}  reasons=[${promo.reasons.join(", ")}]`);

    // --- McLean-Pontiff decay realism: haircut the in-sample Sharpe ~50% ---
    const decayedSharpe = best.searchSharpe * (1 - DECAY_HAIRCUT);
    const decayedDsr = computeDeflatedSharpeRatio(
      best.result.netReturns.map((r) => r * (1 - DECAY_HAIRCUT)),
      { trialCount: grid.length },
    );
    console.log(`\n-- Decay realism (McLean-Pontiff 50% Sharpe haircut) --`);
    console.log(`  in-sample per-bar Sharpe ${best.searchSharpe.toFixed(4)} -> post-decay ${decayedSharpe.toFixed(4)}; post-decay DSR(trueN)=${decayedDsr.deflatedProbability.toFixed(4)}`);

    // --- CONSUME-ONCE FINAL HOLD-OUT (~24 months, never used for selection) ---
    const guard = new FinalHoldoutGuard();
    guard.consume({ reason: `exp3-${tf.name}-holdout`, trialCount: grid.length, nowIso: new Date().toISOString() });
    const holdoutRes = runConfig(holdoutCloses, best.cfg);
    const holdoutNet = compound(holdoutRes.netReturns);
    const holdoutGross = compound(holdoutRes.grossReturns);
    const holdoutBH = compound(buyAndHoldReturns(holdoutCloses));
    const holdoutStats = summarizeReturnSeries(holdoutRes.netReturns);
    console.log(`\n-- ONE-SHOT FINAL HOLD-OUT (~24mo, consume-once; starts ${holdoutStartIso}) --`);
    console.log(`  holdout bars=${holdoutRes.netReturns.length} trades=${holdoutRes.tradeCount} exposure=${pct(holdoutRes.exposure)}`);
    console.log(`  holdout NET=${pct(holdoutNet)} gross=${pct(holdoutGross)}  buy&hold=${pct(holdoutBH)}  per-bar Sharpe=${holdoutStats.sharpe.toFixed(4)}`);
    const holdoutBeatsBH = holdoutNet > holdoutBH;
    const holdoutPositive = holdoutNet > 0;
    console.log(`  holdout beats buy&hold? ${holdoutBeatsBH}    holdout positive net? ${holdoutPositive}`);

    // --- VERDICT for this timeframe ---
    const survivesGates = promo.promotable;
    const survivesDecay = decayedDsr.deflatedProbability >= DSR_THRESHOLD;
    const survivesHoldout = holdoutPositive && holdoutBeatsBH;
    const verdict = survivesGates && survivesDecay && survivesHoldout ? "PROMOTE" : "KILL";
    console.log(`\n>>> ${tf.name.toUpperCase()} VERDICT: ${verdict}`);
    console.log(`    survives full gate conjunction (true N)=${survivesGates}; survives 50% decay DSR=${survivesDecay}; survives hold-out (positive & beats B&H)=${survivesHoldout}`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("DONE.");
  console.log("=".repeat(80));
}

function monthsSpan(bars: Bar[]): number {
  if (bars.length < 2) return 1;
  const ms = bars.at(-1)!.ts - bars[0]!.ts;
  return Math.max(1, ms / (30.44 * 86_400_000));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
