import { describe, expect, it } from "vitest";

import { classifyRegimes, regimeGate, summarizeRegimes } from "./regime";

function series(seed: number, n: number, drift: number, amp: number): number[] {
  let s = seed >>> 0;
  const next = () => {
    s += 0x6d2b79f5;
    let v = s;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: n }, () => drift + (next() - 0.5) * 2 * amp);
}

describe("classifyRegimes", () => {
  it("labels an up-drift, low-vol stretch as up and a down stretch as down", () => {
    const up = classifyRegimes(series(1, 100, 0.01, 0.002), { trendWindow: 10, volWindow: 10 });
    const down = classifyRegimes(series(2, 100, -0.01, 0.002), { trendWindow: 10, volWindow: 10 });
    expect(up.at(-1)?.trend).toBe("up");
    expect(down.at(-1)?.trend).toBe("down");
  });

  it("is warm-null before the window and labeled after", () => {
    const labels = classifyRegimes(series(3, 30, 0, 0.01), { trendWindow: 10, volWindow: 10 });
    expect(labels[0].trendMean).toBeNull();
    expect(labels[0].trend).toBe("flat");
    expect(labels.at(-1)?.trendMean).not.toBeNull();
  });

  it("is strictly causal: mutating a future return cannot change an earlier label", () => {
    const base = series(7, 120, 0.001, 0.01);
    const labelsBase = classifyRegimes(base, { trendWindow: 15, volWindow: 15 });
    const mutated = [...base];
    mutated[100] = mutated[100] + 5; // huge shock far in the future
    const labelsMutated = classifyRegimes(mutated, { trendWindow: 15, volWindow: 15 });
    for (let t = 0; t < 100; t += 1) {
      expect(labelsMutated[t].label).toBe(labelsBase[t].label);
      expect(labelsMutated[t].vol).toBe(labelsBase[t].vol);
    }
  });
});

describe("summarizeRegimes + regimeGate", () => {
  it("counts regimes and gates allowed ones", () => {
    const labels = classifyRegimes(series(9, 200, 0.002, 0.01), { trendWindow: 10, volWindow: 10 });
    const summary = summarizeRegimes(labels);
    expect(summary.total).toBe(200);
    const sumFractions = Object.values(summary.fractions).reduce((a, b) => a + b, 0);
    expect(sumFractions).toBeCloseTo(1, 6);
    expect(regimeGate("up_low", ["up_low", "up_high"])).toBe(true);
    expect(regimeGate("down_high", ["up_low", "up_high"])).toBe(false);
  });
});
