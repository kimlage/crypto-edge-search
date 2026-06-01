#!/usr/bin/env node
/**
 * fetch-funding-rates.mjs — EXPERIMENT 2 (funding-rate carry feasibility).
 *
 * Pulls REAL historical 8h funding rates + daily spot/perp closes for ~8 majors
 * from Binance USDT-perp public REST (no auth). Falls back to a calibrated
 * synthetic series ONLY if the network is blocked (clearly labeled in the saved
 * manifest with source="synthetic").
 *
 * Endpoints (free, public, no key):
 *   funding : https://fapi.binance.com/fapi/v1/fundingRate?symbol=...&startTime=...&limit=1000
 *   perp px : https://fapi.binance.com/fapi/v1/klines?symbol=...&interval=1d&startTime=...&limit=1000
 *   spot px : https://api.binance.com/api/v3/klines?symbol=...&interval=1d&startTime=...&limit=1000
 *
 * Output (disjoint dir): output/funding/
 *   <SYMBOL>_funding_8h.json    — [{ fundingTime, fundingRate }]
 *   <SYMBOL>_prices_daily.json  — [{ date, spotClose, perpClose }]
 *   manifest.json               — source, span, counts, fetchedAt
 *
 * Usage: node scripts/fetch-funding-rates.mjs [--years 3] [--force-synth]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
const OUT_DIR = join("output", "funding");
const FAPI = "https://fapi.binance.com";
const SAPI = "https://api.binance.com";
const DAY_MS = 86_400_000;
const EIGHT_H_MS = 8 * 60 * 60 * 1000;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function hasFlag(flag) {
  return process.argv.includes(flag);
}

const YEARS = Number(arg("--years", "3"));
const FORCE_SYNTH = hasFlag("--force-synth");

async function fetchJson(url, { tries = 4 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status === 418) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("fetch failed");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Paginate funding rate history forward by startTime. */
async function fetchFunding(symbol, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  // Hard cap pages so a misbehaving endpoint can't loop forever (~3y = ~4 pages).
  for (let page = 0; page < 40; page += 1) {
    const url = `${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({ fundingTime: Number(r.fundingTime), fundingRate: Number(r.fundingRate) });
    }
    const last = Number(rows[rows.length - 1].fundingTime);
    if (rows.length < 1000 || last >= endMs) break;
    cursor = last + 1;
    await sleep(200);
  }
  // de-dup + sort
  const seen = new Set();
  return out
    .filter((r) => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate))
    .filter((r) => (seen.has(r.fundingTime) ? false : (seen.add(r.fundingTime), true)))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}

/** Daily closes (perp or spot) keyed by UTC date string. */
async function fetchDailyCloses(base, symbol, startMs, endMs) {
  const out = new Map();
  let cursor = startMs;
  for (let page = 0; page < 40; page += 1) {
    const url = `${base}/${base === FAPI ? "fapi/v1" : "api/v3"}/klines?symbol=${symbol}&interval=1d&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows) {
      const openTime = Number(k[0]);
      const close = Number(k[4]);
      const date = new Date(openTime).toISOString().slice(0, 10);
      out.set(date, close);
    }
    const last = Number(rows[rows.length - 1][0]);
    if (rows.length < 1000 || last >= endMs) break;
    cursor = last + DAY_MS;
    await sleep(200);
  }
  return out;
}

/**
 * Calibrated synthetic fallback (clearly labeled). Mean ~+0.01%/8h, positive
 * ~85% of periods, occasional sustained negative regimes + a few sharp spikes.
 * Deterministic via a seeded PRNG so the pipeline is reproducible.
 */
function synthFunding(symbol, startMs, endMs) {
  const rng = mulberry32(hash(symbol));
  const out = [];
  let regime = 1; // +1 positive-carry regime, -1 negative regime
  let regimeLeft = 60 + Math.floor(rng() * 120);
  for (let t = startMs; t <= endMs; t += EIGHT_H_MS) {
    if (regimeLeft-- <= 0) {
      // ~12% of the time flip into a negative-funding regime, else stay/return positive
      regime = rng() < 0.12 ? -1 : 1;
      regimeLeft = regime < 0 ? 9 + Math.floor(rng() * 30) : 80 + Math.floor(rng() * 200);
    }
    const base = regime > 0 ? 0.0001 : -0.00008; // +1bp/8h positive vs -0.8bp negative
    const noise = (rng() - 0.5) * 0.00016;
    let rate = base + noise;
    if (rng() < 0.008) rate += (rng() < 0.5 ? 1 : -1) * (0.0007 + rng() * 0.0018); // sharp spike
    out.push({ fundingTime: t, fundingRate: rate });
  }
  return out;
}
function synthPrices(symbol, startMs, endMs) {
  const rng = mulberry32(hash(symbol) ^ 0x9e3779b9);
  const out = [];
  let px = 100 + rng() * 100;
  for (let t = startMs; t <= endMs; t += DAY_MS) {
    px *= 1 + (rng() - 0.49) * 0.05; // mild drift + 5% daily vol
    const basis = 1 + (rng() - 0.5) * 0.0008; // perp within ~4bp of spot
    out.push({ date: new Date(t).toISOString().slice(0, 10), spotClose: px, perpClose: px * basis });
  }
  return out;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function hash(s) {
  let h = 2_166_136_261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const endMs = Date.now();
  const startMs = endMs - Math.round(YEARS * 365.25 * DAY_MS);

  let source = "binance_public_rest";
  let reason = null;

  // Probe network once unless forced to synth.
  if (!FORCE_SYNTH) {
    try {
      await fetchJson(`${FAPI}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1`);
    } catch (err) {
      source = "synthetic";
      reason = `network probe failed: ${err?.message ?? err}`;
    }
  } else {
    source = "synthetic";
    reason = "forced via --force-synth";
  }

  const manifest = {
    experiment: "funding-carry",
    source,
    reason,
    fetchedAt: new Date().toISOString(),
    requestedYears: YEARS,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    symbols: {},
  };

  for (const symbol of SYMBOLS) {
    let funding;
    let prices;
    if (source === "binance_public_rest") {
      try {
        funding = await fetchFunding(symbol, startMs, endMs);
        const [perp, spot] = await Promise.all([
          fetchDailyCloses(FAPI, symbol, startMs, endMs),
          fetchDailyCloses(SAPI, symbol, startMs, endMs),
        ]);
        const dates = [...perp.keys()].sort();
        prices = dates
          .filter((d) => spot.has(d))
          .map((d) => ({ date: d, spotClose: spot.get(d), perpClose: perp.get(d) }));
        if (funding.length === 0 || prices.length === 0) throw new Error("empty real series");
      } catch (err) {
        // Per-symbol fallback keeps the pipeline whole if one symbol is missing.
        manifest.symbols[symbol] = { fallback: `synthetic (${err?.message ?? err})` };
        funding = synthFunding(symbol, startMs, endMs);
        prices = synthPrices(symbol, startMs, endMs);
        writeFileSync(join(OUT_DIR, `${symbol}_funding_8h.json`), JSON.stringify(funding));
        writeFileSync(join(OUT_DIR, `${symbol}_prices_daily.json`), JSON.stringify(prices));
        manifest.symbols[symbol].fundingCount = funding.length;
        manifest.symbols[symbol].priceCount = prices.length;
        manifest.symbols[symbol].source = "synthetic_per_symbol";
        console.log(`  ${symbol}: SYNTH fallback (${err?.message ?? err})`);
        continue;
      }
    } else {
      funding = synthFunding(symbol, startMs, endMs);
      prices = synthPrices(symbol, startMs, endMs);
    }

    writeFileSync(join(OUT_DIR, `${symbol}_funding_8h.json`), JSON.stringify(funding));
    writeFileSync(join(OUT_DIR, `${symbol}_prices_daily.json`), JSON.stringify(prices));
    const meanRate = funding.reduce((s, r) => s + r.fundingRate, 0) / Math.max(1, funding.length);
    const posRate = funding.filter((r) => r.fundingRate > 0).length / Math.max(1, funding.length);
    manifest.symbols[symbol] = {
      source,
      fundingCount: funding.length,
      priceCount: prices.length,
      meanFundingRate: meanRate,
      positiveFraction: posRate,
      firstFunding: funding[0] ? new Date(funding[0].fundingTime).toISOString() : null,
      lastFunding: funding.length ? new Date(funding[funding.length - 1].fundingTime).toISOString() : null,
    };
    console.log(
      `  ${symbol}: ${source} funding=${funding.length} prices=${prices.length} ` +
        `mean=${(meanRate * 100).toFixed(5)}%/8h pos=${(posRate * 100).toFixed(1)}%`,
    );
  }

  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nSOURCE: ${source}${reason ? ` (${reason})` : ""}`);
  console.log(`Saved ${SYMBOLS.length} symbols under ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
