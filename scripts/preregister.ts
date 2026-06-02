/**
 * `preregister` — freeze a hypothesis's config into a pre-registration manifest
 * (FRONT: prereg).
 *
 * It reads a `hypothesis.yaml` (or .json) path, loads + validates it as a
 * `HypothesisSpec`, freezes its config (the searched-grid / single-config selection
 * plus the cost stack — the bytes that define WHAT is being tested) into a
 * `PreregistrationManifest`, writes that manifest JSON to a given --out path, and
 * prints the SHA-256 content hash that LOCKS the config.
 *
 * The wall-clock `createdAt` is read HERE (the script owns the clock) and passed in to
 * the pure builder — the library itself never reads `Date.now`, so the manifest stays
 * deterministic and testable; the timestamp's provenance lives with this script.
 *
 * A `preregistered_single` spec earns an honest N of 1: the printed hash is the proof
 * that the single config was committed BEFORE the data was looked at and cannot be
 * re-pointed afterwards. A `searched_grid` spec is NOT a single hypothesis — this tool
 * prints a clear warning that such a spec must be validated as a FAMILY (the
 * `validate-family` / MAX-statistic path), and freezes the whole grid so the family
 * cannot later be widened.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/preregister.ts <hypothesis.yaml> --out <manifest.json>
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { loadHypothesisSpec, requiresFamilyValidation } from "../src/lib/spec/hypothesis-spec";
import type { HypothesisSpec } from "../src/lib/spec/hypothesis-spec";
import { buildPreregistration } from "../src/lib/prereg/preregistration";
import type { PreregistrationManifest } from "../src/lib/prereg/preregistration";

interface Args {
  hypothesisPath: string;
  out: string;
  /** ISO instant override (so a CI / test run can pin a deterministic timestamp). */
  createdAt?: string;
}

/**
 * The frozen config: the bytes that define WHAT is being tested — the selection
 * posture (single vs grid, the honest config count, the optional grid hash) and the
 * declared cost stack. Built deterministically from the spec so the same spec always
 * freezes to the same hash.
 */
export function freezeConfig(spec: HypothesisSpec): Record<string, unknown> {
  return {
    hypothesisId: spec.id,
    claimType: spec.claimType,
    selection: {
      selection_mode: spec.search.selection_mode,
      configCount: spec.search.configCount,
      ...(spec.search.configHash !== undefined ? { configHash: spec.search.configHash } : {}),
    },
    cost: spec.cost,
    surrogate: spec.surrogate,
    holdout: spec.holdout,
    data: spec.data,
  };
}

/**
 * Parse argv into `Args`. Supports `--out <path>` / `--out=<path>` and an optional
 * `--created-at <iso>` to pin the timestamp deterministically; a bare positional is
 * the hypothesis path. Unknown `--flags` fail loudly.
 */
export function parseArgs(argv: string[]): Args {
  let hypothesisPath: string | undefined;
  let out: string | undefined;
  let createdAt: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      if (hypothesisPath !== undefined) {
        throw new Error(`unexpected extra positional '${token}' (already have '${hypothesisPath}').`);
      }
      hypothesisPath = token;
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`flag --${key} requires a value.`);
      i += 1;
      return next;
    };
    if (key === "out") {
      out = takeValue();
    } else if (key === "created-at") {
      createdAt = takeValue();
    } else {
      throw new Error(`unknown flag --${key}.`);
    }
  }

  if (hypothesisPath === undefined) {
    throw new Error("missing <hypothesis.(yml|json)> argument.");
  }
  if (out === undefined) {
    throw new Error("missing required --out <manifest.json>.");
  }
  return { hypothesisPath, out, createdAt };
}

/**
 * Build the pre-registration manifest for a hypothesis spec. Exposed (pure modulo the
 * caller-supplied `createdAt`) so a test can drive it without touching the filesystem.
 */
export function preregisterSpec(spec: HypothesisSpec, createdAt: string): PreregistrationManifest {
  return buildPreregistration({
    hypothesisId: spec.id,
    frozenConfig: freezeConfig(spec),
    mechanism: spec.mechanism,
    createdAt,
  });
}

function run(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`preregister: ${message(error)}\n\n`);
    process.stderr.write(
      "USAGE: tsx scripts/preregister.ts <hypothesis.(yml|json)> --out <manifest.json> [--created-at <iso>]\n",
    );
    return 2;
  }

  let spec: HypothesisSpec;
  try {
    spec = loadHypothesisSpec(readFileSync(args.hypothesisPath, "utf8"));
  } catch (error) {
    process.stderr.write(`preregister: cannot load '${args.hypothesisPath}': ${message(error)}\n`);
    return 2;
  }

  // The script owns the clock; the library never reads it.
  const createdAt = args.createdAt ?? new Date().toISOString();
  const manifest = preregisterSpec(spec, createdAt);

  try {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`preregister: cannot write '${args.out}': ${message(error)}\n`);
    return 2;
  }

  // Print the hash that LOCKS the config (stdout: the load-bearing line).
  process.stdout.write(`${manifest.configHash}\n`);
  process.stderr.write(
    `preregister: froze '${spec.id}' (${spec.search.selection_mode}, configCount=${spec.search.configCount}) -> ${args.out}\n`,
  );
  if (requiresFamilyValidation(spec)) {
    process.stderr.write(
      "preregister: NOTE — this is a SEARCHED grid; it must be validated as a FAMILY " +
        "(crypto-edge validate-family / MAX-statistic), NOT as a single series. Honest N " +
        `is ${spec.search.configCount}, not 1.\n`,
    );
  }
  return 0;
}

// Entrypoint — only when invoked directly (so importing this file is side-effect-free).
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return entry.endsWith("preregister.ts") || entry.endsWith("preregister.js");
})();

if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
