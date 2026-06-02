/**
 * Family-wise MAX-statistic surrogate test — THE methodological addition the audit
 * forced on us. It is the single gate that flipped three "promising" leads to KILL.
 *
 * WHY THIS EXISTS (the lesson):
 *   When you SEARCH a grid of N configs and keep the best one, the per-config
 *   surrogate p-value of that winner is a LIE — it ignores that you took a maximum
 *   over N draws. The luckiest of N pure-noise configs will reliably beat its OWN
 *   single-config null at the 5% level (that is what 5% MEANS, repeated N times).
 *   The honest null is therefore the distribution of the GRID-MAXIMUM statistic
 *   under the surrogate: on each surrogate panel you must rebuild EVERY config and
 *   take the best of them, then ask whether the real grid-best beats the 95th
 *   percentile of those surrogate maxima. This is the family-wise / max-statistic
 *   correction (Westfall & Young 1993; Romano & Wolf 2005; White's Reality Check
 *   2000; Bailey & López de Prado's False Strategy Theorem 2014). It controls the
 *   family-wise error rate exactly because the max-null already "paid" for the
 *   search.
 *
 * This is the SEARCHED-grid analogue of the single-series surrogate gate in
 * `strategy-validator.ts` (which this file does NOT modify or import). There the
 * null is one config vs its own surrogate; here the null is the grid-best vs the
 * surrogate grid-MAX. Use THIS one whenever a config was chosen by searching a grid.
 *
 * CONTRACT — the caller supplies a `family`:
 *   - `configs`: the full searched grid (honest N = configs.length).
 *   - `buildReturns(panel, config)`: rebuild ONE config's net per-period returns on a
 *     (real or surrogate) panel. MUST be pure & deterministic in (panel, config).
 *   - `makeSurrogatePanel(panel, seed)`: a panel-level null that DESTROYS the edge the
 *     family exploits while preserving each asset's marginal nuisance structure
 *     (e.g. a cross-sectional shuffle for rotation edges, a per-asset block bootstrap
 *     or phase randomization for temporal edges). MUST be pure & deterministic in
 *     (panel, seed). Every config is rebuilt on the SAME surrogate panel per draw, so
 *     the grid-max is taken over a coherent cross-section — exactly as in the real grid.
 *
 * Pure and deterministic (seeded). No I/O, no network, no committed-file edits.
 */

import {
  summarizeReturnSeries,
  type ReturnSeriesStatistic,
  type ReturnSeriesStats,
} from "../statistical-validation";

/** A panel is one return path per asset; configs/surrogates are functions of it. */
export type FamilyPanel<Panel> = Panel;

export interface StrategyFamily<Panel, Config> {
  /** Stable identifier for the family (for the evidence record / reason string). */
  id: string;
  /** The FULL searched grid. honestN = configs.length (no silent de-duplication). */
  configs: readonly Config[];
  /**
   * Rebuild ONE config's net per-period return series on a (real or surrogate) panel.
   * Pure & deterministic in (panel, config). Non-finite values are dropped before scoring.
   */
  buildReturns: (panel: Panel, config: Config) => readonly number[];
  /**
   * Build a surrogate panel whose null DESTROYS the family's edge but preserves the
   * marginal nuisance structure. Pure & deterministic in (panel, seed).
   */
  makeSurrogatePanel: (panel: Panel, seed: number) => Panel;
}

export interface StrategyFamilyOptions {
  /** Surrogate draws (grid-max samples). Default 200. */
  iterations?: number;
  /**
   * Statistic the grid is scored / maximized on. Default "sharpe" — the searched-grid
   * surrogate tests STRUCTURE edges, and most panel-level nulls (shuffle / block /
   * phase) preserve the marginal mean, so a Sharpe-type statistic is what the null can
   * actually discriminate. Override only when the null also destroys the mean.
   */
  statistic?: ReturnSeriesStatistic;
  /**
   * Family-wise quantile the real grid-best must exceed. Default 0.95 (the surr95 of
   * the maxima ⇒ a one-sided 5% family-wise error rate).
   */
  quantile?: number;
  /** Base seed; surrogate draw i is seeded deterministically from this. Default "family". */
  seed?: number | string;
}

export interface FamilyConfigScore<Config> {
  config: Config;
  /** Index of the config in the original grid (stable tie-break). */
  index: number;
  /** Real-panel score on the chosen statistic. */
  stat: number;
  /** Real-panel full summary (for the evidence record). */
  stats: ReturnSeriesStats;
}

export interface StrategyFamilyVerdict<Config> {
  familyId: string;
  statistic: ReturnSeriesStatistic;
  /** The grid-best config on the REAL panel (the one a search would have kept). */
  bestConfig: Config;
  /** Index of the best config in the original grid. */
  bestConfigIndex: number;
  /** The real grid-best statistic (max over configs on the real panel). */
  realBestStat: number;
  /**
   * Family-wise surrogate p-value: fraction of surrogate GRID-MAXIMA ≥ the real
   * grid-best. This already "pays" for the search of N configs.
   */
  surrogateMaxP: number;
  /** The `quantile`-th percentile of the surrogate grid-maxima (default surr95). */
  surr95: number;
  /** PASS iff realBestStat > surr95 (strictly), i.e. surrogateMaxP < (1 - quantile). */
  passed: boolean;
  /** The HONEST trial count actually corrected for (= configs.length). */
  honestN: number;
  /** Number of surrogate draws (grid-max samples collected). */
  iterations: number;
  /** Quantile used for the family-wise bar (default 0.95). */
  quantile: number;
  /** Per-config real scores, sorted best-first (the realized grid). */
  realScores: FamilyConfigScore<Config>[];
  /** The collected null distribution of surrogate grid-maxima, ascending. */
  surrogateMaxima: number[];
  /** One-line human reason (why it passed / what killed it). */
  reason: string;
}

const EPSILON = 1e-12;

/**
 * Run the FAMILY-WISE MAX-statistic surrogate test on a searched grid.
 *
 * 1. Score every config on the REAL panel; the grid-best is what a search keeps.
 * 2. For each of `iterations` surrogate draws: build ONE surrogate panel, rebuild
 *    EVERY config on it, take the grid-MAX statistic ⇒ one sample of the null max.
 * 3. The real grid-best must STRICTLY exceed the `quantile`-th percentile (default
 *    surr95) of those surrogate maxima. Equivalently surrogateMaxP < 1 - quantile.
 *
 * A KILL here means "the best of your N configs is no better than the best of N
 * pure-structure-less configs" — i.e. you found the luckiest of N, not an edge.
 */
export function validateStrategyFamily<Panel, Config>(
  panel: Panel,
  family: StrategyFamily<Panel, Config>,
  options: StrategyFamilyOptions = {},
): StrategyFamilyVerdict<Config> {
  if (family.configs.length === 0) {
    throw new Error("validateStrategyFamily: family.configs must be non-empty.");
  }

  const statistic = options.statistic ?? "sharpe";
  const iterations = normalizePositiveInteger(options.iterations, 200);
  const quantile = clamp(options.quantile ?? 0.95, 0.5, 1 - EPSILON);
  const honestN = family.configs.length;

  // --- 1. Real grid: score every config, find the grid-best (what a search keeps). ---
  const realScores: FamilyConfigScore<Config>[] = family.configs.map(
    (config, index) => {
      const stats = summarizeReturnSeries(finite(family.buildReturns(panel, config)));
      return { config, index, stat: pick(stats, statistic), stats };
    },
  );
  const sortedReal = [...realScores].sort(
    (left, right) => right.stat - left.stat || left.index - right.index,
  );
  const best = sortedReal[0]!;
  const realBestStat = best.stat;

  // --- 2. Surrogate grid-maxima: rebuild EVERY config on each surrogate panel,
  //        take the grid-MAX. The max-over-N is what corrects for the search. ----------
  const baseSeed = toSeed(options.seed ?? "family");
  const surrogateMaxima: number[] = [];
  for (let it = 0; it < iterations; it += 1) {
    // Deterministic per-draw seed (mixed with the base seed) so the whole test is
    // reproducible and each draw is an independent surrogate panel.
    const drawSeed = mixSeed(baseSeed, it);
    const surrogatePanel = family.makeSurrogatePanel(panel, drawSeed);
    let gridMax = Number.NEGATIVE_INFINITY;
    for (const config of family.configs) {
      const score = pick(
        summarizeReturnSeries(finite(family.buildReturns(surrogatePanel, config))),
        statistic,
      );
      if (score > gridMax) gridMax = score;
    }
    surrogateMaxima.push(Number.isFinite(gridMax) ? gridMax : 0);
  }
  surrogateMaxima.sort((left, right) => left - right);

  // --- 3. Family-wise comparison: real grid-best vs surr95 of the surrogate maxima. ---
  const surr95 = quantileSorted(surrogateMaxima, quantile);
  // Family-wise p = fraction of surrogate grid-maxima ≥ the real grid-best.
  const geCount = surrogateMaxima.filter((m) => m >= realBestStat - EPSILON).length;
  const surrogateMaxP = surrogateMaxima.length > 0 ? geCount / surrogateMaxima.length : 1;
  const passed = realBestStat > surr95 + EPSILON;

  const reason = passed
    ? `real grid-best ${statistic}=${realBestStat.toFixed(5)} beats family-wise null ` +
      `(surr${Math.round(quantile * 100)}=${surr95.toFixed(5)} of ${iterations} grid-maxima over honest N=${honestN}; ` +
      `familyP=${surrogateMaxP.toFixed(3)})`
    : `LUCKIEST-OF-N, NOT AN EDGE: real grid-best ${statistic}=${realBestStat.toFixed(5)} does NOT clear the ` +
      `family-wise null (surr${Math.round(quantile * 100)}=${surr95.toFixed(5)} of ${iterations} grid-maxima over honest N=${honestN}; ` +
      `familyP=${surrogateMaxP.toFixed(3)}) — KILL`;

  return {
    familyId: family.id,
    statistic,
    bestConfig: best.config,
    bestConfigIndex: best.index,
    realBestStat,
    surrogateMaxP,
    surr95,
    passed,
    honestN,
    iterations,
    quantile,
    realScores: sortedReal,
    surrogateMaxima,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Helpers (kept local & dependency-free, matching the repo's pure-function style)
// ---------------------------------------------------------------------------

function pick(stats: ReturnSeriesStats, statistic: ReturnSeriesStatistic): number {
  if (statistic === "mean") return stats.mean;
  if (statistic === "sharpe") return stats.sharpe;
  return stats.compoundReturn;
}

function finite(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

function quantileSorted(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const bounded = clamp(quantile, 0, 1);
  const position = (values.length - 1) * bounded;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower] ?? 0;
  const weight = position - lower;
  return (values[lower] ?? 0) * (1 - weight) + (values[upper] ?? 0) * weight;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

/** Coerce a seed (number | string) into a 32-bit unsigned integer. */
function toSeed(seed: number | string): number {
  return typeof seed === "number" ? seed >>> 0 : hashString(seed);
}

/** Deterministically derive surrogate-draw `i`'s seed from the base seed. */
function mixSeed(base: number, index: number): number {
  let value = (base ^ (index + 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
