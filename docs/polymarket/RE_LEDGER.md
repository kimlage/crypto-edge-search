# Campaign-D — Reverse-Engineering Mechanism Ledger (committed dispositions)

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


Every one of the 22 reverse-engineering mechanisms now has a **committed disposition** — either an
independent gauntlet/census run, or a formal **DEFERRED** with the specific $0-blocking data reason
(matching the crypto program's DEFERRED policy: not a verdict on edge, a verdict on coverage). This
replaces the earlier "agent-claimed" status the audit flagged.

Legend: **TESTED** = reproduced from a committed script; **DEFERRED** = honest $0 test needs data we lack.

| ID | family | disposition | committed evidence |
|---|---|---|---|
| RE01 | resolution-rules | **TESTED → KILL** | `run_all.ts` longshot-fade (clean binary) KILL @ every cost; `arb_baskets.mjs` negRisk basket overround +7.3% |
| RE02 | resolution-rules | **TESTED (census) → KILL-lean** | 50-50 fallback rate 0.88% overall, **1.71% in matchup markets** (committed census); the 0.5 floor is too rare + cheap-side spread too wide to be a net put — full price-path test DEFERRED (thin matchup pre-res prices) |
| RE03 | cross-market | **TESTED → KILL** | `arb_baskets.mjs`: 579 baskets, median sum(ask) 1.073 (arb-free); partitions only ~25% clean |
| RE04 | cross-market | **DEFERRED** | cross-leg relative-value needs full live basket books at depth + partition-purity (RE03 shows ~75% impure) |
| RE05 | cross-market | **DEFERRED** | nested-date monotonicity needs paired nested-date markets + simultaneous live books |
| RE06 | cross-market | **DEFERRED** | parlay/leg-vs-aggregate consistency needs the full series book set live |
| RE07 | resolution-rules | **TESTED → KILL (redundant)** | void census: negRisk=true **0/46,095** void, so the haircut term is 0 where it gates; ≥1¢ spread binds first |
| RE08 | favorite-carry | **TESTED → KILL** | `run_all.ts` favorite-buy (BUY YES ≥ band) negative at every cost |
| RE09 | favorite-carry | **DEFERRED** | cross-market favorite basket carry needs collateral/convert mechanics + the full basket |
| RE10 | forecasting | **TESTED → DEFERRED** | `re_verify.ts`: stable templates (≥20 causal priors) and the tradeable [0.02,0.98] band are **near-disjoint** → not testable as a trade (the "Claude brain" family) |
| RE11 | category | **DEFERRED** | crypto barrier-vs-spot needs an aligned FREE spot series at each market's resolution instants |
| RE12 | resolution-rules | **DEFERRED** | settlement-source/fixing edge needs the exact named external fixing feed |
| RE13 | primary-liquidity | **TESTED → KILL** | `re_verify.ts`: price-path momentum mean −0.051 net of 2¢, surrogate p=1.000, binds net_of_cost |
| RE14 | primary-liquidity | **DEFERRED** | new-market cold-anchor needs the open-snapshot before liquidity arrives (not in resolved tapes) |
| RE15 | primary-liquidity | **DEFERRED** | far-dated staleness MAP needs a free fair-value proxy that does not exist for these markets |
| RE16 | market-making | **TESTED → KILL** | `run_all.ts` calibration favorite-direction = SELL the longshot; negative at every cost |
| RE17 | market-making | **DEFERRED** | negRisk capital-efficiency short needs live margin/convert mechanics |
| RE18 | market-making | **DEFERRED** | regime-gated thin-book spread capture needs point-in-time L2 books + live quoting |
| RE19 | market-making | **DEFERRED** | LP rewards-subsidy capture needs the daily USDC reward-accrual feed |
| RE20 | sizing | **TESTED → KILL** | `mm_risk_gauntlet.ts` + `mm_oos_check.ts`: sizing manufactures no EV; empirical-q Kelly is look-ahead → ruin OOS |
| RE21 | sizing | **DEFERRED** | liquidity-aware sizing needs a tape-calibrated price-impact / book-depth model (PIT) |
| RE22 | forecasting | **TESTED → KILL** | `verify_re22.ts`: corpus on-winner gap **+0.0001** (calibrated in aggregate); cohort +0.057 is survivorship |

## Tally

- **TESTED (committed): 9** — RE01, RE02(census), RE03, RE07, RE08, RE13, RE16, RE20, RE22 → all KILL / KILL-lean; plus RE10 **TESTED→DEFERRED**.
- **DEFERRED (need PIT L2 / live quoting / external feeds / reward-accrual / basket mechanics): 12** — RE04, RE05, RE06, RE09, RE11, RE12, RE14, RE15, RE17, RE18, RE19, RE21.
- **0 SURVIVE** among everything testable at $0. The DEFERRED set is a coverage gap, not an edge claim — and (as in the crypto program) the families that DEFER are exactly those needing paid/point-in-time microstructure data.

> Net: the broad "0 deployable edge" now rests on **committed tests for every $0-decidable mechanism**
> plus an explicit, reasoned DEFER list — at parity with the OSS project's DEFERRED policy. No mechanism
> is left as unverified agent narrative.
