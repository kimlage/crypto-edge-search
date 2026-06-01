import { describe, expect, it } from "vitest";

import {
  countDistinctTrials,
  effectiveTrialCount,
  evaluateMinBtl,
  summarizeTrialSelection,
} from "./trial-count";

describe("countDistinctTrials", () => {
  it("counts unique DNA ids and falls back to trial id", () => {
    const rows = [
      { dnaId: "dna-1", trialId: "t1" },
      { dnaId: "dna-1", trialId: "t2" },
      { dnaId: "dna-2", trialId: "t3" },
      { dnaId: null, trialId: "t4" },
      { dnaId: " ", trialId: "t5" },
    ];
    // dna-1, dna-2, t4 (fallback), t5 (fallback) = 4
    expect(countDistinctTrials(rows)).toBe(4);
  });

  it("ignores rows with no usable identity", () => {
    expect(countDistinctTrials([{ dnaId: null, trialId: null }, {}])).toBe(0);
  });
});

describe("effectiveTrialCount", () => {
  it("never returns below 1", () => {
    expect(effectiveTrialCount({})).toBe(1);
  });

  it("takes the largest of rows, explicit and floor", () => {
    const rows = [{ dnaId: "a" }, { dnaId: "b" }];
    expect(effectiveTrialCount({ rows, explicitTrialCount: 50 })).toBe(50);
    expect(effectiveTrialCount({ rows, floor: 5 })).toBe(5);
    expect(effectiveTrialCount({ rows })).toBe(2);
  });
});

describe("evaluateMinBtl", () => {
  it("flags a short sample as insufficient for many trials", () => {
    // 500 trials, only 8 observations, modest Sharpe ⇒ explainable by luck
    const result = evaluateMinBtl({ trialCount: 500, sampleCount: 8, observedSharpe: 0.5 });
    expect(result.sufficientLength).toBe(false);
    expect(result.reason).toBe("sample_too_short_for_500_trials");
    expect(result.minSampleForObservedSharpe).toBeGreaterThan(8);
  });

  it("accepts a long sample with a strong Sharpe", () => {
    const result = evaluateMinBtl({ trialCount: 200, sampleCount: 5000, observedSharpe: 0.5 });
    expect(result.sufficientLength).toBe(true);
    expect(result.reason).toBe("sufficient");
  });

  it("requires more observations as the trial count grows", () => {
    const few = evaluateMinBtl({ trialCount: 10, sampleCount: 1, observedSharpe: 1 });
    const many = evaluateMinBtl({ trialCount: 10_000, sampleCount: 1, observedSharpe: 1 });
    expect(many.minSampleForObservedSharpe).toBeGreaterThan(few.minSampleForObservedSharpe);
  });

  it("handles non-positive Sharpe and empty sample", () => {
    expect(evaluateMinBtl({ trialCount: 10, sampleCount: 100, observedSharpe: 0 }).reason).toBe(
      "non_positive_sharpe",
    );
    expect(evaluateMinBtl({ trialCount: 10, sampleCount: 0, observedSharpe: 1 }).reason).toBe(
      "no_sample",
    );
  });
});

describe("summarizeTrialSelection", () => {
  it("reports N plus the dispersion of validation2 returns", () => {
    const summary = summarizeTrialSelection([
      { dnaId: "a", validation2Return: 0.02 },
      { dnaId: "b", validation2Return: -0.01 },
      { dnaId: "c", validation2Return: 0.03 },
      { dnaId: "c", validation2Return: 0.03 }, // duplicate config
    ]);
    expect(summary.trialCount).toBe(3);
    expect(summary.returnSampleCount).toBe(4);
    expect(summary.bestReturn).toBeCloseTo(0.03, 12);
    expect(summary.worstReturn).toBeCloseTo(-0.01, 12);
    expect(summary.returnVariance).toBeGreaterThan(0);
  });
});
