# RESULTS — The Crypto Edge-Search Program (canonical record)

> **What this is.** The single, canonical, English-language record of every hypothesis
> tested in this project's systematic search for a tradeable crypto edge. **35 distinct
> hypotheses** were run at full rigor on real public market data (cloud spend **$0**).
> **33 were KILLED.** **2 are sub-risk-free carry "survivors"** that pass the full-sample
> gates but are **sub-risk-free in the current (2025–2026) regime** — they are regime
> trades, not a business.
>
> **The durable asset is the methodology, not a strategy.** A committed anti-overfitting
> gauntlet (honest trial-count `N`, surrogate/placebo controls, and a consume-once
> holdout) refused to promote 33 pretty in-sample Sharpes that would otherwise have
> looked like wins. That refusal is the result.
>
> **Honest framing.** This is a *negative-results + rigorous-methodology* contribution.
> Carry is **not** "profitable" today; it is real but has decayed below the risk-free
> rate in the current regime. Nothing here is investment advice.
>
> **Provenance.** Every number traces to the chronological lab log
> `docs/EVOLUTION_TRAINING_LOG.md` (the raw provenance, in Portuguese) and to the
> machine-readable JSON outputs under `output/`. The methodology is documented in
> `docs/VALIDATION_HARNESS.md`; the durable synthesis and full academic bibliography in
> `docs/EDGE_SEARCH_SYNTHESIS.md`.
>
> **License: MIT (see [`../LICENSE`](../LICENSE)).**

---

## 1. Master table — all 35 hypotheses

Columns: **ID** · **Name** · **Class** (prediction / carry / rotation / event /
structural / adaptive / TA-timing) · **Data used** · **Honest N** (the true number of
distinct configs searched, fed to the Deflated-Sharpe and haircut gates) · **Binding
KILL gate** (the first gate that failed) or **SURVIVOR\*** · **Key out-of-sample
number** (the consume-once holdout return/Sharpe, or — for survivors — the full-sample
net APR).

| ID | Name | Class | Data used | Honest N | Binding gate (or SURVIVOR\*) | Key out-of-sample number |
|---|---|---|---|---|---|---|
| **E1** | Cross-section weekly momentum | prediction | 30 USDT pairs, Binance daily 2020–2026 | 32 | KILL — holdout + baselines (loses to random-lottery) | holdout **−9.59% net**; DSR=0.041 |
| **E2** | **Perp funding carry** (delta-neutral: long spot / short perp) | **carry** | 8 majors, Binance 8h funding, 3y | — | **SURVIVOR\*** (passes all gates on 3y sample) | full-sample **net ~5.84% APR**; sub-RF today (§4) |
| **E3** | BTC time-series trend (daily / weekly) | prediction | BTC full local history | 36 | KILL — Deflated Sharpe + baselines | DSR **0.886** (daily) / **0.593** (weekly) < 0.95; returns = long-beta |
| **T1** | Cross-section reversal | prediction | 30-coin panel | — | KILL — holdout | holdout **−32%** |
| **T2** | CS momentum, market-neutral + vol-target | prediction | 30-coin panel | 4 | KILL — Deflated Sharpe (loses to random-lottery) | in-sample +27.9% vs universe −51.6%, but DSR(N=4) fails |
| **T3** | Vol-target BTC (Moreira–Muir) | prediction | BTC history | — | KILL — holdout | holdout **net −11%** |
| **T4** | Diversified TSMOM + vol-target | prediction | multi-asset panel | — | KILL — holdout | holdout **−18%**; gross only +2.8% / 2y |
| **T5** | Regime-gated trend | prediction | BTC / majors | — | KILL — holdout (loses to B&H) | holdout **+1.3%** vs buy-and-hold **+15.3%** |
| **T6** | Seasonality / turn-of-month | prediction | majors daily | — | KILL — holdout (data-mining trap) | holdout **−32%** |
| **T7** | Funding as contrarian predictor | prediction | funding panel | — | KILL — dead in-sample | holdout **APR −28%** |
| **T8** | **Dated-futures basis / cash-and-carry** | **carry** | Binance quarterly delivery futures | 30 | **SURVIVOR\*** (passes all gates) | holdout **net APR +14.6% → +7.31%** post-50% haircut; sub-RF / compressing (§4) |
| **T9** | ETH/BTC relative value | prediction | ETH, BTC | — | KILL — holdout | holdout **−48%** |
| **T10** | Cointegration pairs | prediction | majors panel | 420 | KILL — Deflated Sharpe + MinBTL | gross +52.8% but path-fragile; **DSR(N=420)=0.029**, MinBTL fails |
| **TA1** | Indicators to TIME the carry (ON/OFF) | TA-timing | funding / premium / basis-slope, 3y | 69 | KILL — holdout (oracle ceiling) | passes all gates in-sample (p=5.8e-7); holdout **100% OFF, ties RF**; **oracle bound only +0.52%/yr** |
| **TA2** | Slow vol-targeted TSMOM (Moskowitz–Ooi–Pedersen) | prediction | 30-coin panel, monthly | 24 | KILL — net-of-cost / holdout | vault Sharpe **−0.076** (−4.74%); 12m lookback is *worst* in crypto |
| **TA3** | Microstructure / forced-flow 15m BTC (224 variants) | prediction | BTC 15m, 306k bars, 8.75y + funding/OI | 224 | KILL — Deflated Sharpe + holdout | cost kills all 15m/30m; survivor dies **DSR(N=224, p=0.21)** + holdout **−0.98** |
| **TA4** | Classic indicators (RSI/MACD/BB/MA/ADX/Donchian/Stoch) | prediction | 8 majors daily | 94 | KILL — baselines + holdout | **0/94 beat buy-and-hold**; best flips to holdout Sharpe **−1.01** |
| **WF-A** | Adaptive walk-forward, premise test (5 families) | adaptive | BTC/ETH/SOL/BNB daily | meta-grid | KILL — net-of-cost (surrogate clean) | trailing-best beats random next window only **50.7%**; OOS net −0.0041/bar |
| **WF-B** | Adaptive WF on majors (Bollinger/Donchian/MA-cross) | adaptive | majors daily | 27 | KILL — **surrogate** | real 0.0050 ≤ surrogate 0.0085, placeboP=0.59 (optimization artifact) |
| **WF-C** | Adaptive WF on 15m BTC | adaptive | BTC 15m, 306k bars | meta-grid | KILL — **surrogate (decisive)** | real **−0.063** vs phase +0.129 / block +0.132; 80 surrogates beat real, placeboP=0.63 |
| **WF-D** | Adaptivity ON THE REAL EDGE (carry threshold) | adaptive-carry | funding, 3y | meta-grid | KILL — edge-vs-RF (oracle ceiling) | tracks perfectly (autocorr 0.97) but **oracle only +0.53%/yr** left to harvest |
| **R2** | Illiquid corners / small-caps | prediction | 20 non-top-20 names, Binance 6y, real small-cap cost | 1640 | KILL — **surrogate** | champion (CS-mom 7d, search Sharpe 0.738) **worse than noise** (surr mean 1.59 / max 3.14, placeboP=0.90); holdout **−58.5%** |
| **R3** | GA evolves trading RULES (genetic programming) | prediction | 6 majors, daily perp closes, 3y | 5613 | KILL — **surrogate (placeboP=1.000)** | train +0.088 → holdout **−0.097**; GA on pure noise beats real champion (mean +0.032, max +0.110) |
| **R4** | GA on STRUCTURAL+technical carry rules | structural | funding/premium/basis primitives, 3y | 2823 | KILL — edge-vs-RF + surrogate | in-sample +3.15%/yr → holdout **−0.015%/yr** (collapses to flat RF); oracle ceiling **+0.51%/yr**; placeboP=0.721 |
| **C1** | Capital rotation as lead-lag flow ("ride the relay") | rotation | 43-coin tiered panel + volume, 6y | 108 | KILL — **surrogate (cross-sectional shuffle)** | holdout **−39.9%**; PBO **96.4%**; lead-lag reproduced by x-shuffle (p_LL=1.000) |
| **C2** | Dominance cycle (is there a rotation PERIOD?) | rotation | 30 coins, weekly, 6y | 16 | KILL — Deflated Sharpe | dominance is persistent not cyclic; vault **−52.7%** (Sharpe −1.53), placeboP=1.000 |
| **C3** | Joint market-state / breadth overlay | rotation | 30-coin panel + volume, 6y | 32 | KILL — baselines (loses to linear) | holdout **−19.56%**; ties equal-weight; the residual timing edge is *aggregate vol*, not breadth |
| **C4** | Event / listing forced-flow | event | 641 real Binance listing events (incl. delisted), 2019–2026 | 32 | KILL — **surrogate** | real "listing dump" (CAR −5.3% by day 20) but block-boot reproduces 72%; holdout short **−100% compound** |
| **OC1** | On-chain distribution-pressure overlay (exchange-flow + MVRV) | on-chain / flow | Coin Metrics Community exchange in/out flow (native units) + MVRV, BTC+ETH daily ~3,948 bars | 36 | KILL — **baselines** + **surrogate (placeboP=0.482)** | long/flat overlay loses to B&H + random-lottery + equal-weight; phase/block surrogates reproduce the "edge" ~48% of the time; holdout flat (Sharpe 0.003) |
| **NF1** | Support/resistance & price levels (pivots, swing H/L, round #s, Fibonacci, Bollinger) | TA / price-action | BTC 15m + 8 majors daily OHLC | 168 | KILL — **surrogate (placeboP=0.609)** | every winner is a *breakout riding trend*; destroy the levels (phase/block/x-shuffle) and the edge is unchanged — levels are decoration on filtered beta |
| **NF2** | Target + Stop-Loss / professional brackets (path-dependent, intrabar TP/SL) | exit management | BTC 15m HIGH/LOW path + majors daily OHLC | 25 | KILL — **net-of-cost (0/47 pass)** | TP/SL **reshapes** the P&L distribution (win-rate 33→65%, skew −0.64→+2.22) but does **not** move expectancy (~0); bracketed real ≈ bracketed noise |
| **NF3** | Confluence of rare pre-registered signals (≥k of 6 agree) | confluence / low-N | funding + basis + price + cross-section, BTC daily | 8 | KILL — baselines (loses to random-lottery) | pre-registration genuinely lowers the bar (expMaxSharpe 0.049) but **no k is both rare AND edgeful**; holdout **−0.090** |
| **NA** | Monthly options-expiry / "max-pain pin" | calendar / event | BTC 15m→4h + derived expiry calendar | 12 | KILL — baselines (loses to buy-and-hold) | the "max-pain pin / pre-expiry dump" is **folklore**: the real pre-weak/post-strong drift is just long-BTC beta; surrogate p=0.77; holdout **−0.010** |
| **NB** | On-chain valuation suite (exchange-reserve trend, active-address momentum, NVT) | on-chain / valuation | Coin Metrics Community, BTC+ETH daily | 192 | KILL — baselines | on-chain valuation is **coincident, not predictive**; vol-targeting just parks you in cash (mean exposure 0.22); loses to B&H + equal-weight + random-lottery |
| **NC** | Cross-asset macro regime (BTC vs DXY/gold/SPX risk-on/off) | macro / regime | stooq free macro + BTC daily | 90 | KILL — Deflated Sharpe (PBO 0.964) | macro conditioning is **coincident beta** — BTC/SPX/$ share the same global risk tape; the small bump is de-risking, not timing |
| **ND** | Intraday/weekly calendar (weekend, day-of-week, sessions) | seasonality / calendar | BTC 15m, 306k bars, 8.75y | 28 | KILL — Deflated Sharpe | no calendar edge — a data-mining mirage like T6; best **+447% in-sample → negative holdout**; surrogate p=0.752 |
| **—** | BTC-15m direction (retired legacy GA target) | prediction | BTC 15m | 659 evals | KILL (retired as an alpha generator) | best **+2.2%** < luck-of-N expectation **+11.76%**; mean negative |

**\*** The two survivors are **structural carry**, not prediction. Both passed the full
anti-overfitting gauntlet on the 3-year full sample, but both have **decayed below the
risk-free rate** in the current regime — see **§4**. A dash (`—`) in *Honest N* means the
hypothesis was a single pre-specified rule (no config grid searched), so deflation is by
construction; the holdout still governs the verdict.

**Canonical totals: 35 hypotheses tested · 33 KILL · 2 sub-risk-free carry survivors (both
sub-RF now).** This is the project's authoritative tally (lab log, 28th-test entry). The 2
survivors are **E2** (perp funding carry) and **T8** (dated-futures basis). The 33 kills
are every other entry in the table — the prediction / TA / rotation / event / adaptive /
on-chain hypotheses (E1, E3, T1–T7, T9, T10, TA1–TA4, WF-A–D, R2–R4, C1–C4, **OC1**)
together with the **retired legacy BTC-15m direction target**, which is counted among the
kills as the program's origin point (it is what the whole search replaced).

> **Note on the count.** The master table lists every distinct identifier the program
> touched, so a reader can audit each one independently. Counting the two carry survivors
> (E2, T8) inside their E/T ranges and the retired legacy target as one kill, the program
> total is **35 hypotheses: 33 KILL + 2 survivors.** (The Round-1–4 synthesis,
> `docs/EDGE_SEARCH_SYNTHESIS.md`, reports the running total of 23 at the end of Round 4;
> Rounds 5–6 added R2–R4 and C1–C4 to reach 27, and the 28th-test on-chain
> distribution-pressure POC (**OC1**) added the 28th = the 26th KILL.)

---

## 2. Reading the gates (how a "KILL" is decided)

Every hypothesis runs through the same fixed-order gauntlet (documented in
`docs/VALIDATION_HARNESS.md`). The **first failing gate is the binding gate** reported
above. Cheap economic gates run first so a gross-only or baseline-losing signal dies
immediately:

1. **`net_of_cost`** — positive *net* of realistic cost (taker ≈ 4 bps/side perp ⇒ 8 bps
   round-trip, charged on every position change). A gross-only signal is an automatic KILL.
2. **`baselines`** — must beat buy-and-hold + equal-weight + random-lottery + a one-layer
   linear model, net of cost.
3. **`deflated_sharpe`** — Deflated Sharpe probability ≥ 0.95 **at the honest `N`** (the
   true number of distinct configs, not 1, not a per-family length).
4. **`cpcv_pbo`** — Probability of Backtest Overfitting < 0.5 over combinatorial splits.
5. **`haircut`** — Sharpe survives the Harvey-Liu multiple-testing haircut.
6. **`surrogate`** — real edge beats a phase-randomized + block-bootstrap (+ cross-sectional
   shuffle, for rotation/lead-lag) null. *The methodological hero (§5).*
7. **`holdout`** — out-of-sample slice scored **exactly once** (consume-once vault).

> **Change the target, never the gates.** An empty parent pool under this gauntlet means
> the target lacks edge net of cost — not that the gauntlet is too strict.

---

## 3. Narrative — by round and theme

The program ran in six rounds over a single intensive cycle (lab log entries dated
2026-05-31), plus a follow-up on-chain POC (Round 7 below, the 28th test). Each round
attacked a distinct economic prior. The recurring structure of
each kill — *pretty in-sample Sharpe → passes the selection gates → dies at baselines +
consume-once holdout* — is summarized in §5.

### Round 0 — Origin: the retired GA alpha engine (a rigorous TRUE NEGATIVE)

**Why this matters.** Before any of the hypothesis tests above, the project was a different
thing entirely: a **genetic-algorithm engine evolving populations of neural "DNAs"** to predict
**BTC 15-minute direction**. The pivot away from that engine — to the theory-first,
hypothesis-by-hypothesis gauntlet documented here — was not a whim; it was forced by a clean,
quantified negative result. That negative is the program's **origin point**, and it strengthens
the negative-results story rather than detracting from it.

**The conclusion (preserved).** An honest population audit
(`scripts/audit-population-significance.ts`) returned the verdict **does not survive**: across
**659 evaluations**, the best single DNA returned **+2.2%**, which is *weaker* than the
**+11.76% expected-max** of that many pure-noise strategies (the luck-of-N benchmark — the best
of 659 random strategies is *expected* to look better than +2.2% by selection alone), and the
population **mean was negative**. In other words, the GA's best result is what you would get —
and worse than what you would expect to get — by drawing 659 random strategies and keeping the
luckiest. That is a textbook **true negative**: the engine did not find edge, and we can show it
did not find edge. The realistic probability of single-pair 15-minute direction prediction
becoming a profitable method was estimated at ~1–2% (effectively zero; an earlier legacy C#
attempt at the same target had also failed).

**What it triggered.** This true negative is exactly what motivated the **pivot to theory-first
hypothesis testing** — *change the target, never the gates* — and the construction of the
committed anti-overfitting harness that then killed 25 further hypotheses (and now 29, with
OC1). The GA-over-neural-DNAs engine itself is **retired as an alpha generator**; its source is
**preserved/archived in the repository for provenance, not maintained or recommended for use**.
The durable win was never the engine — it was retiring a dead target and keeping the rigor.
*(Log: 2026-05-31 "Strategic Decision" entry. The later Round-5 R3 result independently confirms
the same lesson from the other direction: a genetic program *is* the definitive overfitter, and
the surrogate control catches it every time.)*

### Round 1 — Theory-first reorientation (E1–E3) and the wide battery (T1–T10)

Three theory-first experiments (no ML), on real free-API data, through the committed
gates + a one-shot consume-once holdout.

- **E1 — cross-section weekly momentum** (Jegadeesh–Titman). The pretty in-sample result
  is a survivorship + long-bull artifact. **KILL:** holdout 2024–2026 **−9.59% net**, DSR
  0.041, MinBTL fails, haircut 0, loses to random-lottery. *(`output/funding/*`.)*
- **E3 — BTC time-series trend** (daily/weekly). The large returns are simply long
  exposure to the bull (buy-and-hold with less drawdown). Deflated by the true N=36:
  **DSR 0.886 (daily) / 0.593 (weekly) < 0.95**. Daily does not beat B&H on the holdout;
  weekly beats on the holdout (+38.5% vs +11.1%) but fails baselines + DSR in-sample. **KILL.**
- **E2 — perp funding carry** (delta-neutral, structural — not prediction). **The one
  survivor of Round 1.** A continuously-held diversified book over the 8 majors: gross
  ~7.55% APR, **net ~5.84% APR** (16 bps round-trip), vol ~0.37%, max drawdown 5.37%, all
  8 legs net-positive; survives a 50% decay haircut (2.88% APR); post-2024 holdout still
  positive (+0.91% APR — funding had already compressed). The **dominant risk is
  counterparty / venue (FTX-style), not the funding signal**: survives a counterparty gap
  up to ~50% of notional, dies at ~75%. **PROMOTE (modest, with caveats).** Round 2 then
  re-examined it under real operating frictions (§4).

The wide battery (T1–T10) then stress-tested every remaining standard academic prior.
**9 of 10 are KILL** (all prediction / trend / relative-value): T1 reversal (holdout −32%),
T2 market-neutral CS-momentum + vol-target (fixed E1's long-only artifact — +27.9% vs
universe −51.6% — but DSR(N=4) loses to random-lottery), T3 vol-target BTC (holdout net
−11%), T4 diversified TSMOM (holdout −18%, gross only +2.8%/2y), T5 regime-gated trend
(holdout +1.3% vs B&H +15.3%), T6 seasonality (holdout −32%, a data-mining trap), T7
funding-as-contrarian (dead in-sample, holdout APR −28%), T9 ETH/BTC relative value
(holdout −48%), T10 cointegration pairs (gross +52.8% but path-fragile, **DSR(N=420)=0.029**,
MinBTL fails).

- **T8 — dated-futures basis / cash-and-carry** (Binance quarterly delivery). **The second
  survivor.** Holdout per-contract **net APR +14.6% → +7.31%** after a 50% decay haircut,
  cross-contract Sharpe 9.17, max drawdown at delivery 0.00%, robust to costs of 28–80 bps,
  DSR(N=30)=1.0, and a no-hallucination check passes (a null with no convergence yields
  −0.22% vs real +2.1%, p≈0.000). Basis is locked at entry and converges to zero at
  delivery — a structurally clean limits-to-arbitrage premium.

**Round-1 conclusion (13 hypotheses: E1–E3 + T1–T10):** 11 prediction strategies dead;
the only 2 survivors (E2 funding carry, T8 dated basis) are **both structural carry**
(cash-and-carry / basis convergence = a limits-to-arbitrage premium, BIS WP 1087). The
edge that survives cost in crypto is **basis/carry, not prediction.**

### Round 2 — Carry, examined honestly (D1–D4): a regime trade, not a business

Four parallel deep-dives on the survivors, all on real public data (Binance reuse +
fresh Bybit/OKX REST, live depth, open interest), cloud $0. *(`scripts/carry/*`,
`output/carry/*`.)*

- **D1 — multi-venue surface + cross-venue dispersion.** Gross 3y funding (Binance/Bybit):
  BTC 7.4/7.8%, ETH 7.7/7.8%, XRP 7.6/9.1%, DOGE 8.2/9.5%, SOL 5.3/6.8%, and **BNB is
  NEGATIVE** (−2.2/−0.04% — short-carry would *lose*). **Cross-venue dispersion arbitrage
  is a mirage at taker cost:** Binance↔Bybit funding is 0.66–0.87 correlated; the spread
  is 0.4–0.9 bps vs a 10–19 bps round-trip cost, so a cost-aware policy fires **0–2× in 3
  years ≈ 0%/yr**. *(`output/carry/d1-report.json`.)*
- **D2 — full cost/capital model.** The key insight: funding is earned on the short
  *notional*, but you immobilize ~1.5–2× the notional (margin + survival buffer), so
  gross-on-capital is roughly half. Monthly-roll fees (~3.4%/yr of notional) ≈ *all* of
  current funding. Trailing-12-month funding has collapsed to **3.2–3.5% — below the 4.5%
  risk-free.** Incremental edge over T-bills is **negative at every tier**:
  **−$28/mo @ $10k, −$276/mo @ $100k, −$2,822/mo @ $1M** (and across all 40 sensitivity
  cells). **Minimum viable capital: none up to $5M.** Break-even needs funding ≈ 8.4–9.8% —
  only seen at the 2024 peak. *(`output/carry/d2_full_cost_model.json`,
  `output/carry/d2_sensitivity.json`.)*
- **D3 — tail / survival risk.** Risk is gap-dominated (an FTX-style venue failure), not
  signal: the worst real negative-funding regime is a shallow 16-day / −1.49% cumulative
  bleed, and liquidation is manageable on core majors at 3×. Multi-venue does **not** lower
  the *expected* gap loss (it is linear) but cuts the **tail**: P(ruin) **2%/yr (1 venue) →
  0.032%/yr (4 venues)**. Using the *non-decayed* 5.84% headline, post-survival edge is
  +0.82%/yr; **stack the 50% decay haircut and the edge goes negative.**
  *(`output/carry/d3/d3-tail-survival-results.json`.)*
- **D4 — capacity + decay.** **Decay is severe and real:** equal-weight 8-major gross
  funding APR went **2023H2 6.53% → 2024 10.99% (the one-off bull blowout) → 2025 2.55% →
  2026 YTD −0.05%**. The forward (trailing-12m BTC+ETH) gross is ~**3.35%** — below the
  risk-free in every cadence. Capacity is ample ($440–518M @ 2% of OI) but irrelevant —
  there is no edge to scale. **US persons are geo-blocked** from the deep venues, making
  the economics strictly worse. *(`output/carry/capacity-decay-report.{txt,json}`.)*

**Round-2 verdict (honest):** the "+6–7% APR" headline was true for the *full 3-year
sample* dominated by the now-fully-reverted 2024 funding blowout. **In today's regime
carry does not beat the risk-free rate** at any tier after fees + capital efficiency +
buffer; incremental edge vs T-bills ≈ **−2% to −3.3%/yr**. **Carry is a regime trade**
(turn it on only when funding is rich, >~8–9%, and rising, as in 2024) — **not an
always-on business.** Dated basis is structurally cleaner (~7% historical, basis locked
at entry) but also compresses, is quarterly-lumpy, and carries the same counterparty tail.

### Round 3 — Technical analysis / indicators (TA1–TA4): ~411 variants, 4/4 KILL

The user's prior was that classic indicators could improve the decision. Four
economically distinct angles, all through the committed gates, realistic cost on every
trade. *(`scripts/ta-research/*`, `output/ta-research/*`.)*

- **TA1 — indicators to TIME the carry (ON/OFF).** 69 causal gating rules (funding
  level/momentum, perp-spot premium, basis slope). In-sample, the honest winner
  *genuinely* beats always-on and RF and passes DSR (p=5.8e-7, N=69), PBO 0.075, all
  baselines and the haircut — it really does dodge the bad months. **KILL by the holdout:**
  in 2025-10..2026-05 the gate sits **100% OFF and ties RF** (0% excess). The decisive
  proof is the **oracle bound**: a gate with *perfect foresight* earns only **+0.52%/yr**
  over RF on the holdout, because realized funding there is ≈0.36%/yr. **The structural
  edge decayed below the cost of harvesting it** — not even a clairvoyant timer extracts
  edge now; the only out-of-sample "gain" from timing is *not trading*.
- **TA2 — slow vol-targeted TSMOM** (Moskowitz–Ooi–Pedersen, the best academic prior).
  30-coin panel, monthly rebalance, N=24. In-sample net Sharpe 1.20; **out-of-sample vault
  −0.076** (−4.74%). The 12-month lookback (the "slowest", best in TradFi) is the *worst*
  in crypto (2021–22 whipsaw). Turnover is low, so this did not die from cost — trend
  autocorrelation simply does not persist out-of-sample. **KILL.**
- **TA3 — microstructure / forced-flow on 15m BTC** (306k bars, 8.75y) + funding/OI. 224
  variants (4 families × grid × 15m/30m/1h/4h). **Cost annihilates every 15m/30m variant**
  (net-negative). Only the lowest-frequency (4h vol-breakout) survives cost (net Sharpe
  1.30), but it dies at **DSR (N=224, p=0.21)** + holdout (−0.98, edge inverts) + Bonferroni
  (adjP=0.28). A technical signal is a gross-only mirage. **KILL.**
- **TA4 — classic indicators, definitive** (RSI, MACD, Bollinger, MA-cross, ADX, Donchian,
  Stochastic), 8 majors daily, N=94. **0 of 94 configs beat buy-and-hold** on net daily
  mean return. The best (Bollinger breakout) passes DSR (p=0.00025), PBO (0.00) and the
  haircut — but those gates only certify *"this Sharpe is not luck-of-selection."* It then
  **dies at the two gates that test real edge**: baselines (loses to B&H, random-lottery,
  and linear) and the holdout (flips to net Sharpe **−1.01**). Every top config is
  long/flat — the "edge" is filtered long-beta in a bull, not timing skill. **KILL.**

### Round 4 — Adaptive walk-forward (WF-A–D): the user's premise was *partly right*

The user's sophisticated hypothesis: the market is non-stationary ⇒ the optimal indicator
config *drifts* ⇒ a fixed parameter decays ⇒ you must **adapt** (re-optimize on a rolling
walk-forward). Tested with maximal rigor: strict causality (param chosen only with data
< t, trades the next slice, rolls), four honest benchmarks (buy-and-hold,
param-frozen-at-first-window, random-param-WF, and a **surrogate/placebo**), cost on every
switch, honest N = the meta-parameter grid, consume-once holdout. *(`scripts/walkforward/*`,
`output/walkforward/*`.)*

- **WF-A — direct premise** (daily, 5 families). The optimal param *is* persistent
  (autocorr lag1 = 0.57, stickiness 0.70) — it does not jump randomly. **But the
  persistence test kills it:** trailing-best beats a *random* param next window only
  **50.7%** of the time (a coin flip; OOS net −0.0041/bar). The objective surface is
  **flat** — "best" is statistically indistinguishable from "arbitrary" in the future.
  The **surrogate is clean** (real −0.10 is *worse* than typical noise, placeboP=0.81) —
  the machine does not invent edge in noise, so this failure is genuine.
- **WF-B — adaptive WF on majors** (Bollinger/Donchian/MA-cross, N=27). Here the param does
  *not* drift trackably (autocorr ~0.035, 44% churn ≈ noise). Adaptive ≈ fixed (−33.4% vs
  −35.9%) but pays **+43% more cost** to adapt and gains nothing. **The surrogate FAILS:**
  the same machine scores **equal-or-better in noise** (real 0.0050 vs surrogate 0.0085,
  placeboP=0.59) ⇒ the "edge" is an optimization artifact.
- **WF-C — adaptive WF on 15m BTC** (306k bars). The premise is confirmed *more* strongly
  (autocorr lag1 0.39–0.64). But adaptive net **−0.063** loses to B&H +0.376 and to fixed
  +0.265. **The surrogate is decisive:** 80 surrogates (phase-randomized + block-bootstrap,
  which preserve vol/autocorrelation but destroy regime) score *higher* than the real run
  (phase mean +0.129, block +0.132 vs real −0.063); placeboP=0.63 (the real run sits at the
  37th percentile of its *own* noise).
- **WF-D — adaptivity on the ONE real edge** (auto-calibrating carry threshold, rolling
  quantile). The premise is *perfect* (regime autocorr 0.97, calibrates beautifully). But
  adaptive +1.41%/yr does not beat the risk-free (−3.09%/yr) and even *loses* to the fixed
  threshold (−1.49%/yr, having paid 3 extra toggles). **Surrogate fails** (placeboP=0.19).
  Structural cause: the perfect-foresight oracle yields only **+0.53%/yr** over RF in this
  regime — adaptivity tracks a real edge but **cannot create carry the market already shed.**

**Round-4 lesson (the project's most instructive):** the user is *right* that the optimal
config drifts (confirmed in 4/4: autocorr 0.39–0.97). But adapting fails for two distinct
reasons: (1) for **TA/price**, the drift is real but *not predictive* — the surface is flat
(trailing-best = random at 50.7% OOS) and the surrogate proves the adaptive machine
manufactures "edge" in pure noise as well as in real data (fitting noise, not tracking
regime); (2) for **carry**, the drift *is* predictive and auto-calibrates (autocorr 0.97),
but there is nothing left to harvest (oracle +0.53%/yr < cost). **Adaptivity tracks an edge
that exists; it does not manufacture one that vanished.**

### Round 5 — Illiquid corners + GA-evolved rules (R2, R3, R4): 3/3 KILL, surrogate decisive again

Three search fronts, all on real data, cloud $0. *(`scripts/{r2-illiquid,front-r3,front-r4}/`,
`output/{r2-illiquid,front-r3,front-r4}/`.)*

- **R2 — illiquid corners / small-caps.** 20 names outside the top-20 (Binance REST, 6y),
  with realistic small-cap cost (median spread **6.93 bps** + depth-based slippage). **KILL
  by the SURROGATE (decisive):** the real champion (CS-momentum 7d, search Sharpe **0.738**)
  is *worse than noise* — surrogates yield mean **1.59** / max **3.14**, **placeboP=0.90**
  (36/40 surrogates ≥ real). It also fails DSR (0.015), holdout (**−58.5%**), all baselines,
  and the haircut. Capacity ceiling ~**$108k**. Survivorship inflates this (only coins alive
  today are in the panel), so it is an *upper bound* — and even so it is a KILL, at both
  $5k and $25k sizes (monthly net **−$74 @ $5k**, **−$488 @ $25k**).
- **R3 — GA that EVOLVES trading RULES** (real genetic programming: population 160, tournament
  selection, subtree/condition crossover, multi-mode mutation, elitism, 40 generations; genome
  = AND/OR conjunction of (indicator, comparator, threshold) → position). **KILL, surrogate
  placeboP=1.000** — a GA run on *pure noise* (phase-rand + block-bootstrap) finds champions
  that are *better* out-of-sample (mean +0.032, max +0.110) than the real champion (−0.097).
  Honest N = **5613 unique genomes** ⇒ DSR ≈ 9e-12. The real champion collapses train +0.088 →
  holdout **−0.097** (a textbook overfit collapse), robust across 4 seeds. **The GA is the
  definitive overfitter; without the surrogate control it would have *looked like* an in-sample
  win.**
- **R4 — GA on STRUCTURAL + technical rules** (same machine + funding/premium/basis-slope
  primitives). **KILL** — the GA found a purely structural rule that is beautiful in-sample
  (**+3.15%/yr** over RF, 28% deployed) but **collapses to 0% deployed (flat RF) on the
  holdout** (**−0.015%/yr**). The perfect-foresight holdout oracle = **+0.51%/yr** (confirming
  WF-D's ceiling). Surrogate placeboP=0.721, DSR p≈1.0 (N=2823). An evolutionary search
  *confirms* the hand-made conclusion: there is no structural decision rule to operate in the
  current regime.

**Round-5 lesson:** giving an evolutionary search (the definitive overfitting machine) both
technical (R3) and structural (R4) primitives does **not** produce edge — the surrogate
control catches the self-deception every time (the GA scores equal-or-better in pure noise).

### Round 6 — Capital rotation / cycles + event flow (C1–C4): 4/4 KILL

The user's hypothesis: the market is a single pool of volume that *circulates* among
assets/tiers in *cycles*, and looking at many assets *together* would reveal exploitable
cycles. Also requested: test event/listing flow. Five fronts, real data (fresh Binance
public volume), cloud $0. *(`scripts/{c1-rotation,front-c2,front-c3,front-c4,validation}/`.)*

- **C1 — rotation as lead-lag flow** ("ride the relay" of conserved volume circulating
  between tiers). **KILL.** N=108, DSR deflatedP=0.45, **PBO 96.4%** (severe overfit),
  holdout **−39.9%**. Surrogate: in-sample net Sharpe 1.076, but the phase-surrogate q95 is
  1.138 (p=0.080, not significant) and the lead-lag statistic is *reproduced* by the
  cross-sectional shuffle (p_LL=1.000) — the "lead-lag" is an artifact, not real capital
  rotation. *(`output/c1-rotation/rotation-report.json`.)*
- **C2 — dominance cycle** (is there a rotation *period*?). **KILL.** Dominance is
  *persistent, not cyclic* (acf1=0.55, stay-rate 68%, 32%/week switch). The 14-week spectral
  peak is reproduced by phase/block surrogates (cycle = autocorrelated noise). The strategy:
  in-sample Sharpe 1.14 → **vault −1.53 (−52.7%)**, surrogate placeboP=1.000. The
  volume-dominance variant is degenerate (majors win 93% ⇒ it is buy-and-hold-majors). The
  apparent "rotation edge" is single-asset momentum (Jegadeesh–Titman at short K), not tier
  rotation. *(`output/front-c2/dominance-cycle-result.json`.)*
- **C3 — joint market-state / breadth overlay.** **KILL.** The joint view *carries real
  descriptive information* (dispersion/correlation predict forward vol — "correlation→1 in
  risk-off" is real), but it does not become a tradeable overlay: it ties equal-weight on the
  test, loses on the holdout (**−19.56%**), loses to a trivial linear model, DSR 0.89, PBO
  0.90. **The cross-sectional shuffle (placeboP=0.244, not significant) proves the residual
  timing edge is *aggregate vol state*, NOT breadth/rotation** — the multi-asset view adds
  nothing an aggregate vol series would not. *(`output/front-c3/c3-report.json`.)*
- **C4 — event / listing forced-flow** (token unlocks have no free data, so listing was used
  as a tractable proxy: 641 real events via onboardDate, including delisted names = no
  survivorship at the event). **KILL.** There is a real descriptive "listing dump" (CAR
  **−5.3% by day 20**, individual days significant), but it is not tradeable: block-bootstrap
  reproduces 72% of the "edge", DSR(N=32)=0.77, and the consume-once holdout (the 2025–26
  cohort) *pumped* — so shorting it returned **−100% compound**. *(`output/front-c4/listing-event-result.json`.)*
- **C5 — methodology + references (delivered, not a hypothesis).** The reusable harness
  `src/lib/validation/strategy-validator.ts` → `validateStrategy(returns | fn, opts)`
  composes the 7 committed gates into one `{ verdict, bindingGate, perGate }`. The smoke-run
  `scripts/validation/demo-validate.ts` (exit 0) kills a noise series *and* the real carry
  series (sub-RF today, which is the honest, expected outcome; the surrogate independently
  flags it at placeboP≈0.67). Documented in `docs/VALIDATION_HARNESS.md`; the full academic
  bibliography is in `docs/EDGE_SEARCH_SYNTHESIS.md`.

**Round-6 lesson:** once again the user's intuition has a *true descriptive kernel*
(rotation/persistence exists; the joint view carries vol regime; the listing-dump is real) —
but none of it is exploitable, cost-surviving, out-of-sample edge. The cross-sectional
shuffle (this round's new null) is decisive: it proves the "rotation edge" is single-asset
momentum + aggregate vol state, not cross-tier capital circulation.

### Round 7 — On-chain distribution-pressure (OC1): the only genuinely new data class, also a KILL

The on-chain feasibility scout (`docs/ONCHAIN_FEASIBILITY.md`) had established that a rigorous
on-chain edge test is **fully fundable at $0** (Coin Metrics Community + DefiLlama, no paid
keys) and recommended exactly one shot: a **BTC+ETH exchange-net-flow + MVRV "distribution-pressure"
overlay**. That POC was run through the committed `validateStrategy` harness as the program's
**28th hypothesis** (OC1). *(`scripts/onchain-poc/`; `output/onchain-poc/verdict.json`.)*

- **OC1 — on-chain distribution-pressure overlay.** Features: exchange in/out flow in **native
  units** (CM `FlowInExNtv − FlowOutExNtv`, native to avoid the USD-denomination tautology) +
  **MVRV** cost-basis (`CapMVRVCur`), long/flat vol-targeted spot on BTC+ETH, ~3,948 daily bars.
  **Look-ahead was controlled**: features are lagged ≥1 day (z-score and MVRV read at *d=t−1*;
  vol-target uses past returns only), and Coin Metrics' revision (`flash`/`reviewed`) flags were
  quantified (BTC 8,336 flash; ETH 2,924 flash + 4,992 reviewed) — proof the series is **not**
  point-in-time, which is exactly why the lag is mandatory. **Honest N = 36** (2 assets × 3
  lookbacks × 3 MVRV thresholds × 2 agreement rules). **KILL.** The **binding gate is baselines**
  (the long/flat overlay loses to buy-and-hold, random-lottery, *and* equal-weight — it forfeits
  beta in a sample that rose), and the **surrogate also fails** (**placeboP=0.482**, `crossSectional:
  false`: phase-randomized + block-bootstrap of the *same* BTC/ETH trajectories reproduce the
  "edge" ~48% of the time, so the on-chain feature's timing carries no information beyond each
  asset's drift + autocorrelation). DSR *passed* (0.96 at N=36) but is not the decisive gate, and
  the consume-once holdout was flat (Sharpe 0.003). *(Note: the PBO gate here ran on self-derived
  folds and is **not** load-bearing — this is an internal-review finding (H5).)*

**Round-7 lesson (and the honest framing):** KILL was the explicit prior — on-chain
NVT/MVRV/SOPR/active-address/flow metrics are heavily published and arbitraged, and this data
class most resembles the rotation tests (C1, C2) that both died on the surrogate. The POC simply
**closed the gap on the only genuinely new data source** (on-chain / flow) with real evidence,
under the same rigor, without manufacturing a survivor. The frontier is now tested, not just
scouted.

### Round 8 — Trader-style forms (NF1–NF3): support/resistance, target+stop-loss, low-N confluence — 3/3 KILL

Three trade *forms* categorically different from the indicator strategies above — level-based
discretionary techniques, path-dependent exit management, and rare-signal confluence — each forcing
an explicit methodological upgrade to stay honest. Full reflection in
`docs/TRADER_FORMS_REFLECTION.md`. *(`scripts/{nf1,nf2-brackets,nf3-confluence}/`.)*

- **NF1 — Support/Resistance & price levels** (floor pivots, swing H/L, round numbers, Fibonacci,
  Bollinger edges × bounce/breakout/retest, N=168). **KILL by the surrogate (placeboP=0.609).**
  Floor-trader pivots are flat-to-negative net of cost; only *breakout* variants "work," and they
  just ride trend. Destroying the level structure (phase/block/cross-sectional shuffle) leaves the
  edge unchanged — the levels are decoration on filtered beta, the same failure as the classic
  indicators in TA4.
- **NF2 — Target + Stop-Loss / professional brackets** (path-dependent, intrabar TP/SL on the real
  HIGH/LOW path, N=25). **KILL by net-of-cost (0/47 configs pass).** The decisive question — does
  TP/SL *create* edge or *reshape* the distribution? — resolves cleanly: bracketing swings the
  win-rate 33%→65% and per-trade skew −0.64→+2.22 while **gross expectancy stays ≈0**. Bracketed
  real (−0.0795 Sharpe/trade) ≈ bracketed noise (GBM −0.0948, phase −0.0906). This is the
  *fair-game / optional-stopping theorem* made operational: **"risk management" manages variance, it
  does not manufacture edge — only the entry signal's edge matters,** and the entry was itself
  indistinguishable from the surrogate null.
- **NF3 — Confluence of rare pre-registered signals** (6 economically-motivated signals, act when
  ≥k agree, N=8). **KILL by baselines (loses to random-lottery).** The honest nuance: pre-registration
  *genuinely* lowers the deflation bar (N=8 ⇒ expected-max Sharpe only 0.049 — the intuition is
  statistically correct), but **there is no threshold k that is simultaneously rare AND edgeful** —
  loosen it (k=3) and it fires 735/1082 days = a long-biased trend filter beaten by the
  random-lottery; tighten it (k=6) and it fires twice. The small honest N helps the statistics; it
  cannot manufacture an edge that is not there.

**Round-8 lesson:** each form forced a methodological upgrade (path-dependent exits need a per-trade
P&L series + a bracket-on-surrogate null; low-N confluence needs genuine pre-registration so N stays
small; discretionary levels need the level-construction counted in N) — and each KILL is one more
falsified trader-favorite technique. The deepest, now-operational result: **stop-loss / take-profit
is variance management, not alpha.**

### Round 9 — Four more popular beliefs (NA–ND): expiry pins, on-chain valuation, macro regime, calendar — 4/4 KILL

Four widely-held retail beliefs, each fundable at $0, run through the gauntlet. All KILL — and
three of the four die the *same* way: a real descriptive pattern that is just **long-BTC beta in
disguise**, losing to buy-and-hold once costed. *(`scripts/{options-expiry,onchain-nb,nc,track-nd}/`.)*

- **NA — Monthly options-expiry / "max-pain pin"** (N=12). The folklore *looks* alive descriptively
  (BTC is weak into the last-Friday expiry, drifts up after), but **KILL by baselines**: the
  post-expiry "rally" is just being long BTC in a subset of a bull market — it loses to buy-and-hold
  and to a random-lottery of equal trade count, the surrogate places it at the 23rd percentile of
  its own null (p=0.77), and the holdout is negative. A cautionary tale: a claim-specific "expiry
  beats random windows" placebo returned **p=0.000** — it *would* have looked like a SURVIVE without
  the committed baselines + consume-once-holdout gates, which correctly expose it as beta.
  (Historical option OI-by-strike is not free, so the robust price-vs-calendar test is the
  falsifiable one.)
- **NB — On-chain valuation suite** (exchange-reserve trend, active-address momentum, NVT; N=192).
  **KILL by baselines.** Free on-chain valuation metrics are **coincident, not predictive**: scaling
  exposure to them lifts the Sharpe only because vol-targeting parks you in cash (mean exposure
  0.22), mechanically cutting drawdown while sacrificing more return than it saves. It loses to
  buy-and-hold, equal-weight, and a random-lottery of the same exposure; phase/block surrogates
  reproduce it. (Distinct features from the MVRV+flow OC1 test — same conclusion.)
- **NC — Cross-asset macro regime** (BTC vs DXY/gold/SPX risk-on/off; N=90). **KILL by Deflated
  Sharpe** (PBO 0.964, surrogate). Macro conditioning is **coincident beta**: BTC, equities, and the
  dollar all respond to the same global risk-on/off tape, so "risk-on ⇒ long BTC" mostly recovers
  long-BTC exposure with lower time-in-market. The small in-sample bump is de-risking (volatility
  reduction), not predictive timing, and it does not survive deflation.
- **ND — Intraday/weekly calendar** (weekend pump, day-of-week, Asia/EU/US sessions, turn-of-week;
  N=28). **KILL by Deflated Sharpe.** No real, cost-surviving, out-of-sample calendar edge — a
  seasonality data-mining mirage exactly like T6: the best rule is **+447% in-sample → negative
  Sharpe in the untouched holdout**, its temporal structure matched by phase/block surrogates
  (p=0.752).

**Round-9 lesson:** three of the four (NA, NB, NC) are the same trap — a *real* descriptive pattern
that is **long-BTC beta sampled part of the time**, which the baselines and Deflated-Sharpe gates
correctly unmask; the fourth (ND) is pure calendar data-mining. "Trade with the macro" and the
"max-pain pin" join the kill list as folklore, not edge.

---

## 4. The two survivors — real, but a regime trade, sub-RF now

Both survivors are **structural carry** (a limits-to-arbitrage premium, BIS WP 1087), not
prediction: **E2 perp funding carry** and **T8 dated-futures basis / cash-and-carry**.
Both pass the full anti-overfitting gauntlet on the 3-year full sample. **Neither beats
the risk-free rate in the current regime.**

| Survivor | Full-sample headline | Why it is sub-RF *now* | Oracle proof |
|---|---|---|---|
| **E2 — perp funding carry** | net ~**5.84% APR** (3y, 8 majors, all legs net-positive, max DD 5.37%) | trailing-12m gross collapsed to **~3.35%** < RF 4.5%; incremental edge vs T-bills **−2% to −3.3%/yr**; min viable capital none up to $5M | TA1 timing oracle (perfect foresight) earns only **+0.52%/yr**; realized funding ≈0.36%/yr |
| **T8 — dated-futures basis** | holdout net APR **+14.6% → +7.31%** post-50% haircut (cross-contract Sharpe 9.17, 0.00% DD at delivery) | also compresses; quarterly-lumpy; same counterparty tail; structurally cleaner but ~7% historical and falling | WF-D adaptive-carry oracle ceiling **+0.53%/yr**; R4 GA structural oracle **+0.51%/yr** |

**The deepest finding** is the oracle proof, which appears *three independent times*
(TA1, WF-D, R4): a gate or rule with **perfect foresight** earns only **+0.51–0.53%/yr**
over the risk-free rate in the current holdout, because realized carry there is ≈0.36%/yr.
**The structural edge has decayed below the cost of harvesting it — not even a clairvoyant
timer can extract it now.**

> **Verdict on carry.** It is a **regime trade** — arm it only when funding is rich
> (>~8–9%) and rising, as in 2024 — not an always-on business. For an indie at
> $10k–$100k today it does not beat the risk-free rate after fees + capital efficiency +
> buffer (incremental edge vs T-bills ≈ −2% to −3.3%/yr). US persons are also geo-blocked
> from the deep venues, making the economics strictly worse.

---

## 5. Patterns across all 35 tests

Two patterns recur so consistently they are the meta-findings of the program.

### Pattern A — the "two-gate" death

A signal produces a **pretty in-sample Sharpe** and *passes* DSR / PBO / Harvey-Liu
haircut. **Those gates only certify "this Sharpe is not luck-of-selection." They do not
test economic edge.** Every such candidate then **dies at the two gates that test real
edge**:

1. **Baselines** — beat buy-and-hold + equal-weight + random-lottery + a one-layer linear
   model, *net of cost*.
2. **Consume-once holdout** — performance on data the search never saw.

This killed TA1, TA3, TA4, T2, T10, R2, R3, R4, C1, C3, C4, and more. The canonical example
is **TA4**: its best Bollinger-breakout config passes DSR (p=0.00025), PBO (0.00) and the
haircut, then **loses to buy-and-hold, random-lottery, and linear**, and the holdout flips
to net Sharpe **−1.01**. The apparent "edge" is **filtered long-beta in a bull**, not timing
skill — every top config is long/flat. The honest `N` is what makes this work: deflating by
the *true* number of trials turned every "p<0.001" champion into noise (TA3 at N=224 → p=0.21;
T10 at N=420 → DSR 0.029; R3 at N=5613 → DSR ≈ 9e-12).

### Pattern B — the "true descriptive kernel, no tradeable edge" meta-finding

Round after round, the user's intuition contained a **genuinely true descriptive fact** —
and that fact still produced **no tradeable, cost-surviving, out-of-sample edge**:

- **Adaptive drift is real** (WF-A/B/C/D: optimal-config autocorr 0.39–0.97) — but for
  TA/price it is not *predictive* (flat surface, trailing-best = random at 50.7%), and the
  surrogate proves the adaptive machine fits noise as well as it "tracks regime."
- **Correlation→1 in risk-off is real** (C3: dispersion/correlation predict forward vol) —
  but the residual timing edge is *aggregate vol state*, not breadth, and the multi-asset
  view adds nothing a single aggregate series would not.
- **Dominance persistence is real** (C2) — but it is *persistent, not cyclic*; the spectral
  "cycle" is autocorrelated noise.
- **The listing dump is real** (C4: CAR −5.3% by day 20) — but block-bootstrap reproduces
  72% of it, and the next cohort pumped.

The **surrogate / placebo control is the hero** of both patterns. By preserving each
asset's volatility and autocorrelation while destroying genuine regime / cross-asset
structure (phase randomization, block bootstrap, and the cross-sectional shuffle for
rotation), it directly answers: *"Is this 'edge' just dispersion the machine would
manufacture in noise?"* When the answer is yes (WF-B, WF-C, R2, R3, C1, and the descriptive
kernels above), the candidate is an optimization artifact, full stop. Without this single
control, the in-sample WF-B/WF-C/R3 results would have looked like wins.

### The synthesis

**The edge is NOT in (a) direction prediction, (b) cross-section / relative value at
retail cost, (c) classic or microstructure TA, (d) timing the carry, (e) adaptively
re-fitting any of the above, (f) illiquid small-caps, (g) GA-evolved rules, or (h) capital
rotation / dominance cycles / breadth / event flow, or (i) on-chain / exchange-flow + MVRV
distribution-pressure overlays.** Twenty-six independent attempts — all the standard academic
priors, fixed and adaptive, plus the only genuinely new (on-chain) data class — all dead net
of realistic cost. The only thing that survived the gauntlet is **structural carry**, and it
has decayed below the risk-free rate in the current regime.

**The durable asset of this project is the methodology** — committed gates + surrogate /
placebo controls + honest trial-count `N` + a consume-once holdout — packaged as the
reusable `validateStrategy(...)` harness. A KILL is a valid, valuable outcome. The empty
parent pool is the gates working correctly, not a failure of effort. **Change the target,
never the gates.**

---

## Provenance and related documents

- **`docs/EVOLUTION_TRAINING_LOG.md`** — the raw chronological lab log (Portuguese), the
  source of truth for every number above (entries dated 2026-05-31, Rounds 1–6).
- **`docs/EDGE_SEARCH_SYNTHESIS.md`** — the durable synthesis + full academic bibliography
  (every gate and every hypothesis mapped to its peer-reviewed or working-paper source).
- **`docs/VALIDATION_HARNESS.md`** — the reusable anti-overfitting gauntlet, documented as
  one API (`src/lib/validation/strategy-validator.ts`).
- **Machine-readable outputs** — `output/{funding,carry,ta-research,walkforward,front-r3,front-r4,r2-illiquid,c1-rotation,front-c2,front-c3,front-c4,dated-futures,onchain-poc,validation}/`.

> **License: MIT** (see [`../LICENSE`](../LICENSE)). The repository is released under the MIT
> License, copyright Kim Lage.
