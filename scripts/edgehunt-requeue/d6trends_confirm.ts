/* Confirm: tighten AR-placebo p (N=1000) on the best momentum config, and report holdout split
   detail + a PIT-honesty note (change-transform IC ~0). */
import { loadSeries, runPositions, mean, std, mkRng, type Series } from "./d6trends_harness.ts";

function fitAR1(z:number[]){const v=z.filter(x=>Number.isFinite(x));const mu=v.reduce((s,x)=>s+x,0)/v.length;const c=v.map(x=>x-mu);let num=0,den=0;for(let i=1;i<c.length;i++){num+=c[i]*c[i-1];den+=c[i-1]*c[i-1];}const phi=den>0?num/den:0;const sd=std(v);return{phi,sigma:Math.sqrt(Math.max(1e-9,sd*sd*(1-phi*phi))),mu};}
function gauss(rng:()=>number){let u=0,v=0;while(u===0)u=rng();while(v===0)v=rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
const ANN=Math.sqrt(365);
function annSh(a:number[]){const s=std(a);return s>1e-12?(mean(a)/s)*ANN:0;}

const S:Series=loadSeries(52);
const z=S.trendZ;
const k=2,dir=1; // best config: momentum, longonly, level
function rule(sig:number[]){const o=new Array(sig.length).fill(NaN);for(let t=0;t<sig.length;t++){const s=sig[t];if(!Number.isFinite(s)){o[t]=NaN;continue;}o[t]=Math.max(0,Math.min(1,dir*Math.tanh(k*s)));}return o;}

const T=S.price.length, startIdx=7, tradableEnd=T-1;
const span=tradableEnd-startIdx, splitIdx=startIdx+Math.floor(span*0.8);

const realPos=rule(z);
const realIS=runPositions(S,realPos,startIdx,splitIdx);
const realOOS=runPositions(S,realPos,splitIdx,tradableEnd);
const realShIS=annSh(realIS.dailyNet);
console.log(`real IS netSharpe=${realShIS.toFixed(3)} (n=${realIS.dailyNet.length})  OOS netSharpe=${annSh(realOOS.dailyNet).toFixed(3)} (n=${realOOS.dailyNet.length})`);

const ar=fitAR1(z);
const N=1000; const surr:number[]=[];
for(let i=0;i<N;i++){
  const rng=mkRng(13000+i*7919);
  const ss=new Array(z.length).fill(NaN);let cur=ar.mu,prev=NaN;
  for(let t=0;t<z.length;t++){if(!Number.isFinite(z[t])){ss[t]=NaN;prev=NaN;continue;}const ch=!Number.isFinite(prev)||z[t]!==prev;if(ch)cur=ar.mu+ar.phi*(cur-ar.mu)+ar.sigma*gauss(rng);ss[t]=cur;prev=z[t];}
  const r=runPositions(S,rule(ss),startIdx,splitIdx);
  surr.push(annSh(r.dailyNet));
}
surr.sort((a,b)=>a-b);
const above=surr.filter(s=>s>=realShIS).length;
console.log(`AR-placebo (N=${N}): p=${((above+1)/(N+1)).toFixed(4)}  placeboMean=${mean(surr).toFixed(3)}  placebo95=${surr[Math.floor(N*0.95)].toFixed(3)}  placeboMax=${surr[N-1].toFixed(3)}`);

// split holdout net-return sign by half
const oos=realOOS.dailyNet; const h=Math.floor(oos.length/2);
console.log(`OOS first-half Sharpe=${annSh(oos.slice(0,h)).toFixed(3)} second-half=${annSh(oos.slice(h)).toFixed(3)}`);
