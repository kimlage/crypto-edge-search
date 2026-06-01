import { describe, expect, it } from "vitest";

import {
  cpcvDeflatedSharpe,
  cpcvPbo,
  cpcvSelectionScore,
  summarizeCpcvPaths,
  type CpcvPathReturns,
} from "./cpcv-paths";

const stablePaths: CpcvPathReturns[] = [
  { pathId: "p0", returns: [0.01, 0.012, 0.008, 0.011] },
  { pathId: "p1", returns: [0.009, 0.011, 0.01, 0.012] },
  { pathId: "p2", returns: [0.011, 0.009, 0.012, 0.01] },
];

// same median performance but wildly different across paths
const fragilePaths: CpcvPathReturns[] = [
  { pathId: "p0", returns: [0.05, 0.06, 0.04, 0.05] },
  { pathId: "p1", returns: [-0.04, -0.05, -0.03, -0.04] },
  { pathId: "p2", returns: [0.01, 0.011, 0.009, 0.01] },
];

describe("summarizeCpcvPaths", () => {
  it("captures dispersion and worst path across the OOS paths", () => {
    const stable = summarizeCpcvPaths(stablePaths);
    const fragile = summarizeCpcvPaths(fragilePaths);
    expect(stable.pathCount).toBe(3);
    expect(stable.sharpeDispersion).toBeLessThan(fragile.sharpeDispersion);
    expect(fragile.worstSharpe).toBeLessThan(stable.worstSharpe);
    expect(stable.fractionPositivePaths).toBeCloseTo(1, 12);
    expect(fragile.fractionPositivePaths).toBeCloseTo(2 / 3, 6);
  });
});

describe("cpcvSelectionScore", () => {
  it("prefers the path-stable strategy over the path-fragile one", () => {
    const stable = cpcvSelectionScore(summarizeCpcvPaths(stablePaths));
    const fragile = cpcvSelectionScore(summarizeCpcvPaths(fragilePaths));
    expect(stable).toBeGreaterThan(fragile);
  });
});

describe("cpcvDeflatedSharpe", () => {
  it("deflates harder as the trial count grows", () => {
    const few = cpcvDeflatedSharpe(stablePaths, 1);
    const many = cpcvDeflatedSharpe(stablePaths, 500);
    expect(many).toBeLessThanOrEqual(few);
    expect(few).toBeGreaterThan(0);
  });
});

describe("cpcvPbo", () => {
  it("estimates PBO over the strategies x paths matrix", () => {
    const result = cpcvPbo([
      { id: "overfit", paths: fragilePaths },
      { id: "steady", paths: stablePaths },
      { id: "weak", paths: [
        { pathId: "p0", returns: [-0.01, -0.012, -0.009, -0.011] },
        { pathId: "p1", returns: [-0.009, -0.011, -0.01, -0.012] },
        { pathId: "p2", returns: [-0.011, -0.009, -0.012, -0.01] },
      ] },
    ]);
    expect(result.strategyCount).toBe(3);
    expect(result.foldCount).toBe(3);
    expect(result.pbo).toBeGreaterThanOrEqual(0);
    expect(result.pbo).toBeLessThanOrEqual(1);
  });

  it("intersects to shared path ids only", () => {
    const result = cpcvPbo([
      { id: "a", paths: [{ pathId: "p0", returns: [0.01, 0.01] }, { pathId: "p1", returns: [0.01, 0.01] }] },
      { id: "b", paths: [{ pathId: "p0", returns: [0.01, 0.01] }] },
    ]);
    expect(result.foldCount).toBe(1);
  });
});
