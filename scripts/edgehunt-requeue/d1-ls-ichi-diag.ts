/**
 * Diagnostics for D1-LS-ICHI: per-year Sharpe of the canonical mechanism + best grid config,
 * direction stability, and a weekly-rebalance / multi-day-hold robustness check. NO new gates;
 * this is purely to understand the OOS decay before deciding the honest final form.
 */
import fs from "node:fs";
const ROOT = ".";
const ASSETS = ["ADA", "AVAX", "BNB", "BTC", "DOGE", "ETH", "SOL", "XRP"];
const COST = 0.0004;
const ANN = Math.sqrt(365);
type Bar = { date: string; high: number; low: number; close: number };
function load(a: string) {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${a}_daily_ohlc.json`, "utf8"));
  const m = new Map<string, Bar>();
  for (const r of raw) m.set(r.date, { date: r.date, high: +r.high, low: +r.low, close: +r.close });
  return m;
}
const byA = new Map(ASSETS.map((a) => [a, load(a)]));
let common: string[] | null = null;
for (const a of ASSETS) {
  const ds = new Set(byA.get(a)!.keys());
  common = common ? common.filter((d) => ds.has(d)) : [...ds];
}
common!.sort();
const DATES = common!;
const T = DATES.length,
  A = ASSETS.length;
const close = DATES.map((d) => ASSETS.map((a) => byA.get(a)!.get(d)!.close));
const high = DATES.map((d) => ASSETS.map((a) => byA.get(a)!.get(d)!.high));
const low = DATES.map((d) => ASSETS.map((a) => byA.get(a)!.get(d)!.low));
const fwd: number[][] = [];
for (let t = 0; t < T; t++)
  fwd.push(ASSETS.map((_, j) => (t + 1 < T ? Math.log(close[t + 1][j] / close[t][j]) : NaN)));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)));
};
const shD = (a: number[]) => (std(a) > 1e-12 ? mean(a) / std(a) : 0);
function donMid(win: number) {
  const out: number[][] = Array.from({ length: T }, () => new Array(A).fill(NaN));
  for (let j = 0; j < A; j++)
    for (let t = 0; t < T; t++) {
      if (t + 1 < win) continue;
      let hi = -Infinity,
        lo = Infinity;
      for (let k = t - win + 1; k <= t; k++) {
        if (high[k][j] > hi) hi = high[k][j];
        if (low[k][j] < lo) lo = low[k][j];
      }
      out[t][j] = (hi + lo) / 2;
    }
  return out;
}
function cloudPos(tw: number, kw: number, bw: number, sh: number) {
  const tk = donMid(tw),
    kj = donMid(kw),
    sb = donMid(bw);
  const out: number[][] = Array.from({ length: T }, () => new Array(A).fill(NaN));
  for (let t = 0; t < T; t++) {
    const src = t - sh;
    if (src < 0) continue;
    for (let j = 0; j < A; j++) {
      const sa = (tk[src][j] + kj[src][j]) / 2;
      const sbb = sb[src][j];
      if (Number.isFinite(sa) && Number.isFinite(sbb) && close[t][j] > 0)
        out[t][j] = (close[t][j] - (sa + sbb) / 2) / close[t][j];
    }
  }
  return out;
}
// dollar-neutral top/bottom-K weights, optional sign flip, optional hold (rebalance every `hold` days)
function weights(sig: number[][], K: number, sign: number) {
  const W: (number[] | null)[] = [];
  for (let t = 0; t < T; t++) {
    const idx: number[] = [];
    for (let j = 0; j < A; j++) if (Number.isFinite(sig[t][j])) idx.push(j);
    if (idx.length < 6) {
      W.push(null);
      continue;
    }
    const sorted = [...idx].sort((p, q) => sig[t][p] - sig[t][q]);
    const k = Math.min(K, Math.floor(sorted.length / 2));
    const w = new Array(A).fill(0);
    for (const j of sorted.slice(sorted.length - k)) w[j] = (sign * 0.5) / k;
    for (const j of sorted.slice(0, k)) w[j] = (-sign * 0.5) / k;
    W.push(w);
  }
  return W;
}
function run(W: (number[] | null)[], lo: number, hi: number, hold: number) {
  const daily: number[] = [];
  let prev = new Array(A).fill(0);
  let held = new Array(A).fill(0);
  let sinceRebal = 1e9;
  for (let t = lo; t < hi; t++) {
    const w = W[t];
    if (!w) continue;
    let ok = true;
    for (let j = 0; j < A; j++) if (w[j] !== 0 && !Number.isFinite(fwd[t][j])) ok = false;
    if (!ok) continue;
    if (sinceRebal >= hold) {
      held = w;
      sinceRebal = 0;
    }
    sinceRebal++;
    let g = 0,
      turn = 0;
    for (let j = 0; j < A; j++) {
      g += held[j] * fwd[t][j];
      turn += Math.abs(held[j] - prev[j]);
    }
    daily.push(g - turn * COST);
    prev = held;
  }
  return daily;
}
function perYear(W: (number[] | null)[], lo: number, hi: number) {
  const buckets = new Map<string, number[]>();
  let prev = new Array(A).fill(0);
  for (let t = lo; t < hi; t++) {
    const w = W[t];
    if (!w) continue;
    let ok = true;
    for (let j = 0; j < A; j++) if (w[j] !== 0 && !Number.isFinite(fwd[t][j])) ok = false;
    if (!ok) continue;
    let g = 0,
      turn = 0;
    for (let j = 0; j < A; j++) {
      g += w[j] * fwd[t][j];
      turn += Math.abs(w[j] - prev[j]);
    }
    const y = DATES[t].slice(0, 4);
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y)!.push(g - turn * COST);
    prev = w;
  }
  return [...buckets.entries()].map(([y, r]) => `${y}:${(shD(r) * ANN).toFixed(2)}(n${r.length})`);
}

const warmup = 155;
const split = warmup + Math.floor((T - 1 - warmup) * 0.8);
console.log(`split idx=${split} date=${DATES[split]}  full window ${DATES[warmup]}..${DATES[T - 2]}`);

for (const [name, tw, kw, bw, sh, K] of [
  ["best7/22/44 K3", 7, 22, 44, 22, 3],
  ["Hosoda9/26/52 K2", 9, 26, 52, 26, 2],
  ["slow20/60/120 K3", 20, 60, 120, 30, 3],
] as [string, number, number, number, number, number][]) {
  const sig = cloudPos(tw, kw, bw, sh);
  for (const sign of [1, -1]) {
    const W = weights(sig, K, sign);
    const full = run(W, warmup, T - 1, 1);
    const is = run(W, warmup, split, 1);
    const oos = run(W, split, T - 1, 1);
    console.log(
      `\n[${name} sign=${sign > 0 ? "+momentum" : "-reversal"}] FULL Sh=${(shD(full) * ANN).toFixed(3)} IS=${(shD(is) * ANN).toFixed(3)} OOS=${(shD(oos) * ANN).toFixed(3)}`,
    );
    console.log("   peryear: " + perYear(W, warmup, T - 1).join("  "));
  }
}
// weekly hold robustness on the best momentum config
const sig = cloudPos(7, 22, 44, 22);
for (const hold of [1, 3, 5, 10]) {
  const W = weights(sig, 3, 1);
  const full = run(W, warmup, T - 1, hold);
  const oos = run(W, split, T - 1, hold);
  console.log(`hold=${hold}d  FULL Sh=${(shD(full) * ANN).toFixed(3)}  OOS Sh=${(shD(oos) * ANN).toFixed(3)}`);
}

// ---- vol-scaled dollar-neutral (risk-parity-ish) on the cloud-momentum signal ----
function realizedVol(win: number) {
  const out: number[][] = Array.from({ length: T }, () => new Array(A).fill(NaN));
  for (let j = 0; j < A; j++)
    for (let t = 0; t < T; t++) {
      if (t < win) continue;
      const r: number[] = [];
      for (let k = t - win + 1; k <= t; k++) r.push(Math.log(close[k][j] / close[k - 1][j]));
      out[t][j] = std(r);
    }
  return out;
}
function weightsVol(sig: number[][], K: number, vol: number[][]) {
  const W: (number[] | null)[] = [];
  for (let t = 0; t < T; t++) {
    const idx: number[] = [];
    for (let j = 0; j < A; j++) if (Number.isFinite(sig[t][j]) && (vol[t][j] ?? 0) > 1e-9) idx.push(j);
    if (idx.length < 6) { W.push(null); continue; }
    const sorted = [...idx].sort((p, q) => sig[t][p] - sig[t][q]);
    const k = Math.min(K, Math.floor(sorted.length / 2));
    const longs = sorted.slice(sorted.length - k), shorts = sorted.slice(0, k);
    const w = new Array(A).fill(0);
    // inverse-vol within each side, then scale each side to gross 0.5 (dollar+vol neutral-ish)
    let ls = 0, ss = 0;
    for (const j of longs) ls += 1 / vol[t][j];
    for (const j of shorts) ss += 1 / vol[t][j];
    for (const j of longs) w[j] = 0.5 * (1 / vol[t][j]) / ls;
    for (const j of shorts) w[j] = -0.5 * (1 / vol[t][j]) / ss;
    W.push(w);
  }
  return W;
}
console.log("\n=== vol-scaled (inverse-vol within side) ===");
const vol = realizedVol(20);
for (const [name, tw, kw, bw, sh, K] of [
  ["best7/22/44 K3", 7, 22, 44, 22, 3],
  ["Hosoda9/26/52 K2", 9, 26, 52, 26, 2],
] as [string, number, number, number, number, number][]) {
  const s = cloudPos(tw, kw, bw, sh);
  const W = weightsVol(s, K, vol);
  const full = run(W, warmup, T - 1, 1), is = run(W, warmup, split, 1), oos = run(W, split, T - 1, 1);
  console.log(`[${name} volscaled] FULL=${(shD(full)*ANN).toFixed(3)} IS=${(shD(is)*ANN).toFixed(3)} OOS=${(shD(oos)*ANN).toFixed(3)}`);
  console.log("   peryear: " + perYear(W, warmup, T - 1).join("  "));
}
