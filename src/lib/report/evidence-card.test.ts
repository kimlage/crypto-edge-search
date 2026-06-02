/**
 * Tests for the compact evidence-card renderer (`renderEvidenceCard`).
 *
 * Coverage:
 *   1. KILL CARD — contains the verdict, hypothesis id, binding gate and decisive
 *      number, and every fixed-order template field label.
 *   2. PROMISING / SURVIVE — the verdict headline and null-binding-gate path render.
 *   3. PURITY / DETERMINISM — identical input ⇒ byte-identical output; no FS.
 */

import { describe, expect, it } from "vitest";

import {
  renderEvidenceCard,
  type EvidenceCardInput,
} from "./evidence-card";

const TEMPLATE_LABELS = [
  "Belief:",
  "Tested:",
  "Best in-sample:",
  "Binding gate:",
  "Decisive number:",
  "Why it died:",
  "What would revive it:",
] as const;

const KILL_CARD: EvidenceCardInput = {
  hypothesisId: "btc-exchange-reserve-depletion",
  verdict: "KILL",
  belief: "Exchange-reserve depletion predicts BTC up-moves",
  tested: "2019-2025 daily, phase + block surrogate null, honest N=96",
  bestInSample: "in-sample Sharpe 0.994 before the gauntlet",
  bindingGate: "surrogate",
  decisiveNumber: "family-wise MAX-stat: real-best 0.994 < surr95 1.19 (placeboP~=0.24)",
  whyItDied:
    "The lead is grid-selection noise: surrogates score equal-or-better under the family-wise MAX-statistic.",
  whatWouldReviveIt:
    "A real-best that clears surr95 on a pre-registered single config (no grid search).",
};

describe("renderEvidenceCard", () => {
  it("renders a KILL card with the verdict, binding gate and decisive number", () => {
    const md = renderEvidenceCard(KILL_CARD);

    expect(md).toContain("KILL");
    expect(md).toContain("btc-exchange-reserve-depletion");
    // binding gate + decisive number are the two load-bearing facts on a KILL card.
    expect(md).toContain("surrogate");
    expect(md).toContain("placeboP~=0.24");
    // every fixed-order template field label is present.
    for (const label of TEMPLATE_LABELS) {
      expect(md, `missing card field: ${label}`).toContain(label);
    }
  });

  it("preserves the fixed field order (Belief … What would revive it)", () => {
    const md = renderEvidenceCard(KILL_CARD);
    const positions = TEMPLATE_LABELS.map((label) => md.indexOf(label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("renders a PROMISING card and a null binding gate as an em-dash", () => {
    const md = renderEvidenceCard({
      ...KILL_CARD,
      hypothesisId: "xs-donchian-long-short",
      verdict: "PROMISING",
      bindingGate: null,
      whyItDied:
        "Structure is real but the honest-N magnitude significance is not — never crossed PROMISING→SURVIVE.",
    });
    expect(md).toContain("PROMISING");
    expect(md).toContain("xs-donchian-long-short");
    expect(md).toContain("Binding gate:** —");
  });

  it("is pure/deterministic: identical input ⇒ byte-identical output", () => {
    const a = renderEvidenceCard(KILL_CARD);
    const b = renderEvidenceCard(KILL_CARD);
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
  });
});
