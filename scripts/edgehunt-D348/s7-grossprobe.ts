/**
 * D4-S7 gross probe — is ANY honest tradable construction gross-positive?
 * The IC diagnostic was significant (t up to -4.49) but the portfolio was gross-negative.
 * Resolve the contradiction: measure the GROSS long-short decile spread directly for the
 * strongest-IC configs, including the full top-vs-bottom spread and a continuous
 * rank-weighted (IC-style) portfolio that actually captures the IC.
 *
 * If even the rank-weighted (full-cross-section) gross spread is <=0, the IC sign is
 * noise/middle-driven and there is no harvestable reversal. If rank-weighted is positive
 * but decile is not, the edge is too diffuse to trade past cost.
 */
import fs from "node:fs";
import path from "node:path";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };
const COINS = Object.keys(daily.closes);
const dailyCoins = COINS.filter((c) => {
  const cl = daily.closes[c];
  return cl && cl.every((v) => v != null && (v as number) > 0);
});
const D = daily.dates.length;
const logc: Record<string, number[]> = {};
for (const c of dailyCoins) logc[c] = (daily.closes[c] as number[]).map((v) => Math.log(v));
const dret = (c: string, a: number, b: number) => logc[c][b] - logc[c][a];
const ann = (s: number, ppy: number) => s * Math.sqrt(ppy);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const mean = (r: number[]) => r.reduce((a, b) => a + b, 0) / r.length;

function rankWeights(sig: number[]): number[] {
  // continuous demeaned rank weights, sum |w| = 1; reversal => weight = -(rank-centered)
  const n = sig.length;
  const idx = sig.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(n).fill(0);
  for (let k = 0; k < n; k++) r[idx[k][1]] = k - (n - 1) / 2; // centered rank
  // reversal: long low-signal (negative centered rank) => weight = -centeredRank
  const w = r.map((x) => -x);
  const s = w.reduce((a, b) => a + Math.abs(b), 0) || 1;
  return w.map((x) => x / s);
}

function decileSpread(L: number, H: number, skip: number, fracK: number) {
  const K = Math.max(2, Math.floor(dailyCoins.length * fracK));
  const out: number[] = [];
  for (let i = L + skip; i + H < D; i += H) {
    const sig0 = dailyCoins.map((c) => dret(c, i - L - skip, i - skip));
    const sm = mean(sig0);
    const sig = sig0.map((x) => x - sm);
    const order = sig.map((v, idx) => [v, idx] as [number, number]).sort((a, b) => a[0] - b[0]);
    const longs = order.slice(0, K).map((o) => o[1]);
    const shorts = order.slice(-K).map((o) => o[1]);
    const fwd = dailyCoins.map((c) => dret(c, i, i + H));
    const fm = mean(fwd);
    let g = 0;
    for (const idx of longs) g += fwd[idx] - fm;
    for (const idx of shorts) g -= fwd[idx] - fm;
    out.push(g / (longs.length + shorts.length));
  }
  return out;
}

function rankWeighted(L: number, H: number, skip: number) {
  const out: number[] = [];
  for (let i = L + skip; i + H < D; i += H) {
    const sig0 = dailyCoins.map((c) => dret(c, i - L - skip, i - skip));
    const sm = mean(sig0);
    const w = rankWeights(sig0.map((x) => x - sm));
    const fwd = dailyCoins.map((c) => dret(c, i, i + H));
    const fm = mean(fwd);
    let g = 0;
    for (let k = 0; k < dailyCoins.length; k++) g += w[k] * (fwd[k] - fm);
    out.push(g);
  }
  return out;
}

console.log("config            | rankWtd grossSh | decile grossSh | decile meanBps");
for (const [L, H, sk] of [[5, 1, 0], [3, 3, 1], [2, 2, 0], [5, 5, 0], [7, 5, 1], [3, 1, 0]] as [number,number,number][]) {
  const ppy = 252 / H;
  const rw = rankWeighted(L, H, sk);
  for (const fk of [0.2]) {
    const dc = decileSpread(L, H, sk, fk);
    console.log(
      `L=${L} H=${H} skip=${sk} k=${fk} | ${ann(sharpe(rw), ppy).toFixed(2).padStart(6)}          | ${ann(sharpe(dc), ppy).toFixed(2).padStart(6)}         | ${(mean(dc) * 1e4).toFixed(1)}`,
    );
  }
}
