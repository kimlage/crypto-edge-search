import { describe, expect, it } from "vitest";
import {
  ensembleSharpeAnnual,
  normalQuantile,
  poweredHorizonYears,
  preflightPowerCheck,
  requiredObservedSharpeAnnual,
} from "./power-analysis";

const SHARPE_TOL = 0.02; // +/-0.02 Sharpe vs the §3 tables
const YEARS_TOL = 0.3; // +/-0.3y vs the §3 horizon table

describe("normalQuantile", () => {
  it("matches reference values of the standard normal quantile", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 8);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 8);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 8);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959963984540054, 8);
    // Tail branches of the Acklam approximation.
    expect(normalQuantile(0.01)).toBeCloseTo(-2.3263478740408408, 8);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232306167813, 8);
  });

  it("is antisymmetric around 0.5", () => {
    expect(normalQuantile(0.3)).toBeCloseTo(-normalQuantile(0.7), 9);
  });

  it("rejects p outside (0, 1)", () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
    expect(() => normalQuantile(-0.1)).toThrow(RangeError);
    expect(() => normalQuantile(Number.NaN)).toThrow(RangeError);
  });
});

describe("requiredObservedSharpeAnnual — §3 'required observed Sharpe' table", () => {
  const table: Array<{ days: number; dsr: number; tstat: number }> = [
    { days: 182, dsr: 2.34, tstat: 2.78 }, // 26 weeks
    { days: 365, dsr: 1.65, tstat: 1.96 }, // 1 year
    { days: 548, dsr: 1.34, tstat: 1.6 }, // 18 months
    { days: 730, dsr: 1.16, tstat: 1.39 }, // 2 years
    { days: 1095, dsr: 0.95, tstat: 1.13 }, // 3 years
    { days: 1460, dsr: 0.82, tstat: 0.98 }, // 4 years
    { days: 1825, dsr: 0.74, tstat: 0.88 }, // 5 years
  ];

  for (const row of table) {
    it(`reproduces the ${row.days}-day row (dsr ${row.dsr}, t ${row.tstat})`, () => {
      const dsr = requiredObservedSharpeAnnual({
        days: row.days,
        criterion: "dsr",
      });
      const tstat = requiredObservedSharpeAnnual({
        days: row.days,
        criterion: "tstat",
      });
      expect(Math.abs(dsr - row.dsr)).toBeLessThanOrEqual(SHARPE_TOL);
      expect(Math.abs(tstat - row.tstat)).toBeLessThanOrEqual(SHARPE_TOL);
    });
  }

  it("honors explicit dsrBar / alpha / periodsPerYear", () => {
    // dsrBar 0.975 on the dsr criterion equals alpha 0.05 on tstat, up to n vs n-1.
    const dsr = requiredObservedSharpeAnnual({
      days: 365,
      criterion: "dsr",
      dsrBar: 0.975,
    });
    expect(dsr).toBeCloseTo(1.959963984540054 * Math.sqrt(365 / 364), 8);
    const tstat252 = requiredObservedSharpeAnnual({
      days: 252,
      periodsPerYear: 252,
      criterion: "tstat",
      alpha: 0.05,
    });
    expect(tstat252).toBeCloseTo(1.959963984540054, 8);
  });

  it("rejects invalid inputs", () => {
    expect(() =>
      requiredObservedSharpeAnnual({ days: 0, criterion: "tstat" }),
    ).toThrow(RangeError);
    expect(() =>
      requiredObservedSharpeAnnual({ days: 1, criterion: "dsr" }),
    ).toThrow(RangeError);
  });
});

describe("poweredHorizonYears — §3 'years for 80% power' table", () => {
  const table: Array<{ trueSR: number; years: number }> = [
    { trueSR: 0.3, years: 87.2 },
    { trueSR: 0.5, years: 31.4 },
    { trueSR: 0.7, years: 16.0 },
    { trueSR: 1.0, years: 7.8 },
    { trueSR: 1.5, years: 3.5 },
    { trueSR: 2.0, years: 2.0 },
  ];

  for (const row of table) {
    it(`reproduces true SR ${row.trueSR} -> ~${row.years}y`, () => {
      const years = poweredHorizonYears({ trueSharpeAnnual: row.trueSR });
      expect(Math.abs(years - row.years)).toBeLessThanOrEqual(YEARS_TOL);
    });
  }

  it("scales with power and alpha", () => {
    const base = poweredHorizonYears({ trueSharpeAnnual: 1.0 });
    const morePower = poweredHorizonYears({
      trueSharpeAnnual: 1.0,
      power: 0.9,
    });
    const looserAlpha = poweredHorizonYears({
      trueSharpeAnnual: 1.0,
      alpha: 0.1,
    });
    expect(morePower).toBeGreaterThan(base);
    expect(looserAlpha).toBeLessThan(base);
  });

  it("rejects non-positive true Sharpe", () => {
    expect(() => poweredHorizonYears({ trueSharpeAnnual: 0 })).toThrow(
      RangeError,
    );
    expect(() => poweredHorizonYears({ trueSharpeAnnual: -0.5 })).toThrow(
      RangeError,
    );
  });
});

describe("ensembleSharpeAnnual", () => {
  it("(0.5, 0.5, rho=0) -> ~0.71", () => {
    const sr = ensembleSharpeAnnual({ sharpes: [0.5, 0.5], rho: 0 });
    expect(Math.abs(sr - 0.71)).toBeLessThanOrEqual(SHARPE_TOL);
  });

  it("(0.7, 0.7, rho=0.2) -> ~0.90", () => {
    const sr = ensembleSharpeAnnual({ sharpes: [0.7, 0.7], rho: 0.2 });
    expect(Math.abs(sr - 0.9)).toBeLessThanOrEqual(SHARPE_TOL);
  });

  it("k=1 returns the sleeve Sharpe unchanged", () => {
    expect(ensembleSharpeAnnual({ sharpes: [0.42], rho: 0 })).toBeCloseTo(
      0.42,
      10,
    );
  });

  it("rho=1 collapses to the average sleeve Sharpe", () => {
    expect(ensembleSharpeAnnual({ sharpes: [0.4, 0.8], rho: 1 })).toBeCloseTo(
      0.6,
      10,
    );
  });

  it("rejects empty sleeves and infeasible rho", () => {
    expect(() => ensembleSharpeAnnual({ sharpes: [], rho: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      ensembleSharpeAnnual({ sharpes: [0.5, 0.5], rho: -1 }),
    ).toThrow(RangeError);
    expect(() => ensembleSharpeAnnual({ sharpes: [0.5], rho: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe("preflightPowerCheck — the lab's auto-flag gate", () => {
  it("flags a 26-week window at true SR 0.5 as infeasible", () => {
    const result = preflightPowerCheck({
      declaredWindowYears: 0.5,
      assumedTrueSharpeAnnual: 0.5,
    });
    expect(result.feasible).toBe(false);
    expect(Math.abs(result.poweredYears - 31.4)).toBeLessThanOrEqual(
      YEARS_TOL,
    );
    expect(Math.abs(result.requiredObservedSharpeDsr - 2.34)).toBeLessThanOrEqual(
      SHARPE_TOL,
    );
    expect(Math.abs(result.requiredObservedSharpeT - 2.78)).toBeLessThanOrEqual(
      SHARPE_TOL,
    );
    expect(result.recommendation).toContain("AUTO-FLAG");
    expect(result.recommendation).toContain("KILL-only watch");
  });

  it("passes a 2-year window at true SR 2.0 as feasible", () => {
    const result = preflightPowerCheck({
      declaredWindowYears: 2,
      assumedTrueSharpeAnnual: 2.0,
    });
    expect(result.feasible).toBe(true);
    expect(Math.abs(result.poweredYears - 2.0)).toBeLessThanOrEqual(YEARS_TOL);
    expect(Math.abs(result.requiredObservedSharpeDsr - 1.16)).toBeLessThanOrEqual(
      SHARPE_TOL,
    );
    expect(Math.abs(result.requiredObservedSharpeT - 1.39)).toBeLessThanOrEqual(
      SHARPE_TOL,
    );
    expect(result.recommendation).toContain("PROCEED");
  });

  it("rejects a non-positive declared window", () => {
    expect(() =>
      preflightPowerCheck({
        declaredWindowYears: 0,
        assumedTrueSharpeAnnual: 1,
      }),
    ).toThrow(RangeError);
  });
});
