/**
 * FRONT C4 — Event / token-flow forced-flow study (LISTING effect).
 * ============================================================================
 * MECHANISM (event-driven, NOT cyclical): a new Binance USDT-perp LISTING is a
 * KNOWN-calendar forced-flow event. Listing day is day 0; the post-listing days
 * carry predictable transactional pressure (initial allocation unwind, market-
 * maker inventory, retail churn). We test whether that produces a deployable,
 * COST-SURVIVING abnormal-return edge.
 *
 * Why LISTING and not UNLOCK: free historical token-UNLOCK / vesting-cliff data
 * with clean dates is NOT freely available offline (TokenUnlocks / vesting APIs
 * are paid/gated). Listing dates ARE knowable for free: Binance Futures
 * `exchangeInfo` exposes `onboardDate` per symbol, giving 644 cleanly-dated
 * events spanning 2019-2026. So we test the tractable, fully-real LISTING proxy
 * and are explicit that the UNLOCK side is data-limited (see verdict/caveats).
 *
 * EVENT-STUDY MODEL: market-adjusted abnormal return (MacKinlay 1997; Brown &
 * Warner 1985). There is NO pre-event estimation window for a brand-new coin
 * (the listing IS the first data), so beta is fixed at 1 vs BTC — the standard
 * market-adjusted fallback. AR_{i,t} = r_{i,t} - r_{mkt,t}.  CAR over [1..H].
 *
 * TRADEABLE STRATEGY: take a position at day-0 close, hold H days, exit at the
 * day-H close. direction ∈ {short, long}. Net per-event return is the position
 * return minus an 8bps round-trip perp cost (4bps/side taker). ONE position per
 * listing → one net return per event. Turnover is exactly 1 round trip / event.
 *
 * GATES (committed, unmodified): computeDeflatedSharpeRatio (DSR, TRUE N),
 * estimateCscvPbo (CPCV/PBO over event-folds), evaluateBaselineGate
 * (buy&hold-market + equal-weight + random-lottery), haircutSharpe (Harvey-Liu),
 * planHoldoutSplit + FinalHoldoutGuard (consume-once).
 *
 * SURROGATE/PLACEBO (the methodological hero): the IDENTICAL search machinery is
 * re-run on (a) CROSS-SECTIONALLY-SHUFFLED events (each event keeps day-0..H but
 * the path is swapped for a random OTHER coin's listing path — destroys the
 * listing-specific effect, keeps marginals), (b) PHASE/BLOCK-BOOTSTRAP per-coin
 * surrogates (preserves vol & autocorrelation, destroys event timing), and
 * (c) a CALENDAR placebo (random non-listing start dates, identical pipeline).
 * If the machinery finds equal-or-better edge on surrogates → artifact.
 *
 * COST: 8 bps round-trip on EVERY position (mandate). Turnover reported.
 * DATA: 100% real Binance Futures REST (cached). No BigQuery. No training loop.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  evaluateBaselineGate,
  baselineScoreFromReturns,
  buildRandomLotteryBaseline,
  type BaselineScore,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import {
  planHoldoutSplit,
  assertSearchDoesNotTouchHoldout,
  FinalHoldoutGuard,
} from "../../src/lib/significance/holdout";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CACHE = join(ROOT, "output", "front-c4", "cache");
const OUT = join(ROOT, "output", "front-c4");

// ---- cost & gate constants -------------------------------------------------
const TAKER_BPS_PER_SIDE = 4; // 4 bps/side perp taker
const ROUND_TRIP_COST = (2 * TAKER_BPS_PER_SIDE) / 10_000; // 8 bps = 0.0008
const DSR_THRESHOLD = 0.95;
const PBO_THRESHOLD = 0.5;
const HAIRCUT_ALPHA = 0.05;
const HOLD_HORIZONS = [1, 2, 3, 5, 7, 10, 15, 20] as const; // days
const DIRECTIONS = ["short", "long"] as const;
const SURROGATE_REPS = 200;

// ---- types -----------------------------------------------------------------
interface ListingRecord {
  symbol: string;
  status: string;
  onboardDate: string;
  onboardMs: number;
  bars: number[][]; // [openTimeMs, open, high, low, close, volume]
}
interface BtcDaily {
  dates: string[];
  closes: number[];
}

// ---- helpers ---------------------------------------------------------------
function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}
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
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function tStat(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1));
  if (sd <= 1e-12) return 0;
  return m / (sd / Math.sqrt(n));
}

// ---- data loading ----------------------------------------------------------
function loadData(): { listings: ListingRecord[]; btcByDate: Map<string, number> } {
  const listings = JSON.parse(readFileSync(join(CACHE, "listing-bars.json"), "utf8")) as ListingRecord[];
  const btc = JSON.parse(readFileSync(join(CACHE, "btc-daily.json"), "utf8")) as BtcDaily;
  const btcByDate = new Map<string, number>();
  for (let i = 0; i < btc.dates.length; i += 1) btcByDate.set(btc.dates[i], btc.closes[i]);
  return { listings, btcByDate };
}

/**
 * Build per-event daily log-return paths for the coin and the aligned BTC market,
 * starting from the listing day-0 close. Day index t uses bars[t] vs bars[t-1].
 * Returns coinRet[t] (close_t/close_{t-1}-1 in simple terms) for t=1..maxDays and
 * the aligned market return on the same calendar date.
 */
interface EventPath {
  symbol: string;
  onboardDate: string;
  // simple returns indexed by day offset; coinRet[h] = close_h/close_0 - 1 (cumulative)
  // we store per-step then cumulate when needed
  stepCoin: number[]; // stepCoin[t] = close_t/close_{t-1}-1, t=1..N
  stepMkt: number[]; // aligned BTC step return on same date
  validSteps: number; // number of usable steps
}
function buildEventPaths(listings: ListingRecord[], btcByDate: Map<string, number>): EventPath[] {
  const paths: EventPath[] = [];
  for (const rec of listings) {
    if (rec.bars.length < 2) continue;
    const dates = rec.bars.map((b) => new Date(b[0]).toISOString().slice(0, 10));
    const closes = rec.bars.map((b) => b[4]);
    const stepCoin: number[] = [];
    const stepMkt: number[] = [];
    let valid = 0;
    for (let t = 1; t < closes.length; t += 1) {
      const cPrev = closes[t - 1];
      const cCur = closes[t];
      const mPrev = btcByDate.get(dates[t - 1]);
      const mCur = btcByDate.get(dates[t]);
      if (cPrev > 0 && cCur > 0 && mPrev != null && mCur != null && mPrev > 0 && mCur > 0) {
        stepCoin.push(cCur / cPrev - 1);
        stepMkt.push(mCur / mPrev - 1);
        valid += 1;
      } else {
        stepCoin.push(NaN);
        stepMkt.push(NaN);
      }
    }
    paths.push({ symbol: rec.symbol, onboardDate: rec.onboardDate, stepCoin, stepMkt, validSteps: valid });
  }
  return paths;
}

/**
 * Net per-event return of the listing trade for a given direction+horizon.
 * Position return = sign * (cumulative coin return over [1..H]); abnormal version
 * subtracts cumulative market return over the same days. We trade the RAW price
 * (you cannot trade an abnormal return directly), but for the event-study stat
 * we report CAR. The tradeable P&L uses the raw coin path minus cost; we also
 * provide a market-hedged variant (long/short coin vs BTC) for robustness.
 */
function eventNet(
  path: EventPath,
  direction: "short" | "long",
  horizon: number,
  opts: { hedged: boolean },
): number | null {
  if (path.stepCoin.length < horizon) return null;
  let cumCoin = 1;
  let cumMkt = 1;
  let used = 0;
  for (let t = 0; t < horizon; t += 1) {
    const rc = path.stepCoin[t];
    const rm = path.stepMkt[t];
    if (!Number.isFinite(rc) || !Number.isFinite(rm)) return null;
    cumCoin *= 1 + rc;
    cumMkt *= 1 + rm;
    used += 1;
  }
  if (used < horizon) return null;
  const coinRet = cumCoin - 1;
  const mktRet = cumMkt - 1;
  const sign = direction === "short" ? -1 : 1;
  // hedged: position in coin minus same-sign position in market (beta-1 hedge),
  // costs both legs (2 round trips). unhedged: just the coin, 1 round trip.
  if (opts.hedged) {
    const gross = sign * (coinRet - mktRet);
    return gross - 2 * ROUND_TRIP_COST;
  }
  const gross = sign * coinRet;
  return gross - ROUND_TRIP_COST;
}

interface StratResult {
  id: string;
  direction: "short" | "long";
  horizon: number;
  hedged: boolean;
  netReturns: number[];
  grossReturns: number[];
  n: number;
}
function runStrategy(
  paths: EventPath[],
  direction: "short" | "long",
  horizon: number,
  hedged: boolean,
): StratResult {
  const net: number[] = [];
  const gross: number[] = [];
  for (const p of paths) {
    const v = eventNet(p, direction, horizon, { hedged });
    if (v == null) continue;
    net.push(v);
    // gross = net + cost (for diagnostics)
    gross.push(v + (hedged ? 2 : 1) * ROUND_TRIP_COST);
  }
  return {
    id: `${direction}-h${horizon}-${hedged ? "hedged" : "raw"}`,
    direction,
    horizon,
    hedged,
    netReturns: net,
    grossReturns: gross,
    n: net.length,
  };
}

// ---- the search (over the SEARCH slice only) -------------------------------
interface SearchOutcome {
  best: StratResult;
  trueN: number;
  allSharpes: { id: string; sharpe: number; mean: number; n: number }[];
}
function searchBestStrategy(searchPaths: EventPath[]): SearchOutcome {
  const candidates: StratResult[] = [];
  for (const dir of DIRECTIONS) {
    for (const h of HOLD_HORIZONS) {
      for (const hedged of [false, true]) {
        candidates.push(runStrategy(searchPaths, dir, h, hedged));
      }
    }
  }
  const scored = candidates.map((c) => {
    const stats = summarizeReturnSeries(c.netReturns);
    return { c, sharpe: stats.sharpe, mean: stats.mean, n: c.n };
  });
  // best by net mean (compound-return proxy per event), require enough events
  const eligible = scored.filter((s) => s.n >= 30);
  const best = eligible.reduce((b, s) => (s.mean > b.mean ? s : b), eligible[0]);
  return {
    best: best.c,
    trueN: candidates.length, // TRUE number of configs tried
    allSharpes: scored.map((s) => ({ id: s.c.id, sharpe: s.sharpe, mean: s.mean, n: s.n })),
  };
}

// ---- surrogate builders ----------------------------------------------------
/**
 * CALENDAR placebo (the cross-structure-destroying null for a POOLED-AVERAGE edge).
 * A naive cross-sectional row-shuffle is INVARIANT for a pooled cross-event mean
 * (swapping which slot holds which path does not change the multiset being
 * averaged), so it cannot test the event hypothesis. The correct null re-anchors
 * each event to a RANDOM offset inside that same coin's own post-listing window:
 * same coin, same vol & autocorrelation, but the trade is NO LONGER aligned to
 * day-0 of the listing. If the listing day carries no special forced-flow
 * structure, a random-offset window yields an equal-or-better edge. This DESTROYS
 * the event timing while preserving each asset's marginal dynamics.
 */
function calendarReanchor(paths: EventPath[], rng: () => number, maxStartOffset = 30): EventPath[] {
  return paths.map((p) => {
    const room = Math.max(0, p.stepCoin.length - maxStartOffset);
    if (room <= 0) return p;
    const off = 1 + Math.floor(rng() * (p.stepCoin.length - maxStartOffset - 1));
    return { ...p, stepCoin: p.stepCoin.slice(off), stepMkt: p.stepMkt.slice(off) };
  });
}
/** Block-bootstrap each coin's own steps (preserves vol & local autocorr, destroys event timing). */
function blockBootstrapPath(p: EventPath, rng: () => number, blockLen = 3): EventPath {
  const n = p.stepCoin.length;
  const outC: number[] = [];
  const outM: number[] = [];
  while (outC.length < n) {
    const start = Math.floor(rng() * n);
    for (let o = 0; o < blockLen && outC.length < n; o += 1) {
      outC.push(p.stepCoin[(start + o) % n]);
      outM.push(p.stepMkt[(start + o) % n]);
    }
  }
  return { ...p, stepCoin: outC, stepMkt: outM };
}
/** Phase randomization (sign-flip surrogate) preserving magnitude distribution. */
function phaseRandomPath(p: EventPath, rng: () => number): EventPath {
  const outC = p.stepCoin.map((x) => (Number.isFinite(x) ? (rng() < 0.5 ? -x : x) : x));
  return { ...p, stepCoin: outC };
}

/** Re-run the IDENTICAL search and return the best net mean it finds. */
function searchEdge(paths: EventPath[]): number {
  const out = searchBestStrategy(paths);
  return summarizeReturnSeries(out.best.netReturns).mean;
}

// ---- main ------------------------------------------------------------------
function main(): void {
  const { listings, btcByDate } = loadData();
  const allPaths = buildEventPaths(listings, btcByDate)
    .filter((p) => p.validSteps >= 20) // need at least 20 usable post-listing days
    .sort((a, b) => (a.onboardDate < b.onboardDate ? -1 : 1)); // chronological

  console.log("=".repeat(78));
  console.log("FRONT C4 — LISTING-EVENT forced-flow study (REAL Binance Futures data)");
  console.log("=".repeat(78));
  console.log(`raw listing records loaded: ${listings.length}`);
  console.log(`usable events (>=20 post-listing days, BTC-aligned): ${allPaths.length}`);
  console.log(
    `event date range: ${allPaths[0]?.onboardDate} .. ${allPaths[allPaths.length - 1]?.onboardDate}`,
  );
  console.log(`round-trip cost: ${(ROUND_TRIP_COST * 10_000).toFixed(1)} bps (${TAKER_BPS_PER_SIDE}bps/side)`);

  // ---- RAW EVENT STUDY (descriptive, market-adjusted CAR by day) -----------
  console.log("\n--- EVENT STUDY: market-adjusted abnormal returns (AR) by day ---");
  console.log("day | meanAR%  cumCAR%  t(AR)  n");
  const maxDay = 20;
  let cum = 0;
  for (let d = 0; d < maxDay; d += 1) {
    const ars: number[] = [];
    for (const p of allPaths) {
      if (p.stepCoin.length <= d) continue;
      const rc = p.stepCoin[d];
      const rm = p.stepMkt[d];
      if (Number.isFinite(rc) && Number.isFinite(rm)) ars.push(rc - rm);
    }
    const mAr = mean(ars);
    cum += mAr;
    console.log(
      `${String(d + 1).padStart(3)} | ${(mAr * 100).toFixed(3).padStart(7)} ${(cum * 100)
        .toFixed(3)
        .padStart(8)} ${tStat(ars).toFixed(2).padStart(6)} ${String(ars.length).padStart(4)}`,
    );
  }

  // ---- HOLDOUT SPLIT (chronological consume-once) --------------------------
  const plan = planHoldoutSplit({ totalRows: allPaths.length, holdoutFraction: 0.25, testFraction: 0.0 });
  const searchPaths = allPaths.slice(plan.search.start, plan.search.end);
  const holdoutPaths = allPaths.slice(plan.finalHoldout.start, plan.finalHoldout.end);
  assertSearchDoesNotTouchHoldout({
    searchMaxIndexExclusive: plan.search.end,
    holdoutStartIndex: plan.finalHoldout.start,
  });
  console.log(`\n--- HOLDOUT SPLIT (chronological) ---`);
  console.log(
    `search events: ${searchPaths.length} (${searchPaths[0]?.onboardDate}..${searchPaths[searchPaths.length - 1]?.onboardDate})`,
  );
  console.log(
    `holdout events: ${holdoutPaths.length} (${holdoutPaths[0]?.onboardDate}..${holdoutPaths[holdoutPaths.length - 1]?.onboardDate})`,
  );

  // ---- SEARCH on the search slice only -------------------------------------
  const searchOut = searchBestStrategy(searchPaths);
  const best = searchOut.best;
  const searchStats = summarizeReturnSeries(best.netReturns);
  console.log(`\n--- SEARCH (TRUE N = ${searchOut.trueN} configs) ---`);
  console.log("config | netMean%  netSharpe  n");
  for (const s of searchOut.allSharpes.sort((a, b) => b.mean - a.mean).slice(0, 8)) {
    console.log(
      `${s.id.padEnd(20)} ${(s.mean * 100).toFixed(3).padStart(8)} ${s.sharpe
        .toFixed(3)
        .padStart(9)} ${String(s.n).padStart(4)}`,
    );
  }
  console.log(`BEST on search: ${best.id}  netMean=${(searchStats.mean * 100).toFixed(3)}%  sharpe=${searchStats.sharpe.toFixed(3)}  n=${best.n}`);

  // ---- SURROGATE / PLACEBO (the hero) — run IDENTICAL search on nulls -------
  console.log(`\n--- SURROGATE / PLACEBO (${SURROGATE_REPS} reps each) ---`);
  const realEdge = searchStats.mean; // edge metric = best net-mean found on the search slice
  function placebo(label: string, makeSurrogate: (rng: () => number) => EventPath[]): { p: number; mean: number; q95: number } {
    const edges: number[] = [];
    for (let r = 0; r < SURROGATE_REPS; r += 1) {
      const rng = mulberry32(1000 + r);
      edges.push(searchEdge(makeSurrogate(rng)));
    }
    edges.sort((a, b) => a - b);
    const ge = edges.filter((e) => e >= realEdge).length;
    const p = (ge + 1) / (SURROGATE_REPS + 1);
    const q95 = edges[Math.floor(0.95 * edges.length)];
    console.log(
      `${label.padEnd(26)} realEdge=${(realEdge * 100).toFixed(3)}%  surrMean=${(mean(edges) * 100).toFixed(3)}%  surr95=${(q95 * 100).toFixed(3)}%  placeboP=${p.toFixed(4)}`,
    );
    return { p, mean: mean(edges), q95 };
  }
  const pCal = placebo("calendar-reanchor", (rng) => calendarReanchor(searchPaths, rng));
  const pBlock = placebo("block-bootstrap", (rng) => searchPaths.map((p) => blockBootstrapPath(p, rng)));
  const pPhase = placebo("phase-random(signflip)", (rng) => searchPaths.map((p) => phaseRandomPath(p, rng)));
  const worstPlaceboP = Math.max(pCal.p, pBlock.p, pPhase.p);

  // ---- CPCV / PBO across event-folds ---------------------------------------
  // Build fold returns: split each candidate's per-event returns into K contiguous
  // (chronological) folds; estimateCscvPbo measures overfit of selecting by IS.
  const K = 8;
  const cscvStrategies: CscvStrategyFoldReturns[] = searchOut.allSharpes
    .map((s) => {
      const strat = runStrategy(searchPaths, s.id.startsWith("short") ? "short" : "long", Number(s.id.match(/h(\d+)/)![1]), s.id.endsWith("hedged"));
      const folds: number[][] = Array.from({ length: K }, () => []);
      strat.netReturns.forEach((v, i) => folds[i % K].push(v));
      return { id: strat.id, folds };
    })
    .filter((s) => s.folds.every((f) => f.length > 0));
  const pbo = estimateCscvPbo(cscvStrategies, { statistic: "mean" });
  console.log(`\n--- CPCV / PBO ---`);
  console.log(`strategies=${pbo.strategyCount} folds=${pbo.foldCount} splits=${pbo.splitCount} PBO=${pbo.pbo.toFixed(3)} (threshold ${PBO_THRESHOLD})`);

  // ---- DSR (TRUE N) on the search slice ------------------------------------
  const dsr = computeDeflatedSharpeRatio(best.netReturns, { trialCount: searchOut.trueN });
  console.log(`\n--- DEFLATED SHARPE (TRUE N=${searchOut.trueN}) ---`);
  console.log(`sharpe=${dsr.sharpe.toFixed(3)} expMaxSharpe=${dsr.expectedMaxSharpe.toFixed(3)} DSR=${dsr.deflatedProbability.toFixed(4)} (threshold ${DSR_THRESHOLD})`);

  // ---- HAIRCUT (Harvey-Liu, Bonferroni at top rank) ------------------------
  const hc = haircutSharpe({ observedSharpe: best.netReturns.length > 1 ? summarizeReturnSeries(best.netReturns).sharpe : 0, sampleCount: best.netReturns.length, trialCount: searchOut.trueN, method: "bonferroni" });
  console.log(`\n--- HAIRCUT (Harvey-Liu) ---`);
  console.log(`pValue=${hc.pValue.toExponential(2)} adjP=${hc.adjustedPValue.toExponential(2)} haircutSharpe=${hc.haircutSharpe.toFixed(3)} haircutFrac=${hc.haircut.toFixed(3)} (alpha ${HAIRCUT_ALPHA})`);

  // ---- BASELINES (buy&hold market, equal-weight, random lottery) -----------
  // Per-event "buy&hold the market" baseline: BTC return over the same horizon, net of cost.
  const bhEvents: number[] = [];
  for (const p of searchPaths) {
    if (p.stepMkt.length < best.horizon) continue;
    let cm = 1;
    let ok = true;
    for (let t = 0; t < best.horizon; t += 1) {
      if (!Number.isFinite(p.stepMkt[t])) { ok = false; break; }
      cm *= 1 + p.stepMkt[t];
    }
    if (ok) bhEvents.push(cm - 1 - ROUND_TRIP_COST);
  }
  const baselineBuyHold = baselineScoreFromReturns("buy_and_hold", "buy&hold market (per event)", bhEvents, { statistic: "mean" });
  // equal-weight = long every new listing (the naive "buy the listing") net of cost
  const ewStrat = runStrategy(searchPaths, "long", best.horizon, best.hedged);
  const baselineEqual: BaselineScore = baselineScoreFromReturns("equal_weight", "equal-weight long-listing", ewStrat.netReturns, { statistic: "mean" });
  // random lottery matched to turnover (1 round trip/event)
  const lottery = buildRandomLotteryBaseline({
    barReturns: searchPaths.flatMap((p) => p.stepCoin.slice(0, best.horizon)).filter((x) => Number.isFinite(x)),
    tradeCount: best.n,
    averageHoldingBars: best.horizon,
    roundTripCost: ROUND_TRIP_COST,
    iterations: 1024,
    statistic: "mean",
    seed: "front-c4",
  });
  // linear baseline = predict next-event AR from prior-event AR mean (degenerate -> use flat 0 series sized like candidate)
  const linearBaseline = baselineScoreFromReturns("linear", "linear (zero-skill drift)", new Array(best.n).fill(0), { statistic: "mean" });
  const baselineGate = evaluateBaselineGate({
    candidateReturns: best.netReturns,
    baselines: [baselineBuyHold, baselineEqual, lottery, linearBaseline],
    statistic: "mean",
    requirePositive: true,
  });
  console.log(`\n--- BASELINES (net mean per event) ---`);
  console.log(`candidate=${(baselineGate.candidateScore * 100).toFixed(3)}%`);
  for (const c of baselineGate.comparisons) {
    console.log(`  vs ${c.id.padEnd(14)} base=${(c.baselineScore * 100).toFixed(3)}% margin=${(c.margin * 100).toFixed(3)}% beaten=${c.beaten}`);
  }
  console.log(`beatsAll=${baselineGate.beatsAll} passed=${baselineGate.passed}`);

  // ---- HOLDOUT consume-once: evaluate chosen config ONCE on holdout --------
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "front-c4-listing-final", gitSha: gitSha(), trialCount: searchOut.trueN, nowIso: new Date().toISOString() });
  const holdoutStrat = runStrategy(holdoutPaths, best.direction, best.horizon, best.hedged);
  const holdoutStats = summarizeReturnSeries(holdoutStrat.netReturns);
  const holdoutDsr = computeDeflatedSharpeRatio(holdoutStrat.netReturns, { trialCount: 1 });
  console.log(`\n--- HOLDOUT (consume-once, chosen config ${best.id}) ---`);
  console.log(`n=${holdoutStrat.n} netMean=${(holdoutStats.mean * 100).toFixed(3)}% netSharpe=${holdoutStats.sharpe.toFixed(3)} compound=${(holdoutStats.compoundReturn * 100).toFixed(2)}% DSR(N=1)=${holdoutDsr.deflatedProbability.toFixed(4)}`);

  // ---- VERDICT -------------------------------------------------------------
  const gatesPassed = {
    searchPositive: searchStats.mean > 0,
    placebo: worstPlaceboP < 0.05,
    pbo: pbo.pbo < PBO_THRESHOLD,
    dsr: dsr.deflatedProbability >= DSR_THRESHOLD,
    haircut: hc.adjustedPValue < HAIRCUT_ALPHA && hc.haircutSharpe > 0,
    baselines: baselineGate.passed,
    holdoutPositive: holdoutStats.mean > 0,
    holdoutSharpe: holdoutStats.sharpe > 0,
  };
  const allPass = Object.values(gatesPassed).every(Boolean);
  const firstFail = Object.entries(gatesPassed).find(([, v]) => !v)?.[0] ?? null;

  console.log(`\n${"=".repeat(78)}`);
  console.log("GATE SUMMARY");
  console.log("=".repeat(78));
  for (const [k, v] of Object.entries(gatesPassed)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
  const verdict = allPass ? "SURVIVE" : "KILL";
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`killed-by-gate: ${firstFail ?? "none"}`);

  // ---- persist -------------------------------------------------------------
  const report = {
    track: "FRONT C4 — event/listing forced-flow",
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    data: {
      source: "binance-futures-rest (onboardDate + daily klines)",
      realData: true,
      rawRecords: listings.length,
      usableEvents: allPaths.length,
      dateRange: [allPaths[0]?.onboardDate, allPaths[allPaths.length - 1]?.onboardDate],
      roundTripBps: ROUND_TRIP_COST * 10_000,
    },
    eventStudy: { note: "market-adjusted AR vs BTC, beta=1 (no pre-event window)" },
    search: { trueN: searchOut.trueN, best: best.id, netMean: searchStats.mean, netSharpe: searchStats.sharpe, n: best.n },
    surrogate: { calendarReanchor: pCal, blockBootstrap: pBlock, phaseRandom: pPhase, worstPlaceboP },
    pbo: { pbo: pbo.pbo, strategyCount: pbo.strategyCount, foldCount: pbo.foldCount },
    dsr: { searchDSR: dsr.deflatedProbability, trueN: searchOut.trueN, holdoutDSR: holdoutDsr.deflatedProbability },
    haircut: { adjustedPValue: hc.adjustedPValue, haircutSharpe: hc.haircutSharpe, haircutFrac: hc.haircut },
    baselines: baselineGate,
    holdout: { n: holdoutStrat.n, netMean: holdoutStats.mean, netSharpe: holdoutStats.sharpe, compound: holdoutStats.compoundReturn },
    gatesPassed,
    verdict,
    killedByGate: firstFail,
    holdoutConsumption: guard.status(),
  };
  writeFileSync(join(OUT, "listing-event-result.json"), JSON.stringify(report, null, 2));
  console.log(`\nwrote ${join(OUT, "listing-event-result.json")}`);
}

main();
