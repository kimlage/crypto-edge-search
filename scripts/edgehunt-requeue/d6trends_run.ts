/**
 * D6-TRENDS runner — strongest honest version of the "attention fade/accumulate" rule + gauntlet.
 *
 * Signal: strictly-lagged weekly Google Trends "bitcoin" interest, rolling z over zWin weeks.
 * Rule family (thesis = high-attention FADE / low-attention ACCUMULATE):
 *   pos[t] = -tanh(k * z[t])  clamped to [-1,1]   (z high -> short/flat; z low -> long)
 * with optional long-only variant (accumulate only): pos = max(0, -k*z) clamped.
 *
 * AR-matched placebo: AR(1) surrogate matched to the trend-z lag-1 autocorr + variance, fed through
 * the IDENTICAL rule. If the rule earns the same on the placebo, the attention content is zero.
 */
import fs from "node:fs";
import {
  loadSeries,
  runGauntlet,
  printVerdict,
  mkRng,
  mean,
  std,
  type Series,
  type GauntletInput,
} from "./d6trends_harness.ts";

const OUT = "output/edgehunt-requeue";

// ---- AR(1) fit on the daily-aligned trend-z (use the in-sample-ish full causal series) ----
function fitAR1(z: number[]): { phi: number; sigma: number; mu: number } {
  const v = z.filter((x) => Number.isFinite(x));
  const mu = mean(v);
  const c = v.map((x) => x - mu);
  let num = 0,
    den = 0;
  for (let i = 1; i < c.length; i++) {
    num += c[i] * c[i - 1];
    den += c[i - 1] * c[i - 1];
  }
  const phi = den > 0 ? num / den : 0;
  // innovation sigma so that stationary var matches sample var: var = sigma^2/(1-phi^2)
  const sampleVar = std(v) ** 2;
  const sigma = Math.sqrt(Math.max(1e-9, sampleVar * (1 - phi * phi)));
  return { phi, sigma, mu };
}

// Generate an AR(1) path of length n on the WEEKLY grid (trends is weekly), matched to weekly
// autocorr, then map to daily by the same strictly-lagged step structure the real signal uses.
// Simpler & valid: since the daily series is piecewise-constant within a week, generate the AR(1)
// at the DAILY-aligned cadence but matched to the DAILY-aligned z autocorr (which is what the rule
// actually consumes). gaussian via Box-Muller.
function gauss(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- build positions from a z-vector via the rule ----
function ruleToPosition(
  zvec: number[],
  cfg: Record<string, number | string>,
): number[] {
  const k = Number(cfg.k);
  const longOnly = cfg.mode === "longonly";
  const out = new Array(zvec.length).fill(NaN);
  for (let t = 0; t < zvec.length; t++) {
    const z = zvec[t];
    if (!Number.isFinite(z)) {
      out[t] = NaN;
      continue;
    }
    let p = -Math.tanh(k * z); // fade attention: high z -> negative (short/flat), low z -> long
    if (longOnly) p = Math.max(0, p);
    out[t] = Math.max(-1, Math.min(1, p));
  }
  return out;
}

function main() {
  // pick a representative zWin for series construction; we vary zWin INSIDE the config grid by
  // rebuilding the z lazily. To keep honest-N exact we enumerate the full grid of (zWin,k,mode).
  const zWins = [13, 26, 52, 104]; // weeks: quarter, half, 1y, 2y rolling z
  const ks = [0.5, 1.0, 1.5, 2.0];
  const modes = ["both", "longonly"];

  // Precompute one Series per zWin (the daily-aligned strictly-lagged z differs by zWin).
  const seriesByWin = new Map<number, Series>();
  for (const w of zWins) seriesByWin.set(w, loadSeries(w));

  // The harness's buildPosition receives a cfg; it must pick the right Series by zWin.
  // We embed zWin in cfg and resolve the series inside the closures. The gauntlet uses ONE Series
  // for price/fwdRet (identical across zWins — only trendZ differs), so we pass the zWin=52 series
  // for price and build positions against the cfg-specific trendZ.
  const baseSeries = seriesByWin.get(52)!;

  // AR(1) fit per zWin on that win's daily trend-z.
  const arByWin = new Map<number, { phi: number; sigma: number; mu: number }>();
  for (const w of zWins) arByWin.set(w, fitAR1(seriesByWin.get(w)!.trendZ));

  const configs: Record<string, number | string>[] = [];
  for (const w of zWins) for (const k of ks) for (const m of modes) configs.push({ zWin: w, k, mode: m });

  // first tradable index: after the longest zWin warmup has daily-z populated + a margin
  let startIdx = 0;
  const z52 = baseSeries.trendZ;
  for (let t = 0; t < z52.length; t++) {
    // require all-win z available
    const ok = zWins.every((w) => Number.isFinite(seriesByWin.get(w)!.trendZ[t]));
    if (ok) {
      startIdx = t;
      break;
    }
  }

  const buildPosition = (cfg: Record<string, number | string>): number[] => {
    const w = Number(cfg.zWin);
    const z = seriesByWin.get(w)!.trendZ;
    return ruleToPosition(z, cfg);
  };

  // AR-matched placebo: generate AR(1) daily-aligned z surrogate with the cfg-win's params,
  // BUT preserve the weekly piecewise-constant cadence so turnover/structure matches the real one.
  const buildPlaceboPosition = (
    cfg: Record<string, number | string>,
    rng: () => number,
  ): number[] => {
    const w = Number(cfg.zWin);
    const { phi, sigma, mu } = arByWin.get(w)!;
    const realZ = seriesByWin.get(w)!.trendZ;
    const surrZ = new Array(realZ.length).fill(NaN);
    // step only when the real z changes (i.e., on week boundaries) so the placebo updates at the
    // same cadence the real signal does; hold constant within the week.
    let cur = mu;
    let prevReal = NaN;
    for (let t = 0; t < realZ.length; t++) {
      if (!Number.isFinite(realZ[t])) {
        surrZ[t] = NaN;
        prevReal = NaN;
        continue;
      }
      const changed = !Number.isFinite(prevReal) || realZ[t] !== prevReal;
      if (changed) cur = mu + phi * (cur - mu) + sigma * gauss(rng);
      surrZ[t] = cur;
      prevReal = realZ[t];
    }
    return ruleToPosition(surrZ, cfg);
  };

  const input: GauntletInput = {
    name: "D6-TRENDS attention fade/accumulate",
    S: baseSeries,
    buildPosition,
    buildPlaceboPosition,
    configs,
    canonical: { zWin: 52, k: 1.0, mode: "both" }, // pre-registered: 1y rolling z, fade, both legs
    startIdx,
    holdoutFrac: 0.2,
    nSurr: 400,
  };

  const o = runGauntlet(input);
  printVerdict(o);

  // grounding diagnostics
  const bh = (() => {
    const T = baseSeries.price.length;
    const r: number[] = [];
    for (let t = startIdx; t < T - 1; t++) if (Number.isFinite(baseSeries.fwdRet[t])) r.push(baseSeries.fwdRet[t]);
    const m = mean(r),
      s = std(r);
    return (m / s) * Math.sqrt(365);
  })();
  console.log(`\n[diag] startIdx=${startIdx} date=${baseSeries.dates[startIdx]} buyHoldGrossSharpe=${bh.toFixed(3)}`);
  console.log(`[diag] AR(1) fits per zWin:`);
  for (const w of zWins) {
    const a = arByWin.get(w)!;
    console.log(`   zWin=${w}: phi=${a.phi.toFixed(3)} sigma=${a.sigma.toFixed(3)} mu=${a.mu.toFixed(3)}`);
  }

  fs.writeFileSync(
    `${OUT}/d6trends_result.json`,
    JSON.stringify({ verdict: o.verdict, best: o.best, gates: o.gates, canonical: o.canonical, honestN: o.honestN, surrogateP: o.surrogateP, holdoutSharpeAnn: o.holdoutSharpeAnn, buyHoldGrossSharpe: bh }, null, 2),
  );
}
main();
