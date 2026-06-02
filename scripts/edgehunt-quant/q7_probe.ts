import {
  loadDailyBTC,
  realizedVol,
  tsmomSignal,
  rsi,
  runPositions,
  annSharpe,
  sharpeDaily,
  fitGarch11,
  mean,
  std,
} from "./q7_lib.ts";

const B = loadDailyBTC();
const T = B.close.length;
console.log(`daily bars: ${T} | ${B.dates[0]} .. ${B.dates[T - 1]}`);
console.log(
  `daily ret mean=${(mean(B.ret) * 365).toFixed(3)}/yr std(daily)=${std(B.ret).toFixed(4)} annVol=${(std(B.ret) * Math.sqrt(365)).toFixed(3)}`,
);

// Buy & hold reference (full sample, after a 200-day warmup so it's comparable)
const start = 200;
const bh = runPositions(B, new Array(T).fill(1), start, T - 1);
console.log(`B&H netSharpeAnn=${annSharpe(sharpeDaily(bh.dailyNet)).toFixed(3)} nDays=${bh.nDays}`);

// 1) confirm standalone TSMOM (sign of trailing return) is killed
for (const L of [20, 50, 100]) {
  const sig = tsmomSignal(B.close, L);
  const pos = sig.map((s) => (Number.isFinite(s) ? Math.sign(s) : NaN));
  const r = runPositions(B, pos, start, T - 1);
  console.log(
    `TSMOM L=${L} long/short: netSharpeAnn=${annSharpe(sharpeDaily(r.dailyNet)).toFixed(3)} exposure=${r.exposure.toFixed(2)} turnover=${r.turnover.toFixed(3)}`,
  );
  // long-only variant (only take longs)
  const posLO = sig.map((s) => (Number.isFinite(s) ? (s > 0 ? 1 : 0) : NaN));
  const rLO = runPositions(B, posLO, start, T - 1);
  console.log(
    `TSMOM L=${L} long-only:  netSharpeAnn=${annSharpe(sharpeDaily(rLO.dailyNet)).toFixed(3)} exposure=${rLO.exposure.toFixed(2)}`,
  );
}

// 2) confirm standalone RSI mean-reversion is killed
for (const L of [7, 14]) {
  const ind = rsi(B.close, L);
  // classic reversion: long when oversold (<30), short when overbought (>70)
  const pos = ind.map((v) => (Number.isFinite(v) ? (v < 30 ? 1 : v > 70 ? -1 : 0) : NaN));
  const r = runPositions(B, pos, start, T - 1);
  console.log(
    `RSI L=${L} revert(30/70): netSharpeAnn=${annSharpe(sharpeDaily(r.dailyNet)).toFixed(3)} exposure=${r.exposure.toFixed(2)} turnover=${r.turnover.toFixed(3)}`,
  );
}

// 3) GARCH fit sanity
const g = fitGarch11(B.ret);
console.log(
  `GARCH(1,1): omega=${g.omega.toExponential(3)} alpha=${g.alpha.toFixed(3)} beta=${g.beta.toFixed(3)} a+b=${(g.alpha + g.beta).toFixed(3)} uncondVol=${(Math.sqrt(g.uncondVar) * Math.sqrt(365)).toFixed(3)}`,
);

// 4) realized-vol regime distribution
const rv = realizedVol(B.ret, 20);
const rvf = rv.filter(Number.isFinite).sort((a, b) => a - b);
console.log(
  `RV20 quantiles (annualized): p20=${(rvf[Math.floor(rvf.length * 0.2)] * Math.sqrt(365)).toFixed(2)} p50=${(rvf[Math.floor(rvf.length * 0.5)] * Math.sqrt(365)).toFixed(2)} p80=${(rvf[Math.floor(rvf.length * 0.8)] * Math.sqrt(365)).toFixed(2)}`,
);
