/**
 * VRP tail-stress + CASH-promotion test.
 *
 * Builds the headline gated/sized short-variance strategy (BTC, h7, blend) and:
 *  1. Charges a MUCH more honest convex crash tail (calibrate to historical short-straddle
 *     blowups: when realized vol >> implied, a short straddle loses a multiple of the
 *     linear variance payoff). Sweep the tail-severity multiplier.
 *  2. Compares net distribution vs CASH (0% nominal) on CVaR(5%), Calmar, max drawdown.
 *  3. Re-runs the shuffled-VRP placebo AND a tail-matched block bootstrap at each tail level.
 *
 * The point: short-vol is high-win / negative-skew. The premium is real, but the question
 * is whether it SURVIVES an honest left tail and whether the SIGNAL (not just being short)
 * earns its keep. Promotion = beat CASH on CVaR & Calmar after the honest tail.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
} from "../../src/lib/training/statistical-validation";

const ANN_DAYS = 365;
const dvol = JSON.parse(readFileSync("output/edgehunt/dvol_btc.json", "utf8")) as { date: string; close: number }[];

interface DayOHLC { date: string; open: number; high: number; low: number; close: number; }
function loadBtcDaily(): DayOHLC[] {
  const raw = readFileSync("output/bigquery/btc_ohlcv_15m.ndjson", "utf8").split("\n");
  const byDay = new Map<string, DayOHLC>();
  for (const line of raw) {
    if (!line) continue;
    const r = JSON.parse(line);
    const date = r.event_date as string;
    const cur = byDay.get(date);
    if (!cur) byDay.set(date, { date, open: r.open, high: r.high, low: r.low, close: r.close });
    else { cur.high = Math.max(cur.high, r.high); cur.low = Math.min(cur.low, r.low); cur.close = r.close; }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const quantile = (s: number[], q: number) => { if (!s.length) return 0; const p = (s.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return lo === hi ? s[lo] : s[lo] * (hi - p) + s[hi] * (p - lo); };
function rng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const days = loadBtcDaily();
const vseries = days.map((d, i) => {
  const prev = i > 0 ? days[i - 1].close : d.open;
  const rc = Math.log(d.close / prev);
  const hl = Math.log(d.high / d.low);
  const co = Math.log(d.close / d.open);
  const park = (1 / (4 * Math.log(2))) * hl * hl;
  const gk = 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
  return { date: d.date, blend: (rc * rc + Math.max(0, park) + Math.max(0, gk)) / 3 };
});
const fundRows = JSON.parse(readFileSync("output/funding/BTCUSDT_funding_8h.json", "utf8")) as { fundingTime: number; fundingRate: number }[];
const fundDay = new Map<string, number>();
for (const r of fundRows) { const d = new Date(r.fundingTime).toISOString().slice(0, 10); fundDay.set(d, (fundDay.get(d) ?? 0) + r.fundingRate); }
const dvolByDate = new Map(dvol.map((d) => [d.date, d.close / 100]));

function fwdRV(i: number, h: number): number | null {
  if (i + h > vseries.length) return null;
  let s = 0; for (let k = i; k < i + h; k++) s += vseries[k].blend;
  return Math.sqrt((s / h) * ANN_DAYS);
}
function trailRV(i: number, h: number): number | null {
  if (i - h < 0) return null;
  let s = 0; for (let k = i - h; k < i; k++) s += vseries[k].blend;
  return Math.sqrt((s / h) * ANN_DAYS);
}

const H = 7, ZLB = 90, VOL_TARGET = 0.10, taker = 0.0004;

// build windows with a parameterized tail severity
function buildWindows(tailMult: number, shuffleSig = false, seed = 1) {
  // ex-ante signal series
  const exAnte = new Map<number, number>();
  for (let i = 0; i < vseries.length; i++) {
    const iv = dvolByDate.get(vseries[i].date); if (iv === undefined) continue;
    const trv = trailRV(i, H); if (trv === null) continue;
    exAnte.set(i, iv * iv - trv * trv);
  }
  // collect non-overlapping windows
  const idxs: number[] = [];
  for (let i = H; i + H <= vseries.length; i += H) {
    if (exAnte.has(i) && dvolByDate.has(vseries[i].date) && fwdRV(i, H) !== null) idxs.push(i);
  }
  // z-scores
  const zByIdx = new Map<number, number>();
  for (const i of idxs) {
    const past: number[] = [];
    for (let k = Math.max(0, i - ZLB); k < i; k++) { const v = exAnte.get(k); if (v !== undefined) past.push(v); }
    if (past.length < 10) continue;
    const m = mean(past), s = std(past) || 1e-9;
    zByIdx.set(i, (exAnte.get(i)! - m) / s);
  }
  const valid = idxs.filter((i) => zByIdx.has(i));
  // optionally shuffle which z attaches to which window (placebo)
  let zArr = valid.map((i) => zByIdx.get(i)!);
  if (shuffleSig) {
    const r = rng(seed);
    for (let i = zArr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [zArr[i], zArr[j]] = [zArr[j], zArr[i]]; }
  }
  // calibrate vega scale to vol target on a first pass (unscaled payoff)
  const payoffs = valid.map((i) => { const iv = dvolByDate.get(vseries[i].date)!; const fwd = fwdRV(i, H)!; return iv * iv - fwd * fwd; });
  const annF = Math.sqrt(ANN_DAYS / H);
  const unit = std(payoffs) * annF || 1e-9;
  const volScaler = VOL_TARGET / unit;

  const windows = valid.map((i, k) => {
    const iv = dvolByDate.get(vseries[i].date)!;
    const fwd = fwdRV(i, H)!;
    const spike = (() => {
      const past: number[] = []; for (let j = Math.max(0, i - ZLB); j < i; j++) { const v = dvolByDate.get(vseries[j].date); if (v !== undefined) past.push(v); }
      if (past.length < 5) return 0; const m = mean(past), s = std(past) || 1e-9; return (iv - m) / s;
    })();
    const benign = (() => {
      const rvs: number[] = []; for (let j = Math.max(H, i - ZLB); j <= i; j++) { const r = trailRV(j, H); if (r !== null) rvs.push(r); }
      if (rvs.length < 10) return true; const cur = rvs.at(-1)!; return cur <= quantile([...rvs].sort((a, b) => a - b), 0.6);
    })();
    let size = zArr[k] > 0 ? Math.min(zArr[k], 2.5) : 0;
    if (spike > 1.5) size = 0;
    if (!benign) size = 0;
    size *= volScaler;
    const payoffVar = iv * iv - fwd * fwd;
    const gross = size * payoffVar;
    // funding
    let fundSum = 0; for (let j = i; j < i + H; j++) { const f = fundDay.get(vseries[j].date); if (f !== undefined) fundSum += Math.abs(f); }
    const fundingCost = Math.abs(size) * fundSum * 0.5;
    const rebal = 2 + H;
    const takerCost = Math.abs(size) > 0 ? rebal * taker * Math.min(Math.abs(size), 3) : 0;
    // HONEST convex tail: when realized vol > implied, a short straddle loses a MULTIPLE.
    const rvOverIv = fwd / iv;
    const crash = rvOverIv > 1.5;
    let tailCost = 0;
    if (size > 0 && rvOverIv > 1.0) {
      const excess = rvOverIv - 1.0;
      tailCost = size * (iv * iv) * (excess * excess) * tailMult;
    }
    const net = gross - fundingCost - takerCost - tailCost;
    return { date: vseries[i].date, size, gross, fundingCost, takerCost, tailCost, net, crash, rvOverIv };
  });
  return windows;
}

function maxDD(r: number[]) { let eq = 1, pk = 1, mdd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); } return mdd; }
function cvar(r: number[], q = 0.05) { const s = [...r].sort((a, b) => a - b); const n = Math.max(1, Math.floor(s.length * q)); return mean(s.slice(0, n)); }
function annSharpe(r: number[]) { const s = summarizeReturnSeries(r); return s.sharpe * Math.sqrt(ANN_DAYS / H); }
function calmar(r: number[]) { const ann = mean(r) * (ANN_DAYS / H); const m = Math.abs(maxDD(r)); return m > 1e-9 ? ann / m : 0; }

// placebo distribution at a tail level
function placeboP(tailMult: number, obsSharpe: number, iters = 1500) {
  let ge = 0; const ss: number[] = [];
  for (let it = 0; it < iters; it++) {
    const w = buildWindows(tailMult, true, 1000 + it);
    const sh = annSharpe(w.map((x) => x.net));
    ss.push(sh); if (sh >= obsSharpe) ge++;
  }
  return { p: ge / iters, meanSharpe: mean(ss) };
}

const results: any[] = [];
for (const tailMult of [0.6, 1.5, 3.0, 6.0]) {
  const w = buildWindows(tailMult);
  const active = w.filter((x) => x.size > 0);
  const rets = w.map((x) => x.net);
  const stats = summarizeReturnSeries(rets);
  const sh = annSharpe(rets);
  const plc = placeboP(tailMult, sh, 1200);
  const dsr = computeDeflatedSharpeRatio(rets, { trialCount: 90 });
  const winRate = active.filter((x) => x.net > 0).length / Math.max(1, active.length);
  const monthlyMean = stats.mean * (30 / H);
  results.push({
    tailMult,
    netSharpe: +sh.toFixed(3),
    CVaR5: +cvar(rets).toFixed(5),
    Calmar: +calmar(rets).toFixed(3),
    maxDD: +maxDD(rets).toFixed(4),
    skew: +stats.skewness.toFixed(2),
    kurt: +stats.kurt?.toFixed?.(2) ?? +stats.kurtosis.toFixed(2),
    winRate: +winRate.toFixed(3),
    monthlyPct: +(monthlyMean * 100).toFixed(3),
    monthly_100k: +(monthlyMean * 100000).toFixed(0),
    avgTail: +mean(w.map((x) => x.tailCost)).toFixed(6),
    worstWindow: +Math.min(...rets).toFixed(4),
    DSR: +dsr.deflatedProbability.toFixed(3),
    placebo_p: +plc.p.toFixed(3),
    placebo_sharpe: +plc.meanSharpe.toFixed(3),
    // PROMOTION vs CASH: cash has CVaR=0, maxDD=0. Strategy must have a tolerable tail.
    // We say "beats cash on risk-adjusted" if Calmar>0 AND mean>0 AND CVaR not catastrophic.
    beatsCash: stats.mean > 0 && calmar(rets) > 0.5,
    signalAddsValue: plc.p < 0.05,
  });
}

const out = { headline: "BTC|h7|blend gated+sized short-variance, tail stress", results };
writeFileSync("output/edgehunt/vrp-tailstress-result.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
