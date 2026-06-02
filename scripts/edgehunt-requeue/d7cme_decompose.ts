/**
 * D7-CME decomposition: is the "edge" gap-specific, or just generic weekend mean-reversion?
 *
 * Three tests:
 *  (1) DIRECTIONAL EDGE of trading toward the fill, with a FIXED horizon (no path-dependent exit),
 *      so exit mechanics can't manufacture edge. Position = -sign(gap) held sunOpen->friClose(next).
 *      Compare to: same fixed-horizon return of a coin-flip direction (random sign).
 *  (2) CALENDAR-REANCHOR null (the committed null): keep the SAME |move| and the SAME mean-reversion
 *      rule, but re-anchor the "gap" to a random *intraweek* close (a fake weekend). If real-weekend
 *      reversion ~ fake-weekend reversion, the gap is not special — it's just generic reversion.
 *  (3) Surrogate that preserves DIRECTION (sign of true gap) but reanchors the TARGET level only,
 *      to separate "direction predicts" from "the specific friClose level is a magnet".
 */
import { loadBars, buildWeekends, barAtOrBefore, type Bar, type Weekend } from "./d7cme_probe.ts";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const COST = 0.0004;
const ANN = Math.sqrt(52);

function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function annSh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const bars = loadBars();
const weekends = buildWeekends(bars);
const N = weekends.length;
const minGap = 0.02; // best config used a 2% min gap

// (1) Fixed-horizon directional edge: enter at sunOpen, hold to next-Fri close, position = toward fill.
//     toward fill: gap up -> short; gap down -> long.  return = -sign(gap)*log(close_end/entry) - 2*cost
function fixedHorizonReturns(filterMin: number): { real: number[]; nTraded: number } {
  const real: number[] = [];
  let nTraded = 0;
  for (const w of weekends) {
    if (Math.abs(w.gapPct) < filterMin) { real.push(0); continue; }
    const eb = barAtOrBefore(bars, w.sunOpenEpoch);
    const xb = barAtOrBefore(bars, w.weekEndEpoch);
    if (!eb || !xb) { real.push(0); continue; }
    const dir = w.gapPct > 0 ? -1 : 1; // toward fill
    const r = dir * Math.log(xb.c / eb.c) - 2 * COST;
    real.push(r);
    nTraded++;
  }
  return { real, nTraded };
}

const fh = fixedHorizonReturns(minGap);
console.log(`(1) FIXED-HORIZON directional (toward fill), minGap=${minGap}:`);
console.log(`    nTraded=${fh.nTraded} meanRet=${(mean(fh.real) * 1e4).toFixed(2)}bps annSh=${annSh(fh.real).toFixed(3)}`);
// random-sign baseline distribution
{
  const shs: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const rng = mkRng(11 + i * 2654435761);
    const r: number[] = [];
    for (const w of weekends) {
      if (Math.abs(w.gapPct) < minGap) { r.push(0); continue; }
      const eb = barAtOrBefore(bars, w.sunOpenEpoch);
      const xb = barAtOrBefore(bars, w.weekEndEpoch);
      if (!eb || !xb) { r.push(0); continue; }
      const dir = rng() < 0.5 ? 1 : -1;
      r.push(dir * Math.log(xb.c / eb.c) - 2 * COST);
    }
    shs.push(annSh(r));
  }
  shs.sort((a, b) => a - b);
  const p = (shs.filter((s) => s >= annSh(fh.real)).length + 1) / (shs.length + 1);
  console.log(`    random-sign baseline: mean=${mean(shs).toFixed(3)} p95=${shs[Math.floor(shs.length * 0.95)].toFixed(3)} p(rand>=real)=${p.toFixed(4)}`);
}

// (2) CALENDAR-REANCHOR null: define a FAKE weekend at a random intraweek day-pair with the same
//     2-day gap and the same forward 5-day horizon; apply the SAME "toward fill" reversion rule.
//     If generic reversion explains it, fake weekends reverse just as well.
{
  console.log(`\n(2) CALENDAR-REANCHOR null (fake 2-day "gaps" on random weekdays, same rule):`);
  const realSh = annSh(fh.real);
  const fakeShs: number[] = [];
  // precompute a fast lookup of close at an arbitrary epoch
  for (let i = 0; i < 500; i++) {
    const rng = mkRng(777 + i * 7919);
    const r: number[] = [];
    for (const w of weekends) {
      // anchor offset: shift the whole (entry, gap-window, horizon) by a random number of days 1..4
      // so the "weekend" lands mid-week. Keep structure: gapStart = friClose - 2d shifted; here we
      // emulate by picking a random day in the week as the "Fri close" and +2d as "Sun open".
      const shiftDays = 1 + Math.floor(rng() * 4); // 1..4 days
      const fakeFriEpoch = w.friCloseEpoch + shiftDays * DAY;
      const fakeSunEpoch = fakeFriEpoch + 2 * DAY;
      const fakeEndEpoch = fakeFriEpoch + 7 * DAY;
      const fb = barAtOrBefore(bars, fakeFriEpoch);
      const sb = barAtOrBefore(bars, fakeSunEpoch);
      const xb = barAtOrBefore(bars, fakeEndEpoch);
      if (!fb || !sb || !xb) { r.push(0); continue; }
      const fakeGap = (sb.c - fb.c) / fb.c;
      if (Math.abs(fakeGap) < minGap) { r.push(0); continue; }
      const dir = fakeGap > 0 ? -1 : 1;
      r.push(dir * Math.log(xb.c / sb.c) - 2 * COST);
    }
    fakeShs.push(annSh(r));
  }
  fakeShs.sort((a, b) => a - b);
  const p = (fakeShs.filter((s) => s >= realSh).length + 1) / (fakeShs.length + 1);
  console.log(`    real annSh=${realSh.toFixed(3)}  fake-weekend mean=${mean(fakeShs).toFixed(3)} p50=${fakeShs[Math.floor(fakeShs.length * 0.5)].toFixed(3)} p95=${fakeShs[Math.floor(fakeShs.length * 0.95)].toFixed(3)}`);
  console.log(`    p(fake-weekend >= real-weekend)=${p.toFixed(4)}  <- if NOT small, weekend is not special`);
}

// (3) Generic 2-day reversion on ANY consecutive 2-day move (not just weekends), same min filter.
{
  console.log(`\n(3) GENERIC 2-day reversion (all overlapping windows, daily): is the weekend even needed?`);
  // build daily closes at 00:00 UTC
  const dailyClose: { t: number; c: number }[] = [];
  const t0 = bars[0].t, tN = bars[bars.length - 1].t;
  let d = new Date(t0); d.setUTCHours(0, 0, 0, 0);
  for (let e = d.getTime(); e <= tN; e += DAY) {
    const b = barAtOrBefore(bars, e);
    if (b) dailyClose.push({ t: e, c: b.c });
  }
  const r: number[] = [];
  for (let i = 2; i + 5 < dailyClose.length; i++) {
    const twoDay = (dailyClose[i].c - dailyClose[i - 2].c) / dailyClose[i - 2].c;
    if (Math.abs(twoDay) < minGap) continue;
    const dir = twoDay > 0 ? -1 : 1;
    r.push(dir * Math.log(dailyClose[i + 5].c / dailyClose[i].c) - 2 * COST);
  }
  console.log(`    n=${r.length} meanRet=${(mean(r) * 1e4).toFixed(2)}bps annSh(daily-overlap, ann@252-ish)=${(mean(r) / std(r) * Math.sqrt(252 / 5)).toFixed(3)}`);
}
