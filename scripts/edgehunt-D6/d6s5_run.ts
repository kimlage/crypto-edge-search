/**
 * D6-S5 runner — News sentiment tone (GDELT) -> next-day BTC return.
 *
 * Honest N (the configs an honest researcher would have tried) ~= 24, spanning:
 *   - feature: tone LEVEL vs tone CHANGE (impulse)          (2)
 *   - window:  trailing z-score / change lookback {10,21,42} (3)
 *   - threshold: |z| band {0.0, 0.5, 1.0}                    (3)
 *   - de-trend: tone is reactive -> we ALWAYS de-trend in the headline grid (the KEY control),
 *     but include a no-de-trend strip to show how much edge is just relabelled long-beta.
 *   - direction: long/flat vs long/short.
 *
 * We also run a separate "density" (article volume) test as a sibling: volume z-score / change.
 *
 * Canonical pre-registered config (N=1, the belief stated cleanly): de-trended tone LEVEL z>0 over a
 * 21d window, long/flat. "Positive aggregate tone precedes next-day gains."
 */
import { loadD6Panel, runGauntlet, printVerdict, type Cfg, type D6Panel, mean, std } from "./d6s5_harness.ts";

function firstTradable(P: D6Panel): number {
  // need warmup for the largest z-window (42) + de-trend min (60) + lag(1) + change(1)
  for (let t = 0; t < P.price.length; t++) {
    if (Number.isFinite(P.tone[t])) {
      // require at least ~75 prior finite tone obs
      let cnt = 0;
      for (let k = 0; k <= t; k++) if (Number.isFinite(P.tone[k])) cnt++;
      if (cnt >= 80) return t;
    }
  }
  return 80;
}

function gridTone(): Cfg[] {
  const cfgs: Cfg[] = [];
  const features: ("level" | "change")[] = ["level", "change"];
  const windows = [10, 21, 42];
  const thresholds = [0.0, 0.5, 1.0];
  for (const feature of features)
    for (const window of windows)
      for (const threshold of thresholds)
        cfgs.push({ feature, window, threshold, detrend: 1, momWin: 21, longOnly: 1 });
  // long/short variants for the headline level/change at the central window (4 more) -> total 22
  for (const feature of features)
    for (const threshold of [0.5, 1.0])
      cfgs.push({ feature, window: 21, threshold, detrend: 1, momWin: 21, longOnly: 0 });
  return cfgs; // 18 + 4 = 22 ~ honest N target
}

function main(): void {
  const P = loadD6Panel();
  const nTone = P.tone.filter((v) => Number.isFinite(v)).length;
  const nVol = P.volume.filter((v) => Number.isFinite(v)).length;
  console.log(
    `panel: ${P.dates.length} BTC days (${P.dates[0]}..${P.dates[P.dates.length - 1]}), tone obs=${nTone}, volume obs=${nVol}`,
  );

  // diagnostic: is tone REACTIVE? correlate tone[t] with PAST return (ret[t]) and tone[t] with fwdRet[t].
  diagReactivity(P);

  const startIdx = firstTradable(P);
  console.log(`startIdx=${startIdx} (${P.dates[startIdx]})`);

  // ---------------- main tone grid ----------------
  const configs = gridTone();
  const canonical: Cfg = { feature: "level", window: 21, threshold: 0.0, detrend: 1, momWin: 21, longOnly: 1 };
  const out = runGauntlet({ name: "D6-S5 GDELT tone (de-trended, t-1)", P, configs, canonical, startIdx, nSurr: 500 });
  printVerdict(out);

  // ---------------- robustness: NO de-trend (shows the coincident-beta inflation) ----------------
  const rawConfigs = configs.map((c) => ({ ...c, detrend: 0 as 0 }));
  const rawCanon: Cfg = { ...canonical, detrend: 0 };
  const outRaw = runGauntlet({
    name: "D6-S5 GDELT tone RAW (no de-trend — coincident-beta strip)",
    P,
    configs: rawConfigs,
    canonical: rawCanon,
    startIdx,
    nSurr: 500,
  });
  printVerdict(outRaw);

  // ---------------- density (article volume) sibling ----------------
  const densConfigs: Cfg[] = [];
  for (const feature of ["level", "change"] as const)
    for (const window of [10, 21, 42])
      for (const threshold of [0.0, 0.5, 1.0])
        densConfigs.push({ feature, window, threshold, detrend: 1, momWin: 21, longOnly: 1 });
  const densCanon: Cfg = { feature: "change", window: 21, threshold: 0.5, detrend: 1, momWin: 21, longOnly: 1 };
  // re-point the panel's "tone" to volume for the density test
  const Pd: D6Panel = { ...P, tone: P.volume.slice() };
  const outDens = runGauntlet({
    name: "D6-S5 GDELT density (article volume, de-trended, t-1)",
    P: Pd,
    configs: densConfigs,
    canonical: densCanon,
    startIdx,
    nSurr: 500,
  });
  printVerdict(outDens);

  // ---------------- summary block for the deliverable ----------------
  console.log(`\n--- D6-S5 SUMMARY ---`);
  for (const o of [out, outRaw, outDens]) {
    console.log(
      `${o.name}: verdict=${o.verdict} bestNetSh=${o.best.netSharpeAnn.toFixed(3)} binding=${o.bindingGate} surrP=${o.surrogateP.toFixed(3)} holdoutSh=${o.holdoutSharpeAnn.toFixed(3)}`,
    );
  }
}

// Diagnostic: contemporaneous & lead-lag correlations to expose reactivity vs predictiveness.
function diagReactivity(P: D6Panel): void {
  const idx: number[] = [];
  for (let t = 1; t < P.price.length - 1; t++)
    if (Number.isFinite(P.tone[t]) && Number.isFinite(P.ret[t]) && Number.isFinite(P.fwdRet[t])) idx.push(t);
  const tone = idx.map((t) => P.tone[t]);
  const pastRet = idx.map((t) => P.ret[t]); // return INTO day t (reactive channel)
  const fwd = idx.map((t) => P.fwdRet[t]); // return AFTER day t (predictive channel)
  // also tone[t-1] vs fwdRet[t] (the actual strict-t-1 predictive test)
  const toneLag = idx.map((t) => P.tone[t - 1]);
  console.log(
    `diag reactivity (n=${idx.length}): corr(tone_t, pastRet_t)=${corr(tone, pastRet).toFixed(3)} [reactive]  ` +
      `corr(tone_t, fwdRet_t)=${corr(tone, fwd).toFixed(3)}  corr(tone_{t-1}, fwdRet_t)=${corr(toneLag, fwd).toFixed(3)} [strict-t-1 predictive]`,
  );
  // AR(1) of tone (for the placebo sanity)
  const c = tone.map((v) => v - mean(tone));
  let num = 0,
    den = 0;
  for (let i = 1; i < c.length; i++) {
    num += c[i] * c[i - 1];
    den += c[i - 1] * c[i - 1];
  }
  console.log(`diag tone AR(1)=${(den > 0 ? num / den : 0).toFixed(3)}  toneStd=${std(tone).toFixed(3)}`);
}

function corr(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = mean(a),
    mb = mean(b);
  let sab = 0,
    saa = 0,
    sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

main();
