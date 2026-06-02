/**
 * D2-M2 (premium leg) — Amihud illiquidity premium, CROSS-SECTION.
 *
 * Belief (Amihud 2002): illiquid assets earn a return premium. Crypto test:
 *   ILLIQ_i = trailing mean( |daily_ret_i| / dollar_volume_i )
 *   Sort coins by ILLIQ, dollar-neutral L/S (long illiquid / short liquid),
 *   rebalance every R days, held with a STRICT h>=1 lag (form on info<=t-1,
 *   hold over day t). The LAGGED component is the only thing that can be edge.
 *
 * Data: output/c1-rotation/volume-panel.json — daily close + QUOTE (dollar)
 * volume for 43 coins, staggered listings -> point-in-time universe (a coin
 * enters only once it has a price + nonzero dollar volume). Survivorship-biased
 * (dead coins LUNA/FTT/etc. ABSENT) => any premium is an UPPER BOUND.
 *
 * RIGHT NULL = cross-sectional shuffle: on each rebalance, randomly permute the
 * ILLIQ ranking ACROSS coins, keep each coin's own realized return path. This
 * destroys any illiquidity->return cross-sectional sorting power while
 * preserving every coin's marginal return distribution and the market.
 * p = P(null netSharpe >= observed).
 *
 * KEY CONTROL (R2 / size collinearity): ILLIQ is ~0.96 cross-sectionally
 * collinear with pure inverse-dollar-volume, so the SAME sort built on plain
 * trailing dollar-volume is the decisive baseline. The real "illiquidity-
 * specific" edge = EXCESS of Amihud L/S over the volume-size L/S. We run BOTH
 * the standalone Amihud leg AND the excess-over-size leg through the gauntlet.
 *
 * Cost: taker 4 bps/side on |Δweight| per coin per day.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  runGauntlet,
  rng,
  printResult,
  COST_PER_SIDE,
  type GateResult,
} from "./lib.ts";

interface Panel {
  coins: string[];
  dates: string[];
  close: Record<string, (number | null)[]>;
  quoteVolume: Record<string, (number | null)[]>;
}

const panel = JSON.parse(
  readFileSync("output/c1-rotation/volume-panel.json", "utf8"),
) as Panel;
const { coins, dates } = panel;
const T = dates.length;
const N = coins.length;

// Per-coin daily simple return and raw Amihud daily ratio |ret|/dollarVol.
const ret: number[][] = coins.map(() => new Array(T).fill(NaN));
const illiqD: number[][] = coins.map(() => new Array(T).fill(NaN));
const dvol: number[][] = coins.map(() => new Array(T).fill(NaN));
for (let ci = 0; ci < N; ci += 1) {
  const C = panel.close[coins[ci]];
  const V = panel.quoteVolume[coins[ci]];
  for (let t = 1; t < T; t += 1) {
    const c0 = C[t - 1];
    const c1 = C[t];
    const v = V[t];
    if (c0 != null && c1 != null && c0 > 0 && v != null && v > 0) {
      const r = c1 / c0 - 1;
      ret[ci][t] = r;
      illiqD[ci][t] = Math.abs(r) / v;
      dvol[ci][t] = v;
    }
  }
}

function trailMean(arr: number[], t: number, w: number): number | null {
  let s = 0;
  let n = 0;
  for (let k = Math.max(1, t - w); k < t; k += 1) {
    if (Number.isFinite(arr[k])) {
      s += arr[k];
      n += 1;
    }
  }
  return n >= Math.max(5, Math.floor(w / 2)) ? s / n : null;
}

type SignalFn = (ci: number, t: number, w: number) => number | null;
const sigIlliq: SignalFn = (ci, t, w) => trailMean(illiqD[ci], t, w);
// pure-size control: trailing inverse dollar volume (higher = more "illiquid")
const sigInvVol: SignalFn = (ci, t, w) => {
  const m = trailMean(dvol[ci], t, w);
  return m != null && m > 0 ? 1 / m : null;
};

/**
 * Dollar-neutral L/S backtest. Sort by signal; long the top `frac` (high
 * signal = illiquid), short the bottom `frac` (liquid); equal-weight each leg;
 * rebalance every `reb` days; weights formed at t-1 held over day t (h>=1).
 * Optional `permute` shuffles the cross-sectional signal ranking each rebal
 * (the cross-sectional-shuffle null). Returns net + gross per-day series.
 */
function runLS(
  sig: SignalFn,
  w: number,
  reb: number,
  frac: number,
  permute: (() => number) | null,
): { net: number[]; gross: number[]; turnover: number } {
  const net: number[] = [];
  const gross: number[] = [];
  let curW = new Array(N).fill(0);
  let prevW = new Array(N).fill(0);
  let formDay = -1e9;
  let turnSum = 0;
  const start = Math.max(220, w + 5);
  for (let t = start; t < T; t += 1) {
    if (t - formDay >= reb) {
      const rows: { ci: number; s: number }[] = [];
      for (let ci = 0; ci < N; ci += 1) {
        const s = sig(ci, t, w);
        if (s != null && Number.isFinite(s)) rows.push({ ci, s });
      }
      if (rows.length >= 8) {
        let order = rows.map((r) => r.ci);
        let vals = rows.map((r) => r.s);
        if (permute) {
          // cross-sectional shuffle: permute the signal values across the
          // SAME set of coins (Fisher-Yates), keeping each coin's return path.
          const perm = vals.slice();
          for (let i = perm.length - 1; i > 0; i -= 1) {
            const j = Math.floor(permute() * (i + 1));
            [perm[i], perm[j]] = [perm[j], perm[i]];
          }
          vals = perm;
        }
        const idx = order.map((ci, i) => ({ ci, s: vals[i] }));
        idx.sort((a, b) => a.s - b.s);
        const k = Math.max(1, Math.floor(idx.length * frac));
        const low = idx.slice(0, k).map((x) => x.ci); // liquid -> short
        const high = idx.slice(idx.length - k).map((x) => x.ci); // illiquid -> long
        const nw = new Array(N).fill(0);
        for (const ci of high) nw[ci] = 1 / high.length;
        for (const ci of low) nw[ci] = -1 / low.length;
        curW = nw;
        formDay = t;
      }
    }
    let pr = 0;
    let tw = 0;
    for (let ci = 0; ci < N; ci += 1) {
      const wv = curW[ci];
      if (wv !== 0 && Number.isFinite(ret[ci][t])) pr += wv * ret[ci][t];
      tw += Math.abs(wv - prevW[ci]);
    }
    gross.push(pr);
    net.push(pr - tw * COST_PER_SIDE);
    turnSum += tw;
    prevW = curW.slice();
  }
  return { net, gross, turnover: turnSum / Math.max(1, net.length) };
}

function annSharpe(x: number[]): number {
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length);
  return sd > 1e-12 ? (m / sd) * Math.sqrt(365) : 0;
}

// Equal-weight buy-hold of the universe (point-in-time) as market baseline.
function marketRet(): number[] {
  const out: number[] = [];
  const start = Math.max(220, 65);
  for (let t = start; t < T; t += 1) {
    let s = 0;
    let n = 0;
    for (let ci = 0; ci < N; ci += 1) {
      if (Number.isFinite(ret[ci][t])) {
        s += ret[ci][t];
        n += 1;
      }
    }
    out.push(n > 0 ? s / n : 0);
  }
  return out;
}

const SUR = 500;
const results: Record<string, GateResult> = {};

// =====================================================================
// LEG A: standalone Amihud illiquidity L/S (long illiquid / short liquid).
// Config sweep = honest N. Surrogate = cross-sectional shuffle.
// =====================================================================
function runAmihudStandalone() {
  const ws = [30, 40, 60, 90];
  const rebs = [5, 10, 20];
  const fracs = [0.2, 0.33];
  const configs: { id: string; w: number; reb: number; frac: number; net: number[]; turnover: number }[] =
    [];
  for (const w of ws)
    for (const reb of rebs)
      for (const frac of fracs) {
        const bt = runLS(sigIlliq, w, reb, frac, null);
        configs.push({ id: `w${w}_r${reb}_f${frac}`, w, reb, frac, net: bt.net, turnover: bt.turnover });
      }
  const honestN = configs.length;
  let best = configs[0];
  let bestS = -Infinity;
  for (const c of configs) {
    const s = annSharpe(c.net);
    if (s > bestS) {
      bestS = s;
      best = c;
    }
  }
  const btBest = runLS(sigIlliq, best.w, best.reb, best.frac, null);
  const observed = annSharpe(btBest.net);

  // cross-sectional shuffle null on the BEST config
  const surSharpes: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(11000 + s);
    const b = runLS(sigIlliq, best.w, best.reb, best.frac, rand);
    surSharpes.push(annSharpe(b.net));
  }
  const k = Math.floor(btBest.net.length / 5);
  const folds = configs.map((c) => ({
    id: c.id,
    folds: [0, 1, 2, 3, 4].map((f) => c.net.slice(f * k, (f + 1) * k)),
  }));
  const r = runGauntlet({
    name: "D2-M2 Amihud illiq L/S (long illiquid, h>=1)",
    config: best.id,
    net: btBest.net,
    gross: btBest.gross,
    turnover: btBest.turnover,
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: observed,
    buyHoldRets: marketRet(),
    pboStrategies: folds,
    periodsPerYear: 365,
  });
  results["D2-M2-standalone"] = r;
  printResult(r);
  return honestN;
}

// =====================================================================
// LEG B (decisive R2 control): EXCESS of Amihud L/S over the pure-volume
// (inverse dollar-volume) size L/S, matched w/reb/frac. This isolates any
// edge SPECIFIC to the |ret| numerator beyond the small-cap/low-volume tilt.
// Surrogate = cross-sectional shuffle applied to BOTH legs identically.
// =====================================================================
function runAmihudExcessOverSize(priorN: number) {
  const ws = [30, 40, 60, 90];
  const rebs = [5, 10, 20];
  const fracs = [0.2, 0.33];
  const configs: { id: string; w: number; reb: number; frac: number; excess: number[] }[] = [];
  for (const w of ws)
    for (const reb of rebs)
      for (const frac of fracs) {
        const a = runLS(sigIlliq, w, reb, frac, null);
        const b = runLS(sigInvVol, w, reb, frac, null);
        const ex = a.net.map((x, i) => x - (b.net[i] ?? 0));
        configs.push({ id: `w${w}_r${reb}_f${frac}`, w, reb, frac, excess: ex });
      }
  // honest N accumulates ALL configs tried across BOTH legs.
  const honestN = priorN + configs.length;
  let best = configs[0];
  let bestS = -Infinity;
  for (const c of configs) {
    const s = annSharpe(c.excess);
    if (s > bestS) {
      bestS = s;
      best = c;
    }
  }
  const observed = annSharpe(best.excess);
  const surSharpes: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(22000 + s);
    // SAME shuffle stream drives both legs -> isolates numerator-specific edge.
    const ra = runLS(sigIlliq, best.w, best.reb, best.frac, rng(22000 + s));
    const rb = runLS(sigInvVol, best.w, best.reb, best.frac, rng(22000 + s));
    const ex = ra.net.map((x, i) => x - (rb.net[i] ?? 0));
    surSharpes.push(annSharpe(ex));
    void rand;
  }
  const k = Math.floor(best.excess.length / 5);
  const folds = configs.map((c) => ({
    id: c.id,
    folds: [0, 1, 2, 3, 4].map((f) => c.excess.slice(f * k, (f + 1) * k)),
  }));
  const r = runGauntlet({
    name: "D2-M2 Amihud EXCESS over volume-size (illiq-specific, h>=1)",
    config: best.id,
    net: best.excess,
    gross: best.excess,
    turnover: 0.02,
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: observed,
    buyHoldRets: marketRet(),
    pboStrategies: folds,
    periodsPerYear: 365,
  });
  results["D2-M2-excess-over-size"] = r;
  printResult(r);
}

console.log("=== D2-M2 Amihud illiquidity premium (cross-section) ===");
console.log(`universe=${N} coins, ${T} days, ${dates[0]}..${dates[T - 1]}`);
console.log("NOTE: survivorship-biased panel (dead coins absent) => UPPER BOUND.\n");
const nA = runAmihudStandalone();
runAmihudExcessOverSize(nA);

writeFileSync("output/edgehunt-D2/amihud-results.json", JSON.stringify(results, null, 2));
console.log("\n=== summary ===");
for (const [k, r] of Object.entries(results)) {
  console.log(
    `${k}: pass=${r.pass} netSharpe=${r.netSharpeAnn.toFixed(2)} binding=${r.bindingGate} surP=${r.surrogateP.toFixed(3)} DSR=${r.dsrProb.toFixed(3)} PBO=${r.pbo == null ? "na" : r.pbo.toFixed(2)} N=${r.honestN}`,
  );
}
