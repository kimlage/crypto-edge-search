/**
 * Tests for the pre-registration manifest (`buildPreregistration` /
 * `assertPreregistered`).
 *
 * Load-bearing contracts:
 *   - the config hash is STABLE: equal config (modulo object key order) ⇒ identical
 *     hash, so a cosmetic re-ordering never breaks the lock;
 *   - any real change to the config changes the hash (tamper is detectable);
 *   - `assertPreregistered` passes for the matching config and THROWS for a drifted
 *     one — so an honest N=1 cannot be claimed on a re-pointed config;
 *   - a corrupted manifest (configHash no longer matching its own frozenConfig) is
 *     rejected;
 *   - `createdAt` is the caller's value verbatim — the builder never reads the clock.
 */

import { describe, expect, it } from "vitest";

import {
  buildPreregistration,
  assertPreregistered,
  canonicalize,
  sha256Hex,
  PreregistrationError,
  type PreregistrationManifest,
} from "./preregistration";

const CREATED_AT = "2026-01-15T00:00:00.000Z";

function manifestFor(frozenConfig: unknown): PreregistrationManifest {
  return buildPreregistration({
    hypothesisId: "rsi2-mean-reversion-btc",
    frozenConfig,
    mechanism: "RSI(2) oversold overnight mean reversion on BTC daily closes.",
    createdAt: CREATED_AT,
  });
}

describe("buildPreregistration", () => {
  it("produces a sha256-prefixed hash and echoes the caller's createdAt verbatim", () => {
    const manifest = manifestFor({ period: 2, entry: 10 });
    expect(manifest.kind).toBe("preregistration");
    expect(manifest.version).toBe(1);
    expect(manifest.hypothesisId).toBe("rsi2-mean-reversion-btc");
    expect(manifest.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // createdAt is PASSED IN, never read from the clock.
    expect(manifest.createdAt).toBe(CREATED_AT);
    // The hash is exactly the sha256 of the canonical frozen config.
    expect(manifest.configHash).toBe(`sha256:${sha256Hex(canonicalize({ period: 2, entry: 10 }))}`);
  });

  it("is hash-stable across object key ordering (canonical, so the lock is robust)", () => {
    const a = manifestFor({ period: 2, entry: 10, exit: "next_bar" });
    const b = manifestFor({ exit: "next_bar", entry: 10, period: 2 });
    expect(a.configHash).toBe(b.configHash);
  });

  it("changes the hash when ANY parameter changes (tamper is detectable)", () => {
    const a = manifestFor({ period: 2, entry: 10 });
    const b = manifestFor({ period: 2, entry: 11 }); // a single param drifted
    expect(a.configHash).not.toBe(b.configHash);
  });

  it("preserves array order in the hash (order is meaningful)", () => {
    const a = manifestFor({ windows: [20, 40, 60] });
    const b = manifestFor({ windows: [60, 40, 20] });
    expect(a.configHash).not.toBe(b.configHash);
  });

  it("throws on empty hypothesisId / mechanism / createdAt and on an undefined config", () => {
    expect(() =>
      buildPreregistration({ hypothesisId: "", frozenConfig: {}, mechanism: "m", createdAt: CREATED_AT }),
    ).toThrow(PreregistrationError);
    expect(() =>
      buildPreregistration({ hypothesisId: "h", frozenConfig: {}, mechanism: "  ", createdAt: CREATED_AT }),
    ).toThrow(/mechanism/);
    expect(() =>
      buildPreregistration({ hypothesisId: "h", frozenConfig: {}, mechanism: "m", createdAt: "" }),
    ).toThrow(/createdAt/);
    expect(() =>
      buildPreregistration({ hypothesisId: "h", frozenConfig: undefined, mechanism: "m", createdAt: CREATED_AT }),
    ).toThrow(/frozenConfig/);
  });
});

describe("assertPreregistered", () => {
  it("passes for the exact frozen config (honest N=1 is earned)", () => {
    const manifest = manifestFor({ period: 2, entry: 10 });
    // Same config, different key order — still matches.
    expect(() => assertPreregistered(manifest, { entry: 10, period: 2 })).not.toThrow();
  });

  it("rejects a drifted live config (refuses to claim N=1 on a re-pointed config)", () => {
    const manifest = manifestFor({ period: 2, entry: 10 });
    expect(() => assertPreregistered(manifest, { period: 2, entry: 15 })).toThrow(
      PreregistrationError,
    );
    expect(() => assertPreregistered(manifest, { period: 2, entry: 15 })).toThrow(
      /does not match the pre-registered config/,
    );
  });

  it("rejects a corrupted manifest whose configHash no longer matches its frozenConfig", () => {
    const manifest = manifestFor({ period: 2, entry: 10 });
    const tampered: PreregistrationManifest = {
      ...manifest,
      // Hash kept, but the frozen config quietly swapped (the classic tamper).
      frozenConfig: { period: 2, entry: 99 },
    };
    expect(() => assertPreregistered(tampered, { period: 2, entry: 99 })).toThrow(
      /manifest is corrupt/,
    );
  });
});
