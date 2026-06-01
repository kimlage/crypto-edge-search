/**
 * Unified promotion evaluator (roadmap Plan #3).
 *
 * Each committed significance module gates ONE dimension of the
 * "is this winner real?" question. In isolation any one of them is gameable:
 * a +0.5% edge on 6 trades clears a naive return filter, a many-trials noise
 * winner clears a single-test Sharpe, a path-fragile edge clears a composite
 * walk-forward score. The literature (Bailey/López de Prado, Harvey & Liu,
 * Hansen, Chen & Navet) is explicit that defensibility comes from APPLYING ALL
 * the gates together — the conjunction, not the disjunction.
 *
 * This module composes them into a single decision:
 *
 *   A1  baselines      — beat buy&hold, random-lottery and the linear model,
 *                        net of costs, and be positive.
 *   A0  minBtl         — the sample is long enough that the observed Sharpe
 *                        clears the selection-luck bar for the TRUE trial count.
 *   A0/A2 deflatedSharpe — the Deflated Sharpe probability, deflated by the TRUE
 *                        N, is >= the threshold (default 0.95).
 *   A3/A4 cpcvPbo      — (if CPCV paths supplied) PBO <= threshold (default 0.4)
 *                        AND the pooled multi-path Deflated Sharpe >= threshold.
 *   A5  haircut        — the Harvey-Liu haircut Sharpe is still positive after
 *                        the multiple-testing adjustment.
 *   A5  spa            — (if a competitor panel supplied) Hansen's SPA p-value
 *                        < alpha, i.e. the win is not data-snooping.
 *
 * A candidate is `promotable` ONLY if every applicable gate passes. Every
 * failing gate appends a human-readable reason, so a rejection is auditable.
 *
 * Pure and deterministic: it does NOT train, backtest or do any I/O. Randomized
 * sub-gates (random-lottery, SPA bootstrap) are seeded.
 */

import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
  type ReturnSeriesStatistic,
} from "../statistical-validation";
import {
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  evaluateBaselineGate,
  type BaselineGateResult,
  type BaselineScore,
} from "./baselines";
import { evaluateMinBtl, type MinBtlResult } from "./trial-count";
import {
  cpcvDeflatedSharpe,
  cpcvPbo,
  summarizeCpcvPaths,
  type CpcvPathReturns,
  type CpcvPathSummary,
  type CpcvStrategyPaths,
} from "./cpcv-paths";
import { haircutSharpe, type HaircutMethod, type HaircutResult } from "./haircut";
import { superiorPredictiveAbility, type SpaResult, type SpaStrategy } from "./spa";

const DEFAULT_DSR_THRESHOLD = 0.95;
const DEFAULT_PBO_THRESHOLD = 0.4;
const DEFAULT_ALPHA = 0.05;
const EPSILON = 1e-12;

export interface PromotionThresholds {
  /** Minimum Deflated Sharpe probability (true N). Default 0.95. */
  dsrThreshold?: number;
  /** Maximum tolerated Probability of Backtest Overfitting. Default 0.4. */
  pboThreshold?: number;
  /** Significance level for the SPA test. Default 0.05. */
  alpha?: number;
  /** Candidate must beat each baseline by at least this margin. Default 0. */
  baselineMinMargin?: number;
  /** Haircut multiple-testing method. Default "bonferroni" (harshest). */
  haircutMethod?: HaircutMethod;
}

export interface PromotionEvaluationInput {
  /** Optional candidate identifier for the evidence record. */
  candidateId?: string;
  /**
   * Candidate net-of-cost per-trade (or per-block) return series. This drives
   * baselines, the Sharpe used by MinBTL, the single-series Deflated Sharpe and
   * the haircut.
   */
  candidateReturns: readonly number[];
  /**
   * Number of observations the Sharpe was computed on (trades or blocks). When
   * omitted, the finite length of `candidateReturns` is used.
   */
  sampleCount?: number;
  /** TRUE number of distinct configs tried (the N every deflation uses). */
  trialCount: number;
  /**
   * Per-bar market returns over the evaluation window (close-to-close
   * fractions). Used to synthesize the buy&hold and random-lottery baselines.
   * When absent, only explicit `extraBaselines` are gated.
   */
  barReturns?: readonly number[];
  /** Round-trip cost as a fraction (e.g. 0.0028). Applied to the baselines. */
  roundTripCost?: number;
  /** Average holding length in bars for the random-lottery turnover match. */
  averageHoldingBars?: number;
  /**
   * Extra explicit baselines (e.g. the linear one-layer model's net returns,
   * built via `baselineScoreFromReturns`). Always gated when present.
   */
  extraBaselines?: readonly BaselineScore[];
  /** Comparison statistic for the baseline gate. Default compoundReturn. */
  baselineStatistic?: ReturnSeriesStatistic;
  /** CPCV multi-path OOS returns for the candidate (enables A3/A4). */
  cpcvPaths?: readonly CpcvPathReturns[];
  /**
   * Competitor strategies for the CPCV PBO matrix (needs >= 2 strategies). The
   * candidate is added automatically; supply rivals here.
   */
  cpcvCompetitors?: readonly CpcvStrategyPaths[];
  /**
   * Competitor panel of per-period excess-vs-benchmark returns for the SPA test
   * (enables A5 SPA). The candidate's excess series is supplied separately.
   */
  spaPanel?: readonly SpaStrategy[];
  /**
   * The candidate's own per-period excess-vs-benchmark returns for SPA. When
   * omitted but a panel is supplied, `candidateReturns` is used as the excess.
   */
  spaCandidateExcess?: readonly number[];
  thresholds?: PromotionThresholds;
  /** Seed for the randomized sub-gates (random-lottery, SPA). */
  seed?: number | string;
}

export interface BaselineGateReport {
  applicable: boolean;
  passed: boolean;
  result: BaselineGateResult | null;
}

export interface DeflatedSharpeGateReport {
  applicable: boolean;
  passed: boolean;
  threshold: number;
  trialCount: number;
  sampleCount: number;
  sharpe: number;
  deflatedProbability: number;
}

export interface MinBtlGateReport {
  applicable: boolean;
  passed: boolean;
  result: MinBtlResult;
}

export interface CpcvPboGateReport {
  applicable: boolean;
  passed: boolean;
  pbo: number;
  pboThreshold: number;
  pooledDeflatedProbability: number;
  dsrThreshold: number;
  pathSummary: CpcvPathSummary | null;
}

export interface HaircutGateReport {
  applicable: boolean;
  passed: boolean;
  result: HaircutResult;
}

export interface SpaGateReport {
  applicable: boolean;
  passed: boolean;
  alpha: number;
  result: SpaResult | null;
}

export interface PromotionGates {
  baselines: BaselineGateReport;
  deflatedSharpe: DeflatedSharpeGateReport;
  minBtl: MinBtlGateReport;
  cpcvPbo: CpcvPboGateReport;
  haircut: HaircutGateReport;
  spa: SpaGateReport;
}

export interface PromotionSummary {
  candidateId: string | null;
  sampleCount: number;
  trialCount: number;
  candidateSharpe: number;
  candidateCompoundReturn: number;
  candidateMean: number;
  /** Number of applicable gates that passed. */
  gatesPassed: number;
  /** Number of applicable gates total. */
  gatesApplicable: number;
}

export interface PromotionEvaluation {
  promotable: boolean;
  gates: PromotionGates;
  reasons: string[];
  summary: PromotionSummary;
}

/**
 * Run every applicable rigor gate, in order, and combine them. A candidate is
 * `promotable` only if ALL applicable gates pass; each failing gate adds a
 * reason. Always-applicable gates: baselines (A1), MinBTL (A0), Deflated Sharpe
 * (A0/A2) and the haircut (A5). Conditionally applicable: CPCV-PBO/pooled DSR
 * (A3/A4) when `cpcvPaths` are supplied, and SPA (A5) when a `spaPanel` is
 * supplied.
 */
export function evaluatePromotion(input: PromotionEvaluationInput): PromotionEvaluation {
  const thresholds = input.thresholds ?? {};
  const dsrThreshold = finiteOr(thresholds.dsrThreshold, DEFAULT_DSR_THRESHOLD);
  const pboThreshold = finiteOr(thresholds.pboThreshold, DEFAULT_PBO_THRESHOLD);
  const alpha = finiteOr(thresholds.alpha, DEFAULT_ALPHA);
  const baselineStatistic = input.baselineStatistic ?? "compoundReturn";
  const haircutMethod = thresholds.haircutMethod ?? "bonferroni";
  const seed = input.seed ?? "promotion-evaluator";

  const candidateReturns = input.candidateReturns.filter((value) => Number.isFinite(value));
  const stats = summarizeReturnSeries(candidateReturns);
  const sampleCount = Math.max(
    0,
    Math.floor(input.sampleCount ?? stats.sampleCount),
  );
  const trialCount = Math.max(1, Math.floor(input.trialCount));

  const reasons: string[] = [];

  // --- A1: baselines -------------------------------------------------------
  const baselines = buildBaselines(input, baselineStatistic, seed);
  let baselineReport: BaselineGateReport;
  if (baselines.length === 0) {
    baselineReport = { applicable: false, passed: false, result: null };
    reasons.push("baselines_unavailable");
  } else {
    const result = evaluateBaselineGate({
      candidateReturns,
      baselines,
      statistic: baselineStatistic,
      minMargin: finiteOr(thresholds.baselineMinMargin, 0),
      requirePositive: true,
    });
    baselineReport = { applicable: true, passed: result.passed, result };
    if (!result.passed) {
      for (const reason of result.reasons) reasons.push(`baselines:${reason}`);
    }
  }

  // --- A0: Minimum Backtest Length ----------------------------------------
  const minBtlResult = evaluateMinBtl({
    trialCount,
    sampleCount,
    observedSharpe: stats.sharpe,
  });
  const minBtlReport: MinBtlGateReport = {
    applicable: true,
    passed: minBtlResult.sufficientLength,
    result: minBtlResult,
  };
  if (!minBtlResult.sufficientLength) {
    reasons.push(`minBtl:${minBtlResult.reason}`);
  }

  // --- A0/A2: Deflated Sharpe (true N) ------------------------------------
  const dsr = computeDeflatedSharpeRatio(candidateReturns, { trialCount });
  const dsrPassed = dsr.deflatedProbability >= dsrThreshold - EPSILON;
  const deflatedSharpeReport: DeflatedSharpeGateReport = {
    applicable: true,
    passed: dsrPassed,
    threshold: dsrThreshold,
    trialCount,
    sampleCount: dsr.sampleCount,
    sharpe: dsr.sharpe,
    deflatedProbability: dsr.deflatedProbability,
  };
  if (!dsrPassed) {
    reasons.push(
      `deflatedSharpe:below_threshold(${dsr.deflatedProbability.toFixed(4)}<${dsrThreshold})`,
    );
  }

  // --- A3/A4: CPCV PBO + pooled Deflated Sharpe ---------------------------
  const cpcvReport = evaluateCpcvGate(input, trialCount, pboThreshold, dsrThreshold);
  if (cpcvReport.applicable && !cpcvReport.passed) {
    if (cpcvReport.pbo > pboThreshold + EPSILON) {
      reasons.push(`cpcvPbo:pbo_above_threshold(${cpcvReport.pbo.toFixed(4)}>${pboThreshold})`);
    }
    if (cpcvReport.pooledDeflatedProbability < dsrThreshold - EPSILON) {
      reasons.push(
        `cpcvPbo:pooled_dsr_below_threshold(${cpcvReport.pooledDeflatedProbability.toFixed(4)}<${dsrThreshold})`,
      );
    }
  }

  // --- A5: Haircut Sharpe --------------------------------------------------
  const haircutResult = haircutSharpe({
    observedSharpe: stats.sharpe,
    sampleCount,
    trialCount,
    method: haircutMethod,
  });
  const haircutPassed = haircutResult.haircutSharpe > EPSILON;
  const haircutReport: HaircutGateReport = {
    applicable: true,
    passed: haircutPassed,
    result: haircutResult,
  };
  if (!haircutPassed) {
    reasons.push(
      `haircut:non_positive_after_adjustment(${haircutResult.haircutSharpe.toFixed(4)})`,
    );
  }

  // --- A5: Superior Predictive Ability ------------------------------------
  const spaReport = evaluateSpaGate(input, candidateReturns, alpha, seed);
  if (spaReport.applicable && !spaReport.passed && spaReport.result) {
    reasons.push(
      `spa:not_significant(p=${spaReport.result.pValue.toFixed(4)}>=${alpha})`,
    );
  }

  const gates: PromotionGates = {
    baselines: baselineReport,
    deflatedSharpe: deflatedSharpeReport,
    minBtl: minBtlReport,
    cpcvPbo: cpcvReport,
    haircut: haircutReport,
    spa: spaReport,
  };

  const applicableGates = [
    baselineReport,
    deflatedSharpeReport,
    minBtlReport,
    cpcvReport,
    haircutReport,
    spaReport,
  ].filter((gate) => gate.applicable);
  const gatesPassed = applicableGates.filter((gate) => gate.passed).length;
  const promotable = reasons.length === 0 && applicableGates.every((gate) => gate.passed);

  return {
    promotable,
    gates,
    reasons,
    summary: {
      candidateId: input.candidateId ?? null,
      sampleCount,
      trialCount,
      candidateSharpe: stats.sharpe,
      candidateCompoundReturn: stats.compoundReturn,
      candidateMean: stats.mean,
      gatesPassed,
      gatesApplicable: applicableGates.length,
    },
  };
}

function buildBaselines(
  input: PromotionEvaluationInput,
  statistic: ReturnSeriesStatistic,
  seed: number | string,
): BaselineScore[] {
  const baselines: BaselineScore[] = [];
  const barReturns = input.barReturns?.filter((value) => Number.isFinite(value)) ?? [];

  if (barReturns.length > 0) {
    baselines.push(
      buildBuyAndHoldBaseline({
        barReturns,
        roundTripCost: input.roundTripCost,
        statistic,
      }),
    );
    const tradeCount = Math.max(
      1,
      Math.floor(input.sampleCount ?? input.candidateReturns.length),
    );
    baselines.push(
      buildRandomLotteryBaseline({
        barReturns,
        tradeCount,
        averageHoldingBars: input.averageHoldingBars,
        roundTripCost: input.roundTripCost,
        statistic,
        seed: `${String(seed)}:lottery`,
      }),
    );
  }

  if (input.extraBaselines) {
    for (const baseline of input.extraBaselines) baselines.push(baseline);
  }

  return baselines;
}

function evaluateCpcvGate(
  input: PromotionEvaluationInput,
  trialCount: number,
  pboThreshold: number,
  dsrThreshold: number,
): CpcvPboGateReport {
  const paths = input.cpcvPaths?.filter((path) => path.returns.length > 0) ?? [];
  if (paths.length < 2) {
    return {
      applicable: false,
      passed: false,
      pbo: 0,
      pboThreshold,
      pooledDeflatedProbability: 0,
      dsrThreshold,
      pathSummary: null,
    };
  }

  const pathSummary = summarizeCpcvPaths(paths);
  const pooledDeflatedProbability = cpcvDeflatedSharpe(paths, trialCount);

  // PBO needs the candidate plus >= 1 competitor over the same paths.
  const candidateStrategy: CpcvStrategyPaths = {
    id: input.candidateId ?? "candidate",
    paths,
  };
  const strategies: CpcvStrategyPaths[] = [
    candidateStrategy,
    ...(input.cpcvCompetitors ?? []),
  ];
  const pboResult = cpcvPbo(strategies);
  // If there is no competitor panel, PBO is undefined (splitCount 0); fall back
  // to a self-consistency PBO of 0 (no overfitting observable) so the pooled DSR
  // alone governs. With competitors, the real PBO governs.
  const pbo = pboResult.splitCount > 0 ? pboResult.pbo : 0;

  const passed =
    pbo <= pboThreshold + EPSILON &&
    pooledDeflatedProbability >= dsrThreshold - EPSILON;

  return {
    applicable: true,
    passed,
    pbo,
    pboThreshold,
    pooledDeflatedProbability,
    dsrThreshold,
    pathSummary,
  };
}

function evaluateSpaGate(
  input: PromotionEvaluationInput,
  candidateReturns: readonly number[],
  alpha: number,
  seed: number | string,
): SpaGateReport {
  const panel = input.spaPanel ?? [];
  if (panel.length === 0) {
    return { applicable: false, passed: false, alpha, result: null };
  }

  const candidateExcess = input.spaCandidateExcess ?? candidateReturns;
  const candidateStrategy: SpaStrategy = {
    id: input.candidateId ?? "candidate",
    excessReturns: candidateExcess,
  };
  // Ensure the candidate is in the tested set so SPA gates the actual winner.
  const hasCandidate = panel.some((strategy) => strategy.id === candidateStrategy.id);
  const strategies = hasCandidate ? panel : [candidateStrategy, ...panel];

  const result = superiorPredictiveAbility(strategies, {
    seed: `${String(seed)}:spa`,
  });
  const passed = result.pValue < alpha - EPSILON;
  return { applicable: true, passed, alpha, result };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
