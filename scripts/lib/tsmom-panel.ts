/**
 * TARGET 4 — Time-Series MOMentum with vol-targeting across a multi-coin panel
 * (Moskowitz, Ooi & Pedersen 2012, "Time Series Momentum").
 *
 * Novel pure helper (logic not present in the shared cores). It is intentionally
 * transparent and CAUSAL: the position held over day t uses ONLY information
 * observable at the close of day t-1 (the trailing L-day return and the trailing
 * realised volatility, both ending at t-1). The position is the sign of the
 * trailing return, scaled so each coin contributes a constant ex-ante volatility
 * (vol-targeting), then averaged across all coins that have enough history at t.
 *
 * Distinct from a single-asset long-flat momentum (E3): this can go SHORT, it
 * vol-targets every leg, and it diversifies across the whole panel.
 *
 * No I/O, no randomness, deterministic.
 */

export interface TsmomConfig {
  /** Look-back horizon L in days for the momentum sign (trailing return). */
  lookbackDays: number;
  /** Window in days for the trailing realised-vol estimate used to vol-target. */
  volWindowDays: number;
  /** Per-leg annualised target volatility (e.g. 0.40 = 40%/yr per coin). */
  targetAnnualVol: number;
  /** Round-trip cost charged per unit of |position| turned over, as a fraction. */
  roundTripCost: number;
  /** Cap on a single coin's |scaled weight| to avoid blow-ups when vol is tiny. */
  maxLegWeight: number;
}

export interface TsmomResult {
  /** Net-of-cost daily portfolio returns, one per active day (length = T_active). */
  dailyNet: number[];
  /** Gross daily portfolio returns (no cost) aligned with dailyNet. */
  dailyGross: number[];
  /** Cost charged each active day (>= 0), aligned with dailyNet. */
  dailyCost: number[];
  /** Dates aligned with dailyNet. */
  dates: string[];
  /** Average number of coins live on each active day. */
  avgBreadth: number;
  /** Average daily turnover: mean over days of sum_i |w_{i,t} - w_{i,t-1}|. */
  avgDailyTurnover: number;
  /** Total number of active days. */
  activeDays: number;
}

const TRADING_DAYS_PER_YEAR = 365; // crypto trades every calendar day

/** Daily simple returns from a close series, with nulls preserved as NaN gaps. */
export function closesToDaily(closes: readonly (number | null)[]): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev != null && cur != null && prev > 0 && cur > 0) {
      out[i] = cur / prev - 1;
    }
  }
  return out;
}

/**
 * Run the diversified TSMOM portfolio over a panel.
 *
 * @param closesByCoin  coin -> aligned daily close array (nulls before listing).
 * @param dates         aligned date labels (same length as each close array).
 * @param startIndex    first index (inclusive) of the evaluation window.
 * @param endIndex      one-past-last index (exclusive) of the evaluation window.
 */
export function runTsmomPanel(args: {
  closesByCoin: Record<string, readonly (number | null)[]>;
  dates: readonly string[];
  config: TsmomConfig;
  startIndex: number;
  endIndex: number;
}): TsmomResult {
  const { closesByCoin, dates, config } = args;
  const coins = Object.keys(closesByCoin);
  const T = dates.length;
  const start = Math.max(1, Math.floor(args.startIndex));
  const end = Math.min(T, Math.floor(args.endIndex));

  // Precompute daily returns per coin.
  const dailyByCoin: Record<string, number[]> = {};
  for (const coin of coins) dailyByCoin[coin] = closesToDaily(closesByCoin[coin]);

  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  const dailyCost: number[] = [];
  const outDates: string[] = [];
  let breadthSum = 0;
  let turnoverSum = 0;

  // Previous-day weight per coin (for turnover/cost). Persisted across days.
  const prevWeight: Record<string, number> = {};
  for (const coin of coins) prevWeight[coin] = 0;

  const volScale = config.targetAnnualVol / Math.sqrt(TRADING_DAYS_PER_YEAR);

  for (let t = start; t < end; t += 1) {
    // --- Build CAUSAL weights using data ending at t-1 ---
    const weights: Record<string, number> = {};
    let liveCount = 0;
    for (const coin of coins) {
      weights[coin] = 0;
      const daily = dailyByCoin[coin];

      // Trailing L-day return ending at t-1: need close at t-1 and t-1-L.
      const iNow = t - 1;
      const iPast = t - 1 - config.lookbackDays;
      const closes = closesByCoin[coin];
      if (iPast < 0) continue;
      const cNow = closes[iNow];
      const cPast = closes[iPast];
      if (cNow == null || cPast == null || cPast <= 0 || cNow <= 0) continue;
      const trailingReturn = cNow / cPast - 1;
      const sign = trailingReturn > 0 ? 1 : trailingReturn < 0 ? -1 : 0;
      if (sign === 0) continue;

      // Trailing realised daily vol over volWindowDays ending at t-1.
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let k = t - config.volWindowDays; k <= t - 1; k += 1) {
        if (k < 1) continue;
        const r = daily[k];
        if (Number.isFinite(r)) {
          sum += r;
          sumSq += r * r;
          n += 1;
        }
      }
      // Require a reasonably full vol window so the target is meaningful.
      if (n < Math.ceil(config.volWindowDays * 0.6)) continue;
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      const dailyVol = Math.sqrt(variance);
      if (!(dailyVol > 0)) continue;

      let w = (sign * volScale) / dailyVol;
      // Cap leg weight.
      if (w > config.maxLegWeight) w = config.maxLegWeight;
      if (w < -config.maxLegWeight) w = -config.maxLegWeight;
      weights[coin] = w;
      liveCount += 1;
    }

    if (liveCount === 0) {
      // No live legs: flat day, but still pay to unwind any prior book.
      let turnover = 0;
      for (const coin of coins) {
        turnover += Math.abs(0 - prevWeight[coin]);
        prevWeight[coin] = 0;
      }
      const cost = turnover * config.roundTripCost;
      // A fully-flat day with no realised P&L; only cost if we unwound.
      if (cost !== 0) {
        dailyGross.push(0);
        dailyCost.push(cost);
        dailyNet.push(-cost);
        outDates.push(dates[t]);
        turnoverSum += turnover;
      }
      continue;
    }

    // Diversify: average across live legs (equal capital per live coin).
    // gross_t = sum_i (w_i / liveCount) * r_{i,t}
    let gross = 0;
    let turnover = 0;
    for (const coin of coins) {
      const wScaled = weights[coin] / liveCount;
      const r = dailyByCoin[coin][t];
      if (Number.isFinite(r)) gross += wScaled * r;
      turnover += Math.abs(wScaled - prevWeight[coin]);
      prevWeight[coin] = wScaled;
    }
    const cost = turnover * config.roundTripCost;
    const net = gross - cost;

    dailyGross.push(gross);
    dailyCost.push(cost);
    dailyNet.push(net);
    outDates.push(dates[t]);
    breadthSum += liveCount;
    turnoverSum += turnover;
  }

  const activeDays = dailyNet.length;
  return {
    dailyNet,
    dailyGross,
    dailyCost,
    dates: outDates,
    avgBreadth: activeDays > 0 ? breadthSum / activeDays : 0,
    avgDailyTurnover: activeDays > 0 ? turnoverSum / activeDays : 0,
    activeDays,
  };
}

/** Compound a daily return series into a total multiplicative return. */
export function compound(returns: readonly number[]): number {
  let acc = 1;
  for (const r of returns) if (Number.isFinite(r)) acc *= 1 + r;
  return acc - 1;
}

/** Annualised return (CAGR) from a daily series. */
export function annualizedReturn(dailyReturns: readonly number[]): number {
  const n = dailyReturns.filter((r) => Number.isFinite(r)).length;
  if (n === 0) return 0;
  const total = compound(dailyReturns);
  const years = n / TRADING_DAYS_PER_YEAR;
  if (years <= 0) return 0;
  return Math.pow(1 + total, 1 / years) - 1;
}

/** Annualised Sharpe (rf=0) from a daily series. */
export function annualizedSharpe(dailyReturns: readonly number[]): number {
  const vals = dailyReturns.filter((r) => Number.isFinite(r));
  if (vals.length < 2) return 0;
  const mean = vals.reduce((s, r) => s + r, 0) / vals.length;
  const variance =
    vals.reduce((s, r) => s + (r - mean) ** 2, 0) / (vals.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return 0;
  return (mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Max drawdown (as a positive fraction) of the equity curve of a daily series. */
export function maxDrawdown(dailyReturns: readonly number[]): number {
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of dailyReturns) {
    if (!Number.isFinite(r)) continue;
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? 1 - equity / peak : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}
