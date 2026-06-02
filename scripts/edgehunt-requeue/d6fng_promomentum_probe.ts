/**
 * Devil's-advocate robustness probe: the explore showed FNG's sign is momentum-like
 * (greed -> higher fwd ret). The contrarian thesis is dead; is the OPPOSITE (pro-cyclical
 * "trend") salvageable, and does it beat the AR(1) placebo? If even the best-signed FNG rule
 * loses to a persistent-random placebo, sentiment content is conclusively zero.
 */
import fs from "node:fs";
const ROOT = ".";
function loadFng(){const j=JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D6/fng_history.json`,"utf8"));const m=new Map<string,number>();for(const r of j.data){const d=new Date(Number(r.timestamp)*1000).toISOString().slice(0,10);m.set(d,Number(r.value));}return m;}
function loadBtc(){const out=new Map<string,number>();const nf1=JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`,"utf8")) as any[];for(const r of nf1)if(r.date&&Number.isFinite(r.close))out.set(r.date,r.close);const cm=JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_btc.json`,"utf8")) as any;for(const r of cm.data){if(!r.PriceUSD)continue;const d=r.time.slice(0,10);if(!out.has(d)){const px=Number(r.PriceUSD);if(Number.isFinite(px))out.set(d,px);}}return out;}
const mean=(a:number[])=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const std=(a:number[])=>{const n=a.length;if(n<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(n-1));};
const ANN=Math.sqrt(365);
const sh=(a:number[])=>{const s=std(a);return s>1e-12?(mean(a)/s)*ANN:0;};
function rng(seed:number){let s=seed>>>0;return()=>{s+=0x6d2b79f5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
function gauss(r:()=>number){const u1=Math.max(1e-12,r());const u2=r();return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);}

const fm=loadFng(),bm=loadBtc();
const dates=[...fm.keys()].filter(d=>bm.has(d)).sort();
const T=dates.length;
const fng=dates.map(d=>fm.get(d)!);
const px=dates.map(d=>bm.get(d)!);
const fwd:number[]=new Array(T).fill(NaN);for(let t=0;t<T-1;t++)fwd[t]=Math.log(px[t+1]/px[t]);
const COST=0.0004;
// AR(1)
function ar1(lv:number[]){let sxy=0,sxx=0,sx=0,sy=0;const m=lv.length-1;for(let i=1;i<lv.length;i++){sx+=lv[i-1];sy+=lv[i];sxy+=lv[i-1]*lv[i];sxx+=lv[i-1]*lv[i-1];}const phi=(m*sxy-sx*sy)/(m*sxx-sx*sx);const c=(sy-phi*sx)/m;let sse=0;for(let i=1;i<lv.length;i++){const e=lv[i]-(c+phi*lv[i-1]);sse+=e*e;}return{phi,c,sigma:Math.sqrt(sse/(m-2)),mean:mean(lv)};}
const AR=ar1(fng);
const startIdx=200,tradableEnd=T-1,splitIdx=startIdx+Math.floor((tradableEnd-startIdx)*0.8);

// PRO-CYCLICAL (momentum) rule grid: long when FNG high (greed), flat/short when FNG low (fear).
type Cfg={lo:number,hi:number,fearAct:number,base:number,lag:number};
const cfgs:Cfg[]=[];
for(const lo of[20,25,30,35])for(const hi of[60,65,70,75])for(const fearAct of[0,-1])for(const base of[0,1])for(const lag of[0,1])cfgs.push({lo,hi,fearAct,base,lag});
function buildPro(sig:number[],c:Cfg){const pos=new Array(T).fill(NaN);for(let t=0;t<T;t++){const st=t-c.lag;if(st<0)continue;const v=sig[st];if(!Number.isFinite(v))continue;let p=c.base;if(v>=c.hi)p=1;else if(v<=c.lo)p=c.fearAct;pos[t]=p;}return pos;}
function run(pos:number[],lo:number,hi:number){const out:number[]=[];let prev=0,exp=0;for(let t=lo;t<hi;t++){const fr=fwd[t],p=pos[t];if(!Number.isFinite(fr)||!Number.isFinite(p))continue;out.push(p*fr-Math.abs(p-prev)*COST);exp+=Math.abs(p);prev=p;}return{net:out,exp:out.length?exp/out.length:0};}
function bestOn(sig:number[]){let b=-Infinity;for(const c of cfgs){const r=run(buildPro(sig,c),startIdx,splitIdx);const s=sh(r.net);if(s>b)b=s;}return b;}

const scored=cfgs.map(c=>{const r=run(buildPro(fng,c),startIdx,splitIdx);return{c,s:sh(r.net),exp:r.exp,pos:buildPro(fng,c)};}).sort((a,b)=>b.s-a.s);
const best=scored[0];
const bh=run(new Array(T).fill(1),startIdx,splitIdx);const bhSh=sh(bh.net);
const hold=run(best.pos,splitIdx,tradableEnd);const holdSh=sh(hold.net);
// AR(1) placebo best-of-grid
const NS=500;let ge=0;const pl:number[]=[];
for(let s=0;s<NS;s++){const r=rng(7000+s*7919);const fake=new Array<number>(T);fake[0]=AR.mean;for(let i=1;i<T;i++){let v=AR.c+AR.phi*fake[i-1]+AR.sigma*gauss(r);v=Math.max(0,Math.min(100,v));fake[i]=v;}const bs=bestOn(fake);pl.push(bs);if(bs>=best.s)ge++;}
pl.sort((a,b)=>a-b);const p=(ge+1)/(NS+1);
console.log(`PRO-CYCLICAL(momentum-FNG) probe — honestN=${cfgs.length}`);
console.log(`  best IS netSharpe=${best.s.toFixed(3)} (lo${best.c.lo}/hi${best.c.hi}/fearAct${best.c.fearAct}/base${best.c.base}/lag${best.c.lag}) exp=${best.exp.toFixed(2)}`);
console.log(`  B&H IS netSharpe=${bhSh.toFixed(3)}   beats B&H? ${best.s>bhSh}`);
console.log(`  holdout OOS netSharpe=${holdSh.toFixed(3)}`);
console.log(`  AR(1)-placebo best: med=${pl[NS/2].toFixed(3)} p95=${pl[Math.floor(NS*0.95)].toFixed(3)} max=${pl[NS-1].toFixed(3)}  p(placebo>=real)=${p.toFixed(4)} (<0.05 to pass)`);
