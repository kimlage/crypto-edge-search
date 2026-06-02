/**
 * Q8-EFFRATIO full committed gauntlet.
 *
 * Strategy: TSMOM (lookback L, long/flat or long/short) gated by a trend-strength meta-gate:
 *   take the TSMOM position only when ER(erWin) >= erThr  OR/AND  ADX(adxWin) >= adxThr,
 *   else flat. Gate modes: er-only, adx-only, er-and-adx, er-or-adx.
 *
 * HONEST N = every (L, short, gateMode, erWin, erThr, adxWin, adxThr) config scored in-sample.
 *
 * Gates (binding order):
 *  1. net_of_cost            best config mean daily net > 0 (4bps/side)
 *  2. beat_ungated_TSMOM     best gated net Sharpe > the BEST ungated TSMOM net Sharpe (matched
 *                            family: same lookback grid, long/flat & long/short) — the parent control
 *  3. beat_BH                best gated net Sharpe > buy&hold net Sharpe
 *  4. matched_exposure       best gated net Sharpe > 95th pct of RANDOM-GATE books with identical
 *                            on-rate applied to the SAME TSMOM signal (the timing control: proves
 *                            the gate's WHEN, not just its reduced exposure, adds value)
 *  5. deflated_sharpe        DSR @ honest N > 0.95
 *  6. block_bootstrap        mean daily net 95% CI lower bound > 0
 *  7. cpcv_pbo               PBO < 0.5
 *  8. haircut                Harvey-Liu Bonferroni adjP < 0.05
 *  9. surrogate              block-circular-shift of the GATE MASK vs returns: placebo p < 0.05
 * 10. holdout                consume-once last 20% OOS net Sharpe > 0  (AND > B&H OOS)
 *
 * SURVIVE requires Q8 to beat ungated TSMOM AND B&H, pass the matched-exposure timing control,
 * and clear the multiple-testing + surrogate + holdout gates.
 */
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";
import {
  loadDaily,
  efficiencyRatio,
  adx,
  tsmomSignal,
  runPositions,
  annSharpe,
  sharpeDaily,
  mean,
  mkRng,
  type Daily,
} from "./lib_q8.ts";

const D = loadDaily();
const T = D.close.length;
const startIdx = 120; // warmup big enough for ADX(30) double-smoothing + ER(40) + TSMOM(120)
const tradableEnd = T - 1;
const HOLDOUT_FRAC = 0.2;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * (1 - HOLDOUT_FRAC));
const NSURR = 500;

// ---------------- precompute indicators -----------------
const Ls = [10, 15, 20, 30, 40, 50, 90, 120];
const erWins = [10, 14, 20, 30, 40];
const erThrs = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
const adxWins = [10, 14, 20, 30];
const adxThrs = [15, 18, 20, 22, 25, 30];

const tsmomLF: Record<number, number[]> = {};
const tsmomLS: Record<number, number[]> = {};
for (const L of Ls) {
  tsmomLF[L] = tsmomSignal(D.close, L, false);
  tsmomLS[L] = tsmomSignal(D.close, L, true);
}
const erCache: Record<number, number[]> = {};
for (const w of erWins) erCache[w] = efficiencyRatio(D.close, w);
const adxCache: Record<number, number[]> = {};
for (const w of adxWins) adxCache[w] = adx(D.high, D.low, D.close, w);

// ---------------- config space (honest N) -----------------
interface Cfg {
  L: number;
  short: boolean;
  mode: "er" | "adx" | "and" | "or";
  erWin: number;
  erThr: number;
  adxWin: number;
  adxThr: number;
}

function gateMask(cfg: Cfg): boolean[] {
  const er = erCache[cfg.erWin];
  const a = adxCache[cfg.adxWin];
  const mask = new Array(T).fill(false);
  for (let t = 0; t < T; t++) {
    const erOn = Number.isFinite(er[t]) && er[t] >= cfg.erThr;
    const adxOn = Number.isFinite(a[t]) && a[t] >= cfg.adxThr;
    let on: boolean;
    if (cfg.mode === "er") on = erOn;
    else if (cfg.mode === "adx") on = adxOn;
    else if (cfg.mode === "and") on = erOn && adxOn;
    else on = erOn || adxOn;
    mask[t] = on;
  }
  return mask;
}

function buildPosition(cfg: Cfg): number[] {
  const base = cfg.short ? tsmomLS[cfg.L] : tsmomLF[cfg.L];
  const mask = gateMask(cfg);
  return base.map((s, t) => (mask[t] && Number.isFinite(s) ? s : 0));
}

const configs: Cfg[] = [];
for (const L of Ls) {
  for (const short of [false, true]) {
    // er-only
    for (const erWin of erWins) for (const erThr of erThrs)
      configs.push({ L, short, mode: "er", erWin, erThr, adxWin: 14, adxThr: 0 });
    // adx-only
    for (const adxWin of adxWins) for (const adxThr of adxThrs)
      configs.push({ L, short, mode: "adx", erWin: 14, erThr: 0, adxWin, adxThr });
    // er-and-adx + er-or-adx (subset of thresholds to keep N honest but realistic)
    for (const erWin of [14, 20]) for (const erThr of [0.25, 0.35])
      for (const adxWin of [14, 20]) for (const adxThr of [20, 25])
        for (const mode of ["and", "or"] as const)
          configs.push({ L, short, mode, erWin, erThr, adxWin, adxThr });
  }
}
const HONEST_N = configs.length;

function cfgLabel(c: Cfg): string {
  return `L=${c.L},${c.short ? "LS" : "LF"},${c.mode},er(${c.erWin},${c.erThr}),adx(${c.adxWin},${c.adxThr})`;
}

// ---------------- score every config in-sample -----------------
const scored = configs.map((cfg) => {
  const pos = buildPosition(cfg);
  const res = runPositions(D, pos, startIdx, splitIdx);
  return { cfg, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestNet = best.res.dailyNet;

// ---------------- baseline: best UNGATED TSMOM (the parent control) -----------------
let bestUngated = { net: -9, label: "" };
for (const L of Ls) {
  for (const short of [false, true]) {
    const sig = short ? tsmomLS[L] : tsmomLF[L];
    const r = runPositions(D, sig, startIdx, splitIdx);
    const s = annSharpe(sharpeDaily(r.dailyNet));
    if (s > bestUngated.net) bestUngated = { net: s, label: `L=${L},${short ? "LS" : "LF"}` };
  }
}

// ---------------- baseline: B&H -----------------
const bh = runPositions(D, new Array(T).fill(1), startIdx, splitIdx);
const bhSh = annSharpe(sharpeDaily(bh.dailyNet));

// ---------------- matched-exposure RANDOM-GATE control -----------------
// Random gate with the SAME on-rate as the best config, applied to the SAME TSMOM signal.
// This isolates the gate's TIMING: if a random gate of equal time-in-market matches the real
// gate, the meta-gate adds no timing alpha (only exposure reduction).
const bestBase = best.cfg.short ? tsmomLS[best.cfg.L] : tsmomLF[best.cfg.L];
const bestMask = gateMask(best.cfg);
let onCount = 0,
  totCount = 0;
for (let t = startIdx; t < splitIdx; t++) {
  if (!Number.isFinite(D.fwdRet[t])) continue;
  totCount++;
  if (bestMask[t]) onCount++;
}
const onRate = totCount ? onCount / totCount : 0;
const rgSh: number[] = [];
for (let i = 0; i < 1000; i++) {
  const rng = mkRng(1234567 + i * 2654435761);
  const pos = bestBase.map((s, t) =>
    Number.isFinite(s) && t >= startIdx && t < splitIdx && rng() < onRate ? s : 0,
  );
  const r = runPositions(D, pos, startIdx, splitIdx);
  rgSh.push(annSharpe(sharpeDaily(r.dailyNet)));
}
rgSh.sort((a, b) => a - b);
const rg95 = rgSh[Math.floor(rgSh.length * 0.95)];
const rgMean = mean(rgSh);

// ---------------- Deflated Sharpe @ honest N -----------------
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });

// ---------------- block bootstrap CI on mean daily net -----------------
const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 20,
  confidenceLevel: 0.95,
  seed: "q8-bb",
});

// ---------------- CSCV / PBO across all configs -----------------
function toFolds(series: number[], nf: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / nf);
  for (let f = 0; f < nf; f++) {
    const lo = f * sz;
    const hi = f === nf - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}
const NFOLDS = 8;
// cap CSCV inputs to top configs by IS for tractability but keep a representative set
const cscvInput = scored.slice(0, Math.min(400, scored.length)).map((s) => ({
  id: cfgLabel(s.cfg),
  folds: toFolds(s.res.dailyNet, NFOLDS),
}));
let pbo = 1,
  medLogit = 0;
try {
  const r = estimateCscvPbo(cscvInput, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = r.pbo;
  medLogit = r.medianLogit;
} catch {
  pbo = 1;
}

// ---------------- Harvey-Liu (Bonferroni) haircut -----------------
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
const psrP = 1 - normalCdf(zSharpe(bestNet));
const adjP = Math.min(1, psrP * HONEST_N);

// ---------------- surrogate null: block-circular-shift of the GATE MASK vs returns -----------------
// Preserves: TSMOM signal, price path, the gate's marginal on-rate AND its autocorrelation
// (block structure). Destroys ONLY the alignment between gate timing and forward returns.
// This is the correct phase-randomization-equivalent for a meta-gate timing claim.
const BLOCK = 20;
function shiftMask(mask: boolean[], shift: number): boolean[] {
  const out = new Array(T).fill(false);
  // circular shift within [startIdx, splitIdx)
  const lo = startIdx,
    hi = splitIdx,
    len = hi - lo;
  for (let t = lo; t < hi; t++) {
    const src = lo + (((t - lo + shift) % len) + len) % len;
    out[t] = mask[src];
  }
  return out;
}
const surr: number[] = [];
{
  const rng = mkRng(909090);
  const lenIS = splitIdx - startIdx;
  for (let i = 0; i < NSURR; i++) {
    // shift by a random multiple of BLOCK to preserve block autocorrelation of the mask
    const nblocks = Math.floor(lenIS / BLOCK);
    const shift = (1 + Math.floor(rng() * (nblocks - 1))) * BLOCK;
    const sm = shiftMask(bestMask, shift);
    const pos = bestBase.map((s, t) => (sm[t] && Number.isFinite(s) ? s : 0));
    const r = runPositions(D, pos, startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
}
surr.sort((a, b) => a - b);
const surrAbove = surr.filter((s) => s >= best.netSh).length;
const surrP = (surrAbove + 1) / (NSURR + 1);

// ---------------- consume-once holdout (best cfg only) -----------------
const holdRes = runPositions(D, best.pos, splitIdx, tradableEnd);
const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
const bhHold = runPositions(D, new Array(T).fill(1), splitIdx, tradableEnd);
const bhHoldSh = annSharpe(sharpeDaily(bhHold.dailyNet));
// ungated parent on holdout (same family best on IS)
const ungatedParts = bestUngated.label.match(/L=(\d+),(LS|LF)/);
let ungatedHoldSh = NaN;
if (ungatedParts) {
  const Lp = Number(ungatedParts[1]);
  const shortP = ungatedParts[2] === "LS";
  const sig = shortP ? tsmomLS[Lp] : tsmomLF[Lp];
  ungatedHoldSh = annSharpe(sharpeDaily(runPositions(D, sig, splitIdx, tradableEnd).dailyNet));
}

// ---------------- assemble gates -----------------
const meanDailyNet = mean(bestNet);
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: {
    pass: meanDailyNet > 0,
    detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turnover=${best.res.turnover.toFixed(3)} exp=${best.res.exposure.toFixed(2)}`,
  },
  beat_ungated_TSMOM: {
    pass: best.netSh > bestUngated.net,
    detail: `gatedNet=${best.netSh.toFixed(3)} vs bestUngated=${bestUngated.net.toFixed(3)} [${bestUngated.label}]`,
  },
  beat_BH: {
    pass: best.netSh > bhSh,
    detail: `gatedNet=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)}`,
  },
  matched_exposure: {
    pass: best.netSh > rg95,
    detail: `gatedNet=${best.netSh.toFixed(3)} vs randGate95=${rg95.toFixed(3)} (mean=${rgMean.toFixed(3)}, onRate=${onRate.toFixed(2)})`,
  },
  deflated_sharpe: {
    pass: dsr.deflatedProbability > 0.95,
    detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}`,
  },
  block_bootstrap: {
    pass: bb.lower > 0,
    detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
  },
  cpcv_pbo: {
    pass: pbo < 0.5,
    detail: `PBO=${pbo.toFixed(3)} medianLogit=${medLogit.toFixed(3)}`,
  },
  haircut: {
    pass: adjP < 0.05,
    detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})`,
  },
  surrogate: {
    pass: surrP < 0.05,
    detail: `placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(NSURR * 0.95)].toFixed(3)}`,
  },
  holdout: {
    pass: holdSh > 0 && holdSh > bhHoldSh,
    detail: `OOS net=${holdSh.toFixed(3)} vs B&H_OOS=${bhHoldSh.toFixed(3)} vs ungatedParent_OOS=${ungatedHoldSh.toFixed(3)} over ${holdRes.nDays} rows`,
  },
};

const order = [
  "net_of_cost",
  "beat_ungated_TSMOM",
  "beat_BH",
  "matched_exposure",
  "deflated_sharpe",
  "block_bootstrap",
  "cpcv_pbo",
  "haircut",
  "surrogate",
  "holdout",
];
let binding = "none";
for (const g of order) {
  if (!gates[g].pass) {
    binding = g;
    break;
  }
}
const allPass = binding === "none";
const coreTiming =
  gates.net_of_cost.pass &&
  gates.beat_ungated_TSMOM.pass &&
  gates.beat_BH.pass &&
  gates.matched_exposure.pass &&
  gates.surrogate.pass &&
  gates.holdout.pass;
let verdict: "SURVIVE" | "PROMISING" | "KILL";
if (allPass) verdict = "SURVIVE";
else if (coreTiming) verdict = "PROMISING";
else verdict = "KILL";

const monthlyAt100k = meanDailyNet * 30 * 100000;

console.log(`\n================ Q8-EFFRATIO ================`);
console.log(`T=${T} span ${D.date[0]}..${D.date[T - 1]}`);
console.log(`startIdx=${startIdx} splitIdx=${splitIdx} (IS rows~${splitIdx - startIdx}, OOS rows~${tradableEnd - splitIdx})`);
console.log(`honestN=${HONEST_N}`);
console.log(`best=${cfgLabel(best.cfg)}`);
console.log(
  `best netSharpeAnn=${best.netSh.toFixed(3)} grossSh=${annSharpe(sharpeDaily(best.res.dailyGross)).toFixed(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(2)} nDays=${best.res.nDays}`,
);
for (const g of order) {
  console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
}
const monthlyStr = allPass ? `$${Math.round(monthlyAt100k)}` : "n/a";
console.log(
  `VERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthlyStr} | holdoutSharpe ${holdSh.toFixed(3)}`,
);
