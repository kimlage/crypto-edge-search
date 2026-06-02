/**
 * O3-NVTS probe: characterize the raw predictive content of free NVTS proxies BEFORE the gauntlet.
 * Strictly causal: NVTS computed from throughput smoothed (SMA90), z-scored on trailing window,
 * lagged >=1 day, then bucketed by quintile of forward return.
 */
import { loadNvtPanel, throughput, type NvtPanel } from "./load_nvt.ts";

function sma(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < win) continue;
    let s = 0, ok = true;
    for (let k = i - win + 1; k <= i; k++) {
      if (!Number.isFinite(x[k])) { ok = false; break; }
      s += x[k];
    }
    if (ok) out[i] = s / win;
  }
  return out;
}
function rollingZ(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - win + 1);
    const w: number[] = [];
    for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]);
    if (w.length < Math.min(60, win)) continue;
    const m = w.reduce((s, v) => s + v, 0) / w.length;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1));
    out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0;
  }
  return out;
}
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function corr(a: number[], b: number[]): number {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  const mx = mean(xs), my = mean(ys);
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return n / Math.sqrt(dx * dy);
}

function nvts(P: NvtPanel, kind: string, smaWin: number): number[] {
  const thr = throughput(P, kind);
  const thrSm = sma(thr, smaWin);
  // NVT = MarketCap / smoothed throughput
  return P.marketCap.map((mc, t) => (mc > 0 && thrSm[t] > 0 ? mc / thrSm[t] : NaN));
}

function probe(asset: "btc" | "eth") {
  const P = loadNvtPanel(asset);
  console.log(`\n========== ${asset.toUpperCase()} n=${P.price.length} (${P.dates[0]}..${P.dates[P.dates.length - 1]}) ==========`);
  for (const kind of ["fee", "tx", "tfr", "feeNtv"]) {
    const nv = nvts(P, kind, 90);
    const z = rollingZ(nv, 365);
    const zL = lag(z, 1); // causal
    // correlation of lagged-z with forward return
    const c = corr(zL, P.fwdRet);
    // quintile buckets of zL -> mean fwdRet
    const pairs: { z: number; r: number }[] = [];
    for (let t = 0; t < P.price.length; t++) if (Number.isFinite(zL[t]) && Number.isFinite(P.fwdRet[t])) pairs.push({ z: zL[t], r: P.fwdRet[t] });
    pairs.sort((a, b) => a.z - b.z);
    const q = 5, sz = Math.floor(pairs.length / q);
    const buckets: string[] = [];
    for (let i = 0; i < q; i++) {
      const slice = pairs.slice(i * sz, i === q - 1 ? pairs.length : (i + 1) * sz);
      const mr = mean(slice.map((p) => p.r));
      buckets.push(`Q${i + 1}[z~${mean(slice.map((p) => p.z)).toFixed(2)}]=${(mr * 1e4).toFixed(1)}bp/d`);
    }
    console.log(`  ${kind.padEnd(7)} n=${pairs.length} corr(zL,fwd)=${c.toFixed(4)}`);
    console.log(`      ${buckets.join("  ")}`);
  }
  // long-beta reference: mean daily fwdRet (buy&hold) over full sample
  const r = P.fwdRet.filter((v) => Number.isFinite(v));
  console.log(`  [ref] buy&hold meanDaily=${(mean(r) * 1e4).toFixed(1)}bp  ann=${(mean(r) * 365 * 100).toFixed(1)}%`);
}

probe("btc");
probe("eth");
