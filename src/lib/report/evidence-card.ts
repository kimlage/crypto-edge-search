/**
 * Evidence card renderer — a compact, shareable KILL / PROMISING / SURVIVE card.
 *
 * This is the project's one-screen "what we believed, what we tested, why it died,
 * what would revive it" card (the same shape the RESULTS ledger summarizes each
 * hypothesis with). It is PURE: an input object in, a Markdown string out. No I/O,
 * no clock, no schema coupling — it is the human-facing companion to the
 * machine-readable verdict JSON.
 *
 * Card template (fixed field order, so cards are scannable side-by-side):
 *   - Belief            — the human claim under test ("X predicts Y").
 *   - Tested            — how it was tested (window / null / honest N).
 *   - Best in-sample    — the prettiest in-sample number BEFORE the gauntlet bit.
 *   - Binding gate      — the first gate that failed (the decisive constraint).
 *   - Decisive number   — the one number that bound the verdict.
 *   - Why it died       — one honest sentence (or "survived" for a clean pass).
 *   - What would revive it — the concrete condition that would flip the verdict.
 */

/** Verdict label for the card headline. Mirrors the scientific verdict vocabulary. */
export type EvidenceCardVerdict =
  | "SURVIVE"
  | "PROMISING"
  | "KILL"
  | "DEFERRED"
  | "INDETERMINATE";

export interface EvidenceCardInput {
  /** Stable identifier / short title for the hypothesis. */
  hypothesisId: string;
  /** The verdict label (KILL / PROMISING / SURVIVE / ...). */
  verdict: EvidenceCardVerdict;
  /** The human claim under test, e.g. "Exchange-reserve depletion predicts BTC up-moves". */
  belief: string;
  /** How it was tested — window, null model, honest N. */
  tested: string;
  /** The prettiest in-sample number BEFORE the gauntlet (e.g. "in-sample Sharpe 1.33"). */
  bestInSample: string;
  /** The first gate that failed (the binding constraint), or null on a clean pass. */
  bindingGate: string | null;
  /** The single decisive number that bound the verdict (e.g. "placeboP=0.24 > 0.05"). */
  decisiveNumber: string;
  /** One honest sentence on why it died (omit / "survived" for a clean pass). */
  whyItDied: string;
  /** The concrete condition that would flip the verdict (e.g. "unseen OOS Sharpe > 0 at honest N"). */
  whatWouldReviveIt: string;
}

/** Fall back to an em-dash for an empty optional field, so the card stays aligned. */
function orDash(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "—";
}

/** Collapse newlines so a single card field stays on one logical line. */
function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/**
 * Render a compact, shareable evidence card in Markdown. The card leads with the
 * verdict + hypothesis id, then the fixed-order template fields. Pure and
 * deterministic: same input ⇒ byte-identical output.
 */
export function renderEvidenceCard(input: EvidenceCardInput): string {
  const lines: string[] = [];
  lines.push(`### ${input.verdict} — ${oneLine(input.hypothesisId)}`);
  lines.push("");
  lines.push(`- **Belief:** ${orDash(oneLine(input.belief))}`);
  lines.push(`- **Tested:** ${orDash(oneLine(input.tested))}`);
  lines.push(`- **Best in-sample:** ${orDash(oneLine(input.bestInSample))}`);
  lines.push(`- **Binding gate:** ${orDash(input.bindingGate)}`);
  lines.push(`- **Decisive number:** ${orDash(oneLine(input.decisiveNumber))}`);
  lines.push(`- **Why it died:** ${orDash(oneLine(input.whyItDied))}`);
  lines.push(
    `- **What would revive it:** ${orDash(oneLine(input.whatWouldReviveIt))}`,
  );
  return lines.join("\n");
}
