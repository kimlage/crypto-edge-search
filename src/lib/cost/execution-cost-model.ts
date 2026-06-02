/**
 * Composable, leverage-aware execution cost model.
 *
 * WHY THIS EXISTS (the motivating bug — the "dated-futures leak"):
 * -----------------------------------------------------------------
 * The legacy turnover wrapper (src/lib/reorientation/turnover.ts) only charges
 * TAKER turnover: `tradeCount * roundTripCost`. It is completely blind to the
 * *carrying* cost of a levered or short book. A dated-futures / cash-and-carry
 * style strategy finances its long leg and must pay the risk-free (or futures
 * financing) rate on the FULL notional it holds. If you (incorrectly) charge
 * that financing on ONE unit of capital while the book is actually ~2.95x
 * levered, you under-charge the carry by a factor of ~2.95 and the strategy
 * looks far better than it is. In the audit that motivated this module, exactly
 * this leak inflated a dated-futures Sharpe from a true 0.69 to a reported 1.64:
 * charging RF on 1 unit instead of on the ~2.95x-levered notional collapsed the
 * Sharpe back from 1.64 -> 0.69 once corrected.
 *
 * The lesson, hard-coded here: FINANCING AND BORROW ARE CHARGED ON THE FULL
 * LEVERED / SHORT NOTIONAL, never on 1 unit. `chargeExecutionCosts` makes the
 * leverage explicit and scales every carry component (short borrow, perp
 * funding, futures financing, risk-free on the cash/long leg, and the margin
 * haircut) by the actual gross exposure, not by 1.
 *
 * Cost components modeled (all composable; set any to 0 to disable):
 *   - takerBpsPerSide / makerBpsPerSide : execution fees per side, charged on
 *     traded notional (turnover), split between taker and maker by makerFraction.
 *   - slippageBps                       : market-impact slippage per side, on
 *     traded notional.
 *   - shortBorrowAprByVenue             : annual borrow cost to hold a SHORT,
 *     converted to a per-period rate and charged on the short notional.
 *   - perpFundingPerPeriod              : per-period perp funding paid on the
 *     net perp exposure (sign: positive = you pay).
 *   - futuresFinancingApr               : annual financing on a dated-futures /
 *     financed long leg, per-period, on the financed long notional.
 *   - riskFreeApr                       : annual risk-free carry on the cash/long
 *     leg of a levered book, per-period, on the FULL long notional. THIS is the
 *     component the dated-futures leak under-charged.
 *   - marginHaircut                     : a per-period drag proportional to the
 *     gross notional, standing in for the opportunity cost / financing of posted
 *     margin (haircut). Charged on gross exposure.
 *
 * Pure, deterministic, ESM. No I/O, no Date.now, no RNG.
 */

/** A per-side bps figure (e.g. 5 = 5 basis points = 0.0005 of notional). */
export type Bps = number;

/** Map of venue id -> annual short-borrow APR (fraction, e.g. 0.20 = 20%/yr). */
export interface ShortBorrowAprByVenue {
  [venue: string]: number;
}

export interface ExecutionCostModel {
  /** Taker fee per side, in bps of traded notional. */
  takerBpsPerSide: Bps;
  /** Maker fee per side, in bps of traded notional. */
  makerBpsPerSide: Bps;
  /**
   * Fraction of turnover executed as MAKER (0..1). The rest is taker. Default 0
   * (all taker — the conservative assumption the legacy wrapper implicitly made).
   */
  makerFraction?: number;
  /** Per-side market-impact slippage, in bps of traded notional. */
  slippageBps: Bps;
  /**
   * Annual short-borrow APR per venue. The model uses `borrowVenue` (or the
   * single entry, or the max across venues if neither is supplied) to charge the
   * SHORT notional. Empty => no borrow charge.
   */
  shortBorrowAprByVenue: ShortBorrowAprByVenue;
  /** Which venue's borrow rate to apply. If unset, see resolveShortBorrowApr. */
  borrowVenue?: string;
  /**
   * Per-PERIOD perp funding already expressed per period (NOT annual). Positive
   * means the book PAYS funding on its net perp exposure. Default 0.
   */
  perpFundingPerPeriod: number;
  /**
   * Annual financing on a dated-futures / financed long leg (fraction/yr). Charged
   * per period on the financed long notional. Default 0.
   */
  futuresFinancingApr: number;
  /**
   * Annual risk-free carry on the cash/long leg of a levered book (fraction/yr).
   * Charged per period on the FULL long notional (leverage-aware). This is the
   * component the dated-futures leak under-charged. Default 0.
   */
  riskFreeApr: number;
  /**
   * Per-period margin haircut drag as a fraction of GROSS notional (the financing
   * / opportunity cost of posted margin). Default 0.
   */
  marginHaircut: number;
}

export interface ChargeExecutionCostsInput {
  /** Gross (pre-cost) per-period returns of the strategy, as fractions. */
  grossReturns: readonly number[];
  /**
   * Per-period book composition. Either `positions` (each = signed exposure as a
   * multiple of capital, can be > 1 or < 0) OR `weights` (a basket of signed
   * weights per period that are summed/abs-summed to long/short/gross legs). If
   * both are omitted, the book is assumed flat-long at `leverage`.
   *
   * `positions[t]` is the SIGNED net exposure for period t. Its sign splits into
   * a long leg (max(pos,0)) and a short leg (max(-pos,0)). The gross is |pos|.
   */
  positions?: readonly number[];
  /**
   * Per-period basket of signed weights. weights[t] is an array; the long leg is
   * the sum of positive weights, the short leg the abs-sum of negative weights,
   * gross the sum of absolute weights. Overrides the flat assumption.
   */
  weights?: readonly (readonly number[])[];
  /**
   * Target gross leverage of the book (e.g. 2.95). When `positions`/`weights` are
   * given, they are SCALED so the average gross exposure equals `leverage`
   * (leverage is the authoritative notional multiplier). When neither is given,
   * the book is flat long at exactly `leverage`. Default 1.
   */
  leverage?: number;
  /** Periods per year, to convert annual APRs to per-period. e.g. 365, 252, 1095.75. */
  periodsPerYear: number;
  model: ExecutionCostModel;
  /**
   * Per-period TRADED notional (turnover) as a fraction of capital, for the
   * fee/slippage legs. If omitted, turnover is derived from period-over-period
   * changes in gross exposure (entries/exits), which is the honest minimum.
   */
  turnover?: readonly number[];
}

export interface PerPeriodCostBreakdown {
  /** Fee + slippage on traded notional. */
  executionCost: number;
  /** Short-borrow charge on the short notional. */
  borrowCost: number;
  /** Perp funding on net perp exposure. */
  fundingCost: number;
  /** Dated-futures financing on the financed long notional. */
  futuresFinancingCost: number;
  /** Risk-free carry on the FULL long notional (leverage-aware). */
  riskFreeCost: number;
  /** Margin haircut drag on gross notional. */
  marginHaircutCost: number;
  /** Sum of all cost components for the period. */
  totalCost: number;
  /** Gross exposure (|notional| / capital) used this period. */
  grossNotional: number;
  /** Long-leg notional used this period. */
  longNotional: number;
  /** Short-leg notional used this period. */
  shortNotional: number;
}

export interface ChargeExecutionCostsResult {
  /** Net per-period returns = gross - per-period total cost. */
  netReturns: number[];
  /** Per-period cost breakdown, aligned to `grossReturns`. */
  breakdown: PerPeriodCostBreakdown[];
  /** Total cost charged across the whole series (sum of per-period totals). */
  totalCost: number;
  /** Per-period carry charges (borrow+funding+futures+rf+haircut), summed. */
  totalCarryCost: number;
  /** Per-period execution charges (fee+slippage), summed. */
  totalExecutionCost: number;
  /** Mean gross exposure actually used (after leverage scaling). */
  meanGrossNotional: number;
}

/**
 * DEFAULT taker model: a conservative, all-taker, no-carry baseline that matches
 * what the legacy turnover wrapper effectively charged (taker turnover only) so
 * it can be dropped in as a strict superset. Borrow / funding / financing /
 * risk-free / haircut are all OFF by default — you opt INTO carry explicitly,
 * which is precisely how the leak hid (carry was never turned on against the
 * full notional).
 *
 * 5 bps/side taker is a realistic crypto spot/perp taker fee; 2 bps slippage is
 * a modest market-impact assumption.
 */
export const DEFAULT_TAKER_MODEL: ExecutionCostModel = {
  takerBpsPerSide: 5,
  makerBpsPerSide: 1,
  makerFraction: 0,
  slippageBps: 2,
  shortBorrowAprByVenue: {},
  perpFundingPerPeriod: 0,
  futuresFinancingApr: 0,
  riskFreeApr: 0,
  marginHaircut: 0,
};

const BPS = 1e-4;

/** Annual fraction -> per-period fraction (simple/linear; deterministic). */
export function aprToPerPeriod(apr: number, periodsPerYear: number): number {
  const pp = Number.isFinite(periodsPerYear) && periodsPerYear > 0 ? periodsPerYear : 1;
  const a = Number.isFinite(apr) ? apr : 0;
  return a / pp;
}

/**
 * Resolve the short-borrow APR to apply: prefer the explicitly-named
 * `borrowVenue`; else if exactly one venue is configured use it; else use the
 * MAX across venues (the conservative, leak-resistant choice — you cannot pretend
 * to borrow at the cheapest venue you do not actually have inventory at).
 */
export function resolveShortBorrowApr(model: ExecutionCostModel): number {
  const map = model.shortBorrowAprByVenue ?? {};
  const keys = Object.keys(map);
  if (model.borrowVenue && Number.isFinite(map[model.borrowVenue])) {
    return Math.max(0, map[model.borrowVenue]!);
  }
  if (keys.length === 0) return 0;
  if (keys.length === 1) return Math.max(0, num(map[keys[0]!], 0));
  let mx = 0;
  for (const k of keys) mx = Math.max(mx, num(map[k], 0));
  return mx;
}

interface Legs {
  gross: number;
  long: number;
  short: number;
}

/** Decompose a per-period book row into long/short/gross legs. */
function legsFromPositions(position: number): Legs {
  const p = Number.isFinite(position) ? position : 0;
  const long = Math.max(0, p);
  const short = Math.max(0, -p);
  return { gross: long + short, long, short };
}

function legsFromWeights(weights: readonly number[]): Legs {
  let long = 0;
  let short = 0;
  for (const w of weights) {
    if (!Number.isFinite(w)) continue;
    if (w > 0) long += w;
    else short += -w;
  }
  return { gross: long + short, long, short };
}

/**
 * Build the per-period leg series, then SCALE every leg so the mean gross
 * exposure equals `leverage` (leverage is the authoritative notional
 * multiplier). This is the core leak fix: the carry legs are sized to the FULL
 * levered notional, not to 1 unit.
 */
function buildLegs(input: ChargeExecutionCostsInput): Legs[] {
  const n = input.grossReturns.length;
  const leverage = Math.max(0, num(input.leverage, 1));
  let raw: Legs[];

  if (input.weights && input.weights.length > 0) {
    raw = Array.from({ length: n }, (_, t) =>
      legsFromWeights(input.weights![Math.min(t, input.weights!.length - 1)] ?? []),
    );
  } else if (input.positions && input.positions.length > 0) {
    raw = Array.from({ length: n }, (_, t) =>
      legsFromPositions(input.positions![Math.min(t, input.positions!.length - 1)] ?? 0),
    );
  } else {
    // No composition given: flat LONG at exactly `leverage`.
    return Array.from({ length: n }, () => ({ gross: leverage, long: leverage, short: 0 }));
  }

  // Scale so mean gross == leverage (authoritative notional multiplier).
  const meanGross = raw.reduce((s, l) => s + l.gross, 0) / Math.max(1, raw.length);
  if (meanGross <= 0) {
    return raw;
  }
  const scale = leverage / meanGross;
  return raw.map((l) => ({ gross: l.gross * scale, long: l.long * scale, short: l.short * scale }));
}

/**
 * Derive per-period traded notional (turnover) from changes in the leg sizes:
 * the L1 change in (long + short) exposure between consecutive periods. Period 0
 * pays to establish the initial gross. This is the honest minimum turnover; a
 * caller with a real fill schedule can pass `turnover` directly.
 */
function deriveTurnover(legs: readonly Legs[]): number[] {
  const out: number[] = [];
  let prevLong = 0;
  let prevShort = 0;
  for (const l of legs) {
    out.push(Math.abs(l.long - prevLong) + Math.abs(l.short - prevShort));
    prevLong = l.long;
    prevShort = l.short;
  }
  return out;
}

/**
 * Charge the full execution + carry cost stack against a gross return series,
 * with EVERY carry component sized to the full levered/short notional. Returns
 * net per-period returns plus a per-period breakdown. Pure and deterministic.
 */
export function chargeExecutionCosts(
  input: ChargeExecutionCostsInput,
): ChargeExecutionCostsResult {
  const { model } = input;
  const periodsPerYear =
    Number.isFinite(input.periodsPerYear) && input.periodsPerYear > 0
      ? input.periodsPerYear
      : 1;
  const n = input.grossReturns.length;

  const legs = buildLegs(input);
  const turnover = input.turnover
    ? Array.from({ length: n }, (_, t) =>
        Math.max(0, num(input.turnover![Math.min(t, input.turnover!.length - 1)], 0)),
      )
    : deriveTurnover(legs);

  // Per-side execution rate (fee blended taker/maker + slippage), as a fraction
  // of traded notional. Turnover already counts notional moved (one side), so we
  // charge the per-side rate once per unit of turnover.
  const makerFraction = clamp01(num(model.makerFraction, 0));
  const feeBpsPerSide =
    (1 - makerFraction) * Math.max(0, model.takerBpsPerSide) +
    makerFraction * Math.max(0, model.makerBpsPerSide);
  const execRatePerSide = (feeBpsPerSide + Math.max(0, model.slippageBps)) * BPS;

  const shortBorrowApr = resolveShortBorrowApr(model);
  const borrowPerPeriod = aprToPerPeriod(shortBorrowApr, periodsPerYear);
  const futuresFinancingPerPeriod = aprToPerPeriod(
    Math.max(0, num(model.futuresFinancingApr, 0)),
    periodsPerYear,
  );
  const riskFreePerPeriod = aprToPerPeriod(num(model.riskFreeApr, 0), periodsPerYear);
  const fundingPerPeriod = num(model.perpFundingPerPeriod, 0);
  const marginHaircut = Math.max(0, num(model.marginHaircut, 0));

  const breakdown: PerPeriodCostBreakdown[] = [];
  const netReturns: number[] = [];
  let totalCost = 0;
  let totalCarryCost = 0;
  let totalExecutionCost = 0;
  let sumGross = 0;

  for (let t = 0; t < n; t += 1) {
    const leg = legs[t]!;
    const gross = Number.isFinite(input.grossReturns[t]) ? input.grossReturns[t]! : 0;

    const executionCost = execRatePerSide * turnover[t]!;
    // Carry legs — EACH on its full levered notional:
    const borrowCost = borrowPerPeriod * leg.short;
    const futuresFinancingCost = futuresFinancingPerPeriod * leg.long;
    const riskFreeCost = riskFreePerPeriod * leg.long; // full long notional, NOT 1 unit
    // Funding is paid on the net perp exposure; use net = long - short (signed).
    const fundingCost = fundingPerPeriod * (leg.long - leg.short);
    const marginHaircutCost = marginHaircut * leg.gross;

    const periodTotal =
      executionCost +
      borrowCost +
      futuresFinancingCost +
      riskFreeCost +
      fundingCost +
      marginHaircutCost;

    breakdown.push({
      executionCost,
      borrowCost,
      fundingCost,
      futuresFinancingCost,
      riskFreeCost,
      marginHaircutCost,
      totalCost: periodTotal,
      grossNotional: leg.gross,
      longNotional: leg.long,
      shortNotional: leg.short,
    });

    netReturns.push(gross - periodTotal);
    totalCost += periodTotal;
    totalExecutionCost += executionCost;
    totalCarryCost +=
      borrowCost + futuresFinancingCost + riskFreeCost + fundingCost + marginHaircutCost;
    sumGross += leg.gross;
  }

  return {
    netReturns,
    breakdown,
    totalCost,
    totalCarryCost,
    totalExecutionCost,
    meanGrossNotional: n > 0 ? sumGross / n : 0,
  };
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
