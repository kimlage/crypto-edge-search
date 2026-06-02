/**
 * Cross-venue funding-rate dispersion (market-neutral relative value).
 *
 * Per coin per 8h: long the perp on the cheaper-funding venue, short on the
 * richer venue. Payoff over a held 8h period = (funding_short_venue -
 * funding_long_venue) on matched notional = the funding wedge. Both legs are
 * perps (no spot), so the position is dollar-neutral and (to first order)
 * price-neutral; the only PnL is the funding differential minus trading cost.
 *
 * THE decisive test: does dispersion add anything OVER funding-LEVEL carry?
 * We build a funding-level-only baseline (single-venue: short the perp whose
 * own funding is high / long whose funding is low across the cross-section)
 * and require the dispersion strategy to beat it NET of added cost.
 *
 * Costs: perp taker = 4 bps/side (from d2_full_cost_model.json). A dispersion
 * position has 2 legs; entering costs 2*4=8 bps, exiting costs 8 bps, so a
 * full round-trip = 16 bps of traded notional. Transfer cost between venues
 * is irrelevant for a *cash-and-carry-free* perp/perp spread held within each
 * venue's own margin (you post margin on both venues independently); we add a
 * conservative venue-rebalance transfer allowance below.
 *
 * Gates (committed harness, src/lib/training/statistical-validation.ts):
 *   - net-of-cost Sharpe + monthly $/%
 *   - funding-level baseline (must beat it net)
 *   - Deflated Sharpe @ honest N (every config tried)
 *   - CSCV/PBO
 *   - block-bootstrap CI on the spread
 *   - RIGHT surrogate null: cross-sectional shuffle of venue->funding mapping
 *     within each timestamp + block-bootstrap on the spread
 *   - Harvey-Liu haircut
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/training/statistical-validation";

const ROOT = ".";
const COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"] as const;
const PERIODS_PER_YEAR = 3 * 365; // 8h funding
const PERIODS_PER_MONTH = PERIODS_PER_YEAR / 12;

// ---- cost model (from output/carry/d2_full_cost_model.json) ----
const PERP_TAKER_BPS = 4; // per side, per leg
const DISPERSION_LEG_COUNT = 2; // long one venue + short other
const BASELINE_LEG_COUNT = 1; // single-venue perp per coin
// transfer allowance: margin rebalancing between venues is occasional; charge a
// small per-position-open transfer cost as a conservative add-on (bps of notional).
const TRANSFER_BPS_PER_OPEN = 1;
const BPS = 1e-4;

type FundingPoint = { fundingTime: number; fundingRate: number };

function load(path: string): FundingPoint[] {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as FundingPoint[];
}

// Build aligned panel: per timestamp (8h bucket), funding by coin & venue.
function buildPanel() {
  const byCoin: Record<
    string,
    { binance: Map<number, number>; bybit: Map<number, number> }
  > = {};
  for (const c of COINS) {
    const bin = load(`output/funding/${c}USDT_funding_8h.json`);
    const byb = load(`output/carry/bybit_${c}USDT_funding_8h.json`);
    const bMap = new Map<number, number>();
    const yMap = new Map<number, number>();
    for (const p of bin) bMap.set(Math.floor(p.fundingTime / 3_600_000), p.fundingRate);
    for (const p of byb) yMap.set(Math.floor(p.fundingTime / 3_600_000), p.fundingRate);
    byCoin[c] = { binance: bMap, bybit: yMap };
  }
  // shared timestamps = present for ALL coins on BOTH venues
  let shared: number[] | null = null;
  for (const c of COINS) {
    const keys = new Set<number>();
    for (const k of byCoin[c].binance.keys())
      if (byCoin[c].bybit.has(k)) keys.add(k);
    shared = shared === null ? [...keys] : shared.filter((k) => keys.has(k));
  }
  const timestamps = (shared ?? []).sort((a, b) => a - b);
  // rows[t] = { coin -> {bin, byb} }
  const rows = timestamps.map((t) => {
    const row: Record<string, { bin: number; byb: number }> = {};
    for (const c of COINS)
      row[c] = { bin: byCoin[c].binance.get(t)!, byb: byCoin[c].bybit.get(t)! };
    return row;
  });
  return { timestamps, rows };
}

// ---- Strategy returns ----
// Dispersion: per coin, target sign = sign(byb - bin) i.e. short the richer
// (long cheaper). Gross per-period funding pnl per coin = |spread| when held in
// the favorable direction; if we hold a fixed direction we earn (dir)*(byb-bin).
// We use hysteresis: enter when |spread| > enterTh, hold while sign agrees and
// |spread| > exitTh, else flat. Equal-weight across active coins.
// Returns are per-period portfolio returns on deployed notional.

interface Params {
  enterBps: number; // enter threshold on |spread| in bps/8h
  exitBps: number; // exit threshold (hysteresis), <= enterBps
}

function runDispersion(
  rows: Record<string, { bin: number; byb: number }>[],
  params: Params,
  costMultiplier = 1,
): { ret: number[]; turnover: number } {
  const enter = params.enterBps * BPS;
  const exit = params.exitBps * BPS;
  // per-coin state: position direction in {-1,0,1}; +1 = long bybit-leg? We set
  // dir = sign(byb-bin) meaning short the richer venue. PnL of holding dir over
  // next period uses the SAME period's realized spread (funding accrues over the
  // period; we decide at period open using prior info — see lag below).
  const pos: Record<string, number> = {};
  for (const c of COINS) pos[c] = 0;
  const portfolioRet: number[] = [];
  let totalLegChanges = 0;
  let totalLegSlots = 0;

  for (let t = 1; t < rows.length; t++) {
    const prev = rows[t - 1]; // signal formed from PRIOR period (no look-ahead)
    const cur = rows[t]; // funding realized THIS period
    let grossSum = 0;
    let costSum = 0;
    let active = 0;
    for (const c of COINS) {
      const sigSpread = prev[c].byb - prev[c].bin; // signal
      const absSig = Math.abs(sigSpread);
      const oldPos = pos[c];
      let newPos = oldPos;
      if (oldPos === 0) {
        if (absSig > enter) newPos = Math.sign(sigSpread);
      } else {
        // exit if weakened below exit OR sign flipped
        if (absSig < exit || Math.sign(sigSpread) !== oldPos) {
          newPos = absSig > enter ? Math.sign(sigSpread) : 0;
        }
      }
      pos[c] = newPos;
      // realized funding pnl this period for holding newPos:
      // dir=+1 => short bybit / long binance => earn (byb-bin); dir=-1 => earn (bin-byb)
      const realizedSpread = cur[c].byb - cur[c].bin;
      const gross = newPos * realizedSpread;
      // cost: a dispersion position has 2 perp legs. Each unit of position
      // change moves BOTH legs (taker each). |newPos-oldPos| in {0,1,2}.
      // legsTraded = |dPos| * 2 ; cost = legsTraded * takerBps.
      //   open 0->1 : |d|=1 -> 2 legs -> 8 bps
      //   close 1->0: |d|=1 -> 2 legs -> 8 bps   (round-trip = 16 bps)
      //   flip 1->-1: |d|=2 -> 4 legs -> 16 bps
      const legDelta = Math.abs(newPos - oldPos); // 0,1,2
      const cost =
        legDelta * DISPERSION_LEG_COUNT * PERP_TAKER_BPS * BPS +
        (newPos !== 0 && oldPos === 0 ? TRANSFER_BPS_PER_OPEN * BPS : 0);
      grossSum += gross;
      costSum += cost * costMultiplier;
      if (newPos !== 0) active++;
      if (newPos !== oldPos) totalLegChanges++;
      totalLegSlots++;
    }
    // equal weight across active coins (deployed-notional return). If none active, 0.
    const denom = Math.max(active, 1);
    portfolioRet.push(active > 0 ? (grossSum - costSum) / denom : 0);
  }
  return { ret: portfolioRet, turnover: totalLegChanges / Math.max(totalLegSlots, 1) };
}

// Funding-LEVEL-only baseline: classic single-venue cross-sectional carry.
// Per timestamp, short the perp whose OWN funding is high, long whose funding
// is low (use Binance funding levels). Market/beta exposure netted by ranking:
// long bottom-k, short top-k equal weight => beta-neutral-ish carry harvest.
// PnL of a short perp over the period = +funding paid to shorts = +funding.
function runFundingLevelBaseline(
  rows: Record<string, { bin: number; byb: number }>[],
  venue: "bin" | "byb",
  k: number,
  costMultiplier = 1,
): number[] {
  const prevPos: Record<string, number> = {};
  for (const c of COINS) prevPos[c] = 0;
  const ret: number[] = [];
  for (let t = 1; t < rows.length; t++) {
    const prev = rows[t - 1];
    const cur = rows[t];
    const ranked = [...COINS].sort(
      (a, b) => prev[b][venue] - prev[a][venue],
    ); // desc funding
    const shortSet = new Set(ranked.slice(0, k)); // high funding -> short perp
    const longSet = new Set(ranked.slice(COINS.length - k)); // low funding -> long perp
    let grossSum = 0;
    let costSum = 0;
    let active = 0;
    for (const c of COINS) {
      let newPos = 0;
      if (shortSet.has(c)) newPos = -1; // short perp earns +funding
      else if (longSet.has(c)) newPos = +1; // long perp earns -funding
      // realized: short perp pnl = +funding (longs pay shorts when funding>0)
      // long perp pnl = -funding. So holding pos earns -pos*funding? Define:
      // funding>0 => longs pay shorts. short(pos=-1) earns +funding => pnl = -pos*funding = +funding. correct.
      const f = cur[c][venue];
      const gross = -newPos * f;
      // single perp leg per coin: each unit position change = 1 taker = 4 bps.
      const legDelta = Math.abs(newPos - prevPos[c]);
      const cost =
        legDelta * BASELINE_LEG_COUNT * PERP_TAKER_BPS * BPS * costMultiplier;
      grossSum += gross;
      costSum += cost;
      if (newPos !== 0) active++;
      prevPos[c] = newPos;
    }
    const denom = Math.max(active, 1);
    ret.push(active > 0 ? (grossSum - costSum) / denom : 0);
  }
  return ret;
}

// Persistent single-venue level carry: per coin, short the perp while its own
// funding stays above enterBps (earns +funding), long while below -enterBps
// (earns -funding), with hysteresis exit at exitBps. Low churn — the STRONG
// honest funding-level harvest to beat. enter=exit=0 => always-on sign carry.
function runPersistentLevelBaseline(
  rows: Record<string, { bin: number; byb: number }>[],
  venue: "bin" | "byb",
  enterBps: number,
  exitBps: number,
): number[] {
  const enter = enterBps * BPS;
  const exit = exitBps * BPS;
  const pos: Record<string, number> = {};
  for (const c of COINS) pos[c] = 0;
  const ret: number[] = [];
  for (let t = 1; t < rows.length; t++) {
    const prev = rows[t - 1];
    const cur = rows[t];
    let grossSum = 0;
    let costSum = 0;
    let active = 0;
    for (const c of COINS) {
      const f = prev[c][venue]; // signal: own funding (prior period)
      const oldPos = pos[c];
      // desired position: short(-1) if funding rich, long(+1) if funding cheap.
      let newPos = oldPos;
      if (oldPos === 0) {
        if (f > enter) newPos = -1;
        else if (f < -enter) newPos = +1;
      } else if (oldPos === -1) {
        if (f < exit) newPos = f < -enter ? +1 : 0; // funding dropped
      } else {
        if (f > -exit) newPos = f > enter ? -1 : 0;
      }
      pos[c] = newPos;
      const realized = cur[c][venue];
      const gross = -newPos * realized; // short earns +funding
      const legDelta = Math.abs(newPos - oldPos);
      costSum += legDelta * BASELINE_LEG_COUNT * PERP_TAKER_BPS * BPS;
      grossSum += gross;
      if (newPos !== 0) active++;
    }
    const denom = Math.max(active, 1);
    ret.push(active > 0 ? (grossSum - costSum) / denom : 0);
  }
  return ret;
}

// ---- annualization / reporting ----
function annualizeSharpe(perPeriodSharpe: number): number {
  return perPeriodSharpe * Math.sqrt(PERIODS_PER_YEAR);
}

function reportSeries(name: string, ret: number[]) {
  const s = summarizeReturnSeries(ret);
  const annSharpe = annualizeSharpe(s.sharpe);
  const monthlyMean = s.mean * PERIODS_PER_MONTH;
  return {
    name,
    n: s.sampleCount,
    perPeriodMean: s.mean,
    perPeriodSharpe: s.sharpe,
    annSharpe,
    monthlyReturnPct: monthlyMean * 100,
    annReturnPct: s.mean * PERIODS_PER_YEAR * 100,
    positiveRate: s.positiveRate,
    compound: s.compoundReturn,
  };
}

// ---- surrogate null: shuffle venue->funding mapping within each timestamp ----
// For each timestamp and each coin, randomly swap which venue is "binance" vs
// "bybit" (i.e. randomize the sign/assignment of the wedge) — destroys any real
// cross-venue structure while preserving marginal funding distributions.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffledRows(
  rows: Record<string, { bin: number; byb: number }>[],
  rng: () => number,
): Record<string, { bin: number; byb: number }>[] {
  return rows.map((row) => {
    const out: Record<string, { bin: number; byb: number }> = {};
    for (const c of COINS) {
      if (rng() < 0.5) out[c] = { bin: row[c].byb, byb: row[c].bin };
      else out[c] = { bin: row[c].bin, byb: row[c].byb };
    }
    return out;
  });
}

function main() {
  const { timestamps, rows } = buildPanel();
  const startDate = new Date(timestamps[0] * 3_600_000).toISOString().slice(0, 10);
  const endDate = new Date(timestamps.at(-1)! * 3_600_000)
    .toISOString()
    .slice(0, 10);

  // ---- honest N: enumerate every config we try ----
  const enterGrid = [1, 2, 3, 5, 8];
  const exitGrid = [0.5, 1, 2];
  const configs: Params[] = [];
  for (const e of enterGrid)
    for (const x of exitGrid) if (x <= e) configs.push({ enterBps: e, exitBps: x });
  const baselineConfigs = [
    { venue: "bin" as const, k: 1 },
    { venue: "bin" as const, k: 2 },
    { venue: "byb" as const, k: 1 },
    { venue: "byb" as const, k: 2 },
  ];
  // persistent (low-churn) level-carry baselines: hold short while funding>enter,
  // exit when funding<exit. This is the STRONG funding-level harvest.
  const persistBaselineConfigs = [
    { venue: "bin" as const, enterBps: 0, exitBps: 0 }, // always-on sign carry
    { venue: "bin" as const, enterBps: 2, exitBps: 0.5 },
    { venue: "byb" as const, enterBps: 0, exitBps: 0 },
    { venue: "byb" as const, enterBps: 2, exitBps: 0.5 },
  ];
  const honestN =
    configs.length + baselineConfigs.length + persistBaselineConfigs.length;

  // ---- run all dispersion configs, pick best by net per-period Sharpe ----
  const dispRuns = configs.map((p) => {
    const { ret, turnover } = runDispersion(rows, p);
    const rep = reportSeries(`disp_e${p.enterBps}_x${p.exitBps}`, ret);
    return { p, ret, turnover, rep };
  });
  dispRuns.sort((a, b) => b.rep.perPeriodSharpe - a.rep.perPeriodSharpe);
  const bestDisp = dispRuns[0];

  // gross (no cost) version of best for diagnostic
  const grossBest = runDispersion(rows, bestDisp.p, 0);
  const grossRep = reportSeries("disp_best_GROSS", grossBest.ret);

  // ---- baselines ----
  const baseRuns = baselineConfigs.map((b) => {
    const ret = runFundingLevelBaseline(rows, b.venue, b.k);
    return { b, ret, rep: reportSeries(`baseline_xs_${b.venue}_k${b.k}`, ret) };
  });
  const persistBaseRuns = persistBaselineConfigs.map((b) => {
    const ret = runPersistentLevelBaseline(rows, b.venue, b.enterBps, b.exitBps);
    return {
      b,
      ret,
      rep: reportSeries(`baseline_lvl_${b.venue}_e${b.enterBps}_x${b.exitBps}`, ret),
    };
  });
  const allBaseRuns = [...baseRuns, ...persistBaseRuns];
  allBaseRuns.sort((a, b) => b.rep.perPeriodSharpe - a.rep.perPeriodSharpe);
  const bestBase = allBaseRuns[0];

  // ---- "added value" series: dispersion minus baseline (does disp add over level?) ----
  const addedLen = Math.min(bestDisp.ret.length, bestBase.ret.length);
  const added = Array.from(
    { length: addedLen },
    (_, i) => bestDisp.ret[i] - bestBase.ret[i],
  );
  const addedRep = reportSeries("disp_minus_baseline", added);

  // ---- Deflated Sharpe @ honest N on best dispersion ----
  const dsr = computeDeflatedSharpeRatio(bestDisp.ret, { trialCount: honestN });

  // ---- block bootstrap CI on the per-period net return (the spread pnl) ----
  const boot = blockBootstrapConfidenceInterval(bestDisp.ret, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 21, // ~7 days of 8h periods
    confidenceLevel: 0.95,
    seed: "disp-boot",
  });

  // ---- CSCV/PBO: dispersion configs vs baselines as competing strategies ----
  // build folds (10 contiguous blocks) for top strategies
  const FOLDS = 10;
  function toFolds(ret: number[]): number[][] {
    const size = Math.floor(ret.length / FOLDS);
    return Array.from({ length: FOLDS }, (_, i) =>
      ret.slice(i * size, i === FOLDS - 1 ? ret.length : (i + 1) * size),
    );
  }
  const cscvStrats: CscvStrategyFoldReturns[] = [
    ...dispRuns.slice(0, 8).map((r) => ({ id: r.rep.name, folds: toFolds(r.ret) })),
    ...allBaseRuns.map((r) => ({ id: r.rep.name, folds: toFolds(r.ret) })),
  ];
  const pbo = estimateCscvPbo(cscvStrats, { statistic: "sharpe", trainFraction: 0.5 });

  // ---- SURROGATE NULL: cross-sectional venue->funding shuffle, refit best config ----
  const NSURR = 500;
  let surrGE = 0;
  const surrSharpes: number[] = [];
  for (let s = 0; s < NSURR; s++) {
    const rng = mulberry32(1000 + s);
    const sr = shuffledRows(rows, rng);
    const { ret } = runDispersion(sr, bestDisp.p);
    const sh = summarizeReturnSeries(ret).sharpe;
    surrSharpes.push(sh);
    if (sh >= bestDisp.rep.perPeriodSharpe) surrGE++;
  }
  const surrogateP = (surrGE + 1) / (NSURR + 1);
  surrSharpes.sort((a, b) => a - b);

  // ---- Harvey-Liu style haircut: t-stat haircut for multiple testing ----
  // observed t ~ sharpe * sqrt(N); haircut p via Bonferroni-like across honestN.
  const tObs = bestDisp.rep.perPeriodSharpe * Math.sqrt(bestDisp.rep.n);
  // two-sided p from t (normal approx)
  const pSingle = 2 * (1 - normalCdf(Math.abs(tObs)));
  const pHaircutBonferroni = Math.min(1, pSingle * honestN);
  // Holm-ish effective haircut Sharpe (scale t by sqrt of adjustment) — report both
  const haircutTstat =
    inverseNormalCdf(1 - Math.min(0.5, pHaircutBonferroni / 2));

  // ---- $ at capital. Deployed notional model: equal-weight across active coins.
  // realisticNetMonthlyPct = monthly mean return on DEPLOYED notional.
  // Conservative: deploy 60% of capital (buffer model from cost doc).
  const deployFrac = 0.6;
  function dollars(monthlyPct: number, capital: number) {
    return (monthlyPct / 100) * deployFrac * capital;
  }

  const out = {
    meta: {
      strategy: "cross-venue funding-rate dispersion (Binance x Bybit perp/perp)",
      coins: COINS,
      periods: rows.length,
      startDate,
      endDate,
      periodsPerYear: PERIODS_PER_YEAR,
      honestN,
      costModel: {
        perpTakerBps: PERP_TAKER_BPS,
        dispersionRoundTripBps: DISPERSION_LEG_COUNT * PERP_TAKER_BPS * 2,
        transferBpsPerOpen: TRANSFER_BPS_PER_OPEN,
      },
    },
    bestDispersion: { params: bestDisp.p, turnover: bestDisp.turnover, ...bestDisp.rep },
    bestDispersionGross: grossRep,
    bestBaseline: { config: bestBase.b, ...bestBase.rep },
    addedValue_dispMinusBaseline: addedRep,
    allDispersionConfigs: dispRuns.map((r) => ({
      params: r.p,
      annSharpe: round(r.rep.annSharpe),
      monthlyPct: round(r.rep.monthlyReturnPct),
      turnover: round(r.turnover),
    })),
    allBaselines: allBaseRuns.map((r) => ({
      name: r.rep.name,
      config: r.b,
      annSharpe: round(r.rep.annSharpe),
      monthlyPct: round(r.rep.monthlyReturnPct),
    })),
    gates: {
      deflatedSharpe: {
        sharpePerPeriod: round(dsr.sharpe),
        annSharpe: round(annualizeSharpe(dsr.sharpe)),
        trialCount: dsr.trialCount,
        expectedMaxSharpe: round(dsr.expectedMaxSharpe),
        deflatedProbability: round(dsr.deflatedProbability),
        passes_p_gt_0_95: dsr.deflatedProbability > 0.95,
      },
      blockBootstrapMeanCI: {
        estimatePerPeriod: round(boot.estimate),
        lower: round(boot.lower),
        upper: round(boot.upper),
        annReturnPct_estimate: round(boot.estimate * PERIODS_PER_YEAR * 100),
        annReturnPct_lower: round(boot.lower * PERIODS_PER_YEAR * 100),
        ciExcludesZero: boot.lower > 0 || boot.upper < 0,
      },
      cscvPbo: {
        pbo: round(pbo.pbo),
        medianLogit: round(pbo.medianLogit),
        passes_pbo_lt_0_5: pbo.pbo < 0.5,
      },
      surrogateNull: {
        method: "cross-sectional venue->funding shuffle within timestamp, refit",
        nSurrogates: NSURR,
        observedSharpe: round(bestDisp.rep.perPeriodSharpe),
        surrogateMeanSharpe: round(mean(surrSharpes)),
        surrogateP95Sharpe: round(quantile(surrSharpes, 0.95)),
        p: round(surrogateP),
        passes_p_lt_0_05: surrogateP < 0.05,
      },
      harveyLiuHaircut: {
        tObserved: round(tObs),
        pSingle: round(pSingle),
        honestN,
        pBonferroni: round(pHaircutBonferroni),
        haircutTstat: round(haircutTstat),
        passes_pBonf_lt_0_05: pHaircutBonferroni < 0.05,
      },
      beatsBaselineNet: {
        dispAnnSharpe: round(bestDisp.rep.annSharpe),
        baseAnnSharpe: round(bestBase.rep.annSharpe),
        addedValueAnnSharpe: round(addedRep.annSharpe),
        addedValueMonthlyPct: round(addedRep.monthlyReturnPct),
        dispBeatsBaseline: bestDisp.rep.perPeriodSharpe > bestBase.rep.perPeriodSharpe,
        addedValuePositive: addedRep.perPeriodMean > 0,
      },
    },
    dollarsAtCapital: {
      deployFrac,
      best_disp_monthly_pct: round(bestDisp.rep.monthlyReturnPct),
      monthly_10k: round(dollars(bestDisp.rep.monthlyReturnPct, 10_000)),
      monthly_100k: round(dollars(bestDisp.rep.monthlyReturnPct, 100_000)),
      added_value_monthly_100k: round(dollars(addedRep.monthlyReturnPct, 100_000)),
    },
  };

  writeFileSync(
    join(ROOT, "output/edgehunt/funding_dispersion_result.json"),
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify(out, null, 2));
}

// ---- helpers ----
function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
function mean(a: number[]): number {
  return a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
}
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
function inverseNormalCdf(p: number): number {
  // Acklam approx, sufficient for reporting
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const pp = Math.min(1 - 1e-12, Math.max(1e-12, p));
  if (pp < pl) {
    const q = Math.sqrt(-2 * Math.log(pp));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (pp > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - pp));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = pp - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

main();
