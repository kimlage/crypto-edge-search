/**
 * Tests for the verdict report renderers (`renderVerdictMarkdown` / `renderVerdictJson`).
 *
 * Coverage:
 *   1. JSON SHAPE — the emitted object carries every REQUIRED field of
 *      verdict.schema.json (hypothesisId, verdict, bindingGate, trialCount, gates)
 *      and every gate carries gate.schema.json's required fields (id, status, reason).
 *   2. JSON ENUMS — `verdict` is the scientific verdict enum; each gate `status` is a
 *      valid gate status; the binding gate is flagged with `binding: true` exactly once.
 *   3. MARKDOWN CONTENT — the report contains the scientific + binary verdict and the
 *      binding gate id, the honest N, and a per-gate row for every gate.
 *   4. PURITY / DETERMINISM — identical inputs produce byte-identical output; no FS.
 *   5. REAL VERDICT — a real `validateStrategy` KILL on seeded noise renders cleanly.
 */

import { describe, expect, it } from "vitest";

import {
  renderVerdictJson,
  renderVerdictMarkdown,
  type VerdictJson,
} from "./report-renderer";
import {
  validateStrategy,
  type GateOutcome,
  type StrategyValidatorVerdict,
} from "../validation/strategy-validator";

// --- schema field references (kept in lock-step with schemas/*.schema.json) -----

const VERDICT_REQUIRED = [
  "hypothesisId",
  "verdict",
  "bindingGate",
  "trialCount",
  "gates",
] as const;
const VERDICT_ENUM = [
  "SURVIVE",
  "PROMISING",
  "KILL",
  "DEFERRED",
  "INDETERMINATE",
] as const;
const GATE_REQUIRED = ["id", "status", "reason"] as const;
const GATE_STATUS_ENUM = ["PASS", "FAIL", "SKIP", "ADVISORY"] as const;
const GATE_ID_ENUM = [
  "net_of_cost",
  "baselines",
  "deflated_sharpe",
  "block_bootstrap",
  "cpcv_pbo",
  "haircut",
  "surrogate",
  "holdout",
] as const;

// --- deterministic fixtures -----------------------------------------------------

/** mulberry32, matching the harness's seeded RNG for reproducible inputs. */
function seededRandom(seed: number | string): () => number {
  let state =
    typeof seed === "number"
      ? seed >>> 0
      : (() => {
          let h = 2_166_136_261;
          for (let i = 0; i < seed.length; i += 1) {
            h ^= seed.charCodeAt(i);
            h = Math.imul(h, 16_777_619);
          }
          return h >>> 0;
        })();
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(rnd: () => number): number {
  const u1 = Math.max(1e-12, rnd());
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** A real KILL verdict: seeded mean-zero noise cannot be certified by the gauntlet. */
function realNoiseVerdict(): StrategyValidatorVerdict {
  const rnd = seededRandom("report-renderer-noise");
  const returns = Array.from({ length: 600 }, () => gaussian(rnd) * 0.01);
  return validateStrategy(returns, { trialCount: 50, seed: "report-renderer" });
}

/** A hand-built SURVIVE verdict (all gates pass) to exercise the no-binding path. */
function survivingVerdict(): StrategyValidatorVerdict {
  const gate = (
    id: GateOutcome["id"],
    label: string,
    status: GateOutcome["status"] = "PASS",
  ): GateOutcome => ({
    id,
    label,
    passed: status === "PASS" || status === "SKIP" || status === "ADVISORY",
    status,
    reason: `${id} ${status.toLowerCase()} for fixture`,
    detail: { score: 0.5, ok: true, note: "fixture" },
  });
  return {
    verdict: "PASS",
    scientificVerdict: "SURVIVE",
    bindingGate: null,
    perGate: [
      gate("net_of_cost", "Net-of-cost summary"),
      gate("baselines", "Baselines"),
      gate("deflated_sharpe", "Deflated Sharpe"),
      gate("block_bootstrap", "Block-bootstrap CI"),
      gate("cpcv_pbo", "CPCV / PBO", "SKIP"),
      gate("haircut", "Harvey-Liu haircut"),
      gate("surrogate", "Surrogate / placebo"),
      gate("holdout", "Consume-once holdout"),
    ],
    netStats: {
      sampleCount: 400,
      mean: 0.0008,
      sharpe: 1.1,
      compoundReturn: 0.32,
      turnover: 40,
      grossSharpe: 1.3,
    } as StrategyValidatorVerdict["netStats"],
    trialCount: 7,
  };
}

// --- 1+2. JSON SHAPE / ENUMS ----------------------------------------------------

describe("renderVerdictJson", () => {
  it("emits every required verdict-schema field with valid enum values", () => {
    const verdict = realNoiseVerdict();
    const json = renderVerdictJson(verdict, {
      hypothesisId: "noise-control",
      rationale: "seeded mean-zero noise cannot be certified",
      createdAt: "2026-06-02T00:00:00Z",
    });

    for (const field of VERDICT_REQUIRED) {
      expect(json, `missing required verdict field: ${field}`).toHaveProperty(
        field,
      );
    }
    expect(VERDICT_ENUM).toContain(json.verdict);
    expect(json.hypothesisId).toBe("noise-control");
    expect(typeof json.hypothesisId).toBe("string");
    expect(json.hypothesisId.length).toBeGreaterThan(0);
    expect(Number.isInteger(json.trialCount)).toBe(true);
    expect(json.trialCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(json.gates)).toBe(true);
    expect(json.gates.length).toBeGreaterThanOrEqual(1);
    // bindingGate is string|null and, when present, names a real gate.
    expect(
      json.bindingGate === null || typeof json.bindingGate === "string",
    ).toBe(true);
    // optional fields surface only when supplied.
    expect(json.rationale).toBe("seeded mean-zero noise cannot be certified");
    expect(json.createdAt).toBe("2026-06-02T00:00:00Z");
  });

  it("emits gate-schema-required fields and valid enums per gate", () => {
    const json = renderVerdictJson(realNoiseVerdict());
    for (const gate of json.gates) {
      for (const field of GATE_REQUIRED) {
        expect(gate, `gate missing required field: ${field}`).toHaveProperty(
          field,
        );
      }
      expect(GATE_ID_ENUM).toContain(gate.id);
      expect(GATE_STATUS_ENUM).toContain(gate.status);
      expect(typeof gate.reason).toBe("string");
      expect(gate.reason.length).toBeGreaterThan(0);
      // detail values are scalars (number | string | boolean | null) per gate.schema.json.
      for (const value of Object.values(gate.detail)) {
        const ok =
          value === null ||
          typeof value === "number" ||
          typeof value === "string" ||
          typeof value === "boolean";
        expect(ok, `non-scalar gate detail value: ${String(value)}`).toBe(true);
      }
    }
  });

  it("flags exactly one binding gate (the first FAIL) with binding:true", () => {
    const verdict = realNoiseVerdict();
    const json = renderVerdictJson(verdict);
    const flagged = json.gates.filter((g) => g.binding === true);
    if (verdict.bindingGate === null) {
      expect(flagged.length).toBe(0);
    } else {
      expect(flagged.length).toBe(1);
      expect(flagged[0]?.id).toBe(verdict.bindingGate);
    }
  });

  it("defaults hypothesisId and omits optional fields when meta is absent", () => {
    const json: VerdictJson = renderVerdictJson(survivingVerdict());
    expect(json.hypothesisId.length).toBeGreaterThan(0);
    expect(json.verdict).toBe("SURVIVE");
    expect(json.bindingGate).toBeNull();
    expect(json).not.toHaveProperty("rationale");
    expect(json).not.toHaveProperty("createdAt");
    expect(json.gates.some((g) => g.binding === true)).toBe(false);
  });

  it("is pure/deterministic: identical inputs ⇒ deep-equal output", () => {
    const v = realNoiseVerdict();
    const a = renderVerdictJson(v, { hypothesisId: "x", createdAt: "t" });
    const b = renderVerdictJson(v, { hypothesisId: "x", createdAt: "t" });
    expect(a).toEqual(b);
  });
});

// --- 3+4. MARKDOWN CONTENT / DETERMINISM ----------------------------------------

describe("renderVerdictMarkdown", () => {
  it("contains the scientific verdict, binary verdict, binding gate and honest N", () => {
    const verdict = realNoiseVerdict();
    const md = renderVerdictMarkdown(verdict, { hypothesisId: "noise-control" });

    expect(md).toContain(verdict.scientificVerdict);
    expect(md).toContain(verdict.verdict);
    expect(md).toContain("noise-control");
    expect(md).toContain(`Honest N (trialCount):** ${verdict.trialCount}`);
    // the binding gate id must appear in the report.
    expect(verdict.bindingGate).not.toBeNull();
    expect(md).toContain(String(verdict.bindingGate));
    // a per-gate row for every gate.
    for (const gate of verdict.perGate) {
      expect(md).toContain(gate.id);
    }
  });

  it("states a clean SURVIVE with no binding constraint", () => {
    const md = renderVerdictMarkdown(survivingVerdict());
    expect(md).toContain("SURVIVE");
    expect(md).toContain("no binding constraint");
    expect(md).toContain("Binding gate:** none (all gates passed)");
  });

  it("is pure/deterministic: identical inputs ⇒ identical string", () => {
    const v = realNoiseVerdict();
    const a = renderVerdictMarkdown(v, { hypothesisId: "x" });
    const b = renderVerdictMarkdown(v, { hypothesisId: "x" });
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
  });
});
