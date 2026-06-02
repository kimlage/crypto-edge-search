---
name: New hypothesis (pre-registration)
about: Pre-register a trading-technique hypothesis BEFORE you search, so honest N and the right null are fixed up front.
title: "[HYPOTHESIS] <one-line claim>"
labels: ["hypothesis", "pre-registration"]
assignees: []
---

<!--
This is a FALSIFICATION lab. A well-run KILL is a contribution; you are not expected to
find a survivor. Pre-register this hypothesis BEFORE you look at returns — that is what
keeps honest N and the right null honest. Fill in EVERY section; "not applicable" is an
acceptable answer, but a blank is not. The one rule: change the target, never the gates.
See CONTRIBUTING_QUANT.md for the end-to-end flow and docs/GLOSSARY.md for any term below.
-->

## 1. Hypothesis
<!-- One falsifiable sentence. What edge do you claim exists, in which market, over which horizon? State it so a KILL is meaningful. -->


## 2. Mechanism
<!-- WHY should this edge exist? The economic / behavioral / structural reason (risk premium, flow, friction, behavioral bias, microstructure). "A backtest looked good" is not a mechanism. A mechanism you can name is what separates a real prior from a data-mined shape. -->


## 3. Data + biases
<!-- The exact free, $0, key-less source(s) (provider + endpoint), the period and symbols, and the KNOWN biases the data carries: survivorship (are delisted names — LUNA, FTT — present?), look-ahead / point-in-time, regime coverage, vendor revisions. A surrogate cannot fix a biased panel; name the biases so they are never silent. (Schema: schemas/dataset-manifest.schema.json.) -->

- Source(s) (provider + endpoint, no API key):
- Period + symbols:
- Known biases (survivorship / look-ahead / regime / revisions):

## 4. Strategy family + EVERY config
<!-- Which strategy family, and the FULL searched grid — every parameter and every value, not just the one you intend to keep. The grid size IS your honest N (Section 5). Do not silently de-duplicate. (Schema: schemas/trial-ledger.schema.json.) -->

- Strategy family / signal:
- Parameter grid (each parameter → all values tried):
- Selection rule (how the grid-best is chosen):

## 5. Honest N
<!-- The HONEST N = the number of DISTINCT configs in Section 4, counted BEFORE the search — never 1, never the argmax. A "pre-registered" config only collapses N→1 if it was frozen from mechanism BEFORE you looked at returns and is NOT the grid argmax. State the number and how you counted it. -->

- Honest N (distinct configs):
- Is the kept config pre-registered (frozen before search) or the grid argmax?

## 6. Cost model
<!-- The realistic costs charged BEFORE any gate sees a return: taker per side (on every |Δposition|), maker/slippage if used, and financing/borrow charged on the FULL levered/short notional — never on 1 unit. State leverage and short notional explicitly. (Schema: schemas/cost-model.schema.json; engine: src/lib/cost/execution-cost-model.ts.) -->

- Taker per side / maker / slippage:
- Financing / borrow rate, leverage, and short notional (charged on full notional):

## 7. Baselines
<!-- The dumb things this must beat: buy-and-hold AND a matched-exposure benchmark (for any timing/overlay), equal-weight, the random-lottery control, and a one-layer linear model. For a cross-sectional book, state the beta-neutrality plan (book β≈0, alpha-t on the residual) using an honest OUT-OF-SAMPLE hedge beta, never an in-sample over-hedge. -->

- Baselines compared against:
- Beta-neutrality / matched-exposure plan (if timing or cross-sectional):

## 8. Right surrogate / placebo null
<!-- The surrogate must DESTROY the specific structure you claim while preserving everything else. Match the null to the claim: time-series timing → phase-randomization / block bootstrap; rotation / relative-value → cross-sectional shuffle; path-dependent exits → bracket-on-surrogate; vol-clustering → GARCH-simulated; variance premium → shuffled-VRP; calendar/event → calendar-reanchor. For ANY searched grid the null MUST be the family-wise MAX-statistic (rebuild every config on each surrogate, take the grid-max), not the single-best-config p. (Schema: schemas/surrogate-run.schema.json.) -->

- Null generator (matched to the claim):
- Family-wise MAX-statistic over the grid? (required for a searched grid):

## 9. Holdout plan
<!-- The consume-once holdout: which most-recent block is reserved, how it is carved off BEFORE any in-sample gate runs, and the promise that it is scored EXACTLY ONCE. Re-scoring the vault voids the verdict. State the holdout/test fractions. -->

- Reserved holdout block (fractions, carved before in-sample gates):
- Consume-once acknowledgement (scored exactly once):

## 10. Expected failure mode
<!-- Honest prior: how do you EXPECT this to die? (coincident long-beta, the h=0 tautology, selection inflation at honest N, carry sub-risk-free, a too-powerful surrogate, survivorship in the holdout.) Naming the most likely binding gate up front is good science, not pessimism — most hypotheses KILL, and that is the point. -->

- Most likely binding gate and why:

---

<!-- Reminder: you may test any target you like, but you may NOT weaken a gate to let it through. The gates only ever move toward MORE rigorous. -->
- [ ] I have read CONTRIBUTING_QUANT.md and will not weaken any gate to manufacture a pass.
- [ ] Honest N counts every distinct config (Section 4 = Section 5), not 1 and not the argmax.
- [ ] The surrogate null destroys my claimed structure, and is family-wise for any searched grid.
- [ ] The holdout is reserved before in-sample gates and will be scored exactly once.
