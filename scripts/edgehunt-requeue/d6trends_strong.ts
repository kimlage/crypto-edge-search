/**
 * D6-TRENDS STRONGEST honest version + committed gauntlet on the RIGHT null (AR-matched placebo).
 *
 * The lead-lag probe showed level-attention-z has a POSITIVE forward IC (+0.10 @21d): high attention
 * precedes higher returns (opposite of "fade"). So we give the thesis its best shot by searching
 * BOTH directions (dir=+1 accumulate-on-high / momentum, dir=-1 fade) AND both signal transforms
 * (level z, 1-week change in z), AND a long-only "accumulate" variant. Every config is counted in
 * honest N. The AR(1)-matched placebo (right null) decides whether any apparent edge is attention
 * content or just an autocorrelated wiggle riding BTC's bull drift.
 */
import fs from "node:fs";
import {
  loadSeries,
  runGauntlet,
  printVerdict,
  mean,
  std,
  type Series,
  type GauntletInput,
} from "./d6trends_harness.ts";

const OUT = "output/edgehunt-requeue";

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
  const sigma = Math.sqrt(Math.max(1e-9, std(v) ** 2 * (1 - phi * phi)));
  return { phi, sigma, mu };
}
function gauss(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// signal vector for a given series + transform
function signalVec(S: Series, transform: string): number[] {
  const z = S.trendZ;
  if (transform === "level") return z;
  // 1-week change in z (PIT-cleaner: differencing removes the slow rescaled trend)
  const out = new Array(z.length).fill(NaN);
  for (let t = 7; t < z.length; t++) {
    if (Number.isFinite(z[t]) && Number.isFinite(z[t - 7])) out[t] = z[t] - z[t - 7];
  }
  return out;
}

function ruleToPosition(sig: number[], cfg: Record<string, number | string>): number[] {
  const k = Number(cfg.k);
  const dir = Number(cfg.dir); // +1 = accumulate-on-high (momentum), -1 = fade
  const longOnly = cfg.mode === "longonly";
  const out = new Array(sig.length).fill(NaN);
  for (let t = 0; t < sig.length; t++) {
    const s = sig[t];
    if (!Number.isFinite(s)) {
      out[t] = NaN;
      continue;
    }
    let p = dir * Math.tanh(k * s);
    if (longOnly) p = Math.max(0, p);
    out[t] = Math.max(-1, Math.min(1, p));
  }
  return out;
}

function main() {
  const zWins = [13, 26, 52, 104];
  const ks = [0.5, 1.0, 2.0];
  const dirs = [1, -1];
  const transforms = ["level", "change"];
  const modes = ["both", "longonly"];

  const seriesByWin = new Map<number, Series>();
  for (const w of zWins) seriesByWin.set(w, loadSeries(w));
  const baseSeries = seriesByWin.get(52)!;

  // AR(1) fits keyed by (zWin, transform) since the change-transform has different autocorr.
  const arKey = (w: number, tr: string) => `${w}|${tr}`;
  const arMap = new Map<string, { phi: number; sigma: number; mu: number }>();
  for (const w of zWins)
    for (const tr of transforms) arMap.set(arKey(w, tr), fitAR1(signalVec(seriesByWin.get(w)!, tr)));

  const configs: Record<string, number | string>[] = [];
  for (const w of zWins)
    for (const k of ks)
      for (const dir of dirs)
        for (const tr of transforms)
          for (const m of modes) configs.push({ zWin: w, k, dir, transform: tr, mode: m });

  // start index: all-win level-z available + change warmup
  let startIdx = 0;
  for (let t = 0; t < baseSeries.trendZ.length; t++) {
    const ok = zWins.every((w) => {
      const z = seriesByWin.get(w)!.trendZ;
      return Number.isFinite(z[t]) && t >= 7 && Number.isFinite(z[t - 7]);
    });
    if (ok) {
      startIdx = t;
      break;
    }
  }

  const buildPosition = (cfg: Record<string, number | string>): number[] => {
    const w = Number(cfg.zWin);
    const sig = signalVec(seriesByWin.get(w)!, String(cfg.transform));
    return ruleToPosition(sig, cfg);
  };

  const buildPlaceboPosition = (
    cfg: Record<string, number | string>,
    rng: () => number,
  ): number[] => {
    const w = Number(cfg.zWin);
    const tr = String(cfg.transform);
    const { phi, sigma, mu } = arMap.get(arKey(w, tr))!;
    const realSig = signalVec(seriesByWin.get(w)!, tr);
    const surr = new Array(realSig.length).fill(NaN);
    let cur = mu;
    let prevReal = NaN;
    for (let t = 0; t < realSig.length; t++) {
      if (!Number.isFinite(realSig[t])) {
        surr[t] = NaN;
        prevReal = NaN;
        continue;
      }
      const changed = !Number.isFinite(prevReal) || realSig[t] !== prevReal;
      if (changed) cur = mu + phi * (cur - mu) + sigma * gauss(rng);
      surr[t] = cur;
      prevReal = realSig[t];
    }
    return ruleToPosition(surr, cfg);
  };

  const input: GauntletInput = {
    name: "D6-TRENDS STRONG (both dirs, level+change)",
    S: baseSeries,
    buildPosition,
    buildPlaceboPosition,
    configs,
    canonical: { zWin: 52, k: 1.0, dir: 1, transform: "level", mode: "longonly" }, // best-shot momentum
    startIdx,
    holdoutFrac: 0.2,
    nSurr: 400,
  };

  const o = runGauntlet(input);
  printVerdict(o);
  console.log(`\n[diag] honestN=${configs.length} startIdx=${startIdx} date=${baseSeries.dates[startIdx]}`);

  fs.writeFileSync(
    `${OUT}/d6trends_strong_result.json`,
    JSON.stringify(
      {
        verdict: o.verdict,
        best: o.best,
        gates: o.gates,
        canonical: o.canonical,
        honestN: o.honestN,
        surrogateP: o.surrogateP,
        holdoutSharpeAnn: o.holdoutSharpeAnn,
      },
      null,
      2,
    ),
  );
}
main();
