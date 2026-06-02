# Edgehunt On-Chain 2 — Summary

Batch of 8 hypotheses (on-chain valuation/flow signals + price-transform overlays) run through the committed gauntlet (`scripts/edgehunt-D5/harness.ts::runGauntlet`): net-of-cost @4bps/side, baselines (B&H / random-lottery), Deflated Sharpe @ honest N, CPCV/PBO, Harvey-Liu haircut, the right surrogate null (phase-randomization / surrogate-recompute), and a consume-once holdout.

## Verdict table

| ID | Hypothesis | Verdict | Net Sharpe | Honest N | Surrogate p | Binding gate | Monthly @ $100k |
|----|------------|---------|-----------:|---------:|------------:|--------------|----------------:|
| O1-ADRACT | Network-growth (AdrActCnt + TxCnt) momentum timer, price-orthogonalized | KILL | 0.963 | 594 | 0.243 | baselines (BTC) / holdout (ETH OOS -0.19) | n/a |
| O2-REALCAP | Realized-cap / MVRV valuation band (thermocap deferred) | KILL | 0.898 | 88 | 0.010 | baselines (loses to B&H + price-only Mayer control) | n/a |
| O3-NVTS | NVT signal, fee-revenue free proxy, causal contrarian | **PROMISING** | **1.33** | 312 (54 restricted) | 0.005 | deflated_sharpe @ broad N=312 (clears @ a-priori N=54) | **$6,304** |
| O4-STABLEFLOW | Stablecoin supply growth as lagged dry-powder flow | KILL | 1.224 | 270 | 0.027 (reverse-causality-clean 0.060) | deflated_sharpe @ honest N (PBO + haircut + clean holdout -0.276 also fail) | n/a |
| O5-HEIKIN | Heikin-Ashi trend / HA-EMA timer | KILL | 1.190 | 14 | 0.176 | deflated_sharpe (also dsr_vs_bh 0.102) | n/a |
| O6-FRACTAL | Williams 5-bar fractal breakout | KILL | 0.682 | 1 (grid 24) | 0.206 | baselines | n/a |
| O7-MAYER | Mayer Multiple (price / SMA200) | KILL | 0.910 (classic rule -0.380) | 62 | 0.150 | deflated_sharpe (substantively surrogate-recompute) | n/a |
| O8-RENKO | Causal Renko brick trend timer | KILL | 0.646 | 44 | 0.050 | holdout (fails own B&H OOS; also deflated_sharpe) | n/a |

## Counts

- **8 tested**: 1 PROMISING, 7 KILL, 0 SURVIVE.
- **DEFERRED (paid-data) sub-tests inside the batch**: 3 — see list below. (No whole hypothesis was deferred; in each case a free-data path or exact algebraic proxy was found and tested honestly, and the paid metric is flagged for later.)

## SURVIVE / PROMISING callout

**O3-NVTS — PROMISING (confidence: med).** Fee-revenue NVT signal `MarketCap / SMA(FeeTotNtv·Price)`, Kalichkin-smoothed, trailing z-scored, lagged >=1d, strictly causal, contrarian (short the overvalued leg). BTC:

- **Net Sharpe 1.33** vs B&H 0.60; **monthly @ $100k ~= $6,304** (~6.3%/mo, net of modeled 4bps/side).
- Passes net-of-cost, baselines, DSR p=0.968 (@ a-priori N=54), block-bootstrap, CPCV/PBO=0.20, Harvey-Liu, phase-rand surrogate **p=0.005** (1000 surr), and a consume-once holdout **+0.59 OOS** (2023-12 -> 2026-05) vs B&H 0.45.
- Robust: 10/10 in-sample years positive (0.22-2.81), neighborhood is a plateau (0.97-1.33, no lone spike), short-overvalued leg standalone +0.38 (genuine — shorting a rising asset still profits on high fee-NVTS).

**Why PROMISING, not SURVIVE (honest caveats):**
1. DSR clears 0.95 only under the a-priori N=54 fee-only restriction. The full 4-denominator grid (N=312) gives DSR 0.894 -> demotes to PROMISING. The restriction is economically motivated (fee proxy is the only family whose forward-return buckets survive price-momentum orthogonalization) but is a researcher choice.
2. The pre-registered canonical config (90/365) is weak (net 0.74, surrP 0.066); the win rides the selected 30/730 config.
3. ETH KILLs (holdout -0.59, PBO 0.50) — no cross-asset confirmation.

## DEFERRED (paid-data) — reasons

| Metric / sub-test | Belongs to | Reason deferred | Free path actually used |
|-------------------|-----------|-----------------|-------------------------|
| `CapRealUSD` (realized cap) + `RevAllTimeUSD` (**thermocap**) | O2-REALCAP | Both return HTTP `forbidden` ("not available with supplied credentials") — NOT in the 32-metric CM Community catalog. Thermocap has **no honest free reconstruction**, so thermocap itself is DEFERRED. | Realized cap recovered **algebraically exact** for free: `realizedCap = CapMrktCurUSD / CapMVRVCur` (both free), since MVRV == MarketCap / RealizedCap. Tested on the exact proxy — KILL. |
| `TxTfrValAdjUSD` + ready-made `NVTAdj` / `NVTAdj90` (**canonical Coin Metrics NVT**) | O3-NVTS | PAID — not in the CM Community 32-metric catalog (verified live). The literal Coin Metrics NVT denominator is DEFERRED. | Built the strongest **free** proxy: fee-revenue NVTS from `FeeTotNtv`*`PriceUSD` + `CapMrktCurUSD` (all free). Tested — PROMISING (the surviving signal of the batch). |

**Follow-up if paid data is procured:** validate O3-NVTS on the canonical `NVTAdj90` / `TxTfrValAdjUSD` denominator (the free fee proxy is a substitute, not the textbook metric — confirm the edge survives on the real transfer-value NVT and isn't a fee-cycle artifact), and re-run O2-REALCAP thermocap (`RevAllTimeUSD`) directly rather than relying on the realized-cap-only proxy.

## Cross-cutting follow-ups

- **O3-NVTS is the only carry candidate.** Before any deployment: (a) re-run on canonical paid `NVTAdj90` (see above); (b) stress the N-restriction — if the broad N=312 grid is the honest test, treat as PROMISING-only and do not size up; (c) it has no ETH confirmation, so keep BTC-only and monitor for regime decay (fee-cycle dependence). Suggest a forward paper-trade window before capital.
- **Recurring trap confirmed across O1/O5/O6/O7/O8:** every price-transform overlay (Heikin-Ashi, Williams fractal, Mayer, Renko) and the "adoption" momentum signal (O1) reduce to an **equivalently-lagged moving-average / long-beta tilt** — they tie or lose to B&H, are reproduced by spectrum/vol-preserving surrogate-recompute nulls, and the on-chain "adoption" series are repackaged price momentum (reverse causality: O1 corr 0.55-0.73 with price momentum; O4 lead/lag 0.022 forward vs 0.351 trailing). No further effort warranted on price-transform overlays or coincident-demand on-chain momentum.
- **O4-STABLEFLOW** "survive" only appeared under a dishonest post-hoc N=3 carve-out; the reverse-causality-clean version is holdout-negative. Closed.
