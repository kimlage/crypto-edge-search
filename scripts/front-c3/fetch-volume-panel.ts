/**
 * FRONT C3 — fetch DAILY QUOTE VOLUME for the 30-coin universe from Binance public
 * REST (free, no key). This complements the existing close-price panel at
 * output/crossxs/daily-closes.json with a volume panel so we can build the
 * volume-concentration (HHI) and BTC-dominance JOINT state signals.
 *
 * Quote volume = klines[i][7] (USDT-denominated turnover). Aligned to the SAME
 * date axis as the close panel. Coins with no data before listing get null.
 *
 * Free public REST only. No paid BigQuery. Writes output/front-c3/volume-panel.json.
 *
 * Run: <codex-node>/tsx scripts/front-c3/fetch-volume-panel.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNIVERSE = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK",
  "MATIC", "LTC", "TRX", "ATOM", "UNI", "ETC", "XLM", "BCH", "FIL", "APT",
  "NEAR", "ARB", "OP", "INJ", "AAVE", "ALGO", "EGLD", "SAND", "AXS", "GRT",
];

const HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
];

interface CloseFile {
  dates: string[];
  closes: Record<string, (number | null)[]>;
}

function dayMs(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<Map<number, number>> {
  // returns map dayStartMs -> quoteVolume
  const out = new Map<number, number>();
  let cursor = startMs;
  while (cursor <= endMs) {
    let ok = false;
    for (const host of HOSTS) {
      const url = `${host}/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${cursor}&endTime=${endMs}&limit=1000`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) continue;
        const rows = (await res.json()) as unknown[][];
        if (!Array.isArray(rows) || rows.length === 0) {
          return out;
        }
        for (const row of rows) {
          const openTime = Number(row[0]);
          const quoteVol = Number(row[7]);
          // normalize to day-start UTC
          const dayStart = Math.floor(openTime / 86400000) * 86400000;
          out.set(dayStart, quoteVol);
        }
        const lastOpen = Number(rows[rows.length - 1][0]);
        cursor = lastOpen + 86400000;
        ok = true;
        break;
      } catch {
        // try next host
      }
    }
    if (!ok) {
      // both hosts failed for this page; back off and retry once
      await sleep(1500);
      // attempt one more with first host
      const url = `${HOSTS[0]}/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${cursor}&endTime=${endMs}&limit=1000`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (res.ok) {
          const rows = (await res.json()) as unknown[][];
          if (!Array.isArray(rows) || rows.length === 0) return out;
          for (const row of rows) {
            const dayStart = Math.floor(Number(row[0]) / 86400000) * 86400000;
            out.set(dayStart, Number(row[7]));
          }
          cursor = Number(rows[rows.length - 1][0]) + 86400000;
          continue;
        }
      } catch {
        // give up on this symbol page
      }
      return out;
    }
    await sleep(120);
  }
  return out;
}

async function main(): Promise<void> {
  const closePath = join("output", "crossxs", "daily-closes.json");
  const closeFile = JSON.parse(readFileSync(closePath, "utf8")) as CloseFile;
  const dates = closeFile.dates;
  const dayKeys = dates.map(dayMs);
  const startMs = dayKeys[0];
  const endMs = dayKeys[dayKeys.length - 1];

  console.log(`Fetching daily quote volume for ${UNIVERSE.length} coins, ${dates.length} days (${dates[0]} -> ${dates[dates.length - 1]})`);

  const volumes: Record<string, (number | null)[]> = {};
  const failed: string[] = [];

  for (const coin of UNIVERSE) {
    const symbol = `${coin}USDT`;
    try {
      const map = await fetchKlines(symbol, startMs, endMs);
      const arr = dayKeys.map((k) => {
        const v = map.get(k);
        return v !== undefined && Number.isFinite(v) ? v : null;
      });
      const nValid = arr.filter((x) => x !== null).length;
      volumes[coin] = arr;
      console.log(`  ${coin.padEnd(6)} ${nValid}/${dates.length} days`);
      if (nValid === 0) failed.push(coin);
    } catch (err) {
      console.log(`  ${coin.padEnd(6)} FAILED: ${(err as Error).message}`);
      volumes[coin] = dayKeys.map(() => null);
      failed.push(coin);
    }
  }

  const outPath = join("output", "front-c3", "volume-panel.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        source: "binance-public-rest",
        realData: true,
        field: "quoteVolumeUSDT",
        dates,
        volumes,
        failedSymbols: failed,
        generatedAt: new Date().toISOString(),
      },
      null,
      0,
    ),
  );
  console.log(`Wrote ${outPath}. Failed: ${failed.length ? failed.join(",") : "none"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
