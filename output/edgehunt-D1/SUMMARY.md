# EdgeHunt D1 — Synthesis

_Generated 2026-06-01. Universe: 8-major equal-risk book (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX), 3,211 daily bars, 2017-08-17 → 2026-06-01 (~8.8yr). Costs: 4 bps/side on every position change._

## Counts

| Bucket | N |
|---|---|
| Hypotheses dispatched | 11 |
| Completed (judged to a verdict) | 2 |
| Did not complete (server rate-limited, no verdict) | 9 |
| **SURVIVE / PROMISING** | **0** |
| **KILL** | **2** |

Both hypotheses that reached a judgment were **KILL**. No SURVIVE, no PROMISING. The other 9 dispatched slots returned `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited` — these **never ran** and carry **no verdict** (re-queue; do not count as KILL).

## Verdict table

| ID | Hypothesis | Verdict | Net Sharpe | Benchmark | Binding gate (failed) | Honest N | Surrogate p | Monthly @ $100k | Conf |
|---|---|---|---|---|---|---|---|---|---|
| D1-03 | Supertrend (ATR-band trend overlay) | **KILL** | 1.645 (gross 1.665) | B&H vol-matched 0.917 | deflated-Sharpe-vs-B&H = 0.307 (need <0.05); excess-over-B&H CI straddles 0 (−0.00017 [−0.00065, +0.00033]) | 144 | 0.801 (vol-preserving; surrogate mean 1.926 > observed 1.645) | n/a (artifact) | high |
| D1-06 | CCI (z-scored typical-price oscillator) | **KILL** | 1.768 (gross 1.784) | killed-RSI book 1.689 | deflated-Sharpe-vs-RSI = 0.009 (need <0.05); surrogate null p=1.0 | 128 | 1.0 (phase mean 2.413 / block mean 2.317, both > observed 1.768) | n/a (artifact) | high |
| — | 9 further D1 slots | **NO VERDICT** | — | — | run never executed (rate-limited) | — | — | — | — |

## SURVIVE / PROMISING callouts

**None.** Zero strategies cleared the gauntlet, so there is no real monthly %/$ to report on the positive side.

For honesty, both winners produced eye-catching standalone numbers that are **selection-inflated trend artifacts, not edges** — do not bank either:

- **D1-06 CCI** best cell `cci_p20_thr100_trend_longflat`: **+5.31%/mo ≈ $531/mo @ $10k, $5,307/mo @ $100k** on net Sharpe 1.768. Killed because the surrogate null (recomputing CCI on phase-randomized AND vol-preserving block-bootstrap surrogates) returns mean book Sharpe **2.3–2.4, higher than observed**, combined p=1.0; and deflated-Sharpe over the already-killed RSI book collapses to p=0.009. It is mechanical long-only trend-following of a trending asset (a TSMOM proxy), not predictive content.
- **D1-03 Supertrend** best cell `atr7_m2_longflat_vt0.4_ema200`: **+2.08%/mo ≈ $208/mo @ $10k, $2,084/mo @ $100k** on net Sharpe 1.645. Killed because it does **not beat its own buy-and-hold benchmark** after deflation (DSR-vs-B&H 0.307; excess-over-B&H 95% CI straddles zero and the point estimate is *negative*), and the vol-preserving surrogate null beats it (surrogate mean 1.926 > observed 1.645, p=0.801).

The gross≈net spread on both (CCI 1.784 vs 1.768; Supertrend 1.665 vs 1.645) means **cost is not the killer** — the raw signal itself is statistically indistinguishable from a structure-free, vol/spectrum-preserving null. That is the strongest form of KILL.

## Why each KILL (one line)

- **D1-03 Supertrend** — A long-flat ATR trend overlay on a secularly-rising book inevitably "works," but it fails the only benchmark that matters: it cannot out-Sharpe its own buy-and-hold after the multiple-testing deflation (144 configs swept). DSR-vs-B&H 0.307, excess-over-B&H CI = [−0.00065, +0.00033] (point est negative), and the vol-preserving surrogate (which destroys any genuine timing while keeping vol/autocorrelation) scores *higher* than the live strategy (1.926 vs 1.645, p=0.801). PBO 0.2 and bootstrap mean>0 pass, but they only confirm "long beta is real," not "the timing adds anything."
- **D1-06 CCI** — Built as the strongest honest version (causal MAD z-score of typical price, 128-config sweep) and it even beats the same-grid killed-RSI book (paired excess CI lower>0), passes DSR@N=0.997, PBO=0. **Inherit-the-kill check did not fire** (signal corr to RSI 0.41, value corr 0.78, both <0.9) so it is killed on its own merits, not by tautology. The two binding nulls are decisive: surrogate p=1.0 (CCI recomputed on phase-randomized + vol-preserving block-bootstrap surrogates scores 2.3–2.4, *above* observed 1.768) and deflated-Sharpe-vs-RSI p=0.009 (no edge over the dead oscillator after deflation). A path/momentum artifact of a trending asset.

## Follow-up (the deeper one)

**The shared lesson across both KILLs: a long-flat trend/oscillator overlay on a secularly-rising crypto book will always post a 1.6–1.8 net Sharpe and a "real-looking" monthly $, and it is always a long-beta + mechanical-momentum artifact unless it survives BOTH (a) deflated-Sharpe against the *right* benchmark (its own buy-and-hold, or the already-killed sibling indicator), and (b) a vol/spectrum-preserving surrogate null where the indicator is recomputed on each surrogate.** Neither D1-03 nor D1-06 cleared either of those two gates, and in every case the surrogate mean came in *above* the observed Sharpe — the clearest possible signature of "no information, all path."

Concrete next actions:

1. **Re-queue the 9 rate-limited slots.** They returned server throttling, not verdicts — no signal was tested. These are the only open items in D1.
2. **Stop running bare long-flat trend/oscillator overlays through the full gauntlet.** They are now a known dead family (Supertrend D1-03, CCI D1-06, plus the prior RSI KILL). Pre-screen any future single-indicator long-flat idea against just two cheap gates first — deflated-Sharpe-vs-its-own-B&H and the vol-preserving surrogate-recompute null — before spending a full run; if the surrogate mean ≥ observed, kill immediately.
3. **If trend is to be pursued at all, the bar is incremental over buy-and-hold (and over the killed RSI/Supertrend book), not standalone Sharpe.** Require the excess-over-B&H bootstrap CI to be entirely >0 — D1-03's point estimate was already negative, which is the tell that the timing subtracts value net of turnover.
4. **The deeper open question worth a genuine run: long-SHORT or market-neutral configurations.** Every surviving-looking cell in both reports was `longflat` (long-only), which is exactly what makes them long-beta traps. A cross-sectional or long-short version that cannot harvest static beta — judged on the same surrogate-recompute and deflated-vs-neutral-benchmark nulls — is the only branch of this family not yet falsified, and is the one place a non-artifact edge could still hide.

## Artifacts

- scripts/edgehunt-D1/supertrend-trend-overlay.ts → output/edgehunt-D1/supertrend-report.json
- scripts/edgehunt-D1/cci-oscillator.ts → output/edgehunt-D1/cci-report.json
