/**
 * Signal helpers shared across D5 strategies: phase-randomization surrogate of a real-valued
 * causal feature series, and a generic threshold/band -> position mapper.
 *
 * The RIGHT surrogate null here is TIME-SERIES phase randomization (Theiler 1992): take the
 * feature series, randomize its Fourier phases (preserve power spectrum / autocorrelation / vol,
 * destroy the *timing* of its crossings relative to the price path), then rebuild positions on the
 * SAME real price path. If the strategy's net Sharpe is reproduced by these phase-scrambled
 * features, the "edge" was the price path / long-beta, not the on-chain signal's timing.
 * crossSectional:false (single-asset timing), as required.
 */

// FFT via radix-2 (pad to power of two). Returns surrogate with randomized phases, same spectrum.
function fft(re: number[], im: number[], inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1,
        cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k],
          ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) re[i] /= n;
}

/**
 * Phase-randomize a real series over its finite span. NaNs are passed through unchanged at their
 * positions; only finite values are surrogated (so warmups/gaps keep their structure).
 */
export function phaseRandomize(x: number[], rng: () => number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i])) idx.push(i);
  const m = idx.length;
  if (m < 8) return x.slice();
  // pad to power of two
  let n = 1;
  while (n < m) n <<= 1;
  const vals = idx.map((i) => x[i]);
  const mu = vals.reduce((s, v) => s + v, 0) / m;
  const re = new Array(n).fill(0);
  const im = new Array(n).fill(0);
  for (let i = 0; i < m; i++) re[i] = vals[i] - mu;
  fft(re, im, false);
  // randomize phases, keep magnitudes; preserve conjugate symmetry for a real output
  const half = n / 2;
  for (let k = 1; k < half; k++) {
    const mag = Math.hypot(re[k], im[k]);
    const ph = 2 * Math.PI * rng();
    re[k] = mag * Math.cos(ph);
    im[k] = mag * Math.sin(ph);
    re[n - k] = re[k];
    im[n - k] = -im[k];
  }
  // k=0 and k=half stay real
  im[0] = 0;
  if (half < n) im[half] = 0;
  fft(re, im, true);
  const out = x.slice();
  for (let i = 0; i < m; i++) out[idx[i]] = re[i] + mu;
  return out;
}
