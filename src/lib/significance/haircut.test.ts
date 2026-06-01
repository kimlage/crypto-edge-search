import { describe, expect, it } from "vitest";

import {
  haircutSharpe,
  haircutSharpePanel,
  sharpePValue,
  type HaircutStrategy,
} from "./haircut";

describe("sharpePValue", () => {
  it("falls toward 0 for a strong Sharpe and 1 for a flat one", () => {
    expect(sharpePValue(0.5, 100)).toBeLessThan(0.001);
    expect(sharpePValue(0, 100)).toBeCloseTo(1, 6);
  });
});

describe("haircutSharpe", () => {
  it("barely haircuts a single trial", () => {
    const r = haircutSharpe({ observedSharpe: 0.3, sampleCount: 200, trialCount: 1 });
    expect(r.haircut).toBeLessThan(0.05);
  });

  it("haircuts hard once there are many trials", () => {
    const r = haircutSharpe({ observedSharpe: 0.3, sampleCount: 200, trialCount: 1000 });
    expect(r.haircut).toBeGreaterThan(0.2);
    expect(r.haircutSharpe).toBeLessThan(0.3);
    expect(r.adjustedPValue).toBeGreaterThan(r.pValue);
  });

  it("BHY is more lenient than Bonferroni", () => {
    const bonf = haircutSharpe({ observedSharpe: 0.3, sampleCount: 200, trialCount: 500, method: "bonferroni" });
    const bhy = haircutSharpe({ observedSharpe: 0.3, sampleCount: 200, trialCount: 500, method: "bhy" });
    expect(bhy.haircut).toBeLessThanOrEqual(bonf.haircut);
    expect(bhy.adjustedPValue).toBeLessThanOrEqual(bonf.adjustedPValue);
  });

  it("can fully haircut a marginal Sharpe under heavy multiple testing", () => {
    const r = haircutSharpe({ observedSharpe: 0.1, sampleCount: 50, trialCount: 5000 });
    expect(r.haircut).toBeGreaterThan(0.5);
  });
});

describe("haircutSharpePanel", () => {
  const strategies: HaircutStrategy[] = [
    { id: "strong", observedSharpe: 0.5, sampleCount: 300 },
    { id: "weak", observedSharpe: 0.08, sampleCount: 300 },
    { id: "noise", observedSharpe: 0.01, sampleCount: 300 },
  ];

  it("ranks by significance and flags only genuine survivors (Holm)", () => {
    const rows = haircutSharpePanel(strategies, { method: "holm", alpha: 0.05 });
    expect(rows[0].id).toBe("strong");
    expect(rows[0].significant).toBe(true);
    expect(rows.find((r) => r.id === "noise")?.significant).toBe(false);
  });

  it("handles an empty panel", () => {
    expect(haircutSharpePanel([])).toEqual([]);
  });
});
