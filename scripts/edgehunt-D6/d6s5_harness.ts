/**
 * D6-S5 — News sentiment tone (GDELT) -> next-day BTC return.
 *
 * Belief: positive aggregate tone precedes next-day gains. Strongest honest version:
 *   - tone z-score (level) and tone-change / impulse (Δtone), BOTH strictly lagged through prior day.
 *   - DE-TREND tone vs price runs (KEY control): financial-news tone is overwhelmingly REACTIVE —
 *     a lagged transform of recent returns. We orthogonalize tone against trailing BTC momentum
 *     (causally, with an expanding OLS) and trade the RESIDUAL tone so any surviving edge is not just
 *     a relabelled long-beta / momentum bet.
 *
 * STRICT causality: signal uses tone/density known at the close of day t-1 (lag>=1); position taken
 * at close of t; return earned over t -> t+1. So the feature is lagged >= 1 trading day vs the return.
 *
 * The committed gauntlet (mirrors scripts/edgehunt-D5/harness.ts): net-of-cost, baselines
 * (buy&hold + long-beta + random-lottery), Deflated Sharpe @ HONEST N, block-bootstrap CI, CSCV/PBO,
 * Harvey-Liu (Bonferroni) haircut, consume-once forward holdout, and — the RIGHT surrogate null for
 * a reactive-sentiment timer — an AR(1)-matched tone PLACEBO that preserves tone's autocorrelation and
 * variance but destroys its alignment to price. A real edge must beat that placebo AND buy&hold.
 *
 * Cost: 4 bps taker per side (repo COST_PER_SIDE), realistic for liquid BTC spot.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
export const COST_PER_SIDE = 0.0004;
const ANN = Math.sqrt(365);

// ----------------------------------------------------------------- data load
export interface D6Panel {
  dates: string[];
  price: number[];
  tone: number[]; // raw GDELT daily mean tone, aligned to BTC days (NaN where missing)
  volume: number[]; // raw GDELT daily article volume (density)
  fwdRet: number[]; // log price[t]->price[t+1]; last = NaN
  ret: number[]; // contemporaneous log return price[t-1]->price[t]; first = NaN (for de-trend regressor)
}

export function loadD6Panel(): D6Panel {
  const btc: { date: string; close: number }[] = JSON.parse(
    fs.readFileSync(`${ROOT}/output/edgehunt/btc_daily_close.json`, "utf8"),
  );
  const gd = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D6/gdelt_tone.json`, "utf8"));
  const tMap = new Map<string, number>();
  const vMap = new Map<string, number>();
  for (const r of gd.daily as { date: string; tone: number | null; volume: number | null }[]) {
    if (r.tone != null) tMap.set(r.date, r.tone);
    if (r.volume != null) vMap.set(r.date, r.volume);
  }
  const P: D6Panel = { dates: [], price: [], tone: [], volume: [], fwdRet: [], ret: [] };
  const sorted = [...btc].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of sorted) {
    if (!(r.close > 0)) continue;
    P.dates.push(r.date);
    P.price.push(r.close);
    P.tone.push(tMap.has(r.date) ? tMap.get(r.date)! : NaN);
    P.volume.push(vMap.has(r.date) ? vMap.get(r.date)! : NaN);
  }
  const T = P.price.length;
  for (let t = 0; t < T; t++) {
    P.fwdRet.push(t + 1 < T ? Math.log(P.price[t + 1] / P.price[t]) : NaN);
    P.ret.push(t > 0 ? Math.log(P.price[t] / P.price[t - 1]) : NaN);
  }
  // forward-fill tone/volume over short gaps (<=3 days) — news days are near-continuous; weekends thin.
  ffillShort(P.tone, 3);
  ffillShort(P.volume, 3);
  return P;
}

function ffillShort(x: number[], maxGap: number): void {
  let last = NaN;
  let gap = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i])) {
      last = x[i];
      gap = 0;
    } else if (Number.isFinite(last) && gap < maxGap) {
      x[i] = last;
      gap += 1;
    }
  }
}

// ----------------------------------------------------------------- math utils
export function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
export function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
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
function gauss(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// strictly-causal trailing z-score
export function rollingZ(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - win + 1);
    const w: number[] = [];
    for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]);
    if (w.length < Math.min(30, win)) continue;
    const m = mean(w),
      s = std(w);
    out[i] = s > 1e-12 ? (x[i] - m) / s : 0;
  }
  return out;
}

// trailing log-price momentum over `mom` days (causal); regressor for de-trending tone.
function trailingMom(price: number[], mom: number): number[] {
  const out = new Array(price.length).fill(NaN);
  for (let i = 0; i < price.length; i++) {
    if (i - mom < 0) continue;
    out[i] = Math.log(price[i] / price[i - mom]);
  }
  return out;
}

/**
 * DE-TREND tone causally: at each t, fit OLS tone ~ a + b*trailingMom using ONLY data up to t
 * (expanding window, min 60 obs) and return the residual. Removes the part of tone explained by
 * recent price runs (the "coincident beta" trap). Returns raw tone if de-trend disabled.
 */
function detrendTone(tone: number[], price: number[], momWin: number, enable: boolean): number[] {
  if (!enable) return tone.slice();
  const mom = trailingMom(price, momWin);
  const out = new Array(tone.length).fill(NaN);
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    n = 0;
  for (let t = 0; t < tone.length; t++) {
    // predict residual at t using params fit on [0, t-1] (strictly causal: no t in the fit)
    if (n >= 60) {
      const denom = n * sxx - sx * sx;
      const b = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
      const a = (sy - b * sx) / n;
      if (Number.isFinite(tone[t]) && Number.isFinite(mom[t])) out[t] = tone[t] - (a + b * mom[t]);
    }
    // now fold t into the accumulators for future predictions
    if (Number.isFinite(tone[t]) && Number.isFinite(mom[t])) {
      sx += mom[t];
      sy += tone[t];
      sxx += mom[t] * mom[t];
      sxy += mom[t] * tone[t];
      n += 1;
    }
  }
  return out;
}

// ----------------------------------------------------------------- signal -> position
export interface Cfg {
  feature: "level" | "change"; // tone level z-score, or Δtone (impulse) z-score
  window: number; // z-score / change lookback
  threshold: number; // |z| band
  detrend: 0 | 1; // de-trend tone vs trailing momentum
  momWin: number; // momentum window for de-trend
  longOnly: 0 | 1; // long/flat (1) vs long/short (0)
  [k: string]: number | string;
}

// Build the causal "tone signal" series s[t] used to decide position at close of t.
// STRICT t-1: the signal at decision-time t uses tone observed THROUGH t-1 (lag 1).
function toneSignal(P: D6Panel, cfg: Cfg): number[] {
  const dt = detrendTone(P.tone, P.price, cfg.momWin, cfg.detrend === 1);
  let base: number[];
  if (cfg.feature === "change") {
    const ch = new Array(dt.length).fill(NaN);
    for (let i = 1; i < dt.length; i++)
      if (Number.isFinite(dt[i]) && Number.isFinite(dt[i - 1])) ch[i] = dt[i] - dt[i - 1];
    base = rollingZ(ch, cfg.window);
  } else {
    base = rollingZ(dt, cfg.window);
  }
  // LAG by 1: signal usable at close of t is base[t-1] (tone aggregated through prior day).
  const lagged = new Array(base.length).fill(NaN);
  for (let i = 1; i < base.length; i++) lagged[i] = base[i - 1];
  return lagged;
}

export function buildPosition(P: D6Panel, cfg: Cfg): number[] {
  const sig = toneSignal(P, cfg);
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    const s = sig[t];
    if (!Number.isFinite(s)) {
      pos[t] = 0;
      continue;
    }
    if (cfg.longOnly === 1) {
      pos[t] = s >= cfg.threshold ? 1 : 0; // positive tone -> long, else flat
    } else {
      pos[t] = s >= cfg.threshold ? 1 : s <= -cfg.threshold ? -1 : 0;
    }
  }
  return pos;
}

/**
 * AR(1)-matched tone PLACEBO. Replaces the de-trended tone series with a synthetic series that has
 * the SAME AR(1) coefficient and innovation variance (so identical autocorrelation/variance), but is
 * independent of the price path. Rebuild positions exactly as the real strategy. This is the RIGHT
 * null for a reactive-sentiment timer: it asks "could a series that merely *looks* like tone, with no
 * causal link to price, produce this Sharpe by chance?"
 */
function buildPlaceboPosition(P: D6Panel, cfg: Cfg, rng: () => number): number[] {
  const dt = detrendTone(P.tone, P.price, cfg.momWin, cfg.detrend === 1);
  // estimate AR(1) on observed (finite, mean-centred) de-trended tone
  const vals: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < dt.length; i++)
    if (Number.isFinite(dt[i])) {
      vals.push(dt[i]);
      idx.push(i);
    }
  const m = mean(vals);
  const c = vals.map((v) => v - m);
  let num = 0,
    den = 0;
  for (let i = 1; i < c.length; i++) {
    num += c[i] * c[i - 1];
    den += c[i - 1] * c[i - 1];
  }
  let phi = den > 0 ? num / den : 0;
  phi = Math.max(-0.98, Math.min(0.98, phi));
  // innovation variance so that stationary var matches sample var
  const sampVar = mean(c.map((v) => v * v));
  const innoSd = Math.sqrt(Math.max(1e-12, sampVar * (1 - phi * phi)));
  // simulate placebo with same AR(1)/var, mapped back onto the original finite positions
  const placebo = new Array(dt.length).fill(NaN);
  let prev = gauss(rng) * Math.sqrt(Math.max(1e-12, sampVar));
  for (let k = 0; k < idx.length; k++) {
    prev = phi * prev + innoSd * gauss(rng);
    placebo[idx[k]] = prev + m;
  }
  // build the signal from the placebo using the SAME transforms (change/level, z, lag)
  let base: number[];
  if (cfg.feature === "change") {
    const ch = new Array(placebo.length).fill(NaN);
    for (let i = 1; i < placebo.length; i++)
      if (Number.isFinite(placebo[i]) && Number.isFinite(placebo[i - 1])) ch[i] = placebo[i] - placebo[i - 1];
    base = rollingZ(ch, cfg.window);
  } else {
    base = rollingZ(placebo, cfg.window);
  }
  const lagged = new Array(base.length).fill(NaN);
  for (let i = 1; i < base.length; i++) lagged[i] = base[i - 1];
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    const s = lagged[t];
    if (!Number.isFinite(s)) {
      pos[t] = 0;
      continue;
    }
    if (cfg.longOnly === 1) pos[t] = s >= cfg.threshold ? 1 : 0;
    else pos[t] = s >= cfg.threshold ? 1 : s <= -cfg.threshold ? -1 : 0;
  }
  return pos;
}

// ----------------------------------------------------------------- backtest
export interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number;
  nDays: number;
  longShare: number;
}
export function runPositions(
  P: D6Panel,
  position: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0,
    expSum = 0,
    longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = P.fwdRet[t];
    const pos = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev);
    const cost = turn * costPerSide;
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - cost);
    turnoverSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    prev = pos;
  }
  const n = dailyNet.length;
  return {
    dailyNet,
    dailyGross,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    nDays: n,
    longShare: n ? longCount / n : 0,
  };
}

// ----------------------------------------------------------------- gauntlet
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
function normalCdfLocal(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
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
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}

export interface GauntletOutput {
  name: string;
  honestN: number;
  best: {
    label: string;
    cfg: Cfg;
    netSharpeAnn: number;
    grossSharpeAnn: number;
    meanDailyNet: number;
    turnover: number;
    exposure: number;
    longShare: number;
    nDays: number;
    monthlyAt100k: number;
  };
  canonical: { netSharpeAnn: number; surrogateP: number; holdoutSharpeAnn: number };
  gates: Record<string, { pass: boolean; detail: string }>;
  bindingGate: string;
  verdict: "SURVIVE" | "PROMISING" | "KILL";
  surrogateP: number;
  holdoutSharpeAnn: number;
}

export function runGauntlet(input: {
  name: string;
  P: D6Panel;
  configs: Cfg[];
  canonical: Cfg;
  startIdx: number;
  holdoutFrac?: number;
  nSurr?: number;
}): GauntletOutput {
  const { P, configs } = input;
  const HONEST_N = configs.length;
  const holdoutFrac = input.holdoutFrac ?? 0.2;
  const nSurr = input.nSurr ?? 400;
  const T = P.price.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - input.startIdx;
  const splitIdx = input.startIdx + Math.floor(span * (1 - holdoutFrac));

  const scored = configs.map((cfg) => {
    const pos = buildPosition(P, cfg);
    const res = runPositions(P, pos, input.startIdx, splitIdx);
    const label = Object.entries(cfg)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return { cfg, label, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // baselines: buy&hold (long-beta) + random-lottery matched exposure
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(P, bhPos, input.startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 300; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = input.startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 10,
    confidenceLevel: 0.95,
    seed: `${input.name}-bb`,
  });
  const bbPass = bb.lower > 0;

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

  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // RIGHT surrogate: AR(1)-matched tone placebo
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const pos = buildPlaceboPosition(P, best.cfg, rng);
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((s) => s >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  const holdRes = runPositions(P, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // canonical (N=1)
  const canonPos = buildPosition(P, input.canonical);
  const canonRes = runPositions(P, canonPos, input.startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    const pos = buildPlaceboPosition(P, input.canonical, rng);
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    canonSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHold = runPositions(P, canonPos, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: {
      pass: mean(bestNet) > 0,
      detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)}`,
    },
    baselines: {
      pass: baselinePass,
      detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H(long-beta)=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}`,
    },
    deflated_sharpe: {
      pass: dsrPass,
      detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}`,
    },
    block_bootstrap: {
      pass: bbPass,
      detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
    },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: {
      pass: haircutPass,
      detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})`,
    },
    surrogate: {
      pass: surrPass,
      detail: `AR-placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
    },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays} rows` },
  };

  const order = [
    "net_of_cost",
    "baselines",
    "deflated_sharpe",
    "block_bootstrap",
    "cpcv_pbo",
    "haircut",
    "surrogate",
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
    gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (allPass) verdict = "SURVIVE";
  else if (survivesCore) verdict = "PROMISING";
  else verdict = "KILL";

  const meanDailyNet = mean(bestNet);
  return {
    name: input.name,
    honestN: HONEST_N,
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
    gates,
    bindingGate: binding,
    verdict,
    surrogateP: surrP,
    holdoutSharpeAnn: holdSh,
  };
}

export function printVerdict(o: GauntletOutput): void {
  console.log(`\n================ ${o.name} ================`);
  console.log(`honestN=${o.honestN}  best=${o.best.label}`);
  console.log(
    `best netSharpeAnn=${o.best.netSharpeAnn.toFixed(3)} grossSharpeAnn=${o.best.grossSharpeAnn.toFixed(3)} turnover=${o.best.turnover.toFixed(3)} exposure=${o.best.exposure.toFixed(3)} longShare=${o.best.longShare.toFixed(2)} nDays=${o.best.nDays}`,
  );
  for (const [g, r] of Object.entries(o.gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  console.log(
    `canonical: netSharpeAnn=${o.canonical.netSharpeAnn.toFixed(3)} surrP=${o.canonical.surrogateP.toFixed(4)} holdoutSharpeAnn=${o.canonical.holdoutSharpeAnn.toFixed(3)}`,
  );
  const monthly = o.bindingGate === "none" ? `$${Math.round(o.best.monthlyAt100k)}` : "n/a";
  console.log(
    `VERDICT: ${o.verdict} | net Sharpe ${o.best.netSharpeAnn.toFixed(3)} | binding gate ${o.bindingGate} | honest N ${o.honestN} | surrogate p ${o.surrogateP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${o.holdoutSharpeAnn.toFixed(3)}`,
  );
}
