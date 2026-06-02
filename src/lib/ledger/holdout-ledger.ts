/**
 * Hold-out ledger (roadmap A6 / consume-once) — a PERSISTENT record of which
 * dataset slices have already been spent on a final out-of-sample verdict.
 *
 * `FinalHoldoutGuard` (src/lib/significance/holdout.ts) is an in-memory, per-call
 * guard: it forbids a second `consume()` *within one process*, but a fresh run
 * starts with a clean guard and could silently re-score the same vault — which
 * voids the verdict, because the slice is no longer out-of-sample once it has
 * informed any decision. This ledger closes that gap: it records each consumed
 * `{datasetHash,rowStart,rowEnd,strategyId,runId}` and `assertNotConsumed(slice)`
 * THROWS if that exact dataset slice was already consumed — across runs, via an
 * injected store that can be serialized to / from JSONL.
 *
 * A "slice" is identified by `datasetHash` plus the half-open row range
 * `[rowStart, rowEnd)`. Re-consuming the SAME slice throws regardless of which
 * `strategyId`/`runId` asks for it (re-using a vault for a second strategy is
 * exactly the leak we forbid). Determinism: no clock reads — any `consumedAt`
 * timestamp is supplied by the caller.
 */

export interface HoldoutSlice {
  /** Stable hash of the underlying dataset (content fingerprint). */
  datasetHash: string;
  /** Inclusive start row index of the consumed slice. */
  rowStart: number;
  /** Exclusive end row index of the consumed slice. */
  rowEnd: number;
}

export interface HoldoutConsumptionRecord extends HoldoutSlice {
  /** Strategy that consumed the slice. */
  strategyId: string;
  /** Run that consumed the slice. */
  runId: string;
  /** Caller-supplied timestamp; null when omitted. Never generated here. */
  consumedAt: string | null;
}

/**
 * Append-only store of hold-out consumptions. Preserves insertion order and
 * never mutates prior records. Default is in-memory; `JsonlHoldoutStore`
 * mirrors records as JSONL for cross-run persistence.
 */
export interface HoldoutStore {
  append(record: HoldoutConsumptionRecord): void;
  all(): readonly HoldoutConsumptionRecord[];
}

/** Default in-memory store: append-only array, no I/O. */
export class InMemoryHoldoutStore implements HoldoutStore {
  private readonly rows: HoldoutConsumptionRecord[] = [];

  append(record: HoldoutConsumptionRecord): void {
    this.rows.push(record);
  }

  all(): readonly HoldoutConsumptionRecord[] {
    return this.rows;
  }
}

/**
 * JSONL serializer store. Holds records in memory, renders one canonical JSON
 * object per line, and rehydrates from JSONL via `parse()`. No file I/O — the
 * caller owns reading/writing the string.
 */
export class JsonlHoldoutStore implements HoldoutStore {
  private readonly rows: HoldoutConsumptionRecord[] = [];

  append(record: HoldoutConsumptionRecord): void {
    this.rows.push(record);
  }

  all(): readonly HoldoutConsumptionRecord[] {
    return this.rows;
  }

  serialize(): string {
    return this.rows
      .map((row) =>
        JSON.stringify({
          datasetHash: row.datasetHash,
          rowStart: row.rowStart,
          rowEnd: row.rowEnd,
          strategyId: row.strategyId,
          runId: row.runId,
          consumedAt: row.consumedAt,
        }),
      )
      .join("\n");
  }

  static parse(text: string): JsonlHoldoutStore {
    const store = new JsonlHoldoutStore();
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as Partial<HoldoutConsumptionRecord>;
      store.append({
        datasetHash: String(parsed.datasetHash ?? ""),
        rowStart: toInt(parsed.rowStart),
        rowEnd: toInt(parsed.rowEnd),
        strategyId: String(parsed.strategyId ?? ""),
        runId: String(parsed.runId ?? ""),
        consumedAt: normalizeOptional(parsed.consumedAt),
      });
    }
    return store;
  }
}

export interface ConsumeHoldoutInput extends HoldoutSlice {
  strategyId: string;
  runId: string;
  /** Caller-supplied timestamp; stored verbatim, never generated here. */
  consumedAt?: string | null;
}

/**
 * Persistent consume-once guard for final hold-out slices. Backed by an injected
 * store so the consumed set survives across runs (serialize the store to JSONL,
 * reload it next run). A slice may be consumed exactly once; a second attempt
 * throws.
 */
export class HoldoutLedger {
  private readonly store: HoldoutStore;
  private readonly consumed = new Set<string>();

  constructor(store: HoldoutStore = new InMemoryHoldoutStore()) {
    this.store = store;
    for (const row of store.all()) {
      this.consumed.add(sliceKey(row));
    }
  }

  /** True when this exact dataset slice has already been consumed. */
  isConsumed(slice: HoldoutSlice): boolean {
    return this.consumed.has(sliceKey(slice));
  }

  /**
   * Throws if the slice was already consumed (in this run OR a previous one
   * loaded from the store). The error names the slice so the void is auditable.
   */
  assertNotConsumed(slice: HoldoutSlice): void {
    if (this.consumed.has(sliceKey(slice))) {
      throw new Error(
        `Hold-out slice already consumed: dataset ${slice.datasetHash} ` +
          `rows [${normalizeRowStart(slice.rowStart)}, ${normalizeRowEnd(slice.rowEnd)}); ` +
          `a final hold-out can only be spent once.`,
      );
    }
  }

  /**
   * Consume a slice. Asserts it is unconsumed, then appends the record and marks
   * it consumed. Throws on a repeat. Returns the stored record.
   */
  consume(input: ConsumeHoldoutInput): HoldoutConsumptionRecord {
    this.assertNotConsumed(input);
    const record: HoldoutConsumptionRecord = {
      datasetHash: input.datasetHash,
      rowStart: normalizeRowStart(input.rowStart),
      rowEnd: normalizeRowEnd(input.rowEnd),
      strategyId: input.strategyId,
      runId: input.runId,
      consumedAt: normalizeOptional(input.consumedAt),
    };
    this.store.append(record);
    this.consumed.add(sliceKey(record));
    return record;
  }

  /** Number of distinct slices consumed. */
  consumedCount(): number {
    return this.consumed.size;
  }

  /** Full append-only consumption history in insertion order. */
  records(): readonly HoldoutConsumptionRecord[] {
    return this.store.all();
  }
}

/** Identity of a slice: dataset fingerprint + half-open row range. */
function sliceKey(slice: HoldoutSlice): string {
  return `${slice.datasetHash}@${normalizeRowStart(slice.rowStart)}:${normalizeRowEnd(slice.rowEnd)}`;
}

function normalizeRowStart(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeRowEnd(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function toInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

function normalizeOptional(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
