/**
 * O1-ADRACT — committed gauntlet on the ORTHOGONALIZED (adoption-only) network-momentum timer.
 * This is the clean test of "does on-chain adoption LEAD price" after removing the price-momentum
 * echo. honest N counts the full orthogonalized grid. Runs harness::runGauntlet (phase-rand null,
 * baselines, DSR, PBO, haircut, consume-once holdout) + an AR(5)-matched placebo for the IS-best.
 */
import fs from "node:fs";
import { type Panel, runPositions, sharpeDaily, annSharpe, mkRng, mean, rollingZ, ema, runGauntlet, printVerdict, type GauntletInput } from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
const ROOT=".", OUT=`${ROOT}/output/edgehunt-onchain2`, LAG=1;
interface NetPanel extends Panel { tx:number[] }
function loadNetPanel(asset:"btc"|"eth"):NetPanel{
  const net=JSON.parse(fs.readFileSync(`${OUT}/cm_txcnt_${asset}.json`,"utf8")).data as any[];
  const nm=new Map<string,{adr:number,tx:number}>();
  for(const r of net){const d=r.time.slice(0,10);nm.set(d,{adr:r.AdrActCnt!=null?+r.AdrActCnt:NaN,tx:r.TxCnt!=null?+r.TxCnt:NaN});}
  const poc=JSON.parse(fs.readFileSync(`${ROOT}/output/onchain-poc/cm_${asset}.json`,"utf8")).data as any[];
  const pm=new Map<string,number>(); for(const r of poc) if(r.PriceUSD!=null) pm.set(r.time.slice(0,10),+r.PriceUSD);
  const extra=JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_${asset}.json`,"utf8")).data as any[];
  for(const r of extra){const d=r.time.slice(0,10); if(!pm.has(d)&&r.PriceUSD!=null) pm.set(d,+r.PriceUSD);}
  const dates=[...pm.keys()].filter(d=>nm.has(d)).sort();
  const P:NetPanel={asset,dates:[],price:[],mvrv:[],flowInNtv:[],flowOutNtv:[],adr:[],tx:[],marketCap:[],hashRate:[],supply:[],realizedCap:[],realizedPrice:[],fwdRet:[]};
  for(const d of dates){const p=pm.get(d)!,n=nm.get(d)!; if(!(p>0)||!(n.adr>0))continue;
    P.dates.push(d);P.price.push(p);P.adr.push(n.adr);P.tx.push(n.tx);
    P.mvrv.push(NaN);P.flowInNtv.push(NaN);P.flowOutNtv.push(NaN);P.marketCap.push(NaN);P.hashRate.push(NaN);P.supply.push(NaN);P.realizedCap.push(NaN);P.realizedPrice.push(NaN);}
  const T=P.price.length; for(let t=0;t<T;t++)P.fwdRet.push(t+1<T?Math.log(P.price[t+1]/P.price[t]):NaN);
  return P;
}
function lagArr(x:number[],k:number){const o=new Array(x.length).fill(NaN);for(let i=k;i<x.length;i++)o[i]=x[i-k];return o;}
function momOf(lx:number[],f:number,s:number){const ef=ema(lx,f),es=ema(lx,s);return ef.map((v,i)=>v-es[i]);}
function expandingOrthog(a:number[],b:number[],minObs:number){const T=a.length,out=new Array(T).fill(NaN);let n=0,sx=0,sy=0,sxx=0,sxy=0;
  for(let t=0;t<T;t++){ if(n>=minObs&&Number.isFinite(a[t])&&Number.isFinite(b[t])){const dn=n*sxx-sx*sx; if(Math.abs(dn)>1e-9){const beta=(n*sxy-sx*sy)/dn,alpha=(sy-beta*sx)/n;out[t]=a[t]-(alpha+beta*b[t]);}}
    if(Number.isFinite(a[t])&&Number.isFinite(b[t])){n++;sx+=b[t];sy+=a[t];sxx+=b[t]*b[t];sxy+=b[t]*a[t];}}
  return out;}
type Cfg={fast:number,slow:number,zwin:number,thr:number,side:"longflat"|"longshort"|"tilt"};
function cfgK(c:Record<string,number|string>):Cfg{return c as any;}
function sigFor(P:NetPanel,c:Cfg){
  const lA=P.adr.map(v=>v>0?Math.log(v):NaN),lT=P.tx.map(v=>v>0?Math.log(v):NaN),lP=P.price.map(p=>Math.log(p));
  const am=momOf(lA,c.fast,c.slow),tm=momOf(lT,c.fast,c.slow);
  const comp=am.map((v,i)=>Number.isFinite(v)&&Number.isFinite(tm[i])?(v+tm[i])/2:(Number.isFinite(v)?v:tm[i]));
  const pm=momOf(lP,c.fast,c.slow);
  return lagArr(expandingOrthog(comp,pm,365),LAG); // ADOPTION-ONLY
}
function pos(P:NetPanel,sig:number[],c:Cfg){const z=rollingZ(sig,c.zwin);const p=new Array(P.price.length).fill(NaN);
  for(let t=0;t<P.price.length;t++){if(!Number.isFinite(z[t]))continue;
    if(c.side==="tilt")p[t]=z[t]<=-c.thr?0:1; else if(z[t]>=c.thr)p[t]=1; else if(z[t]<=-c.thr)p[t]=c.side==="longshort"?-1:0; else p[t]=0;}
  return p;}
function grid():Cfg[]{const F=[7,14,30],S=[30,60,90,180],Z=[180,365,730],TH=[0,0.5,1.0],SD:Cfg["side"][]=["longflat","longshort","tilt"];const g:Cfg[]=[];
  for(const fast of F)for(const slow of S){if(slow<=fast)continue;for(const zwin of Z)for(const thr of TH)for(const side of SD)g.push({fast,slow,zwin,thr,side});}return g;}
function arFit(x:number[],p:number){const v=x.filter(q=>Number.isFinite(q)),n=v.length,mu=v.reduce((s,q)=>s+q,0)/n;
  const c=(k:number)=>{let s=0;for(let i=k;i<n;i++)s+=(v[i]-mu)*(v[i-k]-mu);return s/n;};const r=Array.from({length:p+1},(_,k)=>c(k));
  const phi=new Array(p).fill(0);let e=r[0];for(let i=0;i<p;i++){let acc=r[i+1];for(let j=0;j<i;j++)acc-=phi[j]*r[i-j];const k=e>1e-12?acc/e:0;const pr=phi.slice(0,i);phi[i]=k;for(let j=0;j<i;j++)phi[j]=pr[j]-k*pr[i-1-j];e*=1-k*k;}return{phi,mu,sigma:Math.sqrt(Math.max(0,e))};}
function arSurr(x:number[],fit:any,rng:()=>number){const p=fit.phi.length,T=x.length,out=new Array(T).fill(NaN),buf:number[]=[];
  for(let t=0;t<T;t++){if(!Number.isFinite(x[t])){out[t]=NaN;continue;}let val:number;if(buf.length<p)val=x[t]-fit.mu;else{let pr=0;for(let j=0;j<p;j++)pr+=fit.phi[j]*buf[buf.length-1-j];const u1=Math.max(1e-12,rng()),u2=rng();val=pr+fit.sigma*Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);}buf.push(val);out[t]=val+fit.mu;}return out;}
function main(){
  const asset=(process.argv[2] as "btc"|"eth")||"btc";
  const P=loadNetPanel(asset);const T=P.price.length;
  console.log(`\n##### O1-ADRACT ORTHOGONALIZED (adoption-only) ${asset.toUpperCase()} T=${T} #####`);
  const g=grid();const cache=new Map<string,number[]>();
  const sf=(c:Cfg)=>{const k=`${c.fast}-${c.slow}`;let s=cache.get(k);if(!s){s=sigFor(P,c);cache.set(k,s);}return s;};
  const startIdx=500;
  const input:GauntletInput={name:`O1-ADRACT-ORTH-${asset}`,P,
    buildPosition:c=>pos(P,sf(cfgK(c)),cfgK(c)),
    buildSurrogatePosition:(c,rng)=>{const cc=cfgK(c);return pos(P,phaseRandomize(sf(cc),rng),cc);},
    configs:g as any,canonical:{fast:14,slow:60,zwin:365,thr:0,side:"longflat"},startIdx,holdoutFrac:0.2,nSurr:300};
  const out=runGauntlet(input);printVerdict(out);
  // AR placebo on IS-best
  const tradableEnd=T-1,span=tradableEnd-startIdx,splitIdx=startIdx+Math.floor(span*0.8);
  const bc=cfgK(out.best.cfg),bs=sf(bc),bp=pos(P,bs,bc);
  const bIS=annSharpe(sharpeDaily(runPositions(P,bp,startIdx,splitIdx).dailyNet));
  const fit=arFit(bs,5);const ar:number[]=[];for(let i=0;i<300;i++){const r=mkRng(31000+i*7919);ar.push(annSharpe(sharpeDaily(runPositions(P,pos(P,arSurr(bs,fit,r),bc),startIdx,splitIdx).dailyNet)));}
  ar.sort((a,b)=>a-b);const arP=(ar.filter(s=>s>=bIS).length+1)/301;
  console.log(`AR-matched placebo (AR5): bestIS=${bIS.toFixed(3)} arP=${arP.toFixed(4)} ${arP<0.05?"PASS":"FAIL"}`);
  fs.writeFileSync(`${OUT}/result_adract_orth_${asset}.json`,JSON.stringify({...out,arPlaceboP:arP},null,2));
}
main();
