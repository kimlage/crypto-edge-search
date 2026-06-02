# Edge-Hunt Synthesis — SUMMARY

_9 hypotheses tested, judged on net-of-cost tail performance against the committed gate battery (Deflated Sharpe @ honest N, CSCV/PBO, block-bootstrap CI, surrogate nulls, beats-baseline/beats-cash)._

## Executive summary

Of 9 hypotheses, **7 are clean KILLs and 2 are PROMISING** (none cleared the full bar to SURVIVE). The KILLs are decisive and concordant — every gate fails in the same direction, and in several cases the "edge" is shown to be plain funding-level carry, levered beta, or simply lower average leverage dressed up as a hedge. Daily-frequency crypto residuals do not mean-revert, the contrarian funding-fade is backwards (the data trends, not reverts), and the perp-spot / dated cash-and-carry book is a short-crash option that under-earns T-bills on a tail-adjusted basis.

**The two real leads are both term-structure / volatility carry, not cross-sectional alpha:**

1. **Dated-futures cash-and-carry (BTC+ETH)** — the strongest result in the batch. A real term-structure premium *beyond* perp funding that survives into the low-perp-funding regime. **~$640/mo @ $100k (raw, net of cost), Sharpe ~2.3.** Confidence: medium.
2. **VRP harvest with crash-gate (BTC/ETH options)** — a genuine, theory-backed variance-risk premium plus a "don't sell into the crash" gate that beats cash on Calmar. **~$495/mo @ $100k, Sharpe 1.37 at realistic tail.** Confidence: medium. Fails deflation + its own placebo at achievable N.

Honest bottom line: **nothing is investable-grade today.** Both survivors are power-limited (short history / small N) rather than disproven, and both are directional/volatility carry harvests with regime dependence. They warrant a focused, pre-registered, better-powered follow-up — not capital yet.

## Verdict counts

| Outcome | Count | Hypotheses |
|---|---|---|
| SURVIVE | 0 | — |
| PROMISING | 2 | Dated-futures carry, VRP harvest + crash-gate |
| KILL | 7 | Funding dispersion, Perp-spot carry, TSMOM-carry overlay, Residual momentum, PCA stat-arb, Vol-target (Moreira-Muir), Funding-sentiment fade |
| DEFERRED | 0 | — |

## Results table

| Hypothesis | Verdict | Net Sharpe | Binding gate | Monthly @ $100k | Confidence |
|---|---|---|---|---|---|
| **Dated-futures cash-and-carry (BTC+ETH)** | **PROMISING** | **2.27** (raw, net) | cross-sectional-shuffle p=0.66 (no expiry-selection alpha; 7/8 gates pass) | **~$640** (~$560 low-funding regime) | med |
| **VRP harvest + crash-gate (BTC/ETH)** | **PROMISING** | **1.37** (realistic tail; 0.53–1.0 under tail stress) | Deflated-Sharpe@N=90 (0.53<0.95) + shuffled-VRP placebo p=0.14 | **~$495** | med |
| Funding-momentum inverse (drift-stripped) | KILL* | +1.08 ann | Deflated Sharpe @ N=24 (prob 0.44<0.95) | ($1,859, non-surviving) | high |
| Residual / idiosyncratic momentum (BHM) | KILL | 0.76 best / 0.18 canonical | Deflated Sharpe @ N=192 (prob 0.18; gross fails too) + bootstrap CI spans 0 | ~$2,916 best (not investable) | high |
| Funding dispersion (Binance×Bybit) | KILL | 0.53 | beats-funding-level-baseline (−$296/mo vs baseline) + DSR 0.124 + HL pBonf=1.0 | $7.82 net / −$296 vs baseline | high |
| Perp-spot cash-and-carry | KILL | −0.17 excess (vs cash; +0.54 raw) | Deflated Sharpe (prob 0.0023 @ N=96); loses to cash on raw + CVaR/Calmar | +$284 gross / −$91 vs cash | high |
| TSMOM-carry crash-hedge overlay | KILL | 0.62 (worse than 0.73 matched-lev baseline) | left-tail control + calendar-reanchor surrogate p=0.33–0.36 | $897 (vs $1,074 for de-levering) | high |
| Vol-target / Moreira-Muir overlay (BTC) | KILL | 0.77 (levered beta; −0.17 OOS vs control) | matched-exposure control flips −0.17 OOS + GARCH surrogate p=0.386 + PBO=0.95 | n/a (levered beta, not alpha) | high |
| PCA basket stat-arb (Avellaneda-Lee) | KILL | 0.17 (OOS −1.16; gross negative at proper breadth) | surrogate null p≈0.20 (gross Sharpe negative pre-cost, 0/81 configs >0.5) | n/a (no real edge) | high |
| Funding-sentiment contrarian fade | KILL | −0.64 ann | Deflated Sharpe @ N=24 (fade prob 0.001); placebo p=0.88 beats it | n/a | high |

\* The funding-sentiment fade verdict carries two strands: the **requested fade is a decisive KILL** (−0.64 ann, 0/8 coins, placebo beats it), and its **mirror image — drift-stripped funding-momentum — is a real-but-thin lead** (+1.08 ann, 8/8 coins, surrogate p=0.023) that nonetheless fails the deflated-Sharpe gate (prob 0.44<0.95). Logged here as a near-miss worth exactly one pre-registered confirmation, not a survivor.

---

## ★ SURVIVOR / PROMISING SHORTLIST ★

Nothing reached SURVIVE. Two candidates are real enough to fund a deeper look. Both are **carry/volatility-premium harvests**, both are **power-limited, not disproven**, and both are **regime-dependent**.

### 1. Dated-futures cash-and-carry (BTC+ETH) — the headline lead

**What it is:** Short the contango quarterly future, long spot, hold to convergence. Harvests the dated-futures term-structure premium that exists *over and above* perp funding.

**Realistic monthly numbers (net of 4bps/side taker, early-unwind tail charged):**

| Notional | Monthly % (raw) | Monthly $ |
|---|---|---|
| $10k | ~0.64%/mo (~7.7%/yr) | **~$64/mo** |
| $100k | ~0.64%/mo | **~$640/mo** (~$560 in the low-perp-funding regime) |

**How robust / confident — medium:**
- Net raw Sharpe **2.27 annualized**, positive in **every calendar year** (973 portfolio-days, 2021-09→2025-09).
- The edge is **genuinely beyond perp funding**, established three ways: 82% basis↔funding correlation but with a **positive intercept (~4.5%/yr residual premium)**; daily OLS alpha **+9.9%/yr, t=3.25** after controlling for perp carry; and the decisive **regime test** — when perp funding is low (<5%/yr), dated carry still earns 6.7%/yr at **Sharpe 2.87**, essentially identical to the high-funding regime. It is NOT just re-priced perp funding.
- **7 of 8 gates pass** (DSR 0.962/0.972, bootstrap mean CI strictly positive, PBO=0.45, block-sign-flip surrogate p=0.001, Harvey-Liu t=5.26>2.95). The one failing gate (cross-sectional shuffle p=0.66) is *expected and non-falsifying* — this is a pure directional carry with no expiry-selection structure, so the shuffle has no power.
- **Honest caveats:** magnitude is **regime-dependent** (concentrated in contango-rich 2024–25; only 1.5%/yr in 2023); the eye-catching residual weekly Sharpe of 4.16 is a flagged variance-gaming artifact of a noisy negative beta — do not rely on it. The defensible number is raw Sharpe ~2.3 / ~7%/yr.

**Exact deeper follow-up it needs next:**
- Add **vol-targeting** on the neutral spread.
- Source **live basis and borrow/financing-cost data** (the backtest assumes idealized convergence and taker cost only — real roll/borrow can erode the residual premium).
- Stress the **2023-style thin-contango regime** explicitly and size to the low-funding-regime number (~$560/mo), not the contango-rich peak.
- Confirm before sizing; do not lean on the residual weekly Sharpe.

### 2. VRP harvest with crash-gate (BTC/ETH options) — the volatility lead

**What it is:** Harvest the variance-risk premium (sell variance / IV²−RV²), with a DVOL-spike + benign-regime "don't sell into the crash" gate and z-score sizing, 10% vol-target.

**Realistic monthly numbers (net of cost, realistic convex tail):**

| Notional | Monthly % | Monthly $ |
|---|---|---|
| $10k | ~0.5%/mo | **~$49/mo** |
| $100k | ~0.5%/mo | **~$495/mo** (78% win rate, skew −1.26) |

**How robust / confident — medium:**
- The **VRP premium is unambiguously real**: BTC IV²−RV² ≈ **+0.065 variance points, positive in 76% of weekly windows** (ETH +0.049).
- The **crash-gate is the genuine value driver**: cuts max-DD from −26% → −11%, Calmar 0.29 → 0.87, and **beats CASH on Calmar**. The signal *sign* is informative (inverse-VRP loses −0.36 Sharpe).
- Net Sharpe **1.37** at a realistic tail (decays 1.0→0.53 as the convex tail is charged 3–6×).
- **Why it's not a SURVIVE:** fails **two committed gates at the binding N** — Deflated Sharpe 0.53 (need >0.95) and the **shuffled-VRP placebo p=0.14** (the z-*sizing* is indistinguishable from random; signal-minus-premium Sharpe −0.62). DVOL history only goes back to 2021-03, so N≈266 weekly windows / 90 configs can't yet clear deflation. It beats cash on Calmar but not on CVaR.

**Exact deeper follow-up it needs next:**
- Re-test the **gate-only variant as the PRIMARY hypothesis** (the crash-avoidance gate is the real edge; the z-sizing failed its placebo — drop it or demote it).
- Source **longer-history options-implied vol** to lift N above the deflation threshold.
- Use **true variance-swap replication** for the payoff instead of the DVOL proxy.

---

## What died, plainly

The other seven are honest, concordant KILLs — worth stating so they are not re-litigated:

- **Funding dispersion (Binance×Bybit):** the spread (~0.5 bps/8h) is ~30× smaller than its 16-bps capture cost and is *dominated by plain funding-level carry* (adds −$296/mo vs a low-churn funding-level baseline). Real wedge, economically dead.
- **Perp-spot cash-and-carry:** a short-crash option (skew −12.9, kurt 175); the entire left tail is Nov-2024 alt-season liquidations (−18.9%). Under-earns T-bills on raw return; loses to cash even in the BTC+ETH steelman.
- **TSMOM-carry crash-hedge overlay:** the "hedge" is just **lower average leverage** — mis-timed (phase-shifted) trend signals hedge as well as the real one (surrogate p=0.33–0.36). Conditional timing adds nothing; net it *lags* matched-leverage carry.
- **Residual / idiosyncratic momentum (BHM):** signal is **genuinely real** (surrogate p=0.0033, beta-neutral by construction) but **too thin for the 30-coin cross-section** — even at zero cost the gross Sharpe fails deflation at honest N=192. Needs a 60–100+ name universe; not fixable by tuning.
- **PCA basket stat-arb:** the most fundamental failure — **gross Sharpe is negative pre-cost at any reasonable breadth** (0/81 configs >0.5). Daily-frequency crypto residuals simply don't mean-revert; the lone positive IS number inverts OOS (−1.16).
- **Vol-target / Moreira-Muir overlay:** the IS "win" is selection noise (PBO=0.95); flips −0.17 OOS vs a matched-exposure control and fails the GARCH vol-clustering null (p=0.386). The 0.77 Sharpe is **levered beta, not alpha**. DVOL didn't help. Matches the Cederburg-et-al. critique.
- **Funding-sentiment contrarian fade:** backwards — in 2023–2026 extreme funding **persists/trends, it does not revert** (fade 0/8 coins, placebo p=0.88 beats it). Its momentum mirror is a real-but-sub-threshold near-miss (see footnote above).

## One-line takeaway

The cross-sectional and stat-arb ideas are dead; **the only pulses are carry/volatility-premium harvests** — dated-futures basis (~$640/mo @ $100k, the headline) and a VRP crash-gate (~$495/mo @ $100k) — both real-but-power-limited, both needing a pre-registered, better-powered, vol-targeted follow-up with live cost/basis (and longer IV history) before any capital.
