# Campaign-D — Methodology (Polymarket adaptation of the committed gauntlet)

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


Campaign-D reuses the crypto program's anti-overfitting gauntlet verbatim (see [../METHODOLOGY.md](../METHODOLOGY.md))
and adds the adaptations a prediction-market domain requires. This page documents only the deltas.

## The one structural advantage: ground-truth labels

Unlike price-forecasting (where every backtest is an upper bound on an unknowable future), **every
resolved Polymarket market is a labeled example** (`outcomePrices` ∈ {[1,0],[0,1]} / 50-50 / void). So
calibration, wallet-skill persistence, and arbitrage are *decidable*, not merely arguable. This is why
the campaign could be run honestly at $0.

## The unified gauntlet (`scripts/campaign-D/gauntlet.ts::runGauntlet`)

One harness chains all gates in the crypto program's binding order, reusing the committed primitives:

```
net_of_cost → baselines → deflated_sharpe@honestN → block_bootstrap → cpcv_pbo
            → harvey_liu_haircut → right-null surrogate → consume-once holdout
```

- **Verdicts:** SURVIVE = all pass; PROMISING = passes net+baselines+surrogate+holdout but trips a
  multiple-testing/DSR gate; KILL = fails a core economic gate; DEFERRED = honest test needs unavailable data.
- The Harvey-Liu **haircut** (Bonferroni/Holm/BHY) is implemented in-harness (no committed primitive on
  this branch). `run_all.ts` applies the full chain uniformly to every strategy × cost level.

## The right null per claim (the hero gate)

| Claim | Right null | Destroys | Preserves |
|---|---|---|---|
| **Calibration / favorite-longshot** | **calibrated-Bernoulli, family-wise MAX** — resample each outcome ~ Bernoulli(price), keep prices+strategy fixed | any edge beyond what perfect calibration + cost gives | each market's price and the strategy logic |
| **Wallet skill / copy-trading** | **wallet-label shuffle, family-wise MAX** — copy RANDOM eligible wallets | the skill-selection signal | each wallet's own OOS trade returns |
| **Forecasting skill (RE22)** | **price-tied Bernoulli** — P(on winner)=price(BUY)/1-price(SELL) | claimed predictive skill | the price regime the wallet actually traded |
| **Static arbitrage** | structural (no null needed) — within-book complete-set sums to 1+spread by construction | — | — |

A surrogate PASS proves the structure/sign is non-random; it does **not** prove a positive realized mean
at honest N on unseen data — exactly the PROMISING/SURVIVE boundary, which no Campaign-D lead crossed.

## Cost model (financing-honest, price-aware)

Polymarket charges 0% trading fee, so the cost is the **spread** (and gas + capital lockup). The audit
showed a flat 1¢ floor understates longshot spreads (real ≈5–20¢, ~150% of a ≤10¢ price). `run_all.ts`
charges a **price-proportional** half-spread at three levels — `flat1` (1¢), `prop` (max(1¢, 0.15·min(p,1−p))),
`wide` (max(3¢, 0.25·min(p,1−p))) — and reports all three. The KILL holds at every level; at `wide` the
favorite-longshot mean goes net-negative (binds on `net_of_cost`).

## Named failure modes observed (the crypto program's taxonomy, instantiated here)

- **(a) base-rate / long-NO-beta in disguise** — "fade longshots" profits partly because 74% resolve NO; the blind-NO baseline + Bernoulli null strip it.
- **(c) selection inflation / survivorship** — top-decile-train wallets are largely lucky; they anti-persist (−$90k OOS).
- **(f) no separable premium** — negRisk clean-settlement gating removes the void tail, not the longshot-upset tail; no residual edge.
- **(i) cost leak** — the flat 1¢ floor; corrected with the price-proportional model.
- **look-ahead** — empirical-q Kelly sizes on the in-sample calibration curve → grows in-sample, **ruins OOS** (`mm_oos_check.ts`).

## Honest-N and reproducibility

Honest N is declared per family (`REPRODUCIBILITY.md`); DSR is deflated at that N. Every cited number is
script-derived and pinned to `SNAPSHOT.json`. The data is live-API, so the snapshot hash is the pin.

> **A KILL is the expected, valuable outcome.** The deliverable is the methodology + the negative
> evidence, not a manufactured survivor. Campaign-D returned **0 deployable edge**, consistent with the
> 111-hypothesis crypto program — and, thanks to ground-truth resolution, provably so.
