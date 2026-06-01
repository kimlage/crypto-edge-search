/**
 * CPCV multi-path selection substrate (roadmap A3 / gap L5).
 *
 * López de Prado (2018, ch.7/12): walk-forward overfits as easily as walk-backward
 * because it tests a single path. Combinatorial Purged CV produces MANY out-of-sample
 * paths; selecting on the *distribution* of path Sharpes (not one composite path) is
 * the canonical fix. The purged/embargoed folds themselves already exist in
 * preprocess.ts (createPurgedCpcvFolds); this module turns their per-path returns into
 * a robust, multi-path selection score and wires the strategies×paths matrix into the
 * canonical CSCV/PBO estimator.
 *
 * Pure and deterministic.
 */

import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
  type CscvPboResult,
  type CscvStrategyFoldReturns,
} from "../statistical-validation";

export interface CpcvPathReturns {
  pathId: string;
  /** OOS returns observed along this combinatorial path (per trade or per block). */
  returns: readonly number[];
}

export interface CpcvPathStat {
  pathId: string;
  sampleCount: number;
  sharpe: number;
  compoundReturn: number;
  mean: number;
}

export interface CpcvPathSummary {
  pathCount: number;
  perPath: CpcvPathStat[];
  medianSharpe: number;
  worstSharpe: number;
  bestSharpe: number;
  /** Std of the per-path Sharpes — high dispersion ⇒ path-fragile edge. */
  sharpeDispersion: number;
  /** Fraction of paths with a positive compound return. */
  fractionPositivePaths: number;
  medianCompoundReturn: number;
  worstCompoundReturn: number;
  /** All path returns pooled (for a deflated Sharpe over the whole OOS evidence). */
  pooledSampleCount: number;
}

export interface CpcvSelectionScoreOptions {
  /** Weight on the worst path (robustness). Default 0.45. */
  worstWeight?: number;
  /** Penalty per unit of Sharpe dispersion across paths. Default 0.5. */
  dispersionPenalty?: number;
  /** Bonus per unit of positive-path fraction. Default 0.3. */
  positiveFractionBonus?: number;
}

export function summarizeCpcvPaths(paths: readonly CpcvPathReturns[]): CpcvPathSummary {
  const perPath = paths.map((path): CpcvPathStat => {
    const stats = summarizeReturnSeries(path.returns);
    return {
      pathId: path.pathId,
      sampleCount: stats.sampleCount,
      sharpe: stats.sharpe,
      compoundReturn: stats.compoundReturn,
      mean: stats.mean,
    };
  });

  const sharpes = perPath.map((p) => p.sharpe);
  const compounds = perPath.map((p) => p.compoundReturn);
  const pooledSampleCount = perPath.reduce((sum, p) => sum + p.sampleCount, 0);

  return {
    pathCount: perPath.length,
    perPath,
    medianSharpe: median(sharpes),
    worstSharpe: sharpes.length > 0 ? Math.min(...sharpes) : 0,
    bestSharpe: sharpes.length > 0 ? Math.max(...sharpes) : 0,
    sharpeDispersion: std(sharpes),
    fractionPositivePaths:
      perPath.length > 0 ? compounds.filter((c) => c > 0).length / perPath.length : 0,
    medianCompoundReturn: median(compounds),
    worstCompoundReturn: compounds.length > 0 ? Math.min(...compounds) : 0,
    pooledSampleCount,
  };
}

/**
 * Multi-path selection score: rewards median Sharpe, leans on the worst path, and
 * penalizes Sharpe dispersion across paths (the single-path validation2 score cannot
 * see any of this). Higher is better.
 */
export function cpcvSelectionScore(
  summary: CpcvPathSummary,
  options: CpcvSelectionScoreOptions = {},
): number {
  const worstWeight = options.worstWeight ?? 0.45;
  const dispersionPenalty = options.dispersionPenalty ?? 0.5;
  const positiveFractionBonus = options.positiveFractionBonus ?? 0.3;
  const medianWeight = Math.max(0, 1 - worstWeight);

  return (
    summary.medianSharpe * medianWeight +
    summary.worstSharpe * worstWeight -
    summary.sharpeDispersion * dispersionPenalty +
    summary.fractionPositivePaths * positiveFractionBonus
  );
}

/**
 * Deflated Sharpe over the pooled OOS evidence of all paths, deflated by the true
 * trial count. Returns the deflated probability (the promotion-grade DSR).
 */
export function cpcvDeflatedSharpe(
  paths: readonly CpcvPathReturns[],
  trialCount: number,
): number {
  const pooled = paths.flatMap((path) => path.returns.filter((value) => Number.isFinite(value)));
  if (pooled.length < 2) return 0;
  return computeDeflatedSharpeRatio(pooled, { trialCount: Math.max(1, Math.floor(trialCount)) })
    .deflatedProbability;
}

export interface CpcvStrategyPaths {
  id: string;
  paths: readonly CpcvPathReturns[];
}

/**
 * Build the strategies×paths matrix and run the canonical CSCV/PBO over it. Each
 * combinatorial path is a fold, so PBO is estimated over the real OOS paths rather
 * than the degenerate ~3-block proxy (ties A3 to A4).
 */
export function cpcvPbo(
  strategies: readonly CpcvStrategyPaths[],
  options: { trainFraction?: number } = {},
): CscvPboResult {
  const pathOrder = sharedPathOrder(strategies);
  // The canonical estimator needs ≥2 strategies and ≥2 shared folds/paths.
  if (strategies.length < 2 || pathOrder.length < 2) {
    return {
      strategyCount: strategies.length,
      foldCount: pathOrder.length,
      splitCount: 0,
      statistic: "compoundReturn",
      pbo: 0,
      meanLogit: 0,
      medianLogit: 0,
      splits: [],
    };
  }
  const matrix: CscvStrategyFoldReturns[] = strategies.map((strategy) => {
    const byPath = new Map(strategy.paths.map((p) => [p.pathId, p.returns]));
    return {
      id: strategy.id,
      folds: pathOrder.map((pathId) => [...(byPath.get(pathId) ?? [])]),
    };
  });
  return estimateCscvPbo(matrix, { statistic: "compoundReturn", trainFraction: options.trainFraction ?? 0.5 });
}

function sharedPathOrder(strategies: readonly CpcvStrategyPaths[]): string[] {
  if (strategies.length === 0) return [];
  // intersection of path ids, in first-strategy order
  const counts = new Map<string, number>();
  for (const strategy of strategies) {
    const seen = new Set<string>();
    for (const path of strategy.paths) seen.add(path.pathId);
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const total = strategies.length;
  const firstOrder = strategies[0].paths.map((p) => p.pathId);
  return firstOrder.filter((id) => counts.get(id) === total);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid] ?? 0
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function std(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}
