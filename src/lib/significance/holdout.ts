/**
 * Final hold-out vault (roadmap A6) — López de Prado (2018); MinBTL.
 *
 * The search sees train + validation2 (selection) and may audit `test`, but a
 * truly out-of-sample verdict needs a final slice that the search NEVER touches
 * and that is consumed exactly once. This module defines that convention and a
 * consume-once guard, plus a leakage check that the search window never overlaps
 * the vault. Pure and deterministic — no I/O.
 *
 * Time order (oldest → newest):
 *   [ search: train + validation2 ] [ test (posterior audit) ] [ final hold-out ]
 * The hold-out is the most-recent contiguous block so the verdict is the hardest,
 * most-forward-looking sample.
 */

export interface HoldoutPlanInput {
  /** Total number of ordered rows/candles available. */
  totalRows: number;
  /** Fraction reserved as the untouched final vault (most recent). Default 0.15. */
  holdoutFraction?: number;
  /** Fraction reserved as the posterior `test` audit, before the vault. Default 0.15. */
  testFraction?: number;
}

export interface HoldoutPlan {
  totalRows: number;
  /** [start, end) row indexes the search may use (train + validation2). */
  search: { start: number; end: number; rows: number };
  /** [start, end) posterior audit slice. */
  test: { start: number; end: number; rows: number };
  /** [start, end) final hold-out vault — never touched by the search. */
  finalHoldout: { start: number; end: number; rows: number };
}

/**
 * Carve the ordered series into search / test / final-hold-out blocks. The vault is
 * the most-recent `holdoutFraction`; `test` is the block just before it; the search
 * owns everything older. Boundaries are disjoint and contiguous.
 */
export function planHoldoutSplit(input: HoldoutPlanInput): HoldoutPlan {
  const totalRows = Math.max(0, Math.floor(input.totalRows));
  const holdoutFraction = clamp01(input.holdoutFraction ?? 0.15);
  const testFraction = clamp01(input.testFraction ?? 0.15);

  const holdoutRows = Math.min(totalRows, Math.floor(totalRows * holdoutFraction));
  const testRows = Math.min(totalRows - holdoutRows, Math.floor(totalRows * testFraction));
  const searchRows = Math.max(0, totalRows - holdoutRows - testRows);

  const searchEnd = searchRows;
  const testEnd = searchEnd + testRows;
  const holdoutEnd = testEnd + holdoutRows;

  return {
    totalRows,
    search: { start: 0, end: searchEnd, rows: searchRows },
    test: { start: searchEnd, end: testEnd, rows: testRows },
    finalHoldout: { start: testEnd, end: holdoutEnd, rows: holdoutRows },
  };
}

/**
 * Throws if a search window (any index the GA/selection reads) reaches into the
 * final hold-out. Use as an anti-leakage assertion wherever the search picks rows.
 */
export function assertSearchDoesNotTouchHoldout(args: {
  searchMaxIndexExclusive: number;
  holdoutStartIndex: number;
}): void {
  if (args.searchMaxIndexExclusive > args.holdoutStartIndex) {
    throw new Error(
      `Search window reaches row ${args.searchMaxIndexExclusive} but the final hold-out starts at ` +
        `${args.holdoutStartIndex}; the vault must never be visible to the search.`,
    );
  }
}

export interface HoldoutConsumption {
  consumed: boolean;
  reason: string | null;
  consumedAtIso: string | null;
  gitSha: string | null;
  trialCount: number | null;
}

/**
 * Consume-once guard for the final hold-out. The vault may be evaluated exactly once,
 * recording the reason, the git SHA and the trial count N for reproducibility. A
 * second attempt throws — re-running the search against the vault would void it.
 */
export class FinalHoldoutGuard {
  private state: HoldoutConsumption = {
    consumed: false,
    reason: null,
    consumedAtIso: null,
    gitSha: null,
    trialCount: null,
  };

  isConsumed(): boolean {
    return this.state.consumed;
  }

  status(): HoldoutConsumption {
    return { ...this.state };
  }

  assertNotConsumed(): void {
    if (this.state.consumed) {
      throw new Error(
        `Final hold-out already consumed (${this.state.reason ?? "unknown"} at ` +
          `${this.state.consumedAtIso ?? "?"}); it can only be used once.`,
      );
    }
  }

  /** Mark the vault as consumed. Throws if already consumed. */
  consume(args: { reason: string; gitSha?: string | null; trialCount?: number | null; nowIso?: string }): HoldoutConsumption {
    this.assertNotConsumed();
    this.state = {
      consumed: true,
      reason: args.reason,
      consumedAtIso: args.nowIso ?? null,
      gitSha: args.gitSha ?? null,
      trialCount:
        typeof args.trialCount === "number" && Number.isFinite(args.trialCount)
          ? Math.max(0, Math.floor(args.trialCount))
          : null,
    };
    return this.status();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
