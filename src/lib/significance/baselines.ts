/**
 * Mandatory baseline gate (roadmap A1).
 *
 * The literature is explicit that a search-by-backtest strategy only counts as
 * promising once it beats trivial baselines net of costs:
 *  - a one-layer linear model (Zeng et al. 2023, DLinear — a single linear layer
 *    matches or beats sophisticated forecasters in most univariate settings);
 *  - a random / zero-intelligence "lottery" trader (Chen & Navet 2007 — without a
 *    random-search pre-test, GP/GA "success" is probably luck);
 *  - buy-and-hold (the cost-free benchmark every active strategy must justify).
 *
 * This module is pure and deterministic: it does NOT train models or run
 * backtests. Callers feed in the candidate's net-of-cost return series plus the
 * baselines (the linear model's returns come from the existing logistic/DLinear
 * baseline; buy-and-hold and random-lottery are derived from the bar series).
 * The candidate must beat every baseline by `minMargin` and be positive.
 */

import {
  summarizeReturnSeries,
  type ReturnSeriesStatistic,
} from "../statistical-validation";

const EPSILON = 1e-12;

export type BaselineId =
  | "buy_and_hold"
  | "random_lottery"
  | "linear_one_layer"
  | (string & {});

export interface BaselineScore {
  id: BaselineId;
  label: string;
  /** Score in the configured statistic (compoundReturn by default), net of costs. */
  score: number;
  /** How the score was derived (for evidence/audit). */
  source: string;
  /** Optional sample/trade context for diagnostics. */
  sampleCount?: number;
  tradeCount?: number;
}

export interface BaselineComparison {
  id: BaselineId;
  label: string;
  baselineScore: number;
  /** candidateScore - baselineScore. Positive ⇒ candidate is ahead. */
  margin: number;
  beaten: boolean;
}

export interface BaselineGateInput {
  /** Candidate net-of-cost return series (per trade or per bar — must match the baselines). */
  candidateReturns: readonly number[];
  /** Optional explicit candidate score; otherwise computed from `candidateReturns`. */
  candidateScore?: number;
  baselines: readonly BaselineScore[];
  /** Comparison statistic. Default: compoundReturn (net P&L), per the cost-realism rule. */
  statistic?: ReturnSeriesStatistic;
  /** Candidate must beat each baseline by at least this margin (same units). Default 0. */
  minMargin?: number;
  /** Require candidate score > 0 to pass. Default true. */
  requirePositive?: boolean;
}

export interface BaselineGateResult {
  statistic: ReturnSeriesStatistic;
  candidateScore: number;
  candidatePositive: boolean;
  comparisons: BaselineComparison[];
  beatsAll: boolean;
  /** Smallest margin across all baselines (the binding constraint). */
  worstMargin: number;
  worstBaselineId: BaselineId | null;
  passed: boolean;
  reasons: string[];
}

export interface BuyAndHoldOptions {
  /** Per-bar market returns over the evaluation window (close-to-close fractions). */
  barReturns: readonly number[];
  /** Round-trip cost as a fraction (e.g. 0.0028 for 28 bps). Applied once. */
  roundTripCost?: number;
  statistic?: ReturnSeriesStatistic;
  /** Trade direction. Default long. */
  side?: "long" | "short";
}

export interface RandomLotteryOptions {
  /** Per-bar market returns over the evaluation window. */
  barReturns: readonly number[];
  /** Number of trades to match the candidate's turnover. */
  tradeCount: number;
  /** Average holding length in bars (matches the candidate). Default 1. */
  averageHoldingBars?: number;
  /** Net round-trip cost as a fraction. Applied per trade. */
  roundTripCost?: number;
  /** Monte-Carlo iterations. Default 512. */
  iterations?: number;
  /**
   * Percentile of the random-trader distribution the candidate must beat
   * (so it beats luck with confidence). Default 0.95.
   */
  quantile?: number;
  /** Allow random shorts as well as longs. Default true. */
  allowShort?: boolean;
  statistic?: ReturnSeriesStatistic;
  seed?: number | string;
}

export interface RandomLotteryBaseline extends BaselineScore {
  id: "random_lottery";
  /** The MC distribution of random-trader scores (sorted). */
  samples: number[];
  quantile: number;
}

/** Pull a single statistic out of a return series, reusing the canonical digest. */
function scoreReturns(
  returns: readonly number[],
  statistic: ReturnSeriesStatistic,
): number {
  const stats = summarizeReturnSeries(returns);
  if (statistic === "mean") return stats.mean;
  if (statistic === "sharpe") return stats.sharpe;
  return stats.compoundReturn;
}

/** Build a baseline score from an explicit net-of-cost return series (e.g. the linear model). */
export function baselineScoreFromReturns(
  id: BaselineId,
  label: string,
  returns: readonly number[],
  options: { statistic?: ReturnSeriesStatistic; source?: string; tradeCount?: number } = {},
): BaselineScore {
  const statistic = options.statistic ?? "compoundReturn";
  const stats = summarizeReturnSeries(returns);
  return {
    id,
    label,
    score: scoreReturns(returns, statistic),
    source: options.source ?? "returns_series",
    sampleCount: stats.sampleCount,
    tradeCount: options.tradeCount,
  };
}

/**
 * Buy-and-hold baseline. Holds the asset over the full window and pays one
 * round-trip cost. The compound score charges the cost once at the entry bar.
 */
export function buildBuyAndHoldBaseline(options: BuyAndHoldOptions): BaselineScore {
  const statistic = options.statistic ?? "compoundReturn";
  const roundTripCost = Math.max(0, options.roundTripCost ?? 0);
  const sign = options.side === "short" ? -1 : 1;
  const bars = finiteValues(options.barReturns).map((value) => sign * value);
  // Charge the entry cost on the first bar so the Sharpe/mean path also sees it.
  const series = bars.length > 0 ? [bars[0] - roundTripCost, ...bars.slice(1)] : [];
  const stats = summarizeReturnSeries(series);
  return {
    id: "buy_and_hold",
    label: options.side === "short" ? "Sell-and-hold" : "Buy-and-hold",
    score: scoreReturns(series, statistic),
    source: `bar_series:${bars.length}bars;roundTripCost=${roundTripCost}`,
    sampleCount: stats.sampleCount,
    tradeCount: bars.length > 0 ? 1 : 0,
  };
}

/**
 * Random / zero-intelligence lottery trader (Chen & Navet 2007). Generates
 * `iterations` random traders that each place `tradeCount` random entries of
 * `averageHoldingBars` length (random direction if `allowShort`), net of costs.
 * The baseline score is the `quantile` of that distribution — the candidate
 * must beat random luck at that confidence level. Deterministic via `seed`.
 */
export function buildRandomLotteryBaseline(
  options: RandomLotteryOptions,
): RandomLotteryBaseline {
  const statistic = options.statistic ?? "compoundReturn";
  const bars = finiteValues(options.barReturns);
  const tradeCount = Math.max(0, Math.floor(options.tradeCount));
  const holding = Math.max(1, Math.round(options.averageHoldingBars ?? 1));
  const roundTripCost = Math.max(0, options.roundTripCost ?? 0);
  const iterations = Math.max(1, Math.floor(options.iterations ?? 512));
  const quantile = clamp(options.quantile ?? 0.95, 0, 1);
  const allowShort = options.allowShort ?? true;
  const random = createSeededRandom(options.seed ?? "random-lottery");

  if (bars.length === 0 || tradeCount === 0) {
    return {
      id: "random_lottery",
      label: "Random lottery trader",
      score: 0,
      source: `degenerate:${bars.length}bars;trades=${tradeCount}`,
      sampleCount: 0,
      tradeCount,
      samples: [],
      quantile,
    };
  }

  const samples = Array.from({ length: iterations }, () => {
    const tradeReturns: number[] = [];
    for (let trade = 0; trade < tradeCount; trade += 1) {
      const start = Math.floor(random() * bars.length);
      const direction = allowShort ? (random() < 0.5 ? -1 : 1) : 1;
      let logReturn = 0;
      for (let offset = 0; offset < holding; offset += 1) {
        const bar = bars[(start + offset) % bars.length];
        const directed = direction * bar;
        // guard against pathological -100%+ bars in the log accumulation
        logReturn += Math.log1p(Math.max(-0.999999, directed));
      }
      const gross = Math.expm1(logReturn);
      tradeReturns.push(gross - roundTripCost);
    }
    return scoreReturns(tradeReturns, statistic);
  }).sort((left, right) => left - right);

  return {
    id: "random_lottery",
    label: "Random lottery trader",
    score: quantileSorted(samples, quantile),
    source: `montecarlo:${iterations}it;trades=${tradeCount};hold=${holding};q=${quantile}`,
    sampleCount: tradeCount * holding,
    tradeCount,
    samples,
    quantile,
  };
}

/**
 * Gate a candidate against every baseline. The candidate must beat each baseline
 * by `minMargin` and (by default) be positive net of costs.
 */
export function evaluateBaselineGate(input: BaselineGateInput): BaselineGateResult {
  const statistic = input.statistic ?? "compoundReturn";
  const minMargin = Number.isFinite(input.minMargin) ? (input.minMargin as number) : 0;
  const requirePositive = input.requirePositive ?? true;
  const candidateScore =
    input.candidateScore !== undefined && Number.isFinite(input.candidateScore)
      ? input.candidateScore
      : scoreReturns(input.candidateReturns, statistic);

  const comparisons = input.baselines.map((baseline): BaselineComparison => {
    const margin = candidateScore - baseline.score;
    return {
      id: baseline.id,
      label: baseline.label,
      baselineScore: baseline.score,
      margin,
      beaten: margin >= minMargin - EPSILON,
    };
  });

  const beatsAll = comparisons.every((comparison) => comparison.beaten);
  const candidatePositive = candidateScore > EPSILON;
  const worst = comparisons.reduce<BaselineComparison | null>(
    (current, comparison) =>
      current === null || comparison.margin < current.margin ? comparison : current,
    null,
  );

  const reasons: string[] = [];
  if (requirePositive && !candidatePositive) {
    reasons.push("candidate_not_positive");
  }
  for (const comparison of comparisons) {
    if (!comparison.beaten) {
      reasons.push(`fails_vs_${comparison.id}`);
    }
  }

  return {
    statistic,
    candidateScore,
    candidatePositive,
    comparisons,
    beatsAll,
    worstMargin: worst?.margin ?? 0,
    worstBaselineId: worst?.id ?? null,
    passed: beatsAll && (!requirePositive || candidatePositive),
    reasons,
  };
}

function finiteValues(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function quantileSorted(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const bounded = clamp(quantile, 0, 1);
  const position = (values.length - 1) * bounded;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower] ?? 0;
  const weight = position - lower;
  return (values[lower] ?? 0) * (1 - weight) + (values[upper] ?? 0) * weight;
}

function createSeededRandom(seed: number | string): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
