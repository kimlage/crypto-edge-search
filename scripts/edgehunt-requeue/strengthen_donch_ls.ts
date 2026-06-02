/**
 * Strengthen D1-LS-DONCH: raise the per-period Sharpe (the binding DSR lever) honestly.
 * Variants tried (all causal, dollar-neutral, breakout direction = long HIGH cp):
 *   A. equal-weight legs (baseline)
 *   B. inverse-vol leg weighting (risk-parity within each leg; 20d realised vol)
 *   C. rank-weighted (linear in cp-rank, demeaned) dollar-neutral — uses the full cross-section
 *   D. cp z-score weighting (cp cross-sectionally demeaned, /xs-std) dollar-neutral
 * Each printed gross/net daily-rebalanced Sharpe over the IS window for a couple of lookbacks.
 * Pick the construction with the best NET Sharpe to carry into the gauntlet (counted in honest N).
 */
import fs from "node:fs";
const ROOT = ".";
const ANN = Math.sqrt(365);
const COST = 0.0004;
type Closes = { dates: string[]; closes: Record<string, number[]> };
const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8")) as Closes;
const dates = raw.dates; const syms = Object.keys(raw.closes); const T = dates.length; const S = syms.length;
const px: number[][] = Array.from({ length: T }, (_, t) => syms.map((s) => raw.closes[s][t]));
const fwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 0; t < T - 1; t++) for (let s = 0; s < S; s++) { const a = px[t][s], b = px[t + 1][s]; if (a > 0 && b > 0) fwd[t][s] = Math.log(b / a); }
function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1))); }
function sh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }

// daily log returns per coin (for realised vol)
const ret: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 1; t < T; t++) for (let s = 0; s < S; s++) { const a = px[t - 1][s], b = px[t][s]; if (a > 0 && b > 0) ret[t][s] = Math.log(b / a); }
function realisedVol(t: number, s: number, win = 20): number {
  const w: number[] = []; for (let k = t - win + 1; k <= t; k++) if (k >= 0 && Number.isFinite(ret[k][s])) w.push(ret[k][s]);
  if (w.length < 10) return NaN; return std(w);
}
function channelPos(N: number): number[][] {
  const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let s = 0; s < S; s++) for (let t = N; t < T; t++) {
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let k = t - N + 1; k <= t; k++) { const v = px[k][s]; if (!(v > 0)) { ok = false; break; } if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!ok || mx - mn < 1e-12) continue; cp[t][s] = (px[t][s] - mn) / (mx - mn);
  }
  return cp;
}
const firstTradable = 250; const splitIdx = firstTradable + Math.floor((T - 1 - firstTradable) * 0.8);

// generic portfolio from a weight matrix (rows sum to ~0, gross ~2)
function port(W: number[][]): { net: number[]; gross: number[]; turn: number } {
  const net: number[] = [], gross: number[] = []; let prev = new Array(S).fill(0); let ts = 0;
  for (let t = firstTradable; t < splitIdx; t++) {
    let g = 0, turn = 0, any = false;
    for (let s = 0; s < S; s++) { const p = W[t][s]; turn += Math.abs(p - prev[s]); if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; any = true; } }
    if (!any) continue; gross.push(g); net.push(g - turn * COST); ts += turn; prev = W[t].slice();
  }
  return { net, gross, turn: net.length ? ts / net.length : 0 };
}

// weight builders --------------------------------------------------
function wEqual(cp: number[][], frac: number): number[][] {
  const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const v: { s: number; c: number }[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) v.push({ s, c: cp[t][s] });
    if (v.length < 6) continue; v.sort((a, b) => a.c - b.c);
    const k = Math.max(1, Math.floor(v.length * frac));
    const L = v.slice(v.length - k), Sh = v.slice(0, k);
    for (const { s } of L) W[t][s] = 1 / L.length; for (const { s } of Sh) W[t][s] = -1 / Sh.length;
  }
  return W;
}
function wInvVol(cp: number[][], frac: number): number[][] {
  const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const v: { s: number; c: number }[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) v.push({ s, c: cp[t][s] });
    if (v.length < 6) continue; v.sort((a, b) => a.c - b.c);
    const k = Math.max(1, Math.floor(v.length * frac));
    const L = v.slice(v.length - k), Sh = v.slice(0, k);
    const iv = (s: number) => { const vv = realisedVol(t, s); return Number.isFinite(vv) && vv > 1e-6 ? 1 / vv : NaN; };
    let lsum = 0, ssum = 0; const lw: number[] = [], sw: number[] = [];
    for (const { s } of L) { const w = iv(s); lw.push(w); if (Number.isFinite(w)) lsum += w; }
    for (const { s } of Sh) { const w = iv(s); sw.push(w); if (Number.isFinite(w)) ssum += w; }
    if (lsum <= 0 || ssum <= 0) continue;
    L.forEach(({ s }, i) => { if (Number.isFinite(lw[i])) W[t][s] = lw[i] / lsum; });
    Sh.forEach(({ s }, i) => { if (Number.isFinite(sw[i])) W[t][s] = -sw[i] / ssum; });
  }
  return W;
}
function wRank(cp: number[][]): number[][] {
  const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const v: { s: number; c: number }[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) v.push({ s, c: cp[t][s] });
    const n = v.length; if (n < 6) continue; v.sort((a, b) => a.c - b.c);
    // rank in [0,1], demean to [-.5,.5], scale so sum|w|=2 (gross 2, net 0)
    const rawW = v.map((_, i) => (i / (n - 1)) - 0.5);
    const absSum = rawW.reduce((s, x) => s + Math.abs(x), 0) || 1;
    v.forEach((it, i) => { W[t][it.s] = (rawW[i] / absSum) * 2; });
  }
  return W;
}
function wZ(cp: number[][]): number[][] {
  const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const idx: number[] = [], vals: number[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) { idx.push(s); vals.push(cp[t][s]); }
    if (idx.length < 6) continue; const m = mean(vals), sd = std(vals) || 1;
    const z = vals.map((x) => (x - m) / sd); const absSum = z.reduce((s, x) => s + Math.abs(x), 0) || 1;
    idx.forEach((s, i) => { W[t][s] = (z[i] / absSum) * 2; });
  }
  return W;
}

console.log("construction  LB   frac  grossSh  netSh   turn");
for (const N of [30, 90, 120]) {
  const cp = channelPos(N);
  for (const frac of [0.2, 0.33]) {
    const e = port(wEqual(cp, frac)); console.log(`equal        ${String(N).padStart(3)}  ${frac}   ${sh(e.gross).toFixed(3).padStart(6)}  ${sh(e.net).toFixed(3).padStart(6)}  ${e.turn.toFixed(3)}`);
    const iv = port(wInvVol(cp, frac)); console.log(`invvol       ${String(N).padStart(3)}  ${frac}   ${sh(iv.gross).toFixed(3).padStart(6)}  ${sh(iv.net).toFixed(3).padStart(6)}  ${iv.turn.toFixed(3)}`);
  }
  const rk = port(wRank(cp)); console.log(`rank         ${String(N).padStart(3)}  all    ${sh(rk.gross).toFixed(3).padStart(6)}  ${sh(rk.net).toFixed(3).padStart(6)}  ${rk.turn.toFixed(3)}`);
  const zz = port(wZ(cp)); console.log(`zscore       ${String(N).padStart(3)}  all    ${sh(zz.gross).toFixed(3).padStart(6)}  ${sh(zz.net).toFixed(3).padStart(6)}  ${zz.turn.toFixed(3)}`);
}
