/**
 * D7-DOW robustness: is the -Wednesday effect a real persistent calendar tilt, or a handful of
 * market-wide Wednesday crash dates (pseudo-replication: 8 assets share the same Wednesdays)?
 *
 * Tests:
 *  (1) Per-year Wednesday mean return + t (BTC) — is it stable or concentrated?
 *  (2) Pooled -Wed Sharpe after trimming the 1%/3%/5% worst Wednesdays (winsorize the tail).
 *  (3) In-sample-only (pre-2024-08) pooled calendar-reanchor p for -Wed — does it survive WITHOUT
 *      the 2024-25 holdout crashes?
 *  (4) How many distinct Wednesday DATES carry the holdout pnl (concentration / Top-5 contribution).
 */
import { loadDaily, mean, std, sharpeDaily, annSharpe, mkRng, DailySeries } from "./d7dow_harness.ts";

const ASSETS = ["BTC", "ETH", "SOL", "DOGE", "ADA", "XRP", "BNB", "AVAX"];

function demean(S: DailySeries, lo: number, hi: number): number[] {
  const v: number[] = [];
  for (let t = lo; t < hi; t++) if (Number.isFinite(S.fwdRet[t])) v.push(S.fwdRet[t]);
  const gm = mean(v);
  return S.fwdRet.map((r) => (Number.isFinite(r) ? r - gm : NaN));
}

// (1) per-year Wednesday demeaned mean (BTC)
console.log("=== (1) BTC Wednesday demeaned fwdRet by year ===");
{
  const S = loadDaily("BTC");
  const dm = demean(S, 0, S.close.length - 1);
  const byYear = new Map<string, number[]>();
  for (let t = 0; t < S.close.length - 1; t++) {
    if (S.weekday[t] !== 3) continue; // Wed
    if (!Number.isFinite(dm[t])) continue;
    const y = S.dates[t].slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(dm[t]);
  }
  for (const y of [...byYear.keys()].sort()) {
    const r = byYear.get(y)!;
    const m = mean(r), s = std(r), t = (m / s) * Math.sqrt(r.length);
    console.log(`  ${y}: nWed=${r.length} meanDemean=${(m * 100).toFixed(3)}% t=${t.toFixed(2)}`);
  }
}

// Build pooled per-date demeaned series (whole sample)
type Row = { wd: number; vals: number[]; date: string };
const byDate = new Map<string, Row>();
for (const a of ASSETS) {
  const S = loadDaily(a);
  const dm = demean(S, 0, S.close.length - 1);
  for (let t = 0; t < S.close.length - 1; t++) {
    if (!Number.isFinite(dm[t])) continue;
    const d = S.dates[t];
    if (!byDate.has(d)) byDate.set(d, { wd: S.weekday[t], vals: [], date: d });
    byDate.get(d)!.vals.push(dm[t]);
  }
}
const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
const wedRows = rows.filter((r) => r.wd === 3).map((r) => ({ date: r.date, ret: mean(r.vals) }));

// (4) concentration of -Wed pnl (short Wed -> pnl = -ret). Largest negative-Wed = biggest gains.
console.log("\n=== (4) -Wed pooled: pnl concentration (short Wednesday) ===");
{
  const pnl = wedRows.map((r) => ({ date: r.date, pnl: -r.ret }));
  const total = pnl.reduce((s, p) => s + p.pnl, 0);
  const sorted = [...pnl].sort((a, b) => b.pnl - a.pnl);
  const top5 = sorted.slice(0, 5);
  const top5sum = top5.reduce((s, p) => s + p.pnl, 0);
  const top10sum = sorted.slice(0, 10).reduce((s, p) => s + p.pnl, 0);
  console.log(`  nWed=${pnl.length} totalPnl=${(total * 100).toFixed(2)}%  top5 contrib=${((top5sum / total) * 100).toFixed(1)}%  top10=${((top10sum / total) * 100).toFixed(1)}%`);
  console.log(`  top5 Wednesdays:`, top5.map((p) => `${p.date}:${(p.pnl * 100).toFixed(1)}%`).join("  "));
}

// (2) pooled -Wed Sharpe after trimming worst Wednesdays (most-negative pooled return = biggest short gains)
console.log("\n=== (2) pooled -Wed Sharpe after trimming most-negative Wednesdays ===");
{
  function sharpeTrim(trimN: number): number {
    // sort wed by ret ascending; drop the trimN most negative (the crashes that the short profits from)
    const sorted = [...wedRows].sort((a, b) => a.ret - b.ret);
    const drop = new Set(sorted.slice(0, trimN).map((r) => r.date));
    const kept = wedRows.filter((r) => !drop.has(r.date)).map((r) => -r.ret);
    return annSharpe(sharpeDaily(kept));
  }
  for (const tn of [0, 3, 5, 10, 20]) console.log(`  trim ${tn} worst Wed: -Wed Sharpe=${sharpeTrim(tn).toFixed(3)}`);
}

// (3) in-sample-only pooled calendar-reanchor for -Wed (pre-2024-08-01) -> does it survive without the late crashes?
console.log("\n=== (3) IN-SAMPLE-ONLY pooled -Wed calendar-reanchor (dates < 2024-08-01) ===");
{
  const cut = "2024-08-01";
  const sub = rows.filter((r) => r.date < cut);
  const pooled = sub.map((r) => mean(r.vals));
  const wd = sub.map((r) => r.wd);
  const n = pooled.length;
  const COST = 0.0004;
  function apply(ret: number[], wdl: number[]): number[] {
    const out: number[] = []; let prev = 0;
    for (let t = 0; t < ret.length; t++) { const pos = wdl[t] === 3 ? -1 : 0; out.push(pos * ret[t] - Math.abs(pos - prev) * COST); prev = pos; }
    return out;
  }
  const real = annSharpe(sharpeDaily(apply(pooled, wd)));
  const nSurr = 2000; const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(21000 + i * 7919);
    const shift = 1 + Math.floor(rng() * (n - 2));
    const rot = pooled.map((_, k) => pooled[(k + shift) % n]);
    surr.push(annSharpe(sharpeDaily(apply(rot, wd))));
  }
  surr.sort((a, b) => a - b);
  const p = (surr.filter((s) => s >= real).length + 1) / (nSurr + 1);
  console.log(`  in-sample n=${n} realSh=${real.toFixed(3)} calendar-reanchor p=${p.toFixed(4)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`);
}
