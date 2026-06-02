import fs from "node:fs";
const ROOT=".";
function load(asset:"btc"|"eth"){
  const net=JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-onchain2/cm_txcnt_${asset}.json`,"utf8")).data;
  const nm=new Map<string,{adr:number,tx:number}>();
  for(const r of net){const d=r.time.slice(0,10);nm.set(d,{adr:r.AdrActCnt!=null?+r.AdrActCnt:NaN,tx:r.TxCnt!=null?+r.TxCnt:NaN});}
  const poc=JSON.parse(fs.readFileSync(`${ROOT}/output/onchain-poc/cm_${asset}.json`,"utf8")).data;
  const pm=new Map<string,number>();
  for(const r of poc){const d=r.time.slice(0,10);if(r.PriceUSD!=null)pm.set(d,+r.PriceUSD);}
  const extra=JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_${asset}.json`,"utf8")).data;
  for(const r of extra){const d=r.time.slice(0,10);if(!pm.has(d)&&r.PriceUSD!=null)pm.set(d,+r.PriceUSD);}
  const dates=[...pm.keys()].filter(d=>nm.has(d)).sort();
  const rows:{price:number,adr:number,tx:number}[]=[];
  for(const d of dates){const p=pm.get(d)!;const n=nm.get(d)!;if(p>0&&n.adr>0)rows.push({price:p,adr:n.adr,tx:n.tx});}
  return rows;
}
function ema(x:number[],span:number){const a=2/(span+1);const o=new Array(x.length).fill(NaN);let pv=NaN;for(let i=0;i<x.length;i++){const v=x[i];if(!Number.isFinite(v)){o[i]=pv;continue;}pv=Number.isFinite(pv)?a*v+(1-a)*pv:v;o[i]=pv;}return o;}
function mom(lx:number[],f:number,s:number){const ef=ema(lx,f),es=ema(lx,s);return ef.map((v,i)=>v-es[i]);}
function finite(a:number[],b:number[]){const xs:number[]=[],ys:number[]=[];for(let i=0;i<a.length;i++)if(Number.isFinite(a[i])&&Number.isFinite(b[i])){xs.push(a[i]);ys.push(b[i]);}return[xs,ys] as const;}
function pear(a:number[],b:number[]){const[xs,ys]=finite(a,b);const n=xs.length;if(n<30)return NaN;const mx=xs.reduce((s,v)=>s+v)/n,my=ys.reduce((s,v)=>s+v)/n;let sxy=0,sxx=0,syy=0;for(let i=0;i<n;i++){sxy+=(xs[i]-mx)*(ys[i]-my);sxx+=(xs[i]-mx)**2;syy+=(ys[i]-my)**2;}return sxy/Math.sqrt(sxx*syy);}
// residualize a wrt b (OLS, full-sample for the probe only)
function resid(a:number[],b:number[]){const[xs,ys]=finite(a,b);const n=xs.length;const mx=ys.reduce((s,v)=>s+v)/n,my=xs.reduce((s,v)=>s+v)/n;let sxy=0,sxx=0;for(let i=0;i<n;i++){sxy+=(ys[i]-mx)*(xs[i]-my);sxx+=(ys[i]-mx)**2;}const beta=sxy/sxx,alpha=my-beta*mx;return a.map((v,i)=>Number.isFinite(v)&&Number.isFinite(b[i])?v-(alpha+beta*b[i]):NaN);}
for(const asset of["btc","eth"] as const){
  const rows=load(asset);const T=rows.length;const price=rows.map(r=>r.price);
  const fwd=new Array(T).fill(NaN);for(let t=0;t<T-1;t++)fwd[t]=Math.log(price[t+1]/price[t]);
  const logAdr=rows.map(r=>r.adr>0?Math.log(r.adr):NaN);
  const logTx=rows.map(r=>r.tx>0?Math.log(r.tx):NaN);
  const logP=price.map(p=>Math.log(p));
  console.log(`\n=== ${asset.toUpperCase()} orthogonalized-to-price-momentum IC ===`);
  for(const[f,s] of[[14,60],[30,90],[30,180]]){
    const aMom=[NaN,...mom(logAdr,f,s).slice(0,-1)];
    const tMom=[NaN,...mom(logTx,f,s).slice(0,-1)];
    const pMom=[NaN,...mom(logP,f,s).slice(0,-1)];
    // network composite = mean of adr & tx momentum (after standardizing roughly via their own corr)
    const netMom=aMom.map((v,i)=>Number.isFinite(v)&&Number.isFinite(tMom[i])?(v+tMom[i])/2:NaN);
    const icRaw=pear(netMom,fwd);
    const netOrth=resid(netMom,pMom); // remove price-momentum component
    const icOrth=pear(netOrth,fwd);
    const icPrice=pear(pMom,fwd);
    console.log(`  ${f}/${s}: IC(netMom)=${fmt(icRaw)}  IC(netMom|price)=${fmt(icOrth)}  IC(priceMom)=${fmt(icPrice)}`);
  }
}
function fmt(x:number){return Number.isFinite(x)?(x>=0?" ":"")+x.toFixed(4):"  n/a ";}
