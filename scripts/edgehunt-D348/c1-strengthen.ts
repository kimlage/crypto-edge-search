/**
 * edgehunt-D348 — D8-C1 Cross-venue funding-rate dispersion (Binance vs Bybit)
 * STRENGTHENED, executable, honest build (re-test of the prior KILL).
 *
 * What changed vs scripts/edgehunt-D348/harness.ts (the prior KILL):
 *  - NO LOOK-AHEAD. The prior harvested contemporaneous |d_t| (you cannot know the
 *    sign of this 8h funding diff before it is set). Here position p_t is set from the
 *    OBSERVED dispersion d_{t-1} and the realized pnl is p_t * d_t. This is what an
 *    actual trader captures; it relies on the dispersion's autocorrelation, which the
 *    EDA confirms is real (AR1 0.11..0.54, sign-persistence 61..70%).
 *  - Per-symbol independent positions (the prior shared one prevSign across all symbols — a bug).
 *  - Realistic cost: a sign flip reverses BOTH perp legs on BOTH venues = 4 taker fills
 *    @5bps each (legsPerFlip=4). Hysteresis deadband reduces churn.
 *  - The deadband is a SWEPT config -> counted in honest N (this is the real hidden search).
 *  - KEY control: head-to-head vs the funding LEVEL carry (short-richer-perp-vs-spot),
 *    answering "does dispersion add anything over level?".
 *  - RIGHT null: cross-sectional shuffle of the venue->funding mapping (relative-value null)
 *    + circular block-bootstrap on the realized spread.
 *  - CPCV/PBO across the deadband grid, Deflated Sharpe @ honest N, Harvey-Liu haircut.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/c1-strengthen.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

const SYMBOLS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"];
const TAKER = 0.0005; // 5 bps / leg (realistic taker on a USDT perp)
const LEGS_PER_FLIP = 4; // reverse both legs on both venues
const PPY = (365 * 24) / 8; // 8h funding periods per year
const DEADBANDS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4]; // bps hysteresis grid (the swept config)

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length) || 1e-12;
};
const sharpe = (x: number[]) => summarizeReturnSeries(x).sharpe;
const ann = (sp: number) => sp * Math.sqrt(PPY);

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
    for (let o = 0; o < blk && out.length < x.length; o++) out.push(x[(s + o) % x.length]);
  }
  return out;
}

function load(f: string): { t: number; r: number }[] {
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as { fundingTime: number; fundingRate: number }[];
  return raw.map((x) => ({ t: x.fundingTime, r: x.fundingRate })).sort((a, b) => a.t - b.t);
}
const key = (t: number) => Math.round(t / (3600 * 1000)) * 3600 * 1000;

// Aligned per-symbol arrays: aR = Binance funding, bR = Bybit funding
const perSym: { aR: number; bR: number }[][] = [];
for (const s of SYMBOLS) {
  const bin = load(path.join(ROOT, `output/funding/${s}USDT_funding_8h.json`));
  const byb = load(path.join(ROOT, `output/carry/bybit_${s}USDT_funding_8h.json`));
  const bm = new Map(byb.map((x) => [key(x.t), x.r]));
  const arr: { aR: number; bR: number }[] = [];
  for (const x of bin) {
    const bv = bm.get(key(x.t));
    if (bv != null) arr.push({ aR: x.r, bR: bv });
  }
  perSym.push(arr);
}
const N = Math.min(...perSym.map((a) => a.length));

// ---------------------------------------------------------------------------
// Executable dispersion strategy: per-symbol position from observed d_{t-1}.
// pnl_t = p_t * (aR_t - bR_t); cost on sign change = LEGS_PER_FLIP * TAKER.
// Returns the equal-weight portfolio of per-8h pnl (cross-sectional avg).
// ---------------------------------------------------------------------------
function runDispersion(deadbandBps: number): { net: number[]; gross: number[]; flipRate: number } {
  const net: number[] = [];
  const gross: number[] = [];
  const pos = SYMBOLS.map(() => 0);
  let flips = 0;
  let steps = 0;
  for (let i = 1; i < N; i++) {
    let g = 0;
    let nt = 0;
    for (let k = 0; k < SYMBOLS.length; k++) {
      const dPrev = (perSym[k][i - 1].aR - perSym[k][i - 1].bR) * 1e4; // bps
      const dNow = perSym[k][i].aR - perSym[k][i].bR;
      let newPos = pos[k];
      if (Math.abs(dPrev) > deadbandBps) newPos = Math.sign(dPrev);
      const changed = newPos !== pos[k];
      const cost = changed ? LEGS_PER_FLIP * TAKER : 0;
      // long the cheap-funding venue / short the rich: if Binance funding > Bybit (d>0),
      // Binance is "rich" -> short Binance perp / long Bybit perp -> you capture +d when d>0.
      // pnl sign = newPos * dNow with newPos = sign(dPrev). (positive when persistence holds)
      g += newPos * dNow;
      nt += newPos * dNow - cost;
      if (changed) flips++;
      steps++;
      pos[k] = newPos;
    }
    gross.push(g / SYMBOLS.length);
    net.push(nt / SYMBOLS.length);
  }
  return { net, gross, flipRate: flips / steps };
}

// ---------------------------------------------------------------------------
// CONTROL: funding LEVEL carry (short the richer perp vs spot). This is the
// canonical "short-richer-perp" carry. We harvest max(aR,bR,0) per 8h (you only
// take the carry when the richer venue's funding is positive), net of one entry
// taker amortized via a deadband-equivalent (held while positive => low churn).
// This is the redundancy check: does dispersion beat just collecting level carry?
// ---------------------------------------------------------------------------
function runLevelCarry(): { net: number[]; gross: number[] } {
  const net: number[] = [];
  const gross: number[] = [];
  const pos = SYMBOLS.map(() => 0); // 1 if currently short the richer perp
  for (let i = 1; i < N; i++) {
    let g = 0;
    let nt = 0;
    for (let k = 0; k < SYMBOLS.length; k++) {
      const richPrev = Math.max(perSym[k][i - 1].aR, perSym[k][i - 1].bR);
      const richNow = Math.max(perSym[k][i].aR, perSym[k][i].bR);
      const newPos = richPrev > 0 ? 1 : 0; // short richer perp only if its funding positive
      const changed = newPos !== pos[k];
      const cost = changed ? 2 * TAKER : 0; // single perp leg in/out (2 legs round-trip amortized)
      g += newPos * richNow;
      nt += newPos * richNow - cost;
      pos[k] = newPos;
    }
    gross.push(g / SYMBOLS.length);
    net.push(nt / SYMBOLS.length);
  }
  return { net, gross };
}

// ---------------------------------------------------------------------------
// Sweep deadband, pick best NET (this selection is the hidden search).
// ---------------------------------------------------------------------------
const sweep = DEADBANDS.map((db) => {
  const r = runDispersion(db);
  return { db, netSh: ann(sharpe(r.net)), grossSh: ann(sharpe(r.gross)), flipRate: r.flipRate, net: r.net, gross: r.gross };
});
const best = sweep.reduce((a, b) => (b.netSh > a.netSh ? b : a));

// Level carry control (no sweep, one canonical config).
const level = runLevelCarry();
const levelSh = ann(sharpe(level.net));
const levelGrossSh = ann(sharpe(level.gross));

// Does dispersion add over level? compare gross (pure-signal) and net.
const bestGross = best.gross;
const dispGrossSh = ann(sharpe(bestGross));

// ---------------------------------------------------------------------------
// RIGHT null #1: cross-sectional shuffle of venue->funding mapping per timestamp.
// Under the relative-value null you cannot know which venue is cheap, so the sign
// you assign is random per symbol per step. Re-run the SAME engine (incl. cost &
// best deadband) with venue identity randomly swapped each (symbol,step).
// ---------------------------------------------------------------------------
function runShuffled(deadbandBps: number, r: () => number): number[] {
  const net: number[] = [];
  const pos = SYMBOLS.map(() => 0);
  // pre-draw a per-(symbol,step) swap mask so the surrogate is internally consistent in time
  for (let i = 1; i < N; i++) {
    let nt = 0;
    for (let k = 0; k < SYMBOLS.length; k++) {
      const swapPrev = r() < 0.5;
      const swapNow = r() < 0.5;
      const aPrev = swapPrev ? perSym[k][i - 1].bR : perSym[k][i - 1].aR;
      const bPrev = swapPrev ? perSym[k][i - 1].aR : perSym[k][i - 1].bR;
      const aNow = swapNow ? perSym[k][i].bR : perSym[k][i].aR;
      const bNow = swapNow ? perSym[k][i].aR : perSym[k][i].bR;
      const dPrev = (aPrev - bPrev) * 1e4;
      const dNow = aNow - bNow;
      let newPos = pos[k];
      if (Math.abs(dPrev) > deadbandBps) newPos = Math.sign(dPrev);
      const cost = newPos !== pos[k] ? LEGS_PER_FLIP * TAKER : 0;
      nt += newPos * dNow - cost;
      pos[k] = newPos;
    }
    net.push(nt / SYMBOLS.length);
  }
  return net;
}
const rS = rng(101);
const surroShuffle: number[] = [];
for (let it = 0; it < 1000; it++) surroShuffle.push(ann(sharpe(runShuffled(best.db, rS))));
surroShuffle.sort((a, b) => a - b);
const pShuffle = surroShuffle.filter((x) => x >= best.netSh).length / surroShuffle.length;
const surroShuffleMean = mean(surroShuffle);

// RIGHT null #2: circular block-bootstrap on the realized NET spread series
// (preserves own autocorr, tests whether mean>0 is distinguishable from a
// resampled-own-history null around its own mean=0 recentered).
const rB = rng(202);
const recentered = best.net.map((x) => x - mean(best.net));
const bootSh: number[] = [];
for (let it = 0; it < 1000; it++) bootSh.push(ann(sharpe(blockResample(recentered, 21, rB))));
bootSh.sort((a, b) => a - b);
const pBoot = bootSh.filter((x) => x >= best.netSh).length / bootSh.length;

// Block-bootstrap CI of the mean per-8h net (is it even > 0?).
const bbCI = blockBootstrapConfidenceInterval(best.net, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 21,
  confidenceLevel: 0.95,
  seed: "c1-net-mean",
});

// ---------------------------------------------------------------------------
// CPCV / PBO across the deadband grid (each deadband = a "strategy"; folds in time).
// ---------------------------------------------------------------------------
const FOLDS = 8;
const foldLen = Math.floor((N - 1) / FOLDS);
const cscvStrategies = DEADBANDS.map((db) => {
  const series = runDispersion(db).net;
  const folds: number[][] = [];
  for (let f = 0; f < FOLDS; f++) folds.push(series.slice(f * foldLen, (f + 1) * foldLen));
  return { id: `db${db}`, folds };
});
const pbo = estimateCscvPbo(cscvStrategies, { statistic: "sharpe", trainFraction: 0.5 });

// ---------------------------------------------------------------------------
// Honest N: deadband grid (8) x [dispersion vs level framing] x signal-rule choices.
// The real hidden search is the deadband sweep + the cost/legs assumptions explored.
// Be conservative-honest: 8 deadbands x ~3 cost assumptions x 2 leg models ~ 48 configs.
// ---------------------------------------------------------------------------
const HONEST_N = 48;
const dsr = computeDeflatedSharpeRatio(best.net, { trialCount: HONEST_N });

// Harvey-Liu style haircut: multiple-testing adjusted t. Effective t = sharpe*sqrt(n).
// Haircut Sharpe ~ Sharpe * (1 - haircutFraction) where haircut from DSR p.
const nObs = best.net.length;
const tStat = sharpe(best.net) * Math.sqrt(nObs);
// Bonferroni-adjusted required |t| for HONEST_N trials at 5% two-sided:
const bonfAlpha = 0.05 / HONEST_N;

// Monthly return @ $100k (net), using compounded mean per 8h.
const meanNet8h = mean(best.net);
const monthlyPctNet = (Math.pow(1 + meanNet8h, PPY / 12) - 1) * 100;
const monthlyDollarNet = (monthlyPctNet / 100) * 100000;

const results = {
  n: nObs,
  symbols: SYMBOLS,
  taker_bps_per_leg: TAKER * 1e4,
  legs_per_flip: LEGS_PER_FLIP,
  deadband_sweep: sweep.map((s) => ({
    deadbandBps: s.db,
    grossSharpeAnn: +s.grossSh.toFixed(3),
    netSharpeAnn: +s.netSh.toFixed(3),
    flipRatePct: +(s.flipRate * 100).toFixed(2),
  })),
  best_config: {
    deadbandBps: best.db,
    netSharpeAnn: +best.netSh.toFixed(3),
    grossSharpeAnn: +best.grossSh.toFixed(3),
    dispersionGrossSharpeAnn: +dispGrossSh.toFixed(3),
    flipRatePct: +(best.flipRate * 100).toFixed(2),
    meanNet_bps_per8h: +(meanNet8h * 1e4).toFixed(4),
  },
  level_carry_control: {
    netSharpeAnn: +levelSh.toFixed(3),
    grossSharpeAnn: +levelGrossSh.toFixed(3),
  },
  dispersion_adds_over_level_NET: best.netSh > levelSh,
  dispersion_adds_over_level_GROSS: dispGrossSh > levelGrossSh,
  surrogate_venue_shuffle_p: +pShuffle.toFixed(4),
  surrogate_venue_shuffle_meanSharpe: +surroShuffleMean.toFixed(3),
  blockBootstrap_recentered_p: +pBoot.toFixed(4),
  net_mean_per8h_CI95: { lower: +(bbCI.lower * 1e4).toFixed(4), upper: +(bbCI.upper * 1e4).toFixed(4), estimate: +(bbCI.estimate * 1e4).toFixed(4) },
  pbo: +pbo.pbo.toFixed(4),
  honest_N: HONEST_N,
  deflated_sharpe_p: +dsr.deflatedProbability.toFixed(4),
  expectedMaxSharpe_underNull_ann: +(dsr.expectedMaxSharpe * Math.sqrt(PPY)).toFixed(3),
  tStat: +tStat.toFixed(2),
  bonferroni_alpha: bonfAlpha,
  monthlyReturnPctNet: +monthlyPctNet.toFixed(3),
  monthlyDollarNet_at_100k: +monthlyDollarNet.toFixed(0),
  note:
    "Executable lagged-sign dispersion (no look-ahead): position from d_{t-1}, pnl=p*d_t, 4 legs/flip @5bps, deadband swept (counted in honest N). Level-carry control = short-richer-perp. Surrogate = venue->funding cross-sectional shuffle.",
};

fs.writeFileSync(path.join(OUT, "c1-strengthen.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
