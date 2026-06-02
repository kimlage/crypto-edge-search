// Q9-LOWVOL full committed gauntlet.
// Cross-sectional low-vol long-short, dollar-neutral + beta-neutral.
// Net-of-cost (4bps/side), baselines (equal-weight market / random long-short /
// matched-exposure shuffle control), Deflated Sharpe @ HONEST N (every config),
// block-bootstrap CI, CPCV/PBO, Harvey-Liu haircut, cross-sectional-shuffle null,
// consume-once forward holdout.
import { writeFileSync } from "node:fs";
import {
  loadPanel,
  marketReturn,
  buildWeights,
  runWeights,
  sharpeAnn,
  mean,
  std,
  mkRng,
  Config,
  Panel,
} from "./q9_lowvol_lib";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const P = loadPanel();
const mkt = marketReturn(P);
const T = P.dates.length;
const TRADING_DAYS = 365;
const startIdx = 90;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const holdoutFrac = 0.2;
const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));
console.log(
  `IS window: ${P.dates[startIdx]}..${P.dates[splitIdx - 1]} (${splitIdx - startIdx} d)`,
);
console.log(
  `OOS holdout: ${P.dates[splitIdx]}..${P.dates[tradableEnd - 1]} (${tradableEnd - splitIdx} d) [consume-once]`,
);

// ---------------- HONEST grid: count EVERY config ----------------
const volWins = [20, 30, 60, 90];
const betaWins = [60, 90];
const holdDays = [5, 7, 14];
const fracs = [0.2, 0.3];
const betaNeutrals = [true, false];
const configs: Config[] = [];
for (const vw of volWins)
  for (const bw of betaWins)
    for (const hd of holdDays)
      for (const fr of fracs)
        for (const bn of betaNeutrals)
          configs.push({
            volWin: vw,
            betaWin: bw,
            holdDays: hd,
            frac: fr,
            betaNeutral: bn,
            gross: 1,
          });
const HONEST_N = configs.length;
console.log(`HONEST N = ${HONEST_N} configs`);

function cfgLabel(c: Config): string {
  return `vw${c.volWin}_bw${c.betaWin}_hd${c.holdDays}_fr${c.frac}_bn${c.betaNeutral ? 1 : 0}`;
}

// ---- score every config IN-SAMPLE on net Sharpe (selection that DSR must correct) ----
const scored = configs.map((cfg) => {
  const W = buildWeights(P, cfg, mkt, startIdx, splitIdx);
  const r = runWeights(P, W, mkt, startIdx, splitIdx, cfg);
  return { cfg, label: cfgLabel(cfg), W, r, netSh: sharpeAnn(r.dailyNet) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestNet = best.r.dailyNet;
console.log(
  `\nBEST IS config: ${best.label} netSh=${best.netSh.toFixed(3)} bookBeta=${best.r.avgNetBeta.toFixed(3)} turn/rebal=${best.r.turnoverPerRebal.toFixed(2)} nDays=${bestNet.length}`,
);
console.log("top 5:");
for (const s of scored.slice(0, 5))
  console.log(`  ${s.label} netSh=${s.netSh.toFixed(3)} beta=${s.r.avgNetBeta.toFixed(3)}`);

// ======================= BASELINES =======================
// (1) equal-weight market long-only (buy & hold the panel)
const ewDaily: number[] = [];
for (let t = startIdx; t < splitIdx; t++) {
  if (Number.isFinite(mkt[t])) ewDaily.push(mkt[t]);
}
const ewSh = sharpeAnn(ewDaily);

// (2) random long-short books at matched gross & turnover (random coin assignment).
//     This is the matched-exposure control: same dollar-neutral L/S structure,
//     same number of legs & rebalance cadence, RANDOM coin selection.
function randomLongShort(seed: number, cfg: Config): number[] {
  const rng = mkRng(seed);
  const N = P.symbols.length;
  const W: (number[] | null)[] = new Array(T).fill(null);
  let current: number[] | null = null;
  let lastRebal = -1;
  for (let t = startIdx; t < splitIdx; t++) {
    const due = lastRebal < 0 || t - lastRebal >= cfg.holdDays;
    if (due) {
      const elig: number[] = [];
      for (let i = 0; i < N; i++) {
        if (Number.isFinite(P.ret[t][i]) && Number.isFinite(P.close[t - 1][i]))
          elig.push(i);
      }
      if (elig.length >= 6) {
        // shuffle eligible, pick k long / k short
        for (let j = elig.length - 1; j > 0; j--) {
          const m = Math.floor(rng() * (j + 1));
          [elig[j], elig[m]] = [elig[m], elig[j]];
        }
        const k = Math.max(1, Math.floor(elig.length * cfg.frac));
        const w = new Array(N).fill(0);
        for (let j = 0; j < k; j++) w[elig[j]] += 1 / k;
        for (let j = 0; j < k; j++) w[elig[elig.length - 1 - j]] -= 1 / k;
        let s = 0;
        for (const v of w) s += Math.abs(v);
        const sc = cfg.gross / s;
        for (let i = 0; i < N; i++) w[i] *= sc;
        current = w;
        lastRebal = t;
      }
    }
    W[t] = current ? current.slice() : null;
  }
  const r = runWeights(P, W, mkt, startIdx, splitIdx, cfg);
  return r.dailyNet;
}
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) rlSh.push(sharpeAnn(randomLongShort(424242 + i * 2654435761, best.cfg)));
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
const rlMean = mean(rlSh);

const baselinePass = best.netSh > ewSh && best.netSh > rl95 && best.netSh > 0;
console.log(
  `\nBASELINES: bestNetSh=${best.netSh.toFixed(3)} vs EWmarket=${ewSh.toFixed(3)} randomLS_mean=${rlMean.toFixed(3)} randomLS_95=${rl95.toFixed(3)} -> pass=${baselinePass}`,
);

// ======================= DEFLATED SHARPE @ HONEST N =======================
// convert annualized to per-period: the lib works on the raw daily series.
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;
console.log(
  `DSR: p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSharpe(daily)=${dsr.expectedMaxSharpe.toFixed(4)} sharpe(daily)=${dsr.sharpe.toFixed(4)} -> pass=${dsrPass}`,
);

// ======================= BLOCK-BOOTSTRAP CI on mean daily net =======================
const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 20,
  confidenceLevel: 0.95,
  seed: "q9-lowvol-bb",
});
const bbPass = bb.lower > 0;
console.log(
  `BLOCK-BOOTSTRAP: meanDailyNet CI95=[${bb.lower.toExponential(3)}, ${bb.upper.toExponential(3)}] est=${bb.estimate.toExponential(3)} -> pass=${bbPass}`,
);

// ======================= CPCV / PBO across all configs =======================
function toFolds(series: number[], n: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / n);
  for (let f = 0; f < n; f++) {
    const lo = f * sz;
    const hi = f === n - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}
const NFOLDS = 6;
const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.r.dailyNet, NFOLDS) }));
let pbo = 1;
let medianLogit = 0;
try {
  const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = r.pbo;
  medianLogit = r.medianLogit;
} catch (e) {
  console.log("CPCV err", e);
}
const pboPass = pbo < 0.5;
console.log(`CPCV/PBO: PBO=${pbo.toFixed(3)} medianLogit=${medianLogit.toFixed(3)} -> pass=${pboPass}`);

// ======================= HARVEY-LIU (Bonferroni) HAIRCUT =======================
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
const psrP = 1 - normalCdf(zSharpe(bestNet));
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;
console.log(`HAIRCUT: Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N}) -> pass=${haircutPass}`);

// ======================= CROSS-SECTIONAL SHUFFLE NULL (the RIGHT null) =======================
// At each day, the strategy maps coins->weights via the vol rank. The cross-sectional
// shuffle destroys the coin<->signal linkage by permuting which coin receives which
// target weight, while preserving the panel's realized cross-sectional return distribution
// each day (same coins, same returns, same gross/dollar-neutral structure). If the low-vol
// ranking carries no information, the shuffled book has the same expected Sharpe.
function shuffleNullSharpe(seed: number, W: (number[] | null)[]): number {
  const rng = mkRng(seed);
  const N = P.symbols.length;
  const dailyNet: number[] = [];
  let prevPerm: number[] | null = null;
  let prevW: number[] | null = null;
  // Use one fixed permutation per rebalance block (consistent with hold) so turnover matches.
  // Detect rebalance by weight change.
  let perm: number[] = Array.from({ length: N }, (_, i) => i);
  for (let t = startIdx; t < splitIdx; t++) {
    const w = W[t];
    if (!w) continue;
    const changed =
      !prevW || w.some((v, i) => Math.abs(v - prevW![i]) > 1e-12);
    if (changed) {
      // new permutation of coin indices
      perm = Array.from({ length: N }, (_, i) => i);
      for (let j = N - 1; j > 0; j--) {
        const m = Math.floor(rng() * (j + 1));
        [perm[j], perm[m]] = [perm[m], perm[j]];
      }
    }
    // apply: weight intended for coin i is given to coin perm[i]; only valid if perm[i] tradable
    let g = 0;
    let valid = 0;
    let grossW = 0;
    const eff = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      if (w[i] === 0) continue;
      const j = perm[i];
      const r = P.ret[t][j];
      if (Number.isFinite(r)) {
        eff[j] = w[i];
        grossW += Math.abs(w[i]);
      }
    }
    // renormalize to same gross so exposure matches even if some perm targets are untradable
    let s = 0;
    for (let i = 0; i < N; i++) s += Math.abs(eff[i]);
    if (s < 1e-12) {
      dailyNet.push(0);
      prevW = w;
      continue;
    }
    const sc = (best.cfg.gross) / s;
    for (let i = 0; i < N; i++) {
      if (eff[i] === 0) continue;
      g += eff[i] * sc * P.ret[t][i];
    }
    // cost on rebalance (matched gross turnover)
    let cost = 0;
    if (changed) cost = grossW * sc * 0 + best.r.turnoverPerRebal * 0; // see below
    dailyNet.push(g);
    prevW = w;
  }
  // apply average per-day cost equal to the real book's amortized cost so net-comparison is fair
  const amortCost = (best.r.turnoverPerRebal * 0.0004) / Math.max(1, best.cfg.holdDays);
  for (let i = 0; i < dailyNet.length; i++) dailyNet[i] -= amortCost;
  return sharpeAnn(dailyNet);
}
const nSurr = 500;
const surr: number[] = [];
for (let i = 0; i < nSurr; i++) surr.push(shuffleNullSharpe(7000 + i * 7919, best.W));
surr.sort((a, b) => a - b);
const surrAbove = surr.filter((s) => s >= best.netSh).length;
const surrP = (surrAbove + 1) / (nSurr + 1);
const surrPass = surrP < 0.05;
console.log(
  `\nCROSS-SECTIONAL SHUFFLE NULL: real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)} surr99=${surr[Math.floor(nSurr * 0.99)].toFixed(3)} p=${surrP.toFixed(4)} -> pass=${surrPass}`,
);

// ======================= CONSUME-ONCE FORWARD HOLDOUT =======================
const Whold = buildWeights(P, best.cfg, mkt, startIdx, tradableEnd);
const holdRes = runWeights(P, Whold, mkt, splitIdx, tradableEnd, best.cfg);
const holdSh = sharpeAnn(holdRes.dailyNet);
const holdoutPass = holdSh > 0;
console.log(
  `HOLDOUT (consume-once): OOS netSharpeAnn=${holdSh.toFixed(3)} bookBeta=${holdRes.avgNetBeta.toFixed(3)} over ${holdRes.dailyNet.length} days -> pass=${holdoutPass}`,
);

// monthly $ at $100k (use IS mean daily net, gross=1 => $100k notional gross)
const meanDailyNet = mean(bestNet);
const monthlyAt100k = meanDailyNet * 30 * 100000;

// ======================= ASSEMBLE GATES =======================
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: {
    pass: meanDailyNet > 0,
    detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turn/rebal=${best.r.turnoverPerRebal.toFixed(3)}`,
  },
  baselines: { pass: baselinePass, detail: `best=${best.netSh.toFixed(3)} EW=${ewSh.toFixed(3)} randLS95=${rl95.toFixed(3)}` },
  deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N}` },
  block_bootstrap: { pass: bbPass, detail: `CI95 lower=${bb.lower.toExponential(3)}` },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.toFixed(3)}` },
  haircut: { pass: haircutPass, detail: `adjP=${adjP.toExponential(3)}` },
  surrogate: { pass: surrPass, detail: `XS-shuffle p=${surrP.toFixed(4)}` },
  holdout: { pass: holdoutPass, detail: `OOS netSh=${holdSh.toFixed(3)}` },
};
const order = [
  "net_of_cost",
  "baselines",
  "deflated_sharpe",
  "block_bootstrap",
  "cpcv_pbo",
  "haircut",
  "surrogate",
  "holdout",
];
let binding = "none";
for (const g of order) if (!gates[g].pass) { binding = g; break; }
const allPass = binding === "none";
const survivesCore =
  gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
let verdict: string;
if (allPass) verdict = "SURVIVE";
else if (survivesCore) verdict = "PROMISING";
else verdict = "KILL";

console.log("\n================ GATES ================");
for (const g of order) console.log(`  ${gates[g].pass ? "PASS" : "FAIL"}  ${g.padEnd(16)} ${gates[g].detail}`);
console.log(`\nbindingGate=${binding}  verdict=${verdict}`);
console.log(
  `best netSh=${best.netSh.toFixed(3)}  monthly@$100k=$${monthlyAt100k.toFixed(0)}  holdoutSh=${holdSh.toFixed(3)}  surrP=${surrP.toFixed(4)}`,
);

const out = {
  honestN: HONEST_N,
  bestLabel: best.label,
  bestCfg: best.cfg,
  bestNetSharpeAnn: best.netSh,
  bookBeta: best.r.avgNetBeta,
  meanDailyNet,
  monthlyAt100k,
  baselines: { ewMarket: ewSh, randomLS_mean: rlMean, randomLS_95: rl95 },
  dsr: { p: dsr.deflatedProbability, expectedMaxSharpeDaily: dsr.expectedMaxSharpe },
  blockBootstrap: { lower: bb.lower, upper: bb.upper, estimate: bb.estimate },
  pbo,
  haircutAdjP: adjP,
  surrogate: { p: surrP, mean: mean(surr), q95: surr[Math.floor(nSurr * 0.95)] },
  holdout: { netSharpeAnn: holdSh, bookBeta: holdRes.avgNetBeta, nDays: holdRes.dailyNet.length },
  gates,
  bindingGate: binding,
  verdict,
};
writeFileSync("output/edgehunt-quant/q9_lowvol_gauntlet.json", JSON.stringify(out, null, 2));
console.log("\nwrote output/edgehunt-quant/q9_lowvol_gauntlet.json");
