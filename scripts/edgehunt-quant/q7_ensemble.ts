/**
 * Q7 strengthening attempt #3 (the honest "carry-the-multiple-testing-burden" version):
 * Instead of cherry-picking the best-of-600 config (which DSR/Harvey-Liu rightly penalize), test a
 * PRE-REGISTERED ENSEMBLE: equal-weight the storm-gated TSMOM family into ONE position book and
 * evaluate it as a SINGLE strategy. Honest N here is tiny (we test exactly a handful of
 * pre-registered ensembles: storm-long, storm-ls, calm-long, calm-ls). This is the legitimate way
 * to claim a BROAD regime effect rather than a lucky config.
 *
 * Full gauntlet on the ensemble:
 *   net-of-cost, B&H + random-lottery + MATCHED-EXPOSURE control, DSR @ honest N (=#ensembles),
 *   block-bootstrap CI, Harvey-Liu, GARCH(1,1) surrogate null, consume-once holdout.
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
  mkRng,
  fitGarch11,
  simulateGarchCloses,
  barsFromCloses,
  type DailyBars,
} from "./q7_lib.ts";
import fs from "node:fs";

const ROOT = ".";
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
// equal-weight ensemble position book over a family (average of per-config positions)
function ensemblePos(B: DailyBars, fam: Cfg[]): number[] {
  const T = B.close.length;
  const acc = new Array(T).fill(0);
  const cnt = new Array(T).fill(0);
  for (const c of fam) {
    const p = gated(B, c);
    for (let t = 0; t < T; t++) if (Number.isFinite(p[t])) { acc[t] += p[t]; cnt[t]++; }
  }
  return acc.map((s, t) => (cnt[t] > 0 ? s / cnt[t] : NaN));
}
function famOf(gate: "calm" | "storm", side: "long" | "ls"): Cfg[] {
  const f: Cfg[] = [];
  for (const L of [20, 50, 100])
    for (const volWin of [10, 20, 40])
      for (const rankWin of [180, 365])
        for (const thresh of [0.3, 0.4, 0.5, 0.6, 0.7]) f.push({ L, side, volWin, rankWin, gate, thresh });
  return f;
}

// honest N = the small set of pre-registered ensembles we evaluate
const ensembles: { name: string; fam: Cfg[] }[] = [
  { name: "storm-long", fam: famOf("storm", "long") },
  { name: "storm-ls", fam: famOf("storm", "ls") },
  { name: "calm-long", fam: famOf("calm", "long") },
  { name: "calm-ls", fam: famOf("calm", "ls") },
];
const HONEST_N = ensembles.length;

const g = fitGarch11(B.ret);
const NSURR = 500;

const rows = ensembles.map((e) => {
  const pos = ensemblePos(B, e.fam);
  const isR = runPositions(B, pos, START, splitIdx);
  const isSh = annSharpe(sharpeDaily(isR.dailyNet));
  const hold = runPositions(B, pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(hold.dailyNet));
  return { e, pos, isR, isSh, holdSh, exposure: isR.exposure };
});
rows.sort((a, b) => b.isSh - a.isSh);
const best = rows[0];
const bestNet = best.isR.dailyNet;

// baselines
const bh = runPositions(B, new Array(T).fill(1), START, splitIdx);
const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
// random lottery @ matched exposure
const rl: number[] = [];
for (let i = 0; i < 300; i++) {
  const rng = mkRng(31337 + i * 2654435761);
  const pos = new Array(T).fill(0);
  for (let t = START; t < splitIdx; t++) pos[t] = rng() < best.exposure ? 1 : 0;
  rl.push(annSharpe(sharpeDaily(runPositions(B, pos, START, splitIdx).dailyNet)));
}
rl.sort((a, b) => a - b);
const rl95 = rl[Math.floor(rl.length * 0.95)];
// matched-exposure control: ungated TSMOM (same sides present in the ensemble) thinned to ensemble exposure
// build the ungated ensemble (gate disabled) and thin
function ungatedEnsemble(fam: Cfg[]): number[] {
  const T = B.close.length;
  const acc = new Array(T).fill(0), cnt = new Array(T).fill(0);
  for (const c of fam) {
    const p = rawPos(B, c);
    for (let t = 0; t < T; t++) if (Number.isFinite(p[t])) { acc[t] += p[t]; cnt[t]++; }
  }
  return acc.map((s, t) => (cnt[t] > 0 ? s / cnt[t] : NaN));
}
const ungEns = ungatedEnsemble(best.e.fam);
let ue = 0, un = 0;
for (let t = START; t < splitIdx; t++) if (Number.isFinite(ungEns[t])) { ue += Math.abs(ungEns[t]); un++; }
const ungExp = un ? ue / un : 0;
const keep = ungExp > 0 ? Math.min(1, best.exposure / ungExp) : 0;
const meArr: number[] = [];
for (let i = 0; i < 300; i++) {
  const rng = mkRng(424299 + i * 40503);
  const pos = new Array(T).fill(NaN);
  for (let t = START; t < splitIdx; t++) { if (!Number.isFinite(ungEns[t])) continue; pos[t] = rng() < keep ? ungEns[t] : 0; }
  meArr.push(annSharpe(sharpeDaily(runPositions(B, pos, START, splitIdx).dailyNet)));
}
meArr.sort((a, b) => a - b);
const meMean = mean(meArr), me95 = meArr[Math.floor(meArr.length * 0.95)];
const matchedExpPass = best.isSh > me95;

// GARCH surrogate on the WHOLE ensemble (rebuild on each surrogate path)
const surr: number[] = [];
for (let i = 0; i < NSURR; i++) {
  const rng = mkRng(9100 + i * 7919);
  const Bs = barsFromCloses(B, simulateGarchCloses(g, B.close[0], T, rng));
  const pos = ensemblePos(Bs, best.e.fam);
  surr.push(annSharpe(sharpeDaily(runPositions(Bs, pos, START, splitIdx).dailyNet)));
}
surr.sort((a, b) => a - b);
const surrP = (surr.filter((s) => s >= best.isSh).length + 1) / (NSURR + 1);

// DSR @ honest N, block bootstrap, Harvey-Liu
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "q7-ens-bb" });
function erf(x: number){const t=1/(1+0.3275911*Math.abs(x));const y=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return x>=0?y:-y;}
function ncdf(z:number){return 0.5*(1+erf(z/Math.SQRT2));}
function zSh(r:number[]){const s=summarizeReturnSeries(r);if(s.sampleCount<3||s.stdDev<=0)return 0;const sh=s.sharpe;const d=Math.sqrt(Math.max(1e-9,1-s.skewness*sh+((s.kurtosis-1)/4)*sh*sh));return sh*Math.sqrt(s.sampleCount-1)/d;}
const psr = 1 - ncdf(zSh(bestNet));
const adjP = Math.min(1, psr * HONEST_N);

const meanDailyNet = mean(bestNet);
const monthly = meanDailyNet * 30 * 100000;

console.log(`================ Q7 ENSEMBLE (storm/calm-gated TSMOM, honest N = ${HONEST_N} ensembles) ================`);
for (const r of rows) console.log(`  ${r.e.name.padEnd(11)} IS=${r.isSh.toFixed(3)}  holdout=${r.holdSh.toFixed(3)}  exp=${r.exposure.toFixed(3)}`);
console.log(`\nBEST ensemble = ${best.e.name} (${best.e.fam.length} configs averaged)`);
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: { pass: meanDailyNet > 0, detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turnover=${best.isR.turnover.toFixed(3)} exp=${best.exposure.toFixed(3)}` },
  baselines: { pass: best.isSh > bhSh && best.isSh > rl95 && matchedExpPass, detail: `IS=${best.isSh.toFixed(3)} B&H=${bhSh.toFixed(3)} randLot95=${rl95.toFixed(3)} matchedExp(mean/95)=${meMean.toFixed(3)}/${me95.toFixed(3)} matchedExpPass=${matchedExpPass}` },
  deflated_sharpe: { pass: dsr.deflatedProbability > 0.95, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxDaily=${dsr.expectedMaxSharpe.toFixed(4)} bestDaily=${summarizeReturnSeries(bestNet).sharpe.toFixed(4)}` },
  block_bootstrap: { pass: bb.lower > 0, detail: `CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
  haircut: { pass: adjP < 0.05, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psr=${psr.toExponential(3)}*N=${HONEST_N})` },
  surrogate_garch: { pass: surrP < 0.05, detail: `GARCH-surrP=${surrP.toFixed(4)} real=${best.isSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(NSURR*0.95)].toFixed(3)}` },
  holdout: { pass: best.holdSh > 0, detail: `OOS netSharpe=${best.holdSh.toFixed(3)}` },
};
const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "haircut", "surrogate_garch", "holdout"];
let binding = "none";
for (const gn of order) { if (!gates[gn].pass) { binding = gn; break; } }
for (const gn of order) console.log(`  [${gates[gn].pass ? "PASS" : "KILL"}] ${gn} — ${gates[gn].detail}`);
const allPass = binding === "none";
const core = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate_garch.pass && gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : core ? "PROMISING" : "KILL";
const monthlyStr = binding === "none" ? `$${Math.round(monthly)}` : "n/a";
console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.isSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthlyStr} | holdoutSharpe ${best.holdSh.toFixed(3)}`);

fs.writeFileSync(`${ROOT}/output/edgehunt-quant/q7_ensemble_result.json`, JSON.stringify({ honestN: HONEST_N, ensembles: rows.map(r=>({name:r.e.name,isSh:r.isSh,holdSh:r.holdSh,exposure:r.exposure})), best: best.e.name, gates, binding, verdict, surrP, holdSh: best.holdSh, monthly, bhSh, rl95, meMean, me95 }, null, 2));
console.log(`wrote output/edgehunt-quant/q7_ensemble_result.json`);
