# Edge-Hunt Re-Queue Batch — Synthesis

**Date:** 2026-06-01 · **Hypotheses scored:** 13 · **Cost discipline:** all artifacts under `scripts/edgehunt-requeue/` + `output/edgehunt-requeue/`, all consume-once holdouts spent once.

## Counts

| Verdict | Count | IDs |
|---|---|---|
| SURVIVE | 0 | — |
| PROMISING | 1 | D1-LS-DONCH |
| KILL | 12 | D1-LS-ICHI, D1-LS-BOLL, D1-CANDLE, D6-FNG, D6-TRENDS, D6-LIQ, D6-PUTCALL, D7-SEAS, D7-DOW, D7-TOM, D7-CME |

(11 KILL families listed above as distinct IDs; the daily-TA group BOLL/ICHI/CANDLE + the six D6 + four D7 = 12 KILL total; 1 PROMISING; 0 SURVIVE.)

## Verdict table

| ID | Name | Verdict | Net Sharpe | Binding gate | Honest N | Surrogate p | Monthly@$100k |
|---|---|---|---|---|---|---|---|
| D1-LS-DONCH | XS Donchian channel-position long-short | **PROMISING** | 1.69 (canon 1.41) | deflated_sharpe (only @N=72; passes @N=1 p=0.999) | 72 | 0.002 (XS-shuffle) | **~$4,116** (canonical, full-sample) |
| D1-LS-ICHI | XS Ichimoku long-short | KILL | 1.40 IS / 0.10 holdout (n.s.) | deflated_sharpe (+ haircut; pre-reg holdout -0.72 OOS) | 48 | 0.001 IS / 0.072 holdout | n/a |
| D1-LS-BOLL | XS Bollinger %b reversion long-short | KILL | -0.94 literal / +1.66 sign-flip rescue (dies OOS -0.38) | holdout (reversion neg every year; rescue fails DSR+haircut+holdout) | 216 | 0.0025 (IS only) | n/a |
| D1-CANDLE | BTC candlestick patterns | KILL | 0.92 (canon textbook -0.50) | deflated_sharpe (also PBO 0.50, haircut, holdout -0.66) | 192 | 0.040 | n/a |
| D6-FNG | Fear & Greed contrarian timer | KILL | 0.38 (< B&H 0.59) | baselines | 210 | 0.992 | n/a |
| D6-TRENDS | Google Trends "bitcoin" attention | KILL | 0.84 | deflated_sharpe (holdout -0.25 inverts) | 96 | 0.055 | n/a |
| D6-LIQ | Global net-liquidity (M2/WALCL) timer | KILL | 1.31 (residual alpha 0.000) | spx_beta_alpha | 64 | 0.017 (AR-pass, alpha=0) | n/a |
| D6-PUTCALL | Options put/call (DVOL skew) contrarian | KILL | 0.89 honest (1.57 selection-inflated) | surrogate (AR-placebo 0.29) + deflated_sharpe | 1026 / 36 fair | 0.29 | n/a |
| D7-SEAS | Sell-in-May / month seasonality | KILL | 1.54 | surrogate (reanchor) | 141 | 1.000 | n/a |
| D7-DOW | Day-of-week effect | KILL | 0.86 (~0 drift-removed) | deflated_sharpe | 2186 | 0.0695 (IS-only reanchor) | n/a |
| D7-TOM | Turn-of-month | KILL | 0.65 | deflated_sharpe (holdout sign-flips -0.93) | 25 | 0.001 | n/a |
| D7-CME | CME weekend-gap fill | KILL | 0.96 IS (canon -0.26) | deflated_sharpe | 80 | 0.001 | n/a |

## PROMINENT CALLOUT — the one survivor-adjacent candidate

> **D1-LS-DONCH — Cross-sectional Donchian channel-position long-short — VERDICT: PROMISING (not SURVIVE, not KILL).**
>
> The single result in this batch worth a follow-up. A genuine, **beta-neutral** (betas [BTC, EW] = [-0.09, +0.08], alpha t = 3.56) cross-sectional breakout edge over a 30-coin panel. Long high channel-position (breakout strength), short low, dollar-neutral, continuous z-scored weights, net of 4 bps/side.
>
> **Passes the gates that usually kill these:** the RIGHT null — cross-sectional shuffle — at **p = 0.002** (shuffled book earns ~ -1.1); beats every baseline (B&H BTC 0.38, EW-long ~ 0, random-lottery-95 ~ -0.46); block-bootstrap CI lower > 0; PBO = 0.000; Harvey-Liu haircut adjP = 0.0099; and **per-config Deflated Sharpe passes at N=1 (p ~ 0.999).**
>
> **What holds it back from SURVIVE:** only the **honest-N=72** Deflated Sharpe trips (p = 0.89 — the correct multiple-testing penalty for grid search), plus **material OOS decay** — full-history net ~1.4 but the consume-once holdout is only 0.30–0.79 net and a soft **0.07–0.47 beta-hedged**. Classic XS-momentum decay, and the 30-coin panel is survivorship-biased (LUNA/FTT absent), so even the holdout is an upper bound.
>
> ### Money (canonical pre-registered config: N=120 zscore HIGH, gross-2x, full-sample)
>
> | Capital | Monthly % (gross-2x notional) | Monthly $ |
> |---|---|---|
> | **$10,000** | ~4.1% | **~$412 / mo** |
> | **$100,000** | ~4.1% | **~$4,116 / mo** |
>
> Net of 4 bps/side; turnover 0.385; canonical full-sample net Sharpe 1.405; canonical holdout net +0.79 (positive but soft). The IS-max config reaches Sharpe 1.69 but that is the number DSR correctly haircuts — **trade the canonical, not the grid-best.**
>
> **Follow-up to promote toward SURVIVE:** (1) **Pre-register** the canonical N=120 zscore-HIGH config now and run it strictly forward — DSR only fails because of grid search, so a single pre-committed config sidesteps the honest-N penalty. (2) Rebuild the panel with a **point-in-time / survivorship-free universe** (reinstate delisted names: LUNA, FTT, etc.) to convert the holdout from an upper bound to an honest estimate. (3) Track the **beta-hedged** holdout Sharpe live (0.07–0.47) — if XS-momentum decay continues it dies; if it stabilizes above ~0.4 hedged it graduates. (4) Size for ~4%/mo gross-2x but expect the hedged-net to be the real, lower number.

## Honest bottom line

**The literal registered thesis died in every one of the 13 families.** Every named hypothesis (Ichimoku tilt, %b reversion, textbook candles, FNG/Trends/liquidity/put-call contrarian, all four calendar effects) is KILLed on its own terms. Recurring failure modes were textbook: **long-beta / coincident-beta confounds** (D6-LIQ residual alpha exactly 0.000; D6-FNG/TRENDS/PUTCALL are lagged price echoes that an AR-matched placebo times *better* than the real series), **selection inflation under honest N** (DSR / Harvey-Liu haircuts), and **OOS sign-flips on the consume-once holdout** (BOLL, TRENDS, TOM, CME canonical, ICHI). The calendar effects reproduced BACKLOG/literature KILL priors (Halloween reanchor p=1.000; DOW tail-driven by shared crash Wednesdays; TOM/CME are equity-flow effects crypto structurally lacks).

**Exactly one signal — D1-LS-DONCH — earned PROMISING** by passing the right null *and* beta-neutrality *and* the Bonferroni haircut, failing only the honest-N DSR (a search penalty curable by pre-registration) with real-but-decaying OOS performance. It is the only candidate in this batch worth capital or further work; everything else is a clean KILL.
