/**
 * fetch-market-structure.mjs — TRACK D4 (capacity + decay).
 *
 * Pulls LIVE public market-structure data needed to bound carry CAPACITY:
 *   - Order-book depth (perp) on Binance fapi, Bybit linear, OKX swap
 *   - Open interest (perp) per venue
 *   - Current funding rate per venue
 *   - Spot order-book depth on Binance (the long leg)
 *
 * All endpoints are PUBLIC (no auth). If a venue is network-blocked we record the
 * error and continue; the consumer marks those as estimated.
 *
 * Writes: output/carry/market-structure.json
 *
 * Usage: node scripts/carry/fetch-market-structure.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join("output", "carry");
mkdirSync(OUT_DIR, { recursive: true });

// 8 majors used everywhere in this repo's funding set.
const MAJORS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Sum notional ($) of book within +/- bpsBand of mid, both sides averaged. */
function depthWithinBand(bids, asks, bpsBand) {
  const bestBid = Number(bids?.[0]?.[0]);
  const bestAsk = Number(asks?.[0]?.[0]);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  const mid = (bestBid + bestAsk) / 2;
  const lo = mid * (1 - bpsBand / 10000);
  const hi = mid * (1 + bpsBand / 10000);
  let bidNotional = 0;
  for (const [p, q] of bids) {
    const px = Number(p);
    if (px < lo) break;
    bidNotional += px * Number(q);
  }
  let askNotional = 0;
  for (const [p, q] of asks) {
    const px = Number(p);
    if (px > hi) break;
    askNotional += px * Number(q);
  }
  return { mid, bidNotional, askNotional, oneSide: (bidNotional + askNotional) / 2 };
}

async function binancePerp(base) {
  const sym = `${base}USDT`;
  const [depth, oi, prem] = await Promise.all([
    getJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=1000`),
    getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`),
    getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`),
  ]);
  const mark = Number(prem.markPrice);
  const bands = {};
  for (const b of [5, 10, 25, 50]) bands[b] = depthWithinBand(depth.bids, depth.asks, b);
  return {
    venue: "binance",
    symbol: sym,
    markPrice: mark,
    lastFundingRate: Number(prem.lastFundingRate),
    nextFundingTime: prem.nextFundingTime,
    openInterestContracts: Number(oi.openInterest),
    openInterestUsd: Number(oi.openInterest) * mark,
    depthBands: bands,
  };
}

async function binanceSpot(base) {
  const sym = `${base}USDT`;
  const depth = await getJson(`https://api.binance.com/api/v3/depth?symbol=${sym}&limit=1000`);
  const bands = {};
  for (const b of [5, 10, 25, 50]) bands[b] = depthWithinBand(depth.bids, depth.asks, b);
  return { venue: "binance-spot", symbol: sym, depthBands: bands };
}

async function bybitPerp(base) {
  const sym = `${base}USDT`;
  const [tick, ob] = await Promise.all([
    getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`),
    getJson(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${sym}&limit=200`),
  ]);
  const t = tick.result.list[0];
  const bids = ob.result.b;
  const asks = ob.result.a;
  const bands = {};
  for (const b of [5, 10, 25, 50]) bands[b] = depthWithinBand(bids, asks, b);
  return {
    venue: "bybit",
    symbol: sym,
    markPrice: Number(t.markPrice),
    lastFundingRate: Number(t.fundingRate),
    openInterestContracts: Number(t.openInterest),
    openInterestUsd: Number(t.openInterestValue),
    turnover24hUsd: Number(t.turnover24h),
    depthBands: bands,
  };
}

async function okxPerp(base) {
  const inst = `${base}-USDT-SWAP`;
  const [ob, oi, fr, tick] = await Promise.all([
    getJson(`https://www.okx.com/api/v5/market/books?instId=${inst}&sz=400`),
    getJson(`https://www.okx.com/api/v5/public/open-interest?instId=${inst}`),
    getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${inst}`),
    getJson(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`),
  ]);
  const bids = ob.data[0].bids.map((r) => [r[0], r[1]]);
  const asks = ob.data[0].asks.map((r) => [r[0], r[1]]);
  const bands = {};
  for (const b of [5, 10, 25, 50]) bands[b] = depthWithinBand(bids, asks, b);
  return {
    venue: "okx",
    symbol: inst,
    markPrice: Number(tick.data[0].last),
    lastFundingRate: Number(fr.data[0].fundingRate),
    openInterestUsd: Number(oi.data[0].oiCcy) * Number(tick.data[0].last),
    depthBands: bands,
  };
}

async function safe(label, fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), label };
  }
}

async function main() {
  const out = { fetchedAt: new Date().toISOString(), majors: {} };
  for (const base of MAJORS) {
    process.stderr.write(`fetching ${base} ...\n`);
    const [bp, bs, by, ok] = await Promise.all([
      safe(`binance-perp-${base}`, () => binancePerp(base)),
      safe(`binance-spot-${base}`, () => binanceSpot(base)),
      safe(`bybit-perp-${base}`, () => bybitPerp(base)),
      safe(`okx-perp-${base}`, () => okxPerp(base)),
    ]);
    out.majors[base] = { binancePerp: bp, binanceSpot: bs, bybitPerp: by, okxPerp: ok };
    await new Promise((r) => setTimeout(r, 250));
  }
  const path = join(OUT_DIR, "market-structure.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  // quick console summary
  let okCount = 0,
    total = 0;
  for (const base of MAJORS) {
    for (const k of ["binancePerp", "binanceSpot", "bybitPerp", "okxPerp"]) {
      total += 1;
      if (out.majors[base][k].ok) okCount += 1;
    }
  }
  process.stderr.write(`\nWROTE ${path}\nlegs OK: ${okCount}/${total}\n`);
  const btc = out.majors.BTC;
  if (btc.binancePerp.ok) {
    const d = btc.binancePerp.depthBands;
    process.stderr.write(
      `BTC binance perp OI=$${(btc.binancePerp.openInterestUsd / 1e9).toFixed(2)}B | depth +/-10bps oneSide=$${(d[10].oneSide / 1e6).toFixed(2)}M +/-25bps=$${(d[25].oneSide / 1e6).toFixed(2)}M\n`,
    );
  }
}

main().catch((e) => {
  process.stderr.write(`FATAL ${e}\n`);
  process.exit(1);
});
