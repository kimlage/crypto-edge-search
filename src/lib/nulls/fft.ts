/**
 * Minimal real-input DFT / inverse-DFT used by the IAAFT surrogate.
 *
 * The validation harness keeps its own FFT private (`dft`/`idft` in
 * ../validation/strategy-validator are not exported), so the nulls library carries
 * a small, self-contained O(n log n) transform here rather than reaching into a
 * module-private symbol. This is numerics, not a null generator — the approved
 * surrogate generators (`phaseRandomize`, `blockBootstrap`, the cross-sectional
 * shuffle) are still imported, never reimplemented.
 *
 * `fft` is radix-2 Cooley-Tukey for power-of-2 lengths and Bluestein's chirp-z
 * transform for arbitrary lengths, so any return-window length stays O(n log n).
 * Pure and deterministic.
 */

/** Forward DFT of a real series. Returns the full length-n complex spectrum. */
export function dft(x: readonly number[]): { re: number[]; im: number[] } {
  const n = x.length;
  return fft(Float64Array.from(x), new Float64Array(n), false);
}

/** Inverse DFT, O(n log n), with the 1/n normalization applied here. */
export function idft(re: readonly number[], im: readonly number[]): number[] {
  const n = re.length;
  if (n === 0) return [];
  const out = fft(Float64Array.from(re), Float64Array.from(im), true);
  return Array.from(out.re, (v) => v / n);
}

function fft(re: Float64Array, im: Float64Array, inverse: boolean): { re: number[]; im: number[] } {
  const n = re.length;
  if (n === 0) return { re: [], im: [] };
  if (n === 1) return { re: [re[0]!], im: [im[0]!] };
  if ((n & (n - 1)) === 0) {
    fftRadix2(re, im, inverse);
    return { re: Array.from(re), im: Array.from(im) };
  }
  return fftBluestein(re, im, inverse);
}

/** Radix-2 Cooley-Tukey FFT, in place. Requires n to be a power of two. */
function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wReStep = Math.cos(ang);
    const wImStep = Math.sin(ang);
    for (let start = 0; start < n; start += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const tRe = re[b]! * wRe - im[b]! * wIm;
        const tIm = re[b]! * wIm + im[b]! * wRe;
        re[b] = re[a]! - tRe;
        im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe;
        im[a] = im[a]! + tIm;
        const nextWRe = wRe * wReStep - wIm * wImStep;
        wIm = wRe * wImStep + wIm * wReStep;
        wRe = nextWRe;
      }
    }
  }
}

/** Bluestein's chirp-z transform for arbitrary length n; keeps the DFT O(n log n). */
function fftBluestein(re: Float64Array, im: Float64Array, inverse: boolean): { re: number[]; im: number[] } {
  const n = re.length;
  const sign = inverse ? 1 : -1;
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const j = (k * k) % (2 * n);
    const ang = (sign * Math.PI * j) / n;
    cosT[k] = Math.cos(ang);
    sinT[k] = Math.sin(ang);
  }

  let m = 1;
  while (m < 2 * n - 1) m <<= 1;

  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  for (let k = 0; k < n; k += 1) {
    aRe[k] = re[k]! * cosT[k]! - im[k]! * sinT[k]!;
    aIm[k] = re[k]! * sinT[k]! + im[k]! * cosT[k]!;
  }

  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);
  bRe[0] = cosT[0]!;
  bIm[0] = -sinT[0]!;
  for (let k = 1; k < n; k += 1) {
    bRe[k] = cosT[k]!;
    bIm[k] = -sinT[k]!;
    bRe[m - k] = cosT[k]!;
    bIm[m - k] = -sinT[k]!;
  }

  fftRadix2(aRe, aIm, false);
  fftRadix2(bRe, bIm, false);
  for (let k = 0; k < m; k += 1) {
    const cr = aRe[k]! * bRe[k]! - aIm[k]! * bIm[k]!;
    const ci = aRe[k]! * bIm[k]! + aIm[k]! * bRe[k]!;
    aRe[k] = cr;
    aIm[k] = ci;
  }
  fftRadix2(aRe, aIm, true);
  for (let k = 0; k < m; k += 1) {
    aRe[k] = aRe[k]! / m;
    aIm[k] = aIm[k]! / m;
  }

  const outRe = new Array<number>(n);
  const outIm = new Array<number>(n);
  for (let k = 0; k < n; k += 1) {
    outRe[k] = aRe[k]! * cosT[k]! - aIm[k]! * sinT[k]!;
    outIm[k] = aRe[k]! * sinT[k]! + aIm[k]! * cosT[k]!;
  }
  return { re: outRe, im: outIm };
}
