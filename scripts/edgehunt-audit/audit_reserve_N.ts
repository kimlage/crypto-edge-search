/**
 * AUDIT: D5-08 reserve honest-N sensitivity. The headline 0.994 grid-best is selected from a
 * 54-config grid, but strengthening probed V1/V2/V3 (3 x 54 = 162 more configs) on the SAME
 * exchange-flow hypothesis. Honest family N for "exchange flow edge" is arguably ~216. Check that
 * the DSR/haircut verdict (PROMISING, not SURVIVE/overstated) is robust to the larger N.
 */
import { computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation.ts";
import { loadPanel, runPositions, ema, rollingZ, sharpeDaily, annSharpe, type Panel } from "../edgehunt-D5/harness.ts";

const LAG = 1;
const lag = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
function netZ(P: Panel, smooth: number, zwin: number): number[] {
  const fin = lag(P.flowInNtv, LAG), fout = lag(P.flowOutNtv, LAG);
  const net = P.price.map((_, t) => (Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN));
  return rollingZ(ema(net, smooth), zwin);
}
const P = loadPanel("btc");
const T = P.price.length;
const startIdx = 700, splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8);
const z = netZ(P, 7, 365);
const p = new Array(T).fill(NaN);
for (let t = 0; t < T; t++) { if (!Number.isFinite(z[t])) continue; if (z[t] <= -0.5) p[t] = 1; else if (z[t] >= 0.5) p[t] = 0; else p[t] = 0; }
const r = runPositions(P, p, startIdx, splitIdx);
console.log("netSh", annSharpe(sharpeDaily(r.dailyNet)).toFixed(3));
for (const N of [1, 54, 108, 162, 216]) {
  const d = computeDeflatedSharpeRatio(r.dailyNet, { trialCount: N });
  console.log(`DSR @N=${N} = ${d.deflatedProbability.toFixed(4)} (PASS>0.95: ${d.deflatedProbability > 0.95})`);
}
