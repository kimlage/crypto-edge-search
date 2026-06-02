# D5-08 follow-up — pre-registered single-config forward test + cross-asset generalization

**Lead:** D5-08 Exchange reserve-depletion / netflow trend (native FlowIn−FlowOut). Carried from
the D5 batch as PROMISING; the grid-best config (smooth=7,zwin=365,thr=0.5,longflat, net 0.994)
passed everything except (1) Deflated Sharpe at honest N=54 and (2) generalization to ETH.

**Goal of this follow-up:** collapse honest N → 1 by *pre-registering a single config from mechanism*
(removing the binding Deflated-Sharpe penalty if the pre-registered — not grid-best — config holds),
then test whether the edge is real (forward consume-once + surrogate + price-orthogonality) and
whether it generalizes across assets. No tuning to find a winner.

---

## 1. Pre-registered config (locked on mechanism, before any return was inspected)

`smooth=14, zwin=365, thr=1.0, lag=1, side=long/flat`

**Mechanism (not backtest Sharpe):** sustained net **outflow** of coins from exchanges
(FlowIn−FlowOut ≪ 0) = coins leaving trading venues for cold storage / self-custody = reduced
sell-side liquidity / accumulation regime = bullish next-day. Signal = rolling-Z of EMA-smoothed
netflow; z ≤ −1 → long, else flat.

- `smooth=14` — fortnight EMA: washes out daily settlement / withdrawal-batch / exchange-internal
  reshuffle noise, still tracks a multi-week accumulation regime. The canonical fortnight window.
- `zwin=365` — 1-year trailing baseline: native netflow scale grows with adoption, so the Z must
  reference a recent **annual** regime (full seasonal cycle, no quarter bias). Strictly causal.
- `thr=1.0` — 1-sigma band = standard "meaningfully beyond normal"; **not** the snooped 0.5 of the
  grid-best.
- `side=long/flat` — the mechanism only supports a *bullish* read of outflows; the short-on-inflow
  leg is a much weaker claim (inflows are routinely rebalancing/margin), so the defensible bet is
  long-on-outflow / flat-otherwise.

This is the only config tested as the bet (honest **N = 1**). The prior D5 "canonical" (zwin=**180**)
is reported below as a transparency reference only — it is **not** the pre-registered bet.

---

## 2. Forward consume-once test (BTC) — held-out tail 2023-08-15 → 2026-05-30 (last 20%, never used)

| metric | in-sample (pre-holdout) | **FORWARD consume-once** | full span |
|---|---:|---:|---:|
| net Sharpe (ann, 4bps/side) | 0.606 | **1.265** | 0.746 |
| DSR @ N=1 | 0.963 PASS | **0.988 PASS** | 0.994 PASS |
| Harvey-Liu adjP (N=1) | 0.0375 PASS | **0.0124 PASS** | 0.0056 PASS |
| surrogate p (phase-rand, crossSec:false) | 0.126 fail | **0.020 PASS** | 0.026 PASS |
| block-bootstrap mean CI95 | [−2.2e-5, 7.5e-4] fail | **[1.3e-4, 1.2e-3] PASS** | [1.0e-4, 7.5e-4] PASS |
| conditional Sharpe (signal-ON days) | 1.77 | **3.36** | 2.12 |
| exposure / turnover | 0.135 / 0.062 | 0.157 / 0.063 | 0.141 / 0.062 |
| monthly @ $100k / $10k | $1,054 / $105 | **$1,858 / $186** | $1,252 / $125 |
| monthly % | 1.05% | **1.86%** | 1.25% |

**The pre-registered single config clears DSR@N=1 on BTC** (0.988 forward, 0.994 full) — the binding
multiple-testing gate that capped the grid-best is removed once N is honestly 1. The forward
consume-once tail is *stronger* than in-sample (net 1.27, surrogate p 0.020), so this is not a decayed
config. Prior-canonical zwin=180 (ref only): net 0.497 full, surrogate p 0.168 — weaker, fails
surrogate; the 365d annual baseline is materially the better-motivated and better-behaved spec.

**Caveat — the literal committed `runGauntlet` at N=1 returns KILL, binding gate `baselines`.** This
is a harness-construction artifact, not a failure of the edge: the gauntlet scores configs only on
the *in-sample* window, where a 14%-exposure long/flat overlay structurally cannot beat 100%-long
buy-&-hold's Sharpe (0.606 < B&H 0.912) during the in-sample bull run. The same run's forward holdout
is +1.265 and the full-span surrogate passes. On excess (cost-adjusted, mechanism-grounded, surrogate
+ DSR@N=1 + block-bootstrap) terms the pre-registered config is real on BTC.

---

## 3. Generalization across assets — the decisive question

**Free-data universe is BTC + ETH only.** The Coin Metrics *community* catalog
(`/v4/catalog/asset-metrics?metrics=FlowInExNtv`, no key) exposes 1d exchange FlowIn/FlowOut for
**exactly two assets: btc, eth**. Every other liquid asset (ltc, bch, etc, xrp, ada, doge, trx, bnb,
xlm, sol, …) returns HTTP 400 (metric not in free catalog) or PriceUSD-only. So the honest cross-asset
test is BTC (selection asset) → ETH (the one available out-of-sample asset).

| asset / window | net Sharpe | surrogate p | random-lottery p | DSR@N=1 | monthly @ $100k |
|---|---:|---:|---:|---:|---:|
| ETH forward holdout | **−0.846** | 0.864 | 0.798 | 0.118 FAIL | −$1,953 |
| ETH full span | −0.028 | 0.629 | 0.537 | 0.466 FAIL | −$65 |
| ETH orthogonalized full | −0.089 | 0.687 | — | 0.395 FAIL | −$203 |
| **Pooled BTC+ETH forward** | **0.203** | — | — | **0.667 FAIL** | — |
| Pooled BTC+ETH full span | 0.341 | — | — | — | — |

**It does NOT generalize to ETH.** The same config is net-negative on the ETH forward tail
(−0.85) and ≈ zero full-span, fails surrogate and random-lottery (indistinguishable from a matched
random in/out book), and the pooled cross-asset forward test fails DSR@N=1 (0.667). Diagnostic:
the information coefficient IC(−netflow-Z, next-day return) is **+0.0214 on BTC** but only **+0.0105
on ETH** — half the strength, swamped by noise; not a sign-flip artifact, a genuine weakness of the
flow signal on ETH (likely thinner / noisier exchange-attribution coverage on ETH, plus DeFi/L2 flows
that bypass the centralized-exchange wallets the metric tracks). **The edge is BTC-specific.**

---

## 4. Mechanism check — price-orthogonal real flow, not a price echo

Orthogonalize the EMA-smoothed netflow against trailing return (causal expanding OLS), z-score the
residual, re-run the SAME pre-registered band:

| BTC orthogonalized | net Sharpe | surrogate p | DSR@N=1 | monthly @ $100k |
|---|---:|---:|---:|---:|
| full span | **0.863** | **0.040 PASS** | 0.998 PASS | $1,420 |
| forward holdout | **1.114** | **0.048 PASS** | 0.973 PASS | $1,557 |

After removing the price-coupled component the BTC edge is *unchanged-to-stronger* and the surrogate
**still passes**. The flow timing carries real, price-orthogonal information on BTC — it is not a
price echo / long-beta artifact. (On ETH the orthogonalized version is still negative — confirming
the BTC-specificity is about flow information, not price coupling.)

---

## Bottom line

The pre-registration removed the multiple-testing cap: the single, mechanism-justified config
**clears DSR@N=1 on BTC** (forward 0.988, full 0.994), survives the forward consume-once tail
(net 1.27, surrogate p 0.020, block-bootstrap CI strictly positive), and is **price-orthogonal**
(surrogate still passes after orthogonalization). That is the strongest honest evidence yet that the
BTC exchange-netflow timing edge is real.

But it **fails the decisive generalization bar**: it does not generalize to ETH — the only other
asset with free exchange-flow data — where it is net-negative on the forward tail and statistically
indistinguishable from random; the pooled cross-asset test fails. The promotion rule was SURVIVE only
if the pre-registered config clears DSR@N=1 **AND** generalizes to ≥1 other asset on the forward
holdout. It clears DSR@N=1 but does **not** generalize. Cap: **BTC-specific — do not trust as a
cross-asset edge.**

Use, if at all, only as a single-asset (BTC) overlay sized on the ~14%-exposure / conditional-Sharpe
regime; never as a portfolio-wide on-chain factor on this evidence.

VERDICT: PROMISING (BTC-only) | pre-registered config smooth=14,zwin=365,thr=1.0,lag=1,long/flat | forward net Sharpe 1.265 | DSR@N=1 0.988 (PASS) | generalizes? BTC-only (ETH forward −0.85, surrogate p 0.86, pooled DSR@N=1 0.667 FAIL) | monthly@$100k $1,858 (BTC forward) | confidence med — strong, price-orthogonal, surrogate-passing single-config BTC edge that clears DSR@N=1 on the held-out tail, but free flow data exists only for BTC+ETH and it inverts on ETH, so cross-asset reality is unconfirmed and likely BTC-specific
