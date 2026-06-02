/**
 * ADVERSARIAL VERIFY — regime-window artifact on the D5-08 paper-forward (c).
 * Is net Sharpe 1.19 on 2023-06..2026-05 a one-sub-period artifact?
 *   - per-calendar-year net Sharpe on the funded window
 *   - leave-one-year-out: drop each year, recompute net Sharpe (does any single year carry it?)
 *   - the single best 90-day block's contribution (concentration)
 * Same next-open + cost + funding execution as paperforward.ts.
 */
import fs from "node:fs";
import { loadPanel, ema, rollingZ, mean, sharpeDaily, annSharpe, type Panel } from "../edgehunt-D5/harness.ts";

const ROOT = ".";
const LAG = 1, COST = 0.0004;
const PREREG = { smooth: 14, zwin: 365, thr: 1.0 } as const;

function loadDailyOpens(): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of fs.readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`, "utf8").split("\n")) {
    if (!line) continue; let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (typeof d.event_time === "string" && d.event_time.endsWith("T00:00:00.000Z")) m.set(d.event_date, Number(d.open));
  }
  return m;
}
function loadDailyFunding(): Map<string, number> {
  const arr = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/BTCUSDT_funding_8h.json`, "utf8"));
  const byDay = new Map<string, number>();
  for (const x of arr) { const iso = new Date(x.fundingTime).toISOString().slice(0, 10); byDay.set(iso, (byDay.get(iso) ?? 0) + Number(x.fundingRate)); }
  return byDay;
}
const lagArr = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
function netZ(P: Panel, s: number, zw: number): number[] {
  const fin = lagArr(P.flowInNtv, LAG), fout = lagArr(P.flowOutNtv, LAG);
  const net = P.price.map((_, t) => Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN);
  return rollingZ(ema(net, s), zw);
}
const BTC = loadPanel("btc");
const opens = loadDailyOpens(), funding = loadDailyFunding();
const z = netZ(BTC, PREREG.smooth, PREREG.zwin);
const pos = new Array(BTC.price.length).fill(NaN);
for (let t = 0; t < BTC.price.length; t++) if (Number.isFinite(z[t])) pos[t] = z[t] <= -PREREG.thr ? 1 : 0;

type Row = { date: string; net: number };
const rows: Row[] = []; let prev = 0;
for (let t = 0; t < BTC.price.length - 2; t++) {
  if (!Number.isFinite(pos[t])) continue;
  const dN = BTC.dates[t + 1], dN2 = BTC.dates[t + 2];
  const oN = opens.get(dN), oN2 = opens.get(dN2), fund = funding.get(dN);
  if (!(oN! > 0) || !(oN2! > 0) || !Number.isFinite(fund)) continue;
  const p = pos[t];
  const g = p * Math.log(oN2! / oN!), cost = Math.abs(p - prev) * COST, f = p > 0 ? p * fund! : 0;
  rows.push({ date: dN, net: g - cost - f }); prev = p;
}
const all = rows.map((r) => r.net);
const fullSharpe = annSharpe(sharpeDaily(all));

// per-year
const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))].sort();
const perYear = years.map((y) => {
  const s = rows.filter((r) => r.date.slice(0, 4) === y).map((r) => r.net);
  return { year: y, n: s.length, netSharpe: annSharpe(sharpeDaily(s)), meanDaily: mean(s), sumRet: s.reduce((a, b) => a + b, 0) };
});
// leave-one-year-out
const loyo = years.map((y) => {
  const s = rows.filter((r) => r.date.slice(0, 4) !== y).map((r) => r.net);
  return { droppedYear: y, n: s.length, netSharpe: annSharpe(sharpeDaily(s)) };
});
// best 90-day window contribution: total sum vs sum excluding the best contiguous 90-day block
const totalSum = all.reduce((a, b) => a + b, 0);
let bestBlockSum = -Infinity, bestStart = 0;
const W = 90;
for (let i = 0; i + W <= all.length; i++) { let s = 0; for (let j = i; j < i + W; j++) s += all[j]; if (s > bestBlockSum) { bestBlockSum = s; bestStart = i; } }
const exBest = all.slice(0, bestStart).concat(all.slice(bestStart + W));
const exBestSharpe = annSharpe(sharpeDaily(exBest));

const out = {
  window: { start: rows[0].date, end: rows[rows.length - 1].date, n: rows.length, fullSharpe },
  perYear,
  leaveOneYearOut: loyo,
  loyo_minSharpe: Math.min(...loyo.map((l) => l.netSharpe)),
  loyo_allStayAbove_0_8: loyo.every((l) => l.netSharpe > 0.8),
  concentration: {
    bestBlockStart: rows[bestStart].date, bestBlockW: W,
    bestBlockSumRet: bestBlockSum, totalSumRet: totalSum, bestBlockFracOfTotal: bestBlockSum / totalSum,
    sharpeExcludingBestBlock: exBestSharpe,
  },
};
fs.writeFileSync(`${ROOT}/output/edgehunt-deepen/verify_regime_result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
