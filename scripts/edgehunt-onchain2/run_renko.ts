/**
 * O8-RENKO gauntlet runner.
 *
 * Strategy: causal Renko brick trend timer on BTC, long-flat. Bricks formed on 15m closes (honest,
 * look-ahead-free); daily position = direction of last brick confirmed at day-t close, held over
 * next-day return. Net-of-cost @ 4bps/side taker.
 *
 * Gauntlet (committed primitives, binding order):
 *   net_of_cost -> baselines(B&H/random-lottery) -> deflated_sharpe@honestN -> block_bootstrap
 *   -> cpcv_pbo -> haircut(Harvey-Liu) -> surrogate(vol/spectrum-preserving re-Renko-ize) -> holdout
 *
 * MUST beat its OWN buy&hold after deflation AND beat the vol-preserving surrogate-recompute null.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";
import {
  loadBars15m,
  dailyCloseFrom15m,
  renkoDirections,
  trailingAtrBrick,
  fixedPctBrick,
  phaseRandomize,
  pathFromLogRets,
  type Bar,
} from "./renko_lib.ts";

const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);

// ---------- math ----------
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
function annSharpe(d: number): number {
  return d * ANN;
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

// ---------- daily Renko position from a 15m close path ----------
interface Cfg {
  type: "pct" | "atr";
  val?: number; // pct
  win?: number; // atr window (bars)
  k?: number; // atr mult
  rev: number; // reversal bricks
}
function cfgLabel(c: Cfg): string {
  return c.type === "pct" ? `pct${c.val}_rev${c.rev}` : `atr${c.win}x${c.k}_rev${c.rev}`;
}

// returns long-flat daily position aligned to `idxLastBarOfDay` for a given 15m close path.
function dailyPositionFromPath(
  close15: number[],
  idxLastBarOfDay: number[],
  cfg: Cfg,
): number[] {
  const brick =
    cfg.type === "pct" ? fixedPctBrick(close15, cfg.val!) : trailingAtrBrick(close15, cfg.win!, cfg.k!);
  const st = renkoDirections(close15, brick, cfg.rev);
  return idxLastBarOfDay.map((i) => (st.dirAtBar[i] > 0 ? 1 : 0));
}

// ---------- backtest on daily returns ----------
function runPositions(
  fwdRet: number[],
  position: number[],
  startIdx: number,
  endIdx: number,
): { dailyNet: number[]; dailyGross: number[]; turnover: number; exposure: number; longShare: number; nDays: number } {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0,
    turnSum = 0,
    expSum = 0,
    longCount = 0,
    n = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = fwdRet[t];
    const pos = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(pos)) continue;
    const turn = Math.abs(pos - prev);
    dailyGross.push(pos * fr);
    dailyNet.push(pos * fr - turn * COST_PER_SIDE);
    turnSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    prev = pos;
    n++;
  }
  return {
    dailyNet,
    dailyGross,
    turnover: n ? turnSum / n : 0,
    exposure: n ? expSum / n : 0,
    longShare: n ? longCount / n : 0,
    nDays: n,
  };
}

function toFolds(s: number[], nf: number): number[][] {
  const out: number[][] = [];
  const sz = Math.floor(s.length / nf);
  for (let f = 0; f < nf; f++) {
    const lo = f * sz;
    const hi = f === nf - 1 ? s.length : lo + sz;
    out.push(s.slice(lo, hi));
  }
  return out;
}

// ============================================================ main
function main() {
  const STRENGTHEN = process.argv.includes("--strengthen");
  const NSURR = Number(process.env.NSURR ?? 300);
  const bars: Bar[] = loadBars15m();
  const close15 = bars.map((b) => b.close);
  const { dates, idxLastBarOfDay } = dailyCloseFrom15m(bars);
  const T = dates.length;
  const dailyClose = idxLastBarOfDay.map((i) => close15[i]);
  const fwdRet: number[] = [];
  for (let t = 0; t < T; t++) fwdRet.push(t + 1 < T ? Math.log(dailyClose[t + 1] / dailyClose[t]) : NaN);

  // precompute 15m log-returns for the surrogate (vol/spectrum-preserving)
  const logr15 = new Array(close15.length - 1);
  for (let i = 1; i < close15.length; i++) logr15[i - 1] = Math.log(close15[i] / close15[i - 1]);

  // warmup: largest atr window in days-equivalent; start trading after 60 daily rows (atr win 96-384 bars ~ 1-4 days; use 60d buffer for vol estimate stability)
  const startIdx = 60;
  const holdoutFrac = 0.2;
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));

  // ---- config grid (honest N) ----
  let configs: Cfg[];
  if (STRENGTHEN) {
    configs = [];
    for (const val of [0.5, 0.75, 1.0, 1.5, 2.0, 3.0])
      for (const rev of [1, 2]) configs.push({ type: "pct", val, rev });
    for (const win of [48, 96, 192, 384])
      for (const k of [1.5, 2, 2.5, 3])
        for (const rev of [1, 2]) configs.push({ type: "atr", win, k, rev });
  } else {
    // pre-committed-ish modest grid
    configs = [
      { type: "pct", val: 1.0, rev: 1 },
      { type: "pct", val: 2.0, rev: 1 },
      { type: "atr", win: 96, k: 2, rev: 1 },
      { type: "atr", win: 96, k: 3, rev: 2 },
      { type: "atr", win: 192, k: 2, rev: 1 },
    ];
  }
  const HONEST_N = configs.length;
  // canonical pre-registered config: 1% fixed-pct brick, 1-brick reversal (the textbook Renko default)
  const canonical: Cfg = { type: "pct", val: 1.0, rev: 1 };

  // ---- score every config IN-SAMPLE on net Sharpe ----
  const scored = configs.map((cfg) => {
    const pos = dailyPositionFromPath(close15, idxLastBarOfDay, cfg);
    const res = runPositions(fwdRet, pos, startIdx, splitIdx);
    return { cfg, label: cfgLabel(cfg), pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // ---- baselines ----
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(fwdRet, bhPos, startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
    const r = runPositions(fwdRet, pos, startIdx, splitIdx);
    rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // ---- deflated sharpe @ honest N ----
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---- block bootstrap ----
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 20,
    confidenceLevel: 0.95,
    seed: "renko-bb",
  });
  const bbPass = bb.lower > 0;

  // ---- cscv / pbo ----
  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try {
    const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch {
    pbo = { pbo: 1, medianLogit: 0 };
  }
  const pboPass = pbo.pbo < 0.5;

  // ---- Harvey-Liu Bonferroni haircut ----
  const psrP = 1 - normalCdf(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---- THE RIGHT NULL: vol/spectrum-preserving surrogate-RECOMPUTE ----
  // phase-randomize 15m log-returns (preserves power spectrum => vol + autocorrelation), rebuild
  // the intraday price path, RE-RENKO-IZE with the SAME best cfg, rebuild daily position.
  function surrogateSharpe(cfg: Cfg, seedBase: number, n: number): number[] {
    const out: number[] = [];
    const p0 = close15[0];
    for (let i = 0; i < n; i++) {
      const rng = mkRng(seedBase + i * 7919);
      const surrRets = phaseRandomize(logr15, rng);
      const surrPath = pathFromLogRets(p0, surrRets); // length = close15.length
      const pos = dailyPositionFromPath(surrPath, idxLastBarOfDay, cfg);
      // surrogate path's daily close for fair return attribution (its OWN path, not the real one)
      const surrDailyClose = idxLastBarOfDay.map((j) => surrPath[j]);
      const surrFwd: number[] = [];
      for (let t = 0; t < T; t++)
        surrFwd.push(t + 1 < T ? Math.log(surrDailyClose[t + 1] / surrDailyClose[t]) : NaN);
      const r = runPositions(surrFwd, pos, startIdx, splitIdx);
      out.push(annSharpe(sharpeDaily(r.dailyNet)));
    }
    return out;
  }
  const surr = surrogateSharpe(best.cfg, 7000, NSURR).sort((a, b) => a - b);
  const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (NSURR + 1);
  const surrPass = surrP < 0.05;

  // ---- consume-once holdout (best cfg, OOS tail) ----
  const holdRes = runPositions(fwdRet, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  // holdout must also beat its OWN B&H on the holdout window (Renko trap: rising asset)
  const bhHold = runPositions(fwdRet, bhPos, splitIdx, tradableEnd);
  const bhHoldSh = annSharpe(sharpeDaily(bhHold.dailyNet));
  const holdoutPass = holdSh > 0 && holdSh > bhHoldSh;

  // ---- canonical (N=1) ----
  const canonPos = dailyPositionFromPath(close15, idxLastBarOfDay, canonical);
  const canonRes = runPositions(fwdRet, canonPos, startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr = surrogateSharpe(canonical, 99000, NSURR).sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (NSURR + 1);
  const canonHold = runPositions(fwdRet, canonPos, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  // ---- gates ----
  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: { pass: mean(bestNet) > 0, detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)}` },
    baselines: { pass: baselinePass, detail: `bestNetSh=${best.netSh.toFixed(3)} vs ownB&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}` },
    deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}` },
    block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)}*N=${HONEST_N})` },
    surrogate: { pass: surrPass, detail: `volPreservingP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(NSURR * 0.95)].toFixed(3)}` },
    holdout: { pass: holdoutPass, detail: `OOS netSh=${holdSh.toFixed(3)} vs OOS B&H=${bhHoldSh.toFixed(3)} over ${holdRes.nDays} rows` },
  };
  const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
  let binding = "none";
  for (const g of order) if (!gates[g].pass) { binding = g; break; }
  const allPass = binding === "none";
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";

  const meanDailyNet = mean(bestNet);
  const monthlyAt100k = meanDailyNet * 30 * 100000;

  console.log(`\n================ O8-RENKO ${STRENGTHEN ? "(strengthened grid)" : "(committed grid)"} ================`);
  console.log(`data: BTC 15m ${dates[0]}..${dates[T - 1]}  dailyRows=${T} startIdx=${startIdx} splitIdx=${splitIdx} holdout=${tradableEnd - splitIdx}`);
  console.log(`honestN=${HONEST_N}  best=${best.label}`);
  console.log(`best netSharpeAnn=${best.netSh.toFixed(3)} grossSharpeAnn=${annSharpe(sharpeDaily(best.res.dailyGross)).toFixed(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)} longShare=${best.res.longShare.toFixed(2)} nDays=${best.res.nDays}`);
  console.log(`OWN buy&hold netSharpeAnn (in-sample) = ${bhSh.toFixed(3)}`);
  for (const g of order) console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
  console.log(`canonical(${cfgLabel(canonical)}): netSh=${canonSh.toFixed(3)} surrP=${canonSurrP.toFixed(4)} holdoutSh=${canonHoldSh.toFixed(3)}`);
  const monthly = binding === "none" ? `$${Math.round(monthlyAt100k)}` : "n/a";
  console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly} | confidence`);

  // persist
  const out = {
    name: "O8-RENKO",
    mode: STRENGTHEN ? "strengthen" : "committed",
    data: { dates0: dates[0], dates1: dates[T - 1], dailyRows: T, startIdx, splitIdx, holdoutRows: tradableEnd - splitIdx },
    honestN: HONEST_N,
    best: { label: best.label, cfg: best.cfg, netSharpeAnn: best.netSh, grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)), turnover: best.res.turnover, exposure: best.res.exposure, longShare: best.res.longShare, nDays: best.res.nDays, meanDailyNet, monthlyAt100k },
    ownBuyHoldSharpeAnn: bhSh,
    gates,
    binding,
    verdict,
    surrogateP: surrP,
    holdoutSharpeAnn: holdSh,
    holdoutBuyHoldSharpeAnn: bhHoldSh,
    canonical: { label: cfgLabel(canonical), netSharpeAnn: canonSh, surrogateP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
    allConfigsInSample: scored.map((s) => ({ label: s.label, netSh: s.netSh, turnover: s.res.turnover, longShare: s.res.longShare })),
  };
  const fname = `output/edgehunt-onchain2/renko_${STRENGTHEN ? "strengthen" : "committed"}.json`;
  fs.writeFileSync(fname, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${fname}`);
}
main();
