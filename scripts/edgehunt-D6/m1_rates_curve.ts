/**
 * D6-M1 — BTC vs US rates / 2s10s yield-curve regime timer.
 *
 * Belief: hawkish Fed bad for BTC; curve regime-shifts BTC (risk-on/off). Long BTC when real/nominal
 * rates are FALLING and/or the curve is STEEPENING (risk-on); reduce when hawkish (rates rising,
 * curve flattening/inverting). We build the strongest HONEST version and judge it with the committed
 * gauntlet (net-of-cost, baselines incl. buy&hold + AR-matched-rate placebo, Deflated Sharpe @
 * HONEST N = macro regimes, CPCV/PBO, Harvey-Liu haircut, the RIGHT surrogate null, consume-once
 * out-of-regime holdout). KEY control = macro-beta neutralization (orthogonalize PnL vs SPX): if the
 * "edge" is just risk-on/off beta it must vanish.
 *
 * STRICT CAUSALITY: every rate level / change / slope is taken as KNOWN AT t-1 (we lag the daily
 * FRED series by one extra day on top of FRED's own publication lag, and forward-fill across
 * weekends/holidays). Position is set from t-1 info and earns return_t (BTC spot close t-1 -> t).
 *
 * Data ($0, FRED no-key CSV, confirmed reachable): DGS2, DGS10, T10Y2Y, SP500. BTC daily spot close
 * from output/funding/BTCUSDT_prices_daily.json (2023-06-01..2026-05-31).
 *
 * The RIGHT null for a slow macro timer:
 *   (a) AR-matched-rate placebo: refit an AR(1) to each rate series' daily changes, simulate a
 *       surrogate path with the SAME persistence + innovation vol, rebuild the timer on it. If the
 *       timer makes money on AR-matched noise rates as often as on the real ones, there is no edge.
 *   (b) SPX-beta neutralization: regress the strategy's daily PnL on same-day SPX returns and keep
 *       the residual. "Coincident risk beta" (the prior KILL mechanism, and how NC died) is removed.
 *       The edge must survive on the residual, not just ride risk-on/off.
 *   (c) Out-of-regime holdout: consume-once tail (last 25%, a distinct rate regime) — the strategy
 *       is selected in-sample and must still work OOS.
 *
 * Honest N: rates move in ~2-4 macro regimes over this 3y window (hiking-plateau 2023, pivot/cut
 * expectations 2024, higher-for-longer / re-acceleration 2025-26). The effective number of
 * independent macro "bets" is tiny, NOT ~1000 daily obs. DSR trialCount is set to the number of
 * configs tried (the honest selection cost); the binding "honest N" reported is the macro-regime
 * count used to gauge whether ANY edge is even estimable.
 *
 * Realistic cost: 4 bps taker per side (COST_PER_SIDE). Low turnover (regime flips) is the point.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);

// ----------------------------------------------------------------- utils
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
};
const sharpeDaily = (a: number[]) => {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
};
const annSh = (a: number[]) => sharpeDaily(a) * ANN;
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalCdf(z: number): number {
  // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}
const round = (x: number, n = 4) => {
  const f = 10 ** n;
  return Math.round(x * f) / f;
};

// ----------------------------------------------------------------- data load
function loadFredCsv(id: string): Map<string, number> {
  const txt = fs.readFileSync(`${ROOT}/output/edgehunt-D6/${id}.csv`, "utf8");
  const m = new Map<string, number>();
  const lines = txt.trim().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const [d, v] = lines[i].split(",");
    const x = Number(v);
    if (d && Number.isFinite(x)) m.set(d, x);
  }
  return m;
}
function loadBtc(): { dates: string[]; close: number[] } {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/BTCUSDT_prices_daily.json`, "utf8"));
  const dates: string[] = [];
  const close: number[] = [];
  for (const r of j) {
    if (r.spotClose > 0) {
      dates.push(r.date);
      close.push(Number(r.spotClose));
    }
  }
  return { dates, close };
}

// Forward-fill a FRED daily series onto the BTC calendar: value for date d = most recent FRED
// observation on or before d. This is the value KNOWN as of close d (FRED already publishes with a
// lag; we additionally lag by one trading day below for the t-1 rule).
function alignFwdFill(btcDates: string[], src: Map<string, number>): number[] {
  const out = new Array(btcDates.length).fill(NaN);
  const srcDates = [...src.keys()].sort();
  let j = 0;
  let last = NaN;
  for (let i = 0; i < btcDates.length; i++) {
    while (j < srcDates.length && srcDates[j] <= btcDates[i]) {
      last = src.get(srcDates[j])!;
      j++;
    }
    out[i] = last;
  }
  return out;
}

// ----------------------------------------------------------------- aligned panel
interface Panel {
  dates: string[];
  close: number[];
  fwdRet: number[]; // log return close[t] -> close[t+1]; last = NaN. Earned by position[t].
  spxRet: number[]; // same-day SPX log return (for beta neutralization), aligned to fwdRet[t]
  dgs2: number[]; // KNOWN at close t (forward-filled)
  dgs10: number[];
  slope: number[]; // T10Y2Y
}

function buildPanel(): Panel {
  const btc = loadBtc();
  const dgs2 = alignFwdFill(btc.dates, loadFredCsv("DGS2"));
  const dgs10 = alignFwdFill(btc.dates, loadFredCsv("DGS10"));
  const slope = alignFwdFill(btc.dates, loadFredCsv("T10Y2Y"));
  const spx = alignFwdFill(btc.dates, loadFredCsv("SP500"));
  const T = btc.close.length;
  const fwdRet = new Array(T).fill(NaN);
  for (let t = 0; t + 1 < T; t++) fwdRet[t] = Math.log(btc.close[t + 1] / btc.close[t]);
  // same-day SPX log return aligned to the BTC fwd window: spx return over (t -> t+1)
  const spxRet = new Array(T).fill(NaN);
  for (let t = 0; t + 1 < T; t++) {
    if (spx[t] > 0 && spx[t + 1] > 0) spxRet[t] = Math.log(spx[t + 1] / spx[t]);
    else spxRet[t] = 0; // weekend: SPX flat, BTC trades; treat as 0 SPX return that day
  }
  return { dates: btc.dates, close: btc.close, fwdRet, spxRet, dgs2, dgs10, slope };
}

// ----------------------------------------------------------------- signals (strict t-1)
//
// All features use values KNOWN AT t-1 (we read index t-1 of the forward-filled FRED series and
// changes ending at t-1) to set position[t] that earns fwdRet[t].
//
//   levelDir   : sign of "rates falling" using nominal level vs its own trailing average.
//   chgMom     : sign of "rates falling" using the change of DGS10 over `mom` days ending t-1.
//   slopeLevel : curve steep (slope above its trailing average) => risk-on.
//   slopeMom   : curve steepening (change of slope over `mom` days ending t-1) => risk-on.
//
// Strategy = long-only timer (long when risk-on, flat/half when hawkish) — the honest "macro timer"
// form. A long/short variant is also tested.

function smaPrev(x: number[], t: number, win: number): number {
  // trailing average over [t-win+1 .. t]; returns NaN if insufficient/invalid
  if (t - win + 1 < 0) return NaN;
  let s = 0;
  for (let k = t - win + 1; k <= t; k++) {
    if (!Number.isFinite(x[k])) return NaN;
    s += x[k];
  }
  return s / win;
}

interface Cfg {
  signal: "rateChg" | "slopeMom" | "combo" | "rateLevel" | "slopeLevel";
  mom: number; // lookback (trading days) for change/level reference
  mode: "longflat" | "longshort" | "longhalf";
  [k: string]: number | string;
}

// Build position[] of length T. position[t] earns fwdRet[t], computed from info at t-1.
function buildPosition(P: Panel, cfg: Cfg): number[] {
  const T = P.close.length;
  const pos = new Array(T).fill(0);
  const flat = cfg.mode === "longshort" ? -1 : cfg.mode === "longhalf" ? 0.5 : 0;
  const mom = cfg.mom;
  for (let t = 1; t < T; t++) {
    const i = t - 1; // info index (t-1): strictly causal
    let riskOn: number; // +1 risk-on, -1 hawkish, NaN unknown
    if (cfg.signal === "rateChg") {
      // rates FALLING over the last `mom` days ending t-1 => risk-on (+1)
      if (i - mom < 0) {
        riskOn = NaN;
      } else {
        const dr = P.dgs10[i] - P.dgs10[i - mom];
        riskOn = Number.isFinite(dr) ? (dr < 0 ? 1 : -1) : NaN;
      }
    } else if (cfg.signal === "rateLevel") {
      // nominal 10Y below its trailing-`mom` average => easy regime => risk-on
      const avg = smaPrev(P.dgs10, i, mom);
      riskOn = Number.isFinite(avg) ? (P.dgs10[i] < avg ? 1 : -1) : NaN;
    } else if (cfg.signal === "slopeMom") {
      // curve STEEPENING over last `mom` days ending t-1 => risk-on
      if (i - mom < 0) {
        riskOn = NaN;
      } else {
        const ds = P.slope[i] - P.slope[i - mom];
        riskOn = Number.isFinite(ds) ? (ds > 0 ? 1 : -1) : NaN;
      }
    } else if (cfg.signal === "slopeLevel") {
      // curve steeper than its trailing average => risk-on
      const avg = smaPrev(P.slope, i, mom);
      riskOn = Number.isFinite(avg) ? (P.slope[i] > avg ? 1 : -1) : NaN;
    } else {
      // combo: long only when (rates falling) AND/OR (curve steepening). Use OR-of-risk-on with a
      // hawkish override: hawkish only if BOTH say hawkish (the strongest "lean long" honest form).
      let rOn: number, sOn: number;
      if (i - mom < 0) {
        rOn = NaN;
        sOn = NaN;
      } else {
        const dr = P.dgs10[i] - P.dgs10[i - mom];
        const ds = P.slope[i] - P.slope[i - mom];
        rOn = Number.isFinite(dr) ? (dr < 0 ? 1 : -1) : NaN;
        sOn = Number.isFinite(ds) ? (ds > 0 ? 1 : -1) : NaN;
      }
      if (!Number.isFinite(rOn) || !Number.isFinite(sOn)) riskOn = NaN;
      else riskOn = rOn > 0 || sOn > 0 ? 1 : -1; // OR risk-on
    }
    if (!Number.isFinite(riskOn)) {
      pos[t] = NaN;
      continue;
    }
    pos[t] = riskOn > 0 ? 1 : flat;
  }
  return pos;
}

// AR(1)-matched-rate surrogate: simulate a surrogate DGS10 & slope path with the same persistence
// of daily changes and innovation vol, rebuild the timer on it (preserving the REAL BTC return path
// and the REAL warmup). This is the AR-matched-rate placebo. If the timer earns as much on
// AR-matched noise rates, the rate signal carries no information.
function ar1Fit(series: number[]): { phi: number; sigma: number; level0: number } {
  const ch: number[] = [];
  for (let t = 1; t < series.length; t++) {
    if (Number.isFinite(series[t]) && Number.isFinite(series[t - 1])) ch.push(series[t] - series[t - 1]);
  }
  // AR(1) on the change series
  let num = 0,
    den = 0;
  const m = mean(ch);
  for (let t = 1; t < ch.length; t++) {
    num += (ch[t] - m) * (ch[t - 1] - m);
    den += (ch[t - 1] - m) ** 2;
  }
  const phi = den > 1e-12 ? num / den : 0;
  // innovation vol
  const resid: number[] = [];
  for (let t = 1; t < ch.length; t++) resid.push(ch[t] - m - phi * (ch[t - 1] - m));
  const sigma = std(resid);
  const level0 = series.find((v) => Number.isFinite(v)) ?? 0;
  return { phi, sigma, level0, mu: m } as any;
}
function ar1Sim(fit: any, T: number, rng: () => number): number[] {
  // gaussian via Box-Muller from the uniform rng
  const gauss = () => {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const out = new Array(T).fill(0);
  let lvl = fit.level0;
  let prevCh = 0;
  out[0] = lvl;
  for (let t = 1; t < T; t++) {
    const ch = fit.mu + fit.phi * (prevCh - fit.mu) + fit.sigma * gauss();
    lvl += ch;
    out[t] = lvl;
    prevCh = ch;
  }
  return out;
}
function buildSurrogatePosition(P: Panel, cfg: Cfg, rng: () => number): number[] {
  const T = P.close.length;
  const fitR = ar1Fit(P.dgs10);
  const fitS = ar1Fit(P.slope);
  const sDgs10 = ar1Sim(fitR, T, rng);
  const sSlope = ar1Sim(fitS, T, rng);
  const sP: Panel = { ...P, dgs10: sDgs10, slope: sSlope };
  return buildPosition(sP, cfg);
}

// ----------------------------------------------------------------- backtest
interface Bt {
  net: number[]; // daily net returns
  gross: number[];
  netResid: number[]; // SPX-beta-neutralized daily net (residual after regressing on spxRet)
  turnover: number;
  exposure: number;
  longShare: number;
  n: number;
}
function runPositions(P: Panel, pos: number[], lo: number, hi: number): Bt {
  const net: number[] = [];
  const gross: number[] = [];
  const spxAligned: number[] = [];
  let prev = 0;
  let turn = 0,
    exp = 0,
    longC = 0;
  for (let t = lo; t < hi; t++) {
    const fr = P.fwdRet[t];
    const p = pos[t];
    if (!Number.isFinite(fr) || !Number.isFinite(p)) continue;
    const dturn = Math.abs(p - prev);
    const g = p * fr;
    gross.push(g);
    net.push(g - dturn * COST_PER_SIDE);
    spxAligned.push(Number.isFinite(P.spxRet[t]) ? P.spxRet[t] : 0);
    turn += dturn;
    exp += Math.abs(p);
    if (p > 0) longC++;
    prev = p;
  }
  const n = net.length;
  // SPX-beta neutralization: residual = net - beta*spx (beta from OLS of net on spx)
  const mS = mean(spxAligned);
  const mN = mean(net);
  let cov = 0,
    varS = 0;
  for (let k = 0; k < n; k++) {
    cov += (spxAligned[k] - mS) * (net[k] - mN);
    varS += (spxAligned[k] - mS) ** 2;
  }
  const beta = varS > 1e-12 ? cov / varS : 0;
  const netResid = net.map((v, k) => v - beta * spxAligned[k]);
  return {
    net,
    gross,
    netResid,
    turnover: n ? turn / n : 0,
    exposure: n ? exp / n : 0,
    longShare: n ? longC / n : 0,
    n,
  };
}

function toFolds(s: number[], k: number): number[][] {
  const f: number[][] = [];
  const sz = Math.floor(s.length / k);
  for (let i = 0; i < k; i++) f.push(s.slice(i * sz, i === k - 1 ? s.length : (i + 1) * sz));
  return f;
}

// ----------------------------------------------------------------- gauntlet
const P = buildPanel();
const T = P.close.length;
// warmup: max lookback used; first tradable index
const MAXMOM = 126;
const startIdx = MAXMOM + 2;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const HOLDOUT_FRAC = 0.25; // out-of-regime tail
const splitIdx = startIdx + Math.floor(span * (1 - HOLDOUT_FRAC));

// Honest config grid (the honest N for DSR = number of configs tried = the selection cost).
const signals: Cfg["signal"][] = ["rateChg", "rateLevel", "slopeMom", "slopeLevel", "combo"];
const moms = [21, 42, 63, 126];
const modes: Cfg["mode"][] = ["longflat", "longhalf", "longshort"];
const configs: Cfg[] = [];
for (const signal of signals)
  for (const mom of moms) for (const mode of modes) configs.push({ signal, mom, mode });
const HONEST_N = configs.length;
// Macro-regime honest N (the number of independent macro bets in this 3y window).
const MACRO_N = 3;

// canonical pre-registered config: the thesis as written — long when rates falling and/or curve
// steepening, low turnover (63d), long-flat (a pure long-biased macro timer).
const canonical: Cfg = { signal: "combo", mom: 63, mode: "longflat" };

// score every config in-sample on net Sharpe (selection that DSR must correct for)
const scored = configs.map((cfg) => {
  const pos = buildPosition(P, cfg);
  const res = runPositions(P, pos, startIdx, splitIdx);
  return { cfg, pos, res, netSh: annSh(res.net), residSh: annSh(res.netResid) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestNet = best.res.net;
const bestResid = best.res.netResid;

// baselines: buy&hold, random-lottery (matched exposure)
const bhPos = new Array(T).fill(1);
const bh = runPositions(P, bhPos, startIdx, splitIdx);
const bhSh = annSh(bh.net);
const exposure = best.res.exposure;
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(424242 + i * 2654435761);
  const pos = new Array(T).fill(0);
  for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
  rlSh.push(annSh(runPositions(P, pos, startIdx, splitIdx).net));
}
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

// Deflated Sharpe @ honest N (= configs tried)
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;

// block bootstrap CI on mean daily net (autocorrelation-honest, slow macro -> long blocks)
const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 30,
  confidenceLevel: 0.95,
  seed: "d6m1-bb",
});
const bbPass = bb.lower > 0;

// CSCV / PBO across all configs
const cscv = scored.map((s) => ({ id: `${s.cfg.signal}-${s.cfg.mom}-${s.cfg.mode}`, folds: toFolds(s.res.net, 6) }));
let pbo = { pbo: 1, medianLogit: 0 };
try {
  const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
} catch {}
const pboPass = pbo.pbo < 0.5;

// Harvey-Liu (Bonferroni) haircut on the single-test p-value
function zSharpe(r: number[]): number {
  const n = r.length;
  if (n < 2) return 0;
  return sharpeDaily(r) * Math.sqrt(n);
}
const psrP = 1 - normalCdf(zSharpe(bestNet));
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// RIGHT surrogate null: AR-matched-rate placebo (best config)
const nSurr = 400;
const surr: number[] = [];
for (let i = 0; i < nSurr; i++) {
  const rng = mkRng(7000 + i * 7919);
  const pos = buildSurrogatePosition(P, best.cfg, rng);
  surr.push(annSh(runPositions(P, pos, startIdx, splitIdx).net));
}
surr.sort((a, b) => a - b);
const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);
const surrPass = surrP < 0.05;

// KEY control: SPX-beta-neutralized edge. The residual Sharpe must stay positive & beat the
// AR-matched placebo on the residual too (otherwise the edge is coincident risk beta).
const surrResid: number[] = [];
for (let i = 0; i < nSurr; i++) {
  const rng = mkRng(13000 + i * 7919);
  const pos = buildSurrogatePosition(P, best.cfg, rng);
  surrResid.push(annSh(runPositions(P, pos, startIdx, splitIdx).netResid));
}
surrResid.sort((a, b) => a - b);
const residSh = annSh(bestResid);
const surrResidP = (surrResid.filter((s) => s >= residSh).length + 1) / (nSurr + 1);
const betaNeutralPass = residSh > 0 && surrResidP < 0.05;

// consume-once out-of-regime holdout (best cfg only)
const hold = runPositions(P, best.pos, splitIdx, tradableEnd);
const holdSh = annSh(hold.net);
const holdResidSh = annSh(hold.netResid);
const holdoutPass = holdSh > 0;

// canonical (N=1) diagnostics
const canonPos = buildPosition(P, canonical);
const canonRes = runPositions(P, canonPos, startIdx, splitIdx);
const canonSh = annSh(canonRes.net);
const canonSurr: number[] = [];
for (let i = 0; i < nSurr; i++) {
  const rng = mkRng(99000 + i * 7919);
  canonSurr.push(annSh(runPositions(P, buildSurrogatePosition(P, canonical, rng), startIdx, splitIdx).net));
}
canonSurr.sort((a, b) => a - b);
const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
const canonHold = annSh(runPositions(P, canonPos, splitIdx, tradableEnd).net);

// assemble gates
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: {
    pass: mean(bestNet) > 0,
    detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(4)} exposure=${best.res.exposure.toFixed(3)}`,
  },
  baselines: {
    pass: baselinePass,
    detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}`,
  },
  beta_neutral: {
    pass: betaNeutralPass,
    detail: `SPX-neutral residSh=${residSh.toFixed(3)} residPlaceboP=${surrResidP.toFixed(4)} (edge must survive removing coincident SPX beta)`,
  },
  deflated_sharpe: {
    pass: dsrPass,
    detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} | macroN=${MACRO_N}`,
  },
  block_bootstrap: {
    pass: bbPass,
    detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
  },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
  haircut: {
    pass: haircutPass,
    detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})`,
  },
  surrogate: {
    pass: surrPass,
    detail: `AR-matched-rate placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
  },
  holdout: {
    pass: holdoutPass,
    detail: `OOS(out-of-regime) netSh=${holdSh.toFixed(3)} residSh=${holdResidSh.toFixed(3)} over ${hold.n} rows`,
  },
};

const order = [
  "net_of_cost",
  "baselines",
  "beta_neutral",
  "deflated_sharpe",
  "block_bootstrap",
  "cpcv_pbo",
  "haircut",
  "surrogate",
  "holdout",
];
let binding = "none";
for (const g of order)
  if (!gates[g].pass) {
    binding = g;
    break;
  }
const allPass = binding === "none";
const survivesCore =
  gates.net_of_cost.pass &&
  gates.baselines.pass &&
  gates.beta_neutral.pass &&
  gates.surrogate.pass &&
  gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";

// monthly $ on $100k at best net Sharpe (only meaningful if it beats B&H)
const monthlyMean = mean(bestNet) * 21;
const monthlyAt100k = baselinePass && best.netSh > 0 ? Math.round(monthlyMean * 100000) : null;

const out = {
  task: "D6-M1 BTC vs US rates / 2s10s yield-curve regime timer",
  window: `${P.dates[startIdx]}..${P.dates[tradableEnd]} (in-sample to ${P.dates[splitIdx]}, out-of-regime holdout tail ${(HOLDOUT_FRAC * 100).toFixed(0)}%)`,
  honestN_configs: HONEST_N,
  macroRegimeN: MACRO_N,
  best: {
    cfg: best.cfg,
    netSharpeAnn: round(best.netSh, 3),
    residSharpeAnn: round(residSh, 3),
    turnover: round(best.res.turnover, 4),
    exposure: round(best.res.exposure, 3),
    longShare: round(best.res.longShare, 3),
    inSampleDays: best.res.n,
  },
  baselineBuyHoldSharpe: round(bhSh, 3),
  canonical: {
    cfg: canonical,
    netSharpeAnn: round(canonSh, 3),
    surrogateP: round(canonSurrP, 4),
    holdoutSharpeAnn: round(canonHold, 3),
  },
  gates,
  bindingGate: binding,
  verdict,
  surrogateP: round(surrP, 4),
  holdoutSharpeAnn: round(holdSh, 3),
  monthlyAt100k,
};
fs.writeFileSync(`${ROOT}/output/edgehunt-D6/m1_result.json`, JSON.stringify(out, null, 2));

const monthlyStr = monthlyAt100k == null ? "n/a" : `$${monthlyAt100k}`;
console.log(JSON.stringify(out.gates, null, 2));
console.log(
  `\nbest cfg: ${JSON.stringify(best.cfg)} | netSh=${best.netSh.toFixed(3)} residSh(SPX-neutral)=${residSh.toFixed(3)} B&H=${bhSh.toFixed(3)} turnover=${best.res.turnover.toFixed(4)}`,
);
console.log(
  `canonical(thesis): netSh=${canonSh.toFixed(3)} surrP=${canonSurrP.toFixed(4)} holdoutSh=${canonHold.toFixed(3)}`,
);
console.log(
  `\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${MACRO_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthlyStr} | confidence ${verdict === "KILL" ? "high" : "med"}`,
);
