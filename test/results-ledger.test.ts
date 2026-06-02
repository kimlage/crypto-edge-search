import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildLedger, auditedHeadline, type LedgerEntry } from "../scripts/build-results-ledger";
import { ledgerInvariantErrors } from "../scripts/validate-results-ledger";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const LEDGER_PATH = join(REPO_ROOT, "output", "results-ledger.json");

/** The committed ledger on disk (what every downstream consumer reads). */
const committed = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as LedgerEntry[];

/** The four leads the two-layer audit flipped raw-PROMISING -> audited-KILL. */
const FLIPPED = ["D5-08", "Q9-LOWVOL", "O3-NVTS", "VRP-HARVEST"];

describe("results-ledger — canonical audited headline", () => {
  it("the committed ledger has exactly 0 SURVIVE and 2 PROMISING", () => {
    const counts = auditedHeadline(committed);
    expect(counts.SURVIVE).toBe(0);
    expect(counts.PROMISING).toBe(2);
  });

  it("the 2 PROMISING are XS Donchian and dated-futures-unlevered-thin", () => {
    const promising = committed.filter((e) => e.auditedVerdict === "PROMISING").map((e) => e.id).sort();
    expect(promising).toEqual(["D1-LS-DONCH", "D8-C6-DATED"]);
  });

  it("everything else is KILL or DEFERRED (no SURVIVE/INDETERMINATE)", () => {
    const others = committed.filter((e) => e.auditedVerdict !== "PROMISING");
    for (const e of others) expect(["KILL", "DEFERRED"]).toContain(e.auditedVerdict);
  });
});

describe("results-ledger — the four audit flips", () => {
  it("flips exactly the four documented leads from PROMISING to KILL", () => {
    const flips = committed.filter((e) => e.rawVerdict !== e.auditedVerdict);
    expect(flips.map((e) => e.id).sort()).toEqual([...FLIPPED].sort());
    for (const f of flips) {
      expect(f.rawVerdict).toBe("PROMISING");
      expect(f.auditedVerdict).toBe("KILL");
    }
  });

  it("every flip carries an auditOverrideReason; no non-flip does", () => {
    for (const e of committed) {
      const flipped = e.rawVerdict !== e.auditedVerdict;
      expect(Boolean(e.auditOverrideReason)).toBe(flipped);
    }
  });
});

describe("results-ledger — invariants and provenance", () => {
  it("passes the cross-field + headline invariants in the validator", () => {
    expect(ledgerInvariantErrors(committed)).toEqual([]);
  });

  it("never embeds an absolute or machine-local artifact path", () => {
    for (const e of committed) {
      if (e.artifactPath) {
        expect(e.artifactPath).not.toMatch(/^\/|^[A-Za-z]:[\\/]|file:\/\//);
      }
    }
  });

  it("the builder reproduces the committed ledger byte-for-byte (deterministic, in sync)", () => {
    expect(buildLedger()).toEqual(committed);
  });
});
