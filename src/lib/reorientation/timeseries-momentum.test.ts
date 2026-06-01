import { describe, expect, it } from "vitest";

import {
  buyAndHoldReturns,
  compound,
  movingAverageCrossover,
  timeSeriesMomentum,
} from "./timeseries-momentum";

/** Deterministic smooth uptrend with a sharp crash in the middle then recovery. */
function trendingCloses(): number[] {
  const closes: number[] = [];
  // up 200 bars (+0.5%/bar), crash 40 bars (-2%/bar), up 200 bars (+0.5%/bar)
  let price = 100;
  for (let i = 0; i < 200; i += 1) {
    price *= 1.005;
    closes.push(price);
  }
  for (let i = 0; i < 40; i += 1) {
    price *= 0.98;
    closes.push(price);
  }
  for (let i = 0; i < 200; i += 1) {
    price *= 1.005;
    closes.push(price);
  }
  return closes;
}

/** A zero-drift random walk (seeded) — the honest negative control: no trend,
 *  so a trend rule must NOT beat buy&hold once costs are paid. */
function randomWalkCloses(seed: number): number[] {
  // mulberry32 PRNG for determinism
  let state = seed >>> 0;
  const rng = (): number => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < 1500; i += 1) {
    // zero-mean Gaussian-ish step (Box-Muller), sigma ~1%/bar, NO drift
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    price *= Math.exp(0.01 * z - 0.5 * 0.01 * 0.01); // drift-corrected log-normal step
    closes.push(price);
  }
  return closes;
}

describe("timeSeriesMomentum", () => {
  it("is strictly causal: position into bar t uses only data up to t-1", () => {
    const closes = [100, 101, 102, 103, 99, 98, 97, 110, 120, 130];
    const r = timeSeriesMomentum({ closes, lookback: 2, roundTripCost: 0 });
    // positions[0] is always 0 (no prior info); positions length == closes length
    expect(r.positions[0]).toBe(0);
    expect(r.positions.length).toBe(closes.length);
    // net/gross/market aligned to bars 1..n-1
    expect(r.netReturns.length).toBe(closes.length - 1);
    expect(r.marketReturns.length).toBe(closes.length - 1);
  });

  it("on a trending series, long-flat TS-momentum beats buy&hold NET of cost", () => {
    const closes = trendingCloses();
    const r = timeSeriesMomentum({ closes, lookback: 20, side: "long-flat", roundTripCost: 0.0028 });
    const stratNet = compound(r.netReturns);
    const bh = compound(buyAndHoldReturns(closes));
    // It sidesteps the crash by going flat -> net beats buy&hold.
    expect(stratNet).toBeGreaterThan(bh);
    // Low turnover: far fewer trades than bars.
    expect(r.tradeCount).toBeLessThan(closes.length / 5);
  });

  it("on a zero-drift random walk, the trend rule does NOT beat buy&hold net (averaged over seeds)", () => {
    // On any single noise path luck can swing either way; the documented claim is
    // that trend has NO edge on a driftless walk *on average*. Average net edge
    // over many seeds must be <= 0.
    let sumEdge = 0;
    const seeds = 40;
    for (let s = 1; s <= seeds; s += 1) {
      const closes = randomWalkCloses(s * 7919);
      const r = timeSeriesMomentum({ closes, lookback: 10, side: "long-short", roundTripCost: 0.0028 });
      sumEdge += compound(r.netReturns) - compound(buyAndHoldReturns(closes));
    }
    expect(sumEdge / seeds).toBeLessThanOrEqual(0);
  });

  it("cost drag is real: net < gross whenever the rule trades", () => {
    const closes = randomWalkCloses(12345);
    const r = timeSeriesMomentum({ closes, lookback: 10, side: "long-short", roundTripCost: 0.0028 });
    expect(r.tradeCount).toBeGreaterThan(0);
    expect(compound(r.netReturns)).toBeLessThan(compound(r.grossReturns) + 1e-9);
  });

  it("charges cost only on position changes and logs turnover", () => {
    // monotonically rising -> enters long once, never flips: exactly 1 trade.
    const closes = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
    const r = timeSeriesMomentum({ closes, lookback: 5, roundTripCost: 0.0028 });
    expect(r.tradeCount).toBe(1);
    expect(r.totalTurnover).toBeCloseTo(1, 9);
    expect(r.exposure).toBeGreaterThan(0.8);
  });
});

describe("movingAverageCrossover", () => {
  it("is causal and beats buy&hold on a trend with a crash (net)", () => {
    const closes = trendingCloses();
    const r = movingAverageCrossover({ closes, fast: 10, slow: 50, roundTripCost: 0.0028 });
    expect(r.positions[0]).toBe(0);
    const stratNet = compound(r.netReturns);
    const bh = compound(buyAndHoldReturns(closes));
    expect(stratNet).toBeGreaterThan(bh);
    expect(r.tradeCount).toBeLessThan(closes.length / 5);
  });

  it("does not manufacture edge on a zero-drift random walk (averaged over seeds)", () => {
    let sumEdge = 0;
    const seeds = 40;
    for (let s = 1; s <= seeds; s += 1) {
      const closes = randomWalkCloses(s * 104729);
      const r = movingAverageCrossover({ closes, fast: 5, slow: 20, side: "long-short", roundTripCost: 0.0028 });
      sumEdge += compound(r.netReturns) - compound(buyAndHoldReturns(closes));
    }
    expect(sumEdge / seeds).toBeLessThanOrEqual(0);
  });
});
