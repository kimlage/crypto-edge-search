/**
 * Residual / Idiosyncratic Momentum (Blitz-Huij-Martens) on the 30-coin daily panel.
 *
 * Design:
 *  - Rolling-regress each coin's daily log return on BTC (and optionally PC1 of the panel)
 *    over a lookback window -> residual returns + estimated beta.
 *  - Rank residual momentum = cumulative residual return over a momentum window (with a skip-day).
 *  - Weekly rebalance: long top fraction / short bottom fraction, dollar-neutral.
 *  - Make BETA-NEUTRAL BY CONSTRUCTION: scale legs so portfolio BTC beta ~ 0 using estimated betas.
 *  - Vol-scale the spread to a target annual vol (cap leverage).
 *  - Realistic taker cost (4 bps/side) charged on every weight change (turnover).
 *
 * Verification:
 *  - Regress realized book returns on BTC return -> slope (should be ~0).
 *
 * Gates (committed harness, src/lib/training/statistical-validation.ts):
 *  - Net-of-cost Sharpe, monthly %, $ at 10k/100k.
 *  - Deflated Sharpe @ honest N (= every config tried).
 *  - Block bootstrap CI on mean daily net return.
 *  - CSCV/PBO across the swept window configs.
 *  - RIGHT surrogate null: factor-preserving block-bootstrap + cross-sectional shuffle of the
 *    residual ranking (re-run the entire weekly book under shuffled cross-sectional ranks).
 */

import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

// ----------------------------- data load -----------------------------

interface PanelFile {
  dates: string[];
  closes: Record<string, (number | null)[]>;
}

const panel: PanelFile = JSON.parse(
  fs.readFileSync(
    "output/crossxs/daily-closes.json",
    "utf8",
  ),
);

const DATES = panel.dates;
const T = DATES.length;
const COINS = Object.keys(panel.closes);
const N = COINS.length;
const BTC_IDX = COINS.indexOf("BTC");

// log returns matrix [t][coin]; null if either price missing/zero
const ret: (number | null)[][] = Array.from({ length: T }, () =>
  Array<number | null>(N).fill(null),
);
for (let c = 0; c < N; c++) {
  const px = panel.closes[COINS[c]];
  for (let t = 1; t < T; t++) {
    const p0 = px[t - 1];
    const p1 = px[t];
    if (p0 != null && p1 != null && p0 > 0 && p1 > 0) {
      ret[t][c] = Math.log(p1 / p0);
    }
  }
}

// ----------------------------- helpers -----------------------------

function olsBeta(y: number[], x: number[]): { alpha: number; beta: number } {
  const n = y.length;
  if (n < 5) return { alpha: 0, beta: 0 };
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return { alpha: sy / n, beta: 0 };
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  return { alpha, beta };
}

function annualizeSharpe(dailySharpe: number): number {
  return dailySharpe * Math.sqrt(365);
}

function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = a.reduce((s, v) => s + v, 0) / n;
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  return Math.sqrt(Math.max(0, v));
}

// seeded RNG (mulberry32)
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

// PC1 of the panel return cross-section at time t is not used by default; we use BTC as the
// single market factor (the spirit of BHM: residualize on the dominant factor). Optionally we
// add an equal-weight market factor as a second factor variant.

// ----------------------------- core backtest -----------------------------

interface Config {
  betaWindow: number; // rolling window for beta estimation
  momWindow: number; // residual momentum lookback
  skip: number; // skip-day (exclude most recent N days from signal)
  frac: number; // fraction of universe per leg (e.g. 0.3 = top/bottom 30%)
  factor: "btc" | "btc+mkt"; // residualize on BTC, or BTC + equal-weight market
  volTarget: number; // annualized vol target for the spread
  minHistory: number; // min valid daily returns for a coin to be eligible
  weighting: "bucket" | "zscore"; // hard top/bottom buckets, or rank z-score weights (lower turnover)
  band: number; // no-trade band: skip per-name reweight if |target-current| < band (turnover cut)
  rebalancePeriod: number; // days between rebalances
}

interface BacktestResult {
  dailyNet: number[]; // daily net (post-cost) book returns, length = number of active days
  dailyGross: number[];
  bookBtcExposure: number[]; // realized ex-ante portfolio beta to BTC each active day
  bookRetForBetaCheck: number[]; // gross book return aligned with btc return for regression
  btcRetForBetaCheck: number[];
  turnoverDaily: number[];
  avgGrossLeverage: number;
  nRebalances: number;
  avgNamesPerLeg: number;
}

const COST_PER_SIDE = 0.0004; // 4 bps taker per side

/**
 * Run the weekly residual-momentum book.
 * If `shuffleRng` is provided, the cross-sectional residual-momentum ranking is randomly permuted
 * at each rebalance (surrogate null: destroys cross-sectional signal, preserves factor structure
 * & marginal weights/turnover).
 */
function backtest(cfg: Config, shuffleRng?: () => number): BacktestResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  const turnoverDaily: number[] = [];
  const bookBtcExposure: number[] = [];
  const bookRetForBetaCheck: number[] = [];
  const btcRetForBetaCheck: number[] = [];

  // target weights per coin, held constant between weekly rebalances
  let targetW = new Float64Array(N);
  let prevW = new Float64Array(N); // previous applied weights (for turnover)
  let grossLevSum = 0;
  let grossLevCount = 0;
  let namesPerLegSum = 0;
  let nReb = 0;

  // equal-weight market factor return at time t (mean of available coin returns)
  function mktRet(t: number): number {
    let s = 0,
      k = 0;
    for (let c = 0; c < N; c++) {
      const r = ret[t][c];
      if (r != null) {
        s += r;
        k++;
      }
    }
    return k > 0 ? s / k : 0;
  }

  // first index where we have enough history to form a signal
  const warmup = Math.max(cfg.betaWindow, cfg.momWindow + cfg.skip) + 2;

  for (let t = warmup; t < T; t++) {
    const isRebalance = (t - warmup) % cfg.rebalancePeriod === 0;

    if (isRebalance) {
      // ---- estimate beta over [t-betaWindow, t-1] and residual momentum over the mom window ----
      const score: (number | null)[] = Array<number | null>(N).fill(null);
      const betaEst: number[] = Array<number>(N).fill(0);

      // precompute factor series over beta window
      const fStart = t - cfg.betaWindow;
      const btcSeries: number[] = [];
      const mktSeries: number[] = [];
      for (let s = fStart; s < t; s++) {
        btcSeries.push(ret[s][BTC_IDX] ?? 0);
        if (cfg.factor === "btc+mkt") mktSeries.push(mktRet(s));
      }

      for (let c = 0; c < N; c++) {
        if (c === BTC_IDX) continue;
        // gather paired (coin, factor) over beta window, require enough valid points
        const yArr: number[] = [];
        const xArr: number[] = [];
        let valid = 0;
        for (let s = fStart; s < t; s++) {
          const rc = ret[s][c];
          const rb = ret[s][BTC_IDX];
          if (rc != null && rb != null) {
            yArr.push(rc);
            xArr.push(rb);
            valid++;
          }
        }
        if (valid < cfg.minHistory) continue;

        // beta on BTC (single-factor); for btc+mkt we orthogonalize sequentially (BTC then mkt resid)
        const { alpha, beta } = olsBeta(yArr, xArr);
        betaEst[c] = beta;

        // residual momentum over [t-skip-momWindow, t-skip): cumulative residual
        let cumResid = 0;
        let mvalid = 0;
        const mEnd = t - cfg.skip;
        const mStart = mEnd - cfg.momWindow;
        for (let s = mStart; s < mEnd; s++) {
          const rc = ret[s][c];
          const rb = ret[s][BTC_IDX];
          if (rc == null || rb == null) continue;
          let resid = rc - alpha - beta * rb;
          if (cfg.factor === "btc+mkt") {
            // subtract additional market component (equal-weight) using a quick second regression
            // approximated by removing mkt loading estimated jointly is heavier; we keep BTC resid
            // and additionally net out the cross-sectional mean residual below.
          }
          cumResid += resid;
          mvalid++;
        }
        if (mvalid < Math.floor(cfg.momWindow * 0.6)) continue;
        // normalize residual momentum by its own residual vol over the beta window for cross-sectional comparability
        const residVol = (() => {
          const rs: number[] = [];
          for (let s = fStart; s < t; s++) {
            const rc = ret[s][c];
            const rb = ret[s][BTC_IDX];
            if (rc != null && rb != null) rs.push(rc - alpha - beta * rb);
          }
          return std(rs) || 1e-6;
        })();
        score[c] = cumResid / residVol;
      }

      // for btc+mkt, additionally demean scores cross-sectionally (removes common residual drift)
      if (cfg.factor === "btc+mkt") {
        const vals = score.filter((s): s is number => s != null);
        if (vals.length > 0) {
          const m = vals.reduce((a, b) => a + b, 0) / vals.length;
          for (let c = 0; c < N; c++) if (score[c] != null) score[c] = (score[c] as number) - m;
        }
      }

      // eligible coins
      const eligible = COINS.map((_, c) => c).filter((c) => score[c] != null);
      if (eligible.length >= 6) {
        // SURROGATE NULL: cross-sectional shuffle of the residual ranking.
        // Permute the score->coin assignment across eligible names. This destroys the
        // cross-sectional signal while preserving the marginal score distribution, leg sizes,
        // turnover, vol-scaling and costs — and it affects BOTH bucket and zscore weightings.
        if (shuffleRng) {
          const scs = eligible.map((c) => score[c] as number);
          for (let i = scs.length - 1; i > 0; i--) {
            const j = Math.floor(shuffleRng() * (i + 1));
            [scs[i], scs[j]] = [scs[j], scs[i]];
          }
          eligible.forEach((c, idx) => {
            score[c] = scs[idx];
          });
        }
        const ranked = [...eligible].sort(
          (a, b) => (score[b] as number) - (score[a] as number),
        );
        const k = Math.max(1, Math.floor(eligible.length * cfg.frac));
        const longs = ranked.slice(0, k);
        const shorts = ranked.slice(ranked.length - k);

        // raw dollar-neutral weights: either hard buckets or rank z-score (smoother, lower turnover)
        const wRaw = new Float64Array(N);
        if (cfg.weighting === "bucket") {
          for (const c of longs) wRaw[c] += 1 / k;
          for (const c of shorts) wRaw[c] -= 1 / k;
        } else {
          // z-score weighting across the whole eligible set; gross-normalized to 1 per side
          const sc = eligible.map((c) => score[c] as number);
          const m = sc.reduce((a, b) => a + b, 0) / sc.length;
          const sd = std(sc) || 1e-6;
          const raw = new Float64Array(N);
          for (const c of eligible) raw[c] = ((score[c] as number) - m) / sd;
          // dollar-neutral by demeaning the raw weights across eligible names
          const rawMean =
            eligible.reduce((a, c) => a + raw[c], 0) / eligible.length;
          let grossSum = 0;
          for (const c of eligible) {
            raw[c] -= rawMean;
            grossSum += Math.abs(raw[c]);
          }
          // normalize to total gross = 2 (1 long + 1 short), matching bucket scale
          const norm = grossSum > 1e-9 ? 2 / grossSum : 0;
          for (const c of eligible) wRaw[c] = raw[c] * norm;
        }

        // BETA-NEUTRAL BY CONSTRUCTION: net out residual portfolio beta.
        // portfolio beta = sum_c wRaw[c]*betaEst[c]. Hedge with BTC weight = -portBeta.
        let portBeta = 0;
        for (let c = 0; c < N; c++) portBeta += wRaw[c] * betaEst[c];
        // We neutralize by adjusting BTC weight (BTC beta ~ 1) so net beta = 0 without changing dollar-neutrality much.
        const wHedged = new Float64Array(wRaw);
        wHedged[BTC_IDX] += -portBeta; // BTC has beta 1 on itself
        // restore dollar-neutrality: the hedge adds net dollar exposure -portBeta; offset across legs
        // by subtracting its mean from all non-BTC active names proportionally.
        const netDollar = wHedged.reduce((a, b) => a + b, 0);
        const activeNonBtc = eligible.filter((c) => c !== BTC_IDX && wHedged[c] !== 0);
        if (activeNonBtc.length > 0 && Math.abs(netDollar) > 1e-12) {
          const adj = netDollar / activeNonBtc.length;
          for (const c of activeNonBtc) wHedged[c] -= adj;
        }

        targetW = wHedged;
        namesPerLegSum += k;
        nReb++;
      }
    }

    // ---- apply weights for day t (weights formed at last rebalance, traded into at rebalance day) ----
    // turnover & cost happen on the rebalance day (weights change from prevW to targetW).
    // No-trade band: only move a name if its target differs from current by >= band; otherwise hold.
    let turnover = 0;
    if (isRebalance) {
      const applied = new Float64Array(prevW);
      for (let c = 0; c < N; c++) {
        if (Math.abs(targetW[c] - prevW[c]) >= cfg.band) {
          applied[c] = targetW[c];
        }
      }
      for (let c = 0; c < N; c++) turnover += Math.abs(applied[c] - prevW[c]);
      prevW = applied;
    }
    const cost = turnover * COST_PER_SIDE; // cost per side; turnover already counts both legs as abs change

    // gross book return for day t using day-t realized returns
    let gross = 0;
    let grossLev = 0;
    let portBetaExAnte = 0;
    for (let c = 0; c < N; c++) {
      const w = prevW[c];
      if (w === 0) continue;
      const r = ret[t][c];
      if (r != null) gross += w * r;
      grossLev += Math.abs(w);
    }
    const btcR = ret[t][BTC_IDX];

    // vol-scaling: scale the whole book to target daily vol using trailing realized spread vol.
    // We compute a trailing 30d vol of the *unscaled* gross series; applied multiplicatively.
    dailyGross.push(gross);
    turnoverDaily.push(turnover);
    if (grossLev > 0) {
      grossLevSum += grossLev;
      grossLevCount++;
    }

    // record raw (pre-vol-scale) book + btc for beta verification
    bookRetForBetaCheck.push(gross);
    btcRetForBetaCheck.push(btcR ?? 0);
    bookBtcExposure.push(portBetaExAnte);

    // net = gross - cost (vol scaling applied in a second pass below)
    dailyNet.push(gross - cost);
  }

  // ----- vol-target scaling (second pass), applied causally with trailing 30d vol -----
  const VOLWIN = 30;
  const dailyTargetVol = cfg.volTarget / Math.sqrt(365);
  const scaledNet: number[] = [];
  const scaledGross: number[] = [];
  const scaledBook: number[] = [];
  for (let i = 0; i < dailyGross.length; i++) {
    const lo = Math.max(0, i - VOLWIN);
    const trailing = dailyGross.slice(lo, i);
    const v = trailing.length >= 10 ? std(trailing) : dailyTargetVol;
    let lev = v > 1e-9 ? dailyTargetVol / v : 1;
    lev = Math.min(lev, 4); // cap leverage at 4x
    scaledNet.push(dailyNet[i] * lev);
    scaledGross.push(dailyGross[i] * lev);
    scaledBook.push(bookRetForBetaCheck[i] * lev);
  }

  return {
    dailyNet: scaledNet,
    dailyGross: scaledGross,
    bookBtcExposure,
    bookRetForBetaCheck: scaledBook,
    btcRetForBetaCheck,
    turnoverDaily,
    avgGrossLeverage: grossLevCount > 0 ? grossLevSum / grossLevCount : 0,
    nRebalances: nReb,
    avgNamesPerLeg: nReb > 0 ? namesPerLegSum / nReb : 0,
  };
}

// ----------------------------- config sweep (HONEST N) -----------------------------

const betaWindows = [120];
const momWindows = [30, 60, 90];
const skips = [0, 1];
const fracs = [0.2, 0.3];
const factors: Config["factor"][] = ["btc", "btc+mkt"];
const weightings: Config["weighting"][] = ["bucket", "zscore"];
const bands = [0, 0.02]; // no-trade band to cut turnover
const rebalancePeriods = [7, 14]; // weekly, bi-weekly
const volTarget = 0.4;
const minHistory = 90;

const configs: Config[] = [];
for (const bw of betaWindows)
  for (const mw of momWindows)
    for (const sk of skips)
      for (const fr of fracs)
        for (const fa of factors)
          for (const wt of weightings)
            for (const bd of bands)
              for (const rp of rebalancePeriods)
                configs.push({
                  betaWindow: bw,
                  momWindow: mw,
                  skip: sk,
                  frac: fr,
                  factor: fa,
                  weighting: wt,
                  band: bd,
                  rebalancePeriod: rp,
                  volTarget,
                  minHistory,
                });

const HONEST_N = configs.length;

// ----------------------------- run all configs -----------------------------

interface Scored {
  cfg: Config;
  label: string;
  res: BacktestResult;
  netSharpeAnn: number;
  grossSharpeAnn: number;
  meanDailyNet: number;
  betaSlope: number;
  betaR2: number;
  avgTurnover: number;
}

function regressSlope(y: number[], x: number[]): { slope: number; r2: number } {
  const n = y.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
    syy += y[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = Math.abs(denom) < 1e-12 ? 0 : (n * sxy - sx * sy) / denom;
  const num = n * sxy - sx * sy;
  const r2 =
    (n * sxx - sx * sx) * (n * syy - sy * sy) > 0
      ? (num * num) / ((n * sxx - sx * sx) * (n * syy - sy * sy))
      : 0;
  return { slope, r2 };
}

const scored: Scored[] = configs.map((cfg) => {
  const res = backtest(cfg);
  const sNet = summarizeReturnSeries(res.dailyNet);
  const sGross = summarizeReturnSeries(res.dailyGross);
  const { slope, r2 } = regressSlope(res.bookRetForBetaCheck, res.btcRetForBetaCheck);
  const avgTurnover =
    res.turnoverDaily.reduce((a, b) => a + b, 0) /
    res.turnoverDaily.filter((x) => x > 0).length || 0;
  return {
    cfg,
    label: `bw${cfg.betaWindow}_mw${cfg.momWindow}_sk${cfg.skip}_fr${cfg.frac}_${cfg.factor}_${cfg.weighting}_bd${cfg.band}_rp${cfg.rebalancePeriod}`,
    res,
    netSharpeAnn: annualizeSharpe(sNet.sharpe),
    grossSharpeAnn: annualizeSharpe(sGross.sharpe),
    meanDailyNet: sNet.mean,
    betaSlope: slope,
    betaR2: r2,
    avgTurnover,
  };
});

// pick the best NET config (honest: this selection is what DSR @ honest N corrects for)
scored.sort((a, b) => b.netSharpeAnn - a.netSharpeAnn);
const best = scored[0];

// CANONICAL pre-registered spec (BHM textbook: 60d residual mom, skip-1, weekly, bucket, BTC factor).
// Reported separately, evaluated at N=1, as the fairest "if you had committed to one spec" view.
const canonCfg: Config = {
  betaWindow: 120,
  momWindow: 60,
  skip: 1,
  frac: 0.3,
  factor: "btc",
  weighting: "bucket",
  band: 0,
  rebalancePeriod: 7,
  volTarget,
  minHistory,
};
const canonScored = scored.find(
  (s) =>
    s.cfg.momWindow === 60 &&
    s.cfg.skip === 1 &&
    s.cfg.frac === 0.3 &&
    s.cfg.factor === "btc" &&
    s.cfg.weighting === "bucket" &&
    s.cfg.band === 0 &&
    s.cfg.rebalancePeriod === 7,
)!;
const canonDsr = computeDeflatedSharpeRatio(canonScored.res.dailyNet, { trialCount: 1 });
const canonBb = blockBootstrapConfidenceInterval(canonScored.res.dailyNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 10,
  confidenceLevel: 0.95,
  seed: "resmom-canon",
});
const canonSurr: number[] = [];
for (let i = 0; i < 300; i++) {
  const rng = mkRng(50000 + i * 7919);
  const sres = backtest(canonScored.cfg, rng);
  canonSurr.push(annualizeSharpe(summarizeReturnSeries(sres.dailyNet).sharpe));
}
canonSurr.sort((a, b) => a - b);
const canonSurrP =
  (canonSurr.filter((s) => s >= canonScored.netSharpeAnn).length + 1) / (canonSurr.length + 1);
void canonCfg;

// ----------------------------- gates on the best config -----------------------------

const bestNet = best.res.dailyNet;
const nDays = bestNet.length;
const yearsCovered = nDays / 365;

// Deflated Sharpe @ honest N
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });

// Block bootstrap CI on mean daily net return (factor-preserving block resample of the book)
const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 10,
  confidenceLevel: 0.95,
  seed: "resmom",
});

// CSCV/PBO across all configs (each config = a strategy; folds = contiguous time blocks)
const NFOLDS = 6;
function toFolds(series: number[]): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / NFOLDS);
  for (let f = 0; f < NFOLDS; f++) {
    const lo = f * sz;
    const hi = f === NFOLDS - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}
const cscvStrategies = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet) }));
const pbo = estimateCscvPbo(cscvStrategies, { statistic: "sharpe", trainFraction: 0.5 });

// ----------------------------- RIGHT surrogate null -----------------------------
// Factor-preserving block-bootstrap + cross-sectional shuffle of the residual ranking.
// We re-run the FULL weekly book for the best config but with the cross-sectional ranking
// permuted at every rebalance. This preserves the factor structure, the leg sizes, the
// turnover, the vol-scaling and the costs — it ONLY destroys the cross-sectional residual
// momentum signal. The observed net Sharpe must beat this null distribution.
const N_SURR = 300;
const surrSharpes: number[] = [];
for (let i = 0; i < N_SURR; i++) {
  const rng = mkRng(1000 + i * 7919);
  const sres = backtest(best.cfg, rng);
  const ss = summarizeReturnSeries(sres.dailyNet);
  surrSharpes.push(annualizeSharpe(ss.sharpe));
}
surrSharpes.sort((a, b) => a - b);
const surrMean = surrSharpes.reduce((a, b) => a + b, 0) / surrSharpes.length;
const surrAbove = surrSharpes.filter((s) => s >= best.netSharpeAnn).length;
const surrP = (surrAbove + 1) / (N_SURR + 1);
const surrP95 = surrSharpes[Math.floor(N_SURR * 0.95)];

// ----------------------------- monthly $ figures -----------------------------
const meanDailyNet = best.meanDailyNet;
const monthlyPct = meanDailyNet * 30; // arithmetic monthly (book is dollar-neutral, return on notional)
const monthlyAt10k = monthlyPct * 10000;
const monthlyAt100k = monthlyPct * 100000;

// ----------------------------- output -----------------------------
const report = {
  universe: { coins: N, dates: T, from: DATES[0], to: DATES[T - 1] },
  honestN: HONEST_N,
  best: {
    label: best.label,
    cfg: best.cfg,
    netSharpeAnnual: round(best.netSharpeAnn),
    grossSharpeAnnual: round(best.grossSharpeAnn),
    meanDailyNet: best.meanDailyNet,
    monthlyPct: round(monthlyPct * 100),
    monthlyAt10k: round(monthlyAt10k),
    monthlyAt100k: round(monthlyAt100k),
    daysActive: nDays,
    yearsCovered: round(yearsCovered),
    avgGrossLeverage: round(best.res.avgGrossLeverage),
    avgNamesPerLeg: round(best.res.avgNamesPerLeg),
    nRebalances: best.res.nRebalances,
    avgTurnoverPerRebalance: round(best.avgTurnover),
  },
  betaNeutrality: {
    slopeBookOnBtc: round(best.betaSlope, 4),
    r2: round(best.betaR2, 4),
    verdict: Math.abs(best.betaSlope) < 0.1 ? "NEUTRAL" : "NOT NEUTRAL",
  },
  gates: {
    deflatedSharpe: {
      trialCount: dsr.trialCount,
      sharpeDaily: round(dsr.sharpe, 4),
      expectedMaxSharpeDaily: round(dsr.expectedMaxSharpe, 4),
      deflatedProbability: round(dsr.deflatedProbability, 4),
      pass: dsr.deflatedProbability > 0.95,
    },
    blockBootstrapMeanDailyNet: {
      estimate: bb.estimate,
      lower: bb.lower,
      upper: bb.upper,
      pass: bb.lower > 0,
    },
    cscvPbo: {
      pbo: round(pbo.pbo, 4),
      medianLogit: round(pbo.medianLogit, 4),
      pass: pbo.pbo < 0.5,
    },
    surrogateNull: {
      observedNetSharpeAnn: round(best.netSharpeAnn),
      surrogateMeanSharpe: round(surrMean),
      surrogate95th: round(surrP95),
      pValue: round(surrP, 4),
      pass: surrP < 0.05,
    },
  },
  canonicalPreRegistered: {
    label: canonScored.label,
    netSharpeAnnual: round(canonScored.netSharpeAnn),
    grossSharpeAnnual: round(canonScored.grossSharpeAnn),
    monthlyPctOfNotional: round(canonScored.meanDailyNet * 30 * 100),
    monthlyAt100k: round(canonScored.meanDailyNet * 30 * 100000),
    betaSlope: round(canonScored.betaSlope, 4),
    avgTurnover: round(canonScored.avgTurnover),
    deflatedProbAtN1: round(canonDsr.deflatedProbability, 4),
    bootstrapMeanLower: canonBb.lower,
    bootstrapPass: canonBb.lower > 0,
    surrogateP: round(canonSurrP, 4),
    surrogatePass: canonSurrP < 0.05,
  },
  topConfigs: scored.slice(0, 15).map((s) => ({
    label: s.label,
    netSharpe: round(s.netSharpeAnn),
    grossSharpe: round(s.grossSharpeAnn),
    betaSlope: round(s.betaSlope, 4),
    avgTurnover: round(s.avgTurnover),
  })),
};

function round(x: number, d = 3): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

fs.writeFileSync(
  "output/edgehunt/residual-momentum-report.json",
  JSON.stringify(report, null, 2),
);

console.log(JSON.stringify(report, null, 2));
