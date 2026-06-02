import { describe, expect, it } from "vitest";

import { summarizeReturnSeries } from "../statistical-validation";
import {
  aprToPerPeriod,
  chargeExecutionCosts,
  DEFAULT_TAKER_MODEL,
  resolveShortBorrowApr,
  type ExecutionCostModel,
} from "./execution-cost-model";

/** Deterministic mulberry32 PRNG — seeded, no Math.random, fully reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A reproducible daily gross-return series with a real positive edge. */
function syntheticGrossReturns(n: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const dailyMean = 0.0009; // ~modest positive drift
  const dailyVol = 0.012;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    // Box-Muller from two uniforms (deterministic given the seed).
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(dailyMean + dailyVol * z);
  }
  return out;
}

describe("aprToPerPeriod", () => {
  it("divides an annual rate by periods per year", () => {
    expect(aprToPerPeriod(0.0365, 365)).toBeCloseTo(0.0001, 12);
    expect(aprToPerPeriod(0.05, 0)).toBeCloseTo(0.05, 12); // guards bad periodsPerYear
    expect(aprToPerPeriod(Number.NaN, 365)).toBe(0);
  });
});

describe("resolveShortBorrowApr", () => {
  it("uses the named venue when provided", () => {
    const model: ExecutionCostModel = {
      ...DEFAULT_TAKER_MODEL,
      shortBorrowAprByVenue: { binance: 0.1, okx: 0.3 },
      borrowVenue: "binance",
    };
    expect(resolveShortBorrowApr(model)).toBeCloseTo(0.1, 12);
  });

  it("uses the MAX across venues when none is named (leak-resistant)", () => {
    const model: ExecutionCostModel = {
      ...DEFAULT_TAKER_MODEL,
      shortBorrowAprByVenue: { binance: 0.1, okx: 0.3 },
    };
    expect(resolveShortBorrowApr(model)).toBeCloseTo(0.3, 12);
  });

  it("returns 0 when no venues are configured", () => {
    expect(resolveShortBorrowApr(DEFAULT_TAKER_MODEL)).toBe(0);
  });
});

describe("chargeExecutionCosts — DEFAULT_TAKER_MODEL", () => {
  it("with no carry, only turnover is charged and net <= gross", () => {
    const grossReturns = syntheticGrossReturns(252, 1);
    const result = chargeExecutionCosts({
      grossReturns,
      leverage: 1,
      periodsPerYear: 252,
      model: DEFAULT_TAKER_MODEL,
    });
    expect(result.totalCarryCost).toBe(0); // no borrow/funding/financing/rf/haircut
    expect(result.totalExecutionCost).toBeGreaterThan(0); // establishing the position costs
    // Every net return is <= its gross (costs are non-negative here).
    for (let i = 0; i < grossReturns.length; i += 1) {
      expect(result.netReturns[i]!).toBeLessThanOrEqual(grossReturns[i]! + 1e-15);
    }
  });

  it("is pure/deterministic — identical inputs give identical outputs", () => {
    const grossReturns = syntheticGrossReturns(100, 7);
    const args = {
      grossReturns,
      leverage: 2.95,
      periodsPerYear: 365,
      model: { ...DEFAULT_TAKER_MODEL, riskFreeApr: 0.05 },
    } as const;
    const a = chargeExecutionCosts(args);
    const b = chargeExecutionCosts(args);
    expect(a.netReturns).toEqual(b.netReturns);
    expect(a.totalCost).toBe(b.totalCost);
  });
});

describe("leverage-aware carry sizing", () => {
  it("scales the carry charge by the gross notional, not by 1 unit", () => {
    const grossReturns = syntheticGrossReturns(365, 3);
    const model: ExecutionCostModel = {
      ...DEFAULT_TAKER_MODEL,
      takerBpsPerSide: 0, // isolate carry
      makerBpsPerSide: 0,
      slippageBps: 0,
      riskFreeApr: 0.05,
    };
    const lev1 = chargeExecutionCosts({ grossReturns, leverage: 1, periodsPerYear: 365, model });
    const lev3 = chargeExecutionCosts({ grossReturns, leverage: 2.95, periodsPerYear: 365, model });
    // Carry on the 2.95x notional is ~2.95x the 1-unit carry.
    expect(lev3.totalCarryCost / lev1.totalCarryCost).toBeCloseTo(2.95, 6);
  });
});

/**
 * THE MOTIVATING BUG (dated-futures leak), asserted directly.
 *
 * A cash-and-carry / dated-futures book finances its long leg at the risk-free
 * (or financing) rate on the FULL levered notional. The leak charged that
 * risk-free on 1 unit while the book was ~2.95x levered, which inflated the
 * Sharpe. Here we charge the SAME risk-free APR two ways against the SAME gross
 * series and assert that the correct (full-notional) charge materially REDUCES
 * the net Sharpe relative to the buggy (1-unit) charge — i.e. the leak's
 * direction is to OVERSTATE performance.
 */
describe("dated-futures leak — risk-free on full levered notional reduces net Sharpe", () => {
  it("charging RF on ~2.95x notional cuts net Sharpe materially vs charging on 1 unit", () => {
    const grossReturns = syntheticGrossReturns(365 * 2, 42);
    const periodsPerYear = 365;
    const leverage = 2.95;

    // Carry-only model (isolate the financing leak from execution fees).
    const model: ExecutionCostModel = {
      ...DEFAULT_TAKER_MODEL,
      takerBpsPerSide: 0,
      makerBpsPerSide: 0,
      slippageBps: 0,
      riskFreeApr: 0.05, // 5%/yr on the financed long leg
    };

    // BUGGY (leak): risk-free charged on 1 unit of capital (leverage = 1).
    const buggy = chargeExecutionCosts({
      grossReturns,
      leverage: 1,
      periodsPerYear,
      model,
    });
    // CORRECT: risk-free charged on the FULL ~2.95x-levered notional.
    const correct = chargeExecutionCosts({
      grossReturns,
      leverage,
      periodsPerYear,
      model,
    });

    const buggySharpe = summarizeReturnSeries(buggy.netReturns).sharpe;
    const correctSharpe = summarizeReturnSeries(correct.netReturns).sharpe;

    // The correct (full-notional) charge must reduce the Sharpe...
    expect(correctSharpe).toBeLessThan(buggySharpe);
    // ...and MATERIALLY so (the leak is not a rounding error). Require at least a
    // 20% relative haircut to the net Sharpe — in the audit it was 1.64 -> 0.69.
    expect(correctSharpe).toBeLessThan(buggySharpe * 0.8);

    // The carry charged under the correct sizing is ~2.95x the buggy charge.
    expect(correct.totalCarryCost / buggy.totalCarryCost).toBeCloseTo(leverage, 4);
    // And the correct mean gross notional reflects the real leverage.
    expect(correct.meanGrossNotional).toBeCloseTo(leverage, 6);
  });

  it("reproduces the audit's Sharpe-collapse direction on a tuned series", () => {
    // A series whose 1-unit-financed Sharpe lands near the audit's 1.64 and whose
    // full-2.95x-financed Sharpe collapses toward ~0.69. We do not pin the exact
    // numbers (they depend on the synthetic draw) — we assert the COLLAPSE.
    const periodsPerYear = 365;
    const leverage = 2.95;
    const grossReturns = syntheticGrossReturns(365 * 3, 1234);

    const model: ExecutionCostModel = {
      ...DEFAULT_TAKER_MODEL,
      takerBpsPerSide: 0,
      makerBpsPerSide: 0,
      slippageBps: 0,
      riskFreeApr: 0.06,
    };

    // Annualize the per-period Sharpe (× sqrt(periodsPerYear)) to compare against
    // the audit's reported annual Sharpe figures (1.64 -> 0.69).
    const annualize = Math.sqrt(periodsPerYear);
    const buggySharpe =
      annualize *
      summarizeReturnSeries(
        chargeExecutionCosts({ grossReturns, leverage: 1, periodsPerYear, model }).netReturns,
      ).sharpe;
    const correctSharpe =
      annualize *
      summarizeReturnSeries(
        chargeExecutionCosts({ grossReturns, leverage, periodsPerYear, model }).netReturns,
      ).sharpe;

    expect(buggySharpe).toBeGreaterThan(correctSharpe);
    // A real, decision-changing gap in ANNUALIZED Sharpe (the audit saw ~0.95).
    expect(buggySharpe - correctSharpe).toBeGreaterThan(0.4);
  });
});

describe("composability of legs (positions / weights)", () => {
  it("charges short borrow on the short leg and risk-free on the long leg", () => {
    const grossReturns = syntheticGrossReturns(365, 9);
    // A market-neutral basket: +1 long, -1 short each period => gross 2, scaled to leverage.
    const weights = grossReturns.map(() => [1, -1]);
    const model: ExecutionCostModel = {
      ...DEFAULT_TAKER_MODEL,
      takerBpsPerSide: 0,
      makerBpsPerSide: 0,
      slippageBps: 0,
      riskFreeApr: 0.04,
      shortBorrowAprByVenue: { binance: 0.2 },
    };
    const result = chargeExecutionCosts({
      grossReturns,
      weights,
      leverage: 2,
      periodsPerYear: 365,
      model,
    });
    const b = result.breakdown[0]!;
    // Gross 2 => long 1, short 1 after scaling (symmetric basket, leverage 2).
    expect(b.longNotional).toBeCloseTo(1, 6);
    expect(b.shortNotional).toBeCloseTo(1, 6);
    expect(b.borrowCost).toBeGreaterThan(0); // short borrow charged
    expect(b.riskFreeCost).toBeGreaterThan(0); // rf on the long leg charged
    // Borrow on short (0.20/yr) > rf on long (0.04/yr) at equal notional.
    expect(b.borrowCost).toBeGreaterThan(b.riskFreeCost);
  });

  it("a flat-long book (no composition) has zero short leg", () => {
    const grossReturns = syntheticGrossReturns(50, 11);
    const result = chargeExecutionCosts({
      grossReturns,
      leverage: 2.95,
      periodsPerYear: 365,
      model: { ...DEFAULT_TAKER_MODEL, shortBorrowAprByVenue: { x: 0.5 } },
    });
    for (const b of result.breakdown) {
      expect(b.shortNotional).toBe(0);
      expect(b.borrowCost).toBe(0);
      expect(b.longNotional).toBeCloseTo(2.95, 9);
    }
  });
});
