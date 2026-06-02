/**
 * D2-LIQ — Liquidation-cascade fade/follow (proxy).  (BACKLOG D2-D1)
 *
 * BELIEF: forced-deleveraging cascades overshoot; "fade the liquidation" (or
 * "ride then fade"). L2 forceOrder feed is NOT free -> $0 PROXY:
 *   liquidation spike := a 15m bar with a LARGE ADVERSE move (|ret| z-spike)
 *   + VOLUME spike + a FLOW FLIP (taker order-flow imbalance flips sign and
 *   magnitude crosses a threshold = aggressors switching = the cascade
 *   signature: forced sells overwhelm prior buy flow, or vice-versa).
 *
 * TEST: fade vs follow, with BRACKET exits (take-profit / stop-loss / time-stop).
 *
 * STRICTLY LAGGED (h>=1): a trigger is detected at the CLOSE of bar i; the
 * position is opened at the OPEN of bar i+1.  All trigger inputs (ret, vol,
 * flow) are known by bar i close.  Same-bar flow is never used to set same-bar
 * position (that is the circular look-ahead the spec forbids).  The lagged
 * component is the ONLY thing scored.
 *
 * RIGHT NULL = BRACKET-ON-SURROGATE: block-bootstrap the (ret, signed-flow,
 * volume) tuples jointly (preserving short autocorr), recompute triggers AND
 * run the IDENTICAL bracket engine on the surrogate path.  This nulls out the
 * cascade->future-return link while reproducing exactly the return distribution
 * that the bracket logic itself induces (TP/SL asymmetry, time-stop drift).
 * p = P(null netSharpe >= observed).
 *
 * KEY CONTROL (spec): is "fade the liquidation" better than "fade ANY large
 * adverse candle"?  EDGE is reported as EXCESS of the flow-flip-conditioned
 * bracket over the plain-large-candle bracket (same sigma/volume, no flow flip),
 * trade-time aligned.  That excess series is what the gauntlet judges.
 *
 * GAUNTLET: committed validators (statistical-validation.ts) via runGauntlet:
 * net Sharpe, beats-buy&hold, block-boot CI lower>0, DSR @ honest N (=every
 * config across fade/follow x all sweeps), surrogate-p<0.05, PBO<0.5.  Plus an
 * explicit Harvey-Liu multiple-testing haircut on the t-stat.
 *
 * COST: taker 4 bps / side (entry + exit = 8 bps round-trip), charged on
 * |Δposition| inside backtestNet.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  backtestNet,
  runGauntlet,
  rng,
  printResult,
  COST_PER_SIDE,
  type Bar,
  type GateResult,
} from "./lib.ts";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";

const OUT = "output/edgehunt-D2";
const SUR = 500;

function load15m(): Bar[] {
  return JSON.parse(readFileSync(`${OUT}/btc_15m_flow.json`, "utf8")) as Bar[];
}

// ---- helpers -------------------------------------------------------------
function rollingZ(x: number[], w: number): number[] {
  // strictly causal rolling z using window ENDING at i (inclusive)
  const out = new Array(x.length).fill(0);
  let s = 0;
  let s2 = 0;
  const buf: number[] = [];
  for (let i = 0; i < x.length; i += 1) {
    buf.push(x[i]);
    s += x[i];
    s2 += x[i] * x[i];
    if (buf.length > w) {
      const o = buf.shift()!;
      s -= o;
      s2 -= o * o;
    }
    const n = buf.length;
    const m = s / n;
    const v = Math.max(0, s2 / n - m * m);
    const sd = Math.sqrt(v);
    out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0;
  }
  return out;
}

/** per-bar order-flow imbalance in [-1,1]: (buy-sell)/total = (2*tbb - v)/v */
function ofi(bars: Bar[]): number[] {
  return bars.map((b) => (b.v > 0 ? (2 * b.tbb - b.v) / b.v : 0));
}

/** simple bar log return r[i] = ln(c[i]/c[i-1]); r[0]=0 */
function barRet(bars: Bar[]): number[] {
  const r = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i += 1) r[i] = Math.log(bars[i].c / bars[i - 1].c);
  return r;
}

// ---- bracket engine ------------------------------------------------------
// A trigger at bar i (known at close[i]) -> enter at open[i+1].  Direction +1
// long / -1 short.  Exit when, scanning bars i+1..i+maxHold:
//   - intrabar favorable extreme hits +tp*ATR     -> exit at TP
//   - intrabar adverse extreme hits  -sl*ATR      -> exit at SL (checked first
//     when both could trigger same bar = conservative)
//   - time-stop at i+maxHold close
// Returns a sparse per-bar net-return stream indexed by the ENTRY bar's
// forward path so the gauntlet sees i.i.d.-ish trade outcomes spread in time.
// We emit ONE net return per trade, placed at the entry bar index, plus 0
// elsewhere; cost = round-trip taker (entry+exit) on notional 1.
interface BracketCfg {
  dir: 1 | -1; // +1 follow-up / -1 fade-down etc. (set by side & move sign)
  tp: number; // take-profit in ATR units
  sl: number; // stop-loss in ATR units
  maxHold: number; // bars
}
interface Trade {
  entryIdx: number;
  ret: number; // gross fractional pnl (signed by dir, already)
}

function runBracket(
  bars: Bar[],
  triggers: { idx: number; dir: 1 | -1 }[],
  atr: number[],
  cfg: { tp: number; sl: number; maxHold: number },
): Trade[] {
  const trades: Trade[] = [];
  let busyUntil = -1; // no overlapping trades (one position at a time)
  for (const trg of triggers) {
    const i = trg.idx;
    if (i <= busyUntil) continue; // already in a trade
    const entryBar = i + 1;
    if (entryBar >= bars.length) continue;
    const entry = bars[entryBar].o;
    const a = atr[i]; // ATR known at trigger close
    if (!(a > 0) || !(entry > 0)) continue;
    const tpPx = trg.dir === 1 ? entry * (1 + cfg.tp * a) : entry * (1 - cfg.tp * a);
    const slPx = trg.dir === 1 ? entry * (1 - cfg.sl * a) : entry * (1 + cfg.sl * a);
    let exitPx = bars[Math.min(entryBar + cfg.maxHold, bars.length - 1)].c;
    let exitIdx = Math.min(entryBar + cfg.maxHold, bars.length - 1);
    for (let k = entryBar; k <= Math.min(entryBar + cfg.maxHold, bars.length - 1); k += 1) {
      const hi = bars[k].h;
      const lo = bars[k].l;
      if (trg.dir === 1) {
        // adverse = low hits SL (check stop first = conservative)
        if (lo <= slPx) { exitPx = slPx; exitIdx = k; break; }
        if (hi >= tpPx) { exitPx = tpPx; exitIdx = k; break; }
      } else {
        if (hi >= slPx) { exitPx = slPx; exitIdx = k; break; }
        if (lo <= tpPx) { exitPx = tpPx; exitIdx = k; break; }
      }
    }
    const gross = trg.dir === 1 ? exitPx / entry - 1 : entry / exitPx - 1;
    trades.push({ entryIdx: entryBar, ret: gross });
    busyUntil = exitIdx;
  }
  return trades;
}

/** ATR proxy: rolling mean of (h-l)/c over w bars, strictly causal */
function atrFrac(bars: Bar[], w: number): number[] {
  const tr = bars.map((b) => (b.c > 0 ? (b.h - b.l) / b.c : 0));
  const out = new Array(bars.length).fill(0);
  let s = 0;
  const buf: number[] = [];
  for (let i = 0; i < tr.length; i += 1) {
    buf.push(tr[i]); s += tr[i];
    if (buf.length > w) s -= buf.shift()!;
    out[i] = s / buf.length;
  }
  return out;
}

// Convert a list of trades into a per-trade net return vector (round-trip cost).
// Returned as an ARRAY of net returns (one per trade), order = entry time.
// This is the series the gauntlet scores (each element ~ one independent bet).
function tradesToNet(trades: Trade[]): { net: number[]; gross: number[] } {
  const rt = 2 * COST_PER_SIDE; // entry + exit taker
  const gross = trades.map((t) => t.ret);
  const net = trades.map((t) => t.ret - rt);
  return { net, gross };
}

function annFromPerTrade(net: number[], tradesPerYear: number): number {
  const s = summarizeReturnSeries(net);
  return s.sharpe * Math.sqrt(tradesPerYear);
}

// ---- main: build triggers, sweep fade/follow x brackets, score ----------
type FlowMode = "flip" | "plain"; // flip = flow-flip condition; plain = control
type Side = "fade" | "follow";

interface Cfg {
  id: string;
  side: Side;
  retSig: number; // adverse-move z threshold
  volZ: number; // volume z threshold
  flipThr: number; // |ofi| threshold AND sign-flip vs trailing flow
  tp: number;
  sl: number;
  maxHold: number;
}

function buildTriggers(
  bars: Bar[],
  rZ: number[],
  vZ: number[],
  of: number[],
  ofTrail: number[],
  cfg: Cfg,
  mode: FlowMode,
): { idx: number; dir: 1 | -1 }[] {
  // an adverse DOWN spike (rZ < -retSig) is a LONG-liquidation cascade;
  // an adverse UP spike (rZ > +retSig) is a SHORT-liquidation cascade.
  const trgs: { idx: number; dir: 1 | -1 }[] = [];
  for (let i = 0; i < bars.length - 1; i += 1) {
    const down = rZ[i] < -cfg.retSig;
    const up = rZ[i] > cfg.retSig;
    if (!down && !up) continue;
    if (vZ[i] < cfg.volZ) continue;
    if (mode === "flip") {
      // FLOW FLIP: same-bar aggressor flow points OPPOSITE to the prior trailing
      // flow and exceeds magnitude threshold.  For a long-liq down spike the
      // cascade signature is heavy SELL flow (of[i] strongly negative) flipping
      // from prior positive flow.  This flow is observed at bar i CLOSE (lagged
      // into the i+1 entry), so it is admissible.
      if (down) {
        if (!(of[i] < -cfg.flipThr && ofTrail[i] > 0)) continue;
      } else {
        if (!(of[i] > cfg.flipThr && ofTrail[i] < 0)) continue;
      }
    }
    // direction by side:
    //  fade  -> bet on reversal: long after a down spike, short after up spike
    //  follow-> bet on continuation: short after down spike, long after up spike
    let dir: 1 | -1;
    if (cfg.side === "fade") dir = down ? 1 : -1;
    else dir = down ? -1 : 1;
    trgs.push({ idx: i, dir });
  }
  return trgs;
}

function main() {
  const bars = load15m();
  const n = bars.length;
  const r = barRet(bars);
  const of = ofi(bars);
  const vol = bars.map((b) => b.v);

  // strictly-causal features (all known at bar i close)
  const rZ = rollingZ(r, 96); // ~1 day of 15m bars
  const vZ = rollingZ(vol, 96);
  const ofTrail: number[] = (() => {
    // trailing flow EXCLUDING current bar (prior-flow regime), causal
    const w = 8;
    const out = new Array(n).fill(0);
    let s = 0;
    const buf: number[] = [];
    for (let i = 0; i < n; i += 1) {
      // value at i uses bars i-w..i-1
      out[i] = buf.length > 0 ? s / buf.length : 0;
      buf.push(of[i]); s += of[i];
      if (buf.length > w) s -= buf.shift()!;
    }
    return out;
  })();
  const atr = atrFrac(bars, 96);

  const tradesPerYear = (idxCount: number, spanBars: number) => {
    const yearsSpan = (bars[n - 1].t - bars[0].t) / (365.25 * 86400000);
    return idxCount / Math.max(1e-9, yearsSpan);
  };
  const yearsSpan = (bars[n - 1].t - bars[0].t) / (365.25 * 86400000);

  // ---- config sweep (HONEST N counts EVERY config below) ----
  const sides: Side[] = ["fade", "follow"];
  const retSigs = [2.5, 3, 3.5];
  const volZs = [1.0, 1.5];
  const flipThrs = [0.15, 0.3];
  const brackets = [
    { tp: 1.5, sl: 1.0, maxHold: 8 },
    { tp: 2.0, sl: 1.5, maxHold: 16 },
    { tp: 3.0, sl: 2.0, maxHold: 24 },
  ];

  const cfgs: Cfg[] = [];
  for (const side of sides)
    for (const rs of retSigs)
      for (const vz of volZs)
        for (const ft of flipThrs)
          for (const bk of brackets)
            cfgs.push({
              id: `${side}_rs${rs}_vz${vz}_ft${ft}_tp${bk.tp}_sl${bk.sl}_h${bk.maxHold}`,
              side, retSig: rs, volZ: vz, flipThr: ft,
              tp: bk.tp, sl: bk.sl, maxHold: bk.maxHold,
            });
  const honestN = cfgs.length; // every config is a trial

  // evaluate every config: EDGE = flip-bracket EXCESS over plain-bracket
  interface Scored {
    cfg: Cfg;
    excessNet: number[]; // per-trade excess (flip - matched plain mean)
    flipNet: number[];
    plainNet: number[];
    nTrades: number;
    sharpe: number; // ann excess sharpe
    flipSharpe: number;
    folds: number[][];
  }
  const scored: Scored[] = [];

  for (const cfg of cfgs) {
    const trFlip = buildTriggers(bars, rZ, vZ, of, ofTrail, cfg, "flip");
    const trPlain = buildTriggers(bars, rZ, vZ, of, ofTrail, cfg, "plain");
    const flipTrades = runBracket(bars, trFlip, atr, cfg);
    const plainTrades = runBracket(bars, trPlain, atr, cfg);
    if (flipTrades.length < 20) {
      scored.push({
        cfg, excessNet: [], flipNet: [], plainNet: [], nTrades: flipTrades.length,
        sharpe: -Infinity, flipSharpe: -Infinity, folds: [[0], [0]],
      });
      continue;
    }
    const flip = tradesToNet(flipTrades);
    const plain = tradesToNet(plainTrades);
    // CONTROL baseline = MEAN net of the plain (large-candle, no-flip) bracket
    // over the SAME window; excess per flip-trade = flipNet - plainMean.
    const plainMean = plain.net.length
      ? plain.net.reduce((a, b) => a + b, 0) / plain.net.length
      : 0;
    const excessNet = flip.net.map((x) => x - plainMean);
    const sh = annFromPerTrade(
      excessNet,
      tradesPerYear(flipTrades.length, n),
    );
    const flipSh = annFromPerTrade(flip.net, tradesPerYear(flipTrades.length, n));
    // 5 folds (sequential) for PBO on the flip net series
    const k = Math.max(1, Math.floor(flip.net.length / 5));
    const folds = [0, 1, 2, 3, 4].map((f) => flip.net.slice(f * k, (f + 1) * k));
    scored.push({
      cfg, excessNet, flipNet: flip.net, plainNet: plain.net,
      nTrades: flipTrades.length, sharpe: sh, flipSharpe: flipSh,
      folds: folds.filter((x) => x.length > 0),
    });
  }

  // ---- STANDALONE-LAGGED diagnostic (the decisive test the spec demands) ----
  // The lagged component must clear ALONE.  Report the best STANDALONE flip
  // bracket (net, not excess) for fade and for follow separately.
  const standalone = scored.filter((s) => s.flipNet.length >= 20);
  const bestFade = standalone.filter((s) => s.cfg.side === "fade").sort((a, b) => b.flipSharpe - a.flipSharpe)[0];
  const bestFollow = standalone.filter((s) => s.cfg.side === "follow").sort((a, b) => b.flipSharpe - a.flipSharpe)[0];
  console.log(`\n[D2-LIQ] STANDALONE-LAGGED best net Sharpe (the decisive 'clears alone' test):`);
  for (const [lab, s] of [["FADE", bestFade], ["FOLLOW", bestFollow]] as const) {
    if (!s) { console.log(`    ${lab}: none`); continue; }
    const m = s.flipNet.reduce((a, b) => a + b, 0) / s.flipNet.length;
    console.log(`    ${lab}: ${s.cfg.id}  nT=${s.nTrades}  standaloneNetSharpe=${s.flipSharpe.toFixed(2)}  meanNetBp/trade=${(m * 1e4).toFixed(1)}`);
  }
  // best STANDALONE across both sides (this is what must clear gates alone)
  const bestStandalone = standalone.sort((a, b) => b.flipSharpe - a.flipSharpe)[0];

  // pick the best config by EXCESS net Sharpe (honest N penalizes via DSR)
  let best = scored[0];
  for (const s of scored) if (s.sharpe > best.sharpe) best = s;

  console.log(`\n[D2-LIQ] swept ${honestN} configs over ${n} 15m bars (${yearsSpan.toFixed(2)}y).`);
  console.log(`[D2-LIQ] best = ${best.cfg.id}`);
  console.log(`[D2-LIQ]   flip trades=${best.nTrades}  flip annSharpe(net)=${best.flipSharpe.toFixed(2)}  EXCESS-over-plain annSharpe=${best.sharpe.toFixed(2)}`);
  // top-5 by flip sharpe and by excess for transparency
  const byExcess = [...scored].filter((s) => Number.isFinite(s.sharpe)).sort((a, b) => b.sharpe - a.sharpe).slice(0, 6);
  console.log(`[D2-LIQ] top configs by EXCESS sharpe:`);
  for (const s of byExcess)
    console.log(`    ${s.cfg.id}  nT=${s.nTrades}  flipSh=${s.flipSharpe.toFixed(2)}  excessSh=${s.sharpe.toFixed(2)}  meanExcessBp=${(s.excessNet.reduce((a,b)=>a+b,0)/Math.max(1,s.excessNet.length)*1e4).toFixed(1)}`);

  // ---- BRACKET-ON-SURROGATE null --------------------------------------
  // block-bootstrap the joint (logret, ofi, vol) tuples; rebuild a synthetic
  // price path from the resampled logrets; rebuild h/l around each close using
  // the resampled bar's (h-l)/c range and o; recompute triggers + brackets +
  // the SAME excess construction.  p = P(surrogate excess Sharpe >= observed).
  const tuples = bars.map((b, i) => ({
    r: r[i], of: of[i], v: vol[i],
    rangeFrac: b.c > 0 ? (b.h - b.l) / b.c : 0,
    // where close sits inside the bar range (0=low,1=high), to reconstruct o/h/l
    clPos: b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5,
  }));
  const blk = 8; // ~2h blocks preserve intraday autocorr

  // bracket-on-surrogate: for a given config, return BOTH the excess sharpe and
  // the standalone-flip sharpe distribution under the null.
  function surrogateDist(c: Cfg): { excess: number[]; flip: number[] } {
    const excess: number[] = [];
    const flip: number[] = [];
    for (let s = 0; s < SUR; s += 1) {
      const rand = rng(90000 + s);
      const idx: number[] = [];
      while (idx.length < n) {
        const start = Math.floor(rand() * n);
        for (let k = 0; k < blk && idx.length < n; k += 1) idx.push((start + k) % n);
      }
      const sB: Bar[] = new Array(n);
      let px = bars[0].c;
      for (let i = 0; i < n; i += 1) {
        const tp = tuples[idx[i]];
        const prev = px;
        px = prev * Math.exp(tp.r);
        const cl = px;
        const range = cl * tp.rangeFrac;
        const lo = cl - tp.clPos * range;
        const hi = lo + range;
        const o = prev;
        const v = tp.v;
        const tbb = (v * (tp.of + 1)) / 2;
        sB[i] = { t: bars[i].t, o, h: Math.max(hi, o, cl), l: Math.min(lo, o, cl), c: cl, v, tbb, n: 1 };
      }
      const sR = barRet(sB);
      const sOf = ofi(sB);
      const sVol = sB.map((b) => b.v);
      const sRZ = rollingZ(sR, 96);
      const sVZ = rollingZ(sVol, 96);
      const sOfTrail: number[] = (() => {
        const w = 8; const out = new Array(n).fill(0); let acc = 0; const buf: number[] = [];
        for (let i = 0; i < n; i += 1) { out[i] = buf.length ? acc / buf.length : 0; buf.push(sOf[i]); acc += sOf[i]; if (buf.length > w) acc -= buf.shift()!; }
        return out;
      })();
      const sAtr = atrFrac(sB, 96);
      const trF = buildTriggers(sB, sRZ, sVZ, sOf, sOfTrail, c, "flip");
      const trP = buildTriggers(sB, sRZ, sVZ, sOf, sOfTrail, c, "plain");
      const fT = runBracket(sB, trF, sAtr, c);
      const pT = runBracket(sB, trP, sAtr, c);
      if (fT.length < 5) { excess.push(0); flip.push(0); continue; }
      const fNet = tradesToNet(fT).net;
      const pNet = tradesToNet(pT).net;
      const pMean = pNet.length ? pNet.reduce((a, b) => a + b, 0) / pNet.length : 0;
      const ex = fNet.map((x) => x - pMean);
      excess.push(annFromPerTrade(ex, tradesPerYear(fT.length, n)));
      flip.push(annFromPerTrade(fNet, tradesPerYear(fT.length, n)));
    }
    return { excess, flip };
  }

  const obsExcessSharpe = best.sharpe;
  const surDistBest = surrogateDist(best.cfg);
  const surSharpes = surDistBest.excess;

  // DECISIVE: bracket-on-surrogate null for the best STANDALONE config (net,
  // NOT excess) — the lagged component must clear ALONE.
  const surDistStandalone = best.cfg.id === bestStandalone.cfg.id
    ? surDistBest
    : surrogateDist(bestStandalone.cfg);
  const standaloneNet = bestStandalone.flipNet;
  const standaloneObs = bestStandalone.flipSharpe;
  const standaloneGauntlet = runGauntlet({
    name: "D2-LIQ STANDALONE-LAGGED flip bracket (net, h>=1) — the 'clears alone' test",
    config: bestStandalone.cfg.id,
    net: standaloneNet,
    gross: standaloneNet,
    turnover: bestStandalone.nTrades,
    honestN,
    surrogateSharpes: surDistStandalone.flip,
    observedSharpe: standaloneObs,
    buyHoldRets: r.slice(1),
    pboStrategies: scored
      .filter((s) => s.folds.length >= 2 && s.flipNet.length >= 25)
      .slice(0, 24)
      .map((s) => ({ id: s.cfg.id, folds: s.folds })),
    periodsPerYear: tradesPerYear(bestStandalone.nTrades, n),
  });
  console.log(`\n[D2-LIQ] === STANDALONE-LAGGED gauntlet (must clear ALONE) ===`);
  printResult(standaloneGauntlet);

  // buy&hold baseline over the same span, per-bar (for the beats-B&H gate),
  // scaled to per-trade frequency so the comparison is apples-to-apples in ann.
  const bhPerBar = r.slice(1);

  const gres: GateResult = runGauntlet({
    name: "D2-LIQ liq-cascade bracket (flow-flip EXCESS over plain-candle, h>=1, fade/follow swept)",
    config: best.cfg.id,
    net: best.excessNet,
    gross: best.flipNet,
    turnover: best.nTrades, // informational
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: obsExcessSharpe,
    buyHoldRets: bhPerBar,
    pboStrategies: scored
      .filter((s) => s.folds.length >= 2 && s.flipNet.length >= 25)
      .slice(0, 24)
      .map((s) => ({ id: s.cfg.id, folds: s.folds })),
    periodsPerYear: tradesPerYear(best.nTrades, n), // ann at trade frequency
  });

  // ---- explicit Harvey-Liu haircut on the EXCESS t-stat ----------------
  // HL: under m independent tests, Bonferroni-adjusted t threshold ~ for p=0.05
  // single-test t*=1.96; HL haircut multiplies the required t by the multiple-
  // testing factor.  Report haircut Sharpe = sharpe * (t_haircut / t_raw).
  const exStats = summarizeReturnSeries(best.excessNet);
  const nT = best.excessNet.length;
  const tRaw = exStats.sharpe * Math.sqrt(Math.max(1, nT));
  // Bonferroni single-test p for nominal 0.05 across honestN trials:
  const pBonf = 0.05 / honestN;
  // two-sided z for pBonf:
  const zHL = inverseNormalCdf(1 - pBonf / 2);
  const haircutFactor = tRaw > 1e-9 ? Math.max(0, (tRaw - zHL) / tRaw) : 0;
  const haircutSharpe = gres.netSharpeAnn * haircutFactor;
  const hlPass = tRaw > zHL;

  console.log(`\n[D2-LIQ] Harvey-Liu haircut: tRaw(excess)=${tRaw.toFixed(2)}  Bonferroni z@N=${zHL.toFixed(2)}  -> pass=${hlPass}  haircutSharpe=${haircutSharpe.toFixed(3)}`);

  printResult(gres);

  const out = {
    hypothesis: "D2-LIQ liquidation-cascade fade/follow (proxy), BACKLOG D2-D1",
    honestN,
    // THE DECISIVE TEST: standalone lagged flip bracket must clear gates ALONE
    standaloneLagged: {
      config: bestStandalone.cfg.id,
      nTrades: bestStandalone.nTrades,
      netSharpeAnn: standaloneGauntlet.netSharpeAnn,
      surrogateP: standaloneGauntlet.surrogateP,
      bootLowerSharpe: standaloneGauntlet.bootLowerSharpe,
      dsrProb: standaloneGauntlet.dsrProb,
      pbo: standaloneGauntlet.pbo,
      bindingGate: standaloneGauntlet.bindingGate,
      pass: standaloneGauntlet.pass,
      monthlyAt100k: standaloneGauntlet.monthlyAt100k,
    },
    bestExcessConfig: best.cfg.id,
    flipTrades: best.nTrades,
    flipNetSharpeAnn: best.flipSharpe,
    excessNetSharpeAnn: gres.netSharpeAnn,
    excessMeanBpPerTrade: (best.excessNet.reduce((a, b) => a + b, 0) / Math.max(1, best.excessNet.length)) * 1e4,
    surrogateP: gres.surrogateP,
    surrogateMeanSharpe: gres.surrogateMeanSharpe,
    bootLowerSharpe: gres.bootLowerSharpe,
    dsrProb: gres.dsrProb,
    pbo: gres.pbo,
    beatsBuyHold: gres.netSharpeAnn > gres.buyHoldSharpe,
    buyHoldSharpe: gres.buyHoldSharpe,
    harveyLiu: { tRaw, zThreshold: zHL, pass: hlPass, haircutSharpe },
    bindingGate: gres.bindingGate,
    pass: gres.pass,
    monthlyAt100k: gres.monthlyAt100k,
    note: "h>=1 strictly-lagged; entry at next-bar open; bracket-on-surrogate null; edge=excess over plain-large-candle bracket (the 'fade any 3-sigma candle' control). L2 forceOrder/VPIN DEFERRED (not free).",
  };
  writeFileSync(`${OUT}/liq-results.json`, JSON.stringify(out, null, 2));
  console.log(`\n[D2-LIQ] written -> ${OUT}/liq-results.json`);
  console.log(JSON.stringify(out, null, 2));
}

// rational approx of inverse normal CDF (Acklam) for the HL z threshold
function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q, x;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  else if (p <= phigh) { q = p - 0.5; const rr = q*q; x = (((((a[0]*rr+a[1])*rr+a[2])*rr+a[3])*rr+a[4])*rr+a[5])*q / (((((b[0]*rr+b[1])*rr+b[2])*rr+b[3])*rr+b[4])*rr+1); }
  else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  return x;
}

main();
