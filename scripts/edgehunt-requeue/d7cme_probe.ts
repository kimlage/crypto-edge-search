/**
 * D7-CME probe: build the CME weekend-gap structure from 15m BTC spot and explore whether
 * the Friday-close -> Sunday/Monday-open gap fills predictably.
 *
 * CME BTC futures (Globex) trading hours: Sun 17:00 CT -> Fri 16:00 CT, with a daily 16:00-17:00
 * CT maintenance halt. So the weekend halt is Fri 16:00 CT -> Sun 17:00 CT.
 *   CT = UTC-6 (CST, winter) / UTC-5 (CDT, summer).
 *   Fri 16:00 CT  ≈ Fri 21:00 UTC (CST) / Fri 22:00 UTC (CDT)
 *   Sun 17:00 CT  ≈ Sun 23:00 UTC (CST) / Sun 22:00 UTC (CDT)
 * We use spot (24/7) as the continuous reference. The "CME gap" is the spot price move that
 * happened across the futures halt: from spot at Fri-CME-close to spot at Sun-CME-reopen.
 *
 * For robustness we approximate the CME close with the spot price at Fri 21:00 UTC and the
 * CME reopen with spot at Sun 22:00 UTC (covers both DST regimes approximately; we test
 * sensitivity to the exact stamp later). These are the standard reference points used by
 * the gap-fill folklore.
 */
import fs from "node:fs";

const ROOT = ".";

export interface Bar {
  t: number; // epoch ms (event_time = bar open)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function loadBars(): Bar[] {
  const raw = fs.readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`, "utf8");
  const bars: Bar[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const j = JSON.parse(line);
    bars.push({
      t: Date.parse(j.event_time),
      o: j.open,
      h: j.high,
      l: j.low,
      c: j.close,
      v: j.volume,
    });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

// Find the bar whose [t, t+15m) interval contains the given epoch ms; return the bar at-or-before.
export function barAtOrBefore(bars: Bar[], epoch: number): Bar | null {
  let lo = 0,
    hi = bars.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= epoch) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans < 0) return null;
  // require the bar to be within 1h of the target to avoid huge holes
  if (epoch - bars[ans].t > 6 * 3600 * 1000) return null;
  return bars[ans];
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// UTC day-of-week: 0=Sun..6=Sat
function dow(epoch: number): number {
  return new Date(epoch).getUTCDay();
}

export interface Weekend {
  friCloseEpoch: number;
  friClose: number; // spot at Fri CME close
  sunOpenEpoch: number;
  sunOpen: number; // spot at Sun CME reopen
  monOpenEpoch: number;
  monOpen: number; // spot at Mon 00:00 UTC (alt anchor)
  gapPct: number; // (sunOpen - friClose)/friClose : >0 = gap up over weekend
  weekEndEpoch: number; // following Fri CME close (end of trade horizon)
}

// Build the list of weekends with the CME close / reopen anchors.
// friCloseStampUtcHour: hour-of-day UTC for the Fri close anchor (default 21)
// sunOpenStampUtcHour: hour-of-day UTC for the Sun reopen anchor (default 22)
export function buildWeekends(
  bars: Bar[],
  friCloseStampUtcHour = 21,
  sunOpenStampUtcHour = 22,
): Weekend[] {
  if (bars.length === 0) return [];
  const t0 = bars[0].t;
  const tN = bars[bars.length - 1].t;
  const out: Weekend[] = [];
  // iterate over Fridays
  // find first Friday >= t0
  let d = new Date(t0);
  d.setUTCHours(friCloseStampUtcHour, 0, 0, 0);
  while (d.getUTCDay() !== 5) d = new Date(d.getTime() + DAY);
  for (let fc = d.getTime(); fc <= tN; fc += 7 * DAY) {
    const friBar = barAtOrBefore(bars, fc);
    if (!friBar) continue;
    const sunEpoch = fc + 2 * DAY - (friCloseStampUtcHour - sunOpenStampUtcHour) * HOUR;
    // Sun = Fri + 2 days, at sunOpenStampUtcHour
    const sunStamp = (() => {
      const s = new Date(fc + 2 * DAY);
      s.setUTCHours(sunOpenStampUtcHour, 0, 0, 0);
      return s.getTime();
    })();
    const sunBar = barAtOrBefore(bars, sunStamp);
    if (!sunBar) continue;
    const monStamp = (() => {
      const m = new Date(fc + 3 * DAY);
      m.setUTCHours(0, 0, 0, 0);
      return m.getTime();
    })();
    const monBar = barAtOrBefore(bars, monStamp);
    const weekEnd = fc + 7 * DAY; // next Fri close
    out.push({
      friCloseEpoch: friBar.t,
      friClose: friBar.c,
      sunOpenEpoch: sunBar.t,
      sunOpen: sunBar.c,
      monOpenEpoch: monBar ? monBar.t : sunBar.t,
      monOpen: monBar ? monBar.c : sunBar.c,
      gapPct: (sunBar.c - friBar.c) / friBar.c,
      weekEndEpoch: weekEnd,
    });
  }
  return out;
}

// Does the gap fill? i.e. does spot, between sunOpen and weekEnd, touch back to friClose?
// returns {filled, fillEpoch|null, fracOfWeek}
export function gapFills(
  bars: Bar[],
  w: Weekend,
): { filled: boolean; fillEpoch: number | null } {
  if (Math.abs(w.gapPct) < 1e-9) return { filled: true, fillEpoch: w.sunOpenEpoch };
  const target = w.friClose;
  const gapUp = w.sunOpen > w.friClose;
  // scan bars from sunOpenEpoch to weekEndEpoch
  let i = 0;
  // binary search start
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
  for (i = start; i < bars.length && bars[i].t <= w.weekEndEpoch; i++) {
    const b = bars[i];
    if (gapUp) {
      // need price to come DOWN to target
      if (b.l <= target) return { filled: true, fillEpoch: b.t };
    } else {
      if (b.h >= target) return { filled: true, fillEpoch: b.t };
    }
  }
  return { filled: false, fillEpoch: null };
}

if (process.argv[1] && process.argv[1].includes("d7cme_probe")) {
  const bars = loadBars();
  console.log(
    `bars=${bars.length} from ${new Date(bars[0].t).toISOString()} to ${new Date(bars[bars.length - 1].t).toISOString()}`,
  );
  const weekends = buildWeekends(bars);
  console.log(`weekends=${weekends.length}`);
  // distribution of |gap|
  const gaps = weekends.map((w) => w.gapPct);
  const absGaps = gaps.map((g) => Math.abs(g)).sort((a, b) => a - b);
  const q = (p: number) => absGaps[Math.floor(absGaps.length * p)];
  console.log(
    `|gap| pct: p10=${(q(0.1) * 100).toFixed(2)} p50=${(q(0.5) * 100).toFixed(2)} p90=${(q(0.9) * 100).toFixed(2)} max=${(absGaps[absGaps.length - 1] * 100).toFixed(2)}`,
  );
  const upN = gaps.filter((g) => g > 0).length;
  console.log(`gap up share=${(upN / gaps.length).toFixed(3)}`);
  // fill rates by gap-size bucket
  const buckets: Record<string, { n: number; filled: number }> = {};
  let totFill = 0;
  for (const w of weekends) {
    const f = gapFills(bars, w);
    if (f.filled) totFill++;
    const ag = Math.abs(w.gapPct) * 100;
    const key =
      ag < 0.25 ? "0.00-0.25%" : ag < 0.5 ? "0.25-0.5%" : ag < 1 ? "0.5-1%" : ag < 2 ? "1-2%" : ag < 4 ? "2-4%" : ">4%";
    buckets[key] = buckets[key] || { n: 0, filled: 0 };
    buckets[key].n++;
    if (f.filled) buckets[key].filled++;
  }
  console.log(`overall same-week fill rate=${(totFill / weekends.length).toFixed(3)}`);
  for (const k of ["0.00-0.25%", "0.25-0.5%", "0.5-1%", "1-2%", "2-4%", ">4%"]) {
    const b = buckets[k];
    if (b) console.log(`  bucket ${k}: n=${b.n} fillRate=${(b.filled / b.n).toFixed(3)}`);
  }
}
