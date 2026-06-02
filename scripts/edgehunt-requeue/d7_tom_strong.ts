/**
 * D7-TOM strongest honest version: EXPOSURE-NEUTRAL isolated turn (long turn / short rest), which
 * removes BTC long-beta from selection so the gauntlet judges the TURN MECHANISM, not drift.
 * Also pooled across BTC+ETH for max power. Same calendar-reanchor null.
 *
 * Position: +1 on turn days (last N + first M of month), -1 otherwise. Net market exposure ~0,
 * so the strategy earns ONLY the turn-vs-rest spread. If TOM is real this is where it shows.
 * (We also report a long-only-turn vs flat variant for completeness.)
 */
import fs from "node:fs";
import { computeDeflatedSharpeRatio, estimateCscvPbo, blockBootstrapConfidenceInterval, summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
const ROOT = ".";
const COST = 0.0004; const ANN = Math.sqrt(365);
interface Bar { date: string; close: number; }
function load(asset: string) {
  const j: Bar[] = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${asset}_daily_ohlc.json`, "utf8"));
  j.sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = j.map((r) => r.date); const price = j.map((r) => r.close); const T = price.length;
  const fwd: number[] = []; for (let t = 0; t < T; t++) fwd.push(t + 1 < T ? Math.log(price[t + 1] / price[t]) : NaN);
  const ym = dates.map((d) => d.slice(0, 7));
  const counts = new Map<string, number>(); for (const k of ym) counts.set(k, (counts.get(k) ?? 0) + 1);
  const posInMonth: number[] = []; const dim: number[] = []; const monthIdx: number[] = [];
  let m = ""; let run = 0; let mi = -1;
  for (let t = 0; t < T; t++) { if (ym[t] !== m) { m = ym[t]; run = 0; mi++; } posInMonth.push(run); dim.push(counts.get(m)!); monthIdx.push(mi); run++; }
  return { dates, fwd, posInMonth, dim, monthIdx, T };
}
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const mu = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1))); }
function shD(a: number[]) { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function annS(d: number) { return d * ANN; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

type D = ReturnType<typeof load>;
function isTurn(d: D, t: number, N: number, M: number) { return d.posInMonth[t] >= d.dim[t] - N || d.posInMonth[t] < M; }

// long/short exposure-neutral position
function posLS(d: D, N: number, M: number): number[] { const p = new Array(d.T).fill(0); for (let t = 0; t < d.T; t++) p[t] = isTurn(d, t, N, M) ? 1 : -1; return p; }
// reanchored null for the L/S variant: per month, place a same-length +1 block at random offset, -1 elsewhere
function posLSReanchor(d: D, N: number, M: number, rng: () => number): number[] {
  const p = new Array(d.T).fill(-1);
  const byMonth = new Map<number, number[]>();
  for (let t = 0; t < d.T; t++) { const k = d.monthIdx[t]; if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k)!.push(t); }
  for (const [, idxs] of byMonth) {
    const dim = idxs.length; const blockLen = Math.min(dim, Math.max(1, Math.min(N, dim) + Math.min(M, dim)));
    const maxStart = dim - blockLen; const start = maxStart > 0 ? Math.floor(rng() * (maxStart + 1)) : 0;
    for (let k = start; k < start + blockLen; k++) p[idxs[k]] = 1;
  }
  return p;
}
function bt(d: D, pos: number[], s: number, e: number) {
  const net: number[] = []; let prev = 0;
  for (let t = s; t < e; t++) { const fr = d.fwd[t]; const p = pos[t]; if (!Number.isFinite(fr) || !Number.isFinite(p)) continue; net.push(p * fr - Math.abs(p - prev) * COST); prev = p; }
  return net;
}
// pooled: concatenate per-asset daily net series (each backtested over its own window)
function btPooled(panels: D[], build: (d: D) => number[], frac: [number, number]) {
  const out: number[] = [];
  for (const d of panels) {
    let s0 = 0; while (s0 < d.T && d.monthIdx[s0] === d.monthIdx[0]) s0++;
    const end = d.T - 1; const span = end - s0; const a = s0 + Math.floor(span * frac[0]); const b = s0 + Math.floor(span * frac[1]);
    out.push(...bt(d, build(d), a, b));
  }
  return out;
}
function normalCdf(z: number) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function zSh(r: number[]) { const s = summarizeReturnSeries(r); if (s.sampleCount < 3 || s.stdDev <= 0) return 0; const sh = s.sharpe; const dn = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh)); return (sh * Math.sqrt(s.sampleCount - 1)) / dn; }
function toFolds(x: number[], n: number) { const o: number[][] = []; const sz = Math.floor(x.length / n); for (let f = 0; f < n; f++) { const lo = f * sz; const hi = f === n - 1 ? x.length : lo + sz; o.push(x.slice(lo, hi)); } return o; }

const panels = [load("BTC"), load("ETH")];
const configs: { N: number; M: number }[] = [];
for (let N = 1; N <= 5; N++) for (let M = 1; M <= 5; M++) configs.push({ N, M });
const HONEST = configs.length;

// score IS (0..0.8) on exposure-neutral L/S
const scored = configs.map((c) => { const net = btPooled(panels, (d) => posLS(d, c.N, c.M), [0, 0.8]); return { c, net, sh: annS(shD(net)) }; });
scored.sort((a, b) => b.sh - a.sh);
const best = scored[0];

const dsr = computeDeflatedSharpeRatio(best.net, { trialCount: HONEST });
const bb = blockBootstrapConfidenceInterval(best.net, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "tom-ls" });
let pbo = 1; try { pbo = estimateCscvPbo(scored.map((s) => ({ id: `${s.c.N}-${s.c.M}`, folds: toFolds(s.net, 6) })), { statistic: "sharpe", trainFraction: 0.5 }).pbo; } catch {}
const psrP = 1 - normalCdf(zSh(best.net)); const adjP = Math.min(1, psrP * HONEST);
// reanchor null (pooled), 1000 surrogates
const surr: number[] = [];
for (let i = 0; i < 1000; i++) { const rng = mkRng(7000 + i * 7919); const net = btPooled(panels, (d) => posLSReanchor(d, best.c.N, best.c.M, rng), [0, 0.8]); surr.push(annS(shD(net))); }
surr.sort((a, b) => a - b); const surrP = (surr.filter((s) => s >= best.sh).length + 1) / 1001;
// holdout
const hold = btPooled(panels, (d) => posLS(d, best.c.N, best.c.M), [0.8, 1]); const holdSh = annS(shD(hold));

console.log(`\n==== D7-TOM STRONG: exposure-neutral L/S, pooled BTC+ETH, calendar-reanchor null ====`);
console.log(`honestN=${HONEST} best=N=${best.c.N},M=${best.c.M} netSharpeAnn=${best.sh.toFixed(3)} nDaysIS=${best.net.length}`);
console.log(`  net mean daily = ${(mean(best.net) * 1e4).toFixed(2)}bp`);
console.log(`  DSR p=${dsr.deflatedProbability.toFixed(4)} (need>0.95)`);
console.log(`  blockBootstrap meanDaily CI95=[${bb.lower.toExponential(2)},${bb.upper.toExponential(2)}] (need lower>0)`);
console.log(`  PBO=${pbo.toFixed(3)} (need<0.5)`);
console.log(`  Harvey-Liu adjP=${adjP.toExponential(2)} (need<0.05)`);
console.log(`  reanchor surrogate p=${surrP.toFixed(4)} real=${best.sh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} (need<0.05)`);
console.log(`  holdout OOS netSharpeAnn=${holdSh.toFixed(3)} over ${hold.length} rows (need>0)`);

// also: long-only-turn pooled best, for the reported VERDICT net Sharpe
const scoredLO = configs.map((c) => { const net = btPooled(panels, (d) => { const p = new Array(d.T).fill(0); for (let t = 0; t < d.T; t++) p[t] = isTurn(d, t, c.N, c.M) ? 1 : 0; return p; }, [0, 0.8]); return { c, net, sh: annS(shD(net)) }; });
scoredLO.sort((a, b) => b.sh - a.sh);
const bLO = scoredLO[0];
const holdLO = btPooled(panels, (d) => { const p = new Array(d.T).fill(0); for (let t = 0; t < d.T; t++) p[t] = isTurn(d, t, bLO.c.N, bLO.c.M) ? 1 : 0; return p; }, [0.8, 1]);
console.log(`\n  [long-only-turn pooled] best=N=${bLO.c.N},M=${bLO.c.M} ISnetSharpe=${bLO.sh.toFixed(3)} holdout=${annS(shD(holdLO)).toFixed(3)}`);

const gates = { deflated_sharpe: dsr.deflatedProbability > 0.95, block_bootstrap: bb.lower > 0, cpcv_pbo: pbo < 0.5, haircut: adjP < 0.05, surrogate: surrP < 0.05, holdout: holdSh > 0, net_of_cost: mean(best.net) > 0 };
const order = ["net_of_cost", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
let binding = "none"; for (const g of order) if (!gates[g as keyof typeof gates]) { binding = g; break; }
const verdict = binding === "none" ? "SURVIVE" : (gates.net_of_cost && gates.surrogate && gates.holdout ? "PROMISING" : "KILL");
console.log(`\nVERDICT(strong): ${verdict} | net Sharpe ${best.sh.toFixed(3)} | binding ${binding} | honest N ${HONEST} | surrogate p ${surrP.toFixed(3)} | holdout ${holdSh.toFixed(3)}`);
fs.writeFileSync(`${ROOT}/output/edgehunt-requeue/d7_tom_strong.json`, JSON.stringify({ best: best.c, bestNetSharpe: best.sh, dsrP: dsr.deflatedProbability, pbo, adjP, surrP, holdSh, verdict, binding, honestN: HONEST }, null, 2));
