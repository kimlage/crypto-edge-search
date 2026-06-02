/**
 * AUDIT (D1) — Is the surrogate null TOO POWERFUL? (error class v)
 *
 * Both D1-03 (Supertrend) and D1-06 (CCI) are KILLED primarily because the surrogate-recompute null
 * mean Sharpe (ST 1.93 / CCI 2.3-2.4) EXCEEDS the observed net Sharpe (ST 1.645 / CCI 1.768), p~0.8-1.0.
 *
 * The original author's fairness test compared overlay-on-surrogate vs always-long-on-surrogate and
 * found them close => "the surrogate Sharpe is preserved long-beta, null FAIR." That test only proves
 * the surrogate is INTERNALLY consistent. It does NOT test the load-bearing question:
 *
 *   Does the surrogate RECONSTRUCTION itself make the world EASIER than reality?
 *   i.e. is  always-long-on-SURROGATE Sharpe  >>  always-long-on-REAL Sharpe ?
 *
 * If the surrogate OHLC rebuild inflates the passive long Sharpe far above the real passive long
 * Sharpe, then "observed < surrogate" is an artifact of an easier synthetic environment, the null is
 * TOO POWERFUL, and the KILL could be wrongly killing a real edge. The honest like-for-like reference
 * the surrogate mean must be compared against is the ALWAYS-LONG-ON-SURROGATE mean (the matched-
 * exposure passive book IN THE SAME SYNTHETIC WORLD), not the real observed Sharpe.
 *
 * Decisive numbers produced here, for BOTH the CCI surrogate builders and the Supertrend builder:
 *   A. real always-long net Sharpe (the true long-beta the overlay rides)
 *   B. surrogate always-long net Sharpe (mean over N draws)   <- if B >> A, surrogate is easier
 *   C. surrogate overlay net Sharpe (mean)                    <- the number the report uses as the null
 *   D. observed overlay net Sharpe (from committed report)
 *   Verdict logic:
 *     - If C ~ B (overlay can't beat passive IN the synthetic world) AND B ~ A (synthetic world is
 *       NOT easier than real)  => null FAIR, KILL SOUND.
 *     - If B >> A => surrogate inflates passive beta => null TOO POWERFUL => the (C>D) comparison is
 *       contaminated => potential FALSE KILL. The honest test then is D vs A and D vs (C - (B-A)).
 */
import fs from "node:fs";

const ROOT = ".";
const COST_PER_SIDE = 0.0004;
const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"];
interface Bar { date: string; open: number; high: number; low: number; close: number; }
function loadSymbol(sym: string): Bar[] {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`, "utf8")) as Bar[];
  return raw.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
}
const perSym: Record<string, Bar[]> = {};
for (const s of SYMBOLS) perSym[s] = loadSymbol(s);
const DATES = Array.from(new Set(SYMBOLS.flatMap((s) => perSym[s].map((b) => b.date)))).sort();
const T = DATES.length;
const dateIdx = new Map(DATES.map((d, i) => [d, i]));
const barAt: Record<string, (Bar | null)[]> = {};
for (const s of SYMBOLS) { const a: (Bar | null)[] = Array<Bar | null>(T).fill(null); for (const b of perSym[s]) { const i = dateIdx.get(b.date); if (i != null) a[i] = b; } barAt[s] = a; }
const logret: Record<string, (number | null)[]> = {};
for (const s of SYMBOLS) { const r: (number | null)[] = Array<number | null>(T).fill(null); for (let t = 1; t < T; t++) { const a = barAt[s][t - 1], b = barAt[s][t]; if (a && b) r[t] = Math.log(b.close / a.close); } logret[s] = r; }

function mean(a: number[]) { return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); }
function annualize(d: number) { return d * Math.sqrt(365); }
function summ(a: number[]) { const m = mean(a); const v = a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1); const sd = Math.sqrt(v); return sd > 1e-12 ? m / sd : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const VOL_CAP = 3;
type Mode = "trend" | "revert"; type Side = "longflat" | "longshort";

// ---- CCI (copied verbatim) ----
function cciSeries(bars: (Bar | null)[], period: number): (number | null)[] { const n = bars.length; const out: (number | null)[] = Array<number | null>(n).fill(null); const w: number[] = [];
  for (let t = 0; t < n; t++) { const b = bars[t]; if (!b) { out[t] = null; continue; } const tp = (b.high + b.low + b.close) / 3; w.push(tp); if (w.length > period) w.shift(); if (w.length < period) { out[t] = null; continue; }
    const sma = w.reduce((a, x) => a + x, 0) / period; let mad = 0; for (const x of w) mad += Math.abs(x - sma); mad /= period; if (mad < 1e-12) { out[t] = 0; continue; } out[t] = (tp - sma) / (0.015 * mad); } return out; }
function cciSignal(cci: (number | null)[], thr: number, mode: Mode, side: Side): (number | null)[] { const n = cci.length; const out: (number | null)[] = Array<number | null>(n).fill(null); let pos = 0;
  for (let t = 0; t < n; t++) { const v = cci[t]; if (v == null) { out[t] = null; continue; } let d = pos;
    if (mode === "trend") { if (v > thr) d = 1; else if (v < -thr) d = -1; else if (pos === 1 && v < 0) d = 0; else if (pos === -1 && v > 0) d = 0; }
    else { if (v < -thr) d = 1; else if (v > thr) d = -1; else if (pos === 1 && v > 0) d = 0; else if (pos === -1 && v < 0) d = 0; }
    if (d < 0 && side === "longflat") d = 0; pos = d; out[t] = pos; } return out; }

// ---- Supertrend (copied verbatim from D1-03) ----
function emaStep(prev: number, x: number, period: number) { const k = 2 / (period + 1); return prev + k * (x - prev); }
function supertrendSignal(bars: (Bar | null)[], atrPeriod: number, mult: number, side: Side, emaConfirm: number): (number | null)[] {
  const n = bars.length; const sig: (number | null)[] = Array<number | null>(n).fill(null);
  let atr = NaN, prevClose = NaN, finalUpper = NaN, finalLower = NaN, trendUp = true, emaVal = NaN, warm = 0;
  for (let t = 0; t < n; t++) { const b = bars[t]; if (!b) continue;
    let tr: number; if (!Number.isFinite(prevClose)) tr = b.high - b.low; else tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    if (!Number.isFinite(atr)) atr = tr; else atr = (atr * (atrPeriod - 1) + tr) / atrPeriod;
    if (emaConfirm > 0) { if (!Number.isFinite(emaVal)) emaVal = b.close; else emaVal = emaStep(emaVal, b.close, emaConfirm); }
    const hl2 = (b.high + b.low) / 2; const basicUpper = hl2 + mult * atr; const basicLower = hl2 - mult * atr;
    if (!Number.isFinite(finalUpper)) { finalUpper = basicUpper; finalLower = basicLower; }
    else { finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper; finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower; }
    if (trendUp) { if (b.close < finalLower) trendUp = false; } else { if (b.close > finalUpper) trendUp = true; }
    warm++; prevClose = b.close;
    if (warm <= atrPeriod + 1) { sig[t] = 0; continue; }
    let s = 0; if (trendUp) s = 1; else s = side === "longshort" ? -1 : 0;
    if (emaConfirm > 0 && Number.isFinite(emaVal)) { if (s > 0 && b.close < emaVal) s = 0; if (s < 0 && b.close > emaVal) s = 0; }
    sig[t] = s; } return sig; }

// ---- generic book on a given logret + signals ----
function book(sigs: Record<string, (number | null)[]>, lr: Record<string, (number | null)[]>, volTarget: number, volWin: number) {
  const net: number[] = []; const prevW: Record<string, number> = {}; for (const s of SYMBOLS) prevW[s] = 0; const dtv = volTarget / Math.sqrt(365);
  function tv(s: string, t: number) { const r = lr[s]; const v: number[] = []; for (let k = Math.max(1, t - volWin); k < t; k++) { const x = r[k]; if (x != null) v.push(x); } if (v.length < 10) return NaN; const m = mean(v); const vv = v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1); return Math.sqrt(Math.max(0, vv)); }
  for (let t = 1; t < T; t++) { let g = 0, turn = 0; const nw: Record<string, number> = {};
    for (const s of SYMBOLS) { const sig = sigs[s][t - 1]; const r = lr[s][t]; let w = 0; if (sig != null && sig !== 0) { if (volTarget > 0) { const v = tv(s, t); if (Number.isFinite(v) && v > 1e-9) w = sig * Math.min(VOL_CAP, dtv / v); } else w = sig; } nw[s] = w; turn += Math.abs(w - (prevW[s] ?? 0)); if (r != null && w !== 0) g += w * (Math.exp(r) - 1); }
    net.push(g / SYMBOLS.length - (turn / SYMBOLS.length) * COST_PER_SIDE); for (const s of SYMBOLS) prevW[s] = nw[s]; }
  return net; }

function alwaysLongSig(bars: Record<string, (Bar | null)[]>): Record<string, (number | null)[]> {
  const o: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { const a: (number | null)[] = Array<number | null>(T).fill(null); let started = false; for (let t = 0; t < T; t++) { if (bars[s][t]) started = true; a[t] = started ? 1 : 0; } o[s] = a; } return o; }
function surLogretFromBars(sb: (Bar | null)[]): (number | null)[] { const r: (number | null)[] = Array<number | null>(T).fill(null); let p = -1; for (let t = 0; t < T; t++) { if (sb[t]) { if (p >= 0 && sb[p]) r[t] = Math.log(sb[t]!.close / sb[p]!.close); p = t; } } return r; }

// ---- surrogate builders ----
function dft(re: number[], im: number[], inv: boolean) { const n = re.length; const oR = new Array(n).fill(0), oI = new Array(n).fill(0); const sign = inv ? 1 : -1;
  for (let k = 0; k < n; k++) { let sr = 0, si = 0; for (let j = 0; j < n; j++) { const ang = (sign * 2 * Math.PI * k * j) / n; const c = Math.cos(ang), s = Math.sin(ang); sr += re[j] * c - im[j] * s; si += re[j] * s + im[j] * c; } oR[k] = sr; oI[k] = si; } for (let k = 0; k < n; k++) { re[k] = inv ? oR[k] / n : oR[k]; im[k] = inv ? oI[k] / n : oI[k]; } }
function phaseRand(series: number[], rng: () => number): number[] { const n = series.length; if (n < 8) return series.slice(); const m = mean(series); const re = series.map((x) => x - m); const im = new Array(n).fill(0); dft(re, im, false);
  const half = Math.floor(n / 2); for (let k = 1; k <= half; k++) { const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]); const ph = 2 * Math.PI * rng(); re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph); const mir = n - k; if (mir !== k && mir < n) { re[mir] = re[k]; im[mir] = -im[k]; } } if (n % 2 === 0) im[half] = 0; dft(re, im, true); return re.map((x) => x + m); }
function stationaryBootstrap(m: number, length: number, meanBlock: number, rng: () => number): number[] { const out: number[] = []; if (m === 0) return out; let pos = Math.floor(rng() * m); for (let i = 0; i < length; i++) { out.push(pos); if (rng() < 1 / meanBlock) pos = Math.floor(rng() * m); else pos = (pos + 1) % m; } return out; }
// CCI's barsFromReturns: symmetric |r| intrabar band around [prev,close]
function cciBarsFromReturns(start: number, rets: number[], slots: number[]): (Bar | null)[] { const out: (Bar | null)[] = Array<Bar | null>(T).fill(null); let close = start; for (let i = 0; i < slots.length; i++) { const prev = close; close = close * Math.exp(rets[i]); const t = slots[i]; const rg = Math.abs(rets[i]); out[t] = { date: DATES[t], open: prev, high: Math.max(prev, close) * Math.exp(0.5 * rg), low: Math.min(prev, close) * Math.exp(-0.5 * rg), close }; } return out; }

function validIdxOf(s: string): number[] { const vi: number[] = []; for (let t = 1; t < T; t++) if (logret[s][t] != null) vi.push(t); return vi; }
function startOf(s: string, vi: number[]) { return barAt[s][vi[0] - 1]?.close ?? barAt[s][vi[0]]!.close; }

// CCI phase surrogate bars
function cciPhaseBars(seedBase: number): Record<string, (Bar | null)[]> { const sb: Record<string, (Bar | null)[]> = {}; for (const s of SYMBOLS) { const rng = mkRng(seedBase + s.charCodeAt(0) * 131 + s.charCodeAt(1) * 17); const vi = validIdxOf(s); if (vi.length < 50) { sb[s] = Array<Bar | null>(T).fill(null); continue; } const rets = vi.map((t) => logret[s][t]!); const sr = phaseRand(rets, rng); sb[s] = cciBarsFromReturns(startOf(s, vi), sr, vi); } return sb; }
// CCI block surrogate bars (geometry-preserving, like committed)
function cciBlockBars(seedBase: number): Record<string, (Bar | null)[]> { const sb: Record<string, (Bar | null)[]> = {}; for (const s of SYMBOLS) { const rng = mkRng(seedBase + s.charCodeAt(0) * 131 + s.charCodeAt(1) * 17); const vi = validIdxOf(s); if (vi.length < 50) { sb[s] = Array<Bar | null>(T).fill(null); continue; } const geom = vi.map((t) => { const b = barAt[s][t]!; return { r: logret[s][t]!, hi: Math.log(b.high / b.close), lo: Math.log(b.low / b.close), op: Math.log(b.open / b.close) }; }); const sampled = stationaryBootstrap(geom.length, geom.length, 20, rng); const out: (Bar | null)[] = Array<Bar | null>(T).fill(null); let close = startOf(s, vi); for (let k = 0; k < vi.length; k++) { const t = vi[k]; const g = geom[sampled[k]]; close = close * Math.exp(g.r); const c = close; out[t] = { date: DATES[t], open: Math.max(1e-9, c * Math.exp(g.op)), high: Math.max(c * Math.exp(g.hi), c), low: Math.min(c * Math.exp(g.lo), c), close: c }; } sb[s] = out; } return sb; }
// Supertrend block surrogate bars (geometry-preserving, like committed D1-03)
function stBlockBars(seedBase: number): Record<string, (Bar | null)[]> { return cciBlockBars(seedBase); } // identical construction

// ===== REAL baselines =====
const realAlwaysLong_vt0 = annualize(summ(book(alwaysLongSig(barAt), logret, 0, 30)));
const realAlwaysLong_vt04 = annualize(summ(book(alwaysLongSig(barAt), logret, 0.4, 30)));
const realDrift = mean(SYMBOLS.map((s) => mean(logret[s].filter((v): v is number => v != null))));

// CCI config: p20 thr100 trend longflat vt0
const CCI = { period: 20, thr: 100, mode: "trend" as Mode, side: "longflat" as Side, volTarget: 0, volWin: 30 };
// Supertrend config: atr7 m2 longflat vt0.4 ema200
const ST = { atrPeriod: 7, mult: 2, side: "longflat" as Side, volTarget: 0.4, emaConfirm: 200, volWin: 30 };

const N = Number(process.env.NDRAWS ?? 40);
let phCci = 0, phLong = 0, phDrift = 0, blCci = 0, blLong = 0, blDrift = 0;
let stOv = 0, stLong = 0, stDrift = 0;
for (let i = 0; i < N; i++) {
  // CCI phase
  { const sb = cciPhaseBars(3000 + i * 7919); const lr: Record<string, (number | null)[]> = {}; const sg: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { lr[s] = surLogretFromBars(sb[s]); sg[s] = cciSignal(cciSeries(sb[s], CCI.period), CCI.thr, CCI.mode, CCI.side); }
    phCci += annualize(summ(book(sg, lr, CCI.volTarget, CCI.volWin))); phLong += annualize(summ(book(alwaysLongSig(sb), lr, CCI.volTarget, CCI.volWin))); phDrift += mean(SYMBOLS.map((s) => mean(lr[s].filter((v): v is number => v != null)))); }
  // CCI block
  { const sb = cciBlockBars(5000 + i * 9973); const lr: Record<string, (number | null)[]> = {}; const sg: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { lr[s] = surLogretFromBars(sb[s]); sg[s] = cciSignal(cciSeries(sb[s], CCI.period), CCI.thr, CCI.mode, CCI.side); }
    blCci += annualize(summ(book(sg, lr, CCI.volTarget, CCI.volWin))); blLong += annualize(summ(book(alwaysLongSig(sb), lr, CCI.volTarget, CCI.volWin))); blDrift += mean(SYMBOLS.map((s) => mean(lr[s].filter((v): v is number => v != null)))); }
  // Supertrend block
  { const sb = stBlockBars(7000 + i * 9973); const lr: Record<string, (number | null)[]> = {}; const sg: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { lr[s] = surLogretFromBars(sb[s]); sg[s] = supertrendSignal(sb[s], ST.atrPeriod, ST.mult, ST.side, ST.emaConfirm); }
    stOv += annualize(summ(book(sg, lr, ST.volTarget, ST.volWin))); stLong += annualize(summ(book(alwaysLongSig(sb), lr, ST.volTarget, ST.volWin))); stDrift += mean(SYMBOLS.map((s) => mean(lr[s].filter((v): v is number => v != null)))); }
}
const out = {
  N,
  real: { drift_bps: realDrift * 1e4, alwaysLong_vt0_Sharpe: realAlwaysLong_vt0, alwaysLong_vt0_4_Sharpe: realAlwaysLong_vt04 },
  observed: { cci_net_Sharpe: 1.768, supertrend_net_Sharpe: 1.645 },
  cci_phase_surrogate: { drift_bps: (phDrift / N) * 1e4, overlay_Sharpe: phCci / N, alwaysLong_Sharpe: phLong / N },
  cci_block_surrogate: { drift_bps: (blDrift / N) * 1e4, overlay_Sharpe: blCci / N, alwaysLong_Sharpe: blLong / N },
  supertrend_block_surrogate: { drift_bps: (stDrift / N) * 1e4, overlay_Sharpe: stOv / N, alwaysLong_Sharpe: stLong / N },
  diagnostics: {
    cci_phase_surrLong_vs_realLong: phLong / N - realAlwaysLong_vt0,
    cci_block_surrLong_vs_realLong: blLong / N - realAlwaysLong_vt0,
    st_block_surrLong_vs_realLong: stLong / N - realAlwaysLong_vt04,
    note: "If surrLong >> realLong, the surrogate world is EASIER than reality => null TOO POWERFUL.",
  },
};
fs.mkdirSync(`${ROOT}/output/edgehunt-audit`, { recursive: true });
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/d1-surrogate-power-check.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
