/** Placebo-stability: re-run the shuffled-GATE placebo across multiple seeds & iters.
 *  The prior SIZING version failed at p=0.14; the gate version reported p=0.046 (right at 0.05).
 *  Confirm the gate placebo p is robustly < 0.05 (or not) before trusting it. Reuses canon stream. */
import { readFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";
const ANN_DAYS=365,TAKER=0.0004,TAIL_MULT=1.5,H=7;
const readJson=<T>(p:string)=>JSON.parse(readFileSync(p,"utf8")) as T;
const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const std=(a:number[])=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
const quantile=(s:number[],q:number)=>{if(!s.length)return 0;const p=(s.length-1)*q;const lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?s[lo]:s[lo]*(hi-p)+s[hi]*(p-lo);};
function rng(seed:number){let s=seed>>>0;return()=>{s+=0x6d2b79f5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
interface DayOHLC{date:string;open:number;high:number;low:number;close:number;}
const raw=readFileSync("output/bigquery/btc_ohlcv_15m.ndjson","utf8").split("\n");const m=new Map<string,DayOHLC>();for(const l of raw){if(!l)continue;const r=JSON.parse(l);const d=r.event_date;const c=m.get(d);if(!c)m.set(d,{date:d,open:r.open,high:r.high,low:r.low,close:r.close});else{c.high=Math.max(c.high,r.high);c.low=Math.min(c.low,r.low);c.close=r.close;}}
const days=[...m.values()].sort((a,b)=>a.date.localeCompare(b.date));
const vseries=days.map((d,i)=>{const prev=i>0?days[i-1].close:d.open;const rc=Math.log(d.close/prev);const hl=Math.log(d.high/d.low);const co=Math.log(d.close/d.open);const park=(1/(4*Math.log(2)))*hl*hl;const gk=0.5*hl*hl-(2*Math.log(2)-1)*co*co;return{date:d.date,blend:(rc*rc+Math.max(0,park)+Math.max(0,gk))/3};});
const dvol=readJson<{date:string;close:number}[]>("output/edgehunt/dvol_btc.json");const dvolBy=new Map(dvol.map(d=>[d.date,d.close/100]));
const fundRows=readJson<{fundingTime:number;fundingRate:number}[]>("output/funding/BTCUSDT_funding_8h.json");const fundDay=new Map<string,number>();for(const r of fundRows){const d=new Date(r.fundingTime).toISOString().slice(0,10);fundDay.set(d,(fundDay.get(d)??0)+r.fundingRate);}
const fwdRV=(i:number)=>{if(i+H>vseries.length)return null;let s=0;for(let k=i;k<i+H;k++)s+=vseries[k].blend;return Math.sqrt((s/H)*ANN_DAYS);};
const trailRV=(i:number)=>{if(i-H<0)return null;let s=0;for(let k=i-H;k<i;k++)s+=vseries[k].blend;return Math.sqrt((s/H)*ANN_DAYS);};
const spikeZ=(i:number)=>{const iv=dvolBy.get(vseries[i].date);if(iv===undefined)return 0;const p:number[]=[];for(let k=Math.max(0,i-90);k<i;k++){const v=dvolBy.get(vseries[k].date);if(v!==undefined)p.push(v);}if(p.length<5)return 0;const me=mean(p),s=std(p)||1e-9;return(iv-me)/s;};
const benign=(i:number)=>{const rvs:number[]=[];for(let k=Math.max(H,i-90);k<=i;k++){const r=trailRV(k);if(r!==null)rvs.push(r);}if(rvs.length<10)return true;const cur=rvs.at(-1)!;return cur<=quantile([...rvs].sort((a,b)=>a-b),0.6);};
interface W{on:boolean;payoff:number;iv:number;r:number;funding:number;net:number;}
const wins:W[]=[];
for(let i=H;i+H<=vseries.length;i+=H){const iv=dvolBy.get(vseries[i].date);if(iv===undefined)continue;const fwd=fwdRV(i);if(fwd===null)continue;if(trailRV(i)===null)continue;if(i-90<0)continue;
  let on=true;if(spikeZ(i)>1.5)on=false;if(!benign(i))on=false;const size=on?1:0;const payoff=iv*iv-fwd*fwd;const gross=size*payoff;
  let fs=0;for(let k=i;k<i+H;k++){const f=fundDay.get(vseries[k].date);if(f!==undefined)fs+=Math.abs(f);}const fund=size>0?size*fs*0.5:0;const taker=size>0?(2+H)*TAKER:0;const r=fwd/iv;let tail=0;if(size>0&&r>1.0){const e=r-1.0;tail=size*(iv*iv)*e*e*TAIL_MULT;}
  // store realized funding share even if flat (use window's own funding sum for if-on reconstruction)
  wins.push({on,payoff,iv,r,funding:fs*0.5,net:gross-fund-taker-tail});}
const annSharpe=(r:number[])=>summarizeReturnSeries(r).sharpe*Math.sqrt(ANN_DAYS/H);
const observed=annSharpe(wins.map(w=>w.net));const onFrac=wins.filter(w=>w.on).length/wins.length;
const ifOn=wins.map(w=>{const gross=w.payoff;const taker=(2+H)*TAKER;let tail=0;if(w.r>1.0){const e=w.r-1.0;tail=w.iv*w.iv*e*e*TAIL_MULT;}return gross-taker-tail-w.funding;});
function placeboP(seed:number,iters:number){const rr=rng(seed);let ge=0;for(let it=0;it<iters;it++){const idx=wins.map((_,i)=>i);for(let i=idx.length-1;i>0;i--){const j=Math.floor(rr()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]];}const nOn=Math.round(onFrac*wins.length);const onSet=new Set(idx.slice(0,nOn));const rets=wins.map((_,i)=>onSet.has(i)?ifOn[i]:0);if(annSharpe(rets)>=observed)ge++;}return ge/iters;}
const ps=[111,222,333,444,555,666,777,888].map(s=>+placeboP(s,5000).toFixed(4));
console.log(JSON.stringify({observedSharpe:+observed.toFixed(3),onFrac:+onFrac.toFixed(3),placebo_p_8seeds:ps,mean_p:+mean(ps).toFixed(4),max_p:Math.max(...ps),all_below_05:ps.every(p=>p<0.05)},null,2));
