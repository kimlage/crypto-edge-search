/**
 * TARGET 4 — Diversified Time-Series Momentum (TSMOM) with vol-targeting across
 * the multi-coin panel (Moskowitz, Ooi & Pedersen 2012).
 *
 * Rule (transparent + causal): for each coin, hold sign(trailing L-day return),
 * scaled to a constant ex-ante per-leg volatility (vol-targeting), then average
 * across all coins live at t. The position over day t uses ONLY data observable
 * at the close of t-1. Distinct from E3 (single-asset long-flat, no vol-target):
 * this is panel-diversified, can go short, and vol-targets every leg.
 *
 * Method (identical to the other targets, for comparability):
 *   1) Implement causally, charge realistic cost (28 bps round-trip default),
 *      log turnover.
 *   2) Self-checks via tsx: PURE NOISE must show no edge; a future-data mutation
 *      must not change an earlier day's decision (causality).
 *   3) Search configs on the SEARCH slice only; record the TRUE N tried.
 *   4) Reserve the most-recent ~24 months as a one-shot hold-out (holdout.ts
 *      consume-once). Evaluate the chosen config ONCE via evaluatePromotion.
 *   5) Apply a 50% McLean-Pontiff haircut. PROMOTE only if, on the hold-out:
 *      net positive, beats the universe buy&hold baseline, DSR(true N) >= 0.95,
 *      MinBTL ok, haircut > 0.
 *
 * Reuses committed cores (no re-implemented stats): evaluatePromotion,
 * planHoldoutSplit + FinalHoldoutGuard, summarizeReturnSeries,
 * computeDeflatedSharpeRatio, evaluateMinBtl. Reads output/crossxs only.
 * No BigQuery, no training, no writes outside this target.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import {
  planHoldoutSplit,
  assertSearchDoesNotTouchHoldout,
  FinalHoldoutGuard,
} from "../src/lib/significance/holdout";
import { summarizeReturnSeries } from "../src/lib/statistical-validation";
import {
  runTsmomPanel,
  annualizedReturn,
  annualizedSharpe,
  maxDrawdown,
  compound,
  type TsmomConfig,
} from "./lib/tsmom-panel";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ROUND_TRIP_COST = 0.0028; // 28 bps per the cost-realism rule
const DSR_THRESHOLD = 0.95;
const HAIRCUT = 0.5; // McLean & Pontiff 50% out-of-sample decay

interface DailyCloses {
  source: string;
  realData: boolean;
  dates: string[];
  closes: Record<string, (number | null)[]>;
}

function loadPanel(): DailyCloses {
  const raw = readFileSync(join(ROOT, "output", "crossxs", "daily-closes.json"), "utf8");
  return JSON.parse(raw) as DailyCloses;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}

/** Seeded PRNG (mulberry32) for the noise self-check. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a PURE-NOISE panel: each coin is a geometric random walk with the same
 * length/listing pattern as the real panel but i.i.d. zero-drift returns. A real
 * momentum edge must vanish here (no autocorrelation to exploit).
 */
function buildNoisePanel(real: DailyCloses, seed: number): DailyCloses {
  const rng = mulberry32(seed);
  const gauss = () => {
    // Box-Muller
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const closes: Record<string, (number | null)[]> = {};
  const dailySigma = 0.04; // ~4%/day, realistic crypto
  for (const coin of Object.keys(real.closes)) {
    const src = real.closes[coin];
    const out: (number | null)[] = new Array(src.length).fill(null);
    let price = 100;
    let started = false;
    for (let i = 0; i < src.length; i += 1) {
      if (src[i] == null) {
        out[i] = null;
        continue;
      }
      if (!started) {
        price = 100;
        started = true;
        out[i] = price;
        continue;
      }
      price *= Math.exp(dailySigma * gauss() - 0.5 * dailySigma * dailySigma);
      out[i] = price;
    }
    closes[coin] = out;
  }
  return { ...real, closes };
}

const SEARCH_CONFIGS: Array<Omit<TsmomConfig, "roundTripCost">> = (() => {
  const out: Array<Omit<TsmomConfig, "roundTripCost">> = [];
  const lookbacks = [30, 60, 90, 120, 180, 252];
  const volWindows = [30, 60, 90];
  const targetVols = [0.3, 0.4];
  for (const lookbackDays of lookbacks) {
    for (const volWindowDays of volWindows) {
      for (const targetAnnualVol of targetVols) {
        out.push({
          lookbackDays,
          volWindowDays,
          targetAnnualVol,
          maxLegWeight: 3,
        });
      }
    }
  }
  return out;
})();

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function universeBuyAndHoldDaily(panel: DailyCloses, start: number, end: number): number[] {
  // Equal-weight, daily-rebalanced buy&hold over all live coins (the "universe").
  const coins = Object.keys(panel.closes);
  const out: number[] = [];
  for (let t = Math.max(1, start); t < end; t += 1) {
    let sum = 0;
    let n = 0;
    for (const coin of coins) {
      const prev = panel.closes[coin][t - 1];
      const cur = panel.closes[coin][t];
      if (prev != null && cur != null && prev > 0 && cur > 0) {
        sum += cur / prev - 1;
        n += 1;
      }
    }
    if (n > 0) out.push(sum / n);
  }
  return out;
}

function main(): void {
  console.log("=".repeat(80));
  console.log("TARGET 4 — DIVERSIFIED TSMOM (vol-targeted, multi-coin) — honest audit");
  console.log("=".repeat(80));

  const panel = loadPanel();
  const T = panel.dates.length;
  console.log(
    `panel : ${Object.keys(panel.closes).length} coins, ${T} daily dates ` +
      `${panel.dates[0]}..${panel.dates[T - 1]} realData=${panel.realData} source=${panel.source}`,
  );
  console.log(`cost  : roundTrip=${ROUND_TRIP_COST} (28 bps)  DSR>=${DSR_THRESHOLD}  haircut=${HAIRCUT}`);

  // --- Holdout plan: most-recent ~24 months as the one-shot vault. -----------
  // 24 months of daily ≈ 730 rows. Set fractions so the vault ~= last 24mo and a
  // posterior 'test' block precedes it; the search owns everything older.
  const holdoutFraction = 730 / T; // ~24 months
  const plan = planHoldoutSplit({ totalRows: T, holdoutFraction, testFraction: 0.0 });
  const searchEnd = plan.search.end; // search uses [0, searchEnd)
  const holdoutStart = plan.finalHoldout.start;
  const holdoutEnd = plan.finalHoldout.end;
  assertSearchDoesNotTouchHoldout({ searchMaxIndexExclusive: searchEnd, holdoutStartIndex: holdoutStart });
  console.log(
    `\nholdout plan: search=[0,${searchEnd}) (${panel.dates[0]}..${panel.dates[searchEnd - 1]})  ` +
      `VAULT=[${holdoutStart},${holdoutEnd}) (${panel.dates[holdoutStart]}..${panel.dates[holdoutEnd - 1]})`,
  );
  console.log(`             vault span ~= ${((holdoutEnd - holdoutStart) / 365).toFixed(2)} years`);

  // === SELF-CHECK 1: PURE NOISE must show no edge ===========================
  console.log("\n-- self-check 1: pure-noise panel (must NOT show edge) --");
  const noiseCfg: TsmomConfig = { lookbackDays: 90, volWindowDays: 60, targetAnnualVol: 0.4, roundTripCost: ROUND_TRIP_COST, maxLegWeight: 3 };
  // On PURE NOISE there is no autocorrelation, so momentum has zero GROSS edge.
  // The honest test: the GROSS net Sharpe must hover around 0 (no spurious signal),
  // and the after-cost result must NOT be positive (a noise rule cannot make money).
  const noiseGrossSharpes: number[] = [];
  const noiseNetSharpes: number[] = [];
  for (let s = 1; s <= 5; s += 1) {
    const noise = buildNoisePanel(panel, 12345 + s);
    const res = runTsmomPanel({ closesByCoin: noise.closes, dates: noise.dates, config: noiseCfg, startIndex: 1, endIndex: searchEnd });
    const grossSh = annualizedSharpe(res.dailyGross);
    const netSh = annualizedSharpe(res.dailyNet);
    noiseGrossSharpes.push(grossSh);
    noiseNetSharpes.push(netSh);
    console.log(`   seed ${s}: GROSS Sharpe=${grossSh.toFixed(3)} netSharpe=${netSh.toFixed(3)} grossTotal=${pct(compound(res.dailyGross))} netTotal=${pct(compound(res.dailyNet))} turnover=${res.avgDailyTurnover.toFixed(3)}`);
  }
  const meanGross = noiseGrossSharpes.reduce((a, b) => a + b, 0) / noiseGrossSharpes.length;
  const meanNet = noiseNetSharpes.reduce((a, b) => a + b, 0) / noiseNetSharpes.length;
  // Clean = no spurious GROSS edge (|grossSharpe| small) AND net is not positive.
  const noiseClean = Math.abs(meanGross) < 0.35 && meanNet <= 0;
  console.log(`   mean GROSS Sharpe=${meanGross.toFixed(3)} (must be ~0)  mean NET Sharpe=${meanNet.toFixed(3)} (must be <=0)`);
  console.log(`   -> ${noiseClean ? "CLEAN (no spurious gross edge; cost makes noise unprofitable as expected)" : "WARNING: noise shows a gross edge!"}`);

  // === SELF-CHECK 2: causality — mutating the FUTURE must not change an =====
  // earlier day's net return. ================================================
  console.log("\n-- self-check 2: causality (future mutation must not change earlier decisions) --");
  const cfgC: TsmomConfig = { lookbackDays: 90, volWindowDays: 60, targetAnnualVol: 0.4, roundTripCost: ROUND_TRIP_COST, maxLegWeight: 3 };
  const baseRun = runTsmomPanel({ closesByCoin: panel.closes, dates: panel.dates, config: cfgC, startIndex: 1, endIndex: searchEnd });
  // Mutate the LAST 50 days of every coin's closes (the future), then re-run and
  // compare the FIRST 80% of the daily net series (the past, which must be intact).
  const mutated: Record<string, (number | null)[]> = {};
  const cut = searchEnd - 50;
  for (const coin of Object.keys(panel.closes)) {
    const arr = panel.closes[coin].slice();
    for (let i = cut; i < arr.length; i += 1) if (arr[i] != null) arr[i] = (arr[i] as number) * 1.5;
    mutated[coin] = arr;
  }
  const mutRun = runTsmomPanel({ closesByCoin: mutated, dates: panel.dates, config: cfgC, startIndex: 1, endIndex: searchEnd });
  // Compare returns for active days whose date < dates[cut-1] (strictly the past).
  let maxDiff = 0;
  let comparedDays = 0;
  const cutDate = panel.dates[cut - 1];
  for (let i = 0; i < baseRun.dates.length; i += 1) {
    if (baseRun.dates[i] >= cutDate) break;
    // align by date
    const j = mutRun.dates.indexOf(baseRun.dates[i]);
    if (j >= 0) {
      maxDiff = Math.max(maxDiff, Math.abs(baseRun.dailyNet[i] - mutRun.dailyNet[j]));
      comparedDays += 1;
    }
  }
  const causalityClean = maxDiff < 1e-12;
  console.log(`   compared ${comparedDays} past days (before ${cutDate}); max |Δ net| = ${maxDiff.toExponential(2)} -> ${causalityClean ? "CAUSAL (past intact)" : "LEAK!"}`);

  // === SEARCH on the SEARCH SLICE only ======================================
  console.log(`\n-- search: ${SEARCH_CONFIGS.length} configs on search slice only (TRUE N = ${SEARCH_CONFIGS.length}) --`);
  const TRUE_N = SEARCH_CONFIGS.length;
  let best: { cfg: TsmomConfig; sharpe: number; ann: number; mdd: number; net: number; res: ReturnType<typeof runTsmomPanel> } | null = null;
  const rows: Array<{ cfg: TsmomConfig; sharpe: number; ann: number }> = [];
  for (const base of SEARCH_CONFIGS) {
    const cfg: TsmomConfig = { ...base, roundTripCost: ROUND_TRIP_COST };
    const res = runTsmomPanel({ closesByCoin: panel.closes, dates: panel.dates, config: cfg, startIndex: 1, endIndex: searchEnd });
    const sharpe = annualizedSharpe(res.dailyNet);
    const ann = annualizedReturn(res.dailyNet);
    const mdd = maxDrawdown(res.dailyNet);
    rows.push({ cfg, sharpe, ann });
    if (!best || sharpe > best.sharpe) best = { cfg, sharpe, ann, mdd, net: compound(res.dailyNet), res };
  }
  rows.sort((a, b) => b.sharpe - a.sharpe);
  console.log("   top 5 configs by in-sample net Sharpe:");
  for (const r of rows.slice(0, 5)) {
    console.log(`     L=${String(r.cfg.lookbackDays).padStart(3)} volW=${String(r.cfg.volWindowDays).padStart(2)} tgt=${r.cfg.targetAnnualVol}  Sharpe=${r.sharpe.toFixed(3)} ann=${pct(r.ann)}`);
  }
  const chosen = best!;
  console.log(
    `\n   CHOSEN (in-sample best): L=${chosen.cfg.lookbackDays} volW=${chosen.cfg.volWindowDays} tgt=${chosen.cfg.targetAnnualVol}` +
      `  Sharpe=${chosen.sharpe.toFixed(3)} ann=${pct(chosen.ann)} maxDD=${pct(chosen.mdd)} ` +
      `breadth=${chosen.res.avgBreadth.toFixed(1)} turnover=${chosen.res.avgDailyTurnover.toFixed(3)}`,
  );

  // === ONE-SHOT HOLD-OUT EVALUATION =========================================
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "TARGET4 TSMOM one-shot vault eval", gitSha: gitSha(), trialCount: TRUE_N, nowIso: new Date().toISOString() });
  console.log("\n" + "=".repeat(80));
  console.log("ONE-SHOT HOLD-OUT (vault consumed once)");
  console.log("=".repeat(80));

  const vault = runTsmomPanel({ closesByCoin: panel.closes, dates: panel.dates, config: chosen.cfg, startIndex: holdoutStart, endIndex: holdoutEnd });
  const vaultStats = summarizeReturnSeries(vault.dailyNet);
  const vaultAnn = annualizedReturn(vault.dailyNet);
  const vaultSharpe = annualizedSharpe(vault.dailyNet);
  const vaultMdd = maxDrawdown(vault.dailyNet);
  const vaultNetTotal = compound(vault.dailyNet);
  const vaultGrossTotal = compound(vault.dailyGross);

  // Universe buy&hold over the SAME vault window, charged one round-trip.
  const uniDaily = universeBuyAndHoldDaily(panel, holdoutStart, holdoutEnd);

  console.log(
    `vault TSMOM : days=${vault.activeDays} netTotal=${pct(vaultNetTotal)} grossTotal=${pct(vaultGrossTotal)} ` +
      `ann=${pct(vaultAnn)} Sharpe=${vaultSharpe.toFixed(3)} maxDD=${pct(vaultMdd)}`,
  );
  console.log(
    `             breadth=${vault.avgBreadth.toFixed(1)} avgDailyTurnover=${vault.avgDailyTurnover.toFixed(3)} ` +
      `costDrag/yr~=${pct(vault.dailyCost.reduce((a, b) => a + b, 0) / (vault.activeDays / 365))}`,
  );
  console.log(`universe B&H: total=${pct(compound(uniDaily))} ann=${pct(annualizedReturn(uniDaily))} Sharpe=${annualizedSharpe(uniDaily).toFixed(3)}`);

  // Promotion gates: feed the candidate daily net series + universe bar returns
  // as the buy&hold baseline; trialCount = TRUE_N.
  const evaluation = evaluatePromotion({
    candidateId: `tsmom-L${chosen.cfg.lookbackDays}-vw${chosen.cfg.volWindowDays}-tv${chosen.cfg.targetAnnualVol}`,
    candidateReturns: vault.dailyNet,
    sampleCount: vault.activeDays,
    trialCount: TRUE_N,
    barReturns: uniDaily, // drives buy&hold + random-lottery baselines on the universe
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: Math.max(1, Math.round(chosen.cfg.lookbackDays)),
    baselineStatistic: "compoundReturn",
    seed: "target4-tsmom",
  });

  const g = evaluation.gates;
  console.log("\n-- promotion gates (evaluatePromotion, trueN) --");
  console.log(`  baselines      : applicable=${g.baselines.applicable} passed=${g.baselines.passed}`);
  if (g.baselines.result) {
    for (const c of g.baselines.result.comparisons) {
      console.log(`     vs ${c.label.padEnd(22)} candidate-baseline margin=${pct(c.margin)} beaten=${c.beaten}`);
    }
  }
  console.log(`  deflatedSharpe : passed=${g.deflatedSharpe.passed} DSR=${g.deflatedSharpe.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}) sharpe(per-day)=${g.deflatedSharpe.sharpe.toFixed(4)} N=${g.deflatedSharpe.trialCount}`);
  console.log(`  minBtl         : passed=${g.minBtl.passed} reason=${g.minBtl.result.reason} need>=${g.minBtl.result.minSampleForObservedSharpe} have=${g.minBtl.result.sampleCount}`);
  console.log(`  haircut        : passed=${g.haircut.passed} haircutSharpe=${g.haircut.result.haircutSharpe.toFixed(4)}`);
  console.log(`  gatesPassed    : ${evaluation.summary.gatesPassed}/${evaluation.summary.gatesApplicable}`);
  if (evaluation.reasons.length > 0) console.log(`  reasons        : ${evaluation.reasons.join("; ")}`);

  // McLean-Pontiff 50% haircut on the vault annualised return.
  const haircutAnn = vaultAnn * HAIRCUT;
  console.log(`\n-- McLean-Pontiff 50% decay haircut --`);
  console.log(`  vault ann=${pct(vaultAnn)} -> post-haircut ann=${pct(haircutAnn)}`);

  // === VERDICT ==============================================================
  const netPositive = vaultNetTotal > 0;
  const beatsBaseline = g.baselines.passed;
  const dsrOk = g.deflatedSharpe.passed;
  const minBtlOk = g.minBtl.passed;
  const haircutPositive = haircutAnn > 0;
  const promote = netPositive && beatsBaseline && dsrOk && minBtlOk && haircutPositive && noiseClean && causalityClean;

  console.log("\n" + "=".repeat(80));
  console.log("VERDICT");
  console.log("=".repeat(80));
  console.log(`  net-of-cost positive      : ${netPositive} (${pct(vaultNetTotal)})`);
  console.log(`  beats universe baseline   : ${beatsBaseline}`);
  console.log(`  DSR(trueN=${TRUE_N})>=0.95     : ${dsrOk} (${g.deflatedSharpe.deflatedProbability.toFixed(4)})`);
  console.log(`  MinBTL ok                 : ${minBtlOk}`);
  console.log(`  haircut>0                 : ${haircutPositive} (${pct(haircutAnn)})`);
  console.log(`  self-checks (noise/causal): ${noiseClean}/${causalityClean}`);
  console.log(`\n  ==> ${promote ? "PROMOTE" : "KILL"}`);
  console.log("=".repeat(80));
}

main();
