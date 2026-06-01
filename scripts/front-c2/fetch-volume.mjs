/**
 * FRONT C2 — fetch DAILY quote-volume for the fixed 30-coin panel.
 *
 * The committed cross-sectional panel (output/crossxs/daily-closes.json) has
 * closes only. The C2 dominance test needs a SECOND, independent definition of
 * "dominant" = highest VOLUME SHARE. We fetch daily quote-volume (USDT) from the
 * SAME Binance public REST endpoint, aligned to the SAME date axis as the panel
 * (so the two series are directly comparable). Free, no auth, Cloud $0.
 *
 * If Binance is blocked we abort WITHOUT writing — the C2 analysis then runs on
 * return-dominance only and reports the volume leg as "unavailable" (honest).
 *
 * Output: output/front-c2/daily-volume.json
 *   { source, realData, dates[], volume: { COIN: number[] aligned to dates } }
 *
 * Run: PATH=<codex-node-bin>:$PATH node scripts/front-c2/fetch-volume.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "output", "front-c2");
mkdirSync(OUT_DIR, { recursive: true });

const closes = JSON.parse(
  readFileSync(join(ROOT, "output", "crossxs", "daily-closes.json"), "utf8"),
);
const DATES = closes.dates; // 'YYYY-MM-DD'
const COINS = Object.keys(closes.closes);
const DATE_INDEX = new Map(DATES.map((d, i) => [d, i]));
const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.parse(DATES[0] + "T00:00:00Z") - DAY_MS;
const END_MS = Date.parse(DATES[DATES.length - 1] + "T00:00:00Z") + DAY_MS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDaily(symbol) {
  const pair = `${symbol}USDT`;
  const out = new Array(DATES.length).fill(null);
  let cursor = START_MS;
  for (let page = 0; page < 60; page += 1) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d` +
      `&startTime=${cursor}&endTime=${END_MS}&limit=1000`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`network:${err?.name ?? "err"}`);
    }
    if (res.status === 451 || res.status === 403) throw new Error(`blocked:${res.status}`);
    if (!res.ok) throw new Error(`http:${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const iso = new Date(r[0]).toISOString().slice(0, 10);
      const idx = DATE_INDEX.get(iso);
      if (idx !== undefined) out[idx] = Number(r[7]); // quote asset volume (USDT)
    }
    const last = rows[rows.length - 1][0];
    cursor = last + DAY_MS;
    if (rows.length < 1000 || cursor > END_MS) break;
    await sleep(120);
  }
  return out;
}

(async () => {
  const volume = {};
  let ok = 0;
  for (const c of COINS) {
    try {
      volume[c] = await fetchDaily(c);
      const n = volume[c].filter((v) => v != null && Number.isFinite(v)).length;
      ok += 1;
      console.log(`  ${c}: ${n}/${DATES.length} days`);
    } catch (err) {
      console.error(`FATAL fetching ${c}: ${err.message}; aborting (volume leg unavailable).`);
      process.exit(2);
    }
    await sleep(150);
  }
  writeFileSync(
    join(OUT_DIR, "daily-volume.json"),
    JSON.stringify({ source: "binance", realData: true, dates: DATES, volume }, null, 0),
  );
  console.log(`Wrote output/front-c2/daily-volume.json (${ok}/${COINS.length} coins).`);
})();
