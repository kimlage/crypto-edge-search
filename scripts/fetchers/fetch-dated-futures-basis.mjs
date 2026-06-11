#!/usr/bin/env node
/**
 * fetch-dated-futures-basis.mjs — recommit of the fetcher behind output/dated-futures/
 * (PROJECT_REVIEW_2026-06-09.md §2 fix 8 — reproducibility gap).
 *
 * Reconstructs the per-contract daily basis series of Binance COIN-M (dapi) quarterly
 * DELIVERY contracts vs spot:
 *
 *   {ASSET}_quarterly_basis.json — [
 *     { symbol: "BTCUSD_220325", deliveryDate: "2022-03-25",
 *       rows: [{ date:"YYYY-MM-DD", future:<1d close>, spot:<1d close>,
 *                basis: (future - spot) / spot }, ...] },
 *     ...
 *   ]
 * (basis is computed exactly as (future - spot) / spot — NOT future/spot - 1, which
 * differs in the last float ulp; verified bit-identical against all 183 cached rows of
 * BTCUSD_250926.)
 * plus manifest.json matching output/dated-futures/manifest.json (experiment
 * "dated-futures-basis"; merged across assets: running BTC then ETH reproduces the
 * combined contracts list).
 *
 * Contract discovery: quarterly delivery = LAST FRIDAY of Mar/Jun/Sep/Dec; symbol
 * {ASSET}USD_{YYMMDD}. Binance dapi still serves klines for EXPIRED contracts when an
 * explicit startTime is passed (verified live: BTCUSD_220325 returns history); a
 * candidate with no klines is skipped. A contract is included only when:
 *   - its delivery date is <= --end (use --end 2025-10-01 to reproduce the committed
 *     cache exactly: 15 contracts per asset, BTCUSD_220325 .. BTCUSD_250926), and
 *   - its FIRST available kline date is >= --start (default 2021-09-01). This is what
 *     excludes e.g. BTCUSD_211231 (listed 2021-06) while keeping BTCUSD_220325
 *     (listed 2021-09-24), matching the committed cache.
 *
 * Sources (free, public, key-less):
 *   https://dapi.binance.com/dapi/v1/klines   (COIN-M delivery contract 1d closes)
 *   https://api.binance.com/api/v3/klines     ({ASSET}USDT spot 1d closes)
 *
 * Usage:
 *   node scripts/fetchers/fetch-dated-futures-basis.mjs --asset BTC --end 2025-10-01 --out output/dated-futures
 *   node scripts/fetchers/fetch-dated-futures-basis.mjs --asset ETH --end 2025-10-01 --out output/dated-futures
 *
 *   node scripts/fetchers/fetch-dated-futures-basis.mjs --selftest
 *     (1 expired contract, ~4 days, writes to /tmp/fetchers-selftest/dated-futures/)
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const DAY_MS = 86_400_000;
const LISTING_LOOKBACK_DAYS = 400; // quarterlies list ~2 quarters before delivery
const SLEEP_MS = Number(process.env.FETCH_DELAY_MS ?? 1100);

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

function lastFridayOfMonth(year, month /* 1-12 */) {
  let t = Date.UTC(year, month, 0); // last day of month
  while (new Date(t).getUTCDay() !== 5) t -= DAY_MS;
  return t;
}

function quarterlyCandidates(asset, startMs, endMs) {
  const out = [];
  const firstYear = new Date(startMs).getUTCFullYear();
  const lastYear = new Date(endMs).getUTCFullYear();
  for (let y = firstYear; y <= lastYear; y++) {
    for (const m of [3, 6, 9, 12]) {
      const deliveryMs = lastFridayOfMonth(y, m);
      if (deliveryMs < startMs || deliveryMs > endMs) continue;
      const d = new Date(deliveryMs);
      const yymmdd =
        String(d.getUTCFullYear()).slice(2) +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        String(d.getUTCDate()).padStart(2, "0");
      out.push({ symbol: `${asset}USD_${yymmdd}`, deliveryDate: utcDate(deliveryMs), deliveryMs });
    }
  }
  return out;
}

async function fetchKlines(baseUrl, symbol, startMs, endMs, pageLimit) {
  const klines = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const url =
      `${baseUrl}?symbol=${symbol}&interval=1d&startTime=${cursor}&endTime=${endMs}&limit=${pageLimit}`;
    const page = await getJson(url);
    if (!Array.isArray(page) || page.length === 0) break;
    klines.push(...page);
    if (page.length < pageLimit) break;
    cursor = page[page.length - 1][0] + DAY_MS;
  }
  return klines; // [openTime, open, high, low, close, ...]
}

async function buildContracts(asset, startMs, endMs) {
  const candidates = quarterlyCandidates(asset, startMs, endMs);
  const contracts = [];
  for (const c of candidates) {
    const from = c.deliveryMs - LISTING_LOOKBACK_DAYS * DAY_MS;
    const to = c.deliveryMs + 2 * DAY_MS; // dapi keeps a kline on/after the delivery day
    const klines = await fetchKlines("https://dapi.binance.com/dapi/v1/klines", c.symbol, from, to, 500);
    if (klines.length === 0) {
      console.log(`[skip] ${c.symbol}: no klines (not listed / no history)`);
      continue;
    }
    const firstMs = klines[0][0];
    if (firstMs < startMs) {
      console.log(`[skip] ${c.symbol}: first kline ${utcDate(firstMs)} < --start ${utcDate(startMs)}`);
      continue;
    }
    contracts.push({ ...c, klines });
    console.log(`[ok]   ${c.symbol}: ${klines.length} daily klines ${utcDate(firstMs)} -> ${utcDate(klines[klines.length - 1][0])}`);
  }
  if (contracts.length === 0) return [];

  // One spot panel covering all contracts.
  const spotFrom = Math.min(...contracts.map((c) => c.klines[0][0]));
  const spotTo = Math.max(...contracts.map((c) => c.klines[c.klines.length - 1][0])) + DAY_MS - 1;
  const spotKlines = await fetchKlines("https://api.binance.com/api/v3/klines", `${asset}USDT`, spotFrom, spotTo, 1000);
  const spotByDate = new Map(spotKlines.map((k) => [utcDate(k[0]), Number(k[4])]));

  return contracts.map((c) => {
    const rows = [];
    for (const k of c.klines) {
      const date = utcDate(k[0]);
      const spot = spotByDate.get(date);
      if (spot === undefined) continue;
      const future = Number(k[4]);
      rows.push({ date, future, spot, basis: (future - spot) / spot });
    }
    return { symbol: c.symbol, deliveryDate: c.deliveryDate, rows };
  }).filter((c) => c.rows.length > 0);
}

function manifestEntries(asset, contracts) {
  return contracts.map((c) => ({
    symbol: c.symbol,
    coin: asset,
    deliveryDate: c.deliveryDate,
    days: c.rows.length,
    firstDate: c.rows[0].date,
    lastDate: c.rows[c.rows.length - 1].date,
    entryBasis: c.rows[0].basis,
    exitBasis: c.rows[c.rows.length - 1].basis,
  }));
}

function writeOutputs(outDir, asset, contracts) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${asset}_quarterly_basis.json`), JSON.stringify(contracts));

  // Merge into manifest.json so BTC + ETH runs reproduce the combined contracts list.
  const manifestPath = path.join(outDir, "manifest.json");
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(manifestPath, "utf8")).contracts ?? [];
  } catch { /* fresh manifest */ }
  const kept = existing.filter((e) => e.coin !== asset);
  const merged = [...kept, ...manifestEntries(asset, contracts)]
    .sort((a, b) => (a.coin === b.coin ? a.deliveryDate.localeCompare(b.deliveryDate) : a.coin.localeCompare(b.coin)));
  const manifest = {
    experiment: "dated-futures-basis",
    source: "binance_public_rest_dapi_delivery",
    fetchedAt: new Date().toISOString(),
    contracts: merged,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------- selftest ----------

function validateShapes(file) {
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  check(Array.isArray(data), "basis: not an array");
  check(data.length >= 1, "basis: no contracts");
  const c = data[0] ?? {};
  check(typeof c.symbol === "string" && /USD_\d{6}$/.test(c.symbol), `basis: bad symbol ${c.symbol}`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(c.deliveryDate ?? ""), `basis: bad deliveryDate ${c.deliveryDate}`);
  check(Array.isArray(c.rows) && c.rows.length >= 3, `basis: expected >=3 rows, got ${c.rows?.length}`);
  check(Object.keys(c).length === 3, `basis: extra contract keys ${Object.keys(c)}`);
  for (const r of (c.rows ?? []).slice(0, 20)) {
    check(/^\d{4}-\d{2}-\d{2}$/.test(r.date), `basis: bad row date ${r.date}`);
    check(typeof r.future === "number" && r.future > 0, "basis: future not a positive number");
    check(typeof r.spot === "number" && r.spot > 0, "basis: spot not a positive number");
    check(typeof r.basis === "number" && r.basis === (r.future - r.spot) / r.spot,
      "basis: basis !== (future - spot) / spot");
    check(Object.keys(r).length === 4, `basis: extra row keys ${Object.keys(r)}`);
  }
  return { errors, sample: c.rows?.[0], symbol: c.symbol };
}

async function selftest() {
  const outDir = "/tmp/fetchers-selftest/dated-futures";
  fs.mkdirSync(outDir, { recursive: true });
  // One known-expired contract, ~4 days of klines — exercises the dapi expired-contract path.
  const symbol = "BTCUSD_250926";
  const from = parseDay("2025-09-20");
  const to = parseDay("2025-09-23") + DAY_MS - 1;
  console.log(`[selftest] ${symbol} ${utcDate(from)} -> ${utcDate(to)} -> ${outDir}`);

  const klines = await fetchKlines("https://dapi.binance.com/dapi/v1/klines", symbol, from, to, 500);
  const spotKlines = await fetchKlines("https://api.binance.com/api/v3/klines", "BTCUSDT", from, to, 1000);
  const spotByDate = new Map(spotKlines.map((k) => [utcDate(k[0]), Number(k[4])]));
  const rows = klines.flatMap((k) => {
    const date = utcDate(k[0]);
    const spot = spotByDate.get(date);
    if (spot === undefined) return [];
    const future = Number(k[4]);
    return [{ date, future, spot, basis: (future - spot) / spot }];
  });
  const file = path.join(outDir, "BTC_quarterly_basis.json");
  fs.writeFileSync(file, JSON.stringify([{ symbol, deliveryDate: "2025-09-26", rows }]));

  const { errors, sample } = validateShapes(file);
  console.log(`[selftest] sample row: ${JSON.stringify(sample)}`);
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
      asset: { type: "string", default: "BTC" }, // BTC | ETH
      start: { type: "string", default: "2021-09-01" },
      end: { type: "string", default: utcDate(Date.now()) },
      out: { type: "string", default: "output/dated-futures" },
      selftest: { type: "boolean", default: false },
    },
  });
  if (values.selftest) return selftest();

  const asset = values.asset.toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(asset)) throw new Error(`bad --asset: ${values.asset}`);
  const startMs = parseDay(values.start);
  const endMs = parseDay(values.end) + DAY_MS - 1;

  console.log(`[fetch] ${asset} quarterly delivery contracts, delivery <= ${values.end}, first kline >= ${values.start}`);
  const contracts = await buildContracts(asset, startMs, endMs);
  if (contracts.length === 0) {
    console.error("[error] no contracts matched — nothing written");
    process.exit(1);
  }
  const manifest = writeOutputs(values.out, asset, contracts);
  console.log(`[done] ${asset}: ${contracts.length} contracts -> ${values.out}/${asset}_quarterly_basis.json`);
  console.log(`[done] manifest now lists ${manifest.contracts.length} contracts total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
