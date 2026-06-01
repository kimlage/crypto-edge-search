/**
 * EXPERIMENT 1 — STEP 3 gate. Mirrors audit-population-significance.ts.
 *
 * Feeds the NET weekly L/S momentum returns into evaluatePromotion with:
 *   - candidateReturns = net weekly L/S returns of the BEST config
 *   - trialCount       = the TRUE N (number of K/quantile/mode configs actually tried)
 *   - barReturns       = equal-weight universe weekly returns (buy&hold + random lottery)
 *   - roundTripCost    = 0.0028
 *
 * Prints DSR(true N), MinBTL, baselines (beat buy&hold-the-universe + random lottery),
 * haircut. Also reports the McLean-Pontiff in-sample Sharpe haircut (~50%) for decay
 * realism and a post-2021 slice survival check. Pure reuse of committed cores.
 *
 * Run: <codex-node>/tsx scripts/audit-crossxs-momentum.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildWeeklyPanel,
  runCrossSectionalMomentum,
  type MomentumConfig,
} from "../src/lib/reorientation/cross-sectional-momentum";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import { summarizeReturnSeries } from "../src/lib/statistical-validation";
import { haircutSharpe } from "../src/lib/significance/haircut";

const ROUND_TRIP_COST = 0.0028;
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
  // 52 weeks/year; geometric-ish APR from arithmetic mean; Sharpe scaled by sqrt(52).
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

function main(): void {
  const panelPath = join("output", "crossxs", "weekly-returns.json");
  const metaPath = join("output", "crossxs", "panel-meta.json");
  const panel = JSON.parse(readFileSync(panelPath, "utf8")) as PanelFile;
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;

  const coins = Object.keys(panel.weeklyRet);
  const weeklyPanel = buildWeeklyPanel(panel.weeklyRet, coins);

  console.log("=".repeat(80));
  console.log("EXPERIMENT 1 — CROSS-SECTIONAL WEEKLY MOMENTUM — RIGOR GATE");
  console.log("=".repeat(80));
  console.log(`data source     : ${panel.source} (realData=${panel.realData})`);
  console.log(`universe        : ${coins.length} coins`);
  console.log(`weekly periods  : ${panel.weeks.length}  (${panel.weeks[0]} -> ${panel.weeks[panel.weeks.length - 1]})`);
  console.log(`round-trip cost : ${ROUND_TRIP_COST} (28 bps)`);
  console.log(`SURVIVORSHIP    : ${String(meta.survivorshipNote).slice(0, 120)}...`);

  // --- The config grid we ACTUALLY try => the TRUE N for deflation. ---
  const Ks = [2, 4, 8, 12];
  const quantiles = [0.1, 0.2];
  const modes: MomentumConfig["mode"][] = ["long_short", "long_only"];
  const skips = [0, 1];
  const grid: MomentumConfig[] = [];
  for (const lookbackWeeks of Ks)
    for (const quantile of quantiles)
      for (const mode of modes)
        for (const skipWeeks of skips) grid.push({ lookbackWeeks, quantile, mode, skipWeeks });
  const trueN = grid.length;
  console.log(`\nconfig grid tried (TRUE N) : ${trueN}  (K in [${Ks}] x q in [${quantiles}] x mode{LS,LO} x skip{0,1})`);

  // --- Run every config on the FULL sample, rank by net Sharpe. ---
  interface Row {
    cfg: MomentumConfig;
    net: number[];
    uni: number[];
    meanTO: number;
    sharpe: number;
    meanNet: number;
    compound: number;
  }
  const rows: Row[] = grid.map((cfg) => {
    const res = runCrossSectionalMomentum(weeklyPanel, { ...cfg, roundTripCost: ROUND_TRIP_COST });
    const s = summarizeReturnSeries(res.netReturns);
    return {
      cfg,
      net: res.netReturns,
      uni: res.universeReturns,
      meanTO: res.meanTurnover,
      sharpe: s.sharpe,
      meanNet: s.mean,
      compound: s.compoundReturn,
    };
  });

  rows.sort((a, b) => b.sharpe - a.sharpe);
  console.log("\n-- top configs by net weekly Sharpe (FULL sample, in-sample) --");
  for (const r of rows.slice(0, 6)) {
    const ann = annualizedFromWeekly(r.meanNet, summarizeReturnSeries(r.net).stdDev);
    console.log(
      `  K=${String(r.cfg.lookbackWeeks).padStart(2)} q=${r.cfg.quantile} ${r.cfg.mode!.padEnd(10)} skip=${r.cfg.skipWeeks} ` +
        `| netSharpe(wk)=${r.sharpe.toFixed(3)} annSharpe=${ann.sharpe.toFixed(2)} ` +
        `meanNet=${pct(r.meanNet)}/wk APR=${pct(ann.apr)} compound=${pct(r.compound)} meanTO=${r.meanTO.toFixed(2)}`,
    );
  }

  const best = rows[0]!;
  const bestStats = summarizeReturnSeries(best.net);
  const ann = annualizedFromWeekly(best.meanNet, bestStats.stdDev);
  const mdd = maxDrawdown(best.net);

  console.log("\n-- BEST in-sample config --");
  console.log(`  config        : K=${best.cfg.lookbackWeeks} q=${best.cfg.quantile} mode=${best.cfg.mode} skip=${best.cfg.skipWeeks}`);
  console.log(`  weeks traded  : ${best.net.length}   mean turnover/wk: ${best.meanTO.toFixed(3)} (1 rebalance/week)`);
  console.log(`  net mean/wk   : ${pct(best.meanNet)}   net weekly Sharpe: ${bestStats.sharpe.toFixed(3)}`);
  console.log(`  annualized    : APR=${pct(ann.apr)}  annSharpe=${ann.sharpe.toFixed(2)}  maxDD=${pct(mdd)}`);
  console.log(`  compound (net): ${pct(bestStats.compoundReturn)} over ${best.net.length} weeks`);

  // --- Feed into the unified promotion evaluator with TRUE N. ---
  const evaluation = evaluatePromotion({
    candidateId: `crossxs-K${best.cfg.lookbackWeeks}-q${best.cfg.quantile}-${best.cfg.mode}`,
    candidateReturns: best.net,
    sampleCount: best.net.length,
    trialCount: trueN,
    barReturns: best.uni,
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: 1,
    baselineStatistic: "compoundReturn",
    seed: "crossxs-audit",
  });

  const g = evaluation.gates;
  console.log("\n-- GATES (evaluatePromotion, TRUE N deflation) --");
  console.log(`  A1 baselines     : applicable=${g.baselines.applicable} passed=${g.baselines.passed}`);
  if (g.baselines.result) {
    for (const c of g.baselines.result.comparisons) {
      console.log(`       vs ${c.label.padEnd(22)}: baseline=${pct(c.baselineScore)} candidate=${pct(g.baselines.result.candidateScore)} margin=${pct(c.margin)} beaten=${c.beaten}`);
    }
  }
  console.log(`  A0 MinBTL        : passed=${g.minBtl.passed} reason=${g.minBtl.result.reason}`);
  console.log(`       observedSharpe=${g.minBtl.result.observedSharpe.toFixed(4)} expMaxNull=${g.minBtl.result.expectedMaxNullSharpe.toFixed(4)} minSampleNeeded=${g.minBtl.result.minSampleForObservedSharpe} (have ${best.net.length})`);
  console.log(`  A0/A2 DSR(N=${trueN}) : passed=${g.deflatedSharpe.passed} prob=${g.deflatedSharpe.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}) sharpe=${g.deflatedSharpe.sharpe.toFixed(4)}`);
  console.log(`  A5 haircut       : passed=${g.haircut.passed} haircutSharpe=${g.haircut.result.haircutSharpe.toFixed(4)} haircutFrac=${g.haircut.result.haircut.toFixed(3)} (method=${g.haircut.result.method})`);
  console.log(`  gates passed     : ${evaluation.summary.gatesPassed}/${evaluation.summary.gatesApplicable}  promotable=${evaluation.promotable}`);
  if (evaluation.reasons.length > 0) console.log(`  fail reasons     : ${evaluation.reasons.join(", ")}`);

  // --- McLean-Pontiff decay haircut (~50% of in-sample Sharpe) for realism. ---
  const decayedSharpe = bestStats.sharpe * 0.5;
  console.log("\n-- DECAY REALISM (McLean-Pontiff): halve the in-sample Sharpe --");
  console.log(`  in-sample net weekly Sharpe : ${bestStats.sharpe.toFixed(4)}`);
  console.log(`  post-publication (x0.5)     : ${decayedSharpe.toFixed(4)}  annualized ~${(decayedSharpe * Math.sqrt(52)).toFixed(2)}`);
  const hc = haircutSharpe({ observedSharpe: bestStats.sharpe, sampleCount: best.net.length, trialCount: trueN, method: "bonferroni" });
  console.log(`  Harvey-Liu haircut Sharpe   : ${hc.haircutSharpe.toFixed(4)} (>0 required) => ${hc.haircutSharpe > 0 ? "POSITIVE" : "NON-POSITIVE"}`);

  // --- Post-2021 slice survival (drop the early 2020-21 bull). ---
  // Recompute best config but keep only weeks whose date >= 2022-01-01.
  const cutoffIdx = panel.weeks.findIndex((w) => w >= "2022-01-01");
  if (cutoffIdx > 0) {
    const res = runCrossSectionalMomentum(weeklyPanel, { ...best.cfg, roundTripCost: ROUND_TRIP_COST });
    // Map the produced points back to week dates via their weekIndex (weekIndex is
    // an index into the original weekly array, offset by the realizable start).
    const post = res.points.filter((p) => panel.weeks[p.weekIndex] !== undefined && panel.weeks[p.weekIndex]! >= "2022-01-01").map((p) => p.netReturn);
    const ps = summarizeReturnSeries(post);
    const pann = annualizedFromWeekly(ps.mean, ps.stdDev);
    console.log("\n-- POST-2022 SLICE (decay/regime check) --");
    console.log(`  weeks          : ${post.length}`);
    console.log(`  net mean/wk    : ${pct(ps.mean)}  weeklySharpe=${ps.sharpe.toFixed(3)}  annSharpe=${pann.sharpe.toFixed(2)}`);
    console.log(`  compound (net) : ${pct(ps.compoundReturn)}  APR=${pct(pann.apr)}`);
    console.log(`  positive net   : ${ps.mean > 0 ? "YES" : "NO"}`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("IN-SAMPLE VERDICT (full-grid, best config):");
  if (evaluation.promotable) {
    console.log("  All applicable gates PASS in-sample. Proceed to STEP 4 one-shot hold-out.");
  } else {
    console.log(`  DOES NOT clear all gates in-sample. Failing: ${evaluation.reasons.join(", ")}`);
    console.log("  (The one-shot hold-out in STEP 4 is the binding, honest test.)");
  }
  console.log("=".repeat(80));
}

main();
