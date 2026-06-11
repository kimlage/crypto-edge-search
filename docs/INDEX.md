# Wiki Home — The $0 Falsification Lab

*You are here: **Home**. · [Crypto domain](README.md) · [Polymarket domain](polymarket/README.md) · [Glossary](GLOSSARY.md) · [Methodology](METHODOLOGY.md) · [Unified synthesis](../SYNTHESIS.md)*

This is the **navigation hub** for a reproducible, **$0-cloud-spend** research program that pushes trading
hypotheses through **one committed anti-overfitting gauntlet** on free public data, across **two domains**
(crypto + prediction markets), and publishes the negative results as the deliverable.

> **What** — one fixed gate chain, run on every hypothesis. **Why** — to *break* techniques, not to fit a
> story to a backtest. **Verdict** — **0 clean SURVIVE, 0 deployable edge** across both domains; the asset is
> the **methodology + the map of where the edge is NOT**. **License: MIT.**

---

## The unified funnel

```
184+ distinct hypotheses & mechanisms
   ├─ ~111 crypto (8 domains: direction, TA, cross-section, carry, rotation, on-chain, sentiment, calendar)
   └─  73 Polymarket (35 backlog + 22 reverse-engineering + 16 external-information leads)
        │
        ▼  one committed gauntlet — first failure is the binding gate
   net_of_cost(+financing) → baselines → deflated_sharpe@honestN → block_bootstrap
                           → cpcv_pbo → harvey_liu_haircut → right-null surrogate → consume-once holdout
        │
        ▼
   0 clean SURVIVE · 1 weak PROMISING (crypto) · everything else KILL · rest DEFERRED ($0-undecidable)
```

Plus a **29-test credibility battery**, a forensic falsification of **5 viral "Claude + copy-trade = print
money" claims**, and **3 pre-registered forward tests** — the only honest path to any remaining lead. A
planted-edge **[positive control](GLOSSARY.md#positive-control)** proves the harness *would* SURVIVE a real
+8% edge, so "0 SURVIVE" is a property of the *markets*, not a dead gauntlet.

---

## The two domains

| Domain | Hub page | What was tested | Headline verdict |
|---|---|---|---|
| **Crypto** (BTC/USDT & cross-section) | **[README.md](README.md)** | ~111 hypotheses across 8 domains — fixed, adaptive, and genetically-evolved | **0 SURVIVE, 1 weak PROMISING**, rest KILL (XS Donchian fell to KILL 2026-06-09 — survivorship); the one real thing — [carry](GLOSSARY.md#carry) — is a sub-risk-free *regime trade* |
| **Polymarket** (prediction markets) | **[polymarket/README.md](polymarket/README.md)** | 35-hypothesis backlog, copy-trading, calibration, arbitrage, money-mgmt, 22 reverse-engineering mechanisms, 16 external-info leads | **0 deployable edge** — and here we can *prove* it, because every market resolves to a ground-truth label |

---

## Concept index (the glossary, by anchor)

Every load-bearing term is one paragraph in **[GLOSSARY.md](GLOSSARY.md)**. Jump straight to one:

**The gate terms** —
[DSR / Deflated Sharpe](GLOSSARY.md#dsr--deflated-sharpe-ratio) ·
[PBO / CSCV](GLOSSARY.md#pbo--cscv--probability-of-backtest-overfitting-via-combinatorially-symmetric-cross-validation) ·
[Harvey-Liu haircut](GLOSSARY.md#harvey-liu-haircut) ·
[Family-wise MAX](GLOSSARY.md#family-wise-max-statistic) ·
[Surrogate / placebo null](GLOSSARY.md#surrogate--placebo-null) ·
[Honest N](GLOSSARY.md#honest-n) ·
[Consume-once holdout](GLOSSARY.md#consume-once-holdout) ·
[Matched-exposure baseline](GLOSSARY.md#matched-exposure-baseline) ·
[Beta-neutrality](GLOSSARY.md#beta-neutrality) ·
[h=0 leakage](GLOSSARY.md#h0-leakage) ·
[Financing on full notional](GLOSSARY.md#financing-on-full-notional)

**The verdict scheme** —
[KILL](GLOSSARY.md#kill) · [PROMISING](GLOSSARY.md#promising) · [SURVIVE](GLOSSARY.md#survive) · [DEFERRED](GLOSSARY.md#deferred)

**Prediction-market terms** —
[Calibrated-Bernoulli null](GLOSSARY.md#calibrated-bernoulli) ·
[Wallet-label-shuffle null](GLOSSARY.md#wallet-label-shuffle) ·
[Favorite-longshot bias](GLOSSARY.md#favorite-longshot) ·
[Overround / negRisk](GLOSSARY.md#overround) ·
[Carry](GLOSSARY.md#carry) ·
[Stouffer z](GLOSSARY.md#stouffer-z) ·
[Positive control](GLOSSARY.md#positive-control)

---

## Reader journeys — pick your path

**🧭 Newcomer (what is this / why care)** →
[Unified synthesis](../SYNTHESIS.md) → [Crypto results](RESULTS.md) → [Polymarket bottom line](polymarket/README.md#bottom-line).
*Read the conclusion first; the rigor comes after.*

**🔬 Auditor (is the rigor real)** →
[Methodology](METHODOLOGY.md) (the binding gate order + right-null discipline) →
[Glossary](GLOSSARY.md) (the terms it assumes) →
[Validation harness](VALIDATION_HARNESS.md) (the gate primitives) →
[Methodology conformance](METHODOLOGY_CONFORMANCE.md) (each claim → the `file::function` that implements it) →
[Polymarket honest evaluation & audit](polymarket/EVALUATION.md). *If you audit one thing, audit METHODOLOGY.*

**🤖 Agent / machine reader** →
the machine-readable assets below (the two `results-ledger.json` files + `SNAPSHOT.json`), then
[scripts/campaign-D/README.md](../scripts/campaign-D/README.md) for the runnable Polymarket pipeline and
[VALIDATION_HARNESS.md](VALIDATION_HARNESS.md) for the `validateStrategy(...)` entry point.

**🔁 Reproducer (re-run the numbers)** →
[Crypto reproducibility](REPRODUCIBILITY.md) and [Polymarket reproducibility](polymarket/REPRODUCIBILITY.md) —
every cited number re-derives from a clean clone at **$0**.

---

## Page map

### Top level
- **[../README.md](../README.md)** — the front door (two-domain overview, by-the-numbers).
- **[../SYNTHESIS.md](../SYNTHESIS.md)** — the unified narrative: *where the edge is NOT, across both domains*.
- **[../AGENTS.md](../AGENTS.md)** — repo orientation for coding agents (layout, the always-run-the-gauntlet rule).

### Shared / crypto domain (`docs/`)
- **[README.md](README.md)** — crypto documentation index + the audited headline (~111 tested).
- **[METHODOLOGY.md](METHODOLOGY.md)** — the shared committed gauntlet (the rigor; audit this first).
- **[GLOSSARY.md](GLOSSARY.md)** — every load-bearing term, one paragraph each (the concept hub).
- **[RESULTS.md](RESULTS.md)** · **[EDGE_SEARCH_SYNTHESIS.md](EDGE_SEARCH_SYNTHESIS.md)** · **[EDGE_SEARCH_DOMAIN_CAMPAIGN.md](EDGE_SEARCH_DOMAIN_CAMPAIGN.md)** — crypto findings, narrative, and the 2026-06 campaign.
- **[VALIDATION_HARNESS.md](VALIDATION_HARNESS.md)** · **[METHODOLOGY_CONFORMANCE.md](METHODOLOGY_CONFORMANCE.md)** · **[REPRODUCIBILITY.md](REPRODUCIBILITY.md)** · **[REFERENCES.md](REFERENCES.md)** — the harness, the claim→code bridge, re-run instructions, bibliography.
- **[BACKLOG.md](BACKLOG.md)** · **[ONCHAIN_FEASIBILITY.md](ONCHAIN_FEASIBILITY.md)** · **[DISCLAIMER.md](DISCLAIMER.md)** — the pipeline, the on-chain $0 feasibility verdict, the not-investment-advice notice.

### Polymarket domain (`docs/polymarket/`)
- **[polymarket/README.md](polymarket/README.md)** — Campaign-D index + bottom line.
- **[polymarket/RESULTS.md](polymarket/RESULTS.md)** · **[polymarket/REVERSE_ENGINEERING.md](polymarket/REVERSE_ENGINEERING.md)** · **[polymarket/MONEY_MGMT_AND_ARB.md](polymarket/MONEY_MGMT_AND_ARB.md)** — the proof phase, the 22-mechanism reverse-engineering, the arbitrage/money-management attack.
- **[polymarket/METHODOLOGY.md](polymarket/METHODOLOGY.md)** · **[polymarket/VALIDATION_HARNESS.md](polymarket/VALIDATION_HARNESS.md)** · **[polymarket/REPRODUCIBILITY.md](polymarket/REPRODUCIBILITY.md)** · **[polymarket/REFERENCES.md](polymarket/REFERENCES.md)** — the Polymarket adaptation, harness, re-run, bibliography.
- **[polymarket/EVALUATION.md](polymarket/EVALUATION.md)** — the honest self-assessment + 8-agent adversarial audit + parity scorecard.
- **[polymarket/RE_LEDGER.md](polymarket/RE_LEDGER.md)** · **[polymarket/CREDIBILITY_BACKLOG.md](polymarket/CREDIBILITY_BACKLOG.md)** · **[polymarket/BACKLOG.md](polymarket/BACKLOG.md)** — the per-mechanism dispositions, the 29-test credibility battery, the 35-hypothesis backlog.
- **[polymarket/EXTERNAL_INFO_EDGES.md](polymarket/EXTERNAL_INFO_EDGES.md)** · **[polymarket/WEATHER.md](polymarket/WEATHER.md)** · **[polymarket/CLAUDE_BOT_ARTICLE_VALIDATION.md](polymarket/CLAUDE_BOT_ARTICLE_VALIDATION.md)** — the 16 external-information leads, the weather forward test, the viral-claim forensics.

---

## Machine-readable assets

| Asset | What it is |
|---|---|
| [`../output/results-ledger.json`](../output/results-ledger.json) | Crypto per-hypothesis verdict ledger (the canonical machine schema). |
| [`../output/campaign-D/results-ledger.json`](../output/campaign-D/results-ledger.json) | Polymarket per-mechanism verdict ledger (same schema). |
| [`../output/campaign-D/SNAPSHOT.json`](../output/campaign-D/SNAPSHOT.json) | The Polymarket corpus pin (sha256 + counts) for deterministic re-runs. |
| [`../output/campaign-D/*.json`](../output/campaign-D/) | Every cited Polymarket number, script-derived (persistence, arb, walk-forward, calibration, …). |
| [`../scripts/campaign-D/README.md`](../scripts/campaign-D/README.md) | The runnable Polymarket pipeline (script index + run order). |

---

> **A KILL is the expected, valuable outcome.** The refusal to manufacture a survivor — backed by a positive
> control proving the gauntlet *would* find one — is the contribution. **License:** MIT — see [`../LICENSE`](../LICENSE).
