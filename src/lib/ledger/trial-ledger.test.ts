import { describe, expect, it } from "vitest";

import {
  InMemoryTrialStore,
  JsonlTrialStore,
  TrialLedger,
  canonicalize,
  stableConfigHash,
} from "./trial-ledger";

describe("stableConfigHash", () => {
  it("is insensitive to object key order", () => {
    const a = stableConfigHash({ lookback: 20, threshold: 0.5, symbol: "BTC" });
    const b = stableConfigHash({ symbol: "BTC", threshold: 0.5, lookback: 20 });
    expect(a).toBe(b);
  });

  it("is insensitive to key order in nested objects", () => {
    const a = stableConfigHash({ outer: { x: 1, y: 2 }, list: [{ a: 1, b: 2 }] });
    const b = stableConfigHash({ list: [{ b: 2, a: 1 }], outer: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it("distinguishes different values", () => {
    expect(stableConfigHash({ lookback: 20 })).not.toBe(stableConfigHash({ lookback: 21 }));
  });

  it("distinguishes array order (order is meaningful in arrays)", () => {
    expect(stableConfigHash([1, 2, 3])).not.toBe(stableConfigHash([3, 2, 1]));
  });

  it("is a fixed-width 16-char hex string", () => {
    expect(stableConfigHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats undefined object fields as absent (canonical)", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe("TrialLedger.honestN (distinct-config counting)", () => {
  it("counts distinct configs across many records", () => {
    const ledger = new TrialLedger();
    ledger.record({ config: { lookback: 10 } });
    ledger.record({ config: { lookback: 20 } });
    ledger.record({ config: { lookback: 30 } });
    expect(ledger.honestN()).toBe(3);
    expect(ledger.totalRecords()).toBe(3);
  });

  it("dedupes duplicate configs so honestN counts distinct, totalRecords counts all", () => {
    const ledger = new TrialLedger();
    const first = ledger.record({ config: { lookback: 10, symbol: "BTC" } });
    // same config, keys reordered, re-evaluated in another run
    const second = ledger.record({ config: { symbol: "BTC", lookback: 10 }, runId: "run-2" });
    ledger.record({ config: { lookback: 99 } });

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false); // duplicate detected despite key reorder
    expect(second.hash).toBe(first.hash);
    expect(ledger.honestN()).toBe(2); // two DISTINCT configs
    expect(ledger.totalRecords()).toBe(3); // three appended records (audit trail kept)
  });

  it("never reads the clock — timestamp is only stored when passed in", () => {
    const ledger = new TrialLedger();
    const noTs = ledger.record({ config: { a: 1 } });
    ledger.record({ config: { a: 2 }, timestamp: "2026-06-01T00:00:00Z" });
    const records = ledger.records();
    expect(noTs.isNew).toBe(true);
    expect(records[0].timestamp).toBeNull();
    expect(records[1].timestamp).toBe("2026-06-01T00:00:00Z");
  });

  it("DSR/haircut can read N straight from the ledger", () => {
    const ledger = new TrialLedger();
    const grid = [10, 20, 30, 40, 50];
    // search re-evaluates the whole grid 3 times (3 surrogate-like passes)
    for (let pass = 0; pass < 3; pass++) {
      for (const lookback of grid) ledger.record({ config: { lookback }, runId: `pass-${pass}` });
    }
    expect(ledger.totalRecords()).toBe(15);
    expect(ledger.honestN()).toBe(grid.length); // N = 5, not 15 and not 1
  });
});

describe("JsonlTrialStore (cross-run persistence)", () => {
  it("round-trips records through JSONL and preserves honestN", () => {
    const store = new JsonlTrialStore();
    const ledger = new TrialLedger(store);
    ledger.record({ config: { lookback: 10 }, label: "tsmom", runId: "r1", timestamp: "2026-06-01T00:00:00Z" });
    ledger.record({ config: { lookback: 20 }, label: "tsmom", runId: "r1" });
    ledger.record({ config: { lookback: 10 }, label: "tsmom", runId: "r1" }); // dup

    const text = store.serialize();
    expect(text.split("\n")).toHaveLength(3);

    const reloaded = new TrialLedger(JsonlTrialStore.parse(text));
    expect(reloaded.honestN()).toBe(2);
    expect(reloaded.totalRecords()).toBe(3);
    expect(reloaded.records()[0].timestamp).toBe("2026-06-01T00:00:00Z");
    expect(reloaded.records()[1].timestamp).toBeNull();
  });

  it("continues a previous run without double-counting carried-over configs", () => {
    const run1 = new JsonlTrialStore();
    const ledger1 = new TrialLedger(run1);
    ledger1.record({ config: { lookback: 10 } });
    ledger1.record({ config: { lookback: 20 } });

    // Next run: reload prior ledger, try one repeat + one new config.
    const ledger2 = new TrialLedger(JsonlTrialStore.parse(run1.serialize()));
    const repeat = ledger2.record({ config: { lookback: 20 } });
    const fresh = ledger2.record({ config: { lookback: 30 } });
    expect(repeat.isNew).toBe(false);
    expect(fresh.isNew).toBe(true);
    expect(ledger2.honestN()).toBe(3); // 10, 20, 30 — 20 not double counted
  });

  it("InMemoryTrialStore is the default store", () => {
    const ledger = new TrialLedger();
    ledger.record({ config: { a: 1 } });
    expect(ledger.records()).toHaveLength(1);
    expect(new InMemoryTrialStore().all()).toHaveLength(0);
  });
});
