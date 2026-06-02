import { describe, expect, it } from "vitest";

import {
  dataQualityReport,
  medianOf,
  panelQualityReport,
} from "./data-quality";

/** A clean, well-behaved series with low noise around 0 and no defects. */
function cleanSeries(n: number): number[] {
  // Deterministic small wiggle (no RNG): a bounded sine, always finite & varied.
  return Array.from({ length: n }, (_, i) => Math.sin(i) * 0.001);
}

describe("dataQualityReport — missingness", () => {
  it("flags injected NaN / null / Infinity as missing", () => {
    const values = [0.01, Number.NaN, 0.02, null, 0.03, Infinity, 0.04];
    const r = dataQualityReport({ name: "s", values });
    expect(r.missingCount).toBe(3);
    expect(r.finiteCount).toBe(4);
    expect(r.missingFraction).toBeCloseTo(3 / 7, 10);
  });

  it("grades a high missing fraction as FAIL", () => {
    // 3 of 5 missing = 0.60 ≥ 0.20 default FAIL threshold.
    const r = dataQualityReport({ values: [1, Number.NaN, null, Infinity, 2] });
    expect(r.grade).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/missingFraction/);
  });

  it("grades a small missing fraction as WARN, not FAIL", () => {
    const values = cleanSeries(200);
    values[10] = Number.NaN; // 1/200 = 0.005 < warn 0.01 -> still PASS for missingness alone
    values[20] = Number.NaN; // 2/200 = 0.01 ≥ warn 0.01 -> WARN
    const r = dataQualityReport({ values });
    expect(r.missingCount).toBe(2);
    expect(r.grade).toBe("WARN");
  });
});

describe("dataQualityReport — timestamps", () => {
  it("reports 0 timestamp issues when no dates are supplied", () => {
    const r = dataQualityReport({ values: cleanSeries(10) });
    expect(r.duplicateTimestampCount).toBe(0);
    expect(r.duplicateOrNonMonotonicCount).toBe(0);
  });

  it("flags an injected duplicate timestamp and FAILs", () => {
    const values = cleanSeries(5);
    const dates = ["2026-01-01", "2026-01-02", "2026-01-02", "2026-01-03", "2026-01-04"];
    const r = dataQualityReport({ values, dates });
    expect(r.duplicateTimestampCount).toBe(1);
    expect(r.duplicateOrNonMonotonicCount).toBe(1);
    expect(r.grade).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/duplicate\/non-monotonic/);
  });

  it("flags a backwards (non-monotonic) timestamp without counting it as a duplicate", () => {
    const values = cleanSeries(4);
    const dates = ["2026-01-01", "2026-01-03", "2026-01-02", "2026-01-04"];
    const r = dataQualityReport({ values, dates });
    expect(r.duplicateTimestampCount).toBe(0);
    expect(r.duplicateOrNonMonotonicCount).toBe(1);
    expect(r.grade).toBe("FAIL");
  });
});

describe("dataQualityReport — outliers via MAD", () => {
  it("flags an injected outlier with the default k=8", () => {
    // Tight cluster around 0 plus one gross outlier.
    const values = [0, 0.1, -0.1, 0.05, -0.05, 0.02, -0.02, 0.0, 0.03, 100];
    const r = dataQualityReport({ values });
    expect(r.outlierCount).toBe(1);
    expect(r.grade).toBe("WARN");
    expect(r.reasons.join(" ")).toMatch(/MAD outlier/);
  });

  it("does not flag the outlier when k is raised above its robust z-score", () => {
    const values = [0, 0.1, -0.1, 0.05, -0.05, 0.02, -0.02, 0.0, 0.03, 100];
    const r = dataQualityReport({ values }, { outlierK: 100000 });
    expect(r.outlierCount).toBe(0);
  });

  it("does not over-flag a clean series (no false outliers)", () => {
    const r = dataQualityReport({ values: cleanSeries(500) });
    expect(r.outlierCount).toBe(0);
    expect(r.grade).toBe("PASS");
  });
});

describe("dataQualityReport — zero variance", () => {
  it("flags a constant column and FAILs", () => {
    const r = dataQualityReport({ values: [0.5, 0.5, 0.5, 0.5] });
    expect(r.zeroVariance).toBe(true);
    expect(r.grade).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/zero variance/);
  });

  it("does not flag a varied column", () => {
    const r = dataQualityReport({ values: cleanSeries(50) });
    expect(r.zeroVariance).toBe(false);
  });
});

describe("dataQualityReport — grading & determinism", () => {
  it("grades a clean series PASS with no reasons", () => {
    const r = dataQualityReport({ values: cleanSeries(300) });
    expect(r.grade).toBe("PASS");
    expect(r.reasons).toEqual([]);
  });

  it("FAILs a series with fewer than 2 finite values", () => {
    expect(dataQualityReport({ values: [] }).grade).toBe("FAIL");
    expect(dataQualityReport({ values: [1] }).grade).toBe("FAIL");
  });

  it("is deterministic: same input => identical report", () => {
    const values = [0, 0.1, -0.1, 100, Number.NaN];
    const a = dataQualityReport({ name: "s", values });
    const b = dataQualityReport({ name: "s", values });
    expect(a).toEqual(b);
  });
});

describe("panelQualityReport", () => {
  it("reports per-column and rolls up to the worst column grade", () => {
    // col 0: clean; col 1: constant (FAIL via zero variance).
    const rows: number[][] = [];
    for (let i = 0; i < 30; i++) rows.push([Math.sin(i) * 0.01, 0.5]);
    const report = panelQualityReport({ assets: ["A", "B"], panel: rows });
    expect(report.columns).toHaveLength(2);
    expect(report.columns[0].grade).toBe("PASS");
    expect(report.columns[1].grade).toBe("FAIL");
    expect(report.grade).toBe("FAIL");
    expect(report.reasons.some((r) => r.startsWith("B:"))).toBe(true);
  });

  it("applies the shared date axis to every column", () => {
    const rows = [
      [0.01, 0.02],
      [0.03, 0.04],
      [0.05, 0.06],
    ];
    const dates = ["2026-01-01", "2026-01-01", "2026-01-02"]; // duplicate at row 1
    const report = panelQualityReport({ assets: ["A", "B"], panel: rows, dates });
    expect(report.columns[0].duplicateTimestampCount).toBe(1);
    expect(report.columns[1].duplicateTimestampCount).toBe(1);
    expect(report.grade).toBe("FAIL");
  });
});

describe("medianOf", () => {
  it("handles odd and even lengths and returns NaN for empty", () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(medianOf([]))).toBe(true);
  });
});
