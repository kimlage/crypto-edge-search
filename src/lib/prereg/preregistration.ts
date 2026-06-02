/**
 * The PRE-REGISTRATION manifest (FRONT: prereg).
 *
 * WHY THIS EXISTS:
 * ----------------
 * An honest trial count N of 1 has to be EARNED, not asserted. The only way a
 * single-series verdict can legitimately deflate by N=1 is if the exact config it
 * tested was committed BEFORE the data was looked at, and can be proven not to have
 * moved afterwards. A pre-registration manifest is that proof: it freezes the config,
 * pins it with a SHA-256 content hash, and records WHEN it was frozen — so a later run
 * can `assertPreregistered` the live config against the frozen one and refuse to
 * proceed if so much as a single parameter drifted.
 *
 * Two disciplines are enforced structurally here:
 *
 *   1. The hash is over a CANONICAL serialization of the frozen config (sorted keys,
 *      array order preserved), so cosmetic re-orderings of equal config never change
 *      the hash, but any real change does. This is the same canonicalizer the dataset
 *      manifest and the results ledger use, so all three agree on "the same content".
 *
 *   2. `createdAt` is PASSED IN by the caller — this module NEVER reads the clock.
 *      A pure, clock-free builder means the manifest is fully deterministic and
 *      reproducible in a test, and the timestamp's provenance lives with the caller
 *      (the script that owns the wall-clock), not buried in a library.
 *
 * Pure: no file I/O, no Date.now, no RNG. Same input ⇒ byte-identical manifest.
 */

import { createHash } from "node:crypto";

/** Thrown when a live config does not match a pre-registered (frozen) config. */
export class PreregistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreregistrationError";
  }
}

/**
 * The frozen config is any JSON-serializable value (a flat param map, a nested grid,
 * a whole StrategySpec — the prereg layer is agnostic to its shape; it only freezes
 * and hashes it by VALUE).
 */
export type FrozenConfig = unknown;

/** Input to {@link buildPreregistration}. */
export interface BuildPreregistrationInput {
  /** The hypothesis id this pre-registration locks (links to the HypothesisSpec). */
  hypothesisId: string;
  /** The config being frozen — hashed by value via canonical JSON. */
  frozenConfig: FrozenConfig;
  /** A plain-language statement of the mechanism (carried for the evidence record). */
  mechanism: string;
  /**
   * ISO-8601 instant the config was frozen. PASSED IN — never read from the clock —
   * so the manifest is deterministic and the timestamp's provenance is the caller's.
   */
  createdAt: string;
}

/**
 * The committed pre-registration manifest. `configHash` LOCKS the frozen config: any
 * later run must reproduce the same hash (via `assertPreregistered`) before it may
 * claim the honest N=1 a pre-registration earns.
 */
export interface PreregistrationManifest {
  /** Stable schema tag so a reader can recognize and version the manifest. */
  kind: "preregistration";
  /** Manifest format version. */
  version: 1;
  /** The hypothesis this pre-registration locks. */
  hypothesisId: string;
  /** The mechanism statement, carried for the evidence record. */
  mechanism: string;
  /** The frozen config, stored verbatim for audit (the hash is over its canonical form). */
  frozenConfig: FrozenConfig;
  /** SHA-256 of the canonical frozen config, prefixed "sha256:". */
  configHash: string;
  /** ISO-8601 instant the config was frozen (supplied by the caller). */
  createdAt: string;
}

/**
 * Freeze a config into a {@link PreregistrationManifest}. The `configHash` is a pure
 * function of the canonical serialization of `frozenConfig`, so equal configs (modulo
 * object key order) always hash identically and any real change is detected. Because
 * the honest trial count N for a pre-registered single hypothesis is 1, this lock is
 * what makes that N=1 defensible: the config could not have been re-pointed after the
 * fact without changing the hash.
 *
 * Throws on the structural mistakes that would make the lock meaningless: an empty
 * `hypothesisId`, an empty `mechanism`, an empty / non-string `createdAt`, or a
 * `frozenConfig` of `undefined` (there is nothing to freeze).
 */
export function buildPreregistration(
  input: BuildPreregistrationInput,
): PreregistrationManifest {
  const hypothesisId = requireNonEmpty(input.hypothesisId, "hypothesisId");
  const mechanism = requireNonEmpty(input.mechanism, "mechanism");
  const createdAt = requireNonEmpty(input.createdAt, "createdAt");
  if (input.frozenConfig === undefined) {
    throw new PreregistrationError(
      "buildPreregistration: `frozenConfig` is required — there is nothing to freeze.",
    );
  }

  const configHash = `sha256:${sha256Hex(canonicalize(input.frozenConfig))}`;

  return {
    kind: "preregistration",
    version: 1,
    hypothesisId,
    mechanism,
    frozenConfig: input.frozenConfig,
    configHash,
    createdAt,
  };
}

/**
 * Verify that a LIVE config matches the manifest's frozen config, by recomputing the
 * canonical hash of `config` and comparing it to `manifest.configHash`. Throws a
 * `PreregistrationError` (naming both hashes) when they differ — so a run whose config
 * drifted from what was pre-registered can NEVER quietly claim the honest N=1 the
 * pre-registration earns. Returns silently when they match.
 *
 * As a consistency guard it also re-derives the manifest's own hash from its stored
 * `frozenConfig`; a manifest whose `configHash` was tampered with (so it no longer
 * matches its own frozen config) is rejected even before the live config is compared.
 */
export function assertPreregistered(
  manifest: PreregistrationManifest,
  config: FrozenConfig,
): void {
  const selfHash = `sha256:${sha256Hex(canonicalize(manifest.frozenConfig))}`;
  if (selfHash !== manifest.configHash) {
    throw new PreregistrationError(
      `assertPreregistered: manifest is corrupt — its configHash (${manifest.configHash}) does not match the hash of its own frozenConfig (${selfHash}). The lock has been tampered with.`,
    );
  }

  const liveHash = `sha256:${sha256Hex(canonicalize(config))}`;
  if (liveHash !== manifest.configHash) {
    throw new PreregistrationError(
      `assertPreregistered: the live config does not match the pre-registered config for '${manifest.hypothesisId}'. Pre-registered ${manifest.configHash}, got ${liveHash}. An honest N=1 requires the EXACT frozen config — refusing to proceed.`,
    );
  }
}

/**
 * SHA-256 of UTF-8 `text`, as 64 lowercase hex chars, via node:crypto. Matches the
 * dataset manifest's hasher so the whole lab agrees on its content-hash convention.
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical JSON for hashing-by-value: objects rendered with keys sorted recursively,
 * `undefined`/function values dropped, non-finite numbers folded to null. Array order
 * is preserved (it is meaningful). Mirrors the dataset-manifest / ledger canonicalizer
 * so the three agree on what "the same content" means.
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

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PreregistrationError(
      `buildPreregistration: \`${field}\` is required and must be a non-empty string.`,
    );
  }
  return value.trim();
}
