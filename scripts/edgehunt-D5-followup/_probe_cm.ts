// Probe free Coin Metrics community tier for FlowIn/FlowOut/Price coverage per asset.
const CM = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const METRICS = "FlowInExNtv,FlowOutExNtv,PriceUSD";
const assets = ["ltc","bch","etc","xrp","ada","doge","sol","trx","link","matic","dot","avax","bnb","xlm","aave","uni"];
async function probe(a: string) {
  const url = `${CM}?assets=${a}&metrics=${METRICS}&frequency=1d&page_size=10&start_time=2018-01-01`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(()=>ctrl.abort(), 30000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) { console.log(`${a}: HTTP ${r.status}`); return; }
    const j: any = await r.json();
    const rows = j.data ?? [];
    if (!rows.length) { console.log(`${a}: no rows`); return; }
    const r0 = rows[0];
    const hasFlow = ("FlowInExNtv" in r0) && ("FlowOutExNtv" in r0);
    console.log(`${a}: rows>=${rows.length} keys=[${Object.keys(r0).filter(k=>k!=="asset"&&k!=="time").join(",")}] flow=${hasFlow}`);
  } catch(e:any){ console.log(`${a}: ERR ${e.message}`); }
}
(async()=>{ for (const a of assets) { await probe(a); await new Promise(r=>setTimeout(r,300)); } })();
