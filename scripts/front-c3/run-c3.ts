/**
 * FRONT C3 — JOINT market-state / breadth overlay. Full rigor run.
 *
 * QUESTION: does the multi-asset JOINT view (breadth, cross-sectional dispersion,
 * average pairwise correlation, volume concentration / BTC dominance, aggregate
 * momentum) carry market-TIMING / RISK-regime information that a single series
 * hides? We:
 *   (1) compute the joint state signals from the 30-coin panel (PAST-only, lagged);
 *   (2) test whether they PREDICT forward aggregate return and forward realized vol;
 *   (3) build a risk-on/off overlay that scales exposure to the equal-weight book
 *       vs always-on equal-weight and buy&hold-BTC, NET OF COST (8 bps round-trip
 *       on every change in exposure);
 *   (4) push the best overlay through the COMMITTED gates (DSR true-N, MinBTL,
 *       baselines beat buy&hold + EW + random-lottery + linear, haircut, CPCV-PBO),
 *       a consume-once HOLDOUT, and the SURROGATE/PLACEBO battery
 *       (phase-randomized, block-bootstrap, cross-sectional-shuffle nulls);
 *   (5) report cycle evidence (ACF + dominant spectral period + lead-lag).
 *
 * The SEARCH only sees the search window (oldest 70%); test = next 15%; the final
 * holdout (most recent 15%) is consumed ONCE. Surrogates re-run the IDENTICAL
 * search+overlay machinery so any "edge" they reproduce is an artifact.
 *
 * Run: <codex-node>/tsx scripts/front-c3/run-c3.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  loadPanel,
  buildReturns,
  aggregateReturn,
  computeStateSignals,
  expandingZScore,
  pearson,
  meanOf,
  stdOf,
  autocorr,
  dominantPeriod,
  phaseRandomizePanel,
  blockBootstrapPanel,
  crossSectionalShufflePanel,
  type Panel,
  type ReturnMatrix,
  type SignalParams,
} from "./lib-c3";
import { evaluatePromotion } from "../../src/lib/significance/promotion-evaluator";
import { planHoldoutSplit, FinalHoldoutGuard } from "../../src/lib/significance/holdout";
import { summarizeReturnSeries } from "../../src/lib/statistical-validation";
import { baselineScoreFromReturns } from "../../src/lib/significance/baselines";

const ROUND_TRIP_COST = 0.0008; // 8 bps round-trip (4 bps/side taker perp) per the cost rule
const DSR_THRESHOLD = 0.95;

// ---------------------------------------------------------------------------
// Overlay strategy + search grid
// ---------------------------------------------------------------------------

interface OverlayConfig {
  id: string;
  params: SignalParams;
  // weights of each z-scored signal in the regime score (sign chosen by hypothesis)
  wBreadth: number;
  wDispersion: number; // high dispersion => risk-off (negative weight)
  wCorr: number; // high correlation => risk-off (negative weight)
  wMom: number;
  wHHI: number; // high concentration => flight-to-BTC, risk-off (negative)
  expoMin: number;
  expoMax: number;
  smooth: number; // EMA smoothing of exposure (days) to cut turnover
}

interface OverlayResult {
  config: OverlayConfig;
  // daily NET returns of the overlay over the EVALUATION slice
  net: number[];
  gross: number[];
  exposure: number[];
  ewBench: number[]; // equal-weight always-on (net of its own rebalancing? -> we charge 0; it is daily EW)
  turnover: number; // mean |Δexposure| per day
}

/**
 * Run the overlay on a given panel over [start,end). Returns the NET daily P&L of
 * the EW book scaled by the lagged regime exposure, plus benchmarks. Exposure at
 * day t (held over day t, applied to agg[t]) uses signals from day t-1 (lag).
 */
function runOverlay(
  panel: Panel,
  ret: ReturnMatrix,
  cfg: OverlayConfig,
  start: number,
  end: number,
): OverlayResult {
  const T = panel.dates.length;
  const sig = computeStateSignals(panel, ret, cfg.params);
  const agg = aggregateReturn(ret, panel.symbols, T);

  // z-score each signal causally
  const zB = expandingZScore(sig.breadth);
  const zD = expandingZScore(sig.dispersion);
  const zC = expandingZScore(sig.avgCorr);
  const zM = expandingZScore(sig.aggMom);
  const zH = expandingZScore(sig.volHHI);

  // raw regime score (higher => more risk-on)
  const score = new Array(T).fill(0);
  for (let t = 0; t < T; t += 1) {
    score[t] =
      cfg.wBreadth * zB[t] +
      cfg.wDispersion * zD[t] +
      cfg.wCorr * zC[t] +
      cfg.wMom * zM[t] +
      cfg.wHHI * zH[t];
  }
  // map score -> exposure via logistic into [expoMin, expoMax]
  const rawExpo = new Array(T).fill(cfg.expoMax);
  for (let t = 0; t < T; t += 1) {
    const logistic = 1 / (1 + Math.exp(-score[t]));
    rawExpo[t] = cfg.expoMin + (cfg.expoMax - cfg.expoMin) * logistic;
  }
  // EMA smooth to cut turnover
  const expo = new Array(T).fill(cfg.expoMax);
  const alpha = 2 / (cfg.smooth + 1);
  for (let t = 0; t < T; t += 1) {
    expo[t] = t === 0 ? rawExpo[t] : alpha * rawExpo[t] + (1 - alpha) * expo[t - 1];
  }

  const net: number[] = [];
  const gross: number[] = [];
  const exposure: number[] = [];
  const ewBench: number[] = [];
  let turnoverSum = 0;
  let turnoverCnt = 0;
  let prevExpo = cfg.expoMax; // assume start fully invested baseline

  for (let t = Math.max(start, 1); t < end; t += 1) {
    // exposure for day t determined by signals at t-1 (lag => no lookahead)
    const e = expo[t - 1];
    const g = e * agg[t];
    const dExpo = Math.abs(e - prevExpo);
    const cost = dExpo * ROUND_TRIP_COST; // cost proportional to traded fraction
    net.push(g - cost);
    gross.push(g);
    exposure.push(e);
    ewBench.push(agg[t]);
    turnoverSum += dExpo;
    turnoverCnt += 1;
    prevExpo = e;
  }

  return {
    config: cfg,
    net,
    gross,
    exposure,
    ewBench,
    turnover: turnoverCnt > 0 ? turnoverSum / turnoverCnt : 0,
  };
}

/** Build the search grid => its size is the TRUE N for deflation. */
function buildGrid(): OverlayConfig[] {
  const grid: OverlayConfig[] = [];
  const maW = [30, 50];
  const corrW = [20, 40];
  const momW = [20, 40];
  const expo = [
    { min: 0.0, max: 1.0 },
    { min: 0.3, max: 1.0 },
  ];
  const smooths = [5, 10];
  // single hypothesis-driven weight vector (risk-on = high breadth/mom, low disp/corr/hhi)
  const wB = 1.0;
  const wD = -0.5;
  const wC = -0.7;
  const wM = 0.6;
  const wH = -0.4;
  let i = 0;
  for (const ma of maW)
    for (const cw of corrW)
      for (const mw of momW)
        for (const ex of expo)
          for (const sm of smooths) {
            grid.push({
              id: `c3-${i++}`,
              params: { maWindow: ma, dispWindow: mw, corrWindow: cw, momWindow: mw },
              wBreadth: wB,
              wDispersion: wD,
              wCorr: wC,
              wMom: wM,
              wHHI: wH,
              expoMin: ex.min,
              expoMax: ex.max,
              smooth: sm,
            });
          }
  return grid;
}

function sharpeAnn(net: number[]): number {
  const s = summarizeReturnSeries(net);
  return s.stdDev > 1e-12 ? (s.mean / s.stdDev) * Math.sqrt(365) : 0;
}
function maxDD(net: number[]): number {
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of net) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

/**
 * Search: pick the best config by SEARCH-WINDOW net Sharpe (only the search slice
 * is visible). Returns the winner + its in-search Sharpe.
 */
function search(
  panel: Panel,
  ret: ReturnMatrix,
  grid: OverlayConfig[],
  searchStart: number,
  searchEnd: number,
): { winner: OverlayConfig; results: Map<string, OverlayResult>; bestSharpe: number } {
  const results = new Map<string, OverlayResult>();
  let best: OverlayConfig | null = null;
  let bestSharpe = -Infinity;
  for (const cfg of grid) {
    const r = runOverlay(panel, ret, cfg, searchStart, searchEnd);
    results.set(cfg.id, r);
    const sh = sharpeAnn(r.net);
    if (sh > bestSharpe) {
      bestSharpe = sh;
      best = cfg;
    }
  }
  return { winner: best as OverlayConfig, results, bestSharpe };
}

/** Aggregate predictive diagnostics: does each signal predict fwd ret / fwd vol? */
function predictiveDiagnostics(
  panel: Panel,
  ret: ReturnMatrix,
  params: SignalParams,
  start: number,
  end: number,
  horizon: number,
): Record<string, { predRet: number; predVol: number }> {
  const T = panel.dates.length;
  const sig = computeStateSignals(panel, ret, params);
  const agg = aggregateReturn(ret, panel.symbols, T);

  // forward H-day cumulative return and forward H-day realized vol, both starting t+1
  const fwdRet: number[] = new Array(T).fill(NaN);
  const fwdVol: number[] = new Array(T).fill(NaN);
  for (let t = 0; t < T; t += 1) {
    if (t + horizon < T) {
      let logc = 0;
      const window: number[] = [];
      for (let k = t + 1; k <= t + horizon; k += 1) {
        logc += Math.log1p(Math.max(-0.99, agg[k]));
        window.push(agg[k]);
      }
      fwdRet[t] = Math.expm1(logc);
      fwdVol[t] = stdOf(window);
    }
  }

  const signals: Record<string, number[]> = {
    breadth: sig.breadth,
    dispersion: sig.dispersion,
    avgCorr: sig.avgCorr,
    volHHI: sig.volHHI,
    btcDom: sig.btcDom,
    aggMom: sig.aggMom,
  };
  const out: Record<string, { predRet: number; predVol: number }> = {};
  for (const [name, s] of Object.entries(signals)) {
    const xs: number[] = [];
    const yr: number[] = [];
    const yv: number[] = [];
    for (let t = start; t < end; t += 1) {
      if (Number.isFinite(s[t]) && Number.isFinite(fwdRet[t]) && Number.isFinite(fwdVol[t])) {
        xs.push(s[t]);
        yr.push(fwdRet[t]);
        yv.push(fwdVol[t]);
      }
    }
    out[name] = {
      predRet: pearson(xs, yr),
      predVol: pearson(xs, yv),
    };
  }
  return out;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

function main(): void {
  const panel = loadPanel();
  const ret = buildReturns(panel);
  const T = panel.dates.length;
  const grid = buildGrid();
  const TRUE_N = grid.length;

  // Time split: search 70% | test 15% | holdout 15% (consume-once).
  const split = planHoldoutSplit({ totalRows: T, holdoutFraction: 0.15, testFraction: 0.15 });
  const searchStart = 60; // warm-up for expanding z-scores / windows
  const searchEnd = split.search.end;
  const testStart = split.test.start;
  const testEnd = split.test.end;
  const holdStart = split.finalHoldout.start;
  const holdEnd = split.finalHoldout.end;

  console.log("=".repeat(88));
  console.log("FRONT C3 — JOINT market-state / breadth OVERLAY — full rigor");
  console.log("=".repeat(88));
  console.log(`data source   : binance daily closes + binance quote-volume (realData=true)`);
  console.log(`universe      : ${panel.symbols.length} coins`);
  console.log(`days          : ${T}  (${panel.dates[0]} -> ${panel.dates[T - 1]})`);
  console.log(`round-trip    : ${ROUND_TRIP_COST} (8 bps) charged on |Δexposure| each day`);
  console.log(`TRUE N (grid) : ${TRUE_N} overlay configs`);
  console.log(
    `splits        : search[${searchStart},${searchEnd}) test[${testStart},${testEnd}) holdout[${holdStart},${holdEnd})`,
  );
  console.log(
    `              : search ${panel.dates[searchStart]}->${panel.dates[searchEnd - 1]} | ` +
      `test ${panel.dates[testStart]}->${panel.dates[testEnd - 1]} | ` +
      `holdout ${panel.dates[holdStart]}->${panel.dates[holdEnd - 1]}`,
  );

  // --- (2) Predictive diagnostics on the SEARCH window (in-sample, descriptive) ---
  console.log("\n--- (2) JOINT-SIGNAL PREDICTIVE DIAGNOSTICS (search window, H=20d) ---");
  console.log("signal      corr(signal_t, fwd20_ret)   corr(signal_t, fwd20_vol)");
  const diag = predictiveDiagnostics(
    panel,
    ret,
    { maWindow: 50, dispWindow: 20, corrWindow: 30, momWindow: 30 },
    searchStart,
    searchEnd,
    20,
  );
  for (const [name, d] of Object.entries(diag)) {
    console.log(`  ${name.padEnd(10)}  ${d.predRet >= 0 ? " " : ""}${d.predRet.toFixed(4)}                    ${d.predVol >= 0 ? " " : ""}${d.predVol.toFixed(4)}`);
  }

  // --- (5) CYCLE EVIDENCE: ACF + dominant period + lead-lag with fwd market ---
  console.log("\n--- (5) CYCLE EVIDENCE (do JOINT signals oscillate cyclically & lead?) ---");
  const sigFull = computeStateSignals(panel, ret, { maWindow: 50, dispWindow: 20, corrWindow: 30, momWindow: 30 });
  const aggFull = aggregateReturn(ret, panel.symbols, T);
  const cycleNames: Array<[string, number[]]> = [
    ["breadth", sigFull.breadth],
    ["dispersion", sigFull.dispersion],
    ["avgCorr", sigFull.avgCorr],
    ["btcDom", sigFull.btcDom],
  ];
  const cycleReport: Record<string, unknown> = {};
  for (const [name, s] of cycleNames) {
    const sub = s.slice(searchStart, searchEnd);
    const ac1 = autocorr(sub, 1);
    const ac5 = autocorr(sub, 5);
    const ac20 = autocorr(sub, 20);
    const ac60 = autocorr(sub, 60);
    const { period, powerShare } = dominantPeriod(sub, 5, 365);
    // lead-lag: corr(signal_t, fwd-20d agg return). positive lead => predictive.
    const xs: number[] = [];
    const ys: number[] = [];
    for (let t = searchStart; t + 20 < searchEnd; t += 1) {
      let logc = 0;
      for (let k = t + 1; k <= t + 20; k += 1) logc += Math.log1p(Math.max(-0.99, aggFull[k]));
      xs.push(s[t]);
      ys.push(Math.expm1(logc));
    }
    const lead = pearson(xs, ys);
    cycleReport[name] = { ac1, ac5, ac20, ac60, dominantPeriodDays: period, powerShare, leadCorrFwd20: lead };
    console.log(
      `  ${name.padEnd(10)} acf1=${ac1.toFixed(2)} acf5=${ac5.toFixed(2)} acf20=${ac20.toFixed(2)} acf60=${ac60.toFixed(2)} | ` +
        `domPeriod=${period}d (pwr ${(powerShare * 100).toFixed(1)}%) | lead(fwd20)=${lead.toFixed(3)}`,
    );
  }

  // --- (3)+(4) SEARCH on the search window, evaluate winner on TEST, gates, holdout ---
  const { winner, bestSharpe } = search(panel, ret, grid, searchStart, searchEnd);
  console.log(`\n--- (3) BEST OVERLAY (selected on SEARCH window net Sharpe) ---`);
  console.log(`  winner id     : ${winner.id}`);
  console.log(`  params        : MA=${winner.params.maWindow} corrW=${winner.params.corrWindow} momW=${winner.params.momWindow} expo[${winner.expoMin},${winner.expoMax}] smooth=${winner.smooth}`);
  console.log(`  search Sharpe : ${bestSharpe.toFixed(3)} (annualized, net)`);

  // Evaluate winner OOS on TEST slice (pre-holdout audit)
  const testRes = runOverlay(panel, ret, winner, testStart, testEnd);
  const testStats = summarizeReturnSeries(testRes.net);
  const ewTest = summarizeReturnSeries(testRes.ewBench);
  console.log(`\n--- (4a) TEST slice (posterior audit, OOS) ---`);
  console.log(`  overlay  net Sharpe(ann)=${sharpeAnn(testRes.net).toFixed(3)} cumRet=${(testStats.compoundReturn * 100).toFixed(2)}% maxDD=${(maxDD(testRes.net) * 100).toFixed(1)}% turnover=${(testRes.turnover * 100).toFixed(2)}%/day`);
  console.log(`  EW bench net Sharpe(ann)=${sharpeAnn(testRes.ewBench).toFixed(3)} cumRet=${(ewTest.compoundReturn * 100).toFixed(2)}% maxDD=${(maxDD(testRes.ewBench) * 100).toFixed(1)}%`);

  // ---- GATES on the winner, evaluated over SEARCH+TEST (no holdout) ----
  // Build BTC buy&hold returns over the same eval window for the baseline.
  const btcRet = ret["BTC"];
  function sliceFinite(arr: (number | null)[], a: number, b: number): number[] {
    const out: number[] = [];
    for (let t = a; t < b; t += 1) {
      const v = arr[t];
      out.push(v !== null && Number.isFinite(v) ? (v as number) : 0);
    }
    return out;
  }
  // Eval window for gates: search+test (everything the search was allowed to audit)
  const evalRes = runOverlay(panel, ret, winner, searchStart, testEnd);
  const evalNet = evalRes.net;
  const evalEW = evalRes.ewBench;
  const btcEval = sliceFinite(btcRet, searchStart + 1, testEnd); // align length ~ evalNet

  // Linear baseline: a one-layer linear predictor of fwd 1d agg return from the
  // lagged z-scored signals, fit on search window, traded on eval window (net).
  const linNet = buildLinearBaseline(panel, ret, winner.params, searchStart, searchEnd, testEnd);

  // CPCV: chop eval window into K contiguous OOS paths.
  const cpcvPaths = makeCpcvPaths(evalNet, 6);
  const ewPaths = makeCpcvPaths(evalEW, 6);

  console.log(`\n--- (4b) COMMITTED GATES (eval = search+test, true N=${TRUE_N}) ---`);
  const promo = evaluatePromotion({
    candidateId: winner.id,
    candidateReturns: evalNet,
    sampleCount: evalNet.length,
    trialCount: TRUE_N,
    barReturns: evalEW, // buy&hold + random-lottery built off the EW market
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: 1,
    extraBaselines: [
      baselineScoreFromReturns("linear_one_layer", "Linear one-layer (signals->fwd ret)", linNet),
      baselineScoreFromReturns("buy_and_hold_btc", "Buy & hold BTC", btcEval),
    ],
    cpcvPaths,
    cpcvCompetitors: [
      { id: "equal_weight_alwayson", paths: ewPaths },
    ],
    thresholds: { dsrThreshold: DSR_THRESHOLD, haircutMethod: "bonferroni" },
    seed: "front-c3",
  });
  printPromo(promo);

  // ---- SURROGATE / PLACEBO battery ----
  console.log(`\n--- SURROGATE / PLACEBO BATTERY (identical search machinery) ---`);
  const realEvalSharpe = sharpeAnn(evalNet);
  const realEvalEWSharpe = sharpeAnn(evalEW);
  const realEvalCompound = summarizeReturnSeries(evalNet).compoundReturn;
  // EDGE = the overlay's TIMING skill over its OWN equal-weight benchmark. This is
  // the apples-to-apples statistic: a surrogate panel has a different underlying
  // market, so we compare each panel's overlay against ITS OWN EW bench. Real
  // joint-regime information must let the overlay BEAT its EW by more than nulls.
  const realEdge = realEvalSharpe - realEvalEWSharpe;
  console.log(`  REAL eval: bestSearchSharpe=${bestSharpe.toFixed(3)} | winner netSharpe=${realEvalSharpe.toFixed(3)} ewSharpe=${realEvalEWSharpe.toFixed(3)} EDGE=${realEdge.toFixed(3)} compound=${(realEvalCompound * 100).toFixed(2)}%`);

  const N_SURR = Number(process.env.C3_NSURR ?? 40);
  const surrTypes: Array<[string, (p: Panel, r: ReturnMatrix, seed: number) => Panel]> = [
    ["phase_random", (p, r, s) => phaseRandomizePanel(p, r, s)],
    ["block_boot", (p, r, s) => blockBootstrapPanel(p, r, s, 20)],
    ["xsection_shuffle", (p, r, s) => crossSectionalShufflePanel(p, r, s)],
  ];
  const surrReport: Record<string, unknown> = {};
  for (const [tname, gen] of surrTypes) {
    const surrEdges: number[] = [];
    const surrSharpes: number[] = [];
    let geEdge = 0;
    let geSharpe = 0;
    for (let i = 0; i < N_SURR; i += 1) {
      const sp = gen(panel, ret, 1000 + i * 17);
      const sret = buildReturns(sp);
      // IDENTICAL search machinery: search the SAME grid, pick best by search Sharpe,
      // then measure that winner's EDGE over its own EW on the SAME eval window.
      const { winner: sWin } = search(sp, sret, grid, searchStart, searchEnd);
      const sEval = runOverlay(sp, sret, sWin, searchStart, testEnd);
      const sSharpe = sharpeAnn(sEval.net);
      const sEW = sharpeAnn(sEval.ewBench);
      const sEdge = sSharpe - sEW;
      surrEdges.push(sEdge);
      surrSharpes.push(sSharpe);
      if (sEdge >= realEdge) geEdge += 1;
      if (sSharpe >= realEvalSharpe) geSharpe += 1;
    }
    surrEdges.sort((a, b) => a - b);
    surrSharpes.sort((a, b) => a - b);
    // primary placebo p-value uses the EDGE-over-EW statistic
    const pEdge = (geEdge + 1) / (N_SURR + 1);
    const pSharpe = (geSharpe + 1) / (N_SURR + 1);
    const q95edge = surrEdges[Math.floor(0.95 * (surrEdges.length - 1))];
    surrReport[tname] = {
      n: N_SURR,
      statistic: "edge = Sharpe(overlay) - Sharpe(ownEW)",
      surrogateMeanEdge: meanOf(surrEdges),
      surrogateQ95Edge: q95edge,
      realEdge,
      surrogateMeanSharpe: meanOf(surrSharpes),
      realSharpe: realEvalSharpe,
      countSurrogateEdgeGEReal: geEdge,
      countSurrogateSharpeGEReal: geSharpe,
      placeboPValue: pEdge,
      placeboPValueRawSharpe: pSharpe,
    };
    console.log(
      `  ${tname.padEnd(18)} surrEdgeMean=${meanOf(surrEdges).toFixed(3)} surrEdgeQ95=${q95edge.toFixed(3)} ` +
        `realEdge=${realEdge.toFixed(3)} | #surrEdge>=real=${geEdge}/${N_SURR} placeboP(edge)=${pEdge.toFixed(4)} ` +
        `| placeboP(rawSharpe)=${pSharpe.toFixed(4)}`,
    );
  }

  // ---- HOLDOUT (consume-once) ----
  console.log(`\n--- FINAL HOLDOUT (consume-once, most-recent 15%) ---`);
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "front-c3 winner OOS verdict", gitSha: gitSha(), trialCount: TRUE_N, nowIso: new Date().toISOString() });
  const holdRes = runOverlay(panel, ret, winner, holdStart, holdEnd);
  const holdStats = summarizeReturnSeries(holdRes.net);
  const ewHold = summarizeReturnSeries(holdRes.ewBench);
  const btcHold = sliceFinite(btcRet, holdStart + 1, holdEnd);
  const btcHoldStats = summarizeReturnSeries(btcHold);
  console.log(`  overlay  netSharpe(ann)=${sharpeAnn(holdRes.net).toFixed(3)} cumRet=${(holdStats.compoundReturn * 100).toFixed(2)}% maxDD=${(maxDD(holdRes.net) * 100).toFixed(1)}% turnover=${(holdRes.turnover * 100).toFixed(2)}%/day meanExpo=${meanOf(holdRes.exposure).toFixed(2)}`);
  console.log(`  EW bench netSharpe(ann)=${sharpeAnn(holdRes.ewBench).toFixed(3)} cumRet=${(ewHold.compoundReturn * 100).toFixed(2)}% maxDD=${(maxDD(holdRes.ewBench) * 100).toFixed(1)}%`);
  console.log(`  BTC B&H  netSharpe(ann)=${(btcHoldStats.stdDev > 1e-12 ? (btcHoldStats.mean / btcHoldStats.stdDev) * Math.sqrt(365) : 0).toFixed(3)} cumRet=${(btcHoldStats.compoundReturn * 100).toFixed(2)}%`);
  const holdoutBeatsEW = holdStats.compoundReturn > ewHold.compoundReturn && sharpeAnn(holdRes.net) > sharpeAnn(holdRes.ewBench);

  // ---- VERDICT ----
  const placeboFail = Object.values(surrReport).some((r: any) => r.placeboPValue > 0.05);
  const verdict = promo.promotable && !placeboFail && holdoutBeatsEW ? "SURVIVE" : "KILL";
  // Find the binding gate
  let killedBy = "none";
  if (!promo.promotable) killedBy = `gates:${promo.reasons[0] ?? "unknown"}`;
  else if (placeboFail) {
    const worst = Object.entries(surrReport).find(([, r]: [string, any]) => r.placeboPValue > 0.05);
    killedBy = `surrogate:${worst?.[0]}(p=${(worst?.[1] as any).placeboPValue.toFixed(3)})`;
  } else if (!holdoutBeatsEW) killedBy = "holdout:does_not_beat_equal_weight";

  console.log(`\n${"=".repeat(88)}`);
  console.log(`VERDICT: ${verdict}`);
  console.log(`killed by gate: ${killedBy}`);
  console.log(`promotable=${promo.promotable} placeboFail=${placeboFail} holdoutBeatsEW=${holdoutBeatsEW}`);
  console.log("=".repeat(88));

  const report = {
    track: "FRONT C3 — JOINT market-state / breadth overlay",
    dataSource: "binance daily closes (output/crossxs) + binance quote-volume (output/front-c3)",
    realData: true,
    universe: panel.symbols,
    days: T,
    dateRange: [panel.dates[0], panel.dates[T - 1]],
    roundTripCost: ROUND_TRIP_COST,
    trueN: TRUE_N,
    splits: { searchStart, searchEnd, testStart, testEnd, holdStart, holdEnd },
    predictiveDiagnostics: diag,
    cycleEvidence: cycleReport,
    winner,
    searchSharpe: bestSharpe,
    test: {
      overlaySharpe: sharpeAnn(testRes.net),
      overlayCompound: testStats.compoundReturn,
      ewSharpe: sharpeAnn(testRes.ewBench),
      ewCompound: ewTest.compoundReturn,
      turnover: testRes.turnover,
    },
    gates: {
      promotable: promo.promotable,
      reasons: promo.reasons,
      summary: promo.summary,
      deflatedSharpe: promo.gates.deflatedSharpe,
      baselines: promo.gates.baselines.result?.comparisons,
      haircut: promo.gates.haircut.result,
      minBtl: promo.gates.minBtl.result,
      cpcvPbo: { pbo: promo.gates.cpcvPbo.pbo, pooledDsr: promo.gates.cpcvPbo.pooledDeflatedProbability, applicable: promo.gates.cpcvPbo.applicable, passed: promo.gates.cpcvPbo.passed },
    },
    surrogates: surrReport,
    holdout: {
      overlaySharpe: sharpeAnn(holdRes.net),
      overlayCompound: holdStats.compoundReturn,
      overlayMaxDD: maxDD(holdRes.net),
      overlayTurnover: holdRes.turnover,
      overlayMeanExposure: meanOf(holdRes.exposure),
      ewSharpe: sharpeAnn(holdRes.ewBench),
      ewCompound: ewHold.compoundReturn,
      btcCompound: btcHoldStats.compoundReturn,
      beatsEW: holdoutBeatsEW,
      consumed: guard.status(),
    },
    verdict,
    killedBy,
  };
  const outPath = join("output", "front-c3", "c3-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
}

function printPromo(promo: ReturnType<typeof evaluatePromotion>): void {
  const g = promo.gates;
  console.log(`  promotable    : ${promo.promotable}  (gatesPassed ${promo.summary.gatesPassed}/${promo.summary.gatesApplicable})`);
  console.log(`  candidate     : netSharpe(perDay)=${promo.summary.candidateSharpe.toFixed(4)} compound=${(promo.summary.candidateCompoundReturn * 100).toFixed(2)}% n=${promo.summary.sampleCount}`);
  console.log(`  DSR (trueN)   : prob=${g.deflatedSharpe.deflatedProbability.toFixed(4)} thr=${g.deflatedSharpe.threshold} -> ${g.deflatedSharpe.passed ? "PASS" : "FAIL"}`);
  console.log(`  MinBTL        : ${g.minBtl.passed ? "PASS" : "FAIL"} (${g.minBtl.result.reason})`);
  console.log(`  haircut       : haircutSharpe=${g.haircut.result.haircutSharpe.toFixed(4)} (${(g.haircut.result.haircut * 100).toFixed(0)}% cut) -> ${g.haircut.passed ? "PASS" : "FAIL"}`);
  if (g.baselines.result) {
    console.log(`  baselines     : beatsAll=${g.baselines.result.beatsAll} worst=${g.baselines.result.worstBaselineId} (margin ${(g.baselines.result.worstMargin * 100).toFixed(2)}%) -> ${g.baselines.passed ? "PASS" : "FAIL"}`);
    for (const c of g.baselines.result.comparisons) {
      console.log(`      vs ${String(c.id).padEnd(22)} candidate-baseline margin=${(c.margin * 100).toFixed(2)}% beaten=${c.beaten}`);
    }
  }
  console.log(`  CPCV-PBO      : applicable=${g.cpcvPbo.applicable} pbo=${g.cpcvPbo.pbo.toFixed(3)} pooledDSR=${g.cpcvPbo.pooledDeflatedProbability.toFixed(4)} -> ${g.cpcvPbo.passed ? "PASS" : "FAIL"}`);
  if (promo.reasons.length) console.log(`  reasons       : ${promo.reasons.join("; ")}`);
}

/** Chop a return series into K contiguous OOS CPCV paths. */
function makeCpcvPaths(net: number[], k: number): Array<{ pathId: string; returns: number[] }> {
  const out: Array<{ pathId: string; returns: number[] }> = [];
  const n = net.length;
  const size = Math.floor(n / k);
  if (size < 5) return [{ pathId: "p0", returns: net.slice() }];
  for (let i = 0; i < k; i += 1) {
    const a = i * size;
    const b = i === k - 1 ? n : (i + 1) * size;
    out.push({ pathId: `p${i}`, returns: net.slice(a, b) });
  }
  return out;
}

/**
 * Linear one-layer baseline: fit OLS of fwd-1d agg return on lagged z-scored joint
 * signals over the SEARCH window, then trade sign-scaled exposure on the eval
 * window, net of cost. Returns net daily returns aligned to the eval window.
 */
function buildLinearBaseline(
  panel: Panel,
  ret: ReturnMatrix,
  params: SignalParams,
  searchStart: number,
  searchEnd: number,
  evalEnd: number,
): number[] {
  const T = panel.dates.length;
  const sig = computeStateSignals(panel, ret, params);
  const agg = aggregateReturn(ret, panel.symbols, T);
  const z = {
    b: expandingZScore(sig.breadth),
    d: expandingZScore(sig.dispersion),
    c: expandingZScore(sig.avgCorr),
    m: expandingZScore(sig.aggMom),
    h: expandingZScore(sig.volHHI),
  };
  // design matrix on search window: predict agg[t+1] from signals at t
  const X: number[][] = [];
  const y: number[] = [];
  for (let t = searchStart; t < searchEnd - 1; t += 1) {
    X.push([1, z.b[t], z.d[t], z.c[t], z.m[t], z.h[t]]);
    y.push(agg[t + 1]);
  }
  const beta = olsFit(X, y);
  // Standardize predictions on the search window so the logistic map is well-scaled
  // (fair comparison vs the overlay, which also maps a z-scored score -> [0,1]).
  const predsSearch: number[] = [];
  for (let t = searchStart; t < searchEnd - 1; t += 1) {
    predsSearch.push(beta[0] + beta[1] * z.b[t] + beta[2] * z.d[t] + beta[3] * z.c[t] + beta[4] * z.m[t] + beta[5] * z.h[t]);
  }
  const pMean = meanOf(predsSearch);
  const pStd = Math.max(1e-9, stdOf(predsSearch));
  // trade on eval window: exposure = logistic(standardized prediction) in [0,1]
  const net: number[] = [];
  let prevExpo = 1;
  for (let t = searchStart; t < evalEnd - 1; t += 1) {
    const pred = beta[0] + beta[1] * z.b[t] + beta[2] * z.d[t] + beta[3] * z.c[t] + beta[4] * z.m[t] + beta[5] * z.h[t];
    const zPred = (pred - pMean) / pStd;
    const e = 1 / (1 + Math.exp(-zPred)); // [0,1]
    const g = e * agg[t + 1];
    const cost = Math.abs(e - prevExpo) * ROUND_TRIP_COST;
    net.push(g - cost);
    prevExpo = e;
  }
  return net;
}

/** Tiny OLS via normal equations (ridge-stabilized). */
function olsFit(X: number[][], y: number[]): number[] {
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < X.length; i += 1) {
    for (let a = 0; a < p; a += 1) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b += 1) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < p; a += 1) XtX[a][a] += 1e-6; // ridge
  return solve(XtX, Xty);
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let c = col; c <= n; c += 1) M[col][c] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

main();
