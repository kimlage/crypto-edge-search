/**
 * D2-VWAP strengthening pass. The base sweep showed best GROSS Sharpe ~0.16-0.69
 * but net negative after 4bps/side. Two honest questions remain:
 *   (1) Is the GROSS reversion signal even real (vs bracket-on-surrogate null)?
 *       If gross is itself null-indistinguishable, there is nothing to harvest.
 *   (2) Does a RARE / EXTREME-band, low-turnover variant clear cost?
 *       (higher entryK, longer holds, revert-to-VWAP-only TP, fewer round trips)
 * We pick the best-GROSS config and the lowest-turnover positive-gross config,
 * run the bracket-on-surrogate null on the GROSS series, and a focused
 * low-turnover sweep aiming to beat cost.
 */
import {
  backtestNet,
  rng,
  blockResampleIndices,
  COST_PER_SIDE,
  type Bar,
} from "./lib.ts";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { readFileSync } from "node:fs";

const OUT = "output/edgehunt-D2";
const BARS_PER_YEAR = 365 * 96;
const ANN = Math.sqrt(BARS_PER_YEAR);
const SUR = 400;

function load15m(): Bar[] {
  return JSON.parse(readFileSync(`${OUT}/btc_15m_flow.json`, "utf8")) as Bar[];
}
function annSharpe(s: number[]): number {
  return summarizeReturnSeries(s).sharpe * ANN;
}
function typical(b: Bar): number {
  return (b.h + b.l + b.c) / 3;
}
function rollingVWAP(bars: Bar[], w: number): number[] {
  const out = new Array(bars.length).fill(0);
  let pv = 0, vv = 0;
  const buf: [number, number][] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const tp = typical(bars[i]) * bars[i].v;
    buf.push([tp, bars[i].v]);
    pv += tp; vv += bars[i].v;
    if (buf.length > w) { const [op, ov] = buf.shift()!; pv -= op; vv -= ov; }
    out[i] = vv > 0 ? pv / vv : typical(bars[i]);
  }
  return out;
}
function sessionVWAP(bars: Bar[]): number[] {
  const out = new Array(bars.length).fill(0);
  let pv = 0, vv = 0, curDay = -1;
  for (let i = 0; i < bars.length; i += 1) {
    const day = Math.floor(bars[i].t / 86400000);
    if (day !== curDay) { curDay = day; pv = 0; vv = 0; }
    pv += typical(bars[i]) * bars[i].v; vv += bars[i].v;
    out[i] = vv > 0 ? pv / vv : typical(bars[i]);
  }
  return out;
}
function ztrail(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(0);
  let s = 0, s2 = 0; const buf: number[] = [];
  for (let i = 0; i < x.length; i += 1) {
    buf.push(x[i]); s += x[i]; s2 += x[i] * x[i];
    if (buf.length > w) { const old = buf.shift()!; s -= old; s2 -= old * old; }
    const n = buf.length, m = s / n, v = Math.max(0, s2 / n - m * m), sd = Math.sqrt(v);
    out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0;
  }
  return out;
}
interface BracketCfg { entryK: number; tpFrac: number; slMult: number; maxHold: number; }
function simulateBrackets(bars: Bar[], vwap: number[], zdev: number[], dev: number[], cfg: BracketCfg): number[] {
  const n = bars.length; const pos = new Array(n).fill(0); let i = 0;
  while (i < n - 1) {
    const z = zdev[i]; let side = 0;
    if (z > cfg.entryK) side = -1; else if (z < -cfg.entryK) side = 1;
    if (side === 0) { i += 1; continue; }
    const absEntry = Math.abs(dev[i]); let j = i + 1, held = 0;
    while (j < n && held < cfg.maxHold) {
      pos[j] = side; held += 1;
      const v = vwap[j]; const devHi = (bars[j].h - v) / v, devLo = (bars[j].l - v) / v;
      let exit = false;
      if (side === -1) { if (devLo <= cfg.tpFrac * absEntry) exit = true; else if (devHi >= cfg.slMult * absEntry) exit = true; }
      else { if (devHi >= -cfg.tpFrac * absEntry) exit = true; else if (devLo <= -cfg.slMult * absEntry) exit = true; }
      if (exit) { j += 1; break; }
      j += 1;
    }
    i = Math.max(j, i + 1);
  }
  return pos;
}
function runConfig(bars: Bar[], r: number[], vwap: number[], cfg: BracketCfg, zwin: number) {
  const dev = bars.map((b, i) => (vwap[i] > 0 ? (b.c - vwap[i]) / vwap[i] : 0));
  const zdev = ztrail(dev, zwin);
  const pos = simulateBrackets(bars, vwap, zdev, dev, cfg).slice(0, r.length);
  const bt = backtestNet(pos, r, COST_PER_SIDE);
  let trades = 0;
  for (let i = 1; i < pos.length; i += 1) if (pos[i] !== 0 && pos[i - 1] === 0) trades += 1;
  return { net: bt.net, gross: bt.gross, turnover: bt.turnover, trades, netS: annSharpe(bt.net), grossS: annSharpe(bt.gross) };
}

function main() {
  const bars = load15m();
  const r: number[] = [];
  for (let i = 0; i < bars.length - 1; i += 1) r.push(bars[i + 1].c / bars[i].c - 1);
  const sV = sessionVWAP(bars);
  const rollCache = new Map<number, number[]>();
  for (const w of [16, 32, 96]) rollCache.set(w, rollingVWAP(bars, w));

  // ---- Q1: is the GROSS signal of the best-gross config real? ----
  // best-gross config from base sweep: roll32_z96_k2.5_tp0.25_sl3_h8
  const bestGross = { anchor: "roll" as const, rollW: 32, zwin: 96, bcfg: { entryK: 2.5, tpFrac: 0.25, slMult: 3, maxHold: 8 } };
  const vwapBG = rollCache.get(32)!;
  const dBG = runConfig(bars, r, vwapBG, bestGross.bcfg, bestGross.zwin);
  console.log(`[best-gross] roll32_z96_k2.5_tp.25_sl3_h8  grossS=${dBG.grossS.toFixed(3)} netS=${dBG.netS.toFixed(3)} trades=${dBG.trades}`);

  // bracket-on-surrogate null on the GROSS sharpe (does the signal beat null pre-cost?)
  const p0 = bars[0].c;
  const surG: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(11000 + s);
    const idx = blockResampleIndices(r.length, 32, rand);
    const rS = idx.map((j) => r[j]);
    const sB: Bar[] = new Array(rS.length + 1); let c = p0; sB[0] = { ...bars[0] };
    for (let i = 0; i < rS.length; i += 1) {
      const src = bars[idx[i]]; const cN = c * (1 + rS[i]);
      sB[i + 1] = { t: bars[i + 1].t, o: cN * (src.o / src.c), h: cN * (src.h / src.c), l: cN * (src.l / src.c), c: cN, v: src.v, tbb: src.tbb, n: src.n };
      c = cN;
    }
    const vwS = rollingVWAP(sB, 32);
    const rN: number[] = []; for (let i = 0; i < sB.length - 1; i += 1) rN.push(sB[i + 1].c / sB[i].c - 1);
    surG.push(runConfig(sB, rN, vwS, bestGross.bcfg, bestGross.zwin).grossS);
  }
  const surGmean = surG.reduce((a, b) => a + b, 0) / surG.length;
  const pGross = (surG.filter((x) => x >= dBG.grossS).length + 1) / (surG.length + 1);
  console.log(`[best-gross GROSS-vs-bracket-on-surrogate] null mean=${surGmean.toFixed(3)} p(gross>=obs)=${pGross.toFixed(4)}`);

  // ---- Q2: focused LOW-TURNOVER sweep to try to beat cost ----
  // extreme bands (rarer), long holds, revert-to-VWAP TP only, both anchors.
  const cfgs: { id: string; anchor: "session" | "roll"; rollW: number; zwin: number; bcfg: BracketCfg }[] = [];
  for (const anchor of ["session", "roll"] as const) {
    const rws = anchor === "roll" ? [32, 96] : [0];
    for (const rw of rws)
      for (const zwin of [192, 384])
        for (const ek of [3.0, 3.5, 4.0])
          for (const sl of [3, 4])
            for (const mh of [32, 48, 96])
              cfgs.push({ id: `${anchor}${anchor === "roll" ? rw : ""}_z${zwin}_k${ek}_sl${sl}_h${mh}`, anchor, rollW: rw, zwin, bcfg: { entryK: ek, tpFrac: 0, slMult: sl, maxHold: mh } });
  }
  let bestNet = -Infinity, bestId = "", bestTrades = 0, bestGrossOut = 0, bestTurn = 0;
  let posCount = 0;
  for (const c of cfgs) {
    const vwap = c.anchor === "session" ? sV : rollCache.get(c.rollW)!;
    const d = runConfig(bars, r, vwap, c.bcfg, c.zwin);
    if (d.netS > 0) posCount += 1;
    if (d.netS > bestNet && d.trades >= 20) { bestNet = d.netS; bestId = c.id; bestTrades = d.trades; bestGrossOut = d.grossS; bestTurn = d.turnover; }
  }
  console.log(`[low-turnover sweep] N=${cfgs.length} configs, ${posCount} with net Sharpe>0`);
  console.log(`[low-turnover best] ${bestId}  netS=${bestNet.toFixed(3)} grossS=${bestGrossOut.toFixed(3)} trades=${bestTrades} turn=${bestTurn.toFixed(4)}`);

  // ---- breakeven cost: at what cost/side would best-gross go net-zero? ----
  // net ≈ gross - cost*turnover*ANN... estimate via direct relation on mean.
  const stG = summarizeReturnSeries(dBG.gross);
  const grossMeanBp = stG.mean * 1e4;
  // cost per bar at 4bps = turnover*4bps; breakeven cost = grossMean/turnover
  const breakevenBps = (stG.mean / Math.max(1e-12, dBG.turnover)) * 1e4;
  console.log(`[breakeven] best-gross mean=${grossMeanBp.toFixed(4)}bp/bar turnover=${dBG.turnover.toFixed(4)} -> breakeven cost = ${breakevenBps.toFixed(3)} bps/side (we pay 4.0)`);
}
main();
