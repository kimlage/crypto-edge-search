/**
 * GARCH(1,1) zero-edge surrogate (Bollerslev 1986).
 *
 * Many "edges" in crypto are really just VOLATILITY CLUSTERING — quiet periods
 * follow quiet periods, storms follow storms — which a momentum/vol fitter can
 * monetize without any genuine directional predictability. The right null for such
 * a claim is a path that has the SAME vol-clustering dynamics but provably ZERO
 * drift: if the strategy still looks profitable on this null, its "edge" was the
 * clustering, not a real signal.
 *
 * We fit a GARCH(1,1) variance recursion to the series' squared (de-meaned)
 * returns,
 *     sigma_t^2 = omega + alpha * eps_{t-1}^2 + beta * sigma_{t-1}^2,
 * by a light method-of-moments calibration (closed-form, deterministic — no
 * optimizer), then simulate r_t = sigma_t * z_t with z_t ~ standard normal and
 * NO drift term. The simulated path therefore preserves the unconditional variance
 * and the volatility autocorrelation (the clustering) while having ~zero mean.
 *
 * Pure & deterministic given the seeded `random`. No I/O.
 */

export interface GarchParams {
  /** Constant variance term (omega > 0). */
  omega: number;
  /** ARCH coefficient (alpha ≥ 0): sensitivity to last period's squared shock. */
  alpha: number;
  /** GARCH coefficient (beta ≥ 0): persistence of past variance. */
  beta: number;
  /** Unconditional (long-run) variance = omega / (1 - alpha - beta). */
  unconditionalVariance: number;
}

export interface GarchSurrogateResult {
  /** The simulated zero-drift return path (same length as the input). */
  surrogate: number[];
  /** The calibrated GARCH(1,1) parameters. */
  params: GarchParams;
}

/**
 * Calibrate a GARCH(1,1) to `series` by method of moments and simulate one
 * zero-drift surrogate path of the same length.
 *
 * Calibration (deterministic, optimizer-free):
 *   - The unconditional variance V matches the sample variance of de-meaned returns.
 *   - Persistence (alpha + beta) is read from the lag-1 autocorrelation of squared
 *     de-meaned returns (the empirical clustering strength), clamped to (0, 0.999).
 *   - The ARCH/GARCH split uses a standard, well-conditioned crypto-like ratio
 *     (alpha ≈ 0.1 of the persistence), so alpha and beta are both ≥ 0 and the
 *     recursion is stationary.
 *   - omega = V * (1 - alpha - beta) keeps the long-run variance at V.
 */
export function garchSurrogate(
  series: readonly number[],
  random: () => number,
  overrides: Partial<Pick<GarchParams, "alpha" | "beta">> = {},
): GarchSurrogateResult {
  const x = finite(series);
  const n = x.length;
  const params = calibrateGarch(x, overrides);
  if (n === 0) return { surrogate: [], params };

  const { omega, alpha, beta, unconditionalVariance } = params;

  const out = new Array<number>(n).fill(0);
  // Seed the recursion at the long-run variance and a zero shock.
  let sigma2 = unconditionalVariance;
  let prevShockSq = unconditionalVariance;
  for (let t = 0; t < n; t += 1) {
    sigma2 = omega + alpha * prevShockSq + beta * sigma2;
    const sigma = Math.sqrt(Math.max(sigma2, 0));
    const z = standardNormal(random);
    const shock = sigma * z; // r_t = sigma_t * z_t — NO drift term
    out[t] = shock;
    prevShockSq = shock * shock;
  }
  return { surrogate: out, params };
}

/** Method-of-moments GARCH(1,1) calibration. Pure; no RNG, no optimizer. */
export function calibrateGarch(
  series: readonly number[],
  overrides: Partial<Pick<GarchParams, "alpha" | "beta">> = {},
): GarchParams {
  const x = finite(series);
  const n = x.length;
  if (n < 4) {
    // Degenerate: fall back to a tiny iid variance with no persistence.
    const v = populationVariance(x) || 1e-8;
    return { omega: v, alpha: 0, beta: 0, unconditionalVariance: v };
  }

  const m = mean(x);
  const centered = x.map((v) => v - m);
  const variance = Math.max(populationVariance(centered), 1e-12);

  // Clustering strength from the lag-1 autocorrelation of squared shocks. A high
  // value ⇒ strong persistence (alpha + beta near 1).
  const sq = centered.map((v) => v * v);
  const acf1 = Math.max(0, lag1Autocorrelation(sq));
  // Map clustering onto total persistence, clamped strictly inside the stationary
  // region so omega stays positive and the long-run variance is finite.
  const persistence = clamp(acf1, 0, 0.999);

  const alpha = overrides.alpha ?? clamp(0.1 * persistence, 0, persistence);
  const beta = overrides.beta ?? clamp(persistence - alpha, 0, 0.999);
  const omega = Math.max(variance * (1 - alpha - beta), 1e-12);

  return { omega, alpha, beta, unconditionalVariance: variance };
}

// ---------------------------------------------------------------------------
// Local numerics (pure)
// ---------------------------------------------------------------------------

/** Box-Muller standard-normal draw on top of a uniform generator. */
function standardNormal(random: () => number): number {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function lag1Autocorrelation(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const c = values[i]! - m;
    den += c * c;
    if (i > 0) num += (values[i - 1]! - m) * c;
  }
  return den > 0 ? num / den : 0;
}

function populationVariance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return acc / values.length;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

function finite(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}
