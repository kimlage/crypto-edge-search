// Diagnose the ETH non-generalization: is the signal flat/inverted/noisy? Check correlation of
// netflow-Z with next-day return on BTC vs ETH, and B&H sharpe per window for context.
import { loadPanel, runPositions, ema, rollingZ, sharpeDaily, annSharpe, mean, std } from "../edgehunt-D5/harness.ts";
const LAG=1;
const lag=(x:number[],k:number)=>{const o=new Array(x.length).fill(NaN);for(let i=k;i<x.length;i++)o[i]=x[i-k];return o;};
function netZ(P:any,s:number,zw:number){const fin=lag(P.flowInNtv,LAG),fout=lag(P.flowOutNtv,LAG);const net=P.price.map((_:any,t:number)=>Number.isFinite(fin[t])&&Number.isFinite(fout[t])?fin[t]-fout[t]:NaN);return rollingZ(ema(net,s),zw);}
function corr(a:number[],b:number[]){const x:number[]=[],y:number[]=[];for(let i=0;i<a.length;i++)if(Number.isFinite(a[i])&&Number.isFinite(b[i])){x.push(a[i]);y.push(b[i]);}const mx=mean(x),my=mean(y);let n=0,d1=0,d2=0;for(let i=0;i<x.length;i++){n+=(x[i]-mx)*(y[i]-my);d1+=(x[i]-mx)**2;d2+=(y[i]-my)**2;}return n/Math.sqrt(d1*d2);}
for(const a of ["btc","eth"] as const){
  const P=loadPanel(a);const T=P.price.length;const start=700,split=start+Math.floor((T-1-start)*0.8);
  const z=netZ(P,14,365);
  // IC: corr(-z, fwdRet) — mechanism says negative z (outflow) -> positive next-day return, so -z should correlate +
  const negz:number[]=[],fr:number[]=[];
  for(let t=start;t<T-1;t++){if(Number.isFinite(z[t])&&Number.isFinite(P.fwdRet[t])){negz.push(-z[t]);fr.push(P.fwdRet[t]);}}
  const ic=corr(negz,fr);
  // B&H sharpe in-sample vs forward
  const bhIn=annSharpe(sharpeDaily(runPositions(P,new Array(T).fill(1),start,split).dailyNet));
  const bhFwd=annSharpe(sharpeDaily(runPositions(P,new Array(T).fill(1),split,T-1).dailyNet));
  console.log(`${a}: IC(-z, nextRet)=${ic.toFixed(4)} over ${negz.length} days | B&H Sharpe inSample=${bhIn.toFixed(3)} forward=${bhFwd.toFixed(3)}`);
}
