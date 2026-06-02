/**
 * D5-09 Puell diagnostic probe. GENUINELY hunt for an edge before judging:
 *  1) reconstruct Puell from SplyCur deltas * PriceUSD / 365d-MA (the $0 path).
 *  2) characterize the distribution + how often each buy/sell threshold fires (the empty-book risk).
 *  3) conditional next-day mean return by Puell regime (does low Puell actually precede gains?).
 *  4) build the Mayer price-only control (price/365d-MA(price)) and correlate with Puell — if they
 *     are near-identical, Puell carries no issuance information beyond price (the relabel thesis).
 *  5) a "Puell residual vs Mayer" feature: orthogonalize Puell against Mayer and test if the
 *     ISSUANCE component (halving steps + fee/hashprice drift) carries any independent timing edge.
 */
import { loadPanel, ema, sma } from "./harness.ts";

const LAG = 1;
function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function corr(a: number[], b: number[]) {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i]-mx)*(ys[i]-my); sxx += (xs[i]-mx)**2; syy += (ys[i]-my)**2; }
  return sxy / Math.sqrt(sxx*syy);
}

const P = loadPanel("btc");
const T = P.price.length;
console.log(`panel: ${P.dates[0]} -> ${P.dates[T-1]}  T=${T}`);

// --- Puell (as in run_d5) ---
const issNtv = P.supply.map((s, t) => t>0 && Number.isFinite(s) && Number.isFinite(P.supply[t-1]) ? Math.max(0, s-P.supply[t-1]) : NaN);
const issUSD = issNtv.map((v, t) => Number.isFinite(v) && P.price[t]>0 ? v*P.price[t] : NaN);
const issUSDsm = ema(issUSD, 7);
const ma365 = sma(issUSDsm, 365);
const puell = issUSDsm.map((v, t) => Number.isFinite(v) && Number.isFinite(ma365[t]) && ma365[t]>0 ? v/ma365[t] : NaN);

// --- Mayer multiple (price / 365d-MA(price)) ---
const pma365 = sma(P.price, 365);
const mayer = P.price.map((p, t) => Number.isFinite(pma365[t]) && pma365[t]>0 ? p/pma365[t] : NaN);

// distribution of Puell where finite
const pv = puell.filter(Number.isFinite).sort((a,b)=>a-b);
const q = (p: number) => pv[Math.floor(p*(pv.length-1))];
console.log(`\nPuell distribution (n=${pv.length}): min=${pv[0].toFixed(3)} p05=${q(0.05).toFixed(3)} p10=${q(0.10).toFixed(3)} p25=${q(0.25).toFixed(3)} median=${q(0.5).toFixed(3)} p75=${q(0.75).toFixed(3)} p90=${q(0.90).toFixed(3)} p95=${q(0.95).toFixed(3)} max=${pv[pv.length-1].toFixed(3)}`);

// how often each grid threshold fires
const puellL = lag(puell, LAG);
for (const b of [0.4, 0.5, 0.6, 0.8, 1.0]) {
  const n = puellL.filter(v => Number.isFinite(v) && v <= b).length;
  console.log(`  Puell<=${b}: ${n} days (${(100*n/pv.length).toFixed(1)}%)`);
}
for (const s of [2,3,4]) {
  const n = puellL.filter(v => Number.isFinite(v) && v >= s).length;
  console.log(`  Puell>=${s}: ${n} days (${(100*n/pv.length).toFixed(1)}%)`);
}

// conditional next-day mean log-return by Puell regime (using lagged Puell -> fwdRet)
function condRet(pred: (v:number)=>boolean) {
  const r: number[] = [];
  for (let t=0;t<T;t++) if (Number.isFinite(puellL[t]) && Number.isFinite(P.fwdRet[t]) && pred(puellL[t])) r.push(P.fwdRet[t]);
  return { n: r.length, mean: mean(r), annMean: mean(r)*365 };
}
const all = P.fwdRet.filter(Number.isFinite);
console.log(`\nUnconditional next-day mean log-ret = ${(mean(all)).toExponential(3)} (ann ${(mean(all)*365*100).toFixed(1)}%)`);
console.log("Conditional next-day mean by Puell decile bands (lagged):");
const bands: [string,(v:number)=>boolean][] = [
  ["<=0.4", v=>v<=0.4], ["<=0.5", v=>v<=0.5], ["<=0.6", v=>v<=0.6], ["<=0.8", v=>v<=0.8],
  ["<=1.0", v=>v<=1.0], [">=2", v=>v>=2], [">=3", v=>v>=3], [">=4", v=>v>=4],
];
for (const [lab,pred] of bands) { const c = condRet(pred); console.log(`  Puell ${lab}: n=${c.n} mean=${c.mean.toExponential(3)} ann=${(c.annMean*100).toFixed(1)}%`); }

// correlation Puell vs Mayer (level and rank-ish via log)
console.log(`\ncorr(Puell, Mayer) level = ${corr(puell, mayer).toFixed(4)}`);
const lpu = puell.map(v=>v>0?Math.log(v):NaN), lma = mayer.map(v=>v>0?Math.log(v):NaN);
console.log(`corr(log Puell, log Mayer) = ${corr(lpu, lma).toFixed(4)}`);

// Puell residual orthogonal to Mayer: regress log Puell ~ a + b log Mayer (full-sample diag only),
// residual = issuance-specific component (halving steps + hashprice). Does it lead returns?
const xs: number[]=[], ys:number[]=[], idx:number[]=[];
for (let t=0;t<T;t++) if (Number.isFinite(lpu[t]) && Number.isFinite(lma[t])) { xs.push(lma[t]); ys.push(lpu[t]); idx.push(t); }
const mx=mean(xs),my=mean(ys); let sxy=0,sxx=0; for(let i=0;i<xs.length;i++){sxy+=(xs[i]-mx)*(ys[i]-my);sxx+=(xs[i]-mx)**2;}
const beta=sxy/sxx, alpha=my-beta*mx;
const resid = new Array(T).fill(NaN);
for (let i=0;i<idx.length;i++) resid[idx[i]] = ys[i] - (alpha+beta*xs[i]);
const residL = lag(resid, LAG);
// sign-of-residual conditional return
const rPos:number[]=[], rNeg:number[]=[];
for (let t=0;t<T;t++) if (Number.isFinite(residL[t]) && Number.isFinite(P.fwdRet[t])) (residL[t]>0?rPos:rNeg).push(P.fwdRet[t]);
console.log(`\nPuell residual (issuance-specific, orthogonal to Mayer): R^2 of Mayer on Puell = ${(beta*beta*sxx/(ys.reduce((s,v)=>s+(v-my)**2,0))).toFixed(4)}`);
console.log(`  residual>0 (issuance-high vs price): n=${rPos.length} fwd mean=${mean(rPos).toExponential(3)} ann=${(mean(rPos)*365*100).toFixed(1)}%`);
console.log(`  residual<0 (issuance-low vs price):  n=${rNeg.length} fwd mean=${mean(rNeg).toExponential(3)} ann=${(mean(rNeg)*365*100).toFixed(1)}%`);
