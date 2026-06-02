/**
 * Verdict report renderers — turn a `StrategyValidatorVerdict` into a clean human
 * Markdown report and a stable, schema-shaped JSON object.
 *
 * These are PURE: string/object in, string/object out. No filesystem, no network,
 * no clock unless the caller supplies one (`meta.createdAt`). The JSON shape is
 * deliberately aligned with `schemas/verdict.schema.json` + `schemas/gate.schema.json`
 * (field names `hypothesisId`, `verdict`, `bindingGate`, `trialCount`, `gates[]` with
 * `id`/`status`/`reason`/optional `binding`/`detail`) so the emitted object validates
 * against those schemas.
 *
 * Note on `verdict`: the schema's `verdict` enum is the RICHER scientific verdict
 * (SURVIVE | PROMISING | KILL | DEFERRED | INDETERMINATE), so `renderVerdictJson`
 * maps `StrategyValidatorVerdict.scientificVerdict` into the schema's `verdict`
 * field. The Markdown report shows BOTH the scientific verdict and the binary
 * PASS/KILL verdict, as the human report should.
 */

import type {
  GateOutcome,
  StrategyValidatorVerdict,
} from "../validation/strategy-validator";

/** Caller-supplied report metadata. All optional; none of it is read from I/O. */
export interface ReportMeta {
  /** Stable identifier for the hypothesis / strategy under test. */
  hypothesisId?: string;
  /** One-line human explanation of why this label was assigned. */
  rationale?: string;
  /** ISO-8601 timestamp the verdict was produced (caller supplies; renderer never clocks). */
  createdAt?: string;
}

/** A gate, in the shape `schemas/gate.schema.json` requires. */
export interface VerdictJsonGate {
  id: GateOutcome["id"];
  status: GateOutcome["status"];
  reason: string;
  /** Present (and true) only on the single binding gate. */
  binding?: boolean;
  detail: GateOutcome["detail"];
}

/** The full verdict object, in the shape `schemas/verdict.schema.json` requires. */
export interface VerdictJson {
  hypothesisId: string;
  verdict: StrategyValidatorVerdict["scientificVerdict"];
  bindingGate: string | null;
  trialCount: number;
  gates: VerdictJsonGate[];
  rationale?: string;
  createdAt?: string;
}

const DEFAULT_HYPOTHESIS_ID = "unnamed-strategy";

/**
 * Render a stable, schema-shaped JSON object for the verdict. Matches
 * `verdict.schema.json` (required: hypothesisId, verdict, bindingGate, trialCount,
 * gates) and `gate.schema.json` (required per gate: id, status, reason).
 *
 * Deterministic: the same verdict + meta always produces a structurally identical
 * object. `verdict` carries the scientific verdict (the schema's enum); the binding
 * gate is flagged with `binding: true` on exactly one gate (the first FAIL), if any.
 */
export function renderVerdictJson(
  verdict: StrategyValidatorVerdict,
  meta: ReportMeta = {},
): VerdictJson {
  const gates: VerdictJsonGate[] = verdict.perGate.map((gate) => {
    const out: VerdictJsonGate = {
      id: gate.id,
      status: gate.status,
      reason: gate.reason,
      detail: { ...gate.detail },
    };
    if (verdict.bindingGate !== null && gate.id === verdict.bindingGate) {
      out.binding = true;
    }
    return out;
  });

  const json: VerdictJson = {
    hypothesisId:
      meta.hypothesisId && meta.hypothesisId.length > 0
        ? meta.hypothesisId
        : DEFAULT_HYPOTHESIS_ID,
    verdict: verdict.scientificVerdict,
    bindingGate: verdict.bindingGate,
    trialCount: verdict.trialCount,
    gates,
  };
  if (meta.rationale !== undefined) json.rationale = meta.rationale;
  if (meta.createdAt !== undefined) json.createdAt = meta.createdAt;
  return json;
}

/** Status glyph for the per-gate table (ASCII-safe, stable). */
function statusMark(status: GateOutcome["status"]): string {
  switch (status) {
    case "PASS":
      return "PASS";
    case "FAIL":
      return "FAIL";
    case "SKIP":
      return "SKIP";
    case "ADVISORY":
      return "ADVISORY";
    default:
      return status;
  }
}

/** Escape pipes/newlines so a reason never breaks the Markdown table. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Render a clean, human-readable Markdown report for the verdict: the scientific
 * verdict + the binary PASS/KILL verdict, the honest N, the binding gate, and a
 * per-gate table (id / status / passed / reason). Pure: string in, string out.
 */
export function renderVerdictMarkdown(
  verdict: StrategyValidatorVerdict,
  meta: ReportMeta = {},
): string {
  const hypothesisId =
    meta.hypothesisId && meta.hypothesisId.length > 0
      ? meta.hypothesisId
      : DEFAULT_HYPOTHESIS_ID;
  const bindingGate = verdict.bindingGate ?? "none (all gates passed)";

  const lines: string[] = [];
  lines.push(`# Verdict — ${hypothesisId}`);
  lines.push("");
  lines.push(`- **Scientific verdict:** ${verdict.scientificVerdict}`);
  lines.push(`- **Verdict (binary):** ${verdict.verdict}`);
  lines.push(`- **Binding gate:** ${bindingGate}`);
  lines.push(`- **Honest N (trialCount):** ${verdict.trialCount}`);
  if (meta.rationale !== undefined && meta.rationale.length > 0) {
    lines.push(`- **Rationale:** ${cell(meta.rationale)}`);
  }
  if (meta.createdAt !== undefined && meta.createdAt.length > 0) {
    lines.push(`- **Created at:** ${meta.createdAt}`);
  }
  lines.push("");

  // Headline net-of-cost stats for quick reading.
  const net = verdict.netStats;
  lines.push("## Headline net-of-cost stats");
  lines.push("");
  lines.push(`- Net compound return: ${fmt(net.compoundReturn)}`);
  lines.push(`- Net Sharpe: ${fmt(net.sharpe)} (gross Sharpe ${fmt(net.grossSharpe)})`);
  lines.push(`- Mean per period: ${fmt(net.mean)}`);
  lines.push(`- Turnover: ${fmt(net.turnover)}`);
  lines.push(`- Sample count: ${net.sampleCount}`);
  lines.push("");

  // Per-gate table: id / status / passed / reason, in evaluation order. The binding
  // gate (first FAIL) is flagged so a reader sees what bound the verdict at a glance.
  lines.push("## Gates (in evaluation order)");
  lines.push("");
  lines.push("| Gate | Status | Passed | Binding | Reason |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const gate of verdict.perGate) {
    const isBinding =
      verdict.bindingGate !== null && gate.id === verdict.bindingGate;
    lines.push(
      `| ${cell(gate.id)} | ${statusMark(gate.status)} | ${
        gate.passed ? "yes" : "no"
      } | ${isBinding ? "yes" : ""} | ${cell(gate.reason)} |`,
    );
  }
  lines.push("");

  // The single binding constraint, spelled out (or a clean SURVIVE statement).
  lines.push("## Binding constraint");
  lines.push("");
  if (verdict.bindingGate === null) {
    lines.push(
      "Every gate passed — no binding constraint. The edge survived the full gauntlet.",
    );
  } else {
    const binding = verdict.perGate.find((g) => g.id === verdict.bindingGate);
    lines.push(
      `The first failing gate was **${verdict.bindingGate}**: ${
        binding ? cell(binding.reason) : "(reason unavailable)"
      }`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

/** Format a number stably for the human report (5 dp, finite-safe). */
function fmt(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(5);
}
