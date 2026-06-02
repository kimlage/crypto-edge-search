/**
 * Tests for the null registry (null-registry.ts).
 *
 * Asserted: every claim type resolves to an entry carrying a generator (a series
 * surrogate, a panel surrogate, or a structured-null name) AND a non-empty rationale;
 * an unknown claim type throws a clear error that enumerates the known types; and the
 * resolved series surrogates are deterministic per seed.
 */

import { describe, expect, it } from "vitest";

import {
  getNullForClaim,
  listClaimTypes,
  makeBracketNull,
  makeCalendarNull,
  type ClaimType,
} from "./null-registry";

/** mulberry32, matching the harness's seeded RNG. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALL_CLAIM_TYPES: ClaimType[] = [
  "time_series_timing",
  "cross_sectional_rotation",
  "path_dependent_exit",
  "vol_clustering",
  "variance_risk_premium",
  "calendar_event",
  "macro_sentiment",
  "nonlinear_structure",
];

function sampleSeries(seed: number, length: number): number[] {
  const random = seededRandom(seed);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < length; i += 1) {
    const value = 0.3 * prev + 0.02 * (random() - 0.5);
    out.push(value);
    prev = value;
  }
  return out;
}

describe("null-registry", () => {
  it("lists exactly the eight known claim types", () => {
    expect(new Set(listClaimTypes())).toEqual(new Set(ALL_CLAIM_TYPES));
    expect(listClaimTypes()).toHaveLength(ALL_CLAIM_TYPES.length);
  });

  it("resolves EVERY claim type to a generator + a non-empty rationale", () => {
    for (const claimType of ALL_CLAIM_TYPES) {
      const entry = getNullForClaim(claimType);
      expect(entry.claimType).toBe(claimType);
      expect(entry.rationale.length).toBeGreaterThan(20);
      expect(entry.generators.length).toBeGreaterThan(0);

      // Each entry exposes a generator appropriate to its kind.
      if (entry.kind === "series") {
        expect(typeof entry.surrogate).toBe("function");
      } else if (entry.kind === "panel") {
        expect(typeof entry.panelSurrogate).toBe("function");
      } else {
        // structured nulls (bracket, calendar) name their generator; the typed
        // factory is exercised separately below.
        expect(entry.kind).toBe("structured");
        expect(entry.surrogate).toBeUndefined();
        expect(entry.panelSurrogate).toBeUndefined();
      }
    }
  });

  it("maps each claim type to its expected approved generator name", () => {
    expect(getNullForClaim("time_series_timing").generators).toContain("phaseRandomize");
    expect(getNullForClaim("time_series_timing").generators).toContain("blockBootstrap");
    expect(getNullForClaim("cross_sectional_rotation").generators).toContain(
      "crossSectionalShuffle",
    );
    expect(getNullForClaim("path_dependent_exit").generators).toContain("bracketOnSurrogate");
    expect(getNullForClaim("vol_clustering").generators).toContain("garchSurrogate");
    expect(getNullForClaim("variance_risk_premium").generators).toContain("shuffledVrpPlacebo");
    expect(getNullForClaim("calendar_event").generators).toContain("calendarReanchor");
    expect(getNullForClaim("macro_sentiment").generators).toContain("arMatchedPlacebo");
    expect(getNullForClaim("nonlinear_structure").generators).toContain("iaaftSurrogate");
  });

  it("throws a clear, enumerated error for an unknown claim type", () => {
    expect(() => getNullForClaim("not_a_real_claim")).toThrow(/Unknown claim type/);
    // The message lists the known types so the caller can fix the typo.
    expect(() => getNullForClaim("not_a_real_claim")).toThrow(/time_series_timing/);
    expect(() => getNullForClaim("")).toThrow(/Unknown claim type/);
  });

  it("series surrogates resolved from the registry are deterministic per seed", () => {
    const series = sampleSeries(12345, 256);
    for (const claimType of ALL_CLAIM_TYPES) {
      const entry = getNullForClaim(claimType);
      if (entry.kind !== "series" || !entry.surrogate) continue;
      const a = entry.surrogate(series, seededRandom(42));
      const b = entry.surrogate(series, seededRandom(42));
      expect(a).toEqual(b);
      expect(a).toHaveLength(series.length);
    }
  });

  it("panel surrogate (cross-sectional rotation) is deterministic and preserves marginals", () => {
    const panel = [sampleSeries(1, 64), sampleSeries(2, 64), sampleSeries(3, 64)];
    const entry = getNullForClaim("cross_sectional_rotation");
    const a = entry.panelSurrogate!(panel, seededRandom(9));
    const b = entry.panelSurrogate!(panel, seededRandom(9));
    expect(a).toEqual(b);
    // Each row is one of the original asset paths (marginal preserved, just relabeled).
    for (const row of a) {
      expect(panel.some((p) => JSON.stringify(p) === JSON.stringify(row))).toBe(true);
    }
  });

  it("structured-null factories produce working, deterministic closures", () => {
    const returns = sampleSeries(7, 200);
    const bracketNull = makeBracketNull({ takeProfit: 0.03, stopLoss: 0.03, maxHold: 8 });
    const r1 = bracketNull(returns, seededRandom(3));
    const r2 = bracketNull(returns, seededRandom(3));
    expect(r1.surrogateTotals).toEqual(r2.surrogateTotals);
    expect(r1.p).toBeGreaterThan(0);

    const calendarNull = makeCalendarNull({
      series: returns,
      buckets: returns.map((_, i) => i % 7),
      specialBuckets: [1, 4],
    });
    const c1 = calendarNull(seededRandom(5));
    const c2 = calendarNull(seededRandom(5));
    expect(c1.specialBuckets).toEqual(c2.specialBuckets);
    expect(c1.specialBuckets).toHaveLength(2);
  });
});
