/**
 * O3-NVTS AUDIT — honest-N Deflated Sharpe at the FULL searched grid + financing on the short leg.
 *
 * (2) HONEST-N: the win (kind=fee,sma=30,zWin=730,band,zHi=1.5,zLo=-0.5) is the ARGMAX of the BROAD
 *     N=312 grid. The honest trial count for that argmax is therefore 312 (the search that produced
 *     it), NOT the 54 fee-only carve-out applied AFTER seeing the broad result. We report DSR @ both,
 *     plus a Harvey-Liu Bonferroni haircut @ N=312.
 * (3) FINANCING: the band rule shorts the overvalued leg (pos=-1). A real short pays borrow on the
 *     full short notional. We recompute net Sharpe charging an annual borrow on |negative position|
 *     exposure (BTC spot borrow ~ a few % to >10% annualized; we sweep 3% / 6% / 10%).
 */
import {
  computeDeflatedSharpeRatio,
} from "../../src/lib/training/statistical-validation.ts";
import { loadNvtPanel, throughput, type NvtPanel } from "../edgehunt-onchain2/load_nvt.ts";

const LAG = 1; const COST = 0.0004; const ANN = Math.sqrt(365);
const START_IDX = 800; const HOLDOUT_FRAC = 0.2;

function sma(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; let s = 0, ok = true; for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; } if (ok) out[i] = s / win; } return out; }
function rollingZ(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { const lo = Math.max(0, i - win + 1); const w: number[] = []; for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length < 60) continue; const m = w.reduce((s, v) => s + v, 0) / w.length; const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1)); out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0; } return out; }
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }
function nvtsZ(P: NvtPanel, kind: string, smaWin: number, zWin: number): number[] { const thrSm = sma(throughput(P, kind), smaWin); const nv = P.marketCap.map((mc, t) => (mc > 0 && thrSm[t] > 0 ? mc / thrSm[t] : NaN)); return rollingZ(nv, zWin); }
function positionFrom(zL: number[], rule: string, zHi: number, zLo: number): number[] { const T = zL.length; const pos = new Array(T).fill(NaN); for (let t = 0; t < T; t++) { const z = zL[t]; if (!Number.isFinite(z)) { pos[t] = NaN; continue; } if (rule === "band") pos[t] = z > zHi ? -1 : z < zLo ? 1 : 0; } return pos; }

const P = loadNvtPanel("btc");
const T = P.price.length; const tradableEnd = T - 1; const span = tradableEnd - START_IDX;
const splitIdx = START_IDX + Math.floor(span * (1 - HOLDOUT_FRAC));

// winning config
const zL = lag(nvtsZ(P, "fee", 30, 730), LAG);
const pos = positionFrom(zL, "band", 1.5, -0.5);

// in-sample daily net returns with optional annual borrow on short notional
function dailyNet(borrowAnnual: number): number[] {
  const borrowDaily = borrowAnnual / 365;
  const r: number[] = []; let prev = 0;
  for (let t = START_IDX; t < splitIdx; t++) {
    const fr = P.fwdRet[t]; const p = pos[t];
    if (!Number.isFinite(fr) || !Number.isFinite(p)) continue;
    const turnCost = Math.abs(p - prev) * COST;
    const borrow = p < 0 ? Math.abs(p) * borrowDaily : 0; // borrow on short notional
    r.push(p * fr - turnCost - borrow); prev = p;
  }
  return r;
}
function annSharpe(r: number[]): number { const m = r.reduce((a, b) => a + b, 0) / r.length; const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)); return (m / sd) * ANN; }

// fraction of days in a short
let shortDays = 0, total = 0;
for (let t = START_IDX; t < splitIdx; t++) { const p = pos[t]; if (Number.isFinite(p) && Number.isFinite(P.fwdRet[t])) { total++; if (p < 0) shortDays++; } }

const base = dailyNet(0);
console.log(`O3-NVTS winning cfg (fee,sma=30,zWin=730,band,1.5,-0.5) — short days = ${shortDays}/${total} = ${(shortDays/total*100).toFixed(1)}%`);
console.log(`\n--- (2) honest-N Deflated Sharpe (in-sample daily net, no borrow) ---`);
for (const N of [54, 312]) {
  const d = computeDeflatedSharpeRatio(base, { trialCount: N });
  console.log(`  DSR @N=${N}: deflatedProb=${d.deflatedProbability.toFixed(4)}  ${d.deflatedProbability > 0.95 ? "PASS" : "FAIL"}  (expMaxSh=${d.expectedMaxSharpe.toFixed(4)}, rawSh=${d.sharpe.toFixed(4)})`);
}

console.log(`\n--- (3) financing: net Sharpe with annual borrow on short notional ---`);
console.log(`  borrow=0%   netSharpe=${annSharpe(dailyNet(0)).toFixed(4)}`);
for (const b of [0.03, 0.06, 0.10, 0.20]) {
  const r = dailyNet(b);
  const d312 = computeDeflatedSharpeRatio(r, { trialCount: 312 });
  console.log(`  borrow=${(b*100).toFixed(0).padStart(2)}%  netSharpe=${annSharpe(r).toFixed(4)}  DSR@312=${d312.deflatedProbability.toFixed(4)}`);
}
