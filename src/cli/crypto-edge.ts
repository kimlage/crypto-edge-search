/**
 * `crypto-edge` — the lab's command-line front door to the anti-overfitting stack.
 *
 * Two subcommands wrap the COMMITTED, individually-tested library functions (it does
 * NOT reimplement any statistics):
 *
 *   validate         — run the full single-series gauntlet (`validateStrategy`) on a
 *                      returns CSV and print the scientific verdict (KILL / PROMISING /
 *                      SURVIVE / INDETERMINATE) as Markdown or JSON.
 *   validate-family  — run the family-wise MAX-statistic surrogate
 *                      (`validateStrategyFamily`) over a searched config grid on a wide
 *                      asset panel, and print the family verdict + an evidence card.
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
import { resolve } from "node:path";
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

  const verdict = validateStrategy(csv.returns, options);
  const meta = { hypothesisId: deriveHypothesisId(returnsPath) };

  if (parsed.flags.json) {
    io.out(`${JSON.stringify(renderVerdictJson(verdict, meta), null, 2)}\n`);
  } else {
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
]);
const BOOL_FLAGS = new Set(["strict", "json"]);

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
    "  crypto-edge --help",
    "",
    "validate — run the full single-series gauntlet on a returns CSV.",
    "  <returns.csv>            Long CSV with a returns column (+ optional date/position).",
    "  --baselines <csv>        Wide date+assets panel for B&H / equal-weight baselines.",
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
    "EXIT CODES:",
    "  0  the gauntlet RAN — the scientific verdict (KILL/PROMISING/SURVIVE/INDETERMINATE)",
    "     is the RESULT, not a failure.",
    "  2  usage / parse / file error (a clear message is written to stderr).",
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
