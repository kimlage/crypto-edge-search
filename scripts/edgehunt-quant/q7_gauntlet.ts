/**
 * Q7-VOLREGIME gauntlet (docs/BACKLOG.md D3-A4). Does a previously-killed signal (TSMOM or RSI)
 * revive when GATED to a realized-vol regime?
 *
 * Strategy family (every config counted in HONEST N):
 *   base signal  s ∈ { TSMOM(L), RSI(L) }
 *   direction rule:
 *     TSMOM -> trend-follow: pos_raw = sign(trailing ret over L)   (long-only or long/short)
 *     RSI   -> mean-revert : pos_raw = +1 if RSI<lo, -1 if RSI>hi  (long/short or long-only)
 *   vol regime gate: trailing realized vol RV(volWin); regime label = trailing pct-rank of RV.
 *     gateSide = "calm" -> trade only when rank <= thresh (low vol)   [momentum-in-calm]
 *     gateSide = "storm"-> trade only when rank >= thresh (high vol)  [reversion-in-crisis]
 *   gated position = pos_raw masked by the regime gate.
 *
 * NULLS:
 *   (A) GARCH(1,1) surrogate — re-simulate zero-edge vol-clustering price paths; rebuild the SAME
 *       gated strategy on each path; p = P(surrogate netSharpe >= real). The honest test of "is the
 *       gated edge just an artifact of vol clustering + regime labeling?"
 *   (B) MATCHED-EXPOSURE control — the UNGATED killed signal scaled to the SAME avg |exposure| as
 *       the gated book (random thinning to match exposure). The gate must beat de-risking, i.e.
 *       best gated netSharpe must exceed the matched-exposure control's netSharpe.
 *   plus B&H and random-lottery@matched-exposure baselines.
 *
 * GAUNTLET PRIMITIVES (committed): computeDeflatedSharpeRatio, estimateCscvPbo,
 * blockBootstrapConfidenceInterval, summarizeReturnSeries from src/lib/training/statistical-validation.ts.
 * Deflated Sharpe @ HONEST N, CPCV/PBO, Harvey-Liu Bonferroni haircut, GARCH surrogate null,
 * consume-once forward holdout (last 20%).
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";
import {
  loadDailyBTC,
  realizedVol,
  trailingPctRank,
  tsmomSignal,
  rsi,
  runPositions,
  annSharpe,
  sharpeDaily,
  mean,
  mkRng,
  fitGarch11,
  simulateGarchCloses,
  barsFromCloses,
  type DailyBars,
} from "./q7_lib.ts";

const ROOT = ".";
const ANN = Math.sqrt(365);

// ---------------- config grid (HONEST N = every one) ----------------
type Cfg = {
  sig: "tsmom" | "rsi";
  L: number; // signal lookback
  side: "long" | "ls"; // long-only or long/short
  volWin: number; // realized-vol window
  rankWin: number; // window for trailing pct-rank of RV (regime label)
  gate: "calm" | "storm" | "none";
  thresh: number; // pct-rank threshold for the gate
};

function buildGrid(): Cfg[] {
  const cfgs: Cfg[] = [];
  const Ls_tsmom = [20, 50, 100];
  const Ls_rsi = [7, 14];
  const volWins = [10, 20, 40];
  const rankWins = [180, 365];
  const threshes = [0.3, 0.4, 0.5, 0.6, 0.7];
  const gates: Cfg["gate"][] = ["calm", "storm"];
  for (const L of Ls_tsmom) {
    for (const side of ["long", "ls"] as const) {
      for (const volWin of volWins) {
        for (const rankWin of rankWins) {
          for (const gate of gates) {
            for (const thresh of threshes) {
              cfgs.push({ sig: "tsmom", L, side, volWin, rankWin, gate, thresh });
            }
          }
        }
      }
    }
  }
  for (const L of Ls_rsi) {
    for (const side of ["long", "ls"] as const) {
      for (const volWin of volWins) {
        for (const rankWin of rankWins) {
          for (const gate of gates) {
            for (const thresh of threshes) {
              cfgs.push({ sig: "rsi", L, side, volWin, rankWin, gate, thresh });
            }
          }
        }
      }
    }
  }
  return cfgs;
}

function cfgLabel(c: Cfg): string {
  return `${c.sig}|L=${c.L}|${c.side}|vw=${c.volWin}|rw=${c.rankWin}|${c.gate}|th=${c.thresh}`;
}

// raw (ungated) position for the base killed signal
function rawPosition(B: DailyBars, c: Cfg): number[] {
  const T = B.close.length;
  const out = new Array(T).fill(NaN);
  if (c.sig === "tsmom") {
    const sig = tsmomSignal(B.close, c.L);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(sig[t])) continue;
      const s = Math.sign(sig[t]);
      out[t] = c.side === "long" ? (s > 0 ? 1 : 0) : s;
    }
  } else {
    const ind = rsi(B.close, c.L);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(ind[t])) continue;
      const long = ind[t] < 30 ? 1 : 0;
      const short = ind[t] > 70 ? -1 : 0;
      out[t] = c.side === "long" ? long : long + short;
    }
  }
  return out;
}

// vol-regime gate mask (1=trade, 0=flat) — causal pct-rank of trailing RV
function gateMask(B: DailyBars, c: Cfg): number[] {
  const T = B.close.length;
  if (c.gate === "none") return new Array(T).fill(1);
  const rv = realizedVol(B.ret, c.volWin);
  const rank = trailingPctRank(rv, c.rankWin);
  const out = new Array(T).fill(0);
  for (let t = 0; t < T; t++) {
    if (!Number.isFinite(rank[t])) continue;
    if (c.gate === "calm") out[t] = rank[t] <= c.thresh ? 1 : 0;
    else out[t] = rank[t] >= c.thresh ? 1 : 0;
  }
  return out;
}

function gatedPosition(B: DailyBars, c: Cfg): number[] {
  const raw = rawPosition(B, c);
  const mask = gateMask(B, c);
  return raw.map((p, t) => (Number.isFinite(p) ? p * mask[t] : NaN));
}

// --------------- main ---------------
const B = loadDailyBTC();
const T = B.close.length;
const START = 400; // warmup for rankWin=365 + signal lookbacks
const tradableEnd = T - 1;
const HOLDOUT_FRAC = 0.2;
const span = tradableEnd - START;
const splitIdx = START + Math.floor(span * (1 - HOLDOUT_FRAC));

const grid = buildGrid();
const HONEST_N = grid.length;

// score every config IN-SAMPLE on net Sharpe
const scored = grid.map((c) => {
  const pos = gatedPosition(B, c);
  const res = runPositions(B, pos, START, splitIdx);
  return { c, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestNet = best.res.dailyNet;

// ---- baselines ----
const bh = runPositions(B, new Array(T).fill(1), START, splitIdx);
const bhSh = annSharpe(sharpeDaily(bh.dailyNet));

// random-lottery @ matched exposure of best
const exposure = best.res.exposure;
const rlSh: number[] = [];
for (let i = 0; i < 300; i++) {
  const rng = mkRng(424242 + i * 2654435761);
  const pos = new Array(T).fill(0);
  for (let t = START; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
  const r = runPositions(B, pos, START, splitIdx);
  rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
}
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];

// ---- MATCHED-EXPOSURE control (the key trap): ungated killed signal thinned to best's exposure ----
// take the SAME base signal+side+L as the best config, UNGATED, randomly thin to match exposure.
const baseCfg: Cfg = { ...best.c, gate: "none", thresh: 0 };
const baseRaw = rawPosition(B, baseCfg); // ungated raw position
// ungated exposure:
let ung = 0,
  ungN = 0;
for (let t = START; t < splitIdx; t++) {
  if (Number.isFinite(baseRaw[t])) {
    ung += Math.abs(baseRaw[t]);
    ungN++;
  }
}
const ungExposure = ungN ? ung / ungN : 0;
const keepProb = ungExposure > 0 ? Math.min(1, exposure / ungExposure) : 0;
const meCtrlSh: number[] = [];
for (let i = 0; i < 300; i++) {
  const rng = mkRng(913131 + i * 40503);
  const pos = new Array(T).fill(NaN);
  for (let t = START; t < splitIdx; t++) {
    if (!Number.isFinite(baseRaw[t])) continue;
    pos[t] = rng() < keepProb ? baseRaw[t] : 0;
  }
  const r = runPositions(B, pos, START, splitIdx);
  meCtrlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
}
meCtrlSh.sort((a, b) => a - b);
const meCtrlMean = mean(meCtrlSh);
const meCtrl95 = meCtrlSh[Math.floor(meCtrlSh.length * 0.95)];
// the gate must beat the matched-exposure control's 95th pct (must beat de-risking, strongly)
const matchedExposurePass = best.netSh > meCtrl95;

const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0 && matchedExposurePass;

// ---- Deflated Sharpe @ honest N ----
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;

// ---- block bootstrap CI on mean daily net ----
const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 20,
  confidenceLevel: 0.95,
  seed: "q7-bb",
});
const bbPass = bb.lower > 0;

// ---- CSCV / PBO ----
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
const NFOLDS = 6;
const cscv = scored.map((s, i) => ({ id: `${i}:${cfgLabel(s.c)}`, folds: toFolds(s.res.dailyNet, NFOLDS) }));
let pbo = { pbo: 1, medianLogit: 0 };
try {
  const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
} catch (e) {
  pbo = { pbo: 1, medianLogit: 0 };
}
const pboPass = pbo.pbo < 0.5;

// ---- Harvey-Liu Bonferroni haircut ----
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
const psrP = 1 - normalCdf(zSharpe(bestNet));
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// ---- GARCH(1,1) surrogate null (THE RIGHT null for vol-clustering strategies) ----
const g = fitGarch11(B.ret);
const NSURR = 400;
const surr: number[] = [];
for (let i = 0; i < NSURR; i++) {
  const rng = mkRng(7000 + i * 7919);
  const closes = simulateGarchCloses(g, B.close[0], T, rng);
  const Bs = barsFromCloses(B, closes);
  const pos = gatedPosition(Bs, best.c);
  const r = runPositions(Bs, pos, START, splitIdx);
  surr.push(annSharpe(sharpeDaily(r.dailyNet)));
}
surr.sort((a, b) => a - b);
const surrAbove = surr.filter((s) => s >= best.netSh).length;
const surrP = (surrAbove + 1) / (NSURR + 1);
const surrPass = surrP < 0.05;

// ---- consume-once forward holdout (best cfg only) ----
const holdRes = runPositions(B, best.pos, splitIdx, tradableEnd);
const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
const holdoutPass = holdSh > 0;

// ---- pre-registered canonical (N=1): the lab's stated belief = momentum-in-calm ----
// TSMOM L=50 long-only, gated to calm regime (RV20 trailing rank <= 0.5), rankWin=365.
const canon: Cfg = { sig: "tsmom", L: 50, side: "long", volWin: 20, rankWin: 365, gate: "calm", thresh: 0.5 };
const canonPos = gatedPosition(B, canon);
const canonRes = runPositions(B, canonPos, START, splitIdx);
const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
const canonSurr: number[] = [];
for (let i = 0; i < NSURR; i++) {
  const rng = mkRng(99000 + i * 7919);
  const closes = simulateGarchCloses(g, B.close[0], T, rng);
  const Bs = barsFromCloses(B, closes);
  const r = runPositions(Bs, gatedPosition(Bs, canon), START, splitIdx);
  canonSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
}
canonSurr.sort((a, b) => a - b);
const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
const canonHold = runPositions(B, canonPos, splitIdx, tradableEnd);
const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

// ---- assemble gates ----
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: {
    pass: mean(bestNet) > 0,
    detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)}`,
  },
  baselines: {
    pass: baselinePass,
    detail: `bestNetSh=${best.netSh.toFixed(3)} | B&H=${bhSh.toFixed(3)} | randLot95=${rl95.toFixed(3)} | matchedExpCtrl(mean/95)=${meCtrlMean.toFixed(3)}/${meCtrl95.toFixed(3)} matchedExpPass=${matchedExposurePass}`,
  },
  deflated_sharpe: {
    pass: dsrPass,
    detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} bestDailySh=${summarizeReturnSeries(bestNet).sharpe.toFixed(4)}`,
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
  surrogate_garch: {
    pass: surrPass,
    detail: `GARCH-surrP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(NSURR * 0.95)].toFixed(3)}`,
  },
  holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays} rows` },
};

const order = [
  "net_of_cost",
  "baselines",
  "deflated_sharpe",
  "block_bootstrap",
  "cpcv_pbo",
  "haircut",
  "surrogate_garch",
  "holdout",
];
let binding = "none";
for (const gName of order) {
  if (!gates[gName].pass) {
    binding = gName;
    break;
  }
}
const allPass = binding === "none";
const survivesCore =
  gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate_garch.pass && gates.holdout.pass;
let verdict: "SURVIVE" | "PROMISING" | "KILL";
if (allPass) verdict = "SURVIVE";
else if (survivesCore) verdict = "PROMISING";
else verdict = "KILL";

const meanDailyNet = mean(bestNet);
const monthlyAt100k = meanDailyNet * 30 * 100000;

console.log(`\n================ Q7-VOLREGIME (D3-A4 realized-vol regime gating) ================`);
console.log(`daily BTC ${B.dates[0]}..${B.dates[T - 1]} | in-sample ${B.dates[START]}..${B.dates[splitIdx]} | holdout ${B.dates[splitIdx]}..${B.dates[tradableEnd]}`);
console.log(`honestN=${HONEST_N}  best=${cfgLabel(best.c)}`);
console.log(
  `best netSharpeAnn=${best.netSh.toFixed(3)} grossSharpeAnn=${annSharpe(sharpeDaily(best.res.dailyGross)).toFixed(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)} longShare=${best.res.longShare.toFixed(2)} nDays=${best.res.nDays}`,
);
console.log(`top5 in-sample:`);
for (const s of scored.slice(0, 5)) console.log(`   ${s.netSh.toFixed(3)}  ${cfgLabel(s.c)}`);
for (const gName of order) console.log(`  [${gates[gName].pass ? "PASS" : "KILL"}] ${gName} — ${gates[gName].detail}`);
console.log(
  `canonical(momentum-in-calm TSMOM50 long, RV20 rank<=0.5): netSharpeAnn=${canonSh.toFixed(3)} GARCH-surrP=${canonSurrP.toFixed(4)} holdoutSharpeAnn=${canonHoldSh.toFixed(3)}`,
);
const monthly = binding === "none" ? `$${Math.round(monthlyAt100k)}` : "n/a";
console.log(
  `\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${holdSh.toFixed(3)}`,
);

fs.writeFileSync(
  `${ROOT}/output/edgehunt-quant/q7_volregime_result.json`,
  JSON.stringify(
    {
      honestN: HONEST_N,
      best: { cfg: best.c, netSharpeAnn: best.netSh, exposure: best.res.exposure, turnover: best.res.turnover, nDays: best.res.nDays },
      baselines: { bhSh, rl95, meCtrlMean, meCtrl95, matchedExposurePass },
      gates,
      binding,
      verdict,
      surrP,
      holdSh,
      canonical: { canonSh, canonSurrP, canonHoldSh },
      garch: g,
      monthlyAt100k,
    },
    null,
    2,
  ),
);
console.log(`\nwrote output/edgehunt-quant/q7_volregime_result.json`);
