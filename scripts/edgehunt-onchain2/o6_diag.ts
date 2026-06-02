/**
 * O6-FRACTAL diagnostic sweep: print IS / OOS / placebo for every config to understand the
 * landscape honestly (is there a stable region, or is the IS edge pure selection?).
 */
import fs from "node:fs";
import {
  type Panel,
  mkRng,
  annSharpe,
  sharpeDaily,
  runPositions,
  mean,
  std,
} from "../edgehunt-D5/harness.ts";

const ROOT = ".";

interface Bar { date: string; open: number; high: number; low: number; close: number; }
function loadBars(): Bar[] {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8"));
  const bars: Bar[] = j.map((r: any) => ({ date: r.date, open: +r.open, high: +r.high, low: +r.low, close: +r.close }))
    .filter((b: Bar) => b.high > 0 && b.low > 0 && b.close > 0 && b.high >= b.low);
  bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return bars;
}
interface FP extends Panel { high: number[]; low: number[]; }
function buildPanel(bars: Bar[]): FP {
  const T = bars.length;
  const P: any = { asset: "btc", dates: bars.map(b=>b.date), price: bars.map(b=>b.close), high: bars.map(b=>b.high), low: bars.map(b=>b.low),
    mvrv:[], flowInNtv:[], flowOutNtv:[], adr:[], marketCap:[], hashRate:[], supply:[], realizedCap:[], realizedPrice:[], fwdRet:[] as number[] };
  for (let t=0;t<T;t++) P.fwdRet.push(t+1<T?Math.log(P.price[t+1]/P.price[t]):NaN);
  return P as FP;
}
function fractalLevels(high:number[], low:number[], half:number){
  const T=high.length; const isUp=new Array(T).fill(false); const isDn=new Array(T).fill(false);
  for(let c=half;c<T-half;c++){let up=true,dn=true;for(let k=c-half;k<=c+half;k++){if(k===c)continue;if(high[k]>=high[c])up=false;if(low[k]<=low[c])dn=false;}isUp[c]=up;isDn[c]=dn;}
  const upLevel=new Array(T).fill(NaN),dnLevel=new Array(T).fill(NaN);let lu=NaN,ld=NaN;
  for(let t=0;t<T;t++){const c=t-half;if(c>=0){if(isUp[c])lu=high[c];if(isDn[c])ld=low[c];}upLevel[t]=lu;dnLevel[t]=ld;}
  return {upLevel,dnLevel};
}
function buildPos(P:FP,n:number,mode:string,buf:number){
  const half=(n-1)/2;const b=buf/10000;const{upLevel,dnLevel}=fractalLevels(P.high,P.low,half);
  const T=P.price.length;const pos=new Array(T).fill(NaN);let cur=0;
  for(let t=0;t<T;t++){const c=P.price[t];const up=upLevel[t];const dn=dnLevel[t];
    if(Number.isFinite(up)&&c>up*(1+b))cur=1;else if(Number.isFinite(dn)&&c<dn*(1-b))cur=mode==="ls"?-1:0;pos[t]=cur;}
  return pos;
}

const bars=loadBars();const P=buildPanel(bars);const T=P.price.length;const startIdx=30;
const splitIdx=startIdx+Math.floor((T-1-startIdx)*0.8);const tradableEnd=T-1;
console.log(`bars=${T} IS=[${startIdx},${splitIdx}) (${P.dates[startIdx]}..${P.dates[splitIdx]}) OOS=[${splitIdx},${tradableEnd}) (${P.dates[splitIdx]}..${P.dates[tradableEnd-1]})`);
// full-sample B&H reference
const bhFull=runPositions(P,new Array(T).fill(1),startIdx,tradableEnd);
console.log(`B&H full netSh=${annSharpe(sharpeDaily(bhFull.dailyNet)).toFixed(3)}  IS B&H=${annSharpe(sharpeDaily(runPositions(P,new Array(T).fill(1),startIdx,splitIdx).dailyNet)).toFixed(3)} OOS B&H=${annSharpe(sharpeDaily(runPositions(P,new Array(T).fill(1),splitIdx,tradableEnd).dailyNet)).toFixed(3)}`);
console.log("n mode buf | IS_net  OOS_net  FULL_net  exp  turn  long%");
const rows:any[]=[];
for(const n of [3,5,7,9,11,15,21]) for(const mode of ["lf","ls"]) for(const buf of [0,10,25,50,100]){
  const pos=buildPos(P,n,mode,buf);
  const is=runPositions(P,pos,startIdx,splitIdx);
  const oos=runPositions(P,pos,splitIdx,tradableEnd);
  const full=runPositions(P,pos,startIdx,tradableEnd);
  const r={n,mode,buf,IS:annSharpe(sharpeDaily(is.dailyNet)),OOS:annSharpe(sharpeDaily(oos.dailyNet)),FULL:annSharpe(sharpeDaily(full.dailyNet)),exp:full.exposure,turn:full.turnover,long:full.longShare};
  rows.push(r);
  console.log(`${n} ${mode} ${String(buf).padStart(3)} | ${r.IS.toFixed(3).padStart(6)} ${r.OOS.toFixed(3).padStart(7)} ${r.FULL.toFixed(3).padStart(8)}  ${r.exp.toFixed(2)} ${r.turn.toFixed(3)} ${(r.long*100).toFixed(0)}%`);
}
// correlation IS vs OOS across configs (does IS rank predict OOS at all?)
const xs=rows.map(r=>r.IS),ys=rows.map(r=>r.OOS);
const mx=mean(xs),my=mean(ys);let cov=0;for(let i=0;i<xs.length;i++)cov+=(xs[i]-mx)*(ys[i]-my);cov/=xs.length;
const corr=cov/(std(xs)*std(ys));
console.log(`\ncorr(IS_net, OOS_net) across ${rows.length} configs = ${corr.toFixed(3)}  (>0 = IS rank carries forward; <=0 = selection is noise)`);
const lfFull=rows.filter(r=>r.mode==="lf").map(r=>r.FULL);
console.log(`mean FULL net Sharpe (long/flat configs) = ${mean(lfFull).toFixed(3)} vs B&H full ${annSharpe(sharpeDaily(bhFull.dailyNet)).toFixed(3)}`);
