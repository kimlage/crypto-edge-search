/**
 * FRONT C1 — Capital ROTATION (lead-lag flow-of-capital).
 *
 * Fetch DAILY QUOTE VOLUME (USDT dollar volume = the user's literal "volume"
 * variable) for the full tier panel from Binance public REST klines.
 *
 * Kline layout: [openTime, open, high, low, close, baseVol, closeTime,
 *                quoteVol(USDT), trades, ...]. We take index 7 (dollar volume)
 * AND index 4 (close, for returns). One row per UTC day.
 *
 * Tiers (built from real data + the committed panels):
 *   mega       = BTC
 *   large      = ETH
 *   large_alts = SOL, BNB, XRP, ADA, AVAX, DOGE
 *   mid_small  = the rest of output/crossxs/* (30-coin panel) + output/r2-illiquid/* (smallcap)
 *
 * Output: output/c1-rotation/volume-panel.json
 *   { source, realData, dates:[...], close:{SYM:[...]}, quoteVolume:{SYM:[...]} }
 *
 * Cloud $0: free public REST only.
 */
import { writeFileSync, readFileSync } from "node:fs";

const DAY_MS = 86_400_000;
const START_MS = Date.parse("2020-06-01T00:00:00Z");
const NOW = Date.now();

// Union of all coins across both committed panels (so every tier coin exists).
const CROSSXS = JSON.parse(
  readFileSync("output/crossxs/daily-closes.json", "utf8"),
);
const SMALLCAP = JSON.parse(
  readFileSync("output/r2-illiquid/smallcap-daily-closes.json", "utf8"),
);
const PANEL_COINS: string[] = Array.from(
  new Set<string>([
    ...Object.keys(CROSSXS.closes),
    ...Object.keys(SMALLCAP.closes),
  ]),
);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Paginate daily klines; returns [openTimeMs, close, quoteVolumeUSDT][]. */
async function fetchBinanceDaily(
  symbol: string,
): Promise<[number, number, number][]> {
  const pair = `${symbol}USDT`;
  const rows: [number, number, number][] = [];
  let cursor = START_MS;
  for (let page = 0; page < 60; page += 1) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d` +
      `&startTime=${cursor}&limit=1000`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`network:${(err as Error)?.name ?? "err"}`);
    }
    if (res.status === 451 || res.status === 403)
      throw new Error(`blocked:${res.status}`);
    if (!res.ok) throw new Error(`http:${res.status}`);
    const data = (await res.json()) as unknown[];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const k of data as number[][]) {
      rows.push([Number(k[0]), Number(k[4]), Number(k[7])]);
    }
    const lastOpen = Number((data[data.length - 1] as number[])[0]);
    if (data.length < 1000) break;
    cursor = lastOpen + DAY_MS;
    if (cursor > NOW) break;
    await sleep(120);
  }
  return rows;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log(`[fetch] panel = ${PANEL_COINS.length} coins`);

  const perCoin = new Map<string, Map<string, [number, number]>>(); // sym -> day -> [close, qvol]
  const dateSet = new Set<string>();
  const fetched: string[] = [];
  const failed: string[] = [];

  for (const coin of PANEL_COINS) {
    try {
      const rows = await fetchBinanceDaily(coin);
      if (rows.length < 200) {
        failed.push(`${coin}:short(${rows.length})`);
        continue;
      }
      const byDay = new Map<string, [number, number]>();
      for (const [ts, close, qvol] of rows) {
        const day = isoDay(ts);
        byDay.set(day, [close, qvol]);
        dateSet.add(day);
      }
      perCoin.set(coin, byDay);
      fetched.push(coin);
      process.stdout.write(`  ${coin}(${rows.length}) `);
    } catch (err) {
      failed.push(`${coin}:${(err as Error).message}`);
    }
  }
  process.stdout.write("\n");

  if (fetched.length < 20) {
    throw new Error(
      `only ${fetched.length} coins fetched (need >=20). failed=${failed.join(",")}`,
    );
  }

  // Common, sorted date axis (intersection-free union; forward-fill within coin).
  const dates = Array.from(dateSet).sort();
  const close: Record<string, number[]> = {};
  const quoteVolume: Record<string, number[]> = {};

  for (const coin of fetched) {
    const byDay = perCoin.get(coin)!;
    const c: number[] = [];
    const v: number[] = [];
    let lastClose = NaN;
    for (const d of dates) {
      const row = byDay.get(d);
      if (row) {
        lastClose = row[0];
        c.push(row[0]);
        v.push(row[1]);
      } else {
        // coin not yet listed / gap: NaN close, 0 volume (no trading attributed)
        c.push(Number.isFinite(lastClose) ? lastClose : NaN);
        v.push(0);
      }
    }
    close[coin] = c;
    quoteVolume[coin] = v;
  }

  const out = {
    experiment: "c1-rotation-volume-panel",
    source: "binance",
    realData: true,
    generatedAt: new Date().toISOString(),
    note: "Daily QUOTE volume (USDT dollar volume, kline idx 7) + close (idx 4). Survivorship-biased (coins liquid TODAY); edge is an UPPER BOUND.",
    coins: fetched,
    failed,
    dates,
    close,
    quoteVolume,
  };
  writeFileSync(
    "output/c1-rotation/volume-panel.json",
    JSON.stringify(out),
    "utf8",
  );
  console.log(
    `[fetch] wrote ${fetched.length} coins, ${dates.length} days -> output/c1-rotation/volume-panel.json`,
  );
  console.log(`[fetch] failed: ${failed.length ? failed.join(", ") : "none"}`);
  console.log(`[fetch] window: ${dates[0]} .. ${dates[dates.length - 1]}`);
}

main().catch((err) => {
  console.error("[fetch] FATAL", err);
  process.exit(1);
});
