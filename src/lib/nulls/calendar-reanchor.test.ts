/**
 * Tests for the calendar / event re-anchoring surrogate (calendar-reanchor.ts).
 *
 * Preserved: the series values, the per-observation bucket labels (the seasonal
 * shape), and the COUNT of special buckets.
 * Destroyed: the privilege of the originally chosen buckets — which buckets are
 * tagged "special" is reshuffled, so the chosen-date advantage cannot survive.
 * Plus determinism for a fixed seed.
 */

import { describe, expect, it } from "vitest";

import { calendarReanchor } from "./calendar-reanchor";

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

/** A daily series tagged with day-of-week buckets 0..6. */
function dayOfWeekFixture(seed: number, length: number) {
  const random = seededRandom(seed);
  const series: number[] = [];
  const buckets: number[] = [];
  for (let i = 0; i < length; i += 1) {
    series.push(random() - 0.5);
    buckets.push(i % 7);
  }
  return { series, buckets };
}

describe("calendarReanchor", () => {
  it("preserves the special-bucket COUNT", () => {
    const { series, buckets } = dayOfWeekFixture(1, 140);
    const specialBuckets = [1, 5]; // e.g. "Tuesday and Saturday are special"

    const out = calendarReanchor({ series, buckets, specialBuckets }, seededRandom(42));
    expect(out.specialBuckets).toHaveLength(specialBuckets.length);
    // No duplicate buckets in the re-anchored special set.
    expect(new Set(out.specialBuckets).size).toBe(out.specialBuckets.length);
    // Every chosen bucket is a real bucket in the data.
    for (const b of out.specialBuckets) expect(buckets).toContain(b);
  });

  it("preserves the series values and the bucket labels (the seasonal shape)", () => {
    const { series, buckets } = dayOfWeekFixture(2, 140);
    const out = calendarReanchor(
      { series, buckets, specialBuckets: [0, 3] },
      seededRandom(7),
    );
    expect(out.series).toEqual(series);
    expect(out.buckets).toEqual(buckets);
    // isSpecial is consistent with the re-anchored special set.
    const chosen = new Set(out.specialBuckets);
    for (let i = 0; i < buckets.length; i += 1) {
      expect(out.isSpecial[i]).toBe(chosen.has(buckets[i]!));
    }
  });

  it("DESTROYS the chosen-date privilege: the label assignment changes", () => {
    const { series, buckets } = dayOfWeekFixture(3, 210);
    const specialBuckets = [2]; // a single chosen bucket

    // Scan seeds: at least one re-anchoring must move the special label off bucket 2.
    let moved = false;
    for (let seed = 1; seed <= 20 && !moved; seed += 1) {
      const out = calendarReanchor({ series, buckets, specialBuckets }, seededRandom(seed));
      if (out.specialBuckets[0] !== 2) moved = true;
    }
    expect(moved).toBe(true);
  });

  it("re-anchors across the full pool over many seeds (not pinned to the original)", () => {
    const { series, buckets } = dayOfWeekFixture(4, 280);
    const seen = new Set<number>();
    for (let seed = 0; seed < 200; seed += 1) {
      const out = calendarReanchor({ series, buckets, specialBuckets: [4] }, seededRandom(seed));
      seen.add(out.specialBuckets[0]!);
    }
    // With 7 day-of-week buckets and 200 seeds, the chosen bucket lands on several
    // distinct days — the privilege is genuinely reshuffled, not fixed to day 4.
    expect(seen.size).toBeGreaterThan(3);
  });

  it("is deterministic given a seed", () => {
    const { series, buckets } = dayOfWeekFixture(5, 140);
    const a = calendarReanchor({ series, buckets, specialBuckets: [1, 6] }, seededRandom(123));
    const b = calendarReanchor({ series, buckets, specialBuckets: [1, 6] }, seededRandom(123));
    expect(a.specialBuckets).toEqual(b.specialBuckets);
    expect(a.isSpecial).toEqual(b.isSpecial);
  });

  it("clamps the special count to the available pool and handles empty inputs", () => {
    // Requesting more special buckets than exist clamps to the pool size.
    const tiny = calendarReanchor(
      { series: [0.1, -0.2, 0.3], buckets: [0, 1, 0], specialBuckets: [0, 1, 2, 3] },
      seededRandom(1),
    );
    // Pool is the distinct buckets {0,1} plus requested {0,1,2,3} = {0,1,2,3}.
    expect(tiny.specialBuckets.length).toBe(4);

    const empty = calendarReanchor({ series: [], buckets: [], specialBuckets: [] }, seededRandom(1));
    expect(empty.series).toEqual([]);
    expect(empty.specialBuckets).toEqual([]);
    expect(empty.isSpecial).toEqual([]);
  });
});
