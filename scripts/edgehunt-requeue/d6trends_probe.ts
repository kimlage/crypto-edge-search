/* Direct lead-lag probe: does lagged attention (level / change / z) predict forward BTC returns?
   Reports IC (corr) at multiple forward horizons, plus quintile forward-return spreads. */
import { loadSeries } from "./d6trends_harness.ts";

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i]-ma)*(b[i]-mb); da += (a[i]-ma)**2; db += (b[i]-mb)**2; }
  return num / Math.sqrt(da*db);
}
function fwdLogRet(price: number[], t: number, h: number): number {
  if (t + h >= price.length) return NaN;
  return Math.log(price[t+h]/price[t]);
}

const S = loadSeries(52);
const z = S.trendZ;
const price = S.price;
// also attention 1-week change (z[t]-z[t-7]) and level
const horizons = [1, 5, 10, 21, 42];
console.log("=== IC of strictly-lagged attention-z vs forward H-day log returns ===");
for (const h of horizons) {
  const xs: number[] = [], ys: number[] = [];
  for (let t = 200; t < price.length; t++) {
    const fr = fwdLogRet(price, t, h);
    if (Number.isFinite(z[t]) && Number.isFinite(fr)) { xs.push(z[t]); ys.push(fr); }
  }
  console.log(`  H=${h}d  n=${xs.length}  IC(level z)=${corr(xs,ys).toFixed(4)}`);
}
// change in z
console.log("=== IC of attention z 1w-CHANGE vs forward returns ===");
for (const h of horizons) {
  const xs: number[] = [], ys: number[] = [];
  for (let t = 200; t < price.length; t++) {
    const dz = z[t] - z[t-7];
    const fr = fwdLogRet(price, t, h);
    if (Number.isFinite(dz) && Number.isFinite(fr)) { xs.push(dz); ys.push(fr); }
  }
  console.log(`  H=${h}d  n=${xs.length}  IC(dz)=${corr(xs,ys).toFixed(4)}`);
}
// quintile spread on level z, H=21
console.log("=== quintile forward-21d mean log-ret by attention-z (level) ===");
{
  const rows: {z:number;fr:number}[]=[];
  for (let t = 200; t < price.length; t++) {
    const fr = fwdLogRet(price, t, 21);
    if (Number.isFinite(z[t]) && Number.isFinite(fr)) rows.push({z:z[t],fr});
  }
  rows.sort((a,b)=>a.z-b.z);
  const q = Math.floor(rows.length/5);
  for (let i=0;i<5;i++){
    const slice = rows.slice(i*q, i===4?rows.length:(i+1)*q);
    const m = slice.reduce((s,r)=>s+r.fr,0)/slice.length;
    console.log(`  Q${i+1} (low->high attention) n=${slice.length} mean21dRet=${(m*100).toFixed(2)}% meanZ=${(slice.reduce((s,r)=>s+r.z,0)/slice.length).toFixed(2)}`);
  }
}
