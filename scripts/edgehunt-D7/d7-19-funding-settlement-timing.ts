/**
 * D7.19 — Funding-rate settlement-timing micro-flows.
 *
 * Belief: the fixed 8h funding stamps (00/08/16 UTC) create predictable
 * micro-flows (carry traders rebalancing into/out of the stamp). Position
 * around the stamp — fade or follow the pre-settle drift — to harvest it.
 *
 * THE BAR THIS MUST CLEAR (the whole point of the item):
 *   The carry edge ALREADY survived sub-RF (perfect-foresight carry beat
 *   T-bills by <0.55%/yr). Settlement-timing is a REFINEMENT — it must ADD
 *   net Sharpe OVER the carry survivor, *net of the extra intraday turnover
 *   it introduces*. Beating zero is not enough; beating the carry baseline is.
 *
 * Honest N = stamp(3: 00/08/16) x sign(fade/follow = 2) x lead/lag-offset grid.
 * Every (stamp, polarity, lead, lag, hold) cell is a data-mining trial; DSR is
 * applied at that full count.
 *
 * RIGHT null = calendar-reanchor of the settlement stamps: re-run the identical
 * intraday rule on RANDOM FAKE stamp times (preserving the 3-per-day cadence but
 * randomly phased off the true 00/08/16 grid). If fake stamps harvest the same
 * micro-flow, there is no settlement-specific edge. Plus block-bootstrap CI on
 * the INCREMENTAL (overlay-minus-carry) return.
 *
 * Data ($0): output/funding/BTCUSDT_funding_8h.json (8h stamps, 3y) +
 * output/edgehunt-D7/btc_15m_settle_window.json (15m bars over the funding
 * overlap, pre-extracted from output/bigquery/btc_ohlcv_15m.ndjson).
 *
 * Cost: realistic 6 bps/side taker on every position change (same as D7.1).
 * The overlay's extra intraday churn is charged in full.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-D7/d7-19-funding-settlement-timing.json`;

// ---------- load ----------
interface Funding {
  fundingTime: number;
  fundingRate: number;
}
const funding: Funding[] = JSON.parse(
  readFileSync(`${ROOT}/output/funding/BTCUSDT_funding_8h.json`, "utf8"),
).sort((a: Funding, b: Funding) => a.fundingTime - b.fundingTime);

// 15m bars: [t, open, high, low, close, vol]
type Bar15 = [number, number, number, number, number, number];
const bars: Bar15[] = JSON.parse(
  readFileSync(`${ROOT}/output/edgehunt-D7/btc_15m_settle_window.json`, "utf8"),
);

const BAR_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// index bars by timestamp for O(1) lookup of the bar that OPENS at t.
const barByT = new Map<number, number>();
for (let i = 0; i < bars.length; i += 1) barByT.set(bars[i][0], i);

const closeAt = (t: number): number | undefined => {
  const i = barByT.get(t);
  return i === undefined ? undefined : bars[i][4];
};
const openAt = (t: number): number | undefined => {
  const i = barByT.get(t);
  return i === undefined ? undefined : bars[i][1];
};

// ---------- common config ----------
const COST_PER_SIDE = 0.0006; // 6 bps taker, charged on every entry & every exit
const ANNUALIZE_8H = Math.sqrt(3 * 365); // 8h-period Sharpe -> annual
const ANNUALIZE_TRADE = (tradesPerYear: number) => Math.sqrt(tradesPerYear);

// overlap window between funding and bars
const barT0 = bars[0][0];
const barTN = bars[bars.length - 1][0];
const yearsOverlap = (barTN - barT0) / (365.25 * DAY_MS);

// ============================================================
// PART A — CARRY SURVIVOR BASELINE (perfect-foresight, DELTA-NEUTRAL carry)
// ============================================================
// The actual carry survivor is DELTA-NEUTRAL (long spot + short perp), so it has
// NO price exposure — it just accrues the funding stream. Each 8h period the
// short-perp leg RECEIVES funding f when f>0 (and pays when f<0). With perfect
// foresight you hold the side that collects; since BTC funding is ~85% positive,
// the dominant book is static short-perp/long-spot. Per-8h net return = pos*f,
// where pos is +1 (short perp collects +f) held with hysteresis so it does not
// churn on every sign blip (the naive flip-every-sign version self-destructs on
// turnover — verified: 18%/yr churn wipes the 7.4% funding). Rebalances charged
// 6 bps/side on BOTH legs.
//
// This near-deterministic funding stream is the high-Sharpe survivor the overlay
// must ADD to. Crucially it carries essentially zero price variance, so any
// DIRECTIONAL intraday overlay injects noise variance + turnover into it.

interface CarryStep {
  t: number; // stamp time (entry)
  ret: number; // net 8h return of carry book (funding accrual, delta-neutral)
  pos: number; // +1 short-perp (collect +f), -1 long-perp (collect -f)
  funding: number;
}

function roundToBar(t: number): number {
  return Math.floor(t / BAR_MS) * BAR_MS;
}

function buildCarry(stamps: Funding[]): CarryStep[] {
  const steps: CarryStep[] = [];
  // Perfect-foresight hysteresis: hold the side whose EMA-funding sign collects.
  const band = 0.00005;
  const k = 0.05;
  let ema = 0;
  let pos = 1; // start short-perp (dominant: ~85% positive funding)
  for (let i = 0; i < stamps.length; i += 1) {
    const f = stamps[i].fundingRate;
    ema = ema * (1 - k) + f * k;
    let newPos = pos;
    if (ema > band) newPos = 1;
    else if (ema < -band) newPos = -1;
    const turnoverCost = newPos !== pos ? 2 * COST_PER_SIDE : 0; // rebalance both legs
    pos = newPos;
    // delta-neutral: only funding accrual, pos*f (short-perp collects +f)
    steps.push({ t: stamps[i].fundingTime, ret: pos * f - turnoverCost, pos, funding: f });
  }
  return steps;
}

const carry = buildCarry(funding.filter((f) => f.fundingTime >= barT0 && f.fundingTime <= barTN));
const carryRet = carry.map((c) => c.ret);
const carryStats = summarizeReturnSeries(carryRet);

// T-bill bar: ~the item says carry beat T-bills by <0.55%/yr. We model the RF
// hurdle as a per-8h drag so "excess over T-bills" is the honest baseline. Use
// 4.5%/yr (recent T-bill) -> per-8h = 0.045/ (3*365).
const RF_ANNUAL = 0.045;
const RF_PER_8H = RF_ANNUAL / (3 * 365);
const carryExcessRet = carryRet.map((r) => r - RF_PER_8H);
const carryExcessStats = summarizeReturnSeries(carryExcessRet);
const carryAnnualExcess =
  Math.expm1(carryExcessStats.mean * 3 * 365) === 0
    ? carryExcessStats.mean * 3 * 365
    : carryExcessStats.mean * 3 * 365; // mean*periods/yr ~ annual log excess

// ============================================================
// PART B — SETTLEMENT-TIMING OVERLAY GRID
// ============================================================
// Around each true stamp at hour H in {0,8,16} UTC, we test an intraday rule:
//   - lead: enter `lead` 15m-bars BEFORE the stamp
//   - hold: exit `hold` 15m-bars AFTER entry (so we straddle/precede the stamp)
//   - polarity: FOLLOW the pre-settle drift (sign of return over the lookback
//     leading into entry) or FADE it.
// The overlay return is the intraday price move over [entry, exit] times the
// chosen sign, net of 6 bps/side entry+exit. This is a SEPARATE intraday book.
//
// THE TEST: overlay return is added to the carry book (a small intraday tilt).
// We measure incremental Sharpe = Sharpe(carry+overlay) - Sharpe(carry), and we
// require the overlay's STANDALONE net Sharpe to be positive AND the increment
// to be positive AND surrogate-significant. The extra turnover (2 trades per
// stamp it acts on) is fully charged.

const LEADS = [1, 2, 4, 8]; // 15m, 30m, 1h, 2h before stamp
const HOLDS = [1, 2, 4, 8]; // exit n bars after entry
const POLARITIES: Array<"follow" | "fade"> = ["follow", "fade"];
const STAMP_HOURS = [0, 8, 16];
const LOOKBACK_BARS = 4; // drift measured over 1h before entry, to set follow/fade sign

interface OverlayCell {
  stampHour: number | "all";
  polarity: "follow" | "fade";
  lead: number;
  hold: number;
  perStampRet: number[]; // net intraday return per acted stamp
  stampTimes: number[];
}

/** Build one overlay cell's per-stamp net intraday returns on a given stamp set. */
function buildOverlay(
  stamps: number[], // stamp timestamps to act on
  polarity: "follow" | "fade",
  lead: number,
  hold: number,
): { rets: number[]; times: number[] } {
  const rets: number[] = [];
  const times: number[] = [];
  for (const st of stamps) {
    const stBar = roundToBar(st);
    const tEntry = stBar - lead * BAR_MS;
    const tExit = tEntry + hold * BAR_MS;
    const tLookStart = tEntry - LOOKBACK_BARS * BAR_MS;
    const pLookStart = openAt(tLookStart);
    const pEntry = openAt(tEntry);
    const pExit = openAt(tExit);
    if (
      pLookStart === undefined ||
      pEntry === undefined ||
      pExit === undefined ||
      pLookStart <= 0 ||
      pEntry <= 0 ||
      pExit <= 0
    )
      continue;
    const drift = Math.log(pEntry / pLookStart); // pre-settle drift into entry
    const driftSign = drift > 0 ? 1 : drift < 0 ? -1 : 0;
    if (driftSign === 0) continue;
    const sign = polarity === "follow" ? driftSign : -driftSign;
    const move = Math.log(pExit / pEntry);
    const gross = sign * move;
    const net = gross - 2 * COST_PER_SIDE; // entry + exit, full taker each side
    rets.push(net);
    times.push(st);
  }
  return { rets, times };
}

// all true stamps in overlap
const trueStamps = funding
  .filter((f) => f.fundingTime >= barT0 + 2 * HOUR_MS && f.fundingTime <= barTN)
  .map((f) => f.fundingTime);

// stamp times bucketed by hour
const stampsByHour = new Map<number, number[]>();
for (const h of STAMP_HOURS) stampsByHour.set(h, []);
for (const st of trueStamps) {
  const h = new Date(st).getUTCHours();
  if (stampsByHour.has(h)) stampsByHour.get(h)!.push(st);
}

// ---------- sweep the full honest grid ----------
const cells: Array<{
  key: string;
  stampHour: number | "all";
  polarity: "follow" | "fade";
  lead: number;
  hold: number;
  nStamps: number;
  overlaySharpe8h: number;
  overlaySharpeAnnual: number;
  overlayMean: number;
  combinedSharpe8h: number;
  incrementalSharpe8h: number;
  incrementalSharpeAnnual: number;
}> = [];

// Pre-compute carry indexed by stamp time so we can add overlay onto the same
// 8h clock. Map stampTime -> carry index.
const carryIdxByStamp = new Map<number, number>();
carry.forEach((c, i) => carryIdxByStamp.set(c.t, i));

/** Combine carry + an overlay book (overlay acts on a subset of stamps). */
function combinedSeries(overlayTimes: number[], overlayRets: number[]): number[] {
  const add = new Map<number, number>();
  for (let i = 0; i < overlayTimes.length; i += 1) {
    // overlay around stamp st affects the carry step that ENTERS at st (the
    // stamp). Attribute overlay pnl to that 8h bucket.
    add.set(overlayTimes[i], (add.get(overlayTimes[i]) ?? 0) + overlayRets[i]);
  }
  return carry.map((c) => c.ret + (add.get(c.t) ?? 0));
}

const stampSets: Array<{ label: number | "all"; stamps: number[] }> = [
  { label: "all", stamps: trueStamps },
  ...STAMP_HOURS.map((h) => ({ label: h as number | "all", stamps: stampsByHour.get(h)! })),
];

for (const ss of stampSets) {
  for (const pol of POLARITIES) {
    for (const lead of LEADS) {
      for (const hold of HOLDS) {
        const { rets, times } = buildOverlay(ss.stamps, pol, lead, hold);
        if (rets.length < 30) continue;
        const ovStats = summarizeReturnSeries(rets);
        const combined = combinedSeries(times, rets);
        const combStats = summarizeReturnSeries(combined);
        const incr = combStats.sharpe - carryStats.sharpe;
        cells.push({
          key: `h${ss.label}|${pol}|lead${lead}|hold${hold}`,
          stampHour: ss.label,
          polarity: pol,
          lead,
          hold,
          nStamps: rets.length,
          overlaySharpe8h: ovStats.sharpe,
          overlaySharpeAnnual: ovStats.sharpe * ANNUALIZE_TRADE(rets.length / yearsOverlap),
          overlayMean: ovStats.mean,
          combinedSharpe8h: combStats.sharpe,
          incrementalSharpe8h: incr,
          incrementalSharpeAnnual: incr * ANNUALIZE_8H,
        });
      }
    }
  }
}

// Honest N = full grid count (data-mining trials).
const honestN = cells.length;

// Best cell by INCREMENTAL Sharpe (must add over carry) — the right objective.
cells.sort((a, b) => b.incrementalSharpe8h - a.incrementalSharpe8h);
const bestIncr = cells[0];
// Best cell by standalone overlay Sharpe (for reference).
const bestStandalone = [...cells].sort((a, b) => b.overlaySharpe8h - a.overlaySharpe8h)[0];

// ============================================================
// PART B2 — STANDALONE PREDICTIVE CONTENT (fairest shot for the overlay)
// ============================================================
// Independent of carry-Sharpe dilution: does pre-settle drift predict the
// post-settle move? Pool ALL true stamps; regress post-entry move on pre-settle
// drift sign. Report hit-rate and mean signed move (FOLLOW polarity) net of cost
// at the single best (lead,hold). If even the standalone overlay has no positive
// net edge AND no settlement-vs-fake gap, the refinement is dead on arrival.
function mulberry32b(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// PART C — RIGHT NULL: calendar-reanchor of stamp times
// ============================================================
// Rebuild the BEST incremental cell's overlay on FAKE stamp grids: keep the
// 3-per-day cadence but shift the whole 00/08/16 grid by a random phase off the
// true settlement times. If fake stamps achieve the same incremental Sharpe,
// the "edge" is generic intraday mean-reversion/momentum, NOT settlement flow.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N_SURR = 2000;
const rng = mulberry32(71919);

// Reconstruct the day-list of true stamps (one per 8h slot) for the best cell's
// stamp set. For "all" we use every day's 3 slots; for a single hour, one slot.
function fakeStampGrid(phaseBars: number): number[] {
  // shift each true stamp by phaseBars*15m, snapped to the bar grid. This keeps
  // exactly the same number/cadence of events but moves them OFF the true stamp.
  const shift = phaseBars * BAR_MS;
  const set = bestIncr.stampHour === "all"
    ? trueStamps
    : stampsByHour.get(bestIncr.stampHour as number)!;
  return set.map((st) => roundToBar(st) + shift);
}

let surrGE = 0;
const surrIncr: number[] = [];
for (let s = 0; s < N_SURR; s += 1) {
  // random phase in [1, 31] bars (15m..~8h) but NOT a multiple of 32 bars (=8h)
  // so it never realigns with a true stamp. Also exclude 0.
  let pb = 1 + Math.floor(rng() * 30); // 1..30 bars off
  if (pb === 0) pb = 1;
  const fake = fakeStampGrid(pb);
  const { rets, times } = buildOverlay(fake, bestIncr.polarity, bestIncr.lead, bestIncr.hold);
  if (rets.length < 30) continue;
  const combined = combinedSeries(times, rets);
  const incr = summarizeReturnSeries(combined).sharpe - carryStats.sharpe;
  surrIncr.push(incr);
  if (incr >= bestIncr.incrementalSharpe8h) surrGE += 1;
}
const surrogateP = (surrGE + 1) / (surrIncr.length + 1);
const surrMeanIncr = surrIncr.reduce((a, b) => a + b, 0) / Math.max(1, surrIncr.length);

// Standalone-overlay surrogate: give the overlay its fairest shot — does the
// best STANDALONE overlay Sharpe depend on hitting the TRUE stamp, vs a fake
// stamp shifted off the grid? (settlement-specific timing test, no carry dilution)
const rngB = mulberry32b(424242);
const bestStandaloneSet =
  bestStandalone.stampHour === "all"
    ? trueStamps
    : stampsByHour.get(bestStandalone.stampHour as number)!;
let surrStandaloneGE = 0;
const surrStandalone: number[] = [];
for (let s = 0; s < N_SURR; s += 1) {
  const pb = 1 + Math.floor(rngB() * 30);
  const fake = bestStandaloneSet.map((st) => roundToBar(st) + pb * BAR_MS);
  const { rets } = buildOverlay(fake, bestStandalone.polarity, bestStandalone.lead, bestStandalone.hold);
  if (rets.length < 30) continue;
  const sh = summarizeReturnSeries(rets).sharpe;
  surrStandalone.push(sh);
  if (sh >= bestStandalone.overlaySharpe8h) surrStandaloneGE += 1;
}
const surrogateStandaloneP = (surrStandaloneGE + 1) / (surrStandalone.length + 1);
const surrStandaloneMean =
  surrStandalone.reduce((a, b) => a + b, 0) / Math.max(1, surrStandalone.length);

// ============================================================
// PART D — DSR at honest N on the best cell's COMBINED book increment
// ============================================================
// Build the incremental return series (combined - carry) for the best cell and
// deflate at the full honest N.
const bestSet =
  bestIncr.stampHour === "all" ? trueStamps : stampsByHour.get(bestIncr.stampHour as number)!;
const bestOv = buildOverlay(bestSet, bestIncr.polarity, bestIncr.lead, bestIncr.hold);
const bestCombined = combinedSeries(bestOv.times, bestOv.rets);
const incrSeries = bestCombined.map((v, i) => v - carry[i].ret);
const incrStats = summarizeReturnSeries(incrSeries);

const dsr = computeDeflatedSharpeRatio(incrSeries, { trialCount: Math.max(honestN, 1) });
// also DSR on standalone overlay returns
const dsrStandalone = computeDeflatedSharpeRatio(bestOv.rets, { trialCount: Math.max(honestN, 1) });

// Block bootstrap CI on the incremental compound return.
const boot = blockBootstrapConfidenceInterval(incrSeries, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 9, // ~3 days of 8h steps
  confidenceLevel: 0.95,
  seed: "d7-19-incr",
});

// ============================================================
// PART E — CPCV / PBO across the grid (overfit check)
// ============================================================
// Treat each (combined) cell as a strategy; split the timeline into K folds and
// ask: does the in-sample-best cell stay best out-of-sample? Use the combined
// books so PBO is on the refinement objective. Build aligned fold returns.
const K = 8;
const foldSize = Math.floor(carry.length / K);
function foldsOf(series: number[]): number[][] {
  const f: number[][] = [];
  for (let k = 0; k < K; k += 1) {
    f.push(series.slice(k * foldSize, (k + 1) * foldSize));
  }
  return f;
}
// Use top cells (and carry) as the strategy universe to keep CPCV tractable.
const topCells = cells.slice(0, Math.min(24, cells.length));
const cpcvStrats = [
  { id: "carry", folds: foldsOf(carryRet) },
  ...topCells.map((c) => {
    const set = c.stampHour === "all" ? trueStamps : stampsByHour.get(c.stampHour as number)!;
    const ov = buildOverlay(set, c.polarity, c.lead, c.hold);
    return { id: c.key, folds: foldsOf(combinedSeries(ov.times, ov.rets)) };
  }),
];
let pbo: number | null = null;
try {
  const cpcv = estimateCscvPbo(cpcvStrats, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = cpcv.pbo;
} catch (e) {
  pbo = null;
}

// ============================================================
// PART F — Harvey-Liu haircut on the headline incremental Sharpe
// ============================================================
// Multiple-testing haircut: t-stat of incremental Sharpe, Bonferroni-style
// haircut for honestN trials. Haircut Sharpe = Sharpe * (1 - p_hl-adjustment).
function tStatOfSharpe(sh: number, n: number): number {
  return sh * Math.sqrt(n);
}
const incrT = tStatOfSharpe(incrStats.sharpe, incrSeries.length);
// Bonferroni p across honestN
function normalSf(z: number): number {
  // survival of standard normal
  return 0.5 * erfc(z / Math.SQRT2);
}
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  // Numerical Recipes erfcc rational approximation (Horner via reduce).
  const coeffs = [
    -1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807,
    -1.13520398, 1.48851587, -0.82215223, 0.17087277,
  ];
  let poly = 0;
  for (let i = coeffs.length - 1; i >= 0; i -= 1) {
    poly = poly * t + coeffs[i];
  }
  const r = t * Math.exp(-z * z + poly);
  return x >= 0 ? r : 2 - r;
}
const pSingle = normalSf(incrT);
const pBonf = Math.min(1, pSingle * honestN);
const haircutSharpe = pBonf < 0.5 ? incrStats.sharpe : incrStats.sharpe * Math.max(0, 1 - pBonf);

// ---------- assemble ----------
const result = {
  hypothesis: "D7.19 funding-rate settlement-timing micro-flows (refines carry)",
  sample: {
    start: new Date(barT0).toISOString(),
    end: new Date(barTN).toISOString(),
    years: Number(yearsOverlap.toFixed(3)),
    fundingStamps: funding.length,
    bars15m: bars.length,
  },
  cost: { perSideBps: COST_PER_SIDE * 10_000, note: "taker, charged on every entry & exit" },
  carrySurvivorBaseline: {
    note: "perfect-foresight perp carry: take the side that receives funding each 8h",
    nSteps: carryRet.length,
    netSharpe8h: carryStats.sharpe,
    netSharpeAnnual: carryStats.sharpe * ANNUALIZE_8H,
    meanPer8h: carryStats.mean,
    compound: carryStats.compoundReturn,
    excessOverTbill_annualLog: carryAnnualExcess,
    excessSharpeAnnual: carryExcessStats.sharpe * ANNUALIZE_8H,
    rfAnnualAssumed: RF_ANNUAL,
  },
  honestN,
  overlayGrid: {
    leads: LEADS,
    holds: HOLDS,
    polarities: POLARITIES,
    stampSets: ["all", ...STAMP_HOURS],
    cellsEvaluated: cells.length,
  },
  bestByIncrementalSharpe: bestIncr,
  bestByStandaloneSharpe: {
    key: bestStandalone.key,
    overlaySharpe8h: bestStandalone.overlaySharpe8h,
    overlaySharpeAnnual: bestStandalone.overlaySharpeAnnual,
    incrementalSharpe8h: bestStandalone.incrementalSharpe8h,
    nStamps: bestStandalone.nStamps,
  },
  incrementalBook: {
    note: "(carry+bestOverlay) - carry, on the shared 8h clock",
    nSteps: incrSeries.length,
    meanPer8h: incrStats.mean,
    sharpe8h: incrStats.sharpe,
    sharpeAnnual: incrStats.sharpe * ANNUALIZE_8H,
    compound: incrStats.compoundReturn,
  },
  rightNull_calendarReanchorStamps: {
    surrogates: surrIncr.length,
    realIncrementalSharpe8h: bestIncr.incrementalSharpe8h,
    surrogateMeanIncrementalSharpe8h: surrMeanIncr,
    fakeBeatsReal_count: surrGE,
    surrogateP,
    note: "fake stamps = 00/08/16 grid shifted by a random 15m..8h phase off true stamps",
  },
  rightNull_standaloneOverlay: {
    bestStandaloneKey: bestStandalone.key,
    surrogates: surrStandalone.length,
    realStandaloneSharpe8h: bestStandalone.overlaySharpe8h,
    surrogateMeanSharpe8h: surrStandaloneMean,
    fakeBeatsReal_count: surrStandaloneGE,
    surrogateP: surrogateStandaloneP,
    note: "does the BEST standalone overlay Sharpe require the true stamp vs a fake-shifted one",
  },
  deflatedSharpe: {
    incremental: {
      sharpe8h: dsr.sharpe,
      trialCount: dsr.trialCount,
      expectedMaxSharpe: dsr.expectedMaxSharpe,
      deflatedProbability: dsr.deflatedProbability,
    },
    standaloneOverlay: {
      sharpe8h: dsrStandalone.sharpe,
      deflatedProbability: dsrStandalone.deflatedProbability,
    },
  },
  blockBootstrapIncrementalMean: { lower: boot.lower, estimate: boot.estimate, upper: boot.upper },
  cpcvPbo: pbo,
  harveyLiuHaircut: {
    incrementalSharpe8h: incrStats.sharpe,
    tStat: incrT,
    pSingle,
    pBonferroni: pBonf,
    haircutSharpe8h: haircutSharpe,
  },
  monthlyAt100k: null as number | null,
};

// crude monthly $ on $100k IF it survived: incremental mean per 8h * 3 * 30 days
// * $100k. Only meaningful if increment is positive & significant.
const monthlyIncr = incrStats.mean * 3 * 30 * 100_000;
result.monthlyAt100k = Number(monthlyIncr.toFixed(2));

writeFileSync(OUT, JSON.stringify(result, null, 2));

// ---------- console summary ----------
console.log("=== D7.19 Funding settlement-timing micro-flows ===");
console.log(
  `sample ${result.sample.start.slice(0, 10)}..${result.sample.end.slice(0, 10)} (${result.sample.years}y), honest N=${honestN}`,
);
console.log(
  `CARRY survivor: net Sharpe 8h=${carryStats.sharpe.toFixed(4)} annual=${(carryStats.sharpe * ANNUALIZE_8H).toFixed(3)}, excess-over-Tbill annual log=${carryAnnualExcess.toFixed(4)}`,
);
console.log(
  `BEST incremental cell: ${bestIncr.key} | overlay Sharpe8h=${bestIncr.overlaySharpe8h.toFixed(4)} | incremental Sharpe8h=${bestIncr.incrementalSharpe8h.toFixed(5)} (annual=${bestIncr.incrementalSharpeAnnual.toFixed(4)}) | nStamps=${bestIncr.nStamps}`,
);
console.log(
  `BEST standalone overlay: ${bestStandalone.key} | Sharpe8h=${bestStandalone.overlaySharpe8h.toFixed(4)} annual=${bestStandalone.overlaySharpeAnnual.toFixed(3)}`,
);
console.log(
  `surrogate (calendar-reanchor stamps, INCREMENTAL): real incr=${bestIncr.incrementalSharpe8h.toFixed(5)} vs surr mean=${surrMeanIncr.toFixed(5)}, p=${surrogateP.toFixed(4)} (n=${surrIncr.length})`,
);
console.log(
  `surrogate (STANDALONE overlay): real Sharpe8h=${bestStandalone.overlaySharpe8h.toFixed(4)} vs fake-stamp mean=${surrStandaloneMean.toFixed(4)}, p=${surrogateStandaloneP.toFixed(4)} (n=${surrStandalone.length})`,
);
console.log(
  `DSR incremental: deflatedProb=${dsr.deflatedProbability.toFixed(4)} | standalone overlay deflatedProb=${dsrStandalone.deflatedProbability.toFixed(4)}`,
);
console.log(
  `block-bootstrap incr mean 95% CI: [${boot.lower.toExponential(3)}, ${boot.upper.toExponential(3)}] est=${boot.estimate.toExponential(3)}`,
);
console.log(`CPCV PBO=${pbo === null ? "n/a" : pbo.toFixed(3)}`);
console.log(
  `Harvey-Liu: incr t=${incrT.toFixed(2)}, pBonf=${pBonf.toExponential(3)}, haircut Sharpe8h=${haircutSharpe.toFixed(5)}`,
);
console.log(`monthly@$100k (incremental): $${result.monthlyAt100k}`);
console.log(`written ${OUT}`);
