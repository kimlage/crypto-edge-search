/**
 * Tests for the bracket-on-surrogate null (bracket-on-surrogate.ts).
 *
 * Key invariants asserted:
 *   - The bracket LOGIC is identical on the real path and on every surrogate path
 *     (the same `applyBracket` is the single source of truth). We prove this by
 *     re-running the surrogate generation independently and getting byte-identical
 *     outcomes, and by checking the bracket on a hand-built path with a known exit.
 *   - The whole procedure is deterministic per seed.
 */

import { describe, expect, it } from "vitest";

import {
  applyBracket,
  bracketOnSurrogate,
  pricePathFromReturns,
} from "./bracket-on-surrogate";
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

function returnsSeries(seed: number, length: number): number[] {
  const random = seededRandom(seed);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < length; i += 1) {
    const z = random() - 0.5;
    const value = 0.4 * prev + 0.02 * z; // autocorrelated returns
    out.push(value);
    prev = value;
  }
  return out;
}

describe("applyBracket", () => {
  it("exits on take-profit at the first bar crossing the TP threshold", () => {
    // +2% per step: TP at +5% triggers at step 3 (1.02^3 - 1 ≈ 6.1%, > 5%).
    const path = pricePathFromReturns([0.02, 0.02, 0.02, 0.02], 1);
    const out = applyBracket(path, { takeProfit: 0.05, stopLoss: 0.5, maxHold: 10 });
    expect(out.trades[0]!.reason).toBe("takeProfit");
    expect(out.trades[0]!.exit).toBe(3);
    expect(out.trades[0]!.pnl).toBeGreaterThanOrEqual(0.05);
  });

  it("exits on stop-loss at the first bar breaching the SL threshold", () => {
    const path = pricePathFromReturns([-0.02, -0.02, -0.02, -0.02], 1);
    const out = applyBracket(path, { takeProfit: 0.5, stopLoss: 0.05, maxHold: 10 });
    expect(out.trades[0]!.reason).toBe("stopLoss");
    expect(out.trades[0]!.pnl).toBeLessThanOrEqual(-0.05);
  });

  it("exits on the time stop when neither barrier is hit", () => {
    const path = pricePathFromReturns([0.001, 0.001, 0.001, 0.001, 0.001], 1);
    const out = applyBracket(path, { takeProfit: 0.5, stopLoss: 0.5, maxHold: 3 });
    expect(out.trades[0]!.reason).toBe("time");
    expect(out.trades[0]!.exit).toBe(3); // entry 0 + maxHold 3
  });

  it("re-enters after each exit with no overlapping positions", () => {
    const path = pricePathFromReturns(Array.from({ length: 10 }, () => 0.001), 1);
    const out = applyBracket(path, { takeProfit: 0.5, stopLoss: 0.5, maxHold: 2 });
    for (let k = 1; k < out.trades.length; k += 1) {
      expect(out.trades[k]!.entry).toBe(out.trades[k - 1]!.exit + 1);
    }
  });
});

describe("bracketOnSurrogate", () => {
  const spec = { takeProfit: 0.03, stopLoss: 0.03, maxHold: 8 };

  it("applies the IDENTICAL bracket logic to real vs surrogate paths", () => {
    const returns = returnsSeries(12345, 300);

    // Reproduce the FIRST surrogate the procedure builds, then bracket it by hand,
    // and confirm the procedure's first surrogate outcome matches exactly.
    const procRandom = seededRandom(7);
    const result = bracketOnSurrogate(returns, spec, procRandom, {
      count: 5,
      kind: "phase",
    });

    const checkRandom = seededRandom(7);
    const firstSurrReturns = phaseRandomize(returns, checkRandom);
    const firstSurrPath = pricePathFromReturns(firstSurrReturns, 1);
    const expectedFirst = applyBracket(firstSurrPath, spec);

    expect(result.surrogateOutcomes[0]).toEqual(expectedFirst);
    expect(result.surrogateTotals[0]).toBe(expectedFirst.totalPnl);

    // And the real outcome equals applyBracket on the real compounded path.
    const realPath = pricePathFromReturns(returns, 1);
    expect(result.real).toEqual(applyBracket(realPath, spec));
  });

  it("returns a valid right-tail p-value with the +1 correction", () => {
    const returns = returnsSeries(999, 256);
    const result = bracketOnSurrogate(returns, spec, seededRandom(3), { count: 50 });
    expect(result.surrogateTotals).toHaveLength(50);
    expect(result.p).toBeGreaterThan(0);
    expect(result.p).toBeLessThanOrEqual(1);
    // p = (#{surr >= real} + 1) / (count + 1) — recompute and match.
    const atLeast = result.surrogateTotals.filter((v) => v >= result.real.totalPnl).length;
    expect(result.p).toBeCloseTo((atLeast + 1) / 51, 12);
  });

  it("supports the block-bootstrap surrogate too", () => {
    const returns = returnsSeries(2024, 256);
    const result = bracketOnSurrogate(returns, spec, seededRandom(5), {
      count: 10,
      kind: "block",
      blockLength: 8,
    });
    expect(result.surrogateTotals).toHaveLength(10);
  });

  it("is deterministic given a seed", () => {
    const returns = returnsSeries(31337, 200);
    const a = bracketOnSurrogate(returns, spec, seededRandom(42), { count: 20 });
    const b = bracketOnSurrogate(returns, spec, seededRandom(42), { count: 20 });
    expect(a.surrogateTotals).toEqual(b.surrogateTotals);
    expect(a.p).toBe(b.p);
    expect(a.real).toEqual(b.real);
  });
});
