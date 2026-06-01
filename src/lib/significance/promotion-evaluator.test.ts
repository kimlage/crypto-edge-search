import { describe, expect, it } from "vitest";

import { baselineScoreFromReturns } from "./baselines";
import type { CpcvPathReturns, CpcvStrategyPaths } from "./cpcv-paths";
import { evaluatePromotion, type PromotionEvaluationInput } from "./promotion-evaluator";
import type { SpaStrategy } from "./spa";

/** Deterministic mulberry32 so the synthetic series are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function series(seed: number, count: number, mean: number, std: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, () => mean + std * gaussian(rng));
}

describe("evaluatePromotion", () => {
  it("promotes a strong, stable synthetic edge with adequate sample and low N", () => {
    const n = 400;
    const candidateReturns = series(101, n, 0.004, 0.01); // per-trade Sharpe ~0.4
    const barReturns = series(202, 600, -0.0002, 0.008);
    const linearReturns = series(303, n, 0.0003, 0.01);

    const cpcvPaths: CpcvPathReturns[] = Array.from({ length: 6 }, (_, p) => ({
      pathId: `path-${p}`,
      returns: series(400 + p, 80, 0.0035, 0.01),
    }));
    const competitors: CpcvStrategyPaths[] = Array.from({ length: 4 }, (_, c) => ({
      id: `rival-${c}`,
      paths: Array.from({ length: 6 }, (_, p) => ({
        pathId: `path-${p}`,
        returns: series(900 + c * 10 + p, 80, -0.001, 0.01),
      })),
    }));
    const spaPanel: SpaStrategy[] = [
      { id: "candidate", excessReturns: candidateReturns },
      ...Array.from({ length: 8 }, (_, k) => ({
        id: `noise-${k}`,
        excessReturns: series(1300 + k, n, 0, 0.01),
      })),
    ];

    const input: PromotionEvaluationInput = {
      candidateId: "candidate",
      candidateReturns,
      sampleCount: n,
      trialCount: 5,
      barReturns,
      roundTripCost: 0.0008,
      extraBaselines: [
        baselineScoreFromReturns("linear_one_layer", "Linear one-layer", linearReturns),
      ],
      cpcvPaths,
      cpcvCompetitors: competitors,
      spaPanel,
      seed: "promotion-test-a",
    };

    const out = evaluatePromotion(input);

    expect(out.promotable).toBe(true);
    expect(out.reasons).toEqual([]);
    expect(out.gates.baselines.applicable && out.gates.baselines.passed).toBe(true);
    expect(out.gates.deflatedSharpe.passed).toBe(true);
    expect(out.gates.deflatedSharpe.deflatedProbability).toBeGreaterThanOrEqual(0.95);
    expect(out.gates.minBtl.passed).toBe(true);
    expect(out.gates.cpcvPbo.applicable && out.gates.cpcvPbo.passed).toBe(true);
    expect(out.gates.cpcvPbo.pbo).toBeLessThanOrEqual(0.4);
    expect(out.gates.cpcvPbo.pooledDeflatedProbability).toBeGreaterThanOrEqual(0.95);
    expect(out.gates.haircut.passed).toBe(true);
    expect(out.gates.haircut.result.haircutSharpe).toBeGreaterThan(0);
    expect(out.gates.spa.applicable && out.gates.spa.passed).toBe(true);
    expect(out.summary.gatesPassed).toBe(out.summary.gatesApplicable);
  });

  it("rejects the historic mirage: +0.5% on only 6 trades that lost on test", () => {
    // Real winner from auto-loop-2026-05-23T13-33-29-789Z-i2 (G1-DNA-002-mutation):
    // validation2Return +0.004982, tradeCount 6, testReturn -0.0362.
    const candidateReturns = [0.05, -0.03, 0.04, -0.02, 0.012, -0.043];

    const input: PromotionEvaluationInput = {
      candidateId: "G1-DNA-002-mutation",
      candidateReturns,
      sampleCount: 6,
      trialCount: 7, // 7 distinct DNA tried in that batch
      barReturns: series(777, 500, 0.0001, 0.01),
      roundTripCost: 0.0008,
      seed: "promotion-test-b",
    };

    const out = evaluatePromotion(input);

    expect(out.promotable).toBe(false);
    // The MinBTL gate must catch the 6-trade sample as too short for the trial count.
    expect(out.gates.minBtl.passed).toBe(false);
    expect(out.gates.minBtl.result.reason).toMatch(/^sample_too_short/);
    expect(out.gates.minBtl.result.minSampleForObservedSharpe).toBeGreaterThan(6);
    // And/or the baselines and DSR reject it too; at minimum a reason is recorded.
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.reasons.some((reason) => reason.startsWith("minBtl:sample_too_short"))).toBe(true);
  });

  it("rejects a many-trials noise winner via the Deflated Sharpe", () => {
    const n = 250;
    // modest apparent edge (Sharpe ~0.08) that survives a single test but not deflation.
    const candidateReturns = series(555, n, 0.0008, 0.01);

    const input: PromotionEvaluationInput = {
      candidateId: "noise-winner",
      candidateReturns,
      sampleCount: n,
      trialCount: 2000, // huge search -> heavy deflation
      barReturns: series(666, 500, 0.0001, 0.01),
      roundTripCost: 0.0008,
      seed: "promotion-test-c",
    };

    const out = evaluatePromotion(input);

    expect(out.promotable).toBe(false);
    expect(out.gates.deflatedSharpe.passed).toBe(false);
    expect(out.gates.deflatedSharpe.deflatedProbability).toBeLessThan(0.95);
    expect(out.reasons.some((reason) => reason.startsWith("deflatedSharpe:"))).toBe(true);
  });

  it("marks CPCV and SPA gates non-applicable when their inputs are absent", () => {
    const input: PromotionEvaluationInput = {
      candidateReturns: series(99, 300, 0.003, 0.01),
      sampleCount: 300,
      trialCount: 4,
      barReturns: series(88, 400, 0, 0.01),
      roundTripCost: 0.0008,
      seed: "promotion-test-applicability",
    };
    const out = evaluatePromotion(input);
    expect(out.gates.cpcvPbo.applicable).toBe(false);
    expect(out.gates.spa.applicable).toBe(false);
    // The always-on gates are still applicable.
    expect(out.gates.baselines.applicable).toBe(true);
    expect(out.gates.deflatedSharpe.applicable).toBe(true);
    expect(out.gates.minBtl.applicable).toBe(true);
    expect(out.gates.haircut.applicable).toBe(true);
    expect(out.summary.gatesApplicable).toBe(4);
  });

  it("is deterministic across repeated evaluations", () => {
    const candidateReturns = series(11, 120, 0.001, 0.01);
    const make = (): PromotionEvaluationInput => ({
      candidateReturns,
      sampleCount: 120,
      trialCount: 50,
      barReturns: series(22, 240, 0, 0.01),
      roundTripCost: 0.0008,
      spaPanel: [
        { id: "candidate", excessReturns: candidateReturns },
        { id: "rival", excessReturns: series(33, 120, 0, 0.01) },
      ],
      seed: "promotion-test-det",
    });
    const a = evaluatePromotion(make());
    const b = evaluatePromotion(make());
    expect(a.promotable).toBe(b.promotable);
    expect(a.reasons).toEqual(b.reasons);
    expect(a.gates.spa.result?.pValue).toBe(b.gates.spa.result?.pValue);
  });
});
