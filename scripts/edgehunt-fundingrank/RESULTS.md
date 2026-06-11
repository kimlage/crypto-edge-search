# Results — cross-sectional funding-rank L/S carry → KILL

**Verdict: KILL** (binding gate `deflated_sharpe`). Run 2026-06-09, engine + gauntlet in 7.3 s on a
survivorship-free panel of **155 ever-member perps**, axis 2020-12-31 → 2026-05-31 (1978 days; 282
weekly + 65 monthly formations; `output/fundingrank/{results,champion_series}.json`, `run.log`). The
honest N=12 grid was frozen in `README.md` before any number was computed.

## The honest correction to the viral claim

The claim — *"short the high-funding coins, long the low-funding ones = free money"* — is neither
free money nor obviously fake. On the **survivorship-free** panel it produces a real-looking book
(champion full-window net **77.4%/yr, Sharpe 1.24**, holdout SR 1.07, last-12m SR 1.36) whose
**price leg is positive**, not the coupon-eaten-by-bleed story from the quick 8-major replay. It
still **KILLs** — but on the multiple-testing / overfitting cluster, not on economics: it cannot
separate from a cross-sectional label-shuffle null once the 12 configs are counted. This is failure
mode (c) (selection inflation / single-vs-family surrogate), the program's most common KILL.

## 8-major reproduction (judge replay)

The judge's informal replay on the cached 8-major panel (`output/funding/`, 2023-06→2026-05) reported
funding leg +3.27%/yr, price leg −7.64%/yr, net Sharpe −0.12, last-12m −0.87. Reproduction on the
same panel, same 12 configs: **the sign is config-dependent.** The funding leg is always strongly
positive (SR 10–13); the price leg is **negative on monthly configs** (the judge's case:
L20-quintile-monthly net −24.5%/yr, SR −0.26) but **positive on weekly configs** (L20-quintile-weekly
net +79.3%/yr SR 1.32). Last-12m is negative on most weekly configs (−0.34 to −0.65), matching the
judge's −0.87 ballpark. So the judge's headline was true for *its* (monthly) config, not universally —
documented rather than overstated.

## P&L decomposition (survivorship-free panel, TRAIN window, net of 4 bps/side)

| Config | Net %/yr (SR) | Funding leg %/yr (SR) | Price leg %/yr | Cost %/yr |
|---|---:|---:|---:|---:|
| L20-quintile-weekly | 82.8 (1.40) | 24.9 (14.5) | 60.4 | 2.55 |
| L20-quintile-monthly | 98.3 (1.24) | 19.6 (14.7) | 80.1 | 1.35 |
| **L20-tercile-weekly (champion)** | **68.3 (1.53)** | **17.8 (15.6)** | **52.7** | **2.22** |
| L20-tercile-monthly | 63.9 (1.09) | 13.4 (14.3) | 51.8 | 1.20 |
| L30-quintile-weekly | 82.7 (1.44) | 23.4 (14.0) | 61.4 | 2.21 |
| L30-quintile-monthly | 92.8 (1.15) | 20.7 (6.9) | 73.4 | 1.25 |
| L30-tercile-weekly | 46.5 (1.05) | 17.0 (15.0) | 31.4 | 1.86 |
| L30-tercile-monthly | 80.0 (1.34) | 15.1 (8.1) | 66.1 | 1.12 |
| L45-quintile-weekly | 53.5 (0.90) | 22.3 (13.3) | 33.1 | 1.94 |
| L45-quintile-monthly | 39.7 (0.64) | 21.3 (7.1) | 19.5 | 1.10 |
| L45-tercile-weekly | 41.1 (0.94) | 15.9 (14.4) | 26.8 | 1.64 |
| L45-tercile-monthly | 4.5 (0.07) | 15.4 (8.1) | −9.9 | 1.02 |

The funding coupon is real and large everywhere (SR 7–16); on the wide survivorship-free panel the
price leg is *additive*, not a drag — which is exactly why the kill must come from the deflation /
surrogate gates, not from net_of_cost.

## Gauntlet (champion L20-tercile-weekly, full 8-gate chain, honest N=12)

| Gate | Result | Detail |
|---|---|---|
| net_of_cost | PASS | mean net 0.001870/day, n=1582, financing charged (rate 0 — funding is explicit cashflow) |
| baselines | PASS | strat 0.001870 > B&H BTC 0.001263 > EW-long 0.000925 > random-book p95 0.000740 |
| **deflated_sharpe** | **FAIL (binding)** | **DSR 0.942 @ N=12** (Sharpe 0.080, expMax 0.041) — just under the 0.95 bar |
| block_bootstrap | PASS | mean 95% CI [0.000343, 0.003519] |
| cpcv_pbo | FAIL | purged CPCV PBO **0.643** (8 folds, purgeGap 16, embargo 15, 70 splits) — champion is overfit to the grid |
| haircut | PASS | Bonferroni@N=12 p=0.0177 (Holm 0.0177, BY 0.0549) |
| surrogate | FAIL | real 0.001870 vs family-wise null95 0.002044, **p=0.060** (300 cross-sectional-shuffle draws, MAX over 12 configs) |
| holdout | PASS | OOS n=396, mean 0.003127, DSR@1 0.956 |

Binding gate = first failure = **deflated_sharpe**. The cluster of three multiple-testing failures
(DSR 0.942, PBO 0.643, family-wise surrogate p=0.060) is the real story: the book looks good on any
single config but does not survive counting the grid or shuffling the cross-sectional labels.

## Diagnostics

- **Power pre-flight** (realized 4.33y train window): AUTO-FLAG — at true SR 0.5 the powered horizon
  is 31.4y; even at true SR 1.0 it is 7.85y > 4.33y. A SURVIVE here would require observed SR ≥ 0.79
  (DSR) / 0.94 (t) — the window can only KILL or extend. (Consistent with §3 of the review.)
- **BTC beta** (train): −0.037 (t=−2.02, R²=0.003) — effectively beta-neutral; holdout raw SR 1.069
  vs hedged 1.065 (hedge changes nothing).
- **Momentum loading** (train): +0.090 on a 90d XS-momentum factor (t=4.30, R²=0.012) — small but
  significant; the book carries a modest momentum exposure (the short-high-funding leg overlaps with
  recent winners).

## Limitations

- The champion is selected by best train Sharpe among 12 — DSR/PBO penalize exactly this. A single
  *pre-registered* config (not the grid argmax) on a forward window is the only way to test the
  structure honestly; the §3 power table says that needs years.
- Funding cashflows are credited at the documented stamp convention; small timing assumptions exist
  but cannot flip a verdict that binds on deflation.

**Teaching case:** the funding coupon is genuinely large and the survivorship-free price leg is
positive — yet the strategy is a KILL because at honest N=12 it fails to separate from a
cross-sectional-shuffle null (p=0.060) and is overfit (PBO 0.64). "Real-looking, not real" — the
canonical edge-search outcome.
