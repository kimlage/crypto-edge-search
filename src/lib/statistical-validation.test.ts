import { describe, expect, it } from "vitest";
import {
  analyzeThresholdSensitivity,
  blockBootstrapConfidenceInterval,
  computeDeflatedSharpeRatio,
  computeProbabilisticSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "./statistical-validation";

describe("statistical validation", () => {
  it("computes PSR and DSR from non-normal return samples", () => {
    const returns = [
      0.011, 0.008, -0.003, 0.014, 0.006, -0.002, 0.009, 0.012,
      0.004, -0.001, 0.007, 0.01,
    ];
    const stats = summarizeReturnSeries(returns);
    const psr = computeProbabilisticSharpeRatio(returns, 0);
    const dsr = computeDeflatedSharpeRatio(returns, {
      benchmarkSharpe: 0,
      trialCount: 25,
    });

    expect(stats.sampleCount).toBe(returns.length);
    expect(stats.compoundReturn).toBeGreaterThan(0);
    expect(psr.probability).toBeGreaterThan(0.95);
    expect(dsr.expectedMaxSharpe).toBeGreaterThan(0);
    expect(dsr.deflatedProbability).toBeLessThan(psr.probability);
  });

  it("deflates the same return series harder when effective trials increase", () => {
    const returns = [
      0.014, 0.01, -0.002, 0.011, 0.007, -0.001, 0.009, 0.006,
      0.013, 0.004, -0.003, 0.008,
    ];
    const singleTrial = computeDeflatedSharpeRatio(returns, { trialCount: 1 });
    const manyTrials = computeDeflatedSharpeRatio(returns, { trialCount: 64 });

    expect(singleTrial.effectiveTrials).toBe(1);
    expect(manyTrials.effectiveTrials).toBe(64);
    expect(manyTrials.expectedMaxSharpe).toBeGreaterThan(
      singleTrial.expectedMaxSharpe,
    );
    expect(manyTrials.deflatedProbability).toBeLessThan(
      singleTrial.deflatedProbability,
    );
  });

  it("builds deterministic block bootstrap confidence intervals", () => {
    const returns = [
      0.01, -0.004, 0.006, 0.008, -0.003, 0.012, 0.004, -0.002,
      0.009, 0.003, -0.001, 0.007,
    ];
    const first = blockBootstrapConfidenceInterval(returns, {
      iterations: 250,
      blockLength: 3,
      seed: "bootstrap-fixture",
    });
    const second = blockBootstrapConfidenceInterval(returns, {
      iterations: 250,
      blockLength: 3,
      seed: "bootstrap-fixture",
    });

    expect(first.samples).toHaveLength(250);
    expect(first).toEqual(second);
    expect(first.lower).toBeLessThan(first.estimate);
    expect(first.upper).toBeGreaterThan(first.estimate);
  });

  it("summarizes threshold sensitivity around the best candidate", () => {
    const summary = analyzeThresholdSensitivity(
      [
        { threshold: 0.52, returns: [0.006, 0.004, 0.002], tradeCount: 16 },
        { threshold: 0.55, returns: [0.008, 0.006, 0.001], tradeCount: 14 },
        { threshold: 0.58, returns: [0.005, -0.001, 0.003], tradeCount: 12 },
        { threshold: 0.64, returns: [-0.003, -0.002], tradeCount: 5 },
      ],
      {
        minTradeCount: 8,
        neighborhood: 0.04,
        minimumPositiveFraction: 0.66,
        maxMedianDegradation: 0.5,
      },
    );

    expect(summary.best?.threshold).toBe(0.55);
    expect(summary.positiveFraction).toBeCloseTo(1, 12);
    expect(summary.localRows.map((row) => row.threshold)).toEqual([0.52, 0.55, 0.58]);
    expect(summary.passed).toBe(true);
  });

  it("refuses to certify the best of many true-zero strategies once N is injected (A2)", () => {
    // 200 strategies of pure noise (true mean 0). Pick the luckiest by in-sample
    // Sharpe, then deflate by the real number of trials. The honest verdict is
    // that the winner does NOT clear DSR > 0.95 — the gate tells the truth.
    const trials = 200;
    const sampleLength = 40;
    let best: { sharpe: number; returns: number[] } | null = null;
    for (let strategy = 0; strategy < trials; strategy += 1) {
      const seed = (strategy + 1) * 2654435761;
      const returns = pseudoNoise(sampleLength, seed, 0, 0.01);
      const stats = summarizeReturnSeries(returns);
      if (best === null || stats.sharpe > best.sharpe) {
        best = { sharpe: stats.sharpe, returns };
      }
    }
    const dsr = computeDeflatedSharpeRatio(best!.returns, { trialCount: trials });
    expect(dsr.deflatedProbability).toBeLessThan(0.95);
  });

  it("still certifies a genuine edge after deflating by the same N (A2)", () => {
    // A strong, stable positive-drift series clears the bar even with N injected.
    const trials = 200;
    const edge = pseudoNoise(60, 12345, 0.012, 0.004);
    const dsr = computeDeflatedSharpeRatio(edge, { trialCount: trials });
    expect(summarizeReturnSeries(edge).sharpe).toBeGreaterThan(1.5);
    expect(dsr.deflatedProbability).toBeGreaterThan(0.95);
  });

  it("estimates simple CSCV/PBO from strategy fold returns", () => {
    const result = estimateCscvPbo([
      {
        id: "spiky",
        folds: [[0.08], [0.08], [-0.04], [-0.04]],
      },
      {
        id: "steady",
        folds: [[0.01], [0.01], [0.01], [0.01]],
      },
      {
        id: "weak",
        folds: [[-0.01], [-0.01], [-0.01], [-0.01]],
      },
    ]);

    expect(result.strategyCount).toBe(3);
    expect(result.foldCount).toBe(4);
    expect(result.splitCount).toBe(6);
    expect(result.pbo).toBeGreaterThan(0);
    expect(result.pbo).toBeLessThanOrEqual(1);
    expect(result.splits.some((split) => split.overfit)).toBe(true);
  });
});

/** Deterministic uniform noise with an optional drift (no RNG dependency). */
function pseudoNoise(
  length: number,
  seed: number,
  drift: number,
  amplitude: number,
): number[] {
  let state = seed >>> 0;
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length }, () => drift + (next() - 0.5) * 2 * amplitude);
}
