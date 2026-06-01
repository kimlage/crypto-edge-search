/**
 * TRACK WF-C — Adaptive walk-forward on 15m BTC (faster regimes) + SURROGATE/PLACEBO.
 *
 * Pipeline:
 *  0. Load 15m BTC closes. Carve a consume-once final holdout (last ~18%).
 *  1. Q1 — Does the optimal param DRIFT trackably? Measure autocorrelation of the
 *     trailing-best param across re-opt steps on the SEARCH span.
 *  2. Meta-config selection: sweep families x trainBars x oosBars on the SEARCH
 *     span ONLY (never touches holdout). Pick the meta-config with best net
 *     adaptive OOS Sharpe on the search span. N = size of this meta grid (the
 *     honest multiple-testing surface for the DSR).
 *  3. Holdout (consume-once): on the held-out span, run the chosen adaptive
 *     meta-config and ALL FOUR benchmarks: buy&hold, honest fixed-param,
 *     random-param WF, and the SURROGATE/PLACEBO distribution (phase-randomized +
 *     block-bootstrap, many seeds) run through the EXACT SAME adaptive machinery.
 *  4. Gates: DSR (N=meta grid), Harvey-Liu haircut, MinBTL, baseline gate.
 *  5. Verdict.
 *
 * Everything net of realistic 15m taker cost (4bps/side). Brutally honest about
 * turnover. Strict causality (see engine.ts).
 */

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadBars,
  toReturns,
  pricesFromReturns,
  phaseRandomizedReturns,
  blockBootstrapReturns,
  mulberry32,
  sharpeOf,
  type Family,
} from "./lib";
import {
  type MetaConfig,
  runWalkForward,
  runFixedParam,
  runBuyHold,
  paramDriftDiagnostic,
  pickBest,
  pickRandom,
} from "./engine";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
} from "../../src/lib/statistical-validation";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import { evaluateMinBtl } from "../../src/lib/significance/trial-count";
import {
  evaluateBaselineGate,
  baselineScoreFromReturns,
} from "../../src/lib/significance/baselines";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const DATA = resolve(ROOT, "output/bigquery/btc_ohlcv_15m.ndjson");
const OUT = resolve(ROOT, "output/walkforward/wf-c-result.json");
const COST_PER_SIDE = 0.0004; // 4 bps taker / side (perp)
const BARS_PER_YEAR = (365.25 * 24 * 60) / 15; // ~35064 fifteen-min bars/yr
const ANNUALIZE = Math.sqrt(BARS_PER_YEAR);

function annualizedSharpe(perBar: number): number {
  return perBar * ANNUALIZE;
}

/** Spread-safe summary for LARGE per-bar series (the committed gate uses
 * Math.min(...values) which overflows the call stack past ~1e5 elements). We
 * compute the same fields in O(n) without spread. Used for reporting Sharpe /
 * compound on full series; the committed gates are fed BLOCK-aggregated (small)
 * series so they run unmodified. */
function safeSummary(returns: readonly number[]): {
  sharpe: number;
  compoundReturn: number;
  mean: number;
  sampleCount: number;
} {
  const n = returns.length;
  if (n === 0) return { sharpe: 0, compoundReturn: 0, mean: 0, sampleCount: 0 };
  let logsum = 0;
  for (const x of returns) logsum += Math.log1p(x <= -1 ? -0.999999 : x);
  return {
    sharpe: sharpeOf(returns),
    compoundReturn: Math.expm1(logsum),
    mean: returns.reduce((s, x) => s + x, 0) / n,
    sampleCount: n,
  };
}

/** Aggregate per-bar net returns into non-overlapping block (compounded) returns.
 * Block returns are the statistically cleaner unit for Sharpe significance (they
 * deflate the per-bar autocorrelation) and keep arrays small enough for the
 * committed gate functions. blockBars=96 = one trading day of 15m bars. */
function blockReturns(perBar: readonly number[], blockBars: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < perBar.length; i += blockBars) {
    let logsum = 0;
    const end = Math.min(i + blockBars, perBar.length);
    for (let j = i; j < end; j += 1) {
      const x = perBar[j];
      logsum += Math.log1p(x <= -1 ? -0.999999 : x);
    }
    out.push(Math.expm1(logsum));
  }
  return out;
}

function log(...args: unknown[]): void {
  console.log(...args);
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: ROOT,
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function main(): void {
  const t0 = Date.now();
  log("=".repeat(78));
  log("TRACK WF-C — Adaptive walk-forward on 15m BTC + SURROGATE/PLACEBO control");
  log("=".repeat(78));

  const bars = loadBars(DATA);
  const closes = bars.map((b) => b.close);
  const N = closes.length;
  log(`Loaded ${N} 15m bars from ${new Date(bars[0].time).toISOString()} to ${new Date(bars[N - 1].time).toISOString()}`);
  log(`Cost: ${COST_PER_SIDE * 10000}bps/side (taker perp). Annualization: sqrt(${BARS_PER_YEAR.toFixed(0)} bars/yr).`);

  // ---- holdout split: last ~18% consume-once vault, rest is the search span ----
  const holdoutFraction = 0.18;
  const holdoutStart = Math.floor(N * (1 - holdoutFraction));
  const searchStart = 0;
  const searchEnd = holdoutStart; // search may NOT touch >= holdoutStart
  log(`\nHoldout split: search bars [0, ${searchEnd}) = ${searchEnd} bars (~${((searchEnd / N) * 100).toFixed(0)}%);`);
  log(`              holdout bars [${holdoutStart}, ${N}) = ${N - holdoutStart} bars (~${(holdoutFraction * 100).toFixed(0)}%, consume-once).`);

  // ===================================================================
  // Q1 — Does the optimal param drift TRACKABLY (persistent) or jump randomly?
  // Measured on the SEARCH span only. Fine cadence so we get many steps.
  // ===================================================================
  log("\n" + "-".repeat(78));
  log("Q1: Does the trailing-best param DRIFT trackably (persistent/autocorrelated)?");
  log("-".repeat(78));
  const driftByFamily: Record<string, ReturnType<typeof paramDriftDiagnostic>> = {};
  const families: Family[] = ["donchian", "bollinger", "rsi"];
  for (const fam of families) {
    const d = paramDriftDiagnostic(
      closes,
      fam,
      4000, // trailing window ~1.4 months of 15m bars
      1000, // re-opt cadence ~10.4 days
      searchStart,
      searchEnd,
      COST_PER_SIDE,
    );
    driftByFamily[fam] = d;
    log(
      `  ${fam.padEnd(10)} steps=${d.paramSeries.length}  ` +
        `lag1 AC=${d.lag1Autocorr.toFixed(3)}  lag2=${d.lag2Autocorr.toFixed(3)}  lag4=${d.lag4Autocorr.toFixed(3)}  ` +
        `changedFrac=${d.changedFraction.toFixed(2)}  meanAbsStep=${d.meanAbsStep.toFixed(1)}`,
    );
  }

  // ===================================================================
  // Meta-config grid (the honest multiple-testing surface). Selected on SEARCH.
  // ===================================================================
  const trainGrid = [2000, 4000, 8000]; // ~21d, ~42d, ~83d trailing windows
  const oosGrid = [500, 1000, 2000]; // ~5d, ~10d, ~21d re-opt cadence / OOS slice
  const metaConfigs: MetaConfig[] = [];
  for (const fam of families) {
    for (const trainBars of trainGrid) {
      for (const oosBars of oosGrid) {
        metaConfigs.push({ family: fam, trainBars, oosBars });
      }
    }
  }
  const META_N = metaConfigs.length;
  log("\n" + "-".repeat(78));
  log(`Meta-config selection on SEARCH span. N = ${META_N} meta-configs ` +
    `(${families.length} families x ${trainGrid.length} trainBars x ${oosGrid.length} oosBars).`);
  log("This N is the honest trial count for the Deflated Sharpe Ratio.");
  log("-".repeat(78));

  const rngSel = mulberry32(12345);
  const searchResults = metaConfigs.map((cfg) => {
    const wf = runWalkForward(closes, cfg, searchStart, searchEnd, COST_PER_SIDE, pickBest, rngSel);
    const stats = safeSummary(wf.netReturns);
    return { cfg, wf, stats };
  });
  // rank by net per-bar Sharpe on the search span
  searchResults.sort((a, b) => b.stats.sharpe - a.stats.sharpe);
  log("  Top meta-configs on SEARCH (net per-bar Sharpe, annualized):");
  for (const r of searchResults.slice(0, 6)) {
    log(
      `    ${r.cfg.family.padEnd(10)} train=${String(r.cfg.trainBars).padEnd(5)} oos=${String(r.cfg.oosBars).padEnd(5)} ` +
        `searchSharpe(ann)=${annualizedSharpe(r.stats.sharpe).toFixed(3)}  ` +
        `compound=${(r.stats.compoundReturn * 100).toFixed(1)}%  changeEvents=${r.wf.changeEvents}`,
    );
  }
  const chosen = searchResults[0];
  log(`\n  SELECTED meta-config: family=${chosen.cfg.family} trainBars=${chosen.cfg.trainBars} oosBars=${chosen.cfg.oosBars}`);
  log(`  (search-span net Sharpe ann=${annualizedSharpe(chosen.stats.sharpe).toFixed(3)})`);

  // ===================================================================
  // HOLDOUT (consume-once). Run chosen adaptive config + ALL benchmarks.
  // ===================================================================
  log("\n" + "=".repeat(78));
  log("HOLDOUT (consume-once): chosen adaptive config vs 4 honest benchmarks");
  log("=".repeat(78));

  // The adaptive run on the holdout still re-optimizes, but its trailing window
  // must include bars just BEFORE the holdout to make the first decision. We
  // start the WF range at holdoutStart - trainBars so the first OOS bar is the
  // first holdout bar and the first trailing window ends exactly at holdoutStart.
  const hRangeStart = Math.max(0, holdoutStart - chosen.cfg.trainBars);
  // But OOS returns we COUNT must lie inside the holdout. runWalkForward begins
  // trading at hRangeStart + trainBars == holdoutStart. Good — all counted OOS
  // bars are >= holdoutStart (inside the vault).
  const rngH = mulberry32(999);

  const adaptive = runWalkForward(
    closes,
    chosen.cfg,
    hRangeStart,
    N,
    COST_PER_SIDE,
    pickBest,
    rngH,
  );
  const adaptiveStats = safeSummary(adaptive.netReturns);
  const adaptiveGross = safeSummary(adaptive.grossReturns);

  // sanity: first counted OOS bar must be >= holdoutStart (no vault leakage)
  if (adaptive.firstBar < holdoutStart) {
    throw new Error(`LEAKAGE: adaptive first OOS bar ${adaptive.firstBar} < holdoutStart ${holdoutStart}`);
  }

  // Benchmark 1: buy & hold over the SAME OOS span
  const bh = runBuyHold(closes, adaptive.firstBar, adaptive.lastBar, COST_PER_SIDE);
  const bhStats = safeSummary(bh);

  // Benchmark 2: honest fixed-param (locked on first in-sample window before holdout)
  const fixed = runFixedParam(closes, chosen.cfg, hRangeStart, N, COST_PER_SIDE);
  const fixedStats = safeSummary(fixed.netReturns);

  // Benchmark 3: random-param WF (same machinery, random pick each step)
  const RANDOM_SEEDS = 30;
  const randomSharpes: number[] = [];
  for (let s = 0; s < RANDOM_SEEDS; s += 1) {
    const rng = mulberry32(7000 + s);
    const wf = runWalkForward(closes, chosen.cfg, hRangeStart, N, COST_PER_SIDE, pickRandom, rng);
    randomSharpes.push(safeSummary(wf.netReturns).sharpe);
  }
  randomSharpes.sort((a, b) => a - b);
  const randomMean = randomSharpes.reduce((s, x) => s + x, 0) / randomSharpes.length;
  const randomP95 = randomSharpes[Math.floor(0.95 * (randomSharpes.length - 1))];

  log(`\nAdaptive (trailing-best) OOS on holdout:`);
  log(`  netSharpe(perBar)=${adaptiveStats.sharpe.toFixed(5)}  ann=${annualizedSharpe(adaptiveStats.sharpe).toFixed(3)}  ` +
    `compound=${(adaptiveStats.compoundReturn * 100).toFixed(1)}%  bars=${adaptiveStats.sampleCount}`);
  log(`  grossSharpe(ann)=${annualizedSharpe(adaptiveGross.sharpe).toFixed(3)}  changeEvents=${adaptive.changeEvents}  turnoverUnits=${adaptive.turnoverUnits}`);
  log(`Buy & hold (same span):    netSharpe(ann)=${annualizedSharpe(bhStats.sharpe).toFixed(3)}  compound=${(bhStats.compoundReturn * 100).toFixed(1)}%`);
  log(`Fixed-param (honest):      netSharpe(ann)=${annualizedSharpe(fixedStats.sharpe).toFixed(3)}  compound=${(fixedStats.compoundReturn * 100).toFixed(1)}%  param=${fixed.param}  changeEvents=${fixed.changeEvents}`);
  log(`Random-param WF (${RANDOM_SEEDS} seeds): meanSharpe(ann)=${annualizedSharpe(randomMean).toFixed(3)}  p95(ann)=${annualizedSharpe(randomP95).toFixed(3)}`);

  // Turnover cost of adapting: extra change events vs fixed, * 2 sides * cost.
  const extraEvents = adaptive.changeEvents - fixed.changeEvents;
  const adaptTurnoverCostFrac = (adaptive.turnoverUnits - fixed.turnoverUnits) * COST_PER_SIDE;
  log(`\nTurnover cost of ADAPTING (vs fixed): extra changeEvents=${extraEvents}, ` +
    `extra turnover units=${adaptive.turnoverUnits - fixed.turnoverUnits}, ` +
    `=> extra cost ~${(adaptTurnoverCostFrac * 100).toFixed(2)}% of equity over holdout.`);

  // ===================================================================
  // SURROGATE / PLACEBO — the anti-self-deception track.
  // Build surrogates of the FULL return series, integrate to a price path that
  // matches the real scale, then run the EXACT SAME adaptive pipeline (same
  // chosen meta-config, same holdout span indices) on each surrogate.
  // ===================================================================
  log("\n" + "=".repeat(78));
  log("SURROGATE / PLACEBO control: same adaptive machinery on phase-randomized");
  log("and block-bootstrap surrogates (preserve vol & autocorr, destroy regimes).");
  log("=".repeat(78));

  const realReturns = toReturns(bars);
  const p0 = closes[0];
  const SURR_SEEDS = 40;

  function surrogateAdaptiveSharpe(kind: "phase" | "block", seed: number): {
    sharpe: number;
    compound: number;
    changeEvents: number;
    bars: number;
  } {
    let surrReturns: number[];
    if (kind === "phase") {
      surrReturns = phaseRandomizedReturns(realReturns, seed);
    } else {
      // block length ~ 96 bars (1 day) preserves intraday autocorr
      surrReturns = blockBootstrapReturns(realReturns, 96, seed);
    }
    const surrCloses = pricesFromReturns(surrReturns, p0);
    // map holdout indices onto the surrogate (same length convention). Surrogate
    // price length = surrReturns.length + 1. Phase truncates to power-of-two, so
    // recompute the holdout split on the surrogate's own length to stay valid.
    const sn = surrCloses.length;
    const sHoldoutStart = Math.floor(sn * (1 - holdoutFraction));
    const sRangeStart = Math.max(0, sHoldoutStart - chosen.cfg.trainBars);
    const rng = mulberry32(424242 + seed);
    const wf = runWalkForward(surrCloses, chosen.cfg, sRangeStart, sn, COST_PER_SIDE, pickBest, rng);
    const st = safeSummary(wf.netReturns);
    return { sharpe: st.sharpe, compound: st.compoundReturn, changeEvents: wf.changeEvents, bars: st.sampleCount };
  }

  const phaseSharpes: number[] = [];
  const blockSharpes: number[] = [];
  for (let s = 0; s < SURR_SEEDS; s += 1) {
    phaseSharpes.push(surrogateAdaptiveSharpe("phase", s + 1).sharpe);
    blockSharpes.push(surrogateAdaptiveSharpe("block", s + 1).sharpe);
  }
  phaseSharpes.sort((a, b) => a - b);
  blockSharpes.sort((a, b) => a - b);

  function dist(name: string, arr: number[]): { mean: number; p05: number; p50: number; p95: number; max: number } {
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    const q = (p: number) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(p * (arr.length - 1))))];
    const r = { mean, p05: q(0.05), p50: q(0.5), p95: q(0.95), max: arr[arr.length - 1] };
    log(
      `  ${name.padEnd(22)} mean(ann)=${annualizedSharpe(r.mean).toFixed(3)}  ` +
        `p50=${annualizedSharpe(r.p50).toFixed(3)}  p95=${annualizedSharpe(r.p95).toFixed(3)}  ` +
        `max=${annualizedSharpe(r.max).toFixed(3)}`,
    );
    return r;
  }
  log(`\nAdaptive net Sharpe distribution (per-bar; annualized shown):`);
  log(`  REAL holdout (ann)=${annualizedSharpe(adaptiveStats.sharpe).toFixed(3)}`);
  const phaseDist = dist("phase-randomized", phaseSharpes);
  const blockDist = dist("block-bootstrap", blockSharpes);

  // Empirical placebo p-value: fraction of surrogates with Sharpe >= real.
  const allSurr = [...phaseSharpes, ...blockSharpes].sort((a, b) => a - b);
  const surrGE = allSurr.filter((x) => x >= adaptiveStats.sharpe).length;
  const placeboP = (surrGE + 1) / (allSurr.length + 1);
  log(`\nPlacebo p-value (surrogate Sharpe >= real): ${surrGE}/${allSurr.length} => p≈${placeboP.toFixed(3)}`);
  const realVsSurr = adaptiveStats.sharpe - phaseDist.mean;
  log(`Real - mean(surrogate) per-bar Sharpe = ${realVsSurr.toFixed(5)} (ann ${annualizedSharpe(realVsSurr).toFixed(3)})`);

  // ===================================================================
  // GATES on the holdout adaptive return series. The committed gate functions
  // are fed DAILY-BLOCK returns (96 x 15m bars): cleaner Sharpe significance
  // (deflates per-bar autocorrelation) and small enough to avoid the spread
  // overflow in summarizeReturnSeries. N for the DSR = the meta-config grid.
  // ===================================================================
  log("\n" + "=".repeat(78));
  log("GATES (holdout adaptive net returns, aggregated to DAILY blocks)");
  log("=".repeat(78));

  const BLOCK = 96; // 1 trading day of 15m bars
  const BLOCKS_PER_YEAR = BARS_PER_YEAR / BLOCK; // ~365
  const ANN_BLOCK = Math.sqrt(BLOCKS_PER_YEAR);
  const adaptiveBlocks = blockReturns(adaptive.netReturns, BLOCK);
  const bhBlocks = blockReturns(bh, BLOCK);
  const fixedBlocks = blockReturns(fixed.netReturns, BLOCK);
  const blockStats = summarizeReturnSeries(adaptiveBlocks);
  log(`Daily-block adaptive: blocks=${blockStats.sampleCount} blockSharpe=${blockStats.sharpe.toFixed(4)} ` +
    `ann=${(blockStats.sharpe * ANN_BLOCK).toFixed(3)} compound=${(blockStats.compoundReturn * 100).toFixed(1)}%`);

  const dsr = computeDeflatedSharpeRatio(adaptiveBlocks, { trialCount: META_N });
  log(`Deflated Sharpe (N=${META_N}, daily blocks): sharpe=${dsr.sharpe.toFixed(4)} expMaxSharpe=${dsr.expectedMaxSharpe.toFixed(4)} ` +
    `z=${dsr.zScore.toFixed(3)} DSR_prob=${dsr.deflatedProbability.toFixed(4)}`);
  const dsrP = 1 - dsr.deflatedProbability; // p-value that it's NOT > expected-max-null

  const hair = haircutSharpe({
    observedSharpe: blockStats.sharpe,
    sampleCount: blockStats.sampleCount,
    trialCount: META_N,
    method: "bonferroni",
  });
  log(`Harvey-Liu haircut (Bonferroni, N=${META_N}): pValue=${hair.pValue.toExponential(2)} ` +
    `adjP=${hair.adjustedPValue.toExponential(2)} haircutSharpe=${hair.haircutSharpe.toFixed(4)} haircut=${(hair.haircut * 100).toFixed(1)}%`);

  const minbtl = evaluateMinBtl({
    trialCount: META_N,
    sampleCount: blockStats.sampleCount,
    observedSharpe: blockStats.sharpe,
  });
  log(`MinBTL: sufficientLength=${minbtl.sufficientLength} reason=${minbtl.reason} ` +
    `expMaxNullSharpe=${minbtl.expectedMaxNullSharpe.toFixed(4)} minSample=${minbtl.minSampleForObservedSharpe}`);

  // Baseline gate (Sharpe, net, daily blocks): adaptive vs buy&hold + fixed.
  // Block-vs-block so the units match. The random-WF and surrogate controls are
  // compared separately (per-bar, like-for-like) in the verdict logic below.
  const baselineGate = evaluateBaselineGate({
    candidateReturns: adaptiveBlocks,
    statistic: "sharpe",
    baselines: [
      baselineScoreFromReturns("buy_and_hold", "Buy & hold", bhBlocks, { statistic: "sharpe" }),
      baselineScoreFromReturns("fixed_param", "Honest fixed-param", fixedBlocks, { statistic: "sharpe" }),
    ],
    requirePositive: true,
    minMargin: 0,
  });
  log(`\nBaseline gate (Sharpe, net): candidateSharpe=${baselineGate.candidateScore.toFixed(5)} passed=${baselineGate.passed}`);
  for (const c of baselineGate.comparisons) {
    log(`  vs ${c.label.padEnd(22)} baseline=${c.baselineScore.toFixed(5)} margin=${c.margin.toFixed(5)} beaten=${c.beaten}`);
  }

  // ===================================================================
  // VERDICT
  // ===================================================================
  const beatsBuyHold = adaptiveStats.sharpe > bhStats.sharpe && adaptiveStats.compoundReturn > bhStats.compoundReturn;
  const beatsFixed = adaptiveStats.sharpe > fixedStats.sharpe;
  const beatsRandom = adaptiveStats.sharpe > randomP95;
  // "real >> surrogate" (no artifact): real must clearly exceed BOTH surrogate
  // distributions' p95 AND the placebo p-value must be significant (<=0.05).
  const realBeatsSurrogate =
    adaptiveStats.sharpe > phaseDist.p95 && adaptiveStats.sharpe > blockDist.p95 && placeboP <= 0.05;
  const passesDsr = dsr.deflatedProbability >= 0.95;
  const positive = adaptiveStats.sharpe > 0 && adaptiveStats.compoundReturn > 0;

  let verdict: "SURVIVE" | "KILL" | "PARTIAL";
  if (positive && beatsBuyHold && beatsFixed && beatsRandom && realBeatsSurrogate && passesDsr) {
    verdict = "SURVIVE";
  } else if (!positive || (!realBeatsSurrogate && !beatsBuyHold && !beatsFixed)) {
    verdict = "KILL";
  } else {
    verdict = "PARTIAL";
  }

  log("\n" + "=".repeat(78));
  log("VERDICT DECISION TABLE");
  log("=".repeat(78));
  log(`  positive (Sharpe>0 & compound>0):        ${positive}`);
  log(`  Q2 adaptive beats buy&hold:              ${beatsBuyHold}`);
  log(`  Q3 adaptive beats honest fixed-param:    ${beatsFixed}`);
  log(`     adaptive beats random-WF p95:         ${beatsRandom}`);
  log(`  Q4 real >> surrogate (no artifact):      ${realBeatsSurrogate}  (placeboP=${placeboP.toFixed(3)})`);
  log(`     passes DSR (prob>=0.95):              ${passesDsr}  (prob=${dsr.deflatedProbability.toFixed(4)})`);
  log(`\n  >>> VERDICT: ${verdict} <<<`);
  log(`  Runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const result = {
    track: "WF-C (15m BTC adaptive walk-forward + surrogate/placebo)",
    dataSource: DATA,
    gitSha: gitSha(),
    bars: N,
    dateRange: [new Date(bars[0].time).toISOString(), new Date(bars[N - 1].time).toISOString()],
    costPerSideBps: COST_PER_SIDE * 10000,
    holdout: { fraction: holdoutFraction, start: holdoutStart, bars: N - holdoutStart },
    metaTrialCount: META_N,
    q1_drift: Object.fromEntries(
      Object.entries(driftByFamily).map(([k, v]) => [
        k,
        {
          steps: v.paramSeries.length,
          lag1Autocorr: v.lag1Autocorr,
          lag2Autocorr: v.lag2Autocorr,
          lag4Autocorr: v.lag4Autocorr,
          changedFraction: v.changedFraction,
          meanAbsStep: v.meanAbsStep,
        },
      ]),
    ),
    chosenMetaConfig: chosen.cfg,
    holdoutResults: {
      adaptive: {
        perBarSharpe: adaptiveStats.sharpe,
        annualizedSharpe: annualizedSharpe(adaptiveStats.sharpe),
        grossAnnualizedSharpe: annualizedSharpe(adaptiveGross.sharpe),
        compoundReturn: adaptiveStats.compoundReturn,
        bars: adaptiveStats.sampleCount,
        changeEvents: adaptive.changeEvents,
        turnoverUnits: adaptive.turnoverUnits,
        firstBar: adaptive.firstBar,
        lastBar: adaptive.lastBar,
      },
      buyHold: { annualizedSharpe: annualizedSharpe(bhStats.sharpe), compoundReturn: bhStats.compoundReturn },
      fixedParam: { annualizedSharpe: annualizedSharpe(fixedStats.sharpe), compoundReturn: fixedStats.compoundReturn, param: fixed.param, changeEvents: fixed.changeEvents },
      randomWf: { meanAnnualizedSharpe: annualizedSharpe(randomMean), p95AnnualizedSharpe: annualizedSharpe(randomP95) },
      adaptTurnoverCostFrac,
      extraChangeEventsVsFixed: extraEvents,
    },
    surrogate: {
      seeds: SURR_SEEDS,
      phase: { meanAnn: annualizedSharpe(phaseDist.mean), p50Ann: annualizedSharpe(phaseDist.p50), p95Ann: annualizedSharpe(phaseDist.p95), maxAnn: annualizedSharpe(phaseDist.max) },
      block: { meanAnn: annualizedSharpe(blockDist.mean), p50Ann: annualizedSharpe(blockDist.p50), p95Ann: annualizedSharpe(blockDist.p95), maxAnn: annualizedSharpe(blockDist.max) },
      placeboPValue: placeboP,
      realMinusSurrogateMeanPerBar: realVsSurr,
    },
    gates: {
      dsr: { prob: dsr.deflatedProbability, pValue: dsrP, expMaxSharpe: dsr.expectedMaxSharpe, zScore: dsr.zScore, trialCount: META_N },
      haircut: { pValue: hair.pValue, adjustedPValue: hair.adjustedPValue, haircutSharpe: hair.haircutSharpe, haircut: hair.haircut },
      minBtl: { sufficientLength: minbtl.sufficientLength, reason: minbtl.reason },
      baselineGate: { passed: baselineGate.passed, candidateScore: baselineGate.candidateScore, comparisons: baselineGate.comparisons },
    },
    verdict,
    decisionFlags: { positive, beatsBuyHold, beatsFixed, beatsRandom, realBeatsSurrogate, passesDsr },
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  log(`\nWrote ${OUT}`);
}

main();
