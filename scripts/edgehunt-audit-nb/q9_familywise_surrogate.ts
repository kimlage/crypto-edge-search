// INDEPENDENT AUDIT — Q9-LOWVOL family-wise MAX-statistic surrogate.
//
// The committed gauntlet (scripts/edgehunt-quant/q9_gauntlet.ts) reports XS-shuffle
// p=0.002, but it shuffles ONLY the best config's weights and compares the shuffled
// Sharpes against the BEST config's Sharpe. That is a SINGLE-config null. The best
// config was selected as the argmax over a 96-config grid, so the correct null is the
// FAMILY-WISE MAX statistic: for each surrogate draw, apply ONE coin-permutation stream
// to the WHOLE grid, recompute every config's shuffled Sharpe, and take the grid-MAX.
// Compare the REAL grid-best Sharpe to the 95th pct of the per-surrogate grid-MAX null.
//
// This is the exact same correction the main audit applied to flip BTC reserve PROMISING->KILL.
//
// Also: (A) honest-N DSR & Harvey-Liu at the FULL grid N; (B) short-leg borrow financing on
// the FULL short notional; (C) survivorship note. Writes only to output/edgehunt-audit-nb/.
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
} from "../edgehunt-quant/q9_lowvol_lib";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const P = loadPanel();
const mkt = marketReturn(P);
const T = P.dates.length;
const N = P.symbols.length;
const startIdx = 90;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * 0.8); // IS = first 80% (matches gauntlet)

// ---------------- EXACT same honest grid as the committed gauntlet ----------------
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
          configs.push({ volWin: vw, betaWin: bw, holdDays: hd, frac: fr, betaNeutral: bn, gross: 1 });
const HONEST_N = configs.length;
const cfgLabel = (c: Config) =>
  `vw${c.volWin}_bw${c.betaWin}_hd${c.holdDays}_fr${c.frac}_bn${c.betaNeutral ? 1 : 0}`;

// ---- score every config IN-SAMPLE on net Sharpe (the selection DSR/family-wise must correct) ----
const scored = configs.map((cfg) => {
  const W = buildWeights(P, cfg, mkt, startIdx, splitIdx);
  const r = runWeights(P, W, mkt, startIdx, splitIdx, cfg);
  return { cfg, label: cfgLabel(cfg), W, r, netSh: sharpeAnn(r.dailyNet) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const realGridBest = best.netSh;
console.log(`HONEST_N=${HONEST_N}  REAL grid-best = ${best.label} netSh=${realGridBest.toFixed(4)}`);

// ============================================================================
// FAMILY-WISE MAX-STATISTIC SURROGATE
// ============================================================================
// Per surrogate draw s: build ONE per-rebalance coin-index permutation STREAM and apply
// it to EVERY config's weight matrix (the weight intended for coin i is given to coin
// perm[i]; renormalize to same gross). Recompute each config's shuffled net Sharpe, then
// take the grid-MAX over all 96 configs. This is the searched-grid null.
//
// The single-config shuffle uses one perm per rebalance, re-drawn when weights change.
// To make the family-wise null faithful, each surrogate draw owns its RNG; within a draw,
// the same rebalance-block permutations are reused across configs by re-deriving a fresh
// perm at each rebalance from the draw's RNG, applied identically per config. Because configs
// rebalance on different cadences, we draw a fresh perm at each *day* a given config rebalances,
// from that draw's RNG -- preserving "destroy coin<->signal link, keep cross-sectional return
// distribution & gross" while being one coherent randomization per surrogate draw.

function shuffledNetForConfig(
  rng: () => number,
  W: (number[] | null)[],
  cfg: Config,
  turnoverPerRebal: number,
): number {
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
    const sc = cfg.gross / s;
    let g = 0;
    for (let i = 0; i < N; i++) if (eff[i] !== 0) g += eff[i] * sc * P.ret[t][i];
    dailyNet.push(g);
    prevW = w;
  }
  // amortized cost matched to the real book of THIS config (fair net comparison, as in gauntlet)
  const amortCost = (turnoverPerRebal * 0.0004) / Math.max(1, cfg.holdDays);
  for (let i = 0; i < dailyNet.length; i++) dailyNet[i] -= amortCost;
  return sharpeAnn(dailyNet);
}

const nSurr = 500;
const gridMax: number[] = [];
// also keep the single-config null (best only) to reproduce the gauntlet's p for comparison
const singleBestNull: number[] = [];
for (let s = 0; s < nSurr; s++) {
  const rng = mkRng(90210 + s * 2654435761);
  let mx = -Infinity;
  let bestConfigShuffle = NaN;
  for (const sc of scored) {
    const sh = shuffledNetForConfig(rng, sc.W, sc.cfg, sc.r.turnoverPerRebal);
    if (sh > mx) mx = sh;
    if (sc.label === best.label) bestConfigShuffle = sh;
  }
  gridMax.push(mx);
  singleBestNull.push(bestConfigShuffle);
  if ((s + 1) % 100 === 0) console.log(`  surrogate ${s + 1}/${nSurr} ... gridMax so far q95~${[...gridMax].sort((a,b)=>a-b)[Math.floor(gridMax.length*0.95)].toFixed(3)}`);
}
gridMax.sort((a, b) => a - b);
singleBestNull.sort((a, b) => a - b);

const surr95max = gridMax[Math.floor(nSurr * 0.95)];
const surr99max = gridMax[Math.floor(nSurr * 0.99)];
const familyAbove = gridMax.filter((v) => v >= realGridBest).length;
const familywiseP = (familyAbove + 1) / (nSurr + 1);
const familywisePass = realGridBest > surr95max; // gate: real-best must beat surr95(max)

// reproduce single-config p (for the record)
const singleAbove = singleBestNull.filter((v) => v >= realGridBest).length;
const singleP = (singleAbove + 1) / (nSurr + 1);

console.log(`\n===== FAMILY-WISE MAX-STATISTIC SURROGATE =====`);
console.log(`real grid-best Sharpe        = ${realGridBest.toFixed(4)}`);
console.log(`surrogate grid-MAX mean      = ${mean(gridMax).toFixed(4)}`);
console.log(`surrogate grid-MAX 95th pct  = ${surr95max.toFixed(4)}`);
console.log(`surrogate grid-MAX 99th pct  = ${surr99max.toFixed(4)}`);
console.log(`family-wise p (MAX-stat)     = ${familywiseP.toFixed(4)}`);
console.log(`GATE real-best > surr95(max) = ${familywisePass}  ${familywisePass ? "(surrogate PASSES family-wise)" : "(surrogate FAILS family-wise -> KILL)"}`);
console.log(`\n[reproduce single-config null] single-best XS-shuffle p = ${singleP.toFixed(4)} (gauntlet reported 0.0020)`);

// ============================================================================
// HONEST-N DSR + Harvey-Liu at FULL grid N (= 96)
// ============================================================================
const dsr = computeDeflatedSharpeRatio(best.r.dailyNet, { trialCount: HONEST_N });
function normalCdf(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
const psrP = 1 - normalCdf(zSharpe(best.r.dailyNet));
const hlAdjP = Math.min(1, psrP * HONEST_N);
console.log(`\n===== HONEST-N MULTIPLE-TESTING =====`);
console.log(`DSR p @N=${HONEST_N} = ${dsr.deflatedProbability.toFixed(4)} (sharpeDaily=${dsr.sharpe.toFixed(4)} expMax=${dsr.expectedMaxSharpe.toFixed(4)})  pass=${dsr.deflatedProbability > 0.95}`);
console.log(`Harvey-Liu Bonferroni adjP @N=${HONEST_N} = ${hlAdjP.toExponential(3)}  pass=${hlAdjP < 0.05}`);

// ============================================================================
// FINANCING — short-leg borrow on FULL short notional
// ============================================================================
// Q9 is dollar-neutral L/S, gross=1 => short notional ~ 0.5 of gross book.
// (best config is beta-neutral so legs are slightly asymmetric; use realized short notional.)
// Recompute the realized average short notional from the best config weights, then charge
// borrow at several annual rates on the FULL short notional, every day held.
function shortNotional(W: (number[] | null)[]): number {
  // average sum of negative weights (abs) over held days, in gross-1 units
  const vals: number[] = [];
  for (let t = startIdx; t < splitIdx; t++) {
    const w = W[t];
    if (!w) continue;
    let sn = 0;
    for (let i = 0; i < N; i++) if (w[i] < 0) sn += -w[i];
    vals.push(sn);
  }
  return mean(vals);
}
const sn = shortNotional(best.W);
// borrow rate scenarios (annual). Crypto perp/spot borrow on alts is expensive & volatile.
// Use a realistic mid (10%/yr ~ liquid majors funded) plus a high alt scenario (30%/yr).
const borrowScenarios = [0.05, 0.10, 0.20, 0.30];
const dailyNetBase = best.r.dailyNet.slice();
const finResults = borrowScenarios.map((annual) => {
  const dailyBorrow = (annual * sn) / 365; // borrow on full short notional, per day
  const adj = dailyNetBase.map((x) => x - dailyBorrow);
  return { annual, dailyBorrowBps: dailyBorrow * 1e4, netSharpe: sharpeAnn(adj), meanDailyNetBps: mean(adj) * 1e4 };
});
console.log(`\n===== FINANCING (short-leg borrow on FULL short notional) =====`);
console.log(`realized avg short notional (gross=1 units) = ${sn.toFixed(4)}`);
console.log(`base net Sharpe (no borrow) = ${realGridBest.toFixed(4)}, base mean daily net = ${(mean(dailyNetBase)*1e4).toFixed(3)} bps`);
for (const f of finResults)
  console.log(`  borrow ${(f.annual*100).toFixed(0)}%/yr -> -${f.dailyBorrowBps.toFixed(3)} bps/day | net Sharpe = ${f.netSharpe.toFixed(4)} | mean daily net = ${f.meanDailyNetBps.toFixed(3)} bps`);

// pick the realistic-alt scenario (20%/yr) as the headline financing-corrected number
const headlineFin = finResults.find((f) => f.annual === 0.20)!;

// ============================================================================
// SURVIVORSHIP NOTE
// ============================================================================
const deadCoins = ["LUNA", "UST", "FTT", "LUNC", "USTC", "ANC", "MIR"];
const present = deadCoins.filter((d) => P.symbols.includes(d));
console.log(`\n===== SURVIVORSHIP =====`);
console.log(`panel = ${N} coins, all alive as of ${P.dates[tradableEnd]}.`);
console.log(`blow-up coins present: ${present.length ? present.join(",") : "NONE (LUNA/FTT/UST absent)"}`);
console.log(`=> short-HIGH-vol leg never held the catastrophic high-vol losers it would have shorted;`);
console.log(`   survivorship is a directional upper bound on this strategy.`);

// ============================================================================
// VERDICT
// ============================================================================
const out = {
  audit: "Q9-LOWVOL independent family-wise surrogate audit",
  honestN: HONEST_N,
  bestLabel: best.label,
  realGridBestSharpe: realGridBest,
  familywiseSurrogate: {
    nSurr,
    realGridBest,
    surrMaxMean: mean(gridMax),
    surr95max,
    surr99max,
    familywiseP,
    passes: familywisePass,
  },
  singleConfigSurrogateP_reproduced: singleP,
  honestN_DSR_p: dsr.deflatedProbability,
  honestN_DSR_pass: dsr.deflatedProbability > 0.95,
  harveyLiu_adjP: hlAdjP,
  financing: {
    realizedShortNotional: sn,
    scenarios: finResults,
    headline20pct_netSharpe: headlineFin.netSharpe,
  },
  survivorship: { panelCoins: N, blowupCoinsPresent: present },
};
writeFileSync("output/edgehunt-audit-nb/q9_familywise_surrogate.json", JSON.stringify(out, null, 2));
console.log(`\nwrote output/edgehunt-audit-nb/q9_familywise_surrogate.json`);

// final decision line
const kill =
  !familywisePass || !(dsr.deflatedProbability > 0.95) || !(hlAdjP < 0.05);
const verdict = kill ? "KILL" : "PROMISING";
console.log(`\n================ AUDIT VERDICT ================`);
console.log(`family-wise surrogate p = ${familywiseP.toFixed(4)} (gate ${familywisePass ? "PASS" : "FAIL"})`);
console.log(`honest-N DSR p = ${dsr.deflatedProbability.toFixed(4)} (gate ${dsr.deflatedProbability > 0.95 ? "PASS" : "FAIL"})`);
console.log(`financing-corrected (20%/yr borrow) net Sharpe = ${headlineFin.netSharpe.toFixed(4)}`);
console.log(`VERDICT: ${verdict}`);
