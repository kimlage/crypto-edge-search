/**
 * FRONT C4 — Listing-event data fetcher (REAL data, free Binance Futures REST).
 *
 * Binance Futures `exchangeInfo` exposes `onboardDate` (the exact listing
 * timestamp) for every USDT perpetual contract. That is a genuine, large,
 * well-dated panel of KNOWN-calendar supply/flow events (a new listing is a
 * forced-flow event: index funds, market makers, retail all transact on day 0).
 *
 * This script:
 *   1) Pulls every USDT-quoted PERPETUAL symbol + its onboardDate + status.
 *   2) For each, fetches the first `POST_DAYS` daily klines from the listing.
 *   3) Fetches BTCUSDT full daily history (the market benchmark for the
 *      abnormal-return / event-study computation).
 *   4) Caches everything to output/front-c4/cache so re-runs are offline.
 *
 * No writes outside the track. No BigQuery. Free public REST only.
 *
 * Honesty: onboardDate is the venue listing date, the cleanest possible "known
 * calendar event". We include SETTLING (delisted) symbols too, so the LISTING
 * side is NOT survivorship-biased on the event itself.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CACHE = join(ROOT, "output", "front-c4", "cache");

const FAPI = "https://fapi.binance.com";
const POST_DAYS = 60; // daily klines to keep after listing day 0
const DAY_MS = 86_400_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url: string, tries = 5): Promise<unknown> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418) {
        const wait = 2000 * (attempt + 1);
        process.stderr.write(`  rate-limited (${res.status}), wait ${wait}ms\n`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === tries - 1) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw new Error("unreachable");
}

interface SymbolMeta {
  symbol: string;
  status: string;
  onboardMs: number;
  onboardDate: string;
}

interface ListingRecord {
  symbol: string;
  status: string;
  onboardDate: string;
  onboardMs: number;
  // first POST_DAYS daily bars: each [openTimeMs, open, high, low, close, volume]
  bars: number[][];
}

async function fetchUniverse(): Promise<SymbolMeta[]> {
  const info = (await getJson(`${FAPI}/fapi/v1/exchangeInfo`)) as {
    symbols: Array<{
      symbol: string;
      quoteAsset: string;
      contractType: string;
      status: string;
      onboardDate: number;
    }>;
  };
  return info.symbols
    .filter((s) => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.onboardDate)
    .map((s) => ({
      symbol: s.symbol,
      status: s.status,
      onboardMs: s.onboardDate,
      onboardDate: new Date(s.onboardDate).toISOString().slice(0, 10),
    }));
}

async function fetchDailyKlines(
  symbol: string,
  startMs: number,
  limit: number,
): Promise<number[][]> {
  const url = `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=1d&startTime=${startMs}&limit=${limit}`;
  const kl = (await getJson(url)) as unknown[][];
  return kl.map((k) => [
    Number(k[0]),
    Number(k[1]),
    Number(k[2]),
    Number(k[3]),
    Number(k[4]),
    Number(k[5]),
  ]);
}

/** Fetch the full daily close history of BTC as the market benchmark. */
async function fetchBtcDaily(): Promise<{ dates: string[]; closes: number[] }> {
  const start = Date.UTC(2019, 8, 1); // 2019-09
  let cursor = start;
  const out: number[][] = [];
  for (let page = 0; page < 40; page += 1) {
    const url = `${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=1d&startTime=${cursor}&limit=1000`;
    const kl = (await getJson(url)) as unknown[][];
    if (kl.length === 0) break;
    for (const k of kl) out.push([Number(k[0]), Number(k[4])]);
    const last = Number(kl[kl.length - 1][0]);
    if (kl.length < 1000) break;
    cursor = last + DAY_MS;
    await sleep(200);
  }
  // dedupe by openTime
  const seen = new Set<number>();
  const dates: string[] = [];
  const closes: number[] = [];
  for (const [t, c] of out) {
    if (seen.has(t)) continue;
    seen.add(t);
    dates.push(new Date(t).toISOString().slice(0, 10));
    closes.push(c);
  }
  return { dates, closes };
}

async function main(): Promise<void> {
  const universePath = join(CACHE, "universe.json");
  const listingsPath = join(CACHE, "listing-bars.json");
  const btcPath = join(CACHE, "btc-daily.json");

  if (existsSync(listingsPath) && existsSync(btcPath) && !process.env.FORCE) {
    process.stdout.write("cache present; set FORCE=1 to refetch. Skipping.\n");
    const recs = JSON.parse(readFileSync(listingsPath, "utf8")) as ListingRecord[];
    process.stdout.write(`cached listings: ${recs.length}\n`);
    return;
  }

  process.stdout.write("fetching USDT-perp universe...\n");
  const universe = await fetchUniverse();
  writeFileSync(universePath, JSON.stringify(universe, null, 2));
  process.stdout.write(`universe: ${universe.length} symbols\n`);

  process.stdout.write("fetching BTC daily benchmark...\n");
  const btc = await fetchBtcDaily();
  writeFileSync(btcPath, JSON.stringify(btc));
  process.stdout.write(`btc daily: ${btc.dates.length} bars (${btc.dates[0]}..${btc.dates[btc.dates.length - 1]})\n`);

  const records: ListingRecord[] = [];
  let i = 0;
  for (const meta of universe) {
    i += 1;
    try {
      const bars = await fetchDailyKlines(meta.symbol, meta.onboardMs, POST_DAYS);
      records.push({
        symbol: meta.symbol,
        status: meta.status,
        onboardDate: meta.onboardDate,
        onboardMs: meta.onboardMs,
        bars,
      });
      if (i % 50 === 0) {
        process.stdout.write(`  ${i}/${universe.length} fetched...\n`);
        writeFileSync(listingsPath, JSON.stringify(records));
      }
    } catch (err) {
      process.stderr.write(`  FAILED ${meta.symbol}: ${(err as Error).message}\n`);
    }
    await sleep(120);
  }
  writeFileSync(listingsPath, JSON.stringify(records));
  process.stdout.write(`DONE: ${records.length} listing records cached.\n`);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${(err as Error).stack}\n`);
  process.exit(1);
});
