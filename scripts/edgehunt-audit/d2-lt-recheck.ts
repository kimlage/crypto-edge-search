/**
 * AUDIT spot-run: re-derive D2-LT best config + DSR@honestN independently, and
 * stress the verdict: (a) confirm honestN=48 is the full grid; (b) confirm DSR
 * deflated prob ~0.513 < 0.95 (the binding gate); (c) check that DSR stays <0.95
 * even if honest N were UNDER-counted (e.g. N=24 momentum-only, N=12, N=1) — i.e.
 * is the KILL robust to the multiple-testing assumption, or is the edge being
 * killed only by an inflated N? Also reproduce the surrogate p to confirm it is a
 * SURROGATE pass (flow->return link), not a magnitude claim.
 */
import { load15m, backtestNet, rng, blockResampleIndices, type Bar } from "../edgehunt-D2/lib.ts";
import { computeDeflatedSharpeRatio, summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";

const PPY = 96 * 365;
const COST = 0.0004;

function annSharpeOf(net: number[]): number {
  const m = net.reduce((a, b) => a + b, 0) / net.length;
  const sd = Math.sqrt(net.reduce((a, b) => a + (b - m) ** 2, 0) / net.length);
  return sd > 1e-12 ? (m / sd) * Math.sqrt(PPY) : 0;
}
function rollingMeanAbs(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(0); let acc = 0;
  for (let i = 0; i < x.length; i += 1) { acc += Math.abs(x[i]); if (i >= w) acc -= Math.abs(x[i - w]); out[i] = acc / Math.min(i + 1, w); }
  return out;
}
function quantile(arr: number[], p: number): number { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; }
function eventsToPositions(flow: number[], print: boolean[], h: number, dir: number, nRets: number): number[] {
  const pos = new Array(nRets).fill(0); const cnt = new Array(nRets).fill(0);
  for (let j = 0; j < flow.length; j += 1) {
    if (!print[j]) continue; const want = dir * Math.sign(flow[j]);
    for (let k = 0; k < h; k += 1) { const i = j + k; if (i >= 0 && i < nRets) { pos[i] += want; cnt[i] += 1; } }
  }
  for (let i = 0; i < nRets; i += 1) if (cnt[i] > 0) pos[i] = Math.max(-1, Math.min(1, pos[i] / cnt[i]));
  return pos;
}

const bars: Bar[] = load15m();
const flow = bars.map((b) => 2 * b.tbb - b.v);
const absFlow = flow.map(Math.abs);
const rets: number[] = [];
for (let i = 0; i < bars.length - 1; i += 1) rets.push(bars[i + 1].c / bars[i].c - 1);
const nRets = rets.length;
const rollW = 96;
const rollMeanAbs = rollingMeanAbs(flow, rollW);

const pctLevels = [0.99, 0.995, 0.999];
const relLevels = [3, 5, 8];
const horizons = [1, 2, 4, 8];
const dirs = [1, -1];
const pctMasks: Record<number, boolean[]> = {};
for (const p of pctLevels) { const thr = quantile(absFlow, p); pctMasks[p] = absFlow.map((x, i) => i >= rollW && x >= thr); }
const relMasks: Record<number, boolean[]> = {};
for (const k of relLevels) relMasks[k] = absFlow.map((x, i) => i >= rollW && rollMeanAbs[i] > 0 && x / rollMeanAbs[i] >= k);

type Cfg = { id: string; net: number[]; sh: number; dir: number };
const all: Cfg[] = [];
for (const det of ["pct", "rel"] as const) {
  const levels = det === "pct" ? pctLevels : relLevels;
  for (const lvl of levels) {
    const mask = det === "pct" ? pctMasks[lvl] : relMasks[lvl];
    for (const h of horizons) for (const dir of dirs) {
      const pos = eventsToPositions(flow, mask, h, dir, nRets);
      const bt = backtestNet(pos, rets, COST);
      all.push({ id: `${det}${lvl}_h${h}_d${dir > 0 ? "mom" : "rev"}`, net: bt.net, sh: annSharpeOf(bt.net), dir });
    }
  }
}
all.sort((a, b) => b.sh - a.sh);
const best = all[0];
console.log(`grid size (honest N) = ${all.length}`);
console.log(`best config = ${best.id}  netSharpe = ${best.sh.toFixed(4)}`);

// DSR at several N to test robustness of the KILL
for (const N of [1, 12, 24, 48, 96]) {
  const d = computeDeflatedSharpeRatio(best.net, { benchmarkSharpe: 0, trialCount: N });
  console.log(`  DSR@N=${N}: deflatedProb=${d.deflatedProbability.toFixed(4)}  (gate needs >0.95)`);
}

// surrogate p (block-bootstrap flow re-paired with same returns) -> confirm it's a
// surrogate (link) pass, recompute small to confirm direction
const SUR = 300; const blk = 32; const surS: number[] = [];
for (let s = 0; s < SUR; s += 1) {
  const rand = rng(90000 + s);
  const idx = blockResampleIndices(flow.length, blk, rand);
  const flowS = idx.map((j) => flow[j]); const absS = flowS.map(Math.abs);
  const rollS = rollingMeanAbs(flowS, rollW);
  const bestDet = best.id.startsWith("pct") ? "pct" : "rel";
  const lvl = parseFloat(best.id.replace(/^(pct|rel)/, "").split("_")[0]);
  const h = parseInt(best.id.split("_h")[1].split("_")[0], 10);
  let maskS: boolean[];
  if (bestDet === "pct") { const thr = quantile(absS, lvl); maskS = absS.map((x, i) => i >= rollW && x >= thr); }
  else maskS = absS.map((x, i) => i >= rollW && rollS[i] > 0 && x / rollS[i] >= lvl);
  const posS = eventsToPositions(flowS, maskS, h, best.dir, nRets);
  surS.push(annSharpeOf(backtestNet(posS, rets, COST).net));
}
const ge = surS.filter((x) => x >= best.sh).length;
console.log(`surrogate p (n=${SUR}) = ${((ge + 1) / (surS.length + 1)).toFixed(4)}  (link-destroying null; pass=<0.05)`);
const st = summarizeReturnSeries(best.net);
console.log(`net mean bp/bar = ${(st.mean * 1e4).toFixed(4)}  (economic magnitude, NOT the surrogate claim)`);
