/**
 * Tests for the `preregister` script's pure helpers (`parseArgs`, `freezeConfig`,
 * `preregisterSpec`).
 *
 * We exercise the script's exported, side-effect-free functions (the file's I/O
 * entrypoint only runs when invoked directly, so importing it here is safe). Contracts:
 *   - args parse: a positional + --out are required; unknown flags fail loudly;
 *   - freezing the SAME spec twice yields the SAME hash (deterministic);
 *   - a searched_grid spec freezes a different config (and hash) than a single;
 *   - the manifest carries the caller's createdAt verbatim (no clock in the library);
 *   - the manifest's frozen config never embeds an absolute / machine-local path
 *     (public-repo leak guard).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseArgs, freezeConfig, preregisterSpec } from "../scripts/preregister";
import { loadHypothesisSpec } from "../src/lib/spec/hypothesis-spec";
import { assertPreregistered } from "../src/lib/prereg/preregistration";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const HYPOTHESES = join(REPO_ROOT, "examples", "hypotheses");
const CREATED_AT = "2026-01-15T00:00:00.000Z";

function loadExample(name: string) {
  return loadHypothesisSpec(readFileSync(join(HYPOTHESES, name), "utf8"));
}

describe("preregister — parseArgs", () => {
  it("parses a positional hypothesis path and --out (both spaced and =)", () => {
    expect(parseArgs(["h.yaml", "--out", "m.json"])).toEqual({
      hypothesisPath: "h.yaml",
      out: "m.json",
      createdAt: undefined,
    });
    expect(parseArgs(["--out=m.json", "h.yaml", "--created-at", CREATED_AT])).toEqual({
      hypothesisPath: "h.yaml",
      out: "m.json",
      createdAt: CREATED_AT,
    });
  });

  it("fails loudly on a missing path, a missing --out, and unknown flags", () => {
    expect(() => parseArgs(["--out", "m.json"])).toThrow(/missing <hypothesis/);
    expect(() => parseArgs(["h.yaml"])).toThrow(/--out/);
    expect(() => parseArgs(["h.yaml", "--out", "m.json", "--bogus"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["h.yaml", "extra.yaml", "--out", "m.json"])).toThrow(/extra positional/);
  });
});

describe("preregister — freezeConfig / preregisterSpec", () => {
  it("freezes the same spec to the same hash (deterministic)", () => {
    const spec = loadExample("preregistered-rsi.yaml");
    const a = preregisterSpec(spec, CREATED_AT);
    const b = preregisterSpec(spec, CREATED_AT);
    expect(a.configHash).toBe(b.configHash);
    expect(a.createdAt).toBe(CREATED_AT); // caller's timestamp, verbatim
    // The manifest round-trips through its own lock.
    expect(() => assertPreregistered(a, freezeConfig(spec))).not.toThrow();
  });

  it("freezes a searched_grid spec to a different config than a single (honest N differs)", () => {
    const single = loadExample("preregistered-rsi.yaml");
    const grid = loadExample("xs-donchian-family.yaml");
    const singleFrozen = freezeConfig(single) as { selection: { configCount: number } };
    const gridFrozen = freezeConfig(grid) as { selection: { configCount: number } };
    expect(singleFrozen.selection.configCount).toBe(1);
    expect(gridFrozen.selection.configCount).toBe(24);
    expect(preregisterSpec(single, CREATED_AT).configHash).not.toBe(
      preregisterSpec(grid, CREATED_AT).configHash,
    );
  });

  it("never embeds an absolute or machine-local path in the frozen manifest (leak guard)", () => {
    for (const name of ["preregistered-rsi.yaml", "xs-donchian-family.yaml"]) {
      const manifest = preregisterSpec(loadExample(name), CREATED_AT);
      const serialized = JSON.stringify(manifest);
      for (const token of serialized.split(/["\s,{}[\]]+/)) {
        if (token.length === 0) continue;
        // Generic absolute-path / file-URI check (no machine-specific literals). A
        // leading slash only counts as a path when a path segment follows it, so a
        // lone prose separator ("long / short") is not a false positive.
        expect(/^\/[^/\s]|^[A-Za-z]:[\\/]|file:\/\//.test(token)).toBe(false);
      }
    }
  });
});
