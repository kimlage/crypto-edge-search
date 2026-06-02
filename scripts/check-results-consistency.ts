/**
 * check-results-consistency.ts — the single cross-artifact consistency gate.
 *
 * One script, three jobs, all of which must agree or CI fails:
 *
 *   1. STRUCTURE — load output/results-ledger.json and validate it against
 *      schemas/results-ledger.schema.json using the same hand-rolled JSON Schema
 *      core scripts/validate-schemas.ts and scripts/validate-results-ledger.ts use
 *      (no new deps). A malformed ledger fails here before anything else runs.
 *
 *   2. LEDGER HEADLINE — derive the audited headline counts straight from the
 *      ledger's auditedVerdict field and ASSERT they match the CANONICAL claim:
 *      exactly 0 SURVIVE and exactly 2 PROMISING {D1-LS-DONCH, D8-C6-DATED},
 *      everything else KILL/DEFERRED. This is the machine-readable source of truth.
 *
 *   3. DOC HEADLINE — the human-readable headline in README.md and docs/RESULTS.md
 *      MUST repeat the same numbers. We grep each doc for the SURVIVE=0 claim, the
 *      PROMISING=2 claim, and the ~111-hypotheses figure (each doc states the count
 *      in its own form: RESULTS.md as the literal "0 SURVIVE" / "2 PROMISING" line,
 *      README.md as a `| Clean **SURVIVE** | **0** |` table row). If a doc's stated
 *      number ever drifts from the ledger, this fails with an explicit diff.
 *
 * On ANY mismatch we print a clear, line-oriented diff and exit non-zero so the
 * ledger, the schema, and every quoted headline can never silently disagree.
 *
 * Run:
 *   tsx scripts/check-results-consistency.ts
 *   # or: node_modules/.bin/tsx scripts/check-results-consistency.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSchemaLoader, validate, type Json } from "./lib/json-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas");
const LEDGER_PATH = join(REPO_ROOT, "output", "results-ledger.json");
const README_PATH = join(REPO_ROOT, "README.md");
const RESULTS_PATH = join(REPO_ROOT, "docs", "RESULTS.md");

/** The CANONICAL AUDITED FINAL STATE — the single source of truth this check encodes. */
const EXPECTED_SURVIVE = 0;
const EXPECTED_PROMISING = 2;
const EXPECTED_PROMISING_IDS = ["D1-LS-DONCH", "D8-C6-DATED"];
const EXPECTED_HYPOTHESES_TOKEN = "~111";

interface LedgerEntry {
  id: string;
  auditedVerdict: string;
}

/** Audited headline counts, derived straight from the ledger. */
export interface Headline {
  survive: number;
  promising: number;
  promisingIds: string[];
  kill: number;
  deferred: number;
  total: number;
}

export function deriveHeadline(entries: LedgerEntry[]): Headline {
  const count = (v: string): number => entries.filter((e) => e.auditedVerdict === v).length;
  return {
    survive: count("SURVIVE"),
    promising: count("PROMISING"),
    promisingIds: entries.filter((e) => e.auditedVerdict === "PROMISING").map((e) => e.id).sort(),
    kill: count("KILL"),
    deferred: count("DEFERRED"),
    total: entries.length,
  };
}

/**
 * A single doc-headline check: does `text` state the canonical claim `label`?
 * `patterns` are accepted equivalents (literal phrase OR markdown-table form);
 * a doc passes if ANY pattern matches.
 */
interface DocClaim {
  label: string;
  patterns: RegExp[];
}

/** The claims each human-readable doc must repeat, in any of the accepted forms. */
function docClaims(): DocClaim[] {
  return [
    {
      // SURVIVE = 0: literal "0 SURVIVE" / "0 clean SURVIVE" OR a `| ...SURVIVE... | **0** |` row.
      label: `${EXPECTED_SURVIVE} SURVIVE`,
      patterns: [
        new RegExp(`\\b${EXPECTED_SURVIVE}\\b[^\\n]*\\bSURVIVE\\b`),
        new RegExp(`\\bSURVIVE\\b[^\\n]*\\*\\*${EXPECTED_SURVIVE}\\*\\*`),
      ],
    },
    {
      // PROMISING = 2: literal "2 PROMISING" / "2 weak PROMISING" OR a `| ...PROMISING... | **2** |` row.
      label: `${EXPECTED_PROMISING} PROMISING`,
      patterns: [
        new RegExp(`\\b${EXPECTED_PROMISING}\\b[^\\n]*\\bPROMISING\\b`),
        new RegExp(`\\bPROMISING\\b[^\\n]*\\*\\*${EXPECTED_PROMISING}\\*\\*`),
      ],
    },
    {
      // ~111 hypotheses tested (program-wide count).
      label: EXPECTED_HYPOTHESES_TOKEN,
      patterns: [new RegExp(EXPECTED_HYPOTHESES_TOKEN.replace("~", "\\~"))],
    },
  ];
}

function checkDoc(name: string, text: string): string[] {
  const errors: string[] = [];
  for (const claim of docClaims()) {
    if (!claim.patterns.some((p) => p.test(text))) {
      errors.push(`${name}: missing the canonical headline claim "${claim.label}"`);
    }
  }
  return errors;
}

export function run(): number {
  const errors: string[] = [];

  // 1. STRUCTURE — schema-validate the ledger with the shared validator core.
  const loadSchema = makeSchemaLoader(SCHEMA_DIR);
  const schema = loadSchema("results-ledger.schema.json");
  const ledgerJson = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Json;
  const schemaErrors: string[] = [];
  validate(ledgerJson, schema, "$", schemaErrors, loadSchema);
  for (const e of schemaErrors) errors.push(`schema: ${e}`);

  // Without a structurally valid array we cannot derive a headline; stop here.
  if (schemaErrors.length > 0) {
    return report(null, errors);
  }

  const entries = ledgerJson as unknown as LedgerEntry[];
  const headline = deriveHeadline(entries);

  // 2. LEDGER HEADLINE — assert the derived counts match the canonical claim.
  if (headline.survive !== EXPECTED_SURVIVE) {
    errors.push(`ledger: expected ${EXPECTED_SURVIVE} SURVIVE, got ${headline.survive}`);
  }
  if (headline.promising !== EXPECTED_PROMISING) {
    errors.push(`ledger: expected ${EXPECTED_PROMISING} PROMISING, got ${headline.promising}`);
  }
  if (JSON.stringify(headline.promisingIds) !== JSON.stringify(EXPECTED_PROMISING_IDS)) {
    errors.push(
      `ledger: expected PROMISING ids ${JSON.stringify(EXPECTED_PROMISING_IDS)}, ` +
        `got ${JSON.stringify(headline.promisingIds)}`,
    );
  }

  // 3. DOC HEADLINE — README.md and docs/RESULTS.md must repeat the same numbers.
  errors.push(...checkDoc("README.md", readFileSync(README_PATH, "utf8")));
  errors.push(...checkDoc("docs/RESULTS.md", readFileSync(RESULTS_PATH, "utf8")));

  return report(headline, errors);
}

function report(headline: Headline | null, errors: string[]): number {
  if (errors.length === 0 && headline) {
    console.log("check-results-consistency: PASS");
    console.log(
      `  ledger (${headline.total} entries): ${headline.survive} SURVIVE, ${headline.promising} PROMISING ` +
        `(${headline.promisingIds.join(", ")}), ${headline.kill} KILL, ${headline.deferred} DEFERRED`,
    );
    console.log(`  canonical claim: ${EXPECTED_SURVIVE} SURVIVE, ${EXPECTED_PROMISING} PROMISING, ${EXPECTED_HYPOTHESES_TOKEN} hypotheses`);
    console.log("  README.md and docs/RESULTS.md repeat the same headline.");
    return 0;
  }

  console.log("check-results-consistency: FAIL");
  console.log("");
  if (headline) {
    console.log("  Derived from output/results-ledger.json:");
    console.log(`    SURVIVE=${headline.survive}  PROMISING=${headline.promising}  KILL=${headline.kill}  DEFERRED=${headline.deferred}  TOTAL=${headline.total}`);
    console.log(`    PROMISING ids: ${JSON.stringify(headline.promisingIds)}`);
    console.log("  Canonical claim:");
    console.log(`    SURVIVE=${EXPECTED_SURVIVE}  PROMISING=${EXPECTED_PROMISING}  PROMISING ids=${JSON.stringify(EXPECTED_PROMISING_IDS)}  hypotheses=${EXPECTED_HYPOTHESES_TOKEN}`);
    console.log("");
  }
  console.log("  Mismatches:");
  for (const e of errors) console.log(`    - ${e}`);
  return 1;
}

// Run when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}
