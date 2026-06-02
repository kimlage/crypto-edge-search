/**
 * Public API for the "right null per claim" library.
 *
 * Pick a null through the registry (`getNullForClaim`) or reach for a specific
 * surrogate generator directly. Every generator here is pure and deterministic given
 * a seeded RNG. The linear/temporal generators (`phaseRandomize`, `blockBootstrap`,
 * `crossSectionalShuffle`) remain owned by ../validation/strategy-validator; this
 * library wraps them in the registry and adds the bespoke nulls below.
 */

// The registry: claim type -> approved surrogate(s) + rationale.
export {
  getNullForClaim,
  listClaimTypes,
  makeBracketNull,
  makeCalendarNull,
  blockBootstrapNull,
  shuffledVrpPlacebo,
  arMatchedPlacebo,
  type ClaimType,
  type NullEntry,
  type NullKind,
  type SeriesSurrogate,
  type PanelSurrogate,
} from "./null-registry";

// GARCH(1,1) zero-drift surrogate (vol clustering).
export {
  garchSurrogate,
  calibrateGarch,
  type GarchParams,
  type GarchSurrogateResult,
} from "./garch-surrogate";

// IAAFT surrogate (nonlinear structure on a non-Gaussian marginal).
export {
  iaaftSurrogate,
  type IaaftOptions,
  type IaaftResult,
} from "./iaaft";

// Calendar / event re-anchoring surrogate.
export {
  calendarReanchor,
  type CalendarReanchorInput,
  type CalendarReanchorResult,
} from "./calendar-reanchor";

// Bracket-on-surrogate null for path-dependent exits.
export {
  bracketOnSurrogate,
  applyBracket,
  pricePathFromReturns,
  type BracketSpec,
  type BracketTrade,
  type BracketOutcome,
  type BracketSurrogateOptions,
  type BracketSurrogateResult,
  type ReturnsSurrogateKind,
} from "./bracket-on-surrogate";

// Detector-on-surrogate null for chart patterns / S&R / candlesticks.
export {
  detectorOnSurrogate,
  type Detector,
  type DetectorScore,
  type DetectorOnSurrogateOptions,
  type DetectorOnSurrogateResult,
} from "./detector-on-surrogate";

// Low-level transform used by IAAFT (re-exported for callers that need it).
export { dft, idft } from "./fft";
