/**
 * D2-OBV — OBV / Accumulation-Distribution trend-confirmation overlay on daily BTC.
 *
 * BELIEF (Granville 1963; Chaikin): "volume precedes price". OBV / A-D line slope,
 * used as a TREND-CONFIRMATION overlay, should let you hold the trend only when the
 * volume line confirms it and stand aside on divergence -> beat buy&hold and an
 * equal-weight basket on a risk-adjusted basis (not just be long beta).
 *
 * STRONGEST HONEST VERSION:
 *  - OBV = cumsum(sign(dC)*V); A-D line = cumsum(MFM*V), MFM=((C-L)-(H-C))/(H-L).
 *  - Trend-confirmation overlay: hold the price trend (close vs MA) ONLY when the
 *    volume-line slope agrees; flatten / cut on divergence. Also a long-only "stay
 *    in / step out of beta" variant (the honest way to "beat buy&hold").
 *  - STRICT h>=1 LAG: the position over bar i->i+1 uses the signal through bar i-1.
 *    Same-bar volume is circular (the trades ARE the move); only the lagged
 *    component is allowed to count as edge. We report h=0 separately as a ceiling.
 *  - Honest N = EVERY config swept (line x slopeWin x maWin x zWin x mode).
 *  - Baselines: buy&hold BTC, equal-weight {BTC,ETH,BNB,SOL}, and price-trend-ALONE
 *    overlay (proves the volume line adds value vs pure momentum/beta).
 *  - RIGHT NULL: FFT phase-randomization of BTC returns (preserves the linear
 *    autocorrelation / power spectrum, destroys predictive nonlinear structure),
 *    rebuild the surrogate price path, REGENERATE OBV & A-D on it, recompute the
 *    whole strategy. p = P(surrogate net Sharpe >= observed). This breaks the
 *    OBV<->price collinearity tautology, which a plain return shuffle would not.
 *  - Cost: taker 4 bps/side on |Dposition|.
 *
 * Gauntlet = committed validators via runGauntlet (DSR@honestN, block-boot CI,
 * surrogate p, PBO). The LAGGED long/short overlay is judged ALONE.
 */
import {
  loadDaily,
  simpleret,
  backtestNet,
  runGauntlet,
  rng,
  printResult,
  type Bar,
  type GateResult,
} from "./lib.ts";
import { writeFileSync } from "node:fs";

const SUR = 1000;

// ---------- indicators ----------
function sma(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(0);
  let s = 0;
  for (let i = 0; i < x.length; i += 1) {
    s += x[i];
    if (i >= w) s -= x[i - w];
    out[i] = i >= w - 1 ? s / w : x.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
  }
  return out;
}
function obvLine(b: Bar[]): number[] {
  const o = [0];
  for (let i = 1; i < b.length; i += 1) {
    const d = Math.sign(b[i].c - b[i - 1].c);
    o.push(o[i - 1] + d * b[i].v);
  }
  return o;
}
function adLine(b: Bar[]): number[] {
  const o = [0];
  for (let i = 1; i < b.length; i += 1) {
    const rng_ = b[i].h - b[i].l;
    const mfm = rng_ > 1e-12 ? ((b[i].c - b[i].l) - (b[i].h - b[i].c)) / rng_ : 0;
    o.push(o[i - 1] + mfm * b[i].v);
  }
  return o;
}
/** slope of a series over window w (difference), normalized by rolling std of the series */
function normSlope(x: number[], w: number, zw: number): number[] {
  const slope = x.map((_, i) => (i >= w ? x[i] - x[i - w] : 0));
  // normalize slope by rolling std of slope to make it scale-free & comparable
  const out = new Array(x.length).fill(0);
  for (let i = 0; i < x.length; i += 1) {
    const lo = Math.max(0, i - zw + 1);
    const win = slope.slice(lo, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, win.length - 1));
    out[i] = sd > 1e-12 ? (slope[i] - m) / sd : 0;
  }
  return out;
}

// ---------- FFT (radix-2 + Bluestein for arbitrary N) ----------
function fft(re: number[], im: number[], inv: boolean): void {
  const n = re.length;
  if (n <= 1) return;
  // bit-reversal
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = i + k + len / 2;
        const xr = re[b] * cwr - im[b] * cwi;
        const xi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
}
function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p; }
/** Bluestein FFT for arbitrary length -> returns {re,im} */
function dft(reIn: number[], imIn: number[], inv: boolean): { re: number[]; im: number[] } {
  const n = reIn.length;
  if ((n & (n - 1)) === 0) {
    const re = reIn.slice();
    const im = imIn.slice();
    fft(re, im, inv);
    return { re, im };
  }
  const m = nextPow2(2 * n + 1);
  const sign = inv ? 1 : -1;
  const ar = new Array(m).fill(0);
  const ai = new Array(m).fill(0);
  const br = new Array(m).fill(0);
  const bi = new Array(m).fill(0);
  const wr = new Array(n);
  const wi = new Array(n);
  for (let k = 0; k < n; k += 1) {
    const ang = (sign * Math.PI * ((k * k) % (2 * n))) / n;
    wr[k] = Math.cos(ang);
    wi[k] = Math.sin(ang);
    // a[k] = x[k] * w[k]
    ar[k] = reIn[k] * wr[k] - imIn[k] * wi[k];
    ai[k] = reIn[k] * wi[k] + imIn[k] * wr[k];
  }
  br[0] = wr[0]; bi[0] = -wi[0];
  for (let k = 1; k < n; k += 1) {
    br[k] = wr[k]; bi[k] = -wi[k];
    br[m - k] = wr[k]; bi[m - k] = -wi[k];
  }
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < m; i += 1) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im2 = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r; ai[i] = im2;
  }
  fft(ar, ai, true);
  const re = new Array(n);
  const im = new Array(n);
  for (let k = 0; k < n; k += 1) {
    re[k] = ar[k] * wr[k] - ai[k] * wi[k];
    im[k] = ar[k] * wi[k] + ai[k] * wr[k];
  }
  if (inv) for (let k = 0; k < n; k += 1) { re[k] /= n; im[k] /= n; }
  return { re, im };
}
/**
 * Phase-randomization surrogate of a real series (Theiler 1992): FFT, randomize
 * phases (keeping conjugate symmetry so the inverse is real), inverse FFT.
 * Preserves the power spectrum (linear autocorrelation) exactly; destroys
 * higher-order / predictive structure. This is the RIGHT null for "does the
 * volume-line slope carry predictive info beyond linear autocorrelation".
 */
function phaseRandomize(x: number[], rand: () => number): number[] {
  const n = x.length;
  const { re, im } = dft(x.slice(), new Array(n).fill(0), false);
  const half = Math.floor(n / 2);
  const pr = new Array(n).fill(0);
  const pi = new Array(n).fill(0);
  pr[0] = re[0]; pi[0] = im[0]; // DC preserved
  for (let k = 1; k <= half; k += 1) {
    const mag = Math.hypot(re[k], im[k]);
    if (n % 2 === 0 && k === half) {
      // Nyquist must stay real
      pr[k] = re[k] >= 0 ? mag : -mag;
      pi[k] = 0;
    } else {
      const ph = rand() * 2 * Math.PI;
      pr[k] = mag * Math.cos(ph);
      pi[k] = mag * Math.sin(ph);
      pr[n - k] = pr[k];
      pi[n - k] = -pi[k];
    }
  }
  const out = dft(pr, pi, true);
  return out.re;
}

// ---------- strategy ----------
type Mode = "ls" | "long"; // long/short trend-confirm, or long-only beta-on/off
interface Cfg { id: string; line: "obv" | "ad" | "both"; sw: number; ma: number; zw: number; mode: Mode; }

function buildPositions(bars: Bar[], rets: number[], cfg: Cfg): number[] {
  const ob = normSlope(obvLine(bars), cfg.sw, cfg.zw);
  const ad = normSlope(adLine(bars), cfg.sw, cfg.zw);
  const closes = bars.map((b) => b.c);
  const maS = sma(closes, cfg.ma);
  const priceTrend = closes.map((c, i) => Math.sign(c - maS[i])); // +1 up-trend
  const pos = new Array(rets.length).fill(0);
  for (let i = 0; i < rets.length; i += 1) {
    // STRICT h>=1: decide position for bar i->i+1 from info through i-1
    const j = i - 1;
    if (j < 1) { pos[i] = 0; continue; }
    const pt = priceTrend[j];
    const volConf = cfg.line === "obv" ? Math.sign(ob[j])
      : cfg.line === "ad" ? Math.sign(ad[j])
      : (Math.sign(ob[j]) + Math.sign(ad[j])) / 2 >= 0.5 ? 1
        : (Math.sign(ob[j]) + Math.sign(ad[j])) / 2 <= -0.5 ? -1 : 0;
    if (cfg.mode === "ls") {
      // long/short trend-confirmation: take the trend only if volume confirms it
      pos[i] = pt !== 0 && volConf === pt ? pt : 0;
    } else {
      // long-only: hold beta only when up-trend AND volume confirms; else flat
      pos[i] = pt > 0 && volConf > 0 ? 1 : 0;
    }
  }
  return pos;
}

function sharpe(net: number[]): number {
  const m = net.reduce((a, b) => a + b, 0) / net.length;
  const sd = Math.sqrt(net.reduce((a, b) => a + (b - m) ** 2, 0) / net.length);
  return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
}

function main() {
  const bars = loadDaily("BTCUSDT");
  const rets = simpleret(bars);

  // equal-weight basket baseline (BTC+ETH+BNB+SOL), aligned by timestamp
  const others = ["ETHUSDT", "BNBUSDT", "SOLUSDT"].map((s) => {
    const b = loadDaily(s);
    const m = new Map<number, number>();
    for (let i = 1; i < b.length; i += 1) m.set(b[i].t, b[i].c / b[i - 1].c - 1);
    return m;
  });
  const ewRets = rets.map((r, i) => {
    const t = bars[i + 1].t;
    const vals = [r, ...others.map((m) => m.get(t)).filter((v): v is number => v !== undefined)];
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  });
  const ewSharpe = sharpe(ewRets);
  const bhSharpe = sharpe(rets);

  // ----- honest config sweep -----
  const lines: Cfg["line"][] = ["obv", "ad", "both"];
  const sws = [10, 20, 40, 60];
  const mas = [20, 50, 100, 200];
  const zws = [60, 120];
  const modes: Mode[] = ["ls", "long"];
  const configs: { cfg: Cfg; net: number[]; gross: number[]; turnover: number; sh: number }[] = [];
  for (const line of lines)
    for (const sw of sws)
      for (const ma of mas)
        for (const zw of zws)
          for (const mode of modes) {
            const cfg: Cfg = { id: `${line}_sw${sw}_ma${ma}_zw${zw}_${mode}`, line, sw, ma, zw, mode };
            const pos = buildPositions(bars, rets, cfg);
            const bt = backtestNet(pos, rets);
            configs.push({ cfg, net: bt.net, gross: bt.gross, turnover: bt.turnover, sh: sharpe(bt.net) });
          }
  const honestN = configs.length; // EVERY config is a trial

  // ----- price-trend-ALONE overlay control (no volume line) -----
  function trendAlone(ma: number, mode: Mode): number[] {
    const closes = bars.map((b) => b.c);
    const maS = sma(closes, ma);
    const pt = closes.map((c, i) => Math.sign(c - maS[i]));
    const pos = new Array(rets.length).fill(0);
    for (let i = 0; i < rets.length; i += 1) {
      const j = i - 1;
      if (j < 1) { pos[i] = 0; continue; }
      pos[i] = mode === "ls" ? pt[j] : pt[j] > 0 ? 1 : 0;
    }
    return pos;
  }

  // pick best config by net Sharpe (in-sample selection -> DSR @ honest N pays for it)
  configs.sort((a, b) => b.sh - a.sh);
  const best = configs[0];
  const bestBt = backtestNet(buildPositions(bars, rets, best.cfg), rets);
  const observedRaw = sharpe(bestBt.net);

  // EDGE = excess over price-trend-alone with the SAME ma/mode (proves volume adds value)
  const ctrlPos = trendAlone(best.cfg.ma, best.cfg.mode);
  const ctrlBt = backtestNet(ctrlPos, rets);
  const excessNet = bestBt.net.map((x, i) => x - (ctrlBt.net[i] ?? 0));
  const observedExcess = sharpe(excessNet);

  // ----- h=0 ceiling (CIRCULAR, reported only as sanity, never as edge) -----
  function buildH0(cfg: Cfg): number[] {
    const ob = normSlope(obvLine(bars), cfg.sw, cfg.zw);
    const ad = normSlope(adLine(bars), cfg.sw, cfg.zw);
    const closes = bars.map((b) => b.c);
    const maS = sma(closes, cfg.ma);
    const pt = closes.map((c, i) => Math.sign(c - maS[i]));
    const pos = new Array(rets.length).fill(0);
    for (let i = 0; i < rets.length; i += 1) {
      const j = i; // SAME BAR (look-ahead) -> ceiling only
      const vc = cfg.line === "obv" ? Math.sign(ob[j]) : cfg.line === "ad" ? Math.sign(ad[j])
        : (Math.sign(ob[j]) + Math.sign(ad[j])) / 2 >= 0.5 ? 1 : (Math.sign(ob[j]) + Math.sign(ad[j])) / 2 <= -0.5 ? -1 : 0;
      pos[i] = cfg.mode === "ls" ? (pt[j] !== 0 && vc === pt[j] ? pt[j] : 0) : (pt[j] > 0 && vc > 0 ? 1 : 0);
    }
    return pos;
  }
  const h0Sharpe = sharpe(backtestNet(buildH0(best.cfg), rets).net);

  // ----- RIGHT NULL: FFT phase-randomization, regenerate OBV/AD, recompute -----
  // surrogate measures excess-over-trend-alone too, so the null carries the same
  // collinearity / momentum structure -> isolates the volume line's added info.
  const surExcess: number[] = [];
  const surRaw: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(424242 + s);
    const rS = phaseRandomize(rets, rand);
    // rebuild a price path & bars on the surrogate returns; regenerate H/L/V from
    // the surrogate close path so OBV/AD are reconstructed on the null (not reused).
    const bS: Bar[] = [{ ...bars[0] }];
    for (let i = 0; i < rS.length; i += 1) {
      const prev = bS[i];
      const c = prev.c * (1 + rS[i]);
      const o = prev.c;
      // reconstruct a plausible H/L around o->c using the empirical bar's range ratio
      const src = bars[i + 1];
      const rngRatio = src.c !== 0 ? (src.h - src.l) / Math.abs(src.c) : 0.02;
      const span = Math.abs(c) * rngRatio;
      const hi = Math.max(o, c) + span * 0.5;
      const lo = Math.min(o, c) - span * 0.5;
      bS.push({ ...src, o, c, h: hi, l: lo });
    }
    const cfg = best.cfg;
    const posS = buildPositions(bS, rS, cfg);
    const btS = backtestNet(posS, rS);
    surRaw.push(sharpe(btS.net));
    const ctrlS = backtestNet(trendAloneS(bS, rS, cfg.ma, cfg.mode), rS);
    const exS = btS.net.map((x, i) => x - (ctrlS.net[i] ?? 0));
    surExcess.push(sharpe(exS));
  }
  function trendAloneS(b: Bar[], r: number[], ma: number, mode: Mode): number[] {
    const closes = b.map((x) => x.c);
    const maS = sma(closes, ma);
    const pt = closes.map((c, i) => Math.sign(c - maS[i]));
    const pos = new Array(r.length).fill(0);
    for (let i = 0; i < r.length; i += 1) {
      const j = i - 1;
      if (j < 1) { pos[i] = 0; continue; }
      pos[i] = mode === "ls" ? pt[j] : pt[j] > 0 ? 1 : 0;
    }
    return pos;
  }

  // PBO across configs (top set), folds of the LAGGED net
  const foldsByCfg = configs.slice(0, 24).map((c) => {
    const net = backtestNet(buildPositions(bars, rets, c.cfg), rets).net;
    const k = Math.floor(net.length / 6);
    return { id: c.cfg.id, folds: [0, 1, 2, 3, 4, 5].map((f) => net.slice(f * k, (f + 1) * k)) };
  });

  // The DELIVERABLE judgment: LAGGED long/short overlay EXCESS over trend-alone,
  // judged ALONE with phase-randomization null. Must beat buy&hold AND equal-weight.
  const rExcess = runGauntlet({
    name: "D2-OBV trend-confirm overlay (LAGGED h>=1, EXCESS over price-trend-alone)",
    config: best.cfg.id,
    net: excessNet,
    gross: excessNet,
    turnover: bestBt.turnover,
    honestN,
    surrogateSharpes: surExcess,
    observedSharpe: observedExcess,
    buyHoldRets: rets,
    pboStrategies: foldsByCfg,
    periodsPerYear: 365,
  });

  // Also judge the RAW lagged overlay (must beat buy&hold + equal-weight directly)
  const rRaw = runGauntlet({
    name: "D2-OBV trend-confirm overlay (LAGGED h>=1, RAW net vs buy&hold/equal-weight)",
    config: best.cfg.id,
    net: bestBt.net,
    gross: bestBt.gross,
    turnover: bestBt.turnover,
    honestN,
    surrogateSharpes: surRaw,
    observedSharpe: observedRaw,
    buyHoldRets: rets,
    pboStrategies: foldsByCfg,
    periodsPerYear: 365,
  });

  const beatsBH = observedRaw > bhSharpe;
  const beatsEW = observedRaw > ewSharpe;

  console.log("=== D2-OBV / Accumulation-Distribution trend confirmation ===");
  console.log(`bars=${bars.length} honestN=${honestN} cost=4bps/side`);
  console.log(`baselines: buy&hold Sharpe=${bhSharpe.toFixed(3)}  equal-weight Sharpe=${ewSharpe.toFixed(3)}`);
  console.log(`best config: ${best.cfg.id}`);
  console.log(`h=0 CEILING (circular, look-ahead) Sharpe=${h0Sharpe.toFixed(3)}  <- if this is also weak, no signal even with leakage`);
  console.log(`LAGGED raw net Sharpe=${observedRaw.toFixed(3)}  beats buy&hold=${beatsBH}  beats equal-weight=${beatsEW}`);
  console.log(`LAGGED excess-over-trend-alone Sharpe=${observedExcess.toFixed(3)}  (does volume ADD over pure trend?)`);
  console.log("--- RAW (vs buy&hold/equal-weight), LAGGED, phase-rand null ---");
  printResult(rRaw);
  console.log("--- EXCESS over price-trend-alone, LAGGED, phase-rand null ---");
  printResult(rExcess);

  const out = {
    hypothesis: "D2-OBV",
    bars: bars.length,
    honestN,
    cost_bps_per_side: 4,
    buyHoldSharpe: bhSharpe,
    equalWeightSharpe: ewSharpe,
    bestConfig: best.cfg.id,
    h0CeilingSharpe: h0Sharpe,
    lagged: {
      rawSharpe: observedRaw,
      beatsBuyHold: beatsBH,
      beatsEqualWeight: beatsEW,
      excessOverTrendAloneSharpe: observedExcess,
      raw: rRaw,
      excess: rExcess,
    },
    null: "FFT phase-randomization (Theiler 1992), OBV/AD regenerated on surrogate path",
  };
  writeFileSync("output/edgehunt-D2/obv_result.json", JSON.stringify(out, null, 2));
  console.log("wrote output/edgehunt-D2/obv_result.json");
}

main();
