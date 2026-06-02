/**
 * INDEPENDENT AUDIT (methodology auditor, NOT the original tester).
 *
 * Decisive check for the AGENTS.md edge-search index: the BTC exchange reserve-depletion lead is the
 * closest-to-survivor. AGENTS.md line 181 presents the FIRST-PASS framing (pre-registered, clears
 * DSR@N=1 on the forward tail, ~$1,858/mo). The deepening (output/edgehunt-deepen/) downgraded it:
 * the "pre-registered" config is the ARGMAX of a searched ~10-config neighborhood, so honest N is NOT
 * 1 — deflated by the neighborhood the surrogate significance fails.
 *
 * This script reproduces, from scratch and from the committed primitives only:
 *   1. the pre-registered config (smooth=14,zwin=365,thr=1.0,lag=1,long/flat) net Sharpe on the
 *      consume-once forward tail (last 20%);
 *   2. its surrogate p at N=1 (phase-randomized signal null);
 *   3. the surrogate p of EVERY config in the plausible searched neighborhood, and the family-wise
 *      MAX-stat / Bonferroni deflation of the pre-registered config's significance across that grid.
 *
 * Verdict logic: if the prereg config is the in-sample argmax of the neighborhood, honest N = grid
 * size, and the multiple-testing-corrected significance is what binds. We report both so the
 * PROMISING-vs-SURVIVE boundary is auditable.
 *
 * Writes ONLY to output/edgehunt-audit/. Reuses scripts/edgehunt-D5/harness.ts data + primitives.
 */
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";
import {
  loadPanel, runPositions, ema, rollingZ, mkRng, sharpeDaily, annSharpe, mean, type Panel,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import fs from "node:fs";

const LAG = 1;
const lag = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
function netZ(P: Panel, smooth: number, zwin: number): number[] {
  const fin = lag(P.flowInNtv, LAG), fout = lag(P.flowOutNtv, LAG);
  const net = P.price.map((_, t) => (Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN));
  return rollingZ(ema(net, smooth), zwin);
}
function posFrom(P: Panel, z: number[], thr: number): number[] {
  const p = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    p[t] = z[t] <= -thr ? 1 : 0; // long/flat
  }
  return p;
}
function surrogateP(P: Panel, z: number[], thr: number, lo: number, hi: number, realNet: number, nSurr = 400, seed = 13000): number {
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(seed + i * 7919);
    const sp = posFrom(P, phaseRandomize(z, rng), thr);
    surr.push(annSharpe(sharpeDaily(runPositions(P, sp, lo, hi).dailyNet)));
  }
  return (surr.filter((s) => s >= realNet).length + 1) / (nSurr + 1);
}

const P = loadPanel("btc");
const T = P.price.length;
const startIdx = 700;
const tradableEnd = T - 1;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);

// ---- pre-registered config, FORWARD consume-once tail ----
const PRE = { smooth: 14, zwin: 365, thr: 1.0 };
const zPre = netZ(P, PRE.smooth, PRE.zwin);
const pPre = posFrom(P, zPre, PRE.thr);
const fwd = runPositions(P, pPre, splitIdx, tradableEnd);
const fwdNet = annSharpe(sharpeDaily(fwd.dailyNet));
const dsrFwd1 = computeDeflatedSharpeRatio(fwd.dailyNet, { trialCount: 1 });
const sPfwd = surrogateP(P, zPre, PRE.thr, splitIdx, tradableEnd, fwdNet, 400, 21000);

// in-sample window for the neighborhood-search honest-N test
const inS = runPositions(P, pPre, startIdx, splitIdx);
const inSNet = annSharpe(sharpeDaily(inS.dailyNet));
const sPin = surrogateP(P, zPre, PRE.thr, startIdx, splitIdx, inSNet, 400, 13000);

// ---- the plausible searched neighborhood (what an honest N must count) ----
const smooths = [7, 14, 21];
const zwins = [180, 365];
const thrs = [0.5, 1.0];
const grid: { cfg: { smooth: number; zwin: number; thr: number }; netIn: number; surrP: number }[] = [];
for (const smooth of smooths) for (const zwin of zwins) for (const thr of thrs) {
  const z = netZ(P, smooth, zwin);
  const p = posFrom(P, z, thr);
  const r = runPositions(P, p, startIdx, splitIdx);
  const netIn = annSharpe(sharpeDaily(r.dailyNet));
  const sp = surrogateP(P, z, thr, startIdx, splitIdx, netIn, 250, 31000 + smooth * 13 + zwin + Math.round(thr * 10));
  grid.push({ cfg: { smooth, zwin, thr }, netIn, surrP: sp });
}
grid.sort((a, b) => b.netIn - a.netIn);
const N = grid.length;
const preIsArgmax = grid[0].cfg.smooth === PRE.smooth && grid[0].cfg.zwin === PRE.zwin && grid[0].cfg.thr === PRE.thr;
// rank of the prereg config by in-sample net Sharpe
const preRank = grid.findIndex((g) => g.cfg.smooth === PRE.smooth && g.cfg.zwin === PRE.zwin && g.cfg.thr === PRE.thr) + 1;
const preGrid = grid.find((g) => g.cfg.smooth === PRE.smooth && g.cfg.zwin === PRE.zwin && g.cfg.thr === PRE.thr)!;
// family-wise deflation of the prereg surrogate p across the searched neighborhood
const bonfP = Math.min(1, preGrid.surrP * N);
const keepSurr = grid.filter((g) => g.surrP < 0.05).length;

const out = {
  note: "Independent audit of the reserve lead honest-N claim. Primitives from src/lib/training/statistical-validation.ts only.",
  preRegisteredConfig: PRE,
  forwardConsumeOnce: {
    netSharpeAnn: Number(fwdNet.toFixed(4)),
    dsrAtN1: Number(dsrFwd1.deflatedProbability.toFixed(4)),
    surrogateP_N1: Number(sPfwd.toFixed(4)),
    exposure: Number(fwd.exposure.toFixed(4)),
    nDays: fwd.nDays,
    monthlyAt100k: Math.round(mean(fwd.dailyNet) * 30 * 100000),
  },
  inSample: {
    netSharpeAnn: Number(inSNet.toFixed(4)),
    surrogateP_N1: Number(sPin.toFixed(4)),
  },
  searchedNeighborhood: {
    gridSize_honestN: N,
    preRegRankByInSampleNet: preRank,
    preRegIsInSampleArgmax: preIsArgmax,
    preRegSurrogateP_singleConfig: Number(preGrid.surrP.toFixed(4)),
    bonferroniDeflatedP_acrossGrid: Number(bonfP.toFixed(4)),
    configsKeepingSurrogateSig: `${keepSurr}/${N}`,
    grid: grid.map((g) => ({ ...g.cfg, netIn: Number(g.netIn.toFixed(3)), surrP: Number(g.surrP.toFixed(4)) })),
  },
  auditConclusion:
    bonfP >= 0.05
      ? `HONEST-N CONFIRMED: prereg surrogate p=${preGrid.surrP.toFixed(3)} at N=1 deflates to ${bonfP.toFixed(3)} across the N=${N} searched grid -> FAILS multiple-testing. Lead is correctly capped at PROMISING, not SURVIVE. Matches the deepening downgrade.`
      : `prereg surrogate survives Bonferroni across N=${N} (p=${bonfP.toFixed(3)}); would NOT support the deepening downgrade — re-examine.`,
};
fs.writeFileSync("output/edgehunt-audit/reserve_honest_n_check.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
