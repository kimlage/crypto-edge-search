import { computeDeflatedSharpeRatio, estimateCscvPbo, blockBootstrapConfidenceInterval, summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
const r = Array.from({length: 500}, (_,i)=> Math.sin(i)*0.001 + 0.0002);
console.log("DSR prob:", computeDeflatedSharpeRatio(r, {trialCount: 10}).deflatedProbability.toFixed(4));
console.log("summ sharpe:", summarizeReturnSeries(r).sharpe.toFixed(4));
const bb = blockBootstrapConfidenceInterval(r, {statistic:"mean", iterations: 500, blockLength: 10});
console.log("bb lower/upper:", bb.lower.toExponential(2), bb.upper.toExponential(2));
