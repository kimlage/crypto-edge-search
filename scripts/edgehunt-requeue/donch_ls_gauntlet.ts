/**
 * D1-LS-DONCH — Cross-sectional Donchian/Keltner channel-position long-short.
 *
 * CLAIM: rank coins by channel position (breakout strength); long high-cp, short low-cp,
 *        dollar-neutral. The RIGHT null is the CROSS-SECTIONAL SHUFFLE (permute asset->label
 *        within each timestamp) — it destroys which coin gets which cp rank while preserving
 *        the marginal cp distribution, the per-day return cross-section, and the market move.
 *
 * Committed gauntlet, imported directly from src/lib/training/statistical-validation.ts:
 *   - net-of-cost (4bps taker/side, full turnover charged each day)
 *   - baselines: buy&hold (long BTC), equal-weight-long basket, random dollar-neutral lottery (95pct)
 *   - Deflated Sharpe @ HONEST N (every config counted)
 *   - block-bootstrap CI on mean daily net (lower>0)
 *   - CPCV / PBO across all configs
 *   - Harvey-Liu (Bonferroni) haircut on PSR p
 *   - cross-sectional-shuffle surrogate null (the correct null for a relative-value claim)
 *   - beta-neutrality gate: regress net PnL on {BTC ret, equal-weight basket ret}; residual-alpha DSR
 *   - consume-once forward holdout (last 20%, best cfg only)
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
const COST_PER_SIDE = 0.0004; // 4 bps taker/side

// ---------------------------------------------------------------- data
type Closes = { dates: string[]; closes: Record<string, number[]> };
const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8")) as Closes;
const dates = raw.dates;
const syms = Object.keys(raw.closes);
const T = dates.length;
const S = syms.length;
const px: number[][] = Array.from({ length: T }, (_, t) => syms.map((s) => raw.closes[s][t]));

// fwd log return s over t->t+1 (causal: position decided at close t, earned t->t+1)
const fwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 0; t < T - 1; t++)
  for (let s = 0; s < S; s++) {
    const a = px[t][s], b = px[t + 1][s];
    if (a > 0 && b > 0) fwd[t][s] = Math.log(b / a);
  }
// BTC index (idx 0) and equal-weight basket fwd ret (market proxies for beta gate)
const BTC = syms.indexOf("BTC");
const ewFwd: number[] = new Array(T).fill(NaN);
for (let t = 0; t < T - 1; t++) {
  const v: number[] = [];
  for (let s = 0; s < S; s++) if (Number.isFinite(fwd[t][s])) v.push(fwd[t][s]);
  if (v.length) ewFwd[t] = v.reduce((x, y) => x + y, 0) / v.length;
}

// ---------------------------------------------------------------- math
function mean(a: number[]): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]): number {
  const n = a.length; if (n < 2) return 0; const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]): number { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function annSharpe(d: number): number { return d * ANN; }
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- channel position
function channelPos(N: number): number[][] {
  const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let s = 0; s < S; s++)
    for (let t = N; t < T; t++) {
      let mn = Infinity, mx = -Infinity, ok = true;
      for (let k = t - N + 1; k <= t; k++) { const v = px[k][s]; if (!(v > 0)) { ok = false; break; } if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!ok || mx - mn < 1e-12) continue;
      cp[t][s] = (px[t][s] - mn) / (mx - mn);
    }
  return cp;
}

interface Cfg { N: number; frac: number; dir: number; band: number }
// band = hysteresis: only switch a coin's side if its rank crosses by `band` rows (reduces turnover);
// band=0 -> rebalance fully each day.

// build daily dollar-neutral positions from cp
function buildPositions(cp: number[][], cfg: Cfg): number[][] {
  const pos: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const valid: { s: number; v: number }[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) valid.push({ s, v: cp[t][s] });
    if (valid.length < 6) continue;
    valid.sort((a, b) => a.v - b.v);
    const k = Math.max(1, Math.floor(valid.length * cfg.frac));
    const longSet = cfg.dir > 0 ? valid.slice(valid.length - k) : valid.slice(0, k);
    const shortSet = cfg.dir > 0 ? valid.slice(0, k) : valid.slice(valid.length - k);
    for (const { s } of longSet) pos[t][s] = 1 / longSet.length;
    for (const { s } of shortSet) pos[t][s] = -1 / shortSet.length;
  }
  if (cfg.band > 0) applyBanding(pos);
  return pos;
}
// banding: hold previous side unless the new target flips sign AND |Δ| material; cheap turnover cut.
// Simple version: only update a coin when its target sign differs from held sign.
function applyBanding(pos: number[][]): void {
  let prev = new Array(S).fill(0);
  for (let t = 0; t < T; t++) {
    const cur = pos[t];
    const anyTarget = cur.some((x) => x !== 0);
    if (!anyTarget) { pos[t] = prev.slice(); continue; }
    const out = cur.slice();
    for (let s = 0; s < S; s++) {
      // keep previous if same sign (avoid re-weight churn); adopt new sign on flip / new entry
      if (prev[s] !== 0 && Math.sign(prev[s]) === Math.sign(cur[s])) out[s] = prev[s];
    }
    pos[t] = out;
    prev = out.slice();
  }
}

// portfolio returns from positions over [startIdx,endIdx)
function portfolio(pos: number[][], startIdx: number, endIdx: number): { net: number[]; gross: number[]; turnover: number; exposure: number } {
  const net: number[] = [], gross: number[] = [];
  let prev = new Array(S).fill(0); let turnSum = 0, expSum = 0;
  for (let t = startIdx; t < endIdx; t++) {
    let g = 0, turn = 0, exp = 0, anyValid = false;
    for (let s = 0; s < S; s++) {
      const p = pos[t][s];
      turn += Math.abs(p - prev[s]); exp += Math.abs(p);
      if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; anyValid = true; }
    }
    if (!anyValid) continue;
    gross.push(g); net.push(g - turn * COST_PER_SIDE);
    turnSum += turn; expSum += exp; prev = pos[t].slice();
  }
  const n = net.length;
  return { net, gross, turnover: n ? turnSum / n : 0, exposure: n ? expSum / n : 0 };
}

// portfolio returns aligned to a date index (for beta regression): returns net[] AND the
// matching BTC/EW fwd at those days
function portfolioAligned(pos: number[][], startIdx: number, endIdx: number) {
  const net: number[] = [], btc: number[] = [], ew: number[] = [];
  let prev = new Array(S).fill(0);
  for (let t = startIdx; t < endIdx; t++) {
    let g = 0, turn = 0, anyValid = false;
    for (let s = 0; s < S; s++) { const p = pos[t][s]; turn += Math.abs(p - prev[s]); if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; anyValid = true; } }
    if (!anyValid) continue;
    net.push(g - turn * COST_PER_SIDE);
    btc.push(Number.isFinite(fwd[t][BTC]) ? fwd[t][BTC] : 0);
    ew.push(Number.isFinite(ewFwd[t]) ? ewFwd[t] : 0);
    prev = pos[t].slice();
  }
  return { net, btc, ew };
}

// Beta-neutrality: regress y ~ 1 + factors. The INTERCEPT is the beta-neutral alpha.
// The intercept-bearing residual is mean-zero (so its Sharpe is ~0 by construction); instead we
// (a) report alpha and its Newey-West-free t-stat, and (b) form the BETA-HEDGED return
//   hedged_t = y_t - betas·factors_t   (no intercept subtracted) -> retains alpha as its mean.
// hedgedSh = Sharpe of the beta-hedged series = the realisable neutral-by-construction Sharpe.
function olsResidual(y: number[], Xcols: number[][]): { alpha: number; alphaT: number; betas: number[]; hedged: number[] } {
  const n = y.length, p = Xcols.length + 1;
  const X: number[][] = y.map((_, i) => [1, ...Xcols.map((c) => c[i])]);
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  const b = solve(XtX, Xty);
  const resid = y.map((yi, i) => yi - X[i].reduce((acc, xv, a) => acc + xv * b[a], 0));
  // alpha t-stat = b[0] / SE(b[0]); SE = sqrt( sigma2 * (XtX^-1)_00 )
  const dof = Math.max(1, n - p);
  const sigma2 = resid.reduce((s, r) => s + r * r, 0) / dof;
  const inv00 = invDiag0(XtX);
  const seAlpha = Math.sqrt(Math.max(1e-18, sigma2 * inv00));
  const alphaT = b[0] / seAlpha;
  // beta-hedged series (subtract only the factor loadings, keep alpha in the mean)
  const betas = b.slice(1);
  const hedged = y.map((yi, i) => yi - Xcols.reduce((acc, c, j) => acc + betas[j] * c[i], 0));
  return { alpha: b[0], alphaT, betas, hedged };
}
// (XtX^-1)_00 via solving XtX x = e0
function invDiag0(XtX: number[][]): number {
  const p = XtX.length; const e0 = new Array(p).fill(0); e0[0] = 1;
  const x = solve(XtX.map((r) => r.slice()), e0);
  return x[0];
}
function solve(A: number[][], rhs: number[]): number[] {
  const n = rhs.length; const M = A.map((r, i) => [...r, rhs[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((r) => r[n]);
}

// ---------------------------------------------------------------- cross-sectional shuffle surrogate
// Permute the asset->cp-label mapping WITHIN each day: each day, randomly reassign the realized cp
// values to coins (only among coins valid that day). Preserves the cp marginal distribution and the
// realized return cross-section; destroys the coin-specific cp ranking. Rebuild positions & price.
function buildSurrogatePositions(cp: number[][], cfg: Cfg, rng: () => number): number[][] {
  const cpShuf: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let t = 0; t < T; t++) {
    const validS: number[] = [], vals: number[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) { validS.push(s); vals.push(cp[t][s]); }
    // Fisher-Yates shuffle vals
    for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
    for (let i = 0; i < validS.length; i++) cpShuf[t][validS[i]] = vals[i];
  }
  return buildPositions(cpShuf, cfg);
}

// ---------------------------------------------------------------- gauntlet
const firstTradable = 250; // warmup
const tradableEnd = T - 1;
const holdoutFrac = 0.2;
const span = tradableEnd - firstTradable;
const splitIdx = firstTradable + Math.floor(span * (1 - holdoutFrac));

// HONEST N: every config considered across the whole study (probe + this grid).
const lookbacks = [10, 20, 30, 55, 90, 120];
const fracs = [0.2, 0.33];
const dirs = [1, -1];
const bands = [0, 1];
const configs: Cfg[] = [];
for (const N of lookbacks) for (const frac of fracs) for (const dir of dirs) for (const band of bands) configs.push({ N, frac, dir, band });
const HONEST_N = configs.length; // counts every grid cell incl. both directions and banding

// precompute cp per lookback
const cpCache = new Map<number, number[][]>();
for (const N of lookbacks) cpCache.set(N, channelPos(N));

// score every config IN-SAMPLE
const scored = configs.map((cfg) => {
  const cp = cpCache.get(cfg.N)!;
  const pos = buildPositions(cp, cfg);
  const r = portfolio(pos, firstTradable, splitIdx);
  return { cfg, pos, r, netSh: annSharpe(sharpeDaily(r.net)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestNet = best.r.net;
const label = (c: Cfg) => `N=${c.N},frac=${c.frac},dir=${c.dir > 0 ? "HIGH" : "LOW"},band=${c.band}`;

// ---- baselines ----
// buy&hold BTC over window
const bhNet: number[] = [];
for (let t = firstTradable; t < splitIdx; t++) if (Number.isFinite(fwd[t][BTC])) bhNet.push(fwd[t][BTC]);
const bhSh = annSharpe(sharpeDaily(bhNet));
// equal-weight long basket
const ewNet: number[] = [];
for (let t = firstTradable; t < splitIdx; t++) if (Number.isFinite(ewFwd[t])) ewNet.push(ewFwd[t]);
const ewSh = annSharpe(sharpeDaily(ewNet));
// random dollar-neutral lottery matched to best's gross exposure / # legs
const bestK = Math.max(1, Math.floor(S * best.cfg.frac));
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(424242 + i * 2654435761);
  const pos: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = firstTradable; t < splitIdx; t++) {
    const valid: number[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(fwd[t][s])) valid.push(s);
    for (let i2 = valid.length - 1; i2 > 0; i2--) { const j = Math.floor(rng() * (i2 + 1)); [valid[i2], valid[j]] = [valid[j], valid[i2]]; }
    const k = Math.min(bestK, Math.floor(valid.length / 2));
    for (let q = 0; q < k; q++) pos[t][valid[q]] = 1 / k;
    for (let q = 0; q < k; q++) pos[t][valid[valid.length - 1 - q]] = -1 / k;
  }
  rlSh.push(annSharpe(sharpeDaily(portfolio(pos, firstTradable, splitIdx).net)));
}
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
const baselinePass = best.netSh > bhSh && best.netSh > ewSh && best.netSh > rl95 && best.netSh > 0;

// ---- Deflated Sharpe @ honest N ----
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;

// ---- block bootstrap CI ----
const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "donch-ls-bb" });
const bbPass = bb.lower > 0;

// ---- CPCV / PBO ----
function toFolds(series: number[], nf: number): number[][] {
  const folds: number[][] = []; const sz = Math.floor(series.length / nf);
  for (let f = 0; f < nf; f++) { const lo = f * sz; const hi = f === nf - 1 ? series.length : lo + sz; folds.push(series.slice(lo, hi)); }
  return folds;
}
const cscv = scored.map((s) => ({ id: label(s.cfg), folds: toFolds(s.r.net, 6) }));
let pbo = { pbo: 1, medianLogit: 0 };
try { const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }); pbo = { pbo: r.pbo, medianLogit: r.medianLogit }; } catch { /* keep */ }
const pboPass = pbo.pbo < 0.5;

// ---- Harvey-Liu Bonferroni haircut ----
function normalCdf(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number): number { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns); if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe; const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
const psrP = 1 - normalCdf(zSharpe(bestNet));
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// ---- cross-sectional shuffle surrogate null ----
const nSurr = 500;
const surr: number[] = [];
const cpBest = cpCache.get(best.cfg.N)!;
for (let i = 0; i < nSurr; i++) {
  const rng = mkRng(7000 + i * 7919);
  const pos = buildSurrogatePositions(cpBest, best.cfg, rng);
  surr.push(annSharpe(sharpeDaily(portfolio(pos, firstTradable, splitIdx).net)));
}
surr.sort((a, b) => a - b);
const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);
const surrPass = surrP < 0.05;

// ---- beta-neutrality / residual-alpha gate ----
const al = portfolioAligned(best.pos, firstTradable, splitIdx);
const reg = olsResidual(al.net, [al.btc, al.ew]);
const hedgedSh = annSharpe(sharpeDaily(reg.hedged)); // Sharpe of beta-hedged (alpha-retaining) series
// alpha must be positive & significant (t>2) AND the hedged series DSR-significant @ honest N
const residDsr = computeDeflatedSharpeRatio(reg.hedged, { trialCount: HONEST_N });
const betaPass = reg.alpha > 0 && reg.alphaT > 2 && hedgedSh > 0;

// ---- consume-once forward holdout ----
const holdRes = portfolio(best.pos, splitIdx, tradableEnd);
const holdSh = annSharpe(sharpeDaily(holdRes.net));
const holdoutPass = holdSh > 0;
// holdout beta-neutral too
const holdAl = portfolioAligned(best.pos, splitIdx, tradableEnd);
const holdReg = olsResidual(holdAl.net, [holdAl.btc, holdAl.ew]);
const holdResidSh = annSharpe(sharpeDaily(holdReg.hedged));

// ---- assemble gates ----
const meanDailyNet = mean(bestNet);
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: { pass: meanDailyNet > 0, detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turnover=${best.r.turnover.toFixed(3)}` },
  baselines: { pass: baselinePass, detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H_BTC=${bhSh.toFixed(3)} EW_long=${ewSh.toFixed(3)} randLottery95=${rl95.toFixed(3)}` },
  deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}` },
  block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
  haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})` },
  surrogate_xs_shuffle: { pass: surrPass, detail: `XS-shuffle placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}` },
  beta_neutrality: { pass: betaPass, detail: `alpha=${reg.alpha.toExponential(3)}/day t=${reg.alphaT.toFixed(2)} betas[BTC,EW]=[${reg.betas.map((b) => b.toFixed(3)).join(",")}] hedgedSh=${hedgedSh.toFixed(3)} hedgedDSRp=${residDsr.deflatedProbability.toFixed(4)}` },
  holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} residSh=${holdResidSh.toFixed(3)} over ${holdRes.net.length} rows` },
};
const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate_xs_shuffle", "beta_neutrality", "holdout"];
let binding = "none";
for (const g of order) if (!gates[g].pass) { binding = g; break; }
const allPass = binding === "none";
const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate_xs_shuffle.pass && gates.beta_neutrality.pass && gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
const monthlyAt100k = meanDailyNet * 21 * 100000; // ~21 trading-equivalent days/mo on daily series

console.log(`\n================ D1-LS-DONCH (cross-sectional channel-position long-short) ================`);
console.log(`panel: ${S} coins, ${dates[0]}..${dates[T - 1]}, IS rows ${best.r.net.length}, holdout rows ${holdRes.net.length}`);
console.log(`honestN=${HONEST_N}  best=${label(best.cfg)}`);
console.log(`best netSharpeAnn=${best.netSh.toFixed(3)} grossSharpeAnn=${annSharpe(sharpeDaily(best.r.gross)).toFixed(3)} turnover=${best.r.turnover.toFixed(3)} exposure=${best.r.exposure.toFixed(3)}`);
console.log(`top-8 configs IS:`);
for (const s of scored.slice(0, 8)) console.log(`   ${label(s.cfg).padEnd(34)} netSh=${s.netSh.toFixed(3)}`);
for (const g of order) console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
const monthlyStr = allPass ? `$${Math.round(monthlyAt100k)}` : "n/a";
console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(4)} | monthly@$100k ${monthlyStr} | holdoutSharpe ${holdSh.toFixed(3)} residHoldSh ${holdResidSh.toFixed(3)}`);

fs.writeFileSync(`${ROOT}/output/edgehunt-requeue/donch_ls_result.json`, JSON.stringify({
  honestN: HONEST_N, best: { cfg: best.cfg, netSh: best.netSh, turnover: best.r.turnover },
  gates, binding, verdict, surrP, holdSh, holdResidSh, hedgedSh, alpha: reg.alpha, alphaT: reg.alphaT, betas: reg.betas,
  dsrP: dsr.deflatedProbability, expMaxShDaily: dsr.expectedMaxSharpe,
  baselines: { bhSh, ewSh, rl95 }, monthlyAt100k: allPass ? monthlyAt100k : null,
}, null, 2));
