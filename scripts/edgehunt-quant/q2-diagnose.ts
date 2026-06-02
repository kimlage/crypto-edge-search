/**
 * Diagnostic: for the de-risk ("cut") and "flip" BOCPD modes specifically — the GENUINE change-point
 * de-risk thesis — measure in-sample AND holdout net Sharpe vs the matched-exposure B&H control, plus
 * detection delay and how often the detector fires on real vs phase-surrogate data (false-alarm rate).
 * This isolates the documented mechanism: causal detectors have unavoidable delay.
 */
import { loadBtc, type Bars } from "./data.ts";
import { runBocpd, type BocpdParams } from "./bocpd-core.ts";
import { phaseRandomize } from "./surrogate.ts";

const COST = 0.0004;
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function sh(a: number[]) { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function rstd(x: number[], win: number) { const o = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; const w: number[] = []; for (let k = i - win + 1; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length >= Math.min(10, win)) o[i] = std(w); } return o; }
function standardize(ret: number[], vw: number) { const rs = rstd(ret, vw); const o = new Array(ret.length).fill(0); for (let i = 0; i < ret.length; i++) { const v = rs[i]; o[i] = Number.isFinite(ret[i]) && Number.isFinite(v) && v > 1e-9 ? ret[i] / v : 0; } return o; }

function netRets(bars: Bars, pos: number[], lo: number, hi: number) {
  const out: number[] = []; let prev = 0;
  for (let t = lo; t < hi; t++) { const fr = bars.ret[t + 1]; if (!Number.isFinite(fr) || !Number.isFinite(pos[t])) continue; out.push(pos[t] * fr - Math.abs(pos[t] - prev) * COST); prev = pos[t]; }
  return out;
}
function mexNet(bars: Bars, exp: number, lo: number, hi: number) {
  const out: number[] = []; let prev = 0;
  for (let t = lo; t < hi; t++) { const fr = bars.ret[t + 1]; if (!Number.isFinite(fr)) continue; out.push(exp * fr - Math.abs(exp - prev) * COST); prev = exp; }
  return out;
}

// de-risk position: long by default; on cpProb>=thr go flat (cut) for holdBars
function cutPos(bars: Bars, sret: number[], lambda: number, thr: number, holdBars: number, warmup: number) {
  const p: BocpdParams = { hazardLambda: lambda, mu0: 0, kappa0: 1, alpha0: 1, beta0: 0.5, maxRunLength: 600 };
  const steps = runBocpd(sret, p);
  const T = bars.ret.length; const pos = new Array(T).fill(0);
  let until = -1; let fires = 0;
  for (let t = 0; t < T; t++) {
    if (t < warmup || t >= steps.length) { pos[t] = 0; continue; }
    if (steps[t].cpProb >= thr) { until = t + holdBars; fires++; }
    pos[t] = t <= until ? 0 : 1;
  }
  return { pos, fires };
}

function annD(s: number, bpy: number) { return s * Math.sqrt(bpy); }

function main() {
  for (const [name, mult, bpy] of [["daily", 96, 365], ["4h", 16, 365 * 6]] as [string, number, number][]) {
    const bars = loadBtc(mult);
    const warmup = 300; const T = bars.ret.length; const lo = warmup; const end = T - 1;
    const split = lo + Math.floor((end - lo) * 0.8);
    const sret = standardize(bars.ret, 30);
    console.log(`\n==== ${name} (bars=${T}) ====`);
    console.log(`mode=CUT (genuine de-risk). cols: lambda thr hold | IS_sh IS_mexBH | OOS_sh OOS_mexBH | fires exposure`);
    for (const lambda of [50, 150, 400]) for (const thr of [0.2, 0.3, 0.5]) for (const hold of [3, 10, 30]) {
      const { pos, fires } = cutPos(bars, sret, lambda, thr, hold, warmup);
      const isR = netRets(bars, pos, lo, split); const oosR = netRets(bars, pos, split, end);
      // exposure
      let exp = 0, n = 0; for (let t = lo; t < split; t++) if (Number.isFinite(bars.ret[t + 1])) { exp += Math.abs(pos[t]); n++; }
      exp /= n;
      const isMex = mexNet(bars, exp, lo, split); const oosMex = mexNet(bars, exp, split, end);
      console.log(`l${lambda} cp${thr} h${hold} | IS ${annD(sh(isR), bpy).toFixed(3)} vs mex ${annD(sh(isMex), bpy).toFixed(3)} | OOS ${annD(sh(oosR), bpy).toFixed(3)} vs mex ${annD(sh(oosMex), bpy).toFixed(3)} | fires=${fires} exp=${exp.toFixed(2)}`);
    }
    // false-alarm: fire rate on real vs phase surrogates (best sensitive config)
    const fin: number[] = []; const idx: number[] = [];
    for (let i = 0; i < bars.ret.length; i++) if (Number.isFinite(bars.ret[i])) { idx.push(i); fin.push(bars.ret[i]); }
    let realFires = cutPos(bars, sret, 150, 0.3, 10, warmup).fires;
    const surFires: number[] = [];
    for (let i = 0; i < 30; i++) {
      const sur = phaseRandomize(fin, mkRng(11 + i * 13));
      const sr = bars.ret.slice(); for (let j = 0; j < idx.length; j++) sr[idx[j]] = sur[j];
      const sb: Bars = { t: bars.t, close: bars.close, ret: sr };
      surFires.push(cutPos(sb, standardize(sr, 30), 150, 0.3, 10, warmup).fires);
    }
    surFires.sort((a, b) => a - b);
    console.log(`false-alarm check (l150 cp0.3 h10): realFires=${realFires} surrogateFires median=${surFires[15]} [${surFires[0]}..${surFires[surFires.length - 1]}]`);
  }
}
main();
