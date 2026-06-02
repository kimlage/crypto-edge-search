/**
 * D4-M3 follow-up: market-NEUTRAL build, where the cross-sectional surrogate is
 * actually informative (the long-only book's surrogate p is dominated by net
 * long-beta drift, not anchoring).
 *
 * Long top-K nearest-to-high, short bottom-K farthest-from-high, dollar-neutral.
 * Also the residual-of-momentum neutral book (KEY control). Then:
 *   - BTC beta of the neutral book (should be ~0 by construction; verify),
 *   - cross-sectional shuffle surrogate (now meaningful: destroys ranking, keeps
 *     dollar-neutrality),
 *   - NF1 structure-destroying surrogate (no real highs),
 *   - DSR@honestN, net of cost.
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
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
const COST = 0.001;

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
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const b = vx > 1e-12 ? cov / vx : 0;
  const a = my - b * mx;
  return y.map((v, i) => v - (a + b * x[i]));
}
function buildScores(closeOf: (c: string) => (number | null)[], di: number) {
  const out: { c: string; near: number; mom: number }[] = [];
  for (const c of COINS) {
    const cl = closeOf(c);
    const near = nearnessAt(cl, di);
    const mom = mom52At(cl, di);
    if (near != null && mom != null) out.push({ c, near, mom });
  }
  return out;
}

// dollar-neutral long-top/short-bottom by score; returns {port, btcRet}
function runNeutral(
  resid: boolean,
  topK: number,
  closeOf: (c: string) => (number | null)[],
  shuffleRank = false,
  r?: () => number,
): { port: number[]; btcRet: number[] } {
  const port: number[] = [];
  const btcRet: number[] = [];
  let prevL: string[] = [];
  let prevS: string[] = [];
  for (let i = 1; i < W - 1; i++) {
    const di = WK2DI[i];
    if (di < 0) continue;
    const scored = buildScores(closeOf, di);
    if (scored.length < 2 * topK + 1) {
      port.push(0);
      btcRet.push(wret("BTC", i + 1) ?? 0);
      prevL = [];
      prevS = [];
      continue;
    }
    let vals = resid
      ? residualize(scored.map((s) => s.near), scored.map((s) => s.mom))
      : scored.map((s) => s.near);
    if (shuffleRank && r) {
      for (let j = vals.length - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        [vals[j], vals[k]] = [vals[k], vals[j]];
      }
    }
    const ranked = scored
      .map((s, idx) => ({ c: s.c, v: vals[idx] }))
      .sort((a, b) => b.v - a.v);
    const longs = ranked.slice(0, topK).map((x) => x.c); // nearest-to-high
    const shorts = ranked.slice(-topK).map((x) => x.c); // farthest-from-high
    let pr = 0;
    let cl = 0;
    let cs = 0;
    for (const c of longs) {
      const v = wret(c, i + 1);
      if (v != null) (pr += v), cl++;
    }
    for (const c of shorts) {
      const v = wret(c, i + 1);
      if (v != null) (pr -= v), cs++;
    }
    pr = (cl > 0 ? pr : 0) / Math.max(1, topK); // EW dollar-neutral
    const turn =
      prevL.filter((c) => !longs.includes(c)).length +
      longs.filter((c) => !prevL.includes(c)).length +
      prevS.filter((c) => !shorts.includes(c)).length +
      shorts.filter((c) => !prevS.includes(c)).length;
    pr -= (turn / Math.max(1, 2 * topK)) * COST;
    port.push(pr);
    btcRet.push(wret("BTC", i + 1) ?? 0);
    prevL = longs;
    prevS = shorts;
  }
  return { port, btcRet };
}
function regress(y: number[], x: number[]) {
  const n = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0,
    vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const beta = vx > 1e-12 ? cov / vx : 0;
  const alpha = my - beta * mx;
  return { alpha, beta, resid: y.map((v, i) => v - (alpha + beta * x[i])) };
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
const topKs = [3, 5, 8];
const honestN = topKs.length * 2; // raw + resid neutral configs

// sweep neutral configs
const rawCfgs = topKs.map((k) => {
  const res = runNeutral(false, k, realClose);
  return { id: `rawNeutral_K${k}`, k, resid: false, sharpe: ann(sharpe(res.port)), res };
});
const residCfgs = topKs.map((k) => {
  const res = runNeutral(true, k, realClose);
  return { id: `residNeutral_K${k}`, k, resid: true, sharpe: ann(sharpe(res.port)), res };
});
const all = [...rawCfgs, ...residCfgs].sort((a, b) => b.sharpe - a.sharpe);
const best = all[0];
const bestRaw = rawCfgs.sort((a, b) => b.sharpe - a.sharpe)[0];
const bestResid = residCfgs.sort((a, b) => b.sharpe - a.sharpe)[0];

const regRaw = regress(bestRaw.res.port, bestRaw.res.btcRet);
const regResid = regress(bestResid.res.port, bestResid.res.btcRet);

// surrogate S1: cross-sectional shuffle (now meaningful, dollar-neutral preserved)
function surrP(cfg: typeof bestRaw, seed: number) {
  const r = rng(seed);
  const s: number[] = [];
  for (let it = 0; it < 400; it++) {
    const res = runNeutral(cfg.resid, cfg.k, realClose, true, r);
    s.push(ann(sharpe(res.port)));
  }
  s.sort((a, b) => a - b);
  return {
    p: s.filter((x) => x >= cfg.sharpe).length / s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p95: s[Math.floor(0.95 * (s.length - 1))],
  };
}
const shufRaw = surrP(bestRaw, 301);
const shufResid = surrP(bestResid, 302);

// surrogate S2: NF1 structure-destroying (no real highs)
function nf1P(cfg: typeof bestRaw, seed: number) {
  const r = rng(seed);
  const s: number[] = [];
  for (let it = 0; it < 200; it++) {
    const sc = surrogateCloses(r);
    const res = runNeutral(cfg.resid, cfg.k, (c) => sc[c]);
    s.push(ann(sharpe(res.port)));
  }
  s.sort((a, b) => a - b);
  return {
    p: s.filter((x) => x >= cfg.sharpe).length / s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p95: s[Math.floor(0.95 * (s.length - 1))],
  };
}
const nf1Raw = nf1P(bestRaw, 401);
const nf1Resid = nf1P(bestResid, 402);

const dsrRaw = computeDeflatedSharpeRatio(bestRaw.res.port, { trialCount: honestN });
const dsrResid = computeDeflatedSharpeRatio(bestResid.res.port, { trialCount: honestN });
const meanRaw = bestRaw.res.port.reduce((a, b) => a + b, 0) / bestRaw.res.port.length;
const meanResid =
  bestResid.res.port.reduce((a, b) => a + b, 0) / bestResid.res.port.length;

const out = {
  item: "D4-M3 52wk-high nearness — MARKET-NEUTRAL (long nearest / short farthest)",
  honestN,
  rawNeutral: {
    config: bestRaw.id,
    sharpeAnnNet: bestRaw.sharpe,
    monthlyReturnPctNet: (Math.pow(1 + meanRaw, 52 / 12) - 1) * 100,
    btc_beta: regRaw.beta,
    alpha_ann_pct: regRaw.alpha * 52 * 100,
    residual_alpha_sharpe_ann: ann(sharpe(regRaw.resid)),
    dsr_p_at_honestN: dsrRaw.deflatedProbability,
    shuffle_p: shufRaw.p,
    shuffle_mean: shufRaw.mean,
    nf1_p: nf1Raw.p,
    nf1_mean: nf1Raw.mean,
    nf1_p95: nf1Raw.p95,
  },
  residNeutral_KEYcontrol: {
    config: bestResid.id,
    sharpeAnnNet: bestResid.sharpe,
    monthlyReturnPctNet: (Math.pow(1 + meanResid, 52 / 12) - 1) * 100,
    btc_beta: regResid.beta,
    alpha_ann_pct: regResid.alpha * 52 * 100,
    residual_alpha_sharpe_ann: ann(sharpe(regResid.resid)),
    dsr_p_at_honestN: dsrResid.deflatedProbability,
    shuffle_p: shufResid.p,
    shuffle_mean: shufResid.mean,
    nf1_p: nf1Resid.p,
    nf1_mean: nf1Resid.mean,
    nf1_p95: nf1Resid.p95,
    note: "Nearness residualized vs 52w momentum, dollar-neutral. Tests whether anchoring adds over the killed momentum.",
  },
  allConfigs: all.map((c) => ({ id: c.id, sharpe: c.sharpe })),
};
fs.writeFileSync(path.join(OUT, "m3-neutral.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
