/**
 * Resolve the IC<0 vs book<0 puzzle. For the 1-week-lookback / 3-day-hold residual signal,
 * sort the cross-section into quintiles by signal (Q1=biggest loser ... Q5=biggest winner) and
 * report the mean FORWARD residual return of each quintile. A genuine reversal => Q1 (losers)
 * forward > Q5 (winners) forward, monotone decreasing. This tells us WHERE (if anywhere) the
 * tradable reversal sits, and whether the long-loser/short-winner tail book is the right harvest.
 */
import { loadDailyPanel, rebalanceDays, mean, std } from "./lib_strev.ts";
const panel = loadDailyPanel();
const btc = panel.btcIdx;
function olsBeta(y:number[],x:number[]){const n=y.length;if(n<5)return 0;let sx=0,sy=0;for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];}const mx=sx/n,my=sy/n;let c=0,v=0;for(let i=0;i<n;i++){const dx=x[i]-mx;c+=dx*(y[i]-my);v+=dx*dx;}return v>1e-12?c/v:0;}

const HOLD=3, LB=7, BW=60, WARMUP=200;
const rebal = rebalanceDays(panel, HOLD, WARMUP);
const NQ=5;
const qfwd: number[][] = Array.from({length:NQ},()=>[]);
const spread: number[] = []; // Q1(loser) - Q5(winner) forward residual
for (const t of rebal) {
  const sigLo=t-LB+1, sigHi=t, betaLo=t-BW+1, fwdLo=t+1, fwdHi=t+HOLD;
  if (sigLo<1||betaLo<1||fwdHi>panel.dates.length-1) continue;
  const btcWin:number[]=[]; for(let d=betaLo;d<=t;d++) btcWin.push(panel.logret[d][btc]);
  const rec: {sig:number;fwd:number}[]=[];
  for(let a=0;a<panel.assets.length;a++){ if(a===btc)continue;
    let ok=true; for(let d=Math.min(sigLo,betaLo);d<=fwdHi;d++){if(!panel.present[d][a]||!panel.present[d][btc]){ok=false;break;}}
    if(!ok)continue;
    const yWin:number[]=[]; for(let d=betaLo;d<=t;d++) yWin.push(panel.logret[d][a]);
    const beta=olsBeta(yWin,btcWin);
    let cs=0; for(let d=sigLo;d<=sigHi;d++) cs+=panel.logret[d][a]-beta*panel.logret[d][btc];
    let cf=0; for(let d=fwdLo;d<=fwdHi;d++) cf+=panel.logret[d][a]-beta*panel.logret[d][btc];
    rec.push({sig:cs,fwd:cf});
  }
  if(rec.length<10)continue;
  rec.sort((p,q)=>p.sig-q.sig); // ascending: index 0 = biggest loser
  const m=rec.length;
  for(let qi=0;qi<NQ;qi++){
    const lo=Math.floor(qi*m/NQ), hi=Math.floor((qi+1)*m/NQ);
    const slice=rec.slice(lo,hi);
    qfwd[qi].push(mean(slice.map(r=>r.fwd)));
  }
  spread.push(qfwd[0][qfwd[0].length-1]-qfwd[NQ-1][qfwd[NQ-1].length-1]);
}
console.log(`1w lookback / 3d hold, ${spread.length} rebalances. Mean forward residual return by signal quintile:`);
console.log(`(Q1=biggest LOSER ... Q5=biggest WINNER). Reversal => Q1>...>Q5, spread Q1-Q5 > 0`);
for(let qi=0;qi<NQ;qi++){
  const m=mean(qfwd[qi]), s=std(qfwd[qi]), n=qfwd[qi].length, t=s>0?m/(s/Math.sqrt(n)):0;
  console.log(`  Q${qi+1}: meanFwdResid=${(m*1e4).toFixed(2)}bps  t=${t.toFixed(2)}`);
}
const ms=mean(spread), ss=std(spread), ns=spread.length, ts=ss>0?ms/(ss/Math.sqrt(ns)):0;
console.log(`\n  Q1-Q5 spread (long-loser/short-winner GROSS, per 3d): mean=${(ms*1e4).toFixed(2)}bps t=${ts.toFixed(2)} n=${ns}`);
console.log(`  annualized spread Sharpe (gross): ${(Math.sqrt(365/HOLD)*ms/ss).toFixed(3)}`);
console.log(`  Round-trip taker cost for this 2-sided book ~ ${(2*2*4).toFixed(0)}bps per rebalance vs ${(ms*1e4).toFixed(2)}bps gross edge`);
