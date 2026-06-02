/**
 * DEEPEN — VRP harvest, CRASH-GATE-ONLY (drop the failed z-sizing).
 *
 * PRIOR (output/edgehunt/vrp-FINAL.json) FAILED: the z-SIZING was indistinguishable
 * from random — shuffled-VRP placebo p=0.14, DSR@N90 p=0.53. The decomposition showed
 * the value driver was the GATE ("don't sell into the crash"), NOT the sizing.
 *
 * THIS TEST re-frames the GATE as the PRIMARY, PRE-REGISTERED hypothesis:
 *   "A long/flat short-variance harvest that is ON (full short variance) when DVOL is
 *    benign, and FLAT when DVOL spikes / regime malign — NO z-sizing — earns a real,
 *    deflation-surviving net premium."
 *
 * PRE-REGISTERED CANONICAL CONFIG (chosen from prior decompose `premium_gated`, frozen
 * BEFORE seeing this test's holdout):
 *   asset=BTC, horizon=7d, est=blend, zLookback=90, spikeGate z>1.5 => FLAT,
 *   regimeGate ON (trailing RV above its 60th pct => FLAT), else FULL short (size=1).
 *   Position in {0,1}. NO sizing. Vol-target only rescales the whole stream (does not
 *   change Sharpe / gate decisions). ETH h7 cc reported as out-of-asset robustness.
 *
 * HONEST N = every GATE config tried here (horizons x ests x spikeGates x regimeOpts,
 *   per asset) — the sizing grid is GONE, so N is much smaller and honest for the
 *   gate-only family.
 *
 * COSTS (charged on every position change, both assets):
 *   - taker 4 bps/side on entry+exit+daily delta-hedge rebalances of the perp hedge
 *   - perp funding drag over the held window (delta-hedge carry)
 *   - explicit CONVEX crash-tail charge when realized vol blows past implied (gamma/jump
 *     loss beyond the linear variance payoff)
 *
 * GATES (committed primitives, src/lib/training/statistical-validation.ts):
 *   net-of-cost, DSR @ honest N (gate-only count), block-bootstrap CI on mean net,
 *   tail-matched block-bootstrap surrogate, CSCV/PBO across the gate family,
 *   shuffled-GATE placebo (the right null for a GATE), consume-once holdout.
 *
 * PROMOTE to SURVIVE only if the SINGLE pre-registered config clears the binding gate
 * (DSR @ honest N) AND the placebo, on the holdout it never saw.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeProbabilisticSharpeRatio,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation";

const ANN_DAYS = 365;
const TAKER = 0.0004; // 4 bps per side
const TAIL_MULT = 1.5; // realistic convex crash-tail multiplier (same as prior tailstress)
const VOL_TARGET = 0.10; // 10% ann vol target — rescales stream only, no effect on Sharpe/gates

// ---------------------------------------------------------------- io / math
function readJson<T>(p: string): T { return JSON.parse(readFileSync(p, "utf8")) as T; }
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const quantile = (s: number[], q: number) => { if (!s.length) return 0; const p = (s.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return lo === hi ? s[lo] : s[lo] * (hi - p) + s[hi] * (p - lo); };
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface DvolRow { date: string; close: number; }
interface DayOHLC { date: string; open: number; high: number; low: number; close: number; }
interface VarRow { date: string; cc: number; park: number; gk: number; }
type Est = "cc" | "park" | "gk" | "blend";

function loadBtcDaily(): DayOHLC[] {
  const raw = readFileSync("output/bigquery/btc_ohlcv_15m.ndjson", "utf8").split("\n");
  const byDay = new Map<string, DayOHLC>();
  for (const line of raw) { if (!line) continue; const r = JSON.parse(line); const date = r.event_date as string; const c = byDay.get(date);
    if (!c) byDay.set(date, { date, open: r.open, high: r.high, low: r.low, close: r.close });
    else { c.high = Math.max(c.high, r.high); c.low = Math.min(c.low, r.low); c.close = r.close; } }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function dailyVar(days: DayOHLC[]): VarRow[] {
  const out: VarRow[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i]; const prev = i > 0 ? days[i - 1].close : d.open;
    const rc = Math.log(d.close / prev), hl = Math.log(d.high / d.low), co = Math.log(d.close / d.open);
    const park = (1 / (4 * Math.log(2))) * hl * hl;
    const gk = 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
    out.push({ date: d.date, cc: rc * rc, park: Math.max(0, park), gk: Math.max(0, gk) });
  }
  return out;
}
function pick(v: VarRow, est: Est): number {
  return est === "cc" ? v.cc : est === "park" ? v.park : est === "gk" ? v.gk : (v.cc + v.park + v.gk) / 3;
}
function fwdRV(vs: VarRow[], i: number, h: number, est: Est): number | null {
  if (i + h > vs.length) return null; let s = 0; for (let k = i; k < i + h; k++) s += pick(vs[k], est); return Math.sqrt((s / h) * ANN_DAYS);
}
function trailRV(vs: VarRow[], i: number, h: number, est: Est): number | null {
  if (i - h < 0) return null; let s = 0; for (let k = i - h; k < i; k++) s += pick(vs[k], est); return Math.sqrt((s / h) * ANN_DAYS);
}
function dailyFunding(path: string): Map<string, number> {
  const rows = readJson<{ fundingTime: number; fundingRate: number }[]>(path);
  const m = new Map<string, number>();
  for (const r of rows) { const d = new Date(r.fundingTime).toISOString().slice(0, 10); m.set(d, (m.get(d) ?? 0) + r.fundingRate); }
  return m;
}

// ---------------------------------------------------------------- gate config
interface Gate { horizon: number; est: Est; zLookback: number; spikeGate: number; regimeGate: boolean; regimePct: number; }

// One window record from the GATE-ONLY harvest. Position is on (size=1) or flat (size=0).
interface Win { idx: number; date: string; on: boolean; payoffVar: number; iv: number; rvOverIv: number;
  netRet: number; grossRet: number; fundingCost: number; takerCost: number; tailCost: number; crash: boolean; }

function runGate(dvol: DvolRow[], vs: VarRow[], fund: Map<string, number>, g: Gate): Win[] {
  const dvolByDate = new Map(dvol.map((d) => [d.date, d.close / 100]));
  const h = g.horizon;
  const spikeZ = (i: number): number => {
    const iv = dvolByDate.get(vs[i].date); if (iv === undefined) return 0;
    const past: number[] = []; for (let k = Math.max(0, i - g.zLookback); k < i; k++) { const v = dvolByDate.get(vs[k].date); if (v !== undefined) past.push(v); }
    if (past.length < 5) return 0; const m = mean(past), s = std(past) || 1e-9; return (iv - m) / s;
  };
  const benign = (i: number): boolean => {
    const rvs: number[] = []; for (let k = Math.max(h, i - g.zLookback); k <= i; k++) { const r = trailRV(vs, k, h, g.est); if (r !== null) rvs.push(r); }
    if (rvs.length < 10) return true; const cur = rvs.at(-1)!; return cur <= quantile([...rvs].sort((a, b) => a - b), g.regimePct);
  };

  // non-overlapping horizon-step windows (honest N within a config)
  const wins: Win[] = [];
  for (let i = h; i + h <= vs.length; i += h) {
    const date = vs[i].date; const iv = dvolByDate.get(date); if (iv === undefined) continue;
    const fwd = fwdRV(vs, i, h, g.est); if (fwd === null) continue;
    // need enough history for the gate decisions
    const trv = trailRV(vs, i, h, g.est); if (trv === null) continue;
    if (i - g.zLookback < 0) continue; // require full lookback so the gate is well-defined everywhere

    // GATE (pure on/off, NO sizing): ON unless dvol-spike or malign regime.
    let on = true;
    if (spikeZ(i) > g.spikeGate) on = false;
    if (g.regimeGate && !benign(i)) on = false;
    const size = on ? 1 : 0;

    const payoffVar = iv * iv - fwd * fwd; // + when IV>RV (we collect)
    const grossRet = size * payoffVar;

    // costs (only when on / on position change). With pure on/off, turnover at the
    // boundary; we charge the full hedge cycle whenever the position is on for a window.
    let fundSum = 0; for (let k = i; k < i + h; k++) { const f = fund.get(vs[k].date); if (f !== undefined) fundSum += Math.abs(f); }
    const fundingCost = size > 0 ? size * fundSum * 0.5 : 0;
    const rebalances = 2 + h; // open + close + daily delta hedge
    const takerCost = size > 0 ? rebalances * TAKER : 0;
    const rvOverIv = fwd / iv;
    const crash = rvOverIv > 1.5;
    let tailCost = 0;
    if (size > 0 && rvOverIv > 1.0) { const e = rvOverIv - 1.0; tailCost = size * (iv * iv) * e * e * TAIL_MULT; }

    const netRet = grossRet - fundingCost - takerCost - tailCost;
    wins.push({ idx: i, date, on, payoffVar, iv, rvOverIv, netRet, grossRet, fundingCost, takerCost, tailCost, crash });
  }
  return wins;
}

// vol-target rescale (does NOT change Sharpe; just makes monthly$ realistic at a defined risk)
function volScale(rawRets: number[], h: number): number {
  const ann = std(rawRets) * Math.sqrt(ANN_DAYS / h) || 1e-9; return VOL_TARGET / ann;
}
const annSharpe = (r: number[], h: number) => summarizeReturnSeries(r).sharpe * Math.sqrt(ANN_DAYS / h);
const maxDD = (r: number[]) => { let eq = 1, pk = 1, mdd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); } return mdd; };
const calmar = (r: number[], h: number) => { const a = mean(r) * (ANN_DAYS / h); const m = Math.abs(maxDD(r)); return m > 1e-9 ? a / m : 0; };
const cvar = (r: number[], q = 0.05) => { const s = [...r].sort((a, b) => a - b); const n = Math.max(1, Math.floor(s.length * q)); return mean(s.slice(0, n)); };

// ---------------------------------------------------------------- nulls
// TAIL-MATCHED block bootstrap: resample blocks of NET returns preserving crash clustering;
// recentre to zero to test H0 "no edge" while keeping the fat left tail intact.
function tailMatchedBB(rets: number[], h: number, iters = 4000, seed = 777) {
  const observed = annSharpe(rets, h); const r = rng(seed); const n = rets.length;
  const block = Math.max(2, Math.round(Math.sqrt(n))); let ge = 0; const sh: number[] = [];
  for (let it = 0; it < iters; it++) {
    const res: number[] = [];
    while (res.length < n) { const st = Math.floor(r() * n); for (let o = 0; o < block && res.length < n; o++) res.push(rets[(st + o) % n]); }
    const m = mean(res); const cen = res.map((x) => x - m); const s = annSharpe(cen, h); sh.push(s);
    if (Math.abs(s) >= Math.abs(observed)) ge++;
  }
  return { p: ge / iters, meanSharpe: mean(sh), observed };
}

// shuffled-GATE placebo: keep the SAME per-window payoffs/costs ingredients, but RANDOMLY
// reassign which windows are ON vs FLAT, preserving the realized on-fraction. If a random
// gate with the same duty cycle does as well, the gate carries no skill. THIS is the right
// null for a GATE (the prior tested shuffled-SIZING; here we test shuffled-GATING).
function shuffledGatePlacebo(wins: Win[], h: number, iters = 2000, seed = 555) {
  // observed = realized gate net Sharpe on the active (vol-unscaled) net stream
  const observed = annSharpe(wins.map((w) => w.netRet), h);
  const onFrac = wins.filter((w) => w.on).length / Math.max(1, wins.length);
  // per-window "if-on" net (recompute net as if this window were ON)
  const ifOnNet = wins.map((w) => {
    const grossRet = w.payoffVar;
    const rebalances = 2 + h; const takerCost = rebalances * TAKER;
    // funding/tail are embedded in the realized record when on; when the realized window was
    // FLAT we must reconstruct. funding: approximate by the cross-window mean |funding| share is
    // not stored, so reconstruct tail (depends only on rvOverIv,iv) and use realized funding if on.
    let tailCost = 0; if (w.rvOverIv > 1.0) { const e = w.rvOverIv - 1.0; tailCost = w.iv * w.iv * e * e * TAIL_MULT; }
    const fundingCost = w.on ? w.fundingCost : meanFunding; // realized when on, else portfolio-mean
    return grossRet - takerCost - tailCost - fundingCost;
  });
  // portfolio-mean funding for windows that were flat (best estimate of carry had they been on)
  const r = rng(seed); let ge = 0; const sh: number[] = [];
  for (let it = 0; it < iters; it++) {
    // random on/off mask with matched on-fraction
    const idx = wins.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const nOn = Math.round(onFrac * wins.length); const onSet = new Set(idx.slice(0, nOn));
    const rets = wins.map((_, i) => (onSet.has(i) ? ifOnNet[i] : 0));
    const s = annSharpe(rets, h); sh.push(s); if (s >= observed) ge++;
  }
  return { p: ge / iters, observed, placeboMeanSharpe: mean(sh), onFrac };
}
let meanFunding = 0; // set per-asset before placebo

// ---------------------------------------------------------------- driver
function main() {
  const dvolBtc = readJson<DvolRow[]>("output/edgehunt/dvol_btc.json");
  const dvolEth = readJson<DvolRow[]>("output/edgehunt/dvol_eth.json");
  const btcVar = dailyVar(loadBtcDaily());
  const fundBtc = dailyFunding("output/funding/BTCUSDT_funding_8h.json");
  const fundEth = dailyFunding("output/funding/ETHUSDT_funding_8h.json");

  // ETH realized from crossxs daily closes (cc only)
  const cx = readJson<{ dates: string[]; closes: Record<string, number[]> }>("output/crossxs/daily-closes.json");
  const ethCloses = cx.closes.ETH; const ethDates = cx.dates;
  const ethVar: VarRow[] = ethDates.map((date, i) => { const prev = i > 0 ? ethCloses[i - 1] : ethCloses[i]; const rc = Math.log(ethCloses[i] / prev); return { date, cc: rc * rc, park: rc * rc, gk: rc * rc }; });

  // ===== GATE-ONLY config grid — honest N (no sizing dimension) =====
  const horizons = [7, 14, 30];
  const btcEsts: Est[] = ["cc", "park", "gk", "blend"];
  const ethEsts: Est[] = ["cc"]; // ETH has no intraday => only cc
  const spikeGates = [1.0, 1.5, 99]; // 99 = effectively no spike gate
  const regimeOpts = [true, false];
  const ZLB = 90;

  interface Trial { label: string; asset: string; g: Gate; wins: Win[]; rawNet: number[]; netSharpe: number; }
  const trials: Trial[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    const dvol = asset === "BTC" ? dvolBtc : dvolEth;
    const vs = asset === "BTC" ? btcVar : ethVar;
    const fund = asset === "BTC" ? fundBtc : fundEth;
    const ests = asset === "BTC" ? btcEsts : ethEsts;
    for (const horizon of horizons) for (const est of ests) for (const spikeGate of spikeGates) for (const regimeGate of regimeOpts) {
      const g: Gate = { horizon, est, zLookback: ZLB, spikeGate, regimeGate, regimePct: 0.6 };
      const wins = runGate(dvol, vs, fund, g);
      if (wins.length < 20) continue;
      const rawNet = wins.map((w) => w.netRet);
      trials.push({ label: `${asset}|h${horizon}|${est}|spk${spikeGate}|rg${regimeGate ? 1 : 0}`, asset, g, wins, rawNet, netSharpe: annSharpe(rawNet, horizon) });
    }
  }
  const honestN = trials.length; // GATE-ONLY configs tried

  // ===== PRE-REGISTERED CANONICAL CONFIG (frozen before holdout) =====
  // BTC h7 blend, spikeGate 1.5, regimeGate ON. The `premium_gated` of the prior decompose.
  const CANON_LABEL = "BTC|h7|blend|spk1.5|rg1";
  const canon = trials.find((t) => t.label === CANON_LABEL);
  if (!canon) throw new Error(`canonical config ${CANON_LABEL} not found among trials`);

  // best BTC by in-sample net Sharpe (for the data-mined comparison & PBO family)
  const btc = trials.filter((t) => t.asset === "BTC").sort((a, b) => b.netSharpe - a.netSharpe);
  const eth = trials.filter((t) => t.asset === "ETH").sort((a, b) => b.netSharpe - a.netSharpe);
  const best = btc[0];

  // ===== CONSUME-ONCE HOLDOUT (last 20% of windows), pre-registered config ONLY =====
  const wAll = canon.wins;
  const split = Math.floor(wAll.length * 0.8);
  const wIn = wAll.slice(0, split);
  const wOut = wAll.slice(split);
  const h = canon.g.horizon;
  const inNet = wIn.map((w) => w.netRet);
  const outNet = wOut.map((w) => w.netRet);
  const fullNet = wAll.map((w) => w.netRet);
  const canonInSharpe = annSharpe(inNet, h);
  const canonOutSharpe = annSharpe(outNet, h);
  const canonFullSharpe = annSharpe(fullNet, h);

  // ===== FULL gate battery on the PRE-REGISTERED config (full sample for power) =====
  // DSR @ honest N (gate-only count). negative-skew aware via the lib's sharpeStandardError.
  const dsr = computeDeflatedSharpeRatio(fullNet, { benchmarkSharpe: 0, trialCount: honestN });
  const psr = computeProbabilisticSharpeRatio(fullNet, 0);
  // DSR also on the HOLDOUT slice (the consume-once decisive number) at honest N
  const dsrOut = computeDeflatedSharpeRatio(outNet, { benchmarkSharpe: 0, trialCount: honestN });

  // block bootstrap CI on mean net (full sample)
  const bb = blockBootstrapConfidenceInterval(fullNet, { statistic: "mean", iterations: 3000, confidenceLevel: 0.95, seed: "vrp-crashgate" });

  // tail-matched block bootstrap surrogate
  const tmbb = tailMatchedBB(fullNet, h, 4000, 777);

  // shuffled-GATE placebo (the right null for the GATE)
  meanFunding = mean(canon.wins.filter((w) => w.on).map((w) => w.fundingCost)); // mean carry when on
  const placebo = shuffledGatePlacebo(canon.wins, h, 4000, 555);

  // CSCV / PBO across the GATE family (genuinely diverse: spike on/off, regime on/off, horizons, ests)
  const foldCount = 6;
  const toFolds = (r: number[]) => { const f: number[][] = Array.from({ length: foldCount }, () => []); r.forEach((x, i) => f[i % foldCount].push(x)); return f; };
  const cscv = btc.filter((t) => t.rawNet.length >= foldCount * 2).slice(0, 16).map((t) => ({ id: t.label, folds: toFolds(t.rawNet) }));
  let pbo = NaN, medianLogit = NaN;
  if (cscv.length >= 2) { const res = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }); pbo = res.pbo; medianLogit = res.medianLogit; }

  // ===== Naive (always-short, NO gate) benchmark over the SAME windows — what does the gate add? =====
  const alwaysG: Gate = { ...canon.g, spikeGate: 99, regimeGate: false };
  const alwaysWins = runGate(dvolBtc, btcVar, fundBtc, alwaysG);
  const alwaysNet = alwaysWins.map((w) => w.netRet);
  const alwaysSharpe = annSharpe(alwaysNet, h);

  // ===== reporting stats (vol-scaled stream for realistic monthly$) =====
  const vScale = volScale(fullNet, h);
  const scaled = fullNet.map((x) => x * vScale);
  const stats = summarizeReturnSeries(scaled);
  const onWins = canon.wins.filter((w) => w.on);
  const winRate = onWins.filter((w) => w.netRet > 0).length / Math.max(1, onWins.length);
  const monthlyWindows = 30 / h;
  const monthlyMean = stats.mean * monthlyWindows;

  // gate decisions
  const dsrPass = dsr.deflatedProbability > 0.95;
  const dsrOutPass = dsrOut.deflatedProbability > 0.95;
  const placeboPass = placebo.p < 0.05;
  const tmbbPass = tmbb.p < 0.05;
  const bbPass = bb.lower > 0;
  const pboPass = pbo < 0.5;
  const holdoutPass = canonOutSharpe > 0;
  const netPass = mean(fullNet) > 0;

  // binding gate order (first failing)
  const gateOrder: [string, boolean][] = [
    ["net_of_cost", netPass],
    ["block_bootstrap", bbPass],
    ["cpcv_pbo", pboPass],
    ["surrogate_tailBB", tmbbPass],
    ["shuffled_GATE_placebo", placeboPass],
    ["deflated_sharpe_honestN", dsrPass],
    ["consume_once_holdout", holdoutPass],
    ["deflated_sharpe_holdout", dsrOutPass],
  ];
  let binding = "none"; for (const [g, ok] of gateOrder) if (!ok) { binding = g; break; }

  // SURVIVE only if the pre-registered config clears the BINDING gate (DSR @ honest N) AND
  // the placebo, on data it never saw (holdout positive).
  const survive = dsrPass && placeboPass && holdoutPass && netPass && bbPass && tmbbPass && dsrOutPass && pboPass;
  const promising = !survive && netPass && placeboPass && holdoutPass && (dsr.deflatedProbability > 0.5);
  const verdict = survive ? "SURVIVE" : promising ? "PROMISING" : "KILL";

  const report = {
    hypothesis: "GATE-ONLY short-variance harvest (NO z-sizing): ON when DVOL benign, FLAT on spike/malign regime",
    preRegisteredCanonical: CANON_LABEL,
    honestN_gateConfigsOnly: honestN,
    dataSpan: { dvolStart: dvolBtc[0].date, dvolEnd: dvolBtc[dvolBtc.length - 1].date, btcWindows: canon.wins.length, ethWindows_best: eth[0]?.wins.length ?? 0 },
    windows: { total: wAll.length, inSample: wIn.length, holdout: wOut.length, activeOn: onWins.length, onFraction: +(onWins.length / wAll.length).toFixed(3) },
    netSharpe: { canon_full: +canonFullSharpe.toFixed(3), canon_inSample: +canonInSharpe.toFixed(3), canon_holdout: +canonOutSharpe.toFixed(3), bestBTC_dataMined: +best.netSharpe.toFixed(3), bestBTC_label: best.label, naive_always_short: +alwaysSharpe.toFixed(3), ETH_best: eth[0] ? { label: eth[0].label, netSharpe: +eth[0].netSharpe.toFixed(3), N: eth[0].wins.length } : null },
    gate_adds: { canon_vs_naive_sharpe_delta: +(canonFullSharpe - alwaysSharpe).toFixed(3), naive_maxDD: +maxDD(alwaysNet).toFixed(4), canon_maxDD: +maxDD(fullNet).toFixed(4) },
    economics_volTargeted: { winRate: +winRate.toFixed(3), skew: +stats.skewness.toFixed(3), kurtosis: +stats.kurtosis.toFixed(3), maxDD: +maxDD(scaled).toFixed(4), Calmar: +calmar(scaled, h).toFixed(3), CVaR5: +cvar(scaled).toFixed(5), monthlyMeanPct: +(monthlyMean * 100).toFixed(3), monthly_at_10k: +(monthlyMean * 10000).toFixed(2), monthly_at_100k: +(monthlyMean * 100000).toFixed(2) },
    costs_avgPerWindow: { taker: +mean(canon.wins.map((w) => w.takerCost)).toFixed(6), funding: +mean(canon.wins.map((w) => w.fundingCost)).toFixed(6), convexTail: +mean(canon.wins.map((w) => w.tailCost)).toFixed(6), crashWindows: canon.wins.filter((w) => w.crash).length },
    GATES: {
      net_of_cost: { pass: netPass, meanNetWindow: +mean(fullNet).toFixed(6) },
      block_bootstrap_meanCI: { pass: bbPass, lower: +bb.lower.toFixed(6), upper: +bb.upper.toFixed(6) },
      cpcv_pbo: { pass: pboPass, pbo: +pbo.toFixed(3), medianLogit: +medianLogit.toFixed(3), familySize: cscv.length },
      surrogate_tailMatchedBB_p: { pass: tmbbPass, p: +tmbb.p.toFixed(4) },
      shuffled_GATE_placebo_p: { pass: placeboPass, p: +placebo.p.toFixed(4), placeboMeanSharpe: +placebo.placeboMeanSharpe.toFixed(3), onFracMatched: +placebo.onFrac.toFixed(3) },
      deflated_sharpe_honestN: { pass: dsrPass, p: +dsr.deflatedProbability.toFixed(4), expectedMaxSharpe: +dsr.expectedMaxSharpe.toFixed(4), threshold: 0.95, N: honestN },
      consume_once_holdout: { pass: holdoutPass, holdoutSharpe: +canonOutSharpe.toFixed(3), holdoutWindows: wOut.length },
      deflated_sharpe_holdout: { pass: dsrOutPass, p: +dsrOut.deflatedProbability.toFixed(4) },
      PSR_full: +psr.probability.toFixed(4),
    },
    bindingGate: binding,
    verdict,
    decisive: "Does GATE-ONLY clear DSR@honestN AND the (shuffled-GATE) placebo where the SIZING version failed (placebo p=0.14, DSR=0.53)?",
  };

  writeFileSync("output/edgehunt-deepen/vrp-crashgate-result.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("\n=== ALL GATE TRIALS (honest N) ===");
  for (const t of [...trials].sort((a, b) => b.netSharpe - a.netSharpe)) console.log(`${t.label}  netSharpe=${t.netSharpe.toFixed(3)}  N=${t.wins.length}  on%=${(t.wins.filter((w)=>w.on).length/t.wins.length).toFixed(2)}`);
}
main();
