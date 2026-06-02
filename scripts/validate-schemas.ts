/**
 * Lightweight structural validator for the JSON Schemas in schemas/ (FRONT: schemas).
 *
 * NO new dependencies — this hand-rolls a small subset of JSON Schema draft 2020-12
 * (type, required, enum, const, properties, additionalProperties:false, items, $ref to
 * sibling schema files, minItems, minLength, minimum/maximum, exclusiveMinimum,
 * exclusiveMaximum) — exactly the keywords the lab's schemas use. It validates each
 * example in schemas/examples/ against its schema, prints a table, and exits non-zero
 * on any failure.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/validate-schemas.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSchemaLoader, validate, type Json } from "./lib/json-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "..", "schemas");
const EXAMPLE_DIR = join(SCHEMA_DIR, "examples");

const loadSchema = makeSchemaLoader(SCHEMA_DIR);

interface Row {
  schema: string;
  example: string;
  ok: boolean;
  errors: string[];
}

function run(): number {
  // Pair each *.schema.json with examples/<base>.example.json.
  const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort();
  const exampleFiles = new Set(readdirSync(EXAMPLE_DIR).filter((f) => f.endsWith(".example.json")));
  const rows: Row[] = [];

  for (const schemaFile of schemaFiles) {
    const base = schemaFile.replace(/\.schema\.json$/, "");
    const exampleFile = `${base}.example.json`;
    if (!exampleFiles.has(exampleFile)) {
      rows.push({ schema: schemaFile, example: "(none)", ok: false, errors: [`missing example ${exampleFile}`] });
      continue;
    }
    const example = JSON.parse(readFileSync(join(EXAMPLE_DIR, exampleFile), "utf8")) as Json;
    const errors: string[] = [];
    validate(example, loadSchema(schemaFile), "$", errors, loadSchema);
    rows.push({ schema: schemaFile, example: exampleFile, ok: errors.length === 0, errors });
  }

  // Pretty table.
  const wSchema = Math.max(6, ...rows.map((r) => r.schema.length));
  const wExample = Math.max(7, ...rows.map((r) => r.example.length));
  const head = `${"SCHEMA".padEnd(wSchema)}  ${"EXAMPLE".padEnd(wExample)}  RESULT`;
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of rows) {
    console.log(`${r.schema.padEnd(wSchema)}  ${r.example.padEnd(wExample)}  ${r.ok ? "PASS" : "FAIL"}`);
    if (!r.ok) for (const e of r.errors) console.log(`    - ${e}`);
  }

  const failed = rows.filter((r) => !r.ok).length;
  console.log("-".repeat(head.length));
  console.log(`${rows.length} schema(s) checked, ${rows.length - failed} passed, ${failed} failed.`);
  return failed === 0 ? 0 : 1;
}

process.exit(run());
