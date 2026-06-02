/**
 * D4-M1 RESCUE attempt — genuinely try to extract REAL relative-momentum alpha after
 * the long-only gated build was shown to be timed beta (resid Sharpe ~0, holdout ~0).
 *
 * Strategy variants that, if the relative leg carries ANY information, should survive:
 *   (A) Market-NEUTRAL dual momentum: long top-K winners, short bottom-K losers, EW
 *       dollar-neutral. Beta-neutral BY CONSTRUCTION -> isolates the relative leg with
 *       no BTC-regime overlay. If the ranking is informative, net Sharpe>0 and surrogate
 *       (cross-sectional shuffle) p is small. This is the cleanest test of the BELIEF.
 *   (B) Long-only top-K minus equal-weight market (XS-demeaned) -> also beta-stripped
 *       (subtract the cross-sectional mean each week). Tests pure relative selection.
 *
 * Full honest-N grid look{4,8,12,26,52} x top{1,3,5,10} = 20 per variant.
 * For each: net-of-cost (10bps rt; +28bps realism check), cross-sectional-shuffle
 * surrogate, DSR @ honest N (count BOTH variants' grids), PBO across grid, BTC-beta
 * regression (expect ~0 by construction), consume-once holdout (config on first 80%).
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/m1-rescue.ts
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
fs.mkdirSync(OUT, { recursive: true });
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };
const COINS = Object.keys(weekly.weeklyRet);
const W = weekly.weeks.length;
const FULL = COINS.filter((c) =>
  weekly.weeklyRet[c].every((v) => v != null && isFinite(v as number)),
);
const ret = (c: string, i: number) => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : (v as number);
};
const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
function trail(c: string, i: number, look: number): number | null {
  if (i - look < 0) return null;
  let cum = 1;
  for (let k = i - look + 1; k <= i; k++) {
    const v = ret(c, k);
    if (v == null) return null;
    cum *= 1 + v;
  }
  return cum - 1;
}
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

const COST = 0.001; // 10bps rt per name
const COST_REAL = 0.0028; // 28bps realism (panel-meta recommended)

// Variant A: market-neutral long top-K / short bottom-K, EW dollar-neutral.
// Variant B: long top-K minus cross-sectional EW market (XS-demeaned long-only).
type Variant = "neutral" | "xsdemean";
function run(
  variant: Variant,
  look: number,
  top: number,
  iStart: number,
  iEnd: number,
  cost: number,
  shuffle: boolean,
  r?: () => number,
): { port: number[]; btcRet: number[] } {
  const port: number[] = [];
  const btcRet: number[] = [];
  let prevL: string[] = [];
  let prevS: string[] = [];
  for (let i = Math.max(look, iStart); i < Math.min(W - 1, iEnd); i++) {
    let scored = FULL.map((c) => ({ c, m: trail(c, i, look) })).filter(
      (x) => x.m != null,
    ) as { c: string; m: number }[];
    if (scored.length < 2 * top) {
      continue;
    }
    if (shuffle && r) {
      const ms = scored.map((x) => x.m);
      for (let j = ms.length - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        [ms[j], ms[k]] = [ms[k], ms[j]];
      }
      scored.forEach((x, idx) => (x.m = ms[idx]));
    }
    scored.sort((a, b) => b.m - a.m);
    const longs = scored.slice(0, top).map((x) => x.c);
    const shorts = scored.slice(-top).map((x) => x.c);
    // next-week realized
    const ewRet = (names: string[]) => {
      let s = 0;
      let n = 0;
      for (const c of names) {
        const v = ret(c, i + 1);
        if (v != null) (s += v), n++;
      }
      return n > 0 ? s / n : 0;
    };
    let pr: number;
    let curL = longs;
    let curS: string[] = [];
    if (variant === "neutral") {
      pr = ewRet(longs) - ewRet(shorts);
      curS = shorts;
    } else {
      // long top-K minus EW market (all coins) -> cross-sectional demean
      const mkt = ewRet(FULL);
      pr = ewRet(longs) - mkt;
    }
    // turnover cost on both legs
    const turnL =
      prevL.filter((c) => !curL.includes(c)).length +
      curL.filter((c) => !prevL.includes(c)).length;
    const turnS =
      prevS.filter((c) => !curS.includes(c)).length +
      curS.filter((c) => !prevS.includes(c)).length;
    pr -= ((turnL + turnS) / Math.max(1, top)) * cost;
    port.push(pr);
    btcRet.push(ret("BTC", i + 1) ?? 0);
    prevL = curL;
    prevS = curS;
  }
  return { port, btcRet };
}

function regress(y: number[], x: number[]) {
  const n = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const beta = vx > 0 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - (alpha + beta * x[i]));
  return { alpha, beta, resid };
}

const looks = [4, 8, 12, 26, 52];
const tops = [1, 3, 5, 10];
const variants: Variant[] = ["neutral", "xsdemean"];
const configs: { id: string; variant: Variant; look: number; top: number }[] = [];
for (const v of variants)
  for (const l of looks)
    for (const t of tops)
      configs.push({ id: `${v}_L${l}_T${t}`, variant: v, look: l, top: t });
const honestN = configs.length; // 40 (both variants searched)

const scored = configs.map((c) => {
  const full = run(c.variant, c.look, c.top, 0, W, COST, false);
  const reg = regress(full.port, full.btcRet);
  return {
    ...c,
    sharpeFull: ann(sharpe(full.port)),
    port: full.port,
    btcRet: full.btcRet,
    beta: reg.beta,
    residSharpe: ann(sharpe(reg.resid)),
    alphaAnnPct: reg.alpha * 52 * 100,
  };
});
scored.sort((a, b) => b.sharpeFull - a.sharpeFull);
const best = scored[0];

// surrogate on the best config: cross-sectional shuffle of rank->coin
const rs = rng(7);
const surr: number[] = [];
for (let it = 0; it < 500; it++) {
  surr.push(ann(sharpe(run(best.variant, best.look, best.top, 0, W, COST, true, rs).port)));
}
surr.sort((a, b) => a - b);
const pSurro = surr.filter((x) => x >= best.sharpeFull).length / surr.length;

// consume-once holdout: pick config on first 80%, score last 20%
const splitIdx = Math.floor(W * 0.8);
const isScored = configs.map((c) => ({
  c,
  s: ann(sharpe(run(c.variant, c.look, c.top, 0, splitIdx, COST, false).port)),
}));
isScored.sort((a, b) => b.s - a.s);
const bestIS = isScored[0].c;
const holdout = run(bestIS.variant, bestIS.look, bestIS.top, splitIdx, W, COST, false);
const holdoutSharpe = ann(sharpe(holdout.port));

// realism cost re-run of best config
const bestReal = run(best.variant, best.look, best.top, 0, W, COST_REAL, false);
const bestRealSharpe = ann(sharpe(bestReal.port));

// PBO across the grid
const FOLDS = 8;
const foldReturns = scored.map((s) => {
  const folds: number[][] = Array.from({ length: FOLDS }, () => []);
  s.port.forEach((r, i) => folds[i % FOLDS].push(r));
  return { id: s.id, folds };
});
const pbo = estimateCscvPbo(foldReturns, { statistic: "sharpe" });

const dsr = computeDeflatedSharpeRatio(best.port, { trialCount: honestN });
const meanW = best.port.reduce((a, b) => a + b, 0) / best.port.length;

const out = {
  honestN,
  bestConfigOnFull: best.id,
  bestSharpeAnnFull: best.sharpeFull,
  bestSharpeAnn_28bps: bestRealSharpe,
  best_btc_beta: best.beta,
  best_residual_alpha_sharpe: best.residSharpe,
  best_alpha_ann_pct: best.alphaAnnPct,
  surrogate_p: pSurro,
  dsr_p_at_honestN: dsr.deflatedProbability,
  pbo: (pbo as { pbo: number }).pbo,
  bestConfigInSample: bestIS.id,
  holdout_sharpe_ann_consumeOnce: holdoutSharpe,
  holdout_nWeeks: holdout.port.length,
  monthlyReturnPctNet_best: (Math.pow(1 + meanW, 52 / 12) - 1) * 100,
  top5: scored.slice(0, 5).map((s) => ({
    id: s.id,
    sharpe: s.sharpeFull,
    beta: s.beta,
    residSharpe: s.residSharpe,
  })),
  bottom3: scored.slice(-3).map((s) => ({ id: s.id, sharpe: s.sharpeFull })),
  note:
    "Beta-NEUTRAL rescue: variant A long-top/short-bottom dollar-neutral, variant B top-K minus XS-market. If relative leg is real, residSharpe>0 and surrogate p small. 10bps rt; 28bps realism check. honestN=40 counts both variants.",
};
fs.writeFileSync(path.join(OUT, "m1-rescue.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
