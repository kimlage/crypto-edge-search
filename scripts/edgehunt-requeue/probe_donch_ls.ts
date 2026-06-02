/**
 * D1-LS-DONCH probe: cross-sectional Donchian channel-position long-short.
 *
 * Channel position of coin i at day t (Donchian, causal, on closes):
 *   cp_i = (close_i - rollingMin_N) / (rollingMax_N - rollingMin_N)   in [0,1]
 *   cp=1 -> at top of its N-day channel (breakout strength up)
 *   cp=0 -> at bottom of its N-day channel
 * Cross-sectional rank-based dollar-neutral book: long top-K cp, short bottom-K cp.
 * Breakout claim: long HIGH cp, short LOW cp (momentum-of-channel).
 * (We also report the reverse direction to be honest about which way it leans.)
 *
 * This probe is exploratory: prints gross/net daily-rebalanced Sharpe across lookbacks,
 * quantile fractions, both directions. NO gates yet.
 */
import fs from "node:fs";

const ROOT = ".";
const ANN = Math.sqrt(365);
const COST_PER_SIDE = 0.0004; // 4bps taker/side

type Closes = { dates: string[]; closes: Record<string, number[]> };
const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/crossxs/daily-closes.json`, "utf8")) as Closes;
const dates = raw.dates;
const syms = Object.keys(raw.closes);
const T = dates.length;
const S = syms.length;

// price matrix [t][s]
const px: number[][] = Array.from({ length: T }, (_, t) => syms.map((s) => raw.closes[s][t]));

function mean(a: number[]): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function std(a: number[]): number {
  const n = a.length; if (n < 2) return 0; const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]): number { const s = std(a); return s > 1e-12 ? mean(a) / s : 0; }

// fwd log return s over t->t+1
const fwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
for (let t = 0; t < T - 1; t++) {
  for (let s = 0; s < S; s++) {
    const a = px[t][s], b = px[t + 1][s];
    if (a > 0 && b > 0) fwd[t][s] = Math.log(b / a);
  }
}

// Donchian channel position over lookback N, causal (uses window ending at t)
function channelPos(N: number): number[][] {
  const cp: number[][] = Array.from({ length: T }, () => new Array(S).fill(NaN));
  for (let s = 0; s < S; s++) {
    for (let t = N; t < T; t++) {
      let mn = Infinity, mx = -Infinity, ok = true;
      for (let k = t - N + 1; k <= t; k++) {
        const v = px[k][s];
        if (!(v > 0)) { ok = false; break; }
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      if (!ok || mx - mn < 1e-12) continue;
      cp[t][s] = (px[t][s] - mn) / (mx - mn);
    }
  }
  return cp;
}

// build dollar-neutral position from cp at day t: rank, long top frac, short bottom frac
// direction = +1 -> long HIGH cp (breakout); -1 -> long LOW cp
function buildPositions(cp: number[][], frac: number, direction: number): number[][] {
  const pos: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
  for (let t = 0; t < T; t++) {
    const valid: { s: number; v: number }[] = [];
    for (let s = 0; s < S; s++) if (Number.isFinite(cp[t][s]) && Number.isFinite(fwd[t][s])) valid.push({ s, v: cp[t][s] });
    if (valid.length < 6) continue;
    valid.sort((a, b) => a.v - b.v); // ascending cp
    const k = Math.max(1, Math.floor(valid.length * frac));
    // top k = highest cp; bottom k = lowest cp
    const longSet = direction > 0 ? valid.slice(valid.length - k) : valid.slice(0, k);
    const shortSet = direction > 0 ? valid.slice(0, k) : valid.slice(valid.length - k);
    // dollar-neutral: +1/k gross on each long, -1/k on each short -> gross exposure 2, net 0
    for (const { s } of longSet) pos[t][s] = 1 / longSet.length;
    for (const { s } of shortSet) pos[t][s] = -1 / shortSet.length;
  }
  return pos;
}

// portfolio daily net returns with turnover cost (sum over coins of |dpos|*cost)
function portfolioReturns(pos: number[][], startIdx: number, endIdx: number): { net: number[]; gross: number[]; turnover: number } {
  const net: number[] = [], gross: number[] = [];
  let prev = new Array(S).fill(0);
  let turnoverSum = 0;
  for (let t = startIdx; t < endIdx; t++) {
    let g = 0, turn = 0, anyValid = false;
    for (let s = 0; s < S; s++) {
      const p = pos[t][s];
      turn += Math.abs(p - prev[s]);
      if (p !== 0 && Number.isFinite(fwd[t][s])) { g += p * fwd[t][s]; anyValid = true; }
    }
    if (!anyValid) { continue; }
    const cost = turn * COST_PER_SIDE;
    gross.push(g);
    net.push(g - cost);
    turnoverSum += turn;
    prev = pos[t].slice();
  }
  return { net, gross, turnover: net.length ? turnoverSum / net.length : 0 };
}

const firstTradable = 250; // warmup for longest lookback
const lookbacks = [10, 20, 30, 55, 90, 120];
const fracs = [0.2, 0.33];
console.log("LB  frac  dir   grossSh   netSh   turnover  nDays");
for (const N of lookbacks) {
  const cp = channelPos(N);
  for (const frac of fracs) {
    for (const dir of [1, -1]) {
      const pos = buildPositions(cp, frac, dir);
      const r = portfolioReturns(pos, firstTradable, T - 1);
      const gsh = sharpeDaily(r.gross) * ANN;
      const nsh = sharpeDaily(r.net) * ANN;
      console.log(
        `${String(N).padStart(3)} ${frac.toFixed(2)}  ${dir > 0 ? "HIGH" : "LOW "}  ${gsh.toFixed(3).padStart(7)} ${nsh.toFixed(3).padStart(7)}  ${r.turnover.toFixed(3).padStart(7)}  ${r.net.length}`,
      );
    }
  }
}
