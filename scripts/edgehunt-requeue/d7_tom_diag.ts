/**
 * D7-TOM diagnostic: decompose the turn-of-month edge.
 *  - mean fwd log-return by trading-day position relative to the turn (last k .. first k)
 *  - in-sample (first 80%) vs holdout (last 20%) split, to see if the per-position edge is stable
 *  - "isolated turn" excess: turn-window mean minus rest-of-month mean (removes long-beta drift)
 */
import fs from "node:fs";
const ROOT = ".";
interface Bar { date: string; close: number; }
function load(asset: string) {
  const j: Bar[] = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${asset}_daily_ohlc.json`, "utf8"));
  j.sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = j.map((r) => r.date); const price = j.map((r) => r.close); const T = price.length;
  const fwd: number[] = []; for (let t = 0; t < T; t++) fwd.push(t + 1 < T ? Math.log(price[t + 1] / price[t]) : NaN);
  const ym = dates.map((d) => d.slice(0, 7));
  const counts = new Map<string, number>(); for (const k of ym) counts.set(k, (counts.get(k) ?? 0) + 1);
  const posInMonth: number[] = []; const dim: number[] = []; let m = ""; let run = 0;
  for (let t = 0; t < T; t++) { if (ym[t] !== m) { m = ym[t]; run = 0; } posInMonth.push(run); dim.push(counts.get(m)!); run++; }
  return { dates, fwd, posInMonth, dim, T };
}
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const mu = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1)); }
function tstat(a: number[]) { return a.length > 1 ? mean(a) / (std(a) / Math.sqrt(a.length)) : 0; }

for (const asset of ["BTC", "ETH"]) {
  const D = load(asset);
  const split = Math.floor(D.T * 0.8);
  // relative position: negative = from end (last day = -1), nonneg = from start (first day = +0)
  // We map each day to a "turn distance" label: last-k => -k (k=1..), first-j => +j (j=0..)
  // Then average fwd ret by label for IS and OOS.
  const labels = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4];
  const isBy = new Map<number, number[]>(); const oosBy = new Map<number, number[]>();
  for (const L of labels) { isBy.set(L, []); oosBy.set(L, []); }
  for (let t = 0; t < D.T; t++) {
    if (!Number.isFinite(D.fwd[t])) continue;
    const fromStart = D.posInMonth[t]; // 0-based
    const fromEnd = D.posInMonth[t] - D.dim[t]; // -1 = last day
    let label: number | null = null;
    if (fromEnd >= -5) label = fromEnd;        // last 5 days: -5..-1
    else if (fromStart <= 4) label = fromStart; // first 5 days: 0..4  (0 overlaps only if month<10)
    if (label === null || !labels.includes(label)) continue;
    (t < split ? isBy : oosBy).get(label)!.push(D.fwd[t]);
  }
  console.log(`\n==== ${asset}  (IS first 80% | OOS last 20%) ====`);
  console.log(`label   IS_mean   IS_t  IS_n  |  OOS_mean  OOS_t OOS_n`);
  for (const L of labels) {
    const a = isBy.get(L)!; const b = oosBy.get(L)!;
    console.log(`${String(L).padStart(4)}  ${(mean(a) * 1e4).toFixed(1).padStart(7)}bp ${tstat(a).toFixed(2).padStart(5)} ${String(a.length).padStart(4)}  | ${(mean(b) * 1e4).toFixed(1).padStart(7)}bp ${tstat(b).toFixed(2).padStart(5)} ${String(b.length).padStart(4)}`);
  }
  // overall: all days mean (the beta baseline)
  const allIS: number[] = []; const allOOS: number[] = [];
  for (let t = 0; t < D.T; t++) { if (!Number.isFinite(D.fwd[t])) continue; (t < split ? allIS : allOOS).push(D.fwd[t]); }
  console.log(` all  ${(mean(allIS) * 1e4).toFixed(1).padStart(7)}bp ${tstat(allIS).toFixed(2).padStart(5)} ${String(allIS.length).padStart(4)}  | ${(mean(allOOS) * 1e4).toFixed(1).padStart(7)}bp ${tstat(allOOS).toFixed(2).padStart(5)} ${String(allOOS.length).padStart(4)}`);
}
