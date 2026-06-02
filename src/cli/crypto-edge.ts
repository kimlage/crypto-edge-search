/**
 * `crypto-edge` — the lab's command-line front door to the anti-overfitting stack.
 *
 * The subcommands wrap the COMMITTED, individually-tested library functions (it does
 * NOT reimplement any statistics):
 *
 *   validate         — run the full single-series gauntlet (`validateStrategy`) on a
 *                      returns CSV and print the scientific verdict (KILL / PROMISING /
 *                      SURVIVE / INDETERMINATE) as Markdown or JSON. The scientific
 *                      verdict LEADS the summary; the legacy PASS/KILL is labelled the
 *                      "legacy binary verdict". With NO baselines the run is capped at
 *                      INDETERMINATE and REFUSES (exit 2) unless the operator passes
 *                      `--allow-missing-baselines` to acknowledge. A spec/flag that
 *                      declares a `searched_grid` selection mode is REFUSED here and
 *                      directed to `validate-family` (a grid-best needs the family-wise
 *                      null, not the single-series one).
 *   validate-family  — run the family-wise MAX-statistic surrogate
 *                      (`validateStrategyFamily`) over a searched config grid on a wide
 *                      asset panel, and print the family verdict + an evidence card.
 *   check-data       — parse a returns/panel CSV and print the data-quality grade
 *                      (PASS / WARN / FAIL); exit 2 when the grade is FAIL.
 *   init             — scaffold a hypothesis.yaml template to stdout (or `--out`).
 *   prereg           — freeze a HypothesisSpec's config into a pre-registration
 *                      manifest (`buildPreregistration`), print the SHA-256 hash that
 *                      LOCKS it (so an honest N=1 is earned), and flag a `searched_grid`
 *                      spec as requiring `validate-family`.
 *
 * Design contract (so this stays testable and well-behaved):
 *   - `runCli(argv)` is async and returns an EXIT CODE. It NEVER calls process.exit,
 *     so tests can assert on the returned code and on captured stdout/stderr.
 *   - A scientific verdict is a RESULT, not a failure: a run that completes returns 0
 *     even when the verdict is KILL. Exit 2 is reserved for usage / parse / file
 *     errors (a clear message is written to stderr).
 *   - All statistics come from `src/lib/**`; this file only parses args, reads files,
 *     wires the libraries together, and renders.
 *
 * The module-bottom entrypoint runs `runCli(process.argv.slice(2))` ONLY when the file
 * is invoked directly (guarded with import.meta.url), so importing it in a test is
 * side-effect-free.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReturnsCsv, parsePanelCsv } from "../lib/io/returns-csv";
import type { ParsedPanelCsv } from "../lib/io/returns-csv";
import {
  loadStrategySpec,
  loadCostSpec,
  costSpecToExecutionModel,
} from "../lib/spec/load-spec";
import type { StrategySpec } from "../lib/spec/types";
import { validateStrategy } from "../lib/validation/strategy-validator";
import type {
  StrategyValidatorOptions,
  BaselineSeries,
} from "../lib/validation/strategy-validator";
import {
  validateStrategyFamily,
  type StrategyFamily,
} from "../lib/validation/strategy-family-validator";
import type { ReturnSeriesStatistic } from "../lib/statistical-validation";
import {
  renderVerdictMarkdown,
  renderVerdictJson,
} from "../lib/report/report-renderer";
import { renderEvidenceCard } from "../lib/report/evidence-card";
import {
  dataQualityReport,
  panelQualityReport,
  type QualityGrade,
} from "../lib/data/data-quality";
import { parseSpecString } from "../lib/spec/load-spec";
import {
  loadHypothesisSpec,
  requiresFamilyValidation,
} from "../lib/spec/hypothesis-spec";
import { buildPreregistration } from "../lib/prereg/preregistration";

/** Sink for output so tests can capture without touching the real streams. */
export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const DEFAULT_IO: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const VALID_STATISTICS: readonly ReturnSeriesStatistic[] = [
  "compoundReturn",
  "mean",
  "sharpe",
];

/** Cap on the cartesian config grid so a fat spec cannot explode the family run. */
const MAX_FAMILY_CONFIGS = 256;

/**
 * Parse argv and dispatch to a subcommand. Returns an EXIT CODE; never throws to the
 * caller (all errors are caught, reported on stderr, and mapped to exit 2) and never
 * calls process.exit. `io` is injectable so tests can capture output.
 */
export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(usage());
    return 0;
  }

  try {
    switch (command) {
      case "validate":
        return runValidate(rest, io);
      case "validate-family":
        return runValidateFamily(rest, io);
      case "check-data":
        return runCheckData(rest, io);
      case "init":
        return runInit(rest, io);
      case "prereg":
        return runPrereg(rest, io);
      default:
        io.err(`crypto-edge: unknown command '${command}'.\n\n${usage()}`);
        return 2;
    }
  } catch (error) {
    io.err(`crypto-edge: ${errorMessage(error)}\n`);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: validate
// ---------------------------------------------------------------------------

/**
 * `validate <returns.csv> [flags]` — read a returns CSV, run the full single-series
 * gauntlet, and print the verdict. Returns 0 whenever the gauntlet RUNS (the verdict
 * is the result), 2 on a usage / parse / file error.
 */
function runValidate(args: string[], io: CliIo): number {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    io.out(usage());
    return 0;
  }

  const parsed = parseFlags(args);
  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    io.err(`crypto-edge validate: missing <returns.csv> argument.\n\n${usage()}`);
    return 2;
  }
  if (positionals.length > 1) {
    io.err(
      `crypto-edge validate: expected exactly one <returns.csv>, got ${positionals.length}.\n`,
    );
    return 2;
  }

  // SELECTION-MODE ENFORCEMENT (c): resolve the declared selection mode from the
  // explicit --selection-mode flag and/or a passed --spec file's `selection_mode`
  // field. A 'searched_grid' selection is a grid-best and MUST use the family-wise
  // null (validate-family), not the single-series gauntlet — so REFUSE with exit 2.
  const selectionMode = resolveSelectionMode(parsed, io);
  if (selectionMode === "searched_grid") {
    io.err(
      "crypto-edge validate: selection_mode is 'searched_grid' — a grid-best must be " +
        "scored against the FAMILY-WISE null, not the single-series gauntlet. " +
        "Re-run with 'crypto-edge validate-family <spec> --panel <panel.csv>'.\n",
    );
    return 2;
  }

  const returnsPath = positionals[0]!;
  const returnsText = readFileOrThrow(returnsPath);
  const csv = parseReturnsCsv(returnsText);

  const statistic = resolveStatistic(parsed.values.statistic);
  const trialCount = resolveTrialCount(parsed.values.trials, 1);
  const seed = parsed.values.seed ?? "crypto-edge-validate";

  const options: StrategyValidatorOptions = {
    trialCount,
    statistic,
    seed,
  };
  if (csv.positions && csv.positions.length === csv.returns.length) {
    options.cost = { position: csv.positions };
  }

  // Optional leverage-aware cost model from a CostSpec.
  if (parsed.values.cost !== undefined) {
    const costText = readFileOrThrow(parsed.values.cost);
    const costSpec = loadCostSpec(costText);
    options.costModel = costSpecToExecutionModel(costSpec);
    if (csv.positions && csv.positions.length === csv.returns.length) {
      options.costModelPositions = csv.positions;
    }
  }

  // Optional baselines panel: a wide date+assets CSV whose equal-weight portfolio and
  // first-asset (market) series seed the buy-and-hold / equal-weight baselines.
  if (parsed.values.baselines !== undefined) {
    const baselineText = readFileOrThrow(parsed.values.baselines);
    options.baselines = baselinesFromPanel(parsePanelCsv(baselineText), csv.returns.length);
  }
  if (parsed.flags.strict) {
    options.strictBaselines = true;
  }

  // NO-BASELINES ENFORCEMENT (a): without baselines the baselines gate cannot certify
  // and the scientific verdict is CAPPED at INDETERMINATE (not certified). Emit a LOUD
  // stderr warning, and REFUSE (exit 2) unless the operator explicitly acknowledges
  // with --allow-missing-baselines (or supplies --baselines).
  if (options.baselines === undefined) {
    io.err(
      "WARNING: no baselines supplied -> scientific verdict is capped at INDETERMINATE " +
        "(not certified). Pass --baselines <csv> or --allow-missing-baselines to acknowledge.\n",
    );
    if (!parsed.flags["allow-missing-baselines"]) {
      return 2;
    }
  }

  const verdict = validateStrategy(csv.returns, options);
  const meta = { hypothesisId: deriveHypothesisId(returnsPath) };

  if (parsed.flags.json) {
    io.out(`${JSON.stringify(renderVerdictJson(verdict, meta), null, 2)}\n`);
  } else {
    // The CLI's OWN summary line LEADS with the scientific verdict (the prominent,
    // certifying result) and labels the legacy PASS/KILL as the "legacy binary
    // verdict" — then the full Markdown report (renderVerdictMarkdown, which also
    // prioritizes the scientific verdict) follows.
    io.out(
      `Scientific verdict: ${verdict.scientificVerdict} ` +
        `(legacy binary verdict: ${verdict.verdict})\n\n`,
    );
    io.out(`${renderVerdictMarkdown(verdict, meta)}\n`);
  }

  // --out: write BOTH the .md and .json report into the directory.
  if (parsed.values.out !== undefined) {
    const dir = parsed.values.out;
    mkdirSync(dir, { recursive: true });
    const base = `${meta.hypothesisId}.verdict`;
    writeFileSync(resolve(dir, `${base}.md`), `${renderVerdictMarkdown(verdict, meta)}\n`);
    writeFileSync(
      resolve(dir, `${base}.json`),
      `${JSON.stringify(renderVerdictJson(verdict, meta), null, 2)}\n`,
    );
    io.err(`crypto-edge validate: wrote ${base}.md and ${base}.json to ${dir}\n`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: validate-family
// ---------------------------------------------------------------------------

/**
 * `validate-family <strategyspec> --panel <panel.csv> [flags]` — build the searched
 * config grid from the spec, run the family-wise MAX-statistic surrogate over a wide
 * asset panel, and print the family verdict + an evidence card. Returns 0 on a run,
 * 2 on a usage / parse / file error.
 */
function runValidateFamily(args: string[], io: CliIo): number {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    io.out(usage());
    return 0;
  }

  const parsed = parseFlags(args);
  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    io.err(
      `crypto-edge validate-family: missing <strategyspec.(yml|json)> argument.\n\n${usage()}`,
    );
    return 2;
  }
  if (parsed.values.panel === undefined) {
    io.err("crypto-edge validate-family: missing required --panel <panel.csv>.\n");
    return 2;
  }

  const specPath = positionals[0]!;
  const spec = loadStrategySpec(readFileOrThrow(specPath));
  const panel = parsePanelCsv(readFileOrThrow(parsed.values.panel));

  const iterations = resolveTrialCount(parsed.values.iterations, spec.surrogate.iterations);
  const statistic = resolveSpecStatistic(spec);
  const configs = buildConfigGrid(spec);

  const family: StrategyFamily<ParsedPanelCsv, FamilyConfig> = {
    id: spec.family,
    configs,
    buildReturns: (p, config) => buildReturns(p, config),
    makeSurrogatePanel: (p, seed) => makeSurrogatePanel(p, seed),
  };

  const verdict = validateStrategyFamily(panel, family, {
    iterations,
    statistic,
    seed: spec.strategy_id,
  });

  // Family verdict header: real best vs surr95(max), family-wise p, honest N.
  const lines: string[] = [];
  lines.push(`# Family verdict — ${spec.strategy_id} (${spec.family})`);
  lines.push("");
  lines.push(`- **Outcome:** ${verdict.passed ? "PASS (real edge clears the family-wise null)" : "KILL (luckiest-of-N, not an edge)"}`);
  lines.push(`- **Statistic:** ${verdict.statistic}`);
  lines.push(`- **Real grid-best ${verdict.statistic}:** ${verdict.realBestStat.toFixed(5)}`);
  lines.push(`- **Surrogate null surr${Math.round(verdict.quantile * 100)}(grid-max):** ${verdict.surr95.toFixed(5)}`);
  lines.push(`- **Family-wise p (surrogateMaxP):** ${verdict.surrogateMaxP.toFixed(4)}`);
  lines.push(`- **Honest N (configs searched):** ${verdict.honestN}`);
  lines.push(`- **Surrogate draws:** ${verdict.iterations}`);
  lines.push(`- **Best config:** ${JSON.stringify(verdict.bestConfig)}`);
  lines.push("");
  lines.push(verdict.reason);
  lines.push("");
  lines.push(renderEvidenceCard(familyEvidenceCard(spec, verdict)));
  lines.push("");
  io.out(`${lines.join("\n")}\n`);

  if (parsed.values.out !== undefined) {
    const dir = parsed.values.out;
    mkdirSync(dir, { recursive: true });
    const base = `${deriveHypothesisId(specPath)}.family`;
    writeFileSync(resolve(dir, `${base}.md`), `${lines.join("\n")}\n`);
    writeFileSync(resolve(dir, `${base}.json`), `${JSON.stringify(familyJson(spec, verdict), null, 2)}\n`);
    io.err(`crypto-edge validate-family: wrote ${base}.md and ${base}.json to ${dir}\n`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: check-data
// ---------------------------------------------------------------------------

/**
 * `check-data <csv> [flags]` — parse a returns CSV (or, with --panel-mode / a wide
 * date+assets CSV, a panel) and run the deterministic data-quality report. Prints the
 * overall grade (PASS / WARN / FAIL) plus the reasons that drove it. Returns 0 for
 * PASS/WARN (a WARN is a caveat, not a stop), and 2 when the grade is FAIL — so a CI
 * step can gate a backtest on data hygiene the same way it gates on significance.
 */
function runCheckData(args: string[], io: CliIo): number {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    io.out(usage());
    return 0;
  }

  const parsed = parseFlags(args);
  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    io.err(`crypto-edge check-data: missing <csv> argument.\n\n${usage()}`);
    return 2;
  }
  if (positionals.length > 1) {
    io.err(
      `crypto-edge check-data: expected exactly one <csv>, got ${positionals.length}.\n`,
    );
    return 2;
  }

  const csvPath = positionals[0]!;
  const text = readFileOrThrow(csvPath);

  // Decide the shape: a wide panel iff the header declares more than one asset column
  // (i.e. parsePanelCsv succeeds AND finds ≥2 assets). Otherwise treat it as a long
  // returns series. We probe panel first and fall back to the returns parser so a
  // plain `date,return` file checks the returns column, not a 1-wide "panel".
  let grade: QualityGrade;
  let reasons: string[];
  const panel = tryParsePanel(text);
  if (panel && panel.assets.length >= 2) {
    const report = panelQualityReport({
      dates: panel.dates,
      assets: panel.assets,
      panel: panel.panel,
    });
    grade = report.grade;
    reasons = report.reasons;
    io.out(
      `# Data quality — ${deriveHypothesisId(csvPath)} (panel: ${panel.assets.length} assets, ${panel.panel.length} rows)\n`,
    );
  } else {
    const csv = parseReturnsCsv(text);
    const report = dataQualityReport({
      name: deriveHypothesisId(csvPath),
      values: csv.returns,
      dates: csv.dates,
    });
    grade = report.grade;
    reasons = report.reasons;
    io.out(
      `# Data quality — ${deriveHypothesisId(csvPath)} (returns: ${csv.returns.length} rows)\n`,
    );
  }

  io.out(`\n- **Grade:** ${grade}\n`);
  if (reasons.length === 0) {
    io.out("- No issues found — series is clean.\n");
  } else {
    io.out("- Reasons:\n");
    for (const reason of reasons) io.out(`  - ${reason}\n`);
  }

  // FAIL is a hard stop (exit 2); PASS and WARN both proceed (0).
  return grade === "FAIL" ? 2 : 0;
}

/** Try to parse the text as a wide panel; return undefined if it is not panel-shaped. */
function tryParsePanel(text: string): ParsedPanelCsv | undefined {
  try {
    return parsePanelCsv(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: init
// ---------------------------------------------------------------------------

/**
 * `init [--out <file>]` — scaffold a commented hypothesis.yaml template the operator
 * fills in before running the gauntlet. Prints to stdout by default, or writes to
 * `--out <file>` (a note goes to stderr so stdout stays the pure artifact). Always 0
 * on success; 2 only on a file-write error.
 */
function runInit(args: string[], io: CliIo): number {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    io.out(usage());
    return 0;
  }

  const parsed = parseFlags(args);
  const template = hypothesisTemplate();

  if (parsed.values.out !== undefined) {
    const outPath = parsed.values.out;
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, template);
    } catch (error) {
      throw new Error(`cannot write template to '${outPath}': ${errorMessage(error)}`);
    }
    io.err(`crypto-edge init: wrote hypothesis template to ${outPath}\n`);
    return 0;
  }

  io.out(template);
  return 0;
}

/**
 * The scaffolded hypothesis.yaml: a fully-formed, commented StrategySpec the
 * loader (`loadStrategySpec`) accepts, plus the `selection_mode` knob the CLI reads
 * to route between `validate` (preregistered_single) and `validate-family`
 * (searched_grid). Pure: a constant string, no I/O, no clock.
 */
function hypothesisTemplate(): string {
  return [
    "# crypto-edge hypothesis template. Fill this in, then run:",
    "#   crypto-edge check-data <returns.csv>      # gate on data hygiene first",
    "#   crypto-edge validate <returns.csv> --baselines <panel.csv>   # single, preregistered",
    "#   crypto-edge validate-family this.yaml --panel <panel.csv>    # searched grid",
    "#",
    "# selection_mode pins HOW the config was chosen, so the right null is used:",
    "#   preregistered_single -> one config fixed BEFORE seeing the data (single-series null)",
    "#   searched_grid        -> the best of a searched grid (FAMILY-WISE max null; use validate-family)",
    "selection_mode: preregistered_single",
    "",
    "strategy_id: my-hypothesis",
    "family: my_family",
    "cadence: daily # minute|minute5|minute15|hourly|hourly4|funding8h|daily|weekly|yearly",
    "universe:",
    "  type: top_by_volume",
    "  max_assets: 30",
    "  include_delisted: true # survivorship-free: keep delisted names",
    "configs:",
    "  # param -> the values searched. The product of these lengths is the HONEST N.",
    "  lookback_days: [20, 40, 60, 90]",
    "  hold_days: [1, 5, 10]",
    "  long_short: [true, false]",
    "trial_count_policy:",
    "  mode: grid # honest N = product of the configs grid sizes",
    "cost_model:",
    "  taker_bps_per_side: 5",
    "  maker_bps_per_side: 1",
    "  maker_fraction: 0",
    "  slippage_bps: 2",
    "baselines:",
    "  - buy_and_hold",
    "  - equal_weight",
    "  - random_lottery",
    "  - linear_one_layer",
    "surrogate:",
    "  mode: family_max # phase|block|cross_sectional|family_max",
    '  "null": structure # quote: bare null is the YAML null literal, not a string',
    "  iterations: 200",
    "holdout:",
    "  mode: tail",
    "  fraction: 0.20 # reserve the most-recent 20% as a consume-once vault",
    "statistic: sharpe # compoundReturn|mean|sharpe",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: prereg
// ---------------------------------------------------------------------------

/**
 * `prereg <hypothesis.(yml|json)> [--created-at <iso>] [--out <file>] [--json]` —
 * load a HypothesisSpec, FREEZE its scientific claim into a pre-registration manifest
 * (`buildPreregistration`), and print the SHA-256 `configHash` that LOCKS it. That
 * lock is what makes an honest N=1 defensible: a later run can prove (via the hash)
 * that the config was not re-pointed after the data was seen.
 *
 * A `searched_grid` spec is NOT a single pre-registered hypothesis: it is flagged
 * (via `requiresFamilyValidation`) and the operator is directed to `validate-family`,
 * whose family-wise null deflates by the real config count rather than pretending N=1.
 * The manifest is still emitted (the grid is worth freezing), but a LOUD note is
 * written to stderr so a grid can never quietly claim the single-series N=1.
 *
 * `createdAt` is the caller's responsibility (the prereg library never reads the
 * clock): `--created-at <iso>` pins it for a deterministic, reproducible manifest;
 * absent it, the current wall-clock instant is used (the CLI owns the clock here).
 * Returns 0 on a successful freeze, 2 on a usage / parse / file error.
 */
function runPrereg(args: string[], io: CliIo): number {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    io.out(usage());
    return 0;
  }

  const parsed = parseFlags(args);
  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    io.err(`crypto-edge prereg: missing <hypothesis.(yml|json)> argument.\n\n${usage()}`);
    return 2;
  }
  if (positionals.length > 1) {
    io.err(
      `crypto-edge prereg: expected exactly one <hypothesis.(yml|json)>, got ${positionals.length}.\n`,
    );
    return 2;
  }

  const specPath = positionals[0]!;
  const spec = loadHypothesisSpec(readFileOrThrow(specPath));

  // createdAt is the caller's to supply; default to the current instant (the only
  // place this CLI reads the clock, and only when the operator did not pin it).
  const createdAt = parsed.values["created-at"] ?? new Date().toISOString();

  const manifest = buildPreregistration({
    hypothesisId: spec.id,
    frozenConfig: spec,
    mechanism: spec.mechanism,
    createdAt,
  });

  const needsFamily = requiresFamilyValidation(spec);

  if (parsed.flags.json) {
    io.out(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    const lines: string[] = [];
    lines.push(`# Pre-registration — ${manifest.hypothesisId}`);
    lines.push("");
    lines.push(`- **Locked config hash:** ${manifest.configHash}`);
    lines.push(`- **Selection mode:** ${spec.search.selection_mode}`);
    lines.push(`- **Honest N (configCount):** ${spec.search.configCount}`);
    lines.push(`- **Frozen at:** ${manifest.createdAt}`);
    lines.push("");
    if (needsFamily) {
      lines.push(
        "This is a SEARCHED GRID — it cannot honestly claim N=1. Validate it with " +
          "'crypto-edge validate-family <spec> --panel <panel.csv>' (the family-wise " +
          "null deflates by the real config count, not 1).",
      );
    } else {
      lines.push(
        "This is a PRE-REGISTERED SINGLE config (honest N=1). The hash above LOCKS it: " +
          "a later run must reproduce it before claiming the N=1 the lock earns.",
      );
    }
    lines.push("");
    io.out(`${lines.join("\n")}\n`);
  }

  // A searched grid still gets a LOUD stderr flag so it can never quietly proceed as
  // a single-series pre-registration.
  if (needsFamily) {
    io.err(
      "crypto-edge prereg: selection_mode is 'searched_grid' — this is NOT an honest " +
        "N=1 pre-registration. Use 'crypto-edge validate-family' (family-wise null).\n",
    );
  }

  if (parsed.values.out !== undefined) {
    const outPath = parsed.values.out;
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      throw new Error(`cannot write manifest to '${outPath}': ${errorMessage(error)}`);
    }
    io.err(`crypto-edge prereg: wrote pre-registration manifest to ${outPath}\n`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Family default rule: a cross-sectional, dollar-neutral long-top/short-bottom
// strategy the spec's configs parameterize.
// ---------------------------------------------------------------------------

/** One realized config of the searched grid: a flat param-name -> value map. */
export type FamilyConfig = Record<string, string | number | boolean>;

/**
 * The DEFAULT cross-sectional rule the spec parameterizes. For every period t we rank
 * the assets by a per-asset z-score of their trailing `window` returns (a channel-
 * position / momentum signal), go LONG the top fraction and SHORT the bottom fraction
 * dollar-neutrally (equal weight within each leg), and book next-period returns. The
 * sleeve is rebalanced every `hold` periods (lower turnover for larger hold).
 *
 * The config knobs are read by NAME with sensible aliases so it works out of the box
 * with the example spec (`lookback_days`, `hold_days`, `long_short`) without the user
 * having to learn a bespoke parameter vocabulary:
 *   - window  ← lookback_days | lookback | window | channel_periods (default 20)
 *   - hold    ← hold_days | hold | rebalance (default 1)
 *   - topFrac ← top_fraction | top_frac (default 0.34 ⇒ ~top/bottom third)
 *   - longShort ← long_short (default true). When false, it is long-only top minus the
 *                 cross-sectional mean (still cross-sectional, not dollar-neutral).
 *
 * Pure & deterministic in (panel, config): no RNG, no clock. Non-finite cells are
 * treated as 0 returns. This is the function the family-wise surrogate rebuilds on
 * every (real or surrogate) panel.
 */
export function buildReturns(panel: ParsedPanelCsv, config: FamilyConfig): number[] {
  const matrix = panel.panel; // matrix[t][asset]
  const nRows = matrix.length;
  const nAssets = panel.assets.length;
  if (nRows < 2 || nAssets < 2) return [];

  const window = clampInt(numParam(config, ["window", "lookback_days", "lookback", "channel_periods"], 20), 1, Math.max(1, nRows - 1));
  const hold = clampInt(numParam(config, ["hold", "hold_days", "rebalance"], 1), 1, Math.max(1, nRows));
  const topFrac = clamp01(numParam(config, ["top_fraction", "top_frac"], 0.34));
  const longShort = boolParam(config, ["long_short", "longShort"], true);
  const legSize = Math.max(1, Math.floor(nAssets * topFrac));

  const out: number[] = [];
  let weights: number[] = new Array<number>(nAssets).fill(0);

  for (let t = window; t < nRows - 1; t += 1) {
    // Re-rank only on a rebalance boundary; otherwise carry the prior weights.
    if ((t - window) % hold === 0) {
      const signal = crossSectionalSignal(matrix, t, window, nAssets);
      weights = dollarNeutralWeights(signal, legSize, longShort);
    }
    // Book NEXT-period asset returns against the held weights (no look-ahead: the
    // signal uses returns up to and including t, the P&L is the t+1 bar).
    let sleeve = 0;
    const next = matrix[t + 1]!;
    for (let a = 0; a < nAssets; a += 1) {
      sleeve += (weights[a] ?? 0) * finiteOr0(next[a]);
    }
    out.push(sleeve);
  }
  return out;
}

/** Per-asset trailing-window z-score signal at time t (channel position / momentum). */
function crossSectionalSignal(
  matrix: readonly number[][],
  t: number,
  window: number,
  nAssets: number,
): number[] {
  const signal = new Array<number>(nAssets).fill(0);
  for (let a = 0; a < nAssets; a += 1) {
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let k = t - window + 1; k <= t; k += 1) {
      const v = finiteOr0(matrix[k]?.[a]);
      sum += v;
      sumSq += v * v;
      count += 1;
    }
    const mean = count > 0 ? sum / count : 0;
    const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
    const std = Math.sqrt(variance);
    // Channel position: cumulative trailing mean normalized by its own volatility. A
    // high z-score = strong recent momentum (the cross-sectional signal we rank on).
    signal[a] = std > 1e-12 ? mean / std : 0;
  }
  return signal;
}

/**
 * Dollar-neutral weights: long the top `legSize` assets by signal, short the bottom
 * `legSize` (equal weight within each leg, leg-sum normalized so each side is ±1).
 * When `longShort` is false: long-only the top leg, demeaned cross-sectionally so the
 * sleeve still reads a cross-sectional spread rather than market beta.
 */
function dollarNeutralWeights(signal: readonly number[], legSize: number, longShort: boolean): number[] {
  const n = signal.length;
  const order = signal
    .map((stat, index) => ({ stat, index }))
    .sort((left, right) => right.stat - left.stat || left.index - right.index);
  const weights = new Array<number>(n).fill(0);
  const top = order.slice(0, Math.min(legSize, n));
  const longW = top.length > 0 ? 1 / top.length : 0;
  for (const { index } of top) weights[index] = longW;

  if (longShort) {
    const bottom = order.slice(Math.max(0, n - legSize));
    const shortW = bottom.length > 0 ? 1 / bottom.length : 0;
    for (const { index } of bottom) weights[index] = (weights[index] ?? 0) - shortW;
  } else {
    // Long-only minus the cross-sectional mean weight, so it is still cross-sectional.
    const meanW = 1 / n;
    for (let a = 0; a < n; a += 1) weights[a] = (weights[a] ?? 0) - meanW;
  }
  return weights;
}

/**
 * The cross-sectional SHUFFLE surrogate: keep each asset's marginal return path but
 * permute WHICH asset column gets which path, destroying genuine cross-asset
 * structure (rotation / lead-lag / the long-top-short-bottom spread the family
 * exploits) while preserving every marginal distribution. Pure & deterministic in
 * (panel, seed): the column permutation is drawn from a seeded RNG.
 */
export function makeSurrogatePanel(panel: ParsedPanelCsv, seed: number): ParsedPanelCsv {
  const nAssets = panel.assets.length;
  const random = seededRandom(seed);
  const order = panel.assets.map((_, i) => i);
  // Fisher-Yates on the column index order.
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  const shuffled = panel.panel.map((row) => {
    const newRow = new Array<number>(nAssets).fill(0);
    for (let a = 0; a < nAssets; a += 1) newRow[a] = finiteOr0(row[order[a]!]);
    return newRow;
  });
  return { dates: panel.dates, assets: panel.assets, panel: shuffled };
}

/**
 * Build the searched config grid as the cartesian product of the spec's `configs`
 * parameter-value lists, capped at MAX_FAMILY_CONFIGS so a fat spec cannot explode the
 * run (the cap is deterministic: the first N products in declared order). honest N for
 * the family-wise correction is the number of configs actually built.
 */
export function buildConfigGrid(spec: StrategySpec): FamilyConfig[] {
  const keys = Object.keys(spec.configs);
  if (keys.length === 0) return [{}];
  let grid: FamilyConfig[] = [{}];
  for (const key of keys) {
    const values = spec.configs[key] ?? [];
    const next: FamilyConfig[] = [];
    for (const partial of grid) {
      for (const value of values) {
        next.push({ ...partial, [key]: value });
        if (next.length >= MAX_FAMILY_CONFIGS) break;
      }
      if (next.length >= MAX_FAMILY_CONFIGS) break;
    }
    grid = next;
    if (grid.length >= MAX_FAMILY_CONFIGS) break;
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Rendering helpers for the family card / JSON
// ---------------------------------------------------------------------------

function familyEvidenceCard(
  spec: StrategySpec,
  verdict: ReturnType<typeof validateStrategyFamily<ParsedPanelCsv, FamilyConfig>>,
): Parameters<typeof renderEvidenceCard>[0] {
  return {
    hypothesisId: spec.strategy_id,
    verdict: verdict.passed ? "SURVIVE" : "KILL",
    belief: `${spec.family}: a searched cross-sectional long-top/short-bottom family on ${spec.universe.max_assets} assets predicts forward returns`,
    tested: `family-wise MAX-statistic surrogate (cross-sectional shuffle null), honest N=${verdict.honestN}, ${verdict.iterations} draws, scored on ${verdict.statistic}`,
    bestInSample: `grid-best ${verdict.statistic}=${verdict.realBestStat.toFixed(4)} (config ${JSON.stringify(verdict.bestConfig)})`,
    bindingGate: verdict.passed ? null : "family_max",
    decisiveNumber: `familyP=${verdict.surrogateMaxP.toFixed(3)} vs surr${Math.round(verdict.quantile * 100)}(max)=${verdict.surr95.toFixed(4)}`,
    whyItDied: verdict.passed
      ? "survived — the real grid-best beats the surrogate grid-maximum"
      : "the best of N configs is no better than the best of N structure-less configs (luckiest-of-N, not an edge)",
    whatWouldReviveIt: `real grid-best ${verdict.statistic} > surr${Math.round(verdict.quantile * 100)} of the surrogate grid-maxima at honest N=${verdict.honestN}`,
  };
}

function familyJson(
  spec: StrategySpec,
  verdict: ReturnType<typeof validateStrategyFamily<ParsedPanelCsv, FamilyConfig>>,
): Record<string, unknown> {
  return {
    strategyId: spec.strategy_id,
    family: spec.family,
    statistic: verdict.statistic,
    passed: verdict.passed,
    realBestStat: verdict.realBestStat,
    surr95: verdict.surr95,
    surrogateMaxP: verdict.surrogateMaxP,
    honestN: verdict.honestN,
    iterations: verdict.iterations,
    quantile: verdict.quantile,
    bestConfig: verdict.bestConfig,
    bestConfigIndex: verdict.bestConfigIndex,
    reason: verdict.reason,
  };
}

// ---------------------------------------------------------------------------
// Baselines from a panel
// ---------------------------------------------------------------------------

/**
 * Derive baseline series from a wide asset panel: the equal-weight portfolio (mean
 * across assets per period) and a "market" series (the first asset column). Both are
 * trimmed to at most `maxLen` periods so they align with the strategy window.
 */
function baselinesFromPanel(panel: ParsedPanelCsv, maxLen: number): BaselineSeries {
  const nAssets = panel.assets.length;
  const equalWeight: number[] = [];
  const market: number[] = [];
  const len = Math.min(panel.panel.length, maxLen);
  for (let t = 0; t < len; t += 1) {
    const row = panel.panel[t] ?? [];
    let sum = 0;
    for (let a = 0; a < nAssets; a += 1) sum += finiteOr0(row[a]);
    equalWeight.push(nAssets > 0 ? sum / nAssets : 0);
    market.push(finiteOr0(row[0]));
  }
  return { marketReturns: market, equalWeightReturns: equalWeight };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  /** Flags that take a value: --key <value> or --key=<value>. */
  values: Record<string, string | undefined>;
  /** Boolean flags: --strict, --json. */
  flags: Record<string, boolean>;
}

const VALUE_FLAGS = new Set([
  "baselines",
  "trials",
  "statistic",
  "cost",
  "seed",
  "out",
  "panel",
  "iterations",
  "selection-mode",
  "spec",
  "created-at",
]);
const BOOL_FLAGS = new Set(["strict", "json", "allow-missing-baselines"]);

/** Selection modes the CLI understands (whence the validate vs. validate-family split). */
const VALID_SELECTION_MODES = ["preregistered_single", "searched_grid"] as const;
type SelectionMode = (typeof VALID_SELECTION_MODES)[number];

/**
 * Minimal, dependency-free arg parser. Supports `--key value`, `--key=value`, boolean
 * `--flag`, and bare positionals. Unknown `--flags` raise a clear error rather than
 * being silently swallowed (a typo'd flag must fail loudly).
 */
function parseFlags(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values: Record<string, string | undefined> = {};
  const flags: Record<string, boolean> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
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
        const next = args[i + 1];
        if (next === undefined) {
          throw new Error(`flag --${key} requires a value.`);
        }
        values[key] = next;
        i += 1;
      }
      continue;
    }
    throw new Error(`unknown flag --${key}.`);
  }

  return { positionals, values, flags };
}

// ---------------------------------------------------------------------------
// Small resolvers + utilities
// ---------------------------------------------------------------------------

/**
 * Resolve the declared SELECTION MODE for a `validate` run from two sources:
 *   1. the explicit `--selection-mode <preregistered_single|searched_grid>` flag, and
 *   2. a `--spec <hypothesis.(yml|json)>` file that declares a top-level
 *      `selection_mode` field.
 * When BOTH are present they must AGREE (a contradiction fails loudly). Returns the
 * resolved mode, or undefined when neither source declares one (the default, single,
 * pre-registered path). Throws (mapped to exit 2) on an invalid value or a conflict.
 */
function resolveSelectionMode(parsed: ParsedArgs, io: CliIo): SelectionMode | undefined {
  const flagMode = parsed.values["selection-mode"];
  let fromFlag: SelectionMode | undefined;
  if (flagMode !== undefined) {
    if (!VALID_SELECTION_MODES.includes(flagMode as SelectionMode)) {
      throw new Error(
        `--selection-mode must be one of [${VALID_SELECTION_MODES.join(", ")}], got '${flagMode}'.`,
      );
    }
    fromFlag = flagMode as SelectionMode;
  }

  let fromSpec: SelectionMode | undefined;
  if (parsed.values.spec !== undefined) {
    const specText = readFileOrThrow(parsed.values.spec);
    const declared = readSelectionModeFromSpec(specText);
    if (declared !== undefined) {
      if (!VALID_SELECTION_MODES.includes(declared as SelectionMode)) {
        throw new Error(
          `--spec selection_mode must be one of [${VALID_SELECTION_MODES.join(", ")}], got '${declared}'.`,
        );
      }
      fromSpec = declared as SelectionMode;
    }
  }

  if (fromFlag !== undefined && fromSpec !== undefined && fromFlag !== fromSpec) {
    throw new Error(
      `selection_mode conflict: --selection-mode '${fromFlag}' contradicts the spec's '${fromSpec}'.`,
    );
  }
  // Silence the unused-io lint without changing behaviour: io is reserved for future
  // advisory notes; the conflict above is the only diagnostic and is thrown, not printed.
  void io;
  return fromFlag ?? fromSpec;
}

/** Read an OPTIONAL top-level `selection_mode` from a hypothesis/strategy spec string. */
function readSelectionModeFromSpec(specText: string): string | undefined {
  const obj = parseSpecString(specText, "Spec");
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const value = (obj as Record<string, unknown>)["selection_mode"];
  return typeof value === "string" ? value : undefined;
}

function resolveStatistic(raw: string | undefined): ReturnSeriesStatistic {
  if (raw === undefined) return "compoundReturn";
  if (!VALID_STATISTICS.includes(raw as ReturnSeriesStatistic)) {
    throw new Error(
      `--statistic must be one of [${VALID_STATISTICS.join(", ")}], got '${raw}'.`,
    );
  }
  return raw as ReturnSeriesStatistic;
}

function resolveSpecStatistic(spec: StrategySpec): ReturnSeriesStatistic {
  // The family-wise surrogate tests STRUCTURE edges; default to Sharpe (what the
  // cross-sectional shuffle null can actually discriminate) unless the spec pins one.
  return (spec.statistic as ReturnSeriesStatistic | undefined) ?? "sharpe";
}

function resolveTrialCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`expected a positive integer, got '${raw}'.`);
  }
  return Math.floor(value);
}

function numParam(config: FamilyConfig, aliases: readonly string[], fallback: number): number {
  for (const alias of aliases) {
    const value = config[alias];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return fallback;
}

function boolParam(config: FamilyConfig, aliases: readonly string[], fallback: boolean): boolean {
  for (const alias of aliases) {
    const value = config[alias];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }
  return fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function finiteOr0(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function seededRandom(seed: number | string): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Read a file as UTF-8, raising a CLEAR, located error on failure (mapped to exit 2). */
function readFileOrThrow(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read file '${path}': ${errorMessage(error)}`);
  }
}

/** A stable hypothesis id from a path: the basename without its extension. */
function deriveHypothesisId(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.length > 0 ? stem : "unnamed-strategy";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Usage text for both subcommands. */
function usage(): string {
  return [
    "crypto-edge — anti-overfitting validation CLI",
    "",
    "USAGE:",
    "  crypto-edge validate <returns.csv> [options]",
    "  crypto-edge validate-family <strategyspec.(yml|json)> --panel <panel.csv> [options]",
    "  crypto-edge check-data <csv>",
    "  crypto-edge init [--out <file>]",
    "  crypto-edge prereg <hypothesis.(yml|json)> [--out <manifest.json>] [--created-at <iso>]",
    "  crypto-edge --help",
    "",
    "validate — run the full single-series gauntlet on a returns CSV.",
    "  The summary LEADS with the scientific verdict; the PASS/KILL is the legacy",
    "  binary verdict. With NO baselines the verdict is capped at INDETERMINATE and the",
    "  run REFUSES (exit 2) unless --allow-missing-baselines is passed to acknowledge.",
    "  <returns.csv>            Long CSV with a returns column (+ optional date/position).",
    "  --baselines <csv>        Wide date+assets panel for B&H / equal-weight baselines.",
    "  --allow-missing-baselines  Proceed without baselines (verdict capped INDETERMINATE).",
    "  --selection-mode <m>     preregistered_single | searched_grid. 'searched_grid' is",
    "                           REFUSED here -> use validate-family (family-wise null).",
    "  --spec <hyp.(yml|json)>  Read selection_mode (and route) from a hypothesis spec.",
    "  --trials <N>             Honest trial count for DSR / haircut (default 1).",
    "  --statistic <stat>       compoundReturn | mean | sharpe (default compoundReturn).",
    "  --cost <costspec.(yml|json)>  Leverage-aware cost model (CostSpec).",
    "  --strict                 Treat missing baselines as a hard failure (INDETERMINATE).",
    "  --seed <s>               Seed for the surrogate/bootstrap nulls.",
    "  --out <dir>              Write <id>.verdict.md and .json into <dir>.",
    "  --json                   Print the verdict as JSON instead of Markdown.",
    "",
    "validate-family — family-wise MAX-statistic surrogate over a searched config grid.",
    "  <strategyspec.(yml|json)>  StrategySpec whose `configs` define the searched grid.",
    "  --panel <panel.csv>      Wide date+assets panel the family trades (REQUIRED).",
    "  --iterations <N>         Surrogate grid-max draws (default: spec.surrogate.iterations).",
    "  --out <dir>              Write <id>.family.md and .json into <dir>.",
    "",
    "check-data — parse a returns/panel CSV and grade its data quality.",
    "  <csv>                    A long returns CSV or a wide date+assets panel CSV.",
    "                           Prints PASS/WARN/FAIL; exit 2 when the grade is FAIL.",
    "",
    "init — scaffold a hypothesis.yaml template.",
    "  --out <file>             Write the template to <file> (default: print to stdout).",
    "",
    "prereg — freeze a HypothesisSpec's config into a pre-registration manifest.",
    "  <hypothesis.(yml|json)>  A HypothesisSpec (loadHypothesisSpec) to freeze.",
    "  --out <manifest.json>    Write the manifest JSON to <file> (hash always printed).",
    "  --created-at <iso>       Pin the manifest timestamp (default: now). The library",
    "                           never reads the clock, so this stays deterministic.",
    "                           A 'searched_grid' spec is flagged: use validate-family.",
    "",
    "EXIT CODES:",
    "  0  the gauntlet RAN — the scientific verdict (KILL/PROMISING/SURVIVE/INDETERMINATE)",
    "     is the RESULT, not a failure. (check-data: a PASS or WARN grade.)",
    "  2  usage / parse / file error (a clear message is written to stderr); also: validate",
    "     refusing on missing baselines or a 'searched_grid' selection, or check-data FAIL.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint — only when invoked directly (so importing this file is side-effect-free)
// ---------------------------------------------------------------------------

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`crypto-edge: ${errorMessage(error)}\n`);
      process.exitCode = 2;
    });
}
