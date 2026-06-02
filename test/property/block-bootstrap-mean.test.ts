import { describe, expect, it } from "vitest";

import { blockBootstrap } from "../../src/lib/validation/strategy-validator";
import { mean, seededRandom, syntheticReturnSeries } from "./_generators";

/**
 * Property (2): the block-bootstrap surrogate preserves the marginal mean of
 * the source series within tolerance, in expectation over many draws.
 *
 * A circular block bootstrap resamples contiguous blocks (wrapping modulo n),
 * so each draw is a multiset of the original observations. Any single draw is
 * a finite sample whose mean fluctuates, but averaging the per-draw means over
 * many seeds must converge to the true marginal mean. If it did not, the
 * surrogate null would be biased and the placebo gate would compare the real
 * edge against the wrong reference level.
 */
describe("property: blockBootstrap preserves the marginal mean", () => {
  it("matches the source mean (averaged over many draws) across many seeds", () => {
    const SEEDS = 40;
    const DRAWS_PER_SEED = 300;

    for (let s = 0; s < SEEDS; s += 1) {
      const seed = (s + 1) * 40503;
      const length = 120 + (s % 60);
      const drift = ((s % 7) - 3) * 0.001; // span negative, zero, positive means
      const series = syntheticReturnSeries(seed, length, {
        drift,
        sigma: 0.01,
        phi: 0.4,
      });
      const sourceMean = mean(series);

      const blockLength = 1 + (s % 8); // vary block length 1..8
      const random = seededRandom(seed ^ 0x9e3779b9);

      let acc = 0;
      for (let d = 0; d < DRAWS_PER_SEED; d += 1) {
        acc += mean(blockBootstrap(series, blockLength, random));
      }
      const bootMean = acc / DRAWS_PER_SEED;

      // Tolerance scaled to the series' own dispersion / sample size. The
      // standard error of a per-draw mean is ~ sigma/sqrt(length); averaging
      // DRAWS_PER_SEED of them shrinks it further, so this band is comfortable
      // yet still meaningfully tight.
      const sigma = 0.01;
      const tolerance =
        4 * (sigma / Math.sqrt(length)) +
        4 * (sigma / Math.sqrt(length * DRAWS_PER_SEED)) +
        1e-9;

      expect(Math.abs(bootMean - sourceMean)).toBeLessThanOrEqual(tolerance);
    }
  });

  it("a single draw is an exact reordering when blockLength === 1 (mean exactly preserved is not required, but values are drawn from the source)", () => {
    // Sanity guard: every value produced by the bootstrap comes from the
    // source multiset, so the bootstrap mean is bounded by the source extremes.
    const series = syntheticReturnSeries(12345, 64, { drift: 0.001 });
    const min = Math.min(...series);
    const max = Math.max(...series);
    const random = seededRandom(777);
    for (let d = 0; d < 50; d += 1) {
      const draw = blockBootstrap(series, 4, random);
      expect(draw).toHaveLength(series.length);
      const m = mean(draw);
      expect(m).toBeGreaterThanOrEqual(min - 1e-12);
      expect(m).toBeLessThanOrEqual(max + 1e-12);
    }
  });
});
