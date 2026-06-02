/**
 * IAAFT — Iterative Amplitude-Adjusted Fourier Transform surrogate
 * (Schreiber & Schmitz 1996).
 *
 * The plain phase-randomized surrogate (`phaseRandomize` in
 * ../validation/strategy-validator) preserves the POWER SPECTRUM exactly but, by
 * adding many independent phases, drives the marginal toward a Gaussian — so it
 * does NOT preserve the amplitude DISTRIBUTION of a fat-tailed / skewed return
 * series. IAAFT fixes exactly that: it preserves BOTH
 *   (a) the exact sorted-amplitude set (the empirical marginal distribution), and
 *   (b) the power spectrum to a close approximation,
 * by alternately (1) rank-remapping the iterate's values back onto the original
 * sorted amplitudes and (2) replacing the iterate's Fourier amplitudes with the
 * target amplitudes while keeping its phases. The fixed point of that alternation
 * is a series that is a permutation-preserving re-ordering of the data with
 * (almost) the original autocorrelation.
 *
 * This is the right TEMPORAL null when the claim depends on the marginal's tails
 * (e.g. a vol/tail strategy): a Gaussianizing phase surrogate would understate the
 * tail and make the strategy look special for the wrong reason. IAAFT keeps the
 * exact tail and only destroys the temporal ORDERING beyond second order.
 *
 * Pure & deterministic given the seeded `random`. No I/O.
 */

import { dft, idft } from "./fft";

export interface IaaftOptions {
  /** Maximum refinement iterations. Default 200 (typically converges in <50). */
  maxIterations?: number;
  /**
   * Convergence tolerance on the relative change of the spectrum-match error
   * between iterations. Default 1e-8. Once the iterate stops moving, we stop.
   */
  tolerance?: number;
}

export interface IaaftResult {
  /** The surrogate series (a permutation of the input's amplitudes). */
  surrogate: number[];
  /** Iterations actually run before convergence / the cap. */
  iterations: number;
  /** Whether the iteration converged before hitting `maxIterations`. */
  converged: boolean;
}

/**
 * Generate one IAAFT surrogate of `series`. Returns the surrogate plus convergence
 * metadata. For a series shorter than 4 points there is no spectrum to preserve, so
 * the input is returned unchanged.
 */
export function iaaftSurrogate(
  series: readonly number[],
  random: () => number,
  options: IaaftOptions = {},
): IaaftResult {
  const x = finite(series);
  const n = x.length;
  if (n < 4) {
    return { surrogate: [...x], iterations: 0, converged: true };
  }

  const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? 200));
  const tolerance = options.tolerance ?? 1e-8;

  // Target invariants: the sorted amplitude set and the target Fourier amplitudes.
  const sortedTarget = [...x].sort((a, b) => a - b);
  const { re: srcRe, im: srcIm } = dft(x);
  const targetAmp = new Array<number>(n);
  for (let k = 0; k < n; k += 1) {
    targetAmp[k] = Math.hypot(srcRe[k]!, srcIm[k]!);
  }

  // Start from a random shuffle of the data (a valid amplitude-preserving state).
  let iterate = shuffle(x, random);
  // Track the marginal-exact iterate with the SMALLEST spectral error seen, so a
  // late iteration that happens to overshoot can never make the result worse.
  let best = iterate;
  let bestError = Number.POSITIVE_INFINITY;

  let prevError = Number.POSITIVE_INFINITY;
  let iterations = 0;
  let converged = false;

  for (let it = 0; it < maxIterations; it += 1) {
    iterations = it + 1;

    // Step 1 — impose the target power spectrum: keep the iterate's PHASES but
    // swap in the target AMPLITUDES, then invert.
    const { re, im } = dft(iterate);
    const newRe = new Array<number>(n);
    const newIm = new Array<number>(n);
    let specError = 0;
    for (let k = 0; k < n; k += 1) {
      const amp = Math.hypot(re[k]!, im[k]!);
      const scale = amp > 1e-300 ? targetAmp[k]! / amp : 0;
      newRe[k] = re[k]! * scale;
      newIm[k] = im[k]! * scale;
      const dAmp = amp - targetAmp[k]!;
      specError += dAmp * dAmp;
    }
    const spectral = idft(newRe, newIm);

    // Step 2 — impose the exact marginal: rank-remap the spectral iterate's values
    // back onto the original sorted amplitudes. This restores the EXACT amplitude
    // set (so the sorted-amplitude invariant holds) at the cost of a small spectrum
    // perturbation — which the next iteration shrinks.
    iterate = rankRemap(spectral, sortedTarget);

    // `specError` measures how far the iterate's spectrum was BEFORE this step's
    // amplitude swap — the standard IAAFT objective. Keep the best marginal-exact
    // iterate seen so far.
    if (specError < bestError) {
      bestError = specError;
      best = iterate;
    }

    // Convergence: the spectrum-match error stops improving (the iterate has
    // settled into its fixed point and is only cycling on float noise).
    const denom = Math.max(prevError, 1e-300);
    const relChange = Math.abs(prevError - specError) / denom;
    if (it > 0 && relChange < tolerance) {
      converged = true;
      break;
    }
    prevError = specError;
  }

  return { surrogate: best, iterations, converged };
}

/**
 * Rank-remap: produce a series with the EXACT multiset `sortedTarget` whose values
 * follow the rank order of `reference`. The i-th smallest output value goes to the
 * position holding the i-th smallest reference value. Ties in the reference are
 * broken by index so the map is deterministic.
 */
function rankRemap(reference: readonly number[], sortedTarget: readonly number[]): number[] {
  const n = reference.length;
  const order = reference.map((value, index) => ({ value, index }));
  order.sort((a, b) => a.value - b.value || a.index - b.index);
  const out = new Array<number>(n).fill(0);
  for (let rank = 0; rank < n; rank += 1) {
    out[order[rank]!.index] = sortedTarget[rank]!;
  }
  return out;
}

/** Fisher-Yates shuffle of `values`, driven by the seeded `random`. Pure (copies). */
function shuffle(values: readonly number[], random: () => number): number[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function finite(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}
