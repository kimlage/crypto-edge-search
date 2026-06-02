/**
 * D4-S7 STRONGEST HONEST BUILD — short-term cross-sectional reversal.
 *
 * The weekly horizon is dead (diagnostic: meanIC≈0, t=-0.31 — momentum dominates).
 * But the daily panel shows real reversal at short horizons, microstructure-clean:
 *   L=5 H=1 skip=0  meanIC=-0.0334 t=-4.49
 *   L=3 H=3 skip=1  meanIC=-0.0360 t=-2.91  (skip-one removes bid-ask bounce, survives)
 * So the honest strongest version trades the DAILY short-term reversal, not weekly.
 *
 * Portfolio: each rebalance, demean signal cross-sectionally (pure XS, market-neutral),
 * long bottom-K / short top-K of the L-day return, dollar-neutral, hold H days, then
 * rebalance. skipDays gap between signal end and entry neutralizes bid-ask bounce.
 *
 * Costs: realistic. Each leg pays roundTripCost on full turnover at each rebalance.
 *   - aggressive 10bps/leg (taker-ish) AND realism check at 28bps (panel audit rule).
 * Gross-vs-net decomposition reported. Surrogate = cross-sectional shuffle of ranking.
 *
 * Gauntlet: Deflated Sharpe @ honest N (count the horizon/K grid we searched),
 * block-bootstrap CI, CPCV/PBO across the grid, surrogate p, skip-one bounce control.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/s7-strong.ts
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

const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };

const COINS = Object.keys(daily.closes);
const dailyCoins = COINS.filter((c) => {
  const cl = daily.closes[c];
  return cl && cl.every((v) => v != null && (v as number) > 0);
});
const D = daily.dates.length;
const logclose: Record<string, number[]> = {};
for (const c of dailyCoins) logclose[c] = (daily.closes[c] as number[]).map((v) => Math.log(v));
const ann = (s: number, ppy: number) => s * Math.sqrt(ppy);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dret(c: string, a: number, b: number): number {
  return logclose[c][b] - logclose[c][a];
}

/**
 * Run the daily XS-reversal portfolio.
 * L: signal lookback (days), H: holding period (days), skipDays: gap signal->entry,
 * fracK: top/bottom fraction, costLeg: round-trip cost per leg per rebalance,
 * shuffle: cross-sectional ranking shuffle (surrogate null).
 * Returns the per-rebalance NET portfolio return series (already H-day, non-overlapping).
 */
function runRev(
  L: number,
  H: number,
  skipDays: number,
  fracK: number,
  costLeg: number,
  shuffle: ((n: number) => number[]) | null,
): { net: number[]; gross: number[] } {
  const K = Math.max(2, Math.floor(dailyCoins.length * fracK));
  const net: number[] = [];
  const gross: number[] = [];
  for (let i = L + skipDays; i + H < D; i += H) {
    const sa = i - L - skipDays, sb = i - skipDays;
    let sig = dailyCoins.map((c) => dret(c, sa, sb));
    // pure XS: demean (market-neutral signal)
    const m = sig.reduce((a, b) => a + b, 0) / sig.length;
    sig = sig.map((x) => x - m);
    let order = sig.map((v, idx) => [v, idx] as [number, number]);
    if (shuffle) {
      const perm = shuffle(order.length);
      order = order.map((o, k) => [order[perm[k]][0], o[1]]);
    }
    order.sort((a, b) => a[0] - b[0]);
    const longs = order.slice(0, K).map((o) => o[1]); // losers -> long (fade)
    const shorts = order.slice(-K).map((o) => o[1]); // winners -> short
    // forward H-day return, dollar-neutral EW, demeaned to be market-neutral pnl
    const fwd = dailyCoins.map((c) => dret(c, i, i + H));
    const fmean = fwd.reduce((a, b) => a + b, 0) / fwd.length;
    let g = 0;
    for (const idx of longs) g += fwd[idx] - fmean;
    for (const idx of shorts) g -= fwd[idx] - fmean;
    g /= longs.length + shorts.length;
    // cost: full turnover both legs at each rebalance (we exit & re-enter every H days)
    const cost = 2 * costLeg;
    gross.push(g);
    net.push(g - cost);
  }
  return { net, gross };
}

// ----- honest search grid (everything we tried = the hidden N) -----
const grid: { L: number; H: number; skip: number; fracK: number }[] = [];
for (const L of [3, 5, 7])
  for (const H of [1, 3, 5])
    for (const skip of [0, 1])
      for (const fracK of [0.2, 0.33])
        grid.push({ L, H, skip, fracK });
const honestN = grid.length;

// cost scenarios
const COST_OPTIMISTIC = 0.0010; // 10 bps/leg (task spec)
const COST_REALISTIC = 0.0028 / 2; // 28 bps rt panel rule => 14 bps/leg

// score every grid config at optimistic cost; pick the best by NET annualized Sharpe.
type Row = { cfg: typeof grid[number]; ppy: number; netSh: number; grossSh: number; net: number[]; gross: number[] };
const rows: Row[] = grid.map((cfg) => {
  const { net, gross } = runRev(cfg.L, cfg.H, cfg.skip, cfg.fracK, COST_OPTIMISTIC, null);
  const ppy = 252 / cfg.H; // non-overlapping H-day rebalances
  return { cfg, ppy, netSh: ann(sharpe(net), ppy), grossSh: ann(sharpe(gross), ppy), net, gross };
});
rows.sort((a, b) => b.netSh - a.netSh);

console.log("=== honest grid (sorted by NET annualized Sharpe @10bps/leg) ===");
console.log("  L  H skip fracK   grossSh   netSh   nReb");
for (const r of rows) {
  console.log(
    `  ${r.cfg.L}  ${r.cfg.H}   ${r.cfg.skip}   ${r.cfg.fracK}   ${r.grossSh.toFixed(2).padStart(6)}  ${r.netSh.toFixed(2).padStart(6)}   ${r.net.length}`,
  );
}

const best = rows[0];
console.log(`\n=== BEST config: L=${best.cfg.L} H=${best.cfg.H} skip=${best.cfg.skip} fracK=${best.cfg.fracK} ===`);

// gross/net at both cost levels for the best config
const bestRealistic = runRev(best.cfg.L, best.cfg.H, best.cfg.skip, best.cfg.fracK, COST_REALISTIC, null);
const grossSh = ann(sharpe(best.gross), best.ppy);
const netShOpt = ann(sharpe(best.net), best.ppy);
const netShReal = ann(sharpe(bestRealistic.net), best.ppy);

// surrogate: cross-sectional shuffle of the ranking (destroys signal->coin mapping)
const r = rng(1234);
const shuffleFn = (n: number) => {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let j = n - 1; j > 0; j--) {
    const k = Math.floor(r() * (j + 1));
    [p[j], p[k]] = [p[k], p[j]];
  }
  return p;
};
const surr: number[] = [];
for (let it = 0; it < 500; it++) {
  const s = runRev(best.cfg.L, best.cfg.H, best.cfg.skip, best.cfg.fracK, COST_OPTIMISTIC, shuffleFn);
  surr.push(ann(sharpe(s.net), best.ppy));
}
surr.sort((a, b) => a - b);
const pSurro = surr.filter((x) => x >= netShOpt).length / surr.length;

// block-bootstrap CI of net mean return (own-autocorr preserving)
const bb = blockBootstrapConfidenceInterval(best.net, {
  statistic: "mean",
  iterations: 2000,
  blockLength: Math.max(2, Math.round(Math.sqrt(best.net.length))),
  seed: "s7-daily-rev",
});

// Deflated Sharpe @ honest N (we searched the whole grid)
const dsrOpt = computeDeflatedSharpeRatio(best.net, { trialCount: honestN });
const dsrReal = computeDeflatedSharpeRatio(bestRealistic.net, { trialCount: honestN });

// CPCV / PBO across the grid: treat each grid config as a "strategy", split the
// rebalance timeline into folds, select best in-sample, measure OOS rank. We use a
// common timeline by reusing the H of the best config so all rows align... but H varies.
// Cleaner: PBO over the subset of configs sharing the best H (apples-to-apples folds).
const sameH = grid.filter((g) => g.H === best.cfg.H);
const series = sameH.map((g) => runRev(g.L, g.H, g.skip, g.fracK, COST_OPTIMISTIC, null).net);
const nReb = Math.min(...series.map((s) => s.length));
const NF = 8;
const foldLen = Math.floor(nReb / NF);
const cscvStrategies = sameH.map((g, si) => ({
  id: `L${g.L}H${g.H}s${g.skip}k${g.fracK}`,
  folds: Array.from({ length: NF }, (_, f) => series[si].slice(f * foldLen, (f + 1) * foldLen)),
}));
const pbo = estimateCscvPbo(cscvStrategies, { statistic: "sharpe", trainFraction: 0.5 });

const meanNet = best.net.reduce((a, b) => a + b, 0) / best.net.length;
const monthlyPctNet = (Math.pow(1 + meanNet, (252 / best.cfg.H) / 12) - 1) * 100;

const summary = {
  item: "D4-S7 short-term reversal (daily XS, strongest honest build)",
  weeklyHorizonDead: "weekly meanIC=-0.0056 t=-0.31 (momentum dominates) — confirmed prior KILL",
  bestConfig: best.cfg,
  honestN,
  nRebalances: best.net.length,
  grossSharpeAnn: grossSh,
  netSharpeAnn_10bps: netShOpt,
  netSharpeAnn_28bpsRT: netShReal,
  surrogate_p: pSurro,
  blockBootstrap_meanNet_95CI: [bb.lower, bb.upper],
  blockBootstrap_estimate: bb.estimate,
  deflatedSharpe_p_10bps: dsrOpt.deflatedProbability,
  deflatedSharpe_p_28bps: dsrReal.deflatedProbability,
  dsr_expectedMaxSharpe: dsrOpt.expectedMaxSharpe,
  pbo: pbo.probabilityOfBacktestOverfitting ?? (pbo as any).pbo,
  monthlyReturnPctNet_10bps: monthlyPctNet,
  note:
    "Daily XS reversal, demeaned (market-neutral) signal & pnl, long losers/short winners, dollar-neutral. Cost = 2*leg full turnover each rebalance. Surrogate = XS ranking shuffle.",
};
console.log("\n=== GAUNTLET SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT, "s7-strong-results.json"), JSON.stringify({ grid: rows.map((r) => ({ ...r.cfg, grossSh: r.grossSh, netSh: r.netSh })), summary }, null, 2));
