/**
 * Experiment registry — an append-only record of every gauntlet run, so the
 * provenance of each strategy verdict (which git SHA, which dataset, how many
 * configs, what the binding gate was) survives across runs and can be queried.
 *
 * This is the run-level companion to the trial ledger: where the trial ledger
 * counts the DISTINCT configs a search ever tried (the honest N), the experiment
 * registry records the OUTCOME of each gauntlet run as one structured entry. It
 * never collapses entries on the way in — two runs that happen to share a runId
 * are BOTH kept (append-only audit trail). De-duplication is opt-in at read time
 * via `find({ dedupeByRunId: true })`, which keeps the latest entry per runId.
 *
 * Determinism: `createdAt` is ALWAYS passed in by the caller (e.g. ISO-8601);
 * this module never reads the clock, so the same sequence of records always
 * yields byte-identical output. There is no I/O in the pure path — storage is
 * injected. The default is in-memory; an optional JSONL serializer is provided
 * for persisting entries across runs.
 */

/** A scientific/decision verdict for a gauntlet run. Free-form but conventional. */
export type RegistryVerdict = string;

/**
 * One recorded gauntlet run. `runId`, `strategyId`, `configCount`, `verdict` and
 * `createdAt` are required; everything else is optional provenance. Fields are
 * stored verbatim — the registry does not interpret them.
 */
export interface ExperimentEntry {
  /** Id of the gauntlet run that produced this entry. Not unique (append-only). */
  runId: string;
  /** Git commit the run was executed at, if known. */
  gitSha?: string;
  /** Stable hash of the dataset the run consumed, if known. */
  datasetHash?: string;
  /** Id of the strategy under test. */
  strategyId: string;
  /** Strategy family / bucket the strategy belongs to, if known. */
  family?: string;
  /** Number of configs the run evaluated (e.g. the gauntlet grid size). */
  configCount: number;
  /** The headline verdict of the run (e.g. "PASS" / "KILL" / "CARRY"). */
  verdict: RegistryVerdict;
  /** A separate scientific verdict, when the run distinguishes the two. */
  scientificVerdict?: RegistryVerdict;
  /** The gate that bound the decision (e.g. "DSR" / "PBO" / "holdout"). */
  bindingGate?: string;
  /**
   * Caller-supplied creation timestamp (e.g. ISO-8601). NEVER generated inside
   * the registry so the record sequence stays deterministic.
   */
  createdAt: string;
}

/**
 * Append-only store of experiment entries. Implementations must preserve
 * insertion order and never mutate prior entries. The default
 * `InMemoryExperimentStore` keeps rows in an array; `JsonlExperimentStore`
 * mirrors them as JSONL text.
 */
export interface ExperimentStore {
  /** Append one entry (called once per recorded run, including same-runId runs). */
  append(entry: ExperimentEntry): void;
  /** All entries in insertion order, including duplicate runIds. */
  all(): readonly ExperimentEntry[];
}

/** Default in-memory store: an append-only array, no I/O. */
export class InMemoryExperimentStore implements ExperimentStore {
  private readonly rows: ExperimentEntry[] = [];

  append(entry: ExperimentEntry): void {
    this.rows.push(entry);
  }

  all(): readonly ExperimentEntry[] {
    return this.rows;
  }
}

/** Fixed field order for stable JSONL diffs. */
const ENTRY_FIELDS = [
  "runId",
  "gitSha",
  "datasetHash",
  "strategyId",
  "family",
  "configCount",
  "verdict",
  "scientificVerdict",
  "bindingGate",
  "createdAt",
] as const;

/**
 * JSONL serializer store. Holds entries in memory and exposes a `serialize()`
 * that renders one canonical JSON object per line (fields in a fixed order,
 * optional/undefined fields omitted), plus a static `parse()` to rehydrate a
 * store from JSONL text. Pure: it does no file I/O itself — the caller owns
 * reading/writing the string.
 */
export class JsonlExperimentStore implements ExperimentStore {
  private readonly rows: ExperimentEntry[] = [];

  append(entry: ExperimentEntry): void {
    this.rows.push(entry);
  }

  all(): readonly ExperimentEntry[] {
    return this.rows;
  }

  /** One JSON object per line, fields in a fixed order for stable diffs. */
  serialize(): string {
    return this.rows.map((row) => serializeEntry(row)).join("\n");
  }

  /** Rebuild a store from JSONL text. Blank lines are skipped. */
  static parse(text: string): JsonlExperimentStore {
    const store = new JsonlExperimentStore();
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      store.append(normalizeEntry(parsed));
    }
    return store;
  }
}

/** Input to `record()` — same shape as a stored entry. */
export type RecordExperimentInput = ExperimentEntry;

/**
 * Predicate-or-spec accepted by `find()`. A spec narrows by `strategyId` and/or
 * `verdict` (exact match) and/or `since` (entries with `createdAt >= since`,
 * compared as strings — ISO-8601 sorts lexicographically). `dedupeByRunId`, when
 * true, keeps only the LAST matching entry per runId (the append-only trail is
 * still fully preserved in the store).
 */
export interface ExperimentQuery {
  strategyId?: string;
  verdict?: RegistryVerdict;
  since?: string;
  dedupeByRunId?: boolean;
}

/** A predicate over entries, an alternative to the spec form of `find()`. */
export type ExperimentPredicate = (entry: ExperimentEntry) => boolean;

/**
 * Append-only registry of gauntlet runs. `record()` always appends (so the full
 * audit trail, including re-runs that reuse a runId, is preserved). Reads never
 * mutate. `find()` accepts either a predicate or a spec; only the spec form can
 * dedupe by runId. Pure: no clock, no I/O on the in-memory path.
 */
export class ExperimentRegistry {
  private readonly store: ExperimentStore;

  constructor(store: ExperimentStore = new InMemoryExperimentStore()) {
    this.store = store;
  }

  /** Record a gauntlet run. Always appends; never dedupes on write. */
  record(entry: RecordExperimentInput): ExperimentEntry {
    const normalized = normalizeEntry(entry as unknown as Record<string, unknown>);
    this.store.append(normalized);
    return normalized;
  }

  /** All entries in insertion order, including duplicate runIds. */
  all(): readonly ExperimentEntry[] {
    return this.store.all();
  }

  /**
   * Find entries by predicate or spec. With a spec, narrows by strategyId /
   * verdict / since and (optionally) dedupes by runId keeping the latest entry.
   * With a predicate, returns every matching entry in insertion order.
   */
  find(query: ExperimentPredicate | ExperimentQuery): ExperimentEntry[] {
    if (typeof query === "function") {
      return this.store.all().filter((entry) => query(entry));
    }
    const matched = this.store.all().filter((entry) => matchesSpec(entry, query));
    return query.dedupeByRunId ? dedupeByRunId(matched) : [...matched];
  }

  /**
   * The most recent entry for a strategy, by `createdAt` (string/ISO-8601
   * comparison), breaking ties toward the LATER insertion. Null when none match.
   */
  latestFor(strategyId: string): ExperimentEntry | null {
    let latest: ExperimentEntry | null = null;
    for (const entry of this.store.all()) {
      if (entry.strategyId !== strategyId) continue;
      // `>=` so a later insertion with an equal timestamp wins the tie.
      if (latest === null || entry.createdAt >= latest.createdAt) {
        latest = entry;
      }
    }
    return latest;
  }
}

function matchesSpec(entry: ExperimentEntry, spec: ExperimentQuery): boolean {
  if (spec.strategyId !== undefined && entry.strategyId !== spec.strategyId) {
    return false;
  }
  if (spec.verdict !== undefined && entry.verdict !== spec.verdict) {
    return false;
  }
  if (spec.since !== undefined && entry.createdAt < spec.since) {
    return false;
  }
  return true;
}

/** Keep the last entry per runId, preserving first-seen ordering of runIds. */
function dedupeByRunId(entries: readonly ExperimentEntry[]): ExperimentEntry[] {
  const order: string[] = [];
  const byRunId = new Map<string, ExperimentEntry>();
  for (const entry of entries) {
    if (!byRunId.has(entry.runId)) order.push(entry.runId);
    byRunId.set(entry.runId, entry);
  }
  return order.map((runId) => byRunId.get(runId) as ExperimentEntry);
}

/** Render one entry as canonical JSON with optional fields omitted when absent. */
function serializeEntry(entry: ExperimentEntry): string {
  const out: Record<string, unknown> = {};
  for (const field of ENTRY_FIELDS) {
    const value = entry[field];
    if (value !== undefined) out[field] = value;
  }
  return JSON.stringify(out);
}

/**
 * Coerce a loosely-typed record into a well-formed `ExperimentEntry`. Required
 * string fields default to "", `configCount` to a finite integer (0 otherwise),
 * and optional fields are dropped when absent/empty rather than stored as null —
 * keeping serialized lines minimal and round-trip stable.
 */
function normalizeEntry(raw: Record<string, unknown>): ExperimentEntry {
  const entry: ExperimentEntry = {
    runId: requireString(raw.runId),
    strategyId: requireString(raw.strategyId),
    configCount: toFiniteInteger(raw.configCount),
    verdict: requireString(raw.verdict),
    createdAt: requireString(raw.createdAt),
  };
  assignOptional(entry, "gitSha", raw.gitSha);
  assignOptional(entry, "datasetHash", raw.datasetHash);
  assignOptional(entry, "family", raw.family);
  assignOptional(entry, "scientificVerdict", raw.scientificVerdict);
  assignOptional(entry, "bindingGate", raw.bindingGate);
  return entry;
}

function assignOptional(
  entry: ExperimentEntry,
  key: "gitSha" | "datasetHash" | "family" | "scientificVerdict" | "bindingGate",
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    entry[key] = value;
  }
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toFiniteInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}
