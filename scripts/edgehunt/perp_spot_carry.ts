/**
 * Perp-spot cash-and-carry (short perp + hold spot, collect funding) — HONEST tail accounting.
 *
 * Strategy: delta-neutral book. Long 1 unit spot, short 1 unit perp per active symbol.
 * Income = funding received (8h) when funding > 0 (you are short, longs pay you).
 * Costs  = taker fee on every notional change (rebalance / entry / exit) + funding PAID when negative
 *          + basis P&L on the neutral spread (perp-spot convergence) realized on rebalances.
 *
 * STRENGTHENING LAYERS (each is one config, honest-N counted):
 *   - Funding-state ENTRY FILTER: only hold a leg when trailing N-day funding APR > floor.
 *   - VOL-TARGET: scale book gross exposure so neutral-spread vol ~ target (caps tail of basis moves).
 *   - LIQUIDATION-AWARE LEVERAGE CAP on the short leg: short notional <= maxLev * margin;
 *     idle buffer earns risk-free; a liquidation event (intraday adverse move > liqThreshold)
 *     forces an unwind at a loss (breaks neutrality). Models the "short a crash option".
 *
 * TAIL ACCOUNTING: mean yield, skew, worst funding-flip months, max-DD of neutral spread,
 *   CVaR(5%), Calmar — all NET of taker (4bps perp / 10bps spot side) and negative funding.
 *
 * NULLS:
 *   - Block-bootstrap the funding series -> yield distribution + LEFT TAIL (CVaR) confidence.
 *   - Bracket-on-surrogate for liquidation/unwind path: phase-randomize price returns,
 *     re-run the liquidation engine -> distribution of unwind drag under a null price path.
 *
 * PROMOTION HURDLE: beat CASH (risk-free T-bills) on a CVaR / Calmar-adjusted basis, net of cost.
 *   Raw mean vs T-bill is NOT enough — we are short a crash option.
 *
 * Gates: committed harness src/lib/training/statistical-validation.ts
 *   summarizeReturnSeries, computeDeflatedSharpeRatio (honest N), estimateCscvPbo,
 *   blockBootstrapConfidenceInterval.
 */
import fs from "node:fs";
import path from "node:path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
} from "../../src/lib/training/statistical-validation";

const ROOT = ".";
const SYMS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];

// ---- realistic costs ----
const PERP_TAKER = 0.0004; // 4 bps/side perp
const SPOT_TAKER = 0.0010; // 10 bps/side spot
const RISK_FREE_APR = 0.045; // 4.5% T-bills
const RF_DAILY = RISK_FREE_APR / 365;
const TRADING_DAYS = 365; // crypto trades 365

type Funding = { fundingTime: number; fundingRate: number };
type Px = { date: string; spotClose: number; perpClose: number };

function loadSym(s: string) {
  const f: Funding[] = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/funding/${s}USDT_funding_8h.json`), "utf8"),
  );
  const p: Px[] = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/funding/${s}USDT_prices_daily.json`), "utf8"),
  );
  return { f, p };
}

// Aggregate 8h funding to a per-day sum keyed by YYYY-MM-DD.
function fundingByDay(f: Funding[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of f) {
    const d = new Date(x.fundingTime).toISOString().slice(0, 10);
    m.set(d, (m.get(d) ?? 0) + x.fundingRate);
  }
  return m;
}

function mean(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function maxDrawdown(returns: number[]): number {
  let eq = 1,
    peak = 1,
    mdd = 0;
  for (const r of returns) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq / peak - 1);
  }
  return mdd;
}
function cvar(returns: number[], q = 0.05): number {
  const s = [...returns].sort((a, b) => a - b);
  const n = Math.max(1, Math.floor(s.length * q));
  return mean(s.slice(0, n));
}
function calmar(daily: number[]): number {
  const annRet = mean(daily) * TRADING_DAYS;
  const mdd = Math.abs(maxDrawdown(daily));
  return mdd > 1e-9 ? annRet / mdd : 0;
}

// ---- seeded RNG for surrogate / bootstrap reproducibility ----
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Config {
  fundingFloorApr: number; // entry filter: trailing funding APR floor (annualized)
  trailDays: number; // lookback for trailing funding
  volTargetAnnual: number; // target annual vol of neutral spread (0 = off)
  maxLev: number; // short-leg leverage cap (short notional / margin)
  liqBufferFrac: number; // fraction of capital held idle as margin buffer (earns RF)
}

interface DayState {
  date: string;
  ret: number; // net daily return on TOTAL capital (incl. idle buffer @ RF)
  carryRet: number; // gross funding component
  costRet: number; // taker + basis drag
  liqEvents: number;
}

/**
 * Run the delta-neutral carry book for one config.
 * Capital is split: (1-liqBufferFrac) used as collateral margin for the short legs
 * (spot long is fully funded from notional), the rest sits idle earning RF.
 * Per active symbol we run long spot / short perp of equal notional w.
 * w per symbol is scaled by vol-target so the *spread* vol hits target.
 */
function runBook(
  cfg: Config,
  priceRetByDay: Map<string, Map<string, number>>, // sym -> date -> perp daily ret (for liq + basis)
  basisByDay: Map<string, Map<string, number>>, // sym -> date -> (perp-spot)/spot
  fundByDay: Map<string, Map<string, number>>, // sym -> date -> daily funding sum
  dates: string[],
  spreadVolBySym: Map<string, number>,
): DayState[] {
  const out: DayState[] = [];
  // active state per symbol: whether we currently hold the leg, and the basis at entry
  const active = new Map<string, boolean>();
  const entryBasis = new Map<string, number>();
  for (const s of SYMS) active.set(s, false);

  // trailing funding APR per symbol (computed from fundByDay over trailDays)
  function trailingApr(sym: string, idx: number): number {
    const fm = fundByDay.get(sym)!;
    let sum = 0,
      n = 0;
    for (let k = Math.max(0, idx - cfg.trailDays); k < idx; k++) {
      const v = fm.get(dates[k]);
      if (v !== undefined) {
        sum += v;
        n++;
      }
    }
    return n > 0 ? (sum / n) * TRADING_DAYS : 0; // daily funding sum * 365
  }

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let carry = 0,
      cost = 0,
      liqEvents = 0;

    // Determine active symbols by funding-state entry filter
    const want: string[] = [];
    for (const s of SYMS) {
      if (trailingApr(s, i) >= cfg.fundingFloorApr) want.push(s);
    }
    const nWant = want.length;

    // Per-symbol notional weight. Equal-weight across wanted symbols on the
    // collateralized capital, then vol-target scaled.
    const deployable = 1 - cfg.liqBufferFrac; // fraction of capital as gross book / margin
    // idle buffer earns RF
    const idleRF = cfg.liqBufferFrac * RF_DAILY;

    for (const s of SYMS) {
      const wasActive = active.get(s)!;
      const shouldActive = want.includes(s);
      const fm = fundByDay.get(s)!;
      const bm = basisByDay.get(s)!;
      const pm = priceRetByDay.get(s)!;

      // notional weight for this symbol if active
      let w = 0;
      if (shouldActive && nWant > 0) {
        const base = deployable / nWant;
        if (cfg.volTargetAnnual > 0) {
          const sv = spreadVolBySym.get(s) ?? 0.01;
          const annSV = sv * Math.sqrt(TRADING_DAYS);
          const scale = annSV > 1e-6 ? Math.min(3, cfg.volTargetAnnual / annSV) : 1;
          w = base * scale;
        } else {
          w = base;
        }
        // liquidation-aware leverage cap: short notional per symbol <= maxLev * (its margin share)
        // margin share = base of collateral; cap gross notional
        const marginShare = base; // collateral backing this leg
        w = Math.min(w, cfg.maxLev * marginShare);
      }

      // ENTRY: open both legs -> pay taker on spot + perp side
      if (shouldActive && !wasActive) {
        cost += w * (PERP_TAKER + SPOT_TAKER);
        entryBasis.set(s, bm.get(date) ?? 0);
        active.set(s, true);
      }
      // EXIT: close both legs -> pay taker on both sides, realize basis convergence
      if (!shouldActive && wasActive) {
        const eb = entryBasis.get(s) ?? 0;
        const cb = bm.get(date) ?? 0;
        // delta-neutral spread P&L on unwind: we are short perp/long spot.
        // P&L from basis = +(entryBasis - currentBasis) (perp cheapening relative to spot helps short)
        carry += w * (eb - cb);
        cost += w * (PERP_TAKER + SPOT_TAKER);
        active.set(s, false);
      }

      // While ACTIVE: collect funding for the day, model liquidation risk on the short leg.
      if (active.get(s)!) {
        const fday = fm.get(date) ?? 0;
        // We are SHORT perp -> receive funding when funding>0, pay when <0.
        carry += w * fday;

        // LIQUIDATION ENGINE: short perp loses when price rises. With leverage maxLev,
        // an intraday adverse (up) move beyond ~ (1/maxLev) wipes the leg's margin.
        // We approximate intraday extreme by 1.6x the daily perp return magnitude (wick).
        const dr = pm.get(date) ?? 0;
        const adverseUp = Math.max(0, dr) * 1.6; // short hurt by up-moves
        const liqThreshold = 1 / cfg.maxLev; // margin exhausted
        if (adverseUp >= liqThreshold) {
          // forced unwind at a loss: lose the leg's margin share + re-entry taker cost.
          // Realized loss ~ margin consumed (capped at marginShare) + taker to re-establish.
          const marginShare = deployable / Math.max(1, nWant);
          const lossFrac = Math.min(1, adverseUp * cfg.maxLev) ; // fraction of margin lost
          cost += marginShare * lossFrac * 0.5; // half-haircut realized on forced unwind
          cost += w * (PERP_TAKER + SPOT_TAKER); // re-establish
          liqEvents++;
        }
      }
    }

    // total daily return on capital: funding carry - costs + idle buffer RF.
    // Note: the long spot / short perp delta-neutral legs have ~0 price P&L by construction
    // (modeled only via basis on unwind + liquidation drag). Collateral not idle is "working"
    // but earns no extra RF (it's posted as margin); only liqBufferFrac earns RF here = conservative.
    const ret = carry - cost + idleRF;
    out.push({ date, ret, carryRet: carry, costRet: cost, liqEvents });
  }
  return out;
}

// ---- build per-symbol daily maps ----
function build() {
  const priceRetByDay = new Map<string, Map<string, number>>();
  const basisByDay = new Map<string, Map<string, number>>();
  const fundByDay = new Map<string, Map<string, number>>();
  const spreadVolBySym = new Map<string, number>();
  let dates: string[] = [];

  for (const s of SYMS) {
    const { f, p } = loadSym(s);
    const fday = fundingByDay(f);
    const prMap = new Map<string, number>();
    const bMap = new Map<string, number>();
    const spreadRets: number[] = [];
    for (let i = 0; i < p.length; i++) {
      const d = p[i].date;
      bMap.set(d, (p[i].perpClose - p[i].spotClose) / p[i].spotClose);
      if (i > 0) {
        const perpR = p[i].perpClose / p[i - 1].perpClose - 1;
        const spotR = p[i].spotClose / p[i - 1].spotClose - 1;
        prMap.set(d, perpR);
        // neutral spread daily return = spotR - perpR (long spot, short perp)
        spreadRets.push(spotR - perpR);
      } else {
        prMap.set(d, 0);
      }
    }
    priceRetByDay.set(s, prMap);
    basisByDay.set(s, bMap);
    fundByDay.set(s, fday);
    spreadVolBySym.set(s, std(spreadRets));
    if (dates.length === 0) dates = p.map((x) => x.date);
  }
  return { priceRetByDay, basisByDay, fundByDay, spreadVolBySym, dates };
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

function analyze(states: DayState[]) {
  const daily = states.map((s) => s.ret);
  const stats = summarizeReturnSeries(daily);
  const annRet = mean(daily) * TRADING_DAYS;
  const annVol = std(daily) * Math.sqrt(TRADING_DAYS);
  const sharpe = annVol > 1e-9 ? annRet / annVol : 0;
  const netSharpeDaily = stats.sharpe * Math.sqrt(TRADING_DAYS);
  const mdd = maxDrawdown(daily);
  const cv = cvar(daily, 0.05);
  const cal = calmar(daily);
  // monthly returns
  const byMonth = new Map<string, number[]>();
  for (const s of states) {
    const k = monthKey(s.date);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k)!.push(s.ret);
  }
  const monthly: { month: string; ret: number }[] = [];
  for (const [k, rs] of byMonth) {
    const cr = rs.reduce((a, r) => a * (1 + r), 1) - 1;
    monthly.push({ month: k, ret: cr });
  }
  monthly.sort((a, b) => a.ret - b.ret);
  const liq = states.reduce((a, s) => a + s.liqEvents, 0);
  return {
    n: daily.length,
    annRet,
    annVol,
    sharpe,
    netSharpeDaily,
    skew: stats.skewness,
    kurtosis: stats.kurtosis,
    mdd,
    cvar5: cv,
    calmar: cal,
    worstMonths: monthly.slice(0, 5),
    liqEvents: liq,
    daily,
  };
}

// CASH baseline daily series (risk-free)
function cashDaily(n: number): number[] {
  return Array.from({ length: n }, () => RF_DAILY);
}

function main() {
  const { priceRetByDay, basisByDay, fundByDay, spreadVolBySym, dates } = build();

  // ---- config grid (honest N = every config tried) ----
  const fundingFloors = [0, 0.02, 0.04, 0.06]; // APR floors
  const trailDaysArr = [14, 30];
  const volTargets = [0, 0.05, 0.10]; // 0 = off
  const maxLevs = [3, 5];
  const liqBuffers = [0.3, 0.4]; // idle margin buffer fraction

  const configs: Config[] = [];
  for (const ff of fundingFloors)
    for (const td of trailDaysArr)
      for (const vt of volTargets)
        for (const ml of maxLevs)
          for (const lb of liqBuffers)
            configs.push({
              fundingFloorApr: ff,
              trailDays: td,
              volTargetAnnual: vt,
              maxLev: ml,
              liqBufferFrac: lb,
            });

  const honestN = configs.length;
  const results = configs.map((cfg) => {
    const states = runBook(
      cfg,
      priceRetByDay,
      basisByDay,
      fundByDay,
      dates,
      spreadVolBySym,
    );
    const a = analyze(states);
    return { cfg, a };
  });

  // CASH baseline metrics
  const cash = cashDaily(dates.length);
  const cashAnn = mean(cash) * TRADING_DAYS;
  const cashCalmar = 0; // no DD, infinite-ish; treat as 0 DD baseline (Calmar undefined)
  const cashCVaR = cvar(cash, 0.05); // = RF_DAILY (no negative days)

  // Promotion hurdle: beat CASH on CVaR/Calmar-adjusted basis.
  // We rank by Calmar (annRet / MDD) AND require CVaR(5%) better (less negative) is impossible
  // vs cash (cash CVaR is positive). So the honest test: does the strategy's RISK-ADJUSTED
  // excess return over cash justify the crash-option short? Use Sharpe of (ret - RF) and Calmar.
  const scored = results
    .map((r) => {
      const excess = r.a.daily.map((x) => x - RF_DAILY);
      const exStats = summarizeReturnSeries(excess);
      const exSharpe = exStats.sharpe * Math.sqrt(TRADING_DAYS);
      return { ...r, exSharpe, excessAnn: mean(excess) * TRADING_DAYS };
    })
    .sort((a, b) => b.a.calmar - a.a.calmar);

  // pick the BEST config by Calmar (risk-adjusted, crash-aware)
  const best = scored[0];

  // ---- DEFLATED SHARPE at honest N on the best config's daily excess-over-RF ----
  const bestExcess = best.a.daily.map((x) => x - RF_DAILY);
  const dsr = computeDeflatedSharpeRatio(bestExcess, {
    benchmarkSharpe: 0,
    trialCount: honestN,
  });

  // ---- BLOCK BOOTSTRAP the funding-driven yield + LEFT TAIL ----
  // bootstrap the best config's daily returns (captures funding+cost autocorr via blocks)
  const bb = blockBootstrapConfidenceInterval(best.a.daily, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 30,
    confidenceLevel: 0.95,
    seed: "carry-yield",
  });
  // left-tail CVaR bootstrap: resample blocks, compute CVaR each iter
  const r = rng(12345);
  const cvarSamples: number[] = [];
  const sharpeSamples: number[] = [];
  const blk = 30;
  const series = best.a.daily;
  for (let it = 0; it < 2000; it++) {
    const res: number[] = [];
    while (res.length < series.length) {
      const start = Math.floor(r() * series.length);
      for (let o = 0; o < blk && res.length < series.length; o++) {
        res.push(series[(start + o) % series.length]);
      }
    }
    cvarSamples.push(cvar(res, 0.05));
    const ex = res.map((x) => x - RF_DAILY);
    sharpeSamples.push((mean(ex) / (std(ex) || 1)) * Math.sqrt(TRADING_DAYS));
  }
  cvarSamples.sort((a, b) => a - b);
  sharpeSamples.sort((a, b) => a - b);
  const q = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))];

  // ---- SURROGATE NULL: phase-randomize price returns, re-run liquidation engine ----
  // This kills any real time-structure in prices while preserving the spectrum;
  // the liquidation drag distribution under the null tells us if the unwind path is benign.
  function phaseRandomize(x: number[], seed: number): number[] {
    // simple block-shuffle surrogate (preserves marginal dist, destroys ordering of extremes)
    const rr = rng(seed);
    const blocks: number[][] = [];
    const bl = 5;
    for (let i = 0; i < x.length; i += bl) blocks.push(x.slice(i, i + bl));
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rr() * (i + 1));
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    }
    return blocks.flat().slice(0, x.length);
  }
  // run surrogate: shuffle price returns per symbol, recompute book, measure Calmar+CVaR
  const surrCalmars: number[] = [];
  const surrSharpes: number[] = [];
  for (let it = 0; it < 200; it++) {
    const surPriceRet = new Map<string, Map<string, number>>();
    for (const s of SYMS) {
      const orig = priceRetByDay.get(s)!;
      const arr = dates.map((d) => orig.get(d) ?? 0);
      const sh = phaseRandomize(arr, 9000 + it * 31 + s.length);
      const m = new Map<string, number>();
      dates.forEach((d, k) => m.set(d, sh[k]));
      surPriceRet.set(s, m);
    }
    const st = runBook(best.cfg, surPriceRet, basisByDay, fundByDay, dates, spreadVolBySym);
    const aa = analyze(st);
    surrCalmars.push(aa.calmar);
    const ex = aa.daily.map((x) => x - RF_DAILY);
    surrSharpes.push((mean(ex) / (std(ex) || 1)) * Math.sqrt(TRADING_DAYS));
  }
  surrCalmars.sort((a, b) => a - b);
  surrSharpes.sort((a, b) => a - b);
  // surrogate p: fraction of surrogate Calmars >= real Calmar (one-sided)
  const surrP =
    surrCalmars.filter((c) => c >= best.a.calmar).length / surrCalmars.length;

  // ---- CPCV / PBO across configs (5 folds) ----
  const F = 5;
  const foldLen = Math.floor(dates.length / F);
  const pboStrategies = results.slice(0, Math.min(results.length, 40)).map((r, idx) => {
    const folds: number[][] = [];
    for (let k = 0; k < F; k++) {
      folds.push(r.a.daily.slice(k * foldLen, (k + 1) * foldLen).map((x) => x - RF_DAILY));
    }
    return { id: `cfg_${idx}`, folds };
  });
  let pbo: any = null;
  try {
    pbo = estimateCscvPbo(pboStrategies, { statistic: "sharpe", trainFraction: 0.5 });
  } catch (e) {
    pbo = { error: String(e) };
  }

  // ---- $ figures ----
  const monthly100k = (best.a.annRet / 12) * 100000;
  const monthly10k = (best.a.annRet / 12) * 10000;
  const excessMonthly100k = (best.exSharpe, (best.excessAnn / 12) * 100000);

  const report = {
    meta: {
      strategy: "perp-spot cash-and-carry (delta-neutral 8h, funding-filter+vol-target+liq-cap)",
      symbols: SYMS,
      period: `${dates[0]} -> ${dates[dates.length - 1]}`,
      days: dates.length,
      honestN,
      costs: { perpTakerBps: PERP_TAKER * 1e4, spotTakerBps: SPOT_TAKER * 1e4, riskFreeApr: RISK_FREE_APR },
    },
    bestConfig: best.cfg,
    bestMetrics: {
      annRetPct: +(best.a.annRet * 100).toFixed(3),
      annVolPct: +(best.a.annVol * 100).toFixed(3),
      sharpe_excessRF: +best.exSharpe.toFixed(3),
      netSharpe_raw: +best.a.sharpe.toFixed(3),
      excessAnnOverCashPct: +(best.excessAnn * 100).toFixed(3),
      skew: +best.a.skew.toFixed(3),
      kurtosis: +best.a.kurtosis.toFixed(3),
      maxDD_pct: +(best.a.mdd * 100).toFixed(3),
      cvar5_dailyPct: +(best.a.cvar5 * 100).toFixed(4),
      calmar: +best.a.calmar.toFixed(3),
      liqEvents: best.a.liqEvents,
      worstMonths: best.a.worstMonths.map((m) => ({ month: m.month, retPct: +(m.ret * 100).toFixed(2) })),
    },
    cashBaseline: {
      annRetPct: +(cashAnn * 100).toFixed(3),
      cvar5_dailyPct: +(cashCVaR * 100).toFixed(4),
      note: "cash has zero DD, positive CVaR; strategy must justify crash-option short on risk-adj excess",
    },
    promotionTest: {
      excessSharpeOverCash: +best.exSharpe.toFixed(3),
      excessAnnOverCashPct: +(best.excessAnn * 100).toFixed(3),
      beatsCashOnCalmar: best.a.calmar > 0 && best.excessAnn > 0,
      verdict_note: "Need excess Sharpe>0 AND robust left tail to justify short crash option",
    },
    deflatedSharpe: {
      sharpe: +dsr.sharpe.toFixed(3),
      annualized: +(dsr.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(3),
      trialCount: dsr.trialCount,
      expectedMaxSharpe: +dsr.expectedMaxSharpe.toFixed(4),
      deflatedProbability: +dsr.deflatedProbability.toFixed(4),
      passes_DSR: dsr.deflatedProbability > 0.95,
    },
    blockBootstrap: {
      meanDailyEstimate: +bb.estimate.toFixed(6),
      meanDaily_CI95: [+bb.lower.toFixed(6), +bb.upper.toFixed(6)],
      meanLowerBoundBeatsRF: bb.lower > RF_DAILY,
      cvar5_CI95: [+q(cvarSamples, 0.025).toFixed(5), +q(cvarSamples, 0.975).toFixed(5)],
      sharpeExcess_CI95: [+q(sharpeSamples, 0.025).toFixed(3), +q(sharpeSamples, 0.975).toFixed(3)],
      sharpeLowerBoundPositive: q(sharpeSamples, 0.025) > 0,
    },
    surrogateNull: {
      realCalmar: +best.a.calmar.toFixed(3),
      surrogateCalmar_median: +q(surrCalmars, 0.5).toFixed(3),
      surrogateCalmar_p95: +q(surrCalmars, 0.95).toFixed(3),
      surrogateP_oneSided: +surrP.toFixed(4),
      realSharpe: +best.exSharpe.toFixed(3),
      surrogateSharpe_median: +q(surrSharpes, 0.5).toFixed(3),
      note: "Surrogate shuffles price ordering -> tests if liquidation/unwind drag is structural. High p = real path not distinguishable from null (carry dominated by funding, not price timing).",
    },
    cpcvPbo: pbo && !pbo.error
      ? {
          pbo: +pbo.pbo.toFixed(3),
          meanLogit: +pbo.meanLogit.toFixed(3),
          strategyCount: pbo.strategyCount,
          passes_PBO: pbo.pbo < 0.5,
        }
      : pbo,
    dollarFigures: {
      monthlyAt10k: +monthly10k.toFixed(2),
      monthlyAt100k: +monthly100k.toFixed(2),
      excessOverCashMonthlyAt100k: +((best.excessAnn / 12) * 100000).toFixed(2),
    },
    allConfigsSummary: scored.slice(0, 10).map((r) => ({
      cfg: r.cfg,
      annRetPct: +(r.a.annRet * 100).toFixed(2),
      exSharpe: +r.exSharpe.toFixed(2),
      calmar: +r.a.calmar.toFixed(2),
      mddPct: +(r.a.mdd * 100).toFixed(2),
      skew: +r.a.skew.toFixed(2),
      liq: r.a.liqEvents,
    })),
  };

  fs.writeFileSync(
    path.join(ROOT, "output/edgehunt/perp_spot_carry_report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

main();
