/**
 * TRACK NF2 — Target + Stop-Loss / professional BRACKET strategies engine.
 *
 * PATH-DEPENDENT intrabar TP/SL simulation. Unlike prior tracks (position ×
 * next-return, no path-dependent exits), this walks the HIGH/LOW path of each
 * 15m bar after entry and resolves which bracket level (target, stop, trail) is
 * touched first. The OUTPUT is a PER-TRADE net return series (one element per
 * resolved trade), which is fed to the committed gates as the return series.
 *
 * Conservative tie-break: when BOTH the target and the stop fall inside the same
 * bar's [low, high], we assume the STOP fires first (worst case for the trader).
 * This is the honest, anti-optimistic convention for path-dependent backtests.
 *
 * Pure, deterministic given a seed. No network, no committed-file edits. Only the
 * NDJSON loader does I/O.
 */

import { readFileSync } from "node:fs";

export interface Bar {
  t: number; // epoch ms (event_time)
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Load the 15m BTC OHLCV NDJSON into an ordered Bar[] (oldest → newest). */
export function loadBars(path: string): Bar[] {
  const text = readFileSync(path, "utf8");
  const bars: Bar[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as {
      event_time: string;
      open: number;
      high: number;
      low: number;
      close: number;
    };
    const o = +r.open;
    const h = +r.high;
    const l = +r.low;
    const c = +r.close;
    if (![o, h, l, c].every(Number.isFinite)) continue;
    bars.push({ t: Date.parse(r.event_time), open: o, high: h, low: l, close: c });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

// ---------------------------------------------------------------------------
// Seeded RNG (same mulberry32 family the committed gates use)
// ---------------------------------------------------------------------------
export function seeded(seed: number | string): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
/** Box-Muller standard normal from a uniform RNG. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Entry signals — produce a list of entry bar indexes + direction (+1 long / -1 short)
// ---------------------------------------------------------------------------
export interface Entry {
  i: number; // entry bar index (we enter at bars[i].close, signal known at close of i)
  dir: 1 | -1;
}

/**
 * Momentum / breakout entry: go LONG when close breaks above the rolling
 * `lookback`-bar high (Donchian breakout); go SHORT when it breaks below the
 * rolling low. Signals are evaluated at bar close and acted on the same close
 * (the standard breakout convention; the exit walk starts at the NEXT bar so no
 * look-ahead on the path). Non-overlapping: once a trade opens, no new entry is
 * generated until the engine reports the exit (handled by the runner).
 */
export function breakoutEntries(bars: Bar[], lookback: number): Entry[] {
  const entries: Entry[] = [];
  for (let i = lookback; i < bars.length - 1; i += 1) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - lookback; j < i; j += 1) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    const c = bars[i].close;
    if (c > hh) entries.push({ i, dir: 1 });
    else if (c < ll) entries.push({ i, dir: -1 });
  }
  return entries;
}

/**
 * Random entry: at each eligible bar, with probability `rate`, open a trade with a
 * random direction. Same density knob as the signal so the comparison is fair.
 */
export function randomEntries(bars: Bar[], rate: number, rng: () => number): Entry[] {
  const entries: Entry[] = [];
  for (let i = 1; i < bars.length - 1; i += 1) {
    if (rng() < rate) entries.push({ i, dir: rng() < 0.5 ? 1 : -1 });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ATR helper (Wilder true range, simple rolling mean over `n`)
// ---------------------------------------------------------------------------
export function atrAt(bars: Bar[], i: number, n: number): number {
  if (i < 1) return bars[i].high - bars[i].low;
  let sum = 0;
  let cnt = 0;
  for (let j = Math.max(1, i - n + 1); j <= i; j += 1) {
    const tr = Math.max(
      bars[j].high - bars[j].low,
      Math.abs(bars[j].high - bars[j - 1].close),
      Math.abs(bars[j].low - bars[j - 1].close),
    );
    sum += tr;
    cnt += 1;
  }
  return cnt > 0 ? sum / cnt : bars[i].high - bars[i].low;
}

// ---------------------------------------------------------------------------
// Bracket definitions
// ---------------------------------------------------------------------------
export type BracketKind =
  | { type: "fixed_rr"; stopPct: number; rr: number } // SL = stopPct, TP = stopPct*rr
  | { type: "atr"; atrN: number; stopMult: number; rr: number } // SL = stopMult*ATR, TP = rr*SL
  | { type: "trailing"; trailPct: number; maxBars: number } // trailing stop, no fixed target
  | { type: "breakout_stop"; stopPct: number; maxBars: number } // stop only, time exit
  | { type: "r_multiple"; stopPct: number; targets: number[]; fractions: number[] }; // scale-out R-multiples

export interface BracketResult {
  netRet: number; // gross trade return (fraction), direction-adjusted, BEFORE cost
  exitIndex: number; // bar index at which the trade closed
  bars: number; // holding length in bars
  outcome: "target" | "stop" | "trail" | "time" | "eod";
}

/**
 * Simulate ONE bracketed trade starting at entry bar `e.i` (entered at its close),
 * walking the intrabar HIGH/LOW path forward. Returns the GROSS direction-adjusted
 * return; cost is applied later by the validator (one round-trip per trade).
 *
 * Path resolution per bar (conservative): for a long, if the bar's LOW pierces the
 * stop AND its HIGH pierces the target in the same bar, the STOP is taken first.
 */
export function simulateBracket(
  bars: Bar[],
  e: Entry,
  br: BracketKind,
  maxHold: number,
): BracketResult {
  const entryPrice = bars[e.i].close;
  const dir = e.dir;
  const last = bars.length - 1;

  if (br.type === "fixed_rr" || br.type === "breakout_stop" || br.type === "atr") {
    let stopDist: number;
    let tpDist: number | null;
    let cap: number;
    if (br.type === "fixed_rr") {
      stopDist = entryPrice * br.stopPct;
      tpDist = stopDist * br.rr;
      cap = maxHold;
    } else if (br.type === "atr") {
      const atr = atrAt(bars, e.i, br.atrN);
      stopDist = atr * br.stopMult;
      tpDist = stopDist * br.rr;
      cap = maxHold;
    } else {
      stopDist = entryPrice * br.stopPct;
      tpDist = null; // stop-only, time exit
      cap = br.maxBars;
    }
    const stopPrice = entryPrice - dir * stopDist;
    const tpPrice = tpDist === null ? null : entryPrice + dir * tpDist;

    const end = Math.min(last, e.i + cap);
    for (let k = e.i + 1; k <= end; k += 1) {
      const bar = bars[k];
      const hitStop = dir === 1 ? bar.low <= stopPrice : bar.high >= stopPrice;
      const hitTp =
        tpPrice === null ? false : dir === 1 ? bar.high >= tpPrice : bar.low <= tpPrice;
      // conservative: stop first when both in the same bar
      if (hitStop) {
        return {
          netRet: dir * (stopPrice / entryPrice - 1),
          exitIndex: k,
          bars: k - e.i,
          outcome: "stop",
        };
      }
      if (hitTp && tpPrice !== null) {
        return {
          netRet: dir * (tpPrice / entryPrice - 1),
          exitIndex: k,
          bars: k - e.i,
          outcome: "target",
        };
      }
    }
    // time / end-of-data exit at the close of the last walked bar
    const exitBar = bars[end];
    return {
      netRet: dir * (exitBar.close / entryPrice - 1),
      exitIndex: end,
      bars: end - e.i,
      outcome: end === last ? "eod" : "time",
    };
  }

  if (br.type === "trailing") {
    // Trailing stop: stop trails the best price by trailPct; time-cap at maxBars.
    let best = entryPrice; // best favorable price seen (high for long, low for short)
    const cap = Math.min(maxHold, br.maxBars);
    const end = Math.min(last, e.i + cap);
    for (let k = e.i + 1; k <= end; k += 1) {
      const bar = bars[k];
      // first, can the CURRENT trailing stop be hit by this bar's adverse extreme?
      const trailStop = dir === 1 ? best * (1 - br.trailPct) : best * (1 + br.trailPct);
      const hitTrail = dir === 1 ? bar.low <= trailStop : bar.high >= trailStop;
      if (hitTrail) {
        return {
          netRet: dir * (trailStop / entryPrice - 1),
          exitIndex: k,
          bars: k - e.i,
          outcome: "trail",
        };
      }
      // then update the best favorable extreme for the next bar's trail
      if (dir === 1) best = Math.max(best, bar.high);
      else best = Math.min(best, bar.low);
    }
    const exitBar = bars[end];
    return {
      netRet: dir * (exitBar.close / entryPrice - 1),
      exitIndex: end,
      bars: end - e.i,
      outcome: end === last ? "eod" : "time",
    };
  }

  // r_multiple scale-out: stop at stopPct; take `fractions[j]` of the position off
  // at each target R-multiple `targets[j]` (in units of the stop distance). Remaining
  // position exits at time cap. P&L is the fraction-weighted sum.
  {
    const stopDist = entryPrice * br.stopPct;
    const stopPrice = entryPrice - dir * stopDist;
    const tpPrices = br.targets.map((r) => entryPrice + dir * stopDist * r);
    const fracs = [...br.fractions];
    let realized = 0;
    let remaining = 1;
    const end = Math.min(last, e.i + maxHold);
    for (let k = e.i + 1; k <= end; k += 1) {
      const bar = bars[k];
      const hitStop = dir === 1 ? bar.low <= stopPrice : bar.high >= stopPrice;
      if (hitStop) {
        // remaining position stopped out (conservative: stop before any same-bar TP)
        realized += remaining * dir * (stopPrice / entryPrice - 1);
        return { netRet: realized, exitIndex: k, bars: k - e.i, outcome: "stop" };
      }
      for (let j = 0; j < tpPrices.length; j += 1) {
        if (fracs[j] <= 0) continue;
        const hit = dir === 1 ? bar.high >= tpPrices[j] : bar.low <= tpPrices[j];
        if (hit) {
          const take = Math.min(remaining, fracs[j]);
          realized += take * dir * (tpPrices[j] / entryPrice - 1);
          remaining -= take;
          fracs[j] = 0;
        }
      }
      if (remaining <= 1e-9) {
        return { netRet: realized, exitIndex: k, bars: k - e.i, outcome: "target" };
      }
    }
    const exitBar = bars[end];
    realized += remaining * dir * (exitBar.close / entryPrice - 1);
    return {
      netRet: realized,
      exitIndex: end,
      bars: end - e.i,
      outcome: end === last ? "eod" : "time",
    };
  }
}

/**
 * Run a full bracket strategy over a bar series given a list of candidate entries.
 * Trades are NON-OVERLAPPING: after a trade closes at exitIndex, the next entry
 * considered must have i > exitIndex (no pyramiding, no concurrent exposure). This
 * keeps the per-trade series an independent sample and keeps turnover honest.
 *
 * Returns the per-trade GROSS return series plus diagnostics.
 */
export interface StrategyRun {
  perTrade: number[]; // gross direction-adjusted per-trade returns (cost applied by validator)
  tradeCount: number;
  avgBars: number;
  winRate: number;
  outcomeCounts: Record<string, number>;
}

export function runBracketStrategy(
  bars: Bar[],
  entries: Entry[],
  br: BracketKind,
  maxHold: number,
): StrategyRun {
  const perTrade: number[] = [];
  const outcomeCounts: Record<string, number> = {};
  let totalBars = 0;
  let wins = 0;
  let nextFree = 0;
  for (const e of entries) {
    if (e.i < nextFree) continue; // enforce non-overlap
    if (e.i >= bars.length - 1) continue;
    const res = simulateBracket(bars, e, br, maxHold);
    perTrade.push(res.netRet);
    totalBars += res.bars;
    if (res.netRet > 0) wins += 1;
    outcomeCounts[res.outcome] = (outcomeCounts[res.outcome] ?? 0) + 1;
    nextFree = res.exitIndex + 1;
  }
  return {
    perTrade,
    tradeCount: perTrade.length,
    avgBars: perTrade.length > 0 ? totalBars / perTrade.length : 0,
    winRate: perTrade.length > 0 ? wins / perTrade.length : 0,
    outcomeCounts,
  };
}

/**
 * UN-BRACKETED control: hold the SAME entry for a FIXED horizon of `holdBars`
 * (no path-dependent exit), exiting at that bar's close. Used to answer "does
 * bracketing beat just holding?" — same entries, same non-overlap rule.
 */
export function runFixedHorizon(
  bars: Bar[],
  entries: Entry[],
  holdBars: number,
): StrategyRun {
  const perTrade: number[] = [];
  let totalBars = 0;
  let wins = 0;
  let nextFree = 0;
  for (const e of entries) {
    if (e.i < nextFree) continue;
    const exitIndex = Math.min(bars.length - 1, e.i + holdBars);
    if (exitIndex <= e.i) continue;
    const ret = e.dir * (bars[exitIndex].close / bars[e.i].close - 1);
    perTrade.push(ret);
    totalBars += exitIndex - e.i;
    if (ret > 0) wins += 1;
    nextFree = exitIndex + 1;
  }
  return {
    perTrade,
    tradeCount: perTrade.length,
    avgBars: perTrade.length > 0 ? totalBars / perTrade.length : 0,
    winRate: perTrade.length > 0 ? wins / perTrade.length : 0,
    outcomeCounts: { time: perTrade.length },
  };
}

// ---------------------------------------------------------------------------
// Surrogate price paths (preserve vol/autocorrelation, destroy genuine structure)
// ---------------------------------------------------------------------------

/**
 * GBM surrogate: a driftless geometric random walk whose per-bar log-return vol
 * matches the real series. On a driftless GBM there is NO genuine structure, so
 * any bracketed "edge" here is pure distribution reshaping. We build a synthetic
 * OHLC bar by interpolating an intrabar mini-path so HIGH/LOW are realistic.
 */
export function gbmSurrogateBars(real: Bar[], rng: () => number): Bar[] {
  const logRets: number[] = [];
  for (let i = 1; i < real.length; i += 1) {
    logRets.push(Math.log(real[i].close / real[i - 1].close));
  }
  const mu = 0; // driftless: the fair-game null
  const sigma = stdev(logRets);
  // realistic intrabar range: median (high-low)/close of the real series
  const ranges = real.map((b) => (b.high - b.low) / b.close).sort((a, b) => a - b);
  const medRange = ranges[Math.floor(ranges.length / 2)] || 0.002;

  const out: Bar[] = [];
  let price = real[0].close;
  for (let i = 0; i < real.length; i += 1) {
    const open = price;
    const close = open * Math.exp(mu + sigma * gaussian(rng));
    // synth intrabar high/low: extend beyond the open/close envelope by a noisy range
    const base = (open + close) / 2;
    const halfRange = base * medRange * (0.5 + rng());
    const hi = Math.max(open, close) + halfRange * rng();
    const lo = Math.min(open, close) - halfRange * rng();
    out.push({ t: real[i].t, open, high: hi, low: Math.max(1e-9, lo), close });
    price = close;
  }
  return out;
}

/**
 * Phase-randomized surrogate of the close series, rebuilt into OHLC bars. Preserves
 * the power spectrum (autocorrelation) and variance of log-returns but destroys
 * nonlinear / regime structure. Intrabar range is reattached from the real bars'
 * relative range so the path test is comparable.
 */
export function phaseSurrogateBars(real: Bar[], rng: () => number): Bar[] {
  const logRets: number[] = [];
  for (let i = 1; i < real.length; i += 1) {
    logRets.push(Math.log(real[i].close / real[i - 1].close));
  }
  const surrRets = phaseRandomizeSeries(logRets, rng);
  const relRanges = real.map((b) => (b.high - b.low) / b.close);
  const relUp = real.map((b) => (b.high - Math.max(b.open, b.close)) / b.close);
  const relDn = real.map((b) => (Math.min(b.open, b.close) - b.low) / b.close);

  const out: Bar[] = [];
  let price = real[0].close;
  out.push({ ...real[0] });
  for (let i = 0; i < surrRets.length; i += 1) {
    const open = price;
    const close = open * Math.exp(surrRets[i]);
    const ix = i + 1;
    const up = (relUp[ix] ?? 0) * close;
    const dn = (relDn[ix] ?? 0) * close;
    const hi = Math.max(open, close) + Math.max(0, up);
    const lo = Math.min(open, close) - Math.max(0, dn);
    out.push({ t: real[ix].t, open, high: hi, low: Math.max(1e-9, lo), close });
    price = close;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------
function stdev(x: number[]): number {
  if (x.length < 2) return 0;
  const m = x.reduce((s, v) => s + v, 0) / x.length;
  const v = x.reduce((s, v2) => s + (v2 - m) ** 2, 0) / (x.length - 1);
  return Math.sqrt(Math.max(0, v));
}

/** Phase randomization of a 1-D series via naive DFT (fine for one-shot surrogate gen). */
function phaseRandomizeSeries(series: number[], rng: () => number): number[] {
  const n = series.length;
  if (n < 4) return [...series];
  const m = series.reduce((s, v) => s + v, 0) / n;
  const c = series.map((v) => v - m);
  // forward DFT
  const re = new Array<number>(n).fill(0);
  const im = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k += 1) {
    let sr = 0;
    let si = 0;
    for (let j = 0; j < n; j += 1) {
      const ang = (-2 * Math.PI * k * j) / n;
      sr += c[j] * Math.cos(ang);
      si += c[j] * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  const nr = new Array<number>(n).fill(0);
  const ni = new Array<number>(n).fill(0);
  nr[0] = re[0];
  ni[0] = im[0];
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k += 1) {
    const amp = Math.hypot(re[k], im[k]);
    if (k === half && n % 2 === 0) {
      nr[k] = amp * (rng() < 0.5 ? -1 : 1);
      ni[k] = 0;
    } else {
      const ph = rng() * 2 * Math.PI;
      nr[k] = amp * Math.cos(ph);
      ni[k] = amp * Math.sin(ph);
      nr[n - k] = nr[k];
      ni[n - k] = -ni[k];
    }
  }
  // inverse DFT (real part)
  const out = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j += 1) {
    let s = 0;
    for (let k = 0; k < n; k += 1) {
      const ang = (2 * Math.PI * k * j) / n;
      s += nr[k] * Math.cos(ang) - ni[k] * Math.sin(ang);
    }
    out[j] = s / n + m;
  }
  return out;
}
