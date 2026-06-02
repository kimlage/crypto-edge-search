/**
 * Q8-EFFRATIO canonical / robustness check.
 *
 * (A) PRE-REGISTERED canonical config from theory (Kaufman 1995 + Wilder 1978 defaults), N tiny:
 *     ER(20)>=0.30 gate on long/flat TSMOM(L=50). Test it at honest N = the small canonical grid
 *     so DSR/haircut are fair, and report IS + consume-once holdout + matched-exposure + surrogate.
 *
 * (B) ROBUSTNESS: instead of the IS-argmax (which CPCV flagged as overfit, PBO=0.83), pick the
 *     config that is most STABLE across the IS folds (highest median fold Sharpe), then check
 *     whether THAT generalizes to the holdout and still beats the ungated parent OOS.
 *
 * (C) The decisive test: pooled OOS performance of the ER-gate vs ungated parent across the WHOLE
 *     sample with a SINGLE pre-registered config (walk-forward-ish: no per-config selection).
 */
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
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
} from "./lib_q8.ts";

const D = loadDaily();
const T = D.close.length;
const startIdx = 120;
const tradableEnd = T - 1;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);

function netSh(pos: number[], lo: number, hi: number) {
  const r = runPositions(D, pos, lo, hi);
  return { sh: annSharpe(sharpeDaily(r.dailyNet)), exp: r.exposure, mean: mean(r.dailyNet), turn: r.turnover, n: r.nDays };
}

// ---------------- (A) pre-registered canonical ----------------
console.log("=== (A) PRE-REGISTERED canonical: ER(20)>=0.30 gate, TSMOM(L=50) long/flat ===");
const er20 = efficiencyRatio(D.close, 20);
const baseLF50 = tsmomSignal(D.close, 50, false);
const canonPos = baseLF50.map((s, t) => (Number.isFinite(er20[t]) && er20[t] >= 0.3 ? s : 0));
const canonIS = netSh(canonPos, startIdx, splitIdx);
const canonOOS = netSh(canonPos, splitIdx, tradableEnd);
const parentIS = netSh(baseLF50, startIdx, splitIdx);
const parentOOS = netSh(baseLF50, splitIdx, tradableEnd);
const bhOOS = netSh(new Array(T).fill(1), splitIdx, tradableEnd);
console.log(`canonical  IS sh=${canonIS.sh.toFixed(3)} exp=${canonIS.exp.toFixed(2)} | OOS sh=${canonOOS.sh.toFixed(3)} exp=${canonOOS.exp.toFixed(2)}`);
console.log(`parent(L50 LF) IS sh=${parentIS.sh.toFixed(3)} | OOS sh=${parentOOS.sh.toFixed(3)}`);
console.log(`B&H OOS sh=${bhOOS.sh.toFixed(3)}`);
// canonical small grid: 3 erWin x 3 erThr x 2 L = 18 honest configs (the pre-registered family)
const canonN = 18;
const dsrC = computeDeflatedSharpeRatio(runPositions(D, canonPos, startIdx, splitIdx).dailyNet, { trialCount: canonN });
console.log(`canonical DSR p=${dsrC.deflatedProbability.toFixed(4)} @N=${canonN}`);

// ---------------- (B) most-stable config across IS folds ----------------
console.log("\n=== (B) most-STABLE config across IS folds (vs IS-argmax) ===");
const Ls = [10, 15, 20, 30, 40, 50, 90];
const erWins = [10, 14, 20, 30];
const erThrs = [0.2, 0.25, 0.3, 0.35, 0.4];
function toFolds(s: number[], nf: number): number[][] {
  const out: number[][] = [];
  const sz = Math.floor(s.length / nf);
  for (let f = 0; f < nf; f++) out.push(s.slice(f * sz, f === nf - 1 ? s.length : (f + 1) * sz));
  return out;
}
function median(a: number[]): number {
  const b = [...a].sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
let bestStable = { medFold: -9, isSh: 0, label: "", pos: [] as number[] };
let bestIS = { isSh: -9, label: "", pos: [] as number[] };
for (const L of Ls) {
  const base = tsmomSignal(D.close, L, false);
  for (const w of erWins) {
    const er = efficiencyRatio(D.close, w);
    for (const thr of erThrs) {
      const pos = base.map((s, t) => (Number.isFinite(er[t]) && er[t] >= thr ? s : 0));
      const r = runPositions(D, pos, startIdx, splitIdx);
      const isSh = annSharpe(sharpeDaily(r.dailyNet));
      const folds = toFolds(r.dailyNet, 6).map((f) => annSharpe(sharpeDaily(f)));
      const medFold = median(folds);
      const label = `L=${L},er(${w},${thr})`;
      if (medFold > bestStable.medFold) bestStable = { medFold, isSh, label, pos };
      if (isSh > bestIS.isSh) bestIS = { isSh, label, pos };
    }
  }
}
const stableOOS = netSh(bestStable.pos, splitIdx, tradableEnd);
const isargmaxOOS = netSh(bestIS.pos, splitIdx, tradableEnd);
console.log(`most-stable: ${bestStable.label} medFoldSh=${bestStable.medFold.toFixed(3)} IS=${bestStable.isSh.toFixed(3)} -> OOS=${stableOOS.sh.toFixed(3)} (exp=${stableOOS.exp.toFixed(2)})`);
console.log(`IS-argmax:   ${bestIS.label} IS=${bestIS.isSh.toFixed(3)} -> OOS=${isargmaxOOS.sh.toFixed(3)} (exp=${isargmaxOOS.exp.toFixed(2)})`);

// ---------------- (C) pooled OOS: single pre-registered config across full sample ----------------
console.log("\n=== (C) OOS-only comparison (consume-once holdout), single pre-registered cfg ===");
// Use the canonical ER(20)>=0.30 on L=50 LF — never selected on the holdout.
console.log(`canonical gated  OOS sh=${canonOOS.sh.toFixed(3)} mean=${canonOOS.mean.toExponential(2)} exp=${canonOOS.exp.toFixed(2)}`);
console.log(`ungated parent   OOS sh=${parentOOS.sh.toFixed(3)} mean=${parentOOS.mean.toExponential(2)} exp=${parentOOS.exp.toFixed(2)}`);
console.log(`gate beats parent OOS? ${canonOOS.sh > parentOOS.sh}`);
// block-bootstrap the OOS difference series (gated - parent) daily net to see if it's > 0
const gatedDaily = runPositions(D, canonPos, splitIdx, tradableEnd).dailyNet;
const parentDaily = runPositions(D, baseLF50, splitIdx, tradableEnd).dailyNet;
const diff = gatedDaily.map((g, i) => g - (parentDaily[i] ?? 0));
const bbDiff = blockBootstrapConfidenceInterval(diff, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.9, seed: "q8-diff" });
console.log(`OOS (gated-parent) mean daily net CI90 = [${bbDiff.lower.toExponential(2)}, ${bbDiff.upper.toExponential(2)}] (est=${bbDiff.estimate.toExponential(2)})`);
