/**
 * D7-CME robustness: canonical pre-registered config (N=1) + temporal stability.
 * Canonical = "fade the weekend move at the Sunday reopen, fixed horizon to next Fri, all gaps."
 * This is what a practitioner specifies a priori (no grid search). Then split by year-era to see
 * if the edge is concentrated in early illiquid years (2017-2019) vs the liquid recent regime.
 */
import { loadBars, buildWeekends, barAtOrBefore, type Bar, type Weekend } from "./d7cme_probe.ts";
import { computeDeflatedSharpeRatio, summarizeReturnSeries, blockBootstrapConfidenceInterval } from "../../src/lib/training/statistical-validation.ts";

const HOUR = 3600 * 1000;
const COST = 0.0004;
const ANN = Math.sqrt(52);
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function annSh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }

const bars = loadBars();
const weekends = buildWeekends(bars);

function fade(W: Weekend[], minGap: number, maxGap: number, lag: number): number[] {
  const out: number[] = [];
  for (const w of W) {
    const ag = Math.abs(w.gapPct);
    if (ag < minGap || (maxGap < 1 && ag > maxGap)) continue;
    const eb = barAtOrBefore(bars, w.sunOpenEpoch + lag * HOUR);
    const xb = barAtOrBefore(bars, w.weekEndEpoch);
    if (!eb || !xb) continue;
    out.push(-Math.sign(w.gapPct) * Math.log(xb.c / eb.c) - 2 * COST);
  }
  return out;
}

// Canonical: minGap 0 (all gaps), lag 0, no cap
const canon = fade(weekends, 0, 1, 0);
console.log(`CANONICAL (all gaps, lag0, fixed horizon): n=${canon.length} meanRet=${(mean(canon) * 1e4).toFixed(2)}bps annSh=${annSh(canon).toFixed(3)}`);
const dsrC = computeDeflatedSharpeRatio(canon, { trialCount: 1 });
console.log(`  PSR (N=1) p=${dsrC.deflatedProbability.toFixed(4)} per-trade sh=${summarizeReturnSeries(canon).sharpe.toFixed(4)}`);
const bbC = blockBootstrapConfidenceInterval(canon, { statistic: "mean", iterations: 2000, blockLength: 8, seed: "canon" });
console.log(`  meanRet CI95=[${(bbC.lower * 1e4).toFixed(2)},${(bbC.upper * 1e4).toFixed(2)}]bps`);

// Canonical-2: the folklore version with a sensible small min-gap filter (0.5%) to avoid noise
const canon2 = fade(weekends, 0.005, 1, 0);
console.log(`CANONICAL-2 (minGap 0.5%, lag0): n=${canon2.length} meanRet=${(mean(canon2) * 1e4).toFixed(2)}bps annSh=${annSh(canon2).toFixed(3)}`);

// Temporal stability of the BEST config (mg1.5%,xg6%,lag24) across eras
function era(w: Weekend, y0: number, y1: number) { const y = new Date(w.sunOpenEpoch).getUTCFullYear(); return y >= y0 && y <= y1; }
const eras: [string, number, number][] = [["2017-2019", 2017, 2019], ["2020-2022", 2020, 2022], ["2023-2026", 2023, 2026]];
console.log(`\nTemporal stability of BEST config (mg=1.5%,xg=6%,lag24):`);
for (const [name, y0, y1] of eras) {
  const W = weekends.filter((w) => era(w, y0, y1));
  const r = fade(W, 0.015, 0.06, 24);
  console.log(`  ${name}: n=${r.length} meanRet=${(mean(r) * 1e4).toFixed(2)}bps annSh=${annSh(r).toFixed(3)}`);
}
console.log(`\nTemporal stability of CANONICAL (all gaps, lag0):`);
for (const [name, y0, y1] of eras) {
  const W = weekends.filter((w) => era(w, y0, y1));
  const r = fade(W, 0, 1, 0);
  console.log(`  ${name}: n=${r.length} meanRet=${(mean(r) * 1e4).toFixed(2)}bps annSh=${annSh(r).toFixed(3)}`);
}
