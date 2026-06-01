/**
 * Time-series momentum / trend rules (Experiment 3, documented-rule baseline).
 *
 * The classic, widely-documented low-turnover trend rules:
 *   (a) Time-series momentum (Moskowitz, Ooi & Pedersen 2012): go long when the
 *       trailing L-period return is positive, otherwise flat (long-flat) or short
 *       (long-short).
 *   (b) Moving-average crossover (the oldest documented technical rule; Brock,
 *       Lakonishok & LeBaron 1992): go long when a fast SMA is above a slow SMA,
 *       otherwise flat / short.
 *
 * These are PURE and strictly CAUSAL: the position taken for bar t is decided
 * using information available at the close of bar t-1 (returns/closes up to and
 * including t-1). The realized per-bar return is therefore
 *     pnl(t) = position(t-1) * ret(t) - cost on any change in position,
 * where ret(t) = (close[t] - close[t-1]) / close[t-1]. A round-trip cost is
 * charged proportional to the absolute change in position (|pos(t)-pos(t-1)|),
 * so a flat->long entry costs half a round trip and a long->short flip costs a
 * full round trip. Turnover is logged so the low daily/weekly frequency is visible.
 *
 * No I/O, no randomness, deterministic.
 */

export type TrendSide = "long-flat" | "long-short";

export interface TrendRuleResult {
  /** Position held into each bar (length = closes.length). position[t] is held over bar t->t+1. */
  positions: number[];
  /** Net per-bar strategy return (position(t-1)*ret(t) - cost). Aligned to bars 1..n-1. */
  netReturns: number[];
  /** Gross per-bar strategy return (no cost). */
  grossReturns: number[];
  /** Per-bar buy&hold return ret(t), aligned identically (the benchmark). */
  marketReturns: number[];
  /** Number of position changes (entries, exits, flips) charged a cost. */
  tradeCount: number;
  /** Sum of |Δposition| across the series — the turnover the cost is applied to. */
  totalTurnover: number;
  /** Fraction of bars spent with a non-zero position (exposure). */
  exposure: number;
  /** Average holding length in bars per trade (totalBars*exposure / tradeCount). */
  avgHoldingBars: number;
  /** Round-trip cost fraction used. */
  roundTripCost: number;
}

function ret(prev: number, curr: number): number {
  return prev > 0 ? (curr - prev) / prev : 0;
}

/**
 * Core engine shared by both rules: given a per-bar desired position signal
 * (decided causally from data up to t-1) and the close series, produce the
 * net/gross/market return streams, turnover and trade count.
 *
 * `desiredPosition[t]` is the position to HOLD over the interval (t-1 -> t),
 * i.e. it must have been decided at the close of bar t-1. desiredPosition[0] is
 * forced to 0 (no prior information). The cost is charged at the bar where the
 * position changes, proportional to |Δposition| * (roundTripCost / 2) per side
 * — so a full round-trip (enter then exit) pays `roundTripCost` total.
 */
function runPositions(
  closes: readonly number[],
  desiredPosition: readonly number[],
  roundTripCost: number,
): TrendRuleResult {
  const n = closes.length;
  const positions: number[] = new Array(n).fill(0);
  const netReturns: number[] = [];
  const grossReturns: number[] = [];
  const marketReturns: number[] = [];
  const costPerSide = Math.max(0, roundTripCost) / 2;

  let tradeCount = 0;
  let totalTurnover = 0;
  let exposedBars = 0;

  let prevPos = 0;
  for (let t = 0; t < n; t += 1) {
    const pos = t === 0 ? 0 : (desiredPosition[t] ?? 0);
    positions[t] = pos;
    if (t === 0) {
      prevPos = 0;
      continue;
    }
    const r = ret(closes[t - 1]!, closes[t]!);
    const gross = prevPos * r;
    const turnover = Math.abs(pos - prevPos);
    if (turnover > 0) {
      tradeCount += 1;
      totalTurnover += turnover;
    }
    const cost = turnover * costPerSide;
    grossReturns.push(gross);
    netReturns.push(gross - cost);
    marketReturns.push(r);
    if (prevPos !== 0) exposedBars += 1;
    prevPos = pos;
  }

  const bars = Math.max(1, n - 1);
  const exposure = exposedBars / bars;
  // Each round trip = ~2 turnover units; holding bars per trade ~ exposed bars / round trips.
  const roundTrips = Math.max(1, totalTurnover / 2);
  const avgHoldingBars = exposedBars / roundTrips;

  return {
    positions,
    netReturns,
    grossReturns,
    marketReturns,
    tradeCount,
    totalTurnover,
    exposure,
    avgHoldingBars,
    roundTripCost: Math.max(0, roundTripCost),
  };
}

export interface TimeSeriesMomentumInput {
  closes: readonly number[];
  /** Lookback in bars for the trailing return sign. */
  lookback: number;
  /** long-flat (default) or long-short. */
  side?: TrendSide;
  /** Round-trip cost fraction (e.g. 0.0028). */
  roundTripCost?: number;
}

/**
 * (a) Time-series momentum: at the close of bar t-1, look at the trailing
 * `lookback`-bar return r_{t-1} = close[t-1]/close[t-1-L] - 1. If r > 0 hold long
 * over bar t; else flat (long-flat) or short (long-short). Strictly causal.
 */
export function timeSeriesMomentum(input: TimeSeriesMomentumInput): TrendRuleResult {
  const closes = input.closes;
  const L = Math.max(1, Math.floor(input.lookback));
  const side = input.side ?? "long-flat";
  const roundTripCost = input.roundTripCost ?? 0.0028;
  const n = closes.length;
  const desired: number[] = new Array(n).fill(0);

  for (let t = 1; t < n; t += 1) {
    // decision uses data up to bar t-1 (inclusive): trailing L-bar return ending at t-1.
    const base = t - 1 - L;
    if (base < 0) {
      desired[t] = 0; // not enough history yet -> flat
      continue;
    }
    const trailing = ret(closes[base]!, closes[t - 1]!);
    if (trailing > 0) {
      desired[t] = 1;
    } else if (trailing < 0) {
      desired[t] = side === "long-short" ? -1 : 0;
    } else {
      desired[t] = 0;
    }
  }

  return runPositions(closes, desired, roundTripCost);
}

export interface MovingAverageCrossoverInput {
  closes: readonly number[];
  fast: number;
  slow: number;
  side?: TrendSide;
  roundTripCost?: number;
}

/** Trailing simple moving average of `window` closes ending at index `end` (inclusive). */
function sma(closes: readonly number[], end: number, window: number): number | null {
  const start = end - window + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= end; i += 1) sum += closes[i]!;
  return sum / window;
}

/**
 * (b) Moving-average crossover: at the close of bar t-1, compute the fast and slow
 * trailing SMAs ending at t-1. If fast > slow hold long over bar t; else flat /
 * short. Strictly causal (both SMAs use only closes up to t-1).
 */
export function movingAverageCrossover(input: MovingAverageCrossoverInput): TrendRuleResult {
  const closes = input.closes;
  const fast = Math.max(1, Math.floor(input.fast));
  const slow = Math.max(fast + 1, Math.floor(input.slow));
  const side = input.side ?? "long-flat";
  const roundTripCost = input.roundTripCost ?? 0.0028;
  const n = closes.length;
  const desired: number[] = new Array(n).fill(0);

  for (let t = 1; t < n; t += 1) {
    const fastMa = sma(closes, t - 1, fast);
    const slowMa = sma(closes, t - 1, slow);
    if (fastMa === null || slowMa === null) {
      desired[t] = 0;
      continue;
    }
    if (fastMa > slowMa) {
      desired[t] = 1;
    } else if (fastMa < slowMa) {
      desired[t] = side === "long-short" ? -1 : 0;
    } else {
      desired[t] = 0;
    }
  }

  return runPositions(closes, desired, roundTripCost);
}

/** Per-bar buy&hold returns (close-to-close) for a close series — the benchmark. */
export function buyAndHoldReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) out.push(ret(closes[i - 1]!, closes[i]!));
  return out;
}

/** Compound a per-bar return series into a single net return fraction. */
export function compound(returns: readonly number[]): number {
  let log = 0;
  for (const r of returns) {
    if (r <= -1) return -1;
    log += Math.log1p(r);
  }
  return Math.expm1(log);
}
