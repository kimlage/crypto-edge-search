/**
 * D5-08 DEEPEN — BTC exchange reserve-depletion / netflow lead.
 *
 * $0 cross-asset flow data is EXHAUSTED (free Coin Metrics community exposes 1d FlowIn/FlowOut for
 * EXACTLY {btc, eth}, and ETH inverts). So we deepen on BTC ROBUSTNESS + HONESTY without re-inflating
 * the honest N. The pre-registered single config (locked in the prior follow-up) is fixed:
 *
 *     PREREG = smooth=14 (EMA fortnight), zwin=365 (annual trailing baseline), thr=1.0, side=long/flat
 *
 * Four deepening axes (NONE of which re-tunes to find a winner; honest N stays 1):
 *   (a) ROLLING DSR@N=1 STABILITY across non-overlapping sub-periods — is the forward edge persistent
 *       or a single-window fluke? Report per-sub-period net Sharpe + DSR@N=1 + sign + monthly%.
 *   (b) DEFINITIONAL-PERTURBATION ROBUSTNESS — does the SAME pre-registered edge survive *reasonable
 *       definitional perturbation* (gross outflow vs net; EMA spans 10/14/21; z windows 270/365/540)?
 *       Reported as a robustness CLOUD around the locked point, NOT as a selection grid: we report the
 *       distribution (how many stay net-positive, how many keep surrogate p<0.05). The pre-registered
 *       point remains the only *bet* (N=1); perturbations are sensitivity bars, not new candidates.
 *   (c) PROPER PAPER-FORWARD SIM on BTC — realistic execution: signal decided at the Coin-Metrics
 *       daily close of day t (flow lagged >=1d), filled at the Binance 00:00-UTC OPEN of day t+1
 *       (next-open fill), marked open->open, 4 bps taker each side on position change, plus 8h
 *       perpetual FUNDING debited on the long leg pro-rata to exposure. Over the funded window
 *       (2023-06-01 -> 2026-05-18) which is essentially the held-out forward tail.
 *   (d) BTC-vs-ETH DIVERGENCE — quantify (IC, sign-stability, flow-coverage proxy, sub-period IC) and
 *       state the most likely cause: reflexive narrative vs data-coverage vs fluke.
 *
 * Gate primitives imported directly from src/lib/training/statistical-validation.ts; signal/backtest
 * reuse scripts/edgehunt-D5/harness.ts (4 bps/side, next-day return, causal lag>=1).
 */
import fs from "node:fs";
import {
  loadPanel,
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
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-deepen`;
const LAG = 1;
const NSURR = 500;
const ANN = Math.sqrt(365);

// ---- PRE-REGISTERED single config (locked in prior follow-up; the ONLY bet, honest N = 1) ----
const PREREG = { smooth: 14, zwin: 365, thr: 1.0, side: "longflat" } as const;

// ---------------------------------------------------------------- signal builders (reuse prior defs)
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
// GROSS-OUTFLOW variant: use -FlowOut only (ignore inflow). Mechanism = withdrawals to cold storage.
function grossOutRaw(P: Panel): number[] {
  const fout = lagArr(P.flowOutNtv, LAG);
  // sign so that "more outflow" -> more negative -> same long-on-very-negative convention as netflow
  return P.price.map((_, t) => (Number.isFinite(fout[t]) ? -fout[t] : NaN));
}
function netZ(P: Panel, smooth: number, zwin: number): number[] {
  return rollingZ(ema(netflowRaw(P), smooth), zwin);
}
function grossOutZ(P: Panel, smooth: number, zwin: number): number[] {
  return rollingZ(ema(grossOutRaw(P), smooth), zwin);
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
function surrogateP(P: Panel, buildZ: () => number[], thr: number, side: string, start: number, end: number, realNet: number, seed0: number): number {
  const z = buildZ();
  const surr: number[] = [];
  for (let i = 0; i < NSURR; i++) {
    const rng = mkRng(seed0 + i * 7919);
    const sp = posFromZ(P, phaseRandomize(z, rng), thr, side);
    surr.push(annSharpe(sharpeDaily(runPositions(P, sp, start, end).dailyNet)));
  }
  return (surr.filter((s) => s >= realNet).length + 1) / (NSURR + 1);
}
function corr(a: number[], b: number[]): number {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { x.push(a[i]); y.push(b[i]); }
  const mx = mean(x), my = mean(y);
  let n = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); d1 += (x[i] - mx) ** 2; d2 += (y[i] - my) ** 2; }
  return d1 > 0 && d2 > 0 ? n / Math.sqrt(d1 * d2) : NaN;
}

const result: Record<string, unknown> = {
  preregistered_config: PREREG,
  note: "Honest N stays 1. Perturbations are sensitivity bars around the locked point, not a selection grid. Cross-asset $0 data exhausted (free CM = btc+eth only).",
};

const BTC = loadPanel("btc");
const T = BTC.price.length;
const startIdx = 700;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * 0.8); // last 20% = consume-once forward (as in prior)

// pre-registered position on BTC, full
const preZ = netZ(BTC, PREREG.smooth, PREREG.zwin);
const prePos = posFromZ(BTC, preZ, PREREG.thr, PREREG.side);

// ============================================================================
// (a) ROLLING DSR@N=1 STABILITY across NON-OVERLAPPING calendar sub-periods.
//     Is the forward edge persistent, or a single-window fluke?
// ============================================================================
console.log("\n=== (a) ROLLING DSR@N=1 STABILITY (non-overlapping sub-periods) ===");
// build year-based sub-periods over the tradable span (from first tradable index)
function yearOf(d: string): number { return Number(d.slice(0, 4)); }
const firstYear = yearOf(BTC.dates[startIdx]);
const lastYear = yearOf(BTC.dates[tradableEnd - 1]);
const subPeriods: { label: string; lo: number; hi: number }[] = [];
for (let y = firstYear; y <= lastYear; y++) {
  let lo = -1, hi = -1;
  for (let t = startIdx; t < tradableEnd; t++) {
    if (yearOf(BTC.dates[t]) === y) { if (lo < 0) lo = t; hi = t + 1; }
  }
  if (lo >= 0 && hi - lo >= 60) subPeriods.push({ label: String(y), lo, hi });
}
const rollingByYear = subPeriods.map((sp) => {
  const r = runPositions(BTC, prePos, sp.lo, sp.hi);
  const netSh = annSharpe(sharpeDaily(r.dailyNet));
  const dsr = r.dailyNet.length > 5 ? computeDeflatedSharpeRatio(r.dailyNet, { trialCount: 1 }).deflatedProbability : NaN;
  const md = mean(r.dailyNet);
  return {
    period: sp.label, nDays: r.nDays, exposure: r.exposure,
    netSharpeAnn: netSh, dsrAtN1: dsr, dsrPass: dsr > 0.95,
    sign: netSh > 0 ? "+" : "-", monthlyPct: md * 30 * 100, monthlyAt100k: md * 30 * 100000,
  };
});
const posYears = rollingByYear.filter((x) => x.netSharpeAnn > 0).length;
const dsrPassYears = rollingByYear.filter((x) => x.dsrPass).length;

// ALSO: rolling 365-day window DSR@N=1 (overlapping, step 90d) to see persistence as a path, not just buckets
const rollWin = 365, rollStep = 90;
const rolling365: { startDate: string; endDate: string; netSharpeAnn: number; dsrAtN1: number; sign: string }[] = [];
for (let s = startIdx; s + rollWin <= tradableEnd; s += rollStep) {
  const r = runPositions(BTC, prePos, s, s + rollWin);
  const netSh = annSharpe(sharpeDaily(r.dailyNet));
  const dsr = r.dailyNet.length > 5 ? computeDeflatedSharpeRatio(r.dailyNet, { trialCount: 1 }).deflatedProbability : NaN;
  rolling365.push({ startDate: BTC.dates[s], endDate: BTC.dates[s + rollWin - 1], netSharpeAnn: netSh, dsrAtN1: dsr, sign: netSh > 0 ? "+" : "-" });
}
const roll365Pos = rolling365.filter((x) => x.netSharpeAnn > 0).length;
const roll365Dsr = rolling365.filter((x) => x.dsrAtN1 > 0.95).length;
result.a_rolling_stability = {
  byCalendarYear: rollingByYear,
  positiveYears: posYears, totalYears: rollingByYear.length, dsrPassYears,
  rolling365_step90: rolling365,
  rolling365_positiveWindows: roll365Pos, rolling365_total: rolling365.length, rolling365_dsrPassWindows: roll365Dsr,
};
for (const x of rollingByYear)
  console.log(`  ${x.period}: net=${x.netSharpeAnn.toFixed(3)} dsr@N1=${(x.dsrAtN1 ?? NaN).toFixed(3)} ${x.dsrPass ? "PASS" : "    "} exp=${x.exposure.toFixed(3)} mo%=${x.monthlyPct.toFixed(2)} nDays=${x.nDays}`);
console.log(`  -> ${posYears}/${rollingByYear.length} years net-positive; ${dsrPassYears} years individually DSR@N=1-pass`);
console.log(`  rolling-365d windows (step 90d): ${roll365Pos}/${rolling365.length} positive, ${roll365Dsr} DSR@N=1-pass`);

// ============================================================================
// (b) DEFINITIONAL-PERTURBATION ROBUSTNESS — sensitivity cloud, NOT a grid.
//     Same long-on-very-negative mechanism; perturb the *definitional* choices.
// ============================================================================
console.log("\n=== (b) DEFINITIONAL-PERTURBATION ROBUSTNESS (sensitivity cloud; honest N still 1) ===");
type Perturb = { name: string; build: () => number[] };
const perturbs: Perturb[] = [];
// EMA span perturbations (10/14/21) on net
for (const s of [10, 14, 21]) perturbs.push({ name: `net EMA${s} z365`, build: () => netZ(BTC, s, PREREG.zwin) });
// z window perturbations (270/365/540) on net
for (const zw of [270, 365, 540]) perturbs.push({ name: `net EMA14 z${zw}`, build: () => netZ(BTC, PREREG.smooth, zw) });
// gross-outflow-only variant (def perturbation: drop inflow leg)
perturbs.push({ name: `grossOut EMA14 z365`, build: () => grossOutZ(BTC, PREREG.smooth, PREREG.zwin) });
for (const s of [10, 21]) perturbs.push({ name: `grossOut EMA${s} z365`, build: () => grossOutZ(BTC, s, PREREG.zwin) });
// threshold sensitivity (0.75/1.0/1.25) — only thr, on net (still the same mechanism band)
const thrVariants = [0.75, 1.0, 1.25];

const pertRows: any[] = [];
for (const pt of perturbs) {
  for (const thr of [PREREG.thr]) {
    const z = pt.build();
    const pos = posFromZ(BTC, z, thr, PREREG.side);
    // evaluate on FORWARD holdout (the held-out tail) AND full span
    const fwd = runPositions(BTC, pos, splitIdx, tradableEnd);
    const full = runPositions(BTC, pos, startIdx, tradableEnd);
    const fwdNet = annSharpe(sharpeDaily(fwd.dailyNet));
    const fullNet = annSharpe(sharpeDaily(full.dailyNet));
    const dsrFwd = fwd.dailyNet.length > 5 ? computeDeflatedSharpeRatio(fwd.dailyNet, { trialCount: 1 }).deflatedProbability : NaN;
    const sP = surrogateP(BTC, pt.build, thr, PREREG.side, splitIdx, tradableEnd, fwdNet, 50000 + pertRows.length * 131);
    pertRows.push({
      variant: `${pt.name} thr${thr}`, isPrereg: pt.name === "net EMA14 z365" && thr === PREREG.thr,
      forwardNetSharpe: fwdNet, fullNetSharpe: fullNet, forwardDsrN1: dsrFwd,
      forwardSurrogateP: sP, forwardExposure: fwd.exposure,
    });
  }
}
// threshold-only sweep on the pre-registered net signal (forward)
for (const thr of thrVariants) {
  if (thr === PREREG.thr) continue;
  const pos = posFromZ(BTC, preZ, thr, PREREG.side);
  const fwd = runPositions(BTC, pos, splitIdx, tradableEnd);
  const full = runPositions(BTC, pos, startIdx, tradableEnd);
  const fwdNet = annSharpe(sharpeDaily(fwd.dailyNet));
  const dsrFwd = fwd.dailyNet.length > 5 ? computeDeflatedSharpeRatio(fwd.dailyNet, { trialCount: 1 }).deflatedProbability : NaN;
  const sP = surrogateP(BTC, () => preZ, thr, PREREG.side, splitIdx, tradableEnd, fwdNet, 60000 + Math.round(thr * 100));
  pertRows.push({
    variant: `net EMA14 z365 thr${thr}`, isPrereg: false,
    forwardNetSharpe: fwdNet, fullNetSharpe: annSharpe(sharpeDaily(full.dailyNet)), forwardDsrN1: dsrFwd,
    forwardSurrogateP: sP, forwardExposure: fwd.exposure,
  });
}
const fwdNets = pertRows.map((r) => r.forwardNetSharpe);
const posFrac = pertRows.filter((r) => r.forwardNetSharpe > 0).length / pertRows.length;
const surrPassFrac = pertRows.filter((r) => r.forwardSurrogateP < 0.05).length / pertRows.length;
const dsrPassFrac = pertRows.filter((r) => r.forwardDsrN1 > 0.95).length / pertRows.length;
result.b_perturbation_robustness = {
  variants: pertRows,
  nVariants: pertRows.length,
  forwardNetSharpe_min: Math.min(...fwdNets), forwardNetSharpe_median: [...fwdNets].sort((a, b) => a - b)[Math.floor(fwdNets.length / 2)], forwardNetSharpe_max: Math.max(...fwdNets),
  fractionForwardPositive: posFrac, fractionForwardSurrogatePass: surrPassFrac, fractionForwardDsrPass: dsrPassFrac,
};
for (const r of pertRows)
  console.log(`  ${r.isPrereg ? "*" : " "}${r.variant.padEnd(26)} fwdNet=${r.forwardNetSharpe.toFixed(3)} fullNet=${r.fullNetSharpe.toFixed(3)} fwdDSR=${(r.forwardDsrN1 ?? NaN).toFixed(3)} fwdSurrP=${r.forwardSurrogateP.toFixed(3)} exp=${r.forwardExposure.toFixed(3)}`);
console.log(`  -> ${(posFrac * 100).toFixed(0)}% forward-positive; ${(surrPassFrac * 100).toFixed(0)}% surrogate-pass; ${(dsrPassFrac * 100).toFixed(0)}% DSR@N1-pass; fwdNet[min,med,max]=[${Math.min(...fwdNets).toFixed(2)},${[...fwdNets].sort((a, b) => a - b)[Math.floor(fwdNets.length / 2)].toFixed(2)},${Math.max(...fwdNets).toFixed(2)}]`);

fs.writeFileSync(`${OUT}/deepen_partA_B.json`, JSON.stringify(result, null, 2));
console.log(`\nwrote ${OUT}/deepen_partA_B.json`);
