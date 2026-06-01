import { describe, expect, it } from "vitest";

import {
  deriveBasisMoves,
  simulateFundingCarry,
  stressFundingCarry,
  type FundingInterval,
} from "./funding-carry";

function constantSeries(rate: number, n: number): FundingInterval[] {
  return Array.from({ length: n }, (_, i) => ({ fundingTime: i, fundingRate: rate }));
}

describe("simulateFundingCarry", () => {
  it("a steadily positive funding series yields a positive net APR", () => {
    // +1bp/8h, well above a 4bp-per-leg entry cost amortized over many intervals.
    const series = constantSeries(0.0001, 1000);
    const result = simulateFundingCarry(series, { takerFeePerLeg: 0.0004 });
    expect(result.netApr).toBeGreaterThan(0);
    expect(result.grossApr).toBeGreaterThan(result.netApr); // fees make net < gross
    expect(result.fractionInPosition).toBeGreaterThan(0.9); // stays in almost always
    expect(result.netCumulativeYield).toBeGreaterThan(0);
  });

  it("an all-negative series with a threshold gate stays ~flat, not deeply negative", () => {
    // Funding always below the entry threshold ⇒ never enters ⇒ no carry, no fees.
    const series = constantSeries(-0.0002, 1000);
    const result = simulateFundingCarry(series, {
      entryThreshold: 0.00005,
      takerFeePerLeg: 0.0004,
    });
    expect(result.entries).toBe(0);
    expect(result.intervalsInPosition).toBe(0);
    expect(result.netCumulativeYield).toBe(0); // exactly flat (stayed out)
    expect(result.maxDrawdown).toBe(0);
  });

  it("without a gate, a negative series bleeds funding (the cost of staying in)", () => {
    const series = constantSeries(-0.0002, 200);
    const gated = simulateFundingCarry(series, { entryThreshold: 0.00005 });
    const ungated = simulateFundingCarry(series, { entryThreshold: -1 }); // force in
    expect(gated.netCumulativeYield).toBe(0);
    expect(ungated.netCumulativeYield).toBeLessThan(0); // pays funding each interval
    expect(gated.netCumulativeYield).toBeGreaterThan(ungated.netCumulativeYield);
  });

  it("charges entry + exit fees on a single round trip", () => {
    // One positive interval then negative: enter (2 legs), then next interval exits (2 legs).
    const series: FundingInterval[] = [
      { fundingTime: 0, fundingRate: 0.001 },
      { fundingTime: 1, fundingRate: -0.001 },
    ];
    const result = simulateFundingCarry(series, { takerFeePerLeg: 0.0004, entryThreshold: 0 });
    // entry 2*0.0004 + exit 2*0.0004 = 0.0016 in fees.
    expect(result.totalFeesPaid).toBeCloseTo(0.0016, 6);
    expect(result.entries).toBe(1);
  });

  it("triggers a rebalance fee when the basis drifts past the threshold", () => {
    const series: FundingInterval[] = [
      { fundingTime: 0, fundingRate: 0.001, basisMove: 0 },
      { fundingTime: 1, fundingRate: 0.001, basisMove: 0.05 }, // big drift
      { fundingTime: 2, fundingRate: 0.001, basisMove: 0 },
    ];
    const result = simulateFundingCarry(series, {
      takerFeePerLeg: 0.0004,
      rebalanceDriftThreshold: 0.01,
    });
    expect(result.rebalances).toBe(1);
  });

  it("reports a non-negative max drawdown and finite annualized vol", () => {
    const series = constantSeries(0.0001, 500);
    const result = simulateFundingCarry(series);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.realizedVolAnnualized)).toBe(true);
  });
});

describe("stressFundingCarry", () => {
  it("a sustained negative regime plus a counterparty gap reduces cumulative yield", () => {
    const base = simulateFundingCarry(constantSeries(0.0001, 1000));
    const stress = stressFundingCarry(base, {
      negativeRegimeIntervals: 90,
      negativeRegimeRate: -0.0005,
      counterpartyGapLoss: 0.5,
    });
    expect(stress.negativeRegimeNetReturn).toBeLessThan(0);
    expect(stress.stressedCumulativeYield).toBeLessThan(base.netCumulativeYield);
    expect(stress.counterpartyGapLoss).toBeCloseTo(0.5, 6);
  });

  it("flags non-survivable when the gap loss dominates a thin carry buffer", () => {
    const base = simulateFundingCarry(constantSeries(0.0001, 100)); // small buffer
    const stress = stressFundingCarry(base, { counterpartyGapLoss: 0.6 });
    expect(stress.survivable).toBe(false);
    expect(stress.reason).toContain("survival_floor");
  });

  it("a large carry buffer can absorb a moderate gap and survive", () => {
    // 8bp/8h for 3000 intervals compounds to a big buffer; a 20% gap is survivable.
    const base = simulateFundingCarry(constantSeries(0.0008, 3000));
    const stress = stressFundingCarry(base, {
      negativeRegimeIntervals: 30,
      counterpartyGapLoss: 0.2,
    });
    expect(stress.survivable).toBe(true);
    expect(stress.reason).toBe("survivable");
  });
});

describe("deriveBasisMoves", () => {
  it("computes per-step change in perp-vs-spot basis", () => {
    const spot = [100, 100, 100];
    const perp = [100, 101, 100.5]; // basis: 0, +1%, +0.5%
    const moves = deriveBasisMoves(spot, perp);
    expect(moves[0]).toBe(0);
    expect(moves[1]).toBeCloseTo(0.01, 6);
    expect(moves[2]).toBeCloseTo(-0.005, 6);
  });
});
