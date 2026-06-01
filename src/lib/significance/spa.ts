/**
 * Superior Predictive Ability (roadmap A5).
 *
 * When the "best" of many strategies is selected, its apparent outperformance may
 * be pure data-snooping. Two complementary tests gate that:
 *  - Hansen's SPA (2005): a single p-value for H0 "no strategy beats the benchmark",
 *    via a stationary block bootstrap of the studentized max statistic (the
 *    consistent SPAc recentering is used). Generalizes White's Reality Check (2000).
 *  - Romano & Wolf (2005) stepwise: which strategies are genuinely superior while
 *    controlling the family-wise error rate, via stepwise bootstrap.
 *
 * Inputs are per-period excess returns vs the benchmark (positive = outperformance),
 * one equal-length series per strategy. Pure and deterministic (seeded bootstrap).
 */

export interface SpaStrategy {
  id: string;
  /** Per-period returns in excess of the benchmark (loss differential d_k). */
  excessReturns: readonly number[];
}

export interface SpaOptions {
  iterations?: number;
  /** Expected stationary-bootstrap block length (geometric). Default sqrt(n). */
  blockLength?: number;
  seed?: number | string;
}

export interface SpaResult {
  strategyCount: number;
  sampleCount: number;
  iterations: number;
  blockLength: number;
  bestStrategyId: string | null;
  /** Studentized statistic of the best strategy: max_k sqrt(n)·d̄_k/ω_k. */
  testStatistic: number;
  /** Hansen consistent SPA p-value (fraction of bootstrap maxima ≥ observed). */
  pValue: number;
  perStrategy: { id: string; meanExcess: number; studentized: number }[];
}

export interface RomanoWolfOptions extends SpaOptions {
  alpha?: number;
}

export interface RomanoWolfResult {
  strategyCount: number;
  sampleCount: number;
  alpha: number;
  rejected: string[];
  perStrategy: { id: string; meanExcess: number; studentized: number; rejected: boolean }[];
}

const EPSILON = 1e-12;

export function superiorPredictiveAbility(
  strategies: readonly SpaStrategy[],
  options: SpaOptions = {},
): SpaResult {
  const prep = prepare(strategies);
  const { n, series, ids } = prep;
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1000));
  const blockLength = clampBlock(options.blockLength, n);

  if (n < 2 || series.length === 0) {
    return {
      strategyCount: series.length,
      sampleCount: n,
      iterations,
      blockLength,
      bestStrategyId: ids[0] ?? null,
      testStatistic: 0,
      pValue: 1,
      perStrategy: series.map((s, k) => ({ id: ids[k], meanExcess: s.mean, studentized: 0 })),
    };
  }

  const studentized = series.map((s) => (s.omega > EPSILON ? (Math.sqrt(n) * s.mean) / s.omega : 0));
  const testStatistic = Math.max(0, ...studentized);
  const bestIndex = studentized.reduce((best, value, idx) => (value > studentized[best] ? idx : best), 0);

  // SPAc recentering threshold: keep d̄_k only if it is not "too negative".
  const threshold = Math.sqrt((2 * Math.log(Math.log(n))) || 0);
  const g = series.map((s, k) =>
    studentized[k] >= -threshold ? s.mean : 0,
  );

  const random = createSeededRandom(options.seed ?? "spa");
  let exceed = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const indexes = stationaryBootstrapIndexes(n, blockLength, random);
    let maxStat = 0;
    for (let k = 0; k < series.length; k += 1) {
      const s = series[k];
      if (s.omega <= EPSILON) continue;
      const resampledMean = meanAtIndexes(s.values, indexes);
      const stat = (Math.sqrt(n) * (resampledMean - g[k])) / s.omega;
      if (stat > maxStat) maxStat = stat;
    }
    if (maxStat >= testStatistic) exceed += 1;
  }

  return {
    strategyCount: series.length,
    sampleCount: n,
    iterations,
    blockLength,
    bestStrategyId: ids[bestIndex] ?? null,
    testStatistic,
    pValue: exceed / iterations,
    perStrategy: series.map((s, k) => ({ id: ids[k], meanExcess: s.mean, studentized: studentized[k] })),
  };
}

export function romanoWolfStepwise(
  strategies: readonly SpaStrategy[],
  options: RomanoWolfOptions = {},
): RomanoWolfResult {
  const prep = prepare(strategies);
  const { n, series, ids } = prep;
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1000));
  const blockLength = clampBlock(options.blockLength, n);
  const alpha = clamp(options.alpha ?? 0.05, EPSILON, 1 - EPSILON);

  const studentized = series.map((s) => (s.omega > EPSILON ? (Math.sqrt(n) * s.mean) / s.omega : 0));
  const rejected = new Set<number>();

  if (n >= 2 && series.length > 0) {
    const random = createSeededRandom(options.seed ?? "romano-wolf");
    // Precompute bootstrap resamples once (shared across stepwise rounds for determinism).
    const resamples = Array.from({ length: iterations }, () =>
      stationaryBootstrapIndexes(n, blockLength, random),
    );

    let active = series.map((_, k) => k).filter((k) => !rejected.has(k));
    let keepGoing = true;
    while (keepGoing && active.length > 0) {
      // bootstrap distribution of the max centered statistic over the active set
      const maxima = resamples.map((indexes) => {
        let maxStat = -Infinity;
        for (const k of active) {
          const s = series[k];
          if (s.omega <= EPSILON) continue;
          const resampledMean = meanAtIndexes(s.values, indexes);
          const stat = (Math.sqrt(n) * (resampledMean - s.mean)) / s.omega;
          if (stat > maxStat) maxStat = stat;
        }
        return Number.isFinite(maxStat) ? maxStat : 0;
      });
      const critical = quantileSorted([...maxima].sort((a, b) => a - b), 1 - alpha);
      const newlyRejected = active.filter((k) => studentized[k] > critical);
      if (newlyRejected.length === 0) {
        keepGoing = false;
      } else {
        for (const k of newlyRejected) rejected.add(k);
        active = active.filter((k) => !rejected.has(k));
      }
    }
  }

  return {
    strategyCount: series.length,
    sampleCount: n,
    alpha,
    rejected: [...rejected].map((k) => ids[k]).sort(),
    perStrategy: series.map((s, k) => ({
      id: ids[k],
      meanExcess: s.mean,
      studentized: studentized[k],
      rejected: rejected.has(k),
    })),
  };
}

interface PreparedSeries {
  values: number[];
  mean: number;
  omega: number;
}

function prepare(strategies: readonly SpaStrategy[]): {
  n: number;
  series: PreparedSeries[];
  ids: string[];
} {
  if (strategies.length === 0) {
    return { n: 0, series: [], ids: [] };
  }
  const n = Math.min(...strategies.map((s) => s.excessReturns.length));
  const ids = strategies.map((s) => s.id);
  const series = strategies.map((strategy) => {
    const values = strategy.excessReturns.slice(0, n).map((value) => (Number.isFinite(value) ? value : 0));
    const mean = values.length > 0 ? average(values) : 0;
    const omega = sampleStd(values, mean);
    return { values, mean, omega };
  });
  return { n, series, ids };
}

function stationaryBootstrapIndexes(
  n: number,
  expectedBlockLength: number,
  random: () => number,
): number[] {
  const p = 1 / Math.max(1, expectedBlockLength);
  const indexes: number[] = [];
  let current = Math.floor(random() * n);
  while (indexes.length < n) {
    indexes.push(current);
    if (random() < p) {
      current = Math.floor(random() * n);
    } else {
      current = (current + 1) % n;
    }
  }
  return indexes;
}

function meanAtIndexes(values: readonly number[], indexes: readonly number[]): number {
  let sum = 0;
  for (const index of indexes) sum += values[index] ?? 0;
  return indexes.length > 0 ? sum / indexes.length : 0;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function quantileSorted(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * clamp(quantile, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function clampBlock(blockLength: number | undefined, n: number): number {
  const fallback = Math.max(1, Math.round(Math.sqrt(Math.max(1, n))));
  if (blockLength === undefined || !Number.isFinite(blockLength) || blockLength <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(n, Math.round(blockLength)));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
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
