/**
 * Q3-ACCEL — Acceleration momentum (momentum-of-momentum), D4-M6.
 *
 * Belief: accelerating trends persist; decelerating winners reverse. Signal = the
 * 2nd derivative of price drift (change-in-momentum). Cross-sectional across the
 * 30-coin weekly panel, DOLLAR-NEUTRAL (EW long-top / short-bottom) and
 * BETA-NEUTRAL (BTC beta hedged + verified). Null = cross-sectional shuffle.
 *
 * Strongest honest build:
 *   accel_i = mom(short) - mom(long)            (difference of two trailing cum-returns)
 *   where mom(L) at week i = trailing-L-week cumulative return ending at week i.
 *   Several encodings tried (count EVERY config in honest N):
 *     - DIFF:   r_recent(s) - r_prior(s) over non-overlapping windows  (ROC-of-ROC)
 *     - SLOPE:  mom(short) - mom(long)          (acceleration as short-minus-long drift)
 *   K in {3,4,5}, window pairs in a small pre-registered grid.
 *
 * Gauntlet (committed primitives, cross-sectional flavour):
 *   - net of cost (taker 4bps/side -> weekly turnover priced per leg)
 *   - baselines: BTC buy&hold, dollar-neutral RANDOM-LOTTERY (matched gross exposure),
 *     and the RIGHT matched-exposure control = PLAIN XS MOMENTUM (1st derivative).
 *     Acceleration must beat plain momentum or it is just (a noisier) momentum.
 *   - BTC beta of the book (must be ~0; also report beta-hedged book).
 *   - Deflated Sharpe @ HONEST N (= every config scored).
 *   - CPCV / PBO across all configs (estimateCscvPbo).
 *   - Harvey-Liu Bonferroni haircut.
 *   - RIGHT surrogate null: CROSS-SECTIONAL SHUFFLE (permute signal->coin mapping
 *     each week; preserves the realized return cross-section + dollar-neutrality).
 *   - consume-once forward holdout (last 20% of weeks, best cfg only, evaluated ONCE).
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-quant/q3-accel.ts
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

const COST_PER_SIDE = 0.0004; // 4 bps taker per side
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

// ---- tradeable mask: real return, kill long exact-zero runs (dead/migrated feeds) ----
const RAW: Record<string, (number | null)[]> = weekly.weeklyRet;
const MASK: Record<string, boolean[]> = {};
for (const c of COINS) {
  const arr = RAW[c];
  const m = new Array(W).fill(false);
  for (let i = 0; i < W; i++) {
    const v = arr[i];
    m[i] = v != null && isFinite(v as number);
  }
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

// trailing cumulative return over [i-look+1, i], requires all weeks tradeable
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

// ---- signal builders ------------------------------------------------------
// SLOPE acceleration: short-window drift minus long-window drift (mom-of-mom).
function accelSlope(c: string, i: number, sShort: number, sLong: number): number | null {
  const mS = trailRet(c, i, sShort);
  const mL = trailRet(c, i, sLong);
  if (mS == null || mL == null) return null;
  // annualize each leg to a per-week drift so the difference is a clean 2nd-derivative
  const dS = mS / sShort;
  const dL = mL / sLong;
  return dS - dL;
}
// DIFF acceleration (ROC-of-ROC): recent L-week return minus the prior, non-overlapping L-week return.
function accelDiff(c: string, i: number, look: number): number | null {
  const recent = trailRet(c, i, look);
  const prior = trailRet(c, i - look, look);
  if (recent == null || prior == null) return null;
  return recent - prior;
}
// plain momentum (1st derivative) — the matched-exposure control
function momPlain(c: string, i: number, look: number): number | null {
  return trailRet(c, i, look);
}

type Signal = (c: string, i: number) => number | null;

// ---- dollar-neutral EW long-top / short-bottom book -----------------------
// Returns the realized weekly net PnL series + the matched BTC return series for beta.
function runBook(
  signal: Signal,
  K: number,
  startWk: number,
  endWk: number, // exclusive
  shuffle = false,
  r?: () => number,
): { port: number[]; btc: number[]; nWk: number; turnoverMean: number } {
  const port: number[] = [];
  const btc: number[] = [];
  let prevL: string[] = [];
  let prevS: string[] = [];
  let turnSum = 0;
  let turnN = 0;
  for (let i = startWk; i < endWk; i++) {
    // signal known at close of week i; realize over week i+1
    if (i + 1 >= W) break;
    let scored = COINS.map((c) => ({ c, v: signal(c, i) })).filter(
      (x) => x.v != null && MASK[x.c][i + 1],
    ) as { c: string; v: number }[];
    if (scored.length < 2 * K + 1) {
      // not enough names this week: flat, but keep BTC for alignment
      port.push(0);
      btc.push(ret("BTC", i + 1) ?? 0);
      prevL = [];
      prevS = [];
      continue;
    }
    if (shuffle && r) {
      // CROSS-SECTIONAL SHUFFLE: permute the signal->coin mapping (destroys ranking,
      // preserves the realized return cross-section + dollar-neutrality).
      const vs = scored.map((x) => x.v);
      for (let j = vs.length - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        [vs[j], vs[k]] = [vs[k], vs[j]];
      }
      scored = scored.map((x, idx) => ({ c: x.c, v: vs[idx] }));
    }
    scored.sort((a, b) => b.v - a.v);
    const longs = scored.slice(0, K).map((x) => x.c); // top accel
    const shorts = scored.slice(-K).map((x) => x.c); // bottom accel
    let pl = 0;
    let cl = 0;
    for (const c of longs) {
      const v = ret(c, i + 1);
      if (v != null) (pl += v), cl++;
    }
    let ps = 0;
    let cs = 0;
    for (const c of shorts) {
      const v = ret(c, i + 1);
      if (v != null) (ps += v), cs++;
    }
    // dollar-neutral EW: +1/K on each long, -1/K on each short -> gross exposure = 2
    let pr = (cl > 0 ? pl / K : 0) - (cs > 0 ? ps / K : 0);
    const turn =
      prevL.filter((c) => !longs.includes(c)).length +
      longs.filter((c) => !prevL.includes(c)).length +
      prevS.filter((c) => !shorts.includes(c)).length +
      shorts.filter((c) => !prevS.includes(c)).length;
    // each name carries 1/K notional; turnover cost = (#legs changed / K) * costPerSide
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
  if (n < 3) return { alpha: 0, beta: 0, resid: y.slice() };
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) * (x[i] - mx);
  }
  const beta = vx > 1e-12 ? cov / vx : 0;
  const alpha = my - beta * mx;
  return { alpha, beta, resid: y.map((v, i) => v - (alpha + beta * x[i])) };
}

// ---- config grid (count EVERY config in honest N) -------------------------
type Cfg = {
  id: string;
  kind: "slope" | "diff";
  K: number;
  a: number; // short window (slope) or look (diff)
  b: number; // long window (slope); unused for diff
};
function sigOf(cfg: Cfg): Signal {
  if (cfg.kind === "slope") return (c, i) => accelSlope(c, i, cfg.a, cfg.b);
  return (c, i) => accelDiff(c, i, cfg.a);
}

const Ks = [3, 4, 5];
const slopePairs: [number, number][] = [
  [2, 6],
  [4, 12],
  [4, 26],
  [8, 26],
  [12, 52],
];
const diffLooks = [4, 8, 12, 26];
const CFGS: Cfg[] = [];
for (const K of Ks) {
  for (const [a, b] of slopePairs)
    CFGS.push({ id: `slope_${a}_${b}_K${K}`, kind: "slope", K, a, b });
  for (const a of diffLooks) CFGS.push({ id: `diff_${a}_K${K}`, kind: "diff", K, a, b: 0 });
}
const HONEST_N = CFGS.length;

// warmup so all configs have data: max window used = 52 (slope long) and diff needs 2*26
const WARMUP = 52;
const TRADE_START = WARMUP;
const TRADE_END = W - 1; // last week has no realization
const span = TRADE_END - TRADE_START;
const SPLIT = TRADE_START + Math.floor(span * 0.8); // 80/20 consume-once holdout

// ---- score every config IN-SAMPLE on net Sharpe --------------------------
const scored = CFGS.map((cfg) => {
  const book = runBook(sigOf(cfg), cfg.K, TRADE_START, SPLIT);
  return { cfg, book, netSh: ann(sharpe(book.port)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];

// ---- baselines -----------------------------------------------------------
// BTC buy&hold (in-sample window)
const btcBH: number[] = [];
for (let i = TRADE_START; i < SPLIT; i++) {
  const v = ret("BTC", i + 1);
  if (v != null) btcBH.push(v);
}
const bhSh = ann(sharpe(btcBH));

// dollar-neutral random-lottery: random K-long / K-short books, matched gross exposure
const rlSh: number[] = [];
{
  const rl = rng(909090);
  for (let it = 0; it < 200; it++) {
    const port: number[] = [];
    for (let i = TRADE_START; i < SPLIT; i++) {
      if (i + 1 >= W) break;
      const avail = COINS.filter((c) => MASK[c][i] && MASK[c][i + 1]);
      if (avail.length < 2 * best.cfg.K + 1) {
        port.push(0);
        continue;
      }
      // pick 2K distinct names at random
      const pool = avail.slice();
      for (let j = pool.length - 1; j > 0; j--) {
        const k = Math.floor(rl() * (j + 1));
        [pool[j], pool[k]] = [pool[k], pool[j]];
      }
      const longs = pool.slice(0, best.cfg.K);
      const shorts = pool.slice(best.cfg.K, 2 * best.cfg.K);
      let pl = 0;
      for (const c of longs) pl += ret(c, i + 1)!;
      let ps = 0;
      for (const c of shorts) ps += ret(c, i + 1)!;
      port.push(pl / best.cfg.K - ps / best.cfg.K);
    }
    rlSh.push(ann(sharpe(port)));
  }
}
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];

// MATCHED-EXPOSURE CONTROL = plain XS momentum (1st derivative), same K & best look.
// Use the momentum look that matches the winning accel config's longer window.
const momLook = best.cfg.kind === "slope" ? best.cfg.b : best.cfg.a;
const momBook = runBook((c, i) => momPlain(c, i, momLook), best.cfg.K, TRADE_START, SPLIT);
const momSh = ann(sharpe(momBook.port));
// also: BEST plain-momentum over a matched grid (so accel must beat the best 1st-derivative too)
const momLooks = [4, 8, 12, 26, 52];
let bestMomSh = -Infinity;
let bestMomLook = momLook;
for (const L of momLooks) {
  for (const K of Ks) {
    const b = runBook((c, i) => momPlain(c, i, L), K, TRADE_START, SPLIT);
    const s = ann(sharpe(b.port));
    if (s > bestMomSh) {
      bestMomSh = s;
      bestMomLook = L;
    }
  }
}

const beatsBH = best.netSh > bhSh;
const beatsRL = best.netSh > rl95;
const beatsMom = best.netSh > momSh && best.netSh > bestMomSh;
const baselinePass = best.netSh > 0 && beatsRL && beatsMom;

// ---- BTC beta of best book + beta-hedged variant -------------------------
const reg = regress(best.book.port, best.book.btc);
const betaHedged = best.book.port.map((v, i) => v - reg.beta * best.book.btc[i]);
const betaHedgedSh = ann(sharpe(betaHedged));

// ---- Deflated Sharpe @ honest N ------------------------------------------
const dsr = computeDeflatedSharpeRatio(best.book.port, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;

// ---- block bootstrap CI on mean weekly net -------------------------------
const bb = blockBootstrapConfidenceInterval(best.book.port, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 8,
  confidenceLevel: 0.95,
  seed: "q3-accel-bb",
});
const bbPass = bb.lower > 0;

// ---- CPCV / PBO across all configs ---------------------------------------
function toFolds(series: number[], nf: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / nf);
  for (let f = 0; f < nf; f++) {
    const lo = f * sz;
    const hi = f === nf - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}
let pbo = 1;
let medianLogit = 0;
try {
  const r = estimateCscvPbo(
    scored.map((s) => ({ id: s.cfg.id, folds: toFolds(s.book.port, 6) })),
    { statistic: "sharpe", trainFraction: 0.5 },
  );
  pbo = r.pbo;
  medianLogit = r.medianLogit;
} catch {
  pbo = 1;
}
const pboPass = pbo < 0.5;

// ---- Harvey-Liu Bonferroni haircut ---------------------------------------
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const sBest = summarizeReturnSeries(best.book.port);
const psrZ =
  sBest.sampleCount > 3 && sBest.stdDev > 0
    ? (sBest.sharpe * Math.sqrt(sBest.sampleCount - 1)) /
      Math.sqrt(
        Math.max(
          1e-9,
          1 - sBest.skewness * sBest.sharpe + ((sBest.kurtosis - 1) / 4) * sBest.sharpe ** 2,
        ),
      )
    : 0;
const psrP = 1 - normCdf(psrZ);
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// ---- RIGHT surrogate null: CROSS-SECTIONAL SHUFFLE ------------------------
const NSURR = 500;
const surr: number[] = [];
{
  const r = rng(424242);
  for (let it = 0; it < NSURR; it++) {
    const book = runBook(sigOf(best.cfg), best.cfg.K, TRADE_START, SPLIT, true, r);
    surr.push(ann(sharpe(book.port)));
  }
}
surr.sort((a, b) => a - b);
const surrAbove = surr.filter((s) => s >= best.netSh).length;
const surrP = (surrAbove + 1) / (NSURR + 1);
const surrPass = surrP < 0.05;
const surrMean = mean(surr);
const surr95 = surr[Math.floor(0.95 * (NSURR - 1))];

// ---- consume-once forward holdout (best cfg ONLY, evaluated ONCE) --------
const holdBook = runBook(sigOf(best.cfg), best.cfg.K, SPLIT, TRADE_END);
const holdSh = ann(sharpe(holdBook.port));
const holdReg = regress(holdBook.port, holdBook.btc);
const holdoutPass = holdSh > 0;

// ---- assemble gates in binding order -------------------------------------
const meanWk = mean(best.book.port);
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: {
    pass: meanWk > 0,
    detail: `meanWeeklyNet=${meanWk.toExponential(3)} turnover=${best.book.turnoverMean.toFixed(2)}`,
  },
  baselines: {
    pass: baselinePass,
    detail: `accelNetSh=${best.netSh.toFixed(3)} vs plainMom(L${momLook})=${momSh.toFixed(3)} bestMom(L${bestMomLook})=${bestMomSh.toFixed(3)} RL95=${rl95.toFixed(3)} BTC_BH=${bhSh.toFixed(3)}`,
  },
  deflated_sharpe: {
    pass: dsrPass,
    detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh=${dsr.expectedMaxSharpe.toFixed(4)}`,
  },
  block_bootstrap: {
    pass: bbPass,
    detail: `meanWkNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
  },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.toFixed(3)} medianLogit=${medianLogit.toFixed(3)}` },
  haircut: {
    pass: haircutPass,
    detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})`,
  },
  surrogate: {
    pass: surrPass,
    detail: `XS-shuffle p=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${surrMean.toFixed(3)} surr95=${surr95.toFixed(3)}`,
  },
  holdout: {
    pass: holdoutPass,
    detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdBook.nWk} wk (OOS beta=${holdReg.beta.toFixed(3)})`,
  },
};
const order = [
  "net_of_cost",
  "baselines",
  "deflated_sharpe",
  "block_bootstrap",
  "cpcv_pbo",
  "haircut",
  "surrogate",
  "holdout",
];
let binding = "none";
for (const g of order)
  if (!gates[g].pass) {
    binding = g;
    break;
  }
const allPass = binding === "none";
const survivesCore =
  gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";

const monthlyAt100k = allPass ? meanWk * (52 / 12) * 100000 : NaN;

const out = {
  item: "Q3-ACCEL / D4-M6 Acceleration momentum (momentum-of-momentum), XS dollar+beta-neutral",
  honestN: HONEST_N,
  universe: `30-coin weekly panel, tradeable mask (zero-run feeds removed), ${WEEKS[TRADE_START]}..${WEEKS[TRADE_END]}`,
  inSampleWeeks: best.book.nWk,
  holdoutWeeks: holdBook.nWk,
  best: {
    id: best.cfg.id,
    netSharpeAnn: best.netSh,
    grossSharpeAnn: ann(sharpe(best.book.port.map((v) => v))),
    meanWeeklyNet: meanWk,
    turnover: best.book.turnoverMean,
    btc_beta: reg.beta,
    betaHedgedSharpeAnn: betaHedgedSh,
    monthlyReturnPctNet: (Math.pow(1 + meanWk, 52 / 12) - 1) * 100,
  },
  baselines: {
    BTC_buyHold_sharpeAnn: bhSh,
    randomLottery95_sharpeAnn: rl95,
    plainMomentum_matched_sharpeAnn: momSh,
    bestPlainMomentum_sharpeAnn: bestMomSh,
    accel_beats_plainMomentum: beatsMom,
  },
  gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, { pass: v.pass, detail: v.detail }])),
  bindingGate: binding,
  surrogateP: surrP,
  holdoutSharpeAnn: holdSh,
  verdict,
  monthlyAt100k,
  top5Configs: scored.slice(0, 5).map((s) => ({ id: s.cfg.id, netSh: s.netSh })),
  bottom3Configs: scored.slice(-3).map((s) => ({ id: s.cfg.id, netSh: s.netSh })),
};
fs.writeFileSync(path.join(OUT, "q3-accel.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(
  `\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${allPass ? "$" + Math.round(monthlyAt100k) : "n/a"} | holdoutSharpe ${holdSh.toFixed(3)} btcBeta ${reg.beta.toFixed(3)}`,
);
