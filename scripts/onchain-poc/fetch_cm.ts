/**
 * On-chain distribution-pressure POC — STEP 1: fetch + cache Coin Metrics Community.
 *
 * Program's 28th hypothesis (docs/ONCHAIN_FEASIBILITY.md §3). $0 / no-key.
 * Source: Coin Metrics Community API (community-api.coinmetrics.io/v4) — proven live
 * by the scout (scripts/onchain-scout/oc2_fetch.ts). Reuses that pagination pattern.
 *
 * Pulls BTC and ETH DAILY full-history for the five metrics the POC needs:
 *   AdrActCnt, FlowInExNtv, FlowOutExNtv, CapMVRVCur (MVRV), PriceUSD
 * Native-unit flows (…Ntv) are used deliberately to avoid the USD-denomination
 * tautology (OC4: USD-denominated stocks move mechanically with price).
 *
 * The CM rows carry `…-status: flash|reviewed` revision flags (NOT point-in-time).
 * We persist those flags too, so the look-ahead control is auditable downstream.
 *
 * Cache: output/onchain-poc/cm_{btc,eth}.json  (skipped if already present & fresh).
 *
 * Run:
 *   node_modules/.bin/tsx scripts/onchain-poc/fetch_cm.ts
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT = resolve(ROOT, "output/onchain-poc");
mkdirSync(OUT, { recursive: true });

const METRICS = ["AdrActCnt", "FlowInExNtv", "FlowOutExNtv", "CapMVRVCur", "PriceUSD"] as const;
const START = "2015-01-01";
const END = "2026-05-30";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url: string, label: string): Promise<any> {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": "onchain-poc/1.0" } });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  console.log(
    `[${label}] HTTP ${res.status} | ${ms}ms | ${text.length}B | ` +
    `x-ratelimit-remaining=${res.headers.get("x-ratelimit-remaining") ?? "n/a"}`,
  );
  return { status: res.status, json, text };
}

/** Paginate the full daily history for one asset (reuses the oc2 pattern, larger cap). */
async function cmTimeseries(asset: string): Promise<any[]> {
  const rows: any[] = [];
  let url =
    `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics` +
    `?assets=${asset}&metrics=${METRICS.join(",")}` +
    `&frequency=1d&start_time=${START}&end_time=${END}&page_size=1000`;
  let pages = 0;
  while (url && pages < 30) {
    const { status, json } = await getJSON(url, `CM ${asset} p${pages}`);
    if (status !== 200 || !json?.data) {
      console.log("  -> stop:", JSON.stringify(json)?.slice(0, 200));
      break;
    }
    rows.push(...json.data);
    url = json.next_page_url ?? "";
    pages += 1;
    if (url) await sleep(300); // be polite (6000/20s sliding limit)
  }
  return rows;
}

async function fetchAsset(asset: string): Promise<any[]> {
  const path = `${OUT}/cm_${asset}.json`;
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(cached?.data) && cached.data.length > 1000) {
      console.log(`[cache] ${asset}: ${cached.data.length} rows (using cache)`);
      return cached.data;
    }
  }
  const rows = await cmTimeseries(asset);
  // count revision flags so the look-ahead caveat is quantified
  let flash = 0, reviewed = 0;
  for (const r of rows) {
    for (const m of METRICS) {
      const s = r[`${m}-status`];
      if (s === "flash") flash += 1;
      else if (s === "reviewed") reviewed += 1;
    }
  }
  writeFileSync(path, JSON.stringify({
    asset,
    metrics: METRICS,
    fetchedAt: new Date().toISOString(),
    rowCount: rows.length,
    firstTime: rows[0]?.time ?? null,
    lastTime: rows[rows.length - 1]?.time ?? null,
    revisionFlags: { flash, reviewed },
    data: rows,
  }, null, 2));
  console.log(`[saved] ${asset}: ${rows.length} rows -> ${path} (flash=${flash}, reviewed=${reviewed})`);
  return rows;
}

async function main() {
  const btc = await fetchAsset("btc");
  await sleep(400);
  const eth = await fetchAsset("eth");
  console.log("\n===== FETCH SUMMARY =====");
  console.log(`btc: ${btc.length} rows  ${btc[0]?.time} .. ${btc[btc.length - 1]?.time}`);
  console.log(`eth: ${eth.length} rows  ${eth[0]?.time} .. ${eth[eth.length - 1]?.time}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

export {};
