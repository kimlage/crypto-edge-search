/**
 * INDEPENDENT AUDIT (methodology auditor) — D5-08 reserve/netflow PROMISING soundness.
 *
 * The committed harness runs the phase-randomization surrogate ONLY on the in-sample-selected
 * grid-best config (smooth7/zwin365/thr0.5/longflat), with NO family-wise correction. It reports
 * placeboP=0.013 -> surrogate gate PASS -> contributes to the PROMISING verdict (the SURVIVE cap
 * is DSR@N=54). The committed STANDARD, however, demands a family-wise MAX-stat surrogate for a
 * searched grid: the real grid-best Sharpe must beat the 95th pct of the *max-over-configs*
 * surrogate Sharpe drawn from the SAME 54-config grid under one shared phase scramble per draw.
 *
 * Decisive question: is D5-08's surrogate-pass genuine signal, or a multiple-testing artifact that
 * would make the correct verdict KILL (not PROMISING)?
 *
 * This reproduces the exact 54-config grid + the harness's selection (in-sample net Sharpe argmax),
 * then builds the family-wise null: for each surrogate draw, phase-randomize the netflow series ONCE
 * with a fresh seed, rebuild ALL 54 configs on that single scrambled feature, take the MAX in-sample
 * net Sharpe across configs. The family-wise p = P(maxSurr >= realGridBest).
 *
 * Writes ONLY to output/edgehunt-audit/. Reuses scripts/edgehunt-D5 data + primitives.
 */
import { computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation.ts";
import {
  loadPanel, runPositions, ema, rollingZ, mkRng, sharpeDaily, annSharpe, mean, type Panel,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import fs from "node:fs";

const LAG = 1;
const lag = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };

const P = loadPanel("btc");
const T = P.price.length;
const startIdx = 700;
const tradableEnd = T - 1;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);

const fin = lag(P.flowInNtv, LAG), fout = lag(P.flowOutNtv, LAG);
const netInflow = P.price.map((_, t) => (Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN));
function signal(smooth: number, zwin: number): number[] { return rollingZ(ema(netInflow, smooth), zwin); }

const smooths = [7, 14, 30], zwins = [90, 180, 365], thrs = [0.5, 1, 1.5], sides = ["longflat", "longshort"];
interface Cfg { smooth: number; zwin: number; thr: number; side: string }
const configs: Cfg[] = [];
for (const s of smooths) for (const zw of zwins) for (const th of thrs) for (const sd of sides) configs.push({ smooth: s, zwin: zw, thr: th, side: sd });

function build(cfg: Cfg, sig: number[]): number[] {
  const pos = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    if (!Number.isFinite(sig[t])) continue;
    if (sig[t] <= -cfg.thr) pos[t] = 1;
    else if (sig[t] >= cfg.thr) pos[t] = cfg.side === "longshort" ? -1 : 0;
    else pos[t] = 0;
  }
  return pos;
}
// precompute the real signal per (smooth,zwin) — the only thing that varies the feature
const realSig = new Map<string, number[]>();
for (const s of smooths) for (const zw of zwins) realSig.set(`${s}|${zw}`, signal(s, zw));

// ---- real grid-best (in-sample net Sharpe argmax) ----
let best = { cfg: configs[0], netIn: -Infinity, dailyNet: [] as number[] };
for (const cfg of configs) {
  const sig = realSig.get(`${cfg.smooth}|${cfg.zwin}`)!;
  const r = runPositions(P, build(cfg, sig), startIdx, splitIdx);
  const netIn = annSharpe(sharpeDaily(r.dailyNet));
  if (netIn > best.netIn) best = { cfg, netIn, dailyNet: r.dailyNet };
}

// ---- naive per-config surrogate p for the grid-best (reproduces harness placeboP) ----
const bestSig = realSig.get(`${best.cfg.smooth}|${best.cfg.zwin}`)!;
const naiveSurr: number[] = [];
for (let i = 0; i < 400; i++) {
  const rng = mkRng(7000 + i * 7919);
  const r = runPositions(P, build(best.cfg, phaseRandomize(bestSig, rng)), startIdx, splitIdx);
  naiveSurr.push(annSharpe(sharpeDaily(r.dailyNet)));
}
const naiveP = (naiveSurr.filter((s) => s >= best.netIn).length + 1) / (naiveSurr.length + 1);

// ---- FAMILY-WISE MAX-stat surrogate: one scramble per (smooth,zwin) base series per draw, max over all 54 configs ----
const NDRAW = 400;
const maxSurr: number[] = [];
for (let i = 0; i < NDRAW; i++) {
  // scramble each base (smooth,zwin) feature once with a draw-specific seed, then take max net Sharpe over all 54 configs
  const scrambled = new Map<string, number[]>();
  for (const s of smooths) for (const zw of zwins) {
    const rng = mkRng(500000 + i * 104729 + s * 131 + zw);
    scrambled.set(`${s}|${zw}`, phaseRandomize(realSig.get(`${s}|${zw}`)!, rng));
  }
  let mx = -Infinity;
  for (const cfg of configs) {
    const r = runPositions(P, build(cfg, scrambled.get(`${cfg.smooth}|${cfg.zwin}`)!), startIdx, splitIdx);
    const v = annSharpe(sharpeDaily(r.dailyNet));
    if (v > mx) mx = v;
  }
  maxSurr.push(mx);
}
maxSurr.sort((a, b) => a - b);
const fwP = (maxSurr.filter((s) => s >= best.netIn).length + 1) / (maxSurr.length + 1);
const fw95 = maxSurr[Math.floor(NDRAW * 0.95)];

const dsr54 = computeDeflatedSharpeRatio(best.dailyNet, { trialCount: 54 });

const out = {
  note: "D5-08 family-wise MAX-stat surrogate audit. The harness surrogate gate is per-best-config (no FWER). This adds the MAX-stat null the standard demands for a 54-config grid.",
  gridBest: { ...best.cfg, netInSample: Number(best.netIn.toFixed(4)) },
  honestN: configs.length,
  naivePerConfigSurrogateP: Number(naiveP.toFixed(4)),
  familyWise: {
    maxStatSurrogateP: Number(fwP.toFixed(4)),
    maxStatSurr95: Number(fw95.toFixed(4)),
    realGridBest: Number(best.netIn.toFixed(4)),
    passesFamilyWiseSurrogate: best.netIn > fw95,
  },
  dsrAtN54: Number(dsr54.deflatedProbability.toFixed(4)),
  verdictLogic:
    best.netIn > fw95
      ? "Grid-best real Sharpe EXCEEDS family-wise max-stat surr95 -> surrogate edge is genuine even after FWER; PROMISING (capped by DSR) is sound, not an artifact."
      : "Grid-best real Sharpe does NOT exceed family-wise max-stat surr95 -> the surrogate-pass is a multiple-testing artifact; under the FWER surrogate the core gate FAILS and the correct verdict is KILL, not PROMISING.",
};
fs.writeFileSync("output/edgehunt-audit/d5_08_familywise_surrogate.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
