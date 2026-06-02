/**
 * D6-M4 full gauntlet. STRICT t-1 real-yield timer vs buy&hold + the RIGHT
 * surrogate nulls. Net of 4bps/flip cost. Honest N = regime count.
 *
 * Strategy family (all strictly causal: signal known at close t-1, return t):
 *   - change timers (long when L-day real-yield change < 0)
 *   - level timers (long when real yield below rolling-W median)
 *   - long/short variants
 * Grid is the honest "number of configs tried" -> Deflated Sharpe trialCount.
 *
 * Nulls:
 *   1) Pair-shuffle: shuffle the BTC<->yield date pairing (break the link,
 *      keep both marginals + the timer machinery). p = frac surrogate >= real.
 *   2) AR(1)-matched real-yield placebo: generate fake yield paths with the
 *      same AR(1) persistence + innovation vol, run the SAME timer. Tests
 *      whether ANY persistent macro series of this shape would "time" BTC
 *      (the coincident-beta / digital-gold trap).
 *   3) Long-block bootstrap CI on the net strategy returns (is Sharpe>0 robust).
 *   4) Risk-on beta neutralization: regress strategy daily returns on BTC
 *      buy&hold; the ALPHA (intercept) is the non-beta edge. A timer that only
 *      de-risks has ~0 alpha.
 *   5) Regime-split holdout: does the best in-sample config survive OOS in a
 *      later, disjoint regime window?
 */
import {
  loadPanel,
  sharpe,
  annReturn,
  maxDrawdown,
  ANN,
  type PanelRow,
} from "./load_data";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation";

const COST_PER_FLIP = 0.0004; // 4 bps on a full position change (round-trip notional turnover)

const panel = loadPanel();
const N = panel.length;
console.log(
  `panel rows=${N} ${panel[0].date}..${panel[N - 1].date}; BTC B&H Sharpe=${sharpe(
    panel.map((r) => r.btcRet),
  ).toFixed(3)}`,
);

// ---------- signal builders (strict t-1) ----------
function levelAt(i: number): number | null {
  // real-yield level KNOWN at close t-1 (positions panel[i].btcRet)
  return panel[i - 1]?.dfii10 ?? null;
}
function changeAt(i: number, L: number): number | null {
  const a = panel[i - 1]?.dfii10;
  const b = panel[i - 1 - L]?.dfii10;
  if (a == null || b == null) return null;
  return a - b;
}
function rollMedian(i: number, W: number): number | null {
  const hist: number[] = [];
  for (let k = i - W; k < i; k++) {
    const y = panel[k]?.dfii10;
    if (y != null) hist.push(y);
  }
  if (hist.length < Math.floor(W * 0.6)) return null;
  hist.sort((a, b) => a - b);
  return hist[Math.floor(hist.length / 2)];
}

type PosFn = (i: number) => number | null; // target position in {-1,0,1} for return_t, or null=skip

interface Config {
  id: string;
  kind: "change" | "level";
  longShort: boolean;
  pos: PosFn;
}

// Build the honest grid of configs (this count drives Deflated-Sharpe trialCount).
function buildConfigs(yieldOf: (i: number) => number | null): Config[] {
  const cfgs: Config[] = [];
  // change timers
  for (const L of [5, 10, 20, 40, 60]) {
    cfgs.push({
      id: `chg-L${L}-LO`,
      kind: "change",
      longShort: false,
      pos: (i) => {
        const a = i - 1 >= 0 ? yieldOf(i - 1) : null;
        const b = i - 1 - L >= 0 ? yieldOf(i - 1 - L) : null;
        if (a == null || b == null) return null;
        return a - b < 0 ? 1 : 0;
      },
    });
    cfgs.push({
      id: `chg-L${L}-LS`,
      kind: "change",
      longShort: true,
      pos: (i) => {
        const a = i - 1 >= 0 ? yieldOf(i - 1) : null;
        const b = i - 1 - L >= 0 ? yieldOf(i - 1 - L) : null;
        if (a == null || b == null) return null;
        return a - b < 0 ? 1 : -1;
      },
    });
  }
  // level timers (below rolling median = cheap money = long)
  for (const W of [60, 120, 250]) {
    cfgs.push({
      id: `lvl-W${W}-LO`,
      kind: "level",
      longShort: false,
      pos: (i) => {
        const hist: number[] = [];
        for (let k = i - W; k < i; k++) {
          const y = yieldOf(k);
          if (y != null) hist.push(y);
        }
        if (hist.length < Math.floor(W * 0.6)) return null;
        hist.sort((a, b) => a - b);
        const med = hist[Math.floor(hist.length / 2)];
        const yPrev = yieldOf(i - 1);
        if (yPrev == null) return null;
        return yPrev < med ? 1 : 0;
      },
    });
    cfgs.push({
      id: `lvl-W${W}-LS`,
      kind: "level",
      longShort: true,
      pos: (i) => {
        const hist: number[] = [];
        for (let k = i - W; k < i; k++) {
          const y = yieldOf(k);
          if (y != null) hist.push(y);
        }
        if (hist.length < Math.floor(W * 0.6)) return null;
        hist.sort((a, b) => a - b);
        const med = hist[Math.floor(hist.length / 2)];
        const yPrev = yieldOf(i - 1);
        if (yPrev == null) return null;
        return yPrev < med ? 1 : -1;
      },
    });
  }
  return cfgs;
}

const HONEST_TRIALS = 16; // size of the config grid above = honest N for DSR deflation

// ---------- run a config: returns net daily-return series + flip count ----------
interface RunResult {
  net: number[]; // net (post-cost) daily returns aligned to a fixed index range
  gross: number[];
  pos: number[]; // realized position each day
  btc: number[]; // buy&hold return same days
  flips: number;
  startIdx: number;
}

function runConfig(
  cfg: Config,
  retOf: (i: number) => number,
): RunResult {
  const net: number[] = [];
  const gross: number[] = [];
  const posArr: number[] = [];
  const btc: number[] = [];
  let prevPos = 0;
  let flips = 0;
  let startIdx = -1;
  for (let i = 1; i < N; i++) {
    const p = cfg.pos(i);
    if (p == null) continue;
    if (startIdx < 0) startIdx = i;
    const r = retOf(i);
    const turn = Math.abs(p - prevPos);
    const cost = turn * COST_PER_FLIP;
    if (turn > 0) flips++;
    gross.push(p * r);
    net.push(p * r - cost);
    posArr.push(p);
    btc.push(r);
    prevPos = p;
  }
  return { net, gross, pos: posArr, btc, flips, startIdx };
}

// ---------- evaluate all configs on REAL data ----------
const realYield = (i: number) => panel[i]?.dfii10 ?? null;
const realRet = (i: number) => panel[i].btcRet;
const configs = buildConfigs(realYield);

console.log("\n=== REAL-DATA configs (net of 4bps/flip) ===");
const results = configs.map((cfg) => {
  const r = runConfig(cfg, realRet);
  const grS = sharpe(r.gross);
  const netS = sharpe(r.net);
  const exposure =
    r.pos.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, r.pos.length);
  return { cfg, r, grS, netS, exposure };
});
results.sort((a, b) => b.netS - a.netS);
for (const x of results) {
  console.log(
    `  ${x.cfg.id.padEnd(12)} grossS=${x.grS.toFixed(3)} netS=${x.netS.toFixed(3)} flips=${x.r.flips} exp=${(x.exposure * 100).toFixed(0)}% netRet=${(annReturn(x.r.net) * 100).toFixed(1)}%`,
  );
}

const best = results[0];
console.log(
  `\nBEST config: ${best.cfg.id} netSharpe=${best.netS.toFixed(3)} (B&H=${sharpe(best.r.btc).toFixed(3)})`,
);

// ---------- beta-neutralization: alpha of best vs buy&hold ----------
function regressAlphaBeta(y: number[], x: number[]): { alpha: number; beta: number; tAlpha: number } {
  const n = Math.min(y.length, x.length);
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let k = 0; k < n; k++) {
    sxy += (x[k] - mx) * (y[k] - my);
    sxx += (x[k] - mx) ** 2;
  }
  const beta = sxx > 1e-12 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  // residual std for t-stat on alpha
  let sse = 0;
  for (let k = 0; k < n; k++) {
    const resid = y[k] - (alpha + beta * x[k]);
    sse += resid * resid;
  }
  const seReg = Math.sqrt(sse / Math.max(1, n - 2));
  const seAlpha = seReg * Math.sqrt(1 / n + (mx * mx) / Math.max(1e-12, sxx));
  const tAlpha = seAlpha > 1e-12 ? alpha / seAlpha : 0;
  return { alpha, beta, tAlpha };
}
const ab = regressAlphaBeta(best.r.net, best.r.btc);
console.log(
  `\n=== Beta-neutralization (best vs B&H) ===\n  alpha=${(ab.alpha * 365 * 100).toFixed(2)}%/yr  beta=${ab.beta.toFixed(3)}  t(alpha)=${ab.tAlpha.toFixed(2)}  (alpha annualized; t<~2 => no non-beta edge)`,
);

// ---------- Deflated Sharpe @ honest N ----------
const dsr = computeDeflatedSharpeRatio(best.r.net, {
  benchmarkSharpe: 0,
  trialCount: HONEST_TRIALS,
});
// note: primitive returns per-observation Sharpe; we report both
console.log(
  `\n=== Deflated Sharpe (honest trials=${HONEST_TRIALS}) ===\n  per-obs Sharpe=${dsr.sharpe.toFixed(4)} expectedMax=${dsr.expectedMaxSharpe.toFixed(4)} z=${dsr.zScore.toFixed(3)} deflatedProb=${dsr.deflatedProbability.toFixed(4)} (need >0.95 to survive)`,
);

// ---------- Long-block bootstrap CI on net Sharpe-like (compoundReturn) ----------
const boot = blockBootstrapConfidenceInterval(best.r.net, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 40, // long block to preserve macro autocorrelation
  confidenceLevel: 0.95,
  seed: "d6m4-block",
});
console.log(
  `\n=== Long-block bootstrap (blockLen=40) on mean daily net ===\n  est=${(boot.estimate * 1e4).toFixed(2)}bps/day  CI95=[${(boot.lower * 1e4).toFixed(2)}, ${(boot.upper * 1e4).toFixed(2)}]bps  (CI must exclude 0)`,
);

// ---------- NULL 1: pair-shuffle (break BTC<->yield pairing) ----------
// Re-pair BTC returns with a circularly-shifted yield series, re-run the WHOLE
// grid, take the best net Sharpe per surrogate. p = frac(best_surrogate >= best_real).
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bestNetSharpeWithYield(yieldOf: (i: number) => number | null): number {
  const cfgs = buildConfigs(yieldOf);
  let bestS = -Infinity;
  for (const cfg of cfgs) {
    const r = runConfig(cfg, realRet); // BTC returns stay real & aligned to t
    const s = sharpe(r.net);
    if (Number.isFinite(s) && s > bestS) bestS = s;
  }
  return bestS;
}

console.log("\n=== NULL 1: pair-shuffle (circular shift of yield vs BTC) ===");
{
  const rng = mulberry32(12345);
  const NS = 500;
  let ge = 0;
  const surr: number[] = [];
  for (let s = 0; s < NS; s++) {
    const shift = 50 + Math.floor(rng() * (N - 100)); // non-trivial circular shift
    const shuffledYield = (i: number) => panel[(i + shift) % N]?.dfii10 ?? null;
    const bs = bestNetSharpeWithYield(shuffledYield);
    surr.push(bs);
    if (bs >= best.netS) ge++;
  }
  surr.sort((a, b) => a - b);
  const p = (ge + 1) / (NS + 1);
  console.log(
    `  real best netSharpe=${best.netS.toFixed(3)}; surrogate best: median=${surr[Math.floor(NS / 2)].toFixed(3)} p95=${surr[Math.floor(NS * 0.95)].toFixed(3)} max=${surr[NS - 1].toFixed(3)}`,
  );
  console.log(`  p(surrogate_best >= real_best) = ${p.toFixed(4)}  (need <0.05)`);
}

// ---------- NULL 2: AR(1)-matched real-yield placebo ----------
// Fit AR(1) on DFII10 levels, simulate fake yield paths w/ same persistence &
// innovation vol, run the SAME timer grid, compare best net Sharpe.
console.log("\n=== NULL 2: AR(1)-matched yield placebo ===");
{
  const lv: number[] = [];
  for (let i = 0; i < N; i++) if (panel[i].dfii10 != null) lv.push(panel[i].dfii10!);
  // AR(1): y_t = c + phi*y_{t-1} + e
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
  console.log(`  fitted AR(1): phi=${phi.toFixed(4)} sigma=${sigma.toFixed(4)} mean=${(sy / m).toFixed(3)}`);

  const rng = mulberry32(999);
  function gauss() {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  const NS = 500;
  let ge = 0;
  const surr: number[] = [];
  const mean0 = sy / m;
  for (let s = 0; s < NS; s++) {
    const fake = new Array<number>(N);
    fake[0] = mean0;
    for (let i = 1; i < N; i++) fake[i] = c + phi * fake[i - 1] + sigma * gauss();
    const fakeYield = (i: number) => (i >= 0 && i < N ? fake[i] : null);
    const bs = bestNetSharpeWithYield(fakeYield);
    surr.push(bs);
    if (bs >= best.netS) ge++;
  }
  surr.sort((a, b) => a - b);
  const p = (ge + 1) / (NS + 1);
  console.log(
    `  real best netSharpe=${best.netS.toFixed(3)}; placebo best: median=${surr[Math.floor(NS / 2)].toFixed(3)} p95=${surr[Math.floor(NS * 0.95)].toFixed(3)} max=${surr[NS - 1].toFixed(3)}`,
  );
  console.log(`  p(placebo_best >= real_best) = ${p.toFixed(4)}  (need <0.05; THIS is the coincident-beta killer)`);
}

// ---------- Regime-split holdout (consume-once) ----------
// IS = first 60%, OOS = last 40%. Pick best config on IS, evaluate on OOS.
console.log("\n=== Regime-split holdout (IS=first 60%, OOS=last 40%) ===");
{
  const split = Math.floor(N * 0.6);
  function runSplit(cfg: Config, lo: number, hi: number) {
    const net: number[] = [];
    const btc: number[] = [];
    let prevPos = 0;
    for (let i = Math.max(1, lo); i < hi; i++) {
      const p = cfg.pos(i);
      if (p == null) continue;
      const r = realRet(i);
      const turn = Math.abs(p - prevPos);
      net.push(p * r - turn * COST_PER_FLIP);
      btc.push(r);
      prevPos = p;
    }
    return { net, btc };
  }
  let bestIs: { cfg: Config; s: number } | null = null;
  for (const cfg of configs) {
    const { net } = runSplit(cfg, 1, split);
    const s = sharpe(net);
    if (!bestIs || s > bestIs.s) bestIs = { cfg, s };
  }
  const oos = runSplit(bestIs!.cfg, split, N);
  console.log(
    `  IS pick: ${bestIs!.cfg.id} IS-netSharpe=${bestIs!.s.toFixed(3)}`,
  );
  console.log(
    `  OOS: netSharpe=${sharpe(oos.net).toFixed(3)} B&H-OOS=${sharpe(oos.btc).toFixed(3)} netRet=${(annReturn(oos.net) * 100).toFixed(1)}% (OOS must beat B&H to survive)`,
  );
}

// ---------- CPCV / PBO across regime folds ----------
console.log("\n=== CPCV/PBO (8 folds, all configs) ===");
{
  const F = 8;
  const foldSize = Math.floor(N / F);
  const strategies = configs.map((cfg) => {
    const folds: number[][] = [];
    for (let f = 0; f < F; f++) {
      const lo = f * foldSize + 1;
      const hi = f === F - 1 ? N : (f + 1) * foldSize;
      const net: number[] = [];
      let prevPos = 0;
      for (let i = lo; i < hi; i++) {
        const p = cfg.pos(i);
        if (p == null) continue;
        const r = realRet(i);
        const turn = Math.abs(p - prevPos);
        net.push(p * r - turn * COST_PER_FLIP);
        prevPos = p;
      }
      folds.push(net);
    }
    return { id: cfg.id, folds };
  });
  const pbo = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });
  console.log(
    `  PBO=${pbo.pbo.toFixed(3)} meanLogit=${pbo.meanLogit.toFixed(3)} splits=${pbo.splitCount} (PBO<0.5 needed; high=overfit selection)`,
  );
}

// ---------- B&H benchmark detail ----------
console.log("\n=== Benchmark ===");
const bhRet = panel.map((r) => r.btcRet);
console.log(
  `  Buy&hold: Sharpe=${sharpe(bhRet).toFixed(3)} annRet=${(annReturn(bhRet) * 100).toFixed(1)}% MDD=${(maxDrawdown(bhRet) * 100).toFixed(0)}%`,
);
console.log(
  `  Best timer: netSharpe=${best.netS.toFixed(3)} annRet=${(annReturn(best.r.net) * 100).toFixed(1)}% MDD=${(maxDrawdown(best.r.net) * 100).toFixed(0)}% exposure=${(best.exposure * 100).toFixed(0)}%`,
);
