/**
 * FRONT C3 — shared library: load the joint 30-coin panel, build aggregate +
 * cross-sectional STATE signals, the regime overlay strategy, and surrogate
 * generators. Pure functions so the IDENTICAL machinery runs on real and
 * surrogate panels.
 *
 * All state signals are computed from PAST data only and used LAGGED (the signal
 * at the close of day t informs the position held over day t+1) to avoid lookahead.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Panel {
  dates: string[];
  symbols: string[];
  /** closes[symbol][t], null before listing. */
  closes: Record<string, (number | null)[]>;
  /** volumes[symbol][t] quote-volume USDT, null where unavailable. */
  volumes: Record<string, (number | null)[]>;
}

/** Simple daily returns per symbol, null where either close is missing. */
export type ReturnMatrix = Record<string, (number | null)[]>;

export function loadPanel(): Panel {
  const closeFile = JSON.parse(
    readFileSync(join("output", "crossxs", "daily-closes.json"), "utf8"),
  ) as { dates: string[]; closes: Record<string, (number | null)[]> };
  const volFile = JSON.parse(
    readFileSync(join("output", "front-c3", "volume-panel.json"), "utf8"),
  ) as { dates: string[]; volumes: Record<string, (number | null)[]> };

  const symbols = Object.keys(closeFile.closes);
  // volume axis is aligned to the SAME dates by construction
  return {
    dates: closeFile.dates,
    symbols,
    closes: closeFile.closes,
    volumes: volFile.volumes,
  };
}

export function buildReturns(panel: Panel): ReturnMatrix {
  const out: ReturnMatrix = {};
  for (const s of panel.symbols) {
    const c = panel.closes[s];
    const r: (number | null)[] = new Array(c.length).fill(null);
    for (let t = 1; t < c.length; t += 1) {
      const a = c[t - 1];
      const b = c[t];
      if (a !== null && b !== null && a > 0 && Number.isFinite(a) && Number.isFinite(b)) {
        r[t] = b / a - 1;
      }
    }
    out[s] = r;
  }
  return out;
}

/** Equal-weight aggregate market return each day = mean over active coins. */
export function aggregateReturn(ret: ReturnMatrix, symbols: string[], T: number): number[] {
  const out = new Array(T).fill(0);
  for (let t = 0; t < T; t += 1) {
    let sum = 0;
    let n = 0;
    for (const s of symbols) {
      const v = ret[s][t];
      if (v !== null && Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    out[t] = n > 0 ? sum / n : 0;
  }
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Pearson correlation of two equal-length arrays (no nulls). */
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sa = 0;
  let sb = 0;
  let sab = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sa += da * da;
    sb += db * db;
    sab += da * db;
  }
  if (sa <= 1e-18 || sb <= 1e-18) return 0;
  return sab / Math.sqrt(sa * sb);
}

export interface StateSignals {
  breadth: number[]; // % coins above trailing MA
  dispersion: number[]; // cross-sectional std of trailing momentum
  avgCorr: number[]; // mean pairwise corr over trailing window
  volHHI: number[]; // Herfindahl of volume share
  btcDom: number[]; // BTC volume share
  aggMom: number[]; // trailing aggregate cumulative return
}

export interface SignalParams {
  maWindow: number; // breadth trailing MA window (days)
  dispWindow: number; // momentum window for dispersion (days)
  corrWindow: number; // pairwise correlation window (days)
  momWindow: number; // aggregate momentum window (days)
}

/**
 * Compute all joint state signals. Each value at index t uses ONLY data up to
 * and including day t (close-of-day-t information set).
 */
export function computeStateSignals(
  panel: Panel,
  ret: ReturnMatrix,
  params: SignalParams,
): StateSignals {
  const { dates, symbols, closes, volumes } = panel;
  const T = dates.length;
  const breadth = new Array(T).fill(0);
  const dispersion = new Array(T).fill(0);
  const avgCorr = new Array(T).fill(0);
  const volHHI = new Array(T).fill(0);
  const btcDom = new Array(T).fill(0);
  const aggMom = new Array(T).fill(0);

  const { maWindow, dispWindow, corrWindow, momWindow } = params;
  const agg = aggregateReturn(ret, symbols, T);

  for (let t = 0; t < T; t += 1) {
    // --- breadth: fraction of active coins with close > trailing MA(maWindow) ---
    {
      let above = 0;
      let active = 0;
      for (const s of symbols) {
        const c = closes[s];
        const px = c[t];
        if (px === null || !Number.isFinite(px)) continue;
        if (t < maWindow) continue;
        let sum = 0;
        let n = 0;
        for (let k = t - maWindow + 1; k <= t; k += 1) {
          const v = c[k];
          if (v !== null && Number.isFinite(v)) {
            sum += v;
            n += 1;
          }
        }
        if (n < Math.max(3, Math.floor(maWindow * 0.6))) continue;
        active += 1;
        if (px > sum / n) above += 1;
      }
      breadth[t] = active > 0 ? above / active : 0.5;
    }

    // --- dispersion: cross-sectional std of trailing momentum (dispWindow ret) ---
    {
      const moms: number[] = [];
      for (const s of symbols) {
        const c = closes[s];
        const pNow = c[t];
        const pPast = t >= dispWindow ? c[t - dispWindow] : null;
        if (pNow !== null && pPast !== null && pPast > 0 && Number.isFinite(pNow) && Number.isFinite(pPast)) {
          moms.push(pNow / pPast - 1);
        }
      }
      dispersion[t] = moms.length >= 3 ? std(moms) : 0;
    }

    // --- average pairwise correlation over trailing corrWindow returns ---
    {
      if (t >= corrWindow) {
        // collect series for coins with full data in the window
        const series: number[][] = [];
        for (const s of symbols) {
          const r = ret[s];
          const w: number[] = [];
          let ok = true;
          for (let k = t - corrWindow + 1; k <= t; k += 1) {
            const v = r[k];
            if (v === null || !Number.isFinite(v)) {
              ok = false;
              break;
            }
            w.push(v);
          }
          if (ok && w.length === corrWindow) series.push(w);
        }
        if (series.length >= 3) {
          let sum = 0;
          let cnt = 0;
          for (let i = 0; i < series.length; i += 1) {
            for (let j = i + 1; j < series.length; j += 1) {
              sum += corr(series[i], series[j]);
              cnt += 1;
            }
          }
          avgCorr[t] = cnt > 0 ? sum / cnt : 0;
        } else {
          avgCorr[t] = t > 0 ? avgCorr[t - 1] : 0;
        }
      }
    }

    // --- volume concentration HHI + BTC dominance (today's volume shares) ---
    {
      let total = 0;
      const shares: number[] = [];
      let btcVol = 0;
      for (const s of symbols) {
        const v = volumes[s]?.[t];
        if (v !== null && v !== undefined && Number.isFinite(v) && v > 0) {
          shares.push(v);
          total += v;
          if (s === "BTC") btcVol = v;
        }
      }
      if (total > 0 && shares.length >= 3) {
        let hhi = 0;
        for (const v of shares) {
          const sh = v / total;
          hhi += sh * sh;
        }
        volHHI[t] = hhi;
        btcDom[t] = btcVol / total;
      } else {
        volHHI[t] = t > 0 ? volHHI[t - 1] : 1 / symbols.length;
        btcDom[t] = t > 0 ? btcDom[t - 1] : 1 / symbols.length;
      }
    }

    // --- aggregate momentum: trailing momWindow cumulative agg return ---
    {
      if (t >= momWindow) {
        let logc = 0;
        for (let k = t - momWindow + 1; k <= t; k += 1) {
          logc += Math.log1p(Math.max(-0.99, agg[k]));
        }
        aggMom[t] = Math.expm1(logc);
      }
    }
  }

  return { breadth, dispersion, avgCorr, volHHI, btcDom, aggMom };
}

/** z-score a series using an expanding (causal) mean/std (no lookahead). */
export function expandingZScore(xs: number[], minObs = 60): number[] {
  const out = new Array(xs.length).fill(0);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let t = 0; t < xs.length; t += 1) {
    if (n >= minObs) {
      const m = sum / n;
      const v = sumSq / n - m * m;
      const sd = Math.sqrt(Math.max(1e-12, v));
      out[t] = sd > 1e-9 ? (xs[t] - m) / sd : 0;
    }
    sum += xs[t];
    sumSq += xs[t] * xs[t];
    n += 1;
  }
  return out;
}

/** Pearson corr ignoring null-aligned pairs. */
export function pearson(a: number[], b: number[]): number {
  const xa: number[] = [];
  const xb: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xa.push(a[i]);
      xb.push(b[i]);
    }
  }
  return corr(xa, xb);
}

export function meanOf(xs: number[]): number {
  return mean(xs);
}
export function stdOf(xs: number[]): number {
  return std(xs);
}

/** Autocorrelation at lag k. */
export function autocorr(xs: number[], lag: number): number {
  const n = xs.length;
  if (lag >= n - 2) return 0;
  const a = xs.slice(0, n - lag);
  const b = xs.slice(lag);
  return corr(a, b);
}

/**
 * Dominant period via a coarse DFT power spectrum over the de-meaned series.
 * Returns the period (in samples) of the largest non-DC spectral peak and its
 * relative power share. Cheap O(n*K) since we only scan candidate periods.
 */
export function dominantPeriod(
  xs: number[],
  minPeriod = 4,
  maxPeriod = 512,
): { period: number; powerShare: number } {
  const n = xs.length;
  if (n < 16) return { period: 0, powerShare: 0 };
  const m = mean(xs);
  const x = xs.map((v) => v - m);
  let totalPower = 0;
  let bestPower = 0;
  let bestPeriod = 0;
  const maxP = Math.min(maxPeriod, Math.floor(n / 2));
  for (let p = minPeriod; p <= maxP; p += 1) {
    const w = (2 * Math.PI) / p;
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t += 1) {
      re += x[t] * Math.cos(w * t);
      im += x[t] * Math.sin(w * t);
    }
    const power = re * re + im * im;
    totalPower += power;
    if (power > bestPower) {
      bestPower = power;
      bestPeriod = p;
    }
  }
  return {
    period: bestPeriod,
    powerShare: totalPower > 0 ? bestPower / totalPower : 0,
  };
}

// ---------------------------------------------------------------------------
// SURROGATE GENERATORS — preserve each asset's marginal/vol/acf but destroy the
// genuine cross-asset / regime structure.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * PHASE-RANDOMIZED surrogate of the return matrix: per asset, take its observed
 * (non-null) return path, FFT-phase-randomize it (preserve power spectrum =>
 * preserve autocorrelation & variance), then re-insert at the same active
 * indices. Cross-asset structure is destroyed because each asset is randomized
 * with INDEPENDENT phases. Rebuilds closes from the surrogate returns.
 */
export function phaseRandomizePanel(panel: Panel, ret: ReturnMatrix, seed: number): Panel {
  const rnd = mulberry32(seed);
  const closes: Record<string, (number | null)[]> = {};
  for (const s of panel.symbols) {
    const r = ret[s];
    const activeIdx: number[] = [];
    const vals: number[] = [];
    for (let t = 0; t < r.length; t += 1) {
      if (r[t] !== null && Number.isFinite(r[t] as number)) {
        activeIdx.push(t);
        vals.push(r[t] as number);
      }
    }
    const surr = phaseRandomizeSeries(vals, rnd);
    // rebuild a close series at the active indices from the original first valid close
    const origCloses = panel.closes[s];
    const firstValid = origCloses.findIndex((x) => x !== null && Number.isFinite(x as number));
    const newCloses: (number | null)[] = new Array(origCloses.length).fill(null);
    if (firstValid >= 0) {
      let px = origCloses[firstValid] as number;
      newCloses[firstValid] = px;
      // surr returns correspond to activeIdx (which start at the first RETURN, i.e. firstValid+? )
      // activeIdx[k] is the day the return applies to; set close[idx] = close[prev]*(1+surr[k])
      for (let k = 0; k < activeIdx.length; k += 1) {
        const idx = activeIdx[k];
        px = px * (1 + surr[k]);
        newCloses[idx] = px;
      }
    }
    closes[s] = newCloses;
  }
  return { ...panel, closes };
}

/** In-place iterative radix-2 Cooley-Tukey FFT. re/im length must be power of 2. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * wRe - im[i + k + len / 2] * wIm;
        const vIm = re[i + k + len / 2] * wIm + im[i + k + len / 2] * wRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Phase-randomize via FFT (zero-padded to the next power of two). Preserves the
 * power spectrum (=> autocorrelation & variance) up to the padding, randomizes
 * phases with conjugate symmetry so the inverse is real. O(n log n).
 */
function phaseRandomizeSeries(x: number[], rnd: () => number): number[] {
  const n = x.length;
  if (n < 8) return x.slice();
  const m = mean(x);
  let N = 1;
  while (N < n) N <<= 1;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < n; i += 1) re[i] = x[i] - m;
  fft(re, im, false);
  // randomize phases, keep magnitudes, conjugate-symmetric for real ifft
  const half = N >> 1;
  for (let k = 1; k < half; k += 1) {
    const mag = Math.hypot(re[k], im[k]);
    const ph = (rnd() * 2 - 1) * Math.PI;
    re[k] = mag * Math.cos(ph);
    im[k] = mag * Math.sin(ph);
    re[N - k] = re[k];
    im[N - k] = -im[k];
  }
  // leave DC (k=0) and Nyquist (k=half) real-valued (phase 0 or pi)
  im[0] = 0;
  if (half < N) im[half] = 0;
  fft(re, im, true);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = re[i];
  // rescale to EXACTLY match the original (de-meaned) variance — the surrogate
  // must preserve each asset's volatility (zero-padding slightly deflates it).
  const origVar = x.reduce((a, v) => a + (v - m) ** 2, 0) / n;
  const surrVar = out.reduce((a, v) => a + v * v, 0) / n;
  const scale = surrVar > 1e-18 ? Math.sqrt(origVar / surrVar) : 1;
  for (let i = 0; i < n; i += 1) out[i] = out[i] * scale + m;
  return out;
}

/**
 * STATIONARY BLOCK-BOOTSTRAP surrogate: per asset, resample its active return
 * path in random blocks (geometric length) — preserves short-range autocorr &
 * marginal vol, destroys long-range regime/cross-asset timing. Independent per
 * asset.
 */
export function blockBootstrapPanel(
  panel: Panel,
  ret: ReturnMatrix,
  seed: number,
  meanBlock = 20,
): Panel {
  const rnd = mulberry32(seed);
  const closes: Record<string, (number | null)[]> = {};
  for (const s of panel.symbols) {
    const r = ret[s];
    const activeIdx: number[] = [];
    const vals: number[] = [];
    for (let t = 0; t < r.length; t += 1) {
      if (r[t] !== null && Number.isFinite(r[t] as number)) {
        activeIdx.push(t);
        vals.push(r[t] as number);
      }
    }
    const surr = stationaryBootstrap(vals, rnd, meanBlock);
    const origCloses = panel.closes[s];
    const firstValid = origCloses.findIndex((x) => x !== null && Number.isFinite(x as number));
    const newCloses: (number | null)[] = new Array(origCloses.length).fill(null);
    if (firstValid >= 0) {
      let px = origCloses[firstValid] as number;
      newCloses[firstValid] = px;
      for (let k = 0; k < activeIdx.length; k += 1) {
        px = px * (1 + surr[k]);
        newCloses[activeIdx[k]] = px;
      }
    }
    closes[s] = newCloses;
  }
  return { ...panel, closes };
}

function stationaryBootstrap(x: number[], rnd: () => number, meanBlock: number): number[] {
  const n = x.length;
  if (n < 4) return x.slice();
  const p = 1 / Math.max(2, meanBlock);
  const out: number[] = [];
  let i = Math.floor(rnd() * n);
  while (out.length < n) {
    out.push(x[i % n]);
    if (rnd() < p) {
      i = Math.floor(rnd() * n);
    } else {
      i += 1;
    }
  }
  return out.slice(0, n);
}

/**
 * CROSS-SECTIONALLY-SHUFFLED null: at each day, PERMUTE which asset is assigned
 * which return (a random permutation of the cross-section). This destroys real
 * lead-lag / rotation / breadth structure while EXACTLY preserving the
 * cross-sectional marginal distribution each day (so dispersion's marginal and
 * the aggregate market return are untouched). The genuine *identity* link
 * across time (asset persistence) is broken. Rebuilds closes.
 */
export function crossSectionalShufflePanel(panel: Panel, ret: ReturnMatrix, seed: number): Panel {
  const rnd = mulberry32(seed);
  const T = panel.dates.length;
  const syms = panel.symbols;
  // new return matrix
  const newRet: Record<string, (number | null)[]> = {};
  for (const s of syms) newRet[s] = new Array(T).fill(null);

  for (let t = 0; t < T; t += 1) {
    // active assets this day
    const active: string[] = [];
    const vals: number[] = [];
    for (const s of syms) {
      const v = ret[s][t];
      if (v !== null && Number.isFinite(v as number)) {
        active.push(s);
        vals.push(v as number);
      }
    }
    // Fisher-Yates permute vals among active assets
    const perm = vals.slice();
    for (let i = perm.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    for (let i = 0; i < active.length; i += 1) {
      newRet[active[i]][t] = perm[i];
    }
  }

  // rebuild closes from newRet, keeping each asset's original first valid close & active span
  const closes: Record<string, (number | null)[]> = {};
  for (const s of syms) {
    const origCloses = panel.closes[s];
    const firstValid = origCloses.findIndex((x) => x !== null && Number.isFinite(x as number));
    const newCloses: (number | null)[] = new Array(T).fill(null);
    if (firstValid >= 0) {
      let px = origCloses[firstValid] as number;
      newCloses[firstValid] = px;
      for (let t = firstValid + 1; t < T; t += 1) {
        const rr = newRet[s][t];
        if (rr === null || !Number.isFinite(rr as number)) {
          // gap: carry forward but keep null marker so it stays inactive
          newCloses[t] = null;
          continue;
        }
        px = px * (1 + (rr as number));
        newCloses[t] = px;
      }
    }
    closes[s] = newCloses;
  }
  // NOTE: volumes are kept as-is (the shuffle targets return/regime structure).
  return { ...panel, closes };
}
