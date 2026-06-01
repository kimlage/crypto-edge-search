export type ReturnSeriesStatistic = "compoundReturn" | "mean" | "sharpe";

export interface ReturnSeriesStats {
  sampleCount: number;
  mean: number;
  stdDev: number;
  sharpe: number;
  skewness: number;
  kurtosis: number;
  positiveRate: number;
  compoundReturn: number;
  min: number;
  max: number;
}

export interface ProbabilisticSharpeRatio {
  sampleCount: number;
  sharpe: number;
  benchmarkSharpe: number;
  skewness: number;
  kurtosis: number;
  zScore: number;
  probability: number;
}

export interface DeflatedSharpeRatio extends ProbabilisticSharpeRatio {
  trialCount: number;
  effectiveTrials: number;
  sharpeStandardError: number;
  expectedMaxSharpe: number;
  deflatedProbability: number;
}

export interface BlockBootstrapOptions {
  iterations?: number;
  blockLength?: number;
  confidenceLevel?: number;
  statistic?: ReturnSeriesStatistic;
  seed?: number | string;
}

export interface BlockBootstrapConfidenceInterval {
  statistic: ReturnSeriesStatistic;
  estimate: number;
  lower: number;
  upper: number;
  confidenceLevel: number;
  iterations: number;
  blockLength: number;
  samples: number[];
}

export interface ThresholdSensitivityCandidate {
  id?: string;
  threshold?: number;
  longThreshold?: number;
  shortThreshold?: number;
  returns: readonly number[];
  tradeCount?: number;
}

export interface ThresholdSensitivityOptions {
  statistic?: ReturnSeriesStatistic;
  minTradeCount?: number;
  neighborhood?: number;
  minimumPositiveFraction?: number;
  maxMedianDegradation?: number;
}

export interface ThresholdSensitivityRow {
  id: string;
  threshold: number | null;
  longThreshold: number | null;
  shortThreshold: number | null;
  sampleCount: number;
  tradeCount: number;
  compoundReturn: number;
  mean: number;
  sharpe: number;
  score: number;
  positive: boolean;
  eligible: boolean;
}

export interface ThresholdSensitivitySummary {
  statistic: ReturnSeriesStatistic;
  rows: ThresholdSensitivityRow[];
  best: ThresholdSensitivityRow | null;
  medianScore: number;
  scoreRange: number;
  positiveFraction: number;
  bestToMedianDegradation: number;
  localRows: ThresholdSensitivityRow[];
  locallyStable: boolean;
  passed: boolean;
}

export interface CscvStrategyFoldReturns {
  id: string;
  folds: readonly (readonly number[])[];
}

export interface CscvPboOptions {
  statistic?: ReturnSeriesStatistic;
  trainFraction?: number;
}

export interface CscvSplitResult {
  trainFoldIndexes: number[];
  testFoldIndexes: number[];
  selectedStrategyId: string;
  selectedTrainScore: number;
  selectedTestScore: number;
  selectedTestRank: number;
  selectedTestRankPercentile: number;
  logit: number;
  overfit: boolean;
}

export interface CscvPboResult {
  strategyCount: number;
  foldCount: number;
  splitCount: number;
  statistic: ReturnSeriesStatistic;
  pbo: number;
  meanLogit: number;
  medianLogit: number;
  splits: CscvSplitResult[];
}

const EPSILON = 1e-12;
const EULER_GAMMA = 0.5772156649015329;

export function summarizeReturnSeries(
  returns: readonly number[],
): ReturnSeriesStats {
  const values = finiteValues(returns);

  if (values.length === 0) {
    return {
      sampleCount: 0,
      mean: 0,
      stdDev: 0,
      sharpe: 0,
      skewness: 0,
      kurtosis: 3,
      positiveRate: 0,
      compoundReturn: 0,
      min: 0,
      max: 0,
    };
  }

  const mean = average(values);
  const stdDev = sampleStdDev(values, mean);
  const sharpe = stdDev > EPSILON ? mean / stdDev : 0;
  const positiveRate =
    values.filter((value) => value > 0).length / values.length;

  return {
    sampleCount: values.length,
    mean,
    stdDev,
    sharpe,
    skewness: skewness(values, mean, stdDev),
    kurtosis: kurtosis(values, mean, stdDev),
    positiveRate,
    compoundReturn: compoundReturn(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function computeProbabilisticSharpeRatio(
  returns: readonly number[],
  benchmarkSharpe = 0,
): ProbabilisticSharpeRatio {
  const stats = summarizeReturnSeries(returns);
  const standardError = sharpeStandardError(stats);
  const zScore =
    standardError > EPSILON
      ? (stats.sharpe - benchmarkSharpe) / standardError
      : 0;

  return {
    sampleCount: stats.sampleCount,
    sharpe: stats.sharpe,
    benchmarkSharpe,
    skewness: stats.skewness,
    kurtosis: stats.kurtosis,
    zScore,
    probability: normalCdf(zScore),
  };
}

export function computeDeflatedSharpeRatio(
  returns: readonly number[],
  options: {
    benchmarkSharpe?: number;
    trialCount?: number;
  } = {},
): DeflatedSharpeRatio {
  const stats = summarizeReturnSeries(returns);
  const benchmarkSharpe = options.benchmarkSharpe ?? 0;
  const trialCount = Math.max(1, Math.floor(options.trialCount ?? 1));
  const effectiveTrials = Math.max(1, trialCount);
  const sharpeStandardErrorValue = sharpeStandardError(stats);
  const expectedMaxSharpe =
    benchmarkSharpe +
    sharpeStandardErrorValue * expectedMaxStandardNormal(effectiveTrials);
  const zScore =
    sharpeStandardErrorValue > EPSILON
      ? (stats.sharpe - expectedMaxSharpe) / sharpeStandardErrorValue
      : 0;
  const deflatedProbability = normalCdf(zScore);

  return {
    sampleCount: stats.sampleCount,
    sharpe: stats.sharpe,
    benchmarkSharpe,
    skewness: stats.skewness,
    kurtosis: stats.kurtosis,
    zScore,
    probability: deflatedProbability,
    trialCount,
    effectiveTrials,
    sharpeStandardError: sharpeStandardErrorValue,
    expectedMaxSharpe,
    deflatedProbability,
  };
}

export function blockBootstrapConfidenceInterval(
  returns: readonly number[],
  options: BlockBootstrapOptions = {},
): BlockBootstrapConfidenceInterval {
  const values = finiteValues(returns);
  const statistic = options.statistic ?? "compoundReturn";
  const iterations = normalizePositiveInteger(options.iterations, 1_000);
  const confidenceLevel = clamp(options.confidenceLevel ?? 0.95, 0.5, 0.999);
  const blockLength = normalizePositiveInteger(
    options.blockLength,
    Math.max(1, Math.round(Math.sqrt(Math.max(1, values.length)))),
  );
  const estimate = statisticValue(values, statistic);

  if (values.length === 0) {
    return {
      statistic,
      estimate: 0,
      lower: 0,
      upper: 0,
      confidenceLevel,
      iterations,
      blockLength,
      samples: [],
    };
  }

  const random = createSeededRandom(options.seed ?? "block-bootstrap");
  const samples = Array.from({ length: iterations }, () => {
    const resampled: number[] = [];

    while (resampled.length < values.length) {
      const start = Math.floor(random() * values.length);

      for (
        let offset = 0;
        offset < blockLength && resampled.length < values.length;
        offset += 1
      ) {
        resampled.push(values[(start + offset) % values.length]);
      }
    }

    return statisticValue(resampled, statistic);
  }).sort((left, right) => left - right);
  const alpha = 1 - confidenceLevel;

  return {
    statistic,
    estimate,
    lower: quantileSorted(samples, alpha / 2),
    upper: quantileSorted(samples, 1 - alpha / 2),
    confidenceLevel,
    iterations,
    blockLength,
    samples,
  };
}

export function analyzeThresholdSensitivity(
  candidates: readonly ThresholdSensitivityCandidate[],
  options: ThresholdSensitivityOptions = {},
): ThresholdSensitivitySummary {
  const statistic = options.statistic ?? "compoundReturn";
  const minTradeCount = Math.max(0, Math.floor(options.minTradeCount ?? 1));
  const minimumPositiveFraction = clamp(
    options.minimumPositiveFraction ?? 0.6,
    0,
    1,
  );
  const maxMedianDegradation = Math.max(0, options.maxMedianDegradation ?? 0.5);
  const rows = candidates
    .map((candidate, index): ThresholdSensitivityRow => {
      const stats = summarizeReturnSeries(candidate.returns);
      const score = statisticValueFromStats(stats, statistic);
      const tradeCount = Math.max(
        0,
        Math.floor(candidate.tradeCount ?? stats.sampleCount),
      );

      return {
        id: candidate.id ?? thresholdCandidateId(candidate, index),
        threshold: finiteOrNull(candidate.threshold),
        longThreshold: finiteOrNull(candidate.longThreshold),
        shortThreshold: finiteOrNull(candidate.shortThreshold),
        sampleCount: stats.sampleCount,
        tradeCount,
        compoundReturn: stats.compoundReturn,
        mean: stats.mean,
        sharpe: stats.sharpe,
        score,
        positive: score > 0,
        eligible: stats.sampleCount > 0 && tradeCount >= minTradeCount,
      };
    })
    .sort(compareThresholdRows);
  const eligibleRows = rows.filter((row) => row.eligible);
  const best = eligibleRows.reduce<ThresholdSensitivityRow | null>(
    (currentBest, row) =>
      currentBest === null || row.score > currentBest.score ? row : currentBest,
    null,
  );
  const scores = eligibleRows.map((row) => row.score).sort((left, right) => left - right);
  const medianScore = scores.length > 0 ? quantileSorted(scores, 0.5) : 0;
  const scoreRange =
    scores.length > 0 ? (scores.at(-1) ?? 0) - (scores[0] ?? 0) : 0;
  const positiveFraction =
    eligibleRows.length > 0
      ? eligibleRows.filter((row) => row.positive).length / eligibleRows.length
      : 0;
  const bestToMedianDegradation =
    best && best.score > EPSILON
      ? clamp((best.score - medianScore) / Math.abs(best.score), 0, 1)
      : best && best.score <= EPSILON && medianScore < best.score
        ? 1
        : 0;
  const localRows = best
    ? eligibleRows.filter((row) =>
        thresholdDistance(row, best) <= (options.neighborhood ?? 0.025),
      )
    : [];
  const locallyStable =
    best !== null &&
    localRows.length >= Math.min(2, eligibleRows.length) &&
    localRows.every((row) => row.score >= 0);

  return {
    statistic,
    rows,
    best,
    medianScore,
    scoreRange,
    positiveFraction,
    bestToMedianDegradation,
    localRows,
    locallyStable,
    passed:
      best !== null &&
      best.score > 0 &&
      positiveFraction >= minimumPositiveFraction &&
      bestToMedianDegradation <= maxMedianDegradation &&
      locallyStable,
  };
}

export function estimateCscvPbo(
  strategies: readonly CscvStrategyFoldReturns[],
  options: CscvPboOptions = {},
): CscvPboResult {
  const statistic = options.statistic ?? "compoundReturn";
  const normalized = normalizeCscvStrategies(strategies);
  const strategyCount = normalized.length;
  const foldCount = normalized[0]?.folds.length ?? 0;
  const trainSize = clampInteger(
    Math.round(foldCount * clamp(options.trainFraction ?? 0.5, 0.1, 0.9)),
    1,
    Math.max(1, foldCount - 1),
  );
  const trainCombinations = combinations(
    Array.from({ length: foldCount }, (_, index) => index),
    trainSize,
  );
  const splits = trainCombinations.map((trainFoldIndexes): CscvSplitResult => {
    const trainSet = new Set(trainFoldIndexes);
    const testFoldIndexes = Array.from(
      { length: foldCount },
      (_, index) => index,
    ).filter((index) => !trainSet.has(index));
    const trainScores = normalized.map((strategy) => ({
      id: strategy.id,
      score: scoreFolds(strategy.folds, trainFoldIndexes, statistic),
    }));
    const selected = trainScores.reduce((best, item) =>
      item.score > best.score ? item : best,
    );
    const testScores = normalized
      .map((strategy) => ({
        id: strategy.id,
        score: scoreFolds(strategy.folds, testFoldIndexes, statistic),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const selectedTestIndex = testScores.findIndex(
      (item) => item.id === selected.id,
    );
    const selectedTestRank = selectedTestIndex + 1;
    const selectedTestScore = testScores[selectedTestIndex]?.score ?? 0;
    const selectedTestRankPercentile =
      strategyCount <= 1
        ? 0.5
        : 1 - selectedTestIndex / (strategyCount - 1);
    const boundedPercentile = clamp(selectedTestRankPercentile, EPSILON, 1 - EPSILON);
    const logit = Math.log(boundedPercentile / (1 - boundedPercentile));

    return {
      trainFoldIndexes: [...trainFoldIndexes],
      testFoldIndexes,
      selectedStrategyId: selected.id,
      selectedTrainScore: selected.score,
      selectedTestScore,
      selectedTestRank,
      selectedTestRankPercentile,
      logit,
      overfit: logit < 0,
    };
  });
  const logits = splits.map((split) => split.logit).sort((left, right) => left - right);
  const pbo =
    splits.length > 0
      ? splits.filter((split) => split.overfit).length / splits.length
      : 0;

  return {
    strategyCount,
    foldCount,
    splitCount: splits.length,
    statistic,
    pbo,
    meanLogit: logits.length > 0 ? average(logits) : 0,
    medianLogit: logits.length > 0 ? quantileSorted(logits, 0.5) : 0,
    splits,
  };
}

function normalizeCscvStrategies(
  strategies: readonly CscvStrategyFoldReturns[],
): CscvStrategyFoldReturns[] {
  if (strategies.length < 2) {
    throw new Error("CSCV/PBO needs at least two strategies.");
  }

  const foldCount = strategies[0]?.folds.length ?? 0;

  if (foldCount < 2) {
    throw new Error("CSCV/PBO needs at least two folds.");
  }

  return strategies.map((strategy) => {
    if (!strategy.id.trim()) {
      throw new Error("CSCV/PBO strategy id must be non-empty.");
    }

    if (strategy.folds.length !== foldCount) {
      throw new Error("CSCV/PBO strategies must have the same fold count.");
    }

    return {
      id: strategy.id,
      folds: strategy.folds.map((fold) => finiteValues(fold)),
    };
  });
}

function scoreFolds(
  folds: readonly (readonly number[])[],
  indexes: readonly number[],
  statistic: ReturnSeriesStatistic,
): number {
  return statisticValue(
    indexes.flatMap((index) => folds[index] ?? []),
    statistic,
  );
}

function statisticValueFromStats(
  stats: ReturnSeriesStats,
  statistic: ReturnSeriesStatistic,
): number {
  if (statistic === "mean") {
    return stats.mean;
  }

  if (statistic === "sharpe") {
    return stats.sharpe;
  }

  return stats.compoundReturn;
}

function statisticValue(
  returns: readonly number[],
  statistic: ReturnSeriesStatistic,
): number {
  const stats = summarizeReturnSeries(returns);
  return statisticValueFromStats(stats, statistic);
}

function sharpeStandardError(stats: ReturnSeriesStats): number {
  if (stats.sampleCount < 2) {
    return 0;
  }

  const variance =
    1 -
    stats.skewness * stats.sharpe +
    ((stats.kurtosis - 1) / 4) * stats.sharpe * stats.sharpe;

  return Math.sqrt(Math.max(EPSILON, variance) / (stats.sampleCount - 1));
}

export function expectedMaxStandardNormal(trialCount: number): number {
  if (trialCount <= 1) {
    return 0;
  }

  const first = inverseNormalCdf(1 - 1 / trialCount);
  const second = inverseNormalCdf(1 - 1 / (trialCount * Math.E));

  return (1 - EULER_GAMMA) * first + EULER_GAMMA * second;
}

export function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-x * x);

  return sign * y;
}

export function inverseNormalCdf(probability: number): number {
  const p = clamp(probability, EPSILON, 1 - EPSILON);
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;

  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
    q
  ) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function skewness(values: readonly number[], mean: number, stdDev: number): number {
  if (values.length < 3 || stdDev <= EPSILON) {
    return 0;
  }

  const thirdMoment = average(values.map((value) => ((value - mean) / stdDev) ** 3));

  return Number.isFinite(thirdMoment) ? thirdMoment : 0;
}

function kurtosis(values: readonly number[], mean: number, stdDev: number): number {
  if (values.length < 4 || stdDev <= EPSILON) {
    return 3;
  }

  const fourthMoment = average(values.map((value) => ((value - mean) / stdDev) ** 4));

  return Number.isFinite(fourthMoment) ? fourthMoment : 3;
}

function compoundReturn(values: readonly number[]): number {
  let logReturn = 0;

  for (const value of values) {
    if (value <= -1) {
      return -1;
    }

    logReturn += Math.log1p(value);
  }

  return Math.expm1(logReturn);
}

function finiteValues(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStdDev(values: readonly number[], mean: number): number {
  if (values.length < 2) {
    return 0;
  }

  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);

  return Math.sqrt(Math.max(0, variance));
}

function quantileSorted(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const bounded = clamp(quantile, 0, 1);
  const position = (values.length - 1) * bounded;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return values[lower] ?? 0;
  }

  const weight = position - lower;
  return (values[lower] ?? 0) * (1 - weight) + (values[upper] ?? 0) * weight;
}

function combinations(values: readonly number[], size: number): number[][] {
  const output: number[][] = [];

  function visit(start: number, current: number[]): void {
    if (current.length === size) {
      output.push([...current]);
      return;
    }

    for (let index = start; index < values.length; index += 1) {
      current.push(values[index]);
      visit(index + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return output;
}

function thresholdCandidateId(
  candidate: ThresholdSensitivityCandidate,
  index: number,
): string {
  if (Number.isFinite(candidate.threshold)) {
    return `threshold:${candidate.threshold}`;
  }

  if (
    Number.isFinite(candidate.longThreshold) ||
    Number.isFinite(candidate.shortThreshold)
  ) {
    return `long:${candidate.longThreshold ?? "na"}|short:${candidate.shortThreshold ?? "na"}`;
  }

  return `candidate:${index}`;
}

function thresholdDistance(
  left: ThresholdSensitivityRow,
  right: ThresholdSensitivityRow,
): number {
  const distances = [
    normalizedFieldDistance(left.threshold, right.threshold),
    normalizedFieldDistance(left.longThreshold, right.longThreshold),
    normalizedFieldDistance(left.shortThreshold, right.shortThreshold),
  ].filter((value) => value !== null);

  return distances.length === 0 ? 0 : Math.max(...distances);
}

function normalizedFieldDistance(
  left: number | null,
  right: number | null,
): number | null {
  return left === null || right === null ? null : Math.abs(left - right);
}

function compareThresholdRows(
  left: ThresholdSensitivityRow,
  right: ThresholdSensitivityRow,
): number {
  return (
    (left.threshold ?? left.longThreshold ?? 0) -
      (right.threshold ?? right.longThreshold ?? 0) ||
    (left.shortThreshold ?? 0) - (right.shortThreshold ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function finiteOrNull(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
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
