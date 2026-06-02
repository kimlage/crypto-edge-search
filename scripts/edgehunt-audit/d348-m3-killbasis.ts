/**
 * INDEPENDENT re-derivation of the M3 KILL BASIS (SUMMARY line 22):
 *   "Harvey-Liu haircut->0 + DSR 0.63 + NF1 surrogate + liquidity 1.04->0.51".
 *
 * We reconstruct the SAME neutral resid-K8 book and:
 *   (1) re-derive the Harvey-Liu haircut the gauntlet used (and check it is the binding kill).
 *   (2) re-run DSR across the FULL grid of plausible honest-N values, and identify which N
 *       the verdict needs. Report DSR at the M3-family-honest N (6, from the neutral harness)
 *       vs the gauntlet's "count generously" 30.
 *   (3) re-read the NF1 surrogate: is real>P95 a PASS (the audit's claim) and what is p?
 *   (4) re-derive the liquidity decay (the audit's claimed REAL support).
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt-audit");
fs.mkdirSync(OUT, { recursive: true });

const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };

const COINS = Object.keys(weekly.weeklyRet);
const W = weekly.weeks.length;
const DATES = daily.dates;
const WEEKS = weekly.weeks;
const WINDOW = 364;
const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const wret = (c: string, i: number): number | null => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : (v as number);
};
const dateIdx = new Map(DATES.map((d, i) => [d, i]));
const WK2DI = WEEKS.map((w) => (dateIdx.has(w) ? dateIdx.get(w)! : -1));

function nearnessAt(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di]; if (cur == null || !(cur > 0)) return null;
  let hi = -Infinity, valid = 0; const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) { const v = close[k]; if (v != null && v > 0) { valid++; if (v > hi) hi = v; } }
  if (valid < WINDOW || hi <= 0) return null;
  return cur / hi;
}
function mom52At(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di]; const past = close[di - WINDOW + 1];
  if (cur == null || !(cur > 0) || past == null || !(past > 0)) return null;
  let valid = 0; const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) { const v = close[k]; if (v != null && v > 0) valid++; }
  if (valid < WINDOW) return null;
  return cur / past - 1;
}
function residualizeXS(y: number[], x: number[]): number[] {
  const n = y.length; if (n < 3) return y.map(() => 0);
  const mx = x.reduce((a, b) => a + b, 0) / n; const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) * (x[i] - mx); }
  const b = vx > 1e-12 ? cov / vx : 0; const a = my - b * mx;
  return y.map((v, i) => v - (a + b * x[i]));
}
function buildScores(di: number) {
  const out: { c: string; near: number; mom: number }[] = [];
  for (const c of COINS) {
    const cl = daily.closes[c]; const near = nearnessAt(cl, di); const mom = mom52At(cl, di);
    if (near != null && mom != null) out.push({ c, near, mom });
  }
  return out;
}
function runNeutral(resid: boolean, topK: number, cost: number, restrict?: Set<string>): number[] {
  const port: number[] = []; let prevL: string[] = [], prevS: string[] = [];
  for (let i = 1; i < W - 1; i++) {
    const di = WK2DI[i]; if (di < 0) continue;
    let allScored = buildScores(di);
    if (restrict) allScored = allScored.filter((s) => restrict.has(s.c));
    if (allScored.length < 2 * topK + 1) { port.push(0); prevL = []; prevS = []; continue; }
    const vals = resid
      ? residualizeXS(allScored.map((s) => s.near), allScored.map((s) => s.mom))
      : allScored.map((s) => s.near);
    const ranked = allScored.map((s, idx) => ({ c: s.c, v: vals[idx] })).sort((a, b) => b.v - a.v);
    const longs = ranked.slice(0, topK).map((x) => x.c);
    const shorts = ranked.slice(-topK).map((x) => x.c);
    let pr = 0;
    for (const c of longs) { const v = wret(c, i + 1); if (v != null) pr += v; }
    for (const c of shorts) { const v = wret(c, i + 1); if (v != null) pr -= v; }
    pr /= topK;
    const turn = prevL.filter((c) => !longs.includes(c)).length + longs.filter((c) => !prevL.includes(c)).length
      + prevS.filter((c) => !shorts.includes(c)).length + shorts.filter((c) => !prevS.includes(c)).length;
    pr -= (turn / Math.max(1, 2 * topK)) * cost;
    port.push(pr); prevL = longs; prevS = shorts;
  }
  return port;
}

const head = runNeutral(true, 8, 0.001);
const headSharpe = ann(sharpe(head));
const nWeeks = head.length;

// (1) Harvey-Liu haircut EXACTLY as the gauntlet computed it
const tStat = (headSharpe / Math.sqrt(52)) * Math.sqrt(nWeeks);
function haircutAt(N: number) {
  const tReqN = Math.sqrt(2 * Math.log(N)) + 1.0;
  return { tReqN, haircutSharpe: headSharpe * Math.max(0, 1 - tReqN / Math.max(tStat, 1e-9)) };
}

// (2) DSR across N grid
const dsrByN: Record<string, number> = {};
for (const N of [1, 6, 12, 30, 60]) {
  dsrByN[`N${N}`] = computeDeflatedSharpeRatio(head, { trialCount: N }).deflatedProbability;
}

// (4) liquidity decay: restrict short pool / both pools to top-liquid (proxy: largest-cap = first 15 coins?)
// The gauntlet used nLiquid=15. We reproduce by restricting names to a 15-coin liquid set.
// Use the SAME heuristic the gauntlet likely used: coins with full daily history (most-liquid proxy).
const liquidSet = new Set(
  COINS.filter((c) => daily.closes[c].filter((v) => v != null && (v as number) > 0).length > DATES.length * 0.95).slice(0, 15),
);
const bothLiquid = ann(sharpe(runNeutral(true, 8, 0.001, liquidSet)));

const out = {
  headSharpeAnn: headSharpe,
  nWeeks,
  tStat_ofSharpe: tStat,
  harveyLiu: {
    "N6": haircutAt(6),
    "N12": haircutAt(12),
    "N30": haircutAt(30),
    note: "haircutSharpe = SR*max(0,1 - tReqN/tStat); tReqN=sqrt(2*ln N)+1. BINDING KILL claim is haircut->0.",
  },
  dsrByN,
  liquidity_bothLiquid_sharpe: bothLiquid,
  liquidSetSize: liquidSet.size,
};
fs.writeFileSync(path.join(OUT, "d348-m3-killbasis.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
