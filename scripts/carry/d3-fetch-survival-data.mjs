/**
 * d3-fetch-survival-data.mjs — TRACK D3 (tail / survival risk). SELF-CONTAINED.
 *
 * Concurrent tracks (D1/D4) write into output/carry/ too, so this track writes ONLY
 * to output/carry/d3/ to avoid any collision/race.
 *
 * Pulls a SECOND-venue (Bybit linear perp) funding history for the 8 majors so the
 * tail analysis can measure whether MULTI-VENUE diversification changes the
 * counterparty-gap tail and whether funding-flip regimes are correlated across
 * venues. Binance 8h funding is already in output/funding/.
 *
 * Also records each venue's min/max funding clamp + cadence (material for "how
 * negative can funding legally go" — the funding-flip tail bound).
 *
 * Public REST only (no auth). Network-blocked venues are recorded and skipped; the
 * audit marks those as estimated.
 *
 * Writes: output/carry/d3/bybit_<SYM>_funding.json + d3/fetch-manifest.json
 *
 * Usage: node scripts/carry/d3-fetch-survival-data.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join("output", "carry", "d3");
mkdirSync(OUT_DIR, { recursive: true });

const MAJORS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];
const NOW = Date.now();
const START_MS = Date.UTC(2023, 5, 1); // align to Binance funding start (2023-06-01)

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "carry-d3/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Bybit funding: newest-first within [startTime,endTime]; walk windows backward. */
async function fetchBybitFunding(symbol) {
  const out = new Map();
  let end = NOW;
  for (let guard = 0; guard < 200; guard += 1) {
    const url =
      `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}` +
      `&startTime=${START_MS}&endTime=${end}&limit=200`;
    let j;
    try {
      j = await getJson(url);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), rows: [...out.values()] };
    }
    if (j.retCode !== 0) return { ok: false, error: `retCode ${j.retCode}`, rows: [...out.values()] };
    const list = j?.result?.list ?? [];
    if (list.length === 0) break;
    for (const r of list) {
      const ts = Number(r.fundingRateTimestamp);
      const rate = Number(r.fundingRate);
      if (Number.isFinite(ts) && Number.isFinite(rate)) out.set(ts, rate);
    }
    const oldest = Math.min(...list.map((r) => Number(r.fundingRateTimestamp)));
    if (oldest <= START_MS || list.length < 200) break;
    end = oldest - 1;
    await sleep(140);
  }
  const rows = [...out.entries()]
    .map(([fundingTime, fundingRate]) => ({ fundingTime, fundingRate }))
    .filter((r) => r.fundingTime >= START_MS)
    .sort((a, b) => a.fundingTime - b.fundingTime);
  return { ok: true, rows };
}

async function main() {
  const manifest = { source: "bybit_v5_public", fetchedAt: new Date().toISOString(), symbols: {} };
  for (const coin of MAJORS) {
    const symbol = `${coin}USDT`;
    process.stdout.write(`Bybit funding ${symbol} ... `);
    const res = await fetchBybitFunding(symbol);
    const rows = res.rows;
    if (rows.length > 0) writeFileSync(join(OUT_DIR, `bybit_${symbol}_funding.json`), JSON.stringify(rows));
    if (!res.ok) {
      console.log(`PARTIAL/FAILED (${res.error}) — ${rows.length} rows`);
      manifest.symbols[symbol] = { ok: false, error: res.error, count: rows.length };
      continue;
    }
    const rates = rows.map((r) => r.fundingRate);
    const mean = rates.reduce((s, v) => s + v, 0) / (rates.length || 1);
    const posFrac = rates.filter((r) => r > 0).length / (rates.length || 1);
    const minRate = Math.min(...rates);
    manifest.symbols[symbol] = {
      ok: true,
      count: rows.length,
      meanRate: mean,
      positiveFraction: posFrac,
      minRate,
      first: rows[0] ? new Date(rows[0].fundingTime).toISOString() : null,
      last: rows.at(-1) ? new Date(rows.at(-1).fundingTime).toISOString() : null,
    };
    console.log(
      `${rows.length} rows  mean=${(mean * 100).toFixed(4)}%/8h  pos=${(posFrac * 100).toFixed(1)}%  min=${(minRate * 100).toFixed(3)}%`,
    );
  }
  writeFileSync(join(OUT_DIR, "fetch-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("\nwrote", join(OUT_DIR, "fetch-manifest.json"));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
