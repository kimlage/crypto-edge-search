/**
 * Tests for the `crypto-edge` CLI (`runCli`).
 *
 * `runCli` returns an EXIT CODE and never calls process.exit, so these tests assert
 * directly on the returned code and on captured stdout/stderr (via an injected CliIo
 * sink — no monkey-patching of the real streams). The load-bearing contract:
 *   - a `validate` run on the bundled example returns 0 AND produces a real verdict
 *     (with baselines, OR with the explicit --allow-missing-baselines acknowledgement);
 *   - a `validate` run with NO baselines and no acknowledgement REFUSES (exit 2) with
 *     the LOUD INDETERMINATE-cap warning;
 *   - a 'searched_grid' selection mode is REFUSED and pointed at validate-family;
 *   - a missing file returns 2 with a clear stderr message;
 *   - `--help` returns 0 and prints usage for the subcommands;
 *   - `validate-family` on the bundled spec + panel returns 0 and prints a family verdict;
 *   - `check-data` grades the bundled CSVs and exits 2 on a FAIL grade;
 *   - `init` scaffolds a hypothesis template that round-trips through loadStrategySpec.
 *
 * A KILL is a valid RESULT, not a failure — so the verdict assertions check that a
 * verdict was *produced*, not that it is a survivor.
 */

import { describe, expect, it } from "vitest";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { runCli, type CliIo } from "./crypto-edge";
import { loadStrategySpec } from "../lib/spec/load-spec";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const RETURNS_CSV = resolve(REPO_ROOT, "examples/cli/returns.example.csv");
const PANEL_CSV = resolve(REPO_ROOT, "examples/cli/panel.example.csv");
const STRATEGY_SPEC = resolve(REPO_ROOT, "examples/specs/strategy.example.yaml");
const HYP_PREREGISTERED = resolve(REPO_ROOT, "examples/hypotheses/preregistered-rsi.yaml");
const HYP_SEARCHED = resolve(REPO_ROOT, "examples/hypotheses/xs-donchian-family.yaml");
/** A fixed instant so the prereg manifest is deterministic in the test (no clock). */
const FIXED_CREATED_AT = "2026-01-15T00:00:00.000Z";

/** A capturing CliIo so we can assert on what the CLI wrote without touching stdout. */
function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  let outBuf = "";
  let errBuf = "";
  return {
    io: {
      out: (text) => {
        outBuf += text;
      },
      err: (text) => {
        errBuf += text;
      },
    },
    out: () => outBuf,
    err: () => errBuf,
  };
}

describe("crypto-edge CLI — runCli", () => {
  it("(a) validate on the example returns CSV (acknowledging missing baselines) returns 0 and produces a verdict", async () => {
    const cap = captureIo();
    const code = await runCli(
      ["validate", RETURNS_CSV, "--allow-missing-baselines"],
      cap.io,
    );

    expect(code).toBe(0);
    const stdout = cap.out();
    // The CLI summary LEADS with the scientific verdict and labels the legacy PASS/KILL.
    expect(stdout).toMatch(
      /^Scientific verdict: (KILL|PROMISING|SURVIVE|INDETERMINATE|DEFERRED) \(legacy binary verdict: (PASS|KILL)\)/,
    );
    // The run produced a verdict: the report shows a scientific verdict label and the
    // gauntlet's gate table. (KILL is a valid RESULT — we assert a verdict exists,
    // not that it survived.)
    expect(stdout).toContain("Scientific verdict:");
    expect(stdout).toMatch(/KILL|PROMISING|SURVIVE|INDETERMINATE|DEFERRED/);
    expect(stdout).toContain("Gates (in evaluation order)");
  });

  it("(a-warn) validate with NO baselines and no acknowledgement REFUSES (exit 2) with the INDETERMINATE-cap warning", async () => {
    const cap = captureIo();
    const code = await runCli(["validate", RETURNS_CSV], cap.io);

    expect(code).toBe(2);
    // The LOUD stderr warning is emitted verbatim and names the acknowledgement flag.
    expect(cap.err()).toContain(
      "WARNING: no baselines supplied -> scientific verdict is capped at INDETERMINATE",
    );
    expect(cap.err()).toContain("--allow-missing-baselines");
    // It refused BEFORE running, so no verdict was printed.
    expect(cap.out()).toBe("");
  });

  it("(a-baselines) validate WITH --baselines runs without the missing-baselines warning", async () => {
    const cap = captureIo();
    const code = await runCli(
      ["validate", RETURNS_CSV, "--baselines", PANEL_CSV],
      cap.io,
    );

    expect(code).toBe(0);
    expect(cap.err()).not.toContain("no baselines supplied");
    expect(cap.out()).toContain("Scientific verdict:");
  });

  it("(a') validate --json on the example returns CSV returns 0 and emits a schema-shaped verdict", async () => {
    const cap = captureIo();
    const code = await runCli(
      ["validate", RETURNS_CSV, "--json", "--trials", "8", "--allow-missing-baselines"],
      cap.io,
    );

    expect(code).toBe(0);
    const json = JSON.parse(cap.out()) as {
      verdict: string;
      trialCount: number;
      gates: unknown[];
    };
    expect(["KILL", "PROMISING", "SURVIVE", "INDETERMINATE", "DEFERRED"]).toContain(
      json.verdict,
    );
    expect(json.trialCount).toBe(8);
    expect(json.gates.length).toBeGreaterThan(0);
  });

  it("(b) a missing returns file returns 2 with a clear stderr message", async () => {
    const cap = captureIo();
    const code = await runCli(
      ["validate", resolve(REPO_ROOT, "examples/cli/__does_not_exist__.csv")],
      cap.io,
    );

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain("cannot read file");
  });

  it("(c) --help returns 0 and documents both subcommands", async () => {
    const cap = captureIo();
    const code = await runCli(["--help"], cap.io);

    expect(code).toBe(0);
    expect(cap.out()).toContain("crypto-edge validate ");
    expect(cap.out()).toContain("crypto-edge validate-family ");
  });

  it("(c') no args also prints usage and returns 0", async () => {
    const cap = captureIo();
    const code = await runCli([], cap.io);

    expect(code).toBe(0);
    expect(cap.out()).toContain("USAGE:");
  });

  it("(d) validate-family on the example spec + panel returns 0 and prints a family verdict", async () => {
    const cap = captureIo();
    const code = await runCli(
      [
        "validate-family",
        STRATEGY_SPEC,
        "--panel",
        PANEL_CSV,
        // Keep the surrogate draw count modest so the test stays fast & deterministic.
        "--iterations",
        "64",
      ],
      cap.io,
    );

    expect(code).toBe(0);
    const stdout = cap.out();
    expect(stdout).toContain("Family verdict —");
    // honest N = product of the example grid (4 lookbacks * 3 holds * 2 long_short = 24).
    expect(stdout).toContain("Honest N (configs searched):** 24");
    // The family-wise outcome is a PASS or a KILL — either is a valid produced result.
    expect(stdout).toMatch(/Outcome:\*\* (PASS|KILL)/);
    // It also renders the compact evidence card.
    expect(stdout).toMatch(/### (SURVIVE|KILL) —/);
  });

  it("validate-family without --panel returns 2 with a clear message", async () => {
    const cap = captureIo();
    const code = await runCli(["validate-family", STRATEGY_SPEC], cap.io);

    expect(code).toBe(2);
    expect(cap.err()).toContain("--panel");
  });

  it("an unknown command returns 2 and prints usage to stderr", async () => {
    const cap = captureIo();
    const code = await runCli(["frobnicate"], cap.io);

    expect(code).toBe(2);
    expect(cap.err()).toContain("unknown command");
  });

  // -------------------------------------------------------------------------
  // (c) selection-mode enforcement
  // -------------------------------------------------------------------------

  it("(c) validate --selection-mode searched_grid REFUSES (exit 2) and points at validate-family", async () => {
    const cap = captureIo();
    const code = await runCli(
      [
        "validate",
        RETURNS_CSV,
        "--selection-mode",
        "searched_grid",
        "--allow-missing-baselines",
      ],
      cap.io,
    );

    expect(code).toBe(2);
    expect(cap.err()).toContain("searched_grid");
    expect(cap.err()).toContain("validate-family");
    expect(cap.out()).toBe("");
  });

  it("(c') validate --selection-mode preregistered_single is allowed and runs", async () => {
    const cap = captureIo();
    const code = await runCli(
      [
        "validate",
        RETURNS_CSV,
        "--selection-mode",
        "preregistered_single",
        "--allow-missing-baselines",
      ],
      cap.io,
    );

    expect(code).toBe(0);
    expect(cap.out()).toContain("Scientific verdict:");
  });

  it("(c'') a --spec declaring selection_mode: searched_grid is REFUSED by validate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-edge-spec-"));
    try {
      // Scaffold a template, then flip its declared selection mode to searched_grid.
      const cap0 = captureIo();
      await runCli(["init"], cap0.io);
      const spec = cap0
        .out()
        .replace(
          "selection_mode: preregistered_single",
          "selection_mode: searched_grid",
        );
      const specPath = join(dir, "hypothesis.yaml");
      writeFileSync(specPath, spec);

      const cap = captureIo();
      const code = await runCli(
        ["validate", RETURNS_CSV, "--spec", specPath, "--allow-missing-baselines"],
        cap.io,
      );
      expect(code).toBe(2);
      expect(cap.err()).toContain("validate-family");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(c''') a --selection-mode that contradicts the spec's selection_mode fails loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-edge-spec-"));
    try {
      const cap0 = captureIo();
      await runCli(["init", "--out", join(dir, "h.yaml")], cap0.io); // preregistered_single
      const cap = captureIo();
      const code = await runCli(
        [
          "validate",
          RETURNS_CSV,
          "--spec",
          join(dir, "h.yaml"),
          "--selection-mode",
          "searched_grid",
          "--allow-missing-baselines",
        ],
        cap.io,
      );
      expect(code).toBe(2);
      expect(cap.err()).toContain("conflict");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // (d) check-data
  // -------------------------------------------------------------------------

  it("(d) check-data on the example returns CSV grades PASS and returns 0", async () => {
    const cap = captureIo();
    const code = await runCli(["check-data", RETURNS_CSV], cap.io);

    expect(code).toBe(0);
    expect(cap.out()).toContain("Data quality");
    expect(cap.out()).toMatch(/\*\*Grade:\*\* (PASS|WARN)/);
  });

  it("(d') check-data on the example panel CSV grades the wide panel and returns 0", async () => {
    const cap = captureIo();
    const code = await runCli(["check-data", PANEL_CSV], cap.io);

    expect(code).toBe(0);
    expect(cap.out()).toContain("panel:");
    expect(cap.out()).toMatch(/\*\*Grade:\*\* (PASS|WARN)/);
  });

  it("(d'') check-data on a zero-variance series grades FAIL and returns 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-edge-bad-"));
    try {
      const bad = join(dir, "bad.csv");
      writeFileSync(
        bad,
        "date,return\n2024-01-01,0.0\n2024-01-02,0.0\n2024-01-03,0.0\n2024-01-04,0.0\n",
      );
      const cap = captureIo();
      const code = await runCli(["check-data", bad], cap.io);

      expect(code).toBe(2);
      expect(cap.out()).toContain("**Grade:** FAIL");
      expect(cap.out().toLowerCase()).toContain("zero variance");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check-data with no argument returns 2 with a clear message", async () => {
    const cap = captureIo();
    const code = await runCli(["check-data"], cap.io);

    expect(code).toBe(2);
    expect(cap.err()).toContain("missing <csv>");
  });

  // -------------------------------------------------------------------------
  // (d) init
  // -------------------------------------------------------------------------

  it("(d) init prints a hypothesis template that round-trips through loadStrategySpec", async () => {
    const cap = captureIo();
    const code = await runCli(["init"], cap.io);

    expect(code).toBe(0);
    const template = cap.out();
    expect(template).toContain("selection_mode: preregistered_single");
    // The scaffold is a VALID StrategySpec the loader accepts (no I/O — parse the string).
    const spec = loadStrategySpec(template);
    expect(spec.strategy_id).toBe("my-hypothesis");
    expect(Object.keys(spec.configs).length).toBeGreaterThan(0);
  });

  it("(d') init --out writes the template to a file and notes it on stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-edge-init-"));
    try {
      const outPath = join(dir, "hypothesis.yaml");
      const cap = captureIo();
      const code = await runCli(["init", "--out", outPath], cap.io);

      expect(code).toBe(0);
      // Pure artifact on disk; the human note goes to stderr so stdout stays empty.
      expect(cap.out()).toBe("");
      expect(cap.err()).toContain("wrote hypothesis template");
      const written = readFileSync(outPath, "utf8");
      expect(loadStrategySpec(written).strategy_id).toBe("my-hypothesis");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // (e) prereg — freeze a HypothesisSpec into a pre-registration manifest
  // -------------------------------------------------------------------------

  it("(e) prereg on the preregistered_single example LOCKS a config hash and writes the manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-edge-prereg-"));
    try {
      const outPath = join(dir, "manifest.json");
      const cap = captureIo();
      const code = await runCli(
        ["prereg", HYP_PREREGISTERED, "--out", outPath, "--created-at", FIXED_CREATED_AT],
        cap.io,
      );

      expect(code).toBe(0);
      // The summary card surfaces the lock (the sha256 configHash) prominently.
      expect(cap.out()).toContain("# Pre-registration —");
      expect(cap.out()).toMatch(/Locked config hash:\*\* sha256:[0-9a-f]{64}/);
      expect(cap.out()).toContain("honest N=1");
      // The written manifest carries the caller's createdAt verbatim (no clock in the lib).
      const manifest = JSON.parse(readFileSync(outPath, "utf8")) as {
        kind: string;
        hypothesisId: string;
        configHash: string;
        createdAt: string;
      };
      expect(manifest.kind).toBe("preregistration");
      expect(manifest.hypothesisId).toBe("rsi2-mean-reversion-btc");
      expect(manifest.createdAt).toBe(FIXED_CREATED_AT);
      expect(manifest.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      // A preregistered single is NOT flagged for the family-wise null.
      expect(cap.err()).not.toContain("searched_grid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(e') prereg is DETERMINISTIC: the same spec + created-at locks the same hash", async () => {
    const a = captureIo();
    const b = captureIo();
    await runCli(["prereg", HYP_PREREGISTERED, "--json", "--created-at", FIXED_CREATED_AT], a.io);
    await runCli(["prereg", HYP_PREREGISTERED, "--json", "--created-at", FIXED_CREATED_AT], b.io);
    const ha = (JSON.parse(a.out()) as { configHash: string }).configHash;
    const hb = (JSON.parse(b.out()) as { configHash: string }).configHash;
    expect(ha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ha).toBe(hb);
  });

  it("(e'') prereg on a searched_grid spec flags it as requiring validate-family", async () => {
    const cap = captureIo();
    const code = await runCli(
      ["prereg", HYP_SEARCHED, "--created-at", FIXED_CREATED_AT],
      cap.io,
    );

    expect(code).toBe(0);
    // A searched grid CANNOT be a single series — it is flagged for the family-wise null.
    expect(cap.out()).toContain("SEARCHED GRID");
    expect(cap.err()).toContain("searched_grid");
    expect(cap.err()).toContain("validate-family");
  });

  it("prereg with no argument returns 2 with a clear message", async () => {
    const cap = captureIo();
    const code = await runCli(["prereg"], cap.io);

    expect(code).toBe(2);
    expect(cap.err()).toContain("missing <hypothesis");
  });

  it("prereg on a malformed hypothesis spec returns 2 (loud parse error)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crypto-edge-prereg-bad-"));
    try {
      const bad = join(dir, "bad.yaml");
      // Missing the required `mechanism` and others — the loader must reject it.
      writeFileSync(bad, "id: x\nname: y\n");
      const cap = captureIo();
      const code = await runCli(["prereg", bad], cap.io);

      expect(code).toBe(2);
      expect(cap.err()).toContain("crypto-edge:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
