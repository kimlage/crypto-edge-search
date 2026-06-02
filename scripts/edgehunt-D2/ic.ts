/**
 * D2-CVD divergence — CORE PREDICTIVE-CONTENT diagnostic (IC), the cleanest
 * possible test of the belief, independent of position-sizing choices.
 *
 * Information Coefficient = Spearman corr between the strictly-LAGGED divergence
 * score at bar j and the FUTURE return over bar (j+lag-1)->(j+lag). If the belief
 * is true, lagged divergence (CVD rising while price flat/down) should positively
 * correlate with future return. We test:
 *   - score = z(CVD-slope) - z(price-slope)   [literal divergence]
 *   - score = z(residual of CVD-slope on price-slope)  [residual divergence]
 * at lags h=1,2,3,5 on all 4 symbols, plus the h=0 (circular) reference.
 *
 * RIGHT NULL: block-bootstrap the signed-flow stream (block=10) re-paired with the
 * SAME realized returns; recompute the IC on each surrogate. p = P(|IC_null| >= |IC_obs|)
 * (two-sided) and P(IC_null >= IC_obs) (one-sided in the believed direction).
 */
import { loadDaily, simpleret, signedFlow, rng, blockResampleIndices } from "./lib.ts";

function zscore(x: number[], w: number): number[] {
  const out: number[] = new Array(x.length).fill(0);
  for (let i = 0; i < x.length; i += 1) {
    const lo = Math.max(0, i - w + 1);
    const win = x.slice(lo, i + 1);
    const m = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, win.length - 1));
    out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0;
  }
  return out;
}
function rank(x: number[]): number[] {
  const idx = x.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(x.length).fill(0);
  for (let k = 0; k < idx.length; k += 1) r[idx[k][1]] = k;
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = rank(a), rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i += 1) { cov += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

function divScores(flow: number[], close: number[], slopeWin: number, zWin: number): { lit: number[]; res: number[] } {
  const cvd: number[] = new Array(flow.length).fill(0);
  for (let i = 1; i < flow.length; i += 1) cvd[i] = cvd[i - 1] + flow[i];
  const cs = cvd.map((v, i) => (i >= slopeWin ? v - cvd[i - slopeWin] : 0));
  const lc = close.map((c) => Math.log(c));
  const ps = lc.map((v, i) => (i >= slopeWin ? v - lc[i - slopeWin] : 0));
  const cz = zscore(cs, zWin), pz = zscore(ps, zWin);
  const lit = cz.map((v, i) => v - pz[i]);
  // residual of CVD-slope on price-slope (rolling OLS over zWin)
  const res: number[] = new Array(flow.length).fill(0);
  for (let i = 0; i < flow.length; i += 1) {
    const lo = Math.max(0, i - zWin + 1);
    let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
    for (let j = lo; j <= i; j += 1) { sx += ps[j]; sy += cs[j]; sxx += ps[j] * ps[j]; sxy += ps[j] * cs[j]; k += 1; }
    const den = k * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) { res[i] = 0; continue; }
    const b = (k * sxy - sx * sy) / den; const a = (sy - b * sx) / k;
    res[i] = cs[i] - (a + b * ps[i]);
  }
  return { lit, res: zscore(res, zWin) };
}

const SYMS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
const slopeWin = 7, zWin = 60;
const lags = [0, 1, 2, 3, 5];

console.log("=== D2-CVD divergence: Information Coefficient (lagged predictive content) ===");
console.log(`slopeWin=${slopeWin} zWin=${zWin}; IC = Spearman(score_j, future ret over bar j+lag)`);
console.log("(h=0 is the circular reference; only h>=1 is honest edge)\n");

for (const sym of SYMS) {
  const bars = loadDaily(sym);
  const rets = simpleret(bars); // rets[i] = bar i->i+1
  const flow = signedFlow(bars);
  const close = bars.map((b) => b.c);
  const { lit, res } = divScores(flow, close, slopeWin, zWin);
  const rows: string[] = [];
  for (const lag of lags) {
    // align: score at bar j predicts return realized over bar (j+lag)->(j+lag+1) = rets[j+lag]
    for (const [name, score] of [["lit", lit], ["res", res]] as [string, number[]][]) {
      const xs: number[] = [], ys: number[] = [];
      for (let j = zWin; j < rets.length - lag - 1; j += 1) {
        xs.push(score[j]); ys.push(rets[j + lag]);
      }
      const ic = spearman(xs, ys);
      // surrogate null only for the headline h=1 residual (cheaper); compute for all but light
      let p = NaN;
      if (lag >= 1) {
        const SUR = 400;
        let ge = 0;
        for (let s = 0; s < SUR; s += 1) {
          const rand = rng(55000 + s + lag * 1000 + (name === "res" ? 500000 : 0));
          const idx = blockResampleIndices(flow.length, 10, rand);
          const flowS = idx.map((k) => flow[k]);
          const sc = divScores(flowS, close, slopeWin, zWin);
          const scoreS = name === "lit" ? sc.lit : sc.res;
          const xs2: number[] = [], ys2: number[] = [];
          for (let j = zWin; j < rets.length - lag - 1; j += 1) { xs2.push(scoreS[j]); ys2.push(rets[j + lag]); }
          const icS = spearman(xs2, ys2);
          if (icS >= ic) ge += 1; // one-sided in believed (positive) direction
        }
        p = (ge + 1) / (SUR + 1);
      }
      rows.push(`  h=${lag} ${name}: IC=${ic >= 0 ? "+" : ""}${ic.toFixed(4)}${Number.isFinite(p) ? `  surP=${p.toFixed(3)}` : "  (circular)"}`);
    }
  }
  console.log(`${sym}:`);
  for (const r of rows) console.log(r);
  console.log("");
}
