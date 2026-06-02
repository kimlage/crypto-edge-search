/**
 * AUDIT spot-check for D1-03 Supertrend surrogate null.
 *
 * Concern: is the vol-preserving block-bootstrap surrogate a FAIR null or a TOO-POWERFUL one?
 * The surrogate resamples each coin's log returns in blocks (preserving the sample mean / drift),
 * rebuilds the price path, recomputes Supertrend, and re-runs the book. If the surrogate preserves
 * the strong positive drift of crypto, then a long-flat trend overlay will mechanically score high
 * on the surrogate too -> surrogate mean ~ observed is the EXPECTED, CORRECT signature of "no timing
 * edge beyond long-beta". We verify:
 *   (1) surrogate paths preserve the per-coin drift (mean log-ret) -> confirms the null is "long-beta
 *       preserving", i.e. it tests for timing edge ABOVE static long exposure. That is the RIGHT null.
 *   (2) a pure always-long book on the SAME surrogate scores similarly -> the surrogate Sharpe is
 *       essentially the long-beta the overlay cannot escape, NOT some artifact injected by the
 *       surrogate construction.
 * If (1) and (2) hold, the KILL is sound (not a false-KILL from a too-powerful null).
 */
import fs from "node:fs";

const ROOT = ".";
const COST_PER_SIDE = 0.0004;
const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"];
interface Bar { date: string; open: number; high: number; low: number; close: number; }
function loadSymbol(sym: string): Bar[] {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`, "utf8")) as Bar[];
  return raw.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
}
const perSym: Record<string, Bar[]> = {};
for (const s of SYMBOLS) perSym[s] = loadSymbol(s);
const DATES = Array.from(new Set(SYMBOLS.flatMap((s) => perSym[s].map((b) => b.date)))).sort();
const T = DATES.length;
const dateIdx = new Map(DATES.map((d, i) => [d, i]));
const barAt: Record<string, (Bar | null)[]> = {};
for (const s of SYMBOLS) {
  const arr: (Bar | null)[] = Array<Bar | null>(T).fill(null);
  for (const b of perSym[s]) { const i = dateIdx.get(b.date); if (i != null) arr[i] = b; }
  barAt[s] = arr;
}
const logret: Record<string, (number | null)[]> = {};
for (const s of SYMBOLS) {
  const r: (number | null)[] = Array<number | null>(T).fill(null);
  for (let t = 1; t < T; t++) { const a = barAt[s][t-1], b = barAt[s][t]; if (a && b) r[t] = Math.log(b.close/a.close); }
  logret[s] = r;
}
function mean(a: number[]): number { return a.reduce((x,y)=>x+y,0)/Math.max(1,a.length); }

// (1) per-coin real drift
console.log("=== (1) Real per-coin daily mean log-return (drift) ===");
const realDrift: Record<string,number> = {};
for (const s of SYMBOLS) {
  const vals = logret[s].filter((v): v is number => v != null);
  realDrift[s] = mean(vals);
  console.log(`${s}: meanLogRet=${(realDrift[s]*1e4).toFixed(2)} bps/day  annualized=${(realDrift[s]*365*100).toFixed(1)}%/yr`);
}

// surrogate construction (copied from the batch script)
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t=s; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
}
function stationaryBootstrap(validIdx: number[], length: number, meanBlock: number, rng: ()=>number): number[] {
  const out: number[] = []; const m = validIdx.length; if (m===0) return out;
  let pos = Math.floor(rng()*m);
  for (let i=0;i<length;i++){ out.push(validIdx[pos]); if (rng()<1/meanBlock) pos=Math.floor(rng()*m); else pos=(pos+1)%m; }
  return out;
}
function surrogateBars(sym: string, rng: ()=>number): (Bar|null)[] {
  const arr = barAt[sym];
  const validIdx: number[] = []; for (let t=1;t<T;t++) if (logret[sym][t]!=null) validIdx.push(t);
  if (validIdx.length<50) return Array<Bar|null>(T).fill(null);
  const geom = validIdx.map((t)=>{ const b=arr[t]!; return { r: logret[sym][t]!, hi: Math.log(b.high/b.close), lo: Math.log(b.low/b.close), op: Math.log(b.open/b.close) }; });
  const firstBar = arr[validIdx[0]-1] ?? arr[validIdx[0]]!;
  const startPrice = firstBar.close;
  const sampled = stationaryBootstrap(geom.map((_,i)=>i), validIdx.length, 20, rng);
  const out: (Bar|null)[] = Array<Bar|null>(T).fill(null);
  let close = startPrice;
  for (let i=0;i<validIdx.length;i++){ const t=validIdx[i]; const g=geom[sampled[i]]; close=close*Math.exp(g.r); const c=close;
    out[t]={ date: DATES[t], open: Math.max(1e-9,c*Math.exp(g.op)), high: Math.max(c*Math.exp(g.hi),c,c*Math.exp(g.op)), low: Math.min(c*Math.exp(g.lo),c,c*Math.exp(g.op)), close: c }; }
  return out;
}

// (2) measure surrogate drift + always-long surrogate book Sharpe vs supertrend surrogate book Sharpe
console.log("\n=== (2) Surrogate drift preservation + always-long vs supertrend on SAME surrogate ===");
function annualize(d: number){ return d*Math.sqrt(365); }
function summarize(a: number[]){ const m=mean(a); const v=a.reduce((x,y)=>x+(y-m)**2,0)/Math.max(1,a.length-1); const sd=Math.sqrt(v); return { mean:m, sharpe: sd>1e-12? m/sd:0 }; }

// Supertrend causal signal (copied)
function ema(prev:number,x:number,p:number){ const k=2/(p+1); return prev+k*(x-prev); }
function supertrendSignal(bars:(Bar|null)[],atrPeriod:number,mult:number,side:"longflat"|"longshort",emaConfirm:number):(number|null)[]{
  const n=bars.length; const sig:(number|null)[]=Array<number|null>(n).fill(null);
  let atr=NaN,prevClose=NaN,finalUpper=NaN,finalLower=NaN,trendUp=true,emaVal=NaN,warm=0;
  for(let t=0;t<n;t++){ const b=bars[t]; if(!b) continue;
    let tr:number; if(!Number.isFinite(prevClose)) tr=b.high-b.low; else tr=Math.max(b.high-b.low,Math.abs(b.high-prevClose),Math.abs(b.low-prevClose));
    if(!Number.isFinite(atr)) atr=tr; else atr=(atr*(atrPeriod-1)+tr)/atrPeriod;
    if(emaConfirm>0){ if(!Number.isFinite(emaVal)) emaVal=b.close; else emaVal=ema(emaVal,b.close,emaConfirm); }
    const hl2=(b.high+b.low)/2; const basicUpper=hl2+mult*atr, basicLower=hl2-mult*atr;
    if(!Number.isFinite(finalUpper)){ finalUpper=basicUpper; finalLower=basicLower; }
    else { finalUpper = basicUpper<finalUpper||prevClose>finalUpper?basicUpper:finalUpper; finalLower=basicLower>finalLower||prevClose<finalLower?basicLower:finalLower; }
    if(trendUp){ if(b.close<finalLower) trendUp=false; } else { if(b.close>finalUpper) trendUp=true; }
    warm++; prevClose=b.close;
    if(warm<=atrPeriod+1){ sig[t]=0; continue; }
    let s=0; if(trendUp) s=1; else s= side==="longshort"?-1:0;
    if(emaConfirm>0&&Number.isFinite(emaVal)){ if(s>0&&b.close<emaVal) s=0; if(s<0&&b.close>emaVal) s=0; }
    sig[t]=s;
  }
  return sig;
}
const VOL_CAP=3;
function bookFromSig(sigs:Record<string,(number|null)[]>, lr:Record<string,(number|null)[]>, volTarget:number, volWin:number){
  const dailyNet:number[]=[]; const prevW:Record<string,number>={}; for(const s of SYMBOLS) prevW[s]=0;
  const dtv=volTarget/Math.sqrt(365);
  function tvol(s:string,t:number){ const r=lr[s]; const vals:number[]=[]; for(let k=Math.max(1,t-volWin);k<t;k++){ const v=r[k]; if(v!=null) vals.push(v);} if(vals.length<10) return NaN; const m=mean(vals); const v=vals.reduce((a,x)=>a+(x-m)**2,0)/(vals.length-1); return Math.sqrt(Math.max(0,v)); }
  for(let t=1;t<T;t++){ let gross=0,turn=0; const newW:Record<string,number>={};
    for(const s of SYMBOLS){ const sig=sigs[s][t-1]; const r=lr[s][t]; let w=0;
      if(sig!=null&&sig!==0){ if(volTarget>0){ const v=tvol(s,t); if(Number.isFinite(v)&&v>1e-9) w=sig*Math.min(VOL_CAP,dtv/v);} else w=sig; }
      newW[s]=w; turn+=Math.abs(w-(prevW[s]??0)); if(r!=null&&w!==0) gross+=w*(Math.exp(r)-1); }
    const denom=SYMBOLS.length; dailyNet.push(gross/denom - (turn/denom)*COST_PER_SIDE);
    for(const s of SYMBOLS) prevW[s]=newW[s];
  }
  return dailyNet;
}
// best supertrend cfg from report
const CFG = { atrPeriod:7, mult:2, side:"longflat" as const, volTarget:0.4, emaConfirm:200, volWin:30 };

const N=80; // smaller for speed; enough to characterize the distribution
const surrSt:number[]=[]; const surrLong:number[]=[]; const surrDrift:number[]=[];
for(let i=0;i<N;i++){
  const surBars:Record<string,(Bar|null)[]>={}; const surLr:Record<string,(number|null)[]>={};
  let driftAcc:number[]=[];
  for(const s of SYMBOLS){ const rng=mkRng(7000+i*9973+s.charCodeAt(0)*131+s.charCodeAt(1)*17); const sb=surrogateBars(s,rng); surBars[s]=sb;
    const r:(number|null)[]=Array<number|null>(T).fill(null); let p=-1; for(let t=0;t<T;t++){ if(sb[t]){ if(p>=0&&sb[p]) r[t]=Math.log(sb[t]!.close/sb[p]!.close); p=t; } } surLr[s]=r;
    const vv=r.filter((v):v is number=>v!=null); driftAcc.push(mean(vv));
  }
  surrDrift.push(mean(driftAcc));
  // supertrend book
  const stSig:Record<string,(number|null)[]>={}; for(const s of SYMBOLS) stSig[s]=supertrendSignal(surBars[s],CFG.atrPeriod,CFG.mult,CFG.side,CFG.emaConfirm);
  surrSt.push(annualize(summarize(bookFromSig(stSig,surLr,CFG.volTarget,CFG.volWin)).sharpe));
  // always-long book (same vol target) on the SAME surrogate
  const longSig:Record<string,(number|null)[]>={}; for(const s of SYMBOLS){ const a:(number|null)[]=Array<number|null>(T).fill(null); let started=false; for(let t=0;t<T;t++){ if(surBars[s][t]) started=true; a[t]=started?1:0; } longSig[s]=a; }
  surrLong.push(annualize(summarize(bookFromSig(longSig,surLr,CFG.volTarget,CFG.volWin)).sharpe));
}
console.log(`real book drift (avg per-coin meanLogRet): ${(mean(Object.values(realDrift))*1e4).toFixed(2)} bps/day`);
console.log(`surrogate book drift (avg): ${(mean(surrDrift)*1e4).toFixed(2)} bps/day  -> drift PRESERVED: ${Math.abs(mean(surrDrift)-mean(Object.values(realDrift)))<3e-4}`);
console.log(`supertrend-on-surrogate mean Sharpe: ${mean(surrSt).toFixed(3)}`);
console.log(`always-long-on-surrogate mean Sharpe: ${mean(surrLong).toFixed(3)}`);
console.log(`observed supertrend net Sharpe (report): 1.645`);
console.log(`\nINTERPRETATION: if supertrend-on-surrogate ~ always-long-on-surrogate ~ observed, the`);
console.log(`surrogate Sharpe IS the long-beta the overlay cannot escape -> null is FAIR, KILL sound.`);
