/**
 * Tests for the `crypto-edge` CLI (`runCli`).
 *
 * `runCli` returns an EXIT CODE and never calls process.exit, so these tests assert
 * directly on the returned code and on captured stdout/stderr (via an injected CliIo
 * sink — no monkey-patching of the real streams). The load-bearing contract:
 *   - a `validate` run on the bundled example returns 0 AND produces a real verdict;
 *   - a missing file returns 2 with a clear stderr message;
 *   - `--help` returns 0 and prints usage for BOTH subcommands;
 *   - `validate-family` on the bundled spec + panel returns 0 and prints a family verdict.
 *
 * A KILL is a valid RESULT, not a failure — so the verdict assertions check that a
 * verdict was *produced*, not that it is a survivor.
 */

import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli, type CliIo } from "./crypto-edge";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const RETURNS_CSV = resolve(REPO_ROOT, "examples/cli/returns.example.csv");
const PANEL_CSV = resolve(REPO_ROOT, "examples/cli/panel.example.csv");
const STRATEGY_SPEC = resolve(REPO_ROOT, "examples/specs/strategy.example.yaml");

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
  it("(a) validate on the example returns CSV returns 0 and produces a verdict", async () => {
    const cap = captureIo();
    const code = await runCli(["validate", RETURNS_CSV], cap.io);

    expect(code).toBe(0);
    const stdout = cap.out();
    // The run produced a verdict: the report shows a scientific verdict label and the
    // gauntlet's gate table. (KILL is a valid RESULT — we assert a verdict exists,
    // not that it survived.)
    expect(stdout).toContain("Scientific verdict:");
    expect(stdout).toMatch(/KILL|PROMISING|SURVIVE|INDETERMINATE|DEFERRED/);
    expect(stdout).toContain("Gates (in evaluation order)");
  });

  it("(a') validate --json on the example returns CSV returns 0 and emits a schema-shaped verdict", async () => {
    const cap = captureIo();
    const code = await runCli(["validate", RETURNS_CSV, "--json", "--trials", "8"], cap.io);

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
});
