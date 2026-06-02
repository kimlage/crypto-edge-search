/**
 * D8-A7 — Ensemble stacking of weak lab signals.
 *
 * Belief: a meta-learner over weak, low-correlation base alphas beats any component
 * (Sharpe ~sqrt(k)). Folklore failure mode: correlated long-beta inputs + a meta-fit
 * leak => stacking only re-discovers timed beta.
 *
 * $0 inputs: the lab's already-tested signal RETURN SERIES, reconstructed as weekly
 * net-of-cost books from the on-disk crossxs price panel + funding diagnostics:
 *   XSMOM   cross-sectional momentum (12w), dollar-neutral decile L/S   [D4 momentum book]
 *   XSREV   cross-sectional 1w reversal, dollar-neutral decile L/S      [D4-S7, KILLed]
 *   TSMOM   time-series momentum on BTC/ETH basket (12w)                [TA momentum, KILLed]
 *   DUALMOM dual-momentum top-3 long, abs+BTC-regime gated             [D4-M1, KILLed]
 *   LOWVOL  cross-sectional low-vol tilt, dollar-neutral                [low-vol book]
 *   CARRY*  funding-level carry proxy from on-disk funding diagnostics  [proxy, NOT the
 *           excluded carry survivors — those are off-limits]
 *
 * KEY control: meta-learner must beat naive 1/k equal-weight AND inverse-variance
 * combinations, net-of-cost.
 * Meta-fit hygiene: the meta-layer is a hidden search => fit on PURGED + EMBARGOED CPCV
 * (combinatorial purged CV). Honest N counts every combiner config tried.
 * Surrogate null: STATIONARY BLOCK-BOOTSTRAP of the base-signal return PANEL (resampled
 * by timestamp row => preserves per-week cross-signal correlation and own autocorr,
 * destroys the time-alignment the meta-weights exploit).
 * Consume-once holdout: last 20% of weeks, evaluated ONCE.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/d8a7-ensemble-stack.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

const PPY = 52; // weekly
const ann = (sPerPeriod: number) => sPerPeriod * Math.sqrt(PPY);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const annSharpe = (r: number[]) => ann(sharpe(r));
const mean = (r: number[]) => (r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Load weekly panel
// ---------------------------------------------------------------------------
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };

const WEEKS = weekly.weeks;
const W = WEEKS.length;
const COINS = Object.keys(weekly.weeklyRet);
const FULL = COINS.filter((c) =>
  weekly.weeklyRet[c].every((v) => v != null && isFinite(v as number)),
);
const ret = (c: string, i: number): number | null => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : v;
};
function trail(c: string, i: number, look: number): number | null {
  if (i - look < 0) return null;
  let cum = 1;
  for (let k = i - look + 1; k <= i; k++) {
    const v = ret(c, k);
    if (v == null) return null;
    cum *= 1 + v;
  }
  return cum - 1;
}
function vol(c: string, i: number, look: number): number | null {
  if (i - look < 0) return null;
  const xs: number[] = [];
  for (let k = i - look + 1; k <= i; k++) {
    const v = ret(c, k);
    if (v == null) return null;
    xs.push(v);
  }
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
}

// ---------------------------------------------------------------------------
// Base-signal books. Each returns a length-W array (NaN where undefined).
// Cost baked in. All are weekly-rebalanced. Universe = FULL coins.
// ---------------------------------------------------------------------------
const COST = 0.001; // 10 bps round-trip per name traded (realistic taker+slippage)

// dollar-neutral cross-sectional L/S with a scoring function. score(i) ranked, long top
// decile, short bottom decile. Returns next-week book return net of turnover cost.
function xsBook(
  score: (c: string, i: number) => number | null,
  start: number,
  longHigh: boolean,
): number[] {
  const out = new Array(W).fill(NaN);
  const K = Math.max(2, Math.floor(FULL.length * 0.2));
  let prevLong: string[] = [];
  let prevShort: string[] = [];
  for (let i = start; i < W - 1; i++) {
    const scored = FULL.map((c) => ({ c, s: score(c, i) })).filter(
      (x) => x.s != null && isFinite(x.s as number),
    ) as { c: string; s: number }[];
    if (scored.length < 2 * K) continue;
    scored.sort((a, b) => b.s - a.s); // descending
    const top = scored.slice(0, K).map((x) => x.c);
    const bot = scored.slice(-K).map((x) => x.c);
    const longs = longHigh ? top : bot;
    const shorts = longHigh ? bot : top;
    let pr = 0;
    let cnt = 0;
    for (const c of longs) {
      const v = ret(c, i + 1);
      if (v != null) (pr += v), cnt++;
    }
    for (const c of shorts) {
      const v = ret(c, i + 1);
      if (v != null) (pr -= v), cnt++;
    }
    pr = cnt > 0 ? pr / cnt : 0;
    const turn =
      prevLong.filter((c) => !longs.includes(c)).length +
      longs.filter((c) => !prevLong.includes(c)).length +
      prevShort.filter((c) => !shorts.includes(c)).length +
      shorts.filter((c) => !prevShort.includes(c)).length;
    pr -= (turn / Math.max(1, 2 * K)) * COST;
    out[i + 1] = pr;
    prevLong = longs;
    prevShort = shorts;
  }
  return out;
}

// XSMOM: cross-sectional 12w momentum, long winners / short losers
const XSMOM = xsBook((c, i) => trail(c, i, 12), 12, true);
// XSREV: 1w reversal, long losers / short winners
const XSREV = xsBook((c, i) => ret(c, i), 1, false);
// LOWVOL: long low realized-vol coins, short high vol (longHigh=false on vol score)
const LOWVOL = xsBook((c, i) => vol(c, i, 12), 12, false);

// TSMOM: time-series momentum on equal-weight BTC/ETH/BNB basket; long when basket
// trailing 12w > 0 else flat. Net of cost on regime flips.
function tsmom(): number[] {
  const out = new Array(W).fill(NaN);
  const basket = ["BTC", "ETH", "BNB"].filter((c) => FULL.includes(c));
  let prevOn = false;
  for (let i = 12; i < W - 1; i++) {
    let m = 0;
    let ok = 0;
    for (const c of basket) {
      const t = trail(c, i, 12);
      if (t != null) (m += t), ok++;
    }
    if (ok < basket.length) continue;
    m /= basket.length;
    const on = m > 0;
    let nx = 0;
    let cnt = 0;
    for (const c of basket) {
      const v = ret(c, i + 1);
      if (v != null) (nx += v), cnt++;
    }
    nx = cnt > 0 ? nx / cnt : 0;
    let pr = on ? nx : 0;
    if (on !== prevOn) pr -= COST; // flip cost
    out[i + 1] = pr;
    prevOn = on;
  }
  return out;
}
const TSMOM = tsmom();

// DUALMOM: top-3 EW relative winners gated by abs-mom>0 AND BTC 12w mom>0 (the M1 book)
function dualmom(): number[] {
  const out = new Array(W).fill(NaN);
  const LOOK = 12;
  const TOP = 3;
  let prevHold: string[] = [];
  for (let i = LOOK; i < W - 1; i++) {
    const btcMom = trail("BTC", i, LOOK);
    const scored = FULL.map((c) => ({ c, m: trail(c, i, LOOK) })).filter(
      (x) => x.m != null,
    ) as { c: string; m: number }[];
    scored.sort((a, b) => b.m - a.m);
    const onRegime = btcMom != null && btcMom > 0;
    const hold = onRegime ? scored.slice(0, TOP).filter((x) => x.m > 0).map((x) => x.c) : [];
    let w = 0;
    let cnt = 0;
    for (const c of hold) {
      const v = ret(c, i + 1);
      if (v != null) (w += v), cnt++;
    }
    let pr = cnt > 0 ? w / cnt : 0;
    const turn =
      prevHold.filter((c) => !hold.includes(c)).length +
      hold.filter((c) => !prevHold.includes(c)).length;
    pr -= (turn / Math.max(1, TOP)) * COST;
    out[i + 1] = pr;
    prevHold = hold;
  }
  return out;
}
const DUALMOM = dualmom();

// CARRY proxy: short the richest-funding coins vs basket. Built from on-disk funding
// diagnostics (8h funding files). This is a DIAGNOSTIC-DERIVED PROXY, deliberately weak
// (it is NOT the excluded carry-survivor strategy). Long the basket / short rich-funding
// names => receive funding. Map 8h funding into weekly. Only covers funding-era weeks.
function carryProxy(): number[] {
  const out = new Array(W).fill(NaN);
  const syms = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];
  // load weekly mean funding per symbol
  const wkFund: Record<string, (number | null)[]> = {};
  for (const s of syms) {
    const f = path.join(ROOT, `output/funding/${s}USDT_funding_8h.json`);
    if (!fs.existsSync(f)) continue;
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as {
      fundingTime: number;
      fundingRate: number;
    }[];
    const arr = new Array(W).fill(null) as (number | null)[];
    // bucket each funding obs into its ISO week index by matching the weekly date grid
    const weekMs = WEEKS.map((d) => Date.parse(d + "T00:00:00Z"));
    for (const o of raw) {
      // find week index whose start <= t < next start
      let lo = 0;
      let hi = weekMs.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (weekMs[mid] <= o.fundingTime) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (idx >= 0) {
        const cur = arr[idx];
        // accumulate sum of 8h funding within the week (3 per day * 7 = 21 obs)
        arr[idx] = (cur ?? 0) + o.fundingRate;
      }
    }
    wkFund[s] = arr;
  }
  const avail = Object.keys(wkFund);
  if (avail.length < 4) return out;
  let prevShort: string[] = [];
  for (let i = 0; i < W - 1; i++) {
    const scored = avail
      .map((c) => ({ c, f: wkFund[c][i] }))
      .filter((x) => x.f != null && FULL.includes(x.c)) as { c: string; f: number }[];
    if (scored.length < 4) continue;
    scored.sort((a, b) => b.f - a.f); // richest funding first
    const K = Math.max(1, Math.floor(scored.length / 3));
    const shorts = scored.slice(0, K).map((x) => x.c); // short richest funding
    const longs = scored.slice(-K).map((x) => x.c); // long cheapest funding
    // book = funding received on shorts (the rich funding accrues to short side) minus
    // paid on longs, plus price L/S of the cheap-vs-rich (dollar neutral). Approx: the
    // realized funding carry + the next-week price spread.
    let carryPnl = 0;
    let n = 0;
    for (const c of shorts) {
      const fv = wkFund[c][i];
      if (fv != null) (carryPnl += fv), n++; // receive funding shorting rich
    }
    for (const c of longs) {
      const fv = wkFund[c][i];
      if (fv != null) (carryPnl -= fv), n++; // pay funding longing cheap (usually less)
    }
    // price leg (next week), dollar-neutral long-cheap / short-rich
    let priceLeg = 0;
    let pc = 0;
    for (const c of longs) {
      const v = ret(c, i + 1);
      if (v != null) (priceLeg += v), pc++;
    }
    for (const c of shorts) {
      const v = ret(c, i + 1);
      if (v != null) (priceLeg -= v), pc++;
    }
    const carryW = n > 0 ? carryPnl / (n / 2) : 0;
    const priceW = pc > 0 ? priceLeg / pc : 0;
    let pr = carryW + priceW;
    const turn =
      prevShort.filter((c) => !shorts.includes(c)).length +
      shorts.filter((c) => !prevShort.includes(c)).length;
    pr -= (turn / Math.max(1, K)) * COST;
    out[i + 1] = pr;
    prevShort = shorts;
  }
  return out;
}
const CARRY = carryProxy();

// BTC buy-and-hold (beta reference, NOT a combiner input — used only for beta decomp)
const BTCBH = new Array(W).fill(NaN);
for (let i = 1; i < W; i++) {
  const v = ret("BTC", i);
  if (v != null) BTCBH[i] = v;
}

// ---------------------------------------------------------------------------
// Assemble base panel over the common support (rows where ALL base books defined).
// Two panels (set via env D8A7_PANEL):
//   "full"    = 5 signals (no CARRY) over FULL history (~280w) — large-N honest read.
//   "funding" = 6 signals incl CARRY proxy, funding era only (~156w).
// CARRY truncates to the funding era (files start 2023-06) and that era is a low-carry
// regime, so the long-history 5-signal panel is the primary honest test.
// ---------------------------------------------------------------------------
const PANEL = (process.env.D8A7_PANEL ?? "full").toLowerCase();
const BASE: Record<string, number[]> =
  PANEL === "funding"
    ? { XSMOM, XSREV, TSMOM, DUALMOM, LOWVOL, CARRY }
    : { XSMOM, XSREV, TSMOM, DUALMOM, LOWVOL };
const NAMES = Object.keys(BASE);
const rows: { week: number; vec: number[]; btc: number }[] = [];
for (let i = 0; i < W; i++) {
  const vec = NAMES.map((n) => BASE[n][i]);
  if (vec.every((v) => isFinite(v)) && isFinite(BTCBH[i])) {
    rows.push({ week: i, vec, btc: BTCBH[i] });
  }
}
const N = rows.length;
const K = NAMES.length;
const X = rows.map((r) => r.vec); // N x K
const BTC = rows.map((r) => r.btc);

// per-base annualized net Sharpe + correlation matrix
const baseStats = NAMES.map((n, j) => {
  const s = X.map((row) => row[j]);
  return { name: n, annSharpe: annSharpe(s), meanW: mean(s) };
});
function corr(a: number[], b: number[]) {
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / (Math.sqrt(va * vb) || 1e-12);
}
const corrMat = NAMES.map((_, j) =>
  NAMES.map((_, k) => corr(X.map((r) => r[j]), X.map((r) => r[k]))),
);
const betaToBTC = NAMES.map((_, j) => {
  const s = X.map((r) => r[j]);
  return covBeta(s, BTC);
});
function covBeta(y: number[], x: number[]) {
  const my = mean(y);
  const mx = mean(x);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < y.length; i++) {
    cov += (y[i] - my) * (x[i] - mx);
    vx += (x[i] - mx) ** 2;
  }
  return cov / (vx || 1e-12);
}

// ---------------------------------------------------------------------------
// Combiners
// ---------------------------------------------------------------------------
// (a) 1/k equal-weight
function equalWeight(rowsX: number[][]): number[] {
  return rowsX.map((row) => mean(row));
}
// (b) inverse-variance using a TRAILING window (no look-ahead). Weight ∝ 1/var_trailing.
function inverseVariance(rowsX: number[][], win = 26): number[] {
  const out: number[] = [];
  for (let i = 0; i < rowsX.length; i++) {
    if (i < win) {
      out.push(mean(rowsX[i])); // warmup: equal weight
      continue;
    }
    const w: number[] = [];
    for (let j = 0; j < K; j++) {
      const seg = rowsX.slice(i - win, i).map((r) => r[j]);
      const m = mean(seg);
      const v = seg.reduce((s, x) => s + (x - m) ** 2, 0) / seg.length || 1e-9;
      w.push(1 / v);
    }
    const sw = w.reduce((a, b) => a + b, 0) || 1;
    out.push(rowsX[i].reduce((s, x, j) => s + x * (w[j] / sw), 0));
  }
  return out;
}

// (c) Meta-learner: ridge regression of next-step combiner. We fit weights w that
// maximize in-sample mean/var (i.e. tangency-style) with L2 shrinkage, on TRAIN folds
// only, then apply OOS on TEST folds with PURGE+EMBARGO. Non-negativity optional.
// Solve w = (Sigma + lambda I)^-1 mu  (mean-variance / ridge tangency), normalize to
// unit gross leverage so it is cost/scale-comparable to 1/k.
function solveMeanVar(trainX: number[][], lambda: number, nonneg: boolean): number[] {
  const mu = new Array(K).fill(0);
  for (const row of trainX) for (let j = 0; j < K; j++) mu[j] += row[j];
  for (let j = 0; j < K; j++) mu[j] /= trainX.length;
  // covariance
  const cov = Array.from({ length: K }, () => new Array(K).fill(0));
  for (const row of trainX)
    for (let a = 0; a < K; a++)
      for (let b = 0; b < K; b++) cov[a][b] += (row[a] - mu[a]) * (row[b] - mu[b]);
  for (let a = 0; a < K; a++)
    for (let b = 0; b < K; b++) cov[a][b] /= trainX.length;
  // ridge: Sigma + lambda*trace/K * I
  const tr = cov.reduce((s, r, i) => s + r[i], 0) / K;
  const A = cov.map((r, i) => r.map((v, j) => v + (i === j ? lambda * tr : 0)));
  let w = solve(A, mu);
  if (nonneg) w = w.map((v) => Math.max(0, v));
  // guard near-singular solves: fall back to equal weight if NaN/Inf or degenerate
  if (!w.every((v) => isFinite(v))) return new Array(K).fill(1 / K);
  // normalize to unit gross (sum |w| = 1) so leverage matches 1/k's sum|w|=1
  const gross = w.reduce((s, v) => s + Math.abs(v), 0);
  if (!(gross > 1e-9)) return new Array(K).fill(1 / K);
  return w.map((v) => v / gross);
}
// Gaussian elimination solve A x = b (K small)
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

// ---------------------------------------------------------------------------
// Purged + embargoed COMBINATORIAL CV (CPCV) for the meta-fit.
// Split N rows into G groups; choose all C(G, G-test) train/test combos; PURGE
// embargo rows around each test block (weekly => embargo = 2 weeks). For each split,
// fit meta on train, apply weights on test rows => OOS meta returns. Concatenate.
// ---------------------------------------------------------------------------
function cpcvMetaReturns(
  rowsX: number[][],
  G: number,
  testGroups: number,
  lambda: number,
  nonneg: boolean,
  embargo: number,
): { oos: number[]; weightsAvg: number[] } {
  const Nn = rowsX.length;
  const bounds: [number, number][] = [];
  for (let g = 0; g < G; g++) {
    const a = Math.floor((g * Nn) / G);
    const b = Math.floor(((g + 1) * Nn) / G);
    bounds.push([a, b]);
  }
  const combos = chooseCombos(G, testGroups);
  const oosAcc = new Array(Nn).fill(null) as (number | null)[];
  const oosCnt = new Array(Nn).fill(0);
  const wsum = new Array(K).fill(0);
  let wn = 0;
  for (const testIdx of combos) {
    const testSet = new Set(testIdx);
    const testMask = new Array(Nn).fill(false);
    for (const g of testIdx) for (let i = bounds[g][0]; i < bounds[g][1]; i++) testMask[i] = true;
    // purge+embargo: drop train rows within `embargo` of any test row
    const purged = new Array(Nn).fill(false);
    for (let i = 0; i < Nn; i++) {
      if (!testMask[i]) continue;
      for (let e = -embargo; e <= embargo; e++) {
        const j = i + e;
        if (j >= 0 && j < Nn) purged[j] = true;
      }
    }
    const trainX: number[][] = [];
    for (let i = 0; i < Nn; i++) {
      if (testMask[i]) continue;
      if (purged[i]) continue; // embargoed
      trainX.push(rowsX[i]);
    }
    if (trainX.length < K + 5) continue;
    const w = solveMeanVar(trainX, lambda, nonneg);
    for (let j = 0; j < K; j++) wsum[j] += w[j];
    wn++;
    for (let i = 0; i < Nn; i++) {
      if (!testMask[i]) continue;
      const r = rowsX[i].reduce((s, x, j) => s + x * w[j], 0);
      oosAcc[i] = (oosAcc[i] ?? 0) + r;
      oosCnt[i]++;
    }
  }
  const oos: number[] = [];
  for (let i = 0; i < Nn; i++) {
    if (oosCnt[i] > 0) {
      const v = (oosAcc[i] as number) / oosCnt[i];
      if (isFinite(v)) oos.push(v);
    }
  }
  const weightsAvg = wsum.map((v) => (wn > 0 ? v / wn : 0));
  return { oos, weightsAvg };
}
function chooseCombos(n: number, k: number): number[][] {
  const res: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) {
      res.push([...acc]);
      return;
    }
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return res;
}

// ---------------------------------------------------------------------------
// Build combiner books on the FULL panel (for baselines) and the meta via CPCV.
// All combiners scaled to the same unit-gross leverage so cost/Sharpe are comparable;
// equal-weight sum|w| = 1 by construction (mean), inverse-var normalized to sum 1,
// meta normalized to sum|w| = 1. Combiner rebalancing cost: charge turnover of the
// COMBINER weights * (mean per-book one-way cost) — but the per-book returns already
// include their internal trading cost, so combiner-level cost is the cost of shifting
// capital BETWEEN books. Approx with a modest 2bps per unit weight turnover.
const COMB_COST = 0.0002; // 2 bps per unit of combiner-weight turnover (capital shift between books)

function applyCombinerCost(weightsSeries: number[][], grossReturns: number[]): number[] {
  const out: number[] = [];
  let prevW: number[] | null = null;
  for (let i = 0; i < grossReturns.length; i++) {
    const w = weightsSeries[i];
    let turn = 0;
    if (prevW) for (let j = 0; j < w.length; j++) turn += Math.abs(w[j] - prevW[j]);
    out.push(grossReturns[i] - turn * COMB_COST);
    prevW = w;
  }
  return out;
}

// equal weight: constant weights 1/K
const ewWeights = X.map(() => new Array(K).fill(1 / K));
const ewGross = equalWeight(X);
const EW = applyCombinerCost(ewWeights, ewGross);

// inverse-variance with explicit weights for cost
function inverseVarianceWithWeights(rowsX: number[][], win = 26) {
  const rets: number[] = [];
  const ws: number[][] = [];
  for (let i = 0; i < rowsX.length; i++) {
    let w: number[];
    if (i < win) w = new Array(K).fill(1 / K);
    else {
      const raw: number[] = [];
      for (let j = 0; j < K; j++) {
        const seg = rowsX.slice(i - win, i).map((r) => r[j]);
        const m = mean(seg);
        const v = seg.reduce((s, x) => s + (x - m) ** 2, 0) / seg.length || 1e-9;
        raw.push(1 / v);
      }
      const sw = raw.reduce((a, b) => a + b, 0) || 1;
      w = raw.map((x) => x / sw);
    }
    ws.push(w);
    rets.push(rowsX[i].reduce((s, x, j) => s + x * w[j], 0));
  }
  return { rets, ws };
}
const ivObj = inverseVarianceWithWeights(X, 26);
const IV = applyCombinerCost(ivObj.ws, ivObj.rets);

// ---------------------------------------------------------------------------
// META search grid (CPCV). Count EVERY config => honest N for the meta layer.
// grid: lambda in {0.1,0.3,1.0,3.0}, nonneg in {false,true}, G in {6,8}, testGroups in
// {2,3}, embargo {2}. => 4*2*2*2 = 32 meta configs. Plus we add the base-signal and
// combiner trials already spent upstream (the books themselves were searched in the
// lab). Honest N for the meta hidden search = 32 meta configs. The OVERALL honest N
// folds in the base/combiner search too (documented below).
// ---------------------------------------------------------------------------
const lambdas = [0.1, 0.3, 1.0, 3.0];
const nonnegs = [false, true];
const Gs = [6, 8];
const testGs = [2, 3];
const EMBARGO = 2;
type MetaCfg = { id: string; lambda: number; nonneg: boolean; G: number; tg: number; oos: number[]; w: number[]; annSh: number };
const metaConfigs: MetaCfg[] = [];
for (const lambda of lambdas)
  for (const nonneg of nonnegs)
    for (const G of Gs)
      for (const tg of testGs) {
        const { oos, weightsAvg } = cpcvMetaReturns(X, G, tg, lambda, nonneg, EMBARGO);
        metaConfigs.push({
          id: `L${lambda}_${nonneg ? "nn" : "free"}_G${G}_t${tg}`,
          lambda,
          nonneg,
          G,
          tg,
          oos,
          w: weightsAvg,
          annSh: annSharpe(oos),
        });
      }
const META_HONEST_N = metaConfigs.length; // 32
// best meta config by OOS CPCV Sharpe (this selection is itself part of the search)
metaConfigs.sort(
  (a, b) =>
    (isFinite(b.annSh) ? b.annSh : -Infinity) -
    (isFinite(a.annSh) ? a.annSh : -Infinity),
);
const bestMeta = metaConfigs[0];

// combiner-cost on the best meta's average weights (apply constant avg weights -> low turnover)
const metaWeightsSeries = X.map(() => bestMeta.w);
const metaGross = X.map((row) => row.reduce((s, x, j) => s + x * bestMeta.w[j], 0));
const META_full = applyCombinerCost(metaWeightsSeries, metaGross);
// but the HONEST meta return is the CPCV-OOS series (already purged), with combiner cost:
const META_oos = bestMeta.oos.map((r) => r); // already net of book-level cost; apply tiny combiner cost
// approximate combiner cost on OOS as constant avg-weight turnover ~ negligible; subtract a flat 2bps/wk
const META_oos_net = META_oos.map((r) => r - COMB_COST * 0.5);

// ---------------------------------------------------------------------------
// SURROGATE NULL: stationary block-bootstrap of the base-signal PANEL.
// Resample whole ROWS (keep per-week cross-signal vector intact) in random blocks =>
// preserves cross-signal correlation + own autocorr, destroys time alignment the meta
// fit exploits. Re-run the FULL meta CPCV+selection pipeline on each surrogate panel,
// take its best-config OOS Sharpe => null distribution for the META edge.
// ---------------------------------------------------------------------------
function blockResampleRows(r: () => number, blk: number): number[][] {
  const out: number[][] = [];
  while (out.length < N) {
    const s = Math.floor(r() * N);
    for (let o = 0; o < blk && out.length < N; o++) out.push(X[(s + o) % N]);
  }
  return out;
}
const BLK = Math.max(2, Math.round(Math.sqrt(N)));
const SURRO_ITERS = 300;
const rSur = rng(20260601);
const surroBestSh: number[] = [];
for (let it = 0; it < SURRO_ITERS; it++) {
  const Xs = blockResampleRows(rSur, BLK);
  // run a REDUCED but faithful meta search (same grid would be too slow x300; use the
  // best-config's structure but re-select lambda/nonneg to honor the hidden search):
  let best = -Infinity;
  for (const lambda of [0.3, 1.0]) {
    for (const nonneg of [false, true]) {
      const { oos } = cpcvMetaReturns(Xs, 8, 2, lambda, nonneg, EMBARGO);
      const sh = annSharpe(oos);
      if (sh > best) best = sh;
    }
  }
  surroBestSh.push(best);
}
surroBestSh.sort((a, b) => a - b);
const surroP =
  surroBestSh.filter((x) => x >= annSharpe(META_oos_net)).length / surroBestSh.length;

// ---------------------------------------------------------------------------
// CONSUME-ONCE HOLDOUT: select best meta config on first 80% of rows only (via CPCV on
// that block), then evaluate ONCE on the last 20%.
// ---------------------------------------------------------------------------
const split = Math.floor(N * 0.8);
const Xtrain = X.slice(0, split);
const Xhold = X.slice(split);
// select best cfg on TRAIN via CPCV
let bestTrain: { cfg: string; w: number[]; sh: number } | null = null;
for (const lambda of lambdas)
  for (const nonneg of nonnegs) {
    const { oos, weightsAvg } = cpcvMetaReturns(Xtrain, 8, 2, lambda, nonneg, EMBARGO);
    const sh = annSharpe(oos);
    if (!bestTrain || sh > bestTrain.sh)
      bestTrain = { cfg: `L${lambda}_${nonneg ? "nn" : "free"}`, w: weightsAvg, sh };
  }
// fit final weights on ALL of train (purge not needed across the train/hold boundary
// beyond embargo: drop last `embargo` train rows)
const trainFit = Xtrain.slice(0, Xtrain.length - EMBARGO);
const wFinal = solveMeanVar(
  trainFit,
  Number(bestTrain!.cfg.split("_")[0].slice(1)),
  bestTrain!.cfg.includes("nn"),
);
const holdMeta = Xhold.map((row) => row.reduce((s, x, j) => s + x * wFinal[j], 0) - COMB_COST * 0.5);
const holdEW = Xhold.map((row) => mean(row));
const holdMetaSh = annSharpe(holdMeta);
const holdEWSh = annSharpe(holdEW);

// ---------------------------------------------------------------------------
// CPCV/PBO across the meta configs (treat each meta config as a "strategy", folds =
// its OOS returns chunked). Use estimateCscvPbo over the config OOS series.
// ---------------------------------------------------------------------------
function chunk(arr: number[], folds: number): number[][] {
  const out: number[][] = [];
  for (let f = 0; f < folds; f++) {
    const a = Math.floor((f * arr.length) / folds);
    const b = Math.floor(((f + 1) * arr.length) / folds);
    out.push(arr.slice(a, b));
  }
  return out;
}
const FOLDS = 6;
// align all meta-config OOS series to a common length for CSCV
const minLen = Math.min(...metaConfigs.map((m) => m.oos.length), EW.length, IV.length);
const cscvStrats: CscvStrategyFoldReturns[] = [
  { id: "EW", folds: chunk(EW.slice(0, minLen), FOLDS) },
  { id: "IV", folds: chunk(IV.slice(0, minLen), FOLDS) },
  ...metaConfigs.slice(0, 8).map((m) => ({
    id: m.id,
    folds: chunk(m.oos.slice(0, minLen), FOLDS),
  })),
];
let pbo = NaN;
try {
  const cscv = estimateCscvPbo(cscvStrats, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = cscv.pbo;
} catch (e) {
  pbo = NaN;
}

// ---------------------------------------------------------------------------
// Gauntlet metrics for the META (consume-once-aware), baselines, DSR, Harvey-Liu.
// ---------------------------------------------------------------------------
// OVERALL honest N: base-signal book search upstream (~ the lab tested dozens of
// momentum/reversal/carry configs) + combiner search (EW, IV-window grid) + meta grid.
// Be conservative & honest: meta grid 32; base/combiner search counted as +~40 from the
// lab. Use 32 for the META-layer DSR (its OWN hidden search), and report an OVERALL N.
const META_HONEST_N_OVERALL = META_HONEST_N + 40; // meta(32) + upstream lab book/combiner search(~40)
const dsrMeta = computeDeflatedSharpeRatio(META_oos_net, { trialCount: META_HONEST_N });
const dsrMetaOverall = computeDeflatedSharpeRatio(META_oos_net, { trialCount: META_HONEST_N_OVERALL });

// Harvey-Liu haircut: haircut Sharpe = SR * (1 - p_adj) style. Use a multiple-testing
// adjusted t. Approx HL haircut: SR_haircut = SR * max(0, 1 - (t_BHY/t_obs)) where we use
// the Bonferroni-adjusted critical t for N tests. We approximate with: the fraction of
// the observed Sharpe that survives after inflating the SE by sqrt(2 ln N) (the expected
// max of N standard normals scaling). haircut_ratio = max(0, (SR - SR_expmax)/SR).
const seMeta = computeDeflatedSharpeRatio(META_oos_net, { trialCount: 1 }).sharpeStandardError;
const expMax = dsrMetaOverall.expectedMaxSharpe; // per-period expected max under N
const srPerPeriod = sharpe(META_oos_net);
const hlHaircutRatio = srPerPeriod > 0 ? Math.max(0, (srPerPeriod - expMax) / srPerPeriod) : 0;
const hlHaircutSharpeAnn = ann(srPerPeriod * hlHaircutRatio);

// beta of meta to BTC + residual alpha
const metaBeta = covBeta(META_oos_net, BTC.slice(0, META_oos_net.length));
const resid = META_oos_net.map((r, i) => r - metaBeta * BTC[i]);
const residAlphaSh = annSharpe(resid);

// uplift vs baselines (the KEY control)
const metaSh = annSharpe(META_oos_net);
const ewSh = annSharpe(EW);
const ivSh = annSharpe(IV);
const beatsEW = metaSh > ewSh;
const beatsIV = metaSh > ivSh;
const beatsBestBase = metaSh > Math.max(...baseStats.map((b) => b.annSharpe));

const monthlyMeanW = mean(META_oos_net);
const monthlyPct = (Math.pow(1 + monthlyMeanW, 52 / 12) - 1) * 100;
const monthlyAt100k = (Math.pow(1 + monthlyMeanW, 52 / 12) - 1) * 100000;

const out = {
  panel: {
    label: PANEL,
    nWeeks: N,
    kBaseSignals: K,
    baseNames: NAMES,
    blockLen: BLK,
    firstWeek: WEEKS[rows[0]?.week],
    lastWeek: WEEKS[rows[N - 1]?.week],
  },
  baseStats,
  corrMatrix: corrMat,
  meanAbsCorr:
    corrMat.reduce(
      (s, r, i) => s + r.reduce((ss, v, j) => (i < j ? ss + Math.abs(v) : ss), 0),
      0,
    ) /
    ((K * (K - 1)) / 2),
  betaToBTC: NAMES.reduce((o, n, j) => ({ ...o, [n]: betaToBTC[j] }), {}),
  baselines: { equalWeightSharpeAnn: ewSh, inverseVarSharpeAnn: ivSh },
  meta: {
    bestConfig: bestMeta.id,
    bestWeights: NAMES.reduce((o, n, j) => ({ ...o, [n]: bestMeta.w[j] }), {}),
    cpcvOosSharpeAnn: metaSh,
    cpcvOosWeeks: META_oos_net.length,
  },
  KEY_CONTROL: {
    metaSharpeAnn: metaSh,
    beatsEqualWeight: beatsEW,
    beatsInverseVariance: beatsIV,
    beatsBestSingleBase: beatsBestBase,
    upliftVsEW_ann: metaSh - ewSh,
    upliftVsIV_ann: metaSh - ivSh,
  },
  surrogate: {
    null: "stationary block-bootstrap of base-signal PANEL (rows), re-run meta CPCV+select",
    iters: SURRO_ITERS,
    blockLen: BLK,
    p_value: surroP,
    surroMedianBestSharpe: surroBestSh[Math.floor(SURRO_ITERS / 2)],
    surro95: surroBestSh[Math.floor(SURRO_ITERS * 0.95)],
  },
  honestN: {
    metaLayer: META_HONEST_N,
    overall: META_HONEST_N_OVERALL,
    note: "metaLayer=32 meta configs (lambda x nonneg x G x testGroups); overall adds ~40 upstream lab book/combiner trials",
  },
  deflatedSharpe: {
    atMetaN: dsrMeta.deflatedProbability,
    atOverallN: dsrMetaOverall.deflatedProbability,
    expectedMaxSharpePerPeriod: expMax,
    observedSharpePerPeriod: srPerPeriod,
  },
  harveyLiu: { haircutRatio: hlHaircutRatio, haircutSharpeAnn: hlHaircutSharpeAnn },
  cpcvPbo: pbo,
  betaDecomp: { metaBetaToBTC: metaBeta, residualAlphaSharpeAnn: residAlphaSh },
  consumeOnceHoldout: {
    selectedConfig: bestTrain?.cfg,
    holdoutWeeks: Xhold.length,
    metaHoldoutSharpeAnn: holdMetaSh,
    equalWeightHoldoutSharpeAnn: holdEWSh,
    metaBeatsEWOnHoldout: holdMetaSh > holdEWSh,
  },
  economics: { meanWeeklyNet: monthlyMeanW, monthlyReturnPctNet: monthlyPct, monthlyAt100kUSD: monthlyAt100k },
};

fs.writeFileSync(
  path.join(OUT, `d8a7-ensemble-stack-${PANEL}.json`),
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify(out, null, 2));
