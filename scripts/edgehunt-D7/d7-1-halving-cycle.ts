/**
 * D7.1 — Four-year halving cycle / post-halving drift.
 *
 * Strongest-honest version. Belief: be long BTC during the ~year after each
 * halving ("post-halving drift") beats buy-and-hold (B&H).
 *
 * RIGHT null for a calendar claim = calendar-reanchor: re-run the identical
 * rule on random FAKE halving anchors (4y-spaced lattice, randomly phased) and
 * measure how often the real anchors beat the fakes (surrogate p-value).
 *
 * KEY control = long-beta: the post-halving window inherits BTC's bull legs.
 * We report whether the windowed rule adds over "just being long" (mean daily
 * return inside vs outside window, and fraction of B&H captured) — the trap
 * that killed NA/ND ("long-beta sampled some of the time").
 *
 * Honest N = number of non-overlapping post-halving windows that actually fall
 * in-sample (the data-mining unit). DSR applied at that honest N.
 *
 * Reuses output/nf1/BTC_daily_ohlc.json (8.75y daily). $0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
} from "../../src/lib/training/statistical-validation";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-D7/d7-1-halving-cycle.json`;

interface Bar {
  date: string;
  close: number;
}

const bars: Bar[] = (
  JSON.parse(readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Bar[]
).filter((b) => Number.isFinite(b.close) && b.close > 0);

const dayMs = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const t0 = toMs(bars[0].date);
const tN = toMs(bars[bars.length - 1].date);

// Daily log returns aligned to bars[i] (return realized over [i-1, i]).
const ret: number[] = [];
const retMs: number[] = [];
for (let i = 1; i < bars.length; i += 1) {
  ret.push(Math.log(bars[i].close / bars[i - 1].close));
  retMs.push(toMs(bars[i].date));
}

// Known BTC halving dates (deterministic, PIT-clean).
const HALVINGS = ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"].map(toMs);
const WINDOW_DAYS = 365; // canonical "post-halving year"
const WINDOW_MS = WINDOW_DAYS * dayMs;

// Realistic cost: 6 bps per side round-trip on long<->flat transitions.
const COST_PER_SIDE = 0.0006;
const ANNUALIZE = Math.sqrt(365);

/** In-window mask for a given set of anchor timestamps. */
function inWindow(ms: number, anchors: number[]): boolean {
  for (const a of anchors) {
    if (ms >= a && ms < a + WINDOW_MS) return true;
  }
  return false;
}

/** Apply long-in-window / flat-out rule. Returns net daily return series + turnover count. */
function ruleReturns(anchors: number[]): { net: number[]; gross: number[]; turns: number; inDays: number } {
  const net: number[] = [];
  const gross: number[] = [];
  let prevPos = 0;
  let turns = 0;
  let inDays = 0;
  for (let i = 0; i < ret.length; i += 1) {
    const pos = inWindow(retMs[i], anchors) ? 1 : 0;
    if (pos !== prevPos) turns += 1;
    if (pos === 1) inDays += 1;
    const g = pos * ret[i];
    const c = pos !== prevPos ? COST_PER_SIDE : 0;
    gross.push(g);
    net.push(g - c);
    prevPos = pos;
  }
  return { net, gross, turns, inDays };
}

// --- Real rule ---
const real = ruleReturns(HALVINGS);
const realStats = summarizeReturnSeries(real.net);
const bhStats = summarizeReturnSeries(ret);

// Honest N: count post-halving windows that overlap the sample at all.
const honestWindows = HALVINGS.filter((a) => a + WINDOW_MS > t0 && a < tN).length;

// --- Long-beta control: does the window add over "just being long"? ---
// Mean daily return inside vs outside the real window (gross, no rule cost).
let inSum = 0,
  inCnt = 0,
  outSum = 0,
  outCnt = 0;
for (let i = 0; i < ret.length; i += 1) {
  if (inWindow(retMs[i], HALVINGS)) {
    inSum += ret[i];
    inCnt += 1;
  } else {
    outSum += ret[i];
    outCnt += 1;
  }
}
const inMean = inCnt ? inSum / inCnt : 0;
const outMean = outCnt ? outSum / outCnt : 0;
// Fraction of B&H total log-return captured by the in-window days.
const bhTotal = ret.reduce((s, r) => s + r, 0);
const inTotal = real.gross.reduce((s, r) => s + r, 0); // gross window log-return
const captureFrac = bhTotal !== 0 ? inTotal / bhTotal : 0;

// --- RIGHT NULL: calendar-reanchor ---
// Generate fake anchor sets that preserve the 4y-spaced lattice but are
// randomly phased across the whole timeline. Each fake set has the SAME number
// of anchors spaced ~4y apart; phase drawn uniformly. We score by net Sharpe.
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
const SPACING = 4 * 365.25 * dayMs;
const N_SURR = 5000;
const rng = mulberry32(12345);
const span = tN - t0;
let geCount = 0; // fake Sharpe >= real Sharpe
const surrSharpes: number[] = [];
for (let s = 0; s < N_SURR; s += 1) {
  // random phase: place a lattice of 4y-spaced anchors starting at a random
  // offset within the first spacing interval, covering the whole span.
  const phase = rng() * SPACING;
  const fake: number[] = [];
  for (let a = t0 - SPACING + phase; a < tN; a += SPACING) {
    if (a + WINDOW_MS > t0 && a < tN) fake.push(a);
  }
  if (fake.length === 0) continue;
  const fr = ruleReturns(fake);
  const fSharpe = summarizeReturnSeries(fr.net).sharpe;
  surrSharpes.push(fSharpe);
  if (fSharpe >= realStats.sharpe) geCount += 1;
}
const surrogateP = (geCount + 1) / (surrSharpes.length + 1);
const surrMean = surrSharpes.reduce((a, b) => a + b, 0) / surrSharpes.length;

// --- Deflated Sharpe at honest N (data-mining trials = candidate windows we
// could have picked: window length {0.5y,1y,1.5y,2y} x {long,flat} polarity x
// {post-halving, pre-halving} anchor = a conservatively small grid). We count
// the family we genuinely searched plus the surrogate multiplicity floor. ---
const honestTrials = Math.max(honestWindows, 8); // >= candidate-window family
const dsrDaily = computeDeflatedSharpeRatio(real.net, { trialCount: honestTrials });

// Block bootstrap CI on net compound return (monthly-ish blocks).
const bootstrap = blockBootstrapConfidenceInterval(real.net, {
  statistic: "compoundReturn",
  iterations: 2000,
  blockLength: 30,
  confidenceLevel: 0.95,
  seed: "d7-1",
});

const result = {
  hypothesis: "D7.1 four-year halving cycle / post-halving drift",
  sample: { start: bars[0].date, end: bars[bars.length - 1].date, days: ret.length },
  rule: { windowDays: WINDOW_DAYS, costPerSide: COST_PER_SIDE, turnoverEvents: real.turns, inWindowDays: real.inDays },
  honestN: honestWindows,
  honestTrials,
  performance: {
    ruleNetSharpe_annual: realStats.sharpe * ANNUALIZE,
    ruleNetSharpe_daily: realStats.sharpe,
    bhSharpe_annual: bhStats.sharpe * ANNUALIZE,
    ruleNetMeanDaily: realStats.mean,
    ruleNetCompound: realStats.compoundReturn,
    bhCompound: bhStats.compoundReturn,
  },
  longBetaControl: {
    inWindowMeanDaily: inMean,
    outWindowMeanDaily: outMean,
    inMinusOut: inMean - outMean,
    fractionOfBHCaptured: captureFrac,
    note: "If inMinusOut>0 but rule net Sharpe < B&H Sharpe, the 'edge' is just long-beta sampled part-time (NA/ND trap).",
  },
  rightNull_calendarReanchor: {
    surrogates: surrSharpes.length,
    realNetSharpe_daily: realStats.sharpe,
    surrogateMeanSharpe_daily: surrMean,
    fakeBeatsReal_count: geCount,
    surrogateP,
  },
  deflatedSharpe_daily: {
    sharpe: dsrDaily.sharpe,
    trialCount: dsrDaily.trialCount,
    expectedMaxSharpe: dsrDaily.expectedMaxSharpe,
    deflatedProbability: dsrDaily.deflatedProbability,
  },
  bootstrapCompoundCI: { lower: bootstrap.lower, estimate: bootstrap.estimate, upper: bootstrap.upper },
};

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
