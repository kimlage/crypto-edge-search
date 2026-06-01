/**
 * Marco 1 honest verdict (read-only): does the BEST evolved DNA actually survive
 * the rigour gates over the EXISTING local evidence?
 *
 * It answers two questions with real numbers, reusing the Track-A pure cores
 * (no new statistics are invented here):
 *   1) Selection deflation — the cross-sectional False Strategy Theorem on the
 *      validation2 net returns: given N distinct trials with mean/sd dispersion,
 *      the expected maximum under the null (no skill) is
 *        E[max] = mean + sd * E[max of N standard normals]   (Bailey/LdP).
 *      The best candidate must clear that bar AND be positive net of costs.
 *   2) Baseline floor — the best candidate must beat buy-and-hold and a
 *      random/zero-intelligence lottery trader (Chen & Navet 2007), via the
 *      existing baselines gate, when a market bar series is available.
 *
 * Pure reuse: trial-count.ts (true N, MinBTL), statistical-validation.ts
 * (computeDeflatedSharpeRatio, expectedMaxStandardNormal, summarizeReturnSeries),
 * baselines.ts (buy-and-hold / random-lottery gate). No BigQuery, no training,
 * no writes — it only reads local ledger NDJSON under output/headless-evolution.
 *
 * Usage:
 *   npx tsx scripts/audit-population-significance.ts [ledgerDir] [--symbol BTCUSDT] [--timeframe 15m] [--include-synthetic]
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  countDistinctTrials,
  summarizeTrialSelection,
} from "../src/lib/significance/trial-count";
import { expectedMaxStandardNormal } from "../src/lib/statistical-validation";
import {
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  evaluateBaselineGate,
  type BaselineScore,
} from "../src/lib/significance/baselines";

interface LedgerRow {
  file: string;
  dnaId: string | null;
  candidateId: string | null;
  symbol: string | null;
  timeframe: string | null;
  source: string | null;
  candidateSource: string | null;
  operationalClass: string | null;
  objectiveScore: number | null;
  v2NetReturn: number | null;
  v2Trades: number | null;
  v2ProfitFactor: number | null;
  v2MaxDrawdown: number | null;
}

const DSR_THRESHOLD = 0.95;
const MIN_OPERATIONAL_TRADES = 8;

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : null;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function isSynthetic(row: LedgerRow): boolean {
  const haystack = `${row.source ?? ""} ${row.candidateSource ?? ""} ${row.file}`.toLowerCase();
  return haystack.includes("synth") || haystack.includes("smoke") || haystack.includes("dev");
}

function collectLedgerFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith("-ledger.ndjson")) out.push(join(dir, name));
  }
  return out;
}

function parseRow(raw: unknown, file: string): LedgerRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    file,
    dnaId: str(r.dna_id),
    candidateId: str(r.candidate_id),
    symbol: str(r.symbol),
    timeframe: str(r.timeframe),
    source: str(r.source),
    candidateSource: str(r.candidate_source),
    operationalClass: str(r.operational_class),
    objectiveScore: num(r.objective_score),
    v2NetReturn: num(r.validation2_total_net_return),
    v2Trades: num(r.validation2_trade_count),
    v2ProfitFactor: num(r.validation2_profit_factor),
    v2MaxDrawdown: num(r.validation2_max_drawdown),
  };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(3)}%`;
}

function loadClosesNearestTo(symbol: string, timeframe: string): number[] | null {
  // Best-effort: a local OHLCV ndjson for buy-and-hold/lottery baselines.
  const candidates = [
    join("output", "bigquery", `${symbol.toLowerCase()}_ohlcv_${timeframe}.ndjson`),
    join("output", "bigquery", `btc_ohlcv_${timeframe}.ndjson`),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) return null;
  try {
    // Guard against very large files — only sample if it is reasonable to read.
    const size = statSync(candidate).size;
    if (size > 200 * 1024 * 1024) return null;
    const closes: number[] = [];
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as Record<string, unknown>;
      const close = num(obj.close) ?? num(obj.c);
      if (close !== null) closes.push(close);
    }
    return closes.length > 1 ? closes : null;
  } catch {
    return null;
  }
}

function closesToBarReturns(closes: readonly number[]): number[] {
  const bars: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    if (prev > 0) bars.push((closes[i]! - prev) / prev);
  }
  return bars;
}

function main(): void {
  const ledgerDir = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : join("output", "headless-evolution");
  const symbol = arg("--symbol") ?? "BTCUSDT";
  const timeframe = arg("--timeframe") ?? "15m";
  const includeSynthetic = hasFlag("--include-synthetic");
  const roundTripCost = (8 + 2 + 4) * 2 / 10_000; // fee+slip+spread per side, round trip ≈ 0.0028

  console.log("=".repeat(78));
  console.log("MARCO 1 — POPULATION SIGNIFICANCE AUDIT (read-only, reuses Track-A cores)");
  console.log("=".repeat(78));
  console.log(`ledger dir : ${ledgerDir}`);
  console.log(`scope      : symbol=${symbol} timeframe=${timeframe} include_synthetic=${includeSynthetic}`);

  const files = collectLedgerFiles(ledgerDir);
  if (files.length === 0) {
    console.log(`\nINSUFFICIENT LOCAL EVIDENCE: no *-ledger.ndjson found under ${ledgerDir}`);
    return;
  }

  const rows: LedgerRow[] = [];
  let parseErrors = 0;
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      parseErrors += 1;
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = parseRow(JSON.parse(line), file);
        if (row) rows.push(row);
      } catch {
        parseErrors += 1;
      }
    }
  }

  const scoped = rows.filter(
    (r) =>
      (r.symbol === null || r.symbol === symbol) &&
      (r.timeframe === null || r.timeframe === timeframe) &&
      (includeSynthetic || !isSynthetic(r)),
  );
  const withReturn = scoped.filter((r) => r.v2NetReturn !== null);

  console.log(`\nCorpus : ${files.length} ledger files, ${rows.length} rows, ${scoped.length} in-scope, ${withReturn.length} with a validation2 return (parse issues: ${parseErrors})`);

  if (withReturn.length === 0) {
    console.log(`\nINSUFFICIENT LOCAL EVIDENCE: no in-scope candidate carried a validation2 net return.`);
    return;
  }

  // --- True trial count N + dispersion (reused from trial-count.ts) ---
  const trialRows = withReturn.map((r) => ({
    dnaId: r.dnaId,
    trialId: r.candidateId,
    validation2Return: r.v2NetReturn,
  }));
  const N = countDistinctTrials(trialRows);
  const selection = summarizeTrialSelection(trialRows);
  const sd = Math.sqrt(selection.returnVariance);

  // --- Operational breakdown ---
  const byClass = new Map<string, number>();
  for (const r of withReturn) {
    const key = r.operationalClass ?? "unknown";
    byClass.set(key, (byClass.get(key) ?? 0) + 1);
  }
  const positive = withReturn.filter((r) => (r.v2NetReturn ?? 0) > 0);
  const operationalProfitable = withReturn.filter(
    (r) => r.operationalClass === "profitable" && (r.v2Trades ?? 0) >= MIN_OPERATIONAL_TRADES,
  );

  // Best candidate by selection score (objective_score), then by return.
  const best = [...withReturn].sort(
    (a, b) =>
      (b.objectiveScore ?? -Infinity) - (a.objectiveScore ?? -Infinity) ||
      (b.v2NetReturn ?? -Infinity) - (a.v2NetReturn ?? -Infinity),
  )[0]!;

  console.log("\n-- Trial population --");
  console.log(`  distinct trials N        : ${N}`);
  console.log(`  return samples           : ${selection.returnSampleCount}`);
  console.log(`  mean validation2 return  : ${pct(selection.meanReturn)}`);
  console.log(`  sd of returns            : ${pct(sd)}`);
  console.log(`  best / worst return      : ${pct(selection.bestReturn)} / ${pct(selection.worstReturn)}`);
  console.log("\n-- Operational classes (in scope) --");
  for (const [cls, count] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(34)} : ${count}`);
  }
  console.log(`  positive validation2 return        : ${positive.length}`);
  console.log(`  operationally profitable (>=${MIN_OPERATIONAL_TRADES} trades): ${operationalProfitable.length}`);

  console.log("\n-- Best candidate (by objective_score) --");
  console.log(`  dna/candidate : ${best.dnaId ?? best.candidateId ?? "?"}`);
  console.log(`  objective     : ${best.objectiveScore?.toFixed(4) ?? "n/a"}  class=${best.operationalClass ?? "?"}`);
  console.log(`  validation2   : return=${pct(best.v2NetReturn)} trades=${best.v2Trades ?? "?"} PF=${best.v2ProfitFactor ?? "n/a"} maxDD=${pct(best.v2MaxDrawdown)}`);

  // --- Cross-sectional False Strategy Theorem on validation2 returns ---
  const zN = expectedMaxStandardNormal(Math.max(2, N));
  const expectedMaxNullReturn = selection.meanReturn + sd * zN;
  const bestReturn = selection.bestReturn;
  const survivesSelection = bestReturn > 0 && bestReturn > expectedMaxNullReturn;

  console.log("\n-- Selection deflation (cross-sectional False Strategy Theorem) --");
  console.log(`  E[max of N standard normals] z_N : ${zN.toFixed(4)}  (N=${N})`);
  console.log(`  expected max NULL return         : ${pct(expectedMaxNullReturn)}  (mean + sd*z_N)`);
  console.log(`  observed best return             : ${pct(bestReturn)}`);
  console.log(`  clears selection-luck bar        : ${survivesSelection ? "YES" : "NO"}`);
  console.log(`  NOTE: N counts distinct dna_id labels (slot-based, e.g. G2-DNA-001-mutation),`);
  console.log(`        so it is a LOWER bound; the true config count is closer to ${withReturn.length}`);
  console.log(`        evaluations, which would deflate the bar even harder (gap A0/L3).`);

  // --- Optional: full Deflated Sharpe + MinBTL + baselines if a positive,
  //     operational candidate exists and a series can be built. ---
  let richVerdict = "";
  if (operationalProfitable.length > 0) {
    // We have an operational positive candidate but the ledger only stores an
    // aggregate (one return), not a per-trade series, so a true per-strategy
    // Deflated Sharpe needs the trade series exported. Report what is blocking.
    richVerdict =
      "  NOTE: an operationally profitable candidate exists; a per-trade return series\n" +
      "        (from backtest_trades) is required to compute its per-strategy Deflated\n" +
      "        Sharpe with N. That export is the next step (A2 wiring).";
  }

  // Baseline floor (buy-and-hold / random lottery), best-effort from local OHLCV.
  let baselineLine = "  baselines: skipped (no local OHLCV series found for buy-and-hold/lottery).";
  const closes = loadClosesNearestTo(symbol, timeframe);
  if (closes) {
    // Coarse reference only: full-history closes are NOT aligned to each
    // candidate's validation2 window, and summarizeReturnSeries spreads the
    // array (Math.min(...)), so very large inputs overflow the stack. Cap to a
    // recent window for a bounded, honest sanity reference.
    const bars = closesToBarReturns(closes).slice(-4096);
    const buyHold = buildBuyAndHoldBaseline({ barReturns: bars, roundTripCost });
    const trades = Math.max(1, Math.round(best.v2Trades ?? 1));
    const lottery = buildRandomLotteryBaseline({
      barReturns: bars,
      tradeCount: trades,
      roundTripCost,
      quantile: 0.95,
      seed: "marco1-audit",
    });
    const baselines: BaselineScore[] = [buyHold, lottery];
    // The candidate's net return is its compound P&L over its window; compare it
    // as a single aggregate score against the baselines (a conservative floor).
    const gate = evaluateBaselineGate({
      candidateReturns: [],
      candidateScore: best.v2NetReturn ?? 0,
      baselines,
    });
    baselineLine =
      `  baselines (coarse, recent ${bars.length}-bar window, NOT candidate-window-aligned):\n` +
      `    buy&hold=${pct(buyHold.score)}  lottery_q95=${pct(lottery.score)}  candidate=${pct(best.v2NetReturn)}\n` +
      `    -> beatsAll=${gate.beatsAll} (a rigorous gate needs per-candidate window-aligned returns — A2 export)`;
  }
  console.log("\n-- Baseline floor --");
  console.log(baselineLine);

  // --- VERDICT ---
  const passes = survivesSelection && operationalProfitable.length > 0;
  console.log("\n" + "=".repeat(78));
  if (positive.length === 0) {
    console.log(
      `VERDICT: NO EDGE. 0 of ${N} distinct trials produced a positive validation2 return\n` +
      `         net of costs. There is no winner to deflate — the rigour gates are\n` +
      `         correctly empty. This matches the critical analysis: the target (BTC\n` +
      `         ${timeframe} direction net of costs) lacks edge; change the target, not the gates.`,
    );
  } else if (!passes) {
    console.log(
      `VERDICT: DOES NOT SURVIVE. ${positive.length} of ${withReturn.length} evaluations are nominally\n` +
      `         positive (best ${pct(bestReturn)}), but across N=${N} distinct trials the best return\n` +
      `         does NOT clear the selection-luck bar: the luckiest of N pure-noise strategies is\n` +
      `         expected to return ${pct(expectedMaxNullReturn)}. The winner is weaker than luck predicts\n` +
      `         — no evidence of skill. No promotion (and the true N is higher, so this is generous).`,
    );
  } else {
    console.log(
      `VERDICT: CANDIDATE CLEARS SELECTION DEFLATION. Best operational candidate survives the\n` +
      `         cross-sectional False Strategy Theorem at N=${N}. Next: compute its per-trade\n` +
      `         Deflated Sharpe (>${DSR_THRESHOLD}) + PBO before any capital.`,
    );
  }
  if (richVerdict) console.log(richVerdict);
  console.log("=".repeat(78));
}

main();
