/**
 * Probe: landscape for Q8-EFFRATIO before the full gauntlet.
 * Reports, in-sample (first 80%) and full-sample:
 *   - B&H net Sharpe
 *   - ungated TSMOM (several lookbacks, long/flat and long/short)
 *   - ER-gated and ADX-gated TSMOM
 *   - the gate's time-in-market (exposure) so we know the matched-exposure control target
 */
import {
  loadDaily,
  efficiencyRatio,
  adx,
  tsmomSignal,
  runPositions,
  annSharpe,
  sharpeDaily,
  mean,
} from "./lib_q8.ts";

const D = loadDaily();
const T = D.close.length;
const WARM = 60; // warmup for indicators
const startIdx = WARM;
const tradableEnd = T - 1;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);

function sh(pos: number[], lo: number, hi: number) {
  const r = runPositions(D, pos, lo, hi);
  return {
    net: annSharpe(sharpeDaily(r.dailyNet)),
    gross: annSharpe(sharpeDaily(r.dailyGross)),
    exp: r.exposure,
    turn: r.turnover,
    meanNet: mean(r.dailyNet),
    n: r.nDays,
  };
}

console.log(`T=${T} span ${D.date[0]}..${D.date[T - 1]} startIdx=${startIdx} splitIdx=${splitIdx}`);

// B&H
const bh = new Array(T).fill(1);
const bhIS = sh(bh, startIdx, splitIdx);
const bhOOS = sh(bh, splitIdx, tradableEnd);
console.log(`\nB&H        IS net=${bhIS.net.toFixed(3)} gross=${bhIS.gross.toFixed(3)}  OOS net=${bhOOS.net.toFixed(3)}`);

console.log(`\n--- ungated TSMOM (long/flat) ---`);
for (const L of [10, 20, 30, 50, 90, 120]) {
  const sig = tsmomSignal(D.close, L, false);
  const r = sh(sig, startIdx, splitIdx);
  console.log(`L=${L}  IS net=${r.net.toFixed(3)} gross=${r.gross.toFixed(3)} exp=${r.exp.toFixed(2)} turn=${r.turn.toFixed(3)}`);
}
console.log(`\n--- ungated TSMOM (long/short) ---`);
for (const L of [10, 20, 30, 50, 90, 120]) {
  const sig = tsmomSignal(D.close, L, true);
  const r = sh(sig, startIdx, splitIdx);
  console.log(`L=${L}  IS net=${r.net.toFixed(3)} gross=${r.gross.toFixed(3)} exp=${r.exp.toFixed(2)} turn=${r.turn.toFixed(3)}`);
}

console.log(`\n--- ER-gated TSMOM (L=30 long/short), gate ER(erWin)>=thr ---`);
for (const erWin of [10, 20, 30]) {
  const er = efficiencyRatio(D.close, erWin);
  for (const thr of [0.2, 0.3, 0.4, 0.5]) {
    const base = tsmomSignal(D.close, 30, true);
    const pos = base.map((s, t) => (Number.isFinite(er[t]) && er[t] >= thr ? s : 0));
    const r = sh(pos, startIdx, splitIdx);
    console.log(`erWin=${erWin} thr=${thr}  IS net=${r.net.toFixed(3)} gross=${r.gross.toFixed(3)} exp=${r.exp.toFixed(2)} turn=${r.turn.toFixed(3)}`);
  }
}

console.log(`\n--- ADX-gated TSMOM (L=30 long/short), gate ADX(adxWin)>=thr ---`);
for (const adxWin of [14, 20, 30]) {
  const a = adx(D.high, D.low, D.close, adxWin);
  for (const thr of [20, 25, 30, 35]) {
    const base = tsmomSignal(D.close, 30, true);
    const pos = base.map((s, t) => (Number.isFinite(a[t]) && a[t] >= thr ? s : 0));
    const r = sh(pos, startIdx, splitIdx);
    console.log(`adxWin=${adxWin} thr=${thr}  IS net=${r.net.toFixed(3)} gross=${r.gross.toFixed(3)} exp=${r.exp.toFixed(2)} turn=${r.turn.toFixed(3)}`);
  }
}
