import { describe, expect, it } from "vitest";

import {
  buildDatasetManifest,
  canonicalize,
  sha256Hex,
  type DatasetManifest,
} from "./dataset-manifest";

/**
 * Minimal re-implementation of the schema validator's relevant checks, scoped to
 * the dataset-manifest required fields. We assert the built object carries every
 * required key (and required nested keys), with the right primitive types and the
 * schema's snake_case naming, so this stays in lockstep with
 * schemas/dataset-manifest.schema.json without importing the script's process.exit.
 */
function validatesAgainstManifestSchema(m: DatasetManifest): string[] {
  const errors: string[] = [];
  const KNOWN = new Set([
    "survivorship",
    "look_ahead",
    "selection",
    "regime_specific",
    "delisting_shock",
    "low_liquidity",
    "stablecoin_depeg",
    "exchange_specific",
    "none_known",
  ]);
  const req = (cond: boolean, msg: string) => {
    if (!cond) errors.push(msg);
  };
  req(typeof m.datasetId === "string" && m.datasetId.length >= 1, "datasetId");
  req(typeof m.source?.provider === "string" && m.source.provider.length >= 1, "source.provider");
  req(typeof m.source?.endpoint === "string" && m.source.endpoint.length >= 1, "source.endpoint");
  req(typeof m.period?.start === "string" && m.period.start.length >= 1, "period.start");
  req(typeof m.period?.end === "string" && m.period.end.length >= 1, "period.end");
  req(Array.isArray(m.symbols) && m.symbols.length >= 1, "symbols (minItems 1)");
  req(typeof m.hash === "string" && m.hash.length >= 1, "hash");
  req(Array.isArray(m.known_biases) && m.known_biases.length >= 1, "known_biases (minItems 1)");
  req(
    Array.isArray(m.known_biases) && m.known_biases.every((b) => KNOWN.has(b)),
    "known_biases enum",
  );
  req(
    typeof m.rate_limits?.requestsPerMinute === "number" && m.rate_limits.requestsPerMinute > 0,
    "rate_limits.requestsPerMinute (>0)",
  );
  return errors;
}

const baseInput = {
  datasetId: "funding-8h-majors-3y",
  source: { provider: "Binance", endpoint: "fapi.binance.com", accessedAt: "2026-05-30T00:00:00Z" },
  periodStart: "2023-05-01",
  periodEnd: "2026-05-29",
  granularity: "8h",
  symbols: ["BTCUSDT", "ETHUSDT"],
  knownBiases: ["survivorship", "regime_specific"] as const,
  rateLimits: { requestsPerMinute: 1200, weightPerMinute: 2400, notes: "back off on 429/418" },
};

describe("buildDatasetManifest — schema conformance", () => {
  it("produces an object satisfying the schema's required fields", () => {
    const m = buildDatasetManifest({ ...baseInput, rows: [{ t: 1, v: 2 }] });
    expect(validatesAgainstManifestSchema(m)).toEqual([]);
  });

  it("hashes with a sha256: prefix and 64 hex chars", () => {
    const m = buildDatasetManifest({ ...baseInput, rows: [1, 2, 3] });
    expect(m.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("carries through period granularity and source accessedAt", () => {
    const m = buildDatasetManifest({ ...baseInput, rows: "x" });
    expect(m.period).toEqual({ start: "2023-05-01", end: "2026-05-29", granularity: "8h" });
    expect(m.source.accessedAt).toBe("2026-05-30T00:00:00Z");
  });

  it("normalizes known_biases: dedupes, drops unknowns, canonical enum order", () => {
    const m = buildDatasetManifest({
      ...baseInput,
      rows: "x",
      knownBiases: ["regime_specific", "survivorship", "survivorship", "bogus" as never],
    });
    expect(m.known_biases).toEqual(["survivorship", "regime_specific"]);
  });

  it("defaults known_biases to ['none_known'] when none usable supplied", () => {
    const m = buildDatasetManifest({ ...baseInput, rows: "x", knownBiases: [] });
    expect(m.known_biases).toEqual(["none_known"]);
  });

  it("defaults rate limits to a conservative 60 rpm when omitted", () => {
    const { rateLimits: _omit, ...rest } = baseInput;
    const m = buildDatasetManifest({ ...rest, rows: "x" });
    expect(m.rate_limits).toEqual({ requestsPerMinute: 60 });
  });
});

describe("buildDatasetManifest — hash stability & sensitivity", () => {
  it("is deterministic for the same content", () => {
    const a = buildDatasetManifest({ ...baseInput, rows: [{ t: 1, close: 100 }, { t: 2, close: 101 }] });
    const b = buildDatasetManifest({ ...baseInput, rows: [{ t: 1, close: 100 }, { t: 2, close: 101 }] });
    expect(a.hash).toBe(b.hash);
  });

  it("is insensitive to object key order in rows (hash by value)", () => {
    const a = buildDatasetManifest({ ...baseInput, rows: [{ t: 1, close: 100 }] });
    const b = buildDatasetManifest({ ...baseInput, rows: [{ close: 100, t: 1 }] });
    expect(a.hash).toBe(b.hash);
  });

  it("changes when the content changes (sensitivity)", () => {
    const a = buildDatasetManifest({ ...baseInput, rows: [{ t: 1, close: 100 }] });
    const b = buildDatasetManifest({ ...baseInput, rows: [{ t: 1, close: 100.0001 }] });
    expect(a.hash).not.toBe(b.hash);
  });

  it("respects array order (row order is meaningful)", () => {
    const a = buildDatasetManifest({ ...baseInput, rows: [1, 2, 3] });
    const b = buildDatasetManifest({ ...baseInput, rows: [3, 2, 1] });
    expect(a.hash).not.toBe(b.hash);
  });

  it("contentForHash hashes the exact bytes and matches sha256Hex", () => {
    const text = "ts,close\n1,100\n2,101\n";
    const m = buildDatasetManifest({ ...baseInput, contentForHash: text });
    expect(m.hash).toBe(`sha256:${sha256Hex(text)}`);
  });

  it("sha256Hex matches a known vector for the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("buildDatasetManifest — input validation", () => {
  it("requires exactly one of rows / contentForHash (neither => throw)", () => {
    expect(() => buildDatasetManifest({ ...baseInput })).toThrow(/exactly one/);
  });

  it("requires exactly one of rows / contentForHash (both => throw)", () => {
    expect(() =>
      buildDatasetManifest({ ...baseInput, rows: "x", contentForHash: "y" }),
    ).toThrow(/exactly one/);
  });

  it("throws on empty datasetId / provider / endpoint", () => {
    expect(() => buildDatasetManifest({ ...baseInput, datasetId: "  ", rows: "x" })).toThrow(/datasetId/);
    expect(() =>
      buildDatasetManifest({ ...baseInput, source: { provider: "", endpoint: "x" }, rows: "x" }),
    ).toThrow(/provider/);
  });

  it("throws on empty symbols", () => {
    expect(() => buildDatasetManifest({ ...baseInput, symbols: [], rows: "x" })).toThrow(/symbol/);
  });

  it("throws on non-positive requestsPerMinute", () => {
    expect(() =>
      buildDatasetManifest({ ...baseInput, rows: "x", rateLimits: { requestsPerMinute: 0 } }),
    ).toThrow(/requestsPerMinute/);
  });
});

describe("canonicalize", () => {
  it("is insensitive to nested key order but sensitive to array order", () => {
    expect(canonicalize({ a: { x: 1, y: 2 } })).toBe(canonicalize({ a: { y: 2, x: 1 } }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("folds non-finite numbers to null", () => {
    expect(canonicalize(Number.NaN)).toBe("null");
    expect(canonicalize(Infinity)).toBe("null");
  });
});
