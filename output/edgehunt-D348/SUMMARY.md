# EdgeHunt D348 — Synthesis Summary

12 hypotheses re-tested with the strongest honest build + full gauntlet (Deflated Sharpe @ honest N, CPCV/PBO, block-bootstrap CI, surrogate nulls, consume-once holdout, residualization/liquidity controls). Every candidate was given a genuine rescue attempt before judgment.

## Verdict counts

| Verdict | Count |
|---|---|
| KILL | 10 |
| DEFERRED | 2 |
| SURVIVE / PROMISING | **0** |

No strategy SURVIVED or was PROMISING — there are no monthly %/$ candidates to carry forward.

## Verdict table

| ID | Hypothesis | Verdict | Net Sharpe (headline) | Binding gate | Honest N | Surrogate p | monthly@$100k | Conf |
|---|---|---|---|---|---|---|---|---|
| D4-M1 | Dual momentum (abs+rel) | KILL | 0.85 IS / −0.64 holdout (gated 1.60 = timed beta, resid α ~0) | consume-once holdout (DSR p 0.47, PBO 0.44) | 40 | 0.00 (IS only; moot) | n/a | high |
| D8-C1 | Funding dispersion (cross-venue) | KILL | 3.0 realistic / 4.9 zero-cost (annualization-inflated) | Deflated-Sharpe @ N (p 0.59–0.70) + economic triviality | 48 | 0.00 (real but redundant w/ level) | $36 (≈$75 best) | high |
| D4-S7 | Short-term reversal (weekly+daily XS) | KILL | −0.39 (best of 36; −0.54 @28bps) | gross-negative/flat (no harvestable edge) | 36 | 0.45 | n/a | high |
| D4-M3 | 52-week-high nearness (anchoring) | KILL | 1.04 raw (haircut 0; resid-α vs BTC ~0) | Harvey-Liu haircut→0 + DSR 0.63 + NF1 surrogate + liquidity 1.04→0.51 | 30 | 0.04 (NF1) | n/a | high |
| D4-M4 | Frog-in-the-pan / info discreteness | KILL | ~0 (fipSpread 0.81 but +0.00004/wk incremental, CI spans 0) | incremental-over-momentum CI spans 0 + holdout (lowID −0.82) + DSR 0.68 | 64 | 0.01 (ID placebo broken; moot) | n/a | high |
| D8-A7 | Ensemble stacking of weak signals | KILL | 1.03 meta CPCV-OOS / 0.58 holdout | KEY: fails to beat naive 1/k (holdout 0.58 vs 0.96) + surrogate | 72 (32 meta) | 0.82 (funding 0.65) | n/a | high |
| D8-B4 | Rebalancing premium / vol harvesting | KILL | 0.17 (best freq) | corr-matched + XS-shuffle surrogate (DSR 0.069, boot CI spans 0) | 24 | 0.39 | ~$293 (CI spans 0 → n/a) | high |
| D8-B1 | Risk parity (inverse-vol / ERC) | KILL | 0.40 (RP−EW spread; construction-α ~0) | residualize-vs-low-vol-factor (α t≤0.94) + surrogate + DSR | 12 | 0.167 | n/a | high |
| D3-A3 | GARCH/EGARCH vol-forecast timing (BTC) | KILL | 0.45 (< B&H@matched 0.49, lift −0.037) | GARCH-simulated zero-edge surrogate (p_lift 0.575) + matched-exposure B&H | 108 | 0.575 | n/a (~$1,937 = pure timed beta < B&H) | high |
| D3-B9 | DVOL signals (spike/mom/level/timer) | KILL | 0.11 honest fwd (1.01 = boundary-leak) | strict-forward-lag (1-day-lag collapse) + DSR @ N | 58 | 0.003 naive → n.s. de-leaked | n/a | high |
| D3-B1 | GEX / dealer gamma (walls, flip) | DEFERRED | −0.17 (proxy-only) | data-availability (per-strike OI+gamma history absent) + surrogate + DSR | 14 | 0.42 label / 0.51 block | n/a | high |
| D3-B3 | 25-delta risk reversal / skew | DEFERRED | 0.095 raw (resid 0.45 = partial-out artifact, boot CI spans 0) | data-DEFERRED (paid per-delta IV history); proxy fails lead-lag + boot + DSR + PBO | 48 | 0.50 boot / 0.60 lead-lag | n/a | high |

## SURVIVE / PROMISING callouts

None. Zero of 12 cleared the gauntlet. No monthly %/$ to report (D8-C1's $36/mo and D8-B4's ~$293/mo are explicitly sub-threshold / CI-spans-zero and do not qualify as edge).

## Recurring failure mechanisms (cross-cut)

- **Timed BTC beta in disguise** (M1, M3, M4): long-only "edges" are a market-timing/cash-gate overlay; residual-alpha-vs-BTC Sharpe ≈ 0 and the beta-neutral leg overfits to negative OOS. The consume-once holdout inversion is the consistent tell.
- **Real signal, no tradable/incremental PnL** (S7 rank-IC t=−4.49; C1 dispersion wedge CI strictly positive; M4 ID-placebo p=0.01): statistically real but sub-cost, redundant with a known factor (funding level, momentum), or non-monotone across the cross-section.
- **Risk transform ≠ alpha** (B1 risk parity = low-vol beta tilt t≈7.6; B4 rebalancing premium = structural vol+corr artifact, monotone in correlation).
- **Deflated Sharpe / PBO failure @ honest N** is near-universal — config search deflates headline Sharpes below the ~0.95 bar (A3 DSR 0.079, B9 0.65, A7 0.65, B1 0.218).
- **Boundary leakage / look-ahead** (B9: lag0 1.01 → lag1 0.11): same-day contamination inflates naive surrogates; one honest day of lag collapses it.

## Caveats (shared)

- Panel is **survivorship-biased** (LUNA/FTT absent) — cross-sectional results are an upper bound.
- FULL universe is thin (15–18 fully-covered coins), leaving little robust selection room for top-K/bottom-K spreads.
- Committed gauntlet primitives live in `src/lib/training/statistical-validation.ts` (DSR, CSCV/PBO, summarizeReturnSeries), not the `src/lib/validation/strategy-validator.ts` path cited in AGENTS.md/BACKLOG.

## Follow-up

- **D3-B1 (GEX) and D3-B3 (risk reversal): forward-record only.** Both require a paid point-in-time per-strike greeks / per-delta IV surface history that does not exist at $0. Mark for the BACKLOG growing-holdout protocol: pre-register the first block, consume-once holdout, score once at small forward-N. Null = strike-shuffle placebo + gamma-regime/VRP block + flip label-shuffle. Do NOT buy the paid panel on current evidence — the strongest $0 proxies are unambiguously null/negative.
- **D8-C1 (funding dispersion): closed.** Wedge is real but ~0.08 bps/8h (sub-cost, near-zero capacity) and adds nothing over funding level — no reason to revisit unless cost structure changes materially.
- **All KILLs are stable** in split-half / consume-once OOS; no re-test warranted. The momentum/M-family lesson (long-only = timed beta) is now confirmed four times (M1, M3, M4, and A7's $0 books) — treat any future long-only crypto "edge" as beta until residualized.

## Artifacts

Scripts in `scripts/edgehunt-D348/` and JSON results in `output/edgehunt-D348/` (per-item provenance: `m1-harden.json`, `m1-rescue.json`, `c1-strengthen.json`, `c1-verdict.json`, `s7-strong-results.json`, `m3-52wk-high.json`, `m3-neutral.json`, `m3-gauntlet.json`, `m4-frog-in-pan.json`, `m4-strengthen.json`, `d8a7-ensemble-stack-{full,funding}.json`, `d8b4-results.json`, `d8b1-risk-parity.json`, `a3-results.json`, `d3b9-dvol.json`/`d3b9-diag.json`/`d3b9-confirm.json`, `d3b1-gex-proxy.json`/`d3b1-VERDICT.json`, `d3b3-skew.json`).
