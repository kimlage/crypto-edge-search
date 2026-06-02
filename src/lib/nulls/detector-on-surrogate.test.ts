/**
 * Tests for the detector-on-surrogate null (detector-on-surrogate.ts).
 *
 * The key behavioral property: a detector that keys on genuine NONLINEAR structure —
 * here, the TIME-REVERSAL ASYMMETRY of a sawtooth (slow rise, fast fall) — scores
 * HIGHER on the real series than on its phase-randomized surrogates, so its right-tail
 * p is small. Phase randomization preserves the power spectrum (hence variance and
 * autocorrelation) but, by re-randomizing phases, symmetrizes the series in time and
 * destroys exactly this asymmetry — the textbook case where the detector-specific null
 * is the right one. On pure noise the same detector is INDISTINGUISHABLE from the null
 * (p not small). Plus: identical detector applied to real vs surrogate, determinism.
 */

import { describe, expect, it } from "vitest";

import {
  detectorOnSurrogate,
  type Detector,
  type DetectorScore,
} from "./detector-on-surrogate";
import { phaseRandomize } from "../validation/strategy-validator";

/** mulberry32, matching the harness's seeded RNG. */
function seededRandom(seed: number): () => number {
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
 * Detector: emit the per-step price increments (a "signal" per step). The detector
 * itself is linear/trivial; the DISCRIMINATING power lives in the score below, which
 * is a nonlinear (cubic) functional of these increments. This separation is exactly
 * what a chart-pattern detector + a pattern-strength score look like.
 */
const incrementDetector: Detector<number> = (series) => {
  const out: number[] = [];
  for (let i = 1; i < series.length; i += 1) out.push(series[i]! - series[i - 1]!);
  return out;
};

/**
 * Time-reversal asymmetry score: |mean(increment^3)|. A sawtooth's slow rise / fast
 * fall makes the increment distribution skewed (many small positives, few large
 * negatives), so the cubed mean is clearly nonzero. Phase randomization symmetrizes
 * the increments, driving this toward zero — the property the null destroys.
 */
const asymmetryScore: DetectorScore<number> = (increments) => {
  if (increments.length === 0) return 0;
  let acc = 0;
  for (const d of increments) acc += d * d * d;
  return Math.abs(acc / increments.length);
};

/**
 * An asymmetric sawtooth: a slow linear rise over (period - fall) steps then a fast
 * drop over `fall` steps, plus modest noise so the POWER SPECTRUM is not dominated by
 * the motif (which would let surrogates inherit it). The asymmetry — not the spectrum —
 * is the planted nonlinear structure.
 */
function plantedPatternSeries(seed: number, length: number): number[] {
  const random = seededRandom(seed);
  const period = 16;
  const fall = 2;
  const amp = 1.0;
  const noise = 0.2;
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const phase = i % period;
    let value: number;
    if (phase < period - fall) {
      value = amp * (phase / (period - fall)); // slow rise
    } else {
      const fp = phase - (period - fall);
      value = amp * (1 - (fp + 1) / fall); // fast fall
    }
    out.push(value + noise * (random() - 0.5));
  }
  return out;
}

/** Pure noise — no planted structure. */
function noiseSeries(seed: number, length: number): number[] {
  const random = seededRandom(seed);
  return Array.from({ length }, () => random() - 0.5);
}

describe("detectorOnSurrogate", () => {
  it("scores planted structure HIGHER than its surrogates (small right-tail p)", () => {
    const series = plantedPatternSeries(12345, 1200);
    const result = detectorOnSurrogate(series, incrementDetector, seededRandom(7), {
      count: 200,
      score: asymmetryScore,
    });

    expect(result.surrogateScores).toHaveLength(200);
    // The sawtooth's time-reversal asymmetry is far above what the spectrum alone
    // produces: the real score exceeds the surrogate mean by a wide margin.
    const surrMean =
      result.surrogateScores.reduce((s, v) => s + v, 0) / result.surrogateScores.length;
    expect(result.realScore).toBeGreaterThan(surrMean);
    // And the right-tail p is small — the asymmetry is significant under this null.
    expect(result.p).toBeLessThan(0.05);
  });

  it("is INDISTINGUISHABLE from the null on pure noise (p not small)", () => {
    const series = noiseSeries(98765, 1200);
    const result = detectorOnSurrogate(series, incrementDetector, seededRandom(11), {
      count: 200,
      score: asymmetryScore,
    });
    // No planted asymmetry: the real score sits inside the surrogate cloud, so the
    // right-tail p is not significant.
    expect(result.p).toBeGreaterThan(0.05);
  });

  it("applies the IDENTICAL detector + score to real vs surrogate paths", () => {
    const series = plantedPatternSeries(2024, 400);
    const procRandom = seededRandom(5);
    const result = detectorOnSurrogate(series, incrementDetector, procRandom, {
      count: 3,
      score: asymmetryScore,
    });

    // Real score equals the detector + score run directly on the real series.
    expect(result.realScore).toBe(asymmetryScore(incrementDetector(series)));

    // Reproduce the first surrogate and confirm the first surrogate score matches.
    const checkRandom = seededRandom(5);
    const firstSurrogate = phaseRandomize(series, checkRandom);
    expect(result.surrogateScores[0]).toBe(asymmetryScore(incrementDetector(firstSurrogate)));
  });

  it("defaults to the signal COUNT when no scorer is given", () => {
    const series = plantedPatternSeries(777, 300);
    const result = detectorOnSurrogate(series, incrementDetector, seededRandom(1), {
      count: 5,
    });
    // Default score is the number of signals the detector emitted.
    expect(result.realScore).toBe(incrementDetector(series).length);
  });

  it("is deterministic given a seed", () => {
    const series = plantedPatternSeries(31337, 300);
    const a = detectorOnSurrogate(series, incrementDetector, seededRandom(42), {
      count: 30,
      score: asymmetryScore,
    });
    const b = detectorOnSurrogate(series, incrementDetector, seededRandom(42), {
      count: 30,
      score: asymmetryScore,
    });
    expect(a.realScore).toBe(b.realScore);
    expect(a.surrogateScores).toEqual(b.surrogateScores);
    expect(a.p).toBe(b.p);
  });
});
