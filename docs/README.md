# Documentation Index — Crypto Edge Search

*[🧭 Wiki home (both domains)](INDEX.md) · [Polymarket domain](polymarket/README.md) · [Glossary](GLOSSARY.md) · [Methodology](METHODOLOGY.md) · [Unified synthesis](../SYNTHESIS.md)*

> **This page is the crypto domain index.** For the cross-domain wiki home (crypto **+** Polymarket, the
> concept map, and the reader journeys) start at **[INDEX.md](INDEX.md)**. The Polymarket campaign has its
> own index at **[polymarket/README.md](polymarket/README.md)**.

This is the documentation set for an open, rigor-first **crypto edge-search program** — a
**$0, reproducible falsification lab** for retail/quant crypto trading strategies. We do not
look for a story that fits a backtest; we try to **break** every technique with the same
committed anti-overfitting gauntlet, and we publish whatever survives **and** whatever dies.
A clean backtest is a starting point, not evidence.

## The audited headline

We have put **~111 distinct trading hypotheses** through the gauntlet — ~35 in prior rounds,
**58** in the parallelized 2026-06 eight-domain campaign, and 18 new entries from the $0
backlog — every one on **free public data at $0 cloud cost**.

After a deepening pass **and** an independent two-layer methodology audit
(audit-of-the-audit re-deriving each disputed number from the committed primitives):

> **0 clean SURVIVE · 1 weak PROMISING · everything else KILL. Nothing is deployable.**

> **Browse every verdict interactively:** [`dashboard.html`](dashboard.html) — a single self-contained page (search + filter by domain/verdict over one sortable table) generated from the `output/edgehunt-*/SUMMARY.md` ledgers by `tsx scripts/build-dashboard.ts`.

The sole remaining PROMISING lead is held back at the **PROMISING/SURVIVE boundary** — its
realized mean is not positive-with-significance at honest `N` on unseen data:

1. **Dated-futures basis carry** — **unlevered-thin only** (~4.9%/yr, `t=2.41`), which is
   below every multiple-testing bar; the levered headline was a **financing-leak artifact**
   (the harness charged the risk-free rate on 1 unit but borrow on the ~2.9×-levered notional).

> **2026-06-09 — XS Donchian downgraded PROMISING → KILL (survivorship).** The
> cross-sectional Donchian L/S lead looked beta-neutral with a real structure on the 30-name
> survivor panel (`p=0.009`), but rebuilt on the delisted-inclusive point-in-time universe
> (the honest 161 ever-members) it was substantially survivorship: the family-wise shuffle
> `p` moved **0.002 → 0.103** and the alpha `t` **3.22 → 1.60** (BTC beta → +0.36); the
> gauntlet binds on DSR 0.451 @N=72. See [`CHANGELOG_RESEARCH.md`](CHANGELOG_RESEARCH.md) and
> `scripts/edgehunt-donchian-pit/RESULTS.md`.

The audit was load-bearing. It **flipped three earlier PROMISINGs to KILL** — BTC exchange
reserve-depletion, the Q9 cross-sectional low-vol anomaly, and the O3 fee-revenue NVT
signal — all on the **same defect**: a single-best-config surrogate `p` masking a *searched*
grid (the correct null is the **family-wise MAX-statistic**), compounded by honest-`N`
Deflated Sharpe failure at the full grid. It also caught a **systemic financing leak** (zero
borrow charged on the levered/short notional) that had inflated the carry headlines.

**The meta-conclusion.** A right-null surrogate **PASS** proves the *structure/sign* is
non-random; it does **not** prove the realized *mean is positive-with-significance* at honest
`N` on unseen data. That gap **is** the PROMISING/SURVIVE boundary, and **no lead crossed
it.** The two prior carry "survivors" (perp funding carry, dated-futures basis) remain
**sub-risk-free regime trades**, not standing businesses.

This is therefore a **negative-results + methodology** contribution. The durable asset is
**not** a profitable strategy; it is the **methodology** — committed validation gates, the
right surrogate null per claim (including the family-wise MAX-statistic for searched grids),
an honest trial-count `N`, financing charged honestly, and a consume-once holdout — the stack
that killed ~109 in-sample Sharpes that would otherwise have looked like wins.

> **License:** MIT (see [`../LICENSE`](../LICENSE)).
> Every quantitative claim in these docs traces to a committed script and a JSON/Markdown
> artifact under `output/`; each domain's synthesis lives next to its scripts in
> `output/edgehunt-*/SUMMARY.md`, and the two independent audits in
> `output/edgehunt-audit/SUMMARY.md` + `output/edgehunt-audit-nb/SUMMARY.md`.

---

## The documentation set

| Document | One-line description |
|---|---|
| `README.md` (this file) | **Front door & index** — what the program is, the audited headline (~111 tested / 0 SURVIVE / 1 weak PROMISING / rest KILL), and the map to every other doc. |
| [`RESULTS.md`](RESULTS.md) | **The findings, as tables** — the per-hypothesis result tables and the headline tally, with the binding gate that killed (or capped) each hypothesis. |
| [`METHODOLOGY.md`](METHODOLOGY.md) | **How the killing was done** — the binding gauntlet order, the right surrogate null per claim (incl. the family-wise MAX-statistic for searched grids), honest `N`, honest financing, and the consume-once holdout. |
| [`GLOSSARY.md`](GLOSSARY.md) | **The terms, defined** — one clear paragraph each for DSR, PBO/CSCV, the Harvey-Liu haircut, the family-wise MAX-statistic, the surrogate/placebo null, honest `N`, the consume-once holdout, the matched-exposure baseline, beta-neutrality, h=0 leakage, and financing-on-full-notional. |
| [`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md) | **Findings & synthesis (the narrative)** — *where the edge is NOT and why*: the carry-is-sub-RF result, the recurring death patterns (coincident long-beta, the h=0 tautology, selection inflation), and the only non-exhausted frontiers. |
| [`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md) | **The 2026-06 domain campaign** — the parallelized fan-out of 58 hypotheses across eight domains, the deepening + two-layer audit that flipped 3 leads to KILL, and the per-domain KILL ledger as teaching cases. |
| [`REFERENCES.md`](REFERENCES.md) | **The bibliography** — every gate and every tested hypothesis mapped to its peer-reviewed (or working-paper) academic source. |
| [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) | **Re-run it yourself** — how to reproduce every number from a clean clone (scripts, free inputs, expected outputs; cloud spend $0). |
| [`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md) | **The reusable harness** — the gate primitives (`computeDeflatedSharpeRatio`, `estimateCscvPbo`, `blockBootstrapConfidenceInterval`, `summarizeReturnSeries`) chained by per-domain `runGauntlet` wrappers, plus the single-series `validateStrategy(...)` and searched-grid `validateStrategyFamily(...)` entry points so any future hypothesis is validated exactly the way these ~111 were. |
| [`METHODOLOGY_CONFORMANCE.md`](METHODOLOGY_CONFORMANCE.md) | **The audit bridge** — every methodological claim / gate mapped to the exact `file::function` that implements it and the test that covers it (no code ⇒ not implemented; no test ⇒ not trusted). |
| [`DISCLAIMER.md`](DISCLAIMER.md) | **Not investment advice** — research and software only; nothing in this repository is deployable. |
| [`ONCHAIN_FEASIBILITY.md`](ONCHAIN_FEASIBILITY.md) | **On-chain $0 feasibility report** — the verdict that a rigorous on-chain edge test is fully fundable at $0 (Coin Metrics Community + DefiLlama, no paid keys), with an honest null prior — and the recurring wall (free flow data covers only BTC+ETH, so the closest lead never generalized). |
| [`BACKLOG.md`](BACKLOG.md) | **The research backlog** — 155 testable trading-technique hypotheses across 8 domains (D1–D8), each carrying its right surrogate null, honest-`N` concern, the control that separates real edge from long-beta, an honest prior (KILL is a valid outcome), and references. |

---

## Suggested reading order (for a newcomer evaluating the rigor)

1. **This index** — get the audited headline (~111 tested, 0 SURVIVE, 1 weak PROMISING, the
   rest KILL; the methodology is the asset) and the lay of the land.
2. **[`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md)** — the narrative: read this to
   understand *what was learned and why nothing tradeable survived*. It frames everything
   else. (Start at the TL;DR, then "where the edge is NOT".)
3. **[`METHODOLOGY.md`](METHODOLOGY.md)** — now check *how* the claims were stress-tested.
   This is where the rigor lives: the binding gate order, the right null per claim (and why a
   surrogate PASS is not a mean-significance PASS), honest `N`, honest financing, and the
   consume-once holdout. **If you only audit one thing, audit this.**
4. **[`RESULTS.md`](RESULTS.md)** — the per-hypothesis tables, to see the gates applied
   ~111 times and which gate was binding for each kill or cap.
5. **[`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md)** — the deep dive on
   the 2026-06 campaign and the two-layer audit: read this to see the family-wise MAX-statistic
   and the financing-leak corrections actually flip labels (reserve, Q9, O3 → KILL).
6. **[`REFERENCES.md`](REFERENCES.md)** — confirm every gate and hypothesis is grounded in
   published work (Bailey & López de Prado, Harvey & Liu, Theiler et al., Politis & Romano,
   and the tested-hypothesis priors).
7. **[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)** — re-run the numbers yourself from a clean
   clone to verify they are real, not asserted (cloud spend $0).
8. **[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md)** — if you want to *reuse* the gauntlet
   on your own hypothesis: the gate primitives, the one-call `validateStrategy(...)` API, and
   the searched-grid `validateStrategyFamily(...)` entry point. (Conformance mapping in
   [`METHODOLOGY_CONFORMANCE.md`](METHODOLOGY_CONFORMANCE.md).)
9. **[`ONCHAIN_FEASIBILITY.md`](ONCHAIN_FEASIBILITY.md)** — the $0 on-chain feasibility
   verdict and the data-coverage wall that capped the closest lead.
10. **[`BACKLOG.md`](BACKLOG.md)** — the 155-hypothesis pipeline, if you want to challenge,
    revive, or extend the program against the *same* gates.

> **The one rule that makes the rest trustworthy: change the target, never the gates.**
> An empty parent pool under this gauntlet means the target lacks edge net of cost — not that
> the gauntlet is too strict. A right-null surrogate PASS establishes that a structure is
> non-random; only honest-`N` magnitude-significance on a consume-once holdout earns SURVIVE,
> and nothing here earned it.

---

> **License:** MIT — see [`../LICENSE`](../LICENSE).
