/**
 * D4-M1 hardening: the only promising result. Tests whether dual momentum is real
 * alpha or timed beta, with the FULL honest-N config sweep, PBO across configs,
 * BTC-beta decomposition, and a consume-once holdout (last 20% never used for selection).
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
const COST = 0.001;
// returns {port, btcExposureFrac} per week; regimeGate toggles BTC abs-mom filter
function run(
  look: number,
  top: number,
  regimeGate: boolean,
  iStart: number,
  iEnd: number,
): { port: number[]; btcRet: number[] } {
  const port: number[] = [];
  const btcRet: number[] = [];
  let prev: string[] = [];
  for (let i = Math.max(look, iStart); i < Math.min(W - 1, iEnd); i++) {
    const btcMom = trail("BTC", i, look);
    const scored = FULL.map((c) => ({ c, m: trail(c, i, look) })).filter(
      (x) => x.m != null,
    ) as { c: string; m: number }[];
    scored.sort((a, b) => b.m - a.m);
    const winners = scored.slice(0, top);
    const onReg = !regimeGate || (btcMom != null && btcMom > 0);
    const hold = onReg ? winners.filter((x) => x.m > 0).map((x) => x.c) : [];
    let w = 0;
    let cnt = 0;
    for (const c of hold) {
      const v = ret(c, i + 1);
      if (v != null) (w += v), cnt++;
    }
    let pr = cnt > 0 ? w / cnt : 0;
    const turn =
      prev.filter((c) => !hold.includes(c)).length +
      hold.filter((c) => !prev.includes(c)).length;
    pr -= (turn / Math.max(1, top)) * COST;
    port.push(pr);
    btcRet.push(ret("BTC", i + 1) ?? 0);
    prev = hold;
  }
  return { port, btcRet };
}

// Full honest-N config grid
const looks = [4, 8, 12, 26, 52];
const tops = [1, 3, 5, 10];
const gates = [true, false];
const configs: { id: string; look: number; top: number; gate: boolean }[] = [];
for (const l of looks)
  for (const t of tops)
    for (const g of gates)
      configs.push({ id: `L${l}_T${t}_${g ? "gated" : "plain"}`, look: l, top: t, gate: g });
const honestN = configs.length;

// Split: insample = first 80%, holdout = last 20% (consume once)
const splitIdx = Math.floor(W * 0.8);

// score every config on the FULL sample to find the best (this IS the search)
const scored = configs.map((c) => {
  const full = run(c.look, c.top, c.gate, 0, W);
  return { ...c, sharpeFull: ann(sharpe(full.port)), port: full.port, btcRet: full.btcRet };
});
scored.sort((a, b) => b.sharpeFull - a.sharpeFull);
const best = scored[0];

// In-sample-selected best, then evaluate on holdout (consume once)
const inSampleScored = configs.map((c) => {
  const is = run(c.look, c.top, c.gate, 0, splitIdx);
  return { c, s: ann(sharpe(is.port)) };
});
inSampleScored.sort((a, b) => b.s - a.s);
const bestIS = inSampleScored[0].c;
const holdoutRun = run(bestIS.look, bestIS.top, bestIS.gate, splitIdx, W);
const holdoutSharpe = ann(sharpe(holdoutRun.port));

// BTC-beta decomposition of the headline config (best on full)
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
const reg = regress(best.port, best.btcRet);
const residSharpe = ann(sharpe(reg.resid)); // alpha-only Sharpe
const alphaAnnPct = reg.alpha * 52 * 100;

// PBO across the config grid: build CSCV folds (split weeks into 8 folds)
const FOLDS = 8;
const foldReturns = scored.map((s) => {
  const folds: number[][] = Array.from({ length: FOLDS }, () => []);
  s.port.forEach((r, i) => folds[i % FOLDS].push(r));
  return { id: s.id, folds };
});
const pbo = estimateCscvPbo(foldReturns, { statistic: "sharpe" as any });

// DSR on the best-on-full at honest N
const dsr = computeDeflatedSharpeRatio(best.port, { trialCount: honestN });
const meanW = best.port.reduce((a, b) => a + b, 0) / best.port.length;

const out = {
  honestN,
  bestConfigOnFull: best.id,
  bestSharpeAnnFull: best.sharpeFull,
  dsr_p_at_honestN: dsr.deflatedProbability,
  pbo: (pbo as any).pbo ?? (pbo as any).probabilityOfBacktestOverfitting ?? pbo,
  btc_beta: reg.beta,
  alpha_ann_pct: alphaAnnPct,
  residual_alpha_sharpe_ann: residSharpe,
  bestConfigInSample: `L${bestIS.look}_T${bestIS.top}_${bestIS.gate ? "gated" : "plain"}`,
  holdout_sharpe_ann_consumeOnce: holdoutSharpe,
  holdout_nWeeks: holdoutRun.port.length,
  monthlyReturnPctNet_best: (Math.pow(1 + meanW, 52 / 12) - 1) * 100,
  top5Configs: scored.slice(0, 5).map((s) => ({ id: s.id, sharpe: s.sharpeFull })),
  bottom3Configs: scored.slice(-3).map((s) => ({ id: s.id, sharpe: s.sharpeFull })),
  note:
    "Best-on-full reported with DSR@honestN. Holdout = config selected ONLY on first 80%, evaluated on last 20% (consume once). Beta decomposition isolates alpha from timed beta.",
};
fs.writeFileSync(path.join(OUT, "m1-harden.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
