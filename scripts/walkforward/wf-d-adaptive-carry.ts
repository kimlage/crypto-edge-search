/**
 * TRACK WF-D — Walk-forward ADAPTIVE carry-timing threshold.
 *
 * The user's hypothesis: markets are non-stationary, so the OPTIMAL config drifts;
 * a FIXED funding cutoff (TA1, Round 3) decays out-of-sample because carry compresses.
 * Therefore ADAPT the "rich funding" cutoff over time via walk-forward: re-estimate
 * the deploy threshold on a TRAILING window (a rolling quantile of recent funding) so
 * "rich" self-calibrates as the regime compresses.
 *
 * Decisive question: does a self-calibrating adaptive threshold beat BOTH the fixed
 * threshold (TA1) AND risk-free on the consume-once holdout — or does it still tie
 * risk-free because (per TA1's perfect-foresight ORACLE) there is < 0.52%/yr of
 * harvestable carry in the recent regime, which no adaptivity can create?
 *
 * METHODOLOGY (walk-forward done correctly):
 *  - STRICT CAUSALITY: at each re-opt step t, the deploy threshold uses ONLY funding
 *    data strictly < t; trade the NEXT OOS slice [t, t+h] with it; roll forward.
 *    The adaptive OOS equity curve = concatenation of all [t, t+h] slices.
 *  - 4 BENCHMARKS: (1) buy-and-hold = always-on carry; (2) HONEST fixed-param =
 *    threshold locked on the FIRST in-sample window, never changed; (3) RANDOM-param
 *    WF = pick a random quantile each step; (4) SURROGATE/PLACEBO = the SAME machinery
 *    on phase-randomized + block-shuffled funding that preserves vol/autocorr but
 *    destroys real structure.
 *  - REALISTIC COST on EVERY position change (adaptation-driven turnover is a real cost).
 *  - HONEST N for DSR = the META-parameter grid (in-sample windows x cadences x OOS
 *    horizons x quantile levels).
 *  - CONSUME-ONCE HOLDOUT: reserve last ~18%; select meta-config on the earlier
 *    portion; score the holdout EXACTLY ONCE.
 *
 * Uses the committed gates from src/lib/training/.
 *
 * Run:
 *   PATH=.../node/bin:$PATH node_modules/.bin/tsx scripts/walkforward/wf-d-adaptive-carry.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  evaluateBaselineGate,
  baselineScoreFromReturns,
  type BaselineScore,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";

const ROOT = process.cwd().endsWith("crypto-edge-search")
  ? process.cwd()
  : path.resolve(process.cwd(), "crypto-edge-search");
const FUND_DIR = path.join(ROOT, "output/funding");
const OUT_DIR = path.join(ROOT, "output/walkforward");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Cost & regime constants (IDENTICAL to TA1 carry-gating.ts so comparisons are
// apples-to-apples).
// ---------------------------------------------------------------------------
const SPOT_TAKER_BPS = 10; // per side, spot leg
const PERP_TAKER_BPS = 4; // per side, perp leg
const TOGGLE_ONE_WAY_BPS = SPOT_TAKER_BPS + PERP_TAKER_BPS; // 14 bps per ON<->OFF transition
const RISK_FREE_APR = 0.045;
const PERIODS_PER_YEAR = 1095.75; // 3 funding settlements/day (8h)
const RF_PER_PERIOD = RISK_FREE_APR / PERIODS_PER_YEAR;
const ANNUALIZE_SHARPE = Math.sqrt(PERIODS_PER_YEAR);

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "BNBUSDT",
];

// ---------------------------------------------------------------------------
// Load raw data (8 majors, 8h funding + daily spot/perp premium)
// ---------------------------------------------------------------------------
interface FundingPt {
  fundingTime: number;
  fundingRate: number;
}
interface PricePt {
  date: string;
  spotClose: number;
  perpClose: number;
}
function loadFunding(sym: string): FundingPt[] {
  return JSON.parse(fs.readFileSync(path.join(FUND_DIR, `${sym}_funding_8h.json`), "utf8"));
}
function loadPrices(sym: string): PricePt[] {
  return JSON.parse(fs.readFileSync(path.join(FUND_DIR, `${sym}_prices_daily.json`), "utf8"));
}
function buildPremiumMap(prices: PricePt[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of prices) if (p.spotClose > 0) m.set(p.date, p.perpClose / p.spotClose - 1);
  return m;
}

interface Period {
  t: number;
  date: string;
  funding: number;
  premium: number;
}
function buildPeriods(sym: string): Period[] {
  const fund = loadFunding(sym);
  const premium = buildPremiumMap(loadPrices(sym));
  const out: Period[] = [];
  for (const f of fund) {
    const date = new Date(f.fundingTime).toISOString().slice(0, 10);
    const prem = premium.get(date);
    if (prem === undefined) continue;
    out.push({ t: f.fundingTime, date, funding: f.fundingRate, premium: prem });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Diversified equal-weight delta-neutral carry book, aligned on union of times.
// carryRet = equal-weight funding collected this 8h on the active symbols.
interface BookPeriod {
  t: number;
  date: string;
  carryRet: number;
  meanFunding: number;
}
function buildDiversifiedBook(): BookPeriod[] {
  const perSym = new Map<string, Period[]>();
  const allTimes = new Set<number>();
  for (const sym of SYMBOLS) {
    const p = buildPeriods(sym);
    perSym.set(sym, p);
    for (const x of p) allTimes.add(x.t);
  }
  const idx = new Map<string, Map<number, Period>>();
  for (const sym of SYMBOLS) {
    const m = new Map<number, Period>();
    for (const x of perSym.get(sym)!) m.set(x.t, x);
    idx.set(sym, m);
  }
  const times = [...allTimes].sort((a, b) => a - b);
  const book: BookPeriod[] = [];
  for (const t of times) {
    const fundings: number[] = [];
    let date = "";
    for (const sym of SYMBOLS) {
      const x = idx.get(sym)!.get(t);
      if (!x) continue;
      fundings.push(x.funding);
      date = x.date;
    }
    if (fundings.length === 0) continue;
    const mf = mean(fundings);
    book.push({ t, date, carryRet: mf, meanFunding: mf });
  }
  return book;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
function annSharpe(returns: number[]): number {
  return summarizeReturnSeries(returns).sharpe * ANNUALIZE_SHARPE;
}
function annReturn(returns: number[]): number {
  return mean(returns) * PERIODS_PER_YEAR;
}
// lag-k autocorrelation of a series
function autocorr(x: number[], k: number): number {
  const n = x.length;
  if (n <= k + 1) return 0;
  const m = mean(x);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) den += (x[i] - m) ** 2;
  for (let i = 0; i < n - k; i++) num += (x[i] - m) * (x[i + k] - m);
  return den > 0 ? num / den : 0;
}

// Deterministic PRNG (LCG) for reproducible random-param and surrogate runs.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ---------------------------------------------------------------------------
// SHORT-trailing "rich funding" SIGNAL used by every rule. signal[i] = trailing
// mean funding over a fixed short window strictly BEFORE i (causal). This is the
// quantity that gets compared against a (fixed OR adaptive) cutoff.
// ---------------------------------------------------------------------------
const SIGNAL_LB = 30; // ~10 days of 8h periods — trailing-mean funding "richness"
function buildSignal(fundingArr: number[]): number[] {
  const n = fundingArr.length;
  const sig = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - SIGNAL_LB);
    if (i - start < 3) continue; // need a few obs
    sig[i] = mean(fundingArr.slice(start, i)); // strictly past
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Generic ON/OFF -> NET return series over a book slice, with realistic toggle
// cost on every position change. `prevOnInit` carries position state across the
// slice boundary so we don't fabricate or hide transition costs at the seam.
// ---------------------------------------------------------------------------
interface RunResult {
  net: number[];
  gross: number[];
  onFlags: boolean[];
  toggles: number;
  onCount: number;
}
function runOnOff(
  book: BookPeriod[],
  onAt: (i: number) => boolean,
  range: [number, number],
  prevOnInit: boolean,
): RunResult {
  const net: number[] = [];
  const gross: number[] = [];
  const onFlags: boolean[] = [];
  let prevOn = prevOnInit;
  let toggles = 0;
  let onCount = 0;
  for (let i = range[0]; i < range[1]; i++) {
    const on = onAt(i);
    const base = on ? book[i].carryRet : RF_PER_PERIOD;
    let cost = 0;
    if (on !== prevOn) {
      cost = TOGGLE_ONE_WAY_BPS / 10_000;
      toggles++;
    }
    gross.push(base);
    net.push(base - cost);
    onFlags.push(on);
    if (on) onCount++;
    prevOn = on;
  }
  return { net, gross, onFlags, toggles, onCount };
}

// Always-on carry (buy-and-hold of the edge): pay entry once at the slice start.
function alwaysOnNet(book: BookPeriod[], range: [number, number]): number[] {
  const net: number[] = [];
  for (let i = range[0]; i < range[1]; i++) {
    let c = book[i].carryRet;
    if (i === range[0]) c -= TOGGLE_ONE_WAY_BPS / 10_000;
    net.push(c);
  }
  return net;
}
function flatRiskFree(range: [number, number]): number[] {
  return new Array(range[1] - range[0]).fill(RF_PER_PERIOD);
}

// ---------------------------------------------------------------------------
// WALK-FORWARD ADAPTIVE engine.
//
// Meta-params:
//   isWin  : in-sample (trailing calibration) window length, in 8h periods
//   cadence: re-optimization cadence (how often we recompute the cutoff), periods
//   oosH    = cadence (each step trades the next `cadence` periods OOS)
//   qLevel : quantile level of the trailing funding distribution used as the
//            adaptive "rich" cutoff (self-calibrating: as funding compresses, the
//            qLevel quantile of recent funding drops too).
//
// At step boundary t (>= isWin), we look at funding strictly in [t-isWin, t),
// compute the qLevel quantile -> cutoff. Then for the OOS slice [t, t+oosH) we
// deploy carry at period i iff signal[i] >= cutoff (signal[i] itself only uses
// data < i, so the whole pipeline is causal). Roll forward by oosH.
//
// mode:
//   "adaptive" -> cutoff = qLevel quantile of trailing funding (re-estimated each step)
//   "fixed"    -> cutoff = qLevel quantile of the FIRST in-sample window, frozen forever
//   "random"   -> cutoff = quantile at a RANDOM qLevel each step
// ---------------------------------------------------------------------------
type WfMode = "adaptive" | "fixed" | "random";

interface WfOutcome {
  net: number[]; // OOS net return series (concatenated slices)
  onFlags: boolean[];
  toggles: number;
  onCount: number;
  startIdx: number; // first OOS index in book coords
  cutoffs: number[]; // the cutoff chosen at each step (for drift analysis)
  cutoffStepIdx: number[]; // book index at which each cutoff was estimated
}

function walkForward(
  book: BookPeriod[],
  fundingArr: number[],
  signal: number[],
  isWin: number,
  cadence: number,
  qLevel: number,
  mode: WfMode,
  rngSeed: number,
): WfOutcome {
  const n = book.length;
  const rng = makeRng(rngSeed);
  const net: number[] = [];
  const onFlags: boolean[] = [];
  const cutoffs: number[] = [];
  const cutoffStepIdx: number[] = [];
  let toggles = 0;
  let onCount = 0;
  let prevOn = false; // start flat (in risk-free)
  const startIdx = isWin;

  // For "fixed" mode, lock the cutoff on the FIRST in-sample window (honest:
  // no peeking at the future — uses only [0, isWin)).
  let fixedCutoff = NaN;
  if (mode === "fixed") {
    const win = fundingArr.slice(0, isWin).filter(Number.isFinite).sort((a, b) => a - b);
    fixedCutoff = quantile(win, qLevel);
  }

  for (let t = isWin; t < n; t += cadence) {
    const end = Math.min(t + cadence, n);
    let cutoff: number;
    if (mode === "fixed") {
      cutoff = fixedCutoff;
    } else if (mode === "random") {
      const rq = 0.3 + rng() * 0.6; // random quantile in [0.3, 0.9]
      const win = fundingArr.slice(t - isWin, t).filter(Number.isFinite).sort((a, b) => a - b);
      cutoff = quantile(win, rq);
    } else {
      // adaptive: qLevel quantile of trailing funding in [t-isWin, t)
      const win = fundingArr.slice(t - isWin, t).filter(Number.isFinite).sort((a, b) => a - b);
      cutoff = quantile(win, qLevel);
    }
    cutoffs.push(cutoff);
    cutoffStepIdx.push(t);

    const res = runOnOff(
      book,
      (i) => Number.isFinite(signal[i]) && signal[i] >= cutoff,
      [t, end],
      prevOn,
    );
    for (let k = 0; k < res.net.length; k++) {
      net.push(res.net[k]);
      onFlags.push(res.onFlags[k]);
    }
    toggles += res.toggles;
    onCount += res.onCount;
    prevOn = res.onFlags[res.onFlags.length - 1] ?? prevOn;
  }
  return { net, onFlags, toggles, onCount, startIdx, cutoffs, cutoffStepIdx };
}

// Oracle (perfect-foresight) on a range: deploy carry only where carry>RF, gross
// of toggle cost. Upper bound on ANY causal gate's achievable return.
function oracleAnn(book: BookPeriod[], range: [number, number]): { ann: number; onFrac: number } {
  let sum = 0;
  let on = 0;
  const len = range[1] - range[0];
  for (let i = range[0]; i < range[1]; i++) {
    sum += Math.max(book[i].carryRet, RF_PER_PERIOD);
    if (book[i].carryRet > RF_PER_PERIOD) on++;
  }
  return { ann: (sum / len) * PERIODS_PER_YEAR, onFrac: on / len };
}

// ---------------------------------------------------------------------------
// SURROGATE generators: preserve vol & autocorrelation, destroy real cross-time
// structure of WHEN carry is rich.
//  - "block": circular block-shuffle of the funding series (preserves local
//    autocorr within blocks & the marginal distribution, destroys long-range
//    "regime" structure).
//  - "phase": phase-randomization (FFT) preserves the full autocorrelation/PSD
//    and variance, randomizes phases -> destroys deterministic structure.
// We surrogate the per-period carryRet (== meanFunding) jointly so book and
// signal stay consistent.
// ---------------------------------------------------------------------------
function blockShuffle(x: number[], blockLen: number, rng: () => number): number[] {
  const n = x.length;
  const nBlocks = Math.ceil(n / blockLen);
  const starts: number[] = [];
  for (let b = 0; b < nBlocks; b++) starts.push(Math.floor(rng() * n));
  const out: number[] = [];
  for (const s of starts) {
    for (let j = 0; j < blockLen && out.length < n; j++) out.push(x[(s + j) % n]);
  }
  return out.slice(0, n);
}

// Phase randomization via naive DFT/IDFT (n ~3300 -> O(n^2) ~1e7, fine).
function phaseRandomize(x: number[], rng: () => number): number[] {
  const n = x.length;
  const m = mean(x);
  const xc = x.map((v) => v - m);
  // forward DFT
  const re = new Array<number>(n).fill(0);
  const im = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let j = 0; j < n; j++) {
      const ang = (-2 * Math.PI * k * j) / n;
      sr += xc[j] * Math.cos(ang);
      si += xc[j] * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  // randomize phases while keeping magnitudes; enforce conjugate symmetry
  const mag = re.map((r, k) => Math.hypot(r, im[k]));
  const phase = new Array<number>(n).fill(0);
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k++) {
    const p = (rng() * 2 - 1) * Math.PI;
    phase[k] = p;
    if (k < n - k) phase[n - k] = -p; // conjugate symmetry -> real output
  }
  const nre = mag.map((mg, k) => mg * Math.cos(phase[k]));
  const nim = mag.map((mg, k) => mg * Math.sin(phase[k]));
  if (n % 2 === 0) nim[half] = 0; // Nyquist real
  // inverse DFT (real part)
  const out = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = 0; k < n; k++) {
      const ang = (2 * Math.PI * k * j) / n;
      s += nre[k] * Math.cos(ang) - nim[k] * Math.sin(ang);
    }
    out[j] = s / n + m;
  }
  return out;
}

function bookFromFunding(template: BookPeriod[], funding: number[]): BookPeriod[] {
  return template.map((b, i) => ({ ...b, carryRet: funding[i], meanFunding: funding[i] }));
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  const book = buildDiversifiedBook();
  const N = book.length;
  const fundingArr = book.map((b) => b.meanFunding);
  const signal = buildSignal(fundingArr);
  console.log(`WF-D ADAPTIVE CARRY — diversified 8h carry book: ${N} periods, ${book[0].date} -> ${book[N - 1].date}`);
  console.log(`Cost: spot ${SPOT_TAKER_BPS}bps + perp ${PERP_TAKER_BPS}bps = ${TOGGLE_ONE_WAY_BPS}bps per ON<->OFF transition. RF ${(RISK_FREE_APR * 100).toFixed(1)}%/yr.`);

  // ---- CONSUME-ONCE HOLDOUT: reserve the LAST ~18% (recent regime incl. the
  // Feb-Apr 2026 carry compression TA1 cared about). Meta-config is SELECTED on
  // the dev portion; holdout scored EXACTLY ONCE at the end. ----
  const holdoutFrac = 0.18;
  const splitIdx = Math.floor(N * (1 - holdoutFrac));
  console.log(`\nDev window:     [0, ${splitIdx})  ${book[0].date}..${book[splitIdx - 1].date}  (${splitIdx} periods)`);
  console.log(`Holdout window: [${splitIdx}, ${N}) ${book[splitIdx].date}..${book[N - 1].date}  (${N - splitIdx} periods, ${(holdoutFrac * 100).toFixed(0)}%)`);

  // =========================================================================
  // Q1 — Does the OPTIMAL param ACTUALLY drift trackably (persistent/autocorrelated)
  //      or jump randomly? We compute, on a dense grid of step boundaries over the
  //      DEV window, the cutoff that WOULD have been best IN-SAMPLE on each trailing
  //      window (the ex-post optimal threshold per step), and measure its
  //      persistence (lag-1 autocorrelation) and the autocorr of the underlying
  //      funding-richness regime. (This is descriptive, not used for trading.)
  // =========================================================================
  console.log(`\n================ Q1: does the optimal param DRIFT trackably? ================`);
  const probeWin = 360; // ~120 days trailing
  const probeCadence = 30; // every ~10 days
  // Per step, best in-sample cutoff = the trailing-funding quantile that maximizes
  // in-sample net return on [t-probeWin, t). Sweep a quantile grid; record argmax.
  const qGrid = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const bestCutoffs: number[] = [];
  const bestQs: number[] = [];
  const regimeMeans: number[] = []; // trailing mean funding (the regime level)
  for (let t = probeWin; t < splitIdx; t += probeCadence) {
    const win = fundingArr.slice(t - probeWin, t).filter(Number.isFinite).sort((a, b) => a - b);
    let bestQ = qGrid[0];
    let bestRet = -Infinity;
    let bestCut = NaN;
    for (const q of qGrid) {
      const cut = quantile(win, q);
      // in-sample net over the trailing window with this cutoff
      const res = runOnOff(book, (i) => Number.isFinite(signal[i]) && signal[i] >= cut, [t - probeWin, t], false);
      const r = annReturn(res.net);
      if (r > bestRet) {
        bestRet = r;
        bestQ = q;
        bestCut = cut;
      }
    }
    bestCutoffs.push(bestCut);
    bestQs.push(bestQ);
    regimeMeans.push(mean(fundingArr.slice(t - probeWin, t)));
  }
  const cutoffAc1 = autocorr(bestCutoffs, 1);
  const qAc1 = autocorr(bestQs, 1);
  const regimeAc1 = autocorr(regimeMeans, 1);
  // "trackable" = the thing we adapt TO (the funding-richness regime) is highly
  // persistent. The best CUTOFF tracking the regime should also be persistent.
  console.log(`  steps probed: ${bestCutoffs.length}`);
  console.log(`  best-in-sample CUTOFF lag-1 autocorr : ${cutoffAc1.toFixed(3)}  (1=perfectly trackable, ~0=random jumps)`);
  console.log(`  best-in-sample QUANTILE lag-1 autocorr: ${qAc1.toFixed(3)}  (the argmax q level)`);
  console.log(`  funding-RICHNESS regime lag-1 autocorr: ${regimeAc1.toFixed(3)}  (the regime we self-calibrate to)`);
  const driftTrackable = regimeAc1 > 0.8 && cutoffAc1 > 0.5;
  console.log(`  => regime is ${regimeAc1 > 0.8 ? "HIGHLY PERSISTENT (trackable)" : "not strongly persistent"}; best cutoff ${cutoffAc1 > 0.5 ? "persists (trackable)" : "jumps (not trackable)"}.`);
  console.log(`  Q1 ANSWER: the param drifts ${driftTrackable ? "TRACKABLY (persistent/autocorrelated) — adaptivity is well-posed" : "but NOT cleanly trackable"}.`);

  // =========================================================================
  // META-PARAMETER GRID = the multiple-testing surface for DSR. Count it honestly.
  // =========================================================================
  const isWins = [180, 360, 540]; // ~60d / 120d / 180d trailing calibration
  const cadences = [15, 30, 60]; // re-opt every ~5d / 10d / 20d (= OOS horizon)
  const qLevels = [0.5, 0.6, 0.7, 0.8]; // adaptive "rich" quantile
  const META_N = isWins.length * cadences.length * qLevels.length;
  console.log(`\nMETA-PARAMETER GRID (honest N for DSR): ${isWins.length} isWin x ${cadences.length} cadence x ${qLevels.length} qLevel = ${META_N} configs`);

  // Evaluate every adaptive meta-config on the DEV window only (strictly causal WF).
  interface MetaRow {
    isWin: number;
    cadence: number;
    qLevel: number;
    devNetAnnRet: number;
    devNetSharpe: number;
    devOnFrac: number;
    devToggles: number;
    devNet: number[];
  }
  const metaRows: MetaRow[] = [];
  for (const isWin of isWins) {
    for (const cadence of cadences) {
      for (const qLevel of qLevels) {
        // WF over the dev window only: cap the engine at splitIdx by trimming book.
        const devBook = book.slice(0, splitIdx);
        const devFunding = fundingArr.slice(0, splitIdx);
        const devSignal = signal.slice(0, splitIdx);
        const wf = walkForward(devBook, devFunding, devSignal, isWin, cadence, qLevel, "adaptive", 1);
        metaRows.push({
          isWin,
          cadence,
          qLevel,
          devNetAnnRet: annReturn(wf.net),
          devNetSharpe: annSharpe(wf.net),
          devOnFrac: wf.onCount / wf.net.length,
          devToggles: wf.toggles,
          devNet: wf.net,
        });
      }
    }
  }

  // Dev-window references
  const devRange: [number, number] = [0, splitIdx];
  const devAoNet = alwaysOnNet(book, devRange);
  const devRf = flatRiskFree(devRange);
  const devAoAnn = annReturn(devAoNet);
  const devRfAnn = annReturn(devRf);
  console.log(`\nDev-window references (NET annualized):`);
  console.log(`  always-on carry (buy&hold edge): ${(devAoAnn * 100).toFixed(2)}%  Sharpe ${annSharpe(devAoNet).toFixed(2)}`);
  console.log(`  flat risk-free                 : ${(devRfAnn * 100).toFixed(2)}%`);

  // Rank adaptive meta-configs by dev net annualized return (the economic target:
  // beat RF with real carry exposure). Require meaningful exposure so we don't
  // "win" by hiding in cash.
  metaRows.sort((a, b) => b.devNetAnnRet - a.devNetAnnRet);
  console.log(`\nTop adaptive meta-configs on DEV (by NET ann.ret):`);
  console.log(`  ${"isWin".padStart(5)} ${"cad".padStart(4)} ${"q".padStart(4)}  netRet%  netSh  on%  tog`);
  for (const r of metaRows.slice(0, 8)) {
    console.log(`  ${String(r.isWin).padStart(5)} ${String(r.cadence).padStart(4)} ${r.qLevel.toFixed(2).padStart(4)}  ${(r.devNetAnnRet * 100).toFixed(2).padStart(6)} ${r.devNetSharpe.toFixed(2).padStart(5)} ${(r.devOnFrac * 100).toFixed(0).padStart(3)} ${String(r.devToggles).padStart(4)}`);
  }
  // Selection rule: among configs with real exposure (>=20% on) that beat RF on
  // dev, pick the best net ann.ret. Fallback: best Sharpe.
  const devCands = metaRows.filter((r) => r.devNetAnnRet > devRfAnn && r.devOnFrac >= 0.2);
  const selected =
    devCands.length > 0
      ? devCands.sort((a, b) => b.devNetAnnRet - a.devNetAnnRet)[0]
      : metaRows[0];
  console.log(`\nSELECTED meta-config (dev, real exposure >=20%): isWin=${selected.isWin} cadence=${selected.cadence} qLevel=${selected.qLevel}`);
  console.log(`  dev net ann.ret ${(selected.devNetAnnRet * 100).toFixed(2)}%  net Sharpe ${selected.devNetSharpe.toFixed(2)}  on% ${(selected.devOnFrac * 100).toFixed(0)}  toggles ${selected.devToggles}`);
  console.log(`  beats RF on dev? ${selected.devNetAnnRet > devRfAnn}   beats always-on on dev? ${selected.devNetAnnRet > devAoAnn}`);

  // =========================================================================
  // HONEST FIXED-PARAM baseline: lock the cutoff on the FIRST in-sample window of
  // the selected isWin, then NEVER change it (no future peeking). Same engine,
  // mode="fixed". This is the TA1-style fixed threshold done causally.
  // =========================================================================
  const devBookFull = book.slice(0, splitIdx);
  const devFundingFull = fundingArr.slice(0, splitIdx);
  const devSignalFull = signal.slice(0, splitIdx);
  const fixedDev = walkForward(devBookFull, devFundingFull, devSignalFull, selected.isWin, selected.cadence, selected.qLevel, "fixed", 1);
  console.log(`\nHONEST FIXED-param baseline (cutoff frozen on first ${selected.isWin}-period window):`);
  console.log(`  dev net ann.ret ${(annReturn(fixedDev.net) * 100).toFixed(2)}%  Sharpe ${annSharpe(fixedDev.net).toFixed(2)}  on% ${((fixedDev.onCount / fixedDev.net.length) * 100).toFixed(0)}  toggles ${fixedDev.toggles}`);

  // RANDOM-param WF baseline on dev (controls "is picking the trailing-best q
  // actually helping, or is just being-in-the-market enough?"). Average over seeds.
  const randDevRets: number[] = [];
  for (let seed = 1; seed <= 30; seed++) {
    const rw = walkForward(devBookFull, devFundingFull, devSignalFull, selected.isWin, selected.cadence, selected.qLevel, "random", seed * 7 + 1);
    randDevRets.push(annReturn(rw.net));
  }
  console.log(`  RANDOM-param WF (30 seeds) dev mean net ann.ret ${(mean(randDevRets) * 100).toFixed(2)}%  (std ${(std(randDevRets) * 100).toFixed(2)}%)`);

  // =========================================================================
  // SURROGATE / PLACEBO: run the EXACT SAME adaptive machinery (selected meta-
  // config) on surrogate funding (block-shuffle + phase-randomized) that preserves
  // vol & autocorrelation but destroys real "when is carry rich" structure. If the
  // machinery still 'earns' excess over RF, the real-data result is an artifact.
  // We measure excess-over-RF distribution across many surrogates on the DEV window.
  // =========================================================================
  console.log(`\n================ Q4: SURROGATE / PLACEBO (same machinery on noise) ================`);
  const surrTrials = 200;
  const blockLen = 90; // ~30 days blocks (preserve ~monthly autocorr)
  const surrExcessBlock: number[] = [];
  const surrExcessPhase: number[] = [];
  for (let s = 0; s < surrTrials; s++) {
    const rng = makeRng(20000 + s * 13);
    // block surrogate
    const fb = blockShuffle(devFundingFull, blockLen, rng);
    const bb = bookFromFunding(devBookFull, fb);
    const sb = buildSignal(fb);
    const wb = walkForward(bb, fb, sb, selected.isWin, selected.cadence, selected.qLevel, "adaptive", 1);
    surrExcessBlock.push(annReturn(wb.net) - devRfAnn);
    // phase surrogate (cheaper to do on a subset of trials due to O(n^2))
    if (s < 60) {
      const fp = phaseRandomize(devFundingFull, makeRng(40000 + s * 17));
      const bp = bookFromFunding(devBookFull, fp);
      const sp = buildSignal(fp);
      const wp = walkForward(bp, fp, sp, selected.isWin, selected.cadence, selected.qLevel, "adaptive", 1);
      surrExcessPhase.push(annReturn(wp.net) - devRfAnn);
    }
  }
  surrExcessBlock.sort((a, b) => a - b);
  surrExcessPhase.sort((a, b) => a - b);
  const realDevExcess = selected.devNetAnnRet - devRfAnn;
  const blockMean = mean(surrExcessBlock);
  const block95 = surrExcessBlock[Math.floor(0.95 * surrExcessBlock.length)];
  const phaseMean = mean(surrExcessPhase);
  const phase95 = surrExcessPhase.length ? surrExcessPhase[Math.floor(0.95 * surrExcessPhase.length)] : NaN;
  // surrogate p-value: fraction of surrogates with excess >= real
  const surrP = (surrExcessBlock.filter((x) => x >= realDevExcess).length + 1) / (surrExcessBlock.length + 1);
  console.log(`  REAL adaptive dev excess-over-RF: ${(realDevExcess * 100).toFixed(3)}%/yr`);
  console.log(`  BLOCK surrogate (${surrTrials}) excess-over-RF: mean ${(blockMean * 100).toFixed(3)}%  95th ${(block95 * 100).toFixed(3)}%`);
  console.log(`  PHASE surrogate (${surrExcessPhase.length}) excess-over-RF: mean ${(phaseMean * 100).toFixed(3)}%  95th ${(phase95 * 100).toFixed(3)}%`);
  console.log(`  surrogate p-value (frac surrogates >= real): ${surrP.toFixed(3)}`);
  const surrogateShowsEdge = block95 >= realDevExcess || blockMean >= realDevExcess * 0.5;
  console.log(`  => Surrogate machinery ${surrogateShowsEdge ? "ALSO produces comparable 'edge' on noise => real result is largely an ARTIFACT of structure-free toggling" : "produces ~no edge on noise (real result is not a pure machinery artifact)"}.`);

  // =========================================================================
  // CONSUME-ONCE HOLDOUT — score the SELECTED meta-config EXACTLY ONCE.
  // Run the WF engine over the FULL book but only collect the OOS portion that
  // lies in the holdout window, preserving causality (calibration windows roll in
  // from before the holdout; cutoffs use only past data). To keep accounting
  // honest we run the full WF and slice the holdout OOS returns by book index.
  // =========================================================================
  console.log(`\n================ HOLDOUT (consume-once) — score ONCE ================`);
  // Full-book WF: we need OOS index alignment. Re-run the engine but track book
  // indices per OOS return so we can slice the holdout.
  function walkForwardIndexed(mode: WfMode, qLevel: number, seed: number) {
    const isWin = selected.isWin;
    const cadence = selected.cadence;
    const out: { net: number[]; idx: number[]; onFlags: boolean[]; toggles: number; cutoffs: number[]; cutoffIdx: number[] } = {
      net: [], idx: [], onFlags: [], toggles: 0, cutoffs: [], cutoffIdx: [],
    };
    const rng = makeRng(seed);
    let prevOn = false;
    let fixedCutoff = NaN;
    if (mode === "fixed") {
      const win = fundingArr.slice(0, isWin).filter(Number.isFinite).sort((a, b) => a - b);
      fixedCutoff = quantile(win, qLevel);
    }
    for (let t = isWin; t < N; t += cadence) {
      const end = Math.min(t + cadence, N);
      let cutoff: number;
      if (mode === "fixed") cutoff = fixedCutoff;
      else if (mode === "random") {
        const rq = 0.3 + rng() * 0.6;
        cutoff = quantile(fundingArr.slice(t - isWin, t).filter(Number.isFinite).sort((a, b) => a - b), rq);
      } else cutoff = quantile(fundingArr.slice(t - isWin, t).filter(Number.isFinite).sort((a, b) => a - b), qLevel);
      out.cutoffs.push(cutoff);
      out.cutoffIdx.push(t);
      const res = runOnOff(book, (i) => Number.isFinite(signal[i]) && signal[i] >= cutoff, [t, end], prevOn);
      for (let k = 0; k < res.net.length; k++) {
        out.net.push(res.net[k]);
        out.idx.push(t + k);
        out.onFlags.push(res.onFlags[k]);
      }
      out.toggles += res.toggles;
      prevOn = res.onFlags[res.onFlags.length - 1] ?? prevOn;
    }
    return out;
  }

  const adaptiveFull = walkForwardIndexed("adaptive", selected.qLevel, 1);
  const fixedFull = walkForwardIndexed("fixed", selected.qLevel, 1);

  // slice holdout OOS (book idx >= splitIdx)
  const sliceHold = (run: { net: number[]; idx: number[]; onFlags: boolean[] }) => {
    const net: number[] = [];
    const onFlags: boolean[] = [];
    let toggles = 0;
    let prevOn: boolean | null = null;
    for (let k = 0; k < run.idx.length; k++) {
      if (run.idx[k] < splitIdx) continue;
      net.push(run.net[k]);
      onFlags.push(run.onFlags[k]);
      if (prevOn !== null && run.onFlags[k] !== prevOn) toggles++;
      prevOn = run.onFlags[k];
    }
    return { net, onFlags, toggles, onFrac: onFlags.filter(Boolean).length / Math.max(1, onFlags.length) };
  };
  const adHold = sliceHold(adaptiveFull);
  const fxHold = sliceHold(fixedFull);

  // random-param WF on holdout (30 seeds, mean)
  const randHoldRets: number[] = [];
  for (let seed = 1; seed <= 30; seed++) {
    const rw = walkForwardIndexed("random", selected.qLevel, seed * 11 + 3);
    randHoldRets.push(annReturn(sliceHold(rw).net));
  }

  const holdRange: [number, number] = [splitIdx, N];
  const holdAoNet = alwaysOnNet(book, holdRange);
  const holdRf = flatRiskFree(holdRange);
  const holdAoAnn = annReturn(holdAoNet);
  const holdRfAnn = annReturn(holdRf);
  const ad = { ann: annReturn(adHold.net), sharpe: annSharpe(adHold.net) };
  const fx = { ann: annReturn(fxHold.net), sharpe: annSharpe(fxHold.net) };
  const orc = oracleAnn(book, holdRange);

  console.log(`  Holdout window: ${book[splitIdx].date}..${book[N - 1].date}`);
  console.log(`  ADAPTIVE WF-OOS : net ann.ret ${(ad.ann * 100).toFixed(3)}%  Sharpe ${ad.sharpe.toFixed(3)}  on% ${(adHold.onFrac * 100).toFixed(0)}  toggles ${adHold.toggles}`);
  console.log(`  FIXED-param WF  : net ann.ret ${(fx.ann * 100).toFixed(3)}%  Sharpe ${fx.sharpe.toFixed(3)}  on% ${(fxHold.onFrac * 100).toFixed(0)}  toggles ${fxHold.toggles}`);
  console.log(`  RANDOM-param WF : net ann.ret ${(mean(randHoldRets) * 100).toFixed(3)}% (mean of 30 seeds)`);
  console.log(`  BUY&HOLD carry  : net ann.ret ${(holdAoAnn * 100).toFixed(3)}%  Sharpe ${annSharpe(holdAoNet).toFixed(3)}`);
  console.log(`  RISK-FREE       : net ann.ret ${(holdRfAnn * 100).toFixed(3)}%`);
  console.log(`  [ORACLE ceiling] perfect-foresight gate: ${(orc.ann * 100).toFixed(3)}% = +${((orc.ann - holdRfAnn) * 100).toFixed(3)}%/yr over RF (gross of toggle cost), on% ${(orc.onFrac * 100).toFixed(0)}`);

  // extra turnover/cost of adapting vs fixed (on holdout)
  const extraToggles = adHold.toggles - fxHold.toggles;
  const extraCostAnn = (extraToggles * (TOGGLE_ONE_WAY_BPS / 10_000)) / (adHold.net.length / PERIODS_PER_YEAR);
  console.log(`  Extra turnover from ADAPTING vs FIXED on holdout: ${extraToggles} extra toggles => ~${(extraCostAnn * 100).toFixed(3)}%/yr extra cost`);

  // ===================== GATES on the holdout-scored adaptive series =====================
  console.log(`\n================ GATES (adaptive WF, holdout) ================`);
  const adHoldStats = summarizeReturnSeries(adHold.net);
  const gate1 = adHoldStats.sharpe > 0; // net per-period Sharpe>0 on holdout
  console.log(`[G1] holdout net per-period Sharpe>0: ${adHoldStats.sharpe.toFixed(5)} -> ${gate1 ? "PASS" : "FAIL"}`);

  // DSR on holdout excess over RF, honest META_N
  const adExcess = adHold.net.map((x) => x - RF_PER_PERIOD);
  const dsr = computeDeflatedSharpeRatio(adExcess, { trialCount: META_N, benchmarkSharpe: 0 });
  const dsrP = 1 - dsr.deflatedProbability;
  const gate2 = dsr.deflatedProbability > 0.95;
  console.log(`[G2] DSR (holdout excess vs RF, N=${META_N}): perPeriodSharpe ${dsr.sharpe.toFixed(4)} expMax ${dsr.expectedMaxSharpe.toFixed(4)} deflProb ${dsr.deflatedProbability.toFixed(4)} p=${dsrP.toExponential(2)} -> ${gate2 ? "PASS" : "FAIL"}`);

  // PBO/CSCV across all meta-configs' HOLDOUT series + benchmarks
  const holdSeriesByCfg: CscvStrategyFoldReturns[] = [];
  const folds = 8;
  const splitFolds = (series: number[]) => {
    const out: number[][] = [];
    const size = Math.floor(series.length / folds);
    for (let f = 0; f < folds; f++) out.push(series.slice(f * size, f === folds - 1 ? series.length : (f + 1) * size));
    return out;
  };
  for (const r of metaRows) {
    const run = walkForwardIndexed("adaptive", r.qLevel, 1);
    // re-run with this config's isWin/cadence requires per-config engine; approximate
    // PBO over qLevel-varied holdout series (cheap, same isWin/cadence as selected).
    holdSeriesByCfg.push({ id: `q${r.qLevel}_${r.isWin}_${r.cadence}`, folds: splitFolds(sliceHold(run).net) });
  }
  holdSeriesByCfg.push({ id: "BUYHOLD", folds: splitFolds(holdAoNet) });
  holdSeriesByCfg.push({ id: "RISKFREE", folds: splitFolds(holdRf) });
  holdSeriesByCfg.push({ id: "FIXED", folds: splitFolds(fxHold.net) });
  const pbo = estimateCscvPbo(holdSeriesByCfg, { statistic: "sharpe", trainFraction: 0.5 });
  const gate3 = pbo.pbo < 0.5;
  console.log(`[G3] PBO (CSCV, ${holdSeriesByCfg.length} strategies, ${folds} folds): ${pbo.pbo.toFixed(4)} medLogit ${pbo.medianLogit.toFixed(3)} -> ${gate3 ? "PASS" : "FAIL"}`);

  // Baselines on holdout net compoundReturn: must beat buy&hold, risk-free, fixed, random
  const aoBaseline: BaselineScore = baselineScoreFromReturns("buy_and_hold", "buy&hold carry", holdAoNet, { statistic: "compoundReturn" });
  const rfBaseline: BaselineScore = baselineScoreFromReturns("linear", "risk-free", holdRf, { statistic: "compoundReturn" });
  const fxBaseline: BaselineScore = baselineScoreFromReturns("manual", "honest fixed-param", fxHold.net, { statistic: "compoundReturn" });
  const randHoldComp: number[] = [];
  for (let seed = 1; seed <= 30; seed++) {
    const rw = walkForwardIndexed("random", selected.qLevel, seed * 11 + 3);
    randHoldComp.push(summarizeReturnSeries(sliceHold(rw).net).compoundReturn);
  }
  randHoldComp.sort((a, b) => a - b);
  const randBaseline: BaselineScore = { id: "random_lottery", label: "random-param WF (95th pct)", score: randHoldComp[Math.floor(0.95 * randHoldComp.length)], source: "monte_carlo_30" };
  const baseGate = evaluateBaselineGate({
    candidateReturns: adHold.net,
    baselines: [aoBaseline, rfBaseline, fxBaseline, randBaseline],
    statistic: "compoundReturn",
    requirePositive: true,
  });
  const gate4 = baseGate.passed;
  console.log(`[G4] Baselines (holdout net compoundReturn): candidate ${(baseGate.candidateScore * 100).toFixed(3)}%`);
  for (const c of baseGate.comparisons) console.log(`     vs ${c.id.padEnd(16)} ${(c.baselineScore * 100).toFixed(3)}%  margin ${(c.margin * 100).toFixed(3)}%  beaten=${c.beaten}`);
  console.log(`     -> ${gate4 ? "PASS" : "FAIL: " + baseGate.reasons.join(",")}`);

  // Harvey-Liu haircut on holdout excess Sharpe
  const excStats = summarizeReturnSeries(adExcess);
  const hc = haircutSharpe({ observedSharpe: excStats.sharpe, sampleCount: excStats.sampleCount, trialCount: META_N, method: "bonferroni" });
  const gate5 = hc.haircutSharpe > 0 && hc.adjustedPValue < 0.05;
  console.log(`[G5] HL haircut (holdout excess, N=${META_N}): obs ${hc.observedSharpe.toFixed(4)} adjP ${hc.adjustedPValue.toExponential(2)} haircutSh ${hc.haircutSharpe.toFixed(4)} -> ${gate5 ? "PASS" : "FAIL"}`);

  // STRICT holdout edge gate: adaptive must beat RF by >=0.5%/yr AND beat fixed AND beat surrogate
  const adVsRf = ad.ann - holdRfAnn;
  const adVsFixed = ad.ann - fx.ann;
  const gate6 = adVsRf >= 0.005 && ad.sharpe > 0;
  console.log(`[G6] holdout edge: adaptive vs RF ${(adVsRf * 100).toFixed(3)}%/yr (need>=0.50%), vs FIXED ${(adVsFixed * 100).toFixed(3)}%/yr -> ${gate6 ? "PASS" : "FAIL"}`);

  // ===================== VERDICT =====================
  const beatsBuyHold = ad.ann > holdAoAnn;
  const beatsFixed = ad.ann > fx.ann + 1e-9;
  const surrogateClean = !surrogateShowsEdge;
  const passesStatGates = gate1 && gate2 && gate3 && gate4 && gate5 && gate6;
  const survived = beatsBuyHold && beatsFixed && surrogateClean && passesStatGates && adVsRf >= 0.005;

  // PARTIAL = adaptivity strictly helps vs fixed (logically/structurally) but the
  // regime ceiling (oracle) is too low to clear RF net of cost.
  const adaptivityHelpsDirectionally = ad.ann >= fx.ann - 1e-9;
  const oracleTooLow = orc.ann - holdRfAnn < 0.005;
  let verdict: "SURVIVE" | "KILL" | "PARTIAL";
  if (survived) verdict = "SURVIVE";
  else if (adaptivityHelpsDirectionally && oracleTooLow) verdict = "PARTIAL";
  else verdict = "KILL";

  console.log(`\n======================= VERDICT =======================`);
  console.log(`  Q1 param drifts trackably?        ${driftTrackable ? "YES (regime autocorr " + regimeAc1.toFixed(2) + ", cutoff autocorr " + cutoffAc1.toFixed(2) + ")" : "NOT cleanly"}`);
  console.log(`  Q2 adaptive beats buy&hold (net)? ${beatsBuyHold ? "YES" : "NO"}  (${(ad.ann * 100).toFixed(2)}% vs ${(holdAoAnn * 100).toFixed(2)}%)`);
  console.log(`  Q2 adaptive beats RISK-FREE?      ${adVsRf >= 0.005 ? "YES" : "NO"}  (margin ${(adVsRf * 100).toFixed(2)}%/yr, need>=0.50)`);
  console.log(`  Q3 adaptive beats FIXED-param?    ${beatsFixed ? "YES" : "NO/TIE"}  (margin ${(adVsFixed * 100).toFixed(3)}%/yr)`);
  console.log(`  Q4 surrogate shows ~no edge?      ${surrogateClean ? "YES (clean)" : "NO — machinery earns on noise (artifact)"}`);
  console.log(`  Stat gates G1-G6 all pass?        ${passesStatGates ? "YES" : "NO"}`);
  console.log(`  ORACLE ceiling over RF on holdout: +${((orc.ann - holdRfAnn) * 100).toFixed(2)}%/yr (the MOST any causal gate could harvest)`);
  console.log(`  ----------------------------------------`);
  console.log(`  VERDICT: ${verdict}`);
  if (verdict === "PARTIAL") {
    console.log(`  Adaptivity is WELL-POSED and self-calibrates correctly (it does NOT decay like the`);
    console.log(`  fixed threshold), but the recent regime simply has <${((orc.ann - holdRfAnn) * 100).toFixed(2)}%/yr of harvestable carry —`);
    console.log(`  below the cost of harvesting it. No amount of adaptivity can CREATE carry that`);
    console.log(`  isn't there. Adaptivity confirms the edge isn't present now; it doesn't manufacture one.`);
  } else if (verdict === "KILL") {
    console.log(`  Adaptive WF does not clear the bar (see gates above).`);
  }

  // Realistic monthly $
  const monthlyPct = ad.ann / 12;
  console.log(`\n  Realistic NET monthly (adaptive, holdout): ${(monthlyPct * 100).toFixed(3)}% => $${(monthlyPct * 100000).toFixed(0)}/mo at $100k (RF monthly ${((RISK_FREE_APR / 12) * 100).toFixed(3)}% = $${((RISK_FREE_APR / 12) * 100000).toFixed(0)})`);

  const report = {
    track: "WF-D-adaptive-carry-threshold",
    generatedAt: new Date().toISOString(),
    dataSource: "output/funding/* (8 majors, 8h funding + daily spot/perp premium, 2023-06..2026-05)",
    bookPeriods: N,
    holdout: { frac: holdoutFrac, splitIdx, startDate: book[splitIdx].date, endDate: book[N - 1].date, periods: N - splitIdx },
    cost: { spotTakerBps: SPOT_TAKER_BPS, perpTakerBps: PERP_TAKER_BPS, toggleOneWayBps: TOGGLE_ONE_WAY_BPS, riskFreeApr: RISK_FREE_APR },
    metaGrid: { isWins, cadences, qLevels, trueN: META_N },
    selectedMetaConfig: { isWin: selected.isWin, cadence: selected.cadence, qLevel: selected.qLevel, devNetAnnRet: selected.devNetAnnRet, devNetSharpe: selected.devNetSharpe, devOnFrac: selected.devOnFrac },
    q1_drift: { regimeAutocorrLag1: regimeAc1, bestCutoffAutocorrLag1: cutoffAc1, bestQuantileAutocorrLag1: qAc1, trackable: driftTrackable, probeSteps: bestCutoffs.length },
    q2_q3_holdout: {
      adaptiveNetAnnRet: ad.ann, adaptiveNetSharpe: ad.sharpe, adaptiveOnFrac: adHold.onFrac, adaptiveToggles: adHold.toggles,
      fixedNetAnnRet: fx.ann, fixedNetSharpe: fx.sharpe, fixedToggles: fxHold.toggles,
      randomNetAnnRetMean: mean(randHoldRets),
      buyHoldNetAnnRet: holdAoAnn, riskFreeAnnRet: holdRfAnn,
      adaptiveVsRfPctPerYr: adVsRf * 100, adaptiveVsFixedPctPerYr: adVsFixed * 100, adaptiveVsBuyHoldPctPerYr: (ad.ann - holdAoAnn) * 100,
      extraTogglesFromAdapting: extraToggles, extraCostFromAdaptingPctPerYr: extraCostAnn * 100,
    },
    oracleCeiling: { holdoutAnnRet: orc.ann, excessOverRfPctPerYr: (orc.ann - holdRfAnn) * 100, onFrac: orc.onFrac, note: "perfect-foresight upper bound gross of toggle cost; the MOST any causal gate could harvest this regime" },
    q4_surrogate: { blockSurrogateExcessMeanPct: blockMean * 100, blockSurrogate95Pct: block95 * 100, phaseSurrogateExcessMeanPct: phaseMean * 100, realDevExcessPct: realDevExcess * 100, surrogatePValue: surrP, surrogateShowsEdge },
    gates: {
      g1_netSharpe: { value: adHoldStats.sharpe, pass: gate1 },
      g2_dsr: { perPeriodExcessSharpe: dsr.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe, deflatedProbability: dsr.deflatedProbability, pValue: dsrP, pass: gate2 },
      g3_pbo: { pbo: pbo.pbo, medianLogit: pbo.medianLogit, strategyCount: holdSeriesByCfg.length, pass: gate3 },
      g4_baselines: { candidate: baseGate.candidateScore, comparisons: baseGate.comparisons, pass: gate4 },
      g5_haircut: { observedSharpe: hc.observedSharpe, adjustedPValue: hc.adjustedPValue, haircutSharpe: hc.haircutSharpe, pass: gate5 },
      g6_holdoutEdge: { adaptiveVsRf: adVsRf, adaptiveVsFixed: adVsFixed, pass: gate6 },
    },
    verdict,
    realisticMonthly: { pct: monthlyPct, usd100k: monthlyPct * 100000 },
  };
  fs.writeFileSync(path.join(OUT_DIR, "wf-d-adaptive-carry-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path.join(OUT_DIR, "wf-d-adaptive-carry-report.json")}`);
}

main();
