/**
 * D6-PUTCALL probe — does extreme DVOL (defensive options positioning) predict forward BTC returns?
 * DVOL = Deribit BTC implied-vol index (free history). High DVOL = traders paying up for protection
 * = extreme defensive positioning. Contrarian belief: high defensive positioning -> bounce (long).
 * We measure corr(signal_{t-lag}, fwdRet_t) for several DVOL-derived proxies, plus a regime split.
 */
import fs from "node:fs";
const ROOT = ".";

function loadDvol(): Map<string, number> {
  const a = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt/dvol_btc.json`, "utf8")) as Array<{ date: string; close: number }>;
  const m = new Map<string, number>();
  for (const r of a) if (r.date && Number.isFinite(r.close)) m.set(r.date, r.close);
  return m;
}
function loadBtc(): Map<string, number> {
  const out = new Map<string, number>();
  const nf1 = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Array<{ date: string; close: number }>;
  for (const r of nf1) if (r.date && Number.isFinite(r.close)) out.set(r.date, r.close);
  const cm = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_btc.json`, "utf8")) as { data: Array<{ time: string; PriceUSD?: string }> };
  for (const r of cm.data) {
    if (!r.PriceUSD) continue;
    const d = r.time.slice(0, 10);
    if (!out.has(d)) { const px = Number(r.PriceUSD); if (Number.isFinite(px)) out.set(d, px); }
  }
  return out;
}
const dvolMap = loadDvol();
const btcMap = loadBtc();
const dates = [...dvolMap.keys()].filter((d) => btcMap.has(d)).sort();
const T = dates.length;
const dvol = dates.map((d) => dvolMap.get(d)!);
const px = dates.map((d) => btcMap.get(d)!);
const fwdRet = new Array(T).fill(NaN);
for (let t = 0; t < T - 1; t++) fwdRet[t] = Math.log(px[t + 1] / px[t]);

function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); }
function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { x.push(a[i]); y.push(b[i]); }
  const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}
// realized vol (20d) from price, for DVOL-RV proxy
function realizedVol(win: number): number[] {
  const ret = new Array(T).fill(NaN);
  for (let t = 1; t < T; t++) ret[t] = Math.log(px[t] / px[t - 1]);
  const rv = new Array(T).fill(NaN);
  for (let t = win; t < T; t++) {
    const w = ret.slice(t - win + 1, t + 1).filter(Number.isFinite);
    rv[t] = std(w) * Math.sqrt(365) * 100; // annualized in vol points, comparable to DVOL
  }
  return rv;
}
function rollingZ(series: number[], win: number): number[] {
  const out = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    const lo = Math.max(0, t - win + 1); const w: number[] = [];
    for (let k = lo; k <= t; k++) if (Number.isFinite(series[k])) w.push(series[k]);
    if (w.length < Math.min(30, win)) continue;
    const m = mean(w), s = std(w); out[t] = s > 1e-12 ? (series[t] - m) / s : 0;
  }
  return out;
}

const rv20 = realizedVol(20);
const dvolMinusRv = dvol.map((v, i) => Number.isFinite(rv20[i]) ? v - rv20[i] : NaN); // VRP proxy / defensive premium
const dvolMom5 = dvol.map((v, i) => i >= 5 && Number.isFinite(dvol[i - 5]) ? v - dvol[i - 5] : NaN);

console.log(`aligned days=${T} (${dates[0]}..${dates[T - 1]})`);
console.log(`DVOL: mean=${mean(dvol).toFixed(1)} sd=${std(dvol).toFixed(1)} min=${Math.min(...dvol).toFixed(1)} max=${Math.max(...dvol).toFixed(1)}`);
// AR(1) phi of DVOL level
{
  let sxy = 0, sxx = 0, sx = 0, sy = 0; const m = T - 1;
  for (let i = 1; i < T; i++) { sx += dvol[i - 1]; sy += dvol[i]; sxy += dvol[i - 1] * dvol[i]; sxx += dvol[i - 1] ** 2; }
  const phi = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  console.log(`DVOL AR(1) phi=${phi.toFixed(4)} (persistence)`);
}

const zL = rollingZ(dvol, 90);
const zMR = rollingZ(dvolMinusRv, 90);
for (const lag of [1, 2, 3, 5]) {
  const sigL: number[] = [], sigZ: number[] = [], sigMom: number[] = [], sigZMR: number[] = [], fr: number[] = [];
  for (let t = 0; t < T; t++) {
    const st = t - lag; if (st < 0) continue;
    if (!Number.isFinite(fwdRet[t])) continue;
    sigL.push(dvol[st]); sigZ.push(zL[st]); sigMom.push(dvolMom5[st]); sigZMR.push(zMR[st]); fr.push(fwdRet[t]);
  }
  console.log(`lag=${lag}: corr(DVOLlevel,fwd)=${corr(sigL, fr).toFixed(3)}  corr(zDVOL,fwd)=${corr(sigZ, fr).toFixed(3)}  corr(DVOLmom5,fwd)=${corr(sigMom, fr).toFixed(3)}  corr(z(DVOL-RV),fwd)=${corr(sigZMR, fr).toFixed(3)}`);
}

// regime split: mean fwd ret when zDVOL high (defensive/fear) vs low, lag1
for (const thr of [1.0, 1.5, 2.0]) {
  let hiSum = 0, hiN = 0, loSum = 0, loN = 0, midSum = 0, midN = 0;
  for (let t = 1; t < T; t++) {
    const z = zL[t - 1]; if (!Number.isFinite(z) || !Number.isFinite(fwdRet[t])) continue;
    if (z >= thr) { hiSum += fwdRet[t]; hiN++; }
    else if (z <= -thr) { loSum += fwdRet[t]; loN++; }
    else { midSum += fwdRet[t]; midN++; }
  }
  console.log(`thr z=±${thr}: HI-DVOL(fear) meanFwd=${(hiSum / hiN * 1e4).toFixed(1)}bps n=${hiN} | MID=${(midSum / midN * 1e4).toFixed(1)}bps n=${midN} | LO-DVOL(calm) meanFwd=${(loSum / loN * 1e4).toFixed(1)}bps n=${loN}`);
}
