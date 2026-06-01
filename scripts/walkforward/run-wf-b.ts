/**
 * TRACK WF-B — Walk-forward ADAPTIVE indicator strategy, main test.
 *
 * Hypothesis under test: markets are non-stationary, so the optimal indicator
 * config DRIFTS; a fixed param decays; therefore ADAPT (walk-forward re-opt) to
 * recover edge. We test this RIGOROUSLY and HONESTLY.
 *
 * Methodology (non-negotiable):
 *  - STRICT CAUSALITY: at each re-opt step t, pick param using ONLY [t-IS, t),
 *    then trade [t, t+h) with it; roll forward. Adaptive OOS = concat of slices.
 *  - 4 BENCHMARKS: (1) buy-and-hold; (2) fixed-param locked on FIRST IS window;
 *    (3) random-param WF; (4) surrogate/placebo (same machinery on phase-rand &
 *    block-shuffle surrogates that preserve vol+autocorr).
 *  - REALISTIC COST 4bps/side on every position change; report extra turnover.
 *  - HONEST N = meta-grid (IS windows x OOS horizons x families) for DSR/haircut.
 *  - CONSUME-ONCE HOLDOUT: last ~18% of timeline; meta-config selected on the
 *    earlier portion; holdout scored EXACTLY ONCE.
 *
 * Decisive questions: (Q1) does the optimal param drift TRACKABLY (autocorrelated)
 * or jump randomly? (Q2) adaptive beats buy-and-hold net of cost on holdout?
 * (Q3) beats honest fixed-param? (Q4) does the SAME machinery 'find edge' on
 * surrogates (=> artifact)?
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSETS,
  REPO_ROOT,
  TAKER_FEE_PER_SIDE,
  loadAllAssets,
  buildParamGrid,
  gridForFamily,
  computeSignal,
  backtestSlice,
  phaseRandomizedCloses,
  blockShuffledCloses,
  makeRng,
  avg,
  std,
  compound,
  annualizedSharpe,
  autocorr1,
  paramKey,
  type AssetSeries,
  type ParamConfig,
  type Family,
} from "./wf-lib";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
} from "../../src/lib/statistical-validation";
import {
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  evaluateBaselineGate,
  baselineScoreFromReturns,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import { evaluateMinBtl } from "../../src/lib/significance/trial-count";
import { planHoldoutSplit, FinalHoldoutGuard } from "../../src/lib/significance/holdout";

const FAMILIES: Family[] = ["bollinger", "donchian", "ma_cross"];
const IS_WINDOWS = [180, 365, 540];
const OOS_HORIZONS = [30, 60, 90];
const BARS_PER_YEAR = 365;

interface MetaConfig {
  isWindow: number;
  oosHorizon: number;
  family: Family;
}

interface WfStepRecord {
  asset: string;
  oosStart: number; // index of first OOS bar
  chosen: ParamConfig;
  chosenA: number; // numeric handle for drift autocorr (normalized rank within family grid)
}

interface WfOutcome {
  /** concatenated net OOS returns across all assets and steps (adaptive) */
  adaptiveNet: number[];
  adaptiveGross: number[];
  /** fixed-param-locked-first-window net OOS */
  fixedNet: number[];
  /** random-param WF net OOS */
  randomNet: number[];
  /** buy-and-hold net OOS over same bars */
  bhNet: number[];
  adaptiveTurnover: number;
  fixedTurnover: number;
  adaptiveCost: number;
  fixedCost: number;
  adaptiveTrades: number;
  steps: WfStepRecord[];
  oosBars: number;
}

/**
 * Run the walk-forward for one meta-config across all assets and return the
 * concatenated OOS series for adaptive / fixed / random / buy-and-hold, all net
 * of cost. `barsLimit` restricts every asset to indices [0, barsLimit) so we can
 * keep the consume-once holdout untouched during meta-selection.
 *
 * `closesOf` lets us swap real closes for surrogate closes (placebo) while
 * keeping the EXACT SAME machinery.
 */
function runWalkForward(
  assets: AssetSeries[],
  meta: MetaConfig,
  barsLimit: number,
  closesOf: (a: AssetSeries) => number[],
  randomSeed: number,
): WfOutcome {
  const out: WfOutcome = {
    adaptiveNet: [],
    adaptiveGross: [],
    fixedNet: [],
    randomNet: [],
    bhNet: [],
    adaptiveTurnover: 0,
    fixedTurnover: 0,
    adaptiveCost: 0,
    fixedCost: 0,
    adaptiveTrades: 0,
    steps: [],
    oosBars: 0,
  };
  const grid = gridForFamily(meta.family);
  const rng = makeRng(randomSeed);

  for (const asset of assets) {
    const closes = closesOf(asset).slice(0, barsLimit);
    const returns = new Array<number>(closes.length).fill(0);
    for (let i = 1; i < closes.length; i += 1) returns[i] = closes[i] / closes[i - 1] - 1;
    const n = closes.length;

    // precompute every param's full causal signal once
    const sigs = new Map<string, number[]>();
    for (const p of grid) sigs.set(paramKey(p), computeSignal(closes, p));

    // first re-opt step starts at index isWindow (need a full IS window behind it)
    const firstOos = meta.isWindow;
    if (firstOos >= n) continue;

    // FIXED-param baseline: optimize ONCE on the first IS window [0, isWindow)
    const fixedBest = pickBest(grid, sigs, returns, 0, meta.isWindow);
    const fixedSig = sigs.get(paramKey(fixedBest))!;

    let adaptivePriorPos = 0;
    let fixedPriorPos = 0;
    let randomPriorPos = 0;

    for (let oosStart = firstOos; oosStart < n; oosStart += meta.oosHorizon) {
      const oosEnd = Math.min(oosStart + meta.oosHorizon, n);
      const isStart = Math.max(0, oosStart - meta.isWindow);

      // ADAPTIVE: pick best param on trailing IS window [isStart, oosStart)
      const best = pickBest(grid, sigs, returns, isStart, oosStart);
      const bestSig = sigs.get(paramKey(best))!;
      const btA = backtestSlice(returns, bestSig, oosStart, oosEnd, adaptivePriorPos);
      out.adaptiveNet.push(...btA.netReturns);
      out.adaptiveGross.push(...btA.grossReturns);
      out.adaptiveTurnover += btA.turnover;
      out.adaptiveCost += btA.costPaid;
      out.adaptiveTrades += btA.tradeCount;
      adaptivePriorPos = btA.positions.at(-1) ?? adaptivePriorPos;

      // FIXED: same OOS slice, param locked on first window
      const btF = backtestSlice(returns, fixedSig, oosStart, oosEnd, fixedPriorPos);
      out.fixedNet.push(...btF.netReturns);
      out.fixedTurnover += btF.turnover;
      out.fixedCost += btF.costPaid;
      fixedPriorPos = btF.positions.at(-1) ?? fixedPriorPos;

      // RANDOM-param WF: pick a random param from the family each step
      const randp = grid[Math.floor(rng() * grid.length)];
      const randSig = sigs.get(paramKey(randp))!;
      const btR = backtestSlice(returns, randSig, oosStart, oosEnd, randomPriorPos);
      out.randomNet.push(...btR.netReturns);
      randomPriorPos = btR.positions.at(-1) ?? randomPriorPos;

      // BUY-AND-HOLD over same OOS bars (cost charged once at first bar of slice
      // handled below at concat level; here we just collect gross long returns)
      for (let i = oosStart; i < oosEnd; i += 1) out.bhNet.push(returns[i]);

      // drift record: normalized rank of chosen config within the family grid
      const rank = grid.findIndex((g) => paramKey(g) === paramKey(best));
      out.steps.push({
        asset: asset.asset,
        oosStart,
        chosen: best,
        chosenA: rank / Math.max(1, grid.length - 1),
      });
      out.oosBars += oosEnd - oosStart;
    }
  }
  return out;
}

/** Pick the param maximizing net-of-cost Sharpe over [from, to). */
function pickBest(
  grid: ParamConfig[],
  sigs: Map<string, number[]>,
  returns: number[],
  from: number,
  to: number,
): ParamConfig {
  let best = grid[0];
  let bestSharpe = -Infinity;
  for (const p of grid) {
    const sig = sigs.get(paramKey(p))!;
    const bt = backtestSlice(returns, sig, from, to, 0);
    const m = avg(bt.netReturns);
    const s = std(bt.netReturns, m);
    const sharpe = s > 1e-12 ? m / s : 0;
    if (sharpe > bestSharpe) {
      bestSharpe = sharpe;
      best = p;
    }
  }
  return best;
}

/** Charge buy-and-hold a single round-trip cost at the start of the concat path. */
function buyHoldNetSeries(bh: number[]): number[] {
  if (bh.length === 0) return [];
  const rt = 2 * TAKER_FEE_PER_SIDE; // one entry + one exit over the whole window
  return [bh[0] - rt, ...bh.slice(1)];
}

function perBarStats(xs: number[]) {
  const s = summarizeReturnSeries(xs);
  return {
    n: s.sampleCount,
    mean: s.mean,
    sharpe: s.sharpe,
    annSharpe: annualizedSharpe(s.sharpe, BARS_PER_YEAR),
    compound: s.compoundReturn,
  };
}

// ===========================================================================
// MAIN
// ===========================================================================
function main() {
  const log: string[] = [];
  const say = (s = "") => {
    log.push(s);
    console.log(s);
  };

  say("==================================================================");
  say("TRACK WF-B — Walk-forward ADAPTIVE indicator strategy (majors, daily)");
  say("==================================================================");

  const assets = loadAllAssets();
  const minBars = Math.min(...assets.map((a) => a.bars.length));
  say(`Assets: ${ASSETS.join(", ")}`);
  say(`Bars per asset (min): ${minBars}  range ${assets[0].bars[0].date} .. ${assets[0].bars.at(-1)!.date}`);
  say(`Fee: ${(TAKER_FEE_PER_SIDE * 1e4).toFixed(1)} bps/side (taker perp)`);

  // ---- consume-once holdout split on the timeline (last ~18%) -------------
  const plan = planHoldoutSplit({ totalRows: minBars, holdoutFraction: 0.18, testFraction: 0.0 });
  const holdoutStart = plan.finalHoldout.start;
  const searchBars = plan.search.end; // == holdoutStart (testFraction 0)
  say("");
  say(`HOLDOUT PLAN: search[0,${searchBars}) | holdout[${holdoutStart},${minBars}) (last ${(plan.finalHoldout.rows / minBars * 100).toFixed(1)}%)`);
  say(`  holdout dates ${assets[0].bars[holdoutStart]?.date} .. ${assets[0].bars[minBars - 1]?.date}`);

  // META-GRID size = honest N for the multiple-testing surface
  const metaGrid: MetaConfig[] = [];
  for (const isWindow of IS_WINDOWS)
    for (const oosHorizon of OOS_HORIZONS)
      for (const family of FAMILIES)
        metaGrid.push({ isWindow, oosHorizon, family });
  const N = metaGrid.length;
  say("");
  say(`META-GRID (honest N for DSR/haircut): ${IS_WINDOWS.length} IS-windows x ${OOS_HORIZONS.length} OOS-horizons x ${FAMILIES.length} families = ${N}`);

  // =====================================================================
  // PHASE 1 — META-SELECTION on SEARCH portion only (holdout untouched).
  // For each meta-config, run the adaptive WF on [0, searchBars). Select the
  // meta-config with the best net-of-cost Sharpe on the search OOS series.
  // =====================================================================
  say("");
  say("PHASE 1 — meta-config selection on SEARCH portion (holdout NOT touched)");
  const realCloses = (a: AssetSeries) => a.bars.map((b) => b.close);
  const metaResults = metaGrid.map((meta) => {
    const o = runWalkForward(assets, meta, searchBars, realCloses, 12345);
    const st = perBarStats(o.adaptiveNet);
    return { meta, outcome: o, stats: st };
  });
  // rank by search-OOS Sharpe
  metaResults.sort((a, b) => b.stats.sharpe - a.stats.sharpe);
  say("  Top 6 meta-configs by SEARCH adaptive net Sharpe (per-bar | ann):");
  for (const r of metaResults.slice(0, 6)) {
    say(
      `    IS=${r.meta.isWindow} OOS=${r.meta.oosHorizon} ${r.meta.family.padEnd(9)}` +
        `  sharpe=${r.stats.sharpe.toFixed(4)} ann=${r.stats.annSharpe.toFixed(2)}` +
        ` comp=${(r.stats.compound * 100).toFixed(1)}% trades=${r.outcome.adaptiveTrades}`,
    );
  }
  const selected = metaResults[0];
  say(`  SELECTED meta-config: IS=${selected.meta.isWindow} OOS=${selected.meta.oosHorizon} family=${selected.meta.family}`);

  // =====================================================================
  // Q1 — Does the optimal param DRIFT trackably or jump randomly?
  // Use the SELECTED meta-config's per-step chosen-config rank series; compute
  // lag-1 autocorrelation of the chosen-rank sequence per asset (persistence)
  // and the fraction of steps where the choice CHANGES (churn).
  // Compare against a random-choice null (autocorr ~ 0).
  // =====================================================================
  say("");
  say("Q1 — Does the optimal param drift TRACKABLY (autocorrelated) or jump randomly?");
  const driftByAsset: Record<string, { ac1: number; changeRate: number; steps: number }> = {};
  for (const asset of ASSETS) {
    const seq = selected.outcome.steps.filter((s) => s.asset === asset).map((s) => s.chosenA);
    if (seq.length < 3) continue;
    const ac1 = autocorr1(seq);
    let changes = 0;
    for (let i = 1; i < seq.length; i += 1) if (seq[i] !== seq[i - 1]) changes += 1;
    driftByAsset[asset] = { ac1, changeRate: changes / (seq.length - 1), steps: seq.length };
  }
  const allAc1 = Object.values(driftByAsset).map((d) => d.ac1);
  const allChange = Object.values(driftByAsset).map((d) => d.changeRate);
  const meanAc1 = avg(allAc1);
  const meanChange = avg(allChange);
  for (const asset of ASSETS) {
    const d = driftByAsset[asset];
    if (d) say(`    ${asset.padEnd(5)} chosen-rank lag1-autocorr=${d.ac1.toFixed(3)} changeRate=${(d.changeRate * 100).toFixed(0)}% (${d.steps} steps)`);
  }
  say(`  MEAN lag-1 autocorr of chosen-config rank = ${meanAc1.toFixed(3)} (random-jump null ~ 0)`);
  say(`  MEAN step-to-step change rate = ${(meanChange * 100).toFixed(0)}%  (1.0 = re-picks a different config every step)`);
  const driftTrackable = meanAc1 > 0.15; // material persistence beyond noise

  // =====================================================================
  // PHASE 2 — CONSUME-ONCE HOLDOUT scoring with the selected meta-config.
  // Run the EXACT SAME machinery over the FULL timeline but only KEEP the OOS
  // bars that fall in the holdout window. Strict causality: the IS windows that
  // feed holdout-step param choices use pre-holdout data (legitimate — that is
  // how live trading works: you always re-opt on trailing data).
  // =====================================================================
  say("");
  say("PHASE 2 — CONSUME-ONCE HOLDOUT (selected meta-config, scored exactly once)");
  const guard = new FinalHoldoutGuard();

  // run WF on full timeline; collect OOS bars and tag which are in the holdout
  const holdout = runWalkForwardHoldout(assets, selected.meta, minBars, holdoutStart, realCloses, 12345);
  guard.consume({ reason: "wf-b-final-verdict", trialCount: N, nowIso: new Date().toISOString() });

  const adStats = perBarStats(holdout.adaptiveNet);
  const fxStats = perBarStats(holdout.fixedNet);
  const rndStats = perBarStats(holdout.randomNet);
  const bhNetSeries = buyHoldNetSeries(holdout.bhNet);
  const bhStats = perBarStats(bhNetSeries);

  say(`  Holdout OOS bars (concat across assets): ${holdout.adaptiveNet.length}`);
  say("");
  say("  Net-of-cost performance on HOLDOUT (per-bar sharpe | annualized | compound):");
  say(`    ADAPTIVE WF   sharpe=${adStats.sharpe.toFixed(4)} ann=${adStats.annSharpe.toFixed(2)} comp=${(adStats.compound * 100).toFixed(1)}% trades=${holdout.adaptiveTrades} turnover=${holdout.adaptiveTurnover.toFixed(0)} cost=${(holdout.adaptiveCost * 100).toFixed(2)}%`);
  say(`    FIXED (1st)   sharpe=${fxStats.sharpe.toFixed(4)} ann=${fxStats.annSharpe.toFixed(2)} comp=${(fxStats.compound * 100).toFixed(1)}% turnover=${holdout.fixedTurnover.toFixed(0)} cost=${(holdout.fixedCost * 100).toFixed(2)}%`);
  say(`    RANDOM WF     sharpe=${rndStats.sharpe.toFixed(4)} ann=${rndStats.annSharpe.toFixed(2)} comp=${(rndStats.compound * 100).toFixed(1)}%`);
  say(`    BUY-AND-HOLD  sharpe=${bhStats.sharpe.toFixed(4)} ann=${bhStats.annSharpe.toFixed(2)} comp=${(bhStats.compound * 100).toFixed(1)}%`);

  // turnover/cost OF ADAPTING (extra vs fixed)
  const extraTurnover = holdout.adaptiveTurnover - holdout.fixedTurnover;
  const extraCost = holdout.adaptiveCost - holdout.fixedCost;
  say("");
  say(`  EXTRA turnover caused by ADAPTING vs fixed-param: ${extraTurnover.toFixed(0)} units (${(extraCost * 100).toFixed(2)}% extra cost over holdout)`);

  // =====================================================================
  // Q2 / Q3 — adaptive vs buy-and-hold and vs fixed, on the holdout, net of cost
  // Use the committed baseline gate (compound-return statistic) for B&H + random
  // lottery, then a direct Sharpe/compound comparison vs fixed.
  // =====================================================================
  say("");
  say("Q2/Q3 — adaptive vs benchmarks on HOLDOUT (net of cost) via committed gates");
  const bhBaseline = buildBuyAndHoldBaseline({
    barReturns: holdout.bhNet,
    roundTripCost: 2 * TAKER_FEE_PER_SIDE,
    statistic: "compoundReturn",
  });
  const lottery = buildRandomLotteryBaseline({
    barReturns: holdout.bhNet,
    tradeCount: Math.max(1, holdout.adaptiveTrades),
    averageHoldingBars: Math.max(1, Math.round(holdout.adaptiveNet.length / Math.max(1, holdout.adaptiveTrades))),
    roundTripCost: 2 * TAKER_FEE_PER_SIDE,
    iterations: 2000,
    quantile: 0.95,
    seed: "wf-b",
    statistic: "compoundReturn",
  });
  const fixedBaseline = baselineScoreFromReturns("fixed_first_window", "Fixed-param (first IS window)", holdout.fixedNet, { statistic: "compoundReturn" });
  const randomWfBaseline = baselineScoreFromReturns("random_param_wf", "Random-param WF", holdout.randomNet, { statistic: "compoundReturn" });
  const gate = evaluateBaselineGate({
    candidateReturns: holdout.adaptiveNet,
    baselines: [bhBaseline, lottery, fixedBaseline, randomWfBaseline],
    statistic: "compoundReturn",
    minMargin: 0,
    requirePositive: true,
  });
  for (const c of gate.comparisons) {
    say(`    vs ${c.label.padEnd(30)} candidate=${(gate.candidateScore * 100).toFixed(1)}% baseline=${(c.baselineScore * 100).toFixed(1)}% margin=${(c.margin * 100).toFixed(1)}% beaten=${c.beaten}`);
  }
  say(`  BASELINE GATE passed (beats ALL incl B&H + random-lottery + fixed): ${gate.passed}`);
  const beatsBuyHold = gate.comparisons.find((c) => c.id === "buy_and_hold")?.beaten ?? false;
  const beatsFixed = gate.comparisons.find((c) => c.id === "fixed_first_window")?.beaten ?? false;
  const beatsRandomWf = gate.comparisons.find((c) => c.id === "random_param_wf")?.beaten ?? false;

  // =====================================================================
  // DSR / MinBTL / Haircut with HONEST N = meta-grid size
  // =====================================================================
  say("");
  say(`Gate stack with honest N=${N} (meta-grid)`);
  const dsr = computeDeflatedSharpeRatio(holdout.adaptiveNet, { trialCount: N });
  say(`  DSR: sharpe=${dsr.sharpe.toFixed(4)} expectedMaxSharpe(N=${N})=${dsr.expectedMaxSharpe.toFixed(4)} deflatedProb=${dsr.deflatedProbability.toFixed(4)} (p=${(1 - dsr.deflatedProbability).toFixed(4)})`);
  const minbtl = evaluateMinBtl({ trialCount: N, sampleCount: holdout.adaptiveNet.length, observedSharpe: adStats.sharpe });
  say(`  MinBTL: observedSharpe=${adStats.sharpe.toFixed(4)} expMaxNullSharpe=${minbtl.expectedMaxNullSharpe.toFixed(4)} sufficientLength=${minbtl.sufficientLength} (${minbtl.reason})`);
  const hc = haircutSharpe({ observedSharpe: adStats.sharpe, sampleCount: holdout.adaptiveNet.length, trialCount: N, method: "bonferroni" });
  say(`  Harvey-Liu haircut (Bonferroni): p=${hc.pValue.toFixed(4)} adjP=${hc.adjustedPValue.toFixed(4)} haircutSharpe=${hc.haircutSharpe.toFixed(4)} haircut=${(hc.haircut * 100).toFixed(0)}%`);
  const dsrPass = dsr.deflatedProbability >= 0.95;

  // =====================================================================
  // PBO — Combinatorially-Symmetric Cross-Validation across meta-configs.
  // Build fold-return matrices: each meta-config = a 'strategy', its search-OOS
  // adaptive net series chopped into folds. PBO = prob the search winner is below
  // median OOS (overfit). Uses committed estimateCscvPbo.
  // =====================================================================
  say("");
  say("PBO — CSCV across meta-configs (search-OOS adaptive series)");
  let pbo = NaN;
  try {
    const FOLDS = 8;
    const strategies = metaResults.map((r) => {
      const series = r.outcome.adaptiveNet;
      const foldLen = Math.floor(series.length / FOLDS);
      const folds: number[][] = [];
      for (let f = 0; f < FOLDS; f += 1) {
        folds.push(series.slice(f * foldLen, f === FOLDS - 1 ? series.length : (f + 1) * foldLen));
      }
      return { id: `${r.meta.isWindow}-${r.meta.oosHorizon}-${r.meta.family}`, folds };
    });
    const pboRes = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = pboRes.pbo;
    say(`  PBO=${pbo.toFixed(3)} (fraction of CSCV splits where the IS-best meta-config is below-median OOS) medianLogit=${pboRes.medianLogit.toFixed(3)}`);
  } catch (e) {
    say(`  PBO skipped: ${(e as Error).message}`);
  }

  // =====================================================================
  // Q4 — SURROGATE / PLACEBO. Run the SAME machinery (full meta-selection +
  // holdout score) on phase-randomized and block-shuffled surrogates. If the
  // adaptive machinery 'finds' comparable edge there, real edge is an artifact.
  // =====================================================================
  say("");
  say("Q4 — SURROGATE/PLACEBO (same machinery on phase-rand & block-shuffle surrogates)");
  const surrogateRuns: { kind: string; sharpe: number; ann: number; comp: number; beatsBh: boolean }[] = [];
  const NUM_SURR = 8;
  for (const kind of ["phase", "block"] as const) {
    for (let s = 0; s < NUM_SURR; s += 1) {
      const seed = 9000 + (kind === "phase" ? 0 : 1000) + s;
      const surrCloses = (a: AssetSeries) => {
        const c = a.bars.map((b) => b.close);
        return kind === "phase" ? phaseRandomizedCloses(c, seed + a.asset.charCodeAt(0)) : blockShuffledCloses(c, seed + a.asset.charCodeAt(0));
      };
      // meta-select on surrogate search portion, then score surrogate holdout — same recipe
      const surMeta = metaGrid.map((meta) => {
        const o = runWalkForward(assets, meta, searchBars, surrCloses, 12345);
        return { meta, sharpe: perBarStats(o.adaptiveNet).sharpe };
      });
      surMeta.sort((a, b) => b.sharpe - a.sharpe);
      const surSel = surMeta[0].meta;
      const surHold = runWalkForwardHoldout(assets, surSel, minBars, holdoutStart, surrCloses, 12345);
      const st = perBarStats(surHold.adaptiveNet);
      const surBh = buyHoldNetSeries(surHold.bhNet);
      const beatsBh = st.compound > compound(surBh);
      surrogateRuns.push({ kind, sharpe: st.sharpe, ann: st.annSharpe, comp: st.compound, beatsBh });
    }
  }
  const phaseRuns = surrogateRuns.filter((r) => r.kind === "phase");
  const blockRuns = surrogateRuns.filter((r) => r.kind === "block");
  const surrSharpes = surrogateRuns.map((r) => r.sharpe).sort((a, b) => a - b);
  const surrMeanSharpe = avg(surrSharpes);
  const surrMaxSharpe = surrSharpes.at(-1) ?? 0;
  // p-value: fraction of surrogate adaptive Sharpes >= real adaptive holdout Sharpe
  const surrGE = surrSharpes.filter((x) => x >= adStats.sharpe).length;
  const surrP = (surrGE + 1) / (surrSharpes.length + 1);
  say(`  phase-rand holdout adaptive sharpe: mean=${avg(phaseRuns.map((r) => r.sharpe)).toFixed(4)} (n=${phaseRuns.length})`);
  say(`  block-shuffle holdout adaptive sharpe: mean=${avg(blockRuns.map((r) => r.sharpe)).toFixed(4)} (n=${blockRuns.length})`);
  say(`  surrogate adaptive sharpe: mean=${surrMeanSharpe.toFixed(4)} max=${surrMaxSharpe.toFixed(4)} (vs REAL=${adStats.sharpe.toFixed(4)})`);
  say(`  surrogate-vs-real placebo p-value (frac surrogates >= real) = ${surrP.toFixed(3)}`);
  const surrogateShowsEdge = surrMeanSharpe > 0.02 || surrP > 0.20; // surrogate machinery 'finds' comparable edge

  // =====================================================================
  // VERDICT
  // =====================================================================
  say("");
  say("==================================================================");
  say("VERDICT");
  say("==================================================================");
  const conditions = {
    beatsBuyHold,
    beatsFixed,
    beatsRandomWf,
    surrogateNoEdge: !surrogateShowsEdge,
    dsrPass,
    minBtlPass: minbtl.sufficientLength,
    candidatePositive: gate.candidatePositive,
  };
  say(`  (Q2) adaptive beats buy-and-hold net of cost on holdout: ${beatsBuyHold}`);
  say(`  (Q3) adaptive beats honest fixed-param baseline:          ${beatsFixed}`);
  say(`       adaptive beats random-param WF:                      ${beatsRandomWf}`);
  say(`  (Q4) surrogate machinery shows ~no edge:                  ${!surrogateShowsEdge}`);
  say(`       DSR passes (deflatedProb>=0.95, honest N=${N}):        ${dsrPass}`);
  say(`       MinBTL sufficient length:                            ${minbtl.sufficientLength}`);
  say(`       candidate net-positive on holdout:                   ${gate.candidatePositive}`);

  const survive =
    beatsBuyHold && beatsFixed && conditions.surrogateNoEdge && dsrPass && gate.candidatePositive;
  // PARTIAL if it beats fixed (adaptation adds SOMETHING) but fails B&H or significance
  const partial =
    !survive &&
    (beatsFixed || beatsBuyHold) &&
    gate.candidatePositive;
  const verdict = survive ? "SURVIVE" : partial ? "PARTIAL" : "KILL";
  say("");
  say(`  FINAL VERDICT: ${verdict}`);
  say(`  Reasoning: adaptive holdout net Sharpe=${adStats.sharpe.toFixed(4)} (ann ${adStats.annSharpe.toFixed(2)}), ` +
    `B&H=${bhStats.sharpe.toFixed(4)}, fixed=${fxStats.sharpe.toFixed(4)}, surrogate mean=${surrMeanSharpe.toFixed(4)}, DSR p=${(1 - dsr.deflatedProbability).toFixed(3)}.`);

  // persist machine-readable result
  const result = {
    track: "WF-B",
    generatedAt: new Date().toISOString(),
    assets: ASSETS,
    minBars,
    fee_bps_per_side: TAKER_FEE_PER_SIDE * 1e4,
    metaGridN: N,
    holdout: { start: holdoutStart, end: minBars, fraction: plan.finalHoldout.rows / minBars },
    selectedMeta: selected.meta,
    drift: { meanAc1, meanChange, byAsset: driftByAsset, trackable: driftTrackable },
    holdoutStats: {
      adaptive: adStats,
      fixed: fxStats,
      random: rndStats,
      buyHold: bhStats,
      adaptiveTrades: holdout.adaptiveTrades,
      adaptiveTurnover: holdout.adaptiveTurnover,
      fixedTurnover: holdout.fixedTurnover,
      extraTurnover,
      extraCost,
      adaptiveCost: holdout.adaptiveCost,
    },
    gate: { passed: gate.passed, comparisons: gate.comparisons },
    dsr: { sharpe: dsr.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe, deflatedProbability: dsr.deflatedProbability, p: 1 - dsr.deflatedProbability },
    minBtl: { sufficientLength: minbtl.sufficientLength, expectedMaxNullSharpe: minbtl.expectedMaxNullSharpe, reason: minbtl.reason },
    haircut: { pValue: hc.pValue, adjustedPValue: hc.adjustedPValue, haircutSharpe: hc.haircutSharpe, haircut: hc.haircut },
    pbo,
    surrogate: { meanSharpe: surrMeanSharpe, maxSharpe: surrMaxSharpe, p: surrP, showsEdge: surrogateShowsEdge, runs: surrogateRuns },
    conditions,
    verdict,
    holdoutGuard: guard.status(),
  };
  const outPath = join(REPO_ROOT, "output", "walkforward", "wf-b-result.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  const logPath = join(REPO_ROOT, "output", "walkforward", "wf-b-run.log");
  writeFileSync(logPath, log.join("\n"));
  say("");
  say(`Wrote ${outPath}`);
  say(`Wrote ${logPath}`);
}

/**
 * Holdout variant: runs WF over the FULL timeline but only KEEPS OOS bars whose
 * index >= holdoutStart. Param choices still come from trailing IS windows (which
 * may include pre-holdout bars — that is legitimate live re-optimization; the
 * holdout guard only forbids the META-SELECTION from peeking, which it does not).
 */
function runWalkForwardHoldout(
  assets: AssetSeries[],
  meta: MetaConfig,
  barsLimit: number,
  holdoutStart: number,
  closesOf: (a: AssetSeries) => number[],
  randomSeed: number,
): WfOutcome {
  const out: WfOutcome = {
    adaptiveNet: [], adaptiveGross: [], fixedNet: [], randomNet: [], bhNet: [],
    adaptiveTurnover: 0, fixedTurnover: 0, adaptiveCost: 0, fixedCost: 0,
    adaptiveTrades: 0, steps: [], oosBars: 0,
  };
  const grid = gridForFamily(meta.family);
  const rng = makeRng(randomSeed);
  for (const asset of assets) {
    const closes = closesOf(asset).slice(0, barsLimit);
    const returns = new Array<number>(closes.length).fill(0);
    for (let i = 1; i < closes.length; i += 1) returns[i] = closes[i] / closes[i - 1] - 1;
    const n = closes.length;
    const sigs = new Map<string, number[]>();
    for (const p of grid) sigs.set(paramKey(p), computeSignal(closes, p));
    const firstOos = meta.isWindow;
    if (firstOos >= n) continue;
    const fixedBest = pickBest(grid, sigs, returns, 0, meta.isWindow);
    const fixedSig = sigs.get(paramKey(fixedBest))!;
    let aPrior = 0, fPrior = 0, rPrior = 0;
    for (let oosStart = firstOos; oosStart < n; oosStart += meta.oosHorizon) {
      const oosEnd = Math.min(oosStart + meta.oosHorizon, n);
      const isStart = Math.max(0, oosStart - meta.isWindow);
      const best = pickBest(grid, sigs, returns, isStart, oosStart);
      const bestSig = sigs.get(paramKey(best))!;
      const randp = grid[Math.floor(rng() * grid.length)];
      const randSig = sigs.get(paramKey(randp))!;
      // backtest the WHOLE slice for cost continuity, but only KEEP holdout bars
      const btA = backtestSlice(returns, bestSig, oosStart, oosEnd, aPrior);
      const btF = backtestSlice(returns, fixedSig, oosStart, oosEnd, fPrior);
      const btR = backtestSlice(returns, randSig, oosStart, oosEnd, rPrior);
      for (let j = 0; j < btA.positions.length; j += 1) {
        const idx = oosStart + j;
        if (idx >= holdoutStart) {
          out.adaptiveNet.push(btA.netReturns[j]);
          out.adaptiveGross.push(btA.grossReturns[j]);
          out.fixedNet.push(btF.netReturns[j]);
          out.randomNet.push(btR.netReturns[j]);
          out.bhNet.push(returns[idx]);
          // cost/turnover only counted inside holdout
          const dA = j === 0 ? Math.abs(btA.positions[0] - aPrior) : Math.abs(btA.positions[j] - btA.positions[j - 1]);
          const dF = j === 0 ? Math.abs(btF.positions[0] - fPrior) : Math.abs(btF.positions[j] - btF.positions[j - 1]);
          out.adaptiveTurnover += dA;
          out.adaptiveCost += dA * TAKER_FEE_PER_SIDE;
          if (dA > 0) out.adaptiveTrades += 1;
          out.fixedTurnover += dF;
          out.fixedCost += dF * TAKER_FEE_PER_SIDE;
          out.oosBars += 1;
        }
      }
      aPrior = btA.positions.at(-1) ?? aPrior;
      fPrior = btF.positions.at(-1) ?? fPrior;
      rPrior = btR.positions.at(-1) ?? rPrior;
    }
  }
  return out;
}

main();
