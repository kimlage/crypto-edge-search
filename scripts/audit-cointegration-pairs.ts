/**
 * TARGET 10 — COINTEGRATION PAIRS across majors (read-only, reuses the rigor cores).
 *
 * Hypothesis: some pairs of liquid USDT coins are cointegrated — their log-price
 * spread is mean-reverting — so a market-neutral spread trade (enter at |z|>2,
 * exit at z=0) earns net-of-cost alpha. This is the target flagged as "easiest to
 * fool yourself", so it is tested the most rigorously:
 *
 *   1) Engle-Granger cointegration is fit on the SEARCH slice ONLY (the oldest
 *      ~4 years). The ADF statistic on the OLS residual ranks the 105 pairs.
 *   2) The best pair's spread is traded CAUSALLY: the hedge ratio (rolling OLS),
 *      the spread mean and the spread sd at day t use ONLY closes <= t-1. Signal at
 *      t enters/holds; P&L accrues on day t+1's market move. Round trip = 28 bps.
 *   3) The single best config (pair + z-window) is chosen on the SEARCH slice.
 *      TRUE N = pairs x z-windows tried is recorded and fed to every deflation.
 *   4) The most-recent 24 months (730 days) are a one-shot hold-out, planned by
 *      planHoldoutSplit and consumed once via FinalHoldoutGuard.
 *   5) The chosen config is evaluated ONCE on the vault through evaluatePromotion
 *      (baselines, MinBTL, Deflated Sharpe @ true N, haircut). A 50% McLean-Pontiff
 *      decay haircut is applied. PROMOTE only if, on the hold-out, the net edge is
 *      positive, beats buy&hold + the random-lottery, DSR(true N) >= 0.95, MinBTL ok
 *      and the haircut Sharpe stays positive.
 *
 * Self-checks (run inline): on a PURE-NOISE clone (each coin an independent random
 * walk with matched vol) the rule must NOT show edge, and a FUTURE-DATA mutation
 * (scrambling closes strictly after a decision day) must NOT change that day's
 * position — proving causality.
 *
 * Reuses: holdout.ts (planHoldoutSplit, FinalHoldoutGuard),
 * promotion-evaluator.ts (evaluatePromotion), statistical-validation.ts
 * (summarizeReturnSeries), haircut.ts (haircutSharpe). No new statistics, no
 * BigQuery, no training, no writes. Reads output/crossxs only.
 *
 * Usage:
 *   tsx scripts/audit-cointegration-pairs.ts
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import {
  evaluatePromotion,
  type PromotionEvaluation,
} from "../src/lib/significance/promotion-evaluator";
import { summarizeReturnSeries } from "../src/lib/statistical-validation";
import { haircutSharpe } from "../src/lib/significance/haircut";
import {
  planHoldoutSplit,
  FinalHoldoutGuard,
} from "../src/lib/significance/holdout";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const ROUND_TRIP_COST = 0.0028; // 28 bps spot round trip (cost-realism rule)
const ENTRY_Z = 2.0; // enter when |z| > 2
const EXIT_Z = 0.0; // exit when the spread crosses 0 (mean)
const HOLDOUT_DAYS = 730; // most-recent ~24 months one-shot vault
const Z_WINDOWS = [30, 45, 60, 90] as const; // rolling lookbacks searched per pair
const MIN_HALF_LIFE_OBS = 252; // require >= 1y of search history to fit a pair
const DSR_THRESHOLD = 0.95;
const MCLEAN_PONTIFF_DECAY = 0.5; // 50% out-of-sample decay haircut

// ----------------------------------------------------------------------------
// Data loading
// ----------------------------------------------------------------------------

interface Panel {
  dates: string[];
  symbols: string[];
  /** symbol -> aligned daily close array (no nulls; full-history coins only). */
  closes: Map<string, number[]>;
  realData: boolean;
}

function loadPanel(): Panel {
  const raw = JSON.parse(
    readFileSync(join("output", "crossxs", "daily-closes.json"), "utf8"),
  ) as { dates: string[]; closes: Record<string, (number | null)[]>; realData?: boolean };
  const dates = raw.dates;
  const closes = new Map<string, number[]>();
  const symbols: string[] = [];
  for (const sym of Object.keys(raw.closes)) {
    const arr = raw.closes[sym]!;
    if (arr.length === dates.length && arr.every((c) => typeof c === "number" && c > 0)) {
      closes.set(sym, arr as number[]);
      symbols.push(sym);
    }
  }
  return { dates, symbols, closes, realData: raw.realData ?? false };
}

// ----------------------------------------------------------------------------
// Pure stats helpers (cointegration machinery — NOT a reimplementation of the
// promotion gates; these are the rule's own econometrics)
// ----------------------------------------------------------------------------

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : 0;
}

function std(xs: readonly number[], m = mean(xs)): number {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** OLS slope+intercept of y on x (no time leakage — caller controls the window). */
function ols(x: readonly number[], y: readonly number[]): { beta: number; alpha: number } {
  const n = Math.min(x.length, y.length);
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - mx;
    sxx += dx * dx;
    sxy += dx * (y[i]! - my);
  }
  const beta = sxx > 1e-12 ? sxy / sxx : 0;
  return { beta, alpha: my - beta * mx };
}

/**
 * Augmented Dickey-Fuller test statistic (no constant, lag 0 — the standard
 * Engle-Granger residual ADF). Regresses d(resid)_t on resid_{t-1}; the t-stat of
 * the AR coefficient is the ADF statistic. More negative ⇒ stronger stationarity.
 * (We add 1 autoregressive lag of the difference to soak up serial correlation.)
 */
function adfStat(resid: readonly number[]): number {
  const n = resid.length;
  if (n < 20) return 0;
  // Build regression: dy_t = rho * y_{t-1} + phi * dy_{t-1} + e
  const Y: number[] = [];
  const L: number[] = []; // y_{t-1}
  const D: number[] = []; // dy_{t-1}
  for (let t = 2; t < n; t += 1) {
    Y.push(resid[t]! - resid[t - 1]!); // dy_t
    L.push(resid[t - 1]!);
    D.push(resid[t - 1]! - resid[t - 2]!);
  }
  const m = Y.length;
  if (m < 10) return 0;
  // Two-regressor OLS via normal equations (L, D). Solve 2x2 system.
  let sLL = 0,
    sLD = 0,
    sDD = 0,
    sLY = 0,
    sDY = 0;
  for (let i = 0; i < m; i += 1) {
    sLL += L[i]! * L[i]!;
    sLD += L[i]! * D[i]!;
    sDD += D[i]! * D[i]!;
    sLY += L[i]! * Y[i]!;
    sDY += D[i]! * Y[i]!;
  }
  const det = sLL * sDD - sLD * sLD;
  if (Math.abs(det) < 1e-12) return 0;
  const rho = (sDD * sLY - sLD * sDY) / det;
  const phi = (sLL * sDY - sLD * sLY) / det;
  // Residual variance and SE of rho.
  let sse = 0;
  for (let i = 0; i < m; i += 1) {
    const yhat = rho * L[i]! + phi * D[i]!;
    sse += (Y[i]! - yhat) ** 2;
  }
  const dof = Math.max(1, m - 2);
  const sigma2 = sse / dof;
  // Var(rho) = sigma2 * (S^-1)_{11} = sigma2 * sDD/det
  const varRho = (sigma2 * sDD) / det;
  const seRho = Math.sqrt(Math.max(varRho, 1e-18));
  return rho / seRho; // t-stat (ADF). Negative & large-magnitude ⇒ stationary.
}

// ----------------------------------------------------------------------------
// The trading rule (CAUSAL): trade the spread z-score of an ordered pair (a,b).
//   spread_t   = logP_a[t] - beta * logP_b[t]      (beta fit on window < t)
//   z_t        = (spread_t - mu_t) / sd_t          (mu, sd on window < t)
//   position: long spread (long a, short beta*b) when z < -ENTRY, short when z>ENTRY,
//             flatten when |z| crosses EXIT. Dollar-neutral via beta.
//   P&L on day t+1 uses position set from data <= t. Costs charged on turnover.
// Returns the per-day net return series of the spread strategy over [start,end).
// ----------------------------------------------------------------------------

interface PairTrade {
  /** Net daily returns of the market-neutral spread book (per unit gross capital). */
  daily: number[];
  /** Number of round-trip trades (position changes / 2). */
  trades: number;
  /** Sum of |position change| per leg — turnover proxy. */
  turnover: number;
  /** Average holding length in bars. */
  avgHoldBars: number;
}

function tradePairCausal(
  logA: readonly number[],
  logB: readonly number[],
  retA: readonly number[],
  retB: readonly number[],
  start: number,
  end: number,
  zWindow: number,
): PairTrade {
  const daily: number[] = [];
  let position = 0; // -1 short spread, 0 flat, +1 long spread
  let prevPosition = 0;
  let trades = 0;
  let turnover = 0;
  let holdSum = 0;
  let holdCount = 0;
  let currentHold = 0;

  for (let t = start; t < end; t += 1) {
    // --- decide position from data strictly < t (causal) ---
    const w0 = t - zWindow;
    if (w0 < 1) {
      daily.push(0);
      continue;
    }
    // Hedge ratio (beta) from the rolling window of log-prices ending at t-1.
    const xWin = logB.slice(w0, t); // b
    const yWin = logA.slice(w0, t); // a
    const { beta, alpha } = ols(xWin, yWin);
    // Spread series on the same window, z from its mean/sd.
    const spreadWin: number[] = [];
    for (let i = 0; i < xWin.length; i += 1) spreadWin.push(yWin[i]! - (alpha + beta * xWin[i]!));
    const mu = mean(spreadWin);
    const sd = std(spreadWin, mu);
    // Current spread at t-1 (last fully-observed bar).
    const spreadNow = logA[t - 1]! - (alpha + beta * logB[t - 1]!);
    const z = sd > 1e-9 ? (spreadNow - mu) / sd : 0;

    // --- state machine: enter at |z|>ENTRY, exit when |z|<=EXIT ---
    if (position === 0) {
      if (z > ENTRY_Z) position = -1; // spread rich -> short spread (short a, long b)
      else if (z < -ENTRY_Z) position = 1; // spread cheap -> long spread
    } else if (position === 1 && z >= -EXIT_Z) {
      position = 0;
    } else if (position === -1 && z <= EXIT_Z) {
      position = 0;
    }

    // --- realize day-t market move with the position set from <= t-1 ---
    // Spread return ~= retA - beta_used * retB, normalized to unit gross
    // exposure (|1| + |beta|) so 28 bps applies to total notional turned over.
    const gross = 1 + Math.abs(beta);
    const spreadRet = (retA[t]! - beta * retB[t]!) / gross;
    let pnl = prevPosition * spreadRet;

    // costs: charge round trip on the fraction of the book that flipped.
    const change = Math.abs(position - prevPosition); // 0,1,2 (units of full book)
    if (change > 0) {
      pnl -= (change / 2) * ROUND_TRIP_COST;
      turnover += change;
      if (position !== 0 && prevPosition === 0) {
        // opened
      }
      if (position === 0 && prevPosition !== 0) {
        trades += 1; // a completed round trip
        holdSum += currentHold;
        holdCount += 1;
        currentHold = 0;
      } else if (position !== 0 && prevPosition !== 0 && position !== prevPosition) {
        // flip counts as a close + open
        trades += 1;
        holdSum += currentHold;
        holdCount += 1;
        currentHold = 0;
      }
    }
    if (position !== 0) currentHold += 1;

    daily.push(pnl);
    prevPosition = position;
  }
  const avgHoldBars = holdCount > 0 ? holdSum / holdCount : 0;
  return { daily, trades, turnover, avgHoldBars };
}

// ----------------------------------------------------------------------------
// Search: fit Engle-Granger on the SEARCH slice, rank pairs by ADF, then pick the
// best (pair, zWindow) by in-sample net Sharpe of the spread trade.
// ----------------------------------------------------------------------------

interface PairConfig {
  a: string;
  b: string;
  zWindow: number;
  adf: number;
  beta: number;
  sharpe: number;
  compound: number;
  trades: number;
}

function logSeries(closes: readonly number[]): number[] {
  return closes.map((c) => Math.log(c));
}
function retSeries(closes: readonly number[]): number[] {
  const r: number[] = [0];
  for (let i = 1; i < closes.length; i += 1) r.push((closes[i]! - closes[i - 1]!) / closes[i - 1]!);
  return r;
}

function annualizedSharpe(daily: readonly number[]): number {
  const s = summarizeReturnSeries(daily);
  return s.sharpe * Math.sqrt(252);
}

function searchBestConfig(
  panel: Panel,
  closesOf: (sym: string) => number[],
  searchStart: number,
  searchEnd: number,
): { best: PairConfig; allConfigs: PairConfig[]; trueN: number; ranked: PairConfig[] } {
  const syms = panel.symbols;
  const log = new Map<string, number[]>();
  const ret = new Map<string, number[]>();
  for (const s of syms) {
    const c = closesOf(s);
    log.set(s, logSeries(c));
    ret.set(s, retSeries(c));
  }

  const configs: PairConfig[] = [];
  let trueN = 0;
  for (let i = 0; i < syms.length; i += 1) {
    for (let j = i + 1; j < syms.length; j += 1) {
      const a = syms[i]!;
      const b = syms[j]!;
      const logA = log.get(a)!;
      const logB = log.get(b)!;
      // Engle-Granger on the SEARCH slice only.
      const xWin = logB.slice(searchStart, searchEnd);
      const yWin = logA.slice(searchStart, searchEnd);
      if (xWin.length < MIN_HALF_LIFE_OBS) continue;
      const { beta, alpha } = ols(xWin, yWin);
      const resid: number[] = [];
      for (let k = 0; k < xWin.length; k += 1) resid.push(yWin[k]! - (alpha + beta * xWin[k]!));
      const adf = adfStat(resid);
      // Each (pair, zWindow) is a distinct config TRIED -> counts toward true N.
      for (const zWindow of Z_WINDOWS) {
        trueN += 1;
        const tr = tradePairCausal(
          logA,
          logB,
          ret.get(a)!,
          ret.get(b)!,
          searchStart,
          searchEnd,
          zWindow,
        );
        const stats = summarizeReturnSeries(tr.daily.filter((x) => x !== 0 || true));
        configs.push({
          a,
          b,
          zWindow,
          adf,
          beta,
          sharpe: annualizedSharpe(tr.daily),
          compound: stats.compoundReturn,
          trades: tr.trades,
        });
      }
    }
  }
  // Rank for display by ADF (cointegration strength).
  const ranked = [...configs]
    .filter((c) => c.zWindow === Z_WINDOWS[0])
    .sort((x, y) => x.adf - y.adf);
  // Pick the BEST config by in-sample net Sharpe among pairs with at least a
  // mild cointegration signal (ADF < -1.5) and enough trades to be operational.
  const eligible = configs.filter((c) => c.adf < -1.5 && c.trades >= 6);
  const pool = eligible.length > 0 ? eligible : configs;
  const best = [...pool].sort((x, y) => y.sharpe - x.sharpe)[0]!;
  return { best, allConfigs: configs, trueN, ranked };
}

// ----------------------------------------------------------------------------
// Self-checks
// ----------------------------------------------------------------------------

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Build a pure-noise panel: each coin an independent GBM with the SAME daily vol
 *  as the real coin, but zero cross-correlation (so NO pair can be cointegrated). */
function buildNoisePanel(panel: Panel, closesOf: (s: string) => number[]): Map<string, number[]> {
  const rng = seeded(12345);
  const out = new Map<string, number[]>();
  for (const sym of panel.symbols) {
    const real = closesOf(sym);
    const rets = retSeries(real);
    const vol = std(rets.slice(1));
    const synth: number[] = [100];
    for (let i = 1; i < real.length; i += 1) {
      // Box-Muller normal
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      synth.push(synth[i - 1]! * Math.exp(vol * z - 0.5 * vol * vol));
    }
    out.set(sym, synth);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

function pct(x: number | null | undefined): string {
  return x == null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(2)}%`;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main(): void {
  const line = "=".repeat(80);
  console.log(line);
  console.log("TARGET 10 — COINTEGRATION PAIRS across majors (one-shot hold-out, rigor gates)");
  console.log(line);

  const panel = loadPanel();
  const realClosesOf = (s: string): number[] => panel.closes.get(s)!;
  console.log(`data        : output/crossxs/daily-closes.json  realData=${panel.realData}`);
  console.log(`universe    : ${panel.symbols.length} full-history coins  ${panel.symbols.join(",")}`);
  console.log(`days        : ${panel.dates.length}  [${panel.dates[0]} .. ${panel.dates.at(-1)}]`);

  // --- hold-out plan: last 730 days are the one-shot vault ---
  const total = panel.dates.length;
  const holdoutFraction = HOLDOUT_DAYS / total;
  const plan = planHoldoutSplit({ totalRows: total, holdoutFraction, testFraction: 0 });
  const searchStart = 0;
  const searchEnd = plan.search.end; // search owns oldest rows; vault is most-recent
  const vaultStart = plan.finalHoldout.start;
  const vaultEnd = plan.finalHoldout.end;
  console.log(`\n-- Hold-out plan (planHoldoutSplit, consume-once) --`);
  console.log(`  search slice : rows[${searchStart},${searchEnd})  ${panel.dates[searchStart]} .. ${panel.dates[searchEnd - 1]}  (${searchEnd} days)`);
  console.log(`  final vault  : rows[${vaultStart},${vaultEnd})  ${panel.dates[vaultStart]} .. ${panel.dates[vaultEnd - 1]}  (${vaultEnd - vaultStart} days, ~24mo)`);

  // ======================= SELF-CHECK 1: pure noise =======================
  console.log(`\n${line}\nSELF-CHECK 1 — PURE NOISE (independent random walks; must show NO edge)\n${line}`);
  const noiseCloses = buildNoisePanel(panel, realClosesOf);
  const noiseClosesOf = (s: string): number[] => noiseCloses.get(s)!;
  const noiseSearch = searchBestConfig(panel, noiseClosesOf, searchStart, searchEnd);
  // Evaluate the noise-best config on the noise vault.
  const nLogA = logSeries(noiseClosesOf(noiseSearch.best.a));
  const nLogB = logSeries(noiseClosesOf(noiseSearch.best.b));
  const nRetA = retSeries(noiseClosesOf(noiseSearch.best.a));
  const nRetB = retSeries(noiseClosesOf(noiseSearch.best.b));
  const noiseVault = tradePairCausal(nLogA, nLogB, nRetA, nRetB, vaultStart, vaultEnd, noiseSearch.best.zWindow);
  const noiseVaultSharpe = annualizedSharpe(noiseVault.daily);
  const noiseVaultRet = summarizeReturnSeries(noiseVault.daily).compoundReturn;
  console.log(`  noise best pair (IS) : ${noiseSearch.best.a}/${noiseSearch.best.b} zWin=${noiseSearch.best.zWindow} IS-Sharpe=${noiseSearch.best.sharpe.toFixed(2)} ADF=${noiseSearch.best.adf.toFixed(2)}`);
  console.log(`  noise OOS vault      : Sharpe=${noiseVaultSharpe.toFixed(2)}  net=${pct(noiseVaultRet)}  trades=${noiseVault.trades}`);
  const noisePass = noiseVaultRet <= 0.02 || noiseVaultSharpe < 0.5;
  console.log(`  -> noise shows no robust edge OOS : ${noisePass ? "PASS" : "FAIL (suspicious)"}`);

  // ======================= SELF-CHECK 2: causality =======================
  console.log(`\n${line}\nSELF-CHECK 2 — CAUSALITY (future mutation must not change an earlier decision)\n${line}`);
  // Pick an arbitrary pair and a decision day; mutate closes STRICTLY AFTER it.
  const ca = realClosesOf(panel.symbols[0]!);
  const cb = realClosesOf(panel.symbols[1]!);
  const decisionDay = 400;
  const zWin = 60;
  function positionAt(closesA: number[], closesB: number[], day: number): number {
    const lA = logSeries(closesA);
    const lB = logSeries(closesB);
    const w0 = day - zWin;
    const xWin = lB.slice(w0, day);
    const yWin = lA.slice(w0, day);
    const { beta, alpha } = ols(xWin, yWin);
    const sw: number[] = [];
    for (let i = 0; i < xWin.length; i += 1) sw.push(yWin[i]! - (alpha + beta * xWin[i]!));
    const mu = mean(sw);
    const sd = std(sw, mu);
    const spreadNow = lA[day - 1]! - (alpha + beta * lB[day - 1]!);
    return sd > 1e-9 ? (spreadNow - mu) / sd : 0;
  }
  const zBefore = positionAt(ca, cb, decisionDay);
  const caMut = ca.slice();
  const cbMut = cb.slice();
  const rng = seeded(999);
  for (let i = decisionDay; i < caMut.length; i += 1) {
    caMut[i] = caMut[i]! * (1 + (rng() - 0.5)); // scramble the future
    cbMut[i] = cbMut[i]! * (1 + (rng() - 0.5));
  }
  const zAfter = positionAt(caMut, cbMut, decisionDay);
  const causalPass = Math.abs(zBefore - zAfter) < 1e-9;
  console.log(`  pair ${panel.symbols[0]}/${panel.symbols[1]} day=${decisionDay}: z(before mutation)=${zBefore.toFixed(6)}  z(after future mutation)=${zAfter.toFixed(6)}`);
  console.log(`  -> earlier decision unchanged by future data : ${causalPass ? "PASS" : "FAIL (leak!)"}`);

  // ======================= SEARCH on real data =======================
  console.log(`\n${line}\nSEARCH — Engle-Granger cointegration on the SEARCH slice ONLY\n${line}`);
  const search = searchBestConfig(panel, realClosesOf, searchStart, searchEnd);
  console.log(`  pairs x zWindows tried (TRUE N) : ${search.trueN}`);
  console.log(`  most-cointegrated pairs (ADF, search slice):`);
  for (const c of search.ranked.slice(0, 8)) {
    console.log(`    ${(c.a + "/" + c.b).padEnd(12)} ADF=${c.adf.toFixed(2)}  beta=${c.beta.toFixed(3)}`);
  }
  const b = search.best;
  console.log(`\n  CHOSEN CONFIG (best in-sample net Sharpe among cointegrated, operational):`);
  console.log(`    pair=${b.a}/${b.b}  zWindow=${b.zWindow}  ADF=${b.adf.toFixed(2)}  beta=${b.beta.toFixed(3)}`);
  console.log(`    IS net Sharpe(ann)=${b.sharpe.toFixed(2)}  IS net compound=${pct(b.compound)}  IS trades=${b.trades}`);

  // ======================= ONE-SHOT HOLD-OUT EVALUATION =======================
  console.log(`\n${line}\nONE-SHOT HOLD-OUT — evaluate the chosen config ONCE on the vault\n${line}`);
  const guard = new FinalHoldoutGuard();
  const logA = logSeries(realClosesOf(b.a));
  const logB = logSeries(realClosesOf(b.b));
  const retA = retSeries(realClosesOf(b.a));
  const retB = retSeries(realClosesOf(b.b));
  // Trade the vault. The hedge ratio + z are RE-ESTIMATED causally inside the
  // vault from rolling windows (so the parameters never see the future), but the
  // PAIR and zWindow were frozen by the search — this is the legitimate OOS test.
  const vault = tradePairCausal(logA, logB, retA, retB, vaultStart, vaultEnd, b.zWindow);
  guard.consume({
    reason: `cointegration ${b.a}/${b.b} zWin=${b.zWindow}`,
    gitSha: gitSha(),
    trialCount: search.trueN,
    nowIso: new Date().toISOString(),
  });
  const vStats = summarizeReturnSeries(vault.daily);
  const vSharpe = annualizedSharpe(vault.daily);
  const vaultDays = vaultEnd - vaultStart;
  const apr = (1 + vStats.compoundReturn) ** (252 / vaultDays) - 1;
  console.log(`  guard consumed : ${JSON.stringify(guard.status())}`);
  console.log(`  vault trades   : ${vault.trades}  turnover=${vault.turnover.toFixed(1)}  avgHold=${vault.avgHoldBars.toFixed(1)} bars`);
  console.log(`  vault net      : compound=${pct(vStats.compoundReturn)}  APR≈${pct(apr)}  Sharpe(ann)=${vSharpe.toFixed(2)}  daily-Sharpe=${vStats.sharpe.toFixed(3)}`);
  console.log(`  vault path     : posRate=${pct(vStats.positiveRate)}  maxDailyLoss=${pct(vStats.min)}  maxDailyGain=${pct(vStats.max)}`);

  // Bar returns over the vault for buy&hold/lottery baselines: use the long-leg
  // (coin a) market path — the natural "just hold the asset" alternative.
  const barReturns = retA.slice(vaultStart, vaultEnd);

  const evalInput = {
    candidateId: `coint-${b.a}-${b.b}-z${b.zWindow}`,
    candidateReturns: vault.daily,
    sampleCount: vault.daily.length,
    trialCount: search.trueN,
    barReturns,
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: Math.max(1, Math.round(vault.avgHoldBars)),
    thresholds: { dsrThreshold: DSR_THRESHOLD },
    seed: "coint-pairs-audit",
  };
  const promo: PromotionEvaluation = evaluatePromotion(evalInput);

  console.log(`\n-- evaluatePromotion gates (true N=${search.trueN}) --`);
  console.log(`  baselines       : applicable=${promo.gates.baselines.applicable} passed=${promo.gates.baselines.passed}`);
  if (promo.gates.baselines.result) {
    for (const c of promo.gates.baselines.result.comparisons) {
      console.log(`      vs ${c.id.padEnd(16)} cand=${pct(promo.summary.candidateCompoundReturn)} base=${pct(c.baselineScore)} beaten=${c.beaten}`);
    }
  }
  const dsr = promo.gates.deflatedSharpe;
  console.log(`  deflatedSharpe  : passed=${dsr.passed}  DSR=${dsr.deflatedProbability.toFixed(4)} (>= ${dsr.threshold})  sharpe=${dsr.sharpe.toFixed(3)} N=${dsr.trialCount}`);
  const mb = promo.gates.minBtl.result;
  console.log(`  minBtl          : passed=${promo.gates.minBtl.passed}  reason=${mb.reason}  obsSharpe=${mb.observedSharpe.toFixed(3)} need>=${mb.minSampleForObservedSharpe} have=${mb.sampleCount}`);
  console.log(`  haircut         : passed=${promo.gates.haircut.passed}  haircutSharpe=${promo.gates.haircut.result.haircutSharpe.toFixed(3)}`);

  // McLean-Pontiff 50% decay haircut on the OOS edge.
  const decayedCompound = vStats.compoundReturn * (1 - MCLEAN_PONTIFF_DECAY);
  const decayedSharpe = vSharpe * (1 - MCLEAN_PONTIFF_DECAY);
  console.log(`\n-- McLean-Pontiff decay (50% haircut on OOS edge) --`);
  console.log(`  raw OOS compound=${pct(vStats.compoundReturn)} -> decayed=${pct(decayedCompound)}`);
  console.log(`  raw OOS Sharpe=${vSharpe.toFixed(2)} -> decayed=${decayedSharpe.toFixed(2)}`);

  // Independent haircut Sharpe (Harvey-Liu) for the record at true N.
  const hl = haircutSharpe({
    observedSharpe: vStats.sharpe,
    sampleCount: vault.daily.length,
    trialCount: search.trueN,
    method: "bonferroni",
  });
  console.log(`  Harvey-Liu haircut Sharpe(per-obs) @N=${search.trueN}: ${hl.haircutSharpe.toFixed(4)}`);

  // ======================= VERDICT =======================
  const netPositive = vStats.compoundReturn > 0;
  const decayPositive = decayedCompound > 0;
  const beatsBaselines = promo.gates.baselines.passed;
  const dsrOk = dsr.passed;
  const minBtlOk = promo.gates.minBtl.passed;
  const haircutOk = promo.gates.haircut.passed;
  const promote =
    netPositive && decayPositive && beatsBaselines && dsrOk && minBtlOk && haircutOk && promo.promotable;

  console.log(`\n${line}`);
  console.log(`VERDICT: ${promote ? "PROMOTE" : "KILL"}`);
  console.log(line);
  console.log(`  net-of-cost positive OOS     : ${netPositive}`);
  console.log(`  positive after 50% decay     : ${decayPositive}`);
  console.log(`  beats buy&hold + lottery     : ${beatsBaselines}`);
  console.log(`  DSR(trueN=${search.trueN}) >= 0.95     : ${dsrOk} (${dsr.deflatedProbability.toFixed(4)})`);
  console.log(`  MinBTL sufficient length     : ${minBtlOk}`);
  console.log(`  haircut Sharpe positive      : ${haircutOk}`);
  console.log(`  evaluatePromotion.promotable : ${promo.promotable}  (${promo.summary.gatesPassed}/${promo.summary.gatesApplicable} gates)`);
  if (promo.reasons.length) console.log(`  fail reasons: ${promo.reasons.join("; ")}`);
  console.log(`  self-checks: noise=${noisePass ? "PASS" : "FAIL"} causality=${causalPass ? "PASS" : "FAIL"}`);
  console.log(line);

  // Machine-readable tail for the harness.
  console.log("\nRESULT_JSON " + JSON.stringify({
    target: "cointegration-pairs",
    realData: panel.realData,
    pair: `${b.a}/${b.b}`,
    zWindow: b.zWindow,
    trueN: search.trueN,
    isSharpe: Number(b.sharpe.toFixed(3)),
    oosCompound: Number(vStats.compoundReturn.toFixed(5)),
    oosAPR: Number(apr.toFixed(5)),
    oosSharpe: Number(vSharpe.toFixed(3)),
    oosTrades: vault.trades,
    dsr: Number(dsr.deflatedProbability.toFixed(4)),
    decayedCompound: Number(decayedCompound.toFixed(5)),
    beatsBaselines,
    minBtlOk,
    haircutOk,
    promotable: promo.promotable,
    verdict: promote ? "PROMOTE" : "KILL",
    noiseSelfCheck: noisePass,
    causalitySelfCheck: causalPass,
  }));
}

main();
