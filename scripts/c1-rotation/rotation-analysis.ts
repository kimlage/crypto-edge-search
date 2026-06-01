/**
 * FRONT C1 — Capital ROTATION as lead-lag flow-of-capital.
 *
 * The user's model: "one big volume that passes between assets in cycles."
 * We operationalise that as a TIER LADDER and test three things on REAL daily
 * dollar-volume + price data (Binance public REST):
 *
 *   (1) CONSERVATION & ROTATION of volume share: is BTC-vs-alt dollar-volume
 *       share mean-reverting / cyclical, and does a FALLING BTC share PREDICT
 *       RISING alt returns next period?
 *   (2) LEAD-LAG matrix: does a leader tier's return/volume at t predict a
 *       follower tier's return at t+1..t+k (lagged cross-correlation +
 *       Granger-style OLS), net of nothing yet — pure structure.
 *   (3) TRADEABLE "ride the relay" rotation rule vs buy&hold BTC vs equal-weight,
 *       net of realistic cost (8 bps round-trip taker), through the FULL gate
 *       stack (Deflated Sharpe w/ TRUE N, CPCV/PBO, Harvey-Liu haircut,
 *       baselines incl. random-lottery + linear, consume-once holdout).
 *
 * SURROGATE/PLACEBO (methodological hero): the IDENTICAL machinery is run on
 *   - phase-randomized panels (preserve each asset's spectrum/vol),
 *   - block-bootstrap panels (preserve autocorrelation),
 *   - CROSS-SECTIONALLY-SHUFFLED panels (shuffle which asset gets which return
 *     path -> destroys genuine lead-lag/rotation, keeps marginals).
 * If the machinery finds equal-or-better edge on surrogates, rotation is an
 * ARTIFACT. We report the real-vs-surrogate distribution + a placebo p-value.
 *
 * Cost: 8 bps round-trip on EVERY position change. Gross-only = KILL.
 *
 * References (see final report): Lo & MacKinlay (1990) "When are contrarian
 * profits due to stock market overreaction?"; Bacon-Shone & ... lead-lag;
 * Granger (1969); Theiler et al. (1992) surrogate data; López de Prado (2018)
 * Advances in Financial ML (DSR, CPCV/PBO, MinBTL); Bailey & López de Prado
 * (2014) Deflated Sharpe; Harvey & Liu (2015) "Backtesting"; Politis & Romano
 * (1994) stationary bootstrap.
 *
 * Cloud $0. Imports ONLY the committed gates; does not modify them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  baselineScoreFromReturns,
  evaluateBaselineGate,
  type BaselineScore,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import {
  planHoldoutSplit,
  FinalHoldoutGuard,
} from "../../src/lib/significance/holdout";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const COST_ROUND_TRIP = 0.0008; // 8 bps round-trip taker perp (4 bps/side)
const ANNUALIZE = Math.sqrt(365); // daily -> annual Sharpe
const LEAD_LAG_MAX = 5; // test t+1..t+5
const SURROGATE_ITERS = 200; // per-null surrogate panels

// Tier ladder (mega -> large -> large_alts -> mid_small)
const TIERS: Record<string, string[]> = {
  mega: ["BTC"],
  large: ["ETH"],
  large_alts: ["SOL", "BNB", "XRP", "ADA", "AVAX", "DOGE"],
  // mid_small filled at runtime = every other panel coin
};
const TIER_ORDER = ["mega", "large", "large_alts", "mid_small"];

// ----------------------------------------------------------------------------
// Load real panel
// ----------------------------------------------------------------------------
interface Panel {
  coins: string[];
  dates: string[];
  close: Record<string, number[]>;
  quoteVolume: Record<string, number[]>;
}
const PANEL: Panel = JSON.parse(
  readFileSync("output/c1-rotation/volume-panel.json", "utf8"),
);

// mid_small = all panel coins not already in mega/large/large_alts
const ASSIGNED = new Set([...TIERS.mega, ...TIERS.large, ...TIERS.large_alts]);
TIERS.mid_small = PANEL.coins.filter((c) => !ASSIGNED.has(c));

const T = PANEL.dates.length;

// Daily simple returns per coin (NaN where price missing / pre-listing).
function dailyReturns(closes: number[]): number[] {
  const r = new Array(closes.length).fill(NaN);
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0) {
      r[i] = b / a - 1;
    }
  }
  return r;
}
const RET: Record<string, number[]> = {};
for (const c of PANEL.coins) RET[c] = dailyReturns(PANEL.close[c]);

// ----------------------------------------------------------------------------
// Tier aggregates: dollar-volume share + volume-weighted tier return.
// ----------------------------------------------------------------------------
function tierVolume(tier: string, i: number): number {
  let v = 0;
  for (const c of TIERS[tier]) {
    const x = PANEL.quoteVolume[c]?.[i];
    if (Number.isFinite(x)) v += x;
  }
  return v;
}
function totalVolume(i: number): number {
  let v = 0;
  for (const t of TIER_ORDER) v += tierVolume(t, i);
  return v;
}
/** Volume-weighted (cap-proxy) tier return at day i, using prior-day volume weights. */
function tierReturn(tier: string, i: number): number {
  let num = 0;
  let den = 0;
  for (const c of TIERS[tier]) {
    const r = RET[c]?.[i];
    const w = PANEL.quoteVolume[c]?.[i - 1];
    if (Number.isFinite(r) && Number.isFinite(w) && w > 0) {
      num += w * r;
      den += w;
    }
  }
  return den > 0 ? num / den : NaN;
}

// Precompute tier return series + tier volume-share series.
const tierRet: Record<string, number[]> = {};
const tierShare: Record<string, number[]> = {};
for (const t of TIER_ORDER) {
  tierRet[t] = new Array(T).fill(NaN);
  tierShare[t] = new Array(T).fill(NaN);
}
for (let i = 0; i < T; i += 1) {
  const tot = totalVolume(i);
  for (const t of TIER_ORDER) {
    tierRet[t][i] = i >= 1 ? tierReturn(t, i) : NaN;
    tierShare[t][i] = tot > 0 ? tierVolume(t, i) / tot : NaN;
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function pearson(x: number[], y: number[]): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i += 1) {
    const a = x[i];
    const b = y[i];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      n += 1;
      sx += a;
      sy += b;
      sxx += a * a;
      syy += b * b;
      sxy += a * b;
    }
  }
  if (n < 3) return NaN;
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return NaN;
  return cov / Math.sqrt(vx * vy);
}

/** Lagged cross-correlation: corr( x[t], y[t+k] ). Positive ⇒ x leads y by k. */
function laggedCorr(x: number[], y: number[], k: number): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + k < x.length; i += 1) {
    xs.push(x[i]);
    ys.push(y[i + k]);
  }
  return pearson(xs, ys);
}

/** Newey-West-ish t-stat of a single-predictor OLS (Granger-lite). */
function olsTStat(pred: number[], target: number[]): { beta: number; t: number; n: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < pred.length; i += 1) {
    if (Number.isFinite(pred[i]) && Number.isFinite(target[i])) {
      xs.push(pred[i]);
      ys.push(target[i]);
    }
  }
  const n = xs.length;
  if (n < 10) return { beta: NaN, t: NaN, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx <= 0) return { beta: NaN, t: NaN, n };
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const e = ys[i] - (alpha + beta * xs[i]);
    sse += e * e;
  }
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { beta, t: se > 0 ? beta / se : NaN, n };
}

function annualizedSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns.filter((x) => Number.isFinite(x)));
  return s.sharpe * ANNUALIZE;
}

function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// TEST (1) — Conservation & rotation of volume share
// ============================================================================
function test1Conservation() {
  // BTC dominance = mega share. Alt share = 1 - mega share.
  const megaShare = tierShare.mega;
  const altShare = megaShare.map((s) => (Number.isFinite(s) ? 1 - s : NaN));

  // Total-volume "conservation": is total volume stable, or does it expand/contract?
  // We report coefficient of variation of log total volume (not literally conserved,
  // but the SHARE is the conserved quantity by construction: shares sum to 1).
  const logTot: number[] = [];
  for (let i = 0; i < T; i += 1) {
    const v = totalVolume(i);
    if (v > 0) logTot.push(Math.log(v));
  }
  const meanLog = logTot.reduce((a, b) => a + b, 0) / logTot.length;
  const sdLog = Math.sqrt(
    logTot.reduce((a, b) => a + (b - meanLog) ** 2, 0) / logTot.length,
  );

  // Mean-reversion of BTC share: AR(1) on share changes. beta<0 ⇒ mean-reverting.
  const shareLevel: number[] = [];
  const shareNext: number[] = [];
  for (let i = 1; i < T; i += 1) {
    if (Number.isFinite(megaShare[i - 1]) && Number.isFinite(megaShare[i])) {
      shareLevel.push(megaShare[i - 1] - meanShare(megaShare));
      shareNext.push(megaShare[i] - megaShare[i - 1]);
    }
  }
  const ar = olsTStat(shareLevel, shareNext);

  // Predictive: does a FALLING BTC share at t predict RISING alt return at t+1?
  // predictor = -Δ(BTC share)_t  (falling dominance), target = alt-tier return_{t+1}
  const altRet = volWeightedAltReturn(); // large+large_alts+mid_small pooled
  const pred: number[] = [];
  const tgt: number[] = [];
  for (let i = 1; i + 1 < T; i += 1) {
    const dShare = megaShare[i] - megaShare[i - 1];
    const fall = Number.isFinite(dShare) ? -dShare : NaN;
    const next = altRet[i + 1];
    if (Number.isFinite(fall) && Number.isFinite(next)) {
      pred.push(fall);
      tgt.push(next);
    }
  }
  const predReg = olsTStat(pred, tgt);

  return {
    totalVolumeLogCV: sdLog / Math.abs(meanLog),
    btcShareMean: meanShare(megaShare),
    btcShareMin: Math.min(...megaShare.filter(Number.isFinite)),
    btcShareMax: Math.max(...megaShare.filter(Number.isFinite)),
    altShareMean: meanShare(altShare),
    shareAR1Beta: ar.beta,
    shareAR1T: ar.t,
    shareMeanReverting: Number.isFinite(ar.beta) && ar.beta < 0 && ar.t < -2,
    fallingBtcSharePredictsAltBeta: predReg.beta,
    fallingBtcSharePredictsAltT: predReg.t,
    fallingBtcSharePredictsAltN: predReg.n,
    predictivelySignificant: Number.isFinite(predReg.t) && Math.abs(predReg.t) > 2,
  };
}
function meanShare(s: number[]): number {
  const v = s.filter(Number.isFinite);
  return v.reduce((a, b) => a + b, 0) / v.length;
}
/** Pooled alt-tier (everything except mega) volume-weighted return. */
function volWeightedAltReturn(): number[] {
  const out = new Array(T).fill(NaN);
  const altTiers = ["large", "large_alts", "mid_small"];
  const altCoins = altTiers.flatMap((t) => TIERS[t]);
  for (let i = 1; i < T; i += 1) {
    let num = 0;
    let den = 0;
    for (const c of altCoins) {
      const r = RET[c]?.[i];
      const w = PANEL.quoteVolume[c]?.[i - 1];
      if (Number.isFinite(r) && Number.isFinite(w) && w > 0) {
        num += w * r;
        den += w;
      }
    }
    out[i] = den > 0 ? num / den : NaN;
  }
  return out;
}

// ============================================================================
// TEST (2) — Lead-lag matrix (cross-correlation + Granger-lite OLS)
// ============================================================================
function test2LeadLag(retSeries: Record<string, number[]> = tierRet) {
  const matrix: Record<string, Record<string, { k1corr: number; bestK: number; bestCorr: number; grangerT: number }>> = {};
  for (const lead of TIER_ORDER) {
    matrix[lead] = {};
    for (const follow of TIER_ORDER) {
      // lagged corr at k=1..MAX (lead at t -> follow at t+k)
      let bestCorr = 0;
      let bestK = 0;
      for (let k = 1; k <= LEAD_LAG_MAX; k += 1) {
        const c = laggedCorr(retSeries[lead], retSeries[follow], k);
        if (Number.isFinite(c) && Math.abs(c) > Math.abs(bestCorr)) {
          bestCorr = c;
          bestK = k;
        }
      }
      const k1 = laggedCorr(retSeries[lead], retSeries[follow], 1);
      // Granger-lite: follow_{t+1} ~ lead_t (controlling nothing; lite)
      const pred: number[] = [];
      const tgt: number[] = [];
      for (let i = 0; i + 1 < T; i += 1) {
        if (Number.isFinite(retSeries[lead][i]) && Number.isFinite(retSeries[follow][i + 1])) {
          pred.push(retSeries[lead][i]);
          tgt.push(retSeries[follow][i + 1]);
        }
      }
      const g = olsTStat(pred, tgt);
      matrix[lead][follow] = { k1corr: k1, bestK, bestCorr, grangerT: g.t };
    }
  }
  return matrix;
}

// ============================================================================
// TEST (3) — "Ride the relay" rotation rule (tradeable, net of cost)
// ============================================================================
/**
 * Rule: each day, hold the NEXT tier in the ladder after the tier that "fired"
 * (leader = tier with the strongest recent volume-share momentum). The intuition:
 * capital relays from mega -> large -> large_alts -> mid_small. We detect the
 * "fire" as the tier whose volume share rose most over a lookback, then ride the
 * NEXT tier's return tomorrow. Pays cost on every tier switch.
 *
 * Returns: { returns:number[], turnover, switches, holdSeries:string[] }
 */
function rotationStrategy(
  shareSeries: Record<string, number[]> = tierShare,
  retSeries: Record<string, number[]> = tierRet,
  lookback = 5,
): { returns: number[]; turnover: number; switches: number; holds: string[] } {
  const returns: number[] = [];
  const holds: string[] = [];
  let prevHold = "";
  let switches = 0;
  for (let i = lookback + 1; i + 1 < T; i += 1) {
    // leader = tier whose volume share rose most over the lookback window
    let leader = TIER_ORDER[0];
    let bestMom = -Infinity;
    for (const t of TIER_ORDER) {
      const s0 = shareSeries[t][i - lookback];
      const s1 = shareSeries[t][i];
      if (Number.isFinite(s0) && Number.isFinite(s1)) {
        const mom = s1 - s0;
        if (mom > bestMom) {
          bestMom = mom;
          leader = t;
        }
      }
    }
    // ride the NEXT tier in the ladder
    const li = TIER_ORDER.indexOf(leader);
    const nextTier = TIER_ORDER[(li + 1) % TIER_ORDER.length];
    const r = retSeries[nextTier][i + 1];
    if (!Number.isFinite(r)) continue;
    let net = r;
    if (nextTier !== prevHold && prevHold !== "") {
      net -= COST_ROUND_TRIP;
      switches += 1;
    } else if (prevHold === "") {
      net -= COST_ROUND_TRIP / 2; // initial entry
    }
    returns.push(net);
    holds.push(nextTier);
    prevHold = nextTier;
  }
  const turnover = returns.length > 0 ? switches / returns.length : 0;
  return { returns, turnover, switches, holds };
}

/** Buy & hold BTC (net) over same window. */
function buyHoldBTC(start: number): number[] {
  const out: number[] = [];
  for (let i = start; i + 1 < T; i += 1) {
    const r = RET.BTC[i + 1];
    if (Number.isFinite(r)) out.push(r);
  }
  if (out.length > 0) out[0] -= COST_ROUND_TRIP / 2;
  return out;
}
/** Equal-weight all-coin daily rebalanced (net of cost on the daily rebalance). */
function equalWeight(start: number): { returns: number[]; turnover: number } {
  const out: number[] = [];
  for (let i = start; i + 1 < T; i += 1) {
    let s = 0;
    let n = 0;
    for (const c of PANEL.coins) {
      const r = RET[c][i + 1];
      if (Number.isFinite(r)) {
        s += r;
        n += 1;
      }
    }
    if (n > 0) out.push(s / n - COST_ROUND_TRIP * 0.1); // ~10% effective daily churn cost proxy
  }
  return { returns: out, turnover: 1 };
}

// ============================================================================
// SURROGATE GENERATORS (operate on per-coin return paths)
// ============================================================================
/**
 * Phase-randomization with a PRECOMPUTED magnitude spectrum (Theiler 1992).
 * The forward DFT + magnitude is computed ONCE per series and cached; each
 * surrogate only redraws Hermitian-symmetric phases and runs one inverse DFT
 * over a cached cos table. This makes 200 iters tractable in pure JS.
 */
interface SpectrumCache {
  n: number;
  reMag: Float64Array; // magnitude per frequency bin (forward DFT, done once)
}
const SPECTRUM_CACHE = new Map<string, SpectrumCache>();

function buildSpectrum(key: string, x: number[]): SpectrumCache {
  const cached = SPECTRUM_CACHE.get(key);
  if (cached) return cached;
  const vals = x.map((v) => (Number.isFinite(v) ? v : 0));
  const n = vals.length;
  const mag = new Float64Array(n);
  const two = (2 * Math.PI) / n;
  for (let k = 0; k < n; k += 1) {
    let sr = 0;
    let si = 0;
    const wk = two * k;
    for (let t = 0; t < n; t += 1) {
      const ang = wk * t;
      sr += vals[t] * Math.cos(ang);
      si -= vals[t] * Math.sin(ang);
    }
    mag[k] = Math.hypot(sr, si);
  }
  const entry: SpectrumCache = { n, reMag: mag };
  SPECTRUM_CACHE.set(key, entry);
  return entry;
}

/**
 * Inverse with random Hermitian-symmetric phases. We exploit conjugate symmetry:
 * out[t] = (1/n)[ mag[0] + 2 Σ_{k=1..n/2-1} mag[k]·cos(2π k t/n + φ_k) + Nyquist ].
 * The forward DFT (the magnitude) is cached, so this is the only per-surrogate cost.
 */
function phaseRandomizeKeyed(key: string, x: number[], rng: () => number): number[] {
  const { n, reMag: mag } = buildSpectrum(key, x);
  const half = Math.floor(n / 2);
  const phi = new Float64Array(half + 1);
  for (let k = 1; k <= half; k += 1) phi[k] = (rng() * 2 - 1) * Math.PI;
  const two = (2 * Math.PI) / n;
  const out = new Array(n);
  for (let t = 0; t < n; t += 1) {
    let s = mag[0]; // DC term (phase 0)
    const wt = two * t;
    for (let k = 1; k < half; k += 1) {
      s += 2 * mag[k] * Math.cos(wt * k + phi[k]);
    }
    if (n % 2 === 0) {
      // Nyquist term, real-valued (phase ±)
      s += mag[half] * Math.cos(wt * half + phi[half]);
    } else {
      s += 2 * mag[half] * Math.cos(wt * half + phi[half]);
    }
    out[t] = s / n;
  }
  return out;
}
/** Block bootstrap a series (preserve short-range autocorrelation). */
function blockBootstrap(x: number[], rng: () => number, block = 20): number[] {
  const n = x.length;
  const out: number[] = [];
  while (out.length < n) {
    const start = Math.floor(rng() * n);
    for (let j = 0; j < block && out.length < n; j += 1) {
      out.push(x[(start + j) % n]);
    }
  }
  return out;
}

// Note: phase-randomization over 2191 points with naive O(n^2) DFT is ~5M ops/series
// -> fine for a handful, but 200 iters x 43 coins is heavy. We phase-randomize the
// 4 TIER return series + tier share series directly (cheap & sufficient: the null
// destroys cross-tier phase alignment while keeping each tier's spectrum).

/** Build a surrogate tier panel under a chosen null, then run tests 2 & 3 on it. */
function surrogateRun(
  nullType: "phase" | "block" | "xshuffle",
  rng: () => number,
): { rotSharpe: number; maxLeadLagCorr: number } {
  const sRet: Record<string, number[]> = {};
  const sShare: Record<string, number[]> = {};

  if (nullType === "xshuffle") {
    // CROSS-SECTIONAL SHUFFLE: permute which TIER gets which return path & share
    // path -> destroys real lead-lag/rotation, keeps each marginal intact.
    const perm = [...TIER_ORDER].sort(() => rng() - 0.5);
    for (let i = 0; i < TIER_ORDER.length; i += 1) {
      sRet[TIER_ORDER[i]] = tierRet[perm[i]].slice();
      // also independently time-shift the share path to break joint timing
      const shift = Math.floor(rng() * T);
      const src = tierShare[perm[i]];
      sShare[TIER_ORDER[i]] = src.map((_, j) => src[(j + shift) % T]);
    }
  } else if (nullType === "phase") {
    for (const t of TIER_ORDER) {
      sRet[t] = phaseRandomizeKeyed(`ret_${t}`, tierRet[t], rng);
      const mShare = meanShare(tierShare[t]);
      const centred = tierShare[t].map((v) => (Number.isFinite(v) ? v - mShare : 0));
      sShare[t] = phaseRandomizeKeyed(`share_${t}`, centred, rng).map((v) =>
        Math.min(1, Math.max(0, v + mShare)),
      );
    }
  } else {
    // block bootstrap each tier independently (destroys cross-tier joint timing)
    for (const t of TIER_ORDER) {
      sRet[t] = blockBootstrap(tierRet[t], rng);
      sShare[t] = blockBootstrap(tierShare[t], rng);
    }
  }

  const rot = rotationStrategy(sShare, sRet);
  const rotSharpe = rot.returns.length > 30 ? annualizedSharpe(rot.returns) : 0;

  // max |lead-lag corr| off-diagonal at k=1
  let maxLL = 0;
  for (const a of TIER_ORDER)
    for (const b of TIER_ORDER) {
      if (a === b) continue;
      const c = laggedCorr(sRet[a], sRet[b], 1);
      if (Number.isFinite(c) && Math.abs(c) > Math.abs(maxLL)) maxLL = c;
    }
  return { rotSharpe, maxLeadLagCorr: maxLL };
}

// ============================================================================
// MAIN
// ============================================================================
function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  console.log("=".repeat(78));
  console.log("FRONT C1 — Capital ROTATION (lead-lag flow-of-capital)");
  console.log("=".repeat(78));
  console.log(
    `Panel: ${PANEL.coins.length} coins, ${T} days (${PANEL.dates[0]} .. ${PANEL.dates[T - 1]})`,
  );
  console.log("Tier ladder:");
  for (const t of TIER_ORDER)
    console.log(`  ${t.padEnd(11)} (${TIERS[t].length}) ${TIERS[t].slice(0, 10).join(",")}${TIERS[t].length > 10 ? ",..." : ""}`);
  console.log(`Cost: ${(COST_ROUND_TRIP * 1e4).toFixed(0)} bps round-trip on every switch.`);

  // ---- TEST 1 ----
  console.log("\n" + "-".repeat(78));
  console.log("TEST 1 — Conservation & rotation of volume share");
  console.log("-".repeat(78));
  const t1 = test1Conservation();
  console.log(`  total-volume log CV: ${t1.totalVolumeLogCV.toFixed(3)} (0=perfectly conserved level)`);
  console.log(`  BTC volume share: mean=${(t1.btcShareMean * 100).toFixed(1)}%  range=[${(t1.btcShareMin * 100).toFixed(1)}%, ${(t1.btcShareMax * 100).toFixed(1)}%]`);
  console.log(`  alt share mean: ${(t1.altShareMean * 100).toFixed(1)}%`);
  console.log(`  BTC-share AR(1) on Δ: beta=${t1.shareAR1Beta.toFixed(4)} t=${t1.shareAR1T.toFixed(2)} meanReverting=${t1.shareMeanReverting}`);
  console.log(`  Falling-BTC-share -> next alt return: beta=${t1.fallingBtcSharePredictsAltBeta.toFixed(4)} t=${t1.fallingBtcSharePredictsAltT.toFixed(2)} n=${t1.fallingBtcSharePredictsAltN} sig=${t1.predictivelySignificant}`);

  // ---- TEST 2 ----
  console.log("\n" + "-".repeat(78));
  console.log("TEST 2 — Lead-lag matrix (real tiers), k=1 corr / best-k / Granger t");
  console.log("-".repeat(78));
  const t2 = test2LeadLag();
  console.log(`  ${"lead\\follow".padEnd(12)}${TIER_ORDER.map((x) => x.slice(0, 9).padStart(10)).join("")}`);
  let maxRealLL = 0;
  for (const lead of TIER_ORDER) {
    const cells = TIER_ORDER.map((follow) => {
      const m = t2[lead][follow];
      if (lead !== follow && Math.abs(m.k1corr) > Math.abs(maxRealLL)) maxRealLL = m.k1corr;
      return (Number.isFinite(m.k1corr) ? m.k1corr.toFixed(3) : "  -  ").padStart(10);
    });
    console.log(`  ${lead.padEnd(12)}${cells.join("")}`);
  }
  console.log(`  Granger-lite t-stats (lead_t -> follow_{t+1}):`);
  for (const lead of TIER_ORDER) {
    const cells = TIER_ORDER.map((f) => (Number.isFinite(t2[lead][f].grangerT) ? t2[lead][f].grangerT.toFixed(2) : "  -  ").padStart(10));
    console.log(`  ${lead.padEnd(12)}${cells.join("")}`);
  }
  console.log(`  max |off-diagonal k=1 lead-lag corr| (REAL): ${Math.abs(maxRealLL).toFixed(4)}`);

  // ---- TEST 3: rotation strategy, holdout split ----
  console.log("\n" + "-".repeat(78));
  console.log("TEST 3 — Ride-the-relay rotation rule, net of cost, full gate stack");
  console.log("-".repeat(78));

  const plan = planHoldoutSplit({ totalRows: T, holdoutFraction: 0.15, testFraction: 0.15 });
  console.log(`  Holdout plan: search[0,${plan.search.end}) test[${plan.test.start},${plan.test.end}) HOLDOUT[${plan.finalHoldout.start},${plan.finalHoldout.end})`);

  // Run rotation on FULL panel for the strategy series (we then split returns by index).
  const rot = rotationStrategy();
  console.log(`  rotation: ${rot.returns.length} trading days, switches=${rot.switches}, turnover=${(rot.turnover * 100).toFixed(1)}%/day`);

  // The rotation returns array starts at day (lookback+2). Map returns to absolute day index.
  const rotStartDay = 5 + 2; // lookback=5, +1 for share window, +1 for next-day return
  // search-region returns vs holdout-region returns
  const searchRet: number[] = [];
  const holdoutRet: number[] = [];
  for (let j = 0; j < rot.returns.length; j += 1) {
    const day = rotStartDay + j;
    if (day < plan.finalHoldout.start) searchRet.push(rot.returns[j]);
    else holdoutRet.push(rot.returns[j]);
  }

  const grossRot = rotationStrategyGross();
  const searchStats = summarizeReturnSeries(searchRet);
  console.log(`  SEARCH region (n=${searchRet.length}):`);
  console.log(`    gross daily Sharpe (annualized): ${(annualizedSharpe(grossRot.searchReturns)).toFixed(3)}`);
  console.log(`    NET   daily Sharpe (annualized): ${(searchStats.sharpe * ANNUALIZE).toFixed(3)}  compound=${(searchStats.compoundReturn * 100).toFixed(1)}%`);

  // ---- Baselines on the search region ----
  const bhSearch = buyHoldBTC(0).slice(0, searchRet.length);
  const ewSearch = equalWeight(0).returns.slice(0, searchRet.length);
  const baselines: BaselineScore[] = [
    baselineScoreFromReturns("buy_and_hold", "Buy&Hold BTC", bhSearch, { statistic: "sharpe" }),
    baselineScoreFromReturns("equal_weight", "Equal-weight panel", ewSearch, { statistic: "sharpe" }),
    buildRandomLotteryBaseline({
      barReturns: tierRet.large_alts.filter(Number.isFinite),
      tradeCount: rot.switches,
      roundTripCost: COST_ROUND_TRIP,
      iterations: 512,
      statistic: "sharpe",
      seed: "c1-rotation",
    }),
    baselineScoreFromReturns(
      "linear_one_layer",
      "Linear predictor (falling-BTC-share)",
      linearBaselineReturns().slice(0, searchRet.length),
      { statistic: "sharpe" },
    ),
  ];
  const baseGate = evaluateBaselineGate({
    candidateReturns: searchRet,
    statistic: "sharpe",
    baselines,
    requirePositive: true,
  });
  console.log(`  Baseline gate (statistic=sharpe, candidate=${baseGate.candidateScore.toFixed(4)}):`);
  for (const c of baseGate.comparisons)
    console.log(`    vs ${c.label.padEnd(34)} base=${c.baselineScore.toFixed(4)} margin=${c.margin.toFixed(4)} beaten=${c.beaten}`);
  console.log(`    beatsAll=${baseGate.beatsAll} passed=${baseGate.passed} reasons=[${baseGate.reasons.join(",")}]`);

  // ---- TRUE N (trial count) for DSR/haircut ----
  // We searched over: 4 tier-rotation variants (lookbacks) x leader-momentum vs leader-return
  // x 3 next-step offsets, plus the lead-lag matrix scan (4x4 x 5 lags) and test-1 predictors.
  // Conservative true N:
  const TRUE_N =
    4 /*lookbacks*/ * 2 /*leader rule*/ * 3 /*ride offset*/ +
    TIER_ORDER.length * TIER_ORDER.length * LEAD_LAG_MAX /*lead-lag scan*/ +
    4 /*test-1 predictors*/;
  console.log(`  TRUE N (trials searched): ${TRUE_N}`);

  // ---- Deflated Sharpe on search region (daily) ----
  const dsr = computeDeflatedSharpeRatio(searchRet, { trialCount: TRUE_N, benchmarkSharpe: 0 });
  console.log(`  Deflated Sharpe: SR=${dsr.sharpe.toFixed(4)} (daily) expMax=${dsr.expectedMaxSharpe.toFixed(4)} z=${dsr.zScore.toFixed(3)} deflatedP=${dsr.deflatedProbability.toFixed(4)}`);

  // ---- Harvey-Liu haircut ----
  const hc = haircutSharpe({ observedSharpe: searchStats.sharpe, sampleCount: searchRet.length, trialCount: TRUE_N, method: "bhy" });
  console.log(`  Harvey-Liu haircut (BHY): p=${hc.pValue.toExponential(2)} adjP=${hc.adjustedPValue.toExponential(2)} haircut=${(hc.haircut * 100).toFixed(1)}% haircutSR=${hc.haircutSharpe.toFixed(4)}`);

  // ---- CPCV / PBO ----
  // Build fold returns for the rotation candidate + a set of alternatives (the search grid),
  // so PBO measures overfit of selecting rotation among its variants.
  const candidates = buildCandidateGrid();
  const pbo = estimateCscvPbo(candidates, { statistic: "sharpe", trainFraction: 0.5 });
  console.log(`  CPCV/PBO: strategies=${pbo.strategyCount} folds=${pbo.foldCount} PBO=${(pbo.pbo * 100).toFixed(1)}% medianLogit=${pbo.medianLogit.toFixed(3)}`);

  // ---- SURROGATES / PLACEBO ----
  console.log("\n" + "-".repeat(78));
  console.log(`SURROGATE / PLACEBO — ${SURROGATE_ITERS} iters x 3 nulls (real rotation NET Sharpe = ${(searchStats.sharpe * ANNUALIZE).toFixed(3)})`);
  console.log("-".repeat(78));
  const realRotSharpe = searchStats.sharpe * ANNUALIZE;
  const realMaxLL = Math.abs(maxRealLL);
  const nulls: ("phase" | "block" | "xshuffle")[] = ["phase", "block", "xshuffle"];
  const surrogateSummary: Record<string, { pPlacebo: number; pLeadLag: number; meanSharpe: number; q95Sharpe: number; meanLL: number }> = {};
  for (const nt of nulls) {
    const tStart = Date.now();
    process.stdout.write(`  [surrogate] null=${nt} running ${SURROGATE_ITERS} iters...\n`);
    const rng = seededRng(nt === "phase" ? 11 : nt === "block" ? 22 : 33);
    const sharpes: number[] = [];
    const lls: number[] = [];
    let geRot = 0;
    let geLL = 0;
    for (let it = 0; it < SURROGATE_ITERS; it += 1) {
      const s = surrogateRun(nt, rng);
      sharpes.push(s.rotSharpe);
      lls.push(Math.abs(s.maxLeadLagCorr));
      if (s.rotSharpe >= realRotSharpe) geRot += 1;
      if (Math.abs(s.maxLeadLagCorr) >= realMaxLL) geLL += 1;
      if ((it + 1) % 50 === 0)
        process.stdout.write(`    ${nt} ${it + 1}/${SURROGATE_ITERS} (${Date.now() - tStart}ms)\n`);
    }
    sharpes.sort((a, b) => a - b);
    const mean = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
    const q95 = sharpes[Math.floor(0.95 * (sharpes.length - 1))];
    const meanLL = lls.reduce((a, b) => a + b, 0) / lls.length;
    const pPlacebo = (geRot + 1) / (SURROGATE_ITERS + 1);
    const pLeadLag = (geLL + 1) / (SURROGATE_ITERS + 1);
    surrogateSummary[nt] = { pPlacebo, pLeadLag, meanSharpe: mean, q95Sharpe: q95, meanLL };
    console.log(`  null=${nt.padEnd(9)} surr Sharpe mean=${mean.toFixed(3)} q95=${q95.toFixed(3)} | p(surr>=real rotation)=${pPlacebo.toFixed(3)} | leadlag mean=${meanLL.toFixed(3)} p(surr LL>=real)=${pLeadLag.toFixed(3)}`);
  }

  // ---- CONSUME-ONCE HOLDOUT (final, once) ----
  console.log("\n" + "-".repeat(78));
  console.log("CONSUME-ONCE FINAL HOLDOUT");
  console.log("-".repeat(78));
  const guard = new FinalHoldoutGuard();
  const holdoutStats = summarizeReturnSeries(holdoutRet);
  guard.consume({ reason: "C1 rotation final verdict", gitSha: gitSha(), trialCount: TRUE_N, nowIso: new Date().toISOString() });
  console.log(`  HOLDOUT n=${holdoutRet.length}  NET daily Sharpe(ann)=${(holdoutStats.sharpe * ANNUALIZE).toFixed(3)}  compound=${(holdoutStats.compoundReturn * 100).toFixed(1)}%  consumed=${guard.isConsumed()}`);
  const bhHoldout = buyHoldBTC(plan.finalHoldout.start);
  console.log(`  HOLDOUT Buy&Hold BTC NET daily Sharpe(ann)=${(annualizedSharpe(bhHoldout)).toFixed(3)}`);

  // ---- VERDICT LOGIC ----
  const placeboFail = nulls.some((nt) => surrogateSummary[nt].pPlacebo > 0.05);
  const leadLagFail = nulls.some((nt) => surrogateSummary[nt].pLeadLag > 0.05);
  const gatePass =
    baseGate.passed &&
    dsr.deflatedProbability > 0.95 &&
    pbo.pbo < 0.5 &&
    hc.adjustedPValue < 0.05 &&
    holdoutStats.sharpe > 0;

  let verdict: "SURVIVE" | "KILL" | "PARTIAL";
  let killedBy = "";
  if (!baseGate.passed) { verdict = "KILL"; killedBy = "baseline_gate (fails to beat buy&hold/equal-weight/random/linear net of cost)"; }
  else if (placeboFail) { verdict = "KILL"; killedBy = "surrogate_placebo (machinery finds equal-or-better edge on surrogate nulls)"; }
  else if (dsr.deflatedProbability <= 0.95) { verdict = "KILL"; killedBy = `deflated_sharpe (DSR p=${dsr.deflatedProbability.toFixed(3)} <= 0.95)`; }
  else if (hc.adjustedPValue >= 0.05) { verdict = "KILL"; killedBy = `harvey_liu_haircut (adjP=${hc.adjustedPValue.toExponential(2)} >= 0.05)`; }
  else if (pbo.pbo >= 0.5) { verdict = "KILL"; killedBy = `cpcv_pbo (PBO=${(pbo.pbo * 100).toFixed(0)}% >= 50%)`; }
  else if (holdoutStats.sharpe <= 0) { verdict = "KILL"; killedBy = "consume_once_holdout (negative net Sharpe out of sample)"; }
  else if (gatePass && !placeboFail && !leadLagFail) { verdict = "SURVIVE"; }
  else { verdict = "PARTIAL"; killedBy = "passes some gates but lead-lag indistinguishable from surrogate, or mixed"; }

  console.log("\n" + "=".repeat(78));
  console.log(`VERDICT: ${verdict}`);
  if (killedBy) console.log(`KILLED BY: ${killedBy}`);
  console.log("=".repeat(78));

  // ---- write artifact ----
  const report = {
    experiment: "c1-rotation",
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    panel: { coins: PANEL.coins.length, days: T, window: [PANEL.dates[0], PANEL.dates[T - 1]] },
    tiers: TIERS,
    cost_round_trip_bps: COST_ROUND_TRIP * 1e4,
    trueN: TRUE_N,
    test1_conservation: t1,
    test2_leadlag_maxOffDiagK1: Math.abs(maxRealLL),
    test2_matrix: t2,
    test3: {
      tradingDays: rot.returns.length,
      switches: rot.switches,
      turnoverPerDay: rot.turnover,
      searchN: searchRet.length,
      searchNetSharpeAnn: searchStats.sharpe * ANNUALIZE,
      searchGrossSharpeAnn: annualizedSharpe(grossRot.searchReturns),
      searchCompound: searchStats.compoundReturn,
      holdoutN: holdoutRet.length,
      holdoutNetSharpeAnn: holdoutStats.sharpe * ANNUALIZE,
      holdoutCompound: holdoutStats.compoundReturn,
    },
    baselineGate: { passed: baseGate.passed, candidateScore: baseGate.candidateScore, comparisons: baseGate.comparisons, reasons: baseGate.reasons },
    deflatedSharpe: { sharpe: dsr.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe, zScore: dsr.zScore, deflatedProbability: dsr.deflatedProbability, trialCount: dsr.trialCount },
    haircut: hc,
    pbo: { pbo: pbo.pbo, medianLogit: pbo.medianLogit, strategyCount: pbo.strategyCount, foldCount: pbo.foldCount },
    surrogates: surrogateSummary,
    verdict,
    killedBy,
  };
  writeFileSync("output/c1-rotation/rotation-report.json", JSON.stringify(report, null, 2), "utf8");
  console.log("\nWrote output/c1-rotation/rotation-report.json");
}

// gross (no cost) rotation, split by region
function rotationStrategyGross(): { searchReturns: number[]; allReturns: number[] } {
  const all: number[] = [];
  const search: number[] = [];
  const lookback = 5;
  const plan = planHoldoutSplit({ totalRows: T, holdoutFraction: 0.15, testFraction: 0.15 });
  for (let i = lookback + 1; i + 1 < T; i += 1) {
    let leader = TIER_ORDER[0];
    let bestMom = -Infinity;
    for (const t of TIER_ORDER) {
      const s0 = tierShare[t][i - lookback];
      const s1 = tierShare[t][i];
      if (Number.isFinite(s0) && Number.isFinite(s1) && s1 - s0 > bestMom) { bestMom = s1 - s0; leader = t; }
    }
    const li = TIER_ORDER.indexOf(leader);
    const nextTier = TIER_ORDER[(li + 1) % TIER_ORDER.length];
    const r = tierRet[nextTier][i + 1];
    if (!Number.isFinite(r)) continue;
    all.push(r);
    if (i + 1 < plan.finalHoldout.start) search.push(r);
  }
  return { searchReturns: search, allReturns: all };
}

// linear baseline: long alt-tier when falling-BTC-share signal positive, else flat (net of cost on flips)
function linearBaselineReturns(): number[] {
  const alt = volWeightedAltReturn();
  const out: number[] = [];
  let prev = 0;
  for (let i = 2; i + 1 < T; i += 1) {
    const dShare = tierShare.mega[i] - tierShare.mega[i - 1];
    const signal = Number.isFinite(dShare) ? (-dShare > 0 ? 1 : 0) : 0;
    const r = alt[i + 1];
    if (!Number.isFinite(r)) continue;
    let net = signal * r;
    if (signal !== prev) net -= COST_ROUND_TRIP / 2;
    out.push(net);
    prev = signal;
  }
  return out;
}

// candidate grid for PBO: rotation with different lookbacks + naive tier holds, sliced into folds
function buildCandidateGrid(): CscvStrategyFoldReturns[] {
  const FOLDS = 10;
  const variants: { id: string; returns: number[] }[] = [];
  for (const lb of [3, 5, 8, 13]) {
    const r = rotationStrategy(tierShare, tierRet, lb).returns;
    variants.push({ id: `rot_lb${lb}`, returns: r });
  }
  // static tier-hold baselines as competing strategies
  for (const t of TIER_ORDER) {
    const r: number[] = [];
    for (let i = 7; i + 1 < T; i += 1) {
      const x = tierRet[t][i + 1];
      if (Number.isFinite(x)) r.push(x);
    }
    variants.push({ id: `hold_${t}`, returns: r });
  }
  // align lengths to the shortest, then chunk into folds
  const minLen = Math.min(...variants.map((v) => v.returns.length));
  const foldLen = Math.floor(minLen / FOLDS);
  return variants.map((v) => {
    const folds: number[][] = [];
    for (let f = 0; f < FOLDS; f += 1) {
      folds.push(v.returns.slice(f * foldLen, (f + 1) * foldLen));
    }
    return { id: v.id, folds };
  });
}

main();
