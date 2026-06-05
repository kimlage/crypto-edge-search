# Edge-Search — Domain Campaign Results (2026-06)

*[Home](INDEX.md) · [Crypto](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](GLOSSARY.md) · [Polymarket](polymarket/README.md)*

> **Philosophy.** This is a public falsification lab. We do not look for a story that fits a backtest;
> we try to *break* every technique with the same anti-overfitting protocol, and we publish whatever
> survives **and** whatever dies. A clean backtest is a starting point, not evidence. The working
> hypothesis the data keeps confirming: for an individual at retail cost, speculation behaves far more
> like a game of chance than a consistent way to make money.

This document records one large, parallelized campaign that pushed **~58 hypotheses** across **eight
domains** through the committed gauntlet at **$0 data cost** (free public APIs + on-disk reuse). It was
run as a fan-out of domain workflows, each genuinely trying to *find* edge (not to manufacture kills),
then judging honestly. Every per-domain synthesis lives next to its scripts under
`output/edgehunt-*/SUMMARY.md`; this file is the cross-domain roll-up.

---

## TL;DR

- **0 clean SURVIVE.**
- **4 PROMISING leads**, all beta-neutral or structural, all held back from SURVIVE by the *same*
  honest-N multiple-testing penalty (curable only by genuine pre-registration) and/or a
  generalization/decay caveat.
- **~50 decisive KILLs**, almost all collapsing to **three recurring failure modes**:
  1. **Coincident / timed long-beta in disguise** — a descriptive pattern that is just long-BTC (or
     long-SPX risk-on) exposure on a secularly rising asset; loses to buy-and-hold after deflation.
  2. **The h=0 tautology** — order-flow "signals" whose entire Sharpe lives in the contemporaneous
     bar (the trades *are* the move); the strictly-lagged (h≥1) component is ~0.
  3. **Selection inflation under honest N** — a pretty grid-best that evaporates once the Deflated
     Sharpe / Harvey-Liu haircut counts every config tried, and/or sign-flips on the consume-once
     holdout.

### The four leads

| Lead | Family | Monthly @ $100k | Passes | Held back by |
|---|---|---:|---|---|
| **Exchange reserve-depletion** (BTC netflow) | on-chain flow | **~$1,858** (BTC fwd) | **Deflated Sharpe @ N=1 on the forward holdout** (0.988), price-orthogonal, surrogate p=0.020 | Does **not** generalize — inverts on ETH (−0.85); free flow data exists only for BTC+ETH |
| **XS Donchian channel-position long-short** | cross-sectional breakout | **~$4,116** (canonical) | Beta-neutral (β≈0, α t=3.56), cross-sectional-shuffle null p=0.002, Harvey-Liu adjP=0.0099, DSR@N=1 ≈0.999 | DSR @ honest N=72 (search penalty), material OOS decay, survivorship-biased panel |
| **Dated-futures basis carry** (BTC+ETH) | structural carry | **~$640** | 7/8 gates; term-structure alpha beyond perp funding (t=3.25); survives the low-funding regime (Sharpe 2.87) | Regime-dependent (thin in 2023); the one failing gate (cross-sectional shuffle) is expected for pure directional carry |
| **VRP harvest + crash-gate** (BTC/ETH options) | variance risk premium | **~$495** | Premium is real (IV²−RV² ≈ +0.065, positive 76% of weeks); the "don't sell into the crash" gate cuts max-DD −26%→−11% (Calmar 0.29→0.87) | Fails DSR (0.53) and the shuffled-VRP placebo (p=0.14) at the achievable N |

**None is investable today.** The honest next step for all four is the same: **pre-register one config,
acquire the missing data (multi-asset exchange flow / survivorship-free universe / live basis & borrow /
longer-history implied vol), and validate strictly forward** — not more backtesting.

### Update — deepening + adversarial verification (2026-06-01)

Each lead was then carried into a pre-registered consume-once forward test **and** handed to an
adversarial skeptic instructed to default-to-refute. The skeptic *strengthened* the honest picture and
caught real errors in the leads' own first-pass numbers. **Final after verification: 0 SURVIVE, 3
PROMISING, 1 KILL — nothing deployable.** (`output/edgehunt-deepen/SUMMARY.md`.)

| Lead | Post-verify | Corrected monthly @ $100k | What the skeptic found |
|---|---|---:|---|
| **XS Donchian L/S** | PROMISING | **~$2,298** (was ~$4,116) | Structure is real (XS-shuffle p=0.009, positive every N∈[20,200] and every holdout quarter) but on the 388-row consume-once holdout the **magnitude is indistinguishable from zero** — DSR@N=1=0.79, Newey-West t(mean)=0.96, block-bootstrap CI-lower<0. (It also *corrected* the first pass: the cited beta-hedge gate 0.318 was an in-sample over-hedge artifact; honest-OOS hedge = 0.78.) Survivorship: a −90% delisting shock flips the holdout negative in 17% of draws. |
| **BTC reserve-depletion** | PROMISING (BTC-only) | **~$1,701** | The "pre-registered" config was actually the **argmax of a searched ~10-config neighborhood**, so it is *not* honestly N=1: deflated by N=10 the surrogate p goes 0.044 → ~0.36 and **fails**. The BTC paper-forward (Sharpe 1.19) is real, causal and leak-free, but blocked by honest-N + no cross-asset generalization (ETH forward −0.85). |
| **Dated-futures basis carry** | PROMISING (thin) | **~$475** (was ~$640/the levered $1,051) | **Financing leak:** the script charged the risk-free rate on 1 unit but borrow on the ~2.9×-levered notional; correcting it collapses the levered series to DSR 0.18 and roughly halves the economics. A *thin* real market-neutral excess survives **unlevered** (~4.9%/yr, t=2.41, DSR 0.60) but is sub-every-multiple-testing-bar and regime-fragile (sub-RF in 2023, −37% in the 2021 cohort). |
| **VRP harvest (gate-only)** | **KILL** (downgraded) | n/a | Re-tested as the crash-gate-only primary hypothesis, it is a **2021 DVOL-onset regime artifact**: leave-2021-out Sharpe 1.257 → 0.560, post-2021 DSR@N=1 only 0.842, and the favorable consume-once holdout was lucky split-placement on the 2nd-richest year. Dead. |

**Lesson reinforced:** a right-null surrogate pass (XS-shuffle p=0.009; reserve p=0.044 at N=1) establishes
that the *structure/sign* is non-random — it does **not** establish that the realized *mean is positive
with significance* at honest N on unseen data. That gap is exactly the PROMISING/SURVIVE boundary, and no
lead crossed it. The two structurally-real edges worth keeping warm are **reserve** (gated on paid
multi-asset flow + live paper-forward) and **donchian** (gated on a longer survivorship-clean panel);
dated-futures is a thin sub-RF carry once financing is honest; VRP is a confirmed kill.

### Update — independent two-layer methodology audit (2026-06-01)

Every batch (all 9) was then re-reviewed by an independent auditor **and** an audit-of-the-audit that
re-derived each disputed number from the committed primitives (`output/edgehunt-audit/SUMMARY.md`). **No
false-KILL was found anywhere** — the conservative "nothing deployable" stands and is *stronger* than
first reported. Two systematic defects were confirmed:

- **D5-08 reserve-depletion: PROMISING → KILL.** The harness ran the phase-randomization surrogate on
  only the single in-sample-selected grid-best config, with **no family-wise correction** (p=0.013).
  Under the **family-wise MAX-statistic surrogate** the methodology requires for a *searched* family, the
  surrogate gate **fails** (p≈0.24, real best 0.994 < surr95 ≈1.19). The deepening had caught the same
  neighborhood-argmax on the DSR economics but never propagated it to the surrogate gate, where it flips
  the label. The "pre-registered" config was the argmax of a ~12-config neighborhood, so honest N≠1.
  **Reserve is a KILL.**
- **Financing-leak is systemic (error class i).** Every short/levered book in the campaign charges zero
  borrow/financing on the levered or short notional. On KILLs it only deepens the kill; on the two carries
  it inflates the headline: **dated-futures** at the correct levered RF charge (avg 2.95×) collapses
  Sharpe 1.64→0.69, $1,062→$447/mo, DSR 0.58→0.13 (and fails the 0.95 gate at *any* RF ≥ 0.75%/yr); only a
  thin **unlevered** ~4.9%/yr excess survives. **Donchian's** OOS holdout erodes from 0.53 toward
  0/negative once borrow on the ~1.0× short notional is charged — report it as a range ~0.3–0.5.

Two doc-level (non-flipping) defects were also logged in D348: `residual_alpha_sharpe = sharpe(OLS
residuals)` is ~0 *by construction* (a tautological metric — the beta-hedged alpha is actually large
in-sample; the KILLs stand on the holdout collapse), and the 52-week-high KILL binds on the Harvey-Liu
haircut, not the cited DSR.

**Corrected tally for the audited set: 0 SURVIVE, 2 PROMISING (Donchian, dated-futures-unlevered-thin),
~51 KILL.** No edge is deployable.

---

## The four leads in detail

### 1. Exchange reserve-depletion / netflow trend (BTC) — the closest to a survivor

Mechanism: net exchange outflow → reduced sell-side liquidity → bullish drift. Signal = EMA-smoothed
native `FlowIn − FlowOut`, rolling-Z, **lagged ≥1 day**, long/flat.

- The grid-best (Sharpe 0.994) was correctly capped at PROMISING by Deflated Sharpe at honest N=54 — its
  strength lived in a *selected* config.
- The decisive follow-up **pre-registered one config from mechanism before inspecting returns**
  (`smooth=14, zwin=365, thr=1.0, lag=1, long/flat`), which collapses honest N→1. On the **consume-once
  forward tail (2023-08 → 2026-05)** the pre-registered config earns **net Sharpe 1.265, DSR@N=1 = 0.988
  (PASS), Harvey-Liu adjP 0.012, surrogate p 0.020, block-bootstrap mean CI strictly positive,
  ~$1,858/mo @ $100k** — *stronger* out-of-sample than in-sample.
- **Price-orthogonal:** orthogonalizing netflow-Z against trailing returns leaves the BTC edge
  unchanged-to-stronger and the surrogate still passes. This is real flow information, not a price echo.
- **The wall: no generalization.** Free Coin Metrics Community exposes 1d FlowIn/FlowOut for *exactly two
  assets* (BTC, ETH). The same config on **ETH inverts** (forward Sharpe −0.85, surrogate p 0.86); the
  pooled BTC+ETH test fails (DSR@N=1 0.667). Either BTC-specific market structure (exchange reserves are
  the single most-watched on-chain narrative, plausibly partly reflexive) or a lucky forward window —
  though pre-registration + DSR@N=1 are strong evidence against pure overfitting.
- **Caveat flagged honestly:** the literal `runGauntlet` at N=1 returns KILL on the `baselines` gate,
  because it scores only the in-sample window where a 14%-exposure long/flat overlay structurally can't
  out-Sharpe 100%-long buy-and-hold — an overlay-vs-B&H construction artifact; the holdout, DSR, haircut
  and full-span surrogate all pass.
- **Verdict: PROMISING (BTC-only).** Next: paid multi-asset exchange-flow data + live paper-forward.
- Artifacts: `scripts/edgehunt-D5/`, `scripts/edgehunt-D5-followup/`, `output/edgehunt-D5/SUMMARY.md`,
  `output/edgehunt-D5-followup/VERDICT.md`.

### 2. Cross-sectional Donchian channel-position long-short

Mechanism: rank a 30-coin panel by position within each coin's N-day high-low channel (breakout
strength); go long high-position, short low-position, dollar-neutral, continuous z-scored weights.

- **Genuinely beta-neutral** (betas on {BTC, equal-weight} = [−0.09, +0.08], alpha t = 3.4–3.6), so it is
  not timed beta; beats every baseline (B&H 0.38, EW-long ≈0, random dollar-neutral 95th ≈ −0.46);
  **passes the right null** (cross-sectional shuffle p=0.002, shuffled book ≈ −1.1 Sharpe);
  block-bootstrap CI lower>0; PBO=0.000; Harvey-Liu adjP=0.0099; per-config DSR@N=1 ≈ 0.999.
- **Held back by:** DSR at honest N=72 (the correct penalty for searching the grid), plus material OOS
  decay (full-history net ~1.4 but consume-once holdout only 0.30–0.79 net, a soft 0.07–0.47
  beta-hedged) — classic crowded cross-sectional-momentum decay. The 30-coin panel is survivorship-biased
  (LUNA/FTT absent), so even the holdout is an upper bound.
- **Money (canonical N=120 z-score HIGH, full-sample):** ~4.1%/mo gross-2x → **~$412/mo @ $10k,
  ~$4,116/mo @ $100k**; turnover 0.385; canonical holdout +0.79 (positive but soft). *Trade the
  canonical, not the grid-best (1.69) which DSR correctly haircuts.*
- **Verdict: PROMISING.** Next: pre-register the canonical config and run forward; rebuild the panel
  point-in-time / survivorship-free; track the **beta-hedged** holdout Sharpe live (dies if decay
  continues; graduates if it stabilizes above ~0.4 hedged).
- Artifacts: `scripts/edgehunt-requeue/donch_ls_*`, `output/edgehunt-requeue/SUMMARY.md`.

### 3. Dated-futures basis cash-and-carry (BTC+ETH)

Short the contango quarterly future + long spot, hold to convergence; harvest term-structure premium
*beyond* perp funding. Net raw Sharpe **2.27**, +7.7%/yr, **~$640/mo @ $100k**, positive every calendar
year. The edge beyond perp funding is established three ways: 82% basis↔funding correlation but a
**positive intercept** (~4.5%/yr residual); daily C3 alpha **+9.9%/yr, t=3.25** controlling for perp
carry; and a regime test — when perp funding is low (<5%/yr) dated carry still earns 6.7%/yr at **Sharpe
2.87**. 7/8 gates pass; the lone fail (cross-sectional shuffle p=0.66) is *expected* for a pure
directional carry with no expiry-selection alpha. Regime-dependent (only 1.5%/yr in 2023). Next:
vol-targeting, live basis + borrow/financing-cost data, stress the thin-contango regime.
Artifacts: `scripts/edgehunt/dated_futures_carry.ts`, `output/edgehunt/dated_futures_carry_report.json`.

### 4. VRP harvest + crash-gate (BTC/ETH options)

Sell variance with a DVOL-spike "don't sell into the crash" gate. The premium is unambiguously real (BTC
IV²−RV² ≈ +0.065 variance points, positive 76% of weekly windows). Net Sharpe **1.37** at a realistic
convex tail (~**$495/mo @ $100k**, 78% win rate, skew −1.26). The crash-gate is the genuine value driver
(max-DD −26%→−11%, Calmar 0.29→0.87, beats cash on Calmar). Not a SURVIVE: fails Deflated Sharpe (0.53)
and the shuffled-VRP placebo (p=0.14 — the z-*sizing* is indistinguishable from random) at the achievable
N (DVOL history only since 2021-03). Next: re-test the **gate-only variant as the primary hypothesis**
(drop the failed sizing), source longer-history implied vol, use true variance-swap replication.
Artifacts: `scripts/edgehunt/vrp-*.ts`, `output/edgehunt/vrp-FINAL.json`.

---

## KILL ledger by domain (teaching cases)

Each KILL is honest evidence and a documented teaching case. Binding gate and the decisive number are
given so any of them can be challenged or revived against the *same* gates.

### Consensus / carry-arb family (`output/edgehunt/SUMMARY.md`)
- **Cross-venue funding dispersion** — KILL. Wedge real but ~0.5 bps/8h, ~30× smaller than its 16 bps
  round-trip cost; loses to plain funding-level carry by −$296/mo. Surrogate p=0.002 (real), DSR 0.124.
- **Perp-spot cash-and-carry** — KILL. A short-crash option: skew −12.9, kurtosis 175, Nov-2024 month
  −18.9% from alt-season liquidations; best config under-earns T-bills (excess Sharpe −0.17). DSR 0.0023
  @ N=96.
- **TSMOM trend overlay on carry** — KILL. The "crash hedge" is just lower average leverage; mis-timed
  surrogate signals hedge equally well (calendar-reanchor p 0.33–0.36); incremental over matched leverage
  ≈ 0.
- **Residual / idiosyncratic momentum (Blitz-Huij-Martens)** — KILL but signal is *real* (surrogate
  p=0.0033, beta-neutral). Dies at Deflated Sharpe @ N=192 (0.18) — even zero-cost gross fails the
  deflation threshold. Binding constraint: the 30-coin cross-section, not the surrogate. Needs a
  60–100+ name universe.
- **PCA basket stat-arb (Avellaneda-Lee s-score)** — KILL. At proper breadth the **gross** residual-
  reversion Sharpe is *negative* (max −0.146/81 configs). Daily-frequency crypto residuals do not revert;
  the equity-style reversion lives intraday where costs dominate.
- **Vol-targeting (Moreira-Muir)** — KILL. Apparent lift flips negative OOS (−0.17), fails the
  GARCH-simulated zero-edge surrogate (p=0.386), PBO=0.95. Confirms the Cederburg-et-al. critique;
  forward-looking DVOL did *worse* than trailing realized vol.
- **Funding-sentiment contrarian fade** — KILL. Backwards: extreme funding *persists*, it does not
  revert (0/8 coins, placebo beats the real signal p=0.88). The mirror (funding *momentum*, drift-
  stripped) is real (+1.08, surrogate p=0.023) but fails DSR @ N=24 (0.44).

### D1 — indicators & price action (`output/edgehunt-D1/SUMMARY.md`, `output/edgehunt-requeue/SUMMARY.md`)
- **Supertrend, CCI** — KILL. 1.6–1.8 net Sharpe but the vol/spectrum-preserving surrogate scores
  *above* the live strategy (CCI surrogate mean 2.3–2.4 > 1.768, p=1.0); neither out-Sharpes its own
  buy-and-hold after deflation. Long-flat trend/oscillator overlay on a rising asset = guaranteed
  long-beta artifact.
- **XS Ichimoku long-short** — KILL. In-sample tilt beats the right null (p=0.001) but it is *decayed
  cross-sectional momentum*: yearly Sharpe 2.65→…→−2.55 (2026); fails DSR/haircut @ N=48; pre-registered
  Hosoda 9/26/52 mechanism is −0.72 OOS.
- **XS Bollinger %b reversion** — KILL. The literal reversion claim is wrong-signed in *every* calendar
  year (these majors trend daily, not revert); the only profitable rescue is the opposite-sign factor,
  which dies on the holdout (−0.38).
- **Candlestick reversal patterns** — KILL. Best grid 0.92 but textbook canonical −0.50; DSR + PBO 0.50
  + holdout −0.66. Pattern-label placebo not beaten.

### D2 — volume & microstructure (`output/edgehunt-D2/SUMMARY.md`) — all 8 KILL
The whole **free-tier order-flow belief set is dead at h≥1.** Any Sharpe lives in the **h=0 contemporaneous
/ look-ahead** version (Hasbrouck/Easley tautology — the trades *are* the move). CVD divergence (lagged IC
≈0), taker buy/sell ratio (lagged edge = 5% of the h=0 ceiling), anchored-VWAP reversion (breakeven 1.46
bps < 4 bps taker; session-anchor worse than rolling — crypto has no close auction), volume-profile POC
(wrong-signed), OBV (zero over the identical price-trend overlay), Amihud illiquidity (74% of P&L from 20
of 1971 days, a 2021-only premium), whale-print momentum (prints mean-revert), liquidation-cascade fade
(events too rare). **DEFERRED, not killed:** the L2 family (VPIN, Kyle's λ, microprice, book imbalance)
needs paid point-in-time order-book history — but the free belief each was meant to proxy is dead.

### D5 — on-chain / crypto-native (`output/edgehunt-D5/SUMMARY.md`) — 1 PROMISING (see lead #1), 7 KILL
- **Hash Ribbons** — KILL. Highest raw Sharpe (1.13) and passes 7/8 gates, killed only by the hash-only
  surrogate: the edge is the price-confirmation clause (long beta); incremental hash edge **−0.084**.
- **MVRV-Z** — KILL. Strengthened variant is byte-identical to B&H OOS; all timing days sit in the
  2015–17 in-sample window (non-causal artifact).
- **Stock-to-Flow** — KILL. The residual is a price clock (corr 0.78 with price-vs-time, 0.75 with 365d
  momentum) → Granger-Newbold spurious regression; causal IC decays to 0.012 post-2021.
- **SSR** — KILL. Holdout inverts (−0.239); lead-lag shows mints *lag* price (reverse-causality echo).
- **Puell Multiple** — KILL. 93% the Mayer price/365d-MA oscillator (R²=0.87).
- **Realized-price cost-basis S/R** — KILL. A fixed line whose phase-randomized surrogate scores *higher*
  (p=0.841) — same illusion as a random horizontal line.
- **Metcalfe active-address residual** — KILL. Mean-reverting noise (0/162 configs cleared surrogate AND
  held OOS).

### D6 — sentiment & cross-asset / macro (`output/edgehunt-D6/SUMMARY.md`, re-queue) — all KILL
All collapse to the **coincident-beta trap**: raw predictive corr ≈ 0 (news-tone corr 0.00, hit-rate
0.516 = coin-flip), an AR-matched placebo of the same shape times BTC *as well or better*, the edge is
SPX/risk-on beta, and it inverts out-of-regime on the holdout. Rates + 2s10s timer (holdout −1.65),
real-yield "digital gold" (β 0.443, OOS −0.77), GDELT news-tone, **Fear & Greed contrarian** (0.38 < B&H
0.59, surrogate p 0.992), **Google Trends** (holdout inverts −0.25), **global net-liquidity / M2** (net
Sharpe 1.31 but residual alpha exactly **0.000** — pure beta), **options put/call** (selection-inflated
1.57 → 0.89 honest, placebo 0.29).

### D7 — calendar & event (`output/edgehunt-D7/SUMMARY.md`, re-queue) — all KILL
- **Four-year halving cycle** — KILL. Honest N is hard-capped at **2 genuine in-sample post-halving
  years** (2020, 2024); no free PIT-clean pre-2017 data. DSR cannot mathematically clear 0.95 at N=2.
  Structurally unfalsifiable-in-favor.
- **Stablecoin mint-as-event** — KILL. Best of a 128-cell grid on 16–50 events; the honest family-wise
  MAX-statistic placebo gives p=0.31 (the per-cell p=0.007 is the data-mining trap). Mechanism is
  coincident demand (issuers mint *after* inflows).
- **Funding-settlement timing** — KILL. Every overlay cell loses standalone; injecting directional
  variance into a near-deterministic delta-neutral funding stream can only lower it.
- **Sell-in-May / month seasonality** — KILL (calendar-reanchor p=1.000). **Day-of-week** — KILL (~0
  drift-removed; tail-driven by shared crash Wednesdays). **Turn-of-month** — KILL (holdout sign-flips
  −0.93). **CME weekend-gap fill** — KILL (canonical −0.26). TOM/CME are equity-flow effects crypto
  structurally lacks.

### D3/D4/D8 remainder (`output/edgehunt-D348/SUMMARY.json`) — all KILL, 1 DEFERRED
Funding dispersion, **dual momentum** (timed beta, holdout 0.03), **pairs (GGR)** (random pairing
reproduces it, p=0.50), short-term reversal (negative even gross), **GARCH/EGARCH vol-timing** (loses to
B&H at matched exposure; GARCH surrogate p=0.575 — a sibling of Moreira-Muir), **frog-in-the-pan /
information discreteness** (zero incremental over plain momentum; the apparent edge is *more* timed BTC
beta, β=1.26, that reverses OOS), squeeze/vol-breakout, risk-parity, rebalancing premium, ensemble
stacking. **DEFERRED:** dealer GEX / gamma walls and option skew per-strike greeks — need paid
point-in-time options chains.

---

## New $0 backlog batches (post-campaign)

Two further $0 batches were run after the main campaign, same gauntlet and traps.

### Quant / regime / vol / momentum (`output/edgehunt-quant/SUMMARY.md`) — 10 KILL, 1 provisional PROMISING (later flipped to KILL — see audit below)
HMM and BOCPD regime timers, acceleration momentum, weekly residual reversal, time-of-day, DVOL
term-structure vol-carry, vol-regime conditioning, efficiency-ratio/ADX gate, carry+momentum combo — all
KILL on the documented mechanisms (de-risking masquerading as timing, exposed by the matched-exposure
control; detection latency; no separable premium over an already-killed parent; search inflation vs honest
N). The one PROMISING is **Q9 — cross-sectional low-volatility anomaly** (beta-neutral L/S, β-neutralization
doubles Sharpe to 0.78, every config positive, XS-shuffle p=0.002, consume-once holdout +2.08, ~$2,615/mo
upper bound) — but it fails Deflated Sharpe @ honest N=96 (the pre-registered canonical is only 0.70) and
the panel is survivorship-biased. Same profile as Donchian.

### On-chain (free Coin Metrics) + price-action (`output/edgehunt-onchain2/SUMMARY.md`) — 7 KILL, 1 provisional PROMISING (later flipped to KILL — see audit below)
Network-activity momentum, realized-cap/MVRV, stablecoin-supply flow, and four price-transform overlays
(Heikin-Ashi, Williams fractals, Mayer Multiple, Renko) — all KILL; the overlays reduce to a lagged
moving-average / long-beta tilt (reproduced by the surrogate-recompute null), and the "adoption" series are
repackaged price momentum (reverse causality). The one PROMISING is **O3 — fee-revenue NVT signal** (BTC,
causal contrarian, net Sharpe 1.33, ~$6,304/mo, 10/10 years positive, phase-rand p=0.005, holdout +0.59) —
but SURVIVE depends on a researcher-chosen a-priori N-restriction (only PROMISING at the broad honest
N=312), the pre-registered canonical is weak (0.74), there is no ETH confirmation, and it is a *free proxy*
for the paid canonical NVT (`NVTAdj90`, DEFERRED).

**Both Q9 and O3 were then KILLED** by the same two-layer family-wise audit that flipped reserve
(`output/edgehunt-audit-nb/SUMMARY.md`): both rested on a single-best-config surrogate p masking a *searched*
grid (Q9 harness p=0.002, O3 p=0.005), and under the correct family-wise MAX-statistic null over the
actually-searched grid both fail (O3 p=0.093 @ N=312; Q9 ~0.06, borderline) — while both independently fail
honest-N Deflated Sharpe at the full grid (Q9 DSR 0.476 @ N=96; O3 DSR 0.894 @ N=312, the N=54 pass was a
post-hoc carve-out). Same failure mode as reserve. (The audit-of-audit also caught and corrected its own
first-pass error on Q9 — an inflated independent-per-config null gave 0.397; the precedent-faithful coherent
null gives ~0.06 — the two-layer audit self-correcting.) **Final corrected program tally: 0 SURVIVE, 2
PROMISING (XS Donchian, dated-futures-unlevered-thin — both weak and caveated), everything else KILL.**

## Methodology notes reinforced this campaign

- **The right null per claim is non-negotiable.** Time-series claims → phase-randomization / block
  bootstrap; rotation/relative-value → cross-sectional shuffle; path-dependent exits → bracket-on-
  surrogate; variance-risk-premium → shuffled-VRP placebo; vol-clustering strategies → GARCH-simulated
  zero-edge surrogate; calendar/event → calendar-reanchor + family-wise MAX-statistic; macro/sentiment →
  AR(1)-matched placebo of the same persistence. Using the wrong null either over-kills (a directional
  carry "fails" a cross-sectional shuffle that has no power) or under-kills (a per-cell calendar placebo
  passes a data-mined grid).
- **Pre-registration is the only honest way to collapse N→1.** The reserve lead and the Donchian lead
  *both* fail Deflated Sharpe only because of grid search. A single, mechanism-justified, pre-committed
  config sidesteps the penalty — *if* the pre-registered (not grid-best) config holds forward. The
  reserve follow-up demonstrated this concretely (DSR@N=1 = 0.988 forward).
- **"Beats buy-and-hold after deflation," not "positive standalone."** Every long-flat overlay on a
  rising asset posts a 1.6–1.8 Sharpe and a real-looking monthly $; the bar is incremental over its own
  B&H (excess CI entirely > 0) and over the already-killed sibling indicator.
- **The h=0 vs h≥1 blade** kills the entire free-tier order-flow domain: report the contemporaneous
  ceiling, then require the strictly-lagged component to clear the gates *alone*.
- **Operational lesson (honesty about coverage):** running 7 heavy domain workflows simultaneously
  saturated the API rate limit — D1 and D7 each lost ~8–9 of 11 dispatches to throttling (these returned
  server errors, **not** verdicts, and were re-queued at low concurrency, never counted as KILLs). Silent
  truncation would have read as "covered everything" when it had not. Fan-out width must be matched to
  the rate budget.

---

## References (selected, by theme)

- **Multiple-testing / deflation:** Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014); *The
  Probability of Backtest Overfitting* (CSCV/PBO); López de Prado, *Advances in Financial Machine
  Learning* (CPCV). Harvey, Liu & Zhu, *…and the Cross-Section of Expected Returns* (2016); Harvey & Liu,
  *Backtesting* / haircut Sharpe ratios.
- **Fair-game / path vs expectancy:** optional-stopping / fair-game theorem — stops & take-profits
  reshape variance and win-rate, not expectancy.
- **Carry / limits to arbitrage:** BIS Working Paper 1087 on crypto basis and limits to arbitrage;
  perp-funding and dated-futures term-structure literature.
- **Volatility management:** Moreira & Muir, *Volatility-Managed Portfolios* (2017); Cederburg et al.
  critique on OOS fragility.
- **Cross-sectional / residual momentum:** Blitz, Huij & Martens, *Residual Momentum*; Da, Gurun &
  Warachka, *Frog in the Pan* (information discreteness).
- **Statistical arbitrage / pairs:** Avellaneda & Lee, *Statistical Arbitrage in the US Equities Market*
  (2010); Gatev, Goetzmann & Rouwenhorst, *Pairs Trading* (GGR).
- **Microstructure / order flow:** Easley, López de Prado & O'Hara, *VPIN*; Kyle, *Continuous Auctions
  and Insider Trading* (λ / price impact); Hasbrouck, information shares.
- **On-chain valuation (mostly debunked here):** PlanB Stock-to-Flow (spurious price clock);
  MVRV/SOPR/NVT/Puell/SSR practitioner literature; Granger & Newbold on spurious regression.

Full per-hypothesis references are in `docs/BACKLOG.md` (155 hypotheses across 8 domains) and the
per-domain `output/edgehunt-*/SUMMARY.md` files.

---

## Reproducibility

All work ran at **$0** on free public data (Binance/Bybit/OKX public REST, Coin Metrics Community no-key,
Deribit public DVOL, FRED no-key CSV, alternative.me Fear & Greed, Google Trends, GDELT). Inputs were
reused from on-disk caches under `output/{funding,carry,crossxs,dated-futures,bigquery/btc_ohlcv_15m.ndjson,
onchain-poc,nf1,edgehunt-*}/`. Every test imports the committed primitives in
`src/lib/training/statistical-validation.ts` (`computeDeflatedSharpeRatio`, `estimateCscvPbo`,
`blockBootstrapConfidenceInterval`, `summarizeReturnSeries`) plus `src/lib/training/significance/*`; the
per-domain `runGauntlet` wrappers (e.g. `scripts/edgehunt-D5/harness.ts`) chain them with the
claim-appropriate null. Realistic cost (taker ~4 bps/side) is charged on every position change, honest N
counts every config tried, and each consume-once holdout is spent exactly once.

> **Bottom line.** Of ~58 hypotheses spanning the full retail/quant arsenal, **none cleared the full
> gauntlet on data it had never seen.** Four leads are worth a deeper, better-powered, pre-registered,
> live-forward follow-up — two beta-neutral signals (BTC exchange-flow, cross-sectional breakout) and two
> structural premia (dated-futures basis, variance risk premium). Everything else is a documented KILL.
> No capital is deployed.
