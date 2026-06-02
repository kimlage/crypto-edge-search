/**
 * D5-08 CONFIRMATION — pin down (a) the N=1 pre-registered-canonical DSR/haircut for the ORIGINAL
 * raw-native netflow-Z signal (the strongest honest version), (b) the ETH non-generalization that
 * caps this at PROMISING, and (c) the conditional Sharpe on signal-ON days.
 *
 * Reuses the committed gauntlet primitives directly so numbers are apples-to-apples with run_d5.
 */
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";
import {
  loadPanel, runPositions, ema, rollingZ, mkRng, sharpeDaily, annSharpe, mean, std, type Panel,
} from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const LAG = 1;
const lag = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };

function netZ(P: Panel, smooth: number, zwin: number): number[] {
  const fin = lag(P.flowInNtv, LAG), fout = lag(P.flowOutNtv, LAG);
  const net = P.price.map((_, t) => (Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN));
  return rollingZ(ema(net, smooth), zwin);
}
function pos(P: Panel, z: number[], thr: number, side: string): number[] {
  const p = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    if (z[t] <= -thr) p[t] = 1; else if (z[t] >= thr) p[t] = side === "longshort" ? -1 : 0; else p[t] = 0;
  }
  return p;
}

function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const ncdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function zSh(r: number[]) { const s = summarizeReturnSeries(r); if (s.sampleCount < 3 || s.stdDev <= 0) return 0; const sh = s.sharpe; const d = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh)); return (sh * Math.sqrt(s.sampleCount - 1)) / d; }

const P = loadPanel("btc");
const T = P.price.length;
const startIdx = 700;
const splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8);

// ---- (a) GRID-BEST config (smooth7,zwin365,thr0.5,longflat) AND pre-registered CANONICAL ----
for (const [tag, cfg] of [
  ["grid-best", { smooth: 7, zwin: 365, thr: 0.5, side: "longflat" }],
  ["canonical", { smooth: 14, zwin: 180, thr: 1, side: "longflat" }],
] as const) {
  const z = netZ(P, cfg.smooth as number, cfg.zwin as number);
  const p = pos(P, z, cfg.thr as number, cfg.side as string);
  const r = runPositions(P, p, startIdx, splitIdx);
  const net = annSharpe(sharpeDaily(r.dailyNet));
  // DSR at N=1 (the registered single bet) vs N=54
  const dsr1 = computeDeflatedSharpeRatio(r.dailyNet, { trialCount: 1 });
  const dsr54 = computeDeflatedSharpeRatio(r.dailyNet, { trialCount: 54 });
  const psrP = 1 - ncdf(zSh(r.dailyNet));
  const hair1 = Math.min(1, psrP * 1), hair54 = Math.min(1, psrP * 54);
  // conditional Sharpe on signal-ON (|pos|>0) days, in-sample
  const on: number[] = [];
  for (let t = startIdx; t < splitIdx; t++) if (Number.isFinite(p[t]) && Math.abs(p[t]) > 0 && Number.isFinite(P.fwdRet[t])) on.push(p[t] * P.fwdRet[t]);
  const condSh = annSharpe(sharpeDaily(on));
  // surrogate p at this exact config
  const surr: number[] = [];
  for (let i = 0; i < 300; i++) { const rng = mkRng(13000 + i * 7919); const sp = pos(P, phaseRandomize(z, rng), cfg.thr as number, cfg.side as string); surr.push(annSharpe(sharpeDaily(runPositions(P, sp, startIdx, splitIdx).dailyNet))); }
  surr.sort((a, b) => a - b);
  const surrP = (surr.filter((s) => s >= net).length + 1) / 301;
  console.log(`\n[${tag}] ${JSON.stringify(cfg)}`);
  console.log(`  inSample netSharpeAnn=${net.toFixed(3)} exposure=${r.exposure.toFixed(3)} turnover=${r.turnover.toFixed(3)} nDays=${r.nDays}`);
  console.log(`  conditional Sharpe (signal-ON days, share=${(on.length / r.nDays).toFixed(2)}) = ${condSh.toFixed(3)}`);
  console.log(`  DSR @N=1  = ${dsr1.deflatedProbability.toFixed(4)} (PASS>0.95: ${dsr1.deflatedProbability > 0.95})`);
  console.log(`  DSR @N=54 = ${dsr54.deflatedProbability.toFixed(4)} (PASS>0.95: ${dsr54.deflatedProbability > 0.95})`);
  console.log(`  haircut adjP @N=1=${hair1.toExponential(3)} (PASS<0.05: ${hair1 < 0.05}) | @N=54=${hair54.toExponential(3)} (${hair54 < 0.05})`);
  console.log(`  surrogate p=${surrP.toFixed(4)}`);
}

// ---- (b) ETH non-generalization: exposure-matched random-lottery p on the same construction ----
const E = loadPanel("eth");
const Te = E.price.length;
const eStart = 700, eSplit = eStart + Math.floor((Te - 1 - eStart) * 0.8);
const ez = netZ(E, 7, 365);
const ep = pos(E, ez, 0.5, "longflat");
const er = runPositions(E, ep, eStart, eSplit);
const eNet = annSharpe(sharpeDaily(er.dailyNet));
// exposure-matched random-lottery null on ETH
const rl: number[] = [];
for (let i = 0; i < 1000; i++) {
  const rng = mkRng(555 + i * 2654435761);
  const rp = new Array(Te).fill(0);
  for (let t = eStart; t < eSplit; t++) rp[t] = rng() < er.exposure ? 1 : 0;
  rl.push(annSharpe(sharpeDaily(runPositions(E, rp, eStart, eSplit).dailyNet)));
}
rl.sort((a, b) => a - b);
const ethRlP = (rl.filter((s) => s >= eNet).length + 1) / 1001;
console.log(`\n[ETH generalization] netSharpeAnn=${eNet.toFixed(3)} exposure=${er.exposure.toFixed(3)} random-lottery p=${ethRlP.toFixed(3)} (PASS<0.05: ${ethRlP < 0.05})`);
console.log(`  -> ETH random-lottery p~0.18 documented => does NOT generalize => caps at PROMISING.`);
