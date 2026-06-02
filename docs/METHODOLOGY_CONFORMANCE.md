# Methodology Conformance

This document is the audit bridge between **what the methodology claims** and **what
the code actually does**. Every methodological claim / gate in
[`METHODOLOGY.md`](METHODOLOGY.md) is mapped here to the exact source file and function
that implements it, and to the test that covers it. If a row has no code, it does not
count as implemented; if it has no test, it does not count as trusted.

All paths are repo-relative. The committed gauntlet order is:

> **net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout**

The orchestrator that wires these in order (and assigns the **first failing gate** as
the binding one) is
[`validateStrategy`](../src/lib/validation/strategy-validator.ts) — the single API.
Verdict scheme: **SURVIVE / PROMISING / KILL / DEFERRED** (the validator emits the
binary `PASS`/`KILL` gate decision; `PROMISING` and `DEFERRED` are human verdicts
applied on top of the gate evidence — see [`RESULTS.md`](RESULTS.md)).

## Quick legend

- **Claim / gate** — the methodological promise being made.
- **Implemented by** — `file::function` (repo-relative).
- **Covered by test** — `file::"test name"` (repo-relative).

---

## 1. Conformance table

| # | Claim / gate | Implemented by (`file::function`) | Covered by test (`file::"name"`) |
|---|---|---|---|
| 1 | **net_of_cost** — turnover-aware net return; gross-only or non-positive-after-cost ⇒ KILL. Costs are charged inside the score, not bolted on. | `src/lib/validation/strategy-validator.ts::applyCost` + the `net_of_cost` gate in `::validateStrategy`; per-trade view `src/lib/reorientation/turnover.ts::computeNetEdge` | `src/lib/validation/strategy-validator.test.ts::"the in-sample net stat is scored on the search slice, not the full series"` and `::"KILLs a pure-noise series"`; `src/lib/reorientation/turnover.test.ts::"charges cost per trade and exposes the per-trade edge"` |
| 2 | **baselines** — beat buy-and-hold + equal-weight + random-lottery + one-layer linear, net of cost, before any edge is credited. | `src/lib/significance/baselines.ts::evaluateBaselineGate` (+ `buildRandomLotteryBaseline`, `buildBuyAndHoldBaseline`, `baselineScoreFromReturns`); wired via `src/lib/validation/strategy-validator.ts::runBaselines` | `src/lib/significance/baselines.test.ts::"blocks a pure-noise candidate that loses to buy-and-hold"` and `::"blocks a noise candidate that does not beat the random-lottery bar"` |
| 3 | **deflated_sharpe** — DSR at an EXPLICIT honest `trialCount` (true N), deflating the observed Sharpe by the expected max of N true-zero trials (Bailey & López de Prado, False Strategy Theorem). | `src/lib/statistical-validation.ts::computeDeflatedSharpeRatio` (+ `expectedMaxStandardNormal`, `computeProbabilisticSharpeRatio`); wired via the `deflated_sharpe` gate in `src/lib/validation/strategy-validator.ts::validateStrategy` | `src/lib/statistical-validation.test.ts::"refuses to certify the best of many true-zero strategies once N is injected (A2)"` and `::"still certifies a genuine edge after deflating by the same N (A2)"`; `src/lib/validation/strategy-validator.test.ts::"flips a borderline DSR PASS→KILL when the honest trialCount rises"` |
| 4 | **block_bootstrap** — block/stationary bootstrap confidence intervals on the headline statistic, preserving short-range autocorrelation (Politis & Romano). *Planned as a standalone wrapper gate in the next phase;* the primitive is committed and is already consumed inside the surrogate null. | Primitive: `src/lib/statistical-validation.ts::blockBootstrapConfidenceInterval`; surrogate-side resampler: `src/lib/validation/strategy-validator.ts::blockBootstrap` (consumed in `::runSurrogate`) | `src/lib/statistical-validation.test.ts::"builds deterministic block bootstrap confidence intervals"` |
| 5 | **cpcv_pbo** — Probability of Backtest Overfitting via CSCV over a genuine strategies×folds (or strategies×paths) matrix; PBO < bar. Self-derived candidate-vs-zero PBO is structurally unfailable, so it is SKIPPED (non-binding) unless a real matrix is supplied. | `src/lib/statistical-validation.ts::estimateCscvPbo`; multi-path substrate `src/lib/significance/cpcv-paths.ts::cpcvPbo` / `summarizeCpcvPaths`; gate wiring `src/lib/validation/strategy-validator.ts::runPbo` | `src/lib/statistical-validation.test.ts::"estimates simple CSCV/PBO from strategy fold returns"`; `src/lib/significance/cpcv-paths.test.ts::"estimates PBO over the strategies x paths matrix"`; `src/lib/validation/strategy-validator.test.ts::"skips the PBO gate (passed+skipped) instead of a confident self-vs-zero PASS"` |
| 6 | **haircut** — Harvey & Liu multiple-testing haircut; the Sharpe must survive the trial-count-adjusted p-value (Bonferroni / Holm / BHY). | `src/lib/significance/haircut.ts::haircutSharpe` (single best) + `::haircutSharpePanel` (whole panel); wired via the `haircut` gate in `src/lib/validation/strategy-validator.ts::validateStrategy` | `src/lib/significance/haircut.test.ts::"haircuts hard once there are many trials"`, `::"BHY is more lenient than Bonferroni"`, `::"ranks by significance and flags only genuine survivors (Holm)"` |
| 7 | **surrogate** — the methodological hero. Real edge must beat a phase-randomized + block-bootstrap (+ optional cross-sectional) null on the discriminating statistic; surrogates ≥ real ⇒ EDGE IS AN ARTIFACT ⇒ KILL. | `src/lib/validation/strategy-validator.ts::runSurrogate` (+ `phaseRandomize`, `blockBootstrap`, `crossSectionalShuffle`) | `src/lib/validation/strategy-validator.test.ts::"certifies a genuine cross-sectional rotation edge (planted edge → PASS)"`, `::"phase randomization preserves variance and lag-1 autocorrelation"`, `::"the block bootstrap preserves the marginal mean"` |
| 7a | **family-wise MAX-statistic** — for a SEARCHED grid the surrogate / multiple-testing null must be the grid-MAX statistic: rebuild every config on each null draw, take the grid-max, compare the real best to the surr95 of those maxima (NOT a single-best-config p). | `src/lib/significance/spa.ts::superiorPredictiveAbility` (Hansen SPA — studentized **max** statistic, `testStatistic = max_k √n·d̄_k/ω_k`) + `::romanoWolfStepwise` (FWER step-down over the max) | `src/lib/significance/spa.test.ts::"does not flag a panel of pure-noise strategies"`, `::"flags a genuine outperformer hidden among noise"`; `::"rejects nothing in pure noise"`, `::"rejects a clear outperformer"` |
| 8 | **holdout** — consume-once final vault, carved off BEFORE gates 1–7 run, scored exactly once; a second read voids the verdict. | `src/lib/significance/holdout.ts::planHoldoutSplit` + `FinalHoldoutGuard` (+ `assertSearchDoesNotTouchHoldout`); wired via `src/lib/validation/strategy-validator.ts::runHoldout` (carve in `::validateStrategy`) | `src/lib/significance/holdout.test.ts::"carves disjoint contiguous search/test/holdout blocks with the vault most recent"`, `::"refuses a second consumption"`; `src/lib/validation/strategy-validator.test.ts::"mutating the vault rows does not change any in-sample gate detail"` |
| 9 | **cost model** — per-side taker charged on every position change (`\|Δposition\| × roundTrip`); financing/borrow charged on the FULL levered/short notional (the dated-futures leak fix); carry fees on BOTH legs in + out. | `src/lib/validation/strategy-validator.ts::applyCost` (turnover × round-trip); financing-on-full-notional carry: `src/lib/reorientation/funding-carry.ts::simulateFundingCarry` (entry/exit/rebalance fees on both legs) | `src/lib/reorientation/funding-carry.test.ts::"charges entry + exit fees on a single round trip"`, `::"triggers a rebalance fee when the basis drifts past the threshold"`; `src/lib/reorientation/turnover.test.ts::"charges cost per trade and exposes the per-trade edge"` |
| 10 | **trial count / MinBTL ledger** — the true N injected into DSR/haircut comes from a distinct-config ledger, never `1`; plus the Minimum Backtest Length bar (sample must be long enough that the winner beats selection luck). | `src/lib/significance/trial-count.ts::effectiveTrialCount` / `countDistinctTrials` / `evaluateMinBtl` / `summarizeTrialSelection` | `src/lib/significance/trial-count.test.ts::"counts unique DNA ids and falls back to trial id"`, `::"takes the largest of rows, explicit and floor"`, `::"flags a short sample as insufficient for many trials"` |
| 11 | **cadence ledger** — every reported Sharpe carries an explicit periods-per-year so a per-period Sharpe is never silently mis-annualized. | `src/lib/cadence.ts::annualizeSharpe` / `annualizeReturn` / `PeriodsPerYear` | `src/lib/cadence.test.ts::"scales a per-period Sharpe by the square root of periods per year"`, `::"annualizes the SAME per-period Sharpe differently across cadences"`, `::"refuses to annualize without an explicit positive cadence"` |
| 12 | **deterministic / seeded randomness** — every null, bootstrap and Monte-Carlo is reproducible from a seed; no `Date.now`, no unseeded RNG in the gate path. | Seeded PRNG `createSeededRandom` in `src/lib/statistical-validation.ts`, `src/lib/significance/baselines.ts`, `src/lib/significance/spa.ts`, `src/lib/validation/strategy-validator.ts` | `src/lib/significance/spa.test.ts::"is deterministic for a given seed"`; `src/lib/statistical-validation.test.ts::"builds deterministic block bootstrap confidence intervals"` |

---

## 2. Two decisive audit lessons → where they live in code

These are the two mistakes the audit caught and the methodology now hard-codes against.

### Lesson 1 — a searched grid needs the FAMILY-WISE MAX-statistic

> For a SEARCHED grid the surrogate/null must be the family-wise **MAX**-statistic:
> rebuild every config on each null draw, take the **grid-max**, and compare the real
> best config to the **surr95** of those maxima — not a single-best-config p-value.
> A single-config p-value silently ignores the N-1 other configs you tried and
> manufactures false survivors.

- **Implemented by:** `src/lib/significance/spa.ts::superiorPredictiveAbility`
  computes the studentized **maximum** across the panel
  (`testStatistic = max_k √n·d̄_k/ω_k`) and the SPA p-value as the fraction of
  **bootstrap maxima** ≥ observed — i.e. the grid-max compared against the null
  distribution of grid-maxima. `::romanoWolfStepwise` extends this to a step-down
  family-wise-error-controlled set ("which configs are genuinely superior").
- **Why the single-config surrogate gate isn't enough on its own:** the
  `surrogate` gate in `src/lib/validation/strategy-validator.ts::runSurrogate`
  scores ONE series against its own null. That is correct for a *single* pre-registered
  config, but for a grid the binding test is the MAX-stat in `spa.ts`; the conformance
  contract is that a searched result is reported against the family-wise max, and the
  honest N is injected into DSR/haircut (rows 3, 6, 10) on top of it.
- **Covered by:** `src/lib/significance/spa.test.ts` — the panel of pure-noise
  strategies is NOT flagged (max-stat null absorbs the luckiest config), while a
  genuine outperformer hidden among noise IS flagged.

### Lesson 2 — charge financing/borrow on the FULL levered/short notional

> Financing/borrow must be charged on the FULL levered/short notional. The dated-
> futures leak charged the risk-free rate on 1 unit while running ~2.95× levered,
> which collapsed once corrected (illustratively, Sharpe 1.64 → 0.69).

- **Implemented by:** `src/lib/reorientation/funding-carry.ts::simulateFundingCarry`
  charges taker fees on **both legs** at entry and exit (round-trip = 4 leg-fees) and
  a per-leg rebalance fee on basis drift, and pays/collects funding on the held
  notional every interval — financing is on the notional actually carried, not on a
  nominal 1 unit. `::stressFundingCarry` then charges a sustained negative-funding
  regime plus a counterparty-gap capital hit on the full position.
- **General per-change cost:** `src/lib/validation/strategy-validator.ts::applyCost`
  charges `|Δposition| × roundTrip` on the actual (possibly >1, possibly short)
  position path, so a levered/short book pays cost on its true notional turnover.
- **Covered by:** `src/lib/reorientation/funding-carry.test.ts` (both-leg fees, stress
  survivability) and the cost path in `src/lib/validation/strategy-validator.test.ts`.

---

## 3. Notes, caveats and known gaps

- **`block_bootstrap` as a standalone gate is planned, not yet a separate gauntlet
  step.** The committed gauntlet runs the block bootstrap *inside* the `surrogate`
  null (`strategy-validator.ts::blockBootstrap`), and the standalone CI primitive
  (`statistical-validation.ts::blockBootstrapConfidenceInterval`) is committed and
  tested. Promoting it to an explicit, separately-binding wrapper gate between
  `deflated_sharpe` and `cpcv_pbo` is scheduled for the next phase; until then this
  row is "primitive committed + consumed in surrogate", not "standalone binding gate".
- **`cpcv_pbo` is intentionally non-binding without a genuine matrix.** A self-derived
  candidate-vs-zero PBO is structurally unfailable (PBO = 0 always), so
  `runPbo` SKIPS the gate unless ≥2 distinct strategies × ≥2 folds are supplied. A
  confident PASS only comes from a real strategies×folds / strategies×paths matrix.
- **`PROMISING` / `DEFERRED` are human verdicts.** The code emits a per-gate
  `PASS`/`KILL` and a binding gate; the four-way verdict (`SURVIVE` / `PROMISING` /
  `KILL` / `DEFERRED`) is applied by a human reading the gate evidence and recorded in
  [`RESULTS.md`](RESULTS.md). The gates do not manufacture survivors; a KILL is a valid
  and valuable outcome.
- **Determinism is a conformance requirement, not a convenience.** Any gate that draws
  a null must be seeded and reproducible; see row 12.

For the prose methodology and the right-null-per-claim table, see
[`METHODOLOGY.md`](METHODOLOGY.md); for the gate API, see
[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md); for the bibliography behind each
gate, see [`REFERENCES.md`](REFERENCES.md). This project is research/software only —
see [`DISCLAIMER.md`](DISCLAIMER.md).
