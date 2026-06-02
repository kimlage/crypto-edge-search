import { describe, expect, it } from "vitest";

import {
  HoldoutLedger,
  InMemoryHoldoutStore,
  JsonlHoldoutStore,
} from "./holdout-ledger";

describe("HoldoutLedger.assertNotConsumed (re-consumption rejection)", () => {
  it("allows a slice to be consumed exactly once", () => {
    const ledger = new HoldoutLedger();
    const slice = { datasetHash: "ds-abc", rowStart: 850, rowEnd: 1000 };
    expect(ledger.isConsumed(slice)).toBe(false);
    const record = ledger.consume({
      ...slice,
      strategyId: "tsmom-best",
      runId: "milestone-1",
      consumedAt: "2026-05-29T00:00:00Z",
    });
    expect(record.strategyId).toBe("tsmom-best");
    expect(record.consumedAt).toBe("2026-05-29T00:00:00Z");
    expect(ledger.isConsumed(slice)).toBe(true);
    expect(ledger.consumedCount()).toBe(1);
  });

  it("throws when the SAME slice is consumed again", () => {
    const ledger = new HoldoutLedger();
    const slice = { datasetHash: "ds-abc", rowStart: 850, rowEnd: 1000 };
    ledger.consume({ ...slice, strategyId: "s1", runId: "r1" });
    expect(() => ledger.assertNotConsumed(slice)).toThrow(/already consumed/);
    expect(() => ledger.consume({ ...slice, strategyId: "s2", runId: "r2" })).toThrow(
      /already consumed/,
    );
  });

  it("rejects re-use of the vault by a DIFFERENT strategy or run", () => {
    const ledger = new HoldoutLedger();
    const slice = { datasetHash: "ds-abc", rowStart: 850, rowEnd: 1000 };
    ledger.consume({ ...slice, strategyId: "strategy-A", runId: "run-1" });
    // A second strategy trying to score the same vault is exactly the leak.
    expect(() =>
      ledger.consume({ ...slice, strategyId: "strategy-B", runId: "run-2" }),
    ).toThrow(/already consumed/);
    expect(ledger.consumedCount()).toBe(1);
  });

  it("allows a different slice of the same dataset", () => {
    const ledger = new HoldoutLedger();
    ledger.consume({ datasetHash: "ds-abc", rowStart: 850, rowEnd: 1000, strategyId: "s1", runId: "r1" });
    expect(() =>
      ledger.consume({ datasetHash: "ds-abc", rowStart: 700, rowEnd: 850, strategyId: "s2", runId: "r2" }),
    ).not.toThrow();
    expect(ledger.consumedCount()).toBe(2);
  });

  it("allows the same row range on a different dataset", () => {
    const ledger = new HoldoutLedger();
    ledger.consume({ datasetHash: "ds-abc", rowStart: 850, rowEnd: 1000, strategyId: "s1", runId: "r1" });
    expect(() =>
      ledger.consume({ datasetHash: "ds-xyz", rowStart: 850, rowEnd: 1000, strategyId: "s1", runId: "r1" }),
    ).not.toThrow();
  });

  it("never reads the clock — consumedAt is null unless passed in", () => {
    const ledger = new HoldoutLedger();
    const record = ledger.consume({
      datasetHash: "ds-abc",
      rowStart: 0,
      rowEnd: 100,
      strategyId: "s1",
      runId: "r1",
    });
    expect(record.consumedAt).toBeNull();
  });
});

describe("HoldoutLedger persistence (consume-once ACROSS runs)", () => {
  it("a slice consumed in a previous run is rejected after reload", () => {
    const run1 = new JsonlHoldoutStore();
    const ledger1 = new HoldoutLedger(run1);
    const slice = { datasetHash: "ds-abc", rowStart: 850, rowEnd: 1000 };
    ledger1.consume({ ...slice, strategyId: "s1", runId: "run-1", consumedAt: "2026-05-29T00:00:00Z" });

    // Fresh process: rehydrate from the serialized ledger.
    const text = run1.serialize();
    const ledger2 = new HoldoutLedger(JsonlHoldoutStore.parse(text));
    expect(ledger2.isConsumed(slice)).toBe(true);
    expect(() => ledger2.assertNotConsumed(slice)).toThrow(/already consumed/);
    expect(() => ledger2.consume({ ...slice, strategyId: "s2", runId: "run-2" })).toThrow(
      /already consumed/,
    );
  });

  it("round-trips records through JSONL", () => {
    const store = new JsonlHoldoutStore();
    const ledger = new HoldoutLedger(store);
    ledger.consume({ datasetHash: "ds-abc", rowStart: 850, rowEnd: 1000, strategyId: "s1", runId: "r1" });
    ledger.consume({ datasetHash: "ds-abc", rowStart: 700, rowEnd: 850, strategyId: "s2", runId: "r1" });

    const text = store.serialize();
    expect(text.split("\n")).toHaveLength(2);

    const reloaded = JsonlHoldoutStore.parse(text);
    expect(reloaded.all()).toHaveLength(2);
    expect(reloaded.all()[0].datasetHash).toBe("ds-abc");
    expect(reloaded.all()[0].rowEnd).toBe(1000);
  });

  it("InMemoryHoldoutStore is the default store", () => {
    const ledger = new HoldoutLedger();
    ledger.consume({ datasetHash: "d", rowStart: 0, rowEnd: 1, strategyId: "s", runId: "r" });
    expect(ledger.records()).toHaveLength(1);
    expect(new InMemoryHoldoutStore().all()).toHaveLength(0);
  });
});
