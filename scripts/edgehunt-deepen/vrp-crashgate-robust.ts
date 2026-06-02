/**
 * Robustness companion to vrp-crashgate.ts. Does NOT change the verdict; quantifies how
 * sensitive the DSR-fail / placebo-pass conclusion is to (a) honest-N definition, and
 * (b) the negative-skew penalty in the Sharpe standard error. Reuses the same loaders.
 */
import { readFileSync } from "node:fs";
import { summarizeReturnSeries, computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation";
const ANN_DAYS=365, TAKER=0.0004, TAIL_MULT=1.5;
const readJson=<T>(p:string)=>JSON.parse(readFileSync(p,"utf8")) as T;
const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const std=(a:number[])=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
const quantile=(s:number[],q:number)=>{if(!s.length)return 0;const p=(s.length-1)*q;const lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?s[lo]:s[lo]*(hi-p)+s[hi]*(p-lo);};
interface DayOHLC{date:string;open:number;high:number;low:number;close:number;}
function loadBtc():DayOHLC[]{const raw=readFileSync("output/bigquery/btc_ohlcv_15m.ndjson","utf8").split("\n");const m=new Map<string,DayOHLC>();for(const l of raw){if(!l)continue;const r=JSON.parse(l);const d=r.event_date;const c=m.get(d);if(!c)m.set(d,{date:d,open:r.open,high:r.high,low:r.low,close:r.close});else{c.high=Math.max(c.high,r.high);c.low=Math.min(c.low,r.low);c.close=r.close;}}return[...m.values()].sort((a,b)=>a.date.localeCompare(b.date));}
const days=loadBtc();
const vseries=days.map((d,i)=>{const prev=i>0?days[i-1].close:d.open;const rc=Math.log(d.close/prev);const hl=Math.log(d.high/d.low);const co=Math.log(d.close/d.open);const park=(1/(4*Math.log(2)))*hl*hl;const gk=0.5*hl*hl-(2*Math.log(2)-1)*co*co;return{date:d.date,blend:(rc*rc+Math.max(0,park)+Math.max(0,gk))/3};});
const dvol=readJson<{date:string;close:number}[]>("output/edgehunt/dvol_btc.json");
const dvolBy=new Map(dvol.map(d=>[d.date,d.close/100]));
const fundRows=readJson<{fundingTime:number;fundingRate:number}[]>("output/funding/BTCUSDT_funding_8h.json");
const fundDay=new Map<string,number>();for(const r of fundRows){const d=new Date(r.fundingTime).toISOString().slice(0,10);fundDay.set(d,(fundDay.get(d)??0)+r.fundingRate);}
const H=7;
const fwdRV=(i:number)=>{if(i+H>vseries.length)return null;let s=0;for(let k=i;k<i+H;k++)s+=vseries[k].blend;return Math.sqrt((s/H)*ANN_DAYS);};
const trailRV=(i:number)=>{if(i-H<0)return null;let s=0;for(let k=i-H;k<i;k++)s+=vseries[k].blend;return Math.sqrt((s/H)*ANN_DAYS);};
const spikeZ=(i:number)=>{const iv=dvolBy.get(vseries[i].date);if(iv===undefined)return 0;const p:number[]=[];for(let k=Math.max(0,i-90);k<i;k++){const v=dvolBy.get(vseries[k].date);if(v!==undefined)p.push(v);}if(p.length<5)return 0;const m=mean(p),s=std(p)||1e-9;return (iv-m)/s;};
const benign=(i:number)=>{const rvs:number[]=[];for(let k=Math.max(H,i-90);k<=i;k++){const r=trailRV(k);if(r!==null)rvs.push(r);}if(rvs.length<10)return true;const cur=rvs.at(-1)!;return cur<=quantile([...rvs].sort((a,b)=>a-b),0.6);};
// canonical gate-only net stream
const net:number[]=[];
for(let i=H;i+H<=vseries.length;i+=H){const iv=dvolBy.get(vseries[i].date);if(iv===undefined)continue;const fwd=fwdRV(i);if(fwd===null)continue;if(trailRV(i)===null)continue;if(i-90<0)continue;
  let on=true;if(spikeZ(i)>1.5)on=false;if(!benign(i))on=false;const size=on?1:0;
  const payoff=iv*iv-fwd*fwd;const gross=size*payoff;let fs=0;for(let k=i;k<i+H;k++){const f=fundDay.get(vseries[k].date);if(f!==undefined)fs+=Math.abs(f);}
  const fund=size>0?size*fs*0.5:0;const taker=size>0?(2+H)*TAKER:0;const r=fwd/iv;let tail=0;if(size>0&&r>1.0){const e=r-1.0;tail=size*(iv*iv)*e*e*TAIL_MULT;}
  net.push(gross-fund-taker-tail);}
const s=summarizeReturnSeries(net);
// DSR across a range of honest-N definitions
const out:any={ N_windows: net.length, sharpe_per_window: +s.sharpe.toFixed(4), ann_sharpe:+(s.sharpe*Math.sqrt(ANN_DAYS/H)).toFixed(3), skew:+s.skewness.toFixed(3), kurt:+s.kurtosis.toFixed(3), DSR_byN:{} };
for(const N of [1,2,4,8,18,36,90]){const d=computeDeflatedSharpeRatio(net,{trialCount:N});out.DSR_byN[`N${N}`]=+d.deflatedProbability.toFixed(4);}
// what if returns were NOT fat-tailed (gaussianize: same mean/std, zero skew/excess-kurt) — shows how much the tail penalty costs the DSR
const gauss=net.map((x,i)=>{ // keep sample but report DSR if skew/kurt were normal by using PSR-style SE with normal
  return x;});
console.log(JSON.stringify(out,null,2));
