/**
 * AUDIT: quantify gross leverage of the D1-03 Supertrend best config (volTarget=0.4, VOL_CAP=3) and
 * estimate the financing/borrow drag that the batch script does NOT charge. THE STANDARD requires
 * financing on the FULL levered notional. If the book runs net leverage >1 on average, an unmodeled
 * financing charge could move the (already-failing) numbers. Since the verdict is KILL, a missing
 * financing charge can only make it "more KILL" -> but we quantify to confirm it is not material to
 * any conclusion (and would not have rescued a borderline pass).
 *
 * Book weight convention: per-coin w in [0, VOL_CAP], book exposure = sum(w)/8. We report the average
 * book gross exposure (sum|w|/8) for the best config -> the notional on which financing would accrue.
 */
import fs from "node:fs";
const ROOT=".";
const SYMBOLS=["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX"];
interface Bar{date:string;open:number;high:number;low:number;close:number;}
function load(s:string){ return (JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${s}_daily_ohlc.json`,"utf8")) as Bar[]).filter(b=>b.open>0&&b.high>0&&b.low>0&&b.close>0); }
const perSym:Record<string,Bar[]>={}; for(const s of SYMBOLS) perSym[s]=load(s);
const DATES=Array.from(new Set(SYMBOLS.flatMap(s=>perSym[s].map(b=>b.date)))).sort();
const T=DATES.length; const di=new Map(DATES.map((d,i)=>[d,i]));
const barAt:Record<string,(Bar|null)[]>={}; for(const s of SYMBOLS){ const a:(Bar|null)[]=Array<Bar|null>(T).fill(null); for(const b of perSym[s]){ const i=di.get(b.date); if(i!=null) a[i]=b;} barAt[s]=a; }
const logret:Record<string,(number|null)[]>={}; for(const s of SYMBOLS){ const r:(number|null)[]=Array<number|null>(T).fill(null); for(let t=1;t<T;t++){ const a=barAt[s][t-1],b=barAt[s][t]; if(a&&b) r[t]=Math.log(b.close/a.close);} logret[s]=r; }
function mean(a:number[]){ return a.reduce((x,y)=>x+y,0)/Math.max(1,a.length); }
function ema(p:number,x:number,pr:number){ const k=2/(pr+1); return p+k*(x-p); }
function st(bars:(Bar|null)[],atrP:number,mult:number,emaC:number):(number|null)[]{ const n=bars.length; const sig:(number|null)[]=Array<number|null>(n).fill(null); let atr=NaN,pc=NaN,fu=NaN,fl=NaN,up=true,ev=NaN,warm=0;
  for(let t=0;t<n;t++){ const b=bars[t]; if(!b) continue; let tr; if(!Number.isFinite(pc)) tr=b.high-b.low; else tr=Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc)); if(!Number.isFinite(atr)) atr=tr; else atr=(atr*(atrP-1)+tr)/atrP;
    if(emaC>0){ if(!Number.isFinite(ev)) ev=b.close; else ev=ema(ev,b.close,emaC);} const hl2=(b.high+b.low)/2; const bu=hl2+mult*atr,bl=hl2-mult*atr;
    if(!Number.isFinite(fu)){ fu=bu; fl=bl;} else { fu=bu<fu||pc>fu?bu:fu; fl=bl>fl||pc<fl?bl:fl;} if(up){ if(b.close<fl) up=false;} else { if(b.close>fu) up=true;} warm++; pc=b.close;
    if(warm<=atrP+1){ sig[t]=0; continue;} let s=up?1:0; if(emaC>0&&Number.isFinite(ev)){ if(s>0&&b.close<ev) s=0;} sig[t]=s; } return sig; }
function tvol(s:string,t:number,win:number){ const r=logret[s]; const v:number[]=[]; for(let k=Math.max(1,t-win);k<t;k++){ const x=r[k]; if(x!=null) v.push(x);} if(v.length<10) return NaN; const m=mean(v); const vv=v.reduce((a,x)=>a+(x-m)**2,0)/(v.length-1); return Math.sqrt(Math.max(0,vv)); }

const VOL_CAP=3; const volTarget=0.4, volWin=30, atrP=7,mult=2,emaC=200;
const dtv=volTarget/Math.sqrt(365);
const sig:Record<string,(number|null)[]>={}; for(const s of SYMBOLS) sig[s]=st(barAt[s],atrP,mult,emaC);
let bookExp:number[]=[]; let maxW=0;
for(let t=1;t<T;t++){ let g=0; for(const s of SYMBOLS){ const sg=sig[s][t-1]; let w=0; if(sg!=null&&sg!==0){ const v=tvol(s,t,volWin); if(Number.isFinite(v)&&v>1e-9) w=sg*Math.min(VOL_CAP,dtv/v);} g+=Math.abs(w); maxW=Math.max(maxW,w);} bookExp.push(g/SYMBOLS.length); }
const avgExp=mean(bookExp);
console.log(`Best Supertrend config (vt=0.4, cap=3):`);
console.log(`  avg book gross exposure (sum|w|/8): ${avgExp.toFixed(3)}  (1.0 = fully invested, >1 = levered)`);
console.log(`  max single-coin weight hit: ${maxW.toFixed(3)} (cap ${VOL_CAP})`);
console.log(`  fraction of days book exposure > 1.0: ${(bookExp.filter(x=>x>1).length/bookExp.length*100).toFixed(1)}%`);
// financing drag if avg leverage L>1: borrow (L-1) of notional at rate rf. Estimate at rf=5%/yr.
const rf=0.05; const dailyDrag = Math.max(0,avgExp-1)*rf/365;
console.log(`  if avg leverage ${avgExp.toFixed(2)}>1, financing on (L-1) @5%/yr = ${(dailyDrag*1e4).toFixed(3)} bps/day drag`);
console.log(`  report mean daily net = ${(0.0006946789735738358*1e4).toFixed(2)} bps/day; financing drag is ${dailyDrag>0?(dailyDrag/0.0006946789735738358*100).toFixed(1)+'% of it':'0 (book is NET DE-levered, no borrow)'}`);
console.log(`\nNOTE: a positive financing charge can only LOWER net Sharpe -> verdict already KILL, so omission`);
console.log(`does not change the verdict (and would not have rescued a fail). Direction is conservative.`);
