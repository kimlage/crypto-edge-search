/**
 * Diagnostic: is there ANY exploitable cross-sectional residual structure at the weekly horizon,
 * and in which direction? We compute, per rebalance, the cross-sectional rank correlation
 * (Spearman) between the signal (cumulative residual over lookback) and the FORWARD residual
 * return over the hold window. Negative mean rank-IC => reversal (losers outperform); positive =>
 * momentum (winners continue). Also break down by lookback and hold horizon.
 *
 * This is the honest "is there signal at all" check, independent of leg construction / cost.
 */
import { loadDailyPanel, rebalanceDays, mean, std } from "./lib_strev.ts";

const panel = loadDailyPanel();
const btc = panel.btcIdx;

function olsBeta(y: number[], x: number[]): number {
  const n = y.length; if (n < 5) return 0;
  let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n; let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx; cov += dx * (y[i] - my); vx += dx * dx; }
  return vx > 1e-12 ? cov / vx : 0;
}
function rank(a: number[]): number[] {
  const idx = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i;
  return r;
}
function spearman(x: number[], y: number[]): number {
  const rx = rank(x), ry = rank(y); const n = x.length;
  const mx = (n - 1) / 2;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = rx[i] - mx, dy = ry[i] - mx; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

const HOLD = 7, WARMUP = 200, BETAWIN = 60;
const rebal = rebalanceDays(panel, HOLD, WARMUP);

// signal lookback (weeks) x forward hold (days)
const lookbacks = [1, 2, 4];        // weeks
const horizons = [3, 7, 14];        // forward days
const skips = [false, true];

console.log("Cross-sectional rank-IC: corr(signal=cum-resid over lookback, fwd-resid over horizon)");
console.log("(IC<0 => reversal; IC>0 => momentum). Reported: mean IC, t-stat, n weeks, frac IC<0\n");

for (const skip of skips) {
  for (const Lw of lookbacks) {
    for (const Hd of horizons) {
      const ics: number[] = [];
      const sigDays = Lw * HOLD;
      for (const t of rebal) {
        const sigLo = t - sigDays - (skip ? 1 : 0) + 1;
        const sigHi = t - (skip ? 1 : 0);
        const betaLo = t - BETAWIN + 1;
        const fwdLo = t + 1, fwdHi = t + Hd;
        if (sigLo < 1 || betaLo < 1 || fwdHi > panel.dates.length - 1) continue;
        const btcWin: number[] = []; for (let d = betaLo; d <= t; d++) btcWin.push(panel.logret[d][btc]);
        const sig: number[] = [], fwd: number[] = [];
        for (let a = 0; a < panel.assets.length; a++) {
          if (a === btc) continue;
          let ok = true;
          for (let d = Math.min(sigLo, betaLo); d <= fwdHi; d++) { if (!panel.present[d][a] || !panel.present[d][btc]) { ok = false; break; } }
          if (!ok) continue;
          const yWin: number[] = []; for (let d = betaLo; d <= t; d++) yWin.push(panel.logret[d][a]);
          const beta = olsBeta(yWin, btcWin);
          let cs = 0; for (let d = sigLo; d <= sigHi; d++) cs += panel.logret[d][a] - beta * panel.logret[d][btc];
          let cf = 0; for (let d = fwdLo; d <= fwdHi; d++) cf += panel.logret[d][a] - beta * panel.logret[d][btc];
          sig.push(cs); fwd.push(cf);
        }
        if (sig.length >= 6) ics.push(spearman(sig, fwd));
      }
      const m = mean(ics), s = std(ics), n = ics.length;
      const tstat = s > 0 ? m / (s / Math.sqrt(n)) : 0;
      const fracNeg = ics.filter(v => v < 0).length / n;
      console.log(`  skip=${skip?1:0} L=${Lw}w H=${Hd}d : meanIC=${m.toFixed(4)} t=${tstat.toFixed(2)} n=${n} fracNeg=${fracNeg.toFixed(2)}`);
    }
  }
}
