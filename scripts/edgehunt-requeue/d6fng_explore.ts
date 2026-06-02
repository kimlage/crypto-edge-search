/**
 * D6-FNG exploratory analysis (no gates yet) — understand the raw predictive
 * content of the Crypto Fear & Greed Index before committing the gauntlet.
 *
 * Questions:
 *  1) Is FNG a lagged transform of price? corr(FNG_t, past BTC ret) vs corr(FNG_t, fwd BTC ret).
 *  2) Granger direction: does BTC return Granger-cause FNG, or vice versa?
 *  3) Raw predictive content: corr(FNG_{t-1}, fwd BTC ret) and decile sort.
 *  4) AR(1) structure of FNG (phi, sigma) for the matched placebo.
 */
import fs from "node:fs";

const ROOT = ".";

// ---- load FNG daily (value 0..100, classification) keyed by ISO date ----
function loadFng(): Map<string, number> {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D6/fng_history.json`, "utf8"));
  const m = new Map<string, number>();
  for (const r of j.data) {
    const d = new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10);
    m.set(d, Number(r.value));
  }
  return m;
}

// ---- load BTC daily close (nf1 OHLC primary, CM tail) ----
function loadBtc(): Map<string, number> {
  const out = new Map<string, number>();
  const nf1 = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Array<{
    date: string;
    close: number;
  }>;
  for (const r of nf1) if (r.date && Number.isFinite(r.close)) out.set(r.date, r.close);
  const cm = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_btc.json`, "utf8")) as {
    data: Array<{ time: string; PriceUSD?: string }>;
  };
  for (const r of cm.data) {
    if (!r.PriceUSD) continue;
    const d = r.time.slice(0, 10);
    if (!out.has(d)) {
      const px = Number(r.PriceUSD);
      if (Number.isFinite(px)) out.set(d, px);
    }
  }
  return out;
}

function mean(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]) {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
}
function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n)),
    mb = mean(b.slice(0, n));
  let cov = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma,
      db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

const fng = loadFng();
const btc = loadBtc();

// aligned dates where both exist
const dates = [...fng.keys()].filter((d) => btc.has(d)).sort();
const fv: number[] = [];
const px: number[] = [];
for (const d of dates) {
  fv.push(fng.get(d)!);
  px.push(btc.get(d)!);
}
const T = dates.length;
const ret: number[] = new Array(T).fill(NaN); // ret[t] = log px[t]/px[t-1] (return INTO day t)
for (let t = 1; t < T; t++) ret[t] = Math.log(px[t] / px[t - 1]);
const fwd: number[] = new Array(T).fill(NaN); // fwd[t] = log px[t+1]/px[t]
for (let t = 0; t < T - 1; t++) fwd[t] = Math.log(px[t + 1] / px[t]);

console.log(`aligned days: ${T}  (${dates[0]}..${dates[T - 1]})`);

// ---- Q1: is FNG a lagged transform of price? ----
// corr(FNG_t, past k-day BTC ret) for k=1..5 vs corr(FNG_t, fwd k-day ret)
function pastRet(t: number, k: number) {
  if (t - k < 0) return NaN;
  return Math.log(px[t] / px[t - k]);
}
function fwdRet(t: number, k: number) {
  if (t + k >= T) return NaN;
  return Math.log(px[t + k] / px[t]);
}
console.log("\n--- Q1: FNG_t vs price (is sentiment a price echo?) ---");
for (const k of [1, 2, 3, 5, 7]) {
  const A: number[] = [],
    Bp: number[] = [],
    Bf: number[] = [];
  for (let t = 0; t < T; t++) {
    const p = pastRet(t, k),
      f = fwdRet(t, k);
    if (Number.isFinite(p)) {
      A.push(fv[t]);
      Bp.push(p);
    }
  }
  const A2: number[] = [],
    F2: number[] = [];
  for (let t = 0; t < T; t++) {
    const f = fwdRet(t, k);
    if (Number.isFinite(f)) {
      A2.push(fv[t]);
      F2.push(f);
    }
  }
  console.log(
    `  k=${k}: corr(FNG_t, PAST ${k}d ret)=${corr(A, Bp).toFixed(3)}   corr(FNG_t, FWD ${k}d ret)=${corr(A2, F2).toFixed(3)}`,
  );
}

// ---- Q2: change in FNG vs same-day & lagged return ----
console.log("\n--- Q2: dFNG_t vs returns ---");
const dfng: number[] = new Array(T).fill(NaN);
for (let t = 1; t < T; t++) dfng[t] = fv[t] - fv[t - 1];
{
  // corr(dFNG_t, ret_t)  [coincident]; corr(dFNG_t, ret_{t-1}) [does price lead?]; corr(dFNG_t, fwd) [does FNG lead?]
  const co_a: number[] = [],
    co_b: number[] = [];
  const lag_a: number[] = [],
    lag_b: number[] = [];
  const lead_a: number[] = [],
    lead_b: number[] = [];
  for (let t = 1; t < T; t++) {
    if (Number.isFinite(dfng[t]) && Number.isFinite(ret[t])) {
      co_a.push(dfng[t]);
      co_b.push(ret[t]);
    }
    if (Number.isFinite(dfng[t]) && Number.isFinite(ret[t - 1])) {
      lag_a.push(dfng[t]);
      lag_b.push(ret[t - 1]);
    }
    if (Number.isFinite(dfng[t]) && Number.isFinite(fwd[t])) {
      lead_a.push(dfng[t]);
      lead_b.push(fwd[t]);
    }
  }
  console.log(`  corr(dFNG_t, ret_t)    [coincident]      = ${corr(co_a, co_b).toFixed(3)}`);
  console.log(`  corr(dFNG_t, ret_{t-1})[price leads FNG?] = ${corr(lag_a, lag_b).toFixed(3)}`);
  console.log(`  corr(dFNG_t, fwd ret)  [FNG leads price?] = ${corr(lead_a, lead_b).toFixed(3)}`);
}

// ---- Q3: raw predictive content of LAGGED FNG level on fwd return ----
console.log("\n--- Q3: contrarian predictive content (STRICTLY LAGGED: FNG known at close t -> fwd[t]) ---");
{
  const a: number[] = [],
    b: number[] = [];
  for (let t = 0; t < T; t++) {
    if (Number.isFinite(fwd[t])) {
      a.push(fv[t]); // FNG at close t (known)
      b.push(fwd[t]); // return t->t+1
    }
  }
  // contrarian => negative corr (low FNG = fear = buy)
  console.log(`  corr(FNG_t, fwd ret) = ${corr(a, b).toFixed(4)}  (contrarian wants NEGATIVE)`);
  // decile sort
  const idx = a.map((_, i) => i).sort((i, j) => a[i] - a[j]);
  const nq = 5;
  const sz = Math.floor(idx.length / nq);
  for (let q = 0; q < nq; q++) {
    const lo = q * sz,
      hi = q === nq - 1 ? idx.length : lo + sz;
    const sub = idx.slice(lo, hi).map((i) => b[i]);
    const fsub = idx.slice(lo, hi).map((i) => a[i]);
    console.log(
      `  Q${q + 1} FNG[${Math.min(...fsub).toFixed(0)}..${Math.max(...fsub).toFixed(0)}] meanFwdRet=${(mean(sub) * 1e4).toFixed(2)}bps  hitUp=${(sub.filter((x) => x > 0).length / sub.length).toFixed(3)}  n=${sub.length}`,
    );
  }
}

// ---- Q4: AR(1) structure of FNG level ----
console.log("\n--- Q4: AR(1) structure of FNG (for matched placebo) ---");
{
  const lv = fv.slice();
  let sxy = 0,
    sxx = 0,
    sx = 0,
    sy = 0;
  const m = lv.length - 1;
  for (let i = 1; i < lv.length; i++) {
    sx += lv[i - 1];
    sy += lv[i];
    sxy += lv[i - 1] * lv[i];
    sxx += lv[i - 1] * lv[i - 1];
  }
  const phi = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  const c = (sy - phi * sx) / m;
  let sse = 0;
  for (let i = 1; i < lv.length; i++) {
    const e = lv[i] - (c + phi * lv[i - 1]);
    sse += e * e;
  }
  const sigma = Math.sqrt(sse / (m - 2));
  console.log(`  AR(1): phi=${phi.toFixed(4)} c=${c.toFixed(3)} sigma_innov=${sigma.toFixed(3)} mean=${mean(lv).toFixed(2)} sd=${std(lv).toFixed(2)}`);
  // lag-1..lag-5 autocorr
  for (const k of [1, 5, 10, 20]) {
    const a: number[] = [],
      b: number[] = [];
    for (let i = k; i < lv.length; i++) {
      a.push(lv[i]);
      b.push(lv[i - k]);
    }
    console.log(`  autocorr lag ${k} = ${corr(a, b).toFixed(3)}`);
  }
}
