import { describe, expect, it } from "vitest";

import { phaseRandomize } from "../../src/lib/validation/strategy-validator";
import {
  circularLag1Autocorrelation,
  lag1Autocorrelation,
  mean,
  populationVariance,
  seededRandom,
  syntheticReturnSeries,
} from "./_generators";

/**
 * Property (3): phase randomization preserves variance and lag-1
 * autocorrelation within tolerance.
 *
 * A phase-randomized surrogate keeps the amplitude spectrum and only scrambles
 * the phases, so by Parseval the variance is invariant and the (circular)
 * autocovariance function - hence lag-1 autocorrelation - is invariant too.
 * This is precisely what makes it a valid null for TEMPORAL/STRUCTURE edges:
 * it must keep the linear second-order structure a momentum/regime fitter
 * feeds on while destroying nonlinear structure. If it drifted the variance or
 * autocorrelation, the surrogate gate would test the wrong null.
 *
 * Variance and the CIRCULAR lag-1 autocorrelation are preserved essentially
 * exactly on every single draw (they are exact spectral invariants). The
 * standard LINEAR (edge-truncated) lag-1 estimator is preserved only in
 * expectation, so it is checked as an average over many draws with a looser
 * band.
 */
describe("property: phaseRandomize preserves variance and lag-1 autocorrelation", () => {
  it("preserves variance and circular lag-1 autocorrelation on every draw, across many seeds", () => {
    const SEEDS = 40;
    const DRAWS_PER_SEED = 25;

    for (let s = 0; s < SEEDS; s += 1) {
      const seed = (s + 1) * 2246822519;
      const length = 64 + (s % 96);
      const series = syntheticReturnSeries(seed, length, {
        drift: ((s % 5) - 2) * 0.001,
        sigma: 0.01,
        phi: 0.2 + 0.01 * (s % 30),
      });

      const sourceVar = populationVariance(series);
      const sourceCircAc = circularLag1Autocorrelation(series);
      const random = seededRandom(seed ^ 0x85ebca6b);

      for (let d = 0; d < DRAWS_PER_SEED; d += 1) {
        const surrogate = phaseRandomize(series, random);
        expect(surrogate).toHaveLength(series.length);

        const surVar = populationVariance(surrogate);
        const surCircAc = circularLag1Autocorrelation(surrogate);

        // Variance is an exact spectral invariant: tiny relative tolerance.
        expect(relativeError(surVar, sourceVar)).toBeLessThanOrEqual(1e-9);
        // Circular lag-1 autocorrelation is also an exact invariant.
        expect(Math.abs(surCircAc - sourceCircAc)).toBeLessThanOrEqual(1e-7);
      }
    }
  });

  it("preserves the standard (linear) lag-1 autocorrelation in expectation", () => {
    const SEEDS = 24;
    const DRAWS_PER_SEED = 400;

    for (let s = 0; s < SEEDS; s += 1) {
      const seed = (s + 1) * 374761393;
      const length = 96 + (s % 80);
      const series = syntheticReturnSeries(seed, length, {
        drift: 0,
        sigma: 0.01,
        phi: 0.3 + 0.005 * s,
      });
      const sourceLinearAc = lag1Autocorrelation(series);

      const random = seededRandom(seed ^ 0xc2b2ae35);
      let acc = 0;
      for (let d = 0; d < DRAWS_PER_SEED; d += 1) {
        acc += lag1Autocorrelation(phaseRandomize(series, random));
      }
      const meanLinearAc = acc / DRAWS_PER_SEED;

      // Edge effects make a single draw scatter by ~0.1; the average over many
      // draws converges back to the source value well inside this band.
      expect(Math.abs(meanLinearAc - sourceLinearAc)).toBeLessThanOrEqual(0.08);
    }
  });

  it("does not shift the mean (phase randomization re-centers on the source mean)", () => {
    const series = syntheticReturnSeries(135791113, 128, {
      drift: 0.002,
      sigma: 0.01,
      phi: 0.4,
    });
    const sourceMean = mean(series);
    const random = seededRandom(424242);
    for (let d = 0; d < 50; d += 1) {
      const surrogate = phaseRandomize(series, random);
      expect(Math.abs(mean(surrogate) - sourceMean)).toBeLessThanOrEqual(1e-9);
    }
  });
});

function relativeError(value: number, reference: number): number {
  const denom = Math.max(Math.abs(reference), 1e-15);
  return Math.abs(value - reference) / denom;
}
