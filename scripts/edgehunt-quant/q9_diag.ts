import {
  loadPanel,
  marketReturn,
  buildWeights,
  runWeights,
  sharpeAnn,
  mean,
  std,
  Config,
} from "./q9_lowvol_lib";

const P = loadPanel();
const mkt = marketReturn(P);
const T = P.dates.length;
// require all base windows available; start after the longest lookback + buffer
const startIdx = 90; // ~3 months in to have vol+beta windows
const endIdx = T - 1;
console.log(`panel: ${P.symbols.length} coins, ${T} days, ${P.dates[0]}..${P.dates[T - 1]}`);
console.log(`tradable window: ${P.dates[startIdx]}..${P.dates[endIdx - 1]} (${endIdx - startIdx} days)`);

function evalCfg(cfg: Config, label: string) {
  const W = buildWeights(P, cfg, mkt, startIdx, endIdx);
  const r = runWeights(P, W, mkt, startIdx, endIdx, cfg);
  const sh = sharpeAnn(r.dailyNet);
  const shG = sharpeAnn(r.dailyGross);
  const m = mean(r.dailyNet);
  console.log(
    `${label.padEnd(46)} netSh=${sh.toFixed(3)} grossSh=${shG.toFixed(3)} ` +
      `meanDay=${(m * 1e4).toFixed(2)}bps bookBeta=${r.avgNetBeta.toFixed(3)} ` +
      `turn/rebal=${r.turnoverPerRebal.toFixed(2)} nRebal=${r.nRebals} nDays=${r.dailyNet.length}`,
  );
  return { sh, r };
}

// Baseline naive (NOT beta-neutral) — expect structurally short-beta
evalCfg(
  { volWin: 30, betaWin: 60, holdDays: 7, frac: 0.3, betaNeutral: false, gross: 1 },
  "naive long-low/short-high (NOT beta-neutral)",
);
// Beta-neutral version
evalCfg(
  { volWin: 30, betaWin: 60, holdDays: 7, frac: 0.3, betaNeutral: true, gross: 1 },
  "beta-neutral",
);
// a few windows
for (const vw of [20, 30, 60, 90]) {
  for (const hd of [5, 7, 14]) {
    evalCfg(
      { volWin: vw, betaWin: 60, holdDays: hd, frac: 0.3, betaNeutral: true, gross: 1 },
      `bn volWin=${vw} hold=${hd}`,
    );
  }
}
