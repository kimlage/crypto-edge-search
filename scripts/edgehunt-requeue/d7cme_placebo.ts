/**
 * D7-CME random-level placebo (the Fibonacci/random-lines kill).
 *
 * For each weekend, the real gap is a target level `friClose` at signed distance `gapPct` from
 * the Sun reopen. The placebo: pick a RANDOM nearby level at the SAME absolute distance but in a
 * random direction (or at a random distance drawn from the same empirical |gap| distribution),
 * anchored at the Sun reopen, and measure how often spot touches THAT level in the same week.
 *
 * If the real-gap fill rate is NOT higher than the placebo touch rate, the "magnet" is just
 * diffusion/volatility — no edge. This is the committed surrogate-gap null.
 */
import { loadBars, buildWeekends, type Bar, type Weekend } from "./d7cme_probe.ts";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Does spot touch a signed target level (anchored relative to sunOpen) within the week?
function touches(
  bars: Bar[],
  w: Weekend,
  targetLevel: number,
  needDown: boolean, // true: need price to fall to target (target below sunOpen)
): boolean {
  let lo = 0,
    hi = bars.length - 1,
    start = bars.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t >= w.sunOpenEpoch) {
      start = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  for (let i = start; i < bars.length && bars[i].t <= w.weekEndEpoch; i++) {
    const b = bars[i];
    if (needDown) {
      if (b.l <= targetLevel) return true;
    } else {
      if (b.h >= targetLevel) return true;
    }
  }
  return false;
}

const bars = loadBars();
const weekends = buildWeekends(bars);
// real fill rate (matched to placebo logic: touch friClose from sunOpen)
let realFill = 0;
for (const w of weekends) {
  if (Math.abs(w.gapPct) < 1e-9) {
    realFill++;
    continue;
  }
  const needDown = w.sunOpen > w.friClose;
  if (touches(bars, w, w.friClose, needDown)) realFill++;
}
const realRate = realFill / weekends.length;

// Placebo A: same |distance|, RANDOM direction.
// Placebo B: random distance drawn from empirical |gap| distribution, random direction.
const absGaps = weekends.map((w) => Math.abs(w.gapPct));
const NS = 500;
const aRates: number[] = [];
const bRates: number[] = [];
for (let s = 0; s < NS; s++) {
  const rng = mkRng(13 + s * 2654435761);
  let aFill = 0,
    bFill = 0;
  for (const w of weekends) {
    // Placebo A: same magnitude, random sign
    {
      const dist = Math.abs(w.gapPct);
      const up = rng() < 0.5; // target above sunOpen?
      const target = w.sunOpen * (up ? 1 + dist : 1 - dist);
      if (touches(bars, w, target, !up)) aFill++;
    }
    // Placebo B: random magnitude from empirical dist, random sign
    {
      const dist = absGaps[Math.floor(rng() * absGaps.length)];
      const up = rng() < 0.5;
      const target = w.sunOpen * (up ? 1 + dist : 1 - dist);
      if (touches(bars, w, target, !up)) bFill++;
    }
  }
  aRates.push(aFill / weekends.length);
  bRates.push(bFill / weekends.length);
}
aRates.sort((a, b) => a - b);
bRates.sort((a, b) => a - b);
const pctl = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];
const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
// one-sided p: fraction of placebo rates >= real rate
const pA = (aRates.filter((r) => r >= realRate).length + 1) / (NS + 1);
const pB = (bRates.filter((r) => r >= realRate).length + 1) / (NS + 1);

console.log(`weekends=${weekends.length}`);
console.log(`REAL same-week fill rate (touch friClose)=${realRate.toFixed(4)}`);
console.log(
  `Placebo A (same |dist|, random dir): mean=${mean(aRates).toFixed(4)} p50=${pctl(aRates, 0.5).toFixed(4)} p95=${pctl(aRates, 0.95).toFixed(4)}  p(placebo>=real)=${pA.toFixed(4)}`,
);
console.log(
  `Placebo B (random |dist|+dir):       mean=${mean(bRates).toFixed(4)} p50=${pctl(bRates, 0.5).toFixed(4)} p95=${pctl(bRates, 0.95).toFixed(4)}  p(placebo>=real)=${pB.toFixed(4)}`,
);
