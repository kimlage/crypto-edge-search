/**
 * Q2-BOCPD (D8-A5) — Bayesian Online Change-Point regime filter. Full committed gauntlet.
 *
 * Strategy: run strictly-causal BOCPD on returns. When a break is detected (cpProb high / expected
 * run length collapses), CUT or FLIP exposure based on the post-break regime-mean estimate. The
 * position at bar t (built from x_{1:t}) earns ret[t+1] (next bar). 4bps/side taker cost.
 *
 * Controls (the traps this lab documents for timing strategies):
 *   - MATCHED-EXPOSURE buy&hold: B&H scaled to the SAME average |exposure| as the strategy. A
 *     timing book must beat this, not merely de-risk during a bull market.
 *   - LATENCY-MATCHED vol-stop: a fixed N-bar realized-vol stop whose N is tuned to the SAME average
 *     action delay as BOCPD. The detector must beat a same-delay mechanical de-risker (the spec's
 *     KEY control).
 *   - random-lottery (matched exposure), buy&hold.
 * Null: phase-randomization + AAFT surrogates of the return series (preserve spectrum/marginal,
 *   destroy real change-points). Plus block-bootstrap CI. Deflated Sharpe @ honest N (every config).
 *   CPCV/PBO, Harvey-Liu Bonferroni haircut, consume-once forward holdout (last 20%).
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";
import { loadBtc, type Bars } from "./data.ts";
import { runBocpd, type BocpdParams } from "./bocpd-core.ts";
import { phaseRandomize, aaftSurrogate } from "./surrogate.ts";

const COST_PER_SIDE = 0.0004; // 4 bps taker per side

// ---------------- math utils ----------------
function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
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
// rolling std of returns (causal), used for vol-targeting / vol-stop
function rollingStd(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < win) continue;
    const w: number[] = [];
    for (let k = i - win + 1; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]);
    if (w.length >= Math.min(10, win)) out[i] = std(w);
  }
  return out;
}

// ---------------- backtest core ----------------
interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number;
  nBars: number;
  longShare: number;
}
// position[t] applied to ret[t+1]; window [lo, hi) over position index t (so it touches ret up to hi)
function runPositions(bars: Bars, position: number[], lo: number, hi: number): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0;
  let expSum = 0;
  let longCount = 0;
  let n = 0;
  for (let t = lo; t < hi; t++) {
    const fr = bars.ret[t + 1];
    const pos = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev);
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - turn * COST_PER_SIDE);
    turnoverSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    prev = pos;
    n++;
  }
  return {
    dailyNet,
    dailyGross,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    nBars: n,
    longShare: n ? longCount / n : 0,
  };
}

// ---------------- BOCPD position builder ----------------
interface Cfg {
  lambda: number; // hazard (expected regime length, bars)
  collapseFrac: number; // run-length COLLAPSE trigger: expRun < collapseFrac * trailing-max => break
  mode: "cut" | "flip" | "trend"; // cut=>flat on break; flip=>follow post-break regime sign; trend=>regimeMean sign always
  volWin: number; // window to standardize returns fed to BOCPD
  holdBars: number; // bars to hold the de-risk/flip action after a trigger
  beta0: number; // NIG prior scale
}

// Standardize returns by trailing vol so BOCPD detects MEAN/level breaks on a stationary-vol scale.
function standardizeReturns(ret: number[], volWin: number): number[] {
  const rs = rollingStd(ret, volWin);
  const out = new Array(ret.length).fill(0);
  for (let i = 0; i < ret.length; i++) {
    const v = rs[i];
    out[i] = Number.isFinite(ret[i]) && Number.isFinite(v) && v > 1e-9 ? ret[i] / v : 0;
  }
  return out;
}

function buildPositionFromSteps(
  bars: Bars,
  stepsFor: number[], // standardized returns the BOCPD ran on
  cfg: Cfg,
  warmup: number,
): number[] {
  const T = bars.ret.length;
  const p: BocpdParams = {
    hazardLambda: cfg.lambda,
    mu0: 0,
    kappa0: 1,
    alpha0: 1,
    beta0: cfg.beta0,
    maxRunLength: 600,
  };
  const steps = runBocpd(stepsFor, p);
  const er = steps.map((s) => s.expRunLength);
  const COLLAPSE_WIN = 60; // trailing window for the run-length peak
  const pos = new Array(T).fill(0);
  // baseline exposure: long (the dominant crypto factor) UNLESS a break action is active.
  let actionUntil = -1;
  let actionPos = 1;
  for (let t = 0; t < T; t++) {
    if (t < warmup || t >= steps.length) {
      pos[t] = 0;
      continue;
    }
    const st = steps[t];
    // genuine BOCPD break = expected run-length COLLAPSE (posterior says a new regime just began).
    let trailMax = 0;
    for (let k = Math.max(0, t - COLLAPSE_WIN); k < t; k++) trailMax = Math.max(trailMax, er[k]);
    const collapsed = trailMax > 10 && er[t] < cfg.collapseFrac * trailMax;
    if (collapsed) {
      if (cfg.mode === "cut") {
        actionPos = 0;
      } else if (cfg.mode === "flip") {
        // follow the post-break regime-mean estimate (standardized scale). + => long, - => short
        actionPos = st.regimeMean > 0 ? 1 : -1;
      } else {
        actionPos = st.regimeMean > 0 ? 1 : st.regimeMean < 0 ? -1 : 0;
      }
      actionUntil = t + cfg.holdBars;
    }
    if (cfg.mode === "trend") {
      // always track current-regime mean sign (continuous regime filter)
      pos[t] = st.regimeMean > 0 ? 1 : st.regimeMean < 0 ? -1 : 0;
    } else if (t <= actionUntil) {
      pos[t] = actionPos;
    } else {
      pos[t] = 1; // default long-beta
    }
  }
  return pos;
}

// ---------------- baselines / controls ----------------
// Matched-exposure buy&hold: constant long position equal to the strategy's average |exposure|.
function matchedExposureBH(bars: Bars, exposure: number, lo: number, hi: number): number[] {
  const dailyNet: number[] = [];
  let prev = 0;
  for (let t = lo; t < hi; t++) {
    const fr = bars.ret[t + 1];
    if (!Number.isFinite(fr)) continue;
    const pos = exposure;
    dailyNet.push(pos * fr - Math.abs(pos - prev) * COST_PER_SIDE);
    prev = pos;
  }
  return dailyNet;
}

// Latency-matched vol-stop: go flat for `holdBars` whenever trailing realized vol jumps above its
// rolling median by `k`. `holdBars` is set to the SAME avg action delay/duration as BOCPD.
function volStopPosition(bars: Bars, volWin: number, k: number, holdBars: number, warmup: number): number[] {
  const T = bars.ret.length;
  const rs = rollingStd(bars.ret, volWin);
  // rolling median of vol (causal)
  const pos = new Array(T).fill(0);
  let actionUntil = -1;
  for (let t = 0; t < T; t++) {
    if (t < warmup) { pos[t] = 0; continue; }
    // trailing median of vol over a long window
    const lo = Math.max(0, t - 200);
    const w: number[] = [];
    for (let i = lo; i <= t; i++) if (Number.isFinite(rs[i])) w.push(rs[i]);
    w.sort((a, b) => a - b);
    const med = w.length ? w[Math.floor(w.length / 2)] : NaN;
    if (Number.isFinite(rs[t]) && Number.isFinite(med) && rs[t] > k * med) {
      actionUntil = t + holdBars;
    }
    pos[t] = t <= actionUntil ? 0 : 1;
  }
  return pos;
}

// ---------------- gauntlet ----------------
function annFromDaily(dailySharpe: number, barsPerYear: number): number {
  return dailySharpe * Math.sqrt(barsPerYear);
}

interface RunCtx {
  bars: Bars;
  barsPerYear: number;
  warmup: number;
  lo: number; // first tradable position index
  split: number; // in-sample/holdout boundary
  end: number; // last tradable position index (exclusive); needs ret[t+1]
  label: string;
}

function main() {
  const results: any[] = [];
  // Two resolutions: 4h (mult=16) and daily (mult=96). Daily is the natural regime scale; 4h gives
  // BOCPD a faster detector at the cost of more noise. Count BOTH families in honest N.
  const families: { name: string; mult: number; barsPerYear: number }[] = [
    { name: "4h", mult: 16, barsPerYear: 365 * 6 },
    { name: "daily", mult: 96, barsPerYear: 365 },
  ];

  // config grid (counts toward honest N)
  const lambdas = [50, 150, 400];
  const collapseFracs = [0.3, 0.4, 0.5];
  const modes: Cfg["mode"][] = ["cut", "flip", "trend"];
  const volWins = [30];
  const holdBarsArr = [10, 30];
  const beta0s = [0.5];

  // accumulate honest N across BOTH families and ALL configs
  const grid: Cfg[] = [];
  for (const lambda of lambdas)
    for (const collapseFrac of collapseFracs)
      for (const mode of modes)
        for (const volWin of volWins)
          for (const holdBars of holdBarsArr)
            for (const beta0 of beta0s)
              grid.push({ lambda, collapseFrac, mode, volWin, holdBars, beta0 });
  const honestN = grid.length * families.length;

  const out: string[] = [];
  const log = (s: string) => { out.push(s); console.log(s); };
  log(`Q2-BOCPD gauntlet — honestN=${honestN} (${grid.length} configs x ${families.length} families)`);

  // ---- evaluate each family, pick the best config in-sample, then run full gauntlet ----
  let bestOverall: any = null;
  const allInSampleNetByConfig: { id: string; folds: number[][] }[] = [];

  for (const fam of families) {
    const bars = loadBtc(fam.mult);
    const warmup = 300; // BOCPD + vol warmup
    const T = bars.ret.length;
    const lo = warmup;
    const end = T - 1; // need ret[t+1]
    const span = end - lo;
    const split = lo + Math.floor(span * 0.8); // last 20% = consume-once holdout
    log(`\n[family ${fam.name}] bars=${T} tradable=${span} inSample=[${lo},${split}) holdout=[${split},${end})`);

    // precompute standardized returns per volWin
    const stdCache = new Map<number, number[]>();
    for (const vw of volWins) stdCache.set(vw, standardizeReturns(bars.ret, vw));

    const scored = grid.map((cfg) => {
      const sret = stdCache.get(cfg.volWin)!;
      const pos = buildPositionFromSteps(bars, sret, cfg, warmup);
      const res = runPositions(bars, pos, lo, split);
      const netSh = annFromDaily(sharpeDaily(res.dailyNet), fam.barsPerYear);
      const id = `${fam.name}|l${cfg.lambda}|cf${cfg.collapseFrac}|${cfg.mode}|h${cfg.holdBars}`;
      return { cfg, pos, res, netSh, id };
    });
    scored.sort((a, b) => b.netSh - a.netSh);
    const best = scored[0];

    // CSCV folds for ALL configs across BOTH families (combined PBO)
    const NFOLDS = 6;
    for (const s of scored) {
      const series = s.res.dailyNet;
      const folds: number[][] = [];
      const sz = Math.floor(series.length / NFOLDS);
      for (let f = 0; f < NFOLDS; f++) {
        const flo = f * sz;
        const fhi = f === NFOLDS - 1 ? series.length : flo + sz;
        folds.push(series.slice(flo, fhi));
      }
      allInSampleNetByConfig.push({ id: s.id, folds });
    }

    log(`[family ${fam.name}] best in-sample: ${best.id} netSharpeAnn=${best.netSh.toFixed(3)} exposure=${best.res.exposure.toFixed(3)} turnover=${best.res.turnover.toFixed(3)} longShare=${best.res.longShare.toFixed(2)}`);

    if (!bestOverall || best.netSh > bestOverall.best.netSh) {
      bestOverall = { fam, bars, warmup, lo, split, end, best, stdCache };
    }
  }

  // ============ full gauntlet on the GLOBAL best config ============
  const { fam, bars, warmup, lo, split, end, best } = bestOverall;
  const bestNet = best.res.dailyNet;
  log(`\n======== GAUNTLET on global best: ${best.id} (family ${fam.name}) ========`);

  // ---- net-of-cost ----
  const netMean = mean(bestNet);
  const g_net = netMean > 0;

  // ---- baselines ----
  const bhNet = matchedExposureBH(bars, 1.0, lo, split); // full-exposure B&H
  const bhSh = annFromDaily(sharpeDaily(bhNet), fam.barsPerYear);
  // MATCHED-EXPOSURE B&H (the critical timing control)
  const mexNet = matchedExposureBH(bars, best.res.exposure, lo, split);
  const mexSh = annFromDaily(sharpeDaily(mexNet), fam.barsPerYear);
  // random-lottery matched exposure
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(bars.ret.length).fill(0);
    for (let t = lo; t < split; t++) pos[t] = rng() < best.res.exposure ? 1 : 0;
    const r = runPositions(bars, pos, lo, split);
    rlSh.push(annFromDaily(sharpeDaily(r.dailyNet), fam.barsPerYear));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  // LATENCY-MATCHED vol-stop (KEY control): tune holdBars to match avg action duration.
  // approximate the BOCPD action duration with the config holdBars (avg delay+hold).
  let bestVsSh = -Infinity;
  let bestVsLabel = "";
  for (const k of [1.5, 2.0, 2.5]) {
    const vsPos = volStopPosition(bars, best.cfg.volWin, k, best.cfg.holdBars, warmup);
    const vsRes = runPositions(bars, vsPos, lo, split);
    const vsSh = annFromDaily(sharpeDaily(vsRes.dailyNet), fam.barsPerYear);
    if (vsSh > bestVsSh) { bestVsSh = vsSh; bestVsLabel = `k=${k}`; }
  }
  const baselinePass =
    best.netSh > bhSh && best.netSh > mexSh && best.netSh > rl95 && best.netSh > bestVsSh && best.netSh > 0;

  log(`baselines: best=${best.netSh.toFixed(3)} | B&H=${bhSh.toFixed(3)} | matchedExpBH=${mexSh.toFixed(3)} | randLottery95=${rl95.toFixed(3)} | latencyMatchedVolStop=${bestVsSh.toFixed(3)} (${bestVsLabel})`);

  // ---- Deflated Sharpe @ honest N ----
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: honestN });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---- block bootstrap CI on mean daily net ----
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "q2-bocpd-bb",
  });
  const bbPass = bb.lower > 0;

  // ---- CSCV/PBO across ALL configs (both families) ----
  let pbo = 1, medLogit = 0;
  try {
    const r = estimateCscvPbo(allInSampleNetByConfig, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = r.pbo; medLogit = r.medianLogit;
  } catch (e) { pbo = 1; }
  const pboPass = pbo < 0.5;

  // ---- Harvey-Liu Bonferroni haircut ----
  const psrP = 1 - normalCdf(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * honestN);
  const haircutPass = adjP < 0.05;

  // ---- RIGHT surrogate null: phase-randomization + AAFT of the return series ----
  // On each surrogate we rebuild the standardized returns and re-run the SAME best config.
  const nSurr = 300;
  const surrSh: number[] = [];
  const realRet = bars.ret.slice();
  const finiteIdx: number[] = [];
  for (let i = 0; i < realRet.length; i++) if (Number.isFinite(realRet[i])) finiteIdx.push(i);
  const finiteRet = finiteIdx.map((i) => realRet[i]);
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const surr = i % 2 === 0 ? phaseRandomize(finiteRet, rng) : aaftSurrogate(finiteRet, rng);
    // splice back into a return array aligned to bars
    const sret = realRet.slice();
    for (let j = 0; j < finiteIdx.length; j++) sret[finiteIdx[j]] = surr[j];
    const surrBars: Bars = { t: bars.t, close: bars.close, ret: sret };
    const stdR = standardizeReturns(sret, best.cfg.volWin);
    const pos = buildPositionFromSteps(surrBars, stdR, best.cfg, warmup);
    const res = runPositions(surrBars, pos, lo, split);
    surrSh.push(annFromDaily(sharpeDaily(res.dailyNet), fam.barsPerYear));
  }
  surrSh.sort((a, b) => a - b);
  const surrAbove = surrSh.filter((s) => s >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // ---- consume-once forward holdout ----
  const holdRes = runPositions(bars, best.pos, split, end);
  const holdSh = annFromDaily(sharpeDaily(holdRes.dailyNet), fam.barsPerYear);
  const holdMexNet = matchedExposureBH(bars, holdRes.exposure, split, end);
  const holdMexSh = annFromDaily(sharpeDaily(holdMexNet), fam.barsPerYear);
  const holdoutPass = holdSh > 0 && holdSh > holdMexSh;

  // ---- assemble gates ----
  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: { pass: g_net, detail: `netMeanDaily=${netMean.toExponential(3)} turnover=${best.res.turnover.toFixed(3)}` },
    baselines: { pass: baselinePass, detail: `best=${best.netSh.toFixed(3)} vs matchedExpBH=${mexSh.toFixed(3)} latencyVolStop=${bestVsSh.toFixed(3)} rl95=${rl95.toFixed(3)} B&H=${bhSh.toFixed(3)}` },
    deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${honestN} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} obsSh=${dsr.sharpe.toFixed(4)}` },
    block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.toFixed(3)} medianLogit=${medLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${honestN})` },
    surrogate: { pass: surrPass, detail: `phaseRand/AAFT placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surrSh).toFixed(3)} surr95=${surrSh[Math.floor(nSurr * 0.95)].toFixed(3)}` },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} vs OOS matchedExpBH=${holdMexSh.toFixed(3)} over ${holdRes.nBars} bars` },
  };

  const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
  let binding = "none";
  for (const g of order) if (!gates[g].pass) { binding = g; break; }
  const allPass = binding === "none";
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";

  log(`\n--- gates ---`);
  for (const g of order) log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);

  const monthlyAt100k = allPass ? `$${Math.round(netMean * (fam.barsPerYear / 12) * 100000)}` : "n/a";
  const verdictLine = `VERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${honestN} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthlyAt100k}`;
  log(`\n${verdictLine}`);

  fs.writeFileSync(
    "output/edgehunt-quant/q2-bocpd-result.txt",
    out.join("\n") + "\n",
  );
}

// ---- normal helpers ----
function normalCdf(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}

main();
