/**
 * D4-M3 — 52-week-high nearness (anchoring). George & Hwang 2004.
 *
 * Belief: nearness to the 52-week high (close / rolling-52w-high) predicts the
 * cross-section of returns better than past returns (anchoring under-reaction).
 *
 * Strongest honest build:
 *   - Signal per coin per week: nearness = close / max(close over trailing 364d).
 *     Range (0,1]; 1.0 = at the 52w high. Long the nearest-to-high.
 *   - A coin enters the rankable universe in a given week ONLY once it has >=364
 *     prior valid daily closes (real 52w window). This admits the 30-coin panel
 *     as each coin matures, maximizing the cross-section honestly (not just the
 *     15 fully-covered coins).
 *   - Weekly rebalance, realistic net-of-cost.
 *
 * KEY control (the whole point): does nearness add OVER D4-M1's killed momentum
 * and BTC beta?
 *   (a) Cross-sectionally orthogonalize nearness vs 12m (52w) momentum each week
 *       (regress nearness on momentum, trade the RESIDUAL ranking) -> residual-of-
 *       momentum portfolio.
 *   (b) Decompose the headline portfolio vs BTC: regress on BTC weekly return,
 *       report alpha + residual Sharpe (timed-beta check, exactly as M1).
 *
 * Surrogates (the RIGHT null for an anchoring/level claim):
 *   (S1) Cross-sectional shuffle: permute the nearness->coin mapping each week.
 *   (S2) NF1-style structure-destroying null: block-bootstrap each coin's daily
 *        log-return path (destroys the real running-high structure -> "no real
 *        highs"), rebuild prices, recompute nearness, re-run the SAME strategy.
 *        If a path with no genuine 52w-high anchor reproduces the Sharpe, the
 *        edge is an artifact of price-path autocorrelation, not anchoring.
 *
 * Gauntlet: honest-N config sweep, DSR@honestN, CSCV/PBO across configs,
 * consume-once holdout (config picked on first 80%, scored on last 20%),
 * BTC-beta residual.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/m3-52wk-high.ts
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
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };

const COINS = Object.keys(daily.closes);
const DATES = daily.dates;
const D = DATES.length;
const WEEKS = weekly.weeks;
const W = WEEKS.length;

const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const wret = (c: string, i: number): number | null => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : (v as number);
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
function blockResample(x: number[], blk: number, r: () => number): number[] {
  const out: number[] = [];
  while (out.length < x.length) {
    const s = Math.floor(r() * x.length);
    for (let o = 0; o < blk && out.length < x.length; o++)
      out.push(x[(s + o) % x.length]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Map each weekly period to a daily index (last daily date <= week date).
// weekly.weeks are Mondays of the week-close; daily dates are daily closes.
// ---------------------------------------------------------------------------
const dateIdx = new Map(DATES.map((d, i) => [d, i]));
function weekToDailyIdx(wi: number): number {
  // find the last daily date <= the week label
  const wd = WEEKS[wi];
  if (dateIdx.has(wd)) return dateIdx.get(wd)!;
  let lo = 0;
  let best = -1;
  for (let i = 0; i < D; i++) {
    if (DATES[i] <= wd) best = i;
    else break;
  }
  return best;
}
const WK2DI = WEEKS.map((_, i) => weekToDailyIdx(i));

// ---------------------------------------------------------------------------
// Build, per coin, the daily log-return series and a helper to get the
// 52w-high nearness and 52w momentum AS OF a daily index, using only valid
// (non-null, >0) closes. A coin is eligible at daily index di only if it has
// >=WINDOW valid closes ending at di.
// ---------------------------------------------------------------------------
const WINDOW = 364; // 52 weeks of calendar days
type Series = { close: (number | null)[] };
const SER: Record<string, Series> = {};
for (const c of COINS) SER[c] = { close: daily.closes[c] };

// nearness as-of daily index di over trailing WINDOW days (inclusive).
// Returns null if fewer than WINDOW valid closes in the window or current close invalid.
function nearnessAt(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di];
  if (cur == null || !(cur > 0)) return null;
  let hi = -Infinity;
  let valid = 0;
  const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) {
    const v = close[k];
    if (v != null && v > 0) {
      valid++;
      if (v > hi) hi = v;
    }
  }
  if (valid < WINDOW || hi <= 0) return null; // require a FULL real 52w window
  return cur / hi;
}
// 52w momentum as-of di (close / close[di-WINDOW]) - 1, same eligibility.
function mom52At(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di];
  const past = close[di - WINDOW + 1];
  if (cur == null || !(cur > 0) || past == null || !(past > 0)) return null;
  // require full valid window
  let valid = 0;
  const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) {
    const v = close[k];
    if (v != null && v > 0) valid++;
  }
  if (valid < WINDOW) return null;
  return cur / past - 1;
}

// generic versions that take an arbitrary close array (for surrogates)
function buildScores(
  closeOf: (c: string) => (number | null)[],
  di: number,
): { c: string; near: number; mom: number }[] {
  const out: { c: string; near: number; mom: number }[] = [];
  for (const c of COINS) {
    const cl = closeOf(c);
    const near = nearnessAt(cl, di);
    const mom = mom52At(cl, di);
    if (near != null && mom != null) out.push({ c, near, mom });
  }
  return out;
}

// cross-sectional OLS residual of y on x (returns residuals aligned to input)
function residualize(y: number[], x: number[]): number[] {
  const n = y.length;
  if (n < 3) return y.map(() => 0);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const b = vx > 1e-12 ? cov / vx : 0;
  const a = my - b * mx;
  return y.map((v, i) => v - (a + b * x[i]));
}

// ---------------------------------------------------------------------------
// Core strategy runner.
//   mode: "near"        -> rank by raw nearness, long top-K
//         "nearResid"   -> rank by nearness residualized vs 52w momentum (KEY control)
//         "mom"         -> rank by 52w momentum, long top-K (momentum baseline)
//   shuffleRank: cross-sectional shuffle surrogate (permute score->coin)
//   closeOf: provider of per-coin close array (swap for surrogate prices)
//   iStart/iEnd: weekly index bounds (for holdout)
// Long-only top-K equal weight, weekly rebalance, cost on turnover.
// ---------------------------------------------------------------------------
type Mode = "near" | "nearResid" | "mom";
const COST = 0.001; // 10 bps round-trip per name rotated, weekly

function run(
  mode: Mode,
  topK: number,
  closeOf: (c: string) => (number | null)[],
  iStart: number,
  iEnd: number,
  shuffleRank = false,
  r?: () => number,
): { port: number[]; btcRet: number[] } {
  const port: number[] = [];
  const btcRet: number[] = [];
  let prev: string[] = [];
  for (let i = Math.max(1, iStart); i < Math.min(W - 1, iEnd); i++) {
    const di = WK2DI[i];
    if (di < 0) continue;
    const scored = buildScores(closeOf, di);
    if (scored.length < topK + 2) {
      // not enough eligible coins yet; stay in cash
      port.push(0);
      btcRet.push(wret("BTC", i + 1) ?? 0);
      prev = [];
      continue;
    }
    // primary score per mode
    let scoreVals: number[];
    if (mode === "mom") scoreVals = scored.map((s) => s.mom);
    else if (mode === "nearResid")
      scoreVals = residualize(
        scored.map((s) => s.near),
        scored.map((s) => s.mom),
      );
    else scoreVals = scored.map((s) => s.near);

    if (shuffleRank && r) {
      for (let j = scoreVals.length - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        [scoreVals[j], scoreVals[k]] = [scoreVals[k], scoreVals[j]];
      }
    }
    const ranked = scored
      .map((s, idx) => ({ c: s.c, v: scoreVals[idx] }))
      .sort((a, b) => b.v - a.v);
    const hold = ranked.slice(0, topK).map((x) => x.c);

    let w = 0;
    let cnt = 0;
    for (const c of hold) {
      const v = wret(c, i + 1);
      if (v != null) (w += v), cnt++;
    }
    let pr = cnt > 0 ? w / cnt : 0;
    const turn =
      prev.filter((c) => !hold.includes(c)).length +
      hold.filter((c) => !prev.includes(c)).length;
    pr -= (turn / Math.max(1, topK)) * COST;
    port.push(pr);
    btcRet.push(wret("BTC", i + 1) ?? 0);
    prev = hold;
  }
  return { port, btcRet };
}

const realClose = (c: string) => SER[c].close;

// ===========================================================================
// 1) Honest-N config sweep on the REAL signal (long-only nearness)
// ===========================================================================
const topKs = [3, 5, 8, 10];
const modes: Mode[] = ["near", "nearResid"];
type Cfg = { id: string; mode: Mode; topK: number };
const configs: Cfg[] = [];
for (const m of modes)
  for (const k of topKs) configs.push({ id: `${m}_K${k}`, mode: m, topK: k });
// honest N also counts the momentum baseline variants we evaluated as part of search
const honestN = configs.length + topKs.length; // + mom baselines

const scoredCfg = configs.map((cfg) => {
  const res = run(cfg.mode, cfg.topK, realClose, 0, W);
  return {
    ...cfg,
    sharpe: ann(sharpe(res.port)),
    port: res.port,
    btcRet: res.btcRet,
  };
});
scoredCfg.sort((a, b) => b.sharpe - a.sharpe);
const best = scoredCfg[0];
const bestNearRaw = scoredCfg
  .filter((s) => s.mode === "near")
  .sort((a, b) => b.sharpe - a.sharpe)[0];
const bestNearResid = scoredCfg
  .filter((s) => s.mode === "nearResid")
  .sort((a, b) => b.sharpe - a.sharpe)[0];

// momentum baseline (the killed M1 cousin, long-only 52w mom) for comparison
const momScored = topKs.map((k) => {
  const res = run("mom", k, realClose, 0, W);
  return { k, sharpe: ann(sharpe(res.port)) };
});
momScored.sort((a, b) => b.sharpe - a.sharpe);
const bestMom = momScored[0];

// ===========================================================================
// 2) BTC-beta decomposition of the headline (best raw-nearness) portfolio
// ===========================================================================
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
  const beta = vx > 1e-12 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - (alpha + beta * x[i]));
  return { alpha, beta, resid };
}
const headReg = regress(bestNearRaw.port, bestNearRaw.btcRet);
const headResidSharpe = ann(sharpe(headReg.resid));
const headAlphaAnnPct = headReg.alpha * 52 * 100;

// residual-of-momentum portfolio (KEY control) beta decomposition too
const residReg = regress(bestNearResid.port, bestNearResid.btcRet);
const residResidSharpe = ann(sharpe(residReg.resid));
const residAlphaAnnPct = residReg.alpha * 52 * 100;

// ===========================================================================
// 3) Surrogate S1 — cross-sectional shuffle (on the headline raw-nearness cfg)
// ===========================================================================
{
  const r = rng(101);
  const surr: number[] = [];
  for (let it = 0; it < 400; it++) {
    const res = run(bestNearRaw.mode, bestNearRaw.topK, realClose, 0, W, true, r);
    surr.push(ann(sharpe(res.port)));
  }
  surr.sort((a, b) => a - b);
  var pShuffle = surr.filter((x) => x >= bestNearRaw.sharpe).length / surr.length;
  var shuffleMean = surr.reduce((a, b) => a + b, 0) / surr.length;
}

// ===========================================================================
// 4) Surrogate S2 — NF1-style structure-destroying null ("no real highs").
//   Block-bootstrap each coin's daily log-return path (block=21d ~ 1 month) to
//   destroy the genuine running-high structure, rebuild prices anchored at the
//   coin's first valid close, recompute nearness, re-run the SAME strategy.
// ===========================================================================
function buildSurrogateCloses(r: () => number): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const c of COINS) {
    const cl = SER[c].close;
    // collect valid log-returns and the index of first valid close
    let firstValid = -1;
    const lr: number[] = [];
    for (let i = 0; i < D; i++) {
      const v = cl[i];
      if (v != null && v > 0) {
        if (firstValid < 0) firstValid = i;
        const prev = cl[i - 1];
        if (i > 0 && prev != null && prev > 0) lr.push(Math.log(v / prev));
      }
    }
    if (firstValid < 0 || lr.length < WINDOW) {
      out[c] = cl.map(() => null);
      continue;
    }
    const shuffled = blockResample(lr, 21, r);
    // rebuild close path on the SAME timestamps (null before firstValid)
    const newCl: (number | null)[] = new Array(D).fill(null);
    const p0 = cl[firstValid] as number;
    let logp = Math.log(p0);
    newCl[firstValid] = p0;
    let li = 0;
    for (let i = firstValid + 1; i < D; i++) {
      const orig = cl[i];
      if (orig != null && orig > 0) {
        logp += shuffled[li % shuffled.length];
        li++;
        newCl[i] = Math.exp(logp);
      } else {
        newCl[i] = null;
      }
    }
    out[c] = newCl;
  }
  return out;
}
{
  const r = rng(202);
  const surr: number[] = [];
  for (let it = 0; it < 200; it++) {
    const sc = buildSurrogateCloses(r);
    const closeOf = (c: string) => sc[c];
    const res = run(bestNearRaw.mode, bestNearRaw.topK, closeOf, 0, W);
    surr.push(ann(sharpe(res.port)));
  }
  surr.sort((a, b) => a - b);
  var pNF1 = surr.filter((x) => x >= bestNearRaw.sharpe).length / surr.length;
  var nf1Mean = surr.reduce((a, b) => a + b, 0) / surr.length;
  var nf1P95 = surr[Math.floor(0.95 * (surr.length - 1))];
}

// ===========================================================================
// 5) CSCV / PBO across the config grid (raw + residual configs)
// ===========================================================================
const FOLDS = 8;
const foldReturns = scoredCfg.map((s) => {
  const folds: number[][] = Array.from({ length: FOLDS }, () => []);
  s.port.forEach((r, i) => folds[i % FOLDS].push(r));
  return { id: s.id, folds };
});
const pboRes = estimateCscvPbo(foldReturns, { statistic: "sharpe" as any });
const pbo =
  (pboRes as any).pbo ??
  (pboRes as any).probabilityOfBacktestOverfitting ??
  pboRes;

// ===========================================================================
// 6) Consume-once holdout: pick best config on first 80%, score on last 20%
// ===========================================================================
const splitIdx = Math.floor(W * 0.8);
const inSample = configs.map((cfg) => {
  const res = run(cfg.mode, cfg.topK, realClose, 0, splitIdx);
  return { cfg, s: ann(sharpe(res.port)) };
});
inSample.sort((a, b) => b.s - a.s);
const bestIS = inSample[0].cfg;
const holdout = run(bestIS.mode, bestIS.topK, realClose, splitIdx, W);
const holdoutSharpe = ann(sharpe(holdout.port));

// ===========================================================================
// 7) DSR at honest N on the headline raw-nearness portfolio
// ===========================================================================
const dsr = computeDeflatedSharpeRatio(bestNearRaw.port, { trialCount: honestN });
const dsrResid = computeDeflatedSharpeRatio(bestNearResid.port, {
  trialCount: honestN,
});
const meanWHead = bestNearRaw.port.reduce((a, b) => a + b, 0) / bestNearRaw.port.length;
const meanWResid =
  bestNearResid.port.reduce((a, b) => a + b, 0) / bestNearResid.port.length;

const out = {
  item: "D4-M3 52-week-high nearness (anchoring)",
  panel: { coins: COINS.length, weeks: W, window_days: WINDOW },
  honestN,
  // headline raw-nearness long-only
  headline_rawNearness: {
    config: bestNearRaw.id,
    sharpeAnnNet: bestNearRaw.sharpe,
    nWeeks: bestNearRaw.port.length,
    monthlyReturnPctNet: (Math.pow(1 + meanWHead, 52 / 12) - 1) * 100,
    dsr_p_at_honestN: dsr.deflatedProbability,
    btc_beta: headReg.beta,
    alpha_ann_pct: headAlphaAnnPct,
    residual_alpha_sharpe_ann: headResidSharpe,
  },
  // KEY control: nearness residualized vs 52w momentum
  residualOfMomentum: {
    config: bestNearResid.id,
    sharpeAnnNet: bestNearResid.sharpe,
    monthlyReturnPctNet: (Math.pow(1 + meanWResid, 52 / 12) - 1) * 100,
    dsr_p_at_honestN: dsrResid.deflatedProbability,
    btc_beta: residReg.beta,
    alpha_ann_pct: residAlphaAnnPct,
    residual_alpha_sharpe_ann: residResidSharpe,
    note:
      "Trades the cross-sectional residual of nearness after regressing out 52w momentum. If this collapses, nearness adds nothing over momentum (mirrors M1 residual collapse).",
  },
  momentumBaseline: { bestConfig: `mom_K${bestMom.k}`, sharpeAnnNet: bestMom.sharpe },
  surrogates: {
    crossSectionalShuffle_p: pShuffle,
    crossSectionalShuffle_mean: shuffleMean,
    nf1StructureDestroying_p: pNF1,
    nf1StructureDestroying_mean: nf1Mean,
    nf1StructureDestroying_p95: nf1P95,
    note:
      "S1 permutes nearness->coin mapping. S2 (NF1) block-bootstraps each coin's daily path (no real highs) and recomputes nearness. p = frac surrogate Sharpe >= real.",
  },
  pbo,
  holdout_consumeOnce: {
    configSelectedInSample: bestIS.id,
    sharpeAnn: holdoutSharpe,
    nWeeks: holdout.port.length,
  },
  topConfigs: scoredCfg.slice(0, 6).map((s) => ({ id: s.id, sharpe: s.sharpe })),
  cost_bps_roundtrip_per_name: COST * 1e4,
};
fs.writeFileSync(path.join(OUT, "m3-52wk-high.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
