/**
 * D7-DOW strengthen: isolate the calendar effect from long-beta drift.
 *
 * The best 3-sign config was ~"buy&hold minus Wednesday", which mostly inherits BTC's secular long
 * drift (B&H Sharpe 0.51). The BACKLOG KEY control = DEMEAN SECULAR DRIFT. So here we test the
 * weekday effect on DRIFT-DEMEANED returns: subtract the per-day grand mean so the strategy can only
 * profit from the weekday-relative pattern, not from being long a rising asset.
 *
 * We run two honest variants and an explicit beta-neutral spread:
 *   (A) 3-sign grid on DEMEANED fwd returns (honest N = 3^7-1). Position earns demeaned return.
 *   (B) beta-neutral single spread: long best weekday, short worst weekday (selected in-sample),
 *       honest N = 7*6 = 42 ordered pairs. Calendar-reanchor null. Net exposure ~0 -> no long-beta.
 *
 * Right null throughout = calendar-reanchor.
 */
import {
  loadDaily,
  allSignConfigs,
  mean,
  std,
  sharpeDaily,
  annSharpe,
  mkRng,
  rotatedFwdRet,
  DailySeries,
} from "./d7dow_harness.ts";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const COST = 0.0004;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// demean: subtract the grand mean of fwdRet (estimated IN-SAMPLE only, applied everywhere -> causal)
function demeanedRet(S: DailySeries, splitIdx: number): number[] {
  const inS: number[] = [];
  for (let t = 0; t < splitIdx; t++) if (Number.isFinite(S.fwdRet[t])) inS.push(S.fwdRet[t]);
  const gm = mean(inS);
  return S.fwdRet.map((r) => (Number.isFinite(r) ? r - gm : NaN));
}

function runSign(S: DailySeries, fwd: number[], sign: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let t = lo; t < hi; t++) {
    const fr = fwd[t];
    if (!Number.isFinite(fr)) continue;
    const pos = sign[S.weekday[t]];
    out.push(pos * fr - Math.abs(pos - prev) * COST);
    prev = pos;
  }
  return out;
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z / Math.SQRT2) * (z / Math.SQRT2));
  const cdf = 0.5 * (1 + (z >= 0 ? y : -y));
  return cdf;
}
function psrZ(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
function toFolds(x: number[], nf: number): number[][] {
  const f: number[][] = [];
  const sz = Math.floor(x.length / nf);
  for (let i = 0; i < nf; i++) f.push(x.slice(i * sz, i === nf - 1 ? x.length : (i + 1) * sz));
  return f;
}

function gauntlet(name: string, S: DailySeries, configs: number[][], useDemean: boolean) {
  const T = S.close.length;
  const startIdx = 0;
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * 0.8);
  const fwdIS = useDemean ? demeanedRet(S, splitIdx) : S.fwdRet;

  const scored = configs.map((sign) => {
    const dn = runSign(S, fwdIS, sign, startIdx, splitIdx);
    return { sign, label: sign.map((s, i) => (s ? `${s > 0 ? "+" : "-"}${WD[i]}` : "")).filter(Boolean).join(",") || "flat", dn, sh: annSharpe(sharpeDaily(dn)) };
  });
  scored.sort((a, b) => b.sh - a.sh);
  const best = scored[0];
  const N = configs.length;

  const dsr = computeDeflatedSharpeRatio(best.dn, { trialCount: N });
  const bb = blockBootstrapConfidenceInterval(best.dn, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: `${name}-bb` });
  const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.dn, 6) }));
  let pbo = 1;
  try { pbo = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }).pbo; } catch {}
  const psrP = 1 - normalCdf(psrZ(best.dn));
  const adjP = Math.min(1, psrP * N);

  // calendar-reanchor null (on the SAME demean/raw basis, in-sample window)
  const nSurr = 500;
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const shift = 1 + Math.floor(rng() * (span - 2));
    const fwdR = rotatedFwdRet(S, shift);
    const fwdRot = useDemean ? (() => { const isv: number[] = []; for (let t = 0; t < splitIdx; t++) if (Number.isFinite(fwdR[t])) isv.push(fwdR[t]); const gm = mean(isv); return fwdR.map((r) => (Number.isFinite(r) ? r - gm : NaN)); })() : fwdR;
    const dn = runSign(S, fwdRot, best.sign, startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(dn)));
  }
  surr.sort((a, b) => a - b);
  const surrP = (surr.filter((s) => s >= best.sh).length + 1) / (nSurr + 1);

  // holdout: best config, OOS, ALWAYS on RAW returns (real money) regardless of demean for selection
  const holdDn = runSign(S, S.fwdRet, best.sign, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdDn));
  const holdDemeanDn = runSign(S, useDemean ? demeanedRet(S, splitIdx) : S.fwdRet, best.sign, splitIdx, tradableEnd);
  const holdDemeanSh = annSharpe(sharpeDaily(holdDemeanDn));

  const meanDaily = mean(best.dn);
  console.log(`\n--- ${name} ---`);
  console.log(`honestN=${N} best=${best.label} netSharpeAnn(sel-basis)=${best.sh.toFixed(3)}`);
  console.log(`  DSR p=${dsr.deflatedProbability.toFixed(4)} | bbCI=[${bb.lower.toExponential(2)},${bb.upper.toExponential(2)}] | PBO=${pbo.toFixed(3)} | haircut adjP=${adjP.toExponential(2)}`);
  console.log(`  calendar-reanchor placeboP=${surrP.toFixed(4)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr*0.95)].toFixed(3)}`);
  console.log(`  HOLDOUT raw netSharpe=${holdSh.toFixed(3)} | holdout demean-basis netSharpe=${holdDemeanSh.toFixed(3)} over ${holdDn.length} rows`);
  const monthly = meanDaily * 30 * 100000;
  return { name, N, best: best.label, sh: best.sh, dsrP: dsr.deflatedProbability, bbLo: bb.lower, pbo, adjP, surrP, holdSh, holdDemeanSh, monthly };
}

const S = loadDaily(process.argv[2] ?? "BTC");

// (A) 3-sign grid on DEMEANED returns -> isolates calendar from long-beta. honest N = 3^7-1.
gauntlet("A: 3-sign grid, DEMEANED (drift-removed)", S, allSignConfigs(), true);

// (B) beta-neutral spread: long day i, short day j (all ordered pairs). honest N = 42.
const pairs: number[][] = [];
for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) if (i !== j) { const s = new Array(7).fill(0); s[i] = 1; s[j] = -1; pairs.push(s); }
gauntlet("B: beta-neutral 1-long/1-short spread (raw)", S, pairs, false);

// (C) single best weekday LONG-ONLY on demeaned (honest N=7) — the simplest pre-registered form.
const singles: number[][] = [];
for (let i = 0; i < 7; i++) { const s = new Array(7).fill(0); s[i] = 1; singles.push(s); }
gauntlet("C: single best weekday LONG, DEMEANED (N=7)", S, singles, true);

// (D) single best weekday SHORT-or-LONG on demeaned (honest N=14) — sign chosen too.
const single14: number[][] = [];
for (let i = 0; i < 7; i++) for (const sg of [1, -1]) { const s = new Array(7).fill(0); s[i] = sg; single14.push(s); }
gauntlet("D: single best weekday +/- , DEMEANED (N=14)", S, single14, true);
