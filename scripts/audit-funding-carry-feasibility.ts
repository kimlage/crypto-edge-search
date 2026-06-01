/**
 * audit-funding-carry-feasibility.ts — EXPERIMENT 2 verdict (read-only over
 * output/funding/, reuses the Track-A pure cores; no BigQuery, no training, no
 * shared-file edits).
 *
 * Question (structural, NOT a forecast): is delta-neutral perpetual carry (long
 * spot + short perp, collect funding) net-of-fee positive with a SURVIVABLE
 * worst case, on real funding history?
 *
 * Pipeline:
 *   1. Load real 8h funding + daily spot/perp closes (scripts/fetch-funding-rates.mjs).
 *   2. simulateFundingCarry per symbol -> net APR, drawdown, % in-position, vol,
 *      per-interval net-return series. Basis moves drive delta-restoring rebalances.
 *   3. Gates on the per-interval net-carry returns (this is ONE strategy, low N —
 *      noted): computeDeflatedSharpeRatio (N=1 trial since carry is not searched),
 *      evaluateMinBtl, a 50% McLean-Pontiff in-sample Sharpe haircut, and a post-2021
 *      hold-out slice that must independently survive.
 *   4. stressFundingCarry: sustained negative-funding regime + one FTX-style
 *      counterparty gap (lose the short leg).
 *   5. Verdict: PROMOTE iff net APR clearly positive (haircut-survived) AND the
 *      hold-out slice is positive AND the worst case is survivable. Carry is judged
 *      by net APR vs drawdown + survivability, NOT by beating a directional baseline.
 *
 * Usage:
 *   tsx scripts/audit-funding-carry-feasibility.ts [--symbol BTCUSDT|ALL] [--cost 0.0008]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  deriveBasisMoves,
  simulateFundingCarry,
  stressFundingCarry,
  type FundingInterval,
} from "../src/lib/reorientation/funding-carry";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../src/lib/statistical-validation";
import { evaluateMinBtl } from "../src/lib/significance/trial-count";
import { haircutSharpe } from "../src/lib/significance/haircut";
import { planHoldoutSplit } from "../src/lib/significance/holdout";

const OUT_DIR = join("output", "funding");
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
const INTERVALS_PER_YEAR = 365.25 * 3;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
function pct(v: number): string {
  return `${(v * 100).toFixed(3)}%`;
}

interface PriceRow {
  date: string;
  spotClose: number;
  perpClose: number;
}

function loadFunding(symbol: string): FundingInterval[] {
  const path = join(OUT_DIR, `${symbol}_funding_8h.json`);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { fundingTime: number; fundingRate: number }[];
  return raw
    .filter((r) => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}
function loadPrices(symbol: string): PriceRow[] {
  const path = join(OUT_DIR, `${symbol}_prices_daily.json`);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as PriceRow[];
}

/**
 * Attach a per-interval basisMove to each funding interval by mapping the funding
 * settlement to the day's perp-vs-spot basis change. There are ~3 funding intervals
 * per day; we apply the daily basis change to the funding interval whose timestamp
 * falls on that UTC date (first interval of the day), 0 otherwise.
 */
function attachBasisMoves(funding: FundingInterval[], prices: PriceRow[]): FundingInterval[] {
  if (prices.length === 0) return funding;
  const spot = prices.map((p) => p.spotClose);
  const perp = prices.map((p) => p.perpClose);
  const dailyMoves = deriveBasisMoves(spot, perp);
  const moveByDate = new Map<string, number>();
  prices.forEach((p, i) => moveByDate.set(p.date, dailyMoves[i] ?? 0));
  const seenDate = new Set<string>();
  return funding.map((f) => {
    const date = new Date(f.fundingTime).toISOString().slice(0, 10);
    let basisMove = 0;
    if (!seenDate.has(date)) {
      seenDate.add(date);
      basisMove = moveByDate.get(date) ?? 0;
    }
    return { ...f, basisMove };
  });
}

function runSymbol(symbol: string, roundTripCostPerLeg: number) {
  const funding = loadFunding(symbol);
  const prices = loadPrices(symbol);
  if (funding.length === 0) return null;
  const withBasis = attachBasisMoves(funding, prices);

  // REALISTIC carry design = continuous hold with HYSTERESIS, not sign-flip churn.
  // A delta-neutral desk does NOT unwind both legs every 8h when funding briefly
  // dips negative (that pays 16bps round-trip on noise — see the naive contrast).
  // Enter once funding is positive; only EXIT on a SUSTAINED deeply-negative bar
  // (exitThreshold = -0.0002 = -2bp/8h), so single negative prints are held through.
  const entryThreshold = 0.00002; // enter when funding > 0.2bp/8h
  const exitThreshold = -0.0002; // exit only on a clearly-negative regime (-2bp/8h)
  const result = simulateFundingCarry(withBasis, {
    entryThreshold,
    exitThreshold,
    takerFeePerLeg: roundTripCostPerLeg,
    rebalanceDriftThreshold: 0.0075,
    intervalsPerYear: INTERVALS_PER_YEAR,
  });
  // Naive sign-flip gate (exit at funding<=0) kept as a churn contrast.
  const naive = simulateFundingCarry(withBasis, {
    entryThreshold: 0.00005,
    exitThreshold: 0,
    takerFeePerLeg: roundTripCostPerLeg,
    rebalanceDriftThreshold: 0.0075,
    intervalsPerYear: INTERVALS_PER_YEAR,
  });
  return { symbol, funding: withBasis, result, naive };
}

function main(): void {
  const which = arg("--symbol", "ALL").toUpperCase();
  // Binance USDT-perp taker fee ≈ 4 bps/leg; round-trip (open+close, 2 legs) = 16 bps.
  // The brief allows a lower figure than 28bps when realistic for the instrument:
  // carry trades taker on perp + spot; we use 4bps/leg (= 8bps/leg-pair, 16bps RT).
  const feePerLeg = Number(arg("--cost", "0.0004"));

  console.log("=".repeat(80));
  console.log("EXPERIMENT 2 — FUNDING-RATE CARRY FEASIBILITY (delta-neutral, structural)");
  console.log("=".repeat(80));

  const manifestPath = join(OUT_DIR, "manifest.json");
  let dataSource = "unknown";
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { source?: string };
    dataSource = m.source ?? "unknown";
  }
  console.log(`data source        : ${dataSource}  (output/funding/)`);
  console.log(`fee per leg        : ${pct(feePerLeg)}  (round-trip 2 legs x 2 sides = ${pct(feePerLeg * 4)})`);
  console.log(`design             : continuous hold + hysteresis (enter funding>0.2bp/8h, exit only on -2bp/8h)`);
  console.log(`annualization      : ${INTERVALS_PER_YEAR.toFixed(2)} funding intervals/yr (8h)\n`);

  const targets = which === "ALL" ? SYMBOLS : [which];
  const runs = targets.map((s) => runSymbol(s, feePerLeg)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (runs.length === 0) {
    console.log("NO DATA — run scripts/fetch-funding-rates.mjs first.");
    return;
  }

  // ---- Per-symbol feasibility table ----
  console.log("-- Per-symbol carry feasibility (real funding, net of fees; continuous-hold + hysteresis) --");
  console.log(
    "symbol    netAPR    grossAPR   maxDD    %in-pos  vol(ann)  entries  fees3y   naiveAPR(churn)",
  );
  for (const { symbol, result, naive } of runs) {
    console.log(
      `${symbol.padEnd(9)} ${pct(result.netApr).padStart(8)} ${pct(result.grossApr).padStart(9)} ` +
        `${pct(result.maxDrawdown).padStart(8)} ${(result.fractionInPosition * 100).toFixed(1).padStart(6)}% ` +
        `${pct(result.realizedVolAnnualized).padStart(8)} ${String(result.entries).padStart(7)} ` +
        `${pct(result.totalFeesPaid).padStart(7)} ${pct(naive.netApr).padStart(10)}`,
    );
  }
  console.log("  (naiveAPR = sign-flip exit-at-0 gate: churns a 16bp round-trip on every funding dip)");

  // ---- Pooled, equal-weight carry across all symbols (the deployable book) ----
  // Pool the per-interval net returns across symbols (equal-weight diversified book).
  const pooledReturns: number[] = [];
  for (const { result } of runs) pooledReturns.push(...result.netReturns);
  const pooledStats = summarizeReturnSeries(pooledReturns);

  // The deployable book is the equal-weight average APR (diversification reduces vol).
  const meanNetApr = runs.reduce((s, r) => s + r.result.netApr, 0) / runs.length;
  const meanGrossApr = runs.reduce((s, r) => s + r.result.grossApr, 0) / runs.length;
  const worstDd = Math.max(...runs.map((r) => r.result.maxDrawdown));
  const meanInPos = runs.reduce((s, r) => s + r.result.fractionInPosition, 0) / runs.length;

  // Build an equal-weight diversified per-interval series (mean across symbols per index)
  // for the DSR/holdout — aligned by interval index (all symbols have equal length).
  const len = Math.min(...runs.map((r) => r.result.netReturns.length));
  const diversified: number[] = [];
  for (let i = 0; i < len; i += 1) {
    let s = 0;
    for (const r of runs) s += r.result.netReturns[i]!;
    diversified.push(s / runs.length);
  }
  const divStats = summarizeReturnSeries(diversified);
  const divApr = Math.expm1(divStats.mean * INTERVALS_PER_YEAR);
  const divVolAnn = divStats.stdDev * Math.sqrt(INTERVALS_PER_YEAR);
  const divSharpeAnn = divVolAnn > 0 ? (divApr) / divVolAnn : 0;

  console.log("\n-- Pooled / diversified equal-weight book --");
  console.log(`  symbols pooled            : ${runs.length}`);
  console.log(`  mean per-symbol net APR   : ${pct(meanNetApr)}  (gross ${pct(meanGrossApr)})`);
  console.log(`  diversified book net APR  : ${pct(divApr)}`);
  console.log(`  diversified ann. vol      : ${pct(divVolAnn)}`);
  console.log(`  diversified ann. Sharpe   : ${divSharpeAnn.toFixed(3)}  (APR/vol)`);
  console.log(`  worst single-symbol maxDD : ${pct(worstDd)}`);
  console.log(`  mean %-in-position        : ${(meanInPos * 100).toFixed(1)}%`);

  // ---- Gate: Deflated Sharpe on per-interval diversified net returns (N=1 trial) ----
  // Carry is a SINGLE structural strategy, not a multiple-tested search: trialCount=1.
  // Low N caveat noted. The DSR here mainly confirms the per-interval Sharpe is
  // statistically distinguishable from 0 given the sample length.
  const dsr = computeDeflatedSharpeRatio(diversified, { trialCount: 1 });
  console.log("\n-- Gate 1: Deflated Sharpe (per-interval, N=1 trial — ONE strategy, low N) --");
  console.log(`  per-interval Sharpe       : ${dsr.sharpe.toFixed(5)}  (sample=${dsr.sampleCount})`);
  console.log(`  PSR/DSR probability       : ${dsr.probability.toFixed(4)}`);
  console.log(`  NOTE: carry is not a searched population; trialCount=1, so DSR≈PSR here.`);

  // ---- Gate 2: McLean-Pontiff 50% in-sample Sharpe haircut ----
  // Decay realism: published anomalies lose ~50% post-publication. We HALVE the
  // in-sample per-interval Sharpe and re-annualize, then re-derive a haircut APR.
  const decaySharpe = dsr.sharpe * 0.5;
  const haircutApr = Math.expm1(decaySharpe * divStats.stdDev * INTERVALS_PER_YEAR);
  // Also apply the multiple-testing haircut machinery (conservative, even at N=1->small).
  const mtHaircut = haircutSharpe({
    observedSharpe: dsr.sharpe,
    sampleCount: dsr.sampleCount,
    trialCount: 1,
    method: "bonferroni",
  });
  console.log("\n-- Gate 2: Decay/compression haircut (McLean-Pontiff 50%) --");
  console.log(`  in-sample per-int Sharpe  : ${dsr.sharpe.toFixed(5)}`);
  console.log(`  after 50% decay haircut   : ${decaySharpe.toFixed(5)}`);
  console.log(`  implied haircut net APR   : ${pct(haircutApr)}  (decayed Sharpe re-annualized)`);
  console.log(`  multiple-test haircutSharpe(N=1): ${mtHaircut.haircutSharpe.toFixed(5)} (p=${mtHaircut.pValue.toExponential(2)})`);

  // ---- Gate 3: MinBTL — is the sample long enough for this Sharpe at N=1? ----
  const minBtl = evaluateMinBtl({ trialCount: 1, sampleCount: dsr.sampleCount, observedSharpe: dsr.sharpe });
  console.log("\n-- Gate 3: Minimum Backtest Length (N=1) --");
  console.log(`  expected max NULL Sharpe  : ${minBtl.expectedMaxNullSharpe.toFixed(5)}`);
  console.log(`  min sample for Sharpe     : ${minBtl.minSampleForObservedSharpe}`);
  console.log(`  sufficient length         : ${minBtl.sufficientLength ? "YES" : "NO"} (${minBtl.reason})`);

  // ---- Gate 4: Post-2021 / hold-out slice must independently survive ----
  // The vault is the most-recent 30% of intervals (forward-looking, post-search).
  const plan = planHoldoutSplit({ totalRows: diversified.length, holdoutFraction: 0.3, testFraction: 0.0 });
  const holdout = diversified.slice(plan.finalHoldout.start, plan.finalHoldout.end);
  const holdoutStats = summarizeReturnSeries(holdout);
  const holdoutApr = Math.expm1(holdoutStats.mean * INTERVALS_PER_YEAR);
  const searchSlice = diversified.slice(plan.search.start, plan.search.end);
  const searchStats = summarizeReturnSeries(searchSlice);
  const searchApr = Math.expm1(searchStats.mean * INTERVALS_PER_YEAR);
  console.log("\n-- Gate 4: Hold-out slice (most-recent 30%, forward-looking) --");
  console.log(`  search slice net APR      : ${pct(searchApr)}  (${searchSlice.length} intervals)`);
  console.log(`  hold-out net APR          : ${pct(holdoutApr)}  (${holdout.length} intervals)`);
  console.log(`  hold-out survives (>0)    : ${holdoutApr > 0 ? "YES" : "NO"}`);

  // ---- Stress: sustained negative funding + FTX-style counterparty gap ----
  // Stress the diversified book: build a CarryResult-like buffer from the diversified
  // cumulative yield, then apply the negative regime + gap.
  const divCumulative = Math.expm1(diversified.reduce((s, r) => s + Math.log1p(Math.max(-0.999999, r)), 0));
  const stressBaseline = {
    ...runs[0]!.result,
    netCumulativeYield: divCumulative,
  };
  const stress = stressFundingCarry(stressBaseline, {
    negativeRegimeIntervals: 90, // ~30 days of -5bp/8h funding (sustained negative regime)
    negativeRegimeRate: -0.0005,
    counterpartyGapLoss: 0.5, // FTX-style: lose 50% of notional on the short leg
    takerFeePerLeg: feePerLeg,
    intervalsPerYear: INTERVALS_PER_YEAR,
  });
  console.log("\n-- Stress: sustained negative-funding regime + FTX-style counterparty gap --");
  console.log(`  diversified buffer (cum)  : ${pct(divCumulative)}  (3y compounded net carry)`);
  console.log(`  sustained -5bp/8h x90 net : ${pct(stress.negativeRegimeNetReturn)}`);
  console.log(`  counterparty gap loss     : ${pct(stress.counterpartyGapLoss)} of notional (short leg wiped)`);
  console.log(`  stressed cumulative yield : ${pct(stress.stressedCumulativeYield)}`);
  console.log(`  survival floor            : ${pct(stress.survivalFloor)}`);
  console.log(`  SURVIVABLE                : ${stress.survivable ? "YES" : "NO"} (${stress.reason})`);

  // Gap-loss sensitivity — survival is dominated by the counterparty-gap assumption,
  // so show the break-even gap and a sweep (the carry buffer is only ~18% over 3y).
  console.log("\n  gap-loss sensitivity (sustained-neg regime held fixed):");
  for (const gl of [0.1, 0.25, 0.35, 0.5, 0.75]) {
    const s = stressFundingCarry(stressBaseline, {
      negativeRegimeIntervals: 90,
      negativeRegimeRate: -0.0005,
      counterpartyGapLoss: gl,
      takerFeePerLeg: feePerLeg,
      intervalsPerYear: INTERVALS_PER_YEAR,
    });
    console.log(`    gap=${(gl * 100).toFixed(0).padStart(3)}% -> stressed=${pct(s.stressedCumulativeYield).padStart(9)}  survivable=${s.survivable ? "YES" : "NO"}`);
  }
  console.log("  NOTE: a 3y carry buffer (~18%) CANNOT absorb a full-notional venue failure;");
  console.log("        survival depends on the gap hitting only the short-leg margin/uPnL, not");
  console.log("        the whole book. This is the dominant tail risk for carry, not funding sign.");

  // ---- VERDICT ----
  const aprClearlyPositive = haircutApr > 0.02; // >2% net APR after the 50% decay haircut
  const holdoutOk = holdoutApr > 0;
  const survivable = stress.survivable;
  const promote = aprClearlyPositive && holdoutOk && survivable;

  console.log("\n" + "=".repeat(80));
  console.log("VERDICT (carry: net APR vs drawdown + worst-case survivability — NOT a baseline beat)");
  console.log("=".repeat(80));
  console.log(`  haircut net APR > 2%      : ${aprClearlyPositive ? "YES" : "NO"} (${pct(haircutApr)})`);
  console.log(`  hold-out slice positive   : ${holdoutOk ? "YES" : "NO"} (${pct(holdoutApr)})`);
  console.log(`  worst-case survivable     : ${survivable ? "YES" : "NO"} (${pct(stress.stressedCumulativeYield)})`);
  if (promote) {
    console.log(`\n  ==> PROMOTE: delta-neutral funding carry is net-positive after fees and the`);
    console.log(`      50% decay haircut (${pct(haircutApr)} APR), survives the forward hold-out`);
    console.log(`      (${pct(holdoutApr)} APR), and survives a sustained-negative + counterparty-gap`);
    console.log(`      stress (${pct(stress.stressedCumulativeYield)} cumulative). Structurally feasible.`);
  } else {
    const why = [
      aprClearlyPositive ? null : "haircut APR not clearly positive",
      holdoutOk ? null : "hold-out slice not positive",
      survivable ? null : "worst-case not survivable",
    ].filter(Boolean).join("; ");
    console.log(`\n  ==> ${survivable ? "INCONCLUSIVE" : "KILL"}: ${why}.`);
  }
  console.log("=".repeat(80));
}

main();
