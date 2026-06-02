/**
 * AUDIT (D1-06) — is the deflated-Sharpe-vs-RSI gate (the report's bindingGate, p=0.0087) a FAIR null
 * for a "CCI beats the killed RSI book" claim, or is it TOO STRICT?
 *
 * The committed gate sets benchmarkSharpe = RSI daily Sharpe AND subtracts the full N=128 selection
 * haircut on top: expectedMax = RSI + SE*E[max(128)]. So it demands CCI beat RSI by an entire
 * multiple-testing margin. Meanwhile the paired excessVsRSI bootstrap CI is entirely > 0.
 *
 * This script reproduces, side by side:
 *  (1) the committed deflatedSharpeVsRSI probability (over-strict gate)  -> should be ~0.0087 FAIL
 *  (2) a deflated-Sharpe of the PAIRED EXCESS series (CCI net - RSI net) at honest N -> the honest
 *      "does CCI's edge OVER RSI survive multiple testing?" test (benchmark 0 on the excess series)
 *  (3) the paired excess block-bootstrap CI (committed excessVsRSI) -> entirely > 0 = reliably beats
 *  (4) a paired t-stat on daily excess.
 * If (1) FAILs but (2)/(3)/(4) PASS, the binding gate is the wrong/over-strict null and CCI does, on
 * the honest paired test, beat RSI -> the CCI KILL does NOT rest on a sound benchmark gate either.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004;
const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"];
interface Bar { date: string; open: number; high: number; low: number; close: number; }
function loadSymbol(sym: string): Bar[] { const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`, "utf8")) as Bar[]; return raw.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0); }
const perSym: Record<string, Bar[]> = {}; for (const s of SYMBOLS) perSym[s] = loadSymbol(s);
const DATES = Array.from(new Set(SYMBOLS.flatMap((s) => perSym[s].map((b) => b.date)))).sort();
const T = DATES.length; const dateIdx = new Map(DATES.map((d, i) => [d, i]));
const barAt: Record<string, (Bar | null)[]> = {}; for (const s of SYMBOLS) { const a: (Bar | null)[] = Array<Bar | null>(T).fill(null); for (const b of perSym[s]) { const i = dateIdx.get(b.date); if (i != null) a[i] = b; } barAt[s] = a; }
const logret: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { const r: (number | null)[] = Array<number | null>(T).fill(null); for (let t = 1; t < T; t++) { const a = barAt[s][t - 1], b = barAt[s][t]; if (a && b) r[t] = Math.log(b.close / a.close); } logret[s] = r; }
function mean(a: number[]) { return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); }
const VOL_CAP = 3;
type Mode = "trend" | "revert"; type Side = "longflat" | "longshort";
function cciSeries(bars: (Bar | null)[], period: number): (number | null)[] { const n = bars.length; const out: (number | null)[] = Array<number | null>(n).fill(null); const w: number[] = []; for (let t = 0; t < n; t++) { const b = bars[t]; if (!b) { out[t] = null; continue; } const tp = (b.high + b.low + b.close) / 3; w.push(tp); if (w.length > period) w.shift(); if (w.length < period) { out[t] = null; continue; } const sma = w.reduce((a, x) => a + x, 0) / period; let mad = 0; for (const x of w) mad += Math.abs(x - sma); mad /= period; if (mad < 1e-12) { out[t] = 0; continue; } out[t] = (tp - sma) / (0.015 * mad); } return out; }
function rsiSeries(bars: (Bar | null)[], period: number): (number | null)[] { const n = bars.length; const out: (number | null)[] = Array<number | null>(n).fill(null); let avgGain = NaN, avgLoss = NaN, prevClose = NaN, warm = 0; for (let t = 0; t < n; t++) { const b = bars[t]; if (!b) { out[t] = null; continue; } if (!Number.isFinite(prevClose)) { prevClose = b.close; out[t] = null; continue; } const ch = b.close - prevClose; const gain = Math.max(0, ch); const loss = Math.max(0, -ch); if (!Number.isFinite(avgGain)) { avgGain = gain; avgLoss = loss; } else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; } prevClose = b.close; warm++; if (warm < period) { out[t] = null; continue; } const rs = avgLoss < 1e-12 ? 100 : avgGain / avgLoss; out[t] = 100 - 100 / (1 + rs); } return out; }
function cciSignal(cci: (number | null)[], thr: number, mode: Mode, side: Side): (number | null)[] { const n = cci.length; const out: (number | null)[] = Array<number | null>(n).fill(null); let pos = 0; for (let t = 0; t < n; t++) { const v = cci[t]; if (v == null) { out[t] = null; continue; } let d = pos; if (mode === "trend") { if (v > thr) d = 1; else if (v < -thr) d = -1; else if (pos === 1 && v < 0) d = 0; else if (pos === -1 && v > 0) d = 0; } else { if (v < -thr) d = 1; else if (v > thr) d = -1; else if (pos === 1 && v > 0) d = 0; else if (pos === -1 && v < 0) d = 0; } if (d < 0 && side === "longflat") d = 0; pos = d; out[t] = pos; } return out; }
function rsiSignal(rsi: (number | null)[], lo: number, hi: number, mode: Mode, side: Side): (number | null)[] { const n = rsi.length; const out: (number | null)[] = Array<number | null>(n).fill(null); let pos = 0; for (let t = 0; t < n; t++) { const v = rsi[t]; if (v == null) { out[t] = null; continue; } let d = pos; if (mode === "trend") { if (v > hi) d = 1; else if (v < lo) d = -1; else if (pos === 1 && v < 50) d = 0; else if (pos === -1 && v > 50) d = 0; } else { if (v < lo) d = 1; else if (v > hi) d = -1; else if (pos === 1 && v > 50) d = 0; else if (pos === -1 && v < 50) d = 0; } if (d < 0 && side === "longflat") d = 0; pos = d; out[t] = pos; } return out; }
function book(sigs: Record<string, (number | null)[]>, volTarget: number, volWin: number) { const net: number[] = []; const prevW: Record<string, number> = {}; for (const s of SYMBOLS) prevW[s] = 0; const dtv = volTarget / Math.sqrt(365); function tv(s: string, t: number) { const r = logret[s]; const v: number[] = []; for (let k = Math.max(1, t - volWin); k < t; k++) { const x = r[k]; if (x != null) v.push(x); } if (v.length < 10) return NaN; const m = mean(v); const vv = v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1); return Math.sqrt(Math.max(0, vv)); } for (let t = 1; t < T; t++) { let g = 0, turn = 0; const nw: Record<string, number> = {}; for (const s of SYMBOLS) { const sig = sigs[s][t - 1]; const r = logret[s][t]; let w = 0; if (sig != null && sig !== 0) { if (volTarget > 0) { const v = tv(s, t); if (Number.isFinite(v) && v > 1e-9) w = sig * Math.min(VOL_CAP, dtv / v); } else w = sig; } nw[s] = w; turn += Math.abs(w - (prevW[s] ?? 0)); if (r != null && w !== 0) g += w * (Math.exp(r) - 1); } net.push(g / SYMBOLS.length - (turn / SYMBOLS.length) * COST_PER_SIDE); for (const s of SYMBOLS) prevW[s] = nw[s]; } return net; }

// best CCI = p20 thr100 trend longflat vt0
const cciSig: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) cciSig[s] = cciSignal(cciSeries(barAt[s], 20), 100, "trend", "longflat");
const cciNet = book(cciSig, 0, 30);
// best RSI book over its grid (reproduce report's winner search)
const rsiPeriods = [14, 20, 30, 50]; const rsiBands: Array<[number, number]> = [[20, 80], [30, 70], [10, 90], [25, 75]]; const modes: Mode[] = ["trend", "revert"]; const sides: Side[] = ["longflat", "longshort"]; const volTargets = [0, 0.4];
let bestRsiNet: number[] | null = null; let bestRsiSharpe = -Infinity; let bestRsiLabel = "";
const rsiCache: Record<number, Record<string, (number | null)[]>> = {}; for (const p of rsiPeriods) { rsiCache[p] = {}; for (const s of SYMBOLS) rsiCache[p][s] = rsiSeries(barAt[s], p); }
for (const p of rsiPeriods) for (const [lo, hi] of rsiBands) for (const md of modes) for (const sd of sides) for (const vt of volTargets) { const sg: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) sg[s] = rsiSignal(rsiCache[p][s], lo, hi, md, sd); const net = book(sg, vt, 30); const sh = summarizeReturnSeries(net).sharpe; if (sh > bestRsiSharpe) { bestRsiSharpe = sh; bestRsiNet = net; bestRsiLabel = `rsi_p${p}_${lo}/${hi}_${md}_${sd}_vt${vt}`; } }
const rsiNet = bestRsiNet!;

const HONEST_N = 128;
const cciStats = summarizeReturnSeries(cciNet);
const rsiStats = summarizeReturnSeries(rsiNet);
// (1) committed over-strict gate
const g1 = computeDeflatedSharpeRatio(cciNet, { trialCount: HONEST_N, benchmarkSharpe: rsiStats.sharpe });
// (2) honest: deflated Sharpe of the PAIRED EXCESS series at honest N (benchmark 0)
const excess: number[] = []; for (let i = 0; i < cciNet.length; i++) excess.push(cciNet[i] - (rsiNet[i] ?? 0));
const g2 = computeDeflatedSharpeRatio(excess, { trialCount: HONEST_N });
const g2_n1 = computeDeflatedSharpeRatio(excess, { trialCount: 1 });
// (3) paired excess block-bootstrap CI (committed excessVsRSI)
const g3 = blockBootstrapConfidenceInterval(excess, { statistic: "mean", iterations: 2000, blockLength: 15, confidenceLevel: 0.95, seed: "cci-excess-vs-rsi" });
// (4) Newey-West-free paired t on daily excess
const em = mean(excess); const esd = Math.sqrt(excess.reduce((a, x) => a + (x - em) ** 2, 0) / (excess.length - 1)); const tstat = em / (esd / Math.sqrt(excess.length));

const out = {
  cci_best: "cci_p20_thr100_trend_longflat_vt0", rsi_best: bestRsiLabel,
  cci_dailySharpe: cciStats.sharpe, rsi_dailySharpe: rsiStats.sharpe, excess_dailySharpe: summarizeReturnSeries(excess).sharpe,
  gate1_committed_deflatedVsRSI: { deflatedProbability: g1.deflatedProbability, expectedMax: g1.expectedMaxSharpe, pass: g1.deflatedProbability > 0.95, note: "RSI level + FULL N=128 haircut on top — the report's bindingGate" },
  gate2_honest_deflatedExcess_atN: { deflatedProbability: g2.deflatedProbability, pass: g2.deflatedProbability > 0.95, note: "deflated Sharpe of CCI-minus-RSI excess at honest N=128 — does the edge OVER rsi survive MT?" },
  gate2b_deflatedExcess_atN1: { deflatedProbability: g2_n1.deflatedProbability, pass: g2_n1.deflatedProbability > 0.95 },
  gate3_pairedExcess_bootCI: { lower: g3.lower, estimate: g3.estimate, upper: g3.upper, pass: g3.lower > 0, note: "committed excessVsRSI — entirely>0 = CCI reliably beats RSI" },
  gate4_paired_t: { tStat: tstat, meanExcessDaily: em },
};
fs.mkdirSync(`${ROOT}/output/edgehunt-audit`, { recursive: true });
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/d1-cci-vs-rsi-gate.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
