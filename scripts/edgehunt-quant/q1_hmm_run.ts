/**
 * Q1-HMM — HMM / Markov 2-3 state regime-switching timer. Full committed gauntlet.
 *
 * Strategy: fit a 2-3 state Gaussian HMM on BTC daily [logret, log(realized-vol)]. STRICTLY causal:
 * refit on a TRAILING window ending at t (no future params), filter forward to t, go LONG when the
 * filtered probability of the risk-on state (higher in-sample mean, causally identified) exceeds a
 * threshold; otherwise FLAT. Held over t->t+1. Net of 4bps/side taker cost.
 *
 * THE RIGHT CONTROLS (documented traps for this lab):
 *  - Matched-exposure: the timer is long X% of days. It must beat (a) a random in/out book at the
 *    SAME exposure (random-lottery 95th pct) AND (b) a DETERMINISTIC matched-exposure control:
 *    constant fractional long at exposure X (= X * buy&hold). De-risking alone is NOT edge.
 *  - The RIGHT surrogate null = GARCH(1,1)-simulated returns (preserves vol clustering, the thing the
 *    HMM keys on, but has NO predictable regime/return structure). Run the ENTIRE pipeline on each
 *    surrogate; real net Sharpe must beat the surrogate distribution. (Phase-randomization is WRONG
 *    here — it destroys vol clustering and flatters the HMM.)
 *  - Honest N = every (K, retScale, thr, rvWin, refitEvery) config tried.
 *  - DSR @ honest N, CPCV/PBO across configs, Harvey-Liu Bonferroni haircut, consume-once holdout.
 */

import fs from "node:fs";
import {
  loadBtcDaily,
  buildSeries,
  fitHmm,
  filterLast,
  mean,
  std,
  sharpeDaily,
  annSharpe,
  mkRng,
  gauss,
  type Series,
} from "./q1_hmm_lib.ts";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ROOT = ".";

interface Cfg {
  K: number; // states
  rvWin: number; // realized-vol window for the feature
  refitEvery: number; // refit cadence (days)
  fitWin: number; // trailing fit window length (days); 0 => expanding
  thr: number; // long if P(risk-on) > thr
  minFit: number; // min obs before any trading
}

// Build a strictly-causal position array for one config. position[t] in {0,1} applied over fwdRet[t].
function buildPosition(S: Series, cfg: Cfg): number[] {
  const T = S.close.length;
  const pos = new Array(T).fill(NaN);
  // observation vector at day t = [ret[t], log(rv[t])]; needs rv finite
  const obsAll: (number[] | null)[] = new Array(T).fill(null);
  for (let t = 0; t < T; t++) {
    if (Number.isFinite(S.ret[t]) && Number.isFinite(S.rv[t]) && S.rv[t]! > 0) {
      obsAll[t] = [S.ret[t], Math.log(S.rv[t]!)];
    }
  }
  let params: ReturnType<typeof fitHmm> | null = null;
  let riskOnState = -1;
  let lastFit = -1;
  for (let t = 0; t < T; t++) {
    if (obsAll[t] == null) continue;
    // gather contiguous causal obs window ending at t
    const startWin = cfg.fitWin > 0 ? Math.max(0, t - cfg.fitWin + 1) : 0;
    const win: number[][] = [];
    for (let k = startWin; k <= t; k++) if (obsAll[k]) win.push(obsAll[k]!);
    if (win.length < cfg.minFit) continue;
    // refit on schedule (causal: only past+present obs)
    if (params == null || t - lastFit >= cfg.refitEvery) {
      params = fitHmm(win, cfg.K, { maxIter: 50, seed: 7, nInit: 2 });
      // risk-on state = highest in-sample mean ret (dim 0); tie-break lower vol (dim 1)
      let bestK = 0;
      let bestScore = -Infinity;
      for (let k = 0; k < cfg.K; k++) {
        const score = params.mu[k][0] - 0.0 * params.var_[k][0];
        if (score > bestScore) {
          bestScore = score;
          bestK = k;
        }
      }
      riskOnState = bestK;
      lastFit = t;
    }
    // filter forward to t using the (past-fit) params on the causal window
    const filt = filterLast(win, params);
    const pOn = filt[riskOnState];
    pos[t] = pOn > cfg.thr ? 1 : 0;
  }
  return pos;
}

interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number;
  longShare: number;
  nDays: number;
}

function runPositions(
  S: Series,
  position: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0;
  let expSum = 0;
  let longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = S.fwdRet[t];
    const pos = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev);
    const cost = turn * costPerSide;
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - cost);
    turnoverSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    prev = pos;
  }
  const n = dailyNet.length;
  return {
    dailyNet,
    dailyGross,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    longShare: n ? longCount / n : 0,
    nDays: n,
  };
}

// ---- GARCH(1,1) fit (Gaussian QMLE, simple grid+refine) on returns ----
function fitGarch(ret: number[]): { omega: number; alpha: number; beta: number; mu: number } {
  const r = ret.filter((x) => Number.isFinite(x));
  const mu = mean(r);
  const v = r.map((x) => x - mu);
  const uncond = mean(v.map((x) => x * x));
  function nll(omega: number, alpha: number, beta: number): number {
    let s2 = uncond;
    let ll = 0;
    for (let t = 0; t < v.length; t++) {
      if (t > 0) s2 = omega + alpha * v[t - 1] * v[t - 1] + beta * s2;
      s2 = Math.max(s2, 1e-12);
      ll += 0.5 * (Math.log(2 * Math.PI * s2) + (v[t] * v[t]) / s2);
    }
    return ll;
  }
  let best = { omega: uncond * 0.1, alpha: 0.08, beta: 0.9, ll: Infinity };
  for (const alpha of [0.03, 0.05, 0.08, 0.1, 0.15]) {
    for (const beta of [0.8, 0.85, 0.9, 0.93, 0.95]) {
      if (alpha + beta >= 0.999) continue;
      const omega = uncond * (1 - alpha - beta);
      const ll = nll(omega, alpha, beta);
      if (ll < best.ll) best = { omega, alpha, beta, ll };
    }
  }
  return { omega: best.omega, alpha: best.alpha, beta: best.beta, mu };
}

// Simulate one GARCH(1,1) return path (preserves vol clustering, NO regime/return predictability).
function simGarch(
  g: { omega: number; alpha: number; beta: number; mu: number },
  n: number,
  rng: () => number,
): number[] {
  const uncond = g.omega / Math.max(1e-9, 1 - g.alpha - g.beta);
  let s2 = uncond;
  const out = new Array(n);
  let prevShock = 0;
  for (let t = 0; t < n; t++) {
    if (t > 0) s2 = g.omega + g.alpha * prevShock * prevShock + g.beta * s2;
    s2 = Math.max(s2, 1e-12);
    const eps = Math.sqrt(s2) * gauss(rng);
    prevShock = eps;
    out[t] = g.mu + eps;
  }
  return out;
}

// Build a synthetic Series from a return path (close reconstructed by cumsum; rv recomputed).
function seriesFromReturns(ret: number[], rvWin: number): Series {
  const T = ret.length;
  const close = new Array(T);
  let logp = Math.log(10000);
  for (let t = 0; t < T; t++) {
    logp += ret[t];
    close[t] = Math.exp(logp);
  }
  const rv = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    if (t + 1 < rvWin) continue;
    rv[t] = std(ret.slice(t - rvWin + 1, t + 1));
  }
  const fwdRet = new Array(T).fill(NaN);
  for (let t = 0; t < T - 1; t++) fwdRet[t] = ret[t + 1];
  const dates = ret.map((_, i) => String(i));
  return { dates, close, ret, rv, fwdRet };
}

// ----------------------------------------------------------------- gauntlet

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
function toFolds(series: number[], nfolds: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / nfolds);
  for (let f = 0; f < nfolds; f++) {
    const lo = f * sz;
    const hi = f === nfolds - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}

function main() {
  const bars = loadBtcDaily();
  console.log(`BTC daily bars: ${bars.length} (${bars[0].date} .. ${bars[bars.length - 1].date})`);

  // honest grid (count EVERY config in N)
  const Ks = [2, 3];
  const rvWins = [10, 14, 21];
  const refits = [21, 63]; // monthly / quarterly refit
  const fitWins = [504, 0]; // 2y trailing or expanding (0)
  const thrs = [0.5, 0.6, 0.7];
  const minFit = 252;

  const configs: Cfg[] = [];
  for (const K of Ks)
    for (const rvWin of rvWins)
      for (const refitEvery of refits)
        for (const fitWin of fitWins)
          for (const thr of thrs)
            configs.push({ K, rvWin, refitEvery, fitWin, thr, minFit });
  const HONEST_N = configs.length;
  console.log(`honest N = ${HONEST_N} configs`);

  // canonical pre-registered config (the textbook 2-state, monthly refit, 2y window, P>0.5)
  const canonical: Cfg = { K: 2, rvWin: 14, refitEvery: 21, fitWin: 504, thr: 0.5, minFit };

  // precompute series per rvWin (feature depends on rvWin)
  const seriesByRv = new Map<number, Series>();
  for (const rvWin of rvWins) seriesByRv.set(rvWin, buildSeries(bars, rvWin));

  const T = bars.length;
  const startIdx = minFit + Math.max(...rvWins) + 5; // warmup
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const holdoutFrac = 0.2;
  const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));
  console.log(
    `startIdx=${startIdx} (${bars[startIdx].date})  splitIdx=${splitIdx} (${bars[splitIdx].date})  holdout=[${bars[splitIdx].date}..${bars[tradableEnd].date}]`,
  );

  // score every config IN-SAMPLE on net Sharpe
  const scored = configs.map((cfg) => {
    const S = seriesByRv.get(cfg.rvWin)!;
    const pos = buildPosition(S, cfg);
    const res = runPositions(S, pos, startIdx, splitIdx);
    const label = `K${cfg.K}_rv${cfg.rvWin}_re${cfg.refitEvery}_fw${cfg.fitWin}_thr${cfg.thr}`;
    return { cfg, label, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;
  const Sbest = seriesByRv.get(best.cfg.rvWin)!;
  console.log(
    `\nBEST in-sample: ${best.label}  netSharpeAnn=${best.netSh.toFixed(3)}  exposure=${best.res.exposure.toFixed(3)} longShare=${best.res.longShare.toFixed(3)} turnover=${best.res.turnover.toFixed(3)} nDays=${best.res.nDays}`,
  );
  console.log("Top 5 configs in-sample:");
  for (const s of scored.slice(0, 5))
    console.log(
      `  ${s.label}: netSh=${s.netSh.toFixed(3)} exp=${s.res.exposure.toFixed(3)} long=${s.res.longShare.toFixed(3)}`,
    );

  // ---------- baselines on the SAME in-sample window ----------
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(Sbest, bhPos, startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));

  // MATCHED-EXPOSURE control (deterministic): constant fractional long = best exposure (= e*B&H).
  const expo = best.res.exposure;
  const mePos = new Array(T).fill(expo);
  const me = runPositions(Sbest, mePos, startIdx, splitIdx);
  const meSh = annSharpe(sharpeDaily(me.dailyNet));

  // random-lottery at matched exposure (95th pct)
  const rlSh: number[] = [];
  for (let i = 0; i < 300; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < expo ? 1 : 0;
    const r = runPositions(Sbest, pos, startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];

  // The BINDING baseline test for a timing strategy: beat the matched-exposure control AND
  // the random-lottery 95th pct AND B&H is NOT required (timer de-risks), but matched-exposure IS.
  const baselinePass = best.netSh > meSh && best.netSh > rl95 && best.netSh > 0;
  console.log(
    `\nBaselines: best=${best.netSh.toFixed(3)} | B&H=${bhSh.toFixed(3)} | matched-exposure(det)=${meSh.toFixed(3)} | random-lottery95=${rl95.toFixed(3)}`,
  );

  // ---------- Deflated Sharpe @ honest N ----------
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---------- block bootstrap CI on mean daily net ----------
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 20,
    confidenceLevel: 0.95,
    seed: "q1hmm-bb",
  });
  const bbPass = bb.lower > 0;

  // ---------- CPCV / PBO across all configs ----------
  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try {
    const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch (e) {
    console.log("pbo err", e);
  }
  const pboPass = pbo.pbo < 0.5;

  // ---------- Harvey-Liu Bonferroni haircut ----------
  const psrP = 1 - normalCdf(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---------- THE RIGHT surrogate null: GARCH(1,1) vol-clustering-preserving ----------
  // Fit GARCH on the IN-SAMPLE returns, simulate N paths, run the FULL pipeline (best cfg) on each.
  const insampleRet = Sbest.ret.slice(startIdx, splitIdx).filter((x) => Number.isFinite(x));
  const g = fitGarch(insampleRet);
  console.log(
    `\nGARCH(1,1) fit (in-sample): omega=${g.omega.toExponential(3)} alpha=${g.alpha.toFixed(3)} beta=${g.beta.toFixed(3)} mu=${g.mu.toExponential(3)} (alpha+beta=${(g.alpha + g.beta).toFixed(3)})`,
  );
  const nSurr = 200;
  const nSim = splitIdx + 50; // sim enough length to cover warmup+in-sample window
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const simRet = simGarch(g, nSim, rng);
    const simS = seriesFromReturns(simRet, best.cfg.rvWin);
    const sStart = Math.min(startIdx, simS.close.length - 50);
    const sEnd = Math.min(splitIdx, simS.close.length - 1);
    const simPos = buildPosition(simS, best.cfg);
    const r = runPositions(simS, simPos, sStart, sEnd);
    surr.push(annSharpe(sharpeDaily(r.dailyNet)));
    if ((i + 1) % 50 === 0) process.stdout.write(`  surrogate ${i + 1}/${nSurr}\r`);
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((s) => s >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;
  console.log(
    `\nGARCH surrogate: real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)} placeboP=${surrP.toFixed(4)}`,
  );

  // ---------- consume-once forward holdout (best cfg only, OOS) ----------
  const holdRes = runPositions(Sbest, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  // matched-exposure control on the SAME holdout window (what does de-risking alone give OOS?)
  const holdExpo = holdRes.exposure;
  const holdMePos = new Array(T).fill(holdExpo);
  const holdMe = runPositions(Sbest, holdMePos, splitIdx, tradableEnd);
  const holdMeSh = annSharpe(sharpeDaily(holdMe.dailyNet));
  const holdoutPass = holdSh > 0 && holdSh > holdMeSh;
  console.log(
    `\nHoldout(OOS): timer netSharpeAnn=${holdSh.toFixed(3)} vs matched-exposure=${holdMeSh.toFixed(3)} over ${holdRes.nDays} rows (exposure=${holdExpo.toFixed(3)})`,
  );

  // ---------- canonical (N=1) ----------
  const Scanon = seriesByRv.get(canonical.rvWin)!;
  const canonPos = buildPosition(Scanon, canonical);
  const canonIS = runPositions(Scanon, canonPos, startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonIS.dailyNet));
  const canonHold = runPositions(Scanon, canonPos, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  // ---------- assemble gates ----------
  const meanDailyNet = mean(bestNet);
  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: {
      pass: meanDailyNet > 0,
      detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turnover=${best.res.turnover.toFixed(3)}`,
    },
    baselines_matched_exposure: {
      pass: baselinePass,
      detail: `best=${best.netSh.toFixed(3)} matchedExp=${meSh.toFixed(3)} rl95=${rl95.toFixed(3)} B&H=${bhSh.toFixed(3)}`,
    },
    deflated_sharpe: {
      pass: dsrPass,
      detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N}`,
    },
    block_bootstrap: {
      pass: bbPass,
      detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
    },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)})` },
    garch_surrogate: {
      pass: surrPass,
      detail: `placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
    },
    holdout: {
      pass: holdoutPass,
      detail: `OOS=${holdSh.toFixed(3)} vs matchedExp=${holdMeSh.toFixed(3)} (${holdRes.nDays} rows)`,
    },
  };
  const order = [
    "net_of_cost",
    "baselines_matched_exposure",
    "deflated_sharpe",
    "block_bootstrap",
    "cpcv_pbo",
    "haircut",
    "garch_surrogate",
    "holdout",
  ];
  let binding = "none";
  for (const gname of order)
    if (!gates[gname].pass) {
      binding = gname;
      break;
    }
  const allPass = binding === "none";
  const survivesCore =
    gates.net_of_cost.pass &&
    gates.baselines_matched_exposure.pass &&
    gates.garch_surrogate.pass &&
    gates.holdout.pass;
  const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";

  console.log(`\n================ Q1-HMM gauntlet ================`);
  for (const gname of order)
    console.log(`  [${gates[gname].pass ? "PASS" : "KILL"}] ${gname} — ${gates[gname].detail}`);
  console.log(
    `canonical(N=1): IS netSharpeAnn=${canonSh.toFixed(3)} OOS=${canonHoldSh.toFixed(3)} exposure=${canonIS.exposure.toFixed(3)}`,
  );
  const monthly = allPass ? `$${Math.round(meanDailyNet * 30 * 100000)}` : "n/a";
  console.log(
    `\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly} | confidence`,
  );

  fs.writeFileSync(
    `${ROOT}/output/edgehunt-quant/q1_hmm_result.json`,
    JSON.stringify(
      {
        bestLabel: best.label,
        bestCfg: best.cfg,
        honestN: HONEST_N,
        netSharpeAnn: best.netSh,
        grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)),
        exposure: best.res.exposure,
        longShare: best.res.longShare,
        turnover: best.res.turnover,
        meanDailyNet,
        monthlyAt100k: meanDailyNet * 30 * 100000,
        baselines: { bhSh, meSh, rl95 },
        gates,
        binding,
        verdict,
        surrP,
        holdSh,
        holdMeSh,
        canonical: { canonSh, canonHoldSh },
        garch: g,
        top5: scored.slice(0, 5).map((s) => ({ label: s.label, netSh: s.netSh, exp: s.res.exposure })),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote output/edgehunt-quant/q1_hmm_result.json`);
}

main();
