/**
 * NF1 data prep — fetch & cache DAILY OHLC for the 8 majors from Binance public
 * klines (free, no key). BTC daily OHLC is ALSO derived locally by aggregating the
 * committed 15m file, so we can cross-check the Binance daily bars against our own
 * intrabar data. Caches one JSON per symbol in output/nf1/, so the main test can run
 * fully offline afterwards.
 *
 * Daily OHLC (true High/Low/Close) is REQUIRED for floor-trader pivot points and
 * Fibonacci retracements; the committed funding/*_prices_daily.json only have closes.
 *
 * Run:
 *   tsx scripts/nf1/fetch-daily-ohlc.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT_DIR = join(REPO, "output", "nf1");

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"] as const;

export interface DailyBar {
  date: string; // YYYY-MM-DD (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchBinanceDaily(symbol: string): Promise<DailyBar[]> {
  // Binance klines, 1d, paginated from 2017 to now. Max 1000 per call.
  const out: DailyBar[] = [];
  let startTime = Date.parse("2017-08-01T00:00:00Z");
  const now = Date.now();
  const pair = `${symbol}USDT`;
  for (let guard = 0; guard < 50; guard += 1) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d` +
      `&startTime=${startTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${pair} HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      const openTime = Number(r[0]);
      const date = new Date(openTime).toISOString().slice(0, 10);
      out.push({
        date,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    startTime = lastOpen + 86_400_000;
    if (startTime > now) break;
    if (rows.length < 1000) break;
    await sleep(120);
  }
  // dedupe by date (defensive)
  const seen = new Set<string>();
  return out.filter((b) => {
    if (seen.has(b.date)) return false;
    seen.add(b.date);
    return Number.isFinite(b.high) && Number.isFinite(b.low) && b.high >= b.low && b.low > 0;
  });
}

/** Aggregate the committed 15m BTC file into daily OHLC (UTC day). */
function aggregateBtcDailyFrom15m(): DailyBar[] {
  const path = join(REPO, "output", "bigquery", "btc_ohlcv_15m.ndjson");
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const byDay = new Map<string, DailyBar>();
  for (const line of lines) {
    const o = JSON.parse(line) as {
      event_date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    };
    const d = o.event_date;
    const cur = byDay.get(d);
    if (!cur) {
      byDay.set(d, {
        date: d,
        open: o.open,
        high: o.high,
        low: o.low,
        close: o.close,
        volume: o.volume,
      });
    } else {
      cur.high = Math.max(cur.high, o.high);
      cur.low = Math.min(cur.low, o.low);
      cur.close = o.close; // last bar of the day
      cur.volume += o.volume;
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function main(): Promise<void> {
  console.log("NF1 data prep — daily OHLC for 8 majors");

  // BTC: prefer local 15m aggregation (full 2017+ history, our own intrabar data).
  const btcDaily = aggregateBtcDailyFrom15m();
  writeFileSync(join(OUT_DIR, "BTC_daily_ohlc.json"), JSON.stringify(btcDaily));
  console.log(`  BTC (from 15m): ${btcDaily.length} days ${btcDaily[0].date}..${btcDaily[btcDaily.length - 1].date}`);

  for (const sym of SYMBOLS) {
    if (sym === "BTC") continue;
    const cachePath = join(OUT_DIR, `${sym}_daily_ohlc.json`);
    if (existsSync(cachePath) && !process.env.NF1_REFETCH) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as DailyBar[];
      console.log(`  ${sym}: cached ${cached.length} days`);
      continue;
    }
    const bars = await fetchBinanceDaily(sym);
    writeFileSync(cachePath, JSON.stringify(bars));
    console.log(`  ${sym}: fetched ${bars.length} days ${bars[0]?.date}..${bars[bars.length - 1]?.date}`);
    await sleep(200);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
