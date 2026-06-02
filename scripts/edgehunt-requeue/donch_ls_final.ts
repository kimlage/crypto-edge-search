/**
 * D1-LS-DONCH FINAL — cross-sectional Donchian channel-position long-short, committed gauntlet.
 *
 * Construction families considered (ALL counted in honest N):
 *   - tail equal-weight  (long top-frac cp, short bottom-frac cp), frac in {0.2,0.33}
 *   - tail inverse-vol   (risk-parity legs)
 *   - rank-weighted      (linear cp-rank, dollar-neutral, full cross-section)
 *   - zscore-weighted    (cp cross-sectionally standardised, dollar-neutral) <- strengthened primary
 *   directions {HIGH=breakout (theory), LOW=reversal placebo}, lookbacks {10,20,30,55,90,120}.
 * HONEST N counts every (family x dir x lookback x frac) cell evaluated across the whole study.
 *
 * Gauntlet primitives imported directly from src/lib/training/statistical-validation.ts.
 * RIGHT null = cross-sectional shuffle (asset->cp-label permutation within each timestamp).
 * Plus beta-neutrality (alpha t-stat vs {BTC, equal-weight basket}) and consume-once holdout.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const ANN = Math.sqrt(365);
const COST = 0.0004;

type Closes = { dates: string[]; closes: Record<string, number[]> };
const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8")) as Closes;
const dates = raw.dates; const syms = Object.keys(raw.closes); const T = dates.length; const S = syms.length;
const px: number[][] = Array.from({ length: T }, (_, t) => syms.map((s) => raw.closes[s][t]));
const BTC = syms.indexOf("BTC");
const fwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 0; t < T - 1; t++) for (let s = 0; s < S; s++) { const a = px[t][s], b = px[t + 1][s]; if (a > 0 && b > 0) fwd[t][s] = Math.log(b / a); }
const ret: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 1; t < T; t++) for (let s = 0; s < S; s++) { const a = px[t - 1][s], b = px[t][s]; if (a > 0 && b > 0) ret[t][s] = Math.log(b / a); }
const ewFwd = new Array(T).fill(NaN);
for (let t = 0; t < T - 1; t++) { const v: number[] = []; for (let s = 0; s < S; s++) if (Number.isFinite(fwd[t][s])) v.push(fwd[t][s]); if (v.length) ewFwd[t] = v.reduce((x, y) => x + y, 0) / v.length; }

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1))); }
function sharpeDaily(a: number[]) { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function annSharpe(d: number) { return d * ANN; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function realisedVol(t: number, s: number, win = 20) { const w: number[] = []; for (let k = t - win + 1; k <= t; k++) if (k >= 0 && Number.isFinite(ret[k][s])) w.push(ret[k][s]); if (w.length < 10) return NaN; return std(w); }
function channelPos(N: number): number[][] {
  const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let s = 0; s < S; s++) for (let t = N; t < T; t++) {
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let k = t - N + 1; k <= t; k++) { const v = px[k][s]; if (!(v > 0)) { ok = false; break; } if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!ok || mx - mn < 1e-12) continue; cp[t][s] = (px[t][s] - mn) / (mx - mn);
  }
  return cp;
}

type Family = "equal" | "invvol" | "rank" | "zscore";
interface Cfg { N: number; family: Family; frac: number; dir: number }

// build weight matrix from cp (cp already direction-agnostic; dir flips long/short)
function buildW(cp: number[][], cfg: Cfg): number[][] {
  const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const idx: number[] = [], vals: number[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) { idx.push(s); vals.push(cfg.dir > 0 ? cp[t][s] : -cp[t][s]); }
    const n = idx.length; if (n < 6) continue;
    if (cfg.family === "zscore") {
      const m = mean(vals), sd = std(vals) || 1; const z = vals.map((x) => (x - m) / sd);
      const aS = z.reduce((s, x) => s + Math.abs(x), 0) || 1; idx.forEach((s, i) => { W[t][s] = (z[i] / aS) * 2; });
    } else if (cfg.family === "rank") {
      const order = idx.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
      const rw = new Array(n).fill(0); order.forEach((oi, r) => { rw[oi] = (r / (n - 1)) - 0.5; });
      const aS = rw.reduce((s, x) => s + Math.abs(x), 0) || 1; idx.forEach((s, i) => { W[t][s] = (rw[i] / aS) * 2; });
    } else {
      const pairs = idx.map((s, i) => ({ s, v: vals[i] })).sort((a, b) => a.v - b.v);
      const k = Math.max(1, Math.floor(n * cfg.frac));
      const L = pairs.slice(n - k), Sh = pairs.slice(0, k);
      if (cfg.family === "invvol") {
        const iv = (s: number) => { const vv = realisedVol(t, s); return Number.isFinite(vv) && vv > 1e-6 ? 1 / vv : NaN; };
        let ls = 0, ss = 0; const lw = L.map(({ s }) => iv(s)), sw = Sh.map(({ s }) => iv(s));
        lw.forEach((w) => { if (Number.isFinite(w)) ls += w; }); sw.forEach((w) => { if (Number.isFinite(w)) ss += w; });
        if (ls <= 0 || ss <= 0) continue;
        L.forEach(({ s }, i) => { if (Number.isFinite(lw[i])) W[t][s] = lw[i] / ls; });
        Sh.forEach(({ s }, i) => { if (Number.isFinite(sw[i])) W[t][s] = -sw[i] / ss; });
      } else {
        for (const { s } of L) W[t][s] = 1 / L.length; for (const { s } of Sh) W[t][s] = -1 / Sh.length;
      }
    }
  }
  return W;
}

function port(W: number[][], lo: number, hi: number) {
  const net: number[] = [], gross: number[] = []; let prev = new Array(S).fill(0); let ts = 0, es = 0;
  for (let t = lo; t < hi; t++) {
    let g = 0, turn = 0, exp = 0, any = false;
    for (let s = 0; s < S; s++) { const p = W[t][s]; turn += Math.abs(p - prev[s]); exp += Math.abs(p); if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; any = true; } }
    if (!any) continue; gross.push(g); net.push(g - turn * COST); ts += turn; es += exp; prev = W[t].slice();
  }
  const n = net.length; return { net, gross, turnover: n ? ts / n : 0, exposure: n ? es / n : 0 };
}
function portAligned(W: number[][], lo: number, hi: number) {
  const net: number[] = [], btc: number[] = [], ew: number[] = []; let prev = new Array(S).fill(0);
  for (let t = lo; t < hi; t++) {
    let g = 0, turn = 0, any = false;
    for (let s = 0; s < S; s++) { const p = W[t][s]; turn += Math.abs(p - prev[s]); if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; any = true; } }
    if (!any) continue; net.push(g - turn * COST); btc.push(Number.isFinite(fwd[t][BTC]) ? fwd[t][BTC] : 0); ew.push(Number.isFinite(ewFwd[t]) ? ewFwd[t] : 0); prev = W[t].slice();
  }
  return { net, btc, ew };
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

// cross-sectional shuffle of the cp labels within each day
function shuffleCp(cp: number[][], rng: () => number): number[][] {
  const out: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let t = 0; t < T; t++) {
    const idx: number[] = [], vals: number[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) { idx.push(s); vals.push(cp[t][s]); }
    for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
    for (let i = 0; i < idx.length; i++) out[t][idx[i]] = vals[i];
  }
  return out;
}

const firstTradable = 250; const tradableEnd = T - 1; const holdoutFrac = 0.2;
const splitIdx = firstTradable + Math.floor((tradableEnd - firstTradable) * (1 - holdoutFrac));

// HONEST N grid
const lookbacks = [10, 20, 30, 55, 90, 120];
const configs: Cfg[] = [];
for (const N of lookbacks) for (const dir of [1, -1]) {
  for (const frac of [0.2, 0.33]) { configs.push({ N, family: "equal", frac, dir }); configs.push({ N, family: "invvol", frac, dir }); }
  configs.push({ N, family: "rank", frac: 0, dir }); configs.push({ N, family: "zscore", frac: 0, dir });
}
const HONEST_N = configs.length;
const lab = (c: Cfg) => `N=${c.N},${c.family}${c.family === "equal" || c.family === "invvol" ? `(${c.frac})` : ""},dir=${c.dir > 0 ? "HIGH" : "LOW"}`;

const cpCache = new Map<number, number[][]>(); for (const N of lookbacks) cpCache.set(N, channelPos(N));
const scored = configs.map((cfg) => {
  const W = buildW(cpCache.get(cfg.N)!, cfg); const r = port(W, firstTradable, splitIdx);
  return { cfg, W, r, netSh: annSharpe(sharpeDaily(r.net)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0]; const bestNet = best.r.net;

// baselines
const bhNet: number[] = []; for (let t = firstTradable; t < splitIdx; t++) if (Number.isFinite(fwd[t][BTC])) bhNet.push(fwd[t][BTC]); const bhSh = annSharpe(sharpeDaily(bhNet));
const ewNet: number[] = []; for (let t = firstTradable; t < splitIdx; t++) if (Number.isFinite(ewFwd[t])) ewNet.push(ewFwd[t]); const ewSh = annSharpe(sharpeDaily(ewNet));
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(424242 + i * 2654435761); const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = firstTradable; t < splitIdx; t++) {
    const valid: number[] = []; for (let s = 0; s < S; s++) if (Number.isFinite(fwd[t][s])) valid.push(s);
    for (let i2 = valid.length - 1; i2 > 0; i2--) { const j = Math.floor(rng() * (i2 + 1)); [valid[i2], valid[j]] = [valid[j], valid[i2]]; }
    const k = Math.max(1, Math.floor(valid.length / 3));
    for (let q = 0; q < k; q++) W[t][valid[q]] = 1 / k; for (let q = 0; q < k; q++) W[t][valid[valid.length - 1 - q]] = -1 / k;
  }
  rlSh.push(annSharpe(sharpeDaily(port(W, firstTradable, splitIdx).net)));
}
rlSh.sort((a, b) => a - b); const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
const baselinePass = best.netSh > bhSh && best.netSh > ewSh && best.netSh > rl95 && best.netSh > 0;

const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N }); const dsrPass = dsr.deflatedProbability > 0.95;
const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "donch-ls-final-bb" }); const bbPass = bb.lower > 0;

function toFolds(a: number[], nf: number) { const f: number[][] = []; const sz = Math.floor(a.length / nf); for (let i = 0; i < nf; i++) { const lo = i * sz; const hi = i === nf - 1 ? a.length : lo + sz; f.push(a.slice(lo, hi)); } return f; }
let pbo = { pbo: 1, medianLogit: 0 };
try { const r = estimateCscvPbo(scored.map((s) => ({ id: lab(s.cfg), folds: toFolds(s.r.net, 6) })), { statistic: "sharpe", trainFraction: 0.5 }); pbo = { pbo: r.pbo, medianLogit: r.medianLogit }; } catch { /* */ }
const pboPass = pbo.pbo < 0.5;

function normalCdf(z: number) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function zSharpe(rr: number[]) { const s = summarizeReturnSeries(rr); if (s.sampleCount < 3 || s.stdDev <= 0) return 0; const sh = s.sharpe; const den = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh)); return (sh * Math.sqrt(s.sampleCount - 1)) / den; }
const psrP = 1 - normalCdf(zSharpe(bestNet)); const adjP = Math.min(1, psrP * HONEST_N); const haircutPass = adjP < 0.05;

const nSurr = 500; const surr: number[] = []; const cpBest = cpCache.get(best.cfg.N)!;
for (let i = 0; i < nSurr; i++) { const rng = mkRng(7000 + i * 7919); const W = buildW(shuffleCp(cpBest, rng), best.cfg); surr.push(annSharpe(sharpeDaily(port(W, firstTradable, splitIdx).net))); }
surr.sort((a, b) => a - b); const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1); const surrPass = surrP < 0.05;

const al = portAligned(best.W, firstTradable, splitIdx); const reg = betaReg(al.net, [al.btc, al.ew]);
const hedgedSh = annSharpe(sharpeDaily(reg.hedged)); const betaPass = reg.alpha > 0 && reg.alphaT > 2 && hedgedSh > 0;

const holdRes = port(best.W, splitIdx, tradableEnd); const holdSh = annSharpe(sharpeDaily(holdRes.net)); const holdoutPass = holdSh > 0;
const holdAl = portAligned(best.W, splitIdx, tradableEnd); const holdReg = betaReg(holdAl.net, [holdAl.btc, holdAl.ew]); const holdHedgedSh = annSharpe(sharpeDaily(holdReg.hedged));

const meanDailyNet = mean(bestNet);
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: { pass: meanDailyNet > 0, detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turnover=${best.r.turnover.toFixed(3)}` },
  baselines: { pass: baselinePass, detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H_BTC=${bhSh.toFixed(3)} EW_long=${ewSh.toFixed(3)} randLottery95=${rl95.toFixed(3)}` },
  deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} sampleShDaily=${dsr.sharpe.toFixed(4)}` },
  block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
  haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})` },
  surrogate_xs_shuffle: { pass: surrPass, detail: `XS-shuffle placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}` },
  beta_neutrality: { pass: betaPass, detail: `alpha=${reg.alpha.toExponential(3)}/day t=${reg.alphaT.toFixed(2)} betas[BTC,EW]=[${reg.betas.map((b) => b.toFixed(3)).join(",")}] hedgedSh=${hedgedSh.toFixed(3)}` },
  holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} hedgedSh=${holdHedgedSh.toFixed(3)} over ${holdRes.net.length} rows` },
};
const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate_xs_shuffle", "beta_neutrality", "holdout"];
let binding = "none"; for (const g of order) if (!gates[g].pass) { binding = g; break; }
const allPass = binding === "none";
const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate_xs_shuffle.pass && gates.beta_neutrality.pass && gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
const monthlyAt100k = meanDailyNet * 21 * 100000;

console.log(`\n================ D1-LS-DONCH FINAL ================`);
console.log(`panel: ${S} coins, ${dates[0]}..${dates[T - 1]}, IS rows ${best.r.net.length}, holdout rows ${holdRes.net.length}`);
console.log(`honestN=${HONEST_N}  best=${lab(best.cfg)}`);
console.log(`best netSharpeAnn=${best.netSh.toFixed(3)} grossSharpeAnn=${annSharpe(sharpeDaily(best.r.gross)).toFixed(3)} turnover=${best.r.turnover.toFixed(3)} exposure=${best.r.exposure.toFixed(3)}`);
console.log(`top-8 IS:`); for (const s of scored.slice(0, 8)) console.log(`   ${lab(s.cfg).padEnd(28)} netSh=${s.netSh.toFixed(3)}`);
for (const g of order) console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
const monthlyStr = allPass ? `$${Math.round(monthlyAt100k)}` : "n/a";
console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(4)} | monthly@$100k ${monthlyStr} | holdoutSharpe ${holdSh.toFixed(3)} hedgedHoldSh ${holdHedgedSh.toFixed(3)}`);
fs.writeFileSync(`${ROOT}/output/edgehunt-requeue/donch_ls_final_result.json`, JSON.stringify({ honestN: HONEST_N, best: { cfg: best.cfg, netSh: best.netSh, turnover: best.r.turnover }, gates, binding, verdict, surrP, holdSh, holdHedgedSh, hedgedSh, alpha: reg.alpha, alphaT: reg.alphaT, betas: reg.betas, dsrP: dsr.deflatedProbability, expMaxShDaily: dsr.expectedMaxSharpe, sampleShDaily: dsr.sharpe, baselines: { bhSh, ewSh, rl95 }, monthlyAt100k: allPass ? monthlyAt100k : null }, null, 2));
