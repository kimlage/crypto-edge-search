/**
 * Cadence-aware Sharpe / return annualization.
 *
 * A Sharpe ratio without a cadence is meaningless: the SAME per-period Sharpe is a
 * different annualized number on a daily bar than on an 8-hour funding interval. The
 * project's reported Sharpes therefore MUST carry an explicit `periodsPerYear`. This
 * module is the single, deterministic place that converts a per-period Sharpe (or a
 * per-period mean return) to an annualized figure under the IID-returns convention:
 *
 *   annualized Sharpe  = perPeriodSharpe × √(periodsPerYear)
 *   annualized return  = (1 + perPeriodReturn)^periodsPerYear − 1   (compounded)
 *
 * The √-time rule is the standard IID scaling (Lo 2002, "The Statistics of Sharpe
 * Ratios", Financial Analysts Journal): variance scales linearly with horizon, so
 * the standard deviation — and hence the Sharpe denominator — scales with √horizon.
 * It assumes serially-uncorrelated returns; autocorrelation breaks it (Lo 2002 gives
 * the correction), so callers carrying a known autocorrelation should adjust upstream.
 * We deliberately do NOT hide the cadence inside a default — every call states it.
 *
 * Pure and deterministic. No I/O, no RNG, no Date.now.
 */

/** A return/Sharpe sampling cadence, by the bar/interval the series was sampled on. */
export type Cadence =
  | "minute"
  | "minute5"
  | "minute15"
  | "minute30"
  | "hourly"
  | "hourly4"
  | "funding8h"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly";

/**
 * Canonical periods-per-year for each cadence. Crypto trades 24/7/365, so there is
 * no 252-trading-day discount — a crypto "daily" bar is 365.25 periods/year, an 8h
 * funding interval is 3×365.25, etc. Using the calendar year (365.25) keeps leap
 * years honest across multi-year windows.
 */
export const PeriodsPerYear: Readonly<Record<Cadence, number>> = Object.freeze({
  minute: 365.25 * 24 * 60,
  minute5: 365.25 * 24 * 12,
  minute15: 365.25 * 24 * 4,
  minute30: 365.25 * 24 * 2,
  hourly: 365.25 * 24,
  hourly4: 365.25 * 6,
  funding8h: 365.25 * 3,
  daily: 365.25,
  weekly: 365.25 / 7,
  monthly: 12,
  yearly: 1,
});

/** A Sharpe ratio that always carries the cadence it was measured/annualized at. */
export interface AnnualizedSharpe {
  /** The raw per-period Sharpe (mean/stdDev of the per-period returns). */
  perPeriodSharpe: number;
  /** Periods per year used to annualize (the explicit cadence). */
  periodsPerYear: number;
  /** perPeriodSharpe × √(periodsPerYear). */
  annualizedSharpe: number;
}

/** A return that always carries the cadence it was measured/annualized at. */
export interface AnnualizedReturn {
  /** The raw per-period (arithmetic) return as a fraction. */
  perPeriodReturn: number;
  periodsPerYear: number;
  /** (1 + perPeriodReturn)^periodsPerYear − 1, compounded. */
  annualizedReturn: number;
}

/**
 * Annualize a per-period Sharpe under the IID √-time rule. `periodsPerYear` is
 * REQUIRED and must be a finite number > 0 — there is no default cadence, by design.
 */
export function annualizeSharpe(
  perPeriodSharpe: number,
  periodsPerYear: number,
): AnnualizedSharpe {
  const ppy = requirePositivePeriods(periodsPerYear);
  const sharpe = Number.isFinite(perPeriodSharpe) ? perPeriodSharpe : 0;
  return {
    perPeriodSharpe: sharpe,
    periodsPerYear: ppy,
    annualizedSharpe: sharpe * Math.sqrt(ppy),
  };
}

/**
 * Annualize a per-period return by compounding it over `periodsPerYear`. A per-period
 * return of -100% or worse compounds to a total loss (-100%); we clamp the base at
 * just above -1 so the power stays finite. `periodsPerYear` is REQUIRED (> 0).
 */
export function annualizeReturn(
  perPeriodReturn: number,
  periodsPerYear: number,
): AnnualizedReturn {
  const ppy = requirePositivePeriods(periodsPerYear);
  const r = Number.isFinite(perPeriodReturn) ? perPeriodReturn : 0;
  const base = Math.max(-0.999999, r);
  const annualizedReturn =
    r <= -1 ? -1 : Math.expm1(Math.log1p(base) * ppy);
  return {
    perPeriodReturn: r,
    periodsPerYear: ppy,
    annualizedReturn,
  };
}

/** Resolve a named cadence to its periods-per-year (sugar over the map). */
export function periodsPerYearFor(cadence: Cadence): number {
  return PeriodsPerYear[cadence];
}

function requirePositivePeriods(periodsPerYear: number): number {
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) {
    throw new Error(
      `annualization requires an explicit periodsPerYear > 0; got ${periodsPerYear}. ` +
        "Pick a cadence from PeriodsPerYear (e.g. PeriodsPerYear.daily).",
    );
  }
  return periodsPerYear;
}
