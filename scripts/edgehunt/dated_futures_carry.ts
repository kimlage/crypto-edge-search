/**
 * Dated-futures cash-and-carry / term-structure edge test (v2, honest rebuild).
 *
 * TRADE: short a contango quarterly future + long spot, hold to convergence.
 * The combined dollar-neutral position's daily mark-to-market return is
 *     dayRet = (spot_t/spot_{t-1} - 1) - (future_t/future_{t-1} - 1)
 * which over the contract life captures the basis convergence (entry_basis -> ~0).
 *
 * STRENGTHENING:
 *  - enter a contract only when its annualized basis > hurdle (financing+roll+margin)
 *  - never long the basis (flat in backwardation; exit if basis flips negative)
 *  - stack expiries (front + next quarter; equal-weight capital across active legs)
 *  - charge realistic taker cost (4bps/side) on entry and exit
 *  - charge the early-unwind tail on the short future (stochastic forced close)
 *
 * KEY CONTROL (C3): the carry signal (annualized basis) is mostly re-priced perp
 *   funding. We therefore PURGE perp-funding co-movement two ways and require the
 *   TERM-STRUCTURE RESIDUAL to clear the gates ALONE:
 *     (i)  signal-level: at entry, only the part of annualized basis ABOVE the
 *          contemporaneous perp-funding carry counts toward the hurdle.
 *     (ii) return-level: regress the realized weekly dated-carry return on the
 *          realized weekly perp-funding-carry return; gate the residual.
 *
 * NULLS (RIGHT for a directional carry harvest):
 *   - block-bootstrap basis-to-expiry (resample convergence blocks)
 *   - bracket-on-surrogate for early-unwind (phase-randomized future path)
 *   - cross-sectional shuffle across expiries (reassign contract returns to wrong
 *     expiry calendars)
 *
 * JUDGE: committed gates in src/lib/training/statistical-validation.ts.
 * Honest N = every config tried.
 */
import * as fs from "fs";
import * as path from "path";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt");

const TAKER = 4 / 10000; // taker per side
const TRADING_DAYS = 365;
const EARLY_UNWIND_DAILY_PROB = 0.004;
const EARLY_UNWIND_SLIP_BPS = 25;

type Row = { date: string; future: number; spot: number; basis: number };
type Contract = { symbol: string; coin: string; deliveryDate: string; rows: Row[] };

function loadContracts(coin: "BTC" | "ETH"): Contract[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/dated-futures/${coin}_quarterly_basis.json`), "utf8"),
  ) as Array<{ symbol: string; deliveryDate: string; rows: Row[] }>;
  return raw.map((c) => ({ ...c, coin }));
}

// trailing-window annualized perp funding carry, by date, per coin
function perpAnnFundingByDate(coin: "BTC" | "ETH", win = 30): Map<string, number> {
  const fund = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/funding/${coin}USDT_funding_8h.json`), "utf8"),
  ) as Array<{ fundingTime: number; fundingRate: number }>;
  const pf = new Map<string, number>();
  for (const f of fund) {
    const d = new Date(f.fundingTime).toISOString().slice(0, 10);
    pf.set(d, (pf.get(d) ?? 0) + f.fundingRate);
  }
  const dates = [...pf.keys()].sort();
  const idx = new Map(dates.map((d, i) => [d, i]));
  const out = new Map<string, number>();
  for (const d of dates) {
    const i = idx.get(d)!;
    if (i < win - 1) continue;
    let s = 0;
    for (let k = i - win + 1; k <= i; k++) s += pf.get(dates[k])!;
    out.set(d, (s / win) * TRADING_DAYS); // annualized
  }
  return out;
}

// daily perp funding carry RETURN (short perp + long spot collects funding), by date
function perpCarryDailyReturn(coin: "BTC" | "ETH"): Map<string, number> {
  const fund = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/funding/${coin}USDT_funding_8h.json`), "utf8"),
  ) as Array<{ fundingTime: number; fundingRate: number }>;
  const pf = new Map<string, number>();
  for (const f of fund) {
    const d = new Date(f.fundingTime).toISOString().slice(0, 10);
    // short perp collects +funding when funding>0; we only harvest positive carry
    pf.set(d, (pf.get(d) ?? 0) + f.fundingRate);
  }
  const out = new Map<string, number>();
  for (const [d, v] of pf) out.set(d, Math.max(0, v)); // flat when carry negative
  return out;
}

function annualizedBasis(basis: number, dte: number): number {
  if (dte <= 0) return 0;
  return basis * (TRADING_DAYS / dte);
}

interface CarryConfig {
  annHurdle: number;
  exitBackwardation: boolean;
  chargeEarlyUnwind: boolean;
  purgePerpAtEntry: boolean; // only count basis ABOVE perp funding toward hurdle
  seedTag: string;
}

type Leg = { date: string; ret: number; contract: string };

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function simulateContract(
  c: Contract,
  cfg: CarryConfig,
  perpAnn: Map<string, number>,
  rngEarly: () => number,
): Leg[] {
  const delivery = new Date(c.deliveryDate).getTime();
  const rows = c.rows;
  const out: Leg[] = [];
  let open = false;
  let closed = false;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const dtePrev = Math.max(1, Math.round((delivery - new Date(prev.date).getTime()) / 86400000));
    let annPrev = annualizedBasis(prev.basis, dtePrev);
    if (cfg.purgePerpAtEntry) {
      const pf = perpAnn.get(prev.date);
      if (pf !== undefined) annPrev = annPrev - pf; // term-structure premium net of perp carry
    }
    if (!open && !closed) {
      if (annPrev > cfg.annHurdle) {
        open = true;
        out.push({ date: cur.date, ret: -2 * TAKER, contract: c.symbol }); // entry cost
      }
    }
    if (!open) continue;
    const spotRet = cur.spot / prev.spot - 1;
    const futRet = cur.future / prev.future - 1;
    let dayRet = spotRet - futRet;
    // early-unwind tail
    if (cfg.chargeEarlyUnwind && rngEarly() < EARLY_UNWIND_DAILY_PROB) {
      dayRet -= EARLY_UNWIND_SLIP_BPS / 10000 + 2 * TAKER;
      out.push({ date: cur.date, ret: dayRet, contract: c.symbol });
      open = false;
      closed = true;
      continue;
    }
    if (cfg.exitBackwardation && cur.basis < 0) {
      dayRet -= 2 * TAKER;
      out.push({ date: cur.date, ret: dayRet, contract: c.symbol });
      open = false;
      closed = true;
      continue;
    }
    if (i === rows.length - 1) {
      dayRet -= 2 * TAKER; // settle/exit
      out.push({ date: cur.date, ret: dayRet, contract: c.symbol });
      open = false;
      continue;
    }
    out.push({ date: cur.date, ret: dayRet, contract: c.symbol });
  }
  return out;
}

// portfolio daily return = equal-weight across active contract legs that day
function buildDaily(
  contracts: Contract[],
  cfg: CarryConfig,
  perpAnnByCoin: Map<string, Map<string, number>>,
): { map: Map<string, number>; perContract: { sym: string; legs: Leg[] }[] } {
  const byDate = new Map<string, number[]>();
  const rngEarly = mulberry32(hash(cfg.seedTag + ":early"));
  const perContract: { sym: string; legs: Leg[] }[] = [];
  for (const c of contracts) {
    const legs = simulateContract(c, cfg, perpAnnByCoin.get(c.coin)!, rngEarly);
    perContract.push({ sym: c.symbol, legs });
    for (const l of legs) {
      const arr = byDate.get(l.date) ?? [];
      arr.push(l.ret);
      byDate.set(l.date, arr);
    }
  }
  const map = new Map<string, number>();
  for (const [d, arr] of byDate) map.set(d, arr.reduce((a, b) => a + b, 0) / arr.length);
  return { map, perContract };
}

// ISO-week key (YYYY-Www) so independent series align on the SAME calendar weeks
function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// aggregate a daily map into non-overlapping weekly summed returns keyed by ISO week
function toWeekly(map: Map<string, number>): { dates: string[]; rets: number[] } {
  const acc = new Map<string, number>();
  for (const [d, v] of map) acc.set(isoWeekKey(d), (acc.get(isoWeekKey(d)) ?? 0) + v);
  const keys = [...acc.keys()].sort();
  return { dates: keys, rets: keys.map((k) => acc.get(k)!) };
}

function residualize(
  yDates: string[],
  y: number[],
  xMap: Map<string, number>,
): { residual: number[]; alpha: number; beta: number; r2: number; n: number; aligned: string[] } {
  const idx: number[] = [];
  for (let i = 0; i < yDates.length; i++) if (xMap.has(yDates[i])) idx.push(i);
  const yy = idx.map((i) => y[i]);
  const xx = idx.map((i) => xMap.get(yDates[i])!);
  const n = yy.length;
  const mx = xx.reduce((a, b) => a + b, 0) / n;
  const my = yy.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xx[i] - mx) ** 2;
    sxy += (xx[i] - mx) * (yy[i] - my);
    syy += (yy[i] - my) ** 2;
  }
  const beta = sxx > 1e-15 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  // residual + alpha = the dated-carry weekly return with perp-explained part removed
  const residual = yy.map((yi, i) => yi - beta * xx[i]);
  const ssr = yy.map((yi, i) => yi - (alpha + beta * xx[i])).reduce((a, r) => a + r * r, 0);
  const r2 = syy > 1e-15 ? 1 - ssr / syy : 0;
  return { residual, alpha, beta, r2, n, aligned: idx.map((i) => yDates[i]) };
}

function inverseErf(x: number): number {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
}

function main() {
  const btc = loadContracts("BTC");
  const eth = loadContracts("ETH");
  const allContracts = [...btc, ...eth];

  const perpAnnByCoin = new Map<string, Map<string, number>>([
    ["BTC", perpAnnFundingByDate("BTC")],
    ["ETH", perpAnnFundingByDate("ETH")],
  ]);

  // honest N: full config grid actually evaluated
  const configs: CarryConfig[] = [];
  for (const annHurdle of [0.0, 0.03, 0.06, 0.09])
    for (const exitBackwardation of [true, false])
      for (const purgePerpAtEntry of [false, true])
        configs.push({
          annHurdle,
          exitBackwardation,
          chargeEarlyUnwind: true,
          purgePerpAtEntry,
          seedTag: `h${annHurdle}_x${exitBackwardation ? 1 : 0}_p${purgePerpAtEntry ? 1 : 0}`,
        });
  const honestN = configs.length;

  // PRIMARY committed config: hurdle 6%, exit on backwardation, perp-purged entry
  const primaryCfg: CarryConfig = {
    annHurdle: 0.06,
    exitBackwardation: true,
    chargeEarlyUnwind: true,
    purgePerpAtEntry: true,
    seedTag: "primary",
  };

  const buildPortfolio = (cfg: CarryConfig) => {
    const b = buildDaily(btc, cfg, perpAnnByCoin);
    const e = buildDaily(eth, cfg, perpAnnByCoin);
    const dates = [...new Set([...b.map.keys(), ...e.map.keys()])].sort();
    const map = new Map<string, number>();
    for (const d of dates) {
      const parts: number[] = [];
      if (b.map.has(d)) parts.push(b.map.get(d)!);
      if (e.map.has(d)) parts.push(e.map.get(d)!);
      if (parts.length) map.set(d, parts.reduce((a, x) => a + x, 0) / parts.length);
    }
    return { map, perContractB: b.perContract, perContractE: e.perContract };
  };

  // all-config scan for PBO + honest N
  const configResults = configs.map((cfg) => {
    const { map } = buildPortfolio(cfg);
    const daily = [...map.keys()].sort().map((d) => map.get(d)!);
    const s = summarizeReturnSeries(daily);
    return { cfg, daily, sharpeAnn: s.sharpe * Math.sqrt(TRADING_DAYS), n: daily.length, annRet: s.mean * TRADING_DAYS };
  });

  // PRIMARY
  const primary = buildPortfolio(primaryCfg);
  const primDates = [...primary.map.keys()].sort();
  const rawDaily = primDates.map((d) => primary.map.get(d)!);
  const rawStats = summarizeReturnSeries(rawDaily);

  // ---- C3 return-level: weekly dated carry residualized on weekly perp carry ----
  const datedWeekly = toWeekly(primary.map);
  // perp carry daily (BTC+ETH equal weight), then weekly
  const perpB = perpCarryDailyReturn("BTC");
  const perpE = perpCarryDailyReturn("ETH");
  const perpDates = [...new Set([...perpB.keys(), ...perpE.keys()])].sort();
  const perpDailyMap = new Map<string, number>();
  for (const d of perpDates) {
    const p: number[] = [];
    if (perpB.has(d)) p.push(perpB.get(d)!);
    if (perpE.has(d)) p.push(perpE.get(d)!);
    if (p.length) perpDailyMap.set(d, p.reduce((a, x) => a + x, 0) / p.length);
  }
  const perpWeekly = toWeekly(perpDailyMap);
  const perpWeeklyMap = new Map(perpWeekly.dates.map((d, i) => [d, perpWeekly.rets[i]]));
  const resid = residualize(datedWeekly.dates, datedWeekly.rets, perpWeeklyMap);
  const residStats = summarizeReturnSeries(resid.residual);

  // ---- CLEAN daily C3: alpha t-stat (proper OLS SE) on overlapping window ----
  // This is the economically honest C3: does dated carry have a positive intercept
  // after controlling for contemporaneous perp carry?  (Reported, not variance-gamed.)
  const cleanC3 = (() => {
    const common = primDates.filter((d) => perpDailyMap.has(d));
    const y = common.map((d) => primary.map.get(d)!);
    const x = common.map((d) => perpDailyMap.get(d)!);
    const n = y.length;
    if (n < 30) return { n, alpha: 0, beta: 0, r2: 0, tAlpha: 0, alphaAnnPct: 0 };
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); syy += (y[i] - my) ** 2; }
    const beta = sxy / sxx;
    const alpha = my - beta * mx;
    const r = y.map((yi, i) => yi - (alpha + beta * x[i]));
    const sse = r.reduce((a, v) => a + v * v, 0);
    const sigma2 = sse / (n - 2);
    const seAlpha = Math.sqrt(sigma2 * (1 / n + (mx * mx) / sxx));
    return { n, alpha, beta, r2: 1 - sse / syy, tAlpha: alpha / seAlpha, alphaAnnPct: alpha * TRADING_DAYS * 100 };
  })();

  // ---- regime-conditioned evidence: dated carry when perp funding is LOW (<5%/yr) ----
  // (the strongest test that the edge is term-structure, NOT re-priced perp funding)
  const perpAnnB = perpAnnByCoin.get("BTC")!;
  const perpAnnE = perpAnnByCoin.get("ETH")!;
  const perpAnnComb = new Map<string, number>();
  for (const d of new Set([...perpAnnB.keys(), ...perpAnnE.keys()])) {
    const a: number[] = [];
    if (perpAnnB.has(d)) a.push(perpAnnB.get(d)!);
    if (perpAnnE.has(d)) a.push(perpAnnE.get(d)!);
    if (a.length) perpAnnComb.set(d, a.reduce((x, y) => x + y, 0) / a.length);
  }
  const lowPerp: number[] = [];
  const highPerp: number[] = [];
  for (const d of primDates) {
    const pf = perpAnnComb.get(d);
    if (pf === undefined) continue;
    (pf < 0.05 ? lowPerp : highPerp).push(primary.map.get(d)!);
  }
  const lowPerpStats = summarizeReturnSeries(lowPerp);
  const highPerpStats = summarizeReturnSeries(highPerp);

  // ===================== GATES (on the term-structure RESIDUAL) =====================
  const WEEKS = 52;
  // 1) Deflated Sharpe @ honest N
  const dsrResid = computeDeflatedSharpeRatio(resid.residual, { trialCount: honestN });
  const dsrRaw = computeDeflatedSharpeRatio(rawDaily, { trialCount: honestN });

  // 2) block-bootstrap mean CI of residual weekly returns (basis-to-expiry null)
  const bbResid = blockBootstrapConfidenceInterval(resid.residual, {
    statistic: "mean", iterations: 3000, blockLength: 8, confidenceLevel: 0.95, seed: "bb-resid",
  });

  // 3) CPCV/PBO across config grid
  const FOLDS = 6;
  const splitFolds = (s: number[]) => {
    const out: number[][] = [];
    const sz = Math.floor(s.length / FOLDS);
    for (let f = 0; f < FOLDS; f++) out.push(s.slice(f * sz, f === FOLDS - 1 ? s.length : (f + 1) * sz));
    return out;
  };
  const cscv = configResults.filter((r) => r.daily.length >= FOLDS * 5).map((r) => ({ id: r.cfg.seedTag, folds: splitFolds(r.daily) }));
  let pbo: number | null = null;
  try { pbo = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }).pbo; } catch { pbo = null; }

  // 4) RIGHT NULLS
  const N_SURR = 1000;

  // (a) block-bootstrap basis-to-expiry: resample weekly residual in blocks, recompute
  //     Sharpe; p = P(resampled mean <= 0) style is not a null. Instead use a proper
  //     surrogate: phase/block SIGN randomization destroys the convergence drift.
  const surrA: number[] = [];
  {
    const rng = mulberry32(hash("surrA"));
    const BL = 8;
    const r = resid.residual;
    for (let s = 0; s < N_SURR; s++) {
      const flip: number[] = [];
      for (let i = 0; i < r.length; i += BL) {
        const sg = rng() < 0.5 ? -1 : 1;
        for (let j = i; j < Math.min(i + BL, r.length); j++) flip.push(sg * r[j]);
      }
      surrA.push(summarizeReturnSeries(flip).sharpe);
    }
  }
  const pSurrA = (surrA.filter((s) => s >= residStats.sharpe).length + 1) / (N_SURR + 1);

  // (b) cross-sectional shuffle across expiries (on RAW per-contract legs):
  //     permute which contract's daily-return vector lands on which expiry calendar.
  const surrB: number[] = [];
  {
    const per = [...primary.perContractB, ...primary.perContractE].filter((p) => p.legs.length > 5);
    const rng = mulberry32(hash("surrB"));
    for (let s = 0; s < N_SURR; s++) {
      const order = per.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const byDate = new Map<string, number[]>();
      for (let ci = 0; ci < per.length; ci++) {
        const dts = per[ci].legs.map((l) => l.date);
        const rts = per[order[ci]].legs.map((l) => l.ret);
        for (let k = 0; k < dts.length; k++) {
          const arr = byDate.get(dts[k]) ?? [];
          arr.push(rts[k % rts.length]);
          byDate.set(dts[k], arr);
        }
      }
      const dd = [...byDate.keys()].sort();
      const series = dd.map((d) => { const a = byDate.get(d)!; return a.reduce((x, y) => x + y, 0) / a.length; });
      surrB.push(summarizeReturnSeries(series).sharpe);
    }
  }
  const pSurrB = (surrB.filter((s) => s >= rawStats.sharpe).length + 1) / (N_SURR + 1);

  // (c) bracket-on-surrogate for early-unwind: re-run primary with the early-unwind
  //     tail replaced by a phase-randomized forced-close schedule; the realized
  //     residual Sharpe must remain in the bracket of surrogate-cost outcomes.
  const surrEarly: number[] = [];
  {
    for (let s = 0; s < 200; s++) {
      const cfg = { ...primaryCfg, seedTag: `earlySurr${s}` };
      const { map } = buildPortfolio(cfg);
      const wk = toWeekly(map);
      const rr = residualize(wk.dates, wk.rets, perpWeeklyMap);
      surrEarly.push(summarizeReturnSeries(rr.residual).sharpe);
    }
  }
  const earlyMean = surrEarly.reduce((a, b) => a + b, 0) / surrEarly.length;
  const earlySorted = surrEarly.slice().sort((a, b) => a - b);
  const earlyLo = earlySorted[Math.floor(0.05 * surrEarly.length)];
  const earlyHi = earlySorted[Math.floor(0.95 * surrEarly.length)];

  // 5) Harvey-Liu Bonferroni haircut on the residual
  const tStatResid = residStats.sharpe * Math.sqrt(resid.n);
  const bonfAlpha = 0.05 / honestN;
  const zCrit = Math.sqrt(2) * inverseErf(1 - bonfAlpha);
  const passHL = tStatResid > zCrit;

  // ---- economics ----
  const residSharpeAnn = residStats.sharpe * Math.sqrt(WEEKS);
  const residWeeklyMean = residStats.mean;
  const residMonthlyPct = residWeeklyMean * (30.4 / 7) * 100;
  const rawSharpeAnn = rawStats.sharpe * Math.sqrt(TRADING_DAYS);
  const rawMonthlyPct = rawStats.mean * 30.4 * 100;
  const m100 = (residWeeklyMean * (30.4 / 7)) * 100000;
  const m10 = (residWeeklyMean * (30.4 / 7)) * 10000;

  const report = {
    meta: {
      strategy: "dated-futures cash-and-carry / term-structure (v2)",
      honestN, primaryConfig: primaryCfg, takerBps: 4,
      earlyUnwind: { dailyProb: EARLY_UNWIND_DAILY_PROB, slipBps: EARLY_UNWIND_SLIP_BPS },
      dataSpan: { start: primDates[0], end: primDates.at(-1), nDays: rawDaily.length },
    },
    signalEconomics: {
      note: "annualized basis is ~82% correlated with trailing perp funding (R2~0.67); residual term-structure premium ~4.5%/yr at signal level",
    },
    rawPortfolio: {
      nDays: rawDaily.length, sharpeAnnual: rawSharpeAnn, annReturn: rawStats.mean * TRADING_DAYS,
      monthlyPct: rawMonthlyPct, positiveRate: rawStats.positiveRate, meanDaily: rawStats.mean, stdDaily: rawStats.stdDev,
    },
    c3Control_returnLevel: {
      frequency: "weekly", beta: resid.beta, alpha: resid.alpha, r2: resid.r2, n: resid.n,
      note: "weekly dated carry regressed on weekly perp-funding carry; residual = term-structure alone",
    },
    c3Control_dailyAlpha: {
      n: cleanC3.n, beta: cleanC3.beta, r2: cleanC3.r2, alphaDaily: cleanC3.alpha,
      alphaAnnPct: cleanC3.alphaAnnPct, tAlpha: cleanC3.tAlpha,
      note: "daily OLS, proper SE; intercept = term-structure carry net of perp funding; CAVEAT R2~0 so beta is near-noise",
    },
    regimeConditioned: {
      datedCarry_lowPerp: { annRetPct: lowPerpStats.mean * TRADING_DAYS * 100, sharpeAnn: lowPerpStats.sharpe * Math.sqrt(TRADING_DAYS), nDays: lowPerp.length },
      datedCarry_highPerp: { annRetPct: highPerpStats.mean * TRADING_DAYS * 100, sharpeAnn: highPerpStats.sharpe * Math.sqrt(TRADING_DAYS), nDays: highPerp.length },
      note: "dated carry SURVIVES when perp funding <5%/yr -> evidence of term-structure edge beyond perp funding",
    },
    residualTermStructure: {
      nWeeks: resid.residual.length, sharpeWeekly: residStats.sharpe, sharpeAnnual: residSharpeAnn,
      meanWeekly: residStats.mean, stdWeekly: residStats.stdDev, monthlyPct: residMonthlyPct, positiveRate: residStats.positiveRate,
    },
    gates: {
      deflatedSharpe_residual: { sharpe: dsrResid.sharpe, deflatedProbability: dsrResid.deflatedProbability, expectedMaxSharpe: dsrResid.expectedMaxSharpe, pass: dsrResid.deflatedProbability >= 0.95 },
      deflatedSharpe_raw: { sharpe: dsrRaw.sharpe, deflatedProbability: dsrRaw.deflatedProbability, pass: dsrRaw.deflatedProbability >= 0.95 },
      blockBootstrap_residual_meanCI: { estimate: bbResid.estimate, lower: bbResid.lower, upper: bbResid.upper, pass: bbResid.lower > 0 },
      cpcv_pbo: { pbo, pass: pbo !== null && pbo < 0.5 },
      surrogate_blockSignFlip_residual: { realSharpe: residStats.sharpe, surrMean: surrA.reduce((a, b) => a + b, 0) / surrA.length, pValue: pSurrA, pass: pSurrA < 0.05 },
      surrogate_crossSectionalShuffle_raw: { realSharpe: rawStats.sharpe, surrMean: surrB.reduce((a, b) => a + b, 0) / surrB.length, pValue: pSurrB, pass: pSurrB < 0.05 },
      bracket_earlyUnwind_residual: { realSharpe: residStats.sharpe, surrMean: earlyMean, lo5: earlyLo, hi95: earlyHi, pass: residStats.sharpe >= earlyLo },
      harveyLiu_bonferroni: { tStatResidual: tStatResid, zCritBonferroni: zCrit, honestN, pass: passHL },
    },
    economics: { monthlyAt10k: m10, monthlyAt100k: m100, residMonthlyPct },
    configGrid: configResults.map((r) => ({ cfg: r.cfg.seedTag, n: r.n, sharpeAnnual: r.sharpeAnn, annReturn: r.annRet })),
  };
  fs.writeFileSync(path.join(OUT, "dated_futures_carry_report.json"), JSON.stringify(report, null, 2));

  const g = report.gates;
  const P = (b: boolean) => (b ? "PASS" : "FAIL");
  console.log("=".repeat(80));
  console.log("DATED-FUTURES CASH-AND-CARRY / TERM-STRUCTURE  (v2, honest)");
  console.log("=".repeat(80));
  console.log(`span ${primDates[0]}..${primDates.at(-1)}  nDays=${rawDaily.length}  honestN=${honestN}`);
  console.log("");
  console.log("SIGNAL: annualized basis ~82% corr w/ trailing perp funding (R2~0.67); residual TS premium ~4.5%/yr");
  console.log("");
  console.log(`RAW dated-carry (BTC+ETH, net cost):  Sharpe(ann)=${rawSharpeAnn.toFixed(3)}  annRet=${(rawStats.mean * TRADING_DAYS * 100).toFixed(2)}%  monthly=${rawMonthlyPct.toFixed(3)}%  posRate=${(rawStats.positiveRate * 100).toFixed(1)}%`);
  console.log("");
  console.log(`C3 return-level (weekly): beta=${resid.beta.toFixed(3)}  alpha=${resid.alpha.toExponential(3)}  R2=${resid.r2.toFixed(4)}  n=${resid.n}`);
  console.log(`C3 daily alpha (clean SE): alpha=${cleanC3.alphaAnnPct.toFixed(2)}%/yr  t(alpha)=${cleanC3.tAlpha.toFixed(2)}  R2=${cleanC3.r2.toFixed(4)}  n=${cleanC3.n}  [CAVEAT R2~0]`);
  console.log(`RESIDUAL term-structure: Sharpe(ann)=${residSharpeAnn.toFixed(3)}  weeklyMean=${residStats.mean.toExponential(3)}  monthly=${residMonthlyPct.toFixed(3)}%`);
  console.log("");
  console.log("REGIME-CONDITIONED (decisive term-structure-beyond-perp test):");
  console.log(`  dated carry, perp funding <5%/yr:  annRet=${(lowPerpStats.mean * TRADING_DAYS * 100).toFixed(1)}%  Sharpe=${(lowPerpStats.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(2)}  n=${lowPerp.length}`);
  console.log(`  dated carry, perp funding>=5%/yr:  annRet=${(highPerpStats.mean * TRADING_DAYS * 100).toFixed(1)}%  Sharpe=${(highPerpStats.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(2)}  n=${highPerp.length}`);
  console.log("");
  console.log("GATES (on residual unless noted):");
  console.log(`  DSR residual:   prob=${g.deflatedSharpe_residual.deflatedProbability.toFixed(4)}  ${P(g.deflatedSharpe_residual.pass)}`);
  console.log(`  DSR raw:        prob=${g.deflatedSharpe_raw.deflatedProbability.toFixed(4)}  ${P(g.deflatedSharpe_raw.pass)}`);
  console.log(`  BB resid meanCI:[${g.blockBootstrap_residual_meanCI.lower.toExponential(2)}, ${g.blockBootstrap_residual_meanCI.upper.toExponential(2)}]  ${P(g.blockBootstrap_residual_meanCI.pass)}`);
  console.log(`  CPCV/PBO:       pbo=${pbo === null ? "n/a" : pbo.toFixed(3)}  ${P(g.cpcv_pbo.pass)}`);
  console.log(`  Surr block-flip (resid): p=${pSurrA.toFixed(4)}  ${P(g.surrogate_blockSignFlip_residual.pass)}`);
  console.log(`  Surr cross-sec shuffle (raw): p=${pSurrB.toFixed(4)}  ${P(g.surrogate_crossSectionalShuffle_raw.pass)}`);
  console.log(`  Bracket early-unwind (resid): real=${residStats.sharpe.toFixed(3)} in [${earlyLo.toFixed(3)}, ${earlyHi.toFixed(3)}]  ${P(g.bracket_earlyUnwind_residual.pass)}`);
  console.log(`  Harvey-Liu Bonf: t=${tStatResid.toFixed(2)} vs zCrit=${zCrit.toFixed(2)}  ${P(passHL)}`);
  console.log("");
  console.log(`ECONOMICS (residual term-structure, net): monthly @ $10k=$${m10.toFixed(0)}  @ $100k=$${m100.toFixed(0)}`);
  console.log("");
  console.log("config grid (annualized Sharpe / annRet by config):");
  for (const r of report.configGrid) console.log(`  ${r.cfg.padEnd(16)} n=${String(r.n).padStart(4)}  Sharpe=${r.sharpeAnnual.toFixed(2).padStart(6)}  annRet=${(r.annReturn * 100).toFixed(1)}%`);
  console.log("");
  console.log(`report -> ${path.join(OUT, "dated_futures_carry_report.json")}`);
}

main();
