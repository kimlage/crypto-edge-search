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

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "..", "schemas");
const EXAMPLE_DIR = join(SCHEMA_DIR, "examples");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };

const schemaCache = new Map<string, Schema>();

function loadSchema(file: string): Schema {
  const cached = schemaCache.get(file);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Schema;
  schemaCache.set(file, schema);
  return schema;
}

function jsonType(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value as number) && typeof value === "number") return "integer";
  return typeof value;
}

/** A JSON value matches a schema "type" (string or array of strings). */
function typeMatches(value: Json, type: Json): boolean {
  const allowed = Array.isArray(type) ? (type as string[]) : [type as string];
  const t = jsonType(value);
  return allowed.some((a) => a === t || (a === "number" && t === "integer"));
}

/**
 * Validate `value` against `schema`, pushing dotted-path error messages into `errors`.
 * Returns nothing; the caller inspects `errors`.
 */
function validate(value: Json, schema: Schema, path: string, errors: string[]): void {
  if (typeof schema.$ref === "string") {
    validate(value, loadSchema(schema.$ref), path, errors);
    return;
  }

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${jsonType(value)}`);
    return; // type is the foundation — later checks would be noise
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum)) {
    const ok = (schema.enum as Json[]).some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!ok) errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
  }

  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${path}: array length ${value.length} < minItems ${schema.minItems}`);
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((item, i) => validate(item, schema.items as Schema, `${path}[${i}]`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as { [k: string]: Json };
    const props = (schema.properties as { [k: string]: Schema } | undefined) ?? {};

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}" (additionalProperties:false)`);
      }
    }

    const apSchema =
      schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)
        ? (schema.additionalProperties as Schema)
        : null;

    for (const [key, child] of Object.entries(obj)) {
      if (key in props) {
        validate(child, props[key], `${path}.${key}`, errors);
      } else if (apSchema) {
        validate(child, apSchema, `${path}.${key}`, errors);
      }
    }
  }
}

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
    validate(example, loadSchema(schemaFile), "$", errors);
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
