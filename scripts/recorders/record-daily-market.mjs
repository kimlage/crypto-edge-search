// Campaign-E — daily $0 market recorder (append-only; pattern: scripts/campaign-D/fetch_weather_forward.mjs).
//
// Records, once per day, from free keyless Binance endpoints:
//   1) 8-major USDT-perp funding prints (last 3 x 8h = 24h)        -> output/recorders/market-funding.ndjson
//   2) BTC/ETH COIN-M quarterly basis (mark vs index, annualized)  -> output/recorders/market-basis.ndjson
//   3) live top-30-by-90d-dollar-volume spot universe              -> output/recorders/market-universe.ndjson
//   4) last CLOSED daily kline for each universe symbol            -> output/recorders/market-klines.ndjson
//
// FORMAT DECISION (documented per the prereg pack): one append-only NDJSON file PER STREAM,
// one JSON line per record, every line stamped with {recordedAt, runId}. Rationale: downstream
// scoring reads a stream as a whole; per-day files would multiply open/close logic and make
// append-only auditing harder. Idempotence: re-running on the same day appends a new runId —
// scorers must dedupe by (stream key, dateUTC) keeping the LAST runId.
//
// $0, keyless, paced at <=1 request/second (SLEEP_MS env to override, min 350ms).
// Usage: node scripts/recorders/record-daily-market.mjs
// The lab's training loop remains OFF; this is data-only recording (see scripts/recorders/README.md).

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "output/recorders");
mkdirSync(OUT, { recursive: true });

const UA = "campaign-E-recorder (research; $0 keyless)";
const SLEEP_MS = Math.max(350, Number(process.env.SLEEP_MS ?? 1000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let httpCalls = 0;
async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      httpCalls++;
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;
}
const writeLine = (file, obj) => appendFileSync(path.join(OUT, file), JSON.stringify(obj) + "\n");

const t0 = Date.now();
const recordedAt = new Date().toISOString();
const dateUTC = recordedAt.slice(0, 10);
const runId = `${dateUTC}T${recordedAt.slice(11, 19).replace(/:/g, "")}Z`;
const stamp = { recordedAt, dateUTC, runId };

// ---------- 1) 8-major funding (the E4 trigger series; majors frozen in e4-regime-carry.json) ----------
const MAJORS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"];
let fundingLines = 0;
for (const symbol of MAJORS) {
  const j = await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=3`);
  await sleep(SLEEP_MS);
  if (!Array.isArray(j) || j.length === 0) { console.error(`[market] funding MISS ${symbol}`); continue; }
  const prints = j.map((p) => ({ fundingTime: p.fundingTime, fundingRate: Number(p.fundingRate) }));
  const sum24h = prints.reduce((s, p) => s + p.fundingRate, 0);
  writeLine("market-funding.ndjson", {
    ...stamp, stream: "funding", symbol, prints,
    sum24h: +sum24h.toFixed(8),
    annualizedPct: +(sum24h * 365 * 100 / (prints.length / 3)).toFixed(4),
  });
  fundingLines++;
}

// ---------- 2) BTC/ETH COIN-M quarterly basis ----------
const dapiInfo = await getJson("https://dapi.binance.com/dapi/v1/exchangeInfo");
await sleep(SLEEP_MS);
const deliveryBySym = new Map();
for (const s of dapiInfo?.symbols ?? []) {
  if ((s.contractType === "CURRENT_QUARTER" || s.contractType === "NEXT_QUARTER") &&
      (s.pair === "BTCUSD" || s.pair === "ETHUSD") && s.contractStatus === "TRADING") {
    deliveryBySym.set(s.symbol, { pair: s.pair, contractType: s.contractType, deliveryDate: s.deliveryDate });
  }
}
let basisLines = 0;
{
  // one unfiltered call: dapi premiumIndex returns ALL COIN-M symbols; keep only the four
  // BTC/ETH quarterly delivery contracts from exchangeInfo (pair taken from metadata, not query)
  const px = await getJson("https://dapi.binance.com/dapi/v1/premiumIndex");
  await sleep(SLEEP_MS);
  for (const row of Array.isArray(px) ? px : []) {
    const meta = deliveryBySym.get(row.symbol);
    if (!meta) continue; // perpetual or non-BTC/ETH-quarterly
    const mark = Number(row.markPrice), index = Number(row.indexPrice);
    const dte = Math.max(1, (meta.deliveryDate - Date.now()) / 86400000);
    const basis = mark / index - 1;
    writeLine("market-basis.ndjson", {
      ...stamp, stream: "basis", symbol: row.symbol, pair: meta.pair, contractType: meta.contractType,
      deliveryDate: new Date(meta.deliveryDate).toISOString().slice(0, 10),
      dteDays: +dte.toFixed(2), markPrice: mark, indexPrice: index,
      basis: +basis.toFixed(6), annualizedBasisPct: +((basis * 365 / dte) * 100).toFixed(4),
    });
    basisLines++;
  }
  if (!basisLines) console.error("[market] basis MISS (premiumIndex)");
}

// ---------- 3+4) top-30-by-90d-dollar-volume universe + daily klines ----------
// Preselect top-60 USDT spot pairs by 24h quote volume (1 call), then rank those by summed
// 90d CLOSED daily quoteVolume (1 klines call each) and keep the top 30. PIT by construction.
const STABLE_FIAT = /^(USDC|TUSD|BUSD|FDUSD|DAI|PAX|PAXG|USDP|EUR|GBP|TRY|BRL|AEUR|EURI|USD1|XUSD|USDE)$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;
const tickers = await getJson("https://api.binance.com/api/v3/ticker/24hr");
await sleep(SLEEP_MS);
const candidates = (tickers ?? [])
  .filter((t) => t.symbol.endsWith("USDT"))
  .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), qv24h: Number(t.quoteVolume) }))
  .filter((t) => t.qv24h > 0 && !STABLE_FIAT.test(t.base) && !LEVERAGED.test(t.base))
  .sort((a, b) => b.qv24h - a.qv24h)
  .slice(0, 60);

const ranked = [];
for (const c of candidates) {
  const k = await getJson(`https://api.binance.com/api/v3/klines?symbol=${c.symbol}&interval=1d&limit=91`);
  await sleep(SLEEP_MS);
  if (!Array.isArray(k) || k.length < 2) { console.error(`[market] klines MISS ${c.symbol}`); continue; }
  const closed = k.slice(0, -1); // drop the in-progress candle
  const dollarVol90d = closed.reduce((s, row) => s + Number(row[7]), 0); // quoteAssetVolume
  ranked.push({ ...c, dollarVol90d, daysUsed: closed.length, lastClosed: closed[closed.length - 1] });
}
ranked.sort((a, b) => b.dollarVol90d - a.dollarVol90d);
const top30 = ranked.slice(0, 30);

writeLine("market-universe.ndjson", {
  ...stamp, stream: "universe", method: "top-60 by 24h quoteVolume -> rank by sum of <=90 closed daily quoteVolume -> top 30",
  candidates: candidates.length, rankedOk: ranked.length,
  top30: top30.map((t, i) => ({ rank: i + 1, symbol: t.symbol, dollarVol90d: Math.round(t.dollarVol90d), daysUsed: t.daysUsed })),
});
for (const t of top30) {
  const [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades] = t.lastClosed;
  writeLine("market-klines.ndjson", {
    ...stamp, stream: "kline1d", symbol: t.symbol,
    openTime, closeTime, dateUTCBar: new Date(openTime).toISOString().slice(0, 10),
    open: Number(open), high: Number(high), low: Number(low), close: Number(close),
    volume: Number(volume), quoteVolume: Number(quoteVolume), trades,
  });
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.error(`[market] ${dateUTC} runId=${runId} httpCalls=${httpCalls} funding=${fundingLines} basis=${basisLines} universe=top${top30.length}/${ranked.length} klines=${top30.length} in ${secs}s -> ${OUT}`);
