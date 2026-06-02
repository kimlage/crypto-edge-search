/**
 * AUDIT (D1) DECISIVE — corrected surrogate null on the LIFT statistic.
 *
 * The committed reports kill both strategies by comparing the RAW overlay net Sharpe (observed) to
 * the RAW overlay net Sharpe recomputed on surrogates, finding surrogate mean > observed -> p~0.8-1.0.
 *
 * d1-surrogate-power-check showed the surrogate RECONSTRUCTION inflates the PASSIVE long-only Sharpe
 * by ~+0.75 to +1.09 Sharpe units above the real passive long (because phase/block surrogates destroy
 * volatility-clustering & crash-clustering, smoothing the equity curve and lifting buy&hold Sharpe).
 * So "surrogate overlay > observed overlay" is contaminated by an EASIER synthetic long-beta, not by
 * the overlay timing being worthless.
 *
 * The CORRECT null statistic for a long/flat trend/oscillator OVERLAY is its LIFT over a matched
 * passive-long book IN THE SAME WORLD:   lift = Sharpe(overlay) - Sharpe(always-long).
 *   - Observed lift uses REAL bars.
 *   - Null distribution = lift recomputed on each surrogate (overlay - always-long, same surrogate).
 * This cancels the shared long-beta in BOTH worlds and isolates whether the overlay's TIMING extracts
 * anything beyond structure-free path geometry. p = P(surrogate lift >= observed lift).
 *
 * Output per strategy: observed lift, surrogate lift distribution (mean, p95, p-value), verdict.
 */
import fs from "node:fs";

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
function annualize(d: number) { return d * Math.sqrt(365); }
function summ(a: number[]) { const m = mean(a); const v = a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1); const sd = Math.sqrt(v); return sd > 1e-12 ? m / sd : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const VOL_CAP = 3;
type Mode = "trend" | "revert"; type Side = "longflat" | "longshort";
function cciSeries(bars: (Bar | null)[], period: number): (number | null)[] { const n = bars.length; const out: (number | null)[] = Array<number | null>(n).fill(null); const w: number[] = []; for (let t = 0; t < n; t++) { const b = bars[t]; if (!b) { out[t] = null; continue; } const tp = (b.high + b.low + b.close) / 3; w.push(tp); if (w.length > period) w.shift(); if (w.length < period) { out[t] = null; continue; } const sma = w.reduce((a, x) => a + x, 0) / period; let mad = 0; for (const x of w) mad += Math.abs(x - sma); mad /= period; if (mad < 1e-12) { out[t] = 0; continue; } out[t] = (tp - sma) / (0.015 * mad); } return out; }
function cciSignal(cci: (number | null)[], thr: number, mode: Mode, side: Side): (number | null)[] { const n = cci.length; const out: (number | null)[] = Array<number | null>(n).fill(null); let pos = 0; for (let t = 0; t < n; t++) { const v = cci[t]; if (v == null) { out[t] = null; continue; } let d = pos; if (mode === "trend") { if (v > thr) d = 1; else if (v < -thr) d = -1; else if (pos === 1 && v < 0) d = 0; else if (pos === -1 && v > 0) d = 0; } else { if (v < -thr) d = 1; else if (v > thr) d = -1; else if (pos === 1 && v > 0) d = 0; else if (pos === -1 && v < 0) d = 0; } if (d < 0 && side === "longflat") d = 0; pos = d; out[t] = pos; } return out; }
function emaStep(prev: number, x: number, period: number) { const k = 2 / (period + 1); return prev + k * (x - prev); }
function supertrendSignal(bars: (Bar | null)[], atrPeriod: number, mult: number, side: Side, emaConfirm: number): (number | null)[] { const n = bars.length; const sig: (number | null)[] = Array<number | null>(n).fill(null); let atr = NaN, prevClose = NaN, finalUpper = NaN, finalLower = NaN, trendUp = true, emaVal = NaN, warm = 0; for (let t = 0; t < n; t++) { const b = bars[t]; if (!b) continue; let tr: number; if (!Number.isFinite(prevClose)) tr = b.high - b.low; else tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)); if (!Number.isFinite(atr)) atr = tr; else atr = (atr * (atrPeriod - 1) + tr) / atrPeriod; if (emaConfirm > 0) { if (!Number.isFinite(emaVal)) emaVal = b.close; else emaVal = emaStep(emaVal, b.close, emaConfirm); } const hl2 = (b.high + b.low) / 2; const basicUpper = hl2 + mult * atr; const basicLower = hl2 - mult * atr; if (!Number.isFinite(finalUpper)) { finalUpper = basicUpper; finalLower = basicLower; } else { finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper; finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower; } if (trendUp) { if (b.close < finalLower) trendUp = false; } else { if (b.close > finalUpper) trendUp = true; } warm++; prevClose = b.close; if (warm <= atrPeriod + 1) { sig[t] = 0; continue; } let s = 0; if (trendUp) s = 1; else s = side === "longshort" ? -1 : 0; if (emaConfirm > 0 && Number.isFinite(emaVal)) { if (s > 0 && b.close < emaVal) s = 0; if (s < 0 && b.close > emaVal) s = 0; } sig[t] = s; } return sig; }
function book(sigs: Record<string, (number | null)[]>, lr: Record<string, (number | null)[]>, volTarget: number, volWin: number) { const net: number[] = []; const prevW: Record<string, number> = {}; for (const s of SYMBOLS) prevW[s] = 0; const dtv = volTarget / Math.sqrt(365); function tv(s: string, t: number) { const r = lr[s]; const v: number[] = []; for (let k = Math.max(1, t - volWin); k < t; k++) { const x = r[k]; if (x != null) v.push(x); } if (v.length < 10) return NaN; const m = mean(v); const vv = v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1); return Math.sqrt(Math.max(0, vv)); } for (let t = 1; t < T; t++) { let g = 0, turn = 0; const nw: Record<string, number> = {}; for (const s of SYMBOLS) { const sig = sigs[s][t - 1]; const r = lr[s][t]; let w = 0; if (sig != null && sig !== 0) { if (volTarget > 0) { const v = tv(s, t); if (Number.isFinite(v) && v > 1e-9) w = sig * Math.min(VOL_CAP, dtv / v); } else w = sig; } nw[s] = w; turn += Math.abs(w - (prevW[s] ?? 0)); if (r != null && w !== 0) g += w * (Math.exp(r) - 1); } net.push(g / SYMBOLS.length - (turn / SYMBOLS.length) * COST_PER_SIDE); for (const s of SYMBOLS) prevW[s] = nw[s]; } return net; }
function alwaysLongSig(bars: Record<string, (Bar | null)[]>): Record<string, (number | null)[]> { const o: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { const a: (number | null)[] = Array<number | null>(T).fill(null); let started = false; for (let t = 0; t < T; t++) { if (bars[s][t]) started = true; a[t] = started ? 1 : 0; } o[s] = a; } return o; }
function surLogretFromBars(sb: (Bar | null)[]): (number | null)[] { const r: (number | null)[] = Array<number | null>(T).fill(null); let p = -1; for (let t = 0; t < T; t++) { if (sb[t]) { if (p >= 0 && sb[p]) r[t] = Math.log(sb[t]!.close / sb[p]!.close); p = t; } } return r; }
function dft(re: number[], im: number[], inv: boolean) { const n = re.length; const oR = new Array(n).fill(0), oI = new Array(n).fill(0); const sign = inv ? 1 : -1; for (let k = 0; k < n; k++) { let sr = 0, si = 0; for (let j = 0; j < n; j++) { const ang = (sign * 2 * Math.PI * k * j) / n; const c = Math.cos(ang), s = Math.sin(ang); sr += re[j] * c - im[j] * s; si += re[j] * s + im[j] * c; } oR[k] = sr; oI[k] = si; } for (let k = 0; k < n; k++) { re[k] = inv ? oR[k] / n : oR[k]; im[k] = inv ? oI[k] / n : oI[k]; } }
function phaseRand(series: number[], rng: () => number): number[] { const n = series.length; if (n < 8) return series.slice(); const m = mean(series); const re = series.map((x) => x - m); const im = new Array(n).fill(0); dft(re, im, false); const half = Math.floor(n / 2); for (let k = 1; k <= half; k++) { const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]); const ph = 2 * Math.PI * rng(); re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph); const mir = n - k; if (mir !== k && mir < n) { re[mir] = re[k]; im[mir] = -im[k]; } } if (n % 2 === 0) im[half] = 0; dft(re, im, true); return re.map((x) => x + m); }
function stationaryBootstrap(m: number, length: number, meanBlock: number, rng: () => number): number[] { const out: number[] = []; if (m === 0) return out; let pos = Math.floor(rng() * m); for (let i = 0; i < length; i++) { out.push(pos); if (rng() < 1 / meanBlock) pos = Math.floor(rng() * m); else pos = (pos + 1) % m; } return out; }
function cciBarsFromReturns(start: number, rets: number[], slots: number[]): (Bar | null)[] { const out: (Bar | null)[] = Array<Bar | null>(T).fill(null); let close = start; for (let i = 0; i < slots.length; i++) { const prev = close; close = close * Math.exp(rets[i]); const t = slots[i]; const rg = Math.abs(rets[i]); out[t] = { date: DATES[t], open: prev, high: Math.max(prev, close) * Math.exp(0.5 * rg), low: Math.min(prev, close) * Math.exp(-0.5 * rg), close }; } return out; }
function validIdxOf(s: string): number[] { const vi: number[] = []; for (let t = 1; t < T; t++) if (logret[s][t] != null) vi.push(t); return vi; }
function startOf(s: string, vi: number[]) { return barAt[s][vi[0] - 1]?.close ?? barAt[s][vi[0]]!.close; }
function cciPhaseBars(seedBase: number): Record<string, (Bar | null)[]> { const sb: Record<string, (Bar | null)[]> = {}; for (const s of SYMBOLS) { const rng = mkRng(seedBase + s.charCodeAt(0) * 131 + s.charCodeAt(1) * 17); const vi = validIdxOf(s); if (vi.length < 50) { sb[s] = Array<Bar | null>(T).fill(null); continue; } const rets = vi.map((t) => logret[s][t]!); const sr = phaseRand(rets, rng); sb[s] = cciBarsFromReturns(startOf(s, vi), sr, vi); } return sb; }
function blockBars(seedBase: number): Record<string, (Bar | null)[]> { const sb: Record<string, (Bar | null)[]> = {}; for (const s of SYMBOLS) { const rng = mkRng(seedBase + s.charCodeAt(0) * 131 + s.charCodeAt(1) * 17); const vi = validIdxOf(s); if (vi.length < 50) { sb[s] = Array<Bar | null>(T).fill(null); continue; } const geom = vi.map((t) => { const b = barAt[s][t]!; return { r: logret[s][t]!, hi: Math.log(b.high / b.close), lo: Math.log(b.low / b.close), op: Math.log(b.open / b.close) }; }); const sampled = stationaryBootstrap(geom.length, geom.length, 20, rng); const out: (Bar | null)[] = Array<Bar | null>(T).fill(null); let close = startOf(s, vi); for (let k = 0; k < vi.length; k++) { const t = vi[k]; const g = geom[sampled[k]]; close = close * Math.exp(g.r); const c = close; out[t] = { date: DATES[t], open: Math.max(1e-9, c * Math.exp(g.op)), high: Math.max(c * Math.exp(g.hi), c), low: Math.min(c * Math.exp(g.lo), c), close: c }; } sb[s] = out; } return sb; }

const CCI = { period: 20, thr: 100, mode: "trend" as Mode, side: "longflat" as Side, volTarget: 0, volWin: 30 };
const ST = { atrPeriod: 7, mult: 2, side: "longflat" as Side, volTarget: 0.4, emaConfirm: 200, volWin: 30 };
const N = Number(process.env.NDRAWS ?? 200);

// ----- observed lifts on REAL bars -----
const cciSigReal: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) cciSigReal[s] = cciSignal(cciSeries(barAt[s], CCI.period), CCI.thr, CCI.mode, CCI.side);
const cciObsOverlay = annualize(summ(book(cciSigReal, logret, CCI.volTarget, CCI.volWin)));
const cciObsLong = annualize(summ(book(alwaysLongSig(barAt), logret, CCI.volTarget, CCI.volWin)));
const cciObsLift = cciObsOverlay - cciObsLong;

const stSigReal: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) stSigReal[s] = supertrendSignal(barAt[s], ST.atrPeriod, ST.mult, ST.side, ST.emaConfirm);
const stObsOverlay = annualize(summ(book(stSigReal, logret, ST.volTarget, ST.volWin)));
const stObsLong = annualize(summ(book(alwaysLongSig(barAt), logret, ST.volTarget, ST.volWin)));
const stObsLift = stObsOverlay - stObsLong;

// ----- surrogate lift distributions -----
const cciPhaseLift: number[] = [], cciBlockLift: number[] = [], stBlockLift: number[] = [];
for (let i = 0; i < N; i++) {
  { const sb = cciPhaseBars(3000 + i * 7919); const lr: Record<string, (number | null)[]> = {}; const sg: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { lr[s] = surLogretFromBars(sb[s]); sg[s] = cciSignal(cciSeries(sb[s], CCI.period), CCI.thr, CCI.mode, CCI.side); } cciPhaseLift.push(annualize(summ(book(sg, lr, CCI.volTarget, CCI.volWin))) - annualize(summ(book(alwaysLongSig(sb), lr, CCI.volTarget, CCI.volWin)))); }
  { const sb = blockBars(5000 + i * 9973); const lr: Record<string, (number | null)[]> = {}; const sg: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { lr[s] = surLogretFromBars(sb[s]); sg[s] = cciSignal(cciSeries(sb[s], CCI.period), CCI.thr, CCI.mode, CCI.side); } cciBlockLift.push(annualize(summ(book(sg, lr, CCI.volTarget, CCI.volWin))) - annualize(summ(book(alwaysLongSig(sb), lr, CCI.volTarget, CCI.volWin)))); }
  { const sb = blockBars(7000 + i * 9973); const lr: Record<string, (number | null)[]> = {}; const sg: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { lr[s] = surLogretFromBars(sb[s]); sg[s] = supertrendSignal(sb[s], ST.atrPeriod, ST.mult, ST.side, ST.emaConfirm); } stBlockLift.push(annualize(summ(book(sg, lr, ST.volTarget, ST.volWin))) - annualize(summ(book(alwaysLongSig(sb), lr, ST.volTarget, ST.volWin)))); }
}
function stat(arr: number[], obs: number) { const a = [...arr].sort((x, y) => x - y); const m = mean(a); const p95 = a[Math.floor(a.length * 0.95)]; const p = (a.filter((x) => x >= obs).length + 1) / (a.length + 1); return { mean: m, p95, p }; }
const out = {
  N,
  note: "LIFT = Sharpe(overlay) - Sharpe(matched always-long) in the SAME world. Cancels shared long-beta. p = P(surrogate lift >= observed lift).",
  cci: { observed: { overlay: cciObsOverlay, alwaysLong: cciObsLong, lift: cciObsLift }, phase: stat(cciPhaseLift, cciObsLift), block: stat(cciBlockLift, cciObsLift) },
  supertrend: { observed: { overlay: stObsOverlay, alwaysLong: stObsLong, lift: stObsLift }, block: stat(stBlockLift, stObsLift) },
};
fs.mkdirSync(`${ROOT}/output/edgehunt-audit`, { recursive: true });
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/d1-lift-null.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
