/**
 * FRONT R4 — Genetic-programming search over COMBINED structural + technical
 * decision rules for a delta-neutral carry book.
 *
 * The thesis under test: a REAL evolutionary search (population, tournament
 * selection, crossover, mutation, elitism, ~40 generations, honest N = unique
 * genomes) — given for the FIRST TIME the structural primitives that are the only
 * things that ever survived in this project (funding LEVEL, funding MOMENTUM,
 * perp-spot premium, dated-basis term-structure SLOPE, plus their cross-sectional
 * ranks) ALONGSIDE technical primitives — can it discover a regime/selection rule
 * for the carry book that the hand-built tests (E2/T8/TA1/WF-D) did not? Or does it
 * just confirm the hand-built conclusion that the recent regime is compressed and
 * there is < ~0.5%/yr of harvestable carry over risk-free?
 *
 * The genome evolves a boolean DEPLOY rule. When the rule fires we hold the
 * diversified delta-neutral carry book (collect equal-weight funding) for that 8h
 * period; otherwise we sit in risk-free. Every ON<->OFF transition pays a realistic
 * 14bps toggle cost (10bps spot + 4bps perp, one way). Fitness = annualized
 * EXCESS-over-RF of the NET return series on the in-sample window (carry only has
 * to beat parking cash, exactly like WF-D / the hand-built carry tests).
 *
 * RIGOR (all committed gates from src/lib/training/):
 *   - honest N for DSR = TOTAL UNIQUE GENOMES evaluated across all generations.
 *   - consume-once holdout: last ~18% is NEVER seen by the search; scored ONCE.
 *   - beat buy-and-hold (= always-on carry) + random-lottery + random-RULE
 *     (random genomes, same machinery) + the always-on carry baseline + RF 4.5%.
 *   - DSR (computeDeflatedSharpeRatio) at honest N on the holdout excess-vs-RF.
 *   - SURROGATE/PLACEBO control (the methodological hero): run the IDENTICAL
 *     GA on phase-randomized AND block-bootstrap surrogates of the per-period
 *     carry/funding series (preserve vol + short-range autocorr, DESTROY genuine
 *     regime/structure). If the GA finds equal-or-better holdout edge on surrogates,
 *     the real champion is an ARTIFACT of the optimizer, not a real signal.
 *   - oracle ceiling (perfect-foresight) sanity check on the holdout.
 *
 * Daily returns are used for the gate digests (8h would be >1e5 bars and overflow
 * summarizeReturnSeries's Math.min spread; we aggregate to daily blocks — the
 * conservative/honest choice flagged in the brief).
 *
 * No BigQuery, no training loop, no Next.js. Free local data only.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/front-r4/ga-structural-carry.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  normalCdf,
} from "../../src/lib/statistical-validation";
import {
  evaluateBaselineGate,
  baselineScoreFromReturns,
  buildRandomLotteryBaseline,
  type BaselineScore,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";

const ROOT = process.cwd();
const FUND_DIR = path.join(ROOT, "output/funding");
const DATED_DIR = path.join(ROOT, "output/dated-futures");
const OUT_DIR = path.join(ROOT, "output/front-r4");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Cost & regime constants — IDENTICAL to WF-D / TA1 so comparisons are apples-to-apples.
// ---------------------------------------------------------------------------
const SPOT_TAKER_BPS = 10; // per side, spot leg
const PERP_TAKER_BPS = 4; // per side, perp leg
const TOGGLE_ONE_WAY_BPS = SPOT_TAKER_BPS + PERP_TAKER_BPS; // 14 bps per ON<->OFF transition
const TOGGLE_COST = TOGGLE_ONE_WAY_BPS / 10_000;
const RISK_FREE_APR = 0.045;
const PERIODS_PER_YEAR = 1095.75; // 3 funding settlements/day (8h)
const RF_PER_PERIOD = RISK_FREE_APR / PERIODS_PER_YEAR;
// Crypto trades 365 days/yr (no weekends). Daily blocks = one calendar day, so
// annualize by 365.25 and use RF/365.25 as the per-day risk-free rate. Using 252
// here would mis-state the RF baseline as a fake negative excess.
const DAYS_PER_YEAR = 365.25;
const ANNUALIZE_SHARPE = Math.sqrt(DAYS_PER_YEAR); // daily-block Sharpe annualization

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
interface DatedContract {
  symbol: string;
  deliveryDate: string;
  rows: { date: string; future: number; spot: number; basis: number }[];
}

function loadFunding(sym: string): FundingPt[] {
  return JSON.parse(fs.readFileSync(path.join(FUND_DIR, `${sym}_funding_8h.json`), "utf8"));
}
function loadPrices(sym: string): PricePt[] {
  return JSON.parse(fs.readFileSync(path.join(FUND_DIR, `${sym}_prices_daily.json`), "utf8"));
}
function loadDated(coin: "BTC" | "ETH"): DatedContract[] {
  const p = path.join(DATED_DIR, `${coin}_quarterly_basis.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Per-date ANNUALIZED dated-basis term-structure slope (front, nearest non-expired
// contract). slope = basis / (daysToDelivery/365). Averages BTC & ETH where both exist.
function buildDatedSlopeMap(): Map<string, number> {
  const byDate = new Map<string, number[]>();
  for (const coin of ["BTC", "ETH"] as const) {
    for (const c of loadDated(coin)) {
      const delivery = Date.parse(c.deliveryDate);
      for (const r of c.rows) {
        const d = Date.parse(r.date);
        const daysToDelivery = (delivery - d) / 86_400_000;
        if (daysToDelivery < 5) continue; // skip the last few days (degenerate annualization)
        const annSlope = r.basis / (daysToDelivery / 365);
        if (!Number.isFinite(annSlope)) continue;
        // Prefer the NEAREST contract per date: keep the smallest daysToDelivery.
        // We store [annSlope, daysToDelivery] and resolve later by picking min dtd.
        const arr = byDate.get(r.date) ?? [];
        arr.push(annSlope); // multiple contracts/date; we'll average front ones
        byDate.set(r.date, arr);
      }
    }
  }
  // Resolve: per date use the MEDIAN of available annualized slopes (robust to the
  // far contract). Good enough as a structural "is the curve in contango" signal.
  const out = new Map<string, number>();
  for (const [date, arr] of byDate) {
    arr.sort((a, b) => a - b);
    const mid = arr[Math.floor(arr.length / 2)];
    out.set(date, mid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build per-symbol 8h period series and the diversified book aligned on time union.
// Each book period carries the STRUCTURAL primitive raw values (computed CAUSALLY
// at feature-build time below).
// ---------------------------------------------------------------------------
interface SymPeriod {
  t: number;
  date: string;
  funding: number; // 8h funding rate
  premium: number; // perp/spot - 1 (daily, that date)
}
function buildPeriods(sym: string): SymPeriod[] {
  const fund = loadFunding(sym);
  const prices = loadPrices(sym);
  const premMap = new Map<string, number>();
  for (const p of prices) if (p.spotClose > 0) premMap.set(p.date, p.perpClose / p.spotClose - 1);
  const out: SymPeriod[] = [];
  for (const f of fund) {
    const date = new Date(f.fundingTime).toISOString().slice(0, 10);
    const prem = premMap.get(date);
    if (prem === undefined) continue;
    out.push({ t: f.fundingTime, date, funding: f.fundingRate, premium: prem });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// A BookPeriod is one 8h slot of the equal-weight diversified delta-neutral book.
// carryRet = equal-weight funding collected that 8h. Structural primitives are
// computed strictly-causally (only data < this period) and stored as the FEATURE
// vector the genome reads.
interface BookPeriod {
  t: number;
  date: string;
  carryRet: number; // equal-weight funding this 8h (the edge if ON)
  feats: Float64Array; // causal primitive values
}

// Feature primitive registry. Each is computed causally in buildBook().
const FEATURE_NAMES = [
  "fundingLevel", // trailing-mean funding richness (10d), z-ish raw
  "fundingMom", // funding momentum: short trailing mean - longer trailing mean
  "premium", // mean perp-spot premium across symbols (level)
  "premiumMom", // premium momentum (short - long trailing)
  "basisSlope", // dated-futures annualized term-structure slope (BTC/ETH median)
  "xsFundingRank", // cross-sectional rank of current funding vs trailing dist (0..1)
  "xsPremiumRank", // cross-sectional rank of premium vs trailing dist (0..1)
  "priceMom", // technical: trailing price momentum of the book proxy (BTC)
  "vol", // technical: trailing realized vol of book proxy
  "meanRev", // technical: short-term mean-reversion (neg of recent return)
] as const;
type FeatName = (typeof FEATURE_NAMES)[number];
const NFEAT = FEATURE_NAMES.length;
const FIDX: Record<FeatName, number> = Object.fromEntries(
  FEATURE_NAMES.map((n, i) => [n, i]),
) as Record<FeatName, number>;

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}
function trailingRank(window: number[], value: number): number {
  // fraction of window strictly below value -> [0,1]
  if (window.length === 0) return 0.5;
  let below = 0;
  for (const w of window) if (w < value) below++;
  return below / window.length;
}

// Build the diversified book + the causal feature matrix.
function buildBook(): { book: BookPeriod[]; btcPrices: PricePt[] } {
  const perSym = new Map<string, SymPeriod[]>();
  const allTimes = new Set<number>();
  for (const sym of SYMBOLS) {
    const p = buildPeriods(sym);
    perSym.set(sym, p);
    for (const x of p) allTimes.add(x.t);
  }
  const idx = new Map<string, Map<number, SymPeriod>>();
  for (const sym of SYMBOLS) {
    const m = new Map<number, SymPeriod>();
    for (const x of perSym.get(sym)!) m.set(x.t, x);
    idx.set(sym, m);
  }
  const times = [...allTimes].sort((a, b) => a - b);
  const slopeMap = buildDatedSlopeMap();
  const btcPrices = loadPrices("BTCUSDT");
  const btcRetByDate = new Map<string, number>();
  for (let i = 1; i < btcPrices.length; i++) {
    const r = btcPrices[i].spotClose / btcPrices[i - 1].spotClose - 1;
    btcRetByDate.set(btcPrices[i].date, r);
  }

  // First pass: per-period aggregate raw quantities (funding, premium) and carryRet.
  interface Raw {
    t: number;
    date: string;
    carryRet: number;
    meanFunding: number;
    meanPremium: number;
    rawFundings: number[]; // per-symbol funding (for xs rank)
    rawPremiums: number[];
  }
  const raws: Raw[] = [];
  for (const t of times) {
    const fundings: number[] = [];
    const premiums: number[] = [];
    let date = "";
    for (const sym of SYMBOLS) {
      const x = idx.get(sym)!.get(t);
      if (!x) continue;
      fundings.push(x.funding);
      premiums.push(x.premium);
      date = x.date;
    }
    if (fundings.length === 0) continue;
    raws.push({
      t,
      date,
      carryRet: mean(fundings),
      meanFunding: mean(fundings),
      meanPremium: mean(premiums),
      rawFundings: fundings,
      rawPremiums: premiums,
    });
  }

  // Lookback windows (in 8h periods).
  const LB_SHORT = 30; // ~10d
  const LB_LONG = 90; // ~30d
  const LB_RANK = 270; // ~90d trailing distribution for xs rank

  const book: BookPeriod[] = [];
  for (let i = 0; i < raws.length; i++) {
    const r = raws[i];
    const feats = new Float64Array(NFEAT);
    // Causal trailing slices STRICTLY before i.
    const fundHistShort = raws.slice(Math.max(0, i - LB_SHORT), i).map((x) => x.meanFunding);
    const fundHistLong = raws.slice(Math.max(0, i - LB_LONG), i).map((x) => x.meanFunding);
    const fundHistRank = raws.slice(Math.max(0, i - LB_RANK), i).map((x) => x.meanFunding);
    const premHistShort = raws.slice(Math.max(0, i - LB_SHORT), i).map((x) => x.meanPremium);
    const premHistLong = raws.slice(Math.max(0, i - LB_LONG), i).map((x) => x.meanPremium);
    const premHistRank = raws.slice(Math.max(0, i - LB_RANK), i).map((x) => x.meanPremium);

    feats[FIDX.fundingLevel] = mean(fundHistShort); // trailing richness (causal)
    feats[FIDX.fundingMom] = mean(fundHistShort) - mean(fundHistLong);
    feats[FIDX.premium] = mean(premHistShort);
    feats[FIDX.premiumMom] = mean(premHistShort) - mean(premHistLong);
    feats[FIDX.basisSlope] = slopeMap.get(r.date) ?? 0;
    feats[FIDX.xsFundingRank] = trailingRank(fundHistRank, r.meanFunding);
    feats[FIDX.xsPremiumRank] = trailingRank(premHistRank, r.meanPremium);

    // Technical primitives on BTC spot proxy (causal): use daily returns up to the
    // PREVIOUS calendar date relative to this period.
    const dateIdx = btcPrices.findIndex((p) => p.date === r.date);
    if (dateIdx > 0) {
      const startMom = Math.max(0, dateIdx - 10);
      const retsMom: number[] = [];
      for (let k = startMom + 1; k <= dateIdx; k++) {
        retsMom.push(btcPrices[k].spotClose / btcPrices[k - 1].spotClose - 1);
      }
      feats[FIDX.priceMom] = retsMom.reduce((a, b) => a + b, 0);
      const startVol = Math.max(0, dateIdx - 20);
      const retsVol: number[] = [];
      for (let k = startVol + 1; k <= dateIdx; k++) {
        retsVol.push(btcPrices[k].spotClose / btcPrices[k - 1].spotClose - 1);
      }
      feats[FIDX.vol] = std(retsVol);
      const startMR = Math.max(0, dateIdx - 3);
      const retsMR: number[] = [];
      for (let k = startMR + 1; k <= dateIdx; k++) {
        retsMR.push(btcPrices[k].spotClose / btcPrices[k - 1].spotClose - 1);
      }
      feats[FIDX.meanRev] = -retsMR.reduce((a, b) => a + b, 0); // contrarian sign
    }

    book.push({ t: r.t, date: r.date, carryRet: r.carryRet, feats });
  }
  return { book, btcPrices };
}

// ---------------------------------------------------------------------------
// PRIMITIVE NORMALIZATION: per-feature in-sample median + IQR so the GA's
// thresholds operate on a comparable scale. Computed ONLY on the search window
// (no holdout leakage). Returns center[] and scale[].
// ---------------------------------------------------------------------------
function fitNormalizer(book: BookPeriod[], range: [number, number]) {
  const center = new Float64Array(NFEAT);
  const scale = new Float64Array(NFEAT);
  for (let f = 0; f < NFEAT; f++) {
    const vals: number[] = [];
    for (let i = range[0]; i < range[1]; i++) vals.push(book[i].feats[f]);
    vals.sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const q1 = vals[Math.floor(vals.length * 0.25)];
    const q3 = vals[Math.floor(vals.length * 0.75)];
    center[f] = med;
    scale[f] = Math.max(1e-9, q3 - q1);
  }
  return { center, scale };
}
function normFeat(book: BookPeriod[], i: number, f: number, norm: { center: Float64Array; scale: Float64Array }): number {
  return (book[i].feats[f] - norm.center[f]) / norm.scale[f];
}

// ---------------------------------------------------------------------------
// GENOME: a boolean DEPLOY rule = AND/OR tree of leaf comparisons. To keep the
// search space tractable and interpretable, a genome is a small fixed structure:
//   deploy(i) = OR over up to MAXCLAUSES clauses; each clause = AND over up to
//   MAXLITS literals; each literal = (feature CMP threshold) possibly NEGATED.
// This is a disjunctive-normal-form (DNF) rule — expressive enough to encode
// "funding-rich AND basis-positive AND vol-low, else flat", regime gates, hybrids.
// Crossover swaps clauses; mutation perturbs literals/thresholds/structure.
// ---------------------------------------------------------------------------
interface Literal {
  feat: number; // 0..NFEAT-1
  gt: boolean; // true: feature > thr; false: feature < thr
  thr: number; // threshold in NORMALIZED units (roughly z/IQR scale)
}
interface Clause {
  lits: Literal[]; // AND of these
}
interface Genome {
  clauses: Clause[]; // OR of these
}
const MAX_CLAUSES = 3;
const MAX_LITS = 3;

function genomeKey(g: Genome): string {
  // canonical structural key for honest-N uniqueness (round thresholds to 3dp).
  const cl = g.clauses
    .map((c) =>
      c.lits
        .map((l) => `${l.feat}${l.gt ? ">" : "<"}${l.thr.toFixed(3)}`)
        .sort()
        .join("&"),
    )
    .sort()
    .join("|");
  return cl;
}

function evalGenome(g: Genome, book: BookPeriod[], i: number, norm: { center: Float64Array; scale: Float64Array }): boolean {
  if (g.clauses.length === 0) return false;
  for (const c of g.clauses) {
    if (c.lits.length === 0) continue;
    let allTrue = true;
    for (const l of c.lits) {
      const v = normFeat(book, i, l.feat, norm);
      const ok = l.gt ? v > l.thr : v < l.thr;
      if (!ok) {
        allTrue = false;
        break;
      }
    }
    if (allTrue) return true; // OR short-circuit
  }
  return false;
}

// Deterministic PRNG (LCG) — reproducible GA + surrogate runs.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randLiteral(rng: () => number): Literal {
  return {
    feat: Math.floor(rng() * NFEAT),
    gt: rng() < 0.5,
    thr: (rng() * 2 - 1) * 1.5, // thresholds in [-1.5,1.5] normalized units
  };
}
function randClause(rng: () => number): Clause {
  const n = 1 + Math.floor(rng() * MAX_LITS);
  return { lits: Array.from({ length: n }, () => randLiteral(rng)) };
}
function randGenome(rng: () => number): Genome {
  const n = 1 + Math.floor(rng() * MAX_CLAUSES);
  return { clauses: Array.from({ length: n }, () => randClause(rng)) };
}

function cloneGenome(g: Genome): Genome {
  return {
    clauses: g.clauses.map((c) => ({ lits: c.lits.map((l) => ({ ...l })) })),
  };
}

function crossover(a: Genome, b: Genome, rng: () => number): Genome {
  // clause-level uniform crossover, then clamp clause count.
  const pool = [...a.clauses, ...b.clauses].map((c) => ({ lits: c.lits.map((l) => ({ ...l })) }));
  // shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const n = 1 + Math.floor(rng() * MAX_CLAUSES);
  return { clauses: pool.slice(0, n) };
}

function mutate(g: Genome, rng: () => number): Genome {
  const m = cloneGenome(g);
  const roll = rng();
  if (roll < 0.35 && m.clauses.length > 0) {
    // perturb a threshold or flip gt on a random literal
    const c = m.clauses[Math.floor(rng() * m.clauses.length)];
    if (c.lits.length > 0) {
      const l = c.lits[Math.floor(rng() * c.lits.length)];
      if (rng() < 0.5) l.thr += (rng() * 2 - 1) * 0.5;
      else l.gt = !l.gt;
      l.thr = Math.max(-3, Math.min(3, l.thr));
    }
  } else if (roll < 0.55 && m.clauses.length > 0) {
    // change a literal's feature
    const c = m.clauses[Math.floor(rng() * m.clauses.length)];
    if (c.lits.length > 0) c.lits[Math.floor(rng() * c.lits.length)].feat = Math.floor(rng() * NFEAT);
  } else if (roll < 0.7) {
    // add a literal to a random clause
    if (m.clauses.length > 0) {
      const c = m.clauses[Math.floor(rng() * m.clauses.length)];
      if (c.lits.length < MAX_LITS) c.lits.push(randLiteral(rng));
    }
  } else if (roll < 0.82 && m.clauses.length > 0) {
    // drop a literal
    const c = m.clauses[Math.floor(rng() * m.clauses.length)];
    if (c.lits.length > 1) c.lits.splice(Math.floor(rng() * c.lits.length), 1);
  } else if (roll < 0.92 && m.clauses.length < MAX_CLAUSES) {
    // add a clause
    m.clauses.push(randClause(rng));
  } else if (m.clauses.length > 1) {
    // drop a clause
    m.clauses.splice(Math.floor(rng() * m.clauses.length), 1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Backtest a genome (or any onAt predicate) over a book range with realistic
// toggle cost. Returns per-period NET return series + diagnostics.
// ---------------------------------------------------------------------------
interface RunResult {
  net: number[];
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
  const onFlags: boolean[] = [];
  let prevOn = prevOnInit;
  let toggles = 0;
  let onCount = 0;
  for (let i = range[0]; i < range[1]; i++) {
    const on = onAt(i);
    const base = on ? book[i].carryRet : RF_PER_PERIOD;
    let cost = 0;
    if (on !== prevOn) {
      cost = TOGGLE_COST;
      toggles++;
    }
    net.push(base - cost);
    onFlags.push(on);
    if (on) onCount++;
    prevOn = on;
  }
  return { net, onFlags, toggles, onCount };
}

function alwaysOnNet(book: BookPeriod[], range: [number, number]): number[] {
  const net: number[] = [];
  for (let i = range[0]; i < range[1]; i++) {
    let c = book[i].carryRet;
    if (i === range[0]) c -= TOGGLE_COST;
    net.push(c);
  }
  return net;
}
function flatRiskFree(range: [number, number]): number[] {
  return new Array(range[1] - range[0]).fill(RF_PER_PERIOD);
}

// Aggregate an 8h NET series to DAILY blocks (3 periods/day) by COMPOUNDING within
// the day — the honest choice to keep gate inputs < 1e5 and avoid the Math.min
// spread overflow. dates[] is parallel to the 8h series.
function toDailyBlocks(net: number[], dates: string[]): number[] {
  const byDate = new Map<string, number[]>();
  const order: string[] = [];
  for (let i = 0; i < net.length; i++) {
    const d = dates[i];
    if (!byDate.has(d)) {
      byDate.set(d, []);
      order.push(d);
    }
    byDate.get(d)!.push(net[i]);
  }
  return order.map((d) => {
    let comp = 1;
    for (const r of byDate.get(d)!) comp *= 1 + r;
    return comp - 1;
  });
}

// Fitness = annualized EXCESS-over-RF of the daily-block net series.
function annDailyExcess(dailyNet: number[]): number {
  const m = mean(dailyNet);
  const rfDaily = RISK_FREE_APR / DAYS_PER_YEAR;
  return (m - rfDaily) * DAYS_PER_YEAR;
}
function fitness(dailyNet: number[]): number {
  // Annualized excess over RF, lightly penalized by daily vol so we don't reward
  // a high-variance lucky path. (Search objective only; gates use raw series.)
  const exc = annDailyExcess(dailyNet);
  const v = std(dailyNet) * Math.sqrt(DAYS_PER_YEAR);
  return exc - 0.05 * v; // tiny vol penalty
}

// ---------------------------------------------------------------------------
// THE GENETIC-PROGRAMMING ENGINE.
// population, tournament selection, single-point clause crossover, mutation,
// elitism, G generations. Returns champion + honest N (unique genomes seen).
// ---------------------------------------------------------------------------
interface GAConfig {
  popSize: number;
  generations: number;
  eliteCount: number;
  tournamentK: number;
  crossoverRate: number;
  mutationRate: number;
  seed: number;
}
interface GAResult {
  champion: Genome;
  championFitness: number;
  uniqueGenomes: number;
  totalEvals: number;
  bestByGen: number[];
}
function runGA(
  book: BookPeriod[],
  searchRange: [number, number],
  dates: string[],
  norm: { center: Float64Array; scale: Float64Array },
  cfg: GAConfig,
): GAResult {
  const rng = makeRng(cfg.seed);
  const seen = new Set<string>();
  const cache = new Map<string, number>();
  let totalEvals = 0;

  const evalFit = (g: Genome): number => {
    const key = genomeKey(g);
    if (cache.has(key)) return cache.get(key)!;
    seen.add(key);
    totalEvals++;
    const res = runOnOff(book, (i) => evalGenome(g, book, i, norm), searchRange, false);
    const sliceDates = dates.slice(searchRange[0], searchRange[1]);
    const daily = toDailyBlocks(res.net, sliceDates);
    const f = fitness(daily);
    cache.set(key, f);
    return f;
  };

  // init population
  let pop: { g: Genome; f: number }[] = Array.from({ length: cfg.popSize }, () => {
    const g = randGenome(rng);
    return { g, f: evalFit(g) };
  });
  const bestByGen: number[] = [];

  for (let gen = 0; gen < cfg.generations; gen++) {
    pop.sort((a, b) => b.f - a.f);
    bestByGen.push(pop[0].f);
    const next: { g: Genome; f: number }[] = [];
    // elitism
    for (let e = 0; e < cfg.eliteCount; e++) next.push({ g: cloneGenome(pop[e].g), f: pop[e].f });
    // tournament selection -> crossover + mutation
    const pick = (): Genome => {
      let best: { g: Genome; f: number } | null = null;
      for (let k = 0; k < cfg.tournamentK; k++) {
        const cand = pop[Math.floor(rng() * pop.length)];
        if (best === null || cand.f > best.f) best = cand;
      }
      return best!.g;
    };
    while (next.length < cfg.popSize) {
      let child: Genome;
      if (rng() < cfg.crossoverRate) child = crossover(pick(), pick(), rng);
      else child = cloneGenome(pick());
      if (rng() < cfg.mutationRate) child = mutate(child, rng);
      next.push({ g: child, f: evalFit(child) });
    }
    pop = next;
  }
  pop.sort((a, b) => b.f - a.f);
  return {
    champion: pop[0].g,
    championFitness: pop[0].f,
    uniqueGenomes: seen.size,
    totalEvals,
    bestByGen,
  };
}

// ---------------------------------------------------------------------------
// SURROGATE constructors (operate on the per-period carryRet series). We rebuild
// a surrogate book that keeps EVERYTHING (dates, feature matrix) the same but
// replaces carryRet (the actual edge) with a structure-destroyed series of the
// same vol/autocorr. This isolates "does the machinery earn on noise carry".
// We ALSO surrogate the funding-derived features that depend on carryRet so the
// genome cannot exploit a leftover real signal — but premium/basis/technical
// features carry their own structure; the cleanest placebo destroys the CARRY
// edge that fitness optimizes. (Strongest test: a genome can only earn by timing
// real carryRet; if surrogate carryRet has no timeable structure, no rule helps.)
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
function phaseRandomize(x: number[], rng: () => number): number[] {
  const n = x.length;
  const m = mean(x);
  const xc = x.map((v) => v - m);
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
  const mag = re.map((r, k) => Math.hypot(r, im[k]));
  const phase = new Array<number>(n).fill(0);
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k++) {
    const p = (rng() * 2 - 1) * Math.PI;
    phase[k] = p;
    if (k < n - k) phase[n - k] = -p;
  }
  const nre = mag.map((mg, k) => mg * Math.cos(phase[k]));
  const nim = mag.map((mg, k) => mg * Math.sin(phase[k]));
  if (n % 2 === 0) nim[half] = 0;
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

// Rebuild a surrogate book: carryRet replaced; the funding-derived features
// (fundingLevel/fundingMom/xsFundingRank) recomputed from the surrogate carry so
// they stay self-consistent with the noise series. premium/basis/technical feats
// are KEPT (they carry their own real structure; the GA may still try to use them,
// which is the point — can ANY combination time noise carry?).
function buildSurrogateBook(
  base: BookPeriod[],
  kind: "block" | "phase",
  rng: () => number,
): BookPeriod[] {
  const carry = base.map((b) => b.carryRet);
  const surrCarry = kind === "block" ? blockShuffle(carry, 90, rng) : phaseRandomize(carry, rng);
  const LB_SHORT = 30;
  const LB_LONG = 90;
  const LB_RANK = 270;
  const out: BookPeriod[] = base.map((b, i) => {
    const feats = Float64Array.from(b.feats); // copy
    return { t: b.t, date: b.date, carryRet: surrCarry[i], feats };
  });
  // recompute funding-derived features from surrogate carry (causal)
  for (let i = 0; i < out.length; i++) {
    const hs = surrCarry.slice(Math.max(0, i - LB_SHORT), i);
    const hl = surrCarry.slice(Math.max(0, i - LB_LONG), i);
    const hr = surrCarry.slice(Math.max(0, i - LB_RANK), i);
    out[i].feats[FIDX.fundingLevel] = mean(hs);
    out[i].feats[FIDX.fundingMom] = mean(hs) - mean(hl);
    out[i].feats[FIDX.xsFundingRank] = trailingRank(hr, surrCarry[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Oracle (perfect-foresight) ceiling on a range: deploy carry only where
// carryRet > RF_PER_PERIOD, gross of toggle cost. Annualized excess over RF.
// ---------------------------------------------------------------------------
function oracleAnnExcess(book: BookPeriod[], range: [number, number], dates: string[]): number {
  const net: number[] = [];
  for (let i = range[0]; i < range[1]; i++) {
    net.push(Math.max(book[i].carryRet, RF_PER_PERIOD));
  }
  const daily = toDailyBlocks(net, dates.slice(range[0], range[1]));
  return annDailyExcess(daily);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function pct(v: number): string {
  return `${(v * 100).toFixed(3)}%`;
}

function main() {
  const log: string[] = [];
  const say = (s: string) => {
    console.log(s);
    log.push(s);
  };

  say("=".repeat(78));
  say("FRONT R4 — GA over COMBINED structural + technical carry-deployment rules");
  say("=".repeat(78));

  const { book } = buildBook();
  const dates = book.map((b) => b.date);
  say(`Book: ${book.length} 8h periods, ${new Set(dates).size} unique days, ${dates[0]} -> ${dates[dates.length - 1]}`);
  say(`Symbols (equal-weight delta-neutral book): ${SYMBOLS.join(", ")}`);
  say(`Primitives (${NFEAT}): ${FEATURE_NAMES.join(", ")}`);
  say(`Cost: ${TOGGLE_ONE_WAY_BPS}bps per ON<->OFF toggle. RF ${(RISK_FREE_APR * 100).toFixed(1)}%/yr. ${PERIODS_PER_YEAR} periods/yr.`);

  // ---- splits: consume-once holdout = last 18% (never seen by search) ----
  const N = book.length;
  const holdoutFrac = 0.18;
  const holdoutStart = Math.floor(N * (1 - holdoutFrac));
  const searchRange: [number, number] = [0, holdoutStart];
  const holdRange: [number, number] = [holdoutStart, N];
  say("");
  say(`Split: search [0,${holdoutStart}) = ${holdoutStart} periods (${dates[0]}..${dates[holdoutStart - 1]});`);
  say(`       HOLDOUT [${holdoutStart},${N}) = ${N - holdoutStart} periods (${dates[holdoutStart]}..${dates[N - 1]}) — consume ONCE.`);

  // Normalizer fit on SEARCH window only (no leakage).
  const norm = fitNormalizer(book, searchRange);

  // ---- GA config ----
  const cfg: GAConfig = {
    popSize: 120,
    generations: 45,
    eliteCount: 6,
    tournamentK: 4,
    crossoverRate: 0.7,
    mutationRate: 0.6,
    seed: 12345,
  };
  say("");
  say(`GA: pop=${cfg.popSize}, gens=${cfg.generations}, elite=${cfg.eliteCount}, tournK=${cfg.tournamentK}, xover=${cfg.crossoverRate}, mut=${cfg.mutationRate}`);

  say("");
  say(">> Evolving on REAL data...");
  const t0 = Date.now();
  const ga = runGA(book, searchRange, dates, norm, cfg);
  say(`   done in ${((Date.now() - t0) / 1000).toFixed(1)}s. unique genomes (honest N) = ${ga.uniqueGenomes}, total evals = ${ga.totalEvals}`);
  say(`   best-fitness by gen [first..last]: ${ga.bestByGen[0].toFixed(4)} .. ${ga.bestByGen[ga.bestByGen.length - 1].toFixed(4)} (excess-over-RF ann, vol-penalized)`);

  // Champion description (human-readable rule).
  const describe = (g: Genome): string => {
    if (g.clauses.length === 0) return "ALWAYS FLAT";
    return g.clauses
      .map(
        (c) =>
          "(" +
          c.lits
            .map((l) => `${FEATURE_NAMES[l.feat]} ${l.gt ? ">" : "<"} ${l.thr.toFixed(2)}σ`)
            .join(" AND ") +
          ")",
      )
      .join(" OR ");
  };
  const championDesc = `DEPLOY carry IF ${describe(ga.champion)} ELSE risk-free`;
  say("");
  say(`CHAMPION RULE: ${championDesc}`);

  // ---- In-sample champion diagnostics ----
  const isRun = runOnOff(book, (i) => evalGenome(ga.champion, book, i, norm), searchRange, false);
  const isDaily = toDailyBlocks(isRun.net, dates.slice(searchRange[0], searchRange[1]));
  const isExc = annDailyExcess(isDaily);
  const isOnFrac = isRun.onCount / (searchRange[1] - searchRange[0]);
  say(`In-sample: ann excess-over-RF ${pct(isExc)}, on% ${(isOnFrac * 100).toFixed(0)}, toggles ${isRun.toggles}`);

  // =========================================================================
  // CONSUME-ONCE HOLDOUT EVALUATION (scored exactly once).
  // =========================================================================
  say("");
  say("=".repeat(78));
  say("CONSUME-ONCE HOLDOUT (scored once)");
  say("=".repeat(78));

  // Champion on holdout (carry state carries over from end of search window).
  const isLastOn = isRun.onFlags[isRun.onFlags.length - 1] ?? false;
  const holdRun = runOnOff(book, (i) => evalGenome(ga.champion, book, i, norm), holdRange, isLastOn);
  const holdDates = dates.slice(holdRange[0], holdRange[1]);
  const champDaily = toDailyBlocks(holdRun.net, holdDates);
  const champExc = annDailyExcess(champDaily);
  const champOnFrac = holdRun.onCount / (holdRange[1] - holdRange[0]);

  // Baselines on holdout (daily blocks).
  const aoNet = alwaysOnNet(book, holdRange);
  const aoDaily = toDailyBlocks(aoNet, holdDates);
  const aoExc = annDailyExcess(aoDaily);
  const rfNet = flatRiskFree(holdRange);
  const rfDaily = toDailyBlocks(rfNet, holdDates);

  // random-RULE baseline: many RANDOM genomes (same machinery), holdout dist of
  // BOTH ann-excess (for the edge gate) and compoundReturn (for the baseline gate).
  const rrRng = makeRng(99);
  const rrExcess: number[] = [];
  const rrCompound: number[] = [];
  for (let s = 0; s < 400; s++) {
    const g = randGenome(rrRng);
    const r = runOnOff(book, (i) => evalGenome(g, book, i, norm), holdRange, false);
    const d = toDailyBlocks(r.net, holdDates);
    rrExcess.push(annDailyExcess(d));
    rrCompound.push(summarizeReturnSeries(d).compoundReturn);
  }
  rrExcess.sort((a, b) => a - b);
  rrCompound.sort((a, b) => a - b);
  const rr95 = rrExcess[Math.floor(0.95 * rrExcess.length)];
  const rr95Compound = rrCompound[Math.floor(0.95 * rrCompound.length)];
  const rrMean = mean(rrExcess);

  // oracle ceiling on holdout.
  const oracleExc = oracleAnnExcess(book, holdRange, dates);

  say(`Champion holdout: ann excess-over-RF ${pct(champExc)}, on% ${(champOnFrac * 100).toFixed(0)}, toggles ${holdRun.toggles}`);
  say(`Always-on carry : ann excess-over-RF ${pct(aoExc)}`);
  say(`Risk-free (4.5%): ann excess-over-RF ${pct(0)} (by definition)`);
  say(`Random-RULE dist: mean ${pct(rrMean)}, 95th ${pct(rr95)} (n=400 random genomes, same machinery)`);
  say(`ORACLE ceiling  : ann excess-over-RF ${pct(oracleExc)} (perfect foresight, gross of toggle) — the hard cap`);

  // Net Sharpe (daily-block, annualized) of champion on holdout.
  const champStats = summarizeReturnSeries(champDaily);
  const champSharpe = champStats.sharpe * ANNUALIZE_SHARPE;
  // Excess-over-RF daily series for DSR (carry has to beat parking cash).
  const rfDailyRate = RISK_FREE_APR / DAYS_PER_YEAR;
  const champExcessSeries = champDaily.map((x) => x - rfDailyRate);
  say(`Champion holdout net Sharpe (daily, ann): ${champSharpe.toFixed(3)}`);

  // =========================================================================
  // SURROGATE / PLACEBO CONTROL — the methodological hero.
  // Run the IDENTICAL GA on block + phase surrogates of carryRet, score each
  // surrogate champion on its OWN surrogate holdout, build the null distribution
  // of "best holdout excess the machinery can manufacture on structure-free carry".
  // placebo p-value = fraction of surrogate champions whose holdout excess >= real.
  // =========================================================================
  say("");
  say("=".repeat(78));
  say("SURROGATE / PLACEBO CONTROL (identical GA machinery on structure-destroyed carry)");
  say("=".repeat(78));
  const SURR_TRIALS = 30; // GA reruns per kind (each is a full evolution)
  const surrResults: { kind: string; holdExcess: number; isExcess: number; onFrac: number }[] = [];
  const surrRng = makeRng(7777);
  for (const kind of ["block", "phase"] as const) {
    const nTrials = kind === "phase" ? Math.min(12, SURR_TRIALS) : SURR_TRIALS; // phase is O(n^2), fewer
    for (let s = 0; s < nTrials; s++) {
      const sbook = buildSurrogateBook(book, kind, makeRng(20000 + (kind === "block" ? 0 : 50000) + s * 131));
      const snorm = fitNormalizer(sbook, searchRange);
      const sga = runGA(sbook, searchRange, dates, snorm, { ...cfg, seed: 30000 + s * 17 + (kind === "block" ? 0 : 999) });
      // score surrogate champion on surrogate HOLDOUT (same machinery + selection)
      const sIs = runOnOff(sbook, (i) => evalGenome(sga.champion, sbook, i, snorm), searchRange, false);
      const sLastOn = sIs.onFlags[sIs.onFlags.length - 1] ?? false;
      const sHold = runOnOff(sbook, (i) => evalGenome(sga.champion, sbook, i, snorm), holdRange, sLastOn);
      const sHoldDaily = toDailyBlocks(sHold.net, holdDates);
      const sHoldExc = annDailyExcess(sHoldDaily);
      const sIsDaily = toDailyBlocks(sIs.net, dates.slice(searchRange[0], searchRange[1]));
      surrResults.push({
        kind,
        holdExcess: sHoldExc,
        isExcess: annDailyExcess(sIsDaily),
        onFrac: sHold.onCount / (holdRange[1] - holdRange[0]),
      });
    }
    say(`   ${kind} surrogate GA reruns: ${nTrials} done`);
  }
  const surrHold = surrResults.map((r) => r.holdExcess).sort((a, b) => a - b);
  const surrHoldMean = mean(surrHold);
  const surrHold95 = surrHold[Math.floor(0.95 * surrHold.length)];
  const surrHoldMax = surrHold[surrHold.length - 1];
  // placebo p-value: fraction of surrogate champions with holdout excess >= real champion
  const placeboP = (surrHold.filter((x) => x >= champExc).length + 1) / (surrHold.length + 1);
  // also report in-sample: did GA fit the surrogates as well as the real in-sample?
  const surrIs = surrResults.map((r) => r.isExcess).sort((a, b) => a - b);
  say("");
  say(`Surrogate GA holdout excess-over-RF: mean ${pct(surrHoldMean)}, 95th ${pct(surrHold95)}, max ${pct(surrHoldMax)} (n=${surrHold.length})`);
  say(`Surrogate GA IN-SAMPLE excess (fit): mean ${pct(mean(surrIs))}, max ${pct(surrIs[surrIs.length - 1])}`);
  say(`REAL champion holdout excess-over-RF: ${pct(champExc)}`);
  say(`PLACEBO p-value (frac surrogate champions with holdout excess >= real): ${placeboP.toFixed(3)}`);
  const surrogateArtifact = champExc <= surrHold95 || placeboP > 0.05;
  say(`=> ${surrogateArtifact
    ? "Surrogate machinery manufactures EQUAL-OR-BETTER 'edge' on structure-free carry => real champion is an ARTIFACT of the search."
    : "Surrogate machinery cannot match the real champion on noise => real edge is NOT a pure search artifact."}`);

  // =========================================================================
  // GATES
  // =========================================================================
  say("");
  say("=".repeat(78));
  say("GATES (committed src/lib/training/)");
  say("=".repeat(78));

  // Honest N for DSR = total unique genomes across the REAL search.
  const honestN = ga.uniqueGenomes;
  const dsr = computeDeflatedSharpeRatio(champExcessSeries, { trialCount: honestN, benchmarkSharpe: 0 });
  const dsrP = 1 - dsr.deflatedProbability;
  const gateDSR = dsr.deflatedProbability >= 0.95; // deflated prob of beating expected-max
  say(`[G1] DSR on holdout excess-vs-RF, honest N=${honestN}: sharpe(perDay) ${dsr.sharpe.toFixed(4)}, expMax ${dsr.expectedMaxSharpe.toFixed(4)}, deflProb ${dsr.deflatedProbability.toFixed(4)}, p=${dsrP.toExponential(2)} -> ${gateDSR ? "PASS" : "FAIL"}`);

  // Haircut Sharpe (Harvey-Liu) at honest N on holdout daily Sharpe.
  const hc = haircutSharpe({ observedSharpe: champStats.sharpe, sampleCount: champDaily.length, trialCount: honestN, method: "bonferroni" });
  say(`[G2] Haircut Sharpe (Bonferroni, N=${honestN}): observed ${champStats.sharpe.toFixed(4)} -> haircut ${hc.haircutSharpe.toFixed(4)} (cut ${(hc.haircut * 100).toFixed(0)}%), adjP ${hc.adjustedPValue.toExponential(2)}`);

  // Baseline gate on holdout compoundReturn (daily blocks): beat buy&hold(always-on),
  // random-lottery, random-rule, always-on carry, AND risk-free.
  const rlottery = buildRandomLotteryBaseline({
    barReturns: aoDaily, // market bars = always-on carry daily returns (the "asset")
    tradeCount: Math.max(1, holdRun.toggles),
    averageHoldingBars: Math.max(1, Math.round((holdRange[1] - holdRange[0]) / 3 / Math.max(1, holdRun.toggles))),
    roundTripCost: TOGGLE_COST,
    iterations: 1000,
    quantile: 0.95,
    seed: "front-r4",
  });
  const baselines: BaselineScore[] = [
    baselineScoreFromReturns("buy_and_hold", "Always-on carry (buy&hold)", aoDaily, { statistic: "compoundReturn" }),
    baselineScoreFromReturns("linear_one_layer", "Risk-free 4.5%", rfDaily, { statistic: "compoundReturn" }),
    { id: "random_rule", label: "Random-RULE 95th (same machinery)", score: rr95Compound, source: "random-genomes:compoundReturn-95th" },
    rlottery_as_baseline(rlottery),
  ];
  const baseGate = evaluateBaselineGate({
    candidateReturns: champDaily,
    baselines,
    statistic: "compoundReturn",
    minMargin: 0,
    requirePositive: true,
  });
  say(`[G3] Baseline gate (holdout compoundReturn): candidate ${pct(baseGate.candidateScore)}`);
  for (const c of baseGate.comparisons) {
    say(`       vs ${c.label}: base ${pct(c.baselineScore)}, margin ${pct(c.margin)} -> ${c.beaten ? "beat" : "FAIL"}`);
  }
  say(`     beatsAll=${baseGate.beatsAll}, passed=${baseGate.passed}`);

  // Edge vs RF must exceed the WF-D / oracle-bounded threshold (>=0.50%/yr).
  const edgeVsRf = champExc; // already excess over RF
  const gateEdge = edgeVsRf >= 0.005;
  say(`[G4] Holdout edge vs RF: ${pct(edgeVsRf)} (need >= 0.500%/yr) -> ${gateEdge ? "PASS" : "FAIL"}`);

  // Surrogate gate.
  const gateSurr = !surrogateArtifact;
  say(`[G5] Surrogate/placebo clean? ${gateSurr ? "PASS (machinery earns ~nothing on noise)" : "FAIL (machinery earns on noise => artifact)"} (placebo p=${placeboP.toFixed(3)})`);

  // Random-rule beat.
  const gateRandRule = champExc > rr95;
  say(`[G6] Beat random-RULE 95th: champ ${pct(champExc)} vs ${pct(rr95)} -> ${gateRandRule ? "PASS" : "FAIL"}`);

  // ---- VERDICT ----
  const survived = gateDSR && baseGate.passed && gateEdge && gateSurr && gateRandRule;
  say("");
  say("=".repeat(78));
  say(`VERDICT: ${survived ? "SURVIVE" : "KILL"}`);
  say("=".repeat(78));
  say(`  Q1 DSR pass (honest N=${honestN})?           ${gateDSR ? "YES" : "NO"}`);
  say(`  Q2 beats all baselines (incl RF)?           ${baseGate.passed ? "YES" : "NO"}`);
  say(`  Q3 holdout edge >= 0.50%/yr over RF?        ${gateEdge ? "YES" : "NO"}`);
  say(`  Q4 surrogate/placebo clean?                 ${gateSurr ? "YES" : "NO"}`);
  say(`  Q5 beats random-RULE 95th?                  ${gateRandRule ? "YES" : "NO"}`);
  say("");
  if (!survived) {
    const killReason = !gateEdge
      ? "holdout edge over RF below 0.50%/yr (regime compressed — confirms WF-D oracle ceiling)"
      : !gateSurr
        ? "surrogate/placebo shows the search manufactures equal edge on structure-free carry (artifact)"
        : !gateDSR
          ? "DSR fails at honest N (Sharpe not significant after multiple-testing deflation)"
          : !baseGate.passed
            ? `fails baseline gate vs ${baseGate.worstBaselineId}`
            : "fails random-rule gate";
    say(`KILLED BY: ${killReason}`);
  } else {
    say(`Monthly excess-over-RF if operated: ~${pct(champExc / 12)}/mo (annual ${pct(champExc)})`);
  }

  // Persist artifacts.
  const out = {
    track: "FRONT R4 — GA structural+technical carry rules",
    ranOnRealData: true,
    book: { periods: book.length, days: new Set(dates).size, start: dates[0], end: dates[dates.length - 1] },
    split: { searchPeriods: holdoutStart, holdoutPeriods: N - holdoutStart, holdoutStartDate: dates[holdoutStart] },
    primitives: FEATURE_NAMES,
    ga: { ...cfg, honestN, totalEvals: ga.totalEvals, championFitness: ga.championFitness },
    champion: { rule: championDesc, genome: ga.champion, inSampleExcessPct: isExc * 100, inSampleOnFrac: isOnFrac, inSampleToggles: isRun.toggles },
    holdout: {
      championExcessPct: champExc * 100,
      championOnFrac: champOnFrac,
      championToggles: holdRun.toggles,
      championNetSharpe: champSharpe,
      alwaysOnExcessPct: aoExc * 100,
      randomRuleMeanExcessPct: rrMean * 100,
      randomRule95ExcessPct: rr95 * 100,
      oracleCeilingExcessPct: oracleExc * 100,
    },
    surrogate: {
      trials: surrHold.length,
      holdMeanExcessPct: surrHoldMean * 100,
      hold95ExcessPct: surrHold95 * 100,
      holdMaxExcessPct: surrHoldMax * 100,
      realChampionHoldExcessPct: champExc * 100,
      placeboPValue: placeboP,
      surrogateArtifact,
    },
    gates: {
      dsr: { honestN, sharpePerDay: dsr.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe, deflatedProbability: dsr.deflatedProbability, pValue: dsrP, pass: gateDSR },
      haircut: { observedSharpe: champStats.sharpe, haircutSharpe: hc.haircutSharpe, haircut: hc.haircut, adjustedPValue: hc.adjustedPValue },
      baseline: { candidateScore: baseGate.candidateScore, passed: baseGate.passed, comparisons: baseGate.comparisons },
      edgeVsRf: { pct: edgeVsRf * 100, pass: gateEdge },
      surrogate: { pass: gateSurr, placeboP },
      randomRule: { champExcessPct: champExc * 100, rr95Pct: rr95 * 100, pass: gateRandRule },
    },
    verdict: survived ? "SURVIVE" : "KILL",
  };
  fs.writeFileSync(path.join(OUT_DIR, "ga-structural-carry-result.json"), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "ga-structural-carry-run.log"), log.join("\n"));
  say("");
  say(`Wrote output/front-r4/ga-structural-carry-result.json and .log`);
}

// helper: convert a RandomLotteryBaseline into a plain BaselineScore the gate accepts.
function rlottery_as_baseline(b: BaselineScore): BaselineScore {
  return { id: "random_lottery", label: "Random-lottery 95th", score: b.score, source: b.source };
}

main();
