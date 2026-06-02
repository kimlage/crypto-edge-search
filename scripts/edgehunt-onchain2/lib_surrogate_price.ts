/**
 * Surrogate PRICE-PATH generators for the Mayer (price-transform) null.
 *
 * The Mayer Multiple is DETERMINISTIC in price, so phase-randomizing the Mayer series alone is a
 * weak null (it scrambles a derived series). The CORRECT, documented null for a price-transform
 * overlay is a SURROGATE-RECOMPUTE null: build a surrogate PRICE PATH that preserves the return
 * series' marginal distribution + power spectrum (autocorrelation/vol/spectrum-preserving), then
 * RECOMPUTE the Mayer Multiple on that surrogate path and run the IDENTICAL strategy. If the net
 * Sharpe is reproduced on spectrum-matched random walks, the "edge" is pure path/beta/momentum of a
 * rising asset, not a real Mayer-timing signal.
 *
 * Two surrogate families:
 *   - phaseSurrogateReturns: Fourier phase-randomization of the log-return series (preserves the
 *     power spectrum exactly => same autocorrelation & volatility clustering, Gaussianized margins).
 *   - iaaftSurrogateReturns: iterative amplitude-adjusted FT (Schreiber-Schmitz 1996) — preserves
 *     BOTH the power spectrum AND the exact return amplitude distribution (fat tails). Strongest.
 * Each returns a PRICE path price[0]*exp(cumsum(surrogate returns)), same length, same start price.
 */

function fft(re: number[], im: number[], inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) re[i] /= n;
}

// phase-randomize a finite real series; returns same-length surrogate (mean restored)
function phaseRand(vals: number[], rng: () => number): number[] {
  const m = vals.length;
  let n = 1; while (n < m) n <<= 1;
  const mu = vals.reduce((s, v) => s + v, 0) / m;
  const re = new Array(n).fill(0), im = new Array(n).fill(0);
  for (let i = 0; i < m; i++) re[i] = vals[i] - mu;
  fft(re, im, false);
  const half = n / 2;
  for (let k = 1; k < half; k++) {
    const mag = Math.hypot(re[k], im[k]);
    const ph = 2 * Math.PI * rng();
    re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph);
    re[n - k] = re[k]; im[n - k] = -im[k];
  }
  im[0] = 0; if (half < n) im[half] = 0;
  fft(re, im, true);
  const out = new Array(m); for (let i = 0; i < m; i++) out[i] = re[i] + mu;
  return out;
}

function cumPrice(ret: number[], startIdxFinite: number, price0: number, fullLen: number, firstFiniteIdx: number): number[] {
  // place surrogate returns back into a full-length price path: prices before firstFiniteIdx keep
  // original (warmup), from firstFiniteIdx onward we cumulate surrogate returns from price0.
  const out = new Array(fullLen).fill(NaN);
  let p = price0; out[firstFiniteIdx] = p;
  let j = 0;
  for (let i = firstFiniteIdx + 1; i < fullLen; i++) { p = p * Math.exp(ret[j++]); out[i] = p; }
  return out;
}

/** Phase-randomized price path (spectrum/vol-preserving). origPrice has NaN warmups allowed. */
export function phaseSurrogatePrice(origPrice: number[], rng: () => number): number[] {
  // build log returns over the finite contiguous span
  let first = 0; while (first < origPrice.length && !(origPrice[first] > 0)) first++;
  const rets: number[] = [];
  for (let i = first + 1; i < origPrice.length; i++) rets.push(Math.log(origPrice[i] / origPrice[i - 1]));
  if (rets.length < 16) return origPrice.slice();
  const sur = phaseRand(rets, rng).slice(0, rets.length);
  return cumPrice(sur, 0, origPrice[first], origPrice.length, first);
}

/** IAAFT surrogate price path: preserves spectrum AND exact return-amplitude distribution. */
export function iaaftSurrogatePrice(origPrice: number[], rng: () => number, iters = 60): number[] {
  let first = 0; while (first < origPrice.length && !(origPrice[first] > 0)) first++;
  const rets: number[] = [];
  for (let i = first + 1; i < origPrice.length; i++) rets.push(Math.log(origPrice[i] / origPrice[i - 1]));
  const m = rets.length;
  if (m < 16) return origPrice.slice();
  // target amplitude spectrum
  let n = 1; while (n < m) n <<= 1;
  const mu = rets.reduce((s, v) => s + v, 0) / m;
  const re0 = new Array(n).fill(0), im0 = new Array(n).fill(0);
  for (let i = 0; i < m; i++) re0[i] = rets[i] - mu;
  fft(re0, im0, false);
  const targAmp = new Array(n); for (let k = 0; k < n; k++) targAmp[k] = Math.hypot(re0[k], im0[k]);
  const sortedVals = [...rets].sort((a, b) => a - b);
  // start from a random shuffle of the returns
  let cur = [...rets];
  for (let i = cur.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cur[i], cur[j]] = [cur[j], cur[i]]; }
  for (let it = 0; it < iters; it++) {
    // impose spectrum
    const re = new Array(n).fill(0), im = new Array(n).fill(0);
    for (let i = 0; i < m; i++) re[i] = cur[i] - mu;
    fft(re, im, false);
    for (let k = 0; k < n; k++) { const a = Math.hypot(re[k], im[k]) || 1e-12; const s = targAmp[k] / a; re[k] *= s; im[k] *= s; }
    fft(re, im, true);
    const phased = new Array(m); for (let i = 0; i < m; i++) phased[i] = re[i] + mu;
    // impose amplitude distribution (rank-remap to sortedVals)
    const order = phased.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const next = new Array(m);
    for (let r = 0; r < m; r++) next[order[r][1]] = sortedVals[r];
    cur = next;
  }
  return cumPrice(cur, 0, origPrice[first], origPrice.length, first);
}
