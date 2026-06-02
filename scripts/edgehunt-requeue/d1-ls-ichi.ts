/**
 * D1-LS-ICHI — Ichimoku cloud, CROSS-SECTIONAL LONG-SHORT (dollar-neutral).
 *
 * Belief under test: the unfalsified indicator branch is MARKET-NEUTRAL. Every long-flat
 * Ichimoku branch (D1-01) was just long-beta. So: rank the 8 majors each day by Ichimoku
 * cloud position / Tenkan-Kijun momentum, go dollar-neutral long-top / short-bottom. Static
 * beta cannot be harvested by construction (sum of weights = 0). If a cross-sectional Ichimoku
 * tilt has any real predictive content for the RELATIVE performance of the majors, it should
 * survive a cross-sectional shuffle null (permute which asset gets which signal each day,
 * holding the realized cross-section of returns fixed).
 *
 * Data: output/nf1/{ASSET}_daily_ohlc.json (8 majors, real OHLC). Common contiguous window
 *   2020-09-22..2026-05-18, 2065 days, 0 gaps. Ichimoku needs highs/lows -> nf1 (closes-only
 *   crossxs panel cannot build the cloud).
 *
 * Causality: every Ichimoku component at decision-time t uses only data <= t. The forward-shifted
 *   cloud (Senkou A/B) at t is, per the standard definition, computed from data at t-26 -> doubly
 *   causal. Position formed at close t, earns log-return t->t+1. Cost = 4 bps taker / side on
 *   per-asset turnover.
 *
 * Gauntlet (committed primitives, training/statistical-validation.ts):
 *   net-of-cost; baselines (B&H equal-weight long, random dollar-neutral lottery, the
 *   long-flat Ichimoku timing book = the killed D1-01 branch); Deflated Sharpe @ HONEST N
 *   (= every config scored, incl. both signals x grids x rank rules); CPCV/PBO; Harvey-Liu
 *   Bonferroni haircut; the RIGHT null = CROSS-SECTIONAL SHUFFLE; consume-once forward holdout.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const ASSETS = ["ADA", "AVAX", "BNB", "BTC", "DOGE", "ETH", "SOL", "XRP"];
const COST_PER_SIDE = 0.0004; // 4 bps taker / side
const ANN = Math.sqrt(365);

// ---------------- data ----------------
type Bar = { date: string; open: number; high: number; low: number; close: number };
function loadAsset(a: string): Map<string, Bar> {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${a}_daily_ohlc.json`, "utf8"));
  const m = new Map<string, Bar>();
  for (const r of raw)
    m.set(r.date, { date: r.date, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
  return m;
}

const byAsset = new Map<string, Map<string, Bar>>();
for (const a of ASSETS) byAsset.set(a, loadAsset(a));
// common contiguous date axis
let common: string[] | null = null;
for (const a of ASSETS) {
  const ds = new Set(byAsset.get(a)!.keys());
  common = common ? common.filter((d) => ds.has(d)) : [...ds];
}
common!.sort();
const DATES = common!;
const T = DATES.length;
const A = ASSETS.length;

// matrices [t][asset]
const close: number[][] = DATES.map((d) => ASSETS.map((a) => byAsset.get(a)!.get(d)!.close));
const high: number[][] = DATES.map((d) => ASSETS.map((a) => byAsset.get(a)!.get(d)!.high));
const low: number[][] = DATES.map((d) => ASSETS.map((a) => byAsset.get(a)!.get(d)!.low));
// forward log return t->t+1 per asset
const fwdRet: number[][] = [];
for (let t = 0; t < T; t++) {
  fwdRet.push(
    ASSETS.map((_, j) => (t + 1 < T ? Math.log(close[t + 1][j] / close[t][j]) : NaN)),
  );
}

// ---------------- math ----------------
function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
function annSharpe(d: number): number {
  return d * ANN;
}
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// rolling Donchian midpoint (max high + min low)/2 over `win` ending at t (causal)
function donchianMid(win: number): number[][] {
  const out: number[][] = Array.from({ length: T }, () => new Array(A).fill(NaN));
  for (let j = 0; j < A; j++) {
    for (let t = 0; t < T; t++) {
      if (t + 1 < win) continue;
      let hi = -Infinity,
        lo = Infinity;
      for (let k = t - win + 1; k <= t; k++) {
        if (high[k][j] > hi) hi = high[k][j];
        if (low[k][j] < lo) lo = low[k][j];
      }
      out[t][j] = (hi + lo) / 2;
    }
  }
  return out;
}

// ---------------- Ichimoku signals (causal) ----------------
// returns { cloudPos, tkMom } as [t][asset] continuous cross-sectional signals.
// tenkanW/kijunW/senkouBW = the three windows; shift = forward displacement of the cloud.
function ichimokuSignals(tenkanW: number, kijunW: number, senkouBW: number, shift: number) {
  const tenkan = donchianMid(tenkanW);
  const kijun = donchianMid(kijunW);
  const senkouBraw = donchianMid(senkouBW);
  // Senkou A raw = (tenkan+kijun)/2 ; both A and B are displaced FORWARD by `shift`.
  // cloud value at decision-time t = displaced series evaluated at t = raw value at (t-shift).
  const cloudPos: number[][] = Array.from({ length: T }, () => new Array(A).fill(NaN));
  const tkMom: number[][] = Array.from({ length: T }, () => new Array(A).fill(NaN));
  for (let t = 0; t < T; t++) {
    const src = t - shift;
    for (let j = 0; j < A; j++) {
      // TK momentum: tenkan-kijun normalized by price (both at t, causal)
      const tk = tenkan[t][j],
        kj = kijun[t][j];
      if (Number.isFinite(tk) && Number.isFinite(kj) && close[t][j] > 0)
        tkMom[t][j] = (tk - kj) / close[t][j];
      // cloud position: close[t] vs cloud midpoint (displaced cloud, src index)
      if (src >= 0) {
        const sa = (tenkan[src][j] + kijun[src][j]) / 2; // Senkou A raw at src
        const sb = senkouBraw[src][j]; // Senkou B raw at src
        if (Number.isFinite(sa) && Number.isFinite(sb) && close[t][j] > 0) {
          const mid = (sa + sb) / 2;
          cloudPos[t][j] = (close[t][j] - mid) / close[t][j];
        }
      }
    }
  }
  return { cloudPos, tkMom };
}

// ---------------- cross-sectional dollar-neutral weights ----------------
// Given a per-day signal vector across assets, build dollar-neutral weights:
//   - rank "rule": 'topbot' (long top-k, short bottom-k, equal weight) or 'zscore' (demeaned z).
// gross exposure normalized to 1 (sum|w|=1). Returns null where < minValid assets present.
function weightsFromSignal(
  sig: number[],
  rule: string,
  topK: number,
): number[] | null {
  const idx: number[] = [];
  for (let j = 0; j < A; j++) if (Number.isFinite(sig[j])) idx.push(j);
  if (idx.length < 6) return null; // need a real cross-section
  const w = new Array(A).fill(0);
  if (rule === "zscore") {
    const vals = idx.map((j) => sig[j]);
    const m = mean(vals),
      s = std(vals);
    if (s < 1e-12) return null;
    let gross = 0;
    for (const j of idx) {
      w[j] = (sig[j] - m) / s;
      gross += Math.abs(w[j]);
    }
    if (gross < 1e-12) return null;
    for (const j of idx) w[j] /= gross;
    return w;
  }
  // topbot: sort by signal, long top K, short bottom K, equal weight, dollar-neutral
  const sorted = [...idx].sort((p, q) => sig[p] - sig[q]); // ascending
  const k = Math.min(topK, Math.floor(sorted.length / 2));
  if (k < 1) return null;
  const longs = sorted.slice(sorted.length - k);
  const shorts = sorted.slice(0, k);
  // gross = 1 -> each side 0.5
  for (const j of longs) w[j] = 0.5 / k;
  for (const j of shorts) w[j] = -0.5 / k;
  return w;
}

// pick signal field by name
function signalMatrix(
  sigs: { cloudPos: number[][]; tkMom: number[][] },
  name: string,
  combine: number,
): number[][] {
  if (name === "cloud") return sigs.cloudPos;
  if (name === "tk") return sigs.tkMom;
  // combo: cross-sectionally z each then average (combine in [0,1] weight on cloud)
  const out: number[][] = Array.from({ length: T }, () => new Array(A).fill(NaN));
  for (let t = 0; t < T; t++) {
    const c = sigs.cloudPos[t],
      k = sigs.tkMom[t];
    const ci: number[] = [],
      ki: number[] = [];
    for (let j = 0; j < A; j++) {
      if (Number.isFinite(c[j])) ci.push(c[j]);
      if (Number.isFinite(k[j])) ki.push(k[j]);
    }
    const cm = mean(ci),
      cs = std(ci),
      km = mean(ki),
      ks = std(ki);
    for (let j = 0; j < A; j++) {
      const cz = cs > 1e-12 && Number.isFinite(c[j]) ? (c[j] - cm) / cs : NaN;
      const kz = ks > 1e-12 && Number.isFinite(k[j]) ? (k[j] - km) / ks : NaN;
      if (Number.isFinite(cz) && Number.isFinite(kz))
        out[t][j] = combine * cz + (1 - combine) * kz;
    }
  }
  return out;
}

// ---------------- backtest a weights path ----------------
type Cfg = {
  signal: string; // 'cloud' | 'tk' | 'combo'
  tenkanW: number;
  kijunW: number;
  senkouBW: number;
  shift: number;
  rule: string; // 'topbot' | 'zscore'
  topK: number;
  combine: number; // for combo
};

function cfgKey(c: Cfg): string {
  return `${c.signal}|t${c.tenkanW}|k${c.kijunW}|b${c.senkouBW}|s${c.shift}|${c.rule}|K${c.topK}|c${c.combine}`;
}

const sigCache = new Map<string, { cloudPos: number[][]; tkMom: number[][] }>();
function getSigs(c: Cfg) {
  const key = `${c.tenkanW}|${c.kijunW}|${c.senkouBW}|${c.shift}`;
  let s = sigCache.get(key);
  if (!s) {
    s = ichimokuSignals(c.tenkanW, c.kijunW, c.senkouBW, c.shift);
    sigCache.set(key, s);
  }
  return s;
}

// daily weights matrix for a config
function weightsPath(c: Cfg): (number[] | null)[] {
  const sigs = getSigs(c);
  const M = signalMatrix(sigs, c.signal, c.combine);
  const W: (number[] | null)[] = [];
  for (let t = 0; t < T; t++) W.push(weightsFromSignal(M[t], c.rule, c.topK));
  return W;
}

// run a weights path over [lo,hi): returns daily net portfolio returns + diagnostics.
function runWeights(
  W: (number[] | null)[],
  lo: number,
  hi: number,
): { daily: number[]; gross: number[]; turnover: number; netBeta: number } {
  const daily: number[] = [];
  const gross: number[] = [];
  let prev = new Array(A).fill(0);
  let turnSum = 0;
  let betaSum = 0;
  let cnt = 0;
  for (let t = lo; t < hi; t++) {
    const w = W[t];
    if (!w) {
      continue;
    }
    // ensure fwdRet finite for all weighted assets
    let ok = true;
    let g = 0;
    let netW = 0;
    for (let j = 0; j < A; j++) {
      if (w[j] !== 0 && !Number.isFinite(fwdRet[t][j])) {
        ok = false;
        break;
      }
      g += w[j] * fwdRet[t][j];
      netW += w[j];
    }
    if (!ok) continue;
    let turn = 0;
    for (let j = 0; j < A; j++) turn += Math.abs(w[j] - prev[j]);
    const cost = turn * COST_PER_SIDE;
    gross.push(g);
    daily.push(g - cost);
    turnSum += turn;
    betaSum += Math.abs(netW);
    cnt++;
    prev = w;
  }
  return {
    daily,
    gross,
    turnover: cnt ? turnSum / cnt : 0,
    netBeta: cnt ? betaSum / cnt : 0,
  };
}

// ---------------- cross-sectional SHUFFLE null ----------------
// Permute which asset receives which weight each day, holding the realized cross-section of
// returns fixed. Destroys the signal<->asset mapping; preserves dollar-neutrality, daily gross
// magnitude, and the return cross-section. This is the RIGHT null for a cross-sectional claim.
function runShuffle(
  W: (number[] | null)[],
  lo: number,
  hi: number,
  rng: () => number,
): number[] {
  const daily: number[] = [];
  let prev = new Array(A).fill(0);
  for (let t = lo; t < hi; t++) {
    const w = W[t];
    if (!w) continue;
    // valid asset indices (finite fwdRet)
    const valid: number[] = [];
    for (let j = 0; j < A; j++) if (Number.isFinite(fwdRet[t][j])) valid.push(j);
    if (valid.length < A) {
      // if any asset's return missing, only permute among valid; skip if weight on invalid
      let bad = false;
      for (let j = 0; j < A; j++) if (w[j] !== 0 && !Number.isFinite(fwdRet[t][j])) bad = true;
      if (bad) continue;
    }
    // Fisher-Yates permutation of asset labels
    const perm = [...Array(A).keys()];
    for (let i = A - 1; i > 0; i--) {
      const r = Math.floor(rng() * (i + 1));
      [perm[i], perm[r]] = [perm[r], perm[i]];
    }
    // shuffled weights: asset perm[j] gets weight w[j]
    const ws = new Array(A).fill(0);
    for (let j = 0; j < A; j++) ws[perm[j]] = w[j];
    let g = 0,
      ok = true;
    for (let j = 0; j < A; j++) {
      if (ws[j] !== 0 && !Number.isFinite(fwdRet[t][j])) {
        ok = false;
        break;
      }
      g += ws[j] * fwdRet[t][j];
    }
    if (!ok) continue;
    let turn = 0;
    for (let j = 0; j < A; j++) turn += Math.abs(ws[j] - prev[j]);
    daily.push(g - turn * COST_PER_SIDE);
    prev = ws;
  }
  return daily;
}

// ---------------- config grid (HONEST N) ----------------
function buildGrid(): Cfg[] {
  const cfgs: Cfg[] = [];
  // standard + alternative Ichimoku windows
  const windowSets = [
    [9, 26, 52, 26], // classic Hosoda
    [7, 22, 44, 22], // crypto-fast
    [10, 30, 60, 30], // slow
    [20, 60, 120, 30], // very slow (TSMOM-ish)
  ];
  const signals = ["cloud", "tk", "combo"];
  const rules: { rule: string; topK: number }[] = [
    { rule: "topbot", topK: 1 },
    { rule: "topbot", topK: 2 },
    { rule: "topbot", topK: 3 },
    { rule: "zscore", topK: 0 },
  ];
  const combines = [0.5]; // only used by combo
  for (const [tw, kw, bw, sh] of windowSets) {
    for (const sg of signals) {
      for (const r of rules) {
        const cm = sg === "combo" ? combines : [0.5];
        for (const c of cm) {
          cfgs.push({
            signal: sg,
            tenkanW: tw,
            kijunW: kw,
            senkouBW: bw,
            shift: sh,
            rule: r.rule,
            topK: r.topK,
            combine: c,
          });
        }
      }
    }
  }
  return cfgs;
}

// ---------------- gauntlet ----------------
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(
    Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh),
  );
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
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

function main() {
  const grid = buildGrid();
  const HONEST_N = grid.length;
  // warmup = max window + shift, plus a buffer
  const warmup = 120 + 30 + 5;
  const startIdx = warmup;
  const tradableEnd = T - 1; // last day no fwdRet
  const holdoutFrac = 0.2;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));

  // score every config in-sample on net Sharpe
  const scored = grid.map((cfg) => {
    const W = weightsPath(cfg);
    const r = runWeights(W, startIdx, splitIdx);
    return {
      cfg,
      W,
      r,
      label: cfgKey(cfg),
      netSh: annSharpe(sharpeDaily(r.daily)),
    };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.r.daily;
  const bestNetSh = best.netSh;

  // ---- baselines ----
  // (1) buy&hold equal-weight long (the long-beta book we must NOT be) over same window
  const bhDaily: number[] = [];
  for (let t = startIdx; t < splitIdx; t++) {
    let ok = true,
      g = 0;
    for (let j = 0; j < A; j++) {
      if (!Number.isFinite(fwdRet[t][j])) {
        ok = false;
        break;
      }
      g += fwdRet[t][j] / A;
    }
    if (ok) bhDaily.push(g);
  }
  const bhSh = annSharpe(sharpeDaily(bhDaily));
  // (2) random dollar-neutral lottery: random +/- equal-weight books, matched gross=1, topK=best
  const bestK =
    best.cfg.rule === "topbot" ? best.cfg.topK : Math.floor(A / 2);
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(515151 + i * 2654435761);
    const Wr: (number[] | null)[] = [];
    for (let t = 0; t < T; t++) {
      const order = [...Array(A).keys()];
      for (let q = A - 1; q > 0; q--) {
        const rr = Math.floor(rng() * (q + 1));
        [order[q], order[rr]] = [order[rr], order[q]];
      }
      const w = new Array(A).fill(0);
      for (let m = 0; m < bestK; m++) {
        w[order[m]] = 0.5 / bestK;
        w[order[A - 1 - m]] = -0.5 / bestK;
      }
      Wr.push(w);
    }
    const r = runWeights(Wr, startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.daily)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  // baselines pass: market-neutral edge must beat random dollar-neutral AND be positive AND
  // not merely equal long-beta (we explicitly want netBeta ~ 0).
  const baselinePass = bestNetSh > rl95 && bestNetSh > 0;

  // ---- Deflated Sharpe @ honest N ----
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---- block bootstrap CI on mean daily net ----
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 20,
    confidenceLevel: 0.95,
    seed: "d1-ls-ichi-bb",
  });
  const bbPass = bb.lower > 0;

  // ---- CSCV / PBO ----
  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.r.daily, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try {
    const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch (e) {
    pbo = { pbo: 1, medianLogit: 0 };
  }
  const pboPass = pbo.pbo < 0.5;

  // ---- Harvey-Liu Bonferroni haircut ----
  const psrP = 1 - normalCdf(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---- RIGHT null: CROSS-SECTIONAL SHUFFLE ----
  const nSurr = 1000;
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(31337 + i * 7919);
    const d = runShuffle(best.W, startIdx, splitIdx, rng);
    surr.push(annSharpe(sharpeDaily(d)));
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((s) => s >= bestNetSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // ---- consume-once forward holdout (best cfg only) ----
  const holdRes = runWeights(best.W, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.daily));
  const holdoutPass = holdSh > 0;
  // holdout shuffle p for honesty
  const holdSurr: number[] = [];
  for (let i = 0; i < 500; i++) {
    const rng = mkRng(81818 + i * 6271);
    const d = runShuffle(best.W, splitIdx, tradableEnd, rng);
    holdSurr.push(annSharpe(sharpeDaily(d)));
  }
  holdSurr.sort((a, b) => a - b);
  const holdSurrP =
    (holdSurr.filter((s) => s >= holdSh).length + 1) / (holdSurr.length + 1);

  // ---- canonical pre-registered config (N=1): classic Hosoda 9/26/52/26, cloud, topbot K=2 ----
  const canon: Cfg = {
    signal: "cloud",
    tenkanW: 9,
    kijunW: 26,
    senkouBW: 52,
    shift: 26,
    rule: "topbot",
    topK: 2,
    combine: 0.5,
  };
  const canonW = weightsPath(canon);
  const canonRes = runWeights(canonW, startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.daily));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(424242 + i * 7919);
    const d = runShuffle(canonW, startIdx, splitIdx, rng);
    canonSurr.push(annSharpe(sharpeDaily(d)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP =
    (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHold = runWeights(canonW, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.daily));

  // ---- gates ----
  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: {
      pass: mean(bestNet) > 0,
      detail: `meanDailyNet=${mean(bestNet).toExponential(3)} turnover=${best.r.turnover.toFixed(3)} netBeta=${best.r.netBeta.toExponential(2)}`,
    },
    baselines: {
      pass: baselinePass,
      detail: `bestNetSh=${bestNetSh.toFixed(3)} vs randDN95=${rl95.toFixed(3)} | EWlong(beta)Sh=${bhSh.toFixed(3)} canonSh=${canonSh.toFixed(3)}`,
    },
    deflated_sharpe: {
      pass: dsrPass,
      detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} sh(daily)=${sharpeDaily(bestNet).toFixed(4)}`,
    },
    block_bootstrap: {
      pass: bbPass,
      detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
    },
    cpcv_pbo: {
      pass: pboPass,
      detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}`,
    },
    haircut: {
      pass: haircutPass,
      detail: `BonferroniAdjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})`,
    },
    surrogate_xshuffle: {
      pass: surrPass,
      detail: `xshuffleP=${surrP.toFixed(4)} real=${bestNetSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
    },
    holdout: {
      pass: holdoutPass,
      detail: `OOS netSh=${holdSh.toFixed(3)} over ${holdRes.daily.length} rows | holdoutXshuffleP=${holdSurrP.toFixed(4)}`,
    },
  };
  const order = [
    "net_of_cost",
    "baselines",
    "deflated_sharpe",
    "block_bootstrap",
    "cpcv_pbo",
    "haircut",
    "surrogate_xshuffle",
    "holdout",
  ];
  let binding = "none";
  for (const g of order)
    if (!gates[g].pass) {
      binding = g;
      break;
    }
  const allPass = binding === "none";
  const survivesCore =
    gates.net_of_cost.pass &&
    gates.baselines.pass &&
    gates.surrogate_xshuffle.pass &&
    gates.holdout.pass;
  let verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
  const meanDailyNet = mean(bestNet);
  const monthlyAt100k = meanDailyNet * 30 * 100000;

  // ---- report ----
  console.log(`\n================ D1-LS-ICHI (cross-sectional long-short) ================`);
  console.log(
    `panel: ${A} assets, ${DATES[0]}..${DATES[tradableEnd]}, T=${T}, startIdx=${startIdx}, splitIdx=${splitIdx}, holdoutRows=${tradableEnd - splitIdx}`,
  );
  console.log(`honestN=${HONEST_N}`);
  console.log(`best cfg = ${best.label}`);
  console.log(
    `best netSharpeAnn=${bestNetSh.toFixed(3)} grossSh=${annSharpe(sharpeDaily(best.r.gross)).toFixed(3)} turnover=${best.r.turnover.toFixed(3)} netBeta=${best.r.netBeta.toExponential(2)} nDays=${best.r.daily.length}`,
  );
  console.log(`--- top 8 configs by in-sample net Sharpe ---`);
  for (const s of scored.slice(0, 8))
    console.log(`  ${s.netSh.toFixed(3)}  ${s.label}  turn=${s.r.turnover.toFixed(2)}`);
  for (const g of order)
    console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
  console.log(
    `canonical(Hosoda 9/26/52 cloud topbotK2): netSh=${canonSh.toFixed(3)} xshuffleP=${canonSurrP.toFixed(4)} holdoutSh=${canonHoldSh.toFixed(3)}`,
  );
  const monthly = allPass ? `$${Math.round(monthlyAt100k)}` : "n/a";
  const out = {
    name: "D1-LS-ICHI",
    honestN: HONEST_N,
    best: best.label,
    bestNetSharpeAnn: bestNetSh,
    netBeta: best.r.netBeta,
    turnover: best.r.turnover,
    gates,
    binding,
    verdict,
    surrP,
    holdSh,
    holdSurrP,
    canonical: { netSh: canonSh, surrP: canonSurrP, holdSh: canonHoldSh },
    monthlyAt100k,
  };
  fs.writeFileSync(
    `${ROOT}/output/edgehunt-requeue/d1-ls-ichi-result.json`,
    JSON.stringify(out, null, 2),
  );
  console.log(
    `\nVERDICT: ${verdict} | net Sharpe ${bestNetSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSh ${holdSh.toFixed(3)} xshufP ${holdSurrP.toFixed(3)}`,
  );
}

main();
