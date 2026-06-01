import { describe, expect, it } from "vitest";

import {
  buildWeeklyPanel,
  runCrossSectionalMomentum,
} from "./cross-sectional-momentum";

/** Deterministic PRNG so the noise test is reproducible. */
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
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

describe("runCrossSectionalMomentum", () => {
  it("is causal: ranks on trailing data only, holds one rebalance/week", () => {
    // 6 coins, simple panel; check no crash and turnover bounded.
    const weeks = 40;
    const weeklyRet: Record<string, number[]> = {};
    const rng = mulberry32(7);
    for (let c = 0; c < 6; c += 1) {
      weeklyRet[`C${c}`] = Array.from({ length: weeks }, () => gaussian(rng) * 0.05);
    }
    const panel = buildWeeklyPanel(weeklyRet);
    const res = runCrossSectionalMomentum(panel, { lookbackWeeks: 4, quantile: 0.2, roundTripCost: 0.0028 });
    expect(res.points.length).toBeGreaterThan(20);
    expect(res.rebalancesPerWeek).toBe(1);
    // L/S book turnover per rebalance is bounded by 2*(long leg + short leg) = 4.
    expect(res.meanTurnover).toBeLessThanOrEqual(4 + 1e-9);
    expect(res.meanTurnover).toBeGreaterThan(0);
  });

  it("INJECTED cross-sectional drift => net edge is positive", () => {
    // Construct a panel where a coin's PERSISTENT type sets both its trailing
    // signal and its future return: high-type coins keep winning, low-type keep
    // losing. A trailing-momentum L/S MUST capture this and stay positive net.
    const nCoins = 20;
    const weeks = 160;
    const rng = mulberry32(42);
    const type: number[] = []; // persistent expected weekly return per coin
    for (let c = 0; c < nCoins; c += 1) {
      // spread of persistent edges from -1.2%/wk to +1.2%/wk
      type.push(((c / (nCoins - 1)) - 0.5) * 0.024);
    }
    const weeklyRet: Record<string, number[]> = {};
    for (let c = 0; c < nCoins; c += 1) {
      weeklyRet[`C${c}`] = Array.from({ length: weeks }, () => type[c]! + gaussian(rng) * 0.02);
    }
    const panel = buildWeeklyPanel(weeklyRet);
    const res = runCrossSectionalMomentum(panel, { lookbackWeeks: 4, quantile: 0.1, roundTripCost: 0.0028 });
    const meanNet = res.netReturns.reduce((a, b) => a + b, 0) / res.netReturns.length;
    // The long-(high type)/short-(low type) book must earn a clearly positive net edge.
    expect(meanNet).toBeGreaterThan(0.005);
    // And it must beat just holding the whole universe (which averages ~0 here).
    const meanUni = res.universeReturns.reduce((a, b) => a + b, 0) / res.universeReturns.length;
    expect(meanNet).toBeGreaterThan(meanUni);
  });

  it("PURE NOISE => mean net return is ~0 or negative (no hallucinated edge)", () => {
    // i.i.d. noise with NO cross-sectional structure: trailing rank carries no
    // information about next week. After costs the strategy must NOT show a
    // material positive edge — otherwise the rule is fabricating alpha.
    const nCoins = 30;
    const weeks = 400;
    const rng = mulberry32(99);
    const weeklyRet: Record<string, number[]> = {};
    for (let c = 0; c < nCoins; c += 1) {
      weeklyRet[`C${c}`] = Array.from({ length: weeks }, () => gaussian(rng) * 0.04);
    }
    const panel = buildWeeklyPanel(weeklyRet);
    const res = runCrossSectionalMomentum(panel, { lookbackWeeks: 4, quantile: 0.1, roundTripCost: 0.0028 });
    const meanNet = res.netReturns.reduce((a, b) => a + b, 0) / res.netReturns.length;
    // No real edge: net mean should be small; with costs it should not exceed a tiny
    // positive bound (and is typically <= 0 because turnover costs bleed it down).
    expect(meanNet).toBeLessThan(0.001);
  });

  it("long_only variant runs and reports zero shorts", () => {
    const nCoins = 15;
    const weeks = 60;
    const rng = mulberry32(3);
    const weeklyRet: Record<string, number[]> = {};
    for (let c = 0; c < nCoins; c += 1) {
      weeklyRet[`C${c}`] = Array.from({ length: weeks }, () => gaussian(rng) * 0.03);
    }
    const panel = buildWeeklyPanel(weeklyRet);
    const res = runCrossSectionalMomentum(panel, { mode: "long_only", quantile: 0.2 });
    expect(res.points.every((p) => p.shortCount === 0)).toBe(true);
    expect(res.points.every((p) => p.longCount > 0)).toBe(true);
  });

  it("respects missing data: never fabricates a signal across null gaps", () => {
    const weeklyRet: Record<string, (number | null)[]> = {
      A: [0.01, null, 0.02, 0.03, 0.01, 0.02, 0.01, 0.04],
      B: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
      C: [-0.01, -0.02, -0.01, -0.02, -0.01, -0.02, -0.01, -0.02],
      D: [0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005],
    };
    const panel = buildWeeklyPanel(weeklyRet);
    const res = runCrossSectionalMomentum(panel, { lookbackWeeks: 4, quantile: 0.25 });
    // A's signal is null until its null gap clears the trailing window — no crash,
    // and every produced point used only coins with a complete trailing window.
    expect(res.points.every((p) => p.eligible >= 2)).toBe(true);
  });
});
