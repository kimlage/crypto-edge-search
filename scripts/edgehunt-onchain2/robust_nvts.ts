/**
 * O3-NVTS robustness (does NOT re-consume the holdout): for the BTC best config
 * (fee, sma=30, zWin=730, band, zHi=1.5, zLo=-0.5) examine
 *   (a) per-calendar-year net Sharpe IN-SAMPLE (is the edge spread across years or one regime?),
 *   (b) surrogate p with 1000 phase-randomizations (tighter placebo),
 *   (c) sensitivity: net Sharpe across the neighborhood (sma 30/60/90, zWin 365/730, zHi 1.0/1.5/2.0)
 *       to see if the SURVIVE sits on a plateau or a spike.
 */
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import { loadNvtPanel, throughput, type NvtPanel } from "./load_nvt.ts";

const LAG = 1; const ANN = Math.sqrt(365); const COST = 0.0004;
function sma(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; let s = 0, ok = true; for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; } if (ok) out[i] = s / win; } return out; }
function rollingZ(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { const lo = Math.max(0, i - win + 1); const w: number[] = []; for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length < 60) continue; const m = w.reduce((s, v) => s + v, 0) / w.length; const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1)); out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0; } return out; }
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }
function nvtsZ(P: NvtPanel, s: number, w: number): number[] { const thr = sma(throughput(P, "fee"), s); const nv = P.marketCap.map((mc, t) => (mc > 0 && thr[t] > 0 ? mc / thr[t] : NaN)); return rollingZ(nv, w); }
function band(zL: number[], zHi: number, zLo: number): number[] { return zL.map((z) => (!Number.isFinite(z) ? NaN : z > zHi ? -1 : z < zLo ? 1 : 0)); }
function dailyNet(P: NvtPanel, pos: number[], lo: number, hi: number): number[] { const r: number[] = []; let prev = 0; for (let t = lo; t < hi; t++) { const fr = P.fwdRet[t]; const p = pos[t]; if (!Number.isFinite(fr) || !Number.isFinite(p)) continue; r.push(p * fr - Math.abs(p - prev) * COST); prev = p; } return r; }
function shOf(r: number[]): number { if (r.length < 5) return NaN; const m = r.reduce((a, b) => a + b, 0) / r.length; const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)); return (m / sd) * ANN; }

const P = loadNvtPanel("btc");
const T = P.price.length;
const startIdx = 800;
const splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8); // in-sample window (matches harness)
const z = nvtsZ(P, 30, 730);
const pos = band(lag(z, LAG), 1.5, -0.5);

// (a) per-year IN-SAMPLE
console.log("=== per-calendar-year net Sharpe (in-sample window only) ===");
const byYear = new Map<string, number[]>();
let prev = 0;
for (let t = startIdx; t < splitIdx; t++) {
  const fr = P.fwdRet[t]; const p = pos[t];
  if (!Number.isFinite(fr) || !Number.isFinite(p)) continue;
  const y = P.dates[t].slice(0, 4);
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y)!.push(p * fr - Math.abs(p - prev) * COST);
  prev = p;
}
let pos_years = 0, tot_years = 0;
for (const [y, r] of [...byYear.entries()].sort()) { const s = shOf(r); if (Number.isFinite(s)) { tot_years++; if (s > 0) pos_years++; } console.log(`  ${y}: netSharpe=${shOf(r).toFixed(2)} n=${r.length} expo=${(r.filter(Boolean).length / r.length).toFixed(2)}`); }
console.log(`  -> ${pos_years}/${tot_years} years positive`);

// (b) tighter surrogate p (1000 phase-rand) on the in-sample window
const realSh = shOf(dailyNet(P, pos, startIdx, splitIdx));
let above = 0; const NS = 1000;
for (let i = 0; i < NS; i++) { const rng = (() => { let s = (13 + i * 2654435761) >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })(); const sp = band(lag(phaseRandomize(z, rng), LAG), 1.5, -0.5); if (shOf(dailyNet(P, sp, startIdx, splitIdx)) >= realSh) above++; }
console.log(`\n=== surrogate (1000) ===  real=${realSh.toFixed(3)}  p=${((above + 1) / (NS + 1)).toFixed(4)}`);

// (c) neighborhood plateau (in-sample net Sharpe)
console.log("\n=== neighborhood net Sharpe (in-sample) ===");
for (const s of [30, 60, 90]) for (const w of [365, 730]) for (const zHi of [1.0, 1.5, 2.0]) {
  const zz = nvtsZ(P, s, w); const pp = band(lag(zz, LAG), zHi, -0.5);
  console.log(`  sma=${s} zWin=${w} zHi=${zHi}: ${shOf(dailyNet(P, pp, startIdx, splitIdx)).toFixed(3)}`);
}
