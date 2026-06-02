/**
 * AUDIT spot-run: D2-M2 Amihud standalone. The standalone passes the surrogate
 * (cross-sectional shuffle p=0.002) AND has net Sharpe 1.23 > buyhold. It is
 * KILLED on boot-CI-lower>0 (reported -0.090). Verify:
 *  (a) reproduce the boot-CI lower (is it really <=0? the binding gate) using the
 *      committed blockBootstrapConfidenceInterval (mean->sharpe scale);
 *  (b) test the SUMMARY's regime/concentration claim: what fraction of cumulative
 *      P&L comes from the top-20 days, and the per-year Sharpe (is it a 2021-only
 *      premium that dies later?). This decides whether KILL is a sound
 *      robustness rejection vs a wrongly-killed real cross-sectional edge.
 */
import { readFileSync } from "node:fs";
import { rng } from "../edgehunt-D2/lib.ts";
import { blockBootstrapConfidenceInterval, summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";

const COST = 0.0004;
interface Panel { coins: string[]; dates: string[]; close: Record<string, (number | null)[]>; quoteVolume: Record<string, (number | null)[]>; }
const panel = JSON.parse(readFileSync("output/c1-rotation/volume-panel.json", "utf8")) as Panel;
const { coins, dates } = panel; const T = dates.length; const N = coins.length;
const ret: number[][] = coins.map(() => new Array(T).fill(NaN));
const illiqD: number[][] = coins.map(() => new Array(T).fill(NaN));
for (let ci = 0; ci < N; ci += 1) {
  const C = panel.close[coins[ci]]; const V = panel.quoteVolume[coins[ci]];
  for (let t = 1; t < T; t += 1) {
    const c0 = C[t - 1], c1 = C[t], v = V[t];
    if (c0 != null && c1 != null && c0 > 0 && v != null && v > 0) { const r = c1 / c0 - 1; ret[ci][t] = r; illiqD[ci][t] = Math.abs(r) / v; }
  }
}
function trailMean(arr: number[], t: number, w: number): number | null {
  let s = 0, n = 0; for (let k = Math.max(1, t - w); k < t; k += 1) if (Number.isFinite(arr[k])) { s += arr[k]; n += 1; }
  return n >= Math.max(5, Math.floor(w / 2)) ? s / n : null;
}
// best standalone config from amihud-results.json: w30_r5_f0.33
const w = 30, reb = 5, frac = 0.33;
const net: number[] = []; const days: string[] = [];
let curW = new Array(N).fill(0); let prevW = new Array(N).fill(0); let formDay = -1e9;
const start = Math.max(220, w + 5);
for (let t = start; t < T; t += 1) {
  if (t - formDay >= reb) {
    const rows: { ci: number; s: number }[] = [];
    for (let ci = 0; ci < N; ci += 1) { const s = trailMean(illiqD[ci], t, w); if (s != null && Number.isFinite(s)) rows.push({ ci, s }); }
    if (rows.length >= 8) {
      const idx = rows.map((r) => ({ ci: r.ci, s: r.s })).sort((a, b) => a.s - b.s);
      const k = Math.max(1, Math.floor(idx.length * frac));
      const low = idx.slice(0, k).map((x) => x.ci); const high = idx.slice(idx.length - k).map((x) => x.ci);
      const nw = new Array(N).fill(0); for (const ci of high) nw[ci] = 1 / high.length; for (const ci of low) nw[ci] = -1 / low.length;
      curW = nw; formDay = t;
    }
  }
  let pr = 0, tw = 0;
  for (let ci = 0; ci < N; ci += 1) { const wv = curW[ci]; if (wv !== 0 && Number.isFinite(ret[ci][t])) pr += wv * ret[ci][t]; tw += Math.abs(wv - prevW[ci]); }
  net.push(pr - tw * COST); days.push(dates[t]); prevW = curW.slice();
}
const st = summarizeReturnSeries(net);
const annS = st.sharpe * Math.sqrt(365);
console.log(`standalone w30_r5_f0.33: nDays=${net.length} netSharpe=${annS.toFixed(3)} meanBp=${(st.mean * 1e4).toFixed(2)}`);

// (a) boot CI lower (mean -> sharpe scale, exactly as runGauntlet does)
const boot = blockBootstrapConfidenceInterval(net, { statistic: "mean", iterations: 2000, confidenceLevel: 0.95, seed: "D2-M2 Amihud illiq L/S (long illiquid, h>=1)-boot" });
const bootLowerSharpe = st.stdDev > 1e-12 ? (boot.lower / st.stdDev) * Math.sqrt(365) : 0;
console.log(`boot-CI-lower (sharpe scale) = ${bootLowerSharpe.toFixed(4)}  (binding gate needs >0)`);

// (b) concentration: top-20 days share of total P&L; per-year Sharpe
const totalPnl = net.reduce((a, b) => a + b, 0);
const sortedAbs = [...net].map((x, i) => ({ x, i })).sort((a, b) => b.x - a.x);
const top20 = sortedAbs.slice(0, 20).reduce((a, b) => a + b.x, 0);
console.log(`top-20 winning days contribute ${(100 * top20 / totalPnl).toFixed(1)}% of total P&L (n=${net.length} days)`);
const byYear: Record<string, number[]> = {};
for (let i = 0; i < net.length; i += 1) { const y = days[i].slice(0, 4); (byYear[y] ||= []).push(net[i]); }
for (const y of Object.keys(byYear).sort()) {
  const s = summarizeReturnSeries(byYear[y]); console.log(`  ${y}: nDays=${byYear[y].length} annSharpe=${(s.sharpe * Math.sqrt(365)).toFixed(3)} meanBp=${(s.mean * 1e4).toFixed(2)}`);
}
