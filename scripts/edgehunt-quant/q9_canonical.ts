// Q9-LOWVOL canonical pre-registered test (N=1, no search).
// The textbook cross-sectional low-vol anomaly: 30d trailing realized vol,
// beta-neutral, dollar-neutral, weekly rebalance, terciles (frac=0.3).
// This is the spec one would PRE-REGISTER from the literature (Blitz/Frazzini-Pedersen
// BAB) BEFORE any search. DSR & haircut at N=1 are the honest multiple-testing context
// for a pre-specified hypothesis.
import {
  loadPanel,
  marketReturn,
  buildWeights,
  runWeights,
  sharpeAnn,
  mean,
  mkRng,
  Config,
} from "./q9_lowvol_lib";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const P = loadPanel();
const mkt = marketReturn(P);
const T = P.dates.length;
const startIdx = 90;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * 0.8);

// PRE-REGISTERED canonical config (N=1)
const canon: Config = {
  volWin: 30,
  betaWin: 60,
  holdDays: 7,
  frac: 0.3,
  betaNeutral: true,
  gross: 1,
};

const Wis = buildWeights(P, canon, mkt, startIdx, splitIdx);
const ris = runWeights(P, Wis, mkt, startIdx, splitIdx, canon);
const isSh = sharpeAnn(ris.dailyNet);

// DSR at N=1 (no search) and N=96 (full-search honest context)
const dsr1 = computeDeflatedSharpeRatio(ris.dailyNet, { trialCount: 1 });
const dsr96 = computeDeflatedSharpeRatio(ris.dailyNet, { trialCount: 96 });

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
const psrP = 1 - normalCdf(zSharpe(ris.dailyNet));

const bb = blockBootstrapConfidenceInterval(ris.dailyNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 20,
  confidenceLevel: 0.95,
  seed: "q9-canon-bb",
});

// cross-sectional shuffle null on the canonical config
function shuffleNullSharpe(seed: number, W: (number[] | null)[]): number {
  const rng = mkRng(seed);
  const N = P.symbols.length;
  const dailyNet: number[] = [];
  let prevW: number[] | null = null;
  let perm: number[] = Array.from({ length: N }, (_, i) => i);
  for (let t = startIdx; t < splitIdx; t++) {
    const w = W[t];
    if (!w) continue;
    const changed = !prevW || w.some((v, i) => Math.abs(v - prevW![i]) > 1e-12);
    if (changed) {
      perm = Array.from({ length: N }, (_, i) => i);
      for (let j = N - 1; j > 0; j--) {
        const m = Math.floor(rng() * (j + 1));
        [perm[j], perm[m]] = [perm[m], perm[j]];
      }
    }
    const eff = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      if (w[i] === 0) continue;
      const j = perm[i];
      if (Number.isFinite(P.ret[t][j])) eff[j] = w[i];
    }
    let s = 0;
    for (let i = 0; i < N; i++) s += Math.abs(eff[i]);
    if (s < 1e-12) {
      dailyNet.push(0);
      prevW = w;
      continue;
    }
    const sc = canon.gross / s;
    let g = 0;
    for (let i = 0; i < N; i++) if (eff[i] !== 0) g += eff[i] * sc * P.ret[t][i];
    dailyNet.push(g);
    prevW = w;
  }
  const amortCost = (ris.turnoverPerRebal * 0.0004) / Math.max(1, canon.holdDays);
  for (let i = 0; i < dailyNet.length; i++) dailyNet[i] -= amortCost;
  return sharpeAnn(dailyNet);
}
const nSurr = 500;
const surr: number[] = [];
for (let i = 0; i < nSurr; i++) surr.push(shuffleNullSharpe(31000 + i * 7919, Wis));
surr.sort((a, b) => a - b);
const surrP = (surr.filter((s) => s >= isSh).length + 1) / (nSurr + 1);

console.log("=== Q9-LOWVOL CANONICAL (N=1 pre-registered) ===");
console.log(`config: ${JSON.stringify(canon)}`);
console.log(`IS netSharpeAnn=${isSh.toFixed(3)} bookBeta=${ris.avgNetBeta.toFixed(3)} turn/rebal=${ris.turnoverPerRebal.toFixed(2)} nDays=${ris.dailyNet.length}`);
console.log(`DSR@N=1 p=${dsr1.deflatedProbability.toFixed(4)} (pass=${dsr1.deflatedProbability > 0.95})`);
console.log(`DSR@N=96 p=${dsr96.deflatedProbability.toFixed(4)} (pass=${dsr96.deflatedProbability > 0.95})`);
console.log(`Harvey-Liu adjP@N=1=${Math.min(1, psrP).toExponential(3)} (pass=${psrP < 0.05})`);
console.log(`Harvey-Liu adjP@N=96=${Math.min(1, psrP * 96).toExponential(3)} (pass=${psrP * 96 < 0.05})`);
console.log(`block-bootstrap meanDailyNet CI95 lower=${bb.lower.toExponential(3)} (pass=${bb.lower > 0})`);
console.log(`XS-shuffle null: real=${isSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr*0.95)].toFixed(3)} p=${surrP.toFixed(4)} (pass=${surrP<0.05})`);
