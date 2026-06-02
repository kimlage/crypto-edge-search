/**
 * Q4-STREV — Short-term WEEKLY residual reversal (beta-neutral), cross-sectional.
 *
 * Distinct from the killed D4-S6 PCA basket stat-arb (which residualizes against PCA eigen-
 * portfolios) and from D4-S7 plain XS short-term reversal: here we residualize each alt vs BTC
 * (single-factor, rolling causal beta), form a WEEKLY cumulative-residual signal, and run a
 * dollar-neutral & beta-neutral long-losers / short-winners book.
 *
 * Data: committed $0 Binance daily panel output/crossxs/daily-closes.json (30 coins, 2020-06..2026-05).
 *
 * Causality contract:
 *   - beta_i estimated on a TRAILING window ending at rebalance day t (uses returns up to and
 *     including day t). Position formed at close t, held over the next week (t -> t+H days).
 *   - signal = cumulative residual return over the L weeks ending at t (information at close t).
 *   - SKIP-1d option: drop the most recent day from the signal window (neutralizes 1-day bid-ask
 *     bounce / microstructure, the D4-S7 KEY control).
 *
 * Survivorship: universe = coins liquid TODAY (panel-meta survivorshipNote). Edge is an UPPER BOUND.
 */
import fs from "node:fs";

export const ROOT = ".";

export interface DailyPanel {
  dates: string[]; // YYYY-MM-DD ascending
  assets: string[];
  // logret[d][a] = log(close[d]/close[d-1]) for asset a; NaN if either close missing
  logret: number[][];
  // present[d][a] = asset tradable on day d (valid close both d-1 and d)
  present: boolean[][];
  btcIdx: number;
}

export function loadDailyPanel(): DailyPanel {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8"));
  const dates: string[] = j.dates;
  const closesObj: Record<string, (number | null)[]> = j.closes;
  const assets = Object.keys(closesObj);
  const D = dates.length;
  const A = assets.length;
  const logret: number[][] = Array.from({ length: D }, () => new Array(A).fill(NaN));
  const present: boolean[][] = Array.from({ length: D }, () => new Array(A).fill(false));
  for (let a = 0; a < A; a++) {
    const c = closesObj[assets[a]];
    for (let d = 1; d < D; d++) {
      const c0 = c[d - 1];
      const c1 = c[d];
      if (c0 != null && c1 != null && c0 > 0 && c1 > 0) {
        logret[d][a] = Math.log(c1 / c0);
        present[d][a] = true;
      }
    }
  }
  const btcIdx = assets.indexOf("BTC");
  return { dates, assets, logret, present, btcIdx };
}

/** Weekly rebalance day indices (every H days from a fixed phase), tradable region only. */
export function rebalanceDays(panel: DailyPanel, holdDays: number, warmupDays: number): number[] {
  const out: number[] = [];
  // last rebalance must have a full forward holdDays window inside the panel
  const lastStart = panel.dates.length - 1 - holdDays;
  for (let t = warmupDays; t <= lastStart; t += holdDays) out.push(t);
  return out;
}

/** Simple OLS slope of y on x (no intercept removal beyond demean), causal. */
function olsBeta(y: number[], x: number[]): number {
  const n = y.length;
  if (n < 5) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx; cov += dx * (y[i] - my); vx += dx * dx; }
  return vx > 1e-12 ? cov / vx : 0;
}

export interface BookConfig {
  betaWin: number;     // trailing days for rolling beta to BTC
  sigWeeks: number;    // signal lookback in weeks (cumulative residual over sigWeeks*H days)
  holdDays: number;    // rebalance period (7 = weekly)
  skip1d: boolean;     // drop most-recent day from the signal window
  quantile: number;    // fraction of cross-section in each leg (e.g. 0.3 -> top/bottom 30%)
  weighting: "equal" | "rank"; // within-leg weighting
  betaNeutralize: boolean; // residualize signal vs BTC (true = STREV; false = raw XS reversal control)
}

export interface BookResult {
  rebalDates: string[];
  netRet: number[];      // per-rebalance NET portfolio return (long-short, dollar-neutral, gross-exposure 1 per side)
  grossRet: number[];    // before cost
  longShortBeta: number[]; // realized book beta to BTC each period (for neutrality check)
  turnoverPerRebal: number;
  meanNames: number;     // avg names per leg
  nRebal: number;
}

/**
 * Build the long-short book over a set of rebalance indices.
 * Returns per-rebalance portfolio returns (net of cost) and realized book beta to BTC.
 *
 * Cross-section at rebalance t uses only assets present across the WHOLE signal window and the
 * WHOLE forward holding window (no look-ahead survivorship within a period).
 *
 * `shuffleRng`, if provided, performs the CROSS-SECTIONAL SHUFFLE null: within each rebalance,
 * permute the signal-to-asset assignment (destroys XS predictive structure, preserves the marginal
 * signal distribution AND the realized cross-section of forward returns).
 */
export function buildBook(
  panel: DailyPanel,
  cfg: BookConfig,
  rebalIdx: number[],
  costPerSide: number,
  shuffleRng?: () => number,
): BookResult {
  const { betaWin, sigWeeks, holdDays, skip1d, quantile, weighting, betaNeutralize } = cfg;
  const A = panel.assets.length;
  const btc = panel.btcIdx;
  const sigDays = sigWeeks * holdDays;
  const skip = skip1d ? 1 : 0;

  const netRet: number[] = [];
  const grossRet: number[] = [];
  const bookBeta: number[] = [];
  const rebalDates: string[] = [];
  let prevW: number[] = new Array(A).fill(0);
  let turnoverSum = 0;
  let namesSum = 0;
  let nameCount = 0;

  for (const t of rebalIdx) {
    // signal window [t - sigDays - skip + 1 .. t - skip], beta window [t - betaWin + 1 .. t]
    const sigLo = t - sigDays - skip + 1;
    const sigHi = t - skip; // inclusive
    const betaLo = t - betaWin + 1;
    if (sigLo < 1 || betaLo < 1) continue;
    const fwdLo = t + 1;
    const fwdHi = t + holdDays; // inclusive
    if (fwdHi > panel.dates.length - 1) continue;

    // candidate assets: present every day across beta window, signal window, and forward window
    const cand: number[] = [];
    for (let a = 0; a < A; a++) {
      if (a === btc) continue; // BTC is the factor, not tradable in the alt book
      let ok = true;
      for (let d = Math.min(sigLo, betaLo); d <= fwdHi; d++) {
        if (!panel.present[d][a] || !panel.present[d][btc]) { ok = false; break; }
      }
      if (ok) cand.push(a);
    }
    if (cand.length < 6) continue; // need a meaningful cross-section

    // rolling beta of each candidate to BTC over beta window
    const btcWin: number[] = [];
    for (let d = betaLo; d <= t; d++) btcWin.push(panel.logret[d][btc]);
    const signal: number[] = [];
    for (const a of cand) {
      let beta = 0;
      if (betaNeutralize) {
        const yWin: number[] = [];
        for (let d = betaLo; d <= t; d++) yWin.push(panel.logret[d][a]);
        beta = olsBeta(yWin, btcWin);
      }
      // cumulative residual return over signal window
      let cum = 0;
      for (let d = sigLo; d <= sigHi; d++) {
        const r = panel.logret[d][a] - beta * panel.logret[d][btc];
        cum += r;
      }
      signal.push(cum);
    }

    // optional cross-sectional shuffle of the signal -> asset mapping (the RIGHT null)
    let sig = signal;
    if (shuffleRng) {
      sig = signal.slice();
      for (let i = sig.length - 1; i > 0; i--) {
        const j = Math.floor(shuffleRng() * (i + 1));
        const tmp = sig[i]; sig[i] = sig[j]; sig[j] = tmp;
      }
    }

    // rank: long the LOSERS (lowest cumulative residual), short the WINNERS (highest)
    const order = cand.map((a, i) => ({ a, s: sig[i] })).sort((p, q) => p.s - q.s);
    const k = Math.max(1, Math.floor(order.length * quantile));
    const longs = order.slice(0, k);            // most negative residual = losers
    const shorts = order.slice(order.length - k); // most positive residual = winners

    // weights: dollar-neutral, gross exposure 1.0 per side
    const w = new Array(A).fill(0);
    const assignWeights = (leg: { a: number }[], sign: number) => {
      if (weighting === "equal") {
        const ww = sign / leg.length;
        for (const { a } of leg) w[a] += ww;
      } else {
        // rank weighting: linear from edge to center
        let tot = 0;
        const raw = leg.map((_, i) => leg.length - i); // strongest gets most
        for (const r of raw) tot += r;
        leg.forEach(({ a }, i) => { w[a] += (sign * raw[i]) / tot; });
      }
    };
    assignWeights(longs, +1);
    assignWeights(shorts, -1);

    // realized forward return over hold window + realized book beta
    let gross = 0;
    let bookB = 0;
    const fwdBtc: number[] = [];
    for (let d = fwdLo; d <= fwdHi; d++) fwdBtc.push(panel.logret[d][btc]);
    // per-asset forward cumulative return
    for (let a = 0; a < A; a++) {
      if (w[a] === 0) continue;
      let fwd = 0;
      for (let d = fwdLo; d <= fwdHi; d++) fwd += panel.logret[d][a];
      gross += w[a] * fwd;
    }
    // book beta over the forward window (book daily return vs btc daily return)
    {
      const bookDaily: number[] = [];
      for (let d = fwdLo; d <= fwdHi; d++) {
        let bd = 0;
        for (let a = 0; a < A; a++) if (w[a] !== 0) bd += w[a] * panel.logret[d][a];
        bookDaily.push(bd);
      }
      bookB = olsBeta(bookDaily, fwdBtc);
    }

    // turnover vs previous weights (sum |dw|), each unit of turnover pays costPerSide
    let turn = 0;
    for (let a = 0; a < A; a++) turn += Math.abs(w[a] - prevW[a]);
    const cost = turn * costPerSide;
    prevW = w;

    netRet.push(gross - cost);
    grossRet.push(gross);
    bookBeta.push(bookB);
    rebalDates.push(panel.dates[t]);
    turnoverSum += turn;
    namesSum += longs.length + shorts.length;
    nameCount++;
  }

  return {
    rebalDates,
    netRet,
    grossRet,
    longShortBeta: bookBeta,
    turnoverPerRebal: nameCount ? turnoverSum / nameCount : 0,
    meanNames: nameCount ? namesSum / nameCount : 0,
    nRebal: netRet.length,
  };
}

// ---- small stats helpers (period-level; annualization handled by caller) ----
export function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
export function std(a: number[]): number {
  const n = a.length; if (n < 2) return 0; const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
export function sharpePeriod(a: number[]): number { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
export function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
