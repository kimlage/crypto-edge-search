/** Phase-randomization surrogate (the RIGHT null for a change-point/timing strategy).
 *
 * Phase randomization preserves the power spectrum (=> autocorrelation & vol structure of the
 * series) but destroys genuine structural breaks / change-points and any nonlinear timing
 * predictability. AAFT/amplitude-adjusted variant additionally preserves the return marginal
 * (so vol-clustering of MAGNITUDES is largely retained). On such surrogates a *real* change-point
 * detector should fire at its false-alarm rate and produce NO timing edge.
 */

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
    const wlr = Math.cos(ang);
    const wli = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nwr = wr * wlr - wi * wli;
        wi = wr * wli + wi * wlr;
        wr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Phase-randomized surrogate of x preserving the power spectrum. Returns a same-length series. */
export function phaseRandomize(x: number[], rng: () => number): number[] {
  const n0 = x.length;
  const n = nextPow2(n0);
  const re = new Array(n).fill(0);
  const im = new Array(n).fill(0);
  const mean = x.reduce((s, v) => s + v, 0) / n0;
  for (let i = 0; i < n0; i++) re[i] = x[i] - mean;
  fft(re, im, false);
  // randomize phases, keep magnitudes; preserve conjugate symmetry for real output
  const half = n / 2;
  for (let k = 1; k < half; k++) {
    const mag = Math.hypot(re[k], im[k]);
    const phi = 2 * Math.PI * rng();
    re[k] = mag * Math.cos(phi);
    im[k] = mag * Math.sin(phi);
    re[n - k] = re[k];
    im[n - k] = -im[k];
  }
  // Nyquist & DC stay real
  im[0] = 0;
  if (half < n) im[half] = 0;
  fft(re, im, true);
  const out = new Array(n0);
  for (let i = 0; i < n0; i++) out[i] = re[i] + mean;
  return out;
}

/** Amplitude-adjusted phase randomization (AAFT): preserves the marginal AND ~spectrum. */
export function aaftSurrogate(x: number[], rng: () => number): number[] {
  const n = x.length;
  // sorted copy of original values (the marginal to restore)
  const sortedX = [...x].sort((a, b) => a - b);
  // phase-randomize, then rank-map back onto the original marginal
  const phase = phaseRandomize(x, rng);
  const idx = phase.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n);
  for (let rank = 0; rank < n; rank++) out[idx[rank][1]] = sortedX[rank];
  return out;
}
