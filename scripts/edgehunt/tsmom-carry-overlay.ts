/**
 * EDGEHUNT: TSMOM trend overlay on the perp-funding carry book.
 *
 * Claim under test: a causal TSMOM overlay improves the carry book's LEFT TAIL
 * (crash-month return) SPECIFICALLY, beyond simply running carry at lower average
 * leverage ("super-additivity" / crash-hedge claim).
 *
 * Base = directional "long-the-carry" book built from output/funding/*:
 *   - per leg long when trailing funding has been positive (you get paid to be long),
 *     sized by carry attractiveness; daily return = spot return + funding income.
 *   - This is the version of the carry book that actually carries directional
 *     left-tail risk. (A fully delta-neutral cash-and-carry has ~0 left tail:
 *     worst month ~ -0.02%, so there is nothing for a crash hedge to improve.
 *     Reported in the console as a sanity control.)
 *
 * Overlay = causal vol-normalized TSMOM per leg (50/100d crossover sign blended
 *   with 12-1 momentum sign). Stay in carry when trend agrees (up), de-risk/exit
 *   when it disagrees. Combined book vol-targeted to the SAME target as base.
 *
 * Decisive control: MATCHED-AVERAGE-LEVERAGE carry. We scale base carry down by
 *   the overlay's realized average gross exposure, so any tail improvement must
 *   come from TIMING (firing in bad months), not from less leverage on average.
 *
 * Null: block-bootstrap the joint (carry, trend) daily panel; calendar-reanchor
 *   (phase-shift) the trend signal to confirm the hedge is conditional, not coincident.
 *
 * Costs: taker ~4bps/side on every change in net position per leg.
 *
 * Judged with the committed harness primitives (statistical-validation.ts):
 *   computeDeflatedSharpeRatio (honest N = configs tried), estimateCscvPbo,
 *   blockBootstrapConfidenceInterval, summarizeReturnSeries.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const FUND = path.join(ROOT, "output/funding");
const OUT = path.join(ROOT, "output/edgehunt");

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
const TAKER_BPS = 4; // per side, per leg, on net position change
const ANN = Math.sqrt(252);

// ---------- data ----------
type DayRow = { date: string; spot: number; perp: number; fund: number };
function loadLeg(sym: string): Map<string, DayRow> {
  const f: { fundingTime: number; fundingRate: number }[] = JSON.parse(
    fs.readFileSync(path.join(FUND, `${sym}_funding_8h.json`), "utf8"),
  );
  const fundByDay = new Map<string, number>();
  for (const r of f) {
    const d = new Date(r.fundingTime).toISOString().slice(0, 10);
    fundByDay.set(d, (fundByDay.get(d) ?? 0) + r.fundingRate); // 3x8h summed
  }
  const px: { date: string; spotClose: number; perpClose: number }[] = JSON.parse(
    fs.readFileSync(path.join(FUND, `${sym}_prices_daily.json`), "utf8"),
  );
  const m = new Map<string, DayRow>();
  for (const p of px) {
    m.set(p.date, { date: p.date, spot: p.spotClose, perp: p.perpClose, fund: fundByDay.get(p.date) ?? 0 });
  }
  return m;
}

// union calendar across all legs
const legs = new Map<string, Map<string, DayRow>>();
for (const s of SYMS) legs.set(s, loadLeg(s));
const allDates = [...new Set([...legs.values()].flatMap((m) => [...m.keys()]))].sort();

// ---------- per-leg signal series ----------
type LegSeries = {
  date: string[];
  spotRet: number[]; // daily spot return
  perpRet: number[]; // daily perp return
  fund: number[]; // daily funding (sum of 3x8h)
  trailFund: number[]; // trailing-3d funding as-of yesterday (causal carry signal)
  vol: number[]; // trailing 30d realized vol of spot ret (as-of yesterday)
  trendSig: number[]; // causal TSMOM sign in {-1,0,1} as-of yesterday
};

function buildLeg(sym: string): LegSeries {
  const m = legs.get(sym)!;
  const date: string[] = [];
  const spot: number[] = [];
  const perp: number[] = [];
  const fund: number[] = [];
  for (const d of allDates) {
    const r = m.get(d);
    if (r) {
      date.push(d);
      spot.push(r.spot);
      perp.push(r.perp);
      fund.push(r.fund);
    }
  }
  const n = date.length;
  const spotRet = new Array(n).fill(0);
  const perpRet = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    spotRet[i] = spot[i - 1] > 0 ? spot[i] / spot[i - 1] - 1 : 0;
    perpRet[i] = perp[i - 1] > 0 ? perp[i] / perp[i - 1] - 1 : 0;
  }
  const trailFund = new Array(n).fill(0);
  const vol = new Array(n).fill(0);
  const trendSig = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    // trailing 3d funding as-of i-1 (causal)
    let tf = 0;
    for (let k = 1; k <= 3; k++) if (i - k >= 0) tf += fund[i - k];
    trailFund[i] = tf;
    // trailing 30d vol of spot ret as-of i-1
    let s = 0, s2 = 0, cnt = 0;
    for (let k = 1; k <= 30; k++) if (i - k >= 0) { const x = spotRet[i - k]; s += x; s2 += x * x; cnt++; }
    vol[i] = cnt > 1 ? Math.sqrt(Math.max(1e-12, s2 / cnt - (s / cnt) ** 2)) : 0.02;
    // causal TSMOM: vol-normalized 50/100d MA crossover sign blended with 12-1 (252/21d) sign, as-of i-1
    const maShort = mean(spot, i - 1, 50);
    const maLong = mean(spot, i - 1, 100);
    const crossSig = maShort != null && maLong != null ? Math.sign(maShort - maLong) : 0;
    // 12-1 momentum: price[i-1-21] vs price[i-1-252] (skip most recent month)
    let momSig = 0;
    const pNow = i - 1 - 21, pThen = i - 1 - 252;
    if (pThen >= 0 && spot[pThen] > 0) momSig = Math.sign(spot[pNow] / spot[pThen] - 1);
    // blend: agree => strong, disagree => weak. Use average sign.
    trendSig[i] = Math.sign(crossSig + momSig); // -1,0,1
  }
  return { date, spotRet, perpRet, fund, trailFund, vol, trendSig };
}
function mean(arr: number[], endIdx: number, win: number): number | null {
  if (endIdx < win - 1) return null;
  let s = 0;
  for (let k = 0; k < win; k++) s += arr[endIdx - k];
  return s / win;
}

const series = new Map<string, LegSeries>();
for (const s of SYMS) series.set(s, buildLeg(s));

// ---------- assemble daily panel of book returns ----------
// We index everything by the global calendar `allDates`; each leg contributes on
// days it has data. Per-leg DIRECTIONAL carry exposure (as-of yesterday, causal):
//   carryWeight = clip(trailFund/scale, 0, 1)  -> long only when funding positive,
//   sized by carry attractiveness, vol-scaled to a per-leg target.
// Book = equal-risk average across legs, then panel vol-targeted.

const TARGET_LEG_VOL = 0.20 / ANN; // ~20% ann per-leg daily target
const FUND_SCALE = 0.0015; // trailing-3d funding (sum of 9 8h prints) ~ saturate around 15bps

// Build per-day, per-leg primitives keyed by global date
type Cell = { spotRet: number; perpRet: number; fund: number; carryW: number; trend: number };
const panel: Map<string, Map<string, Cell>> = new Map();
for (const d of allDates) panel.set(d, new Map());
for (const sym of SYMS) {
  const ls = series.get(sym)!;
  for (let i = 0; i < ls.date.length; i++) {
    const carryRaw = ls.trailFund[i] > 0 ? Math.min(1, ls.trailFund[i] / FUND_SCALE) : 0;
    const volScale = ls.vol[i] > 1e-6 ? Math.min(3, TARGET_LEG_VOL / ls.vol[i]) : 1;
    const carryW = carryRaw * volScale; // causal target exposure for next day
    panel.get(ls.date[i])!.set(sym, {
      spotRet: ls.spotRet[i],
      perpRet: ls.perpRet[i],
      fund: ls.fund[i],
      carryW,
      trend: ls.trendSig[i],
    });
  }
}

// ---------- book constructors ----------
// Each returns { ret: number[], dates: string[], grossExposure: number[] }
// `weightFn(cell)` -> desired per-leg signed weight (causal, as-of yesterday).
// Daily leg pnl = w * spotRet + w * fund (long spot collects? -> directional long
//   the asset PAYS funding; but the "carry" framing: we are long the asset that pays
//   POSITIVE funding to longs? No. Convention: directional-carry = long the asset,
//   and we ADD the funding the carry trade would earn as a delta-neutral overlay
//   income = w * fund (short-perp leg receives funding). i.e. fully-hedged funding
//   income is attached, plus directional spot exposure is the risk we hedge.)
// Net of cost: 4bps * |dw| per leg per side.
function runBook(weightFn: (c: Cell, prevW: number, sym: string) => number) {
  const prevW = new Map<string, number>();
  const dates: string[] = [];
  const ret: number[] = [];
  const gross: number[] = [];
  for (const d of allDates) {
    const cells = panel.get(d)!;
    if (cells.size === 0) continue;
    let dayPnl = 0;
    let dayGross = 0;
    for (const [sym, c] of cells) {
      const pw = prevW.get(sym) ?? 0;
      const w = weightFn(c, pw, sym);
      // pnl from yesterday's weight applied to today's returns
      const legPnl = pw * c.spotRet + pw * c.fund; // directional spot + attached delta-neutral funding income
      const cost = (Math.abs(w - pw) * TAKER_BPS) / 1e4; // rebalance cost (spot+perp ~ count once at taker/side; conservative single)
      dayPnl += legPnl - cost;
      dayGross += Math.abs(pw);
      prevW.set(sym, w);
    }
    const nLeg = cells.size;
    dates.push(d);
    ret.push(dayPnl / nLeg); // equal-weight across active legs
    gross.push(dayGross / nLeg);
  }
  return { dates, ret, gross };
}

// Base carry (no overlay): full directional carry weight
const base = runBook((c) => c.carryW);

// Overlay: stay in carry when trend agrees (trend>=0 i.e. up/flat), de-risk/exit when trend disagrees (trend<0)
//   trend<0 -> exit (0). trend>=0 -> keep carry. (causal)
const overlay = runBook((c) => (c.trend < 0 ? 0 : c.carryW));

// Average gross exposure of overlay vs base -> matched-leverage scalar
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const baseGross = avg(base.gross);
const overlayGross = avg(overlay.gross);
const matchScalar = overlayGross / baseGross; // < 1: overlay runs less gross on average

// DECISIVE CONTROL: matched-average-leverage carry = base * matchScalar (constant haircut, no timing)
const matched = runBook((c) => c.carryW * matchScalar);

// ---------- vol-target the combined books to common target (annualized) ----------
const TARGET_BOOK_VOL = 0.10; // 10% ann target for final books
function volTarget(ret: number[]): { scaled: number[]; lev: number[] } {
  // causal: scale by trailing 30d realized vol of the book as-of yesterday
  const scaled: number[] = [];
  const lev: number[] = [];
  for (let i = 0; i < ret.length; i++) {
    let s = 0, s2 = 0, cnt = 0;
    for (let k = 1; k <= 30; k++) if (i - k >= 0) { const x = ret[i - k]; s += x; s2 += x * x; cnt++; }
    const dv = cnt > 5 ? Math.sqrt(Math.max(1e-10, s2 / cnt - (s / cnt) ** 2)) : 0.01;
    const annV = dv * ANN;
    const L = annV > 1e-4 ? Math.min(3, TARGET_BOOK_VOL / annV) : 1;
    lev.push(L);
    scaled.push(L * ret[i]);
  }
  return { scaled, lev };
}

const baseVT = volTarget(base.ret);
const overlayVT = volTarget(overlay.ret);
const matchedVT = volTarget(matched.ret);

// ---------- helpers ----------
function toMonthly(dates: string[], ret: number[]): { month: string[]; mret: number[] } {
  const mo = new Map<string, number[]>();
  for (let i = 0; i < dates.length; i++) {
    const m = dates[i].slice(0, 7);
    if (!mo.has(m)) mo.set(m, []);
    mo.get(m)!.push(ret[i]);
  }
  const month = [...mo.keys()].sort();
  const mret = month.map((m) => mo.get(m)!.reduce((s, v) => s * (1 + v), 1) - 1);
  return { month, mret };
}
function ann(stats: { mean: number; stdDev: number }) {
  return { sharpe: stats.stdDev > 0 ? (stats.mean / stats.stdDev) * ANN : 0 };
}
function pct(x: number) { return (x * 100).toFixed(2) + "%"; }

// ---------- left-tail / crash-month decisive test ----------
// Bucket months by BASE carry monthly drawdown; show overlay & matched in the SAME (worst) months.
const baseM = toMonthly(baseVT.scaled.length ? base.dates : base.dates, base.ret);
const baseMVT = toMonthly(base.dates, baseVT.scaled);
const overlayMVT = toMonthly(overlay.dates, overlayVT.scaled);
const matchedMVT = toMonthly(matched.dates, matchedVT.scaled);

// align months
const monthsAll = baseMVT.month.filter((m) => overlayMVT.month.includes(m) && matchedMVT.month.includes(m));
const idxOf = (arr: string[], m: string) => arr.indexOf(m);
const rows = monthsAll.map((m) => ({
  month: m,
  base: baseMVT.mret[idxOf(baseMVT.month, m)],
  overlay: overlayMVT.mret[idxOf(overlayMVT.month, m)],
  matched: matchedMVT.mret[idxOf(matchedMVT.month, m)],
}));
rows.sort((a, b) => a.base - b.base); // worst base months first

const nWorst = Math.max(3, Math.round(rows.length * 0.2)); // bottom quintile
const worst = rows.slice(0, nWorst);
const rest = rows.slice(nWorst);
const meanArr = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

const worstBase = meanArr(worst.map((r) => r.base));
const worstOverlay = meanArr(worst.map((r) => r.overlay));
const worstMatched = meanArr(worst.map((r) => r.matched));
const restBase = meanArr(rest.map((r) => r.base));
const restOverlay = meanArr(rest.map((r) => r.overlay));
const restMatched = meanArr(rest.map((r) => r.matched));

// Super-additivity test: in the worst months, does overlay beat matched-leverage by MORE
// than it gives up in the good months? (the hedge should fire selectively in bad months)
const tailGain_overlay_vs_matched = worstOverlay - worstMatched;
const restGain_overlay_vs_matched = restOverlay - restMatched;

// ---------- summary stats (daily, net of cost, vol-targeted) ----------
function summarize(label: string, dates: string[], ret: number[]) {
  // aggregate guard: well under 1e5 points (daily ~ 1096), safe for summarizeReturnSeries
  const s = summarizeReturnSeries(ret);
  const a = ann(s);
  const { mret } = toMonthly(dates, ret);
  const mMean = meanArr(mret);
  return {
    label,
    n: s.sampleCount,
    annSharpe: a.sharpe,
    dailyMean: s.mean,
    annRet: s.mean * 252,
    monthlyMeanPct: mMean,
    skew: s.skewness,
    worstMonth: Math.min(...mret),
    minDay: s.min,
  };
}

const sumBase = summarize("base_carry", base.dates, baseVT.scaled);
const sumOverlay = summarize("overlay", overlay.dates, overlayVT.scaled);
const sumMatched = summarize("matched_lev", matched.dates, matchedVT.scaled);

// ---------- GATES (committed harness) ----------
// Honest N = configs tried. We tried: 2 base interpretations (delta-neutral sanity + directional)
//   x {base, overlay, matched} x signal variants explored. Count distinct overlay configs tried = N.
const HONEST_N = 24; // 7 legs not configs; configs = signal{50/100, 12-1, blend} x {exit thr} x {vol target} x book interp. Conservative honest count.

const dsrOverlay = computeDeflatedSharpeRatio(overlayVT.scaled, { trialCount: HONEST_N });
const dsrBase = computeDeflatedSharpeRatio(baseVT.scaled, { trialCount: HONEST_N });
const dsrMatched = computeDeflatedSharpeRatio(matchedVT.scaled, { trialCount: HONEST_N });

// The economically relevant test is overlay vs matched-leverage on the TAIL.
// Build the DIFFERENCE series (overlay - matched) daily and test if its mean>0 is real,
// AND specifically that the diff is concentrated in crash months (conditional).
const dlen = Math.min(overlayVT.scaled.length, matchedVT.scaled.length);
const diff: number[] = [];
const diffDates: string[] = [];
for (let i = 0; i < dlen; i++) {
  if (overlay.dates[i] === matched.dates[i]) {
    diff.push(overlayVT.scaled[i] - matchedVT.scaled[i]);
    diffDates.push(overlay.dates[i]);
  }
}
const diffStats = summarizeReturnSeries(diff);
const diffSharpe = diffStats.stdDev > 0 ? (diffStats.mean / diffStats.stdDev) * ANN : 0;
const diffDSR = computeDeflatedSharpeRatio(diff, { trialCount: HONEST_N });
const diffBB = blockBootstrapConfidenceInterval(diff, { statistic: "mean", iterations: 2000, blockLength: 20, seed: "tsmom-carry-diff" });

// ---------- SURROGATE NULL: calendar-reanchor (phase-shift) the trend signal ----------
// Re-run overlay with trend signal shifted by SHIFT days (breaks conditional alignment with
// crashes but preserves trend autocorrelation). If "edge" survives a shifted signal, it was coincident.
function runOverlayShift(shiftDays: number) {
  // rebuild panel trend shifted within each leg's own calendar
  const prevW = new Map<string, number>();
  const dates: string[] = [];
  const ret: number[] = [];
  // build shifted trend lookups per leg
  const shiftedTrend = new Map<string, Map<string, number>>();
  for (const sym of SYMS) {
    const ls = series.get(sym)!;
    const m = new Map<string, number>();
    for (let i = 0; i < ls.date.length; i++) {
      const src = i - shiftDays; // use trend from `shiftDays` earlier (mis-anchored)
      m.set(ls.date[i], src >= 0 ? ls.trendSig[src] : 0);
    }
    shiftedTrend.set(sym, m);
  }
  for (const d of allDates) {
    const cells = panel.get(d)!;
    if (cells.size === 0) continue;
    let dayPnl = 0;
    for (const [sym, c] of cells) {
      const tr = shiftedTrend.get(sym)!.get(d) ?? 0;
      const pw = prevW.get(sym) ?? 0;
      const w = tr < 0 ? 0 : c.carryW;
      const legPnl = pw * c.spotRet + pw * c.fund;
      const cost = (Math.abs(w - pw) * TAKER_BPS) / 1e4;
      dayPnl += legPnl - cost;
      prevW.set(sym, w);
    }
    dates.push(d);
    ret.push(dayPnl / cells.size);
  }
  return { dates, ret };
}

// surrogate distribution: shifts that destroy conditional alignment
const SHIFTS = [21, 42, 63, 84, 126, -21, -42, -63];
const surrogateTailGains: number[] = [];
for (const sh of SHIFTS) {
  const ov = runOverlayShift(sh);
  const ovVT = volTarget(ov.ret);
  const ovM = toMonthly(ov.dates, ovVT.scaled);
  // tail gain vs matched in the SAME worst-base months
  const g = meanArr(worst.map((r) => {
    const j = ovM.month.indexOf(r.month);
    return j >= 0 ? ovM.mret[j] - r.matched : 0;
  }));
  surrogateTailGains.push(g);
}
const realTailGain = tailGain_overlay_vs_matched;
const surrSorted = [...surrogateTailGains].sort((a, b) => a - b);
// one-sided p: fraction of surrogate tail-gains >= real tail gain
const pSurrogate = (surrogateTailGains.filter((g) => g >= realTailGain).length + 1) / (surrogateTailGains.length + 1);

// ---------- block-bootstrap the joint panel: CI on overlay-vs-matched tail gain ----------
// Resample months in blocks; recompute worst-quintile overlay-vs-matched gain.
function bootstrapTailGain(iters: number) {
  const seedR = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const months = rows.map((r) => r.month);
  const gains: number[] = [];
  const block = 3;
  for (let it = 0; it < iters; it++) {
    const sample: typeof rows = [];
    while (sample.length < rows.length) {
      const start = Math.floor(seedR() * rows.length);
      for (let b = 0; b < block && sample.length < rows.length; b++) sample.push(rows[(start + b) % rows.length]);
    }
    const sorted = [...sample].sort((a, b) => a.base - b.base);
    const w = sorted.slice(0, nWorst);
    gains.push(meanArr(w.map((r) => r.overlay - r.matched)));
  }
  gains.sort((a, b) => a - b);
  return { lo: gains[Math.floor(iters * 0.025)], hi: gains[Math.floor(iters * 0.975)], med: gains[Math.floor(iters * 0.5)] };
}
const tailGainBB = bootstrapTailGain(3000);

// ---------- CSCV/PBO: split daily series into folds, strategies = {overlay, matched, base} ----------
function folds(ret: number[], k: number): number[][] {
  const out: number[][] = [];
  const sz = Math.floor(ret.length / k);
  for (let i = 0; i < k; i++) out.push(ret.slice(i * sz, i === k - 1 ? ret.length : (i + 1) * sz));
  return out;
}
let pbo: number | null = null;
try {
  const K = 8;
  const cscv = estimateCscvPbo(
    [
      { id: "overlay", folds: folds(overlayVT.scaled, K) },
      { id: "matched", folds: folds(matchedVT.scaled, K) },
      { id: "base", folds: folds(baseVT.scaled, K) },
    ],
    { statistic: "sharpe", trainFraction: 0.5 },
  );
  pbo = cscv.pbo;
} catch (e) {
  pbo = null;
}

// ---------- delta-neutral sanity control (no left tail to hedge) ----------
function deltaNeutralCarry() {
  const prevW = new Map<string, number>();
  const dates: string[] = [];
  const ret: number[] = [];
  for (const d of allDates) {
    const cells = panel.get(d)!;
    if (cells.size === 0) continue;
    let dayPnl = 0;
    for (const [sym, c] of cells) {
      const w = c.carryW > 0 ? 1 : 0; // carry on/off
      const pw = prevW.get(sym) ?? 0;
      const legPnl = pw * (c.spotRet - c.perpRet) + pw * c.fund; // long spot short perp + funding
      const cost = (Math.abs(w - pw) * TAKER_BPS) / 1e4;
      dayPnl += legPnl - cost;
      prevW.set(sym, w);
    }
    dates.push(d);
    ret.push(dayPnl / cells.size);
  }
  return { dates, ret };
}
const dn = deltaNeutralCarry();
const dnM = toMonthly(dn.dates, dn.ret);

// ---------- $ at capital ----------
function dollarMonthly(monthlyMean: number, capital: number) {
  return monthlyMean * capital;
}

// ---------- report ----------
const report = {
  meta: {
    experiment: "tsmom-overlay-on-carry-book",
    date: new Date().toISOString(),
    symbols: SYMS,
    takerBps: TAKER_BPS,
    targetBookVolAnn: TARGET_BOOK_VOL,
    honestN: HONEST_N,
    nDailyObs: base.dates.length,
    nMonths: rows.length,
  },
  sanity_delta_neutral_carry: {
    note: "Delta-neutral cash-and-carry has ~no left tail; nothing for a crash hedge to improve.",
    worstMonthPct: Math.min(...dnM.mret),
    monthlyMeanBps: meanArr(dnM.mret) * 1e4,
    grossAnnSharpe: ann(summarizeReturnSeries(dn.ret)).sharpe,
  },
  books_net_of_cost_vol_targeted: {
    base_carry: sumBase,
    overlay: sumOverlay,
    matched_avg_leverage: sumMatched,
  },
  leverage: { baseAvgGross: baseGross, overlayAvgGross: overlayGross, matchScalar },
  DECISIVE_left_tail_test: {
    description: "Months bucketed by BASE carry drawdown. Worst quintile = crash months. Does overlay beat MATCHED-AVG-LEVERAGE carry specifically in the worst months?",
    nWorstMonths: nWorst,
    worst_months_mean_return: { base: worstBase, overlay: worstOverlay, matched_lev: worstMatched },
    rest_months_mean_return: { base: restBase, overlay: restOverlay, matched_lev: restMatched },
    overlay_minus_matched_in_TAIL: tailGain_overlay_vs_matched,
    overlay_minus_matched_in_REST: restGain_overlay_vs_matched,
    superadditive: tailGain_overlay_vs_matched > 0 && tailGain_overlay_vs_matched > Math.abs(restGain_overlay_vs_matched),
    worstMonthsTable: worst.map((r) => ({ month: r.month, base: pct(r.base), overlay: pct(r.overlay), matched: pct(r.matched) })),
  },
  gates: {
    DSR_overlay_deflatedProb: dsrOverlay.deflatedProbability,
    DSR_base_deflatedProb: dsrBase.deflatedProbability,
    DSR_matched_deflatedProb: dsrMatched.deflatedProbability,
    overlay_vs_matched_diff: {
      dailyMean: diffStats.mean,
      annSharpe: diffSharpe,
      DSR_deflatedProb: diffDSR.deflatedProbability,
      bootstrap_mean_CI: { lo: diffBB.lower, hi: diffBB.upper, excludesZero: diffBB.lower > 0 || diffBB.upper < 0 },
    },
    CSCV_PBO: pbo,
  },
  NULL_surrogate_calendar_reanchor: {
    description: "Trend signal phase-shifted by [21,42,63,84,126,-21,-42,-63] days. If tail-gain survives mis-anchoring, hedge was coincident not conditional.",
    real_tail_gain: realTailGain,
    surrogate_tail_gains: surrogateTailGains,
    surrogate_p_value: pSurrogate,
    conditional_not_coincident: pSurrogate < 0.2 && realTailGain > Math.max(...surrSorted.slice(0, surrSorted.length - 1).length ? [surrSorted[Math.floor(surrSorted.length / 2)]] : [0]),
  },
  NULL_block_bootstrap_panel: {
    description: "Block-bootstrap months; CI on worst-quintile overlay-minus-matched gain.",
    tail_gain_CI: tailGainBB,
    excludesZero: tailGainBB.lo > 0,
  },
  dollars: {
    overlay_monthly_at_10k: dollarMonthly(sumOverlay.monthlyMeanPct, 10000),
    overlay_monthly_at_100k: dollarMonthly(sumOverlay.monthlyMeanPct, 100000),
    matched_monthly_at_100k: dollarMonthly(sumMatched.monthlyMeanPct, 100000),
    base_monthly_at_100k: dollarMonthly(sumBase.monthlyMeanPct, 100000),
  },
};

fs.writeFileSync(path.join(OUT, "tsmom-carry-overlay.json"), JSON.stringify(report, null, 2));

// console digest
console.log("=== TSMOM overlay on carry book ===");
console.log("obs(daily)", report.meta.nDailyObs, "months", report.meta.nMonths, "honestN", HONEST_N);
console.log("\n-- SANITY: delta-neutral carry (no tail) --");
console.log("worstMonth", pct(report.sanity_delta_neutral_carry.worstMonthPct), "monthlyMean", report.sanity_delta_neutral_carry.monthlyMeanBps.toFixed(1) + "bps", "grossSharpe", report.sanity_delta_neutral_carry.grossAnnSharpe.toFixed(2));
console.log("\n-- BOOKS (net cost, vol-targeted 10% ann) --");
for (const b of [sumBase, sumOverlay, sumMatched]) {
  console.log(b.label.padEnd(13), "annSharpe", b.annSharpe.toFixed(3), "annRet", pct(b.annRet), "monthly", pct(b.monthlyMeanPct), "skew", b.skew.toFixed(2), "worstMo", pct(b.worstMonth));
}
console.log("\nleverage: baseGross", baseGross.toFixed(3), "overlayGross", overlayGross.toFixed(3), "matchScalar", matchScalar.toFixed(3));
console.log("\n-- DECISIVE left-tail (worst", nWorst, "months by base DD) --");
console.log("worst mean:   base", pct(worstBase), "overlay", pct(worstOverlay), "matched", pct(worstMatched));
console.log("rest  mean:   base", pct(restBase), "overlay", pct(restOverlay), "matched", pct(restMatched));
console.log("overlay-minus-matched  TAIL", pct(tailGain_overlay_vs_matched), " REST", pct(restGain_overlay_vs_matched));
console.log("superadditive?", report.DECISIVE_left_tail_test.superadditive);
console.log("\nworst months:");
for (const r of worst) console.log("  ", r.month, "base", pct(r.base), "overlay", pct(r.overlay), "matched", pct(r.matched));
console.log("\n-- GATES --");
console.log("DSR deflatedProb  overlay", dsrOverlay.deflatedProbability.toFixed(3), "base", dsrBase.deflatedProbability.toFixed(3), "matched", dsrMatched.deflatedProbability.toFixed(3));
console.log("overlay-vs-matched diff: annSharpe", diffSharpe.toFixed(3), "DSR", diffDSR.deflatedProbability.toFixed(3), "bootMeanCI [", diffBB.lower.toExponential(2), ",", diffBB.upper.toExponential(2), "] excl0", (diffBB.lower > 0 || diffBB.upper < 0));
console.log("CSCV PBO", pbo == null ? "n/a" : pbo.toFixed(3));
console.log("\n-- NULL surrogate (calendar reanchor) --");
console.log("real tailGain", pct(realTailGain), "surrogate tailGains", surrogateTailGains.map((g) => pct(g)).join(", "));
console.log("surrogate p", pSurrogate.toFixed(3));
console.log("\n-- NULL block-bootstrap panel --");
console.log("tailGain CI [", pct(tailGainBB.lo), ",", pct(tailGainBB.hi), "] med", pct(tailGainBB.med), "excludesZero", tailGainBB.lo > 0);
console.log("\n-- $ --");
console.log("overlay  monthly @10k", "$" + report.dollars.overlay_monthly_at_10k.toFixed(0), "@100k", "$" + report.dollars.overlay_monthly_at_100k.toFixed(0));
console.log("matched  monthly @100k", "$" + report.dollars.matched_monthly_at_100k.toFixed(0));
console.log("\nwrote", path.join(OUT, "tsmom-carry-overlay.json"));
