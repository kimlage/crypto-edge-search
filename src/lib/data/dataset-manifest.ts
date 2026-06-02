/**
 * Dataset manifest builder (FRONT: data) — turns the raw facts about a dataset
 * fetch into the provenance record defined by schemas/dataset-manifest.schema.json.
 *
 * Why this exists: a backtest result is only reproducible if the exact bytes it
 * ran on can be pinned, and only honest if the data's KNOWN BIASES (survivorship,
 * look-ahead, regime, …) travel WITH the numbers instead of living in someone's
 * head. The manifest pins, in one object:
 *   - the source (free, public, key-less endpoint) and when it was accessed,
 *   - the inclusive coverage period and bar granularity,
 *   - the symbols included,
 *   - a SHA-256 content hash so a re-fetch can be byte-compared, and
 *   - the declared biases and the endpoint's rate limits.
 *
 * Determinism: the content hash is a pure function of the supplied content. The
 * caller may hand us either the materialized `rows` (any JSON-serializable value
 * — hashed by VALUE via sorted-key canonical JSON, so object key order and row
 * iteration order of equal data never change the hash) or a pre-rendered
 * `contentForHash` string (hashed byte-for-byte). The hash is computed with
 * node:crypto's SHA-256 and prefixed `sha256:` to match the schema's convention.
 * No clock is read here; `accessedAt` is only set when the CALLER passes one in.
 *
 * Pure: no file I/O, no Date.now, no RNG. Same input ⇒ byte-identical manifest.
 */

import { createHash } from "node:crypto";

/** The bias tags allowed by the schema's `known_biases` enum. */
export type KnownBias =
  | "survivorship"
  | "look_ahead"
  | "selection"
  | "regime_specific"
  | "delisting_shock"
  | "low_liquidity"
  | "stablecoin_depeg"
  | "exchange_specific"
  | "none_known";

/** The full set of allowed bias tags, for validation / enumeration by callers. */
export const KNOWN_BIASES: readonly KnownBias[] = [
  "survivorship",
  "look_ahead",
  "selection",
  "regime_specific",
  "delisting_shock",
  "low_liquidity",
  "stablecoin_depeg",
  "exchange_specific",
  "none_known",
] as const;

/** Where the data came from (a free, public, key-less source). */
export interface DatasetSource {
  /** Provider name, e.g. "Binance", "Coin Metrics Community". */
  provider: string;
  /** Public host / API endpoint used (no API key). */
  endpoint: string;
  /** ISO-8601 date-time the data was fetched. Optional; never generated here. */
  accessedAt?: string;
}

/** Rate limits of the public endpoint, so re-fetches stay within policy. */
export interface RateLimits {
  /** Allowed requests per minute against the endpoint (> 0). */
  requestsPerMinute: number;
  /** Optional weight-based budget per minute (e.g. Binance request weight; > 0). */
  weightPerMinute?: number;
  /** Free-text notes about throttling / backoff behavior. */
  notes?: string;
}

/**
 * The manifest object, matching schemas/dataset-manifest.schema.json exactly
 * (snake_case `known_biases` / `rate_limits` per the schema).
 */
export interface DatasetManifest {
  datasetId: string;
  source: DatasetSource;
  period: {
    start: string;
    end: string;
    granularity?: string;
  };
  symbols: string[];
  /** Content hash, prefixed "sha256:". */
  hash: string;
  known_biases: KnownBias[];
  rate_limits: RateLimits;
}

/** Input to {@link buildDatasetManifest}. */
export interface BuildDatasetManifestInput {
  /** Stable identifier for this dataset artifact. */
  datasetId: string;
  /** Source provenance (provider, endpoint, optional accessedAt). */
  source: DatasetSource;
  /** First covered date (YYYY-MM-DD). */
  periodStart: string;
  /** Last covered date (YYYY-MM-DD). */
  periodEnd: string;
  /** Optional bar / sampling granularity, e.g. "1d", "15m", "8h". */
  granularity?: string;
  /** The symbols / instruments included (at least one). */
  symbols: readonly string[];
  /**
   * The materialized dataset content, hashed BY VALUE via canonical JSON. Provide
   * this OR `contentForHash` (exactly one). Object key order and row order of
   * equal data do not change the hash.
   */
  rows?: unknown;
  /**
   * A pre-rendered content string, hashed BYTE-FOR-BYTE. Provide this OR `rows`.
   * Useful when the caller already holds the canonical serialized bytes (e.g. the
   * exact CSV text fetched from the endpoint).
   */
  contentForHash?: string;
  /**
   * Known biases this data carries. At least one is required so caveats are never
   * silent; pass `["none_known"]` explicitly if truly none. Deduped + ordered to
   * the schema's canonical enum order for stable output.
   */
  knownBiases?: readonly KnownBias[];
  /** Rate limits of the public endpoint. Defaults to a conservative 60 rpm. */
  rateLimits?: RateLimits;
}

/** Default rate limit when the caller does not supply one: a cautious 60 rpm. */
const DEFAULT_RATE_LIMITS: RateLimits = { requestsPerMinute: 60 };

/**
 * Build a {@link DatasetManifest} from the facts of a dataset fetch. The returned
 * object matches schemas/dataset-manifest.schema.json's required fields and is
 * deterministic: the same content (whether via `rows` or `contentForHash`) yields
 * the same `hash`, and the same inputs yield a byte-identical object.
 *
 * Throws on the structural mistakes the schema would reject, but with a clearer,
 * located message: empty id/provider/endpoint, empty symbols, providing both or
 * neither of `rows`/`contentForHash`, a non-positive `requestsPerMinute`, or a
 * `known_biases` list that (after dedupe) is empty.
 */
export function buildDatasetManifest(input: BuildDatasetManifestInput): DatasetManifest {
  const datasetId = requireNonEmpty(input.datasetId, "datasetId");
  const provider = requireNonEmpty(input.source?.provider, "source.provider");
  const endpoint = requireNonEmpty(input.source?.endpoint, "source.endpoint");
  const start = requireNonEmpty(input.periodStart, "periodStart");
  const end = requireNonEmpty(input.periodEnd, "periodEnd");

  const symbols = (input.symbols ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
  if (symbols.length === 0) {
    throw new Error("buildDatasetManifest: at least one symbol is required.");
  }

  const hasRows = Object.prototype.hasOwnProperty.call(input, "rows") && input.rows !== undefined;
  const hasContent = typeof input.contentForHash === "string";
  if (hasRows === hasContent) {
    throw new Error(
      "buildDatasetManifest: provide exactly one of `rows` or `contentForHash` to hash.",
    );
  }
  const hash = hasContent
    ? sha256Hex(input.contentForHash as string)
    : sha256Hex(canonicalize(input.rows));

  const biases = normalizeBiases(input.knownBiases);

  const rate = input.rateLimits ?? DEFAULT_RATE_LIMITS;
  if (!(typeof rate.requestsPerMinute === "number") || !(rate.requestsPerMinute > 0)) {
    throw new Error("buildDatasetManifest: rate_limits.requestsPerMinute must be > 0.");
  }

  const source: DatasetSource = { provider, endpoint };
  if (typeof input.source.accessedAt === "string" && input.source.accessedAt.length > 0) {
    source.accessedAt = input.source.accessedAt;
  }

  const period: DatasetManifest["period"] = { start, end };
  if (typeof input.granularity === "string" && input.granularity.length > 0) {
    period.granularity = input.granularity;
  }

  const rate_limits: RateLimits = { requestsPerMinute: rate.requestsPerMinute };
  if (typeof rate.weightPerMinute === "number" && rate.weightPerMinute > 0) {
    rate_limits.weightPerMinute = rate.weightPerMinute;
  }
  if (typeof rate.notes === "string" && rate.notes.length > 0) {
    rate_limits.notes = rate.notes;
  }

  return {
    datasetId,
    source,
    period,
    symbols,
    hash: `sha256:${hash}`,
    known_biases: biases,
    rate_limits,
  };
}

/**
 * SHA-256 of UTF-8 `text`, as 64 lowercase hex chars, via node:crypto. Exposed so
 * callers can hash content the same way the manifest does (e.g. to compare a
 * re-fetch against a manifest's `hash` after stripping the `sha256:` prefix).
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical JSON for hashing-by-value: objects rendered with keys sorted
 * recursively, `undefined`/function values dropped, non-finite numbers folded to
 * null. Array order is preserved (it is meaningful). Mirrors the ledger's
 * canonicalizer so the two agree on what "the same content" means.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined" || typeof value === "function") return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
      .join(",");
    return `{${body}}`;
  }
  // bigint / symbol — fall back to a stable string form.
  return JSON.stringify(String(value));
}

/**
 * Normalize the caller's bias list: coerce to known tags, drop unknowns, dedupe,
 * and order to the schema's canonical enum order. Defaults to `["none_known"]`
 * when nothing usable is supplied, so the schema's "at least one" rule always
 * holds and caveats are never silent.
 */
function normalizeBiases(input: readonly KnownBias[] | undefined): KnownBias[] {
  const allowed = new Set<string>(KNOWN_BIASES);
  const seen = new Set<KnownBias>();
  for (const raw of input ?? []) {
    if (allowed.has(raw)) seen.add(raw);
  }
  if (seen.size === 0) return ["none_known"];
  return KNOWN_BIASES.filter((b) => seen.has(b));
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`buildDatasetManifest: \`${field}\` is required and must be a non-empty string.`);
  }
  return value.trim();
}
