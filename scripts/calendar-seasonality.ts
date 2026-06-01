/**
 * Pure, causal calendar-seasonality helpers for TARGET 6 (BTC).
 *
 * NOVEL LOGIC (kept out of the audit script so it is unit-testable and so the
 * audit only WIRES it into the committed rigor gates):
 *
 *   - bucketReturns: assign every period return to a calendar bucket whose
 *     membership is known strictly in advance (weekday / day-of-month position /
 *     hour-of-day). The decision to be in the market for period t depends ONLY on
 *     t's calendar slot, which is fixed before t opens — so it is causal: no
 *     future return can change an earlier decision.
 *
 *   - applyBucketRule: given a SET of favorable buckets chosen on the search
 *     slice, produce the net-of-cost return series of a transparent rule:
 *       position(t) = +1 if bucket(t) in favorable      (long-flat)
 *                     -1 if bucket(t) in unfavorable     (long-short, optional)
 *                      0 otherwise.
 *     A round-trip cost is charged on every change of |position| (an entry or an
 *     exit), i.e. when the held side flips. Turnover = number of transitions.
 *
 * These functions do NOT pick the favorable set — the caller does that on the
 * search slice only — and they do NOT compute any statistics; all deflation /
 * baselines / DSR come from the committed cores.
 */

export interface CalendarPeriod {
  /** Epoch ms of the period (the bar this return is earned over). */
  ts: number;
  /** Net fractional return of the period (close-to-close of the bar). */
  ret: number;
  /** Calendar bucket id, derived only from ts (known in advance). */
  bucket: number;
}

export type BucketKind = "dow" | "tom" | "tod";

/**
 * Bucket id for a timestamp under one of the three calendar schemes. All are
 * pure functions of the UTC calendar of `ts` — never of the return.
 *   dow : UTC weekday 0..6 (Sun..Sat).
 *   tom : turn-of-month position. We bucket by signed distance to the month
 *         boundary: the last `tomWindow` calendar days of the month and the first
 *         `tomWindow` days of the next month form the "turn"; everything else is
 *         the "middle". Buckets: 0 = turn-of-month, 1 = middle. (Two buckets keeps
 *         N small and the effect interpretable.)
 *   tod : UTC hour-of-day 0..23 (for 15m intraday bars).
 */
export function bucketId(ts: number, kind: BucketKind, tomWindow = 3): number {
  const d = new Date(ts);
  if (kind === "dow") return d.getUTCDay();
  if (kind === "tod") return d.getUTCHours();
  // tom: is the day within `tomWindow` of a month boundary?
  const dayOfMonth = d.getUTCDate();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const nearStart = dayOfMonth <= tomWindow;
  const nearEnd = dayOfMonth > daysInMonth - tomWindow;
  return nearStart || nearEnd ? 0 : 1;
}

/** Attach a calendar bucket to each (ts, ret) pair. Causal: bucket(ts) ignores ret. */
export function bucketReturns(
  periods: readonly { ts: number; ret: number }[],
  kind: BucketKind,
  tomWindow = 3,
): CalendarPeriod[] {
  return periods.map((p) => ({ ts: p.ts, ret: p.ret, bucket: bucketId(p.ts, kind, tomWindow) }));
}

export interface BucketStat {
  bucket: number;
  count: number;
  meanRet: number;
  sumRet: number;
}

/** Per-bucket mean return on a slice — the search uses this to RANK buckets. */
export function bucketStats(periods: readonly CalendarPeriod[]): BucketStat[] {
  const agg = new Map<number, { count: number; sum: number }>();
  for (const p of periods) {
    const a = agg.get(p.bucket) ?? { count: 0, sum: 0 };
    a.count += 1;
    a.sum += p.ret;
    agg.set(p.bucket, a);
  }
  return [...agg.entries()]
    .map(([bucket, a]) => ({ bucket, count: a.count, meanRet: a.count > 0 ? a.sum / a.count : 0, sumRet: a.sum }))
    .sort((x, y) => x.bucket - y.bucket);
}

export interface BucketRuleResult {
  /** Net-of-cost per-period return series (0 when flat). */
  netReturns: number[];
  /** Gross per-period return series (position * ret, no cost). */
  grossReturns: number[];
  /** Number of side transitions (entries+exits) = round trips proxy. */
  transitions: number;
  /** Fraction of periods with a non-zero position. */
  exposure: number;
  /** Number of periods actually traded (non-zero positions). */
  activePeriods: number;
}

/**
 * Apply a transparent long-flat (or long-short) rule given a favorable bucket set
 * (and, for long-short, an unfavorable set). `roundTripCost` is the FULL cost of a
 * round trip (one entry + one exit); we charge HALF of it on every one-sided
 * transition, so a complete flat->long->flat cycle costs exactly `roundTripCost`,
 * and a long->short flip (which is 2 one-sided changes) costs `roundTripCost`.
 * Fully causal: position(t) depends only on bucket(t), known before period t.
 */
export function applyBucketRule(
  periods: readonly CalendarPeriod[],
  favorable: ReadonlySet<number>,
  options: { roundTripCost: number; unfavorable?: ReadonlySet<number> },
): BucketRuleResult {
  const sideCost = Math.max(0, options.roundTripCost) / 2; // half a round trip per one-sided change
  const unfav = options.unfavorable ?? new Set<number>();
  const netReturns: number[] = [];
  const grossReturns: number[] = [];
  let prevPos = 0;
  let transitions = 0;
  let active = 0;

  for (const p of periods) {
    const pos = favorable.has(p.bucket) ? 1 : unfav.has(p.bucket) ? -1 : 0;
    // Cost is charged on the change in absolute exposure that requires a trade.
    // A flip long<->short trades 2 units (close + open); flat<->side trades 1 unit.
    const tradeUnits = Math.abs(pos - prevPos);
    const periodCost = tradeUnits * sideCost;
    const gross = pos * p.ret;
    grossReturns.push(gross);
    netReturns.push(gross - periodCost);
    if (tradeUnits > 0) transitions += tradeUnits;
    if (pos !== 0) active += 1;
    prevPos = pos;
  }
  // Closing cost when the series ends holding a position (exit at the end).
  if (prevPos !== 0 && netReturns.length > 0) {
    netReturns[netReturns.length - 1]! -= Math.abs(prevPos) * sideCost;
    transitions += Math.abs(prevPos);
  }

  return {
    netReturns,
    grossReturns,
    transitions,
    exposure: periods.length > 0 ? active / periods.length : 0,
    activePeriods: active,
  };
}

/** Compound a fractional return series (log-safe), matching the cores' convention. */
export function compound(returns: readonly number[]): number {
  let log = 0;
  for (const r of returns) {
    if (r <= -1) return -1;
    log += Math.log1p(r);
  }
  return Math.expm1(log);
}
