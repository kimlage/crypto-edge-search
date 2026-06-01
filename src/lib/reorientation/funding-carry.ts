/**
 * Delta-neutral perpetual funding CARRY (EXPERIMENT 2 — structural feasibility,
 * NOT a directional forecast).
 *
 * The trade: hold a long SPOT position of notional S and a short PERP position of
 * notional S so the net price delta is ~0. Each funding interval (8h on Binance),
 * the short-perp leg COLLECTS funding when funding > 0 (longs pay shorts) and PAYS
 * funding when funding < 0. The position is only opened while funding clears an
 * `entryThreshold`; when funding falls below an `exitThreshold` the position is
 * closed (no carry, no price risk, no drag — you sit in cash/spot-only flat here).
 *
 * Costs charged honestly:
 *   - taker fee on BOTH legs at entry and at exit (round-trip = 2 legs in + 2 out);
 *   - a rebalance taker fee whenever the hedge drifts past `rebalanceDriftThreshold`
 *     because spot and perp marks diverge (basis move), restoring delta~0.
 *
 * Worst-case STRESS (the thing that actually kills carry desks):
 *   - a sustained negative-funding regime where you keep paying; PLUS
 *   - one FTX-style counterparty gap where the venue holding the SHORT perp leg
 *     fails and you LOSE that leg's collateral/unrealized PnL while still holding
 *     the long spot — modeled as a one-off capital hit.
 *
 * Judgement reframe (per the brief): carry is judged by net APR vs drawdown and
 * worst-case SURVIVABILITY, NOT by beating a directional baseline. The per-interval
 * net-carry returns are still produced so the standard DSR/haircut machinery can be
 * applied (with the explicit caveat that this is ONE strategy, low N).
 *
 * Pure and deterministic — no I/O, no Date.now, no RNG.
 */

const EIGHT_HOUR_INTERVALS_PER_YEAR = 365.25 * 3; // 3 funding settlements/day

export interface FundingInterval {
  /** Epoch ms of the funding settlement. */
  fundingTime: number;
  /** Funding rate for the interval as a fraction (e.g. 0.0001 = 1bp/8h). */
  fundingRate: number;
  /**
   * Optional fractional basis move over the interval (perp vs spot), used to
   * trigger delta-restoring rebalances. If omitted, no drift-driven rebalances.
   */
  basisMove?: number;
}

export interface CarryConfig {
  /** Open/stay-in while funding > this (fraction per interval). Default 0 (any positive). */
  entryThreshold?: number;
  /** Close when funding <= this (fraction per interval). Default = entryThreshold. */
  exitThreshold?: number;
  /** Taker fee per leg per side (fraction). Binance USDT-perp taker ≈ 0.0004 (4bps). */
  takerFeePerLeg?: number;
  /**
   * |basisMove| beyond which the hedge is rebalanced to restore delta~0, costing one
   * leg's taker fee (you re-trade the perp leg). Default 0.01 (1%). Set high to disable.
   */
  rebalanceDriftThreshold?: number;
  /** Funding settlements per year (annualization). Default 1095.75 (8h). */
  intervalsPerYear?: number;
}

export interface CarryResult {
  intervals: number;
  intervalsInPosition: number;
  fractionInPosition: number;
  entries: number;
  rebalances: number;
  /** Per-interval NET carry return on notional S (0 when flat). For DSR/haircut. */
  netReturns: number[];
  /** Gross funding collected/paid (no fees), fraction of notional, compounded. */
  grossFundingYield: number;
  /** Net cumulative yield after all fees, fraction of notional, compounded. */
  netCumulativeYield: number;
  /** Annualized net APR (compounded). */
  netApr: number;
  /** Annualized gross funding APR (no fees). */
  grossApr: number;
  /** Realized annualized vol of the per-interval net returns. */
  realizedVolAnnualized: number;
  /** Max drawdown of the net-yield equity curve (positive fraction). */
  maxDrawdown: number;
  /** Total fees paid as a fraction of notional. */
  totalFeesPaid: number;
  /** Mean net return per interval (in-sample, all intervals incl. flat). */
  meanNetReturnPerInterval: number;
}

export interface StressConfig {
  /** Length of the sustained negative-funding regime appended (intervals). Default 90 (~30d). */
  negativeRegimeIntervals?: number;
  /** Negative funding rate during the stress regime (fraction/interval). Default -0.0005 (-5bp/8h). */
  negativeRegimeRate?: number;
  /**
   * Counterparty-gap loss as a fraction of notional when the short-leg venue fails.
   * FTX-style: lose the short leg's posted collateral/unrealized PnL. Default 0.5 (50%).
   */
  counterpartyGapLoss?: number;
  takerFeePerLeg?: number;
  intervalsPerYear?: number;
}

export interface StressResult {
  /** Net carry over the appended sustained-negative regime alone (fraction, no gap). */
  negativeRegimeNetReturn: number;
  /** The one-off counterparty-gap capital loss (fraction of notional). */
  counterpartyGapLoss: number;
  /** Cumulative net yield after baseline carry + negative regime + counterparty gap. */
  stressedCumulativeYield: number;
  /**
   * SURVIVABLE when the full stressed path keeps cumulative net yield above -1
   * (not wiped out) AND the gap loss alone does not exceed the baseline buffer by
   * more than the configured tolerance. We report the raw numbers; the verdict is
   * "survivable" iff stressedCumulativeYield > survivalFloor.
   */
  survivable: boolean;
  survivalFloor: number;
  reason: string;
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Simulate the delta-neutral carry over a funding series. While funding clears the
 * entry threshold the position is held and collects (or pays) funding each interval;
 * fees are charged on entry, exit, and drift-driven rebalances. Returns the full set
 * of feasibility metrics plus the per-interval net-return series for the gates.
 */
export function simulateFundingCarry(
  series: readonly FundingInterval[],
  config: CarryConfig = {},
): CarryResult {
  const entryThreshold = num(config.entryThreshold, 0);
  const exitThreshold = num(config.exitThreshold, entryThreshold);
  const takerFeePerLeg = Math.max(0, num(config.takerFeePerLeg, 0.0004));
  const rebalanceDrift = Math.max(0, num(config.rebalanceDriftThreshold, 0.01));
  const intervalsPerYear = Math.max(1, num(config.intervalsPerYear, EIGHT_HOUR_INTERVALS_PER_YEAR));

  // Entry/exit each move TWO legs (spot + perp), so a full round trip = 4 leg-fees.
  const entryCost = 2 * takerFeePerLeg; // open both legs
  const exitCost = 2 * takerFeePerLeg; // close both legs
  const rebalanceCost = takerFeePerLeg; // re-trade the perp leg to restore delta

  const netReturns: number[] = [];
  let inPosition = false;
  let intervalsInPosition = 0;
  let entries = 0;
  let rebalances = 0;
  let totalFeesPaid = 0;
  let grossLog = 0; // log-compounded gross funding while in position
  let netLog = 0; // log-compounded net (funding - fees) over ALL intervals

  for (let i = 0; i < series.length; i += 1) {
    const interval = series[i]!;
    const rate = Number.isFinite(interval.fundingRate) ? interval.fundingRate : 0;
    let intervalFee = 0;
    let fundingPnl = 0;

    if (!inPosition) {
      // Open when funding clears the entry bar.
      if (rate > entryThreshold) {
        inPosition = true;
        entries += 1;
        intervalFee += entryCost;
        // Collect this interval's funding (short perp receives when rate > 0).
        fundingPnl = rate;
        intervalsInPosition += 1;
      }
      // else: stay flat — exactly 0 carry, 0 fee, 0 price risk this interval.
    } else {
      // Already in position: collect/pay this interval's funding.
      fundingPnl = rate;
      intervalsInPosition += 1;
      // Drift-driven rebalance to restore delta~0 after a basis move.
      const basisMove = Math.abs(num(interval.basisMove, 0));
      if (basisMove > rebalanceDrift) {
        intervalFee += rebalanceCost;
        rebalances += 1;
      }
      // Exit when funding falls to/below the exit bar.
      if (rate <= exitThreshold) {
        intervalFee += exitCost;
        inPosition = false;
      }
    }

    const netInterval = fundingPnl - intervalFee;
    totalFeesPaid += intervalFee;
    if (fundingPnl !== 0) grossLog += Math.log1p(clampReturn(fundingPnl));
    netLog += Math.log1p(clampReturn(netInterval));
    netReturns.push(netInterval);
  }

  // If still in position at the end, charge the unwind so the books close flat.
  if (inPosition) {
    totalFeesPaid += exitCost;
    netLog += Math.log1p(clampReturn(-exitCost));
    if (netReturns.length > 0) netReturns[netReturns.length - 1]! -= exitCost;
  }

  const intervals = series.length;
  const grossFundingYield = Math.expm1(grossLog);
  const netCumulativeYield = Math.expm1(netLog);
  const fractionInPosition = intervals > 0 ? intervalsInPosition / intervals : 0;

  // Annualize via the realized average compound growth per interval.
  const netApr = intervals > 0 ? Math.expm1((netLog / intervals) * intervalsPerYear) : 0;
  const grossApr =
    intervalsInPosition > 0
      ? Math.expm1((grossLog / intervalsInPosition) * intervalsPerYear)
      : 0;

  const { stdDev, mean } = meanStd(netReturns);
  const realizedVolAnnualized = stdDev * Math.sqrt(intervalsPerYear);
  const maxDrawdown = maxDrawdownFromReturns(netReturns);

  return {
    intervals,
    intervalsInPosition,
    fractionInPosition,
    entries,
    rebalances,
    netReturns,
    grossFundingYield,
    netCumulativeYield,
    netApr,
    grossApr,
    realizedVolAnnualized,
    maxDrawdown,
    totalFeesPaid,
    meanNetReturnPerInterval: mean,
  };
}

/**
 * Worst-case stress on top of a baseline carry run: append a sustained
 * negative-funding regime (you keep paying) and then a single FTX-style
 * counterparty gap that wipes the short leg. Returns whether the combined path
 * survives (cumulative net yield stays above the survival floor).
 */
export function stressFundingCarry(
  baseline: CarryResult,
  config: StressConfig = {},
): StressResult {
  const negIntervals = Math.max(0, Math.floor(num(config.negativeRegimeIntervals, 90)));
  const negRate = num(config.negativeRegimeRate, -0.0005);
  const gapLoss = Math.max(0, Math.min(1, num(config.counterpartyGapLoss, 0.5)));
  const takerFeePerLeg = Math.max(0, num(config.takerFeePerLeg, 0.0004));
  const intervalsPerYear = Math.max(1, num(config.intervalsPerYear, EIGHT_HOUR_INTERVALS_PER_YEAR));

  // Build the sustained-negative regime as if the gate FAILED to keep us out
  // (the pessimistic case: we are caught holding while funding is deeply negative).
  // Entry cost once, then pay negRate each interval, then exit cost.
  const negativeSeries: FundingInterval[] = Array.from({ length: negIntervals }, (_, i) => ({
    fundingTime: i,
    fundingRate: negRate,
  }));
  const stressedRun = simulateFundingCarry(negativeSeries, {
    entryThreshold: negRate - 1, // force entry so we MUST hold (worst case)
    exitThreshold: negRate - 1,
    takerFeePerLeg,
    rebalanceDriftThreshold: Number.POSITIVE_INFINITY,
    intervalsPerYear,
  });
  const negativeRegimeNetReturn = stressedRun.netCumulativeYield;

  // Combine: baseline carry, then the negative regime, then a one-off gap loss.
  const baseLog = Math.log1p(clampReturn(baseline.netCumulativeYield));
  const negLog = Math.log1p(clampReturn(negativeRegimeNetReturn));
  const gapLog = Math.log1p(clampReturn(-gapLoss));
  const stressedCumulativeYield = Math.expm1(baseLog + negLog + gapLog);

  // Survival floor: a carry book is "survivable" if the stressed path does not
  // drop below -50% of capital (a desk losing >half its capital to a single
  // tail is not a survivable carry program). This is a structural risk bar.
  const survivalFloor = -0.5;
  const survivable = stressedCumulativeYield > survivalFloor;

  let reason: string;
  if (stressedCumulativeYield <= -1 + 1e-9) {
    reason = "wiped_out";
  } else if (!survivable) {
    reason = "below_survival_floor_-50pct";
  } else {
    reason = "survivable";
  }

  return {
    negativeRegimeNetReturn,
    counterpartyGapLoss: gapLoss,
    stressedCumulativeYield,
    survivable,
    survivalFloor,
    reason,
  };
}

/** Compound a daily/interval basis series into per-interval basisMove fractions. */
export function deriveBasisMoves(
  spotCloses: readonly number[],
  perpCloses: readonly number[],
): number[] {
  const n = Math.min(spotCloses.length, perpCloses.length);
  const moves: number[] = [];
  let prevBasis = 0;
  for (let i = 0; i < n; i += 1) {
    const spot = spotCloses[i]!;
    const perp = perpCloses[i]!;
    const basis = spot > 0 ? (perp - spot) / spot : 0;
    moves.push(i === 0 ? 0 : basis - prevBasis);
    prevBasis = basis;
  }
  return moves;
}

function clampReturn(value: number): number {
  // Guard log1p against <= -100% interval returns (a single fee/funding step
  // can never wipe the whole book, but keep the accumulator finite).
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0.999999, value);
}

function meanStd(values: readonly number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (values.length < 2) return { mean, stdDev: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stdDev: Math.sqrt(Math.max(0, variance)) };
}

function maxDrawdownFromReturns(returns: readonly number[]): number {
  let logEquity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of returns) {
    logEquity += Math.log1p(clampReturn(r));
    if (logEquity > peak) peak = logEquity;
    const dd = 1 - Math.exp(logEquity - peak); // fractional drawdown from peak
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}
