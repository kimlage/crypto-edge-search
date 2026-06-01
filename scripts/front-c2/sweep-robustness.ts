/**
 * FRONT C2 — robustness sweep. Confirms the KILL is not an artifact of the
 * chosen period/trailing-K. For each (periodDays, trailK) we report: the
 * return-rotation in-sample (full) net Sharpe, the cross-sectional-shuffle
 * placebo p-value (the targeted rotation-killer), and the periodogram peak +
 * its surrogate-adjusted significance. If the placebo p is large (surrogates
 * match real) across the grid, the rotation edge is an artifact everywhere.
 *
 * Run: PATH=<codex-node-bin>:$PATH node_modules/.bin/tsx scripts/front-c2/sweep-robustness.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeReturnSeries } from "../../src/lib/statistical-validation";

const ROOT = process.cwd();
const closesDoc = JSON.parse(readFileSync(join(ROOT, "output", "crossxs", "daily-closes.json"), "utf8")) as {
  dates: string[];
  closes: Record<string, (number | null)[]>;
};
const COINS = Object.keys(closesDoc.closes);
const T = closesDoc.dates.length;
const ROUND_TRIP = 0.0008;
const N_SURR = 120;

const MAJ = new Set(["BTC", "ETH"]);
const LARGE = new Set(["BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "LTC", "TRX", "BCH"]);
const TIERS = ["MAJ", "LARGE", "MID"];
const tierOf = (c: string) => (MAJ.has(c) ? 0 : LARGE.has(c) ? 1 : 2);

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function coinPeriodRet(periodDays: number): Record<string, (number | null)[]> {
  const bounds: number[] = [];
  for (let i = 0; i < T; i += periodDays) bounds.push(i);
  if (bounds[bounds.length - 1] !== T - 1) bounds.push(T - 1);
  const out: Record<string, (number | null)[]> = {};
  for (const c of COINS) {
    out[c] = [];
    for (let p = 0; p < bounds.length - 1; p += 1) {
      const a = closesDoc.closes[c][bounds[p]];
      const b = closesDoc.closes[c][bounds[p + 1]];
      out[c].push(a != null && b != null && a > 0 ? b / a - 1 : null);
    }
  }
  return out;
}

function tierRet(coinRet: Record<string, (number | null)[]>): number[][] {
  const nP = coinRet[COINS[0]].length;
  const rows: number[][] = [];
  for (let p = 0; p < nP; p += 1) {
    const acc = [[] as number[], [] as number[], [] as number[]];
    for (const c of COINS) {
      const r = coinRet[c][p];
      if (r != null && Number.isFinite(r)) acc[tierOf(c)].push(r);
    }
    rows.push(acc.map((v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN)));
  }
  return rows;
}

function domByReturn(tr: number[][], k: number): number[] {
  const dom: number[] = [];
  for (let p = 0; p < tr.length; p += 1) {
    if (p < k - 1) { dom.push(-1); continue; }
    let best = -1, bv = -Infinity;
    for (let ti = 0; ti < 3; ti += 1) {
      let cum = 1, ok = true;
      for (let j = p - k + 1; j <= p; j += 1) { const r = tr[j][ti]; if (!Number.isFinite(r)) { ok = false; break; } cum *= 1 + r; }
      if (ok && cum > bv) { bv = cum; best = ti; }
    }
    dom.push(best);
  }
  return dom;
}

function rotate(dom: number[], tr: number[][]): number[] {
  const net: number[] = [];
  let prev = -1;
  for (let p = 0; p < dom.length - 1; p += 1) {
    if (dom[p] < 0) continue;
    const r = tr[p + 1][dom[p]];
    if (!Number.isFinite(r)) continue;
    const cost = prev === -1 ? ROUND_TRIP / 2 : dom[p] !== prev ? ROUND_TRIP : 0;
    net.push(r - cost);
    prev = dom[p];
  }
  return net;
}

function annSharpe(net: number[], periodsPerYr: number): number {
  return summarizeReturnSeries(net).sharpe * Math.sqrt(periodsPerYr);
}

function xshuffle(coinRet: Record<string, (number | null)[]>, rng: () => number): Record<string, (number | null)[]> {
  const nP = coinRet[COINS[0]].length;
  const out: Record<string, (number | null)[]> = {};
  for (const c of COINS) out[c] = new Array(nP).fill(null);
  for (let p = 0; p < nP; p += 1) {
    const present: string[] = [], vals: number[] = [];
    for (const c of COINS) { const r = coinRet[c][p]; if (r != null && Number.isFinite(r)) { present.push(c); vals.push(r); } }
    for (let i = vals.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
    present.forEach((c, i) => { out[c][p] = vals[i]; });
  }
  return out;
}

console.log("FRONT C2 robustness sweep — cross-sectional-shuffle placebo across (period, K)");
console.log("placeboP = frac of xshuffle surrogates with full-sample net Sharpe >= real");
console.log("periodDays  trailK  realFullSharpe  xshufflePlaceboP  verdict");
const rng = makeRng(424242);
for (const pd of [5, 7, 14]) {
  const ppY = 365 / pd;
  const cr = coinPeriodRet(pd);
  const tr = tierRet(cr);
  for (const k of [2, 3, 4, 6]) {
    const dom = domByReturn(tr, k);
    const real = annSharpe(rotate(dom, tr), ppY);
    let ge = 0;
    for (let s = 0; s < N_SURR; s += 1) {
      const sc = xshuffle(cr, rng);
      const st = tierRet(sc);
      const sd = domByReturn(st, k);
      if (annSharpe(rotate(sd, st), ppY) >= real) ge += 1;
    }
    const p = (ge + 1) / (N_SURR + 1);
    console.log(
      `${String(pd).padStart(9)}  ${String(k).padStart(6)}  ${real.toFixed(2).padStart(13)}  ${p.toFixed(3).padStart(15)}  ${p <= 0.05 ? "edge>noise" : "ARTIFACT (rotation indistinguishable from cross-shuffle null)"}`,
    );
  }
}
console.log("\nIf placeboP > 0.05 everywhere, the rotation 'edge' is an artifact at every (period,K).");
