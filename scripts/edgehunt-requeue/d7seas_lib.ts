/**
 * D7-SEAS — Sell-in-May / month-of-year seasonality.
 *
 * Belief (BACKLOG D7.2): flat May–Oct, long Nov–Apr ("Halloween indicator"); more generally any
 * partition of the 12 calendar months into LONG vs FLAT buckets times BTC daily returns.
 *
 * Mechanism: equity vacation-liquidity story, NO crypto-native mechanism; ~11 effective obs/month.
 *
 * Honest N = every month-rule tried (canonical Halloween + every contiguous window + data-driven
 * best-k month selections). The RIGHT null is calendar-reanchor / month-permutation: shuffle WHICH
 * months are labeled "good" while preserving the price path. We ALSO demean the secular drift so a
 * long-Nov–Apr rule cannot inherit the bull-market long-beta.
 *
 * Data: longest clean daily BTC price from the committed Coin Metrics POC (cm_btc.json),
 * 2015-01-01 .. 2026-05-30 (~11.4y). Cross-checked against nf1 BTC daily (2017+) for robustness.
 *
 * Cost: a month-of-year long/flat book trades at most ~ (#bucket boundaries) times/year — turnover
 * is tiny, so cost is nearly irrelevant; we still charge 4 bps taker/side at every bucket flip.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
export const COST_PER_SIDE = 0.0004; // 4 bps taker/side
const ANN = Math.sqrt(365);

// ---------------------------------------------------------------- data load

export interface DailySeries {
  dates: string[]; // ISO YYYY-MM-DD ascending
  price: number[];
  month: number[]; // 1..12 (UTC calendar month of date t)
  fwdRet: number[]; // log return price[t] -> price[t+1]; last = NaN
}

export function loadBtcDailyLong(): DailySeries {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/onchain-poc/cm_btc.json`, "utf8"));
  const rows = j.data
    .map((r: any) => ({ d: String(r.time).slice(0, 10), p: Number(r.PriceUSD) }))
    .filter((r: any) => r.p > 0);
  rows.sort((a: any, b: any) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  // dedupe (keep first)
  const seen = new Set<string>();
  const dates: string[] = [];
  const price: number[] = [];
  for (const r of rows) {
    if (seen.has(r.d)) continue;
    seen.add(r.d);
    dates.push(r.d);
    price.push(r.p);
  }
  return finalize(dates, price);
}

export function loadBtcDailyNf1(): DailySeries {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8"));
  const dates: string[] = [];
  const price: number[] = [];
  for (const r of j) {
    if (!(Number(r.close) > 0)) continue;
    dates.push(String(r.date).slice(0, 10));
    price.push(Number(r.close));
  }
  return finalize(dates, price);
}

function finalize(dates: string[], price: number[]): DailySeries {
  const T = price.length;
  const month = dates.map((d) => Number(d.slice(5, 7)));
  const fwdRet: number[] = [];
  for (let t = 0; t < T; t++) fwdRet.push(t + 1 < T ? Math.log(price[t + 1] / price[t]) : NaN);
  return { dates, price, month, fwdRet };
}

// ---------------------------------------------------------------- math utils

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

// Fisher-Yates with seeded rng
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- backtest core
//
// A month-of-year strategy is fully defined by a 12-element mask longMonth[1..12] in {0,1}.
// Position[t] = longMonth[month[t]]. We earn fwdRet[t]*pos[t] minus turnover cost at bucket flips.

export interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number; // mean daily |Δpos|
  exposure: number; // mean |pos|
  nDays: number;
  longShare: number;
}

export function runMask(
  S: DailySeries,
  longMonth: number[], // index 0 unused; 1..12 in {0,1} (or fractional)
  startIdx: number,
  endIdx: number, // exclusive
  costPerSide = COST_PER_SIDE,
  retOverride?: number[], // optional alt return series (e.g. demeaned) aligned to S
): BtResult {
  const ret = retOverride ?? S.fwdRet;
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0;
  let expSum = 0;
  let longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = ret[t];
    const pos = longMonth[S.month[t]];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev);
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - turn * costPerSide);
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

// Build the secular-drift-demeaned return series: subtract the global daily mean log-return over
// the in-sample window so that a long-month rule cannot inherit the bull-market long-beta. The
// month-of-year SIGNAL (if any) survives demeaning; the secular trend does not.
export function demeanReturns(S: DailySeries, startIdx: number, endIdx: number): number[] {
  const vals: number[] = [];
  for (let t = startIdx; t < endIdx; t++) if (Number.isFinite(S.fwdRet[t])) vals.push(S.fwdRet[t]);
  const mu = mean(vals);
  return S.fwdRet.map((r) => (Number.isFinite(r) ? r - mu : r));
}

// ---------------------------------------------------------------- gauntlet

export interface GateResult {
  pass: boolean;
  detail: string;
}
export interface SeasInput {
  name: string;
  S: DailySeries;
  configs: { label: string; longMonth: number[] }[]; // honest N = configs.length
  canonical: { label: string; longMonth: number[] };
  startIdx: number;
  holdoutFrac?: number; // default 0.2 consume-once
  nSurr?: number; // default 1000 (cheap; permutation null)
  demeanSecular?: boolean; // if true, score on drift-demeaned returns (kills long-beta leak)
  // AIRTIGHT snoop-matched calendar-reanchor null: given a permuted month-label series, RE-RUN the
  // full selection (best-k over k=1..11) and return the SELECTED config's net Sharpe. This mirrors
  // the data snooping exactly (we always pick the best months) while destroying calendar identity.
  // When provided, this REPLACES the family-max surrogate as the surrogate gate (the right null).
  reselectSurrogate?: (relabel: number[], scoreRet: number[] | undefined) => number;
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

export interface SeasOutput {
  name: string;
  honestN: number;
  bestLabel: string;
  bestLongMonth: number[];
  netSharpeAnn: number;
  grossSharpeAnn: number;
  meanDailyNet: number;
  turnover: number;
  exposure: number;
  longShare: number;
  nDays: number;
  monthlyAt100k: number;
  surrogateP: number;
  holdoutSharpeAnn: number;
  gates: Record<string, GateResult>;
  bindingGate: string;
  verdict: "SURVIVE" | "PROMISING" | "KILL";
  canonical: { netSharpeAnn: number; surrogateP: number; holdoutSharpeAnn: number };
}

export function runSeasGauntlet(input: SeasInput): SeasOutput {
  const { S, configs } = input;
  const HONEST_N = configs.length;
  const holdoutFrac = input.holdoutFrac ?? 0.2;
  const nSurr = input.nSurr ?? 1000;
  const T = S.price.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - input.startIdx;
  const splitIdx = input.startIdx + Math.floor(span * (1 - holdoutFrac));

  // optional secular-drift demean (computed in-sample only, applied throughout for fairness)
  const scoreRet = input.demeanSecular ? demeanReturns(S, input.startIdx, splitIdx) : undefined;

  // score every config IN-SAMPLE on net Sharpe
  const scored = configs.map((c) => {
    const res = runMask(S, c.longMonth, input.startIdx, splitIdx, COST_PER_SIDE, scoreRet);
    return { ...c, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // ---- baselines: buy&hold (full long) and random-lottery (random in/out, matched exposure) ----
  const bhMask = new Array(13).fill(1);
  const bh = runMask(S, bhMask, input.startIdx, splitIdx, COST_PER_SIDE, scoreRet);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 300; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    // random in/out at the MONTH level (matched #long-months), to match the strategy's structure
    const nLong = best.longMonth.slice(1).reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
    const idx = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], rng).slice(0, nLong);
    const mask = new Array(13).fill(0);
    for (const m of idx) mask[m] = 1;
    const r = runMask(S, mask, input.startIdx, splitIdx, COST_PER_SIDE, scoreRet);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // ---- Deflated Sharpe @ honest N ----
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---- block bootstrap CI on mean daily net (monthly blocks: month-of-year structure) ----
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 30, // ~monthly blocks (seasonality is a monthly phenomenon)
    confidenceLevel: 0.95,
    seed: `${input.name}-bb`,
  });
  const bbPass = bb.lower > 0;

  // ---- CSCV / PBO across all configs ----
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

  // ---- Harvey-Liu Bonferroni haircut ----
  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---- RIGHT surrogate null: CALENDAR-REANCHOR / MONTH-PERMUTATION ----
  // For the BEST config, hold its #long-months fixed but shuffle WHICH calendar months get the
  // long label. This destroys the identity of "May/November" while preserving the price path,
  // its autocorrelation, the secular drift, and the number of long days (~exposure). We re-select
  // the best over the SAME honest-N family on each permuted calendar to mirror the data snooping.
  const nLongBest = best.longMonth.slice(1).reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    // permute the month labels: build a random permutation map perm[1..12]
    const perm = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], rng);
    const permMap = new Array(13).fill(0);
    for (let k = 0; k < 12; k++) permMap[k + 1] = perm[k];
    if (input.reselectSurrogate) {
      // AIRTIGHT null: relabel each day's calendar month, re-run the FULL best-k selection.
      const relabel = S.month.map((m) => permMap[m]);
      surr.push(input.reselectSurrogate(relabel, scoreRet));
    } else {
      // fallback: re-run the WHOLE family under relabeling and take the max net Sharpe.
      let bestSurr = -Infinity;
      for (const c of configs) {
        const mask = new Array(13).fill(0);
        for (let m = 1; m <= 12; m++) mask[permMap[m]] = c.longMonth[m];
        const r = runMask(S, mask, input.startIdx, splitIdx, COST_PER_SIDE, scoreRet);
        const sh = annSharpe(sharpeDaily(r.dailyNet));
        if (sh > bestSurr) bestSurr = sh;
      }
      surr.push(bestSurr);
    }
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((s) => s >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // ---- consume-once forward holdout (best cfg only, OOS) — use RAW returns (real money) ----
  const holdRes = runMask(S, best.longMonth, splitIdx, tradableEnd, COST_PER_SIDE);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // ---- canonical pre-registered (N=1, evaluated under same scoreRet) ----
  const canonRes = runMask(S, input.canonical.longMonth, input.startIdx, splitIdx, COST_PER_SIDE, scoreRet);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  const canonNLong = input.canonical.longMonth.slice(1).reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    // canonical null: random set of canonNLong months long (pure calendar-reanchor, N=1)
    const idx = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], rng).slice(0, canonNLong);
    const mask = new Array(13).fill(0);
    for (const m of idx) mask[m] = 1;
    const r = runMask(S, mask, input.startIdx, splitIdx, COST_PER_SIDE, scoreRet);
    canonSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHold = runMask(S, input.canonical.longMonth, splitIdx, tradableEnd, COST_PER_SIDE);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  // raw (real-money) net Sharpe of the best config IS-window, for reporting monthly@100k honestly
  const bestRaw = runMask(S, best.longMonth, input.startIdx, splitIdx, COST_PER_SIDE);
  const meanDailyNetRaw = mean(bestRaw.dailyNet);

  const gates: Record<string, GateResult> = {
    net_of_cost: {
      pass: mean(bestNet) > 0,
      detail: `scoredMeanDaily=${mean(bestNet).toExponential(3)} rawMeanDaily=${meanDailyNetRaw.toExponential(3)} turnover=${best.res.turnover.toFixed(4)}`,
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
      detail: `calendar-reanchorP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
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
  for (const g of order) if (!gates[g].pass) { binding = g; break; }
  const allPass = binding === "none";
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (allPass) verdict = "SURVIVE";
  else if (survivesCore) verdict = "PROMISING";
  else verdict = "KILL";

  return {
    name: input.name,
    honestN: HONEST_N,
    bestLabel: best.label,
    bestLongMonth: best.longMonth,
    netSharpeAnn: best.netSh,
    grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)),
    meanDailyNet: meanDailyNetRaw,
    turnover: best.res.turnover,
    exposure: best.res.exposure,
    longShare: best.res.longShare,
    nDays: best.res.nDays,
    monthlyAt100k: meanDailyNetRaw * 30 * 100000,
    surrogateP: surrP,
    holdoutSharpeAnn: holdSh,
    gates,
    bindingGate: binding,
    verdict,
    canonical: { netSharpeAnn: canonSh, surrogateP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
  };
}

export function printSeas(o: SeasOutput): void {
  console.log(`\n================ ${o.name} ================`);
  console.log(`honestN=${o.honestN}  best=${o.bestLabel}`);
  console.log(`longMonths=${o.bestLongMonth.slice(1).map((v, i) => (v ? i + 1 : null)).filter((x) => x).join(",")}`);
  console.log(
    `best netSharpeAnn=${o.netSharpeAnn.toFixed(3)} grossSharpeAnn=${o.grossSharpeAnn.toFixed(3)} turnover=${o.turnover.toFixed(4)} exposure=${o.exposure.toFixed(3)} longShare=${o.longShare.toFixed(2)} nDays=${o.nDays}`,
  );
  for (const [g, r] of Object.entries(o.gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  console.log(
    `canonical: netSharpeAnn=${o.canonical.netSharpeAnn.toFixed(3)} surrP=${o.canonical.surrogateP.toFixed(4)} holdoutSharpeAnn=${o.canonical.holdoutSharpeAnn.toFixed(3)}`,
  );
  const monthly = o.bindingGate === "none" ? `$${Math.round(o.monthlyAt100k)}` : "n/a";
  console.log(
    `VERDICT: ${o.verdict} | net Sharpe ${o.netSharpeAnn.toFixed(3)} | binding gate ${o.bindingGate} | honest N ${o.honestN} | surrogate p ${o.surrogateP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${o.holdoutSharpeAnn.toFixed(3)}`,
  );
}
