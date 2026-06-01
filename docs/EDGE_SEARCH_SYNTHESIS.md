# Edge Search — Findings & Synthesis

> **Purpose.** This is the map of what the edge search actually learned, so a future
> reader does not re-walk dead ground. Every number here traces to a committed script
> and a JSON in `output/`. It is the honest, public "Findings & Synthesis" page for the
> whole program: 35 crypto trading hypotheses tested under an anti-overfitting validation
> harness; 33 killed; 2 structural-carry "survivors" that are real but sub-risk-free in
> the current regime.
>
> **Where this sits in the documentation set** (start at the index, [`docs/README.md`](README.md)):
> - **[`RESULTS.md`](RESULTS.md)** — the per-hypothesis result tables and the headline tally.
> - **[`METHODOLOGY.md`](METHODOLOGY.md)** — the gates, controls, and the discipline that did the killing.
> - **[`REFERENCES.md`](REFERENCES.md)** — the academic bibliography (each gate and each hypothesis → its source).
> - **[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)** — how to re-run every number from a clean clone.
> - **[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md)** — the reusable `validateStrategy(...)` API that packages the gates.
> - This page is the **narrative** that ties them together: *where the edge is NOT, and why*.
>
> The raw chronological lab log (per-round detail, internal, Portuguese) is
> `docs/EVOLUTION_TRAINING_LOG.md` (entries dated 2026-05-31, rounds 1–6). Numbers in
> this page are translated/re-derived from that log and the machine-readable `output/`
> JSONs. Git at this synthesis: `ec6fa9a0`. **License: MIT (see [`../LICENSE`](../LICENSE)).**

---

## 0. TL;DR (the honest verdict)

- **35 distinct hypotheses tested** at full rigor on real public data (cloud $0).
- **33 KILL** — every prediction / technical-analysis / relative-value / rotation / event-flow
  / on-chain-flow idea, **fixed, adaptive, AND genetically-evolved**.
- **2 structural-carry survivors** (perp funding carry, dated-futures basis) that **pass the
  full-sample gates but are sub-risk-free in the CURRENT regime** — they only paid in the
  2024 funding blowout.
- **The edge is NOT in direction prediction, TA, relative value, or cross-asset rotation.**
  It never was. The gates are correctly refusing to promote noise.
- **The one durable asset of this project is the methodology**: committed gates +
  surrogate/placebo controls + honest trial count `N` + a consume-once holdout. That stack
  killed 33 pretty in-sample Sharpes that would otherwise have looked like wins — including
  the output of a genetic-programming search, the definitive overfitter.
- **The on-chain / dry-powder-flow frontier has now been tested.** The on-chain scout
  delivered a **$0-feasibility verdict** (fundable at $0, prior null), and the recommended test
  was then run through the full gauntlet as the **28th hypothesis** (OC1, on-chain
  distribution-pressure) — **KILL** (binding gate baselines; surrogate placeboP=0.482). Only
  genuinely illiquid corners remain as a non-exhausted frontier — see §5.

---

## 1. The honest tally

| # | Hypothesis | Class | Verdict | Killed by (out-of-sample / control) |
|---|---|---|---|---|
| E1 | Cross-section weekly momentum (30 coins) | prediction | KILL | holdout **−9.59% net**, DSR(N=32)=0.776, loses to random-lottery |
| E2 | **Perp funding carry (delta-neutral)** | **carry** | **SURVIVOR*** | passes all gates on 3y full-sample; *sub-RF today (§3) |
| E3 | BTC time-series trend (daily/weekly) | prediction | KILL | returns = long-beta to the bull; DSR(N=36)=0.886/0.593 < 0.95 |
| T1 | Cross-section reversal | prediction | KILL | holdout −32% |
| T2 | CS momentum, market-neutral + vol-target | prediction | KILL | fixed the long-only artifact (+27.9% vs universe −51.6%) but DSR(N=4) loses to random-lottery |
| T3 | Vol-target BTC (Moreira–Muir) | prediction | KILL | holdout net −11% |
| T4 | Diversified TSMOM + vol-target | prediction | KILL | holdout −18%, gross only +2.8%/2y |
| T5 | Regime-gated trend | prediction | KILL | holdout +1.3% vs B&H +15.3% |
| T6 | Seasonality / turn-of-month | prediction | KILL | holdout −32% (data-mining trap) |
| T7 | Funding as contrarian predictor | prediction | KILL | dead in-sample, holdout APR −28% |
| T8 | **Dated-futures basis / cash-and-carry** | **carry** | **SURVIVOR*** | holdout net APR +14.6%→+7.31% post-haircut; *also compressing (§3) |
| T9 | ETH/BTC relative value | prediction | KILL | holdout −48% |
| T10 | Cointegration pairs | prediction | KILL | gross +52.8% but path-fragile, DSR(N=420)=0.029, MinBTL fails |
| TA1 | Indicators to TIME the carry (ON/OFF) | timing | KILL | passes all gates in-sample (p=5.8e-7); holdout 100% OFF, ties RF; **oracle bound only +0.52%/yr** |
| TA2 | Slow vol-targeted TSMOM (Moskowitz–Ooi–Pedersen) | prediction | KILL | vault Sharpe **−0.076** (−4.74%), 12m lookback is *worst* in crypto |
| TA3 | Microstructure / forced-flow 15m BTC (224 variants) | prediction | KILL | cost kills all 15m/30m; survivor dies DSR(N=224, p=0.21) + holdout −0.98 |
| TA4 | Classic indicators (RSI/MACD/BB/MA/ADX/Donchian/Stoch), N=94 | prediction | KILL | **0/94 beat buy-and-hold**; best dies baselines + holdout (Sharpe −1.01) |
| WF-A | Adaptive walk-forward, premise test (daily, 5 families) | adaptive | KILL | trailing-best beats random next window only **50.7%**; surrogate clean (genuine fail) |
| WF-B | Adaptive WF on majors (N=27) | adaptive | KILL | **surrogate FAILS** (real 0.0050 ≤ surrogate 0.0085, placeboP=0.59) = optimization artifact |
| WF-C | Adaptive WF on 15m BTC (306k bars) | adaptive | KILL | **surrogate DECISIVE**: 80 surrogates beat real (real −0.063 vs +0.13); placeboP=0.63 |
| WF-D | Adaptivity ON THE REAL EDGE (carry threshold) | adaptive-carry | KILL | tracks perfectly (autocorr 0.97) but **oracle only +0.53%/yr** > nothing left to harvest |
| R2 | Illiquid corners / small-caps (20 names outside top-20) | relative value | KILL | real CS-momentum champion **worse than noise**: surrogate placeboP=0.90 (36/40 ≥ real), DSR 0.015, holdout −58.5% |
| R3 | GA that evolves trading RULES (genetic programming) | evolved-rules | KILL | **surrogate placeboP=1.000**; honest N=5613 genomes → DSR≈9e-12; champion train +0.088 → holdout −0.097 (classic overfit collapse) |
| R4 | GA with STRUCTURAL+technical carry rules | evolved-carry | KILL | beautiful in-sample structural rule (+3.15%/yr) **collapses to flat-RF on holdout** (−0.015%/yr); perfect-foresight oracle only +0.51%/yr |
| C1 | Capital rotation as lead-lag flow ("ride the relay") | rotation | KILL | N=108, PBO **96.4%**, holdout **−39.9%**; the lead-lag statistic is fully reproduced by the cross-sectional shuffle (p=1.000) → artifact, not real rotation |
| C2 | Dominance CYCLE (is there a rotation period?) | rotation | KILL | dominance is **persistent, not cyclic** (acf1=0.55); the 14-week spectral peak is reproduced by phase/block surrogates; strategy in-sample 1.14 → vault **−1.53 (−52.7%)**, placeboP=1.000 |
| C3 | JOINT market-state / breadth overlay | rotation | KILL | breadth/dispersion **do** predict forward vol (descriptive truth), but the overlay ties equal-weight in-test, loses on holdout (−19.6%), loses to trivial linear; cross-sectional shuffle (p=0.244) → leftover timing is **aggregate vol-state, not breadth** |
| C4 | Event / listing forced-flow (641 real events) | event flow | KILL | a real descriptive "listing dump" (CAR −5.3% by day 20), but block-bootstrap reproduces ~72% of it, DSR(N=32)=0.77, and the consume-once 2025–26 cohort **pumped** → shorting it was **−100% compound** |
| OC1 | On-chain distribution-pressure (exchange-flow + MVRV, BTC+ETH) | on-chain / flow | KILL | N=36; the long/flat overlay **loses to B&H + random-lottery + equal-weight** (binding gate baselines) and the **surrogate fails** (placeboP=0.482 — phase/block surrogates of the same trajectories reproduce the "edge"); DSR passed (0.96) but is not decisive; holdout flat (Sharpe 0.003). The only genuinely new data class, also dead. |
| — | BTC-15m direction (the legacy GA target) | prediction | KILL | 659 evals, best +2.2% < luck-of-N +11.76%; retired as alpha generator |

\* Survivors are **structural carry**, not prediction. Both are real edges that have **decayed below the risk-free rate** in the current (2025–2026) regime. See §3.

**Totals: 33 KILL — every prediction / TA / relative-value / rotation / event-flow / evolved-rule
/ on-chain-flow hypothesis (fixed, adaptive, and genetically-evolved) plus 1 retired legacy
target; 2 structural-carry survivors, both sub-RF now.** (The legacy BTC-15m target is counted
within the 33 KILL — 35 distinct hypotheses, 33 killed, 2 carry survivors.)

---

## 2. WHERE the edge is NOT — and the two patterns that prove it

### Pattern A — "Two-gate" death (TA1, TA3, TA4, T10, …)
A signal produces a **pretty in-sample Sharpe** and *passes* DSR / PBO / Harvey-Liu haircut.
Those gates only certify *"this Sharpe is not luck-of-selection."* They do **not** test economic edge.
Every such candidate then **dies at the two gates that test real edge**:

1. **Baselines** — beat buy-and-hold + random-lottery + a one-layer linear model, *net of cost*.
2. **Consume-once holdout** — performance on data the search never saw.

> Canonical example — **TA4** (`output/ta-research/ta4-classic-indicators-result.json`):
> best config Bollinger-breakout passes DSR (p=0.00025) and PBO (0.00) and haircut,
> then **loses to buy-and-hold (margin −0.00057), to random-lottery, and to linear**, and the
> holdout flips to net Sharpe **−1.01**. The apparent "edge" is **long-beta in a bull, filtered**, not timing skill — every top config is long/flat.

### Pattern B — adaptive-drift is real but not trackable (WF-A/B/C/D)
The user's premise was **partially correct and sophisticated**: the optimal indicator config
*does drift* (the market is non-stationary). Confirmed in **4/4** runs:

| Run | optimal-param autocorr lag1 | drift trackable? | why adapting still fails |
|---|---|---|---|
| WF-A | 0.57 (stickiness 0.70) | yes, but **flat surface** | trailing-best beats *random* next window only **50.7%** (coin-flip); OOS net −0.0041/bar |
| WF-B | ~0.035 | no (44% churn ≈ noise) | pays +43% more cost to adapt, gains nothing; **surrogate fails** |
| WF-C | 0.39–0.64 | yes | adaptive net −0.063 < B&H +0.376; **80 surrogates beat the real run** (placeboP=0.63) |
| WF-D | **0.97** (regime), auto-calibrates | yes, beautifully | but oracle ceiling **+0.53%/yr** — nothing left to track |

The **surrogate/placebo control is the hero**. Without it, the in-sample WF-B/WF-C results
would have *looked like wins*. With it: the adaptive machine **manufactures backtest dispersion
in pure phase-randomized / block-bootstrap noise as well as (or better than) in real data** —
i.e. it is **fitting noise, not tracking regime**. (`output/walkforward/wf-c-result.json`:
real −0.063 vs phase-surrogate mean +0.129 / block +0.132.)

### Pattern C — give a genetic-programming search any primitives and it overfits; the surrogate still catches it (R3, R4)
The most aggressive test of the whole program: hand a **genetic-programming search** (the
definitive overfitter) free rein to *evolve* trading rules — technical primitives (R3,
`output/front-r3/ga-rules-result.json`) and structural carry primitives (R4,
`output/front-r4/ga-structural-carry-result.json`). In both, the GA found a champion that
looked great in-sample and **collapsed out-of-sample**, and **the surrogate control flagged
it every time**:

- **R3** (pop 160, 40 generations, honest **N = 5613 unique genomes** → DSR ≈ 9e-12): champion
  train net Sharpe +0.088 → **holdout −0.097** (classic overfit collapse). Run the *identical*
  GA on pure phase-randomized / block-bootstrap **noise** and it finds champions that do
  *better* out-of-sample (mean +0.032, max +0.110) than the real champion. **placeboP = 1.000.**
- **R4** (structural primitives, honest N = 2823): champion deploys carry on 28% of days
  in-sample (+3.15%/yr over RF) and **drops to 0% deployed — flat risk-free — on the holdout**
  (−0.015%/yr). A *perfect-foresight* oracle on the same holdout earns only **+0.51%/yr**,
  independently re-confirming the WF-D ceiling: there is no structural decision rule left to
  harvest in the current regime.

**Lesson:** giving an evolutionary search more freedom does not find edge — it finds
better self-deception, and the surrogate catches it. Without the surrogate, R3 would have
*looked like a win* in-sample.

> **Origin note (the retired GA alpha engine).** This program *began* as a GA evolving
> populations of neural "DNAs" to predict BTC-15m direction. An honest population audit
> (`scripts/audit-population-significance.ts`) returned a
> rigorous **true negative**: across **659 evaluations** the best DNA returned **+2.2%**,
> *below* the **+11.76% expected-max** of that many pure-noise strategies, with negative mean.
> That clean negative is what triggered the pivot to the theory-first gauntlet documented here
> — it is the program's origin, not a footnote. The engine is retired as an alpha generator and
> its source is archived for provenance only. See `RESULTS.md` §3 "Round 0 — Origin".

### Pattern D — "rotation" is single-asset momentum + aggregate vol-state, not capital circulation (C1–C4)
Round 6 tested the intuition that the market is one pool of capital **circulating** between
assets/tiers in cycles. There is a **real descriptive core** (rotation/persistence exists,
the joint view carries a vol regime, listing-dumps are real), but **none of it is tradeable
net of cost out-of-sample**. The decisive new control is the **cross-sectional shuffle**:
permute *which asset receives which return path* (preserving every marginal) so it destroys
genuine lead-lag/rotation but keeps single-asset structure.

- **C1** lead-lag relay: PBO **96.4%**, holdout **−39.9%**, and the lead-lag statistic is
  **fully reproduced by the cross-sectional shuffle (p = 1.000)** → the "lead-lag" is an
  artifact of single-asset momentum, not capital rotation.
- **C2** dominance cycle: dominance is **persistent, not cyclic**; strategy in-sample 1.14 →
  vault **−1.53 (−52.7%)**, placeboP = 1.000.
- **C3** joint breadth overlay: breadth/dispersion genuinely predict forward vol, but the
  cross-sectional shuffle (placeboP = 0.244, not significant) proves the **leftover timing is
  aggregate vol-state, not breadth** — the multi-asset view adds nothing a single aggregate
  vol series would not.
- **C4** event/listing forced-flow: a real descriptive listing-dump, but block-bootstrap
  reproduces ~72% of it and the consume-once 2025–26 cohort **pumped** → shorting it was
  **−100% compound**.

**Conclusion: the edge is NOT in (a) direction prediction, (b) cross-section/relative value at
retail cost, (c) classic or microstructure TA, (d) timing the carry, (e) adaptively re-fitting
any of the above, (f) genetically-evolved technical OR structural rules, (g) cross-asset
rotation / event flow, or (h) free on-chain exchange-flow + MVRV distribution-pressure overlays.**
Twenty-six independent attempts, all the standard academic priors plus the only genuinely new
(on-chain) data class, all dead net of realistic cost — and a true descriptive kernel in several
of them (drift, rotation/persistence, joint vol regime, listing-dumps) that is real but **not a
tradeable edge**. That "true descriptive kernel, no tradeable edge" is the recurring meta-finding
across all six rounds (and the on-chain follow-up).

---

## 3. The ONE real thing — carry — and why it is a regime trade, not a business

Two survivors are both **structural carry** (a limits-to-arbitrage premium, BIS WP 1087), **not prediction**:
**perp funding carry** (E2) and **dated-futures basis / cash-and-carry** (T8). Round 1's headline
"+6–7% APR" was honest *for the full 3-year sample* — but that sample is **dominated by the one-off 2024 funding blowout**, which has fully reverted. Round 2 (D1–D4) modeled real operation and found:

- **Decay is severe and real** (`output/carry/capacity-decay-report.txt`): equal-weight 8-major
  gross funding APR went **2023H2 6.53% → 2024 10.99% (bull blowout) → 2025 2.55% → 2026 YTD −0.05%**.
  Trailing-12m BTC+ETH sleeve gross ≈ **3.35%**, i.e. **below the 4.5% risk-free**.
- **Capital efficiency halves it** (`output/carry/d2_full_cost_model.json`): funding is earned on the
  short *notional*, but you immobilize ~1.5–2× notional (margin + survival buffer); monthly-roll fees
  (~3.4%/yr of notional) ≈ *all* of current funding. **Incremental edge over T-bills is negative at every
  tier**: **−$28/mo @ $10k, −$276/mo @ $100k, −$2,822/mo @ $1M** (incrementalEdgeMonthlyUsd).
  **Min viable capital: none up to $5M.** Break-even needs funding ≈ **8.4–9.8%** — only seen at the 2024 peak.
- **Cross-venue dispersion arb is a mirage at taker cost** (`output/carry/d1-report.json`): Binance↔Bybit
  funding correlated **0.66–0.87**; spread 0.4–0.9 bps vs 10–19 bps round-trip → a cost-aware policy
  fires **0–2× in 3 years** ≈ 0%/yr. BNB short-carry is **negative** (−2.2%) — it would *lose*.
- **Tail risk is counterparty/gap-dominated, not signal** (`output/carry/d3/d3-tail-survival-results.json`):
  worst real funding-flip regime is a shallow 16-day / −1.49% bleed; the real danger is a venue collapse
  (FTX-style). Multi-venue does **not** lower *expected* gap loss (linear) but cuts the **tail**:
  P(ruin) **2%/yr (1 venue) → 0.032%/yr (4 venues)**. Using the *non-decayed* 5.84% headline, post-survival
  edge is +0.82%/yr; **stack the 50% decay haircut and the edge goes negative.**
- **The oracle proof (the deepest finding)** — TA1 (`output/ta-research/carry-gating-report.json`) and
  WF-D (`output/walkforward/wf-d-adaptive-carry-report.json`): a gate with **perfect foresight** earns only
  **+0.52–0.53%/yr** over RF in the current holdout, because realized funding there is ≈0.36%/yr.
  **The structural edge decayed below the cost of harvesting it — not even a clairvoyant timer can extract it now.**

> **Verdict on carry: it is a REGIME TRADE — turn it on only when funding is rich (>~8–9%) and rising
> (as in 2024) — not an always-on business.** For an indie at $10k–$100k today it does **not** beat the
> risk-free rate after fees + capital efficiency + buffer; incremental edge vs T-bills ≈ **−2% to −3.3%/yr**.
> (US persons are also geo-blocked from the deep venues, making the economics strictly worse.) Dated-basis
> is structurally cleaner (~7% historical, basis locked at entry) but also compresses and is quarterly-lumpy,
> with the same counterparty tail.

---

## 4. The methodology that WORKS — the project's real asset

The durable win is **a gauntlet that does not lie**. Reuse it for any future hypothesis; do
**not** weaken it. It is now packaged as a single reusable call — `validateStrategy(...)` in
`src/lib/validation/strategy-validator.ts` — documented in
[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md); the gate-level rationale and academic
sourcing live in [`METHODOLOGY.md`](METHODOLOGY.md) and [`REFERENCES.md`](REFERENCES.md).

**Committed gates (`src/lib/training/`):**
- `statistical-validation.ts` — `computeDeflatedSharpeRatio` (Deflated Sharpe with the **TRUE N** = total
  distinct configs from the trial ledger, *not* 1, *not* per-family length), `estimateCscvPbo` (CPCV/PBO,
  flags `foldCount<8` degenerate), `summarizeReturnSeries`, `normalCdf`/`inverseNormalCdf`/`expectedMaxStandardNormal`.
- `significance/baselines.ts` — must beat **buy-and-hold + random-lottery + one-layer linear**, net of cost.
- `significance/haircut.ts` — Harvey-Liu (Bonferroni/Holm/BHY) multiple-testing haircut.
- `significance/holdout.ts` — **consume-once** final vault: scored exactly once, never re-tuned.

**Three controls that did the actual killing:**
1. **Honest N** — deflating by the *true* number of trials turned every "p<0.001" champion into
   noise (TA3: N=224, T10: N=420, **R3 genetic programming: N=5613 → DSR≈9e-12**).
2. **Consume-once holdout** — the data the search never saw; where every prediction/rotation
   edge died (R3 train +0.088→holdout −0.097; C1 holdout −39.9%; C3 holdout −19.6%; C4 cohort
   −100% compound).
3. **Surrogate / placebo** — three nulls that **preserve vol/autocorrelation but destroy real
   structure**: **phase-randomization** + **block-bootstrap** (destroy regime structure) and, for
   any rotation/lead-lag hypothesis, the **cross-sectional shuffle** (permutes which asset gets
   which path; destroys genuine rotation while preserving every marginal). If the strategy scores
   as well on the surrogate as on real data, the "edge" is an optimization artifact. This control
   made WF-B/WF-C conclusive, caught the R3/R4 genetic-programming overfit, and proved C1's
   "lead-lag" was an artifact (xshuffle p=1.000) instead of producing false positives.

**And the cost discipline:** taker ≈ 4 bps/side perp (8 bps round-trip) charged on **every** position
change; turnover reported. **A gross-only signal is an automatic KILL** (TA3's 15m/30m variants, TA4, all WF runs).

> **A KILL is a valuable, honest outcome.** The empty parent pool / 33 kills are the gates working
> correctly, not a failure of effort. The asset is the refusal to manufacture a survivor.
> **`npx tsc --noEmit` = 0 errors; every run on real public data; cloud spend $0.**

---

## 5. Honest forward guidance

**Exhausted (do not re-walk):** direction prediction on any single pair/timeframe; classic & microstructure
TA; cross-section / relative-value momentum or reversal at retail cost (including small-caps / illiquid
corners, R2); seasonality; funding-as-contrarian; **adaptive re-fitting of any of the above** (drift is
real but not predictively trackable — proven by surrogate); **genetically-evolved technical OR structural
rules** (R3/R4 — the GA just overfits faster, caught by surrogate); and **cross-asset rotation / "capital
circulation" / dominance cycles / event-listing flow** (C1–C4 — a true descriptive kernel of
rotation/persistence/vol-regime exists, but it is single-asset momentum + aggregate vol-state, not a
tradeable cross-tier edge; the cross-sectional shuffle is decisive); and **free on-chain flow signals**
(OC1 — exchange in/out flow + MVRV distribution-pressure on BTC+ETH; the only genuinely new data class,
also dead on baselines + surrogate, placeboP=0.482).

**Carry is *known* and *priced*:** real but a **regime trade**, currently sub-RF. Re-arm only on a funding
regime shift (sustained >~8–9% and rising). If pursued, the work is **operational/risk**, not signal:
multi-venue custody to cut the counterparty tail, capacity/slippage/margin/liquidation modeling, sizing to
survive an FTX-style collapse, and a US-jurisdiction venue check.

**On-chain / dry-powder flow — NOW TESTED (28th hypothesis), KILL.** On-chain and stablecoin-supply
data are a genuinely *different information set* (active addresses, exchange net-flows, stablecoin
mint/burn as dry powder) that the price-only search above never touched. A **feasibility scout**
(`scripts/onchain-scout/`, output under `output/onchain-scout/`) first confirmed a rigorous on-chain
test is **fully fundable at $0** (Coin Metrics Community + DefiLlama, no paid keys); early bivariate
correlations were weak (BTC active-address momentum → next-week return Pearson ≈ 0.09). The recommended
test was then run through the **full §4 gauntlet, unrelaxed** as **OC1** (`scripts/onchain-poc/`,
`output/onchain-poc/verdict.json`): a BTC+ETH exchange-net-flow + MVRV "distribution-pressure" overlay,
honest N=36, look-ahead controlled with a ≥1-day lag against Coin Metrics revision flags. Verdict
**KILL** — binding gate **baselines** (the long/flat overlay loses to B&H + random-lottery + equal-weight),
and the **surrogate also fails** (placeboP=0.482: phase/block surrogates of the same trajectories
reproduce the "edge"). The only genuinely new data class is now tested, and it died the same way the
rotation tests did. *(See [`docs/ONCHAIN_FEASIBILITY.md`](ONCHAIN_FEASIBILITY.md) for the design.)*

**The only non-exhausted priors (search HERE next, if anywhere):**
- **Structural / event flow at the deep-pocket end** — mechanical, calendar-driven, non-discretionary flows
  (index/ETF rebalances, option-expiry pins, liquidation cascades) where a *counterparty is forced to trade*.
  This is the same limits-to-arbitrage family as carry. Note: the *retail-tractable* slice of this family
  (listing/delisting events, C4) is now **exhausted** — it had a real descriptive dump but no tradeable,
  cost-surviving, out-of-sample edge.
- **Illiquid corners** — small/new markets where the cost gauntlet that killed everything liquid leaves room,
  *and* capacity is honestly tiny. Partially probed (R2 small-caps **killed**, capacity ceiling ≈ $108k);
  any remaining hope is in markets even smaller/newer than the R2 panel. Respect the §0 honesty: edge that
  only exists at <$1M is not a business, but it is at least *real*.

Anything new still passes the **full §4 gauntlet, unrelaxed**, including a fresh surrogate control (with the
cross-sectional shuffle where rotation/lead-lag is claimed) and a consume-once holdout. An empty parent pool
under these gates means *the target lacks edge net of cost* — **change the target, never the gates.**

---

### Key scripts & outputs (load-bearing index)

| Track | Script(s) | Output |
|---|---|---|
| Legacy target audit | `scripts/reorientation/audit-population-significance.ts` | — |
| E1/E2/E3 + T1–T10 | `scripts/reorientation/audit-*.ts`, `holdout-crossxs-momentum.ts`, `fetch-funding-rates.mjs`, `fetch-dated-futures-basis.mjs`, `build-crossxs-panel.mjs` | `output/funding/*`, `output/carry/*` |
| Carry round 2 (D1–D4) | `scripts/carry/{analyze-multivenue-carry,audit-capacity-decay,d2_full_cost_model,d2_sensitivity,d3-survival-tail-risk}.ts` | `output/carry/{d1-report,d2_full_cost_model,d3/d3-tail-survival-results,capacity-decay-report}.*` |
| TA round 3 (TA1–TA4) | `scripts/ta-research/{carry-gating,ta2-slow-tsmom,ta3-microstructure,ta4-classic-indicators}.ts` | `output/ta-research/*.json` |
| Adaptive round 4 (WF-A–D) | `scripts/walkforward/{premise-test,run-wf-b,run-wf-c,wf-d-adaptive-carry}.ts` | `output/walkforward/*.json` |
| Round 5: small-caps (R2) + GA-on-rules (R3) + GA-structural (R4) | `scripts/{r2-illiquid,front-r3,front-r4}/*.ts` | `output/{r2-illiquid,front-r3,front-r4}/*.json` |
| Round 6: rotation (C1) + cycle (C2) + breadth (C3) + event/listing (C4) | `scripts/{c1-rotation,front-c2,front-c3,front-c4}/*.ts` | `output/{c1-rotation,front-c2,front-c3,front-c4}/*.json` |
| On-chain feasibility scout (verdict delivered) | `scripts/onchain-scout/*` | [`docs/ONCHAIN_FEASIBILITY.md`](ONCHAIN_FEASIBILITY.md) ($0-fundable, prior null); raw probes under `output/onchain-scout/` |
| Round 7: on-chain distribution-pressure (OC1, the 28th test) | `scripts/onchain-poc/{fetch_cm,run_poc}.ts` | `output/onchain-poc/verdict.{json,txt}` (KILL — baselines + surrogate placeboP=0.482) |
| Reusable harness (the §4 gates, one API) | `src/lib/validation/strategy-validator.ts`, smoke-run `scripts/validation/demo-validate.ts` | `output/validation/*` |
| Gates (do not modify) | `src/lib/training/statistical-validation.ts`, `src/lib/training/significance/{baselines,haircut,holdout,trial-count,spa,cpcv-paths}.ts` | — |
| Pure reorientation cores | `src/lib/training/reorientation/{funding-carry,timeseries-momentum,cross-sectional-momentum,turnover,regime}.ts` | — |

Companion timeline (raw lab provenance, internal, Portuguese):
`docs/EVOLUTION_TRAINING_LOG.md` (2026-05-31 entries: strategic decision + rounds 1–6 + the
28th-test on-chain POC).
The public, English documentation set is indexed at [`docs/README.md`](README.md).

The reusable harness that composes the §4 gates into one API is documented in
[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md) (lib `src/lib/validation/strategy-validator.ts`,
smoke-run `scripts/validation/demo-validate.ts`).

---

## References / Bibliography

> The canonical, standalone bibliography is [`REFERENCES.md`](REFERENCES.md). The list
> below is the load-bearing in-context copy kept with this synthesis so the page is
> self-contained; the two are intended to stay consistent. Every gate and every tested
> hypothesis traces to a peer-reviewed (or working-paper) academic source. Entries are
> one-line, with year; the "→" notes where in this project the result is used or extended.

### Gates (the validation gauntlet, §4)

- **Bailey & López de Prado (2014), "The Deflated Sharpe Ratio", J. Portfolio Mgmt** — deflate an observed Sharpe by the *true* number of trials N, non-normal moments, and sample length. → `computeDeflatedSharpeRatio` (gate `deflated_sharpe`).
- **Bailey, Borwein, López de Prado & Zhu (2014), "Pseudo-Mathematics and Financial Charlatanism… Minimum Backtest Length", Notices of the AMS** — E[max Sharpe of N true-zero strategies] and the MinBTL bound. → `expectedMaxStandardNormal`, `evaluateMinBtl` (true-N / MinBTL).
- **Bailey & López de Prado (2012), "The Sharpe Ratio Efficient Frontier" / Probabilistic Sharpe Ratio, J. Risk** — PSR as the probability the true Sharpe exceeds a benchmark. → `computeProbabilisticSharpeRatio`.
- **Bailey, Borwein, López de Prado & Zhu (2017), "The Probability of Backtest Overfitting" (PBO/CSCV), J. Computational Finance** — combinatorially-symmetric cross-validation estimates the probability the in-sample best underperforms OOS. → `estimateCscvPbo` (gate `cpcv_pbo`).
- **López de Prado (2018), *Advances in Financial Machine Learning* (Wiley), ch. 7/8/11/12** — purged/embargoed CPCV, multiple OOS paths, the "False Strategy Theorem", and the consume-once holdout discipline. → `cpcv-paths.ts`, `holdout.ts` (gates `cpcv_pbo`, `holdout`).
- **Harvey & Liu (2015), "Backtesting", J. Portfolio Mgmt** — the multiple-testing *haircut* Sharpe (Bonferroni / Holm / BHY adjustment of the p-value). → `haircutSharpe`/`haircutSharpePanel` (gate `haircut`).
- **Harvey, Liu & Zhu (2016), "…and the Cross-Section of Expected Returns", Review of Financial Studies** — with hundreds of tested factors, a |t|>3 (not 2) bar is needed; motivates the honest-N deflation throughout. → trial-count / haircut rationale.
- **Harvey & Liu (2020), "False (and Missed) Discoveries in Financial Economics", J. Finance** — FDR/FWER control for strategy panels. → `haircutSharpePanel` (Holm/BHY), `spa.ts`.
- **White (2000), "A Reality Check for Data Snooping", Econometrica** — the bootstrap Reality Check for the best of many strategies. → `spa.ts` (superseded by SPA below).
- **Hansen (2005), "A Test for Superior Predictive Ability", J. Business & Economic Statistics** — studentized, recentered (SPAc) improvement on White's Reality Check. → `superiorPredictiveAbility` in `spa.ts`.
- **Romano & Wolf (2005), "Stepwise Multiple Testing as Formalized Data Snooping", Econometrica** — stepwise FWER control: *which* strategies are genuinely superior. → `romanoWolf` in `spa.ts`.
- **Theiler, Eubank, Longtin, Galdrikian & Farmer (1992), "Testing for nonlinearity… the method of surrogate data", Physica D** — phase-randomized surrogates preserve the power spectrum (autocorrelation/variance) and destroy nonlinear structure. → `phaseRandomize` (gate `surrogate`).
- **Politis & Romano (1994), "The Stationary Bootstrap", J. American Statistical Assoc.** — block/stationary bootstrap preserving short-range dependence. → `blockBootstrap`, `blockBootstrapConfidenceInterval`, SPA block bootstrap (gate `surrogate`).
- **Chen & Navet (2007), "Failure of Genetic-Programming-Induced Trading Strategies: distinguishing… from a random search", lecture/working note** — without a random/zero-intelligence pre-test, GP/GA "success" is probably luck. → `buildRandomLotteryBaseline` (gate `baselines`).
- **Zeng, Chen, Zhang & Xu (2023), "Are Transformers Effective for Time Series Forecasting?" (DLinear), AAAI** — a single linear layer matches/beats sophisticated forecasters in most settings. → one-layer-linear baseline (gate `baselines`).

### Tested hypotheses (the 28, §1)

- **Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", J. Financial Economics** — TSMOM across asset classes. → E3, T4, T5, TA2, WF-A/C (all KILL net of crypto cost; 12m lookback *worst* in crypto).
- **Jegadeesh & Titman (1993), "Returns to Buying Winners and Selling Losers", J. Finance** — cross-sectional momentum. → E1, T2 (KILL: holdout net negative / loses to random-lottery).
- **De Bondt & Thaler (1985), "Does the Stock Market Overreact?", J. Finance** — cross-sectional reversal/overreaction. → T1 (KILL: holdout −32%).
- **Moreira & Muir (2017), "Volatility-Managed Portfolios", J. Finance** — scale exposure inversely to recent variance. → T3, T4, T5 (vol-target; KILL: holdout net negative).
- **Fieberg, Liedtke, Poddig, Walker & Zaremba (2025), "A Trend Factor for the Cross Section of Cryptocurrency Returns" (CTREND), *Journal of Financial and Quantitative Analysis*, DOI 10.1017/S0022109024000747** — crypto trend factor. → BTC/diversified trend tests E3/T4 (KILL: long-beta, not timing skill). *(Verified published form; earlier drafts cited a 2024 working paper — see `REFERENCES.md` notes on citation accuracy.)*
- **Gatev, Goetzmann & Rouwenhorst (2006), "Pairs Trading: Performance of a Relative-Value Arbitrage Rule", Review of Financial Studies** — distance/cointegration pairs. → T9, T10 (KILL: path-fragile, DSR(N=420)=0.029, MinBTL fails).
- **Engle & Granger (1987), "Co-integration and Error Correction", Econometrica** — cointegration test underlying the pairs trade. → T10 cointegration construction.
- **Lo, Mamaysky & Wang (2000), "Foundations of Technical Analysis", J. Finance** — formal evaluation of classic TA patterns. → TA4 (94 classic indicators; 0/94 beat buy-and-hold).
- **Sullivan, Timmermann & White (1999), "Data-Snooping, Technical Trading Rule Performance, and the Bootstrap", J. Finance** — TA rule universes vanish under data-snooping-robust testing. → TA4, TA3 (microstructure 224 variants) rationale.
- **Bouchaud, Bonart, Donier & Gould (2018), *Trades, Quotes and Prices* (CUP)** — market-microstructure / forced-flow mechanics and cost. → TA3 (15m/30m forced-flow; cost kills all).
- **McLean & Pontiff (2016), "Does Academic Research Destroy Stock Return Predictability?", J. Finance** — post-publication decay of anomalies (~58% out of sample). → the decay framing of survivors (§3) and "carry is known and priced".
- **BIS Working Paper No. 1087 (2023), Aramonte, Huang & Schrimpf, "Crypto carry / limits to arbitrage"** — the perp-funding / basis premium is a limits-to-arbitrage compensation, not a forecast. → E2, T8 carry survivors (§3 limits-to-arbitrage framing).
- **Shleifer & Vishny (1997), "The Limits of Arbitrage", J. Finance** — why structural premia persist and who is forced to trade. → §5 "structural / event flow" guidance and carry interpretation.
- **Makarov & Schoar (2020), "Trading and Arbitrage in Cryptocurrency Markets", J. Financial Economics** — cross-venue price/funding dispersion and its frictions. → carry round-2 D1 (cross-venue dispersion a mirage at taker cost).

### Round-6 lead-lag / rotation (cross-sectional null)

- **Lo & MacKinlay (1990), "When Are Contrarian Profits Due to Stock Market Overreaction?", Review of Financial Studies** — lead-lag cross-autocorrelation among assets. → the cross-sectionally-shuffled null (`crossSectionalShuffle`) that must destroy genuine lead-lag.
- **Hou (2007), "Industry Information Diffusion and the Lead-Lag Effect in Stock Returns", Review of Financial Studies** — information diffusion drives lead-lag; rotation tests must control for it. → rotation hypotheses' mandatory cross-sectional surrogate.
- **Moskowitz & Grinblatt (1999), "Do Industries Explain Momentum?", J. Finance** — apparent cross-sectional momentum can be a rotation/grouping artifact. → why rotation edges are tested against the marginal-preserving cross-sectional shuffle, not just phase/block nulls.

### Round-7 on-chain valuation / flow (28th test)

- **The NVT / MVRV on-chain-valuation family** (network-value-to-transactions, market-value-to-realized-value, realized cap, SOPR, exchange in/out flow) — widely published on-chain "fundamental" signals, correspondingly heavily arbitraged. → OC1 distribution-pressure overlay (exchange-flow + MVRV, BTC+ETH): KILL on baselines + surrogate (placeboP=0.482), confirming the null prior. See [`REFERENCES.md`](REFERENCES.md) §B and [`ONCHAIN_FEASIBILITY.md`](ONCHAIN_FEASIBILITY.md).
