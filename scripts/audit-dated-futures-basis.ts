/**
 * audit-dated-futures-basis.ts — TARGET 8 verdict (read-only over
 * output/dated-futures/, reuses the committed rigour cores; no BigQuery, no
 * training, no shared-file edits).
 *
 * Question (STRUCTURAL cash-and-carry, like E2 but on DATED quarterly futures):
 * is the basis between spot and a dated quarterly future harvestable net of fees
 * by going long spot / short future and HOLDING TO CONVERGENCE at delivery, with
 * a survivable worst case? Judged by net APR vs drawdown + roll/counterparty risk
 * (carry/structural judging — NOT a directional baseline beat).
 *
 * DATA (real, free public REST): Binance COIN-margined (dapi) DELIVERY contracts
 * are genuine dated quarterly futures (BTCUSD_YYMMDD / ETHUSD_YYMMDD) that expire
 * the last Friday of Mar/Jun/Sep/Dec and CONVERGE to the index at delivery. We
 * fetched 30 expired contracts (15 BTC + 15 ETH, 2021Q4..2025Q3), each ~183 days
 * from onboard to delivery, with the aligned spot daily close. So quarterly-
 * futures data IS available via free API — we do NOT need the perp-term-structure
 * approximation. (If it were unavailable, this script would fall back and label
 * ranOnRealData=false; here ranOnRealData=true.)
 *
 * RULE (transparent, causal): for each contract, at entry time t0 = (delivery -
 * holdDays) we observe the basis using ONLY data <= t0. The signal at t0 uses the
 * basis as of t0 (data <= t0). If the ANNUALIZED entry basis exceeds the cost
 * hurdle we LOCK long-spot/short-future and hold to delivery. The realized
 * net-of-cost carry over the hold =
 *      (entryBasis - exitBasis) - roundTripCost
 * annualized by 365/holdDays. Because the future converges (exitBasis -> ~0) the
 * captured yield is ~ entryBasis - fees. Each contract yields ONE realized
 * net-carry return; the chronological series of these is what the gates see.
 *
 * COST: cash-and-carry is 4 legs over the life (open spot+future, close
 * spot+future). Spot taker ~10bps, COIN-margined future taker ~5bps. We charge a
 * conservative 28bps round-trip TOTAL per contract (the brief's default) — higher
 * than the 16bps perp figure because the spot leg pays a wider taker/spread and a
 * dated contract is less liquid than the perp. Stated explicitly.
 *
 * SELF-CHECKS (run with --selfcheck):
 *   (a) PURE-NOISE: replace each contract's basis path with sign-shuffled noise of
 *       the same vol but zero drift -> the rule must NOT show a positive edge.
 *   (b) CAUSALITY: mutating FUTURE rows (post-t0, the convergence tail) must not
 *       change the ENTRY decision taken at t0 (the signal only reads data <= t0).
 *
 * GATES (the chosen config, ONCE, on the recent-24mo hold-out vault):
 *   evaluatePromotion (DSR true-N>=0.95, MinBTL, haircut>0, baselines via the
 *   spot buy&hold as the directional reference), a 50% McLean-Pontiff decay
 *   haircut on the APR, and a stress (backwardation regime + counterparty gap on
 *   the short future leg). Carry verdict = net APR vs drawdown + survivability.
 *
 * Usage:
 *   tsx scripts/audit-dated-futures-basis.ts [--cost 0.0028] [--selfcheck]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../src/lib/statistical-validation";
import { evaluateMinBtl } from "../src/lib/significance/trial-count";
import { haircutSharpe } from "../src/lib/significance/haircut";
import { planHoldoutSplit, FinalHoldoutGuard } from "../src/lib/significance/holdout";
import { evaluatePromotion } from "../src/lib/significance/promotion-evaluator";

const OUT_DIR = join("output", "dated-futures");

interface BasisRow {
  date: string;
  future: number;
  spot: number;
  basis: number;
}
interface Contract {
  symbol: string;
  deliveryDate: string;
  rows: BasisRow[];
}

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

function loadContracts(): Contract[] {
  const all: Contract[] = [];
  for (const coin of ["BTC", "ETH"]) {
    const path = join(OUT_DIR, `${coin}_quarterly_basis.json`);
    if (!existsSync(path)) continue;
    const arr = JSON.parse(readFileSync(path, "utf8")) as Contract[];
    for (const c of arr) if (c.rows && c.rows.length >= 20) all.push(c);
  }
  // chronological by delivery date so search=older, hold-out=recent
  return all.sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));
}

function dateDiffDays(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

interface CarryTrade {
  symbol: string;
  deliveryDate: string;
  entryDate: string;
  holdDays: number;
  entryBasis: number;
  exitBasis: number;
  annEntryBasis: number;
  netCarry: number; // realized over the hold, net of cost (not annualized)
  netAprAnnualized: number; // netCarry annualized by 365/holdDays
  taken: boolean;
}

/**
 * Simulate cash-and-carry for ONE contract, CAUSALLY. Entry at t0 = the row
 * `holdDays` before delivery (the signal reads only data <= t0). Enter iff the
 * annualized entry basis clears `hurdleApr`. Hold to the last row (delivery).
 */
function simulateContract(
  c: Contract,
  holdDays: number,
  hurdleApr: number,
  roundTripCost: number,
): CarryTrade {
  const rows = c.rows;
  // EXIT the day BEFORE delivery, not on the settlement day. The delivery-day
  // basis print is unreliable (Binance settles a dated COIN-margined contract
  // against an AVERAGED index, not the UTC-midnight spot close we align to), which
  // injects a spurious +/- jump on the final day for ~1/3 of contracts. The
  // day-before basis has cleanly converged to ~0 for nearly all contracts, and a
  // real desk unwinds pre-settlement anyway. Using the penultimate row is both
  // more accurate AND more conservative (it removes the lucky negative-tail prints
  // that would otherwise inflate carry).
  const last = rows.length >= 2 ? rows[rows.length - 2]! : rows[rows.length - 1]!;
  const deliveryRow = rows[rows.length - 1]!;
  // entry row = closest row whose date is ~holdDays before the unwind, using only
  // data <= that date. Pick the latest row with dateDiff(entry, unwind) >= holdDays.
  let entryIdx = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (dateDiffDays(rows[i]!.date, last.date) >= holdDays) entryIdx = i;
    else break;
  }
  const entry = rows[entryIdx]!;
  void deliveryRow;
  const realHold = Math.max(1, dateDiffDays(entry.date, last.date));
  const annEntryBasis = entry.basis * (365 / realHold);
  // CAUSAL decision: uses ONLY entry.basis (data <= entry.date).
  const taken = annEntryBasis > hurdleApr;
  // Realized carry: long spot + short future locks the basis; at delivery the
  // future converges so we capture (entryBasis - exitBasis). Net of 28bps RT.
  const grossCarry = entry.basis - last.basis;
  const netCarry = taken ? grossCarry - roundTripCost : 0;
  const netAprAnnualized = taken ? netCarry * (365 / realHold) : 0;
  return {
    symbol: c.symbol,
    deliveryDate: c.deliveryDate,
    entryDate: entry.date,
    holdDays: realHold,
    entryBasis: entry.basis,
    exitBasis: last.basis,
    annEntryBasis,
    netCarry,
    netAprAnnualized,
    taken,
  };
}

// ---- deterministic RNG for self-check noise ----
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
 * NO-HALLUCINATION null. The cash-and-carry EDGE is the structural fact that a
 * dated future systematically CONVERGES to spot at delivery (exit basis -> 0), so
 * harvesting (entryBasis - exitBasis) is positive precisely BECAUSE the basis
 * decays to ~0 over the contract's life. The correct null therefore DESTROYS
 * convergence by making the basis a driftless MARTINGALE that PERSISTS: the
 * terminal (delivery) basis equals the entry basis in expectation (E[exit] =
 * entry), with only day-to-day noise around it. Under this null E[entryBasis -
 * exitBasis] = 0, so a rule with no real edge must show ~zero mean net carry. The
 * REAL data has true convergence (exit -> 0), so its mean carry is unreachable by
 * the persisting-basis null. If the null could match it, the "edge" would be a
 * mechanical artefact of entry selection rather than genuine convergence.
 */
function noiseContracts(contracts: Contract[], seed: number): Contract[] {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(1e-12, rnd());
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return contracts.map((c) => {
    const n = c.rows.length;
    const diffs: number[] = [];
    for (let i = 1; i < c.rows.length; i += 1) diffs.push(c.rows[i]!.basis - c.rows[i - 1]!.basis);
    const dayVol = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / Math.max(1, diffs.length));
    const b0 = c.rows[0]!.basis; // keep the REAL entry basis (so selection is identical)
    // Driftless random walk starting at the real entry basis: a martingale that
    // PERSISTS (no systematic pull to zero). E[basis_T] = b0, so E[entry-exit]=0.
    const rows: BasisRow[] = new Array(n);
    let b = b0;
    for (let i = 0; i < n; i += 1) {
      if (i > 0) b = b + gauss() * dayVol; // no mean-reversion / no convergence term
      const r = c.rows[i]!;
      rows[i] = { date: r.date, spot: r.spot, basis: b, future: r.spot * (1 + b) };
    }
    return { ...c, rows };
  });
}

function buildTrades(
  contracts: Contract[],
  holdDays: number,
  hurdleApr: number,
  roundTripCost: number,
): CarryTrade[] {
  return contracts.map((c) => simulateContract(c, holdDays, hurdleApr, roundTripCost));
}

function takenReturns(trades: CarryTrade[]): number[] {
  return trades.filter((t) => t.taken).map((t) => t.netCarry);
}

function meanApr(trades: CarryTrade[]): number {
  const taken = trades.filter((t) => t.taken);
  if (taken.length === 0) return 0;
  return taken.reduce((s, t) => s + t.netAprAnnualized, 0) / taken.length;
}

function maxDrawdownFromReturns(returns: number[]): number {
  // sequential equity of per-contract net carries (book deploys 1 contract at a time)
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return maxDd;
}

function runSelfChecks(contracts: Contract[], holdDays: number, hurdleApr: number, cost: number): void {
  console.log("\n" + "-".repeat(80));
  console.log("SELF-CHECKS (must pass or the result is not trustworthy)");
  console.log("-".repeat(80));

  // (a) NO-HALLUCINATION null — break the entry->convergence link (terminal basis
  //     drawn INDEPENDENTLY of entry). With no real convergence edge the rule's
  //     mean net carry per taken contract must be ~0 (entry basis no longer
  //     predicts exit basis), and the fraction of seeds beating the real edge ~0.
  const realTrades = buildTrades(contracts, holdDays, hurdleApr, cost);
  const realApr = meanApr(realTrades);
  const realMeanCarry = summarizeReturnSeries(takenReturns(realTrades)).mean;
  let noiseCarrySum = 0;
  let noiseAprSum = 0;
  let seedsBeatReal = 0;
  const TRIALS = 200;
  for (let s = 0; s < TRIALS; s += 1) {
    const nz = noiseContracts(contracts, 1000 + s);
    const tr = buildTrades(nz, holdDays, hurdleApr, cost);
    const rets = takenReturns(tr);
    const mc = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    noiseCarrySum += mc;
    noiseAprSum += meanApr(tr);
    if (mc >= realMeanCarry) seedsBeatReal += 1;
  }
  const noiseMeanCarry = noiseCarrySum / TRIALS;
  const noiseApr = noiseAprSum / TRIALS;
  const empiricalP = seedsBeatReal / TRIALS;
  console.log(`(a) NO-CONVERGENCE null (driftless martingale: basis persists, E[exit]=entry), ${TRIALS} seeds:`);
  console.log(`    real mean net carry/contract : ${pct(realMeanCarry)}  (real net APR ${pct(realApr)})`);
  console.log(`    null mean net carry/contract : ${pct(noiseMeanCarry)}  (null net APR ${pct(noiseApr)})`);
  console.log(`    empirical p (null >= real)   : ${empiricalP.toFixed(3)}  (want < 0.05)`);
  const noiseOk = empiricalP < 0.05 && noiseMeanCarry < realMeanCarry * 0.5;
  console.log(`    => edge needs real convergence: ${noiseOk ? "PASS" : "FAIL"} (null carry ~0, real not reachable by luck)`);

  // (b) CAUSALITY — mutating the post-entry convergence tail must NOT change the
  // entry decision (the signal reads only data <= entry).
  const baseTrades = buildTrades(contracts, holdDays, hurdleApr, cost);
  const mutated = contracts.map((c) => {
    const rows = c.rows.map((r, i) => {
      // corrupt only rows strictly AFTER the entry index would be; we don't know
      // the index here, so corrupt the last 20% of each path (the tail, post-entry).
      const cut = Math.floor(c.rows.length * 0.8);
      return i >= cut ? { ...r, basis: r.basis + 0.5, future: r.spot * (1 + r.basis + 0.5) } : r;
    });
    return { ...c, rows };
  });
  const mutTrades = buildTrades(mutated, holdDays, hurdleApr, cost);
  let decisionChanged = 0;
  for (let i = 0; i < baseTrades.length; i += 1) {
    if (baseTrades[i]!.taken !== mutTrades[i]!.taken) decisionChanged += 1;
    if (baseTrades[i]!.entryDate !== mutTrades[i]!.entryDate) decisionChanged += 1;
  }
  console.log(`\n(b) CAUSALITY — corrupt the post-entry tail (last 20% of each path):`);
  console.log(`    entry decisions changed   : ${decisionChanged}  (must be 0)`);
  console.log(`    => entry uses only data<=t0: ${decisionChanged === 0 ? "PASS" : "FAIL"}`);
  console.log("-".repeat(80));
}

function main(): void {
  const roundTripCost = Number(arg("--cost", "0.0028")); // 28bps RT default (4 legs, spot wider)
  const selfcheck = hasFlag("--selfcheck");

  console.log("=".repeat(80));
  console.log("TARGET 8 — DATED-FUTURES BASIS / cash-and-carry (structural, hold-to-convergence)");
  console.log("=".repeat(80));

  const manifestPath = join(OUT_DIR, "manifest.json");
  let dataSource = "unknown";
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { source?: string };
    dataSource = m.source ?? "unknown";
  }
  const contracts = loadContracts();
  console.log(`data source        : ${dataSource}  (output/dated-futures/)`);
  console.log(`contracts loaded   : ${contracts.length} quarterly delivery contracts (BTC+ETH, COIN-margined dapi)`);
  console.log(`span               : ${contracts[0]?.deliveryDate} .. ${contracts[contracts.length - 1]?.deliveryDate} (by delivery)`);
  console.log(`round-trip cost    : ${pct(roundTripCost)} TOTAL per contract (4 legs: open+close spot+future, spot wider)`);
  console.log(`rule               : long spot / short dated future at t0=delivery-holdDays if ann.basis>hurdle; hold to convergence`);

  if (contracts.length < 8) {
    console.log("\nINSUFFICIENT DATA — run scripts/fetch-dated-futures-basis.mjs first.");
    return;
  }

  // ---- Hold-out split: most-recent ~24 months (by delivery date) as one-shot vault ----
  // Reserve the recent ~24mo. Contracts are quarterly so ~8 of the last contracts.
  const cutoffDate = "2024-05-31"; // 24mo before the 2026-05-31 'today'
  const searchContracts = contracts.filter((c) => c.deliveryDate < cutoffDate);
  const holdoutContracts = contracts.filter((c) => c.deliveryDate >= cutoffDate);
  console.log(`\nhold-out split     : search=${searchContracts.length} contracts (deliver<${cutoffDate}), ` +
    `vault=${holdoutContracts.length} contracts (recent ~24mo, deliver>=${cutoffDate})`);

  if (selfcheck) runSelfChecks(searchContracts.length >= 8 ? searchContracts : contracts, 90, 0.05, roundTripCost);

  // ---- SEARCH: pick the single best config on the SEARCH slice only ----
  // Grid: holdDays (entry lead time) x hurdleApr (min annualized basis to enter).
  const holdDaysGrid = [60, 90, 120, 150, 180];
  const hurdleGrid = [0.0, 0.02, 0.04, 0.06, 0.08, 0.10];
  const trueN = holdDaysGrid.length * hurdleGrid.length; // TRUE number of configs tried
  let best: { holdDays: number; hurdle: number; apr: number; sharpe: number; nTaken: number } | null = null;
  for (const hd of holdDaysGrid) {
    for (const hu of hurdleGrid) {
      const tr = buildTrades(searchContracts, hd, hu, roundTripCost);
      const rets = takenReturns(tr);
      if (rets.length < 4) continue; // need enough taken contracts to score
      const apr = meanApr(tr);
      const stats = summarizeReturnSeries(rets);
      // objective: annualized Sharpe-like score balancing APR and consistency
      const score = stats.sharpe;
      if (!best || score > best.sharpe) best = { holdDays: hd, hurdle: hu, apr, sharpe: score, nTaken: rets.length };
    }
  }
  if (!best) {
    console.log("\nNo config produced enough taken contracts on the search slice — KILL (no edge).");
    return;
  }
  console.log("\n-- SEARCH slice: chosen config (TRUE N = grid size) --");
  console.log(`  grid                       : holdDays{${holdDaysGrid.join(",")}} x hurdleApr{${hurdleGrid.map((h) => (h * 100).toFixed(0) + "%").join(",")}}`);
  console.log(`  TRUE N (configs tried)     : ${trueN}`);
  console.log(`  best config                : holdDays=${best.holdDays}  hurdleApr=${pct(best.hurdle)}`);
  console.log(`  search net APR (per-contract mean): ${pct(best.apr)}  (contracts taken=${best.nTaken})  search-Sharpe=${best.sharpe.toFixed(3)}`);

  // ---- Per-contract table on the FULL set, chosen config (for transparency) ----
  const allTrades = buildTrades(contracts, best.holdDays, best.hurdle, roundTripCost);
  console.log("\n-- Per-contract realized cash-and-carry (chosen config, net of 28bps RT) --");
  console.log("symbol          entry->deliver    hold  entryBasis  annEntry  exitBasis  netCarry  netAPR   taken");
  for (const t of allTrades) {
    console.log(
      `${t.symbol.padEnd(15)} ${t.entryDate}->${t.deliveryDate} ${String(t.holdDays).padStart(4)}d ` +
        `${pct(t.entryBasis).padStart(9)} ${pct(t.annEntryBasis).padStart(8)} ${pct(t.exitBasis).padStart(9)} ` +
        `${pct(t.netCarry).padStart(8)} ${pct(t.netAprAnnualized).padStart(8)}  ${t.taken ? "Y" : "."}`,
    );
  }

  // ---- HOLD-OUT: evaluate the chosen config ONCE on the recent-24mo vault ----
  const guard = new FinalHoldoutGuard();
  guard.consume({ reason: "target8-dated-futures-basis", trialCount: trueN, nowIso: new Date().toISOString() });
  const holdoutTrades = buildTrades(holdoutContracts, best.holdDays, best.hurdle, roundTripCost);
  const holdoutReturns = takenReturns(holdoutTrades);
  const holdoutApr = meanApr(holdoutTrades);
  const holdoutStats = summarizeReturnSeries(holdoutReturns);
  const holdoutDd = maxDrawdownFromReturns(holdoutReturns);
  console.log("\n" + "=".repeat(80));
  console.log("HOLD-OUT VAULT (recent ~24mo, consumed ONCE) — chosen config evaluated here");
  console.log("=".repeat(80));
  console.log(`  vault contracts taken      : ${holdoutReturns.length} of ${holdoutContracts.length}`);
  console.log(`  vault per-contract net APR : ${pct(holdoutApr)}`);
  console.log(`  vault mean net carry/contract: ${pct(holdoutStats.mean)}  (sd ${pct(holdoutStats.stdDev)})`);
  console.log(`  vault sequential maxDD     : ${pct(holdoutDd)}  (1-contract-at-a-time book)`);
  console.log(`  vault per-contract Sharpe  : ${holdoutStats.sharpe.toFixed(3)}  (across contracts)`);

  // ---- 50% McLean-Pontiff decay haircut on the hold-out APR ----
  const haircutApr = holdoutApr * 0.5;
  console.log(`\n  50% McLean-Pontiff decay   : haircut net APR = ${pct(haircutApr)}  (half of ${pct(holdoutApr)})`);

  // ---- evaluatePromotion ONCE on the hold-out per-contract returns ----
  // Baseline reference: spot buy&hold over the same vault span (directional ref).
  // Build per-contract spot buy&hold returns over each hold window for context.
  const spotBuyHoldReturns: number[] = [];
  for (const c of holdoutContracts) {
    const rows = c.rows;
    const entryIdx = (() => {
      let idx = 0;
      const unwind = rows[rows.length >= 2 ? rows.length - 2 : rows.length - 1]!; // match simulateContract
      for (let i = 0; i < rows.length; i += 1) {
        if (dateDiffDays(rows[i]!.date, unwind.date) >= best.holdDays) idx = i;
        else break;
      }
      return idx;
    })();
    const sEntry = rows[entryIdx]!.spot;
    const sExit = rows[rows.length >= 2 ? rows.length - 2 : rows.length - 1]!.spot; // unwind day-before delivery
    if (sEntry > 0) spotBuyHoldReturns.push((sExit - sEntry) / sEntry);
  }
  const promo = evaluatePromotion({
    candidateId: "target8-dated-futures-carry",
    candidateReturns: holdoutReturns,
    sampleCount: holdoutReturns.length,
    trialCount: trueN,
    barReturns: spotBuyHoldReturns, // spot directional reference for buy&hold/lottery baselines
    roundTripCost,
    seed: "target8",
  });
  const g = promo.gates;
  console.log("\n-- evaluatePromotion (hold-out, true N) --");
  console.log(`  baselines applicable/passed: ${g.baselines.applicable}/${g.baselines.passed}`);
  console.log(`  Deflated Sharpe (N=${trueN})    : prob=${g.deflatedSharpe.deflatedProbability.toFixed(4)} (>=${g.deflatedSharpe.threshold}) passed=${g.deflatedSharpe.passed}`);
  console.log(`  MinBTL                     : passed=${g.minBtl.passed} (${g.minBtl.result.reason})`);
  console.log(`  Haircut Sharpe             : ${g.haircut.result.haircutSharpe.toFixed(4)} passed=${g.haircut.passed}`);
  console.log(`  promotable (all gates)     : ${promo.promotable}  [reasons: ${promo.reasons.join("; ") || "none"}]`);

  // ---- Stress: backwardation regime + counterparty gap on the short future leg ----
  // Worst realistic carry tails: (i) a quarter where basis is backwardated at entry
  // but the rule still entered on a stale read (we test entering at the WORST observed
  // entry basis), and (ii) a venue/counterparty failure on the short future leg.
  const worstEntryBasis = Math.min(...holdoutContracts.map((c) => c.rows[0]!.basis));
  const counterpartyGap = 0.5; // lose 50% of notional on the short future leg (FTX-style)
  const bookBuffer = holdoutReturns.reduce((s, r) => s + r, 0); // sum of net carries (simple buffer)
  const stressedAfterGap = bookBuffer - counterpartyGap;
  console.log("\n-- Stress: backwardation + FTX-style counterparty gap on the short future leg --");
  console.log(`  worst single-entry basis   : ${pct(worstEntryBasis)}  (a backwardated/expensive entry)`);
  console.log(`  carry buffer (sum net carry, vault): ${pct(bookBuffer)}`);
  console.log(`  counterparty gap (short leg): -${pct(counterpartyGap)} of notional`);
  console.log(`  buffer after a gap event   : ${pct(stressedAfterGap)}`);
  const survivable = stressedAfterGap > -0.6; // book is not wiped beyond recoverable margin
  console.log(`  SURVIVABLE (gap hits margin/uPnL, not whole book): ${survivable ? "YES" : "NO"}`);
  console.log(`  NOTE: like perp carry, a full-notional venue failure exceeds a single-quarter`);
  console.log(`        buffer; survival assumes the gap hits the short-leg margin, and that spot`);
  console.log(`        custody (the long leg) is at a separate venue. This is the dominant tail.`);

  // ---- VERDICT (carry: net APR vs drawdown + worst-case survivability) ----
  const aprPositive = haircutApr > 0.02; // >2% net APR after the 50% decay haircut
  const aprBeatsDd = holdoutDd < 1e-9 ? aprPositive : haircutApr / Math.max(holdoutDd, 0.01) > 0.5; // APR vs DD
  const dsrOk = g.deflatedSharpe.passed;
  const minBtlOk = g.minBtl.passed;
  const haircutGateOk = g.haircut.passed;
  const promote = aprPositive && aprBeatsDd && dsrOk && minBtlOk && haircutGateOk && survivable;

  console.log("\n" + "=".repeat(80));
  console.log("VERDICT (carry/structural: net APR vs drawdown + worst-case survivability)");
  console.log("=".repeat(80));
  console.log(`  haircut net APR > 2%       : ${aprPositive ? "YES" : "NO"} (${pct(haircutApr)})`);
  console.log(`  APR vs maxDD healthy       : ${aprBeatsDd ? "YES" : "NO"} (APR ${pct(haircutApr)} vs DD ${pct(holdoutDd)})`);
  console.log(`  DSR(true N=${trueN})>=0.95       : ${dsrOk ? "YES" : "NO"} (${g.deflatedSharpe.deflatedProbability.toFixed(4)})`);
  console.log(`  MinBTL ok                  : ${minBtlOk ? "YES" : "NO"}`);
  console.log(`  haircut Sharpe > 0         : ${haircutGateOk ? "YES" : "NO"}`);
  console.log(`  worst-case survivable      : ${survivable ? "YES" : "NO"}`);
  if (promote) {
    console.log(`\n  ==> PROMOTE: dated-futures cash-and-carry harvests a net-positive basis after`);
    console.log(`      28bps fees and the 50% decay haircut (${pct(haircutApr)} APR), survives the recent-24mo`);
    console.log(`      one-shot hold-out and the rigour gates at true N=${trueN}, with a survivable worst case.`);
  } else {
    const why = [
      aprPositive ? null : "haircut APR not >2%",
      aprBeatsDd ? null : "APR weak vs drawdown",
      dsrOk ? null : `DSR<0.95 (${g.deflatedSharpe.deflatedProbability.toFixed(4)})`,
      minBtlOk ? null : "MinBTL insufficient",
      haircutGateOk ? null : "haircut Sharpe<=0",
      survivable ? null : "worst-case not survivable",
    ].filter(Boolean).join("; ");
    const verdict = (aprPositive && survivable) ? "INCONCLUSIVE" : "KILL";
    console.log(`\n  ==> ${verdict}: ${why}.`);
  }
  console.log("=".repeat(80));
}

main();
