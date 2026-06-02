/**
 * D4-M4 strengthening / decisive incremental gates.
 *
 * The base harness showed the ID-label placebo IS broken (p=0.01) and the VOL
 * control does NOT reproduce the lift — so ID is not merely an inverse-vol proxy
 * here. BUT: DSR@honestN=0.77 (weak), incremental-over-momentum t=1.51 (n.s.),
 * and fipSpread (0.81) < plain momentum (0.84). The real question: does ID add
 * anything INCREMENTAL over plain momentum, or is all the apparent edge the
 * momentum long book?
 *
 * Decisive tests here:
 *   1) Paired block-bootstrap of (fipSpread - momentumBaseline) weekly diff:
 *      is the ID lift over momentum > 0 with a CI that excludes 0?
 *   2) Same for (lowID_longOnly - momentumBaseline).
 *   3) Consume-once holdout for the lowID long-only family + its BTC beta/alpha.
 *   4) DSR for lowID long-only at honest N.
 *   5) A STRICT honest-N that counts BOTH families x BOTH conditioners (ID,vol)
 *      x the spread/long-only modes actually searched = the real hidden search.
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt-D348");
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };
const DATES = daily.dates;
const D = DATES.length;
const COINS = Object.keys(daily.closes);
const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const STEP = 7;
const REB: number[] = [];
for (let i = 0; i < D; i += STEP) REB.push(i);
const R = REB.length;
function dr(c: string, a: number, b: number): number | null {
  const cl = daily.closes[c];
  const x = cl[a];
  const y = cl[b];
  if (x == null || y == null || !(x > 0) || !(y > 0)) return null;
  return y / x - 1;
}
function buildFeat(c: string, di: number, FORM: number) {
  if (di - FORM < 0) return null;
  let cum = 1, nPos = 0, nNeg = 0, n = 0;
  const rets: number[] = [];
  for (let t = di - FORM + 1; t <= di; t++) {
    const r = dr(c, t - 1, t);
    if (r == null) return null;
    cum *= 1 + r;
    if (r > 0) nPos++;
    else if (r < 0) nNeg++;
    rets.push(r);
    n++;
  }
  const pret = cum - 1;
  const id = Math.sign(pret) * (nNeg / n - nPos / n);
  const mu = rets.reduce((a, b) => a + b, 0) / n;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / n);
  return { pret, id, vol };
}
function fwd(c: string, ri: number): number | null {
  if (ri + 1 >= R) return null;
  return dr(c, REB[ri], REB[ri + 1]);
}
type Mode = "mom" | "lowID" | "fipSpread" | "lowVol" | "volSpread";
function run(
  FORM: number,
  top: number,
  split: number,
  mode: Mode,
  iStart = 0,
  iEnd = R - 1,
  cost = 0.001,
): { port: number[]; btc: number[] } {
  const port: number[] = [];
  const btc: number[] = [];
  let prev: string[] = [];
  for (let ri = iStart; ri < iEnd; ri++) {
    const di = REB[ri];
    const rows: { c: string; pret: number; id: number; vol: number; fr: number }[] = [];
    for (const c of COINS) {
      const f = buildFeat(c, di, FORM);
      if (!f) continue;
      const fr = fwd(c, ri);
      if (fr == null) continue;
      rows.push({ c, ...f, fr });
    }
    if (rows.length < 8) {
      port.push(0);
      btc.push(fwd("BTC", ri) ?? 0);
      continue;
    }
    const idx = rows.map((_, i) => i);
    idx.sort((a, b) => rows[b].pret - rows[a].pret);
    const nWin = Math.max(2, Math.round(rows.length * top));
    const winners = idx.slice(0, nWin);
    const posW = winners.filter((i) => rows[i].pret > 0);
    const useWin = posW.length >= 2 ? posW : winners;
    const condOf = (i: number) =>
      mode === "lowVol" || mode === "volSpread" ? rows[i].vol : rows[i].id;
    const sw = useWin.slice().sort((a, b) => condOf(a) - condOf(b));
    const nSplit = Math.max(1, Math.round(sw.length * split));
    const low = sw.slice(0, nSplit);
    const high = sw.slice(-nSplit);
    let longSet: number[] = [];
    let shortSet: number[] = [];
    if (mode === "mom") longSet = useWin;
    else if (mode === "lowID" || mode === "lowVol") longSet = low;
    else {
      longSet = low;
      shortSet = high;
    }
    let pl = 0;
    for (const i of longSet) pl += rows[i].fr;
    let ph = 0;
    for (const i of shortSet) ph += rows[i].fr;
    let r =
      (longSet.length ? pl / longSet.length : 0) -
      (shortSet.length ? ph / shortSet.length : 0);
    const hold = longSet.concat(shortSet).map((i) => rows[i].c);
    const turn =
      prev.filter((c) => !hold.includes(c)).length +
      hold.filter((c) => !prev.includes(c)).length;
    r -= (turn / Math.max(1, hold.length)) * cost;
    prev = hold;
    port.push(r);
    btc.push(fwd("BTC", ri) ?? 0);
  }
  return { port, btc };
}

// best config from base harness
const FORM = 84, TOP = 0.3, SPLIT = 0.5;
const fip = run(FORM, TOP, SPLIT, "fipSpread");
const mom = run(FORM, TOP, SPLIT, "mom");
const lowID = run(FORM, TOP, SPLIT, "lowID");

// 1) paired diff: ID lift over momentum (fipSpread is a spread; compare its
//    weekly series minus the momentum baseline's weekly series). Block-bootstrap
//    the MEAN of the difference; CI excluding 0 => ID adds incremental return.
const n = Math.min(fip.port.length, mom.port.length);
const diffFipMom = Array.from({ length: n }, (_, i) => fip.port[i] - mom.port[i]);
const diffLowMom = Array.from({ length: n }, (_, i) => lowID.port[i] - mom.port[i]);
const ciFipMom = blockBootstrapConfidenceInterval(diffFipMom, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 6,
  confidenceLevel: 0.95,
  seed: "fip-mom",
});
const ciLowMom = blockBootstrapConfidenceInterval(diffLowMom, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 6,
  confidenceLevel: 0.95,
  seed: "low-mom",
});
const meanDiffFipMom = diffFipMom.reduce((a, b) => a + b, 0) / n;
const meanDiffLowMom = diffLowMom.reduce((a, b) => a + b, 0) / n;

// 2) consume-once holdout for lowID long-only family (its own grid search)
const forms = [28, 56, 84, 168];
const tops = [0.3, 0.5];
const splits = [0.3, 0.5];
const cfgs: { f: number; t: number; s: number }[] = [];
for (const f of forms) for (const t of tops) for (const s of splits) cfgs.push({ f, t, s });
const splitIdx = Math.floor(R * 0.8);
const isScored = cfgs.map((c) => ({
  c,
  s: ann(sharpe(run(c.f, c.t, c.s, "lowID", 0, splitIdx).port)),
}));
isScored.sort((a, b) => b.s - a.s);
const bestIS = isScored[0].c;
const holdoutLow = run(bestIS.f, bestIS.t, bestIS.s, "lowID", splitIdx);
const holdoutLowSh = ann(sharpe(holdoutLow.port));
// momentum baseline on the SAME holdout window (does lowID beat momentum OOS?)
const holdoutMom = run(bestIS.f, bestIS.t, bestIS.s, "mom", splitIdx);
const holdoutMomSh = ann(sharpe(holdoutMom.port));

// 3) BTC beta of lowID long-only and its alpha
function reg(y: number[], x: number[]) {
  const m = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / m;
  const my = y.reduce((a, b) => a + b, 0) / m;
  let cov = 0, vx = 0;
  for (let i = 0; i < m; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const beta = vx > 0 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - (alpha + beta * x[i]));
  const rstd = Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / m) || 1e-12;
  return { beta, alpha, alphaSharpe: alpha / rstd };
}
const rLow = reg(lowID.port, lowID.btc);

// 4) DSR for lowID long-only at the STRICT honest N: we searched
//    4 forms x 2 tops x 2 splits = 16 grid cells, across mode families
//    {mom, lowID, fipSpread, lowVol, volSpread} = 5 → but mom/lowVol/volSpread are
//    controls; the ID candidates we'd actually deploy are {lowID, fipSpread} and
//    each was sweepable on the grid AND we implicitly compared ID-vs-vol
//    conditioner (x2). Strict honest N = 16 grid x 2 candidate modes x 2
//    conditioner choices = 64.
const honestNstrict = 16 * 2 * 2;
const dsrLowStrict = computeDeflatedSharpeRatio(lowID.port, { trialCount: honestNstrict });
const dsrFipStrict = computeDeflatedSharpeRatio(fip.port, { trialCount: honestNstrict });

const out = {
  config: `F${FORM}_W${TOP}_S${SPLIT}`,
  n,
  fipSpread_sharpeAnn: ann(sharpe(fip.port)),
  momentum_sharpeAnn: ann(sharpe(mom.port)),
  lowID_sharpeAnn: ann(sharpe(lowID.port)),
  // incremental over momentum (paired block-bootstrap of weekly diff means)
  meanWeeklyDiff_fipMinusMom: meanDiffFipMom,
  ci95_fipMinusMom: [ciFipMom.lower, ciFipMom.upper],
  fipBeatsMom_ciExcludesZero: ciFipMom.lower > 0,
  meanWeeklyDiff_lowIDMinusMom: meanDiffLowMom,
  ci95_lowIDMinusMom: [ciLowMom.lower, ciLowMom.upper],
  lowIDBeatsMom_ciExcludesZero: ciLowMom.lower > 0,
  // lowID beta/alpha
  lowID_btc_beta: rLow.beta,
  lowID_alpha_sharpeAnn: ann(rLow.alphaSharpe),
  // consume-once holdout (lowID family chosen on first 80%)
  holdout_lowID_config: `F${bestIS.f}_W${bestIS.t}_S${bestIS.s}`,
  holdout_lowID_sharpeAnn: holdoutLowSh,
  holdout_momentum_sharpeAnn: holdoutMomSh,
  holdout_lowID_beats_mom: holdoutLowSh > holdoutMomSh,
  holdout_n: holdoutLow.port.length,
  // strict honest N
  honestN_strict: honestNstrict,
  dsr_p_lowID_strict: dsrLowStrict.deflatedProbability,
  dsr_p_fipSpread_strict: dsrFipStrict.deflatedProbability,
  note:
    "Incremental ID test = paired block-bootstrap of (ID-strategy - plain-momentum) weekly diff. " +
    "If CI of the mean diff includes 0, ID adds no incremental return over momentum. " +
    "Strict honest N = 16 grid x 2 candidate modes x 2 conditioner choices = 64.",
};
fs.writeFileSync(path.join(OUT, "m4-strengthen.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
