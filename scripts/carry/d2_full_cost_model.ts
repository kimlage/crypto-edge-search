/**
 * TRACK D2 — Full cost + capital model for cash-and-carry (long spot / short perp).
 *
 * What an operator actually NETS per month after EVERY friction, at $10k / $100k / $1M.
 *
 * Data (all REAL, no re-fetch except live depth which was fetched once to output/carry):
 *   - output/funding/<SYM>_funding_8h.json   : Binance 8h funding, 8 majors, 2023-06..2026-05
 *   - output/funding/<SYM>_prices_daily.json : spot+perp daily closes (for realized vol)
 *   - output/carry/<SYM>_{spot,perp}_depth.json : live Binance order-book snapshots (limit=1000)
 *
 * Carry survivors deepened here: BTC and ETH (highest liquidity + highest positive-funding
 * fraction among the 8 majors; the only two worth operating a real long-spot/short-perp book on).
 *
 * Run:
 *   node_modules/.bin/tsx scripts/carry/d2_full_cost_model.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? path.resolve(__dirname, '../..');
const FUND = path.join(ROOT, 'output/funding');
const CARRY = path.join(ROOT, 'output/carry');

type FundingPt = { fundingTime: number; fundingRate: number };
type PricePt = { date: string; spotClose: number; perpClose: number };
type DepthBook = { bids: [string, string][]; asks: [string, string][] };

const SURVIVORS = ['BTCUSDT', 'ETHUSDT'] as const;
type Sym = (typeof SURVIVORS)[number];

// ---- REAL fee schedule (bps of notional, per side) -------------------------
// Binance VIP0 taker/maker. We assume a realistic operator: MAKER on spot entry/exit
// where possible, TAKER on perp (you usually cross the spread on the hedge to stay delta-flat).
// Cited exact bps used:
const FEES = {
  spotTakerBps: 10.0,   // 0.10% Binance spot taker (VIP0, no BNB discount)
  spotMakerBps: 10.0,   // spot maker is also 0.10% at VIP0 (no improvement) -> use taker-equiv
  perpTakerBps: 4.0,    // 0.04% USDM perp taker
  perpMakerBps: 1.8,    // 0.018% USDM perp maker
};
// Roundtrip = open both legs + close both legs.
// Open: buy spot (taker 10bps) + short perp (we model TAKER to be honest = 4bps).
// Close: sell spot (10bps) + buy-to-cover perp (4bps).
// => per-roundtrip fee = 2*(spotTaker) + 2*(perpTaker) on respective notionals.

// ---- Cost-of-capital / financing ------------------------------------------
const RISK_FREE_APR = 4.5;        // % T-bill / USDC-lending baseline (the hurdle)
// On a delta-neutral carry you post USDT margin for the short perp. That margin earns ~0
// at Binance (no on-exchange T-bill yield for retail USDM margin), so the opportunity cost
// of margin + buffer parked on-exchange is the risk-free rate you FORGO.
// Spot leg is bought outright (not levered) in the base case -> no borrow cost.
const PERP_INITIAL_MARGIN_PCT = 20; // run the short at ~5x max but operate at 20% IM for safety
// Survival buffer: idle capital you MUST keep un-deployed to survive a price gap / margin call
// before you can rebalance. We hold it on-exchange-or-near, earning ~0, so it forgoes risk-free.
const SURVIVAL_BUFFER_FRAC = 0.40; // 40% of capital idle (within the 30-50% ask)

// ---- holding period assumption for fee amortization ------------------------
// Carry is a hold trade; you don't churn the position. Assume the operator holds each
// carry position ~30 days on average before rotating/closing (funding regime shifts).
const HOLD_DAYS = 30;

// ---- helpers ---------------------------------------------------------------
function load<T>(p: string): T { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function annualizedFundingApr(rates: number[]): number {
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  return mean * 3 * 365 * 100; // 3 settlements/day * 365 * 100 -> %
}

function realizedDailyVol(closes: number[]): number {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length;
  return Math.sqrt(v);
}

/** Walk a real order book; return slippage in bps vs top-of-book for a USD order. */
function walkSlippageBps(book: [string, string][], side: 'buy' | 'sell', usd: number): number | null {
  const top = parseFloat(book[0][0]);
  let remaining = usd, cost = 0, base = 0;
  for (const [ps, qs] of book) {
    const price = parseFloat(ps), qty = parseFloat(qs);
    const lvlUsd = price * qty;
    const take = Math.min(remaining, lvlUsd);
    const qFilled = take / price;
    cost += qFilled * price; base += qFilled; remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-6) return null; // book depleted -> can't fill at this size
  const avg = cost / base;
  const slip = side === 'buy' ? (avg - top) / top : (top - avg) / top;
  return slip * 1e4;
}

/** Roundtrip slippage (bps of capital) for a delta-neutral entry+exit at a given per-leg notional. */
function roundtripSlippageBps(spot: DepthBook, perp: DepthBook, legUsd: number): { bps: number | null; depleted: boolean } {
  // entry: buy spot + sell(short) perp ; exit: sell spot + buy perp
  const a = walkSlippageBps(spot.asks, 'buy', legUsd);   // buy spot @ entry
  const b = walkSlippageBps(perp.bids, 'sell', legUsd);  // short perp @ entry
  const c = walkSlippageBps(spot.bids, 'sell', legUsd);  // sell spot @ exit
  const d = walkSlippageBps(perp.asks, 'buy', legUsd);   // cover perp @ exit
  if (a == null || b == null || c == null || d == null) return { bps: null, depleted: true };
  return { bps: a + b + c + d, depleted: false }; // total slippage cost over the full roundtrip
}

// ---- main ------------------------------------------------------------------
const CAPITAL_TIERS = [10_000, 100_000, 1_000_000];

type SymStats = {
  sym: Sym;
  fundingApr3y: number;
  fundingApr1y: number;
  posFrac1y: number;
  dailyVol1y: number;
  spot: DepthBook;
  perp: DepthBook;
};

const stats: SymStats[] = SURVIVORS.map((sym) => {
  const f = load<FundingPt[]>(path.join(FUND, `${sym}_funding_8h.json`));
  const px = load<PricePt[]>(path.join(FUND, `${sym}_prices_daily.json`));
  const rates = f.map((x) => x.fundingRate);
  const rates1y = rates.slice(-1095); // last ~365 days * 3/day
  const px1y = px.slice(-365);
  return {
    sym,
    fundingApr3y: annualizedFundingApr(rates),
    fundingApr1y: annualizedFundingApr(rates1y),
    posFrac1y: rates1y.filter((x) => x > 0).length / rates1y.length,
    dailyVol1y: realizedDailyVol(px1y.map((p) => p.spotClose)),
    spot: load<DepthBook>(path.join(CARRY, `${sym}_spot_depth.json`)),
    perp: load<DepthBook>(path.join(CARRY, `${sym}_perp_depth.json`)),
  };
});

// We deploy the carry across BOTH survivors equally (diversify funding regime).
// Per-tier, DEPLOYED capital = (1 - buffer). Split 50/50 BTC/ETH.
// Each $ deployed buys $1 spot + shorts $1 perp notional (the perp needs only ~20% IM,
// so the perp margin is a slice of the deployed dollar; the spot purchase uses the rest).
//
// Capital accounting for $1 of "carry exposure" (= $1 notional on each leg):
//   - spot leg: needs $1 cash to buy outright.
//   - perp short: needs PERP_INITIAL_MARGIN_PCT * $1 of margin posted.
//   => total cash to hold $1 of carry exposure = $1 + 0.20 = $1.20.
// So with deployable cash D, carry notional N satisfies N * 1.20 = D -> N = D / 1.20.
const CASH_PER_NOTIONAL = 1 + PERP_INITIAL_MARGIN_PCT / 100;

function modelTier(capital: number) {
  const buffer = capital * SURVIVAL_BUFFER_FRAC;
  const deployable = capital - buffer;
  const carryNotional = deployable / CASH_PER_NOTIONAL; // total notional across both legs combined per-side
  // split across 2 survivors
  const perSymNotional = carryNotional / SURVIVORS.length;

  // ---- gross funding revenue (use RECENT 1y funding — the honest, current regime) ----
  // funding earned = funding_apr * notional (you receive funding when funding>0 as the short)
  let grossFundingUsdAnnual = 0;
  let grossFundingUsd3yAnnual = 0;
  const perSym = stats.map((s) => {
    const annFund1y = (s.fundingApr1y / 100) * perSymNotional;
    const annFund3y = (s.fundingApr3y / 100) * perSymNotional;
    grossFundingUsdAnnual += annFund1y;
    grossFundingUsd3yAnnual += annFund3y;

    // ---- slippage (roundtrip, amortized over holding period) ----
    const rt = roundtripSlippageBps(s.spot, s.perp, perSymNotional);
    return { sym: s.sym, perSymNotional, annFund1y, annFund3y, slipBps: rt.bps, depleted: rt.depleted };
  });

  // ---- FEES (roundtrip), amortized over HOLD_DAYS, annualized ----
  // per roundtrip per leg-notional: open+close.
  // spot: buy(10bps)+sell(10bps)=20bps on spot notional
  // perp: short(4bps)+cover(4bps)=8bps on perp notional
  const feeBpsPerRoundtrip = (2 * FEES.spotTakerBps) + (2 * FEES.perpTakerBps); // 28 bps on the per-side notional
  const roundtripsPerYear = 365 / HOLD_DAYS;
  const feeUsdAnnual = (feeBpsPerRoundtrip / 1e4) * carryNotional * roundtripsPerYear;

  // ---- SLIPPAGE annualized (roundtrip per hold cycle) ----
  let slipUsdAnnual = 0;
  let anyDepleted = false;
  for (const p of perSym) {
    if (p.slipBps == null) { anyDepleted = true; continue; }
    slipUsdAnnual += (p.slipBps / 1e4) * p.perSymNotional * roundtripsPerYear;
  }

  // ---- REBALANCING cost ----
  // To keep delta~0, when spot moves the perp notional drifts from spot notional.
  // Rebalance when |drift| > THRESH (say 5%). With daily vol v, expected #days to hit 5%
  // ~ (0.05/v)^2 (random walk first-passage scale). Each rebalance trades ~THRESH*notional
  // on the perp leg only (taker, perp fee + perp slippage).
  const REBAL_THRESH = 0.05;
  let rebalUsdAnnual = 0;
  for (const s of stats) {
    const v = s.dailyVol1y;
    // expected calendar days between 5% moves (one-sided, rough first-passage):
    const daysBetween = Math.max(1, (REBAL_THRESH / v) ** 2);
    const rebalsPerYear = 365 / daysBetween;
    const tradeNotionalPerRebal = REBAL_THRESH * perSymNotional; // perp adjust ~5% of notional
    // cost = perp taker fee + perp slippage on that small trade (slippage tiny at these sizes)
    const slip = walkSlippageBps(s.perp.bids, 'sell', tradeNotionalPerRebal) ?? 2;
    const costBps = FEES.perpTakerBps + slip;
    rebalUsdAnnual += (costBps / 1e4) * tradeNotionalPerRebal * rebalsPerYear;
  }

  // ---- COST OF CAPITAL / financing ----
  // Two variants, because it matters a LOT and an honest analysis shows both:
  //
  // PESSIMISTIC (margin + buffer earn 0% on-exchange): this is the naive operator who
  //   parks USDT on Binance. Margin posted for the short perp earns ~0; the idle survival
  //   buffer earns ~0. Both FORGO the risk-free rate -> charged as opportunity cost.
  // REALISTIC (margin + buffer earn ~risk-free): a competent operator keeps the survival
  //   buffer in T-bills/USDC-lending (~4.5%) and uses USDC/USDT that itself earns yield, or
  //   counts the buffer as "still your risk-free money, just not in the carry." In that case
  //   the buffer is NOT a drag vs the risk-free baseline (it IS the baseline), and only the
  //   on-exchange margin that genuinely earns 0 is a real opportunity cost.
  //
  // marginPosted = PERP_IM% * carryNotional (posted USDT, earns ~0 on Binance USDM).
  const marginPosted = (PERP_INITIAL_MARGIN_PCT / 100) * carryNotional;
  const marginOppCostAnnual = (RISK_FREE_APR / 100) * marginPosted; // real: margin truly earns 0
  // Pessimistic buffer drag (buffer earns 0):
  const bufferOppCostAnnual = (RISK_FREE_APR / 100) * buffer;
  // NOTE: the spot leg itself is an asset held delta-neutral; its cash is "working" as the long
  // leg of the carry, so we do NOT double-charge opportunity cost on the spot notional — the
  // carry yield IS its return. We charge opp-cost only on margin + idle buffer (truly idle cash).

  // ---- NET ----
  const grossAnnual = grossFundingUsdAnnual; // current-regime (1y) funding revenue
  // Operating frictions that are ALWAYS real (fees, slippage, rebalancing, dead margin):
  const opFrictionAnnual = feeUsdAnnual + slipUsdAnnual + rebalUsdAnnual + marginOppCostAnnual;

  // PESSIMISTIC net (buffer parked at 0%): subtract buffer opportunity cost too.
  const totalCostAnnualPess = opFrictionAnnual + bufferOppCostAnnual;
  const netAnnualPess = grossAnnual - totalCostAnnualPess;

  // REALISTIC net (buffer kept in T-bills/USDC earning RF): buffer is NOT a drag; it earns RF.
  // The relevant question is the INCREMENTAL edge of running the carry vs. putting the WHOLE
  // stake in risk-free. Incremental edge = grossFunding - opFrictions - (RF forgone on the
  // deployed cash that's now in the carry instead of T-bills).
  //   deployed cash in carry (not in T-bills) = deployable (= capital - buffer).
  //   buffer stays in T-bills earning RF in BOTH worlds -> cancels out.
  const rfForgoneOnDeployed = (RISK_FREE_APR / 100) * deployable;
  const incrementalEdgeAnnual = grossAnnual - opFrictionAnnual - rfForgoneOnDeployed;

  // Returns are on TOTAL capital (the operator's whole stake, incl. buffer).
  const totalCostAnnual = totalCostAnnualPess;
  const netAnnual = netAnnualPess;
  const grossPctOnCapital = (grossAnnual / capital) * 100;
  const netPctOnCapital = (netAnnual / capital) * 100;
  const spreadOverRf = netPctOnCapital - RISK_FREE_APR;
  // Incremental edge as % of total capital (this is the cleanest "is it worth it" number):
  const incrementalEdgePct = (incrementalEdgeAnnual / capital) * 100;

  return {
    capital, buffer, deployable, carryNotional, perSymNotional, marginPosted,
    grossAnnual, grossFundingUsd3yAnnual,
    feeUsdAnnual, slipUsdAnnual, rebalUsdAnnual, marginOppCostAnnual, bufferOppCostAnnual,
    opFrictionAnnual, totalCostAnnual, netAnnual,
    incrementalEdgeAnnual, incrementalEdgePct, rfForgoneOnDeployed,
    grossPctOnCapital, netPctOnCapital, spreadOverRf,
    anyDepleted, perSym,
  };
}

const results = CAPITAL_TIERS.map(modelTier);

// ---- Minimum-viable capital -------------------------------------------------
// Fixed effort/cost: a real operator must run infra + monitoring. Model a modest fixed
// annual cost (VPS, data, monitoring, ~2h/week of attention valued at $40/h):
const FIXED_ANNUAL_USD = 12 * 50 /*VPS+data ~$50/mo*/ + 52 * 2 * 40 /*2h/wk @ $40*/; // = $600 + $4160 = $4760
// MIN-VIABLE TEST (the fair one): the carry is "worth it" only if the REALISTIC incremental
// edge over risk-free, AFTER fixed operating effort, is positive. Buffer is held in T-bills in
// both worlds so it cancels; the test is incrementalEdge - fixedCost > 0.
function incrementalAfterFixed(capital: number) {
  const m = modelTier(capital);
  return m.incrementalEdgeAnnual - FIXED_ANNUAL_USD;
}
// scan using CURRENT (1y) funding regime:
let minViable: number | null = null;
for (let c = 5000; c <= 5_000_000; c += 5000) {
  if (incrementalAfterFixed(c) > 0) { minViable = c; break; }
}

// Same test but under the 3y "fat funding" regime (rebuild gross at 3y funding):
function incrementalAfterFixed3y(capital: number) {
  const m = modelTier(capital);
  // swap gross to 3y funding revenue, keep frictions identical
  const gross3y = m.grossFundingUsd3yAnnual;
  const inc3y = gross3y - m.opFrictionAnnual - m.rfForgoneOnDeployed;
  return inc3y - FIXED_ANNUAL_USD;
}
let minViable3y: number | null = null;
for (let c = 5000; c <= 5_000_000; c += 5000) {
  if (incrementalAfterFixed3y(c) > 0) { minViable3y = c; break; }
}

// ---- OUTPUT -----------------------------------------------------------------
const out: any = {
  meta: {
    track: 'D2-full-cost-capital-model',
    generatedAt: new Date().toISOString(),
    survivors: SURVIVORS,
    riskFreeApr: RISK_FREE_APR,
    fees: FEES,
    feeRoundtripBps: (2 * FEES.spotTakerBps) + (2 * FEES.perpTakerBps),
    holdDays: HOLD_DAYS,
    perpInitialMarginPct: PERP_INITIAL_MARGIN_PCT,
    survivalBufferFrac: SURVIVAL_BUFFER_FRAC,
    fixedAnnualUsd: FIXED_ANNUAL_USD,
    fundingRegimeNote: 'Headline uses RECENT 1y funding (current regime). 3y shown for context.',
  },
  symbolStats: stats.map((s) => ({
    sym: s.sym, fundingApr3y: +s.fundingApr3y.toFixed(2), fundingApr1y: +s.fundingApr1y.toFixed(2),
    posFrac1y: +(s.posFrac1y * 100).toFixed(1), annVol1y: +(s.dailyVol1y * Math.sqrt(365) * 100).toFixed(1),
  })),
  tiers: results.map((r) => ({
    capital: r.capital,
    buffer: Math.round(r.buffer),
    deployable: Math.round(r.deployable),
    carryNotional: Math.round(r.carryNotional),
    grossFundingAnnualUsd: Math.round(r.grossAnnual),
    grossFunding3yAnnualUsd: Math.round(r.grossFundingUsd3yAnnual),
    costs: {
      feesUsd: Math.round(r.feeUsdAnnual),
      slippageUsd: Math.round(r.slipUsdAnnual),
      rebalanceUsd: Math.round(r.rebalUsdAnnual),
      marginOppCostUsd: Math.round(r.marginOppCostAnnual),
      bufferOppCostUsd: Math.round(r.bufferOppCostAnnual),
      totalUsd: Math.round(r.totalCostAnnual),
    },
    netAnnualUsd_pessBuffer0: Math.round(r.netAnnual),
    netMonthlyUsd_pessBuffer0: Math.round(r.netAnnual / 12),
    grossPctOnCapitalAnnual: +r.grossPctOnCapital.toFixed(2),
    netPctOnCapitalAnnual_pessBuffer0: +r.netPctOnCapital.toFixed(2),
    netPctOnCapitalMonthly_pessBuffer0: +(r.netPctOnCapital / 12).toFixed(3),
    spreadOverRiskFreePct_pessBuffer0: +r.spreadOverRf.toFixed(2),
    // REALISTIC: buffer in T-bills, incremental edge of running the carry vs all-risk-free
    incrementalEdgeAnnualUsd: Math.round(r.incrementalEdgeAnnual),
    incrementalEdgeMonthlyUsd: Math.round(r.incrementalEdgeAnnual / 12),
    incrementalEdgePctOnCapitalAnnual: +r.incrementalEdgePct.toFixed(3),
    incrementalEdgePctOnCapitalMonthly: +(r.incrementalEdgePct / 12).toFixed(4),
    // net monthly % on capital in the realistic world = RF/12 + incrementalEdge/12
    realisticNetMonthlyPctOnCapital: +(((RISK_FREE_APR + r.incrementalEdgePct) / 12)).toFixed(4),
    realisticNetMonthlyUsd: Math.round(((RISK_FREE_APR / 100) * r.capital + r.incrementalEdgeAnnual) / 12),
    incrementalEdgeAfterFixedAnnualUsd: Math.round(r.incrementalEdgeAnnual - FIXED_ANNUAL_USD),
    anyBookDepleted: r.anyDepleted,
  })),
  minViableCapital: {
    currentRegime_1y: minViable,
    fatRegime_3y: minViable3y,
    note: 'Smallest stake where the REALISTIC incremental edge over risk-free, after fixed operating effort, turns positive. current=last-12mo funding, fat=3y-avg funding.',
  },
};

fs.writeFileSync(path.join(CARRY, 'd2_full_cost_model.json'), JSON.stringify(out, null, 2));

// pretty print
console.log('================ TRACK D2 — FULL COST + CAPITAL MODEL ================');
console.log('Survivors deepened: BTC, ETH (long spot / short perp on Binance).');
console.log('Risk-free hurdle:', RISK_FREE_APR + '% APR.  Fee roundtrip:', out.meta.feeRoundtripBps, 'bps.  Hold:', HOLD_DAYS, 'd.  Buffer:', (SURVIVAL_BUFFER_FRAC*100)+'% idle.');
console.log('');
console.log('Per-symbol funding (REAL Binance 8h):');
for (const s of out.symbolStats) {
  console.log(`  ${s.sym}: APR 3y=${s.fundingApr3y}%  APR LAST-1y=${s.fundingApr1y}%  pos%=${s.posFrac1y}  annVol=${s.annVol1y}%`);
}
console.log('');
console.log('HEADLINE uses CURRENT (last-1y) funding regime. Cost lines are annual $.\n');
const pad = (s: any, n: number) => String(s).padStart(n);
console.log('Cost stack (annual $), gross = current-regime funding on deployed notional:');
console.log('Tier      Gross$   Fees   Slip  Rebal  MargOpp  BufOpp  | TotalCost');
for (const t of out.tiers) {
  console.log(
    pad('$' + (t.capital / 1000) + 'k', 7) + '  ' +
    pad('$' + t.grossFundingAnnualUsd, 6) + '  ' +
    pad('$' + t.costs.feesUsd, 5) + ' ' +
    pad('$' + t.costs.slippageUsd, 5) + ' ' +
    pad('$' + t.costs.rebalanceUsd, 5) + ' ' +
    pad('$' + t.costs.marginOppCostUsd, 7) + ' ' +
    pad('$' + t.costs.bufferOppCostUsd, 6) + '  | ' +
    pad('$' + t.costs.totalUsd, 8)
  );
}
console.log('');
console.log('VIEW A — PESSIMISTIC (buffer + margin parked at 0% on-exchange):');
console.log('Tier      NET%/yr   NET%/mo    NET$/mo   Spread-vs-RF');
for (const t of out.tiers) {
  console.log(
    pad('$' + (t.capital / 1000) + 'k', 7) + '  ' +
    pad(t.netPctOnCapitalAnnual_pessBuffer0 + '%', 7) + '  ' +
    pad(t.netPctOnCapitalMonthly_pessBuffer0 + '%', 8) + '  ' +
    pad('$' + t.netMonthlyUsd_pessBuffer0, 9) + '   ' +
    pad(t.spreadOverRiskFreePct_pessBuffer0 + '%', 7)
  );
}
console.log('');
console.log('VIEW B — REALISTIC (buffer held in T-bills/USDC at RF; only on-exchange margin truly dead):');
console.log('Tier      RealNET%/mo  RealNET$/mo   IncrEdge%/yr  IncrEdge$/mo  IncrEdge$/yr');
for (const t of out.tiers) {
  console.log(
    pad('$' + (t.capital / 1000) + 'k', 7) + '  ' +
    pad(t.realisticNetMonthlyPctOnCapital + '%', 10) + '  ' +
    pad('$' + t.realisticNetMonthlyUsd, 10) + '   ' +
    pad(t.incrementalEdgePctOnCapitalAnnual + '%', 10) + '   ' +
    pad('$' + t.incrementalEdgeMonthlyUsd, 10) + '   ' +
    pad('$' + t.incrementalEdgeAnnualUsd, 10)
  );
}
console.log('');
console.log('After FIXED operating cost ($' + FIXED_ANNUAL_USD + '/yr: VPS+data+~2h/wk attention @ $40/h):');
for (const t of out.tiers) {
  console.log(`  $${t.capital/1000}k: incremental edge over risk-free AFTER fixed = $${t.incrementalEdgeAfterFixedAnnualUsd}/yr`);
}
console.log('');
console.log('MINIMUM VIABLE CAPITAL (realistic test: incremental edge over RF, after fixed effort, > 0):');
console.log('  CURRENT funding regime (last 12mo):', minViable ? '$' + minViable.toLocaleString() : 'NEVER within $5M scan');
console.log('  FAT funding regime (3y avg):       ', minViable3y ? '$' + minViable3y.toLocaleString() : 'NEVER within $5M scan');
console.log('');
console.log('Wrote', path.join(CARRY, 'd2_full_cost_model.json'));
