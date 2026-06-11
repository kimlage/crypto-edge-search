#!/usr/bin/env node
/**
 * community-runner — the thin adapter between a community SUBMISSION
 * (submission.json + data files, see schemas/submission.schema.json) and the
 * repo's committed, tested gauntlet CLI (`crypto-edge`). It maps declarations
 * to CLI invocations and NEVER reimplements a gate:
 *
 *   preregistered_single -> crypto-edge validate <returns.csv>
 *                             --baselines <panel.csv> --trials <honestN>
 *                             --spec <hypothesis.yaml> [--cost <cost.yaml>] --json
 *   searched_grid        -> crypto-edge validate-family <strategy.yaml>
 *                             --panel <panel.csv>
 *   data hygiene         -> crypto-edge check-data (returns + panel)
 *   N=1 lock             -> crypto-edge prereg (recomputes the configHash; a
 *                           mismatch VOIDS the honest-N=1 claim and refuses)
 *
 * It also runs the POWER PRE-FLIGHT on any declared forward claim (claim.forward):
 *   powered horizon (80% power) ~= ((1.96 + 0.8416) / trueSharpe)^2 years
 *   required observed Sharpe in a window of W years: 1.645/sqrt(W) (DSR>=0.95 bar)
 *   and 1.96/sqrt(W) (bootstrap-CI / haircut t>=1.96 bar).
 * If the powered horizon exceeds the declared window, a SURVIVE/PROMISING outcome
 * is CAPPED at DEFERRED (underpowered windows cannot certify; KILLs still count —
 * falsification power is asymmetric).
 *
 * Target path in the public repo: scripts/community/community-runner.mjs
 * (repo root then resolves to ../../ from this file; override with --repo or
 * the CRYPTO_EDGE_REPO env var).
 *
 * USAGE
 *   node community-runner.mjs run <submission-dir> [--repo <root>] [--iterations N] [--out <dir>]
 *   node community-runner.mjs check <submission-dir> [--repo <root>]   # schema + lock + pre-flight only
 *   node community-runner.mjs --selftest [--repo <root>] [--submission <dir>]
 *
 * EXIT CODES (mirrors the crypto-edge contract)
 *   0  the gauntlet RAN — the verdict (KILL / PROMISING / SURVIVE / DEFERRED /
 *      INDETERMINATE) is the RESULT, not a failure.
 *   1  selftest assertion failure (the planted-KILL example did not KILL).
 *   2  usage / schema / lock / data-hygiene refusal (message on stderr).
 *
 * Zero npm dependencies of its own; the YAML parser is borrowed from the repo's
 * own node_modules via createRequire (the repo already depends on `yaml`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const Z_975 = 1.959963985; // two-sided 5% (bootstrap-CI / haircut t-bar)
const Z_95 = 1.644853627; // one-sided 5% (DSR >= 0.95 bar at N=1)
const Z_80 = 0.8416212336; // 80% power

const VALID_CLAIM_TYPES = ["predictive", "structural", "carry", "anomaly", "descriptive"];
const VALID_SELECTION_MODES = ["preregistered_single", "searched_grid"];
const VALID_NULLS = ["phase", "block", "cross_sectional", "family_max"];
const VALID_STATISTICS = ["compoundReturn", "mean", "sharpe"];

// ---------------------------------------------------------------------------
// Arg parsing (minimal, mirrors the crypto-edge style: --key value | --key=value)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positionals = [];
  const values = {};
  const flags = {};
  const VALUE_FLAGS = new Set(["repo", "iterations", "out", "submission"]);
  const BOOL_FLAGS = new Set(["selftest", "json"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (BOOL_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (VALUE_FLAGS.has(key)) {
      if (eq !== -1) {
        values[key] = body.slice(eq + 1);
      } else {
        values[key] = argv[i + 1];
        i += 1;
      }
      continue;
    }
    fail(`unknown flag --${key}.`);
  }
  return { positionals, values, flags };
}

function fail(message) {
  process.stderr.write(`community-runner: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Repo + CLI plumbing
// ---------------------------------------------------------------------------

function resolveRepo(values) {
  const candidate =
    values.repo ?? process.env.CRYPTO_EDGE_REPO ?? resolve(HERE, "..", "..");
  const repo = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  const cli = join(repo, "src", "cli", "crypto-edge.ts");
  if (!existsSync(cli)) {
    fail(
      `cannot find the crypto-edge CLI at ${cli}. Pass --repo <repo-root> or set CRYPTO_EDGE_REPO.`,
    );
  }
  return repo;
}

/** Run a crypto-edge subcommand through the repo's own tsx. Returns {status, stdout, stderr}. */
function cryptoEdge(repo, args) {
  const tsx = join(
    repo,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  if (!existsSync(tsx)) {
    fail(`tsx not found at ${tsx} — run \`npm ci\` in ${repo} first.`);
  }
  const result = spawnSync(tsx, [join(repo, "src", "cli", "crypto-edge.ts"), ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`failed to spawn crypto-edge: ${result.error.message}`);
  return { status: result.status ?? 2, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function loadYamlParser(repo) {
  try {
    return createRequire(join(repo, "package.json"))("yaml");
  } catch {
    fail(`cannot load the repo's yaml parser from ${repo}/node_modules — run \`npm ci\` there.`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Submission loading + structural validation (mirrors submission.schema.json)
// ---------------------------------------------------------------------------

function loadSubmission(dir) {
  const path = join(dir, "submission.json");
  if (!existsSync(path)) fail(`no submission.json in ${dir}.`);
  let sub;
  try {
    sub = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`submission.json is not valid JSON: ${error.message}`);
  }
  const errors = [];
  const need = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  need(sub.schemaVersion === 1, "schemaVersion must be 1");
  need(
    typeof sub.submissionId === "string" && /^[a-z0-9][a-z0-9-]{2,63}$/.test(sub.submissionId),
    "submissionId must be kebab-case [a-z0-9-], 3..64 chars",
  );
  need(typeof sub.author?.name === "string" && sub.author.name.length > 0, "author.name is required");
  need(typeof sub.claim?.summary === "string" && sub.claim.summary.length >= 10, "claim.summary is required (one falsifiable sentence)");
  need(typeof sub.claim?.mechanism === "string" && sub.claim.mechanism.length >= 20, "claim.mechanism is required (why should the edge exist?)");
  need(VALID_CLAIM_TYPES.includes(sub.claim?.claimType), `claim.claimType must be one of [${VALID_CLAIM_TYPES.join(", ")}]`);
  const mode = sub.strategy?.selectionMode;
  need(VALID_SELECTION_MODES.includes(mode), `strategy.selectionMode must be one of [${VALID_SELECTION_MODES.join(", ")}]`);
  if (sub.strategy?.statistic !== undefined) {
    need(VALID_STATISTICS.includes(sub.strategy.statistic), `strategy.statistic must be one of [${VALID_STATISTICS.join(", ")}]`);
  }
  need(Array.isArray(sub.data?.sources) && sub.data.sources.length >= 1, "data.sources must list at least one $0, key-less source");
  for (const [i, src] of (sub.data?.sources ?? []).entries()) {
    need(
      typeof src?.provider === "string" && typeof src?.endpoint === "string" && typeof src?.series === "string",
      `data.sources[${i}] needs provider, endpoint, series`,
    );
  }
  need(/^\d{4}-\d{2}-\d{2}$/.test(sub.data?.periodStart ?? ""), "data.periodStart must be YYYY-MM-DD");
  need(/^\d{4}-\d{2}-\d{2}$/.test(sub.data?.periodEnd ?? ""), "data.periodEnd must be YYYY-MM-DD");
  need(Array.isArray(sub.data?.knownBiases) && sub.data.knownBiases.length >= 1, "data.knownBiases must name at least one bias ('none_known' only if truly none)");
  need(Number.isInteger(sub.declared?.honestN) && sub.declared.honestN >= 1, "declared.honestN must be an integer >= 1 (EVERY config you tried)");
  need(VALID_NULLS.includes(sub.declared?.null), `declared.null must be one of [${VALID_NULLS.join(", ")}]`);
  need(typeof sub.files?.panelCsv === "string", "files.panelCsv is required (no baselines, no certification)");

  if (mode === "preregistered_single") {
    need(sub.declared?.honestN === 1, "preregistered_single requires declared.honestN === 1");
    need(
      typeof sub.declared?.preregHash === "string" && /^sha256:[0-9a-f]{64}$/.test(sub.declared.preregHash),
      "preregistered_single requires declared.preregHash (sha256:<64 hex>) from `crypto-edge prereg`",
    );
    need(typeof sub.files?.hypothesisYaml === "string", "preregistered_single requires files.hypothesisYaml");
    need(typeof sub.files?.returnsCsv === "string", "preregistered_single requires files.returnsCsv");
  }
  if (mode === "searched_grid") {
    need(sub.declared?.honestN >= 2, "searched_grid requires declared.honestN >= 2 (a grid of one is a single hypothesis)");
    need(sub.declared?.null === "family_max", "searched_grid requires declared.null === 'family_max' (the family-wise MAX-statistic)");
    need(typeof sub.files?.strategyYaml === "string", "searched_grid requires files.strategyYaml (the validate-family input)");
  }
  if (sub.claim?.forward !== undefined) {
    need(
      typeof sub.claim.forward.windowYears === "number" && sub.claim.forward.windowYears > 0,
      "claim.forward.windowYears must be a positive number",
    );
    need(
      typeof sub.claim.forward.expectedTrueSharpe === "number" && sub.claim.forward.expectedTrueSharpe > 0,
      "claim.forward.expectedTrueSharpe must be a positive number",
    );
  }

  // Referenced files must exist (data files only — a submission carries no code).
  for (const key of ["hypothesisYaml", "strategyYaml", "returnsCsv", "panelCsv", "costYaml"]) {
    const rel = sub.files?.[key];
    if (typeof rel === "string" && !existsSync(join(dir, rel))) {
      errors.push(`files.${key} -> '${rel}' does not exist in the submission directory`);
    }
  }

  // In-repo placement rule: directory name must equal submissionId.
  if (basename(dirname(resolve(dir))) === "submissions" && basename(resolve(dir)) !== sub.submissionId) {
    errors.push(`directory name '${basename(resolve(dir))}' must equal submissionId '${sub.submissionId}'`);
  }

  if (errors.length > 0) {
    fail(`submission.json failed schema checks:\n  - ${errors.join("\n  - ")}`);
  }
  return sub;
}

// ---------------------------------------------------------------------------
// Honesty checks: prereg lock, grid-N consistency, power pre-flight
// ---------------------------------------------------------------------------

/** Recompute the prereg configHash through the PUBLIC prereg path; refuse on mismatch. */
function verifyPreregLock(repo, dir, sub) {
  const specPath = join(dir, sub.files.hypothesisYaml);
  const createdAt = sub.declared.preregCreatedAt ?? "1970-01-01T00:00:00.000Z";
  const run = cryptoEdge(repo, ["prereg", specPath, "--created-at", createdAt, "--json"]);
  if (run.status !== 0) {
    fail(`crypto-edge prereg failed on ${specPath}:\n${run.stderr || run.stdout}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(run.stdout);
  } catch {
    fail(`could not parse the prereg manifest JSON from crypto-edge prereg.`);
  }
  if (manifest.configHash !== sub.declared.preregHash) {
    fail(
      `PREREG LOCK MISMATCH — the honest N=1 claim is VOID.\n` +
        `  declared : ${sub.declared.preregHash}\n` +
        `  recomputed: ${manifest.configHash}\n` +
        `The hypothesis spec is not the config that was frozen. Either restore the frozen ` +
        `spec or resubmit as searched_grid with the true honest N.`,
    );
  }
  return manifest.configHash;
}

/** Declared honestN must equal the strategy spec's config-grid product (searched_grid). */
function verifyGridN(repo, dir, sub) {
  const yaml = loadYamlParser(repo);
  const raw = readFileSync(join(dir, sub.files.strategyYaml), "utf8");
  let spec;
  try {
    spec = yaml.parse(raw);
  } catch (error) {
    fail(`files.strategyYaml is not parseable YAML: ${error.message}`);
  }
  const configs = spec?.configs ?? {};
  let product = 1;
  for (const key of Object.keys(configs)) {
    const values = configs[key];
    if (!Array.isArray(values) || values.length === 0) {
      fail(`strategy spec configs.${key} must be a non-empty array of searched values.`);
    }
    product *= values.length;
  }
  const capped = Math.min(product, 256); // MAX_FAMILY_CONFIGS in src/cli/crypto-edge.ts
  if (sub.declared.honestN !== product) {
    fail(
      `declared.honestN (${sub.declared.honestN}) must equal the strategy spec's config-grid ` +
        `product (${product}). Honest N is EVERY config searched — fix the declaration, not the grid.`,
    );
  }
  return { product, capped };
}

/** The power pre-flight (mandatory for forward claims). Pure math, mirrors the power table. */
export function powerPreflight(windowYears, expectedTrueSharpe) {
  const poweredHorizonYears = ((Z_975 + Z_80) / expectedTrueSharpe) ** 2;
  const requiredObservedSharpeDsr = Z_95 / Math.sqrt(windowYears);
  const requiredObservedSharpeT = Z_975 / Math.sqrt(windowYears);
  const underpowered = poweredHorizonYears > windowYears;
  return {
    windowYears,
    expectedTrueSharpe,
    poweredHorizonYears,
    requiredObservedSharpeDsr,
    requiredObservedSharpeT,
    underpowered,
    recommendation: underpowered
      ? `AUTO-DEFER as a SURVIVE attempt: 80% power needs ~${poweredHorizonYears.toFixed(1)}y > declared ${windowYears}y window. ` +
        `Run it as a forward WATCH (a KILL still counts — falsification power is asymmetric), or extend the window.`
      : `Powered: 80% power horizon ~${poweredHorizonYears.toFixed(1)}y fits the declared ${windowYears}y window.`,
  };
}

// ---------------------------------------------------------------------------
// Gauntlet invocation + verdict assembly
// ---------------------------------------------------------------------------

function runCheckData(repo, label, csvPath, lines) {
  const run = cryptoEdge(repo, ["check-data", csvPath]);
  const grade = /\*\*Grade:\*\* (PASS|WARN|FAIL)/.exec(run.stdout)?.[1] ?? "FAIL";
  lines.push(`- Data quality (${label}): **${grade}**`);
  if (run.status !== 0) {
    process.stderr.write(run.stdout + run.stderr);
    fail(`check-data graded ${label} FAIL — fix the data before submitting.`);
  }
}

function runSingle(repo, dir, sub, lines) {
  const args = [
    "validate",
    join(dir, sub.files.returnsCsv),
    "--baselines",
    join(dir, sub.files.panelCsv),
    "--trials",
    String(sub.declared.honestN),
    "--spec",
    join(dir, sub.files.hypothesisYaml),
    "--statistic",
    sub.strategy.statistic ?? "compoundReturn",
    "--seed",
    sub.submissionId,
    "--json",
  ];
  if (sub.files.costYaml) args.push("--cost", join(dir, sub.files.costYaml));
  const run = cryptoEdge(repo, args);
  if (run.status !== 0) {
    fail(`crypto-edge validate refused (exit ${run.status}):\n${run.stderr || run.stdout}`);
  }
  let json;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    fail("could not parse the verdict JSON from crypto-edge validate.");
  }
  lines.push(`### Verdict: **${json.verdict}** — binding gate: \`${json.bindingGate ?? "none"}\``);
  lines.push("");
  lines.push("| Gate | Status | Binding | Reason |");
  lines.push("| --- | --- | --- | --- |");
  for (const gate of json.gates) {
    lines.push(
      `| ${gate.id} | ${gate.status} | ${gate.binding ? "**yes**" : ""} | ${gate.reason.replaceAll("|", "\\|")} |`,
    );
  }
  return { verdict: json.verdict, bindingGate: json.bindingGate, json };
}

function runFamily(repo, dir, sub, iterations, lines) {
  const args = ["validate-family", join(dir, sub.files.strategyYaml), "--panel", join(dir, sub.files.panelCsv)];
  if (iterations !== undefined) args.push("--iterations", String(iterations));
  const run = cryptoEdge(repo, args);
  if (run.status !== 0) {
    fail(`crypto-edge validate-family refused (exit ${run.status}):\n${run.stderr || run.stdout}`);
  }
  const passed = /\*\*Outcome:\*\* PASS/.test(run.stdout);
  // A family PASS is a SURVIVE-CANDIDATE, not a SURVIVE: the maintainer must
  // reproduce it and the grid-best must still clear the full single-series
  // gauntlet (at the family's honest N) on data the search never saw.
  const verdict = passed ? "SURVIVE" : "KILL";
  lines.push(passed
    ? "### Family verdict: **PASS** (survive-candidate — maintainer reproduction + full single-series gauntlet on unseen data still required)"
    : "### Family verdict: **KILL** (luckiest-of-N, not an edge)");
  lines.push("");
  lines.push(run.stdout.trim());
  return { verdict, bindingGate: passed ? null : "family_max", json: { raw: run.stdout } };
}

const LABELS = {
  SURVIVE: "survive-candidate",
  PROMISING: "promising",
  KILL: "kill",
  DEFERRED: "deferred",
  INDETERMINATE: "indeterminate",
};

function runSubmission(dir, values, { checkOnly = false } = {}) {
  const repo = resolveRepo(values);
  const sub = loadSubmission(dir);
  const lines = [];
  lines.push(`## Community gauntlet — \`${sub.submissionId}\``);
  lines.push("");
  lines.push(`- **Author:** ${sub.author.name}${sub.author.github ? ` (@${sub.author.github})` : ""}`);
  lines.push(`- **Claim:** ${sub.claim.summary}`);
  lines.push(`- **Path:** ${sub.strategy.selectionMode === "searched_grid" ? "family-wise MAX-statistic (`validate-family`)" : "single-series 8-gate gauntlet (`validate`)"}`);
  lines.push(`- **Declared honest N:** ${sub.declared.honestN}`);
  lines.push(`- **Null:** ${sub.declared.null}${sub.declared.namedNull ? ` (${sub.declared.namedNull})` : ""}`);

  // Honesty locks.
  if (sub.strategy.selectionMode === "preregistered_single") {
    const hash = verifyPreregLock(repo, dir, sub);
    lines.push(`- **Prereg lock:** verified — \`${hash}\` reproduces from the submitted hypothesis spec`);
  } else {
    const { product, capped } = verifyGridN(repo, dir, sub);
    lines.push(`- **Grid N:** declared ${sub.declared.honestN} == grid product ${product}${capped !== product ? ` (CLI caps the family run at ${capped} configs)` : ""}`);
  }

  // Power pre-flight (mandatory for forward claims).
  let preflight;
  if (sub.claim.forward) {
    preflight = powerPreflight(sub.claim.forward.windowYears, sub.claim.forward.expectedTrueSharpe);
    lines.push(
      `- **Power pre-flight:** window ${preflight.windowYears}y, claimed true SR ${preflight.expectedTrueSharpe} -> ` +
        `80%-power horizon ~${preflight.poweredHorizonYears.toFixed(1)}y; observed-SR bars: ` +
        `${preflight.requiredObservedSharpeDsr.toFixed(2)} (DSR) / ${preflight.requiredObservedSharpeT.toFixed(2)} (t>=1.96). ` +
        `${preflight.underpowered ? "**UNDERPOWERED — SURVIVE capped at DEFERRED**" : "powered"}`,
    );
  }

  if (checkOnly) {
    lines.push("");
    lines.push("Schema, lock and pre-flight checks **passed** (gauntlet not run: check-only mode).");
    const text = lines.join("\n");
    process.stdout.write(`${text}\n`);
    return { verdict: "CHECK_ONLY", label: "checked", markdown: text };
  }

  // Data hygiene (the same gate CI uses: exit 2 on a FAIL grade).
  if (sub.files.returnsCsv) runCheckData(repo, "returns", join(dir, sub.files.returnsCsv), lines);
  runCheckData(repo, "panel", join(dir, sub.files.panelCsv), lines);
  lines.push("");

  // The gauntlet itself — committed primitives only.
  const iterations = values.iterations !== undefined ? Number(values.iterations) : undefined;
  const result =
    sub.strategy.selectionMode === "searched_grid"
      ? runFamily(repo, dir, sub, iterations, lines)
      : runSingle(repo, dir, sub, lines);

  // Power-wall cap: an underpowered forward window cannot certify; it can only KILL.
  let verdict = result.verdict;
  if (preflight?.underpowered && (verdict === "SURVIVE" || verdict === "PROMISING")) {
    lines.push("");
    lines.push(
      `> **Power-wall cap applied:** outcome ${verdict} on an underpowered forward window is recorded as ` +
        `**DEFERRED** (the declared ${preflight.windowYears}y window cannot reach 80% power at the claimed true Sharpe).`,
    );
    verdict = "DEFERRED";
  }

  const label = LABELS[verdict] ?? "indeterminate";
  lines.push("");
  if (sub.notes) lines.push(`> Submitter note: ${sub.notes}`);
  lines.push("");
  lines.push(`**LABEL:** \`gauntlet:${label}\` · *No auto-merge: every verdict — especially a survive-candidate — requires maintainer review and independent reproduction before it is recorded.*`);

  const markdown = lines.join("\n");
  process.stdout.write(`${markdown}\n`);
  // Machine-readable trailer for the CI workflow (greppable, stable).
  process.stdout.write(`\n::verdict::${verdict}\n::label::gauntlet:${label}\n`);

  if (values.out !== undefined) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, `${sub.submissionId}.comment.md`), `${markdown}\n`);
    writeFileSync(
      join(values.out, `${sub.submissionId}.verdict.json`),
      `${JSON.stringify({ submissionId: sub.submissionId, verdict, label: `gauntlet:${label}`, bindingGate: result.bindingGate, preflight: preflight ?? null, detail: result.json }, null, 2)}\n`,
    );
  }
  return { verdict, label, markdown };
}

// ---------------------------------------------------------------------------
// Selftest: run the committed example (which KILLs BY DESIGN) through the
// PUBLIC repo code and assert the planted-negative control behaves.
// ---------------------------------------------------------------------------

function selftest(values) {
  const candidates = [
    values.submission,
    join(HERE, "example-submission"), // staged layout (publish/community/)
    resolve(HERE, "..", "..", "submissions", "rsi2-overlay-example"), // public-repo layout
  ].filter(Boolean);
  const dir = candidates.find((c) => existsSync(join(c, "submission.json")));
  if (!dir) fail(`selftest: no example submission found (tried: ${candidates.join(", ")}).`);

  process.stdout.write(`community-runner selftest — example submission at ${dir}\n\n`);
  const { verdict } = runSubmission(dir, values);
  if (verdict !== "KILL") {
    process.stderr.write(
      `\nSELFTEST FAILED: the planted-KILL example returned ${verdict}, expected KILL. ` +
        `Either the example data drifted or a gate weakened — investigate before trusting any run.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    "\nSELFTEST PASSED: the kills-by-design example KILLed through the public gauntlet (planted-negative control intact).\n",
  );
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const { positionals, values, flags } = parseArgs(process.argv.slice(2));

if (flags.selftest) {
  selftest(values);
} else {
  const [command, dir] = positionals;
  if (command === "run" && dir) {
    runSubmission(resolve(dir), values);
  } else if (command === "check" && dir) {
    runSubmission(resolve(dir), values, { checkOnly: true });
  } else {
    process.stderr.write(
      [
        "community-runner — map a community submission onto the committed crypto-edge gauntlet.",
        "",
        "USAGE:",
        "  node community-runner.mjs run <submission-dir> [--repo <root>] [--iterations N] [--out <dir>]",
        "  node community-runner.mjs check <submission-dir> [--repo <root>]",
        "  node community-runner.mjs --selftest [--repo <root>] [--submission <dir>]",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
}
