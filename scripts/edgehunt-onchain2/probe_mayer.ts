/**
 * O7-MAYER probe: conditional structure of forward returns by Mayer-Multiple bucket.
 * Goal: see whether low-Mayer precedes gains and high-Mayer precedes losses (the belief),
 * and whether any of it survives obvious confounds, BEFORE building the strategy grid.
 */
import { loadPricePanel } from "./price_panel.ts";

function sma(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < win) continue;
    let s = 0, ok = true;
    for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; }
    if (ok) out[i] = s / win;
  }
  return out;
}
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function std(a: number[]): number { const n = a.length; if (n < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); }

for (const asset of ["btc", "eth"] as const) {
  const P = loadPricePanel(asset);
  const ma200 = sma(P.price, 200);
  const mayer = P.price.map((p, t) => Number.isFinite(ma200[t]) && ma200[t] > 0 ? p / ma200[t] : NaN);
  const mayerL = lag(mayer, 1); // strictly causal
  const start = 220;
  console.log(`\n==== ${asset.toUpperCase()} ${P.dates[start]} -> ${P.dates[P.dates.length - 1]} (T=${P.dates.length}) ====`);
  // distribution
  const vals = mayerL.slice(start).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))];
  console.log(`Mayer pctiles: p05=${q(0.05).toFixed(2)} p25=${q(0.25).toFixed(2)} p50=${q(0.5).toFixed(2)} p75=${q(0.75).toFixed(2)} p95=${q(0.95).toFixed(2)}  min=${vals[0].toFixed(2)} max=${vals[vals.length-1].toFixed(2)}`);
  // forward-return by bucket (next-1d and next-30d cumulative)
  const buckets = [[0, 0.8], [0.8, 1.0], [1.0, 1.2], [1.2, 1.6], [1.6, 2.4], [2.4, 99]];
  console.log("bucket            n     mean1d(bps) sharpe1d   fwd30d(%)");
  for (const [lo, hi] of buckets) {
    const r1: number[] = []; const r30: number[] = [];
    for (let t = start; t < P.dates.length - 31; t++) {
      const m = mayerL[t];
      if (!(Number.isFinite(m) && m >= lo && m < hi)) continue;
      if (Number.isFinite(P.fwdRet[t])) r1.push(P.fwdRet[t]);
      let c = 0, ok = true; for (let k = 0; k < 30; k++) { const fr = P.fwdRet[t + k]; if (!Number.isFinite(fr)) { ok = false; break; } c += fr; } if (ok) r30.push(c);
    }
    const s = std(r1); const sh = s > 0 ? (mean(r1) / s) * Math.sqrt(365) : NaN;
    console.log(`[${lo.toFixed(1)},${hi === 99 ? "inf" : hi.toFixed(1)})`.padEnd(16), String(r1.length).padStart(5), (mean(r1) * 1e4).toFixed(1).padStart(11), (sh).toFixed(2).padStart(8), (mean(r30) * 100).toFixed(1).padStart(10));
  }
  // overall buy&hold sharpe on window for reference
  const bh: number[] = []; for (let t = start; t < P.dates.length - 1; t++) if (Number.isFinite(P.fwdRet[t])) bh.push(P.fwdRet[t]);
  console.log(`buy&hold ann Sharpe on window = ${((mean(bh) / std(bh)) * Math.sqrt(365)).toFixed(3)}  (n=${bh.length})`);
}
