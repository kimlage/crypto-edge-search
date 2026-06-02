/**
 * D5 edgehunt — fetch the EXTRA free Coin Metrics Community metrics (no key) needed beyond the
 * committed cm_{btc,eth}.json POC, plus DefiLlama stablecoin circulating supply for SSR.
 *
 * Writes to output/edgehunt-D5/cm_extra_{btc,eth}.json and stablecoins_total.json.
 * Light fetch: paged, aggregated to daily rows we actually use. Idempotent (skips if present).
 */
import fs from "node:fs";

const OUT = "output/edgehunt-D5";
const CM = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";

// Metrics beyond the POC: market cap, realized cap, NVT pieces, miner rev, hashrate, supply,
// active-supply 1yr proxy, transfer value.
// Only metrics confirmed available on the FREE community tier (others 403). Realized cap is
// derived downstream as CapMrktCurUSD / CapMVRVCur (CapMVRVCur lives in the POC file); issuance
// from the known halving schedule + SplyCur deltas. NVT/transfer-value is NOT free → not tested.
const METRICS = [
  "CapMrktCurUSD",
  "HashRate",
  "SplyCur",
  "AdrActCnt",
  "PriceUSD",
].join(",");

interface Row {
  time: string;
  [k: string]: string;
}

async function fetchAsset(asset: string): Promise<Row[]> {
  const out: Row[] = [];
  let nextUrl =
    `${CM}?assets=${asset}&metrics=${METRICS}&frequency=1d&page_size=5000&start_time=2010-01-01`;
  let guard = 0;
  while (nextUrl && guard < 20) {
    guard++;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(nextUrl, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error(`CM ${asset} HTTP ${r.status}`);
    const j: any = await r.json();
    for (const d of j.data ?? []) out.push(d);
    nextUrl = j.next_page_url ?? "";
  }
  return out;
}

async function fetchStables(): Promise<{ date: string; total: number }[]> {
  // DefiLlama free stablecoins API: total circulating across all stablecoins (USD peg).
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 60000);
  const r = await fetch("https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=", {
    signal: ctrl.signal,
  });
  clearTimeout(to);
  if (!r.ok) throw new Error(`DefiLlama HTTP ${r.status}`);
  const j: any = await r.json();
  const rows: { date: string; total: number }[] = [];
  for (const e of j) {
    const ts = Number(e.date) * 1000;
    const date = new Date(ts).toISOString().slice(0, 10);
    // totalCirculatingUSD.peggedUSD is the headline USD-pegged circulating
    const total = Number(e?.totalCirculatingUSD?.peggedUSD ?? 0);
    if (total > 0) rows.push({ date, total });
  }
  return rows;
}

async function main() {
  for (const asset of ["btc", "eth"]) {
    const path = `${OUT}/cm_extra_${asset}.json`;
    if (fs.existsSync(path)) {
      console.log(`skip ${path} (exists)`);
      continue;
    }
    const rows = await fetchAsset(asset);
    fs.writeFileSync(path, JSON.stringify({ asset, metrics: METRICS, rowCount: rows.length, data: rows }));
    console.log(`wrote ${path} rows=${rows.length}`);
  }
  const sp = `${OUT}/stablecoins_total.json`;
  if (!fs.existsSync(sp)) {
    const stab = await fetchStables();
    fs.writeFileSync(sp, JSON.stringify({ source: "defillama", rowCount: stab.length, data: stab }));
    console.log(`wrote ${sp} rows=${stab.length}`);
  } else {
    console.log(`skip ${sp} (exists)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
