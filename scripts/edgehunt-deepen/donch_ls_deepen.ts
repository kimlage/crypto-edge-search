/**
 * D1-LS-DONCH DEEPEN — pre-registered forward consume-once of the SINGLE canonical config.
 *
 * ============================ PRE-REGISTRATION (FROZEN BEFORE RETURNS INSPECTED) ============================
 * The prior lead (output/edgehunt-requeue/SUMMARY.md) named the canonical config explicitly:
 *   "canonical pre-registered config: N=120 zscore HIGH, gross-2x, full-sample".
 * We commit EXACTLY that, once, before looking at any holdout return:
 *   - signal  : Donchian channel position cp = (px - min_N) / (max_N - min_N), N = 120 days.
 *   - weights : cross-sectional z-score of cp within each day, dollar-neutral, scaled to gross ~2x.
 *   - dir     : HIGH  (long high channel-position = breakout strength, short low).
 *   - rebal   : daily, hold t -> t+1 (causal: cp from close t, forward return t->t+1).
 *   - cost    : 4 bps taker per side on every weight change (turnover * 0.0004).
 * HONEST N = 1.  There is no grid here; one config, committed, run strictly forward.
 *
 * SELECTION SEGMENT (NEVER scored for this verdict): [firstTradable, splitIdx)  == the prior IS window.
 * FORWARD HOLDOUT (consume-once, the ONLY thing the verdict reads): [splitIdx, tradableEnd).
 *   splitIdx = firstTradable + floor((tradableEnd-firstTradable)*0.8)  -> last ~20%, 2025-05-08..2026-05-31.
 *
 * Gauntlet primitives imported directly from src/lib/training/statistical-validation.ts.
 * RIGHT null = cross-sectional shuffle (asset->cp-label permutation within each timestamp) on the HOLDOUT.
 *
 * Deliverables:
 *   (a) forward net Sharpe, DSR@N=1, Harvey-Liu adjP (xN=1), XS-shuffle surrogate p, block-bootstrap CI.
 *   (b) BETA-HEDGED holdout Sharpe (regress out {BTC, equal-weight}; trade the residual) -- the real number.
 *   (c) SURVIVORSHIP sensitivity: drop the single best holdout performer; inject a -90% delisting shock
 *       to a random held name mid-holdout; report Sharpe degradation.
 *   (d) turnover / cost realism (gross/net spread vs taker bps).
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const ANN = Math.sqrt(365);
const COST = 0.0004; // 4 bps taker / side

// ---------- FROZEN PRE-REGISTERED CONFIG (declared before any return is computed) ----------
const CANON = { N: 120, family: "zscore" as const, dir: 1 as const, grossTarget: 2 };
const HONEST_N = 1;

// ---------- data ----------
type Closes = { dates: string[]; closes: Record<string, number[]> };
const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8")) as Closes;
const dates = raw.dates; const syms = Object.keys(raw.closes); const T = dates.length; const S = syms.length;
const px: number[][] = Array.from({ length: T }, (_, t) => syms.map((s) => raw.closes[s][t]));
const BTC = syms.indexOf("BTC");

function fwdFrom(price: number[][]): number[][] {
  const f: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let t = 0; t < T - 1; t++) for (let s = 0; s < S; s++) { const a = price[t][s], b = price[t + 1][s]; if (a > 0 && b > 0) f[t][s] = Math.log(b / a); }
  return f;
}
const fwd = fwdFrom(px);
const ewFwd = new Array(T).fill(NaN);
for (let t = 0; t < T - 1; t++) { const v: number[] = []; for (let s = 0; s < S; s++) if (Number.isFinite(fwd[t][s])) v.push(fwd[t][s]); if (v.length) ewFwd[t] = v.reduce((x, y) => x + y, 0) / v.length; }

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1))); }
function sharpeDaily(a: number[]) { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function annSharpe(d: number) { return d * ANN; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function channelPos(N: number, price: number[][]): number[][] {
  const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let s = 0; s < S; s++) for (let t = N; t < T; t++) {
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let k = t - N + 1; k <= t; k++) { const v = price[k][s]; if (!(v > 0)) { ok = false; break; } if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!ok || mx - mn < 1e-12) continue; cp[t][s] = (price[t][s] - mn) / (mx - mn);
  }
  return cp;
}

// z-score dollar-neutral weights, gross ~2x (the frozen construction)
function buildW(cp: number[][], fwdMat: number[][]): number[][] {
  const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const idx: number[] = [], vals: number[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwdMat[t][s])) { idx.push(s); vals.push(CANON.dir > 0 ? cp[t][s] : -cp[t][s]); }
    const n = idx.length; if (n < 6) continue;
    const m = mean(vals), sd = std(vals) || 1; const z = vals.map((x) => (x - m) / sd);
    const aS = z.reduce((s, x) => s + Math.abs(x), 0) || 1;
    idx.forEach((s, i) => { W[t][s] = (z[i] / aS) * CANON.grossTarget; });
  }
  return W;
}

function port(W: number[][], fwdMat: number[][], lo: number, hi: number) {
  const net: number[] = [], gross: number[] = []; let prev = new Array(S).fill(0); let ts = 0, es = 0;
  for (let t = lo; t < hi; t++) {
    let g = 0, turn = 0, exp = 0, any = false;
    for (let s = 0; s < S; s++) { const p = W[t][s]; turn += Math.abs(p - prev[s]); exp += Math.abs(p); if (p !== 0 && Number.isFinite(fwdMat[t][s])) { g += p * fwdMat[t][s]; any = true; } }
    if (!any) continue; gross.push(g); net.push(g - turn * COST); ts += turn; es += exp; prev = W[t].slice();
  }
  const n = net.length; return { net, gross, turnover: n ? ts / n : 0, exposure: n ? es / n : 0 };
}
// per-day net plus aligned BTC/EW factor returns for beta-hedging
function portAligned(W: number[][], fwdMat: number[][], lo: number, hi: number) {
  const net: number[] = [], btc: number[] = [], ew: number[] = []; let prev = new Array(S).fill(0);
  for (let t = lo; t < hi; t++) {
    let g = 0, turn = 0, any = false;
    for (let s = 0; s < S; s++) { const p = W[t][s]; turn += Math.abs(p - prev[s]); if (p !== 0 && Number.isFinite(fwdMat[t][s])) { g += p * fwdMat[t][s]; any = true; } }
    if (!any) continue; net.push(g - turn * COST); btc.push(Number.isFinite(fwdMat[t][BTC]) ? fwdMat[t][BTC] : 0); ew.push(Number.isFinite(ewFwd[t]) ? ewFwd[t] : 0); prev = W[t].slice();
  }
  return { net, btc, ew };
}
// per-name contribution within the holdout (for "drop best performer")
function perNameContribution(W: number[][], fwdMat: number[][], lo: number, hi: number): number[] {
  const contrib = new Array(S).fill(0);
  for (let t = lo; t < hi; t++) for (let s = 0; s < S; s++) { const p = W[t][s]; if (p !== 0 && Number.isFinite(fwdMat[t][s])) contrib[s] += p * fwdMat[t][s]; }
  return contrib;
}

function solve(A: number[][], rhs: number[]): number[] {
  const n = rhs.length; const M = A.map((r, i) => [...r, rhs[i]]);
  for (let c = 0; c < n; c++) { let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; const d = M[c][c] || 1e-12; for (let j = c; j <= n; j++) M[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; } }
  return M.map((r) => r[n]);
}
function betaReg(y: number[], Xcols: number[][]) {
  const n = y.length, p = Xcols.length + 1;
  const X = y.map((_, i) => [1, ...Xcols.map((c) => c[i])]);
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0)); const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  const b = solve(XtX, Xty); const resid = y.map((yi, i) => yi - X[i].reduce((s, xv, a) => s + xv * b[a], 0));
  const dof = Math.max(1, n - p); const sigma2 = resid.reduce((s, r) => s + r * r, 0) / dof;
  const e0 = new Array(p).fill(0); e0[0] = 1; const inv00 = solve(XtX.map((r) => r.slice()), e0)[0];
  const seA = Math.sqrt(Math.max(1e-18, sigma2 * inv00)); const betas = b.slice(1);
  const hedged = y.map((yi, i) => yi - Xcols.reduce((acc, c, j) => acc + betas[j] * c[i], 0));
  return { alpha: b[0], alphaT: b[0] / seA, betas, hedged };
}

function shuffleCp(cp: number[][], rng: () => number, fwdMat: number[][]): number[][] {
  const out: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let t = 0; t < T; t++) {
    const idx: number[] = [], vals: number[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwdMat[t][s])) { idx.push(s); vals.push(cp[t][s]); }
    for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
    for (let i = 0; i < idx.length; i++) out[t][idx[i]] = vals[i];
  }
  return out;
}

function normalCdf(z: number) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function zSharpe(rr: number[]) { const s = summarizeReturnSeries(rr); if (s.sampleCount < 3 || s.stdDev <= 0) return 0; const sh = s.sharpe; const den = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh)); return (sh * Math.sqrt(s.sampleCount - 1)) / den; }

// ---------- split (identical to prior; selection segment is NOT scored for the verdict) ----------
const firstTradable = 250; const tradableEnd = T - 1; const holdoutFrac = 0.2;
const splitIdx = firstTradable + Math.floor((tradableEnd - firstTradable) * (1 - holdoutFrac));

// ===== BUILD THE FROZEN CONFIG (no inspection / no selection) =====
const cp = channelPos(CANON.N, px);
const W = buildW(cp, fwd);

// ----- (selection segment summary, reported for context only; NOT a gate input) -----
const isR = port(W, fwd, firstTradable, splitIdx);
const isNetSh = annSharpe(sharpeDaily(isR.net));

// ===================== (a) FORWARD consume-once on the HOLDOUT =====================
const fwdR = port(W, fwd, splitIdx, tradableEnd);
const fwdNet = fwdR.net;
const fwdNetSh = annSharpe(sharpeDaily(fwdNet));
const fwdGrossSh = annSharpe(sharpeDaily(fwdR.gross));

const dsr = computeDeflatedSharpeRatio(fwdNet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;

const bb = blockBootstrapConfidenceInterval(fwdNet, { statistic: "mean", iterations: 4000, blockLength: 20, confidenceLevel: 0.95, seed: "donch-deepen-bb" });
const bbPass = bb.lower > 0;

const psrP = 1 - normalCdf(zSharpe(fwdNet)); const adjP = Math.min(1, psrP * HONEST_N); const haircutPass = adjP < 0.05;

// XS-shuffle surrogate p on the HOLDOUT only
const nSurr = 1000; const surr: number[] = [];
for (let i = 0; i < nSurr; i++) { const rng = mkRng(91000 + i * 7919); const Ws = buildW(shuffleCp(cp, rng, fwd), fwd); surr.push(annSharpe(sharpeDaily(port(Ws, fwd, splitIdx, tradableEnd).net))); }
surr.sort((a, b) => a - b); const surrP = (surr.filter((s) => s >= fwdNetSh).length + 1) / (nSurr + 1); const surrPass = surrP < 0.05;
const surr95 = surr[Math.floor(nSurr * 0.95)];

// ===================== (b) BETA-HEDGED holdout Sharpe (the real number) =====================
const al = portAligned(W, fwd, splitIdx, tradableEnd);
const reg = betaReg(al.net, [al.btc, al.ew]);
const hedgedSh = annSharpe(sharpeDaily(reg.hedged));
const betaHedgedPass = hedgedSh > 0.4; // task threshold

// ===================== (c) SURVIVORSHIP sensitivity =====================
// (c1) drop the single best holdout performer (by per-name P&L contribution), rebuild weights excluding it.
const contrib = perNameContribution(W, fwd, splitIdx, tradableEnd);
let bestName = -1, bestC = -Infinity;
for (let s = 0; s < S; s++) if (contrib[s] > bestC) { bestC = contrib[s]; bestName = s; }
function buildWExcl(cpM: number[][], fwdMat: number[][], excl: Set<number>): number[][] {
  const Wx: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const idx: number[] = [], vals: number[] = [];
    for (let s = 0; s < S; s++) { if (excl.has(s)) continue; if (Number.isFinite(cpM[t][s]) && Number.isFinite(fwdMat[t][s])) { idx.push(s); vals.push(CANON.dir > 0 ? cpM[t][s] : -cpM[t][s]); } }
    const n = idx.length; if (n < 6) continue;
    const m = mean(vals), sd = std(vals) || 1; const z = vals.map((x) => (x - m) / sd);
    const aS = z.reduce((s, x) => s + Math.abs(x), 0) || 1;
    idx.forEach((s, i) => { Wx[t][s] = (z[i] / aS) * CANON.grossTarget; });
  }
  return Wx;
}
const Wdrop = buildWExcl(cp, fwd, new Set([bestName]));
const dropR = port(Wdrop, fwd, splitIdx, tradableEnd); const dropSh = annSharpe(sharpeDaily(dropR.net));
const dropAl = portAligned(Wdrop, fwd, splitIdx, tradableEnd); const dropHedged = annSharpe(sharpeDaily(betaReg(dropAl.net, [dropAl.btc, dropAl.ew]).hedged));

// (c2) inject a -90% delisting shock to a random HELD name mid-holdout.
// Model a delisting: at a mid-holdout date, the chosen name gaps -90% in a single day, then is untradable
// afterwards (price->NaN so it leaves the cross-section, like a real delist). Re-derive fwd & cp from the
// shocked price path and re-run the SAME frozen config. We hold the name (it is in the book) so the
// long/short leg eats the gap. Repeat over several random names/dates and report worst & median degradation.
function delistShockSharpe(seed: number): { name: string; date: string; sh: number; hedged: number } {
  const rng = mkRng(seed);
  // pick a random day in the middle 60% of the holdout
  const lo = splitIdx + Math.floor((tradableEnd - splitIdx) * 0.2);
  const hi = splitIdx + Math.floor((tradableEnd - splitIdx) * 0.8);
  const shockT = lo + Math.floor(rng() * (hi - lo));
  // pick a random name that is actually HELD (nonzero weight) at shockT and tradable
  const held: number[] = []; for (let s = 0; s < S; s++) if (W[shockT][s] !== 0 && px[shockT][s] > 0) held.push(s);
  const victim = held[Math.floor(rng() * held.length)];
  // clone price; apply -90% gap at shockT then untradable
  const px2 = px.map((row) => row.slice());
  const base = px2[shockT][victim];
  if (base > 0) { px2[shockT][victim] = base * 0.1; for (let t = shockT + 1; t < T; t++) px2[t][victim] = NaN; }
  const fwd2 = fwdFrom(px2);
  const ew2 = new Array(T).fill(NaN);
  for (let t = 0; t < T - 1; t++) { const v: number[] = []; for (let s = 0; s < S; s++) if (Number.isFinite(fwd2[t][s])) v.push(fwd2[t][s]); if (v.length) ew2[t] = v.reduce((x, y) => x + y, 0) / v.length; }
  const cp2 = channelPos(CANON.N, px2);
  const W2 = buildW(cp2, fwd2);
  const r2 = port(W2, fwd2, splitIdx, tradableEnd);
  // hedged with shocked btc/ew
  const net2: number[] = [], btc2: number[] = [], ewa2: number[] = []; let prev = new Array(S).fill(0);
  for (let t = splitIdx; t < tradableEnd; t++) {
    let g = 0, turn = 0, any = false;
    for (let s = 0; s < S; s++) { const p = W2[t][s]; turn += Math.abs(p - prev[s]); if (p !== 0 && Number.isFinite(fwd2[t][s])) { g += p * fwd2[t][s]; any = true; } }
    if (!any) continue; net2.push(g - turn * COST); btc2.push(Number.isFinite(fwd2[t][BTC]) ? fwd2[t][BTC] : 0); ewa2.push(Number.isFinite(ew2[t]) ? ew2[t] : 0); prev = W2[t].slice();
  }
  const hedged2 = annSharpe(sharpeDaily(betaReg(net2, [btc2, ewa2]).hedged));
  return { name: syms[victim], date: dates[shockT], sh: annSharpe(sharpeDaily(r2.net)), hedged: hedged2 };
}
const shocks = Array.from({ length: 12 }, (_, i) => delistShockSharpe(31337 + i * 104729));
shocks.sort((a, b) => a.sh - b.sh);
const worstShock = shocks[0]; const medShock = shocks[Math.floor(shocks.length / 2)];

// ===================== (d) turnover / cost realism =====================
const meanDailyNet = mean(fwdNet);
const costDrag = mean(fwdR.gross) - mean(fwdNet); // daily mean lost to cost
const monthlyAt100k = meanDailyNet * 21 * 100000;

// ---------- promotion logic ----------
// PROMOTE to SURVIVE only if: pre-registered config clears DSR@N=1 forward AND beta-hedged holdout Sharpe > ~0.4
// AND survivorship (drop-best AND delisting shock) does not erase it.
const survivorshipOk = dropSh > 0 && dropHedged > 0.2 && worstShock.sh > -0.2 && medShock.sh > 0;
let verdict: "SURVIVE" | "PROMISING" | "KILL";
let blocker = "none";
if (dsrPass && betaHedgedPass && survivorshipOk && fwdNetSh > 0 && surrPass) {
  verdict = "SURVIVE";
} else {
  // identify the single binding blocker in priority order
  if (!dsrPass) blocker = "deflated_sharpe@N=1_forward";
  else if (!betaHedgedPass) blocker = "beta_hedged_holdout_sharpe<0.4";
  else if (!survivorshipOk) blocker = "survivorship";
  else if (!surrPass) blocker = "xs_shuffle_surrogate";
  else blocker = "net_positive";
  // PROMISING if the core economic signal still positive & beta-neutral-ish on the forward holdout
  const corePositive = fwdNetSh > 0 && hedgedSh > 0 && surrPass && dropSh > 0;
  verdict = corePositive ? "PROMISING" : "KILL";
}

// ---------- report ----------
const out = {
  preRegistered: { ...CANON, honestN: HONEST_N },
  panel: { coins: S, first: dates[0], last: dates[T - 1], holdoutStart: dates[splitIdx], holdoutEnd: dates[tradableEnd], holdoutRows: fwdNet.length },
  selectionSegmentContext: { isNetSharpe: isNetSh, note: "NOT a gate input; shown for decay context only" },
  forward: {
    netSharpe: fwdNetSh, grossSharpe: fwdGrossSh,
    dsr: { p: dsr.deflatedProbability, pass: dsrPass, sampleShDaily: dsr.sharpe, expMaxShDaily: dsr.expectedMaxSharpe, trialCount: HONEST_N },
    harveyLiu: { psrP, adjP, pass: haircutPass },
    surrogate: { xsShuffleP: surrP, pass: surrPass, real: fwdNetSh, surrMean: mean(surr), surr95 },
    blockBootstrap: { lower: bb.lower, upper: bb.upper, pass: bbPass },
  },
  betaHedged: { alpha: reg.alpha, alphaT: reg.alphaT, betas: reg.betas, hedgedSharpe: hedgedSh, pass: betaHedgedPass },
  survivorship: {
    dropBest: { name: syms[bestName], droppedContribution: bestC, netSharpe: dropSh, hedgedSharpe: dropHedged, degradationVsBase: fwdNetSh - dropSh },
    delistShock: { worst: worstShock, median: medShock, all: shocks },
    ok: survivorshipOk,
  },
  costRealism: { turnover: fwdR.turnover, exposure: fwdR.exposure, meanDailyNet, costDragDaily: costDrag, grossMinusNetSharpe: fwdGrossSh - fwdNetSh, taker_bps_per_side: 4 },
  monthlyAt100k,
  verdict, blocker,
};
fs.writeFileSync(`${ROOT}/output/edgehunt-deepen/donch_ls_deepen_result.json`, JSON.stringify(out, null, 2));

console.log(`\n================ D1-LS-DONCH DEEPEN (pre-registered, honest N=1) ================`);
console.log(`PRE-REG: N=${CANON.N} zscore dir=HIGH dollar-neutral gross~${CANON.grossTarget}x | holdout ${dates[splitIdx]}..${dates[tradableEnd]} (${fwdNet.length} rows)`);
console.log(`[context] selection-segment net Sharpe ${isNetSh.toFixed(3)} (NOT scored)`);
console.log(`\n(a) FORWARD consume-once:`);
console.log(`   net Sharpe (ann)   = ${fwdNetSh.toFixed(3)}   gross Sharpe = ${fwdGrossSh.toFixed(3)}`);
console.log(`   DSR@N=1            = ${dsr.deflatedProbability.toFixed(4)}  ${dsrPass ? "PASS" : "FAIL"}  (sampleShDaily=${dsr.sharpe.toFixed(4)} expMax=${dsr.expectedMaxSharpe.toFixed(4)})`);
console.log(`   Harvey-Liu adjP    = ${adjP.toExponential(3)}  ${haircutPass ? "PASS" : "FAIL"}  (psrP=${psrP.toExponential(3)} xN=1)`);
console.log(`   XS-shuffle surr p  = ${surrP.toFixed(4)}  ${surrPass ? "PASS" : "FAIL"}  (real=${fwdNetSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr95.toFixed(3)})`);
console.log(`   block-boot CI95    = [${bb.lower.toExponential(3)}, ${bb.upper.toExponential(3)}]  ${bbPass ? "PASS" : "FAIL"}`);
console.log(`\n(b) BETA-HEDGED holdout (the real number):`);
console.log(`   hedged Sharpe      = ${hedgedSh.toFixed(3)}  ${betaHedgedPass ? "PASS(>0.4)" : "FAIL(<0.4)"}  alpha t=${reg.alphaT.toFixed(2)} betas[BTC,EW]=[${reg.betas.map((b) => b.toFixed(3)).join(",")}]`);
console.log(`\n(c) SURVIVORSHIP:`);
console.log(`   drop best name(${syms[bestName]}) -> net Sharpe ${dropSh.toFixed(3)} (hedged ${dropHedged.toFixed(3)}); degradation ${(fwdNetSh - dropSh).toFixed(3)}`);
console.log(`   delist -90% shock: worst ${worstShock.name}@${worstShock.date} net ${worstShock.sh.toFixed(3)} (hedged ${worstShock.hedged.toFixed(3)}); median net ${medShock.sh.toFixed(3)}`);
console.log(`   survivorship OK    = ${survivorshipOk}`);
console.log(`\n(d) COST REALISM:`);
console.log(`   turnover/day ${fwdR.turnover.toFixed(3)} exposure ${fwdR.exposure.toFixed(3)} | gross-net Sharpe gap ${(fwdGrossSh - fwdNetSh).toFixed(3)} | meanDailyNet ${meanDailyNet.toExponential(3)} | monthly@100k $${Math.round(monthlyAt100k)}`);
console.log(`\nVERDICT: ${verdict} | net Sharpe ${fwdNetSh.toFixed(3)} | binding gate ${blocker} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(4)} | monthly@$100k $${Math.round(monthlyAt100k)}`);
