/**
 * Q7 strengthening attempt #2: the data says momentum pays in STORM, not calm. Test storm-gated
 * TSMOM honestly: does it beat (a) its matched-exposure control, (b) the GARCH surrogate, and
 * (c) survive the holdout? Critically — storm regimes overlap bull/crash episodes, so a vol-timing
 * confound (storm vol > calm vol) could LOWER the Sharpe ratio mechanically. We test whether the
 * CONDITIONAL RETURN alpha survives net-of-cost AND beats matched exposure AND the GARCH null at
 * the honest N of THIS family. We also test the honest combined N (calm+storm = the full search).
 */
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";
import {
  loadDailyBTC,
  realizedVol,
  trailingPctRank,
  tsmomSignal,
  runPositions,
  annSharpe,
  sharpeDaily,
  mean,
  std,
  mkRng,
  fitGarch11,
  simulateGarchCloses,
  barsFromCloses,
  type DailyBars,
} from "./q7_lib.ts";

const ANN = Math.sqrt(365);
const B = loadDailyBTC();
const T = B.close.length;
const START = 400;
const tradableEnd = T - 1;
const span = tradableEnd - START;
const splitIdx = START + Math.floor(span * 0.8);

type Cfg = { L: number; side: "long" | "ls"; volWin: number; rankWin: number; gate: "calm" | "storm"; thresh: number };
function rawPos(B: DailyBars, c: Cfg): number[] {
  const sig = tsmomSignal(B.close, c.L);
  return sig.map((s) => (Number.isFinite(s) ? (c.side === "long" ? (s > 0 ? 1 : 0) : Math.sign(s)) : NaN));
}
function mask(B: DailyBars, c: Cfg): number[] {
  const rv = realizedVol(B.ret, c.volWin);
  const rank = trailingPctRank(rv, c.rankWin);
  return rank.map((r) => (!Number.isFinite(r) ? 0 : c.gate === "calm" ? (r <= c.thresh ? 1 : 0) : r >= c.thresh ? 1 : 0));
}
function gated(B: DailyBars, c: Cfg): number[] {
  const raw = rawPos(B, c), m = mask(B, c);
  return raw.map((p, t) => (Number.isFinite(p) ? p * m[t] : NaN));
}
function matchedExp(B: DailyBars, c: Cfg, lo: number, hi: number, targetExp: number) {
  const base: Cfg = { ...c };
  const raw = rawPos(B, base);
  let u = 0, n = 0;
  for (let t = lo; t < hi; t++) if (Number.isFinite(raw[t])) { u += Math.abs(raw[t]); n++; }
  const ungExp = n ? u / n : 0;
  const keep = ungExp > 0 ? Math.min(1, targetExp / ungExp) : 0;
  const arr: number[] = [];
  for (let i = 0; i < 300; i++) {
    const rng = mkRng(777 + i * 7919);
    const pos = new Array(B.close.length).fill(NaN);
    for (let t = lo; t < hi; t++) { if (!Number.isFinite(raw[t])) continue; pos[t] = rng() < keep ? raw[t] : 0; }
    arr.push(annSharpe(sharpeDaily(runPositions(B, pos, lo, hi).dailyNet)));
  }
  arr.sort((a, b) => a - b);
  return { mean: mean(arr), p95: arr[Math.floor(arr.length * 0.95)] };
}

// storm-gated TSMOM family
const fam: Cfg[] = [];
for (const L of [20, 50, 100])
  for (const side of ["long", "ls"] as const)
    for (const volWin of [10, 20, 40])
      for (const rankWin of [180, 365])
        for (const thresh of [0.3, 0.4, 0.5, 0.6, 0.7])
          fam.push({ L, side, volWin, rankWin, gate: "storm", thresh });

const scored = fam.map((c) => {
  const pos = gated(B, c);
  const res = runPositions(B, pos, START, splitIdx);
  return { c, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
console.log(`storm-gated TSMOM family: ${fam.length} configs`);
console.log(`  IS netSharpe: mean=${mean(scored.map(s=>s.netSh)).toFixed(3)} max=${best.netSh.toFixed(3)} best=L=${best.c.L}|${best.c.side}|vw=${best.c.volWin}|rw=${best.c.rankWin}|th=${best.c.thresh} exp=${best.res.exposure.toFixed(3)}`);

const me = matchedExp(B, best.c, START, splitIdx, best.res.exposure);
console.log(`  best vs matchedExp: best=${best.netSh.toFixed(3)} meCtrl(mean/p95)=${me.mean.toFixed(3)}/${me.p95.toFixed(3)} beatsP95=${best.netSh > me.p95}`);

// GARCH surrogate for best storm config (honest N for THIS family = 180; combined = 600)
const g = fitGarch11(B.ret);
const NSURR = 400;
function surrP(c: Cfg, real: number): number {
  const s: number[] = [];
  for (let i = 0; i < NSURR; i++) {
    const rng = mkRng(8000 + i * 7919);
    const Bs = barsFromCloses(B, simulateGarchCloses(g, B.close[0], T, rng));
    s.push(annSharpe(sharpeDaily(runPositions(Bs, gated(Bs, c), START, splitIdx).dailyNet)));
  }
  s.sort((a, b) => a - b);
  return (s.filter((x) => x >= real).length + 1) / (NSURR + 1);
}
const sp = surrP(best.c, best.netSh);
console.log(`  GARCH surrogate p=${sp.toFixed(4)}`);

// DSR at family N=180 and combined honest N=600
const bestNet = best.res.dailyNet;
const dsr180 = computeDeflatedSharpeRatio(bestNet, { trialCount: 180 });
const dsr600 = computeDeflatedSharpeRatio(bestNet, { trialCount: 600 });
console.log(`  DSR @N=180 p=${dsr180.deflatedProbability.toFixed(4)} | @N=600(combined honest) p=${dsr600.deflatedProbability.toFixed(4)}`);

// holdout
const hold = runPositions(B, best.pos, splitIdx, tradableEnd);
const holdSh = annSharpe(sharpeDaily(hold.dailyNet));
console.log(`  holdout netSharpe=${holdSh.toFixed(3)} over ${hold.nDays} rows`);

// family holdout robustness
const holdShs = scored.map((s) => annSharpe(sharpeDaily(runPositions(B, s.pos, splitIdx, tradableEnd).dailyNet)));
console.log(`  family holdout: mean=${mean(holdShs).toFixed(3)} frac>0=${(holdShs.filter(x=>x>0).length/holdShs.length).toFixed(2)}`);

// block bootstrap on best
const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "q7-storm-bb" });
console.log(`  blockBootstrap meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}] pass=${bb.lower > 0}`);

// Harvey-Liu haircut at combined N=600
function erf(x: number){const t=1/(1+0.3275911*Math.abs(x));const y=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return x>=0?y:-y;}
function ncdf(z:number){return 0.5*(1+erf(z/Math.SQRT2));}
function zSh(r:number[]){const s=summarizeReturnSeries(r);if(s.sampleCount<3||s.stdDev<=0)return 0;const sh=s.sharpe;const d=Math.sqrt(Math.max(1e-9,1-s.skewness*sh+((s.kurtosis-1)/4)*sh*sh));return sh*Math.sqrt(s.sampleCount-1)/d;}
const psr = 1 - ncdf(zSh(bestNet));
console.log(`  Harvey-Liu adjP @N=600 = ${Math.min(1,psr*600).toExponential(3)} (psr=${psr.toExponential(3)}) pass=${psr*600<0.05}`);
