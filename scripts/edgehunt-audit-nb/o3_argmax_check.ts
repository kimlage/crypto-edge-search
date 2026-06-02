/**
 * O3-NVTS AUDIT — is the N=54 restriction a frozen mechanism or a post-hoc carve-out riding an argmax?
 *
 * Stated a-priori / "Kalichkin-standard" mechanism in the scripts:
 *   - load_nvt.ts:           "Kalichkin NVTS = 90d MA of throughput"
 *   - run_nvts.ts canonical: { kind:fee, sma:90, zWin:365, rule:avoidHigh/band }
 *   - strengthen_nvts.ts canonical: { sma:90, zWin:365 }
 * The WINNING config is { kind:fee, sma:30, zWin:730, rule:band, zHi:1.5, zLo:-0.5 } — the grid CORNER
 * (shortest sma, longest zWin) FARTHEST from the stated mechanism. We print the in-sample net Sharpe
 * of every fee-band config so the reader can see whether the win is a frozen mechanism or the argmax
 * of a searched neighborhood (i.e. how much Sharpe collapses at the actually-pre-registered 90/365).
 */
import { loadNvtPanel, throughput, type NvtPanel } from "../edgehunt-onchain2/load_nvt.ts";

const LAG = 1; const COST = 0.0004; const ANN = Math.sqrt(365);
const START_IDX = 800; const HOLDOUT_FRAC = 0.2;
function sma(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; let s = 0, ok = true; for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; } if (ok) out[i] = s / win; } return out; }
function rollingZ(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { const lo = Math.max(0, i - win + 1); const w: number[] = []; for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length < 60) continue; const m = w.reduce((s, v) => s + v, 0) / w.length; const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1)); out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0; } return out; }
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }
function nvtsZ(P: NvtPanel, smaWin: number, zWin: number): number[] { const thrSm = sma(throughput(P, "fee"), smaWin); const nv = P.marketCap.map((mc, t) => (mc > 0 && thrSm[t] > 0 ? mc / thrSm[t] : NaN)); return rollingZ(nv, zWin); }
function positionFrom(zL: number[], rule: string, zHi: number, zLo: number): number[] { const T = zL.length; const pos = new Array(T).fill(NaN); for (let t = 0; t < T; t++) { const z = zL[t]; if (!Number.isFinite(z)) { pos[t] = NaN; continue; } if (rule === "band") pos[t] = z > zHi ? -1 : z < zLo ? 1 : 0; else if (rule === "shortHigh") pos[t] = z > zHi ? -1 : 0; } return pos; }

const P = loadNvtPanel("btc");
const T = P.price.length; const splitIdx = START_IDX + Math.floor((T - 1 - START_IDX) * (1 - HOLDOUT_FRAC));
function ish(pos: number[]): number { const r: number[] = []; let prev = 0; for (let t = START_IDX; t < splitIdx; t++) { const fr = P.fwdRet[t]; const p = pos[t]; if (!Number.isFinite(fr) || !Number.isFinite(p)) continue; r.push(p * fr - Math.abs(p - prev) * COST); prev = p; } const m = r.reduce((a, b) => a + b, 0) / r.length; const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)); return (m / sd) * ANN; }

console.log("fee-band in-sample net Sharpe by (sma,zWin) at zHi=1.5,zLo=-0.5:");
for (const s of [30, 60, 90]) { let line = `  sma=${s}: `; for (const w of [365, 730]) { const zL = lag(nvtsZ(P, s, w), LAG); const sh = ish(positionFrom(zL, "band", 1.5, -0.5)); line += `zWin=${w}->${sh.toFixed(3)}  `; } console.log(line); }
console.log("\nKey configs:");
const W = lag(nvtsZ(P, 30, 730), LAG); console.log(`  WINNER  sma=30,zWin=730 band 1.5/-0.5 = ${ish(positionFrom(W, "band", 1.5, -0.5)).toFixed(3)}`);
const C = lag(nvtsZ(P, 90, 365), LAG);
console.log(`  STATED MECHANISM sma=90,zWin=365 band 1.5/-0.5 = ${ish(positionFrom(C, "band", 1.5, -0.5)).toFixed(3)}`);
console.log(`  STATED MECHANISM sma=90,zWin=365 avoidHigh-equivalent shortHigh 1.5 = ${ish(positionFrom(C, "shortHigh", 1.5, 0)).toFixed(3)}`);
