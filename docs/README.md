# Documentation Index — Crypto Edge Search

This is the documentation set for an open, rigor-first **crypto edge-search program**.
We tested **28 distinct crypto trading hypotheses** under a deliberately harsh
anti-overfitting validation harness. **26 were killed.** The **2 survivors** are
structural-carry strategies (perp funding carry, dated-futures basis): they pass the
full-sample gates but are **sub-risk-free in the current (2025–2026) regime** — a regime
trade, not a standing business.

This is a **negative-results + methodology** contribution. The durable asset is **not** a
profitable strategy; it is the **methodology**: committed validation gates, surrogate /
placebo controls, an honest trial-count `N`, and a consume-once holdout — the stack that
killed 26 in-sample Sharpes that would otherwise have looked like wins.

> **License:** MIT (see [`../LICENSE`](../LICENSE)).
> Every quantitative claim in these docs traces to a committed script and a JSON in
> `output/`; the raw chronological lab log is `docs/EVOLUTION_TRAINING_LOG.md` (internal,
> Portuguese — the public docs are 100% English and re-derive its numbers).

---

## The documentation set

| Document | One-line description |
|---|---|
| `README.md` (this file) | **Front door & index** — what the program is, the honest headline, and the map to every other doc. |
| [`RESULTS.md`](RESULTS.md) | **The findings, as tables** — the per-hypothesis result tables and the headline tally (28 tested / 26 killed / 2 sub-RF survivors), with the binding gate that killed each. |
| [`METHODOLOGY.md`](METHODOLOGY.md) | **How the killing was done** — the validation gates, the three load-bearing controls (honest `N`, surrogate/placebo, consume-once holdout), and the cost discipline. |
| [`REFERENCES.md`](REFERENCES.md) | **The bibliography** — every gate and every tested hypothesis mapped to its peer-reviewed (or working-paper) academic source. |
| [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) | **Re-run it yourself** — how to reproduce every number from a clean clone (scripts, inputs, expected outputs; cloud spend $0). |
| [`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md) | **Findings & Synthesis (the narrative)** — *where the edge is NOT and why*: the carry sub-RF / regime trade, the two-gate death pattern, the genetic-programming overfit, the rotation/event-flow "true descriptive kernel, no tradeable edge" meta-finding, and the only non-exhausted frontiers. Carries the load-bearing script/output index and the in-context bibliography. |
| [`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md) | **The reusable harness** — `validateStrategy(...)`, the single API that packages the gates so any future hypothesis is validated exactly the way these 28 were. |
| [`ONCHAIN_FEASIBILITY.md`](ONCHAIN_FEASIBILITY.md) | **On-chain $0 feasibility report** — verdict of the on-chain / dry-powder-flow scout (`scripts/onchain-scout/`; raw probes under `output/onchain-scout/`): a rigorous on-chain edge test is **fully fundable at $0** (Coin Metrics Community + DefiLlama, no paid keys), with an honest null prior (the data class most resembles the rotation tests C1/C2, both KILLed). The recommended test was subsequently run as the program's **28th hypothesis** (on-chain distribution-pressure POC) and was a **KILL** — see `RESULTS.md` §1 and §3 (Round 7). |

---

## Suggested reading order (for a newcomer evaluating the rigor)

1. **This index** — get the honest headline (28 / 26 / 2, sub-RF survivors, methodology
   is the asset) and the lay of the land.
2. **[`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md)** — the narrative: read this to
   understand *what was learned and why nothing tradeable survived*. It frames everything
   else. (Start at §0 TL;DR, then §2 "where the edge is NOT".)
3. **[`METHODOLOGY.md`](METHODOLOGY.md)** — now check *how* the claims were stress-tested.
   This is where the rigor lives: the gates, and especially the three controls (honest `N`,
   surrogate/placebo, consume-once holdout). If you only audit one thing, audit this.
4. **[`RESULTS.md`](RESULTS.md)** — the per-hypothesis tables, to see the gates applied 28
   times and which gate was binding for each kill.
5. **[`REFERENCES.md`](REFERENCES.md)** — confirm every gate and hypothesis is grounded in
   published work (Bailey & López de Prado, Harvey & Liu, Theiler et al., Politis & Romano,
   and the tested-hypothesis priors).
6. **[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)** — re-run the numbers yourself from a clean
   clone to verify they are real, not asserted.
7. **[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md)** — if you want to *reuse* the
   gauntlet on your own hypothesis: the one-call API and its smoke-run.
8. **[`ONCHAIN_FEASIBILITY.md`](ONCHAIN_FEASIBILITY.md)** — the $0 on-chain feasibility
   verdict: the design of the frontier whose recommended test became the **28th hypothesis**
   (KILL — see `RESULTS.md` §1 and §3, Round 7).

> **The one rule that makes the rest trustworthy: change the target, never the gates.**
> An empty parent pool under this gauntlet means the target lacks edge net of cost — not
> that the gauntlet is too strict.
