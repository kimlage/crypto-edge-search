---
name: audit-result
description: Adversarially audit a PROMISING/SURVIVE result to confirm it is real before believing it. Re-runs the family-wise surrogate, re-charges financing on the full notional, and checks the honest-N / pre-registration discipline. Use whenever a strategy looks like it might have edge.
---

# Skill: audit-result

Default to **refute**. This is the two-layer check that flipped three "PROMISING" leads to KILL.

## The known error classes to hunt
1. **Single-config surrogate over a searched grid.** The harness may report a surrogate p that shuffles only
   the *best* config. Re-run the **family-wise MAX-statistic** null: per surrogate draw, apply one shared
   randomization to the **whole grid** and take the grid-max; compare the real grid-best to surr95(max). If
   real-best < surr95, the surrogate gate **FAILS** → KILL. (Coherent shared-realization null, not an
   independent-per-config one, which is extreme-value inflated.)
2. **Neighborhood-argmax masquerading as N=1.** Check the "pre-registered"/"canonical" config was frozen from
   mechanism *before* the search. If it is the argmax of a searched grid, honest N = grid size, not 1 — re-run
   Deflated Sharpe @ the full grid N + the Harvey–Liu haircut.
3. **Financing leak.** For any short/levered book, re-charge borrow on the **full** short/levered notional and
   re-check Sharpe + DSR. An uncharged leg is the most common headline inflation.
4. **Look-ahead / h=0.** Confirm the edge survives with strictly-lagged (h≥1) signals; the contemporaneous
   version is a tautology.
5. **In-sample over-hedge.** A beta-hedge fit on the same holdout flatters the residual — use an out-of-sample
   hedge beta.
6. **Wrong-power null / regime artifact / tautological metric.** A null with no power proves nothing; an edge
   concentrated in one period is not robust; `sharpe(OLS residuals)` is ~0 by construction.

## Procedure
Re-derive the single decisive check yourself (reuse the original scripts; write to `scripts/<name>-audit/` and
`output/<name>-audit/`). For each material concern state **CONFIRMED** (with the corrected number/verdict) or
**DISMISSED** (why). Then give the post-audit verdict — it can only become *more* skeptical, never less.

`VERDICT-AFTER-AUDIT: <CONFIRMED <orig> | DOWNGRADE-TO-PROMISING | DOWNGRADE-TO-KILL> | family-wise surrogate p <p> | honest-N DSR <p> | financing-corrected Sharpe <x> | the one number that settles it`
