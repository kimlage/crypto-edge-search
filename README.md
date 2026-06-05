# crypto-edge-search

> ⚠️ **Not investment advice — software/research only; the project's own conclusion is that nothing here is deployable.** See [docs/DISCLAIMER.md](docs/DISCLAIMER.md).

**You've got a trading edge. An RSI divergence. A Fibonacci pocket. A clean Supertrend flip. Exchange outflows. The halving cycle. A stop-loss rule that finally fixed your win rate. Something that *works*.**

This project tested ~111 of those edges — the whole retail and quant playbook — on free public data, at $0, through one brutal anti-overfitting protocol that doesn't care about your priors. It tried to **break** each one.

**Result: 0 survived clean. 2 limped through too weak to trade. The other ~109 are dead.**

Below is the table. Find your tool. Find the number that killed it. Then, if you think yours is different, [fork it and run it through the same gauntlet](#think-yours-survives) — the protocol is open, the data is free, and **if your rule passes, I'll post it.**

> This is a **falsification lab**, not a strategy shop. We don't look for a story that fits a backtest — we try to falsify every technique with the same fixed protocol, and we publish what dies as loudly as what lives. A clean backtest is the *cheapest* thing in markets. The working hypothesis the data keeps confirming: **for an individual at retail cost, speculation behaves far more like a game of chance than a reliable way to make money.**

---

## Now two domains: crypto **and** prediction markets

The same gauntlet has since been run on **Polymarket prediction markets** — where it can do something crypto can't: **prove** the verdict, because every market resolves to a ground-truth label. Over **172,830 resolved markets** and **1,355,837 trades** (all $0, on the free Polymarket Gamma / CLOB / data-api and the free Open-Meteo forecast), it tested a **35-hypothesis backlog**, copy-trading & wallet-skill, calibration / favorite-longshot, static arbitrage, money-management, **22 reverse-engineering mechanisms**, **16 external-information leads** ([H1–H16](docs/polymarket/EXTERNAL_INFO_EDGES.md)), a **29-test credibility battery**, and a forensic falsification of **5 viral "Claude + copy-trade = print money" claims.**

**Same verdict: 0 deployable edge.** Copy-trading public wallets does not persist (the wallet-label-shuffle null is **p=0.528** across **5 walk-forward windows**, Stouffer z=−0.13; "70%+ win-rate" is the *anti*-signal — it selects longshot-sellers); the market is calibrated in aggregate (+0.0001 over 1.36M trades); the favorite-longshot premium is real but tail-fragile / sub-cost; **no riskless arbitrage**; **no money-management scheme rescues a ≤0 edge** (sizing is expectancy-sign-invariant; "98% win-rate" longshot-sellers pass Sharpe/DSR but **fail the right null**); and even a real Open-Meteo ensemble forecast does **not** beat the crowd in a **pre-registered forward test**. A **planted-edge positive control** confirms the harness *would* SURVIVE a real +8% edge — so 0-SURVIVE is a property of the *markets*, not a dead gauntlet.

→ **[docs/polymarket/](docs/polymarket/)** — the full campaign: [overview](docs/polymarket/README.md) · [results](docs/polymarket/RESULTS.md) · [the honest audit](docs/polymarket/EVALUATION.md) · [credibility backlog](docs/polymarket/CREDIBILITY_BACKLOG.md) · [the viral-claim takedown](docs/polymarket/CLAUDE_BOT_ARTICLE_VALIDATION.md). The unified verdict across both domains — **184+ distinct hypotheses & mechanisms, 0 clean SURVIVE, 0 deployable edge** — is in **[SYNTHESIS.md](SYNTHESIS.md)**.

---

## Find your tool

Verdicts: **KILL** = no edge net of cost on unseen data · **PROMISING** = real structure, but too weak / not deployable · **SURVIVE** = cleared every gate (count: **zero**) · **DEFERRED** = needs paid data we won't buy. Full per-technique numbers and the binding gate for every row live in **[docs/RESULTS.md](docs/RESULTS.md)**.

### Classic indicators & oscillators

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **RSI / MACD / Bollinger / MAs / ADX / Stochastic / Donchian** | Overbought/oversold, crosses and bands time entries | **KILL** — **0 of 94 indicator configs beat buy & hold**; the best flips to **−1.01 Sharpe** out-of-sample |
| **Supertrend** | The "cleanest" ATR trend flip | **KILL** — net Sharpe 1.65, but a vol-preserving **surrogate scores 1.93 > the strategy** (p=0.80): pure long-beta |
| **CCI** | ±100 bands catch trend/reversal | **KILL** — net 1.77, surrogate **2.3–2.4 > observed** (p=1.0): a path artifact, not a signal |
| **Ichimoku Cloud** | Kumo break + TK cross + Chikou = trend | **KILL** — decayed XS-momentum (yearly Sharpe 2.65 → **−2.55**); pre-registered Hosoda config **−0.72 OOS** |
| **Bollinger %b reversion** | Bands mean-revert | **KILL** — wrong-signed in *every* calendar year; the only "fix" is the opposite sign, which dies OOS (−0.38) |
| **Williams %R / StochRSI / MFI** | Oscillator OB/OS reversals | **KILL** — algebraic cousins of the already-dead RSI/Stochastic (corr ≈ 1) |
| **Mayer Multiple (price/SMA200)** | Buy under, sell over the 200-day | **KILL** — classic rule **−0.38** |
| **Heikin-Ashi / Renko / range bars** | Smoothed bars reveal the "real" trend | **KILL** — a lagged moving-average long-beta tilt; the apparent edge is a fill/look-ahead artifact |
| **Williams fractals** | 5-bar fractal breakout | **KILL** — ties/loses to buy & hold |

### Price action, patterns & levels

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Support / resistance & pivots** | Price respects horizontal levels | **KILL** — **168 level configs, no edge**; a phase-randomized surrogate (a *random* line) scores **higher** than the real line (p=0.84). The same illusion as a random horizontal line |
| **Fibonacci retracement / extension** | 0.382 / 0.618 / 1.618 are special | **KILL** — replace the Fib ratios with **random ratios and it works exactly as well**. Fibonacci = random horizontal lines |
| **Candlestick patterns (engulfing / hammer / doji / star)** | Reversal at the candle | **KILL** — best grid 0.92, but the textbook canonical pattern is **−0.50**, holdout −0.66 |
| **Head & shoulders / double tops / triangles / trendlines** | "Most reliable" reversal/continuation | **KILL** — reduce to the S/R kill; the detector finds them in **pure noise** just as often (detector-on-surrogate) |
| **Elliott Wave / harmonics (Gartley, Bat, Crab)** | Wave counts + Fib geometry forecast | **KILL** — so flexible any path fits ex-post (**non-falsifiable**); the only testable kernel (Fib ratios) is random |
| **Wyckoff accumulation/distribution** | Spring/upthrust + volume → enter before markup | **DEFERRED** (mechanized spring genuinely uncertain) — but the "spring" still works with **volume shuffled**: it reduces to an S/R level |

### Volume & order-flow

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **CVD / OBV / VWAP / volume profile** | "Volume precedes price" | **KILL** — the whole free order-flow set is **dead at any lag ≥ 1 bar**; the Sharpe lives only in the **h=0 tautology** where *the trades are the move*. OBV adds **−0.12** over plain price-trend; VWAP breakeven 1.46 bps < 4 bps cost; volume-profile reversion is **wrong-signed** |
| **Taker buy/sell ratio** | Imbalance predicts the next move | **KILL** — the lagged edge is **5% of the h=0 ceiling** |
| **Whale prints / large-trade tape** | Follow the whales | **KILL** — prints **mean-revert**; only the p99.9 tail is positive (t<2) |
| **Liquidation-cascade fade/follow** | Cascades are magnets | **KILL** — events too rare; conditional forward returns all \|t\|<1.5 |
| **Amihud illiquidity premium** | Illiquid names pay a premium | **KILL** — **74% of P&L from 20 of 1,971 days**: a 2021-only premium |
| **VPIN / Kyle's λ / microprice / book imbalance (L2)** | Order-book toxicity/imbalance predicts | **DEFERRED** — needs paid point-in-time L2; the free belief each proxies is already dead |

### Stops, take-profit & sizing

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Stop-loss / take-profit brackets** | "Cut losers, run winners" creates edge | **KILL** — a bracket reshapes a coin-flip from **~33% → 65% win-rate while expectancy stays flat** (the fair-game theorem). You move the variance, not the mean — and on a taker, turnover cost only makes it worse |
| **Parabolic SAR / trailing stops** | The exit schedule *is* the edge | **KILL** — no entry signal, only an exit; high turnover, **4 bps taker dominates** |
| **Kelly / fractional-Kelly / risk-parity / vol-targeting** | Smarter sizing makes money | **KILL** — sizing on a zero-edge book is still zero edge; vol-targeting is **levered beta, not alpha** (flips −0.17 OOS, PBO 0.95). Risk-parity's RP−EW spread is a low-vol beta tilt (t≈7.6), construction-alpha ≈ 0 |
| **Rebalancing premium / vol harvesting** | Rebalancing pays you to diversify | **KILL** — a structural vol+corr artifact, monotone in correlation; best 0.17 |

### Trend & momentum

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **TSMOM / time-series trend-following** | "The trend is your friend" | **KILL** — diversified vol-targeted TSMOM holdout **−18%**; gated IS 1.60 is **timed BTC beta** (β=0.65), holdout 0.03; 12-month lookback is the *worst* in crypto |
| **Dual momentum (abs + rel)** | Combine absolute + relative strength | **KILL** — gated IS 1.60 is timed beta (β=0.65); holdout **0.03** |
| **Acceleration (2nd-derivative) momentum** | Momentum-of-momentum gets you in earlier | **KILL** — 1.29 IS / **−0.27 OOS** |
| **52-week-high / nearness-to-high** | Anchoring breakout | **KILL** — raw 1.04 → **Harvey-Liu haircut to 0** |
| **Frog-in-the-pan (information discreteness)** | Smooth trends persist | **KILL** — adds **+0.00004/wk** over plain momentum; lowID holdout −0.82 (β=1.26, *more* timed beta) |
| **Cross-sectional momentum / rotation** | Long the strong, short the weak | **KILL** — residual momentum is real (β-neutral, surrogate p=0.003) but dies at Deflated Sharpe (0.18 @ N=192): the 30-coin panel is too thin |
| **Capital rotation / BTC-dominance cycle / breadth** | Money rotates BTC→large→alt on a clock | **KILL** — holdout **−39.9%**, PBO 96%; the lead-lag is **reproduced by a shuffle** (p=1.000). Dominance is *persistent, not cyclic* |

### Mean-reversion, pairs & stat-arb

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Distance / cointegration pairs (GGR, Engle-Granger)** | Spreads revert to the mean | **KILL** — gross +52.8% but **DSR(N=420)=0.029**; random pairing reproduces it (p=0.50) |
| **PCA basket stat-arb (Avellaneda-Lee s-score)** | Residuals revert to the basket | **KILL** — at honest breadth the **gross** residual-reversion Sharpe is **negative** (0 of 81 configs > 0.5) |
| **Ornstein-Uhlenbeck single-name reversion** | Price is a mean-reverting process | **KILL** — daily crypto residuals don't revert; reversion lives intraday where cost dominates |
| **Short-term reversal (1d / weekly XS)** | Yesterday's losers bounce | **KILL** — **−0.39** best of 36, **negative even gross** |

### Volatility & options

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Variance risk premium (sell vol)** | IV > RV, so selling vol pays | **KILL** — a **2021 DVOL-onset regime artifact**: leave-2021-out Sharpe 1.26 → **0.56**; fails the shuffled-VRP placebo (p=0.14) |
| **Bollinger/Keltner squeeze → breakout** | Compression precedes expansion | **KILL** — the *magnitude* is real, the *direction* is a coin-flip |
| **GARCH / EGARCH vol-forecast timing** | Forecast vol, time the market | **KILL** — net 0.45 < B&H 0.49 at matched exposure; GARCH surrogate p=0.575 |
| **DVOL / vol-of-vol signals** | Vol level/momentum times spot | **KILL** — lag0 1.01 → **lag1 0.11** (boundary look-ahead) |
| **Covered calls / "the wheel" / short straddles** | High win-rate income | **KILL** — capped VRP + beta; the high win-rate hides negative skew (the inverse of the stops lesson) |
| **Dealer GEX / gamma walls / 25Δ skew / put-call** | Dealer positioning pins/repels price | **DEFERRED** (skew/GEX need paid per-strike chains; the $0 proxy is −0.17). **Put/call contrarian KILL** — selection-inflated 1.57 → 0.89 honest, placebo 0.29 |

### On-chain & crypto-native

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **MVRV / MVRV-Z** | Valuation bands call tops & bottoms | **KILL** — **byte-identical to buy & hold OOS**; all timing days sit in the 2015–17 in-sample window |
| **NVT / fee-NVT** | "Crypto P/E" flags over/undervaluation | **KILL** — looked PROMISING at net 1.33 (10/10 years positive), **flipped to KILL** by the family-wise surrogate (p=0.093) + honest-N DSR 0.894 |
| **SOPR / realized-cap / realized-price S/R** | On-chain cost-basis is support | **KILL** — the realized-price line scores **below its own random surrogate** (p=0.84) |
| **Stock-to-Flow (S2F)** | Scarcity model prices BTC | **KILL** — the residual is a **price clock** (corr 0.78 with price-vs-time): textbook spurious regression |
| **Puell Multiple** | Miner-revenue extremes time cycles | **KILL** — **93% the same series as the Mayer 365-day oscillator** (R²=0.87) |
| **Hash Ribbons** | Miner capitulation = buy | **KILL** — incremental hash edge **−0.08**; the "edge" is the price-confirmation clause (long beta) |
| **Exchange reserves / netflow depletion** | Coins leaving exchanges = bullish | **KILL** — pre-registered config passed forward (DSR 0.99) but it was the **argmax of a ~12-config grid**; family-wise surrogate **p≈0.24**; **inverts on ETH** (−0.85) |
| **SSR (stablecoin supply ratio) / stablecoin mints** | Stablecoin dry powder leads price | **KILL** — holdout **inverts** (−0.24); mints **lag** price (reverse-causality echo) |
| **Metcalfe / active-address valuation** | Network growth → value | **KILL** — mean-reverting noise (0 of 162 configs survived) |
| **Stablecoin / network-activity momentum** | Adoption leads price | **KILL** — the "adoption" series are **repackaged price momentum** (corr 0.55–0.73, reverse causality) |
| **Whale accumulation / HODL waves / SOPR cohorts / CDD** | Smart-money cohorts lead | **DEFERRED** — needs paid cohort/UTXO-age data |

### Sentiment & macro

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Fear & Greed contrarian** | Buy fear, sell greed | **KILL** — net 0.38 < B&H 0.59; surrogate p=0.992 (indistinguishable from noise) |
| **Google Trends contrarian** | Search interest tops the market | **KILL** — holdout **inverts** (−0.25) |
| **News-tone (GDELT)** | Headlines predict | **KILL** — tone↔return corr **0.00**, hit-rate 0.516 (coin-flip) |
| **Global net-liquidity / M2** | Liquidity drives crypto | **KILL** — net 1.31 but **residual alpha exactly 0.000**: pure beta |
| **Rates / 2s10s / real yields ("digital gold")** | Macro regime times crypto | **KILL** — the **coincident-beta trap**: it's SPX/risk-on beta and inverts OOS (holdout **−1.65**) |

### Calendar & seasonality

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Four-year halving cycle** | The cycle that prints money | **KILL** — honest N hard-capped at **2 genuine post-halving years** (2020, 2024); DSR **cannot** mathematically clear the bar at N=2 |
| **Sell-in-May / Halloween effect** | Seasonal months beat the rest | **KILL** — calendar-reanchor placebo **p=1.000** (autocorrelated noise) |
| **Day-of-week / turn-of-month** | Calendar drift | **KILL** — tail-driven by shared crash Wednesdays; TOM holdout sign-flips **−0.93** (an equity-flow effect crypto lacks) |
| **CME weekend gap-fill** | Gaps always fill | **KILL** — canonical **−0.26** |
| **Token unlocks / airdrops / listings / ETF flows / pre-FOMC drift** | Scheduled flows are tradeable | **DEFERRED / KILL** — most are PIT-fragile or n=1; listing-dump CAR −5.3% is reproduced by a block-bootstrap 72% of the time |

### Carry & arbitrage

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Perp funding carry (delta-neutral)** | Harvest funding, market-neutral | **sub-T-bill** — net ~5.84% APR full-sample, but trailing-12m collapsed to **~3.35% < 4.5% risk-free**; a perfect-foresight timer earns only **+0.52%/yr**. A regime trade, not a business |
| **Dated-futures basis cash-and-carry** | Short contango future, long spot | **PROMISING (weak)** — the levered headline was a **financing leak** (Sharpe 1.64 → 0.69 once borrow is charged); only a thin **~4.9%/yr (t=2.41)** unlevered excess survives, **below every multiple-testing bar** |
| **Cross-sectional Donchian channel-position L/S** | Long breakouts, short breakdowns, market-neutral | **PROMISING (weak)** — genuinely beta-neutral, structure is real (XS-shuffle **p=0.009**), **but the realized magnitude is indistinguishable from zero** on the 388-row holdout (DSR 0.79, t=0.96); OOS Sharpe ~0.3–0.5 after borrow. *Not deployable* |
| **Cross-venue funding dispersion** | Arb the funding spread | **KILL** — wedge ~0.5 bps/8h vs **16 bps round-trip cost** (~30× too small) |
| **Perp-spot cash-and-carry** | Risk-free basis | **KILL** — a short-crash option (skew −12.9, kurtosis 175); excess-vs-cash Sharpe **−0.17** |
| **Funding-as-contrarian (fade extremes)** | Extreme funding reverts | **KILL** — backwards: extreme funding **persists** (0/8 coins; the placebo beats the real signal) |
| **DeFi-lending / liquid-staking basis (stETH)** | On-chain yield arb | **DEFERRED** — a risk premium / convergence trade, not free alpha |

### ML / adaptive

| Technique | What traders believe | Verdict + the killer number |
|---|---|---|
| **Adaptive walk-forward (refit the best rule)** | "The market changes; adapt" | **KILL** — the trailing-best beats a random next window only **50.7%** of the time |
| **GA / genetic-programming evolved rules** | Evolve a winner | **KILL** — GA on **pure noise** beats the real champion; train +0.088 → holdout **−0.097** (placeboP=1.000) |
| **GBDT / LSTM / Transformer / RL on price** | Deep learning finds the edge | **KILL** — the legacy GA-neural 15m engine: best of **659 evals +2.2% < +11.76% luck-of-N**; mean negative |
| **HMM / BOCPD regime timers** | Detect the regime, then trade | **KILL** — detectors fire **after** the move; de-risking masquerading as timing |
| **Ensemble stacking of weak signals** | Combine many edges | **KILL** — holdout 0.58 vs a naive 1/k of 0.96 |

---

## The honest bottom line

| | |
|---|---|
| Hypotheses tested | **~111** across **8 domains** |
| Data / cloud cost | **$0** — free public exchange, on-chain, and macro APIs only |
| Clean **SURVIVE** | **0** |
| Weak **PROMISING** | **2** — XS Donchian L/S; dated-futures basis (unlevered, sub-T-bill) |
| **KILL** | the rest (~109) |
| Deployed capital | **none** |

The two PROMISING leads are **not investable today** (both are beta-neutral, both trip a multiple-testing / magnitude gate on data they never saw):

1. **Cross-sectional Donchian channel-position long/short** — real structure (XS-shuffle null **p=0.009**, positive in every channel window and holdout quarter), but on the 388-row consume-once holdout the **magnitude is indistinguishable from zero** (DSR 0.79, Newey-West t=0.96); after honest borrow on the short leg the OOS Sharpe erodes to **~0.3–0.5**.
2. **Dated-futures basis carry (unlevered-thin only)** — a real ~4.9%/yr (t=2.41) market-neutral excess that sits **below every multiple-testing bar**, is sub-risk-free, and regime-fragile (the 2021 cohort was −37%). The headline "Sharpe 2.3" was a financing leak.

**An independent two-layer audit even flipped three apparent winners *back* to KILL** — BTC exchange-flow, a cross-sectional low-vol anomaly, and a fee-revenue NVT signal — all on the *same* defect: a surrogate test run on **one hand-picked grid-best config** instead of the whole searched family. Under the correct family-wise MAX-statistic null, each fails (exchange-flow: single-config p=0.013 → family-wise **p≈0.24**). The same audit caught a **systemic financing leak** that had inflated the carry headlines. **No false-KILL was found anywhere.** The conservative verdict got *stronger* under scrutiny, not weaker.

**The deliverable here is not a strategy. It's the methodology — a gauntlet that doesn't lie — plus the most honest record of negative results you'll find in crypto.**

---

## Why a clean backtest is not evidence

If you've ever built a strategy that looked amazing in-sample and bled out live, this section is the whole reason it happened. A pretty in-sample Sharpe is the *cheapest* thing in markets. Across ~111 attempts, the same handful of illusions killed nearly everything:

- **Coincident long-beta in disguise.** A long/flat or long/short overlay on a secularly rising asset posts a 1.6–1.8 Sharpe and a real-looking monthly P&L that is just **timed BTC exposure** — and loses to buy & hold once you deflate and match exposure. (Supertrend, CCI, hash-ribbons, net-liquidity, dual-momentum.)
- **The h=0 order-flow tautology.** Volume "signals" whose entire edge lives in the *current* bar (the trades *are* the move); strictly lagged one bar, the edge is ~0. (The whole free-tier CVD / OBV / taker-ratio set.)
- **Selection inflation under honest N.** A grid-best that evaporates once Deflated Sharpe and the Harvey-Liu haircut count **every** config you tried — and/or sign-flips on data the search never saw. (Cointegration pairs DSR 0.029 at N=420; the audit flipped three on-chain edges on exactly this defect.)
- **De-risking dressed up as timing**, **reverse-causality echoes** (stablecoin mints *lag* price; "adoption" series are repackaged price momentum), and **price-clock spurious regressions** (Stock-to-Flow correlates with a clock, not a cause).

A signal can *pass* the deflation and overfitting gates — which only certify "this Sharpe isn't luck-of-selection" — and still die at the two gates that test *economic* edge: **beating the right baseline** and the **consume-once holdout**. That gap is where almost everything lives.

> The one sentence: a surrogate **pass** proves a signal's *structure is non-random*. It does **not** prove the realized mean is positive-with-significance at honest N on data you never saw. **No lead, in any domain, crossed that line.**

---

## The gauntlet (the part you can actually reuse)

Every hypothesis must clear **all** gates, in this fixed order. The **first** failure is the binding gate reported in the ledger:

```
net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout
```

- **net_of_cost** — taker ~4 bps/side on every position change; borrow/financing charged on the **full** levered/short notional, never 1 unit.
- **baselines** — beat buy & hold **and** a matched-exposure benchmark **and** a random-lottery control; cross-sectional books must be beta-neutral on an honest out-of-sample hedge.
- **deflated_sharpe @ honest N** — counting **every** config tried.
- **block_bootstrap CI · CPCV / PBO < 0.5 · Harvey-Liu haircut** (often the true binding gate).
- **the right surrogate per claim** — phase-randomization, cross-sectional shuffle, GARCH-simulated, shuffled-VRP, calendar-reanchor — **plus the family-wise MAX-statistic for any searched grid.**
- **consume-once holdout** — data the search never saw, spent exactly once.

**SURVIVE** = all pass. **PROMISING** = passes net + baselines + surrogate + holdout but trips a multiple-testing / Deflated-Sharpe gate. Otherwise **KILL** — and a KILL is a valid, valuable result.

It's `runGauntlet()` in [scripts/edgehunt-D5/harness.ts](scripts/edgehunt-D5/harness.ts), built from the committed primitives (`computeDeflatedSharpeRatio`, `estimateCscvPbo`, `blockBootstrapConfidenceInterval`) in [src/lib/training/statistical-validation.ts](src/lib/training/statistical-validation.ts). The full protocol is documented in **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)**.

---

## $0, reproducible, agent-ready

Everything runs at **$0** on free public data — Binance / Bybit / OKX public REST, Coin Metrics Community (no key), Deribit public DVOL, FRED no-key CSV, alternative.me Fear & Greed, Google Trends, GDELT. The stack is **TypeScript**, run with **tsx**; the gates are pure and deterministic (seeded). Realistic cost is charged on every position change, honest N counts every config, each holdout is spent exactly once. Inputs reuse on-disk caches under `output/`, so every verdict re-derives with no paid infrastructure.

```bash
./node_modules/.bin/tsx scripts/edgehunt-D5/harness.ts
```

The agent contract — how an autonomous agent picks a target, wires it through `runGauntlet()`, and reports a binding gate — is in **[AGENTS.md](AGENTS.md)**.

---

## Think yours survives?

Genuinely — maybe it does. This is a falsification lab, and **a KILL is a valid, valuable result.** I want to be wrong. Here's the deal:

1. **Fork it** → `github.com/kimlage/crypto-edge-search`. Pick a target from [docs/BACKLOG.md](docs/BACKLOG.md) (155 techniques queued, each with its right surrogate null) or bring your own rule.
2. **Add your rule** and run it through the *same* `runGauntlet()` — same costs, same honest N, the **right surrogate null** for your claim (a **family-wise MAX-statistic** if you searched a grid), and a consume-once holdout spent exactly once.
3. **Report the binding gate + the decisive number.** Open a PR or issue. To challenge an existing verdict, re-derive its number from the committed primitives and show which gate it actually binds on.

**If it passes the protocol, I'll post it.** Publicly. With your name on it. That's a standing offer. Change the *target* — never the gates.

---

## Read deeper

| Document | What it is |
|---|---|
| **[docs/INDEX.md](docs/INDEX.md)** | **🧭 Start here — the wiki home.** The cross-domain concept map, the unified funnel, the glossary index, and reader journeys (newcomer / auditor / agent / reproducer). |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Every load-bearing term, one paragraph each — the gauntlet gates, the verdict scheme, and the prediction-market nulls. |
| [docs/RESULTS.md](docs/RESULTS.md) | The full canonical ledger — binding gate + decisive number for every one of the ~111 hypotheses. |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | The committed anti-overfitting protocol in full — every gate, every surrogate null, the honest-N rule. |
| [docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md](docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md) | The 8-domain campaign roll-up — the leads in detail, the per-domain KILL ledger, the two-layer audit. |
| [docs/BACKLOG.md](docs/BACKLOG.md) | 155 techniques queued to falsify, each with its right surrogate null, honest-N concern, and references. |
| [AGENTS.md](AGENTS.md) | The agent contract — how to run a hypothesis end-to-end through the gauntlet. |
| [`output/edgehunt-*/SUMMARY.md`](output/) | Per-domain syntheses, so any verdict can be challenged against the *same* gates. |
| **[SYNTHESIS.md](SYNTHESIS.md)** | **The unified verdict across both domains (crypto + Polymarket): where the edge is NOT, and why.** |
| **[docs/polymarket/](docs/polymarket/)** | **The Polymarket prediction-markets campaign** — [overview](docs/polymarket/README.md), [results](docs/polymarket/RESULTS.md), [methodology](docs/polymarket/METHODOLOGY.md), [reverse-engineering](docs/polymarket/REVERSE_ENGINEERING.md), [money-management & arbitrage](docs/polymarket/MONEY_MGMT_AND_ARB.md), [external-information edges](docs/polymarket/EXTERNAL_INFO_EDGES.md), [weather studies](docs/polymarket/WEATHER.md), the [honest evaluation/audit](docs/polymarket/EVALUATION.md), and the [credibility backlog](docs/polymarket/CREDIBILITY_BACKLOG.md). Run it: `scripts/campaign-D/`. |

---

*MIT License. A negative result, honestly gated, is the result. Nothing here is investment advice — nothing here is profitable today. The deliverable is the methodology, and the honesty.*
[github.com/kimlage/crypto-edge-search](https://github.com/kimlage/crypto-edge-search)
