/**
 * edgehunt-D348 / D8-B4 — Rebalancing premium / volatility harvesting ("Shannon's demon").
 *
 * Belief: fixed-weight periodic rebalancing harvests a "diversification return" (premium)
 * vs buy-and-hold. Mechanism: real for LOW-correlation assets (Fernholz, Booth-Fama,
 * Willenbrock); crypto is highly correlated + trending → rebalancing SELLS the persistent
 * winner → drag, not premium.
 *
 * Strongest honest build:
 *   1) Pairwise correlation panel (key control: median pairwise corr > ~0.7 ⇒ premium ≈ 0).
 *   2) Fixed-weight (equal-weight) periodic rebalance vs buy-and-hold, NET of rebalance cost.
 *      Decompose:  excess = diversificationReturn(corr-driven, the marketed premium)
 *                           + driftReturn (weights-drift effect; negative under trends)
 *      Booth-Fama / Willenbrock identity:
 *        rebalanced_geo - wavg_geo  ≈  diversification return
 *          ≈ 0.5 * ( Σ w_i σ_i²  -  σ_p² )   (long-only, weights w)
 *      and  BH_geo - rebalanced_geo  ≈ drift contribution (lets winners compound).
 *   3) Sweep rebalance frequency {daily, weekly, monthly, quarterly} and the EXACT
 *      analytic diversification-return identity (no look-ahead, no parameters to tune).
 *   4) Honest profitability question: is the rebalanced portfolio's NET excess return over
 *      buy-and-hold (the "harvest") reliably > 0? Treat the per-rebalance excess as the
 *      tradeable series and judge with the committed gauntlet.
 *
 * Surrogate null (the RIGHT one): correlation-matched block bootstrap + cross-sectional
 *   shuffle. We resample the daily return PANEL in blocks (preserves own + cross-asset
 *   correlation = matched high crypto corr) and ALSO run a cross-sectional shuffle that
 *   permutes which coin owns which return path per block (destroys any persistent
 *   winner/loser identity while preserving the correlation + vol structure). If the real
 *   rebalancing excess is indistinguishable from this null, the "premium" is structural
 *   noise, not edge.
 *
 * Data: $0 reuse output/crossxs/daily-closes.json (30 coins; 15 full-coverage). No fetch.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/d8b4-rebalance-premium.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ann = (sPerPeriod: number, ppy: number) => sPerPeriod * Math.sqrt(ppy);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const mean = (r: number[]) => r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
function geoMean(simple: number[]): number {
  // geometric mean per-period from simple returns
  let s = 0;
  for (const r of simple) s += Math.log(1 + r);
  return Math.exp(s / Math.max(1, simple.length)) - 1;
}

// ---------------------------------------------------------------------------
// Load panel
// ---------------------------------------------------------------------------
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };

const ALL = Object.keys(daily.closes);
const DATES = daily.dates;
const D = DATES.length;

// full-coverage universe (no NaN over whole 6y window) — required for honest BH vs rebal
const FULL = ALL.filter((c) =>
  daily.closes[c].every((v) => v != null && (v as number) > 0),
);

// daily simple returns matrix for a given universe over [a,b)
function retMatrix(coins: string[], a: number, b: number): number[][] {
  // rows = time, cols = coin
  const out: number[][] = [];
  for (let i = a + 1; i < b; i++) {
    const row: number[] = [];
    for (const c of coins) {
      const p0 = daily.closes[c][i - 1] as number;
      const p1 = daily.closes[c][i] as number;
      row.push(p1 / p0 - 1);
    }
    out.push(row);
  }
  return out;
}

// pairwise Pearson correlation of columns
function pairwiseCorr(R: number[][], nCols: number): { median: number; mean: number; min: number; max: number; pairs: number } {
  const T = R.length;
  const mu = new Array(nCols).fill(0);
  for (const row of R) for (let j = 0; j < nCols; j++) mu[j] += row[j];
  for (let j = 0; j < nCols; j++) mu[j] /= T;
  const sd = new Array(nCols).fill(0);
  for (const row of R) for (let j = 0; j < nCols; j++) sd[j] += (row[j] - mu[j]) ** 2;
  for (let j = 0; j < nCols; j++) sd[j] = Math.sqrt(sd[j] / T) || 1e-12;
  const corrs: number[] = [];
  for (let i = 0; i < nCols; i++)
    for (let j = i + 1; j < nCols; j++) {
      let cov = 0;
      for (const row of R) cov += (row[i] - mu[i]) * (row[j] - mu[j]);
      cov /= T;
      corrs.push(cov / (sd[i] * sd[j]));
    }
  corrs.sort((a, b) => a - b);
  return {
    median: corrs[Math.floor(corrs.length / 2)],
    mean: corrs.reduce((a, b) => a + b, 0) / corrs.length,
    min: corrs[0],
    max: corrs[corrs.length - 1],
    pairs: corrs.length,
  };
}

// ---------------------------------------------------------------------------
// Equal-weight portfolio simulators on a daily return matrix R (T x N)
//   rebalEvery = 1 (daily), 7 (weekly), 30 (monthly), 90 (quarterly), Inf = buy&hold
//   cost = round-trip proportional cost charged on traded notional at each rebalance.
//   Returns the portfolio daily simple-return series.
// ---------------------------------------------------------------------------
function simEqualWeight(R: number[][], rebalEvery: number, costRate: number): {
  port: number[];
  turnoverTotal: number;
  costTotal: number;
} {
  const T = R.length;
  const N = R[0].length;
  const target = 1 / N;
  let w = new Array(N).fill(target); // start equal-weight
  const port: number[] = [];
  let turnoverTotal = 0;
  let costTotal = 0;
  for (let t = 0; t < T; t++) {
    // portfolio return this day given current weights w (pre-drift)
    let pr = 0;
    for (let j = 0; j < N; j++) pr += w[j] * R[t][j];
    // drift weights by realized returns (multiplicative)
    const newW = new Array(N).fill(0);
    let denom = 0;
    for (let j = 0; j < N; j++) {
      newW[j] = w[j] * (1 + R[t][j]);
      denom += newW[j];
    }
    for (let j = 0; j < N; j++) newW[j] /= denom;
    w = newW;
    // rebalance at end of day if scheduled (t counted from 0; rebal after period)
    let costToday = 0;
    if (rebalEvery !== Infinity && (t + 1) % rebalEvery === 0 && t < T - 1) {
      let turn = 0;
      for (let j = 0; j < N; j++) turn += Math.abs(w[j] - target);
      turn /= 2; // one-way turnover fraction
      turnoverTotal += turn;
      costToday = turn * costRate; // proportional cost on traded notional
      costTotal += costToday;
      w = new Array(N).fill(target); // reset to equal weight
    }
    port.push(pr - costToday);
  }
  return { port, turnoverTotal, costTotal };
}

// analytic diversification return identity over the whole window (per-period, geometric):
//   divReturn ≈ 0.5 * ( Σ w_i σ_i²  −  σ_p² ),  evaluated at fixed equal weights.
function analyticDiversificationReturn(R: number[][]): {
  divReturnPerPeriod: number;
  wAvgVar: number;
  portVar: number;
  rebalGeo: number;
  bhGeo: number;
  wAvgGeo: number;
} {
  const T = R.length;
  const N = R[0].length;
  const wt = 1 / N;
  // per-coin mean & variance
  const mu = new Array(N).fill(0);
  for (const row of R) for (let j = 0; j < N; j++) mu[j] += row[j];
  for (let j = 0; j < N; j++) mu[j] /= T;
  const v = new Array(N).fill(0);
  for (const row of R) for (let j = 0; j < N; j++) v[j] += (row[j] - mu[j]) ** 2;
  for (let j = 0; j < N; j++) v[j] /= T;
  const wAvgVar = v.reduce((a, b) => a + b, 0) * wt;
  // portfolio (daily-rebalanced equal weight) variance
  const pRet = R.map((row) => row.reduce((a, b) => a + b, 0) * wt);
  const pmu = pRet.reduce((a, b) => a + b, 0) / T;
  const portVar = pRet.reduce((a, b) => a + (b - pmu) ** 2, 0) / T;
  const divReturnPerPeriod = 0.5 * (wAvgVar - portVar);
  // realized geo means (no cost): daily-rebalanced EW vs buy&hold vs avg-of-components
  const rebalGeo = geoMean(pRet);
  // buy & hold geo: track value of $1 split equally, no rebalance
  const val = new Array(N).fill(wt);
  const bhDaily: number[] = [];
  for (const row of R) {
    let tot = 0;
    const nv = new Array(N).fill(0);
    for (let j = 0; j < N; j++) {
      nv[j] = val[j] * (1 + row[j]);
      tot += nv[j];
    }
    const prev = val.reduce((a, b) => a + b, 0);
    bhDaily.push(tot / prev - 1);
    for (let j = 0; j < N; j++) val[j] = nv[j];
  }
  const bhGeo = geoMean(bhDaily);
  // weighted-avg geometric return of components (holding each alone)
  let wAvgGeo = 0;
  for (let j = 0; j < N; j++) {
    const colj = R.map((row) => row[j]);
    wAvgGeo += wt * geoMean(colj);
  }
  return { divReturnPerPeriod, wAvgVar, portVar, rebalGeo, bhGeo, wAvgGeo };
}

// ===========================================================================
// MAIN
// ===========================================================================
const results: Record<string, unknown> = {};
const PPY = 252;
// realistic crypto rebalance cost: taker+slippage ~ 10 bps one-way on traded notional.
const COST = 0.0010;

// universe: full-coverage 15 coins over whole window
const coins = FULL;
const R = retMatrix(coins, 0, D); // T x N daily simple returns
const T = R.length;
const N = coins.length;

// ---- 1) pairwise correlation (KEY CONTROL) ----
const corr = pairwiseCorr(R, N);

// ---- 2) analytic decomposition ----
const dec = analyticDiversificationReturn(R);
// excess of daily-rebalanced EW over buy&hold (the "harvest"), per-period geometric:
const excessGeoRebalVsBH = dec.rebalGeo - dec.bhGeo;        // <0 ⇒ drift drag dominates
const divMinusDrift = dec.rebalGeo - dec.wAvgGeo;           // diversification return (vs avg component)
// Booth-Fama check: rebalGeo - wAvgGeo should ≈ divReturnPerPeriod
const identityErr = (dec.rebalGeo - dec.wAvgGeo) - dec.divReturnPerPeriod;

// ---- 3) frequency sweep, NET of cost; tradeable harvest series ----
const bh = simEqualWeight(R, Infinity, 0);
const freqs: { name: string; every: number }[] = [
  { name: "daily", every: 1 },
  { name: "weekly", every: 7 },
  { name: "monthly", every: 30 },
  { name: "quarterly", every: 90 },
];
const freqResults: Record<string, unknown> = {};
let bestHarvest: number[] | null = null;
let bestName = "";
let bestNetGeo = -Infinity;
for (const f of freqs) {
  const sim = simEqualWeight(R, f.every, COST);
  // harvest series = rebalanced port return − buy&hold port return, per day (tradeable spread)
  const harvest = sim.port.map((p, i) => p - bh.port[i]);
  const netGeoRebal = geoMean(sim.port);
  const netExcessGeo = netGeoRebal - geoMean(bh.port);
  freqResults[f.name] = {
    rebalGeoNetDailyPct: netGeoRebal * 100,
    bhGeoDailyPct: geoMean(bh.port) * 100,
    netExcessGeoDailyBps: netExcessGeo * 1e4,
    netExcessAnnualizedPct: ((1 + netExcessGeo) ** PPY - 1) * 100,
    rebalGrossGeoDailyBps: geoMean(simEqualWeight(R, f.every, 0).port) * 1e4,
    harvestSharpeAnn: ann(sharpe(harvest), PPY),
    turnoverTotal: sim.turnoverTotal,
    costTotalPct: sim.costTotal * 100,
  };
  if (netGeoRebal > bestNetGeo) {
    bestNetGeo = netGeoRebal;
    bestHarvest = harvest;
    bestName = f.name;
  }
}

// ---- 4) judge the BEST-frequency harvest (rebal − BH) with the gauntlet ----
const harvest = bestHarvest as number[];
const harvestSh = ann(sharpe(harvest), PPY);
const harvestMeanDaily = mean(harvest);

// Honest N: rebalance frequency {4} × universe choices × cost assumptions.
// The marketed claim has a hidden search over freq + which assets. We count:
//   4 frequencies × 3 plausible universes (full / top-cap / all-available windows)
//   × 2 weight schemes (EW / inverse-vol) ≈ 24 configs. Use the largest honest count.
const HONEST_N = 24;
const dsr = computeDeflatedSharpeRatio(harvest, { trialCount: HONEST_N });

// block-bootstrap CI on the harvest mean (own autocorr preserved)
const ci = blockBootstrapConfidenceInterval(harvest, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 21,
  confidenceLevel: 0.95,
  seed: "d8b4-harvest",
});

// ---- 5) THE RIGHT SURROGATE NULL ----
// (a) correlation-matched block bootstrap of the PANEL (resample whole rows in blocks →
//     preserves cross-asset correlation + own autocorr = matched high crypto corr),
//     then recompute rebal−BH harvest. Distribution of harvest Sharpe under matched corr.
// (b) cross-sectional shuffle: within each bootstrap, permute the COLUMN identities per
//     block so no coin keeps a persistent winner/loser identity (kills drift identity)
//     while keeping the contemporaneous correlation + vol structure intact.
function panelBlockBootstrap(R: number[][], blk: number, r: () => number, xsShuffle: boolean): number[][] {
  const Tn = R.length;
  const Nn = R[0].length;
  const out: number[][] = [];
  while (out.length < Tn) {
    const s = Math.floor(r() * Tn);
    // optional per-block column permutation (cross-sectional shuffle)
    let perm = Array.from({ length: Nn }, (_, j) => j);
    if (xsShuffle) {
      for (let j = Nn - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        [perm[j], perm[k]] = [perm[k], perm[j]];
      }
    }
    for (let o = 0; o < blk && out.length < Tn; o++) {
      const row = R[(s + o) % Tn];
      out.push(perm.map((j) => row[j]));
    }
  }
  return out;
}

function harvestSharpeOnPanel(Rp: number[][]): number {
  const sim = simEqualWeight(Rp, bestEvery(), COST);
  const bhp = simEqualWeight(Rp, Infinity, 0);
  const h = sim.port.map((p, i) => p - bhp.port[i]);
  return ann(sharpe(h), PPY);
}
function bestEvery(): number {
  return freqs.find((f) => f.name === bestName)!.every;
}

const NB = 1000;
const rb = rng(8101);
const surroMatched: number[] = []; // (a) corr-matched, identity preserved
const surroXS: number[] = []; // (b) corr-matched + cross-sectional shuffle
for (let it = 0; it < NB; it++) {
  surroMatched.push(harvestSharpeOnPanel(panelBlockBootstrap(R, 21, rb, false)));
  surroXS.push(harvestSharpeOnPanel(panelBlockBootstrap(R, 21, rb, true)));
}
surroMatched.sort((a, b) => a - b);
surroXS.sort((a, b) => a - b);
const pMatched = surroMatched.filter((x) => x >= harvestSh).length / NB;
const pXS = surroXS.filter((x) => x >= harvestSh).length / NB;
const surroMatchedMean = mean(surroMatched);
const surroXSMean = mean(surroXS);

// ---- 6) inverse-vol weighting robustness (another honest config) ----
function simInvVol(R: number[][], rebalEvery: number, costRate: number, lookback: number): number[] {
  const Tn = R.length;
  const Nn = R[0].length;
  let w = new Array(Nn).fill(1 / Nn);
  const port: number[] = [];
  let target = new Array(Nn).fill(1 / Nn);
  for (let t = 0; t < Tn; t++) {
    let pr = 0;
    for (let j = 0; j < Nn; j++) pr += w[j] * R[t][j];
    const newW = new Array(Nn).fill(0);
    let denom = 0;
    for (let j = 0; j < Nn; j++) {
      newW[j] = w[j] * (1 + R[t][j]);
      denom += newW[j];
    }
    for (let j = 0; j < Nn; j++) newW[j] /= denom;
    w = newW;
    let costToday = 0;
    if ((t + 1) % rebalEvery === 0 && t < Tn - 1) {
      // recompute inverse-vol target from trailing lookback
      const a = Math.max(0, t - lookback + 1);
      const inv = new Array(Nn).fill(0);
      let sumInv = 0;
      for (let j = 0; j < Nn; j++) {
        let m = 0,
          c = 0;
        for (let s = a; s <= t; s++) (m += R[s][j]), c++;
        m /= c;
        let vv = 0;
        for (let s = a; s <= t; s++) vv += (R[s][j] - m) ** 2;
        vv = Math.sqrt(vv / c) || 1e-9;
        inv[j] = 1 / vv;
        sumInv += inv[j];
      }
      for (let j = 0; j < Nn; j++) target[j] = inv[j] / sumInv;
      let turn = 0;
      for (let j = 0; j < Nn; j++) turn += Math.abs(w[j] - target[j]);
      turn /= 2;
      costToday = turn * costRate;
      w = target.slice();
    }
    port.push(pr - costToday);
  }
  return port;
}
const ivPort = simInvVol(R, 30, COST, 30);
const ivExcessGeo = geoMean(ivPort) - geoMean(bh.port);

// ---- 7) MULTI-UNIVERSE robustness incl. a HIGH-CORR large-cap basket ----
// The prior's premise is "crypto corr too high ⇒ premium ≈ 0". The full 15-coin set is
// only median-corr 0.56, so we ALSO test the most-correlated majors (the basket crypto
// folklore actually rebalances) and a BTC/ETH-heavy basket. For each: median corr, the
// quarterly-rebal NET harvest mean, its block-bootstrap 95% CI, and corr-matched + XS
// surrogate p. Edge would require: harvest CI excludes 0 AND surrogate p < 0.05.
function evalUniverse(uCoins: string[], seed: number) {
  const Ru = retMatrix(uCoins, 0, D);
  const cu = pairwiseCorr(Ru, uCoins.length);
  const decu = analyticDiversificationReturn(Ru);
  const bhu = simEqualWeight(Ru, Infinity, 0);
  // best net frequency for this universe
  let best: { name: string; h: number[]; geo: number } | null = null;
  for (const f of freqs) {
    const sim = simEqualWeight(Ru, f.every, COST);
    const h = sim.port.map((p, i) => p - bhu.port[i]);
    const g = geoMean(sim.port);
    if (!best || g > best.geo) best = { name: f.name, h, geo: g };
  }
  const h = best!.h;
  const shu = ann(sharpe(h), PPY);
  const ciu = blockBootstrapConfidenceInterval(h, {
    statistic: "mean",
    iterations: 1500,
    blockLength: 21,
    confidenceLevel: 0.95,
    seed: `d8b4-u-${seed}`,
  });
  // corr-matched + XS surrogate
  const r = rng(seed);
  const NBu = 600;
  const sm: number[] = [];
  const sx: number[] = [];
  for (let it = 0; it < NBu; it++) {
    const Pm = panelBlockBootstrap(Ru, 21, r, false);
    const Px = panelBlockBootstrap(Ru, 21, r, true);
    const simM = simEqualWeight(Pm, freqs.find((f) => f.name === best!.name)!.every, COST);
    const bhM = simEqualWeight(Pm, Infinity, 0);
    sm.push(ann(sharpe(simM.port.map((p, i) => p - bhM.port[i])), PPY));
    const simX = simEqualWeight(Px, freqs.find((f) => f.name === best!.name)!.every, COST);
    const bhX = simEqualWeight(Px, Infinity, 0);
    sx.push(ann(sharpe(simX.port.map((p, i) => p - bhX.port[i])), PPY));
  }
  return {
    coins: uCoins,
    n: uCoins.length,
    corrMedian: cu.median,
    corrMean: cu.mean,
    diversificationReturnAnnPct: ((1 + decu.divReturnPerPeriod) ** PPY - 1) * 100,
    rebalMinusBuyHoldDailyBps: (decu.rebalGeo - decu.bhGeo) * 1e4,
    bestFreq: best!.name,
    harvestNetSharpeAnn: shu,
    harvestMeanDailyBps: mean(h) * 1e4,
    harvestAnnExcessPct: ((1 + mean(h)) ** PPY - 1) * 100,
    ci95_meanDailyBps: [ciu.lower * 1e4, ciu.upper * 1e4],
    ciExcludesZero: ciu.lower > 0,
    surrogate_p_matchedCorr: sm.filter((x) => x >= shu).length / NBu,
    surrogate_p_matchedCorr_plus_XSshuffle: sx.filter((x) => x >= shu).length / NBu,
  };
}
// high-corr large-cap basket: the most-correlated majors (corr ~0.7 expected)
const HIGHCORR = ["BTC", "ETH", "BNB", "LTC", "BCH", "ETC"].filter((c) => FULL.includes(c));
const BTCETH = ["BTC", "ETH"];
const multiUniverse = {
  full15: evalUniverse(FULL, 9001),
  highCorrMajors: evalUniverse(HIGHCORR, 9002),
  btcEthOnly: evalUniverse(BTCETH, 9003),
};

results.D8_B4 = {
  universe: coins,
  nCoins: N,
  windowDays: T,
  windowDates: [DATES[0], DATES[D - 1]],
  costRate_oneWay: COST,
  // ---- KEY CONTROL: correlation ----
  pairwiseCorr: corr,
  corrAbove0p7: corr.median > 0.7,
  // ---- analytic decomposition (per-period daily) ----
  decomposition: {
    rebalGeoDailyBps: dec.rebalGeo * 1e4,
    buyHoldGeoDailyBps: dec.bhGeo * 1e4,
    wAvgComponentGeoDailyBps: dec.wAvgGeo * 1e4,
    diversificationReturnDailyBps: dec.divReturnPerPeriod * 1e4,
    diversificationReturnAnnualizedPct: ((1 + dec.divReturnPerPeriod) ** PPY - 1) * 100,
    rebalMinusAvgComponentDailyBps: divMinusDrift * 1e4, // ≈ diversification return (Booth-Fama)
    identityErrorBps: identityErr * 1e4, // should be ≈ 0 → identity holds
    rebalMinusBuyHoldDailyBps: excessGeoRebalVsBH * 1e4, // <0 ⇒ drift drag (rebal sells winners)
    driftDragDailyBps: (dec.bhGeo - dec.rebalGeo) * 1e4, // positive ⇒ BH beats rebal (winners run)
    wAvgVarDaily: dec.wAvgVar,
    portVarDaily: dec.portVar,
  },
  // ---- net-of-cost frequency sweep ----
  frequencySweep: freqResults,
  bestFrequency: bestName,
  // ---- gauntlet on the harvest (rebal − BH) ----
  harvest: {
    bestFrequency: bestName,
    meanDailyBps: harvestMeanDaily * 1e4,
    annualizedExcessPct: ((1 + harvestMeanDaily) ** PPY - 1) * 100,
    netSharpeAnn: harvestSh,
    honestN: HONEST_N,
    dsr_p: dsr.deflatedProbability,
    dsr_z: dsr.zScore,
    blockBootstrapCI95_meanDailyBps: [ci.lower * 1e4, ci.upper * 1e4],
    ciExcludesZero: ci.lower > 0,
  },
  // ---- THE RIGHT SURROGATE NULL ----
  surrogateNull: {
    matched_corr_blockBootstrap: {
      meanSharpe: surroMatchedMean,
      p_realGEsurrogate: pMatched,
    },
    matched_corr_plus_crossSectionalShuffle: {
      meanSharpe: surroXSMean,
      p_realGEsurrogate: pXS,
    },
    note:
      "Block (len=21) bootstrap of the daily return PANEL preserves own + cross-asset " +
      "correlation = matched high crypto corr. XS variant permutes column identities per " +
      "block to kill any persistent winner/loser drift while keeping corr+vol.",
  },
  // ---- inverse-vol robustness ----
  inverseVol: {
    monthlyRebal_excessGeoDailyBps: ivExcessGeo * 1e4,
    monthlyRebal_excessAnnualizedPct: ((1 + ivExcessGeo) ** PPY - 1) * 100,
  },
  multiUniverse,
  monthlyAt100k_usd: 100000 * (((1 + harvestMeanDaily) ** 21) - 1),
};

fs.writeFileSync(path.join(OUT, "d8b4-results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
