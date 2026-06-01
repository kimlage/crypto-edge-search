/**
 * fetch-multivenue-funding.mjs — TRACK D1 data fetch.
 *
 * Pulls historical 8h funding-rate history for the majors from Bybit and OKX
 * (Binance is already in output/funding/*), plus a one-shot order-book depth
 * snapshot from all three venues (used to calibrate slippage-vs-size). Public
 * REST, no auth.
 *
 *   Bybit:  api.bybit.com/v5/market/funding/history (category=linear, limit<=200,
 *           newest-first, paginate with startTime/endTime windows).
 *   OKX:    www.okx.com/api/v5/public/funding-rate-history (limit<=100,
 *           newest-first, paginate with `after`=older-than cursor).
 *
 * Writes ONLY to output/carry/. If a venue is network-blocked the script records
 * the failure in the manifest and continues; the audit will label that venue.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import https from "node:https";

const OUT = join("output", "carry");
mkdirSync(OUT, { recursive: true });

const COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];
const START_MS = Date.UTC(2023, 5, 1); // 2023-06-01, aligned to Binance funding start
const NOW = Date.now();

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "carry-d1/1.0" } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Bybit -----
async function fetchBybit(coin) {
  const symbol = `${coin}USDT`;
  const out = [];
  let end = NOW;
  // Bybit returns newest-first within [startTime,endTime]; walk windows backward.
  for (let guard = 0; guard < 400; guard++) {
    const url =
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}` +
      `&startTime=${START_MS}&endTime=${end}&limit=200`;
    const { status, body } = await get(url);
    if (status !== 200) throw new Error(`bybit ${symbol} HTTP ${status}`);
    const j = JSON.parse(body);
    if (j.retCode !== 0) throw new Error(`bybit ${symbol} retCode ${j.retCode} ${j.retMsg}`);
    const list = j.result?.list ?? [];
    if (list.length === 0) break;
    for (const r of list) {
      out.push({ fundingTime: Number(r.fundingRateTimestamp), fundingRate: Number(r.fundingRate) });
    }
    const oldest = Math.min(...list.map((r) => Number(r.fundingRateTimestamp)));
    if (oldest <= START_MS || list.length < 200) break;
    end = oldest - 1;
    await sleep(160);
  }
  // dedupe + sort ascending
  const seen = new Map();
  for (const r of out) seen.set(r.fundingTime, r.fundingRate);
  return [...seen.entries()]
    .map(([fundingTime, fundingRate]) => ({ fundingTime, fundingRate }))
    .filter((r) => r.fundingTime >= START_MS)
    .sort((a, b) => a.fundingTime - b.fundingTime);
}

// ------------------------------------------------------------------ OKX -----
async function fetchOkx(coin) {
  const instId = `${coin}-USDT-SWAP`;
  const out = [];
  let after = NOW; // return rows with fundingTime < after
  for (let guard = 0; guard < 400; guard++) {
    const url =
      `https://www.okx.com/api/v5/public/funding-rate-history?instId=${instId}` +
      `&limit=100&after=${after}`;
    const { status, body } = await get(url);
    if (status !== 200) throw new Error(`okx ${instId} HTTP ${status}`);
    const j = JSON.parse(body);
    if (j.code !== "0") throw new Error(`okx ${instId} code ${j.code} ${j.msg}`);
    const data = j.data ?? [];
    if (data.length === 0) break;
    for (const r of data) {
      out.push({
        fundingTime: Number(r.fundingTime),
        fundingRate: Number(r.realizedRate ?? r.fundingRate),
      });
    }
    const oldest = Math.min(...data.map((r) => Number(r.fundingTime)));
    if (oldest <= START_MS || data.length < 100) break;
    after = oldest;
    await sleep(160);
  }
  const seen = new Map();
  for (const r of out) seen.set(r.fundingTime, r.fundingRate);
  return [...seen.entries()]
    .map(([fundingTime, fundingRate]) => ({ fundingTime, fundingRate }))
    .filter((r) => r.fundingTime >= START_MS)
    .sort((a, b) => a.fundingTime - b.fundingTime);
}

// ------------------------------------------------------------ depth -----
// One snapshot of book depth per venue/coin -> used to estimate slippage curve.
async function fetchDepth() {
  const depth = {};
  for (const coin of COINS) {
    depth[coin] = {};
    // Binance USDT-perp
    try {
      const { body } = await get(
        `https://fapi.binance.com/fapi/v1/depth?symbol=${coin}USDT&limit=1000`
      );
      const j = JSON.parse(body);
      depth[coin].binance = {
        bids: (j.bids ?? []).map(([p, q]) => [Number(p), Number(q)]),
        asks: (j.asks ?? []).map(([p, q]) => [Number(p), Number(q)]),
      };
    } catch (e) {
      depth[coin].binance = { error: String(e) };
    }
    await sleep(120);
    // Bybit linear
    try {
      const { body } = await get(
        `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${coin}USDT&limit=200`
      );
      const j = JSON.parse(body);
      depth[coin].bybit = {
        bids: (j.result?.b ?? []).map(([p, q]) => [Number(p), Number(q)]),
        asks: (j.result?.a ?? []).map(([p, q]) => [Number(p), Number(q)]),
      };
    } catch (e) {
      depth[coin].bybit = { error: String(e) };
    }
    await sleep(120);
    // OKX swap (sz is in contracts; ctVal converts to coin — fetch instrument too)
    try {
      const { body } = await get(
        `https://www.okx.com/api/v5/market/books?instId=${coin}-USDT-SWAP&sz=400`
      );
      const j = JSON.parse(body);
      const d = j.data?.[0] ?? {};
      // OKX book sz for SWAP is in CONTRACTS; need ctVal to convert to coin units.
      const inst = await get(
        `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${coin}-USDT-SWAP`
      );
      const ctVal = Number(JSON.parse(inst.body).data?.[0]?.ctVal ?? 1);
      depth[coin].okx = {
        ctVal,
        bids: (d.bids ?? []).map(([p, q]) => [Number(p), Number(q) * ctVal]),
        asks: (d.asks ?? []).map(([p, q]) => [Number(p), Number(q) * ctVal]),
      };
    } catch (e) {
      depth[coin].okx = { error: String(e) };
    }
    await sleep(120);
  }
  return depth;
}

// ------------------------------------------------------------------ main ----
const manifest = {
  experiment: "multivenue-carry-d1",
  fetchedAt: new Date().toISOString(),
  startIso: new Date(START_MS).toISOString(),
  endIso: new Date(NOW).toISOString(),
  venues: {},
};

for (const venue of ["bybit", "okx"]) {
  manifest.venues[venue] = {};
  for (const coin of COINS) {
    try {
      const rows = venue === "bybit" ? await fetchBybit(coin) : await fetchOkx(coin);
      const gaps = [];
      for (let i = 1; i < rows.length; i++) gaps.push((rows[i].fundingTime - rows[i - 1].fundingTime) / 3600000);
      const medGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
      const mean = rows.length ? rows.reduce((s, r) => s + r.fundingRate, 0) / rows.length : null;
      const posFrac = rows.length ? rows.filter((r) => r.fundingRate > 0).length / rows.length : null;
      writeFileSync(join(OUT, `${venue}_${coin}USDT_funding_8h.json`), JSON.stringify(rows));
      manifest.venues[venue][`${coin}USDT`] = {
        source: `${venue}_public_rest`,
        fundingCount: rows.length,
        medianGapHours: medGap,
        meanFundingRate: mean,
        positiveFraction: posFrac,
        firstFunding: rows.length ? new Date(rows[0].fundingTime).toISOString() : null,
        lastFunding: rows.length ? new Date(rows[rows.length - 1].fundingTime).toISOString() : null,
      };
      console.log(`${venue} ${coin}: ${rows.length} rows, medGap=${medGap}h, mean=${mean}`);
    } catch (e) {
      manifest.venues[venue][`${coin}USDT`] = { error: String(e) };
      console.log(`${venue} ${coin}: ERROR ${e}`);
    }
  }
}

console.log("fetching depth snapshots...");
try {
  const depth = await fetchDepth();
  writeFileSync(join(OUT, "depth_snapshots.json"), JSON.stringify(depth));
  manifest.depthSnapshot = { fetchedAt: new Date().toISOString(), ok: true };
  console.log("depth snapshots written");
} catch (e) {
  manifest.depthSnapshot = { ok: false, error: String(e) };
  console.log(`depth ERROR ${e}`);
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("manifest written -> output/carry/manifest.json");
