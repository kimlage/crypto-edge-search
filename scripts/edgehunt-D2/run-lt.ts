/**
 * D2-LT — Large-trade / whale-print short-horizon momentum (15m flow).
 *
 * HYPOTHESIS (BACKLOG D2-M4 / "whale tape"): top-percentile signed-volume bars
 * ("whale prints") in btc_15m_flow are informed; short-horizon price momentum
 * continues in the print's direction. We test the strictly-LAGGED (h>=1)
 * version only — the same-bar move IS the print (aggressive taker volume moves
 * its own bar), so h=0 is circular look-ahead and reported only as a ceiling.
 *
 * GENUINE-EDGE PROTOCOL:
 *  - Detect whale prints two honest ways: (A) global top-percentile |signed
 *    flow|; (B) relative print = |signed flow| / trailing-mean |signed flow|.
 *  - After a print at bar j (decided from close-of-j info), hold a position over
 *    bars j+1..j+h  (strictly lagged, h>=1). Cost charged on entry+exit (taker
 *    4bps/side).
 *  - Direction is part of the SEARCH (momentum = +sign(flow), reversal =
 *    -sign(flow)); both count toward honest N. We let the data pick, then the
 *    gauntlet judges with the multiple-testing-aware DSR @ honest N.
 *  - Build a continuous per-15m-bar net P&L series (positions overlap-averaged)
 *    so the committed gauntlet (DSR, block-boot CI, CPCV/PBO, surrogate null)
 *    applies. periodsPerYear = 96*365 (15m bars).
 *  - RIGHT NULL = block bootstrap of the signed-flow stream re-paired with the
 *    SAME realized returns: destroys flow->future-return link, preserves both
 *    autocorrelation structures. p = P(null netSharpe >= observed).
 *  - Extra Harvey-Liu-style multiple-testing haircut: report the Bonferroni-
 *    haircut surrogate p (p * honestN) as an additional honest gate.
 *
 * The LAGGED component must clear the committed gates ALONE.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  load15m,
  backtestNet,
  runGauntlet,
  rng,
  blockResampleIndices,
  printResult,
  COST_PER_SIDE,
  type Bar,
  type GateResult,
} from "./lib.ts";

const SUR = 1000; // surrogate paths
const PPY = 96 * 365; // 15m bars per year
const results: Record<string, GateResult & { extra?: Record<string, unknown> }> = {};

function tstat(xs: number[]): { m: number; t: number; n: number } {
  const n = xs.length;
  if (n < 2) return { m: 0, t: 0, n };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return { m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, n };
}

/**
 * Build a continuous per-bar position series from whale-print events.
 * print[j] true => take direction `dir*sign(flow[j])` and HOLD it over the next
 * `h` bars (bars j+1 .. j+h). Strictly lagged: position over bar i->i+1 is set
 * by prints in [i-h, i-1]. Overlapping events are AVERAGED (capped to [-1,1]),
 * which is the honest "always-on whale book" portfolio. Returns the per-bar
 * target position array aligned to rets (rets[i] = bar i -> i+1).
 */
function eventsToPositions(
  flow: number[],
  print: boolean[],
  h: number,
  dir: number,
  nRets: number,
): number[] {
  const pos = new Array(nRets).fill(0);
  const cnt = new Array(nRets).fill(0);
  for (let j = 0; j < flow.length; j += 1) {
    if (!print[j]) continue;
    const want = dir * Math.sign(flow[j]);
    // position is HELD over bars j..j+h-1 (i.e. realized returns rets[j..j+h-1]);
    // rets[j] = c[j+1]/c[j]-1 is the FIRST return after the close-of-j decision,
    // so this is strictly lagged (h>=1, no same-bar leakage).
    for (let k = 0; k < h; k += 1) {
      const i = j + k;
      if (i >= 0 && i < nRets) {
        pos[i] += want;
        cnt[i] += 1;
      }
    }
  }
  for (let i = 0; i < nRets; i += 1) {
    if (cnt[i] > 0) pos[i] = Math.max(-1, Math.min(1, pos[i] / cnt[i]));
  }
  return pos;
}

function annSharpeOf(net: number[]): number {
  const m = net.reduce((a, b) => a + b, 0) / net.length;
  const sd = Math.sqrt(net.reduce((a, b) => a + (b - m) ** 2, 0) / net.length);
  return sd > 1e-12 ? (m / sd) * Math.sqrt(PPY) : 0;
}

function rollingMeanAbs(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(0);
  let acc = 0;
  for (let i = 0; i < x.length; i += 1) {
    acc += Math.abs(x[i]);
    if (i >= w) acc -= Math.abs(x[i - w]);
    out[i] = acc / Math.min(i + 1, w);
  }
  return out;
}

function quantile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
}

function runLT() {
  const bars: Bar[] = load15m();
  const flow = bars.map((b) => 2 * b.tbb - b.v); // signed taker flow per bar
  const absFlow = flow.map(Math.abs);
  const rets: number[] = [];
  for (let i = 0; i < bars.length - 1; i += 1) rets.push(bars[i + 1].c / bars[i].c - 1);
  const nRets = rets.length;
  const buyHold = rets;

  // rolling baseline for relative-print detector (1-day window = 96 bars)
  const rollW = 96;
  const rollMeanAbs = rollingMeanAbs(flow, rollW);

  // ---- honest config grid ----
  // detector: 'pct' (global percentile) or 'rel' (relative to trailing mean)
  // pct in {0.99,0.995,0.999}; rel-K in {3,5,8}
  // horizon h in {1,2,4,8} (15m .. 2h)  [STRICTLY LAGGED]
  // direction dir in {+1 momentum, -1 reversal}
  const pctLevels = [0.99, 0.995, 0.999];
  const relLevels = [3, 5, 8];
  const horizons = [1, 2, 4, 8];
  const dirs = [1, -1];

  type Cfg = { id: string; pos: number[]; det: string; lvl: number; h: number; dir: number };
  const configs: Cfg[] = [];

  // precompute print masks
  const pctMasks: Record<number, boolean[]> = {};
  for (const p of pctLevels) {
    const thr = quantile(absFlow, p);
    pctMasks[p] = absFlow.map((x, i) => i >= rollW && x >= thr);
  }
  const relMasks: Record<number, boolean[]> = {};
  for (const k of relLevels) {
    relMasks[k] = absFlow.map((x, i) => i >= rollW && rollMeanAbs[i] > 0 && x / rollMeanAbs[i] >= k);
  }

  for (const det of ["pct", "rel"] as const) {
    const levels = det === "pct" ? pctLevels : relLevels;
    for (const lvl of levels) {
      const mask = det === "pct" ? pctMasks[lvl] : relMasks[lvl];
      for (const h of horizons) {
        for (const dir of dirs) {
          const pos = eventsToPositions(flow, mask, h, dir, nRets);
          configs.push({ id: `${det}${lvl}_h${h}_d${dir > 0 ? "mom" : "rev"}`, pos, det, lvl, h, dir });
        }
      }
    }
  }
  const honestN = configs.length; // EVERY config = one trial

  // pick best by net Sharpe
  let best = configs[0];
  let bestS = -Infinity;
  const foldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of configs) {
    const bt = backtestNet(c.pos, rets);
    const sh = annSharpeOf(bt.net);
    if (sh > bestS) {
      bestS = sh;
      best = c;
    }
    const k = Math.floor(bt.net.length / 5);
    foldsByCfg.push({ id: c.id, folds: [0, 1, 2, 3, 4].map((f) => bt.net.slice(f * k, (f + 1) * k)) });
  }
  const bt = backtestNet(best.pos, rets);
  const observed = annSharpeOf(bt.net);

  // ---- h=0 contemporaneous ceiling (CIRCULAR — sanity only, NOT the edge) ----
  // same-bar: position over bar j->j+1 uses print at bar j+1 (look-ahead). We
  // approximate the ceiling = sign(flow) correlation with same-bar return.
  let h0gross = 0;
  {
    const pos0 = new Array(nRets).fill(0);
    const mask = best.det === "pct" ? pctMasks[best.lvl] : relMasks[best.lvl];
    for (let i = 0; i < nRets; i += 1) {
      if (mask[i + 1]) pos0[i] = best.dir * Math.sign(flow[i + 1]); // uses future bar => circular
    }
    const b0 = backtestNet(pos0, rets);
    h0gross = annSharpeOf(b0.gross);
  }

  // ---- per-event diagnostic on the chosen config (net of round-trip cost) ----
  const mask = best.det === "pct" ? pctMasks[best.lvl] : relMasks[best.lvl];
  const evNet: number[] = [];
  for (let j = rollW; j < bars.length - best.h; j += 1) {
    if (!mask[j]) continue;
    const f = bars[j + best.h].c / bars[j].c - 1;
    if (!Number.isFinite(f)) continue;
    evNet.push(best.dir * Math.sign(flow[j]) * f - 2 * COST_PER_SIDE);
  }
  const ev = tstat(evNet);

  // ---- RIGHT NULL: block-bootstrap the signed-flow stream, recompute the SAME
  // best config on the resampled flow re-paired with the SAME realized returns.
  // Destroys flow->future-return link; preserves return autocorr (rets fixed)
  // and flow autocorr (block resample). p = P(null netSharpe >= observed). ----
  const blk = 32; // ~8h blocks (preserve intraday flow autocorr)
  const surSharpes: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(90000 + s);
    const idx = blockResampleIndices(flow.length, blk, rand);
    const flowS = idx.map((j) => flow[j]);
    const absS = flowS.map(Math.abs);
    const rollS = rollingMeanAbs(flowS, rollW);
    // rebuild the print mask on the SURROGATE flow with the SAME detector/level
    let maskS: boolean[];
    if (best.det === "pct") {
      const thr = quantile(absS, best.lvl);
      maskS = absS.map((x, i) => i >= rollW && x >= thr);
    } else {
      maskS = absS.map((x, i) => i >= rollW && rollS[i] > 0 && x / rollS[i] >= best.lvl);
    }
    const posS = eventsToPositions(flowS, maskS, best.h, best.dir, nRets);
    const bS = backtestNet(posS, rets); // SAME real returns
    surSharpes.push(annSharpeOf(bS.net));
  }

  const r = runGauntlet({
    name: "D2-LT whale-print short-horizon momentum (h>=1, 15m)",
    config: best.id,
    net: bt.net,
    gross: bt.gross,
    turnover: bt.turnover,
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: observed,
    buyHoldRets: buyHold,
    pboStrategies: foldsByCfg,
    periodsPerYear: PPY,
  });

  // Harvey-Liu-style Bonferroni haircut on the surrogate p (multiple testing).
  const haircutP = Math.min(1, r.surrogateP * honestN);

  console.log(
    `  [h=0 contemporaneous ceiling gross Sharpe = ${h0gross.toFixed(2)} — CIRCULAR, not edge]`,
  );
  console.log(
    `  [per-event (net 8bps): n=${ev.n} mean=${(ev.m * 1e4).toFixed(2)}bp t=${ev.t.toFixed(2)}]`,
  );
  console.log(
    `  [Harvey-Liu Bonferroni-haircut surrogate p = ${haircutP.toFixed(4)} (raw ${r.surrogateP.toFixed(4)} x N=${honestN})]`,
  );

  const extra = {
    h0CeilingGrossSharpe: +h0gross.toFixed(3),
    perEventN: ev.n,
    perEventMeanBp: +(ev.m * 1e4).toFixed(3),
    perEventT: +ev.t.toFixed(3),
    harveyLiuHaircutP: +haircutP.toFixed(4),
    bestConfig: best.id,
    nConfigs: honestN,
  };
  results["D2-LT"] = { ...r, extra };
  printResult(r);
  console.log("  bestConfig:", best.id, "netSharpe:", observed.toFixed(3));

  // also report the single strongest MOMENTUM-only config (the literal hypothesis)
  let bestMom = configs.find((c) => c.dir > 0)!;
  let bestMomS = -Infinity;
  for (const c of configs) {
    if (c.dir <= 0) continue;
    const sh = annSharpeOf(backtestNet(c.pos, rets).net);
    if (sh > bestMomS) {
      bestMomS = sh;
      bestMom = c;
    }
  }
  console.log(`  [momentum-only best: ${bestMom.id} netSharpe=${bestMomS.toFixed(3)}]`);
}

console.log("=== D2-LT: whale-print short-horizon momentum (15m, strictly lagged) ===");
runLT();

writeFileSync("output/edgehunt-D2/results-lt.json", JSON.stringify(results, null, 2));
console.log("\n=== written to output/edgehunt-D2/results-lt.json ===");
for (const [k, r] of Object.entries(results)) {
  console.log(
    `${k}: pass=${r.pass} netSharpe=${r.netSharpeAnn.toFixed(2)} binding=${r.bindingGate} surP=${r.surrogateP.toFixed(3)} N=${r.honestN}`,
  );
}
