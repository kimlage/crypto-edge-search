/**
 * Q5-TOD exploration: decompose BTC 15m log-returns by UTC hour and by trading session.
 * Goal: is any UTC hour / session systematically positive (gross, then net of 4bps/side)?
 * This is the HONEST hunt: we print every bucket's mean, t-stat, and Sharpe so we can see
 * whether anything survives even before the gauntlet.
 *
 * Data: output/bigquery/btc_ohlcv_15m.ndjson (committed, $0).
 * Forward return convention: position taken at close of bar t (available_at), held over bar t+1.
 */
import fs from "node:fs";
import readline from "node:readline";

const ROOT = ".";
const FILE = `${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`;

interface Bar {
  t: number; // ms epoch of event_time (bar OPEN)
  close: number;
  hourUTC: number; // 0..23 (UTC hour of the bar)
  dow: number; // 0=Sun..6=Sat (UTC)
}

async function loadBars(): Promise<Bar[]> {
  const rl = readline.createInterface({
    input: fs.createReadStream(FILE),
    crlfDelay: Infinity,
  });
  const bars: Bar[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const d = new Date(r.event_time);
    bars.push({
      t: d.getTime(),
      close: Number(r.close),
      hourUTC: d.getUTCHours(),
      dow: d.getUTCDay(),
    });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}

async function main() {
  const bars = await loadBars();
  console.log(`loaded ${bars.length} bars  ${new Date(bars[0].t).toISOString()} .. ${new Date(bars.at(-1)!.t).toISOString()}`);

  // forward 15m log return r[t] = log(close[t+1]/close[t]); attributed to the bar t we are IN.
  const T = bars.length;
  const fwd: number[] = new Array(T).fill(NaN);
  for (let i = 0; i < T - 1; i++) {
    const dt = bars[i + 1].t - bars[i].t;
    // only accept contiguous 15m bars (no gaps) for a clean attribution
    if (dt === 15 * 60 * 1000 && bars[i].close > 0 && bars[i + 1].close > 0) {
      fwd[i] = Math.log(bars[i + 1].close / bars[i].close);
    }
  }

  // --- decompose by UTC hour of the bar we are IN (24 buckets) ---
  const ann = Math.sqrt(365 * 96); // 96 15m-bars/day annualization for per-bar Sharpe
  console.log("\n=== mean fwd 15m return by UTC hour (the bar you HOLD) ===");
  console.log("hour    n        meanBps    t-stat    annSharpe   posRate");
  const hourBuckets: number[][] = Array.from({ length: 24 }, () => []);
  for (let i = 0; i < T - 1; i++) {
    if (Number.isFinite(fwd[i])) hourBuckets[bars[i].hourUTC].push(fwd[i]);
  }
  for (let h = 0; h < 24; h++) {
    const a = hourBuckets[h];
    const m = mean(a);
    const s = std(a);
    const t = s > 0 ? (m / s) * Math.sqrt(a.length) : 0;
    const sh = s > 0 ? (m / s) * ann : 0;
    const pos = a.filter((x) => x > 0).length / a.length;
    console.log(
      `${String(h).padStart(2)}    ${String(a.length).padStart(7)}   ${(m * 1e4).toFixed(4).padStart(8)}   ${t.toFixed(2).padStart(7)}   ${sh.toFixed(3).padStart(8)}   ${pos.toFixed(3)}`,
    );
  }

  // --- session definitions (UTC) ---
  // Asia: 00-08, EU/London: 07-16, US: 13-22 (overlap intentional, common convention).
  // We test BOTH simple session-long and the "overnight (non-US) vs intraday (US)" decomposition.
  const sessions: Record<string, (h: number) => boolean> = {
    "Asia_00-08": (h) => h >= 0 && h < 8,
    "EU_07-16": (h) => h >= 7 && h < 16,
    "US_13-22": (h) => h >= 13 && h < 22,
    "US_core_14-21": (h) => h >= 14 && h < 21,
    "USopen_13-17": (h) => h >= 13 && h < 17,
    "overnight_nonUS_22-13": (h) => h >= 22 || h < 13,
  };
  console.log("\n=== mean fwd 15m return by SESSION ===");
  console.log("session              n        meanBps    t-stat    annSharpe   posRate");
  for (const [name, fn] of Object.entries(sessions)) {
    const a: number[] = [];
    for (let i = 0; i < T - 1; i++) {
      if (Number.isFinite(fwd[i]) && fn(bars[i].hourUTC)) a.push(fwd[i]);
    }
    const m = mean(a);
    const s = std(a);
    const t = s > 0 ? (m / s) * Math.sqrt(a.length) : 0;
    const sh = s > 0 ? (m / s) * ann : 0;
    const pos = a.filter((x) => x > 0).length / a.length;
    console.log(
      `${name.padEnd(20)} ${String(a.length).padStart(7)}   ${(m * 1e4).toFixed(4).padStart(8)}   ${t.toFixed(2).padStart(7)}   ${sh.toFixed(3).padStart(8)}   ${pos.toFixed(3)}`,
    );
  }

  // --- split-half stability: first 60% vs last 40% by UTC hour mean (does sign persist?) ---
  console.log("\n=== UTC-hour mean SIGN stability: first 60% vs last 40% ===");
  const splitT = Math.floor(T * 0.6);
  const firstB: number[][] = Array.from({ length: 24 }, () => []);
  const lastB: number[][] = Array.from({ length: 24 }, () => []);
  for (let i = 0; i < T - 1; i++) {
    if (!Number.isFinite(fwd[i])) continue;
    (i < splitT ? firstB : lastB)[bars[i].hourUTC].push(fwd[i]);
  }
  let agree = 0;
  for (let h = 0; h < 24; h++) {
    const m1 = mean(firstB[h]);
    const m2 = mean(lastB[h]);
    const same = Math.sign(m1) === Math.sign(m2);
    if (same) agree++;
    console.log(`hour ${String(h).padStart(2)}  first=${(m1 * 1e4).toFixed(3).padStart(7)}bps  last=${(m2 * 1e4).toFixed(3).padStart(7)}bps  ${same ? "SAME" : "FLIP"}`);
  }
  console.log(`\nsign agreement across halves: ${agree}/24 hours`);
}

main();
