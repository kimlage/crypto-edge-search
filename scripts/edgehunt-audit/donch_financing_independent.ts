/**
 * INDEPENDENT AUDIT CROSS-CHECK of the D1-LS-DONCH financing concern.
 *
 * Rebuilds the best config (N=20,zscore,dir=HIGH) FROM SCRATCH (not importing the
 * requeue harness weight code) and re-derives:
 *   (a) the no-borrow IS/holdout net Sharpe — must match harness 1.690 / 0.530 to
 *       prove the replication is faithful;
 *   (b) the daily notional profile (mean/min/max short notional and gross) to confirm
 *       the book really holds ~1.0x short continuously (the borrow base);
 *   (c) financing sensitivity under TWO charge conventions:
 *         - SHORT-leg only  (cash-equity dollar-neutral: pay coin-borrow on shorts)  <- audit's base
 *         - GROSS notional  (levered perp book at 2x: pay funding on BOTH legs)       <- upper bound
 *       This brackets the audit's single-convention number.
 *   (d) the holdout breakeven borrow rate (where consume-once holdout Sharpe crosses 0).
 *
 * Writes ONLY to output/edgehunt-audit/.
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

// Donchian channel position, N=20
const N = 20;
const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let s = 0; s < S; s++) for (let t = N; t < T; t++) {
  let mn = Infinity, mx = -Infinity, ok = true;
  for (let k = t - N + 1; k <= t; k++) { const v = px[k][s]; if (!(v > 0)) { ok = false; break; } if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!ok || mx - mn < 1e-12) continue; cp[t][s] = (px[t][s] - mn) / (mx - mn);
}
// zscore dollar-neutral, dir=HIGH, gross-2x  (independent reimplementation)
const W: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
for (let t = 0; t < T; t++) {
  const idx: number[] = [], vals: number[] = [];
  for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) { idx.push(s); vals.push(cp[t][s]); }
  if (idx.length < 6) continue;
  const m = mean(vals), sd = std(vals) || 1; const z = vals.map((x) => (x - m) / sd);
  const aS = z.reduce((a, x) => a + Math.abs(x), 0) || 1; idx.forEach((s, i) => { W[t][s] = (z[i] / aS) * 2; });
}
const firstTradable = 250; const tradableEnd = T - 1; const holdoutFrac = 0.2;
const splitIdx = firstTradable + Math.floor((tradableEnd - firstTradable) * (1 - holdoutFrac));

// charge convention: "short" -> borrow*shortNotional ; "gross" -> borrow*grossNotional
function port(lo: number, hi: number, borrowAnn: number, base: "short" | "gross") {
  const net: number[] = []; let prev = new Array(S).fill(0);
  const day = borrowAnn / 365;
  const shortNots: number[] = []; const grosses: number[] = [];
  for (let t = lo; t < hi; t++) {
    let g = 0, turn = 0, shortNot = 0, gross = 0, any = false;
    for (let s = 0; s < S; s++) {
      const p = W[t][s]; turn += Math.abs(p - prev[s]); gross += Math.abs(p);
      if (p < 0) shortNot += -p;
      if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; any = true; }
    }
    if (!any) continue;
    const fin = (base === "short" ? shortNot : gross) * day;
    net.push(g - turn * COST - fin); shortNots.push(shortNot); grosses.push(gross);
    prev = W[t].slice();
  }
  return { net, shortNots, grosses };
}

const baseIS = port(firstTradable, splitIdx, 0, "short");
const sn = baseIS.shortNots, gr = baseIS.grosses;
const profile = {
  meanShort: mean(sn), minShort: Math.min(...sn), maxShort: Math.max(...sn),
  meanGross: mean(gr), minGross: Math.min(...gr), maxGross: Math.max(...gr),
};

const rates = [0, 0.05, 0.10, 0.20, 0.30, 0.50];
const rows = rates.map((r) => {
  const isS = port(firstTradable, splitIdx, r, "short"); const hoS = port(splitIdx, tradableEnd, r, "short");
  const isG = port(firstTradable, splitIdx, r, "gross"); const hoG = port(splitIdx, tradableEnd, r, "gross");
  return {
    borrowAnn: r,
    isSharpe_shortBase: annSharpe(sharpeDaily(isS.net)),
    holdoutSharpe_shortBase: annSharpe(sharpeDaily(hoS.net)),
    isSharpe_grossBase: annSharpe(sharpeDaily(isG.net)),
    holdoutSharpe_grossBase: annSharpe(sharpeDaily(hoG.net)),
  };
});

// holdout breakeven borrow (short base): bisect
function holdoutSharpeAt(r: number, base: "short" | "gross") { return annSharpe(sharpeDaily(port(splitIdx, tradableEnd, r, base).net)); }
function breakeven(base: "short" | "gross") {
  let lo = 0, hi = 1.0; if (holdoutSharpeAt(lo, base) <= 0) return 0; if (holdoutSharpeAt(hi, base) > 0) return hi;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (holdoutSharpeAt(mid, base) > 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const breakevenShort = breakeven("short");
const breakevenGross = breakeven("gross");

const out = {
  config: "N=20,zscore,dir=HIGH,gross-2x (independent reimplementation)",
  noBorrowCheck: { isSharpe: rows[0].isSharpe_shortBase, holdoutSharpe: rows[0].holdoutSharpe_shortBase, harnessExpected: { is: 1.690, holdout: 0.530 } },
  notionalProfile: profile,
  rows,
  holdoutBreakevenBorrowAnn: { shortBase: breakevenShort, grossBase: breakevenGross },
};
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/donch_financing_independent.json`, JSON.stringify(out, null, 2));
