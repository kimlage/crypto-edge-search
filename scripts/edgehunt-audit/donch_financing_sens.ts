/**
 * AUDIT SPOT-RUN: financing/borrow sensitivity for the D1-LS-DONCH PROMISING.
 * Replicates the exact best config (N=20, zscore, dir=HIGH, gross-2x dollar-neutral),
 * then re-charges PnL with a per-day borrow on the SHORT-leg notional (the leg you must
 * borrow coins/pay perp funding to hold) at several realistic annual borrow rates.
 * Question the STANDARD demands: does charging financing on the levered/short notional
 * change the IS net Sharpe and (decisively) the consume-once holdout?
 *
 * Reuses the requeue harness math verbatim; writes ONLY to output/edgehunt-audit/.
 */
import fs from "node:fs";
const ROOT = ".";
const ANN = Math.sqrt(365);
const COST = 0.0004;
type Closes = { dates: string[]; closes: Record<string, number[]> };
const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8")) as Closes;
const dates = raw.dates; const syms = Object.keys(raw.closes); const T = dates.length; const S = syms.length;
const px: number[][] = Array.from({ length: T }, (_, t) => syms.map((s) => raw.closes[s][t]));
const fwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 0; t < T - 1; t++) for (let s = 0; s < S; s++) { const a = px[t][s], b = px[t + 1][s]; if (a > 0 && b > 0) fwd[t][s] = Math.log(b / a); }
function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1))); }
function sharpeDaily(a: number[]) { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }
function annSharpe(d: number) { return d * ANN; }
function channelPos(N: number): number[][] {
  const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let s = 0; s < S; s++) for (let t = N; t < T; t++) {
    let mn = Infinity, mx = -Infinity, ok = true;
    for (let k = t - N + 1; k <= t; k++) { const v = px[k][s]; if (!(v > 0)) { ok = false; break; } if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!ok || mx - mn < 1e-12) continue; cp[t][s] = (px[t][s] - mn) / (mx - mn);
  }
  return cp;
}
// best config: N=20 zscore dir=HIGH
const N = 20; const cp = channelPos(N);
const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
for (let t = 0; t < T; t++) {
  const idx: number[] = [], vals: number[] = [];
  for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) { idx.push(s); vals.push(cp[t][s]); }
  const n = idx.length; if (n < 6) continue;
  const m = mean(vals), sd = std(vals) || 1; const z = vals.map((x) => (x - m) / sd);
  const aS = z.reduce((s, x) => s + Math.abs(x), 0) || 1; idx.forEach((s, i) => { W[t][s] = (z[i] / aS) * 2; });
}
const firstTradable = 250; const tradableEnd = T - 1; const holdoutFrac = 0.2;
const splitIdx = firstTradable + Math.floor((tradableEnd - firstTradable) * (1 - holdoutFrac));

// per-day series with cost AND optional short-leg borrow at annual rate `borrowAnn`
function port(lo: number, hi: number, borrowAnn: number) {
  const net: number[] = []; let prev = new Array(S).fill(0); let shortNotSum = 0, grossSum = 0, cnt = 0;
  const dayBorrow = borrowAnn / 365;
  for (let t = lo; t < hi; t++) {
    let g = 0, turn = 0, shortNot = 0, gross = 0, any = false;
    for (let s = 0; s < S; s++) {
      const p = W[t][s]; turn += Math.abs(p - prev[s]); gross += Math.abs(p);
      if (p < 0) shortNot += -p;
      if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; any = true; }
    }
    if (!any) continue;
    // borrow charged on the short notional held that day (coins borrowed to short)
    const fin = shortNot * dayBorrow;
    net.push(g - turn * COST - fin); shortNotSum += shortNot; grossSum += gross; cnt++;
    prev = W[t].slice();
  }
  return { net, meanShortNot: cnt ? shortNotSum / cnt : 0, meanGross: cnt ? grossSum / cnt : 0 };
}

const rates = [0, 0.05, 0.10, 0.20, 0.30];
console.log(`D1-LS-DONCH financing sensitivity (N=20 zscore HIGH, gross-2x dollar-neutral)`);
const base = port(firstTradable, splitIdx, 0);
console.log(`mean short-notional/day=${base.meanShortNot.toFixed(3)} (=1.0 means 1x short leg); mean gross=${base.meanGross.toFixed(3)}`);
console.log(`borrowAnn |  IS netSharpe  |  holdout netSharpe`);
const rows: any[] = [];
for (const r of rates) {
  const is = port(firstTradable, splitIdx, r); const ho = port(splitIdx, tradableEnd, r);
  const isSh = annSharpe(sharpeDaily(is.net)); const hoSh = annSharpe(sharpeDaily(ho.net));
  console.log(`  ${(r * 100).toFixed(0).padStart(3)}%    |    ${isSh.toFixed(3).padStart(6)}     |    ${hoSh.toFixed(3).padStart(6)}`);
  rows.push({ borrowAnn: r, isNetSharpe: isSh, holdoutNetSharpe: hoSh });
}
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/donch_financing_sens.json`, JSON.stringify({ config: "N=20,zscore,HIGH,gross-2x", meanShortNotional: base.meanShortNot, meanGross: base.meanGross, rows }, null, 2));
