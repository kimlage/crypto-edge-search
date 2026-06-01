/**
 * TARGET 5 — REGIME-GATED TREND on BTC (read-only audit, reuses committed cores).
 *
 * HYPOTHESIS: a plain MA-crossover trend rule on BTC daily loses money net of costs
 * because it whipsaws in choppy / unfavorable regimes. If we keep the SAME entries
 * but only let them ACT in favorable regimes — via two causal gates:
 *   (1) classifyRegimes() (reorientation/regime.ts): only trade certain trend×vol
 *       regimes (e.g. up/high-vol = strong-trend), and
 *   (2) buildHigherTimeframeBias()+higherTimeframeGate() (reorientation/multi-timeframe.ts):
 *       only take a long when the most-recent COMPLETED weekly bar was up —
 * then the whipsaw periods are cut and the survivors clear the cost hurdle.
 *
 * INSTRUMENT: BTCUSDT spot, DAILY bars aggregated CAUSALLY from the committed 15m
 * history (output/bigquery/btc_ohlcv_15m.ndjson, real Binance 2017-08..2026-05).
 * A daily bar's close = the last 15m close within that UTC day; we only ever read
 * completed days. The signal at day t uses MAs computed on closes <= t-1, so the
 * decision for day t's return is fixed before day t opens. Gates likewise use only
 * completed regime labels / completed weekly bars (<= t-1).
 *
 * COST: 28 bps round-trip (spot BTC default in this repo). Charged on every change
 * of position (flat<->long), so turnover is logged and paid.
 *
 * METHOD (identical to the other targets, for comparability):
 *  1) Rule implemented transparently & causally; turnover logged; cost charged.
 *  2) Self-checks via tsx: PURE-NOISE data must show ~no edge; a future-data
 *     mutation must not change an earlier day's decision (causality).
 *  3) Single best config chosen on the SEARCH slice only; TRUE N = configs tried.
 *  4) Most-recent ~24 months reserved as a one-shot hold-out (planHoldoutSplit +
 *     FinalHoldoutGuard consume-once). Chosen config evaluated ONCE on the vault
 *     through evaluatePromotion.
 *  5) 50% McLean-Pontiff decay haircut. PROMOTE only if, on the hold-out: net>0,
 *     beats buy&hold + random-lottery, DSR(true N)>=0.95, MinBTL ok, haircut>0.
 *
 * Writes nothing; edits no shared files. Pure reuse of the rigor cores.
 *
 * Run:
 *   
 *     node_modules/.bin/tsx scripts/audit-regime-gated-trend.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyRegimes,
  type RegimeLabel,
} from "../src/lib/reorientation/regime";
import {
  buildHigherTimeframeBias,
  type Bias,
} from "../src/lib/reorientation/multi-timeframe";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
} from "../src/lib/statistical-validation";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";
import { planHoldoutSplit, FinalHoldoutGuard } from "../src/lib/significance/holdout";

// ----------------------------- constants -----------------------------------
const ROUND_TRIP_COST = 0.0028; // 28 bps spot BTC round trip
const DSR_THRESHOLD = 0.95;
const MCLEAN_PONTIFF_HAIRCUT = 0.5; // halve the in-sample edge for the live expectation
const BARS_PER_WEEK = 7; // daily -> weekly higher-TF gate (7 completed days per week bar)

// ----------------------------- data load -----------------------------------
interface DailyBar {
  dateIso: string;
  close: number;
}

/**
 * Aggregate the 15m ndjson into causal UTC-daily closes. A day's close is the last
 * 15m close inside that day; we drop the final (possibly partial) day so every bar
 * used is a fully-completed day.
 */
function loadDailyCloses(): DailyBar[] {
  const path = join("output", "bigquery", "btc_ohlcv_15m.ndjson");
  const text = readFileSync(path, "utf8");
  const lastCloseByDay = new Map<string, { close: number; eventTime: string }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as Record<string, unknown>;
    const close = typeof obj.close === "number" ? obj.close : Number(obj.close);
    const eventDate = String(obj.event_date ?? "");
    const eventTime = String(obj.event_time ?? "");
    if (!Number.isFinite(close) || close <= 0 || !eventDate) continue;
    const prev = lastCloseByDay.get(eventDate);
    if (!prev || eventTime > prev.eventTime) {
      lastCloseByDay.set(eventDate, { close, eventTime });
    }
  }
  const days = [...lastCloseByDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dateIso, v]) => ({ dateIso, close: v.close }));
  // Drop the last day (may be partial — its 15m bars may not span the full day).
  return days.slice(0, -1);
}

function closesToReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    out.push(prev > 0 ? (closes[i]! - prev) / prev : 0);
  }
  return out;
}

// ----------------------------- the rule -------------------------------------
type AllowedRegimeSet = "trend_up" | "up_or_flat_any" | "any";

interface Config {
  fast: number;
  slow: number;
  regimeTrendWindow: number;
  regimeVolWindow: number;
  allowed: AllowedRegimeSet;
  useWeeklyGate: boolean;
}

interface RunResult {
  tradeReturns: number[]; // net per-trade (per holding-episode) returns
  perBarNet: number[]; // net per-day strategy returns (for buy&hold-aligned compare)
  marketReturns: number[]; // aligned buy&hold per-day returns over same window
  trades: number;
  daysInMarket: number;
  totalDays: number;
  grossCompound: number;
  netCompound: number;
}

/** Which combined regime labels are "favorable" for a long trend trade. */
function regimeAllows(label: RegimeLabel, set: AllowedRegimeSet): boolean {
  if (set === "any") return true;
  if (set === "up_or_flat_any") return label.trend === "up" || label.trend === "flat";
  // "trend_up": only an up-trend regime (strong directional persistence).
  return label.trend === "up";
}

/**
 * Run the regime-gated MA-crossover LONG/FLAT rule over a [start,end) slice of the
 * full daily series. Strictly causal:
 *   - position for day t (capturing return r_t = (close_t-close_{t-1})/close_{t-1})
 *     is decided from MAs over closes <= t-1, the regime label at t-1, and the
 *     most-recent COMPLETED weekly bias (bucket of t-1, shifted back one week).
 * Cost charged whenever the position changes (0<->1).
 */
function runRule(
  closes: readonly number[],
  regimeLabels: readonly RegimeLabel[],
  weeklyBias: readonly Bias[],
  cfg: Config,
  sliceStart: number,
  sliceEnd: number,
): RunResult {
  const tradeReturns: number[] = [];
  const perBarNet: number[] = [];
  const marketReturns: number[] = [];
  let trades = 0;
  let daysInMarket = 0;
  let prevPos = 0;
  let openEpisodeLog = 0; // accumulating log return of the current open long episode (net)

  // We iterate over day index t in [sliceStart, sliceEnd). r_t uses close_t/close_{t-1}.
  for (let t = sliceStart; t < sliceEnd; t += 1) {
    if (t < 1) continue;
    const rt = closes[t - 1]! > 0 ? (closes[t]! - closes[t - 1]!) / closes[t - 1]! : 0;

    // --- decide position for day t using only info <= t-1 ---
    const maFast = sma(closes, t - 1, cfg.fast);
    const maSlow = sma(closes, t - 1, cfg.slow);
    let wantLong = maFast !== null && maSlow !== null && maFast > maSlow;

    // regime gate: label at t-1 must be favorable
    if (wantLong) {
      const reg = regimeLabels[t - 1];
      if (!reg || !regimeAllows(reg, cfg.allowed)) wantLong = false;
    }
    // weekly higher-TF gate: most-recent completed weekly bar (at t-1) must be "up"
    if (wantLong && cfg.useWeeklyGate) {
      const b = weeklyBias[t - 1];
      if (b !== "up") wantLong = false;
    }

    const pos = wantLong ? 1 : 0;

    // --- account for the position change cost & per-bar net return ---
    const changedIn = prevPos === 0 && pos === 1;
    const changedOut = prevPos === 1 && pos === 0;
    let dayCost = 0;
    if (changedIn) {
      dayCost += ROUND_TRIP_COST / 2; // entry leg
      trades += 1;
      openEpisodeLog = 0;
    }
    if (changedOut) {
      dayCost += ROUND_TRIP_COST / 2; // exit leg
    }

    const grossDay = pos === 1 ? rt : 0;
    const netDay = grossDay - dayCost;
    perBarNet.push(netDay);
    marketReturns.push(rt);
    if (pos === 1) daysInMarket += 1;

    // accumulate the open long episode (net of legs charged at entry/exit)
    if (pos === 1) {
      openEpisodeLog += Math.log1p(Math.max(-0.999999, grossDay));
      // subtract entry leg cost into the episode P&L at entry day
      if (changedIn) openEpisodeLog += Math.log1p(-ROUND_TRIP_COST / 2);
    }
    if (changedOut) {
      // close the episode: subtract exit leg, push the per-trade net return
      openEpisodeLog += Math.log1p(-ROUND_TRIP_COST / 2);
      tradeReturns.push(Math.expm1(openEpisodeLog));
      openEpisodeLog = 0;
    }

    prevPos = pos;
  }
  // close a still-open episode at the slice end (mark to last close, charge exit leg)
  if (prevPos === 1) {
    openEpisodeLog += Math.log1p(-ROUND_TRIP_COST / 2);
    tradeReturns.push(Math.expm1(openEpisodeLog));
  }

  // net & gross compound over the slice (gross = in-market market move, no costs)
  let netLog = 0;
  let grossLog = 0;
  for (let i = 0; i < perBarNet.length; i += 1) {
    netLog += Math.log1p(Math.max(-0.999999, perBarNet[i]!));
    // gross in-market day move = market return on days we held (cost-free):
    if (marketReturns[i]! !== 0 && perBarNet[i]! !== 0) {
      // perBarNet day is 0 only when out of market (no cost charged that day);
      // approximate gross compound from per-trade gross instead below.
    }
  }
  const netCompound = Math.expm1(netLog);
  // gross compound from the per-trade gross legs (add back the cost we charged):
  for (const tr of tradeReturns) grossLog += Math.log1p(Math.max(-0.999999, tr + ROUND_TRIP_COST));

  return {
    tradeReturns,
    perBarNet,
    marketReturns,
    trades,
    daysInMarket,
    totalDays: perBarNet.length,
    grossCompound: Math.expm1(grossLog),
    netCompound,
  };
}

function sma(values: readonly number[], end: number, window: number): number | null {
  const start = end - window + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= end; i += 1) sum += values[i] ?? 0;
  return sum / window;
}

// ------------------------- scoring helpers ----------------------------------
function compound(returns: readonly number[]): number {
  let log = 0;
  for (const r of returns) log += Math.log1p(Math.max(-0.999999, r));
  return Math.expm1(log);
}

/** Objective for config selection on the SEARCH slice: net compound, requiring >=8 trades. */
function searchScore(run: RunResult): number {
  if (run.trades < 8) return -Infinity;
  return compound(run.perBarNet);
}

// ----------------------------- self checks ----------------------------------
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

function selfCheckPureNoise(cfg: Config): { netCompound: number; trades: number } {
  // Build a pure-noise close series (random walk, zero drift) of similar length.
  const rng = mulberry32(12345);
  const n = 3000;
  const closes: number[] = [100];
  for (let i = 1; i < n; i += 1) {
    const shock = (rng() - 0.5) * 0.04; // ~+-2% daily, zero mean
    closes.push(Math.max(1e-6, closes[i - 1]! * (1 + shock)));
  }
  const rets = closesToReturns(closes);
  const regimes = classifyRegimes(rets, {
    trendWindow: cfg.regimeTrendWindow,
    volWindow: cfg.regimeVolWindow,
  });
  const weekly = buildHigherTimeframeBias(rets, { barsPerHigherBar: BARS_PER_WEEK }).perBaseBar;
  // regimeLabels indexed in returns-space; map to closes-space (offset by 1).
  const regimeByClose: RegimeLabel[] = [{ index: 0, trend: "flat", volatility: "low", label: "flat_low", trendMean: null, vol: null }, ...regimes];
  const weeklyByClose: Bias[] = ["flat", ...weekly];
  const run = runRule(closes, regimeByClose, weeklyByClose, cfg, 1, closes.length);
  return { netCompound: compound(run.perBarNet), trades: run.trades };
}

function selfCheckCausality(
  closes: number[],
  regimeByClose: RegimeLabel[],
  weeklyByClose: Bias[],
  cfg: Config,
): boolean {
  // Decide position for a middle day t with the real series, then MUTATE a FUTURE
  // close (index t+50) and re-derive the position for t. It must be identical.
  const t = Math.floor(closes.length / 2);
  const posBefore = derivePos(closes, regimeByClose, weeklyByClose, cfg, t);
  const mutated = [...closes];
  mutated[t + 50] = mutated[t + 50]! * 5; // huge future shock
  // regimes/weekly are functions of returns; recompute them on the mutated series to be
  // fair, but they too are causal so the t-1 label cannot change.
  const mRets = closesToReturns(mutated);
  const mReg: RegimeLabel[] = [{ index: 0, trend: "flat", volatility: "low", label: "flat_low", trendMean: null, vol: null }, ...classifyRegimes(mRets, { trendWindow: cfg.regimeTrendWindow, volWindow: cfg.regimeVolWindow })];
  const mWeek: Bias[] = ["flat", ...buildHigherTimeframeBias(mRets, { barsPerHigherBar: BARS_PER_WEEK }).perBaseBar];
  const posAfter = derivePos(mutated, mReg, mWeek, cfg, t);
  return posBefore === posAfter;
}

function derivePos(
  closes: readonly number[],
  regimeByClose: readonly RegimeLabel[],
  weeklyByClose: readonly Bias[],
  cfg: Config,
  t: number,
): number {
  const maFast = sma(closes, t - 1, cfg.fast);
  const maSlow = sma(closes, t - 1, cfg.slow);
  let wantLong = maFast !== null && maSlow !== null && maFast > maSlow;
  if (wantLong) {
    const reg = regimeByClose[t - 1];
    if (!reg || !regimeAllows(reg, cfg.allowed)) wantLong = false;
  }
  if (wantLong && cfg.useWeeklyGate) {
    if (weeklyByClose[t - 1] !== "up") wantLong = false;
  }
  return wantLong ? 1 : 0;
}

// ----------------------------- main -----------------------------------------
function main(): void {
  console.log("=".repeat(80));
  console.log("TARGET 5 — REGIME-GATED TREND on BTC daily (real Binance 15m -> daily)");
  console.log("=".repeat(80));

  const bars = loadDailyCloses();
  const closes = bars.map((b) => b.close);
  const returns = closesToReturns(closes);
  console.log(`Daily bars: ${bars.length} (${bars[0]?.dateIso} .. ${bars[bars.length - 1]?.dateIso})`);

  // Precompute causal regime labels and weekly bias over the FULL returns series.
  // Both are strictly causal (label/bias at index i uses only returns <= i), so
  // computing them once over the whole series does NOT leak the holdout into search.
  const regimes = classifyRegimes(returns, { trendWindow: 20, volWindow: 20 });
  // (regimeTrendWindow/volWindow varied per-config below by recomputing.)

  // Map returns-space arrays to closes-space (return r_i corresponds to close index i+1).
  // Pad index 0 with a neutral label / flat bias so arrays line up with `closes`.
  function regimeByCloseFor(cfg: Config): RegimeLabel[] {
    const r = classifyRegimes(returns, {
      trendWindow: cfg.regimeTrendWindow,
      volWindow: cfg.regimeVolWindow,
    });
    return [
      { index: 0, trend: "flat", volatility: "low", label: "flat_low", trendMean: null, vol: null },
      ...r,
    ];
  }
  const weeklyByClose: Bias[] = [
    "flat",
    ...buildHigherTimeframeBias(returns, { barsPerHigherBar: BARS_PER_WEEK }).perBaseBar,
  ];

  // ---- holdout split: most-recent ~24 months as a one-shot vault ----
  // 24 months of daily bars ≈ 730. Express as a fraction of the total.
  const holdoutRowsTarget = 730;
  const holdoutFraction = Math.min(0.4, holdoutRowsTarget / closes.length);
  const plan = planHoldoutSplit({
    totalRows: closes.length,
    holdoutFraction,
    testFraction: 0.0, // no separate posterior audit slice; search vs vault only
  });
  console.log(
    `\nHold-out plan: search=[0,${plan.search.end}) (${plan.search.rows} bars), ` +
      `vault=[${plan.finalHoldout.start},${plan.finalHoldout.end}) (${plan.finalHoldout.rows} bars ≈ ${(plan.finalHoldout.rows / 365).toFixed(2)}y)`,
  );
  console.log(
    `  search window dates: ${bars[0]?.dateIso} .. ${bars[plan.search.end - 1]?.dateIso}`,
  );
  console.log(
    `  vault  window dates: ${bars[plan.finalHoldout.start]?.dateIso} .. ${bars[plan.finalHoldout.end - 1]?.dateIso}`,
  );

  // ---- config grid (TRUE N counted) ----
  const fastSet = [10, 20, 30, 50];
  const slowSet = [50, 100, 150, 200];
  const allowedSet: AllowedRegimeSet[] = ["any", "up_or_flat_any", "trend_up"];
  const weeklyGateSet = [false, true];
  const regimeWindows = [
    { trend: 20, vol: 20 },
    { trend: 40, vol: 40 },
  ];

  const configs: Config[] = [];
  for (const fast of fastSet) {
    for (const slow of slowSet) {
      if (fast >= slow) continue;
      for (const allowed of allowedSet) {
        for (const useWeeklyGate of weeklyGateSet) {
          for (const rw of regimeWindows) {
            configs.push({
              fast,
              slow,
              allowed,
              useWeeklyGate,
              regimeTrendWindow: rw.trend,
              regimeVolWindow: rw.vol,
            });
          }
        }
      }
    }
  }
  const trueN = configs.length;
  console.log(`\nTRUE N = ${trueN} configs (fast×slow×regimeSet×weeklyGate×regimeWindow).`);

  // ---- self checks (use a representative config) ----
  const probe: Config = {
    fast: 20,
    slow: 100,
    allowed: "trend_up",
    useWeeklyGate: true,
    regimeTrendWindow: 20,
    regimeVolWindow: 20,
  };
  // Anti-hallucination: on zero-drift noise the rule must NOT manufacture a positive
  // edge. A trend rule SHOULD bleed to cost/whipsaw on noise (negative is expected &
  // fine); what would be a red flag is a clearly POSITIVE net edge from nothing.
  const noise = selfCheckPureNoise(probe);
  const noiseClean = noise.netCompound <= 0.05; // no spurious positive edge (small slack)
  const probeRegByClose = regimeByCloseFor(probe);
  const causalOk = selfCheckCausality(closes, probeRegByClose, weeklyByClose, probe);
  console.log("\n-- Self-checks --");
  console.log(`  pure-noise net compound (zero-drift RW): ${(noise.netCompound * 100).toFixed(2)}% over ${noise.trades} trades  -> ${noiseClean ? "OK (no spurious POSITIVE edge; bleeds to cost as expected)" : "WARN (positive edge on noise!)"}`);
  console.log(`  causality (future mutation @ t+50 leaves day-t decision unchanged): ${causalOk ? "OK" : "FAIL"}`);
  if (!causalOk) {
    console.log("\nCAUSALITY SELF-CHECK FAILED — aborting (would indicate look-ahead).");
    return;
  }

  // ---- SEARCH: pick the single best config on the search slice only ----
  let best: { cfg: Config; run: RunResult; score: number } | null = null;
  const searchRows: { cfg: Config; score: number; net: number; trades: number }[] = [];
  for (const cfg of configs) {
    const regByClose = regimeByCloseFor(cfg);
    const run = runRule(closes, regByClose, weeklyByClose, cfg, 1, plan.search.end);
    const score = searchScore(run);
    searchRows.push({ cfg, score, net: compound(run.perBarNet), trades: run.trades });
    if (!best || score > best.score) best = { cfg, run, score };
  }
  if (!best || !Number.isFinite(best.score)) {
    console.log("\nNo config produced >=8 trades on the search slice. KILL.");
    return;
  }

  // search-slice buy&hold for context
  const searchMarket = returns.slice(0, plan.search.end - 1);
  const searchBH = compound(searchMarket) - ROUND_TRIP_COST;

  console.log("\n-- SEARCH-slice selection (best by net compound, >=8 trades) --");
  const topRows = [...searchRows].sort((a, b) => b.score - a.score).slice(0, 5);
  for (const row of topRows) {
    console.log(
      `  fast=${row.cfg.fast} slow=${row.cfg.slow} allowed=${row.cfg.allowed} weeklyGate=${row.cfg.useWeeklyGate} regW=${row.cfg.regimeTrendWindow}` +
        `  net=${(row.net * 100).toFixed(1)}% trades=${row.trades}`,
    );
  }
  console.log(`  search buy&hold (net of 1 round trip): ${(searchBH * 100).toFixed(1)}%`);
  console.log("\n  CHOSEN config:");
  console.log(`    fast=${best.cfg.fast} slow=${best.cfg.slow} allowed=${best.cfg.allowed} weeklyGate=${best.cfg.useWeeklyGate} regimeTrendW=${best.cfg.regimeTrendWindow} regimeVolW=${best.cfg.regimeVolWindow}`);
  console.log(`    search net compound=${(compound(best.run.perBarNet) * 100).toFixed(1)}%  trades=${best.run.trades}  daysInMarket=${best.run.daysInMarket}/${best.run.totalDays}`);

  // ---- HOLD-OUT: evaluate the chosen config ONCE on the vault ----
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "target5-regime-gated-trend final verdict", trialCount: trueN, nowIso: new Date().toISOString() });

  const regByCloseBest = regimeByCloseFor(best.cfg);
  const vaultRun = runRule(
    closes,
    regByCloseBest,
    weeklyByClose,
    best.cfg,
    plan.finalHoldout.start,
    plan.finalHoldout.end,
  );

  const vaultNet = compound(vaultRun.perBarNet);
  const vaultMarket = vaultRun.marketReturns; // per-day market over the same window
  const vaultBH = compound(vaultMarket) - ROUND_TRIP_COST;

  console.log("\n" + "=".repeat(80));
  console.log("HOLD-OUT (vault) — chosen config evaluated ONCE");
  console.log("=".repeat(80));
  console.log(`  guard consumed: ${guard.isConsumed()} (trialCount=${guard.status().trialCount})`);
  console.log(`  vault bars                 : ${vaultRun.totalDays}`);
  console.log(`  trades                     : ${vaultRun.trades}`);
  console.log(`  days in market             : ${vaultRun.daysInMarket}/${vaultRun.totalDays} (${((vaultRun.daysInMarket / Math.max(1, vaultRun.totalDays)) * 100).toFixed(1)}% exposure)`);
  console.log(`  turnover (trades/year)     : ${(vaultRun.trades / (vaultRun.totalDays / 365)).toFixed(1)}`);
  console.log(`  NET compound (strategy)    : ${(vaultNet * 100).toFixed(2)}%`);
  console.log(`  buy&hold (net 1 RT)        : ${(vaultBH * 100).toFixed(2)}%`);
  console.log(`  vs buy&hold                : ${vaultNet > vaultBH ? "BEATS" : "loses to"} buy&hold`);

  // per-trade net return series for the gates
  const tradeReturns = vaultRun.tradeReturns;
  const tradeStats = summarizeReturnSeries(tradeReturns);
  console.log(`  per-trade net: n=${tradeStats.sampleCount} mean=${(tradeStats.mean * 100).toFixed(3)}% sharpe(per-trade)=${tradeStats.sharpe.toFixed(3)} winRate=${(tradeStats.positiveRate * 100).toFixed(1)}%`);

  // ---- evaluatePromotion through the full gate stack on the vault ----
  // Use the per-trade net series as the candidate returns; supply vault market
  // per-day returns for buy&hold + random-lottery baselines.
  const promo = evaluatePromotion({
    candidateId: "target5-regime-gated-trend",
    candidateReturns: tradeReturns,
    sampleCount: tradeReturns.length,
    trialCount: trueN,
    barReturns: vaultMarket,
    roundTripCost: ROUND_TRIP_COST,
    averageHoldingBars: Math.max(1, Math.round(vaultRun.daysInMarket / Math.max(1, vaultRun.trades))),
    thresholds: { dsrThreshold: DSR_THRESHOLD },
    seed: "target5-regime-gated-trend",
  });

  const dsr = computeDeflatedSharpeRatio(tradeReturns, { trialCount: trueN });

  console.log("\n-- Promotion gates (evaluatePromotion, true N) --");
  console.log(`  baselines     : applicable=${promo.gates.baselines.applicable} passed=${promo.gates.baselines.passed}` +
    (promo.gates.baselines.result ? ` (beatsAll=${promo.gates.baselines.result.beatsAll}, worstMargin=${(promo.gates.baselines.result.worstMargin * 100).toFixed(2)}% vs ${promo.gates.baselines.result.worstBaselineId})` : ""));
  console.log(`  deflatedSharpe: applicable=${promo.gates.deflatedSharpe.applicable} passed=${promo.gates.deflatedSharpe.passed} DSR=${promo.gates.deflatedSharpe.deflatedProbability.toFixed(4)} (>=${DSR_THRESHOLD}) sharpe=${promo.gates.deflatedSharpe.sharpe.toFixed(3)} N=${promo.gates.deflatedSharpe.trialCount}`);
  console.log(`  minBtl        : applicable=${promo.gates.minBtl.applicable} passed=${promo.gates.minBtl.passed} (${promo.gates.minBtl.result.reason}; need n>=${promo.gates.minBtl.result.minSampleForObservedSharpe}, have ${promo.gates.minBtl.result.sampleCount})`);
  console.log(`  haircut       : applicable=${promo.gates.haircut.applicable} passed=${promo.gates.haircut.passed} haircutSharpe=${promo.gates.haircut.result.haircutSharpe.toFixed(4)}`);
  console.log(`  gatesPassed   : ${promo.summary.gatesPassed}/${promo.summary.gatesApplicable}`);
  console.log(`  reasons       : ${promo.reasons.length ? promo.reasons.join(", ") : "(none)"}`);

  // ---- HYPOTHESIS DIAGNOSTIC (read-only; does NOT change the one-shot verdict) ----
  // The hypothesis is "gating cuts whipsaw". Show, on the vault, how the SAME fast/slow
  // crossover does ungated vs fully-gated. This is descriptive only — the promotable
  // decision above used exactly one config, chosen on the search slice.
  const sameMA = { fast: best.cfg.fast, slow: best.cfg.slow, regimeTrendWindow: best.cfg.regimeTrendWindow, regimeVolWindow: best.cfg.regimeVolWindow };
  const ungated: Config = { ...sameMA, allowed: "any", useWeeklyGate: false };
  const fullyGated: Config = { ...sameMA, allowed: "trend_up", useWeeklyGate: true };
  const ungatedRun = runRule(closes, regimeByCloseFor(ungated), weeklyByClose, ungated, plan.finalHoldout.start, plan.finalHoldout.end);
  const gatedRun = runRule(closes, regimeByCloseFor(fullyGated), weeklyByClose, fullyGated, plan.finalHoldout.start, plan.finalHoldout.end);
  console.log("\n-- Hypothesis diagnostic on the vault (same MA, ungated vs fully-gated) --");
  console.log(`  ungated      : net=${(compound(ungatedRun.perBarNet) * 100).toFixed(2)}% trades=${ungatedRun.trades} exposure=${((ungatedRun.daysInMarket / Math.max(1, ungatedRun.totalDays)) * 100).toFixed(0)}%`);
  console.log(`  fully-gated  : net=${(compound(gatedRun.perBarNet) * 100).toFixed(2)}% trades=${gatedRun.trades} exposure=${((gatedRun.daysInMarket / Math.max(1, gatedRun.totalDays)) * 100).toFixed(0)}%`);
  console.log(`  buy&hold(net): ${(vaultBH * 100).toFixed(2)}%`);
  console.log(`  -> gating ${compound(gatedRun.perBarNet) > compound(ungatedRun.perBarNet) ? "HELPED" : "did NOT help"} on the hold-out; both ${Math.max(compound(gatedRun.perBarNet), compound(ungatedRun.perBarNet)) > vaultBH ? "beat" : "trail"} buy&hold.`);

  // ---- McLean-Pontiff 50% decay haircut on the realized vault edge ----
  const haircutNet = vaultNet * (1 - MCLEAN_PONTIFF_HAIRCUT);
  console.log("\n-- McLean-Pontiff decay haircut (50%) --");
  console.log(`  realized vault net=${(vaultNet * 100).toFixed(2)}%  ->  post-haircut expectation=${(haircutNet * 100).toFixed(2)}%`);

  // ---- VERDICT ----
  const netPositive = vaultNet > 0;
  const beatsBH = vaultNet > vaultBH;
  const dsrOk = dsr.deflatedProbability >= DSR_THRESHOLD;
  const minBtlOk = promo.gates.minBtl.passed;
  const haircutOk = haircutNet > 0;
  const baselinesOk = promo.gates.baselines.applicable && promo.gates.baselines.passed;

  const promote = netPositive && beatsBH && baselinesOk && dsrOk && minBtlOk && haircutOk;

  console.log("\n" + "=".repeat(80));
  console.log("VERDICT");
  console.log("=".repeat(80));
  console.log(`  net positive (vault)     : ${netPositive ? "YES" : "NO"} (${(vaultNet * 100).toFixed(2)}%)`);
  console.log(`  beats buy&hold           : ${beatsBH ? "YES" : "NO"}`);
  console.log(`  beats baselines (BH+lott): ${baselinesOk ? "YES" : "NO"}`);
  console.log(`  DSR(N=${trueN}) >= ${DSR_THRESHOLD}       : ${dsrOk ? "YES" : "NO"} (${dsr.deflatedProbability.toFixed(4)})`);
  console.log(`  MinBTL ok                : ${minBtlOk ? "YES" : "NO"}`);
  console.log(`  haircut > 0              : ${haircutOk ? "YES" : "NO"}`);
  console.log(`\n  >>> ${promote ? "PROMOTE" : "KILL"} <<<`);
  if (!promote) {
    const fails: string[] = [];
    if (!netPositive) fails.push("net<=0 on hold-out");
    if (!beatsBH) fails.push("does not beat buy&hold");
    if (!baselinesOk) fails.push("fails baseline gate");
    if (!dsrOk) fails.push(`DSR ${dsr.deflatedProbability.toFixed(3)}<${DSR_THRESHOLD}`);
    if (!minBtlOk) fails.push("MinBTL insufficient sample");
    if (!haircutOk) fails.push("haircut<=0");
    console.log(`  KILL reasons: ${fails.join("; ")}`);
  }
  console.log("=".repeat(80));
}

main();
