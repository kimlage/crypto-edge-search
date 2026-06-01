/**
 * EXPERIMENT 1 — STEP 4. ONE-SHOT hold-out (the binding, honest test).
 *
 * Reserve the most-recent ~24 months as a vault that the search NEVER sees
 * (planHoldoutSplit + FinalHoldoutGuard, consumed exactly once). On the EARLIER
 * search window ONLY, pick the single best config by net weekly Sharpe. Then
 * evaluate THAT config exactly once on the vault and run the rigor gates with the
 * TRUE N. PROMOTE only if the hold-out net-of-cost is positive, beats
 * buy&hold-the-universe, DSR(true N) >= 0.95, MinBTL ok, and haircut > 0.
 *
 * Run: <codex-node>/tsx scripts/holdout-crossxs-momentum.ts
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import {
  buildWeeklyPanel,
  runCrossSectionalMomentum,
  type MomentumConfig,
  type WeeklyPanel,
} from "../src/lib/reorientation/cross-sectional-momentum";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import { summarizeReturnSeries } from "../src/lib/statistical-validation";
import {
  planHoldoutSplit,
  FinalHoldoutGuard,
} from "../src/lib/significance/holdout";

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
function annSharpe(meanWeekly: number, sdWeekly: number): number {
  return sdWeekly > 1e-12 ? (meanWeekly / sdWeekly) * Math.sqrt(52) : 0;
}
function apr(meanWeekly: number): number {
  return Math.pow(1 + meanWeekly, 52) - 1;
}

/** Slice a panel to weeks [start, end) (by week index). */
function slicePanel(panel: PanelFile, start: number, end: number): WeeklyPanel {
  const coins = Object.keys(panel.weeklyRet);
  const sliced: Record<string, (number | null)[]> = {};
  for (const c of coins) sliced[c] = panel.weeklyRet[c]!.slice(start, end);
  return buildWeeklyPanel(sliced, coins);
}

function main(): void {
  const panelPath = join("output", "crossxs", "weekly-returns.json");
  const panel = JSON.parse(readFileSync(panelPath, "utf8")) as PanelFile;
  const totalWeeks = panel.weeks.length;

  console.log("=".repeat(80));
  console.log("EXPERIMENT 1 — ONE-SHOT HOLD-OUT (consume-once vault)");
  console.log("=".repeat(80));
  console.log(`data source : ${panel.source} (realData=${panel.realData})`);
  console.log(`total weeks : ${totalWeeks}  (${panel.weeks[0]} -> ${panel.weeks[totalWeeks - 1]})`);

  // Reserve ~24 months (~104 weeks) as the vault => fraction = 104/total.
  const vaultWeeks = 104;
  const holdoutFraction = Math.min(0.45, vaultWeeks / totalWeeks);
  const plan = planHoldoutSplit({ totalRows: totalWeeks, holdoutFraction, testFraction: 0 });
  const searchEnd = plan.search.end;
  const vaultStart = plan.finalHoldout.start;
  const vaultEnd = plan.finalHoldout.end;

  console.log(`\nholdout fraction : ${holdoutFraction.toFixed(3)} (~24 months)`);
  console.log(`search window    : weeks [0, ${searchEnd})  ${panel.weeks[0]} -> ${panel.weeks[searchEnd - 1]}  (${searchEnd} wk)`);
  console.log(`VAULT (one-shot) : weeks [${vaultStart}, ${vaultEnd})  ${panel.weeks[vaultStart]} -> ${panel.weeks[vaultEnd - 1]}  (${vaultEnd - vaultStart} wk)`);

  // --- The same config grid as the audit => TRUE N. ---
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
  console.log(`\nTRUE N (configs tried) : ${trueN}`);

  // --- SELECT on the search window ONLY. ---
  const searchPanel = slicePanel(panel, 0, searchEnd);
  interface Row {
    cfg: MomentumConfig;
    sharpe: number;
    meanNet: number;
  }
  const searchRows: Row[] = grid.map((cfg) => {
    const res = runCrossSectionalMomentum(searchPanel, { ...cfg, roundTripCost: ROUND_TRIP_COST });
    const s = summarizeReturnSeries(res.netReturns);
    return { cfg, sharpe: s.sharpe, meanNet: s.mean };
  });
  searchRows.sort((a, b) => b.sharpe - a.sharpe);
  const chosen = searchRows[0]!;
  console.log("\n-- SELECTION on the search window (earlier data ONLY) --");
  for (const r of searchRows.slice(0, 5)) {
    console.log(`     K=${String(r.cfg.lookbackWeeks).padStart(2)} q=${r.cfg.quantile} ${r.cfg.mode!.padEnd(10)} skip=${r.cfg.skipWeeks} | searchNetSharpe(wk)=${r.sharpe.toFixed(3)} meanNet=${pct(r.meanNet)}/wk`);
  }
  console.log(`  CHOSEN config : K=${chosen.cfg.lookbackWeeks} q=${chosen.cfg.quantile} mode=${chosen.cfg.mode} skip=${chosen.cfg.skipWeeks} (single pick, no peeking at vault)`);

  // --- CONSUME the vault ONCE. ---
  const guard = new FinalHoldoutGuard();
  let gitSha: string | null = null;
  try {
    gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    gitSha = null;
  }
  guard.consume({ reason: "crossxs-momentum-experiment-1", gitSha, trialCount: trueN, nowIso: new Date().toISOString() });
  console.log(`\nVAULT consumed once (guard): ${JSON.stringify(guard.status())}`);

  // To evaluate the chosen config on the vault WITHOUT look-ahead at the boundary,
  // run it on the panel ending at vaultEnd, then keep only points whose realized
  // week index falls inside [vaultStart, vaultEnd). The trailing signal therefore
  // uses real prior weeks (including the last weeks of the search window), which is
  // legitimate: the signal is causal and the SELECTION never saw the vault returns.
  const fullPanel = buildWeeklyPanel(panel.weeklyRet, Object.keys(panel.weeklyRet));
  const res = runCrossSectionalMomentum(fullPanel, { ...chosen.cfg, roundTripCost: ROUND_TRIP_COST });
  const vaultPoints = res.points.filter((p) => p.weekIndex >= vaultStart && p.weekIndex < vaultEnd);
  const vaultNet = vaultPoints.map((p) => p.netReturn);
  const vaultGross = vaultPoints.map((p) => p.grossReturn);
  const vaultUni: number[] = [];
  // universeReturns is aligned to res.points; map by position.
  res.points.forEach((p, i) => {
    if (p.weekIndex >= vaultStart && p.weekIndex < vaultEnd) vaultUni.push(res.universeReturns[i]!);
  });

  const vs = summarizeReturnSeries(vaultNet);
  const vgross = summarizeReturnSeries(vaultGross);
  const meanTO = vaultPoints.reduce((a, p) => a + p.turnover, 0) / Math.max(1, vaultPoints.length);

  console.log("\n-- VAULT performance (chosen config, evaluated ONCE) --");
  console.log(`  weeks            : ${vaultNet.length}`);
  console.log(`  gross mean/wk    : ${pct(vgross.mean)}   net mean/wk: ${pct(vs.mean)}`);
  console.log(`  mean turnover/wk : ${meanTO.toFixed(3)}`);
  console.log(`  net weekly Sharpe: ${vs.sharpe.toFixed(4)}   annSharpe: ${annSharpe(vs.mean, vs.stdDev).toFixed(2)}`);
  console.log(`  net compound     : ${pct(vs.compoundReturn)}   APR: ${pct(apr(vs.mean))}`);

  // --- Rigor gates on the VAULT with TRUE N. ---
  const evaluation = evaluatePromotion({
    candidateId: `crossxs-vault-K${chosen.cfg.lookbackWeeks}-q${chosen.cfg.quantile}-${chosen.cfg.mode}`,
    candidateReturns: vaultNet,
    sampleCount: vaultNet.length,
    trialCount: trueN,
    barReturns: vaultUni,
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: 1,
    baselineStatistic: "compoundReturn",
    seed: "crossxs-holdout",
  });
  const g = evaluation.gates;

  // Buy&hold-the-universe over the vault (explicit, for the PROMOTE condition).
  const uniCompound = summarizeReturnSeries(vaultUni).compoundReturn;

  console.log("\n-- VAULT GATES (TRUE N deflation) --");
  console.log(`  A1 baselines  : passed=${g.baselines.passed}`);
  if (g.baselines.result) {
    for (const c of g.baselines.result.comparisons) {
      console.log(`       vs ${c.label.padEnd(22)}: baseline=${pct(c.baselineScore)} candidate=${pct(g.baselines.result.candidateScore)} beaten=${c.beaten}`);
    }
  }
  console.log(`  buy&hold-uni  : compound=${pct(uniCompound)}  candidate=${pct(vs.compoundReturn)}  beats=${vs.compoundReturn > uniCompound}`);
  console.log(`  A0 MinBTL     : passed=${g.minBtl.passed} reason=${g.minBtl.result.reason} (minSampleNeeded=${g.minBtl.result.minSampleForObservedSharpe}, have ${vaultNet.length})`);
  console.log(`  A0/A2 DSR(N=${trueN}): passed=${g.deflatedSharpe.passed} prob=${g.deflatedSharpe.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}) sharpe=${g.deflatedSharpe.sharpe.toFixed(4)}`);
  console.log(`  A5 haircut    : passed=${g.haircut.passed} haircutSharpe=${g.haircut.result.haircutSharpe.toFixed(4)} (>0 required)`);
  console.log(`  gates passed  : ${evaluation.summary.gatesPassed}/${evaluation.summary.gatesApplicable}`);
  if (evaluation.reasons.length > 0) console.log(`  fail reasons  : ${evaluation.reasons.join(", ")}`);

  // --- PROMOTE decision (all conditions). ---
  const netPositive = vs.mean > 0 && vs.compoundReturn > 0;
  const beatsBH = vs.compoundReturn > uniCompound;
  const dsrOk = g.deflatedSharpe.deflatedProbability >= DSR_THRESHOLD;
  const minBtlOk = g.minBtl.passed;
  const haircutOk = g.haircut.result.haircutSharpe > 0;
  const promote = netPositive && beatsBH && dsrOk && minBtlOk && haircutOk;

  console.log("\n" + "=".repeat(80));
  console.log("PROMOTE conditions (one-shot hold-out):");
  console.log(`  net-of-cost positive        : ${netPositive}`);
  console.log(`  beats buy&hold-the-universe : ${beatsBH}`);
  console.log(`  DSR(true N) >= ${DSR_THRESHOLD}         : ${dsrOk}  (${g.deflatedSharpe.deflatedProbability.toFixed(4)})`);
  console.log(`  MinBTL ok                   : ${minBtlOk}`);
  console.log(`  haircut > 0                 : ${haircutOk}  (${g.haircut.result.haircutSharpe.toFixed(4)})`);
  console.log("");
  console.log(`  VERDICT: ${promote ? "PROMOTE" : "KILL"}`);
  console.log("=".repeat(80));
}

main();
