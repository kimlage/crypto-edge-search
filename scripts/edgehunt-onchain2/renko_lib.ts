/**
 * O8-RENKO — Renko brick trend transform (price-move-based, time-independent).
 *
 * Loads 15m BTC OHLCV (free Binance via committed bigquery dump). Forms Renko bricks CAUSALLY
 * (a brick is only known/actionable AFTER price crosses the threshold, observed at that bar's
 * close; we attribute the brick-confirmation to the bar where the crossing is observed, never
 * peeking forward). Trend timer: long when last confirmed brick is up, flat when down (long-flat).
 *
 * Bridge to the committed daily gauntlet (scripts/edgehunt-D5/harness.ts):
 *   - We build a DAILY panel (close-to-close) from the 15m bars.
 *   - The Renko position for day t = direction of the most recent brick CONFIRMED at or before the
 *     close of day t (strictly causal). Held over fwdRet[t] = day t -> t+1 (next-day return).
 *
 * Null (vol/spectrum-preserving surrogate-RECOMPUTE): phase-randomize the 15m log-return series
 * (preserves power spectrum => autocorrelation + volatility), rebuild the intraday price path,
 * RE-RENKO-IZE on the surrogate path, and rebuild the daily position. Survives only if real trend
 * timing beats this path/vol-matched placebo.
 */
import fs from "node:fs";

const ROOT = ".";

export interface Bar {
  t: number; // event_time epoch ms (bar OPEN time)
  availMs: number; // available_at epoch ms (when the close is actionable)
  date: string; // event_date (UTC day of the bar)
  open: number;
  high: number;
  low: number;
  close: number;
}

export function loadBars15m(): Bar[] {
  const lines = fs
    .readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`, "utf8")
    .trim()
    .split("\n");
  const out: Bar[] = [];
  for (const l of lines) {
    const r = JSON.parse(l);
    const c = Number(r.close);
    if (!(c > 0)) continue;
    out.push({
      t: Date.parse(r.event_time),
      availMs: Date.parse(r.available_at),
      date: r.event_date,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: c,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ----------------------------------------------------------------- Renko core
//
// Causal Renko on close prices. brickFn(i) returns the (possibly time-varying, strictly-causal)
// brick size in PRICE units applicable at bar i. We use closes only (no high/low peeking) so that
// "a brick formed" is decided exactly when the observed close crosses the threshold — this is the
// honest, look-ahead-free construction. We additionally enforce a `reversal` of >=1 brick to flip
// direction (classic Renko: a 1-brick reversal off the last brick in the same direction; many
// practitioners use 2-brick reversal to reduce whipsaw — exposed as `reversalBricks`).

export interface RenkoState {
  // direction of the last CONFIRMED brick at each input bar i: +1 up, -1 down, 0 none-yet.
  // dirAtBar[i] is known at the CLOSE of bar i (causal).
  dirAtBar: Int8Array;
  nBricksUp: number;
  nBricksDown: number;
}

/**
 * Build causal Renko brick directions over a close series.
 * @param close  close prices, chronological
 * @param brickSize  brick size in PRICE units per bar (length == close.length). Strictly causal
 *                   (computed from info up to & including bar i, e.g. trailing ATR or last anchor*pct).
 * @param reversalBricks  number of bricks against current trend required to flip (>=1).
 */
export function renkoDirections(
  close: number[],
  brickSize: number[],
  reversalBricks = 1,
): RenkoState {
  const n = close.length;
  const dirAtBar = new Int8Array(n);
  let anchor = NaN; // last brick boundary price
  let dir = 0; // current confirmed trend direction
  let nUp = 0,
    nDown = 0;
  for (let i = 0; i < n; i++) {
    const c = close[i];
    const bs = brickSize[i];
    if (!Number.isFinite(c) || !(bs > 0)) {
      dirAtBar[i] = dir as -1 | 0 | 1;
      continue;
    }
    if (!Number.isFinite(anchor)) {
      anchor = c;
      dirAtBar[i] = 0;
      continue;
    }
    // how many bricks in each direction would form from current anchor?
    const upMove = c - anchor;
    const downMove = anchor - c;
    // continuation needs 1 brick; reversal needs `reversalBricks` bricks against trend.
    let moved = false;
    if (dir >= 0) {
      // up or neutral trend: continue up on +1 brick; flip down on `reversalBricks` bricks
      const upBricks = Math.floor(upMove / bs);
      const downBricks = Math.floor(downMove / bs);
      if (upBricks >= 1) {
        anchor += upBricks * bs;
        dir = 1;
        nUp += upBricks;
        moved = true;
      } else if (downBricks >= reversalBricks) {
        anchor -= downBricks * bs;
        dir = -1;
        nDown += downBricks;
        moved = true;
      }
    } else {
      // down trend: continue down on +1 brick; flip up on `reversalBricks` bricks
      const downBricks = Math.floor(downMove / bs);
      const upBricks = Math.floor(upMove / bs);
      if (downBricks >= 1) {
        anchor -= downBricks * bs;
        dir = -1;
        nDown += downBricks;
        moved = true;
      } else if (upBricks >= reversalBricks) {
        anchor += upBricks * bs;
        dir = 1;
        nUp += upBricks;
        moved = true;
      }
    }
    void moved;
    dirAtBar[i] = dir as -1 | 0 | 1;
  }
  return { dirAtBar, nBricksUp: nUp, nBricksDown: nDown };
}

// trailing ATR-style brick size from intraday closes (causal). We use the rolling std of 15m log
// returns * price * k as a vol-adaptive brick, OR a fixed pct of the anchor price.
export function trailingAtrBrick(
  close: number[],
  win: number,
  k: number,
): number[] {
  const n = close.length;
  const ret = new Array(n).fill(0);
  for (let i = 1; i < n; i++) ret[i] = Math.log(close[i] / close[i - 1]);
  const out = new Array(n).fill(NaN);
  // rolling std of returns over `win`
  for (let i = 0; i < n; i++) {
    if (i + 1 < win) continue;
    let s = 0;
    for (let k2 = i - win + 1; k2 <= i; k2++) s += ret[k2];
    const m = s / win;
    let v = 0;
    for (let k2 = i - win + 1; k2 <= i; k2++) v += (ret[k2] - m) ** 2;
    const sd = Math.sqrt(v / (win - 1));
    out[i] = k * sd * close[i]; // brick in price units
  }
  return out;
}

export function fixedPctBrick(close: number[], pct: number): number[] {
  return close.map((c) => (Number.isFinite(c) ? (pct / 100) * c : NaN));
}

// ----------------------------------------------------------------- daily bridge
//
// Build daily close series + the daily Renko position from 15m bars. The position for day t is the
// brick direction CONFIRMED at the last 15m bar of day t whose CLOSE is available_at <= end of day
// t (always true intraday). long-flat: pos = dir > 0 ? 1 : 0.

export interface DailyRenko {
  dates: string[];
  dailyClose: number[];
  fwdRet: number[]; // log return close[t]->close[t+1]; last NaN
  // a function producing the daily long-flat position for a given Renko config, from an arbitrary
  // 15m close path (used for both real and surrogate paths).
}

export function dailyCloseFrom15m(bars: Bar[]): { dates: string[]; idxLastBarOfDay: number[] } {
  // group by event_date, take the index of the last bar of each day.
  const dates: string[] = [];
  const idxLast: number[] = [];
  let cur = "";
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date !== cur) {
      if (cur !== "") {
        // close out previous day's last index already tracked
      }
      cur = bars[i].date;
      dates.push(cur);
      idxLast.push(i);
    } else {
      idxLast[idxLast.length - 1] = i;
    }
  }
  return { dates, idxLastBarOfDay: idxLast };
}

// phase-randomize a real-valued series preserving its power spectrum (=> autocorrelation & vol).
// FFT via direct DFT is too slow for 300k; use the standard surrogate trick on log-returns with a
// radix-2 FFT. We implement an iterative in-place FFT.
export function phaseRandomize(x: number[], rng: () => number): number[] {
  const n = x.length;
  // next pow2
  let m = 1;
  while (m < n) m <<= 1;
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  for (let i = 0; i < n; i++) re[i] = x[i];
  fft(re, im, false);
  // randomize phases (keep magnitudes); preserve conjugate symmetry for a real output.
  const half = m >> 1;
  const phase = new Float64Array(m);
  for (let k = 1; k < half; k++) {
    const ph = (rng() * 2 - 1) * Math.PI;
    phase[k] = ph;
    phase[m - k] = -ph;
  }
  // DC (k=0) and Nyquist (k=half) phases left as 0 (real).
  for (let k = 0; k < m; k++) {
    const mag = Math.hypot(re[k], im[k]);
    re[k] = mag * Math.cos(phase[k]);
    im[k] = mag * Math.sin(phase[k]);
  }
  fft(re, im, true);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i];
  // vol-preserving correction: pow2 zero-padding dilutes realized variance, so rescale the
  // surrogate to EXACTLY match the input series' mean & std (preserves vol by construction).
  const mIn = x.reduce((s, v) => s + v, 0) / n;
  const sIn = Math.sqrt(x.reduce((s, v) => s + (v - mIn) ** 2, 0) / Math.max(1, n - 1));
  const mOut = out.reduce((s, v) => s + v, 0) / n;
  const sOut = Math.sqrt(out.reduce((s, v) => s + (v - mOut) ** 2, 0) / Math.max(1, n - 1));
  const scale = sOut > 1e-15 ? sIn / sOut : 1;
  for (let i = 0; i < n; i++) out[i] = (out[i] - mOut) * scale + mIn;
  return out;
}

// iterative radix-2 Cooley-Tukey FFT (in place). inverse=true does the inverse (scaled by 1/m).
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
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
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + (len >> 1)] * cwr - im[i + k + (len >> 1)] * cwi;
        const vi = re[i + k + (len >> 1)] * cwi + im[i + k + (len >> 1)] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + (len >> 1)] = ur - vr;
        im[i + k + (len >> 1)] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

// reconstruct a price path from a (phase-randomized) log-return series, anchored at p0.
export function pathFromLogRets(p0: number, logRets: number[]): number[] {
  const out = new Array(logRets.length + 1);
  out[0] = p0;
  for (let i = 0; i < logRets.length; i++) out[i + 1] = out[i] * Math.exp(logRets[i]);
  return out;
}
