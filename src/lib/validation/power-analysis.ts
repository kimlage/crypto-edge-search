/**
 * Power analysis for pre-registered forward tests — "the power wall".
 *
 * Implements PROJECT_REVIEW_2026-06-09.md §3 as a pure, dependency-free
 * library:
 *
 *  1. The *observed* annualized Sharpe a forward window of `days` daily
 *     observations must print to clear either the DSR gate (PSR/DSR >= bar at
 *     N=1, i.e. no selection penalty) or a plain two-sided t-test on the mean
 *     return (the bootstrap-CI / haircut gate proxy).
 *  2. The forward horizon (in years) needed to detect a given *true*
 *     annualized Sharpe with a chosen power at a chosen two-sided alpha.
 *  3. The equal-vol-weight ensemble Sharpe, the only legitimate power lever
 *     that does not raise N.
 *  4. A pre-flight gate combining the above: any pre-registered forward test
 *     whose powered horizon exceeds its declared window is auto-flagged
 *     (DEFER, or reframe as a KILL-only watch).
 *
 * All formulas use the normal approximation on daily returns (i.i.d., zero
 * skew/excess-kurtosis). The DSR's higher-moment correction moves the numbers
 * slightly but not materially (see §3 of the review).
 *
 * Normal quantile: Acklam's rational approximation (see {@link normalQuantile}),
 * absolute error < 1.15e-9 over the full open interval (0, 1) — far below the
 * +/-0.02 Sharpe tolerance any of these tables are read at.
 */

// ---------------------------------------------------------------------------
// Normal quantile (inverse CDF)
// ---------------------------------------------------------------------------

// Coefficients for Peter J. Acklam's rational approximation of the inverse
// normal CDF (2003). Relative/absolute error of the approximation is below
// 1.15e-9 everywhere on (0, 1), which is orders of magnitude tighter than any
// tolerance used in this module, so no Halley/Newton refinement step is
// applied.
const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
] as const;
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
] as const;
const ACKLAM_P_LOW = 0.02425;
const ACKLAM_P_HIGH = 1 - ACKLAM_P_LOW;

/**
 * Standard normal quantile function z_p = Phi^{-1}(p).
 *
 * Acklam's rational approximation; absolute error < 1.15e-9 on (0, 1).
 * Throws on p outside the open interval (0, 1).
 */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new RangeError(
      `normalQuantile: p must be in the open interval (0, 1); got ${p}`,
    );
  }
  if (p < ACKLAM_P_LOW) {
    // Lower tail.
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q +
        ACKLAM_C[3]) *
        q +
        ACKLAM_C[4]) *
        q +
        ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q +
        ACKLAM_D[3]) *
        q +
        1)
    );
  }
  if (p > ACKLAM_P_HIGH) {
    // Upper tail (by symmetry).
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q +
        ACKLAM_C[3]) *
        q +
        ACKLAM_C[4]) *
        q +
        ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q +
        ACKLAM_D[3]) *
        q +
        1)
    );
  }
  // Central region.
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r +
      ACKLAM_A[3]) *
      r +
      ACKLAM_A[4]) *
      r +
      ACKLAM_A[5]) *
      q) /
    (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r +
      ACKLAM_B[3]) *
      r +
      ACKLAM_B[4]) *
      r +
      1)
  );
}

// ---------------------------------------------------------------------------
// 1. Required observed Sharpe on a forward window
// ---------------------------------------------------------------------------

export interface RequiredObservedSharpeOptions {
  /**
   * Number of return observations in the forward window. With the default
   * `periodsPerYear = 365` (daily crypto bars), this is calendar days.
   */
  days: number;
  /** Annualization frequency (observations per year). Default 365. */
  periodsPerYear?: number;
  /**
   * Which gate to clear:
   * - `'dsr'`: Deflated/Probabilistic Sharpe Ratio >= `dsrBar` at honest N=1
   *   (no trials penalty), normal approximation:
   *   SR_ann >= z_{dsrBar} * sqrt(periodsPerYear / (n - 1)).
   * - `'tstat'`: two-sided t-test on the mean daily return (bootstrap-CI /
   *   haircut gate proxy):
   *   SR_ann >= z_{1 - alpha/2} * sqrt(periodsPerYear / n).
   */
  criterion: "dsr" | "tstat";
  /** PSR/DSR confidence bar for the 'dsr' criterion. Default 0.95. */
  dsrBar?: number;
  /** Two-sided significance level for the 'tstat' criterion. Default 0.05. */
  alpha?: number;
}

/**
 * Minimum *observed* annualized Sharpe a forward window must print to pass
 * the given gate (normal approximation, i.i.d. daily returns, honest N=1).
 */
export function requiredObservedSharpeAnnual(
  options: RequiredObservedSharpeOptions,
): number {
  const { days, periodsPerYear = 365, criterion, dsrBar = 0.95, alpha = 0.05 } =
    options;
  if (!Number.isFinite(days) || days <= 0) {
    throw new RangeError(
      `requiredObservedSharpeAnnual: days must be a positive number; got ${days}`,
    );
  }
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) {
    throw new RangeError(
      `requiredObservedSharpeAnnual: periodsPerYear must be positive; got ${periodsPerYear}`,
    );
  }
  if (criterion === "dsr") {
    if (days <= 1) {
      throw new RangeError(
        `requiredObservedSharpeAnnual: dsr criterion needs days > 1; got ${days}`,
      );
    }
    return normalQuantile(dsrBar) * Math.sqrt(periodsPerYear / (days - 1));
  }
  if (criterion === "tstat") {
    return normalQuantile(1 - alpha / 2) * Math.sqrt(periodsPerYear / days);
  }
  throw new RangeError(
    `requiredObservedSharpeAnnual: unknown criterion ${String(criterion)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Powered horizon for a true Sharpe
// ---------------------------------------------------------------------------

export interface PoweredHorizonOptions {
  /** Assumed *true* annualized Sharpe of the mechanism. Must be > 0. */
  trueSharpeAnnual: number;
  /** Desired statistical power (1 - beta). Default 0.8. */
  power?: number;
  /** Two-sided significance level. Default 0.05. */
  alpha?: number;
}

/**
 * Years of forward data needed to detect `trueSharpeAnnual` with the given
 * power at the given two-sided alpha (normal approximation):
 *
 *   years = ((z_{1 - alpha/2} + z_{power}) / trueSharpeAnnual)^2
 *
 * Defaults (power 0.8, alpha 0.05) give the §3 rule of thumb
 * years ~= (2.8 / SR_true)^2.
 */
export function poweredHorizonYears(options: PoweredHorizonOptions): number {
  const { trueSharpeAnnual, power = 0.8, alpha = 0.05 } = options;
  if (!Number.isFinite(trueSharpeAnnual) || trueSharpeAnnual <= 0) {
    throw new RangeError(
      `poweredHorizonYears: trueSharpeAnnual must be > 0; got ${trueSharpeAnnual}`,
    );
  }
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return (z / trueSharpeAnnual) ** 2;
}

// ---------------------------------------------------------------------------
// 3. Ensemble Sharpe (equal-vol-weight)
// ---------------------------------------------------------------------------

export interface EnsembleSharpeOptions {
  /** Annualized Sharpe of each sleeve. */
  sharpes: number[];
  /** Common pairwise return correlation across sleeves. */
  rho: number;
}

/**
 * Annualized Sharpe of an equal-vol-weight portfolio of `k` sleeves with
 * Sharpes S_i and a common pairwise correlation rho:
 *
 *   SR_portfolio = sum(S_i) / sqrt(k + k(k-1) * rho)
 *
 * Assumption: every sleeve is scaled to the same return volatility (equal
 * vol weights), so portfolio mean = sum of sleeve means (per unit vol) and
 * portfolio variance = k + k(k-1)*rho unit-vol terms. This is the only
 * legitimate power lever that does not raise N: it raises the portfolio's
 * true Sharpe, shrinking the powered horizon, without multiplying trials.
 */
export function ensembleSharpeAnnual(options: EnsembleSharpeOptions): number {
  const { sharpes, rho } = options;
  const k = sharpes.length;
  if (k === 0) {
    throw new RangeError("ensembleSharpeAnnual: sharpes must be non-empty");
  }
  if (!sharpes.every((s) => Number.isFinite(s))) {
    throw new RangeError("ensembleSharpeAnnual: every sharpe must be finite");
  }
  if (!Number.isFinite(rho) || rho > 1) {
    throw new RangeError(`ensembleSharpeAnnual: rho must be <= 1; got ${rho}`);
  }
  const variance = k + k * (k - 1) * rho;
  if (variance <= 0) {
    // For k sleeves a common correlation must satisfy rho > -1/(k-1).
    throw new RangeError(
      `ensembleSharpeAnnual: rho = ${rho} is infeasible for k = ${k} sleeves (needs rho > ${-1 / (k - 1)})`,
    );
  }
  const sum = sharpes.reduce((acc, s) => acc + s, 0);
  return sum / Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// 4. Pre-flight power check (the lab's auto-flag gate)
// ---------------------------------------------------------------------------

export interface PreflightPowerCheckOptions {
  /** Length of the declared (pre-registered) forward window, in years. */
  declaredWindowYears: number;
  /** Assumed *true* annualized Sharpe of the mechanism under test. */
  assumedTrueSharpeAnnual: number;
  /** Desired statistical power. Default 0.8. */
  power?: number;
  /** Two-sided significance level. Default 0.05. */
  alpha?: number;
  /** PSR/DSR confidence bar. Default 0.95. */
  dsrBar?: number;
  /** Annualization frequency (observations per year). Default 365. */
  periodsPerYear?: number;
}

export interface PreflightPowerCheckResult {
  /** Observed annualized Sharpe the window must print to clear DSR >= dsrBar. */
  requiredObservedSharpeDsr: number;
  /** Observed annualized Sharpe the window must print to clear the t-test. */
  requiredObservedSharpeT: number;
  /** Powered horizon (years) for the assumed true Sharpe. */
  poweredYears: number;
  /** True iff poweredYears <= declaredWindowYears. */
  feasible: boolean;
  /** Human-readable verdict including the lab's auto-flag rule. */
  recommendation: string;
}

/**
 * Pre-flight gate for pre-registered forward tests (§3 consequence 5).
 *
 * Lab rule: any pre-registered forward test whose powered horizon exceeds its
 * declared window must be auto-flagged — DEFER it, or reframe it as a
 * KILL-only watch (falsification power is asymmetric and stays cheap; only
 * SURVIVE claims hit the power wall).
 */
export function preflightPowerCheck(
  options: PreflightPowerCheckOptions,
): PreflightPowerCheckResult {
  const {
    declaredWindowYears,
    assumedTrueSharpeAnnual,
    power = 0.8,
    alpha = 0.05,
    dsrBar = 0.95,
    periodsPerYear = 365,
  } = options;
  if (!Number.isFinite(declaredWindowYears) || declaredWindowYears <= 0) {
    throw new RangeError(
      `preflightPowerCheck: declaredWindowYears must be > 0; got ${declaredWindowYears}`,
    );
  }
  const days = Math.round(declaredWindowYears * periodsPerYear);
  const requiredObservedSharpeDsr = requiredObservedSharpeAnnual({
    days,
    periodsPerYear,
    criterion: "dsr",
    dsrBar,
  });
  const requiredObservedSharpeT = requiredObservedSharpeAnnual({
    days,
    periodsPerYear,
    criterion: "tstat",
    alpha,
  });
  const poweredYears = poweredHorizonYears({
    trueSharpeAnnual: assumedTrueSharpeAnnual,
    power,
    alpha,
  });
  const feasible = poweredYears <= declaredWindowYears;
  const fmt = (x: number) => x.toFixed(2);
  const recommendation = feasible
    ? `PROCEED: a ${fmt(declaredWindowYears)}y window covers the ${fmt(poweredYears)}y powered horizon at true SR ${fmt(assumedTrueSharpeAnnual)} (power ${power}, alpha ${alpha}). The window must still print observed SR >= ${fmt(requiredObservedSharpeDsr)} (DSR >= ${dsrBar}) / ${fmt(requiredObservedSharpeT)} (t-test) to SURVIVE.`
    : `AUTO-FLAG (DEFER or reframe as KILL-only watch): powered horizon ${fmt(poweredYears)}y exceeds the declared ${fmt(declaredWindowYears)}y window at true SR ${fmt(assumedTrueSharpeAnnual)} (power ${power}, alpha ${alpha}). A SURVIVE on this window would require observed SR >= ${fmt(requiredObservedSharpeDsr)} (DSR >= ${dsrBar}) / ${fmt(requiredObservedSharpeT)} (t-test) — i.e. a fluke. The window can only KILL or extend.`;
  return {
    requiredObservedSharpeDsr,
    requiredObservedSharpeT,
    poweredYears,
    feasible,
    recommendation,
  };
}
