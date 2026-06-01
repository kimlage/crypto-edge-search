/**
 * Cross-sectional WEEKLY momentum L/S portfolio (CTREND / Liu-Tsyvinski 2021).
 *
 * The #1 cost-surviving edge in the crypto factor literature: rank coins by their
 * trailing K-week return, go LONG the top decile and SHORT the bottom decile,
 * equal-weight, rebalance weekly. This module is PURE and CAUSAL — at week t the
 * ranking uses only returns up to and including week t-1 (the signal is the
 * trailing-K cumulative return ending at t-1), and the realized payoff is the
 * cross-section of week-t returns. There is NO look-ahead and NO fitting.
 *
 * Costs: each rebalance changes weights; turnover = Σ|Δw| across the (long+short)
 * book. We charge `roundTripCost/2` per unit of one-way weight traded (a round trip
 * is enter+exit, so one side of the change costs half a round trip). The net weekly
 * return is the gross portfolio return minus that turnover cost.
 *
 * Deterministic, dependency-free. No I/O, no randomness.
 */

export type LongShortMode = "long_short" | "long_only";

export interface MomentumConfig {
  /** Trailing window length in weeks for the momentum signal. Default 4. */
  lookbackWeeks?: number;
  /**
   * Fraction of the cross-section taken on each side (top/bottom). Default 0.1
   * (decile). With ~30 coins a decile is 3 names per side.
   */
  quantile?: number;
  /** Round-trip cost as a fraction (e.g. 0.0028). Charged as cost/2 per one-way Δw. */
  roundTripCost?: number;
  /** long_short (default) or long_only (top decile only). */
  mode?: LongShortMode;
  /**
   * Optional skip of the most recent `skipWeeks` weeks in the signal window
   * (classic momentum skips the last period to avoid short-term reversal). Default 0.
   */
  skipWeeks?: number;
}

export interface WeeklyMomentumPoint {
  /** Index of the realized week in the supplied matrix. */
  weekIndex: number;
  /** Gross equal-weight L/S (or long-only) return for the week, before costs. */
  grossReturn: number;
  /** Turnover this week = Σ|Δw| over the whole book (long+short legs). */
  turnover: number;
  /** Cost charged this week = turnover * roundTripCost / 2. */
  cost: number;
  /** Net return = gross - cost. */
  netReturn: number;
  /** Number of coins eligible (had a valid trailing signal) this week. */
  eligible: number;
  /** Names held long / short this week. */
  longCount: number;
  shortCount: number;
}

export interface MomentumResult {
  config: Required<MomentumConfig>;
  points: WeeklyMomentumPoint[];
  grossReturns: number[];
  netReturns: number[];
  turnovers: number[];
  /** Equal-weight "hold the whole universe" weekly returns over the SAME weeks. */
  universeReturns: number[];
  meanTurnover: number;
  /** Realized rebalances per week (should be ~1.0 by construction). */
  rebalancesPerWeek: number;
}

/** Cross-section of weekly returns: coins x weeks, null where a coin is missing. */
export interface WeeklyPanel {
  coins: readonly string[];
  /** weeklyRet[coin] = array of weekly simple returns (may contain null/NaN gaps). */
  weeklyRet: Readonly<Record<string, readonly (number | null)[]>>;
  /** Number of weekly periods (length of each coin's array). */
  weekCount: number;
}

const DEFAULTS: Required<MomentumConfig> = {
  lookbackWeeks: 4,
  quantile: 0.1,
  roundTripCost: 0.0028,
  mode: "long_short",
  skipWeeks: 0,
};

function isFiniteNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Trailing cumulative (compound) return over weeks [t-lookback-skip, t-1-skip],
 * i.e. ending at week t-1-skip, using ONLY past data. Returns null if any week in
 * the window is missing for that coin (no fabrication).
 */
function trailingSignal(
  series: readonly (number | null)[],
  t: number,
  lookback: number,
  skip: number,
): number | null {
  const end = t - 1 - skip; // last week included in the signal (inclusive)
  const start = end - lookback + 1;
  if (start < 0) return null;
  let cum = 1;
  for (let i = start; i <= end; i += 1) {
    const r = series[i];
    if (!isFiniteNum(r)) return null;
    cum *= 1 + r;
  }
  return cum - 1;
}

/**
 * Run the cross-sectional weekly momentum portfolio over the panel.
 *
 * For each realizable week t (where a trailing signal exists for enough coins):
 *  - rank eligible coins by trailing-K signal computed on weeks <= t-1
 *  - long top `quantile`, short bottom `quantile` (equal weight per side)
 *  - realized return = Σ w_i * r_{i,t}  (r at week t)
 *  - turnover vs previous week's weights; cost = turnover * roundTripCost/2
 */
export function runCrossSectionalMomentum(
  panel: WeeklyPanel,
  config: MomentumConfig = {},
): MomentumResult {
  const cfg: Required<MomentumConfig> = {
    lookbackWeeks: Math.max(1, Math.floor(config.lookbackWeeks ?? DEFAULTS.lookbackWeeks)),
    quantile: clamp(config.quantile ?? DEFAULTS.quantile, 0.01, 0.5),
    roundTripCost: Math.max(0, config.roundTripCost ?? DEFAULTS.roundTripCost),
    mode: config.mode ?? DEFAULTS.mode,
    skipWeeks: Math.max(0, Math.floor(config.skipWeeks ?? DEFAULTS.skipWeeks)),
  };

  const coins = panel.coins;
  const T = panel.weekCount;
  const points: WeeklyMomentumPoint[] = [];
  const universeReturns: number[] = [];

  let prevWeights = new Map<string, number>();

  const firstRealizable = cfg.lookbackWeeks + cfg.skipWeeks; // need t-1-skip-lookback+1 >= 0

  for (let t = firstRealizable; t < T; t += 1) {
    // Build the signal cross-section using only data up to t-1.
    const signals: { coin: string; signal: number; realized: number }[] = [];
    for (const coin of coins) {
      const series = panel.weeklyRet[coin] ?? [];
      const realized = series[t];
      if (!isFiniteNum(realized)) continue; // need a realized return to hold it
      const sig = trailingSignal(series, t, cfg.lookbackWeeks, cfg.skipWeeks);
      if (sig === null) continue;
      signals.push({ coin, signal: sig, realized });
    }
    const eligible = signals.length;
    // Need enough names to form at least one per side.
    if (eligible < Math.ceil(1 / cfg.quantile)) {
      // not enough coins this week; carry forward (no trade, weights unchanged)
      continue;
    }

    signals.sort((a, b) => b.signal - a.signal); // descending: winners first
    const sideCount = Math.max(1, Math.floor(eligible * cfg.quantile));
    const longs = signals.slice(0, sideCount);
    const shorts = cfg.mode === "long_short" ? signals.slice(eligible - sideCount) : [];

    const weights = new Map<string, number>();
    const longW = 1 / longs.length;
    for (const s of longs) weights.set(s.coin, (weights.get(s.coin) ?? 0) + longW);
    if (shorts.length > 0) {
      const shortW = -1 / shorts.length;
      for (const s of shorts) weights.set(s.coin, (weights.get(s.coin) ?? 0) + shortW);
    }

    // Gross portfolio return this week.
    let gross = 0;
    const realizedByCoin = new Map<string, number>();
    for (const s of signals) realizedByCoin.set(s.coin, s.realized);
    for (const [coin, w] of weights) {
      gross += w * (realizedByCoin.get(coin) ?? 0);
    }

    // Turnover vs previous week's weights (Σ|Δw| over the union of names).
    let turnover = 0;
    const names = new Set<string>([...weights.keys(), ...prevWeights.keys()]);
    for (const name of names) {
      const wNew = weights.get(name) ?? 0;
      const wOld = prevWeights.get(name) ?? 0;
      turnover += Math.abs(wNew - wOld);
    }
    const cost = turnover * (cfg.roundTripCost / 2);
    const net = gross - cost;

    points.push({
      weekIndex: t,
      grossReturn: gross,
      turnover,
      cost,
      netReturn: net,
      eligible,
      longCount: longs.length,
      shortCount: shorts.length,
    });

    // Equal-weight universe return over the eligible names this week (the bar).
    let uni = 0;
    for (const s of signals) uni += s.realized;
    universeReturns.push(uni / eligible);

    prevWeights = weights;
  }

  const grossReturns = points.map((p) => p.grossReturn);
  const netReturns = points.map((p) => p.netReturn);
  const turnovers = points.map((p) => p.turnover);
  const meanTurnover = turnovers.length > 0 ? turnovers.reduce((a, b) => a + b, 0) / turnovers.length : 0;

  return {
    config: cfg,
    points,
    grossReturns,
    netReturns,
    turnovers,
    universeReturns,
    meanTurnover,
    // One rebalance per realized week by construction (we trade every realizable week).
    rebalancesPerWeek: points.length > 0 ? 1 : 0,
  };
}

/** Helper: assemble a WeeklyPanel from a coin->returns record. */
export function buildWeeklyPanel(
  weeklyRet: Record<string, readonly (number | null)[]>,
  coins?: readonly string[],
): WeeklyPanel {
  const keys = coins ?? Object.keys(weeklyRet);
  const weekCount = keys.reduce((max, c) => Math.max(max, (weeklyRet[c] ?? []).length), 0);
  return { coins: keys, weeklyRet, weekCount };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
