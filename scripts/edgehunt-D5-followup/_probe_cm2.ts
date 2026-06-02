// Definitive: query FlowInExNtv alone per asset; also check catalog for which assets have it free.
const CM = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const assets = ["btc","eth","ltc","bch","etc","xrp","ada","doge","trx","bnb","xlm","zec","dash","ltc"];
async function probeMetric(a: string) {
  const url = `${CM}?assets=${a}&metrics=FlowInExNtv,FlowOutExNtv&frequency=1d&page_size=5&start_time=2020-01-01`;
  const ctrl = new AbortController(); const to=setTimeout(()=>ctrl.abort(),30000);
  try {
    const r = await fetch(url,{signal:ctrl.signal}); clearTimeout(to);
    if(!r.ok){ console.log(`${a}: HTTP ${r.status}`); return; }
    const j:any = await r.json();
    const rows=j.data??[];
    const ok = rows.length>0 && ("FlowInExNtv" in rows[0]);
    console.log(`${a}: flowRows=${rows.length} hasFlowIn=${ok}`);
  } catch(e:any){ console.log(`${a}: ERR ${e.message}`); clearTimeout(to);}
}
(async()=>{
  for (const a of [...new Set(assets)]) { await probeMetric(a); await new Promise(r=>setTimeout(r,250)); }
})();
