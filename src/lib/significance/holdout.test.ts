import { describe, expect, it } from "vitest";

import {
  FinalHoldoutGuard,
  assertSearchDoesNotTouchHoldout,
  planHoldoutSplit,
} from "./holdout";

describe("planHoldoutSplit", () => {
  it("carves disjoint contiguous search/test/holdout blocks with the vault most recent", () => {
    const plan = planHoldoutSplit({ totalRows: 1000, holdoutFraction: 0.15, testFraction: 0.15 });
    expect(plan.search).toEqual({ start: 0, end: 700, rows: 700 });
    expect(plan.test).toEqual({ start: 700, end: 850, rows: 150 });
    expect(plan.finalHoldout).toEqual({ start: 850, end: 1000, rows: 150 });
    // contiguous + total
    expect(plan.search.end).toBe(plan.test.start);
    expect(plan.test.end).toBe(plan.finalHoldout.start);
    expect(plan.finalHoldout.end).toBe(1000);
  });

  it("degrades gracefully for tiny inputs", () => {
    const plan = planHoldoutSplit({ totalRows: 3 });
    expect(plan.search.rows + plan.test.rows + plan.finalHoldout.rows).toBe(3);
  });
});

describe("assertSearchDoesNotTouchHoldout", () => {
  it("passes when the search stays before the vault", () => {
    expect(() =>
      assertSearchDoesNotTouchHoldout({ searchMaxIndexExclusive: 850, holdoutStartIndex: 850 }),
    ).not.toThrow();
  });

  it("throws on leakage into the vault", () => {
    expect(() =>
      assertSearchDoesNotTouchHoldout({ searchMaxIndexExclusive: 851, holdoutStartIndex: 850 }),
    ).toThrow(/never be visible/);
  });
});

describe("FinalHoldoutGuard", () => {
  it("allows exactly one consumption and records reproducibility metadata", () => {
    const guard = new FinalHoldoutGuard();
    expect(guard.isConsumed()).toBe(false);
    const status = guard.consume({ reason: "milestone-1", gitSha: "abc123", trialCount: 1593, nowIso: "2026-05-29T00:00:00Z" });
    expect(status.consumed).toBe(true);
    expect(status.gitSha).toBe("abc123");
    expect(status.trialCount).toBe(1593);
    expect(guard.isConsumed()).toBe(true);
  });

  it("refuses a second consumption", () => {
    const guard = new FinalHoldoutGuard();
    guard.consume({ reason: "first" });
    expect(() => guard.consume({ reason: "second" })).toThrow(/already consumed/);
    expect(() => guard.assertNotConsumed()).toThrow(/already consumed/);
  });
});
