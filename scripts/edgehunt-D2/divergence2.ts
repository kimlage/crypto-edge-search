/**
 * D2-CVD divergence — STRENGTHENING PASS (still strictly lagged h>=1).
 *
 * Three honest improvements over the literal divergence in divergence.ts:
 *  (A) RESIDUAL divergence: regress trailing price-change on trailing CVD-change
 *      (rolling OLS). The residual = part of CVD move NOT explained by price =
 *      the cleanest "hidden flow" signal. Trade sign(residual) lagged h>=1.
 *  (B) Direction test: divergence belief is ambiguous — does CVD lead price
 *      (momentum: follow the flow) or does it mark exhaustion (reversion: fade)?
 *      We test BOTH and count BOTH in honest N (no cherry-picking the sign).
 *  (C) 15m intraday: CVD divergence is a microstructure effect; test on 84k 15m
 *      bars too (aggregate awareness: 84k<100k so kept; daily reported primary).
 *
 * Gauntlet on the GATED h=1 net series. Null = block-bootstrap signed flow
 * re-paired with realized returns (recompute full residual-divergence on each
 * surrogate). Honest N = every (mode x dir x window x horizon) config across the
 * WHOLE strengthening family + the literal family from divergence.ts (45).
 */
import {
  loadDaily,
  load15m,
  simpleret,
  signedFlow,
  backtestNet,
  runGauntlet,
  rng,
  blockResampleIndices,
  printResult,
  type Bar,
} from "./lib.ts";
import { writeFileSync } from "node:fs";

const SUR = 1000;
const ANN_D = Math.sqrt(365);

function netSharpeOf(net: number[], ann: number): number {
  const m = net.reduce((a, b) => a + b, 0) / net.length;
  const sd = Math.sqrt(net.reduce((a, b) => a + (b - m) ** 2, 0) / net.length);
  return sd > 1e-12 ? (m / sd) * ann : 0;
}

/** rolling-OLS residual of y on x over window w (residual at each i uses only
 * data up to and including i). Returns residual_i = y_i - (a + b*x_i). */
function rollResidual(y: number[], x: number[], w: number): number[] {
  const out: number[] = new Array(y.length).fill(0);
  for (let i = 0; i < y.length; i += 1) {
    const lo = Math.max(0, i - w + 1);
    let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
    for (let j = lo; j <= i; j += 1) {
      sx += x[j]; sy += y[j]; sxx += x[j] * x[j]; sxy += x[j] * y[j]; k += 1;
    }
    const denom = k * sxx - sx * sx;
    if (Math.abs(denom) < 1e-12) { out[i] = 0; continue; }
    const b = (k * sxy - sx * sy) / denom;
    const a = (sy - b * sx) / k;
    out[i] = y[i] - (a + b * x[i]);
  }
  return out;
}
function zscore(x: number[], w: number): number[] {
  const out: number[] = new Array(x.length).fill(0);
  for (let i = 0; i < x.length; i += 1) {
    const lo = Math.max(0, i - w + 1);
    const win = x.slice(lo, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, win.length - 1));
    out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0;
  }
  return out;
}

/**
 * Residual-divergence positions.
 *  resid = price-slope MINUS its rolling-OLS projection on CVD-slope.
 *  Equivalent intuition: when CVD rose more than price "should" given the local
 *  price~flow relation, residual of PRICE is negative while CVD positive =>
 *  positive (bullish) divergence. We build the divergence score as:
 *     score = cvdSlopeZ  -  beta*priceSlope-projection  (the residual on the CVD side)
 *  Concretely: residualCVD = cvdSlope - OLS(cvdSlope ~ priceSlope). score = z(residualCVD).
 *  dir=+1 => trade WITH the score (flow leads), dir=-1 => fade (exhaustion).
 *  Position over bar i->i+1 from bar i-lag.
 */
function residDivPositions(
  flow: number[], close: number[], retsLen: number,
  slopeWin: number, regWin: number, zWin: number, lag: number, dir: number, hold: number,
): number[] {
  const cvd: number[] = new Array(flow.length).fill(0);
  for (let i = 1; i < flow.length; i += 1) cvd[i] = cvd[i - 1] + flow[i];
  const cvdSlope = cvd.map((v, i) => (i >= slopeWin ? v - cvd[i - slopeWin] : 0));
  const logc = close.map((c) => Math.log(c));
  const priceSlope = logc.map((v, i) => (i >= slopeWin ? v - logc[i - slopeWin] : 0));
  // residual of CVD-slope on price-slope = CVD move unexplained by price move
  const residCVD = rollResidual(cvdSlope, priceSlope, regWin);
  const score = zscore(residCVD, zWin);
  const raw: number[] = new Array(retsLen).fill(0);
  for (let i = 0; i < retsLen; i += 1) {
    const j = i - lag;
    if (j < 0) continue;
    raw[i] = dir * Math.max(-1, Math.min(1, score[j]));
  }
  if (hold <= 1) return raw;
  // smooth/hold: average target over last `hold` decision points (reduces turnover)
  const pos: number[] = new Array(retsLen).fill(0);
  for (let i = 0; i < retsLen; i += 1) {
    let s = 0, k = 0;
    for (let h = 0; h < hold; h += 1) { const jj = i - h; if (jj >= 0) { s += raw[jj]; k += 1; } }
    pos[i] = k > 0 ? s / k : 0;
  }
  return pos;
}

// ---------------- DAILY sweep ----------------
const slopeWins = [3, 5, 7, 10, 14];
const regWins = [30, 60, 90];
const zWins = [60, 90];
const dirs = [1, -1];      // both momentum and reversion -> honest N counts both
const holds = [1, 2, 3];
interface Cfg { id: string; slopeWin: number; regWin: number; zWin: number; dir: number; hold: number; }
const cfgs: Cfg[] = [];
for (const sw of slopeWins) for (const rw of regWins) for (const zw of zWins) for (const d of dirs) for (const h of holds)
  cfgs.push({ id: `sw${sw}_rw${rw}_zw${zw}_d${d > 0 ? "mom" : "rev"}_h${h}`, slopeWin: sw, regWin: rw, zWin: zw, dir: d, hold: h });
// honest N includes the 45 literal-divergence configs already tried in divergence.ts
const HONEST_N = cfgs.length + 45;

const SYMS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
const packs = SYMS.map((s) => {
  const bars = loadDaily(s);
  return { sym: s, rets: simpleret(bars), flow: signedFlow(bars), close: bars.map((b) => b.c) };
});

console.log(`=== D2-CVD residual-divergence strengthening (h>=1) ===`);
console.log(`honest N = ${HONEST_N} (this family ${cfgs.length} + literal 45)\n`);

function netFor(p: typeof packs[number], c: Cfg, lag: number) {
  const pos = residDivPositions(p.flow, p.close, p.rets.length, c.slopeWin, c.regWin, c.zWin, lag, c.dir, c.hold);
  return backtestNet(pos, p.rets);
}

// pick best by POOLED net Sharpe (h=1)
let best = cfgs[0]; let bestS = -Infinity;
for (const c of cfgs) {
  const pooled: number[] = [];
  for (const p of packs) pooled.push(...netFor(p, c, 1).net);
  const sh = netSharpeOf(pooled, ANN_D);
  if (sh > bestS) { bestS = sh; best = c; }
}
console.log(`best (pooled h=1) net Sharpe ${bestS.toFixed(3)}: ${best.id}\n`);

const btc = packs[0];
const btcBT = netFor(btc, best, 1);
const observed = netSharpeOf(btcBT.net, ANN_D);
const h2 = netSharpeOf(netFor(btc, best, 2).net, ANN_D);
const ceil = netSharpeOf(backtestNet(residDivPositions(btc.flow, btc.close, btc.rets.length, best.slopeWin, best.regWin, best.zWin, 0, best.dir, best.hold), btc.rets).gross, ANN_D);

// PBO across configs (BTC)
const foldsByCfg = cfgs.map((c) => {
  const net = netFor(btc, c, 1).net; const k = Math.floor(net.length / 5);
  return { id: c.id, folds: [0, 1, 2, 3, 4].map((f) => net.slice(f * k, (f + 1) * k)) };
});

// surrogate: block-bootstrap signed flow, keep realized returns
const sur: number[] = [];
for (let s = 0; s < SUR; s += 1) {
  const rand = rng(33000 + s);
  const idx = blockResampleIndices(btc.flow.length, 10, rand);
  const flowS = idx.map((j) => btc.flow[j]);
  const pos = residDivPositions(flowS, btc.close, btc.rets.length, best.slopeWin, best.regWin, best.zWin, 1, best.dir, best.hold);
  sur.push(netSharpeOf(backtestNet(pos, btc.rets).net, ANN_D));
}
const surP = (sur.filter((x) => x >= observed).length + 1) / (sur.length + 1);

const r = runGauntlet({
  name: "D2-CVD residual-divergence (h>=1)",
  config: best.id, net: btcBT.net, gross: btcBT.gross, turnover: btcBT.turnover,
  honestN: HONEST_N, surrogateSharpes: sur, observedSharpe: observed, buyHoldRets: btc.rets,
  pboStrategies: foldsByCfg, periodsPerYear: 365,
});
console.log(`  [h=0 ceiling gross Sharpe ${ceil.toFixed(2)} | h=1 net ${observed.toFixed(3)} | h=2 net ${h2.toFixed(3)}]`);
console.log(`  [pooled 4-sym h=1 net Sharpe ${bestS.toFixed(3)} | surrogate p ${surP.toFixed(4)}]`);
printResult(r);

// ---------------- 15m INTRADAY check (best-effort, strictly lagged) ----------------
console.log(`\n--- 15m intraday residual-divergence (h>=1, taker 4bps/side) ---`);
const m = load15m();
const mrets = simpleret(m); const mflow = signedFlow(m); const mclose = m.map((b) => b.c);
const ANN_15M = Math.sqrt(365 * 96); // 96 bars/day
let best15 = cfgs[0]; let best15S = -Infinity;
for (const c of cfgs) {
  const pos = residDivPositions(mflow, mclose, mrets.length, c.slopeWin, c.regWin, c.zWin, 1, c.dir, c.hold);
  const sh = netSharpeOf(backtestNet(pos, mrets).net, ANN_15M);
  if (sh > best15S) { best15S = sh; best15 = c; }
}
const bt15 = backtestNet(residDivPositions(mflow, mclose, mrets.length, best15.slopeWin, best15.regWin, best15.zWin, 1, best15.dir, best15.hold), mrets);
const obs15 = netSharpeOf(bt15.net, ANN_15M);
const ceil15 = netSharpeOf(backtestNet(residDivPositions(mflow, mclose, mrets.length, best15.slopeWin, best15.regWin, best15.zWin, 0, best15.dir, best15.hold), mrets).gross, ANN_15M);
const sur15: number[] = [];
for (let s = 0; s < 300; s += 1) {
  const rand = rng(44000 + s);
  const idx = blockResampleIndices(mflow.length, 20, rand);
  const fS = idx.map((j) => mflow[j]);
  const pos = residDivPositions(fS, mclose, mrets.length, best15.slopeWin, best15.regWin, best15.zWin, 1, best15.dir, best15.hold);
  sur15.push(netSharpeOf(backtestNet(pos, mrets).net, ANN_15M));
}
const surP15 = (sur15.filter((x) => x >= obs15).length + 1) / (sur15.length + 1);
console.log(`  15m best ${best15.id}: net Sharpe ${obs15.toFixed(3)} (h=0 ceiling gross ${ceil15.toFixed(2)}) turnover/bar ${bt15.turnover.toFixed(3)} surrogate p ${surP15.toFixed(4)} netMeanBp ${(bt15.net.reduce((a,b)=>a+b,0)/bt15.net.length*1e4).toFixed(3)}`);

const out = {
  daily: {
    bestConfig: best.id, honestN: HONEST_N,
    h1_netSharpe: +observed.toFixed(3), h2_netSharpe: +h2.toFixed(3),
    pooled4sym_h1: +bestS.toFixed(3), h0_ceiling_gross: +ceil.toFixed(2),
    buyHoldSharpe: +r.buyHoldSharpe.toFixed(3), bootLower: +r.bootLowerSharpe.toFixed(3),
    dsrProb: +r.dsrProb.toFixed(4), surrogateP: +surP.toFixed(4), pbo: r.pbo,
    pass: r.pass, bindingGate: r.bindingGate, monthlyAt100k: r.monthlyAt100k,
  },
  intraday15m: {
    bestConfig: best15.id, h1_netSharpe: +obs15.toFixed(3), h0_ceiling_gross: +ceil15.toFixed(2),
    surrogateP: +surP15.toFixed(4), netMeanBp: +(bt15.net.reduce((a,b)=>a+b,0)/bt15.net.length*1e4).toFixed(3),
    turnoverPerBar: +bt15.turnover.toFixed(3),
  },
};
console.log("\n=== STRENGTHENING SUMMARY ===");
console.log(JSON.stringify(out, null, 2));
writeFileSync("output/edgehunt-D2/divergence2_result.json", JSON.stringify(out, null, 2));
