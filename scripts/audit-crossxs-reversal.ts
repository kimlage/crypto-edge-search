/**
 * TARGET 1 — CROSS-SECTIONAL SHORT-TERM REVERSAL (weekly), reuse output/crossxs.
 *
 * Each week LONG the worst-performing decile of the trailing window and SHORT the
 * best (the documented crypto short-term reversal effect; the OPPOSITE of E1
 * momentum, which was KILLED). Market-neutral L/S, rebalance weekly.
 *
 * This is the MIRROR of scripts/audit-crossxs-momentum.ts and uses the SAME real
 * Binance panel (output/crossxs/weekly-returns.json — 30 liquid USDT coins,
 * 2020-2026) and the SAME committed rigor cores. The only new logic is the
 * ranking inversion in scripts/lib/cross-sectional-reversal.ts (long losers,
 * short winners); cost/turnover/eligibility bookkeeping is identical, so the two
 * targets are directly comparable.
 *
 * METHOD (identical for every target):
 *   1) Transparent, causal rule (signal at t uses only data <= t-1). 28 bps
 *      round-trip. Turnover logged.
 *   2) Self-check: PURE-NOISE data must show NO edge; a future-data mutation must
 *      not change an earlier weekly decision (causality).
 *   3) Pick the single best config on the SEARCH slice ONLY; record the TRUE N.
 *   4) Reserve the most-recent ~24 months as a one-shot hold-out (holdout.ts
 *      consume-once). Evaluate the chosen config ONCE through evaluatePromotion.
 *   5) Apply a 50% McLean-Pontiff decay haircut. PROMOTE only if, on the hold-out:
 *      net-of-cost positive, beats the baseline (buy&hold / universe / lottery),
 *      DSR(true N) >= 0.95, MinBTL ok, haircut > 0.
 *
 * Run: <codex-node>/tsx scripts/audit-crossxs-reversal.ts
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import {
  buildWeeklyPanel,
  runCrossSectionalReversal,
  type ReversalConfig,
  type WeeklyPanel,
} from "./lib/cross-sectional-reversal";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import { summarizeReturnSeries } from "../src/lib/statistical-validation";
import { haircutSharpe } from "../src/lib/significance/haircut";
import { planHoldoutSplit, FinalHoldoutGuard } from "../src/lib/significance/holdout";

const ROUND_TRIP_COST = 0.0028; // 28 bps round-trip, same as E1 — comparable.
const DSR_THRESHOLD = 0.95;

interface PanelFile {
  source: string;
  realData: boolean;
  weeks: string[];
  weeklyRet: Record<string, (number | null)[]>;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(3)}%`;
}
function annualizedFromWeekly(meanWeekly: number, sdWeekly: number): { apr: number; sharpe: number } {
  const apr = Math.pow(1 + meanWeekly, 52) - 1;
  const sharpe = sdWeekly > 1e-12 ? (meanWeekly / sdWeekly) * Math.sqrt(52) : 0;
  return { apr, sharpe };
}
function maxDrawdown(returns: readonly number[]): number {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

// Deterministic PRNG (mulberry32) for the noise self-check — seeded, no external dep.
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

/** Build a pure-noise panel with the SAME shape (same coins/weeks, iid normal-ish returns). */
function buildNoisePanel(template: PanelFile, seed: number): WeeklyPanel {
  const rng = mulberry32(seed);
  const coins = Object.keys(template.weeklyRet);
  const noiseRet: Record<string, (number | null)[]> = {};
  for (const coin of coins) {
    const len = template.weeklyRet[coin]!.length;
    const series: number[] = [];
    for (let i = 0; i < len; i += 1) {
      // Box-Muller-ish: sum of 3 uniforms centered, scaled to ~6% weekly vol.
      const z = (rng() + rng() + rng() - 1.5) / 0.866;
      series.push(z * 0.06);
    }
    noiseRet[coin] = series;
  }
  return buildWeeklyPanel(noiseRet, coins);
}

/** Restrict a panel's returns to week indexes [start, end). Returns a sub-panel + a
 * map from sub-index back to the original week index (for date labels). */
function slicePanel(panel: WeeklyPanel, start: number, end: number): WeeklyPanel {
  const sliced: Record<string, (number | null)[]> = {};
  for (const coin of panel.coins) {
    sliced[coin] = (panel.weeklyRet[coin] ?? []).slice(start, end) as (number | null)[];
  }
  return buildWeeklyPanel(sliced, panel.coins);
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function main(): void {
  const panelPath = join("output", "crossxs", "weekly-returns.json");
  const metaPath = join("output", "crossxs", "panel-meta.json");
  const panel = JSON.parse(readFileSync(panelPath, "utf8")) as PanelFile;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;

  const coins = Object.keys(panel.weeklyRet);
  const fullPanel = buildWeeklyPanel(panel.weeklyRet, coins);
  const totalWeeks = panel.weeks.length;

  console.log("=".repeat(80));
  console.log("TARGET 1 — CROSS-SECTIONAL WEEKLY SHORT-TERM REVERSAL — RIGOR GATE");
  console.log("=".repeat(80));
  console.log(`data source     : ${panel.source} (realData=${panel.realData})`);
  console.log(`universe        : ${coins.length} coins`);
  console.log(`weekly periods  : ${totalWeeks}  (${panel.weeks[0]} -> ${panel.weeks[totalWeeks - 1]})`);
  console.log(`round-trip cost : ${ROUND_TRIP_COST} (28 bps, same as E1 momentum)`);
  console.log(`rule            : LONG worst trailing-K decile, SHORT best decile (reversal = -momentum)`);
  console.log(`SURVIVORSHIP    : ${String(meta.survivorshipNote).slice(0, 110)}...`);

  // ===================================================================
  // STEP 2 — SELF-CHECKS (no hallucination, causality)
  // ===================================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 2 — SELF-CHECKS");
  console.log("-".repeat(80));

  // (a) PURE NOISE must show NO edge. The honest no-hallucination test is on the
  //     GROSS (pre-cost) return: with iid-noise ranks, the rule must have ~0 gross
  //     Sharpe/mean. (Net is driven slightly NEGATIVE by the 28 bps cost drag on
  //     ~4 sides/wk of turnover — which is correct: a no-edge rule must LOSE money
  //     net, never fabricate a positive edge.) We require gross ~0 AND net NOT
  //     positive across many independent noise panels.
  const noiseCfg: ReversalConfig = { lookbackWeeks: 1, quantile: 0.1, mode: "long_short", skipWeeks: 0, roundTripCost: ROUND_TRIP_COST };
  let grossSharpeSum = 0;
  let grossMeanSum = 0;
  let netMeanSum = 0;
  const noiseRuns = 40;
  for (let s = 0; s < noiseRuns; s += 1) {
    const np = buildNoisePanel(panel, 1000 + s);
    const res = runCrossSectionalReversal(np, noiseCfg);
    const gs = summarizeReturnSeries(res.grossReturns);
    const ns = summarizeReturnSeries(res.netReturns);
    grossSharpeSum += gs.sharpe;
    grossMeanSum += gs.mean;
    netMeanSum += ns.mean;
  }
  const grossSharpe = grossSharpeSum / noiseRuns;
  const grossMean = grossMeanSum / noiseRuns;
  const netMean = netMeanSum / noiseRuns;
  const noiseOk = Math.abs(grossSharpe) < 0.05 && Math.abs(grossMean) < 0.0010 && netMean <= 0;
  console.log(`(a) pure-noise (${noiseRuns} panels): GROSS netSharpe=${grossSharpe.toFixed(4)} grossMean=${pct(grossMean)}/wk  netMean=${pct(netMean)}/wk`);
  console.log(`    => ${noiseOk ? "PASS" : "FAIL"} (gross ~0 => no fabricated edge; net <=0 => cost drag, never spurious profit)`);

  // (b) CAUSALITY: mutating FUTURE returns must NOT change an earlier weekly net
  //     return. Pick an early realizable week, record its net; then corrupt all
  //     returns AFTER that week and re-run — the early net must be identical.
  const baseRes = runCrossSectionalReversal(fullPanel, noiseCfg);
  const probeIdx = Math.min(20, baseRes.points.length - 1);
  const probeWeek = baseRes.points[probeIdx]!.weekIndex;
  const probeNet = baseRes.points[probeIdx]!.netReturn;
  const mutated: Record<string, (number | null)[]> = {};
  for (const coin of coins) {
    const arr = [...(panel.weeklyRet[coin] ?? [])];
    for (let i = probeWeek + 1; i < arr.length; i += 1) arr[i] = (arr[i] ?? 0) + 999; // corrupt the FUTURE
    mutated[coin] = arr;
  }
  const mutPanel = buildWeeklyPanel(mutated, coins);
  const mutRes = runCrossSectionalReversal(mutPanel, noiseCfg);
  const mutPoint = mutRes.points.find((p) => p.weekIndex === probeWeek);
  const causalOk = mutPoint !== undefined && Math.abs(mutPoint.netReturn - probeNet) < 1e-12;
  console.log(`(b) causality: week@idx${probeWeek} net before=${pct(probeNet)} after future-corruption=${mutPoint ? pct(mutPoint.netReturn) : "MISSING"}`);
  console.log(`    => ${causalOk ? "PASS" : "FAIL"} (corrupting weeks > t leaves the decision at t unchanged)`);

  if (!noiseOk || !causalOk) {
    console.log("\nSELF-CHECK FAILED — aborting before any verdict.");
    process.exit(1);
  }

  // ===================================================================
  // STEP 3 — SEARCH-SLICE config selection (TRUE N), holdout NEVER seen
  // ===================================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 3 — CONFIG SEARCH (search slice only) + TRUE N");
  console.log("-".repeat(80));

  // Hold-out = most-recent ~24 months. 24 months ~= 104 weeks of 301 => ~0.345.
  // Use planHoldoutSplit with holdoutFraction sized to ~24 months; testFraction=0
  // (this target uses a single binding vault, no posterior-audit slice).
  const targetHoldoutWeeks = 104; // ~24 months
  const holdoutFraction = targetHoldoutWeeks / totalWeeks;
  const plan = planHoldoutSplit({ totalRows: totalWeeks, holdoutFraction, testFraction: 0 });
  const searchEnd = plan.search.end; // exclusive
  const holdoutStart = plan.finalHoldout.start;
  console.log(`holdout plan    : total=${plan.totalRows} search=[0,${searchEnd}) holdout=[${holdoutStart},${plan.finalHoldout.end}) (${plan.finalHoldout.rows} wks ~24mo)`);
  console.log(`search window   : ${panel.weeks[0]} -> ${panel.weeks[searchEnd - 1]}`);
  console.log(`holdout window  : ${panel.weeks[holdoutStart]} -> ${panel.weeks[totalWeeks - 1]} (VAULT — touched once)`);

  // Anti-leakage: the search panel is literally truncated to weeks < searchEnd.
  const searchPanel = slicePanel(fullPanel, 0, searchEnd);

  // The config grid we ACTUALLY try => the TRUE N for deflation. Short-term
  // reversal lives at short lookbacks, so the grid centers there.
  const Ks = [1, 2, 3, 4];
  const quantiles = [0.1, 0.2];
  const modes: ReversalConfig["mode"][] = ["long_short", "long_only"];
  const skips = [0, 1];
  const grid: ReversalConfig[] = [];
  for (const lookbackWeeks of Ks)
    for (const quantile of quantiles)
      for (const mode of modes)
        for (const skipWeeks of skips) grid.push({ lookbackWeeks, quantile, mode, skipWeeks });
  const trueN = grid.length;
  console.log(`\nconfig grid (TRUE N) : ${trueN}  (K in [${Ks}] x q in [${quantiles}] x mode{LS,LO} x skip{0,1})`);

  interface Row {
    cfg: ReversalConfig;
    sharpe: number;
    meanNet: number;
    compound: number;
    meanTO: number;
  }
  const rows: Row[] = grid.map((cfg) => {
    const res = runCrossSectionalReversal(searchPanel, { ...cfg, roundTripCost: ROUND_TRIP_COST });
    const s = summarizeReturnSeries(res.netReturns);
    return { cfg, sharpe: s.sharpe, meanNet: s.mean, compound: s.compoundReturn, meanTO: res.meanTurnover };
  });
  rows.sort((a, b) => b.sharpe - a.sharpe);

  console.log("\n-- top configs by net weekly Sharpe (SEARCH slice only) --");
  for (const r of rows.slice(0, 6)) {
    console.log(
      `  K=${String(r.cfg.lookbackWeeks).padStart(2)} q=${r.cfg.quantile} ${r.cfg.mode!.padEnd(10)} skip=${r.cfg.skipWeeks} ` +
        `| netSharpe(wk)=${r.sharpe.toFixed(3)} meanNet=${pct(r.meanNet)}/wk compound=${pct(r.compound)} meanTO=${r.meanTO.toFixed(2)}`,
    );
  }

  const best = rows[0]!;
  console.log(`\nCHOSEN config (search-slice best): K=${best.cfg.lookbackWeeks} q=${best.cfg.quantile} mode=${best.cfg.mode} skip=${best.cfg.skipWeeks}`);
  console.log(`  search-slice netSharpe(wk)=${best.sharpe.toFixed(4)} meanNet=${pct(best.meanNet)}/wk`);

  // The task asks for a MARKET-NEUTRAL reversal. The unconstrained search winner is
  // long_only (it rides crypto beta by holding the dumpers in a bull tape — NOT a
  // neutral reversal edge). Report the best genuinely market-neutral (long_short)
  // config too, so the neutral claim is on record. Both modes are in the same grid
  // (so trueN already accounts for them); the holdout evaluation below uses the
  // search-best config exactly as the consume-once protocol requires.
  const bestLS = rows.find((r) => r.cfg.mode === "long_short");
  if (bestLS) {
    console.log(`  [market-neutral] best long_short on search slice: K=${bestLS.cfg.lookbackWeeks} q=${bestLS.cfg.quantile} skip=${bestLS.cfg.skipWeeks} netSharpe(wk)=${bestLS.sharpe.toFixed(4)} meanNet=${pct(bestLS.meanNet)}/wk`);
  }

  // ===================================================================
  // STEP 4 — ONE-SHOT HOLD-OUT evaluation (consume-once)
  // ===================================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 4 — ONE-SHOT HOLD-OUT (consume-once vault)");
  console.log("-".repeat(80));

  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "TARGET1 reversal one-shot holdout", gitSha: gitSha(), trialCount: trueN, nowIso: new Date().toISOString() });
  console.log(`guard consumed  : ${guard.isConsumed()} (sha=${guard.status().gitSha} N=${guard.status().trialCount})`);

  // Run the CHOSEN config over the WHOLE panel, then keep only the holdout weeks.
  // We need the trailing lookback to warm up across the search/holdout boundary,
  // so we run on the full panel and filter realized weeks by date >= holdout start.
  const fullRun = runCrossSectionalReversal(fullPanel, { ...best.cfg, roundTripCost: ROUND_TRIP_COST });
  const holdoutDate = panel.weeks[holdoutStart]!;
  const holdoutPoints = fullRun.points.filter((p) => panel.weeks[p.weekIndex] !== undefined && panel.weeks[p.weekIndex]! >= holdoutDate);
  const holdoutNet = holdoutPoints.map((p) => p.netReturn);
  // Equal-weight universe (the bar) over the SAME holdout weeks.
  const universeAll = fullRun.points.map((p, i) => ({ weekIdx: p.weekIndex, uni: fullRun.universeReturns[i]! }));
  const holdoutUni = universeAll.filter((u) => panel.weeks[u.weekIdx]! >= holdoutDate).map((u) => u.uni);
  const holdoutTO = holdoutPoints.reduce((a, p) => a + p.turnover, 0) / Math.max(1, holdoutPoints.length);

  const hStats = summarizeReturnSeries(holdoutNet);
  const hAnn = annualizedFromWeekly(hStats.mean, hStats.stdDev);
  const hMdd = maxDrawdown(holdoutNet);
  console.log(`holdout weeks   : ${holdoutNet.length}  mean turnover/wk=${holdoutTO.toFixed(3)}`);
  console.log(`holdout net/wk  : ${pct(hStats.mean)}  netSharpe(wk)=${hStats.sharpe.toFixed(4)}`);
  console.log(`holdout annual  : APR=${pct(hAnn.apr)} annSharpe=${hAnn.sharpe.toFixed(2)} maxDD=${pct(hMdd)}`);
  console.log(`holdout compound: ${pct(hStats.compoundReturn)} over ${holdoutNet.length} weeks  positive=${hStats.mean > 0 ? "YES" : "NO"}`);

  // Feed the HOLD-OUT net series into the unified evaluator with the TRUE N.
  const evaluation = evaluatePromotion({
    candidateId: `reversal-K${best.cfg.lookbackWeeks}-q${best.cfg.quantile}-${best.cfg.mode}`,
    candidateReturns: holdoutNet,
    sampleCount: holdoutNet.length,
    trialCount: trueN,
    barReturns: holdoutUni,
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: 1,
    baselineStatistic: "compoundReturn",
    seed: "reversal-audit",
  });

  const g = evaluation.gates;
  console.log("\n-- GATES on HOLD-OUT (evaluatePromotion, TRUE N deflation) --");
  console.log(`  A1 baselines     : applicable=${g.baselines.applicable} passed=${g.baselines.passed}`);
  if (g.baselines.result) {
    for (const c of g.baselines.result.comparisons) {
      console.log(`       vs ${c.label.padEnd(22)}: baseline=${pct(c.baselineScore)} candidate=${pct(g.baselines.result.candidateScore)} margin=${pct(c.margin)} beaten=${c.beaten}`);
    }
  }
  console.log(`  A0 MinBTL        : passed=${g.minBtl.passed} reason=${g.minBtl.result.reason}`);
  console.log(`       observedSharpe=${g.minBtl.result.observedSharpe.toFixed(4)} expMaxNull=${g.minBtl.result.expectedMaxNullSharpe.toFixed(4)} minSampleNeeded=${g.minBtl.result.minSampleForObservedSharpe} (have ${holdoutNet.length})`);
  console.log(`  A0/A2 DSR(N=${trueN}) : passed=${g.deflatedSharpe.passed} prob=${g.deflatedSharpe.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}) sharpe=${g.deflatedSharpe.sharpe.toFixed(4)}`);
  console.log(`  A5 haircut       : passed=${g.haircut.passed} haircutSharpe=${g.haircut.result.haircutSharpe.toFixed(4)} haircutFrac=${g.haircut.result.haircut.toFixed(3)} (method=${g.haircut.result.method})`);
  console.log(`  gates passed     : ${evaluation.summary.gatesPassed}/${evaluation.summary.gatesApplicable}  promotable=${evaluation.promotable}`);
  if (evaluation.reasons.length > 0) console.log(`  fail reasons     : ${evaluation.reasons.join(", ")}`);

  // ===================================================================
  // STEP 5 — McLean-Pontiff 50% decay haircut
  // ===================================================================
  console.log("\n" + "-".repeat(80));
  console.log("STEP 5 — McLEAN-PONTIFF 50% DECAY HAIRCUT (on holdout Sharpe)");
  console.log("-".repeat(80));
  const decayedSharpe = hStats.sharpe * 0.5;
  const hc = haircutSharpe({ observedSharpe: hStats.sharpe, sampleCount: holdoutNet.length, trialCount: trueN, method: "bonferroni" });
  console.log(`  holdout net weekly Sharpe   : ${hStats.sharpe.toFixed(4)}`);
  console.log(`  post-publication (x0.5)     : ${decayedSharpe.toFixed(4)}  annualized ~${(decayedSharpe * Math.sqrt(52)).toFixed(2)}`);
  console.log(`  Harvey-Liu haircut Sharpe   : ${hc.haircutSharpe.toFixed(4)} => ${hc.haircutSharpe > 0 ? "POSITIVE" : "NON-POSITIVE"}`);
  const decayPositive = decayedSharpe > 0 && hc.haircutSharpe > 0;

  // ===================================================================
  // MARKET-NEUTRAL (long_short) holdout — what the task actually asked for
  // ===================================================================
  console.log("\n" + "-".repeat(80));
  console.log("MARKET-NEUTRAL (long_short) REVERSAL on the SAME holdout weeks");
  console.log("-".repeat(80));
  let lsHoldoutPoints = holdoutPoints; // fallback
  if (bestLS) {
    const lsRun = runCrossSectionalReversal(fullPanel, { ...bestLS.cfg, roundTripCost: ROUND_TRIP_COST });
    lsHoldoutPoints = lsRun.points.filter((p) => panel.weeks[p.weekIndex] !== undefined && panel.weeks[p.weekIndex]! >= holdoutDate);
    const lsStats = summarizeReturnSeries(lsHoldoutPoints.map((p) => p.netReturn));
    const lsAnn = annualizedFromWeekly(lsStats.mean, lsStats.stdDev);
    console.log(`  config          : K=${bestLS.cfg.lookbackWeeks} q=${bestLS.cfg.quantile} long_short skip=${bestLS.cfg.skipWeeks}`);
    console.log(`  holdout net/wk  : ${pct(lsStats.mean)} netSharpe(wk)=${lsStats.sharpe.toFixed(4)} annSharpe=${lsAnn.sharpe.toFixed(2)} compound=${pct(lsStats.compoundReturn)} positive=${lsStats.mean > 0 ? "YES" : "NO"}`);
  }

  // ===================================================================
  // DIRECT COMPARISON vs E1 MOMENTUM (same panel, same vault window)
  // ===================================================================
  console.log("\n" + "-".repeat(80));
  console.log("DIRECT COMPARISON vs E1 MOMENTUM (KILLED) on the SAME holdout weeks");
  console.log("-".repeat(80));
  // The genuinely market-neutral reversal book is the EXACT sign-mirror of the
  // market-neutral momentum book (same names, opposite weights): gross_momentum =
  // -gross_reversal, and the cost term is identical (same turnover). So momentum's
  // holdout net = -(reversal gross) - cost. We use the LONG_SHORT book for this
  // identity to hold (it does NOT hold for long_only, where the mirror would be a
  // short_only momentum, not the symmetric L/S). This is the apples-to-apples E1.
  const lsGrossHoldout = lsHoldoutPoints.map((p) => p.grossReturn);
  const lsNetHoldout = lsHoldoutPoints.map((p) => p.netReturn);
  const lsRevStats = summarizeReturnSeries(lsNetHoldout);
  const momNetHoldout = lsHoldoutPoints.map((p, i) => -lsGrossHoldout[i]! - p.cost);
  const momStats = summarizeReturnSeries(momNetHoldout);
  console.log(`  reversal (L/S) holdout: net/wk=${pct(lsRevStats.mean)} netSharpe=${lsRevStats.sharpe.toFixed(4)} compound=${pct(lsRevStats.compoundReturn)}`);
  console.log(`  momentum (L/S) holdout: net/wk=${pct(momStats.mean)} netSharpe=${momStats.sharpe.toFixed(4)} compound=${pct(momStats.compoundReturn)}`);
  console.log(`  (momentum L/S = exact sign-mirror of reversal L/S gross, minus the identical cost term)`);

  // ===================================================================
  // VERDICT
  // ===================================================================
  console.log("\n" + "=".repeat(80));
  const netPositive = hStats.mean > 0;
  const promote = evaluation.promotable && netPositive && decayPositive;
  if (promote) {
    console.log("HOLD-OUT VERDICT: PROMOTE. Net-positive, beats baseline, DSR/MinBTL/haircut pass,");
    console.log("                 and survives the 50% decay haircut on the one-shot vault.");
  } else {
    console.log("HOLD-OUT VERDICT: KILL. The chosen config does NOT clear all gates on the one-shot");
    console.log(`                 hold-out. netPositive=${netPositive} promotable=${evaluation.promotable} decayPositive=${decayPositive}`);
    if (evaluation.reasons.length > 0) console.log(`                 fail reasons: ${evaluation.reasons.join(", ")}`);
  }
  console.log("=".repeat(80));
}

main();
