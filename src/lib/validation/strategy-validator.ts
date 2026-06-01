/**
 * Strategy Validation Harness — the project's anti-overfitting stack, one API.
 *
 * This composes the COMMITTED, individually-tested gates in `src/lib/training/`
 * into a single ordered gauntlet so any future hypothesis can be validated the
 * same way the 23 edge-search hypotheses were (see docs/EDGE_SEARCH_SYNTHESIS.md).
 * It imports and REUSES those gates — it does NOT reimplement any of them. The
 * only new logic here is (a) orchestration / verdict aggregation and (b) the
 * surrogate/placebo null generators (phase randomization, block bootstrap and a
 * cross-sectional shuffle), which had no committed home.
 *
 * Holdout isolation: the net series is split via `planHoldoutSplit` FIRST. Gates
 * 1–6 score ONLY the in-sample slice `[0, finalHoldout.start)`; the most-recent
 * vault `[finalHoldout.start, finalHoldout.end)` is reserved and never read by any
 * in-sample gate, so Gate 7 is a genuine, independent out-of-sample test.
 *
 * Gate order (each is a hard gate; the FIRST failing one is the binding gate):
 *   1. net-of-cost summary      — turnover-aware net return; gross-only ⇒ KILL.
 *   2. baselines                — beat buy-and-hold + equal-weight + random-lottery + linear.
 *   3. deflated Sharpe (DSR)    — at an EXPLICIT honest trialCount (true N).
 *   4. CPCV / PBO               — probability of backtest overfitting < 0.5. SKIPPED
 *                                 (non-binding) unless a genuine strategies×folds matrix
 *                                 is supplied; a self-derived candidate-vs-zero PBO is
 *                                 structurally unfailable and is never a confident PASS.
 *   5. Harvey-Liu haircut       — Sharpe survives the multiple-testing haircut.
 *   6. surrogate / placebo      — real edge must beat a phase-randomized + block-bootstrap
 *                                 (and optional cross-sectional) null. Tests TEMPORAL /
 *                                 STRUCTURE edges (scored on Sharpe by default, since the
 *                                 surrogates preserve the marginal mean). THE methodological hero.
 *   7. consume-once holdout     — out-of-sample vault, scored exactly once.
 *
 * Academic anchors (full bibliography in docs/EDGE_SEARCH_SYNTHESIS.md §References):
 *   Bailey & López de Prado (Deflated Sharpe / PBO / CSCV / False Strategy Theorem),
 *   Harvey & Liu (multiple-testing haircut), Theiler et al. (surrogate / phase
 *   randomization), Politis & Romano (stationary/block bootstrap), Chen & Navet
 *   (random-lottery), López de Prado (MinBTL / consume-once holdout).
 *
 * Pure and deterministic (seeded). No I/O, no network, no committed-file edits.
 */

import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  summarizeReturnSeries,
  type CscvStrategyFoldReturns,
  type DeflatedSharpeRatio,
  type ReturnSeriesStatistic,
  type ReturnSeriesStats,
} from "../statistical-validation";
import {
  baselineScoreFromReturns,
  buildRandomLotteryBaseline,
  evaluateBaselineGate,
  type BaselineScore,
  type BaselineGateResult,
} from "../significance/baselines";
import { haircutSharpe, type HaircutResult, type HaircutMethod } from "../significance/haircut";
import {
  planHoldoutSplit,
  FinalHoldoutGuard,
  type HoldoutPlan,
} from "../significance/holdout";

/** summarizeReturnSeries uses Math.min(...values) and stack-overflows past ~1e5
 * elements. Anything longer is aggregated into this many blocks before summarizing. */
const MAX_SAFE_SERIES = 100_000;
const DAILY_AGG_TARGET_BLOCKS = 20_000;
const EPSILON = 1e-12;

export type Verdict = "PASS" | "KILL";

export interface GateOutcome {
  /** Canonical gate id, in evaluation order. */
  id:
    | "net_of_cost"
    | "baselines"
    | "deflated_sharpe"
    | "cpcv_pbo"
    | "haircut"
    | "surrogate"
    | "holdout";
  label: string;
  passed: boolean;
  /** One-line human reason (why it passed / what killed it). */
  reason: string;
  /** Gate-specific numeric detail for the evidence record. */
  detail: Record<string, number | string | boolean | null>;
}

export interface StrategyValidatorVerdict {
  verdict: Verdict;
  /** The first gate that failed (the binding constraint), or null if all passed. */
  bindingGate: GateOutcome["id"] | null;
  /** Every gate's outcome, in order. */
  perGate: GateOutcome[];
  /** Headline net-of-cost statistics for quick reading. */
  netStats: ReturnSeriesStats & { turnover: number; grossSharpe: number };
  /** The honest trial count actually used for DSR / haircut. */
  trialCount: number;
}

export interface CostModel {
  /** Per-side taker cost as a fraction. Default 0.0004 (4 bps/side perp). */
  takerPerSide?: number;
  /**
   * Position exposure per period in [-1, 1] (same length as gross returns), used to
   * derive turnover and charge |Δposition| × roundTrip on every change. If omitted,
   * the caller's series is treated as already net (turnover must then be supplied).
   */
  position?: readonly number[];
  /** Explicit turnover (Σ|Δposition|) if `position` is not supplied. */
  turnover?: number;
}

export interface BaselineSeries {
  /** Per-period market (buy-and-hold) returns over the SAME window as the strategy. */
  marketReturns?: readonly number[];
  /** Equal-weight panel returns (mean across assets) for cross-sectional strategies. */
  equalWeightReturns?: readonly number[];
  /** One-layer linear / DLinear baseline net returns, if available. */
  linearReturns?: readonly number[];
  /** Round-trip cost charged to baselines. Defaults to 2× takerPerSide. */
  roundTripCost?: number;
}

export interface SurrogatePanel {
  /** One return path per asset; surrogates are generated from these marginals. */
  assetReturns: readonly (readonly number[])[];
}

export interface SurrogateOptions {
  /** Number of surrogate panels to draw. Default 200. */
  iterations?: number;
  /** Block length for the stationary/block bootstrap. Default sqrt(n). */
  blockLength?: number;
  /** Also test a cross-sectional shuffle (destroys lead-lag / rotation). Default false. */
  crossSectional?: boolean;
  /** Panel whose marginals seed the surrogates. Falls back to the net series as a 1-asset panel. */
  panel?: SurrogatePanel;
  /**
   * Statistic the surrogate null is scored on. The surrogate tests TEMPORAL /
   * STRUCTURE edges, and phase/block surrogates preserve the marginal mean (so a
   * pure return-premium would falsely look like an artifact under "compoundReturn"
   * / "mean"). Defaults to "sharpe" when the outer statistic is "compoundReturn",
   * otherwise inherits the outer statistic.
   */
  statistic?: ReturnSeriesStatistic;
  seed?: number | string;
}

export interface StrategyValidatorOptions {
  /** The HONEST trial count (true N of distinct configs searched). REQUIRED, ≥1. */
  trialCount: number;
  /** Statistic for baselines / DSR. Default "compoundReturn" for cost realism. */
  statistic?: ReturnSeriesStatistic;
  cost?: CostModel;
  baselines?: BaselineSeries;
  /** Strategies×folds matrix for the canonical PBO (≥2 strategies, ≥2 folds). */
  cpcv?: { strategies: readonly CscvStrategyFoldReturns[]; trainFraction?: number };
  haircut?: { method?: HaircutMethod };
  surrogate?: SurrogateOptions;
  /** Holdout split fractions (consumed once via FinalHoldoutGuard). */
  holdout?: { holdoutFraction?: number; testFraction?: number; reason?: string; gitSha?: string | null };
  /** DSR deflated-probability bar. Default 0.95. */
  minDeflatedProbability?: number;
  /** PBO bar. Default 0.5 (must be strictly below). */
  maxPbo?: number;
  /** Maximum Sharpe haircut allowed. Default 0.99 (haircut Sharpe must stay > 0). */
  maxHaircut?: number;
  /** Placebo p-value bar (fraction of surrogates ≥ real). Default 0.05. */
  maxPlaceboP?: number;
  /** Number of OOS folds the holdout is scored over. Default 1. */
  seed?: number | string;
}

export type StrategyFn = () => readonly number[];

/**
 * Run the full anti-overfitting gauntlet on a strategy's GROSS per-period return
 * series (or a function that produces one). Returns a structured verdict with the
 * binding gate. A KILL is a valid, valuable outcome — the gates do not manufacture
 * survivors.
 */
export function validateStrategy(
  grossReturnsOrFn: readonly number[] | StrategyFn,
  options: StrategyValidatorOptions,
): StrategyValidatorVerdict {
  const grossReturns = finite(
    typeof grossReturnsOrFn === "function" ? grossReturnsOrFn() : grossReturnsOrFn,
  );
  const statistic = options.statistic ?? "compoundReturn";
  const trialCount = Math.max(1, Math.floor(options.trialCount));
  const seed = options.seed ?? "strategy-validator";

  // ---- Net-of-cost transform (turnover-aware) on the FULL series --------------
  // We cost the whole path once, then carve the final-holdout vault off so that
  // Gates 1–6 only ever see the in-sample (search/test) slice and Gate 7 scores
  // the untouched vault. Costing first keeps the position/turnover accounting
  // intact across the split boundary.
  const { netReturns: netReturnsFull, turnover } = applyCost(grossReturns, options.cost);

  // Carve the holdout FIRST so the in-sample gates can never read the vault.
  const holdoutPlan: HoldoutPlan = planHoldoutSplit({
    totalRows: netReturnsFull.length,
    holdoutFraction: options.holdout?.holdoutFraction ?? 0.15,
    testFraction: options.holdout?.testFraction ?? 0.15,
  });
  // In-sample slice = everything before the vault. The vault is the most-recent
  // contiguous block [finalHoldout.start, finalHoldout.end) and is reserved for
  // Gate 7 only. If the series is too short to carve a vault, the in-sample slice
  // is the whole series and Gate 7 degrades to "not binding".
  const inSampleReturns = netReturnsFull.slice(0, holdoutPlan.finalHoldout.start);
  const vaultReturns = netReturnsFull.slice(
    holdoutPlan.finalHoldout.start,
    holdoutPlan.finalHoldout.end,
  );
  // Everything below operates on the in-sample slice; `netReturns` is the name the
  // gate helpers expect. The vault is passed only to runHoldout.
  const netReturns = inSampleReturns;
  // Gross stats are scored on the SAME in-sample window as the net gates, so the
  // headline "gross vs net" comparison is apples-to-apples and never leaks the vault.
  const grossInSample = grossReturns.slice(0, holdoutPlan.finalHoldout.start);
  const grossStats = summarizeSafe(grossInSample);
  const netStatsBase = summarizeSafe(netReturns);
  const netStats = { ...netStatsBase, turnover, grossSharpe: grossStats.sharpe };
  const netScore = pick(netStatsBase, statistic);
  const netGate: GateOutcome = {
    id: "net_of_cost",
    label: "Net-of-cost summary",
    passed: netScore > EPSILON && netStatsBase.sharpe > 0,
    reason:
      netScore > EPSILON && netStatsBase.sharpe > 0
        ? `net ${statistic}=${netScore.toFixed(5)} (gross ${pick(grossStats, statistic).toFixed(5)}), turnover=${turnover.toFixed(1)}`
        : `gross-only / non-positive after cost: net ${statistic}=${netScore.toFixed(5)} ≤ 0 (turnover=${turnover.toFixed(1)}) — KILL`,
    detail: {
      netScore,
      grossScore: pick(grossStats, statistic),
      netSharpe: netStatsBase.sharpe,
      grossSharpe: grossStats.sharpe,
      turnover,
      sampleCount: netStatsBase.sampleCount,
    },
  };

  // ---- Gate 2: baselines (B&H + equal-weight + random-lottery + linear) -------
  const baselineGate = runBaselines(netReturns, turnover, statistic, options, seed);
  const baselinesOut: GateOutcome = {
    id: "baselines",
    label: "Baselines (B&H / equal-weight / random-lottery / linear)",
    passed: baselineGate.passed,
    reason: baselineGate.passed
      ? `beats all ${baselineGate.comparisons.length} baselines (worst margin ${baselineGate.worstMargin.toFixed(5)} vs ${baselineGate.worstBaselineId})`
      : `loses to baseline(s): ${baselineGate.reasons.join(", ")}`,
    detail: {
      candidateScore: baselineGate.candidateScore,
      worstMargin: baselineGate.worstMargin,
      worstBaselineId: baselineGate.worstBaselineId,
      baselineCount: baselineGate.comparisons.length,
    },
  };

  // ---- Gate 3: Deflated Sharpe at honest N -----------------------------------
  const dsr = computeDeflatedSharpeRatio(blocksForSummary(netReturns), { trialCount });
  const minDsrProb = options.minDeflatedProbability ?? 0.95;
  const dsrGate: GateOutcome = {
    id: "deflated_sharpe",
    label: `Deflated Sharpe (N=${trialCount})`,
    passed: dsr.deflatedProbability >= minDsrProb,
    reason: `DSR p=${dsr.deflatedProbability.toFixed(4)} ${dsr.deflatedProbability >= minDsrProb ? "≥" : "<"} ${minDsrProb} at honest N=${trialCount} (expMaxSharpe=${dsr.expectedMaxSharpe.toFixed(4)})`,
    detail: {
      deflatedProbability: dsr.deflatedProbability,
      sharpe: dsr.sharpe,
      expectedMaxSharpe: dsr.expectedMaxSharpe,
      trialCount,
      threshold: minDsrProb,
    },
  };

  // ---- Gate 4: CPCV / PBO ----------------------------------------------------
  const pboGate = runPbo(statistic, options);

  // ---- Gate 5: Harvey-Liu haircut --------------------------------------------
  const haircut = haircutSharpe({
    observedSharpe: netStatsBase.sharpe,
    sampleCount: blocksForSummary(netReturns).length,
    trialCount,
    method: options.haircut?.method ?? "bonferroni",
  });
  const maxHaircut = options.maxHaircut ?? 0.99;
  const haircutOut: GateOutcome = {
    id: "haircut",
    label: `Harvey-Liu haircut (${haircut.method})`,
    passed: haircut.haircutSharpe > 0 && haircut.haircut <= maxHaircut,
    reason: `haircut=${(haircut.haircut * 100).toFixed(1)}% ⇒ haircutSharpe=${haircut.haircutSharpe.toFixed(4)} (adjP=${haircut.adjustedPValue.toExponential(2)})`,
    detail: {
      haircut: haircut.haircut,
      haircutSharpe: haircut.haircutSharpe,
      adjustedPValue: haircut.adjustedPValue,
      pValue: haircut.pValue,
      method: haircut.method,
    },
  };

  // ---- Gate 6: surrogate / placebo (the hero) --------------------------------
  const surrogateOut = runSurrogate(netReturns, statistic, options, seed);

  // ---- Gate 7: consume-once holdout ------------------------------------------
  // Scored on the untouched vault carved off BEFORE Gates 1–6 ran. The vault was
  // never visible to any in-sample gate, so this is a genuine out-of-sample test.
  const holdoutOut = runHoldout(vaultReturns, statistic, options);

  const perGate: GateOutcome[] = [
    netGate,
    baselinesOut,
    dsrGate,
    pboGate,
    haircutOut,
    surrogateOut,
    holdoutOut,
  ];
  const binding = perGate.find((gate) => !gate.passed) ?? null;

  return {
    verdict: binding === null ? "PASS" : "KILL",
    bindingGate: binding?.id ?? null,
    perGate,
    netStats,
    trialCount,
  };
}

// ---------------------------------------------------------------------------
// Gate helpers
// ---------------------------------------------------------------------------

function applyCost(
  grossReturns: readonly number[],
  cost: CostModel | undefined,
): { netReturns: number[]; turnover: number } {
  const takerPerSide = Math.max(0, cost?.takerPerSide ?? 0.0004);
  const roundTrip = takerPerSide * 2;
  const position = cost?.position;

  if (position && position.length > 0) {
    // Charge |Δposition| × roundTrip on every position change. Entry from flat (0).
    let turnover = 0;
    const netReturns = grossReturns.map((ret, index) => {
      const prev = index === 0 ? 0 : (position[index - 1] ?? 0);
      const curr = position[index] ?? 0;
      const delta = Math.abs(curr - prev);
      turnover += delta;
      return ret - delta * roundTrip;
    });
    return { netReturns, turnover };
  }

  // No position path: treat caller series as gross per-trade and charge round-trip
  // per non-zero period (one entry+exit), or honor an explicit turnover.
  if (typeof cost?.turnover === "number" && Number.isFinite(cost.turnover)) {
    const perTradeCost = grossReturns.length > 0 ? (cost.turnover * roundTrip) / grossReturns.length : 0;
    return { netReturns: grossReturns.map((ret) => ret - perTradeCost), turnover: cost.turnover };
  }

  // Default: charge a round-trip on each non-zero (active) period.
  let turnover = 0;
  const netReturns = grossReturns.map((ret) => {
    if (Math.abs(ret) > EPSILON) {
      turnover += 1;
      return ret - roundTrip;
    }
    return ret;
  });
  return { netReturns, turnover };
}

function runBaselines(
  netReturns: readonly number[],
  turnover: number,
  statistic: ReturnSeriesStatistic,
  options: StrategyValidatorOptions,
  seed: number | string,
): BaselineGateResult {
  const baselines: BaselineScore[] = [];
  const cfg = options.baselines ?? {};
  const roundTrip = cfg.roundTripCost ?? Math.max(0, options.cost?.takerPerSide ?? 0.0004) * 2;

  if (cfg.marketReturns && cfg.marketReturns.length > 0) {
    // buy-and-hold = hold market, one round-trip charged at entry.
    const bh = [...cfg.marketReturns];
    bh[0] = (bh[0] ?? 0) - roundTrip;
    baselines.push(
      baselineScoreFromReturns("buy_and_hold", "Buy-and-hold", bh, { statistic, source: "market_series" }),
    );
    const tradeCount = Math.max(1, Math.round(turnover));
    baselines.push(
      buildRandomLotteryBaseline({
        barReturns: cfg.marketReturns,
        tradeCount,
        roundTripCost: roundTrip,
        seed,
        statistic,
      }),
    );
  }
  if (cfg.equalWeightReturns && cfg.equalWeightReturns.length > 0) {
    baselines.push(
      baselineScoreFromReturns("equal_weight", "Equal-weight", cfg.equalWeightReturns, {
        statistic,
        source: "equal_weight_panel",
      }),
    );
  }
  if (cfg.linearReturns && cfg.linearReturns.length > 0) {
    baselines.push(
      baselineScoreFromReturns("linear_one_layer", "One-layer linear", cfg.linearReturns, {
        statistic,
        source: "linear_baseline",
      }),
    );
  }

  if (baselines.length === 0) {
    // No baselines supplied: pass vacuously but mark it (caller chose to skip).
    return {
      statistic,
      candidateScore: pick(summarizeSafe(netReturns), statistic),
      candidatePositive: pick(summarizeSafe(netReturns), statistic) > 0,
      comparisons: [],
      beatsAll: true,
      worstMargin: 0,
      worstBaselineId: null,
      passed: true,
      reasons: ["no_baselines_supplied"],
    };
  }

  return evaluateBaselineGate({ candidateReturns: netReturns, baselines, statistic });
}

function runPbo(
  statistic: ReturnSeriesStatistic,
  options: StrategyValidatorOptions,
): GateOutcome {
  const maxPbo = options.maxPbo ?? 0.5;

  // PBO requires a GENUINE strategies×folds matrix (≥2 distinct, comparable
  // strategies). A self-derived candidate-vs-zero matrix is structurally
  // unfailable — the candidate (positive by gate 1) always out-ranks the all-zero
  // straw man on every split, so PBO=0 ⇒ a confident but meaningless PASS. We
  // therefore SKIP the gate (passed:true, skipped:true, non-binding) unless the
  // caller supplies a real matrix, matching how promotion-evaluator treats it.
  const strategies = options.cpcv?.strategies;
  const hasGenuineMatrix =
    !!strategies && strategies.length >= 2 && (strategies[0]?.folds.length ?? 0) >= 2;

  if (!hasGenuineMatrix) {
    return {
      id: "cpcv_pbo",
      label: "CPCV / PBO",
      passed: true,
      reason:
        "PBO skipped: no genuine strategies×folds matrix supplied " +
        "(a self-derived candidate-vs-zero PBO is structurally unfailable) — non-binding",
      detail: {
        pbo: null,
        foldCount: strategies?.[0]?.folds.length ?? 0,
        strategyCount: strategies?.length ?? 0,
        skipped: true,
        derived: false,
      },
    };
  }

  const pbo = estimateCscvPbo(strategies, {
    statistic,
    trainFraction: options.cpcv?.trainFraction ?? 0.5,
  });
  // A trustworthy CSCV PBO needs enough folds for the train/test split lattice;
  // fewer than 8 folds is the documented degenerate regime. We surface the flag
  // but (unlike the old self-derived path) only confident PASSes come from a real
  // matrix now, so a degenerate-but-real matrix still produces an honest verdict.
  const degenerate = pbo.foldCount < 8;
  return {
    id: "cpcv_pbo",
    label: "CPCV / PBO",
    passed: pbo.pbo < maxPbo,
    reason: `PBO=${pbo.pbo.toFixed(3)} ${pbo.pbo < maxPbo ? "<" : "≥"} ${maxPbo} over ${pbo.splitCount} splits${degenerate ? ` (DEGENERATE: ${pbo.foldCount}<8 folds)` : ""}`,
    detail: {
      pbo: pbo.pbo,
      foldCount: pbo.foldCount,
      splitCount: pbo.splitCount,
      medianLogit: pbo.medianLogit,
      degenerate,
      skipped: false,
      derived: false,
    },
  };
}

function runHoldout(
  vault: readonly number[],
  statistic: ReturnSeriesStatistic,
  options: StrategyValidatorOptions,
): GateOutcome {
  const guard = new FinalHoldoutGuard();
  // Consume the vault exactly once — re-scoring it would void the verdict.
  guard.consume({
    reason: options.holdout?.reason ?? "strategy-validator",
    gitSha: options.holdout?.gitSha ?? null,
    trialCount: Math.max(1, Math.floor(options.trialCount)),
  });
  const vaultStats = summarizeSafe(vault);
  const vaultScore = pick(vaultStats, statistic);
  const passed = vault.length > 0 && vaultScore > EPSILON && vaultStats.sharpe > 0;
  return {
    id: "holdout",
    label: "Consume-once holdout",
    passed,
    reason: vault.length === 0
      ? "holdout empty (series too short) — not binding"
      : `vault ${statistic}=${vaultScore.toFixed(5)}, Sharpe=${vaultStats.sharpe.toFixed(3)} over ${vault.length} rows ${passed ? "(OOS confirms)" : "(OOS FAILS) — KILL"}`,
    detail: {
      vaultScore,
      vaultSharpe: vaultStats.sharpe,
      vaultRows: vault.length,
      consumed: guard.isConsumed(),
    },
  };
}

// ---------------------------------------------------------------------------
// Surrogate / placebo — phase randomization, block bootstrap, cross-sectional
// ---------------------------------------------------------------------------

function runSurrogate(
  netReturns: readonly number[],
  statistic: ReturnSeriesStatistic,
  options: StrategyValidatorOptions,
  seed: number | string,
): GateOutcome {
  const cfg = options.surrogate ?? {};
  const iterations = Math.max(1, Math.floor(cfg.iterations ?? 200));
  const maxPlaceboP = options.maxPlaceboP ?? 0.05;

  // The surrogate null tests for TEMPORAL / STRUCTURE edges (regime, nonlinear,
  // lead-lag), NOT for a pure return-premium / carry edge. Phase randomization
  // and the block bootstrap PRESERVE the marginal mean (and phase preserves
  // variance/autocorrelation) by construction, so a return-premium scored on
  // `compoundReturn` lands at placeboP≈0.5 — a FALSE artifact flag. We therefore
  // default the surrogate's INTERNAL statistic to a Sharpe-type measure, which is
  // what the surrogate can actually discriminate. The caller may override via
  // `surrogate.statistic`; if they pass a pure-carry statistic, the reason string
  // flags that the gate is not the right test for a return-premium claim.
  const surrogateStatistic: ReturnSeriesStatistic =
    cfg.statistic ?? (statistic === "compoundReturn" ? "sharpe" : statistic);
  const carrySkew = surrogateStatistic === "compoundReturn" || surrogateStatistic === "mean";
  const realScore = pick(summarizeSafe(netReturns), surrogateStatistic);

  // Marginals to bootstrap from: the panel if supplied, else the net series itself.
  const panel = cfg.panel?.assetReturns ?? [netReturns];
  const blockLength = Math.max(
    1,
    Math.floor(cfg.blockLength ?? Math.round(Math.sqrt(Math.max(1, netReturns.length)))),
  );
  const random = createSeededRandom(cfg.seed ?? `${String(seed)}:surrogate`);

  const scoreOf = (series: readonly number[]): number =>
    pick(summarizeSafe(series), surrogateStatistic);

  // Phase-randomized surrogates: preserve power spectrum (autocorrelation) and
  // variance, destroy nonlinear/regime structure (Theiler et al. 1992).
  const phaseScores: number[] = [];
  // Block-bootstrap surrogates: preserve short-range autocorrelation, destroy
  // long-range regime structure (Politis & Romano 1994).
  const blockScores: number[] = [];
  for (let it = 0; it < iterations; it += 1) {
    const assetIdx = panel.length > 1 ? Math.floor(random() * panel.length) : 0;
    const marg = panel[assetIdx] ?? netReturns;
    phaseScores.push(scoreOf(phaseRandomize(marg, random)));
    blockScores.push(scoreOf(blockBootstrap(marg, blockLength, random)));
  }

  // Cross-sectional shuffle (rotation null): keep each asset's marginal path but
  // shuffle WHICH asset gets which path, destroying real lead-lag / rotation while
  // keeping marginal distributions. Only meaningful with a real panel.
  const crossScores: number[] = [];
  if (cfg.crossSectional && panel.length > 1) {
    for (let it = 0; it < iterations; it += 1) {
      const shuffled = crossSectionalShuffle(panel, random);
      // score the equal-weight portfolio of the shuffled panel
      crossScores.push(scoreOf(equalWeight(shuffled)));
    }
  }

  const allSurrogate = [...phaseScores, ...blockScores, ...crossScores];
  const geCount = allSurrogate.filter((s) => s >= realScore - EPSILON).length;
  const placeboP = allSurrogate.length > 0 ? geCount / allSurrogate.length : 1;
  const phaseMean = mean(phaseScores);
  const blockMean = mean(blockScores);
  const crossMean = crossScores.length > 0 ? mean(crossScores) : NaN;

  const passed = placeboP <= maxPlaceboP;
  const crossNote = crossScores.length > 0 ? `, xs-mean=${crossMean.toFixed(5)}` : "";
  // If the surrogate is (by caller override) scored on a mean/return-premium
  // statistic, phase/block surrogates preserve that quantity, so the gate cannot
  // discriminate a real carry edge — flag it loudly instead of silently mis-killing.
  const carryNote = carrySkew
    ? ` [WARNING: scored on '${surrogateStatistic}', which surrogates preserve — the surrogate gate tests temporal/structure edges, not pure carry/return-premium; treat as advisory]`
    : "";
  return {
    id: "surrogate",
    label: "Surrogate / placebo (phase + block" + (crossScores.length > 0 ? " + cross-sectional" : "") + ")",
    passed,
    reason: passed
      ? `real ${surrogateStatistic}=${realScore.toFixed(5)} beats null (placeboP=${placeboP.toFixed(3)} ≤ ${maxPlaceboP}; phase-mean=${phaseMean.toFixed(5)}, block-mean=${blockMean.toFixed(5)}${crossNote})${carryNote}`
      : `EDGE IS AN ARTIFACT: surrogates score equal-or-better (placeboP=${placeboP.toFixed(3)} > ${maxPlaceboP}; real ${surrogateStatistic}=${realScore.toFixed(5)} vs phase-mean=${phaseMean.toFixed(5)}, block-mean=${blockMean.toFixed(5)}${crossNote}) — KILL${carryNote}`,
    detail: {
      realScore,
      placeboP,
      phaseMean,
      blockMean,
      crossMean: Number.isFinite(crossMean) ? crossMean : null,
      iterations: allSurrogate.length,
      threshold: maxPlaceboP,
      statistic: surrogateStatistic,
      carryStatisticWarning: carrySkew,
    },
  };
}

/**
 * Phase-randomized surrogate (Theiler et al. 1992). FFT of the series, randomize
 * the phases (keeping the amplitude spectrum ⇒ same autocorrelation & variance),
 * inverse FFT. Destroys nonlinear / regime structure while preserving the linear
 * autocorrelation that a momentum/regime fitter feeds on.
 */
export function phaseRandomize(series: readonly number[], random: () => number): number[] {
  const x = finite(series);
  const n = x.length;
  if (n < 4) return [...x];
  const m = mean(x);
  const centered = x.map((v) => v - m);
  const { re, im } = dft(centered);
  // randomize phases symmetrically so the inverse transform stays real
  const newRe = new Array<number>(n).fill(0);
  const newIm = new Array<number>(n).fill(0);
  newRe[0] = re[0];
  newIm[0] = im[0];
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k += 1) {
    const amp = Math.hypot(re[k], im[k]);
    if (k === half && n % 2 === 0) {
      // Nyquist term must stay real
      newRe[k] = amp * (random() < 0.5 ? -1 : 1);
      newIm[k] = 0;
    } else {
      const phase = random() * 2 * Math.PI;
      newRe[k] = amp * Math.cos(phase);
      newIm[k] = amp * Math.sin(phase);
      newRe[n - k] = newRe[k];
      newIm[n - k] = -newIm[k];
    }
  }
  const surrogate = idft(newRe, newIm).map((v) => v + m);
  return surrogate;
}

/**
 * Stationary/block bootstrap surrogate (Politis & Romano 1994). Resamples
 * contiguous blocks of length `blockLength`, preserving short-range autocorrelation
 * but destroying long-range regime structure.
 */
export function blockBootstrap(
  series: readonly number[],
  blockLength: number,
  random: () => number,
): number[] {
  const x = finite(series);
  const n = x.length;
  if (n === 0) return [];
  const out: number[] = [];
  const L = Math.max(1, Math.floor(blockLength));
  while (out.length < n) {
    const start = Math.floor(random() * n);
    for (let offset = 0; offset < L && out.length < n; offset += 1) {
      out.push(x[(start + offset) % n] ?? 0);
    }
  }
  return out;
}

/**
 * Cross-sectional shuffle: permute which asset receives which return path. Keeps
 * every marginal distribution but destroys genuine cross-asset lead-lag / rotation.
 * (The rotation-specific null mandated for round-6 lead-lag tests.)
 */
export function crossSectionalShuffle(
  panel: readonly (readonly number[])[],
  random: () => number,
): number[][] {
  const idx = panel.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [idx[i], idx[j]] = [idx[j] ?? i, idx[i] ?? j];
  }
  return idx.map((i) => [...(panel[i] ?? [])]);
}

function equalWeight(panel: readonly (readonly number[])[]): number[] {
  if (panel.length === 0) return [];
  const len = Math.min(...panel.map((p) => p.length));
  const out: number[] = [];
  for (let t = 0; t < len; t += 1) {
    let sum = 0;
    for (const asset of panel) sum += asset[t] ?? 0;
    out.push(sum / panel.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------

/**
 * Forward DFT, computed in O(n log n) via FFT. Returns the same {re, im} spectrum
 * the naive O(n²) loop did (real input, full length-n spectrum). The heavy lifting
 * is `fft`, which is radix-2 Cooley-Tukey for power-of-2 lengths and Bluestein's
 * chirp-z transform for arbitrary lengths — so a 3288-point return series transforms
 * in milliseconds rather than the ~78s the naive DFT took.
 */
function dft(x: readonly number[]): { re: number[]; im: number[] } {
  const n = x.length;
  return fft(Float64Array.from(x), new Float64Array(n), false);
}

/** Inverse DFT, O(n log n) via the same FFT with the sign flipped and a 1/n scale. */
function idft(re: readonly number[], im: readonly number[]): number[] {
  const n = re.length;
  const out = fft(Float64Array.from(re), Float64Array.from(im), true);
  return Array.from(out.re, (v) => v / n);
}

/**
 * In-place-friendly complex FFT dispatcher. `inverse` only flips the twiddle sign;
 * the 1/n normalization is applied by the caller (idft) to match the old idft.
 * Power-of-2 lengths use radix-2; everything else uses Bluestein so non-power-of-2
 * series (the common case for real return windows) stay O(n log n).
 */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): { re: number[]; im: number[] } {
  const n = re.length;
  if (n === 0) return { re: [], im: [] };
  if (n === 1) return { re: [re[0]], im: [im[0]] };
  if ((n & (n - 1)) === 0) {
    fftRadix2(re, im, inverse);
    return { re: Array.from(re), im: Array.from(im) };
  }
  return fftBluestein(re, im, inverse);
}

/** Radix-2 Cooley-Tukey FFT, in place. Requires n to be a power of two. */
function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wReStep = Math.cos(ang);
    const wImStep = Math.sin(ang);
    for (let start = 0; start < n; start += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextWRe = wRe * wReStep - wIm * wImStep;
        wIm = wRe * wImStep + wIm * wReStep;
        wRe = nextWRe;
      }
    }
  }
}

/**
 * Bluestein's algorithm (chirp-z) for arbitrary length n. Converts the length-n DFT
 * into a convolution of size m (next power of two ≥ 2n-1) and evaluates it with the
 * radix-2 FFT, keeping the whole transform O(n log n) for non-power-of-2 n.
 */
function fftBluestein(re: Float64Array, im: Float64Array, inverse: boolean): { re: number[]; im: number[] } {
  const n = re.length;
  const sign = inverse ? 1 : -1;
  // chirp: w_k = exp(sign * i * π * k² / n)
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    // (k² mod 2n) keeps the angle accurate for large k
    const j = (k * k) % (2 * n);
    const ang = (sign * Math.PI * j) / n;
    cosT[k] = Math.cos(ang);
    sinT[k] = Math.sin(ang);
  }

  let m = 1;
  while (m < 2 * n - 1) m <<= 1;

  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  for (let k = 0; k < n; k += 1) {
    aRe[k] = re[k] * cosT[k] - im[k] * sinT[k];
    aIm[k] = re[k] * sinT[k] + im[k] * cosT[k];
  }

  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);
  // b is the conjugate chirp, mirrored so the linear convolution lines up.
  bRe[0] = cosT[0];
  bIm[0] = -sinT[0];
  for (let k = 1; k < n; k += 1) {
    bRe[k] = cosT[k];
    bIm[k] = -sinT[k];
    bRe[m - k] = cosT[k];
    bIm[m - k] = -sinT[k];
  }

  // Convolve a and b via FFT: c = IFFT(FFT(a) · FFT(b)).
  fftRadix2(aRe, aIm, false);
  fftRadix2(bRe, bIm, false);
  for (let k = 0; k < m; k += 1) {
    const cr = aRe[k] * bRe[k] - aIm[k] * bIm[k];
    const ci = aRe[k] * bIm[k] + aIm[k] * bRe[k];
    aRe[k] = cr;
    aIm[k] = ci;
  }
  fftRadix2(aRe, aIm, true);
  for (let k = 0; k < m; k += 1) {
    aRe[k] /= m;
    aIm[k] /= m;
  }

  // Multiply by the chirp again to recover the DFT.
  const outRe = new Array<number>(n);
  const outIm = new Array<number>(n);
  for (let k = 0; k < n; k += 1) {
    outRe[k] = aRe[k] * cosT[k] - aIm[k] * sinT[k];
    outIm[k] = aRe[k] * sinT[k] + aIm[k] * cosT[k];
  }
  return { re: outRe, im: outIm };
}

/**
 * Aggregate any series longer than MAX_SAFE_SERIES into ~DAILY_AGG_TARGET_BLOCKS
 * compounded blocks before it touches summarizeReturnSeries (whose Math.min(...values)
 * stack-overflows past ~1e5 elements). Shorter series pass through untouched.
 */
export function blocksForSummary(returns: readonly number[]): number[] {
  const x = finite(returns);
  if (x.length <= MAX_SAFE_SERIES) return x;
  const blockSize = Math.ceil(x.length / DAILY_AGG_TARGET_BLOCKS);
  const blocks: number[] = [];
  for (let i = 0; i < x.length; i += blockSize) {
    let logSum = 0;
    for (let j = i; j < Math.min(i + blockSize, x.length); j += 1) {
      logSum += Math.log1p(Math.max(-0.999999, x[j]));
    }
    blocks.push(Math.expm1(logSum));
  }
  return blocks;
}

function summarizeSafe(returns: readonly number[]): ReturnSeriesStats {
  return summarizeReturnSeries(blocksForSummary(returns));
}

function pick(stats: ReturnSeriesStats, statistic: ReturnSeriesStatistic): number {
  if (statistic === "mean") return stats.mean;
  if (statistic === "sharpe") return stats.sharpe;
  return stats.compoundReturn;
}

function finite(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function createSeededRandom(seed: number | string): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export type { DeflatedSharpeRatio, HaircutResult };
