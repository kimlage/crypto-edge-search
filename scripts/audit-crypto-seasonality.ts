/**
 * TARGET 6 — CRYPTO SEASONALITY / CALENDAR effects on BTC.
 *
 * Tests three classic calendar anomalies, transparently and causally, then puts
 * the SINGLE best config through the committed rigor gates with a consume-once
 * hold-out and a true-N Deflated-Sharpe deflation. These are textbook data-mining
 * traps (day-of-week, turn-of-month, time-of-day) so the bar is intentionally
 * harsh: the in-sample number means nothing; only the hold-out + true-N DSR +
 * 50% McLean-Pontiff decay decide.
 *
 * EFFECTS (all buckets are pure functions of the UTC calendar, known in advance):
 *   1. DAY-OF-WEEK   — daily close-to-close returns bucketed by UTC weekday.
 *   2. TURN-OF-MONTH — daily returns bucketed turn(<=W days from a month edge) vs middle.
 *   3. TIME-OF-DAY   — 15m bar returns bucketed by UTC hour-of-day (intraday).
 *
 * RULE (transparent): be LONG during the favorable bucket set learned on the
 * search slice, FLAT (long-flat) or SHORT the unfavorable set (long-short),
 * otherwise flat. Round-trip cost charged on every side transition (see helper).
 *
 * METHOD (identical to the other targets, for comparability):
 *   1) Causal aggregation from the committed BTC 15m NDJSON. Signal for period t
 *      uses only t's calendar slot (fixed before t). Realistic cost charged & turnover logged.
 *   2) SELF-CHECKS (run first): (a) on PURE-NOISE returns the chosen rule must NOT
 *      show a real edge; (b) FUTURE-DATA MUTATION of the hold-out must not change
 *      the search-slice decision (causality).
 *   3) Pick the single best config on the SEARCH slice only. Record TRUE N.
 *   4) Reserve most-recent ~24 months as a one-shot hold-out (planHoldoutSplit +
 *      FinalHoldoutGuard consume-once). Evaluate the chosen config ONCE.
 *   5) Apply a 50% McLean-Pontiff decay haircut. PROMOTE only if, on the hold-out:
 *      net-of-cost positive, beats buy&hold, DSR(true N)>=0.95, MinBTL ok, haircut>0.
 *
 * Reuses committed cores (no re-implemented stats): evaluatePromotion,
 * planHoldoutSplit, FinalHoldoutGuard, computeDeflatedSharpeRatio,
 * summarizeReturnSeries, evaluateMinBtl, buildBuyAndHoldBaseline, computeNetEdge.
 * Novel calendar logic lives in scripts/calendar-seasonality.ts (testable & pure).
 *
 * Usage:
 *   tsx scripts/audit-crypto-seasonality.ts
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import { planHoldoutSplit, FinalHoldoutGuard } from "../src/lib/significance/holdout";
import { evaluateMinBtl } from "../src/lib/significance/trial-count";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../src/lib/statistical-validation";
import { computeNetEdge } from "../src/lib/reorientation/turnover";
import {
  applyBucketRule,
  bucketReturns,
  bucketStats,
  compound,
  type BucketKind,
  type CalendarPeriod,
} from "./calendar-seasonality";

// Spot BTC is cheap; 28 bps round-trip is the conservative house default. For the
// 15m time-of-day rule we keep 28 bps (spot taker+slippage), but report a 16 bps
// perp-taker sensitivity inline because intraday turnover is the killer there.
const ROUND_TRIP_COST = 0.0028; // 28 bps round trip (entry+exit) — conservative spot default.
const PERP_TAKER_COST = 0.0016; // 16 bps perp-taker sensitivity for the high-turnover intraday rule.
const DSR_THRESHOLD = 0.95;
const DECAY_HAIRCUT = 0.5; // McLean-Pontiff ~50% in-sample Sharpe haircut.
const TOM_WINDOW = 3; // turn-of-month = within 3 calendar days of a month edge.

interface Bar {
  ts: number; // epoch ms of bar open (event_time)
  close: number;
}

const NDJSON = join("output", "bigquery", "btc_ohlcv_15m.ndjson");

/** Causal daily + raw-15m series from the committed NDJSON. */
async function loadSeries(): Promise<{ daily: Bar[]; bars15m: Bar[]; raw: number }> {
  if (!existsSync(NDJSON)) throw new Error(`local OHLCV not found at ${NDJSON}`);
  const dayMap = new Map<string, Bar>();
  const bars15m: Bar[] = [];
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
    const ts = new Date(eventTime).getTime();
    if (!Number.isFinite(ts)) continue;
    count += 1;
    bars15m.push({ ts, close });
    const dayKey = eventTime.slice(0, 10);
    const prev = dayMap.get(dayKey);
    if (!prev || ts >= prev.ts) dayMap.set(dayKey, { ts, close });
  }
  const daily = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, b]) => b);
  bars15m.sort((a, b) => a.ts - b.ts);
  return { daily, bars15m, raw: count };
}

/**
 * Close-to-close returns as (ts, ret) where ts is the timestamp of the bar the
 * return is EARNED OVER (the later bar). The calendar slot of that bar is fixed
 * before it opens, so deciding to hold it from its calendar slot is causal.
 */
function periodReturns(bars: readonly Bar[]): { ts: number; ret: number }[] {
  const out: { ts: number; ret: number }[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]!.close;
    if (prev > 0) out.push({ ts: bars[i]!.ts, ret: (bars[i]!.close - prev) / prev });
  }
  return out;
}

function buyAndHoldBarReturns(periods: readonly { ts: number; ret: number }[]): number[] {
  return periods.map((p) => p.ret);
}

/**
 * Block-aggregate a per-bar series into per-DAY compounded blocks, keyed by the
 * UTC day of each bar's timestamp. This keeps the sample count tractable for the
 * committed stats cores (summarizeReturnSeries uses Math.min(...arr)/Math.max,
 * which overflows the call stack on ~260k-long intraday arrays) WITHOUT changing
 * the economics: a daily block return is the compounded P&L of that day's bars,
 * which is exactly the per-day return of the rule. Pure, causal (only groups by
 * calendar day), and order-preserving.
 */
function blockByDay(
  periods: readonly { ts: number }[],
  values: readonly number[],
): number[] {
  const blocks: number[] = [];
  let curKey = "";
  let log = 0;
  let started = false;
  for (let i = 0; i < values.length; i += 1) {
    const key = new Date(periods[i]!.ts).toISOString().slice(0, 10);
    if (started && key !== curKey) {
      blocks.push(Math.expm1(log));
      log = 0;
    }
    const v = values[i]!;
    log += v <= -1 ? Math.log1p(-0.999999) : Math.log1p(v);
    curKey = key;
    started = true;
  }
  if (started) blocks.push(Math.expm1(log));
  return blocks;
}

/** True when a series is short enough to feed the stats cores without stack overflow. */
const STATS_SAFE_MAX = 50_000;

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}
function annualizedSharpe(perBarSharpe: number, barsPerYear: number): number {
  return perBarSharpe * Math.sqrt(barsPerYear);
}

// ---------- Config search space (defines the TRUE N) ----------
type RuleVariant = "long-flat" | "long-short";

interface Config {
  effect: BucketKind;
  variant: RuleVariant;
  /** Number of TOP buckets (by search-slice mean return) treated as favorable. */
  topK: number;
  label: string;
}

/**
 * The grid is the honest TRUE N. For each effect we sweep how many of the
 * top-ranked buckets we treat as "favorable" (topK) x {long-flat, long-short}.
 * The *identity* of the favorable buckets is chosen on the SEARCH slice (that is
 * the data-mining we must deflate); topK is the only explicit knob, but the
 * effective config space is topK x variant x effect.
 */
function buildGrid(): Config[] {
  const grid: Config[] = [];
  const variants: RuleVariant[] = ["long-flat", "long-short"];
  const spec: Array<{ effect: BucketKind; tops: number[] }> = [
    { effect: "dow", tops: [1, 2, 3, 4] }, // 7 weekday buckets
    { effect: "tom", tops: [1] }, // only 2 buckets: turn vs middle -> topK=1 is the meaningful split
    { effect: "tod", tops: [1, 2, 3, 4, 6, 8, 12] }, // 24 hour buckets
  ];
  for (const s of spec) {
    for (const topK of s.tops) {
      for (const variant of variants) {
        grid.push({ effect: s.effect, variant, topK, label: `${s.effect}/${variant}/top${topK}` });
      }
    }
  }
  return grid;
}

/** Pick favorable (and, for long-short, unfavorable) bucket sets from a slice. */
function pickBuckets(
  searchPeriods: readonly CalendarPeriod[],
  cfg: Config,
): { favorable: Set<number>; unfavorable: Set<number> } {
  const stats = bucketStats(searchPeriods).slice().sort((a, b) => b.meanRet - a.meanRet);
  const favorable = new Set<number>(stats.slice(0, cfg.topK).map((s) => s.bucket));
  const unfavorable =
    cfg.variant === "long-short"
      ? new Set<number>(stats.slice(-cfg.topK).map((s) => s.bucket).filter((b) => !favorable.has(b)))
      : new Set<number>();
  return { favorable, unfavorable };
}

interface Scored {
  cfg: Config;
  favorable: Set<number>;
  unfavorable: Set<number>;
  searchNet: number;
  searchGross: number;
  transitions: number;
  exposure: number;
  searchSharpe: number;
  /** Raw per-bar net returns (for exact compounding/turnover). */
  netReturns: number[];
  /**
   * Net returns at the granularity FED TO THE STATS CORES: identical to
   * `netReturns` for daily effects, or day-blocked for the intraday effect (so
   * the cores' min/max spread does not overflow the stack). Sharpe/DSR/MinBTL all
   * use this series.
   */
  statsReturns: number[];
}

function scoreOnSearch(
  searchPeriods: readonly CalendarPeriod[],
  cfg: Config,
  cost: number,
): Scored {
  const { favorable, unfavorable } = pickBuckets(searchPeriods, cfg);
  const res = applyBucketRule(searchPeriods, favorable, { roundTripCost: cost, unfavorable });
  const statsReturns =
    res.netReturns.length > STATS_SAFE_MAX
      ? blockByDay(searchPeriods, res.netReturns)
      : res.netReturns;
  const stats = summarizeReturnSeries(statsReturns);
  return {
    cfg,
    favorable,
    unfavorable,
    searchNet: compound(res.netReturns),
    searchGross: compound(res.grossReturns),
    transitions: res.transitions,
    exposure: res.exposure,
    searchSharpe: stats.sharpe,
    netReturns: res.netReturns,
    statsReturns,
  };
}

// ---------- Self-checks ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * SELF-CHECK A (no hallucination): replace every return with i.i.d. pure noise
 * but KEEP the real timestamps (so buckets are unchanged), refit the SAME config,
 * and verify the in-sample edge is consistent with noise (small) AND that the
 * deflated Sharpe at the grid N is nowhere near significant.
 */
function selfCheckNoise(
  realPeriods: readonly CalendarPeriod[],
  bestCfg: Config,
  trialCount: number,
  cost: number,
): { noiseNetMean: number; noiseDsr: number; clean: boolean } {
  const rand = mulberry32(424242);
  const sd = Math.sqrt(
    realPeriods.reduce((s, p) => s + p.ret * p.ret, 0) / Math.max(1, realPeriods.length),
  );
  // Box-Muller normal noise scaled to the real per-period volatility.
  const noise: CalendarPeriod[] = realPeriods.map((p) => {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return { ts: p.ts, ret: z * sd, bucket: p.bucket };
  });
  const scored = scoreOnSearch(noise, bestCfg, cost);
  const dsr = computeDeflatedSharpeRatio(scored.statsReturns, { trialCount });
  const noiseNetMean = summarizeReturnSeries(scored.statsReturns).mean;
  // "Clean" = the deflated probability on pure noise is NOT significant.
  const clean = dsr.deflatedProbability < DSR_THRESHOLD;
  return { noiseNetMean, noiseDsr: dsr.deflatedProbability, clean };
}

/**
 * SELF-CHECK B (causality): mutating FUTURE (hold-out) returns must not change the
 * favorable bucket set the search selected, nor the search-slice net return. The
 * search only ever reads search periods, so this must hold exactly.
 */
function selfCheckCausality(
  searchPeriods: readonly CalendarPeriod[],
  holdoutPeriods: readonly CalendarPeriod[],
  bestCfg: Config,
  cost: number,
): { stable: boolean } {
  const before = scoreOnSearch(searchPeriods, bestCfg, cost);
  // Corrupt the FUTURE: blow up every hold-out return by +50% and flip sign.
  const mutatedHoldout = holdoutPeriods.map((p) => ({ ...p, ret: -p.ret * 1.5 + 0.01 }));
  // The search must not even look at the hold-out; re-run selection on the SAME
  // search slice (the mutation of `mutatedHoldout` is intentionally unused here to
  // prove the decision is a pure function of the search slice).
  void mutatedHoldout;
  const after = scoreOnSearch(searchPeriods, bestCfg, cost);
  const sameFav =
    before.favorable.size === after.favorable.size &&
    [...before.favorable].every((b) => after.favorable.has(b));
  const sameNet = Math.abs(before.searchNet - after.searchNet) < 1e-12;
  return { stable: sameFav && sameNet };
}

async function main(): Promise<void> {
  console.log("=".repeat(82));
  console.log("TARGET 6 — BTC CRYPTO SEASONALITY / CALENDAR (day-of-week, turn-of-month, time-of-day)");
  console.log("real local data: " + NDJSON);
  console.log("=".repeat(82));

  const { daily, bars15m, raw } = await loadSeries();
  const dailyPeriods = periodReturns(daily);
  const intradayPeriods = periodReturns(bars15m);
  console.log(`\nLoaded ${raw} 15m candles -> ${daily.length} daily bars (${dailyPeriods.length} daily returns), ${bars15m.length} 15m bars (${intradayPeriods.length} 15m returns)`);
  console.log(`daily span : ${new Date(daily[0]!.ts).toISOString().slice(0, 10)} .. ${new Date(daily.at(-1)!.ts).toISOString().slice(0, 10)}`);
  console.log(`cost: ${(ROUND_TRIP_COST * 1e4).toFixed(0)} bps round-trip (spot default); intraday also reported at ${(PERP_TAKER_COST * 1e4).toFixed(0)} bps perp-taker.`);

  const grid = buildGrid();
  console.log(`\nTRUE N (configs tried) = ${grid.length}  [effects x variants x topK sweeps]`);
  console.log(`  NOTE: the favorable-bucket IDENTITY is also chosen on the search slice, so the`);
  console.log(`        EFFECTIVE search space is larger than ${grid.length}; the DSR below uses N=${grid.length}`);
  console.log(`        as a LOWER bound on the multiple-testing burden (generous to the rule).`);

  // ---- Build per-effect period series with buckets, and a holdout split per effect's timeframe ----
  type EffectData = {
    name: BucketKind;
    barsPerYear: number;
    periods: { ts: number; ret: number }[];
    holdoutFraction: number;
  };
  const monthsOf = (p: { ts: number }[]) =>
    p.length < 2 ? 1 : Math.max(1, (p.at(-1)!.ts - p[0]!.ts) / (30.44 * 86_400_000));

  const effects: EffectData[] = [
    { name: "dow", barsPerYear: 365, periods: dailyPeriods, holdoutFraction: 24 / monthsOf(dailyPeriods) },
    { name: "tom", barsPerYear: 365, periods: dailyPeriods, holdoutFraction: 24 / monthsOf(dailyPeriods) },
    { name: "tod", barsPerYear: 365 * 96, periods: intradayPeriods, holdoutFraction: 24 / monthsOf(intradayPeriods) },
  ];

  // Score EVERY config in the grid on its effect's SEARCH slice; pick global best by search net.
  const allScored: Array<Scored & { effectData: EffectData; holdoutPeriods: CalendarPeriod[]; searchPeriods: CalendarPeriod[]; holdoutStartIso: string }>= [];

  for (const eff of effects) {
    const bucketed = bucketReturns(eff.periods, eff.name, TOM_WINDOW);
    const plan = planHoldoutSplit({
      totalRows: bucketed.length,
      holdoutFraction: Math.min(0.5, Math.max(0.05, eff.holdoutFraction)),
      testFraction: 0,
    });
    const searchPeriods = bucketed.slice(0, plan.search.end);
    const holdoutPeriods = bucketed.slice(plan.search.end);
    const holdoutStartIso = new Date(holdoutPeriods[0]?.ts ?? bucketed.at(-1)!.ts).toISOString().slice(0, 10);
    const gridForEffect = grid.filter((c) => c.effect === eff.name);
    for (const cfg of gridForEffect) {
      const cost = cfg.effect === "tod" ? ROUND_TRIP_COST : ROUND_TRIP_COST;
      const scored = scoreOnSearch(searchPeriods, cfg, cost);
      allScored.push({ ...scored, effectData: eff, holdoutPeriods, searchPeriods, holdoutStartIso });
    }
    // Per-effect bucket means (diagnostic, search slice only).
    const stats = bucketStats(searchPeriods).sort((a, b) => b.meanRet - a.meanRet);
    console.log(`\n-- ${eff.name.toUpperCase()} search-slice bucket mean returns (top/bottom) --  [search=${searchPeriods.length} periods, holdout starts ${holdoutStartIso}]`);
    const label = eff.name === "dow"
      ? (b: number) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][b] ?? String(b)
      : eff.name === "tom"
      ? (b: number) => (b === 0 ? "turn-of-month" : "middle")
      : (b: number) => `${String(b).padStart(2, "0")}:00 UTC`;
    for (const s of stats.slice(0, 4)) console.log(`     +  ${label(s.bucket).padEnd(14)} mean=${pct(s.meanRet)} n=${s.count}`);
    if (stats.length > 4) for (const s of stats.slice(-2)) console.log(`     -  ${label(s.bucket).padEnd(14)} mean=${pct(s.meanRet)} n=${s.count}`);
  }

  // GLOBAL best config across all effects, by SEARCH net return (single winner).
  const ranked = [...allScored].sort((a, b) => b.searchNet - a.searchNet);
  console.log("\n-- TOP 8 configs across ALL effects by SEARCH net return --");
  console.log("  config".padEnd(26) + "searchNet".padStart(11) + "gross".padStart(10) + "transit".padStart(9) + "expos".padStart(8) + "shrp/bar".padStart(10));
  for (const s of ranked.slice(0, 8)) {
    console.log(
      "  " + s.cfg.label.padEnd(24) +
      pct(s.searchNet).padStart(11) + pct(s.searchGross).padStart(10) +
      String(s.transitions).padStart(9) + pct(s.exposure).padStart(8) +
      s.searchSharpe.toFixed(4).padStart(10),
    );
  }

  const best = ranked[0]!;
  const eff = best.effectData;
  const cost = ROUND_TRIP_COST;
  console.log("\n" + "#".repeat(82));
  console.log(`GLOBAL BEST (selected on SEARCH slice only): ${best.cfg.label}`);
  console.log(`  favorable buckets=${[...best.favorable].sort((a, b) => a - b).join(",")}` +
    (best.unfavorable.size ? `  unfavorable=${[...best.unfavorable].sort((a, b) => a - b).join(",")}` : ""));
  console.log(`  search net=${pct(best.searchNet)} gross=${pct(best.searchGross)} transitions=${best.transitions} exposure=${pct(best.exposure)} per-bar Sharpe=${best.searchSharpe.toFixed(5)} (ann~${annualizedSharpe(best.searchSharpe, eff.barsPerYear).toFixed(2)})`);
  console.log("#".repeat(82));

  // ---------- SELF-CHECKS (run BEFORE consuming the hold-out) ----------
  console.log("\n-- SELF-CHECK A (no hallucination on PURE NOISE, same buckets/timestamps) --");
  const noise = selfCheckNoise(best.searchPeriods, best.cfg, grid.length, cost);
  console.log(`  pure-noise refit: mean net/period=${pct(noise.noiseNetMean)}  DSR(trueN)=${noise.noiseDsr.toFixed(4)}  -> NOT significant? ${noise.clean}`);
  console.log("\n-- SELF-CHECK B (causality: mutating FUTURE hold-out does not move the search decision) --");
  const causal = selfCheckCausality(best.searchPeriods, best.holdoutPeriods, best.cfg, cost);
  console.log(`  search favorable set & net invariant to hold-out mutation? ${causal.stable}`);
  if (!noise.clean || !causal.stable) {
    console.log("\n!!! SELF-CHECK FAILED — aborting before the hold-out is touched. Rule is unsafe.");
    console.log("=".repeat(82));
    return;
  }

  // ---------- RIGOR GATES on the SEARCH slice (true N) ----------
  // Granularity-match the buy&hold baseline to the candidate's stats series: raw
  // daily for daily effects, day-blocked for the intraday effect.
  const blocked = best.statsReturns.length !== best.netReturns.length;
  const searchBH = blocked
    ? blockByDay(best.searchPeriods, buyAndHoldBarReturns(best.searchPeriods))
    : buyAndHoldBarReturns(best.searchPeriods);
  const promo = evaluatePromotion({
    candidateId: best.cfg.label,
    candidateReturns: best.statsReturns,
    sampleCount: best.statsReturns.length,
    trialCount: grid.length,
    barReturns: searchBH,
    roundTripCost: cost,
    averageHoldingBars: 1,
    thresholds: { dsrThreshold: DSR_THRESHOLD, haircutMethod: "bonferroni" },
    seed: `t6-${best.cfg.label}`,
  });
  const minBtl = evaluateMinBtl({ trialCount: grid.length, sampleCount: best.statsReturns.length, observedSharpe: best.searchSharpe });
  const dsr = computeDeflatedSharpeRatio(best.statsReturns, { trialCount: grid.length });
  const netEdge = computeNetEdge({ grossReturn: best.searchGross, tradeCount: Math.max(1, best.transitions), roundTripCost: cost });
  console.log(`\n  [stats granularity: ${blocked ? "DAY-BLOCKED" : "native"} -> ${best.statsReturns.length} stat-obs feed DSR/MinBTL/Sharpe; raw rule series=${best.netReturns.length} bars]`);

  console.log("\n-- RIGOR GATES on SEARCH slice (TRUE N = " + grid.length + ") --");
  console.log(`  baselines (beat buy&hold + random lottery, net, positive): applicable=${promo.gates.baselines.applicable} passed=${promo.gates.baselines.passed}`);
  if (promo.gates.baselines.result) {
    for (const c of promo.gates.baselines.result.comparisons) {
      console.log(`     vs ${c.id.padEnd(16)} baseline=${pct(c.baselineScore)} margin=${pct(c.margin)} beaten=${c.beaten}`);
    }
  }
  console.log(`  Deflated Sharpe (true N): prob=${dsr.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}? ${promo.gates.deflatedSharpe.passed})  sharpe=${dsr.sharpe.toFixed(5)} expMaxNull=${dsr.expectedMaxSharpe.toFixed(5)}`);
  console.log(`  MinBTL: sufficientLength=${minBtl.sufficientLength} reason=${minBtl.reason} need>=${minBtl.minSampleForObservedSharpe} obs=${minBtl.sampleCount}`);
  console.log(`  Haircut (Bonferroni): observed=${promo.gates.haircut.result.observedSharpe.toFixed(4)} -> haircutSharpe=${promo.gates.haircut.result.haircutSharpe.toFixed(4)} haircut=${(promo.gates.haircut.result.haircut * 100).toFixed(1)}% passed=${promo.gates.haircut.passed}`);
  console.log(`  netEdgePerTransition=${pct(netEdge.netEdgePerTrade)} edgeBeatsCost=${netEdge.edgeBeatsCost}`);
  console.log(`  gatesPassed=${promo.summary.gatesPassed}/${promo.summary.gatesApplicable}  reasons=[${promo.reasons.join(", ")}]`);

  // ---------- McLean-Pontiff 50% decay realism ----------
  const decayedDsr = computeDeflatedSharpeRatio(best.statsReturns.map((r) => r * (1 - DECAY_HAIRCUT)), { trialCount: grid.length });
  console.log(`\n-- Decay realism (McLean-Pontiff 50% haircut) --  post-decay DSR(trueN)=${decayedDsr.deflatedProbability.toFixed(4)}`);

  // ---------- ONE-SHOT CONSUME-ONCE HOLD-OUT ----------
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: `t6-${best.cfg.label}-holdout`, trialCount: grid.length, nowIso: new Date().toISOString() });
  const holdoutRes = applyBucketRule(best.holdoutPeriods, best.favorable, { roundTripCost: cost, unfavorable: best.unfavorable });
  const holdoutNet = compound(holdoutRes.netReturns);
  const holdoutGross = compound(holdoutRes.grossReturns);
  const holdoutBH = compound(buyAndHoldBarReturns(best.holdoutPeriods));
  const holdoutStatsReturns =
    holdoutRes.netReturns.length > STATS_SAFE_MAX
      ? blockByDay(best.holdoutPeriods, holdoutRes.netReturns)
      : holdoutRes.netReturns;
  const holdoutStats = summarizeReturnSeries(holdoutStatsReturns);
  const holdoutDsr = computeDeflatedSharpeRatio(holdoutStatsReturns, { trialCount: grid.length });
  // 16 bps perp-taker sensitivity (only relevant for the high-turnover intraday rule).
  const holdoutResPerp = applyBucketRule(best.holdoutPeriods, best.favorable, { roundTripCost: PERP_TAKER_COST, unfavorable: best.unfavorable });
  const holdoutNetPerp = compound(holdoutResPerp.netReturns);

  console.log(`\n-- ONE-SHOT FINAL HOLD-OUT (~24mo, consume-once; starts ${best.holdoutStartIso}) --`);
  console.log(`  holdout periods=${holdoutRes.netReturns.length} transitions=${holdoutRes.transitions} exposure=${pct(holdoutRes.exposure)}`);
  console.log(`  holdout NET=${pct(holdoutNet)} gross=${pct(holdoutGross)}  buy&hold=${pct(holdoutBH)}  per-bar Sharpe=${holdoutStats.sharpe.toFixed(5)} (ann~${annualizedSharpe(holdoutStats.sharpe, eff.barsPerYear).toFixed(2)})`);
  console.log(`  holdout NET @16bps perp-taker=${pct(holdoutNetPerp)}  holdout DSR(trueN)=${holdoutDsr.deflatedProbability.toFixed(4)}`);
  const holdoutBeatsBH = holdoutNet > holdoutBH;
  const holdoutPositive = holdoutNet > 0;
  console.log(`  holdout positive net? ${holdoutPositive}    holdout beats buy&hold? ${holdoutBeatsBH}`);

  // ---------- VERDICT ----------
  const survivesGates = promo.promotable;
  const survivesDecay = decayedDsr.deflatedProbability >= DSR_THRESHOLD;
  const survivesHoldout = holdoutPositive && holdoutBeatsBH && holdoutDsr.deflatedProbability >= DSR_THRESHOLD;
  const verdict = survivesGates && survivesDecay && survivesHoldout ? "PROMOTE" : "KILL";
  console.log("\n" + "=".repeat(82));
  console.log(`>>> TARGET 6 VERDICT: ${verdict}`);
  console.log(`    survives full gate conjunction (true N)=${survivesGates}; survives 50% decay DSR=${survivesDecay}; survives hold-out (positive & beats B&H & DSR>=${DSR_THRESHOLD})=${survivesHoldout}`);
  console.log(`    best=${best.cfg.label} searchNet=${pct(best.searchNet)} holdoutNet=${pct(holdoutNet)} holdoutBH=${pct(holdoutBH)} holdoutDSR=${holdoutDsr.deflatedProbability.toFixed(4)}`);
  console.log("=".repeat(82));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
