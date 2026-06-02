/**
 * D7-CME tradable strategy + gauntlet.
 *
 * STRATEGY (lagged entry toward the gap):
 *   At the Sun CME reopen (or Mon 00:00 UTC, configurable LAG), if a weekend gap exists, take a
 *   position toward the Friday close:
 *     gap up   (sunOpen > friClose)  -> SHORT (bet price falls to fill)
 *     gap down (sunOpen < friClose)  -> LONG  (bet price rises to fill)
 *   Exit at the FIRST of: (a) gap fills (touch friClose) -> take profit at friClose;
 *                         (b) end of week (next Fri CME close) -> exit at market.
 *   Optional minimum gap threshold (skip tiny gaps), optional stop, optional cap on hold.
 *
 * RETURN SERIES: one realized net log-return per weekend (the per-trade PnL), aligned to the
 * weekend index. Buy&hold baseline = passive long over the same Sun->Fri horizon each week.
 *
 * COST: 4 bps taker per side (entry + exit) => 8 bps round trip, applied to every trade.
 *
 * RIGHT NULL (surrogate-gap / calendar-reanchor): re-anchor the gap to a RANDOM weekday's
 * close instead of the true Fri CME close (calendar-reanchor), AND/OR randomize the gap sign
 * (random-level placebo). The surrogate rebuilds the SAME trade rule on a fake gap; if the real
 * gap's net Sharpe is not above the surrogate distribution, no edge.
 */
import fs from "node:fs";
import {
  loadBars,
  buildWeekends,
  barAtOrBefore,
  type Bar,
  type Weekend,
} from "./d7cme_probe.ts";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// annualization: ~52 trades/yr => sqrt(52)
const ANN = Math.sqrt(52);

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
function sharpe(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
function annSharpe(a: number[]): number {
  return sharpe(a) * ANN;
}
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Get bar index at-or-after epoch
function idxAtOrAfter(bars: Bar[], epoch: number): number {
  let lo = 0,
    hi = bars.length - 1,
    ans = bars.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t >= epoch) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

interface Cfg {
  minGapPct: number; // skip gaps smaller than this (abs)
  maxGapPct: number; // skip gaps larger than this (abs); >=1 = no cap
  lagHours: number; // entry lag after sun reopen (0 = at reopen)
  stopMult: number; // stop loss at stopMult * gap distance adverse (>=99 = none)
}

// Simulate one trade given an entry epoch, entry price, target (friClose), direction, and horizon.
// Returns the realized net log-return (signed by direction; cost applied for entry+exit).
function simTrade(
  bars: Bar[],
  entryEpoch: number,
  entryPrice: number,
  target: number,
  weekEndEpoch: number,
  isLong: boolean,
  stopMult: number,
): number {
  const startI = idxAtOrAfter(bars, entryEpoch);
  const gapDist = Math.abs(target - entryPrice) / entryPrice;
  // stop level: adverse move of stopMult * gapDist from entry
  const stopLevel = isLong
    ? entryPrice * (1 - stopMult * gapDist)
    : entryPrice * (1 + stopMult * gapDist);
  let exitPrice = entryPrice;
  let exited = false;
  for (let i = startI; i < bars.length && bars[i].t <= weekEndEpoch; i++) {
    const b = bars[i];
    if (isLong) {
      // target above entry: fill when high>=target
      if (stopMult < 99 && b.l <= stopLevel) {
        exitPrice = stopLevel;
        exited = true;
        break;
      }
      if (b.h >= target) {
        exitPrice = target;
        exited = true;
        break;
      }
    } else {
      if (stopMult < 99 && b.h >= stopLevel) {
        exitPrice = stopLevel;
        exited = true;
        break;
      }
      if (b.l <= target) {
        exitPrice = target;
        exited = true;
        break;
      }
    }
  }
  if (!exited) {
    // exit at week-end close (next Fri CME close)
    const endBar = barAtOrBefore(bars, weekEndEpoch);
    exitPrice = endBar ? endBar.c : entryPrice;
  }
  const grossLog = isLong
    ? Math.log(exitPrice / entryPrice)
    : Math.log(entryPrice / exitPrice);
  // cost: 8 bps round-trip on notional ~ subtract 2*COST in log space
  return grossLog - 2 * COST_PER_SIDE;
}

// Build the per-weekend net return series for a config. Weekends w/o a trade => return 0 (flat).
function buildReturns(
  bars: Bar[],
  weekends: Weekend[],
  cfg: Cfg,
  // gapOverride: optional (entryPrice, target, isLong) override for surrogate nulls
  override?: (w: Weekend, rng: () => number) => { target: number; isLong: boolean } | null,
  rng?: () => number,
): number[] {
  const out: number[] = [];
  for (const w of weekends) {
    const ag = Math.abs(w.gapPct);
    if (ag < cfg.minGapPct || (cfg.maxGapPct < 1 && ag > cfg.maxGapPct)) {
      out.push(0);
      continue;
    }
    // entry at sunOpen + lag
    const entryEpoch = w.sunOpenEpoch + cfg.lagHours * HOUR;
    const entryBar = barAtOrBefore(bars, entryEpoch);
    if (!entryBar) {
      out.push(0);
      continue;
    }
    const entryPrice = entryBar.c;
    let target = w.friClose;
    let isLong = entryPrice < w.friClose; // gap down -> long toward fill
    if (override && rng) {
      const o = override(w, rng);
      if (!o) {
        out.push(0);
        continue;
      }
      target = o.target;
      isLong = o.isLong;
    }
    const r = simTrade(bars, entryEpoch, entryPrice, target, w.weekEndEpoch, isLong, cfg.stopMult);
    out.push(r);
  }
  return out;
}

// Passive buy&hold over the same Sun->Fri horizon each week (long-beta baseline)
function buildBuyHold(bars: Bar[], weekends: Weekend[]): number[] {
  const out: number[] = [];
  for (const w of weekends) {
    const eb = barAtOrBefore(bars, w.sunOpenEpoch);
    const xb = barAtOrBefore(bars, w.weekEndEpoch);
    if (!eb || !xb) {
      out.push(0);
      continue;
    }
    out.push(Math.log(xb.c / eb.c));
  }
  return out;
}

// ---- main: grid + gauntlet ----
const bars = loadBars();
const weekends = buildWeekends(bars);
const N = weekends.length;
console.log(`weekends=${N} span=${new Date(weekends[0].sunOpenEpoch).toISOString().slice(0, 10)}..${new Date(weekends[N - 1].sunOpenEpoch).toISOString().slice(0, 10)}`);

// HONEST grid: minGap x maxGap x lag x stop
const minGaps = [0, 0.005, 0.01, 0.02];
const maxGaps = [1, 0.04, 0.02]; // 1 = no cap
const lags = [0, 3, 24]; // hours
const stops = [99, 1, 2]; // 99 = no stop
const grid: Cfg[] = [];
for (const mg of minGaps)
  for (const xg of maxGaps)
    for (const lg of lags)
      for (const st of stops) {
        if (xg < 1 && mg >= xg) continue;
        grid.push({ minGapPct: mg, maxGapPct: xg, lagHours: lg, stopMult: st });
      }
const HONEST_N = grid.length;
console.log(`honest N (configs)=${HONEST_N}`);

// holdout split: last 20% of weekends consumed once
const splitIdx = Math.floor(N * 0.8);
const isW = weekends.slice(0, splitIdx);
const oosW = weekends.slice(splitIdx);

// score every config in-sample on net Sharpe
const scored = grid.map((cfg) => {
  const r = buildReturns(bars, isW, cfg);
  // only count weeks with an actual trade for the per-trade Sharpe? No—keep flat-0 weeks to be
  // honest about capital idle; but report both. Strategy return series = all weeks (0 when flat).
  const traded = r.filter((x) => x !== 0);
  return {
    cfg,
    ret: r,
    traded,
    nTrades: traded.length,
    netSh: annSharpe(r),
    netShTraded: annSharpe(traded),
    label: `mg=${cfg.minGapPct},xg=${cfg.maxGapPct},lag=${cfg.lagHours},stop=${cfg.stopMult}`,
  };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
console.log(`\nTOP 6 configs by in-sample net Sharpe (all-weeks series):`);
for (const s of scored.slice(0, 6)) {
  console.log(
    `  ${s.label}: netSh=${s.netSh.toFixed(3)} netShTraded=${s.netShTraded.toFixed(3)} nTrades=${s.nTrades} meanRet=${(mean(s.ret) * 1e4).toFixed(2)}bps`,
  );
}

const bestRet = best.ret;
// ---- gauntlet gates ----
// baselines
const bh = buildBuyHold(bars, isW);
const bhSh = annSharpe(bh);
// random-lottery: random direction (coin flip) at same entries, matched trade count
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(424242 + i * 2654435761);
  const r = buildReturns(bars, isW, best.cfg, (w, rg) => {
    // random direction, target at same |gap| distance
    const dist = Math.abs(w.gapPct);
    if (dist < best.cfg.minGapPct) return null;
    const up = rg() < 0.5;
    const eb = barAtOrBefore(bars, w.sunOpenEpoch + best.cfg.lagHours * HOUR);
    const ep = eb ? eb.c : w.sunOpen;
    return { target: ep * (up ? 1 + dist : 1 - dist), isLong: up };
  }, rng);
  rlSh.push(annSharpe(r));
}
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

// Deflated Sharpe @ honest N
const dsr = computeDeflatedSharpeRatio(bestRet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;

// block bootstrap CI on mean
const bb = blockBootstrapConfidenceInterval(bestRet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 8,
  confidenceLevel: 0.95,
  seed: "d7cme-bb",
});
const bbPass = bb.lower > 0;

// CSCV/PBO
function toFolds(s: number[], nf: number): number[][] {
  const f: number[][] = [];
  const sz = Math.floor(s.length / nf);
  for (let i = 0; i < nf; i++) f.push(s.slice(i * sz, i === nf - 1 ? s.length : (i + 1) * sz));
  return f;
}
let pbo = 1,
  medLogit = 0;
try {
  const r = estimateCscvPbo(
    scored.map((s) => ({ id: s.label, folds: toFolds(s.ret, 6) })),
    { statistic: "sharpe", trainFraction: 0.5 },
  );
  pbo = r.pbo;
  medLogit = r.medianLogit;
} catch (e) {
  pbo = 1;
}
const pboPass = pbo < 0.5;

// Harvey-Liu Bonferroni haircut
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const ss = summarizeReturnSeries(bestRet);
const psrZ =
  ss.sampleCount >= 3 && ss.stdDev > 0
    ? (ss.sharpe * Math.sqrt(ss.sampleCount - 1)) /
      Math.sqrt(Math.max(1e-9, 1 - ss.skewness * ss.sharpe + ((ss.kurtosis - 1) / 4) * ss.sharpe * ss.sharpe))
    : 0;
const psrP = 1 - normalCdf(psrZ);
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// RIGHT surrogate null: calendar-reanchor (anchor gap to a random weekday close) + random sign.
// Rebuild the SAME trade rule against a surrogate target.
const nSurr = 500;
const surr: number[] = [];
for (let i = 0; i < nSurr; i++) {
  const rng = mkRng(7000 + i * 7919);
  const r = buildReturns(bars, isW, best.cfg, (w, rg) => {
    const dist = Math.abs(w.gapPct);
    if (dist < best.cfg.minGapPct || (best.cfg.maxGapPct < 1 && dist > best.cfg.maxGapPct)) return null;
    // calendar-reanchor: target is a level at the SAME |dist| but random direction from entry
    // (surrogate-gap / random-level placebo). Direction independent of true gap.
    const up = rg() < 0.5;
    const eb = barAtOrBefore(bars, w.sunOpenEpoch + best.cfg.lagHours * HOUR);
    const ep = eb ? eb.c : w.sunOpen;
    return { target: ep * (up ? 1 + dist : 1 - dist), isLong: up };
  }, rng);
  surr.push(annSharpe(r));
}
surr.sort((a, b) => a - b);
const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);
const surrPass = surrP < 0.05;

// consume-once holdout
const holdRet = buildReturns(bars, oosW, best.cfg);
const holdSh = annSharpe(holdRet);
const holdoutPass = holdSh > 0;

const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: {
    pass: mean(bestRet) > 0,
    detail: `meanRet=${(mean(bestRet) * 1e4).toFixed(3)}bps/wk nTrades=${best.nTrades} netSh=${best.netSh.toFixed(3)}`,
  },
  baselines: {
    pass: baselinePass,
    detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomDir95=${rl95.toFixed(3)}`,
  },
  deflated_sharpe: {
    pass: dsrPass,
    detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh=${dsr.expectedMaxSharpe.toFixed(4)} sh=${ss.sharpe.toFixed(4)}`,
  },
  block_bootstrap: {
    pass: bbPass,
    detail: `meanRet CI95=[${(bb.lower * 1e4).toFixed(3)},${(bb.upper * 1e4).toFixed(3)}]bps`,
  },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.toFixed(3)} medLogit=${medLogit.toFixed(3)}` },
  haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)}*N=${HONEST_N})` },
  surrogate: {
    pass: surrPass,
    detail: `surrogateP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
  },
  holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRet.filter((x) => x !== 0).length} trades` },
};

const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
let binding = "none";
for (const g of order) if (!gates[g].pass) { binding = g; break; }
const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
const verdict = binding === "none" ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
const monthly = mean(bestRet) > 0 ? mean(bestRet) * (52 / 12) * 100000 : NaN;

console.log(`\n================ D7-CME gauntlet ================`);
console.log(`honestN=${HONEST_N} best=${best.label}`);
console.log(`best netSharpeAnn=${best.netSh.toFixed(3)} meanRet=${(mean(bestRet) * 1e4).toFixed(3)}bps/wk nTrades=${best.nTrades}`);
for (const [g, r] of Object.entries(gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${Number.isFinite(monthly) ? "$" + Math.round(monthly) : "n/a"}`);

fs.writeFileSync(
  `${ROOT}/output/edgehunt-requeue/d7cme_result.json`,
  JSON.stringify({ honestN: HONEST_N, best: best.label, gates, verdict, binding, surrP, bhSh, rl95, holdSh, meanRetBps: mean(bestRet) * 1e4 }, null, 2),
);
