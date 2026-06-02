/**
 * Calendar / event re-anchoring surrogate.
 *
 * A "calendar edge" claim says some PRIVILEGED set of buckets — specific days of the
 * week, months, hours, an event window — earns an abnormal return. The danger is
 * date-mining: with enough candidate buckets, SOME subset always looks special on a
 * fixed sample. The right null keeps everything about the data EXCEPT the privilege
 * of the chosen buckets:
 *
 *   - the series values are untouched (so the marginal, the vol, the tails survive),
 *   - the bucket labels of each observation are untouched (so the seasonal SHAPE —
 *     how returns map onto Monday/Tuesday/... — is intact), and
 *   - only WHICH buckets are tagged "special" is reshuffled, keeping the COUNT of
 *     special buckets fixed.
 *
 * Under this null the chosen-date privilege is destroyed while the calendar geometry
 * and the data are preserved, so a family-wise-max statistic over many re-anchorings
 * tells you whether the real chosen buckets beat what date-mining alone would find.
 *
 * Pure & deterministic given the seeded `random`. No I/O.
 */

export interface CalendarReanchorInput {
  /** The observation series (e.g. per-period returns). Not modified. */
  series: readonly number[];
  /**
   * Calendar bucket index for each observation (same length as `series`). E.g.
   * day-of-week 0..6, or month 0..11. Defines the seasonal partition.
   */
  buckets: readonly number[];
  /** The bucket ids that the claim labels "special" (the chosen-date set). */
  specialBuckets: readonly number[];
}

export interface CalendarReanchorResult {
  /** The (unchanged) series, echoed for convenience so callers can score directly. */
  series: number[];
  /** The (unchanged) per-observation bucket labels. */
  buckets: number[];
  /** The reshuffled set of special bucket ids (same COUNT as the input). */
  specialBuckets: number[];
  /** Per-observation boolean: is this observation in a (re-anchored) special bucket? */
  isSpecial: boolean[];
}

/**
 * Produce one calendar re-anchoring surrogate: keep the series and the bucket labels,
 * but randomly re-choose which of the distinct buckets are "special", preserving the
 * count of special buckets. Sampling is without replacement over the DISTINCT buckets
 * present in `buckets` (union'd with the requested special set, so a requested special
 * bucket that never occurs is still a valid candidate slot).
 */
export function calendarReanchor(
  input: CalendarReanchorInput,
  random: () => number,
): CalendarReanchorResult {
  const series = [...input.series];
  const buckets = [...input.buckets];

  // Candidate pool: every distinct bucket id that appears, plus any requested special
  // ones (so the special count is always satisfiable). Sorted for deterministic order.
  const distinct = new Set<number>();
  for (const b of buckets) distinct.add(b);
  for (const b of input.specialBuckets) distinct.add(b);
  const pool = [...distinct].sort((a, b) => a - b);

  // How many special buckets to pick — clamped to the pool size.
  const wanted = new Set(input.specialBuckets);
  const k = Math.min(wanted.size, pool.length);

  const chosen = sampleWithoutReplacement(pool, k, random).sort((a, b) => a - b);
  const chosenSet = new Set(chosen);
  const isSpecial = buckets.map((b) => chosenSet.has(b));

  return { series, buckets, specialBuckets: chosen, isSpecial };
}

/**
 * Draw `count` distinct items from `pool` without replacement using a partial
 * Fisher-Yates over a copy. Deterministic given `random`; never mutates `pool`.
 */
function sampleWithoutReplacement(
  pool: readonly number[],
  count: number,
  random: () => number,
): number[] {
  const work = [...pool];
  const n = work.length;
  const k = Math.max(0, Math.min(count, n));
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(random() * (n - i));
    const tmp = work[i]!;
    work[i] = work[j]!;
    work[j] = tmp;
  }
  return work.slice(0, k);
}
