import { describe, expect, it } from "vitest";

import {
  baselineScoreFromReturns,
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  evaluateBaselineGate,
  type BaselineScore,
} from "./baselines";

/** Deterministic pseudo-random bar series with a tiny positive drift. */
function driftingBars(count: number, drift: number, vol: number, seed: number): number[] {
  let state = seed >>> 0;
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: count }, () => drift + (next() - 0.5) * 2 * vol);
}

describe("buildBuyAndHoldBaseline", () => {
  it("charges the round-trip cost exactly once", () => {
    const bars = [0.01, 0.01, 0.01];
    const free = buildBuyAndHoldBaseline({ barReturns: bars, roundTripCost: 0 });
    const costed = buildBuyAndHoldBaseline({ barReturns: bars, roundTripCost: 0.005 });
    expect(free.score).toBeGreaterThan(costed.score);
    // gross compound ≈ (1.01)^3 - 1; cost shifts only the first bar by 0.005
    expect(free.score - costed.score).toBeGreaterThan(0.004);
    expect(free.score - costed.score).toBeLessThan(0.006);
    expect(costed.tradeCount).toBe(1);
  });

  it("flips sign for a short hold", () => {
    const bars = [0.01, 0.02, 0.01];
    const long = buildBuyAndHoldBaseline({ barReturns: bars });
    const short = buildBuyAndHoldBaseline({ barReturns: bars, side: "short" });
    expect(long.score).toBeGreaterThan(0);
    expect(short.score).toBeLessThan(0);
  });
});

describe("buildRandomLotteryBaseline", () => {
  it("is deterministic for a given seed", () => {
    const bars = driftingBars(400, 0, 0.01, 7);
    const a = buildRandomLotteryBaseline({ barReturns: bars, tradeCount: 20, seed: "x" });
    const b = buildRandomLotteryBaseline({ barReturns: bars, tradeCount: 20, seed: "x" });
    expect(a.score).toBe(b.score);
    expect(a.samples.length).toBe(512);
  });

  it("is roughly centered below zero once costs are charged", () => {
    const bars = driftingBars(400, 0, 0.01, 11);
    const baseline = buildRandomLotteryBaseline({
      barReturns: bars,
      tradeCount: 30,
      roundTripCost: 0.0028,
      quantile: 0.5,
      seed: "median",
    });
    // a zero-drift random trader nets ~ -tradeCount * roundTripCost in expectation
    expect(baseline.score).toBeLessThan(0);
  });

  it("returns a higher bar at higher quantiles", () => {
    const bars = driftingBars(400, 0, 0.02, 13);
    const q50 = buildRandomLotteryBaseline({ barReturns: bars, tradeCount: 25, quantile: 0.5, seed: "q" });
    const q95 = buildRandomLotteryBaseline({ barReturns: bars, tradeCount: 25, quantile: 0.95, seed: "q" });
    expect(q95.score).toBeGreaterThanOrEqual(q50.score);
  });

  it("degenerates gracefully with no bars or no trades", () => {
    expect(buildRandomLotteryBaseline({ barReturns: [], tradeCount: 10 }).score).toBe(0);
    expect(buildRandomLotteryBaseline({ barReturns: [0.01], tradeCount: 0 }).score).toBe(0);
  });
});

describe("evaluateBaselineGate", () => {
  const baselines: BaselineScore[] = [
    { id: "buy_and_hold", label: "Buy-and-hold", score: 0.02, source: "test" },
    { id: "random_lottery", label: "Random", score: 0.0, source: "test" },
    { id: "linear_one_layer", label: "Linear", score: 0.015, source: "test" },
  ];

  it("passes a candidate with a real edge that beats every baseline", () => {
    const result = evaluateBaselineGate({
      candidateReturns: [],
      candidateScore: 0.08,
      baselines,
    });
    expect(result.passed).toBe(true);
    expect(result.beatsAll).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.worstBaselineId).toBe("buy_and_hold");
  });

  it("blocks a pure-noise candidate that loses to buy-and-hold", () => {
    const result = evaluateBaselineGate({
      candidateReturns: [],
      candidateScore: 0.005,
      baselines,
    });
    expect(result.passed).toBe(false);
    expect(result.beatsAll).toBe(false);
    expect(result.reasons).toContain("fails_vs_buy_and_hold");
    expect(result.reasons).toContain("fails_vs_linear_one_layer");
    expect(result.reasons).not.toContain("fails_vs_random_lottery");
  });

  it("blocks a negative candidate even if it beats a negative baseline", () => {
    const result = evaluateBaselineGate({
      candidateReturns: [],
      candidateScore: -0.01,
      baselines: [{ id: "random_lottery", label: "Random", score: -0.05, source: "test" }],
    });
    expect(result.beatsAll).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain("candidate_not_positive");
  });

  it("computes the candidate score from returns when not given explicitly", () => {
    const winner = [0.03, 0.02, 0.04, 0.01, 0.03];
    const result = evaluateBaselineGate({
      candidateReturns: winner,
      baselines: [{ id: "buy_and_hold", label: "BH", score: 0.02, source: "test" }],
    });
    expect(result.candidateScore).toBeGreaterThan(0.1);
    expect(result.passed).toBe(true);
  });

  it("honours a minimum margin", () => {
    const result = evaluateBaselineGate({
      candidateReturns: [],
      candidateScore: 0.021,
      baselines: [{ id: "buy_and_hold", label: "BH", score: 0.02, source: "test" }],
      minMargin: 0.005,
    });
    expect(result.beatsAll).toBe(false);
    expect(result.reasons).toContain("fails_vs_buy_and_hold");
  });
});

describe("end-to-end: synthetic edge vs noise", () => {
  const bars = driftingBars(600, 0.0002, 0.012, 99);
  const roundTripCost = 0.0028;
  const buyHold = buildBuyAndHoldBaseline({ barReturns: bars, roundTripCost });
  const random = buildRandomLotteryBaseline({
    barReturns: bars,
    tradeCount: 40,
    roundTripCost,
    quantile: 0.95,
    seed: "e2e",
  });
  const linear = baselineScoreFromReturns(
    "linear_one_layer",
    "Linear",
    [0.004, -0.001, 0.003, 0.002, -0.0005, 0.0025],
    { source: "logistic" },
  );

  it("promotes a genuine-edge candidate", () => {
    // a candidate whose per-trade net returns are clearly positive and stable
    const edge = Array.from({ length: 40 }, (_, i) => 0.006 + (i % 5) * 0.0005);
    const result = evaluateBaselineGate({
      candidateReturns: edge,
      baselines: [buyHold, random, linear],
    });
    expect(result.passed).toBe(true);
  });

  it("blocks a noise candidate that does not beat the random-lottery bar", () => {
    // per-trade net returns hovering around the cost drag — no real edge
    const noise = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.002 : -0.0025) - roundTripCost);
    const result = evaluateBaselineGate({
      candidateReturns: noise,
      baselines: [buyHold, random, linear],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
