/**
 * D1-LS-BOLL — Bollinger %b — market-neutral cross-sectional reversion long-short.
 *
 * Claim: cross-sectional %b z-score across 8 majors; dollar-neutral long-oversold /
 * short-overbought. The reversion belief is that an asset stretched to the bottom of its
 * Bollinger band (low %b) relative to its peers will outperform one stretched to the top
 * (high %b) over the next day.
 *
 * Right null for THIS claim: CROSS-SECTIONAL SHUFFLE. Each day we randomly permute the
 * asset->signal mapping while holding the realized forward returns fixed. This destroys the
 * (asset <-> its own %b) pairing that the strategy keys on, while EXACTLY preserving:
 *   - the marginal distribution of forward returns each day,
 *   - the market-neutral / dollar-neutral weight structure (Σw=0, Σ|w|=1),
 *   - the cross-sectional dispersion of weights and the per-day vol.
 * So the placebo measures "is the SIGN of the %b ranking informative", not "is being
 * dollar-neutral on crypto profitable" — the correct surrogate.
 *
 * Gauntlet (committed primitives imported directly from src/lib/training/statistical-validation.ts):
 *   net-of-cost (4 bps taker/side on weight turnover), baselines (per-day-random
 *   dollar-neutral lottery, equal-weight buy&hold long-beta, cross-sectional MOMENTUM as a
 *   sign control), Deflated Sharpe @ HONEST N (= every config tried), CPCV/PBO, Harvey-Liu
 *   Bonferroni haircut, cross-sectional-shuffle surrogate, consume-once forward holdout (tail 20%).
 *
 * Data: output/crossxs/daily-closes.json (Binance daily closes, aligned panel). Universe =
 * the 8 majors {BTC,ETH,SOL,XRP,BNB,ADA,AVAX,DOGE}. Full 8-asset cross-section starts when
 * AVAX lists (2020-09-22). Survivorship caveat: these are coins liquid TODAY -> measured edge
 * is an UPPER BOUND.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-requeue`;
const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);
const MAJORS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "AVAX", "DOGE"] as const;

// ----------------------------------------------------------------- data load
interface Panel {
  dates: string[];
  assets: string[];
  // logPrice[a][t], ret[a][t] = log return t-1 -> t (so fwdRet at signal-day t is ret[t+1])
  close: number[][]; // [asset][t]
  ret: number[][]; // [asset][t] one-day log return into day t (NaN at t=0)
  T: number;
  A: number;
}

function loadPanel(): Panel {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8"));
  const dates: string[] = raw.dates;
  const closesAll: Record<string, (number | null)[]> = raw.closes;
  const assets = [...MAJORS];
  const A = assets.length;
  // find first index where ALL 8 majors are valid
  let start = 0;
  for (let t = 0; t < dates.length; t++) {
    let ok = true;
    for (const a of assets) {
      const v = closesAll[a]?.[t];
      if (!(typeof v === "number" && v > 0)) { ok = false; break; }
    }
    if (ok) { start = t; break; }
  }
  const subDates = dates.slice(start);
  const T = subDates.length;
  const close: number[][] = assets.map((a) => closesAll[a].slice(start).map((v) => Number(v)));
  // any residual gaps -> forward-fill (rare); guarantees a full panel
  for (let ai = 0; ai < A; ai++) {
    for (let t = 0; t < T; t++) {
      if (!(close[ai][t] > 0)) close[ai][t] = t > 0 ? close[ai][t - 1] : NaN;
    }
  }
  const ret: number[][] = assets.map((a, ai) => {
    const r = new Array(T).fill(NaN);
    for (let t = 1; t < T; t++) r[t] = Math.log(close[ai][t] / close[ai][t - 1]);
    return r;
  });
  return { dates: subDates, assets, close, ret, T, A };
}

// ----------------------------------------------------------------- math utils
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]): number {
  const n = a.length; if (n < 2) return 0; const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]): number { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function annSharpe(d: number): number { return d * ANN; }
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// rolling SMA & rolling stdev of a single asset's logPrice (causal)
function rollingMeanStd(x: number[], win: number, t: number): { m: number; sd: number } | null {
  if (t + 1 < win) return null;
  let s = 0; const buf: number[] = [];
  for (let k = t - win + 1; k <= t; k++) { if (!Number.isFinite(x[k])) return null; s += x[k]; buf.push(x[k]); }
  const m = s / win;
  let v = 0; for (const b of buf) v += (b - m) ** 2;
  const sd = Math.sqrt(v / (win - 1));
  return { m, sd };
}

// ----------------------------------------------------------------- signal: %b matrix
// %b_a,t = (logPrice_a,t - SMA_n) / (k * sigma_n)  (standard Bollinger %b is in band units;
// using k=2 reproduces the classic 0..1 inside-band scaling around the midline). We then
// cross-sectionally demean %b each day and form dollar-neutral REVERSION weights w ∝ -(demeaned).
// dir: +1 = reversion (long low %b), -1 = trend (long high %b). hold: rebalance every `hold` days
// (signal held, reducing turnover). horizon h folds into the forward return: we still earn the
// chained 1-day returns but only re-form weights every `hold` days.
interface Cfg { n: number; k: number; smooth: number; weight: "rank" | "z"; dir: number; hold: number; [key: string]: number | string; }

// pctB[asset][t]
function buildPctB(P: Panel, n: number, k: number): number[][] {
  const logP = P.close.map((c) => c.map((v) => Math.log(v)));
  const out: number[][] = P.assets.map(() => new Array(P.T).fill(NaN));
  for (let ai = 0; ai < P.A; ai++) {
    for (let t = 0; t < P.T; t++) {
      const ms = rollingMeanStd(logP[ai], n, t);
      if (!ms || ms.sd <= 1e-12) continue;
      out[ai][t] = (logP[ai][t] - ms.m) / (k * ms.sd);
    }
  }
  return out;
}

// Build dollar-neutral weights[asset][t] from a %b matrix and a config.
// signalDay t -> weights applied to fwdRet ret[t+1]. We demean cross-sectionally each day,
// optionally smooth the signal over `smooth` days, and convert to either z- or rank-based
// REVERSION weights (long low %b, short high %b). Normalized so Σw=0, Σ|w|=1.
function weightsFromPctB(P: Panel, pctB: number[][], cfg: Cfg): number[][] {
  const W: number[][] = P.assets.map(() => new Array(P.T).fill(0));
  // optional trailing smoothing of %b per asset
  let sig = pctB;
  if (cfg.smooth > 1) {
    sig = pctB.map((row) => {
      const o = new Array(P.T).fill(NaN);
      for (let t = 0; t < P.T; t++) {
        if (t + 1 < cfg.smooth) continue;
        let s = 0; let ok = true;
        for (let kk = t - cfg.smooth + 1; kk <= t; kk++) { if (!Number.isFinite(row[kk])) { ok = false; break; } s += row[kk]; }
        if (ok) o[t] = s / cfg.smooth;
      }
      return o;
    });
  }
  const hold = Math.max(1, cfg.hold);
  const dir = cfg.dir; // +1 reversion, -1 trend
  let lastFormed = -1;
  const carried = new Array(P.A).fill(0);
  for (let t = 0; t < P.T; t++) {
    // only re-form weights every `hold` days; otherwise carry the last formed weights
    if (lastFormed >= 0 && t - lastFormed < hold) { for (let ai = 0; ai < P.A; ai++) W[ai][t] = carried[ai]; continue; }
    const vals: { ai: number; v: number }[] = [];
    for (let ai = 0; ai < P.A; ai++) { const v = sig[ai][t]; if (Number.isFinite(v)) vals.push({ ai, v }); }
    if (vals.length < 4) { for (let ai = 0; ai < P.A; ai++) W[ai][t] = carried[ai]; continue; }
    const m = mean(vals.map((x) => x.v));
    let raw: { ai: number; w: number }[];
    if (cfg.weight === "rank") {
      // cross-sectional rank centered: low %b -> +, high %b -> - (reversion base, dir applies)
      const sorted = [...vals].sort((a, b) => a.v - b.v);
      const N = sorted.length;
      raw = sorted.map((x, i) => ({ ai: x.ai, w: dir * ((N - 1) / 2 - i) }));
    } else {
      const sd = std(vals.map((x) => x.v)) || 1;
      raw = vals.map((x) => ({ ai: x.ai, w: dir * (-(x.v - m) / sd) })); // dir*negative => reversion base
    }
    // enforce dollar-neutral (demean) then gross-normalize to Σ|w|=1
    const wm = mean(raw.map((x) => x.w));
    let gross = 0;
    for (const r of raw) { r.w -= wm; gross += Math.abs(r.w); }
    if (gross < 1e-12) { for (let ai = 0; ai < P.A; ai++) W[ai][t] = carried[ai]; continue; }
    for (let ai = 0; ai < P.A; ai++) carried[ai] = 0;
    for (const r of raw) { W[r.ai][t] = r.w / gross; carried[r.ai] = r.w / gross; }
    lastFormed = t;
  }
  return W;
}

// ----------------------------------------------------------------- portfolio backtest
interface BtResult { dailyNet: number[]; dailyGross: number[]; turnover: number; nDays: number; }
function runPortfolio(P: Panel, W: number[][], startT: number, endT: number, cost = COST_PER_SIDE): BtResult {
  const dailyNet: number[] = []; const dailyGross: number[] = [];
  const prevW = new Array(P.A).fill(0);
  let turnSum = 0; let n = 0;
  for (let t = startT; t < endT; t++) {
    // position formed at close t earns ret[t+1]
    if (t + 1 >= P.T) break;
    let gross = 0; let turn = 0; let any = false;
    for (let ai = 0; ai < P.A; ai++) {
      const w = W[ai][t]; const r = P.ret[ai][t + 1];
      if (Number.isFinite(w) && Number.isFinite(r)) { gross += w * r; any = true; }
      turn += Math.abs((Number.isFinite(w) ? w : 0) - prevW[ai]);
    }
    if (!any) continue;
    const c = turn * cost;
    dailyGross.push(gross); dailyNet.push(gross - c); turnSum += turn; n++;
    for (let ai = 0; ai < P.A; ai++) prevW[ai] = Number.isFinite(W[ai][t]) ? W[ai][t] : 0;
  }
  return { dailyNet, dailyGross, turnover: n ? turnSum / n : 0, nDays: n };
}

// cross-sectional shuffle surrogate: rebuild weights from a per-day permuted %b matrix.
function shuffledWeights(P: Panel, pctB: number[][], cfg: Cfg, rng: () => number): number[][] {
  // permute the asset labels of the signal within each day, leaving returns fixed.
  const perm: number[][] = []; // perm[t] = mapping
  for (let t = 0; t < P.T; t++) {
    const idx = [...Array(P.A).keys()];
    for (let i = P.A - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    perm.push(idx);
  }
  const shuf: number[][] = P.assets.map(() => new Array(P.T).fill(NaN));
  for (let t = 0; t < P.T; t++) for (let ai = 0; ai < P.A; ai++) shuf[ai][t] = pctB[perm[t][ai]][t];
  return weightsFromPctB(P, shuf, cfg);
}

// ----------------------------------------------------------------- gauntlet
function toFolds(s: number[], nf: number): number[][] {
  const f: number[][] = []; const sz = Math.floor(s.length / nf);
  for (let i = 0; i < nf; i++) { const lo = i * sz; const hi = i === nf - 1 ? s.length : lo + sz; f.push(s.slice(lo, hi)); }
  return f;
}
function normalCdf(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns); if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe; const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}

function main() {
  const P = loadPanel();
  const warmupMax = 60; // largest lookback in grid
  const startT = warmupMax + 5;
  const tradableEnd = P.T - 1;
  const span = tradableEnd - startT;
  const holdoutFrac = 0.2;
  const splitT = startT + Math.floor(span * (1 - holdoutFrac));
  const nSurr = 400;

  console.log(`Panel: ${P.A} assets [${P.assets.join(",")}] | dates ${P.dates[0]}..${P.dates[P.dates.length - 1]} | T=${P.T}`);
  console.log(`IS=[${P.dates[startT]}..${P.dates[splitT]}] (${splitT - startT}d)  HOLDOUT=[${P.dates[splitT]}..${P.dates[tradableEnd]}] (${tradableEnd - splitT}d)`);

  // ----- config grid (HONEST N = every config evaluated) -----
  const Ns = [10, 14, 20, 30, 40, 60];
  const Ks = [2.0]; // k only rescales the z-signal; cross-sectional z/rank is invariant to it -> fix to classic 2
  const smooths = [1, 2, 3];
  const weights: ("z" | "rank")[] = ["z", "rank"];
  const dirs = [1, -1]; // reversion vs trend: direction is a free parameter -> PAID in honest N
  const holds = [1, 3, 5]; // rebalance every {1,3,5} days (turnover control + multi-day horizon)
  const configs: Cfg[] = [];
  for (const n of Ns) for (const k of Ks) for (const sm of smooths) for (const w of weights) for (const dir of dirs) for (const hold of holds) configs.push({ n, k, smooth: sm, weight: w, dir, hold });
  const HONEST_N = configs.length;
  // pre-registered canonical: classic BB (n=20,k=2), z-weighted, daily reversion (the literal spec)
  const canonical: Cfg = { n: 20, k: 2.0, smooth: 1, weight: "z", dir: 1, hold: 1 };

  // cache %b matrices by (n,k)
  const pctBCache = new Map<string, number[][]>();
  const getPctB = (n: number, k: number) => { const key = `${n}|${k}`; let m = pctBCache.get(key); if (!m) { m = buildPctB(P, n, k); pctBCache.set(key, m); } return m; };

  // ----- score every config IN-SAMPLE on net Sharpe -----
  const scored = configs.map((cfg) => {
    const pctB = getPctB(cfg.n, cfg.k);
    const W = weightsFromPctB(P, pctB, cfg);
    const res = runPortfolio(P, W, startT, splitT);
    const label = `n=${cfg.n},k=${cfg.k},sm=${cfg.smooth},w=${cfg.weight}`;
    return { cfg, label, W, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;
  console.log(`\nTop 6 IS configs by net Sharpe:`);
  for (const s of scored.slice(0, 6)) console.log(`  ${s.label}  netSh=${s.netSh.toFixed(3)} turn=${s.res.turnover.toFixed(3)} grossSh=${annSharpe(sharpeDaily(s.res.dailyGross)).toFixed(3)}`);
  console.log(`Worst IS config netSh=${scored[scored.length - 1].netSh.toFixed(3)}`);

  // ----- baselines -----
  // (a) equal-weight long buy&hold (long-beta) on the 8 majors
  const ewLongW: number[][] = P.assets.map(() => new Array(P.T).fill(1 / P.A));
  const ewRes = runPortfolio(P, ewLongW, startT, splitT);
  const ewSh = annSharpe(sharpeDaily(ewRes.dailyNet));
  // (b) per-day random dollar-neutral lottery matched to gross=1 (random which assets long/short)
  const rlSh: number[] = [];
  for (let i = 0; i < 300; i++) {
    const rng = mkRng(135711 + i * 2654435761);
    const W: number[][] = P.assets.map(() => new Array(P.T).fill(0));
    for (let t = startT; t < splitT; t++) {
      const signs = P.assets.map(() => (rng() < 0.5 ? 1 : -1));
      const m = mean(signs); let g = 0; const adj = signs.map((s) => s - m); for (const v of adj) g += Math.abs(v);
      if (g < 1e-12) continue; for (let ai = 0; ai < P.A; ai++) W[ai][t] = adj[ai] / g;
    }
    const r = runPortfolio(P, W, startT, splitT);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  // (c) cross-sectional MOMENTUM sign control (long high recent return) at best cfg horizon —
  //     reversion must not simply be momentum-with-a-flipped-sign artifact.
  const momW: number[][] = P.assets.map(() => new Array(P.T).fill(0));
  {
    const lb = Math.max(5, Math.round(best.cfg.n / 2));
    for (let t = startT; t < splitT; t++) {
      const vals: { ai: number; v: number }[] = [];
      for (let ai = 0; ai < P.A; ai++) { if (t - lb >= 0 && Number.isFinite(P.close[ai][t]) && P.close[ai][t - lb] > 0) vals.push({ ai, v: Math.log(P.close[ai][t] / P.close[ai][t - lb]) }); }
      if (vals.length < 4) continue;
      const m = mean(vals.map((x) => x.v)); const sd = std(vals.map((x) => x.v)) || 1;
      const raw = vals.map((x) => ({ ai: x.ai, w: (x.v - m) / sd })); // long winners
      let g = 0; for (const r of raw) g += Math.abs(r.w); if (g < 1e-12) continue;
      for (const r of raw) momW[r.ai][t] = r.w / g;
    }
  }
  const momSh = annSharpe(sharpeDaily(runPortfolio(P, momW, startT, splitT).dailyNet));
  const baselinePass = best.netSh > rl95 && best.netSh > 0 && best.netSh > ewSh;

  // ----- Deflated Sharpe @ honest N -----
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ----- block bootstrap CI on mean daily net -----
  const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 3000, blockLength: 10, confidenceLevel: 0.95, seed: "d1lsboll-bb" });
  const bbPass = bb.lower > 0;

  // ----- CSCV / PBO across all configs -----
  const NFOLDS = 8;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try { const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }); pbo = { pbo: r.pbo, medianLogit: r.medianLogit }; } catch { /* keep default */ }
  const pboPass = pbo.pbo < 0.5;

  // ----- Harvey-Liu (Bonferroni) haircut -----
  const psrP = 1 - normalCdf(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ----- RIGHT surrogate: cross-sectional shuffle -----
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(80001 + i * 7919);
    const W = shuffledWeights(P, getPctB(best.cfg.n, best.cfg.k), best.cfg, rng);
    surr.push(annSharpe(sharpeDaily(runPortfolio(P, W, startT, splitT).dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // ----- consume-once forward holdout (best cfg only) -----
  const holdRes = runPortfolio(P, best.W, splitT, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // ----- canonical pre-registered (N=1) -----
  const canonPctB = getPctB(canonical.n, canonical.k);
  const canonW = weightsFromPctB(P, canonPctB, canonical);
  const canonRes = runPortfolio(P, canonW, startT, splitT);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) { const rng = mkRng(91001 + i * 7919); const W = shuffledWeights(P, canonPctB, canonical, rng); canonSurr.push(annSharpe(sharpeDaily(runPortfolio(P, W, startT, splitT).dailyNet))); }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHoldSh = annSharpe(sharpeDaily(runPortfolio(P, canonW, splitT, tradableEnd).dailyNet));

  const meanDailyNet = mean(bestNet);
  const monthlyAt100k = meanDailyNet * 21 * 100000; // ~21 trading-equiv days/mo (crypto trades daily; use 21 for conservatism)
  const monthlyCalendar = meanDailyNet * 30 * 100000;

  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: { pass: meanDailyNet > 0, detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turnover=${best.res.turnover.toFixed(3)} netShAnn=${best.netSh.toFixed(3)} grossShAnn=${annSharpe(sharpeDaily(best.res.dailyGross)).toFixed(3)}` },
    baselines: { pass: baselinePass, detail: `bestNetSh=${best.netSh.toFixed(3)} vs EWlongBeta=${ewSh.toFixed(3)} randNeutral95=${rl95.toFixed(3)} xsMomentum=${momSh.toFixed(3)}` },
    deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} bestDailySh=${dsr.sharpe.toFixed(4)}` },
    block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})` },
    surrogate: { pass: surrPass, detail: `xsShuffleP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}` },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays}d` },
  };
  const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
  let binding = "none"; for (const g of order) { if (!gates[g].pass) { binding = g; break; } }
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (binding === "none") verdict = "SURVIVE"; else if (survivesCore) verdict = "PROMISING"; else verdict = "KILL";

  console.log(`\n================ D1-LS-BOLL ================`);
  console.log(`honestN=${HONEST_N}  best=${best.label}`);
  console.log(`best netSharpeAnn=${best.netSh.toFixed(3)} grossSharpeAnn=${annSharpe(sharpeDaily(best.res.dailyGross)).toFixed(3)} turnover=${best.res.turnover.toFixed(3)} nDays=${best.res.nDays}`);
  for (const [g, r] of Object.entries(gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  console.log(`canonical(n=20,k=2,z): netSharpeAnn=${canonSh.toFixed(3)} xsShuffleP=${canonSurrP.toFixed(4)} holdoutSharpeAnn=${canonHoldSh.toFixed(3)}`);
  const monthlyStr = binding === "none" ? `$${Math.round(monthlyCalendar)}` : "n/a";
  console.log(`monthly@$100k(calendar)=${monthlyStr}  (21d-equiv=$${Math.round(monthlyAt100k)})`);
  console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthlyStr}`);

  fs.writeFileSync(`${OUT}/d1-ls-boll-result.json`, JSON.stringify({
    name: "D1-LS-BOLL", universe: P.assets, dates: [P.dates[startT], P.dates[tradableEnd]],
    honestN: HONEST_N, best: { ...best.cfg, label: best.label, netSharpeAnn: best.netSh, grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)), turnover: best.res.turnover, nDays: best.res.nDays, meanDailyNet, monthlyAt100kCalendar: monthlyCalendar },
    canonical: { ...canonical, netSharpeAnn: canonSh, xsShuffleP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
    gates, bindingGate: binding, verdict, surrogateP: surrP, holdoutSharpeAnn: holdSh,
    baselines: { ewLongBeta: ewSh, randNeutral95: rl95, xsMomentum: momSh },
    top6: scored.slice(0, 6).map((s) => ({ label: s.label, netSh: s.netSh, turn: s.res.turnover })),
  }, null, 2));
  console.log(`\nWrote ${OUT}/d1-ls-boll-result.json`);
}

main();
