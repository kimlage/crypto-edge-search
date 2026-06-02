/**
 * AUDIT (D1) — WHY is the surrogate null too powerful? Mechanism check.
 *
 * Hypothesis: phase/block surrogates preserve the MARGINAL return distribution & power spectrum but
 * DESTROY volatility-clustering and crash-clustering. A buy&hold equity curve on a path whose big
 * down-days are scattered (not clustered into drawdowns) has a HIGHER Sharpe than on the real path.
 * That is why surrogate always-long Sharpe (1.96-2.09) >> real always-long Sharpe (1.00), making the
 * "observed overlay < surrogate overlay" comparison a too-powerful (false-KILL-risk) null.
 *
 * Measure, per coin, on REAL vs PHASE-surrogate vs BLOCK-surrogate returns:
 *   - autocorrelation of |r| at lag 1..5 (vol clustering; should be HIGH in real, ~0 in phase, lower in block)
 *   - max drawdown of the buy&hold equity (deeper in real if crashes cluster)
 *   - realized annualized vol (should MATCH across all — marginal vol preserved)
 * Pooled means across the 8 coins.
 */
import fs from "node:fs";
const ROOT = ".";
const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"];
interface Bar { date: string; open: number; high: number; low: number; close: number; }
function loadSymbol(sym: string): Bar[] { const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`, "utf8")) as Bar[]; return raw.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0); }
const perSym: Record<string, Bar[]> = {}; for (const s of SYMBOLS) perSym[s] = loadSymbol(s);
const DATES = Array.from(new Set(SYMBOLS.flatMap((s) => perSym[s].map((b) => b.date)))).sort();
const T = DATES.length; const dateIdx = new Map(DATES.map((d, i) => [d, i]));
const barAt: Record<string, (Bar | null)[]> = {}; for (const s of SYMBOLS) { const a: (Bar | null)[] = Array<Bar | null>(T).fill(null); for (const b of perSym[s]) { const i = dateIdx.get(b.date); if (i != null) a[i] = b; } barAt[s] = a; }
const logret: Record<string, (number | null)[]> = {}; for (const s of SYMBOLS) { const r: (number | null)[] = Array<number | null>(T).fill(null); for (let t = 1; t < T; t++) { const a = barAt[s][t - 1], b = barAt[s][t]; if (a && b) r[t] = Math.log(b.close / a.close); } logret[s] = r; }
function mean(a: number[]) { return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function dft(re: number[], im: number[], inv: boolean) { const n = re.length; const oR = new Array(n).fill(0), oI = new Array(n).fill(0); const sign = inv ? 1 : -1; for (let k = 0; k < n; k++) { let sr = 0, si = 0; for (let j = 0; j < n; j++) { const ang = (sign * 2 * Math.PI * k * j) / n; const c = Math.cos(ang), s = Math.sin(ang); sr += re[j] * c - im[j] * s; si += re[j] * s + im[j] * c; } oR[k] = sr; oI[k] = si; } for (let k = 0; k < n; k++) { re[k] = inv ? oR[k] / n : oR[k]; im[k] = inv ? oI[k] / n : oI[k]; } }
function phaseRand(series: number[], rng: () => number): number[] { const n = series.length; if (n < 8) return series.slice(); const m = mean(series); const re = series.map((x) => x - m); const im = new Array(n).fill(0); dft(re, im, false); const half = Math.floor(n / 2); for (let k = 1; k <= half; k++) { const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]); const ph = 2 * Math.PI * rng(); re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph); const mir = n - k; if (mir !== k && mir < n) { re[mir] = re[k]; im[mir] = -im[k]; } } if (n % 2 === 0) im[half] = 0; dft(re, im, true); return re.map((x) => x + m); }
function stationaryBootstrap(m: number, length: number, meanBlock: number, rng: () => number): number[] { const out: number[] = []; if (m === 0) return out; let pos = Math.floor(rng() * m); for (let i = 0; i < length; i++) { out.push(pos); if (rng() < 1 / meanBlock) pos = Math.floor(rng() * m); else pos = (pos + 1) % m; } return out; }
function acfAbs(r: number[], lag: number) { const a = r.map(Math.abs); const m = mean(a); let num = 0, den = 0; for (let i = 0; i < a.length; i++) den += (a[i] - m) ** 2; for (let i = lag; i < a.length; i++) num += (a[i] - m) * (a[i - lag] - m); return den > 0 ? num / den : 0; }
function annVol(r: number[]) { const m = mean(r); const v = r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, r.length - 1); return Math.sqrt(v) * Math.sqrt(365); }
function maxDD(r: number[]) { let eq = 0, peak = 0, mdd = 0; for (const x of r) { eq += x; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > mdd) mdd = dd; } return mdd; }
function avgAcf(r: number[]) { return mean([1, 2, 3, 4, 5].map((l) => acfAbs(r, l))); }

let realAcf = 0, phAcf = 0, blAcf = 0, realVol = 0, phVol = 0, blVol = 0, realDD = 0, phDD = 0, blDD = 0;
const rng = mkRng(12345);
for (const s of SYMBOLS) {
  const r = logret[s].filter((v): v is number => v != null);
  const ph = phaseRand(r, rng);
  const idx = stationaryBootstrap(r.length, r.length, 20, rng); const bl = idx.map((i) => r[i]);
  realAcf += avgAcf(r); phAcf += avgAcf(ph); blAcf += avgAcf(bl);
  realVol += annVol(r); phVol += annVol(ph); blVol += annVol(bl);
  realDD += maxDD(r); phDD += maxDD(ph); blDD += maxDD(bl);
}
const n = SYMBOLS.length;
const out = {
  note: "Mechanism: surrogates preserve marginal vol but destroy vol-clustering (|r| autocorr) and deepen-or-shrink drawdowns. Lower clustering => smoother buy&hold equity => inflated passive Sharpe => too-powerful null.",
  abs_return_autocorr_lag1to5_mean: { real: realAcf / n, phase: phAcf / n, block: blAcf / n },
  annualized_vol_mean: { real: realVol / n, phase: phVol / n, block: blVol / n },
  buyhold_maxDrawdown_logsum_mean: { real: realDD / n, phase: phDD / n, block: blDD / n },
};
fs.mkdirSync(`${ROOT}/output/edgehunt-audit`, { recursive: true });
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/d1-surrogate-clustering.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
