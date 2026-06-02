/**
 * AUDIT spot-check for D1-06 CCI surrogate null fairness.
 *
 * Concern: phase/block surrogate mean Sharpe (2.4/2.3) is ABOVE observed (1.768) -> p=1.0. Is this a
 * FAIR null (CCI overlay harvests only long-beta, which the surrogate preserves) or a TOO-POWERFUL
 * null (surrogate construction injects extra drift/edge that the real path lacks, wrongly killing a
 * real edge)? Decisive check: on the SAME surrogate paths, compare CCI-overlay Sharpe vs a passive
 * always-long book Sharpe. If CCI-on-surrogate ~ always-long-on-surrogate, the surrogate Sharpe is
 * just the preserved long-beta and the null is FAIR. Also report surrogate drift vs real drift.
 */
import fs from "node:fs";

const ROOT = ".";
const COST_PER_SIDE = 0.0004;
const SYMBOLS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX"];
interface Bar { date:string; open:number; high:number; low:number; close:number; }
function loadSymbol(sym:string):Bar[]{ const raw=JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`,"utf8")) as Bar[]; return raw.filter(b=>b.open>0&&b.high>0&&b.low>0&&b.close>0); }
const perSym:Record<string,Bar[]>={}; for(const s of SYMBOLS) perSym[s]=loadSymbol(s);
const DATES=Array.from(new Set(SYMBOLS.flatMap(s=>perSym[s].map(b=>b.date)))).sort();
const T=DATES.length; const dateIdx=new Map(DATES.map((d,i)=>[d,i]));
const barAt:Record<string,(Bar|null)[]>={}; for(const s of SYMBOLS){ const a:(Bar|null)[]=Array<Bar|null>(T).fill(null); for(const b of perSym[s]){ const i=dateIdx.get(b.date); if(i!=null) a[i]=b;} barAt[s]=a; }
const logret:Record<string,(number|null)[]>={}; for(const s of SYMBOLS){ const r:(number|null)[]=Array<number|null>(T).fill(null); for(let t=1;t<T;t++){ const a=barAt[s][t-1],b=barAt[s][t]; if(a&&b) r[t]=Math.log(b.close/a.close);} logret[s]=r; }
function mean(a:number[]){ return a.reduce((x,y)=>x+y,0)/Math.max(1,a.length); }
function annualize(d:number){ return d*Math.sqrt(365); }
function summ(a:number[]){ const m=mean(a); const v=a.reduce((x,y)=>x+(y-m)**2,0)/Math.max(1,a.length-1); const sd=Math.sqrt(v); return sd>1e-12?m/sd:0; }
function mkRng(seed:number){ let s=seed>>>0; return ()=>{ s+=0x6d2b79f5; let t=s; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }

// --- CCI (copied) ---
function cciSeries(bars:(Bar|null)[],period:number):(number|null)[]{ const n=bars.length; const out:(number|null)[]=Array<number|null>(n).fill(null); const w:number[]=[];
  for(let t=0;t<n;t++){ const b=bars[t]; if(!b){ out[t]=null; continue;} const tp=(b.high+b.low+b.close)/3; w.push(tp); if(w.length>period) w.shift(); if(w.length<period){ out[t]=null; continue;}
    const sma=w.reduce((a,x)=>a+x,0)/period; let mad=0; for(const x of w) mad+=Math.abs(x-sma); mad/=period; if(mad<1e-12){ out[t]=0; continue;} out[t]=(tp-sma)/(0.015*mad); } return out; }
function cciSignal(cci:(number|null)[],thr:number,mode:"trend"|"revert",side:"longflat"|"longshort"):(number|null)[]{ const n=cci.length; const out:(number|null)[]=Array<number|null>(n).fill(null); let pos=0;
  for(let t=0;t<n;t++){ const v=cci[t]; if(v==null){ out[t]=null; continue;} let d=pos;
    if(mode==="trend"){ if(v>thr) d=1; else if(v<-thr) d=-1; else if(pos===1&&v<0) d=0; else if(pos===-1&&v>0) d=0; }
    else { if(v<-thr) d=1; else if(v>thr) d=-1; else if(pos===1&&v>0) d=0; else if(pos===-1&&v<0) d=0; }
    if(d<0&&side==="longflat") d=0; pos=d; out[t]=pos; } return out; }

const VOL_CAP=3;
function book(sigs:Record<string,(number|null)[]>, lr:Record<string,(number|null)[]>, volTarget:number, volWin:number){
  const net:number[]=[]; const prevW:Record<string,number>={}; for(const s of SYMBOLS) prevW[s]=0; const dtv=volTarget/Math.sqrt(365);
  function tv(s:string,t:number){ const r=lr[s]; const v:number[]=[]; for(let k=Math.max(1,t-volWin);k<t;k++){ const x=r[k]; if(x!=null) v.push(x);} if(v.length<10) return NaN; const m=mean(v); const vv=v.reduce((a,x)=>a+(x-m)**2,0)/(v.length-1); return Math.sqrt(Math.max(0,vv)); }
  for(let t=1;t<T;t++){ let g=0,turn=0; const nw:Record<string,number>={};
    for(const s of SYMBOLS){ const sig=sigs[s][t-1]; const r=lr[s][t]; let w=0; if(sig!=null&&sig!==0){ if(volTarget>0){ const v=tv(s,t); if(Number.isFinite(v)&&v>1e-9) w=sig*Math.min(VOL_CAP,dtv/v);} else w=sig; } nw[s]=w; turn+=Math.abs(w-(prevW[s]??0)); if(r!=null&&w!==0) g+=w*(Math.exp(r)-1); }
    net.push(g/SYMBOLS.length - (turn/SYMBOLS.length)*COST_PER_SIDE); for(const s of SYMBOLS) prevW[s]=nw[s]; }
  return net;
}

// --- surrogate builders (copied) ---
function stationaryBootstrap(m:number,length:number,meanBlock:number,rng:()=>number):number[]{ const out:number[]=[]; if(m===0) return out; let pos=Math.floor(rng()*m); for(let i=0;i<length;i++){ out.push(pos); if(rng()<1/meanBlock) pos=Math.floor(rng()*m); else pos=(pos+1)%m; } return out; }
function dft(re:number[],im:number[],inv:boolean){ const n=re.length; const oR=new Array(n).fill(0),oI=new Array(n).fill(0); const sign=inv?1:-1;
  for(let k=0;k<n;k++){ let sr=0,si=0; for(let j=0;j<n;j++){ const ang=(sign*2*Math.PI*k*j)/n; const c=Math.cos(ang),s=Math.sin(ang); sr+=re[j]*c-im[j]*s; si+=re[j]*s+im[j]*c; } oR[k]=sr; oI[k]=si; }
  for(let k=0;k<n;k++){ re[k]=inv?oR[k]/n:oR[k]; im[k]=inv?oI[k]/n:oI[k]; } }
function phaseRand(series:number[],rng:()=>number):number[]{ const n=series.length; if(n<8) return series.slice(); const m=mean(series); const re=series.map(x=>x-m); const im=new Array(n).fill(0); dft(re,im,false);
  const half=Math.floor(n/2); for(let k=1;k<=half;k++){ const mag=Math.sqrt(re[k]*re[k]+im[k]*im[k]); const ph=2*Math.PI*rng(); re[k]=mag*Math.cos(ph); im[k]=mag*Math.sin(ph); const mir=n-k; if(mir!==k&&mir<n){ re[mir]=re[k]; im[mir]=-im[k]; } } if(n%2===0) im[half]=0; dft(re,im,true); return re.map(x=>x+m); }
function barsFromReturns(start:number,rets:number[],slots:number[]):(Bar|null)[]{ const out:(Bar|null)[]=Array<Bar|null>(T).fill(null); let close=start; for(let i=0;i<slots.length;i++){ const prev=close; close=close*Math.exp(rets[i]); const t=slots[i]; const rg=Math.abs(rets[i]); out[t]={date:DATES[t],open:prev,high:Math.max(prev,close)*Math.exp(0.5*rg),low:Math.min(prev,close)*Math.exp(-0.5*rg),close}; } return out; }

const CFG={ period:20, thr:100, mode:"trend" as const, side:"longflat" as const, volTarget:0, volWin:30 };
const realDrift=mean(SYMBOLS.map(s=>mean(logret[s].filter((v):v is number=>v!=null))));

function surLogretFromBars(sb:(Bar|null)[]):(number|null)[]{ const r:(number|null)[]=Array<number|null>(T).fill(null); let p=-1; for(let t=0;t<T;t++){ if(sb[t]){ if(p>=0&&sb[p]) r[t]=Math.log(sb[t]!.close/sb[p]!.close); p=t; } } return r; }
function alwaysLong(surBars:Record<string,(Bar|null)[]>):Record<string,(number|null)[]>{ const o:Record<string,(number|null)[]>={}; for(const s of SYMBOLS){ const a:(number|null)[]=Array<number|null>(T).fill(null); let started=false; for(let t=0;t<T;t++){ if(surBars[s][t]) started=true; a[t]=started?1:0;} o[s]=a; } return o; }

const N=60;
let phCci=0,phLong=0,phDrift=0, blCci=0,blLong=0,blDrift=0;
for(let i=0;i<N;i++){
  // PHASE surrogate
  { const surBars:Record<string,(Bar|null)[]>={}; for(const s of SYMBOLS){ const rng=mkRng(3000+i*7919+s.charCodeAt(0)*131+s.charCodeAt(1)*17); const vi:number[]=[]; for(let t=1;t<T;t++) if(logret[s][t]!=null) vi.push(t); if(vi.length<50){ surBars[s]=Array<Bar|null>(T).fill(null); continue;} const rets=vi.map(t=>logret[s][t]!); const sr=phaseRand(rets,rng); const start=barAt[s][vi[0]-1]?.close??barAt[s][vi[0]]!.close; surBars[s]=barsFromReturns(start,sr,vi); }
    const surLr:Record<string,(number|null)[]>={}; const cciSig:Record<string,(number|null)[]>={}; for(const s of SYMBOLS){ surLr[s]=surLogretFromBars(surBars[s]); cciSig[s]=cciSignal(cciSeries(surBars[s],CFG.period),CFG.thr,CFG.mode,CFG.side); }
    phCci+=annualize(summ(book(cciSig,surLr,CFG.volTarget,CFG.volWin))); phLong+=annualize(summ(book(alwaysLong(surBars),surLr,CFG.volTarget,CFG.volWin)));
    phDrift+=mean(SYMBOLS.map(s=>mean(surLr[s].filter((v):v is number=>v!=null)))); }
  // BLOCK surrogate
  { const surBars:Record<string,(Bar|null)[]>={}; for(const s of SYMBOLS){ const rng=mkRng(5000+i*9973+s.charCodeAt(0)*131+s.charCodeAt(1)*17); const vi:number[]=[]; for(let t=1;t<T;t++) if(logret[s][t]!=null) vi.push(t); if(vi.length<50){ surBars[s]=Array<Bar|null>(T).fill(null); continue;} const geom=vi.map(t=>{ const b=barAt[s][t]!; return { r:logret[s][t]!, hi:Math.log(b.high/b.close), lo:Math.log(b.low/b.close), op:Math.log(b.open/b.close) }; }); const sampled=stationaryBootstrap(geom.length,geom.length,20,rng); const start=barAt[s][vi[0]-1]?.close??barAt[s][vi[0]]!.close; const out:(Bar|null)[]=Array<Bar|null>(T).fill(null); let close=start; for(let k=0;k<vi.length;k++){ const t=vi[k]; const g=geom[sampled[k]]; close=close*Math.exp(g.r); const c=close; out[t]={date:DATES[t],open:Math.max(1e-9,c*Math.exp(g.op)),high:Math.max(c*Math.exp(g.hi),c),low:Math.min(c*Math.exp(g.lo),c),close:c}; } surBars[s]=out; }
    const surLr:Record<string,(number|null)[]>={}; const cciSig:Record<string,(number|null)[]>={}; for(const s of SYMBOLS){ surLr[s]=surLogretFromBars(surBars[s]); cciSig[s]=cciSignal(cciSeries(surBars[s],CFG.period),CFG.thr,CFG.mode,CFG.side); }
    blCci+=annualize(summ(book(cciSig,surLr,CFG.volTarget,CFG.volWin))); blLong+=annualize(summ(book(alwaysLong(surBars),surLr,CFG.volTarget,CFG.volWin)));
    blDrift+=mean(SYMBOLS.map(s=>mean(surLr[s].filter((v):v is number=>v!=null)))); }
}
console.log(`real avg drift: ${(realDrift*1e4).toFixed(2)} bps/day`);
console.log(`PHASE surrogate (N=${N}): drift=${(phDrift/N*1e4).toFixed(2)} bps  CCI-overlay Sharpe=${(phCci/N).toFixed(3)}  always-long Sharpe=${(phLong/N).toFixed(3)}`);
console.log(`BLOCK surrogate (N=${N}): drift=${(blDrift/N*1e4).toFixed(2)} bps  CCI-overlay Sharpe=${(blCci/N).toFixed(3)}  always-long Sharpe=${(blLong/N).toFixed(3)}`);
console.log(`observed CCI net Sharpe: 1.768`);
console.log(`\nFAIR-null test: CCI-overlay-on-surrogate vs always-long-on-surrogate. If close, surrogate`);
console.log(`Sharpe = preserved long-beta, null is FAIR, KILL sound. If CCI-overlay >> always-long on`);
console.log(`surrogate, the surrogate hands the overlay extra edge -> too-powerful -> false-KILL risk.`);
