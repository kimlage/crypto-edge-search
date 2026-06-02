import { loadBTC, DETECTOR_NAMES, signalSeries, buildPosition, runPositions, annSharpe, sharpeDaily, mean, std, type Cfg } from "./d1-candle-harness.ts";

const b = loadBTC();
const T = b.close.length;
console.log(`BTC daily: ${T} bars, ${b.dates[0]} -> ${b.dates[T - 1]}`);

// next-day forward return conditional on each pattern (raw directional, both dirs), trendWin=20
const trendWin = 20;
console.log(`\nPer-pattern raw next-day edge (trendWin=${trendWin}, hold=1, dir=both):`);
console.log("pattern             nLong nShort  meanFwd(signed)  hitRate  netSharpeAnn");
for (const p of DETECTOR_NAMES) {
  const cfg: Cfg = { pattern: p, trendWin, hold: 1, dir: "both" };
  const sig = signalSeries(b, cfg);
  let nL = 0, nS = 0; const signed: number[] = []; let hits = 0, tot = 0;
  for (let t = 0; t < T - 1; t++) {
    if (sig[t] === 0 || !Number.isFinite(b.fwdRet[t])) continue;
    if (sig[t] > 0) nL++; else nS++;
    const r = sig[t] * b.fwdRet[t]; signed.push(r); tot++; if (r > 0) hits++;
  }
  const pos = buildPosition(b, cfg);
  const res = runPositions(b, pos, trendWin, T - 1);
  const sh = annSharpe(sharpeDaily(res.dailyNet));
  console.log(`${p.padEnd(18)} ${String(nL).padStart(5)} ${String(nS).padStart(6)}  ${(mean(signed) * 1e4).toFixed(1).padStart(8)}bps  ${(tot ? hits / tot : 0).toFixed(3)}    ${sh.toFixed(3)}`);
}

// "all" combined
const cfgAll: Cfg = { pattern: "all", trendWin, hold: 1, dir: "both" };
const posAll = buildPosition(b, cfgAll);
const resAll = runPositions(b, posAll, trendWin, T - 1);
console.log(`\nALL combined: nSignalDays=${resAll.nSignalDays} netSharpeAnn=${annSharpe(sharpeDaily(resAll.dailyNet)).toFixed(3)} exposure=${resAll.exposure.toFixed(3)} turnover=${resAll.turnover.toFixed(3)}`);

// buy & hold reference
const bh = runPositions(b, new Array(T).fill(1), trendWin, T - 1);
console.log(`Buy&Hold: netSharpeAnn=${annSharpe(sharpeDaily(bh.dailyNet)).toFixed(3)} meanDaily=${(mean(bh.dailyNet) * 1e4).toFixed(2)}bps`);
void std;
