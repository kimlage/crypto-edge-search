/**
 * TRACK NF2 — Target + Stop-Loss / professional BRACKET strategies.
 *
 * THE DECISIVE QUESTION: does TP/SL CREATE edge, or just RESHAPE the P&L
 * distribution (variance/skew) of whatever the entry already had?
 *
 * We run the professional bracket toolkit (fixed R:R 1:1/1:2/1:3/2:1, ATR
 * stops/targets, trailing stops, breakout-with-stop, R-multiple scale-outs) on a
 * BREAKOUT (momentum) entry and on a RANDOM entry, simulating INTRABAR TP/SL hits
 * via the HIGH/LOW path of the 15m BTC OHLCV series. Each strategy's PER-TRADE net
 * P&L is fed to the committed gates (validateStrategy: net-of-cost, baselines, DSR,
 * PBO, haircut, surrogate/placebo, consume-once holdout) with cost on entry+exit.
 *
 * Two controls demonstrate the answer:
 *  (1) SAME brackets on a RANDOM entry and on phase-randomized + GBM SURROGATE
 *      price paths. If bracketed P&L on noise ≈ bracketed P&L on real, the "edge"
 *      is the bracket reshaping noise, not capturing signal (the fair-game result).
 *  (2) BRACKETED vs UN-BRACKETED (fixed-horizon hold) of the SAME entry — does
 *      bracketing improve risk-adjusted return out-of-sample, net of turnover?
 *
 * Run:
 *   PATH=.../node/bin:$PATH node_modules/.bin/tsx scripts/nf2-brackets/run-nf2-brackets.ts
 */

import { writeFileSync } from "node:fs";
import {
  validateStrategy,
  phaseRandomize,
  type StrategyValidatorVerdict,
} from "../../src/lib/validation/strategy-validator";
import {
  loadBars,
  seeded,
  breakoutEntries,
  randomEntries,
  runBracketStrategy,
  runFixedHorizon,
  gbmSurrogateBars,
  type Bar,
  type BracketKind,
  type StrategyRun,
} from "./bracket-engine";

const DATA = "<repo>";
const OUT = "<repo>";

// Cost: taker ~4 bps/side => 8 bps round-trip on entry+exit of every trade.
const TAKER_PER_SIDE = 0.0004;

// 15m bars: 96/day. We use a recent multi-year window so the path test has enough
// trades while keeping the phase-surrogate FFT tractable.
const WINDOW_BARS = 96 * 365 * 3; // ~3 years of 15m bars
const MAX_HOLD = 96; // cap a bracketed trade at ~1 day of 15m bars
const BREAKOUT_LOOKBACK = 96; // 1-day Donchian breakout
const RANDOM_RATE = 0.01; // random entry density (tuned to be comparable to breakout count)

// ---------------------------------------------------------------------------
// The professional bracket toolkit (the variants we evaluate — HONEST N counts ALL)
// ---------------------------------------------------------------------------
function bracketToolkit(): { name: string; br: BracketKind }[] {
  return [
    { name: "fixed_rr_1:1", br: { type: "fixed_rr", stopPct: 0.01, rr: 1 } },
    { name: "fixed_rr_1:2", br: { type: "fixed_rr", stopPct: 0.01, rr: 2 } },
    { name: "fixed_rr_1:3", br: { type: "fixed_rr", stopPct: 0.01, rr: 3 } },
    { name: "fixed_rr_2:1", br: { type: "fixed_rr", stopPct: 0.01, rr: 0.5 } },
    { name: "atr_1.5x_1:2", br: { type: "atr", atrN: 14, stopMult: 1.5, rr: 2 } },
    { name: "atr_2x_1:1", br: { type: "atr", atrN: 14, stopMult: 2, rr: 1 } },
    { name: "atr_3x_1:1", br: { type: "atr", atrN: 14, stopMult: 3, rr: 1 } },
    { name: "trailing_1pct", br: { type: "trailing", trailPct: 0.01, maxBars: MAX_HOLD } },
    { name: "trailing_2pct", br: { type: "trailing", trailPct: 0.02, maxBars: MAX_HOLD } },
    { name: "breakout_stop_1pct", br: { type: "breakout_stop", stopPct: 0.01, maxBars: MAX_HOLD } },
    {
      name: "r_multiple_scaleout",
      br: { type: "r_multiple", stopPct: 0.01, targets: [1, 2, 3], fractions: [0.34, 0.33, 0.33] },
    },
  ];
}

// HONEST N: every (entry × bracket) config we evaluate is a trial. We also count the
// fixed-horizon control variants. This N is fed to DSR + haircut so we do NOT pretend N=1.
function honestTrialCount(): number {
  const toolkit = bracketToolkit().length; // 11 brackets
  const entries = 2; // breakout + random
  const fixedHorizonVariants = 3; // hold = 24, 48, 96 bars (the un-bracketed control sweep)
  // We evaluate every bracket on both entries, plus the fixed-horizon sweep on the breakout entry.
  return toolkit * entries + fixedHorizonVariants;
}

// ---------------------------------------------------------------------------
// Build per-bar market returns over the SAME trade window for the baseline gate.
// The baseline B&H/random-lottery need a per-bar return series. We pass close-to-close.
// ---------------------------------------------------------------------------
function barReturns(bars: Bar[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < bars.length; i += 1) r.push(bars[i].close / bars[i - 1].close - 1);
  return r;
}

function validate(
  perTrade: number[],
  bars: Bar[],
  trialCount: number,
  label: string,
): StrategyValidatorVerdict {
  // Per-trade GROSS returns => default cost path charges ONE round-trip (8 bps) per
  // non-zero trade = entry+exit cost. Turnover = number of trades.
  return validateStrategy(perTrade, {
    trialCount,
    statistic: "compoundReturn",
    cost: { takerPerSide: TAKER_PER_SIDE },
    baselines: { marketReturns: barReturns(bars), roundTripCost: TAKER_PER_SIDE * 2 },
    haircut: { method: "bonferroni" },
    surrogate: { iterations: 200, statistic: "sharpe", seed: `nf2:${label}` },
    holdout: { holdoutFraction: 0.2, testFraction: 0.1, reason: `nf2:${label}` },
    seed: `nf2:${label}`,
  });
}

interface RowSummary {
  label: string;
  trades: number;
  winRate: number;
  avgBars: number;
  grossSharpe: number;
  netSharpe: number;
  netCompound: number;
  surrogatePlaceboP: number | null;
  verdict: string;
  bindingGate: string | null;
  outcomes: Record<string, number>;
}

function summarizeRun(
  label: string,
  run: StrategyRun,
  v: StrategyValidatorVerdict,
): RowSummary {
  const surr = v.perGate.find((g) => g.id === "surrogate");
  return {
    label,
    trades: run.tradeCount,
    winRate: +run.winRate.toFixed(3),
    avgBars: +run.avgBars.toFixed(1),
    grossSharpe: +v.netStats.grossSharpe.toFixed(4),
    netSharpe: +v.netStats.sharpe.toFixed(4),
    netCompound: +v.netStats.compoundReturn.toFixed(5),
    surrogatePlaceboP:
      surr && typeof surr.detail.placeboP === "number" ? +(surr.detail.placeboP as number).toFixed(3) : null,
    verdict: v.verdict,
    bindingGate: v.bindingGate,
    outcomes: run.outcomeCounts,
  };
}

function main(): void {
  console.log("=== TRACK NF2 — Target + Stop-Loss / professional BRACKETS (path-dependent) ===\n");
  const allBars = loadBars(DATA);
  const bars = allBars.slice(Math.max(0, allBars.length - WINDOW_BARS));
  console.log(
    `Loaded ${allBars.length} 15m BTC bars; using last ${bars.length} ` +
      `(${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars.at(-1)!.t).toISOString().slice(0, 10)}).`,
  );

  const N = honestTrialCount();
  console.log(`HONEST trial count N = ${N} (every entry×bracket config + fixed-horizon control sweep).\n`);

  // ---- Entries -------------------------------------------------------------
  const breakout = breakoutEntries(bars, BREAKOUT_LOOKBACK);
  const rng = seeded("nf2-random-entry");
  const random = randomEntries(bars, RANDOM_RATE, rng);
  console.log(`Breakout entries (candidates): ${breakout.length}; Random entries (candidates): ${random.length}\n`);

  const toolkit = bracketToolkit();
  const rows: RowSummary[] = [];

  // ====================================================================
  // 1) REAL DATA — breakout entry × every bracket
  // ====================================================================
  console.log("--- (1) BRACKETS on REAL data, BREAKOUT entry ---");
  for (const { name, br } of toolkit) {
    const run = runBracketStrategy(bars, breakout, br, MAX_HOLD);
    if (run.tradeCount < 30) {
      console.log(`  ${name}: only ${run.tradeCount} trades — skipped (too few).`);
      continue;
    }
    const v = validate(run.perTrade, bars, N, `real-breakout-${name}`);
    const s = summarizeRun(`real-breakout-${name}`, run, v);
    rows.push(s);
    console.log(
      `  ${name.padEnd(20)} trades=${String(s.trades).padStart(5)} win=${s.winRate} ` +
        `netSharpe=${String(s.netSharpe).padStart(8)} placeboP=${s.surrogatePlaceboP} ` +
        `=> ${s.verdict} (binding=${s.bindingGate})`,
    );
  }

  // ====================================================================
  // 2) REAL DATA — RANDOM entry × every bracket (placebo entry)
  // ====================================================================
  console.log("\n--- (2) BRACKETS on REAL data, RANDOM entry (placebo entry control) ---");
  for (const { name, br } of toolkit) {
    const run = runBracketStrategy(bars, random, br, MAX_HOLD);
    if (run.tradeCount < 30) continue;
    const v = validate(run.perTrade, bars, N, `real-random-${name}`);
    const s = summarizeRun(`real-random-${name}`, run, v);
    rows.push(s);
    console.log(
      `  ${name.padEnd(20)} trades=${String(s.trades).padStart(5)} win=${s.winRate} ` +
        `netSharpe=${String(s.netSharpe).padStart(8)} placeboP=${s.surrogatePlaceboP} ` +
        `=> ${s.verdict} (binding=${s.bindingGate})`,
    );
  }

  // ====================================================================
  // 3) SURROGATE PRICE PATHS — same brackets, same breakout entry logic, on
  //    GBM (driftless) and phase-randomized prices. THE FAIR-GAME CONTROL.
  // ====================================================================
  console.log("\n--- (3) BRACKETS on SURROGATE price paths (GBM + phase-randomized), breakout entry ---");
  const gbmBars = gbmSurrogateBars(bars, seeded("nf2-gbm"));
  const phaseBars = makePhaseBars(bars, seeded("nf2-phase"));

  for (const [tag, sbars] of [
    ["gbm", gbmBars],
    ["phase", phaseBars],
  ] as const) {
    const sEntries = breakoutEntries(sbars, BREAKOUT_LOOKBACK);
    let printed = 0;
    for (const { name, br } of toolkit) {
      const run = runBracketStrategy(sbars, sEntries, br, MAX_HOLD);
      if (run.tradeCount < 30) continue;
      const v = validate(run.perTrade, sbars, N, `surr-${tag}-${name}`);
      const s = summarizeRun(`surr-${tag}-${name}`, run, v);
      rows.push(s);
      if (printed < 4 || s.verdict === "PASS") {
        console.log(
          `  [${tag}] ${name.padEnd(20)} trades=${String(s.trades).padStart(5)} win=${s.winRate} ` +
            `netSharpe=${String(s.netSharpe).padStart(8)} => ${s.verdict} (binding=${s.bindingGate})`,
        );
      }
      printed += 1;
    }
  }

  // ====================================================================
  // 4) BRACKETED vs UN-BRACKETED (fixed-horizon hold) of the SAME breakout entry.
  //    Does bracketing improve risk-adjusted return net of the extra turnover?
  // ====================================================================
  console.log("\n--- (4) BRACKETED vs UN-BRACKETED (fixed-horizon hold), same breakout entry ---");
  const fixedSummaries: { label: string; netSharpe: number; netCompound: number; trades: number; verdict: string }[] = [];
  for (const hold of [24, 48, 96]) {
    const run = runFixedHorizon(bars, breakout, hold);
    if (run.tradeCount < 30) continue;
    const v = validate(run.perTrade, bars, N, `fixed-hold-${hold}`);
    const s = summarizeRun(`fixed-hold-${hold}bar`, run, v);
    rows.push(s);
    fixedSummaries.push({
      label: `hold-${hold}bar`,
      netSharpe: s.netSharpe,
      netCompound: s.netCompound,
      trades: s.trades,
      verdict: s.verdict,
    });
    console.log(
      `  UN-BRACKETED hold=${String(hold).padStart(3)}bar trades=${String(s.trades).padStart(5)} ` +
        `netSharpe=${String(s.netSharpe).padStart(8)} netCompound=${s.netCompound} => ${s.verdict}`,
    );
  }

  // ---- Real-vs-surrogate comparison: the decisive table --------------------
  console.log("\n=== REAL vs SURROGATE (the decisive control): mean netSharpe across brackets ===");
  const meanNetSharpe = (prefix: string) => {
    const sel = rows.filter((r) => r.label.startsWith(prefix));
    if (sel.length === 0) return NaN;
    return sel.reduce((s, r) => s + r.netSharpe, 0) / sel.length;
  };
  const realBreak = meanNetSharpe("real-breakout-");
  const realRand = meanNetSharpe("real-random-");
  const surrGbm = meanNetSharpe("surr-gbm-");
  const surrPhase = meanNetSharpe("surr-phase-");
  console.log(`  real-breakout mean netSharpe : ${fmt(realBreak)}`);
  console.log(`  real-random   mean netSharpe : ${fmt(realRand)}`);
  console.log(`  gbm-surrogate mean netSharpe : ${fmt(surrGbm)}`);
  console.log(`  phase-surrog. mean netSharpe : ${fmt(surrPhase)}`);

  const passes = rows.filter((r) => r.verdict === "PASS");
  console.log(`\n=== GATE OUTCOME: ${passes.length} of ${rows.length} bracket configs PASS the full gauntlet ===`);
  if (passes.length > 0) {
    for (const p of passes) console.log(`  PASS: ${p.label} (netSharpe=${p.netSharpe}, placeboP=${p.surrogatePlaceboP})`);
  }

  // ---- Verdict logic -------------------------------------------------------
  // KILL unless a REAL bracket survives the FULL gauntlet AND clearly beats the
  // surrogate/random-entry distribution of the same brackets.
  const realPasses = passes.filter((p) => p.label.startsWith("real-"));
  const surrogateMax = Math.max(
    rows.filter((r) => r.label.startsWith("surr-")).reduce((m, r) => Math.max(m, r.netSharpe), -Infinity),
    realRand,
  );
  const verdict =
    realPasses.length > 0 && realBreak > surrogateMax + 0.05 ? "SURVIVE" : "KILL";

  console.log(`\n###### TRACK NF2 VERDICT: ${verdict} ######`);
  console.log(
    verdict === "KILL"
      ? "TP/SL reshapes the P&L distribution (variance/skew) but does NOT manufacture edge: " +
          "bracketed noise ≈ bracketed real, and no real bracket survives the gauntlet net of cost."
      : "A real bracket survived the full gauntlet AND beat the surrogate/random distribution — investigate.",
  );

  const report = {
    track: "NF2",
    generatedAt: new Date().toISOString(),
    dataset: DATA,
    barsUsed: bars.length,
    window: { from: new Date(bars[0].t).toISOString(), to: new Date(bars.at(-1)!.t).toISOString() },
    costTakerPerSide: TAKER_PER_SIDE,
    honestTrialCount: N,
    breakoutEntryCandidates: breakout.length,
    randomEntryCandidates: random.length,
    meanNetSharpe: { realBreak, realRand, surrGbm, surrPhase },
    fixedHorizonControl: fixedSummaries,
    passes: passes.map((p) => p.label),
    verdict,
    rows,
  };
  writeFileSync(`${OUT}/nf2-bracket-report.json`, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT}/nf2-bracket-report.json`);
}

// Phase-randomized OHLC bars using the FAST committed phaseRandomize (O(n log n)).
function makePhaseBars(real: Bar[], rng: () => number): Bar[] {
  const logRets: number[] = [];
  for (let i = 1; i < real.length; i += 1) logRets.push(Math.log(real[i].close / real[i - 1].close));
  const surr = phaseRandomize(logRets, rng); // FFT-based, fast
  const relUp = real.map((b) => Math.max(0, (b.high - Math.max(b.open, b.close)) / b.close));
  const relDn = real.map((b) => Math.max(0, (Math.min(b.open, b.close) - b.low) / b.close));
  const out: Bar[] = [{ ...real[0] }];
  let price = real[0].close;
  for (let i = 0; i < surr.length; i += 1) {
    const open = price;
    const close = open * Math.exp(surr[i]);
    const ix = i + 1;
    const hi = Math.max(open, close) * (1 + (relUp[ix] ?? 0));
    const lo = Math.min(open, close) * (1 - (relDn[ix] ?? 0));
    out.push({ t: real[ix].t, open, high: hi, low: Math.max(1e-9, lo), close });
    price = close;
  }
  return out;
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : "n/a";
}

main();
