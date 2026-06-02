/**
 * O3-NVTS probe #2 (mine): is the fee-NVTS signal anything BEYOND price/long-beta?
 *   (a) orthogonalize fee-NVTS-z against trailing price-momentum (the "valuation ratio = long-beta
 *       in disguise" trap) and re-check forward-return buckets.
 *   (b) compare to a pure price-clock z (does on-chain denominator add anything over price alone?).
 *   (c) multi-horizon forward returns (1d, 5d, 20d).
 */
import { loadNvtPanel, throughput, type NvtPanel } from "./load_nvt.ts";

function sma(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; let s = 0, ok = true; for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; } if (ok) out[i] = s / win; } return out; }
function rollingZ(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { const lo = Math.max(0, i - win + 1); const w: number[] = []; for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length < 60) continue; const m = w.reduce((s, v) => s + v, 0) / w.length; const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1)); out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0; } return out; }
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function fwdH(price: number[], h: number): number[] { const o = new Array(price.length).fill(NaN); for (let t = 0; t + h < price.length; t++) o[t] = Math.log(price[t + h] / price[t]) / h; return o; }
function momZ(price: number[]): number[] { const r = new Array(price.length).fill(NaN); for (let t = 90; t < price.length; t++) r[t] = Math.log(price[t] / price[t - 90]); return rollingZ(r, 365); }
function residualize(a: number[], b: number[]): number[] { const xs: number[] = [], ys: number[] = [], idx: number[] = []; for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(b[i]); ys.push(a[i]); idx.push(i); } const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } const beta = sxy / sxx, alpha = my - beta * mx; const out = new Array(a.length).fill(NaN); for (let i = 0; i < idx.length; i++) out[idx[i]] = ys[i] - (alpha + beta * xs[i]); return out; }
function buckets(zL: number[], fwd: number[], q = 5): string { const pairs: { z: number; r: number }[] = []; for (let t = 0; t < zL.length; t++) if (Number.isFinite(zL[t]) && Number.isFinite(fwd[t])) pairs.push({ z: zL[t], r: fwd[t] }); pairs.sort((a, b) => a.z - b.z); const sz = Math.floor(pairs.length / q); const out: string[] = []; for (let i = 0; i < q; i++) { const sl = pairs.slice(i * sz, i === q - 1 ? pairs.length : (i + 1) * sz); out.push(`Q${i + 1}=${(mean(sl.map((p) => p.r)) * 1e4).toFixed(1)}`); } return out.join(" ") + ` (n=${pairs.length})`; }

function probe(asset: "btc" | "eth") {
  const P = loadNvtPanel(asset);
  const thr = sma(throughput(P, "fee"), 90);
  const nv = P.marketCap.map((mc, t) => (mc > 0 && thr[t] > 0 ? mc / thr[t] : NaN));
  const z = rollingZ(nv, 365);
  const zL = lag(z, 1);
  const zOrth = lag(residualize(z, momZ(P.price)), 1);
  const priceZ = lag(rollingZ(P.price.map((p) => Math.log(p)), 365), 1);
  console.log(`\n===== ${asset.toUpperCase()} =====`);
  for (const h of [1, 5, 20]) {
    const fwd = fwdH(P.price, h);
    console.log(`  H=${h}d feeNVTS-z:      ${buckets(zL, fwd)}`);
    console.log(`        orthog-vs-mom:   ${buckets(zOrth, fwd)}`);
    console.log(`        price-clock-z:   ${buckets(priceZ, fwd)}`);
  }
}
probe("btc");
probe("eth");
