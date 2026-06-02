/**
 * D2-CVD — CVD DIVERGENCE (strictly lagged). The actual D2 hypothesis:
 *
 *   Belief: cumulative volume delta (CVD) DIVERGES from price ahead of reversals.
 *   "Absorption": CVD rising while price flat/down = hidden accumulation -> long.
 *   "Distribution": CVD falling while price flat/up = hidden distribution -> short.
 *
 * This is DISTINCT from CVD trend-following (runV3 in run.ts, which just goes long
 * when flow z is high and therefore inherits BTC's long bias and cannot beat
 * buy-and-hold). The divergence signal is (near) market-neutral by construction:
 * it only fires when flow and price DISAGREE, so the beats-buyhold gate is a real,
 * beatable test rather than an automatic fail.
 *
 * CRITICAL: only the strictly-LAGGED (h>=1) signal counts as edge. The position
 * held over bar i->i+1 is decided from information at bar i-1 or earlier. The h=0
 * (same-bar) version is the circular tautology (the trades ARE the move) and is
 * reported separately as a ceiling, never as the edge.
 *
 * RIGHT NULL (per BACKLOG D2-V3 / D2-D3 spec):
 *   Primary  = block-bootstrap (circular, block=10) of the SIGNED-FLOW stream,
 *              re-paired with the SAME realized returns. Destroys any flow->future
 *              return link while preserving return autocorr AND flow autocorr. The
 *              divergence signal is fully recomputed on each surrogate path.
 *   Secondary= phase-randomization of returns (preserves return power spectrum /
 *              autocorr, destroys nonlinear flow->return coupling), CVD path held.
 * p = P(null net Sharpe >= observed net Sharpe).
 *
 * Honest N = every config in the sweep (DSR trialCount). Cost = taker 4bps/side.
 */
import {
  loadDaily,
  simpleret,
  signedFlow,
  backtestNet,
  runGauntlet,
  rng,
  blockResampleIndices,
  printResult,
  type Bar,
  type GateResult,
} from "./lib.ts";
import { writeFileSync } from "node:fs";

const SUR = 1000; // surrogate paths
const ANN = Math.sqrt(365);

// ---------- helpers ----------
function sma(x: number[], w: number): number[] {
  const out: number[] = new Array(x.length).fill(0);
  let s = 0;
  for (let i = 0; i < x.length; i += 1) {
    s += x[i];
    if (i >= w) s -= x[i - w];
    out[i] = i >= w - 1 ? s / w : x.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
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
function netSharpeOf(net: number[]): number {
  const m = net.reduce((a, b) => a + b, 0) / net.length;
  const sd = Math.sqrt(net.reduce((a, b) => a + (b - m) ** 2, 0) / net.length);
  return sd > 1e-12 ? (m / sd) * ANN : 0;
}

/**
 * Build the CVD-divergence position series.
 *  - flow: per-bar signed taker volume (buy-sell)
 *  - close: per-bar close
 *  - slopeWin: window over which we measure the CVD slope and the price slope
 *  - zWin: rolling window for normalizing both slopes
 *  - lag: h (>=1 for the edge; 0 for the circular ceiling)
 *  - mode: "div" pure divergence; "divband" divergence gated to flat-price band
 * Position over bar i->i+1 decided from bar (i-lag).
 *
 * Divergence value d = cvdSlopeZ - priceSlopeZ  (flow strength minus price strength).
 *  d>0  => flow stronger than price (accumulation / positive divergence) -> LONG
 *  d<0  => flow weaker than price (distribution / negative divergence)   -> SHORT
 * In "divband" we additionally require |priceSlopeZ| < band (price "flat") so we
 * only trade genuine divergences (CVD moving while price is quiet), matching the
 * literal belief "CVD rising while price flat/down".
 */
function divPositions(
  flow: number[],
  close: number[],
  retsLen: number,
  slopeWin: number,
  zWin: number,
  lag: number,
  mode: "div" | "divband",
  band: number,
): number[] {
  // cumulative volume delta
  const cvd: number[] = new Array(flow.length).fill(0);
  for (let i = 1; i < flow.length; i += 1) cvd[i] = cvd[i - 1] + flow[i];
  // trailing slopes (difference over slopeWin), then z-scored over zWin
  const cvdSlope = cvd.map((v, i) => (i >= slopeWin ? v - cvd[i - slopeWin] : 0));
  const logc = close.map((c) => Math.log(c));
  const priceSlope = logc.map((v, i) => (i >= slopeWin ? v - logc[i - slopeWin] : 0));
  const cz = zscore(cvdSlope, zWin);
  const pz = zscore(priceSlope, zWin);
  const pos: number[] = new Array(retsLen).fill(0);
  for (let i = 0; i < retsLen; i += 1) {
    const j = i - lag;
    if (j < 0) continue;
    const d = cz[j] - pz[j]; // divergence: flow strength minus price strength
    let signal: number;
    if (mode === "divband") {
      // only when price is "flat" (|pz|<band) and flow is meaningfully moving
      signal = Math.abs(pz[j]) < band ? Math.max(-1, Math.min(1, cz[j])) : 0;
    } else {
      signal = Math.max(-1, Math.min(1, d / 2)); // continuous divergence exposure
    }
    pos[i] = signal;
  }
  return pos;
}

interface SymPack {
  sym: string;
  rets: number[];
  flow: number[];
  close: number[];
}

function loadSym(sym: string): SymPack {
  const bars = loadDaily(sym);
  return {
    sym,
    rets: simpleret(bars),
    flow: signedFlow(bars),
    close: bars.map((b) => b.c),
  };
}

// ---------- config sweep (HONEST N = every config) ----------
const slopeWins = [3, 5, 7, 10, 14];
const zWins = [30, 60, 90];
const modes: ("div" | "divband")[] = ["div", "divband"];
const bands = [0.5, 1.0]; // only used by divband
interface Cfg {
  id: string;
  slopeWin: number;
  zWin: number;
  mode: "div" | "divband";
  band: number;
}
const cfgs: Cfg[] = [];
for (const sw of slopeWins)
  for (const zw of zWins)
    for (const m of modes)
      for (const b of m === "divband" ? bands : [0]) {
        cfgs.push({ id: `${m}_sw${sw}_zw${zw}_b${b}`, slopeWin: sw, zWin: zw, mode: m, band: b });
      }
const HONEST_N = cfgs.length; // every config tried, across the whole family

console.log(`=== D2-CVD divergence (strictly lagged h>=1) ===`);
console.log(`honest N = ${HONEST_N} configs (div + divband sweep)\n`);

// Build per-symbol net series for each config at the edge lag (h=1).
const SYMS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
const packs = SYMS.map(loadSym);

function netForCfg(p: SymPack, c: Cfg, lag: number): { net: number[]; gross: number[]; turn: number } {
  const pos = divPositions(p.flow, p.close, p.rets.length, c.slopeWin, c.zWin, lag, c.mode, c.band);
  const bt = backtestNet(pos, p.rets);
  return { net: bt.net, gross: bt.gross, turn: bt.turnover };
}

// ---------- pick best config by POOLED net Sharpe across symbols (h=1) ----------
// Pooling reduces single-asset overfit; honest N still = every config.
let best: Cfg = cfgs[0];
let bestS = -Infinity;
const pooledNetByCfg: Record<string, number[]> = {};
for (const c of cfgs) {
  const pooled: number[] = [];
  for (const p of packs) pooled.push(...netForCfg(p, c, 1).net);
  pooledNetByCfg[c.id] = pooled;
  const sh = netSharpeOf(pooled);
  if (sh > bestS) {
    bestS = sh;
    best = c;
  }
}
console.log(`best config (pooled h=1 net Sharpe ${bestS.toFixed(3)}): ${best.id}\n`);

// ---------- BTC-only evaluation of the best config at h=1 (the gated edge) ----------
const btc = packs[0];
const btcBT = (() => {
  const pos = divPositions(btc.flow, btc.close, btc.rets.length, best.slopeWin, best.zWin, 1, best.mode, best.band);
  return backtestNet(pos, btc.rets);
})();
const observedBTC = netSharpeOf(btcBT.net);

// ---------- h=0 circular ceiling (NOT edge) ----------
const ceilGross = (() => {
  const pos = divPositions(btc.flow, btc.close, btc.rets.length, best.slopeWin, best.zWin, 0, best.mode, best.band);
  const bt = backtestNet(pos, btc.rets);
  return netSharpeOf(bt.gross);
})();

// ---------- h=2 robustness (edge should not vanish at deeper lag) ----------
const h2BTC = (() => {
  const pos = divPositions(btc.flow, btc.close, btc.rets.length, best.slopeWin, best.zWin, 2, best.mode, best.band);
  return netSharpeOf(backtestNet(pos, btc.rets).net);
})();

// ---------- PBO across configs (BTC, 5 folds) ----------
const foldsByCfg = cfgs.map((c) => {
  const net = netForCfg(btc, c, 1).net;
  const k = Math.floor(net.length / 5);
  return { id: c.id, folds: [0, 1, 2, 3, 4].map((f) => net.slice(f * k, (f + 1) * k)) };
});

// ---------- SURROGATE NULL 1: block-bootstrap signed flow, keep realized returns ----------
// Destroys flow->future-return coupling; preserves both autocorrs. Recompute the
// FULL divergence signal (CVD rebuilt from resampled flow) at h=1 on each path.
function surrogateFlowBlock(): number[] {
  const out: number[] = [];
  const blk = 10;
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(11000 + s);
    const idx = blockResampleIndices(btc.flow.length, blk, rand);
    const flowS = idx.map((j) => btc.flow[j]);
    const pos = divPositions(flowS, btc.close, btc.rets.length, best.slopeWin, best.zWin, 1, best.mode, best.band);
    out.push(netSharpeOf(backtestNet(pos, btc.rets).net));
  }
  return out;
}

// ---------- SURROGATE NULL 2: phase-randomization of returns ----------
// Preserves the return power spectrum (=> autocorrelation), destroys phase
// alignment / nonlinear coupling to flow. Close path rebuilt from phase-randomized
// returns; CVD (flow) held fixed. p = P(null >= observed).
function phaseRandomize(x: number[], rand: () => number): number[] {
  // real FFT via naive DFT (n~3210, SUR small enough); use radix-agnostic DFT.
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const xc = x.map((v) => v - mean);
  // DFT
  const re: number[] = new Array(n).fill(0);
  const im: number[] = new Array(n).fill(0);
  for (let k = 0; k < n; k += 1) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t += 1) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += xc[t] * Math.cos(ang);
      si += xc[t] * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  // randomize phases (keep magnitudes), preserve conjugate symmetry
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k += 1) {
    const mag = Math.hypot(re[k], im[k]);
    const ph = 2 * Math.PI * rand();
    re[k] = mag * Math.cos(ph);
    im[k] = mag * Math.sin(ph);
    const kk = n - k;
    if (kk !== k && kk < n) {
      re[kk] = re[k];
      im[kk] = -im[k];
    }
  }
  // inverse DFT (real part)
  const out: number[] = new Array(n).fill(0);
  for (let t = 0; t < n; t += 1) {
    let sr = 0;
    for (let k = 0; k < n; k += 1) {
      const ang = (2 * Math.PI * k * t) / n;
      sr += re[k] * Math.cos(ang) - im[k] * Math.sin(ang);
    }
    out[t] = sr / n + mean;
  }
  return out;
}

function surrogatePhase(nPaths: number): number[] {
  // phase-randomization is O(n^2) per path; cap paths for runtime, n=3210.
  const out: number[] = [];
  for (let s = 0; s < nPaths; s += 1) {
    const rand = rng(22000 + s);
    const retsS = phaseRandomize(btc.rets, rand);
    // rebuild close path from phase-randomized returns
    const closeS: number[] = [btc.close[0]];
    for (let i = 0; i < retsS.length; i += 1) closeS.push(closeS[i] * (1 + retsS[i]));
    const pos = divPositions(btc.flow, closeS, retsS.length, best.slopeWin, best.zWin, 1, best.mode, best.band);
    out.push(netSharpeOf(backtestNet(pos, retsS).net));
  }
  return out;
}

console.log("running surrogate null 1 (block-bootstrap signed flow)...");
const surFlow = surrogateFlowBlock();
console.log("running surrogate null 2 (phase-randomization of returns, 200 paths)...");
const surPhase = surrogatePhase(200);

// combine: report the WORSE (more conservative) surrogate p for the gate
const pFlow = (surFlow.filter((x) => x >= observedBTC).length + 1) / (surFlow.length + 1);
const pPhase = (surPhase.filter((x) => x >= observedBTC).length + 1) / (surPhase.length + 1);
const conservativeP = Math.max(pFlow, pPhase);

// ---------- run the committed gauntlet on the gated (h=1) BTC edge ----------
const r: GateResult = runGauntlet({
  name: "D2-CVD divergence (h>=1, strictly lagged)",
  config: best.id,
  net: btcBT.net,
  gross: btcBT.gross,
  turnover: btcBT.turnover,
  honestN: HONEST_N,
  surrogateSharpes: surFlow, // primary null in the gauntlet
  observedSharpe: observedBTC,
  buyHoldRets: btc.rets,
  pboStrategies: foldsByCfg,
  periodsPerYear: 365,
});

console.log(`\n  [h=0 circular ceiling gross Sharpe = ${ceilGross.toFixed(2)} — NOT edge]`);
console.log(`  [h=1 net Sharpe = ${observedBTC.toFixed(3)} | h=2 net Sharpe = ${h2BTC.toFixed(3)}]`);
console.log(`  [surrogate p: flow-block=${pFlow.toFixed(4)} phase-rand=${pPhase.toFixed(4)} -> conservative=${conservativeP.toFixed(4)}]`);
console.log(`  [pooled (4-sym) h=1 net Sharpe = ${bestS.toFixed(3)}]`);
printResult(r);

// recompute the gauntlet pass using the CONSERVATIVE surrogate p (max of both nulls)
const gatesWithConservative = {
  ...r,
  surrogateP: conservativeP,
};
// binding-gate recheck with conservative p
const gates: [string, boolean][] = [
  ["net-sharpe>0.3", r.netSharpeAnn > 0.3],
  ["beats-buyhold", r.netSharpeAnn > r.buyHoldSharpe],
  ["boot-CI-lower>0", r.bootLowerSharpe > 0],
  ["DSR@N>0.95", r.dsrProb > 0.95],
  ["surrogate-p<0.05", conservativeP < 0.05],
  ["PBO<0.5", r.pbo === null ? true : r.pbo < 0.5],
];
let binding = "ALL-PASS";
let pass = true;
for (const [g, ok] of gates) {
  if (!ok) {
    binding = g;
    pass = false;
    break;
  }
}

const summary = {
  observedNetSharpe_h1_BTC: +observedBTC.toFixed(3),
  pooled4sym_h1_netSharpe: +bestS.toFixed(3),
  h2_netSharpe: +h2BTC.toFixed(3),
  h0_circular_ceiling_grossSharpe: +ceilGross.toFixed(2),
  buyHoldSharpe: +r.buyHoldSharpe.toFixed(3),
  bootLowerSharpe: +r.bootLowerSharpe.toFixed(3),
  dsrProb_atHonestN: +r.dsrProb.toFixed(4),
  surrogateP_flowBlock: +pFlow.toFixed(4),
  surrogateP_phaseRand: +pPhase.toFixed(4),
  surrogateP_conservative: +conservativeP.toFixed(4),
  pbo: r.pbo,
  honestN: HONEST_N,
  bestConfig: best.id,
  pass_with_conservative_surrogate: pass,
  bindingGate: binding,
  monthlyAt100k: pass ? r.monthlyAt100k : null,
};
console.log("\n=== FINAL (conservative surrogate) ===");
console.log(JSON.stringify(summary, null, 2));
writeFileSync("output/edgehunt-D2/divergence_result.json", JSON.stringify({ gauntlet: gatesWithConservative, summary }, null, 2));
