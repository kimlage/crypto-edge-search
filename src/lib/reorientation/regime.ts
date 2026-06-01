/**
 * Causal regime classification (roadmap B4).
 *
 * Direction is hard to predict in BTC 15m, but volatility regimes are more
 * persistent and predictable (Bariviera 2017; regime-switching literature). Labeling
 * each bar by trailing trend × trailing volatility gives a gating signal: only trade
 * the regimes where an edge has been observed. Strictly causal — the label at bar t
 * uses only returns up to (and including) t — so it is safe as a runtime feature and
 * passes the anti-lookahead contract.
 */

export type TrendState = "up" | "down" | "flat";
export type VolState = "low" | "high";

export interface RegimeLabel {
  index: number;
  trend: TrendState;
  volatility: VolState;
  /** Combined label, e.g. "up_low", "down_high", "flat_low". */
  label: string;
  /** Trailing mean return over the trend window (null until warm). */
  trendMean: number | null;
  /** Trailing volatility over the vol window (null until warm). */
  vol: number | null;
}

export interface RegimeOptions {
  /** Window for the trailing trend mean. Default 20. */
  trendWindow?: number;
  /** Window for the trailing volatility. Default 20. */
  volWindow?: number;
  /** |trend mean| below this is "flat". Default 0 (any sign counts). */
  flatBand?: number;
}

/**
 * Classify each bar's regime causally. The volatility split ("low"/"high") compares the
 * current trailing vol to the expanding median of all prior trailing vols — no future
 * data is used, so shuffling future candles cannot change an earlier label.
 */
export function classifyRegimes(
  returns: readonly number[],
  options: RegimeOptions = {},
): RegimeLabel[] {
  const trendWindow = Math.max(1, Math.floor(options.trendWindow ?? 20));
  const volWindow = Math.max(2, Math.floor(options.volWindow ?? 20));
  const flatBand = Math.max(0, options.flatBand ?? 0);

  const labels: RegimeLabel[] = [];
  const priorVols: number[] = []; // expanding history of trailing vols (causal)

  for (let t = 0; t < returns.length; t += 1) {
    const trendMean = trailingMean(returns, t, trendWindow);
    const vol = trailingStd(returns, t, volWindow);

    let trend: TrendState = "flat";
    if (trendMean !== null) {
      if (trendMean > flatBand) trend = "up";
      else if (trendMean < -flatBand) trend = "down";
    }

    let volatility: VolState = "low";
    if (vol !== null) {
      // compare to the median of PAST trailing vols (causal); first sample defaults low
      const medianPrior = priorVols.length > 0 ? median(priorVols) : vol;
      volatility = vol > medianPrior ? "high" : "low";
      priorVols.push(vol);
    }

    labels.push({
      index: t,
      trend,
      volatility,
      label: `${trend}_${volatility}`,
      trendMean,
      vol,
    });
  }

  return labels;
}

export interface RegimeSummary {
  total: number;
  counts: Record<string, number>;
  fractions: Record<string, number>;
}

export function summarizeRegimes(labels: readonly RegimeLabel[]): RegimeSummary {
  const counts: Record<string, number> = {};
  for (const label of labels) {
    counts[label.label] = (counts[label.label] ?? 0) + 1;
  }
  const total = labels.length;
  const fractions: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    fractions[key] = total > 0 ? value / total : 0;
  }
  return { total, counts, fractions };
}

/** Gate: should the strategy operate in this regime? */
export function regimeGate(label: string, allowed: readonly string[]): boolean {
  return allowed.includes(label);
}

function trailingMean(values: readonly number[], end: number, window: number): number | null {
  const start = end - window + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= end; i += 1) sum += values[i] ?? 0;
  return sum / window;
}

function trailingStd(values: readonly number[], end: number, window: number): number | null {
  const start = end - window + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= end; i += 1) sum += values[i] ?? 0;
  const mean = sum / window;
  let variance = 0;
  for (let i = start; i <= end; i += 1) variance += ((values[i] ?? 0) - mean) ** 2;
  return Math.sqrt(variance / (window - 1));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid] ?? 0
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
