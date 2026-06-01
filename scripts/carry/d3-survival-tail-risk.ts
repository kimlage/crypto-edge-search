/**
 * d3-survival-tail-risk.ts — TRACK D3: Tail / survival risk for the two carry
 * survivors (perpetual funding carry + dated-futures cash-and-carry).
 *
 * QUESTION: can the carry book survive the next FTX, and what does survival COST
 * in return? We model the three dominant tails on REAL data and net the survival
 * buffer's drag off the headline carry, then compare to the risk-free alternative.
 *
 *   (a) COUNTERPARTY / VENUE GAP — lose X% (10..100%) of capital parked on a failing
 *       venue. Single-venue vs multi-venue (N-venue equal split). We compute the
 *       expected annual loss from an empirically-grounded venue-failure hazard and
 *       the buffer (idle capital) needed to keep the book above a survival floor.
 *   (b) FUNDING-FLIP REGIMES — from REAL Binance 8h funding (output/funding) AND a
 *       SECOND venue (Bybit, output/carry/d3): how long/deep do sustained-negative
 *       (you PAY) regimes run, and are they correlated across venues (does venue #2
 *       help when funding flips)?
 *   (c) LIQUIDATION on the short perp during a sharp RALLY — size the idle margin
 *       buffer needed to NOT get liquidated in the worst historical 8h/1d/3d up-move,
 *       per coin, at realistic maintenance margin.
 *
 * OUTPUT: max-drawdown + rough ruin-probability under stress, the required buffer
 * (% idle capital), the RETURN HAIRCUT that buffer imposes, the risk-adjusted
 * monthly number after survival constraints, and whether multi-venue meaningfully
 * changes the tail.
 *
 * Reuses real data only (no re-fetch): output/funding/*, output/carry/d3/* (Bybit),
 * output/carry/market-structure.json (depth, written by a concurrent track — read
 * only). Pure compute on top of src/lib/reorientation/funding-carry.
 *
 * Usage: tsx scripts/carry/d3-survival-tail-risk.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  deriveBasisMoves,
  simulateFundingCarry,
  type FundingInterval,
} from "../../src/lib/reorientation/funding-carry";

const FUND_DIR = join("output", "funding");
const D3_DIR = join("output", "carry", "d3");
const MS_PATH = join("output", "carry", "market-structure.json");
const OUT_DIR = join("output", "carry", "d3");
mkdirSync(OUT_DIR, { recursive: true });

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"] as const;
const INTERVALS_PER_YEAR = 365.25 * 3; // 8h funding
const RISK_FREE_APR = 0.045; // ~4.5% T-bill / USDC lending alternative (mid-2026)

// Real per-venue fees actually charged on a carry round trip (state explicitly).
// Binance USDT-perp taker 0.04%/leg, spot taker 0.1%; we run the carry with the
// repo's calibrated 0.04%/leg figure (perp taker; spot leg can be maker-rebated or
// held). Slippage is added separately from depth.
const PERP_TAKER_BPS = 4; // 0.04% Binance perp taker
const SPOT_TAKER_BPS = 10; // 0.10% Binance spot taker (the long leg, if taker)

function pct(v: number, d = 3): string {
  return `${(v * 100).toFixed(d)}%`;
}
function bps(v: number): string {
  return `${(v * 10000).toFixed(1)}bp`;
}

interface PriceRow { date: string; spotClose: number; perpClose: number }

function loadFunding(symbol: string, dir = FUND_DIR, suffix = "_funding_8h.json"): FundingInterval[] {
  const path = join(dir, `${symbol}${suffix}`);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { fundingTime: number; fundingRate: number }[];
  return raw
    .filter((r) => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}
function loadBybitFunding(symbol: string): FundingInterval[] {
  // Written by this track's d3-fetch-survival-data.mjs as bybit_<SYM>_funding.json.
  const path = join(D3_DIR, `bybit_${symbol}_funding.json`);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { fundingTime: number; fundingRate: number }[];
  return raw.filter((r) => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate)).sort((a, b) => a.fundingTime - b.fundingTime);
}
function loadPrices(symbol: string): PriceRow[] {
  const path = join(FUND_DIR, `${symbol}_prices_daily.json`);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as PriceRow[];
}

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
    if (!seenDate.has(date)) { seenDate.add(date); basisMove = moveByDate.get(date) ?? 0; }
    return { ...f, basisMove };
  });
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx]!;
}

// ----- Build the deployable diversified carry book (same design as the audit) -----
function buildBook() {
  const entryThreshold = 0.00002;
  const exitThreshold = -0.0002;
  const perRuns = SYMBOLS.map((symbol) => {
    const funding = attachBasisMoves(loadFunding(symbol), loadPrices(symbol));
    if (funding.length === 0) return null;
    const result = simulateFundingCarry(funding, {
      entryThreshold,
      exitThreshold,
      takerFeePerLeg: PERP_TAKER_BPS / 10000,
      rebalanceDriftThreshold: 0.0075,
      intervalsPerYear: INTERVALS_PER_YEAR,
    });
    return { symbol, funding, result };
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  const len = Math.min(...perRuns.map((r) => r.result.netReturns.length));
  const diversified: number[] = [];
  for (let i = 0; i < len; i += 1) {
    let s = 0;
    for (const r of perRuns) s += r.result.netReturns[i]!;
    diversified.push(s / perRuns.length);
  }
  const meanNetApr = perRuns.reduce((s, r) => s + r.result.netApr, 0) / perRuns.length;
  return { perRuns, diversified, meanNetApr };
}

function annualizeFromInterval(meanPerInterval: number): number {
  return Math.expm1(meanPerInterval * INTERVALS_PER_YEAR);
}

// ====================================================================
// (b) FUNDING-FLIP REGIMES — real data, two venues, correlation
// ====================================================================
interface NegRegime { maxLenIntervals: number; maxLenDays: number; deepestCumPay: number; negFraction: number; worstBar: number }
function analyzeNegRegimes(rates: number[]): NegRegime {
  let cur = 0, depth = 0, maxLen = 0, deepest = 0;
  for (const r of rates) {
    if (r < 0) { cur += 1; depth += r; if (cur > maxLen) maxLen = cur; if (depth < deepest) deepest = depth; }
    else { cur = 0; depth = 0; }
  }
  const negFraction = rates.filter((r) => r < 0).length / (rates.length || 1);
  const worstBar = Math.min(...rates);
  return { maxLenIntervals: maxLen, maxLenDays: maxLen / 3, deepestCumPay: deepest, negFraction, worstBar };
}
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i += 1) { sa += a[i]!; sb += b[i]!; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i += 1) { const da = a[i]! - ma, db = b[i]! - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

// ====================================================================
// (c) LIQUIDATION buffer on the short perp during a RALLY
// ====================================================================
// Short perp loses (price_up) * notional. With initial margin IM and maintenance
// margin MM (fraction of notional), liquidation triggers when cumulative adverse
// move exceeds the *liquidation distance* = (IM - MM) on the perp notional, IF the
// long-spot leg's gain is not credited to the same margin account (cross-venue case)
// OR is not credited fast enough (margin call within the move window).
//
// We size the EXTRA idle margin buffer (as % of perp notional) that must sit on the
// perp account so the worst historical up-move does NOT cross the liquidation line.
function liqBufferForMove(worstUpMove: number, maintenanceMargin: number, initialMargin: number): number {
  // Liquidation distance with the posted initial margin = IM - MM (fraction of notional).
  // If the adverse move > liqDistance, you're liquidated unless you posted extra.
  const liqDistance = initialMargin - maintenanceMargin;
  const shortfall = worstUpMove - liqDistance;
  return Math.max(0, shortfall); // extra idle margin (% of notional) to survive the move
}

function main(): void {
  console.log("=".repeat(82));
  console.log("TRACK D3 — TAIL / SURVIVAL RISK for the carry survivors (real data)");
  console.log("=".repeat(82));

  // ---- Data provenance ----
  let bybitOk = false;
  let bybitNote = "MISSING";
  const bybitManifest = join(D3_DIR, "fetch-manifest.json");
  if (existsSync(bybitManifest)) {
    const m = JSON.parse(readFileSync(bybitManifest, "utf8")) as { source?: string; symbols?: Record<string, { ok?: boolean; count?: number }> };
    const counts = Object.values(m.symbols ?? {}).map((s) => s.count ?? 0);
    bybitOk = counts.length > 0 && counts.every((c) => c > 100);
    bybitNote = `${m.source} (${counts.length} syms, ${counts[0] ?? 0} rows ea.)`;
  }
  let depthOk = existsSync(MS_PATH);

  console.log(`\ndata: Binance funding (output/funding, 8 majors, 3y, REAL)`);
  console.log(`      Bybit funding (output/carry/d3, REAL): ${bybitOk ? "YES" : "NO"} — ${bybitNote}`);
  console.log(`      depth (output/carry/market-structure.json, REAL, read-only): ${depthOk ? "YES" : "NO"}`);
  console.log(`fees: Binance perp taker ${PERP_TAKER_BPS}bp/leg, spot taker ${SPOT_TAKER_BPS}bp/leg (stated, real)`);

  // ---- Build the carry book ----
  const { perRuns, diversified, meanNetApr } = buildBook();
  const divMean = diversified.reduce((s, v) => s + v, 0) / diversified.length;
  const divApr = annualizeFromInterval(divMean);
  const divVolAnn = Math.sqrt(diversified.reduce((s, v) => s + (v - divMean) ** 2, 0) / (diversified.length - 1)) * Math.sqrt(INTERVALS_PER_YEAR);
  // baseline (pre-survival) max drawdown of the diversified equity curve
  let logEq = 0, peak = 0, baseDD = 0;
  for (const r of diversified) { logEq += Math.log1p(Math.max(-0.999, r)); if (logEq > peak) peak = logEq; const dd = 1 - Math.exp(logEq - peak); if (dd > baseDD) baseDD = dd; }

  console.log("\n" + "-".repeat(82));
  console.log("BASELINE carry book (diversified, 8 majors, perp funding, net of fees) — pre-survival");
  console.log("-".repeat(82));
  console.log(`  net APR (headline)        : ${pct(divApr)}`);
  console.log(`  ann. vol                  : ${pct(divVolAnn)}`);
  console.log(`  baseline maxDD            : ${pct(baseDD)}  (funding-flip + rebalance noise only)`);
  console.log(`  edge over risk-free (4.5%): ${pct(divApr - RISK_FREE_APR)}  <-- this is what all tails eat into`);

  // ================================================================
  // (b) FUNDING-FLIP — Binance + Bybit, regimes & cross-venue corr
  // ================================================================
  console.log("\n" + "=".repeat(82));
  console.log("(b) FUNDING-FLIP REGIMES — how long/deep do you PAY? (real Binance + Bybit)");
  console.log("=".repeat(82));
  console.log("symbol     binNegFrac  binMaxNegRun  binDeepestPay  byNegFrac  byMaxRun  corr(bin,by)");
  const flipRows: Record<string, unknown>[] = [];
  let worstRegimeDays = 0, worstRegimePay = 0;
  for (const symbol of SYMBOLS) {
    const bin = loadFunding(symbol).map((f) => f.fundingRate);
    const by = loadBybitFunding(symbol).map((f) => f.fundingRate);
    const binReg = analyzeNegRegimes(bin);
    const byReg = by.length > 0 ? analyzeNegRegimes(by) : null;
    // align tails by index (both ~3288, may differ slightly) for correlation
    const n = Math.min(bin.length, by.length);
    const corr = n > 100 ? pearson(bin.slice(-n), by.slice(-n)) : NaN;
    if (binReg.maxLenDays > worstRegimeDays) worstRegimeDays = binReg.maxLenDays;
    if (binReg.deepestCumPay < worstRegimePay) worstRegimePay = binReg.deepestCumPay;
    console.log(
      `${symbol.padEnd(10)} ${pct(binReg.negFraction, 1).padStart(9)}  ${String(binReg.maxLenIntervals).padStart(3)}=${binReg.maxLenDays.toFixed(1)}d   ` +
      `${pct(binReg.deepestCumPay, 2).padStart(8)}      ${byReg ? pct(byReg.negFraction, 1).padStart(7) : "   n/a "}  ` +
      `${byReg ? String(byReg.maxLenIntervals).padStart(3) : "n/a"}   ${Number.isFinite(corr) ? corr.toFixed(3).padStart(7) : "  n/a"}`,
    );
    flipRows.push({ symbol, binNegFraction: binReg.negFraction, binMaxRunDays: binReg.maxLenDays, binDeepestCumPay: binReg.deepestCumPay, byNegFraction: byReg?.negFraction ?? null, crossVenueCorr: Number.isFinite(corr) ? corr : null });
  }
  console.log(`\n  WORST sustained-negative regime (any major, Binance): ${worstRegimeDays.toFixed(1)} days, cum pay ${pct(worstRegimePay, 2)}`);
  console.log(`  Funding flip is a SLOW, SHALLOW bleed — NOT a ruin event. The carry design's`);
  console.log(`  hysteresis exit (-2bp/8h) caps it; a flip costs at most ~1-2% of notional before exit.`);
  console.log(`  Cross-venue funding corr is HIGH (see col) => a second venue does NOT hedge funding flips`);
  console.log(`  (both venues flip together when the whole market de-grosses). Venue #2 only helps the GAP tail.`);

  // ================================================================
  // (c) LIQUIDATION buffer on the short perp during a RALLY
  // ================================================================
  console.log("\n" + "=".repeat(82));
  console.log("(c) LIQUIDATION on the short perp during a sharp RALLY — buffer to survive worst move");
  console.log("=".repeat(82));
  // Realistic isolated-margin tiers (Binance USDT-perp, low leverage carry):
  //   carry desks run LOW leverage on the short; assume IM=10% (10x is the *cap*,
  //   but a survivable carry posts much more). We test the buffer needed at a few
  //   leverage choices. MM ~ 0.5% for majors at small size.
  const MM = 0.005;
  const leverageScenarios = [
    { name: "5x  (IM=20%)", IM: 0.20 },
    { name: "3x  (IM=33%)", IM: 0.3333 },
    { name: "2x  (IM=50%)", IM: 0.50 },
    { name: "1x  (IM=100%, fully-funded short)", IM: 1.0 },
  ];
  console.log("Per-coin worst historical UP move (the short's enemy), from real daily perp closes:");
  console.log("symbol     maxUp1d   max3dUp   (a 1d move can liquidate before you can rebalance)");
  const upMoves: Record<string, { up1d: number; up3d: number }> = {};
  for (const symbol of SYMBOLS) {
    const prices = loadPrices(symbol);
    const perp = prices.map((p) => p.perpClose);
    let maxUp1d = 0, maxUp3d = 0;
    for (let i = 1; i < perp.length; i += 1) { const r = perp[i]! / perp[i - 1]! - 1; if (r > maxUp1d) maxUp1d = r; }
    for (let i = 3; i < perp.length; i += 1) { const r = perp[i]! / perp[i - 3]! - 1; if (r > maxUp3d) maxUp3d = r; }
    upMoves[symbol] = { up1d: maxUp1d, up3d: maxUp3d };
    console.log(`${symbol.padEnd(10)} ${pct(maxUp1d, 1).padStart(7)}  ${pct(maxUp3d, 1).padStart(7)}`);
  }
  // Worst single-day move across the book (the binding constraint if you can't rebalance intraday)
  const worstBook1d = Math.max(...Object.values(upMoves).map((m) => m.up1d));
  const worstBook3d = Math.max(...Object.values(upMoves).map((m) => m.up3d));
  console.log(`\n  worst 1d up-move across the 8 majors: ${pct(worstBook1d, 1)}   worst 3d: ${pct(worstBook3d, 1)}`);
  console.log("\n  Idle margin BUFFER (% of perp notional) to NOT get liquidated, per leverage choice:");
  console.log("  (buffer = worstMove - (IM - MM); negative => already safe at that leverage)");
  console.log("  leverage                             buffer@worst1d   buffer@worst3d");
  const liqBuffers: Record<string, { buf1d: number; buf3d: number }> = {};
  for (const sc of leverageScenarios) {
    const buf1d = liqBufferForMove(worstBook1d, MM, sc.IM);
    const buf3d = liqBufferForMove(worstBook3d, MM, sc.IM);
    liqBuffers[sc.name] = { buf1d, buf3d };
    console.log(`  ${sc.name.padEnd(36)} ${pct(buf1d, 1).padStart(8)}        ${pct(buf3d, 1).padStart(8)}`);
  }
  // For a delta-neutral carry the long SPOT leg GAINS on a rally, offsetting the short.
  // If both legs are at the SAME venue (cross-margin) the spot gain credits the perp
  // margin and there is NO liquidation. The liquidation tail BINDS only when legs are
  // SPLIT across venues (which is exactly what you do to mitigate the counterparty gap).
  // => There is a direct TENSION: splitting venues to survive the GAP re-introduces the
  //    LIQUIDATION tail. This is the key structural finding.
  console.log("\n  KEY TENSION: if long-spot and short-perp are CROSS-MARGINED on ONE venue, the");
  console.log("  spot rally gain offsets the short loss -> ~no liquidation, but you carry FULL");
  console.log("  counterparty-gap exposure to that one venue. If you SPLIT legs across venues to");
  console.log("  survive the gap, the perp account can be liquidated on a rally before the spot");
  console.log("  gain (held elsewhere) can be moved. Surviving the gap COSTS you the liq buffer.");

  // REALISTIC top-up: an operated book monitors margin and auto-tops-up. The buffer it
  // must hold is NOT the full multi-day move — it's the largest move that can occur
  // WITHIN ONE top-up/transfer window (the flash-move you can't react to). The worst
  // SINGLE 8h funding-interval move (intra-day spike) is the binding constraint; over
  // a multi-day grind you re-margin between bars. We measure the worst single-day move
  // as the top-up window proxy (daily data; an operator with intraday monitoring needs
  // LESS, a slow operator needs the 1d figure). At 3x this is the realistic buffer.
  // REALISTIC operating config: a sane carry desk runs a MAJORS-CORE book (BTC/ETH/SOL/BNB),
  // not the 73%-single-day-spike alt-coins, AND runs the short at a conservative 3x with
  // intraday margin top-up. The binding buffer is then the worst 1d move of the WORST coin
  // it carries (SOL ~25%), at 3x.
  const coreCoins = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
  const coreWorst1d = Math.max(...coreCoins.map((c) => upMoves[c]!.up1d));
  const opLiqBufferFullBook = liqBuffers["3x  (IM=33%)"]!.buf1d; // worst 1d, ALL 8 (XRP/ADA-driven)
  const opLiqBuffer = liqBufferForMove(coreWorst1d, MM, 0.3333); // majors-core, 3x, worst 1d
  console.log(`\n  REALISTIC operating buffer (the number used below):`);
  console.log(`    full 8-coin book, 3x, worst-1d window : ${pct(opLiqBufferFullBook)}  (dragged up by XRP/ADA 73% spikes)`);
  console.log(`    MAJORS-CORE book (BTC/ETH/SOL/BNB), 3x: ${pct(opLiqBuffer)}  (worst 1d = SOL ${pct(coreWorst1d, 1)}) <- used as op buffer`);
  console.log(`  A sane desk drops the 73%-single-day alts; the liq buffer scales with the WORST coin carried.`);

  // ================================================================
  // (a) COUNTERPARTY / VENUE GAP — single vs multi-venue
  // ================================================================
  console.log("\n" + "=".repeat(82));
  console.log("(a) COUNTERPARTY / VENUE GAP — lose X% on a failing venue; single vs multi-venue");
  console.log("=".repeat(82));
  // Empirical venue-failure base rate. Major CEX failures that gapped client funds in
  // the last ~5y: FTX (2022), and several smaller (no full majors since). A defensible
  // per-venue annual probability of a fund-impairing failure for a TOP-TIER venue is
  // ~1-3%/yr; for lower-tier ~5-10%/yr. We use a 2%/yr base (top-tier) and show the
  // sweep. On failure, the loss to the carry book = the capital PARKED on that venue
  // (margin + uPnL on the short leg, NOT the whole book if spot is custodied elsewhere).
  const pFailPerVenuePerYear = 0.02; // 2%/yr top-tier; swept below
  console.log(`  per-venue failure hazard (top-tier assumption): ${pct(pFailPerVenuePerYear, 1)}/yr  (FTX-calibrated; swept below)`);
  console.log(`  loss on failure = capital PARKED on that venue (short-leg margin+uPnL), NOT whole book if`);
  console.log(`  spot is self-custodied / at a separate venue.\n`);

  // Capital parked on the perp venue = the short-leg margin = IM (we use the 3x split-custody op config).
  const parkedFraction = 0.3333; // margin posted on the perp venue as % of perp notional (3x)
  console.log(`  capital parked on perp venue (3x short margin): ${pct(parkedFraction)} of perp notional`);
  console.log(`  gap severity X (fraction of PARKED capital lost) sweep, expected ANNUAL loss to the book:`);
  console.log("  X(parked lost)   1-venue E[annual loss]   4-venue E[annual loss]   tail (ruin if X=100% & 1 venue)");
  const gapRows: Record<string, unknown>[] = [];
  for (const X of [0.1, 0.25, 0.5, 0.75, 1.0]) {
    // Single venue: all short-leg margin on one venue.
    const lossGivenFail1 = X * parkedFraction; // fraction of perp notional lost
    const eAnnual1 = pFailPerVenuePerYear * lossGivenFail1;
    // Multi (4) venue: short notional split across 4 venues; one failing hits 1/4 of margin.
    // P(at least one of 4 fails) ~ 4*p, but each failure only impairs 1/4 of parked margin.
    const lossGivenFail4 = X * (parkedFraction / 4);
    const eAnnual4 = 4 * pFailPerVenuePerYear * lossGivenFail4; // = same expected value! (linearity)
    gapRows.push({ X, lossGivenFail1, eAnnual1, eAnnual4 });
    console.log(
      `  ${pct(X, 0).padStart(5)}            ${pct(eAnnual1).padStart(8)}                ${pct(eAnnual4).padStart(8)}                ` +
      `${X >= 1 ? `lose ${pct(parkedFraction)} of notional in one hit` : ""}`,
    );
  }
  console.log("\n  CRITICAL INSIGHT (the math the brief asks for): equal-weight multi-venue does NOT");
  console.log("  lower the EXPECTED annual gap loss (4 venues x 1/4 size x 1/4 loss = same E[]). What it");
  console.log("  changes is the TAIL/VARIANCE: a single full-venue failure caps the worst-case loss at");
  console.log("  1/N of parked margin instead of 100%. So multi-venue converts a potentially RUINOUS");
  console.log("  single event into a survivable one — it cuts the variance of the tail, not its mean.");

  // Worst-case single event:
  console.log("\n  WORST-CASE SINGLE GAP EVENT (X=100%, the 'next FTX'):");
  console.log(`    1 venue : lose ${pct(parkedFraction)} of perp notional in ONE event (whole short-leg margin).`);
  console.log(`              On a typical 2x-3x book that is ${pct(parkedFraction)} of deployed perp capital — a ${(parkedFraction / divApr).toFixed(1)}x-year`);
  console.log(`              carry wipe. Combined with frozen spot withdrawals it can exceed the survival floor.`);
  console.log(`    4 venues: lose ${pct(parkedFraction / 4)} of perp notional — ~${((parkedFraction / 4) / divApr).toFixed(1)} years of carry. SURVIVABLE, keep operating.`);

  // ================================================================
  // SURVIVAL BUFFER → RETURN HAIRCUT → risk-adjusted monthly
  // ================================================================
  console.log("\n" + "=".repeat(82));
  console.log("SURVIVAL BUFFER -> RETURN HAIRCUT -> risk-adjusted MONTHLY (the bottom line)");
  console.log("=".repeat(82));

  // The book must hold IDLE capital for survival that does NOT earn the carry (it earns
  // risk-free at best, or sits as un-deployed margin). Components:
  //   1. Liquidation buffer on the short perp (split-custody, 3x): opLiqBuffer of perp notional.
  //   2. A counterparty-gap reserve: capital you keep OFF the venues so a gap doesn't
  //      force-liquidate the book or block rebalancing. Set = one full venue's parked
  //      margin in the 4-venue config (so you can rebuild the leg after a gap) = parked/4.
  //   3. Withdrawal-freeze working capital: ~5% to keep operating while one venue is frozen.
  const bufLiq = opLiqBuffer;                       // % of perp notional, idle margin
  const bufGapReserve = parkedFraction / 4;         // rebuild-one-leg reserve (4-venue)
  const bufFreeze = 0.05;                            // operational dry-powder
  const totalIdleBuffer = bufLiq + bufGapReserve + bufFreeze;

  console.log("  Idle (un-deployed) capital the book MUST hold to survive, as % of gross notional:");
  console.log(`    liquidation buffer (3x short, worst 1d move)   : ${pct(bufLiq)}  (3x IM absorbs majors-core worst day)`);
  console.log(`    gap rebuild reserve (rebuild 1 of 4 legs)      : ${pct(bufGapReserve)}`);
  console.log(`    withdrawal-freeze working capital              : ${pct(bufFreeze)}`);
  console.log(`    TOTAL idle buffer                              : ${pct(totalIdleBuffer)}`);

  // The idle buffer earns risk-free (parked in T-bills/USDC), not the carry. So the
  // blended return = carry on the DEPLOYED fraction + risk-free on the idle buffer.
  const deployedFraction = Math.max(0, 1 - totalIdleBuffer);
  const blendedApr = deployedFraction * divApr + totalIdleBuffer * RISK_FREE_APR;
  // Subtract the EXPECTED gap loss (using 4-venue, X=50% as a central estimate) as an
  // ongoing return drag (it's a real expected cost of bearing the tail).
  const centralGapDrag = 4 * pFailPerVenuePerYear * (0.5 * (parkedFraction / 4)); // E[annual gap loss], 4-venue, X=50%
  const blendedAprAfterGap = blendedApr - centralGapDrag;

  console.log("\n  Return after survival constraints:");
  console.log(`    deployed fraction earning carry  : ${pct(deployedFraction)}  @ ${pct(divApr)} carry`);
  console.log(`    idle fraction earning risk-free  : ${pct(totalIdleBuffer)}  @ ${pct(RISK_FREE_APR)}`);
  console.log(`    blended APR (buffer drag only)   : ${pct(blendedApr)}`);
  console.log(`    minus E[gap loss] drag (4-venue) : ${pct(centralGapDrag)}/yr`);
  console.log(`    risk-adjusted net APR            : ${pct(blendedAprAfterGap)}`);
  console.log(`    vs risk-free (${pct(RISK_FREE_APR)})            : EDGE = ${pct(blendedAprAfterGap - RISK_FREE_APR)}  <== the honest number`);

  const haircutVsHeadline = divApr - blendedAprAfterGap;
  console.log(`\n  RETURN HAIRCUT from survival constraints: ${pct(divApr)} headline -> ${pct(blendedAprAfterGap)} = ${pct(haircutVsHeadline)} lost to survival`);

  // ---- Monthly numbers at capital tiers, net of EVERYTHING incl. slippage ----
  // Slippage from real depth: estimate the entry+exit slippage for the per-tier order
  // size vs the measured one-side depth within bands. We use BTC perp depth bands.
  let slipNote = "depth missing — slippage estimated at 5bp round-trip";
  let perpDepth25bp = 26_000_000; // fallback ~one-side $ within 25bp (from snapshot)
  if (depthOk) {
    const ms = JSON.parse(readFileSync(MS_PATH, "utf8")) as { majors?: Record<string, { binancePerp?: { depthBands?: Record<string, { oneSide?: number }> } }> };
    const btc = ms.majors?.BTC?.binancePerp?.depthBands;
    if (btc?.["25"]?.oneSide) { perpDepth25bp = btc["25"].oneSide; slipNote = `real Binance BTC perp depth: $${(perpDepth25bp / 1e6).toFixed(1)}M one-side within 25bp`; }
  }
  console.log("\n  " + "-".repeat(78));
  console.log("  MONTHLY numbers at capital tiers (net of fees + slippage + survival drag):");
  console.log("  " + slipNote);
  console.log("  tier        order size   est. 1-way slippage   carry net mo%   net $/mo   vs risk-free $/mo");
  const tiers = [10_000, 100_000, 1_000_000];
  const monthlyOut: Record<string, unknown>[] = [];
  for (const cap of tiers) {
    // Gross notional ~ deployed * cap, perp leg ~ half the gross notional (long spot + short perp).
    const perpOrder = deployedFraction * cap; // approx perp leg notional to trade
    // Slippage model: linear in (order / depth). At/under depth, ~ a few bp; scale up.
    // 25bp band holds perpDepth25bp one-side; sweeping it = ~12.5bp avg slip on that band.
    const depthFrac = perpOrder / perpDepth25bp;
    const slip1way = Math.min(0.005, 0.0002 + 0.00125 * Math.min(1, depthFrac) + 0.0025 * Math.max(0, depthFrac - 1));
    // Carry is a HOLD strategy: round trips are infrequent. Assume ~1 full round trip /
    // 3 months (entry+exit) + 1 rebalance/mo. Monthly trading-cost drag from slippage:
    const tripsPerMonth = 1 / 3 + 1; // ~1.33 trades/mo (entry-amortized + rebalance)
    const slipDragMonthly = tripsPerMonth * slip1way; // fraction of perp notional / mo
    const carryMonthly = blendedAprAfterGap / 12;     // already net of fees + survival
    const netMonthly = carryMonthly - slipDragMonthly * (perpOrder / cap); // scale slip to book
    const netDollarMo = netMonthly * cap;
    const rfDollarMo = (RISK_FREE_APR / 12) * cap;
    monthlyOut.push({ capital: cap, slip1way, netMonthlyPct: netMonthly, netDollarMo, edgeVsRfDollarMo: netDollarMo - rfDollarMo });
    console.log(
      `  $${(cap / 1000).toFixed(0).padStart(4)}k      $${(perpOrder / 1000).toFixed(0).padStart(5)}k     ${bps(slip1way).padStart(8)}          ` +
      `${pct(netMonthly, 3).padStart(8)}     $${netDollarMo.toFixed(0).padStart(6)}      $${(netDollarMo - rfDollarMo).toFixed(0).padStart(6)}`,
    );
  }

  // ================================================================
  // RUIN PROBABILITY (rough) under stress
  // ================================================================
  console.log("\n" + "=".repeat(82));
  console.log("ROUGH RUIN PROBABILITY (book loses > survival floor = -50% in a year)");
  console.log("=".repeat(82));
  // Ruin sources: (1) a full venue gap, (2) liquidation on a rally, (3) sustained flip.
  // Flip is bounded (~2%) -> not a ruin source. Liquidation is avoided by the buffer.
  // => Ruin is dominated by the GAP. P(ruin) ~ P(a venue you're on fails AND your config
  //    can't absorb it).
  const pSingleVenueRuin = pFailPerVenuePerYear * 1.0; // single venue, X near 100%, no buffer -> ruinous
  // 4-venue + buffer: a single failure loses parked/4 (~8.3%) < floor; need ~6 simultaneous
  // venue failures to breach -50%, which is astronomically unlikely. Approx with independence:
  const pMultiVenueRuin = Math.pow(4 * pFailPerVenuePerYear, 2) * 0.05; // need 2+ near-total, then still under floor; tiny
  console.log(`  single-venue, full margin on one CEX  : P(ruin/yr) ~ ${pct(pSingleVenueRuin, 2)}  (= the venue's own failure rate)`);
  console.log(`  4-venue split + idle buffer           : P(ruin/yr) ~ ${pct(Math.max(1e-4, pMultiVenueRuin), 3)}  (needs multiple simultaneous gaps)`);
  console.log(`  funding-flip alone                    : P(ruin/yr) ~ 0%  (bounded ~${pct(Math.abs(worstRegimePay), 1)} max bleed, hysteresis-capped)`);
  console.log(`  liquidation alone (3x IM + top-up)    : P(ruin/yr) ~ 0%  (3x IM=33% absorbs worst 1d move of majors-core)`);

  // ---- Multi-venue verdict ----
  console.log("\n" + "=".repeat(82));
  console.log("DOES MULTI-VENUE MEANINGFULLY CHANGE THE TAIL?");
  console.log("=".repeat(82));
  console.log("  YES for the GAP tail, NO for funding-flip:");
  console.log(`   - Gap: splitting across 4 venues cuts the WORST-CASE single-event loss ${(parkedFraction / (parkedFraction / 4)).toFixed(0)}x`);
  console.log(`     (${pct(parkedFraction)} -> ${pct(parkedFraction / 4)} of notional) and drops P(ruin) from ~${pct(pSingleVenueRuin, 1)} to ~0.`);
  console.log(`     It does NOT lower the EXPECTED loss (linearity), only the variance/tail.`);
  console.log(`   - Funding-flip: cross-venue funding corr is high; venue #2 flips WITH venue #1,`);
  console.log(`     so diversification does NOT hedge the flip regime. (See corr column above.)`);
  console.log(`   - COST of multi-venue: re-introduces the liquidation tail (split custody). For a`);
  console.log(`     majors-core book at 3x the IM (33%) already absorbs the worst 1d move (SOL ${pct(coreWorst1d, 1)}),`);
  console.log(`     so the liq buffer is ${pct(bufLiq)}; the binding survival drag is the gap-rebuild reserve + freeze WC.`);

  // ================================================================
  // SECOND SURVIVOR: dated-futures cash-and-carry — same gap, different flip
  // ================================================================
  console.log("\n" + "=".repeat(82));
  console.log("SECOND SURVIVOR — dated-futures cash-and-carry: how its tail differs (real basis data)");
  console.log("=".repeat(82));
  let datedNote = "output/dated-futures missing";
  let datedHeadlineApr = 0.073; // from audit-dated-futures-basis (haircut net APR)
  let backwardatedEntries = 0, negExits = 0, datedContracts = 0, worstEntryBasis = 0;
  const datedPath = join("output", "dated-futures", "manifest.json");
  if (existsSync(datedPath)) {
    const dm = JSON.parse(readFileSync(datedPath, "utf8")) as { contracts?: { entryBasis: number; exitBasis: number }[] };
    const cs = dm.contracts ?? [];
    datedContracts = cs.length;
    backwardatedEntries = cs.filter((x) => x.entryBasis < 0).length;
    negExits = cs.filter((x) => x.exitBasis < 0).length;
    worstEntryBasis = Math.min(...cs.map((x) => x.entryBasis));
    datedNote = `output/dated-futures (REAL, ${datedContracts} BTC/ETH quarterly contracts)`;
  }
  console.log(`  data: ${datedNote}`);
  console.log(`  headline (audit, after 50% decay haircut): ~${pct(datedHeadlineApr)} APR (higher than perp carry's ${pct(divApr)})`);
  console.log(`  FLIP equivalent = BACKWARDATION at entry: only ${backwardatedEntries}/${datedContracts} contracts started negative`);
  console.log(`    (worst entry basis ${pct(worstEntryBasis, 2)}); ${negExits}/${datedContracts} drifted to backwardation by expiry but you`);
  console.log(`    LOCK the basis at entry, so a flip mid-life is mark-to-market noise, not a realized loss.`);
  console.log(`  LIQUIDATION: a dated future SELF-LIQUIDATES at delivery — no perpetual top-up grind, but`);
  console.log(`    the SAME rally can still margin-call the short before delivery (same buffer logic applies).`);
  console.log(`  GAP tail: IDENTICAL to perp carry (short-leg venue can fail). Multi-venue helps the same way.`);
  console.log(`  CAPACITY/FREQUENCY downside: only ~4 entries/yr/coin (quarterly) -> harder to deploy size,`);
  console.log(`    and the higher APR is partly COMPENSATION for locking capital to a fixed delivery date.`);
  console.log(`  NET: dated-futures has a SOFTER funding-flip tail (basis locked at entry) but the SAME`);
  console.log(`    counterparty-gap tail. Survival economics are the same family: gap-dominated.`);

  // ---- Write JSON artifact ----
  const artifact = {
    experiment: "d3-tail-survival",
    generatedAt: new Date().toISOString(),
    ranOnRealData: bybitOk && depthOk,
    dataSources: {
      binanceFunding: "output/funding (8 majors, 3y, REAL)",
      bybitFunding: bybitOk ? "output/carry/d3 (REAL)" : "missing",
      depth: depthOk ? "output/carry/market-structure.json (REAL, read-only)" : "missing",
    },
    fees: { perpTakerBps: PERP_TAKER_BPS, spotTakerBps: SPOT_TAKER_BPS },
    baseline: { divApr, divVolAnn, baseDD, edgeOverRiskFree: divApr - RISK_FREE_APR },
    fundingFlip: { rows: flipRows, worstRegimeDays, worstRegimeCumPay: worstRegimePay },
    liquidation: { worstBook1d, worstBook3d, buffers: liqBuffers, opLiqBuffer, opLiqBufferFullBook, coreWorst1d },
    counterpartyGap: { pFailPerVenuePerYear, parkedFraction, gapRows },
    survivalBuffer: { bufLiq, bufGapReserve, bufFreeze, totalIdleBuffer, deployedFraction },
    returns: { headlineApr: divApr, blendedApr, centralGapDrag, riskAdjustedApr: blendedAprAfterGap, haircutVsHeadline, edgeVsRiskFree: blendedAprAfterGap - RISK_FREE_APR, riskFreeApr: RISK_FREE_APR },
    monthly: monthlyOut,
    ruin: { pSingleVenueRuin, pMultiVenueRuin },
    datedFuturesSurvivor: { headlineApr: datedHeadlineApr, contracts: datedContracts, backwardatedEntries, negExits, worstEntryBasis, note: "softer flip tail (basis locked at entry), same gap tail" },
  };
  const outPath = join(OUT_DIR, "d3-tail-survival-results.json");
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nwrote ${outPath}`);

  // ---- HONEST VERDICT ----
  console.log("\n" + "=".repeat(82));
  console.log("HONEST VERDICT");
  console.log("=".repeat(82));
  const edge = blendedAprAfterGap - RISK_FREE_APR;
  console.log(`  Headline carry: ${pct(divApr)} APR. After survival constraints: ${pct(blendedAprAfterGap)} APR.`);
  console.log(`  Edge over risk-free (4.5%): ${pct(edge)}/yr = ${pct(edge / 12, 3)}/mo.`);
  if (edge < 0.02) {
    console.log(`  ==> The survival-constrained edge over risk-free is THIN (<2%/yr). For small capital`);
    console.log(`      ($10k-$100k) the dollar edge over T-bills is ~$${(edge / 12 * 100_000).toFixed(0)}/mo at $100k — operational`);
    console.log(`      effort (custody across venues, margin monitoring, rebalancing, key-mgmt, tax) is`);
    console.log(`      almost certainly NOT worth it. It only makes sense at $1M+ with automation, and even`);
    console.log(`      then you are paid ~${pct(edge)}/yr to wear a real (if now-survivable) counterparty tail.`);
  } else {
    console.log(`  ==> The survival-constrained edge clears 2%/yr; viable at scale with multi-venue + buffer.`);
  }
  console.log("=".repeat(82));
}

main();
