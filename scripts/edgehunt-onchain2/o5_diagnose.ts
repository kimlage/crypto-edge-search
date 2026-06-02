/**
 * O5-HEIKIN diagnostics: understand the vol/spectrum-preserving surrogate distribution and
 * whether ANY HA long-flat config beats the surrogate-recompute null after deflation.
 * Reuses the same OHLC + HA + surrogate machinery as o5_heikin.ts (inlined to keep self-contained).
 */
import fs from "node:fs";
const ROOT = ".";
const COST = 0.0004;
const ANN = Math.sqrt(365);
function mean(a:number[]){return a.length?a.reduce((s,v)=>s+v,0)/a.length:0;}
function std(a:number[]){const n=a.length;if(n<2)return 0;const m=mean(a);return Math.sqrt(Math.max(0,a.reduce((s,x)=>s+(x-m)**2,0)/(n-1)));}
function shD(a:number[]){const s=std(a);return s>1e-12?mean(a)/s:0;}
function aSh(d:number){return d*ANN;}
function mkRng(seed:number){let s=seed>>>0;return()=>{s+=0x6d2b79f5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}

interface OHLC{open:number[];high:number[];low:number[];close:number[];fwdRet:number[];dates:string[];}
function loadDailyOHLC():OHLC{
  const raw=fs.readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`,"utf8").trim().split("\n");
  const byDay=new Map<string,{o:number;h:number;l:number;c:number;firstT:string;lastT:string}>();
  for(const ln of raw){if(!ln)continue;const r=JSON.parse(ln);const d=r.event_date;const o=+r.open,h=+r.high,l=+r.low,c=+r.close;if(!(c>0))continue;const cur=byDay.get(d);if(!cur)byDay.set(d,{o,h,l,c,firstT:r.event_time,lastT:r.event_time});else{if(r.event_time<cur.firstT){cur.o=o;cur.firstT=r.event_time;}if(r.event_time>cur.lastT){cur.c=c;cur.lastT=r.event_time;}if(h>cur.h)cur.h=h;if(l<cur.l)cur.l=l;}}
  const dates=[...byDay.keys()].sort();const out:OHLC={open:[],high:[],low:[],close:[],fwdRet:[],dates:[]};
  for(const d of dates){const b=byDay.get(d)!;out.dates.push(d);out.open.push(b.o);out.high.push(b.h);out.low.push(b.l);out.close.push(b.c);}
  const T=out.close.length;for(let t=0;t<T;t++)out.fwdRet.push(t+1<T?Math.log(out.close[t+1]/out.close[t]):NaN);return out;
}
interface HA{open:number[];high:number[];low:number[];close:number[];}
function heikinAshi(o:number[],h:number[],l:number[],c:number[]):HA{const T=c.length;const ho=new Array(T).fill(NaN),hc=new Array(T).fill(NaN),hh=new Array(T).fill(NaN),hl=new Array(T).fill(NaN);for(let t=0;t<T;t++){hc[t]=(o[t]+h[t]+l[t]+c[t])/4;ho[t]=t===0?(o[t]+c[t])/2:(ho[t-1]+hc[t-1])/2;hh[t]=Math.max(h[t],ho[t],hc[t]);hl[t]=Math.min(l[t],ho[t],hc[t]);}return{open:ho,high:hh,low:hl,close:hc};}
function emaArr(x:number[],span:number){const a=2/(span+1);const out=new Array(x.length).fill(NaN);let prev=NaN;for(let i=0;i<x.length;i++){const v=x[i];if(!Number.isFinite(v)){out[i]=prev;continue;}prev=Number.isFinite(prev)?a*v+(1-a)*prev:v;out[i]=prev;}return out;}
type Cfg={variant:string;p:number};
function positionsFromHA(ha:HA,cfg:Cfg):number[]{const T=ha.close.length;const pos=new Array(T).fill(0);if(cfg.variant==="green"){for(let t=0;t<T;t++)pos[t]=ha.close[t]>ha.open[t]?1:0;}else if(cfg.variant==="nowick"){const tol=cfg.p;for(let t=0;t<T;t++){const g=ha.close[t]>ha.open[t];const w=ha.low[t]>=ha.open[t]*(1-tol);pos[t]=g&&w?1:0;}}else if(cfg.variant==="streak"){const k=Math.round(cfg.p);let run=0;for(let t=0;t<T;t++){run=ha.close[t]>ha.open[t]?run+1:0;pos[t]=run>=k?1:0;}}else if(cfg.variant==="ema"){const span=Math.round(cfg.p);const e=emaArr(ha.close,span);for(let t=0;t<T;t++)pos[t]=Number.isFinite(e[t])&&ha.close[t]>e[t]&&ha.close[t]>ha.open[t]?1:0;}return pos;}
function runPos(fwd:number[],pos:number[],s:number,e:number){let prev=0;const net:number[]=[];for(let t=s;t<e;t++){const fr=fwd[t],p=pos[t];if(!Number.isFinite(fr)||!Number.isFinite(p))continue;net.push(p*fr-Math.abs(p-prev)*COST);prev=p;}return net;}
// FFT phase-randomize (radix2 + bluestein)
function fftR2(re:number[],im:number[],inv:boolean){const n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}for(let len=2;len<=n;len<<=1){const ang=(inv?2:-2)*Math.PI/len;const wr=Math.cos(ang),wi=Math.sin(ang);for(let i=0;i<n;i+=len){let cwr=1,cwi=0;for(let k=0;k<len/2;k++){const ur=re[i+k],ui=im[i+k];const vr=re[i+k+len/2]*cwr-im[i+k+len/2]*cwi;const vi=re[i+k+len/2]*cwi+im[i+k+len/2]*cwr;re[i+k]=ur+vr;im[i+k]=ui+vi;re[i+k+len/2]=ur-vr;im[i+k+len/2]=ui-vi;const ncwr=cwr*wr-cwi*wi;cwi=cwr*wi+cwi*wr;cwr=ncwr;}}}if(inv)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}}
function fftBlue(re:number[],im:number[],inv:boolean){const n=re.length;let m=1;while(m<2*n+1)m<<=1;const cT=new Array(n),sT=new Array(n),ar=new Array(m).fill(0),ai=new Array(m).fill(0),br=new Array(m).fill(0),bi=new Array(m).fill(0);for(let i=0;i<n;i++){const j=(i*i)%(2*n);const ang=(inv?Math.PI:-Math.PI)*j/n;cT[i]=Math.cos(ang);sT[i]=Math.sin(ang);ar[i]=re[i]*cT[i]-im[i]*sT[i];ai[i]=re[i]*sT[i]+im[i]*cT[i];}br[0]=cT[0];bi[0]=sT[0];for(let i=1;i<n;i++){br[i]=br[m-i]=cT[i];bi[i]=bi[m-i]=sT[i];}fftR2(ar,ai,false);fftR2(br,bi,false);for(let i=0;i<m;i++){const tr=ar[i]*br[i]-ai[i]*bi[i];ai[i]=ar[i]*bi[i]+ai[i]*br[i];ar[i]=tr;}fftR2(ar,ai,true);for(let i=0;i<n;i++){re[i]=ar[i]*cT[i]-ai[i]*sT[i];im[i]=ar[i]*sT[i]+ai[i]*cT[i];}}
function fft(re:number[],im:number[],inv:boolean){const n=re.length;if(n<=1)return;if((n&(n-1))===0)fftR2(re,im,inv);else fftBlue(re,im,inv);}
function phaseRand(x:number[],rng:()=>number){const n=x.length;const re=x.slice(),im=new Array(n).fill(0);fft(re,im,false);for(let k=1;k<Math.floor(n/2)+1;k++){const mag=Math.hypot(re[k],im[k]);const ph=2*Math.PI*rng();const nr=mag*Math.cos(ph),ni=mag*Math.sin(ph);re[k]=nr;im[k]=ni;const j=(n-k)%n;re[j]=nr;im[j]=-ni;}fft(re,im,true);return re.slice(0,n);}
function buildSurr(real:OHLC,rng:()=>number):OHLC{const T=real.close.length;const lr:number[]=[];for(let t=1;t<T;t++)lr.push(Math.log(real.close[t]/real.close[t-1]));const sl=phaseRand(lr,rng);const close=new Array(T);close[0]=real.close[0];for(let t=1;t<T;t++)close[t]=close[t-1]*Math.exp(sl[t-1]);const open=new Array(T),high=new Array(T),low=new Array(T);for(let t=0;t<T;t++){const k=close[t]/real.close[t];open[t]=real.open[t]*k;high[t]=real.high[t]*k;low[t]=real.low[t]*k;}const fwd=new Array(T);for(let t=0;t<T;t++)fwd[t]=t+1<T?Math.log(close[t+1]/close[t]):NaN;return{open,high,low,close,fwdRet:fwd,dates:real.dates};}

const real=loadDailyOHLC();
const T=real.close.length;const startIdx=30;const tradableEnd=T-1;const splitIdx=startIdx+Math.floor((tradableEnd-startIdx)*0.8);
const realHA=heikinAshi(real.open,real.high,real.low,real.close);

const configs:Cfg[]=[{variant:"green",p:0}];
for(const tol of[0,0.001,0.002,0.005])configs.push({variant:"nowick",p:tol});
for(const k of[1,2,3,4])configs.push({variant:"streak",p:k});
for(const span of[5,10,20,30,50])configs.push({variant:"ema",p:span});

const nSurr=500;
console.log("config           ISnetSh  surrMean surr50 surr90 surr95 surr99  surrP");
for(const cfg of configs){
  const pos=positionsFromHA(realHA,cfg);
  const net=runPos(real.fwdRet,pos,startIdx,splitIdx);
  const isSh=aSh(shD(net));
  const surr:number[]=[];
  for(let i=0;i<nSurr;i++){const rng=mkRng(13000+i*7919);const s=buildSurr(real,rng);const sHA=heikinAshi(s.open,s.high,s.low,s.close);const sp=positionsFromHA(sHA,cfg);surr.push(aSh(shD(runPos(s.fwdRet,sp,startIdx,splitIdx))));}
  surr.sort((a,b)=>a-b);
  const q=(p:number)=>surr[Math.min(nSurr-1,Math.floor(nSurr*p))];
  const surrP=(surr.filter(s=>s>=isSh).length+1)/(nSurr+1);
  console.log(`${(cfg.variant+":"+cfg.p).padEnd(16)} ${isSh.toFixed(3).padStart(7)} ${mean(surr).toFixed(3).padStart(7)} ${q(0.5).toFixed(2).padStart(6)} ${q(0.9).toFixed(2).padStart(6)} ${q(0.95).toFixed(2).padStart(6)} ${q(0.99).toFixed(2).padStart(6)}  ${surrP.toFixed(4)}`);
}
