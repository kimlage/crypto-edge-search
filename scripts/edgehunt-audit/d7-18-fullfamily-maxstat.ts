// Audit: family-wise MAX-stat null over the FULL honest family the winner was selected from:
// 2 assets x {raw,residual} x 4 thresholds x 4 horizons x 2 lags = 128 cells, MAX across ALL.
// The batch robustness only re-mined raw/32 per asset. Here we re-mine the full 128 and compare
// the real grid-max (0.89 = residual BTC) to the placebo grid-max distribution.
import { readFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";
const ROOT=".";
const toMs=(d:string)=>Date.parse(`${d}T00:00:00Z`); const COST=0.0006; const TRAIL=30; const ANN=Math.sqrt(365);
interface Bar{date:string;close:number} interface SupRow{date:string;total:number}
const supByDate=new Map<string,number>();
for(const r of (JSON.parse(readFileSync(`${ROOT}/output/edgehunt-D5/stablecoins_total.json`,"utf8")).data as SupRow[])) if(Number.isFinite(r.total)&&r.total>0) supByDate.set(r.date,r.total);
const loadBars=(s:string)=>(JSON.parse(readFileSync(`${ROOT}/output/nf1/${s}_daily_ohlc.json`,"utf8")) as Bar[]).filter(b=>Number.isFinite(b.close)&&b.close>0).sort((a,b)=>toMs(a.date)-toMs(b.date));
function mb(seed:number){let a=seed>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function build(bars:Bar[]){const date:string[]=[];const close:number[]=[];let last:number|null=null;
 for(const b of bars){const s=supByDate.get(b.date);if(s!==undefined)last=s;if(last===null)continue;date.push(b.date);close.push(b.close);}
 const sup:number[]=[];last=null;for(const d of date){const s=supByDate.get(d);if(s!==undefined)last=s;sup.push(last as number);}
 const n=date.length;const ret=new Array(n).fill(0);const supChg=new Array(n).fill(0);
 for(let i=1;i<n;i++){ret[i]=Math.log(close[i]/close[i-1]);supChg[i]=Math.log(sup[i]/sup[i-1]);}
 const mintZ=new Array(n).fill(0);
 for(let i=TRAIL+1;i<n;i++){let m=0;for(let j=i-TRAIL;j<i;j++)m+=supChg[j];m/=TRAIL;let v=0;for(let j=i-TRAIL;j<i;j++)v+=(supChg[j]-m)**2;const sd=Math.sqrt(v/(TRAIL-1));mintZ[i]=sd>1e-12?(supChg[i]-m)/sd:0;}
 const trail:number[][]=new Array(n);for(let i=0;i<n;i++){const l:number[]=[];for(let L=1;L<=5;L++)l.push(i-L>=0?ret[i-L]:0);trail[i]=l;}
 return {ret,mintZ,trail,n};}
function residualize(y:number[],X:number[][]):number[]{const n=y.length;const k=X[0].length+1;const D=X.map(r=>[1,...r]);
 const XtX=Array.from({length:k},()=>new Array(k).fill(0));const Xty=new Array(k).fill(0);
 for(let i=0;i<n;i++){for(let a=0;a<k;a++){Xty[a]+=D[i][a]*y[i];for(let b=0;b<k;b++)XtX[a][b]+=D[i][a]*D[i][b];}}
 const A=XtX.map((r,i)=>[...r,Xty[i]]);for(let col=0;col<k;col++){let p=col;for(let r=col+1;r<k;r++)if(Math.abs(A[r][col])>Math.abs(A[p][col]))p=r;[A[col],A[p]]=[A[p],A[col]];const d=A[col][col];if(Math.abs(d)<1e-12)continue;for(let c=col;c<=k;c++)A[col][c]/=d;for(let r=0;r<k;r++){if(r===col)continue;const f=A[r][col];for(let c=col;c<=k;c++)A[r][c]-=f*A[col][c];}}
 const beta=A.map(r=>r[k]);const res=new Array(n);for(let i=0;i<n;i++){let pr=0;for(let a=0;a<k;a++)pr+=beta[a]*D[i][a];res[i]=y[i]-pr;}return res;}
function ruleNet(ret:number[],sig:boolean[],h:number,l:number):number[]{const n=ret.length;const want=new Array(n).fill(false);
 for(let i=0;i<n;i++){if(!sig[i])continue;const s=i+l;const e=Math.min(n-1,s+h-1);for(let k=s;k<=e;k++)if(k>=0)want[k]=true;}
 const net:number[]=[];let prev=0;for(let i=0;i<n;i++){const p=want[i]?1:0;const c=p!==prev?COST:0;net.push(p*ret[i]-c);prev=p;}return net;}
const TH=[1.5,2,2.5,3],HZ=[3,5,7,10],LG=[1,2];
function makeResidZ(p:any):number[]{const valid:number[]=[];for(let i=TRAIL+6;i<p.n;i++)valid.push(i);const y=valid.map(i=>p.mintZ[i]);const X=valid.map(i=>p.trail[i]);const rv=residualize(y,X);const rm=rv.reduce((a,b)=>a+b,0)/rv.length;const rsd=Math.sqrt(rv.reduce((a,b)=>a+(b-rm)**2,0)/(rv.length-1));const rz=new Array(p.n).fill(0);valid.forEach((i,k)=>{rz[i]=rsd>1e-12?(rv[k]-rm)/rsd:0;});return rz;}
// real grid-max across BOTH assets x {raw,residual}
function gridMaxAcrossAssets(panels:any[], zPick:(p:any,which:string)=>number[]):number{
 let best=-Infinity;for(const p of panels){for(const which of ["raw","residual"]){const z=zPick(p,which);for(const t of TH){const sig=z.map((v:number)=>v>=t);for(const h of HZ)for(const l of LG){const sh=summarizeReturnSeries(ruleNet(p.ret,sig,h,l)).sharpe;if(sh>best)best=sh;}}}}return best;}
const pB=build(loadBars("BTC")),pE=build(loadBars("ETH"));
pB.residZ=makeResidZ(pB); pE.residZ=makeResidZ(pE);
const zPick=(p:any,which:string)=>which==="raw"?p.mintZ:p.residZ;
const realMax=gridMaxAcrossAssets([pB,pE],zPick);
// placebo: shuffle each asset's mintZ AND recompute residual on shuffled (to mirror the full mining incl. residual path)
const rng=mb(13579); const N=2000; let ge=0; const maxes:number[]=[];
function shuf<T>(a:T[]):T[]{const x=a.slice();for(let i=x.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;}
for(let s=0;s<N;s++){
 const pBs={...pB,mintZ:shuf(pB.mintZ)}; pBs.residZ=makeResidZ(pBs);
 const pEs={...pE,mintZ:shuf(pE.mintZ)}; pEs.residZ=makeResidZ(pEs);
 const m=gridMaxAcrossAssets([pBs,pEs],zPick); maxes.push(m); if(m>=realMax)ge++;
}
maxes.sort((a,b)=>a-b);
console.log(JSON.stringify({
 realFullFamilyGridMaxDaily: realMax, realFullFamilyGridMaxAnnual: realMax*ANN,
 placeboMaxMeanAnnual:(maxes.reduce((a,b)=>a+b,0)/maxes.length)*ANN,
 placeboMaxP95Annual: maxes[Math.floor(0.95*maxes.length)]*ANN,
 fullFamilyWiseP:(ge+1)/(N+1),
 note:"MAX over 2 assets x {raw,residual} x 4x4x2 = 128 cells; placebo shuffles z and recomputes residual each trial"
},null,2));
