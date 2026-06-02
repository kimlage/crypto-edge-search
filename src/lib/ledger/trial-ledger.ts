/**
 * Trial ledger (roadmap A0 / honest-N) — an append-only record of every config
 * the search ever tried, so the Deflated Sharpe Ratio and the haircut can read
 * the *true* trial count N from the ledger instead of a hand-passed number.
 *
 * The two failure modes this guards against:
 *   1. Under-counting N (passing 1, or a per-family bucket size) — which makes
 *      DSR/MinBTL deflate far too little and lets selection luck survive.
 *   2. Double-counting the same config across runs — which inflates N and makes
 *      a real edge look like noise. The ledger dedupes by a stable, order- and
 *      key-insensitive hash of the config object, so `honestN` is the count of
 *      DISTINCT configs regardless of how many times each was re-evaluated.
 *
 * Determinism: the hash is a pure function of the config's *values* (canonical
 * JSON, sorted keys), never of insertion order or object key order. A `timestamp`
 * is only ever stored when the CALLER passes one in — this module never reads the
 * clock, so the same sequence of records always yields byte-identical output.
 *
 * Storage is injected. The default is in-memory; an optional JSONL serializer is
 * provided for persisting `{ hash, label, runId, timestamp }` lines across runs.
 */

export interface TrialRecord {
  /** Stable hash of the config object (sorted-key canonical JSON). */
  hash: string;
  /** Human label for the config family / variant. Optional. */
  label: string | null;
  /** Id of the run that evaluated this config. Optional. */
  runId: string | null;
  /**
   * Caller-supplied timestamp (e.g. ISO-8601). NEVER generated inside the ledger
   * so the record sequence stays deterministic. Null when the caller omits it.
   */
  timestamp: string | null;
}

/**
 * Append-only store of trial records. Implementations must preserve insertion
 * order and never mutate prior records. The default `InMemoryTrialStore` keeps
 * rows in an array; `JsonlTrialStore` mirrors them as JSONL text.
 */
export interface TrialStore {
  /** Append one record (called once per recorded trial, including duplicates). */
  append(record: TrialRecord): void;
  /** All records in insertion order, including duplicate hashes. */
  all(): readonly TrialRecord[];
}

/** Default in-memory store: an append-only array, no I/O. */
export class InMemoryTrialStore implements TrialStore {
  private readonly rows: TrialRecord[] = [];

  append(record: TrialRecord): void {
    this.rows.push(record);
  }

  all(): readonly TrialRecord[] {
    return this.rows;
  }
}

/**
 * JSONL serializer store. Holds records in memory and exposes a `serialize()`
 * that renders one canonical JSON object per line (`{hash,label,runId,timestamp}`),
 * plus a static `parse()` to rehydrate a store from JSONL text. Pure: it does no
 * file I/O itself — the caller owns reading/writing the string.
 */
export class JsonlTrialStore implements TrialStore {
  private readonly rows: TrialRecord[] = [];

  append(record: TrialRecord): void {
    this.rows.push(record);
  }

  all(): readonly TrialRecord[] {
    return this.rows;
  }

  /** One JSON object per line, fields in a fixed order for stable diffs. */
  serialize(): string {
    return this.rows
      .map((row) =>
        JSON.stringify({
          hash: row.hash,
          label: row.label,
          runId: row.runId,
          timestamp: row.timestamp,
        }),
      )
      .join("\n");
  }

  /** Rebuild a store from JSONL text. Blank lines are skipped. */
  static parse(text: string): JsonlTrialStore {
    const store = new JsonlTrialStore();
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as Partial<TrialRecord>;
      store.append({
        hash: String(parsed.hash ?? ""),
        label: normalizeOptional(parsed.label),
        runId: normalizeOptional(parsed.runId),
        timestamp: normalizeOptional(parsed.timestamp),
      });
    }
    return store;
  }
}

export interface RecordTrialInput {
  /** The config object actually tried. Hashed by value, key-order-insensitive. */
  config: unknown;
  label?: string | null;
  runId?: string | null;
  /** Caller-supplied timestamp; stored verbatim, never generated here. */
  timestamp?: string | null;
}

export interface RecordTrialResult {
  /** The stable hash assigned to this config. */
  hash: string;
  /** True when this hash had never been recorded before (a new distinct config). */
  isNew: boolean;
}

/**
 * Append-only ledger of every config tried. `record()` always appends (so the
 * full audit trail, including re-evaluations, is preserved), and reports whether
 * the config was new. `honestN()` is the count of DISTINCT config hashes — the N
 * the DSR/haircut must deflate by.
 */
export class TrialLedger {
  private readonly store: TrialStore;
  private readonly distinct = new Set<string>();

  constructor(store: TrialStore = new InMemoryTrialStore()) {
    this.store = store;
    // Rehydrate distinct set from any pre-existing records (e.g. parsed JSONL).
    for (const row of store.all()) {
      if (row.hash.length > 0) this.distinct.add(row.hash);
    }
  }

  /** Record a tried config. Always appends; dedupe happens only in `honestN`. */
  record(input: RecordTrialInput): RecordTrialResult {
    const hash = stableConfigHash(input.config);
    const isNew = !this.distinct.has(hash);
    this.distinct.add(hash);
    this.store.append({
      hash,
      label: normalizeOptional(input.label),
      runId: normalizeOptional(input.runId),
      timestamp: normalizeOptional(input.timestamp),
    });
    return { hash, isNew };
  }

  /** Number of DISTINCT configs tried — the honest N for DSR/haircut. */
  honestN(): number {
    return this.distinct.size;
  }

  /** Total appended records, including re-evaluations of the same config. */
  totalRecords(): number {
    return this.store.all().length;
  }

  /** The sorted set of distinct config hashes (deterministic order). */
  distinctHashes(): string[] {
    return [...this.distinct].sort();
  }

  /** Full append-only record list in insertion order. */
  records(): readonly TrialRecord[] {
    return this.store.all();
  }
}

/**
 * Deterministic, key-order-insensitive hash of a config value. Renders the value
 * as canonical JSON (object keys sorted recursively) and hashes the bytes with a
 * 64-bit FNV-1a folded into a fixed-width hex string. Pure: same value ⇒ same
 * hash, on any machine, regardless of object key insertion order.
 */
export function stableConfigHash(value: unknown): string {
  return fnv1a64Hex(canonicalize(value));
}

/** Canonical JSON: objects rendered with sorted keys, recursively. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined" || typeof value === "function") return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
      .join(",");
    return `{${body}}`;
  }
  // bigint / symbol — fall back to a stable string form.
  return JSON.stringify(String(value));
}

/**
 * 64-bit FNV-1a over the UTF-16 code units of `text`, returned as 16 lowercase
 * hex chars. Hand-rolled with BigInt so there are no dependencies and no 32-bit
 * collision-prone shortcuts.
 */
function fnv1a64Hex(text: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeOptional(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
