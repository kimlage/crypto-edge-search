/**
 * D7-SEAS FINAL — committed gauntlet with the RIGHT (airtight, snoop-matched) calendar-reanchor null.
 *
 * The surrogate gate now re-runs the FULL best-k selection on each permuted calendar (mirroring the
 * data snooping exactly). This is the correct null for the month-of-year claim: it asks whether the
 * IDENTITY of the calendar months (Oct/Feb/...) carries information beyond "pick the top-mean buckets
 * out of 12". The honest N still counts every month-rule in the family.
 */
import {
  loadBtcDailyLong,
  loadBtcDailyNf1,
  runSeasGauntlet,
  printSeas,
  mean,
  sharpeDaily,
  annSharpe,
  runMask,
  demeanReturns,
  DailySeries,
  SeasInput,
} from "./d7seas_lib.ts";

function maskFromMonths(months: number[]): number[] {
  const m = new Array(13).fill(0);
  for (const x of months) m[x] = 1;
  return m;
}
function buildConfigs(S: DailySeries, startIdx: number, splitIdx: number) {
  const configs: { label: string; longMonth: number[] }[] = [];
  const seen = new Set<string>();
  const add = (label: string, mask: number[]) => {
    if (mask.slice(1).every((v) => v === 0)) return;
    const s = mask.slice(1).join("");
    if (seen.has(s)) return;
    seen.add(s);
    configs.push({ label, longMonth: mask });
  };
  add("Halloween:long Nov-Apr", maskFromMonths([11, 12, 1, 2, 3, 4]));
  add("InvHalloween:long May-Oct", maskFromMonths([5, 6, 7, 8, 9, 10]));
  for (let m = 1; m <= 12; m++) add(`single-long m${m}`, maskFromMonths([m]));
  for (let m = 1; m <= 12; m++) {
    const months = [];
    for (let k = 1; k <= 12; k++) if (k !== m) months.push(k);
    add(`single-flat m${m}`, maskFromMonths(months));
  }
  for (let start = 1; start <= 12; start++)
    for (let len = 1; len <= 11; len++) {
      const months = [];
      for (let k = 0; k < len; k++) months.push(((start - 1 + k) % 12) + 1);
      add(`contig start=${start} len=${len}`, maskFromMonths(months));
    }
  const byMonth: number[][] = Array.from({ length: 13 }, () => []);
  for (let t = startIdx; t < splitIdx; t++) if (Number.isFinite(S.fwdRet[t])) byMonth[S.month[t]].push(S.fwdRet[t]);
  const mu = Array.from({ length: 13 }, (_, m) => (m >= 1 ? mean(byMonth[m]) : -Infinity));
  const ranked = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].sort((a, b) => mu[b] - mu[a]);
  for (let k = 1; k <= 11; k++) add(`bestk k=${k}`, maskFromMonths(ranked.slice(0, k)));
  return configs;
}

// airtight snoop-matched surrogate: re-select best-k over k=1..11 on the relabeled calendar.
function makeReselect(S: DailySeries, startIdx: number, splitIdx: number) {
  return (relabel: number[], scoreRet: number[] | undefined): number => {
    const ret = scoreRet ?? S.fwdRet;
    const byMonth: number[][] = Array.from({ length: 13 }, () => []);
    for (let t = startIdx; t < splitIdx; t++) if (Number.isFinite(ret[t])) byMonth[relabel[t]].push(ret[t]);
    const mu = Array.from({ length: 13 }, (_, m) => (m >= 1 ? mean(byMonth[m]) : -Infinity));
    const ranked = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].sort((a, b) => mu[b] - mu[a]);
    let best = -Infinity;
    for (let k = 1; k <= 11; k++) {
      const mask = maskFromMonths(ranked.slice(0, k));
      const res = runMask({ ...S, month: relabel } as DailySeries, mask, startIdx, splitIdx, 0.0004, ret);
      best = Math.max(best, annSharpe(sharpeDaily(res.dailyNet)));
    }
    return best;
  };
}

function runVariant(S: DailySeries, seriesName: string, demean: boolean) {
  const startIdx = 0;
  const tradableEnd = S.price.length - 1;
  const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);
  const configs = buildConfigs(S, startIdx, splitIdx);
  const input: SeasInput = {
    name: `${seriesName} ${demean ? "DEMEANED(seasonality-only)" : "RAW(long-beta-allowed)"} [airtight null]`,
    S,
    configs,
    canonical: { label: "Halloween:long Nov-Apr", longMonth: maskFromMonths([11, 12, 1, 2, 3, 4]) },
    startIdx,
    holdoutFrac: 0.2,
    nSurr: 2000,
    demeanSecular: demean,
    reselectSurrogate: makeReselect(S, startIdx, splitIdx),
  };
  const out = runSeasGauntlet(input);
  printSeas(out);
  return out;
}

const long = loadBtcDailyLong();
const nf1 = loadBtcDailyNf1();
const rawLong = runVariant(long, "BTC-2015", false);
const demLong = runVariant(long, "BTC-2015", true);
const rawNf1 = runVariant(nf1, "BTC-nf1", false);

console.log(`\n================ D7-SEAS FINAL SUMMARY (airtight calendar-reanchor null) ================`);
for (const [tag, o] of [["RAW-2015", rawLong], ["DEM-2015", demLong], ["RAW-nf1", rawNf1]] as const) {
  console.log(
    `${tag}: verdict=${o.verdict} netSh=${o.netSharpeAnn.toFixed(3)} binding=${o.bindingGate} N=${o.honestN} surrP=${o.surrogateP.toFixed(3)} holdoutSh=${o.holdoutSharpeAnn.toFixed(3)} canonHalloweenSh=${o.canonical.netSharpeAnn.toFixed(3)} best=${o.bestLabel}`,
  );
}
