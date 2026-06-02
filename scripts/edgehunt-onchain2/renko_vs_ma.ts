/**
 * Decisive control (backlog key separator for HA/Renko): does the Renko brick transform add
 * anything over an EQUIVALENTLY-LAGGED moving-average trend filter on the same daily closes?
 * If a plain MA long-flat (price>SMA) with matched responsiveness equals/beats Renko, the brick
 * transform contributes no Renko-specific edge — it is an MA-in-disguise / path artifact.
 *
 * Also: evaluate the strengthened-best Renko config (3% brick, 2-brick reversal) PRE-COMMITTED at
 * N=1 across the FULL sample, in-sample window, and consume-once holdout, with its own B&H per
 * window — the honest "is there any survivable version" check.
 */
import {
  loadBars15m,
  dailyCloseFrom15m,
  renkoDirections,
  fixedPctBrick,
} from "./renko_lib.ts";

const COST = 0.0004;
const ANN = Math.sqrt(365);
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const shAnn = (a: number[]) => (std(a) > 1e-12 ? (mean(a) / std(a)) * ANN : 0);

function run(fwd: number[], pos: number[], lo: number, hi: number) {
  const net: number[] = [];
  let prev = 0,
    turn = 0,
    n = 0,
    long = 0;
  for (let t = lo; t < hi; t++) {
    if (!Number.isFinite(fwd[t]) || !Number.isFinite(pos[t])) continue;
    const tr = Math.abs(pos[t] - prev);
    net.push(pos[t] * fwd[t] - tr * COST);
    turn += tr;
    if (pos[t] > 0) long++;
    prev = pos[t];
    n++;
  }
  return { sh: shAnn(net), turnover: n ? turn / n : 0, longShare: n ? long / n : 0, n, meanDaily: mean(net) };
}

const bars = loadBars15m();
const close15 = bars.map((b) => b.close);
const { dates, idxLastBarOfDay } = dailyCloseFrom15m(bars);
const T = dates.length;
const dc = idxLastBarOfDay.map((i) => close15[i]);
const fwd: number[] = [];
for (let t = 0; t < T; t++) fwd.push(t + 1 < T ? Math.log(dc[t + 1] / dc[t]) : NaN);

const startIdx = 60;
const splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8);
const tradableEnd = T - 1;

// --- Renko best (3% brick, rev2) on 15m, projected to daily long-flat ---
const brick = fixedPctBrick(close15, 3.0);
const st = renkoDirections(close15, brick, 2);
const renkoPos = idxLastBarOfDay.map((i) => (st.dirAtBar[i] > 0 ? 1 : 0));

// --- MA filters on DAILY close (causal: pos[t] from close[t] vs SMA[t]) ---
function smaPos(win: number): number[] {
  const out = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    if (t + 1 < win) continue;
    let s = 0;
    for (let k = t - win + 1; k <= t; k++) s += dc[k];
    out[t] = dc[t] > s / win ? 1 : 0;
  }
  return out;
}

const bhPos = new Array(T).fill(1);

console.log("=== O8-RENKO: Renko-best (pct3/rev2) vs equivalently-lagged MA + B&H ===");
console.log(`window: in-sample [${startIdx},${splitIdx}) holdout [${splitIdx},${tradableEnd})`);
const windows: [string, number, number][] = [
  ["FULL", startIdx, tradableEnd],
  ["IN-SAMPLE", startIdx, splitIdx],
  ["HOLDOUT", splitIdx, tradableEnd],
];
for (const [wn, lo, hi] of windows) {
  const r = run(fwd, renkoPos, lo, hi);
  const bh = run(fwd, bhPos, lo, hi);
  const mas = [10, 20, 50, 100].map((w) => ({ w, ...run(fwd, smaPos(w), lo, hi) }));
  console.log(`\n[${wn}]  Renko(pct3,rev2) Sharpe=${r.sh.toFixed(3)} turn=${r.turnover.toFixed(3)} longShare=${r.longShare.toFixed(2)} | own B&H Sharpe=${bh.sh.toFixed(3)}`);
  for (const m of mas)
    console.log(`        SMA${m.w}d Sharpe=${m.sh.toFixed(3)} turn=${m.turnover.toFixed(3)} longShare=${m.longShare.toFixed(2)}`);
}
