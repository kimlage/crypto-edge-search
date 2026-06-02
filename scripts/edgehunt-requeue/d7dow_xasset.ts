/**
 * D7-DOW cross-asset replication + pooled panel.
 *
 * The strongest honest claim that survives selection on BTC is a NEGATIVE-WEDNESDAY (and weak
 * POSITIVE Sun/Tue) calendar tilt. Genuine calendar effects should replicate across independent
 * assets. Here we:
 *   1) Pre-register the BTC-discovered config (-Wed, +Sun/+Tue) and test it as N=1 on each OTHER
 *      asset's holdout (genuine OOS / OOA = out-of-asset).
 *   2) Build a POOLED panel (stack all-asset demeaned returns) and run the calendar-reanchor null on
 *      the pooled series — honest N tiny because the config is pre-registered from BTC.
 */
import { loadDaily, mean, std, sharpeDaily, annSharpe, mkRng, rotatedFwdRet, DailySeries } from "./d7dow_harness.ts";

const COST = 0.0004;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ASSETS = ["BTC", "ETH", "SOL", "DOGE", "ADA", "XRP", "BNB", "AVAX"];

function runSign(S: DailySeries, fwd: number[], sign: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let t = lo; t < hi; t++) {
    const fr = fwd[t];
    if (!Number.isFinite(fr)) continue;
    const pos = sign[S.weekday[t]];
    out.push(pos * fr - Math.abs(pos - prev) * COST);
    prev = pos;
  }
  return out;
}
function demean(S: DailySeries, lo: number, hi: number): number[] {
  const v: number[] = [];
  for (let t = lo; t < hi; t++) if (Number.isFinite(S.fwdRet[t])) v.push(S.fwdRet[t]);
  const gm = mean(v);
  return S.fwdRet.map((r) => (Number.isFinite(r) ? r - gm : NaN));
}

// Pre-registered configs discovered on BTC in-sample
const CFG_3SIGN = [1, 0, 1, -1, 0, 0, 0]; // +Sun,+Tue,-Wed
const CFG_WED = [0, 0, 0, -1, 0, 0, 0]; // short Wed only

console.log("=== (1) Out-of-asset test: BTC-discovered configs on each asset (FULL & HOLDOUT) ===");
for (const cfg of [
  { name: "+Sun,+Tue,-Wed", c: CFG_3SIGN },
  { name: "-Wed only", c: CFG_WED },
]) {
  console.log(`\nconfig ${cfg.name}`);
  for (const a of ASSETS) {
    const S = loadDaily(a);
    const T = S.close.length;
    const split = Math.floor((T - 1) * 0.8);
    const dnFull = runSign(S, demean(S, 0, T - 1), cfg.c, 0, T - 1);
    const dnHold = runSign(S, demean(S, 0, split), cfg.c, split, T - 1); // demean fit in-sample
    const dnHoldRaw = runSign(S, S.fwdRet, cfg.c, split, T - 1);
    console.log(
      `  ${a.padEnd(5)} full demean Sh=${annSharpe(sharpeDaily(dnFull)).toFixed(2).padStart(6)}  holdout demean Sh=${annSharpe(sharpeDaily(dnHold)).toFixed(2).padStart(6)}  holdout raw Sh=${annSharpe(sharpeDaily(dnHoldRaw)).toFixed(2).padStart(6)}`,
    );
  }
}

console.log("\n=== (2) POOLED panel (equal-weight all assets), demeaned per-asset, calendar-reanchor null ===");
// Build aligned-by-calendar pooled demeaned return: for each date, average available demeaned fwdRet.
// Then apply the BTC config and calendar-reanchor the pooled series.
type Row = { wd: number; vals: number[] };
const byDate = new Map<string, Row>();
for (const a of ASSETS) {
  const S = loadDaily(a);
  const T = S.close.length;
  const dm = demean(S, 0, T - 1);
  for (let t = 0; t < T - 1; t++) {
    if (!Number.isFinite(dm[t])) continue;
    const d = S.dates[t];
    if (!byDate.has(d)) byDate.set(d, { wd: S.weekday[t], vals: [] });
    byDate.get(d)!.vals.push(dm[t]);
  }
}
const dates = [...byDate.keys()].sort();
const wd = dates.map((d) => byDate.get(d)!.wd);
const pooled = dates.map((d) => mean(byDate.get(d)!.vals)); // equal-weight cross-asset demeaned ret
const n = pooled.length;

function applyCfgPooled(cfg: number[], ret: number[], wdLbl: number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let t = 0; t < ret.length; t++) {
    const pos = cfg[wdLbl[t]];
    out.push(pos * ret[t] - Math.abs(pos - prev) * COST);
    prev = pos;
  }
  return out;
}
function rotate(arr: number[], shift: number): number[] {
  const m = arr.length;
  const sh = ((shift % m) + m) % m;
  return arr.map((_, k) => arr[(k + sh) % m]);
}
for (const cfg of [
  { name: "+Sun,+Tue,-Wed", c: CFG_3SIGN },
  { name: "-Wed only", c: CFG_WED },
]) {
  const dn = applyCfgPooled(cfg.c, pooled, wd);
  const real = annSharpe(sharpeDaily(dn));
  const nSurr = 2000;
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(13000 + i * 7919);
    const shift = 1 + Math.floor(rng() * (n - 2));
    const rot = rotate(pooled, shift);
    surr.push(annSharpe(sharpeDaily(applyCfgPooled(cfg.c, rot, wd))));
  }
  surr.sort((a, b) => a - b);
  const p = (surr.filter((s) => s >= real).length + 1) / (nSurr + 1);
  console.log(
    `  pooled ${cfg.name.padEnd(16)} n=${n} realSh=${real.toFixed(3)} calendar-reanchor p=${p.toFixed(4)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)} surr99=${surr[Math.floor(nSurr * 0.99)].toFixed(3)}`,
  );
}
