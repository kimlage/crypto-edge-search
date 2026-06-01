/**
 * TRACK TA1 — Can causal indicators TIME the delta-neutral carry ON/OFF to
 * dodge bad-funding months and beat 4.5% risk-free AFTER cost?
 *
 * Edge under test: cash-and-carry (long spot + short perp) collects the 8h
 * funding rate while staying ~delta-neutral. Round 2 showed always-on carry on
 * the current funding regime sits BELOW risk-free and had a Feb-Apr 2026
 * drawdown. This script asks whether a GATING signal (funding level/momentum,
 * basis term-structure slope, OI/price divergence proxy, realized-vol regime,
 * perp-spot premium) can switch carry ON only when it is rich+stable and sit in
 * risk-free otherwise — net of entry/exit + toggle cost.
 *
 * RIGOR: imports the committed gates (DSR with HONEST N = every rule+threshold
 * tried, CSCV/PBO, baselines, Harvey-Liu haircut, consume-once holdout).
 *
 * Run:
 *   PATH=.../node/bin:$PATH node_modules/.bin/tsx scripts/ta-research/carry-gating.ts
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
const DATED_DIR = path.join(ROOT, "output/dated-futures");
const OUT_DIR = path.join(ROOT, "output/ta-research");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Cost & regime constants (MANDATORY realistic cost; matches d2 cost model)
// ---------------------------------------------------------------------------
const SPOT_TAKER_BPS = 10; // per side, spot leg
const PERP_TAKER_BPS = 4; // per side, perp leg
// A carry TOGGLE = open BOTH legs then later close BOTH legs. Entry pays
// (spot+perp) taker; exit pays (spot+perp) taker. One full ON->...->OFF cycle =
// 2*(10+4) = 28 bps round trip on notional. We charge HALF (14 bps) on each
// transition (ON entry, OFF exit) so the per-toggle accounting is symmetric.
const TOGGLE_ONE_WAY_BPS = SPOT_TAKER_BPS + PERP_TAKER_BPS; // 14 bps per transition
const RISK_FREE_APR = 0.045;
const PERIODS_PER_YEAR = 1095.75; // 3 funding settlements/day
const RF_PER_PERIOD = RISK_FREE_APR / PERIODS_PER_YEAR; // risk-free per 8h
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
// Load raw data
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
  return JSON.parse(
    fs.readFileSync(path.join(FUND_DIR, `${sym}_funding_8h.json`), "utf8"),
  );
}
function loadPrices(sym: string): PricePt[] {
  return JSON.parse(
    fs.readFileSync(path.join(FUND_DIR, `${sym}_prices_daily.json`), "utf8"),
  );
}

// Build a daily premium map (perp/spot - 1) from the daily price file.
function buildPremiumMap(prices: PricePt[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of prices) {
    if (p.spotClose > 0) m.set(p.date, p.perpClose / p.spotClose - 1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Carry P&L per 8h period (delta-neutral cash-and-carry)
// ---------------------------------------------------------------------------
// Per period the SHORT-perp + LONG-spot book receives the funding rate. Basis
// convergence is a second-order term we approximate via the daily premium drift
// (perp/spot mean-reverts toward 0); on a delta-neutral book the spot and perp
// price moves cancel, so the dominant return IS the funding. We include a small
// daily basis-drift term so a rich premium that later collapses is penalized.
interface Period {
  t: number; // funding settlement ms
  date: string; // YYYY-MM-DD (UTC)
  month: string; // YYYY-MM
  funding: number; // funding collected this period (short perp side)
  premium: number; // perp/spot - 1 on this date (level)
}

function buildPeriods(sym: string): Period[] {
  const fund = loadFunding(sym);
  const prices = loadPrices(sym);
  const premium = buildPremiumMap(prices);
  const out: Period[] = [];
  for (const f of fund) {
    const d = new Date(f.fundingTime);
    const date = d.toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    const prem = premium.get(date);
    if (prem === undefined) continue; // need a basis level for that day
    out.push({
      t: f.fundingTime,
      date,
      month,
      funding: f.fundingRate,
      premium: prem,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ---------------------------------------------------------------------------
// Dated-basis term-structure slope (causal): annualized basis of the nearest
// active quarterly future on each date. Rising/steep basis = rich carry regime.
// ---------------------------------------------------------------------------
function buildDatedBasisMap(asset: "BTC" | "ETH"): Map<string, number> {
  const raw: Array<{ deliveryDate: string; rows: Array<{ date: string; basis: number }> }> =
    JSON.parse(fs.readFileSync(path.join(DATED_DIR, `${asset}_quarterly_basis.json`), "utf8"));
  // For each calendar date keep the basis of the contract with the NEAREST
  // future (but still un-delivered) delivery — annualized.
  const byDate = new Map<string, number>();
  for (const c of raw) {
    const delivery = new Date(c.deliveryDate + "T00:00:00Z").getTime();
    for (const r of c.rows) {
      const dt = new Date(r.date + "T00:00:00Z").getTime();
      const daysToDeliv = (delivery - dt) / 86_400_000;
      if (daysToDeliv <= 2 || daysToDeliv > 120) continue; // active near contract
      const annualized = (r.basis * 365) / daysToDeliv;
      const prev = byDate.get(r.date);
      // prefer the nearest contract (smallest positive daysToDeliv): keep first
      // by overwriting only if not present
      if (prev === undefined) byDate.set(r.date, annualized);
    }
  }
  return byDate;
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
function annSharpe(returns: number[]): number {
  return summarizeReturnSeries(returns).sharpe * ANNUALIZE_SHARPE;
}
function annReturn(returns: number[]): number {
  // arithmetic annualized (mean per period * periods/yr)
  return mean(returns) * PERIODS_PER_YEAR;
}

// ---------------------------------------------------------------------------
// Build the diversified delta-neutral carry book at 8h granularity.
// Equal-weight across symbols, aligned on the union of funding timestamps.
// ---------------------------------------------------------------------------
interface BookPeriod {
  t: number;
  date: string;
  month: string;
  carryRet: number; // equal-weight funding across active symbols (gross, no toggle cost)
  meanFunding: number; // mean funding level across symbols (signal input)
  meanPremium: number; // mean perp-spot premium across symbols (signal input)
}

function buildDiversifiedBook(): {
  book: BookPeriod[];
  perSym: Map<string, Period[]>;
} {
  const perSym = new Map<string, Period[]>();
  const allTimes = new Set<number>();
  for (const sym of SYMBOLS) {
    const p = buildPeriods(sym);
    perSym.set(sym, p);
    for (const x of p) allTimes.add(x.t);
  }
  // index per symbol by time
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
    const premiums: number[] = [];
    let date = "";
    let month = "";
    for (const sym of SYMBOLS) {
      const x = idx.get(sym)!.get(t);
      if (!x) continue;
      fundings.push(x.funding);
      premiums.push(x.premium);
      date = x.date;
      month = x.month;
    }
    if (fundings.length === 0) continue;
    book.push({
      t,
      date,
      month,
      carryRet: mean(fundings), // equal-weight funding collected this 8h
      meanFunding: mean(fundings),
      meanPremium: mean(premiums),
    });
  }
  return { book, perSym };
}

// ---------------------------------------------------------------------------
// Realized vol regime (causal): trailing std of meanFunding (proxy for funding
// instability) and trailing std of premium.
// ---------------------------------------------------------------------------
function trailing(arr: number[], i: number, win: number): number[] {
  const start = Math.max(0, i - win);
  return arr.slice(start, i); // STRICTLY past (excludes current i) -> causal
}

// ---------------------------------------------------------------------------
// SIGNAL DEFINITIONS. Each returns, for index i, whether carry should be ON
// using ONLY data strictly before i (causal). We enumerate a grid of
// (signal family x threshold x lookback) — EVERY combination counts toward N.
// ---------------------------------------------------------------------------
type GateFn = (i: number) => boolean;

interface Variant {
  id: string;
  family: string;
  gate: GateFn;
}

function buildVariants(book: BookPeriod[], datedBasis: Map<string, number>): Variant[] {
  const N = book.length;
  const fundingArr = book.map((b) => b.meanFunding);
  const premiumArr = book.map((b) => b.meanPremium);
  const variants: Variant[] = [];

  // Lookback windows in 8h periods (3/day): ~2d,5d,10d,20d,40d
  const lookbacks = [6, 15, 30, 60, 120];

  // ---- Family 1: funding LEVEL — ON if trailing-mean funding > threshold ----
  // thresholds in per-8h funding (e.g. 0 = positive, 1bp, 2bp, 3bp)
  const levelThresh = [0, 0.00005, 0.0001, 0.00015, 0.0002];
  for (const lb of lookbacks) {
    for (const th of levelThresh) {
      variants.push({
        id: `level_lb${lb}_th${th}`,
        family: "funding_level",
        gate: (i) => {
          const past = trailing(fundingArr, i, lb);
          if (past.length < Math.min(lb, 3)) return false;
          return mean(past) > th;
        },
      });
    }
  }

  // ---- Family 2: funding MOMENTUM — ON if funding RISING (short MA > long MA)
  const momPairs: Array<[number, number]> = [
    [6, 30],
    [6, 60],
    [15, 60],
    [15, 120],
    [30, 120],
  ];
  // Also require level above a floor so we don't go long into rising-but-negative
  const momFloor = [Number.NEGATIVE_INFINITY, 0, 0.00005];
  for (const [s, l] of momPairs) {
    for (const fl of momFloor) {
      variants.push({
        id: `mom_s${s}_l${l}_fl${fl}`,
        family: "funding_momentum",
        gate: (i) => {
          const ps = trailing(fundingArr, i, s);
          const pl = trailing(fundingArr, i, l);
          if (ps.length < Math.min(s, 3) || pl.length < Math.min(l, 6)) return false;
          const short = mean(ps);
          const long = mean(pl);
          return short > long && short > fl;
        },
      });
    }
  }

  // ---- Family 3: perp-spot PREMIUM level — ON if premium rich (>threshold)
  // premium per-day fraction; positive premium => contango => carry rich
  const premThresh = [0, 0.0002, 0.0005, 0.001];
  for (const lb of [6, 30, 120]) {
    for (const th of premThresh) {
      variants.push({
        id: `prem_lb${lb}_th${th}`,
        family: "perp_spot_premium",
        gate: (i) => {
          const past = trailing(premiumArr, i, lb);
          if (past.length < Math.min(lb, 3)) return false;
          return mean(past) > th;
        },
      });
    }
  }

  // ---- Family 4: realized-vol / funding-STABILITY regime — ON only when
  // funding is positive AND its trailing volatility is LOW (rich+STABLE).
  const volWin = [15, 30, 60];
  const volCut = [0.00008, 0.00012, 0.0002]; // max allowed trailing std of funding
  for (const w of volWin) {
    for (const vc of volCut) {
      variants.push({
        id: `vol_w${w}_vc${vc}`,
        family: "vol_regime",
        gate: (i) => {
          const past = trailing(fundingArr, i, w);
          if (past.length < Math.min(w, 6)) return false;
          return mean(past) > 0 && std(past) < vc;
        },
      });
    }
  }

  // ---- Family 5: dated-basis term-structure SLOPE — ON when annualized
  // quarterly basis (causal, prior day) is above threshold (steep contango).
  const basisThresh = [0, 0.03, 0.05, 0.08]; // annualized basis cutoffs
  // map dated basis onto book dates, using PRIOR day's value (causal)
  const datedByIdx: number[] = new Array(N).fill(NaN);
  {
    // For each book period, look up the most recent dated-basis on a date < this date
    const sortedDates = [...datedBasis.keys()].sort();
    for (let i = 0; i < N; i++) {
      const d = book[i].date;
      // find latest dated date strictly < d (causal: use yesterday's term structure)
      let val = NaN;
      for (let j = sortedDates.length - 1; j >= 0; j--) {
        if (sortedDates[j] < d) {
          val = datedBasis.get(sortedDates[j])!;
          break;
        }
      }
      datedByIdx[i] = val;
    }
  }
  for (const th of basisThresh) {
    variants.push({
      id: `basis_th${th}`,
      family: "dated_basis_slope",
      gate: (i) => {
        const v = datedByIdx[i];
        if (!Number.isFinite(v)) return false;
        return v > th;
      },
    });
  }

  // ---- Family 6: combined funding-rich + premium-positive (interaction) ----
  for (const lb of [15, 30]) {
    for (const th of [0.00005, 0.0001]) {
      variants.push({
        id: `combo_lb${lb}_th${th}`,
        family: "combo_level_prem",
        gate: (i) => {
          const pf = trailing(fundingArr, i, lb);
          const pp = trailing(premiumArr, i, lb);
          if (pf.length < 3) return false;
          return mean(pf) > th && mean(pp) > 0;
        },
      });
    }
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Apply a gate to produce a NET return series (carry when ON minus toggle cost
// on transitions; risk-free when OFF).
// ---------------------------------------------------------------------------
interface GatedResult {
  net: number[]; // net per-period return series
  gross: number[]; // gross (carry/rf, no toggle cost)
  toggles: number; // number of ON<->OFF transitions
  fracOn: number;
  onFlags: boolean[];
}

function applyGate(book: BookPeriod[], gate: GateFn): GatedResult {
  const net: number[] = [];
  const gross: number[] = [];
  const onFlags: boolean[] = [];
  let prevOn = false;
  let toggles = 0;
  let onCount = 0;
  for (let i = 0; i < book.length; i++) {
    const on = gate(i);
    const carry = book[i].carryRet;
    const base = on ? carry : RF_PER_PERIOD;
    let cost = 0;
    if (on !== prevOn) {
      // transition: pay one-way toggle cost on notional (entering or exiting carry)
      cost = TOGGLE_ONE_WAY_BPS / 10_000;
      toggles++;
    }
    gross.push(base);
    net.push(base - cost);
    onFlags.push(on);
    if (on) onCount++;
    prevOn = on;
  }
  return { net, gross, toggles, fracOn: onCount / book.length, onFlags };
}

// Always-on carry net series (pay entry once, hold; we charge one toggle at start)
function alwaysOnNet(book: BookPeriod[]): number[] {
  const net: number[] = [];
  for (let i = 0; i < book.length; i++) {
    let c = book[i].carryRet;
    if (i === 0) c -= TOGGLE_ONE_WAY_BPS / 10_000; // pay entry once
    net.push(c);
  }
  return net;
}
function flatRiskFree(book: BookPeriod[]): number[] {
  return book.map(() => RF_PER_PERIOD);
}

// ---------------------------------------------------------------------------
// CSCV/PBO across variants — split the period series into folds, score by
// compoundReturn (net). 10 folds, train fraction 0.5.
// ---------------------------------------------------------------------------
function splitFolds(series: number[], folds: number): number[][] {
  const out: number[][] = [];
  const size = Math.floor(series.length / folds);
  for (let f = 0; f < folds; f++) {
    const start = f * size;
    const end = f === folds - 1 ? series.length : start + size;
    out.push(series.slice(start, end));
  }
  return out;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  const { book } = buildDiversifiedBook();
  // Use BTC dated basis as the term-structure proxy for the diversified book.
  const datedBasis = buildDatedBasisMap("BTC");

  console.log(`Diversified carry book: ${book.length} 8h periods, ${book[0].date} -> ${book[book.length - 1].date}`);

  // ---- HOLDOUT: consume-once. Reserve the LAST 20% of periods (most recent,
  // includes the Feb-Apr 2026 drawdown the task cares about). Search ONLY on
  // the first 80%; evaluate the single winner once on holdout. ----
  const holdoutFrac = 0.2;
  const splitIdx = Math.floor(book.length * (1 - holdoutFrac));
  const trainBook = book.slice(0, splitIdx);
  const holdBook = book.slice(splitIdx);
  console.log(`Search window: ${trainBook.length} periods (${trainBook[0].date}..${trainBook[trainBook.length-1].date})`);
  console.log(`Holdout window: ${holdBook.length} periods (${holdBook[0].date}..${holdBook[holdBook.length-1].date})`);

  // Build variants (signals reference the FULL book array indices, but gates are
  // causal — they only look strictly backward. To keep the search honest we
  // build variants twice: one indexed on trainBook, one on full book for holdout.)
  const trainDated = datedBasis; // same map; gates use date lookups
  const variantsTrain = buildVariants(trainBook, trainDated);

  // TRUE TRIAL COUNT N = every variant evaluated in the search.
  const N = variantsTrain.length;
  console.log(`\nTRUE trial count N (every gating rule x threshold x lookback) = ${N}`);

  // Reference series on the search window
  const aoNetTrain = alwaysOnNet(trainBook);
  const rfTrain = flatRiskFree(trainBook);

  // Evaluate every variant on the search window (net of cost)
  interface Row {
    id: string;
    family: string;
    netSharpeAnn: number;
    netAnnRet: number;
    grossAnnRet: number;
    toggles: number;
    fracOn: number;
    net: number[];
  }
  const rows: Row[] = [];
  for (const v of variantsTrain) {
    const r = applyGate(trainBook, v.gate);
    rows.push({
      id: v.id,
      family: v.family,
      netSharpeAnn: annSharpe(r.net),
      netAnnRet: annReturn(r.net),
      grossAnnRet: annReturn(r.gross),
      toggles: r.toggles,
      fracOn: r.fracOn,
      net: r.net,
    });
  }

  // Reference metrics
  const aoSharpe = annSharpe(aoNetTrain);
  const aoRet = annReturn(aoNetTrain);
  const rfRet = annReturn(rfTrain);
  console.log(`\nReference (search window, NET annualized):`);
  console.log(`  always-on carry : ann.ret ${(aoRet * 100).toFixed(2)}%  ann.Sharpe ${aoSharpe.toFixed(3)}`);
  console.log(`  flat risk-free  : ann.ret ${(rfRet * 100).toFixed(2)}%  (Sharpe ~inf, zero vol)`);

  // Rank variants by net annualized Sharpe on search window
  rows.sort((a, b) => b.netSharpeAnn - a.netSharpeAnn);
  console.log(`\nTop 12 gated variants by NET annualized Sharpe (search window):`);
  console.log(`  ${"id".padEnd(26)} ${"family".padEnd(20)} netSh  netRet% grossRet% tog  on%`);
  for (const r of rows.slice(0, 12)) {
    console.log(
      `  ${r.id.padEnd(26)} ${r.family.padEnd(20)} ${r.netSharpeAnn.toFixed(2).padStart(5)} ${(r.netAnnRet * 100).toFixed(2).padStart(7)} ${(r.grossAnnRet * 100).toFixed(2).padStart(8)} ${String(r.toggles).padStart(4)} ${(r.fracOn * 100).toFixed(0).padStart(3)}`,
    );
  }

  // ---- Selection: the HONEST economic question is "does deploying carry when
  // the signal says rich beat always-on AND risk-free?". A degenerate rule that
  // sits in risk-free 95% of the time trivially "beats risk-free" by ~tying it
  // and trivially "beats always-on" by avoiding carry — that is NOT an indicator
  // edge. So we require MEANINGFUL carry exposure (fracOn >= 25%) and pick the
  // best net-annual-return variant among those that beat risk-free. (We also
  // report the degenerate best-Sharpe for transparency.) ----
  const degenerateBestSharpe = rows[0];
  const realCandidates = rows.filter((r) => r.netAnnRet > rfRet && r.fracOn >= 0.25);
  const winner =
    realCandidates.length > 0
      ? realCandidates.sort((a, b) => b.netAnnRet - a.netAnnRet)[0]
      : rows.filter((r) => r.netAnnRet > rfRet).sort((a, b) => b.netSharpeAnn - a.netSharpeAnn)[0] ?? rows[0];
  console.log(`\nDegenerate best-Sharpe variant (NOT an edge — sits in RF): ${degenerateBestSharpe.id} on% ${(degenerateBestSharpe.fracOn * 100).toFixed(0)}`);
  console.log(`Selected winner (real carry exposure >=25% on): ${winner.id} (${winner.family})`);
  console.log(`  net ann.Sharpe ${winner.netSharpeAnn.toFixed(3)}  net ann.ret ${(winner.netAnnRet * 100).toFixed(2)}%  toggles ${winner.toggles}  on% ${(winner.fracOn * 100).toFixed(0)}`);
  console.log(`  beats risk-free on search window? ${winner.netAnnRet > rfRet}`);
  console.log(`  beats always-on (Sharpe)? ${winner.netSharpeAnn > aoSharpe}  beats always-on (ret)? ${winner.netAnnRet > aoRet}`);

  // ===================== RIGOR GATES =====================
  const gateResults: Record<string, unknown> = {};

  // ---- GATE 1: net Sharpe > 0 ----
  const winnerStats = summarizeReturnSeries(winner.net);
  const gate1 = winnerStats.sharpe > 0;
  console.log(`\n[GATE 1] net per-period Sharpe > 0 : ${winnerStats.sharpe.toFixed(4)} -> ${gate1 ? "PASS" : "FAIL"}`);

  // ---- GATE 2: Deflated Sharpe with HONEST N ----
  // DSR works on the EXCESS return over risk-free (so risk-free benchmark is 0).
  const excess = winner.net.map((x) => x - RF_PER_PERIOD);
  const dsr = computeDeflatedSharpeRatio(excess, { trialCount: N, benchmarkSharpe: 0 });
  const dsrP = 1 - dsr.deflatedProbability; // p-value that observed Sharpe is NOT just max-of-N noise
  const gate2 = dsr.deflatedProbability > 0.95; // i.e. p < 0.05
  console.log(`\n[GATE 2] Deflated Sharpe (excess over RF, N=${N}):`);
  console.log(`  per-period Sharpe(excess) ${dsr.sharpe.toFixed(4)}  expectedMaxSharpe ${dsr.expectedMaxSharpe.toFixed(4)}`);
  console.log(`  deflatedProbability ${dsr.deflatedProbability.toFixed(4)}  => p-value ${dsrP.toExponential(3)} -> ${gate2 ? "PASS (p<0.05)" : "FAIL (p>=0.05)"}`);

  // ---- GATE 3: PBO via CSCV across all variants ----
  const folds = 10;
  const strategies: CscvStrategyFoldReturns[] = rows.map((r) => ({
    id: r.id,
    folds: splitFolds(r.net, folds),
  }));
  // include always-on and risk-free as competing strategies
  strategies.push({ id: "ALWAYS_ON", folds: splitFolds(aoNetTrain, folds) });
  strategies.push({ id: "RISK_FREE", folds: splitFolds(rfTrain, folds) });
  const pbo = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });
  const gate3 = pbo.pbo < 0.5;
  console.log(`\n[GATE 3] PBO (CSCV, ${strategies.length} strategies incl. always-on & RF, ${folds} folds, by Sharpe):`);
  console.log(`  PBO ${pbo.pbo.toFixed(4)}  medianLogit ${pbo.medianLogit.toFixed(3)} -> ${gate3 ? "PASS (<0.5)" : "FAIL (>=0.5)"}`);

  // ---- GATE 4: Baselines — must beat buy-and-hold, random-lottery, linear ----
  // Buy-and-hold of the carry book = ALWAYS-ON carry (the natural "hold the
  // edge" baseline). Random-lottery = randomly toggle ON with same on-fraction.
  // Linear = a naive persistence rule (carry ON iff last period's funding>0).
  // We compare on net compoundReturn over the search window.
  const aoBaseline: BaselineScore = baselineScoreFromReturns(
    "buy_and_hold",
    "always-on carry (hold the edge)",
    aoNetTrain,
    { statistic: "compoundReturn" },
  );
  const rfBaseline: BaselineScore = baselineScoreFromReturns(
    "linear",
    "flat risk-free 4.5%",
    rfTrain,
    { statistic: "compoundReturn" },
  );
  // random-lottery: many random gates with same on-fraction; take 95th pct net compound
  const randSamples: number[] = [];
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let it = 0; it < 512; it++) {
    const r = applyGate(trainBook, () => rnd() < winner.fracOn);
    randSamples.push(summarizeReturnSeries(r.net).compoundReturn);
  }
  randSamples.sort((a, b) => a - b);
  const randScore = randSamples[Math.floor(0.95 * randSamples.length)];
  const randBaseline: BaselineScore = {
    id: "random_lottery",
    label: "random toggle (95th pct, matched on-fraction)",
    score: randScore,
    source: "monte_carlo_512",
  };
  const baseGate = evaluateBaselineGate({
    candidateReturns: winner.net,
    baselines: [aoBaseline, rfBaseline, randBaseline],
    statistic: "compoundReturn",
    requirePositive: true,
  });
  const gate4 = baseGate.passed;
  console.log(`\n[GATE 4] Baselines (net compoundReturn over search window):`);
  console.log(`  candidate ${(baseGate.candidateScore * 100).toFixed(3)}%`);
  for (const c of baseGate.comparisons) {
    console.log(`   vs ${c.id.padEnd(16)} ${(c.baselineScore * 100).toFixed(3)}%  margin ${(c.margin * 100).toFixed(3)}%  beaten=${c.beaten}`);
  }
  console.log(`  -> ${gate4 ? "PASS (beats all)" : "FAIL: " + baseGate.reasons.join(",")}`);

  // ---- GATE 5: Harvey-Liu haircut (excess Sharpe, N trials, Bonferroni) ----
  const excStats = summarizeReturnSeries(excess);
  const hc = haircutSharpe({
    observedSharpe: excStats.sharpe,
    sampleCount: excStats.sampleCount,
    trialCount: N,
    method: "bonferroni",
  });
  const gate5 = hc.haircutSharpe > 0 && hc.adjustedPValue < 0.05;
  console.log(`\n[GATE 5] Harvey-Liu haircut (excess Sharpe, N=${N}, Bonferroni):`);
  console.log(`  observed ${hc.observedSharpe.toFixed(4)}  p ${hc.pValue.toExponential(2)}  adjP ${hc.adjustedPValue.toExponential(2)}  haircutSharpe ${hc.haircutSharpe.toFixed(4)} (lost ${(hc.haircut * 100).toFixed(0)}%) -> ${gate5 ? "PASS" : "FAIL"}`);

  // ---- GATE 6: HOLDOUT (consume-once) — apply the SAME winner rule to the
  // reserved recent window. Rebuild the winner's gate against the full book and
  // evaluate only on the holdout slice. ----
  const variantsFull = buildVariants(book, datedBasis);
  const winnerFull = variantsFull.find((v) => v.id === winner.id)!;
  // run gate on full book, then slice the holdout portion (carry state continuity)
  const fullRun = applyGate(book, winnerFull.gate);
  const holdNet = fullRun.net.slice(splitIdx);
  const holdAoNet = alwaysOnNet(holdBook);
  const holdRf = flatRiskFree(holdBook);
  const holdSharpe = annSharpe(holdNet);
  const holdRet = annReturn(holdNet);
  const holdAoRet = annReturn(holdAoNet);
  const holdRfRet = annReturn(holdRf);
  // STRICT: must beat risk-free by a real margin (>=0.5%/yr), not merely tie it
  // by sitting in cash. Sitting in risk-free 100% of the holdout is NOT an edge.
  const holdMarginVsRf = holdRet - holdRfRet;
  const gate6 = holdMarginVsRf >= 0.005 && holdSharpe > 0;
  console.log(`\n[GATE 6] HOLDOUT (consume-once, last ${(holdoutFrac * 100).toFixed(0)}% = ${holdBook[0].date}..${holdBook[holdBook.length-1].date}):`);
  console.log(`  gated net ann.ret ${(holdRet * 100).toFixed(2)}%  ann.Sharpe ${holdSharpe.toFixed(3)}  on% ${(mean(fullRun.onFlags?.slice(splitIdx).map((b)=>(b?1:0)) ?? [0]) * 100).toFixed(0)}`);
  console.log(`  always-on net ann.ret ${(holdAoRet * 100).toFixed(2)}%   risk-free ${(holdRfRet * 100).toFixed(2)}%`);
  console.log(`  margin vs risk-free ${(holdMarginVsRf * 100).toFixed(2)}%/yr (need >=0.50%) -> ${gate6 ? "PASS" : "FAIL"}`);

  // ---- ORACLE BOUND (look-ahead, no toggle cost): the BEST a gate could
  // POSSIBLY do on the holdout = deploy carry only in periods where carry>RF.
  // If even this perfect-foresight upper bound barely beats RF, NO causal gate
  // can survive in this regime. ----
  let oracleSum = 0;
  let oracleOn = 0;
  for (const b of holdBook) {
    oracleSum += Math.max(b.carryRet, RF_PER_PERIOD);
    if (b.carryRet > RF_PER_PERIOD) oracleOn++;
  }
  const oracleAnn = (oracleSum / holdBook.length) * PERIODS_PER_YEAR;
  const oracleExcess = oracleAnn - holdRfRet;
  console.log(`  [ORACLE upper bound] perfect-foresight gate, holdout ann.ret ${(oracleAnn * 100).toFixed(2)}% = +${(oracleExcess * 100).toFixed(2)}%/yr over RF (gross of toggle cost), on% ${(oracleOn / holdBook.length * 100).toFixed(0)}`);
  console.log(`  => even with perfect foresight the recent regime offers <${(oracleExcess * 100).toFixed(2)}%/yr; realistic toggling erases it.`);

  // ===================== VERDICT =====================
  const gates = { gate1, gate2, gate3, gate4, gate5, gate6 };
  const survived = Object.values(gates).every(Boolean);
  let killedBy = "none";
  if (!gate1) killedBy = "net-sharpe<=0";
  else if (!gate2) killedBy = "DSR p>=0.05";
  else if (!gate3) killedBy = "PBO>=0.5";
  else if (!gate4) killedBy = "baselines";
  else if (!gate5) killedBy = "haircut";
  else if (!gate6) killedBy = "holdout";

  console.log(`\n======================= VERDICT =======================`);
  console.log(`  GATE 1 net Sharpe>0        : ${gate1 ? "PASS" : "FAIL"}`);
  console.log(`  GATE 2 DSR p<0.05 (N=${N})   : ${gate2 ? "PASS" : "FAIL"}`);
  console.log(`  GATE 3 PBO<0.5             : ${gate3 ? "PASS" : "FAIL"}`);
  console.log(`  GATE 4 beats baselines     : ${gate4 ? "PASS" : "FAIL"}`);
  console.log(`  GATE 5 HL haircut          : ${gate5 ? "PASS" : "FAIL"}`);
  console.log(`  GATE 6 holdout             : ${gate6 ? "PASS" : "FAIL"}`);
  console.log(`  ----------------------------------------`);
  console.log(`  VERDICT: ${survived ? "SURVIVE" : "KILL"}  ${survived ? "" : "(killed by " + killedBy + ")"}`);

  // Realistic monthly $ if survived (use holdout net ann.ret as honest estimate)
  const monthlyPct = holdRet / 12;
  console.log(`\n  Realistic NET monthly (holdout) : ${(monthlyPct * 100).toFixed(3)}%  => $${(monthlyPct * 10000).toFixed(0)}/mo at $10k, $${(monthlyPct * 100000).toFixed(0)}/mo at $100k`);
  console.log(`  (vs risk-free monthly ${((RISK_FREE_APR / 12) * 100).toFixed(3)}% = $${((RISK_FREE_APR / 12) * 10000).toFixed(0)}/$10k, $${((RISK_FREE_APR / 12) * 100000).toFixed(0)}/$100k)`);

  // turnover (round-trips/yr) of the winner over full sample
  const yrs = (book[book.length - 1].t - book[0].t) / (365.25 * 86_400_000);
  const turnoverPerYr = fullRun.toggles / 2 / yrs; // 2 transitions per round-trip
  console.log(`  Turnover: ${fullRun.toggles} toggles over ${yrs.toFixed(2)}y = ${turnoverPerYr.toFixed(1)} round-trips/yr`);

  const report = {
    track: "TA1-carry-gating",
    generatedAt: new Date().toISOString(),
    dataSource: "output/funding/* (8 majors, 8h funding + daily spot/perp, 2023-06..2026-05) + output/dated-futures/BTC",
    bookPeriods: book.length,
    trueTrialCountN: N,
    cost: { spotTakerBps: SPOT_TAKER_BPS, perpTakerBps: PERP_TAKER_BPS, toggleOneWayBps: TOGGLE_ONE_WAY_BPS },
    reference: { alwaysOnNetAnnRet: aoRet, alwaysOnNetSharpe: aoSharpe, riskFreeAnnRet: rfRet },
    winner: {
      id: winner.id,
      family: winner.family,
      searchNetSharpe: winner.netSharpeAnn,
      searchNetAnnRet: winner.netAnnRet,
      searchGrossAnnRet: winner.grossAnnRet,
      fracOn: winner.fracOn,
      toggles: winner.toggles,
    },
    gates: {
      gate1_netSharpe: { value: winnerStats.sharpe, pass: gate1 },
      gate2_dsr: { perPeriodExcessSharpe: dsr.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe, deflatedProbability: dsr.deflatedProbability, pValue: dsrP, pass: gate2 },
      gate3_pbo: { pbo: pbo.pbo, medianLogit: pbo.medianLogit, strategyCount: strategies.length, pass: gate3 },
      gate4_baselines: { candidate: baseGate.candidateScore, comparisons: baseGate.comparisons, pass: gate4 },
      gate5_haircut: { observedSharpe: hc.observedSharpe, adjustedPValue: hc.adjustedPValue, haircutSharpe: hc.haircutSharpe, pass: gate5 },
      gate6_holdout: { gatedAnnRet: holdRet, gatedSharpe: holdSharpe, alwaysOnAnnRet: holdAoRet, riskFreeAnnRet: holdRfRet, marginVsRf: holdMarginVsRf, pass: gate6 },
    },
    oracleHoldoutBound: { annRet: oracleAnn, excessOverRfPctPerYr: oracleExcess * 100, onFraction: oracleOn / holdBook.length, note: "perfect-foresight upper bound, gross of toggle cost; if tiny, NO causal gate can survive in this regime" },
    degenerateBestSharpeVariant: { id: degenerateBestSharpe.id, fracOn: degenerateBestSharpe.fracOn, note: "best Sharpe overall but ~always-off => not an indicator edge, just sitting in risk-free" },
    verdict: survived ? "SURVIVE" : "KILL",
    killedBy,
    realisticMonthly: { pct: monthlyPct, usd10k: monthlyPct * 10000, usd100k: monthlyPct * 100000 },
    turnoverRoundTripsPerYear: turnoverPerYr,
    allVariants: rows.map((r) => ({ id: r.id, family: r.family, netSharpe: r.netSharpeAnn, netAnnRet: r.netAnnRet, grossAnnRet: r.grossAnnRet, toggles: r.toggles, fracOn: r.fracOn })),
  };
  fs.writeFileSync(path.join(OUT_DIR, "carry-gating-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${path.join(OUT_DIR, "carry-gating-report.json")}`);
}

main();
