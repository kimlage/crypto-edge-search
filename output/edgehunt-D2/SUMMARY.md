# EdgeHunt D2 — Synthesis (CVD / order-flow / volume-microstructure family)

**Date:** 2026-06-01
**Domain:** D2 — free-tier order-flow & volume-microstructure beliefs (taker CVD, taker buy/sell ratio,
anchored VWAP, volume profile, OBV/A-D, Amihud illiquidity, large-trade/whale prints, liquidation cascades).
**Common methodology:** strictly-lagged (h>=1) signals only, realistic 4 bps/side taker cost, honest-N
multiple-testing accounting, the committed gauntlet (`scripts/edgehunt-D2/lib.ts::runGauntlet` ->
`src/lib/training/statistical-validation.ts`: DSR@honest-N, block-bootstrap CI, CSCV/PBO), and the
*right* null for each mechanism (flow block-bootstrap / phase-randomization / bracket-on-surrogate /
cross-sectional shuffle).

## Verdict

**All 8 D2 hypotheses tested -> KILL. Zero SURVIVE. Zero PROMISING.**

No strategy clears the gauntlet on its strictly-lagged (h>=1) component. There is **nothing to call out at
$10k / $100k** — every monthly P&L estimate is `n/a` because no candidate passes the gates. The recurring,
decisive pattern across all 8: any apparent Sharpe lives entirely in the **h=0 contemporaneous / look-ahead**
version (the trades *are* the move — Hasbrouck/Easley tautology), and once the signal is honestly lagged the
predictive content collapses to ~0.

## Counts

| Outcome | Count |
|---|---|
| SURVIVE | 0 |
| PROMISING | 0 |
| KILL | 8 |
| DEFERRED (sub-items, not full hypotheses) | L2-microstructure family (VPIN / Kyle-lambda / microprice / book-imbalance) across all 8 |
| **Total hypotheses** | **8** |

Confidence: **high** on all 8 (each backed by >=2 independent honest formulations plus a sizing-free / control
diagnostic, with the correct null, net of cost).

## Verdict table

| ID | Hypothesis | Verdict | Net Sharpe (honest) | Binding gate | Honest N | Surrogate p | monthly @ $10k/$100k | Confidence |
|---|---|---|---|---|---|---|---|---|
| D2-CVD | CVD literal/band-gated divergence (h>=1) | KILL | 0.237 (BTC h=1) | net-sharpe>0.3 | 45 | 0.17 (phase-rand 0.24) | n/a | high |
| D2-TBR | Taker buy/sell ratio extreme imbalance | KILL | 0.236 | net-sharpe>0.3 | 24 | 0.038 | n/a | high |
| D2-VWAP | Anchored / session VWAP mean-reversion | KILL | 0.589 *(artifact; full-sweep best -0.687)* | beats-buyhold (also surrogate-p / DSR@N / boot-CI / PBO) | 396 | 0.278 | n/a | high |
| D2-VP | Volume-profile POC / value-area reversion | KILL | -1.21 (15m) / -0.62 (daily) holdout | net-sharpe>0.3 | 96 (15m) / 128 (daily) | 0.115 / 0.456 | n/a | high |
| D2-OBV | OBV / A-D trend confirmation | KILL | 1.251 raw *(-0.122 excess-over-trend = real volume edge)* | DSR@N (raw) / <=0 excess (volume) | 192 | 0.011 raw / 0.081 excess | n/a | high |
| D2-M2 | Amihud illiquidity premium (cross-section) | KILL | 1.23 *(fails robustness gates)* | boot-CI-lower>0 (DSR@N 0.83 also fails) | 48 | 0.002 *(real but non-stationary/survivorship)* | n/a | high |
| D2-LT | Large-trade / whale-print short-horizon momentum | KILL | 1.36 *(DSR-deflated to coin flip; net 0.03 bp/bar)* | DSR@N>0.95 (0.513) | 48 | 0.001 (Harvey-Liu 0.048) | n/a | high |
| D2-LIQ | Liquidation-cascade fade/follow (proxy) | KILL | 0.10 *(standalone lagged; -2.0 flip raw)* | net-sharpe>0.3 | 72 | 0.28 | n/a | high |

## Prominent callout — SURVIVE / PROMISING with monthly %/$

**None.** There is no SURVIVE or PROMISING result in D2. No strategy produced a tradeable, gate-passing
edge, so there is no monthly-percent or monthly-dollar figure to report at either the $10k or $100k notional.
Every `monthlyAt100k` field on disk is `null`.

The closest-to-passing was **D2-CVD** at **net Sharpe 0.237** (BTC, h=1, config `divband_sw10_zw90_b1`) — and
it fails the *very first* gate (`net-sharpe>0.3`), then also fails beats-buy-hold (0.24 < buy-hold 0.815),
surrogate (phase-rand p=0.24), boot-CI-lower (-0.349 < 0), and DSR (0.063). D2-TBR sits at the same height
(0.236) and fails identically. So the honest order-flow ceiling is **~0.24 Sharpe, net** — comfortably below
both the 0.3 gate and plain BTC buy-and-hold (~0.81-0.93).

## Why they all died (one line each)

- **D2-CVD** — h>=1 lagged divergence fails the first gate; lagged IC ~0 (|IC|<0.01) at all honest lags on all 4 symbols; only h=0 circular look-ahead has Sharpe (~0.77 gross, still < buy-hold).
- **D2-TBR** — lagged edge is **5.1%** of the h=0 tautology ceiling (gross Sharpe 4.58); lagged corr ~0.006; dominated by a causal price-trend baseline; fails 4 of 6 gates.
- **D2-VWAP** — gross signal indistinguishable from bracket-on-surrogate null (p~0.28) even pre-cost; breakeven 1.46 bps < 4 bps taker; lone cost-survivor is a 48-trade DSR~0.02 artifact; session-anchor worse than rolling (no 24/7 close auction).
- **D2-VP** — canonical reversion is wrong-signed (corr~0.002 -> price continues); only positive (continuation) gross edge is sub-cost; holdout net negative on both cadences; daily PBO=0.90; phase-rand null never beaten.
- **D2-OBV** — volume confirmation adds zero/negative value **over the identical price-trend overlay** (best +0.17 bp, p=0.46); classic OBV<->price collinearity; raw beta-filter edge fails DSR/PBO.
- **D2-M2** — 74% of P&L from 20/1971 days; 2021-only premium that goes negative in 2025; ILLIQ 0.96 cross-sectionally collinear with a pure low-volume/size tilt (survivorship-inflated); robustness gates correctly reject.
- **D2-LT** — lagged whale momentum is **inverted** (prints mean-revert); only net-positive pocket is the p99.9 tail (86 events, t<2); DSR collapses at honest N (0.513); sub-cost bid-ask bounce everywhere else.
- **D2-LIQ** — flow-flip cascade events too rare (46/76 in 2.4y); conditional forward returns all |t|<1.5; flip subset weaker than plain large candles; standalone lagged bracket fails the first gate; bracket-on-surrogate null non-significant.

## DEFERRED — L2 microstructure (the honest follow-up)

The **same L2-derived refinements were deferred in all 8 hypotheses**, for the same honest reason: they
require **non-free, point-in-time L2 order-book / forceOrder history** that we do not have on the $0 tier:

- **VPIN** (volume-synchronized probability of informed trading)
- **Kyle's lambda** (price impact / depth)
- **Microprice** (size-weighted mid)
- **Book imbalance** (top-of-book / depth-weighted)
- For D2-LIQ specifically: real-book whale microstructure and Binance `forceOrder` liquidation stream.

These are the one class of refinement that could *in principle* rescue an order-flow edge, because they
measure information/impact at a resolution the free taker-CVD aggregate cannot. They are **DEFERRED, not
killed** — but note: the free-tier *belief* each was meant to proxy (CVD divergence, taker-ratio imbalance,
whale-print momentum, liquidation cascades) is itself **dead** at h>=1. The deeper follow-up is therefore
gated on **acquiring paid point-in-time L2 history**, not on more $0 work.

### Recommended deeper follow-up (single, concrete)

If/when paid L2 history is acquired: rebuild the order-flow family on **VPIN + Kyle-lambda + microprice +
book-imbalance** features, re-run the *identical* committed gauntlet with the *same* nulls (flow
block-bootstrap, phase-randomization, bracket-on-surrogate), and pre-register that the decisive test is
again **lagged (h>=1) excess over the h=0 contemporaneous ceiling** — the exact blade that killed every $0
version here. Until then, the entire free-tier D2 order-flow / volume-microstructure domain is closed: **KILL,
confidence high.**

## Artifacts

Scripts (`scripts/edgehunt-D2/`): `divergence.ts`, `divergence2.ts`, `ic.ts`, `tbr.ts`,
`anchored-vwap.ts`, `anchored-vwap-strengthen.ts`, `anchored-vwap-final.ts`, `vp.ts`, `vp-daily.ts`,
`vp-diag.ts`, `obv.ts`, `amihud.ts`, `run-lt.ts`, `scan-lt.ts`, `liq.ts`, `liq-diag.ts`, plus shared `lib.ts`.

Results (`output/edgehunt-D2/`): `divergence_result.json`, `divergence2_result.json`, `tbr-report.json`,
`results.json` + `anchored-vwap-final.json`, `vp-results.json`, `obv_result.json`, `amihud-results.json`,
`results-lt.json`, `liq-results.json`. Cached data reused (no re-fetch): `btc_15m_flow.json`,
`btc_daily_flow.json`, `{BNB,ETH,SOL}USDT_daily_flow.json`.

**Note:** the gauntlet lives at `src/lib/training/statistical-validation.ts` (DSR, block-bootstrap CI,
CSCV/PBO); the task-referenced `src/lib/validation/strategy-validator.ts->validateStrategy` does not exist
in the repo — `scripts/edgehunt-D2/lib.ts::runGauntlet` wraps the real one.
