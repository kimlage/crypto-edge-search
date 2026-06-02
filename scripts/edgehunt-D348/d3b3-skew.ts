/**
 * D3-B3 — 25-delta risk reversal / skew direction (strongest HONEST $0 build).
 *
 * THE ITEM: "put skew = fear → bearish or contrarian bottom." The contested claim
 * is DIRECTION. The non-contested part (skew prices the risk-neutral crash prob /
 * tail risk premium = selling rich tails) is already the EXCLUDED VRP items B5/B6.
 *
 * DATA REALITY: a genuine 25Δ risk-reversal RR25 = IV(25Δ put) − IV(25Δ call)
 * needs a POINT-IN-TIME IV-by-delta surface history (per-strike greeks). That is
 * PAID. Only the *current* Deribit chain is $0; honest history would need a
 * forward-record. So the literal per-delta directional signal CANNOT be tested
 * $0-on-history → DEFERRED is the honest data verdict.
 *
 * WHAT WE CAN DO $0 (and do here, to genuinely try): the model-free REALIZED
 * analogue of option skew. Option RR is driven by (a) a risk premium and (b)
 * realized asymmetry expectations. We build the best $0 realized-skew proxies
 * from 15m OHLCV — realized downside/upside semivariance & realized third-moment
 * (signed-jump) — which co-move with and lead RR in the literature, then test the
 * SAME two directional beliefs (contrarian + trend) the item makes. CONTROL: we
 * PARTIAL OUT the risk-premium leg (VRP = DVOL² − RV², the B5/B6 thing) and the
 * long-beta leg, so a surviving edge must be DIRECTIONAL residual, not the premium.
 *
 * NULL: stationary block bootstrap (preserves own autocorr of the skew proxy &
 * returns) + LEAD-LAG PLACEBO on a forward-recorded panel (every signal acts only
 * on strictly-future returns; we also scan ±lags and require the true lag>0 to beat
 * the placebo lags). Honest N counts every config (proxy × belief × lookback ×
 * lag × threshold).
 *
 * Judged with the committed gauntlet primitives (DSR @ honest N, block-bootstrap CI,
 * CSCV/PBO) from src/lib/training/statistical-validation.ts — the same ones the
 * D348 harness consumes. Realistic net-of-cost.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/d3b3-skew.ts
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

const ann = (s: number, ppy: number) => s * Math.sqrt(ppy);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

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
// stationary (geometric-block) bootstrap of paired (signal, fwdRet) rows: preserves
// joint autocorr while breaking nothing structural — used to get a null band on Sharpe
function pairedBlockBoot(rows: number[], blkMean: number, r: () => number): number[] {
  const n = rows.length;
  const out: number[] = [];
  while (out.length < n) {
    let s = Math.floor(r() * n);
    // geometric block length
    while (out.length < n) {
      out.push(rows[s % n]);
      s++;
      if (r() < 1 / blkMean) break;
    }
  }
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------
// Load $0 data: 15m OHLCV (full history) + DVOL daily + BTC daily close
// ---------------------------------------------------------------------------
type Bar = { t: number; date: string; o: number; h: number; l: number; c: number };
function loadOHLCV(): Bar[] {
  const lines = fs
    .readFileSync(path.join(ROOT, "output/bigquery/btc_ohlcv_15m.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean);
  const out: Bar[] = [];
  for (const ln of lines) {
    const j = JSON.parse(ln);
    out.push({
      t: Date.parse(j.event_time),
      date: j.event_date,
      o: +j.open,
      h: +j.high,
      l: +j.low,
      c: +j.close,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
const bars = loadOHLCV();

// DVOL daily (ATM-ish implied vol, annualized %). Use longest series (2021->).
const dvol = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/edgehunt/dvol_btc.json"), "utf8"),
) as { date: string; close: number }[];
const dvolByDate = new Map(dvol.map((x) => [x.date, x.close]));

// ---------------------------------------------------------------------------
// Build daily panel from 15m bars: daily close, realized down/up semivariance,
// realized third moment (signed jump) → REALIZED SKEW proxies (the $0 analogue of
// option skew). All computed from the SAME day's intraday 15m returns (then used
// only to predict STRICTLY-FUTURE daily returns → forward-record discipline).
// ---------------------------------------------------------------------------
type Day = {
  date: string;
  close: number;
  rDown: number; // downside realized semivariance (sum of negative 15m ret^2)
  rUp: number; // upside realized semivariance
  rv: number; // total realized variance (daily)
  rskew: number; // realized skewness (model-free third moment of 15m rets)
  semiSkew: number; // (rUp - rDown)/rv  ∈ [-1,1]; <0 => downside-heavy (≈ put-skew/fear)
};
function buildDays(): Day[] {
  const byDate = new Map<string, Bar[]>();
  for (const b of bars) {
    if (!byDate.has(b.date)) byDate.set(b.date, []);
    byDate.get(b.date)!.push(b);
  }
  const days: Day[] = [];
  for (const [date, db] of byDate) {
    if (db.length < 20) continue; // need enough intraday bars
    db.sort((a, b) => a.t - b.t);
    const rets: number[] = [];
    for (let i = 1; i < db.length; i++) rets.push(Math.log(db[i].c / db[i - 1].c));
    let rDown = 0;
    let rUp = 0;
    let m2 = 0;
    let m3 = 0;
    for (const x of rets) {
      if (x < 0) rDown += x * x;
      else rUp += x * x;
      m2 += x * x;
      m3 += x * x * x;
    }
    const n = rets.length;
    const rv = m2;
    const sd = Math.sqrt(m2 / n) || 1e-12;
    const rskew = (m3 / n) / (sd * sd * sd); // realized (intraday) skewness
    const semiSkew = rv > 0 ? (rUp - rDown) / rv : 0;
    days.push({ date, close: db[db.length - 1].c, rDown, rUp, rv, rskew, semiSkew });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}
const days = buildDays();

// daily log returns (close-to-close)
const dret: number[] = [0];
for (let i = 1; i < days.length; i++)
  dret.push(Math.log(days[i].close / days[i - 1].close));

// rolling 20d realized vol (annualized) for VRP partial-out
function rollRV(i: number, look: number): number | null {
  if (i - look < 0) return null;
  let s = 0;
  let c = 0;
  for (let k = i - look + 1; k <= i; k++) {
    s += dret[k] * dret[k];
    c++;
  }
  return c > 0 ? Math.sqrt((s / c) * 365) : null; // annualized stdev
}

// ---------------------------------------------------------------------------
// SIGNAL FAMILY (the honest realized-skew analogue of the RR25 directional claim).
// Two proxies that proxy option skew sign:
//   semiSkew  (<0 = downside-heavy realized = the "fear" / put-skew reading)
//   rskew     (<0 = left-skewed intraday = fear)
// Two beliefs the item explicitly states:
//   contrarian: fear (skew very negative) → BUY  (bottom-fishing)
//   trend:      fear → SELL / risk-off    (skew = leading bearishness)
// Each smoothed over lookback L; entered when crossing a z-threshold THR.
// Position acts on STRICTLY FUTURE return dret[i + LAG]  (forward-record).
// ---------------------------------------------------------------------------
const COST = 0.0006; // 6 bps round-trip taker on BTC perp/spot per position change (realistic)

type Cfg = {
  proxy: "semiSkew" | "rskew";
  belief: "contrarian" | "trend";
  L: number;
  thr: number;
  lag: number;
};
const PROXIES: Cfg["proxy"][] = ["semiSkew", "rskew"];
const BELIEFS: Cfg["belief"][] = ["contrarian", "trend"];
const LOOKS = [3, 5, 10, 20];
const THRS = [0.5, 1.0, 1.5]; // z-score entry thresholds
const LAGS = [1]; // true forward lag = next day (placebo will scan others)

function smoothZ(raw: number[], L: number, i: number): number | null {
  // z-score of L-day mean of the proxy vs its trailing 60d distribution
  if (i - L - 60 < 0) return null;
  let m = 0;
  for (let k = i - L + 1; k <= i; k++) m += raw[k];
  m /= L;
  // trailing distribution of L-day means
  const hist: number[] = [];
  for (let j = i - 60; j <= i; j++) {
    if (j - L + 1 < 0) continue;
    let mm = 0;
    for (let k = j - L + 1; k <= j; k++) mm += raw[k];
    hist.push(mm / L);
  }
  const hm = mean(hist);
  const hsd =
    Math.sqrt(hist.reduce((s, x) => s + (x - hm) * (x - hm), 0) / hist.length) || 1e-9;
  return (m - hm) / hsd;
}

function runConfig(c: Cfg, lagOverride?: number): { rows: { sig: number; fwd: number }[] } {
  const lag = lagOverride ?? c.lag;
  const raw = days.map((d) => (c.proxy === "semiSkew" ? d.semiSkew : d.rskew));
  const rows: { sig: number; fwd: number }[] = [];
  let prevPos = 0;
  for (let i = 0; i < days.length; i++) {
    const j = i + lag;
    if (j < 1 || j >= days.length) continue;
    const z = smoothZ(raw, c.L, i);
    if (z == null) continue;
    // "fear" = very negative skew proxy (downside-heavy). Signal magnitude = how far
    // below -thr (deeper fear = stronger). When not in fear, flat.
    let pos = 0;
    if (z < -c.thr) {
      pos = c.belief === "contrarian" ? +1 : -1; // contrarian buys fear, trend sells it
    } else if (z > c.thr) {
      // symmetric: extreme positive skew (greed/call-skew) → opposite
      pos = c.belief === "contrarian" ? -1 : +1;
    }
    const fwd = dret[j] ?? 0;
    let pnl = pos * fwd;
    if (pos !== prevPos) pnl -= COST; // cost on position change
    prevPos = pos;
    rows.push({ sig: pos, fwd });
    // store pnl in fwd slot reused later; keep both via closure below
    (rows[rows.length - 1] as any).pnl = pnl;
  }
  return { rows };
}
function pnlOf(rows: { sig: number; fwd: number }[]): number[] {
  return rows.map((r) => (r as any).pnl as number);
}

// ---------------------------------------------------------------------------
// CONTROL: partial out the RISK PREMIUM (VRP) + long-beta. We regress the
// strategy's daily PnL on (a) long-BTC return (beta) and (b) the VRP carry proxy
// vrp_t = (DVOL_t/100)^2/365 − RV20_t^2/365  (sign of the B5/B6 premium per day).
// The DIRECTIONAL residual = PnL − fitted(beta*ret + g*vrp). A real direction edge
// must keep Sharpe AFTER removing the premium+beta legs.
// ---------------------------------------------------------------------------
function vrpProxy(i: number): number | null {
  const d = days[i];
  const iv = dvolByDate.get(d.date);
  if (iv == null) return null;
  const rv = rollRV(i, 20);
  if (rv == null) return null;
  const ivVarDaily = Math.pow(iv / 100, 2) / 365;
  const rvVarDaily = Math.pow(rv, 2) / 365;
  return ivVarDaily - rvVarDaily; // >0 => implied richer than realized (sell-vol premium)
}
function residualizePnl(c: Cfg): {
  rawPnl: number[];
  resid: number[];
  beta: number;
  gVrp: number;
} {
  // rebuild with aligned indices so we can map back to day i for controls
  const lag = c.lag;
  const raw = days.map((d) => (c.proxy === "semiSkew" ? d.semiSkew : d.rskew));
  const Y: number[] = [];
  const Xret: number[] = [];
  const Xvrp: number[] = [];
  let prevPos = 0;
  for (let i = 0; i < days.length; i++) {
    const j = i + lag; // target return index (lag>0 = future = forward-record; <0 = placebo)
    if (j < 1 || j >= days.length) continue;
    const z = smoothZ(raw, c.L, i);
    if (z == null) continue;
    const vp = vrpProxy(i);
    if (vp == null) continue;
    let pos = 0;
    if (z < -c.thr) pos = c.belief === "contrarian" ? +1 : -1;
    else if (z > c.thr) pos = c.belief === "contrarian" ? -1 : +1;
    const fwd = dret[j] ?? 0;
    let pnl = pos * fwd;
    if (pos !== prevPos) pnl -= COST;
    prevPos = pos;
    Y.push(pnl);
    Xret.push(fwd); // long-beta regressor (forward BTC return)
    Xvrp.push(vp); // risk-premium regressor
  }
  // OLS Y ~ b*Xret + g*Xvrp (+ intercept), then residual = Y - (b*Xret + g*Xvrp)
  const n = Y.length;
  const cols = [new Array(n).fill(1), Xret, Xvrp];
  // normal equations 3x3
  const A: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bvec = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      bvec[a] += cols[a][i] * Y[i];
      for (let b = 0; b < 3; b++) A[a][b] += cols[a][i] * cols[b][i];
    }
  }
  const coef = solve3(A, bvec);
  const resid = Y.map((y, i) => y - (coef[1] * Xret[i] + coef[2] * Xvrp[i]));
  return { rawPnl: Y, resid, beta: coef[1], gVrp: coef[2] };
}
function solve3(A: number[][], b: number[]): number[] {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i] || 1e-12;
    for (let j = i; j < 4; j++) M[i][j] /= d;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = M[k][i];
      for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

// ---------------------------------------------------------------------------
// SEARCH all configs; pick best by net Sharpe of the DIRECTIONAL RESIDUAL
// (premium+beta partialled out). honest N = every config.
// ---------------------------------------------------------------------------
const PPY = 365;
const configs: Cfg[] = [];
for (const proxy of PROXIES)
  for (const belief of BELIEFS)
    for (const L of LOOKS)
      for (const thr of THRS) for (const lag of LAGS) configs.push({ proxy, belief, L, thr, lag });

const honestN = configs.length;
let best: {
  cfg: Cfg;
  rawSharpe: number;
  residSharpe: number;
  beta: number;
  gVrp: number;
  rawPnl: number[];
  resid: number[];
} | null = null;
const allRows: { cfg: Cfg; rawSharpe: number; residSharpe: number }[] = [];
for (const c of configs) {
  const { rows } = runConfig(c);
  if (rows.length < 100) continue;
  const rawSharpe = ann(sharpe(pnlOf(rows)), PPY);
  const { rawPnl, resid, beta, gVrp } = residualizePnl(c);
  const residSharpe = ann(sharpe(resid), PPY);
  allRows.push({ cfg: c, rawSharpe, residSharpe });
  // select on the RESIDUAL (the directional part), since the premium part is B5/B6
  if (!best || residSharpe > best.residSharpe)
    best = { cfg: c, rawSharpe, residSharpe, beta, gVrp, rawPnl, resid };
}

if (!best) {
  console.log(JSON.stringify({ error: "no config produced enough rows" }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// NULL 1: stationary block bootstrap on the best config's directional residual.
// ---------------------------------------------------------------------------
const rboot = rng(101);
const bootSh: number[] = [];
for (let it = 0; it < 1000; it++) {
  const bs = pairedBlockBoot(best.resid, 5, rboot);
  bootSh.push(ann(sharpe(bs), PPY));
}
bootSh.sort((a, b) => a - b);
// block-bootstrap CI of residual mean (committed primitive)
const ci = blockBootstrapConfidenceInterval(best.resid, {
  statistic: "sharpe",
  iterations: 2000,
  blockLength: 5,
  seed: "d3b3",
});

// ---------------------------------------------------------------------------
// NULL 2: LEAD-LAG PLACEBO on forward-recorded panel. The true signal must act on
// the next-day return (lag=+1). Re-run the SAME config at placebo lags
// {-5..-1, +2..+6}; under a real lead the true lag should dominate the placebo
// lags. p = fraction of placebo lags whose |residual Sharpe| >= true.
// ---------------------------------------------------------------------------
function residSharpeAtLag(c: Cfg, lag: number): number {
  const cc = { ...c, lag };
  const { resid } = residualizePnl(cc);
  return ann(sharpe(resid), PPY);
}
const trueLagSh = residSharpeAtLag(best.cfg, 1);
const placeboLags = [-5, -4, -3, -2, -1, 2, 3, 4, 5, 6];
const placeboShs = placeboLags.map((l) => residSharpeAtLag(best.cfg, l));
const placeboP =
  placeboShs.filter((s) => Math.abs(s) >= Math.abs(trueLagSh)).length / placeboShs.length;

// bootstrap p on residual: fraction of block-boot Sharpes >= true (one-sided)
const bootP = bootSh.filter((x) => x >= best.residSharpe).length / bootSh.length;

// ---------------------------------------------------------------------------
// CSCV / PBO across configs (committed primitive). Build strategy×fold matrix:
// each config = a strategy, folds = contiguous time blocks of its residual PnL.
// We need equal-length residual series; align on the shortest.
// ---------------------------------------------------------------------------
const residSeries: { name: string; series: number[] }[] = [];
for (const c of configs) {
  const { resid } = residualizePnl(c);
  if (resid.length >= 200) residSeries.push({ name: JSON.stringify(c), series: resid });
}
const minLen = Math.min(...residSeries.map((s) => s.series.length));
const NFOLDS = 8;
const foldLen = Math.floor(minLen / NFOLDS);
const strategyFolds = residSeries.map((s) => {
  const aligned = s.series.slice(s.series.length - foldLen * NFOLDS);
  const folds: number[][] = [];
  for (let f = 0; f < NFOLDS; f++) folds.push(aligned.slice(f * foldLen, (f + 1) * foldLen));
  return { id: s.name, folds };
});
let pbo: number | null = null;
let pboNote = "";
try {
  const res = estimateCscvPbo(strategyFolds, { statistic: "sharpe" });
  pbo = res.pbo;
  pboNote = `nStrategies=${strategyFolds.length}, folds=${NFOLDS}, splits=${res.splitCount}`;
} catch (e) {
  pboNote = `PBO failed: ${(e as Error).message}`;
}

// ---------------------------------------------------------------------------
// Gauntlet: DSR @ honest N on the directional residual + the RAW (pre-control) too.
// ---------------------------------------------------------------------------
const dsrResid = computeDeflatedSharpeRatio(best.resid, { trialCount: honestN });
const dsrRaw = computeDeflatedSharpeRatio(best.rawPnl, { trialCount: honestN });

// Harvey-Liu style haircut: deflate t-stat by sqrt(honestN) (Bonferroni-ish)
const residStats = summarizeReturnSeries(best.resid);
const tStat = residStats.sharpe * Math.sqrt(best.resid.length);
const haircutT = tStat / Math.sqrt(honestN);

// monthly return @ $100k on the RAW tradable PnL (residual is not directly tradable;
// the raw config is what you'd actually run if it survived). Use raw mean daily.
const rawMeanDaily = mean(best.rawPnl);
const monthlyPct = (Math.pow(1 + rawMeanDaily, 365 / 12) - 1) * 100;
const monthlyDollar = (monthlyPct / 100) * 100000;

// Baseline: does residual beat buy-and-hold Sharpe? (long-beta already removed, so
// residual SHOULD be ~beta-neutral; report B&H for context.)
const bhSh = ann(sharpe(dret.slice(1)), PPY);

const summary = {
  item: "D3-B3 25-delta risk reversal / skew direction",
  dataHonesty:
    "PER-DELTA IV / RR25 surface history is PAID (forward-record only). Tested the strongest $0 REALIZED-SKEW analogue (intraday semivariance + realized third moment from 15m OHLCV) as a stand-in for the directional claim, with the VRP risk-premium + long-beta partialled out.",
  nDays: days.length,
  dvolCoverageDays: days.filter((d) => dvolByDate.has(d.date)).length,
  honestN_configs: honestN,
  best: {
    config: best.cfg,
    rawNetSharpeAnn: best.rawSharpe,
    directionalResidualSharpeAnn: best.residSharpe,
    longBeta_partialledOut: best.beta,
    vrpLoading_partialledOut: best.gVrp,
    nObs: best.resid.length,
  },
  controls: {
    note: "residual = PnL − beta*fwdRet − g*VRP. A real DIRECTION edge must keep Sharpe after the premium(B5/B6)+beta legs are removed.",
    rawMinusResidualSharpeDrop: best.rawSharpe - best.residSharpe,
  },
  nulls: {
    blockBootstrap_p_residual: bootP,
    blockBootstrap_residualSharpe_CI: { lower: ci.lower, upper: ci.upper, estimate: ci.estimate },
    leadLagPlacebo_p: placeboP,
    trueLagResidualSharpe: trueLagSh,
    placeboLagResidualSharpes: Object.fromEntries(placeboLags.map((l, i) => [l, placeboShs[i]])),
  },
  gauntlet: {
    DSR_residual_p: dsrResid.deflatedProbability,
    DSR_residual_expMaxSharpe: dsrResid.expectedMaxSharpe,
    DSR_raw_p: dsrRaw.deflatedProbability,
    PBO: pbo,
    PBO_note: pboNote,
    harveyLiu_tStat_raw: tStat,
    harveyLiu_tStat_haircut: haircutT,
  },
  economics: {
    rawNetSharpeAnn: best.rawSharpe,
    buyHoldSharpeAnn: bhSh,
    monthlyReturnPct_raw: monthlyPct,
    monthlyDollar_at100k: monthlyDollar,
    costRoundTrip_bps: COST * 1e4,
  },
};

fs.writeFileSync(path.join(OUT, "d3b3-skew.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
