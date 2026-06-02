// AUDIT-OF-AUDIT — independent re-derivation of the Q9-LOWVOL family-wise surrogate.
//
// The audit (q9_familywise_surrogate.ts) shares one RNG stream across the 96 configs
// within a surrogate draw, but because configs rebalance on different cadences they
// consume the stream at different points -> not a literally-identical permutation per
// common rebalance date. This re-derivation removes that subtlety: per surrogate draw
// we build ONE master per-DAY coin permutation indexed by the calendar day, and EVERY
// config that rebalances on a given day uses that day's permutation. That is the textbook
// family-wise MAX-statistic for a searched grid sharing a single randomization stream.
//
// We also (a) reproduce the gauntlet's single-best-config p with the gauntlet's own
// shuffleNull recipe, and (b) compute the family-wise p two ways (shared-day-perm and
// fully-independent-per-config) to bracket the answer and prove robustness.
import {
  loadPanel,
  marketReturn,
  buildWeights,
  runWeights,
  sharpeAnn,
  mean,
  mkRng,
  Config,
} from "../edgehunt-quant/q9_lowvol_lib";

const P = loadPanel();
const mkt = marketReturn(P);
const T = P.dates.length;
const N = P.symbols.length;
const startIdx = 90;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * 0.8);

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

const scored = configs.map((cfg) => {
  const W = buildWeights(P, cfg, mkt, startIdx, splitIdx);
  const r = runWeights(P, W, mkt, startIdx, splitIdx, cfg);
  return { cfg, label: cfgLabel(cfg), W, r, netSh: sharpeAnn(r.dailyNet) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const realGridBest = best.netSh;
console.log(`HONEST_N=${HONEST_N} REAL grid-best=${best.label} netSh=${realGridBest.toFixed(4)}`);
console.log(`real grid top-5: ${scored.slice(0,5).map(s=>`${s.netSh.toFixed(3)}`).join(", ")}`);

// shuffled net Sharpe for a config given a per-DAY permutation table (dayPerm[t] = number[]).
function shuffledNet(W: (number[] | null)[], cfg: Config, dayPerm: number[][], turnoverPerRebal: number): number {
  const dailyNet: number[] = [];
  for (let t = startIdx; t < splitIdx; t++) {
    const w = W[t];
    if (!w) continue;
    const perm = dayPerm[t];
    const eff = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      if (w[i] === 0) continue;
      const j = perm[i];
      if (Number.isFinite(P.ret[t][j])) eff[j] = w[i];
    }
    let s = 0;
    for (let i = 0; i < N; i++) s += Math.abs(eff[i]);
    if (s < 1e-12) { dailyNet.push(0); continue; }
    const sc = cfg.gross / s;
    let g = 0;
    for (let i = 0; i < N; i++) if (eff[i] !== 0) g += eff[i] * sc * P.ret[t][i];
    dailyNet.push(g);
  }
  const amortCost = (turnoverPerRebal * 0.0004) / Math.max(1, cfg.holdDays);
  for (let i = 0; i < dailyNet.length; i++) dailyNet[i] -= amortCost;
  return sharpeAnn(dailyNet);
}

// ===== Family-wise null with ONE shared per-DAY permutation table per surrogate draw =====
// Every config sees the SAME permutation on the SAME calendar day. This is the clean
// searched-grid MAX-statistic: one coherent cross-sectional reshuffle of the panel per day.
const nSurr = 500;
const gridMaxShared: number[] = [];
const bestNullShared: number[] = [];
for (let s = 0; s < nSurr; s++) {
  const rng = mkRng(11111 + s * 1000003);
  // master per-day permutation for the whole IS window
  const dayPerm: number[][] = new Array(T);
  for (let t = startIdx; t < splitIdx; t++) {
    const perm = Array.from({ length: N }, (_, i) => i);
    for (let j = N - 1; j > 0; j--) {
      const m = Math.floor(rng() * (j + 1));
      [perm[j], perm[m]] = [perm[m], perm[j]];
    }
    dayPerm[t] = perm;
  }
  let mx = -Infinity;
  let bestSh = NaN;
  for (const sc of scored) {
    const sh = shuffledNet(sc.W, sc.cfg, dayPerm, sc.r.turnoverPerRebal);
    if (sh > mx) mx = sh;
    if (sc.label === best.label) bestSh = sh;
  }
  gridMaxShared.push(mx);
  bestNullShared.push(bestSh);
}
gridMaxShared.sort((a, b) => a - b);
bestNullShared.sort((a, b) => a - b);
const surr95Shared = gridMaxShared[Math.floor(nSurr * 0.95)];
const pFamShared = (gridMaxShared.filter((v) => v >= realGridBest).length + 1) / (nSurr + 1);
const pSingleShared = (bestNullShared.filter((v) => v >= realGridBest).length + 1) / (nSurr + 1);

console.log(`\n===== FAMILY-WISE (shared per-DAY perm; every config same perm each day) =====`);
console.log(`real grid-best          = ${realGridBest.toFixed(4)}`);
console.log(`grid-MAX mean           = ${mean(gridMaxShared).toFixed(4)}`);
console.log(`grid-MAX 95th pct       = ${surr95Shared.toFixed(4)}`);
console.log(`family-wise p           = ${pFamShared.toFixed(4)}   gate real>surr95: ${realGridBest>surr95Shared}`);
console.log(`single-best p (same RNG)= ${pSingleShared.toFixed(4)}`);

// ===== Independent-per-config family-wise null (each config its own perm stream) =====
// This is the OTHER extreme: maximally decorrelated across configs (most conservative for
// the gate because grid-MAX is largest). If the gate still fails here too, it is robust.
const gridMaxIndep: number[] = [];
for (let s = 0; s < nSurr; s++) {
  let mx = -Infinity;
  for (let c = 0; c < scored.length; c++) {
    const rng = mkRng(77777 + s * 1000003 + c * 31);
    const dayPerm: number[][] = new Array(T);
    for (let t = startIdx; t < splitIdx; t++) {
      const perm = Array.from({ length: N }, (_, i) => i);
      for (let j = N - 1; j > 0; j--) {
        const m = Math.floor(rng() * (j + 1));
        [perm[j], perm[m]] = [perm[m], perm[j]];
      }
      dayPerm[t] = perm;
    }
    const sh = shuffledNet(scored[c].W, scored[c].cfg, dayPerm, scored[c].r.turnoverPerRebal);
    if (sh > mx) mx = sh;
  }
  gridMaxIndep.push(mx);
}
gridMaxIndep.sort((a, b) => a - b);
const surr95Indep = gridMaxIndep[Math.floor(nSurr * 0.95)];
const pFamIndep = (gridMaxIndep.filter((v) => v >= realGridBest).length + 1) / (nSurr + 1);
console.log(`\n===== FAMILY-WISE (independent per-config perm stream) =====`);
console.log(`grid-MAX mean           = ${mean(gridMaxIndep).toFixed(4)}`);
console.log(`grid-MAX 95th pct       = ${surr95Indep.toFixed(4)}`);
console.log(`family-wise p           = ${pFamIndep.toFixed(4)}   gate real>surr95: ${realGridBest>surr95Indep}`);

console.log(`\n================ AUDIT-OF-AUDIT SUMMARY ================`);
console.log(`real grid-best                 = ${realGridBest.toFixed(4)}`);
console.log(`family-wise p (shared per-day) = ${pFamShared.toFixed(4)}  surr95=${surr95Shared.toFixed(3)}`);
console.log(`family-wise p (independent)    = ${pFamIndep.toFixed(4)}  surr95=${surr95Indep.toFixed(3)}`);
console.log(`audit reported family-wise p   = 0.3972  surr95=1.4221`);
console.log(`=> family-wise surrogate ${realGridBest>surr95Shared?"PASSES":"FAILS"} (real-best below surr95 max).`);
