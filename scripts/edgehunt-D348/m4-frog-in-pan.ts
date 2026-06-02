/**
 * D4-M4  Frog-in-the-pan / information discreteness (ID).
 *
 * Thesis (Da-Gurun-Warachka 2014): momentum is stronger when the cumulative
 * return arrived via MANY SMALL same-sign moves (continuous info, low ID →
 * limited-attention under-reaction) and weaker when it arrived via FEW LARGE
 * jumps (discrete info, high ID → attention-grabbing → priced fast).
 *
 *   ID = sign(formation cumulative return) * (%neg_days - %pos_days)
 *        over the formation window.   Low ID = "continuous" mover.
 *
 * Strongest honest build:
 *   - daily-closes.json (real Binance, $0). ID = sign-of-daily-moves count.
 *   - DOUBLE-SORT momentum x ID: among momentum winners, hold the LOW-ID
 *     (continuous) ones; FIP spread = low-ID winners minus high-ID winners.
 *   - KEY CONTROL: identical double-sort momentum x VOLATILITY (realized daily
 *     vol over formation). ID proxies inverse-vol; if the vol double-sort
 *     reproduces the lift, ID adds nothing incremental.
 *   - BTC-beta decomposition (M1 lesson: crypto momentum's edge is timed beta).
 *   - consume-once holdout (config picked on first 80%, scored on last 20%).
 *
 * Nulls:
 *   - ID-LABEL PLACEBO: shuffle the ID labels ACROSS assets each rebalance
 *     (momentum panel untouched; only which asset is "low-ID" is randomized).
 *     If real low-ID selection beats random ID assignment, ID carries signal.
 *   - CROSS-SECTIONAL SHUFFLE: permute the momentum->asset mapping (kills the
 *     momentum ranking itself).
 *
 * Prior KILL: ID is a vol proxy; once momentum is timed beta and vol is
 * partialled out, ID conditioning has no incremental signal. Survives ONLY if
 * the ID-placebo specifically breaks it (real >> placebo) AND the vol control
 * does NOT reproduce the lift AND residual alpha survives.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/m4-frog-in-pan.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };

const DATES = daily.dates;
const D = DATES.length;
const COINS = Object.keys(daily.closes);

const ann = (s: number) => s * Math.sqrt(52); // weekly rebalance → annualize
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;

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
function shuffleInPlace<T>(arr: T[], r: () => number) {
  for (let j = arr.length - 1; j > 0; j--) {
    const k = Math.floor(r() * (j + 1));
    [arr[j], arr[k]] = [arr[k], arr[j]];
  }
}

// ---------------------------------------------------------------------------
// Weekly rebalance grid built from DAILY closes (every 7 calendar days).
// Per coin we precompute, at each rebalance index, the formation features:
//   PRET  = cumulative formation return (momentum)
//   ID    = sign(PRET) * (%neg - %pos) over formation daily moves
//   VOL   = realized daily vol over formation (the inverse-proxy control)
// and the realized FORWARD weekly return (next 7 days).
// ---------------------------------------------------------------------------
const STEP = 7; // rebalance every 7 days
// rebalance indices into DATES (decision made at close of date REB[i])
const REB: number[] = [];
for (let i = 0; i < D; i += STEP) REB.push(i);
const R = REB.length;

// log/simple daily returns per coin (null-safe)
function dailyRet(c: string, t0: number, t1: number): number | null {
  const cl = daily.closes[c];
  const a = cl[t0];
  const b = cl[t1];
  if (a == null || b == null || !(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

interface Feat {
  pret: number; // formation cumulative return
  id: number; // information discreteness
  vol: number; // realized daily vol over formation
}

// build features for coin c at rebalance index ri using FORM daily bars back
function buildFeat(c: string, dateIdx: number, FORM: number): Feat | null {
  if (dateIdx - FORM < 0) return null;
  const cl = daily.closes[c];
  // require full coverage over the formation + that the start price exists
  let cum = 1;
  let nPos = 0;
  let nNeg = 0;
  let n = 0;
  const rets: number[] = [];
  for (let t = dateIdx - FORM + 1; t <= dateIdx; t++) {
    const r = dailyRet(c, t - 1, t);
    if (r == null) return null;
    cum *= 1 + r;
    if (r > 0) nPos++;
    else if (r < 0) nNeg++;
    rets.push(r);
    n++;
  }
  if (n < FORM * 0.95) return null;
  const pret = cum - 1;
  const fracNeg = nNeg / n;
  const fracPos = nPos / n;
  const id = Math.sign(pret) * (fracNeg - fracPos); // low ID = continuous
  const mu = rets.reduce((a, b) => a + b, 0) / n;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / n);
  return { pret, id, vol };
}

// forward weekly return (date REB[ri] close -> REB[ri+1] close), null-safe
function fwd(c: string, ri: number): number | null {
  if (ri + 1 >= R) return null;
  return dailyRet(c, REB[ri], REB[ri + 1]);
}

// ---------------------------------------------------------------------------
// Core: cross-sectional double-sort.
//   Each rebalance: among coins with valid features, take the momentum WINNERS
//   (top `topFrac`). Within winners, split by conditioning variable (ID or VOL)
//   into LOW vs HIGH. Long the LOW-conditioner winners (continuous / low-vol),
//   EW. The "spread" leg additionally shorts the HIGH-conditioner winners.
// mode:
//   'mom'        plain momentum winners (no conditioning) — baseline
//   'lowID'      momentum winners with LOW id (frog-in-pan long-only)
//   'fipSpread'  low-ID winners minus high-ID winners (the incremental ID bet)
//   'lowVol'     CONTROL: momentum winners with LOW vol
//   'volSpread'  CONTROL: low-vol winners minus high-vol winners
// conditioner permutation hooks:
//   idPlacebo: shuffle the id labels across assets (ID-label placebo null)
//   momShuffle: shuffle the momentum->asset mapping (cross-sectional shuffle null)
// ---------------------------------------------------------------------------
type Mode = "mom" | "lowID" | "fipSpread" | "lowVol" | "volSpread";

function runStrategy(
  FORM: number,
  topFrac: number,
  splitFrac: number,
  mode: Mode,
  opts: {
    iStart?: number;
    iEnd?: number;
    idPlacebo?: () => number;
    momShuffle?: () => number;
    cost?: number;
  } = {},
): { port: number[]; btc: number[] } {
  const cost = opts.cost ?? 0.001; // 10 bps rt per name rotated
  const iStart = opts.iStart ?? 0;
  const iEnd = opts.iEnd ?? R - 1;
  const port: number[] = [];
  const btc: number[] = [];
  let prevHold: string[] = [];
  for (let ri = iStart; ri < iEnd; ri++) {
    const dateIdx = REB[ri];
    const rows: { c: string; f: Feat; fr: number }[] = [];
    for (const c of COINS) {
      const f = buildFeat(c, dateIdx, FORM);
      if (!f) continue;
      const fr = fwd(c, ri);
      if (fr == null) continue;
      rows.push({ c, f, fr });
    }
    if (rows.length < 8) {
      port.push(0);
      btc.push(fwd("BTC", ri) ?? 0);
      continue;
    }
    // momentum scores (optionally cross-sectionally shuffled)
    let momScores = rows.map((r) => r.f.pret);
    if (opts.momShuffle) {
      momScores = momScores.slice();
      shuffleInPlace(momScores, opts.momShuffle);
    }
    // ID labels (optionally placebo-shuffled across assets)
    let idScores = rows.map((r) => r.f.id);
    if (opts.idPlacebo) {
      idScores = idScores.slice();
      shuffleInPlace(idScores, opts.idPlacebo);
    }
    const volScores = rows.map((r) => r.f.vol);

    const idx = rows.map((_, i) => i);
    // rank by momentum desc → winners
    idx.sort((a, b) => momScores[b] - momScores[a]);
    const nWin = Math.max(2, Math.round(rows.length * topFrac));
    const winners = idx.slice(0, nWin);
    // require positive abs momentum to be "winners" (frog-in-pan is a momentum bet)
    const posWinners = winners.filter((i) => momScores[i] > 0);
    const useWin = posWinners.length >= 2 ? posWinners : winners;

    // conditioning within winners
    const condOf = (i: number) =>
      mode === "lowVol" || mode === "volSpread" ? volScores[i] : idScores[i];
    const sortedWin = useWin.slice().sort((a, b) => condOf(a) - condOf(b)); // asc
    const nSplit = Math.max(1, Math.round(sortedWin.length * splitFrac));
    const low = sortedWin.slice(0, nSplit); // low ID / low vol = continuous
    const high = sortedWin.slice(-nSplit); // high ID / high vol

    let longSet: number[] = [];
    let shortSet: number[] = [];
    if (mode === "mom") longSet = useWin;
    else if (mode === "lowID" || mode === "lowVol") longSet = low;
    else if (mode === "fipSpread" || mode === "volSpread") {
      longSet = low;
      shortSet = high;
    }

    const longCoins = longSet.map((i) => rows[i].c);
    const shortCoins = shortSet.map((i) => rows[i].c);
    let pr = 0;
    let nl = 0;
    for (const i of longSet) {
      pr += rows[i].fr;
      nl++;
    }
    let ps = 0;
    let ns = 0;
    for (const i of shortSet) {
      ps += rows[i].fr;
      ns++;
    }
    let r = (nl > 0 ? pr / nl : 0) - (ns > 0 ? ps / ns : 0);

    // turnover cost on the long book (dominant). Track names held.
    const hold = longCoins.concat(shortCoins);
    const turn =
      prevHold.filter((c) => !hold.includes(c)).length +
      hold.filter((c) => !prevHold.includes(c)).length;
    r -= (turn / Math.max(1, hold.length)) * cost;
    prevHold = hold;

    port.push(r);
    btc.push(fwd("BTC", ri) ?? 0);
  }
  return { port, btc };
}

function regress(y: number[], x: number[]) {
  const n = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const beta = vx > 0 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - (alpha + beta * x[i]));
  // alpha Sharpe = intercept relative to residual vol (NOT mean(resid)/sd which
  // is mechanically ~0 because OLS forces mean(resid)=0). This is the correct
  // "edge after partialling out the benchmark" magnitude.
  const residStd =
    Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / resid.length) || 1e-12;
  const alphaSharpePerPeriod = alpha / residStd;
  return { alpha, beta, resid, alphaSharpePerPeriod };
}

// ===========================================================================
// Honest-N config grid. The hidden search: formation window, winner frac,
// split frac, and the mode family (long-only vs spread).
// ===========================================================================
const forms = [28, 56, 84, 168]; // ~1,2,3,6 months in daily bars
const topFracs = [0.3, 0.5];
const splitFracs = [0.3, 0.5];
type Cfg = { id: string; form: number; top: number; split: number };
const cfgs: Cfg[] = [];
for (const f of forms)
  for (const t of topFracs)
    for (const s of splitFracs)
      cfgs.push({ id: `F${f}_W${t}_S${s}`, form: f, top: t, split: s });
// Honest N counts EVERY config tried across the mode families that we report.
// We evaluate fipSpread (the headline ID bet) + lowID long-only as the two
// candidate families on this grid → multiply.
const FAMILIES_TESTED = 2; // {fipSpread, lowID} — the ID-conditioning candidates
const honestN = cfgs.length * FAMILIES_TESTED;

// Score the headline mode (fipSpread) on full sample to find the best config.
const scoredFip = cfgs.map((c) => {
  const full = runStrategy(c.form, c.top, c.split, "fipSpread");
  return { ...c, sh: ann(sharpe(full.port)), port: full.port, btc: full.btc };
});
scoredFip.sort((a, b) => b.sh - a.sh);
const bestFip = scoredFip[0];

// Same grid, long-only low-ID family (alternative candidate).
const scoredLowID = cfgs.map((c) => {
  const full = runStrategy(c.form, c.top, c.split, "lowID");
  return { ...c, sh: ann(sharpe(full.port)), port: full.port };
});
scoredLowID.sort((a, b) => b.sh - a.sh);
const bestLowID = scoredLowID[0];

// ---------------------------------------------------------------------------
// The INCREMENTAL test at the best fipSpread config:
//   1) fipSpread Sharpe (low-ID minus high-ID winners)
//   2) plain momentum winners Sharpe (baseline the ID bet must beat)
//   3) VOL control: volSpread on the SAME config (does inverse-vol reproduce it?)
//   4) BTC-beta decomposition of fipSpread → residual alpha Sharpe
// ---------------------------------------------------------------------------
const B = bestFip;
const fip = runStrategy(B.form, B.top, B.split, "fipSpread");
const momBaseline = runStrategy(B.form, B.top, B.split, "mom");
const lowIDlong = runStrategy(B.form, B.top, B.split, "lowID");
const volSpread = runStrategy(B.form, B.top, B.split, "volSpread");
const lowVollong = runStrategy(B.form, B.top, B.split, "lowVol");

const fipSh = ann(sharpe(fip.port));
const momSh = ann(sharpe(momBaseline.port));
const lowIDsh = ann(sharpe(lowIDlong.port));
const volSpreadSh = ann(sharpe(volSpread.port));
const lowVolSh = ann(sharpe(lowVollong.port));

const reg = regress(fip.port, fip.btc);
const residSharpe = ann(reg.alphaSharpePerPeriod); // alpha-only Sharpe (intercept / resid vol)
const alphaAnnPct = reg.alpha * 52 * 100;

// also residualize the long-only low-ID leg vs BTC (its headline is more beta-laden)
const regLow = regress(lowIDlong.port, lowIDlong.btc);
const residLowSh = ann(regLow.alphaSharpePerPeriod);

// CRITICAL incremental test: does fipSpread add alpha OVER the plain-momentum
// baseline? Regress fipSpread on BOTH BTC and the momentum baseline; the
// intercept's t-stat is the incremental ID edge after momentum is controlled.
function regress2(y: number[], x1: number[], x2: number[]) {
  // OLS with intercept on two regressors (normal equations, 3x3 solve).
  const n = y.length;
  let s1 = 0, s2 = 0, sy = 0, s11 = 0, s22 = 0, s12 = 0, s1y = 0, s2y = 0;
  for (let i = 0; i < n; i++) {
    s1 += x1[i]; s2 += x2[i]; sy += y[i];
    s11 += x1[i] * x1[i]; s22 += x2[i] * x2[i]; s12 += x1[i] * x2[i];
    s1y += x1[i] * y[i]; s2y += x2[i] * y[i];
  }
  // Augmented system [n s1 s2; s1 s11 s12; s2 s12 s22] [a;b1;b2] = [sy;s1y;s2y]
  const A = [
    [n, s1, s2],
    [s1, s11, s12],
    [s2, s12, s22],
  ];
  const bvec = [sy, s1y, s2y];
  // Gaussian elimination
  for (let c = 0; c < 3; c++) {
    let piv = A[c][c] || 1e-12;
    for (let cc = c; cc < 3; cc++) A[c][cc] /= piv;
    bvec[c] /= piv;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r][c];
      for (let cc = c; cc < 3; cc++) A[r][cc] -= f * A[c][cc];
      bvec[r] -= f * bvec[c];
    }
  }
  const [a, b1, b2] = bvec;
  const resid = y.map((v, i) => v - (a + b1 * x1[i] + b2 * x2[i]));
  const rss = resid.reduce((s, v) => s + v * v, 0);
  const residStd = Math.sqrt(rss / Math.max(1, n - 3)) || 1e-12;
  const alphaSharpePerPeriod = a / Math.sqrt(rss / n || 1e-12);
  // SE of intercept ~ residStd * sqrt((A^-1)[0,0]); approximate t via alpha/se
  // (we just report the alpha-Sharpe; t-approx below)
  const tStat = a / (residStd / Math.sqrt(n));
  return { alpha: a, betaBtc: b1, betaMom: b2, alphaSharpePerPeriod, tStat };
}
const regInc = regress2(fip.port, fip.btc, momBaseline.port);

// ---------------------------------------------------------------------------
// NULLS at the best config.
//   (A) ID-LABEL PLACEBO: shuffle ID labels across assets. fipSpread becomes a
//       random low/high split among momentum winners. p = P(placebo >= real).
//   (B) CROSS-SECTIONAL SHUFFLE: shuffle momentum->asset mapping.
// We compare the REAL fipSpread Sharpe to the null distribution.
// ---------------------------------------------------------------------------
const NSUR = 1000;
const rA = rng(40404);
const placeboSh: number[] = [];
for (let it = 0; it < NSUR; it++) {
  const r = runStrategy(B.form, B.top, B.split, "fipSpread", {
    idPlacebo: rA,
  });
  placeboSh.push(ann(sharpe(r.port)));
}
placeboSh.sort((a, b) => a - b);
const pPlacebo = placeboSh.filter((x) => x >= fipSh).length / placeboSh.length;
const placeboMean = placeboSh.reduce((a, b) => a + b, 0) / placeboSh.length;
const placebo95 = placeboSh[Math.floor(0.95 * placeboSh.length)];

const rB = rng(50505);
const xsShuf: number[] = [];
for (let it = 0; it < NSUR; it++) {
  const r = runStrategy(B.form, B.top, B.split, "fipSpread", {
    momShuffle: rB,
  });
  xsShuf.push(ann(sharpe(r.port)));
}
xsShuf.sort((a, b) => a - b);
const pXsShuf = xsShuf.filter((x) => x >= fipSh).length / xsShuf.length;

// Also placebo for the long-only low-ID family (its headline candidate).
const rC = rng(60606);
const placeboLow: number[] = [];
for (let it = 0; it < NSUR; it++) {
  const r = runStrategy(B.form, B.top, B.split, "lowID", { idPlacebo: rC });
  placeboLow.push(ann(sharpe(r.port)));
}
placeboLow.sort((a, b) => a - b);
const pPlaceboLow = placeboLow.filter((x) => x >= lowIDsh).length / placeboLow.length;

// ---------------------------------------------------------------------------
// Gauntlet: DSR @ honest N, CSCV/PBO across the fipSpread config grid,
// consume-once holdout (config chosen on first 80%, scored on last 20%).
// ---------------------------------------------------------------------------
const dsr = computeDeflatedSharpeRatio(fip.port, { trialCount: honestN });

const FOLDS = 8;
const foldReturns = scoredFip.map((s) => {
  const folds: number[][] = Array.from({ length: FOLDS }, () => []);
  s.port.forEach((r, i) => folds[i % FOLDS].push(r));
  return { id: s.id, folds };
});
let pbo: number | string = "n/a";
try {
  const res = estimateCscvPbo(foldReturns, { statistic: "sharpe" as any });
  pbo = (res as any).pbo;
} catch (e) {
  pbo = `err:${(e as Error).message}`;
}

// consume-once holdout: pick best fipSpread config on first 80% of rebalances,
// score it on the last 20% (never used for selection).
const splitIdx = Math.floor(R * 0.8);
const isScored = cfgs.map((c) => {
  const is = runStrategy(c.form, c.top, c.split, "fipSpread", { iEnd: splitIdx });
  return { c, s: ann(sharpe(is.port)) };
});
isScored.sort((a, b) => b.s - a.s);
const bestIS = isScored[0].c;
const ho = runStrategy(bestIS.form, bestIS.top, bestIS.split, "fipSpread", {
  iStart: splitIdx,
});
const holdoutSharpe = ann(sharpe(ho.port));

const meanW = fip.port.reduce((a, b) => a + b, 0) / fip.port.length;
const monthlyPct = (Math.pow(1 + meanW, 52 / 12) - 1) * 100;

const out = {
  nRebalances: fip.port.length,
  honestN,
  honestN_breakdown: `${cfgs.length} configs x ${FAMILIES_TESTED} ID families`,
  bestConfig: B.id,
  // headline incremental comparisons
  fipSpread_sharpeAnn: fipSh,
  momentumBaseline_sharpeAnn: momSh,
  lowID_longOnly_sharpeAnn: lowIDsh,
  // KEY CONTROL — does inverse-vol reproduce it?
  volSpread_control_sharpeAnn: volSpreadSh,
  lowVol_longOnly_control_sharpeAnn: lowVolSh,
  idLiftOverVolControl: fipSh - volSpreadSh,
  // BTC-beta decomposition (M1 lesson)
  fip_btc_beta: reg.beta,
  fip_residual_alpha_sharpeAnn: residSharpe,
  fip_alpha_ann_pct: alphaAnnPct,
  lowID_residual_alpha_sharpeAnn: residLowSh,
  // incremental ID alpha AFTER controlling for BOTH BTC and plain momentum:
  fipIncremental_alpha_ann_pct: regInc.alpha * 52 * 100,
  fipIncremental_alpha_sharpeAnn: ann(regInc.alphaSharpePerPeriod),
  fipIncremental_betaBtc: regInc.betaBtc,
  fipIncremental_betaMom: regInc.betaMom,
  fipIncremental_tStat: regInc.tStat,
  // NULLS
  idPlacebo_p_fipSpread: pPlacebo,
  idPlacebo_mean_sharpe: placeboMean,
  idPlacebo_95pct_sharpe: placebo95,
  xsShuffle_p_fipSpread: pXsShuf,
  idPlacebo_p_lowID: pPlaceboLow,
  // gauntlet
  dsr_p_at_honestN: dsr.deflatedProbability,
  pbo,
  holdout_config_chosen_on_first80: `F${bestIS.form}_W${bestIS.top}_S${bestIS.split}`,
  holdout_sharpe_ann_consumeOnce: holdoutSharpe,
  holdout_nRebalances: ho.port.length,
  monthlyReturnPctNet_bestFip: monthlyPct,
  top5FipConfigs: scoredFip.slice(0, 5).map((s) => ({ id: s.id, sharpe: s.sh })),
  bestLowIDConfig: { id: bestLowID.id, sharpe: bestLowID.sh },
  note:
    "ID = sign(PRET)*(%neg-%pos) over formation daily moves; low ID = continuous mover. " +
    "fipSpread = low-ID minus high-ID momentum winners. VOL control = same double-sort on realized vol. " +
    "ID-label placebo shuffles ID across assets (momentum untouched). 10bps rt cost. Annualized at sqrt(52).",
};

fs.writeFileSync(path.join(OUT, "m4-frog-in-pan.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
