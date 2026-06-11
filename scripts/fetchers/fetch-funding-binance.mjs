#!/usr/bin/env node
/**
 * fetch-funding-binance.mjs — recommit of the fetcher behind output/funding/
 * (PROJECT_REVIEW_2026-06-09.md §2 fix 8 — reproducibility gap).
 *
 * Produces, for each symbol:
 *   {SYM}_funding_8h.json    — [{fundingTime:<ms number, raw API value>, fundingRate:<number>}, ...]
 *   {SYM}_prices_daily.json  — [{date:"YYYY-MM-DD", spotClose:<number>, perpClose:<number>}, ...]
 * plus a single manifest.json matching the committed output/funding/manifest.json shape.
 *
 * Sources (free, public, key-less):
 *   https://fapi.binance.com/fapi/v1/fundingRate   (8h perpetual funding, paginated, history to 2019)
 *   https://fapi.binance.com/fapi/v1/klines        (perp daily closes)
 *   https://api.binance.com/api/v3/klines          (spot daily closes)
 *
 * Usage:
 *   node scripts/fetchers/fetch-funding-binance.mjs \
 *     --symbols BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT \
 *     --start 2023-06-01 --end 2026-05-31 --out output/funding
 *
 *   node scripts/fetchers/fetch-funding-binance.mjs --selftest
 *     (1 symbol, ~3 days, writes to /tmp/fetchers-selftest/funding-binance/, prints PASS/FAIL)
 *
 * Notes:
 *   - fundingRate/closes are stored as JS numbers (Number(<api string>)), matching the cache.
 *   - fundingTime keeps the raw API millisecond value (Binance jitters a few ms past the 8h mark).
 *   - --end is inclusive (end-of-day UTC).
 *   - Polite pacing: >=1.1 s between requests (FETCH_DELAY_MS env to override).
 *   - For survivorship-free panels including DELISTED perps (e.g. FTTUSDT), use the monthly
 *     dumps at data.binance.vision/data/futures/um/monthly/fundingRate/ — the REST endpoint
 *     only serves listed symbols. See scripts/fetchers/README.md.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const DAY_MS = 86_400_000;
const SLEEP_MS = Number(process.env.FETCH_DELAY_MS ?? 1100);
const DEFAULT_SYMBOLS = "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function getJson(url) {
  const wait = lastRequestAt + SLEEP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "crypto-edge-search-fetchers/1.0" } });
      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        process.stderr.write(`HTTP ${res.status} (attempt ${attempt}) ${url}\n`);
        await sleep(2000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`unreachable: ${url}`);
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const parseDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`bad date: ${s} (want YYYY-MM-DD)`);
  return Date.parse(`${s}T00:00:00.000Z`);
};

async function fetchFunding(symbol, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const url =
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const page = await getJson(url);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page) {
      out.push({ fundingTime: Number(r.fundingTime), fundingRate: Number(r.fundingRate) });
    }
    if (page.length < 1000) break;
    cursor = Number(page[page.length - 1].fundingTime) + 1;
  }
  out.sort((a, b) => a.fundingTime - b.fundingTime);
  return out.filter((r, i) => i === 0 || r.fundingTime !== out[i - 1].fundingTime);
}

async function fetchDailyCloses(baseUrl, symbol, startMs, endMs) {
  const closes = new Map(); // "YYYY-MM-DD" -> Number(close)
  let cursor = startMs;
  while (cursor <= endMs) {
    const url =
      `${baseUrl}?symbol=${symbol}&interval=1d&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const page = await getJson(url);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const k of page) closes.set(utcDate(k[0]), Number(k[4]));
    if (page.length < 1000) break;
    cursor = page[page.length - 1][0] + DAY_MS;
  }
  return closes;
}

function buildPriceRows(spotCloses, perpCloses) {
  const rows = [];
  for (const date of [...spotCloses.keys()].sort()) {
    if (!perpCloses.has(date)) continue;
    rows.push({ date, spotClose: spotCloses.get(date), perpClose: perpCloses.get(date) });
  }
  return rows;
}

function summarize(funding, prices) {
  const n = funding.length;
  const mean = n ? funding.reduce((s, r) => s + r.fundingRate, 0) / n : 0;
  const pos = n ? funding.filter((r) => r.fundingRate > 0).length / n : 0;
  return {
    source: "binance_public_rest",
    fundingCount: n,
    priceCount: prices.length,
    meanFundingRate: mean,
    positiveFraction: pos,
    firstFunding: n ? new Date(funding[0].fundingTime).toISOString() : null,
    lastFunding: n ? new Date(funding[n - 1].fundingTime).toISOString() : null,
  };
}

async function fetchSymbol(symbol, startMs, endMs) {
  const funding = await fetchFunding(symbol, startMs, endMs);
  const spot = await fetchDailyCloses("https://api.binance.com/api/v3/klines", symbol, startMs, endMs);
  const perp = await fetchDailyCloses("https://fapi.binance.com/fapi/v1/klines", symbol, startMs, endMs);
  const prices = buildPriceRows(spot, perp);
  return { funding, prices };
}

function writeOutputs(outDir, results, startMs, endMs) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    experiment: "funding-carry",
    source: "binance_public_rest",
    reason: null,
    fetchedAt: new Date().toISOString(),
    requestedYears: Math.round(((endMs - startMs) / DAY_MS / 365.25) * 100) / 100,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    symbols: {},
  };
  for (const [symbol, { funding, prices }] of results) {
    fs.writeFileSync(path.join(outDir, `${symbol}_funding_8h.json`), JSON.stringify(funding));
    fs.writeFileSync(path.join(outDir, `${symbol}_prices_daily.json`), JSON.stringify(prices));
    manifest.symbols[symbol] = summarize(funding, prices);
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------- selftest ----------

function validateShapes(outDir, symbol) {
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };

  const funding = JSON.parse(fs.readFileSync(path.join(outDir, `${symbol}_funding_8h.json`), "utf8"));
  check(Array.isArray(funding), "funding: not an array");
  check(funding.length >= 8, `funding: expected >=8 records over 3 days, got ${funding.length}`);
  for (const r of funding.slice(0, 50)) {
    check(typeof r.fundingTime === "number" && Number.isFinite(r.fundingTime), "funding: fundingTime not a number");
    check(typeof r.fundingRate === "number" && Number.isFinite(r.fundingRate), "funding: fundingRate not a number");
    check(Object.keys(r).length === 2, `funding: extra keys ${Object.keys(r)}`);
  }
  for (let i = 1; i < funding.length; i++) {
    check(funding[i].fundingTime > funding[i - 1].fundingTime, "funding: not strictly ascending");
  }

  const prices = JSON.parse(fs.readFileSync(path.join(outDir, `${symbol}_prices_daily.json`), "utf8"));
  check(Array.isArray(prices), "prices: not an array");
  check(prices.length >= 3, `prices: expected >=3 daily rows, got ${prices.length}`);
  for (const r of prices) {
    check(/^\d{4}-\d{2}-\d{2}$/.test(r.date), `prices: bad date ${r.date}`);
    check(typeof r.spotClose === "number" && r.spotClose > 0, "prices: spotClose not a positive number");
    check(typeof r.perpClose === "number" && r.perpClose > 0, "prices: perpClose not a positive number");
    check(Object.keys(r).length === 3, `prices: extra keys ${Object.keys(r)}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  for (const k of ["experiment", "source", "fetchedAt", "startIso", "endIso", "symbols"]) {
    check(k in manifest, `manifest: missing key ${k}`);
  }
  const s = manifest.symbols?.[symbol] ?? {};
  for (const k of ["source", "fundingCount", "priceCount", "meanFundingRate", "positiveFraction", "firstFunding", "lastFunding"]) {
    check(k in s, `manifest.symbols.${symbol}: missing key ${k}`);
  }
  return { errors, sample: { funding: funding[0], price: prices[0] } };
}

async function selftest() {
  const outDir = "/tmp/fetchers-selftest/funding-binance";
  const symbol = "BTCUSDT";
  const startMs = parseDay("2024-06-01");
  const endMs = parseDay("2024-06-03") + DAY_MS - 1;
  console.log(`[selftest] ${symbol} ${utcDate(startMs)} -> ${utcDate(endMs)} -> ${outDir}`);
  const results = new Map([[symbol, await fetchSymbol(symbol, startMs, endMs)]]);
  writeOutputs(outDir, results, startMs, endMs);
  const { errors, sample } = validateShapes(outDir, symbol);
  console.log(`[selftest] sample funding record: ${JSON.stringify(sample.funding)}`);
  console.log(`[selftest] sample price record:   ${JSON.stringify(sample.price)}`);
  if (errors.length) {
    console.log(`[selftest] FAIL\n - ${errors.join("\n - ")}`);
    process.exit(1);
  }
  console.log("[selftest] PASS");
}

// ---------- main ----------

async function main() {
  const { values } = parseArgs({
    options: {
      symbols: { type: "string", default: DEFAULT_SYMBOLS },
      start: { type: "string", default: "2023-06-01" },
      end: { type: "string", default: "2026-05-31" },
      out: { type: "string", default: "output/funding" },
      selftest: { type: "boolean", default: false },
    },
  });
  if (values.selftest) return selftest();

  const symbols = values.symbols.split(",").map((s) => s.trim()).filter(Boolean);
  const startMs = parseDay(values.start);
  const endMs = parseDay(values.end) + DAY_MS - 1; // inclusive end-of-day UTC
  const results = new Map();
  for (const symbol of symbols) {
    console.log(`[fetch] ${symbol} funding + daily prices ${values.start} -> ${values.end}`);
    results.set(symbol, await fetchSymbol(symbol, startMs, endMs));
  }
  const manifest = writeOutputs(values.out, results, startMs, endMs);
  for (const [sym, s] of Object.entries(manifest.symbols)) {
    console.log(`[done] ${sym}: ${s.fundingCount} funding, ${s.priceCount} prices`);
  }
  console.log(`[done] wrote ${values.out}/manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
