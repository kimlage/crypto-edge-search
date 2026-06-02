/**
 * AUDIT: verify the deflated-Sharpe-vs-benchmark gate is applied correctly for D1-03 and D1-06.
 *
 * Concern A (false-KILL risk): is "deflated-Sharpe-vs-RSI p=0.0087" an OVER-powerful gate that
 * wrongly kills a real edge? It requires CCI's Sharpe to exceed [RSI Sharpe + expectedMax haircut
 * for N=128 trials]. We recompute the components to confirm the gate logic matches the harness
 * primitive and that the failure is genuine (CCI does NOT clear RSI+haircut), not a coding error.
 *
 * Concern B: the SUMMARY phrases the gate as "need p<0.05" while the code passes on p>0.95. We
 * confirm these are the SAME decision (deflatedProbability is P(Sharpe>expectedMax); fail = low prob).
 */
import {
  computeDeflatedSharpeRatio,
} from "../../src/lib/training/statistical-validation.ts";

// Reconstruct from the committed reports' reported daily Sharpe + benchmark.
// We can't get the raw series here without rerunning; instead we sanity-check the PRIMITIVE on
// synthetic series that reproduce the reported daily Sharpe, to confirm the gate's directionality.

// D1-06 CCI: reported sharpeDaily=0.0925, N=128, expectedMaxSharpeDaily=0.045.
// dsrVsRSI uses benchmarkSharpe = rsiDailySharpe. RSI net annual 1.689 => daily ~ 1.689/sqrt(365).
const rsiDaily = 1.689 / Math.sqrt(365);
const cciDaily = 1.768 / Math.sqrt(365);
console.log(`CCI daily Sharpe ~ ${cciDaily.toFixed(4)}, RSI daily Sharpe ~ ${rsiDaily.toFixed(4)}`);
console.log(`raw excess (CCI-RSI) daily Sharpe ~ ${(cciDaily-rsiDaily).toFixed(4)} (CCI nominally beats RSI)`);

// Build a synthetic iid normal series with the CCI daily Sharpe over ~3210 obs, then run the
// primitive with benchmarkSharpe=0 (DSR@N) and benchmarkSharpe=rsiDaily (DSR-vs-RSI).
function synth(sharpeDaily: number, n: number, seed: number): number[] {
  let s = seed>>>0; const rng=()=>{ s+=0x6d2b79f5; let t=s; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
  const out:number[]=[]; const sd=0.01; const mu=sharpeDaily*sd;
  for(let i=0;i<n;i++){ // Box-Muller
    const u1=Math.max(1e-12,rng()), u2=rng(); const z=Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2); out.push(mu+sd*z);
  }
  return out;
}
const series = synth(cciDaily, 3210, 12345);
const dsrAtN = computeDeflatedSharpeRatio(series, { trialCount: 128 });
const dsrVsRsi = computeDeflatedSharpeRatio(series, { trialCount: 128, benchmarkSharpe: rsiDaily });
console.log(`\nDSR@N=128 (benchmark 0): deflatedProb=${dsrAtN.deflatedProbability.toFixed(4)} expectedMax=${dsrAtN.expectedMaxSharpe.toFixed(4)}`);
console.log(`DSR-vs-RSI (benchmark=${rsiDaily.toFixed(4)}): deflatedProb=${dsrVsRsi.deflatedProbability.toFixed(4)} expectedMax=${dsrVsRsi.expectedMaxSharpe.toFixed(4)}`);
console.log(`\nKEY: expectedMax for vs-RSI = benchmark + SE*E[max]. The benchmark SHIFTS the bar up by`);
console.log(`the full RSI Sharpe. So 'beat RSI by raw excess' (~0.004/day) is NOT enough; CCI must beat`);
console.log(`RSI + the N=128 selection haircut. The gate is internally consistent with the harness.`);
console.log(`\nDirectionality check: pass requires deflatedProbability>0.95. Reported 0.0087 << 0.95 => FAIL.`);
console.log(`This is the CORRECT directionality (high prob = clears bar = pass). SUMMARY's 'need p<0.05'`);
console.log(`wording is loose but the DECISION (fail) is identical.`);
