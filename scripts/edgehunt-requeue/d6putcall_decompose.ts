/**
 * D6-PUTCALL decompose — is the "edge" the contrarian LONG-on-fear claim, or the short-on-calm leg?
 * The full grid's winner shorts on extreme calm (gA-1) and is long almost never (longShare 0.05).
 * That is NOT the put/call=fear=>contrarian-LONG belief. Here we isolate the legs and test a small,
 * pre-specifiable grid (low honest N) so the Deflated-Sharpe gate is fair. Plus: does the long-on-fear
 * leg ALONE survive DSR + AR-placebo at honest N?
 */
import fs from "node:fs";
import { computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation.ts";
const ROOT = ".";
const COST = 0.0004; const ANN = Math.sqrt(365);

function loadDvol(): Map<string, number> { const a = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt/dvol_btc.json`, "utf8")) as Array<{ date: string; close: number }>; const m = new Map<string, number>(); for (const r of a) if (r.date && Number.isFinite(r.close)) m.set(r.date, r.close); return m; }
function loadBtc(): Map<string, number> { const out = new Map<string, number>(); const nf1 = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Array<{ date: string; close: number }>; for (const r of nf1) if (r.date && Number.isFinite(r.close)) out.set(r.date, r.close); const cm = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_btc.json`, "utf8")) as { data: Array<{ time: string; PriceUSD?: string }> }; for (const r of cm.data) { if (!r.PriceUSD) continue; const d = r.time.slice(0, 10); if (!out.has(d)) { const px = Number(r.PriceUSD); if (Number.isFinite(px)) out.set(d, px); } } return out; }
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); }
function sh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(rng: () => number) { const u1 = Math.max(1e-12, rng()); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng()); }

const dvolMap = loadDvol(), btcMap = loadBtc();
const dates = [...dvolMap.keys()].filter((d) => btcMap.has(d)).sort();
const T = dates.length;
const dvol = dates.map((d) => dvolMap.get(d)!);
const px = dates.map((d) => btcMap.get(d)!);
const fwd = new Array(T).fill(NaN); for (let t = 0; t < T - 1; t++) fwd[t] = Math.log(px[t + 1] / px[t]);
function fitAr1(lv: number[]) { let sxy = 0, sxx = 0, sx = 0, sy = 0; const m = lv.length - 1; for (let i = 1; i < lv.length; i++) { sx += lv[i - 1]; sy += lv[i]; sxy += lv[i - 1] * lv[i]; sxx += lv[i - 1] ** 2; } const phi = (m * sxy - sx * sy) / (m * sxx - sx * sx); const c = (sy - phi * sx) / m; let sse = 0; for (let i = 1; i < lv.length; i++) { const e = lv[i] - (c + phi * lv[i - 1]); sse += e * e; } return { phi, c, sigma: Math.sqrt(sse / (m - 2)), mean: mean(lv), min: Math.min(...lv), max: Math.max(...lv) }; }
const AR = fitAr1(dvol);
function zAt(s: number[], t: number, w: number) { const lo = Math.max(0, t - w + 1); const a: number[] = []; for (let k = lo; k <= t; k++) if (Number.isFinite(s[k])) a.push(s[k]); if (a.length < Math.min(30, w)) return NaN; const m = mean(a), sd = std(a); return sd > 1e-12 ? (s[t] - m) / sd : 0; }

const startIdx = 200, tradableEnd = T - 1, splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);
function run(pos: number[], lo: number, hi: number) { const dn: number[] = []; let prev = 0; for (let t = lo; t < hi; t++) { const fr = fwd[t], p = pos[t]; if (!Number.isFinite(fr) || !Number.isFinite(p)) continue; dn.push(p * fr - Math.abs(p - prev) * COST); prev = p; } return dn; }

// Three legs, z(DVOL level), 90d window, lag1, threshold 1.5:
//   LONG-on-fear only: long when z>=1.5 else flat (the literal contrarian belief)
//   SHORT-on-calm only: short when z<=-1.5 else flat
//   long-on-fear + stay-long base (de-risk flat on calm) -> canonical
function legPos(kind: string, w: number, thr: number, lag: number): number[] {
  const pos = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) { const st = t - lag; if (st < 0) continue; const z = zAt(dvol, st, w); if (!Number.isFinite(z)) continue;
    if (kind === "longFear") pos[t] = z >= thr ? 1 : 0;
    else if (kind === "shortCalm") pos[t] = z <= -thr ? -1 : 0;
    else if (kind === "longFear+baseLong") pos[t] = z <= -thr ? 0 : 1; // stay long, derisk on calm
    else if (kind === "fullContra") pos[t] = z >= thr ? 1 : z <= -thr ? -1 : 0;
  }
  return pos;
}

console.log(`aligned days=${T} IS=[${startIdx},${splitIdx}) OOS=[${splitIdx},${tradableEnd})`);
console.log(`B&H IS Sharpe=${sh(run(new Array(T).fill(1), startIdx, splitIdx)).toFixed(3)} OOS=${sh(run(new Array(T).fill(1), splitIdx, tradableEnd)).toFixed(3)}`);
for (const kind of ["longFear", "shortCalm", "longFear+baseLong", "fullContra"]) {
  const p = legPos(kind, 90, 1.5, 1);
  const isS = sh(run(p, startIdx, splitIdx)), oos = sh(run(p, splitIdx, tradableEnd));
  // exposure
  let exp = 0, n = 0; for (let t = startIdx; t < splitIdx; t++) if (Number.isFinite(p[t]) && Number.isFinite(fwd[t])) { exp += Math.abs(p[t]); n++; }
  console.log(`  ${kind.padEnd(20)} IS=${isS.toFixed(3)} OOS=${oos.toFixed(3)} exposure=${(exp / n).toFixed(3)}`);
}

// SMALL pre-specified grid for a FAIR Deflated-Sharpe: only the contrarian-LONG family,
// 3 windows x 3 thresholds x 2 lags x {longFear, longFear+baseLong} = 36 configs.
const small: { label: string; dn: number[] }[] = [];
for (const kind of ["longFear", "longFear+baseLong"]) for (const w of [60, 90, 180]) for (const thr of [1.0, 1.5, 2.0]) for (const lag of [1, 2]) {
  const p = legPos(kind, w, thr, lag); small.push({ label: `${kind}|w${w}|thr${thr}|lag${lag}`, dn: run(p, startIdx, splitIdx) });
}
small.sort((a, b) => sh(b.dn) - sh(a.dn));
const sb = small[0];
const dsr = computeDeflatedSharpeRatio(sb.dn, { trialCount: small.length });
console.log(`\nSMALL contrarian-LONG-only grid: honestN=${small.length} best=${sb.label} IS=${sh(sb.dn).toFixed(3)} DSRp=${dsr.deflatedProbability.toFixed(4)} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}`);
console.log(`  top-5:`); for (let i = 0; i < 5; i++) console.log(`    ${sh(small[i].dn).toFixed(3)} ${small[i].label}`);

// AR(1) placebo p for the small grid (best-of-small vs best-of-small on placebo)
function simPlacebo(rng: () => number) { const f = new Array<number>(T); f[0] = AR.mean; for (let i = 1; i < T; i++) { let v = AR.c + AR.phi * f[i - 1] + AR.sigma * gauss(rng); if (v < AR.min) v = AR.min; if (v > AR.max) v = AR.max; f[i] = v; } return f; }
function zAtSig(s: number[], t: number, w: number) { return zAt(s, t, w); }
function legPosSig(sig: number[], kind: string, w: number, thr: number, lag: number) { const pos = new Array(T).fill(NaN); for (let t = 0; t < T; t++) { const st = t - lag; if (st < 0) continue; const z = zAtSig(sig, st, w); if (!Number.isFinite(z)) continue; if (kind === "longFear") pos[t] = z >= thr ? 1 : 0; else pos[t] = z <= -thr ? 0 : 1; } return pos; }
let ge = 0; const NS = 500;
for (let s = 0; s < NS; s++) { const rng = mkRng(7000 + s * 7919); const fk = simPlacebo(rng); let bS = -Infinity;
  for (const kind of ["longFear", "longFear+baseLong"]) for (const w of [60, 90, 180]) for (const thr of [1.0, 1.5, 2.0]) for (const lag of [1, 2]) { const v = sh(run(legPosSig(fk, kind, w, thr, lag), startIdx, splitIdx)); if (v > bS) bS = v; }
  if (bS >= sh(sb.dn)) ge++; }
console.log(`  AR(1)-placebo p (small grid)=${((ge + 1) / (NS + 1)).toFixed(4)}`);
// OOS of small best
const sbCfg = sb.label.split("|"); const kind = sbCfg[0]; const w = +sbCfg[1].slice(1); const thr = +sbCfg[2].slice(3); const lag = +sbCfg[3].slice(3);
console.log(`  small-best OOS Sharpe=${sh(run(legPos(kind, w, thr, lag), splitIdx, tradableEnd)).toFixed(3)}`);
