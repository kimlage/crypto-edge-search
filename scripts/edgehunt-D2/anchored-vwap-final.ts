/**
 * D2-VWAP FINAL adjudication. The only config that beats 4bps/side is the
 * extreme/rare low-turnover one: roll96_z384_k4_sl4_h96 (48 trades, net S~0.59).
 * That is a SUSPICIOUS survivor: tiny N of trades, found after sweeping many
 * configs. We now judge it HONESTLY with the committed gauntlet:
 *   - honest N = ALL configs tried across base(288)+strengthen(108) = 396
 *   - RIGHT null = bracket-on-surrogate (block-bootstrap returns, rebuild price,
 *     rebuild VWAP, re-run the EXACT bracket on the synthetic path); p = P(null
 *     net Sharpe >= observed). This is the decisive test for a rare-trigger rule.
 *   - DSR @ honest N, block-bootstrap CI on net mean, PBO across the strengthen
 *     low-turnover family, beats-buy&hold, cost-net.
 * The strictly-LAGGED net series IS the series judged (entry at i+1 from z@i).
 */
import {
  backtestNet,
  runGauntlet,
  rng,
  blockResampleIndices,
  printResult,
  COST_PER_SIDE,
  type Bar,
} from "./lib.ts";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "output/edgehunt-D2";
const BARS_PER_YEAR = 365 * 96;
const ANN = Math.sqrt(BARS_PER_YEAR);
const SUR = 1000; // big null sample: 48-trade survivor needs a tight p

function load15m(): Bar[] {
  return JSON.parse(readFileSync(`${OUT}/btc_15m_flow.json`, "utf8")) as Bar[];
}
function annSharpe(s: number[]): number { return summarizeReturnSeries(s).sharpe * ANN; }
function typical(b: Bar): number { return (b.h + b.l + b.c) / 3; }
function rollingVWAP(bars: Bar[], w: number): number[] {
  const out = new Array(bars.length).fill(0); let pv = 0, vv = 0; const buf: [number, number][] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const tp = typical(bars[i]) * bars[i].v; buf.push([tp, bars[i].v]); pv += tp; vv += bars[i].v;
    if (buf.length > w) { const [op, ov] = buf.shift()!; pv -= op; vv -= ov; }
    out[i] = vv > 0 ? pv / vv : typical(bars[i]);
  }
  return out;
}
function ztrail(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(0); let s = 0, s2 = 0; const buf: number[] = [];
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

  // the cost-surviving candidate
  const cand = { rollW: 96, zwin: 384, bcfg: { entryK: 4.0, tpFrac: 0, slMult: 4, maxHold: 96 } };
  const vwap = rollingVWAP(bars, cand.rollW);
  const d = runConfig(bars, r, vwap, cand.bcfg, cand.zwin);
  console.log(`candidate roll96_z384_k4_sl4_h96: netS=${d.netS.toFixed(3)} grossS=${d.grossS.toFixed(3)} trades=${d.trades} turnover=${d.turnover.toFixed(5)}`);

  // honest N across both sweeps
  const honestN = 288 + 108;

  // PBO family: the strengthen low-turnover family (extreme bands) folds
  const famCfgs: { id: string; rollW: number; zwin: number; bcfg: BracketCfg }[] = [];
  for (const rw of [96]) for (const zwin of [192, 384]) for (const ek of [3.0, 3.5, 4.0]) for (const sl of [3, 4]) for (const mh of [48, 96])
    famCfgs.push({ id: `r${rw}_z${zwin}_k${ek}_s${sl}_h${mh}`, rollW: rw, zwin, bcfg: { entryK: ek, tpFrac: 0, slMult: sl, maxHold: mh } });
  const foldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of famCfgs) {
    const vw = rollingVWAP(bars, c.rollW);
    const dd = runConfig(bars, r, vw, c.bcfg, c.zwin);
    const k = Math.floor(dd.net.length / 5);
    foldsByCfg.push({ id: c.id, folds: [0, 1, 2, 3, 4].map((f) => dd.net.slice(f * k, (f + 1) * k)) });
  }

  // RIGHT NULL: bracket-on-surrogate (1000 paths). rebuild price+VWAP, re-run exact bracket.
  const p0 = bars[0].c;
  const sur: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(50000 + s);
    const idx = blockResampleIndices(r.length, 32, rand);
    const rS = idx.map((j) => r[j]);
    const sB: Bar[] = new Array(rS.length + 1); let c = p0; sB[0] = { ...bars[0] };
    for (let i = 0; i < rS.length; i += 1) {
      const src = bars[idx[i]]; const cN = c * (1 + rS[i]);
      sB[i + 1] = { t: bars[i + 1].t, o: cN * (src.o / src.c), h: cN * (src.h / src.c), l: cN * (src.l / src.c), c: cN, v: src.v, tbb: src.tbb, n: src.n };
      c = cN;
    }
    const vwS = rollingVWAP(sB, cand.rollW);
    const rN: number[] = []; for (let i = 0; i < sB.length - 1; i += 1) rN.push(sB[i + 1].c / sB[i].c - 1);
    sur.push(runConfig(sB, rN, vwS, cand.bcfg, cand.zwin).netS);
  }
  const surMean = sur.reduce((a, b) => a + b, 0) / sur.length;
  const surP = (sur.filter((x) => x >= d.netS).length + 1) / (sur.length + 1);
  const surGE = sur.filter((x) => x >= d.netS).length;
  console.log(`bracket-on-surrogate null (n=${SUR}): mean netS=${surMean.toFixed(3)}, #(null>=obs)=${surGE}, p=${surP.toFixed(4)}`);

  const gate = runGauntlet({
    name: "D2-VWAP anchored-VWAP reversion FINAL (extreme low-turnover, h>=1)",
    config: "roll96_z384_k4_sl4_h96",
    net: d.net,
    gross: d.gross,
    turnover: d.turnover,
    honestN,
    surrogateSharpes: sur,
    observedSharpe: d.netS,
    buyHoldRets: r,
    pboStrategies: foldsByCfg,
    periodsPerYear: BARS_PER_YEAR,
  });

  const st = summarizeReturnSeries(d.net);
  const monthlyIfTraded = Math.round(st.mean * (BARS_PER_YEAR / 12) * 100000);
  printResult(gate);
  const out = {
    candidate: "roll96_z384_k4_sl4_h96",
    nBars: bars.length, trades: d.trades, honestN,
    netSharpeAnn: +gate.netSharpeAnn.toFixed(3),
    grossSharpeAnn: +gate.grossSharpeAnn.toFixed(3),
    netMeanBp: +gate.netMeanBp.toFixed(4),
    turnover: +gate.turnover.toFixed(5),
    buyHoldSharpe: +gate.buyHoldSharpe.toFixed(3),
    bootLowerSharpe: +gate.bootLowerSharpe.toFixed(3),
    bootUpperSharpe: +gate.bootUpperSharpe.toFixed(3),
    dsrProb: +gate.dsrProb.toFixed(4),
    surrogateP_bracketOnSurrogate: +gate.surrogateP.toFixed(4),
    surrogateMeanSharpe: +gate.surrogateMeanSharpe.toFixed(3),
    pbo: gate.pbo === null ? null : +gate.pbo.toFixed(3),
    pass: gate.pass, bindingGate: gate.bindingGate,
    monthlyAt100k: gate.monthlyAt100k, monthlyIfTraded,
  };
  writeFileSync(`${OUT}/anchored-vwap-final.json`, JSON.stringify(out, null, 2));
  console.log("\n" + JSON.stringify(out, null, 2));
}
main();
