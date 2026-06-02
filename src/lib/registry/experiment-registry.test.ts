import { describe, expect, it } from "vitest";

import {
  ExperimentRegistry,
  InMemoryExperimentStore,
  JsonlExperimentStore,
  type ExperimentEntry,
} from "./experiment-registry";

function entry(overrides: Partial<ExperimentEntry> = {}): ExperimentEntry {
  return {
    runId: "run-1",
    strategyId: "tsmom",
    configCount: 5,
    verdict: "KILL",
    createdAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

describe("ExperimentRegistry.record / all", () => {
  it("records an entry verbatim and returns it normalized", () => {
    const registry = new ExperimentRegistry();
    const recorded = registry.record(
      entry({
        runId: "run-7",
        gitSha: "abc123",
        datasetHash: "deadbeef",
        family: "momentum",
        scientificVerdict: "no-edge",
        bindingGate: "DSR",
      }),
    );
    expect(recorded.runId).toBe("run-7");
    expect(recorded.gitSha).toBe("abc123");
    expect(recorded.bindingGate).toBe("DSR");
    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0]).toEqual(recorded);
  });

  it("defaults to the in-memory store and never reads the clock", () => {
    const registry = new ExperimentRegistry();
    const recorded = registry.record(entry({ createdAt: "2026-06-02T12:00:00Z" }));
    // createdAt is whatever the caller passed — nothing generated internally.
    expect(recorded.createdAt).toBe("2026-06-02T12:00:00Z");
    expect(new InMemoryExperimentStore().all()).toHaveLength(0);
  });

  it("omits optional fields that were not supplied", () => {
    const registry = new ExperimentRegistry();
    const recorded = registry.record(entry());
    expect("gitSha" in recorded).toBe(false);
    expect("family" in recorded).toBe(false);
    expect("scientificVerdict" in recorded).toBe(false);
  });
});

describe("ExperimentRegistry.find (spec form)", () => {
  it("queries by strategyId", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "a", strategyId: "tsmom" }));
    registry.record(entry({ runId: "b", strategyId: "carry" }));
    registry.record(entry({ runId: "c", strategyId: "tsmom" }));

    const hits = registry.find({ strategyId: "tsmom" });
    expect(hits.map((e) => e.runId)).toEqual(["a", "c"]);
  });

  it("queries by verdict", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "a", verdict: "KILL" }));
    registry.record(entry({ runId: "b", verdict: "PASS" }));
    registry.record(entry({ runId: "c", verdict: "KILL" }));

    const hits = registry.find({ verdict: "KILL" });
    expect(hits.map((e) => e.runId)).toEqual(["a", "c"]);
  });

  it("queries by since (inclusive, ISO-8601 string comparison)", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "old", createdAt: "2026-05-01T00:00:00Z" }));
    registry.record(entry({ runId: "boundary", createdAt: "2026-06-01T00:00:00Z" }));
    registry.record(entry({ runId: "new", createdAt: "2026-06-15T00:00:00Z" }));

    const hits = registry.find({ since: "2026-06-01T00:00:00Z" });
    expect(hits.map((e) => e.runId)).toEqual(["boundary", "new"]);
  });

  it("combines strategyId + verdict + since", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "a", strategyId: "tsmom", verdict: "KILL", createdAt: "2026-06-01T00:00:00Z" }));
    registry.record(entry({ runId: "b", strategyId: "tsmom", verdict: "PASS", createdAt: "2026-06-02T00:00:00Z" }));
    registry.record(entry({ runId: "c", strategyId: "carry", verdict: "KILL", createdAt: "2026-06-03T00:00:00Z" }));
    registry.record(entry({ runId: "d", strategyId: "tsmom", verdict: "KILL", createdAt: "2026-06-04T00:00:00Z" }));

    const hits = registry.find({ strategyId: "tsmom", verdict: "KILL", since: "2026-06-02T00:00:00Z" });
    expect(hits.map((e) => e.runId)).toEqual(["d"]);
  });
});

describe("ExperimentRegistry.find (predicate form)", () => {
  it("accepts an arbitrary predicate", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "a", configCount: 3 }));
    registry.record(entry({ runId: "b", configCount: 50 }));
    registry.record(entry({ runId: "c", configCount: 12 }));

    const hits = registry.find((e) => e.configCount >= 12);
    expect(hits.map((e) => e.runId)).toEqual(["b", "c"]);
  });
});

describe("ExperimentRegistry.latestFor", () => {
  it("returns the most recent entry for a strategy by createdAt", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "a", strategyId: "tsmom", createdAt: "2026-06-01T00:00:00Z" }));
    registry.record(entry({ runId: "b", strategyId: "tsmom", createdAt: "2026-06-10T00:00:00Z" }));
    registry.record(entry({ runId: "c", strategyId: "tsmom", createdAt: "2026-06-05T00:00:00Z" }));
    registry.record(entry({ runId: "x", strategyId: "carry", createdAt: "2026-06-20T00:00:00Z" }));

    expect(registry.latestFor("tsmom")?.runId).toBe("b");
  });

  it("breaks ties toward the later insertion", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "first", strategyId: "tsmom", createdAt: "2026-06-01T00:00:00Z" }));
    registry.record(entry({ runId: "second", strategyId: "tsmom", createdAt: "2026-06-01T00:00:00Z" }));
    expect(registry.latestFor("tsmom")?.runId).toBe("second");
  });

  it("returns null when no entry matches", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ strategyId: "tsmom" }));
    expect(registry.latestFor("nonexistent")).toBeNull();
  });
});

describe("append-only semantics + opt-in dedupe", () => {
  it("keeps BOTH records when two share a runId (append-only)", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "dup", verdict: "KILL", createdAt: "2026-06-01T00:00:00Z" }));
    registry.record(entry({ runId: "dup", verdict: "PASS", createdAt: "2026-06-02T00:00:00Z" }));

    expect(registry.all()).toHaveLength(2);
    const both = registry.find({});
    expect(both.map((e) => e.verdict)).toEqual(["KILL", "PASS"]);
  });

  it("dedupes by runId only when asked, keeping the latest per runId", () => {
    const registry = new ExperimentRegistry();
    registry.record(entry({ runId: "dup", verdict: "KILL", createdAt: "2026-06-01T00:00:00Z" }));
    registry.record(entry({ runId: "dup", verdict: "PASS", createdAt: "2026-06-02T00:00:00Z" }));
    registry.record(entry({ runId: "other", verdict: "CARRY", createdAt: "2026-06-03T00:00:00Z" }));

    const deduped = registry.find({ dedupeByRunId: true });
    expect(deduped).toHaveLength(2);
    // runId "dup" collapses to its LAST entry; first-seen runId order preserved.
    expect(deduped.map((e) => e.runId)).toEqual(["dup", "other"]);
    expect(deduped[0].verdict).toBe("PASS");
  });
});

describe("JsonlExperimentStore (cross-run persistence)", () => {
  it("round-trips entries through JSONL preserving fields and order", () => {
    const store = new JsonlExperimentStore();
    const registry = new ExperimentRegistry(store);
    registry.record(
      entry({
        runId: "r1",
        gitSha: "sha1",
        datasetHash: "data1",
        family: "momentum",
        scientificVerdict: "no-edge",
        bindingGate: "DSR",
        createdAt: "2026-06-01T00:00:00Z",
      }),
    );
    registry.record(entry({ runId: "r2", strategyId: "carry", verdict: "CARRY", createdAt: "2026-06-02T00:00:00Z" }));

    const text = store.serialize();
    expect(text.split("\n")).toHaveLength(2);

    const reloaded = new ExperimentRegistry(JsonlExperimentStore.parse(text));
    expect(reloaded.all()).toHaveLength(2);
    expect(reloaded.all()[0]).toEqual({
      runId: "r1",
      strategyId: "tsmom",
      configCount: 5,
      verdict: "KILL",
      createdAt: "2026-06-01T00:00:00Z",
      gitSha: "sha1",
      datasetHash: "data1",
      family: "momentum",
      scientificVerdict: "no-edge",
      bindingGate: "DSR",
    });
    expect(reloaded.latestFor("carry")?.runId).toBe("r2");
  });

  it("preserves duplicate runIds through serialization (append-only)", () => {
    const store = new JsonlExperimentStore();
    const registry = new ExperimentRegistry(store);
    registry.record(entry({ runId: "dup", verdict: "KILL" }));
    registry.record(entry({ runId: "dup", verdict: "PASS" }));

    const reloaded = new ExperimentRegistry(JsonlExperimentStore.parse(store.serialize()));
    expect(reloaded.all()).toHaveLength(2);
    expect(reloaded.find({ dedupeByRunId: true })).toHaveLength(1);
  });

  it("omits absent optional fields from serialized lines", () => {
    const store = new JsonlExperimentStore();
    store.append(entry());
    const line = store.serialize();
    expect(line).not.toContain("gitSha");
    expect(line).not.toContain("family");
    expect(JSON.parse(line)).toEqual({
      runId: "run-1",
      strategyId: "tsmom",
      configCount: 5,
      verdict: "KILL",
      createdAt: "2026-06-01T00:00:00Z",
    });
  });

  it("skips blank lines on parse", () => {
    const text = `${JSON.stringify(entry({ runId: "a" }))}\n\n${JSON.stringify(entry({ runId: "b" }))}\n`;
    const reloaded = new ExperimentRegistry(JsonlExperimentStore.parse(text));
    expect(reloaded.all().map((e) => e.runId)).toEqual(["a", "b"]);
  });
});
