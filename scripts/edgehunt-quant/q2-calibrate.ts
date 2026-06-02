/** Inspect BOCPD output statistics to calibrate the change-point TRIGGER properly.
 * The genuine BOCPD break signal is a COLLAPSE of expected/MAP run length, not cpProb crossing. */
import { loadBtc } from "./data.ts";
import { runBocpd, type BocpdParams } from "./bocpd-core.ts";

function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = a.reduce((s, v) => s + v, 0) / n; return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function rstd(x: number[], win: number) { const o = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; const w: number[] = []; for (let k = i - win + 1; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length >= 10) o[i] = std(w); } return o; }
function standardize(ret: number[], vw: number) { const rs = rstd(ret, vw); const o = new Array(ret.length).fill(0); for (let i = 0; i < ret.length; i++) { const v = rs[i]; o[i] = Number.isFinite(ret[i]) && Number.isFinite(v) && v > 1e-9 ? ret[i] / v : 0; } return o; }
function pct(a: number[], q: number) { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * q)]; }

const bars = loadBtc(96); // daily
const sret = standardize(bars.ret, 30);
for (const lambda of [50, 150, 400]) {
  const p: BocpdParams = { hazardLambda: lambda, mu0: 0, kappa0: 1, alpha0: 1, beta0: 0.5, maxRunLength: 600 };
  const steps = runBocpd(sret, p).slice(300);
  const cp = steps.map((s) => s.cpProb);
  const er = steps.map((s) => s.expRunLength);
  console.log(`lambda=${lambda}: cpProb p50=${pct(cp, 0.5).toFixed(4)} p90=${pct(cp, 0.9).toFixed(4)} p99=${pct(cp, 0.99).toFixed(4)} max=${Math.max(...cp).toFixed(4)}`);
  console.log(`           expRun p50=${pct(er, 0.5).toFixed(1)} p10=${pct(er, 0.1).toFixed(1)} min=${Math.min(...er).toFixed(1)} max=${Math.max(...er).toFixed(1)}`);
  // run-length collapse events: expRun drops below 0.5*its 60-bar trailing max
  let collapses = 0;
  for (let i = 60; i < er.length; i++) { let mx = 0; for (let k = i - 60; k < i; k++) mx = Math.max(mx, er[k]); if (er[i] < 0.4 * mx && mx > 10) collapses++; }
  console.log(`           run-length-collapse events (er<0.4*trailmax)=${collapses}`);
}
