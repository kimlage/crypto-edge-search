/**
 * TRACK WF-C — Adaptive walk-forward on 15m BTC + SURROGATE/PLACEBO control.
 *
 * Shared library: data loading, intraday indicators, a STRICTLY CAUSAL
 * walk-forward re-optimization engine, surrogate generators (phase-randomized
 * + block-bootstrap), and the honest benchmarks.
 *
 * Causality contract (the #1 walk-forward bug we refuse to commit):
 *   At each re-opt step t, the param is chosen using ONLY bars[< t]. The chosen
 *   param then trades the OOS slice [t, t+h). The position at bar i is decided
 *   from the indicator computed on bars[<= i-1] (signal known at close of i-1),
 *   and earns the close-to-close return of bar i. No future bar ever touches a
 *   decision that earns its own return.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface Bar {
  time: number; // epoch ms
  close: number;
}

/** Load 15m BTC closes from the NDJSON export, sorted ascending, deduped, finite. */
export function loadBars(path: string): Bar[] {
  const text = readFileSync(path, "utf8");
  const out: Bar[] = [];
  let prevTime = -Infinity;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: { event_time?: string; close?: number };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const close = Number(row.close);
    const time = row.event_time ? Date.parse(row.event_time) : NaN;
    if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(time)) continue;
    if (time <= prevTime) continue; // strictly ascending; drop dupes/out-of-order
    out.push({ time, close });
    prevTime = time;
  }
  return out;
}

/** Close-to-close simple returns r[i] = close[i]/close[i-1] - 1. Length N-1. */
export function toReturns(bars: readonly Bar[]): number[] {
  const r = new Array<number>(Math.max(0, bars.length - 1));
  for (let i = 1; i < bars.length; i += 1) {
    r[i - 1] = bars[i].close / bars[i - 1].close - 1;
  }
  return r;
}

// ---------------------------------------------------------------------------
// Indicator families. Each produces a per-bar target position in {-1, 0, +1}
// from a parameter, using ONLY past+current closes for the signal at bar i,
// which is then applied to the NEXT bar's return (handled by the engine, which
// lags positions by one bar). We expose a `positions(closes, param)` that
// returns the *desired position to hold INTO bar i+1*, decided at close of i.
// ---------------------------------------------------------------------------

export type Family = "donchian" | "bollinger" | "rsi";

export interface ParamSpec {
  family: Family;
  /** Human label. */
  label: string;
  /** The integer/real knob (lookback window or RSI period). */
  param: number;
}

/** The candidate parameter grid per family (the indicator's own knob). */
export function paramGrid(family: Family): number[] {
  if (family === "donchian") {
    // Donchian channel breakout lookbacks (bars). 15m: 16..192 bars = 4h..2d.
    return [16, 24, 32, 48, 64, 96, 128, 192];
  }
  if (family === "bollinger") {
    // Bollinger breakout lookbacks (bars) with fixed 2-sigma band.
    return [16, 24, 32, 48, 64, 96, 128, 192];
  }
  // rsi periods (bars).
  return [8, 12, 16, 24, 32, 48, 64, 96];
}

/**
 * Desired position held INTO bar i+1, decided at the close of bar i, using only
 * closes[0..i]. Returns an array `pos` of length closes.length where pos[i] is
 * the position to hold during bar i+1's return. pos[i] for i without enough
 * lookback is 0 (flat). The engine lags by applying pos[i] to return of i+1.
 *
 * Donchian breakout: long if close breaks above the highest close of the prior
 * `p` bars; short if it breaks below the lowest; else hold previous state
 * (classic breakout regime-follower with stateful persistence).
 */
export function donchianPositions(closes: readonly number[], p: number): Int8Array {
  const n = closes.length;
  const pos = new Int8Array(n);
  let state = 0;
  for (let i = 0; i < n; i += 1) {
    if (i < p) {
      pos[i] = 0;
      continue;
    }
    // highest/lowest of the PRIOR p closes (exclude current to avoid lookahead
    // on the breakout level itself; current close is compared against them).
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - p; k < i; k += 1) {
      const c = closes[k];
      if (c > hi) hi = c;
      if (c < lo) lo = c;
    }
    const c = closes[i];
    if (c > hi) state = 1;
    else if (c < lo) state = -1;
    // else: keep prior state (persist the breakout regime)
    pos[i] = state as -1 | 0 | 1;
  }
  return pos;
}

/**
 * Bollinger breakout: rolling mean/std of prior `p` closes (2-sigma). Long when
 * close > upper band, short when close < lower band, persist otherwise. Same
 * trend-following polarity as Donchian (breakout = continuation).
 */
export function bollingerPositions(closes: readonly number[], p: number): Int8Array {
  const n = closes.length;
  const pos = new Int8Array(n);
  let state = 0;
  const k = 2; // sigma multiplier
  for (let i = 0; i < n; i += 1) {
    if (i < p) {
      pos[i] = 0;
      continue;
    }
    let sum = 0;
    let sumsq = 0;
    for (let j = i - p; j < i; j += 1) {
      const c = closes[j];
      sum += c;
      sumsq += c * c;
    }
    const mean = sum / p;
    const variance = Math.max(0, sumsq / p - mean * mean);
    const sd = Math.sqrt(variance);
    const c = closes[i];
    const upper = mean + k * sd;
    const lower = mean - k * sd;
    if (c > upper) state = 1;
    else if (c < lower) state = -1;
    pos[i] = state as -1 | 0 | 1;
  }
  return pos;
}

/**
 * RSI mean-reversion: Wilder RSI over `p` bars. Long when RSI < 30 (oversold),
 * short when RSI > 70 (overbought), flat in the neutral zone. This is a
 * mean-reverter (opposite polarity to the breakout families) — deliberately, so
 * the family set spans both trend and reversion.
 */
export function rsiPositions(closes: readonly number[], p: number): Int8Array {
  const n = closes.length;
  const pos = new Int8Array(n);
  if (n < p + 1) return pos;
  // Wilder smoothing
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= p; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= p;
  avgLoss /= p;
  for (let i = p + 1; i < n; i += 1) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    const rs = avgLoss <= 1e-12 ? Infinity : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    // decision at close of i, held into i+1
    if (rsi < 30) pos[i] = 1;
    else if (rsi > 70) pos[i] = -1;
    else pos[i] = 0;
  }
  return pos;
}

export function positionsFor(
  family: Family,
  closes: readonly number[],
  param: number,
): Int8Array {
  if (family === "donchian") return donchianPositions(closes, param);
  if (family === "bollinger") return bollingerPositions(closes, param);
  return rsiPositions(closes, param);
}

// ---------------------------------------------------------------------------
// Range-limited, rolling-efficient evaluators. These compute the net per-bar
// strategy returns over a TRADE range [tradeStart, tradeEnd) without touching
// the rest of the (huge) series, using O(1)-amortized rolling window stats.
//
// To set the stateful breakout position correctly at tradeStart, we warm up the
// indicator state from `param` bars before tradeStart (so the persisted state
// and the prior-bar position used for the first cost are correct). The warmup
// bars are NOT counted in the returned returns. This is exactly equivalent to
// computing positionsFor over the whole series and slicing, but local & fast.
//
// `posAt(i)` = position decided at close of bar i (held into bar i+1). The net
// return at bar i is posAt(i-1) * (close[i]/close[i-1]-1) - cost*|posAt(i-1)-posAt(i-2)|.
// We accumulate net returns for i in [tradeStart, tradeEnd).
// ---------------------------------------------------------------------------

export interface WindowEval {
  netReturns: number[];
  grossReturns: number[];
  turnoverUnits: number;
  changeEvents: number;
  /** running sums for fast Sharpe without materializing arrays when not needed */
  sum: number;
  sumsq: number;
  count: number;
}

/**
 * Compute net per-bar returns over [tradeStart, tradeEnd) for a given family/param.
 * `collectArrays` controls whether the per-bar arrays are materialized (needed for
 * the OOS path concatenation) or only the running Sharpe sums (fast scoring).
 */
export function evalWindow(
  family: Family,
  closes: readonly number[],
  param: number,
  tradeStart: number,
  tradeEnd: number,
  costPerSide: number,
  collectArrays: boolean,
): WindowEval {
  const netReturns: number[] = collectArrays ? [] : [];
  const grossReturns: number[] = collectArrays ? [] : [];
  let turnoverUnits = 0;
  let changeEvents = 0;
  let sum = 0;
  let sumsq = 0;
  let count = 0;

  // We need posAt(i) for i in [tradeStart-2, tradeEnd-1]. Warm up the indicator
  // from warmupStart so the persisted/rolling state at posStart is correct.
  const posStart = Math.max(0, tradeStart - 2);
  // generate positions on [warmupStart, tradeEnd) but only read from posStart.
  const positions = computePositionsRange(family, closes, param, posStart, tradeEnd);
  // positions is indexed relative to posStart: positions[j] = posAt(posStart+j).

  const posAt = (i: number): number => {
    const j = i - posStart;
    if (j < 0 || j >= positions.length) return 0;
    return positions[j];
  };

  for (let i = tradeStart; i < tradeEnd; i += 1) {
    if (i < 1) continue;
    const r = closes[i] / closes[i - 1] - 1;
    const held = posAt(i - 1);
    const gross = held * r;
    const prevHeld = posAt(i - 2);
    const delta = Math.abs(held - prevHeld);
    const cost = delta * costPerSide;
    const net = gross - cost;
    if (delta > 0) {
      turnoverUnits += delta;
      changeEvents += 1;
    }
    sum += net;
    sumsq += net * net;
    count += 1;
    if (collectArrays) {
      netReturns.push(net);
      grossReturns.push(gross);
    }
  }
  return { netReturns, grossReturns, turnoverUnits, changeEvents, sum, sumsq, count };
}

/**
 * Positions over [from, to), warmed up from `from` (which the caller sets to
 * include `param` bars of lookback before the first bar it will read). Returns
 * an Int8Array indexed relative to `from`. Uses rolling window stats:
 *  - Donchian: monotonic deques for rolling max/min of the prior p closes.
 *  - Bollinger: rolling sum & sum-of-squares.
 *  - RSI: Wilder smoothing seeded from `from`.
 * To make the stateful breakout state correct at `from`, we actually start the
 * computation `param` bars earlier (warmStart) and discard the warmup prefix.
 */
function computePositionsRange(
  family: Family,
  closes: readonly number[],
  p: number,
  from: number,
  to: number,
): Int8Array {
  // Breakout state PERSISTS until the next breakout, so the position at `from`
  // depends on history before it. We warm up generously (>= a few hundred bars
  // or several lookbacks) so the persisted state is set by the most recent real
  // breakout, not an arbitrary flat seed. Wilder RSI is a recursive smoother;
  // warm it long enough that the seed bias decays away.
  const warm =
    family === "rsi" ? Math.max(6 * p + 2, 200) : Math.max(8 * p, 1500);
  const warmStart = Math.max(0, from - warm);
  const len = to - warmStart;
  const buf = new Int8Array(Math.max(0, len));
  if (len <= 0) return new Int8Array(0);

  if (family === "rsi") {
    rsiRange(closes, p, warmStart, to, buf);
  } else if (family === "donchian") {
    donchianRange(closes, p, warmStart, to, buf);
  } else {
    bollingerRange(closes, p, warmStart, to, buf);
  }
  // slice off warmup so result is indexed relative to `from`
  const offset = from - warmStart;
  return buf.subarray(offset, offset + (to - from));
}

function donchianRange(
  closes: readonly number[],
  p: number,
  warmStart: number,
  to: number,
  buf: Int8Array,
): void {
  // Use a monotonic-deque rolling max/min over the PRIOR p closes window [i-p, i).
  // Identical semantics to the global donchianPositions but computed locally. For
  // i < p (only possible when warmStart==0) the position stays flat.
  const maxDq: number[] = []; // indexes, closes decreasing front->back
  const minDq: number[] = []; // indexes, closes increasing front->back
  let state = 0;
  // Seed the deque with the window that will be valid at the first scored i.
  for (let i = warmStart; i < to; i += 1) {
    const bi = i - warmStart;
    const addIdx = i - 1; // the bar that just entered the prior-window for this i
    if (addIdx >= 0) {
      while (maxDq.length && closes[maxDq[maxDq.length - 1]] <= closes[addIdx]) maxDq.pop();
      maxDq.push(addIdx);
      while (minDq.length && closes[minDq[minDq.length - 1]] >= closes[addIdx]) minDq.pop();
      minDq.push(addIdx);
    }
    const lo = i - p; // window is [i-p, i)
    while (maxDq.length && maxDq[0] < lo) maxDq.shift();
    while (minDq.length && minDq[0] < lo) minDq.shift();

    if (i < p) {
      buf[bi] = state as -1 | 0 | 1;
      continue;
    }
    const hi = closes[maxDq[0]];
    const lowv = closes[minDq[0]];
    const c = closes[i];
    if (c > hi) state = 1;
    else if (c < lowv) state = -1;
    buf[bi] = state as -1 | 0 | 1;
  }
}

function bollingerRange(
  closes: readonly number[],
  p: number,
  warmStart: number,
  to: number,
  buf: Int8Array,
): void {
  const k = 2;
  let sum = 0;
  let sumsq = 0;
  let filled = 0; // number of elements currently in the rolling window
  let state = 0;
  for (let i = warmStart; i < to; i += 1) {
    const bi = i - warmStart;
    // rolling window over [i-p, i): add closes[i-1], drop closes[i-1-p]
    const addIdx = i - 1;
    if (addIdx >= 0) {
      sum += closes[addIdx];
      sumsq += closes[addIdx] * closes[addIdx];
      filled += 1;
    }
    // Only start dropping once the element leaving the window was actually added
    // (i.e. it is >= warmStart-1, the first index we added). This keeps `filled`
    // monotonically rising to p, then steady.
    const dropIdx = i - 1 - p;
    if (dropIdx >= warmStart - 1 && dropIdx >= 0) {
      sum -= closes[dropIdx];
      sumsq -= closes[dropIdx] * closes[dropIdx];
      filled -= 1;
    }
    // need a full window of p elements AND (for series start) i>=p
    if (filled < p || i < p) {
      buf[bi] = state as -1 | 0 | 1;
      continue;
    }
    const mean = sum / p;
    const variance = Math.max(0, sumsq / p - mean * mean);
    const sd = Math.sqrt(variance);
    const c = closes[i];
    if (c > mean + k * sd) state = 1;
    else if (c < mean - k * sd) state = -1;
    buf[bi] = state as -1 | 0 | 1;
  }
}

function rsiRange(
  closes: readonly number[],
  p: number,
  warmStart: number,
  to: number,
  buf: Int8Array,
): void {
  // seed Wilder averages from the first p changes at/after warmStart
  if (warmStart + p + 1 >= to) return;
  let avgGain = 0;
  let avgLoss = 0;
  const seedStart = warmStart;
  for (let i = seedStart + 1; i <= seedStart + p; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= p;
  avgLoss /= p;
  for (let i = seedStart + p + 1; i < to; i += 1) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    const rs = avgLoss <= 1e-12 ? Infinity : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    const bi = i - warmStart;
    if (rsi < 30) buf[bi] = 1;
    else if (rsi > 70) buf[bi] = -1;
    else buf[bi] = 0;
  }
}

// ---------------------------------------------------------------------------
// PnL engine. Given positions decided at close of i (pos[i]) and per-bar returns
// r[i] = close[i]/close[i-1]-1, the strategy return at bar i is pos[i-1]*r[i]
// MINUS cost on any position change |pos[i-1]-pos[i-2]| * costPerSide.
//
// We charge cost when the position we are ABOUT to hold changes, at the bar
// where it changes. costPerSide is one-way (e.g. 4bps). A flip -1->+1 pays 2x.
// ---------------------------------------------------------------------------

export interface StrategyResult {
  /** Net per-bar strategy returns aligned to bars[1..]. */
  netReturns: number[];
  /** Gross (pre-cost) per-bar returns. */
  grossReturns: number[];
  /** Number of position changes (turnover events, counts |delta| in units). */
  turnoverUnits: number;
  /** Number of bars with a nonzero position change. */
  changeEvents: number;
}

/**
 * Run positions against bar returns with one-bar lag and per-side cost.
 *
 * @param closes  full close series (length N)
 * @param pos     pos[i] = position decided at close of bar i, held into bar i+1
 * @param costPerSide one-way taker cost as a fraction (e.g. 0.0004 = 4bps)
 * @param startIdx first bar index whose return we count (inclusive). Returns are
 *                 indexed by bar; we count returns for bars in [startIdx, endIdx).
 * @param endIdx  exclusive upper bar index.
 *
 * The return earned at bar i (for i in [startIdx,endIdx)) is pos[i-1]*r_i where
 * r_i = closes[i]/closes[i-1]-1. Cost is charged at bar i when pos[i-1] differs
 * from pos[i-2] (the position changed going INTO bar i).
 */
export function runStrategy(
  closes: readonly number[],
  pos: Int8Array,
  costPerSide: number,
  startIdx: number,
  endIdx: number,
): StrategyResult {
  const netReturns: number[] = [];
  const grossReturns: number[] = [];
  let turnoverUnits = 0;
  let changeEvents = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    if (i < 1) continue;
    const r = closes[i] / closes[i - 1] - 1;
    const heldPos = pos[i - 1]; // position held during bar i
    const gross = heldPos * r;
    // cost when the held position changed relative to the prior bar's held pos
    const prevHeld = i >= 2 ? pos[i - 2] : 0;
    const delta = Math.abs(heldPos - prevHeld);
    const cost = delta * costPerSide;
    if (delta > 0) {
      turnoverUnits += delta;
      changeEvents += 1;
    }
    grossReturns.push(gross);
    netReturns.push(gross - cost);
  }
  return { netReturns, grossReturns, turnoverUnits, changeEvents };
}

// ---------------------------------------------------------------------------
// In-sample scoring for param selection. We score a param on a trailing window
// by net Sharpe (mean/std of net per-bar returns). STRICTLY uses only the bars
// in [winStart, winEnd) (the trailing in-sample window).
// ---------------------------------------------------------------------------

export function sharpeOf(returns: readonly number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const x of returns) mean += x;
  mean /= n;
  let v = 0;
  for (const x of returns) v += (x - mean) ** 2;
  v /= n - 1;
  const sd = Math.sqrt(v);
  return sd > 1e-12 ? mean / sd : 0;
}

// ---------------------------------------------------------------------------
// Surrogate generators. Both preserve marginal vol; phase-randomization also
// preserves the full autocorrelation (linear) structure while destroying any
// nonlinear/regime structure; block-bootstrap preserves short-range autocorr.
// Surrogates are built on RETURNS, then integrated back to a price path that
// starts at the real starting price, so indicators see a realistic-scale series.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Phase-randomized surrogate of a return series. FFT -> randomize phases (keep
 * magnitudes, i.e. the power spectrum / linear autocorrelation) -> inverse FFT.
 * Preserves mean, variance and the entire linear autocorrelation; destroys
 * higher-order/nonlinear (regime) structure. Naive O(n^2) DFT is too slow for
 * 300k; we use a radix-2 FFT on the largest power of two <= n (truncate tail).
 */
export function phaseRandomizedReturns(returns: readonly number[], seed: number): number[] {
  const n = returns.length;
  // largest power of two <= n
  let m = 1;
  while (m * 2 <= n) m *= 2;
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  const mean = returns.slice(0, m).reduce((s, x) => s + x, 0) / m;
  for (let i = 0; i < m; i += 1) re[i] = returns[i] - mean;
  fft(re, im, false);
  const rng = mulberry32(seed);
  // randomize phases, preserving Hermitian symmetry so the inverse is real
  for (let k = 1; k < m / 2; k += 1) {
    const mag = Math.hypot(re[k], im[k]);
    const phase = 2 * Math.PI * rng();
    const nr = mag * Math.cos(phase);
    const ni = mag * Math.sin(phase);
    re[k] = nr;
    im[k] = ni;
    re[m - k] = nr; // conjugate symmetric
    im[m - k] = -ni;
  }
  // k=0 (DC) stays real; k=m/2 (Nyquist) must stay real
  im[0] = 0;
  if (m % 2 === 0) im[m / 2] = 0;
  fft(re, im, true);
  const out = new Array<number>(m);
  for (let i = 0; i < m; i += 1) out[i] = re[i] + mean;
  return out;
}

/** In-place radix-2 Cooley-Tukey FFT. inverse=true does the IFFT (scaled by 1/n). */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  // bit reversal
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
    const ang = (2 * Math.PI) / len * (inverse ? 1 : -1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const bI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + len / 2] = aR - bR;
        im[i + k + len / 2] = aI - bI;
        const ncurR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = ncurR;
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
 * Stationary/circular block-bootstrap of a return series. Samples contiguous
 * blocks of length `blockLen` (wrapping) and concatenates to length n. Preserves
 * short-range autocorrelation (within-block) and the marginal distribution
 * (hence vol) while destroying long-range regime structure.
 */
export function blockBootstrapReturns(
  returns: readonly number[],
  blockLen: number,
  seed: number,
): number[] {
  const n = returns.length;
  const rng = mulberry32(seed);
  const out = new Array<number>(n);
  let filled = 0;
  while (filled < n) {
    const start = Math.floor(rng() * n);
    for (let k = 0; k < blockLen && filled < n; k += 1) {
      out[filled] = returns[(start + k) % n];
      filled += 1;
    }
  }
  return out;
}

/** Integrate a return series back into a price path starting at `p0`. */
export function pricesFromReturns(returns: readonly number[], p0: number): number[] {
  const out = new Array<number>(returns.length + 1);
  out[0] = p0;
  for (let i = 0; i < returns.length; i += 1) {
    out[i + 1] = out[i] * (1 + returns[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lag-1 autocorrelation helper (for the "does the optimal param drift trackably"
// question) and a generic autocorrelation at arbitrary lag.
// ---------------------------------------------------------------------------

export function autocorr(series: readonly number[], lag: number): number {
  const n = series.length;
  if (n <= lag + 1) return 0;
  let mean = 0;
  for (const x of series) mean += x;
  mean /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const d = series[i] - mean;
    den += d * d;
    if (i >= lag) num += d * (series[i - lag] - mean);
  }
  return den > 1e-12 ? num / den : 0;
}
