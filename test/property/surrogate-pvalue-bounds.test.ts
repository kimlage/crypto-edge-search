import { describe, expect, it } from "vitest";

import {
  blockBootstrap,
  phaseRandomize,
} from "../../src/lib/validation/strategy-validator";
import { seededRandom, sharpe, syntheticReturnSeries } from "./_generators";

/**
 * Property (4): any surrogate p-value the primitives produce lies in [0, 1].
 *
 * A surrogate/placebo p-value is, by construction, the fraction of surrogate
 * draws whose score is greater-than-or-equal-to the real score. As a fraction
 * of a non-empty count it is mechanically a probability, but the gate's
 * verdicts (SURVIVE / PROMISING / KILL / DEFERRED) compare it against a bar, so
 * a value escaping [0, 1] would corrupt every downstream decision. This
 * property pins the invariant for two constructions:
 *
 *   (a) the single-best-config placebo p (phase + block surrogates), and
 *   (b) the FAMILY-WISE MAX-statistic p the audit mandates for a searched grid:
 *       rebuild every config on each surrogate draw, take the grid-max, and
 *       compare the real best to those maxima. This is the construction that
 *       prevents a searched grid from manufacturing a false edge.
 */

/** Single-config surrogate p: fraction of surrogate scores >= the real score. */
function singleConfigSurrogateP(
  series: readonly number[],
  random: () => number,
  iterations: number,
): number {
  const real = sharpe(series);
  const blockLength = Math.max(1, Math.round(Math.sqrt(series.length)));
  let geCount = 0;
  let total = 0;
  for (let i = 0; i < iterations; i += 1) {
    const phase = sharpe(phaseRandomize(series, random));
    const block = sharpe(blockBootstrap(series, blockLength, random));
    if (phase >= real) geCount += 1;
    if (block >= real) geCount += 1;
    total += 2;
  }
  return total === 0 ? 1 : geCount / total;
}

/**
 * Family-wise MAX-statistic surrogate p for a SEARCHED grid. On each surrogate
 * draw, every config is rebuilt on the SAME surrogate world and the grid-MAX
 * score is taken; the real grid-best is compared against the distribution of
 * those maxima. (The audit's decisive lesson: never use a single-best-config p
 * for a searched grid.)
 */
function familyWiseMaxSurrogateP(
  grid: readonly (readonly number[])[],
  random: () => number,
  iterations: number,
): number {
  const realBest = Math.max(...grid.map((series) => sharpe(series)));
  let geCount = 0;
  for (let i = 0; i < iterations; i += 1) {
    let surrogateMax = Number.NEGATIVE_INFINITY;
    for (const series of grid) {
      const blockLength = Math.max(1, Math.round(Math.sqrt(series.length)));
      // Alternate the two surrogate kinds so both are exercised in the family.
      const surrogate =
        i % 2 === 0
          ? phaseRandomize(series, random)
          : blockBootstrap(series, blockLength, random);
      surrogateMax = Math.max(surrogateMax, sharpe(surrogate));
    }
    if (surrogateMax >= realBest) geCount += 1;
  }
  return iterations === 0 ? 1 : geCount / iterations;
}

describe("property: surrogate p-values lie in [0, 1]", () => {
  it("single-config placebo p is a valid probability across many seeds", () => {
    const SEEDS = 48;
    for (let s = 0; s < SEEDS; s += 1) {
      const seed = (s + 1) * 1597334677;
      const length = 48 + (s % 80);
      // Mix true-zero-edge, weak-edge, and degenerate (tiny) series so we hit
      // both extremes (p near 0 and p near 1) and the constant-series guard.
      const drift = ((s % 6) - 2) * 0.0015;
      const sigma = s % 11 === 0 ? 0 : 0.01; // some constant series (sharpe -> 0)
      const series = syntheticReturnSeries(seed, length, {
        drift,
        sigma,
        phi: 0.3,
      });
      const random = seededRandom(seed ^ 0x27d4eb2f);
      const p = singleConfigSurrogateP(series, random, 120);

      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("family-wise MAX-statistic p (searched grid) is a valid probability across many seeds", () => {
    const SEEDS = 40;
    for (let s = 0; s < SEEDS; s += 1) {
      const gridSize = 3 + (s % 6);
      const length = 64 + (s % 64);
      const grid = Array.from({ length: gridSize }, (_unused, g) =>
        syntheticReturnSeries((s * 131 + g + 1) * 2654435761, length, {
          drift: (g - gridSize / 2) * 0.0008,
          sigma: 0.01,
          phi: 0.25,
        }),
      );
      const random = seededRandom((s + 1) ^ 0x165667b1);
      const p = familyWiseMaxSurrogateP(grid, random, 150);

      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("degenerate edges (every surrogate beats a zero/negative real) still produce p in [0, 1]", () => {
    // A constant series scores sharpe 0; surrogates also score ~0, so >= holds
    // broadly and p approaches 1 - but never exceeds it.
    const flat = new Array(64).fill(0.0);
    const random = seededRandom(20260602);
    const p = singleConfigSurrogateP(flat, random, 100);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});
