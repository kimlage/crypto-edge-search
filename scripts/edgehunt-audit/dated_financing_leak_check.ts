/**
 * DEEPEN — Dated-futures basis cash-and-carry (vol-targeted, cost/regime-stressed).
 *
 * Prior lead: scripts/edgehunt/dated_futures_carry.ts + output/edgehunt/dated_futures_carry_report.json
 *   raw dated-carry Sharpe ~2.26, residual-vs-perp term-structure t=3.25, ~7.7%/yr gross-of-financing.
 *
 * THE BURIED COST (the deciding correction): the prior P&L
 *     dayRet = (spot_t/spot_{t-1}-1) - (fut_t/fut_{t-1}-1)
 * captures basis convergence but CHARGES NO USD FINANCING on the long-spot leg.
 * A real cash-and-carry must BORROW USD (or forgo the risk-free rate on the cash) to buy spot.
 * Net carry = basis - USD_financing. And the RIGHT BENCHMARK is the risk-free rate itself:
 * a carry that earns < T-bills is NOT an edge.  We therefore report EXCESS-of-RF returns and
 * gate the EXCESS series.  (Task: "a sub-risk-free carry is PROMISING at best.")
 *
 * DEEPEN adds, pre-registered:
 *  (a) VOL-TARGETING on the delta-neutral basis spread (target 8%/yr spread vol, causal trailing 30d).
 *  (b) Realistic financing on the spot leg: USD risk-free (monthly SOFR proxy) + 1.5%/yr borrow spread,
 *      PLUS early-unwind tail (0.4%/day forced close, 25bps slip) + 4bps/side taker on every change.
 *  (c) Explicit STRESS of the thin-contango regimes: calendar-2022 (genuinely thin/backwardated,
 *      BTC ~1.2%/yr, ETH ~-3.6%/yr) and calendar-2023 (~4-7%/yr). Is net-of-financing ever negative?
 *  (d) Does the residual TERM-STRUCTURE alpha over perp carry SURVIVE vol-targeting + full financing?
 *      (prior t=3.25). Perp funding only exists 2023-06+, so the residual test is a 2023-06+ subset.
 *  (e) Directional-carry-appropriate gates: DSR @ honest N, Harvey-Liu Bonferroni, block-sign-flip
 *      surrogate, block-bootstrap CI. The cross-sectional-shuffle 'fail' is EXPECTED & not binding.
 *
 * PRE-REGISTERED PRIMARY CONFIG (single, decided before seeing gate output):
 *   annHurdle=0.06 (excess of perp carry), exitBackwardation=true, purgePerpAtEntry=true,
 *   chargeEarlyUnwind=true, volTarget=true (target 8%/yr), financing=RF+1.5% borrow,
 *   benchmark=excess-over-RF. seedTag="primary-deepen".
 *
 * JUDGE: committed primitives in src/lib/training/statistical-validation.ts. Honest N = every config tried.
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
const OUT = path.join(ROOT, "output/edgehunt-deepen");

const TAKER = 4 / 10000; // 4 bps taker per side
const TRADING_DAYS = 365;
const EARLY_UNWIND_DAILY_PROB = 0.004;
const EARLY_UNWIND_SLIP_BPS = 25;
const BORROW_SPREAD_ANN = 0.015; // 1.5%/yr USD borrow spread over RF for the long-spot leg
const VOL_TARGET_ANN = 0.08; // target 8%/yr vol on the delta-neutral spread P&L
const VOL_WIN = 30; // trailing realized-vol window (causal)
const VOL_LEV_CAP = 5; // cap leverage from vol-targeting

type Row = { date: string; future: number; spot: number; basis: number };
type Contract = { symbol: string; coin: string; deliveryDate: string; rows: Row[] };

// ---- US risk-free monthly proxy (SOFR / 3M T-bill, public, %/yr as decimal) ----
// Documented short-rate schedule 2021-09 .. 2025-09. Near-zero through 2021, hiking through 2022,
// plateau ~5.3% mid-2023..mid-2024, easing to ~4.2% by 2025-09. This is the USD financing the
// long-spot leg pays and the benchmark the carry must beat.
const RF_MONTHLY: Array<[string, number]> = [
  ["2021-09", 0.0005], ["2021-10", 0.0006], ["2021-11", 0.0007], ["2021-12", 0.0008],
  ["2022-01", 0.0010], ["2022-02", 0.0015], ["2022-03", 0.0030], ["2022-04", 0.0050],
  ["2022-05", 0.0080], ["2022-06", 0.0130], ["2022-07", 0.0190], ["2022-08", 0.0240],
  ["2022-09", 0.0290], ["2022-10", 0.0330], ["2022-11", 0.0390], ["2022-12", 0.0430],
  ["2023-01", 0.0460], ["2023-02", 0.0470], ["2023-03", 0.0485], ["2023-04", 0.0500],
  ["2023-05", 0.0510], ["2023-06", 0.0515], ["2023-07", 0.0525], ["2023-08", 0.0530],
  ["2023-09", 0.0530], ["2023-10", 0.0533], ["2023-11", 0.0533], ["2023-12", 0.0533],
  ["2024-01", 0.0533], ["2024-02", 0.0533], ["2024-03", 0.0533], ["2024-04", 0.0533],
  ["2024-05", 0.0533], ["2024-06", 0.0533], ["2024-07", 0.0530], ["2024-08", 0.0525],
  ["2024-09", 0.0500], ["2024-10", 0.0480], ["2024-11", 0.0465], ["2024-12", 0.0445],
  ["2025-01", 0.0440], ["2025-02", 0.0435], ["2025-03", 0.0433], ["2025-04", 0.0433],
  ["2025-05", 0.0430], ["2025-06", 0.0428], ["2025-07", 0.0425], ["2025-08", 0.0423],
  ["2025-09", 0.0420],
];
const RF_MAP = new Map(RF_MONTHLY);
function rfAnnual(dateStr: string): number {
  const ym = dateStr.slice(0, 7);
  return RF_MAP.get(ym) ?? 0.0425; // fallback ~last plateau
}
function rfDaily(dateStr: string): number {
  return rfAnnual(dateStr) / TRADING_DAYS;
}

function loadContracts(coin: "BTC" | "ETH"): Contract[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/dated-futures/${coin}_quarterly_basis.json`), "utf8"),
  ) as Array<{ symbol: string; deliveryDate: string; rows: Row[] }>;
  return raw.map((c) => ({ ...c, coin }));
}

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
    out.set(d, (s / win) * TRADING_DAYS);
  }
  return out;
}

function perpCarryDailyReturn(coin: "BTC" | "ETH"): Map<string, number> {
  const fund = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/funding/${coin}USDT_funding_8h.json`), "utf8"),
  ) as Array<{ fundingTime: number; fundingRate: number }>;
  const pf = new Map<string, number>();
  for (const f of fund) {
    const d = new Date(f.fundingTime).toISOString().slice(0, 10);
    pf.set(d, (pf.get(d) ?? 0) + f.fundingRate);
  }
  const out = new Map<string, number>();
  for (const [d, v] of pf) out.set(d, Math.max(0, v));
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
  purgePerpAtEntry: boolean;
  volTarget: boolean;
  chargeFinancing: boolean; // pay RF+borrow on the long-spot leg
  excessOfRF: boolean; // report return net of RF (the right benchmark)
  rfOnLeveredNotional: boolean; // AUDIT: charge RF opp-cost on lev*notional (correct) vs 1 unit (leaked)
  seedTag: string;
}

type Leg = { date: string; ret: number; contract: string; lev?: number; held?: boolean };
const LEV_TRACK: number[] = [];

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

/**
 * Simulate ONE contract leg. Raw daily basis P&L = spotRet - futRet (delta-neutral, dollar-neutral
 * mark-to-market of short-future + long-spot). Then:
 *   - chargeFinancing: subtract (RF+borrow)/365 each held day on the long-spot notional.
 *   - excessOfRF: subtract RF/365 (so the series is excess-of-T-bill). NOTE chargeFinancing already
 *     subtracts RF (in the financing term) + borrow; excessOfRF on top would double-subtract RF.
 *     To keep economics clean: financing = borrow spread ONLY when excessOfRF is on (RF is netted by
 *     the benchmark); financing = RF+borrow when excessOfRF is off (absolute return). We track both
 *     so the report can show absolute AND excess. Here we produce the EXCESS series directly.
 *   - volTarget: scale the day's spread P&L by lev_t = clip(volTarget / trailingVol, 0, cap), where
 *     trailingVol is the causal 30d realized vol of the UNLEVERED spread P&L for this leg.
 *   - early-unwind tail + taker costs as before.
 */
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
  const spreadHist: number[] = []; // trailing unlevered spread P&L for vol estimate
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const dtePrev = Math.max(1, Math.round((delivery - new Date(prev.date).getTime()) / 86400000));
    let annPrev = annualizedBasis(prev.basis, dtePrev);
    if (cfg.purgePerpAtEntry) {
      const pf = perpAnn.get(prev.date);
      if (pf !== undefined) annPrev = annPrev - pf;
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
    const spread = spotRet - futRet; // unlevered delta-neutral spread P&L

    // causal trailing realized vol of the spread (use history BEFORE this day)
    let lev = 1;
    if (cfg.volTarget) {
      if (spreadHist.length >= 10) {
        const w = spreadHist.slice(-VOL_WIN);
        const m = w.reduce((a, b) => a + b, 0) / w.length;
        const v = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1));
        const annVol = v * Math.sqrt(TRADING_DAYS);
        lev = annVol > 1e-9 ? Math.min(VOL_LEV_CAP, VOL_TARGET_ANN / annVol) : VOL_LEV_CAP;
      } else {
        lev = 1; // warmup: unlevered until we have >=10 obs
      }
    }
    spreadHist.push(spread); // update AFTER using (causal)

    let dayRet = lev * spread;
    // financing on the long-spot leg, scaled by leverage (you finance lev * notional)
    if (cfg.chargeFinancing) {
      const fin = cfg.excessOfRF
        ? BORROW_SPREAD_ANN / TRADING_DAYS // RF netted by benchmark; charge borrow spread only
        : rfDaily(cur.date) + BORROW_SPREAD_ANN / TRADING_DAYS;
      dayRet -= lev * fin;
    }
    // excess-of-RF benchmark.
    // ORIGINAL (leaked): RF charged on 1 unit. CORRECTED: RF opp-cost on lev*notional (the cash deployed
    // to buy lev*spot must forgo RF on the full levered amount, exactly like the borrow spread above).
    if (cfg.excessOfRF) {
      dayRet -= cfg.rfOnLeveredNotional ? lev * rfDaily(cur.date) : rfDaily(cur.date);
    }
    if (open) LEV_TRACK.push(lev);

    // early-unwind tail
    if (cfg.chargeEarlyUnwind && rngEarly() < EARLY_UNWIND_DAILY_PROB) {
      dayRet -= lev * (EARLY_UNWIND_SLIP_BPS / 10000) + 2 * TAKER;
      out.push({ date: cur.date, ret: dayRet, contract: c.symbol, lev, held: true });
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
      dayRet -= 2 * TAKER;
      out.push({ date: cur.date, ret: dayRet, contract: c.symbol });
      open = false;
      continue;
    }
    out.push({ date: cur.date, ret: dayRet, contract: c.symbol });
  }
  return out;
}

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

function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
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
): { residual: number[]; alpha: number; beta: number; r2: number; n: number; tAlpha: number } {
  const idx: number[] = [];
  for (let i = 0; i < yDates.length; i++) if (xMap.has(yDates[i])) idx.push(i);
  const yy = idx.map((i) => y[i]);
  const xx = idx.map((i) => xMap.get(yDates[i])!);
  const n = yy.length;
  if (n < 5) return { residual: [], alpha: 0, beta: 0, r2: 0, n, tAlpha: 0 };
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
  const residual = yy.map((yi, i) => yi - beta * xx[i]); // residual+alpha = TS-only return
  const sse = yy.map((yi, i) => yi - (alpha + beta * xx[i])).reduce((a, r) => a + r * r, 0);
  const r2 = syy > 1e-15 ? 1 - sse / syy : 0;
  const sigma2 = sse / (n - 2);
  const seAlpha = Math.sqrt(sigma2 * (1 / n + (mx * mx) / sxx));
  const tAlpha = seAlpha > 1e-15 ? alpha / seAlpha : 0;
  return { residual, alpha, beta, r2, n, tAlpha };
}

function inverseErf(x: number): number {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
}

function auditMain() {
  const btc = loadContracts("BTC");
  const eth = loadContracts("ETH");

  const perpAnnByCoin = new Map<string, Map<string, number>>([
    ["BTC", perpAnnFundingByDate("BTC")],
    ["ETH", perpAnnFundingByDate("ETH")],
  ]);

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
    return map;
  };

  const basePrimary: CarryConfig = {
    annHurdle: 0.06, exitBackwardation: true, chargeEarlyUnwind: true, purgePerpAtEntry: true,
    volTarget: true, chargeFinancing: true, excessOfRF: true, rfOnLeveredNotional: false, seedTag: "primary-deepen",
  };

  // honest-N grid (same 32 configs as the deepen script) for DSR trialCount
  const honestN = 4 * 2 * 2 * 2;

  // LEAKED (original): RF on 1 unit
  LEV_TRACK.length = 0;
  const leakedMap = buildPortfolio({ ...basePrimary, rfOnLeveredNotional: false, seedTag: "leaked" });
  const leakLev = LEV_TRACK.slice();
  const leaked = [...leakedMap.keys()].sort().map((d) => leakedMap.get(d)!);

  // CORRECTED: RF on lev*notional
  LEV_TRACK.length = 0;
  const corrMap = buildPortfolio({ ...basePrimary, rfOnLeveredNotional: true, seedTag: "leaked" });
  const corrLev = LEV_TRACK.slice();
  const corrected = [...corrMap.keys()].sort().map((d) => corrMap.get(d)!);

  const avgLev = leakLev.reduce((a, b) => a + b, 0) / leakLev.length;
  const maxLev = Math.max(...leakLev);
  const sLeak = summarizeReturnSeries(leaked);
  const sCorr = summarizeReturnSeries(corrected);
  const annF = Math.sqrt(TRADING_DAYS);
  const dsrLeak = computeDeflatedSharpeRatio(leaked, { trialCount: honestN });
  const dsrCorr = computeDeflatedSharpeRatio(corrected, { trialCount: honestN });
  const dsrLeakN1 = computeDeflatedSharpeRatio(leaked, { trialCount: 1 });
  const dsrCorrN1 = computeDeflatedSharpeRatio(corrected, { trialCount: 1 });

  const audit = {
    note: "Audit spot-check: charge RF opportunity-cost on the FULL levered notional (lev*RF/365) instead of 1 unit.",
    avgLeverage: avgLev,
    maxLeverage: maxLev,
    nHeldDays: leakLev.length,
    leaked_RFon1unit: {
      nDays: leaked.length,
      sharpeAnnual: sLeak.sharpe * annF,
      annReturnPct: sLeak.mean * TRADING_DAYS * 100,
      monthlyPct: sLeak.mean * 30.4 * 100,
      monthlyAt100k: sLeak.mean * 30.4 * 100000,
      tStat: sLeak.sharpe * Math.sqrt(leaked.length),
      dsrAtHonestN: dsrLeak.deflatedProbability,
      dsrAtN1: dsrLeakN1.deflatedProbability,
    },
    corrected_RFonLevered: {
      nDays: corrected.length,
      sharpeAnnual: sCorr.sharpe * annF,
      annReturnPct: sCorr.mean * TRADING_DAYS * 100,
      monthlyPct: sCorr.mean * 30.4 * 100,
      monthlyAt100k: sCorr.mean * 30.4 * 100000,
      tStat: sCorr.sharpe * Math.sqrt(corrected.length),
      dsrAtHonestN: dsrCorr.deflatedProbability,
      dsrAtN1: dsrCorrN1.deflatedProbability,
    },
    sharpe_ratio_corrected_over_leaked: (sCorr.sharpe * annF) / (sLeak.sharpe * annF),
    extra_rf_drag_annPct: ((sLeak.mean - sCorr.mean) * TRADING_DAYS) * 100,
  };
  fs.writeFileSync(path.join(ROOT, "output/edgehunt-audit/dated_financing_leak_check.json"), JSON.stringify(audit, null, 2));
  console.log(JSON.stringify(audit, null, 2));
}

auditMain();

function main() {
  const btc = loadContracts("BTC");
  const eth = loadContracts("ETH");

  const perpAnnByCoin = new Map<string, Map<string, number>>([
    ["BTC", perpAnnFundingByDate("BTC")],
    ["ETH", perpAnnFundingByDate("ETH")],
  ]);

  // ---- honest N: full config grid actually evaluated (deepen) ----
  const configs: CarryConfig[] = [];
  for (const annHurdle of [0.0, 0.03, 0.06, 0.09])
    for (const exitBackwardation of [true, false])
      for (const purgePerpAtEntry of [false, true])
        for (const volTarget of [false, true])
          configs.push({
            annHurdle,
            exitBackwardation,
            chargeEarlyUnwind: true,
            purgePerpAtEntry,
            volTarget,
            chargeFinancing: true,
            excessOfRF: true,
            seedTag: `h${annHurdle}_x${exitBackwardation ? 1 : 0}_p${purgePerpAtEntry ? 1 : 0}_v${volTarget ? 1 : 0}`,
          });
  const honestN = configs.length;

  // PRE-REGISTERED PRIMARY (decided up front)
  const primaryCfg: CarryConfig = {
    annHurdle: 0.06,
    exitBackwardation: true,
    chargeEarlyUnwind: true,
    purgePerpAtEntry: true,
    volTarget: true,
    chargeFinancing: true,
    excessOfRF: true,
    seedTag: "primary-deepen",
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

  // all-config scan for PBO + honest N (EXCESS-of-RF net series)
  const configResults = configs.map((cfg) => {
    const { map } = buildPortfolio(cfg);
    const daily = [...map.keys()].sort().map((d) => map.get(d)!);
    const s = summarizeReturnSeries(daily);
    return { cfg, daily, sharpeAnn: s.sharpe * Math.sqrt(TRADING_DAYS), n: daily.length, annRet: s.mean * TRADING_DAYS };
  });

  // PRIMARY (excess-of-RF, net, vol-targeted)
  const primary = buildPortfolio(primaryCfg);
  const primDates = [...primary.map.keys()].sort();
  const rawDaily = primDates.map((d) => primary.map.get(d)!);
  const rawStats = summarizeReturnSeries(rawDaily);

  // ALSO build an ABSOLUTE-return version (financing=RF+borrow, NOT excess) for reporting absolute level
  const absCfg: CarryConfig = { ...primaryCfg, excessOfRF: false, seedTag: "primary-deepen-abs" };
  const absPort = buildPortfolio(absCfg);
  const absDaily = [...absPort.map.keys()].sort().map((d) => absPort.map.get(d)!);
  const absStats = summarizeReturnSeries(absDaily);

  // ---- C3 return-level: weekly EXCESS dated carry residualized on weekly perp carry ----
  const datedWeekly = toWeekly(primary.map);
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

  // ---- regime stress: per calendar year, EXCESS-of-RF net dated carry (the deciding stress) ----
  const byYear = new Map<string, number[]>();
  for (const d of primDates) {
    const y = d.slice(0, 4);
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(primary.map.get(d)!);
  }
  const regimeYears: Record<string, { annRetPct: number; sharpeAnn: number; nDays: number; meanDaily: number; posRate: number }> = {};
  for (const [y, arr] of [...byYear.entries()].sort()) {
    const s = summarizeReturnSeries(arr);
    regimeYears[y] = {
      annRetPct: s.mean * TRADING_DAYS * 100,
      sharpeAnn: s.sharpe * Math.sqrt(TRADING_DAYS),
      nDays: arr.length,
      meanDaily: s.mean,
      posRate: s.positiveRate,
    };
  }
  // also the ABSOLUTE (not excess) per-year, to show the raw level vs RF
  const byYearAbs = new Map<string, number[]>();
  const absDates = [...absPort.map.keys()].sort();
  for (const d of absDates) {
    const y = d.slice(0, 4);
    (byYearAbs.get(y) ?? byYearAbs.set(y, []).get(y)!).push(absPort.map.get(d)!);
  }
  const regimeYearsAbs: Record<string, { annRetPct: number; rfAnnPct: number; nDays: number }> = {};
  for (const [y, arr] of [...byYearAbs.entries()].sort()) {
    const s = summarizeReturnSeries(arr);
    // mean RF over the days present
    const dys = absDates.filter((d) => d.slice(0, 4) === y);
    const rfMean = dys.reduce((a, d) => a + rfAnnual(d), 0) / dys.length;
    regimeYearsAbs[y] = { annRetPct: s.mean * TRADING_DAYS * 100, rfAnnPct: rfMean * 100, nDays: arr.length };
  }

  // ===================== GATES (directional-carry-appropriate) =====================
  const WEEKS = 52;
  // 1) Deflated Sharpe @ honest N on (i) EXCESS raw daily, (ii) residual weekly
  const dsrRaw = computeDeflatedSharpeRatio(rawDaily, { trialCount: honestN });
  const dsrResid = resid.residual.length >= 5
    ? computeDeflatedSharpeRatio(resid.residual, { trialCount: honestN })
    : null;

  // 2) block-bootstrap mean CI: EXCESS raw daily AND residual weekly
  const bbRaw = blockBootstrapConfidenceInterval(rawDaily, {
    statistic: "mean", iterations: 3000, blockLength: 20, confidenceLevel: 0.95, seed: "bb-raw-deepen",
  });
  const bbResid = resid.residual.length >= 5 ? blockBootstrapConfidenceInterval(resid.residual, {
    statistic: "mean", iterations: 3000, blockLength: 8, confidenceLevel: 0.95, seed: "bb-resid-deepen",
  }) : null;

  // 3) CPCV/PBO across config grid (excess net)
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

  // 4) Block-sign-flip surrogate (the RIGHT null for directional carry) on EXCESS raw daily
  const N_SURR = 1000;
  const surrFlip: number[] = [];
  {
    const rng = mulberry32(hash("surrFlip-deepen"));
    const BL = 20;
    const r = rawDaily;
    for (let s = 0; s < N_SURR; s++) {
      const flip: number[] = [];
      for (let i = 0; i < r.length; i += BL) {
        const sg = rng() < 0.5 ? -1 : 1;
        for (let j = i; j < Math.min(i + BL, r.length); j++) flip.push(sg * r[j]);
      }
      surrFlip.push(summarizeReturnSeries(flip).sharpe);
    }
  }
  const pSurrFlip = (surrFlip.filter((s) => s >= rawStats.sharpe).length + 1) / (N_SURR + 1);

  // 5) Block-sign-flip surrogate on the residual weekly (TS-alpha null)
  let pSurrResid: number | null = null;
  if (resid.residual.length >= 10) {
    const surrR: number[] = [];
    const rng = mulberry32(hash("surrResid-deepen"));
    const BL = 8;
    const r = resid.residual;
    for (let s = 0; s < N_SURR; s++) {
      const flip: number[] = [];
      for (let i = 0; i < r.length; i += BL) {
        const sg = rng() < 0.5 ? -1 : 1;
        for (let j = i; j < Math.min(i + BL, r.length); j++) flip.push(sg * r[j]);
      }
      surrR.push(summarizeReturnSeries(flip).sharpe);
    }
    pSurrResid = (surrR.filter((s) => s >= residStats.sharpe).length + 1) / (N_SURR + 1);
  }

  // 6) cross-sectional shuffle (EXPECTED FAIL for directional carry — reported, NOT binding)
  const surrCS: number[] = [];
  {
    const per = [...primary.perContractB, ...primary.perContractE].filter((p) => p.legs.length > 5);
    const rng = mulberry32(hash("surrCS-deepen"));
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
      surrCS.push(summarizeReturnSeries(series).sharpe);
    }
  }
  const pSurrCS = (surrCS.filter((s) => s >= rawStats.sharpe).length + 1) / (N_SURR + 1);

  // 7) Harvey-Liu Bonferroni haircut on EXCESS raw daily (the deployable series)
  const tStatRaw = rawStats.sharpe * Math.sqrt(rawDaily.length);
  const tStatResid = resid.residual.length >= 5 ? residStats.sharpe * Math.sqrt(resid.n) : 0;
  const bonfAlpha = 0.05 / honestN;
  const zCrit = Math.sqrt(2) * inverseErf(1 - bonfAlpha);
  const passHLraw = tStatRaw > zCrit;
  const passHLresid = tStatResid > zCrit;

  // ---- economics (EXCESS-of-RF, net, vol-targeted) ----
  const rawSharpeAnn = rawStats.sharpe * Math.sqrt(TRADING_DAYS);
  const rawMonthlyPct = rawStats.mean * 30.4 * 100;
  const m100 = rawStats.mean * 30.4 * 100000;
  const m10 = rawStats.mean * 30.4 * 10000;
  const residSharpeAnn = residStats.sharpe * Math.sqrt(WEEKS);

  // ----- binding-gate logic for a DIRECTIONAL CARRY -----
  // Deployable requires: EXCESS-of-RF mean > 0 (beats T-bills), DSR pass, HL pass, surrogate pass,
  // bootstrap CI lower > 0, PBO < 0.5. Cross-sectional shuffle is EXPECTED to fail -> NOT binding.
  const gateChecks: Array<[string, boolean]> = [
    ["excess_positive", rawStats.mean > 0],
    ["deflated_sharpe_excess", dsrRaw.deflatedProbability >= 0.95],
    ["block_bootstrap_excess_CI", bbRaw.lower > 0],
    ["cpcv_pbo", pbo !== null && pbo < 0.5],
    ["surrogate_block_sign_flip_excess", pSurrFlip < 0.05],
    ["harvey_liu_bonferroni_excess", passHLraw],
  ];
  let binding = "none";
  for (const [name, pass] of gateChecks) if (!pass) { binding = name; break; }

  // SURVIVE only if excess-of-RF beats benchmark AND all binding gates pass.
  // PROMISING if positive-but-below-benchmark OR a multiple-testing gate trips but core holds.
  const corePass = rawStats.mean > 0 && pSurrFlip < 0.05;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (binding === "none") verdict = "SURVIVE";
  else if (corePass && rawStats.mean > 0) verdict = "PROMISING";
  else verdict = "KILL";

  const report = {
    meta: {
      strategy: "dated-futures cash-and-carry / term-structure (DEEPEN: vol-targeted, financing-charged, excess-of-RF)",
      honestN,
      primaryConfig: primaryCfg,
      takerBps: 4,
      borrowSpreadAnn: BORROW_SPREAD_ANN,
      volTargetAnn: VOL_TARGET_ANN,
      volLevCap: VOL_LEV_CAP,
      earlyUnwind: { dailyProb: EARLY_UNWIND_DAILY_PROB, slipBps: EARLY_UNWIND_SLIP_BPS },
      benchmark: "excess-over-US-risk-free (monthly SOFR/T-bill proxy); financing=RF+1.5% borrow on long-spot",
      dataSpan: { start: primDates[0], end: primDates.at(-1), nDays: rawDaily.length },
      fundingDataStart: "2023-06-01 (perp residual test is a 2023-06+ subset)",
    },
    primaryExcessOfRF: {
      nDays: rawDaily.length,
      sharpeAnnual: rawSharpeAnn,
      annReturnPct: rawStats.mean * TRADING_DAYS * 100,
      monthlyPct: rawMonthlyPct,
      positiveRate: rawStats.positiveRate,
      meanDaily: rawStats.mean,
      stdDaily: rawStats.stdDev,
      tStat: tStatRaw,
    },
    primaryAbsoluteReturn: {
      annReturnPct: absStats.mean * TRADING_DAYS * 100,
      sharpeAnnual: absStats.sharpe * Math.sqrt(TRADING_DAYS),
      note: "absolute net return (financing=RF+borrow). Compare to RF to see if it beats T-bills.",
    },
    residualTermStructure_2023plus: dsrResid ? {
      nWeeks: resid.residual.length,
      sharpeWeekly: residStats.sharpe,
      sharpeAnnual: residSharpeAnn,
      meanWeekly: residStats.mean,
      alpha: resid.alpha,
      beta: resid.beta,
      r2: resid.r2,
      tAlpha: resid.tAlpha,
      n: resid.n,
      note: "weekly EXCESS dated carry residualized on weekly perp carry; funding only exists 2023-06+",
    } : { note: "insufficient overlap" },
    regimeStress_byYear_excessOfRF: regimeYears,
    regimeStress_byYear_absolute_vs_RF: regimeYearsAbs,
    gates: {
      excess_positive: { meanDaily: rawStats.mean, pass: rawStats.mean > 0 },
      deflatedSharpe_excess: { sharpe: dsrRaw.sharpe, deflatedProbability: dsrRaw.deflatedProbability, expectedMaxSharpe: dsrRaw.expectedMaxSharpe, pass: dsrRaw.deflatedProbability >= 0.95 },
      deflatedSharpe_residual_2023plus: dsrResid ? { sharpe: dsrResid.sharpe, deflatedProbability: dsrResid.deflatedProbability, pass: dsrResid.deflatedProbability >= 0.95 } : null,
      blockBootstrap_excess_meanCI: { estimate: bbRaw.estimate, lower: bbRaw.lower, upper: bbRaw.upper, pass: bbRaw.lower > 0 },
      blockBootstrap_residual_meanCI: bbResid ? { estimate: bbResid.estimate, lower: bbResid.lower, upper: bbResid.upper, pass: bbResid.lower > 0 } : null,
      cpcv_pbo: { pbo, pass: pbo !== null && pbo < 0.5 },
      surrogate_blockSignFlip_excess: { realSharpe: rawStats.sharpe, surrMean: surrFlip.reduce((a, b) => a + b, 0) / surrFlip.length, pValue: pSurrFlip, pass: pSurrFlip < 0.05 },
      surrogate_blockSignFlip_residual: pSurrResid !== null ? { realSharpe: residStats.sharpe, pValue: pSurrResid, pass: pSurrResid < 0.05 } : null,
      surrogate_crossSectionalShuffle_EXPECTED_FAIL: { realSharpe: rawStats.sharpe, surrMean: surrCS.reduce((a, b) => a + b, 0) / surrCS.length, pValue: pSurrCS, pass: pSurrCS < 0.05, note: "EXPECTED to fail for a pure directional carry; NOT a binding gate" },
      harveyLiu_bonferroni_excess: { tStat: tStatRaw, zCrit, honestN, pass: passHLraw },
      harveyLiu_bonferroni_residual: { tStat: tStatResid, zCrit, pass: passHLresid },
    },
    economics: { monthlyAt10k: m10, monthlyAt100k: m100, excessMonthlyPct: rawMonthlyPct },
    bindingGate: binding,
    verdict,
    configGrid: configResults.map((r) => ({ cfg: r.cfg.seedTag, n: r.n, sharpeAnnual: r.sharpeAnn, annReturnPct: r.annRet * 100 })),
  };
  fs.writeFileSync(path.join(OUT, "_audit_unused_report.json"), JSON.stringify(report, null, 2));

  const P = (b: boolean) => (b ? "PASS" : "FAIL");
  console.log("=".repeat(84));
  console.log("DATED-FUTURES CASH-AND-CARRY  (DEEPEN: vol-targeted, financing-charged, EXCESS-of-RF)");
  console.log("=".repeat(84));
  console.log(`span ${primDates[0]}..${primDates.at(-1)}  nDays=${rawDaily.length}  honestN=${honestN}`);
  console.log(`financing=RF(monthly SOFR proxy)+${(BORROW_SPREAD_ANN*100).toFixed(1)}% borrow; volTarget=${(VOL_TARGET_ANN*100).toFixed(0)}%/yr cap=${VOL_LEV_CAP}x; taker=4bps/side`);
  console.log("");
  console.log("PRIMARY (EXCESS-of-RF, net, vol-targeted) — the deployable series & RIGHT benchmark:");
  console.log(`  Sharpe(ann)=${rawSharpeAnn.toFixed(3)}  excessAnnRet=${(rawStats.mean*TRADING_DAYS*100).toFixed(2)}%  monthly=${rawMonthlyPct.toFixed(3)}%  posRate=${(rawStats.positiveRate*100).toFixed(1)}%  t=${tStatRaw.toFixed(2)}`);
  console.log(`  ABSOLUTE net (financing=RF+borrow): annRet=${(absStats.mean*TRADING_DAYS*100).toFixed(2)}%  Sharpe=${(absStats.sharpe*Math.sqrt(TRADING_DAYS)).toFixed(2)}`);
  console.log("");
  console.log("RESIDUAL term-structure over perp carry (2023-06+ subset):");
  if (dsrResid) console.log(`  Sharpe(ann,wk)=${residSharpeAnn.toFixed(3)}  alpha=${resid.alpha.toExponential(3)}  t(alpha)=${resid.tAlpha.toFixed(2)}  beta=${resid.beta.toFixed(3)}  R2=${resid.r2.toFixed(4)}  n=${resid.n}`);
  else console.log("  insufficient overlap");
  console.log("");
  console.log("REGIME STRESS (EXCESS-of-RF net by calendar year — is it ever NEGATIVE?):");
  for (const [y, r] of Object.entries(regimeYears)) {
    const ar = regimeYearsAbs[y];
    console.log(`  ${y}: excessAnnRet=${r.annRetPct.toFixed(2).padStart(7)}%  Sharpe=${r.sharpeAnn.toFixed(2).padStart(6)}  posRate=${(r.posRate*100).toFixed(0)}%  n=${r.nDays}  | absRet=${ar.annRetPct.toFixed(2)}% vs RF=${ar.rfAnnPct.toFixed(2)}%`);
  }
  console.log("");
  console.log("GATES (directional-carry-appropriate; cross-sec shuffle EXPECTED fail, not binding):");
  console.log(`  excess>0:            mean=${rawStats.mean.toExponential(2)}  ${P(rawStats.mean>0)}`);
  console.log(`  DSR excess:          prob=${dsrRaw.deflatedProbability.toFixed(4)}  ${P(dsrRaw.deflatedProbability>=0.95)}`);
  console.log(`  BB excess meanCI:    [${bbRaw.lower.toExponential(2)}, ${bbRaw.upper.toExponential(2)}]  ${P(bbRaw.lower>0)}`);
  console.log(`  CPCV/PBO:            pbo=${pbo===null?"n/a":pbo.toFixed(3)}  ${P(pbo!==null&&pbo<0.5)}`);
  console.log(`  Surr block-flip exc: p=${pSurrFlip.toFixed(4)}  ${P(pSurrFlip<0.05)}`);
  console.log(`  Harvey-Liu Bonf exc: t=${tStatRaw.toFixed(2)} vs zCrit=${zCrit.toFixed(2)}  ${P(passHLraw)}`);
  console.log(`  -- residual (2023+) DSR:  ${dsrResid?dsrResid.deflatedProbability.toFixed(4):"n/a"}  ${dsrResid?P(dsrResid.deflatedProbability>=0.95):"n/a"}`);
  console.log(`  -- residual surr flip:    p=${pSurrResid===null?"n/a":pSurrResid.toFixed(4)}  ${pSurrResid===null?"n/a":P(pSurrResid<0.05)}`);
  console.log(`  -- residual HL Bonf:      t=${tStatResid.toFixed(2)} vs ${zCrit.toFixed(2)}  ${P(passHLresid)}`);
  console.log(`  [EXPECTED FAIL] cross-sec shuffle: p=${pSurrCS.toFixed(4)}  ${P(pSurrCS<0.05)}`);
  console.log("");
  console.log(`ECONOMICS (excess-of-RF, net): monthly @ $10k=$${m10.toFixed(0)}  @ $100k=$${m100.toFixed(0)}`);
  console.log("");
  console.log("config grid (excess-of-RF annualized Sharpe / annRet):");
  for (const r of report.configGrid) console.log(`  ${r.cfg.padEnd(22)} n=${String(r.n).padStart(4)}  Sharpe=${r.sharpeAnnual.toFixed(2).padStart(6)}  excessAnnRet=${r.annReturnPct.toFixed(1)}%`);
  console.log("");
  console.log(`BINDING GATE: ${binding}   VERDICT: ${verdict}`);
  console.log(`report -> ${path.join(OUT, "dated_futures_carry_deepen_report.json")}`);
}

// main();  // disabled in audit; only auditMain() runs
