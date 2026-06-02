import { describe, expect, it } from "vitest";

import { computeDeflatedSharpeRatio } from "../../src/lib/statistical-validation";
import { syntheticReturnSeries } from "./_generators";

/**
 * Property (1): for a FIXED return series, the deflated Sharpe ratio is
 * monotonically non-increasing in `trialCount`.
 *
 * Inflating the number of trials raises the expected maximum of N independent
 * standard normals, which raises `expectedMaxSharpe`, which can only push the
 * deflated z-score (and therefore the deflated probability) down or leave it
 * flat. Searching a bigger grid must never make the SAME series look better -
 * that is the whole point of deflation, so it is the load-bearing invariant.
 */
describe("property: computeDeflatedSharpeRatio is monotone non-increasing in trialCount", () => {
  const trialCounts = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

  it("never increases deflatedProbability as trialCount grows, across many seeds", () => {
    const SEEDS = 64;
    for (let s = 0; s < SEEDS; s += 1) {
      const seed = (s + 1) * 2654435761;
      const length = 30 + (s % 40); // vary length to widen the search
      const drift = (s % 5) * 0.0015; // mix of zero-edge and weak-edge series
      const series = syntheticReturnSeries(seed, length, {
        drift,
        sigma: 0.01,
        phi: 0.25,
      });

      let previous = Number.POSITIVE_INFINITY;
      for (const trialCount of trialCounts) {
        const dsr = computeDeflatedSharpeRatio(series, { trialCount });
        // Allow a hair of floating-point slack; the relation is non-increasing.
        expect(dsr.deflatedProbability).toBeLessThanOrEqual(previous + 1e-12);
        // Probabilities are valid cdf outputs.
        expect(dsr.deflatedProbability).toBeGreaterThanOrEqual(0);
        expect(dsr.deflatedProbability).toBeLessThanOrEqual(1);
        previous = dsr.deflatedProbability;
      }
    }
  });

  it("never increases the deflated z-score as trialCount grows", () => {
    const series = syntheticReturnSeries(987654321, 48, {
      drift: 0.002,
      sigma: 0.012,
      phi: 0.3,
    });
    let previousZ = Number.POSITIVE_INFINITY;
    let previousExpectedMax = Number.NEGATIVE_INFINITY;
    for (const trialCount of trialCounts) {
      const dsr = computeDeflatedSharpeRatio(series, { trialCount });
      expect(dsr.zScore).toBeLessThanOrEqual(previousZ + 1e-12);
      // expectedMaxSharpe is the mechanism: it is non-decreasing in trials.
      expect(dsr.expectedMaxSharpe).toBeGreaterThanOrEqual(
        previousExpectedMax - 1e-12,
      );
      previousZ = dsr.zScore;
      previousExpectedMax = dsr.expectedMaxSharpe;
    }
  });
});
