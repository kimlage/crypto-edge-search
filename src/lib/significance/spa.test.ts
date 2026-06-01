import { describe, expect, it } from "vitest";

import {
  romanoWolfStepwise,
  superiorPredictiveAbility,
  type SpaStrategy,
} from "./spa";

/** Deterministic noise series with an optional mean shift. */
function noise(length: number, seed: number, mean: number, amplitude: number): number[] {
  let state = seed >>> 0;
  const next = () => {
    state += 0x6d2b79f5;
    let v = state;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length }, () => mean + (next() - 0.5) * 2 * amplitude);
}

describe("superiorPredictiveAbility", () => {
  it("does not flag a panel of pure-noise strategies", () => {
    const strategies: SpaStrategy[] = Array.from({ length: 8 }, (_, k) => ({
      id: `noise-${k}`,
      excessReturns: noise(250, 100 + k, 0, 0.01),
    }));
    const result = superiorPredictiveAbility(strategies, { iterations: 400, seed: "spa-noise" });
    expect(result.pValue).toBeGreaterThan(0.1);
  });

  it("flags a genuine outperformer hidden among noise", () => {
    const strategies: SpaStrategy[] = [
      ...Array.from({ length: 7 }, (_, k) => ({ id: `noise-${k}`, excessReturns: noise(250, 200 + k, 0, 0.01) })),
      { id: "winner", excessReturns: noise(250, 999, 0.004, 0.01) },
    ];
    const result = superiorPredictiveAbility(strategies, { iterations: 400, seed: "spa-win" });
    expect(result.pValue).toBeLessThan(0.1);
    expect(result.bestStrategyId).toBe("winner");
  });

  it("is deterministic for a given seed", () => {
    const strategies: SpaStrategy[] = [
      { id: "a", excessReturns: noise(200, 1, 0.002, 0.01) },
      { id: "b", excessReturns: noise(200, 2, 0, 0.01) },
    ];
    const a = superiorPredictiveAbility(strategies, { iterations: 300, seed: "x" });
    const b = superiorPredictiveAbility(strategies, { iterations: 300, seed: "x" });
    expect(a.pValue).toBe(b.pValue);
  });
});

describe("romanoWolfStepwise", () => {
  it("rejects nothing in pure noise", () => {
    const strategies: SpaStrategy[] = Array.from({ length: 6 }, (_, k) => ({
      id: `noise-${k}`,
      excessReturns: noise(250, 300 + k, 0, 0.01),
    }));
    const result = romanoWolfStepwise(strategies, { iterations: 400, seed: "rw-noise", alpha: 0.05 });
    expect(result.rejected).toEqual([]);
  });

  it("rejects a clear outperformer", () => {
    const strategies: SpaStrategy[] = [
      ...Array.from({ length: 5 }, (_, k) => ({ id: `noise-${k}`, excessReturns: noise(300, 400 + k, 0, 0.01) })),
      { id: "winner", excessReturns: noise(300, 1234, 0.006, 0.01) },
    ];
    const result = romanoWolfStepwise(strategies, { iterations: 400, seed: "rw-win", alpha: 0.05 });
    expect(result.rejected).toContain("winner");
  });
});
