/**
 * D4-S7 diagnostic — does a cross-sectional reversal even EXIST (gross) in this panel?
 * We measure the cross-sectional rank-IC between signal(t) and forward return(t+1) at
 * several horizons and signal constructions. Negative IC = reversal (fade winners),
 * positive IC = momentum/continuation. Pure-XS = demeaned each period (market-neutral).
 *
 * No cost, no portfolio — just the raw predictive sign. If every honest signal IC is
 * >=0 there is NO reversal edge to harvest and the strategy is dead at the source.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/s7-diagnose.ts
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());

const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };

const COINS = Object.keys(weekly.weeklyRet);
const W = weekly.weeks.length;
const FULL = COINS.filter((c) =>
  weekly.weeklyRet[c].every((v) => v != null && isFinite(v as number)),
);

// Spearman rank-IC between two cross-sections (paired by coin)
function rankIC(sig: number[], fwd: number[]): number {
  const n = sig.length;
  if (n < 3) return NaN;
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    for (let k = 0; k < n; k++) r[idx[k][1]] = k;
    return r;
  };
  const rs = rank(sig);
  const rf = rank(fwd);
  const ms = (n - 1) / 2;
  let cov = 0, vs = 0, vf = 0;
  for (let i = 0; i < n; i++) {
    cov += (rs[i] - ms) * (rf[i] - ms);
    vs += (rs[i] - ms) ** 2;
    vf += (rf[i] - ms) ** 2;
  }
  return vs > 0 && vf > 0 ? cov / Math.sqrt(vs * vf) : 0;
}

function demean(xs: number[]): number[] {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.map((x) => x - m);
}

// ---- Weekly panel: raw vs demeaned signal, lag-1 and lag-2 (skip-one) ----
function weeklyIC(skip: boolean, demeanSig: boolean): { meanIC: number; n: number; tStat: number } {
  const ics: number[] = [];
  for (let i = 1; i < W - 1; i++) {
    const sigIdx = skip ? i - 1 : i;
    if (sigIdx < 0) continue;
    const coins = FULL.filter(
      (c) =>
        weekly.weeklyRet[c][sigIdx] != null &&
        weekly.weeklyRet[c][i + 1] != null,
    );
    if (coins.length < 5) continue;
    let sig = coins.map((c) => weekly.weeklyRet[c][sigIdx] as number);
    const fwd = coins.map((c) => weekly.weeklyRet[c][i + 1] as number);
    if (demeanSig) sig = demean(sig);
    const ic = rankIC(sig, fwd);
    if (isFinite(ic)) ics.push(ic);
  }
  const m = ics.reduce((a, b) => a + b, 0) / ics.length;
  const sd = Math.sqrt(ics.reduce((a, b) => a + (b - m) ** 2, 0) / ics.length);
  return { meanIC: m, n: ics.length, tStat: (m / sd) * Math.sqrt(ics.length) };
}

// ---- Daily panel: finer horizons (lookback L days -> forward H days) ----
const dailyCoins = COINS.filter((c) => {
  const cl = daily.closes[c];
  return cl && cl.every((v) => v != null && (v as number) > 0);
});
const D = daily.dates.length;
const logclose: Record<string, number[]> = {};
for (const c of dailyCoins) logclose[c] = (daily.closes[c] as number[]).map((v) => Math.log(v));
function dret(c: string, a: number, b: number): number {
  return logclose[c][b] - logclose[c][a];
}
function dailyIC(L: number, H: number, skipDays: number, demeanSig: boolean): { meanIC: number; n: number; tStat: number } {
  const ics: number[] = [];
  // non-overlapping forward windows to keep tStat honest
  for (let i = L + skipDays; i + H < D; i += H) {
    const sa = i - L - skipDays, sb = i - skipDays; // signal window [i-L-skip, i-skip]
    const fa = i, fb = i + H; // forward window
    let sig = dailyCoins.map((c) => dret(c, sa, sb));
    const fwd = dailyCoins.map((c) => dret(c, fa, fb));
    if (demeanSig) sig = demean(sig);
    const ic = rankIC(sig, fwd);
    if (isFinite(ic)) ics.push(ic);
  }
  const m = ics.reduce((a, b) => a + b, 0) / ics.length;
  const sd = Math.sqrt(ics.reduce((a, b) => a + (b - m) ** 2, 0) / ics.length);
  return { meanIC: m, n: ics.length, tStat: (m / sd) * Math.sqrt(ics.length) };
}

console.log("=== WEEKLY cross-sectional IC (signal -> next-week ret) ===");
console.log("  negative IC => reversal edge; positive => momentum/continuation");
for (const skip of [false, true])
  for (const dm of [false, true]) {
    const r = weeklyIC(skip, dm);
    console.log(
      `  skip=${skip?1:0} demean=${dm?1:0}: meanIC=${r.meanIC.toFixed(4)} t=${r.tStat.toFixed(2)} (n=${r.n})`,
    );
  }

console.log("\n=== DAILY cross-sectional IC at multiple horizons (demeaned signal) ===");
console.log("  L=lookback days, H=forward days, skip=gap days between signal & forward");
const grid: [number, number, number][] = [
  [1, 1, 0], [1, 1, 1], [2, 2, 0], [3, 3, 0], [3, 3, 1],
  [5, 5, 0], [5, 5, 1], [7, 7, 0], [7, 7, 1], [10, 5, 0], [5, 1, 0],
];
for (const [L, H, sk] of grid) {
  const r = dailyIC(L, H, sk, true);
  const tag = r.meanIC < 0 ? "REVERSAL" : "momentum";
  console.log(
    `  L=${L} H=${H} skip=${sk}: meanIC=${r.meanIC.toFixed(4)} t=${r.tStat.toFixed(2)} (n=${r.n}) [${tag}]`,
  );
}
console.log("\ncoins(daily full)=" + dailyCoins.length + " weekly full=" + FULL.length);
