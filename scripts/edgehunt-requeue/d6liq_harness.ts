/**
 * D6-LIQ — Global liquidity / net-liquidity (M2 / WALCL) regime timer.
 *
 * Thesis (Howell "Capital Wars", Alden "BTC global liquidity barometer", Karau 2023):
 *   BTC has no cash flows => pure liquidity sensitivity. When global $ liquidity is rising,
 *   go long BTC; when contracting, de-risk. Liquidity proxies (no-key FRED, $0):
 *     - NETLIQ = WALCL - WTREGEN - RRPONTSYD  (Fed bal sheet net of TGA + reverse repo)
 *     - M2SL    = M2 money stock
 *
 * The committed gauntlet primitives are imported directly from the training lib
 * (src/lib/training/statistical-validation.ts). This file copies the runGauntlet wrapper
 * pattern from scripts/edgehunt-D5/harness.ts but with the RIGHT null for the liquidity claim:
 *
 *   1. CAUSAL LAG: weekly WALCL/WTREGEN forward-filled to daily and lagged >=8 calendar days
 *      (Thu release of prior-Wed reference); RRP daily lagged 2d; M2SL monthly lagged 35d.
 *   2. AR-MATCHED SURROGATE NULL: replace the liquidity series with an AR(1) path matched to the
 *      autocorrelation + innovation variance of the real weekly-change series, re-derive positions.
 *      If the timer scores the same on AR noise, the liquidity *content* is zero.
 *   3. SPX-BETA CONTROL (the load-bearing extra gate): the timer must BEAT a coincident
 *      SPX-beta long-BTC control and must retain alpha after orthogonalizing daily PnL vs
 *      same-day SPX return AND vs BTC long return (de-risking is not enough; must add alpha).
 *   4. HONEST N = every config counted (slow-panel: ~2-3 independent macro cycles, documented).
 *   5. Net-of-cost 4bps/side, baselines (B&H / random-lottery), DSR@N, CPCV/PBO, Harvey-Liu,
 *      consume-once tail holdout.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
export const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);
const DAY = 86400000;

// ----------------------------------------------------------------- math utils
export function mean(a: number[]): number {
  const f = a.filter((x) => Number.isFinite(x));
  return f.length ? f.reduce((s, v) => s + v, 0) / f.length : 0;
}
export function std(a: number[]): number {
  const f = a.filter((x) => Number.isFinite(x));
  const n = f.length;
  if (n < 2) return 0;
  const m = mean(f);
  return Math.sqrt(Math.max(0, f.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
export function sharpeDaily(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
export function annSharpe(d: number): number {
  return d * ANN;
}
export function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussRng(rng: () => number): () => number {
  return () => {
    let u = 0,
      v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// ----------------------------------------------------------------- FRED CSV load
function readFredCsv(file: string): { date: string; t: number; v: number }[] {
  const txt = fs.readFileSync(file, "utf8").trim().split("\n").slice(1);
  const out: { date: string; t: number; v: number }[] = [];
  for (const ln of txt) {
    const [d, vs] = ln.split(",");
    const v = parseFloat(vs);
    if (!d || !Number.isFinite(v)) continue;
    out.push({ date: d, t: Date.parse(d + "T00:00:00Z"), v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Build a daily forward-filled, causally-lagged series over the target date grid.
// `lagDays`: the value attached to target day D is the most recent observation whose
// reference date <= D - lagDays (publication/availability lag, strictly causal).
function dailyLagged(
  series: { t: number; v: number }[],
  targetT: number[],
  lagDays: number,
): number[] {
  const out = new Array(targetT.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < targetT.length; i++) {
    const cutoff = targetT[i] - lagDays * DAY;
    while (j < series.length && series[j].t <= cutoff) j++;
    // series[j-1] is the most recent obs with reference t <= cutoff
    if (j > 0) out[i] = series[j - 1].v;
  }
  return out;
}

// ----------------------------------------------------------------- panel
export interface LiqPanel {
  dates: string[];
  t: number[];
  price: number[];
  fwdRet: number[]; // log price[t] -> price[t+1]; last = NaN
  netliq: number[]; // causally-lagged daily net liquidity ($M)
  m2: number[]; // causally-lagged daily M2 ($B)
  spxRet: number[]; // same-day SPX log return (for beta control); NaN if missing
}

export function loadPanel(): LiqPanel {
  const btc = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as {
    date: string;
    close: number;
  }[];
  btc.sort((a, b) => a.date.localeCompare(b.date));
  const dates = btc.map((r) => r.date);
  const t = dates.map((d) => Date.parse(d + "T00:00:00Z"));
  const price = btc.map((r) => r.close);

  const walcl = readFredCsv(`${ROOT}/output/edgehunt-requeue/WALCL.csv`); // $M weekly
  const tga = readFredCsv(`${ROOT}/output/edgehunt-requeue/WTREGEN.csv`); // $M weekly
  const rrp = readFredCsv(`${ROOT}/output/edgehunt-requeue/RRPONTSYD.csv`); // $B daily
  const m2 = readFredCsv(`${ROOT}/output/edgehunt-requeue/M2SL.csv`); // $B monthly

  // weekly bal-sheet series: lag 8 calendar days (Thu release of prior-Wed reference + buffer)
  const walD = dailyLagged(walcl, t, 8);
  const tgaD = dailyLagged(tga, t, 8);
  // RRP daily: lag 2 days
  const rrpD = dailyLagged(rrp, t, 2);
  // M2 monthly: lag 35 days (released ~3rd-4th week of following month)
  const m2D = dailyLagged(m2, t, 35);

  const netliq = walD.map((w, i) =>
    Number.isFinite(w) && Number.isFinite(tgaD[i]) && Number.isFinite(rrpD[i])
      ? w - tgaD[i] - rrpD[i] * 1000 // RRP $B -> $M
      : NaN,
  );

  // SPX same-day log return for the beta control (FRED SP500, ~10y history)
  const sp = readFredCsv(`${ROOT}/output/edgehunt-D6/SP500.csv`);
  const spMap = new Map<string, number>();
  for (const r of sp) spMap.set(r.date, r.v);
  // build same-day spx log-ret aligned to BTC dates (use prev available spx close)
  const spByT = sp; // sorted
  const spxLevel = dailyLagged(spByT, t, 0); // same-day level (ffill weekends/holidays)
  const spxRet = new Array(dates.length).fill(NaN);
  for (let i = 1; i < dates.length; i++) {
    if (spxLevel[i] > 0 && spxLevel[i - 1] > 0) spxRet[i] = Math.log(spxLevel[i] / spxLevel[i - 1]);
  }
  // NOTE: spxRet[i] is the SPX return realised over the same window as fwdRet[i] would be earned;
  // to align with fwdRet[t] (t->t+1) we want spx t->t+1. Build that:
  const spxFwd = new Array(dates.length).fill(NaN);
  for (let i = 0; i + 1 < dates.length; i++) {
    if (spxLevel[i] > 0 && spxLevel[i + 1] > 0)
      spxFwd[i] = Math.log(spxLevel[i + 1] / spxLevel[i]);
  }

  const fwdRet = new Array(dates.length).fill(NaN);
  for (let i = 0; i + 1 < dates.length; i++) fwdRet[i] = Math.log(price[i + 1] / price[i]);

  return { dates, t, price, fwdRet, netliq, m2: m2D, spxRet: spxFwd };
}

// ----------------------------------------------------------------- signal builders
// rate-of-change over `win` days, strictly causal (uses lagged series only)
export function roc(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = win; i < x.length; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(x[i - win]) && x[i - win] !== 0)
      out[i] = x[i] / x[i - win] - 1;
  }
  return out;
}
export function rollingZ(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - win + 1);
    const w: number[] = [];
    for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]);
    if (w.length < Math.min(40, win)) continue;
    const m = mean(w),
      s = std(w);
    out[i] = s > 1e-12 ? (x[i] - m) / s : 0;
  }
  return out;
}

// ----------------------------------------------------------------- backtest core
export interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  posSeries: number[]; // realised positions per traded day (aligned to retSeries)
  retSeries: number[]; // fwdRet earned per traded day
  spxSeries: number[]; // same-day spx fwd ret per traded day (for beta control)
  turnover: number;
  exposure: number;
  nDays: number;
  longShare: number;
}
export function runPositions(
  P: LiqPanel,
  position: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  const posSeries: number[] = [];
  const retSeries: number[] = [];
  const spxSeries: number[] = [];
  let prev = 0;
  let turnoverSum = 0,
    expSum = 0,
    longCount = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const fr = P.fwdRet[i];
    const pos = position[i];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev);
    const cost = turn * costPerSide;
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - cost);
    posSeries.push(pos);
    retSeries.push(fr);
    spxSeries.push(Number.isFinite(P.spxRet[i]) ? P.spxRet[i] : NaN);
    turnoverSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    prev = pos;
  }
  const n = dailyNet.length;
  return {
    dailyNet,
    dailyGross,
    posSeries,
    retSeries,
    spxSeries,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    nDays: n,
    longShare: n ? longCount / n : 0,
  };
}

// OLS residualization of strategy daily PnL on [1, spxRet, btcLongRet]. Returns residual series +
// the alpha (intercept, annualized Sharpe of residual). This is the SPX-beta + long-beta control:
// alpha must remain after stripping coincident SPX exposure AND BTC long exposure.
export function betaResidual(
  pnl: number[],
  spx: number[],
  btc: number[],
): { resid: number[]; alphaDaily: number; residSharpeAnn: number; betaSpx: number; betaBtc: number } {
  // rows with all finite
  const X: number[][] = [];
  const y: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < pnl.length; i++) {
    if (Number.isFinite(pnl[i]) && Number.isFinite(spx[i]) && Number.isFinite(btc[i])) {
      X.push([1, spx[i], btc[i]]);
      y.push(pnl[i]);
      idx.push(i);
    }
  }
  const n = y.length;
  if (n < 30) return { resid: pnl.slice(), alphaDaily: mean(pnl), residSharpeAnn: annSharpe(sharpeDaily(pnl)), betaSpx: NaN, betaBtc: NaN };
  // normal equations (3x3)
  const XtX = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const Xty = [0, 0, 0];
  for (let r = 0; r < n; r++) {
    for (let a = 0; a < 3; a++) {
      Xty[a] += X[r][a] * y[r];
      for (let b = 0; b < 3; b++) XtX[a][b] += X[r][a] * X[r][b];
    }
  }
  const beta = solve3(XtX, Xty);
  const resid: number[] = [];
  for (let r = 0; r < n; r++) {
    const fit = beta[0] + beta[1] * X[r][1] + beta[2] * X[r][2];
    resid.push(y[r] - fit);
  }
  return {
    resid,
    alphaDaily: beta[0],
    residSharpeAnn: annSharpe(sharpeDaily(resid)),
    betaSpx: beta[1],
    betaBtc: beta[2],
  };
}
function solve3(A: number[][], b: number[]): number[] {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let k = c; k < 4; k++) M[c][k] /= d;
    for (let r = 0; r < 3; r++)
      if (r !== c) {
        const f = M[r][c];
        for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
      }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

// ----------------------------------------------------------------- normal helpers (haircut)
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdfLocal(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}

// ----------------------------------------------------------------- AR(1)-matched surrogate
// Fit AR(1) on the weekly-change of the liquidity LEVEL, then simulate a surrogate level path
// with matched phi + innovation sigma, anchored at the real start level. Returns surrogate level.
export function arSurrogateLevel(level: number[], rng: () => number): number[] {
  const g = gaussRng(rng);
  // changes
  const dl: number[] = [];
  for (let i = 1; i < level.length; i++) {
    if (Number.isFinite(level[i]) && Number.isFinite(level[i - 1])) dl.push(level[i] - level[i - 1]);
    else dl.push(NaN);
  }
  const df = dl.filter((x) => Number.isFinite(x));
  const mu = mean(df);
  // AR(1) phi on the de-meaned changes
  let num = 0,
    den = 0;
  for (let i = 1; i < dl.length; i++) {
    if (Number.isFinite(dl[i]) && Number.isFinite(dl[i - 1])) {
      num += (dl[i] - mu) * (dl[i - 1] - mu);
      den += (dl[i - 1] - mu) ** 2;
    }
  }
  const phi = den > 0 ? Math.max(-0.99, Math.min(0.99, num / den)) : 0;
  const sdChg = std(df);
  const sigInnov = sdChg * Math.sqrt(Math.max(1e-9, 1 - phi * phi));
  // simulate
  const out = new Array(level.length).fill(NaN);
  // find first finite level as anchor
  let start = 0;
  while (start < level.length && !Number.isFinite(level[start])) start++;
  if (start >= level.length) return out;
  out[start] = level[start];
  let chgPrev = 0;
  for (let i = start + 1; i < level.length; i++) {
    const innov = sigInnov * g();
    const chg = mu + phi * (chgPrev - mu) + innov;
    out[i] = out[i - 1] + chg;
    chgPrev = chg;
  }
  return out;
}

// ----------------------------------------------------------------- gauntlet
export interface GauntletInput {
  name: string;
  P: LiqPanel;
  source: number[]; // the raw lagged liquidity LEVEL series the signal derives from (for AR null)
  buildPositionFromLevel: (level: number[], cfg: Record<string, number | string>) => number[];
  configs: Record<string, number | string>[];
  canonical: Record<string, number | string>;
  startIdx: number;
  holdoutFrac?: number;
  nSurr?: number;
  honestNCycles?: number; // for documentation of the slow-panel honest N
  honestNOverride?: number; // count every config across the FULL search (both proxies) for DSR/haircut
}
export interface GateResult {
  pass: boolean;
  detail: string;
}

function toFolds(series: number[], nfolds: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / nfolds);
  for (let f = 0; f < nfolds; f++) {
    const lo = f * sz;
    const hi = f === nfolds - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}

export function runGauntlet(input: GauntletInput) {
  const { P, configs, source } = input;
  const HONEST_N = input.honestNOverride ?? configs.length;
  const holdoutFrac = input.holdoutFrac ?? 0.2;
  const nSurr = input.nSurr ?? 400;
  const T = P.price.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - input.startIdx;
  const splitIdx = input.startIdx + Math.floor(span * (1 - holdoutFrac));

  // score every config in-sample on net Sharpe
  const scored = configs.map((cfg) => {
    const pos = input.buildPositionFromLevel(source, cfg);
    const res = runPositions(P, pos, input.startIdx, splitIdx);
    const label = Object.entries(cfg)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return { cfg, label, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // ---- baselines: coincident SPX-beta long-BTC control = buy&hold (B&H IS the long-beta control)
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(P, bhPos, input.startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let tt = input.startIdx; tt < splitIdx; tt++) pos[tt] = rng() < exposure ? 1 : 0;
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // ---- SPX-beta + long-beta ALPHA control (load-bearing): strip coincident SPX & BTC-long exposure
  const br = betaResidual(best.res.dailyNet, best.res.spxSeries, best.res.retSeries);
  // alpha gate: residual mean > 0 AND residual Sharpe materially positive
  const sr = summarizeReturnSeries(br.resid);
  const alphaPsrZ = zSharpe(br.resid);
  const alphaPsrP = 1 - normalCdfLocal(alphaPsrZ);
  const betaControlPass = br.alphaDaily > 0 && br.residSharpeAnn > 0 && alphaPsrP < 0.05;

  // ---- DSR @ honest N
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---- block bootstrap CI (block 20d ~ monthly autocorrelation honest)
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 20,
    confidenceLevel: 0.95,
    seed: `${input.name}-bb`,
  });
  const bbPass = bb.lower > 0;

  // ---- CSCV / PBO
  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try {
    const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch {
    pbo = { pbo: 1, medianLogit: 0 };
  }
  const pboPass = pbo.pbo < 0.5;

  // ---- Harvey-Liu Bonferroni haircut
  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---- AR-matched surrogate null (the RIGHT null for liquidity content)
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const surLevel = arSurrogateLevel(source, rng);
    const pos = input.buildPositionFromLevel(surLevel, best.cfg);
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((s) => s >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // surrogate against the ALPHA (residual) too: does AR noise produce the same residual alpha?
  const surrAlpha: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(13000 + i * 6151);
    const surLevel = arSurrogateLevel(source, rng);
    const pos = input.buildPositionFromLevel(surLevel, best.cfg);
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    const b = betaResidual(r.dailyNet, r.spxSeries, r.retSeries);
    surrAlpha.push(b.residSharpeAnn);
  }
  surrAlpha.sort((a, b) => a - b);
  const surrAlphaP = (surrAlpha.filter((s) => s >= br.residSharpeAnn).length + 1) / (nSurr + 1);

  // ---- consume-once holdout
  const holdRes = runPositions(P, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // ---- canonical (N=1)
  const canonPos = input.buildPositionFromLevel(source, input.canonical);
  const canonRes = runPositions(P, canonPos, input.startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    const surLevel = arSurrogateLevel(source, rng);
    const pos = input.buildPositionFromLevel(surLevel, input.canonical);
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    canonSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHold = runPositions(P, canonPos, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  const gates: Record<string, GateResult> = {
    net_of_cost: {
      pass: mean(bestNet) > 0,
      detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(4)} exposure=${best.res.exposure.toFixed(3)}`,
    },
    baselines: {
      pass: baselinePass,
      detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H(long-beta)=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}`,
    },
    spx_beta_alpha: {
      pass: betaControlPass,
      detail: `residAlphaSh=${br.residSharpeAnn.toFixed(3)} alphaDaily=${br.alphaDaily.toExponential(2)} betaSPX=${br.betaSpx.toFixed(3)} betaBTC=${br.betaBtc.toFixed(3)} psrP=${alphaPsrP.toExponential(2)} surrAlphaP=${surrAlphaP.toFixed(3)}`,
    },
    deflated_sharpe: {
      pass: dsrPass,
      detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N}`,
    },
    block_bootstrap: {
      pass: bbPass,
      detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
    },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)}*N)` },
    surrogate_AR: {
      pass: surrPass,
      detail: `AR-matched placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
    },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays} rows` },
  };

  const order = [
    "net_of_cost",
    "baselines",
    "spx_beta_alpha",
    "deflated_sharpe",
    "block_bootstrap",
    "cpcv_pbo",
    "haircut",
    "surrogate_AR",
    "holdout",
  ];
  let binding = "none";
  for (const g of order) {
    if (!gates[g].pass) {
      binding = g;
      break;
    }
  }
  const allPass = binding === "none";
  const survivesCore =
    gates.net_of_cost.pass &&
    gates.baselines.pass &&
    gates.spx_beta_alpha.pass &&
    gates.surrogate_AR.pass &&
    gates.holdout.pass;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (allPass) verdict = "SURVIVE";
  else if (survivesCore) verdict = "PROMISING";
  else verdict = "KILL";

  const meanDailyNet = mean(bestNet);
  const out = {
    name: input.name,
    honestN: HONEST_N,
    honestNCycles: input.honestNCycles ?? null,
    best: {
      label: best.label,
      cfg: best.cfg,
      netSharpeAnn: best.netSh,
      grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)),
      meanDailyNet,
      turnover: best.res.turnover,
      exposure: best.res.exposure,
      longShare: best.res.longShare,
      nDays: best.res.nDays,
      monthlyAt100k: meanDailyNet * 30 * 100000,
    },
    canonical: { netSharpeAnn: canonSh, surrogateP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
    betaControl: { residSharpeAnn: br.residSharpeAnn, alphaDaily: br.alphaDaily, betaSpx: br.betaSpx, betaBtc: br.betaBtc, surrAlphaP },
    gates,
    bindingGate: binding,
    verdict,
    surrogateP: surrP,
    holdoutSharpeAnn: holdSh,
    bhSharpe: bhSh,
  };
  return out;
}

export function printVerdict(o: ReturnType<typeof runGauntlet>): void {
  console.log(`\n================ ${o.name} ================`);
  console.log(`honestN=${o.honestN} (cycles~${o.honestNCycles})  best=${o.best.label}`);
  console.log(
    `best netSharpeAnn=${o.best.netSharpeAnn.toFixed(3)} grossSharpeAnn=${o.best.grossSharpeAnn.toFixed(3)} turnover=${o.best.turnover.toFixed(4)} exposure=${o.best.exposure.toFixed(3)} longShare=${o.best.longShare.toFixed(2)} nDays=${o.best.nDays}`,
  );
  console.log(`  long-beta(B&H) Sharpe=${o.bhSharpe.toFixed(3)}`);
  for (const [g, r] of Object.entries(o.gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  console.log(
    `canonical: netSharpeAnn=${o.canonical.netSharpeAnn.toFixed(3)} surrP=${o.canonical.surrogateP.toFixed(4)} holdoutSharpeAnn=${o.canonical.holdoutSharpeAnn.toFixed(3)}`,
  );
  const monthly = o.bindingGate === "none" ? `$${Math.round(o.best.monthlyAt100k)}` : "n/a";
  console.log(
    `VERDICT: ${o.verdict} | net Sharpe ${o.best.netSharpeAnn.toFixed(3)} | binding gate ${o.bindingGate} | honest N ${o.honestN} | surrogate p ${o.surrogateP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${o.holdoutSharpeAnn.toFixed(3)}`,
  );
}
