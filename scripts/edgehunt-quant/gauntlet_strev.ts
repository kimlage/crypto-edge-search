/**
 * Q4-STREV — FULL committed gauntlet, cross-sectional edition.
 *
 * Strategy: weekly residual reversal (residualize vs BTC, rolling causal beta), long last-period
 * residual LOSERS / short WINNERS, dollar- & beta-neutral. The reversal "lives" (statistically) at
 * the short forward horizon, so the strongest honest variant is in the grid (hold in {3,5,7}).
 *
 * Committed primitives (src/lib/training/statistical-validation.ts):
 *   computeDeflatedSharpeRatio, estimateCscvPbo, blockBootstrapConfidenceInterval, summarizeReturnSeries.
 *
 * Gauntlet, in binding order:
 *   1. net_of_cost          mean net period return > 0 (taker 4 bps/side)
 *   2. baselines            beat B&H equal-weight-long, random-lottery (matched gross exposure),
 *                           AND the MATCHED control = a beta-neutral LONG-SHORT book on SHUFFLED
 *                           signals (the right matched-exposure control for an XS timing book)
 *   3. deflated_sharpe      DSR p>0.95 @ HONEST N (every config across ALL probes)
 *   4. block_bootstrap      95% CI on mean net period return strictly > 0
 *   5. cpcv_pbo             PBO < 0.5 over all configs
 *   6. haircut              Harvey-Liu Bonferroni adjP < 0.05
 *   7. surrogate            CROSS-SECTIONAL SHUFFLE null p < 0.05 (the RIGHT surrogate)
 *   8. holdout              consume-once last 20% of weeks, OOS net Sharpe > 0
 *
 * HONEST N: counts EVERY config evaluated across probe_strev (96), probe_3d (48 incl. raw-control
 * overlaps), probe_deciles/probe_direction diagnostics (18 IC configs), and this grid. We pass the
 * full honest count explicitly so DSR/haircut see the true search.
 */
import {
  loadDailyPanel, rebalanceDays, buildBook, BookConfig, mean, std, sharpePeriod, mkRng,
} from "./lib_strev.ts";
import {
  computeDeflatedSharpeRatio, estimateCscvPbo, blockBootstrapConfidenceInterval, summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const COST = 0.0004;
const panel = loadDailyPanel();
function annF(hold: number) { return Math.sqrt(365 / hold); }

// ---- the full config grid evaluated for SELECTION (these all trade a long-short book) ----
const grid: BookConfig[] = [];
for (const hold of [3, 5, 7])
  for (const sigWeeks of [1, 2, 4])
    for (const betaWin of [30, 60, 90])
      for (const quantile of [0.2, 0.3])
        for (const weighting of ["equal", "rank"] as const)
          for (const skip1d of [false, true])
            grid.push({ betaWin, sigWeeks, holdDays: hold, skip1d, quantile, weighting, betaNeutralize: true });

// HONEST N: every distinct strategy config we ever scored across all probes for this hypothesis.
//   probe_strev grid (beta-neutral + raw) ............ 96
//   probe_3d grid .................................... 48
//   probe_direction IC grid .......................... 18
//   probe_deciles (1 config, diagnostic) .............  1
//   this selection grid (3*3*3*2*2*2) ................ 216  (overlaps some, counted fresh = conservative)
// We do NOT subtract overlaps (counting every config is the rule). Total honest search:
const HONEST_N = 96 + 48 + 18 + 1 + grid.length;

const labelOf = (c: BookConfig) =>
  `hold=${c.holdDays},L=${c.sigWeeks},bw=${c.betaWin},q=${c.quantile},w=${c.weighting},skip=${c.skip1d ? 1 : 0}`;

// ---- in-sample / holdout split on rebalance index (consume-once last 20%) ----
function splitRebal(rebal: number[]) {
  const cut = Math.floor(rebal.length * 0.8);
  return { is: rebal.slice(0, cut), oos: rebal.slice(cut) };
}

// score every config IN-SAMPLE on net period Sharpe
interface Scored { cfg: BookConfig; label: string; netIS: number[]; netSh: number; }
const scored: Scored[] = [];
for (const cfg of grid) {
  const rebal = rebalanceDays(panel, cfg.holdDays, 200);
  const { is } = splitRebal(rebal);
  const r = buildBook(panel, cfg, is, COST);
  if (r.nRebal < 30) continue;
  scored.push({ cfg, label: labelOf(cfg), netIS: r.netRet, netSh: annF(cfg.holdDays) * sharpePeriod(r.netRet) });
}
scored.sort((a, b) => b.netSh - a.netSh);
const best = scored[0];
const bestHold = best.cfg.holdDays;
const ANN = annF(bestHold);
console.log(`HONEST N = ${HONEST_N}`);
console.log(`grid configs scored: ${scored.length}`);
console.log(`BEST in-sample: ${best.label}  netSharpeAnn(IS)=${best.netSh.toFixed(3)}`);

// rebuild best on full + splits for reporting
const rebalBest = rebalanceDays(panel, bestHold, 200);
const { is: isR, oos: oosR } = splitRebal(rebalBest);
const bestIS = buildBook(panel, best.cfg, isR, COST);
const bestOOS = buildBook(panel, best.cfg, oosR, COST);
const bestNet = bestIS.netRet;

// ---- 1. net_of_cost ----
const netMean = mean(bestNet);
const g_net = { pass: netMean > 0, detail: `meanNetPeriod=${(netMean * 1e4).toFixed(2)}bps grossSharpeAnn=${(ANN * sharpePeriod(bestIS.grossRet)).toFixed(3)} turnover=${bestIS.turnoverPerRebal.toFixed(2)} bookBeta=${mean(bestIS.longShortBeta).toFixed(3)}` };

// ---- 2. baselines ----
// B&H equal-weight long (the universe-average long, the natural long-only crypto baseline)
function ewLong(rebal: number[], hold: number): number[] {
  const out: number[] = [];
  for (const t of rebal) {
    const fwdLo = t + 1, fwdHi = t + hold;
    if (fwdHi > panel.dates.length - 1) continue;
    let s = 0, n = 0;
    for (let a = 0; a < panel.assets.length; a++) {
      let ok = true; for (let d = fwdLo; d <= fwdHi; d++) { if (!panel.present[d][a]) { ok = false; break; } }
      if (!ok) continue; let f = 0; for (let d = fwdLo; d <= fwdHi; d++) f += panel.logret[d][a]; s += f; n++;
    }
    if (n) out.push(s / n);
  }
  return out;
}
const ewSh = ANN * sharpePeriod(ewLong(isR, bestHold));
// random-lottery: random long-short books with matched gross exposure & #names, same dates
const rlSh: number[] = [];
for (let i = 0; i < 200; i++) {
  const rng = mkRng(13577 + i * 2654435761);
  const r = buildBook(panel, best.cfg, isR, COST, rng); // shuffled signal == random book at matched exposure
  rlSh.push(ANN * sharpePeriod(r.netRet));
}
rlSh.sort((a, b) => a - b);
const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
// matched-exposure control == the shuffled-signal book (same construction, no XS info). Already rl95.
const g_base = { pass: best.netSh > ewSh && best.netSh > rl95 && best.netSh > 0, detail: `bestNetSh=${best.netSh.toFixed(3)} vs EWlong=${ewSh.toFixed(3)} randomLS95=${rl95.toFixed(3)} (matched-exposure shuffled control)` };

// ---- 3. deflated sharpe @ honest N (operate on per-period net series; DSR is scale-free) ----
const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
const g_dsr = { pass: dsr.deflatedProbability > 0.95, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} periodSharpe=${summarizeReturnSeries(bestNet).sharpe.toFixed(4)}` };

// ---- 4. block bootstrap CI on mean net period return ----
const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 8, confidenceLevel: 0.95, seed: "strev-bb" });
const g_bb = { pass: bb.lower > 0, detail: `meanNet CI95=[${(bb.lower * 1e4).toFixed(2)},${(bb.upper * 1e4).toFixed(2)}]bps` };

// ---- 5. CPCV / PBO over all configs ----
function toFolds(s: number[], k: number): number[][] { const f: number[][] = []; const sz = Math.floor(s.length / k); for (let i = 0; i < k; i++) { const lo = i * sz, hi = i === k - 1 ? s.length : lo + sz; f.push(s.slice(lo, hi)); } return f; }
// align fold count: only configs of the same hold share a period count; use the best hold subset for PBO honesty
const sameHold = scored.filter((s) => s.cfg.holdDays === bestHold);
const NF = 6;
let pbo = 1, medLogit = 0;
try {
  const cscv = sameHold.map((s) => ({ id: s.label, folds: toFolds(s.netIS, NF) }));
  const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 });
  pbo = r.pbo; medLogit = r.medianLogit;
} catch (e) { pbo = 1; }
const g_pbo = { pass: pbo < 0.5, detail: `PBO=${pbo.toFixed(3)} medianLogit=${medLogit.toFixed(3)} (over ${sameHold.length} same-hold configs)` };

// ---- 6. Harvey-Liu Bonferroni haircut ----
function normalCdf(z: number) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const ss = summarizeReturnSeries(bestNet);
const seSharpe = ss.sampleCount > 2 ? Math.sqrt(Math.max(1e-9, 1 - ss.skewness * ss.sharpe + ((ss.kurtosis - 1) / 4) * ss.sharpe * ss.sharpe) / (ss.sampleCount - 1)) : 1;
const zS = ss.sharpe / seSharpe;
const psrP = 1 - normalCdf(zS);
const adjP = Math.min(1, psrP * HONEST_N);
const g_hair = { pass: adjP < 0.05, detail: `Bonferroni adjP=${adjP.toExponential(2)} (psrP=${psrP.toExponential(2)} *N=${HONEST_N})` };

// ---- 7. RIGHT surrogate: CROSS-SECTIONAL SHUFFLE null ----
// permute signal->asset within each rebalance; preserves marginal signal dist + realized XS returns.
const NSURR = 500;
const surr: number[] = [];
for (let i = 0; i < NSURR; i++) {
  const rng = mkRng(80000 + i * 7919);
  const r = buildBook(panel, best.cfg, isR, COST, rng);
  surr.push(ANN * sharpePeriod(r.netRet));
}
surr.sort((a, b) => a - b);
const surrP = (surr.filter((s) => s >= best.netSh).length + 1) / (NSURR + 1);
const g_surr = { pass: surrP < 0.05, detail: `XS-shuffle p=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(NSURR * 0.95)].toFixed(3)}` };

// ---- 8. consume-once holdout ----
const oosSh = ANN * sharpePeriod(bestOOS.netRet);
const g_hold = { pass: oosSh > 0, detail: `OOS netSharpeAnn=${oosSh.toFixed(3)} over ${bestOOS.nRebal} weeks (consume-once)` };

// ---- canonical pre-registered (N=1): weekly, 1w lookback, skip-1d, q=0.2, equal, bw=60 ----
const canon: BookConfig = { betaWin: 60, sigWeeks: 1, holdDays: 7, skip1d: true, quantile: 0.2, weighting: "equal", betaNeutralize: true };
const rebalC = rebalanceDays(panel, 7, 200); const { is: cis, oos: coos } = splitRebal(rebalC);
const cR = buildBook(panel, canon, cis, COST); const cOOS = buildBook(panel, canon, coos, COST);
const annC = annF(7);
const canonSh = annC * sharpePeriod(cR.netRet);
const canonSurr: number[] = [];
for (let i = 0; i < NSURR; i++) { const rng = mkRng(91000 + i * 7919); const r = buildBook(panel, canon, cis, COST, rng); canonSurr.push(annC * sharpePeriod(r.netRet)); }
canonSurr.sort((a, b) => a - b);
const canonSurrP = (canonSurr.filter((s) => s >= canonSh).length + 1) / (canonSurr.length + 1);
const canonOOS = annC * sharpePeriod(cOOS.netRet);

// ---- assemble ----
const gates: Record<string, { pass: boolean; detail: string }> = {
  net_of_cost: g_net, baselines: g_base, deflated_sharpe: g_dsr, block_bootstrap: g_bb,
  cpcv_pbo: g_pbo, haircut: g_hair, surrogate: g_surr, holdout: g_hold,
};
const order = ["net_of_cost", "baselines", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "surrogate", "holdout"];
let binding = "none";
for (const k of order) if (!gates[k].pass) { binding = k; break; }
const core = gates.net_of_cost.pass && gates.baselines.pass && gates.surrogate.pass && gates.holdout.pass;
const verdict = binding === "none" ? "SURVIVE" : core ? "PROMISING" : "KILL";
const monthly = binding === "none" ? `$${Math.round(netMean * (30 / bestHold) * 100000)}` : "n/a";

console.log(`\n================ Q4-STREV gauntlet ================`);
console.log(`best=${best.label}  netSharpeAnn(IS)=${best.netSh.toFixed(3)}  bookBeta=${mean(bestIS.longShortBeta).toFixed(3)}  nWeeks(IS)=${bestIS.nRebal}`);
for (const k of order) console.log(`  [${gates[k].pass ? "PASS" : "KILL"}] ${k} — ${gates[k].detail}`);
console.log(`canonical(weekly,1w,skip,q=.2): netSharpeAnn=${canonSh.toFixed(3)} XS-shuffleP=${canonSurrP.toFixed(4)} OOS=${canonOOS.toFixed(3)}`);
console.log(`\nVERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${monthly}`);
