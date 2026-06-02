/**
 * Detector-on-surrogate null for chart-pattern / support-resistance / candlestick
 * claims.
 *
 * A pattern detector (head-and-shoulders, double-top, a candlestick rule, an S&R
 * bounce) emits signals; the claim is that its signals carry information. But ANY
 * detector fires on ordinary price wiggles, so "it fired N times" is not evidence.
 * The right null is detector-SPECIFIC: run the EXACT SAME detector over many
 * phase-randomized surrogates of the series — paths with the same power spectrum
 * (hence the same autocorrelation, variance, and overall "wiggliness") but with the
 * nonlinear pattern structure destroyed — and see whether the detector's score on the
 * real series stands out against that null distribution.
 *
 * The surrogate generator is the approved `phaseRandomize` from
 * ../validation/strategy-validator — never reimplemented here. Pure & deterministic
 * given the seeded `random`.
 */

import { phaseRandomize } from "../validation/strategy-validator";

/**
 * A detector maps a series to a list of signals. The shape of a signal is opaque to
 * this module; only the COUNT (and, optionally, a custom score) matters for the null.
 */
export type Detector<S = unknown> = (series: readonly number[]) => readonly S[];

/**
 * Reduce a detector's signal list to a scalar score. Defaults to the signal count —
 * "how strongly/often did the pattern fire". Provide a custom scorer to weight by
 * signal strength, confidence, etc.
 */
export type DetectorScore<S = unknown> = (signals: readonly S[]) => number;

export interface DetectorOnSurrogateOptions<S = unknown> {
  /** Number of phase-randomized surrogates in the null. Default 200. */
  count?: number;
  /** How to score a signal list. Default: the signal count. */
  score?: DetectorScore<S>;
}

export interface DetectorOnSurrogateResult {
  /** The detector's score on the REAL series. */
  realScore: number;
  /** The detector's score on each phase-randomized surrogate. */
  surrogateScores: number[];
  /**
   * One-sided right-tail p-value: P(surrogate score >= real score) with the +1/+1
   * finite-sample correction. Small ⇒ the real series has detector-relevant
   * structure beyond its linear/spectral content.
   */
  p: number;
}

/**
 * Run `detector` on the real series and on `count` phase-randomized surrogates,
 * returning the real score, the surrogate score distribution, and the right-tail
 * p-value. The detector and the scorer are applied IDENTICALLY to the real and
 * surrogate series — only the input path differs.
 */
export function detectorOnSurrogate<S = unknown>(
  series: readonly number[],
  detector: Detector<S>,
  random: () => number,
  options: DetectorOnSurrogateOptions<S> = {},
): DetectorOnSurrogateResult {
  const count = Math.max(1, Math.floor(options.count ?? 200));
  const score: DetectorScore<S> = options.score ?? ((signals) => signals.length);

  const realScore = score(detector(series));

  const surrogateScores: number[] = [];
  for (let s = 0; s < count; s += 1) {
    const surrogate = phaseRandomize(series, random);
    surrogateScores.push(score(detector(surrogate)));
  }

  const atLeast = surrogateScores.filter((v) => v >= realScore).length;
  const p = (atLeast + 1) / (count + 1);

  return { realScore, surrogateScores, p };
}
