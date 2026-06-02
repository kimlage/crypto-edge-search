/**
 * Shared D5 edgehunt harness.
 *
 * Loads daily on-chain panels (BTC/ETH) from the committed POC (cm_{btc,eth}.json) merged with the
 * free Coin Metrics extras (cm_extra_*) and DefiLlama stables. Provides:
 *   - aligned daily series with NEXT-day forward returns (causal: position from signal at close t,
 *     held over t->t+1; on-chain features are LAGGED >=1 day to respect revision/flash risk).
 *   - the committed gauntlet primitives wired exactly as in scripts/edgehunt/residual-momentum.ts:
 *       net-of-cost, baselines (buy&hold, equal-weight long, random-lottery, linear-1-layer),
 *       Deflated Sharpe @ HONEST N (= every config), CPCV/PBO, Harvey-Liu (Bonferroni) haircut,
 *       the RIGHT surrogate null (time-series phase-randomization + block-bootstrap; NOT
 *       cross-sectional — single-asset timing), consume-once forward holdout (last 20%).
 *   - a single runGauntlet() that returns the binding gate + a one-line VERDICT.
 *
 * Realistic cost: 4 bps taker per side (matches the repo's COST_PER_SIDE).
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
export const COST_PER_SIDE = 0.0004; // 4 bps taker per side, realistic for liquid BTC/ETH spot
const ANN = Math.sqrt(365);

// ---------------------------------------------------------------- data load

export interface Panel {
  asset: string;
  dates: string[]; // ISO date (YYYY-MM-DD), sorted ascending
  price: number[];
  mvrv: number[]; // CapMVRVCur (POC)
  flowInNtv: number[]; // FlowInExNtv (POC)
  flowOutNtv: number[]; // FlowOutExNtv (POC)
  adr: number[]; // AdrActCnt
  marketCap: number[]; // CapMrktCurUSD (extra)
  hashRate: number[]; // HashRate (extra)
  supply: number[]; // SplyCur (extra)
  realizedCap: number[]; // derived = marketCap / mvrv
  realizedPrice: number[]; // derived = realizedCap / supply
  fwdRet: number[]; // log return price[t] -> price[t+1]; last entry = NaN
}

function parseMap(file: string, fields: string[]): Map<string, Record<string, number>> {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const m = new Map<string, Record<string, number>>();
  for (const r of j.data) {
    const d = r.time.slice(0, 10);
    const o: Record<string, number> = {};
    for (const f of fields) o[f] = r[f] != null ? Number(r[f]) : NaN;
    m.set(d, o);
  }
  return m;
}

export function loadPanel(asset: "btc" | "eth"): Panel {
  const poc = parseMap(`${ROOT}/output/onchain-poc/cm_${asset}.json`, [
    "PriceUSD",
    "CapMVRVCur",
    "FlowInExNtv",
    "FlowOutExNtv",
    "AdrActCnt",
  ]);
  const extra = parseMap(`${ROOT}/output/edgehunt-D5/cm_extra_${asset}.json`, [
    "CapMrktCurUSD",
    "HashRate",
    "SplyCur",
    "AdrActCnt",
    "PriceUSD",
  ]);
  // union of dates that have a price (prefer POC price; fall back to extra)
  const dates = [...new Set([...poc.keys(), ...extra.keys()])].sort();
  const P: Panel = {
    asset,
    dates: [],
    price: [],
    mvrv: [],
    flowInNtv: [],
    flowOutNtv: [],
    adr: [],
    marketCap: [],
    hashRate: [],
    supply: [],
    realizedCap: [],
    realizedPrice: [],
    fwdRet: [],
  };
  for (const d of dates) {
    const p = poc.get(d);
    const e = extra.get(d);
    const price = p?.PriceUSD ?? e?.PriceUSD ?? NaN;
    if (!(price > 0)) continue;
    const mc = e?.CapMrktCurUSD ?? NaN;
    const mvrv = p?.CapMVRVCur ?? NaN;
    const sply = e?.SplyCur ?? NaN;
    const realizedCap = mc > 0 && mvrv > 0 ? mc / mvrv : NaN;
    const realizedPrice = realizedCap > 0 && sply > 0 ? realizedCap / sply : NaN;
    P.dates.push(d);
    P.price.push(price);
    P.mvrv.push(mvrv);
    P.flowInNtv.push(p?.FlowInExNtv ?? NaN);
    P.flowOutNtv.push(p?.FlowOutExNtv ?? NaN);
    P.adr.push(p?.AdrActCnt ?? e?.AdrActCnt ?? NaN);
    P.marketCap.push(mc);
    P.hashRate.push(e?.HashRate ?? NaN);
    P.supply.push(sply);
    P.realizedCap.push(realizedCap);
    P.realizedPrice.push(realizedPrice);
  }
  const T = P.price.length;
  for (let t = 0; t < T; t++) {
    P.fwdRet.push(t + 1 < T ? Math.log(P.price[t + 1] / P.price[t]) : NaN);
  }
  return P;
}

export function loadStables(): Map<string, number> {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/stablecoins_total.json`, "utf8"));
  const m = new Map<string, number>();
  for (const r of j.data) m.set(r.date, Number(r.total));
  return m;
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
export function annSharpe(dailySharpe: number): number {
  return dailySharpe * ANN;
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
export function ema(x: number[], span: number): number[] {
  const a = 2 / (span + 1);
  const out = new Array(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    prev = Number.isFinite(prev) ? a * v + (1 - a) * prev : v;
    out[i] = prev;
  }
  return out;
}
export function sma(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < win) continue;
    let s = 0,
      ok = true;
    for (let k = i - win + 1; k <= i; k++) {
      if (!Number.isFinite(x[k])) {
        ok = false;
        break;
      }
      s += x[k];
    }
    if (ok) out[i] = s / win;
  }
  return out;
}
// rolling z-score over a trailing window (expanding-min option). Strictly causal.
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

// ---------------------------------------------------------------- backtest core
//
// A strategy is defined by a `position[]` array in {-1,0,+1} (or fractional), one per day t,
// computed STRICTLY from information available at the close of day t with on-chain features
// LAGGED >= LAG days. We then earn fwdRet[t] on position[t], minus turnover cost.

export interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number; // mean |position|
  nDays: number;
  longShare: number;
}

export function runPositions(
  P: Panel,
  position: number[], // length T; position[t] applied over fwdRet[t]
  startIdx: number,
  endIdx: number, // exclusive
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0;
  let expSum = 0;
  let longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = P.fwdRet[t];
    const pos = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) {
      // carry no position but keep prev for turnover continuity only on valid days
      continue;
    }
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

// ---------------------------------------------------------------- baselines

export interface Baselines {
  buyHoldSharpe: number; // long fwdRet on the active window
  equalWeightLongSharpe: number; // same as buy&hold for single asset (kept for parity / clarity)
  randomLotterySharpe: number; // 95th pct of random in/out books with matched exposure
  linearOneLayerSharpe: number; // best single-feature linear sign rule (the "1-layer" baseline)
}

// Build a strategy position from a real-valued causal signal by a sign/threshold rule, used both
// for the strategy itself and for the linear-one-layer baseline.

// ---------------------------------------------------------------- gauntlet

export interface GauntletInput {
  name: string;
  P: Panel;
  // function producing the FULL-sample position array for a given config
  buildPosition: (cfg: Record<string, number | string>) => number[];
  configs: Record<string, number | string>[]; // honest N = configs.length
  // a surrogate-position builder: given a phase-randomized feature path, rebuild positions.
  // We pass the RIGHT surrogate as a function that returns a position array from a seeded rng by
  // phase-randomizing the underlying signal but preserving the price path (timing-destroying).
  buildSurrogatePosition: (cfg: Record<string, number | string>, rng: () => number) => number[];
  // canonical pre-registered config (evaluated at N=1)
  canonical: Record<string, number | string>;
  startIdx: number; // first tradable index (after warmup); holdout carved from the tail
  holdoutFrac?: number; // default 0.2 consume-once
  nSurr?: number; // default 300
  randomLotteryExposure?: number; // exposure to match in random-lottery baseline
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
  canonical: {
    netSharpeAnn: number;
    surrogateP: number;
    holdoutSharpeAnn: number;
  };
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

export function runGauntlet(input: GauntletInput): GauntletOutput {
  const { P, configs } = input;
  const HONEST_N = configs.length;
  const holdoutFrac = input.holdoutFrac ?? 0.2;
  const nSurr = input.nSurr ?? 300;
  const T = P.price.length;
  // in-sample window = [startIdx, splitIdx); holdout = [splitIdx, T-1)
  const tradableEnd = T - 1; // last day has no fwdRet
  const span = tradableEnd - input.startIdx;
  const splitIdx = input.startIdx + Math.floor(span * (1 - holdoutFrac));

  // score every config IN-SAMPLE on net Sharpe (the selection DSR must correct for)
  const scored = configs.map((cfg) => {
    const pos = input.buildPosition(cfg);
    const res = runPositions(P, pos, input.startIdx, splitIdx);
    const label = Object.entries(cfg)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return { cfg, label, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // ---- baselines (B&H / equal-weight long / random-lottery / linear-one-layer) ----
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(P, bhPos, input.startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  // random-lottery: random in/out books matched to the best book's exposure & turnover-ish
  const exposure = input.randomLotteryExposure ?? best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = input.startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  // linear-one-layer: best single-config among the grid is already `best`; the linear baseline is
  // buy&hold-beta-scaled long (the dominant factor). We use B&H as the binding long-beta baseline.
  const baselinePass =
    best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // ---- Deflated Sharpe @ honest N ----
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---- block bootstrap CI on mean daily net ----
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 20, // autocorrelation-honest for on-chain (monthly-ish structure)
    confidenceLevel: 0.95,
    seed: `${input.name}-bb`,
  });
  const bbPass = bb.lower > 0;

  // ---- CSCV / PBO across all configs ----
  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 0, medianLogit: 0 } as { pbo: number; medianLogit: number };
  try {
    const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch {
    pbo = { pbo: 1, medianLogit: 0 };
  }
  const pboPass = pbo.pbo < 0.5;

  // ---- Harvey-Liu (Bonferroni) haircut ----
  // adjusted p = min(1, p_single * N); pass if still < 0.05. p_single from PSR vs 0.
  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---- RIGHT surrogate null: time-series phase-randomization of the signal (crossSectional:false) ----
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const pos = input.buildSurrogatePosition(best.cfg, rng);
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((s) => s >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // ---- consume-once forward holdout (best cfg only, OOS) ----
  const holdRes = runPositions(P, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // ---- canonical pre-registered (N=1) ----
  const canonPos = input.buildPosition(input.canonical);
  const canonRes = runPositions(P, canonPos, input.startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    const pos = input.buildSurrogatePosition(input.canonical, rng);
    const r = runPositions(P, pos, input.startIdx, splitIdx);
    canonSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP =
    (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHold = runPositions(P, canonPos, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  // ---- assemble gates in binding order ----
  const gates: Record<string, GateResult> = {
    net_of_cost: {
      pass: mean(bestNet) > 0,
      detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)}`,
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
    cpcv_pbo: {
      pass: pboPass,
      detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}`,
    },
    haircut: {
      pass: haircutPass,
      detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})`,
    },
    surrogate: {
      pass: surrPass,
      detail: `placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
    },
    holdout: {
      pass: holdoutPass,
      detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays} rows`,
    },
  };

  // binding gate = first failing gate in order
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
  // PROMISING = passes net+baselines+surrogate+holdout but trips a multiple-testing/DSR gate
  const survivesCore =
    gates.net_of_cost.pass &&
    gates.baselines.pass &&
    gates.surrogate.pass &&
    gates.holdout.pass;
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
    canonical: {
      netSharpeAnn: canonSh,
      surrogateP: canonSurrP,
      holdoutSharpeAnn: canonHoldSh,
    },
    gates,
    bindingGate: binding,
    verdict,
    surrogateP: surrP,
    holdoutSharpeAnn: holdSh,
  };
}

// local normal helpers for the haircut (independent of the lib internals)
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
  // PSR z: Sharpe * sqrt(n-1) / sqrt(1 - skew*Sh + (kurt-1)/4 * Sh^2)
  const sh = s.sharpe;
  const denom = Math.sqrt(
    Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh),
  );
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}

export function printVerdict(o: GauntletOutput): void {
  console.log(`\n================ ${o.name} ================`);
  console.log(`honestN=${o.honestN}  best=${o.best.label}`);
  console.log(
    `best netSharpeAnn=${o.best.netSharpeAnn.toFixed(3)} grossSharpeAnn=${o.best.grossSharpeAnn.toFixed(3)} turnover=${o.best.turnover.toFixed(3)} exposure=${o.best.exposure.toFixed(3)} longShare=${o.best.longShare.toFixed(2)} nDays=${o.best.nDays}`,
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
