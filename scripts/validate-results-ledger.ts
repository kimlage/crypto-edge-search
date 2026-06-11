/**
 * validate-results-ledger.ts — validate output/results-ledger.json against
 * schemas/results-ledger.schema.json (the CANONICAL AUDITED RESULTS LEDGER).
 *
 * Reuses the shared JSON Schema core (`scripts/lib/json-schema.ts`, the same validator
 * `scripts/validate-schemas.ts` runs) and adds the two cross-field invariants JSON
 * Schema 2020-12 alone cannot express:
 *   (a) auditOverrideReason is REQUIRED iff rawVerdict != auditedVerdict (and MUST be
 *       absent when they are equal — a reason without a flip is a provenance error);
 *   (b) the audited headline MUST be exactly 0 SURVIVE and 1 PROMISING
 *       {D8-C6-DATED}, everything else KILL/DEFERRED. (XS Donchian / D1-LS-DONCH was
 *       downgraded PROMISING -> KILL on 2026-06-09 as substantially survivorship.)
 * Plus a leak guard: no artifactPath may be an absolute or machine-local path.
 *
 * Exits non-zero on any failure.
 *
 * Run:
 *   tsx scripts/validate-results-ledger.ts
 *   # or: node_modules/.bin/tsx scripts/validate-results-ledger.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSchemaLoader, validate, type Json } from "./lib/json-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas");
const LEDGER_PATH = join(REPO_ROOT, "output", "results-ledger.json");

interface LedgerEntry {
  id: string;
  domain: string;
  name: string;
  rawVerdict: string;
  auditedVerdict: string;
  auditOverrideReason?: string;
  artifactPath?: string;
}

/** Cross-field + headline invariants beyond what JSON Schema can encode. */
export function ledgerInvariantErrors(entries: LedgerEntry[]): string[] {
  const errors: string[] = [];

  for (const e of entries) {
    const flipped = e.rawVerdict !== e.auditedVerdict;
    const hasReason = typeof e.auditOverrideReason === "string" && e.auditOverrideReason.length > 0;
    if (flipped && !hasReason) {
      errors.push(`${e.id}: flip ${e.rawVerdict} -> ${e.auditedVerdict} requires auditOverrideReason`);
    }
    if (!flipped && hasReason) {
      errors.push(`${e.id}: auditOverrideReason present but rawVerdict == auditedVerdict (${e.rawVerdict})`);
    }
    if (typeof e.artifactPath === "string" && (e.artifactPath.startsWith("/") || /^[A-Za-z]:[\\/]|file:\/\/|\.\.\//.test(e.artifactPath))) {
      errors.push(`${e.id}: artifactPath looks absolute/machine-local: ${e.artifactPath}`);
    }
  }

  const survive = entries.filter((e) => e.auditedVerdict === "SURVIVE");
  const promising = entries.filter((e) => e.auditedVerdict === "PROMISING").map((e) => e.id).sort();
  if (survive.length !== 0) errors.push(`headline: expected 0 SURVIVE, got ${survive.length}`);
  const expectedPromising = ["D8-C6-DATED"];
  if (JSON.stringify(promising) !== JSON.stringify(expectedPromising)) {
    errors.push(`headline: expected PROMISING ${JSON.stringify(expectedPromising)}, got ${JSON.stringify(promising)}`);
  }

  return errors;
}

function run(): number {
  const loadSchema = makeSchemaLoader(SCHEMA_DIR);
  const schema = loadSchema("results-ledger.schema.json");
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Json;

  const schemaErrors: string[] = [];
  validate(ledger, schema, "$", schemaErrors, loadSchema);

  const entries = Array.isArray(ledger) ? (ledger as unknown as LedgerEntry[]) : [];
  const invariantErrors = schemaErrors.length === 0 ? ledgerInvariantErrors(entries) : [];

  const allErrors = [...schemaErrors, ...invariantErrors];
  if (allErrors.length === 0) {
    const counts = entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.auditedVerdict] = (acc[e.auditedVerdict] ?? 0) + 1;
      return acc;
    }, {});
    const promising = entries.filter((e) => e.auditedVerdict === "PROMISING").map((e) => e.id);
    console.log(`results-ledger.json: PASS — ${entries.length} entries validate against the schema and invariants.`);
    console.log(
      `Audited headline: ${counts.SURVIVE ?? 0} SURVIVE, ${counts.PROMISING ?? 0} PROMISING ` +
        `(${promising.join(", ")}), ${counts.KILL ?? 0} KILL, ${counts.DEFERRED ?? 0} DEFERRED.`,
    );
    return 0;
  }

  console.log("results-ledger.json: FAIL");
  for (const e of allErrors) console.log(`    - ${e}`);
  return 1;
}

// Run when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}

export { run };
