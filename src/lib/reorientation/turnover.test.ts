import { describe, expect, it } from "vitest";

import {
  computeNetEdge,
  costAwareSelectionScore,
  minHoldingGate,
  turnoverPenalty,
} from "./turnover";

describe("computeNetEdge", () => {
  it("charges cost per trade and exposes the per-trade edge", () => {
    const edge = computeNetEdge({ grossReturn: 0.1, tradeCount: 50, roundTripCost: 0.0028 });
    expect(edge.totalCost).toBeCloseTo(0.14, 6);
    expect(edge.netReturn).toBeCloseTo(-0.04, 6);
    expect(edge.grossEdgePerTrade).toBeCloseTo(0.002, 6);
    expect(edge.edgeBeatsCost).toBe(false); // 0.002 gross < 0.0028 cost ⇒ net loss
  });

  it("flags an edge that genuinely beats costs", () => {
    const edge = computeNetEdge({ grossReturn: 0.1, tradeCount: 10, roundTripCost: 0.0028 });
    expect(edge.grossEdgePerTrade).toBeCloseTo(0.01, 6);
    expect(edge.edgeBeatsCost).toBe(true);
    expect(edge.netReturn).toBeGreaterThan(0);
  });
});

describe("turnoverPenalty", () => {
  it("grows with trade frequency", () => {
    const low = turnoverPenalty({ tradeCount: 10, totalBars: 1000, roundTripCost: 0.0028 });
    const high = turnoverPenalty({ tradeCount: 200, totalBars: 1000, roundTripCost: 0.0028 });
    expect(high).toBeGreaterThan(low);
  });
});

describe("minHoldingGate", () => {
  it("blocks churn below the minimum holding period", () => {
    expect(minHoldingGate(2, 4).passed).toBe(false);
    expect(minHoldingGate(2, 4).reason).toBe("below_min_holding_churn");
    expect(minHoldingGate(6, 4).passed).toBe(true);
  });
});

describe("costAwareSelectionScore", () => {
  it("prefers a low-turnover strategy over a high-turnover one with the same gross", () => {
    const common = { baseScore: 1, grossReturn: 0.1, totalBars: 1000, roundTripCost: 0.0028, avgHoldingBars: 10, minHoldingBars: 4 };
    const lowTurnover = costAwareSelectionScore({ ...common, tradeCount: 10 });
    const highTurnover = costAwareSelectionScore({ ...common, tradeCount: 200 });
    expect(lowTurnover.score).toBeGreaterThan(highTurnover.score);
  });

  it("penalizes churn that holds below the minimum", () => {
    const churn = costAwareSelectionScore({
      baseScore: 1, grossReturn: 0.05, tradeCount: 100, totalBars: 1000,
      roundTripCost: 0.0028, avgHoldingBars: 1, minHoldingBars: 4, churnPenalty: 2,
    });
    expect(churn.minHolding.passed).toBe(false);
    expect(churn.churnPenalty).toBe(2);
    expect(churn.score).toBeLessThan(1);
  });
});
