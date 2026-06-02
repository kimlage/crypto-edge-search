# Edge-Hunt Deepen Round — Post-Adversarial-Verification Synthesis

**Date:** 2026-06-01
**Round:** 4 leads carried into DEEPEN (pre-registered consume-once on unseen data), then handed to an ADVERSARIAL-VERIFY skeptic instructed to default-to-refute.
**Promotion rule (both required):** clear the *binding gate on data the single pre-registered config never saw* **AND** survive the skeptic. Either failure caps the lead at PROMISING (or drops it to KILL).

---

## Results table

| Lead | Deepen verdict | Post-verify verdict | Binding gate (post-verify) | Fwd net Sharpe | DSR @ N=1 | Monthly @ $100k | What it still needs |
|---|---|---|---|---|---|---|---|
| **donchian** — XS Donchian channel-position L/S | PROMISING | **CONFIRMED PROMISING** | DSR@N=1 fwd 0.79<0.95 (NW t(mean)=0.96, block-boot CI-lower<0). *Stated beta-hedge gate 0.318 is an in-sample over-hedge artifact; honest-OOS hedge = 0.78.* | 0.790 | 0.79 (fail) | $2,298 | Magnitude significance on unseen data — structure is real (XS-shuffle p=0.009, positive every N in [20,200] and every quarter) but the 388-row holdout mean is indistinguishable from zero. Needs a longer survivorship-clean panel (live 17% delist-flip-negative tail). |
| **vrp** — VRP harvest, crash-gate-only | KILL | **CONFIRMED KILL** | deflated_sharpe_honestN DSR=0.389@N=90 (+ PBO=0.50). *Verify exposes deeper kill:* 2021 DVOL-onset regime artifact — leave-2021-out Sharpe 1.257 -> 0.560; post-2021 DSR@N=1 only 0.842. | 0.987 in-iso / **0.842 ex-2021** | 0.389@N=90 (fail) | $1,034 (2021-inflated) | Dead. Edge is sub-RF outside the 2021 DVOL-onset window; favorable consume-once holdout (1.35) is lucky split-placement on the 2nd-richest year. No fix without lift-able IV history (un-liftable). |
| **dated** — Dated-futures basis carry (vol-targeted) | PROMISING | **DOWNGRADE-WITHIN-PROMISING** (label holds; headline economics cut ~2x) | financing-accounting + deflated_sharpe_excess. Script charges RF on 1 unit but borrow on ~2.9x-levered notional; correcting collapses levered series to DSR 0.18. | **0.74 corrected** (1.54 unlevered; NOT claimed 1.64) | 0.18 corrected (fail) | **~$475 corrected** (NOT $1,051) | Honest financing on levered cash-and-carry. A thin **real** market-neutral excess survives *unlevered* (~4.9%/yr, t=2.41, DSR 0.60) — but sub-every multiple-testing bar and regime-fragile (sub-RF in 2023, -37% in 2021 cohort). |
| **reserve** — BTC exchange reserve-depletion | PROMISING | **CONFIRMED PROMISING** | honest-N-deflated surrogate sig (p~=0.36 at N=10) + cross-asset generalization (ETH dead). Prereg is rank-1-of-11 forward-Sharpe point in a searched 10-config neighborhood; only 2/10 keep surrogate. | 1.19 fwd / 0.985 raw | 0.985 raw -> **fails when deflated by N=10** | $1,701 | A genuine larger N: surrogate p=0.044 was earned at honest N=1 but the config is the neighborhood argmax. Needs paid multi-asset flow + live paper-forward; incremental alpha over always-long not CI-significant, 2026-YTD Sharpe 0.07, ETH fwd -0.85. |

---

## Count after verification

- **CONFIRMED-SURVIVE: 0**
- **PROMISING: 3** — donchian, dated, reserve
- **KILL: 1** — vrp

---

## The headline call: did ANYTHING survive?

**No. Zero leads cleared adversarial verification to SURVIVE. None is deployable-grade.**

Promotion required two independent things and **no lead achieved both**:

1. **Clear the binding gate on data the single pre-registered config never saw.** Every lead failed its binding significance gate on unseen data:
   - donchian: DSR@N=1 forward 0.79 (NW t(mean)=0.96, block-boot CI-lower<0) — sign is real, magnitude is not.
   - vrp: DSR=0.389@N=90 (PBO=0.50), and the in-isolation strength is itself a 2021-onset artifact.
   - dated: DSR 0.18 once levered financing is charged correctly; the headline 12.6%/Sharpe 1.64 was inflated ~2x by an RF-accounting leak.
   - reserve: raw DSR@N=1 0.985 looks like a pass, but the prereg config is the **argmax of a 10-config searched neighborhood** — deflated by honest N=10 the surrogate p goes 0.044 -> ~0.36 and fails.

2. **Survive the skeptic.** The adversarial pass *strengthened* every non-promotion: it found vrp's 2021 regime concentration (leave-2021-out 1.257 -> 0.560), corrected dated's financing leak (halving the economics), exposed reserve's honest-N argmax problem, and confirmed donchian's magnitude-insignificance is robust across block lengths. In no case did the skeptic uncover hidden alpha that would justify an upgrade.

**The single most honest sentence:** the best-looking number in the whole round — reserve's BTC paper-forward at **net Sharpe 1.19 / $1,701/mo @ $100k** — is real, causal, leak-free, and regime-distributed, but its **one remaining blocker is honest-N**: the pre-registered config is the rank-1-of-11 point in a neighborhood that was clearly searched, so its surrogate significance does not survive multiple-testing deflation. That is the textbook line between PROMISING and SURVIVE, and it did not cross it.

The two structurally-real survivors worth keeping warm are **reserve** ($1,701/mo, blocker: honest-N / needs paid multi-asset flow + live paper-forward) and **donchian** ($2,298/mo, blocker: 388-row holdout magnitude not significant). Both are genuine cross-sectional/structural signals (right-null surrogates pass at p=0.009 and p=0.044) that simply have not earned significance at honest N on unseen data. **dated** survives only as a thin ~4.9%/yr unlevered carry after correcting a 2x economics overstatement. **vrp** is a clean KILL.

---

## Executive summary (tight)

Four leads entered deepening; after pre-registered consume-once testing **and** an adversarial skeptic instructed to refute, **none survived to deployable-grade.** Final count: **0 CONFIRMED-SURVIVE, 3 PROMISING, 1 KILL.** No promotion occurred because no lead did both required things — clear its binding gate on data the single frozen config never saw *and* withstand the skeptic. The closest miss, BTC reserve-depletion, posts a clean-looking paper-forward Sharpe 1.19 ($1,701/mo @ $100k) but is blocked by honest-N: its config is the argmax of a searched 10-config neighborhood, so the surrogate p deflates from 0.044 to ~0.36 and fails. Donchian XS L/S ($2,298/mo) is a genuine cross-sectional signal (XS-shuffle p=0.009) whose 388-row holdout magnitude is statistically indistinguishable from zero (NW t=0.96). Dated-futures carry stays PROMISING only after the skeptic cut its headline ~2x for an RF-financing leak — a real but thin ~4.9%/yr unlevered, sub-RF in 2023. VRP harvest is a confirmed KILL: its apparent strength is a 2021 DVOL-onset regime artifact (leave-2021-out Sharpe 0.560) and its passing holdout is lucky split-placement. Honest bottom line: two structurally-real edges to keep warm (reserve, donchian), one thin carry, one dead — and **nothing to deploy.**

---

VERDICT: PROMISING (round-level; best lead = reserve) | net Sharpe 1.19 (reserve BTC paper-forward) | binding gate honest-N-deflated surrogate significance (p~=0.36 at N=10) + cross-asset generalization | honest N 10 (prereg is neighborhood argmax) | surrogate p 0.044 raw / ~=0.36 deflated | monthly@$100k $1,701 | confidence high
