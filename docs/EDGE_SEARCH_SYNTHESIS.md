# Edge Search — Findings & Synthesis

*[Home](INDEX.md) · [Crypto](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](GLOSSARY.md) · [Polymarket](polymarket/README.md)*

> **2026-06-09 update — XS Donchian downgraded PROMISING → KILL; tally now 0 SURVIVE / 1 PROMISING.**
> The cross-sectional Donchian L/S lead was rebuilt on a delisted-inclusive point-in-time panel
> (the honest 161-ever-member universe vs the 30-name survivor panel that scored it) and shown to
> be **substantially survivorship**: family-wise cross-sectional-shuffle **p 0.002 → 0.103**,
> beta-neutral alpha **t 3.22 → 1.60** (BTC beta → +0.36), binds on **DSR 0.451 @ N=72**. The
> **dated-futures basis carry (unlevered-thin)** is now the **sole** PROMISING. See
> `scripts/edgehunt-donchian-pit/RESULTS.md` and `docs/CHANGELOG_RESEARCH.md`.

> **Purpose.** This is the canonical map of what the edge search actually learned, so a future
> reader does not re-walk dead ground. It is the honest, public "Findings & Synthesis" page for
> the whole program: a $0, reproducible falsification lab that pushed **~111 crypto
> trading-strategy hypotheses across 8 domains** through one committed anti-overfitting gauntlet
> on free public data — and publishes whatever survives **and** whatever dies. The working
> hypothesis the data keeps confirming: for an individual at retail cost, speculation behaves far
> more like a game of chance than a consistent way to make money.
>
> **The audited verdict: 0 clean SURVIVE, 1 weak PROMISING, everything else KILL. Nothing is
> deployable.** The durable deliverable is the methodology and the body of negative evidence.
>
> **Where this sits in the documentation set** (start at the index, [`README.md`](README.md)):
> - **[`RESULTS.md`](RESULTS.md)** — the per-hypothesis result tables and the headline tally.
> - **[`METHODOLOGY.md`](METHODOLOGY.md)** — the gates, controls, and the discipline that did the killing.
> - **[`REFERENCES.md`](REFERENCES.md)** — the academic bibliography (each gate and each hypothesis → its source).
> - **[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)** — how to re-run every number from a clean clone.
> - **[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md)** — the reusable `validateStrategy(...)` wrapper that packages the gates.
> - **`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`** — the per-domain roll-up of the 2026-06 campaign (the 58-hypothesis fan-out, the audit, and the deepening).
> - This page is the **narrative** that ties them together: *where the edge is NOT, and why*.
>
> **License: MIT (see [`../LICENSE`](../LICENSE)).**

---

## 0. TL;DR (the honest verdict)

- **~111 distinct hypotheses tested** at full rigor on real public data, all at **$0 cloud spend**:
  ~35 prior rounds + 58 from the 2026-06 parallelized domain campaign + 18 from a follow-on $0
  backlog — every one through the same committed gauntlet.
- **0 clean SURVIVE.** Nothing cleared the full gauntlet on data it had never seen.
- **1 weak PROMISING**, held back at the honest-N magnitude-significance boundary on unseen data
  and carrying a financing caveat:
  1. **Dated-futures basis carry, UNLEVERED-thin only** — a thin market-neutral excess of
     **~4.9%/yr (t=2.41)**, sub-every-multiple-testing bar. *The levered headline was a
     financing-leak artifact.*
- **XS Donchian channel-position long-short was downgraded PROMISING → KILL on 2026-06-09.** It
  looked real on the 30-name survivor panel (cross-sectional-shuffle null p=0.009), but rebuilt on
  the delisted-inclusive point-in-time universe (161 ever-members) it was **substantially
  survivorship**: the family-wise shuffle p moved 0.002 → 0.103 and beta-neutral alpha t 3.22 →
  1.60 (BTC beta → +0.36); the library gauntlet binds on DSR 0.451 @ N=72.
- **Everything else is a documented KILL** — every prediction / TA / relative-value / rotation /
  event-flow / on-chain-flow / sentiment-macro / calendar idea, fixed, adaptive, and
  genetically-evolved.
- **A two-layer independent audit flipped three earlier PROMISINGs to KILL** — BTC exchange
  reserve-depletion, the Q9 cross-sectional low-vol anomaly, and the O3 fee-revenue NVT signal —
  all on the **same defect** (a single-best-config surrogate p masking a *searched* grid), plus a
  systemic financing leak. No false-KILL was found anywhere.
- **The one durable asset of this project is the methodology** — the committed gauntlet + the body
  of negative evidence. The two prior carry "survivors" (perp funding carry, dated-futures basis)
  remain **sub-risk-free regime trades**, not a business.

---

## 1. The audited tally

| Bucket | Count | Status |
|---|---:|---|
| Total hypotheses tested across 8 domains | **~111** | all $0, all through the committed gauntlet |
| Clean **SURVIVE** | **0** | nothing deployable |
| Weak **PROMISING** | **1** | dated-futures basis (unlevered-thin) — XS Donchian fell to KILL 2026-06-09 (survivorship) |
| **KILL** | the rest | documented teaching cases |
| Earlier PROMISINGs **flipped to KILL** | **4** | reserve-depletion, Q9 low-vol, O3 NVT (audit) + XS Donchian (survivorship, 2026-06-09) |

**Provenance of the ~111:** ~35 from the prior chronological rounds (predictive TA, cross-section,
trend, carry, rotation, event-flow, the retired genetic-programming alpha engine), **58 from the
2026-06 domain campaign** (`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`), and **18 from a follow-on $0 backlog**
(the `edgehunt-quant` and `edgehunt-onchain2` batches). Per-domain machine-readable detail lives
under `output/edgehunt-*/SUMMARY.md`; the audits are `output/edgehunt-audit/SUMMARY.md` and
`output/edgehunt-audit-nb/SUMMARY.md`; the deepening is `output/edgehunt-deepen/SUMMARY.md`.

### The sole weak PROMISING lead — plus the downgraded Donchian

| Lead | Family | Passes (the right null) | Held back by |
|---|---|---|---|
| **Dated-futures basis carry** (unlevered-thin) | structural carry | A real market-neutral excess **survives unlevered** (~4.9%/yr, t=2.41, DSR 0.60); term-structure premium beyond perp funding | **Sub-every-multiple-testing bar**; regime-fragile (sub-RF in 2023, −37% in the 2021 cohort); the **levered** headline was a financing leak (DSR collapses to ~0.13) |
| **XS Donchian channel-position L/S** *(downgraded 2026-06-09 → KILL)* | cross-sectional breakout | Looked beta-neutral on the survivor panel, cross-sectional-shuffle null p=0.009 | **Substantially survivorship.** On the honest 161-ever-member point-in-time panel the family-wise shuffle p moved **0.002 → 0.103** and alpha **t 3.22 → 1.60** (BTC beta → +0.36); binds on **DSR 0.451 @N=72**. Now **KILL** (`scripts/edgehunt-donchian-pit/RESULTS.md`) |

### The three audit flips (PROMISING → KILL) — all the same defect

| Lead | Family | Was | Now | Why it flipped |
|---|---|---|---|---|
| **BTC exchange reserve-depletion** (netflow) | on-chain flow | PROMISING | **KILL** | The "pre-registered" config was the **argmax of a ~12-config searched neighborhood**, so honest N≠1. Under the **family-wise MAX-statistic surrogate** the standard requires for a searched grid, the surrogate gate **fails** (p≈0.24, real best 0.994 < surr95 ≈1.19; the harness's 0.013 was single-config, no FWER). Also inverts on ETH (forward −0.85). |
| **Q9 — cross-sectional low-vol anomaly** | cross-sectional | PROMISING | **KILL** | Single-best-config surrogate p=0.002 masked a searched 96-config grid; honest-N Deflated Sharpe **fails at the full grid (0.476 @ N=96)**, Harvey-Liu adjP 0.673. The family-wise null is borderline (~0.06); DSR is the robust killer. |
| **O3 — fee-revenue NVT signal** (BTC) | on-chain valuation | PROMISING | **KILL** | Single-best-config surrogate p=0.005 masked a searched 312-config grid; under the family-wise MAX-statistic null the surrogate **fails (p=0.093 @ N=312)** and honest-N DSR **fails (0.894 @ N=312)** — the N=54 pass was a post-hoc carve-out riding an argmax. No ETH confirmation. |

**The defect is one defect, three times:** a surrogate p computed on the *single in-sample-selected
grid-best* config, with **no family-wise correction**, reads as a PASS — but the correct null for a
*searched* family is the **family-wise MAX-statistic** over the actually-searched grid, and each lead
independently **fails honest-N Deflated Sharpe at the full grid size**. The audit-of-audit re-derived
every disputed number from the committed primitives and found **no false-KILL** anywhere; the
conservative "nothing deployable" call is *stronger* after audit, not weaker.

---

## 2. WHERE the edge is NOT

Twenty-plus families, all the standard academic priors plus the genuinely new (on-chain) data
classes, were each given an honest attempt to *find* edge — and each died net of realistic cost on
data it had never seen. The edge is **NOT** in:

1. **Direction prediction** on any single pair or timeframe (BTC trend, TSMOM, vol-targeting,
   seasonality, regime timers).
2. **Classic or microstructure technical analysis** — RSI/MACD/Bollinger/Donchian/Supertrend/CCI
   overlays, candlestick patterns, and the entire free-tier order-flow belief set (CVD, taker
   ratio, VWAP reversion, volume-profile, OBV, Amihud, whale prints, liquidation fades).
3. **Cross-section / relative value at retail cost** — momentum, reversal, residual momentum,
   cointegration / PCA stat-arb, small-cap/illiquid corners — the universe is too narrow and
   survivorship-biased, and the deflation penalty is fatal.
4. **Timing the carry** — even a perfect-foresight oracle extracts only ~0.5%/yr in the current
   regime.
5. **Adaptively re-fitting** any of the above (drift is real but not predictively trackable).
6. **Genetically-evolved technical OR structural rules** — the search just overfits faster, and the
   surrogate catches it.
7. **Cross-asset rotation / "capital circulation" / dominance cycles / event-listing flow** — a true
   descriptive kernel exists, but it is single-asset momentum + aggregate vol-state, not a tradeable
   cross-tier edge.
8. **Free on-chain flow & valuation signals** — exchange net-flow, MVRV, NVT, reserve-depletion,
   stablecoin-supply; the only genuinely new data classes, all dead on baselines and/or the
   family-wise surrogate.
9. **Sentiment / cross-asset macro** — Fear & Greed, Google Trends, news-tone, rates/yields,
   net-liquidity/M2, put/call — all collapse to coincident risk-on beta.
10. **Calendar & event** — halving cycle (unfalsifiable-in-favor at N=2), sell-in-May,
    turn-of-month, day-of-week, CME gap-fill, stablecoin-mint events.

The **sole weak PROMISING lead** (dated-futures carry) — plus the now-downgraded XS Donchian — were
the only places the structure/sign was non-random, and even they fail to show a positive realized mean
*with significance at honest N on unseen data* (Donchian failing it on the survivorship-free rebuild).
**The one real thing — carry — is a regime trade that has decayed below the risk-free rate** (§4). That is the whole
map.

---

## 3. The recurring failure modes (each with one concrete example)

Almost every KILL is one of nine recurring patterns. Naming them is the point: it is how a future
reader recognizes a dead idea *before* spending a week on it. Each is given with one canonical
example and the decisive number.

### (a) Coincident / timed long-beta in disguise
A descriptive pattern that is just long-BTC (or long-SPX risk-on) exposure on a secularly rising
asset; it posts a 1.6–1.8 Sharpe and a real-looking monthly P&L, then loses to buy-and-hold *after
deflation*. The tell: every top config is long/flat, and the residual alpha is ~0.
> **Example — global net-liquidity / M2 (D6):** net Sharpe **1.31**, but residual alpha after
> hedging the BTC beta is exactly **0.000** — pure beta, no timing skill. (Supertrend/CCI in D1 and
> "digital gold" real-yield in D6 are the same trap.)

### (b) The h=0 order-flow tautology
An order-flow "signal" whose entire Sharpe lives in the **contemporaneous bar** — the trades *are*
the move (Hasbrouck/Easley). The strictly-lagged (h≥1) component, the only thing you can actually
trade, is ~0.
> **Example — taker buy/sell ratio (D2):** the lagged (h≥1) edge is **~5% of the h=0 ceiling**; CVD
> divergence has lagged IC ≈ 0. The whole free-tier order-flow belief set is dead at h≥1.

### (c) Selection inflation under honest N / single-config surrogate
A pretty grid-best evaporates once the Deflated Sharpe / Harvey-Liu haircut counts **every** config
tried — and, critically, once the surrogate null is computed **family-wise** over the searched grid
rather than on the single in-sample winner.
> **Example — Q9 cross-sectional low-vol anomaly:** harness surrogate p=0.002 (single-best config),
> but honest-N DSR **0.476 @ N=96** and Harvey-Liu adjP **0.673** fail by wide, fully reproducible
> margins; the family-wise MAX-statistic surrogate is only borderline (~0.06). This is the exact
> defect that flipped **reserve-depletion** and **O3 NVT** to KILL. The cure is genuine
> pre-registration: a config **frozen from mechanism before any search** collapses honest N to 1 —
> but it must not be the grid argmax.

### (d) De-risking masquerading as timing
A "regime gate" or "crash hedge" that looks like skill but is really just **lower average exposure**;
a matched-exposure (or matched-leverage) benchmark reproduces it, and mis-timed surrogate signals
hedge equally well.
> **Example — TSMOM trend overlay on carry (consensus family):** the "crash hedge" is just lower
> average leverage; a calendar-reanchored surrogate hedges as well (p ≈ 0.33–0.36), and the
> incremental return over matched leverage is **≈ 0**. (GARCH/EGARCH vol-timing in D348 is the same:
> it loses to B&H at matched exposure.)

### (e) Detection latency
A regime-switch signal that is correct in hindsight but fires **too late** to capture the move it
identifies — the latency between the regime change and its detection eats the edge.
> **Example — HMM / BOCPD regime timers (quant batch):** KILL on detection latency — by the time the
> change-point is confidently detected, the tradeable portion of the regime is gone.

### (f) No separable premium over an already-killed parent
A "new" signal that is a near-duplicate of an indicator already killed; it adds nothing once you
regress out the parent.
> **Example — Puell Multiple (D5):** **93%** the Mayer price/365d-MA oscillator (R²=0.87) — no
> separable information. (Frog-in-the-pan in D348 adds **zero** over plain momentum; carry+momentum
> combos add nothing over the already-killed carry.)

### (g) Reverse-causality echo
The "predictor" actually *lags* price — the apparent signal is price feeding back into the on-chain
series, not the series forecasting price.
> **Example — SSR / stablecoin-supply-ratio (D5):** the holdout inverts (−0.239) and a lead-lag test
> shows mints **lag** price — a reverse-causality echo, not a forecast. (The "adoption" /
> active-address series in the on-chain batch are repackaged price momentum the same way.)

### (h) Price-clock spurious regression
A residual or "valuation" series that is really a function of *time* (or of trailing price), so a
backtest fits a deterministic clock — Granger-Newbold spurious regression.
> **Example — Stock-to-Flow (D5):** the residual correlates **0.78** with price-vs-time and 0.75 with
> 365d momentum; it is a price clock, and the causal IC decays to **0.012** post-2021. (The
> realized-price cost-basis "support/resistance" line is the same illusion — a phase-randomized
> surrogate of a fixed horizontal line scores *higher*, p=0.841.)

### (i) Financing leak (systemic)
Every short or levered book in the campaign charged **zero borrow/financing on the levered or short
notional** — only the risk-free rate on a single unit. This is systemic: on a KILL it merely deepens
the kill, but it **inflated both carry headlines**.
> **Example — dated-futures basis carry:** the script charged RF on 1 unit while the book was
> ~2.95×-levered. Charging borrow on the real notional collapses **Sharpe 1.64 → 0.69**, **DSR 0.58
> → 0.13**, **$1,062 → $447/mo** — and it fails the 0.95 DSR gate at *any* RF ≥ 0.75%/yr. Only a
> thin **unlevered** ~4.9%/yr excess survives. (The Donchian lead carried the same short-notional
> borrow caveat; it was separately downgraded to KILL on 2026-06-09 for **survivorship** — §1.)

> **A tenth, doc-level caution — the tautological metric.** `residual_alpha_sharpe = sharpe(OLS
> residuals)` is **~0 by construction** (the residual mean is exactly 0), so it proves nothing about
> alpha; use `sharpe(y − β·x)` for true beta-hedged alpha. Two D348 KILLs were *correct on the
> holdout collapse* but had cited this broken metric; the audit corrected the reasoning, not the
> verdict.

---

## 4. The ONE real thing — carry — and why it is a regime trade, not a business

The only structurally real edges are **carry** — a limits-to-arbitrage premium (BIS WP 1087), **not
prediction**: **perp funding carry** and **dated-futures basis / cash-and-carry**. Both are real, and
both have **decayed below the risk-free rate** in the current (2025–2026) regime.

- **Decay is severe and real.** Equal-weight 8-major gross funding APR went **2023H2 6.53% → 2024
  10.99% (the one-off bull blowout) → 2025 2.55% → 2026 YTD −0.05%**. The honest full-3-year headline
  was dominated by the 2024 funding blowout, which has fully reverted.
- **Capital efficiency halves it.** Funding is earned on the short *notional*, but you immobilize
  ~1.5–2× notional (margin + survival buffer); monthly-roll fees (~3.4%/yr of notional) ≈ *all* of
  current funding. The incremental edge over T-bills is **negative at every tier** for an indie at
  $10k–$1M today.
- **The financing-leak correction is decisive for dated-basis.** The levered "$1,051/mo" headline was
  an artifact (RF charged on 1 unit, ~2.95× leverage). At the correct levered RF charge the series
  collapses to **DSR 0.13 / ~$447/mo**. Only a **thin unlevered ~4.9%/yr (t=2.41)** market-neutral
  excess survives — **sub-every-multiple-testing bar**, and regime-fragile (sub-RF in 2023, −37% in
  the 2021 cohort).
- **The oracle proof (the deepest finding).** A carry gate with **perfect foresight** earns only
  ~**0.52–0.53%/yr** over the risk-free rate in the current holdout, because realized funding there is
  ≈0.36%/yr. **The structural edge decayed below the cost of harvesting it — not even a clairvoyant
  timer can extract it now.**

> **Verdict on carry: it is a REGIME TRADE** — turn it on only when funding is rich (sustained
> >~8–9%) and rising, as in 2024 — **not an always-on business.** For an indie at $10k–$100k today it
> does not beat the risk-free rate after fees + capital efficiency + buffer. Dated-basis is
> structurally cleaner but also compresses, is quarterly-lumpy, and carries the same counterparty
> tail. (US persons are geo-blocked from the deepest venues, making the economics strictly worse.)

---

## 5. The methodology that WORKS — the project's real asset

The durable win is **a gauntlet that does not lie**. Reuse it for any future hypothesis; do **not**
weaken it.

**The binding gate order (every hypothesis must clear ALL; the binding gate is the first failure):**

```
net_of_cost → baselines (buy&hold + matched-exposure + random-lottery)
            → Deflated Sharpe @ honest N → block-bootstrap CI → CPCV/PBO
            → Harvey-Liu haircut → the RIGHT surrogate null → consume-once holdout
```

- **SURVIVE** = all pass. **PROMISING** = passes net + baselines + surrogate + holdout but trips a
  multiple-testing / Deflated-Sharpe gate. **Else KILL.**

**Committed primitives** (`src/lib/training/statistical-validation.ts`):
`computeDeflatedSharpeRatio` (Deflated Sharpe at the **true N** = total distinct configs tried, not 1,
not per-family length), `estimateCscvPbo` (CPCV/PBO), `blockBootstrapConfidenceInterval`,
`summarizeReturnSeries`. Per-domain `runGauntlet` wrappers chain them with the claim-appropriate null
(e.g. `scripts/edgehunt-D5/harness.ts`). The published lean repo also exposes a single
`validateStrategy(...)` wrapper, documented in [`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md).
*(On the development branch the `validateStrategy` wrapper and the `significance/*` subdirectory are
not present; the gate primitives above are.)*

**The controls that did the actual killing:**
1. **Honest N** — deflate by the *true* number of trials. This turned every "p<0.001" champion into
   noise (Q9 DSR 0.476 @ N=96; O3 DSR 0.894 @ N=312; a prior genetic-programming search collapsed at
   N=5613 → DSR ≈ 9e-12).
2. **The RIGHT surrogate null, family-wise for searched grids.** Time-series timing →
   phase-randomization / block-bootstrap; rotation / relative-value → **cross-sectional shuffle**;
   variance-risk-premium → shuffled-VRP placebo; vol-clustering → GARCH-simulated zero-edge;
   calendar/event → calendar-reanchor + **family-wise MAX-statistic**. The wrong null over-kills (a
   directional carry "fails" a cross-sectional shuffle that has no power) or under-kills (a
   single-best-config p passes a data-mined grid — the defect that produced three false PROMISINGs).
3. **Consume-once holdout** — scored exactly once, never re-tuned; survivorship-biased panels
   (LUNA/FTT absent) make even the holdout an upper bound.
4. **Cost discipline** — taker ~4 bps/side on every position change, **and borrow on the full
   levered/short notional** (the leak this campaign found and fixed). A gross-only signal is an
   automatic KILL.

> **A KILL is a valuable, honest outcome.** The body of ~111 documented kills is the gates working
> correctly, not a failure of effort. The asset is the refusal to manufacture a survivor.
> `npx tsc --noEmit` clean over `src/` (the committed gates; `scripts/edgehunt-*` run under `tsx`); every run on real public data; cloud spend **$0**.

---

## 6. The meta-conclusion

**A right-null surrogate PASS proves the structure/sign is non-random — it does NOT prove that the
realized mean is positive-with-significance at honest N on unseen data.** That gap is exactly the
PROMISING / SURVIVE boundary, and **no lead crossed it.**

This is the single most important thing the program learned. The closest miss illustrates it cleanly:
the BTC reserve-depletion lead posted a clean-looking paper-forward (Sharpe ≈1.19), is causal and
leak-free — and is still a **KILL**, because its "pre-registered" config was the argmax of a searched
neighborhood, so its surrogate significance does not survive multiple-testing deflation. The XS
Donchian lead made the same point twice over: its cross-sectional structure looked real on the survivor
panel (XS-shuffle p=0.009), yet its holdout *magnitude* was indistinguishable from zero — and when the
panel was rebuilt **survivorship-free**, even the *structure* (the shuffle null) failed (p 0.002 →
0.103). The **sign that looked real was partly the dead coins** — which is precisely the line between
an interesting in-sample structure and a deployable edge.

**Nothing is deployable.** The durable deliverable is the **methodology** — the committed gauntlet,
the right-null discipline, honest N, the family-wise surrogate, the consume-once holdout, and the
financing-honest cost model — plus the **body of negative evidence** that maps where the edge is not.
The two prior carry "survivors" (perp funding carry, dated-futures basis) remain **sub-risk-free
regime trades**: real premia that pay only when funding is rich and rising, not an always-on business
for an individual at retail cost.

> **Bottom line.** Of ~111 hypotheses spanning the full retail/quant arsenal, **none cleared the full
> gauntlet on data it had never seen.** Two weak leads (a beta-neutral cross-sectional breakout and a
> thin unlevered carry) are worth keeping warm for a better-powered, pre-registered, live-forward
> follow-up — gated on a longer survivorship-clean panel and honest financing. Everything else is a
> documented KILL. **No capital is deployed.**

---

*License: MIT — see [`../LICENSE`](../LICENSE).*
