/**
 * D2-LIQ strengthening diagnostic: is there ANY raw (gross, pre-cost) cascade
 * effect to harvest before we worry about brackets/cost?  For each adverse-spike
 * definition, compute the AVERAGE forward log-return over h=1..N bars AFTER the
 * spike (strictly lagged, entry next-bar open), split by:
 *   - all large adverse down spikes  (long-liq cascades)
 *   - large adverse down spikes WITH a sell-flow flip (the cascade signature)
 *   - large adverse up spikes (short-liq cascades) with buy-flow flip
 * Report mean forward ret + t-stat per horizon.  If even the GROSS conditional
 * mean is ~0 / wrong-sign, there is nothing to bracket.  Pure diagnostic, no
 * config selection.
 */
import { readFileSync } from "node:fs";
import type { Bar } from "./lib.ts";

const bars = JSON.parse(readFileSync("output/edgehunt-D2/btc_15m_flow.json", "utf8")) as Bar[];
const n = bars.length;
const r = new Array(n).fill(0);
for (let i = 1; i < n; i += 1) r[i] = Math.log(bars[i].c / bars[i - 1].c);
const of = bars.map((b) => (b.v > 0 ? (2 * b.tbb - b.v) / b.v : 0));
const vol = bars.map((b) => b.v);

function rollingZ(x: number[], w: number): number[] {
  const out = new Array(x.length).fill(0); let s = 0, s2 = 0; const buf: number[] = [];
  for (let i = 0; i < x.length; i += 1) {
    buf.push(x[i]); s += x[i]; s2 += x[i] * x[i];
    if (buf.length > w) { const o = buf.shift()!; s -= o; s2 -= o * o; }
    const m = s / buf.length; const v = Math.max(0, s2 / buf.length - m * m); const sd = Math.sqrt(v);
    out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0;
  }
  return out;
}
const rZ = rollingZ(r, 96);
const vZ = rollingZ(vol, 96);
const ofTrail = (() => { const w = 8; const out = new Array(n).fill(0); let acc = 0; const buf: number[] = []; for (let i = 0; i < n; i += 1) { out[i] = buf.length ? acc / buf.length : 0; buf.push(of[i]); acc += of[i]; if (buf.length > w) acc -= buf.shift()!; } return out; })();

// forward cumulative log-return from entry (open of i+1) to close of i+h
function fwd(i: number, h: number): number {
  const entry = i + 1; if (entry >= n) return NaN;
  const exit = Math.min(i + h, n - 1);
  return Math.log(bars[exit].c / bars[entry].o);
}

function stats(xs: number[]): { mean: number; t: number; nn: number } {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 5) return { mean: 0, t: 0, nn: v.length };
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  return { mean: m, t: sd > 1e-12 ? (m / sd) * Math.sqrt(v.length) : 0, nn: v.length };
}

const horizons = [1, 2, 4, 8, 16, 24, 48];
const rs = 3, vz = 1.0, ft = 0.3;

// down-spike sets
const allDown: number[] = [];
const flipDown: number[] = [];
const allUp: number[] = [];
const flipUp: number[] = [];
for (let i = 0; i < n - 1; i += 1) {
  const down = rZ[i] < -rs && vZ[i] > vz;
  const up = rZ[i] > rs && vZ[i] > vz;
  if (down) { allDown.push(i); if (of[i] < -ft && ofTrail[i] > 0) flipDown.push(i); }
  if (up) { allUp.push(i); if (of[i] > ft && ofTrail[i] < 0) flipUp.push(i); }
}

console.log(`triggers: allDown=${allDown.length} flipDown=${flipDown.length} allUp=${allUp.length} flipUp=${flipUp.length}`);
console.log(`\nForward mean log-ret (%) and t-stat by horizon (rs=${rs}, vz>${vz}, flip|of|>${ft}):`);
console.log(`(positive forward ret after a DOWN spike => FADE works; negative => FOLLOW works)`);
for (const set of [["DOWN all", allDown], ["DOWN flip", flipDown], ["UP all", allUp], ["UP flip", flipUp]] as const) {
  const [lab, idxs] = set;
  let line = `  ${lab.padEnd(10)} (n=${idxs.length.toString().padStart(4)}): `;
  for (const h of horizons) {
    const st = stats(idxs.map((i) => fwd(i, h)));
    line += `h${h}: ${(st.mean * 100).toFixed(2)}%(t${st.t.toFixed(1)})  `;
  }
  console.log(line);
}

// Net-of-cost reachable? round-trip 8bps. Compare mean |fwd| to cost.
console.log(`\nround-trip taker cost = 8 bps = 0.08%. Any mean above ~0.08% (abs) is gross-positive net.`);
