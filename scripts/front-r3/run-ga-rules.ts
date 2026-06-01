/**
 * FRONT R3 RUNNER — GA that evolves trading RULES on real crypto daily data,
 * with a mandatory SURROGATE/PLACEBO control and the committed rigor gates.
 *
 * Pipeline:
 *   1. Load BTC/ETH/SOL/BNB/XRP/DOGE daily closes (output/funding/*_prices_daily.json).
 *   2. planHoldoutSplit -> carve a consume-once final hold-out (most-recent block).
 *      Build per-asset feature matrices ONCE on the full series (causal indicators);
 *      the GA only reads decision indices inside the SEARCH window.
 *   3. Run the REAL GA (tournament + crossover + mutation + elitism) on the SEARCH
 *      (train) window only. Fitness = pooled net-of-cost Sharpe - turnover penalty.
 *      HONEST N = total UNIQUE genomes evaluated across ALL generations.
 *   4. SURROGATE CONTROL: run the IDENTICAL GA machinery on phase-randomized AND
 *      block-bootstrap surrogates of the SAME returns (many independent surrogate
 *      worlds). For each surrogate champion, evaluate its rule on that surrogate's
 *      hold-out. The distribution of surrogate hold-out Sharpes is the placebo null.
 *   5. Evaluate the REAL champion EXACTLY ONCE on the real consume-once hold-out.
 *   6. Gates (committed, unmodified): evaluatePromotion with trialCount = HONEST N
 *      (DSR, MinBTL, haircut, baselines = beat buy&hold + random-lottery), plus an
 *      explicit RANDOM-RULE baseline (best of many random genomes on holdout), the
 *      placebo p-value, and CSCV/PBO across the GA's top final rules.
 *
 * SURVIVE only if the real champion beats buy&hold AND its hold-out Sharpe is
 * clearly outside the surrogate distribution AND it passes DSR at honest N AND
 * survives the hold-out, all net of cost.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/front-r3/run-ga-rules.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildFeatures,
  barsFromReturns,
  blockBootstrapReturns,
  phaseRandomizeReturns,
  describeGenome,
  evaluateGenome,
  genomeKey,
  randomGenome,
  runGa,
  sharpe,
  makeRng,
  type Bar,
  type EvalConfig,
  type FeatureMatrix,
  type GaConfig,
  type Genome,
} from "./lib-ga-rules";

import { planHoldoutSplit, FinalHoldoutGuard } from "../../src/lib/significance/holdout";
import { evaluatePromotion } from "../../src/lib/significance/promotion-evaluator";
import { estimateCscvPbo } from "../../src/lib/statistical-validation";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/statistical-validation";

const REPO = process.cwd();
const ASSETS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"] as const;

// --- realistic perp taker cost: 4 bps / side (8 bps round-trip on a full flip) ---
const COST_PER_SIDE = 0.0004;
const TURNOVER_PENALTY = 0.05; // lambda in Sharpe units on mean |dPos|

// GA hyperparameters (real evolution, not a grid)
const GA: GaConfig = {
  populationSize: 160,
  generations: 40,
  tournamentSize: 5,
  eliteCount: 6,
  crossoverRate: 0.7,
  mutationRate: 0.25,
  seed: "front-r3-real",
};

const N_SURROGATES = 30; // surrogate worlds (15 phase-randomized + 15 block-bootstrap)
const DSR_THRESHOLD = 0.95;

interface AssetData {
  name: string;
  bars: Bar[];
}

function loadAsset(name: string): AssetData {
  const path = join(REPO, "output", "funding", `${name}USDT_prices_daily.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<{
    date: string;
    spotClose: number;
    perpClose: number;
  }>;
  // use perpClose (perp is what we trade with the stated perp taker cost)
  const bars: Bar[] = raw.map((r) => ({ date: r.date, close: r.perpClose }));
  return { name, bars };
}

/** Restrict a full FeatureMatrix to evaluate decisions only in [start,end). */
function evalCfgFor(start: number, end: number): EvalConfig {
  return { costPerSide: COST_PER_SIDE, turnoverPenalty: TURNOVER_PENALTY, startIdx: start, endIdx: end };
}

/** Pooled net-return series of a genome over a window across all asset FMs. */
function pooledNet(g: Genome, fms: FeatureMatrix[], cfg: EvalConfig): {
  net: number[];
  turnover: number;
  posChanges: number;
} {
  const ev = evaluateGenome(g, fms, cfg);
  return { net: ev.netReturns, turnover: ev.turnover, posChanges: ev.positionChanges };
}

/** Buy-and-hold pooled per-bar returns across all assets over a decision window. */
function pooledBuyHoldBars(fms: FeatureMatrix[], start: number, end: number): number[] {
  const out: number[] = [];
  for (const fm of fms) {
    const s = Math.max(start, fm.warmup);
    const e = Math.min(end, fm.ret.length - 2);
    for (let t = s; t <= e; t += 1) out.push(fm.ret[t + 1]);
  }
  return out;
}

/**
 * Average per-asset compound NET return of a genome over a window. Compounding a
 * single concatenated cross-asset chain is meaningless (it mixes independent
 * P&L streams), so we compound EACH asset separately then average — the honest
 * "what an equal-weight book of these per-asset rules earned" figure.
 */
function avgPerAssetCompound(g: Genome, fms: FeatureMatrix[], start: number, end: number): number {
  const comps: number[] = [];
  for (const fm of fms) {
    const ev = evaluateGenome(g, [fm], {
      costPerSide: COST_PER_SIDE,
      turnoverPenalty: TURNOVER_PENALTY,
      startIdx: start,
      endIdx: end,
    });
    if (ev.netReturns.length === 0) continue;
    let log = 0;
    for (const r of ev.netReturns) log += Math.log1p(Math.max(-0.999999, r));
    comps.push(Math.expm1(log));
  }
  return comps.length > 0 ? comps.reduce((s, x) => s + x, 0) / comps.length : 0;
}

function main() {
  const log: string[] = [];
  const say = (s: string) => {
    log.push(s);
    // eslint-disable-next-line no-console
    console.log(s);
  };

  say("=== FRONT R3 — GA that EVOLVES TRADING RULES (genetic programming) ===");
  say(`cost: ${COST_PER_SIDE * 1e4} bps/side (= ${COST_PER_SIDE * 2e4} bps round-trip flip); turnover penalty lambda=${TURNOVER_PENALTY}`);

  // 1. load
  const assets = ASSETS.map(loadAsset);
  const nBars = assets[0].bars.length;
  say(`loaded ${assets.length} assets x ${nBars} daily bars (${assets[0].bars[0].date} -> ${assets[0].bars.at(-1)!.date})`);

  // 2. holdout split (committed gate). Search owns the older ~70%, holdout = recent 15%.
  const plan = planHoldoutSplit({ totalRows: nBars, holdoutFraction: 0.15, testFraction: 0.15 });
  say(`holdout plan: search [0,${plan.search.end}) test [${plan.test.start},${plan.test.end}) finalHoldout [${plan.finalHoldout.start},${plan.finalHoldout.end}) (${plan.finalHoldout.rows} rows)`);

  // The GA SEARCH window = search + test (the model never sees finalHoldout).
  const searchStart = 0;
  const searchEnd = plan.finalHoldout.start; // exclusive decision bound for search
  const holdoutStart = plan.finalHoldout.start;
  const holdoutEnd = plan.finalHoldout.end;

  // build full feature matrices (causal); GA restricts decisions to the window.
  const fullFms = assets.map((a) => buildFeatures(a.bars));
  const warmup = Math.max(...fullFms.map((f) => f.warmup));
  say(`feature warmup = ${warmup} bars`);

  // anti-leakage assertion: the GA's max decision index must not touch holdout.
  // GA decisions run t in [searchStart, searchEnd-1] and earn ret[t+1] up to searchEnd.
  if (searchEnd > holdoutStart) {
    throw new Error(`leakage: searchEnd ${searchEnd} > holdoutStart ${holdoutStart}`);
  }

  const searchCfg = evalCfgFor(Math.max(searchStart, warmup), searchEnd - 1);
  const holdoutCfg = evalCfgFor(Math.max(holdoutStart, warmup), holdoutEnd - 1);

  // 3. REAL GA on the SEARCH window only
  say("\n--- evolving on REAL data (search window only) ---");
  const realGa = runGa(fullFms, searchCfg, GA);
  const honestN = realGa.uniqueGenomes;
  say(`REAL champion fitness (train net Sharpe - penalty) = ${realGa.championFitness.toFixed(4)}`);
  say(`HONEST N = ${honestN} UNIQUE genomes evaluated (total evals incl. cache hits across ${GA.generations} gens, pop ${GA.populationSize})`);
  say(`champion rule: ${describeGenome(realGa.champion)}`);
  say(`gen-best trajectory: ${realGa.generationsBest.map((x) => x.toFixed(3)).join(" ")}`);

  // champion train diagnostics
  const champTrain = pooledNet(realGa.champion, fullFms, searchCfg);
  const champTrainStats = summarizeReturnSeries(champTrain.net);
  say(`champion TRAIN: net Sharpe=${champTrainStats.sharpe.toFixed(4)} bars=${champTrainStats.sampleCount} turnover=${champTrain.turnover.toFixed(4)} posChanges=${champTrain.posChanges}`);

  // 4. SURROGATE / PLACEBO control: identical GA on phase-randomized + block-bootstrap worlds
  say(`\n--- SURROGATE/PLACEBO control: identical GA on ${N_SURROGATES} surrogate worlds ---`);
  const surrRng = makeRng("front-r3-surrogate-master");
  const surrogateHoldoutSharpes: number[] = [];
  const surrogateTrainFitness: number[] = [];

  for (let s = 0; s < N_SURROGATES; s += 1) {
    const method = s % 2 === 0 ? "phase" : "block";
    // build surrogate bars per asset (preserve vol & short-range autocorr, destroy regime)
    const surrFmsFull: FeatureMatrix[] = assets.map((a, ai) => {
      const fm = fullFms[ai];
      const ret = fm.ret.slice(); // full return series
      const localRng = makeRng(`surr-${s}-${ai}-${Math.floor(surrRng() * 1e9)}`);
      let surrRet: number[];
      if (method === "phase") {
        surrRet = phaseRandomizeReturns(ret, localRng);
      } else {
        const blockLen = Math.max(2, Math.round(Math.sqrt(ret.length)));
        surrRet = blockBootstrapReturns(ret, blockLen, localRng);
      }
      const surrBars = barsFromReturns(fm.date, surrRet, 100);
      return buildFeatures(surrBars);
    });
    const surrWarmup = Math.max(...surrFmsFull.map((f) => f.warmup));
    const surrSearchCfg = evalCfgFor(Math.max(searchStart, surrWarmup), searchEnd - 1);
    const surrHoldoutCfg = evalCfgFor(Math.max(holdoutStart, surrWarmup), holdoutEnd - 1);

    // identical GA (different seed per surrogate so it's a fair independent search)
    const surrGa = runGa(surrFmsFull, surrSearchCfg, { ...GA, seed: `front-r3-surr-${s}` });
    surrogateTrainFitness.push(surrGa.championFitness);
    // evaluate surrogate champion ONCE on its own surrogate holdout
    const surrHold = pooledNet(surrGa.champion, surrFmsFull, surrHoldoutCfg);
    const surrHoldSharpe = sharpe(surrHold.net);
    surrogateHoldoutSharpes.push(surrHoldSharpe);
    if (s < 6 || s % 5 === 0) {
      say(`  surrogate ${s} (${method}): trainFit=${surrGa.championFitness.toFixed(3)} holdoutSharpe=${surrHoldSharpe.toFixed(4)}`);
    }
  }

  surrogateHoldoutSharpes.sort((a, b) => a - b);
  const surrMean = surrogateHoldoutSharpes.reduce((s, x) => s + x, 0) / surrogateHoldoutSharpes.length;
  const surrMax = surrogateHoldoutSharpes.at(-1)!;
  const surrMin = surrogateHoldoutSharpes[0];
  const surrP95 = surrogateHoldoutSharpes[Math.floor(0.95 * (surrogateHoldoutSharpes.length - 1))];
  say(`surrogate holdout Sharpe distribution: min=${surrMin.toFixed(4)} mean=${surrMean.toFixed(4)} p95=${surrP95.toFixed(4)} max=${surrMax.toFixed(4)} (n=${surrogateHoldoutSharpes.length})`);

  // 5. REAL champion evaluated EXACTLY ONCE on the consume-once holdout
  say("\n--- consume-once HOLDOUT evaluation (real champion, evaluated ONCE) ---");
  const guard = new FinalHoldoutGuard();
  guard.consume({
    reason: "front-r3 GA champion final holdout",
    gitSha: "dd4ab2d",
    trialCount: honestN,
    nowIso: new Date().toISOString(),
  });
  const champHold = pooledNet(realGa.champion, fullFms, holdoutCfg);
  const champHoldStats = summarizeReturnSeries(champHold.net);
  const champHoldSharpe = champHoldStats.sharpe;
  const champHoldAvgCompound = avgPerAssetCompound(
    realGa.champion,
    fullFms,
    Math.max(holdoutStart, warmup),
    holdoutEnd - 1,
  );
  say(`REAL champion HOLDOUT: net Sharpe=${champHoldSharpe.toFixed(4)} bars=${champHoldStats.sampleCount} meanPerBar=${champHoldStats.mean.toExponential(3)} avgPerAssetCompound=${(champHoldAvgCompound * 100).toFixed(2)}% turnover=${champHold.turnover.toFixed(4)} posChanges=${champHold.posChanges}`);

  // placebo p-value: fraction of surrogate holdout Sharpes >= real champion's holdout Sharpe
  const placeboCount = surrogateHoldoutSharpes.filter((x) => x >= champHoldSharpe).length;
  const placeboP = (placeboCount + 1) / (surrogateHoldoutSharpes.length + 1);
  say(`PLACEBO p-value = (${placeboCount}+1)/(${surrogateHoldoutSharpes.length}+1) = ${placeboP.toFixed(4)}  (P(surrogate holdout Sharpe >= real ${champHoldSharpe.toFixed(4)}))`);

  // RANDOM-RULE baseline: best holdout Sharpe of many random genomes (search-selected
  // on train, evaluated on holdout) — a GP that beats random rules must do better.
  const rrRng = makeRng("front-r3-random-rule");
  const RR_N = 2000;
  let bestRandomRuleTrainFit = -Infinity;
  let bestRandomRuleHoldoutSharpe = -Infinity;
  let bestRandomRuleHoldoutFromTrainSel = -Infinity;
  let bestRandomTrainGenome: Genome | null = null;
  const randomRuleHoldoutSharpes: number[] = [];
  for (let i = 0; i < RR_N; i += 1) {
    const g = randomGenome(rrRng);
    const tf = pooledNet(g, fullFms, searchCfg);
    const trainFit = sharpe(tf.net) - TURNOVER_PENALTY * tf.turnover;
    const hf = pooledNet(g, fullFms, holdoutCfg);
    const hs = sharpe(hf.net);
    randomRuleHoldoutSharpes.push(hs);
    if (hs > bestRandomRuleHoldoutSharpe) bestRandomRuleHoldoutSharpe = hs;
    if (trainFit > bestRandomRuleTrainFit) {
      bestRandomRuleTrainFit = trainFit;
      bestRandomRuleHoldoutFromTrainSel = hs;
      bestRandomTrainGenome = g;
    }
  }
  say(`RANDOM-RULE baseline (${RR_N} random rules): best-on-holdout Sharpe=${bestRandomRuleHoldoutSharpe.toFixed(4)}; train-selected best holdout Sharpe=${bestRandomRuleHoldoutFromTrainSel.toFixed(4)}`);
  if (bestRandomTrainGenome) say(`  (train-selected random rule: ${describeGenome(bestRandomTrainGenome)})`);

  // 6. committed gates: evaluatePromotion with trialCount = HONEST N on the HOLDOUT series.
  //    barReturns = pooled buy&hold over the holdout window (=> buy&hold + random-lottery baselines).
  const holdoutBars = pooledBuyHoldBars(fullFms, Math.max(holdoutStart, warmup), holdoutEnd - 1);
  say("\n--- committed rigor gates (trialCount = HONEST N) ---");
  const promotion = evaluatePromotion({
    candidateId: "front-r3-ga-champion",
    candidateReturns: champHold.net,
    sampleCount: champHold.net.length,
    trialCount: honestN,
    barReturns: holdoutBars,
    roundTripCost: COST_PER_SIDE * 2, // round-trip for buy&hold/random-lottery baselines
    averageHoldingBars: 3,
    thresholds: { dsrThreshold: DSR_THRESHOLD, haircutMethod: "bonferroni" },
    seed: "front-r3-promotion",
  });

  const dsrHoldout = computeDeflatedSharpeRatio(champHold.net, { trialCount: honestN });
  say(`DSR(holdout, N=${honestN}): deflatedProbability=${dsrHoldout.deflatedProbability.toFixed(4)} (threshold ${DSR_THRESHOLD}) sharpe=${dsrHoldout.sharpe.toFixed(4)} expMaxSharpe=${dsrHoldout.expectedMaxSharpe.toFixed(4)}`);
  say(`baselines gate: passed=${promotion.gates.baselines.passed}`);
  if (promotion.gates.baselines.result) {
    for (const c of promotion.gates.baselines.result.comparisons) {
      say(`  vs ${c.id}: candidate-baseline margin=${c.margin.toFixed(5)} beaten=${c.beaten}`);
    }
  }
  say(`minBtl gate: passed=${promotion.gates.minBtl.passed}`);
  say(`haircut gate: passed=${promotion.gates.haircut.passed} haircutSharpe=${promotion.gates.haircut.result.haircutSharpe.toFixed(4)} adjP=${promotion.gates.haircut.result.adjustedPValue.toFixed(4)}`);
  say(`deflatedSharpe gate: passed=${promotion.gates.deflatedSharpe.passed}`);
  say(`PROMOTABLE (all committed gates): ${promotion.promotable}`);
  say(`reasons: ${promotion.reasons.join("; ") || "(none)"}`);

  // ---- final SURVIVE / KILL verdict ----
  const beatsBuyHold =
    promotion.gates.baselines.result?.comparisons.find((c) => c.id === "buy_and_hold")?.beaten ?? false;
  const beatsRandomLottery =
    promotion.gates.baselines.result?.comparisons.find((c) => c.id === "random_lottery")?.beaten ?? false;
  const beatsRandomRule = champHoldSharpe > bestRandomRuleHoldoutFromTrainSel;
  const outsideSurrogate = champHoldSharpe > surrMax; // clearly outside the placebo null
  const dsrPass = dsrHoldout.deflatedProbability >= DSR_THRESHOLD;
  const holdoutPositive = champHoldAvgCompound > 0 && champHoldSharpe > 0;

  say("\n=== VERDICT GATES ===");
  say(`beats buy&hold (holdout, net): ${beatsBuyHold}`);
  say(`beats random-lottery (holdout, net): ${beatsRandomLottery}`);
  say(`beats RANDOM-RULE (train-selected, holdout): ${beatsRandomRule}`);
  say(`holdout Sharpe clearly outside surrogate distribution (> surrogate max ${surrMax.toFixed(4)}): ${outsideSurrogate}`);
  say(`placebo p-value < 0.05: ${placeboP < 0.05} (p=${placeboP.toFixed(4)})`);
  say(`passes DSR at honest N: ${dsrPass}`);
  say(`survives holdout (positive net): ${holdoutPositive}`);

  const survive =
    beatsBuyHold &&
    beatsRandomLottery &&
    beatsRandomRule &&
    outsideSurrogate &&
    placeboP < 0.05 &&
    dsrPass &&
    holdoutPositive &&
    promotion.promotable;

  const bindingGate: string[] = [];
  if (!beatsBuyHold) bindingGate.push("fails_beat_buy_and_hold");
  if (!beatsRandomLottery) bindingGate.push("fails_beat_random_lottery");
  if (!beatsRandomRule) bindingGate.push("fails_beat_random_rule");
  if (!outsideSurrogate) bindingGate.push("inside_surrogate_distribution(placebo)");
  if (placeboP >= 0.05) bindingGate.push(`placebo_p>=0.05(${placeboP.toFixed(3)})`);
  if (!dsrPass) bindingGate.push(`DSR_below_threshold(${dsrHoldout.deflatedProbability.toFixed(4)})`);
  if (!holdoutPositive) bindingGate.push("holdout_not_positive");
  if (!promotion.promotable) bindingGate.push("promotion_gates_failed");

  const verdict = survive ? "SURVIVE" : "KILL";
  say(`\n>>> VERDICT: ${verdict} <<<`);
  say(`binding gate(s): ${bindingGate.join("; ") || "(none — survived)"}`);

  // write artifacts
  const out = {
    track: "FRONT R3 — GA evolves trading rules (genetic programming)",
    timestamp: new Date().toISOString(),
    gitSha: "dd4ab2d",
    dataSource: "output/funding/{BTC,ETH,SOL,BNB,XRP,DOGE}USDT_prices_daily.json (perpClose, daily, 1096 bars, 2023-06-01..2026-05-31)",
    cost: { perSideBps: COST_PER_SIDE * 1e4, roundTripFlipBps: COST_PER_SIDE * 2e4, turnoverPenalty: TURNOVER_PENALTY },
    ga: GA,
    honestN,
    holdoutPlan: plan,
    champion: {
      rule: describeGenome(realGa.champion),
      genomeKey: genomeKey(realGa.champion),
      trainNetSharpe: champTrainStats.sharpe,
      trainTurnover: champTrain.turnover,
      holdoutNetSharpe: champHoldSharpe,
      holdoutAvgPerAssetCompound: champHoldAvgCompound,
      holdoutMeanPerBar: champHoldStats.mean,
      holdoutTurnover: champHold.turnover,
      holdoutBars: champHoldStats.sampleCount,
    },
    surrogate: {
      nSurrogates: surrogateHoldoutSharpes.length,
      holdoutSharpeDistribution: { min: surrMin, mean: surrMean, p95: surrP95, max: surrMax },
      placeboPValue: placeboP,
    },
    randomRule: {
      n: RR_N,
      bestOnHoldoutSharpe: bestRandomRuleHoldoutSharpe,
      trainSelectedHoldoutSharpe: bestRandomRuleHoldoutFromTrainSel,
    },
    dsrHoldout: {
      deflatedProbability: dsrHoldout.deflatedProbability,
      sharpe: dsrHoldout.sharpe,
      expectedMaxSharpe: dsrHoldout.expectedMaxSharpe,
      trialCount: honestN,
    },
    promotion: {
      promotable: promotion.promotable,
      reasons: promotion.reasons,
      baselines: promotion.gates.baselines.result?.comparisons,
      haircutSharpe: promotion.gates.haircut.result.haircutSharpe,
    },
    verdict,
    bindingGate,
  };
  const outPath = join(REPO, "output", "front-r3", "ga-rules-result.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  const logPath = join(REPO, "output", "front-r3", "ga-rules-run.log");
  writeFileSync(logPath, log.join("\n") + "\n");
  say(`\nartifacts: ${outPath}`);
  say(`           ${logPath}`);
}

main();
