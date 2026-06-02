/**
 * Vol-targeting / inverse-vol overlay (Moreira-Muir) on long BTC.
 *
 * Scale exposure inverse to forecast vol -> constant ex-ante vol.
 * Data: output/edgehunt/btc_daily_close.json (aggregated from 15m),
 *       output/funding/BTCUSDT_funding_8h.json (levered-carry cost),
 *       output/edgehunt/btc_dvol_daily.json (Deribit DVOL, forward-looking scaler).
 *
 * Decisive control: constant-leverage buy&hold at MATCHED average exposure,
 *   net of the extra turnover (Moreira-Muir is famously fragile OOS).
 * Right null: GARCH-simulated surrogate (same vol-clustering, zero return edge) ->
 *   the strategy must beat the mechanical Sharpe lift the surrogate produces.
 * Consume-once holdout on the last segment.
 *
 * Judge with committed harness src/lib/training/statistical-validation.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeProbabilisticSharpeRatio,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/training/statistical-validation";

const ROOT = ".";
const TAKER_BPS = 4; // 4 bps per side on |Δweight| notional traded
const ANNUAL = 365; // crypto trades daily
const RF = 0; // risk-free ~0 for relative comparison

// ---------- Load data ----------
type Daily = { date: string; close: number };
const daily: Daily[] = JSON.parse(
  readFileSync(`${ROOT}/output/edgehunt/btc_daily_close.json`, "utf8"),
);
type DvolRow = { t: number; date: string; close: number };
const dvolRaw: DvolRow[] = JSON.parse(
  readFileSync(`${ROOT}/output/edgehunt/btc_dvol_daily.json`, "utf8"),
);
const dvolByDate = new Map<string, number>();
for (const r of dvolRaw) dvolByDate.set(r.date, r.close); // close DVOL (annualized %, e.g. 45 = 45%)

type FundRow = { fundingTime: number; fundingRate: number };
const funding: FundRow[] = JSON.parse(
  readFileSync(`${ROOT}/output/funding/BTCUSDT_funding_8h.json`, "utf8"),
);
// Sum the (up to 3) 8h funding payments per UTC day -> daily funding rate.
const fundByDate = new Map<string, number>();
for (const f of funding) {
  const day = new Date(f.fundingTime).toISOString().slice(0, 10);
  fundByDate.set(day, (fundByDate.get(day) ?? 0) + f.fundingRate);
}

// ---------- Build aligned daily panel ----------
// returns r_t = close_t/close_{t-1} - 1 (the realized return earned holding day t)
type Row = {
  date: string;
  ret: number; // simple daily return of BTC spot
  dvol: number | null; // DVOL close that day (annualized %)
  funding: number; // daily funding rate (sum of 8h), perp long pays this when positive
};
const rows: Row[] = [];
for (let i = 1; i < daily.length; i++) {
  const date = daily[i].date;
  const ret = daily[i].close / daily[i - 1].close - 1;
  rows.push({
    date,
    ret,
    dvol: dvolByDate.get(date) ?? null,
    funding: fundByDate.get(date) ?? 0,
  });
}

// Restrict to funding-covered window (carry cost requires funding).
const FUND_START = "2023-06-01";
const panel = rows.filter((r) => r.date >= FUND_START);
console.error(
  `panel: ${panel.length} days ${panel[0].date}..${panel[panel.length - 1].date}`,
);
const dvolCoverage = panel.filter((r) => r.dvol !== null).length;
console.error(`DVOL coverage: ${dvolCoverage}/${panel.length}`);

// ---------- Vol forecast builders ----------
// Trailing realized vol (daily, annualized) from a rolling window, using ONLY past returns.
function trailingRealizedVolAnnualized(
  idx: number,
  window: number,
): number | null {
  if (idx < window) return null;
  const slice = panel.slice(idx - window, idx).map((r) => r.ret); // returns up to t-1
  const m = slice.reduce((a, b) => a + b, 0) / slice.length;
  const v =
    slice.reduce((a, b) => a + (b - m) * (b - m), 0) / (slice.length - 1);
  return Math.sqrt(v) * Math.sqrt(ANNUAL);
}
// EWMA realized vol (RiskMetrics lambda), annualized, using past returns.
function ewmaVolAnnualized(idx: number, lambda: number): number | null {
  if (idx < 30) return null;
  // seed with first 30-day variance, then iterate
  let varEw = 0;
  const seed = panel.slice(0, 30).map((r) => r.ret);
  const m0 = seed.reduce((a, b) => a + b, 0) / seed.length;
  varEw = seed.reduce((a, b) => a + (b - m0) ** 2, 0) / seed.length;
  for (let j = 30; j < idx; j++) {
    const r = panel[j - 1].ret; // info up to t-1
    varEw = lambda * varEw + (1 - lambda) * r * r;
  }
  return Math.sqrt(varEw) * Math.sqrt(ANNUAL);
}
// DVOL forecast: DVOL close at t-1 (forward-looking implied vol, already annualized %).
function dvolForecast(idx: number): number | null {
  if (idx < 1) return null;
  const d = panel[idx - 1].dvol; // use yesterday's DVOL close (known at decision)
  return d === null ? null : d / 100;
}

// ---------- Strategy simulator ----------
type SimResult = {
  netRet: number[]; // net daily returns of the levered overlay
  grossRet: number[];
  weights: number[];
  avgWeight: number;
  turnover: number; // sum |Δw|
  dates: string[];
};

function simulate(
  volFn: (idx: number) => number | null,
  targetVolAnnual: number,
  capLeverage: number,
  startIdx: number,
): SimResult {
  const netRet: number[] = [];
  const grossRet: number[] = [];
  const weights: number[] = [];
  const dates: string[] = [];
  let prevW = 0;
  let turnover = 0;
  for (let i = startIdx; i < panel.length; i++) {
    const fc = volFn(i);
    if (fc === null || !Number.isFinite(fc) || fc <= 1e-6) continue;
    let w = targetVolAnnual / fc;
    w = Math.max(0, Math.min(capLeverage, w)); // long-only, capped
    const r = panel[i].ret;
    const fund = panel[i].funding;
    // Gross: w * r
    const gross = w * r;
    // Cost: taker on |Δw| (rebalance churn) + funding on full levered notional w
    // (perp long pays funding*w when funding>0; receives when funding<0).
    const tradeCost = (TAKER_BPS / 1e4) * Math.abs(w - prevW);
    const fundingCost = w * fund; // long perp pays funding (cost when positive)
    const net = gross - tradeCost - fundingCost;
    turnover += Math.abs(w - prevW);
    netRet.push(net);
    grossRet.push(gross);
    weights.push(w);
    dates.push(panel[i].date);
    prevW = w;
  }
  const avgWeight =
    weights.reduce((a, b) => a + b, 0) / Math.max(1, weights.length);
  return { netRet, grossRet, weights, avgWeight, turnover, dates };
}

// Constant-leverage buy&hold at a FIXED weight (the matched-exposure control).
// Holding constant leverage as price moves requires daily rebalancing back to w,
// so it ALSO pays taker churn (we charge it honestly) + funding on w.
function simulateConstLeverage(
  fixedW: number,
  startIdx: number,
): SimResult {
  const netRet: number[] = [];
  const grossRet: number[] = [];
  const weights: number[] = [];
  const dates: string[] = [];
  let turnover = 0;
  let prevW = 0;
  for (let i = startIdx; i < panel.length; i++) {
    const r = panel[i].ret;
    const fund = panel[i].funding;
    const w = fixedW;
    const gross = w * r;
    // To keep constant leverage, after yesterday's return the effective weight
    // drifts; rebalancing back to w trades |w - w*(1+r_prev)/(1+w*r_prev)|.
    // First step trades from 0->w. Approximate daily rebal churn from drift.
    let dW: number;
    if (i === startIdx) dW = Math.abs(w - prevW);
    else {
      const rPrev = panel[i - 1].ret;
      const equityGrowth = 1 + w * rPrev;
      const assetGrowth = 1 + rPrev;
      const driftedW = (w * assetGrowth) / Math.max(1e-9, equityGrowth);
      dW = Math.abs(w - driftedW);
    }
    const tradeCost = (TAKER_BPS / 1e4) * dW;
    const fundingCost = w * fund;
    const net = gross - tradeCost - fundingCost;
    turnover += dW;
    netRet.push(net);
    grossRet.push(gross);
    weights.push(w);
    dates.push(panel[i].date);
    prevW = w;
  }
  return {
    netRet,
    grossRet,
    weights,
    avgWeight: fixedW,
    turnover,
    dates,
  };
}

// ---------- Metrics ----------
function annualizedSharpe(daily: number[]): number {
  const s = summarizeReturnSeries(daily);
  return s.sharpe * Math.sqrt(ANNUAL);
}
function annualizedVol(daily: number[]): number {
  const s = summarizeReturnSeries(daily);
  return s.stdDev * Math.sqrt(ANNUAL);
}
function annualizedReturn(daily: number[]): number {
  const s = summarizeReturnSeries(daily);
  // compoundReturn over the period -> annualize
  const years = daily.length / ANNUAL;
  return Math.pow(1 + s.compoundReturn, 1 / years) - 1;
}

// ---------- GARCH(1,1) surrogate null ----------
// Same vol-clustering, ZERO mean edge. The vol-target overlay mechanically lifts
// Sharpe under vol-clustering even with no edge (timing your own vol). The real
// strategy must beat the surrogate's mechanical lift distribution.
function fitGarch11(returns: number[]): {
  omega: number;
  alpha: number;
  beta: number;
  mu: number;
} {
  // Simple moment-ish init + crude gradient-free fit via grid refine on (alpha,beta).
  const mu = returns.reduce((a, b) => a + b, 0) / returns.length;
  const eps = returns.map((r) => r - mu);
  const uncondVar =
    eps.reduce((a, b) => a + b * b, 0) / eps.length;
  let best = { omega: uncondVar * 0.02, alpha: 0.08, beta: 0.9, ll: -Infinity };
  for (const alpha of [0.03, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2]) {
    for (const beta of [0.75, 0.8, 0.85, 0.88, 0.9, 0.93, 0.95]) {
      if (alpha + beta >= 0.999) continue;
      const omega = uncondVar * (1 - alpha - beta);
      // log-likelihood
      let h = uncondVar;
      let ll = 0;
      for (let i = 0; i < eps.length; i++) {
        ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(h) + (eps[i] * eps[i]) / h);
        h = omega + alpha * eps[i] * eps[i] + beta * h;
      }
      if (ll > best.ll) best = { omega, alpha, beta, ll };
    }
  }
  return { omega: best.omega, alpha: best.alpha, beta: best.beta, mu };
}

function simulateGarchPath(
  params: { omega: number; alpha: number; beta: number; mu: number },
  n: number,
  rng: () => number,
  zeroDrift: boolean,
): number[] {
  const { omega, alpha, beta, mu } = params;
  const out: number[] = [];
  let h = omega / Math.max(1e-9, 1 - alpha - beta);
  let prevEps = 0;
  for (let i = 0; i < n; i++) {
    h = omega + alpha * prevEps * prevEps + beta * h;
    const z = gaussian(rng);
    const eps = Math.sqrt(h) * z;
    prevEps = eps;
    // zeroDrift surrogate: mean return = 0 (no edge), keep only clustering.
    out.push((zeroDrift ? 0 : mu) + eps);
  }
  return out;
}

function gaussian(rng: () => number): number {
  // Box-Muller
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// On a surrogate return path, apply the SAME overlay (trailing-vol scaler) and
// measure the (overlay Sharpe - matched const-lev Sharpe) "mechanical lift".
function overlayLiftOnPath(
  pathRet: number[],
  targetVolAnnual: number,
  capLeverage: number,
  window: number,
): number {
  // build trailing vol on this path
  const wts: number[] = [];
  const olRet: number[] = [];
  let prevW = 0;
  for (let i = window; i < pathRet.length; i++) {
    const slice = pathRet.slice(i - window, i);
    const m = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sd = Math.sqrt(
      slice.reduce((a, b) => a + (b - m) ** 2, 0) / (slice.length - 1),
    );
    const fc = sd * Math.sqrt(ANNUAL);
    if (fc <= 1e-6) continue;
    let w = Math.max(0, Math.min(capLeverage, targetVolAnnual / fc));
    const gross = w * pathRet[i];
    const cost = (TAKER_BPS / 1e4) * Math.abs(w - prevW); // no funding on surrogate (no real carry)
    olRet.push(gross - cost);
    wts.push(w);
    prevW = w;
  }
  const avgW = wts.reduce((a, b) => a + b, 0) / Math.max(1, wts.length);
  // matched const-lev on same path at avgW (with its own rebal churn, no funding)
  const clRet: number[] = [];
  let pW = 0;
  for (let i = window; i < pathRet.length; i++) {
    const w = avgW;
    let dW: number;
    if (clRet.length === 0) dW = Math.abs(w - pW);
    else {
      const rPrev = pathRet[i - 1];
      const driftedW = (w * (1 + rPrev)) / Math.max(1e-9, 1 + w * rPrev);
      dW = Math.abs(w - driftedW);
    }
    clRet.push(w * pathRet[i] - (TAKER_BPS / 1e4) * dW);
    pW = w;
  }
  const olS = annualizedSharpe(olRet);
  const clS = annualizedSharpe(clRet);
  return olS - clS;
}

// ---------- Run experiment ----------
// Honest N: count EVERY config tried.
const configs: {
  name: string;
  volFn: (idx: number) => number | null;
  window?: number;
}[] = [
  { name: "realized_10d", volFn: (i) => trailingRealizedVolAnnualized(i, 10), window: 10 },
  { name: "realized_20d", volFn: (i) => trailingRealizedVolAnnualized(i, 20), window: 20 },
  { name: "realized_30d", volFn: (i) => trailingRealizedVolAnnualized(i, 30), window: 30 },
  { name: "ewma_094", volFn: (i) => ewmaVolAnnualized(i, 0.94), window: 20 },
  { name: "ewma_097", volFn: (i) => ewmaVolAnnualized(i, 0.97), window: 20 },
  { name: "dvol", volFn: (i) => dvolForecast(i), window: 20 },
];
const targetVols = [0.4, 0.5, 0.6, 0.8]; // annualized target vol levels
const caps = [1.5, 2.0, 3.0]; // leverage caps

const START_IDX = 30; // need warmup for vol estimators

// Split: in-sample (train) vs consume-once holdout (last ~25%).
const HOLDOUT_FRAC = 0.25;
const holdoutStartIdx =
  START_IDX +
  Math.floor((panel.length - START_IDX) * (1 - HOLDOUT_FRAC));
console.error(
  `holdout starts at idx ${holdoutStartIdx} (${panel[holdoutStartIdx]?.date}), IS up to there`,
);

type ConfigRun = {
  name: string;
  targetVol: number;
  cap: number;
  isSharpe: number;
  isVsCtrl: number; // overlay IS Sharpe - matched const-lev IS Sharpe
  avgW: number;
  sim: SimResult;
};

const allRuns: ConfigRun[] = [];
for (const c of configs) {
  for (const tv of targetVols) {
    for (const cap of caps) {
      // IS portion only for selection (consume-once holdout untouched)
      const simFull = simulate(c.volFn, tv, cap, START_IDX);
      // restrict to IS dates (< holdout date)
      const holdoutDate = panel[holdoutStartIdx].date;
      const isMask = simFull.dates.map((d) => d < holdoutDate);
      const isRet = simFull.netRet.filter((_, k) => isMask[k]);
      const isW = simFull.weights.filter((_, k) => isMask[k]);
      const avgW = isW.reduce((a, b) => a + b, 0) / Math.max(1, isW.length);
      const isSharpe = annualizedSharpe(isRet);
      // matched const-lev control on same IS window
      const ctrlFull = simulateConstLeverage(avgW, START_IDX);
      const ctrlIsRet = ctrlFull.netRet.filter(
        (_, k) => ctrlFull.dates[k] < holdoutDate,
      );
      const ctrlSharpe = annualizedSharpe(ctrlIsRet);
      allRuns.push({
        name: c.name,
        targetVol: tv,
        cap,
        isSharpe,
        isVsCtrl: isSharpe - ctrlSharpe,
        avgW,
        sim: simFull,
      });
    }
  }
}

const HONEST_N = allRuns.length;
console.error(`Honest N (configs tried): ${HONEST_N}`);

// Pick the best config by IS net Sharpe (this is the selection that the
// consume-once holdout will judge).
allRuns.sort((a, b) => b.isSharpe - a.isSharpe);
const best = allRuns[0];
// Also the best by "beats control" margin (the decisive criterion).
const bestByCtrl = [...allRuns].sort((a, b) => b.isVsCtrl - a.isVsCtrl)[0];

console.error("\n=== Top 8 by IS net Sharpe ===");
for (const r of allRuns.slice(0, 8)) {
  console.error(
    `${r.name} tv=${r.targetVol} cap=${r.cap}  isSharpe=${r.isSharpe.toFixed(3)}  vsCtrl=${r.isVsCtrl.toFixed(3)}  avgW=${r.avgW.toFixed(2)}`,
  );
}

// ---------- Evaluate the SELECTED config on the consume-once holdout ----------
function evalOnHoldout(c: ConfigRun) {
  const holdoutDate = panel[holdoutStartIdx].date;
  // overlay holdout returns
  const sim = c.sim;
  const hoMask = sim.dates.map((d) => d >= holdoutDate);
  const olRet = sim.netRet.filter((_, k) => hoMask[k]);
  const olW = sim.weights.filter((_, k) => hoMask[k]);
  const avgWho = olW.reduce((a, b) => a + b, 0) / Math.max(1, olW.length);
  // matched control on holdout at the SAME avg exposure realized in holdout
  const ctrlFull = simulateConstLeverage(avgWho, START_IDX);
  const ctrlRet = ctrlFull.netRet.filter(
    (_, k) => ctrlFull.dates[k] >= holdoutDate,
  );
  return { olRet, ctrlRet, avgWho, holdoutDate };
}

const ho = evalOnHoldout(best);
const olSharpeHO = annualizedSharpe(ho.olRet);
const ctrlSharpeHO = annualizedSharpe(ho.ctrlRet);

// ---------- GARCH surrogate null (mechanical-lift distribution) ----------
// Fit GARCH to the FULL panel returns, simulate zero-drift paths, measure overlay
// lift over matched const-lev. The strategy's REAL lift (overlay-ctrl) must exceed
// this mechanical-lift null distribution.
const panelRets = panel.map((r) => r.ret);
const garch = fitGarch11(panelRets);
console.error(
  `\nGARCH fit: omega=${garch.omega.toExponential(3)} alpha=${garch.alpha} beta=${garch.beta} persist=${(garch.alpha + garch.beta).toFixed(3)} mu=${garch.mu.toExponential(3)}`,
);

const N_SURR = 1000;
const bestWindow =
  configs.find((c) => c.name === best.name)?.window ?? 20;
const surrLifts: number[] = [];
const rng = mulberry32(20260601);
for (let s = 0; s < N_SURR; s++) {
  const path = simulateGarchPath(garch, panel.length, rng, true);
  surrLifts.push(
    overlayLiftOnPath(path, best.targetVol, best.cap, bestWindow),
  );
}
surrLifts.sort((a, b) => a - b);

// Real lift = overlay (net, full sample) Sharpe - matched const-lev Sharpe (net, full sample).
// Use full-sample net returns for the lift comparison (apples-to-apples with surrogate
// which uses the whole simulated path). NOTE: surrogate has no funding (no real carry),
// so to compare the *mechanical timing* lift fairly we also compute a no-funding overlay
// lift on REAL data here.
function realMechanicalLiftNoFunding(c: ConfigRun): number {
  const window = configs.find((x) => x.name === c.name)?.window ?? 20;
  // rebuild overlay on real returns WITHOUT funding (only taker churn) to match surrogate def
  const olRet: number[] = [];
  const wts: number[] = [];
  let prevW = 0;
  for (let i = START_IDX; i < panel.length; i++) {
    const fc = configs.find((x) => x.name === c.name)!.volFn(i);
    if (fc === null || !Number.isFinite(fc) || fc <= 1e-6) continue;
    const w = Math.max(0, Math.min(c.cap, c.targetVol / fc));
    olRet.push(w * panel[i].ret - (TAKER_BPS / 1e4) * Math.abs(w - prevW));
    wts.push(w);
    prevW = w;
  }
  const avgW = wts.reduce((a, b) => a + b, 0) / Math.max(1, wts.length);
  const clFull = simulateConstLeverage(avgW, START_IDX);
  // strip funding from control too: recompute gross - churn only
  const clRet: number[] = clFull.grossRet.map((g, k) => {
    // reconstruct churn cost: net = gross - churn - funding ; we want gross - churn
    const funding = clFull.weights[k] * panel[START_IDX + k]?.funding ?? 0;
    return clFull.netRet[k] + funding; // add back funding
  });
  return annualizedSharpe(olRet) - annualizedSharpe(clRet);
}

const realLift = realMechanicalLiftNoFunding(best);
const surrMean = surrLifts.reduce((a, b) => a + b, 0) / surrLifts.length;
const surrP95 = surrLifts[Math.floor(0.95 * surrLifts.length)];
// p-value: fraction of surrogate lifts >= real lift
const surrP =
  surrLifts.filter((x) => x >= realLift).length / surrLifts.length;

// ---------- Deflated Sharpe at honest N (on holdout overlay returns) ----------
const dsr = computeDeflatedSharpeRatio(ho.olRet, {
  benchmarkSharpe: 0,
  trialCount: HONEST_N,
});
const psrVsCtrl = computeProbabilisticSharpeRatio(
  ho.olRet,
  // benchmark = control's per-period (non-annualized) sharpe
  summarizeReturnSeries(ho.ctrlRet).sharpe,
);

// ---------- CPCV / PBO across configs (folds) ----------
// Build fold returns for each config (full net series, split into 6 contiguous folds).
function makeFolds(ret: number[], k: number): number[][] {
  const folds: number[][] = [];
  const size = Math.floor(ret.length / k);
  for (let f = 0; f < k; f++) {
    folds.push(ret.slice(f * size, f === k - 1 ? ret.length : (f + 1) * size));
  }
  return folds;
}
const K = 6;
const cscvStrategies: CscvStrategyFoldReturns[] = allRuns
  .slice(0, 12) // top configs as the competing strategies
  .map((r) => ({ id: `${r.name}_tv${r.targetVol}_c${r.cap}`, folds: makeFolds(r.sim.netRet, K) }));
let pbo: number | null = null;
try {
  const cscv = estimateCscvPbo(cscvStrategies, { statistic: "sharpe" });
  pbo = cscv.pbo;
} catch (e) {
  console.error("CSCV error", (e as Error).message);
}

// ---------- Block-bootstrap CI on holdout overlay Sharpe-ish (mean) ----------
const bb = blockBootstrapConfidenceInterval(ho.olRet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 10,
  seed: "vt-holdout",
});

// ---------- Economic numbers ----------
const fullNet = best.sim.netRet;
const monthlyMeanPct =
  (Math.pow(1 + summarizeReturnSeries(fullNet).compoundReturn, 30 / fullNet.length) - 1) *
  100;
function dollarMonthly(capital: number): number {
  return (monthlyMeanPct / 100) * capital;
}

// DVOL-specific run for reporting (forward-looking scaler vs trailing)
const dvolRun = allRuns
  .filter((r) => r.name === "dvol")
  .sort((a, b) => b.isSharpe - a.isSharpe)[0];
const realizedBest = allRuns
  .filter((r) => r.name.startsWith("realized") || r.name.startsWith("ewma"))
  .sort((a, b) => b.isSharpe - a.isSharpe)[0];

// ---------- Report ----------
const report = {
  window: { start: panel[0].date, end: panel[panel.length - 1].date, days: panel.length },
  honestN: HONEST_N,
  bestConfig: { name: best.name, targetVol: best.targetVol, cap: best.cap, avgW: best.avgW },
  inSample: {
    bestSharpe: best.isSharpe,
    bestVsControl: best.isVsCtrl,
    bestByControlMargin: {
      name: bestByCtrl.name,
      tv: bestByCtrl.targetVol,
      cap: bestByCtrl.cap,
      vsCtrl: bestByCtrl.isVsCtrl,
      sharpe: bestByCtrl.isSharpe,
    },
  },
  dvolVsTrailing: {
    dvol_bestISSharpe: dvolRun?.isSharpe,
    dvol_vsCtrl: dvolRun?.isVsCtrl,
    trailing_bestISSharpe: realizedBest?.isSharpe,
    trailing_vsCtrl: realizedBest?.isVsCtrl,
  },
  holdout: {
    startDate: ho.holdoutDate,
    days: ho.olRet.length,
    overlaySharpe: olSharpeHO,
    matchedControlSharpe: ctrlSharpeHO,
    overlayMinusControl: olSharpeHO - ctrlSharpeHO,
    avgWeight: ho.avgWho,
  },
  decisiveControl: {
    description: "constant-leverage buy&hold at matched avg exposure, net of turnover",
    is_overlay_minus_control_Sharpe: best.isVsCtrl,
    ho_overlay_minus_control_Sharpe: olSharpeHO - ctrlSharpeHO,
    beatsControl_IS: best.isVsCtrl > 0,
    beatsControl_HO: olSharpeHO - ctrlSharpeHO > 0,
  },
  garchSurrogateNull: {
    persistence: garch.alpha + garch.beta,
    nPaths: N_SURR,
    realMechanicalLift: realLift,
    surrogateMeanLift: surrMean,
    surrogateP95Lift: surrP95,
    pValue: surrP,
    beatsSurrogate: surrP < 0.05,
  },
  deflatedSharpe: {
    holdoutSharpePerPeriod: dsr.sharpe,
    holdoutSharpeAnnual: olSharpeHO,
    trialCount: dsr.trialCount,
    expectedMaxSharpe: dsr.expectedMaxSharpe,
    deflatedProbability: dsr.deflatedProbability,
    passes: dsr.deflatedProbability > 0.95,
  },
  psrVsControl: {
    probability: psrVsCtrl.probability,
    passes: psrVsCtrl.probability > 0.95,
  },
  cscvPbo: { pbo, passes: pbo !== null ? pbo < 0.5 : null },
  blockBootstrapHoldoutMean: {
    estimate: bb.estimate,
    lower: bb.lower,
    upper: bb.upper,
    excludesZero: bb.lower > 0 || bb.upper < 0,
  },
  economics: {
    fullSampleNetSharpeAnnual: annualizedSharpe(fullNet),
    fullSampleNetVolAnnual: annualizedVol(fullNet),
    fullSampleNetReturnAnnual: annualizedReturn(fullNet),
    monthlyMeanPct,
    monthlyAt10k: dollarMonthly(10000),
    monthlyAt100k: dollarMonthly(100000),
    totalTurnover: best.sim.turnover,
  },
};

writeFileSync(
  `${ROOT}/output/edgehunt/vol_target_results.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
