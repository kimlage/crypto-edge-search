/**
 * Q6-DVOLTS — DVOL term-structure vol-carry. FULL committed gauntlet.
 *
 * Strategy family: a SHORT-VOL carry book whose size/on-off is conditioned on the DVOL
 * term-structure slope (contango => rich => sell vol; backwardation => stress => de-risk),
 * tail-hedged. The tradeable return per day is the short-variance-swap carry leg:
 *   sellVolDaily[t] = clamp((dvol[t]^2 - rvFwd_h[t]^2)) * notionalScale
 * realized over the holding period, minus a TAIL-HEDGE cost and minus turnover cost. We work on a
 * DAILY overlapping-holding basis (position re-struck daily; PnL accrues over the forward h-day
 * realized variance, divided by h to make it a daily-equivalent carry).
 *
 * Because this is a vol-CARRY (insurance-selling) book, the RIGHT null is a TAIL-MATCHED BOOTSTRAP
 * (preserve the crash/tail structure of the short-vol payoff), NOT phase-randomization. The RIGHT
 * baseline is the MATCHED-EXPOSURE ALWAYS-SHORT-VOL control (same notional, no timing): the term-
 * structure timing must beat blindly always selling vol. We also run buy&hold (spot), random-lottery
 * (matched exposure), and the killed VRP-level signal as references.
 *
 * Gauntlet primitives: committed src/lib/training/statistical-validation.ts.
 * Honest N = EVERY config evaluated. Consume-once holdout = last 20%.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const PANEL = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-quant/dvolts_panel.json`, "utf8"));
const OUT = `${ROOT}/output/edgehunt-quant/dvolts_result.json`;
const ANN = Math.sqrt(365);

const dvol: number[] = PANEL.dvol;
const rv: number[] = PANEL.rv;
const rvFwd7: number[] = PANEL.rvFwd7;
const dates: string[] = PANEL.dates;
const T = dvol.length;

// ---- realized variance accrual: we need a forward h-day realized variance for the carry leg.
// We already have rvFwd7 (forward 7d realized vol, ann %). Build a general forward-h realized vol.
// Reconstruct daily realized vol from panel rv? panel only has trailing-30 + fwd7. For carry we use
// the forward h-day realized vol over (t, t+h]. Rebuild from logRet-implied daily rv is not stored;
// instead we recompute forward realized vol from the daily price path stored in panel.
const price: number[] = PANEL.price;
const dailyLogRet = new Array(T).fill(NaN);
for (let t = 1; t < T; t++) dailyLogRet[t] = Math.log(price[t] / price[t - 1]);
function fwdRealizedVolAnn(t: number, h: number): number {
  // realized vol over (t, t+h] from daily close-to-close log returns, annualized %
  if (t + h >= T) return NaN;
  let s = 0;
  let n = 0;
  for (let k = t + 1; k <= t + h; k++) {
    if (Number.isFinite(dailyLogRet[k])) {
      s += dailyLogRet[k] * dailyLogRet[k];
      n++;
    }
  }
  if (n < h) return NaN;
  return Math.sqrt(s / n) * Math.sqrt(365) * 100;
}

// ---- utils ----
function mean(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]) {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
function sharpeDaily(a: number[]) {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
function annSharpe(d: number) {
  return d * ANN;
}
function mkRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function ema(x: number[], span: number) {
  const a = 2 / (span + 1);
  const out = new Array(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    prev = Number.isFinite(prev) ? a * x[i] + (1 - a) * prev : x[i];
    out[i] = prev;
  }
  return out;
}
function sma(x: number[], w: number) {
  const out = new Array(x.length).fill(NaN);
  for (let i = w - 1; i < x.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = i - w + 1; k <= i; k++) {
      if (!Number.isFinite(x[k])) {
        ok = false;
        break;
      }
      s += x[k];
    }
    if (ok) out[i] = s / w;
  }
  return out;
}

// ---- the short-vol carry leg: REALISTIC DAILY MARK-TO-MARKET ----
// A short 30d at-the-money straddle / short variance-swap book marks daily as:
//   dailyPnL[t->t+1] = theta_collected - gamma_loss - vega_pnl
// where (per Bates / Broadie-Chernov-Johannes, normalized to a vol-targeted unit-vega book):
//   theta_collected = (dvol[t]/100)^2 / 365 / 2     (implied variance earned per day, half for ATM)
//   gamma_loss      = (dailyLogRet[t+1])^2 / 2       (realized variance paid per day)
//   vega_pnl        = -kappa * (dvol[t+1]-dvol[t])/100  (short vega: lose when IV rises)
// i.e. dailyPnL = 0.5*[ (dvol/100)^2/365 - r_{t+1}^2 ] - kappa*(Δdvol/100).
// This is a TRUE daily MTM with realistic variance and crash convexity (negative skew). The tail
// hedge is a long OTM strangle: pay a daily premium, but it caps the worst daily loss.
// IMPORTANT: a vol-CARRY book earns the held-to-maturity variance risk premium = theta - gamma
//   = 0.5*[ (IV/100)^2/365 - r_{t+1}^2 ].  We do NOT include a daily -KAPPA*ΔDVOL vega MTM term:
// a held-to-maturity variance swap has no vega PnL, and including it creates a mechanical
// circularity (a DVOL-level signal trivially "predicts" the sign of -ΔDVOL because DVOL mean-reverts
// -- see probe_vega_artifact.ts, which shows the only surviving orientation is 100% that artifact).
// This is the HONEST payoff for which the term-structure timing must add value.
function buildCarry(tailHedgeCostPerDay: number): number[] {
  const carry = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    if (t + 1 >= T) continue;
    const iv = dvol[t] / 100;
    const rNext = dailyLogRet[t + 1];
    if (!Number.isFinite(rNext)) continue;
    const theta = 0.5 * (iv * iv) / 365; // implied variance earned per day
    const gamma = 0.5 * rNext * rNext; // realized variance paid per day
    let raw = theta - gamma - tailHedgeCostPerDay;
    // long-strangle tail hedge: absorbs 70% of losses beyond a daily cap (paid for by the premium)
    const capLoss = 0.015;
    if (tailHedgeCostPerDay > 0 && raw < -capLoss) raw = -capLoss - 0.3 * (raw + capLoss);
    carry[t] = raw;
  }
  return carry;
}

// ---- term-structure slope signal ----
function slopeSignal(spanLong: number): number[] {
  const back = ema(dvol, spanLong);
  const slope = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) if (Number.isFinite(back[t]) && back[t] > 0) slope[t] = dvol[t] / back[t];
  return slope;
}

// ---- build a position array from a config ----
// cfg: { spanLong, mode, thr, hedge }
//   mode 'gate'  : pos = full notional when contango (slope < 1 - thr/100), else 0 (de-risk).
//   mode 'size'  : pos = clamp01( (1 - slope) scaled )  -- size up in contango.
//   mode 'twoway': pos = +1 contango (short vol), 0 backwardation (no long-vol; carry is one-sided).
//   hedge: tail-hedge daily premium in carry units (0, small, medium).
const CARRY_CACHE = new Map<number, number[]>();
function carryFor(hedge: number): number[] {
  if (!CARRY_CACHE.has(hedge)) CARRY_CACHE.set(hedge, buildCarry(hedge));
  return CARRY_CACHE.get(hedge)!;
}

// orient: 'contango' = short vol when slope<1 (the pre-registered Q6 hypothesis: rich term struct);
//         'backwd'   = short vol when slope>1 (the empirically-found vol-reversion orientation).
function buildPosition(cfg: Record<string, number | string>): number[] {
  const spanLong = cfg.spanLong as number;
  const mode = cfg.mode as string;
  const thr = cfg.thr as number;
  const orient = (cfg.orient as string) ?? "contango";
  const slope = slopeSignal(spanLong);
  const pos = new Array(T).fill(0);
  // map slope to a "richness" r where r>0 means "the orientation says SHORT vol here"
  for (let t = 0; t < T; t++) {
    const s = slope[t];
    if (!Number.isFinite(s)) { pos[t] = 0; continue; }
    const dev = orient === "contango" ? 1 - s : s - 1; // dev>0 => this orientation wants to be short
    if (mode === "gate") {
      pos[t] = dev > thr ? 1 : 0;
    } else if (mode === "size") {
      pos[t] = Math.max(0, Math.min(1, dev * (1 / Math.max(0.01, thr))));
    } else if (mode === "gatesoft") {
      pos[t] = dev > thr ? 1 : dev > -thr ? 0.5 : 0;
    }
  }
  return pos;
}

// ---- backtest: position[t] earns carry[t] (forward), with turnover cost on |dpos| ----
const COST_PER_SIDE = 0.0004; // 4 bps taker per side (variance-swap entry/exit proxy)
function run(pos: number[], carry: number[], lo: number, hi: number) {
  const net: number[] = [];
  const gross: number[] = [];
  let prev = 0;
  let turn = 0;
  let exp = 0;
  let onN = 0;
  for (let t = lo; t < hi; t++) {
    const c = carry[t];
    const p = pos[t];
    if (!Number.isFinite(c) || !Number.isFinite(p)) continue;
    const tn = Math.abs(p - prev);
    const cost = tn * COST_PER_SIDE;
    const g = p * c;
    gross.push(g);
    net.push(g - cost);
    turn += tn;
    exp += Math.abs(p);
    if (p > 0) onN++;
    prev = p;
  }
  const n = net.length;
  return { net, gross, turnover: n ? turn / n : 0, exposure: n ? exp / n : 0, n, onFrac: n ? onN / n : 0 };
}

// ---- tail-matched bootstrap null ----
// Block-bootstrap the ACTUAL short-vol carry series (preserving crash/tail clusters via block
// resampling), then re-apply the strategy's positions to the RESAMPLED carry. Because the carry's
// tail structure is preserved (insurance payoff), a strategy with no real timing skill will get the
// same distribution. p = fraction of bootstraps whose Sharpe >= real. This is the tail-matched null
// the spec demands (NOT phase-randomization).
function tailMatchedNull(
  pos: number[],
  carry: number[],
  lo: number,
  hi: number,
  realSharpe: number,
  nIter: number,
  blockLen: number,
): number {
  // restrict to valid rows in window, keep (pos,carry) pairs in order
  const P: number[] = [];
  const C: number[] = [];
  for (let t = lo; t < hi; t++) {
    if (Number.isFinite(carry[t]) && Number.isFinite(pos[t])) {
      P.push(pos[t]);
      C.push(carry[t]);
    }
  }
  const m = C.length;
  let above = 0;
  for (let it = 0; it < nIter; it++) {
    const rng = mkRng(13371 + it * 2654435761);
    // resample CARRY in blocks (preserve tail clusters), but DESTROY the pos-carry alignment by
    // pairing the resampled tail-matched carry with the ORIGINAL position order. If timing skill is
    // real, real Sharpe >> bootstrap; if it's just the premium, bootstrap matches.
    const boot: number[] = [];
    let i = 0;
    while (boot.length < m) {
      const start = Math.floor(rng() * m);
      for (let k = 0; k < blockLen && boot.length < m; k++) boot.push(C[(start + k) % m]);
    }
    // apply original positions to the tail-matched resampled carry
    const ret: number[] = [];
    let prev = 0;
    for (let j = 0; j < m; j++) {
      const p = P[j];
      const tn = Math.abs(p - prev);
      ret.push(p * boot[j] - tn * COST_PER_SIDE);
      prev = p;
    }
    if (annSharpe(sharpeDaily(ret)) >= realSharpe) above++;
  }
  return (above + 1) / (nIter + 1);
}

// ---- config grid (HONEST N = every config, BOTH orientations counted) ----
const configs: Record<string, number | string>[] = [];
for (const orient of ["contango", "backwd"]) {
  for (const spanLong of [30, 45, 60, 90]) {
    for (const mode of ["gate", "size", "gatesoft"]) {
      for (const thr of [0.0, 0.02, 0.05, 0.08]) {
        for (const hedge of [0.0, 0.001, 0.002]) {
          configs.push({ orient, spanLong, mode, thr, hedge });
        }
      }
    }
  }
}
const HONEST_N = configs.length;

// ---- window: warmup for the longest span ----
const startIdx = 95; // longest EMA span 90 needs warmup
const tradableEnd = T - 2; // carry marks t->t+1, so last usable signal day is T-2
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * 0.8); // consume-once holdout = last 20%

// ---- score every config IN-SAMPLE on net Sharpe ----
const scored = configs.map((cfg) => {
  const pos = buildPosition(cfg);
  const carry = carryFor(cfg.hedge as number);
  const res = run(pos, carry, startIdx, splitIdx);
  const label = `${cfg.orient},span=${cfg.spanLong},${cfg.mode},thr=${cfg.thr},hedge=${cfg.hedge}`;
  return { cfg, label, pos, carry, res, netSh: annSharpe(sharpeDaily(res.net)) };
});
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestNet = best.res.net;

// ---- baselines ----
// (1) buy & hold SPOT (the strategy is supposed to be an alternative book)
const fwdRet: number[] = PANEL.fwdRet;
const bhNet: number[] = [];
for (let t = startIdx; t < splitIdx; t++) if (Number.isFinite(fwdRet[t])) bhNet.push(fwdRet[t]);
const bhSh = annSharpe(sharpeDaily(bhNet));
// (2) MATCHED-EXPOSURE ALWAYS-SHORT-VOL control: same notional exposure as best, NO timing.
//     This is the binding control for a vol-carry timing strategy.
const exposure = best.res.exposure;
const carryBest = best.carry;
const alwaysShortPos = new Array(T).fill(exposure); // constant exposure = best's avg exposure
const alwaysShort = run(alwaysShortPos, carryBest, startIdx, splitIdx);
const alwaysShortSh = annSharpe(sharpeDaily(alwaysShort.net));
// (3) random-lottery matched exposure (random on/off books at best's on-fraction)
const onFrac = best.res.onFrac;
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(909090 + i * 2654435761);
  const pos = new Array(T).fill(0);
  for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < onFrac ? 1 : 0;
  const r = run(pos, carryBest, startIdx, splitIdx);
  rlSh.push(annSharpe(sharpeDaily(r.net)));
}
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
// (4) killed VRP-level signal (dvol - rv > 0 -> short) as a same-data reference
const vrpPos = new Array(T).fill(0);
for (let t = 0; t < T; t++) vrpPos[t] = Number.isFinite(rv[t]) && dvol[t] - rv[t] > 0 ? 1 : 0;
const vrpRes = run(vrpPos, carryBest, startIdx, splitIdx);
const vrpSh = annSharpe(sharpeDaily(vrpRes.net));

// the binding baseline test: timing must beat the matched-exposure always-short control AND B&H AND random
const baselinePass =
  best.netSh > alwaysShortSh && best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0;

// ---- Deflated Sharpe @ honest N ----
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const dsrPass = dsr.deflatedProbability > 0.95;

// ---- block bootstrap CI ----
const bb = blockBootstrapConfidenceInterval(bestNet, {
  statistic: "mean",
  iterations: 2000,
  blockLength: 20,
  confidenceLevel: 0.95,
  seed: "dvolts-bb",
});
const bbPass = bb.lower > 0;

// ---- CPCV / PBO ----
function toFolds(s: number[], nf: number) {
  const folds: number[][] = [];
  const sz = Math.floor(s.length / nf);
  for (let f = 0; f < nf; f++) folds.push(s.slice(f * sz, f === nf - 1 ? s.length : (f + 1) * sz));
  return folds;
}
let pbo = { pbo: 1, medianLogit: 0 };
try {
  const r = estimateCscvPbo(
    scored.map((s) => ({ id: s.label, folds: toFolds(s.res.net, 6) })),
    { statistic: "sharpe", trainFraction: 0.5 },
  );
  pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
} catch {
  pbo = { pbo: 1, medianLogit: 0 };
}
const pboPass = pbo.pbo < 0.5;

// ---- Harvey-Liu (Bonferroni) haircut ----
function erf(x: number) {
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
function zSharpe(returns: number[]) {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 0;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  return (sh * Math.sqrt(s.sampleCount - 1)) / denom;
}
const psrP = 1 - normalCdf(zSharpe(bestNet));
const adjP = Math.min(1, psrP * HONEST_N);
const haircutPass = adjP < 0.05;

// ---- RIGHT surrogate: TAIL-MATCHED BOOTSTRAP ----
const surrP = tailMatchedNull(best.pos, best.carry, startIdx, splitIdx, best.netSh, 1000, 20);
const surrPass = surrP < 0.05;

// ---- consume-once holdout (best cfg, OOS) ----
const holdRes = run(best.pos, best.carry, splitIdx, tradableEnd);
const holdSh = annSharpe(sharpeDaily(holdRes.net));
const holdoutPass = holdSh > 0;

// ---- pre-registered canonical: the LITERAL Q6 hypothesis (contango => rich => sell vol) ----
const canonCfg = { orient: "contango", spanLong: 60, mode: "gate", thr: 0.02, hedge: 0.001 };
const canonPos = buildPosition(canonCfg);
const canonCarry = carryFor(canonCfg.hedge);
const canonIS = run(canonPos, canonCarry, startIdx, splitIdx);
const canonSh = annSharpe(sharpeDaily(canonIS.net));
const canonSurrP = tailMatchedNull(canonPos, canonCarry, startIdx, splitIdx, canonSh, 1000, 20);
const canonHold = run(canonPos, canonCarry, splitIdx, tradableEnd);
const canonHoldSh = annSharpe(sharpeDaily(canonHold.net));

// ---- assemble ----
const meanDailyNet = mean(bestNet);
const gates = {
  net_of_cost: { pass: meanDailyNet > 0, detail: `meanDailyNet=${meanDailyNet.toExponential(3)} turnover=${best.res.turnover.toFixed(3)} onFrac=${best.res.onFrac.toFixed(2)}` },
  baselines: {
    pass: baselinePass,
    detail: `best=${best.netSh.toFixed(3)} vs alwaysShort(matchedExp)=${alwaysShortSh.toFixed(3)} B&H=${bhSh.toFixed(3)} rndLot95=${rl95.toFixed(3)} [VRPlevelRef=${vrpSh.toFixed(3)}]`,
  },
  deflated_sharpe: { pass: dsrPass, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh=${dsr.expectedMaxSharpe.toFixed(4)}` },
  block_bootstrap: { pass: bbPass, detail: `meanDailyNet CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]` },
  cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medianLogit=${pbo.medianLogit.toFixed(3)}` },
  haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)}*N=${HONEST_N})` },
  surrogate_tailMatched: { pass: surrPass, detail: `tailMatchedBootstrapP=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)}` },
  holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdRes.n} rows` },
};
const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate_tailMatched", "holdout"];
let binding = "none";
for (const g of order) if (!(gates as any)[g].pass) { binding = g; break; }
const allPass = binding === "none";
const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate_tailMatched.pass && gates.holdout.pass;
const verdict = allPass ? "SURVIVE" : survivesCore ? "PROMISING" : "KILL";
const monthlyAt100k = meanDailyNet * 30 * 100000;

const out = {
  name: "Q6-DVOLTS DVOL term-structure vol-carry",
  span: { first: dates[startIdx], split: dates[splitIdx], last: dates[tradableEnd], T, inSample: splitIdx - startIdx, holdout: tradableEnd - splitIdx },
  honestN: HONEST_N,
  best: {
    label: best.label,
    cfg: best.cfg,
    netSharpeAnn: best.netSh,
    grossSharpeAnn: annSharpe(sharpeDaily(best.res.gross)),
    meanDailyNet,
    turnover: best.res.turnover,
    exposure: best.res.exposure,
    onFrac: best.res.onFrac,
    nDays: best.res.n,
    monthlyAt100k,
  },
  baselines: { alwaysShortMatched: alwaysShortSh, buyHold: bhSh, randomLottery95: rl95, vrpLevelRef: vrpSh, fullNotionalAlwaysShort: annSharpe(sharpeDaily(run(new Array(T).fill(1), carryBest, startIdx, splitIdx).net)) },
  canonical_preregistered_Q6: { cfg: canonCfg, label: "contango=>sell vol (literal Q6 hypothesis)", inSampleNetSharpeAnn: canonSh, tailMatchedSurrogateP: canonSurrP, holdoutSharpeAnn: canonHoldSh },
  gates,
  bindingGate: binding,
  verdict,
  surrogateP: surrP,
  holdoutSharpeAnn: holdSh,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log(`\n========= Q6-DVOLTS =========`);
console.log(`span ${out.span.first}..${out.span.last} (split ${out.span.split}) inSample=${out.span.inSample} holdout=${out.span.holdout} honestN=${HONEST_N}`);
console.log(`best(data-mined, both orientations): ${best.label}`);
console.log(`  netSharpeAnn=${best.netSh.toFixed(3)} grossSh=${annSharpe(sharpeDaily(best.res.gross)).toFixed(3)} turnover=${best.res.turnover.toFixed(3)} exposure=${best.res.exposure.toFixed(3)} onFrac=${best.res.onFrac.toFixed(2)} nDays=${best.res.n}`);
console.log(`CANONICAL (literal Q6 contango=>sell): netSh=${canonSh.toFixed(3)} tailMatchedP=${canonSurrP.toFixed(3)} holdoutSh=${canonHoldSh.toFixed(3)}`);
console.log(`baselines: alwaysShort(matchedExp)=${alwaysShortSh.toFixed(3)} fullNotionalShort=${annSharpe(sharpeDaily(run(new Array(T).fill(1), carryBest, startIdx, splitIdx).net)).toFixed(3)} B&H=${bhSh.toFixed(3)} rndLot95=${rl95.toFixed(3)} VRPlevelRef=${vrpSh.toFixed(3)}`);
for (const g of order) console.log(`  [${(gates as any)[g].pass ? "PASS" : "KILL"}] ${g} — ${(gates as any)[g].detail}`);
const monthly = binding === "none" ? `$${Math.round(monthlyAt100k)}` : "n/a";
console.log(`VERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly} | holdoutSharpe ${holdSh.toFixed(3)}`);
