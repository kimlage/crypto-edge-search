/**
 * FRONT C2 — Dominance CYCLE / periodicity test.
 * =============================================================================
 * QUESTION: Does capital/dominance rotate CYCLICALLY among crypto tiers (an
 * exploitable rotation period), or does dominance just drift / jump acyclically?
 *
 * This is the user's "cycles" premise, tested honestly on REAL Binance data
 * (30-coin panel, 2020-06 .. 2026-05, daily closes + daily quote-volume).
 *
 * THREE LEGS (per the brief):
 *  (1) PERIODICITY — build the dominance time series (which TIER is dominant per
 *      period), then run a periodogram (FFT/DFT) + autocorrelation on it. Is there
 *      a characteristic rotation period, or is it white-noise / persistent?
 *  (2) PREMISE TEST (a la round-4 WF-A) — does the CURRENT dominant tier predict
 *      the NEXT dominant tier better than a uniform/random null? (transition matrix
 *      log-likelihood vs uniform null; plus a directional "follow-the-leader" hit
 *      rate net of cost).
 *  (3) TRADEABLE — a rotation strategy (hold currently-/next-predicted-dominant
 *      tier) vs equal-weight and buy-and-hold (BTC), NET of realistic taker cost
 *      (4bps/side, 8bps round-trip on every position change), through the COMMITTED
 *      gates + SURROGATE/PLACEBO nulls + consume-once HOLDOUT.
 *
 * DOMINANCE defined TWO independent ways (brief): (a) highest trailing-k return,
 * (b) highest volume share. Both are tested.
 *
 * SURROGATES (the methodological hero): the IDENTICAL machinery is rerun on
 *   - phase-randomized panels (preserve each coin's spectrum/acf, destroy phase)
 *   - block-bootstrap panels (preserve short-range autocorr, destroy long structure)
 *   - CROSS-SECTIONALLY-SHUFFLED panels (permute which coin gets which return path
 *     per period -> destroys genuine lead-lag / rotation, keeps marginals).
 * If the machinery finds equal-or-better cycle/edge on surrogates, the signal is
 * an artifact.
 *
 * GATES are imported from src/lib/training/ (NOT modified):
 *   statistical-validation: computeDeflatedSharpeRatio, summarizeReturnSeries,
 *     estimateCscvPbo, normalCdf
 *   significance/baselines:  evaluateBaselineGate, buildBuyAndHoldBaseline,
 *     buildRandomLotteryBaseline, baselineScoreFromReturns
 *   significance/haircut:    haircutSharpe
 *   significance/holdout:    planHoldoutSplit, FinalHoldoutGuard
 *
 * COST: 4bps/side taker perp => 8bps round-trip on EVERY tier change. Turnover
 * reported. A gross-only signal is a KILL.
 *
 * Run:
 *  PATH=<codex-node-bin>:$PATH node_modules/.bin/tsx scripts/front-c2/run-dominance-cycle.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
  estimateCscvPbo,
  normalCdf,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  evaluateBaselineGate,
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  baselineScoreFromReturns,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import { planHoldoutSplit, FinalHoldoutGuard } from "../../src/lib/significance/holdout";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "output", "front-c2");
mkdirSync(OUT_DIR, { recursive: true });

const TAKER_BPS_PER_SIDE = 4; // perp taker, one side
const ROUND_TRIP_COST = (2 * TAKER_BPS_PER_SIDE) / 10_000; // 8 bps = 0.0008 on every tier change
const PERIOD_DAYS = 7; // weekly rebalance/period (enough rotation events, lower noise than daily)
const TRAIL_K = 4; // trailing-k periods (~1 month) for return-dominance ranking
const TRADING_DAYS_PER_YEAR = 365; // crypto trades 365
const PERIODS_PER_YEAR = TRADING_DAYS_PER_YEAR / PERIOD_DAYS;
const N_SURROGATES = 200; // per surrogate family
const SEED = 20260531;

// ----------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ----------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

const log: string[] = [];
function say(s = ""): void {
  log.push(s);
  console.log(s);
}

// ----------------------------------------------------------------------------
// Load real panel
// ----------------------------------------------------------------------------
interface DailyCloses {
  source: string;
  realData: boolean;
  dates: string[];
  closes: Record<string, (number | null)[]>;
}
interface DailyVolume {
  source: string;
  realData: boolean;
  dates: string[];
  volume: Record<string, (number | null)[]>;
}

const closesDoc: DailyCloses = JSON.parse(
  readFileSync(join(ROOT, "output", "crossxs", "daily-closes.json"), "utf8"),
);
const volPath = join(ROOT, "output", "front-c2", "daily-volume.json");
const volDoc: DailyVolume | null = existsSync(volPath)
  ? JSON.parse(readFileSync(volPath, "utf8"))
  : null;

const DATES = closesDoc.dates;
const COINS = Object.keys(closesDoc.closes);
const T = DATES.length;

// ----------------------------------------------------------------------------
// Tier definition (stable, economically meaningful size/liquidity tiers).
// Rotation/"alt-season" lore is about money flowing MAJORS -> LARGE -> MID, so
// the tier scheme matches the premise being tested. A coin is assigned to its
// tier for the whole sample (stable membership => clean transition matrix).
// ----------------------------------------------------------------------------
const TIER_OF: Record<string, string> = {};
const TIER_MEMBERS: Record<string, string[]> = { MAJ: [], LARGE: [], MID: [] };
const MAJ = new Set(["BTC", "ETH"]);
const LARGE = new Set([
  "BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "LTC", "TRX", "BCH",
]);
for (const c of COINS) {
  const tier = MAJ.has(c) ? "MAJ" : LARGE.has(c) ? "LARGE" : "MID";
  TIER_OF[c] = tier;
  TIER_MEMBERS[tier].push(c);
}
const TIERS = ["MAJ", "LARGE", "MID"];
const TIER_IDX = new Map(TIERS.map((t, i) => [t, i]));

// ----------------------------------------------------------------------------
// Build per-period (weekly) data: tier returns, coin returns, volume shares.
// A period is PERIOD_DAYS calendar days. Period return for a coin uses the close
// at the period boundary. Tier return = equal-weight of its available coins.
// ----------------------------------------------------------------------------
interface Panel {
  periodDates: string[]; // end date of each period
  coinPeriodRet: Record<string, (number | null)[]>; // per coin, per period simple return
  tierPeriodRet: number[][]; // [period][tier] equal-weight tier return (NaN if no members)
  tierVolShare: number[][]; // [period][tier] share of total quote-volume in the period
}

function buildPanel(closes: Record<string, (number | null)[]>): Panel {
  // period boundaries: indices 0, P, 2P, ...
  const bounds: number[] = [];
  for (let i = 0; i < T; i += PERIOD_DAYS) bounds.push(i);
  if (bounds[bounds.length - 1] !== T - 1) bounds.push(T - 1);
  const nP = bounds.length - 1;

  const periodDates: string[] = [];
  const coinPeriodRet: Record<string, (number | null)[]> = {};
  for (const c of COINS) coinPeriodRet[c] = [];

  for (let p = 0; p < nP; p += 1) {
    const a = bounds[p];
    const b = bounds[p + 1];
    periodDates.push(DATES[b]);
    for (const c of COINS) {
      const pa = closes[c][a];
      const pb = closes[c][b];
      if (pa != null && pb != null && Number.isFinite(pa) && Number.isFinite(pb) && pa > 0) {
        coinPeriodRet[c].push(pb / pa - 1);
      } else {
        coinPeriodRet[c].push(null);
      }
    }
  }

  // tier equal-weight period returns
  const tierPeriodRet: number[][] = [];
  for (let p = 0; p < nP; p += 1) {
    const row: number[] = [];
    for (const tier of TIERS) {
      const vals: number[] = [];
      for (const c of TIER_MEMBERS[tier]) {
        const r = coinPeriodRet[c][p];
        if (r != null && Number.isFinite(r)) vals.push(r);
      }
      row.push(vals.length > 0 ? vals.reduce((s, x) => s + x, 0) / vals.length : NaN);
    }
    tierPeriodRet.push(row);
  }

  // tier volume share per period (sum quote-vol over the period window)
  const tierVolShare: number[][] = [];
  for (let p = 0; p < nP; p += 1) {
    const a = bounds[p];
    const b = bounds[p + 1];
    const tierVol = [0, 0, 0];
    let total = 0;
    if (volDoc) {
      for (const c of COINS) {
        let v = 0;
        for (let i = a + 1; i <= b; i += 1) {
          const x = volDoc.volume[c]?.[i];
          if (x != null && Number.isFinite(x)) v += x;
        }
        tierVol[TIER_IDX.get(TIER_OF[c])!] += v;
        total += v;
      }
    }
    tierVolShare.push(total > 0 ? tierVol.map((v) => v / total) : [NaN, NaN, NaN]);
  }

  return { periodDates, coinPeriodRet, tierPeriodRet, tierVolShare };
}

// ----------------------------------------------------------------------------
// Dominance series: per period, which TIER is dominant?
//  - return-dominance: highest TRAILING-K cumulative tier return (causal; uses
//    periods [p-K+1 .. p], known at end of period p -> predicts/holds period p+1)
//  - volume-dominance: highest volume share in period p
// Returns an array of tier-indices (or -1 if undefined).
// ----------------------------------------------------------------------------
function dominanceByReturn(tierRet: number[][], k: number): number[] {
  const nP = tierRet.length;
  const dom: number[] = [];
  for (let p = 0; p < nP; p += 1) {
    if (p < k - 1) {
      dom.push(-1);
      continue;
    }
    let best = -1;
    let bestVal = -Infinity;
    for (let ti = 0; ti < TIERS.length; ti += 1) {
      let cum = 1;
      let ok = true;
      for (let j = p - k + 1; j <= p; j += 1) {
        const r = tierRet[j][ti];
        if (!Number.isFinite(r)) {
          ok = false;
          break;
        }
        cum *= 1 + r;
      }
      if (ok && cum > bestVal) {
        bestVal = cum;
        best = ti;
      }
    }
    dom.push(best);
  }
  return dom;
}

function dominanceByVolume(tierVolShare: number[][]): number[] {
  return tierVolShare.map((row) => {
    let best = -1;
    let bestVal = -Infinity;
    for (let ti = 0; ti < row.length; ti += 1) {
      if (Number.isFinite(row[ti]) && row[ti] > bestVal) {
        bestVal = row[ti];
        best = ti;
      }
    }
    return best;
  });
}

// ----------------------------------------------------------------------------
// (1) PERIODICITY: periodogram + autocorrelation of a dominance series.
// We encode the categorical dominance series as a set of one-hot indicator
// series (one per tier) and analyze each, plus a "switch" series (1 when
// dominance changes period-to-period). The periodogram peak (period in periods)
// and ACF tell us if rotation is cyclic, persistent, or white.
// ----------------------------------------------------------------------------
function autocorr(x: number[], maxLag: number): number[] {
  const n = x.length;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  let denom = 0;
  for (const v of x) denom += (v - mean) ** 2;
  const acf: number[] = [];
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let num = 0;
    for (let i = 0; i < n - lag; i += 1) num += (x[i] - mean) * (x[i + lag] - mean);
    acf.push(denom > 0 ? num / denom : 0);
  }
  return acf;
}

// DFT periodogram. Returns [{periodInPeriods, power}], sorted by power desc.
function periodogram(x: number[]): { period: number; freq: number; power: number }[] {
  const n = x.length;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const xc = x.map((v) => v - mean);
  const out: { period: number; freq: number; power: number }[] = [];
  // frequencies k=1..n/2
  for (let k = 1; k <= Math.floor(n / 2); k += 1) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let t = 0; t < n; t += 1) {
      re += xc[t] * Math.cos(w * t);
      im -= xc[t] * Math.sin(w * t);
    }
    const power = (re * re + im * im) / n;
    out.push({ period: n / k, freq: k / n, power });
  }
  return out.sort((p, q) => q.power - p.power);
}

// Fisher's g-test for a significant periodogram peak vs white noise.
// g = maxPower / sum(power). p ~= m * (1-g)^(m-1) for the largest ordinate.
function fisherG(powers: number[]): { g: number; pValue: number; m: number } {
  const m = powers.length;
  const total = powers.reduce((s, v) => s + v, 0);
  const maxP = Math.max(...powers);
  const g = total > 0 ? maxP / total : 0;
  // upper-tail p-value (Fisher 1929), first-order term (dominant)
  const p = Math.min(1, m * Math.pow(1 - g, m - 1));
  return { g, pValue: p, m };
}

interface PeriodicityResult {
  switchRate: number; // fraction of periods where dominance changed
  acf1: number; // lag-1 autocorrelation of the dominant-tier-index series
  acfAtPeak: number;
  topPeriods: { period: number; power: number }[];
  fisherG: number;
  fisherP: number;
  dominantSpectralPeriod: number | null; // in periods (weeks); null if not significant
}

function analyzePeriodicity(dom: number[]): PeriodicityResult {
  const valid = dom.filter((d) => d >= 0);
  // switch series
  let switches = 0;
  const switchSeries: number[] = [];
  for (let i = 1; i < valid.length; i += 1) {
    const s = valid[i] !== valid[i - 1] ? 1 : 0;
    switchSeries.push(s);
    switches += s;
  }
  const switchRate = switchSeries.length > 0 ? switches / switchSeries.length : 0;

  // analyze the (numeric) dominant-index series + one-hot indicators; take the
  // strongest periodogram across them (most generous to the cycle hypothesis).
  const series: number[][] = [valid.map((d) => d)];
  for (let ti = 0; ti < TIERS.length; ti += 1) series.push(valid.map((d) => (d === ti ? 1 : 0)));
  series.push([0, ...switchSeries]); // switch series

  let bestFisherP = 1;
  let bestG = 0;
  let bestTop: { period: number; power: number }[] = [];
  let bestPeriod: number | null = null;
  for (const s of series) {
    if (new Set(s).size < 2) continue; // constant -> skip
    const pg = periodogram(s);
    const fg = fisherG(pg.map((p) => p.power));
    if (fg.pValue < bestFisherP) {
      bestFisherP = fg.pValue;
      bestG = fg.g;
      bestTop = pg.slice(0, 5).map((p) => ({ period: p.period, power: p.power }));
      bestPeriod = fg.pValue < 0.05 ? pg[0].period : null;
    }
  }

  const acf = autocorr(valid.map((d) => d), Math.min(52, valid.length - 2));
  const acf1 = acf[1] ?? 0;
  const acfAtPeak = bestPeriod ? acf[Math.round(bestPeriod)] ?? 0 : 0;

  return {
    switchRate,
    acf1,
    acfAtPeak,
    topPeriods: bestTop,
    fisherG: bestG,
    fisherP: bestFisherP,
    dominantSpectralPeriod: bestPeriod,
  };
}

// ----------------------------------------------------------------------------
// (2) PREMISE TEST: does current dominant tier predict next? Transition matrix
// log-likelihood vs uniform null + directional hit-rate.
// ----------------------------------------------------------------------------
interface PremiseResult {
  counts: number[][];
  rowProbs: number[][];
  transitions: number;
  llTransition: number;
  llUniform: number;
  llRatio: number; // 2*(llTransition - llUniform) ~ chi2 (df=(K-1)^2)
  chi2P: number;
  persistenceHitRate: number; // P(next == current) -- "stay" predictor
  argmaxHitRate: number; // hit rate of "predict the most-likely next given current"
}

function chi2SurvivalApprox(x: number, df: number): number {
  // Wilson-Hilferty approximation for chi-square upper tail.
  if (x <= 0) return 1;
  const t = Math.pow(x / df, 1 / 3);
  const m = 1 - 2 / (9 * df);
  const s = Math.sqrt(2 / (9 * df));
  const z = (t - m) / s;
  return 1 - normalCdf(z);
}

function analyzePremise(dom: number[]): PremiseResult {
  const K = TIERS.length;
  const counts = Array.from({ length: K }, () => new Array(K).fill(0));
  const seq: number[] = [];
  for (const d of dom) if (d >= 0) seq.push(d);
  let transitions = 0;
  let persistHits = 0;
  for (let i = 1; i < seq.length; i += 1) {
    counts[seq[i - 1]][seq[i]] += 1;
    transitions += 1;
    if (seq[i] === seq[i - 1]) persistHits += 1;
  }
  const rowProbs = counts.map((row) => {
    const s = row.reduce((a, b) => a + b, 0);
    return s > 0 ? row.map((c) => c / s) : row.map(() => 1 / K);
  });

  // log-likelihood under the fitted transition matrix vs uniform (1/K)
  let llT = 0;
  let llU = 0;
  let argmaxHits = 0;
  for (let i = 1; i < seq.length; i += 1) {
    const from = seq[i - 1];
    const to = seq[i];
    const pT = Math.max(1e-9, rowProbs[from][to]);
    llT += Math.log(pT);
    llU += Math.log(1 / K);
    // argmax next-tier predictor
    let pred = 0;
    let best = -1;
    for (let j = 0; j < K; j += 1) {
      if (rowProbs[from][j] > best) {
        best = rowProbs[from][j];
        pred = j;
      }
    }
    if (pred === to) argmaxHits += 1;
  }
  const llRatio = 2 * (llT - llU);
  const df = (K - 1) * (K - 1);
  const chi2P = chi2SurvivalApprox(llRatio, df);

  return {
    counts,
    rowProbs,
    transitions,
    llTransition: llT,
    llUniform: llU,
    llRatio,
    chi2P,
    persistenceHitRate: transitions > 0 ? persistHits / transitions : 0,
    argmaxHitRate: transitions > 0 ? argmaxHits / transitions : 0,
  };
}

// ----------------------------------------------------------------------------
// (3) TRADEABLE rotation strategy. At the end of period p we know the dominance
// label (causal); we hold the chosen tier's equal-weight basket for period p+1.
// Two variants:
//   - "hold-current": hold the currently-dominant tier next period (momentum/persistence)
//   - "hold-predicted": hold the argmax-next tier from the in-sample transition matrix
// Cost: when the held tier changes, pay ROUND_TRIP_COST (exit old + enter new).
// Returns the per-period NET return series + turnover.
// ----------------------------------------------------------------------------
interface StrategyRun {
  netReturns: number[];
  grossReturns: number[];
  turnover: number; // fraction of periods with a tier change
  heldTiers: number[];
}

function runRotation(
  dom: number[],
  tierRet: number[][],
  mode: "hold-current" | "hold-predicted",
  rowProbs?: number[][],
): StrategyRun {
  const net: number[] = [];
  const gross: number[] = [];
  const held: number[] = [];
  let prevTier = -1;
  let changes = 0;
  let periods = 0;
  for (let p = 0; p < dom.length - 1; p += 1) {
    const sig = dom[p];
    if (sig < 0) continue;
    let target = sig;
    if (mode === "hold-predicted" && rowProbs) {
      let best = -1;
      for (let j = 0; j < TIERS.length; j += 1) {
        if (rowProbs[sig][j] > best) {
          best = rowProbs[sig][j];
          target = j;
        }
      }
    }
    const r = tierRet[p + 1][target];
    if (!Number.isFinite(r)) continue;
    const changed = prevTier !== -1 && target !== prevTier ? 1 : 0;
    const cost = changed ? ROUND_TRIP_COST : prevTier === -1 ? ROUND_TRIP_COST / 2 : 0;
    gross.push(r);
    net.push(r - cost);
    held.push(target);
    if (changed) changes += 1;
    periods += 1;
    prevTier = target;
  }
  return {
    netReturns: net,
    grossReturns: gross,
    turnover: periods > 0 ? changes / periods : 0,
    heldTiers: held,
  };
}

// Equal-weight benchmark: hold all 3 tiers equally (rebalance each period, pay
// a small rebalance cost proportional to drift; approximate with one round-trip
// amortized -> we charge nothing for the static EW of tiers to be generous to
// the benchmark, then ALSO report a turnover-matched cost. EW of all coins.)
function equalWeightBenchmark(tierRet: number[][]): number[] {
  const out: number[] = [];
  for (let p = 1; p < tierRet.length; p += 1) {
    const vals = tierRet[p].filter((r) => Number.isFinite(r));
    out.push(vals.length > 0 ? vals.reduce((s, x) => s + x, 0) / vals.length : 0);
  }
  return out;
}

// Buy-and-hold BTC (the cost-free benchmark every active strat must beat).
function buyHoldBtc(): number[] {
  const out: number[] = [];
  const c = closesDoc.closes["BTC"];
  for (let i = PERIOD_DAYS; i < T; i += PERIOD_DAYS) {
    const a = c[i - PERIOD_DAYS];
    const b = c[i];
    if (a != null && b != null && a > 0) out.push(b / a - 1);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Annualized Sharpe from per-period returns.
// ----------------------------------------------------------------------------
function annSharpe(stats: { sharpe: number }): number {
  return stats.sharpe * Math.sqrt(PERIODS_PER_YEAR);
}

// ----------------------------------------------------------------------------
// SURROGATES. Each returns a coin-close matrix (or directly a tier-return matrix)
// with the SAME shape as real, destroying a specific structure.
// We surrogate at the PERIOD-RETURN level (per coin), then rebuild tiers/dominance.
// ----------------------------------------------------------------------------
function phaseRandomizeSeries(x: number[], rng: () => number): number[] {
  // FFT-based phase randomization preserving power spectrum (real series).
  const n = x.length;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const xc = x.map((v) => v - mean);
  // forward DFT
  const re = new Array(n).fill(0);
  const im = new Array(n).fill(0);
  for (let k = 0; k < n; k += 1) {
    for (let t = 0; t < n; t += 1) {
      const w = (-2 * Math.PI * k * t) / n;
      re[k] += xc[t] * Math.cos(w);
      im[k] += xc[t] * Math.sin(w);
    }
  }
  // randomize phases (keep magnitude), preserve conjugate symmetry
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k += 1) {
    const mag = Math.hypot(re[k], im[k]);
    const ph = 2 * Math.PI * rng();
    re[k] = mag * Math.cos(ph);
    im[k] = mag * Math.sin(ph);
    const j = (n - k) % n;
    re[j] = re[k];
    im[j] = -im[k];
  }
  // inverse DFT (real part)
  const out = new Array(n).fill(0);
  for (let t = 0; t < n; t += 1) {
    let s = 0;
    for (let k = 0; k < n; k += 1) {
      const w = (2 * Math.PI * k * t) / n;
      s += re[k] * Math.cos(w) - im[k] * Math.sin(w);
    }
    out[t] = s / n + mean;
  }
  return out;
}

function blockShuffleSeries(x: number[], block: number, rng: () => number): number[] {
  const n = x.length;
  const blocks: number[][] = [];
  for (let i = 0; i < n; i += block) blocks.push(x.slice(i, Math.min(i + block, n)));
  // Fisher-Yates on block order
  for (let i = blocks.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }
  return blocks.flat().slice(0, n);
}

// Build a surrogate coinPeriodRet by transforming each coin's REAL period-return
// series (ignoring nulls -> only transform the contiguous valid tail).
function surrogateCoinReturns(
  real: Record<string, (number | null)[]>,
  kind: "phase" | "block" | "xshuffle",
  rng: () => number,
): Record<string, (number | null)[]> {
  const nP = real[COINS[0]].length;
  const out: Record<string, (number | null)[]> = {};

  if (kind === "xshuffle") {
    // CROSS-SECTIONAL shuffle: for each period, permute which coin gets which
    // return among the coins that HAVE a return that period. Destroys lead-lag /
    // rotation, keeps each period's cross-sectional marginal distribution.
    for (const c of COINS) out[c] = new Array(nP).fill(null);
    for (let p = 0; p < nP; p += 1) {
      const present: string[] = [];
      const vals: number[] = [];
      for (const c of COINS) {
        const r = real[c][p];
        if (r != null && Number.isFinite(r)) {
          present.push(c);
          vals.push(r);
        }
      }
      // shuffle vals
      for (let i = vals.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [vals[i], vals[j]] = [vals[j], vals[i]];
      }
      present.forEach((c, i) => {
        out[c][p] = vals[i];
      });
    }
    return out;
  }

  // phase / block: transform each coin's own valid series in place (preserves
  // its spectrum/autocorr, destroys cross-asset phase alignment & long structure).
  for (const c of COINS) {
    const series = real[c];
    const firstValid = series.findIndex((v) => v != null && Number.isFinite(v));
    const valid: number[] = [];
    for (let i = firstValid; i < nP; i += 1) {
      const v = series[i];
      valid.push(v != null && Number.isFinite(v) ? v : 0);
    }
    const transformed =
      kind === "phase" ? phaseRandomizeSeries(valid, rng) : blockShuffleSeries(valid, 8, rng);
    const arr: (number | null)[] = new Array(nP).fill(null);
    for (let i = 0; i < valid.length; i += 1) arr[firstValid + i] = transformed[i];
    out[c] = arr;
  }
  return out;
}

function tierReturnsFromCoinReturns(coinRet: Record<string, (number | null)[]>): number[][] {
  const nP = coinRet[COINS[0]].length;
  const tierPeriodRet: number[][] = [];
  for (let p = 0; p < nP; p += 1) {
    const row: number[] = [];
    for (const tier of TIERS) {
      const vals: number[] = [];
      for (const c of TIER_MEMBERS[tier]) {
        const r = coinRet[c][p];
        if (r != null && Number.isFinite(r)) vals.push(r);
      }
      row.push(vals.length > 0 ? vals.reduce((s, x) => s + x, 0) / vals.length : NaN);
    }
    tierPeriodRet.push(row);
  }
  return tierPeriodRet;
}

// ----------------------------------------------------------------------------
// Aggregate per-period returns to daily blocks if too long (summarizeReturnSeries
// stack-overflows past ~1e5). Our period series are ~300 -> safe. No-op guard.
// ----------------------------------------------------------------------------
function safeSummarize(returns: number[]) {
  if (returns.length > 90_000) {
    const blocks: number[] = [];
    for (let i = 0; i < returns.length; i += 7) {
      const chunk = returns.slice(i, i + 7);
      blocks.push(chunk.reduce((s, x) => s + x, 0));
    }
    return summarizeReturnSeries(blocks);
  }
  return summarizeReturnSeries(returns);
}

// ============================================================================
// MAIN
// ============================================================================
function main(): void {
  const sha = gitSha();
  say("=".repeat(78));
  say("FRONT C2 — DOMINANCE CYCLE / PERIODICITY TEST");
  say("=".repeat(78));
  say(`Data: ${closesDoc.source} (realData=${closesDoc.realData}); volume: ${volDoc ? "binance" : "UNAVAILABLE"}`);
  say(`Panel: ${COINS.length} coins, ${T} daily rows ${DATES[0]}..${DATES[T - 1]}`);
  say(`Tiers: MAJ=${TIER_MEMBERS.MAJ.length} LARGE=${TIER_MEMBERS.LARGE.length} MID=${TIER_MEMBERS.MID.length}`);
  say(`Period=${PERIOD_DAYS}d, trailingK=${TRAIL_K}, cost=${(ROUND_TRIP_COST * 1e4).toFixed(0)}bps round-trip/change, ${PERIODS_PER_YEAR.toFixed(1)} periods/yr`);
  say(`git ${sha}`);
  say("");

  const panel = buildPanel(closesDoc.closes);
  const nP = panel.periodDates.length;
  say(`Built ${nP} weekly periods.`);

  // ---- Honest N: count the configurations the search/premise effectively tried.
  // We test 2 dominance defs x {periodicity, premise, 2 strategy modes} plus
  // surrogate families. Honest N for the multiple-testing haircut/DSR = number of
  // distinct strategy configurations we look at to pick the champion.
  // dominance defs (2) x strategy modes (2) x trailingK we *could* have scanned.
  // We fixed K=4 but acknowledge we eyeballed a small grid -> be conservative.
  const honestN = 2 /*dom defs*/ * 2 /*modes*/ * 4 /*plausible K in {2,3,4,6}*/;
  say(`Honest N (configs the champion is selected from): ${honestN}`);
  say("");

  // ========================================================================
  // Dominance series (two definitions)
  // ========================================================================
  const domRet = dominanceByReturn(panel.tierPeriodRet, TRAIL_K);
  const domVol = volDoc ? dominanceByVolume(panel.tierVolShare) : [];

  const labelDist = (dom: number[]) => {
    const c = [0, 0, 0];
    for (const d of dom) if (d >= 0) c[d] += 1;
    const tot = c.reduce((a, b) => a + b, 0);
    return TIERS.map((t, i) => `${t}=${((c[i] / tot) * 100).toFixed(0)}%`).join(" ");
  };
  say("DOMINANCE LABEL DISTRIBUTION");
  say(`  return-dominant (trailing-${TRAIL_K}): ${labelDist(domRet)}`);
  if (volDoc) say(`  volume-dominant:            ${labelDist(domVol)}`);
  say("");

  // ========================================================================
  // (1) PERIODICITY
  // ========================================================================
  say("-".repeat(78));
  say("(1) PERIODICITY — periodogram (Fisher g-test) + autocorrelation");
  say("-".repeat(78));
  const perRet = analyzePeriodicity(domRet);
  say("RETURN-DOMINANCE series:");
  say(`  switch rate (dominance changes/period): ${(perRet.switchRate * 100).toFixed(1)}%`);
  say(`  lag-1 autocorr of dominant-tier index : ${perRet.acf1.toFixed(3)}`);
  say(`  top periodogram periods (weeks)        : ${perRet.topPeriods.map((p) => p.period.toFixed(1)).join(", ")}`);
  say(`  Fisher g=${perRet.fisherG.toFixed(3)} p=${perRet.fisherP.toFixed(3)} -> dominant spectral period: ${perRet.dominantSpectralPeriod ? perRet.dominantSpectralPeriod.toFixed(1) + " wk" : "NONE (p>=0.05)"}`);
  let perVol: PeriodicityResult | null = null;
  if (volDoc) {
    perVol = analyzePeriodicity(domVol);
    say("VOLUME-DOMINANCE series:");
    say(`  switch rate: ${(perVol.switchRate * 100).toFixed(1)}%  lag-1 acf: ${perVol.acf1.toFixed(3)}`);
    say(`  Fisher g=${perVol.fisherG.toFixed(3)} p=${perVol.fisherP.toFixed(3)} -> dominant spectral period: ${perVol.dominantSpectralPeriod ? perVol.dominantSpectralPeriod.toFixed(1) + " wk" : "NONE (p>=0.05)"}`);
  }
  say("");

  // ========================================================================
  // (2) PREMISE TEST
  // ========================================================================
  say("-".repeat(78));
  say("(2) PREMISE — current dominant tier predicts next? (transition matrix vs uniform)");
  say("-".repeat(78));
  const premRet = analyzePremise(domRet);
  const showMatrix = (pr: PremiseResult) => {
    say(`  transition matrix P(next|current), rows=${TIERS.join("/")}:`);
    for (let i = 0; i < TIERS.length; i += 1) {
      say(`    ${TIERS[i]} -> ${pr.rowProbs[i].map((v, j) => `${TIERS[j]}:${v.toFixed(2)}`).join("  ")}  (n=${premRet.counts[i].reduce((a, b) => a + b, 0)})`);
    }
  };
  showMatrix(premRet);
  say(`  transitions=${premRet.transitions}  LL(transition)=${premRet.llTransition.toFixed(1)}  LL(uniform)=${premRet.llUniform.toFixed(1)}`);
  say(`  2*dLL=${premRet.llRatio.toFixed(2)} ~ chi2(df=${(TIERS.length - 1) ** 2})  p=${premRet.chi2P.toExponential(2)}`);
  say(`  persistence hit-rate P(next==current)=${(premRet.persistenceHitRate * 100).toFixed(1)}%  (random=${(100 / TIERS.length).toFixed(0)}%)`);
  say(`  argmax-next predictor hit-rate       =${(premRet.argmaxHitRate * 100).toFixed(1)}%`);
  let premVol: PremiseResult | null = null;
  if (volDoc) {
    premVol = analyzePremise(domVol);
    say("  [volume-dominance] argmax hit-rate=" + (premVol.argmaxHitRate * 100).toFixed(1) + "%  2*dLL=" + premVol.llRatio.toFixed(2) + " p=" + premVol.chi2P.toExponential(2));
  }
  say("");

  // ========================================================================
  // (3) TRADEABLE — pick champion by IN-SAMPLE (search slice) Sharpe, then gate
  // ========================================================================
  say("-".repeat(78));
  say("(3) TRADEABLE rotation strategy — holdout, gates, surrogates");
  say("-".repeat(78));

  // Holdout split on PERIODS (consume-once vault = most-recent 15%).
  const split = planHoldoutSplit({ totalRows: nP, holdoutFraction: 0.15, testFraction: 0.15 });
  say(`  Holdout split: search [0,${split.search.end}) test [${split.test.start},${split.test.end}) VAULT [${split.finalHoldout.start},${split.finalHoldout.end}) (${split.finalHoldout.rows} periods)`);

  // Fit transition matrix ONLY on the search slice (no leakage), for hold-predicted.
  const domRetSearch = domRet.slice(0, split.search.end);
  const premSearch = analyzePremise(domRetSearch);

  // Candidate strategies (the search universe over which we pick a champion).
  // The CHAMPION is chosen ONLY from genuine RETURN-ROTATION strategies: that is
  // the actual "cycle/rotation" hypothesis the user is asking about, and it is the
  // only definition for which the surrogate nulls are apples-to-apples (we can
  // destroy the return-path structure but cannot synthesize surrogate VOLUME).
  // The volume-dominance leg is reported separately as a DESCRIPTIVE diagnostic
  // (below) because, on this panel, it degenerates to ~always-MAJ (93% of weeks)
  // i.e. it is buy-and-hold-majors, NOT a rotation strategy.
  type Cand = { id: string; dom: number[]; mode: "hold-current" | "hold-predicted"; rowProbs?: number[][] };
  const candidates: Cand[] = [
    { id: "ret_hold_current", dom: domRet, mode: "hold-current" },
    { id: "ret_hold_predicted", dom: domRet, mode: "hold-predicted", rowProbs: premSearch.rowProbs },
  ];

  function runBlock(c: Cand, lo: number, hi: number): StrategyRun {
    // restrict dominance + tier returns to [lo,hi) for an honest per-block backtest
    const domSlice = c.dom.slice(lo, hi);
    const tierSlice = panel.tierPeriodRet.slice(lo, hi);
    return runRotation(domSlice, tierSlice, c.mode, c.rowProbs);
  }

  say("  CANDIDATE search-slice performance (net, annualized Sharpe):");
  const scored = candidates.map((c) => {
    const run = runBlock(c, 0, split.search.end);
    const stats = safeSummarize(run.netReturns);
    const aSh = annSharpe(stats);
    say(`    ${c.id.padEnd(20)} netSharpe(ann)=${aSh.toFixed(2)}  turnover=${(run.turnover * 100).toFixed(0)}%  n=${run.netReturns.length}`);
    return { c, run, aSh, stats };
  });
  scored.sort((a, b) => b.aSh - a.aSh);
  const champion = scored[0];
  say(`  >> CHAMPION (by search Sharpe): ${champion.c.id}`);

  // Descriptive-only: volume-dominance rotation (degenerate ~always-MAJ on this panel).
  let volDiag: { searchSharpe: number; turnover: number; degenerate: boolean } | null = null;
  if (volDoc) {
    const volCand: Cand = { id: "vol_hold_current", dom: domVol, mode: "hold-current" };
    const volRun = runBlock(volCand, 0, split.search.end);
    const volTurn = volRun.turnover;
    volDiag = { searchSharpe: annSharpe(safeSummarize(volRun.netReturns)), turnover: volTurn, degenerate: volTurn < 0.10 };
    say(`  [descriptive] volume-dominance rotation: searchSharpe(ann)=${volDiag.searchSharpe.toFixed(2)} turnover=${(volTurn * 100).toFixed(0)}% -> ${volDiag.degenerate ? "DEGENERATE (~always-MAJ buy&hold, NOT rotation; excluded from champion)" : "non-trivial"}`);
  }
  say("");

  // ---- Champion: TEST slice (posterior audit) and VAULT (consume-once).
  const champTest = runBlock(champion.c, split.test.start, split.test.end);
  const champVault = runBlock(champion.c, split.finalHoldout.start, split.finalHoldout.end);
  const champFull = runBlock(champion.c, 0, nP);

  const testStats = safeSummarize(champTest.netReturns);
  const vaultStats = safeSummarize(champVault.netReturns);

  say(`  Champion TEST slice : netSharpe(ann)=${annSharpe(testStats).toFixed(2)}  compound=${(testStats.compoundReturn * 100).toFixed(1)}%  n=${champTest.netReturns.length}`);
  say(`  Champion VAULT slice: netSharpe(ann)=${annSharpe(vaultStats).toFixed(2)}  compound=${(vaultStats.compoundReturn * 100).toFixed(1)}%  n=${champVault.netReturns.length}  turnover=${(champVault.turnover * 100).toFixed(0)}%`);

  // ---- Benchmarks over the VAULT window.
  const ewFull = equalWeightBenchmark(panel.tierPeriodRet);
  const ewVault = ewFull.slice(split.finalHoldout.start, split.finalHoldout.end - 1);
  const btcFull = buyHoldBtc();
  const btcVault = btcFull.slice(split.finalHoldout.start, Math.min(btcFull.length, split.finalHoldout.end - 1));
  const ewStats = safeSummarize(ewVault);
  const btcStats = safeSummarize(btcVault);
  say(`  Benchmark VAULT equal-weight: netSharpe(ann)=${annSharpe(ewStats).toFixed(2)} compound=${(ewStats.compoundReturn * 100).toFixed(1)}%`);
  say(`  Benchmark VAULT B&H BTC:      netSharpe(ann)=${annSharpe(btcStats).toFixed(2)} compound=${(btcStats.compoundReturn * 100).toFixed(1)}%`);
  say("");

  // ========================================================================
  // SURROGATE / PLACEBO — rerun IDENTICAL machinery; champion's VAULT excess.
  // ========================================================================
  say("-".repeat(78));
  say("SURROGATE / PLACEBO — IDENTICAL search on phase / block / cross-shuffle nulls");
  say("-".repeat(78));
  const rng = makeRng(SEED);
  // metric the surrogate must NOT match: champion's full-sample net annualized Sharpe.
  const realMetric = annSharpe(safeSummarize(champFull.netReturns));
  say(`  REAL champion full-sample net Sharpe(ann) = ${realMetric.toFixed(3)}`);

  const families: ("phase" | "block" | "xshuffle")[] = ["phase", "block", "xshuffle"];
  const placebo: Record<string, { samples: number[]; pValue: number; meanPeriodicityP: number }> = {};

  for (const fam of families) {
    const surrSharpes: number[] = [];
    const surrPeriodicityP: number[] = [];
    for (let s = 0; s < N_SURROGATES; s += 1) {
      const surrCoinRet = surrogateCoinReturns(panel.coinPeriodRet, fam, rng);
      const surrTier = tierReturnsFromCoinReturns(surrCoinRet);
      // Champion is RETURN-rotation -> re-derive dominance with the IDENTICAL
      // return-dominance definition on the surrogate panel. The surrogate destroys
      // the genuine cross-asset / regime structure the rotation would exploit
      // (phase: keep each coin's spectrum, kill phase alignment; block: keep
      // short-range acf, kill long structure; xshuffle: kill lead-lag, keep
      // per-period marginals). Apples-to-apples with the real champion.
      const surrDom = dominanceByReturn(surrTier, TRAIL_K);
      // refit transition matrix on surrogate search slice for hold-predicted
      let rowProbs: number[][] | undefined;
      if (champion.c.mode === "hold-predicted") {
        rowProbs = analyzePremise(surrDom.slice(0, split.search.end)).rowProbs;
      }
      const surrRun = runRotation(surrDom, surrTier, champion.c.mode, rowProbs);
      surrSharpes.push(annSharpe(safeSummarize(surrRun.netReturns)));
      surrPeriodicityP.push(analyzePeriodicity(surrDom).fisherP);
    }
    surrSharpes.sort((a, b) => a - b);
    const ge = surrSharpes.filter((v) => v >= realMetric).length;
    const pVal = (ge + 1) / (surrSharpes.length + 1);
    placebo[fam] = {
      samples: surrSharpes,
      pValue: pVal,
      meanPeriodicityP: surrPeriodicityP.reduce((a, b) => a + b, 0) / surrPeriodicityP.length,
    };
    const q95 = surrSharpes[Math.floor(0.95 * surrSharpes.length)];
    say(`  [${fam.padEnd(9)}] surrogate net Sharpe: mean=${(surrSharpes.reduce((a, b) => a + b, 0) / surrSharpes.length).toFixed(2)} q95=${q95.toFixed(2)} | placebo p(surr>=real)=${pVal.toFixed(3)} | mean periodicity p=${placebo[fam].meanPeriodicityP.toFixed(3)}`);
  }
  const worstPlaceboP = Math.max(...families.map((f) => placebo[f].pValue));
  const surrogateClean = worstPlaceboP <= 0.05;
  say(`  => worst placebo p across families = ${worstPlaceboP.toFixed(3)} -> ${surrogateClean ? "REAL EDGE survives surrogates" : "ARTIFACT (surrogates match/beat real)"}`);
  say("");

  // ========================================================================
  // COMMITTED GATES on the champion (vault / full as appropriate)
  // ========================================================================
  say("-".repeat(78));
  say("COMMITTED GATES");
  say("-".repeat(78));

  // G1: Deflated Sharpe at honest N on the champion's per-period net returns
  // (use full-sample series for power; DSR penalizes for honestN trials).
  const dsr = computeDeflatedSharpeRatio(champFull.netReturns, { trialCount: honestN, benchmarkSharpe: 0 });
  say(`  [G1] Deflated Sharpe (N=${honestN}): per-period Sharpe=${dsr.sharpe.toFixed(3)} expMax=${dsr.expectedMaxSharpe.toFixed(3)} -> DSR prob=${dsr.deflatedProbability.toFixed(3)} (need >0.95)`);
  const gateDSR = dsr.deflatedProbability >= 0.95;

  // G2: Haircut Sharpe (Harvey-Liu Bonferroni)
  const hc = haircutSharpe({ observedSharpe: safeSummarize(champFull.netReturns).sharpe, sampleCount: champFull.netReturns.length, trialCount: honestN, method: "bonferroni" });
  say(`  [G2] Haircut (Bonferroni N=${honestN}): observed=${hc.observedSharpe.toFixed(3)} -> haircut=${hc.haircutSharpe.toFixed(3)} (cut ${(hc.haircut * 100).toFixed(0)}%) adjP=${hc.adjustedPValue.toExponential(2)}`);
  const gateHaircut = hc.adjustedPValue <= 0.05 && hc.haircutSharpe > 0;

  // G3: CSCV / PBO — split full series into folds; competing strategies = our candidates
  say("  [G3] CSCV/PBO across candidate strategies:");
  const FOLDS = 10;
  function toFolds(returns: number[]): number[][] {
    const folds: number[][] = [];
    const sz = Math.floor(returns.length / FOLDS);
    if (sz < 1) return [];
    for (let f = 0; f < FOLDS; f += 1) folds.push(returns.slice(f * sz, (f + 1) * sz));
    return folds;
  }
  const cscvInput: CscvStrategyFoldReturns[] = candidates
    .map((c) => ({ id: c.id, folds: toFolds(runBlock(c, 0, nP).netReturns) }))
    .filter((x) => x.folds.length === FOLDS && x.folds.every((f) => f.length > 0));
  let pbo = NaN;
  if (cscvInput.length >= 2) {
    const cscv = estimateCscvPbo(cscvInput, { statistic: "sharpe" });
    pbo = cscv.pbo;
    say(`       strategies=${cscv.strategyCount} folds=${cscv.foldCount} splits=${cscv.splitCount} -> PBO=${(pbo * 100).toFixed(0)}% (need <50%)`);
  } else {
    say("       insufficient distinct candidates for CSCV -> SKIP (treated as fail-open=false)");
  }
  const gatePBO = Number.isFinite(pbo) && pbo < 0.5;

  // G4: Baseline gate (beat B&H BTC + equal-weight + random-lottery) on VAULT, net.
  const btcBaseline = baselineScoreFromReturns("buy_and_hold", "B&H BTC", btcVault, { statistic: "compoundReturn" });
  const ewBaseline = baselineScoreFromReturns("equal_weight", "Equal-weight tiers", ewVault, { statistic: "compoundReturn" });
  const rlottery = buildRandomLotteryBaseline({
    barReturns: ewFull.slice(0, split.finalHoldout.start), // draw from pre-vault market periods
    tradeCount: Math.max(1, champVault.heldTiers.length),
    averageHoldingBars: 1,
    roundTripCost: ROUND_TRIP_COST,
    iterations: 1000,
    quantile: 0.95,
    seed: SEED,
    statistic: "compoundReturn",
  });
  const baseGate = evaluateBaselineGate({
    candidateReturns: champVault.netReturns,
    baselines: [btcBaseline, ewBaseline, rlottery],
    statistic: "compoundReturn",
    requirePositive: true,
  });
  say(`  [G4] Baseline gate on VAULT (compound, net): candidate=${(baseGate.candidateScore * 100).toFixed(1)}%`);
  for (const cmp of baseGate.comparisons) {
    say(`       vs ${cmp.label.padEnd(20)} base=${(cmp.baselineScore * 100).toFixed(1)}% margin=${(cmp.margin * 100).toFixed(1)}% ${cmp.beaten ? "BEAT" : "FAIL"}`);
  }
  const gateBaseline = baseGate.passed;

  // G5: surrogate/placebo
  const gateSurrogate = surrogateClean;

  // G6: consume-once holdout — record the vault verdict exactly once.
  const guard = new FinalHoldoutGuard();
  const vaultPositive = vaultStats.compoundReturn > 0 && annSharpe(vaultStats) > 0;
  guard.consume({ reason: "C2 dominance-cycle champion vault eval", gitSha: sha, trialCount: honestN, nowIso: new Date().toISOString() });
  say(`  [G6] Holdout consumed once (sha=${sha}, N=${honestN}); vault positive & Sharpe>0: ${vaultPositive ? "YES" : "NO"}`);
  say("");

  // ========================================================================
  // VERDICT
  // ========================================================================
  say("=".repeat(78));
  say("GATE SUMMARY");
  say("=".repeat(78));
  const gates: [string, boolean][] = [
    ["G1 Deflated Sharpe prob>=0.95", gateDSR],
    ["G2 Haircut survives (adjP<=0.05, Sharpe>0)", gateHaircut],
    ["G3 PBO<50%", gatePBO],
    ["G4 Beats B&H + EW + random-lottery (vault)", gateBaseline],
    ["G5 Surrogate/placebo clean (real edge survives)", gateSurrogate],
    ["G6 Vault positive net of cost", vaultPositive],
  ];
  for (const [name, ok] of gates) say(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const allPass = gates.every(([, ok]) => ok);

  // periodicity verdict (independent of tradeable)
  const cyclic =
    perRet.dominantSpectralPeriod !== null || (volDoc && perVol && perVol.dominantSpectralPeriod !== null);
  const premiseBeatsRandom = premRet.chi2P < 0.05 || (volDoc && premVol && premVol.chi2P < 0.05);

  say("");
  say("CYCLE EVIDENCE (the premise):");
  say(`  Is dominance CYCLIC? dominant spectral period: return=${perRet.dominantSpectralPeriod ? perRet.dominantSpectralPeriod.toFixed(1) + "wk" : "NONE"}${volDoc && perVol ? ", volume=" + (perVol.dominantSpectralPeriod ? perVol.dominantSpectralPeriod.toFixed(1) + "wk" : "NONE") : ""}`);
  say(`  Dominance transition matrix beats uniform? return p=${premRet.chi2P.toExponential(2)}${volDoc && premVol ? ", volume p=" + premVol.chi2P.toExponential(2) : ""}`);
  say(`  => ${cyclic ? "some spectral peak" : "NO significant cycle (white/persistent)"}; transition ${premiseBeatsRandom ? "beats random" : "NOT distinguishable from random"}`);
  say("");

  const verdict = allPass ? "SURVIVE" : "KILL";
  const firstFail = gates.find(([, ok]) => !ok);
  say(`FINAL VERDICT: ${verdict}${verdict === "KILL" && firstFail ? ` (killed by: ${firstFail[0]})` : ""}`);
  say("=".repeat(78));

  // ---- Persist artifact
  const artifact = {
    track: "FRONT-C2 dominance-cycle",
    generatedAt: new Date().toISOString(),
    gitSha: sha,
    data: { source: closesDoc.source, realData: closesDoc.realData, coins: COINS.length, dailyRows: T, periods: nP, volume: volDoc ? "binance" : null },
    config: { periodDays: PERIOD_DAYS, trailK: TRAIL_K, roundTripCostBps: ROUND_TRIP_COST * 1e4, honestN, nSurrogates: N_SURROGATES },
    periodicity: { return: perRet, volume: perVol },
    premise: {
      return: { rowProbs: premRet.rowProbs, llRatio: premRet.llRatio, chi2P: premRet.chi2P, persistenceHitRate: premRet.persistenceHitRate, argmaxHitRate: premRet.argmaxHitRate, transitions: premRet.transitions },
      volume: premVol ? { llRatio: premVol.llRatio, chi2P: premVol.chi2P, argmaxHitRate: premVol.argmaxHitRate } : null,
    },
    champion: {
      id: champion.c.id,
      searchSharpeAnn: champion.aSh,
      vaultSharpeAnn: annSharpe(vaultStats),
      vaultCompound: vaultStats.compoundReturn,
      vaultTurnover: champVault.turnover,
      fullSharpeAnn: realMetric,
    },
    volumeDominanceDiagnostic: volDiag,
    benchmarks: { ewVaultSharpeAnn: annSharpe(ewStats), btcVaultSharpeAnn: annSharpe(btcStats) },
    surrogate: { worstPlaceboP, families: Object.fromEntries(families.map((f) => [f, { pValue: placebo[f].pValue, meanPeriodicityP: placebo[f].meanPeriodicityP }])) },
    gates: {
      dsr: { prob: dsr.deflatedProbability, sharpe: dsr.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe, pass: gateDSR },
      haircut: { observed: hc.observedSharpe, haircut: hc.haircutSharpe, adjP: hc.adjustedPValue, pass: gateHaircut },
      pbo: { value: pbo, pass: gatePBO },
      baseline: { candidate: baseGate.candidateScore, comparisons: baseGate.comparisons, pass: gateBaseline },
      surrogate: { worstPlaceboP, pass: gateSurrogate },
      vaultPositive,
    },
    verdict,
    killedBy: verdict === "KILL" && firstFail ? firstFail[0] : null,
  };
  writeFileSync(join(OUT_DIR, "dominance-cycle-result.json"), JSON.stringify(artifact, null, 2));
  writeFileSync(join(OUT_DIR, "dominance-cycle-run.log"), log.join("\n"));
  say(`\nWrote output/front-c2/dominance-cycle-result.json + dominance-cycle-run.log`);
}

main();
