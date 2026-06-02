/**
 * D3-A3 — GARCH/EGARCH vol-forecast timing (BTC).
 *
 * Belief: risk-on in calm, risk-off in turbulence. Mechanism question: is vol-timing
 * the long leg ALPHA, or just a smoother BETA (mechanical Sharpe lift)?
 *
 * Build (strongest honest version):
 *   - Daily BTC close-to-close log returns (2017-2026, 3197 days).
 *   - One-step-ahead conditional vol forecast from GARCH(1,1) and EGARCH(1,1),
 *     refit on a ROLLING window every REFIT days (no look-ahead: forecast for day t
 *     uses only data through t-1). Warm-up burned.
 *   - Strategy: leverage_t = clamp(targetVol / forecastVol_t, 0, LMAX). Long-only scaling.
 *   - r_strat_t = leverage_t * r_t  - cost * |leverage_t - leverage_{t-1}|.
 *
 * KEY CONTROLS (must beat ALL, net-of-cost):
 *   (A) Constant-leverage B&H at MATCHED average exposure (same avg leverage, no churn).
 *   (B) Naive trailing-realized-vol timer (same scaling rule, forecastVol = trailing RV).
 *   (C) Constant vol-target on rolling close-to-close vol (standard Moreira-Muir benchmark).
 *
 * SURROGATE NULL (the decisive test): GARCH-SIMULATED paths with the SAME fitted vol
 * dynamics but ZERO return edge (drift = 0, iid standardized innovations). Run the WHOLE
 * pipeline (refit + time + cost + controls) on each surrogate. The mechanical Sharpe lift
 * (strat - B&H) reproduces on these zero-edge paths. REAL lift must exceed surrogate lift.
 *
 * Gauntlet: net-of-cost, Deflated Sharpe @ honest N, CSCV/PBO, block-bootstrap CI,
 * surrogate p on the LIFT (not raw Sharpe), Harvey-Liu haircut.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/a3-harness.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

const ANNDAYS = 365; // crypto trades 365d
const ann = (sPerDay: number) => sPerDay * Math.sqrt(ANNDAYS);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
const std = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, x.length - 1));
};

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
function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Load aggregated daily series
// ---------------------------------------------------------------------------
const dailyRaw = JSON.parse(
  fs.readFileSync(path.join(OUT, "btc_daily.json"), "utf8"),
) as {
  days: { date: string; close: number; prevClose: number | null; rv: number; n15: number }[];
};
// keep only full days with a valid prevClose
const days = dailyRaw.days.filter(
  (d) => d.prevClose != null && d.prevClose > 0 && d.close > 0 && d.n15 >= 80,
);
const dates = days.map((d) => d.date);
// daily close-to-close log return (in %, scaled x100 for numerical conditioning of GARCH)
const SCALE = 100;
const rPct = days.map((d) => Math.log(d.close / (d.prevClose as number)) * SCALE);
const rRaw = rPct.map((x) => x / SCALE); // fractional daily return
const rvDaily = days.map((d) => Math.sqrt(d.rv) * SCALE); // realized vol (%, from intraday)
const N = rPct.length;

// ===========================================================================
// GARCH(1,1):  sigma2_t = omega + alpha*eps_{t-1}^2 + beta*sigma2_{t-1}
//   eps_t = r_t - mu ;   r_t ~ N(mu, sigma2_t).  MLE via coordinate/grid + local search.
// ===========================================================================
interface Garch11 { mu: number; omega: number; alpha: number; beta: number; ll: number; }
function garchFilter(r: number[], p: { mu: number; omega: number; alpha: number; beta: number }) {
  const { mu, omega, alpha, beta } = p;
  const n = r.length;
  const s2 = new Array(n).fill(0);
  const uncond = omega / Math.max(1e-8, 1 - alpha - beta);
  s2[0] = uncond > 0 ? uncond : 1;
  let ll = 0;
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      const e = r[t - 1] - mu;
      s2[t] = omega + alpha * e * e + beta * s2[t - 1];
    }
    if (s2[t] <= 0) s2[t] = 1e-8;
    const e = r[t] - mu;
    ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(s2[t]) + (e * e) / s2[t]);
  }
  return { s2, ll };
}
function fitGarch11(r: number[]): Garch11 {
  const varr = (() => {
    const m = mean(r);
    return r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length;
  })();
  const mu = mean(r);
  let best: Garch11 = { mu, omega: varr * 0.1, alpha: 0.08, beta: 0.9, ll: -Infinity };
  // grid then local refine on (alpha,beta); omega pinned to target uncond var
  const alphas = [0.02, 0.05, 0.08, 0.12, 0.16, 0.2];
  const betas = [0.8, 0.85, 0.9, 0.93, 0.96, 0.98];
  for (const a of alphas)
    for (const b of betas) {
      if (a + b >= 0.999) continue;
      const omega = varr * (1 - a - b);
      const { ll } = garchFilter(r, { mu, omega, alpha: a, beta: b });
      if (ll > best.ll) best = { mu, omega, alpha: a, beta: b, ll };
    }
  // local coordinate refine
  let step = 0.04;
  for (let iter = 0; iter < 60; iter++) {
    let improved = false;
    for (const [da, db] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
    ]) {
      const a = best.alpha + da;
      const b = best.beta + db;
      if (a <= 1e-4 || b <= 1e-4 || a + b >= 0.9995) continue;
      const omega = varr * (1 - a - b);
      const { ll } = garchFilter(r, { mu: best.mu, omega, alpha: a, beta: b });
      if (ll > best.ll) {
        best = { mu: best.mu, omega, alpha: a, beta: b, ll };
        improved = true;
      }
    }
    if (!improved) step *= 0.5;
    if (step < 1e-4) break;
  }
  return best;
}
// one-step-ahead forecast of sigma2 given params and history r[0..t-1]
function garchForecastNext(r: number[], p: Garch11): number {
  const { s2 } = garchFilter(r, p);
  const last = r.length - 1;
  const e = r[last] - p.mu;
  return p.omega + p.alpha * e * e + p.beta * s2[last];
}

// ===========================================================================
// EGARCH(1,1):  ln sigma2_t = omega + beta*ln sigma2_{t-1}
//                + alpha*(|z_{t-1}| - E|z|) + gamma*z_{t-1},   z=eps/sigma
//   captures leverage (gamma). MLE via grid + local refine.
// ===========================================================================
interface Egarch11 { mu: number; omega: number; alpha: number; beta: number; gamma: number; ll: number; }
const SQRT2PI = Math.sqrt(2 / Math.PI); // E|z| for N(0,1)
function egarchFilter(r: number[], p: { mu: number; omega: number; alpha: number; beta: number; gamma: number }) {
  const { mu, omega, alpha, beta, gamma } = p;
  const n = r.length;
  const lns2 = new Array(n).fill(0);
  const varr = (() => {
    const m = mean(r);
    return r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length;
  })();
  lns2[0] = Math.log(Math.max(1e-6, varr));
  let ll = 0;
  for (let t = 0; t < n; t++) {
    if (t > 0) {
      const sPrev = Math.sqrt(Math.exp(lns2[t - 1]));
      const z = (r[t - 1] - mu) / Math.max(1e-8, sPrev);
      lns2[t] = omega + beta * lns2[t - 1] + alpha * (Math.abs(z) - SQRT2PI) + gamma * z;
    }
    const s2 = Math.exp(lns2[t]);
    const e = r[t] - mu;
    ll += -0.5 * (Math.log(2 * Math.PI) + lns2[t] + (e * e) / s2);
  }
  return { lns2, ll };
}
function fitEgarch11(r: number[]): Egarch11 {
  const mu = mean(r);
  const varr = (() => {
    const m = mean(r);
    return r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length;
  })();
  let best: Egarch11 = {
    mu,
    omega: Math.log(varr) * 0.1,
    alpha: 0.1,
    beta: 0.95,
    gamma: -0.05,
    ll: -Infinity,
  };
  const alphas = [0.05, 0.1, 0.15, 0.2];
  const betas = [0.9, 0.95, 0.98];
  const gammas = [-0.15, -0.08, 0, 0.05];
  for (const a of alphas)
    for (const b of betas)
      for (const g of gammas) {
        const omega = Math.log(Math.max(1e-6, varr)) * (1 - b);
        const { ll } = egarchFilter(r, { mu, omega, alpha: a, beta: b, gamma: g });
        if (ll > best.ll) best = { mu, omega, alpha: a, beta: b, gamma: g, ll };
      }
  let step = 0.05;
  for (let iter = 0; iter < 80; iter++) {
    let improved = false;
    const cur = best;
    for (const [da, db, dg, dw] of [
      [step, 0, 0, 0],
      [-step, 0, 0, 0],
      [0, step, 0, 0],
      [0, -step, 0, 0],
      [0, 0, step, 0],
      [0, 0, -step, 0],
      [0, 0, 0, step],
      [0, 0, 0, -step],
    ]) {
      const a = cur.alpha + da;
      const b = cur.beta + db;
      const g = cur.gamma + dg;
      const w = cur.omega + dw;
      if (b <= 0 || b >= 0.9995 || a < 0) continue;
      const { ll } = egarchFilter(r, { mu: cur.mu, omega: w, alpha: a, beta: b, gamma: g });
      if (ll > best.ll) best = { mu: cur.mu, omega: w, alpha: a, beta: b, gamma: g, ll };
    }
    if (best === cur) step *= 0.5;
    if (step < 1e-4) break;
  }
  return best;
}
function egarchForecastNext(r: number[], p: Egarch11): number {
  const { lns2 } = egarchFilter(r, p);
  const last = r.length - 1;
  const sPrev = Math.sqrt(Math.exp(lns2[last]));
  const z = (r[last] - p.mu) / Math.max(1e-8, sPrev);
  const lnNext = p.omega + p.beta * lns2[last] + p.alpha * (Math.abs(z) - SQRT2PI) + p.gamma * z;
  return Math.exp(lnNext);
}

// ---------------------------------------------------------------------------
// Rolling out-of-sample vol forecasts (no look-ahead).
//   WARMUP days used to fit first model; refit every REFIT days on a ROLLING WINDOW.
//   Returns: forecastVol[t] (fractional, daily) for t in [WARMUP, N) — forecast made
//   at close of t-1 for return of day t.
// ---------------------------------------------------------------------------
const WARMUP = 750; // ~2y warmup before first OOS forecast
const REFIT = 21; // refit monthly (keeps cost down; standard)
const WINDOW = 750; // rolling window length for fit

interface ForecastSet {
  garchVol: (number | null)[]; // fractional daily vol forecast for day t
  egarchVol: (number | null)[];
}
function rollingForecasts(rIn: number[], garchOnly = false): ForecastSet {
  const n = rIn.length;
  const garchVol: (number | null)[] = new Array(n).fill(null);
  const egarchVol: (number | null)[] = new Array(n).fill(null);
  let gp: Garch11 | null = null;
  let ep: Egarch11 | null = null;
  for (let t = WARMUP; t < n; t++) {
    if (gp == null || (t - WARMUP) % REFIT === 0) {
      const lo = Math.max(0, t - WINDOW);
      const win = rIn.slice(lo, t); // data through t-1 only
      gp = fitGarch11(win);
      if (!garchOnly) ep = fitEgarch11(win);
    }
    // forecast sigma2 for day t using history through t-1
    const hist = rIn.slice(Math.max(0, t - WINDOW), t);
    const g2 = garchForecastNext(hist, gp as Garch11);
    garchVol[t] = Math.sqrt(Math.max(1e-8, g2)) / SCALE; // back to fractional
    if (!garchOnly) {
      const e2 = egarchForecastNext(hist, ep as Egarch11);
      egarchVol[t] = Math.sqrt(Math.max(1e-8, e2)) / SCALE;
    }
  }
  return { garchVol, egarchVol };
}

// ---------------------------------------------------------------------------
// Strategy + controls given a forecast-vol series and the realized fractional returns.
//   leverage_t = clamp(targetVol / forecastVol_t, 0, LMAX)
//   exposure applied to NEXT-day return; cost on |dLeverage|.
//   We compute the strategy net series, then a B&H-at-matched-avg-exposure control.
// ---------------------------------------------------------------------------
const COST = 0.0006; // 6 bps per unit leverage change (realistic perp taker+slippage, generous)
const LMAX = 3.0; // leverage cap
function volTimedSeries(
  fvol: (number | null)[],
  rFrac: number[],
  targetVolDaily: number,
  costPerLev = COST,
): { net: number[]; gross: number[]; lev: number[]; idx: number[] } {
  const net: number[] = [];
  const gross: number[] = [];
  const lev: number[] = [];
  const idx: number[] = [];
  let prevLev = 0;
  for (let t = 0; t < rFrac.length; t++) {
    const fv = fvol[t];
    if (fv == null || !isFinite(fv) || fv <= 0) continue;
    const L = Math.max(0, Math.min(LMAX, targetVolDaily / fv));
    const g = L * rFrac[t];
    const c = costPerLev * Math.abs(L - prevLev);
    net.push(g - c);
    gross.push(g);
    lev.push(L);
    idx.push(t);
    prevLev = L;
  }
  return { net, gross, lev, idx };
}
// constant-leverage B&H at matched average exposure (no churn, no per-day cost)
function matchedBH(rFrac: number[], idx: number[], avgLev: number, costPerLev = COST): number[] {
  // single entry cost amortized to ~0 over long horizon; constant leverage held.
  const out: number[] = [];
  for (const t of idx) out.push(avgLev * rFrac[t]);
  return out;
}

// trailing realized-vol forecast (naive timer): vol = sqrt(EWMA or rolling of r^2)
function trailingVolForecast(rFrac: number[], look: number): (number | null)[] {
  const n = rFrac.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let t = WARMUP; t < n; t++) {
    let s = 0;
    let c = 0;
    for (let k = t - look; k < t; k++) {
      if (k < 0) continue;
      s += rFrac[k] * rFrac[k];
      c++;
    }
    out[t] = c > 0 ? Math.sqrt(s / c) : null;
  }
  return out;
}
// realized-vol-from-intraday forecast (uses yesterday's intraday RV as tomorrow's vol)
function intradayRvForecast(rvD: number[]): (number | null)[] {
  const n = rvD.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let t = WARMUP; t < n; t++) out[t] = rvD[t - 1] / SCALE; // lag-1, fractional
  return out;
}

// ---------------------------------------------------------------------------
// Build everything on REAL data
// ---------------------------------------------------------------------------
const fc = rollingForecasts(rPct);
// target vol = median realized close-to-close daily vol over OOS window (so avg leverage ~1)
const ccVol = (() => {
  const out: number[] = [];
  for (let t = WARMUP; t < N; t++) {
    let s = 0;
    let c = 0;
    for (let k = t - 30; k < t; k++) {
      if (k < 0) continue;
      s += rRaw[k] * rRaw[k];
      c++;
    }
    if (c > 0) out.push(Math.sqrt(s / c));
  }
  return out;
})();
const TARGET = ccVol.sort((a, b) => a - b)[Math.floor(ccVol.length / 2)]; // median daily vol

// persist forecast vol series (annualized %) with dates for the DVOL cross-check
{
  const recs: { date: string; garchIV: number; egarchIV: number; rvIV: number }[] = [];
  for (let t = WARMUP; t < N; t++) {
    if (fc.garchVol[t] == null) continue;
    recs.push({
      date: dates[t],
      garchIV: (fc.garchVol[t] as number) * Math.sqrt(365) * 100,
      egarchIV: (fc.egarchVol[t] as number) * Math.sqrt(365) * 100,
      rvIV: (rvDaily[t] / SCALE) * Math.sqrt(365) * 100,
    });
  }
  fs.writeFileSync(path.join(OUT, "a3-forecasts.json"), JSON.stringify(recs, null, 0));
}

// strategy: GARCH-timed and EGARCH-timed
const garchS = volTimedSeries(fc.garchVol, rRaw, TARGET);
const egarchS = volTimedSeries(fc.egarchVol, rRaw, TARGET);
// naive trailing-RV timer (control B) — same scaling, trailing 20d r^2
const trailFV = trailingVolForecast(rRaw, 20);
const trailS = volTimedSeries(trailFV, rRaw, TARGET);
// constant vol-target on rolling close-to-close 30d vol (control C, Moreira-Muir benchmark)
const rollFV = trailingVolForecast(rRaw, 30);
const rollS = volTimedSeries(rollFV, rRaw, TARGET);
// intraday-RV timer (extra control, strongest naive: uses realized variance from 15m)
const rvFV = intradayRvForecast(rvDaily);
const rvS = volTimedSeries(rvFV, rRaw, TARGET);

// matched-avg-exposure B&H control for the GARCH strategy
const garchAvgLev = mean(garchS.lev);
const bhMatched = matchedBH(rRaw, garchS.idx, garchAvgLev);
// plain B&H (leverage 1) on same window
const bhPlain = garchS.idx.map((t) => rRaw[t]);

function summarize(label: string, net: number[]) {
  const s = ann(sharpe(net));
  const m = mean(net);
  return { label, n: net.length, sharpeAnn: s, meanDaily: m, monthlyPct: ((Math.pow(1 + m, 30) - 1) * 100) };
}

const garchSum = summarize("GARCH-timed (net)", garchS.net);
const egarchSum = summarize("EGARCH-timed (net)", egarchS.net);
const trailSum = summarize("trailing-RV timer (net)", trailS.net);
const rollSum = summarize("const vol-target 30d (net)", rollS.net);
const rvSum = summarize("intraday-RV timer (net)", rvS.net);
const bhMatchedSum = summarize("B&H @ matched avg exposure", bhMatched);
const bhPlainSum = summarize("B&H leverage=1", bhPlain);

// LIFT = strategy Sharpe - matched-exposure B&H Sharpe (the alpha claim)
const realLift = garchSum.sharpeAnn - bhMatchedSum.sharpeAnn;
const egarchLift = egarchSum.sharpeAnn - bhMatchedSum.sharpeAnn;
const trailLift = trailSum.sharpeAnn - bhMatchedSum.sharpeAnn;

// ===========================================================================
// SURROGATE NULL: GARCH-simulated zero-edge paths.
//   Fit ONE GARCH(1,1) on full OOS-window returns to get vol dynamics; simulate
//   paths with drift=0 (zero return edge) and iid N(0,1) innovations scaled by the
//   GARCH sigma. Run the ENTIRE pipeline (rolling refit + GARCH-timing + cost + matched
//   B&H) on each surrogate. The mechanical lift distribution under H0 (no edge) is the
//   null. Real lift must exceed it.
// ===========================================================================
const fullFit = fitGarch11(rPct);
function simGarchPath(p: Garch11, n: number, r: () => number): number[] {
  // simulate in % units (same as rPct), drift = 0 (zero edge)
  const out: number[] = new Array(n);
  const uncond = p.omega / Math.max(1e-8, 1 - p.alpha - p.beta);
  let s2 = uncond > 0 ? uncond : 1;
  let prevE = 0;
  for (let t = 0; t < n; t++) {
    s2 = p.omega + p.alpha * prevE * prevE + p.beta * s2;
    if (s2 <= 0) s2 = 1e-8;
    const e = Math.sqrt(s2) * gauss(r); // mu=0 → zero edge
    out[t] = e;
    prevE = e;
  }
  return out;
}
const NSURRO = 200;
const surr = rng(20260601);
const surroLifts: number[] = [];
const surroStratSh: number[] = [];
for (let it = 0; it < NSURRO; it++) {
  const simPct = simGarchPath(fullFit, N, surr);
  const simRaw = simPct.map((x) => x / SCALE);
  const sfc = rollingForecasts(simPct, true);
  // target vol = median rolling cc vol on the sim (matched construction)
  const simCC: number[] = [];
  for (let t = WARMUP; t < N; t++) {
    let s = 0;
    let c = 0;
    for (let k = t - 30; k < t; k++) {
      if (k < 0) continue;
      s += simRaw[k] * simRaw[k];
      c++;
    }
    if (c > 0) simCC.push(Math.sqrt(s / c));
  }
  const simTarget = simCC.sort((a, b) => a - b)[Math.floor(simCC.length / 2)];
  const sStrat = volTimedSeries(sfc.garchVol, simRaw, simTarget);
  const sAvgLev = mean(sStrat.lev);
  const sBH = matchedBH(simRaw, sStrat.idx, sAvgLev);
  const lift = ann(sharpe(sStrat.net)) - ann(sharpe(sBH));
  surroLifts.push(lift);
  surroStratSh.push(ann(sharpe(sStrat.net)));
}
surroLifts.sort((a, b) => a - b);
surroStratSh.sort((a, b) => a - b);
const pSurroLift = surroLifts.filter((x) => x >= realLift).length / surroLifts.length;
const pSurroStrat = surroStratSh.filter((x) => x >= garchSum.sharpeAnn).length / surroStratSh.length;
const surroLiftMean = mean(surroLifts);
const surroLiftP95 = surroLifts[Math.floor(0.95 * surroLifts.length)];

// ===========================================================================
// CSCV / PBO: treat the candidate timing strategies as competitors across folds.
//   Strategies = {GARCH, EGARCH, trailing-RV, intraday-RV, rolling-30, B&H-matched}.
//   8 folds over the common OOS index. Tests whether the winner in-train stays good OOS.
// ===========================================================================
function alignToIdx(series: number[], srcIdx: number[], commonIdx: number[]): number[] {
  const m = new Map(srcIdx.map((t, k) => [t, series[k]]));
  return commonIdx.map((t) => m.get(t) ?? 0);
}
const commonIdx = garchS.idx.filter(
  (t) =>
    egarchS.idx.includes(t) &&
    trailS.idx.includes(t) &&
    rollS.idx.includes(t) &&
    rvS.idx.includes(t),
);
function foldify(series: number[], nFolds: number): number[][] {
  const sz = Math.floor(series.length / nFolds);
  const out: number[][] = [];
  for (let f = 0; f < nFolds; f++) out.push(series.slice(f * sz, f === nFolds - 1 ? series.length : (f + 1) * sz));
  return out;
}
const NF = 8;
const cscvStrats = [
  { id: "garch", s: alignToIdx(garchS.net, garchS.idx, commonIdx) },
  { id: "egarch", s: alignToIdx(egarchS.net, egarchS.idx, commonIdx) },
  { id: "trailRV", s: alignToIdx(trailS.net, trailS.idx, commonIdx) },
  { id: "intradayRV", s: alignToIdx(rvS.net, rvS.idx, commonIdx) },
  { id: "roll30", s: alignToIdx(rollS.net, rollS.idx, commonIdx) },
  { id: "bhMatched", s: alignToIdx(matchedBH(rRaw, commonIdx, garchAvgLev), commonIdx, commonIdx) },
].map((x) => ({ id: x.id, folds: foldify(x.s, NF) }));
const pbo = estimateCscvPbo(cscvStrats, { statistic: "sharpe", trainFraction: 0.5 });

// ---------------------------------------------------------------------------
// Honest N: every config in the search.
//   forecast models {GARCH, EGARCH} x window {500,750,1000} x refit {10,21,42}
//   x LMAX {2,3,4} x targetVol {median,mean} x look(naive) — count generously.
//   2 x 3 x 3 x 3 x 2 = 108 for the GARCH/EGARCH family alone; add naive variants.
// ---------------------------------------------------------------------------
const HONEST_N = 108;
const dsr = computeDeflatedSharpeRatio(garchS.net, { trialCount: HONEST_N });

// Block-bootstrap CI on the GARCH strategy daily mean return (net)
const bb = blockBootstrapConfidenceInterval(garchS.net, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 20,
  seed: "a3-garch",
});

// Harvey-Liu style haircut: deflate t-stat by sqrt of (effective independent tests).
// observed t = sharpe_perPeriod * sqrt(n); haircut Sharpe ~ Sharpe * (1 - haircutFrac).
const tObs = sharpe(garchS.net) * Math.sqrt(garchS.net.length);
// HL multiple-testing p adj (Bonferroni-ish on HONEST_N), report implied haircut
const pSingle = 2 * (1 - normalCdfLocal(Math.abs(tObs)));
const pHL = Math.min(1, pSingle * HONEST_N);
function normalCdfLocal(x: number): number {
  // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

// ---------------------------------------------------------------------------
// Monthly $ on $100k notional (net), at matched exposure (the strategy's own avg lev)
// ---------------------------------------------------------------------------
const monthlyDollar100k = (Math.pow(1 + garchSum.meanDaily, 30) - 1) * 100000;

const out = {
  meta: {
    nDailyBars: N,
    oosBars: garchS.net.length,
    firstDate: dates[0],
    lastDate: dates[N - 1],
    warmup: WARMUP,
    refit: REFIT,
    window: WINDOW,
    targetVolDaily: TARGET,
    annTargetVolPct: TARGET * Math.sqrt(365) * 100,
    LMAX,
    costPerLevChange_bps: COST * 1e4,
    garchAvgLeverage: garchAvgLev,
    fullFitGarch: fullFit,
  },
  performance: {
    garch: garchSum,
    egarch: egarchSum,
    trailingRV: trailSum,
    constVolTarget30: rollSum,
    intradayRV: rvSum,
    bhMatchedExposure: bhMatchedSum,
    bhLeverage1: bhPlainSum,
  },
  controls: {
    beats_BH_matched_exposure: garchSum.sharpeAnn > bhMatchedSum.sharpeAnn,
    beats_trailingRV_timer: garchSum.sharpeAnn > trailSum.sharpeAnn,
    beats_constVolTarget: garchSum.sharpeAnn > rollSum.sharpeAnn,
    beats_intradayRV_timer: garchSum.sharpeAnn > rvSum.sharpeAnn,
    realLift_garch_minus_bh: realLift,
    egarchLift,
    trailLift,
  },
  surrogate: {
    nSurro: NSURRO,
    desc: "GARCH-simulated zero-edge paths (drift=0), full pipeline incl. timing+cost+matchedBH",
    surroLiftMean,
    surroLiftP95,
    realLift,
    p_lift_exceeds_surrogate: pSurroLift,
    p_stratSharpe_exceeds_surrogate: pSurroStrat,
    interpretation:
      pSurroLift > 0.10
        ? "real lift is INDISTINGUISHABLE from the mechanical zero-edge lift → no alpha"
        : "real lift exceeds the mechanical surrogate lift",
  },
  gauntlet: {
    honestN: HONEST_N,
    deflatedSharpe_p: dsr.deflatedProbability,
    deflatedSharpe_z: dsr.zScore,
    pbo: pbo.pbo,
    pbo_medianLogit: pbo.medianLogit,
    blockBootstrap_meanDaily_CI: [bb.lower, bb.estimate, bb.upper],
    blockBootstrap_excludesZero: bb.lower > 0 || bb.upper < 0,
    harveyLiu_pSingle: pSingle,
    harveyLiu_pAdjusted: pHL,
    tObs,
  },
  economics: {
    monthlyReturnPctNet: garchSum.monthlyPct,
    monthlyDollar_on_100k: monthlyDollar100k,
  },
};

fs.writeFileSync(path.join(OUT, "a3-results.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
