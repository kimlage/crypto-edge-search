/**
 * D7-CME strongest honest version: FADE THE WEEKEND MOVE (pure direction, fixed horizon).
 *
 * The decomposition showed: (a) the specific friClose "magnet" is NOT special (jittered level does
 * as well, fill-rate = random-level placebo), but (b) there is a weak DIRECTIONAL signal: mid-size
 * weekend moves mean-revert over the following week. So the honest strategy is:
 *
 *   At sunOpen+lag, if |weekend move| in [minGap, maxGap], take position = -sign(move) (fade),
 *   hold a FIXED horizon to next-Fri CME close, exit at market. No path-dependent take-profit
 *   (so no exit-mechanics artifact). Net of 8bps round-trip.
 *
 * FULL GAUNTLET @ HONEST N (every config in the grid counted):
 *   net-of-cost | baselines (B&H, random-sign-lottery) | Deflated Sharpe @ N | block bootstrap |
 *   CPCV/PBO | Harvey-Liu Bonferroni haircut | RIGHT NULL = calendar-reanchor (fake mid-week
 *   "weekends" with the same fade rule) | consume-once holdout (last 20%).
 *
 * The calendar-reanchor null is the committed surrogate for the claim "the WEEKEND specifically
 * mean-reverts" — it preserves the move-size filter and the fade rule but moves the 2-day window
 * to random weekdays. If real weekends don't beat fake ones, the weekend is not special.
 */
import fs from "node:fs";
import { loadBars, buildWeekends, barAtOrBefore, type Bar, type Weekend } from "./d7cme_probe.ts";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const COST = 0.0004;
const ANN = Math.sqrt(52);
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function annSh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const bars = loadBars();
const weekends = buildWeekends(bars);
const Nw = weekends.length;

interface Cfg { minGap: number; maxGap: number; lag: number; }
const minGaps = [0, 0.005, 0.01, 0.015, 0.02];
const maxGaps = [1, 0.06, 0.04, 0.03];
const lags = [0, 3, 12, 24];
const grid: Cfg[] = [];
for (const mg of minGaps) for (const xg of maxGaps) for (const lg of lags) { if (xg < 1 && mg >= xg) continue; grid.push({ minGap: mg, maxGap: xg, lag: lg }); }
const HONEST_N = grid.length;

// fade return for a real weekend
function fadeRet(bars: Bar[], w: Weekend, cfg: Cfg): number | null {
  const ag = Math.abs(w.gapPct);
  if (ag < cfg.minGap || (cfg.maxGap < 1 && ag > cfg.maxGap)) return null;
  const eb = barAtOrBefore(bars, w.sunOpenEpoch + cfg.lag * HOUR);
  const xb = barAtOrBefore(bars, w.weekEndEpoch);
  if (!eb || !xb) return null;
  const dir = -Math.sign(w.gapPct); // fade
  return dir * Math.log(xb.c / eb.c) - 2 * COST;
}
function seriesOf(W: Weekend[], cfg: Cfg): number[] {
  const out: number[] = [];
  for (const w of W) { const r = fadeRet(bars, w, cfg); out.push(r == null ? 0 : r); }
  return out;
}

const splitIdx = Math.floor(Nw * 0.8);
const isW = weekends.slice(0, splitIdx);
const oosW = weekends.slice(splitIdx);

const scored = grid.map((cfg) => {
  const ret = seriesOf(isW, cfg);
  const traded = ret.filter((x) => x !== 0);
  return { cfg, ret, traded, nTrades: traded.length, sh: annSh(ret), label: `mg=${cfg.minGap},xg=${cfg.maxGap},lag=${cfg.lag}` };
}).filter((s) => s.nTrades >= 20);
scored.sort((a, b) => b.sh - a.sh);
const best = scored[0];
console.log(`weekends=${Nw} honestN=${HONEST_N} (grid; scored=${scored.length} w/>=20 trades)`);
console.log(`TOP 6:`);
for (const s of scored.slice(0, 6)) console.log(`  ${s.label}: sh=${s.sh.toFixed(3)} nTrades=${s.nTrades} meanRet=${(mean(s.ret) * 1e4).toFixed(2)}bps`);

const bestRet = best.ret;
// baselines
const bh: number[] = [];
for (const w of isW) { const eb = barAtOrBefore(bars, w.sunOpenEpoch); const xb = barAtOrBefore(bars, w.weekEndEpoch); bh.push(eb && xb ? Math.log(xb.c / eb.c) : 0); }
const bhSh = annSh(bh);
const rlSh: number[] = [];
for (let i = 0; i < 300; i++) { const rng = mkRng(424242 + i * 2654435761); const r: number[] = []; for (const w of isW) { const ag = Math.abs(w.gapPct); if (ag < best.cfg.minGap || (best.cfg.maxGap < 1 && ag > best.cfg.maxGap)) { r.push(0); continue; } const eb = barAtOrBefore(bars, w.sunOpenEpoch + best.cfg.lag * HOUR); const xb = barAtOrBefore(bars, w.weekEndEpoch); if (!eb || !xb) { r.push(0); continue; } const dir = rng() < 0.5 ? 1 : -1; r.push(dir * Math.log(xb.c / eb.c) - 2 * COST); } rlSh.push(annSh(r)); }
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
const baselinePass = best.sh > bhSh && best.sh > rl95 && best.sh > 0;

const dsr = computeDeflatedSharpeRatio(bestRet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;
const bb = blockBootstrapConfidenceInterval(bestRet, { statistic: "mean", iterations: 2000, blockLength: 8, confidenceLevel: 0.95, seed: "d7cme-fade-bb" });
const bbPass = bb.lower > 0;
function toFolds(s: number[], nf: number) { const f: number[][] = []; const sz = Math.floor(s.length / nf); for (let i = 0; i < nf; i++) f.push(s.slice(i * sz, i === nf - 1 ? s.length : (i + 1) * sz)); return f; }
let pbo = 1, medLogit = 0;
try { const r = estimateCscvPbo(scored.map((s) => ({ id: s.label, folds: toFolds(s.ret, 6) })), { statistic: "sharpe", trainFraction: 0.5 }); pbo = r.pbo; medLogit = r.medianLogit; } catch {}
const pboPass = pbo < 0.5;
function ncdf(z: number) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const ss = summarizeReturnSeries(bestRet);
const psrZ = ss.sampleCount >= 3 && ss.stdDev > 0 ? (ss.sharpe * Math.sqrt(ss.sampleCount - 1)) / Math.sqrt(Math.max(1e-9, 1 - ss.skewness * ss.sharpe + ((ss.kurtosis - 1) / 4) * ss.sharpe * ss.sharpe)) : 0;
const psrP = 1 - ncdf(psrZ);
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// RIGHT NULL: calendar-reanchor (fake mid-week weekends, same fade rule)
const nSurr = 1000;
const surr: number[] = [];
for (let i = 0; i < nSurr; i++) {
  const rng = mkRng(7000 + i * 7919);
  const shiftDays = 1 + Math.floor(rng() * 4); // 1..4 days mid-week shift (same per draw across weekends keeps weekly block structure)
  const r: number[] = [];
  for (const w of isW) {
    const fakeFri = w.friCloseEpoch + shiftDays * DAY;
    const fakeSun = fakeFri + 2 * DAY;
    const fakeEnd = fakeFri + 7 * DAY;
    const fb = barAtOrBefore(bars, fakeFri); const sb = barAtOrBefore(bars, fakeSun + best.cfg.lag * HOUR); const xb = barAtOrBefore(bars, fakeEnd);
    if (!fb || !sb || !xb) { r.push(0); continue; }
    const fakeGap = (sb.c - fb.c) / fb.c;
    const ag = Math.abs(fakeGap);
    if (ag < best.cfg.minGap || (best.cfg.maxGap < 1 && ag > best.cfg.maxGap)) { r.push(0); continue; }
    r.push(-Math.sign(fakeGap) * Math.log(xb.c / sb.c) - 2 * COST);
  }
  surr.push(annSh(r));
}
surr.sort((a, b) => a - b);
const surrP = (surr.filter((s) => s >= best.sh).length + 1) / (nSurr + 1);
const surrPass = surrP < 0.05;

const holdRet = seriesOf(oosW, best.cfg);
const holdSh = annSh(holdRet);
const holdoutPass = holdSh > 0;

const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: { pass: mean(bestRet) > 0, detail: `meanRet=${(mean(bestRet) * 1e4).toFixed(3)}bps/wk nTrades=${best.nTrades} sh=${best.sh.toFixed(3)}` },
  baselines: { pass: baselinePass, detail: `bestSh=${best.sh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randSign95=${rl95.toFixed(3)}` },
  deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh=${dsr.expectedMaxSharpe.toFixed(4)} sh(per-trade)=${ss.sharpe.toFixed(4)}` },
  block_bootstrap: { pass: bbPass, detail: `meanRet CI95=[${(bb.lower * 1e4).toFixed(3)},${(bb.upper * 1e4).toFixed(3)}]bps` },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.toFixed(3)} medLogit=${medLogit.toFixed(3)}` },
  haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)}*N=${HONEST_N})` },
  surrogate: { pass: surrPass, detail: `calendar-reanchorP=${surrP.toFixed(4)} real=${best.sh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}` },
  holdout: { pass: holdoutPass, detail: `OOS sh=${holdSh.toFixed(3)} over ${holdRet.filter((x) => x !== 0).length} trades` },
};
const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
let binding = "none";
for (const g of order) if (!gates[g].pass) { binding = g; break; }
const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
const verdict = binding === "none" ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
const monthly = mean(bestRet) > 0 ? mean(bestRet) * (52 / 12) * 100000 : NaN;

console.log(`\n================ D7-CME FADE gauntlet ================`);
console.log(`honestN=${HONEST_N} best=${best.label}`);
for (const [g, r] of Object.entries(gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.sh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${Number.isFinite(monthly) ? "$" + Math.round(monthly) : "n/a"}`);
fs.writeFileSync(`${ROOT}/output/edgehunt-requeue/d7cme_fade_result.json`, JSON.stringify({ honestN: HONEST_N, best: best.label, gates, verdict, binding, surrP, bhSh, rl95, holdSh, meanRetBps: mean(bestRet) * 1e4 }, null, 2));
