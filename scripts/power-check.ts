/**
 * power-check — pre-flight power gate for pre-registered forward tests.
 *
 * Implements PROJECT_REVIEW_2026-06-09.md §3 ("the power wall") as a CLI.
 *
 * Usage (via tsx):
 *   npx tsx scripts/power-check.ts
 *       Print both §3 tables (required observed Sharpe by window; powered
 *       horizon by true Sharpe).
 *
 *   npx tsx scripts/power-check.ts --days 182
 *       Required observed annualized Sharpe for a window of N daily
 *       observations (DSR >= 0.95 and t >= 1.96 criteria).
 *
 *   npx tsx scripts/power-check.ts --true-sharpe 0.5 --window-years 0.5
 *       Full pre-flight check for a declared forward window, including the
 *       lab's auto-flag recommendation (DEFER / KILL-only watch rule).
 *
 * Optional overrides: --power (default 0.8), --alpha (default 0.05),
 * --dsr-bar (default 0.95), --periods-per-year (default 365).
 */

import {
  poweredHorizonYears,
  preflightPowerCheck,
  requiredObservedSharpeAnnual,
} from "@/lib/validation/power-analysis";

interface CliOptions {
  days?: number;
  trueSharpe?: number;
  windowYears?: number;
  power: number;
  alpha: number;
  dsrBar: number;
  periodsPerYear: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    power: 0.8,
    alpha: 0.05,
    dsrBar: 0.95,
    periodsPerYear: 365,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const readNumber = (name: string): number => {
      const raw = argv[i + 1];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`${name} requires a numeric value; got "${raw}"`);
      }
      i += 1;
      return value;
    };
    switch (flag) {
      case "--days":
        options.days = readNumber("--days");
        break;
      case "--true-sharpe":
        options.trueSharpe = readNumber("--true-sharpe");
        break;
      case "--window-years":
        options.windowYears = readNumber("--window-years");
        break;
      case "--power":
        options.power = readNumber("--power");
        break;
      case "--alpha":
        options.alpha = readNumber("--alpha");
        break;
      case "--dsr-bar":
        options.dsrBar = readNumber("--dsr-bar");
        break;
      case "--periods-per-year":
        options.periodsPerYear = readNumber("--periods-per-year");
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag: ${flag} (try --help)`);
    }
  }
  return options;
}

function printUsage(): void {
  console.log(
    [
      "power-check — §3 power-wall pre-flight gate",
      "",
      "  npx tsx scripts/power-check.ts                                  print both §3 tables",
      "  npx tsx scripts/power-check.ts --days 182                       required observed Sharpe for an N-day window",
      "  npx tsx scripts/power-check.ts --true-sharpe 0.5 --window-years 0.5   full pre-flight check + recommendation",
      "",
      "  overrides: --power 0.8 --alpha 0.05 --dsr-bar 0.95 --periods-per-year 365",
    ].join("\n"),
  );
}

const WINDOW_ROWS: Array<{ label: string; days: number }> = [
  { label: "26 weeks", days: 182 },
  { label: "1 year", days: 365 },
  { label: "18 months", days: 548 },
  { label: "2 years", days: 730 },
  { label: "3 years", days: 1095 },
  { label: "4 years", days: 1460 },
  { label: "5 years", days: 1825 },
];

const TRUE_SHARPE_ROW = [0.3, 0.5, 0.7, 0.85, 1.0, 1.2, 1.5, 2.0];

function printTables(options: CliOptions): void {
  console.log(
    "The power wall (PROJECT_REVIEW_2026-06-09.md §3) — normal approximation, daily returns, honest N=1",
  );
  console.log("");
  console.log(
    `Required OBSERVED annualized Sharpe (DSR >= ${options.dsrBar}; t-test two-sided alpha = ${options.alpha}):`,
  );
  console.log("");
  console.log("  Forward window |   days | DSR gate | t-stat gate");
  console.log("  ---------------+--------+----------+------------");
  for (const row of WINDOW_ROWS) {
    const dsr = requiredObservedSharpeAnnual({
      days: row.days,
      periodsPerYear: options.periodsPerYear,
      criterion: "dsr",
      dsrBar: options.dsrBar,
    });
    const tstat = requiredObservedSharpeAnnual({
      days: row.days,
      periodsPerYear: options.periodsPerYear,
      criterion: "tstat",
      alpha: options.alpha,
    });
    console.log(
      `  ${row.label.padEnd(14)} | ${String(row.days).padStart(6)} | ${dsr
        .toFixed(2)
        .padStart(8)} | ${tstat.toFixed(2).padStart(11)}`,
    );
  }
  console.log("");
  console.log(
    `Years of forward data for ${Math.round(options.power * 100)}% power, by TRUE annualized Sharpe:`,
  );
  console.log("");
  console.log(
    `  True SR | ${TRUE_SHARPE_ROW.map((s) => s.toFixed(2).padStart(6)).join(" | ")}`,
  );
  console.log(`  --------+${TRUE_SHARPE_ROW.map(() => "--------").join("+")}`);
  console.log(
    `  Years   | ${TRUE_SHARPE_ROW.map((s) =>
      poweredHorizonYears({
        trueSharpeAnnual: s,
        power: options.power,
        alpha: options.alpha,
      })
        .toFixed(1)
        .padStart(6),
    ).join(" | ")}`,
  );
  console.log("");
  console.log(
    "Lab rule: any pre-registered forward test whose powered horizon exceeds its declared window",
    "is auto-flagged (DEFER or reframe as a KILL-only watch). Fast KILLs stay cheap at any Sharpe.",
  );
}

function printDaysCheck(options: CliOptions & { days: number }): void {
  const dsr = requiredObservedSharpeAnnual({
    days: options.days,
    periodsPerYear: options.periodsPerYear,
    criterion: "dsr",
    dsrBar: options.dsrBar,
  });
  const tstat = requiredObservedSharpeAnnual({
    days: options.days,
    periodsPerYear: options.periodsPerYear,
    criterion: "tstat",
    alpha: options.alpha,
  });
  const years = options.days / options.periodsPerYear;
  console.log(
    `Window: ${options.days} days (${years.toFixed(2)}y at ${options.periodsPerYear} periods/year)`,
  );
  console.log(
    `Required observed annualized Sharpe: ${dsr.toFixed(2)} (DSR >= ${options.dsrBar}) | ${tstat.toFixed(2)} (t-test, alpha ${options.alpha})`,
  );
  console.log(
    "Recommendation: state the powered horizon for your assumed true Sharpe before pre-registering",
    "(--true-sharpe S --window-years Y); a window shorter than the powered horizon can only KILL or extend.",
  );
}

function printPreflight(
  options: CliOptions & { trueSharpe: number; windowYears: number },
): void {
  const result = preflightPowerCheck({
    declaredWindowYears: options.windowYears,
    assumedTrueSharpeAnnual: options.trueSharpe,
    power: options.power,
    alpha: options.alpha,
    dsrBar: options.dsrBar,
    periodsPerYear: options.periodsPerYear,
  });
  console.log(
    `Pre-flight power check — declared window ${options.windowYears}y, assumed true SR ${options.trueSharpe}`,
  );
  console.log(
    `  required observed SR: ${result.requiredObservedSharpeDsr.toFixed(2)} (DSR >= ${options.dsrBar}) | ${result.requiredObservedSharpeT.toFixed(2)} (t-test, alpha ${options.alpha})`,
  );
  console.log(
    `  powered horizon:      ${result.poweredYears.toFixed(1)}y (power ${options.power}, alpha ${options.alpha})`,
  );
  console.log(`  feasible:             ${result.feasible ? "YES" : "NO"}`);
  console.log(`  recommendation:       ${result.recommendation}`);
}

function main(): void {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (options.trueSharpe !== undefined && options.windowYears !== undefined) {
    printPreflight(
      options as CliOptions & { trueSharpe: number; windowYears: number },
    );
    return;
  }
  if (options.trueSharpe !== undefined || options.windowYears !== undefined) {
    console.error(
      "--true-sharpe and --window-years must be used together (try --help)",
    );
    process.exit(2);
  }
  if (options.days !== undefined) {
    printDaysCheck(options as CliOptions & { days: number });
    return;
  }
  printTables(options);
}

main();
