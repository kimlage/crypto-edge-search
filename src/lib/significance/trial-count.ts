/**
 * Effective trial count (true N) and Minimum Backtest Length (roadmap A0 / gap L3).
 *
 * The Deflated Sharpe Ratio only deflates if it is fed the *true* number of
 * distinct configs tried — not 1, and not the per-family bucket size. Bailey,
 * Borwein, López de Prado & Zhu (AMS 2014) further show that, given N trials,
 * there is a Minimum Backtest Length (MinBTL) below which an in-sample Sharpe is
 * statistically useless: the expected maximum Sharpe of N true-zero strategies
 * over a sample of `n` observations is ≈ E[max N(0,1)] / sqrt(n), so any observed
 * Sharpe at or below that bar is explainable by selection luck alone.
 *
 * Pure and dependency-light: callers pass trial fingerprints / counts; this
 * module computes the N to inject into `computeDeflatedSharpeRatio` and whether
 * the sample is long enough to trust the winner.
 */

import { expectedMaxStandardNormal } from "../statistical-validation";

export interface TrialIdentity {
  /** Stable config fingerprint — prefer DNA id; fall back to trial id. */
  dnaId?: string | null;
  trialId?: string | null;
}

/**
 * Distinct configs evaluated. Counts unique DNA ids (the genotype actually
 * searched); rows without a DNA id fall back to their trial id so a bare run
 * still counts as one trial. This is the N the DSR must deflate by.
 */
export function countDistinctTrials(rows: readonly TrialIdentity[]): number {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = nonEmpty(row.dnaId) ?? nonEmpty(row.trialId);
    if (key !== null) {
      seen.add(key);
    }
  }
  return seen.size;
}

/**
 * The trial count to inject into the DSR. Never below 1; takes the largest of an
 * explicit override (e.g. a cross-run ledger total), the distinct rows counted
 * here, and a caller-supplied floor — so deflation is never silently skipped.
 */
export function effectiveTrialCount(args: {
  rows?: readonly TrialIdentity[];
  explicitTrialCount?: number | null;
  floor?: number | null;
}): number {
  const fromRows = args.rows ? countDistinctTrials(args.rows) : 0;
  const explicit = finitePositiveInt(args.explicitTrialCount);
  const floor = finitePositiveInt(args.floor);
  return Math.max(1, fromRows, explicit, floor);
}

export interface MinBtlInput {
  /** True number of distinct configs tried. */
  trialCount: number;
  /** Number of observations the Sharpe was computed on (trades or blocks). */
  sampleCount: number;
  /** The observed (per-observation) Sharpe of the selected strategy. */
  observedSharpe: number;
}

export interface MinBtlResult {
  trialCount: number;
  sampleCount: number;
  observedSharpe: number;
  /** Expected max Sharpe of `trialCount` true-zero strategies at this sample length. */
  expectedMaxNullSharpe: number;
  /** Minimum observations needed for `observedSharpe` to clear the selection-luck bar. */
  minSampleForObservedSharpe: number;
  /** True when the sample is long enough that the observed Sharpe beats luck. */
  sufficientLength: boolean;
  reason: string;
}

/**
 * Minimum Backtest Length check. The expected maximum Sharpe under the null grows
 * with the number of trials and shrinks with sample length: `E[max] ≈ Z_N / √n`.
 * The observed Sharpe must exceed that bar, which is equivalent to requiring
 * `n ≥ (Z_N / observedSharpe)²`.
 */
export function evaluateMinBtl(input: MinBtlInput): MinBtlResult {
  const trialCount = Math.max(1, Math.floor(input.trialCount));
  const sampleCount = Math.max(0, Math.floor(input.sampleCount));
  const observedSharpe = Number.isFinite(input.observedSharpe) ? input.observedSharpe : 0;
  const zN = expectedMaxStandardNormal(trialCount);
  const expectedMaxNullSharpe = sampleCount > 0 ? zN / Math.sqrt(sampleCount) : Infinity;
  const minSampleForObservedSharpe =
    observedSharpe > 0 ? Math.ceil((zN / observedSharpe) ** 2) : Infinity;
  const sufficientLength =
    sampleCount > 0 &&
    observedSharpe > expectedMaxNullSharpe &&
    sampleCount >= minSampleForObservedSharpe;

  let reason: string;
  if (sampleCount === 0) {
    reason = "no_sample";
  } else if (observedSharpe <= 0) {
    reason = "non_positive_sharpe";
  } else if (!sufficientLength) {
    reason = `sample_too_short_for_${trialCount}_trials`;
  } else {
    reason = "sufficient";
  }

  return {
    trialCount,
    sampleCount,
    observedSharpe,
    expectedMaxNullSharpe,
    minSampleForObservedSharpe,
    sufficientLength,
    reason,
  };
}

export interface TrialSelectionSummary {
  trialCount: number;
  returnSampleCount: number;
  meanReturn: number;
  /** Dispersion of validation2 returns across trials — high variance ⇒ more selection luck. */
  returnVariance: number;
  bestReturn: number;
  worstReturn: number;
}

/**
 * Summarize a batch of trials for the evidence record: the true N plus the
 * dispersion of validation2 returns (a proxy for how much selection luck the
 * ranking has to chew through).
 */
export function summarizeTrialSelection(
  rows: readonly (TrialIdentity & { validation2Return?: number | null })[],
): TrialSelectionSummary {
  const trialCount = countDistinctTrials(rows);
  const returns = rows
    .map((row) => row.validation2Return)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const returnSampleCount = returns.length;
  const meanReturn = returnSampleCount > 0 ? average(returns) : 0;
  const returnVariance =
    returnSampleCount > 1
      ? returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / (returnSampleCount - 1)
      : 0;

  return {
    trialCount,
    returnSampleCount,
    meanReturn,
    returnVariance,
    bestReturn: returnSampleCount > 0 ? Math.max(...returns) : 0,
    worstReturn: returnSampleCount > 0 ? Math.min(...returns) : 0,
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finitePositiveInt(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
