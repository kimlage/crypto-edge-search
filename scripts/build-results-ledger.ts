/**
 * build-results-ledger.ts — FRONT: canonical audited results ledger
 *
 * Emits `output/results-ledger.json`, the CANONICAL machine-readable verdict
 * source for the whole program (see `docs/CANONICAL_STATE.md`).
 *
 * Pipeline:
 *   1. RAW layer — reuse the committed dashboard parser (`scripts/build-dashboard.ts`:
 *      `collectRows`) to read every per-domain `output/edgehunt-*\/SUMMARY.md` verdict
 *      table and recover each hypothesis's RAW per-domain verdict. The dashboard parser
 *      is the single, tested source of markdown-table parsing — we do not re-implement it.
 *   2. AUDIT layer — apply the CANONICAL AUDITED FINAL STATE: set `auditedVerdict`
 *      (= scientificVerdict) on every entry, attach honest-N / surrogate-p / monthly /
 *      binding-gate metadata, and FLIP the four audit-corrected leads (D5-08 reserve,
 *      Q9 low-vol, O3 fee-NVT, VRP) to KILL with an `auditOverrideReason` taken from the
 *      two-layer audit (`output/edgehunt-audit/SUMMARY.md`,
 *      `output/edgehunt-audit-nb/SUMMARY.md`, `output/edgehunt-deepen/SUMMARY.md`).
 *   3. The audited headline MUST be exactly 0 SURVIVE, 2 PROMISING (XS Donchian +
 *      dated-futures-unlevered-thin), rest KILL/DEFERRED — asserted before write.
 *
 * The raw rate-limited "N further slots" filler rows carry NO verdict and are excluded
 * (they are not hypotheses). Deterministic: stable sort by (domain, id), no timestamps,
 * only repo-relative paths.
 *
 * Run:
 *   tsx scripts/build-results-ledger.ts
 *   # or: node_modules/.bin/tsx scripts/build-results-ledger.ts
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectRows, type Row } from "./build-dashboard";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const LEDGER_PATH = join(REPO_ROOT, "output", "results-ledger.json");

const AUDIT_DATE = "2026-06-01";

type Verdict = "SURVIVE" | "PROMISING" | "KILL" | "DEFERRED" | "INDETERMINATE";

export interface LedgerEntry {
  id: string;
  domain: string;
  name: string;
  claimType?: string;
  rawVerdict: Verdict;
  auditedVerdict: Verdict;
  bindingGate?: string | null;
  honestN?: number | null;
  surrogateP?: number | null;
  monthlyAt100k?: number | null;
  lastAudit: string;
  auditOverrideReason?: string;
  artifactPath?: string;
}

/**
 * The canonical audited overlay, keyed by a stable identity. Anything not in the
 * overlay inherits its raw verdict as its audited verdict (the audit found NO
 * false-KILL anywhere, so every raw KILL/DEFERRED stays as-is). The overlay only
 * needs to: (a) carry the four FLIPS to KILL with their override reasons, (b) hold
 * the two confirmed PROMISING survivors, and (c) attach machine-readable metadata
 * to the leads the audit actually re-derived. claimType/metadata for the plain
 * KILLs is enriched opportunistically from the raw detail where unambiguous.
 */
interface Override {
  claimType?: string;
  auditedVerdict?: Verdict;
  bindingGate?: string | null;
  honestN?: number | null;
  surrogateP?: number | null;
  monthlyAt100k?: number | null;
  auditOverrideReason?: string;
  artifactPath?: string;
}

/** Stable synthetic id for the two id-less consensus carries. */
function stableId(row: Row): string {
  if (row.domain === "consensus") {
    if (/dated-futures/i.test(row.name)) return "D8-C6-DATED";
    if (/VRP/i.test(row.name)) return "VRP-HARVEST";
  }
  return row.id;
}

/** Identity for an overlay match: keyed by the entry's stable id. */
function overlayFor(row: Row): Override | undefined {
  return OVERRIDES[stableId(row)];
}

const OVERRIDES: Record<string, Override> = {
  // ---- The 2 CONFIRMED PROMISING survivors ----
  "D1-LS-DONCH": {
    claimType: "cross-sectional",
    auditedVerdict: "PROMISING",
    bindingGate: "deflated_sharpe",
    honestN: 72,
    surrogateP: 0.009,
    monthlyAt100k: 4116,
    artifactPath: "output/edgehunt-requeue/SUMMARY.md",
  },
  "D8-C6-DATED": {
    claimType: "carry",
    auditedVerdict: "PROMISING",
    bindingGate: "deflated_sharpe",
    honestN: 16,
    surrogateP: 0.001,
    monthlyAt100k: 475,
    artifactPath: "output/edgehunt-deepen/SUMMARY.md",
  },

  // ---- The 4 FLIPS: raw PROMISING -> audited KILL ----
  "D5-08": {
    claimType: "on-chain",
    auditedVerdict: "KILL",
    bindingGate: "surrogate",
    honestN: 54,
    surrogateP: 0.24,
    monthlyAt100k: null,
    auditOverrideReason:
      "Harness surrogate p=0.013 was a single-best-config p over a searched grid; under the family-wise MAX-statistic null the surrogate gate FAILS (p~=0.24, real-best 0.994 < surr95 1.19) and it fails honest-N DSR at the full grid (audited-kill: family-wise surrogate).",
    artifactPath: "output/edgehunt-audit/SUMMARY.md",
  },
  "Q9-LOWVOL": {
    claimType: "cross-sectional",
    auditedVerdict: "KILL",
    bindingGate: "deflated_sharpe",
    honestN: 96,
    surrogateP: 0.06,
    monthlyAt100k: null,
    auditOverrideReason:
      "Single-best-config surrogate p=0.002 masked a searched 96-config grid; family-wise MAX-stat p~=0.06 (seed-sensitive) and it fails honest-N DSR 0.476 @N=96 + Harvey-Liu adjP 0.673 (audited-kill: family-wise surrogate).",
    artifactPath: "output/edgehunt-audit-nb/SUMMARY.md",
  },
  "O3-NVTS": {
    claimType: "on-chain",
    auditedVerdict: "KILL",
    bindingGate: "deflated_sharpe",
    honestN: 312,
    surrogateP: 0.093,
    monthlyAt100k: null,
    auditOverrideReason:
      "Harness surrogate p=0.005 phase-randomized only the one winning signal; family-wise MAX-stat over the actually-searched N=312 grid gives p=0.093 (real-best 1.332 < surr95-max 1.384) and DSR @N=312 = 0.894 fails — the N=54 carve-out was a post-hoc argmax (audited-kill: family-wise surrogate).",
    artifactPath: "output/edgehunt-audit-nb/SUMMARY.md",
  },
  "VRP-HARVEST": {
    claimType: "volatility-premium",
    auditedVerdict: "KILL",
    bindingGate: "deflated_sharpe",
    honestN: 90,
    surrogateP: 0.14,
    monthlyAt100k: null,
    auditOverrideReason:
      "A 2021 DVOL-onset regime artifact: leave-2021-out Sharpe 1.257 -> 0.560, post-2021 DSR@N=1 only 0.842; the favorable consume-once holdout was lucky split-placement on the 2nd-richest year. Already fails DSR 0.389 @N=90 + PBO 0.50 (audited-kill: 2021 regime artifact).",
    artifactPath: "output/edgehunt-deepen/SUMMARY.md",
  },
};

/** Map the dashboard's normalized bucket onto a schema verdict enum value. */
function rawVerdictOf(row: Row): Verdict | null {
  switch (row.verdict) {
    case "SURVIVE":
    case "PROMISING":
    case "KILL":
    case "DEFERRED":
      return row.verdict;
    case "NO VERDICT":
    default:
      // Rate-limited "N further slots" filler rows carry NO verdict and are not
      // hypotheses — exclude them entirely from the canonical ledger.
      return null;
  }
}

export function buildLedger(): LedgerEntry[] {
  const rows = collectRows();
  const entries: LedgerEntry[] = [];

  for (const row of rows) {
    const rawVerdict = rawVerdictOf(row);
    if (rawVerdict === null) continue;

    const ov = overlayFor(row);
    const auditedVerdict = ov?.auditedVerdict ?? rawVerdict;

    const entry: LedgerEntry = {
      id: stableId(row),
      domain: row.domain,
      name: row.name,
      rawVerdict,
      auditedVerdict,
      lastAudit: AUDIT_DATE,
    };
    if (ov?.claimType !== undefined) entry.claimType = ov.claimType;
    if (ov?.bindingGate !== undefined) entry.bindingGate = ov.bindingGate;
    if (ov?.honestN !== undefined) entry.honestN = ov.honestN;
    if (ov?.surrogateP !== undefined) entry.surrogateP = ov.surrogateP;
    if (ov?.monthlyAt100k !== undefined) entry.monthlyAt100k = ov.monthlyAt100k;
    // auditOverrideReason is REQUIRED iff the audit flipped the label.
    if (rawVerdict !== auditedVerdict) {
      if (!ov?.auditOverrideReason) {
        throw new Error(`Flip ${entry.id} (${rawVerdict} -> ${auditedVerdict}) is missing an auditOverrideReason`);
      }
      entry.auditOverrideReason = ov.auditOverrideReason;
    }
    entry.artifactPath = ov?.artifactPath ?? row.source;

    entries.push(entry);
  }

  // Deterministic order: by domain then id.
  entries.sort((a, b) => (a.domain === b.domain ? a.id.localeCompare(b.id) : a.domain.localeCompare(b.domain)));
  return entries;
}

/** Count audited verdicts for the headline assertion / report. */
export function auditedHeadline(entries: LedgerEntry[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = {
    SURVIVE: 0,
    PROMISING: 0,
    KILL: 0,
    DEFERRED: 0,
    INDETERMINATE: 0,
  };
  for (const e of entries) counts[e.auditedVerdict]++;
  return counts;
}

function main(): void {
  const entries = buildLedger();
  const counts = auditedHeadline(entries);

  // Hard guard on the canonical headline: 0 SURVIVE, exactly 2 PROMISING.
  if (counts.SURVIVE !== 0) throw new Error(`Expected 0 SURVIVE, got ${counts.SURVIVE}`);
  if (counts.PROMISING !== 2) throw new Error(`Expected 2 PROMISING, got ${counts.PROMISING}`);
  const promising = entries.filter((e) => e.auditedVerdict === "PROMISING").map((e) => e.id);
  if (!promising.includes("D1-LS-DONCH") || !promising.includes("D8-C6-DATED")) {
    throw new Error(`Expected PROMISING = {D1-LS-DONCH, D8-C6-DATED}, got ${JSON.stringify(promising)}`);
  }

  writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2) + "\n", "utf8");

  console.log(`Wrote ${entries.length} entries -> output/results-ledger.json`);
  console.log(
    `Audited headline: ${counts.SURVIVE} SURVIVE, ${counts.PROMISING} PROMISING ` +
      `(${promising.join(", ")}), ${counts.KILL} KILL, ${counts.DEFERRED} DEFERRED` +
      (counts.INDETERMINATE ? `, ${counts.INDETERMINATE} INDETERMINATE` : ""),
  );
}

// Run when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
