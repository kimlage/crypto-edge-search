/** Exploratory: month-of-year mean daily log-returns for BTC, raw and demeaned, both series. */
import { loadBtcDailyLong, loadBtcDailyNf1, mean, std, DailySeries } from "./d7seas_lib.ts";

function monthStats(S: DailySeries, label: string) {
  const byMonth: number[][] = Array.from({ length: 13 }, () => []);
  for (let t = 0; t < S.price.length - 1; t++) {
    if (Number.isFinite(S.fwdRet[t])) byMonth[S.month[t]].push(S.fwdRet[t]);
  }
  const all: number[] = [];
  for (let m = 1; m <= 12; m++) all.push(...byMonth[m]);
  const mu = mean(all);
  console.log(`\n=== ${label} (n=${all.length}, ${S.dates[0]}..${S.dates[S.dates.length - 1]}) globalMeanDaily=${(mu).toExponential(3)} ===`);
  const MN = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const rows: { m: number; mu: number; muAnn: number; n: number; nYears: number; tstat: number }[] = [];
  for (let m = 1; m <= 12; m++) {
    const v = byMonth[m];
    const mm = mean(v);
    const se = std(v) / Math.sqrt(v.length);
    const nYears = v.length / 30.4;
    rows.push({ m, mu: mm, muAnn: mm * 365, n: v.length, nYears, tstat: se > 0 ? mm / se : 0 });
  }
  for (const r of rows) {
    const flag = r.m >= 5 && r.m <= 10 ? "  (May-Oct: 'sell')" : "  (Nov-Apr: 'hold')";
    console.log(
      `  ${MN[r.m]}: meanDaily=${r.mu.toExponential(3)} annRet=${(r.muAnn * 100).toFixed(1)}% nDays=${r.n} (~${r.nYears.toFixed(1)}y) t≈${r.tstat.toFixed(2)}${flag}`,
    );
  }
  // Halloween split
  const novApr: number[] = [], mayOct: number[] = [];
  for (let m = 1; m <= 12; m++) (m >= 5 && m <= 10 ? mayOct : novApr).push(...byMonth[m]);
  console.log(
    `  Halloween: Nov-Apr meanDaily=${mean(novApr).toExponential(3)} (ann ${(mean(novApr) * 365 * 100).toFixed(0)}%) | May-Oct meanDaily=${mean(mayOct).toExponential(3)} (ann ${(mean(mayOct) * 365 * 100).toFixed(0)}%)`,
  );
}

const long = loadBtcDailyLong();
const nf1 = loadBtcDailyNf1();
monthStats(long, "BTC daily (onchain-poc, 2015+)");
monthStats(nf1, "BTC daily (nf1, 2017+)");
