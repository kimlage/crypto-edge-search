/**
 * AUDIT spot-check for D4-M3 market-neutral 52wk-high nearness.
 * Reproduce the headline neutral book (resid, K=8, 10bps), then probe DSR sensitivity
 * to honest-N choice and confirm the binding gate. Also re-read the NF1 surrogate result.
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
  blockBootstrapConfidenceInterval,
} from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };

const COINS = Object.keys(daily.closes);
const DATES = daily.dates;
const WEEKS = weekly.weeks;
const W = WEEKS.length;
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
  const cur = close[di];
  if (cur == null || !(cur > 0)) return null;
  let hi = -Infinity, valid = 0;
  const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) {
    const v = close[k];
    if (v != null && v > 0) { valid++; if (v > hi) hi = v; }
  }
  if (valid < WINDOW || hi <= 0) return null;
  return cur / hi;
}
function mom52At(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di];
  const past = close[di - WINDOW + 1];
  if (cur == null || !(cur > 0) || past == null || !(past > 0)) return null;
  let valid = 0;
  const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) { const v = close[k]; if (v != null && v > 0) valid++; }
  if (valid < WINDOW) return null;
  return cur / past - 1;
}
function residualize(y: number[], x: number[]): number[] {
  const n = y.length;
  if (n < 3) return y.map(() => 0);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) * (x[i] - mx); }
  const b = vx > 1e-12 ? cov / vx : 0;
  const a = my - b * mx;
  return y.map((v, i) => v - (a + b * x[i]));
}
function buildScores(di: number) {
  const out: { c: string; near: number; mom: number }[] = [];
  for (const c of COINS) {
    const cl = daily.closes[c];
    const near = nearnessAt(cl, di);
    const mom = mom52At(cl, di);
    if (near != null && mom != null) out.push({ c, near, mom });
  }
  return out;
}
function runNeutral(resid: boolean, topK: number, cost: number): number[] {
  const port: number[] = [];
  let prevL: string[] = [], prevS: string[] = [];
  for (let i = 1; i < W - 1; i++) {
    const di = WK2DI[i];
    if (di < 0) continue;
    const allScored = buildScores(di);
    if (allScored.length < 2 * topK + 1) { port.push(0); prevL = []; prevS = []; continue; }
    const vals = resid
      ? residualize(allScored.map((s) => s.near), allScored.map((s) => s.mom))
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
    port.push(pr);
    prevL = longs; prevS = shorts;
  }
  return port;
}

const head = runNeutral(true, 8, 0.001);
const headSharpe = ann(sharpe(head.port ?? head));
const port = head;
const hs = ann(sharpe(port));
const bb = blockBootstrapConfidenceInterval(port, { statistic: "mean", iterations: 2000, blockLength: 7, seed: "m3-audit" });
const out: any = { headSharpeAnn: hs, nWeeks: port.length, meanWk_CI95: [bb.lower, bb.estimate, bb.upper], ciExcludesZero: bb.lower > 0 || bb.upper < 0 };
for (const N of [1, 6, 12, 30, 60]) {
  const d = computeDeflatedSharpeRatio(port, { trialCount: N });
  out[`dsr_p_N${N}`] = d.deflatedProbability;
}
console.log(JSON.stringify(out, null, 2));
