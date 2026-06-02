/**
 * Data-quality report (FRONT: data) — a deterministic health check run on a
 * returns/price series or an asset panel BEFORE it is allowed into a backtest.
 *
 * Why this exists: silent data defects masquerade as alpha. A handful of NaNs
 * filled forward, a duplicated or out-of-order timestamp, a single fat-fingered
 * outlier bar, or a constant (zero-variance) column can each manufacture or
 * destroy a "signal" that has nothing to do with the market. This module surfaces
 * those defects up front and grades the series PASS / WARN / FAIL so a caller can
 * gate on data hygiene the same way it gates on statistical significance.
 *
 * What it computes (per series, and aggregated across a panel):
 *   - missingness: count + fraction of non-finite values (NaN, null/undefined,
 *     ±Infinity), since any of those breaks downstream math silently.
 *   - duplicate / non-monotonic timestamps: when `dates` are supplied, how many
 *     rows repeat the previous timestamp or step backwards in time (look-ahead
 *     and double-counting both hide here). Without dates this is reported as 0.
 *   - outliers via the MAD rule: with median m and MAD = median(|x − m|), a point
 *     is an outlier when |x − m| / (MAD) > k (default k = 8). MAD is used instead
 *     of mean/σ because σ is itself inflated by the outliers it is meant to find.
 *     A consistency constant is NOT applied — we compare raw deviations to raw
 *     MAD, which is the conservative form and avoids assuming normality.
 *   - zero-variance flag: every finite value identical (a dead/constant column).
 *
 * Grading (worst-of across all rules; a panel takes the worst column grade):
 *   FAIL if any: missingFraction ≥ failMissingFraction (default 0.20), any
 *     duplicate/non-monotonic timestamp, zero variance, or < 2 finite values.
 *   WARN if any: missingFraction ≥ warnMissingFraction (default 0.01), or any
 *     MAD outlier.
 *   PASS otherwise.
 *
 * Pure and deterministic: no I/O, no Date.now, no RNG. Same input ⇒ same report.
 */

/** PASS / WARN / FAIL, in increasing severity. */
export type QualityGrade = "PASS" | "WARN" | "FAIL";

/** A single numeric series, optionally carrying one date string per value. */
export interface QualitySeriesInput {
  /** Series name, surfaced in the report (defaults to "series"). */
  name?: string;
  /** The values. Non-finite entries (NaN/null/Infinity) count as missing. */
  values: ReadonlyArray<number | null | undefined>;
  /** Optional timestamps aligned 1:1 with `values`, for duplicate/order checks. */
  dates?: ReadonlyArray<string | null | undefined>;
}

/** A wide asset panel: many named series sharing one date axis. */
export interface QualityPanelInput {
  /** One date string per row, aligned to every column in `panel`. */
  dates?: ReadonlyArray<string | null | undefined>;
  /** Column (asset) names, aligned to the inner index of `panel`. */
  assets: readonly string[];
  /** `panel[row][col]` aligned to `dates` (rows) and `assets` (columns). */
  panel: ReadonlyArray<ReadonlyArray<number | null | undefined>>;
}

/** Tunable thresholds. All have conservative defaults; pass to override. */
export interface DataQualityOptions {
  /** MAD outlier cutoff k: |x − median| / MAD > k flags an outlier. Default 8. */
  outlierK?: number;
  /** Missing-fraction at/above which the grade is at least WARN. Default 0.01. */
  warnMissingFraction?: number;
  /** Missing-fraction at/above which the grade is FAIL. Default 0.20. */
  failMissingFraction?: number;
}

/** The quality metrics for a single series. */
export interface SeriesQualityReport {
  name: string;
  /** Total entries inspected. */
  count: number;
  /** Count of finite values (count − missingCount). */
  finiteCount: number;
  /** Count of non-finite entries (NaN, null/undefined, ±Infinity). */
  missingCount: number;
  /** missingCount / count (0 when count is 0). */
  missingFraction: number;
  /** Rows whose timestamp repeats the previous one (only when dates supplied). */
  duplicateTimestampCount: number;
  /** Rows whose timestamp duplicates OR steps backwards vs. the previous one. */
  duplicateOrNonMonotonicCount: number;
  /** Count of finite values failing the MAD outlier rule. */
  outlierCount: number;
  /** Median of the finite values (NaN when none). */
  median: number;
  /** Median absolute deviation of the finite values (NaN when none). */
  mad: number;
  /** True when every finite value is identical (a constant column). */
  zeroVariance: boolean;
  /** Worst-of grade across this series' rules. */
  grade: QualityGrade;
  /** Human-readable reasons that drove a WARN/FAIL (empty when PASS). */
  reasons: string[];
}

/** The quality report for a whole panel: per-column plus a rolled-up grade. */
export interface PanelQualityReport {
  /** One report per asset column, in `assets` order. */
  columns: SeriesQualityReport[];
  /** Worst column grade — the panel's overall grade. */
  grade: QualityGrade;
  /** Reasons aggregated from the columns (prefixed by column name). */
  reasons: string[];
}

const DEFAULTS: Required<DataQualityOptions> = {
  outlierK: 8,
  warnMissingFraction: 0.01,
  failMissingFraction: 0.2,
};

/** Severity ordering so we can take the worst grade across rules/columns. */
const SEVERITY: Record<QualityGrade, number> = { PASS: 0, WARN: 1, FAIL: 2 };

/** Return the more severe of two grades. */
function worse(a: QualityGrade, b: QualityGrade): QualityGrade {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** True for a real, usable number; false for NaN, ±Infinity, null, undefined. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Report data quality for one series. Deterministic; the only "randomness" the
 * MAD rule could face — ties in the median — is resolved by the same sorted-array
 * convention every time.
 */
export function dataQualityReport(
  input: QualitySeriesInput,
  options: DataQualityOptions = {},
): SeriesQualityReport {
  const opts = { ...DEFAULTS, ...stripUndefined(options) };
  const name = input.name && input.name.length > 0 ? input.name : "series";
  const values = input.values ?? [];
  const count = values.length;

  const finite: number[] = [];
  let missingCount = 0;
  for (const v of values) {
    if (isFiniteNumber(v)) finite.push(v);
    else missingCount += 1;
  }
  const finiteCount = finite.length;
  const missingFraction = count === 0 ? 0 : missingCount / count;

  // Timestamp duplication / monotonicity (only meaningful when dates are given).
  let duplicateTimestampCount = 0;
  let duplicateOrNonMonotonicCount = 0;
  if (input.dates) {
    let prev: string | null = null;
    for (const raw of input.dates) {
      const d = typeof raw === "string" ? raw : null;
      if (prev !== null && d !== null) {
        if (d === prev) {
          duplicateTimestampCount += 1;
          duplicateOrNonMonotonicCount += 1;
        } else if (d < prev) {
          duplicateOrNonMonotonicCount += 1;
        }
      }
      // Advance only on a real timestamp so gaps of nulls don't fake an order break.
      if (d !== null) prev = d;
    }
  }

  // Robust center / scale and the MAD outlier count.
  const median = finiteCount > 0 ? medianOf(finite) : Number.NaN;
  const deviations = finite.map((x) => Math.abs(x - median));
  const mad = finiteCount > 0 ? medianOf(deviations) : Number.NaN;
  const zeroVariance = finiteCount > 0 && finite.every((x) => x === finite[0]);

  let outlierCount = 0;
  // With MAD === 0 the scale is degenerate (≥ half the points share the median),
  // so we cannot form a robust z-score; treat any nonzero deviation conservatively
  // as not-an-outlier here and let the zero-variance / spread rules speak instead.
  if (finiteCount > 0 && mad > 0) {
    for (const dev of deviations) {
      if (dev / mad > opts.outlierK) outlierCount += 1;
    }
  }

  const reasons: string[] = [];
  let grade: QualityGrade = "PASS";

  if (finiteCount < 2) {
    grade = worse(grade, "FAIL");
    reasons.push(`only ${finiteCount} finite value(s) — too few to assess`);
  }
  if (missingFraction >= opts.failMissingFraction) {
    grade = worse(grade, "FAIL");
    reasons.push(`missingFraction ${fmt(missingFraction)} ≥ FAIL ${opts.failMissingFraction}`);
  } else if (missingFraction >= opts.warnMissingFraction) {
    grade = worse(grade, "WARN");
    reasons.push(`missingFraction ${fmt(missingFraction)} ≥ WARN ${opts.warnMissingFraction}`);
  }
  if (duplicateOrNonMonotonicCount > 0) {
    grade = worse(grade, "FAIL");
    reasons.push(
      `${duplicateOrNonMonotonicCount} duplicate/non-monotonic timestamp(s) ` +
        `(${duplicateTimestampCount} exact duplicate(s))`,
    );
  }
  if (zeroVariance) {
    grade = worse(grade, "FAIL");
    reasons.push("zero variance (constant column)");
  }
  if (outlierCount > 0) {
    grade = worse(grade, "WARN");
    reasons.push(`${outlierCount} MAD outlier(s) at k=${opts.outlierK}`);
  }

  return {
    name,
    count,
    finiteCount,
    missingCount,
    missingFraction,
    duplicateTimestampCount,
    duplicateOrNonMonotonicCount,
    outlierCount,
    median,
    mad,
    zeroVariance,
    grade,
    reasons,
  };
}

/**
 * Report data quality for a whole panel by running {@link dataQualityReport} on
 * each column (sharing the panel's date axis) and rolling the column grades up to
 * a single worst-of grade. Deterministic; column order follows `assets`.
 */
export function panelQualityReport(
  input: QualityPanelInput,
  options: DataQualityOptions = {},
): PanelQualityReport {
  const assets = input.assets ?? [];
  const rows = input.panel ?? [];
  const columns: SeriesQualityReport[] = [];
  const reasons: string[] = [];
  let grade: QualityGrade = "PASS";

  for (let col = 0; col < assets.length; col++) {
    const values = rows.map((row) => (row ? row[col] : undefined));
    const report = dataQualityReport(
      { name: assets[col], values, dates: input.dates },
      options,
    );
    columns.push(report);
    grade = worse(grade, report.grade);
    for (const r of report.reasons) reasons.push(`${report.name}: ${r}`);
  }

  return { columns, grade, reasons };
}

/** Median of a numeric array via a sorted copy. Returns NaN for an empty array. */
export function medianOf(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Drop keys whose value is undefined so `{...DEFAULTS, ...opts}` keeps defaults. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** Compact, deterministic fraction formatting for reason strings. */
function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : String(x);
}
