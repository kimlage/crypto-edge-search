/** Genuine WS-prior test: does BOCPD de-risk (CUT on run-length collapse) improve TAIL risk metrics
 * (max drawdown, Sortino, Calmar) vs matched-exposure B&H — even if Sharpe doesn't separate?
 * Evaluated on the FULL sample and on the consume-once holdout. If it only helps in-sample and the
 * surrogate null matches it, the tail-overlay claim is also a false alarm. */
import { loadBtc, type Bars } from "./data.ts";
import { runBocpd, type BocpdParams } from "./bocpd-core.ts";
import { phaseRandomize, aaftSurrogate } from "./surrogate.ts";

const COST = 0.0004;
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function downStd(a: number[]) { const d = a.filter((x) => x < 0); return d.length ? Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length) : 0; }
function sortino(a: number[], bpy: number) { const ds = downStd(a); return ds > 1e-12 ? (mean(a) / ds) * Math.sqrt(bpy) : 0; }
function sharpe(a: number[], bpy: number) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * Math.sqrt(bpy) : 0; }
function maxDD(a: number[]) { let eq = 0, peak = 0, mdd = 0; for (const r of a) { eq += r; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); } return mdd; }
function calmar(a: number[], bpy: number) { const mdd = maxDD(a); const ann = mean(a) * bpy; return mdd > 1e-9 ? ann / mdd : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function rstd(x: number[], win: number) { const o = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; const w: number[] = []; for (let k = i - win + 1; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length >= 10) o[i] = std(w); } return o; }
function standardize(ret: number[], vw: number) { const rs = rstd(ret, vw); const o = new Array(ret.length).fill(0); for (let i = 0; i < ret.length; i++) { const v = rs[i]; o[i] = Number.isFinite(ret[i]) && Number.isFinite(v) && v > 1e-9 ? ret[i] / v : 0; } return o; }

function netRets(bars: Bars, pos: number[], lo: number, hi: number) { const out: number[] = []; let prev = 0; for (let t = lo; t < hi; t++) { const fr = bars.ret[t + 1]; if (!Number.isFinite(fr) || !Number.isFinite(pos[t])) continue; out.push(pos[t] * fr - Math.abs(pos[t] - prev) * COST); prev = pos[t]; } return out; }

// CUT de-risk on run-length collapse
function cutPos(bars: Bars, sret: number[], lambda: number, cf: number, hold: number, warmup: number) {
  const p: BocpdParams = { hazardLambda: lambda, mu0: 0, kappa0: 1, alpha0: 1, beta0: 0.5, maxRunLength: 600 };
  const steps = runBocpd(sret, p); const er = steps.map((s) => s.expRunLength);
  const T = bars.ret.length; const pos = new Array(T).fill(0); let until = -1; const W = 60;
  for (let t = 0; t < T; t++) { if (t < warmup || t >= steps.length) { pos[t] = 0; continue; } let mx = 0; for (let k = Math.max(0, t - W); k < t; k++) mx = Math.max(mx, er[k]); if (mx > 10 && er[t] < cf * mx) until = t + hold; pos[t] = t <= until ? 0 : 1; }
  return pos;
}

function exposureOf(bars: Bars, pos: number[], lo: number, hi: number) { let e = 0, n = 0; for (let t = lo; t < hi; t++) if (Number.isFinite(bars.ret[t + 1])) { e += Math.abs(pos[t]); n++; } return n ? e / n : 0; }
function mexNet(bars: Bars, exp: number, lo: number, hi: number) { const out: number[] = []; for (let t = lo; t < hi; t++) { const fr = bars.ret[t + 1]; if (!Number.isFinite(fr)) continue; out.push(exp * fr); } return out; }

function report(tag: string, r: number[], bpy: number) {
  return `${tag}: Sharpe=${sharpe(r, bpy).toFixed(3)} Sortino=${sortino(r, bpy).toFixed(3)} Calmar=${calmar(r, bpy).toFixed(3)} maxDD=${maxDD(r).toFixed(3)} mean*bpy=${(mean(r) * bpy).toFixed(3)}`;
}

const bars = loadBtc(96); const bpy = 365; const warmup = 300; const T = bars.ret.length; const lo = warmup; const end = T - 1; const split = lo + Math.floor((end - lo) * 0.8);
const sret = standardize(bars.ret, 30);

console.log("=== BOCPD CUT (de-risk) tail-overlay vs MATCHED-EXPOSURE B&H ===\n");
// pick a representative de-risk config
for (const [lambda, cf, hold] of [[50, 0.4, 10], [150, 0.4, 10], [50, 0.3, 30]] as [number, number, number][]) {
  const pos = cutPos(bars, sret, lambda, cf, hold, warmup);
  const expIS = exposureOf(bars, pos, lo, split); const expOOS = exposureOf(bars, pos, split, end);
  console.log(`config l${lambda} cf${cf} h${hold}  (exposureIS=${expIS.toFixed(3)} exposureOOS=${expOOS.toFixed(3)})`);
  console.log(`  IN-SAMPLE  ${report("BOCPD-cut", netRets(bars, pos, lo, split), bpy)}`);
  console.log(`  IN-SAMPLE  ${report("matchExpBH", mexNet(bars, expIS, lo, split), bpy)}`);
  console.log(`  HOLDOUT    ${report("BOCPD-cut", netRets(bars, pos, split, end), bpy)}`);
  console.log(`  HOLDOUT    ${report("matchExpBH", mexNet(bars, expOOS, split, end), bpy)}\n`);
}

// surrogate null on the Sortino metric for the best de-risk config (does de-risk Sortino edge survive
// on series with no real change points?)
const cfg = [50, 0.4, 10] as [number, number, number];
const realPos = cutPos(bars, sret, cfg[0], cfg[1], cfg[2], warmup);
const realSortino = sortino(netRets(bars, realPos, lo, split), bpy);
const fin: number[] = []; const idx: number[] = [];
for (let i = 0; i < bars.ret.length; i++) if (Number.isFinite(bars.ret[i])) { idx.push(i); fin.push(bars.ret[i]); }
const surS: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(31 + i * 17);
  const sur = i % 2 === 0 ? phaseRandomize(fin, rng) : aaftSurrogate(fin, rng);
  const sr = bars.ret.slice(); for (let j = 0; j < idx.length; j++) sr[idx[j]] = sur[j];
  const sb: Bars = { t: bars.t, close: bars.close, ret: sr };
  const sp = cutPos(sb, standardize(sr, 30), cfg[0], cfg[1], cfg[2], warmup);
  surS.push(sortino(netRets(sb, sp, lo, split), bpy));
}
surS.sort((a, b) => a - b);
const above = surS.filter((s) => s >= realSortino).length;
console.log(`SURROGATE NULL on de-risk SORTINO (l${cfg[0]} cf${cfg[1]} h${cfg[2]}): real=${realSortino.toFixed(3)} surrMean=${mean(surS).toFixed(3)} surr95=${surS[Math.floor(200 * 0.95)].toFixed(3)} placeboP=${((above + 1) / 201).toFixed(4)}`);
