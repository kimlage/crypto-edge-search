/**
 * audit-funding-contrarian.ts — TARGET 7 verdict (read-only over output/funding/,
 * reuses the Track-A pure cores; no BigQuery, no training, no shared-file edits).
 *
 * HYPOTHESIS (DIRECTIONAL, microstructure — distinct from E2 delta-neutral carry):
 *   Extreme positive funding = crowded longs -> SHORT the perp.
 *   Extreme negative funding = crowded shorts -> LONG the perp.
 * The signal is a CONTRARIAN bet on the price direction, derived from how
 * stretched the funding rate is relative to its own recent history.
 *
 * CAUSALITY: the position taken for day t's perp return is decided using ONLY
 * funding observed strictly before day t (a rolling z-score on funding through
 * day t-1). Each day's realized return = position(t) * perpReturn(t) - cost when
 * the position changes. Returns are pooled across the 8 majors (equal weight on
 * whichever symbols are in-position that day) into one daily net-return series.
 *
 * COST: 16 bps round-trip perp TAKER (8 bps/side). Funding implies an 8h cadence
 * but we rebalance DAILY (positions persist when the signal is unchanged), so cost
 * is charged only on the fraction of days the net position flips. Turnover logged.
 *
 * METHOD (identical to the other targets, for comparability):
 *   1) Rule is transparent + causal. Cost charged on every position change.
 *   2) Self-checks (run with --selfcheck): a PURE-NOISE funding mutation must
 *      show no edge; a FUTURE-DATA mutation must not change an earlier decision.
 *   3) Single best config picked on the SEARCH slice only; TRUE N recorded.
 *   4) Most-recent ~24 months reserved as a one-shot hold-out (consume-once).
 *   5) Chosen config evaluated ONCE on the vault via evaluatePromotion, then a
 *      50% McLean-Pontiff decay haircut. PROMOTE only if, on the hold-out:
 *      net positive, beats buy&hold + random-lottery baselines, DSR(true N)>=0.95,
 *      MinBTL ok, haircut > 0.
 *
 * Usage:
 *   tsx scripts/audit-funding-contrarian.ts [--cost 0.0016] [--selfcheck]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../src/lib/statistical-validation";
import { evaluateMinBtl } from "../src/lib/significance/trial-count";
import { haircutSharpe } from "../src/lib/significance/haircut";
import {
  planHoldoutSplit,
  FinalHoldoutGuard,
} from "../src/lib/significance/holdout";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";

const OUT_DIR = join("output", "funding");
const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
];

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
function pct(v: number): string {
  return `${(v * 100).toFixed(3)}%`;
}

interface PriceRow {
  date: string;
  spotClose: number;
  perpClose: number;
}
interface FundingRow {
  fundingTime: number;
  fundingRate: number;
}

function loadFunding(symbol: string): FundingRow[] {
  const path = join(OUT_DIR, `${symbol}_funding_8h.json`);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as FundingRow[];
  return raw
    .filter((r) => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
}
function loadPrices(symbol: string): PriceRow[] {
  const path = join(OUT_DIR, `${symbol}_prices_daily.json`);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as PriceRow[];
}

/** UTC date string (YYYY-MM-DD) for a funding settlement timestamp. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Per-symbol daily series aligned by date: the summed funding rate observed that
 * UTC day (the 3 settlements) and the perp close-to-close return realized that day.
 * dailyFunding[i] is fully observed by the END of day i; perpReturn[i] is the
 * return EARNED across day i (perpClose[i]/perpClose[i-1]-1).
 */
interface SymbolSeries {
  symbol: string;
  dates: string[];
  dailyFunding: number[]; // sum of that day's funding settlements
  perpReturn: number[]; // close-to-close perp return realized on that day (NaN for day 0)
}

function buildSymbolSeries(symbol: string): SymbolSeries | null {
  const funding = loadFunding(symbol);
  const prices = loadPrices(symbol);
  if (funding.length === 0 || prices.length < 2) return null;

  // Sum funding settlements onto their UTC date.
  const fundingByDate = new Map<string, number>();
  for (const f of funding) {
    const d = utcDate(f.fundingTime);
    fundingByDate.set(d, (fundingByDate.get(d) ?? 0) + f.fundingRate);
  }

  const dates: string[] = [];
  const dailyFunding: number[] = [];
  const perpReturn: number[] = [];
  for (let i = 0; i < prices.length; i += 1) {
    const p = prices[i]!;
    dates.push(p.date);
    dailyFunding.push(fundingByDate.get(p.date) ?? 0);
    if (i === 0) {
      perpReturn.push(NaN);
    } else {
      const prev = prices[i - 1]!.perpClose;
      perpReturn.push(prev > 0 ? p.perpClose / prev - 1 : NaN);
    }
  }
  return { symbol, dates, dailyFunding, perpReturn };
}

interface ContrarianConfig {
  /** Rolling lookback (days) for the funding z-score baseline. */
  lookback: number;
  /** |z| above which funding is "extreme" -> take the contrarian position. */
  zThreshold: number;
}

/**
 * The strategy state for ONE symbol over a date-index range [from, to).
 * positionForDay[t] is the contrarian position HELD during day t (so it earns
 * perpReturn[t]); it is decided from funding z-score computed on days < t.
 * Returns the per-day {symbol-contribution, positionChanged} so the pooled
 * portfolio can equal-weight across symbols in-position and charge cost on flips.
 */
function runSymbolContrarian(
  s: SymbolSeries,
  cfg: ContrarianConfig,
  from: number,
  to: number,
): { position: number[]; perpReturn: number[]; changed: boolean[] } {
  const n = s.dates.length;
  const position = new Array<number>(n).fill(0);
  const changed = new Array<boolean>(n).fill(false);

  let prevPos = 0;
  for (let t = 0; t < n; t += 1) {
    // Decide position for day t using ONLY funding strictly before day t:
    // baseline window = funding[t-lookback .. t-1].
    let pos = 0;
    if (t >= cfg.lookback) {
      const window = s.dailyFunding.slice(t - cfg.lookback, t); // ends at t-1
      const mean = avg(window);
      const sd = std(window, mean);
      const latest = s.dailyFunding[t - 1]!; // most recent fully-observed funding
      if (sd > 1e-12) {
        const z = (latest - mean) / sd;
        if (z >= cfg.zThreshold) pos = -1; // crowded longs -> short
        else if (z <= -cfg.zThreshold) pos = +1; // crowded shorts -> long
      }
    }
    position[t] = pos;
    changed[t] = pos !== prevPos;
    prevPos = pos;
  }
  return { position, perpReturn: s.perpReturn, changed };
}

/**
 * Pool the per-symbol contrarian signals into ONE daily net-return series over
 * [from, to). Each day, capital is split equally across whichever symbols are
 * in-position; cost (round-trip) is charged on a symbol whenever its net position
 * flips, amortized by that symbol's weight that day. Returns the daily net series
 * plus turnover diagnostics. Causal: position[t] uses only funding < t.
 */
function pooledDailyReturns(
  series: SymbolSeries[],
  cfg: ContrarianConfig,
  from: number,
  to: number,
  cost: number,
): { daily: number[]; turnover: number; daysInPosition: number; totalDays: number } {
  const runs = series.map((s) => ({ s, r: runSymbolContrarian(s, cfg, from, to) }));
  const daily: number[] = [];
  let flips = 0;
  let symbolDayCount = 0;
  let daysInPosition = 0;
  let totalDays = 0;

  for (let t = from; t < to; t += 1) {
    totalDays += 1;
    // Active symbols this day = those with a non-zero position AND a finite return.
    const active = runs.filter(
      ({ r }) => r.position[t] !== 0 && Number.isFinite(r.perpReturn[t]!),
    );
    if (active.length === 0) {
      daily.push(0);
      continue;
    }
    daysInPosition += 1;
    const w = 1 / active.length;
    let dayRet = 0;
    for (const { r } of active) {
      symbolDayCount += 1;
      let ret = r.position[t]! * r.perpReturn[t]!;
      if (r.changed[t]) {
        ret -= cost; // round-trip cost charged on the flip for this symbol
        flips += 1;
      }
      dayRet += w * ret;
    }
    daily.push(dayRet);
  }
  // Turnover = symbol-flips per symbol-day in-position (fraction of legs that traded).
  const turnover = symbolDayCount > 0 ? flips / symbolDayCount : 0;
  return { daily, turnover, daysInPosition, totalDays };
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function std(xs: number[], mean: number): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

const ANNUAL_DAYS = 365.25;
function annualizedReturn(daily: number[]): number {
  // Compound the daily net returns, annualize by calendar days.
  let eq = 1;
  for (const r of daily) eq *= 1 + r;
  const years = daily.length / ANNUAL_DAYS;
  return years > 0 ? eq ** (1 / years) - 1 : 0;
}
function maxDrawdown(daily: number[]): number {
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of daily) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (eq - peak) / peak : 0;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

// ---------------------------------------------------------------------------
// Self-checks (no-hallucination + causality), run with --selfcheck.
// ---------------------------------------------------------------------------
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

function selfChecks(series: SymbolSeries[], cfg: ContrarianConfig, cost: number): void {
  console.log("\n" + "-".repeat(78));
  console.log("SELF-CHECKS");
  console.log("-".repeat(78));

  // (1) NO-HALLUCINATION: replace funding with pure noise (shuffled gaussian),
  // keep real prices. A genuine signal-from-funding must collapse to ~0 edge.
  const rnd = mulberry32(42);
  const noiseSeries: SymbolSeries[] = series.map((s) => ({
    ...s,
    dailyFunding: s.dailyFunding.map(() => {
      // Box-Muller standard normal scaled to a typical daily-funding magnitude.
      const u1 = Math.max(1e-9, rnd());
      const u2 = rnd();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 3e-4;
    }),
  }));
  const n = series[0]!.dates.length;
  const real = pooledDailyReturns(series, cfg, 0, n, cost);
  const noise = pooledDailyReturns(noiseSeries, cfg, 0, n, cost);
  const realStats = summarizeReturnSeries(real.daily);
  const noiseStats = summarizeReturnSeries(noise.daily);
  console.log(
    `(1) no-hallucination: REAL funding daily Sharpe=${realStats.sharpe.toFixed(4)} ` +
      `mean=${pct(realStats.mean)}  vs  PURE-NOISE funding Sharpe=${noiseStats.sharpe.toFixed(4)} ` +
      `mean=${pct(noiseStats.mean)}`,
  );
  const noiseFlat = Math.abs(noiseStats.sharpe) < 0.05;
  console.log(
    `    -> pure-noise edge ~flat (|Sharpe|<0.05): ${noiseFlat ? "PASS" : "WARN"} ` +
      `(noise should carry no directional edge)`,
  );

  // (2) CAUSALITY: mutate FUTURE funding (last 30% of days) and confirm an EARLY
  // decision (a position deep in the first half) is unchanged.
  const cutIdx = Math.floor(n * 0.7);
  const probe = Math.floor(n * 0.4); // an early day to inspect
  const baseRun = runSymbolContrarian(series[0]!, cfg, 0, n);
  const mutated: SymbolSeries = {
    ...series[0]!,
    dailyFunding: series[0]!.dailyFunding.map((v, i) =>
      i >= cutIdx ? v + 99 /* absurd future shock */ : v,
    ),
  };
  const mutRun = runSymbolContrarian(mutated, cfg, 0, n);
  const earlyUnchanged = baseRun.position[probe] === mutRun.position[probe];
  console.log(
    `(2) causality: future funding (days>=${cutIdx}) mutated by +99; early day ${probe} ` +
      `position ${baseRun.position[probe]} -> ${mutRun.position[probe]}: ` +
      `${earlyUnchanged ? "UNCHANGED (PASS)" : "CHANGED (FAIL)"}`,
  );
  console.log("-".repeat(78) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const cost = Number(arg("--cost", "0.0016")); // 16 bps round-trip perp taker
  console.log("=".repeat(78));
  console.log("TARGET 7 — FUNDING AS A CONTRARIAN DIRECTIONAL PREDICTOR (microstructure)");
  console.log("=".repeat(78));
  console.log(`data    : output/funding/ (real Binance, 8 majors, 2023-06 -> 2026-05)`);
  console.log(`rule    : rolling funding z-score; |z|>=thr -> contrarian perp position`);
  console.log(`cost    : ${pct(cost)} round-trip (16 bps perp taker, 8 bps/side)`);

  const series = SYMBOLS.map(buildSymbolSeries).filter(
    (s): s is SymbolSeries => s !== null,
  );
  if (series.length === 0) {
    console.log("\nINSUFFICIENT DATA: no symbol series could be built.");
    return;
  }
  // All symbols share the same date grid (verified: 1096 daily rows each).
  const n = series[0]!.dates.length;
  const aligned = series.every((s) => s.dates.length === n);
  console.log(
    `symbols : ${series.map((s) => s.symbol).join(", ")}  (n=${n} daily rows, aligned=${aligned})`,
  );

  // --- Hold-out split: reserve the most-recent ~24 months as a one-shot vault.
  // 1096 days ≈ 36 months; we want ~24 months in the vault -> holdoutFraction ≈ 0.667.
  // We fold planHoldoutSplit's `test` block back into the SEARCH slice (we never
  // peek at the vault during selection), so search = oldest ~12 months.
  const HOLDOUT_FRACTION = 24 / 36;
  const plan = planHoldoutSplit({
    totalRows: n,
    holdoutFraction: HOLDOUT_FRACTION,
    testFraction: 0,
  });
  const searchFrom = plan.search.start;
  const searchTo = plan.search.end; // search slice [0, searchTo)
  const vaultFrom = plan.finalHoldout.start;
  const vaultTo = plan.finalHoldout.end;
  console.log(
    `\nhold-out: search=[${searchFrom},${searchTo}) (${series[0]!.dates[searchFrom]}..${series[0]!.dates[searchTo - 1]}), ` +
      `VAULT=[${vaultFrom},${vaultTo}) (${series[0]!.dates[vaultFrom]}..${series[0]!.dates[vaultTo - 1]}, ${vaultTo - vaultFrom} days)`,
  );

  if (hasFlag("--selfcheck")) {
    selfChecks(series, { lookback: 30, zThreshold: 1.5 }, cost);
  }

  // --- SEARCH: pick the single best config on the search slice ONLY. ---------
  const lookbacks = [14, 21, 30, 45, 60];
  const zThresholds = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
  const configs: ContrarianConfig[] = [];
  for (const lb of lookbacks) for (const z of zThresholds) configs.push({ lookback: lb, zThreshold: z });
  const TRUE_N = configs.length; // every config is a distinct trial

  let best: { cfg: ContrarianConfig; sharpe: number; apr: number; daily: number[]; turnover: number; daysInPos: number } | null = null;
  console.log(`\n-- SEARCH slice (config grid, TRUE N=${TRUE_N}) --`);
  for (const cfg of configs) {
    const res = pooledDailyReturns(series, cfg, searchFrom, searchTo, cost);
    const stats = summarizeReturnSeries(res.daily);
    const apr = annualizedReturn(res.daily);
    if (best === null || stats.sharpe > best.sharpe) {
      best = {
        cfg,
        sharpe: stats.sharpe,
        apr,
        daily: res.daily,
        turnover: res.turnover,
        daysInPos: res.daysInPosition,
      };
    }
  }
  const chosen = best!;
  console.log(
    `  best config: lookback=${chosen.cfg.lookback} zThr=${chosen.cfg.zThreshold}  ` +
      `search Sharpe=${chosen.sharpe.toFixed(4)} APR=${pct(chosen.apr)} ` +
      `daysInPos=${chosen.daysInPos} turnover=${chosen.turnover.toFixed(3)}`,
  );

  // --- HOLD-OUT: evaluate the CHOSEN config ONCE on the vault. ---------------
  const guard = new FinalHoldoutGuard();
  guard.consume({
    reason: "target7-funding-contrarian-final-verdict",
    trialCount: TRUE_N,
    nowIso: new Date().toISOString(),
  });
  const vault = pooledDailyReturns(series, chosen.cfg, vaultFrom, vaultTo, cost);
  const vaultStats = summarizeReturnSeries(vault.daily);
  const vaultApr = annualizedReturn(vault.daily);
  const vaultMdd = maxDrawdown(vault.daily);

  // Buy & hold benchmark over the vault = equal-weight long perp across symbols.
  const bhDaily: number[] = [];
  for (let t = vaultFrom; t < vaultTo; t += 1) {
    const rets = series.map((s) => s.perpReturn[t]!).filter((r) => Number.isFinite(r));
    bhDaily.push(rets.length > 0 ? avg(rets) : 0);
  }
  const bhStats = summarizeReturnSeries(bhDaily);
  const bhApr = annualizedReturn(bhDaily);

  console.log(`\n-- HOLD-OUT (vault, consume-once: ${guard.isConsumed()}) --`);
  console.log(
    `  candidate : Sharpe=${vaultStats.sharpe.toFixed(4)} mean=${pct(vaultStats.mean)} ` +
      `APR=${pct(vaultApr)} maxDD=${pct(vaultMdd)} posRate=${pct(vaultStats.positiveRate)} ` +
      `daysInPos=${vault.daysInPosition}/${vault.totalDays} turnover=${vault.turnover.toFixed(3)}`,
  );
  console.log(
    `  buy&hold  : Sharpe=${bhStats.sharpe.toFixed(4)} APR=${pct(bhApr)} (equal-weight long perp)`,
  );

  // --- Rigor gates via evaluatePromotion (true N, baselines, DSR, MinBTL). ----
  // Per-day bar returns for the buy&hold/random-lottery baselines = the vault's
  // equal-weight perp returns. Candidate returns = the vault daily net series.
  const promotion = evaluatePromotion({
    candidateId: `funding-contrarian-lb${chosen.cfg.lookback}-z${chosen.cfg.zThreshold}`,
    candidateReturns: vault.daily,
    sampleCount: vault.daily.length,
    trialCount: TRUE_N,
    barReturns: bhDaily,
    roundTripCost: cost,
    averageHoldingBars: vault.turnover > 0 ? Math.max(1, Math.round(1 / vault.turnover)) : 5,
    seed: "target7-funding-contrarian",
  });

  // --- 50% McLean-Pontiff decay haircut on the OOS mean. ---------------------
  const haircutMean = vaultStats.mean * 0.5;
  const haircutApr = ((1 + haircutMean) ** ANNUAL_DAYS) - 1;
  // Harvey-Liu multiple-testing haircut on the Sharpe (reuse the committed core).
  const hl = haircutSharpe({
    observedSharpe: vaultStats.sharpe,
    sampleCount: vault.daily.length,
    trialCount: TRUE_N,
    method: "bonferroni",
  });
  const dsr = computeDeflatedSharpeRatio(vault.daily, { trialCount: TRUE_N });
  const minBtl = evaluateMinBtl({
    trialCount: TRUE_N,
    sampleCount: vault.daily.length,
    observedSharpe: vaultStats.sharpe,
  });

  console.log("\n-- RIGOR GATES (hold-out, true N) --");
  console.log(`  TRUE N (configs tried)        : ${TRUE_N}`);
  console.log(
    `  baselines beatsAll            : ${promotion.gates.baselines.result?.beatsAll ?? "n/a"} ` +
      `(candidate net-positive=${vaultStats.compoundReturn > 0})`,
  );
  console.log(
    `  DSR(true N)                   : ${dsr.deflatedProbability.toFixed(4)} ` +
      `(need >=0.95) -> ${dsr.deflatedProbability >= 0.95 ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  MinBTL sufficientLength       : ${minBtl.sufficientLength} (${minBtl.reason}; ` +
      `needs >=${minBtl.minSampleForObservedSharpe} obs, have ${vault.daily.length})`,
  );
  console.log(
    `  Harvey-Liu haircut Sharpe     : ${hl.haircutSharpe.toFixed(4)} -> ${hl.haircutSharpe > 0 ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  McLean-Pontiff 50% haircut    : mean ${pct(vaultStats.mean)} -> ${pct(haircutMean)} ` +
      `(APR ${pct(vaultApr)} -> ${pct(haircutApr)}) -> ${haircutMean > 0 ? "PASS" : "FAIL"}`,
  );
  console.log(`  evaluatePromotion.promotable  : ${promotion.promotable}`);
  console.log(`  evaluatePromotion.reasons     : ${promotion.reasons.join(", ") || "(none)"}`);

  // --- VERDICT ---------------------------------------------------------------
  const netPositive = vaultStats.compoundReturn > 0;
  const beatsBaselines = promotion.gates.baselines.result?.beatsAll ?? false;
  const dsrPass = dsr.deflatedProbability >= 0.95;
  const minBtlPass = minBtl.sufficientLength;
  const haircutPass = haircutMean > 0 && hl.haircutSharpe > 0;
  const promote =
    netPositive && beatsBaselines && dsrPass && minBtlPass && haircutPass && promotion.promotable;

  console.log("\n" + "=".repeat(78));
  if (promote) {
    console.log(
      `VERDICT: PROMOTE. On the untouched ${vault.daily.length}-day hold-out the contrarian funding\n` +
        `         signal is net-positive (${pct(vaultApr)} APR), beats buy&hold + lottery, clears\n` +
        `         DSR(N=${TRUE_N})>=0.95, MinBTL and survives the 50% decay haircut.`,
    );
  } else {
    const fails: string[] = [];
    if (!netPositive) fails.push("net return <=0");
    if (!beatsBaselines) fails.push("does not beat baselines");
    if (!dsrPass) fails.push(`DSR ${dsr.deflatedProbability.toFixed(3)}<0.95`);
    if (!minBtlPass) fails.push(`MinBTL ${minBtl.reason}`);
    if (!haircutPass) fails.push("haircut non-positive");
    console.log(
      `VERDICT: KILL. The in-search pick does NOT survive the one-shot hold-out.\n` +
        `         Failing: ${fails.join("; ")}.\n` +
        `         An in-sample number that dies on the vault is a KILL, not a strategy.`,
    );
  }
  console.log("=".repeat(78));

  // Machine-readable tail for the orchestrator.
  console.log("\nRESULT_JSON " + JSON.stringify({
    target: "funding-contrarian-directional",
    trueN: TRUE_N,
    chosen: chosen.cfg,
    searchSharpe: Number(chosen.sharpe.toFixed(4)),
    vaultDays: vault.daily.length,
    vaultSharpe: Number(vaultStats.sharpe.toFixed(4)),
    vaultApr: Number(vaultApr.toFixed(4)),
    vaultMaxDD: Number(vaultMdd.toFixed(4)),
    vaultMeanDaily: Number(vaultStats.mean.toFixed(6)),
    vaultCompound: Number(vaultStats.compoundReturn.toFixed(4)),
    buyHoldApr: Number(bhApr.toFixed(4)),
    turnover: Number(vault.turnover.toFixed(4)),
    dsr: Number(dsr.deflatedProbability.toFixed(4)),
    minBtlPass,
    haircutSharpe: Number(hl.haircutSharpe.toFixed(4)),
    haircutMeanDaily: Number(haircutMean.toFixed(6)),
    beatsBaselines,
    promotable: promotion.promotable,
    promote,
    ranOnRealData: true,
  }));
}

main();
