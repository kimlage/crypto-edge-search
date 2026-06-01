/**
 * Cross-sectional WEEKLY SHORT-TERM REVERSAL L/S portfolio (TARGET 1).
 *
 * The MIRROR IMAGE of the committed cross-sectional momentum engine
 * (src/lib/reorientation/cross-sectional-momentum.ts): rank coins by
 * their trailing K-week return computed on data <= t-1, then go LONG the WORST
 * (bottom quantile) and SHORT the BEST (top quantile), equal-weight, rebalance
 * weekly. This is the documented crypto short-term reversal effect (the opposite
 * of momentum). The cost/turnover/eligibility bookkeeping is IDENTICAL to the
 * momentum engine so the two are directly comparable; only the long/short
 * assignment is flipped.
 *
 * PURE and CAUSAL: at week t the ranking uses ONLY returns up to and including
 * week t-1-skip (the trailing-K cumulative return), and the realized payoff is
 * the cross-section of week-t returns. No look-ahead, no fitting, no I/O, no
 * randomness. A missing week in the signal window => that coin is skipped (no
 * fabrication).
 *
 * Costs: turnover = Σ|Δw| across the (long+short) book; we charge
 * roundTripCost/2 per unit of one-way weight traded — exactly as the momentum
 * engine does.
 */

export type LongShortMode = "long_short" | "long_only";

export interface ReversalConfig {
  /** Trailing window length in weeks for the reversal signal. Default 1 (classic STR). */
  lookbackWeeks?: number;
  /** Fraction of the cross-section taken on each side (top/bottom). Default 0.1. */
  quantile?: number;
  /** Round-trip cost as a fraction (e.g. 0.0028). Charged as cost/2 per one-way Δw. */
  roundTripCost?: number;
  /**
   * long_short (default): long the WORST quantile, short the BEST quantile.
   * long_only: long the WORST quantile only (no short leg).
   */
  mode?: LongShortMode;
  /** Optional skip of the most recent `skipWeeks` weeks in the signal window. Default 0. */
  skipWeeks?: number;
}

export interface ReversalPoint {
  weekIndex: number;
  grossReturn: number;
  turnover: number;
  cost: number;
  netReturn: number;
  eligible: number;
  longCount: number;
  shortCount: number;
}

export interface ReversalResult {
  config: Required<ReversalConfig>;
  points: ReversalPoint[];
  grossReturns: number[];
  netReturns: number[];
  turnovers: number[];
  universeReturns: number[];
  meanTurnover: number;
  rebalancesPerWeek: number;
}

export interface WeeklyPanel {
  coins: readonly string[];
  weeklyRet: Readonly<Record<string, readonly (number | null)[]>>;
  weekCount: number;
}

const DEFAULTS: Required<ReversalConfig> = {
  lookbackWeeks: 1,
  quantile: 0.1,
  roundTripCost: 0.0028,
  mode: "long_short",
  skipWeeks: 0,
};

function isFiniteNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Trailing cumulative (compound) return over weeks ending at t-1-skip, using ONLY
 * past data. Returns null if any week in the window is missing for that coin.
 */
function trailingSignal(
  series: readonly (number | null)[],
  t: number,
  lookback: number,
  skip: number,
): number | null {
  const end = t - 1 - skip;
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Run the cross-sectional weekly REVERSAL portfolio over the panel. For each
 * realizable week t:
 *  - rank eligible coins by trailing-K signal computed on weeks <= t-1
 *  - LONG the bottom `quantile` (worst trailing performers), SHORT the top
 *    `quantile` (best trailing performers), equal weight per side
 *  - realized return = Σ w_i * r_{i,t}
 *  - turnover vs previous week's weights; cost = turnover * roundTripCost/2
 */
export function runCrossSectionalReversal(
  panel: WeeklyPanel,
  config: ReversalConfig = {},
): ReversalResult {
  const cfg: Required<ReversalConfig> = {
    lookbackWeeks: Math.max(1, Math.floor(config.lookbackWeeks ?? DEFAULTS.lookbackWeeks)),
    quantile: clamp(config.quantile ?? DEFAULTS.quantile, 0.01, 0.5),
    roundTripCost: Math.max(0, config.roundTripCost ?? DEFAULTS.roundTripCost),
    mode: config.mode ?? DEFAULTS.mode,
    skipWeeks: Math.max(0, Math.floor(config.skipWeeks ?? DEFAULTS.skipWeeks)),
  };

  const coins = panel.coins;
  const T = panel.weekCount;
  const points: ReversalPoint[] = [];
  const universeReturns: number[] = [];

  let prevWeights = new Map<string, number>();

  const firstRealizable = cfg.lookbackWeeks + cfg.skipWeeks;

  for (let t = firstRealizable; t < T; t += 1) {
    const signals: { coin: string; signal: number; realized: number }[] = [];
    for (const coin of coins) {
      const series = panel.weeklyRet[coin] ?? [];
      const realized = series[t];
      if (!isFiniteNum(realized)) continue;
      const sig = trailingSignal(series, t, cfg.lookbackWeeks, cfg.skipWeeks);
      if (sig === null) continue;
      signals.push({ coin, signal: sig, realized });
    }
    const eligible = signals.length;
    if (eligible < Math.ceil(1 / cfg.quantile)) continue;

    // Descending by signal: winners first, losers last (SAME ordering as the
    // momentum engine). Reversal flips which side we trade.
    signals.sort((a, b) => b.signal - a.signal);
    const sideCount = Math.max(1, Math.floor(eligible * cfg.quantile));
    const winners = signals.slice(0, sideCount); // best trailing performers
    const losers = signals.slice(eligible - sideCount); // worst trailing performers

    // REVERSAL: LONG the losers, SHORT the winners.
    const longs = losers;
    const shorts = cfg.mode === "long_short" ? winners : [];

    const weights = new Map<string, number>();
    const longW = 1 / longs.length;
    for (const s of longs) weights.set(s.coin, (weights.get(s.coin) ?? 0) + longW);
    if (shorts.length > 0) {
      const shortW = -1 / shorts.length;
      for (const s of shorts) weights.set(s.coin, (weights.get(s.coin) ?? 0) + shortW);
    }

    let gross = 0;
    const realizedByCoin = new Map<string, number>();
    for (const s of signals) realizedByCoin.set(s.coin, s.realized);
    for (const [coin, w] of weights) gross += w * (realizedByCoin.get(coin) ?? 0);

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
    rebalancesPerWeek: points.length > 0 ? 1 : 0,
  };
}

export function buildWeeklyPanel(
  weeklyRet: Record<string, readonly (number | null)[]>,
  coins?: readonly string[],
): WeeklyPanel {
  const keys = coins ?? Object.keys(weeklyRet);
  const weekCount = keys.reduce((max, c) => Math.max(max, (weeklyRet[c] ?? []).length), 0);
  return { coins: keys, weeklyRet, weekCount };
}
