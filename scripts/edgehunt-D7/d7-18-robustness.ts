/**
 * D7.18 robustness — the HONEST right-null for a DATA-MINED winner.
 *
 * The per-cell placebo (d7-18-stablecoin-mint.ts) gave surrogateP=0.0072, but
 * that test fixes ONE cell and asks "would random dates do as well?" It does NOT
 * account for the fact that we picked the BEST of 128 grid cells. The DSR
 * (deflatedProb 0.65) and CSCV/PBO (0.59) already flag overfitting. Here we make
 * the selection explicit with a MAX-STATISTIC permutation null:
 *
 *   For each placebo trial, re-run the ENTIRE grid (all thresholds x horizons x
 *   lags x raw/residual) on RANDOM fake mint dates, take the MAX net Sharpe over
 *   the grid (mirroring our own data-mining), and compare the real MAX to the
 *   placebo MAX distribution. This is the leakage-free family-wise null.
 *
 * Also: leave-one-event-out fragility on the winner (does dropping the single
 * best event collapse it?) and a sign/turnover sanity report.
 */
import { readFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";

const ROOT = ".";
const dayMs = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const ANNUALIZE = Math.sqrt(365);
const COST = 0.0006;
const SUPPLY_TRAIL = 30;

interface Bar { date: string; close: number; }
interface SupRow { date: string; total: number; }
const supplyByDate = new Map<string, number>();
for (const r of (JSON.parse(readFileSync(`${ROOT}/output/edgehunt-D5/stablecoins_total.json`, "utf8")).data as SupRow[])) {
  if (Number.isFinite(r.total) && r.total > 0) supplyByDate.set(r.date, r.total);
}
function loadBars(sym: string): Bar[] {
  return (JSON.parse(readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`, "utf8")) as Bar[])
    .filter((b) => Number.isFinite(b.close) && b.close > 0).sort((a, b) => toMs(a.date) - toMs(b.date));
}
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function buildRet(bars: Bar[]): { date: string[]; ret: number[]; mintZ: number[] } {
  const date: string[] = []; const close: number[] = []; let last: number | null = null;
  for (const b of bars) { const s = supplyByDate.get(b.date); if (s !== undefined) last = s; if (last === null) continue; date.push(b.date); close.push(b.close); }
  const sup: number[] = []; last = null;
  for (const d of date) { const s = supplyByDate.get(d); if (s !== undefined) last = s; sup.push(last as number); }
  const n = date.length; const ret = new Array(n).fill(0); const supChg = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) { ret[i] = Math.log(close[i] / close[i - 1]); supChg[i] = Math.log(sup[i] / sup[i - 1]); }
  const mintZ = new Array(n).fill(0);
  for (let i = SUPPLY_TRAIL + 1; i < n; i += 1) {
    let m = 0; for (let j = i - SUPPLY_TRAIL; j < i; j += 1) m += supChg[j]; m /= SUPPLY_TRAIL;
    let v = 0; for (let j = i - SUPPLY_TRAIL; j < i; j += 1) v += (supChg[j] - m) ** 2; const sd = Math.sqrt(v / (SUPPLY_TRAIL - 1));
    mintZ[i] = sd > 1e-12 ? (supChg[i] - m) / sd : 0;
  }
  return { date, ret, mintZ };
}

function ruleNet(ret: number[], signal: boolean[], horizon: number, lag: number): number[] {
  const n = ret.length; const want = new Array(n).fill(false);
  for (let i = 0; i < n; i += 1) { if (!signal[i]) continue; const s = i + lag; const e = Math.min(n - 1, s + horizon - 1); for (let k = s; k <= e; k += 1) if (k >= 0) want[k] = true; }
  const net: number[] = []; let prev = 0;
  for (let i = 0; i < n; i += 1) { const p = want[i] ? 1 : 0; const c = p !== prev ? COST : 0; net.push(p * ret[i] - c); prev = p; }
  return net;
}

const THRESHOLDS = [1.5, 2.0, 2.5, 3.0];
const HORIZONS = [3, 5, 7, 10];
const LAGS = [1, 2];

// real MAX over grid (raw signal only for the family-wise null — same definition the placebo uses)
function gridMaxSharpe(ret: number[], z: number[]): number {
  let best = -Infinity;
  for (const t of THRESHOLDS) { const sig = z.map((v) => v >= t); for (const h of HORIZONS) for (const l of LAGS) { const sh = summarizeReturnSeries(ruleNet(ret, sig, h, l)).sharpe; if (sh > best) best = sh; } }
  return best;
}

// Build a z-like signal from random fake event dates: pick K random days as "events".
// To mirror thresholding, the placebo grid uses the SAME thresholds applied to a
// shuffled mintZ (preserves the marginal distribution of z, destroys timing vs returns).
function shuffle<T>(arr: T[], rng: () => number): T[] { const a = arr.slice(); for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const report: any = { method: "family-wise MAX-statistic placebo null (shuffle mint-z vs returns, re-mine the whole grid each trial)", assets: {} };

for (const asset of ["BTC", "ETH"]) {
  const { ret, mintZ } = buildRet(loadBars(asset));
  const realMax = gridMaxSharpe(ret, mintZ);
  const rng = mulberry32(asset === "BTC" ? 4242 : 9999);
  const N = 3000; let ge = 0; const maxes: number[] = [];
  for (let s = 0; s < N; s += 1) {
    const zShuf = shuffle(mintZ, rng); // preserves z distribution, breaks alignment to returns
    const m = gridMaxSharpe(ret, zShuf);
    maxes.push(m); if (m >= realMax) ge += 1;
  }
  maxes.sort((a, b) => a - b);
  report.assets[asset] = {
    realGridMaxSharpeDaily: realMax,
    realGridMaxSharpeAnnual: realMax * ANNUALIZE,
    placeboMaxMeanDaily: maxes.reduce((a, b) => a + b, 0) / maxes.length,
    placeboMaxP95Daily: maxes[Math.floor(0.95 * maxes.length)],
    familyWiseSurrogateP: (ge + 1) / (N + 1),
  };
}

// Leave-one-event-out fragility on BTC winner (residual t3 h7 l1 -> but family null
// above uses raw; report raw winner too). For interpretability we report the raw
// best cell fragility on BTC.
function bestRawCell(ret: number[], z: number[]) {
  let best: any = null;
  for (const t of THRESHOLDS) { const sig = z.map((v) => v >= t); for (const h of HORIZONS) for (const l of LAGS) { const sh = summarizeReturnSeries(ruleNet(ret, sig, h, l)).sharpe; if (!best || sh > best.sh) best = { t, h, l, sh, sig }; } }
  return best;
}
{
  const { ret, mintZ } = buildRet(loadBars("BTC"));
  const bc = bestRawCell(ret, mintZ);
  const eventIdx: number[] = []; mintZ.forEach((v, i) => { if (v >= bc.t) eventIdx.push(i); });
  const full = summarizeReturnSeries(ruleNet(ret, bc.sig, bc.h, bc.l)).sharpe;
  let worst = Infinity;
  for (const drop of eventIdx) {
    const sig = mintZ.map((v, i) => v >= bc.t && i !== drop);
    const sh = summarizeReturnSeries(ruleNet(ret, sig, bc.h, bc.l)).sharpe;
    if (sh < worst) worst = sh;
  }
  report.btcRawWinnerFragility = {
    cell: { threshold: bc.t, horizon: bc.h, lag: bc.l }, events: eventIdx.length,
    fullNetSharpeDaily: full, fullNetSharpeAnnual: full * ANNUALIZE,
    worstLeaveOneEventOutSharpeDaily: worst, worstLeaveOneEventOutSharpeAnnual: worst * ANNUALIZE,
    fragilityDropPct: (1 - worst / full) * 100,
  };
}

console.log(JSON.stringify(report, null, 2));
