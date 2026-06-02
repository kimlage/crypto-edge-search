#!/usr/bin/env tsx
/**
 * FUNDING-RATE-AS-SENTIMENT CONTRARIAN FADE  (refinement of the killed "T7")
 * ---------------------------------------------------------------------------
 * THESIS: perpetual funding is a crowding/sentiment proxy. When funding is
 * EXTREME POSITIVE, longs are crowded and over-paying -> fade them (SHORT spot).
 * When EXTREME NEGATIVE, shorts are crowded -> buy (LONG spot). We test whether
 * the funding extreme predicts the SAME-COIN forward SPOT return.
 *
 * CRITICAL — STRIP THE CARRY:
 *   The classic funding-carry trade earns a deterministic accrual (short perp
 *   collects funding). That accrual is NOT what we test here. We test ONLY the
 *   directional TIMING overlay: a directional SPOT bet whose P&L is purely the
 *   forward spot price return (minus trading cost). No funding cashflow EVER
 *   enters the P&L — funding is used ONLY as a signal. So a positive result is
 *   the timing edge, net of carry, by construction.
 *
 * STRENGTHEN:
 *   - z-score funding to its own rolling trailing distribution (per coin),
 *     causal (only past data), so "extreme" is relative not absolute.
 *   - act ONLY on extremes (|z| >= zEnter); flat otherwise.
 *   - multi-coin pooling: pool the overlay daily returns across 8 coins.
 *   - realistic taker cost 4bps/side on every position change.
 *
 * RIGHT NULL:
 *   - block-bootstrap CI on the pooled net daily return (committed harness).
 *   - lead-lag PLACEBO: shuffle funding-signal vs forward return (break the
 *     same-day pairing by circularly rotating the signal). The real edge must
 *     beat the placebo distribution -> a surrogate p-value.
 *   - Deflated Sharpe at HONEST N (every (zEnter,horizon) config tried).
 *   - CSCV/PBO across configs, Harvey-Liu style haircut via deflated prob.
 *
 * JUDGE with src/lib/training/statistical-validation.ts primitives (committed).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  computeProbabilisticSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/training/statistical-validation.ts";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];
const DATA_DIR = path.resolve("output/funding");
const OUT_DIR = path.resolve("output/edgehunt");

const TAKER_BPS = 4; // bps per side, taker
const COST_PER_SIDE = TAKER_BPS / 10_000; // 0.0004
const ROLL_WINDOW = 60; // trailing days for funding z-score distribution
const ANNUALIZE = Math.sqrt(365); // daily -> annual sharpe

// The grid of configs we TRY. Honest N = every config evaluated on the pool.
const Z_ENTER_GRID = [1.0, 1.5, 2.0, 2.5];
const HORIZON_GRID = [1, 3, 5]; // forward holding days
// honest N also counts the directional convention (fade vs momentum) we examine
// and the "both-sided vs long-only-extreme-neg" variants we look at below.

// ----------------------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------------------
interface FundingPoint {
  fundingTime: number;
  fundingRate: number;
}
interface PricePoint {
  date: string;
  spotClose: number;
  perpClose: number;
}

function loadCoin(coin: string): {
  dates: string[];
  spot: number[];
  fundingDaily: number[]; // sum of the (up to) 3 funding prints on that calendar day
} {
  const funding: FundingPoint[] = JSON.parse(
    readFileSync(path.join(DATA_DIR, `${coin}USDT_funding_8h.json`), "utf8"),
  );
  const prices: PricePoint[] = JSON.parse(
    readFileSync(path.join(DATA_DIR, `${coin}USDT_prices_daily.json`), "utf8"),
  );

  // Aggregate 8h funding to a daily sum, keyed by UTC calendar date.
  const fundingByDate = new Map<string, number>();
  for (const fp of funding) {
    const d = new Date(fp.fundingTime).toISOString().slice(0, 10);
    fundingByDate.set(d, (fundingByDate.get(d) ?? 0) + fp.fundingRate);
  }

  const dates: string[] = [];
  const spot: number[] = [];
  const fundingDaily: number[] = [];
  for (const p of prices) {
    if (!Number.isFinite(p.spotClose) || p.spotClose <= 0) continue;
    dates.push(p.date);
    spot.push(p.spotClose);
    fundingDaily.push(fundingByDate.get(p.date) ?? 0);
  }
  return { dates, spot, fundingDaily };
}

// ----------------------------------------------------------------------------
// Strategy: directional SPOT overlay driven by funding z-score extremes.
// Returns the per-day NET overlay return for a single coin.
//   position p_t in {-1,0,+1} decided at close of day t using info up to day t.
//   overlay raw return on day t+1 = p_t * (spot_{t+1}/spot_t - 1).
//   For horizon H, we hold the position H days; cost charged on net turnover.
// We implement horizon by overlapping daily slices then NORMALIZE by H so the
// vol is comparable across horizons (standard overlapping-position scaling).
// ----------------------------------------------------------------------------
type SignalFn = (z: number, zEnter: number) => -1 | 0 | 1;

const FADE: SignalFn = (z, zEnter) => {
  if (z >= zEnter) return -1; // crowded longs -> short spot
  if (z <= -zEnter) return 1; // crowded shorts -> long spot
  return 0;
};
const MOMENTUM: SignalFn = (z, zEnter) => {
  // placebo direction: trade WITH the crowd (should lose if fade is the edge)
  if (z >= zEnter) return 1;
  if (z <= -zEnter) return -1;
  return 0;
};

interface OverlayResult {
  dates: string[]; // date of the realized return (t+1 onward aggregated)
  net: number[]; // net daily overlay return aligned to dates
  gross: number[];
  positions: number[]; // target position decided at t (for diagnostics)
  trades: number; // number of position changes
  exposureDays: number; // days with nonzero position
}

function runOverlay(
  coin: ReturnType<typeof loadCoin>,
  zEnter: number,
  horizon: number,
  signalFn: SignalFn,
): OverlayResult {
  const { dates, spot, fundingDaily } = coin;
  const n = spot.length;

  // daily spot simple returns r_{t} = spot_t/spot_{t-1} - 1  (return realized ON day t)
  const ret: number[] = new Array(n).fill(0);
  for (let t = 1; t < n; t++) ret[t] = spot[t] / spot[t - 1] - 1;

  // causal rolling z-score of daily funding using ONLY past ROLL_WINDOW days.
  const z: number[] = new Array(n).fill(NaN);
  for (let t = 0; t < n; t++) {
    const lo = t - ROLL_WINDOW;
    if (lo < 0) continue; // need full window of strictly-past data
    let sum = 0;
    let cnt = 0;
    for (let k = lo; k < t; k++) {
      sum += fundingDaily[k];
      cnt++;
    }
    if (cnt < ROLL_WINDOW) continue;
    const mean = sum / cnt;
    let varSum = 0;
    for (let k = lo; k < t; k++) varSum += (fundingDaily[k] - mean) ** 2;
    const sd = Math.sqrt(varSum / (cnt - 1));
    if (sd <= 1e-12) continue;
    z[t] = (fundingDaily[t] - mean) / sd;
  }

  // Target position decided at close of day t (using z[t], which uses funding
  // through day t). The position is held for `horizon` days; the realized
  // overlay return on day s (for s in t+1..t+H) is targetPos_t * ret[s].
  // We build per-day net overlay return by summing contributions of all open
  // slices, each slice weighted 1/horizon (so total notional ~1). Cost is
  // charged on the change in aggregate target weight between days.
  const targetPos: number[] = new Array(n).fill(0); // decided at day t
  for (let t = 0; t < n; t++) {
    if (Number.isFinite(z[t])) targetPos[t] = signalFn(z[t], zEnter);
  }

  // aggregate held weight on each return-day s = (1/H) * sum_{j=1..H} targetPos[s-j]
  const heldWeight: number[] = new Array(n).fill(0);
  for (let s = 0; s < n; s++) {
    let w = 0;
    for (let j = 1; j <= horizon; j++) {
      const t = s - j;
      if (t >= 0) w += targetPos[t];
    }
    heldWeight[s] = w / horizon;
  }

  const grossArr: number[] = [];
  const netArr: number[] = [];
  const outDates: string[] = [];
  let trades = 0;
  let exposureDays = 0;
  let turnoverTotal = 0;

  let prevW = 0;
  // Start once the z-window is warm (first usable decision) to avoid leading zeros
  const firstUsable = ROLL_WINDOW + 1;
  for (let s = firstUsable; s < n; s++) {
    const w = heldWeight[s];
    const gross = w * ret[s];
    const turnover = Math.abs(w - prevW); // change in net exposure
    const cost = turnover * COST_PER_SIDE;
    const net = gross - cost;
    grossArr.push(gross);
    netArr.push(net);
    outDates.push(dates[s]);
    turnoverTotal += turnover;
    if (turnover > 1e-9) trades++;
    if (Math.abs(w) > 1e-9) exposureDays++;
    prevW = w;
  }

  return {
    dates: outDates,
    net: netArr,
    gross: grossArr,
    positions: targetPos,
    trades,
    exposureDays,
  };
}

// ----------------------------------------------------------------------------
// Pool overlay returns across coins onto a common date axis (equal-weight the
// coins that are active that day; if all flat, pooled return = 0).
// ----------------------------------------------------------------------------
function poolAcrossCoins(
  perCoin: { coin: string; res: OverlayResult }[],
): { dates: string[]; net: number[]; gross: number[]; activeFrac: number } {
  const dateSet = new Set<string>();
  for (const { res } of perCoin) for (const d of res.dates) dateSet.add(d);
  const dates = [...dateSet].sort();
  const idx = new Map<string, number>();
  dates.forEach((d, i) => idx.set(d, i));

  // For pooling we equal-weight ACTIVE coins each day (coins with nonzero held
  // weight). This is the realistic "spread capital across live signals" pool.
  const netSum = new Array(dates.length).fill(0);
  const grossSum = new Array(dates.length).fill(0);
  const activeCnt = new Array(dates.length).fill(0);
  // Track held weight per coin per day to know "active"
  for (const { res } of perCoin) {
    for (let i = 0; i < res.dates.length; i++) {
      const di = idx.get(res.dates[i])!;
      const active = Math.abs(res.gross[i]) > 0 || res.net[i] !== 0;
      if (active || res.net[i] !== 0) {
        // count as active if the coin contributed any nonzero net (incl pure cost days)
      }
      netSum[di] += res.net[i];
      grossSum[di] += res.gross[i];
      // active if it had exposure: approximate via gross!=0 OR cost paid (net<0 with gross 0)
      if (res.gross[i] !== 0 || res.net[i] !== 0) activeCnt[di] += 1;
    }
  }
  // Equal-weight active coins: divide by number active that day.
  const net: number[] = [];
  const gross: number[] = [];
  let activeDays = 0;
  for (let i = 0; i < dates.length; i++) {
    const k = activeCnt[i];
    if (k > 0) {
      net.push(netSum[i] / k);
      gross.push(grossSum[i] / k);
      activeDays++;
    } else {
      net.push(0);
      gross.push(0);
    }
  }
  return { dates, net, gross, activeFrac: activeDays / dates.length };
}

// ----------------------------------------------------------------------------
// Placebo: circularly rotate each coin's funding signal vs its forward returns
// to break the same-day pairing while preserving each series' autocorrelation.
// Returns a distribution of pooled net Sharpe under the null.
// ----------------------------------------------------------------------------
function placeboSharpeDistribution(
  coins: { coin: string; data: ReturnType<typeof loadCoin> }[],
  zEnter: number,
  horizon: number,
  signalFn: SignalFn,
  nShuffles: number,
  seed: number,
): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [];
  for (let s = 0; s < nShuffles; s++) {
    const perCoin = coins.map(({ coin, data }) => {
      // rotate the funding series by a random shift >= ROLL_WINDOW to fully
      // decouple it from the price path while preserving funding autocorrelation.
      const n = data.fundingDaily.length;
      const minShift = ROLL_WINDOW + horizon + 2;
      const shift =
        minShift + Math.floor(rng() * Math.max(1, n - 2 * minShift));
      const rotated = rotate(data.fundingDaily, shift);
      const fake = { ...data, fundingDaily: rotated };
      return { coin, res: runOverlay(fake, zEnter, horizon, signalFn) };
    });
    const pooled = poolAcrossCoins(perCoin);
    const st = summarizeReturnSeries(pooled.net);
    out.push(st.sharpe);
  }
  return out;
}

function rotate(arr: number[], shift: number): number[] {
  const n = arr.length;
  const s = ((shift % n) + n) % n;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[(i + s) % n];
  return out;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
function fmt(x: number, d = 4): string {
  return Number.isFinite(x) ? x.toFixed(d) : "NaN";
}

function main(): void {
  const loaded = COINS.map((coin) => ({ coin, data: loadCoin(coin) }));

  // ----- Honest N accounting -----
  // Configs tried on the POOL: zEnter x horizon x {FADE, MOMENTUM-as-control}.
  // The MOMENTUM direction is a control/placebo we examine (not a free pick),
  // but to be honest we COUNT every overlay we score. We also count the
  // long-only / both-sided framings we examine below.
  const directions: { name: string; fn: SignalFn }[] = [
    { name: "fade", fn: FADE },
    { name: "momentum", fn: MOMENTUM },
  ];

  interface ConfigResult {
    id: string;
    direction: string;
    zEnter: number;
    horizon: number;
    sampleCount: number;
    activeFrac: number;
    netSharpe: number;
    netSharpeAnn: number;
    grossSharpe: number;
    netMeanDaily: number;
    netMeanMonthly: number;
    totalTrades: number;
    poolNet: number[]; // kept for the chosen primary
  }

  const results: ConfigResult[] = [];

  for (const dir of directions) {
    for (const zEnter of Z_ENTER_GRID) {
      for (const horizon of HORIZON_GRID) {
        const perCoin = loaded.map(({ coin, data }) => ({
          coin,
          res: runOverlay(data, zEnter, horizon, dir.fn),
        }));
        const pooled = poolAcrossCoins(perCoin);
        const st = summarizeReturnSeries(pooled.net);
        const gst = summarizeReturnSeries(pooled.gross);
        const totalTrades = perCoin.reduce((a, b) => a + b.res.trades, 0);
        results.push({
          id: `${dir.name}|z${zEnter}|h${horizon}`,
          direction: dir.name,
          zEnter,
          horizon,
          sampleCount: st.sampleCount,
          activeFrac: pooled.activeFrac,
          netSharpe: st.sharpe,
          netSharpeAnn: st.sharpe * ANNUALIZE,
          grossSharpe: gst.sharpe,
          netMeanDaily: st.mean,
          netMeanMonthly: st.mean * 30,
          totalTrades,
          poolNet: pooled.net,
        });
      }
    }
  }

  // HONEST N = every config evaluated (both directions count as trials).
  const honestN = results.length;

  // ----- Pick the primary FADE config by net Sharpe (this is the in-sample
  // best; deflated Sharpe at honestN penalizes this selection) -----
  const fadeResults = results.filter((r) => r.direction === "fade");
  const primary = fadeResults.reduce((best, r) =>
    r.netSharpe > best.netSharpe ? r : best,
  );

  // ----- Deflated Sharpe at honest N on the primary's pooled net returns -----
  const dsr = computeDeflatedSharpeRatio(primary.poolNet, {
    trialCount: honestN,
  });
  const psr = computeProbabilisticSharpeRatio(primary.poolNet, 0);

  // ----- Block bootstrap CI on the primary net daily Sharpe -----
  const boot = blockBootstrapConfidenceInterval(primary.poolNet, {
    statistic: "sharpe",
    iterations: 2000,
    blockLength: 10,
    confidenceLevel: 0.95,
    seed: "funding-fade",
  });
  const bootMean = blockBootstrapConfidenceInterval(primary.poolNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 10,
    confidenceLevel: 0.95,
    seed: "funding-fade-mean",
  });

  // ----- Lead-lag PLACEBO surrogate null on the primary config -----
  const N_SHUFFLE = 1000;
  const placebo = placeboSharpeDistribution(
    loaded,
    primary.zEnter,
    primary.horizon,
    FADE,
    N_SHUFFLE,
    12345,
  );
  placebo.sort((a, b) => a - b);
  // one-sided p: fraction of placebo Sharpes >= observed
  const observed = primary.netSharpe;
  const ge = placebo.filter((s) => s >= observed).length;
  const surrogateP = (ge + 1) / (N_SHUFFLE + 1);
  const placeboMean = placebo.reduce((a, b) => a + b, 0) / placebo.length;
  const placeboSd = Math.sqrt(
    placebo.reduce((a, b) => a + (b - placeboMean) ** 2, 0) / placebo.length,
  );
  const placeboQ95 = placebo[Math.floor(0.95 * placebo.length)];

  // ----- CSCV / PBO across ALL fade configs (split the pooled series into
  // time folds, see if in-sample-best stays good out-of-sample) -----
  const N_FOLDS = 8;
  const cscvStrategies: CscvStrategyFoldReturns[] = fadeResults.map((r) => {
    const folds: number[][] = Array.from({ length: N_FOLDS }, () => []);
    r.poolNet.forEach((v, i) => {
      folds[Math.floor((i / r.poolNet.length) * N_FOLDS) % N_FOLDS].push(v);
    });
    return { id: r.id, folds };
  });
  let pbo: number | null = null;
  try {
    const cscv = estimateCscvPbo(cscvStrategies, { statistic: "sharpe" });
    pbo = cscv.pbo;
  } catch (e) {
    pbo = null;
  }

  // ----- Realistic $ at $10k / $100k for the primary (net) -----
  // Vol-scaling: the overlay runs at ~ (avg held |weight|) of capital. We report
  // the raw pooled net mean compounded monthly on the deployed notional.
  const monthlyPct = primary.netMeanMonthly; // already mean*30 of net daily
  const monthly10k = monthlyPct * 10_000;
  const monthly100k = monthlyPct * 100_000;

  // ----- Robustness: same-direction control (momentum) should NOT win -----
  const momResults = results.filter((r) => r.direction === "momentum");
  const momBest = momResults.reduce((best, r) =>
    r.netSharpe > best.netSharpe ? r : best,
  );

  // ----- Per-coin breakdown of the primary config (does it generalize?) -----
  const perCoinPrimary = loaded.map(({ coin, data }) => {
    const res = runOverlay(data, primary.zEnter, primary.horizon, FADE);
    const st = summarizeReturnSeries(res.net);
    return {
      coin,
      netSharpe: st.sharpe,
      netSharpeAnn: st.sharpe * ANNUALIZE,
      trades: res.trades,
      sampleCount: st.sampleCount,
      meanDaily: st.mean,
    };
  });
  const coinsPositive = perCoinPrimary.filter((c) => c.netSharpe > 0).length;

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const report = {
    meta: {
      strategy: "funding-rate-as-sentiment contrarian fade (carry stripped)",
      coins: COINS,
      rollWindow: ROLL_WINDOW,
      takerBps: TAKER_BPS,
      annualizeFactor: ANNUALIZE,
      honestN,
      gridZEnter: Z_ENTER_GRID,
      gridHorizon: HORIZON_GRID,
      note: "P&L is PURE directional spot return minus cost; NO funding accrual in P&L. Funding used only as signal.",
    },
    primary: {
      id: primary.id,
      zEnter: primary.zEnter,
      horizon: primary.horizon,
      sampleCount: primary.sampleCount,
      activeFrac: primary.activeFrac,
      netSharpeDaily: primary.netSharpe,
      netSharpeAnnual: primary.netSharpeAnn,
      grossSharpeDaily: primary.grossSharpe,
      netMeanDaily: primary.netMeanDaily,
      netMeanMonthlyPct: monthlyPct,
      totalTrades: primary.totalTrades,
    },
    deflatedSharpe: {
      sharpe: dsr.sharpe,
      expectedMaxSharpe: dsr.expectedMaxSharpe,
      zScore: dsr.zScore,
      deflatedProbability: dsr.deflatedProbability,
      trialCount: dsr.trialCount,
      psrProbability: psr.probability,
    },
    blockBootstrap: {
      sharpeEstimate: boot.estimate,
      sharpeLower95: boot.lower,
      sharpeUpper95: boot.upper,
      meanLower95: bootMean.lower,
      meanUpper95: bootMean.upper,
      blockLength: boot.blockLength,
    },
    placeboSurrogate: {
      nShuffles: N_SHUFFLE,
      observedSharpe: observed,
      placeboMean,
      placeboSd,
      placeboQ95,
      surrogateP,
    },
    cscvPbo: { pbo, nFolds: N_FOLDS, nStrategies: fadeResults.length },
    momentumControl: {
      bestId: momBest.id,
      bestNetSharpe: momBest.netSharpe,
      note: "control: trading WITH the crowd; should underperform fade if edge is real",
    },
    perCoinPrimary,
    coinsPositive,
    dollars: { monthlyPct, monthly10k, monthly100k },
    allConfigs: results.map((r) => ({
      id: r.id,
      netSharpe: r.netSharpe,
      netSharpeAnn: r.netSharpeAnn,
      grossSharpe: r.grossSharpe,
      netMeanMonthlyPct: r.netMeanMonthly,
      activeFrac: r.activeFrac,
      sampleCount: r.sampleCount,
      totalTrades: r.totalTrades,
    })),
  };

  writeFileSync(
    path.join(OUT_DIR, "funding-sentiment-fade.json"),
    JSON.stringify(report, null, 2),
  );

  // ---- console summary ----
  console.log("=== FUNDING-AS-SENTIMENT CONTRARIAN FADE (carry stripped) ===");
  console.log(`Honest N (configs tried): ${honestN}`);
  console.log(
    `\nPRIMARY (best fade): ${primary.id}  samples=${primary.sampleCount}  activeFrac=${fmt(primary.activeFrac, 3)}`,
  );
  console.log(
    `  net Sharpe daily = ${fmt(primary.netSharpe)}  (annualized ${fmt(primary.netSharpeAnn, 3)})`,
  );
  console.log(`  gross Sharpe daily = ${fmt(primary.grossSharpe)}`);
  console.log(
    `  net mean daily = ${fmt(primary.netMeanDaily, 6)}  monthly = ${fmt(monthlyPct * 100, 3)}%`,
  );
  console.log(`  total position changes = ${primary.totalTrades}`);
  console.log(`\nDEFLATED SHARPE @ N=${honestN}:`);
  console.log(
    `  expectedMaxSharpe(noise) = ${fmt(dsr.expectedMaxSharpe)}  observed = ${fmt(dsr.sharpe)}`,
  );
  console.log(
    `  deflated prob = ${fmt(dsr.deflatedProbability, 4)}  (PSR vs 0 = ${fmt(psr.probability, 4)})`,
  );
  console.log(`\nBLOCK BOOTSTRAP 95% CI (Sharpe daily):`);
  console.log(`  [${fmt(boot.lower)}, ${fmt(boot.upper)}]  est=${fmt(boot.estimate)}`);
  console.log(
    `  mean daily 95% CI = [${fmt(bootMean.lower, 6)}, ${fmt(bootMean.upper, 6)}]`,
  );
  console.log(`\nLEAD-LAG PLACEBO (shuffle funding vs forward return), n=${N_SHUFFLE}:`);
  console.log(
    `  observed Sharpe = ${fmt(observed)}  placebo mean=${fmt(placeboMean)} sd=${fmt(placeboSd)} q95=${fmt(placeboQ95)}`,
  );
  console.log(`  surrogate p = ${fmt(surrogateP, 4)}`);
  console.log(`\nCSCV/PBO across ${fadeResults.length} fade configs: PBO = ${pbo === null ? "n/a" : fmt(pbo, 3)}`);
  console.log(
    `\nMOMENTUM CONTROL best = ${momBest.id}  netSharpe=${fmt(momBest.netSharpe)} (should be <= fade if edge real)`,
  );
  console.log(`\nPER-COIN (primary fade): ${coinsPositive}/${COINS.length} positive net Sharpe`);
  for (const c of perCoinPrimary) {
    console.log(
      `  ${c.coin.padEnd(5)} netSharpe=${fmt(c.netSharpe).padStart(8)}  ann=${fmt(c.netSharpeAnn, 2).padStart(7)}  trades=${c.trades}`,
    );
  }
  console.log(`\nDOLLARS (net, deployed notional):`);
  console.log(
    `  monthly = ${fmt(monthlyPct * 100, 3)}%  -> $10k: $${fmt(monthly10k, 2)}  $100k: $${fmt(monthly100k, 2)}`,
  );
  console.log(`\nALL CONFIGS (id | netSharpeAnn | monthly% | activeFrac):`);
  for (const r of results) {
    console.log(
      `  ${r.id.padEnd(22)} ${fmt(r.netSharpeAnn, 3).padStart(8)}  ${fmt(r.netMeanMonthly * 100, 3).padStart(8)}%  af=${fmt(r.activeFrac, 3)}`,
    );
  }
  console.log(`\nWrote output/edgehunt/funding-sentiment-fade.json`);
}

main();
