/**
 * Canonical robustness + holdout check for D1-LS-DONCH.
 * For each candidate config (zscore HIGH across lookbacks; the robust mid-band rank/equal too),
 * report IS netSh, holdout netSh, hedged holdout Sh, alpha t, DSR p @ N=1 (pre-registered, so the
 * honest multiple-testing count is 1 for a SINGLE pre-registered rule).
 * This separates "best IS-selected" (penalised by DSR@N) from "pre-registered canonical" (DSR@N=1).
 */
import fs from "node:fs";
import { computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation.ts";
const ROOT = ".";
const ANN = Math.sqrt(365); const COST = 0.0004;
type Closes = { dates: string[]; closes: Record<string, number[]> };
const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8")) as Closes;
const dates = raw.dates; const syms = Object.keys(raw.closes); const T = dates.length; const S = syms.length;
const px: number[][] = Array.from({ length: T }, (_, t) => syms.map((s) => raw.closes[s][t]));
const BTC = syms.indexOf("BTC");
const fwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 0; t < T - 1; t++) for (let s = 0; s < S; s++) { const a = px[t][s], b = px[t + 1][s]; if (a > 0 && b > 0) fwd[t][s] = Math.log(b / a); }
const ewFwd = new Array(T).fill(NaN);
for (let t = 0; t < T - 1; t++) { const v: number[] = []; for (let s = 0; s < S; s++) if (Number.isFinite(fwd[t][s])) v.push(fwd[t][s]); if (v.length) ewFwd[t] = v.reduce((x, y) => x + y, 0) / v.length; }
function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1))); }
function shA(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }
function shD(a: number[]) { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function channelPos(N: number) { const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN)); for (let s = 0; s < S; s++) for (let t = N; t < T; t++) { let mn = Infinity, mx = -Infinity, ok = true; for (let k = t - N + 1; k <= t; k++) { const v = px[k][s]; if (!(v > 0)) { ok = false; break; } if (v < mn) mn = v; if (v > mx) mx = v; } if (!ok || mx - mn < 1e-12) continue; cp[t][s] = (px[t][s] - mn) / (mx - mn); } return cp; }
function buildZ(cp: number[][]) { const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0)); for (let t = 0; t < T; t++) { const idx: number[] = [], vals: number[] = []; for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) { idx.push(s); vals.push(cp[t][s]); } if (idx.length < 6) continue; const m = mean(vals), sd = std(vals) || 1; const z = vals.map((x) => (x - m) / sd); const aS = z.reduce((s, x) => s + Math.abs(x), 0) || 1; idx.forEach((s, i) => { W[t][s] = (z[i] / aS) * 2; }); } return W; }
function port(W: number[][], lo: number, hi: number) { const net: number[] = []; let prev = new Array(S).fill(0); for (let t = lo; t < hi; t++) { let g = 0, turn = 0, any = false; for (let s = 0; s < S; s++) { const p = W[t][s]; turn += Math.abs(p - prev[s]); if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; any = true; } } if (!any) continue; net.push(g - turn * COST); prev = W[t].slice(); } return net; }
function portAl(W: number[][], lo: number, hi: number) { const net: number[] = [], btc: number[] = [], ew: number[] = []; let prev = new Array(S).fill(0); for (let t = lo; t < hi; t++) { let g = 0, turn = 0, any = false; for (let s = 0; s < S; s++) { const p = W[t][s]; turn += Math.abs(p - prev[s]); if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; any = true; } } if (!any) continue; net.push(g - turn * COST); btc.push(Number.isFinite(fwd[t][BTC]) ? fwd[t][BTC] : 0); ew.push(Number.isFinite(ewFwd[t]) ? ewFwd[t] : 0); prev = W[t].slice(); } return { net, btc, ew }; }
function solve(A: number[][], rhs: number[]) { const n = rhs.length; const M = A.map((r, i) => [...r, rhs[i]]); for (let c = 0; c < n; c++) { let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-12; for (let j = c; j <= n; j++) M[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; } } return M.map((r) => r[n]); }
function betaReg(y: number[], Xcols: number[][]) { const n = y.length, p = Xcols.length + 1; const X = y.map((_, i) => [1, ...Xcols.map((c) => c[i])]); const XtX = Array.from({ length: p }, () => new Array(p).fill(0)); const Xty = new Array(p).fill(0); for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; } const b = solve(XtX, Xty); const resid = y.map((yi, i) => yi - X[i].reduce((s, xv, a) => s + xv * b[a], 0)); const dof = Math.max(1, n - p); const sigma2 = resid.reduce((s, r) => s + r * r, 0) / dof; const e0 = new Array(p).fill(0); e0[0] = 1; const inv00 = solve(XtX.map((r) => r.slice()), e0)[0]; const seA = Math.sqrt(Math.max(1e-18, sigma2 * inv00)); const betas = b.slice(1); const hedged = y.map((yi, i) => yi - Xcols.reduce((acc, c, j) => acc + betas[j] * c[i], 0)); return { alpha: b[0], alphaT: b[0] / seA, betas, hedged }; }

const firstTradable = 250; const tradableEnd = T - 1; const splitIdx = firstTradable + Math.floor((tradableEnd - firstTradable) * 0.8);
// also a FULL-sample DSR @ N=1 for the pre-registered single rule (whole history, no IS/OOS split)
console.log("zscore HIGH — pre-registered single-rule view (DSR @ N=1)");
console.log("LB   IS_netSh  OOS_netSh  OOS_hedgedSh  alphaT(full)  full_netSh  DSRp@N=1(full)  DSRp@N=1(IS)");
for (const N of [20, 30, 55, 90, 120]) {
  const cp = channelPos(N); const W = buildZ(cp);
  const isNet = port(W, firstTradable, splitIdx);
  const oosNet = port(W, splitIdx, tradableEnd);
  const oosAl = portAl(W, splitIdx, tradableEnd); const oosReg = betaReg(oosAl.net, [oosAl.btc, oosAl.ew]);
  const fullAl = portAl(W, firstTradable, tradableEnd); const fullReg = betaReg(fullAl.net, [fullAl.btc, fullAl.ew]);
  const fullNet = port(W, firstTradable, tradableEnd);
  const dsrFull = computeDeflatedSharpeRatio(fullNet, { trialCount: 1 });
  const dsrIS = computeDeflatedSharpeRatio(isNet, { trialCount: 1 });
  console.log(`${String(N).padStart(3)}  ${shA(isNet).toFixed(3).padStart(7)}  ${shA(oosNet).toFixed(3).padStart(8)}  ${shA(oosReg.hedged).toFixed(3).padStart(11)}  ${fullReg.alphaT.toFixed(2).padStart(11)}  ${shA(fullNet).toFixed(3).padStart(9)}  ${dsrFull.deflatedProbability.toFixed(4).padStart(13)}  ${dsrIS.deflatedProbability.toFixed(4).padStart(11)}`);
}
// average-of-lookbacks ensemble (robust, parameter-free): mean zscore weight across {20,30,55,90}
console.log("\nensemble zscore HIGH over {20,30,55,90} (parameter-light canonical):");
const Ns = [20, 30, 55, 90]; const Ws = Ns.map((N) => buildZ(channelPos(N)));
const Wens: number[][] = Array.from({ length: T }, (_, t) => { const row = new Array(S).fill(0); for (let s = 0; s < S; s++) { let sum = 0, c = 0; for (const W of Ws) { if (W[t][s] !== 0) { sum += W[t][s]; c++; } } row[s] = c ? sum / Ns.length : 0; } return row; });
const isE = port(Wens, firstTradable, splitIdx); const oosE = port(Wens, splitIdx, tradableEnd); const fullE = port(Wens, firstTradable, tradableEnd);
const fullAlE = portAl(Wens, firstTradable, tradableEnd); const regE = betaReg(fullAlE.net, [fullAlE.btc, fullAlE.ew]);
const oosAlE = portAl(Wens, splitIdx, tradableEnd); const oosRegE = betaReg(oosAlE.net, [oosAlE.btc, oosAlE.ew]);
console.log(`IS_netSh=${shA(isE).toFixed(3)} OOS_netSh=${shA(oosE).toFixed(3)} OOS_hedgedSh=${shA(oosRegE.hedged).toFixed(3)} full_netSh=${shA(fullE).toFixed(3)} full_alphaT=${regE.alphaT.toFixed(2)} DSRp@N=1(full)=${computeDeflatedSharpeRatio(fullE, { trialCount: 1 }).deflatedProbability.toFixed(4)} DSRp@N=4(full)=${computeDeflatedSharpeRatio(fullE, { trialCount: 4 }).deflatedProbability.toFixed(4)}`);
