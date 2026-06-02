/**
 * D2 edge-hunt runner. Builds the strongest honest version of each $0 hypothesis,
 * runs the committed gauntlet (net-of-cost, honest N, DSR, block-boot CI, surrogate
 * null, PBO). Order-flow: ONLY strictly-lagged (h>=1) signal counts as edge.
 *
 * Each hypothesis: (a) compute signal, (b) map to position with h>=1 lag,
 * (c) sweep configs (honest N = every config tried), pick best by IN-SAMPLE-ish
 * net Sharpe but report the GAUNTLET on it with surrogate null + PBO across all
 * configs, (d) surrogate = strategy recomputed on null path that destroys the
 * specific structure being claimed.
 */
import {
  loadDaily,
  load15m,
  simpleret,
  signedFlow,
  ofImbalance,
  backtestNet,
  runGauntlet,
  rng,
  blockResampleIndices,
  printResult,
  type Bar,
  type GateResult,
} from "./lib.ts";
import { writeFileSync } from "node:fs";

const SUR = 500; // surrogate paths
const results: Record<string, GateResult> = {};

function ema(x: number[], span: number): number[] {
  const a = 2 / (span + 1);
  const out: number[] = [];
  let prev = x[0] ?? 0;
  for (let i = 0; i < x.length; i += 1) {
    prev = i === 0 ? x[0] : a * x[i] + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}
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
function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

// =====================================================================
// D2-V3  Cumulative Volume Delta trend (UNC, most credible)
// signal: trailing CVD slope (normalized signed-flow z). LAG h>=1.
// surrogate null: block-bootstrap the signed-flow stream, re-pair with the
// SAME realized returns -> destroys any flow->future-return link while keeping
// return autocorr and flow autocorr. p = P(null netSharpe >= observed).
// =====================================================================
function runV3() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars); // rets[i] = bar i->i+1 (decided at bar i)
  const flow = signedFlow(bars); // per-bar signed taker flow
  const ofi = ofImbalance(bars);

  // config sweep: smoothing window over normalized OFI, and z-window
  const smoothWins = [3, 5, 7, 10, 14, 20];
  const zWins = [20, 40, 60, 90];
  const configs: { id: string; pos: number[]; lab: string }[] = [];
  for (const sw of smoothWins) {
    for (const zw of zWins) {
      const sig = zscore(sma(ofi, sw), zw);
      // position at bar i uses signal at bar i-1 (h>=1 lag, strictly lagged)
      const pos: number[] = new Array(rets.length).fill(0);
      for (let i = 0; i < rets.length; i += 1) {
        const s = i - 1 >= 0 ? sig[i - 1] : 0; // h=1 lag
        pos[i] = Math.max(-1, Math.min(1, s)); // trend-follow flow
      }
      configs.push({ id: `sw${sw}_zw${zw}`, pos, lab: `${sw}/${zw}` });
    }
  }
  const honestN = configs.length;

  // pick best config by net Sharpe (in-sample-ish; honestN penalizes via DSR)
  let best = configs[0];
  let bestS = -Infinity;
  const foldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of configs) {
    const bt = backtestNet(c.pos, rets);
    const m = bt.net.reduce((a, b) => a + b, 0) / bt.net.length;
    const sd = Math.sqrt(bt.net.reduce((a, b) => a + (b - m) ** 2, 0) / bt.net.length);
    const sh = sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
    if (sh > bestS) {
      bestS = sh;
      best = c;
    }
    // 5 folds for PBO
    const k = Math.floor(bt.net.length / 5);
    foldsByCfg.push({
      id: c.id,
      folds: [0, 1, 2, 3, 4].map((f) => bt.net.slice(f * k, (f + 1) * k)),
    });
  }
  const bt = backtestNet(best.pos, rets);
  const observed = (() => {
    const m = bt.net.reduce((a, b) => a + b, 0) / bt.net.length;
    const sd = Math.sqrt(bt.net.reduce((a, b) => a + (b - m) ** 2, 0) / bt.net.length);
    return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
  })();

  // h=0 contemporaneous ceiling (NOT the edge; sanity only)
  const posH0 = new Array(rets.length).fill(0).map((_, i) => {
    const sig = zscore(sma(ofi, 5), 40);
    return Math.max(-1, Math.min(1, sig[i])); // same-bar
  });
  const btH0 = backtestNet(posH0, rets);
  const h0sh = (() => {
    const m = btH0.gross.reduce((a, b) => a + b, 0) / btH0.gross.length;
    const sd = Math.sqrt(btH0.gross.reduce((a, b) => a + (b - m) ** 2, 0) / btH0.gross.length);
    return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
  })();

  // surrogate: block-bootstrap the FLOW stream, recompute the SAME strategy,
  // keeping realized returns fixed -> kills flow->future link.
  const surSharpes: number[] = [];
  const blk = 10;
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(1000 + s);
    const idx = blockResampleIndices(ofi.length, blk, rand);
    const ofiS = idx.map((j) => ofi[j]);
    const sig = zscore(sma(ofiS, Number(best.id.split("_")[0].slice(2))), Number(best.id.split("_")[1].slice(2)));
    const pos: number[] = new Array(rets.length).fill(0);
    for (let i = 0; i < rets.length; i += 1) pos[i] = Math.max(-1, Math.min(1, i - 1 >= 0 ? sig[i - 1] : 0));
    const b = backtestNet(pos, rets);
    const m = b.net.reduce((a, x) => a + x, 0) / b.net.length;
    const sd = Math.sqrt(b.net.reduce((a, x) => a + (x - m) ** 2, 0) / b.net.length);
    surSharpes.push(sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0);
  }

  const r = runGauntlet({
    name: "D2-V3 CVD trend (h>=1)",
    config: best.lab,
    net: bt.net,
    gross: bt.gross,
    turnover: bt.turnover,
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: observed,
    buyHoldRets: rets,
    pboStrategies: foldsByCfg,
    periodsPerYear: 365,
  });
  console.log(`  [h=0 contemporaneous ceiling gross Sharpe = ${h0sh.toFixed(2)} — circular, not edge]`);
  results["D2-V3"] = r;
  printResult(r);
}

// =====================================================================
// D2-M1  VPIN order-flow toxicity (UNC, vol/regime gate)
// signal: VPIN = trailing mean |buy-sell|/total over volume buckets (here
// fixed-bar proxy). Test BOTH directional and a vol-timing variant. KEY
// control: must BEAT trailing-realized-vol baseline. Use h>=1.
// surrogate: shuffle the |imbalance| within blocks vs returns.
// =====================================================================
function runM1() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars);
  const absImb = bars.map((b) => (b.v > 0 ? Math.abs(2 * b.tbb - b.v) / b.v : 0));
  // VPIN proxy = trailing mean of abs imbalance
  const vpinWins = [10, 20, 30, 50];
  // realized vol baseline
  function rvol(w: number): number[] {
    const out: number[] = new Array(rets.length).fill(0);
    for (let i = 0; i < rets.length; i += 1) {
      const lo = Math.max(0, i - w + 1);
      const win = rets.slice(lo, i + 1);
      const m = win.reduce((a, b) => a + b, 0) / win.length;
      out[i] = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / win.length);
    }
    return out;
  }

  // Strategy: high VPIN -> reduce/flip exposure (toxicity = adverse). Test as a
  // RISK-OFF gate on a long-trend base. We test "VPIN-timed long" vs the same
  // vol-timed long baseline; edge = excess over vol-timing.
  const configs: { id: string; pos: number[]; lab: string }[] = [];
  for (const w of vpinWins) {
    const vp = sma(absImb, w);
    const vz = zscore(vp, 60);
    const pos: number[] = new Array(rets.length).fill(0);
    for (let i = 0; i < rets.length; i += 1) {
      const v = i - 1 >= 0 ? vz[i - 1] : 0; // h>=1
      // long, scaled down when VPIN high (toxic)
      pos[i] = Math.max(0, 1 - Math.max(0, v) * 0.5);
    }
    configs.push({ id: `vp${w}`, pos, lab: `vpin${w}->riskoff` });
  }
  // vol-timing baseline (the control): long scaled by inverse vol z
  const rv = zscore(rvol(20), 60);
  const baseVol: number[] = new Array(rets.length).fill(0);
  for (let i = 0; i < rets.length; i += 1) {
    const v = i - 1 >= 0 ? rv[i - 1] : 0;
    baseVol[i] = Math.max(0, 1 - Math.max(0, v) * 0.5);
  }
  const honestN = configs.length + 1; // +baseline counts as a trial

  let best = configs[0];
  let bestS = -Infinity;
  const foldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of configs) {
    const bt = backtestNet(c.pos, rets);
    const m = bt.net.reduce((a, b) => a + b, 0) / bt.net.length;
    const sd = Math.sqrt(bt.net.reduce((a, b) => a + (b - m) ** 2, 0) / bt.net.length);
    const sh = sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
    if (sh > bestS) { bestS = sh; best = c; }
    const k = Math.floor(bt.net.length / 5);
    foldsByCfg.push({ id: c.id, folds: [0,1,2,3,4].map((f) => bt.net.slice(f*k,(f+1)*k)) });
  }
  const bt = backtestNet(best.pos, rets);
  // EDGE = excess of VPIN-timed over VOL-timed (the decisive control).
  const btBase = backtestNet(baseVol, rets);
  const excessNet = bt.net.map((x, i) => x - (btBase.net[i] ?? 0));
  const observed = (() => {
    const m = excessNet.reduce((a, b) => a + b, 0) / excessNet.length;
    const sd = Math.sqrt(excessNet.reduce((a, b) => a + (b - m) ** 2, 0) / excessNet.length);
    return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
  })();

  // surrogate: block-bootstrap abs-imbalance vs returns
  const surSharpes: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(2000 + s);
    const idx = blockResampleIndices(absImb.length, 10, rand);
    const ai = idx.map((j) => absImb[j]);
    const vz = zscore(sma(ai, Number(best.id.slice(2))), 60);
    const pos: number[] = new Array(rets.length).fill(0);
    for (let i = 0; i < rets.length; i += 1) {
      const v = i - 1 >= 0 ? vz[i - 1] : 0;
      pos[i] = Math.max(0, 1 - Math.max(0, v) * 0.5);
    }
    const b = backtestNet(pos, rets);
    const ex = b.net.map((x, i) => x - (btBase.net[i] ?? 0));
    const m = ex.reduce((a, x) => a + x, 0) / ex.length;
    const sd = Math.sqrt(ex.reduce((a, x) => a + (x - m) ** 2, 0) / ex.length);
    surSharpes.push(sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0);
  }

  const r = runGauntlet({
    name: "D2-M1 VPIN toxicity (excess over vol-timing, h>=1)",
    config: best.lab,
    net: excessNet,
    gross: excessNet,
    turnover: bt.turnover,
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: observed,
    buyHoldRets: rets,
    pboStrategies: foldsByCfg,
    periodsPerYear: 365,
  });
  results["D2-M1"] = r;
  printResult(r);
}

// =====================================================================
// D2-D1  Liquidation cascade fade ($0 proxy: 3-sigma down-candle + volume spike
// + funding context). KEY control: must beat "fade ANY 3-sigma candle".
// surrogate: calendar-reanchor / block-bootstrap the trigger times.
// =====================================================================
function runD1() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars);
  const vz = zscore(bars.map((b) => b.v), 60); // volume z
  const rz = zscore(rets.concat([0]), 60); // return z (aligned to bar)
  // cascade proxy: big down move + high volume (forced deleveraging signature)
  const sigmas = [2, 2.5, 3];
  const holds = [1, 2, 3];
  const configs: { id: string; pos: number[]; lab: string }[] = [];
  for (const sg of sigmas) {
    for (const hd of holds) {
      const pos: number[] = new Array(rets.length).fill(0);
      for (let i = 1; i < rets.length; i += 1) {
        // trigger at bar i-1 (info known), fade (go long) for hd bars
        let on = false;
        for (let k = 1; k <= hd; k += 1) {
          const j = i - k;
          if (j >= 0 && rz[j] < -sg && vz[j] > 1) on = true;
        }
        pos[i] = on ? 1 : 0; // fade the down cascade = buy
      }
      configs.push({ id: `s${sg}_h${hd}`, pos, lab: `${sg}sig/hold${hd}` });
    }
  }
  // CONTROL: fade ANY 3-sigma candle (no volume condition)
  const ctrl: number[] = new Array(rets.length).fill(0);
  for (let i = 1; i < rets.length; i += 1) {
    if (i - 1 >= 0 && rz[i - 1] < -2.5) ctrl[i] = 1;
  }
  const honestN = configs.length + 1;

  let best = configs[0];
  let bestS = -Infinity;
  const foldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of configs) {
    const bt = backtestNet(c.pos, rets);
    const m = bt.net.reduce((a, b) => a + b, 0) / bt.net.length;
    const sd = Math.sqrt(bt.net.reduce((a, b) => a + (b - m) ** 2, 0) / bt.net.length);
    const sh = sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
    if (sh > bestS) { bestS = sh; best = c; }
    const k = Math.floor(bt.net.length / 5);
    foldsByCfg.push({ id: c.id, folds: [0,1,2,3,4].map((f) => bt.net.slice(f*k,(f+1)*k)) });
  }
  const bt = backtestNet(best.pos, rets);
  const btC = backtestNet(ctrl, rets);
  // EDGE = excess of volume-confirmed cascade fade over plain-candle fade
  const excessNet = bt.net.map((x, i) => x - (btC.net[i] ?? 0));
  const observed = (() => {
    const m = excessNet.reduce((a, b) => a + b, 0) / excessNet.length;
    const sd = Math.sqrt(excessNet.reduce((a, b) => a + (b - m) ** 2, 0) / excessNet.length);
    return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
  })();

  // surrogate: block-bootstrap returns (recompute trigger+fade on null path)
  const surSharpes: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(3000 + s);
    const idx = blockResampleIndices(rets.length, 5, rand);
    const rS = idx.map((j) => rets[j]);
    const rzS = zscore(rS.concat([0]), 60);
    const vS = idx.map((j) => bars[j].v);
    const vzS = zscore(vS, 60);
    const sg = Number(best.id.split("_")[0].slice(1));
    const hd = Number(best.id.split("_")[1].slice(1));
    const pos: number[] = new Array(rS.length).fill(0);
    for (let i = 1; i < rS.length; i += 1) {
      let on = false;
      for (let k = 1; k <= hd; k += 1) {
        const j = i - k;
        if (j >= 0 && rzS[j] < -sg && vzS[j] > 1) on = true;
      }
      pos[i] = on ? 1 : 0;
    }
    const ctrlS: number[] = new Array(rS.length).fill(0);
    for (let i = 1; i < rS.length; i += 1) if (i-1>=0 && rzS[i-1] < -2.5) ctrlS[i] = 1;
    const b = backtestNet(pos, rS);
    const bc = backtestNet(ctrlS, rS);
    const ex = b.net.map((x, i) => x - (bc.net[i] ?? 0));
    const m = ex.reduce((a, x) => a + x, 0) / ex.length;
    const sd = Math.sqrt(ex.reduce((a, x) => a + (x - m) ** 2, 0) / ex.length);
    surSharpes.push(sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0);
  }

  const r = runGauntlet({
    name: "D2-D1 liq-cascade fade (excess over plain-candle fade)",
    config: best.lab,
    net: excessNet,
    gross: excessNet,
    turnover: bt.turnover,
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: observed,
    buyHoldRets: rets,
    pboStrategies: foldsByCfg,
    periodsPerYear: 365,
  });
  results["D2-D1"] = r;
  printResult(r);
}

// =====================================================================
// D2-V6  Volume-confirmed breakouts (KILL prior). Donchian breakout filtered
// by volume surge. CONTROL: must beat unfiltered breakout. surrogate: phase-
// preserving block bootstrap + return->volume map fixed.
// =====================================================================
function runV6() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars);
  const close = bars.map((b) => b.c);
  const vz = zscore(bars.map((b) => b.v), 40);
  const looks = [20, 30, 55];
  const volThr = [0.5, 1, 1.5];
  const configs: { id: string; pos: number[]; lab: string }[] = [];
  for (const lk of looks) {
    for (const vt of volThr) {
      const pos: number[] = new Array(rets.length).fill(0);
      for (let i = 0; i < rets.length; i += 1) {
        const j = i - 1; // decide using prior bar
        if (j < lk) continue;
        const hi = Math.max(...close.slice(j - lk, j));
        const lo = Math.min(...close.slice(j - lk, j));
        const vok = vz[j] > vt;
        if (close[j] > hi && vok) pos[i] = 1;
        else if (close[j] < lo && vok) pos[i] = -1;
        else pos[i] = pos[i - 1] ?? 0; // hold
      }
      configs.push({ id: `lk${lk}_vt${vt}`, pos, lab: `${lk}/${vt}` });
    }
  }
  // CONTROL: unfiltered breakout
  const ctrl: number[] = new Array(rets.length).fill(0);
  for (let i = 0; i < rets.length; i += 1) {
    const j = i - 1; if (j < 30) continue;
    const hi = Math.max(...close.slice(j-30, j));
    const lo = Math.min(...close.slice(j-30, j));
    if (close[j] > hi) ctrl[i] = 1; else if (close[j] < lo) ctrl[i] = -1; else ctrl[i] = ctrl[i-1] ?? 0;
  }
  const honestN = configs.length + 1;
  let best = configs[0]; let bestS = -Infinity;
  const foldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of configs) {
    const bt = backtestNet(c.pos, rets);
    const m = bt.net.reduce((a,b)=>a+b,0)/bt.net.length;
    const sd = Math.sqrt(bt.net.reduce((a,b)=>a+(b-m)**2,0)/bt.net.length);
    const sh = sd>1e-12?(m/sd)*Math.sqrt(365):0;
    if (sh>bestS){bestS=sh;best=c;}
    const k=Math.floor(bt.net.length/5);
    foldsByCfg.push({id:c.id,folds:[0,1,2,3,4].map((f)=>bt.net.slice(f*k,(f+1)*k))});
  }
  const bt = backtestNet(best.pos, rets);
  const btC = backtestNet(ctrl, rets);
  const excessNet = bt.net.map((x,i)=>x-(btC.net[i]??0));
  const observed = (()=>{const m=excessNet.reduce((a,b)=>a+b,0)/excessNet.length;const sd=Math.sqrt(excessNet.reduce((a,b)=>a+(b-m)**2,0)/excessNet.length);return sd>1e-12?(m/sd)*Math.sqrt(365):0;})();
  // surrogate: block-bootstrap returns, rebuild close path, recompute both
  const surSharpes: number[] = [];
  for (let s=0;s<SUR;s+=1){
    const rand=rng(4000+s);
    const idx=blockResampleIndices(rets.length,5,rand);
    const rS=idx.map((j)=>rets[j]);
    const cS:number[]=[100]; for(const rr of rS) cS.push(cS[cS.length-1]*(1+rr));
    const vS=idx.map((j)=>bars[j].v); const vzS=zscore(vS,40);
    const lk=Number(best.id.split("_")[0].slice(2)); const vt=Number(best.id.split("_")[1].slice(2));
    const pos:number[]=new Array(rS.length).fill(0);
    for(let i=0;i<rS.length;i+=1){const j=i-1;if(j<lk)continue;const hi=Math.max(...cS.slice(j-lk,j));const lo=Math.min(...cS.slice(j-lk,j));const vok=vzS[j]>vt;if(cS[j]>hi&&vok)pos[i]=1;else if(cS[j]<lo&&vok)pos[i]=-1;else pos[i]=pos[i-1]??0;}
    const ctrlS:number[]=new Array(rS.length).fill(0);
    for(let i=0;i<rS.length;i+=1){const j=i-1;if(j<30)continue;const hi=Math.max(...cS.slice(j-30,j));const lo=Math.min(...cS.slice(j-30,j));if(cS[j]>hi)ctrlS[i]=1;else if(cS[j]<lo)ctrlS[i]=-1;else ctrlS[i]=ctrlS[i-1]??0;}
    const b=backtestNet(pos,rS); const bc=backtestNet(ctrlS,rS);
    const ex=b.net.map((x,i)=>x-(bc.net[i]??0));
    const m=ex.reduce((a,x)=>a+x,0)/ex.length; const sd=Math.sqrt(ex.reduce((a,x)=>a+(x-m)**2,0)/ex.length);
    surSharpes.push(sd>1e-12?(m/sd)*Math.sqrt(365):0);
  }
  const r = runGauntlet({name:"D2-V6 volume-confirmed breakout (excess over unfiltered)",config:best.lab,net:excessNet,gross:excessNet,turnover:bt.turnover,honestN,surrogateSharpes:surSharpes,observedSharpe:observed,buyHoldRets:rets,pboStrategies:foldsByCfg,periodsPerYear:365});
  results["D2-V6"]=r; printResult(r);
}

// =====================================================================
// D2-V1  OBV divergence/trend (KILL prior). OBV trend signal, h>=1.
// surrogate: phase-rand (block-boot) returns, regenerate OBV on surrogate path.
// =====================================================================
function runV1() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars);
  function obv(b: Bar[]): number[] {
    const o: number[] = [0];
    for (let i=1;i<b.length;i+=1) o.push(o[i-1] + Math.sign(b[i].c-b[i-1].c)*b[i].v);
    return o;
  }
  const ob = obv(bars);
  const obvz = zscore(ob, 60);
  const wins = [10,20,40,60];
  const configs:{id:string;pos:number[];lab:string}[]=[];
  for (const w of wins) {
    const slope = obvz.map((v,i)=> i>=w ? obvz[i]-obvz[i-w] : 0);
    const pos:number[]=new Array(rets.length).fill(0);
    for(let i=0;i<rets.length;i+=1){const s=i-1>=0?slope[i-1]:0;pos[i]=Math.max(-1,Math.min(1,sign(s)));}
    configs.push({id:`w${w}`,pos,lab:`obvSlope${w}`});
  }
  const honestN=configs.length;
  let best=configs[0];let bestS=-Infinity;const foldsByCfg:{id:string;folds:number[][]}[]=[];
  for(const c of configs){const bt=backtestNet(c.pos,rets);const m=bt.net.reduce((a,b)=>a+b,0)/bt.net.length;const sd=Math.sqrt(bt.net.reduce((a,b)=>a+(b-m)**2,0)/bt.net.length);const sh=sd>1e-12?(m/sd)*Math.sqrt(365):0;if(sh>bestS){bestS=sh;best=c;}const k=Math.floor(bt.net.length/5);foldsByCfg.push({id:c.id,folds:[0,1,2,3,4].map((f)=>bt.net.slice(f*k,(f+1)*k))});}
  const bt=backtestNet(best.pos,rets);
  const observed=(()=>{const m=bt.net.reduce((a,b)=>a+b,0)/bt.net.length;const sd=Math.sqrt(bt.net.reduce((a,b)=>a+(b-m)**2,0)/bt.net.length);return sd>1e-12?(m/sd)*Math.sqrt(365):0;})();
  const surSharpes:number[]=[];
  for(let s=0;s<SUR;s+=1){const rand=rng(5000+s);const idx=blockResampleIndices(rets.length,5,rand);const rS=idx.map((j)=>rets[j]);
    // rebuild bars on surrogate path to regenerate OBV
    const bS:Bar[]=[{...bars[0]}];for(let i=0;i<rS.length;i+=1){const p=bS[i];const c=p.c*(1+rS[i]);bS.push({...bars[idx[i]],c,o:p.c});}
    const obS=obv(bS);const obzS=zscore(obS,60);const w=Number(best.id.slice(1));
    const slope=obzS.map((v,i)=>i>=w?obzS[i]-obzS[i-w]:0);
    const pos:number[]=new Array(rS.length).fill(0);for(let i=0;i<rS.length;i+=1){const ss=i-1>=0?slope[i-1]:0;pos[i]=Math.max(-1,Math.min(1,sign(ss)));}
    const b=backtestNet(pos,rS);const m=b.net.reduce((a,x)=>a+x,0)/b.net.length;const sd=Math.sqrt(b.net.reduce((a,x)=>a+(x-m)**2,0)/b.net.length);surSharpes.push(sd>1e-12?(m/sd)*Math.sqrt(365):0);}
  const r=runGauntlet({name:"D2-V1 OBV trend (h>=1)",config:best.lab,net:bt.net,gross:bt.gross,turnover:bt.turnover,honestN,surrogateSharpes:surSharpes,observedSharpe:observed,buyHoldRets:rets,pboStrategies:foldsByCfg,periodsPerYear:365});
  results["D2-V1"]=r;printResult(r);
}

// =====================================================================
// D2-V2  VWAP-deviation reversion (KILL prior). Bar-VWAP bands, fade.
// CONTROL: separate from AR(1) reversion. surrogate: block-boot returns.
// =====================================================================
function runV2() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars);
  // rolling VWAP proxy: sum(typical*vol)/sum(vol) over window
  function rvwap(w:number):number[]{const tp=bars.map((b)=>(b.h+b.l+b.c)/3);const out:number[]=new Array(bars.length).fill(0);let pv=0,vv=0;const buf:[number,number][]=[];for(let i=0;i<bars.length;i+=1){buf.push([tp[i]*bars[i].v,bars[i].v]);pv+=tp[i]*bars[i].v;vv+=bars[i].v;if(buf.length>w){const[op,ov]=buf.shift()!;pv-=op;vv-=ov;}out[i]=vv>0?pv/vv:tp[i];}return out;}
  const ws=[10,20,30]; const ks=[1,1.5,2];
  const configs:{id:string;pos:number[];lab:string}[]=[];
  for(const w of ws){const vw=rvwap(w);const dev=bars.map((b,i)=>(b.c-vw[i])/vw[i]);const dz=zscore(dev,w*2);
    for(const k of ks){const pos:number[]=new Array(rets.length).fill(0);for(let i=0;i<rets.length;i+=1){const d=i-1>=0?dz[i-1]:0;pos[i]=d>k?-1:d<-k?1:0;}configs.push({id:`w${w}_k${k}`,pos,lab:`${w}/${k}`});}}
  // CONTROL: AR(1) reversion on raw return z (no VWAP)
  const rz=zscore(rets.concat([0]),40);
  const ctrl:number[]=new Array(rets.length).fill(0);for(let i=0;i<rets.length;i+=1){const d=i-1>=0?rz[i-1]:0;ctrl[i]=d>1.5?-1:d<-1.5?1:0;}
  const honestN=configs.length+1;
  let best=configs[0];let bestS=-Infinity;const foldsByCfg:{id:string;folds:number[][]}[]=[];
  for(const c of configs){const bt=backtestNet(c.pos,rets);const m=bt.net.reduce((a,b)=>a+b,0)/bt.net.length;const sd=Math.sqrt(bt.net.reduce((a,b)=>a+(b-m)**2,0)/bt.net.length);const sh=sd>1e-12?(m/sd)*Math.sqrt(365):0;if(sh>bestS){bestS=sh;best=c;}const kk=Math.floor(bt.net.length/5);foldsByCfg.push({id:c.id,folds:[0,1,2,3,4].map((f)=>bt.net.slice(f*kk,(f+1)*kk))});}
  const bt=backtestNet(best.pos,rets);const btC=backtestNet(ctrl,rets);
  const excessNet=bt.net.map((x,i)=>x-(btC.net[i]??0));
  const observed=(()=>{const m=excessNet.reduce((a,b)=>a+b,0)/excessNet.length;const sd=Math.sqrt(excessNet.reduce((a,b)=>a+(b-m)**2,0)/excessNet.length);return sd>1e-12?(m/sd)*Math.sqrt(365):0;})();
  const surSharpes:number[]=[];
  for(let s=0;s<SUR;s+=1){const rand=rng(6000+s);const idx=blockResampleIndices(rets.length,5,rand);const rS=idx.map((j)=>rets[j]);
    const bS=idx.map((j)=>bars[j]);const tp=bS.map((b)=>(b.h+b.l+b.c)/3);const w=Number(best.id.split("_")[0].slice(1));const k=Number(best.id.split("_")[1].slice(1));
    const vw:number[]=new Array(bS.length).fill(0);let pv=0,vv=0;const buf:[number,number][]=[];for(let i=0;i<bS.length;i+=1){buf.push([tp[i]*bS[i].v,bS[i].v]);pv+=tp[i]*bS[i].v;vv+=bS[i].v;if(buf.length>w){const[op,ov]=buf.shift()!;pv-=op;vv-=ov;}vw[i]=vv>0?pv/vv:tp[i];}
    const dev=bS.map((b,i)=>(b.c-vw[i])/vw[i]);const dz=zscore(dev,w*2);
    const pos:number[]=new Array(rS.length).fill(0);for(let i=0;i<rS.length;i+=1){const d=i-1>=0?dz[i-1]:0;pos[i]=d>k?-1:d<-k?1:0;}
    const rzS=zscore(rS.concat([0]),40);const ctrlS:number[]=new Array(rS.length).fill(0);for(let i=0;i<rS.length;i+=1){const d=i-1>=0?rzS[i-1]:0;ctrlS[i]=d>1.5?-1:d<-1.5?1:0;}
    const b=backtestNet(pos,rS);const bc=backtestNet(ctrlS,rS);const ex=b.net.map((x,i)=>x-(bc.net[i]??0));
    const m=ex.reduce((a,x)=>a+x,0)/ex.length;const sd=Math.sqrt(ex.reduce((a,x)=>a+(x-m)**2,0)/ex.length);surSharpes.push(sd>1e-12?(m/sd)*Math.sqrt(365):0);}
  const r=runGauntlet({name:"D2-V2 VWAP reversion (excess over AR1)",config:best.lab,net:excessNet,gross:excessNet,turnover:bt.turnover,honestN,surrogateSharpes:surSharpes,observedSharpe:observed,buyHoldRets:rets,pboStrategies:foldsByCfg,periodsPerYear:365});
  results["D2-V2"]=r;printResult(r);
}

// =====================================================================
// D2-M4  Trade-size clustering / whale tape (KILL prior). Proxy: avg trade size
// = volume / trade-count. Large-print z -> follow. h>=1. CONTROL: collinear with
// lagged-CVD, so EDGE = excess over lagged-CVD signal. surrogate: block-boot.
// =====================================================================
function runM4() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars);
  const avgSize = bars.map((b)=> b.n>0 ? b.v/b.n : 0);
  const ofi = ofImbalance(bars);
  const wins=[5,10,20,40];
  // whale signal: big avg-size bar, direction = sign of contemporaneous-but-lagged flow
  const configs:{id:string;pos:number[];lab:string}[]=[];
  for(const w of wins){const sz=zscore(avgSize,w*3);const fl=sma(ofi,w);
    const pos:number[]=new Array(rets.length).fill(0);for(let i=0;i<rets.length;i+=1){const j=i-1;if(j<0)continue;pos[i]= sz[j]>1 ? Math.max(-1,Math.min(1,sign(fl[j]))) : 0;}
    configs.push({id:`w${w}`,pos,lab:`whale${w}`});}
  // CONTROL: lagged-CVD alone (the collinear baseline)
  const fl5=sma(ofi,10);const ctrl:number[]=new Array(rets.length).fill(0);for(let i=0;i<rets.length;i+=1){const j=i-1;if(j<0)continue;ctrl[i]=Math.max(-1,Math.min(1,sign(fl5[j])));}
  const honestN=configs.length+1;
  let best=configs[0];let bestS=-Infinity;const foldsByCfg:{id:string;folds:number[][]}[]=[];
  for(const c of configs){const bt=backtestNet(c.pos,rets);const m=bt.net.reduce((a,b)=>a+b,0)/bt.net.length;const sd=Math.sqrt(bt.net.reduce((a,b)=>a+(b-m)**2,0)/bt.net.length);const sh=sd>1e-12?(m/sd)*Math.sqrt(365):0;if(sh>bestS){bestS=sh;best=c;}const kk=Math.floor(bt.net.length/5);foldsByCfg.push({id:c.id,folds:[0,1,2,3,4].map((f)=>bt.net.slice(f*kk,(f+1)*kk))});}
  const bt=backtestNet(best.pos,rets);const btC=backtestNet(ctrl,rets);
  const excessNet=bt.net.map((x,i)=>x-(btC.net[i]??0));
  const observed=(()=>{const m=excessNet.reduce((a,b)=>a+b,0)/excessNet.length;const sd=Math.sqrt(excessNet.reduce((a,b)=>a+(b-m)**2,0)/excessNet.length);return sd>1e-12?(m/sd)*Math.sqrt(365):0;})();
  const surSharpes:number[]=[];
  for(let s=0;s<SUR;s+=1){const rand=rng(7000+s);const idx=blockResampleIndices(avgSize.length,10,rand);
    const szA=idx.map((j)=>avgSize[j]);const flA=idx.map((j)=>ofi[j]);
    const w=Number(best.id.slice(1));const sz=zscore(szA,w*3);const fl=sma(flA,w);
    const pos:number[]=new Array(rets.length).fill(0);for(let i=0;i<rets.length;i+=1){const j=i-1;if(j<0)continue;pos[i]=sz[j]>1?Math.max(-1,Math.min(1,sign(fl[j]))):0;}
    const fl5s=sma(flA,10);const ctrlS:number[]=new Array(rets.length).fill(0);for(let i=0;i<rets.length;i+=1){const j=i-1;if(j<0)continue;ctrlS[i]=Math.max(-1,Math.min(1,sign(fl5s[j])));}
    const b=backtestNet(pos,rets);const bc=backtestNet(ctrlS,rets);const ex=b.net.map((x,i)=>x-(bc.net[i]??0));
    const m=ex.reduce((a,x)=>a+x,0)/ex.length;const sd=Math.sqrt(ex.reduce((a,x)=>a+(x-m)**2,0)/ex.length);surSharpes.push(sd>1e-12?(m/sd)*Math.sqrt(365):0);}
  const r=runGauntlet({name:"D2-M4 whale-tape (excess over lagged-CVD)",config:best.lab,net:excessNet,gross:excessNet,turnover:bt.turnover,honestN,surrogateSharpes:surSharpes,observedSharpe:observed,buyHoldRets:rets,pboStrategies:foldsByCfg,periodsPerYear:365});
  results["D2-M4"]=r;printResult(r);
}

console.log("=== D2 edge-hunt: running $0 hypotheses (real-edge-chance order) ===");
runV3();
runM1();
runD1();
runV6();
runV1();
runV2();
runM4();

writeFileSync("output/edgehunt-D2/results.json", JSON.stringify(results, null, 2));
console.log("\n=== summary written to output/edgehunt-D2/results.json ===");
for (const [k, r] of Object.entries(results)) {
  console.log(`${k}: pass=${r.pass} netSharpe=${r.netSharpeAnn.toFixed(2)} binding=${r.bindingGate} surP=${r.surrogateP.toFixed(3)} N=${r.honestN}`);
}
