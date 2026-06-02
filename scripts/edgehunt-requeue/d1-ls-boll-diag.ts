/**
 * Diagnostic for D1-LS-BOLL (no re-selection; purely descriptive sub-period stability).
 * Reuses the exact panel + weight builder logic to report per-calendar-year net Sharpe for
 * (a) the literal-spec reversion canonical and (b) the in-sample-best trend-on-%b config,
 * to characterize WHY the edge fails the consume-once holdout.
 */
import fs from "node:fs";
const ROOT = ".";
const COST = 0.0004; const ANN = Math.sqrt(365);
const MAJORS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "AVAX", "DOGE"];

const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8"));
const allDates: string[] = raw.dates; const closesAll = raw.closes;
let start = 0;
for (let t = 0; t < allDates.length; t++) { let ok = true; for (const a of MAJORS) { const v = closesAll[a]?.[t]; if (!(typeof v === "number" && v > 0)) { ok = false; break; } } if (ok) { start = t; break; } }
const dates = allDates.slice(start); const T = dates.length; const A = MAJORS.length;
const close = MAJORS.map((a) => closesAll[a].slice(start).map((v: any) => Number(v)));
for (let ai = 0; ai < A; ai++) for (let t = 0; t < T; t++) if (!(close[ai][t] > 0)) close[ai][t] = t > 0 ? close[ai][t - 1] : NaN;
const ret = MAJORS.map((_, ai) => { const r = new Array(T).fill(NaN); for (let t = 1; t < T; t++) r[t] = Math.log(close[ai][t] / close[ai][t - 1]); return r; });

function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function rms(x: number[], win: number, t: number) { if (t + 1 < win) return null; let s = 0; const b: number[] = []; for (let k = t - win + 1; k <= t; k++) { if (!Number.isFinite(x[k])) return null; s += x[k]; b.push(x[k]); } const m = s / win; let v = 0; for (const q of b) v += (q - m) ** 2; return { m, sd: Math.sqrt(v / (win - 1)) }; }

function pctB(n: number, k: number) { const lp = close.map((c) => c.map((v) => Math.log(v))); const o = MAJORS.map(() => new Array(T).fill(NaN)); for (let ai = 0; ai < A; ai++) for (let t = 0; t < T; t++) { const ms = rms(lp[ai], n, t); if (!ms || ms.sd <= 1e-12) continue; o[ai][t] = (lp[ai][t] - ms.m) / (k * ms.sd); } return o; }

function weights(sig: number[][], dir: number, smooth: number) {
  let s = sig;
  if (smooth > 1) { s = sig.map((row) => { const o = new Array(T).fill(NaN); for (let t = 0; t < T; t++) { if (t + 1 < smooth) continue; let ss = 0, ok = true; for (let kk = t - smooth + 1; kk <= t; kk++) { if (!Number.isFinite(row[kk])) { ok = false; break; } ss += row[kk]; } if (ok) o[t] = ss / smooth; } return o; }); }
  const W = MAJORS.map(() => new Array(T).fill(0));
  for (let t = 0; t < T; t++) { const vals: { ai: number; v: number }[] = []; for (let ai = 0; ai < A; ai++) { const v = s[ai][t]; if (Number.isFinite(v)) vals.push({ ai, v }); } if (vals.length < 4) continue; const m = mean(vals.map((x) => x.v)); const sd = std(vals.map((x) => x.v)) || 1; const rawW = vals.map((x) => ({ ai: x.ai, w: dir * (-(x.v - m) / sd) })); const wm = mean(rawW.map((x) => x.w)); let g = 0; for (const r of rawW) { r.w -= wm; g += Math.abs(r.w); } if (g < 1e-12) continue; for (const r of rawW) W[r.ai][t] = r.w / g; }
  return W;
}

function yearlySharpe(W: number[][], startT: number) {
  const byYear: Record<string, number[]> = {};
  const prevW = new Array(A).fill(0);
  for (let t = startT; t < T - 1; t++) { let g = 0, turn = 0, any = false; for (let ai = 0; ai < A; ai++) { const w = W[ai][t]; const r = ret[ai][t + 1]; if (Number.isFinite(w) && Number.isFinite(r)) { g += w * r; any = true; } turn += Math.abs((Number.isFinite(w) ? w : 0) - prevW[ai]); } if (!any) continue; const net = g - turn * COST; const yr = dates[t].slice(0, 4); (byYear[yr] ??= []).push(net); for (let ai = 0; ai < A; ai++) prevW[ai] = Number.isFinite(W[ai][t]) ? W[ai][t] : 0; }
  const out: Record<string, { sh: number; n: number; cum: number }> = {};
  for (const [yr, arr] of Object.entries(byYear)) { const sd = std(arr); out[yr] = { sh: sd > 1e-12 ? (mean(arr) / sd) * ANN : 0, n: arr.length, cum: arr.reduce((s, v) => s + v, 0) }; }
  return out;
}

const startT = 65;
const splitDate = "2025-04-23";
console.log(`Holdout boundary ~ ${splitDate}\n`);
const reversion = weights(pctB(20, 2), 1, 1);   // literal spec canonical
const trendBest = weights(pctB(10, 2), -1, 1);  // IS-best trend-on-%b
console.log("LITERAL REVERSION (n=20, dir=+1) yearly net Sharpe:");
for (const [yr, v] of Object.entries(yearlySharpe(reversion, startT))) console.log(`  ${yr}: sh=${v.sh.toFixed(2)}  cumNet=${(v.cum * 100).toFixed(1)}%  n=${v.n}`);
console.log("\nTREND-ON-%b (n=10, dir=-1, IS-best) yearly net Sharpe:");
for (const [yr, v] of Object.entries(yearlySharpe(trendBest, startT))) console.log(`  ${yr}: sh=${v.sh.toFixed(2)}  cumNet=${(v.cum * 100).toFixed(1)}%  n=${v.n}`);
