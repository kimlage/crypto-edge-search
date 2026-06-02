/**
 * Bracket-on-surrogate null for path-dependent exits (TP / SL / time stop).
 *
 * A take-profit / stop-loss / max-hold "bracket" strategy has a P&L that depends on
 * the ORDER of returns inside each trade, not just their marginal — so the right null
 * is NOT a return-shuffle scored on the marginal. Instead we:
 *
 *   1. build a surrogate RETURNS series that preserves the linear/temporal structure
 *      a bracket actually feeds on (phase-randomization keeps the autocorrelation &
 *      variance; block-bootstrap keeps short-range runs), then
 *   2. compound it into a surrogate PRICE path, and
 *   3. apply the EXACT SAME bracket logic to the surrogate path.
 *
 * If the real bracketed P&L is not distinguishable from this surrogate distribution,
 * the "edge" was an artifact of the exit geometry interacting with ordinary price
 * dynamics, not a genuine signal.
 *
 * The surrogate returns come from the approved generators in
 * ../validation/strategy-validator (`phaseRandomize`, `blockBootstrap`) — never
 * reimplemented here. Pure & deterministic given the seeded `random`.
 */

import { phaseRandomize, blockBootstrap } from "../validation/strategy-validator";

export interface BracketSpec {
  /** Fractional take-profit, e.g. 0.05 = +5% from entry closes the trade in profit. */
  takeProfit: number;
  /** Fractional stop-loss as a POSITIVE magnitude, e.g. 0.03 = -3% from entry. */
  stopLoss: number;
  /** Max holding period in steps before a forced time exit. */
  maxHold: number;
}

export interface BracketTrade {
  /** Step index where the trade was entered. */
  entry: number;
  /** Step index where the trade exited. */
  exit: number;
  /** Realized fractional P&L of the trade. */
  pnl: number;
  /** Which leg closed the trade. */
  reason: "takeProfit" | "stopLoss" | "time";
}

export interface BracketOutcome {
  /** Every trade taken when the bracket is applied back-to-back along the path. */
  trades: BracketTrade[];
  /** Sum of trade P&Ls (the bracketed strategy's total fractional return). */
  totalPnl: number;
}

export type ReturnsSurrogateKind = "phase" | "block";

export interface BracketSurrogateOptions {
  /** Number of surrogate paths to generate. Default 200. */
  count?: number;
  /** Which approved returns surrogate to use. Default "phase". */
  kind?: ReturnsSurrogateKind;
  /** Block length for the "block" surrogate. Default ~sqrt(n). */
  blockLength?: number;
  /** Starting price for the compounded path. Default 1. */
  startPrice?: number;
}

export interface BracketSurrogateResult {
  /** The bracket outcome on the REAL returns path. */
  real: BracketOutcome;
  /** Total bracketed P&L on each surrogate path. */
  surrogateTotals: number[];
  /** Full bracket outcome on each surrogate path. */
  surrogateOutcomes: BracketOutcome[];
  /**
   * One-sided right-tail p-value: P(surrogate total >= real total), with the +1/+1
   * finite-sample correction. Small ⇒ the real bracketed P&L beats the null.
   */
  p: number;
}

/**
 * Compound a fractional-returns series into a price path of length `returns.length+1`,
 * starting at `startPrice`. price_{t+1} = price_t * (1 + r_t).
 */
export function pricePathFromReturns(
  returns: readonly number[],
  startPrice = 1,
): number[] {
  const path = new Array<number>(returns.length + 1);
  path[0] = startPrice;
  for (let t = 0; t < returns.length; t += 1) {
    path[t + 1] = path[t]! * (1 + returns[t]!);
  }
  return path;
}

/**
 * Apply the bracket logic along a price path: open a trade at each step that is not
 * already inside a trade, then close it on the FIRST of take-profit, stop-loss, or
 * max-hold. Long-only, one position at a time, re-entering on the step after an exit.
 * This is the single source of truth for the bracket — used identically on the real
 * and surrogate paths.
 */
export function applyBracket(path: readonly number[], spec: BracketSpec): BracketOutcome {
  const trades: BracketTrade[] = [];
  const tp = spec.takeProfit;
  const sl = spec.stopLoss;
  const maxHold = Math.max(1, Math.floor(spec.maxHold));

  let i = 0;
  while (i < path.length - 1) {
    const entryPrice = path[i]!;
    let exit = i;
    let reason: BracketTrade["reason"] = "time";
    let pnl = 0;
    const hardStop = Math.min(path.length - 1, i + maxHold);
    for (let j = i + 1; j <= hardStop; j += 1) {
      const ret = entryPrice !== 0 ? path[j]! / entryPrice - 1 : 0;
      if (ret >= tp) {
        exit = j;
        reason = "takeProfit";
        pnl = ret;
        break;
      }
      if (ret <= -sl) {
        exit = j;
        reason = "stopLoss";
        pnl = ret;
        break;
      }
      if (j === hardStop) {
        exit = j;
        reason = "time";
        pnl = ret;
      }
    }
    trades.push({ entry: i, exit, pnl, reason });
    // Re-enter on the bar after the exit (no overlapping positions).
    i = exit + 1;
  }

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  return { trades, totalPnl };
}

/**
 * Build a returns-surrogate distribution of the bracketed P&L and compare it to the
 * real bracketed P&L. The SAME `applyBracket` runs on the real path and on every
 * surrogate path, so the only thing that changes is the return dynamics.
 */
export function bracketOnSurrogate(
  returns: readonly number[],
  spec: BracketSpec,
  random: () => number,
  options: BracketSurrogateOptions = {},
): BracketSurrogateResult {
  const count = Math.max(1, Math.floor(options.count ?? 200));
  const kind = options.kind ?? "phase";
  const startPrice = options.startPrice ?? 1;
  const blockLength =
    options.blockLength ?? Math.max(2, Math.round(Math.sqrt(returns.length)));

  const realPath = pricePathFromReturns(returns, startPrice);
  const real = applyBracket(realPath, spec);

  const surrogateTotals: number[] = [];
  const surrogateOutcomes: BracketOutcome[] = [];
  for (let s = 0; s < count; s += 1) {
    const surrReturns =
      kind === "block"
        ? blockBootstrap(returns, blockLength, random)
        : phaseRandomize(returns, random);
    const surrPath = pricePathFromReturns(surrReturns, startPrice);
    const outcome = applyBracket(surrPath, spec);
    surrogateOutcomes.push(outcome);
    surrogateTotals.push(outcome.totalPnl);
  }

  // Right-tail p with the standard +1 finite-sample correction.
  const atLeast = surrogateTotals.filter((v) => v >= real.totalPnl).length;
  const p = (atLeast + 1) / (count + 1);

  return { real, surrogateTotals, surrogateOutcomes, p };
}
