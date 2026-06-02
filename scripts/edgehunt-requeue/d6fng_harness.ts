/**
 * D6-FNG — Crypto Fear & Greed contrarian timer. Strongest-honest gauntlet.
 *
 * Belief (BACKLOG D6-S1): buy Extreme Fear, lighten/sell Extreme Greed, strictly lagged.
 * Mechanism the test must defeat: CFGI is largely a lagged price transform (vol+momentum);
 * returns Granger-cause the index (confirmed in explore: corr(FNG_t, PAST 7d ret)=0.42,
 * corr(dFNG_t, ret_{t-1})=0.57, FNG does NOT lead price). So the RIGHT null is an
 * AR(1)-matched sentiment placebo: a persistent random series with FNG's phi/sigma. If the
 * contrarian rule scores the same on the placebo, the "edge" is just persistence x BTC drift
 * (the coincident-beta trap), not sentiment content.
 *
 * Gauntlet (committed primitives in src/lib/training/statistical-validation.ts):
 *   net-of-cost (4bps/side taker), baselines (buy&hold / random-lottery), Deflated Sharpe @
 *   HONEST N (= every config tried), CPCV/PBO, Harvey-Liu Bonferroni haircut, the RIGHT
 *   surrogate null (AR(1)-matched sentiment placebo, best-of-grid), consume-once forward holdout.
 *
 * Position is STRICTLY LAGGED: FNG value known at close of day t positions for the return
 * realized over t -> t+1. We additionally test an extra +1d lag (FNG_{t-1}) as a robustness arm.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);

// ---------------------------------------------------------------- data load
function loadFng(): Map<string, number> {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D6/fng_history.json`, "utf8"));
  const m = new Map<string, number>();
  for (const r of j.data) {
    const d = new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10);
    m.set(d, Number(r.value));
  }
  return m;
}
function loadBtc(): Map<string, number> {
  const out = new Map<string, number>();
  const nf1 = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Array<{
    date: string;
    close: number;
  }>;
  for (const r of nf1) if (r.date && Number.isFinite(r.close)) out.set(r.date, r.close);
  const cm = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_btc.json`, "utf8")) as {
    data: Array<{ time: string; PriceUSD?: string }>;
  };
  for (const r of cm.data) {
    if (!r.PriceUSD) continue;
    const d = r.time.slice(0, 10);
    if (!out.has(d)) {
      const px = Number(r.PriceUSD);
      if (Number.isFinite(px)) out.set(d, px);
    }
  }
  return out;
}

// ---------------------------------------------------------------- math
function mean(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]) {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
}
function sharpeDaily(a: number[]) {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
function annSharpe(ds: number) {
  return ds * ANN;
}
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussFrom(rng: () => number) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------- build aligned panel
const fngMap = loadFng();
const btcMap = loadBtc();
const dates = [...fngMap.keys()].filter((d) => btcMap.has(d)).sort();
const T = dates.length;
const fng: number[] = dates.map((d) => fngMap.get(d)!);
const px: number[] = dates.map((d) => btcMap.get(d)!);
const fwdRet: number[] = new Array(T).fill(NaN); // return over t -> t+1
for (let t = 0; t < T - 1; t++) fwdRet[t] = Math.log(px[t + 1] / px[t]);

// AR(1) fit on the REAL FNG level (for the matched placebo)
function fitAr1(lv: number[]) {
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
  return { phi, c, sigma, mean: mean(lv), sd: std(lv) };
}
const AR = fitAr1(fng);

// ---------------------------------------------------------------- strategy
// Config space. We build a position in [-1,+1] from a LAGGED FNG signal.
//   mode: "contrarian"  -> long when FNG <= buyLo (fear), short/flat when FNG >= sellHi (greed)
//         "longonly"    -> long when FNG <= buyLo, FLAT (de-risk) when FNG >= sellHi, else hold base
//         "zcontrarian" -> position = -clip( z(FNG) ) (rolling-z contrarian, continuous)
//   buyLo, sellHi: thresholds on the 0..100 index
//   greedAction: for contrarian/longonly, what to do in greed: 0 (flat) or -1 (short)
//   base: baseline exposure in the neutral zone (0 or 1)  [for longonly: stay invested by default]
//   lag: extra lag (0 => use FNG at close t; 1 => use FNG_{t-1})  -- robustness
interface Cfg {
  mode: "contrarian" | "longonly" | "zcontrarian";
  buyLo: number;
  sellHi: number;
  greedAction: number; // 0 or -1
  base: number; // 0 or 1
  zwin: number; // rolling window for zcontrarian
  zclip: number;
  lag: number;
  [k: string]: number | string;
}

function rollingZAt(series: number[], t: number, win: number): number {
  const lo = Math.max(0, t - win + 1);
  const w: number[] = [];
  for (let k = lo; k <= t; k++) if (Number.isFinite(series[k])) w.push(series[k]);
  if (w.length < Math.min(30, win)) return NaN;
  const m = mean(w),
    s = std(w);
  return s > 1e-12 ? (series[t] - m) / s : 0;
}

// position[t] applied to fwdRet[t]. signal source supplied so placebo reuses the SAME rule.
function buildPositionFrom(signal: number[], cfg: Cfg): number[] {
  const pos = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    const st = t - cfg.lag; // strictly-lagged signal index
    if (st < 0) continue;
    const v = signal[st];
    if (!Number.isFinite(v)) continue;
    if (cfg.mode === "zcontrarian") {
      const z = rollingZAt(signal, st, cfg.zwin);
      if (!Number.isFinite(z)) continue;
      let p = -Math.max(-cfg.zclip, Math.min(cfg.zclip, z)) / cfg.zclip; // contrarian: low FNG -> long
      pos[t] = p;
    } else {
      let p = cfg.base;
      if (v <= cfg.buyLo) p = 1; // fear -> long
      else if (v >= cfg.sellHi) p = cfg.greedAction; // greed -> flat or short
      pos[t] = p;
    }
  }
  return pos;
}

interface BtResult {
  dailyNet: number[];
  turnover: number;
  exposure: number;
  longShare: number;
  nDays: number;
}
function runPositions(position: number[], lo: number, hi: number): BtResult {
  const dailyNet: number[] = [];
  let prev = 0,
    turnSum = 0,
    expSum = 0,
    longCount = 0;
  for (let t = lo; t < hi; t++) {
    const fr = fwdRet[t];
    const p = position[t];
    if (!Number.isFinite(fr) || !Number.isFinite(p)) continue;
    const turn = Math.abs(p - prev);
    dailyNet.push(p * fr - turn * COST_PER_SIDE);
    turnSum += turn;
    expSum += Math.abs(p);
    if (p > 0) longCount++;
    prev = p;
  }
  const n = dailyNet.length;
  return {
    dailyNet,
    turnover: n ? turnSum / n : 0,
    exposure: n ? expSum / n : 0,
    longShare: n ? longCount / n : 0,
    nDays: n,
  };
}

// ---------------------------------------------------------------- config grid (HONEST N counts ALL)
const configs: Cfg[] = [];
for (const mode of ["contrarian", "longonly"] as const) {
  for (const buyLo of [20, 25, 30, 35]) {
    for (const sellHi of [65, 70, 75, 80]) {
      for (const greedAction of mode === "contrarian" ? [0, -1] : [0]) {
        for (const base of [0, 1]) {
          for (const lag of [0, 1]) {
            configs.push({
              mode,
              buyLo,
              sellHi,
              greedAction,
              base,
              zwin: 0,
              zclip: 0,
              lag,
            });
          }
        }
      }
    }
  }
}
for (const zwin of [60, 90, 180]) {
  for (const zclip of [1.5, 2, 2.5]) {
    for (const lag of [0, 1]) {
      configs.push({
        mode: "zcontrarian",
        buyLo: 0,
        sellHi: 0,
        greedAction: 0,
        base: 0,
        zwin,
        zclip,
        lag,
      });
    }
  }
}
const HONEST_N = configs.length;

// canonical pre-registered config: literal belief, long extreme fear (<25), flat extreme greed (>75),
// stay long in between (base=1), strict 0-lag, no shorting.
const canonical: Cfg = {
  mode: "longonly",
  buyLo: 25,
  sellHi: 75,
  greedAction: 0,
  base: 1,
  zwin: 0,
  zclip: 0,
  lag: 0,
};

// ---------------------------------------------------------------- gauntlet
const startIdx = 200; // warmup for rolling-z; FNG present from day 0 but z needs window
const tradableEnd = T - 1;
const holdoutFrac = 0.2;
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));

// score every config IN-SAMPLE on net Sharpe
const scored = configs.map((cfg) => {
  const pos = buildPositionFrom(fng, cfg);
  const res = runPositions(pos, startIdx, splitIdx);
  const label = `${cfg.mode}|buyLo${cfg.buyLo}|sellHi${cfg.sellHi}|gA${cfg.greedAction}|base${cfg.base}|z${cfg.zwin}/${cfg.zclip}|lag${cfg.lag}`;
  return { cfg, label, pos, res, netSh: annSharpe(sharpeDaily(res.dailyNet)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestNet = best.res.dailyNet;

// baselines
const bhPos = new Array(T).fill(1);
const bh = runPositions(bhPos, startIdx, splitIdx);
const bhSh = annSharpe(sharpeDaily(bh.dailyNet));
const exposure = best.res.exposure;
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(424242 + i * 2654435761);
  const pos = new Array(T).fill(0);
  for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < exposure ? 1 : 0;
  const r = runPositions(pos, startIdx, splitIdx);
  rlSh.push(annSharpe(sharpeDaily(r.dailyNet)));
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
  seed: "d6fng-bb",
});
const bbPass = bb.lower > 0;

// CSCV / PBO
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
const cscv = scored.map((s) => ({ id: s.label, folds: toFolds(s.res.dailyNet, 6) }));
let pbo = { pbo: 1, medianLogit: 0 };
try {
  const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
} catch {
  pbo = { pbo: 1, medianLogit: 0 };
}
const pboPass = pbo.pbo < 0.5;

// Harvey-Liu Bonferroni haircut
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normalCdf(z: number) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function zSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
const psrP = 1 - normalCdf(zSharpe(bestNet));
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// ---- THE RIGHT NULL: AR(1)-matched sentiment placebo (best-of-grid) ----
// Generate a fake sentiment series with FNG's phi/c/sigma, clipped to [0,100] like the real index,
// run the FULL grid on it, take the best in-sample net Sharpe. p = frac(placebo_best >= real_best).
function simAr1Placebo(rng: () => number): number[] {
  const fake = new Array<number>(T);
  fake[0] = AR.mean;
  for (let i = 1; i < T; i++) {
    let v = AR.c + AR.phi * fake[i - 1] + AR.sigma * gaussFrom(rng);
    if (v < 0) v = 0;
    if (v > 100) v = 100;
    fake[i] = v;
  }
  return fake;
}
function bestNetSharpeOnSignal(signal: number[]): number {
  let bestS = -Infinity;
  for (const cfg of configs) {
    const pos = buildPositionFrom(signal, cfg);
    const res = runPositions(pos, startIdx, splitIdx);
    const s = annSharpe(sharpeDaily(res.dailyNet));
    if (s > bestS) bestS = s;
  }
  return bestS;
}
const NS = 500;
const placebo: number[] = [];
let ge = 0;
for (let s = 0; s < NS; s++) {
  const rng = mkRng(7000 + s * 7919);
  const fake = simAr1Placebo(rng);
  const bs = bestNetSharpeOnSignal(fake);
  placebo.push(bs);
  if (bs >= best.netSh) ge++;
}
placebo.sort((a, b) => a - b);
const surrP = (ge + 1) / (NS + 1);
const surrPass = surrP < 0.05;

// consume-once forward holdout (best cfg only, OOS)
const holdRes = runPositions(best.pos, splitIdx, tradableEnd);
const holdSh = annSharpe(sharpeDaily(holdRes.dailyNet));
const holdoutPass = holdSh > 0;

// canonical pre-registered (N=1)
const canonPos = buildPositionFrom(fng, canonical);
const canonRes = runPositions(canonPos, startIdx, splitIdx);
const canonSh = annSharpe(sharpeDaily(canonRes.dailyNet));
const canonHold = runPositions(canonPos, splitIdx, tradableEnd);
const canonHoldSh = annSharpe(sharpeDaily(canonHold.dailyNet));
// canonical placebo p (single-config rule on AR(1) placebo)
let canonGe = 0;
for (let s = 0; s < NS; s++) {
  const rng = mkRng(99000 + s * 7919);
  const fake = simAr1Placebo(rng);
  const pos = buildPositionFrom(fake, canonical);
  const res = runPositions(pos, startIdx, splitIdx);
  if (annSharpe(sharpeDaily(res.dailyNet)) >= canonSh) canonGe++;
}
const canonSurrP = (canonGe + 1) / (NS + 1);

// ---------------------------------------------------------------- report
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: {
    pass: mean(bestNet) > 0,
    detail: `netMeanDaily=${mean(bestNet).toExponential(3)} turnover=${best.res.turnover.toFixed(3)}`,
  },
  baselines: {
    pass: baselinePass,
    detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomLottery95=${rl95.toFixed(3)}`,
  },
  deflated_sharpe: {
    pass: dsrPass,
    detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)}`,
  },
  block_bootstrap: {
    pass: bbPass,
    detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
  },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
  haircut: {
    pass: haircutPass,
    detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})`,
  },
  surrogate: {
    pass: surrPass,
    detail: `AR(1)-placebo p=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} placeboMed=${placebo[Math.floor(NS / 2)].toFixed(3)} placebo95=${placebo[Math.floor(NS * 0.95)].toFixed(3)} placeboMax=${placebo[NS - 1].toFixed(3)}`,
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
for (const g of order) if (!gates[g].pass) { binding = g; break; }
const allPass = binding === "none";
const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
const meanDailyNet = mean(bestNet);
const monthlyAt100k = meanDailyNet * 30 * 100000;

console.log(`\n================ D6-FNG Fear&Greed contrarian ================`);
console.log(`aligned days=${T} (${dates[0]}..${dates[T - 1]})  startIdx=${startIdx} splitIdx=${splitIdx} tradableEnd=${tradableEnd}`);
console.log(`AR(1) FNG fit: phi=${AR.phi.toFixed(4)} sigma=${AR.sigma.toFixed(3)} mean=${AR.mean.toFixed(2)} sd=${AR.sd.toFixed(2)}`);
console.log(`honestN=${HONEST_N}  best=${best.label}`);
console.log(
  `best netSharpeAnn=${best.netSh.toFixed(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)} longShare=${best.res.longShare.toFixed(2)} nDays=${best.res.nDays}`,
);
console.log(`B&H netSharpeAnn(IS)=${bhSh.toFixed(3)}`);
for (const g of order) console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
console.log(
  `canonical(longonly buyLo25/sellHi75/base1/lag0): netSharpeAnn=${canonSh.toFixed(3)} AR(1)-placeboP=${canonSurrP.toFixed(4)} holdoutSharpeAnn=${canonHoldSh.toFixed(3)}`,
);
console.log(`binding gate=${binding}`);
const monthly = binding === "none" ? `$${Math.round(monthlyAt100k)}` : "n/a";
console.log(
  `RESULT: verdict=${verdict} netSharpe=${best.netSh.toFixed(3)} binding=${binding} honestN=${HONEST_N} surrP=${surrP.toFixed(3)} monthly@100k=${monthly} holdoutSharpe=${holdSh.toFixed(3)}`,
);

// also dump top-5 configs for transparency
console.log(`\ntop-5 IS configs:`);
for (let i = 0; i < 5; i++) {
  const s = scored[i];
  console.log(`  ${s.netSh.toFixed(3)}  ${s.label}  exp=${s.res.exposure.toFixed(2)} turn=${s.res.turnover.toFixed(3)}`);
}

fs.writeFileSync(
  `${ROOT}/output/edgehunt-requeue/d6fng_result.json`,
  JSON.stringify(
    {
      name: "D6-FNG",
      alignedDays: T,
      dateRange: [dates[0], dates[T - 1]],
      ar1: AR,
      honestN: HONEST_N,
      best: { label: best.label, cfg: best.cfg, netSharpeAnn: best.netSh, ...best.res, dailyNet: undefined },
      bhSharpeIS: bhSh,
      gates,
      binding,
      verdict,
      surrP,
      holdoutSharpeAnn: holdSh,
      canonical: { netSharpeAnn: canonSh, surrP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
      monthlyAt100k: binding === "none" ? monthlyAt100k : null,
    },
    null,
    2,
  ),
);
