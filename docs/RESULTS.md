# RESULTS — the crypto edge-search ledger (canonical record)

> **What this is.** The single, canonical, English-language record of every hypothesis
> this project has put through its anti-overfitting gauntlet in a systematic, $0,
> reproducible search for a tradeable crypto edge. **~111 distinct hypotheses** have now
> been tested at full statistical rigor on free public market data (cloud/data spend
> **$0**), across three eras: (1) the **prior rounds** (~35: GA/TA/momentum/rotation/
> event/carry/on-chain POC), (2) the **2026-06 domain campaign** (~58 across eight
> domains), and (3) the **new $0 backlog** (18: quant/regime/vol + on-chain/price-action).
>
> **Final, audited verdict: 0 clean SURVIVE. 2 weak PROMISING. Everything else KILL.**
> Nothing is deployable. The two PROMISING leads are real *structures* that never crossed
> the PROMISING→SURVIVE boundary — i.e. their realized mean is **not** positive-with-
> significance at honest trial-count `N` on data the search never saw. Read their full
> caveats in §1 before quoting any number from them.
>
> **The durable asset is the methodology, not a strategy.** A committed, fixed-order
> gauntlet — net-of-cost, matched-exposure baselines, Deflated Sharpe at *honest* `N`,
> block-bootstrap CI, CPCV/PBO, the Harvey-Liu haircut, the *right* surrogate null
> (including a **family-wise MAX-statistic** for searched grids), and a consume-once
> holdout — refused to promote dozens of pretty in-sample Sharpes that would otherwise have
> read as wins. That refusal *is* the result. This is a falsification lab: we try to
> *break* every technique, and we publish what survives **and** what dies.
>
> **Honest framing.** This is a negative-results + rigorous-methodology contribution.
> Nothing here is "profitable" today. The two prior carry "survivors" are real but
> **sub-risk-free** in the current (2025–2026) regime; they are regime trades, not a
> business. Nothing here is investment advice.
>
> **Provenance.** Every number below traces to a machine-readable artifact under `output/`.
> The 2026-06 campaign roll-up is `docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md`; per-domain
> syntheses are `output/edgehunt-*/SUMMARY.md`; the two-layer audit that flipped three
> earlier PROMISINGs to KILL is `output/edgehunt-audit/SUMMARY.md` +
> `output/edgehunt-audit-nb/SUMMARY.md`; the adversarial-verification deepening is
> `output/edgehunt-deepen/SUMMARY.md`. The full backlog of hypotheses (with the right null
> and honest prior for each) is `docs/BACKLOG.md`; the raw chronological lab log (the
> Portuguese provenance for the prior rounds) is `docs/EVOLUTION_TRAINING_LOG.md`. The
> gauntlet rules are codified in `AGENTS.md`.
>
> **License: MIT.**

---

## 0. The headline, in one screen

| | Count | What it means |
|---|---:|---|
| **Hypotheses tested (all eras, all $0)** | **~111** | ~35 prior rounds + 58 the 2026-06 campaign + 18 the new backlog |
| **Clean SURVIVE** | **0** | nothing cleared the full gauntlet on unseen data |
| **PROMISING (weak, caveated)** | **2** | XS Donchian L/S; dated-futures basis carry (unlevered-thin only) |
| **KILL** | **~109** | every other hypothesis, net of realistic cost |
| **Audit flips (PROMISING → KILL)** | **3** | reserve-depletion, Q9 low-vol, O3 fee-NVT — all on the *same* defect |

**The one sentence.** A right-null surrogate **pass** proves a signal's *structure/sign is
non-random*; it does **not** prove the realized mean is positive-with-significance at honest
`N` on unseen data. That gap is exactly the PROMISING/SURVIVE boundary, and **no lead in any
era crossed it.** The two prior carry survivors (perp funding, dated-futures basis) remain
sub-risk-free regime trades. Nothing is deployable; the deliverable is the methodology plus
this body of negative evidence.

---

## 1. The two weak PROMISING leads (full caveats — read before quoting)

Both passed the *right* surrogate null (so the structure is real), beat their baselines, and
survived a consume-once holdout in *sign* — but each trips a magnitude / multiple-testing
gate on unseen data, which is why neither is SURVIVE and neither is deployable. Both carry a
**financing caveat**: the campaign's harness charged zero borrow on the short/levered
notional (a systemic leak; see §4), so the OOS economics below are reported *after* charging
it, as a range.

### Lead 1 — Cross-sectional Donchian channel-position long-short (beta-neutral)

Rank a 30-coin panel by each coin's position within its N-day high-low channel (breakout
strength); go long high-position, short low-position, dollar-neutral, continuous z-scored
weights. *(`output/edgehunt-requeue/SUMMARY.md`; deepened in `output/edgehunt-deepen/SUMMARY.md`.)*

- **What is real.** Genuinely **beta-neutral** (betas on {BTC, equal-weight} ≈ [−0.09, +0.08],
  alpha t ≈ 3.4–3.6 in-sample), so it is not timed long-beta. It **beats every baseline**
  (B&H, equal-weight-long, random dollar-neutral) and **passes the right null** — the
  cross-sectional-shuffle placebo at **p = 0.009** (the shuffled book is ≈ −1.1 Sharpe).
  The tilt is positive at **every** channel length N ∈ [20, 200] and in **every** holdout
  quarter. Harvey-Liu adjP = 0.0099; PBO = 0.000; per-config DSR@N=1 ≈ 0.999.
- **Why it is *not* SURVIVE.** On the **388-row consume-once holdout the magnitude is
  statistically indistinguishable from zero**: DSR@N=1 = **0.79** (< 0.95), Newey-West
  t(mean) = **0.96**, block-bootstrap mean CI-lower < 0. The full grid carries an honest
  **N = 72** search penalty that the per-config DSR ignores. The 30-coin panel is
  **survivorship-biased** (LUNA / FTT absent), so even the holdout is an upper bound — a
  −90% delisting shock flips the holdout negative in **17%** of draws.
- **The financing caveat.** The first pass cited a beta-hedge gate of 0.318, which the
  deepening showed was an **in-sample over-hedge artifact** (honest-OOS hedge β = 0.78).
  Charging borrow on the continuous ~1.0× short notional erodes the OOS holdout Sharpe from
  ~0.53 toward 0 / negative under expensive alt borrow (DOGE/AVAX/INJ…). **Report the OOS
  Sharpe as a range ~0.3–0.5, never a point.**
- **Money (canonical N=120 z-score-HIGH config, gross-2×, full-sample, illustrative only).**
  ~4.1%/mo gross → ~$412/mo @ $10k, ~$4,116/mo @ $100k; the deepening's corrected,
  financing-aware figure is **~$2,298/mo @ $100k**. *These are in-sample/full-history upper
  bounds — the honest OOS magnitude is ~0.* Trade the canonical, not the grid-best (1.69),
  which DSR correctly haircuts.
- **Verdict: PROMISING.** Next step is **not** more backtesting: pre-register the canonical
  config, rebuild the panel point-in-time / survivorship-free, and track the beta-hedged
  holdout Sharpe live (graduates only if it stabilizes above ~0.4 hedged; dies if XS-momentum
  decay continues).

### Lead 2 — Dated-futures basis cash-and-carry (BTC+ETH), **unlevered-thin only**

Short the contango quarterly future + long spot, hold to convergence; harvest the
term-structure premium *beyond* perp funding. *(`scripts/edgehunt/dated_futures_carry.ts`,
`output/edgehunt/SUMMARY.md`; corrected in `output/edgehunt-deepen/SUMMARY.md` and
`output/edgehunt-audit/SUMMARY.md`.)*

- **The headline was a financing-leak artifact.** The script charged the risk-free rate on
  **1 unit** of cash while the book is **~2.95×-levered**, and charged **zero** borrow on the
  levered notional. Correcting it collapses the *levered* series from Sharpe 1.64 → **0.69**,
  ~$1,062/mo → **~$447/mo**, DSR@honest-N 0.58 → **0.13** (and it fails the 0.95 gate at *any*
  RF charge ≥ 0.75%/yr). The original "+12.6%/yr, Sharpe 2.3, ~$640–1,051/mo" figures should
  **not** be quoted.
- **What honestly survives.** Only a **thin, unlevered, market-neutral excess**: **~4.9%/yr,
  t = 2.41, DSR ≈ 0.60, ~$475/mo @ $100k**. There is a genuine term-structure premium beyond
  perp funding (daily alpha controlling for perp carry was t = 3.25 before the leak
  correction), but at honest, unlevered economics it is **sub-every-multiple-testing-bar** and
  **regime-fragile** (sub-RF in 2023; the 2021 cohort was −37%).
- **Verdict: PROMISING (unlevered-thin).** A real but sub-risk-free regime carry, not a
  business. Next: honest financing on a vol-targeted spread, live basis + borrow data, and an
  explicit stress of the thin-contango regime.

> **Neither lead is investable today.** Their common next step is the same: pre-register one
> config, acquire the missing data (survivorship-free universe / live basis + borrow), and
> validate **strictly forward** — not more in-sample search.

---

## 2. Era 1 — prior rounds (~35 hypotheses: 33 KILL, 2 sub-RF carry "survivors")

The program's first phase ran six rounds (chronological lab log, `docs/EVOLUTION_TRAINING_LOG.md`,
entries dated 2026-05-31) plus a follow-up on-chain POC. It tested ~35 hypotheses under the
same bar: **33 KILL, 2 sub-risk-free carry survivors** (perp funding carry, dated-futures
basis). The earlier public ledger counted these as "28 IDs (26 KILL + 2 carry)"; the
inventory was subsequently expanded to 35 as the round-1 wide battery and the rotation/event
fronts were itemized individually. Both framings agree on the bottom line: **the only thing
that survived prediction-vs-carry is structural carry, and it decayed below the risk-free rate.**

### Era-1 KILL ledger (selected, by theme)

| ID / theme | Class | Binding gate (first failure) | Decisive number |
|---|---|---|---|
| Legacy GA neural BTC-15m direction (the retired alpha engine, program origin) | ML / prediction | true-negative population audit (luck-of-N) | best of **659** evals **+2.2%** < +11.76% luck-of-N expected-max; mean negative |
| E1 — cross-section weekly momentum | prediction | holdout + baselines (loses to random-lottery) | holdout **−9.59% net**; DSR 0.041 (N=32) |
| E3 — BTC time-series trend (daily/weekly) | prediction | Deflated Sharpe + baselines | DSR **0.886** daily / 0.593 weekly < 0.95 (N=36); returns = long-beta |
| T1 — cross-section reversal | prediction | holdout | holdout **−32%** |
| T2 — market-neutral CS-mom + vol-target | prediction | Deflated Sharpe (loses to random-lottery) | +27.9% IS vs universe −51.6% but **DSR(N=4)** fails |
| T3 — vol-target BTC (Moreira-Muir) | prediction | holdout | holdout net **−11%** |
| T4 — diversified TSMOM + vol-target | prediction | holdout | holdout **−18%**; gross only +2.8%/2y |
| T5 — regime-gated trend | prediction | holdout (loses to B&H) | holdout **+1.3%** vs B&H +15.3% |
| T6 — seasonality / turn-of-month | prediction | holdout (data-mining trap) | holdout **−32%** |
| T7 — funding-as-contrarian | prediction | dead in-sample | holdout APR **−28%** |
| T9 — ETH/BTC relative value | prediction | holdout | holdout **−48%** |
| T10 — cointegration pairs | prediction | Deflated Sharpe + MinBTL | gross +52.8% but **DSR(N=420) = 0.029** |
| TA1 — indicators to TIME the carry (ON/OFF) | TA-timing | holdout (oracle ceiling) | IS p=5.8e-7 but holdout **100% OFF, ties RF**; perfect-foresight oracle only **+0.52%/yr** |
| TA2 — slow vol-targeted TSMOM (MOP) | prediction | net-of-cost / holdout | vault Sharpe **−0.076** (−4.74%); 12m lookback is *worst* in crypto |
| TA3 — microstructure / forced-flow 15m BTC (224 variants) | prediction | Deflated Sharpe + holdout | cost kills all 15m/30m; survivor **DSR(N=224)=0.21** + holdout −0.98 |
| TA4 — classic indicators (RSI/MACD/BB/MA/ADX/Donchian/Stoch) | prediction | baselines + holdout | **0/94 beat buy-and-hold**; best flips to holdout Sharpe **−1.01** |
| WF-A — adaptive walk-forward premise (5 families) | adaptive | net-of-cost (surrogate clean) | trailing-best beats random next window only **50.7%**; OOS net −0.0041/bar |
| WF-B — adaptive WF on majors | adaptive | **surrogate** | real 0.0050 ≤ surrogate 0.0085, placeboP=0.59 (optimization artifact) |
| WF-C — adaptive WF on 15m BTC | adaptive | **surrogate (decisive)** | real **−0.063** vs phase +0.129 / block +0.132; placeboP=0.63 |
| WF-D — adaptivity on the real edge (carry threshold) | adaptive-carry | edge-vs-RF (oracle ceiling) | tracks perfectly (autocorr 0.97) but **oracle only +0.53%/yr** |
| R2 — illiquid corners / small-caps | prediction | **surrogate** | champion (Sharpe 0.738) worse than noise (surr max 3.14, placeboP=0.90); holdout **−58.5%** |
| R3 — GA evolves trading RULES (genetic programming) | prediction | **surrogate (placeboP=1.000)** | train +0.088 → holdout **−0.097**; GA on noise beats real champion; DSR(N=5613) ≈ 9e-12 |
| R4 — GA on structural + technical carry rules | structural | edge-vs-RF + surrogate | IS +3.15%/yr → holdout **−0.015%/yr** (flat RF); oracle ceiling +0.51%/yr; placeboP=0.721 |
| C1 — capital rotation as lead-lag flow | rotation | **surrogate (cross-sectional shuffle)** | holdout **−39.9%**; PBO **96.4%**; lead-lag reproduced by shuffle (p_LL=1.000) |
| C2 — dominance cycle (rotation period?) | rotation | Deflated Sharpe | dominance is *persistent not cyclic*; vault **−52.7%** (Sharpe −1.53), placeboP=1.000 |
| C3 — joint market-state / breadth overlay | rotation | baselines (loses to linear) | holdout **−19.56%**; residual timing edge is *aggregate vol*, not breadth (shuffle p=0.244) |
| C4 — event / listing forced-flow (641 real events) | event | **surrogate** | real "listing dump" CAR −5.3% by day 20 but block-boot reproduces 72%; holdout short **−100% compound** |
| OC1 — on-chain distribution-pressure overlay (exchange-flow + MVRV) | on-chain / flow | **baselines** + **surrogate (placeboP=0.482)** | long/flat overlay loses to B&H + random-lottery + equal-weight; holdout flat (Sharpe 0.003), N=36 |

### Era-1 carry "survivors" — real, but sub-risk-free now

| Survivor | Class | Full-sample headline | Why it is sub-RF *now* | Oracle proof |
|---|---|---|---|---|
| **E2 — perp funding carry** (delta-neutral) | carry | net ~**5.84% APR** (3y, 8 majors, all legs net-positive, max DD 5.37%) | trailing-12m gross collapsed to **~3.35%** < RF 4.5%; incremental edge vs T-bills **−2% to −3.3%/yr**; no minimum-viable capital up to $5M | TA1 timing oracle (perfect foresight) earns only **+0.52%/yr**; realized funding ≈ 0.36%/yr |
| **T8 — dated-futures basis** | carry | holdout net APR **+14.6% → +7.31%** post-50% haircut (full-sample framing) | compresses; quarterly-lumpy; same counterparty tail; the **2026-06 re-anchor shows the levered headline was a financing leak** — only a thin unlevered ~4.9%/yr survives (§1, §4) | WF-D adaptive-carry oracle ceiling **+0.53%/yr**; R4 GA structural oracle **+0.51%/yr** |

> **The oracle proof appears three independent times (TA1, WF-D, R4):** a gate or rule with
> *perfect foresight* earns only **+0.51–0.53%/yr** over the risk-free rate in the current
> regime, because realized carry there is ≈ 0.36%/yr. **The structural edge has decayed below
> the cost of harvesting it — not even a clairvoyant timer can extract it now.** Carry is a
> regime trade: arm it only when funding is rich (>~8–9%) and rising, as in 2024.

---

## 3. Era 2 — the 2026-06 domain campaign (~58 hypotheses, 8 domains)

One large, parallelized campaign pushed ~58 hypotheses across eight domains through the
committed gauntlet at $0, as a fan-out of domain workflows each genuinely trying to *find*
edge. Cross-domain roll-up: `docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md`. Per-domain syntheses are
cited inline. After deepening + the two-layer audit (§4) the campaign's audited tally is
**0 SURVIVE, 2 PROMISING (the Donchian + dated-futures-unlevered leads in §1), ~51 KILL.**

### 3.1 Consensus / carry-arb family (`output/edgehunt/SUMMARY.md`) — 9 tested, 7 KILL, 2 PROMISING→(audited)

| Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|
| Dated-futures cash-and-carry (BTC+ETH) | PROMISING → **unlevered-thin** (§1, §4) | financing re-anchor + cross-sectional-shuffle p=0.66 (7/8 gates pass) | levered headline a leak; honest unlevered **~4.9%/yr, t=2.41** |
| VRP harvest + crash-gate (BTC/ETH options) | PROMISING → **KILL** (deepen) | Deflated Sharpe 0.53 @ N=90 + shuffled-VRP placebo p=0.14 | a **2021 DVOL-onset regime artifact** (leave-2021-out Sharpe 1.257 → 0.560) |
| Cross-venue funding dispersion | KILL | beats-funding-level baseline (−$296/mo) + DSR 0.124 | wedge ~0.5 bps/8h vs 16 bps round-trip cost (~30× too small) |
| Perp-spot cash-and-carry | KILL | Deflated Sharpe (p=0.0023 @ N=96); loses to cash | a short-crash option: skew −12.9, kurtosis 175; excess-vs-cash Sharpe −0.17 |
| TSMOM trend overlay on carry | KILL | left-tail control + calendar-reanchor surrogate p=0.33–0.36 | the "hedge" is just lower average leverage; incremental ≈ 0 |
| Residual / idiosyncratic momentum (Blitz-Huij-Martens) | KILL (signal real) | Deflated Sharpe @ N=192 (0.18) | beta-neutral, surrogate p=0.0033, but the 30-coin cross-section is too thin even at zero cost |
| PCA basket stat-arb (Avellaneda-Lee s-score) | KILL | surrogate ≈ 0.20 | gross residual-reversion Sharpe **negative** at proper breadth (0/81 configs > 0.5) |
| Vol-targeting (Moreira-Muir) | KILL | matched-exposure control + GARCH null p=0.386 | apparent lift flips **−0.17 OOS**; PBO=0.95; it is levered beta, not alpha |
| Funding-sentiment contrarian fade | KILL | Deflated Sharpe @ N=24 (fade p=0.001); placebo p=0.88 | backwards — extreme funding *persists*, it does not revert (0/8 coins) |

### 3.2 D1 — indicators & price action (`output/edgehunt-D1/SUMMARY.md`, `output/edgehunt-requeue/SUMMARY.md`)

The XS Donchian PROMISING (§1) lives here (re-queue batch). The rest are KILL:

| Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|
| Supertrend (ATR-band trend overlay) | KILL | deflated-Sharpe-vs-own-B&H 0.307; excess-over-B&H CI straddles 0 | net 1.645 but vol-preserving surrogate scores **1.926 > observed** (p=0.801) |
| CCI (z-scored typical-price oscillator) | KILL | deflated-Sharpe-vs-killed-RSI 0.009 | net 1.768 but surrogate scores **2.3–2.4 > observed** (p=1.0) — pure long-beta/path artifact |
| XS Ichimoku long-short | KILL | DSR / haircut @ N=48 | decayed XS-momentum (yearly Sharpe 2.65 → −2.55 by 2026); pre-registered Hosoda **−0.72 OOS** |
| XS Bollinger %b reversion | KILL | wrong-signed every year | the only profitable rescue is the opposite-sign factor, which dies on the holdout (−0.38) |
| Candlestick reversal patterns | KILL | DSR + PBO 0.50 + holdout | best grid 0.92 but textbook canonical **−0.50**, holdout −0.66 |

### 3.3 D2 — volume & microstructure (`output/edgehunt-D2/SUMMARY.md`) — all 8 KILL

The **whole free-tier order-flow belief set is dead at h ≥ 1.** Any Sharpe lives in the
**h=0 contemporaneous / look-ahead** version (Hasbrouck/Easley tautology — the trades *are*
the move); the strictly-lagged component is ~0.

| Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|
| CVD divergence (h≥1) | KILL | net-sharpe>0.3 | net 0.237 (< B&H 0.815); lagged IC ≈ 0 |
| Taker buy/sell ratio extreme imbalance | KILL | net-sharpe>0.3 | lagged edge = **5%** of the h=0 ceiling (gross 4.58) |
| Anchored / session VWAP reversion | KILL | beats-buy-hold | breakeven 1.46 bps < 4 bps taker; session-anchor worse than rolling |
| Volume-profile POC / value-area reversion | KILL | net-sharpe>0.3 | canonical reversion **wrong-signed**; holdout net negative both cadences |
| OBV / A-D trend confirmation | KILL | ≤0 excess over price-trend | volume adds **−0.122** over the identical price-trend overlay |
| Amihud illiquidity premium | KILL | boot-CI-lower>0 | 74% of P&L from 20 of 1971 days — a **2021-only** premium |
| Whale-print momentum | KILL | DSR@N>0.95 (0.513) | prints **mean-revert**; only the p99.9 tail is positive (t<2) |
| Liquidation-cascade fade/follow | KILL | net-sharpe>0.3 | events too rare; conditional forward returns all |t|<1.5 |

*DEFERRED, not killed:* the paid-L2 family (VPIN, Kyle's λ, microprice, book imbalance) — but
the free belief each was meant to proxy is dead.

### 3.4 D5 — on-chain / crypto-native (`output/edgehunt-D5/SUMMARY.md`, `output/edgehunt-D5-followup/VERDICT.md`) — 7 KILL, 1 PROMISING→**KILL** (audit)

| Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|
| Exchange reserve / netflow trend (BTC) | PROMISING → **KILL** (§4 audit) | family-wise MAX-stat surrogate | pre-registered config clears DSR@N=1=0.988 forward, but it is the **argmax of a searched ~12-config neighborhood**; family-wise surrogate p ≈ **0.24** (vs surr95 ≈ 1.19) → FAIL; also inverts on ETH (forward Sharpe −0.85) |
| Hash Ribbons | KILL | hash-only surrogate | highest raw Sharpe 1.13, passes 7/8 gates; incremental hash edge **−0.084** (edge is the price-confirmation clause = long beta) |
| MVRV-Z extreme bands | KILL | baselines | byte-identical to B&H OOS; all timing days sit in the 2015–17 in-sample window |
| Stock-to-Flow deviation | KILL | baselines | residual is a price clock (corr 0.78 with price-vs-time) → Granger-Newbold spurious regression |
| SSR (stablecoin supply ratio) | KILL | baselines / holdout | holdout **inverts** (−0.239); mints *lag* price (reverse-causality echo) |
| Puell Multiple | KILL | baselines | **93%** the Mayer price/365d-MA oscillator (R²=0.87) |
| Realized-price cost-basis S/R | KILL | baselines / surrogate | a fixed line whose phase-randomized surrogate scores *higher* (p=0.841) |
| Metcalfe active-address residual | KILL | baselines / surrogate | mean-reverting noise (0/162 configs cleared surrogate AND held OOS) |

### 3.5 D6 — sentiment & cross-asset / macro (`output/edgehunt-D6/SUMMARY.md`, re-queue) — all KILL

Every macro/sentiment timer collapses to the **coincident-beta trap**: raw predictive corr ≈ 0,
an AR-matched placebo of the same shape times BTC as well or better, the edge is SPX/risk-on
beta, and it inverts out-of-regime on the holdout.

| Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|
| Rates + 2s10s yield-curve timer | KILL | baselines (< B&H, < random-lottery-95) | net 1.548 < B&H 1.522; holdout **−1.65**; AR-matched p=0.319 |
| Real yields / "digital gold" | KILL | AR(1)-matched placebo p=0.096 + holdout | β=0.443; IS +1.34 → **OOS −0.77** (vs B&H +0.91) |
| GDELT news-tone timer | KILL | baselines | tone corr **0.00**, hit-rate 0.516 (coin-flip); holdout −1.48 |
| Fear & Greed contrarian | KILL | baselines | net 0.38 < B&H 0.59; surrogate p=0.992 |
| Google Trends contrarian | KILL | holdout | holdout **inverts** −0.25 |
| Global net-liquidity / M2 | KILL | residual-alpha | net 1.31 but residual alpha exactly **0.000** — pure beta |
| Options put/call contrarian | KILL | DSR / placebo | selection-inflated 1.57 → 0.89 honest; placebo 0.29 |

### 3.6 D7 — calendar & event (`output/edgehunt-D7/SUMMARY.md`, re-queue) — all KILL

| Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|
| Four-year halving cycle | KILL | Deflated Sharpe @ N=2 | honest N hard-capped at **2** genuine post-halving years (2020, 2024); DSR cannot mathematically clear 0.95 |
| Stablecoin mint-as-event | KILL | family-wise MAX-stat placebo | per-cell p=0.007 is the data-mining trap; **family-wise p = 0.31** over the 128-cell grid |
| Funding-settlement timing | KILL | must-add-over-carry | every overlay cell loses standalone; injecting variance into a delta-neutral stream only lowers it |
| Sell-in-May / month seasonality | KILL | calendar-reanchor p=1.000 | Halloween effect is autocorrelated noise |
| Day-of-week | KILL | drift-removed ≈ 0 | tail-driven by shared crash Wednesdays |
| Turn-of-month | KILL | holdout | holdout sign-flips **−0.93** (an equity-flow effect crypto lacks) |
| CME weekend-gap fill | KILL | canonical | canonical −0.26 |

### 3.7 D3/D4/D8 remainder — vol/momentum/ML (`output/edgehunt-D348/SUMMARY.md`, `output/edgehunt-D348/SUMMARY.json`) — 10 KILL, 2 DEFERRED

| Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|
| Dual momentum (abs+rel) | KILL | consume-once holdout + BTC-beta | gated IS 1.60 = **timed beta** (β=0.65); holdout **0.03** |
| Funding dispersion (cross-venue) | KILL | Deflated Sharpe @ N | dispersion 0.52 bps/8h << flip cost; adds nothing over funding level |
| Short-term reversal (weekly+daily XS) | KILL | gross-negative | **−0.39** best of 36, negative even gross |
| 52-week-high nearness (anchoring) | KILL | **Harvey-Liu haircut → 0** (binds even at lenient N=6) | raw 1.04 → haircut 0; liquidity decay 1.04 → 0.51 *(audit: the haircut, not the cited DSR, is the real binding gate)* |
| Frog-in-the-pan / information discreteness | KILL | incremental-over-momentum CI spans 0 + holdout | adds **+0.00004/wk** over plain momentum; lowID holdout **−0.82** (β=1.26, *more* timed beta) |
| Ensemble stacking of weak signals | KILL | fails to beat naive 1/k | holdout 0.58 vs 1/k 0.96 |
| Rebalancing premium / vol harvesting | KILL | corr-matched + XS-shuffle surrogate | best 0.17; a structural vol+corr artifact, monotone in correlation |
| Risk parity (inverse-vol / ERC) | KILL | residualize-vs-low-vol-factor | RP−EW spread is a low-vol beta tilt (t ≈ 7.6), construction-α ~0 |
| GARCH/EGARCH vol-forecast timing | KILL | GARCH-simulated zero-edge surrogate (p=0.575) + matched-exposure | net 0.45 < B&H@matched 0.49; real lift **−0.037** (smoother beta, not alpha) |
| DVOL signals (spike/mom/level/timer) | KILL | strict-forward-lag | lag0 1.01 → lag1 **0.11** (boundary look-ahead) |
| GEX / dealer gamma (walls, flip) | **DEFERRED** | data-availability | needs paid per-strike OI+gamma history; $0 proxy −0.17 |
| 25-delta risk reversal / skew | **DEFERRED** | data-availability | needs paid per-delta IV history; $0 proxy fails lead-lag + boot + DSR |

---

## 4. AUDIT CORRECTIONS (the two-layer independent methodology audit)

Every batch was re-reviewed by an independent auditor **and** an audit-of-the-audit that
re-derived each disputed number from the committed primitives in
`src/lib/training/statistical-validation.ts`. The audits are
`output/edgehunt-audit/SUMMARY.md` (9 batches) and `output/edgehunt-audit-nb/SUMMARY.md`
(the Q9/O3 family-wise re-test). The conservative "nothing deployable" stands and is, if
anything, **stronger** than first reported.

**No false-KILL was found anywhere.** Every spot-run of a survivor candidate collapsed out of
sample, on a matched baseline, or on honest-N deflation. But two systematic defects were
confirmed, and **three earlier PROMISINGs were flipped to KILL on the *same* defect.**

### 4.1 Three PROMISING → KILL flips (one shared defect)

The defect is identical in all three: the harness ran the surrogate null on a **single,
in-sample-selected, grid-best config with no family-wise correction**, while the config was
actually the **argmax of a searched grid**. The correct null for a searched family is the
**family-wise MAX-statistic** (scramble every signal, rebuild *all* configs, take the
per-surrogate grid-MAX). Under it, each surrogate gate fails — and each lead **independently**
fails honest-N Deflated Sharpe at the full grid.

| Flipped lead | Era / source | Harness single-config p | Family-wise MAX-stat p | Honest-N DSR (full grid) | Verdict |
|---|---|---|---|---|---|
| **BTC exchange reserve-depletion / netflow** | campaign D5 (`output/edgehunt-audit/SUMMARY.md`) | 0.013 | **≈ 0.24** (real best 0.994 < surr95 ≈ 1.19) | 0.73 @ N=54 | **KILL** (argmax of a ~12-config neighborhood; also inverts on ETH) |
| **Q9 — cross-sectional low-volatility anomaly** | backlog quant (`output/edgehunt-audit-nb/SUMMARY.md`) | 0.002 | **≈ 0.06** (borderline, seed-sensitive) | **0.476** @ N=96 (Harvey-Liu adjP 0.673) | **KILL** (killed robustly by honest-N DSR; surrogate only a secondary contributor) |
| **O3 — fee-revenue NVT signal (BTC)** | backlog on-chain (`output/edgehunt-audit-nb/SUMMARY.md`) | 0.005 | **0.093** @ broad N=312 (real best 1.332 < surr95 1.384) | **0.894** @ N=312 (the N=54 pass was a post-hoc carve-out) | **KILL** |

The audit-of-audit also **self-corrected**: its first pass over-stated the Q9 family-wise p as
0.397 (an inflated *independent-per-config* null); the precedent-faithful *coherent* null
(one shared per-day permutation applied to all configs) gives ≈ 0.06. The verdict is
unchanged — Q9 dies on honest-N DSR 0.476 and Harvey-Liu 0.673 regardless — but the
correction is logged for honesty.

### 4.2 The systemic financing leak

**Every short/levered book in the campaign charged zero borrow/financing on the levered or
short notional** (error class i — it recurs in dated-futures, Donchian, Bollinger, Ichimoku,
MVRV-Z short, GARCH vol-timing). On the KILLs it only **deepens** the kill; on the two carries
it **inflated the headline**:

- **Dated-futures basis (re-anchored).** At the correct levered RF charge (avg lev **2.95×**),
  Sharpe **1.64 → 0.69**, ~$1,062 → **~$447/mo**, DSR **0.58 → 0.13** — and it fails the 0.95
  gate at *any* RF ≥ 0.75%/yr. Only a thin **unlevered** ~4.9%/yr (t=2.41) excess survives.
  The corrected dated-futures lead is therefore PROMISING **unlevered-thin only** (§1).
- **Donchian L/S.** Charging borrow on the continuous ~1.0× short notional erodes the OOS
  holdout from ~0.53 toward **0 / negative** under expensive alt borrow — so its OOS Sharpe is
  reported as a **range ~0.3–0.5**, never a point (§1).

### 4.3 Two doc-level (non-flipping) corrections

- **Tautological metric.** `residual_alpha_sharpe = sharpe(OLS residuals)` is **~0 by
  construction** (the residual mean is exactly 0), so the "residual-α ≈ 0 → timed beta"
  narrative is unsupported as stated. The dual-momentum / 52-week-high KILLs stand on the
  **holdout collapse**, not on this metric; the correct beta-hedged alpha is `sharpe(y − β·x)`.
- **Re-attributed binding gate.** The **52-week-high** KILL binds on the **Harvey-Liu haircut
  → 0** (which binds even at a lenient N=6) plus liquidity decay, **not** the cited DSR@N=30
  (which was N-inflated, and whose surrogate is actually *passed*).

### 4.4 Corrected tally and the meta-conclusion

**Audited final state: 0 clean SURVIVE; 2 weak PROMISING (XS Donchian; dated-futures
unlevered-thin); everything else KILL** (~109 across all eras, with the 3 flips above moving
from PROMISING to KILL). The financing leak re-anchors the dated-futures carry; the
family-wise surrogate flips reserve, Q9, and O3.

> **The meta-conclusion.** A right-null surrogate **PASS** proves the structure/sign is
> non-random — **not** that the realized mean is positive-with-significance at honest `N` on
> unseen data. That gap is exactly the PROMISING/SURVIVE boundary, and **no lead, in any era,
> crossed it.** Nothing is deployable. The durable deliverable is the **methodology** plus
> this body of negative evidence. The two prior carry "survivors" (perp funding, dated-futures
> basis) remain **sub-risk-free** regime trades.

---

## 5. Era 3 — the new $0 backlog (18 hypotheses: quant 10 + on-chain/price-action 8)

Two further $0 batches ran after the main campaign, same gauntlet and same traps. Both
produced **one provisional PROMISING each**, and the family-wise audit (§4) **flipped both to
KILL**. Net: **18 KILL, 0 surviving PROMISING.**

### 5.1 Quant / regime / vol / momentum (`output/edgehunt-quant/SUMMARY.md`) — 10 KILL

HMM and BOCPD regime timers, acceleration momentum, weekly residual reversal, time-of-day,
DVOL term-structure vol-carry, vol-regime conditioning, efficiency-ratio/ADX gate, and a
carry+momentum combo — all KILL on documented mechanisms: **de-risking masquerading as
timing** (exposed by the matched-exposure control), **detection latency**, **no separable
premium over an already-killed parent**, and **search inflation vs honest N**.

| ID | Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|---|
| Q1-HMM | Gaussian HMM regime timer (BTC) | KILL | deflated_sharpe @ N=72 | net 0.779; GARCH surrogate p=0.065 |
| Q2-BOCPD | Bayesian online change-point timer | KILL | deflated_sharpe @ N=108 | detectors fire *after* the move |
| Q3-ACCEL | Acceleration momentum | KILL | deflated_sharpe @ N=96 | 1.29 IS / **−0.27 OOS** |
| Q4-STREV | Weekly residual reversal | KILL | baselines | net **0.000**; negative gross spread |
| Q5-TOD | Time-of-day / UTC-hour timing | KILL | deflated_sharpe @ N=576 | 0.71 IS / **−0.78 OOS** |
| Q6-DVOLTS | DVOL term-structure vol-carry | KILL | matched-exposure control | mined 3.40, but de-risking not alpha |
| Q7-VOLREGIME | Revive killed signal via vol-regime gate | KILL | baselines / matched-exposure | no separable premium over the dead parent |
| Q8-EFFRATIO | Efficiency-ratio + ADX gate on TSMOM | KILL | deflated_sharpe @ N=1456 | 1.324 IS / **−0.058 OOS** |
| Q9-LOWVOL | XS low-volatility anomaly (β-neutral L/S) | **PROMISING → KILL** (§4) | deflated_sharpe @ N=96 (0.476) + Harvey-Liu 0.673 | β-neutral, XS-shuffle p=0.002, holdout +2.08 — but the canonical is only 0.70; family-wise surrogate ≈ 0.06; survivorship-biased panel |
| Q10-CARRYMOM | Carry + momentum combo | KILL | cpcv_pbo + holdout | 2.722 IS / **−0.04 WF** |

### 5.2 On-chain (free Coin Metrics) + price-action (`output/edgehunt-onchain2/SUMMARY.md`) — 8 KILL

Network-activity momentum, realized-cap/MVRV, stablecoin-supply flow, and four price-transform
overlays (Heikin-Ashi, Williams fractals, Mayer Multiple, Renko) — all KILL: the overlays
reduce to a lagged moving-average / long-beta tilt (reproduced by the surrogate-recompute
null), and the "adoption" series are repackaged price momentum (reverse causality).

| ID | Hypothesis | Verdict | Binding gate | Decisive number |
|---|---|---|---|---|
| O1-ADRACT | Network-growth (AdrAct+TxCnt) momentum, price-orthogonalized | KILL | baselines (BTC) / holdout (ETH OOS −0.19) | corr 0.55–0.73 with price momentum (reverse causality) |
| O2-REALCAP | Realized-cap / MVRV valuation band | KILL | baselines | loses to B&H + price-only Mayer control (realized cap recovered algebraically; thermocap DEFERRED) |
| O3-NVTS | Fee-revenue NVT signal (BTC, contrarian) | **PROMISING → KILL** (§4) | deflated_sharpe @ broad N=312 (0.894) + family-wise surrogate 0.093 | net 1.33, 10/10 years positive, holdout +0.59 — but the N=54 pass was a post-hoc carve-out; canonical only 0.74; no ETH confirmation; a free *proxy* for paid `NVTAdj90` (DEFERRED) |
| O4-STABLEFLOW | Stablecoin supply growth as lagged flow | KILL | deflated_sharpe @ honest N | "survive" only under a dishonest N=3 carve-out; clean holdout **−0.276** |
| O5-HEIKIN | Heikin-Ashi trend / HA-EMA timer | KILL | deflated_sharpe (dsr-vs-B&H 0.102) | a lagged-MA long-beta tilt |
| O6-FRACTAL | Williams 5-bar fractal breakout | KILL | baselines | ties/loses to B&H |
| O7-MAYER | Mayer Multiple (price / SMA200) | KILL | deflated_sharpe (surrogate-recompute) | classic rule −0.380 |
| O8-RENKO | Causal Renko brick trend timer | KILL | holdout (fails own B&H OOS) | a lagged-MA long-beta tilt |

---

## 6. Reading the gates (how a KILL / PROMISING / SURVIVE is decided)

Every hypothesis runs through the same fixed-order gauntlet (codified in `AGENTS.md`; the
harness is `scripts/edgehunt-D5/harness.ts::runGauntlet`, chaining the committed primitives in
`src/lib/training/statistical-validation.ts` — `computeDeflatedSharpeRatio`, `estimateCscvPbo`,
`blockBootstrapConfidenceInterval`, `summarizeReturnSeries`). The **first failing gate is the
binding gate** reported in every table. The binding order:

1. **`net_of_cost`** — positive *net* of realistic cost (taker ≈ 4 bps/side ⇒ 8 bps
   round-trip) on every position change. **Financing/borrow is charged on the FULL
   levered/short notional, not 1 unit** (the systemic-leak rule, §4). A gross-only signal is
   an automatic KILL.
2. **`baselines`** — beat buy-and-hold **and** a matched-exposure benchmark (matched-leverage /
   exposure-matched random-lottery). A low-exposure long/flat overlay structurally cannot
   out-Sharpe 100%-long B&H, so scoring it only vs B&H is an artifact. Cross-sectional books
   must be **beta-neutral** (book β ≈ 0, alpha-t on the residual, using an honest-OOS hedge β,
   never an in-sample over-hedge).
3. **`deflated_sharpe`** — Deflated Sharpe probability ≥ 0.95 **at the honest `N`** (the true
   number of distinct configs searched).
4. **`block_bootstrap`** — block-bootstrap mean CI strictly positive.
5. **`cpcv_pbo`** — Probability of Backtest Overfitting < 0.5 over combinatorial splits.
6. **`haircut`** — Sharpe survives the Harvey-Liu multiple-testing haircut (often the *true*
   binding gate; see the 52-week-high KILL, §4).
7. **`surrogate`** — the real edge beats the **right** null for the claim, using the
   **family-wise MAX-statistic** for a searched grid:
   - time-series timing → phase-randomization / block-bootstrap
   - rotation / relative-value → cross-sectional shuffle
   - path-dependent exits → bracket-on-surrogate
   - vol-clustering → GARCH-simulated zero-edge
   - variance-risk-premium → shuffled-VRP placebo
   - calendar / event → calendar-reanchor + family-wise MAX-statistic
8. **`holdout`** — out-of-sample slice scored **exactly once** (consume-once vault).

**Labels:** SURVIVE = all gates pass. **PROMISING** = passes net + baselines + surrogate +
holdout but trips a multiple-testing / DSR gate (curable only by genuine pre-registration to
collapse `N → 1`). Otherwise KILL.

> **Change the target, never the gates.** An empty parent pool under this gauntlet means the
> target lacks edge net of cost — not that the gauntlet is too strict. A KILL is a valid,
> valuable outcome.

---

## 7. Synthesis — what the whole ledger says

**The edge is NOT in** (a) direction prediction, (b) cross-section / relative value at retail
cost, (c) classic or microstructure TA, (d) timing the carry, (e) adaptively re-fitting any of
the above, (f) illiquid small-caps, (g) GA-evolved rules, (h) capital rotation / dominance
cycles / breadth / event flow, (i) on-chain valuation / flow overlays (NVT, MVRV, SOPR,
exchange-flow, network-activity), (j) macro / sentiment timers, (k) calendar / seasonality
effects, (l) regime / change-point timers, or (m) variance-risk-premium harvesting. ~111
independent attempts — the standard academic priors, fixed and adaptive, plus the genuinely
new on-chain data class — almost all dead net of realistic cost.

Two patterns recur so consistently they are the meta-findings:

- **The "two-gate" death.** A signal posts a pretty in-sample Sharpe and *passes* DSR / PBO /
  haircut — gates that only certify "this Sharpe is not luck-of-selection." It then dies at the
  two gates that test *economic* edge: **baselines** (loses to B&H / matched exposure /
  random-lottery) and the **consume-once holdout**. Honest `N` is what makes this work
  (TA3 at N=224 → DSR 0.21; T10 at N=420 → DSR 0.029; R3 at N=5613 → DSR ≈ 9e-12;
  Q9 at N=96 → DSR 0.476).
- **The "true descriptive kernel, no tradeable edge."** Many intuitions contained a genuinely
  true fact — adaptive drift is real (WF autocorr 0.39–0.97), correlation→1 in risk-off is real
  (C3), dominance is persistent (C2), the listing dump is real (C4), flow carries
  price-orthogonal information on BTC (reserve), the low-vol and breakout tilts are real
  structures (Q9, Donchian) — and *none* became a tradeable, cost-surviving, out-of-sample
  edge. The **surrogate / family-wise null is the hero**: it separates real structure from a
  realized mean that is significant at honest `N` on unseen data.

**The durable asset of this project is the methodology** — committed gates + the right
(family-wise) surrogate null + honest trial-count `N` + a consume-once holdout — together with
this exhaustive body of negative evidence. The empty parent pool is the gates working
correctly, not a failure of effort. **Change the target, never the gates.**

---

## Provenance and related documents

- **`docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md`** — the 2026-06 campaign roll-up (~58 hypotheses, 8
  domains), with the four-leads-in-detail and the per-domain KILL ledger.
- **`output/edgehunt-*/SUMMARY.md`** — the per-domain syntheses cited throughout §3 and §5
  (`edgehunt/`, `edgehunt-D1/`, `edgehunt-D2/`, `edgehunt-D5/`, `edgehunt-D6/`, `edgehunt-D7/`,
  `edgehunt-D348/`, `edgehunt-requeue/`, `edgehunt-quant/`, `edgehunt-onchain2/`), plus the
  pre-registered reserve follow-up `output/edgehunt-D5-followup/VERDICT.md`.
- **`output/edgehunt-audit/SUMMARY.md`** + **`output/edgehunt-audit-nb/SUMMARY.md`** — the
  two-layer independent audit that confirmed the financing leak and flipped reserve, Q9, and O3
  to KILL under the family-wise MAX-statistic null.
- **`output/edgehunt-deepen/SUMMARY.md`** — the adversarial-verification deepening (pre-registered
  consume-once forward tests + a default-to-refute skeptic).
- **`docs/BACKLOG.md`** — the full research backlog (the right surrogate null, honest-N concern,
  and honest prior for each hypothesis).
- **`docs/EVOLUTION_TRAINING_LOG.md`** — the raw chronological lab log (Portuguese), the
  source-of-truth provenance for the Era-1 prior rounds.
- **Gauntlet primitives** — `src/lib/training/statistical-validation.ts`, chained by the
  per-domain `runGauntlet` wrappers (e.g. `scripts/edgehunt-D5/harness.ts`). *(A single
  `validateStrategy()` entry-point wrapper is exposed in the published lean repo; it is not
  present on this working branch, where the primitives are chained directly by the harness.)*

> **License: MIT.** A negative result, honestly gated, is the result.
