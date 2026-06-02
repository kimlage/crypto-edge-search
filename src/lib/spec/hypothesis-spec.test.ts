/**
 * Tests for the pre-registration HYPOTHESIS spec loader (`loadHypothesisSpec`).
 *
 * Load-bearing contracts:
 *   - the two committed example hypotheses load from YAML (one preregistered_single,
 *     one searched_grid) and round-trip through the YAML serializer;
 *   - a JSON string and its YAML serialization yield structurally identical objects;
 *   - a missing required field fails LOUDLY with a field-named SpecValidationError;
 *   - the honest-N invariants are enforced (preregistered_single ⇒ N=1; searched_grid
 *     ⇒ N ≥ 2);
 *   - a searched_grid spec is flagged by `requiresFamilyValidation`, a single is not.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";

import {
  loadHypothesisSpec,
  requiresFamilyValidation,
  type HypothesisSpec,
} from "./hypothesis-spec";
import { SpecValidationError } from "./load-spec";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo-relative path to the committed example hypotheses (no absolute machine path).
const EXAMPLES = path.resolve(dirname, "../../../examples/hypotheses");

function readExample(name: string): string {
  return readFileSync(path.join(EXAMPLES, name), "utf8");
}

describe("loadHypothesisSpec", () => {
  it("loads the preregistered_single example and earns an honest N=1", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    expect(spec.id).toBe("rsi2-mean-reversion-btc");
    expect(spec.claimType).toBe("predictive");
    expect(spec.search.selection_mode).toBe("preregistered_single");
    expect(spec.search.configCount).toBe(1);
    expect(spec.data.pointInTime).toBe("as_of");
    expect(spec.data.fidelity).toBe("executable");
    expect(spec.cost.taker_bps_per_side).toBe(5);
    expect(spec.surrogate.type).toBe("block");
    expect(spec.holdout).toEqual({ policy: "tail", fraction: 0.2 });
    expect(spec.baselines).toContain("buy_and_hold");
    expect(requiresFamilyValidation(spec)).toBe(false);

    // Round-trip via the YAML serializer yields a structurally identical object.
    const reserialized = loadHypothesisSpec(toYaml(spec));
    expect(reserialized).toEqual(spec);
  });

  it("loads the searched_grid example and flags it as requiring family validation", () => {
    const spec = loadHypothesisSpec(readExample("xs-donchian-family.yaml"));
    expect(spec.id).toBe("xs-donchian-breakout-top20");
    expect(spec.claimType).toBe("structural");
    expect(spec.search.selection_mode).toBe("searched_grid");
    expect(spec.search.configCount).toBe(24);
    expect(spec.search.configHash).toMatch(/^sha256:/);
    expect(spec.surrogate.type).toBe("family_max");
    // A searched grid CANNOT be honestly judged as a single series.
    expect(requiresFamilyValidation(spec)).toBe(true);
  });

  it("parses identically from a JSON string and its YAML serialization", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    const json = JSON.stringify(spec);
    const fromJson = loadHypothesisSpec(json);
    const fromYaml = loadHypothesisSpec(toYaml(fromJson));
    expect(fromJson).toEqual(spec);
    expect(fromYaml).toEqual(spec);
  });

  it("throws a field-named error on a missing required field (loud, not silent)", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    const broken = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
    delete broken.mechanism;
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrowError(SpecValidationError);
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrow(/mechanism/);
  });

  it("throws on a missing nested field (data.pointInTime) with the nested context", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    const broken = JSON.parse(JSON.stringify(spec)) as { data: Record<string, unknown> };
    delete broken.data.pointInTime;
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrow(
      /HypothesisSpec\.data.*pointInTime/,
    );
  });

  it("rejects an out-of-enum value (claimType) with the allowed set", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    const broken = { ...spec, claimType: "telepathic" } as unknown as HypothesisSpec;
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrow(/claimType.*one of/);
  });

  it("enforces the honest-N invariant: preregistered_single must have configCount === 1", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    const broken = JSON.parse(JSON.stringify(spec)) as { search: Record<string, unknown> };
    broken.search.configCount = 8; // a single hypothesis cannot search 8 configs
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrow(
      /preregistered_single.*exactly 1/,
    );
  });

  it("enforces the honest-N invariant: searched_grid must have configCount >= 2", () => {
    const spec = loadHypothesisSpec(readExample("xs-donchian-family.yaml"));
    const broken = JSON.parse(JSON.stringify(spec)) as { search: Record<string, unknown> };
    broken.search.configCount = 1; // a grid of one is just a preregistered single
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrow(/searched_grid.*≥ 2/);
  });

  it("rejects an empty baselines array (a claim must beat at least one baseline)", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    const broken = { ...spec, baselines: [] };
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrow(/baselines.*at least 1/);
  });

  it("rejects a holdout fraction outside [0, 1)", () => {
    const spec = loadHypothesisSpec(readExample("preregistered-rsi.yaml"));
    const broken = JSON.parse(JSON.stringify(spec)) as { holdout: Record<string, unknown> };
    broken.holdout.fraction = 1.0;
    expect(() => loadHypothesisSpec(JSON.stringify(broken))).toThrow(/holdout\.fraction/);
  });
});
