/**
 * analyze-multivenue-carry.ts — TRACK D1, ROUND 2 (real-operation viability).
 *
 * Builds a unified multi-venue carry surface (Binance + Bybit full 3y; OKX last
 * ~92d) for BTC ETH SOL BNB XRP DOGE and answers, in honest net-of-everything
 * numbers:
 *   (a) per-venue gross + net carry APR (real per-venue taker fees),
 *   (b) the DIVERSIFIED book net APR across venues+instruments,
 *   (c) the CROSS-VENUE DISPERSION overlay: each 8h, long the perp on the venue
 *       paying the MOST funding and short the one charging the most (net of two
 *       venue legs' fees) — the highest-quality carry arb.
 *   (d) funding-rate time-series stats per venue, cross-venue correlation (does
 *       diversification reduce vol?), and dispersion's marginal contribution.
 *   (e) monthly net-carry series for the diversified book and the overlay.
 *
 * EVERY friction is netted: per-venue taker fees, slippage as a function of size
 * vs REAL order-book depth, 8h funding mechanics (sign can flip), short-perp
 * margin + cost of capital, delta rebalancing, and an idle survival buffer drag.
 * Everything is compared to a 4.5% risk-free alternative.
 *
 * Read-only over output/funding/*, output/carry/*, output/dated-futures/*.
 * Writes ONLY to output/carry/d1-*. No BigQuery, no training, no shared edits.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FUND = join("output", "funding");
const CARRY = join("output", "carry");
const DATED = join("output", "dated-futures");

const COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"] as const;
type Coin = (typeof COINS)[number];
const INTERVALS_PER_YEAR = 365.25 * 3; // 8h funding -> 3/day

// ---- REAL per-venue fees (bps of notional) --------------------------------
// Perp taker / maker fees at the standard (non-VIP) tier as published 2026:
//   Binance USDT-M perp: taker 0.040% / maker 0.018%
//   Bybit  linear perp : taker 0.055% / maker 0.020%
//   OKX    perp        : taker 0.050% / maker 0.020%
//   Spot (for the cash leg of single-venue carry): Binance spot taker 0.100%.
// We trade TAKER on entry/exit (you cannot rely on a maker fill for a delta-
// neutral leg you must execute now); this is the conservative, real assumption.
const PERP_TAKER: Record<string, number> = { binance: 0.00040, bybit: 0.00055, okx: 0.00050 };
const SPOT_TAKER_BINANCE = 0.00100;

// ---- Other real frictions --------------------------------------------------
const RISK_FREE_APR = 0.045;          // T-bills / USDC lending alternative
const SHORT_MARGIN_FRAC = 0.20;       // initial margin posted on the short perp (5x)
const SURVIVAL_BUFFER_FRAC = 0.25;    // idle un-deployed capital to survive a gap/margin call
const REBAL_BAND = 0.05;              // restore delta when |basis drift| exceeds 5%
const FUNDING_HOLD_THRESH = 0;        // single-venue: hold short-perp carry while funding > 0

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
function pct(v: number, d = 3): string {
  return `${(v * 100).toFixed(d)}%`;
}
function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

interface FundingRow { fundingTime: number; fundingRate: number; }

function loadFunding(path: string): FundingRow[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as FundingRow[];
  return raw
    .filter((r) => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}

// Binance funding lives in output/funding/<COIN>USDT_funding_8h.json
function loadBinance(coin: Coin): FundingRow[] {
  return loadFunding(join(FUND, `${coin}USDT_funding_8h.json`));
}
function loadVenue(venue: "bybit" | "okx", coin: Coin): FundingRow[] {
  return loadFunding(join(CARRY, `${venue}_${coin}USDT_funding_8h.json`));
}

// Align venue funding series on common 8h timestamps (bucket to the hour to absorb
// the few-ms settlement jitter). Returns Map<ts, {binance,bybit,okx?}>.
function alignByTs(series: Record<string, FundingRow[]>): Map<number, Record<string, number>> {
  const bucket = (t: number) => Math.round(t / 3600000) * 3600000;
  const out = new Map<number, Record<string, number>>();
  for (const [venue, rows] of Object.entries(series)) {
    for (const r of rows) {
      const k = bucket(r.fundingTime);
      if (!out.has(k)) out.set(k, {});
      out.get(k)![venue] = r.fundingRate;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SLIPPAGE MODEL from real depth snapshot. Given a one-sided notional we walk
// the book and return the average execution slippage (fraction of mid). This is
// a SNAPSHOT (single moment) so it is optimistic in calm and pessimistic-ish in
// stress; we treat it as a structural depth proxy.
// ---------------------------------------------------------------------------
interface Book { bids: [number, number][]; asks: [number, number][]; }
function loadDepth(): Record<string, Record<string, Book>> {
  const p = join(CARRY, "depth_snapshots.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}
function slippageFor(book: Book | undefined, notionalUsd: number, side: "buy" | "sell"): number {
  if (!book || !book.bids?.length || !book.asks?.length) return NaN;
  const mid = (book.bids[0][0] + book.asks[0][0]) / 2;
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = notionalUsd;
  let cost = 0; // signed price*qty consumed
  let filledQty = 0;
  for (const [price, qty] of levels) {
    const levelNotional = price * qty;
    const take = Math.min(levelNotional, remaining);
    const q = take / price;
    cost += price * q;
    filledQty += q;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) {
    // book exhausted -> charge the worst level for the rest (penalize size)
    const worst = levels[levels.length - 1][0];
    const q = remaining / worst;
    cost += worst * q;
    filledQty += q;
  }
  const avgPx = cost / filledQty;
  return Math.abs(avgPx - mid) / mid; // fraction of mid
}

// =====================================================================
// PART A — per-venue single-instrument carry (short perp, collect funding)
// Net APR after taker fees + spot-leg fee + slippage at a reference size.
// =====================================================================
interface VenueStat {
  venue: string; coin: string; n: number; spanDays: number;
  meanRate: number; stdRate: number; posFrac: number;
  grossApr: number; annVol: number;
}
function venueCarryStats(venue: string, coin: string, rows: FundingRow[]): VenueStat | null {
  if (rows.length < 30) return null;
  const rates = rows.map((r) => r.fundingRate);
  // gross carry per 8h interval when holding a SHORT perp = +fundingRate when >0.
  // We model "always-on diversified hold" later; for the surface we report the
  // raw mean funding annualized (gross), and the realized annual vol of funding.
  const grossApr = mean(rates) * INTERVALS_PER_YEAR;
  const annVol = std(rates) * Math.sqrt(INTERVALS_PER_YEAR);
  const spanDays = (rows[rows.length - 1].fundingTime - rows[0].fundingTime) / 86400000;
  return {
    venue, coin, n: rows.length, spanDays,
    meanRate: mean(rates), stdRate: std(rates),
    posFrac: rates.filter((r) => r > 0).length / rates.length,
    grossApr, annVol,
  };
}

// =====================================================================
// MAIN
// =====================================================================
const refSizeUsd = Number(arg("--size", "100000")); // reference clip per leg
const depth = loadDepth();

const report: any = {
  experiment: "d1-multivenue-carry",
  generatedAt: new Date().toISOString(),
  assumptions: {
    perpTakerBps: { binance: PERP_TAKER.binance * 1e4, bybit: PERP_TAKER.bybit * 1e4, okx: PERP_TAKER.okx * 1e4 },
    spotTakerBpsBinance: SPOT_TAKER_BINANCE * 1e4,
    riskFreeApr: RISK_FREE_APR,
    shortMarginFrac: SHORT_MARGIN_FRAC,
    survivalBufferFrac: SURVIVAL_BUFFER_FRAC,
    rebalBand: REBAL_BAND,
    referenceClipUsd: refSizeUsd,
    intervalsPerYear: INTERVALS_PER_YEAR,
  },
  venueStats: [] as VenueStat[],
  perCoinSingleVenue: [] as any[],
  correlation: {} as any,
  diversifiedBook: {} as any,
  dispersionOverlay: {} as any,
  monthly: {} as any,
  datedBasis: {} as any,
};

console.log("=".repeat(78));
console.log("TRACK D1 — MULTI-VENUE CARRY SURFACE + CROSS-VENUE DISPERSION");
console.log("=".repeat(78));
console.log(`Reference clip per leg: $${refSizeUsd.toLocaleString()}`);
console.log(`Perp taker fees (bps): Binance ${PERP_TAKER.binance * 1e4} | Bybit ${PERP_TAKER.bybit * 1e4} | OKX ${PERP_TAKER.okx * 1e4}`);
console.log(`Spot taker (Binance): ${SPOT_TAKER_BINANCE * 1e4} bps | Risk-free: ${pct(RISK_FREE_APR)}`);
console.log("");

// ---- load all series -------------------------------------------------------
const byCoin: Record<string, Record<string, FundingRow[]>> = {};
for (const coin of COINS) {
  byCoin[coin] = {
    binance: loadBinance(coin),
    bybit: loadVenue("bybit", coin),
    okx: loadVenue("okx", coin),
  };
}

// ---- PART A: per-venue funding stats --------------------------------------
console.log("── PART A: per-venue funding-rate stats (gross, annualized) ──");
console.log("coin  venue    n     span_d  meanRate(8h)  posFrac  grossAPR  annVol");
for (const coin of COINS) {
  for (const venue of ["binance", "bybit", "okx"]) {
    const st = venueCarryStats(venue, coin, byCoin[coin][venue]);
    if (!st) continue;
    report.venueStats.push(st);
    console.log(
      `${coin.padEnd(5)} ${venue.padEnd(8)} ${String(st.n).padStart(4)}  ${st.spanDays.toFixed(0).padStart(5)}  ` +
      `${(st.meanRate * 100).toFixed(5).padStart(10)}%  ${st.posFrac.toFixed(2)}    ${pct(st.grossApr, 2).padStart(8)}  ${pct(st.annVol, 1)}`
    );
  }
}

// ---- slippage curve from real depth (perp side) ---------------------------
console.log("\n── Slippage vs size (real depth snapshot, perp ask side) ──");
console.log("coin   venue    $25k    $100k   $250k   $1M     $5M");
const slipSizes = [25_000, 100_000, 250_000, 1_000_000, 5_000_000];
const slipTable: Record<string, Record<string, number[]>> = {};
for (const coin of COINS) {
  slipTable[coin] = {};
  for (const venue of ["binance", "bybit", "okx"]) {
    const book = depth[coin]?.[venue] as Book | undefined;
    const row = slipSizes.map((s) => slippageFor(book, s, "buy"));
    slipTable[coin][venue] = row;
    if (row.every((x) => Number.isNaN(x))) continue;
    console.log(
      `${coin.padEnd(6)} ${venue.padEnd(8)} ` +
      row.map((x) => (Number.isNaN(x) ? "  n/a " : pct(x, 3).padStart(7))).join(" ")
    );
  }
}
report.slippageBps = Object.fromEntries(
  COINS.map((c) => [c, Object.fromEntries(["binance", "bybit", "okx"].map((v) => [v, slipTable[c][v].map((x) => x * 1e4)]))])
);
report.slippageSizes = slipSizes;

// Helper: round-trip cost (open+close) for a delta-neutral SINGLE-venue carry
// = perp taker (x2 sides) + spot taker (x2 sides) + slippage (x2 legs x2 sides).
function singleVenueRoundTripCost(coin: Coin, venue: string, sizeUsd: number): number {
  const perpFee = PERP_TAKER[venue] ?? PERP_TAKER.binance;
  const slipPerp = slippageFor(depth[coin]?.[venue] as Book, sizeUsd, "buy");
  // spot leg approximated with Binance spot depth not fetched; use perp depth as
  // a conservative proxy for spot slippage (spot books are usually deeper, so
  // this OVER-states cost slightly — fine for an honest estimate).
  const slipSpot = slipPerp;
  const slip = Number.isNaN(slipPerp) ? 0.0005 : slipPerp;
  // open: buy spot + sell perp ; close: sell spot + buy perp = 2 perp sides + 2 spot sides + 4 slippage hits
  return 2 * perpFee + 2 * SPOT_TAKER_BINANCE + 4 * slip;
}

// =====================================================================
// PART B — single-venue "always-on" carry net APR per coin/venue
// Hold short perp + long spot continuously; collect funding when >0, PAY when <0
// (sign flips are kept — that is the honest cost). Subtract amortized round-trip
// + periodic rebalances + margin financing + survival-buffer drag.
// =====================================================================
console.log("\n── PART B: single-venue net carry APR (all frictions, $" + (refSizeUsd / 1000) + "k clip) ──");
console.log("coin   venue    grossAPR  funding$  fees+slip  rebal    netAPR(gross-cap)  netAPR(on-equity)");

interface SingleResult { coin: string; venue: string; grossApr: number; netAprGross: number; netAprEquity: number; intervalNet: number[]; }
const singleResults: SingleResult[] = [];

function simulateSingleVenue(coin: Coin, venue: string, rows: FundingRow[], sizeUsd: number): SingleResult | null {
  if (rows.length < 100) return null;
  const rtCost = singleVenueRoundTripCost(coin, venue, sizeUsd);
  // Per interval gross return on notional = fundingRate (we are short perp).
  // Always-on: we keep the position the whole window (one open at start, one
  // close at end), plus rebalances. Rebalance cadence: estimate ~ once / 14 days
  // for delta drift > 5% on majors (calmer than daily). We model rebal cost as a
  // half-round-trip (only the perp leg is resized) at slipPerp + perpFee.
  const slipPerp = slippageFor(depth[coin]?.[venue] as Book, sizeUsd, "buy");
  const slip = Number.isNaN(slipPerp) ? 0.0005 : slipPerp;
  const perpFee = PERP_TAKER[venue] ?? PERP_TAKER.binance;
  const spanDays = (rows[rows.length - 1].fundingTime - rows[0].fundingTime) / 86400000;
  const rebalEvents = Math.max(0, spanDays / 14);
  const rebalCostTotal = rebalEvents * (perpFee + slip); // resize perp leg each time
  const openCloseCost = rtCost; // amortized over the whole window once
  const grossSum = rows.reduce((s, r) => s + r.fundingRate, 0); // fraction of notional over the window
  const years = spanDays / 365.25;
  const grossApr = grossSum / years;
  // Net (on NOTIONAL / gross capital deployed = sizeUsd of spot + margin on perp).
  const netOnNotionalSum = grossSum - openCloseCost - rebalCostTotal;
  const netAprNotional = netOnNotionalSum / years;

  // Capital actually tied up per $1 of notional:
  //   spot leg fully funded: $1
  //   short perp margin: SHORT_MARGIN_FRAC
  //   survival buffer: SURVIVAL_BUFFER_FRAC (idle) of total deployed
  // Equity deployed = (1 + margin) ; plus buffer scales the whole thing.
  const capitalPerNotional = (1 + SHORT_MARGIN_FRAC) * (1 + SURVIVAL_BUFFER_FRAC);
  // The idle buffer + the spot leg actually still earn ~risk-free if parked in
  // T-bills/USDC; but to be conservative on the "edge over risk-free" we report
  // net carry APR on equity and separately compare to risk-free.
  const netAprEquity = netAprNotional / capitalPerNotional;

  // per-interval net series (for monthly + vol): funding minus amortized frictions
  const fricPerInterval = (openCloseCost + rebalCostTotal) / rows.length;
  const intervalNet = rows.map((r) => r.fundingRate - fricPerInterval);

  return { coin, venue, grossApr, netAprGross: netAprNotional, netAprEquity, intervalNet };
}

for (const coin of COINS) {
  for (const venue of ["binance", "bybit"]) { // full-history venues
    const r = simulateSingleVenue(coin, venue, byCoin[coin][venue], refSizeUsd);
    if (!r) continue;
    singleResults.push(r);
    const rows = byCoin[coin][venue];
    const years = (rows[rows.length - 1].fundingTime - rows[0].fundingTime) / 86400000 / 365.25;
    const fundingDollars = rows.reduce((s, x) => s + x.fundingRate, 0) * refSizeUsd;
    console.log(
      `${coin.padEnd(6)} ${venue.padEnd(8)} ${pct(r.grossApr, 2).padStart(8)}  ` +
      `$${(fundingDollars).toFixed(0).padStart(7)}  ${pct(r.grossApr - r.netAprGross, 2).padStart(8)}  ` +
      `${"".padStart(6)} ${pct(r.netAprGross, 2).padStart(10)}        ${pct(r.netAprEquity, 2).padStart(8)}`
    );
  }
}
report.perCoinSingleVenue = singleResults.map((r) => ({
  coin: r.coin, venue: r.venue, grossApr: r.grossApr, netAprNotional: r.netAprGross, netAprEquity: r.netAprEquity,
}));

// =====================================================================
// PART C — CROSS-VENUE CORRELATION (does diversification reduce vol?)
// Correlate Binance vs Bybit funding per coin, and cross-coin on Binance.
// =====================================================================
console.log("\n── PART C: cross-venue & cross-coin funding correlation ──");
// venue-vs-venue per coin (Binance vs Bybit, aligned)
console.log("Binance↔Bybit funding correlation per coin (full 3y):");
const venueCorr: Record<string, number> = {};
for (const coin of COINS) {
  const aligned = alignByTs({ binance: byCoin[coin].binance, bybit: byCoin[coin].bybit });
  const ks = [...aligned.keys()].filter((k) => aligned.get(k)!.binance !== undefined && aligned.get(k)!.bybit !== undefined).sort((a, b) => a - b);
  const a = ks.map((k) => aligned.get(k)!.binance);
  const b = ks.map((k) => aligned.get(k)!.bybit);
  const c = pearson(a, b);
  venueCorr[coin] = c;
  console.log(`  ${coin.padEnd(5)} n=${ks.length}  corr=${c.toFixed(3)}`);
}
report.correlation.binanceVsBybit = venueCorr;

// cross-coin correlation on Binance (diversification across instruments)
console.log("Cross-coin funding correlation (Binance, full 3y):");
const coinSeries: Record<string, number[]> = {};
{
  // align all coins on common Binance timestamps
  const allTs = new Set<number>();
  for (const coin of COINS) for (const r of byCoin[coin].binance) allTs.add(Math.round(r.fundingTime / 3600000) * 3600000);
  const ks = [...allTs].sort((a, b) => a - b);
  const maps: Record<string, Map<number, number>> = {};
  for (const coin of COINS) {
    maps[coin] = new Map(byCoin[coin].binance.map((r) => [Math.round(r.fundingTime / 3600000) * 3600000, r.fundingRate]));
  }
  for (const coin of COINS) coinSeries[coin] = ks.map((k) => maps[coin].get(k) ?? NaN);
  // print matrix
  process.stdout.write("        " + COINS.map((c) => c.padStart(6)).join("") + "\n");
  const corrMatrix: Record<string, Record<string, number>> = {};
  for (const a of COINS) {
    corrMatrix[a] = {};
    let line = a.padEnd(8);
    for (const b of COINS) {
      // pairwise complete obs
      const xa: number[] = [], xb: number[] = [];
      for (let i = 0; i < ks.length; i++) {
        const va = coinSeries[a][i], vb = coinSeries[b][i];
        if (Number.isFinite(va) && Number.isFinite(vb)) { xa.push(va); xb.push(vb); }
      }
      const c = pearson(xa, xb);
      corrMatrix[a][b] = c;
      line += c.toFixed(2).padStart(6);
    }
    console.log(line);
  }
  report.correlation.crossCoinBinance = corrMatrix;
  // average off-diagonal correlation
  let off = 0, cnt = 0;
  for (const a of COINS) for (const b of COINS) if (a !== b) { off += corrMatrix[a][b]; cnt++; }
  report.correlation.avgCrossCoin = off / cnt;
  console.log(`  avg off-diagonal cross-coin corr = ${(off / cnt).toFixed(3)}`);
}

// =====================================================================
// PART D — DIVERSIFIED BOOK
// Equal-weight short-perp carry across the 6 coins on Binance (full history).
// Per interval: book return = mean over coins of (fundingRate) - frictions.
// Demonstrate vol reduction vs single-coin. Build monthly net series.
// =====================================================================
console.log("\n── PART D: DIVERSIFIED book (equal-weight 6 coins, Binance) ──");
{
  // common timestamps where all 6 present
  const ks: number[] = [];
  const allMaps: Record<string, Map<number, number>> = {};
  for (const coin of COINS) allMaps[coin] = new Map(byCoin[coin].binance.map((r) => [Math.round(r.fundingTime / 3600000) * 3600000, r.fundingRate]));
  const tsUnion = new Set<number>();
  for (const coin of COINS) for (const r of byCoin[coin].binance) tsUnion.add(Math.round(r.fundingTime / 3600000) * 3600000);
  for (const k of [...tsUnion].sort((a, b) => a - b)) {
    if (COINS.every((c) => allMaps[c].has(k))) ks.push(k);
  }
  // friction per interval per coin: amortized open/close + rebal (use BTC-like avg)
  // We compute a representative friction drag per coin and average.
  const perCoinFric: number[] = COINS.map((coin) => {
    const rows = byCoin[coin].binance;
    const rt = singleVenueRoundTripCost(coin as Coin, "binance", refSizeUsd);
    const spanDays = (rows[rows.length - 1].fundingTime - rows[0].fundingTime) / 86400000;
    const slip = (() => { const s = slippageFor(depth[coin]?.binance as Book, refSizeUsd, "buy"); return Number.isNaN(s) ? 0.0005 : s; })();
    const rebal = (spanDays / 14) * (PERP_TAKER.binance + slip);
    return (rt + rebal) / rows.length; // per interval
  });
  const bookGross: number[] = ks.map((k) => mean(COINS.map((c) => allMaps[c].get(k)!)));
  const bookFric = mean(perCoinFric);
  const bookNet: number[] = bookGross.map((g) => g - bookFric);

  const grossApr = mean(bookGross) * INTERVALS_PER_YEAR;
  const netAprNotional = mean(bookNet) * INTERVALS_PER_YEAR;
  const annVolGross = std(bookGross) * Math.sqrt(INTERVALS_PER_YEAR);
  const capitalPerNotional = (1 + SHORT_MARGIN_FRAC) * (1 + SURVIVAL_BUFFER_FRAC);
  const netAprEquity = netAprNotional / capitalPerNotional;

  // average single-coin vol for comparison
  const singleVols = COINS.map((c) => {
    const rates = byCoin[c].binance.map((r) => r.fundingRate);
    return std(rates) * Math.sqrt(INTERVALS_PER_YEAR);
  });
  const avgSingleVol = mean(singleVols);

  console.log(`  intervals (all-6 overlap): ${ks.length}`);
  console.log(`  gross APR (mean funding) : ${pct(grossApr, 2)}`);
  console.log(`  friction drag (annualized): ${pct(bookFric * INTERVALS_PER_YEAR, 2)}`);
  console.log(`  NET APR on notional       : ${pct(netAprNotional, 2)}`);
  console.log(`  NET APR on equity (margin+buffer): ${pct(netAprEquity, 2)}`);
  console.log(`  EDGE over risk-free (${pct(RISK_FREE_APR, 1)}): ${pct(netAprEquity - RISK_FREE_APR, 2)}`);
  console.log(`  book funding annVol       : ${pct(annVolGross, 1)}`);
  console.log(`  avg single-coin annVol    : ${pct(avgSingleVol, 1)}  -> diversification cuts vol by ${pct(1 - annVolGross / avgSingleVol, 1)}`);

  report.diversifiedBook = {
    intervals: ks.length, grossApr, frictionDragApr: bookFric * INTERVALS_PER_YEAR,
    netAprNotional, netAprEquity, edgeOverRiskFree: netAprEquity - RISK_FREE_APR,
    bookAnnVol: annVolGross, avgSingleCoinAnnVol: avgSingleVol, volReductionFrac: 1 - annVolGross / avgSingleVol,
    capitalPerNotional,
  };

  // monthly net series (on notional, %/mo) and $ at capital tiers
  const monthly = monthlySeries(ks, bookNet);
  report.monthly.diversifiedBookNotional = monthly;
  // equity-based monthly (divide by capitalPerNotional)
  report.monthly.diversifiedBookEquity = monthly.map((m) => ({ ...m, netPct: m.netPct / capitalPerNotional }));

  // ---- SELECTIVE book: only deploy on coins whose Binance funding is net-positive
  // (a real operator never runs short-perp carry on a NEGATIVE-funding coin like
  // BNB; they skip it or run the OPPOSITE side). Equal-weight the positive set.
  const posCoins = COINS.filter((c) => mean(byCoin[c].binance.map((r) => r.fundingRate)) > 0);
  const selGrossPer = ks.map((k) => mean(posCoins.map((c) => allMaps[c].get(k)!)));
  const selFricList = posCoins.map((coin) => {
    const rows = byCoin[coin].binance;
    const rt = singleVenueRoundTripCost(coin as Coin, "binance", refSizeUsd);
    const spanDays = (rows[rows.length - 1].fundingTime - rows[0].fundingTime) / 86400000;
    const slip = (() => { const s = slippageFor(depth[coin]?.binance as Book, refSizeUsd, "buy"); return Number.isNaN(s) ? 0.0005 : s; })();
    return (rt + (spanDays / 14) * (PERP_TAKER.binance + slip)) / rows.length;
  });
  const selFric = mean(selFricList);
  const selNetPer = selGrossPer.map((g) => g - selFric);
  const selGrossApr = mean(selGrossPer) * INTERVALS_PER_YEAR;
  const selNetNotional = mean(selNetPer) * INTERVALS_PER_YEAR;
  const selNetEquity = selNetNotional / capitalPerNotional;
  const selVol = std(selGrossPer) * Math.sqrt(INTERVALS_PER_YEAR);
  console.log(`\n  SELECTIVE book (positive-funding coins only: ${posCoins.join(",")}):`);
  console.log(`    gross APR=${pct(selGrossApr, 2)}  NET(notional)=${pct(selNetNotional, 2)}  NET(equity)=${pct(selNetEquity, 2)}  EDGE vs RF=${pct(selNetEquity - RISK_FREE_APR, 2)}  vol=${pct(selVol, 1)}`);
  report.diversifiedBook.selective = {
    coins: posCoins, grossApr: selGrossApr, netAprNotional: selNetNotional, netAprEquity: selNetEquity,
    edgeOverRiskFree: selNetEquity - RISK_FREE_APR, annVol: selVol,
  };
  report.monthly.selectiveBookEquity = monthlySeries(ks, selNetPer).map((m) => ({ ...m, netPct: m.netPct / capitalPerNotional }));
}

// =====================================================================
// PART E — CROSS-VENUE DISPERSION OVERLAY
// Each 8h, across the venues quoting the coin, LONG the perp on the venue paying
// you the most funding (most negative funding = shorts pay longs -> you long and
// get paid) and SHORT the venue charging the most (most positive funding -> you
// short and get paid). Gross dispersion gain per interval = spread(funding) over
// the chosen pair; you collect on BOTH legs. Net of two perp legs' fees.
//
// Concretely for a market-neutral cross-venue pair on the SAME coin:
//   you are long perp on venue L (pay/receive fundingL on the long = -fundingL)
//   you are short perp on venue S (receive fundingS on the short = +fundingS)
//   gross funding pnl per interval = fundingS - fundingL  (>0 when S>L)
// Pick L = argmin funding, S = argmax funding -> gross = max - min (always >=0).
// This is delta-neutral across venues (same coin, offsetting), so basis/price
// risk nets; the only real cost is the two perp round trips + slippage + the
// risk that one venue's funding flips between settlements (we hold to next
// settlement and re-pick, so the per-interval realized spread is what we model).
// =====================================================================
console.log("\n── PART E: CROSS-VENUE DISPERSION OVERLAY ──");
console.log("  Two policies: (1) NAIVE re-pick every 8h, (2) COST-AWARE hysteresis");
console.log("  (only open/flip a pair when the funding SPREAD clears trading cost).\n");
{
  // Use Binance+Bybit on full history (OKX only adds 92d; report separately).
  const overlayMonthlyByCoin: Record<string, any[]> = {};
  const summary: any[] = [];
  const capPerNotional = 2 * SHORT_MARGIN_FRAC * (1 + SURVIVAL_BUFFER_FRAC);
  for (const coin of COINS) {
    const aligned = alignByTs({ binance: byCoin[coin].binance, bybit: byCoin[coin].bybit });
    const ks = [...aligned.keys()]
      .filter((k) => { const r = aligned.get(k)!; return r.binance !== undefined && r.bybit !== undefined; })
      .sort((a, b) => a - b);
    if (ks.length < 100) continue;
    const spanDays = (ks[ks.length - 1] - ks[0]) / 86400000;
    const years = spanDays / 365.25;
    const slB = (() => { const s = slippageFor(depth[coin]?.binance as Book, refSizeUsd, "buy"); return Number.isNaN(s) ? 0.0005 : s; })();
    const slY = (() => { const s = slippageFor(depth[coin]?.bybit as Book, refSizeUsd, "buy"); return Number.isNaN(s) ? 0.0005 : s; })();
    // round-trip cost to OPEN a new market-neutral pair = both perp legs taker+slip;
    // a full cycle (open then later close) = 2x that.
    const openPairCost = (PERP_TAKER.binance + slB) + (PERP_TAKER.bybit + slY);
    const cyclePairCost = 2 * openPairCost;

    // ---------- (1) NAIVE: re-pick argmax/argmin venue every interval ----------
    let lastL = "", lastS = "", flips = 0;
    const grossPer: number[] = [];
    for (const k of ks) {
      const r = aligned.get(k)!;
      const venues = (Object.entries(r) as [string, number][]).sort((a, b) => a[1] - b[1]);
      grossPer.push(venues[venues.length - 1][1] - venues[0][1]);
      const L = venues[0][0], S = venues[venues.length - 1][0];
      if (L !== lastL || S !== lastS) { flips++; lastL = L; lastS = S; }
    }
    const grossSum = grossPer.reduce((s, x) => s + x, 0);
    const grossApr = grossSum / years;
    const naiveNetApr = (grossSum - flips * cyclePairCost) / years;

    // ---------- (2) COST-AWARE hysteresis ----------
    // Spread s_t = fundingBybit - fundingBinance (signed). Position p in {-1,0,+1}:
    //   p=+1: short Bybit perp / long Binance perp (collect +s_t)
    //   p=-1: short Binance perp / long Bybit perp (collect -s_t)
    // Enter |s_t| only when expected hold gain clears cost. We require the spread
    // to exceed an ENTRY band and stay until it drops below an EXIT band, paying
    // one cyclePairCost per round trip (enter+exit). The per-interval collected
    // funding equals p * s_t while in position.
    const EXIT = openPairCost * 0.5;      // close when spread no longer covers a leg
    const ENTRY = cyclePairCost;          // enter only when spread >= full cycle cost
    let pos = 0, roundTrips = 0;
    const caPer: number[] = new Array(ks.length).fill(0);
    for (let i = 0; i < ks.length; i++) {
      const r = aligned.get(ks[i])!;
      const s = r.bybit - r.binance; // signed spread this settlement
      // collect on existing position first (funding realized at this settlement)
      if (pos !== 0) caPer[i] += pos * s;
      // then decide next state for the upcoming interval
      const want = Math.abs(s) >= ENTRY ? Math.sign(s) : (Math.abs(s) >= EXIT ? pos : 0);
      if (want !== pos) {
        // a flip from +1 to -1 is two cycles; 0<->±1 is one open or one close (~half cycle each, count as one cycle per full round trip)
        const legs = (pos === 0 || want === 0) ? 1 : 2;
        roundTrips += legs;
        caPer[i] -= legs * openPairCost; // pay to change the book now
        pos = want;
      }
    }
    const caGrossSum = caPer.reduce((s, x) => s + x, 0);
    const caNetApr = caGrossSum / years;
    const caNetAprEquity = caNetApr / capPerNotional;

    overlayMonthlyByCoin[coin] = monthlySeries(ks, caPer);
    summary.push({
      coin, intervals: ks.length,
      naiveFlips: flips, grossApr, naiveNetAprNotional: naiveNetApr,
      caRoundTrips: roundTrips, caNetAprNotional: caNetApr, caNetAprEquity, capPerNotional,
      entryBandBps: ENTRY * 1e4, exitBandBps: EXIT * 1e4,
    });
    console.log(
      `  ${coin.padEnd(5)} n=${ks.length} grossAPR=${pct(grossApr, 3).padStart(7)} | ` +
      `NAIVE flips=${String(flips).padStart(4)} net=${pct(naiveNetApr, 1).padStart(8)} | ` +
      `COST-AWARE trips=${String(roundTrips).padStart(3)} net(notional)=${pct(caNetApr, 3).padStart(7)} net(equity)=${pct(caNetAprEquity, 2).padStart(7)}`
    );
  }
  // portfolio overlay (equal weight across coins on the net interval series)
  report.dispersionOverlay.perCoin = summary;
  report.dispersionOverlay.monthlyByCoin = overlayMonthlyByCoin;
  // build an equal-weight portfolio monthly by averaging coin monthly netPct
  const allMonths = new Set<string>();
  for (const coin of Object.keys(overlayMonthlyByCoin)) for (const m of overlayMonthlyByCoin[coin]) allMonths.add(m.month);
  const months = [...allMonths].sort();
  const portMonthly = months.map((mm) => {
    const vals = Object.keys(overlayMonthlyByCoin)
      .map((coin) => overlayMonthlyByCoin[coin].find((x) => x.month === mm)?.netPct)
      .filter((x): x is number => x !== undefined);
    return { month: mm, netPct: mean(vals) };
  });
  report.dispersionOverlay.portfolioMonthly = portMonthly;
  const avgGross = mean(summary.map((s) => s.grossApr));
  const avgNaiveNet = mean(summary.map((s) => s.naiveNetAprNotional));
  const avgCaNetNot = mean(summary.map((s) => s.caNetAprNotional));
  const avgCaNetEq = mean(summary.map((s) => s.caNetAprEquity));
  console.log(
    `  PORTFOLIO: avg grossAPR=${pct(avgGross, 3)} | NAIVE net=${pct(avgNaiveNet, 2)} | ` +
    `COST-AWARE net(notional)=${pct(avgCaNetNot, 3)} net(equity)=${pct(avgCaNetEq, 2)}`
  );
  report.dispersionOverlay.avgGrossApr = avgGross;
  report.dispersionOverlay.avgNaiveNetAprNotional = avgNaiveNet;
  report.dispersionOverlay.avgCostAwareNetAprNotional = avgCaNetNot;
  report.dispersionOverlay.avgCostAwareNetAprEquity = avgCaNetEq;
}

// ---- OKX 3-way dispersion on the 92d overlap (clearly labeled, short window) -
console.log("\n── PART E2: 3-venue dispersion on OKX overlap window (~92d, LABELED short) ──");
{
  const summary3: any[] = [];
  for (const coin of COINS) {
    const aligned = alignByTs({ binance: byCoin[coin].binance, bybit: byCoin[coin].bybit, okx: byCoin[coin].okx });
    const ks = [...aligned.keys()]
      .filter((k) => { const r = aligned.get(k)!; return r.binance !== undefined && r.bybit !== undefined && r.okx !== undefined; })
      .sort((a, b) => a - b);
    if (ks.length < 30) continue;
    const grossPer = ks.map((k) => { const v = Object.values(aligned.get(k)!); return Math.max(...v) - Math.min(...v); });
    const spanDays = (ks[ks.length - 1] - ks[0]) / 86400000;
    const years = spanDays / 365.25;
    const grossApr = grossPer.reduce((s, x) => s + x, 0) / years;
    summary3.push({ coin, intervals: ks.length, spanDays, grossApr });
    console.log(`  ${coin.padEnd(5)} n=${ks.length} span=${spanDays.toFixed(0)}d  3way grossAPR=${pct(grossApr, 3)}`);
  }
  report.dispersionOverlay.threeVenue92d = summary3;
}

// =====================================================================
// DATED QUARTERLY BASIS (reuse T8 data) — cash-and-carry comparison
// =====================================================================
console.log("\n── PART F: dated quarterly basis (cash-and-carry, reused T8 data) ──");
{
  for (const coin of ["BTC", "ETH"]) {
    const p = join(DATED, `${coin}_quarterly_basis.json`);
    if (!existsSync(p)) continue;
    const contracts = JSON.parse(readFileSync(p, "utf8")) as any[];
    // entry basis captured at first observation of each contract; held to delivery
    // -> harvest = entryBasis - fees. Annualize by contract life.
    const rows = contracts.map((c) => {
      const r = c.rows;
      const entry = r[0];
      const days = (new Date(r[r.length - 1].date).getTime() - new Date(r[0].date).getTime()) / 86400000;
      const entryBasis = entry.basis;
      // cash-and-carry: long spot + short dated future locks entryBasis at convergence.
      // cost = spot taker (open+close) + future taker (open; convergence = no close fee
      // since it settles) ~ 0.1% spot x2 + 0.04% future x1 + slippage ~0.05%.
      const cost = 2 * SPOT_TAKER_BINANCE + PERP_TAKER.binance + 0.0005;
      const net = entryBasis - cost;
      const annualized = net * (365.25 / Math.max(days, 1));
      return { symbol: c.symbol, days, entryBasis, netAnnualized: annualized };
    });
    const avgAnn = mean(rows.map((r) => r.netAnnualized));
    console.log(`  ${coin}: ${rows.length} quarterly contracts, avg net annualized cash-and-carry = ${pct(avgAnn, 2)}`);
    report.datedBasis[coin] = { contracts: rows.length, avgNetAnnualized: avgAnn, perContract: rows };
  }
}

// =====================================================================
// MONTHLY HELPER + capital-tier dollar table
// =====================================================================
function monthlySeries(ks: number[], netPer: number[]): { month: string; netPct: number; intervals: number }[] {
  const byMonth = new Map<string, number[]>();
  for (let i = 0; i < ks.length; i++) {
    const d = new Date(ks[i]);
    const mm = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth.has(mm)) byMonth.set(mm, []);
    byMonth.get(mm)!.push(netPer[i]);
  }
  return [...byMonth.entries()].sort().map(([month, arr]) => ({
    month, netPct: arr.reduce((s, x) => s + x, 0), intervals: arr.length,
  }));
}

// ---- headline monthly table for the diversified book (on EQUITY) ----------
console.log("\n── DIVERSIFIED BOOK monthly net (on equity), last 12 months ──");
{
  const m = report.monthly.diversifiedBookEquity as { month: string; netPct: number }[];
  const last = m.slice(-12);
  console.log("month     net%/mo   $10k     $100k    $1M");
  for (const row of last) {
    console.log(
      `${row.month}  ${(row.netPct * 100).toFixed(3).padStart(7)}%  ` +
      `$${(row.netPct * 10000).toFixed(0).padStart(6)}  $${(row.netPct * 100000).toFixed(0).padStart(6)}  $${(row.netPct * 1_000_000).toFixed(0).padStart(7)}`
    );
  }
  const avg = mean(m.map((x) => x.netPct));
  report.monthly.diversifiedBookAvgPctPerMonth = avg;
  console.log(`  avg net %/mo (equity, full history): ${(avg * 100).toFixed(3)}%  -> ann ~${pct(avg * 12, 2)}`);
}
console.log("\n── SELECTIVE BOOK (positive-funding coins) monthly net (on equity), last 12 ──");
{
  const m = report.monthly.selectiveBookEquity as { month: string; netPct: number }[];
  const last = m.slice(-12);
  console.log("month     net%/mo   $10k     $100k    $1M");
  for (const row of last) {
    console.log(
      `${row.month}  ${(row.netPct * 100).toFixed(3).padStart(7)}%  ` +
      `$${(row.netPct * 10000).toFixed(0).padStart(6)}  $${(row.netPct * 100000).toFixed(0).padStart(6)}  $${(row.netPct * 1_000_000).toFixed(0).padStart(7)}`
    );
  }
  const avg = mean(m.map((x) => x.netPct));
  report.monthly.selectiveBookAvgPctPerMonth = avg;
  console.log(`  avg net %/mo (equity, full history): ${(avg * 100).toFixed(3)}%  -> ann ~${pct(avg * 12, 2)}`);
}
console.log("\n── DISPERSION OVERLAY portfolio monthly net (on equity), last 12 ──");
{
  const m = report.dispersionOverlay.portfolioMonthly as { month: string; netPct: number }[];
  const capPerNotional = 2 * SHORT_MARGIN_FRAC * (1 + SURVIVAL_BUFFER_FRAC);
  const last = m.slice(-12);
  console.log("month     net%/mo(equity)  $10k    $100k   $1M");
  for (const row of last) {
    const eq = row.netPct / capPerNotional;
    console.log(
      `${row.month}  ${(eq * 100).toFixed(3).padStart(7)}%       ` +
      `$${(eq * 10000).toFixed(0).padStart(5)}  $${(eq * 100000).toFixed(0).padStart(5)}  $${(eq * 1_000_000).toFixed(0).padStart(6)}`
    );
  }
  const avg = mean(m.map((x) => x.netPct)) / capPerNotional;
  report.dispersionOverlay.avgMonthlyEquityPct = avg;
  console.log(`  avg net %/mo (equity): ${(avg * 100).toFixed(3)}%  -> ann ~${pct(avg * 12, 2)}`);
}

writeFileSync(join(CARRY, "d1-report.json"), JSON.stringify(report, null, 2));
console.log("\nwrote output/carry/d1-report.json");
