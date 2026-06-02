import { loadPanel } from "../edgehunt-D5/harness.ts";
for (const a of ["btc","eth"] as const) {
  const P = loadPanel(a);
  const T = P.price.length;
  let nf = 0, firstNF = "", lastNF = "";
  for (let t=0;t<T;t++){
    if (Number.isFinite(P.flowInNtv[t]) && Number.isFinite(P.flowOutNtv[t])) {
      nf++; if(!firstNF) firstNF=P.dates[t]; lastNF=P.dates[t];
    }
  }
  console.log(`${a}: rows=${T} dates ${P.dates[0]}..${P.dates[T-1]} | netflow finite=${nf} (${firstNF}..${lastNF})`);
}
