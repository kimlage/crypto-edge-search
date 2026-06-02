/**
 * O6-FRACTAL — pre-registered canonical run (N=1, no selection) + a restrained Williams-5 grid.
 * This removes the selection-overfit confound: if the canonical Williams 5-bar long/flat fractal
 * breakout carries edge, it should pass the right null AND the consume-once holdout on its own.
 */
import fs from "node:fs";
import {
  type Panel,
  runGauntlet,
  printVerdict,
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
function buildPos(P:FP,cfg:Record<string,number|string>){
  const half=(Number(cfg.n)-1)/2;const b=Number(cfg.buf)/10000;const mode=String(cfg.mode);
  const{upLevel,dnLevel}=fractalLevels(P.high,P.low,half);
  const T=P.price.length;const pos=new Array(T).fill(NaN);let cur=0;
  for(let t=0;t<T;t++){const c=P.price[t];const up=upLevel[t];const dn=dnLevel[t];
    if(Number.isFinite(up)&&c>up*(1+b))cur=1;else if(Number.isFinite(dn)&&c<dn*(1-b))cur=mode==="ls"?-1:0;pos[t]=cur;}
  return pos;
}
function buildPlacebo(P:FP,cfg:Record<string,number|string>,rng:()=>number){
  const half=(Number(cfg.n)-1)/2;const b=Number(cfg.buf)/10000;const mode=String(cfg.mode);
  const T=P.price.length;const upLevel=new Array(T).fill(NaN),dnLevel=new Array(T).fill(NaN);let lu=NaN,ld=NaN;
  for(let t=0;t<T;t++){const c=t-half;if(c>=0){const lo=Math.max(0,c-half),hi=Math.min(T-1,c+half);let mn=Infinity,mx=-Infinity;for(let k=lo;k<=hi;k++){if(P.high[k]>mx)mx=P.high[k];if(P.low[k]<mn)mn=P.low[k];}if(mx>mn){lu=mn+(mx-mn)*rng();ld=mn+(mx-mn)*rng();}}upLevel[t]=lu;dnLevel[t]=ld;}
  const pos=new Array(T).fill(NaN);let cur=0;
  for(let t=0;t<T;t++){const c=P.price[t];const up=upLevel[t];const dn=dnLevel[t];
    if(Number.isFinite(up)&&c>up*(1+b))cur=1;else if(Number.isFinite(dn)&&c<dn*(1-b))cur=mode==="ls"?-1:0;pos[t]=cur;}
  return pos;
}

const bars=loadBars();const P=buildPanel(bars);const startIdx=30;
const canonical={n:5,mode:"lf",buf:0};

// (a) N=1 pre-registered canonical Williams 5-bar long/flat
const outCanon=runGauntlet({name:"O6-FRACTAL canonical N=1 (Williams 5-bar lf buf0)",P,
  buildPosition:(cfg)=>buildPos(P,cfg),configs:[canonical],
  buildSurrogatePosition:(cfg,rng)=>buildPlacebo(P,cfg,rng),canonical,startIdx,holdoutFrac:0.2,nSurr:1000});
printVerdict(outCanon);

// (b) restrained canonical-family grid: n=5 only, both modes, small buffers (honest N=8)
const grid:Record<string,number|string>[]=[];
for(const mode of ["lf","ls"]) for(const buf of [0,10,25,50]) grid.push({n:5,mode,buf});
const outGrid=runGauntlet({name:"O6-FRACTAL Williams-5 family (n=5 only, honest N=8)",P,
  buildPosition:(cfg)=>buildPos(P,cfg),configs:grid,
  buildSurrogatePosition:(cfg,rng)=>buildPlacebo(P,cfg,rng),canonical,startIdx,holdoutFrac:0.2,nSurr:500});
printVerdict(outGrid);

fs.writeFileSync(`${ROOT}/output/edgehunt-onchain2/o6_canonical_result.json`,JSON.stringify({outCanon,outGrid},null,2));
