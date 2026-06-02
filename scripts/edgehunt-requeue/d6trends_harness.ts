/**
 * D6-TRENDS — Google Trends "bitcoin" attention. Committed gauntlet on the RIGHT null.
 *
 * Thesis (BACKLOG D6-S4): high-attention fade / low-attention accumulate, strictly-lagged.
 * Free weekly Google Trends interest (fetched + stitched in fetch_gtrends.ts).
 *
 * RIGHT null for THIS claim:
 *   (1) AR-matched placebo  — replace the trends z-score with an AR(1) surrogate matched to the
 *       trends series' lag-1 autocorrelation and variance. If the rule scores the same on the
 *       placebo, the "attention content" is zero (it's just trading an autocorrelated wiggle).
 *   (2) buy & hold (long-beta) baseline — the dominant factor a single-asset timing rule must beat.
 *   (3) random-lottery matched exposure.
 *
 * Causality discipline: weekly Trends value is only known AFTER the week closes and Google
 * publishes; we apply an additional publication lag. A given trading day t uses the z-score of the
 * most recent week that ENDED at least PUB_LAG_DAYS before day t. On-disk free data only.
 *
 * Gauntlet primitives imported directly from src/lib/training/statistical-validation.ts.
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
const PUB_LAG_DAYS = 3; // Google publishes the completed week with a few days' delay; conservative.

// ----------------------------------------------------------------- data
export interface Series {
  dates: string[]; // ISO daily, ascending
  price: number[];
  fwdRet: number[]; // log return price[t]->price[t+1]; last = NaN
  trendZ: number[]; // strictly-lagged rolling z-score of weekly attention, daily aligned
  trendRaw: number[]; // strictly-lagged raw weekly attention value, daily aligned
}

function loadBtcDaily(): { dates: string[]; price: number[] } {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as {
    date: string;
    close: number;
  }[];
  const dates = j.map((r) => r.date);
  const price = j.map((r) => Number(r.close));
  return { dates, price };
}

interface WPt {
  end: number; // unix seconds of week END (week start + 7d), the earliest it could be known
  value: number;
}
function loadWeekly(): WPt[] {
  const w = JSON.parse(
    fs.readFileSync(`${ROOT}/output/edgehunt-requeue/gtrends_bitcoin_weekly.json`, "utf8"),
  ) as { time: number; value: number }[];
  // `time` is the week START (Google reports the week's Sunday). Week is fully observed at start+7d.
  return w.map((p) => ({ end: p.time + 7 * 86400, value: p.value }));
}

export function rollingZ(x: (number | null)[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - win + 1);
    const wv: number[] = [];
    for (let k = lo; k <= i; k++) if (x[k] != null && Number.isFinite(x[k] as number)) wv.push(x[k] as number);
    if (wv.length < Math.min(20, win)) continue;
    const m = wv.reduce((s, v) => s + v, 0) / wv.length;
    const sd = Math.sqrt(Math.max(0, wv.reduce((s, v) => s + (v - m) ** 2, 0) / (wv.length - 1)));
    out[i] = sd > 1e-9 ? ((x[i] as number) - m) / sd : 0;
  }
  return out;
}

// Build the daily-aligned, STRICTLY-LAGGED weekly-z series.
// For each day t, find the latest weekly point whose week END + PUB_LAG <= day t (00:00 UTC).
// zWin = number of weeks in the rolling z window.
export function loadSeries(zWin: number): Series {
  const { dates, price } = loadBtcDaily();
  const weekly = loadWeekly().sort((a, b) => a.end - b.end);
  // weekly raw value array (in weekly index space) and its rolling z over `zWin` weeks
  const wVals = weekly.map((p) => p.value);
  const wZ = rollingZ(wVals as (number | null)[], zWin);

  const trendZ: number[] = [];
  const trendRaw: number[] = [];
  let wi = 0;
  for (let t = 0; t < dates.length; t++) {
    const dayUnix = Math.floor(new Date(dates[t] + "T00:00:00Z").getTime() / 1000);
    const cutoff = dayUnix - PUB_LAG_DAYS * 86400;
    // advance wi to the latest week whose end <= cutoff
    while (wi + 1 < weekly.length && weekly[wi + 1].end <= cutoff) wi++;
    if (weekly[wi].end <= cutoff) {
      trendZ.push(wZ[wi]);
      trendRaw.push(wVals[wi]);
    } else {
      trendZ.push(NaN);
      trendRaw.push(NaN);
    }
  }
  const fwdRet: number[] = [];
  for (let t = 0; t < price.length; t++) {
    fwdRet.push(t + 1 < price.length ? Math.log(price[t + 1] / price[t]) : NaN);
  }
  return { dates, price, fwdRet, trendZ, trendRaw };
}

// ----------------------------------------------------------------- math
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
  S: Series,
  position: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0;
  let expSum = 0;
  let longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = S.fwdRet[t];
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
export interface GauntletInput {
  name: string;
  S: Series;
  buildPosition: (cfg: Record<string, number | string>) => number[];
  // AR-matched placebo: rebuild positions from an AR(1) surrogate of the trend z-series.
  buildPlaceboPosition: (cfg: Record<string, number | string>, rng: () => number) => number[];
  configs: Record<string, number | string>[];
  canonical: Record<string, number | string>;
  startIdx: number;
  holdoutFrac?: number;
  nSurr?: number;
}
export interface GateResult {
  pass: boolean;
  detail: string;
}
export interface GauntletOutput {
  name: string;
  honestN: number;
  best: {
    label: string;
    cfg: Record<string, number | string>;
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
  gates: Record<string, GateResult>;
  bindingGate: string;
  verdict: "SURVIVE" | "PROMISING" | "KILL";
  surrogateP: number;
  holdoutSharpeAnn: number;
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

export function runGauntlet(input: GauntletInput): GauntletOutput {
  const { S, configs } = input;
  const HONEST_N = configs.length;
  const holdoutFrac = input.holdoutFrac ?? 0.2;
  const nSurr = input.nSurr ?? 400;
  const T = S.price.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - input.startIdx;
  const splitIdx = input.startIdx + Math.floor(span * (1 - holdoutFrac));

  const scored = configs.map((cfg) => {
    const pos = input.buildPosition(cfg);
    const res = runPositions(S, pos, input.startIdx, splitIdx);
    const label = Object.entries(cfg)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return { cfg, label, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // baselines
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(S, bhPos, input.startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = input.startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
    const r = runPositions(S, pos, input.startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // DSR @ honest N
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // block bootstrap CI
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 20,
    confidenceLevel: 0.95,
    seed: `${input.name}-bb`,
  });
  const bbPass = bb.lower > 0;

  // CSCV / PBO
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

  // Harvey-Liu (Bonferroni) haircut
  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // RIGHT surrogate null: AR-matched placebo
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const pos = input.buildPlaceboPosition(best.cfg, rng);
    const r = runPositions(S, pos, input.startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((s) => s >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // consume-once holdout
  const holdRes = runPositions(S, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // canonical N=1
  const canonPos = input.buildPosition(input.canonical);
  const canonRes = runPositions(S, canonPos, input.startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    const pos = input.buildPlaceboPosition(input.canonical, rng);
    const r = runPositions(S, pos, input.startIdx, splitIdx);
    canonSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHold = runPositions(S, canonPos, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  const gates: Record<string, GateResult> = {
    net_of_cost: {
      pass: mean(bestNet) > 0,
      detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(4)}`,
    },
    baselines: {
      pass: baselinePass,
      detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}`,
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
      detail: `AR-placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} placeboMean=${mean(surr).toFixed(3)} placebo95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
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
  for (const g of order) {
    if (!gates[g].pass) {
      binding = g;
      break;
    }
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
    `best netSharpeAnn=${o.best.netSharpeAnn.toFixed(3)} grossSharpeAnn=${o.best.grossSharpeAnn.toFixed(3)} turnover=${o.best.turnover.toFixed(4)} exposure=${o.best.exposure.toFixed(3)} longShare=${o.best.longShare.toFixed(2)} nDays=${o.best.nDays}`,
  );
  for (const [g, r] of Object.entries(o.gates)) {
    console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  }
  console.log(
    `canonical: netSharpeAnn=${o.canonical.netSharpeAnn.toFixed(3)} surrP=${o.canonical.surrogateP.toFixed(4)} holdoutSharpeAnn=${o.canonical.holdoutSharpeAnn.toFixed(3)}`,
  );
  const monthly = o.bindingGate === "none" ? `$${Math.round(o.best.monthlyAt100k)}` : "n/a";
  console.log(
    `VERDICT: ${o.verdict} | net Sharpe ${o.best.netSharpeAnn.toFixed(3)} | binding gate ${o.bindingGate} | honest N ${o.honestN} | surrogate p ${o.surrogateP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${o.holdoutSharpeAnn.toFixed(3)}`,
  );
}
