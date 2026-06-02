/**
 * Q6-DVOLTS strengthening probe (pre-gauntlet diagnostics, not a separate selection):
 * Is there ANY orientation of the DVOL term-structure slope that beats the matched-exposure
 * always-short-vol control? We test both signs, multiple back-month proxies, and a "stress-revert"
 * variant (sell MORE in backwardation, betting on vol mean-reversion). Reported Sharpes are
 * full-sample net (diagnostic). The honest-N gauntlet remains run_dvolts.ts.
 */
import fs from "node:fs";

const ROOT = ".";
const P = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-quant/dvolts_panel.json`, "utf8"));
const dvol: number[] = P.dvol;
const price: number[] = P.price;
const rv: number[] = P.rv;
const T = dvol.length;
const ANN = Math.sqrt(365);
const dailyLogRet = new Array(T).fill(NaN);
for (let t = 1; t < T; t++) dailyLogRet[t] = Math.log(price[t] / price[t - 1]);

function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function sh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }
function ema(x: number[], span: number) { const a = 2 / (span + 1); const o = new Array(x.length).fill(NaN); let p = NaN; for (let i = 0; i < x.length; i++) { p = Number.isFinite(p) ? a * x[i] + (1 - a) * p : x[i]; o[i] = p; } return o; }
function sma(x: number[], w: number) { const o = new Array(x.length).fill(NaN); for (let i = w - 1; i < x.length; i++) { let s = 0, ok = true; for (let k = i - w + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; } if (ok) o[i] = s / w; } return o; }

const KAPPA = 0.5;
const carry = new Array(T).fill(NaN);
for (let t = 0; t < T - 1; t++) {
  const iv = dvol[t] / 100, rN = dailyLogRet[t + 1], dIv = (dvol[t + 1] - dvol[t]) / 100;
  if (!Number.isFinite(rN) || !Number.isFinite(dIv)) continue;
  carry[t] = 0.5 * (iv * iv) / 365 - 0.5 * rN * rN - KAPPA * dIv;
}
const COST = 0.0004;
function run(pos: number[], lo: number, hi: number) {
  const net: number[] = []; let prev = 0;
  for (let t = lo; t < hi; t++) { const c = carry[t]; const p = pos[t]; if (!Number.isFinite(c) || !Number.isFinite(p)) continue; net.push(p * c - Math.abs(p - prev) * COST); prev = p; }
  return net;
}
const start = 95, end = T - 2;

// matched-exposure always-short control at exposure e
function alwaysShort(e: number) { const pos = new Array(T).fill(e); return sh(run(pos, start, end)); }

// slope proxies
function slope(spanLong: number, kind: string) {
  if (kind === "ema") { const b = ema(dvol, spanLong); return dvol.map((d, t) => (Number.isFinite(b[t]) && b[t] > 0 ? d / b[t] : NaN)); }
  if (kind === "sma") { const b = sma(dvol, spanLong); return dvol.map((d, t) => (Number.isFinite(b[t]) && b[t] > 0 ? d / b[t] : NaN)); }
  // 'rvanchor': front IV vs trailing realized vol (a true 2-tenor proxy: 30d IV / 30d RV)
  return dvol.map((d, t) => (Number.isFinite(rv[t]) && rv[t] > 0 ? d / rv[t] : NaN));
}

console.log("orientation test: does any term-structure book beat matched-exposure always-short?\n");
let bestBeat = -Infinity; let bestTag = "";
for (const kind of ["ema", "sma", "rvanchor"]) {
  for (const spanLong of [30, 45, 60, 90]) {
    const sl = slope(spanLong, kind);
    if (kind === "rvanchor" && spanLong !== 30) continue; // rvanchor span-independent
    for (const orient of ["contangoShort", "backwdShort"]) {
      for (const thr of [0, 0.02, 0.05]) {
        const pos = new Array(T).fill(0);
        const piv = kind === "rvanchor" ? 1.0 : 1.0;
        for (let t = 0; t < T; t++) {
          const s = sl[t]; if (!Number.isFinite(s)) continue;
          if (orient === "contangoShort") pos[t] = s < piv - thr ? 1 : 0; // short when front cheap (contango)
          else pos[t] = s > piv + thr ? 1 : 0; // short when front rich/backwardated (stress-revert)
        }
        const net = run(pos, start, end);
        const e = net.length ? pos.slice(start, end).filter((x) => x > 0).length / (end - start) : 0;
        const s = sh(net);
        const ctrl = alwaysShort(e);
        const beat = s - ctrl;
        if (beat > bestBeat) { bestBeat = beat; bestTag = `${kind} span=${spanLong} ${orient} thr=${thr}`; }
        if (Math.abs(thr - 0.02) < 1e-9)
          console.log(`${kind} span=${spanLong} ${orient} thr=${thr}: book=${s.toFixed(3)} vs alwaysShort(e=${e.toFixed(2)})=${ctrl.toFixed(3)} delta=${beat.toFixed(3)}`);
      }
    }
  }
}
console.log(`\nBEST term-structure book vs its matched control: delta=${bestBeat.toFixed(3)} @ ${bestTag}`);
console.log(`(delta>0 means term-structure timing adds over always-short. delta<=0 means it does NOT.)`);
console.log(`\nfull-notional always-short Sharpe = ${alwaysShort(1).toFixed(3)} (the unconditional VRP carry)`);
