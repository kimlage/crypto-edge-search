/**
 * Turnover-aware, cost-in-the-score selection (roadmap B5).
 *
 * Costs scale linearly with frequency (~28 bps/round-trip × up to 96 candles/day on
 * 15m). The technical-rules-in-crypto literature repeatedly finds break-even costs
 * BELOW real costs: gross-profitable, net-negative. The fix is to put the cost
 * INSIDE the selection objective (not just the backtest) so the search is pushed
 * toward lower-turnover, higher-net-edge-per-trade strategies, plus a minimum-holding
 * gate that blocks churn.
 *
 * Pure and deterministic.
 */

export interface NetEdgeInput {
  /** Gross compound return over the window (before costs), as a fraction. */
  grossReturn: number;
  tradeCount: number;
  /** Net round-trip cost as a fraction (e.g. 0.0028 for 28 bps). */
  roundTripCost: number;
}

export interface NetEdge {
  grossReturn: number;
  tradeCount: number;
  totalCost: number;
  netReturn: number;
  /** Net return divided by the number of trades — the per-trade edge that must clear costs. */
  netEdgePerTrade: number;
  /** Gross edge per trade before costs. */
  grossEdgePerTrade: number;
  /** True when the average gross move per trade exceeds the round-trip cost. */
  edgeBeatsCost: boolean;
}

/** Net-of-cost edge with the per-trade view that exposes whether the edge clears costs. */
export function computeNetEdge(input: NetEdgeInput): NetEdge {
  const tradeCount = Math.max(0, Math.floor(input.tradeCount));
  const roundTripCost = Math.max(0, input.roundTripCost);
  const totalCost = tradeCount * roundTripCost;
  const netReturn = input.grossReturn - totalCost;
  const grossEdgePerTrade = tradeCount > 0 ? input.grossReturn / tradeCount : 0;
  const netEdgePerTrade = tradeCount > 0 ? netReturn / tradeCount : 0;
  return {
    grossReturn: input.grossReturn,
    tradeCount,
    totalCost,
    netReturn,
    netEdgePerTrade,
    grossEdgePerTrade,
    edgeBeatsCost: tradeCount > 0 && grossEdgePerTrade > roundTripCost,
  };
}

export interface TurnoverPenaltyInput {
  tradeCount: number;
  /** Total bars in the evaluated window. */
  totalBars: number;
  roundTripCost: number;
  /** Penalty weight on the cost drag. Default 1. */
  weight?: number;
}

/**
 * Turnover penalty for the selection score: the expected cost drag per bar, scaled.
 * Higher trade frequency ⇒ larger drag ⇒ larger penalty, independent of whether the
 * backtest already charged costs (it makes the search *prefer* low turnover).
 */
export function turnoverPenalty(input: TurnoverPenaltyInput): number {
  const tradeCount = Math.max(0, Math.floor(input.tradeCount));
  const totalBars = Math.max(1, Math.floor(input.totalBars));
  const roundTripCost = Math.max(0, input.roundTripCost);
  const weight = input.weight ?? 1;
  const costDrag = (tradeCount * roundTripCost) / totalBars; // cost per bar
  return costDrag * weight;
}

export interface MinHoldingGate {
  passed: boolean;
  avgHoldingBars: number;
  minHoldingBars: number;
  reason: string;
}

/** Block churn: the average holding period must reach `minHoldingBars`. */
export function minHoldingGate(avgHoldingBars: number, minHoldingBars: number): MinHoldingGate {
  const avg = Number.isFinite(avgHoldingBars) ? Math.max(0, avgHoldingBars) : 0;
  const min = Math.max(0, minHoldingBars);
  const passed = avg >= min;
  return {
    passed,
    avgHoldingBars: avg,
    minHoldingBars: min,
    reason: passed ? "ok" : "below_min_holding_churn",
  };
}

export interface CostAwareScoreInput {
  /** A base selection score (e.g. a Sharpe-like figure) computed elsewhere. */
  baseScore: number;
  grossReturn: number;
  tradeCount: number;
  totalBars: number;
  roundTripCost: number;
  avgHoldingBars: number;
  minHoldingBars?: number;
  /** Penalty weight on turnover cost drag. Default 50 (drag is small per bar). */
  turnoverWeight?: number;
  /** Penalty applied when the min-holding gate fails. Default 1. */
  churnPenalty?: number;
}

export interface CostAwareScore {
  baseScore: number;
  netEdge: NetEdge;
  turnoverPenalty: number;
  churnPenalty: number;
  minHolding: MinHoldingGate;
  /** Selection score with cost drag and churn folded in. */
  score: number;
}

/**
 * Fold cost and turnover INTO the selection score: subtract the turnover cost-drag and
 * a churn penalty when the strategy holds for less than `minHoldingBars`. This is the
 * B5 operationalization — the GA optimizes a net-of-cost, low-turnover objective rather
 * than relying on the backtest cost accounting alone.
 */
export function costAwareSelectionScore(input: CostAwareScoreInput): CostAwareScore {
  const netEdge = computeNetEdge({
    grossReturn: input.grossReturn,
    tradeCount: input.tradeCount,
    roundTripCost: input.roundTripCost,
  });
  const penalty = turnoverPenalty({
    tradeCount: input.tradeCount,
    totalBars: input.totalBars,
    roundTripCost: input.roundTripCost,
    weight: input.turnoverWeight ?? 50,
  });
  const minHolding = minHoldingGate(input.avgHoldingBars, input.minHoldingBars ?? 0);
  const churnPenalty = minHolding.passed ? 0 : input.churnPenalty ?? 1;

  return {
    baseScore: input.baseScore,
    netEdge,
    turnoverPenalty: penalty,
    churnPenalty,
    minHolding,
    score: input.baseScore - penalty - churnPenalty,
  };
}
