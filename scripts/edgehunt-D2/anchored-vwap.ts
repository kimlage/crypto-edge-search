/**
 * D2-VWAP — Anchored-VWAP deviation reversion (genuine best-effort build).
 *
 * Belief (BACKLOG D2-V2): fade ±k·sigma VWAP bands; "institutions defend VWAP."
 * Mechanism caveat: equities-microstructure artifact; 24/7 crypto has no close
 * auction, so the session anchor is arbitrary (UTC midnight). We nonetheless
 * build the STRONGEST honest version and let the gauntlet judge.
 *
 * Construction (15m BTC, output/edgehunt-D2/btc_15m_flow.json; OHLCV+flow):
 *   - rolling VWAP  : windowed sum(typical*vol)/sum(vol)
 *   - session-VWAP  : cumulative VWAP reset at each UTC-midnight session open
 *   - deviation     : (close - vwap)/vwap
 *   - z-dev bands   : trailing z-score of deviation; enter when |z| > entryK
 *   - mean-revert   : fade (short rich / long cheap)
 *   - bracket exits : intrabar TP (revert toward VWAP) / SL / time-stop, on OHLC
 *
 * LAG DISCIPLINE (decisive for order-flow / any same-bar artifact):
 *   the z-dev that triggers an entry is computed through bar i's CLOSE; the
 *   position is entered at bar i+1 and held forward (strict h>=1). The held-
 *   position array fed to backtestNet[i] is the exposure over bar i->i+1, so
 *   it depends only on info <= bar i-? (we enforce signal[i-1] -> pos[i]).
 *
 * RIGHT NULL = bracket-on-surrogate: block-bootstrap the 15m RETURN series,
 *   rebuild a synthetic price path, REBUILD VWAP/bands, and re-run the EXACT
 *   SAME bracket logic. This preserves return autocorrelation + bracket
 *   mechanics + entry frequency but destroys any genuine VWAP-reversion
 *   structure. p = P(null netSharpe >= observed). (We also report a phase/IID
 *   shuffle null as a second view.)
 *
 * COST: taker 4 bps/side, charged on |Δposition| each bar (lib COST_PER_SIDE).
 * Honest N = every (anchor x window x entryK x tpK x slK x maxHold) config.
 */
import {
  backtestNet,
  runGauntlet,
  rng,
  blockResampleIndices,
  COST_PER_SIDE,
  type Bar,
} from "./lib.ts";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "output/edgehunt-D2";
const BARS_PER_YEAR = 365 * 96; // 15m bars
const ANN = Math.sqrt(BARS_PER_YEAR);
const SUR = 400; // surrogate paths (bracket-on-surrogate is the binding null)

function load15m(): Bar[] {
  return JSON.parse(readFileSync(`${OUT}/btc_15m_flow.json`, "utf8")) as Bar[];
}

function annSharpe(series: number[]): number {
  const s = summarizeReturnSeries(series);
  return s.sharpe * ANN;
}

// ---------- VWAP builders ----------
function typical(b: Bar): number {
  return (b.h + b.l + b.c) / 3;
}

/** rolling windowed VWAP over `w` bars (uses bar i and prior w-1) */
function rollingVWAP(bars: Bar[], w: number): number[] {
  const out = new Array(bars.length).fill(0);
  let pv = 0;
  let vv = 0;
  const buf: [number, number][] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const tp = typical(bars[i]) * bars[i].v;
    buf.push([tp, bars[i].v]);
    pv += tp;
    vv += bars[i].v;
    if (buf.length > w) {
      const [op, ov] = buf.shift()!;
      pv -= op;
      vv -= ov;
    }
    out[i] = vv > 0 ? pv / vv : typical(bars[i]);
  }
  return out;
}

/** session-anchored VWAP: cumulative within each UTC day, reset at midnight */
function sessionVWAP(bars: Bar[]): number[] {
  const out = new Array(bars.length).fill(0);
  let pv = 0;
  let vv = 0;
  let curDay = -1;
  for (let i = 0; i < bars.length; i += 1) {
    const day = Math.floor(bars[i].t / 86400000);
    if (day !== curDay) {
      curDay = day;
      pv = 0;
      vv = 0;
    }
    pv += typical(bars[i]) * bars[i].v;
    vv += bars[i].v;
    out[i] = vv > 0 ? pv / vv : typical(bars[i]);
  }
  return out;
}

/** trailing z-score of x over window w (causal, uses x[<=i]) */
function ztrail(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(0);
  let s = 0;
  let s2 = 0;
  const buf: number[] = [];
  for (let i = 0; i < x.length; i += 1) {
    buf.push(x[i]);
    s += x[i];
    s2 += x[i] * x[i];
    if (buf.length > w) {
      const old = buf.shift()!;
      s -= old;
      s2 -= old * old;
    }
    const n = buf.length;
    const m = s / n;
    const v = Math.max(0, s2 / n - m * m);
    const sd = Math.sqrt(v);
    out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0;
  }
  return out;
}

// ---------- bracket simulator ----------
// Given a deviation z series (zdev[i] known at bar i close), generate a held-
// position array over bars i->i+1. Entry decided at bar i (using zdev[i]),
// executed/held starting bar i+1; we encode pos[i+1..] = side until a bracket
// exit fires intrabar (TP/SL on OHLC) or time-stop. Mean-revert: zdev high =>
// short (-1); zdev low => long (+1). Brackets in units of the entry |zdev|->
// expressed in PRICE via the VWAP-deviation: TP when dev reverts past tpFrac of
// entry dev toward 0; SL when dev extends to slMult * entry dev away from 0.
interface BracketCfg {
  entryK: number; // |zdev| entry threshold
  tpFrac: number; // take profit when |dev| shrinks to tpFrac*|entryDev| (revert)
  slMult: number; // stop when |dev| grows to slMult*|entryDev| (extend)
  maxHold: number; // time-stop in bars
}

function simulateBrackets(
  bars: Bar[],
  vwap: number[],
  zdev: number[],
  dev: number[],
  cfg: BracketCfg,
): number[] {
  const n = bars.length;
  const pos = new Array(n).fill(0); // pos[i] = exposure over bar i->i+1
  let i = 0;
  while (i < n - 1) {
    // signal known at bar i (close); enter at i+1
    const z = zdev[i];
    let side = 0;
    if (z > cfg.entryK) side = -1; // rich vs VWAP -> fade short
    else if (z < -cfg.entryK) side = 1; // cheap vs VWAP -> fade long
    if (side === 0) {
      i += 1;
      continue;
    }
    const entryDev = dev[i]; // signed deviation at entry-decision bar
    const absEntry = Math.abs(entryDev);
    // hold from bar i+1 forward
    let j = i + 1;
    let held = 0;
    while (j < n && held < cfg.maxHold) {
      pos[j] = side;
      held += 1;
      // intrabar exit check on bar j using OHLC vs VWAP[j-1] anchor band.
      // deviation path within the bar: we approximate touch using high/low.
      const v = vwap[j];
      const devHi = (bars[j].h - v) / v;
      const devLo = (bars[j].l - v) / v;
      // for a SHORT (side=-1, entry rich, entryDev>0): TP when dev falls to
      // tpFrac*absEntry (revert); SL when dev rises to slMult*absEntry.
      // for a LONG (side=+1, entry cheap, entryDev<0): TP when dev rises to
      // -tpFrac*absEntry; SL when dev falls to -slMult*absEntry.
      let exit = false;
      if (side === -1) {
        const tpLevel = cfg.tpFrac * absEntry; // dev target (toward 0 from above)
        const slLevel = cfg.slMult * absEntry; // dev stop (further above)
        if (devLo <= tpLevel) exit = true; // reverted enough (profit)
        else if (devHi >= slLevel) exit = true; // extended (loss)
      } else {
        const tpLevel = -cfg.tpFrac * absEntry;
        const slLevel = -cfg.slMult * absEntry;
        if (devHi >= tpLevel) exit = true;
        else if (devLo <= slLevel) exit = true;
      }
      if (exit) {
        j += 1;
        break;
      }
      j += 1;
    }
    // pos[j..] stays 0 (flat) until next entry; resume scanning at j
    i = Math.max(j, i + 1);
  }
  return pos;
}

// ---------- one full config run -> net series + diagnostics ----------
function runConfig(
  bars: Bar[],
  rets: number[],
  vwap: number[],
  cfg: BracketCfg,
  zwin: number,
): { net: number[]; gross: number[]; turnover: number; trades: number; sharpe: number } {
  const dev = bars.map((b, i) => (vwap[i] > 0 ? (b.c - vwap[i]) / vwap[i] : 0));
  const zdev = ztrail(dev, zwin);
  const pos = simulateBrackets(bars, vwap, zdev, dev, cfg);
  // pos has length n (bars); rets has length n-1 (i->i+1). align: pos[i] is
  // exposure over bar i->i+1 == rets[i]. drop last pos.
  const posAligned = pos.slice(0, rets.length);
  const bt = backtestNet(posAligned, rets, COST_PER_SIDE);
  // count round-trip trades = entries
  let trades = 0;
  for (let i = 1; i < posAligned.length; i += 1) {
    if (posAligned[i] !== 0 && posAligned[i - 1] === 0) trades += 1;
  }
  return {
    net: bt.net,
    gross: bt.gross,
    turnover: bt.turnover,
    trades,
    sharpe: annSharpe(bt.net),
  };
}

// =====================================================================
// MAIN
// =====================================================================
function main() {
  const bars = load15m();
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i += 1) rets.push(bars[i].c / bars[i - 1].c - 1);
  // align rets[i] to "over bar i->i+1": rets[i] computed above is c[i+1]/c[i]-1
  // but we pushed for i=1.., i.e. rets[k]=c[k+1]/c[k]-1 with k=0..n-2. good:
  // exposure pos[k] (decided <= bar k) earns rets[k]. ✓
  const r: number[] = [];
  for (let i = 0; i < bars.length - 1; i += 1) r.push(bars[i + 1].c / bars[i].c - 1);

  console.log(`=== D2-VWAP anchored-VWAP reversion: ${bars.length} 15m bars, ${(bars.length / 96).toFixed(0)} sessions ===`);

  // config sweep (honest N = every config)
  const anchors: ("session" | "roll")[] = ["session", "roll"];
  const rollWins = [16, 32, 96]; // 4h, 8h, 24h rolling VWAP windows (15m bars)
  const zWins = [96, 192]; // 1d, 2d trailing z windows
  const entryKs = [1.5, 2.0, 2.5];
  const tpFracs = [0.0, 0.25]; // revert to VWAP, or to 25% of entry dev
  const slMults = [2.0, 3.0];
  const maxHolds = [8, 16, 32]; // 2h, 4h, 8h time stops

  type Cfg = {
    id: string;
    anchor: "session" | "roll";
    rollW: number;
    zwin: number;
    bcfg: BracketCfg;
  };
  const configs: Cfg[] = [];
  for (const a of anchors) {
    const rws = a === "roll" ? rollWins : [0];
    for (const rw of rws) {
      for (const zw of zWins) {
        for (const ek of entryKs) {
          for (const tp of tpFracs) {
            for (const sl of slMults) {
              for (const mh of maxHolds) {
                configs.push({
                  id: `${a}${a === "roll" ? rw : ""}_z${zw}_k${ek}_tp${tp}_sl${sl}_h${mh}`,
                  anchor: a,
                  rollW: rw,
                  zwin: zw,
                  bcfg: { entryK: ek, tpFrac: tp, slMult: sl, maxHold: mh },
                });
              }
            }
          }
        }
      }
    }
  }
  const honestN = configs.length;
  console.log(`honest N = ${honestN} configs`);

  // precompute the two VWAP anchors
  const sVWAP = sessionVWAP(bars);
  const rollCache = new Map<number, number[]>();
  for (const w of rollWins) rollCache.set(w, rollingVWAP(bars, w));

  // evaluate all configs
  let best: Cfg | null = null;
  let bestNet: number[] = [];
  let bestDiag: ReturnType<typeof runConfig> | null = null;
  let bestS = -Infinity;
  const foldsByCfg: { id: string; folds: number[][] }[] = [];
  const allRows: any[] = [];
  for (const c of configs) {
    const vwap = c.anchor === "session" ? sVWAP : rollCache.get(c.rollW)!;
    const diag = runConfig(bars, r, vwap, c.bcfg, c.zwin);
    const k = Math.floor(diag.net.length / 5);
    foldsByCfg.push({
      id: c.id,
      folds: [0, 1, 2, 3, 4].map((f) => diag.net.slice(f * k, (f + 1) * k)),
    });
    allRows.push({
      id: c.id,
      sharpe: +diag.sharpe.toFixed(3),
      trades: diag.trades,
      turnover: +diag.turnover.toFixed(4),
      grossSharpe: +annSharpe(diag.gross).toFixed(3),
    });
    if (diag.sharpe > bestS && diag.trades >= 30) {
      bestS = diag.sharpe;
      best = c;
      bestNet = diag.net;
      bestDiag = diag;
    }
  }
  if (!best || !bestDiag) {
    console.log("no config with >=30 trades; aborting");
    return;
  }
  console.log(`best config: ${best.id}  netSharpe=${bestS.toFixed(3)} trades=${bestDiag.trades} turnover=${bestDiag.turnover.toFixed(3)}`);
  // gross sharpe of best (h>=1 lagged, this IS the only legitimate edge here)
  const grossBestS = annSharpe(bestDiag.gross);
  console.log(`best gross Sharpe (pre-cost) = ${grossBestS.toFixed(3)}  net = ${bestS.toFixed(3)}  (cost drag = ${(grossBestS - bestS).toFixed(3)})`);

  // -------- RIGHT NULL: bracket-on-surrogate --------
  // block-bootstrap returns -> rebuild price -> rebuild chosen VWAP anchor ->
  // re-run exact bracket logic. p = P(null netSharpe >= observed).
  const bestVwapFn = (sBars: Bar[]): number[] =>
    best!.anchor === "session" ? sessionVWAP(sBars) : rollingVWAP(sBars, best!.rollW);
  const surSharpes: number[] = [];
  const blk = 32; // ~8h blocks preserve intraday autocorr
  const p0 = bars[0].c;
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(90000 + s);
    const idx = blockResampleIndices(r.length, blk, rand);
    const rS = idx.map((j) => r[j]);
    // rebuild synthetic bars: keep the bar TIMESTAMPS (for session anchoring)
    // and reconstruct OHLC around the resampled close path using the resampled
    // bar's intrabar shape (range fractions) + resampled volume/flow.
    const sBars: Bar[] = new Array(rS.length + 1);
    let c = p0;
    sBars[0] = { ...bars[0] };
    for (let i = 0; i < rS.length; i += 1) {
      const src = bars[idx[i]];
      const cNew = c * (1 + rS[i]);
      // preserve the source bar's relative high/low/typical geometry
      const ratioH = src.h / src.c;
      const ratioL = src.l / src.c;
      const ratioO = src.o / src.c;
      sBars[i + 1] = {
        t: bars[i + 1].t, // keep real timestamp grid for session resets
        o: cNew * ratioO,
        h: cNew * ratioH,
        l: cNew * ratioL,
        c: cNew,
        v: src.v,
        tbb: src.tbb,
        n: src.n,
      };
      c = cNew;
    }
    const vwapS = bestVwapFn(sBars);
    const rSnext: number[] = [];
    for (let i = 0; i < sBars.length - 1; i += 1) rSnext.push(sBars[i + 1].c / sBars[i].c - 1);
    const diagS = runConfig(sBars, rSnext, vwapS, best!.bcfg, best!.zwin);
    surSharpes.push(diagS.sharpe);
  }
  const surMean = surSharpes.reduce((a, b) => a + b, 0) / surSharpes.length;
  console.log(`bracket-on-surrogate null: mean Sharpe=${surMean.toFixed(3)} (n=${SUR})`);

  // secondary null: IID shuffle of returns (destroys autocorr too) — looser view
  const surIID: number[] = [];
  for (let s = 0; s < 200; s += 1) {
    const rand = rng(70000 + s);
    const idx = blockResampleIndices(r.length, 1, rand);
    const rS = idx.map((j) => r[j]);
    const sBars: Bar[] = new Array(rS.length + 1);
    let c = p0;
    sBars[0] = { ...bars[0] };
    for (let i = 0; i < rS.length; i += 1) {
      const src = bars[idx[i]];
      const cNew = c * (1 + rS[i]);
      sBars[i + 1] = {
        t: bars[i + 1].t,
        o: cNew * (src.o / src.c),
        h: cNew * (src.h / src.c),
        l: cNew * (src.l / src.c),
        c: cNew,
        v: src.v,
        tbb: src.tbb,
        n: src.n,
      };
      c = cNew;
    }
    const vwapS = bestVwapFn(sBars);
    const rSnext: number[] = [];
    for (let i = 0; i < sBars.length - 1; i += 1) rSnext.push(sBars[i + 1].c / sBars[i].c - 1);
    surIID.push(runConfig(sBars, rSnext, vwapS, best!.bcfg, best!.zwin).sharpe);
  }
  const pIID = (surIID.filter((x) => x >= bestS).length + 1) / (surIID.length + 1);

  // -------- GAUNTLET on the LAGGED net series with bracket-on-surrogate null --------
  const gate = runGauntlet({
    name: "D2-VWAP anchored-VWAP reversion (h>=1, bracket exits)",
    config: best.id,
    net: bestDiag.net,
    gross: bestDiag.gross,
    turnover: bestDiag.turnover,
    honestN,
    surrogateSharpes: surSharpes, // bracket-on-surrogate = the RIGHT null
    observedSharpe: bestS,
    buyHoldRets: r,
    pboStrategies: foldsByCfg,
    periodsPerYear: BARS_PER_YEAR,
  });

  // recompute monthly@100k honestly even if it fails (for reporting)
  const st = summarizeReturnSeries(bestDiag.net);
  const barsPerMonth = BARS_PER_YEAR / 12;
  const monthlyIfTraded = Math.round(st.mean * barsPerMonth * 100000);

  const out = {
    hypothesis: "D2-VWAP anchored-VWAP deviation reversion",
    nBars: bars.length,
    honestN,
    best: best.id,
    netSharpeAnn: +gate.netSharpeAnn.toFixed(3),
    grossSharpeAnn: +gate.grossSharpeAnn.toFixed(3),
    costDrag: +(grossBestS - bestS).toFixed(3),
    netMeanBp: +gate.netMeanBp.toFixed(3),
    turnover: +gate.turnover.toFixed(4),
    trades: bestDiag.trades,
    buyHoldSharpe: +gate.buyHoldSharpe.toFixed(3),
    bootLowerSharpe: +gate.bootLowerSharpe.toFixed(3),
    bootUpperSharpe: +gate.bootUpperSharpe.toFixed(3),
    dsrProb: +gate.dsrProb.toFixed(4),
    surrogateP_bracketOnSurrogate: +gate.surrogateP.toFixed(4),
    surrogateMeanSharpe: +gate.surrogateMeanSharpe.toFixed(3),
    surrogateP_IIDshuffle: +pIID.toFixed(4),
    pbo: gate.pbo === null ? null : +gate.pbo.toFixed(3),
    pass: gate.pass,
    bindingGate: gate.bindingGate,
    monthlyAt100k: gate.monthlyAt100k,
    monthlyIfTraded,
    note: "h>=1 strictly lagged: z-dev through bar i close -> position entered bar i+1. Cost 4bps/side taker on |Δpos|.",
  };
  writeFileSync(`${OUT}/anchored-vwap-result.json`, JSON.stringify({ result: out, topConfigs: allRows.sort((a, b) => b.sharpe - a.sharpe).slice(0, 15) }, null, 2));
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(out, null, 2));
}

main();
