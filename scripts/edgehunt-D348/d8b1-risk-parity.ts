/**
 * edgehunt-D348 / D8-B1 — Risk parity (inverse-vol / ERC) vs cap- and equal-weight.
 *
 * Belief tested: equal-risk-contribution (ERC) / inverse-vol (RP) beats cap- and
 * equal-weight on a risk-adjusted basis.
 *
 * Prior (BACKLOG): KILL (return) / WS (risk). In a one-factor crypto market RP collapses
 * to "underweight volatile alts" (a low-vol beta tilt) + leverage funding cost. Any excess
 * over EW should be the low-vol FACTOR, not RP CONSTRUCTION — a pure risk transform cannot
 * manufacture alpha from a zero-edge book.
 *
 * Strongest honest build here:
 *   - Long-only weekly-rebalanced portfolios: InverseVol, ERC, EqualWeight, CapProxy.
 *   - Rolling covariance window (LOOKBACK weeks), weights formed from PAST data only (no
 *     look-ahead): vol/cov estimated on weeks [i-LOOKBACK, i), applied to week i return.
 *   - Net-of-rebalance-cost: turnover * 28 bps round-trip (committed cost from panel-meta).
 *   - Long-beta control: also report beta-MATCHED RP (levered to EW vol) WITH a leverage/
 *     funding cost, since RP de-risks by underweighting volatile alts.
 *   - KEY control = residualize the (RP - EW) spread vs a LOW-VOL FACTOR (BAB-style,
 *     dollar-neutral long low-vol / short high-vol). If alpha vanishes -> RP adds nothing.
 *
 * Gauntlet: committed primitives from src/lib/training/statistical-validation.ts
 *   summarizeReturnSeries, computeDeflatedSharpeRatio, blockBootstrapConfidenceInterval,
 *   estimateCscvPbo. Plus the RIGHT surrogate null for a vol/covariance item:
 *   block-bootstrap of the covariance window + cross-sectional shuffle of the vol ranking.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/d8b1-risk-parity.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LOOKBACK = 26; // weeks of trailing data to estimate cov / vol
const RT_COST = 0.0028; // 28 bps round-trip (committed cost), charged on turnover
const PERIODS = 52; // weeks/year
const SEED = 20260601;

const ann = (sr: number) => sr * Math.sqrt(PERIODS);

// Mulberry32 deterministic RNG
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

const COINS = Object.keys(weekly.weeklyRet);
const W = weekly.weeks.length;
const ret = (c: string, i: number): number | null => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : v;
};

// A coin is TRADEABLE at week i if it has a full clean LOOKBACK window ending at i.
function tradeable(c: string, i: number): boolean {
  if (i < LOOKBACK) return false;
  for (let k = i - LOOKBACK; k < i; k++) if (ret(c, k) == null) return false;
  return ret(c, i) != null;
}

// ---------------------------------------------------------------------------
// Covariance / vol estimation on trailing window [i-LOOKBACK, i)
// ---------------------------------------------------------------------------
function trailingVol(c: string, i: number): number {
  const xs: number[] = [];
  for (let k = i - LOOKBACK; k < i; k++) {
    const v = ret(c, k);
    if (v != null) xs.push(v);
  }
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1);
  return Math.sqrt(v);
}

function trailingCov(universe: string[], i: number): number[][] {
  const n = universe.length;
  const X: number[][] = universe.map((c) => {
    const xs: number[] = [];
    for (let k = i - LOOKBACK; k < i; k++) xs.push(ret(c, k) as number);
    return xs;
  });
  const means = X.map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  const T = LOOKBACK;
  const C: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (X[a][t] - means[a]) * (X[b][t] - means[b]);
      const cov = s / (T - 1);
      C[a][b] = cov;
      C[b][a] = cov;
    }
  }
  // light shrinkage toward diagonal for numerical stability (Ledoit-style, fixed lambda)
  const lambda = 0.1;
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++)
      if (a !== b) C[a][b] *= 1 - lambda;
  return C;
}

// ---------------------------------------------------------------------------
// Weight schemes (all long-only, sum to 1)
// ---------------------------------------------------------------------------
function wEqual(universe: string[]): number[] {
  const n = universe.length;
  return new Array(n).fill(1 / n);
}

function wInverseVol(universe: string[], i: number): number[] {
  const inv = universe.map((c) => 1 / Math.max(1e-9, trailingVol(c, i)));
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / s);
}

// ERC via the standard cyclical-coordinate / iterative algorithm (Maillard et al. 2010).
// Long-only equal-risk-contribution: find w>0 s.t. w_i*(Cw)_i is equal across i.
function wERC(C: number[][]): number[] {
  const n = C.length;
  let w = new Array(n).fill(1 / n);
  const mul = (v: number[]) => C.map((row) => row.reduce((a, x, j) => a + x * v[j], 0));
  for (let iter = 0; iter < 500; iter++) {
    const Cw = mul(w);
    // target risk contribution = portfolio variance / n
    const sigma2 = w.reduce((a, x, j) => a + x * Cw[j], 0);
    const target = sigma2 / n;
    const wNew = w.slice();
    for (let i = 0; i < n; i++) {
      // solve marginal: w_i * (Cw)_i = target  -> Newton-ish update on diagonal
      const rc = w[i] * Cw[i];
      if (rc > 0) wNew[i] = w[i] * (target / rc) ** 0.5;
    }
    const s = wNew.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) wNew[i] = Math.max(1e-9, wNew[i] / s);
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(wNew[i] - w[i]);
    w = wNew;
    if (diff < 1e-9) break;
  }
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

// Cap-weight PROXY. No coin-level market caps on disk for these alts (only stablecoin
// supply). Honest crude proxy: a static dominance tier reflecting persistent crypto cap
// structure (BTC/ETH dominant, majors next, long tail small). This is documented as a
// PROXY; the decisive control is RP vs EQUAL-WEIGHT, not vs cap.
const CAP_TIER: Record<string, number> = {
  BTC: 50, ETH: 18, BNB: 4, SOL: 4, XRP: 4, ADA: 2, DOGE: 2, TRX: 2, LINK: 1.5,
  AVAX: 1.2, DOT: 1, MATIC: 1, LTC: 1, BCH: 1, XLM: 0.8, ATOM: 0.7, UNI: 0.7,
  ETC: 0.6, NEAR: 0.6, APT: 0.5, ARB: 0.5, OP: 0.5, FIL: 0.4, AAVE: 0.4,
  INJ: 0.4, ALGO: 0.3, EGLD: 0.3, SAND: 0.3, AXS: 0.3, GRT: 0.3,
};
function wCapProxy(universe: string[]): number[] {
  const raw = universe.map((c) => CAP_TIER[c] ?? 0.3);
  const s = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / s);
}

// ---------------------------------------------------------------------------
// Backtest engine: given a per-week weight function, produce net-of-cost returns.
// weightFn(universe, i) -> weights aligned to universe (PAST-only info).
// Returns: { gross, net, betaToEW, weightsHistory, turnoverAvg }
// ---------------------------------------------------------------------------
type WeightFn = (universe: string[], i: number) => number[];

function backtest(weightFn: WeightFn): {
  gross: number[];
  net: number[];
  weeks: number[];
  turnover: number[];
} {
  const gross: number[] = [];
  const net: number[] = [];
  const weeks: number[] = [];
  const turnover: number[] = [];
  let prevW: Map<string, number> = new Map();

  for (let i = LOOKBACK; i < W; i++) {
    const universe = COINS.filter((c) => tradeable(c, i));
    if (universe.length < 5) continue;
    const w = weightFn(universe, i);
    // realize week-i return
    let g = 0;
    for (let j = 0; j < universe.length; j++) g += w[j] * (ret(universe[j], i) as number);
    // turnover vs previous applied weights (coins not in either side count as 0)
    const curW = new Map<string, number>();
    for (let j = 0; j < universe.length; j++) curW.set(universe[j], w[j]);
    const keys = new Set<string>([...curW.keys(), ...prevW.keys()]);
    let to = 0;
    for (const k of keys) to += Math.abs((curW.get(k) ?? 0) - (prevW.get(k) ?? 0));
    to *= 0.5; // one-way turnover (sum of |buys| = sum of |sells|)
    const cost = to * RT_COST;
    gross.push(g);
    net.push(g - cost);
    turnover.push(to);
    weeks.push(i);
    prevW = curW;
  }
  return { gross, net, weeks, turnover };
}

// ---------------------------------------------------------------------------
// Low-vol FACTOR (BAB-style, dollar-neutral): each week, rank tradeable coins by trailing
// vol; long the low-vol half (equal weight), short the high-vol half (equal weight).
// This is the factor we residualize the RP-EW spread against.
// ---------------------------------------------------------------------------
function lowVolFactor(): { ret: number[]; weeks: number[] } {
  const out: number[] = [];
  const wk: number[] = [];
  for (let i = LOOKBACK; i < W; i++) {
    const universe = COINS.filter((c) => tradeable(c, i));
    if (universe.length < 6) continue;
    const ranked = universe
      .map((c) => ({ c, v: trailingVol(c, i) }))
      .sort((a, b) => a.v - b.v);
    const half = Math.floor(ranked.length / 2);
    const low = ranked.slice(0, half);
    const high = ranked.slice(ranked.length - half);
    let r = 0;
    for (const x of low) r += (ret(x.c, i) as number) / low.length;
    for (const x of high) r -= (ret(x.c, i) as number) / high.length;
    out.push(r);
    wk.push(i);
  }
  return { ret: out, weeks: wk };
}

// OLS: regress y on [1, X...] columns. Returns {coef, tstat, resid, r2}.
function ols(y: number[], Xcols: number[][]): {
  coef: number[];
  tstat: number[];
  resid: number[];
  r2: number;
} {
  const n = y.length;
  const k = Xcols.length + 1;
  // design matrix with intercept
  const D: number[][] = [];
  for (let t = 0; t < n; t++) {
    const row = [1];
    for (const col of Xcols) row.push(col[t]);
    D.push(row);
  }
  // normal equations (X'X) b = X'y via Gaussian elimination
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let t = 0; t < n; t++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += D[t][a] * y[t];
      for (let b = 0; b < k; b++) XtX[a][b] += D[t][a] * D[t][b];
    }
  }
  // solve
  const A = XtX.map((r) => r.slice());
  const bv = Xty.slice();
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [bv[col], bv[piv]] = [bv[piv], bv[col]];
    const d = A[col][col] || 1e-12;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col] / d;
      for (let c = 0; c < k; c++) A[r][c] -= f * A[col][c];
      bv[r] -= f * bv[col];
    }
  }
  const coef = bv.map((v, i) => v / (A[i][i] || 1e-12));
  // residuals + se
  const resid: number[] = [];
  let sse = 0;
  let sst = 0;
  const ybar = y.reduce((a, b) => a + b, 0) / n;
  for (let t = 0; t < n; t++) {
    let yhat = 0;
    for (let a = 0; a < k; a++) yhat += coef[a] * D[t][a];
    const e = y[t] - yhat;
    resid.push(e);
    sse += e * e;
    sst += (y[t] - ybar) ** 2;
  }
  const sigma2 = sse / Math.max(1, n - k);
  // (X'X)^-1 diagonal via solving again (use A is reduced; recompute inverse diagonal)
  // recompute (X'X)^-1 properly
  const inv = matInv(XtX);
  const tstat = coef.map((c, i) => c / Math.sqrt(Math.max(1e-18, sigma2 * inv[i][i])));
  return { coef, tstat, resid, r2: 1 - sse / Math.max(1e-18, sst) };
}

function matInv(M: number[][]): number[][] {
  const n = M.length;
  const A = M.map((r, i) => [...r, ...new Array(n).fill(0).map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col] || 1e-12;
    for (let c = 0; c < 2 * n; c++) A[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = 0; c < 2 * n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((r) => r.slice(n));
}

// ---------------------------------------------------------------------------
// RUN: build the four portfolios + low-vol factor, align, compute spreads.
// ---------------------------------------------------------------------------
const bEW = backtest(wEqual);
const bIV = backtest((u, i) => wInverseVol(u, i));
const bERC = backtest((u, i) => wERC(trailingCov(u, i)));
const bCAP = backtest(wCapProxy);
const lvf = lowVolFactor();

// All backtests share the same week index set (start at LOOKBACK, same universe filter).
// Align by week index defensively.
function alignByWeek(
  series: { net: number[]; gross: number[]; weeks: number[] }[],
  extra: { ret: number[]; weeks: number[] }[],
): { idx: number[]; nets: number[][]; grosses: number[][]; extras: number[][] } {
  const maps = series.map((s) => {
    const mNet = new Map<number, number>();
    const mGr = new Map<number, number>();
    s.weeks.forEach((w, j) => {
      mNet.set(w, s.net[j]);
      mGr.set(w, s.gross[j]);
    });
    return { mNet, mGr };
  });
  const emaps = extra.map((e) => {
    const m = new Map<number, number>();
    e.weeks.forEach((w, j) => m.set(w, e.ret[j]));
    return m;
  });
  const common = series[0].weeks.filter(
    (w) =>
      maps.every((m) => m.mNet.has(w)) && emaps.every((m) => m.has(w)),
  );
  const nets = maps.map((m) => common.map((w) => m.mNet.get(w) as number));
  const grosses = maps.map((m) => common.map((w) => m.mGr.get(w) as number));
  const extras = emaps.map((m) => common.map((w) => m.get(w) as number));
  return { idx: common, nets, grosses, extras };
}

const al = alignByWeek([bEW, bIV, bERC, bCAP], [lvf]);
const [ewNet, ivNet, ercNet, capNet] = al.nets;
const [ewGr, ivGr, ercGr, capGr] = al.grosses;
const [lvfR] = al.extras;
const N = al.idx.length;

// beta of a series vs EW (long-beta control)
function betaTo(y: number[], x: number[]): number {
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  let cov = 0;
  let vx = 0;
  for (let t = 0; t < y.length; t++) {
    cov += (y[t] - my) * (x[t] - mx);
    vx += (x[t] - mx) ** 2;
  }
  return cov / vx;
}

function stats(name: string, r: number[]) {
  const s = summarizeReturnSeries(r);
  return {
    name,
    n: s.sampleCount,
    annRet: (Math.pow(1 + s.compoundReturn, PERIODS / s.sampleCount) - 1) * 100,
    annVol: s.stdDev * Math.sqrt(PERIODS) * 100,
    sharpe: s.sharpe,
    annSharpe: ann(s.sharpe),
    beta: betaTo(r, ewNet),
  };
}

const portStats = {
  EqualWeight: stats("EqualWeight", ewNet),
  InverseVol: stats("InverseVol", ivNet),
  ERC: stats("ERC", ercNet),
  CapProxy: stats("CapProxy", capNet),
};

// ---------------------------------------------------------------------------
// SPREADS: the actual test is RP - EW. Use ERC as primary RP (inverse-vol secondary).
// ---------------------------------------------------------------------------
const spreadERC = ercNet.map((v, t) => v - ewNet[t]); // raw RP - EW (net)
const spreadIV = ivNet.map((v, t) => v - ewNet[t]);

// ---- Long-beta / leverage control: beta-MATCHED RP ----
// RP de-risks (beta<1 to EW). Lever ERC so its EX-ANTE vol matches EW, then the alpha is
// the honest add. Charge a leverage/funding cost: levered notional pays perp funding.
// Realistic crypto perp funding ~ +10%/yr long carry => ~0.10/52 per week on (L-1) notional.
const FUNDING_WK = 0.1 / PERIODS;
const ercVol = summarizeReturnSeries(ercNet).stdDev;
const ewVol = summarizeReturnSeries(ewNet).stdDev;
const L = ewVol / Math.max(1e-9, ercVol); // leverage to match EW vol
const ercLevered = ercNet.map((v) => v * L - Math.max(0, L - 1) * FUNDING_WK);
const spreadERCmatched = ercLevered.map((v, t) => v - ewNet[t]);

// ---------------------------------------------------------------------------
// KEY CONTROL: residualize (ERC - EW) spread on the LOW-VOL FACTOR.
// If the spread's alpha (intercept) is ~0 / insignificant after controlling for the
// low-vol factor, then RP manufactures NOTHING beyond the low-vol tilt.
// ---------------------------------------------------------------------------
const regRaw = ols(spreadERC, [lvfR]); // spread ~ 1 + lowVolFactor
const regMatched = ols(spreadERCmatched, [lvfR]);
const regIV = ols(spreadIV, [lvfR]);

// also: raw spread mean t-stat (no control) for contrast
function tOfMean(r: number[]): number {
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return m / (sd / Math.sqrt(r.length));
}

// ---------------------------------------------------------------------------
// SURROGATE NULL (the RIGHT null for a covariance/vol item):
//   (a) block-bootstrap the covariance window AND
//   (b) cross-sectional shuffle of the vol ranking.
// Implementation: re-run the SAME ERC/inverse-vol pipeline but with the per-coin vol/cov
// inputs SHUFFLED across coins each week (destroys the genuine vol-ranking information
// while preserving the marginal distribution of vols and the realized returns). Under the
// null that RP construction adds nothing, the shuffled RP-EW Sharpe should be as large as
// the real one.
// We surrogate the WEIGHTS' information content: assign each coin a vol drawn from a
// block-bootstrap of ITS OWN past window but then PERMUTE the vol->coin assignment.
// ---------------------------------------------------------------------------
function blockResample1D(x: number[], blk: number, r: () => number): number[] {
  const out: number[] = [];
  while (out.length < x.length) {
    const s = Math.floor(r() * x.length);
    for (let o = 0; o < blk && out.length < x.length; o++) out.push(x[(s + o) % x.length]);
  }
  return out;
}

function surrogateSpreadSharpe(r: () => number): number {
  // Inverse-vol with SHUFFLED vol assignment + block-bootstrapped windows.
  const sp: number[] = [];
  let prevW = new Map<string, number>();
  let prevWE = new Map<string, number>();
  for (let i = LOOKBACK; i < W; i++) {
    const universe = COINS.filter((c) => tradeable(c, i));
    if (universe.length < 5) continue;
    // genuine trailing vols
    const vols = universe.map((c) => {
      const xs: number[] = [];
      for (let k = i - LOOKBACK; k < i; k++) xs.push(ret(c, k) as number);
      const bb = blockResample1D(xs, 4, r); // block-bootstrap the cov window
      const m = bb.reduce((a, b) => a + b, 0) / bb.length;
      return Math.sqrt(bb.reduce((a, b) => a + (b - m) ** 2, 0) / (bb.length - 1));
    });
    // cross-sectional shuffle: permute vol->coin assignment (Fisher-Yates)
    const perm = vols.slice();
    for (let a = perm.length - 1; a > 0; a--) {
      const b = Math.floor(r() * (a + 1));
      [perm[a], perm[b]] = [perm[b], perm[a]];
    }
    const inv = perm.map((v) => 1 / Math.max(1e-9, v));
    const s = inv.reduce((a, b) => a + b, 0);
    const w = inv.map((x) => x / s);
    // realized RP return
    let g = 0;
    for (let j = 0; j < universe.length; j++) g += w[j] * (ret(universe[j], i) as number);
    // turnover cost
    const curW = new Map<string, number>();
    universe.forEach((c, j) => curW.set(c, w[j]));
    let to = 0;
    const keys = new Set([...curW.keys(), ...prevW.keys()]);
    for (const k of keys) to += Math.abs((curW.get(k) ?? 0) - (prevW.get(k) ?? 0));
    to *= 0.5;
    const rpNet = g - to * RT_COST;
    prevW = curW;
    // EW realized (same universe) net of its own turnover
    const we = 1 / universe.length;
    let ge = 0;
    for (const c of universe) ge += we * (ret(c, i) as number);
    const curWE = new Map<string, number>();
    universe.forEach((c) => curWE.set(c, we));
    let toe = 0;
    const keyse = new Set([...curWE.keys(), ...prevWE.keys()]);
    for (const k of keyse) toe += Math.abs((curWE.get(k) ?? 0) - (prevWE.get(k) ?? 0));
    toe *= 0.5;
    const ewN = ge - toe * RT_COST;
    prevWE = curWE;
    sp.push(rpNet - ewN);
  }
  return summarizeReturnSeries(sp).sharpe;
}

const NSURRO = 1000;
const r = rng(SEED);
const realIVspreadSharpe = summarizeReturnSeries(spreadIV).sharpe;
const surroSharpes: number[] = [];
for (let s = 0; s < NSURRO; s++) surroSharpes.push(surrogateSpreadSharpe(r));
surroSharpes.sort((a, b) => a - b);
const pSurro =
  surroSharpes.filter((x) => x >= realIVspreadSharpe).length / (NSURRO + 1);

// ---------------------------------------------------------------------------
// Gauntlet on the PRIMARY object (ERC net returns standalone) AND on the SPREAD.
// Honest N = number of distinct configs searched. We tried:
//   2 RP families (inverse-vol, ERC) x {raw, beta-matched} x small LOOKBACK grid we did
//   NOT actually scan (we fixed LOOKBACK=26). Configs genuinely evaluated as "candidates":
//   inverse-vol, ERC, ERC-matched, inverse-vol-matched = 4. Add the implicit lookback
//   choice (we considered 13/26/52 conceptually) -> be honest and count 4 portfolios * 3
//   lookbacks = 12 effective trials for the deflation.
// ---------------------------------------------------------------------------
const HONEST_N = 12;

// Deflated Sharpe on the strongest spread candidate (raw ERC-EW vs IV-EW vs matched).
const candidates = {
  "ERC-EW": spreadERC,
  "IV-EW": spreadIV,
  "ERC-EW-matched": spreadERCmatched,
};
const bestName = Object.entries(candidates).sort(
  (a, b) => summarizeReturnSeries(b[1]).sharpe - summarizeReturnSeries(a[1]).sharpe,
)[0][0];
const bestSpread = candidates[bestName as keyof typeof candidates];

const dsr = computeDeflatedSharpeRatio(bestSpread, { trialCount: HONEST_N });
const bbCI = blockBootstrapConfidenceInterval(bestSpread, {
  statistic: "sharpe",
  iterations: 2000,
  blockLength: 6,
  confidenceLevel: 0.95,
  seed: SEED,
});

// CPCV/PBO: treat the candidate portfolios as competing strategies over folds.
// Split the aligned timeline into folds; score = compoundReturn of the NET spread.
function makeFolds(r: number[], k: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(r.length / k);
  for (let f = 0; f < k; f++) folds.push(r.slice(f * sz, f === k - 1 ? r.length : (f + 1) * sz));
  return folds;
}
const pbo = estimateCscvPbo(
  Object.entries(candidates).map(([id, rr]) => ({ id, folds: makeFolds(rr, 8) })),
  { statistic: "sharpe" },
);

// Harvey-Liu style haircut: multiple-testing haircut on the t-stat of the best spread.
// haircut SR = SR * (1 - haircut). Use Bonferroni-ish: t_adj needs to clear sqrt(2 ln N).
const tBest = tOfMean(bestSpread);
const hlThreshold = Math.sqrt(2 * Math.log(Math.max(2, HONEST_N))); // multiple-testing bar
const tHaircutPass = Math.abs(tBest) > hlThreshold;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const report = {
  config: { LOOKBACK, RT_COST, PERIODS, N, HONEST_N, surrogateIters: NSURRO },
  universeNote:
    "Survivorship-biased (coins liquid TODAY); results are an UPPER BOUND. Cap-weight is a crude static-tier PROXY (no coin caps on disk).",
  portfolios: portStats,
  leverage: { ercVol_wk: ercVol, ewVol_wk: ewVol, leverageToMatchEW: L, fundingWk: FUNDING_WK },
  spreads: {
    "ERC-EW_raw": {
      annSharpe: ann(summarizeReturnSeries(spreadERC).sharpe),
      meanWk: spreadERC.reduce((a, b) => a + b, 0) / N,
      tMean: tOfMean(spreadERC),
    },
    "IV-EW_raw": {
      annSharpe: ann(summarizeReturnSeries(spreadIV).sharpe),
      meanWk: spreadIV.reduce((a, b) => a + b, 0) / N,
      tMean: tOfMean(spreadIV),
    },
    "ERC-EW_betaMatched": {
      annSharpe: ann(summarizeReturnSeries(spreadERCmatched).sharpe),
      meanWk: spreadERCmatched.reduce((a, b) => a + b, 0) / N,
      tMean: tOfMean(spreadERCmatched),
    },
  },
  KEY_CONTROL_residualize_vs_lowVolFactor: {
    note: "spread ~ 1 + lowVolFactor. Intercept = RP alpha AFTER removing the low-vol tilt.",
    lowVolFactor_annSharpe: ann(summarizeReturnSeries(lvfR).sharpe),
    "ERC-EW": {
      alpha_wk: regRaw.coef[0],
      alpha_t: regRaw.tstat[0],
      lowVolBeta: regRaw.coef[1],
      lowVolBeta_t: regRaw.tstat[1],
      r2: regRaw.r2,
    },
    "ERC-EW_betaMatched": {
      alpha_wk: regMatched.coef[0],
      alpha_t: regMatched.tstat[0],
      lowVolBeta: regMatched.coef[1],
      lowVolBeta_t: regMatched.tstat[1],
      r2: regMatched.r2,
    },
    "IV-EW": {
      alpha_wk: regIV.coef[0],
      alpha_t: regIV.tstat[0],
      lowVolBeta: regIV.coef[1],
      lowVolBeta_t: regIV.tstat[1],
      r2: regIV.r2,
    },
  },
  surrogate: {
    null: "block-bootstrap cov window + cross-sectional shuffle of vol->coin assignment",
    realObject: "IV-EW net spread Sharpe",
    realSharpe_wk: realIVspreadSharpe,
    surroMean: surroSharpes.reduce((a, b) => a + b, 0) / NSURRO,
    surroP95: surroSharpes[Math.floor(0.95 * NSURRO)],
    p: pSurro,
  },
  gauntlet: {
    bestSpreadCandidate: bestName,
    bestSpread_annSharpe: ann(summarizeReturnSeries(bestSpread).sharpe),
    deflatedSharpe: {
      sharpe_wk: dsr.sharpe,
      expectedMaxSharpe_wk: dsr.expectedMaxSharpe,
      deflatedProbability: dsr.deflatedProbability,
      trialCount: dsr.trialCount,
    },
    blockBootstrapSharpeCI_wk: { lower: bbCI.lower, est: bbCI.estimate, upper: bbCI.upper },
    pbo: { pbo: pbo.pbo, medianLogit: pbo.medianLogit },
    harveyLiu: { tBest, threshold: hlThreshold, pass: tHaircutPass },
  },
};

fs.writeFileSync(
  path.join(OUT, "d8b1-risk-parity.json"),
  JSON.stringify(report, null, 2),
);

// console summary
console.log("=== D8-B1 Risk Parity (inverse-vol / ERC) ===");
console.log(`N weeks=${N}  LOOKBACK=${LOOKBACK}  cost=${RT_COST * 1e4}bps RT  honestN=${HONEST_N}`);
console.log("\n-- Portfolio standalone (net of cost) --");
for (const p of Object.values(portStats)) {
  console.log(
    `${p.name.padEnd(12)} annRet=${p.annRet.toFixed(1)}%  annVol=${p.annVol.toFixed(1)}%  annSharpe=${p.annSharpe.toFixed(3)}  betaToEW=${p.beta.toFixed(3)}`,
  );
}
console.log("\n-- RP - EW spreads (net) --");
console.log(
  `ERC-EW raw       annSharpe=${ann(summarizeReturnSeries(spreadERC).sharpe).toFixed(3)}  tMean=${tOfMean(spreadERC).toFixed(2)}`,
);
console.log(
  `IV-EW  raw       annSharpe=${ann(summarizeReturnSeries(spreadIV).sharpe).toFixed(3)}  tMean=${tOfMean(spreadIV).toFixed(2)}`,
);
console.log(
  `ERC-EW betaMatch annSharpe=${ann(summarizeReturnSeries(spreadERCmatched).sharpe).toFixed(3)}  tMean=${tOfMean(spreadERCmatched).toFixed(2)}  (L=${L.toFixed(2)})`,
);
console.log("\n-- KEY CONTROL: residualize spread vs low-vol factor --");
console.log(`lowVolFactor annSharpe=${ann(summarizeReturnSeries(lvfR).sharpe).toFixed(3)}`);
console.log(
  `ERC-EW   alpha_wk=${regRaw.coef[0].toExponential(2)}  alpha_t=${regRaw.tstat[0].toFixed(2)}  lowVolBeta=${regRaw.coef[1].toFixed(3)} (t=${regRaw.tstat[1].toFixed(2)})  R2=${regRaw.r2.toFixed(2)}`,
);
console.log(
  `ERC-EWm  alpha_wk=${regMatched.coef[0].toExponential(2)}  alpha_t=${regMatched.tstat[0].toFixed(2)}  lowVolBeta=${regMatched.coef[1].toFixed(3)} (t=${regMatched.tstat[1].toFixed(2)})  R2=${regMatched.r2.toFixed(2)}`,
);
console.log(
  `IV-EW    alpha_wk=${regIV.coef[0].toExponential(2)}  alpha_t=${regIV.tstat[0].toFixed(2)}  lowVolBeta=${regIV.coef[1].toFixed(3)} (t=${regIV.tstat[1].toFixed(2)})  R2=${regIV.r2.toFixed(2)}`,
);
console.log("\n-- Surrogate null (block-boot cov + XS vol shuffle) --");
console.log(
  `real IV-EW Sharpe_wk=${realIVspreadSharpe.toFixed(4)}  surroMean=${(surroSharpes.reduce((a, b) => a + b, 0) / NSURRO).toFixed(4)}  surroP95=${surroSharpes[Math.floor(0.95 * NSURRO)].toFixed(4)}  p=${pSurro.toFixed(3)}`,
);
console.log("\n-- Gauntlet --");
console.log(`best spread candidate: ${bestName}  annSharpe=${ann(summarizeReturnSeries(bestSpread).sharpe).toFixed(3)}`);
console.log(
  `DeflatedSharpe: SR_wk=${dsr.sharpe.toFixed(4)}  E[maxSR]=${dsr.expectedMaxSharpe.toFixed(4)}  deflatedProb=${dsr.deflatedProbability.toFixed(3)} (N=${dsr.trialCount})`,
);
console.log(`block-boot Sharpe CI_wk: [${bbCI.lower.toFixed(4)}, ${bbCI.upper.toFixed(4)}]  est=${bbCI.estimate.toFixed(4)}`);
console.log(`PBO=${pbo.pbo.toFixed(3)}  medianLogit=${pbo.medianLogit.toFixed(3)}`);
console.log(`Harvey-Liu: tBest=${tBest.toFixed(2)}  bar=${hlThreshold.toFixed(2)}  pass=${tHaircutPass}`);
console.log(`\nwrote ${path.join(OUT, "d8b1-risk-parity.json")}`);
