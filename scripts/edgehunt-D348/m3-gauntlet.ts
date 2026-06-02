/**
 * D4-M3 final gauntlet on the market-neutral book — the only build that showed a
 * near-zero-beta Sharpe. Decisive checks:
 *   (1) HONEST N across BOTH harnesses (long-only 12 + neutral 6 + mom baselines +
 *       long-short toggle) -> ~30 configs; DSR + Harvey-Liu haircut.
 *   (2) CPCV/PBO across the neutral config grid.
 *   (3) NF1 structure-destroying surrogate at high replication (the binding gate):
 *       does a no-real-highs path reproduce the spread Sharpe?
 *   (4) Cost realism: short legs in crypto small-caps are expensive. Re-run the
 *       headline at 25 bps and 50 bps round-trip to see if the edge survives.
 *   (5) Liquidity guard: restrict the SHORT side to the 15 fully-covered (older,
 *       more liquid) coins; if the edge lives only in shorting illiquid late
 *       listings it is not investable.
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt-D348");
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };

const COINS = Object.keys(daily.closes);
const DATES = daily.dates;
const D = DATES.length;
const WEEKS = weekly.weeks;
const W = WEEKS.length;
const WINDOW = 364;
const LIQUID = COINS.filter((c) =>
  daily.closes[c].every((v) => v != null && (v as number) > 0),
); // 15 fully-covered coins

const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const wret = (c: string, i: number): number | null => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : (v as number);
};
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function blockResample(x: number[], blk: number, r: () => number): number[] {
  const out: number[] = [];
  while (out.length < x.length) {
    const s = Math.floor(r() * x.length);
    for (let o = 0; o < blk && out.length < x.length; o++)
      out.push(x[(s + o) % x.length]);
  }
  return out;
}
const dateIdx = new Map(DATES.map((d, i) => [d, i]));
const WK2DI = WEEKS.map((w) => (dateIdx.has(w) ? dateIdx.get(w)! : -1));

function nearnessAt(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di];
  if (cur == null || !(cur > 0)) return null;
  let hi = -Infinity;
  let valid = 0;
  const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) {
    const v = close[k];
    if (v != null && v > 0) {
      valid++;
      if (v > hi) hi = v;
    }
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
  for (let k = start; k <= di; k++) {
    const v = close[k];
    if (v != null && v > 0) valid++;
  }
  if (valid < WINDOW) return null;
  return cur / past - 1;
}
function residualize(y: number[], x: number[]): number[] {
  const n = y.length;
  if (n < 3) return y.map(() => 0);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0,
    vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const b = vx > 1e-12 ? cov / vx : 0;
  const a = my - b * mx;
  return y.map((v, i) => v - (a + b * x[i]));
}
function buildScores(
  closeOf: (c: string) => (number | null)[],
  di: number,
  pool: string[],
) {
  const out: { c: string; near: number; mom: number }[] = [];
  for (const c of pool) {
    const cl = closeOf(c);
    const near = nearnessAt(cl, di);
    const mom = mom52At(cl, di);
    if (near != null && mom != null) out.push({ c, near, mom });
  }
  return out;
}

// neutral runner with: resid toggle, cost level, short-pool restriction
function runNeutral(opts: {
  resid: boolean;
  topK: number;
  cost: number;
  closeOf: (c: string) => (number | null)[];
  longPool: string[];
  shortPool: string[];
  shuffleRank?: boolean;
  r?: () => number;
}): { port: number[]; btcRet: number[] } {
  const { resid, topK, cost, closeOf, longPool, shortPool, shuffleRank, r } = opts;
  const port: number[] = [];
  const btcRet: number[] = [];
  let prevL: string[] = [];
  let prevS: string[] = [];
  for (let i = 1; i < W - 1; i++) {
    const di = WK2DI[i];
    if (di < 0) continue;
    // rank longs within longPool, shorts within shortPool (each on full-universe score)
    const allScored = buildScores(closeOf, di, COINS);
    if (allScored.length < 2 * topK + 1) {
      port.push(0);
      btcRet.push(wret("BTC", i + 1) ?? 0);
      prevL = [];
      prevS = [];
      continue;
    }
    let vals = resid
      ? residualize(allScored.map((s) => s.near), allScored.map((s) => s.mom))
      : allScored.map((s) => s.near);
    if (shuffleRank && r) {
      for (let j = vals.length - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        [vals[j], vals[k]] = [vals[k], vals[j]];
      }
    }
    const ranked = allScored
      .map((s, idx) => ({ c: s.c, v: vals[idx] }))
      .sort((a, b) => b.v - a.v);
    const longs = ranked.filter((x) => longPool.includes(x.c)).slice(0, topK).map((x) => x.c);
    const shorts = ranked
      .filter((x) => shortPool.includes(x.c))
      .slice(-topK)
      .map((x) => x.c);
    if (longs.length < topK || shorts.length < topK) {
      port.push(0);
      btcRet.push(wret("BTC", i + 1) ?? 0);
      prevL = longs;
      prevS = shorts;
      continue;
    }
    let pr = 0;
    for (const c of longs) {
      const v = wret(c, i + 1);
      if (v != null) pr += v;
    }
    for (const c of shorts) {
      const v = wret(c, i + 1);
      if (v != null) pr -= v;
    }
    pr /= topK;
    const turn =
      prevL.filter((c) => !longs.includes(c)).length +
      longs.filter((c) => !prevL.includes(c)).length +
      prevS.filter((c) => !shorts.includes(c)).length +
      shorts.filter((c) => !prevS.includes(c)).length;
    pr -= (turn / Math.max(1, 2 * topK)) * cost;
    port.push(pr);
    btcRet.push(wret("BTC", i + 1) ?? 0);
    prevL = longs;
    prevS = shorts;
  }
  return { port, btcRet };
}
function surrogateCloses(r: () => number): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const c of COINS) {
    const cl = daily.closes[c];
    let firstValid = -1;
    const lr: number[] = [];
    for (let i = 0; i < D; i++) {
      const v = cl[i];
      if (v != null && v > 0) {
        if (firstValid < 0) firstValid = i;
        const prev = cl[i - 1];
        if (i > 0 && prev != null && prev > 0) lr.push(Math.log(v / prev));
      }
    }
    if (firstValid < 0 || lr.length < WINDOW) {
      out[c] = cl.map(() => null);
      continue;
    }
    const sh = blockResample(lr, 21, r);
    const nc: (number | null)[] = new Array(D).fill(null);
    let logp = Math.log(cl[firstValid] as number);
    nc[firstValid] = cl[firstValid];
    let li = 0;
    for (let i = firstValid + 1; i < D; i++) {
      const orig = cl[i];
      if (orig != null && orig > 0) {
        logp += sh[li % sh.length];
        li++;
        nc[i] = Math.exp(logp);
      }
    }
    out[c] = nc;
  }
  return out;
}
const realClose = (c: string) => daily.closes[c];

// ---- headline config from the neutral sweep: resid, K=8, 10bps ----
const HEAD = { resid: true, topK: 8, longPool: COINS, shortPool: COINS };
const head = runNeutral({ ...HEAD, cost: 0.001, closeOf: realClose });
const headSharpe = ann(sharpe(head.port));

// (1) HONEST N: long-only(12) + neutral raw/resid x K{3,5,8}(6) + mom baselines(4)
//     + long-short cost variants + liquidity variants we evaluate here. Count generously.
const HONEST_N = 30;
const dsr = computeDeflatedSharpeRatio(head.port, { trialCount: HONEST_N });

// Harvey-Liu style haircut: haircut Sharpe = SR * (1 - p_adj-implied shrink).
// Use BHY-ish: required t scales with sqrt(2*ln(N)); haircut SR = SR * tReq0/tReqN where
// tReq0 = z(0.95)=1.645, tReqN approx for N tests.
const nWeeks = head.port.length;
const tStat = headSharpe / Math.sqrt(52) * Math.sqrt(nWeeks); // t of per-period SR
const tReqN = Math.sqrt(2 * Math.log(HONEST_N)) + 1.0; // rough multiple-testing threshold
const haircutSharpe = headSharpe * Math.max(0, 1 - tReqN / Math.max(tStat, 1e-9));

// (2) CPCV/PBO across neutral grid
const grid: { id: string; resid: boolean; topK: number }[] = [];
for (const resid of [false, true]) for (const topK of [3, 5, 8]) grid.push({ id: `${resid ? "resid" : "raw"}_K${topK}`, resid, topK });
const gridRuns = grid.map((g) => ({
  id: g.id,
  port: runNeutral({ resid: g.resid, topK: g.topK, cost: 0.001, closeOf: realClose, longPool: COINS, shortPool: COINS }).port,
}));
const FOLDS = 8;
const foldReturns = gridRuns.map((s) => {
  const folds: number[][] = Array.from({ length: FOLDS }, () => []);
  s.port.forEach((r, i) => folds[i % FOLDS].push(r));
  return { id: s.id, folds };
});
const pboRes = estimateCscvPbo(foldReturns, { statistic: "sharpe" as any });
const pbo = (pboRes as any).pbo ?? (pboRes as any).probabilityOfBacktestOverfitting ?? pboRes;

// (3) NF1 surrogate, high replication (BINDING gate)
const r1 = rng(777);
const nf1: number[] = [];
for (let it = 0; it < 500; it++) {
  const sc = surrogateCloses(r1);
  nf1.push(ann(sharpe(runNeutral({ ...HEAD, cost: 0.001, closeOf: (c) => sc[c] }).port)));
}
nf1.sort((a, b) => a - b);
const nf1P = nf1.filter((x) => x >= headSharpe).length / nf1.length;
const nf1Mean = nf1.reduce((a, b) => a + b, 0) / nf1.length;
const nf1P95 = nf1[Math.floor(0.95 * (nf1.length - 1))];

// (4) Cost realism
const cost25 = ann(sharpe(runNeutral({ ...HEAD, cost: 0.0025, closeOf: realClose }).port));
const cost50 = ann(sharpe(runNeutral({ ...HEAD, cost: 0.005, closeOf: realClose }).port));

// (5) Liquidity guard: short only within the 15 fully-covered (liquid) coins
const liqShort = runNeutral({ ...HEAD, cost: 0.001, closeOf: realClose, shortPool: LIQUID });
const liqShortSharpe = ann(sharpe(liqShort.port));
// both sides liquid-only
const liqBoth = runNeutral({ ...HEAD, cost: 0.001, closeOf: realClose, longPool: LIQUID, shortPool: LIQUID });
const liqBothSharpe = ann(sharpe(liqBoth.port));

const meanW = head.port.reduce((a, b) => a + b, 0) / head.port.length;
const out = {
  item: "D4-M3 — final gauntlet (market-neutral, resid-of-momentum, K=8)",
  headline: {
    sharpeAnnNet_10bps: headSharpe,
    nWeeks,
    monthlyReturnPctNet: (Math.pow(1 + meanW, 52 / 12) - 1) * 100,
  },
  honestN: HONEST_N,
  dsr_p_at_honestN: dsr.deflatedProbability,
  harveyLiu_haircutSharpe: haircutSharpe,
  pbo,
  bindingGate_nf1Surrogate: {
    p: nf1P,
    surrogateMeanSharpe: nf1Mean,
    surrogateP95Sharpe: nf1P95,
    realSharpe: headSharpe,
    verdict_realBeatsP95: headSharpe > nf1P95,
  },
  costRealism: {
    sharpe_25bps: cost25,
    sharpe_50bps: cost50,
  },
  liquidityGuard: {
    shortLiquidOnly_sharpe: liqShortSharpe,
    bothLiquidOnly_sharpe: liqBothSharpe,
    nLiquid: LIQUID.length,
  },
};
fs.writeFileSync(path.join(OUT, "m3-gauntlet.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
