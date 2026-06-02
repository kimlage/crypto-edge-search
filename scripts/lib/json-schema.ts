/**
 * json-schema.ts — the lab's lightweight JSON Schema (draft 2020-12) validator core.
 *
 * NO new dependencies — this hand-rolls exactly the subset of JSON Schema the lab's
 * schemas use: type, required, enum, const, properties, additionalProperties (false
 * or a sub-schema), items, minItems, minLength, minimum/maximum, exclusiveMinimum/
 * exclusiveMaximum, and $ref to a sibling schema file. Both `scripts/validate-schemas.ts`
 * (schema↔example pairs) and `scripts/validate-results-ledger.ts` (the canonical ledger)
 * import this single, tested core so there is one validator, not two.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Schema = { [k: string]: Json };

/**
 * Load (and cache) sibling schema files referenced via `$ref`. `schemaDir` is the
 * directory `$ref` paths are resolved against.
 */
export function makeSchemaLoader(schemaDir: string): (file: string) => Schema {
  const cache = new Map<string, Schema>();
  return function loadSchema(file: string): Schema {
    const cached = cache.get(file);
    if (cached) return cached;
    const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as Schema;
    cache.set(file, schema);
    return schema;
  };
}

export function jsonType(value: Json): string {
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
 * `loadSchema` resolves `$ref` to sibling schema files.
 */
export function validate(
  value: Json,
  schema: Schema,
  path: string,
  errors: string[],
  loadSchema: (file: string) => Schema,
): void {
  if (typeof schema.$ref === "string") {
    validate(value, loadSchema(schema.$ref), path, errors, loadSchema);
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
      value.forEach((item, i) => validate(item, schema.items as Schema, `${path}[${i}]`, errors, loadSchema));
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
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object" &&
      !Array.isArray(schema.additionalProperties)
        ? (schema.additionalProperties as Schema)
        : null;

    for (const [key, child] of Object.entries(obj)) {
      if (key in props) {
        validate(child, props[key], `${path}.${key}`, errors, loadSchema);
      } else if (apSchema) {
        validate(child, apSchema, `${path}.${key}`, errors, loadSchema);
      }
    }
  }
}
