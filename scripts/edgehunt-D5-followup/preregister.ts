/**
 * D5-08 FOLLOW-UP — pre-registered single-config forward test + cross-asset generalization.
 *
 * The D5 synthesis carried ONE lead (D5-08 exchange reserve-depletion / netflow trend, BTC). The
 * grid-best config (smooth=7,zwin=365,thr=0.5,longflat) passes everything EXCEPT (1) Deflated Sharpe
 * at honest N=54 (its strength lives in a grid-selected config) and (2) generalization to ETH.
 *
 * This script does the honest, decisive follow-up:
 *   (1) PRE-REGISTER one config from FIRST PRINCIPLES (mechanism, not backtest Sharpe). Locked here
 *       BEFORE any return is inspected. Justification is in PREREG below. This collapses honest N->1,
 *       so the Deflated-Sharpe penalty is computed at N=1 (the registered single bet) — the binding
 *       gate is removed IF the *pre-registered* (not grid-best) config holds.
 *   (2) FORWARD consume-once test of that single config on the held-out tail (last 20% of the BTC
 *       netflow span, never used for selection). Report net Sharpe, monthly %/$ @ $10k/$100k,
 *       DSR@N=1, Harvey-Liu adjP, block-bootstrap CI, surrogate p (time-series phase-randomization,
 *       crossSectional:false).
 *   (3) GENERALIZATION: run the SAME pre-registered config (no per-asset tuning) on every asset with
 *       free Coin Metrics exchange-flow coverage. The free community catalog exposes FlowInExNtv at
 *       1d for EXACTLY {btc, eth} (verified via /v4/catalog/asset-metrics) — so the cross-asset
 *       universe is BTC + ETH. Per-asset net Sharpe + a pooled cross-asset test.
 *   (4) MECHANISM: orthogonalize netflow-Z vs recent returns, re-test, confirm surrogate still passes
 *       after orthogonalization (real flow info, not a price echo).
 *
 * Cost 4 bps/side on every position change. Features LAGged >= 1 day. Next-day return. All gates from
 * src/lib/training/statistical-validation.ts via scripts/edgehunt-D5/harness.ts::runGauntlet.
 */
import fs from "node:fs";
import {
  loadPanel,
  runGauntlet,
  runPositions,
  ema,
  rollingZ,
  mkRng,
  sharpeDaily,
  annSharpe,
  mean,
  std,
  COST_PER_SIDE,
  type Panel,
  type GauntletOutput,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const OUT = "output/edgehunt-D5-followup";
const LAG = 1;
const NSURR = 500;

// ============================================================================
// PRE-REGISTERED CONFIG — locked from MECHANISM before any return is inspected.
// ----------------------------------------------------------------------------
// Mechanism: sustained net OUTFLOW of coins from exchanges = coins leaving trading venues for cold
// storage / self-custody = reduced sell-side liquidity / accumulation regime = bullish next-day.
// Signal = rolling-Z of EMA-smoothed netflow (FlowIn - FlowOut). Strong negative Z (net outflow) ->
// LONG; otherwise FLAT.
//   smooth=14 : a fortnight EMA. Long enough to wash out daily settlement / withdrawal-batch noise
//               and exchange-internal wallet reshuffles; short enough to track a genuine multi-week
//               accumulation/distribution regime. The canonical fortnight window.
//   zwin=365  : a 1-year trailing baseline. Native netflow scale grows with adoption, so the Z must
//               reference a RECENT annual regime (full seasonal cycle, no quarter bias), not all
//               history. Strictly causal/trailing.
//   thr=1.0   : a 1-sigma band = the standard "meaningfully beyond normal" threshold. NOT the
//               snooped 0.5 of the grid-best.
//   side=longflat : the mechanism only supports a BULLISH read of outflows. The short-on-inflow leg
//               is a much weaker claim (inflows are routinely rebalancing/derivatives margin), so the
//               defensible directional bet is long-on-outflow, flat otherwise.
//   lag=1     : on-chain features lagged >=1 day (revision/flash-status safe).
// This choice is justified on mechanism, NOT on backtest Sharpe. It is locked.
const PREREG = { smooth: 14, zwin: 365, thr: 1.0, side: "longflat" } as const;
// Secondary reference only (the prior D5 "canonical" used zwin=180). Reported for transparency about
// the one remaining degree of freedom; NOT the pre-registered bet.
const PRIOR_CANON = { smooth: 14, zwin: 180, thr: 1.0, side: "longflat" } as const;

// ---------------------------------------------------------------- signal builders
function lagArr(x: number[], k: number): number[] {
  const o = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) o[i] = x[i - k];
  return o;
}
function netflowRaw(P: Panel): number[] {
  const fin = lagArr(P.flowInNtv, LAG);
  const fout = lagArr(P.flowOutNtv, LAG);
  return P.price.map((_, t) =>
    Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN,
  );
}
// raw netflow-Z
function netZ(P: Panel, smooth: number, zwin: number): number[] {
  return rollingZ(ema(netflowRaw(P), smooth), zwin);
}
// price-ORTHOGONALIZED netflow-Z: residualize EMA-smoothed netflow on trailing return via causal
// expanding OLS, then z-score the residual. Removes the price-coupled component of the flow.
function netZorthog(P: Panel, smooth: number, zwin: number): number[] {
  const sm = ema(netflowRaw(P), smooth);
  // trailing (already-realized, causal) return the flow is residualized against
  const retL = P.price.map((_, t) =>
    t > LAG && P.price[t - LAG] > 0 ? Math.log(P.price[t - LAG] / P.price[t - LAG - 1]) : NaN,
  );
  const res = new Array(P.price.length).fill(NaN);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < P.price.length; t++) {
    if (n >= 200 && Number.isFinite(sm[t]) && Number.isFinite(retL[t])) {
      const den = n * sxx - sx * sx;
      if (Math.abs(den) > 1e-9) {
        const b = (n * sxy - sx * sy) / den;
        const a = (sy - b * sx) / n;
        res[t] = sm[t] - (a + b * retL[t]);
      }
    }
    if (Number.isFinite(sm[t]) && Number.isFinite(retL[t])) {
      n++; sx += retL[t]; sy += sm[t]; sxx += retL[t] * retL[t]; sxy += retL[t] * sm[t];
    }
  }
  return rollingZ(res, zwin);
}
function posFromZ(P: Panel, z: number[], thr: number, side: string): number[] {
  const p = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    if (z[t] <= -thr) p[t] = 1;
    else if (z[t] >= thr) p[t] = side === "longshort" ? -1 : 0;
    else p[t] = 0;
  }
  return p;
}

// ---------------------------------------------------------------- stats helpers
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const ncdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function zSh(r: number[]) {
  const s = summarizeReturnSeries(r);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const d = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / d;
}
// surrogate p (time-series phase-randomization of the Z signal, crossSectional:false) on a window
function surrogateP(
  P: Panel, buildZ: () => number[], thr: number, side: string,
  start: number, end: number, realNet: number, seed0: number,
): { p: number; surrMean: number; surr95: number } {
  const z = buildZ();
  const surr: number[] = [];
  for (let i = 0; i < NSURR; i++) {
    const rng = mkRng(seed0 + i * 7919);
    const sp = posFromZ(P, phaseRandomize(z, rng), thr, side);
    surr.push(annSharpe(sharpeDaily(runPositions(P, sp, start, end).dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const p = (surr.filter((s) => s >= realNet).length + 1) / (NSURR + 1);
  return { p, surrMean: mean(surr), surr95: surr[Math.floor(NSURR * 0.95)] };
}

// full per-asset evaluation of ONE locked config over [start,end)
function evalConfig(
  P: Panel, label: string, buildZ: () => number[], cfg: typeof PREREG,
  start: number, end: number, seed0: number,
) {
  const z = buildZ();
  const pos = posFromZ(P, z, cfg.thr, cfg.side);
  const r = runPositions(P, pos, start, end);
  const netSh = annSharpe(sharpeDaily(r.dailyNet));
  const grossSh = annSharpe(sharpeDaily(r.dailyGross));
  const meanDaily = mean(r.dailyNet);
  const dsr1 = computeDeflatedSharpeRatio(r.dailyNet, { trialCount: 1 });
  const psrP = 1 - ncdf(zSh(r.dailyNet));
  const hlAdjP = Math.min(1, psrP * 1); // Harvey-Liu Bonferroni at N=1 -> = psrP
  const bb = blockBootstrapConfidenceInterval(r.dailyNet, {
    statistic: "mean", iterations: 4000, blockLength: 20, confidenceLevel: 0.95, seed: `${label}-bb`,
  });
  const sur = surrogateP(P, buildZ, cfg.thr, cfg.side, start, end, netSh, seed0);
  // conditional Sharpe on signal-ON days
  const on: number[] = [];
  for (let t = start; t < end; t++)
    if (Number.isFinite(pos[t]) && Math.abs(pos[t]) > 0 && Number.isFinite(P.fwdRet[t])) on.push(pos[t] * P.fwdRet[t]);
  const condSh = annSharpe(sharpeDaily(on));
  return {
    label,
    netSharpeAnn: netSh,
    grossSharpeAnn: grossSh,
    meanDailyNet: meanDaily,
    monthlyAt10k: meanDaily * 30 * 10000,
    monthlyAt100k: meanDaily * 30 * 100000,
    monthlyPct: meanDaily * 30 * 100,
    exposure: r.exposure,
    turnover: r.turnover,
    longShare: r.longShare,
    nDays: r.nDays,
    signalOnShare: r.nDays ? on.length / r.nDays : 0,
    conditionalSharpeAnn: condSh,
    dsrAtN1: dsr1.deflatedProbability,
    dsrAtN1_pass: dsr1.deflatedProbability > 0.95,
    harveyLiuAdjP: hlAdjP,
    harveyLiu_pass: hlAdjP < 0.05,
    blockBootstrapCI95: [bb.lower, bb.upper] as [number, number],
    bb_pass: bb.lower > 0,
    surrogateP: sur.p,
    surrogate_pass: sur.p < 0.05,
    surrMean: sur.surrMean,
    surr95: sur.surr95,
  };
}

// index windows: warmup startIdx, last 20% = consume-once forward holdout
function windows(P: Panel, startIdx: number, holdoutFrac = 0.2) {
  const T = P.price.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));
  return { startIdx, splitIdx, tradableEnd };
}

// ============================================================================
const result: Record<string, unknown> = {
  preregistered_config: PREREG,
  prior_canonical_reference_only: PRIOR_CANON,
  mechanism:
    "Sustained net exchange OUTFLOW (FlowIn-FlowOut << 0) = coins to cold storage / reduced sell-side liquidity = bullish next-day. Z of EMA(14) netflow vs 365d trailing baseline; z<=-1 -> long, else flat. Lag>=1d, next-day return, 4bps/side.",
  free_flow_universe: "Coin Metrics community catalog (/v4/catalog/asset-metrics?metrics=FlowInExNtv) exposes 1d FlowInExNtv for EXACTLY {btc, eth}. Cross-asset universe is BTC + ETH.",
};

// ----- BTC: pre-registered config, split into in-sample (pre-holdout) + forward consume-once -----
const BTC = loadPanel("btc");
const bw = windows(BTC, 700);
console.log(`\n### BTC pre-registered single config ${JSON.stringify(PREREG)}`);
console.log(`windows: startIdx=${bw.startIdx} splitIdx=${bw.splitIdx} tradableEnd=${bw.tradableEnd} (holdout=last20%)`);
console.log(`in-sample dates ${BTC.dates[bw.startIdx]}..${BTC.dates[bw.splitIdx - 1]} | FORWARD holdout ${BTC.dates[bw.splitIdx]}..${BTC.dates[bw.tradableEnd - 1]}`);

const btcInSample = evalConfig(BTC, "BTC-prereg-inSample", () => netZ(BTC, PREREG.smooth, PREREG.zwin), PREREG, bw.startIdx, bw.splitIdx, 21000);
const btcForward = evalConfig(BTC, "BTC-prereg-FORWARD", () => netZ(BTC, PREREG.smooth, PREREG.zwin), PREREG, bw.splitIdx, bw.tradableEnd, 22000);
const btcFull = evalConfig(BTC, "BTC-prereg-FULL", () => netZ(BTC, PREREG.smooth, PREREG.zwin), PREREG, bw.startIdx, bw.tradableEnd, 23000);
result.btc = { inSample: btcInSample, forwardHoldout: btcForward, fullSpan: btcFull };

// prior-canonical (zwin=180) reference, full span, for transparency
const btcPriorFull = evalConfig(BTC, "BTC-priorCanon-FULL", () => netZ(BTC, PRIOR_CANON.smooth, PRIOR_CANON.zwin), PRIOR_CANON as any, bw.startIdx, bw.tradableEnd, 24000);
result.btc_priorCanonical_fullSpan = btcPriorFull;

// ----- MECHANISM: price-orthogonalized pre-registered config on BTC (full span + forward) -----
console.log(`\n### BTC price-ORTHOGONALIZED pre-registered config`);
const btcOrthFull = evalConfig(BTC, "BTC-prereg-ORTHOG-FULL", () => netZorthog(BTC, PREREG.smooth, PREREG.zwin), PREREG, bw.startIdx, bw.tradableEnd, 25000);
const btcOrthForward = evalConfig(BTC, "BTC-prereg-ORTHOG-FORWARD", () => netZorthog(BTC, PREREG.smooth, PREREG.zwin), PREREG, bw.splitIdx, bw.tradableEnd, 26000);
result.btc_orthogonalized = { fullSpan: btcOrthFull, forwardHoldout: btcOrthForward };

// ----- GENERALIZATION: SAME pre-registered config on ETH (no per-asset tuning) -----
const ETH = loadPanel("eth");
const ew = windows(ETH, 700);
console.log(`\n### ETH SAME pre-registered config (no tuning)`);
console.log(`windows: startIdx=${ew.startIdx} splitIdx=${ew.splitIdx} tradableEnd=${ew.tradableEnd}`);
const ethForward = evalConfig(ETH, "ETH-prereg-FORWARD", () => netZ(ETH, PREREG.smooth, PREREG.zwin), PREREG, ew.splitIdx, ew.tradableEnd, 31000);
const ethFull = evalConfig(ETH, "ETH-prereg-FULL", () => netZ(ETH, PREREG.smooth, PREREG.zwin), PREREG, ew.startIdx, ew.tradableEnd, 32000);
const ethOrthFull = evalConfig(ETH, "ETH-prereg-ORTHOG-FULL", () => netZorthog(ETH, PREREG.smooth, PREREG.zwin), PREREG, ew.startIdx, ew.tradableEnd, 33000);
result.eth = { forwardHoldout: ethForward, fullSpan: ethFull, orthogonalizedFull: ethOrthFull };

// ETH exposure-matched random-lottery p (matched-exposure null) on full span and forward
function randomLotteryP(P: Panel, exposure: number, realNet: number, start: number, end: number, seed0: number): number {
  const rl: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const rng = mkRng(seed0 + i * 2654435761);
    const rp = new Array(P.price.length).fill(0);
    for (let t = start; t < end; t++) rp[t] = rng() < exposure ? 1 : 0;
    rl.push(annSharpe(sharpeDaily(runPositions(P, rp, start, end).dailyNet)));
  }
  rl.sort((a, b) => a - b);
  return (rl.filter((s) => s >= realNet).length + 1) / (rl.length + 1);
}
const ethRlFull = randomLotteryP(ETH, ethFull.exposure, ethFull.netSharpeAnn, ew.startIdx, ew.tradableEnd, 41000);
const ethRlForward = randomLotteryP(ETH, ethForward.exposure, ethForward.netSharpeAnn, ew.splitIdx, ew.tradableEnd, 42000);
(result.eth as any).randomLotteryP_fullSpan = ethRlFull;
(result.eth as any).randomLotteryP_forward = ethRlForward;

// ----- POOLED cross-asset test: stack BTC+ETH forward-holdout daily nets, single Sharpe + DSR@N=1 -----
console.log(`\n### POOLED cross-asset (BTC+ETH) forward-holdout`);
function dailyNetSeries(P: Panel, buildZ: () => number[], cfg: typeof PREREG, start: number, end: number): number[] {
  return runPositions(P, posFromZ(P, buildZ(), cfg.thr, cfg.side), start, end).dailyNet;
}
const btcFwdNet = dailyNetSeries(BTC, () => netZ(BTC, PREREG.smooth, PREREG.zwin), PREREG, bw.splitIdx, bw.tradableEnd);
const ethFwdNet = dailyNetSeries(ETH, () => netZ(ETH, PREREG.smooth, PREREG.zwin), PREREG, ew.splitIdx, ew.tradableEnd);
const pooledFwd = [...btcFwdNet, ...ethFwdNet];
const pooledFwdSh = annSharpe(sharpeDaily(pooledFwd));
const pooledFwdDsr = computeDeflatedSharpeRatio(pooledFwd, { trialCount: 1 });
const pooledFwdBB = blockBootstrapConfidenceInterval(pooledFwd, { statistic: "mean", iterations: 4000, blockLength: 20, confidenceLevel: 0.95, seed: "pooled-fwd-bb" });
// full-span pooled too
const btcFullNet = dailyNetSeries(BTC, () => netZ(BTC, PREREG.smooth, PREREG.zwin), PREREG, bw.startIdx, bw.tradableEnd);
const ethFullNet = dailyNetSeries(ETH, () => netZ(ETH, PREREG.smooth, PREREG.zwin), PREREG, ew.startIdx, ew.tradableEnd);
const pooledFull = [...btcFullNet, ...ethFullNet];
const pooledFullSh = annSharpe(sharpeDaily(pooledFull));
result.pooled_cross_asset = {
  forwardHoldout: {
    netSharpeAnn: pooledFwdSh,
    dsrAtN1: pooledFwdDsr.deflatedProbability,
    dsrAtN1_pass: pooledFwdDsr.deflatedProbability > 0.95,
    blockBootstrapCI95: [pooledFwdBB.lower, pooledFwdBB.upper],
    bb_pass: pooledFwdBB.lower > 0,
    nDays: pooledFwd.length,
    btcDays: btcFwdNet.length,
    ethDays: ethFwdNet.length,
  },
  fullSpan: { netSharpeAnn: pooledFullSh, nDays: pooledFull.length },
};

// ----- also run the FULL committed gauntlet at honest N=1 (single config) for the audit trail -----
console.log(`\n### Committed runGauntlet at honest N=1 (single pre-registered config), BTC`);
const gauntletN1: GauntletOutput = runGauntlet({
  name: "D5-08 PRE-REGISTERED single config (honest N=1), BTC",
  P: BTC,
  configs: [{ ...PREREG }], // honest N = 1
  canonical: { ...PREREG },
  buildPosition: (cfg) => posFromZ(BTC, netZ(BTC, cfg.smooth as number, cfg.zwin as number), cfg.thr as number, cfg.side as string),
  buildSurrogatePosition: (cfg, rng) => posFromZ(BTC, phaseRandomize(netZ(BTC, cfg.smooth as number, cfg.zwin as number), rng), cfg.thr as number, cfg.side as string),
  startIdx: 700,
  nSurr: NSURR,
});
result.committed_gauntlet_N1_btc = {
  honestN: gauntletN1.honestN,
  verdict: gauntletN1.verdict,
  bindingGate: gauntletN1.bindingGate,
  best: gauntletN1.best,
  gates: gauntletN1.gates,
  surrogateP: gauntletN1.surrogateP,
  holdoutSharpeAnn: gauntletN1.holdoutSharpeAnn,
};

fs.writeFileSync(`${OUT}/preregister_result.json`, JSON.stringify(result, null, 2));

// ---------------------------------------------------------------- console report
function line(o: any, tag: string) {
  console.log(
    `  [${tag}] netSh=${o.netSharpeAnn.toFixed(3)} gross=${o.grossSharpeAnn.toFixed(3)} exp=${o.exposure.toFixed(3)} turn=${o.turnover.toFixed(3)} condSh=${o.conditionalSharpeAnn.toFixed(3)} onShare=${o.signalOnShare.toFixed(2)} nDays=${o.nDays}\n` +
    `        DSR@N=1=${o.dsrAtN1.toFixed(4)}(${o.dsrAtN1_pass ? "PASS" : "FAIL"}) HLadjP=${o.harveyLiuAdjP.toExponential(2)}(${o.harveyLiu_pass ? "PASS" : "FAIL"}) surrP=${o.surrogateP.toFixed(4)}(${o.surrogate_pass ? "PASS" : "FAIL"}) BB95=[${o.blockBootstrapCI95[0].toExponential(2)},${o.blockBootstrapCI95[1].toExponential(2)}](${o.bb_pass ? "PASS" : "FAIL"})\n` +
    `        monthly@$100k=$${Math.round(o.monthlyAt100k)} @$10k=$${Math.round(o.monthlyAt10k)} (${o.monthlyPct.toFixed(3)}%/mo)`,
  );
}
console.log(`\n================ D5-08 PRE-REGISTERED FOLLOW-UP ================`);
console.log(`PRE-REGISTERED CONFIG (locked on mechanism): ${JSON.stringify(PREREG)}`);
console.log(`\n--- BTC ---`);
line(btcInSample, "BTC in-sample (pre-holdout)");
line(btcForward, "BTC FORWARD consume-once (last 20%)");
line(btcFull, "BTC full span");
line(btcPriorFull, "BTC prior-canon zwin=180 (ref only, full)");
console.log(`\n--- BTC price-orthogonalized (mechanism check) ---`);
line(btcOrthFull, "BTC ORTHOG full");
line(btcOrthForward, "BTC ORTHOG forward");
console.log(`\n--- ETH (same config, no tuning) ---`);
line(ethForward, "ETH FORWARD");
line(ethFull, "ETH full");
line(ethOrthFull, "ETH ORTHOG full");
console.log(`  ETH random-lottery p: fullSpan=${ethRlFull.toFixed(3)} forward=${ethRlForward.toFixed(3)} (PASS<0.05)`);
console.log(`\n--- POOLED cross-asset (BTC+ETH) ---`);
console.log(`  forward-holdout: netSh=${pooledFwdSh.toFixed(3)} DSR@N=1=${pooledFwdDsr.deflatedProbability.toFixed(4)}(${pooledFwdDsr.deflatedProbability > 0.95 ? "PASS" : "FAIL"}) BB95=[${pooledFwdBB.lower.toExponential(2)},${pooledFwdBB.upper.toExponential(2)}] nDays=${pooledFwd.length} (btc=${btcFwdNet.length} eth=${ethFwdNet.length})`);
console.log(`  full-span:       netSh=${pooledFullSh.toFixed(3)} nDays=${pooledFull.length}`);
console.log(`\n--- Committed runGauntlet @ honest N=1, BTC ---`);
console.log(`  verdict=${gauntletN1.verdict} binding=${gauntletN1.bindingGate} netSh=${gauntletN1.best.netSharpeAnn.toFixed(3)} surrP=${gauntletN1.surrogateP.toFixed(4)} holdout=${gauntletN1.holdoutSharpeAnn.toFixed(3)}`);
for (const [g, r] of Object.entries(gauntletN1.gates)) console.log(`    [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
console.log(`\nwrote ${OUT}/preregister_result.json`);
