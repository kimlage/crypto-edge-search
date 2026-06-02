/**
 * D5-08 DEEPEN — reconcile the weak full-sample linear IC (t=1.37) with the strong band Sharpe.
 * The bet is NOT a linear IC bet — it is a TAIL-BAND bet (long only when netflow-Z <= -1, ~15% of
 * days). So the honest predictive-strength test is the conditional mean next-day return on ON days
 * vs OFF days, and its t-stat / bootstrap, plus the same split recent-vs-early. This tells us whether
 * the paper-forward 1.19 Sharpe is a genuine tail effect or regime luck.
 */
import { loadPanel, ema, rollingZ, mean, std, mkRng, type Panel } from "../edgehunt-D5/harness.ts";
import fs from "node:fs";
const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-deepen`;
const LAG = 1;
const PREREG = { smooth: 14, zwin: 365, thr: 1.0 };
const lagArr = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
function netZ(P: Panel, s: number, zw: number) {
  const fin = lagArr(P.flowInNtv, LAG), fout = lagArr(P.flowOutNtv, LAG);
  const net = P.price.map((_, t) => Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN);
  return rollingZ(ema(net, s), zw);
}
// block-bootstrap t-style p for "mean(on) > mean(off)" difference (autocorr-honest)
function blockMeanCI(x: number[], seed: number, B = 4000, bl = 20) {
  const n = x.length, means: number[] = [];
  for (let b = 0; b < B; b++) {
    const rng = mkRng(seed + b * 7919); let s = 0, c = 0;
    while (c < n) { const st = Math.floor(rng() * n); for (let k = 0; k < bl && c < n; k++, c++) s += x[(st + k) % n]; }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(B * 0.025)], hi: means[Math.floor(B * 0.975)], mean: mean(x) };
}

function analyze(asset: "btc" | "eth") {
  const P = loadPanel(asset); const T = P.price.length, start = 700;
  const z = netZ(P, PREREG.smooth, PREREG.zwin);
  const on: number[] = [], off: number[] = []; const onDates: string[] = [];
  for (let t = start; t < T - 1; t++) {
    if (!Number.isFinite(z[t]) || !Number.isFinite(P.fwdRet[t])) continue;
    if (z[t] <= -PREREG.thr) { on.push(P.fwdRet[t]); onDates.push(P.dates[t]); } else off.push(P.fwdRet[t]);
  }
  const onCI = blockMeanCI(on, asset === "btc" ? 11 : 22);
  // recent (>=2021) vs early (<2021) ON-day mean
  const onRecent: number[] = [], onEarly: number[] = [];
  for (let t = start; t < T - 1; t++) {
    if (!Number.isFinite(z[t]) || !Number.isFinite(P.fwdRet[t]) || z[t] > -PREREG.thr) continue;
    (Number(P.dates[t].slice(0, 4)) >= 2021 ? onRecent : onEarly).push(P.fwdRet[t]);
  }
  // unconditional mean next-day for reference
  const uncond: number[] = [];
  for (let t = start; t < T - 1; t++) if (Number.isFinite(P.fwdRet[t])) uncond.push(P.fwdRet[t]);
  return {
    asset, nOn: on.length, nOff: off.length,
    meanOn: mean(on), meanOff: mean(off), meanUncond: mean(uncond),
    onMinusOff: mean(on) - mean(off), onMinusUncond: mean(on) - mean(uncond),
    onCI95: [onCI.lo, onCI.hi], on_ci_excludes_zero: onCI.lo > 0,
    on_ci_excludes_uncond: onCI.lo > mean(uncond),
    meanOnEarly: mean(onEarly), nOnEarly: onEarly.length, meanOnRecent: mean(onRecent), nOnRecent: onRecent.length,
  };
}
const btc = analyze("btc"), eth = analyze("eth");
const out = { btc, eth };
fs.writeFileSync(`${OUT}/ic_decompose_result.json`, JSON.stringify(out, null, 2));
console.log("\n=== IC DECOMPOSITION — tail-band conditional mean (the actual bet), not linear IC ===");
for (const s of [btc, eth]) {
  console.log(`  ${s.asset.toUpperCase()}: ON days=${s.nOn} meanON=${(s.meanOn * 100).toFixed(3)}%/d meanOFF=${(s.meanOff * 100).toFixed(3)}% uncond=${(s.meanUncond * 100).toFixed(3)}%`);
  console.log(`     ON-uncond edge=${((s.onMinusUncond) * 100).toFixed(3)}%/d  ON-mean CI95=[${(s.onCI95[0] * 100).toFixed(3)}%,${(s.onCI95[1] * 100).toFixed(3)}%] excl0=${s.on_ci_excludes_zero} exclUncond=${s.on_ci_excludes_uncond}`);
  console.log(`     early(<2021) meanON=${(s.meanOnEarly * 100).toFixed(3)}% (n=${s.nOnEarly}) | recent(>=2021) meanON=${(s.meanOnRecent * 100).toFixed(3)}% (n=${s.nOnRecent})`);
}
console.log(`\nwrote ${OUT}/ic_decompose_result.json`);
