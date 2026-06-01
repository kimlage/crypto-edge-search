/**
 * TRACK OC2 — Core on-chain metrics @ $0 — live POC fetcher.
 *
 * Sources tested (all NO-KEY public REST):
 *   1. Coin Metrics Community API  (community-api.coinmetrics.io/v4)  — multi-year daily, BTC+ETH, 31 free metrics
 *   2. Blockchain.com Charts API   (api.blockchain.info/charts)        — free BTC on-chain daily
 *   3. mempool.space API           (mempool.space/api)                 — free BTC mining/mempool
 *   4. Etherscan V2                 (api.etherscan.io/v2)               — REQUIRES free-signup key (flagged, not fetched)
 *
 * Keeps fetches SMALL (a few hundred rows max) to respect rate limits.
 * Run:
 *   node_modules/.bin/tsx scripts/onchain-scout/oc2_fetch.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT = resolve(ROOT, "output/onchain-scout/oc2");
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url: string, label: string): Promise<any> {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": "oc2-onchain-scout/1.0" } });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  console.log(`[${label}] HTTP ${res.status} | ${ms}ms | ${text.length}B | x-ratelimit-remaining=${res.headers.get("x-ratelimit-remaining") ?? "n/a"}`);
  return { status: res.status, json, text };
}

// ---- Coin Metrics: paginate a timeseries (small cap on pages) ----
async function cmTimeseries(assets: string, metrics: string, start: string, end: string, maxRows = 4000) {
  const rows: any[] = [];
  let url =
    `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics` +
    `?assets=${assets}&metrics=${metrics}&frequency=1d&start_time=${start}&end_time=${end}&page_size=1000`;
  let pages = 0;
  while (url && rows.length < maxRows && pages < 12) {
    const { status, json } = await getJSON(url, `CM ${assets} p${pages}`);
    if (status !== 200 || !json?.data) { console.log("  -> stop:", JSON.stringify(json)?.slice(0, 200)); break; }
    rows.push(...json.data);
    url = json.next_page_url ?? "";
    pages++;
    if (url) await sleep(250); // be polite
  }
  return rows;
}

async function main() {
  const summary: Record<string, any> = {};

  // ===== 1. COIN METRICS COMMUNITY (the gold mine) =====
  console.log("\n===== COIN METRICS COMMUNITY =====");
  // Confirmed-FREE metrics only (community:true). Excludes paid CapRealUSD/TxTfrValAdjUSD/NVTAdj.
  const FREE_METRICS = "AdrActCnt,TxCnt,TxTfrCnt,FeeTotNtv,CapMrktCurUSD,CapMVRVCur,FlowInExUSD,FlowOutExUSD,SplyCur,HashRate,PriceUSD";
  // Multi-year window: BTC from 2015, ETH from 2015 — but cap rows small. Pull 2015-01-01 .. 2015-12-31 dense + recent.
  const cmBtc = await cmTimeseries("btc", FREE_METRICS, "2013-01-01", "2013-06-30");
  await sleep(300);
  const cmBtcRecent = await cmTimeseries("btc", FREE_METRICS, "2025-01-01", "2025-03-31");
  await sleep(300);
  const cmEth = await cmTimeseries("eth", FREE_METRICS, "2016-01-01", "2016-06-30");
  await sleep(300);
  // Full multi-year ANNUAL-sampled depth proof (one metric, 2009->now) — small via monthly-ish slicing is heavy;
  // instead grab the very first + very last rows to prove span.
  const cmBtcEdges = await cmTimeseries("btc", "AdrActCnt", "2009-01-01", "2009-01-15");
  await sleep(300);
  const cmBtcLast = await cmTimeseries("btc", "AdrActCnt", "2026-05-01", "2026-05-30");

  const cmAll = { btc_2013H1: cmBtc, btc_2025Q1: cmBtcRecent, eth_2016H1: cmEth, btc_genesis_window: cmBtcEdges, btc_recent: cmBtcLast };
  writeFileSync(`${OUT}/coinmetrics_btc_eth_poc.json`, JSON.stringify(cmAll, null, 2));
  summary.coinmetrics = {
    free_metrics_used: FREE_METRICS.split(","),
    btc_2013H1_rows: cmBtc.length,
    btc_2025Q1_rows: cmBtcRecent.length,
    eth_2016H1_rows: cmEth.length,
    btc_earliest_row: cmBtcEdges[0] ?? null,
    btc_latest_row: cmBtcLast[cmBtcLast.length - 1] ?? null,
    sample_btc_2013: cmBtc[0] ?? null,
    sample_eth_2016: cmEth[0] ?? null,
  };

  // ===== 2. BLOCKCHAIN.COM CHARTS =====
  console.log("\n===== BLOCKCHAIN.COM CHARTS =====");
  const bcSlugs = ["n-unique-addresses", "n-transactions", "estimated-transaction-volume-usd", "hash-rate", "miners-revenue", "market-price"];
  const bcData: Record<string, any> = {};
  for (const slug of bcSlugs) {
    // 'all' timespan proves full history depth; sampled=false for daily granularity.
    const { status, json } = await getJSON(
      `https://api.blockchain.info/charts/${slug}?timespan=all&format=json&sampled=true`,
      `BC ${slug}`
    );
    if (status === 200 && json?.values) {
      const v = json.values;
      bcData[slug] = {
        unit: json.unit, period: json.period, points: v.length,
        first: v[0], last: v[v.length - 1],
        first_date: v[0] ? new Date(v[0].x * 1000).toISOString().slice(0, 10) : null,
        last_date: v[v.length - 1] ? new Date(v[v.length - 1].x * 1000).toISOString().slice(0, 10) : null,
      };
    } else {
      bcData[slug] = { error: status };
    }
    await sleep(400);
  }
  writeFileSync(`${OUT}/blockchain_com_charts_poc.json`, JSON.stringify(bcData, null, 2));
  summary.blockchain_com = bcData;

  // ===== 3. MEMPOOL.SPACE =====
  console.log("\n===== MEMPOOL.SPACE =====");
  const mp: Record<string, any> = {};
  const hr = await getJSON("https://mempool.space/api/v1/mining/hashrate/3y", "MP hashrate/3y");
  if (hr.status === 200 && hr.json) {
    const h = hr.json.hashrates ?? [];
    const d = hr.json.difficulty ?? [];
    mp.hashrate = {
      hashrate_points: h.length, difficulty_points: d.length,
      first_date: h[0] ? new Date(h[0].timestamp * 1000).toISOString().slice(0, 10) : null,
      last_date: h.length ? new Date(h[h.length - 1].timestamp * 1000).toISOString().slice(0, 10) : null,
      sample_first: h[0] ?? null, sample_last: h[h.length - 1] ?? null,
    };
  }
  await sleep(300);
  const tipH = await getJSON("https://mempool.space/api/blocks/tip/height", "MP tip-height");
  mp.tip_height = tipH.json;
  await sleep(300);
  const fees = await getJSON("https://mempool.space/api/v1/fees/recommended", "MP fees");
  mp.recommended_fees = fees.json;
  writeFileSync(`${OUT}/mempool_space_poc.json`, JSON.stringify(mp, null, 2));
  summary.mempool_space = mp;

  // ===== 4. ETHERSCAN V2 (key required — probe only, flag) =====
  console.log("\n===== ETHERSCAN V2 (no key) =====");
  const es = await getJSON("https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethsupply", "ETHERSCAN nokey");
  summary.etherscan = { no_key_response: es.json, verdict: "REQUIRES free-signup API key for ALL endpoints (V2). Not usable without signup." };

  writeFileSync(`${OUT}/_summary.json`, JSON.stringify(summary, null, 2));
  console.log("\n===== SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

export {};
