// Robustness map: net Sharpe across the full grid, IS only, to judge whether
// the high-Sharpe region is broad/coherent or an isolated overfit corner.
import {
  loadPanel,
  marketReturn,
  buildWeights,
  runWeights,
  sharpeAnn,
  mean,
  Config,
} from "./q9_lowvol_lib";

const P = loadPanel();
const mkt = marketReturn(P);
const T = P.dates.length;
const startIdx = 90;
const splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8);

const volWins = [20, 30, 60, 90];
const fracs = [0.2, 0.3];
const holds = [5, 7, 14];
console.log("beta-neutral net Sharpe (IS) by volWin x frac x hold (betaWin=60):");
const all: number[] = [];
const bnTrue: number[] = [];
const bnFalse: number[] = [];
for (const bn of [true, false]) {
  console.log(`\n--- betaNeutral=${bn} ---`);
  for (const vw of volWins) {
    const row: string[] = [];
    for (const fr of fracs) {
      for (const hd of holds) {
        const cfg: Config = { volWin: vw, betaWin: 60, holdDays: hd, frac: fr, betaNeutral: bn, gross: 1 };
        const W = buildWeights(P, cfg, mkt, startIdx, splitIdx);
        const r = runWeights(P, W, mkt, startIdx, splitIdx, cfg);
        const sh = sharpeAnn(r.dailyNet);
        all.push(sh);
        (bn ? bnTrue : bnFalse).push(sh);
        row.push(`fr${fr}h${hd}=${sh.toFixed(2)}`);
      }
    }
    console.log(`  vw${String(vw).padStart(2)}: ${row.join("  ")}`);
  }
}
console.log(`\nbeta-neutral configs: mean Sharpe=${mean(bnTrue).toFixed(3)}, min=${Math.min(...bnTrue).toFixed(3)}, frac>0=${(bnTrue.filter(s=>s>0).length/bnTrue.length).toFixed(2)}`);
console.log(`non-neutral configs:  mean Sharpe=${mean(bnFalse).toFixed(3)}, min=${Math.min(...bnFalse).toFixed(3)}, frac>0=${(bnFalse.filter(s=>s>0).length/bnFalse.length).toFixed(2)}`);

// long-window subset vs short-window subset
const longWin = volWins.filter(v=>v>=60);
const lw:number[]=[], sw:number[]=[];
for (const vw of volWins) for (const fr of fracs) for (const hd of holds){
  const cfg: Config = { volWin: vw, betaWin: 60, holdDays: hd, frac: fr, betaNeutral: true, gross: 1 };
  const W = buildWeights(P, cfg, mkt, startIdx, splitIdx);
  const sh = sharpeAnn(runWeights(P, W, mkt, startIdx, splitIdx, cfg).dailyNet);
  (vw>=60?lw:sw).push(sh);
}
console.log(`\nbeta-neutral long-vol-window(>=60d): mean Sharpe=${mean(lw).toFixed(3)} (n=${lw.length})`);
console.log(`beta-neutral short-vol-window(<60d): mean Sharpe=${mean(sw).toFixed(3)} (n=${sw.length})`);
