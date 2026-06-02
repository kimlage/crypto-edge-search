/**
 * Q6-DVOLTS robustness probe: is the surviving "backwardation-short" edge a real timing edge,
 * or an ARTIFACT of the vega term in my carry model (which assumes DVOL mean-reverts)?
 *
 * A short variance swap held to maturity earns theta - gamma = (IV^2 - RV^2)/period; it has NO
 * daily vega MTM if held to expiry. The daily vega term I added (-KAPPA*ΔDVOL) is a marking
 * convention that mechanically rewards "short when DVOL is high" because high DVOL mean-reverts down.
 * If the edge VANISHES without the vega term, it is not a tradeable term-structure edge.
 *
 * We re-run the best backwd-short book and the matched control under 3 carry models:
 *   A. full (theta - gamma - vega)  [what survived]
 *   B. no-vega (theta - gamma)      [held-to-maturity variance swap]
 *   C. vega-only (-vega)            [pure short-vol-of-vol; isolates the suspected artifact]
 */
import fs from "node:fs";
const ROOT = ".";
const P = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-quant/dvolts_panel.json`, "utf8"));
const dvol: number[] = P.dvol, price: number[] = P.price;
const T = dvol.length, ANN = Math.sqrt(365);
const dlr = new Array(T).fill(NaN);
for (let t = 1; t < T; t++) dlr[t] = Math.log(price[t] / price[t - 1]);
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function sh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }
function ema(x: number[], span: number) { const a = 2 / (span + 1); const o = new Array(x.length).fill(NaN); let p = NaN; for (let i = 0; i < x.length; i++) { p = Number.isFinite(p) ? a * x[i] + (1 - a) * p : x[i]; o[i] = p; } return o; }
const KAPPA = 0.5, COST = 0.0004, start = 95, end = T - 2;

function carryModel(kind: string) {
  const c = new Array(T).fill(NaN);
  for (let t = 0; t < T - 1; t++) {
    const iv = dvol[t] / 100, rN = dlr[t + 1], dIv = (dvol[t + 1] - dvol[t]) / 100;
    if (!Number.isFinite(rN) || !Number.isFinite(dIv)) continue;
    const theta = 0.5 * iv * iv / 365, gamma = 0.5 * rN * rN, vega = -KAPPA * dIv;
    if (kind === "full") c[t] = theta - gamma + vega;
    else if (kind === "novega") c[t] = theta - gamma;
    else c[t] = vega; // vega-only
  }
  return c;
}
function run(pos: number[], carry: number[]) { const net: number[] = []; let prev = 0; for (let t = start; t < end; t++) { const cc = carry[t], p = pos[t]; if (!Number.isFinite(cc) || !Number.isFinite(p)) continue; net.push(p * cc - Math.abs(p - prev) * COST); prev = p; } return net; }

// best backwd-short book: span=60 gatesoft thr=0.05
const back = ema(dvol, 60);
const slope = dvol.map((d, t) => (Number.isFinite(back[t]) && back[t] > 0 ? d / back[t] : NaN));
const thr = 0.05;
const posBackwd = new Array(T).fill(0);
for (let t = 0; t < T; t++) { const s = slope[t]; if (!Number.isFinite(s)) continue; const dev = s - 1; posBackwd[t] = dev > thr ? 1 : dev > -thr ? 0.5 : 0; }
const e = posBackwd.slice(start, end).filter(Number.isFinite).reduce((a, b) => a + b, 0) / (end - start);
const posCtrl = new Array(T).fill(e);

console.log("carry model | backwdShort book Sharpe | matched-exposure always-short | delta(timing edge)");
for (const k of ["full", "novega", "vegaonly"]) {
  const c = carryModel(k);
  const sBook = sh(run(posBackwd, c));
  const sCtrl = sh(run(posCtrl, c));
  console.log(`  ${k.padEnd(9)} | book=${sBook.toFixed(3)} | ctrl=${sCtrl.toFixed(3)} | delta=${(sBook - sCtrl).toFixed(3)}`);
}
console.log("\nIf delta>0 only under 'full'/'vegaonly' but ~0 under 'novega', the edge is the vega-marking artifact");
console.log("(mechanically: short-vol when DVOL high earns because DVOL mean-reverts in the model, not a real term-structure edge).");
