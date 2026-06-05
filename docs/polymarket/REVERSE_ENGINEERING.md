# Campaign-D — Polymarket: First-Principles Reverse-Engineering

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


> **Goal (owner's ask).** The proof phase (`RESULTS.md`) showed wallet performance does NOT persist —
> so instead of *following* anyone, infer FROM FIRST PRINCIPLES the MECHANISM behind the skilled-
> cohort behaviour (selling cheap longshots) and design INDEPENDENT, market-state strategies that
> reproduce it, each falsified through the committed gauntlet. Generated 2026-06-03 by a
> first-principles workflow (32 agents, ~1.6M tokens; raw in `output/campaign-D/re-wf/`).

## Headline: 0 SURVIVE (consistent with the 111-hypothesis crypto program)

> **VERIFICATION STATUS (per audit + `EVALUATION.md`).** Of the 22 mechanisms, only **3 are
> independently reproduced from committed scripts**: RE22 (the keystone — `verify_re22.ts`), the
> favorite-longshot family RE01/RE16 (via `run_all.ts`, KILL at every cost), and the basket-arb RE03
> (`arb_baskets.mjs`). **The other ~16 KILL/DEFER verdicts are AGENT-CLAIMED (32-agent workflow output),
> NOT independently re-run** — treat them as leads, not gauntlet results. The "0 SURVIVE" headline is
> directionally credible (the verified families and the aggregate calibration all KILL) but is not, for
> the unverified mechanisms, held to the crypto program's audit-of-audit standard.

22 independent reproduction mechanisms across 8 families. Honest prediction and result: **~16 KILL,
~5 DEFERRED (need data we lack at $0), 0 SURVIVE.** The workflow agents ran many in-corpus; the
decision-relevant numbers below were **independently re-verified** by the main loop (one agent number
was wrong — see the keystone).

## The keystone (RE22) — INDEPENDENTLY VERIFIED, and it corrects the agent

Is the cohort's 84.9%-on-winner *skill*, or mechanical? Test: observed `pctOnWinner` vs the **price-
tied Bernoulli null** (under calibration, P(on winner)=price if BUY, 1-price if SELL).

| Group | observed on-winner | price-tied null | gap |
|---|---:|---:|---:|
| Cohort (97 'persistent' wallets) | 0.8493 | 0.7920 | **+0.057** (survivorship — selected as winners) |
| All eligible (1,764) | 0.6277 | 0.6136 | +0.014 (tiny) |
| **Entire corpus (1.36M trades)** | 0.6027 | 0.6025 | **+0.0001** |

> The workflow agent claimed null≈0.889 > observed (negative skill); that did **not** replicate. The
> verified result is cleaner and stronger: **the market is near-perfectly calibrated in aggregate
> (+0.0001)** — there is no population-level forecasting edge — and the cohort's small positive gap is
> pure **survivorship** (they were selected for being OOS-positive). The 'skill' premise is retired.

## Verified structural fact: negRisk = clean settlement (underpins RE01/RE03/RE07)

| class | total | clean {0,1} | 50-50 | void/other |
|---|---:|---:|---:|---:|
| **negRisk=true** | 46,095 | **100.00%** | 0.00% | 0.00% |
| negRisk=false | 117,280 | 98.75% | 1.24% | 0.01% |
| negRisk=none (legacy) | 9,420 | 97.96% | 0.37% | 1.67% |

negRisk=true guarantees a single clean winner — but that removes only the *void/50-50* tail, **not the
longshot-upset tail** that killed the parent fade (holdout −1.0). RE01's own in-corpus follow-up
confirmed: negRisk-restricted short-book worst case stays −1.0 and mean stays negative (−0.0097, n→28).
So the highest-prior lead (PROMISING) **KILLs** — failure mode (f), no separable premium.

## The 22-mechanism backlog

### Resolution-rules / settlement mechanics

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE01 | negRisk clean-settlement gate on the longshot-fade: the cohort's real  | yes | likely-KILL | holdout |
| RE02 | 50-50 fallback put-floor: fade the over-priced favorite in draw-prone  | yes | likely-KILL | net_of_cost |
| RE07 | Settlement-tail / financing haircut: the conditional void+lock cost th | yes | likely-KILL | net_of_cost |
| RE12 | Settlement-source / fixing-basis edge: read the exact named oracle sou | yes | likely-KILL | DEFERRED-data |

### Cross-market / logical consistency

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE03 | negRisk basket no-arbitrage: trade the leg whose price disagrees with  | yes | likely-KILL | net_of_cost |
| RE04 | Cross-leg relative-value short: fade the basket leg rich relative to i | yes | DEFERRED | DEFERRED-data |
| RE05 | Nested-date monotonicity: buy the cheap dominating leg / sell the rich | yes | likely-KILL | net_of_cost |
| RE06 | Leg-vs-aggregate parlay consistency: price the series/parlay winner ag | yes | likely-KILL | net_of_cost |

### Information / forecasting

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE10 | Base-rate / template-anchored estimator: beat the mid using the empiri | yes | likely-KILL | holdout |
| RE22 | Base-rate decomposition null: is the cohort's 0.849-on-winner just the | NO | likely-KILL | surrogate |

### Primary-liquidity / stale-price

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE13 | First-print staleness drift: trade the gap between the seed/first-trad | yes | likely-KILL | surrogate |
| RE14 | New-market cold-anchor divergence: fade the round-number/default open  | yes | likely-KILL | DEFERRED-data |
| RE15 | Stale-far-dated mispricing MAP: tradeable only where a FREE live signa | NO | DEFERRED | DEFERRED-data |

### Market-making / spread

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE16 | One-sided lottery-ticket vendor: SELL the longshot premium as a TAKER  | yes | likely-KILL | net_of_cost |
| RE17 | NegRisk capital-efficiency short-longshot: harvest the tail premium wh | yes | DEFERRED | DEFERRED-data |
| RE18 | Regime-gated thin-book spread capture: rest two-sided ONLY in the low- | NO | likely-KILL | surrogate |
| RE19 | LP rewards-subsidy capture: the daily USDC rebate as the only positive | yes | DEFERRED | net_of_cost |

### Favorite-settlement carry

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE08 | Tail-capped favorite carry with a STRUCTURAL upset filter: the only co | yes | likely-KILL | DEFERRED-data |
| RE09 | Cross-market favorite basket carry: diversify the upset tail across un | yes | DEFERRED | DEFERRED-data |

### Category specialist

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE11 | Crypto price-target barrier model vs free spot anchor: trade only the  | yes | likely-KILL | holdout |

### Sizing / risk

| ID | mechanism | reproducible w/o private info | prior | binding gate |
|---|---|---|---|---|
| RE20 | Sizing/diversification overlay on the killed longshot-fade: does Kelly | yes | likely-KILL | baselines |
| RE21 | Liquidity-aware sizing with a tape-calibrated price-impact charge: is  | yes | likely-KILL | net_of_cost |

## Execute-first results (workflow-reported; keystone + census re-verified above)

- RE22 — Base-rate decomposition null (keystone diagnostic). $0, full-N (16,236 cohort trades + calibration per-bucket YES-rates), provability 5. Run the PRICE-TIED Bernoulli null (draw outcome ~Bernoulli(empirical per-bucket YES-rate), assign realized side, recompute pctOnWinner) — NOT the 1-meanEntryPrice marginal. Verified preview: correct side×price null ≈ 0.889 vs observed 0.849 => cohort is at-or-below its price regime, gap ≈ 0 to negative. Retires the forecasting/copy-skill premise for the whole backlog cheaply.
- RE16 — One-sided longshot vendor net-of-cost (canonical KILL). $0, n=66–171, provability 5. ALREADY RUN: SELL-YES short-longshot mean is NEGATIVE at every band (-0.053 at ≤0.10 t=-1.57; -0.069 at ≤0.15) with worst=-1.000 and 4–8 tail hits — wrong sign before any surrogate. Establishes the net-of-cost+tail coffin every favorite-longshot child inherits.
- RE01 — negRisk clean-settlement gate on the longshot fade. $0, provability 5, highest prior verdict (PROMISING). ALREADY RUN: negRisk=true is 46,095/46,095 clean (0 void, 0 fifty-fifty) BUT the short-book worst=-1.000 is IDENTICAL across negRisk true/false/all and negRisk=true mean stays negative (-0.0097, n collapses to 28). Gate removes void mass, not the clean-binary upset tail. Failure mode (f). Killing the best-looking hypothesis is the single most decision-relevant result.
- RE07 — Settlement-tail/financing haircut GATE census. $0, full-N (172,830 markets), provability 5. ALREADY RUN: all 155 voids live in legacy negRisk=none (1.64%); negRisk=true (the live basket-arb universe) has 0/46,095 voids. Haircut charges a catastrophic term that is 0c where it gates; the ≥1c half-spread binds before the ~0.09c financing. Redundant with the existing net-of-spread gate (failure mode f). Forecloses every static-arb 'riskless' claim.
- RE20 — Sizing-overlay Sharpe-invariance KILL. $0, provability 5. Apply max-loss-cap, half-Kelly (train-only reliability curve), de-clustering to the SAME fade picks; max-loss-cap Sharpe == flat-fade Sharpe to 3 dp (no EV manufactured), and the only 'positive' book is the Kelly gate refusing ~90% of bets (n_eff(OOS)≈2, empty). Binding gate = matched-exposure baseline, failure mode (d). Closes the 'maybe it was just sizing' escape hatch.
- RE13 — First-print staleness drift vs random-anchor placebo. $0, 446 tape markets, provability 4. Family-wise random-anchor event-time placebo + toward-resolution-rate>50% test. Already run: lagged de-staling leg loses net-of-spread (mean -0.013, win 17.7%), pK closer to truth than p0 only 47.2% (worse than coinflip), real leg does NOT beat placebo MAX (p=1.000). Maps the primary-liquidity/stale-price family to KILL on the most data-complete corpus.
- RE10 — Template base-rate estimator disjointness KILL. $0, provability 4. Stem the resolved corpus; show the [0.15,0.85] tradeable OOS band and the stable-template (≥30-prior) set are EMPIRICALLY DISJOINT (0 of 87 tradeable markets in a ≥30-prior stem) and the only stable templates are crypto up/down coinflips (base rate 0.478–0.533 = zero info over a 0.50 mid). Collapses the information-forecasting family into the killed global reliability curve (failure mode f). Folds in the trivial RE12 confirm-and-discard (resolutionSource/description null in all 172,830 rows).
- RE03 — negRisk basket no-arb partition-purity + cost KILL. $0, provability 4. ALREADY PARTLY RUN: slug-stem reconstruction yields only ~25% exactly-one-winner partitions (50% zero-winner, 26% multi-winner) — |S-1| is contaminated by grouping error at ~1-in-3, not a tail. Then show the q-p renormalization gap lives in cheap-tail legs (<0.10) carrying the widest spreads (failure mode i). Maps the cross-market-consistency family and pre-empts RE04/RE05/RE06 which inherit the same partition/spread problem.

## Synthesis: where the edge is NOT (Polymarket)

1. **Copy/follow any wallet ranking** — performance does not persist (anti-persistent); surrogate p=0.528.
2. **Forecasting / 'probability brain'** — the market is calibrated in aggregate (+0.0001); the only stable
   templates are crypto up/down coinflips (base rate ~0.50 = zero info); tradeable band disjoint from stable templates.
3. **Favorite-longshot harvest (buy or sell the tail)** — mispricing structure is real (surrogate p=0.012)
   but every child dies on the **upset tail + wide longshot spread** (holdout −1.0); negRisk gating removes
   void mass, not the upset tail; sizing/Kelly overlays manufacture no EV (Sharpe-invariant).
4. **Cross-market / basket no-arb** — slug-stem partitions are only ~25% clean (50% zero-winner, 26% multi-),
   and the renormalization gap lives in the cheapest, widest-spread legs (cost leak).
5. **Primary-liquidity / stale-price** — the de-staling leg loses net-of-spread and does not beat a random-anchor placebo (p=1.000).
6. **Market-making / spread capture, LP rewards, settlement-source edges** — DEFERRED: the only honest test
   needs point-in-time L2 books / live quoting / reward-accrual data we do not have at $0.

**Verdict: 0 deployable edge.** The one real thing — a genuine favorite-longshot mispricing — is the prediction-
market analogue of crypto carry: real structure, but sub-cost / tail-fragile / capacity-tiny, not a business.
