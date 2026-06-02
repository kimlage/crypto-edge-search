# EdgeHunt D6 — Synthesis Summary

**Theme:** Macro / exogenous-signal BTC timers (rates, curve, real yields, news tone) on $0 data.
**Compiled:** 2026-06-01 · Window: BTC 2023-06..2026-05 (M1, S5) / 2017-08..2026-05 (M4)
**Excluded by request:** D6-M2 (HY OAS credit spreads); NC (already tested).

## Run accounting

11 dispatched · **3 completed** · **8 failed to run** (API rate-limit, not a strategy result — re-runnable).

| Status | Count |
|---|---|
| Completed verdicts | 3 |
| KILL | 3 |
| SURVIVE / PROMISING | 0 |
| Rate-limited (no result) | 8 |

## Verdict table (completed)

| ID | Thesis | Verdict | Best net Sharpe | Binding gate | Honest N | Surrogate p | Monthly @ $100k | Conf |
|---|---|---|---|---|---|---|---|---|
| D6-M1 | BTC vs US rates + 2s10s yield-curve regime timer | **KILL** | 1.548 | baselines (< B&H 1.522, < random-lottery-95 1.666) | 60 cfg / macroN 3 | 0.319 (AR-matched-rate) | n/a | high |
| D6-M4 | Real yields / "digital gold" (falling 10Y TIPS real yield → buy BTC) | **KILL** | 0.828 | AR(1)-matched placebo p=0.096 + regime-holdout OOS −0.77 + DSR@N16 | 16 | 0.120 pair-shuffle / 0.096 AR(1) | n/a | high |
| D6-S5 | GDELT news-tone (sentiment) timer | **KILL** | 1.27 | baselines (< B&H 1.24, < random-lottery-95 1.35) | 22 | 0.16 (AR-matched tone) | n/a | high |

## SURVIVE / PROMISING callouts

**None.** No completed config produced a deployable edge, so there is no monthly %/$ to report (all `monthly@$100k = n/a`).

## Why everything died (one shared mechanism)

All three KILLs collapse to the same **coincident-beta trap**: the apparent in-sample Sharpe is relabelled long-BTC beta on a bull-trending asset, not exogenous-signal alpha.

- **Raw predictive signal is ~zero.** corr(signal_{t-1}, fwd BTC ret): M4 real-yield change ∈ [−0.024, +0.006]; S5 tone = 0.00 (hit-rate 0.516, coin-flip); M1 rates "move too slowly to give a tradable lead."
- **Fails the matched-noise placebo.** AR-matched persistent series of the same shape time BTC nearly as well: M1 p=0.319, M4 p=0.096, S5 p=0.16 — none < 0.05.
- **Edge is SPX/risk-on beta.** M1 every top config beta 0.39–0.87 on SPX; M4 beta 0.443, t(alpha)=2.02 (marginal, dies under placebo).
- **Inverts out-of-regime.** Holdout: M1 net −1.65 (resid −2.62), M4 IS +1.34 → OOS −0.77 (vs B&H OOS +0.91), S5 −1.48.
- **Beats nothing real.** Best honest configs barely match buy-and-hold (M1 1.548 vs 1.522; S5 1.27 vs 1.24) and lose to a random in/out lottery.

This independently **confirms the documented priors** (rates lead too slowly; inflation-hedge / digital-gold failed OOS in 2021-22; news tone is reactive not predictive).

## Data provenance ($0)

- **M1/M4:** FRED no-key CSV (DGS2, DGS10, T10Y2Y, DFII10, SP500) through 2026-05-29, aligned to BTCUSDT spot / `output/nf1/BTC_daily_ohlc.json`.
- **S5:** GDELT DOC 2.0 API IP-throttled (HTTP 429); fell back to `gdelt-bq.gdeltv2.gkg_partitioned` on BigQuery (`_PARTITIONTIME`-pruned, ~440GB scan, under 1TB/mo free tier) → 1097 daily tone+volume rows.
- **Gold leg of M4 DEFERRED:** FRED `GOLDPMGBD228NLBM` bot-blocked, stooq XAU now needs apikey. Real-yield core (the load-bearing leg) was tested and is dead.
- **Validator note:** prompt path `src/lib/validation/strategy-validator.ts` does not exist; committed primitives in `src/lib/training/statistical-validation.ts` (Deflated Sharpe, long-block bootstrap, CSCV/PBO) were chained directly.

## Follow-up

1. **Re-run the 8 rate-limited dispatches** — these are infrastructure failures (API "temporarily limiting requests"), not strategy results; D6 is not complete until they return. Re-queue with backoff / 1-req-spacing.
2. **No further work on M1/M4/S5.** Three independent macro/sentiment timers all die on the same coincident-beta mechanism with well-powered nulls — treat exogenous risk-on-beta-shaped signals as a closed line; do not re-test variants.
3. **Optional, low-priority:** complete M4's gold leg only if a $0 PIT gold source appears (FRED gold is bot-blocked, stooq needs a key). Real-yield core already KILLs, so this is confirmatory at best.

## Artifacts

- Verdicts: `output/edgehunt-D6/m1_result.json`, `output/edgehunt-D6/D6-M4_verdict.json`
- Gauntlet log (M4): `output/edgehunt-D6/gauntlet_results.txt`
- Data reliability notes: `output/edgehunt-D6/_data_reliability_notes.json`
- Data: `output/edgehunt-D6/{DFII10,DGS2,DGS10,T10Y2Y,SP500}.csv`, `gdelt_tone.json`, `fng_history.json`
- Scripts: `scripts/edgehunt-D6/{m1_rates_curve,m1_push,load_data,probe,gauntlet,d6s5_harness,d6s5_run,fetch_gdelt_tone}.ts`
