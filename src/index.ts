/**
 * Public API barrel for crypto-edge-search.
 *
 * This file re-exports the stable, supported surface of the library. Anything
 * that is not re-exported here is considered internal and may change without
 * notice. Imports are intentionally explicit so that the published type surface
 * is unambiguous and free of duplicate re-export conflicts (a few types — for
 * example {@link ExecutionCostModel}, {@link DeflatedSharpeRatio} and
 * {@link HaircutResult} — are surfaced by more than one module).
 */

// ---------------------------------------------------------------------------
// Strategy validation (headline entry point).
//
// `strategy-validator` already re-exports `DeflatedSharpeRatio`, `HaircutResult`
// and `ExecutionCostModel`, so it is treated as the canonical source for those
// three types to avoid ambiguous re-exports.
// ---------------------------------------------------------------------------
export {
  validateStrategy,
  phaseRandomize,
  blockBootstrap,
  crossSectionalShuffle,
  blocksForSummary,
} from "./lib/validation/strategy-validator";
export type {
  Verdict,
  ScientificVerdict,
  GateStatus,
  GateOutcome,
  StrategyValidatorVerdict,
  CostModel,
  BaselineSeries,
  SurrogatePanel,
  SurrogateOptions,
  StrategyValidatorOptions,
  StrategyFn,
  // Re-exported from their respective modules through strategy-validator.
  DeflatedSharpeRatio,
  HaircutResult,
  ExecutionCostModel,
} from "./lib/validation/strategy-validator";

// ---------------------------------------------------------------------------
// Strategy-family validation.
// ---------------------------------------------------------------------------
export { validateStrategyFamily } from "./lib/validation/strategy-family-validator";
export type {
  FamilyPanel,
  StrategyFamily,
  StrategyFamilyOptions,
  FamilyConfigScore,
  StrategyFamilyVerdict,
} from "./lib/validation/strategy-family-validator";

// ---------------------------------------------------------------------------
// Statistical-validation primitives.
//
// `DeflatedSharpeRatio` is surfaced via `strategy-validator` above (same
// declaration), so it is omitted from this block to keep re-exports unambiguous.
// ---------------------------------------------------------------------------
export {
  summarizeReturnSeries,
  computeProbabilisticSharpeRatio,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  analyzeThresholdSensitivity,
  estimateCscvPbo,
  expectedMaxStandardNormal,
  normalCdf,
  inverseNormalCdf,
} from "./lib/statistical-validation";
export type {
  ReturnSeriesStatistic,
  ReturnSeriesStats,
  ProbabilisticSharpeRatio,
  BlockBootstrapOptions,
  BlockBootstrapConfidenceInterval,
  ThresholdSensitivityCandidate,
  ThresholdSensitivityOptions,
  ThresholdSensitivityRow,
  ThresholdSensitivitySummary,
  CscvStrategyFoldReturns,
  CscvPboOptions,
  CscvSplitResult,
  CscvPboResult,
} from "./lib/statistical-validation";

// ---------------------------------------------------------------------------
// Execution cost model + cost charging.
//
// `ExecutionCostModel` is surfaced via `strategy-validator` above (same
// declaration), so it is omitted from this block to keep re-exports unambiguous.
// ---------------------------------------------------------------------------
export {
  DEFAULT_TAKER_MODEL,
  aprToPerPeriod,
  resolveShortBorrowApr,
  chargeExecutionCosts,
} from "./lib/cost/execution-cost-model";
export type {
  Bps,
  ShortBorrowAprByVenue,
  ChargeExecutionCostsInput,
  PerPeriodCostBreakdown,
  ChargeExecutionCostsResult,
} from "./lib/cost/execution-cost-model";

// ---------------------------------------------------------------------------
// Ledgers (trial + holdout).
// ---------------------------------------------------------------------------
export {
  InMemoryTrialStore,
  JsonlTrialStore,
  TrialLedger,
  stableConfigHash,
  canonicalize,
} from "./lib/ledger/trial-ledger";
export type {
  TrialRecord,
  TrialStore,
  RecordTrialInput,
  RecordTrialResult,
} from "./lib/ledger/trial-ledger";

export {
  InMemoryHoldoutStore,
  JsonlHoldoutStore,
  HoldoutLedger,
} from "./lib/ledger/holdout-ledger";
export type {
  HoldoutSlice,
  HoldoutConsumptionRecord,
  HoldoutStore,
  ConsumeHoldoutInput,
} from "./lib/ledger/holdout-ledger";

// ---------------------------------------------------------------------------
// Spec loaders + spec types.
// ---------------------------------------------------------------------------
export {
  SpecValidationError,
  parseSpecString,
  loadStrategySpec,
  loadDatasetSpec,
  loadCostSpec,
  costSpecToExecutionModel,
} from "./lib/spec/load-spec";
export type {
  SpecCadence,
  SpecStatistic,
  UniverseSpec,
  TrialCountPolicy,
  CostSpec,
  SurrogateSpec,
  HoldoutSpec,
  StrategySpec,
  DatasetRateLimits,
  DatasetSource,
  DatasetSpec,
} from "./lib/spec/types";

// ---------------------------------------------------------------------------
// Report renderers (verdict JSON/Markdown + evidence card).
// ---------------------------------------------------------------------------
export {
  renderVerdictJson,
  renderVerdictMarkdown,
} from "./lib/report/report-renderer";
export type {
  ReportMeta,
  VerdictJsonGate,
  VerdictJson,
} from "./lib/report/report-renderer";

export { renderEvidenceCard } from "./lib/report/evidence-card";
export type {
  EvidenceCardVerdict,
  EvidenceCardInput,
} from "./lib/report/evidence-card";

// ---------------------------------------------------------------------------
// IO parsers (returns + panel CSV).
// ---------------------------------------------------------------------------
export { parseReturnsCsv, parsePanelCsv } from "./lib/io/returns-csv";
export type {
  ParsedReturnsCsv,
  ParsedPanelCsv,
} from "./lib/io/returns-csv";

// ---------------------------------------------------------------------------
// Cadence helpers.
// ---------------------------------------------------------------------------
export {
  PeriodsPerYear,
  annualizeSharpe,
  annualizeReturn,
  periodsPerYearFor,
} from "./lib/cadence";
export type {
  Cadence,
  AnnualizedSharpe,
  AnnualizedReturn,
} from "./lib/cadence";

// ---------------------------------------------------------------------------
// Null registry + standardized surrogate generators (the "right null per claim").
// ---------------------------------------------------------------------------
export { getNullForClaim, listClaimTypes } from "./lib/nulls/null-registry";
export type { ClaimType, NullEntry } from "./lib/nulls/null-registry";
export { iaaftSurrogate } from "./lib/nulls/iaaft";
export { garchSurrogate } from "./lib/nulls/garch-surrogate";
export { calendarReanchor } from "./lib/nulls/calendar-reanchor";
export { bracketOnSurrogate } from "./lib/nulls/bracket-on-surrogate";
export { detectorOnSurrogate } from "./lib/nulls/detector-on-surrogate";

// ---------------------------------------------------------------------------
// Pre-registration (freeze a config to honestly claim N = 1).
// ---------------------------------------------------------------------------
export {
  buildPreregistration,
  assertPreregistered,
  PreregistrationError,
} from "./lib/prereg/preregistration";
export type {
  FrozenConfig,
  BuildPreregistrationInput,
  PreregistrationManifest,
} from "./lib/prereg/preregistration";

// ---------------------------------------------------------------------------
// Hypothesis spec (claim type, selection mode, baselines, null, holdout).
// ---------------------------------------------------------------------------
export {
  loadHypothesisSpec,
  requiresFamilyValidation,
} from "./lib/spec/hypothesis-spec";
