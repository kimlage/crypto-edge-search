/**
 * D7-SEAS runner — month-of-year long/flat seasonality, full gauntlet, calendar-reanchor null.
 *
 * Honest N = every month-rule tried. Family:
 *   - canonical Halloween (long Nov-Apr) + its inverse
 *   - all 12 single-month-long rules
 *   - all 12 single-month-flat (long other 11) rules
 *   - all contiguous-window-long rules: start in 1..12 x length 1..11  (132)
 *   - data-snooped best-k-months-by-IS-mean for k=1..11 (11)
 * De-duplicated by mask signature. N = configs.length is reported as the honest count.
 *
 * Two variants per series:
 *   RAW      — score on raw returns (long-beta allowed to help; optimistic)
 *   DEMEANED — score on secular-drift-demeaned returns (the honest seasonality-only test)
 */
import {
  loadBtcDailyLong,
  loadBtcDailyNf1,
  runSeasGauntlet,
  printSeas,
  mean,
  demeanReturns,
  DailySeries,
  SeasInput,
} from "./d7seas_lib.ts";

function maskFromMonths(months: number[]): number[] {
  const m = new Array(13).fill(0);
  for (const x of months) m[x] = 1;
  return m;
}
function sig(mask: number[]): string {
  return mask.slice(1).join("");
}

function buildConfigs(S: DailySeries, startIdx: number, splitIdx: number) {
  const configs: { label: string; longMonth: number[] }[] = [];
  const seen = new Set<string>();
  const add = (label: string, mask: number[]) => {
    const s = sig(mask);
    // skip all-flat (degenerate) and dedupe
    if (mask.slice(1).every((v) => v === 0)) return;
    if (seen.has(s)) return;
    seen.add(s);
    configs.push({ label, longMonth: mask });
  };

  // canonical Halloween long Nov-Apr (11,12,1,2,3,4) + inverse
  add("Halloween:long Nov-Apr", maskFromMonths([11, 12, 1, 2, 3, 4]));
  add("InvHalloween:long May-Oct", maskFromMonths([5, 6, 7, 8, 9, 10]));

  // single-month-long
  for (let m = 1; m <= 12; m++) add(`single-long m${m}`, maskFromMonths([m]));
  // single-month-flat (long the other 11)
  for (let m = 1; m <= 12; m++) {
    const months = [];
    for (let k = 1; k <= 12; k++) if (k !== m) months.push(k);
    add(`single-flat m${m}`, maskFromMonths(months));
  }

  // contiguous windows (wrap-around) start 1..12, length 1..11
  for (let start = 1; start <= 12; start++) {
    for (let len = 1; len <= 11; len++) {
      const months = [];
      for (let k = 0; k < len; k++) months.push(((start - 1 + k) % 12) + 1);
      add(`contig start=${start} len=${len}`, maskFromMonths(months));
    }
  }

  // data-snooped best-k-by-IS-mean (k=1..11). Compute IS monthly means on RAW returns.
  const byMonth: number[][] = Array.from({ length: 13 }, () => []);
  for (let t = startIdx; t < splitIdx; t++) if (Number.isFinite(S.fwdRet[t])) byMonth[S.month[t]].push(S.fwdRet[t]);
  const muByMonth = Array.from({ length: 13 }, (_, m) => (m >= 1 ? mean(byMonth[m]) : -Infinity));
  const ranked = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].sort((a, b) => muByMonth[b] - muByMonth[a]);
  for (let k = 1; k <= 11; k++) add(`bestk k=${k}`, maskFromMonths(ranked.slice(0, k)));

  return configs;
}

function runVariant(S: DailySeries, seriesName: string, demean: boolean) {
  const startIdx = 0;
  const T = S.price.length;
  const tradableEnd = T - 1;
  const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);
  const configs = buildConfigs(S, startIdx, splitIdx);
  const input: SeasInput = {
    name: `${seriesName} ${demean ? "DEMEANED(seasonality-only)" : "RAW(long-beta-allowed)"}`,
    S,
    configs,
    canonical: { label: "Halloween:long Nov-Apr", longMonth: maskFromMonths([11, 12, 1, 2, 3, 4]) },
    startIdx,
    holdoutFrac: 0.2,
    nSurr: 1000,
    demeanSecular: demean,
  };
  const out = runSeasGauntlet(input);
  printSeas(out);
  return out;
}

const long = loadBtcDailyLong();
const nf1 = loadBtcDailyNf1();

console.log(`\n##### PRIMARY: BTC daily onchain-poc 2015+ (longest history, max effective N) #####`);
const rawLong = runVariant(long, "BTC-2015", false);
const demLong = runVariant(long, "BTC-2015", true);

console.log(`\n##### ROBUSTNESS: BTC daily nf1 2017+ #####`);
const rawNf1 = runVariant(nf1, "BTC-nf1", false);
const demNf1 = runVariant(nf1, "BTC-nf1", true);

// summary
console.log(`\n================ D7-SEAS SUMMARY ================`);
for (const [tag, o] of [["RAW-2015", rawLong], ["DEM-2015", demLong], ["RAW-nf1", rawNf1], ["DEM-nf1", demNf1]] as const) {
  console.log(
    `${tag}: verdict=${o.verdict} netSh=${o.netSharpeAnn.toFixed(3)} binding=${o.bindingGate} N=${o.honestN} surrP=${o.surrogateP.toFixed(3)} holdoutSh=${o.holdoutSharpeAnn.toFixed(3)} best=${o.bestLabel}`,
  );
}
