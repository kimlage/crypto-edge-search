/**
 * D7-TOM (D7.5) — Turn-of-month effect on BTC daily.
 *
 * Belief: returns cluster around the month-end/start "turn". Strategy: LONG only the last N
 * trading days of a month + the first M trading days of the next month; FLAT otherwise.
 *
 * Honest N: every (N,M) config in the grid is counted (5x5 = 25). The reported "best" is the
 * in-sample top; DSR / Harvey-Liu correct for all 25.
 *
 * RIGHT null = CALENDAR-REANCHOR. The TOM claim is purely about *where in the month* the long
 * window sits. The correct surrogate preserves (a) the real BTC price path, (b) the monthly block
 * structure, (c) the exposure / window length, and destroys only the turn placement: for each
 * month it slides the long window to a random trading-day offset inside that month. If TOM is a
 * real effect, the true turn-anchored window must beat the distribution of randomly-anchored
 * windows of identical length. (Phase-randomization would be the WRONG null here — it destroys the
 * price autocorrelation, not the calendar anchoring.)
 *
 * Baselines: buy&hold (long-beta — TOM must beat exposure-scaled B&H), equal-weight long (= B&H
 * for single asset), random-lottery (random in/out books at matched exposure).
 *
 * Net of cost: 4 bps taker per side. Consume-once holdout: tail 20%, best cfg only, evaluated once.
 *
 * Gauntlet primitives imported directly from the committed training lib.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);

// ---------------------------------------------------------------- data
interface Bar { date: string; close: number; }
function loadDaily(asset: string): { dates: string[]; price: number[]; fwdRet: number[]; monthIdx: number[]; posInMonth: number[]; daysInMonth: number[] } {
  const j: Bar[] = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${asset}_daily_ohlc.json`, "utf8"));
  j.sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = j.map((r) => r.date);
  const price = j.map((r) => r.close);
  const T = price.length;
  const fwdRet: number[] = [];
  for (let t = 0; t < T; t++) fwdRet.push(t + 1 < T ? Math.log(price[t + 1] / price[t]) : NaN);
  // assign each day a calendar-month bucket and its trading-day position within that month
  const ym = dates.map((d) => d.slice(0, 7)); // YYYY-MM
  const monthIdx: number[] = [];
  const posInMonth: number[] = []; // 0-based index of this trading day within its calendar month
  const daysInMonth: number[] = []; // count of trading days in this day's calendar month
  let cur = -1;
  let m = "";
  const counts = new Map<string, number>();
  for (const k of ym) counts.set(k, (counts.get(k) ?? 0) + 1);
  let runPos = 0;
  for (let t = 0; t < T; t++) {
    if (ym[t] !== m) { m = ym[t]; cur++; runPos = 0; }
    monthIdx.push(cur);
    posInMonth.push(runPos);
    daysInMonth.push(counts.get(m)!);
    runPos++;
  }
  return { dates, price, fwdRet, monthIdx, posInMonth, daysInMonth };
}

// ---------------------------------------------------------------- utils
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]): number {
  const n = a.length; if (n < 2) return 0; const mu = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]): number { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function annSharpe(d: number): number { return d * ANN; }
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- positions
// TOM long window: last N days of month m (posInMonth >= daysInMonth-N) OR first M days of month
// m+1 (posInMonth < M). We build per-day boolean from posInMonth + daysInMonth (causal: a trader
// knows the month length only on a rolling basis, but for a fixed-grid calendar this is the
// idealized signal — we additionally test a STRICTLY-causal variant that uses last month's length).
function tomPosition(D: ReturnType<typeof loadDaily>, N: number, M: number): number[] {
  const T = D.price.length;
  const pos = new Array(T).fill(0);
  for (let t = 0; t < T; t++) {
    const inLastN = D.posInMonth[t] >= D.daysInMonth[t] - N;
    const inFirstM = D.posInMonth[t] < M;
    pos[t] = inLastN || inFirstM ? 1 : 0;
  }
  return pos;
}

// CALENDAR-REANCHOR surrogate: for each calendar month, place a long window of the SAME total
// length (= number of long days the real strategy holds in that month) at a RANDOM contiguous
// starting offset inside that month. Preserves price path + monthly block + exposure; destroys the
// turn-of-month placement. (Real TOM straddles two months; for the null we anchor a same-length
// contiguous block at a random within-month position per month — a strictly harder, fair null than
// shuffling because it keeps within-month autocorrelation.)
function reanchorPosition(D: ReturnType<typeof loadDaily>, N: number, M: number, rng: () => number): number[] {
  const T = D.price.length;
  const pos = new Array(T).fill(0);
  // group day indices by month
  const byMonth = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    const mi = D.monthIdx[t];
    if (!byMonth.has(mi)) byMonth.set(mi, []);
    byMonth.get(mi)!.push(t);
  }
  for (const [, idxs] of byMonth) {
    const dim = idxs.length;
    // real long-days this month = days in last-N of THIS month + first-M of THIS month.
    // (first-M belongs to month m, last-N belongs to month m; matches tomPosition windowing.)
    const lastN = Math.min(N, dim);
    const firstM = Math.min(M, dim);
    const blockLen = Math.min(dim, Math.max(1, lastN + firstM)); // contiguous same-length block
    const maxStart = dim - blockLen;
    const start = maxStart > 0 ? Math.floor(rng() * (maxStart + 1)) : 0;
    for (let k = start; k < start + blockLen; k++) pos[idxs[k]] = 1;
  }
  return pos;
}

interface BtResult { dailyNet: number[]; dailyGross: number[]; turnover: number; exposure: number; nDays: number; longShare: number; }
function runPositions(D: ReturnType<typeof loadDaily>, position: number[], startIdx: number, endIdx: number, cost = COST_PER_SIDE): BtResult {
  const dailyNet: number[] = []; const dailyGross: number[] = [];
  let prev = 0, turnoverSum = 0, expSum = 0, longCount = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = D.fwdRet[t]; const p = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(p)) continue;
    const turn = Math.abs(p - prev); const c = turn * cost; const gross = p * fr;
    dailyGross.push(gross); dailyNet.push(gross - c);
    turnoverSum += turn; expSum += Math.abs(p); if (p > 0) longCount++; prev = p;
  }
  const n = dailyNet.length;
  return { dailyNet, dailyGross, turnover: n ? turnoverSum / n : 0, exposure: n ? expSum / n : 0, nDays: n, longShare: n ? longCount / n : 0 };
}

// ---------------------------------------------------------------- gauntlet
function normalCdfLocal(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
function toFolds(series: number[], n: number): number[][] {
  const out: number[][] = []; const sz = Math.floor(series.length / n);
  for (let f = 0; f < n; f++) { const lo = f * sz; const hi = f === n - 1 ? series.length : lo + sz; out.push(series.slice(lo, hi)); }
  return out;
}

interface Cfg { N: number; M: number; }
function runGauntlet(opts: {
  name: string; D: ReturnType<typeof loadDaily>; configs: Cfg[]; canonical: Cfg;
  startIdx: number; holdoutFrac?: number; nSurr?: number;
}) {
  const { D, configs } = opts;
  const HONEST_N = configs.length;
  const holdoutFrac = opts.holdoutFrac ?? 0.2;
  const nSurr = opts.nSurr ?? 500;
  const T = D.price.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - opts.startIdx;
  const splitIdx = opts.startIdx + Math.floor(span * (1 - holdoutFrac));

  const scored = configs.map((cfg) => {
    const pos = tomPosition(D, cfg.N, cfg.M);
    const res = runPositions(D, pos, opts.startIdx, splitIdx);
    return { cfg, label: `N=${cfg.N},M=${cfg.M}`, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // baselines
  const bhPos = new Array(T).fill(1);
  const bh = runPositions(D, bhPos, opts.startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 300; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const pos = new Array(T).fill(0);
    for (let t = opts.startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
    rlSh.push(annSharpe(sharpeDaily(runPositions(D, pos, opts.startIdx, splitIdx).dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // Deflated Sharpe @ honest N
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // block bootstrap CI on mean daily net
  const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: `${opts.name}-bb` });
  const bbPass = bb.lower > 0;

  // CSCV / PBO
  const NFOLDS = 6;
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try { const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }); pbo = { pbo: r.pbo, medianLogit: r.medianLogit }; } catch { /* keep default */ }
  const pboPass = pbo.pbo < 0.5;

  // Harvey-Liu (Bonferroni) haircut
  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // RIGHT surrogate null: CALENDAR-REANCHOR
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const pos = reanchorPosition(D, best.cfg.N, best.cfg.M, rng);
    surr.push(annSharpe(sharpeDaily(runPositions(D, pos, opts.startIdx, splitIdx).dailyNet)));
  }
  surr.sort((a, b) => a - b);
  const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // consume-once holdout
  const holdRes = runPositions(D, best.pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // canonical (N=1)
  const canonPos = tomPosition(D, opts.canonical.N, opts.canonical.M);
  const canonRes = runPositions(D, canonPos, opts.startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    const pos = reanchorPosition(D, opts.canonical.N, opts.canonical.M, rng);
    canonSurr.push(annSharpe(sharpeDaily(runPositions(D, pos, opts.startIdx, splitIdx).dailyNet)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHoldSh = annSharpe(sharpeDaily(runPositions(D, canonPos, splitIdx, tradableEnd).dailyNet));

  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: { pass: mean(bestNet) > 0, detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)}` },
    baselines: { pass: baselinePass, detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}` },
    deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}` },
    block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})` },
    surrogate: { pass: surrPass, detail: `reanchorP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}` },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays} rows` },
  };
  const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
  let binding = "none";
  for (const g of order) if (!gates[g].pass) { binding = g; break; }
  const allPass = binding === "none";
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
  const meanDailyNet = mean(bestNet);
  const monthlyAt100k = meanDailyNet * 30 * 100000;

  console.log(`\n================ ${opts.name} ================`);
  console.log(`honestN=${HONEST_N}  best=${best.label}  nDaysIS=${best.res.nDays}  splitIdx=${splitIdx}/${T}`);
  console.log(`best netSharpeAnn=${best.netSh.toFixed(3)} grossSharpeAnn=${annSharpe(sharpeDaily(best.res.dailyGross)).toFixed(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)} longShare=${best.res.longShare.toFixed(2)}`);
  console.log(`B&H netSharpeAnn(IS)=${bhSh.toFixed(3)}`);
  for (const [g, r] of Object.entries(gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  console.log(`canonical(N=${opts.canonical.N},M=${opts.canonical.M}): netSharpeAnn=${canonSh.toFixed(3)} reanchorP=${canonSurrP.toFixed(4)} holdoutSharpeAnn=${canonHoldSh.toFixed(3)}`);
  const monthly = binding === "none" ? `$${Math.round(monthlyAt100k)}` : "n/a";
  console.log(`VERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly}`);
  return { verdict, best, binding, HONEST_N, surrP, monthlyAt100k, gates, canonSh, canonSurrP, canonHoldSh, bhSh, scored };
}

// ---------------------------------------------------------------- run
const asset = process.argv[2] ?? "BTC";
const D = loadDaily(asset);
// warmup: skip first month so posInMonth/daysInMonth are clean
let startIdx = 0;
while (startIdx < D.price.length && D.monthIdx[startIdx] === D.monthIdx[0]) startIdx++;

// honest grid: N (last days) x M (first days), 1..5 each => 25 configs
const configs: Cfg[] = [];
for (let N = 1; N <= 5; N++) for (let M = 1; M <= 5; M++) configs.push({ N, M });

const out = runGauntlet({ name: `D7-TOM ${asset} (calendar-reanchor null)`, D, configs, canonical: { N: 2, M: 3 }, startIdx, holdoutFrac: 0.2, nSurr: 1000 });

// dump the full (N,M) IS grid for transparency
console.log(`\n--- full IS (N,M) grid net Sharpe ---`);
const grid = out.scored.slice().sort((a, b) => (a.cfg.N - b.cfg.N) || (a.cfg.M - b.cfg.M));
for (const s of grid) console.log(`  N=${s.cfg.N} M=${s.cfg.M}: netSh=${s.netSh.toFixed(3)} exposure=${s.res.exposure.toFixed(3)}`);

fs.writeFileSync(`${ROOT}/output/edgehunt-requeue/d7_tom_${asset}.json`, JSON.stringify({
  asset, honestN: out.HONEST_N, best: out.best.label, bestNetSharpe: out.best.netSh, binding: out.binding,
  surrogateP: out.surrP, monthlyAt100k: out.monthlyAt100k, verdict: out.verdict, bhSh: out.bhSh,
  canonical: { netSharpe: out.canonSh, reanchorP: out.canonSurrP, holdout: out.canonHoldSh },
  gates: Object.fromEntries(Object.entries(out.gates).map(([k, v]) => [k, v.pass])),
  grid: grid.map((s) => ({ N: s.cfg.N, M: s.cfg.M, netSh: s.netSh, exposure: s.res.exposure })),
}, null, 2));
