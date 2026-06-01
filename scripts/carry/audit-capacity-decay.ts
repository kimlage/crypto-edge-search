/**
 * audit-capacity-decay.ts — TRACK D4: capacity + decay for delta-neutral perp carry.
 *
 * Honest, real-operation viability for long-spot / short-perp funding carry on the
 * 8 Binance majors. Reuses REAL data only:
 *   - output/funding/<SYM>_funding_8h.json  (3288 x 8h funding intervals, 2023-06..2026-05)
 *   - output/funding/<SYM>_prices_daily.json (1096 daily spot+perp closes)
 *   - output/carry/market-structure.json     (LIVE depth + OI + funding, this run)
 *
 * Answers:
 *   (a) DECAY: gross + net funding APR by calendar year (2023H2 / 2024 / 2025 / 2026YTD).
 *       Is the edge compressing?
 *   (b) CAPACITY: how much capital before own-flow + crowding compresses funding/basis,
 *       bounded by real open interest and order-book depth.
 *   (c) FORWARD APR: realistic net carry using ONLY the most-recent 12 months, after
 *       every friction (fees, slippage-by-size, financing, survival-buffer drag),
 *       compared to the ~4.5% risk-free alternative.
 *
 * No BigQuery, no training, no shared-file edits. Writes only output/carry/*.
 *
 * Usage:
 *   tsx scripts/carry/audit-capacity-decay.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FUND_DIR = join("output", "funding");
const CARRY_DIR = join("output", "carry");
const MAJORS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
const INTERVALS_PER_YEAR = 365.25 * 3; // funding settles every 8h = 3/day

// ---- REAL frictions (bps; stated explicitly) -------------------------------
// Binance taker is the conservative default. We hold spot (long) and short perp.
const FEES = {
  perpTakerBps: 4.0, // Binance USDT-M perp taker 0.040%
  perpMakerBps: 1.8, // Binance USDT-M perp maker 0.018%
  spotTakerBps: 10.0, // Binance spot taker 0.100%
  spotMakerBps: 10.0, // spot maker ~0.100% at retail VIP0 (BNB discount ignored for honesty)
};
// Round-trip cost to OPEN then CLOSE the delta-neutral pair, ASSUMING taker on perp
// (you usually cross the spread to get filled fast) and taker on spot.
// open: 1x spot taker + 1x perp taker ; close: same. = 2*(spot+perp) taker.
const ROUNDTRIP_FEE_BPS_TAKER = 2 * (FEES.spotTakerBps + FEES.perpTakerBps); // 28 bps
// A more optimistic execution: maker on perp both legs, taker on spot both legs.
const ROUNDTRIP_FEE_BPS_MIXED = 2 * FEES.spotTakerBps + 2 * FEES.perpMakerBps; // 23.6 bps

const RISK_FREE_APR = 0.045; // T-bills / USDC lending ~4.5%

interface FundingRow {
  fundingTime: number;
  fundingRate: number;
}
interface PriceRow {
  date: string;
  spotClose: number;
  perpClose: number;
}

function loadFunding(sym: string): FundingRow[] {
  const p = join(FUND_DIR, `${sym}_funding_8h.json`);
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, "utf8")) as FundingRow[])
    .filter((r) => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}
function loadPrices(sym: string): PriceRow[] {
  const p = join(FUND_DIR, `${sym}_prices_daily.json`);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")) as PriceRow[];
}

function yearBucket(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (y === 2023) return "2023H2";
  return String(y);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function pct(v: number, d = 3): string {
  return `${(v * 100).toFixed(d)}%`;
}

// ===========================================================================
// (a) DECAY — gross funding APR by year, per symbol and equal-weight portfolio.
// Gross funding APR = mean(8h funding rate over the year) * 3 * 365.25.
// This is what a SHORT-perp collects (you receive funding when rate > 0).
// ===========================================================================
function decayByYear() {
  const years = ["2023H2", "2024", "2025", "2026"];
  const perSym: Record<string, Record<string, { meanRate: number; aprGross: number; n: number; posFrac: number }>> =
    {};
  // portfolio: average of per-symbol 8h rates within each year bucket
  const portBucket: Record<string, number[]> = {};
  for (const y of years) portBucket[y] = [];

  for (const sym of MAJORS) {
    const f = loadFunding(sym);
    perSym[sym] = {};
    const buckets: Record<string, number[]> = {};
    for (const y of years) buckets[y] = [];
    for (const r of f) {
      const y = yearBucket(r.fundingTime);
      if (buckets[y]) buckets[y].push(r.fundingRate);
    }
    for (const y of years) {
      const rates = buckets[y];
      const m = mean(rates);
      perSym[sym][y] = {
        meanRate: m,
        aprGross: m * INTERVALS_PER_YEAR,
        n: rates.length,
        posFrac: rates.length ? rates.filter((x) => x > 0).length / rates.length : 0,
      };
    }
  }
  // equal-weight portfolio APR per year: average the per-symbol gross APRs
  const portfolio: Record<string, { aprGross: number }> = {};
  for (const y of years) {
    const aprs = MAJORS.map((s) => perSym[s][y].aprGross);
    portfolio[y] = { aprGross: mean(aprs) };
  }
  return { years, perSym, portfolio };
}

// ===========================================================================
// Forward-looking: most-recent 12 months ONLY (rolling from last funding ts).
// We compute, per symbol, over the trailing 365d window:
//   grossFundingApr, % of intervals positive (you'd only short when rate>0 to
//   collect; when negative you'd pay -> we model a SIGN-AWARE collector that only
//   holds the short when expected funding > a threshold, AND a NAIVE always-on).
// ===========================================================================
function trailing12mo() {
  const out: Record<
    string,
    {
      n: number;
      grossAprAlwaysOn: number; // short perp every interval (pay when negative)
      grossAprPositiveOnly: number; // only collect positive intervals (upper bound; ignores you can't perfectly time)
      posFrac: number;
      meanRate: number;
      medianRate: number;
    }
  > = {};
  const lastTs = Math.max(...MAJORS.map((s) => loadFunding(s).at(-1)?.fundingTime ?? 0));
  const cutoff = lastTs - 365 * 24 * 3600 * 1000;
  for (const sym of MAJORS) {
    const f = loadFunding(sym).filter((r) => r.fundingTime >= cutoff);
    const rates = f.map((r) => r.fundingRate);
    const pos = rates.filter((x) => x > 0);
    const sorted = [...rates].sort((a, b) => a - b);
    out[sym] = {
      n: rates.length,
      grossAprAlwaysOn: mean(rates) * INTERVALS_PER_YEAR,
      grossAprPositiveOnly: (pos.reduce((a, b) => a + b, 0) / rates.length) * INTERVALS_PER_YEAR,
      posFrac: rates.length ? pos.length / rates.length : 0,
      meanRate: mean(rates),
      medianRate: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    };
  }
  return { cutoffIso: new Date(cutoff).toISOString(), lastIso: new Date(lastTs).toISOString(), out };
}

// ===========================================================================
// (b) CAPACITY — from REAL live depth + OI.
// Logic: to run carry at notional N you must (1) enter/exit through the book ->
// slippage scales with N vs depth, and (2) hold OI share small enough that your
// presence doesn't compress funding. We bound capacity two ways:
//   - DEPTH ceiling: N such that single-shot entry eats <= X bps of slippage.
//   - OI/CROWDING ceiling: N <= shareOfOI * openInterest (your short OI moves the
//     funding rate; empirically funding compresses materially once a single
//     participant is a few % of OI).
// We use BOTH legs (perp short + spot long); the binding (smaller) one wins.
// ===========================================================================

/**
 * Slippage (bps) to execute notional N against a book described by depthBands
 * (oneSide notional within +/-band). Piecewise-linear walk: we consume bands in
 * order; the avg fill price impact ~ half the band you reach. Conservative.
 */
function slippageBpsForNotional(depthBands: Record<string, { oneSide: number }>, notional: number): number {
  // bands: 5,10,25,50 bps cumulative oneSide notional
  const pts = [5, 10, 25, 50]
    .map((b) => ({ band: b, cum: depthBands[String(b)]?.oneSide ?? 0 }))
    .filter((p) => p.cum > 0);
  if (!pts.length) return NaN;
  // find smallest band whose cumulative depth >= notional
  for (let i = 0; i < pts.length; i++) {
    if (notional <= pts[i].cum) {
      // avg impact ~ midpoint between previous band edge and this band, weighted
      const prevBand = i === 0 ? 0 : pts[i - 1].band;
      const prevCum = i === 0 ? 0 : pts[i - 1].cum;
      const frac = (notional - prevCum) / (pts[i].cum - prevCum || 1);
      const edge = prevBand + frac * (pts[i].band - prevBand);
      return edge / 2; // average fill is ~half-way to the marginal edge
    }
  }
  // beyond deepest measured band: extrapolate linearly past 50bps using last slope
  const last = pts.at(-1)!;
  const prev = pts.length > 1 ? pts.at(-2)! : { band: 0, cum: 0 };
  const slope = (last.band - prev.band) / Math.max(last.cum - prev.cum, 1); // bps per $
  const extra = notional - last.cum;
  return (last.band + slope * extra) / 2;
}

function capacity(ms: any) {
  // crowding ceiling: max share of perp OI a single non-flow-aware operator can take
  // before their persistent short demonstrably caps the funding they collect.
  // We report a conservative 2% and an aggressive 5%.
  const SHARE_CONSERVATIVE = 0.02;
  const SHARE_AGGRESSIVE = 0.05;
  // depth ceiling: notional that costs <= TARGET_SLIP_BPS to enter on the THINNER
  // of (perp, spot). We solve by scanning.
  const TARGET_SLIP_BPS = 5; // willing to pay 5bps one-shot entry slippage
  const rows: any[] = [];
  for (const base of ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"]) {
    const m = ms.majors[base];
    const bp = m.binancePerp;
    const bs = m.binanceSpot;
    // best-OI across reachable venues (you can split across venues -> sum OI)
    const ois = [m.binancePerp, m.bybitPerp, m.okxPerp]
      .filter((x) => x?.ok && Number.isFinite(x.openInterestUsd))
      .map((x) => x.openInterestUsd);
    const totalOi = ois.reduce((a, b) => a + b, 0);
    const binanceOi = bp?.ok ? bp.openInterestUsd : 0;

    // depth-ceiling: scan notional to find max N with slip <= target on both legs
    let depthCeil = 0;
    if (bp?.ok && bs?.ok) {
      for (let N = 1e5; N <= 5e8; N *= 1.15) {
        const sp = slippageBpsForNotional(bp.depthBands, N);
        const ss = slippageBpsForNotional(bs.depthBands, N);
        if (!Number.isFinite(sp) || !Number.isFinite(ss)) break;
        if (Math.max(sp, ss) <= TARGET_SLIP_BPS) depthCeil = N;
        else break;
      }
    }
    rows.push({
      base,
      totalOiUsd: totalOi,
      binanceOiUsd: binanceOi,
      crowdingCeil2pct: totalOi * SHARE_CONSERVATIVE,
      crowdingCeil5pct: totalOi * SHARE_AGGRESSIVE,
      depthCeil5bps: depthCeil,
      // binding capacity = min(crowding 2%, depth ceiling). This is per-deployment;
      // depth refreshes so over time you can build a larger book, but a single
      // rebalance/exit faces depthCeil.
      bindingPerShot: Math.min(totalOi * SHARE_CONSERVATIVE, depthCeil),
    });
  }
  return { rows, TARGET_SLIP_BPS, SHARE_CONSERVATIVE, SHARE_AGGRESSIVE };
}

// ===========================================================================
// (c) NET FORWARD APR by capital tier, after EVERY friction.
// Build a delta-neutral BTC+ETH-weighted carry (the only two with real depth) and
// net out: roundtrip fees amortized over holding period, rebalancing, financing on
// short margin, survival-buffer drag, and per-size slippage.
// ===========================================================================
function netForwardApr(t12: any, ms: any, cap: any, holdDays = 90) {
  // Use BTC & ETH only for the deployable book (depth + funding both adequate).
  // Equal-weight the two for the carry sleeve.
  const sleeve = ["BTC", "ETH"];
  const grossApr =
    mean(sleeve.map((b) => t12.out[`${b}USDT`].grossAprAlwaysOn)); // always-on short, pays when negative

  // Holding assumptions for amortizing one-time costs:
  // 90d default = a realistic carry roll cadence (you do NOT fully churn monthly;
  // you roll the position, only fully unwinding ~quarterly). We sensitivity-test below.
  const HOLD_DAYS = holdDays;
  const REBALANCES_PER_MONTH = 4; // restore delta ~weekly after price drift
  const REBALANCE_NOTIONAL_FRAC = 0.05; // each rebalance trades ~5% of book to re-hedge

  // Margin / financing on the short perp:
  // Binance isolated short: initial margin ~ deploy 2x (you post collateral = perp
  // notional to stay safe from liquidation; a 1x-collateralized short needs ~100%).
  // Realistically operators run the short at ~3-5x and hold a buffer. We model:
  //   - spot leg fully funded (no borrow) -> no borrow cost on long.
  //   - short perp collateral = COLLATERAL_FRAC of perp notional, held in USDC
  //     earning risk-free; the OPPORTUNITY here is already in risk-free compare.
  //   - survival buffer: idle un-deployed USDC you must keep to meet margin calls /
  //     counterparty gap. Drags the blended return.
  const SURVIVAL_BUFFER_FRAC = 0.25; // 25% of equity kept idle (earns risk-free, not carry)

  // Per-tier slippage: tier capital deployed across BTC+ETH books equally.
  const tiers = [1e4, 1e5, 1e6];
  const results: any[] = [];
  for (const equity of tiers) {
    // deployed carry notional = (1 - buffer) * equity, split BTC/ETH
    const deployed = equity * (1 - SURVIVAL_BUFFER_FRAC);
    const perLeg = deployed / sleeve.length;

    // entry+exit slippage per leg (perp + spot), once per HOLD_DAYS
    let entryExitSlipBps = 0;
    for (const base of sleeve) {
      const m = ms.majors[base];
      const sp = slippageBpsForNotional(m.binancePerp.depthBands, perLeg);
      const ss = slippageBpsForNotional(m.binanceSpot.depthBands, perLeg);
      // open: perp+spot ; close: perp+spot -> 2*(sp+ss)
      entryExitSlipBps += 2 * (sp + ss);
    }
    entryExitSlipBps /= sleeve.length; // average across legs (weighted equally)

    // rebalance slippage: each rebalance trades REBALANCE_NOTIONAL_FRAC of perLeg
    let rebalSlipBps = 0;
    for (const base of sleeve) {
      const m = ms.majors[base];
      const reN = perLeg * REBALANCE_NOTIONAL_FRAC;
      const sp = slippageBpsForNotional(m.binancePerp.depthBands, reN);
      const ss = slippageBpsForNotional(m.binanceSpot.depthBands, reN);
      rebalSlipBps += sp + ss; // one-sided trade to re-hedge (perp+spot)
    }
    rebalSlipBps /= sleeve.length;

    // ---- annualize the costs over the deployed notional ----
    // fees: roundtrip taker per HOLD_DAYS cycle -> times (365/HOLD_DAYS) per year
    const cyclesPerYear = 365 / HOLD_DAYS;
    const feeDragApr = (ROUNDTRIP_FEE_BPS_TAKER / 10000) * cyclesPerYear;
    const entryExitSlipApr = (entryExitSlipBps / 10000) * cyclesPerYear;
    const rebalFeeApr =
      (((FEES.perpTakerBps + FEES.spotTakerBps) / 10000) * REBALANCE_NOTIONAL_FRAC) *
      REBALANCES_PER_MONTH *
      12;
    const rebalSlipApr = (rebalSlipBps / 10000) * REBALANCES_PER_MONTH * 12;

    // gross carry only earned on DEPLOYED fraction; buffer earns risk-free.
    const grossOnEquity = grossApr * (1 - SURVIVAL_BUFFER_FRAC);
    const bufferRiskFree = RISK_FREE_APR * SURVIVAL_BUFFER_FRAC;

    // all drags apply to the deployed fraction
    const dragApr =
      (feeDragApr + entryExitSlipApr + rebalFeeApr + rebalSlipApr) * (1 - SURVIVAL_BUFFER_FRAC);

    const netCarryAprOnEquity = grossOnEquity - dragApr;
    const blendedNetApr = netCarryAprOnEquity + bufferRiskFree; // total portfolio incl idle buffer
    const edgeVsRiskFree = blendedNetApr - RISK_FREE_APR;

    results.push({
      equity,
      grossAprDeployed: grossApr,
      grossOnEquity,
      bufferRiskFree,
      feeDragApr,
      entryExitSlipBps,
      entryExitSlipApr,
      rebalFeeApr,
      rebalSlipApr,
      dragApr,
      netCarryAprOnEquity,
      blendedNetApr,
      edgeVsRiskFree,
      monthlyNetPct: blendedNetApr / 12,
      monthlyNetUsd: (blendedNetApr / 12) * equity,
      monthlyEdgeUsd: (edgeVsRiskFree / 12) * equity,
    });
  }
  return {
    sleeve,
    grossApr,
    HOLD_DAYS,
    REBALANCES_PER_MONTH,
    REBALANCE_NOTIONAL_FRAC,
    SURVIVAL_BUFFER_FRAC,
    roundtripFeeBpsTaker: ROUNDTRIP_FEE_BPS_TAKER,
    results,
  };
}

// ===========================================================================
function main() {
  if (!existsSync(join(CARRY_DIR, "market-structure.json"))) {
    throw new Error("missing output/carry/market-structure.json — run fetch-market-structure.mjs first");
  }
  const ms = JSON.parse(readFileSync(join(CARRY_DIR, "market-structure.json"), "utf8"));

  const decay = decayByYear();
  const t12 = trailing12mo();
  const cap = capacity(ms);
  const net = netForwardApr(t12, ms, cap, 90); // base case: 90d roll
  // sensitivity: how does net change with churn cadence?
  const sensitivity = [30, 90, 180].map((hd) => ({ holdDays: hd, net: netForwardApr(t12, ms, cap, hd) }));

  // ---- console report ----
  const L: string[] = [];
  const log = (s = "") => L.push(s);

  log("================ TRACK D4: CAPACITY + DECAY — delta-neutral perp carry ================");
  log(`data: output/funding/* (real, 2023-06..2026-05, 8 majors) + LIVE depth/OI ${ms.fetchedAt}`);
  log("");
  log("--- (a) DECAY: GROSS funding APR by year (mean 8h rate x 3 x 365.25), short collects ---");
  log("SYM     2023H2    2024     2025     2026YTD   trend");
  for (const sym of MAJORS) {
    const r = decay.perSym[sym];
    const trend =
      r["2026"].aprGross < r["2024"].aprGross ? "DOWN" : r["2026"].aprGross > r["2024"].aprGross ? "up" : "flat";
    log(
      `${sym.replace("USDT", "").padEnd(6)} ${pct(r["2023H2"].aprGross, 2).padStart(8)} ${pct(r["2024"].aprGross, 2).padStart(8)} ${pct(r["2025"].aprGross, 2).padStart(8)} ${pct(r["2026"].aprGross, 2).padStart(8)}   ${trend}`,
    );
  }
  log(
    `PORT   ${pct(decay.portfolio["2023H2"].aprGross, 2).padStart(8)} ${pct(decay.portfolio["2024"].aprGross, 2).padStart(8)} ${pct(decay.portfolio["2025"].aprGross, 2).padStart(8)} ${pct(decay.portfolio["2026"].aprGross, 2).padStart(8)}   (equal-weight 8)`,
  );
  log("");
  log("--- (c-pre) TRAILING 12-MONTH gross funding APR (the forward-looking base) ---");
  log(`window ${t12.cutoffIso.slice(0, 10)} .. ${t12.lastIso.slice(0, 10)}`);
  log("SYM     alwaysOnAPR  posOnlyAPR  posFrac  medianRate8h");
  for (const sym of MAJORS) {
    const r = t12.out[sym];
    log(
      `${sym.replace("USDT", "").padEnd(6)} ${pct(r.grossAprAlwaysOn, 2).padStart(10)} ${pct(r.grossAprPositiveOnly, 2).padStart(10)} ${(r.posFrac * 100).toFixed(0).padStart(6)}%  ${(r.medianRate * 100).toFixed(4)}%`,
    );
  }
  const sleeveApr = mean(net.sleeve.map((b) => t12.out[`${b}USDT`].grossAprAlwaysOn));
  log(`BTC+ETH sleeve always-on gross APR (12mo): ${pct(sleeveApr, 2)}`);
  log("");
  log("--- (b) CAPACITY: real OI + depth ceilings (per-deployment / single-shot) ---");
  log(`target entry slippage <= ${cap.TARGET_SLIP_BPS}bps; crowding share ${cap.SHARE_CONSERVATIVE * 100}%/${cap.SHARE_AGGRESSIVE * 100}% of OI`);
  log("SYM    totalOI(3venue)  depthCeil@5bps  crowd@2%      crowd@5%     bindingPerShot");
  for (const r of cap.rows) {
    const f = (x: number) => `$${(x / 1e6).toFixed(1)}M`;
    log(
      `${r.base.padEnd(5)} ${`$${(r.totalOiUsd / 1e9).toFixed(2)}B`.padStart(14)}  ${f(r.depthCeil5bps).padStart(13)}  ${f(r.crowdingCeil2pct).padStart(11)}  ${f(r.crowdingCeil5pct).padStart(11)}  ${f(r.bindingPerShot).padStart(13)}`,
    );
  }
  const btcEthCap = cap.rows.filter((r: any) => r.base === "BTC" || r.base === "ETH");
  const totalBindingBtcEth = btcEthCap.reduce((a: number, r: any) => a + r.bindingPerShot, 0);
  log(`BTC+ETH combined binding-per-shot capacity: $${(totalBindingBtcEth / 1e6).toFixed(0)}M`);
  log("(crowding@2% across all 8: $" + (cap.rows.reduce((a: number, r: any) => a + r.crowdingCeil2pct, 0) / 1e6).toFixed(0) + "M total addressable)");
  log("");
  log("--- (c) FORWARD NET APR after EVERY friction, by capital tier (BTC+ETH sleeve) ---");
  log(`assumptions: hold ${net.HOLD_DAYS}d/cycle, ${net.REBALANCES_PER_MONTH} rebal/mo @ ${net.REBALANCE_NOTIONAL_FRAC * 100}% notional, survival buffer ${net.SURVIVAL_BUFFER_FRAC * 100}% idle@RF, roundtrip taker ${net.roundtripFeeBpsTaker}bps, RF=${pct(RISK_FREE_APR, 1)}`);
  log("equity     grossDeploy  entryExitSlip  totalDrag  netCarry   blendedNet  edgeVsRF  mo.Net$  mo.Edge$");
  for (const r of net.results) {
    log(
      `$${(r.equity / 1000).toFixed(0).padStart(4)}k    ${pct(r.grossAprDeployed, 2).padStart(8)}  ${(r.entryExitSlipBps).toFixed(1).padStart(8)}bps  ${pct(r.dragApr, 2).padStart(8)}  ${pct(r.netCarryAprOnEquity, 2).padStart(7)}  ${pct(r.blendedNetApr, 2).padStart(9)}  ${pct(r.edgeVsRiskFree, 2).padStart(7)}  $${r.monthlyNetUsd.toFixed(0).padStart(6)}  $${r.monthlyEdgeUsd.toFixed(0).padStart(6)}`,
    );
  }
  log("");
  log("--- (c-sens) HOLDING-PERIOD SENSITIVITY (blended net APR at $100k tier) ---");
  log("roll cadence   grossDeploy  totalDrag  netCarry   blendedNet  edgeVsRF");
  for (const s of sensitivity) {
    const r = s.net.results[1]; // $100k tier
    log(
      `${(s.holdDays + "d").padEnd(13)}  ${pct(r.grossAprDeployed, 2).padStart(8)}  ${pct(r.dragApr, 2).padStart(8)}  ${pct(r.netCarryAprOnEquity, 2).padStart(7)}  ${pct(r.blendedNetApr, 2).padStart(9)}  ${pct(r.edgeVsRiskFree, 2).padStart(7)}`,
    );
  }
  log("");
  log("--- (c-bestcase) SIGN-AWARE upper bound: collect only positive-funding intervals ---");
  log("(idealized: assumes you perfectly avoid paying negative funding; real capture is lower)");
  const posSleeveApr = mean(net.sleeve.map((b) => t12.out[`${b}USDT`].grossAprPositiveOnly));
  // apply same 90d drag structure to the positive-only gross
  const base100k = net.results[1];
  const posNetCarry = posSleeveApr * (1 - net.SURVIVAL_BUFFER_FRAC) - base100k.dragApr;
  const posBlended = posNetCarry + base100k.bufferRiskFree;
  log(`BTC+ETH positive-only gross APR (12mo): ${pct(posSleeveApr, 2)}`);
  log(`-> blended net (90d roll, $100k): ${pct(posBlended, 2)}, edge vs RF: ${pct(posBlended - RISK_FREE_APR, 2)}`);
  log("");
  log("--- VERDICT (honest) ---");
  const t10k = net.results[0];
  const t1m = net.results[2];
  log(
    `At $10k: blended net ${pct(t10k.blendedNetApr, 2)}/yr = ${pct(t10k.monthlyNetPct, 3)}/mo = $${t10k.monthlyNetUsd.toFixed(0)}/mo; edge over risk-free = ${pct(t10k.edgeVsRiskFree, 2)} = $${t10k.monthlyEdgeUsd.toFixed(0)}/mo.`,
  );
  log(
    `At $1M: blended net ${pct(t1m.blendedNetApr, 2)}/yr = $${t1m.monthlyNetUsd.toFixed(0)}/mo; edge over risk-free = ${pct(t1m.edgeVsRiskFree, 2)} = $${t1m.monthlyEdgeUsd.toFixed(0)}/mo.`,
  );

  const report = L.join("\n");
  console.log(report);

  writeFileSync(
    join(CARRY_DIR, "capacity-decay-report.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), decay, t12, capacity: cap, netForward: net, sensitivity },
      null,
      2,
    ),
  );
  writeFileSync(join(CARRY_DIR, "capacity-decay-report.txt"), report + "\n");
}

main();
