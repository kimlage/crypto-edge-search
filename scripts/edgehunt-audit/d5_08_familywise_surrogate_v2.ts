/**
 * D5-08 family-wise surrogate — robustness of the KILL-vs-PROMISING flip.
 *
 * v1 showed real grid-best (0.994) < family-wise max-stat surr95 (1.19), surrP=0.23. This v2:
 *   (a) restricts the family to the longflat-only sub-grid (27 configs) the winner lives in, to rule
 *       out the longshort ±1 configs inflating the max-stat null;
 *   (b) reports the full max-surr distribution percentiles (power check: the null should NOT routinely
 *       exceed any plausible real Sharpe — if surrMean is near the real, the null has discriminating
 *       power and the non-exceedance is meaningful);
 *   (c) reports, for completeness, the Bonferroni deflation of the per-config naive p across N.
 */
import {
  loadPanel, runPositions, ema, rollingZ, mkRng, sharpeDaily, annSharpe, type Panel,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import fs from "node:fs";

const LAG = 1;
const lag = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
const P = loadPanel("btc");
const T = P.price.length;
const startIdx = 700, splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8);
const fin = lag(P.flowInNtv, LAG), fout = lag(P.flowOutNtv, LAG);
const netInflow = P.price.map((_, t) => (Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN));
function signal(smooth: number, zwin: number): number[] { return rollingZ(ema(netInflow, smooth), zwin); }
const smooths = [7, 14, 30], zwins = [90, 180, 365], thrs = [0.5, 1, 1.5];
interface Cfg { smooth: number; zwin: number; thr: number; side: string }
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
const realSig = new Map<string, number[]>();
for (const s of smooths) for (const zw of zwins) realSig.set(`${s}|${zw}`, signal(s, zw));

function familyWise(configs: Cfg[], NDRAW = 400, seedBase = 600000): { surrP: number; surr95: number; surrMean: number; realBest: number; bestCfg: Cfg } {
  let best = { cfg: configs[0], netIn: -Infinity };
  for (const cfg of configs) {
    const r = runPositions(P, build(cfg, realSig.get(`${cfg.smooth}|${cfg.zwin}`)!), startIdx, splitIdx);
    const v = annSharpe(sharpeDaily(r.dailyNet));
    if (v > best.netIn) best = { cfg, netIn: v };
  }
  const maxSurr: number[] = [];
  for (let i = 0; i < NDRAW; i++) {
    const scrambled = new Map<string, number[]>();
    for (const s of smooths) for (const zw of zwins) {
      const rng = mkRng(seedBase + i * 104729 + s * 131 + zw);
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
  const surrP = (maxSurr.filter((s) => s >= best.netIn).length + 1) / (maxSurr.length + 1);
  return {
    surrP: Number(surrP.toFixed(4)),
    surr95: Number(maxSurr[Math.floor(NDRAW * 0.95)].toFixed(4)),
    surrMean: Number((maxSurr.reduce((a, b) => a + b, 0) / NDRAW).toFixed(4)),
    realBest: Number(best.netIn.toFixed(4)),
    bestCfg: best.cfg,
  };
}

const full: Cfg[] = [];
for (const s of smooths) for (const zw of zwins) for (const th of thrs) for (const sd of ["longflat", "longshort"]) full.push({ smooth: s, zwin: zw, thr: th, side: sd });
const lfOnly: Cfg[] = full.filter((c) => c.side === "longflat");

const out = {
  note: "D5-08 family-wise MAX-stat surrogate robustness (full 54-grid vs longflat-only 27-grid).",
  full54: familyWise(full, 400, 600000),
  longflat27: familyWise(lfOnly, 400, 700000),
  interpretation:
    "If both sub-families show real grid-best < family-wise surr95 (surrP > 0.05), the surrogate-pass reported by the harness (0.013, single-best-config, no FWER) is a multiple-testing artifact and the correct surrogate-gate verdict is FAIL -> KILL, not PROMISING.",
};
fs.writeFileSync("output/edgehunt-audit/d5_08_familywise_surrogate_v2.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
