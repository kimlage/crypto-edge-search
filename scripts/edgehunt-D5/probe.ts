const CM = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const metrics = [
  "CapMrktCurUSD","CapRealUSD","TxTfrValAdjUSD","NVTAdj","NVTAdj90",
  "RevUSD","IssContNtv","HashRate","SplyCur","SplyActPct1yr","AdrActCnt","PriceUSD",
];
async function probe(m: string) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const url = `${CM}?assets=btc&metrics=${m}&frequency=1d&page_size=2&start_time=2024-01-01`;
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) { console.log(m.padEnd(16), "HTTP", r.status); return; }
    const j: any = await r.json();
    console.log(m.padEnd(16), "OK", JSON.stringify(j.data?.[0] ?? {}).slice(0, 120));
  } catch (e: any) { clearTimeout(to); console.log(m.padEnd(16), "ERR", e.message); }
}
async function main() {
  for (const m of metrics) { await probe(m); }
  // also probe page_size limit with the big metric set minus any flagged
}
main();
