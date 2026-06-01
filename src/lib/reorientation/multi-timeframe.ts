/**
 * Multi-timeframe horizon as a TURNOVER-REDUCING gate (roadmap Plan #1).
 *
 * The 15m edge is real but thin: round-trip costs (~28 bps) scale with turnover and
 * eat it (see docs/ANALISE_CRITICA and turnover.ts). The tempting move — add 1h/4h/1d
 * signals and trade on ALL of them — INCREASES the number of entry/exit moments and
 * therefore INCREASES cost drag. That is exactly the wrong direction.
 *
 * The right direction: keep a single 15m executor and use the larger timeframes as a
 * causal directional GATE. An entry is only allowed when its side agrees with the
 * most-recent COMPLETED higher-timeframe bias. A gate can only REMOVE entries, so
 * turnover can never increase — it strictly decreases whenever any 15m entry disagrees
 * with the higher trend. Fewer trades, each clearing the cost hurdle by more.
 *
 * Strict anti-lookahead: a base (15m) bar is mapped to the higher bar that had already
 * CLOSED before it. A future higher bar can never change an earlier base bar's bias or
 * gating decision. Pure, deterministic, no I/O.
 */

import type { CryptoTimeframe } from "../market-data";

/**
 * Timeframes we treat as first-class for the multi-timeframe gate. "1w" is not part of
 * the `CryptoTimeframe` template-literal alphabet (m|h|d), so we model the set with a
 * dedicated union; the m/h/d members remain assignable to `CryptoTimeframe`.
 */
export type MultiTimeframe = "15m" | "1h" | "4h" | "1d" | "1w";

/** The base (executor) timeframe everything aggregates up from. */
export const BASE_TIMEFRAME: MultiTimeframe = "15m";

/** Minutes per bar for each supported timeframe. All are integer multiples of 15m. */
export const TIMEFRAME_MINUTES: Readonly<Record<MultiTimeframe, number>> = {
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
  "1w": 10080,
};

/** A m/h/d member of `MultiTimeframe` is also a valid `CryptoTimeframe`. */
export function toCryptoTimeframe(tf: Exclude<MultiTimeframe, "1w">): CryptoTimeframe {
  return tf;
}

/** Sort timeframes ascending by bar length (shortest → longest). Stable, pure. */
export function orderTimeframes(
  timeframes: readonly MultiTimeframe[],
): readonly MultiTimeframe[] {
  return [...timeframes].sort((a, b) => TIMEFRAME_MINUTES[a] - TIMEFRAME_MINUTES[b]);
}

/** True when `candidate` is a strictly longer (higher) timeframe than `base`. */
export function isHigherTimeframe(base: MultiTimeframe, candidate: MultiTimeframe): boolean {
  return TIMEFRAME_MINUTES[candidate] > TIMEFRAME_MINUTES[base];
}

/**
 * How many `base` bars fit in one `higher` bar. Requires `higher` to be a whole-number
 * multiple of `base` (true for the supported set) and strictly higher.
 */
export function barsPerHigherBar(base: MultiTimeframe, higher: MultiTimeframe): number {
  const baseMin = TIMEFRAME_MINUTES[base];
  const higherMin = TIMEFRAME_MINUTES[higher];
  if (higherMin <= baseMin) {
    throw new Error(`barsPerHigherBar: ${higher} is not higher than ${base}`);
  }
  if (higherMin % baseMin !== 0) {
    throw new Error(`barsPerHigherBar: ${higher} is not a whole multiple of ${base}`);
  }
  return higherMin / baseMin;
}

export type Bias = "up" | "down" | "flat";
export type Side = "long" | "short";

export interface HigherTimeframeBiasOptions {
  /** Base bars per higher bar (e.g. 4 for 15m→1h). */
  barsPerHigherBar: number;
  /**
   * |bucket return| at or below this is "flat" (no directional conviction). Default 0,
   * meaning any nonzero sign counts as a direction.
   */
  flatBand?: number;
}

export interface HigherBiasResult {
  /** Bias to apply to each BASE bar, length === baseReturns.length. */
  readonly perBaseBar: readonly Bias[];
  /** Bias of each COMPLETED higher bar, in close order (diagnostic). */
  readonly higherBarBias: readonly Bias[];
}

/**
 * Build a causal higher-timeframe directional bias for every base bar.
 *
 * Aggregation: base-bar log-or-simple returns are summed into fixed-size higher buckets.
 * A higher bucket's bias is decided from its OWN summed return once it CLOSES. Each base
 * bar then inherits the bias of the most-recent higher bar that closed strictly BEFORE
 * it — i.e. the higher bar covering the *previous* completed window.
 *
 * Anti-lookahead guarantee: base bar `t` lives in higher bucket `b = floor(t / k)`. The
 * most-recent completed higher bar before `t` is bucket `b - 1` (or none if `b === 0`).
 * Its bias depends only on returns in `[(b-1)*k, b*k)`, all of which are at indices < t.
 * Mutating any base return at index >= t cannot change it. Within the same bucket as `t`
 * we never peek (that bucket has not closed), so the first `k` base bars are "flat".
 */
export function buildHigherTimeframeBias(
  baseReturns: readonly number[],
  options: HigherTimeframeBiasOptions,
): HigherBiasResult {
  const k = Math.max(1, Math.floor(options.barsPerHigherBar));
  const flatBand = Math.max(0, options.flatBand ?? 0);
  const n = baseReturns.length;

  // Completed-bucket returns: bucket b is complete once base index reaches (b+1)*k.
  const higherBarBias: Bias[] = [];
  const bucketSum: number[] = [];
  for (let t = 0; t < n; t += 1) {
    const b = Math.floor(t / k);
    bucketSum[b] = (bucketSum[b] ?? 0) + (baseReturns[t] ?? 0);
  }
  // Only buckets that fully closed within the data are usable as completed bias.
  const completedBuckets = Math.floor(n / k);
  for (let b = 0; b < completedBuckets; b += 1) {
    higherBarBias.push(biasFromReturn(bucketSum[b] ?? 0, flatBand));
  }

  const perBaseBar: Bias[] = new Array<Bias>(n).fill("flat");
  for (let t = 0; t < n; t += 1) {
    const b = Math.floor(t / k);
    // Most-recent COMPLETED higher bar strictly before bar t is bucket (b - 1).
    const completedBias = b >= 1 ? higherBarBias[b - 1] : undefined;
    perBaseBar[t] = completedBias ?? "flat";
  }

  return { perBaseBar, higherBarBias };
}

function biasFromReturn(summed: number, flatBand: number): Bias {
  if (summed > flatBand) return "up";
  if (summed < -flatBand) return "down";
  return "flat";
}

export interface BaseEntry {
  /** Index of the base (15m) bar where the entry would fire. */
  index: number;
  side: Side;
}

export interface HigherTimeframeGateInput {
  readonly baseEntries: readonly BaseEntry[];
  /** Per-base-bar bias from one higher TF (length must cover every entry index). */
  readonly higherBias: readonly Bias[];
  /**
   * Optional ADDITIONAL higher-TF biases (e.g. 4h, 1d). When provided, an entry must
   * align with EVERY one of them ("all must align" stacking) — strictly more selective,
   * so turnover only drops further.
   */
  readonly additionalHigherBias?: readonly (readonly Bias[])[];
  /** When true, a "flat" higher bias blocks the entry. Default false (flat = permissive). */
  readonly blockOnFlat?: boolean;
}

export interface HigherTimeframeGateResult {
  readonly kept: readonly BaseEntry[];
  readonly removed: readonly BaseEntry[];
}

/**
 * Keep only entries whose side agrees with the higher-TF bias (and every additional
 * higher TF, if stacked). A gate can only REMOVE entries: `kept.length <= baseEntries.length`
 * always. Therefore turnover can never increase by gating, and strictly decreases whenever
 * any entry disagrees with the trend.
 */
export function higherTimeframeGate(
  input: HigherTimeframeGateInput,
): HigherTimeframeGateResult {
  const blockOnFlat = input.blockOnFlat ?? false;
  const biasLayers: readonly (readonly Bias[])[] = [
    input.higherBias,
    ...(input.additionalHigherBias ?? []),
  ];

  const kept: BaseEntry[] = [];
  const removed: BaseEntry[] = [];

  for (const entry of input.baseEntries) {
    const aligned = biasLayers.every((layer) =>
      biasAllowsSide(layer[entry.index], entry.side, blockOnFlat),
    );
    if (aligned) kept.push(entry);
    else removed.push(entry);
  }

  return { kept, removed };
}

function biasAllowsSide(
  bias: Bias | undefined,
  side: Side,
  blockOnFlat: boolean,
): boolean {
  if (bias === undefined) return !blockOnFlat ? true : false;
  if (bias === "flat") return !blockOnFlat;
  if (side === "long") return bias === "up";
  return bias === "down";
}

export interface SignalSet {
  /** Indices (in BASE-bar space) where this timeframe would fire an entry. */
  readonly entryIndices: readonly number[];
  readonly side: Side;
}

/**
 * The WRONG approach, included for contrast. Unioning entry signals across timeframes
 * adds every timeframe's entries together, so the entry count is >= the largest single
 * source and (with any non-overlapping signals) strictly larger than the base alone.
 * More entries ⇒ more round-trips ⇒ MORE turnover ⇒ more cost drag. This is why we gate
 * (intersection-like) rather than union.
 */
export function naiveMultiSignalUnion(
  signalsByTimeframe: Readonly<Record<string, SignalSet>>,
): readonly BaseEntry[] {
  const byIndex = new Map<number, Side>();
  for (const set of Object.values(signalsByTimeframe)) {
    for (const index of set.entryIndices) {
      // First writer wins per bar (you still can't enter twice on the same bar), but the
      // UNION across bars is what inflates the count vs any single timeframe.
      if (!byIndex.has(index)) byIndex.set(index, set.side);
    }
  }
  return [...byIndex.entries()]
    .map(([index, side]) => ({ index, side }))
    .sort((a, b) => a.index - b.index);
}

export interface TurnoverComparison {
  readonly baseEntries: number;
  readonly gatedEntries: number;
  readonly totalBars: number;
  readonly entriesPerBarBefore: number;
  readonly entriesPerBarAfter: number;
  /** Fractional reduction in entries, in [0, 1]. 0 when nothing was removed. */
  readonly reductionFraction: number;
  /** Same as a percentage. */
  readonly reductionPercent: number;
}

/** Turnover before vs after gating: entries-per-bar and the reduction. */
export function turnoverComparison(
  baseEntries: number,
  gatedEntries: number,
  totalBars: number,
): TurnoverComparison {
  const bars = Math.max(1, Math.floor(totalBars));
  const before = Math.max(0, Math.floor(baseEntries));
  const after = Math.max(0, Math.floor(gatedEntries));
  const entriesPerBarBefore = before / bars;
  const entriesPerBarAfter = after / bars;
  const reductionFraction = before > 0 ? (before - after) / before : 0;
  return {
    baseEntries: before,
    gatedEntries: after,
    totalBars: bars,
    entriesPerBarBefore,
    entriesPerBarAfter,
    reductionFraction,
    reductionPercent: reductionFraction * 100,
  };
}
