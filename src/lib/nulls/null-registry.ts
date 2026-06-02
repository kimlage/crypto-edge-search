/**
 * Null registry — the right null per claim.
 *
 * Picking the wrong surrogate is the most common way a backtest fools itself: a
 * calendar claim tested against a phase-randomized null, or a path-dependent exit
 * scored on a shuffled marginal, will "pass" for the wrong reason. This registry is
 * the single lookup that binds a CLAIM TYPE to the APPROVED surrogate generator(s)
 * for that claim, with a short rationale stating what the null preserves and destroys.
 *
 * The linear/temporal generators (`phaseRandomize`, `blockBootstrap`) and the
 * cross-sectional shuffle live in ../validation/strategy-validator and are the
 * committed source of truth — this module WRAPS them (uniform `(series, random)` /
 * panel signatures), never reimplements them. The bespoke nulls (`garchSurrogate`,
 * `iaaftSurrogate`, `calendarReanchor`, `bracketOnSurrogate`) come from this library.
 *
 * Pure & deterministic given the seeded `random` each generator receives.
 */

import {
  phaseRandomize,
  blockBootstrap,
  crossSectionalShuffle,
} from "../validation/strategy-validator";
import { garchSurrogate } from "./garch-surrogate";
import { iaaftSurrogate } from "./iaaft";
import { calendarReanchor, type CalendarReanchorInput } from "./calendar-reanchor";
import { bracketOnSurrogate, type BracketSpec } from "./bracket-on-surrogate";

/** The claim taxonomy this registry knows how to null. */
export type ClaimType =
  | "time_series_timing"
  | "cross_sectional_rotation"
  | "path_dependent_exit"
  | "vol_clustering"
  | "variance_risk_premium"
  | "calendar_event"
  | "macro_sentiment"
  | "nonlinear_structure";

/** A surrogate generator over a single series: `(series, random) => surrogate`. */
export type SeriesSurrogate = (series: readonly number[], random: () => number) => number[];

/** A surrogate generator over a cross-sectional panel of series. */
export type PanelSurrogate = (
  panel: readonly (readonly number[])[],
  random: () => number,
) => number[][];

/** Generator shape: a surrogate either re-orders one series or re-labels a panel. */
export type NullKind = "series" | "panel" | "structured";

export interface NullEntry {
  /** The claim type this entry serves. */
  claimType: ClaimType;
  /** Whether the generator consumes a single series, a panel, or a structured input. */
  kind: NullKind;
  /**
   * Human-readable name(s) of the approved surrogate generator(s) for this claim —
   * useful for logging which null was applied.
   */
  generators: string[];
  /** What the null PRESERVES and what it DESTROYS, and why it is the right one. */
  rationale: string;
  /**
   * The single-series generator, when `kind === "series"`. Absent for panel /
   * structured nulls, which need their own typed entry points (`panelSurrogate`,
   * the bespoke factories below).
   */
  surrogate?: SeriesSurrogate;
  /** The panel generator, when `kind === "panel"`. */
  panelSurrogate?: PanelSurrogate;
}

/** Default block length when a block-bootstrap null is asked for without one. */
function defaultBlockLength(n: number): number {
  return Math.max(2, Math.round(Math.sqrt(Math.max(n, 1))));
}

/**
 * A combined time-series-timing null: phase-randomization is the primary surrogate
 * (preserves the power spectrum / autocorrelation, destroys nonlinear regime
 * structure), with block-bootstrap available as the short-range-runs alternative.
 * Exposed as a `(series, random)` surrogate returning the phase-randomized path; the
 * block variant is reachable via `blockBootstrapNull`.
 */
const timeSeriesTimingSurrogate: SeriesSurrogate = (series, random) =>
  phaseRandomize(series, random);

/** Block-bootstrap null with an auto block length (preserves short-range runs). */
export const blockBootstrapNull: SeriesSurrogate = (series, random) =>
  blockBootstrap(series, defaultBlockLength(series.length), random);

/**
 * Variance-risk-premium placebo: a shuffled-VRP control. A VRP claim compares
 * implied vs realized variance; the placebo destroys the DATING that lines implied up
 * with the realized window by shuffling the series in time (a full Fisher-Yates
 * permutation), keeping the marginal of the VRP series but removing the privileged
 * alignment. Reuses the generic in-time shuffle rather than a bespoke generator.
 */
export const shuffledVrpPlacebo: SeriesSurrogate = (series, random) => {
  const out = series.filter((v) => Number.isFinite(v));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
};

/**
 * Macro / sentiment AR-matched placebo: generate a surrogate that matches the series'
 * linear AUTOREGRESSIVE structure but carries no genuine macro signal. We use the
 * phase-randomized surrogate, which preserves the power spectrum (equivalently the
 * full linear AR autocorrelation) while destroying any nonlinear sentiment response —
 * the standard "same persistence, no information" macro control.
 */
export const arMatchedPlacebo: SeriesSurrogate = (series, random) =>
  phaseRandomize(series, random);

/** Vol-clustering null: zero-drift GARCH surrogate (keeps clustering, kills drift). */
const volClusteringSurrogate: SeriesSurrogate = (series, random) =>
  garchSurrogate(series, random).surrogate;

/** Nonlinear-structure null: IAAFT (keeps exact marginal + spectrum, kills nonlinearity). */
const nonlinearStructureSurrogate: SeriesSurrogate = (series, random) =>
  iaaftSurrogate(series, random).surrogate;

const REGISTRY: Record<ClaimType, NullEntry> = {
  time_series_timing: {
    claimType: "time_series_timing",
    kind: "series",
    generators: ["phaseRandomize", "blockBootstrap"],
    rationale:
      "Phase-randomization (primary) preserves the power spectrum / autocorrelation " +
      "and variance while destroying nonlinear regime & timing structure; " +
      "block-bootstrap is the short-range-runs alternative. Use these for a market-" +
      "timing edge so the null keeps the linear dynamics a timer feeds on.",
    surrogate: timeSeriesTimingSurrogate,
  },
  cross_sectional_rotation: {
    claimType: "cross_sectional_rotation",
    kind: "panel",
    generators: ["crossSectionalShuffle"],
    rationale:
      "Permute WHICH asset receives which return path: keeps every asset's marginal " +
      "distribution but destroys genuine cross-asset lead-lag / rotation. The right " +
      "null for a rotation or relative-strength claim.",
    panelSurrogate: crossSectionalShuffle,
  },
  path_dependent_exit: {
    claimType: "path_dependent_exit",
    kind: "structured",
    generators: ["bracketOnSurrogate"],
    rationale:
      "Build a surrogate PRICE path from a phase-randomized / block-bootstrap returns " +
      "surrogate and apply the SAME TP/SL/time bracket to it. A bracket's P&L depends " +
      "on return ORDER, not the marginal, so the null must preserve the temporal " +
      "structure and re-run the identical exit logic.",
  },
  vol_clustering: {
    claimType: "vol_clustering",
    kind: "series",
    generators: ["garchSurrogate"],
    rationale:
      "Zero-drift GARCH(1,1) surrogate: preserves the volatility clustering (abs-return " +
      "autocorrelation) and the unconditional variance while imposing ~zero drift. If a " +
      "vol/momentum strategy still 'works' here, its edge was the clustering, not signal.",
    surrogate: volClusteringSurrogate,
  },
  variance_risk_premium: {
    claimType: "variance_risk_premium",
    kind: "series",
    generators: ["shuffledVrpPlacebo"],
    rationale:
      "Shuffled-VRP placebo: a full in-time permutation of the VRP series keeps its " +
      "marginal but destroys the privileged alignment of implied vs realized variance " +
      "windows. A generic shuffle control — if the 'premium' survives random dating, it " +
      "was not a genuine variance-risk premium.",
    surrogate: shuffledVrpPlacebo,
  },
  calendar_event: {
    claimType: "calendar_event",
    kind: "structured",
    generators: ["calendarReanchor"],
    rationale:
      "Calendar re-anchoring: keep the series and the per-observation bucket labels " +
      "(the seasonal shape) but reshuffle WHICH buckets are 'special', preserving the " +
      "count. Score a family-wise-MAX statistic across re-anchorings so the chosen-date " +
      "privilege must beat what date-mining alone would find.",
  },
  macro_sentiment: {
    claimType: "macro_sentiment",
    kind: "series",
    generators: ["arMatchedPlacebo"],
    rationale:
      "AR-matched placebo: a phase-randomized surrogate reproduces the series' linear " +
      "autoregressive persistence (same power spectrum) but carries no genuine macro " +
      "signal. 'Same persistence, no information' — the standard macro/sentiment control.",
    surrogate: arMatchedPlacebo,
  },
  nonlinear_structure: {
    claimType: "nonlinear_structure",
    kind: "series",
    generators: ["iaaftSurrogate"],
    rationale:
      "IAAFT: preserves the EXACT sorted-amplitude marginal (so fat tails survive) AND " +
      "the power spectrum (autocorrelation) while destroying nonlinear ordering beyond " +
      "second order. The right null when the claim is about nonlinear structure on a " +
      "non-Gaussian marginal.",
    surrogate: nonlinearStructureSurrogate,
  },
};

const KNOWN_CLAIM_TYPES = Object.keys(REGISTRY) as ClaimType[];

/**
 * Resolve a claim type to its approved null entry (generator(s) + rationale). Throws a
 * clear, enumerated error for an unknown claim type so a typo can never silently fall
 * back to the wrong surrogate.
 */
export function getNullForClaim(claimType: string): NullEntry {
  const entry = (REGISTRY as Record<string, NullEntry | undefined>)[claimType];
  if (!entry) {
    throw new Error(
      `Unknown claim type "${claimType}". Known claim types: ${KNOWN_CLAIM_TYPES.join(", ")}.`,
    );
  }
  return entry;
}

/** All claim types this registry can null. */
export function listClaimTypes(): ClaimType[] {
  return [...KNOWN_CLAIM_TYPES];
}

/**
 * Bespoke factory for the path-dependent-exit null: returns a closure that brackets a
 * returns series against its returns-surrogate distribution. Kept off the generic
 * `SeriesSurrogate` shape because it needs the bracket spec and returns a distribution.
 */
export function makeBracketNull(spec: BracketSpec) {
  return (returns: readonly number[], random: () => number) =>
    bracketOnSurrogate(returns, spec, random);
}

/**
 * Bespoke factory for the calendar-event null: returns a closure that re-anchors the
 * special buckets of a calendar-tagged series. Kept off the generic shape because it
 * consumes the {series, buckets, specialBuckets} structure.
 */
export function makeCalendarNull(input: CalendarReanchorInput) {
  return (random: () => number) => calendarReanchor(input, random);
}
