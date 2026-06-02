/**
 * Tiny, dependency-free seeded generators for the property tests.
 *
 * No external property-testing library is used (the repo ships only vitest +
 * tsx). Every generator below is a pure function of an integer seed, so each
 * property can be exercised across many seeds while staying fully
 * deterministic and reproducible.
 *
 * The PRNG is the same mulberry32 construction the production primitives use
 * (see `createSeededRandom` in src/lib/statistical-validation.ts and
 * src/lib/validation/strategy-validator.ts), reproduced here because that
 * helper is module-private and must not be exported by editing those files.
 */

/** Mulberry32 PRNG. Returns a function yielding uniforms in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Box-Muller standard-normal draw built on top of a uniform generator.
 * Deterministic given the underlying `random`.
 */
export function standardNormal(random: () => number): number {
  // Guard the log against an exact zero draw.
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A synthetic return series with light autocorrelation (AR(1)) plus an
 * optional drift, so it is non-trivial for the surrogate/bootstrap properties
 * (a pure-iid series would make autocorrelation tests vacuous).
 */
export function syntheticReturnSeries(
  seed: number,
  length: number,
  options: { drift?: number; sigma?: number; phi?: number } = {},
): number[] {
  const drift = options.drift ?? 0;
  const sigma = options.sigma ?? 0.01;
  const phi = options.phi ?? 0.3;
  const random = seededRandom(seed);
  const out: number[] = [];
  let previous = 0;
  for (let i = 0; i < length; i += 1) {
    const shock = standardNormal(random) * sigma;
    const value = drift + phi * previous + shock;
    out.push(value);
    previous = value - drift;
  }
  return out;
}

/** Arithmetic mean of a finite series. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population variance (divisor N) of a finite series. */
export function populationVariance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return acc / values.length;
}

/**
 * Circular lag-1 autocorrelation (population, mean-centered), wrapping the
 * index modulo n. This is the quantity the amplitude spectrum determines, so
 * phase randomization preserves it exactly (up to floating point). The linear
 * estimator below differs only by edge effects.
 */
export function circularLag1Autocorrelation(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const centered = values[i] - m;
    denominator += centered * centered;
    numerator += (values[(i - 1 + n) % n] - m) * centered;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/** Lag-1 autocorrelation (population, mean-centered) of a finite series. */
export function lag1Autocorrelation(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const centered = values[i] - m;
    denominator += centered * centered;
    if (i > 0) numerator += (values[i - 1] - m) * centered;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/** Sharpe-style score (mean / population stddev); 0 when degenerate. */
export function sharpe(values: readonly number[]): number {
  const v = populationVariance(values);
  if (v <= 0) return 0;
  return mean(values) / Math.sqrt(v);
}
