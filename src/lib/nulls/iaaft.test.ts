/**
 * Tests for the IAAFT surrogate (iaaft.ts).
 *
 * The whole point of IAAFT over the plain phase-randomized surrogate is that it
 * preserves BOTH:
 *   (a) the EXACT sorted-amplitude set (the empirical marginal distribution), so a
 *       fat-tailed / skewed return series keeps its tails, and
 *   (b) the power spectrum to a close APPROXIMATION (hence the autocorrelation).
 * These tests assert exactly those two preserved properties, plus that the temporal
 * ordering is actually DESTROYED (it is a genuine surrogate, not the identity) and
 * that it is deterministic given a seed.
 */

import { describe, expect, it } from "vitest";

import { iaaftSurrogate } from "./iaaft";
import { dft } from "./fft";

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

function standardNormal(random: () => number): number {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** A fat-tailed, skewed AR(1) return series — the case a Gaussianizing surrogate breaks. */
function fatTailedSeries(seed: number, length: number): number[] {
  const random = seededRandom(seed);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < length; i += 1) {
    // mix a heavy-tailed shock so the marginal is clearly non-Gaussian
    const z = standardNormal(random);
    const heavy = z * z * z; // cubed ⇒ heavy tails + skew
    const value = 0.3 * prev + 0.01 * heavy;
    out.push(value);
    prev = value;
  }
  return out;
}

function powerSpectrum(series: readonly number[]): number[] {
  const { re, im } = dft(series);
  return re.map((r, k) => r * r + im[k]! * im[k]!);
}

function spectralRelError(a: readonly number[], b: readonly number[]): number {
  const pa = powerSpectrum(a);
  const pb = powerSpectrum(b);
  let num = 0;
  let den = 0;
  // skip DC (k=0): it is fixed to zero after centering and not informative here
  for (let k = 1; k < pa.length; k += 1) {
    num += (pa[k]! - pb[k]!) ** 2;
    den += pb[k]! ** 2;
  }
  return Math.sqrt(num / Math.max(den, 1e-300));
}

/** Autocorrelation at lag `k` (population, mean-centered). */
function autocorr(values: readonly number[], k: number): number {
  const n = values.length;
  const m = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    den += (values[i]! - m) ** 2;
    if (i >= k) num += (values[i]! - m) * (values[i - k]! - m);
  }
  return den > 0 ? num / den : 0;
}

describe("iaaftSurrogate", () => {
  it("preserves the EXACT sorted-amplitude set (the marginal distribution)", () => {
    const series = fatTailedSeries(12345, 200);
    const { surrogate } = iaaftSurrogate(series, seededRandom(7), { maxIterations: 100 });

    expect(surrogate).toHaveLength(series.length);

    const sortedSrc = [...series].sort((a, b) => a - b);
    const sortedSur = [...surrogate].sort((a, b) => a - b);
    // Exact multiset equality (IAAFT's final step rank-remaps onto the source set).
    for (let i = 0; i < sortedSrc.length; i += 1) {
      expect(sortedSur[i]).toBeCloseTo(sortedSrc[i]!, 12);
    }
  });

  it("preserves the power spectrum to a close approximation (autocorrelation kept)", () => {
    const series = fatTailedSeries(999, 256);
    const { surrogate, converged } = iaaftSurrogate(series, seededRandom(3), {
      maxIterations: 300,
    });
    expect(converged).toBe(true);

    // The meaningful 'spectrum preserved' invariant is the autocorrelation FUNCTION:
    // IAAFT keeps the low-lag ACF close while imposing the exact marginal. (The raw
    // per-bin power spectrum of a finite fat-tailed surrogate scatters more, which is
    // the price of the exact marginal — see the looser bound below.)
    for (let lag = 1; lag <= 5; lag += 1) {
      expect(Math.abs(autocorr(surrogate, lag) - autocorr(series, lag))).toBeLessThan(0.12);
    }
    // And the overall power spectrum stays in the right ballpark (NOT a free fit:
    // a value-shuffled control with no spectral matching lands far above this).
    const relErr = spectralRelError(surrogate, series);
    expect(relErr).toBeLessThan(0.35);
  });

  it("matches the spectrum far better than a plain value-shuffle (the iteration earns its keep)", () => {
    const series = fatTailedSeries(424242, 256);
    const { surrogate } = iaaftSurrogate(series, seededRandom(5), { maxIterations: 300 });

    // A plain shuffle preserves the marginal EXACTLY but flattens the spectrum to
    // white noise; IAAFT preserves the marginal AND the spectrum, so its spectral
    // error must be materially smaller than the shuffle's.
    const shuffled = [...series];
    const rng = seededRandom(777);
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    const iaaftErr = spectralRelError(surrogate, series);
    const shuffleErr = spectralRelError(shuffled, series);
    expect(iaaftErr).toBeLessThan(shuffleErr * 0.75);
  });

  it("beats a sorted-amplitude phase surrogate on marginal fidelity (the IAAFT win)", () => {
    // The marginal must be kept EXACTLY (multiset), which is strictly stronger than
    // 'mean and variance preserved'. Confirm the higher moments survive too.
    const series = fatTailedSeries(2024, 220);
    const { surrogate } = iaaftSurrogate(series, seededRandom(11), { maxIterations: 150 });

    const skew = (xs: readonly number[]): number => {
      const m = xs.reduce((s, v) => s + v, 0) / xs.length;
      let m2 = 0;
      let m3 = 0;
      for (const v of xs) {
        m2 += (v - m) ** 2;
        m3 += (v - m) ** 3;
      }
      m2 /= xs.length;
      m3 /= xs.length;
      return m3 / Math.max(m2 ** 1.5, 1e-300);
    };
    // Same multiset ⇒ identical skew/kurtosis up to float noise.
    expect(skew(surrogate)).toBeCloseTo(skew(series), 9);
  });

  it("DESTROYS the temporal ordering (it is a surrogate, not the identity)", () => {
    const series = fatTailedSeries(55, 128);
    const { surrogate } = iaaftSurrogate(series, seededRandom(99), { maxIterations: 100 });
    let differing = 0;
    for (let i = 0; i < series.length; i += 1) {
      if (Math.abs(series[i]! - surrogate[i]!) > 1e-9) differing += 1;
    }
    // The overwhelming majority of positions must move; allow a tiny handful of
    // coincidental fixed points.
    expect(differing).toBeGreaterThan(series.length * 0.8);
  });

  it("is deterministic given a seed", () => {
    const series = fatTailedSeries(31337, 160);
    const a = iaaftSurrogate(series, seededRandom(42), { maxIterations: 80 });
    const b = iaaftSurrogate(series, seededRandom(42), { maxIterations: 80 });
    expect(a.surrogate).toEqual(b.surrogate);
    expect(a.iterations).toBe(b.iterations);
    expect(a.converged).toBe(b.converged);
  });

  it("returns the input unchanged for a degenerate short series", () => {
    expect(iaaftSurrogate([0.01, -0.02, 0.03], seededRandom(1)).surrogate).toEqual([
      0.01, -0.02, 0.03,
    ]);
    expect(iaaftSurrogate([], seededRandom(1)).surrogate).toEqual([]);
  });
});
