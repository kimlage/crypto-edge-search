/**
 * Declarative SPEC shapes for a strategy hypothesis, its dataset provenance, and
 * its cost model — the front door of the lab.
 *
 * WHY THESE EXIST:
 * ----------------
 * Every result in this repo has to be reproducible and its caveats can never be
 * silent (see schemas/dataset-manifest.schema.json, schemas/cost-model.schema.json,
 * docs/METHODOLOGY_CONFORMANCE.md). A SPEC is the committed, human-authored
 * description of a hypothesis BEFORE the gauntlet runs: which family of configs is
 * searched (so the Deflated Sharpe has an HONEST N to deflate by), on which
 * survivorship-aware universe, at which cadence, against which baselines, under
 * which surrogate null, with how much of the tail reserved as a consume-once
 * holdout. The CostSpec maps 1:1 onto `ExecutionCostModel` so the same realistic,
 * leverage-aware cost stack that powers `chargeExecutionCosts` is declared, not
 * hard-coded — and the dated-futures leak (financing on 1 unit instead of the full
 * levered notional) can never sneak back in through an under-declared cost.
 *
 * These are plain, serializable interfaces (no methods, no I/O). They are loaded
 * from JSON or YAML by `load-spec.ts` and validated there.
 */

import type { ExecutionCostModel, ShortBorrowAprByVenue } from "../cost/execution-cost-model";

/**
 * Cadence of the strategy's bars. Mirrors the keys of `PeriodsPerYear` in
 * `src/lib/cadence.ts` so a spec's cadence resolves to an explicit periods-per-year
 * and a reported Sharpe is never silently mis-annualized.
 */
export type SpecCadence =
  | "minute"
  | "minute5"
  | "minute15"
  | "hourly"
  | "hourly4"
  | "funding8h"
  | "daily"
  | "weekly"
  | "yearly";

/** Which return-series statistic a score is scored on (matches ReturnSeriesStatistic). */
export type SpecStatistic = "compoundReturn" | "mean" | "sharpe";

/**
 * The universe of instruments the strategy trades. `include_delisted` is the
 * survivorship knob: a universe that silently drops delisted names overstates an
 * edge (the LUNA/FTT survivorship caveat in docs/RESULTS.md).
 */
export interface UniverseSpec {
  /** Kind of universe, e.g. "top_by_volume", "fixed_list", "all_perps". */
  type: string;
  /** Cap on the number of assets actually traded (cross-section width). */
  max_assets: number;
  /** Whether delisted names are kept (survivorship-free). false ⇒ survivorship bias. */
  include_delisted: boolean;
}

/**
 * Policy that fixes the HONEST trial count N the Deflated Sharpe / Harvey-Liu
 * haircut must deflate by. `mode: "grid"` means N = the product of the searched
 * config grid sizes (auditable from `configs`); `mode: "explicit"` pins N directly.
 */
export interface TrialCountPolicy {
  /** "grid" ⇒ N derived from the searched configs; "explicit" ⇒ N is `count`. */
  mode: "grid" | "explicit";
  /** The explicit honest N, when `mode === "explicit"`. Must be ≥ 1. */
  count?: number;
}

/**
 * The cost-model spec. Maps 1:1 onto `ExecutionCostModel` (see
 * `costSpecToExecutionModel`). All carry components (borrow / funding / financing /
 * risk-free / margin haircut) are declared explicitly so they are charged on the
 * FULL levered/short notional, not on 1 unit — the dated-futures-leak fix.
 */
export interface CostSpec {
  /** Taker fee per side, in basis points of traded notional. */
  taker_bps_per_side: number;
  /** Maker fee per side, in basis points of traded notional. */
  maker_bps_per_side: number;
  /** Fraction of turnover executed as MAKER (0..1). Default 0 (all taker). */
  maker_fraction?: number;
  /** Per-side market-impact slippage, in basis points of traded notional. */
  slippage_bps: number;
  /** Annual short-borrow APR (fraction) per venue. Empty ⇒ no borrow charge. */
  short_borrow_apr_by_venue?: ShortBorrowAprByVenue;
  /** Which venue's borrow rate to apply (else single entry / max across venues). */
  borrow_venue?: string;
  /** Per-PERIOD perp funding (NOT annual). Positive ⇒ the book pays. Default 0. */
  perp_funding_per_period?: number;
  /** Annual financing on a dated-futures / financed long leg (fraction/yr). Default 0. */
  futures_financing_apr?: number;
  /** Annual risk-free carry on the FULL long notional (fraction/yr). Default 0. */
  risk_free_apr?: number;
  /** Per-period margin haircut drag as a fraction of GROSS notional. Default 0. */
  margin_haircut?: number;
}

/** The surrogate / placebo null the strategy's edge must beat (Gate 7). */
export interface SurrogateSpec {
  /**
   * The null mode: which structure the surrogate destroys. e.g. "phase" (Theiler
   * phase randomization), "block" (Politis-Romano block bootstrap),
   * "cross_sectional" (rotation shuffle), or "family_max" (the family-wise
   * MAX-statistic for a searched grid).
   */
  mode: "phase" | "block" | "cross_sectional" | "family_max";
  /**
   * The kind of null the surrogate represents (free-text label for the evidence
   * record, e.g. "temporal", "rotation", "structure").
   */
  null: string;
  /** Number of surrogate panels / grid-max draws. Must be ≥ 1. */
  iterations: number;
}

/** How the consume-once forward holdout vault is carved off the tail. */
export interface HoldoutSpec {
  /** "tail" ⇒ reserve the most-recent contiguous block; "none" ⇒ no vault. */
  mode: "tail" | "none";
  /** Fraction of the series reserved as the consume-once vault (0..1). */
  fraction: number;
}

/**
 * The full strategy hypothesis spec. `configs` is a record of parameter name to its
 * searched values; the product of those array lengths is the honest grid N when
 * `trial_count_policy.mode === "grid"`.
 */
export interface StrategySpec {
  /** Stable identifier for the hypothesis. */
  strategy_id: string;
  /** The family the configs belong to (for the family-wise surrogate / evidence). */
  family: string;
  /** Bar cadence (resolves to an explicit periods-per-year). */
  cadence: SpecCadence;
  /** The survivorship-aware universe of instruments traded. */
  universe: UniverseSpec;
  /** Searched grid: param name -> the values searched for it. */
  configs: Record<string, readonly (string | number | boolean)[]>;
  /** Policy fixing the honest trial count N for DSR / haircut. */
  trial_count_policy: TrialCountPolicy;
  /** The cost model declared for this strategy. */
  cost_model: CostSpec;
  /** The baseline ids the strategy must beat (e.g. buy_and_hold, equal_weight). */
  baselines: readonly string[];
  /** The surrogate / placebo null configuration. */
  surrogate: SurrogateSpec;
  /** The consume-once holdout configuration. */
  holdout: HoldoutSpec;
  /** Optional statistic the gauntlet scores on. Default left to the harness. */
  statistic?: SpecStatistic;
}

/** Concurrency / rate-limit knobs for the public, key-less data endpoint. */
export interface DatasetRateLimits {
  /** Max concurrent in-flight requests against the endpoint. Must be ≥ 1. */
  concurrency: number;
}

/** Where the dataset came from (a free, public, key-less source). */
export interface DatasetSource {
  /** Provider name, e.g. "Binance", "Coin Metrics Community". */
  provider: string;
  /** Public host / API endpoint used (no API key). */
  endpoint: string;
}

/**
 * Provenance record for a dataset. Pins the source, the covered period, the
 * symbols, a content hash for reproducibility, the KNOWN BIASES the data carries,
 * and the rate limits of the public endpoint — so a result can be reproduced and
 * its data caveats are never silent.
 */
export interface DatasetSpec {
  /** Stable identifier for this dataset artifact. */
  dataset_id: string;
  /** Where the data came from. Either a {provider,endpoint} object or a bare string. */
  source: DatasetSource | string;
  /** First covered date (YYYY-MM-DD), inclusive. */
  period_start: string;
  /** Last covered date (YYYY-MM-DD), inclusive. */
  period_end: string;
  /** The symbols / instruments included. At least one. */
  symbols: readonly string[];
  /** Content hash of the materialized dataset (e.g. sha256:...), for reproducibility. */
  hash: string;
  /** Known biases this data carries. At least one (use "none_known" if truly none). */
  known_biases: readonly string[];
  /** Rate limits of the public endpoint, so re-fetches stay within policy. */
  rate_limits: DatasetRateLimits;
}

export type { ExecutionCostModel };
