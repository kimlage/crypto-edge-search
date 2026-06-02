# EdgeHunt-Quant Campaign — Synthesis

**Date:** 2026-06-01 · **Strategies tested:** 11 · **Verdict mix:** 10 KILL · 1 PROMISING · 0 SURVIVE

Every hypothesis was pushed to its strongest honest form and run through the committed gauntlet (net-of-cost, baselines / matched-exposure control, Deflated Sharpe @ honest N, block-bootstrap CI, CPCV/PBO, Harvey-Liu haircut, the right surrogate null, and a consume-once forward holdout). The honest bottom line: **nothing is investable.** Ten strategies died; one (Q9-LOWVOL) is a real-but-marginal cross-sectional effect that fails multiple-testing at honest N.

## Verdict table

| ID | Name | Verdict | Net Sharpe | Binding gate | Honest N | Surrogate p | Monthly @ $100k |
|----|------|---------|-----------|--------------|----------|-------------|-----------------|
| Q1-HMM | Strictly-causal Gaussian HMM regime timer (BTC) | KILL | 0.779 | deflated_sharpe | 72 | 0.065 (GARCH) | n/a |
| Q2-BOCPD | Bayesian online change-point timer (D8-A5) | KILL | 0.775 | deflated_sharpe | 108 | 0.103 (phase-rand) | n/a |
| Q3-ACCEL | Acceleration momentum / momentum-of-momentum (D4-M6) | KILL | 1.29 IS / −0.27 OOS | deflated_sharpe | 96 (≤138) | 0.004 (XS-shuffle) | n/a |
| Q4-STREV | Weekly residual short-term reversal (D4-S7/M2) | KILL | 0.000 | baselines | 379 | 0.250 (XS-shuffle) | n/a |
| Q5-TOD | Time-of-day / UTC-hour session timing (BTC) | KILL | 0.71 IS / −0.78 OOS | deflated_sharpe | 576 | 0.040 (cal-reanchor) | n/a |
| Q6-DVOLTS | DVOL term-structure (contango-sell) vol timing | KILL | 3.40 (mined) | matched-exposure-control | 288 | 0.046 (tail-block) | n/a |
| Q7-VOLREGIME | Revive killed signal via vol-regime gate (D3-A4) | KILL | 0.761 (ens.) / 1.279 (best) | baselines / matched-exposure | 600 / 4 | 0.022 (GARCH) | n/a |
| Q8-EFFRATIO | Efficiency-Ratio + ADX trend-strength gate on TSMOM | KILL | 1.324 IS / −0.058 OOS | deflated_sharpe | 1456 | 0.002 (block-shift) | n/a |
| Q9-LOWVOL | Cross-sectional low-volatility anomaly (β-neutral L/S) | **PROMISING** | 1.12 (best-96) / 0.70 (pre-reg) | deflated_sharpe | 96 | 0.002 (best) / 0.056 (canon) | ~$2.6k |
| Q10-CARRYMOM | Carry + momentum combo (super-additive claim) | KILL | 2.722 IS / −0.04 WF | cpcv_pbo + holdout | 96 | 0.002 (XS-shuffle) | n/a |

> Q1-HMM and Q2-BOCPD subsume the prior D3-A4 (regime-switching Markov) and D8-A4 (HMM gate) / D8-A5 kills.

### Counts
- **Total: 11 framings across 10 distinct strategy IDs** (Q9 carries both a best-of-96 and a pre-registered canonical headline)
- **KILL: 10** · **PROMISING: 1** · **SURVIVE: 0**
- **Binding gate breakdown:** deflated_sharpe ×6 (Q1, Q2, Q3, Q5, Q8, Q9); baselines / matched-exposure ×3 (Q4, Q6, Q7); cpcv_pbo + holdout ×1 (Q10)
- **Surrogate null:** passed in 6 cases (Q3, Q5, Q6, Q7, Q8, Q9-best, Q10) yet the strategy still died — the documented "best-of-N beats a single-draw null by construction" trap; failed / borderline in Q1 (0.065), Q2 (0.103), Q4 (0.250), Q9-canonical (0.056)
- **OOS / holdout collapse** was decisive in Q3, Q5, Q8, Q10 (forward Sharpe ≤ 0); Q9 was the only one with a strong consume-once holdout (+2.08)
- **Confidence:** high on all 10 KILLs; medium on the one PROMISING

## Prominent callout — the only thing still standing

### Q9-LOWVOL — PROMISING (not SURVIVE)
Cross-sectional low-volatility anomaly on the 30-coin Binance daily panel (2020-06→2026-05): long low-vol / short high-vol, **dollar- and beta-neutral**, net 4 bps/side. This is the **only** strategy with a genuinely real, economically-grounded signature:
- Beta-neutralization roughly **doubles** Sharpe (0.78 vs 0.38), realized book beta ≈ +0.05 → a true cross-sectional effect, not a disguised short-beta timing bet.
- **Every** beta-neutral config is positive (min Sharpe 0.58) — broad, not a lucky corner.
- Best-of-grid net Sharpe **1.12** IS, beats EW-market (0.23) and random-L/S 95th pct (0.67); XS-shuffle null **p=0.002**; PBO=0.40; **consume-once OOS holdout +2.08**.

**Economics (best-of-96, in-sample, survivorship-biased UPPER BOUND):**
- Mean daily net ≈ **8.72 bps** on gross.
- **Monthly @ $100k gross ≈ $2,615** (≈ 2.6% / month).
- **Monthly @ $10k gross ≈ $262** (≈ 2.6% / month).

**Why it is PROMISING, not SURVIVE:** binding gate is **deflated_sharpe** — DSR p=0.476 at honest N=96 (daily Sharpe 0.0588 ≈ expected-max 0.0602), and the Harvey-Liu haircut also fails (adjP=0.67). The 1.12 headline is search-inflated (lives almost entirely in the 90-day vol window). The pre-registered N=1 canonical (vol30 / weekly / tercile) gives only Sharpe **0.70**, fails DSR@N=1, block-bootstrap CI includes zero, and XS-shuffle p=0.056. The $2.6k/month is thin and a survivorship upper bound.

> No strategy produced a defensible, multiple-testing-corrected, OOS-persistent, cost-surviving edge. Q9 is the single candidate worth any follow-up, and even it must clear honest-N significance before it could be called investable.

## Honest assessment — they (effectively) all died

Across 11 hypotheses there is **zero SURVIVE**. The recurring kill mechanisms:
1. **De-risking masquerading as timing alpha** (Q1, Q2-cut, Q6, Q7, Q8) — the gate/timer raises the *ratio* by cutting exposure while earning *less* total return; the matched-exposure control exposes it every time.
2. **Detection latency** (Q2) — causal change-point / regime detectors fire *after* the move; by confirmation the edge is gone.
3. **No separable premium over an already-killed parent** (Q3 over momentum, Q7 over TSMOM/RSI, Q10 over carry) — orthogonalized / residual variants give OOS Sharpe ≈ 0.
4. **Search inflation vs honest N** (Q5 @576, Q8 @1456, Q9 @96) — surrogate nulls pass but DSR@honest-N and the consume-once holdout don't.
5. **No positive gross tail edge / cost wall** (Q4 negative gross spread; Q5 sharpest bucket gross +1.15 bps dies on 8 bps round-trip).

## Follow-up

1. **Q9-LOWVOL only.** Re-run on a **survivorship-free, point-in-time universe** (include delisted/migrated coins) — current panel is an explicit upper bound. If the broad β-neutral positivity holds on the unbiased universe, **pre-register a single canonical config** up front so the test is honestly N=1 and can clear DSR. Target the long-vol-window region where the effect concentrates, but commit to it before seeing OOS.
2. **Retire the rest.** Q1–Q8, Q10 are KILL with high confidence and reinforce existing lab priors (D3-A4, D8-A4/A5, D4-M6, D1-11, D3-A2, momentum T1/TA2, VRP B5). Do **not** revisit regime / change-point timers or vol-gated revivals of killed signals without a fundamentally new data source.
3. **Methodology is the asset.** The matched-exposure control + GARCH / phase-randomization surrogate + DSR-at-honest-N + consume-once holdout reliably separated mirage from edge across 11 hunts — this gauntlet (per the edge-search pivot memo) is the publishable open-source deliverable, independent of any single strategy surviving.

---
*Artifacts per strategy live alongside this file in `output/edgehunt-quant/` and in `scripts/edgehunt-quant/`. Net Sharpes are net of 4 bps/side; "n/a" monthly means the strategy has no real edge (lost OOS or to the matched-exposure control), so projecting $/month would be dishonest.*
