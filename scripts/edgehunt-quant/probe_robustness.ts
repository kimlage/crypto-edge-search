/**
 * Q6-DVOLTS final robustness check under the HONEST held-to-maturity variance-swap carry
 * (theta - gamma, no vega artifact). Two questions:
 *   1. Across ALL 288 configs, what fraction of term-structure-timed books beat the matched-exposure
 *      always-short control (delta>0)? A real edge -> most configs beat; overfit -> a lucky few do.
 *   2. Is the in-sample best's edge stable OUT-OF-SAMPLE? Select best IN-SAMPLE by delta-vs-control,
 *      then measure its delta-vs-control on the holdout (consume-once).
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
const COST = 0.0004, start = 95, end = T - 2, split = start + Math.floor((end - start) * 0.8);

const carry = new Array(T).fill(NaN);
for (let t = 0; t < T - 1; t++) { const iv = dvol[t] / 100, rN = dlr[t + 1]; if (!Number.isFinite(rN)) continue; carry[t] = 0.5 * iv * iv / 365 - 0.5 * rN * rN; }
function run(pos: number[], lo: number, hi: number) { const net: number[] = []; let prev = 0; for (let t = lo; t < hi; t++) { const cc = carry[t], p = pos[t]; if (!Number.isFinite(cc) || !Number.isFinite(p)) continue; net.push(p * cc - Math.abs(p - prev) * COST); prev = p; } return net; }
function buildPos(orient: string, spanLong: number, mode: string, thr: number) {
  const back = ema(dvol, spanLong);
  const slope = dvol.map((d, t) => (Number.isFinite(back[t]) && back[t] > 0 ? d / back[t] : NaN));
  const pos = new Array(T).fill(0);
  for (let t = 0; t < T; t++) { const s = slope[t]; if (!Number.isFinite(s)) continue; const dev = orient === "contango" ? 1 - s : s - 1; if (mode === "gate") pos[t] = dev > thr ? 1 : 0; else if (mode === "size") pos[t] = Math.max(0, Math.min(1, dev / Math.max(0.01, thr))); else pos[t] = dev > thr ? 1 : dev > -thr ? 0.5 : 0; }
  return pos;
}

const rows: { tag: string; deltaIS: number; e: number; pos: number[] }[] = [];
for (const orient of ["contango", "backwd"]) for (const spanLong of [30, 45, 60, 90]) for (const mode of ["gate", "size", "gatesoft"]) for (const thr of [0.0, 0.02, 0.05, 0.08]) {
  const pos = buildPos(orient, spanLong, mode, thr);
  const e = pos.slice(start, split).filter(Number.isFinite).reduce((a, b) => a + b, 0) / (split - start);
  const ctrlPos = new Array(T).fill(e);
  const sBook = sh(run(pos, start, split)), sCtrl = sh(run(ctrlPos, start, split));
  rows.push({ tag: `${orient},span=${spanLong},${mode},thr=${thr}`, deltaIS: sBook - sCtrl, e, pos });
}
const beat = rows.filter((r) => r.deltaIS > 0).length;
console.log(`Q1: ${beat}/${rows.length} configs beat their matched-exposure control IN-SAMPLE (delta>0).`);
console.log(`    median delta=${[...rows].map((r) => r.deltaIS).sort((a, b) => a - b)[Math.floor(rows.length / 2)].toFixed(3)} max=${Math.max(...rows.map((r) => r.deltaIS)).toFixed(3)} min=${Math.min(...rows.map((r) => r.deltaIS)).toFixed(3)}`);

// Q2: select best-by-delta IS, measure delta OOS (holdout)
rows.sort((a, b) => b.deltaIS - a.deltaIS);
console.log(`\nTop-5 by IS delta-vs-control, with their OOS holdout delta-vs-control:`);
for (const r of rows.slice(0, 5)) {
  const ctrlPos = new Array(T).fill(r.e);
  const sBookOOS = sh(run(r.pos, split, end)), sCtrlOOS = sh(run(ctrlPos, split, end));
  console.log(`  ${r.tag.padEnd(34)} IS_delta=${r.deltaIS.toFixed(3)}  OOS_book=${sBookOOS.toFixed(3)} OOS_ctrl=${sCtrlOOS.toFixed(3)} OOS_delta=${(sBookOOS - sCtrlOOS).toFixed(3)}`);
}
const top = rows[0];
const ctrlPos = new Array(T).fill(top.e);
const oosDelta = sh(run(top.pos, split, end)) - sh(run(ctrlPos, split, end));
console.log(`\nCONCLUSION: IS-best edge over control = ${top.deltaIS.toFixed(3)}; same book's OOS edge over control = ${oosDelta.toFixed(3)}.`);
console.log(`(If OOS_delta<=0, the term-structure timing does NOT add over always-short out-of-sample.)`);
