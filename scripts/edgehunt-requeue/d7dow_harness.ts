/**
 * D7-DOW — Day-of-week / weekend effect.
 *
 * Claim: certain weekday(s) have a persistent return premium in BTC (Monday/weekend-effect analog).
 * Strategy: bucket daily returns by weekday, take a {-1,0,+1} position per weekday, capture the
 * NEXT-day return. Strictly causal: the weekday of day t (whose fwd return we earn) is known at the
 * close of day t-1, so position[t] = sign(weekday(t)) involves zero look-ahead.
 *
 * Honest N = every weekday combo. With sign in {-1,0,+1} per weekday that is 3^7 = 2187 configs.
 * We also report the long-only subset count (2^7-1 = 127) for context.
 *
 * RIGHT null for a calendar claim = CALENDAR-REANCHOR: circularly rotate the return series relative
 * to the weekday labels by a random integer offset. This destroys the weekday->return mapping while
 * exactly preserving the autocorrelation, vol-clustering, trend and fat tails of the price path.
 * (A within-day-of-week block permute or phase-randomization is a weaker null; calendar-reanchor is
 * the pre-registered control in the BACKLOG.)
 *
 * Full committed gauntlet: net-of-cost (4bps taker/side), baselines (B&H / random-lottery),
 * Deflated Sharpe @ honest N, block-bootstrap CI, CPCV/PBO, Harvey-Liu (Bonferroni) haircut,
 * calendar-reanchor surrogate null, consume-once forward holdout (last 20%).
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
export const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);

// ---------------------------------------------------------------- data
export interface DailySeries {
  asset: string;
  dates: string[]; // YYYY-MM-DD ascending
  close: number[];
  weekday: number[]; // UTC getUTCDay 0=Sun..6=Sat for day t
  fwdRet: number[]; // log close[t]->close[t+1]; last = NaN
}

export function loadDaily(asset: string): DailySeries {
  const raw = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/${asset}_daily_ohlc.json`, "utf8")) as {
    date: string;
    close: number;
  }[];
  const rows = raw.filter((r) => r.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  const dates = rows.map((r) => r.date);
  const close = rows.map((r) => r.close);
  const weekday = dates.map((d) => new Date(d + "T00:00:00Z").getUTCDay());
  const fwdRet: number[] = [];
  for (let t = 0; t < close.length; t++)
    fwdRet.push(t + 1 < close.length ? Math.log(close[t + 1] / close[t]) : NaN);
  return { asset, dates, close, weekday, fwdRet };
}

// ---------------------------------------------------------------- math
export function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
export function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
export function sharpeDaily(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
export function annSharpe(d: number): number {
  return d * ANN;
}
export function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- backtest
export interface BtResult {
  dailyNet: number[];
  dailyGross: number[];
  turnover: number;
  exposure: number;
  nDays: number;
  longShare: number;
}
// position[t] earns fwdRet[t]; weekdaySign maps weekday(t) -> {-1,0,+1}
export function runWeekday(
  S: DailySeries,
  weekdaySign: number[], // length 7
  startIdx: number,
  endIdx: number, // exclusive
  costPerSide = COST_PER_SIDE,
): BtResult {
  const dailyNet: number[] = [];
  const dailyGross: number[] = [];
  let prev = 0;
  let turnoverSum = 0;
  let expSum = 0;
  let longCount = 0;
  let cnt = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = S.fwdRet[t];
    if (!Number.isFinite(fr)) continue;
    const pos = weekdaySign[S.weekday[t]];
    const turn = Math.abs(pos - prev);
    const cost = turn * costPerSide;
    const gross = pos * fr;
    dailyGross.push(gross);
    dailyNet.push(gross - cost);
    turnoverSum += turn;
    expSum += Math.abs(pos);
    if (pos > 0) longCount++;
    if (pos !== 0) cnt++;
    prev = pos;
  }
  const n = dailyNet.length;
  return {
    dailyNet,
    dailyGross,
    turnover: n ? turnoverSum / n : 0,
    exposure: n ? expSum / n : 0,
    nDays: n,
    longShare: n ? longCount / n : 0,
  };
}

// calendar-reanchor: rotate fwdRet array by `shift` relative to the weekday labels (circular).
// We build a rotated fwdRet so that day t (weekday w) now earns the return that originally belonged
// to a different calendar day, destroying the weekday->return alignment but preserving all serial
// structure of the return path.
export function rotatedFwdRet(S: DailySeries, shift: number): number[] {
  const n = S.fwdRet.length;
  // collect finite fwdRet in order, rotate, reinsert at the same positions
  const idx: number[] = [];
  for (let t = 0; t < n; t++) if (Number.isFinite(S.fwdRet[t])) idx.push(t);
  const vals = idx.map((t) => S.fwdRet[t]);
  const m = vals.length;
  const out = S.fwdRet.slice();
  const sh = ((shift % m) + m) % m;
  for (let k = 0; k < m; k++) out[idx[k]] = vals[(k + sh) % m];
  return out;
}
function runWeekdayWithRet(
  S: DailySeries,
  fwd: number[],
  weekdaySign: number[],
  startIdx: number,
  endIdx: number,
  costPerSide = COST_PER_SIDE,
): number[] {
  const dailyNet: number[] = [];
  let prev = 0;
  for (let t = startIdx; t < endIdx; t++) {
    const fr = fwd[t];
    if (!Number.isFinite(fr)) continue;
    const pos = weekdaySign[S.weekday[t]];
    const turn = Math.abs(pos - prev);
    dailyNet.push(pos * fr - turn * costPerSide);
    prev = pos;
  }
  return dailyNet;
}

// ---------------------------------------------------------------- config space
// every weekday combo with sign in {-1,0,+1}: 3^7 = 2187 (includes all-flat which we drop)
export function allSignConfigs(): number[][] {
  const out: number[][] = [];
  const rec = (i: number, cur: number[]) => {
    if (i === 7) {
      if (cur.some((v) => v !== 0)) out.push(cur.slice());
      return;
    }
    for (const s of [-1, 0, 1]) {
      cur.push(s);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

// ---------------------------------------------------------------- gauntlet
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function labelOf(sign: number[]): string {
  return sign.map((s, i) => (s === 0 ? null : `${s > 0 ? "+" : "-"}${WD[i]}`)).filter(Boolean).join(",") || "flat";
}
function toFolds(series: number[], nfolds: number): number[][] {
  const folds: number[][] = [];
  const sz = Math.floor(series.length / nfolds);
  for (let f = 0; f < nfolds; f++) {
    const lo = f * sz;
    const hi = f === nfolds - 1 ? series.length : lo + sz;
    folds.push(series.slice(lo, hi));
  }
  return folds;
}
function normalCdfLocal(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}

export interface DowGauntletInput {
  name: string;
  S: DailySeries;
  configs: number[][]; // honest N
  canonical: number[]; // pre-registered (e.g. long Monday only)
  startIdx: number;
  holdoutFrac?: number;
  nSurr?: number;
}

export function runDowGauntlet(input: DowGauntletInput) {
  const { S, configs } = input;
  const HONEST_N = configs.length;
  const holdoutFrac = input.holdoutFrac ?? 0.2;
  const nSurr = input.nSurr ?? 400;
  const T = S.close.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - input.startIdx;
  const splitIdx = input.startIdx + Math.floor(span * (1 - holdoutFrac));

  // score every config in-sample
  const scored = configs.map((sign) => {
    const res = runWeekday(S, sign, input.startIdx, splitIdx);
    return { sign, label: labelOf(sign), res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];
  const bestNet = best.res.dailyNet;

  // baselines
  const bhRes = runWeekday(S, [1, 1, 1, 1, 1, 1, 1], input.startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bhRes.dailyNet));
  const exposure = best.res.exposure;
  const rlSh: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    // random-lottery matched to exposure: random in/out (long) each day
    const dailyNet: number[] = [];
    let prev = 0;
    for (let t = input.startIdx; t < splitIdx; t++) {
      const fr = S.fwdRet[t];
      if (!Number.isFinite(fr)) continue;
      const pos = rng() < exposure ? 1 : 0;
      dailyNet.push(pos * fr - Math.abs(pos - prev) * COST_PER_SIDE);
      prev = pos;
    }
    rlSh.push(annSharpe(sharpeDaily(dailyNet)));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  const baselinePass = best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

  // Deflated Sharpe @ honest N
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // block bootstrap CI on mean daily net
  const bb = blockBootstrapConfidenceInterval(bestNet, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 20,
    confidenceLevel: 0.95,
    seed: `${input.name}-bb`,
  });
  const bbPass = bb.lower > 0;

  // CPCV / PBO across all configs (cap to keep runtime sane but honest: subsample top + random)
  const NFOLDS = 6;
  const cscvSet = scored; // all configs
  const cscv = cscvSet.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, NFOLDS) }));
  let pbo = { pbo: 1, medianLogit: 0 };
  try {
    const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch {
    pbo = { pbo: 1, medianLogit: 0 };
  }
  const pboPass = pbo.pbo < 0.5;

  // Harvey-Liu Bonferroni haircut
  const psrP = 1 - normalCdfLocal(zSharpe(bestNet));
  const adjP = Math.min(1, psrP * HONEST_N);
  const haircutPass = adjP < 0.05;

  // CALENDAR-REANCHOR surrogate null (the right null)
  const surr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(7000 + i * 7919);
    const shift = 1 + Math.floor(rng() * (span - 2)); // nonzero rotation
    const fwd = rotatedFwdRet(S, shift);
    const dn = runWeekdayWithRet(S, fwd, best.sign, input.startIdx, splitIdx);
    surr.push(annSharpe(sharpeDaily(dn)));
  }
  surr.sort((a, b) => a - b);
  const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // consume-once forward holdout (best cfg only)
  const holdRes = runWeekday(S, best.sign, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
  const holdoutPass = holdSh > 0;

  // canonical pre-registered (N=1)
  const canonRes = runWeekday(S, input.canonical, input.startIdx, splitIdx);
  const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
  const canonSurr: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(99000 + i * 7919);
    const shift = 1 + Math.floor(rng() * (span - 2));
    const fwd = rotatedFwdRet(S, shift);
    const dn = runWeekdayWithRet(S, fwd, input.canonical, input.startIdx, splitIdx);
    canonSurr.push(annSharpe(sharpeDaily(dn)));
  }
  canonSurr.sort((a, b) => a - b);
  const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
  const canonHold = runWeekday(S, input.canonical, splitIdx, tradableEnd);
  const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));

  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: {
      pass: mean(bestNet) > 0,
      detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)}`,
    },
    baselines: {
      pass: baselinePass,
      detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}`,
    },
    deflated_sharpe: {
      pass: dsrPass,
      detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} sh=${dsr.sharpe.toFixed(4)}`,
    },
    block_bootstrap: {
      pass: bbPass,
      detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
    },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: {
      pass: haircutPass,
      detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)}*N=${HONEST_N})`,
    },
    surrogate: {
      pass: surrPass,
      detail: `calendar-reanchor placeboP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
    },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.nDays} rows` },
  };
  const order = [
    "net_of_cost",
    "baselines",
    "deflated_sharpe",
    "block_bootstrap",
    "cpcv_pbo",
    "haircut",
    "surrogate",
    "holdout",
  ];
  let binding = "none";
  for (const g of order)
    if (!gates[g].pass) {
      binding = g;
      break;
    }
  const allPass = binding === "none";
  const survivesCore =
    gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
  const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
  const meanDailyNet = mean(bestNet);
  const monthlyAt100k = meanDailyNet * 30 * 100000;

  return {
    name: input.name,
    honestN: HONEST_N,
    best: {
      label: best.label,
      sign: best.sign,
      netSharpeAnn: best.netSh,
      grossSharpeAnn: annSharpe(sharpeDaily(best.res.dailyGross)),
      meanDailyNet,
      turnover: best.res.turnover,
      exposure: best.res.exposure,
      longShare: best.res.longShare,
      nDays: best.res.nDays,
      monthlyAt100k,
    },
    canonical: { label: labelOf(input.canonical), netSharpeAnn: canonSh, surrogateP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
    gates,
    bindingGate: binding,
    verdict,
    surrogateP: surrP,
    holdoutSharpeAnn: holdSh,
    bhSh,
    splitIdx,
    tradableEnd,
  };
}

export function printDow(o: ReturnType<typeof runDowGauntlet>) {
  console.log(`\n================ ${o.name} ================`);
  console.log(`honestN=${o.honestN}  best=${o.best.label}`);
  console.log(
    `best netSharpeAnn=${o.best.netSharpeAnn.toFixed(3)} grossSharpeAnn=${o.best.grossSharpeAnn.toFixed(3)} turnover=${o.best.turnover.toFixed(3)} exposure=${o.best.exposure.toFixed(3)} longShare=${o.best.longShare.toFixed(2)} nDays=${o.best.nDays} B&H=${o.bhSh.toFixed(3)}`,
  );
  for (const [g, r] of Object.entries(o.gates)) console.log(`  [${r.pass ? "PASS" : "KILL"}] ${g} — ${r.detail}`);
  console.log(
    `canonical(${o.canonical.label}): netSharpeAnn=${o.canonical.netSharpeAnn.toFixed(3)} surrP=${o.canonical.surrogateP.toFixed(4)} holdoutSharpeAnn=${o.canonical.holdoutSharpeAnn.toFixed(3)}`,
  );
  const monthly = o.bindingGate === "none" ? `$${Math.round(o.best.monthlyAt100k)}` : "n/a";
  console.log(
    `VERDICT: ${o.verdict} | net Sharpe ${o.best.netSharpeAnn.toFixed(3)} | binding gate ${o.bindingGate} | honest N ${o.honestN} | surrogate p ${o.surrogateP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${o.holdoutSharpeAnn.toFixed(3)}`,
  );
}
