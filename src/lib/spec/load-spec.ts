/**
 * Loaders + validators for the lab's declarative SPECs (see ./types.ts).
 *
 * Each `load*Spec` accepts a STRING (the raw file contents) of EITHER JSON or YAML,
 * detects the format by trying `JSON.parse` first then `yaml.parse`, validates every
 * required field (throwing a clear, field-named error on anything missing or
 * mistyped — a typo'd key fails loudly, never silently), and returns the typed
 * object. `costSpecToExecutionModel` maps a `CostSpec` onto the `ExecutionCostModel`
 * that powers `chargeExecutionCosts`, so the same realistic, leverage-aware cost
 * stack is declared rather than hard-coded.
 *
 * Pure and deterministic: no I/O, no network, no Date.now, no RNG. The caller reads
 * the file; these functions only parse + validate the string.
 */

import { parse as parseYaml } from "yaml";

import type { ExecutionCostModel, ShortBorrowAprByVenue } from "../cost/execution-cost-model";
import type {
  CostSpec,
  DatasetRateLimits,
  DatasetSource,
  DatasetSpec,
  HoldoutSpec,
  SpecCadence,
  SpecStatistic,
  StrategySpec,
  SurrogateSpec,
  TrialCountPolicy,
  UniverseSpec,
} from "./types";

/** Thrown when a spec string fails to parse or is missing/mistyped a field. */
export class SpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecValidationError";
  }
}

const VALID_CADENCES: readonly SpecCadence[] = [
  "minute",
  "minute5",
  "minute15",
  "hourly",
  "hourly4",
  "funding8h",
  "daily",
  "weekly",
  "yearly",
];

const VALID_STATISTICS: readonly SpecStatistic[] = ["compoundReturn", "mean", "sharpe"];
const VALID_SURROGATE_MODES: readonly SurrogateSpec["mode"][] = [
  "phase",
  "block",
  "cross_sectional",
  "family_max",
];
const VALID_HOLDOUT_MODES: readonly HoldoutSpec["mode"][] = ["tail", "none"];
const VALID_TRIAL_MODES: readonly TrialCountPolicy["mode"][] = ["grid", "explicit"];

/**
 * Parse a spec string that is EITHER JSON or YAML. Detection: try `JSON.parse`
 * first (the strict, fast path); on failure fall back to `yaml.parse` (YAML is a
 * superset of JSON, but trying JSON first keeps JSON inputs exact and fast). A
 * string that is valid neither way throws a clear error naming the spec kind.
 */
export function parseSpecString(raw: string, kind: string): unknown {
  if (typeof raw !== "string") {
    throw new SpecValidationError(`${kind}: expected a string of JSON or YAML, got ${typeof raw}.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SpecValidationError(`${kind}: empty input — expected a string of JSON or YAML.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not JSON — fall through to YAML.
  }
  try {
    return parseYaml(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SpecValidationError(`${kind}: could not parse input as JSON or YAML — ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// StrategySpec
// ---------------------------------------------------------------------------

/** Parse + validate a `StrategySpec` from a JSON or YAML string. */
export function loadStrategySpec(raw: string): StrategySpec {
  const obj = asObject(parseSpecString(raw, "StrategySpec"), "StrategySpec");

  const strategy_id = requireString(obj, "strategy_id", "StrategySpec");
  const family = requireString(obj, "family", "StrategySpec");
  const cadence = requireEnum(obj, "cadence", "StrategySpec", VALID_CADENCES);
  const universe = parseUniverse(requireField(obj, "universe", "StrategySpec"));
  const configs = parseConfigs(requireField(obj, "configs", "StrategySpec"));
  const trial_count_policy = parseTrialCountPolicy(
    requireField(obj, "trial_count_policy", "StrategySpec"),
  );
  const cost_model = parseCostSpec(requireField(obj, "cost_model", "StrategySpec"));
  const baselines = requireStringArray(obj, "baselines", "StrategySpec");
  const surrogate = parseSurrogate(requireField(obj, "surrogate", "StrategySpec"));
  const holdout = parseHoldout(requireField(obj, "holdout", "StrategySpec"));

  const spec: StrategySpec = {
    strategy_id,
    family,
    cadence,
    universe,
    configs,
    trial_count_policy,
    cost_model,
    baselines,
    surrogate,
    holdout,
  };

  if (obj.statistic !== undefined) {
    spec.statistic = requireEnum(obj, "statistic", "StrategySpec", VALID_STATISTICS) as SpecStatistic;
  }

  return spec;
}

function parseUniverse(value: unknown): UniverseSpec {
  const obj = asObject(value, "StrategySpec.universe");
  return {
    type: requireString(obj, "type", "StrategySpec.universe"),
    max_assets: requirePositiveInteger(obj, "max_assets", "StrategySpec.universe"),
    include_delisted: requireBoolean(obj, "include_delisted", "StrategySpec.universe"),
  };
}

function parseConfigs(value: unknown): Record<string, readonly (string | number | boolean)[]> {
  const obj = asObject(value, "StrategySpec.configs");
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    throw new SpecValidationError(
      "StrategySpec.configs: must declare at least one parameter (param -> values).",
    );
  }
  const out: Record<string, (string | number | boolean)[]> = {};
  for (const key of keys) {
    const raw = obj[key];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new SpecValidationError(
        `StrategySpec.configs.${key}: must be a non-empty array of values.`,
      );
    }
    for (const item of raw) {
      const t = typeof item;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        throw new SpecValidationError(
          `StrategySpec.configs.${key}: values must be string | number | boolean, got ${t}.`,
        );
      }
      if (t === "number" && !Number.isFinite(item)) {
        throw new SpecValidationError(
          `StrategySpec.configs.${key}: numeric values must be finite.`,
        );
      }
    }
    out[key] = raw as (string | number | boolean)[];
  }
  return out;
}

function parseTrialCountPolicy(value: unknown): TrialCountPolicy {
  const obj = asObject(value, "StrategySpec.trial_count_policy");
  const mode = requireEnum(
    obj,
    "mode",
    "StrategySpec.trial_count_policy",
    VALID_TRIAL_MODES,
  ) as TrialCountPolicy["mode"];
  const policy: TrialCountPolicy = { mode };
  if (mode === "explicit") {
    policy.count = requirePositiveInteger(obj, "count", "StrategySpec.trial_count_policy");
  } else if (obj.count !== undefined) {
    policy.count = requirePositiveInteger(obj, "count", "StrategySpec.trial_count_policy");
  }
  return policy;
}

function parseSurrogate(value: unknown): SurrogateSpec {
  const obj = asObject(value, "StrategySpec.surrogate");
  return {
    mode: requireEnum(
      obj,
      "mode",
      "StrategySpec.surrogate",
      VALID_SURROGATE_MODES,
    ) as SurrogateSpec["mode"],
    null: requireString(obj, "null", "StrategySpec.surrogate"),
    iterations: requirePositiveInteger(obj, "iterations", "StrategySpec.surrogate"),
  };
}

function parseHoldout(value: unknown): HoldoutSpec {
  const obj = asObject(value, "StrategySpec.holdout");
  const mode = requireEnum(
    obj,
    "mode",
    "StrategySpec.holdout",
    VALID_HOLDOUT_MODES,
  ) as HoldoutSpec["mode"];
  const fraction = requireNumber(obj, "fraction", "StrategySpec.holdout");
  if (fraction < 0 || fraction >= 1) {
    throw new SpecValidationError(
      `StrategySpec.holdout.fraction: must be in [0, 1), got ${fraction}.`,
    );
  }
  return { mode, fraction };
}

// ---------------------------------------------------------------------------
// DatasetSpec
// ---------------------------------------------------------------------------

/** Parse + validate a `DatasetSpec` from a JSON or YAML string. */
export function loadDatasetSpec(raw: string): DatasetSpec {
  const obj = asObject(parseSpecString(raw, "DatasetSpec"), "DatasetSpec");

  const dataset_id = requireString(obj, "dataset_id", "DatasetSpec");
  const source = parseDatasetSource(requireField(obj, "source", "DatasetSpec"));
  const period_start = requireString(obj, "period_start", "DatasetSpec");
  const period_end = requireString(obj, "period_end", "DatasetSpec");
  const symbols = requireStringArray(obj, "symbols", "DatasetSpec", 1);
  const hash = requireString(obj, "hash", "DatasetSpec");
  const known_biases = requireStringArray(obj, "known_biases", "DatasetSpec", 1);
  const rate_limits = parseRateLimits(requireField(obj, "rate_limits", "DatasetSpec"));

  return {
    dataset_id,
    source,
    period_start,
    period_end,
    symbols,
    hash,
    known_biases,
    rate_limits,
  };
}

function parseDatasetSource(value: unknown): DatasetSource | string {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new SpecValidationError("DatasetSpec.source: string source must be non-empty.");
    }
    return value;
  }
  const obj = asObject(value, "DatasetSpec.source");
  return {
    provider: requireString(obj, "provider", "DatasetSpec.source"),
    endpoint: requireString(obj, "endpoint", "DatasetSpec.source"),
  };
}

function parseRateLimits(value: unknown): DatasetRateLimits {
  const obj = asObject(value, "DatasetSpec.rate_limits");
  return {
    concurrency: requirePositiveInteger(obj, "concurrency", "DatasetSpec.rate_limits"),
  };
}

// ---------------------------------------------------------------------------
// CostSpec + mapping to ExecutionCostModel
// ---------------------------------------------------------------------------

/** Parse + validate a `CostSpec` from a JSON or YAML string. */
export function loadCostSpec(raw: string): CostSpec {
  return parseCostSpec(parseSpecString(raw, "CostSpec"));
}

function parseCostSpec(value: unknown): CostSpec {
  const obj = asObject(value, "CostSpec");

  const spec: CostSpec = {
    taker_bps_per_side: requireNonNegativeNumber(obj, "taker_bps_per_side", "CostSpec"),
    maker_bps_per_side: requireNonNegativeNumber(obj, "maker_bps_per_side", "CostSpec"),
    slippage_bps: requireNonNegativeNumber(obj, "slippage_bps", "CostSpec"),
  };

  if (obj.maker_fraction !== undefined) {
    const mf = requireNumber(obj, "maker_fraction", "CostSpec");
    if (mf < 0 || mf > 1) {
      throw new SpecValidationError(`CostSpec.maker_fraction: must be in [0, 1], got ${mf}.`);
    }
    spec.maker_fraction = mf;
  }
  if (obj.short_borrow_apr_by_venue !== undefined) {
    spec.short_borrow_apr_by_venue = parseBorrowMap(obj.short_borrow_apr_by_venue);
  }
  if (obj.borrow_venue !== undefined) {
    spec.borrow_venue = requireString(obj, "borrow_venue", "CostSpec");
  }
  if (obj.perp_funding_per_period !== undefined) {
    spec.perp_funding_per_period = requireNumber(obj, "perp_funding_per_period", "CostSpec");
  }
  if (obj.futures_financing_apr !== undefined) {
    spec.futures_financing_apr = requireNumber(obj, "futures_financing_apr", "CostSpec");
  }
  if (obj.risk_free_apr !== undefined) {
    spec.risk_free_apr = requireNumber(obj, "risk_free_apr", "CostSpec");
  }
  if (obj.margin_haircut !== undefined) {
    spec.margin_haircut = requireNonNegativeNumber(obj, "margin_haircut", "CostSpec");
  }

  return spec;
}

function parseBorrowMap(value: unknown): ShortBorrowAprByVenue {
  const obj = asObject(value, "CostSpec.short_borrow_apr_by_venue");
  const out: ShortBorrowAprByVenue = {};
  for (const venue of Object.keys(obj)) {
    const rate = obj[venue];
    if (typeof rate !== "number" || !Number.isFinite(rate)) {
      throw new SpecValidationError(
        `CostSpec.short_borrow_apr_by_venue.${venue}: must be a finite number (annual APR fraction).`,
      );
    }
    out[venue] = rate;
  }
  return out;
}

/**
 * Map a validated `CostSpec` onto the `ExecutionCostModel` that
 * `chargeExecutionCosts` consumes. Bps fields map straight across; the carry
 * components (borrow / funding / financing / risk-free / margin haircut) default to
 * 0 / empty so an under-declared cost is conservatively NEUTRAL, never silently
 * negative — and when declared they flow into the leverage-aware engine that charges
 * them on the FULL levered/short notional (the dated-futures-leak fix).
 */
export function costSpecToExecutionModel(spec: CostSpec): ExecutionCostModel {
  const model: ExecutionCostModel = {
    takerBpsPerSide: spec.taker_bps_per_side,
    makerBpsPerSide: spec.maker_bps_per_side,
    makerFraction: spec.maker_fraction ?? 0,
    slippageBps: spec.slippage_bps,
    shortBorrowAprByVenue: spec.short_borrow_apr_by_venue ?? {},
    perpFundingPerPeriod: spec.perp_funding_per_period ?? 0,
    futuresFinancingApr: spec.futures_financing_apr ?? 0,
    riskFreeApr: spec.risk_free_apr ?? 0,
    marginHaircut: spec.margin_haircut ?? 0,
  };
  if (spec.borrow_venue !== undefined) {
    model.borrowVenue = spec.borrow_venue;
  }
  return model;
}

// ---------------------------------------------------------------------------
// Validation primitives (clear, field-named errors)
// ---------------------------------------------------------------------------

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpecValidationError(
      `${context}: expected an object, got ${describe(value)}.`,
    );
  }
  return value as Record<string, unknown>;
}

function requireField(obj: Record<string, unknown>, field: string, context: string): unknown {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
    throw new SpecValidationError(`${context}: missing required field '${field}'.`);
  }
  return obj[field];
}

function requireString(obj: Record<string, unknown>, field: string, context: string): string {
  const value = requireField(obj, field, context);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SpecValidationError(
      `${context}.${field}: must be a non-empty string, got ${describe(value)}.`,
    );
  }
  return value;
}

function requireNumber(obj: Record<string, unknown>, field: string, context: string): number {
  const value = requireField(obj, field, context);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SpecValidationError(
      `${context}.${field}: must be a finite number, got ${describe(value)}.`,
    );
  }
  return value;
}

function requireNonNegativeNumber(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = requireNumber(obj, field, context);
  if (value < 0) {
    throw new SpecValidationError(`${context}.${field}: must be ≥ 0, got ${value}.`);
  }
  return value;
}

function requirePositiveInteger(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = requireNumber(obj, field, context);
  if (!Number.isInteger(value) || value < 1) {
    throw new SpecValidationError(
      `${context}.${field}: must be an integer ≥ 1, got ${value}.`,
    );
  }
  return value;
}

function requireBoolean(obj: Record<string, unknown>, field: string, context: string): boolean {
  const value = requireField(obj, field, context);
  if (typeof value !== "boolean") {
    throw new SpecValidationError(
      `${context}.${field}: must be a boolean, got ${describe(value)}.`,
    );
  }
  return value;
}

function requireStringArray(
  obj: Record<string, unknown>,
  field: string,
  context: string,
  minItems = 0,
): string[] {
  const value = requireField(obj, field, context);
  if (!Array.isArray(value)) {
    throw new SpecValidationError(
      `${context}.${field}: must be an array of strings, got ${describe(value)}.`,
    );
  }
  if (value.length < minItems) {
    throw new SpecValidationError(
      `${context}.${field}: must have at least ${minItems} item(s), got ${value.length}.`,
    );
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new SpecValidationError(
        `${context}.${field}: every item must be a non-empty string, got ${describe(item)}.`,
      );
    }
  }
  return value as string[];
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  field: string,
  context: string,
  allowed: readonly T[],
): T {
  const value = requireString(obj, field, context);
  if (!allowed.includes(value as T)) {
    throw new SpecValidationError(
      `${context}.${field}: must be one of [${allowed.join(", ")}], got '${value}'.`,
    );
  }
  return value as T;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
