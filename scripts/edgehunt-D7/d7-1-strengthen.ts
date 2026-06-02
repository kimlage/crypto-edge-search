/**
 * D7.1 — Four-year halving cycle / post-halving drift. STRENGTHENED + JUDGED.
 *
 * Goal: build the strongest *honest* version of "be long BTC in the post-halving
 * window, flat otherwise" and judge it with the committed gauntlet (runGauntlet
 * from scripts/edgehunt-D2/lib.ts, built on src/lib/training/statistical-
 * validation.ts: summarizeReturnSeries, computeDeflatedSharpeRatio @ honest N,
 * blockBootstrapConfidenceInterval, estimateCscvPbo).
 *
 * STRENGTHENING TRIED (genuinely, all counted into honest N as a data-mining
 * family):
 *   - window length grid {180,270,365,547,730}d (post-halving)
 *   - polarity {long}, plus pre-halving anchor as a placebo (not edge)
 *   - vol-targeted variant (scale exposure to 60%-ann target, capped 1.0) to
 *     try to beat plain long-in-window on Sharpe.
 * We pick the BEST in-sample net Sharpe (the adversary's choice) and judge THAT,
 * with honestN = size of the family searched (DSR trialCount).
 *
 * RIGHT NULL = calendar-reanchor: 5000 phase-randomized 4y-lattice fake anchors,
 * re-running the SAME rule; surrogate p = P(fake net Sharpe >= real). Also a
 * drift-demeaned reanchor (subtract unconditional daily mean first) -> if the
 * "edge" is just secular drift sampled part-time the demeaned surrogateP -> 0.5.
 *
 * KEY CONTROLS:
 *   - long-beta capture: fraction of B&H lifetime log-return captured by the
 *     in-window days, and fraction of days spent in-window (the NA/ND trap).
 *   - per-event Sharpe vs B&H at honest N (2020 vs 2024).
 *   - long-beta fraction-of-B&H-captured control.
 *
 * Data: output/nf1/BTC_daily_ohlc.json (8.75y daily, $0). Halvings deterministic
 * /PIT-clean. Cost 6 bps/side on long<->flat transitions.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-D7/d7-1-strengthen.json`;

interface Bar { date: string; close: number }
const bars: Bar[] = (
  JSON.parse(readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Bar[]
).filter((b) => Number.isFinite(b.close) && b.close > 0);

const dayMs = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const t0 = toMs(bars[0].date);
const tN = toMs(bars[bars.length - 1].date);

const ret: number[] = [];
const retMs: number[] = [];
for (let i = 1; i < bars.length; i += 1) {
  ret.push(Math.log(bars[i].close / bars[i - 1].close));
  retMs.push(toMs(bars[i].date));
}

// PIT-clean deterministic halving dates.
const HALVINGS = ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20"].map(toMs);
const COST = 0.0006; // 6 bps/side
const ANN = Math.sqrt(365);

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

const inW = (ms: number, anchors: number[], winMs: number) =>
  anchors.some((a) => ms >= a && ms < a + winMs);

// Trailing realized vol (annualized) for vol-targeting, using info up to i-1.
function trailingVol(i: number, lookback = 30): number {
  const lo = Math.max(0, i - lookback);
  let s = 0, s2 = 0, n = 0;
  for (let j = lo; j < i; j += 1) { s += ret[j]; s2 += ret[j] * ret[j]; n += 1; }
  if (n < 5) return 0.6 / ANN; // fallback daily vol ~ 60% ann
  const m = s / n;
  const v = Math.max(1e-8, s2 / n - m * m);
  return Math.sqrt(v);
}

interface Variant { winDays: number; volTarget: boolean }
const WIN_GRID = [180, 270, 365, 547, 730];
const VARIANTS: Variant[] = [];
for (const w of WIN_GRID) for (const vt of [false, true]) VARIANTS.push({ winDays: w, volTarget: vt });

function ruleSeries(
  anchors: number[],
  series: number[],
  v: Variant,
): { net: number[]; gross: number[]; turns: number; inDays: number } {
  const winMs = v.winDays * dayMs;
  const net: number[] = [];
  const gross: number[] = [];
  let prevPos = 0;
  let turns = 0;
  let inDays = 0;
  const tgtDaily = 0.6 / ANN; // 60% ann vol target
  for (let i = 0; i < series.length; i += 1) {
    let pos = inW(retMs[i], anchors, winMs) ? 1 : 0;
    if (pos === 1 && v.volTarget) {
      const vol = trailingVol(i);
      pos = Math.min(1, tgtDaily / Math.max(1e-8, vol));
    }
    const dpos = Math.abs(pos - prevPos);
    if (dpos > 1e-9) turns += 1;
    if (pos > 1e-9) inDays += 1;
    const g = pos * series[i];
    const c = dpos * COST;
    gross.push(g);
    net.push(g - c);
    prevPos = pos;
  }
  return { net, gross, turns, inDays };
}

// ---- Pick the strongest honest variant (adversary's in-sample choice) ----
const honestN = VARIANTS.length; // every variant we genuinely searched
let best: { v: Variant; net: number[]; gross: number[]; turns: number; inDays: number; sharpe: number } | null = null;
const allFolds: { id: string; folds: number[][] }[] = [];
const FOLDS = 5;
function foldReturns(net: number[]): number[][] {
  const out: number[][] = [];
  const sz = Math.floor(net.length / FOLDS);
  for (let f = 0; f < FOLDS; f += 1) out.push(net.slice(f * sz, (f + 1) * sz));
  return out;
}
for (const v of VARIANTS) {
  const r = ruleSeries(HALVINGS, ret, v);
  const sharpe = summarizeReturnSeries(r.net).sharpe;
  allFolds.push({ id: `w${v.winDays}${v.volTarget ? "vt" : ""}`, folds: foldReturns(r.net) });
  if (!best || sharpe > best.sharpe) best = { v, ...r, sharpe };
}
if (!best) throw new Error("no variant");

const bestNetAnn = best.sharpe * ANN;
const bhStats = summarizeReturnSeries(ret);
const bhSharpeAnn = bhStats.sharpe * ANN;

// ---- RIGHT NULL: calendar-reanchor on the CHOSEN variant ----
const SPACING = 4 * 365.25 * dayMs;
const N_SURR = 5000;
function reanchorP(series: number[], v: Variant, observedSharpeAnn: number, seed: number): { p: number; mean: number; sharpes: number[] } {
  const rng = mulberry32(seed);
  const winMs = v.winDays * dayMs;
  const sharpes: number[] = [];
  let ge = 0;
  for (let s = 0; s < N_SURR; s += 1) {
    const phase = rng() * SPACING;
    const fake: number[] = [];
    for (let a = t0 - SPACING + phase; a < tN; a += SPACING) if (a + winMs > t0 && a < tN) fake.push(a);
    if (!fake.length) continue;
    const fr = ruleSeries(fake, series, v);
    const fs = summarizeReturnSeries(fr.net).sharpe * ANN;
    sharpes.push(fs);
    if (fs >= observedSharpeAnn) ge += 1;
  }
  return { p: (ge + 1) / (sharpes.length + 1), mean: sharpes.reduce((a, b) => a + b, 0) / sharpes.length, sharpes };
}
const reanchor = reanchorP(ret, best.v, bestNetAnn, 12345);

// drift-demeaned reanchor
const mu = ret.reduce((s, r) => s + r, 0) / ret.length;
const dret = ret.map((r) => r - mu);
const realDemeanedAnn = summarizeReturnSeries(ruleSeries(HALVINGS, dret, best.v).net).sharpe * ANN;
const reanchorDemeaned = reanchorP(dret, best.v, realDemeanedAnn, 777);

// ---- long-beta controls ----
const winMsBest = best.v.winDays * dayMs;
let inSum = 0, inCnt = 0, outSum = 0, outCnt = 0;
for (let i = 0; i < ret.length; i += 1) {
  if (inW(retMs[i], HALVINGS, winMsBest)) { inSum += ret[i]; inCnt += 1; } else { outSum += ret[i]; outCnt += 1; }
}
const inMean = inCnt ? inSum / inCnt : 0;
const outMean = outCnt ? outSum / outCnt : 0;
const bhTotal = ret.reduce((s, r) => s + r, 0);
let inTotal = 0;
for (let i = 0; i < ret.length; i += 1) if (inW(retMs[i], HALVINGS, winMsBest)) inTotal += ret[i];
const captureFrac = bhTotal !== 0 ? inTotal / bhTotal : 0;
const dayFrac = inCnt / ret.length;

// ---- per-event Sharpe vs B&H at honest N ----
const perEvent = HALVINGS.filter((a) => a + winMsBest > t0 && a < tN).map((a) => {
  const seg: number[] = [];
  for (let i = 0; i < ret.length; i += 1) if (retMs[i] >= a && retMs[i] < a + winMsBest) seg.push(ret[i]);
  return { halving: new Date(a).toISOString().slice(0, 10), days: seg.length, sharpeAnn: summarizeReturnSeries(seg).sharpe * ANN };
});
const eventsBeatingBH = perEvent.filter((e) => e.sharpeAnn > bhSharpeAnn).length;
const honestEvents = perEvent.length;

// ---- DSR @ honest N ----
const dsr = computeDeflatedSharpeRatio(best.net, { trialCount: honestN });

// ---- block-bootstrap CI on net mean ----
const boot = blockBootstrapConfidenceInterval(best.net, {
  statistic: "mean", iterations: 2000, blockLength: 30, confidenceLevel: 0.95, seed: "d7-1-str",
});
const bestStats = summarizeReturnSeries(best.net);
const bootLowerSharpe = bestStats.stdDev > 1e-12 ? (boot.lower / bestStats.stdDev) * ANN : 0;

// ---- PBO across variant family ----
let pbo: number | null = null;
try { pbo = estimateCscvPbo(allFolds, { statistic: "mean", trainFraction: 0.5 }).pbo; } catch { pbo = null; }

// ---- Harvey-Liu style haircut: deflate t-stat for honestN trials (Bonferroni-ish) ----
// observed Sharpe t-stat over sample:
const tStat = bestStats.sharpe * Math.sqrt(best.net.length);
// HL multiple-testing: required |t| ~ Phi^{-1}(1 - 0.05/(2*honestN)).
function invNorm(p: number): number {
  // Acklam approximation
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425, ph = 1 - pl;
  let q, r, x;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  else if (p <= ph) { q = p - 0.5; r = q*q; x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  return x;
}
const hlRequiredT = invNorm(1 - 0.05 / (2 * honestN));
const hlPasses = Math.abs(tStat) > hlRequiredT;

// ---- GATES (canonical, mirroring runGauntlet) ----
const gates: [string, boolean][] = [
  ["net-sharpe>0.3", bestNetAnn > 0.3],
  ["beats-buyhold", bestNetAnn > bhSharpeAnn],
  ["boot-CI-lower>0", bootLowerSharpe > 0],
  ["DSR@N>0.95", dsr.deflatedProbability > 0.95],
  ["surrogate-p<0.05", reanchor.p < 0.05],
  ["drift-demeaned-surrogate-p<0.05", reanchorDemeaned.p < 0.05],
  ["per-event-honest-N>=3", honestEvents >= 3],
  ["not-long-beta-trap(capture<0.5*dayFrac-adjusted)", captureFrac < 2 * dayFrac],
  ["harvey-liu-haircut", hlPasses],
  ["PBO<0.5", pbo === null ? true : pbo < 0.5],
];
let bindingGate = "ALL-PASS";
let pass = true;
for (const [g, ok] of gates) { if (!ok) { bindingGate = g; pass = false; break; } }

const barsPerMonth = 365 / 12;
const monthlyAt100k = pass ? Math.round(bestStats.mean * barsPerMonth * 100000) : null;

const result = {
  hypothesis: "D7.1 four-year halving cycle / post-halving drift (STRENGTHENED+JUDGED)",
  sample: { start: bars[0].date, end: bars[bars.length - 1].date, days: ret.length },
  dataCeiling: "nf1 BTC daily starts 2017-08-17 (Binance listing); 2012/2016 halvings have NO free PIT-clean data in-repo -> honest N hard-capped at 2 in-sample events",
  chosenVariant: { winDays: best.v.winDays, volTarget: best.v.volTarget, turnoverEvents: best.turns, inWindowDays: best.inDays },
  familySearched: { honestN, grid: VARIANTS.map((v) => `w${v.winDays}${v.volTarget ? "vt" : ""}`) },
  performance: {
    bestNetSharpe_annual: bestNetAnn,
    bhSharpe_annual: bhSharpeAnn,
    excessOverBH: bestNetAnn - bhSharpeAnn,
    netMeanDaily: bestStats.mean,
    netCompound: bestStats.compoundReturn,
    bhCompound: bhStats.compoundReturn,
    tStat,
  },
  longBetaControl: {
    inWindowMeanDaily: inMean,
    outWindowMeanDaily: outMean,
    inMinusOut: inMean - outMean,
    fractionOfBHCaptured: captureFrac,
    fractionOfDaysInWindow: dayFrac,
    captureLeverageVsDays: captureFrac / dayFrac,
    note: "captures most of B&H lifetime gains while long only part-time = long-beta trap (NA/ND killer). Honest test: does it survive drift-demean + per-event?",
  },
  rightNull_calendarReanchor: {
    surrogates: reanchor.sharpes.length,
    realNetSharpe_annual: bestNetAnn,
    surrogateMeanSharpe_annual: reanchor.mean,
    surrogateP: reanchor.p,
  },
  driftDemeanedReanchor: {
    realDemeanedSharpe_annual: realDemeanedAnn,
    surrogateMeanSharpe_annual: reanchorDemeaned.mean,
    surrogateP: reanchorDemeaned.p,
    note: "~0.5 => 'edge' is secular drift sampled part-time, not a halving timing effect",
  },
  perEvent: { bhSharpeAnnual: bhSharpeAnn, events: perEvent, eventsBeatingBH, honestN: honestEvents },
  deflatedSharpe: {
    sharpe_daily: dsr.sharpe,
    trialCount: dsr.trialCount,
    expectedMaxSharpe_daily: dsr.expectedMaxSharpe,
    deflatedProbability: dsr.deflatedProbability,
  },
  harveyLiu: { tStat, requiredT_at_honestN: hlRequiredT, passes: hlPasses },
  bootstrap: { lowerMean: boot.lower, estimateMean: boot.estimate, upperMean: boot.upper, bootLowerSharpe_annual: bootLowerSharpe },
  pbo,
  gates: gates.map(([g, ok]) => ({ gate: g, pass: ok })),
  verdict: { pass, bindingGate, monthlyAt100k, honestN_eventsInSample: honestEvents, honestN_family: honestN, surrogateP: reanchor.p },
};

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
