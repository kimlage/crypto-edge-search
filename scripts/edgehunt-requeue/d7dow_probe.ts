/** D7-DOW probe: raw weekday means/t-stats, in-sample vs OOS, for BTC and the alt panel. */
import { loadDaily, mean, std } from "./d7dow_harness.ts";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function bucket(asset: string, lo?: string, hi?: string) {
  const S = loadDaily(asset);
  const byWd: number[][] = [[], [], [], [], [], [], []];
  for (let t = 0; t < S.fwdRet.length; t++) {
    if (!Number.isFinite(S.fwdRet[t])) continue;
    if (lo && S.dates[t] < lo) continue;
    if (hi && S.dates[t] >= hi) continue;
    byWd[S.weekday[t]].push(S.fwdRet[t]);
  }
  const rows = byWd.map((r, i) => {
    const m = mean(r);
    const s = std(r);
    const t = r.length > 1 ? (m / s) * Math.sqrt(r.length) : 0;
    return { wd: WD[i], n: r.length, meanPct: (m * 100).toFixed(4), tstat: t.toFixed(2) };
  });
  return rows;
}

for (const a of ["BTC", "ETH", "SOL", "DOGE"]) {
  const S = loadDaily(a);
  const T = S.fwdRet.length;
  const splitDateIdx = Math.floor(T * 0.8);
  const splitDate = S.dates[splitDateIdx];
  console.log(`\n=== ${a} (n=${T}, split=${splitDate}) ===`);
  console.log("FULL:");
  for (const r of bucket(a)) console.log(`  ${r.wd}: n=${r.n} mean=${r.meanPct}% t=${r.tstat}`);
  console.log(`IN-SAMPLE (<${splitDate}):`);
  for (const r of bucket(a, undefined, splitDate)) console.log(`  ${r.wd}: n=${r.n} mean=${r.meanPct}% t=${r.tstat}`);
  console.log(`OOS (>=${splitDate}):`);
  for (const r of bucket(a, splitDate)) console.log(`  ${r.wd}: n=${r.n} mean=${r.meanPct}% t=${r.tstat}`);
}
