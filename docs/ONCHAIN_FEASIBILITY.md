# On-Chain at $0 — Feasibility, Data Catalog, and Results

*[Home](INDEX.md) · [Crypto](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](GLOSSARY.md) · [Polymarket](polymarket/README.md)*

> **What this page is.** A public, reproducible account of (a) how far a rigorous,
> anti-overfitting on-chain edge search can go for **$0 / no paid keys**, (b) exactly which
> free on-chain metrics that buys you (and which premium ones it does not), and (c) the
> **2026-06 on-chain results** — every on-chain signal we put through the gauntlet, and the
> verdict on each. This is a falsification lab: we publish what dies as carefully as anything
> that lives. **The on-chain headline is simple: every on-chain signal we tested is a KILL.**
> Nothing here is investment advice and no capital is deployed.

**Scope.** Can we run the committed gauntlet on on-chain data at **$0**, and does any free
on-chain signal survive it? **Feasibility: YES — fully fundable at $0.** **Result: no.** The free
data is real and deep enough to test the published on-chain narratives honestly; under the
same protocol that killed the rest of the program, the on-chain family produced **0 survivors**.

For the full cross-domain campaign these results sit inside, see
[`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md); the prior single-shot on-chain
test (OC1, an earlier single-shot on-chain test) is recorded in the published results wiki page
`RESULTS.md`. This page is the on-chain-specific deep dive.

---

## 1) The $0 on-chain data plan — what free data actually buys you

The backbone of every on-chain test in this project is the **free Coin Metrics Community**
catalog, a no-key daily API (`community-api.coinmetrics.io/v4`) with genesis-depth history for
BTC and full history for ETH. The Community tier exposes roughly **~32 daily metrics** per asset.
The ones the on-chain tests actually use:

| Metric (Coin Metrics Community) | What it is | Coverage | Used for |
|---|---|---|---|
| `PriceUSD` | Reference daily price | BTC 2010→now, ETH 2015→now | Returns, all overlays |
| `CapMrktCurUSD` | Free-float market cap | full | NVT / MVRV / valuation bands |
| `CapMVRVCur` | **MVRV** (market value / realized value) | full | Realized-cap cost-basis (see below) |
| `AdrActCnt` | Active addresses | full | Network-growth / Metcalfe |
| `TxCnt` | Transaction count | full | Network-growth / NVT-style usage |
| `FeeTotNtv` | Total fees paid, native units | full | Fee-revenue NVT proxy |
| `FlowInExNtv` / `FlowOutExNtv` | Exchange in/out flow, **native units** | **BTC + ETH only** | Exchange-flow / reserve-depletion |
| `SplyCur`, `HashRate`, `ROI30d/1yr`, … | Supply, hash, ROI, etc. | full | Supplementary fundamentals |

Two important properties of the free tier:

- **Native-unit exchange flow exists for exactly two assets — BTC and ETH.** This is the single
  most consequential constraint in the whole on-chain search: it means any exchange-flow edge can
  only be cross-checked across **two** assets, which (as the results show) is not enough to tell a
  genuine effect from a lucky single-asset window.
- **Realized cap is recoverable algebraically, for free.** The strict realized-cap series
  (`CapRealUSD`) is paid, but since `MVRV ≡ MarketCap / RealizedCap`, the realized cap is recovered
  **exactly** as `realizedCap = CapMrktCurUSD / CapMVRVCur` — both free. So the realized-cap /
  MVRV mechanism is fully testable at $0 (and it was — KILL).

### Paid on-chain metrics — DEFERRED (probed, confirmed gated, honestly flagged)

These are **not** in the free Community catalog (verified live as `forbidden` / Pro-only). Where an
exact free proxy exists we used it and say so; where none exists, the metric is **DEFERRED** —
recorded as untested-at-$0, not claimed as covered.

| Paid metric | Mechanism it belongs to | Free path used (if any) |
|---|---|---|
| `CapRealUSD` (strict realized cap) | realized-cap / MVRV valuation | **Exact algebraic proxy** `CapMrktCurUSD / CapMVRVCur` (tested — KILL) |
| `RevAllTimeUSD` (**thermocap**) | miner-revenue valuation | **No honest free reconstruction → DEFERRED** |
| `TxTfrValAdjUSD`, `NVTAdj` / `NVTAdj90` (**canonical Coin Metrics NVT**) | network-value-to-transactions | Built the strongest **free** substitute (fee-revenue NVT from `FeeTotNtv`·`PriceUSD`); the textbook transfer-value NVT itself is **DEFERRED** |
| Exchange-grade **netflow** (Glassnode / CryptoQuant) | distribution pressure | CM native-unit `FlowIn−FlowOut` is a **proxy**, not exchange-grade netflow — paid version DEFERRED |
| **SOPR**, **NUPL**, **CDD / coin-dormancy** | spent-output / holder-behavior valuation | No free reconstruction in the Community catalog → **DEFERRED** |

A DEFERRED metric is a metric we could not test honestly at $0 — **not** a metric that failed. The
honest statement the data licenses is "free on-chain valuation/flow signals do not survive," not
"all on-chain analysis is debunked." The premium spent-output and dormancy families (SOPR, NUPL,
CDD) and the canonical transfer-value NVT remain open questions, conditional on paid data.

---

## 2) The 2026-06 on-chain results — every signal, every verdict

All on-chain hypotheses were run through the committed gauntlet
(`scripts/edgehunt-D5/harness.ts::runGauntlet` over the primitives in
`src/lib/training/statistical-validation.ts`): **net-of-cost** (taker ~4 bps/side on every
position change) → **baselines** (buy-and-hold + matched-exposure + random-lottery) → **Deflated
Sharpe at honest N** → **block-bootstrap CI** → **CPCV/PBO** → **Harvey–Liu haircut** → **the right
surrogate null** (phase-randomization for these time-series claims; the **family-wise MAX-statistic**
for any searched grid) → **consume-once holdout**. On-chain features are lagged **≥1 day** with
next-day returns, causality enforced; Coin Metrics' `flash` / `reviewed` revision flags are
persisted in cache so the backtest is not silently using restated values.

**Outcome: every on-chain signal is a KILL. Zero survive, zero remain PROMISING after audit.**

| Signal | Mechanism | Verdict | Why it dies (the teaching case) |
|---|---|---|---|
| **Exchange reserve-depletion** (BTC netflow trend) | outflow → less sell-side liquidity → drift | **KILL** | The single best near-survivor in the whole program — and the family-wise audit flipped it. A *pre-registered* config cleared the consume-once forward tail (net Sharpe 1.265, price-orthogonal, DSR@N=1 0.988), but it is the **argmax of a searched ~12-config neighborhood**, so honest N≠1. Under the **family-wise MAX-statistic** surrogate the standard requires for a searched grid, the surrogate gate **fails** (p≈0.24, real best 0.994 < surr95 ≈1.19; the harness's 0.013 was a single-config p with no FWER). It also **inverts on ETH** (the only other free-flow asset, forward Sharpe −0.85). |
| **Fee-revenue NVT** (BTC, free proxy for canonical NVT) | overvaluation vs on-chain usage → contrarian short | **KILL** | The other provisional near-survivor, also flipped by the family-wise audit. In-sample it looks strong (net Sharpe 1.33, 10/10 years positive, holdout +0.59), but the win rides a grid corner; the **family-wise MAX-stat surrogate fails at the actually-searched N=312 (p=0.093, real best 1.332 < surr95-max 1.384)** and honest-N **DSR is 0.894 @ N=312** (the 0.968 "pass" was a post-hoc N=54 carve-out). No ETH confirmation; it is a **free proxy** for the paid transfer-value NVT (`NVTAdj90`, DEFERRED). |
| **MVRV-Z extreme bands** | sell euphoria / buy capitulation | **KILL** | The "strengthened" variant is **byte-identical to buy-and-hold out-of-sample**; every timing day sits in the 2015–17 in-sample window (band last fired 2017-12). A non-causal in-sample artifact, not a signal. |
| **Stock-to-Flow deviation** | scarcity model → price target | **KILL** | The S2F residual is a **price clock** (corr 0.78 with the price-vs-time residual, 0.75 with 365-day momentum) → a textbook **Granger–Newbold spurious regression**; causal IC decays to ~0.012 post-2021. |
| **Puell Multiple** | miner-revenue valuation oscillator | **KILL** | **93% identical to the Mayer price/365-day-MA oscillator** (R²=0.87) — it is a price oscillator wearing an on-chain label, not independent information. |
| **Stock-to-Sell-Side / SSR** (stablecoin supply ratio) | stablecoin dry-powder vs BTC cap | **KILL** | Holdout **inverts** (−0.24); lead-lag shows mints **lag** price (corr with trailing 30-day return 0.50 vs next-day 0.02) — a **reverse-causality echo**, not a leading indicator. |
| **Hash Ribbons** | miner capitulation → bottom | **KILL** | Highest raw on-chain Sharpe (1.13), passes 7/8 gates, killed by the hash-only surrogate: the edge is entirely the **price-confirmation clause (long beta)** — the incremental hash-rate edge is **−0.084**, and price-only TSMOM alone beats the combined signal. |
| **Metcalfe active-address residual** | network value ∝ users² | **KILL** | Mean-reverting noise — **0 of 162** strengthened configs cleared the surrogate **and** held out-of-sample. |
| **Realized-price cost-basis support/resistance** | aggregate cost basis as S/R | **KILL** | A fixed horizontal line whose phase-randomized surrogate scores **higher** than the real run (p=0.84) — the same illusion as a random horizontal line. |
| **Fee-NVT / realized-cap valuation band** (algebraic realized cap) | over/undervaluation vs realized cap | **KILL** | Loses to buy-and-hold and to a price-only Mayer control; the realized cap was the exact free `MarketCap/MVRV` proxy, so the mechanism was genuinely tested. |
| **Stablecoin-supply dry-powder flow** | new stablecoins → forward buying | **KILL** | Reverse-causality (forward lead/lag 0.022 vs trailing 0.351 — issuers mint **after** inflows); fails DSR at honest N and the holdout is negative once the reverse-causality is cleaned. |
| **Network-growth momentum** (AdrActCnt + TxCnt) | adoption → price | **KILL** | The "adoption" series is **repackaged price momentum** (corr 0.55–0.73 with price momentum); price-orthogonalized it loses to B&H, and the ETH OOS holdout inverts. |

Supporting per-domain detail: [`output/edgehunt-D5/SUMMARY.md`](../output/edgehunt-D5/SUMMARY.md)
(8 on-chain BTC hypotheses) and
[`output/edgehunt-onchain2/SUMMARY.md`](../output/edgehunt-onchain2/SUMMARY.md) (8 valuation/flow +
price-transform hypotheses). The two flips to KILL are documented in
[`output/edgehunt-audit/SUMMARY.md`](../output/edgehunt-audit/SUMMARY.md) (reserve-depletion) and
[`output/edgehunt-audit-nb/SUMMARY.md`](../output/edgehunt-audit-nb/SUMMARY.md) (fee-revenue NVT).

---

## 3) The two near-survivors, and why the audit killed both

Two on-chain leads briefly looked like the closest things to a survivor the whole program
produced. Both were flipped to KILL by an independent **two-layer methodology audit** that
re-derived every disputed number from the committed primitives — and they died on **the same
defect**, which is the central methodological lesson of this page.

**Exchange reserve-depletion (BTC).** A flow signal — EMA-smoothed native `FlowIn − FlowOut`,
rolling-Z, lagged ≥1 day, long/flat — that on a pre-registered config posted a clean-looking
**paper-forward net Sharpe 1.19–1.27** on data it had never seen, price-orthogonal and leak-free.
The problem: the "pre-registered" config was the **rank-1 point of a searched ~12-config
neighborhood**, so it is not honestly N=1. The harness ran its phase-randomization surrogate on
**only that single best config** (p=0.013, a PASS). The correct null for a *searched* family is the
**family-wise MAX-statistic** — scramble every config, take the per-surrogate grid maximum — and
under it the surrogate gate **fails** (p≈0.24; the real best 0.994 sits below the surrogate's 95th
percentile ≈1.19). And the only cross-check available at $0 — ETH, the one other free-flow asset —
**inverts** (forward Sharpe −0.85). **KILL.**

**Fee-revenue NVT (BTC).** A causal contrarian valuation signal — `MarketCap / SMA(FeeTotNtv·Price)`,
Kalichkin-smoothed, z-scored, lagged ≥1 day, short the overvalued leg — that posted in-sample net
Sharpe **1.33**, 10/10 years positive, and a positive consume-once holdout. Same defect: the win
rides a searched grid corner (shortest SMA × longest z-window), the harness surrogate p=0.005 is a
**single-best-config** p, and under the **family-wise MAX-stat over the actually-searched N=312** the
surrogate gate **fails** (p=0.093; real best 1.332 < surr95-max 1.384). Honest-N **DSR is 0.894 @
N=312**; the 0.968 "pass" came from a post-hoc N=54 carve-out, not a frozen mechanism. ETH does not
confirm, and it is a **free proxy** for the paid canonical NVT. **KILL.**

> **The lesson (the PROMISING/SURVIVE boundary).** A surrogate PASS under the *right* null proves
> the signal's **structure/sign is non-random** — it does **not** prove the realized **mean is
> positive with significance at honest N on unseen data**. That gap is exactly the line between
> PROMISING and SURVIVE, and **no on-chain lead crossed it.** The specific trap both leads fell
> into: a **single-best-config surrogate p masking a searched grid**. The honest null is the
> **family-wise MAX-statistic**, and the honest trial count is the **whole grid**, not the winner.

A systemic **financing leak** the audit also found across the program (zero borrow charged on
levered/short notional) does not change any on-chain verdict — on a KILL it only deepens the kill —
but it is why the program's two surviving carries (perp-funding and dated-futures basis) are now
correctly reported as thin, **sub-risk-free** regime trades rather than headline edges.

---

## 4) Completeness, traps, and honest caveats

**Free sources to add if the on-chain thesis is ever revisited** (no signup; not yet exhausted):
DefiLlama `/bridges` + `/bridgevolume` (cross-chain flows are arguably cleaner than USD-denominated
TVL-share); Blockchain.com `mvrv` / `nvt` chart slugs (an independent cross-check on CM's
`CapMVRVCur`); DefiLlama `/fees` and `/revenue` overviews. These are strong candidates by API family
but **were not hit live** in these runs — treat as unverified until probed.

**Data-quality traps that must be controlled in any on-chain test** (all handled in the runs above):

1. **Look-ahead from revised on-chain metrics.** CM exchange-flow and some MVRV rows carry
   `status: flash / reviewed` (provisional, restated later); naive use leaks future revisions.
   *Control:* features lagged ≥1 day, revision flags persisted in cache, proxy treatment.
2. **USD-denomination tautology.** A USD-denominated stock (TVL, market cap) moves *with* price, so
   it is a mechanical contemporaneous "predictor." *Control:* use **native-unit** flows (CM `…Ntv`)
   or strictly-lagged ratios — never a USD stock as a same-bar feature.
3. **Survivorship in token/chain lists.** "Today's surviving chains/coins" exclude dead ones
   (LUNA/FTT/UST), so even a holdout is an upper bound. *Control:* restrict to BTC/ETH or rebuild
   the universe point-in-time before any promotion.
4. **Reverse causality.** "Adoption" and stablecoin-supply series often **follow** price (SSR mints
   lag price; issuers mint after inflows). *Control:* the h≥1 lead/lag test — require the strictly
   leading component to carry the signal.
5. **Definition mismatch across sources.** Blockchain.com `n-unique-addresses` ≠ CM `AdrActCnt`; a
   free flow proxy ≠ exchange-grade netflow. *Control:* cross-check **values**, not names.

**Overclaims corrected (sources that are not as "free" as advertised):** Glassnode and CryptoQuant
are **not** no-key free (live 401); exchange-grade netflow and the canonical transfer-value NVT,
SOPR, NUPL, CDD/dormancy, and thermocap (`RevAllTimeUSD`) are **paid / DEFERRED**, not tested here.
CoinGecko works no-key but is hard-throttled and snapshot-only (not a backfill source). Etherscan
needs a free-signup key on every endpoint; under a no-signup constraint, substitute CM ETH metrics.

---

## Executive summary

- **$0 feasibility: confirmed.** The no-key backbone is **Coin Metrics Community** (~32 daily
  metrics, genesis-depth BTC / full-history ETH: `AdrActCnt`, `TxCnt`, `FlowIn/FlowOut`,
  `CapMVRVCur`, `CapMrktCurUSD`, `FeeTotNtv`, `PriceUSD`). **Native exchange-flow is BTC+ETH only.**
  Realized cap is recovered **algebraically exact** for free as `CapMrktCurUSD / CapMVRVCur`.
- **PAID and DEFERRED (untested at $0, not failed):** SOPR, NUPL, CDD/dormancy, thermocap
  (`RevAllTimeUSD`), and the canonical transfer-value NVT (`NVTAdj` / `TxTfrValAdjUSD`), plus
  exchange-grade netflow. These remain open, conditional on paid data.
- **On-chain result: every tested on-chain signal is a KILL — 0 SURVIVE, 0 PROMISING after audit.**
  Reserve-depletion (flipped to KILL by the family-wise audit), MVRV-Z (in-sample artifact),
  Stock-to-Flow (price-clock / spurious regression), Puell (= Mayer price oscillator), SSR
  (reverse-causality echo), Hash-Ribbons (price-confirmation = long beta), Metcalfe (mean-reverting
  noise), realized-price S/R (random-line illusion), fee-revenue NVT (flipped by the family-wise
  audit), and stablecoin-supply flow (reverse causality) — each a documented teaching case.
- **The central lesson:** the two near-survivors (BTC reserve-depletion, fee-revenue NVT) both died
  on the **same defect — a single-best-config surrogate p masking a searched grid**. The honest null
  is the **family-wise MAX-statistic** and the honest N is the **whole grid**; a right-null PASS
  proves the structure is non-random, not that the mean is positive-with-significance at honest N on
  unseen data. **No on-chain lead crossed that boundary. Nothing is deployable.**

---

*This document is part of an open, $0, reproducible crypto edge-search / falsification lab. We
publish negative results and methodology, not signals. See
[`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md) for the full cross-domain campaign
and the published `RESULTS.md` wiki page for the running ledger.*

*Licensed under the MIT License.*
