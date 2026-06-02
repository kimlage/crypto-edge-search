<!--
Thanks for contributing to the falsification lab. A well-run KILL is a contribution; you are
not expected to ship a survivor. The one non-negotiable rule: CHANGE THE TARGET, NEVER THE
GATES. The gates only ever move toward MORE rigorous. Fill in the summary, then check every
box honestly — an unchecked box is fine if you explain why; a dishonest check is not.
See CONTRIBUTING_QUANT.md for the end-to-end flow and docs/GLOSSARY.md for any term below.
-->

## Summary
<!-- What does this PR do? Link the pre-registration issue. If it reports a verdict, give the one-liner: VERDICT | net Sharpe | binding gate | honest N | surrogate p. -->


## Type of change
- [ ] New hypothesis result (SURVIVE / PROMISING / KILL / DEFERRED)
- [ ] Reviving / hardening a prior KILL
- [ ] Gate attack / a STRICTER gate or null (never looser)
- [ ] New surrogate null
- [ ] Port to another market
- [ ] Reproduction of an existing verdict
- [ ] Docs / tooling only

## The one rule
- [ ] **Change the target, not the gates.** I did NOT weaken any gate, null, baseline, or cost to let a candidate through. If I changed a gate, it is **strictly more rigorous**, and I re-ran everything against it (described above).

## Methodology checklist (required for any result PR)
- [ ] **Honest N counted.** The trial count = the number of DISTINCT configs searched, counted before the search — not 1 and not the grid argmax. (Schema: `schemas/trial-ledger.schema.json`.)
- [ ] **Right null.** The surrogate destroys the specific structure I claim and preserves the rest; for a searched grid it is the **family-wise MAX-statistic** (rebuild every config on each surrogate, take the grid-max), not the single-best-config p. (Schema: `schemas/surrogate-run.schema.json`.)
- [ ] **Financing on full notional.** Borrow / funding / financing / risk-free are charged on the **FULL levered/short notional**, never on 1 unit. Leverage and short notional are explicit. (Schema: `schemas/cost-model.schema.json`.)
- [ ] **Consume-once holdout.** The holdout is carved off BEFORE any in-sample gate runs and is scored **exactly once**; I did not re-tune against it.
- [ ] **No tautological metric.** I used `sharpe(y − β·x)` for hedged alpha (not `sharpe(OLS residuals)`), and applied the h=0 leakage gate where relevant (contemporaneous ceiling reported; the strictly-lagged h≥1 leg clears the gates alone).
- [ ] **Verdict + binding gate reported.** The writeup states the verdict and exactly which gate was binding, with the numbers that produced it.

## Verification
- [ ] `npm test` is green.
- [ ] `npm run typecheck` is clean for any files I touched under `src/`.
- [ ] I reused the committed gate primitives (`validateStrategy` / `validateStrategyFamily` / per-domain `runGauntlet`) and did not re-implement a gate.

<!-- Be welcoming and be honest. We are not here to be right; we are here to find out. If your idea died, you did the job. -->
