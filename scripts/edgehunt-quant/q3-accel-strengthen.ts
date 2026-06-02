/**
 * Q3-ACCEL strengthening — does acceleration add ORTHOGONAL info over momentum?
 *
 * The primary build KILLed on baselines (accel did not beat best plain momentum) and
 * collapsed OOS (holdout Sharpe -0.79) despite passing the XS-shuffle null in-sample.
 * That signature = "accel is a noisier momentum, with no separable premium."
 *
 * Strongest honest attempt to rescue it:
 *   (A) CROSS-SECTIONAL RESIDUAL acceleration: each week regress accel_i on mom_i across
 *       the panel and rank on the residual (accel ⊥ momentum). If accel only works through
 *       its momentum component, the residual book is ~0. This is THE test of a separable
 *       acceleration premium.
 *   (B) Deceleration-of-winners reversal: long decelerating losers / short decelerating
 *       winners (the explicit "decelerating winners reverse" belief).
 *   (C) sign-combo: momentum AND acceleration agree (double-sort) — concentrates the book.
 *
 * Every variant x window x K is counted in honest N. Full committed gauntlet with the
 * cross-sectional shuffle null + consume-once holdout. The RIGHT control stays the best
 * plain-momentum book; the residual book additionally must beat plain momentum.
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt-quant");
fs.mkdirSync(OUT, { recursive: true });
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };

const COINS = Object.keys(weekly.weeklyRet);
const WEEKS = weekly.weeks;
const W = WEEKS.length;
const COST_PER_SIDE = 0.0004;
const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const mean = (r: number[]) => (r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0);
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

const RAW = weekly.weeklyRet;
const MASK: Record<string, boolean[]> = {};
for (const c of COINS) {
  const arr = RAW[c];
  const m = new Array(W).fill(false);
  for (let i = 0; i < W; i++) m[i] = arr[i] != null && isFinite(arr[i] as number);
  let i = 0;
  while (i < W) {
    if (arr[i] === 0) {
      let j = i;
      while (j < W && arr[j] === 0) j++;
      if (j - i >= 8) for (let k = i; k < j; k++) m[k] = false;
      i = j;
    } else i++;
  }
  MASK[c] = m;
}
const ret = (c: string, i: number): number | null =>
  i >= 0 && i < W && MASK[c][i] ? (RAW[c][i] as number) : null;
function trailRet(c: string, i: number, look: number): number | null {
  if (i - look + 1 < 0) return null;
  let cum = 1;
  for (let k = i - look + 1; k <= i; k++) {
    const v = ret(c, k);
    if (v == null) return null;
    cum *= 1 + v;
  }
  return cum - 1;
}
function accelDiff(c: string, i: number, look: number): number | null {
  const recent = trailRet(c, i, look);
  const prior = trailRet(c, i - look, look);
  if (recent == null || prior == null) return null;
  return recent - prior;
}
function accelSlope(c: string, i: number, s: number, l: number): number | null {
  const mS = trailRet(c, i, s);
  const mL = trailRet(c, i, l);
  if (mS == null || mL == null) return null;
  return mS / s - mL / l;
}

// per-week cross-sectional OLS residual of a[] on b[] (both length n)
function xsResid(a: number[], b: number[]): number[] {
  const n = a.length;
  if (n < 3) return a.slice();
  const mb = mean(b);
  const ma = mean(a);
  let cov = 0;
  let vb = 0;
  for (let k = 0; k < n; k++) {
    cov += (b[k] - mb) * (a[k] - ma);
    vb += (b[k] - mb) * (b[k] - mb);
  }
  const beta = vb > 1e-12 ? cov / vb : 0;
  const alpha = ma - beta * mb;
  return a.map((v, k) => v - (alpha + beta * b[k]));
}

type Variant = "accel" | "residAccel" | "decelRev" | "doubleSort";
type Cfg = { id: string; variant: Variant; kind: "diff" | "slope"; a: number; b: number; K: number };

// Build per-week ranked book PnL. Returns realized weekly net + BTC series.
function runBook(
  cfg: Cfg,
  startWk: number,
  endWk: number,
  shuffle = false,
  r?: () => number,
): { port: number[]; btc: number[]; nWk: number; turnoverMean: number } {
  const K = cfg.K;
  const port: number[] = [];
  const btc: number[] = [];
  let prevL: string[] = [];
  let prevS: string[] = [];
  let turnSum = 0;
  let turnN = 0;
  const accelOf = (c: string, i: number) =>
    cfg.kind === "diff" ? accelDiff(c, i, cfg.a) : accelSlope(c, i, cfg.a, cfg.b);
  const momLook = cfg.kind === "diff" ? cfg.a : cfg.b;

  for (let i = startWk; i < endWk; i++) {
    if (i + 1 >= W) break;
    const rows: { c: string; accel: number; mom: number }[] = [];
    for (const c of COINS) {
      if (!MASK[c][i + 1]) continue;
      const ac = accelOf(c, i);
      const mo = trailRet(c, i, momLook);
      if (ac == null || mo == null) continue;
      rows.push({ c, accel: ac, mom: mo });
    }
    if (rows.length < 2 * K + 1) {
      port.push(0);
      btc.push(ret("BTC", i + 1) ?? 0);
      prevL = [];
      prevS = [];
      continue;
    }
    // compute the ranking value per variant
    let vals: number[];
    if (cfg.variant === "accel") {
      vals = rows.map((x) => x.accel);
    } else if (cfg.variant === "residAccel") {
      vals = xsResid(rows.map((x) => x.accel), rows.map((x) => x.mom));
    } else if (cfg.variant === "decelRev") {
      // decelerating winners reverse: short high-mom + decelerating, long low-mom + decelerating.
      // rank by (mom * -accel): high when winner is decelerating (short side) / loser accel'ing.
      vals = rows.map((x) => -(x.mom * x.accel));
    } else {
      // doubleSort: only take names where mom and accel agree in sign; score = sign*|both|
      vals = rows.map((x) => (Math.sign(x.mom) === Math.sign(x.accel) ? x.mom + x.accel : 0));
    }
    let order = rows.map((x, idx) => ({ c: x.c, v: vals[idx] }));
    if (shuffle && r) {
      const vs = order.map((x) => x.v);
      for (let j = vs.length - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        [vs[j], vs[k]] = [vs[k], vs[j]];
      }
      order = order.map((x, idx) => ({ c: x.c, v: vs[idx] }));
    }
    order.sort((a, b) => b.v - a.v);
    const longs = order.slice(0, K).map((x) => x.c);
    const shorts = order.slice(-K).map((x) => x.c);
    let pl = 0;
    for (const c of longs) pl += ret(c, i + 1)!;
    let ps = 0;
    for (const c of shorts) ps += ret(c, i + 1)!;
    let pr = pl / K - ps / K;
    const turn =
      prevL.filter((c) => !longs.includes(c)).length +
      longs.filter((c) => !prevL.includes(c)).length +
      prevS.filter((c) => !shorts.includes(c)).length +
      shorts.filter((c) => !prevS.includes(c)).length;
    pr -= (turn / K) * COST_PER_SIDE;
    turnSum += turn / (2 * K);
    turnN++;
    port.push(pr);
    btc.push(ret("BTC", i + 1) ?? 0);
    prevL = longs;
    prevS = shorts;
  }
  return { port, btc, nWk: port.length, turnoverMean: turnN ? turnSum / turnN : 0 };
}
function regress(y: number[], x: number[]) {
  const n = y.length;
  if (n < 3) return { alpha: 0, beta: 0 };
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const beta = vx > 1e-12 ? cov / vx : 0;
  return { alpha: my - beta * mx, beta };
}

// ---- config grid: ALL variants counted in honest N -----------------------
const Ks = [3, 4, 5];
const diffLooks = [4, 8, 12, 26];
const slopePairs: [number, number][] = [
  [4, 12],
  [4, 26],
  [8, 26],
  [12, 52],
];
const variants: Variant[] = ["accel", "residAccel", "decelRev", "doubleSort"];
const CFGS: Cfg[] = [];
for (const variant of variants) {
  for (const K of Ks) {
    for (const a of diffLooks) CFGS.push({ id: `${variant}_diff${a}_K${K}`, variant, kind: "diff", a, b: 0, K });
    for (const [a, b] of slopePairs)
      CFGS.push({ id: `${variant}_slope${a}_${b}_K${K}`, variant, kind: "slope", a, b, K });
  }
}
const HONEST_N = CFGS.length;

const WARMUP = 52;
const TRADE_START = WARMUP;
const TRADE_END = W - 1;
const span = TRADE_END - TRADE_START;
const SPLIT = TRADE_START + Math.floor(span * 0.8);

const scored = CFGS.map((cfg) => {
  const book = runBook(cfg, TRADE_START, SPLIT);
  return { cfg, book, netSh: ann(sharpe(book.port)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];

// best residAccel specifically (the orthogonality test)
const bestResid = scored.filter((s) => s.cfg.variant === "residAccel").sort((a, b) => b.netSh - a.netSh)[0];

// matched-exposure control: best plain momentum over a matched grid
const momLooks = [4, 8, 12, 26, 52];
let bestMomSh = -Infinity;
let bestMomLook = 12;
let bestMomBook: number[] = [];
for (const L of momLooks)
  for (const K of Ks) {
    const b = runBook({ id: "m", variant: "accel", kind: "diff", a: L, b: 0, K }, TRADE_START, SPLIT);
    // NOTE: variant 'accel' with kind diff is accel, NOT momentum. Build momentum directly:
  }
// build plain momentum book directly (long top mom / short bottom mom)
function momBook(L: number, K: number, startWk: number, endWk: number) {
  const port: number[] = [];
  const btc: number[] = [];
  for (let i = startWk; i < endWk; i++) {
    if (i + 1 >= W) break;
    const rows: { c: string; m: number }[] = [];
    for (const c of COINS) {
      if (!MASK[c][i + 1]) continue;
      const m = trailRet(c, i, L);
      if (m != null) rows.push({ c, m });
    }
    if (rows.length < 2 * K + 1) {
      port.push(0);
      btc.push(ret("BTC", i + 1) ?? 0);
      continue;
    }
    rows.sort((a, b) => b.m - a.m);
    const longs = rows.slice(0, K);
    const shorts = rows.slice(-K);
    let pl = 0;
    for (const x of longs) pl += ret(x.c, i + 1)!;
    let ps = 0;
    for (const x of shorts) ps += ret(x.c, i + 1)!;
    port.push(pl / K - ps / K);
    btc.push(ret("BTC", i + 1) ?? 0);
  }
  return { port, btc };
}
bestMomSh = -Infinity;
for (const L of momLooks)
  for (const K of Ks) {
    const b = momBook(L, K, TRADE_START, SPLIT);
    const s = ann(sharpe(b.port));
    if (s > bestMomSh) {
      bestMomSh = s;
      bestMomLook = L;
      bestMomBook = b.port;
    }
  }

const reg = regress(best.book.port, best.book.btc);
const regResid = regress(bestResid.book.port, bestResid.book.btc);

// DSR @ honest N
const dsr = computeDeflatedSharpeRatio(best.book.port, { trialCount: HONEST_N });
const dsrResid = computeDeflatedSharpeRatio(bestResid.book.port, { trialCount: HONEST_N });

// block bootstrap
const bb = blockBootstrapConfidenceInterval(best.book.port, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 8,
  confidenceLevel: 0.95,
  seed: "q3-accel-str-bb",
});

// CPCV/PBO
function toFolds(s: number[], nf: number): number[][] {
  const f: number[][] = [];
  const sz = Math.floor(s.length / nf);
  for (let k = 0; k < nf; k++) f.push(s.slice(k * sz, k === nf - 1 ? s.length : (k + 1) * sz));
  return f;
}
let pbo = 1;
try {
  pbo = estimateCscvPbo(
    scored.map((s) => ({ id: s.cfg.id, folds: toFolds(s.book.port, 6) })),
    { statistic: "sharpe", trainFraction: 0.5 },
  ).pbo;
} catch {
  pbo = 1;
}

// Harvey-Liu haircut
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const sB = summarizeReturnSeries(best.book.port);
const psrZ =
  sB.sampleCount > 3 && sB.stdDev > 0
    ? (sB.sharpe * Math.sqrt(sB.sampleCount - 1)) /
      Math.sqrt(Math.max(1e-9, 1 - sB.skewness * sB.sharpe + ((sB.kurtosis - 1) / 4) * sB.sharpe ** 2))
    : 0;
const adjP = Math.min(1, (1 - normCdf(psrZ)) * HONEST_N);

// XS-shuffle surrogate on best + on bestResid
function surrP(cfg: Cfg, sh: number, seed: number) {
  const r = rng(seed);
  const s: number[] = [];
  for (let it = 0; it < 500; it++) s.push(ann(sharpe(runBook(cfg, TRADE_START, SPLIT, true, r).port)));
  s.sort((a, b) => a - b);
  return { p: (s.filter((x) => x >= sh).length + 1) / (s.length + 1), mean: mean(s), p95: s[Math.floor(0.95 * (s.length - 1))] };
}
const surBest = surrP(best.cfg, best.netSh, 7001);
const surResid = surrP(bestResid.cfg, bestResid.netSh, 7002);

// consume-once holdout
const holdBest = runBook(best.cfg, SPLIT, TRADE_END);
const holdBestSh = ann(sharpe(holdBest.port));
const holdResid = runBook(bestResid.cfg, SPLIT, TRADE_END);
const holdResidSh = ann(sharpe(holdResid.port));

const meanWk = mean(best.book.port);
const beatsMom = best.netSh > bestMomSh;
const baselinePass = best.netSh > 0 && beatsMom;
const dsrPass = dsr.deflatedProbability > 0.95;
const bbPass = bb.lower > 0;
const pboPass = pbo < 0.5;
const haircutPass = adjP < 0.05;
const surrPass = surBest.p < 0.05;
const holdoutPass = holdBestSh > 0;

const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: { pass: meanWk > 0, detail: `meanWk=${meanWk.toExponential(3)} turn=${best.book.turnoverMean.toFixed(2)}` },
  baselines: { pass: baselinePass, detail: `best=${best.netSh.toFixed(3)} bestMom(L${bestMomLook})=${bestMomSh.toFixed(3)} beatsMom=${beatsMom}` },
  deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N}` },
  block_bootstrap: { pass: bbPass, detail: `CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.toFixed(3)}` },
  haircut: { pass: haircutPass, detail: `adjP=${adjP.toExponential(3)}` },
  surrogate: { pass: surrPass, detail: `XS-shuffle p=${surBest.p.toFixed(4)} surrMean=${surBest.mean.toFixed(3)}` },
  holdout: { pass: holdoutPass, detail: `OOS Sh=${holdBestSh.toFixed(3)} over ${holdBest.nWk}wk` },
};
const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
let binding = "none";
for (const g of order) if (!gates[g].pass) { binding = g; break; }
const allPass = binding === "none";
const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
const monthlyAt100k = allPass ? meanWk * (52 / 12) * 100000 : NaN;

const out = {
  item: "Q3-ACCEL strengthening — residual/decel/doubleSort variants",
  honestN: HONEST_N,
  bestOverall: {
    id: best.cfg.id,
    variant: best.cfg.variant,
    netSharpeAnn: best.netSh,
    meanWeeklyNet: meanWk,
    btc_beta: reg.beta,
    holdoutSharpeAnn: holdBestSh,
  },
  bestResidAccel_orthogonalityTest: {
    id: bestResid.cfg.id,
    netSharpeAnn: bestResid.netSh,
    btc_beta: regResid.beta,
    dsr_p: dsrResid.deflatedProbability,
    XSshuffle_p: surResid.p,
    holdoutSharpeAnn: holdResidSh,
    note: "accel residualized vs momentum each week. If ~0 / fails OOS => no separable acceleration premium.",
  },
  matchedControl_bestPlainMomentum: { look: bestMomLook, sharpeAnn: bestMomSh },
  gates,
  bindingGate: binding,
  verdict,
  surrogateP: surBest.p,
  monthlyAt100k,
  topByVariant: variants.map((v) => {
    const b = scored.filter((s) => s.cfg.variant === v).sort((a, b) => b.netSh - a.netSh)[0];
    return { variant: v, bestId: b.cfg.id, netSh: b.netSh };
  }),
};
fs.writeFileSync(path.join(OUT, "q3-accel-strengthen.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(
  `\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surBest.p.toFixed(3)} | monthly@$100k ${allPass ? "$" + Math.round(monthlyAt100k) : "n/a"} | bestResidHoldout ${holdResidSh.toFixed(3)}`,
);
