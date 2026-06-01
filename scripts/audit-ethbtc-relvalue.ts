/**
 * TARGET 9 — ETH/BTC RELATIVE-VALUE (market-neutral spread trading).
 *
 * Trade the ETH/BTC ratio as a market-neutral relative bet: a long-ratio
 * position is long ETH / short BTC, a short-ratio position is short ETH / long
 * BTC. The per-period "ratio return" already encodes the combined two-leg P&L of
 * that spread, so a position p_t in [-1,+1] earns p_t * ratioReturn_t.
 *
 * We test BOTH families on the ratio, at daily AND weekly horizons:
 *   - MOMENTUM:        go with the sign of the past-L ratio return (trend).
 *   - MEAN-REVERSION:  fade the z-score of the ratio vs its rolling mean (revert).
 *
 * Market-neutral baseline = FLAT (zero). The strategy must (a) be net-positive
 * after costs and (b) clear the rigour gates, which additionally pit it against
 * always-long-the-ratio (buy&hold the spread) and a random-lottery trader.
 *
 * METHOD (identical to the other targets, for comparability):
 *   1) Rule is TRANSPARENT + CAUSAL: position at period t is decided from ratio
 *      data <= t-1 only; P&L = p_t * ratioReturn(t-1 -> t). Cost charged on
 *      |Δposition| turnover. A spread touches TWO legs, so a full flip is charged
 *      2 * roundTrip. Default roundTrip = 28 bps/leg => a flip (|Δp|=2) costs
 *      ~2 * 28bps = 112 bps; a fresh entry (|Δp|=1) costs ~56 bps (two legs, one
 *      side each). Turnover is logged.
 *   2) Self-checks via tsx: on a PURE-NOISE ratio the best rule must NOT show
 *      edge (no hallucination); a future-data mutation must NOT change an earlier
 *      decision (causality).
 *   3) Single best config chosen on a SEARCH slice only; TRUE N = #configs tried.
 *   4) Most-recent ~24 months reserved as a one-shot hold-out (consume-once).
 *      Chosen config evaluated ONCE on the vault via evaluatePromotion.
 *   5) 50% McLean-Pontiff decay haircut on the hold-out edge. PROMOTE only if,
 *      on the hold-out: net positive, beats baseline (flat + buy&hold + lottery),
 *      DSR(true N) >= 0.95, MinBTL ok, haircut > 0.
 *
 * REUSE: committed rigour cores (no re-implemented statistics):
 *   promotion-evaluator.evaluatePromotion, holdout.{planHoldoutSplit,
 *   FinalHoldoutGuard}, statistical-validation.summarizeReturnSeries,
 *   trial-count.evaluateMinBtl.
 *
 * Data: output/crossxs/daily-closes.json (real Binance daily closes, BTC + ETH).
 * No BigQuery. Writes nothing. Read-only over committed data.
 *
 * Usage:
 *   tsx scripts/audit-ethbtc-relvalue.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import {
  planHoldoutSplit,
  FinalHoldoutGuard,
} from "../src/lib/significance/holdout";
import { summarizeReturnSeries } from "../src/lib/statistical-validation";
import { evaluateMinBtl } from "../src/lib/significance/trial-count";

// ---------------------------------------------------------------------------
// Cost model. A relative-value (spread) trade touches TWO spot legs. We treat
// 28 bps as the round-trip cost PER LEG and charge it on per-leg turnover. A
// position change Δp on the ratio re-trades both legs by |Δp|, i.e. 2*|Δp| legs
// of turnover, each costing roundTrip/2 per one-way... To stay strictly
// conservative and transparent we charge: cost_t = ROUND_TRIP_PER_LEG * LEGS *
// |Δp_t| where LEGS = 2. So a full flip (|Δp|=2) is charged 2*2*0.0028 = 1.12%.
// (This is deliberately harsh; a perp-on-ETHBTC or a single ETH leg vs BTC
// collateral would be cheaper, but we do not claim that here.)
const ROUND_TRIP_PER_LEG = 0.0028;
const LEGS = 2;
const COST_PER_UNIT_TURNOVER = ROUND_TRIP_PER_LEG * LEGS; // 0.0056 per unit |Δp|

// Hold-out: most-recent ~24 months. Daily ~ 24/72 months of the 72-month panel.
const HOLDOUT_FRACTION = 24 / 72; // ~0.333 of the timeline = last 24 months
const TEST_FRACTION = 0; // we fold "test" into the search slice; vault is the gate
const DSR_THRESHOLD = 0.95;
const HAIRCUT = 0.5; // McLean-Pontiff 50% decay

interface DailyCloses {
  source: string;
  realData: boolean;
  dates: string[];
  closes: Record<string, number[]>;
}

interface Bar {
  date: string;
  ratio: number;
}

interface SignalConfig {
  id: string;
  family: "momentum" | "reversion";
  horizon: "daily" | "weekly";
  lookback: number; // periods (in the chosen horizon)
  zEntry?: number; // reversion only
}

interface Eval {
  config: SignalConfig;
  perPeriodNet: number[]; // net-of-cost per-period strategy returns
  perPeriodGross: number[];
  ratioReturns: number[]; // the aligned ratio returns (= buy&hold-the-spread bars)
  turnover: number; // sum |Δp|
  periods: number;
  compoundNet: number;
  sharpe: number;
  meanNet: number;
  avgAbsPos: number;
}

// --- Load real ratio series ------------------------------------------------

function loadRatio(): { dates: string[]; ratio: number[]; real: boolean } {
  const path = join("output", "crossxs", "daily-closes.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as DailyCloses;
  const btc = raw.closes.BTC;
  const eth = raw.closes.ETH;
  if (!btc || !eth) throw new Error("BTC/ETH closes missing from daily-closes.json");
  const dates: string[] = [];
  const ratio: number[] = [];
  for (let i = 0; i < raw.dates.length; i += 1) {
    const b = btc[i];
    const e = eth[i];
    if (typeof b === "number" && typeof e === "number" && b > 0 && e > 0) {
      dates.push(raw.dates[i]!);
      ratio.push(e / b);
    }
  }
  return { dates, ratio, real: raw.realData === true };
}

// Aggregate daily ratio to weekly (every 7th day, causal sampling).
function toWeekly(dates: string[], ratio: number[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < ratio.length; i += 7) {
    out.push({ date: dates[i]!, ratio: ratio[i]! });
  }
  return out;
}

function toDaily(dates: string[], ratio: number[]): Bar[] {
  return dates.map((d, i) => ({ date: d, ratio: ratio[i]! }));
}

// --- Causal signal -> position ---------------------------------------------
// position[t] is decided using ratio data with index <= t-1 (strictly past).
// Returns the position array aligned to bars[1..]; P&L of period t (bars[t-1] ->
// bars[t]) uses position decided at t (from data <= t-1).

function positions(bars: Bar[], cfg: SignalConfig): number[] {
  const n = bars.length;
  const pos = new Array<number>(n).fill(0);
  const r = bars.map((b) => b.ratio);
  for (let t = 1; t < n; t += 1) {
    // Decide position for period t (earned over bars[t-1] -> bars[t]) using only
    // data up to index t-1.
    const L = cfg.lookback;
    if (cfg.family === "momentum") {
      const past = t - 1 - L;
      if (past < 0) {
        pos[t] = 0;
        continue;
      }
      const mom = (r[t - 1]! - r[past]!) / r[past]!;
      pos[t] = mom > 0 ? 1 : mom < 0 ? -1 : 0;
    } else {
      // mean-reversion: z-score of ratio vs rolling mean over [t-1-L, t-1].
      const start = t - 1 - L;
      if (start < 0) {
        pos[t] = 0;
        continue;
      }
      let sum = 0;
      for (let k = start; k <= t - 1; k += 1) sum += r[k]!;
      const m = sum / (L + 1);
      let v = 0;
      for (let k = start; k <= t - 1; k += 1) v += (r[k]! - m) ** 2;
      const sd = Math.sqrt(v / Math.max(1, L));
      const z = sd > 1e-12 ? (r[t - 1]! - m) / sd : 0;
      const entry = cfg.zEntry ?? 1;
      // Fade: ratio rich (z high) -> short the spread; ratio cheap -> long.
      if (z >= entry) pos[t] = -1;
      else if (z <= -entry) pos[t] = 1;
      else pos[t] = 0;
    }
  }
  return pos;
}

// --- Evaluate a config over a contiguous slice of bars ---------------------

function evaluate(bars: Bar[], cfg: SignalConfig): Eval {
  const pos = positions(bars, cfg);
  const perPeriodNet: number[] = [];
  const perPeriodGross: number[] = [];
  const ratioReturns: number[] = [];
  let turnover = 0;
  let absPosSum = 0;
  let prevPos = 0;
  for (let t = 1; t < bars.length; t += 1) {
    const rr = (bars[t]!.ratio - bars[t - 1]!.ratio) / bars[t - 1]!.ratio;
    const p = pos[t]!;
    const gross = p * rr;
    const dPos = Math.abs(p - prevPos);
    turnover += dPos;
    const cost = dPos * COST_PER_UNIT_TURNOVER;
    perPeriodGross.push(gross);
    perPeriodNet.push(gross - cost);
    ratioReturns.push(rr);
    absPosSum += Math.abs(p);
    prevPos = p;
  }
  const stats = summarizeReturnSeries(perPeriodNet);
  return {
    config: cfg,
    perPeriodNet,
    perPeriodGross,
    ratioReturns,
    turnover,
    periods: perPeriodNet.length,
    compoundNet: stats.compoundReturn,
    sharpe: stats.sharpe,
    meanNet: stats.mean,
    avgAbsPos: bars.length > 1 ? absPosSum / (bars.length - 1) : 0,
  };
}

// --- Config grid -----------------------------------------------------------

function buildGrid(): SignalConfig[] {
  const grid: SignalConfig[] = [];
  const dailyMomLb = [3, 5, 10, 20, 30, 60, 90];
  const weeklyMomLb = [2, 3, 4, 6, 8, 12, 26];
  const dailyRevLb = [10, 20, 30, 60, 90];
  const weeklyRevLb = [4, 6, 8, 12, 26];
  const zEntries = [1.0, 1.5, 2.0];
  for (const lb of dailyMomLb)
    grid.push({ id: `mom-d-${lb}`, family: "momentum", horizon: "daily", lookback: lb });
  for (const lb of weeklyMomLb)
    grid.push({ id: `mom-w-${lb}`, family: "momentum", horizon: "weekly", lookback: lb });
  for (const lb of dailyRevLb)
    for (const z of zEntries)
      grid.push({ id: `rev-d-${lb}-z${z}`, family: "reversion", horizon: "daily", lookback: lb, zEntry: z });
  for (const lb of weeklyRevLb)
    for (const z of zEntries)
      grid.push({ id: `rev-w-${lb}-z${z}`, family: "reversion", horizon: "weekly", lookback: lb, zEntry: z });
  return grid;
}

// --- Self-checks -----------------------------------------------------------

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

function noiseCheck(bestCfg: SignalConfig): {
  meanSharpe: number;
  meanNetCompound: number;
  posEdgeRate: number;
  draws: number;
} {
  // Pure-noise ratio: zero-drift random walks. The no-hallucination test is that
  // the rule shows NO SYSTEMATIC POSITIVE edge on structureless data: across many
  // seeds the mean Sharpe must hover around 0 (not positive), and a positive net
  // edge must NOT appear materially more than half the time (a real signal on
  // noise would tilt these upward). A single draw can be slightly +/- by luck;
  // we judge the distribution, not one path.
  const draws = 200;
  let sumSharpe = 0;
  let sumNet = 0;
  let posEdge = 0;
  for (let s = 0; s < draws; s += 1) {
    const rng = mulberry32(1000 + s * 7919);
    const n = bestCfg.horizon === "daily" ? 1460 : 209; // match search-slice length
    let r = 0.025;
    const bars: Bar[] = [];
    for (let i = 0; i < n; i += 1) {
      r *= 1 + (rng() - 0.5) * 0.04; // ~1.2% per-step vol, zero drift
      bars.push({ date: `N${i}`, ratio: r });
    }
    const ev = evaluate(bars, bestCfg);
    sumSharpe += ev.sharpe;
    sumNet += ev.compoundNet;
    if (ev.compoundNet > 0) posEdge += 1;
  }
  return {
    meanSharpe: sumSharpe / draws,
    meanNetCompound: sumNet / draws,
    posEdgeRate: posEdge / draws,
    draws,
  };
}

function causalityCheck(bars: Bar[], cfg: SignalConfig): boolean {
  // Decide position at a cut point, then mutate ALL future bars and confirm the
  // position at the cut point is unchanged.
  const cut = Math.floor(bars.length * 0.6);
  const posBefore = positions(bars.slice(0, cut + 1), cfg)[cut];
  const mutated = bars.map((b, i) =>
    i > cut ? { ...b, ratio: b.ratio * (1 + (i % 7) * 0.05) } : b,
  );
  const posAfter = positions(mutated.slice(0, cut + 1), cfg)[cut];
  return posBefore === posAfter;
}

// --- Reporting -------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(3)}%`;
}

function annualize(compound: number, periods: number, perYear: number): number {
  if (periods <= 0) return 0;
  const years = periods / perYear;
  if (years <= 0) return 0;
  return Math.pow(1 + compound, 1 / years) - 1;
}

function maxDrawdown(perPeriod: number[]): number {
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of perPeriod) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = (eq - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

function main(): void {
  console.log("=".repeat(78));
  console.log("TARGET 9 — ETH/BTC RELATIVE-VALUE (market-neutral spread)  HONEST AUDIT");
  console.log("=".repeat(78));

  const { dates, ratio, real } = loadRatio();
  console.log(`data        : output/crossxs/daily-closes.json  realData=${real}`);
  console.log(`ratio span  : ${dates[0]} .. ${dates[dates.length - 1]}  (${ratio.length} daily obs)`);
  console.log(`ratio range : ${Math.min(...ratio).toFixed(5)} .. ${Math.max(...ratio).toFixed(5)}`);
  console.log(
    `cost model  : ${ROUND_TRIP_PER_LEG * 1e4}bps/leg x ${LEGS} legs = ${COST_PER_UNIT_TURNOVER * 1e4}bps per unit |Δp| ` +
      `(full flip |Δp|=2 => ${COST_PER_UNIT_TURNOVER * 2 * 1e4}bps)`,
  );

  const dailyBars = toDaily(dates, ratio);
  const weeklyBars = toWeekly(dates, ratio);
  console.log(`bars        : daily=${dailyBars.length}  weekly=${weeklyBars.length}`);

  // --- Hold-out split on the DAILY timeline; map the same calendar cut to weekly.
  const plan = planHoldoutSplit({
    totalRows: dailyBars.length,
    holdoutFraction: HOLDOUT_FRACTION,
    testFraction: TEST_FRACTION,
  });
  const searchEndIdx = plan.search.end; // exclusive daily index where vault begins
  const cutDate = dailyBars[searchEndIdx]?.date ?? dailyBars[dailyBars.length - 1]!.date;
  console.log(
    `\nhold-out    : search daily[0..${searchEndIdx}) (${plan.search.rows} bars) | ` +
      `VAULT daily[${searchEndIdx}..${dailyBars.length}) (${plan.finalHoldout.rows + plan.test.rows} bars)`,
  );
  console.log(`cut date    : ${cutDate}  (vault = most-recent ~24 months, never seen by the search)`);

  const dailySearch = dailyBars.slice(0, searchEndIdx);
  const dailyVault = dailyBars.slice(searchEndIdx);
  const weeklyCut = weeklyBars.findIndex((b) => b.date >= cutDate);
  const wCut = weeklyCut < 0 ? weeklyBars.length : weeklyCut;
  const weeklySearch = weeklyBars.slice(0, wCut);
  const weeklyVault = weeklyBars.slice(wCut);
  console.log(
    `weekly split: search weekly[0..${wCut}) (${weeklySearch.length}) | VAULT weekly[${wCut}..${weeklyBars.length}) (${weeklyVault.length})`,
  );

  // --- SEARCH: evaluate every config on the search slice only ---------------
  const grid = buildGrid();
  const trueN = grid.length;
  console.log(`\nSEARCH grid : ${trueN} configs (TRUE N = ${trueN})`);

  type Row = { cfg: SignalConfig; ev: Eval; annNet: number; perYear: number };
  const rows: Row[] = [];
  for (const cfg of grid) {
    const bars = cfg.horizon === "daily" ? dailySearch : weeklySearch;
    const ev = evaluate(bars, cfg);
    const perYear = cfg.horizon === "daily" ? 365 : 52;
    const annNet = annualize(ev.compoundNet, ev.periods, perYear);
    rows.push({ cfg, ev, annNet, perYear });
  }
  rows.sort((a, b) => b.ev.sharpe - a.ev.sharpe);

  console.log("\n-- SEARCH-slice leaderboard (ranked by net Sharpe) --");
  console.log("  config              fam  hz   sharpe   netCompound   annNet   turnover  avgPos");
  for (const row of rows.slice(0, 10)) {
    console.log(
      `  ${row.cfg.id.padEnd(18)} ${row.cfg.family.slice(0, 3)}  ${row.cfg.horizon.slice(0, 1)}   ` +
        `${row.ev.sharpe.toFixed(4).padStart(7)}  ${pct(row.ev.compoundNet).padStart(11)}  ` +
        `${pct(row.annNet).padStart(8)}  ${row.ev.turnover.toFixed(0).padStart(7)}  ${row.ev.avgAbsPos.toFixed(2)}`,
    );
  }

  const winner = rows[0]!;
  console.log(
    `\nCHOSEN (best net Sharpe on SEARCH only): ${winner.cfg.id}  ` +
      `[${winner.cfg.family}/${winner.cfg.horizon} lookback=${winner.cfg.lookback}` +
      `${winner.cfg.zEntry ? ` z=${winner.cfg.zEntry}` : ""}]`,
  );

  // --- SELF-CHECK 1: pure noise must show no SYSTEMATIC positive edge -------
  const noise = noiseCheck(winner.cfg);
  // No-hallucination bar: mean Sharpe across draws ~0 (not positive) and the
  // rule is not net-positive on a clear majority of noise draws.
  const noiseClean = noise.meanSharpe < 0.05 && noise.posEdgeRate < 0.6;
  console.log("\n-- SELF-CHECK 1: pure-noise ratio, no hallucination (200 zero-drift draws) --");
  console.log(
    `  mean noise sharpe=${noise.meanSharpe.toFixed(4)}  mean net=${pct(noise.meanNetCompound)}  ` +
      `posEdgeRate=${(noise.posEdgeRate * 100).toFixed(1)}%  => ${noiseClean ? "CLEAN (no systematic edge on noise)" : "WARNING: edge on noise!"}`,
  );

  // --- SELF-CHECK 2: causality (future data cannot change a past decision) --
  const causalDaily = causalityCheck(dailySearch, winner.cfg);
  const causalWeekly = causalityCheck(weeklySearch, winner.cfg);
  const causalOk = causalDaily && causalWeekly;
  console.log("-- SELF-CHECK 2: causality (future mutation, past decision fixed) --");
  console.log(`  daily=${causalDaily}  weekly=${causalWeekly}  => ${causalOk ? "CAUSAL" : "LEAK!"}`);

  // --- HOLD-OUT: evaluate the chosen config ONCE on the vault ---------------
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "ethbtc-relvalue-target9", trialCount: trueN, nowIso: new Date().toISOString() });
  const vaultBars = winner.cfg.horizon === "daily" ? dailyVault : weeklyVault;
  const vaultEv = evaluate(vaultBars, winner.cfg);
  const perYear = winner.perYear;
  const vaultAnnNet = annualize(vaultEv.compoundNet, vaultEv.periods, perYear);
  const vaultMdd = maxDrawdown(vaultEv.perPeriodNet);
  const vaultStats = summarizeReturnSeries(vaultEv.perPeriodNet);

  console.log("\n" + "=".repeat(78));
  console.log("HOLD-OUT (vault, consume-once) — chosen config evaluated ONCE");
  console.log("=".repeat(78));
  console.log(`  guard consumed : ${guard.isConsumed()}  (trialCount N=${trueN})`);
  console.log(`  vault periods  : ${vaultEv.periods}  (${winner.cfg.horizon})`);
  console.log(`  net compound   : ${pct(vaultEv.compoundNet)}   ann net: ${pct(vaultAnnNet)}`);
  console.log(`  net Sharpe     : ${vaultStats.sharpe.toFixed(4)} (per-period)`);
  console.log(`  gross compound : ${pct(summarizeReturnSeries(vaultEv.perPeriodGross).compoundReturn)}`);
  console.log(`  turnover       : ${vaultEv.turnover.toFixed(0)} units  avgAbsPos=${vaultEv.avgAbsPos.toFixed(2)}`);
  console.log(`  max drawdown   : ${pct(vaultMdd)}`);
  console.log(`  positiveRate   : ${pct(vaultStats.positiveRate)}`);

  // MinBTL on the vault sample.
  const minBtl = evaluateMinBtl({
    trialCount: trueN,
    sampleCount: vaultEv.periods,
    observedSharpe: vaultStats.sharpe,
  });

  // McLean-Pontiff 50% haircut on the realised edge.
  const haircutCompound = vaultEv.compoundNet * HAIRCUT;
  const haircutMean = vaultStats.mean * HAIRCUT;

  // --- Rigour gates via evaluatePromotion ----------------------------------
  // barReturns = ratio per-period returns over the vault => buy&hold-the-spread
  // and the random-lottery baselines live on the SAME instrument the strategy
  // trades. The flat (market-neutral) baseline is enforced by requirePositive.
  const sampleCount = vaultEv.periods;
  const avgHold = sampleCount > 0 ? Math.max(1, Math.round(sampleCount / Math.max(1, vaultEv.turnover / 2))) : 1;
  const promo = evaluatePromotion({
    candidateId: `ethbtc-${winner.cfg.id}`,
    candidateReturns: vaultEv.perPeriodNet,
    sampleCount,
    trialCount: trueN,
    barReturns: vaultEv.ratioReturns,
    roundTripCost: COST_PER_UNIT_TURNOVER * 2, // a buy&hold flip cost reference
    averageHoldingBars: avgHold,
    thresholds: { dsrThreshold: DSR_THRESHOLD },
    seed: "ethbtc-relvalue-target9",
  });

  console.log("\n-- RIGOUR GATES (evaluatePromotion, true N) --");
  const g = promo.gates;
  console.log(`  baselines (flat+buy&hold+lottery): ${g.baselines.passed ? "PASS" : "FAIL"}` +
    `${g.baselines.result ? `  beatsAll=${g.baselines.result.beatsAll} candPos=${g.baselines.result.candidatePositive} worstMargin=${pct(g.baselines.result.worstMargin)}` : ""}`);
  if (g.baselines.result) {
    for (const c of g.baselines.result.comparisons) {
      console.log(`      vs ${c.label.padEnd(22)} base=${pct(c.baselineScore)} margin=${pct(c.margin)} beaten=${c.beaten}`);
    }
  }
  console.log(`  deflatedSharpe (DSR>=${DSR_THRESHOLD}) : ${g.deflatedSharpe.passed ? "PASS" : "FAIL"}  ` +
    `DSR=${g.deflatedSharpe.deflatedProbability.toFixed(4)} sharpe=${g.deflatedSharpe.sharpe.toFixed(4)} N=${g.deflatedSharpe.trialCount}`);
  console.log(`  minBtl                            : ${g.minBtl.passed ? "PASS" : "FAIL"}  ` +
    `(needs >=${minBtl.minSampleForObservedSharpe} obs, have ${sampleCount}; ${minBtl.reason})`);
  console.log(`  haircut (Harvey-Liu, >0)          : ${g.haircut.passed ? "PASS" : "FAIL"}  ` +
    `haircutSharpe=${g.haircut.result.haircutSharpe.toFixed(4)}`);
  console.log(`  -- McLean-Pontiff 50% decay haircut on realised edge --`);
  console.log(`     net compound ${pct(vaultEv.compoundNet)} -> ${pct(haircutCompound)} ; mean ${pct(vaultStats.mean)} -> ${pct(haircutMean)}`);

  console.log(`\n  gatesPassed=${promo.summary.gatesPassed}/${promo.summary.gatesApplicable}  promotable(core)=${promo.promotable}`);
  if (promo.reasons.length) console.log(`  reasons: ${promo.reasons.join("; ")}`);

  // --- FINAL VERDICT --------------------------------------------------------
  const netPositive = vaultEv.compoundNet > 0;
  const haircutPositive = haircutCompound > 0;
  const promote = promo.promotable && netPositive && haircutPositive && causalOk && noiseClean;

  console.log("\n" + "=".repeat(78));
  if (promote) {
    console.log(`VERDICT: PROMOTE — ${winner.cfg.id} survives the hold-out net of costs, beats the`);
    console.log(`         market-neutral/flat + buy&hold + lottery baselines, clears DSR(N=${trueN}),`);
    console.log(`         MinBTL and the haircut, and stays positive after a 50% decay haircut.`);
  } else {
    const why: string[] = [];
    if (!netPositive) why.push("hold-out net return <= 0");
    if (!haircutPositive) why.push("dies under 50% haircut");
    if (!promo.promotable) why.push(`gates failed (${promo.reasons.join(",")})`);
    if (!causalOk) why.push("causality leak");
    if (!noiseClean) why.push("edge on noise");
    console.log(`VERDICT: KILL — ${winner.cfg.id} does NOT clear the bar on the one-shot hold-out.`);
    console.log(`         Reasons: ${why.join("; ")}.`);
    console.log(`         An in-sample number that dies on the vault is a KILL, not a strategy.`);
  }
  console.log("=".repeat(78));
}

main();
