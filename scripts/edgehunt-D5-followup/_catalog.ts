// Ask the catalog which assets expose FlowInExNtv on the community tier.
const url = "https://community-api.coinmetrics.io/v4/catalog/asset-metrics?metrics=FlowInExNtv";
const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(),40000);
(async()=>{
  try{
    const r=await fetch(url,{signal:ctrl.signal}); clearTimeout(to);
    console.log("HTTP", r.status);
    const j:any = await r.json();
    const md = j.data ?? j.metrics ?? [];
    // structure: data[].metric, data[].frequencies[].assets ... varies; dump compactly
    const out: string[] = [];
    for (const m of md) {
      if (m.frequencies) for (const f of m.frequencies) {
        if (f.frequency==="1d" && f.assets) out.push(`1d assets(${f.assets.length}): ${f.assets.slice(0,40).join(",")}`);
      }
    }
    console.log(out.join("\n") || JSON.stringify(j).slice(0,800));
  }catch(e:any){ console.log("ERR", e.message); clearTimeout(to);}
})();
