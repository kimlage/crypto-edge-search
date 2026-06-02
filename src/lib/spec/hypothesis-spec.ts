/**
 * The PRE-REGISTRATION layer's hypothesis SPEC (FRONT: prereg).
 *
 * WHY THIS EXISTS:
 * ----------------
 * The single most-corrosive way to overstate an edge is to SEARCH a grid, report
 * the luckiest survivor as if it were one pre-chosen idea, and let the Deflated
 * Sharpe deflate by an honest N of 1. A `HypothesisSpec` is the committed,
 * human-authored declaration of an idea BEFORE the gauntlet runs, and it forces the
 * author to say — on the record — which of the two honest postures they are taking:
 *
 *   - `selection_mode: "preregistered_single"` ⇒ ONE config was chosen up front, the
 *     run is a confirmatory test, and an honest N of 1 is earned (the prereg manifest
 *     LOCKS that single frozen config so the claim can never be quietly re-pointed).
 *   - `selection_mode: "searched_grid"` ⇒ a FAMILY of `configCount` configs is being
 *     searched, so a single-series verdict would be dishonest; such a spec is FLAGGED
 *     as requiring the family-wise MAX-statistic path (`validate-family`), which
 *     deflates by the real N rather than pretending it is 1.
 *
 * A `HypothesisSpec` complements `StrategySpec` (./types.ts): the StrategySpec is the
 * mechanical config grid the harness executes; the HypothesisSpec is the SCIENTIFIC
 * claim — its mechanism, the point-in-time / fidelity of its data, the cost stack it
 * declares (a `CostSpec`, reused verbatim so the leverage-aware cost contract is
 * declared not re-invented), the baselines it must beat, the surrogate null, and the
 * consume-once holdout policy.
 *
 * These are plain, serializable interfaces (no methods, no I/O). `loadHypothesisSpec`
 * parses EITHER JSON or YAML (JSON-first, YAML fallback — matching `parseSpecString`)
 * and validates every required field with a clear, field-named error. Pure and
 * deterministic: no network, no clock, no RNG.
 */

import type { CostSpec } from "./types";
import { parseSpecString, SpecValidationError } from "./load-spec";

/**
 * What KIND of empirical claim the hypothesis makes — the scientific shape of the
 * assertion, used by the evidence record so a "predictive" claim is never silently
 * downgraded to a mere "descriptive" correlation.
 */
export type HypothesisClaimType =
  | "predictive" // the signal forecasts a forward return / sign
  | "structural" // a cross-asset structure (cointegration, lead-lag, rotation)
  | "carry" // a harvestable carry / basis / funding premium
  | "anomaly" // a calendar / seasonality / event anomaly
  | "descriptive"; // a documented regularity, no tradable claim asserted

/**
 * How configs were chosen — the field that fixes the honest trial count N. A
 * `preregistered_single` spec earns N=1; a `searched_grid` spec must be validated as
 * a family (the MAX-statistic path) and deflated by `configCount`.
 */
export type SelectionMode = "preregistered_single" | "searched_grid";

/** The surrogate / placebo null the hypothesis's edge must beat. */
export type SurrogateType =
  | "phase" // Theiler phase randomization (temporal structure)
  | "block" // Politis-Romano stationary block bootstrap
  | "cross_sectional" // rotation / column-shuffle (cross-asset structure)
  | "family_max"; // family-wise MAX-statistic over a searched grid

/** The consume-once forward-holdout policy. */
export type HoldoutPolicy = "tail" | "none";

/**
 * The point-in-time discipline of the data: is every field as it would have been
 * KNOWN at decision time, or has it been revised / back-filled (a look-ahead trap)?
 */
export type PointInTime =
  | "as_of" // strictly point-in-time, no revisions leaked back
  | "revised" // uses revised / final values (look-ahead risk acknowledged)
  | "unknown"; // provenance of revisions not established

/**
 * The fidelity of the data to the tradable reality: are these the prices/returns a
 * book could actually have transacted, or a proxy (index, mid, synthetic)?
 */
export type DataFidelity =
  | "executable" // transactable prices (the book could have traded these)
  | "mid" // mid / mark prices (no spread crossed)
  | "index" // an index / reference series (not directly tradable)
  | "synthetic"; // a constructed / simulated series

/** Where the hypothesis's data comes from and how trustworthy it is in time. */
export interface HypothesisData {
  /** The dataset source ids / endpoints the hypothesis relies on (at least one). */
  sources: readonly string[];
  /** Point-in-time discipline of the data (look-ahead posture). */
  pointInTime: PointInTime;
  /** Fidelity of the data to a tradable reality. */
  fidelity: DataFidelity;
}

/**
 * How the configs were selected, and — for a searched grid — how many. `configHash`
 * is an OPTIONAL content hash pinning the exact searched grid (so a `searched_grid`
 * claim cannot be quietly widened after the fact).
 */
export interface SelectionSpec {
  /** preregistered_single (N=1, confirmatory) | searched_grid (family-wise N). */
  selection_mode: SelectionMode;
  /**
   * The honest number of configs. For `preregistered_single` it MUST be 1; for
   * `searched_grid` it MUST be ≥ 2 (a grid of one is just a single hypothesis).
   */
  configCount: number;
  /** Optional content hash pinning the exact searched grid (sha256:... by convention). */
  configHash?: string;
}

/** The consume-once holdout vault policy carved off the tail of the series. */
export interface HypothesisHoldout {
  /** "tail" ⇒ reserve the most-recent contiguous block; "none" ⇒ no vault. */
  policy: HoldoutPolicy;
  /** Fraction of the series reserved as the consume-once vault (0..1). */
  fraction: number;
}

/** The surrogate-null declaration. */
export interface HypothesisSurrogate {
  /** Which structure the surrogate destroys (the null the edge must beat). */
  type: SurrogateType;
}

/**
 * The full pre-registration hypothesis spec. It is the SCIENTIFIC claim record that
 * sits in front of a `StrategySpec`: what is claimed, by what mechanism, on what
 * (point-in-time, fidelity) data, at what declared cost, against which baselines,
 * under which surrogate null, with how much tail reserved as a consume-once holdout —
 * and, decisively, whether N is honestly 1 (preregistered) or must be a family-wise
 * correction (searched).
 */
export interface HypothesisSpec {
  /** Stable identifier for the hypothesis. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** The scientific shape of the claim. */
  claimType: HypothesisClaimType;
  /** A plain-language statement of the MECHANISM (why the edge should exist). */
  mechanism: string;
  /** Provenance + point-in-time / fidelity posture of the data. */
  data: HypothesisData;
  /** The declared cost stack (reused verbatim from the StrategySpec layer). */
  cost: CostSpec;
  /** How configs were selected (fixes the honest N). */
  search: SelectionSpec;
  /** The baseline ids the hypothesis must beat (at least one). */
  baselines: readonly string[];
  /** The surrogate / placebo null. */
  surrogate: HypothesisSurrogate;
  /** The consume-once holdout policy. */
  holdout: HypothesisHoldout;
}

const VALID_CLAIM_TYPES: readonly HypothesisClaimType[] = [
  "predictive",
  "structural",
  "carry",
  "anomaly",
  "descriptive",
];
const VALID_SELECTION_MODES: readonly SelectionMode[] = [
  "preregistered_single",
  "searched_grid",
];
const VALID_SURROGATE_TYPES: readonly SurrogateType[] = [
  "phase",
  "block",
  "cross_sectional",
  "family_max",
];
const VALID_POINT_IN_TIME: readonly PointInTime[] = ["as_of", "revised", "unknown"];
const VALID_FIDELITY: readonly DataFidelity[] = ["executable", "mid", "index", "synthetic"];
const VALID_HOLDOUT_POLICIES: readonly HoldoutPolicy[] = ["tail", "none"];

/**
 * Parse + validate a `HypothesisSpec` from a JSON or YAML string. Every required
 * field is checked with a clear, field-named error (a typo'd key fails loudly, never
 * silently). The two honest-N invariants are enforced here so a malformed selection
 * posture is impossible: `preregistered_single` ⇒ configCount === 1, `searched_grid`
 * ⇒ configCount ≥ 2.
 */
export function loadHypothesisSpec(raw: string): HypothesisSpec {
  const obj = asObject(parseSpecString(raw, "HypothesisSpec"), "HypothesisSpec");

  const id = requireString(obj, "id", "HypothesisSpec");
  const name = requireString(obj, "name", "HypothesisSpec");
  const claimType = requireEnum(obj, "claimType", "HypothesisSpec", VALID_CLAIM_TYPES);
  const mechanism = requireString(obj, "mechanism", "HypothesisSpec");
  const data = parseData(requireField(obj, "data", "HypothesisSpec"));
  const cost = parseCost(requireField(obj, "cost", "HypothesisSpec"));
  const search = parseSearch(requireField(obj, "search", "HypothesisSpec"));
  const baselines = requireStringArray(obj, "baselines", "HypothesisSpec", 1);
  const surrogate = parseSurrogate(requireField(obj, "surrogate", "HypothesisSpec"));
  const holdout = parseHoldout(requireField(obj, "holdout", "HypothesisSpec"));

  return {
    id,
    name,
    claimType,
    mechanism,
    data,
    cost,
    search,
    baselines,
    surrogate,
    holdout,
  };
}

/**
 * True when a spec searched a grid and therefore CANNOT be honestly judged as a
 * single series — it requires the family-wise MAX-statistic path (`validate-family`),
 * which deflates by the real `configCount` rather than pretending N is 1. Exposed so
 * a caller (CLI / harness) can refuse to run the single-series gauntlet on a searched
 * spec and route it correctly.
 */
export function requiresFamilyValidation(spec: HypothesisSpec): boolean {
  return spec.search.selection_mode === "searched_grid";
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

function parseData(value: unknown): HypothesisData {
  const obj = asObject(value, "HypothesisSpec.data");
  return {
    sources: requireStringArray(obj, "sources", "HypothesisSpec.data", 1),
    pointInTime: requireEnum(obj, "pointInTime", "HypothesisSpec.data", VALID_POINT_IN_TIME),
    fidelity: requireEnum(obj, "fidelity", "HypothesisSpec.data", VALID_FIDELITY),
  };
}

function parseSearch(value: unknown): SelectionSpec {
  const obj = asObject(value, "HypothesisSpec.search");
  const selection_mode = requireEnum(
    obj,
    "selection_mode",
    "HypothesisSpec.search",
    VALID_SELECTION_MODES,
  );
  const configCount = requirePositiveInteger(obj, "configCount", "HypothesisSpec.search");

  if (selection_mode === "preregistered_single" && configCount !== 1) {
    throw new SpecValidationError(
      `HypothesisSpec.search.configCount: a 'preregistered_single' spec must search exactly 1 config (honest N=1), got ${configCount}.`,
    );
  }
  if (selection_mode === "searched_grid" && configCount < 2) {
    throw new SpecValidationError(
      `HypothesisSpec.search.configCount: a 'searched_grid' spec must search ≥ 2 configs, got ${configCount} — a grid of one is just a preregistered single.`,
    );
  }

  const out: SelectionSpec = { selection_mode, configCount };
  if (obj.configHash !== undefined) {
    out.configHash = requireString(obj, "configHash", "HypothesisSpec.search");
  }
  return out;
}

function parseSurrogate(value: unknown): HypothesisSurrogate {
  const obj = asObject(value, "HypothesisSpec.surrogate");
  return {
    type: requireEnum(obj, "type", "HypothesisSpec.surrogate", VALID_SURROGATE_TYPES),
  };
}

function parseHoldout(value: unknown): HypothesisHoldout {
  const obj = asObject(value, "HypothesisSpec.holdout");
  const policy = requireEnum(obj, "policy", "HypothesisSpec.holdout", VALID_HOLDOUT_POLICIES);
  const fraction = requireNumber(obj, "fraction", "HypothesisSpec.holdout");
  if (fraction < 0 || fraction >= 1) {
    throw new SpecValidationError(
      `HypothesisSpec.holdout.fraction: must be in [0, 1), got ${fraction}.`,
    );
  }
  return { policy, fraction };
}

/**
 * Parse the cost stack as a `CostSpec`. We re-validate the required bps fields and the
 * optional carry components locally (rather than importing the private `parseCostSpec`)
 * so the cost contract is enforced with the same clear, field-named errors and the
 * leverage-aware carry components default to NEUTRAL when omitted.
 */
function parseCost(value: unknown): CostSpec {
  const obj = asObject(value, "HypothesisSpec.cost");

  const spec: CostSpec = {
    taker_bps_per_side: requireNonNegativeNumber(obj, "taker_bps_per_side", "HypothesisSpec.cost"),
    maker_bps_per_side: requireNonNegativeNumber(obj, "maker_bps_per_side", "HypothesisSpec.cost"),
    slippage_bps: requireNonNegativeNumber(obj, "slippage_bps", "HypothesisSpec.cost"),
  };

  if (obj.maker_fraction !== undefined) {
    const mf = requireNumber(obj, "maker_fraction", "HypothesisSpec.cost");
    if (mf < 0 || mf > 1) {
      throw new SpecValidationError(
        `HypothesisSpec.cost.maker_fraction: must be in [0, 1], got ${mf}.`,
      );
    }
    spec.maker_fraction = mf;
  }
  if (obj.short_borrow_apr_by_venue !== undefined) {
    spec.short_borrow_apr_by_venue = parseBorrowMap(obj.short_borrow_apr_by_venue);
  }
  if (obj.borrow_venue !== undefined) {
    spec.borrow_venue = requireString(obj, "borrow_venue", "HypothesisSpec.cost");
  }
  if (obj.perp_funding_per_period !== undefined) {
    spec.perp_funding_per_period = requireNumber(obj, "perp_funding_per_period", "HypothesisSpec.cost");
  }
  if (obj.futures_financing_apr !== undefined) {
    spec.futures_financing_apr = requireNumber(obj, "futures_financing_apr", "HypothesisSpec.cost");
  }
  if (obj.risk_free_apr !== undefined) {
    spec.risk_free_apr = requireNumber(obj, "risk_free_apr", "HypothesisSpec.cost");
  }
  if (obj.margin_haircut !== undefined) {
    spec.margin_haircut = requireNonNegativeNumber(obj, "margin_haircut", "HypothesisSpec.cost");
  }

  return spec;
}

function parseBorrowMap(value: unknown): Record<string, number> {
  const obj = asObject(value, "HypothesisSpec.cost.short_borrow_apr_by_venue");
  const out: Record<string, number> = {};
  for (const venue of Object.keys(obj)) {
    const rate = obj[venue];
    if (typeof rate !== "number" || !Number.isFinite(rate)) {
      throw new SpecValidationError(
        `HypothesisSpec.cost.short_borrow_apr_by_venue.${venue}: must be a finite number (annual APR fraction).`,
      );
    }
    out[venue] = rate;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation primitives (clear, field-named errors — mirror load-spec.ts)
// ---------------------------------------------------------------------------

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpecValidationError(`${context}: expected an object, got ${describe(value)}.`);
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
    throw new SpecValidationError(`${context}.${field}: must be an integer ≥ 1, got ${value}.`);
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
