/**
 * Haircut Sharpe Ratio (roadmap A5) — Harvey & Liu (2015), "Backtesting", JPM.
 *
 * After a multiple-testing search, an observed Sharpe overstates the truth. The
 * haircut is the fraction of the Sharpe that survives once the p-value is adjusted
 * for the number of trials. Three adjustments are offered, matching the Harvey-Liu
 * tool: Bonferroni (harshest), Holm (stepwise FWER), and Benjamini-Hochberg-Yekutieli
 * (BHY, FDR — most lenient). The haircut Sharpe is the Sharpe whose two-sided
 * p-value equals the adjusted p-value.
 *
 * Pure; reuses the canonical normalCdf/inverseNormalCdf primitives.
 */

import { inverseNormalCdf, normalCdf } from "../statistical-validation";

export type HaircutMethod = "bonferroni" | "holm" | "bhy";

export interface HaircutInput {
  /** Observed (per-observation) Sharpe of the selected strategy. */
  observedSharpe: number;
  /** Number of observations the Sharpe was estimated on. */
  sampleCount: number;
  /** Number of independent trials/tests in the search (true N). */
  trialCount: number;
  method?: HaircutMethod;
}

export interface HaircutResult {
  method: HaircutMethod;
  observedSharpe: number;
  /** Two-sided p-value of the observed Sharpe (single test). */
  pValue: number;
  /** p-value after the multiple-testing adjustment. */
  adjustedPValue: number;
  /** The Sharpe implied by the adjusted p-value (the "haircut" Sharpe). */
  haircutSharpe: number;
  /** Fraction of the Sharpe lost to multiple testing, in [0, 1]. */
  haircut: number;
}

const SQRT_EPSILON = 1e-9;

/** Two-sided p-value of a per-observation Sharpe over `n` observations (t = S·√n). */
export function sharpePValue(observedSharpe: number, sampleCount: number): number {
  const n = Math.max(0, Math.floor(sampleCount));
  if (n < 2) return 1;
  const t = observedSharpe * Math.sqrt(n);
  return clamp01(2 * (1 - normalCdf(Math.abs(t))));
}

/**
 * Haircut a single (selected/best) Sharpe for the multiple-testing context. For the
 * most-significant strategy, Holm coincides with Bonferroni (p·N); BHY scales the
 * Bonferroni factor by 1/c(N) with c(N)=Σ 1/i, so it is more lenient.
 */
export function haircutSharpe(input: HaircutInput): HaircutResult {
  const method = input.method ?? "bonferroni";
  const sampleCount = Math.max(0, Math.floor(input.sampleCount));
  const trialCount = Math.max(1, Math.floor(input.trialCount));
  const observedSharpe = Number.isFinite(input.observedSharpe) ? input.observedSharpe : 0;
  const pValue = sharpePValue(observedSharpe, sampleCount);

  let adjustedPValue: number;
  if (method === "bhy") {
    // BHY at the top rank: p_adj = p · c(N), where c(N) = Σ_{i=1}^N 1/i
    adjustedPValue = clamp01(pValue * harmonic(trialCount));
  } else {
    // Bonferroni and Holm coincide for the single most-significant test.
    adjustedPValue = clamp01(pValue * trialCount);
  }

  const haircutSharpeValue = sharpeFromPValue(adjustedPValue, sampleCount, observedSharpe);
  const haircut =
    Math.abs(observedSharpe) > SQRT_EPSILON
      ? clamp01(1 - haircutSharpeValue / observedSharpe)
      : 0;

  return {
    method,
    observedSharpe,
    pValue,
    adjustedPValue,
    haircutSharpe: haircutSharpeValue,
    haircut,
  };
}

export interface HaircutStrategy {
  id: string;
  observedSharpe: number;
  sampleCount: number;
}

export interface HaircutStrategyResult extends HaircutResult {
  id: string;
  rank: number;
  significant: boolean;
}

/**
 * Haircut a whole panel of strategies with a proper stepwise (Holm) or FDR (BHY)
 * procedure across the set, ranking by significance. `alpha` flags survivors.
 */
export function haircutSharpePanel(
  strategies: readonly HaircutStrategy[],
  options: { method?: HaircutMethod; alpha?: number } = {},
): HaircutStrategyResult[] {
  const method = options.method ?? "holm";
  const alpha = clamp01(options.alpha ?? 0.05);
  const n = strategies.length;
  if (n === 0) return [];

  const withP = strategies.map((strategy) => ({
    strategy,
    pValue: sharpePValue(strategy.observedSharpe, strategy.sampleCount),
  }));
  // ascending p-value = most significant first
  withP.sort((left, right) => left.pValue - right.pValue || left.strategy.id.localeCompare(right.strategy.id));

  const cN = harmonic(n);
  const results: HaircutStrategyResult[] = [];
  let holmStillRejecting = true;

  withP.forEach((entry, index) => {
    const rank = index + 1; // 1-based
    let adjustedPValue: number;
    let threshold: number;
    if (method === "bhy") {
      adjustedPValue = clamp01(entry.pValue * n * cN / rank);
      threshold = (rank * alpha) / (n * cN);
    } else {
      // Holm: adjusted p = (N - rank + 1) · p; reject while below alpha in order
      adjustedPValue = clamp01((n - rank + 1) * entry.pValue);
      threshold = alpha / (n - rank + 1);
    }

    let significant: boolean;
    if (method === "holm") {
      significant = holmStillRejecting && entry.pValue <= threshold;
      if (!significant) holmStillRejecting = false;
    } else {
      significant = entry.pValue <= threshold;
    }

    const haircutSharpeValue = sharpeFromPValue(
      adjustedPValue,
      entry.strategy.sampleCount,
      entry.strategy.observedSharpe,
    );
    const haircut =
      Math.abs(entry.strategy.observedSharpe) > SQRT_EPSILON
        ? clamp01(1 - haircutSharpeValue / entry.strategy.observedSharpe)
        : 0;

    results.push({
      id: entry.strategy.id,
      rank,
      method,
      observedSharpe: entry.strategy.observedSharpe,
      pValue: entry.pValue,
      adjustedPValue,
      haircutSharpe: haircutSharpeValue,
      haircut,
      significant,
    });
  });

  return results;
}

function sharpeFromPValue(pValue: number, sampleCount: number, observedSharpe: number): number {
  const n = Math.max(0, Math.floor(sampleCount));
  if (n < 2) return 0;
  if (pValue >= 1) return 0;
  // invert the two-sided p-value to a t-stat, then to a Sharpe; keep the original sign.
  const t = inverseNormalCdf(1 - pValue / 2);
  const magnitude = t / Math.sqrt(n);
  return observedSharpe < 0 ? -magnitude : magnitude;
}

function harmonic(n: number): number {
  let sum = 0;
  for (let i = 1; i <= n; i += 1) sum += 1 / i;
  return sum;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
