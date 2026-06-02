import fs from "node:fs";
import path from "node:path";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";
const ROOT = process.cwd();
const weekly = JSON.parse(fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8")) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };
const COINS = Object.keys(weekly.weeklyRet); const W = weekly.weeks.length;
const FULL = COINS.filter((c) => weekly.weeklyRet[c].every((v) => v != null && isFinite(v as number)));
console.log("nWeeks", W, "FULL coins", FULL.length);
const ret = (c: string, i: number) => { const v = weekly.weeklyRet[c]?.[i]; return v == null || !isFinite(v) ? null : (v as number); };
const ann = (s: number) => s * Math.sqrt(52);
function trail(c: string, i: number, L: number) { if (i - L < 0) return null; let cum = 1; for (let k = i - L + 1; k <= i; k++) { const v = ret(c, k); if (v == null) return null; cum *= 1 + v; } return cum - 1; }
const look = 12, top = 5, COST = 0.001;
function run(iStart: number, iEnd: number) {
  const port: number[] = []; let prevL: string[] = [], prevS: string[] = [];
  for (let i = Math.max(look, iStart); i < Math.min(W - 1, iEnd); i++) {
    let sc = FULL.map((c) => ({ c, m: trail(c, i, look) })).filter((x) => x.m != null) as { c: string; m: number }[];
    if (sc.length < 2 * top) continue; sc.sort((a, b) => b.m - a.m);
    const longs = sc.slice(0, top).map((x) => x.c), shorts = sc.slice(-top).map((x) => x.c);
    const ew = (ns: string[]) => { let s = 0, n = 0; for (const c of ns) { const v = ret(c, i + 1); if (v != null) (s += v), n++; } return n > 0 ? s / n : 0; };
    let pr = ew(longs) - ew(shorts);
    const tL = prevL.filter((c) => !longs.includes(c)).length + longs.filter((c) => !prevL.includes(c)).length;
    const tS = prevS.filter((c) => !shorts.includes(c)).length + shorts.filter((c) => !prevS.includes(c)).length;
    pr -= ((tL + tS) / top) * COST; port.push(pr); prevL = longs; prevS = shorts;
  }
  return port;
}
const splitIdx = Math.floor(W * 0.8);
const full = run(0, W), is = run(0, splitIdx), oos = run(splitIdx, W);
console.log("FULL sharpe", ann(summarizeReturnSeries(full).sharpe).toFixed(3), "n", full.length);
console.log("IS(80%) sharpe", ann(summarizeReturnSeries(is).sharpe).toFixed(3), "n", is.length);
console.log("OOS(20%) sharpe", ann(summarizeReturnSeries(oos).sharpe).toFixed(3), "n", oos.length, "mean", summarizeReturnSeries(oos).mean.toFixed(4));
