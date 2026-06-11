#!/usr/bin/env node
/**
 * fetch-funding-bybit-okx.mjs — recommit of the fetcher behind the per-venue files in
 * output/carry/ (PROJECT_REVIEW_2026-06-09.md §2 fix 8 — reproducibility gap).
 *
 * Produces, for each symbol and venue:
 *   bybit_{SYM}_funding_8h.json — [{fundingTime:<ms number>, fundingRate:<number>}, ...]
 *   okx_{SYM}_funding_8h.json   — same shape
 * plus manifest.json matching the committed output/carry/manifest.json shape
 * (experiment "multivenue-carry-d1", venues.bybit/okx per-symbol stats).
 *
 * Optional: --depth also captures the Binance BTC/ETH order-book snapshots
 *   {SYM}_spot_depth.json — raw https://api.binance.com/api/v3/depth?limit=1000 response
 *   {SYM}_perp_depth.json — raw https://fapi.binance.com/fapi/v1/depth?limit=1000 response
 * NOTE: depth snapshots are point-in-time; the committed ones (2026-05-31) cannot be
 * re-fetched retroactively — re-running refreshes them to "now".
 *
 * Sources (free, public, key-less):
 *   https://api.bybit.com/v5/market/funding/history   (category=linear, limit 200/page,
 *       full history back past 2023; paginated backwards via endTime)
 *   https://www.okx.com/api/v5/public/funding-rate-history (instId BTC-USDT-SWAP, limit
 *       100/page; OKX only RETAINS ~3 MONTHS — the committed okx_* files cover
 *       2026-02-28 -> 2026-05-31 for exactly this reason and older history is not
 *       re-fetchable from this endpoint)
 *
 * Usage:
 *   node scripts/fetchers/fetch-funding-bybit-okx.mjs \
 *     --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT \
 *     --start 2023-06-01 --end 2026-05-31 --out output/carry --depth
 *
 *   node scripts/fetchers/fetch-funding-bybit-okx.mjs --selftest
 *     (1 symbol, ~3 recent days, writes to /tmp/fetchers-selftest/funding-bybit-okx/)
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const DAY_MS = 86_400_000;
const SLEEP_MS = Number(process.env.FETCH_DELAY_MS ?? 1100);
const DEFAULT_SYMBOLS = "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT";
const DEPTH_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function getJson(url) {
  const wait = lastRequestAt + SLEEP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "crypto-edge-search-fetchers/1.0" } });
      if (res.status === 429 || res.status >= 500) {
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

const parseDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`bad date: ${s} (want YYYY-MM-DD)`);
  return Date.parse(`${s}T00:00:00.000Z`);
};

const sortDedupe = (rows) => {
  rows.sort((a, b) => a.fundingTime - b.fundingTime);
  return rows.filter((r, i) => i === 0 || r.fundingTime !== rows[i - 1].fundingTime);
};

async function fetchBybit(symbol, startMs, endMs) {
  const out = [];
  let end = endMs;
  for (;;) {
    const url =
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}` +
      `&startTime=${startMs}&endTime=${end}&limit=200`;
    const body = await getJson(url);
    if (body.retCode !== 0) throw new Error(`bybit retCode ${body.retCode}: ${body.retMsg}`);
    const list = body.result?.list ?? []; // descending
    if (list.length === 0) break;
    for (const r of list) {
      out.push({ fundingTime: Number(r.fundingRateTimestamp), fundingRate: Number(r.fundingRate) });
    }
    const oldest = Number(list[list.length - 1].fundingRateTimestamp);
    if (oldest <= startMs || list.length < 200) break;
    end = oldest - 1;
  }
  return sortDedupe(out.filter((r) => r.fundingTime >= startMs && r.fundingTime <= endMs));
}

async function fetchOkx(symbol, startMs, endMs) {
  const instId = `${symbol.replace(/USDT$/, "")}-USDT-SWAP`;
  const out = [];
  let after = "";
  for (;;) {
    const url =
      `https://www.okx.com/api/v5/public/funding-rate-history?instId=${instId}&limit=100` +
      (after ? `&after=${after}` : "");
    const body = await getJson(url);
    if (body.code !== "0") throw new Error(`okx code ${body.code}: ${body.msg}`);
    const list = body.data ?? []; // descending; retention ~3 months only
    if (list.length === 0) break;
    for (const r of list) {
      out.push({ fundingTime: Number(r.fundingTime), fundingRate: Number(r.fundingRate) });
    }
    const oldest = list[list.length - 1].fundingTime;
    if (Number(oldest) <= startMs || list.length < 100) break;
    after = oldest;
  }
  return sortDedupe(out.filter((r) => r.fundingTime >= startMs && r.fundingTime <= endMs));
}

function venueStats(source, rows) {
  const n = rows.length;
  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push((rows[i].fundingTime - rows[i - 1].fundingTime) / 3_600_000);
  gaps.sort((a, b) => a - b);
  return {
    source,
    fundingCount: n,
    medianGapHours: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    meanFundingRate: n ? rows.reduce((s, r) => s + r.fundingRate, 0) / n : 0,
    positiveFraction: n ? rows.filter((r) => r.fundingRate > 0).length / n : 0,
    firstFunding: n ? new Date(rows[0].fundingTime).toISOString() : null,
    lastFunding: n ? new Date(rows[n - 1].fundingTime).toISOString() : null,
  };
}

async function fetchDepthSnapshots(outDir) {
  for (const sym of DEPTH_SYMBOLS) {
    const spot = await getJson(`https://api.binance.com/api/v3/depth?symbol=${sym}&limit=1000`);
    fs.writeFileSync(path.join(outDir, `${sym}_spot_depth.json`), JSON.stringify(spot));
    const perp = await getJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=1000`);
    fs.writeFileSync(path.join(outDir, `${sym}_perp_depth.json`), JSON.stringify(perp));
    console.log(`[depth] ${sym}: spot ${spot.bids?.length} bids, perp ${perp.bids?.length} bids`);
  }
}

// ---------- selftest ----------

function validateShapes(outDir, symbol, venues) {
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };
  const samples = {};

  for (const venue of venues) {
    const file = path.join(outDir, `${venue}_${symbol}_funding_8h.json`);
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    check(Array.isArray(rows), `${venue}: not an array`);
    check(rows.length >= 8, `${venue}: expected >=8 records over 3 days, got ${rows.length}`);
    for (const r of rows.slice(0, 50)) {
      check(typeof r.fundingTime === "number" && Number.isFinite(r.fundingTime), `${venue}: fundingTime not a number`);
      check(typeof r.fundingRate === "number" && Number.isFinite(r.fundingRate), `${venue}: fundingRate not a number`);
      check(Object.keys(r).length === 2, `${venue}: extra keys ${Object.keys(r)}`);
    }
    for (let i = 1; i < rows.length; i++) {
      check(rows[i].fundingTime > rows[i - 1].fundingTime, `${venue}: not strictly ascending`);
    }
    samples[venue] = rows[0];
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  for (const k of ["experiment", "fetchedAt", "startIso", "endIso", "venues"]) {
    check(k in manifest, `manifest: missing key ${k}`);
  }
  for (const venue of venues) {
    const s = manifest.venues?.[venue]?.[symbol] ?? {};
    for (const k of ["source", "fundingCount", "medianGapHours", "meanFundingRate", "positiveFraction", "firstFunding", "lastFunding"]) {
      check(k in s, `manifest.venues.${venue}.${symbol}: missing key ${k}`);
    }
  }
  return { errors, samples };
}

async function selftest() {
  const outDir = "/tmp/fetchers-selftest/funding-bybit-okx";
  fs.mkdirSync(outDir, { recursive: true });
  const symbol = "BTCUSDT";
  // OKX retains only ~3 months, so the selftest window must be recent.
  const endMs = Math.floor(Date.now() / DAY_MS) * DAY_MS - 1;
  const startMs = endMs + 1 - 3 * DAY_MS;
  console.log(`[selftest] ${symbol} last 3 days -> ${outDir}`);

  const bybit = await fetchBybit(symbol, startMs, endMs);
  fs.writeFileSync(path.join(outDir, `bybit_${symbol}_funding_8h.json`), JSON.stringify(bybit));
  const okx = await fetchOkx(symbol, startMs, endMs);
  fs.writeFileSync(path.join(outDir, `okx_${symbol}_funding_8h.json`), JSON.stringify(okx));
  const manifest = {
    experiment: "multivenue-carry-d1",
    fetchedAt: new Date().toISOString(),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    venues: {
      bybit: { [symbol]: venueStats("bybit_public_rest", bybit) },
      okx: { [symbol]: venueStats("okx_public_rest", okx) },
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const { errors, samples } = validateShapes(outDir, symbol, ["bybit", "okx"]);
  console.log(`[selftest] sample bybit record: ${JSON.stringify(samples.bybit)}`);
  console.log(`[selftest] sample okx record:   ${JSON.stringify(samples.okx)}`);
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
      out: { type: "string", default: "output/carry" },
      venues: { type: "string", default: "bybit,okx" },
      depth: { type: "boolean", default: false },
      selftest: { type: "boolean", default: false },
    },
  });
  if (values.selftest) return selftest();

  const symbols = values.symbols.split(",").map((s) => s.trim()).filter(Boolean);
  const venues = values.venues.split(",").map((s) => s.trim()).filter(Boolean);
  const startMs = parseDay(values.start);
  const endMs = parseDay(values.end) + DAY_MS - 1; // inclusive end-of-day UTC
  fs.mkdirSync(values.out, { recursive: true });

  const manifest = {
    experiment: "multivenue-carry-d1",
    fetchedAt: new Date().toISOString(),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    venues: {},
  };
  for (const venue of venues) {
    manifest.venues[venue] = {};
    for (const symbol of symbols) {
      console.log(`[fetch] ${venue} ${symbol} funding ${values.start} -> ${values.end}`);
      const rows = venue === "bybit"
        ? await fetchBybit(symbol, startMs, endMs)
        : await fetchOkx(symbol, startMs, endMs);
      fs.writeFileSync(path.join(values.out, `${venue}_${symbol}_funding_8h.json`), JSON.stringify(rows));
      manifest.venues[venue][symbol] = venueStats(`${venue}_public_rest`, rows);
      console.log(`[done] ${venue} ${symbol}: ${rows.length} records`);
    }
  }
  fs.writeFileSync(path.join(values.out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[done] wrote ${values.out}/manifest.json`);
  if (values.depth) await fetchDepthSnapshots(values.out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
