import { describe, expect, it } from "vitest";

import {
  annualizeReturn,
  annualizeSharpe,
  PeriodsPerYear,
  periodsPerYearFor,
} from "./cadence";

describe("cadence annualization", () => {
  it("scales a per-period Sharpe by the square root of periods per year", () => {
    const daily = annualizeSharpe(0.1, PeriodsPerYear.daily);
    expect(daily.perPeriodSharpe).toBe(0.1);
    expect(daily.periodsPerYear).toBe(365.25);
    expect(daily.annualizedSharpe).toBeCloseTo(0.1 * Math.sqrt(365.25), 12);
  });

  it("annualizes the SAME per-period Sharpe differently across cadences", () => {
    const sharpe = 0.05;
    const daily = annualizeSharpe(sharpe, PeriodsPerYear.daily).annualizedSharpe;
    const funding = annualizeSharpe(sharpe, PeriodsPerYear.funding8h).annualizedSharpe;
    const hourly = annualizeSharpe(sharpe, PeriodsPerYear.hourly).annualizedSharpe;
    // Higher-frequency cadences annualize the same per-period Sharpe to a larger
    // number — exactly why a reported Sharpe must always carry its cadence.
    expect(funding).toBeGreaterThan(daily);
    expect(hourly).toBeGreaterThan(funding);
    // √3 ratio between 8h-funding (3/day) and daily, by construction.
    expect(funding / daily).toBeCloseTo(Math.sqrt(3), 12);
  });

  it("is a no-op at yearly cadence (periodsPerYear = 1)", () => {
    const yearly = annualizeSharpe(1.64, PeriodsPerYear.yearly);
    expect(yearly.annualizedSharpe).toBeCloseTo(1.64, 12);
  });

  it("compounds a per-period return over the periods in a year", () => {
    const daily = annualizeReturn(0.001, PeriodsPerYear.daily);
    expect(daily.perPeriodReturn).toBe(0.001);
    expect(daily.annualizedReturn).toBeCloseTo(1.001 ** 365.25 - 1, 12);
    // A positive daily drift compounds to a large positive annual number.
    expect(daily.annualizedReturn).toBeGreaterThan(0.4);
  });

  it("compounds a -100%-or-worse per-period return to a total loss", () => {
    expect(annualizeReturn(-1, PeriodsPerYear.daily).annualizedReturn).toBe(-1);
    expect(annualizeReturn(-2, PeriodsPerYear.daily).annualizedReturn).toBe(-1);
  });

  it("exposes a complete, frozen PeriodsPerYear map", () => {
    expect(PeriodsPerYear.daily).toBe(365.25);
    expect(PeriodsPerYear.funding8h).toBe(365.25 * 3);
    expect(PeriodsPerYear.hourly).toBe(365.25 * 24);
    expect(PeriodsPerYear.weekly).toBeCloseTo(365.25 / 7, 12);
    expect(PeriodsPerYear.monthly).toBe(12);
    expect(PeriodsPerYear.yearly).toBe(1);
    expect(Object.isFrozen(PeriodsPerYear)).toBe(true);
    expect(periodsPerYearFor("minute15")).toBe(PeriodsPerYear.minute15);
  });

  it("refuses to annualize without an explicit positive cadence", () => {
    expect(() => annualizeSharpe(1, 0)).toThrow(/periodsPerYear/);
    expect(() => annualizeSharpe(1, Number.NaN)).toThrow(/periodsPerYear/);
    expect(() => annualizeReturn(0.01, -5)).toThrow(/periodsPerYear/);
  });

  it("treats non-finite inputs as zero rather than propagating NaN", () => {
    expect(annualizeSharpe(Number.NaN, PeriodsPerYear.daily).annualizedSharpe).toBe(0);
    expect(annualizeReturn(Number.POSITIVE_INFINITY, PeriodsPerYear.daily).annualizedReturn).toBe(0);
  });
});
