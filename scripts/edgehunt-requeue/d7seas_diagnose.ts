/**
 * Diagnose the RAW-2015 nominal pass: is it a long-beta artifact or a real month-of-year edge?
 *
 * Test 1 (snoop-matched calendar-reanchor on RAW returns): permute the calendar labels, then
 *   RE-SELECT the best-k month set by IS-mean on the permuted calendar and recompute its net Sharpe.
 *   This is the exactly-right null: it mirrors the full data-snooping (we always pick the best months)
 *   while destroying the identity of which calendar month is which. p = P(surrogate >= real).
 *
 * Test 2 (year-block reshuffle): keep month identity, but RESAMPLE whole calendar years with
 *   replacement (block = 1 year). If the edge is just "a few huge bull years (2017/2020/2021) had
 *   their gains in Oct/Feb/Jul", the Sharpe should collapse / spread wildly across year-resamples.
 *
 * Test 3 (per-year stability): show the best-config strategy return year-by-year — is the edge
 *   carried by 2-3 years (snooping) or broadly present?
 */
import {
  loadBtcDailyLong,
  mean,
  std,
  sharpeDaily,
  annSharpe,
  mkRng,
  shuffle,
  runMask,
  demeanReturns,
  DailySeries,
} from "./d7seas_lib.ts";

function maskFromMonths(months: number[]): number[] {
  const m = new Array(13).fill(0);
  for (const x of months) m[x] = 1;
  return m;
}

const S = loadBtcDailyLong();
const startIdx = 0;
const T = S.price.length;
const tradableEnd = T - 1;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);
console.log(`IS window ${S.dates[startIdx]}..${S.dates[splitIdx - 1]}, holdout ${S.dates[splitIdx]}..${S.dates[tradableEnd - 1]}`);

// helper: best-k-by-IS-mean selection given a per-day "calendar month" relabeling.
// relabel[m] = the month that the calendar-month m is treated AS (permutation). We compute IS mean
// return for each relabeled bucket and pick the top-k buckets, exactly as the real procedure does.
function bestKsharpe(monthLabel: number[], k: number, ret: number[]): { sh: number; months: number[] } {
  const byMonth: number[][] = Array.from({ length: 13 }, () => []);
  for (let t = startIdx; t < splitIdx; t++) if (Number.isFinite(ret[t])) byMonth[monthLabel[t]].push(ret[t]);
  const mu = Array.from({ length: 13 }, (_, m) => (m >= 1 ? mean(byMonth[m]) : -Infinity));
  const ranked = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].sort((a, b) => mu[b] - mu[a]);
  const months = ranked.slice(0, k);
  const mask = maskFromMonths(months);
  const res = runMask({ ...S, month: monthLabel } as DailySeries, mask, startIdx, splitIdx, 0.0004, ret);
  return { sh: annSharpe(sharpeDaily(res.dailyNet)), months };
}

// REAL best-k over k=1..11 on raw returns (this is what RAW-2015 reported)
let realBest = { sh: -Infinity, k: 0, months: [] as number[] };
for (let k = 1; k <= 11; k++) {
  const r = bestKsharpe(S.month, k, S.fwdRet);
  if (r.sh > realBest.sh) realBest = { sh: r.sh, k, months: r.months };
}
console.log(`\nREAL best-k (raw): k=${realBest.k} months=[${realBest.months.join(",")}] netSharpeAnn=${realBest.sh.toFixed(3)}`);

// TEST 1: snoop-matched calendar-reanchor null on RAW returns
const N = 5000;
const surr: number[] = [];
for (let i = 0; i < N; i++) {
  const rng = mkRng(13000 + i * 2654435761);
  const perm = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], rng);
  const permMap = new Array(13).fill(0);
  for (let j = 0; j < 12; j++) permMap[j + 1] = perm[j];
  const relabel = S.month.map((m) => permMap[m]);
  let bs = -Infinity;
  for (let k = 1; k <= 11; k++) bs = Math.max(bs, bestKsharpe(relabel, k, S.fwdRet).sh);
  surr.push(bs);
}
surr.sort((a, b) => a - b);
const p1 = (surr.filter((s) => s >= realBest.sh).length + 1) / (N + 1);
console.log(`TEST1 snoop-matched calendar-reanchor (RAW): p=${p1.toFixed(4)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(N * 0.95)].toFixed(3)} surrMax=${surr[N - 1].toFixed(3)}`);

// same on DEMEANED returns (seasonality-only)
const dret = demeanReturns(S, startIdx, splitIdx);
let realBestD = { sh: -Infinity, k: 0, months: [] as number[] };
for (let k = 1; k <= 11; k++) {
  const r = bestKsharpe(S.month, k, dret);
  if (r.sh > realBestD.sh) realBestD = { sh: r.sh, k, months: r.months };
}
const surrD: number[] = [];
for (let i = 0; i < N; i++) {
  const rng = mkRng(23000 + i * 2654435761);
  const perm = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], rng);
  const permMap = new Array(13).fill(0);
  for (let j = 0; j < 12; j++) permMap[j + 1] = perm[j];
  const relabel = S.month.map((m) => permMap[m]);
  let bs = -Infinity;
  for (let k = 1; k <= 11; k++) bs = Math.max(bs, bestKsharpe(relabel, k, dret).sh);
  surrD.push(bs);
}
surrD.sort((a, b) => a - b);
const p1d = (surrD.filter((s) => s >= realBestD.sh).length + 1) / (N + 1);
console.log(`REAL best-k (demeaned): k=${realBestD.k} months=[${realBestD.months.join(",")}] netSharpeAnn=${realBestD.sh.toFixed(3)}`);
console.log(`TEST1 snoop-matched calendar-reanchor (DEMEANED): p=${p1d.toFixed(4)} surrMean=${mean(surrD).toFixed(3)} surr95=${surrD[Math.floor(N * 0.95)].toFixed(3)}`);

// TEST 3: per-year contribution of the REAL best-k raw strategy
const mask = maskFromMonths(realBest.months);
const byYear: Record<string, number[]> = {};
for (let t = startIdx; t < splitIdx; t++) {
  if (!Number.isFinite(S.fwdRet[t])) continue;
  const pos = mask[S.month[t]];
  const y = S.dates[t].slice(0, 4);
  (byYear[y] ??= []).push(pos * S.fwdRet[t]);
}
console.log(`\nPER-YEAR cumulative log-return of REAL best-k raw strategy (months [${realBest.months.join(",")}]):`);
const yrs = Object.keys(byYear).sort();
let pos = 0, neg = 0;
for (const y of yrs) {
  const cum = byYear[y].reduce((s, v) => s + v, 0);
  if (cum > 0) pos++; else neg++;
  console.log(`  ${y}: cumLogRet=${(cum * 100).toFixed(1)}%  (annSh≈${annSharpe(sharpeDaily(byYear[y])).toFixed(2)}, n=${byYear[y].length})`);
}
console.log(`  positive years=${pos} negative years=${neg}`);
