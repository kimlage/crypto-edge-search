# Research Backlog — Trading Techniques to Falsify Through the Gauntlet

*[Home](INDEX.md) · [Crypto](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](GLOSSARY.md) · [Polymarket](polymarket/README.md)*

> **CANONICAL VERDICTS:** `output/results-ledger.json` is the single machine-readable source of truth for every audited verdict (see `docs/CANONICAL_STATE.md`). Some verdict cells in this backlog predate the two-layer adversarial audit; where they disagree with the ledger, **the ledger wins**. Cells corrected to the audited reality are tagged `[audited: …]`. Audited headline: **0 SURVIVE, 2 PROMISING (XS Donchian + dated-futures-unlevered-thin), rest KILL/DEFERRED.**

**Status:** living research backlog · **Total hypotheses:** 155 across 8 domains (D1–D8)
**Last compiled:** 2026-06-01 · **License posture:** MIT project, $0 cloud budget, free public data only.

## 1. What this is

This is the **research backlog** of trading techniques — the ones real traders, retail communities, and quant desks actually use — queued to be falsified through the project's committed gauntlet:

```
src/lib/validation/strategy-validator.ts → validateStrategy
  net-of-cost PnL
  → baselines (buy-&-hold / equal-weight / random-lottery / linear-one-layer)
  → Deflated Sharpe @ honest N            (Bailey & López de Prado 2014)
  → CPCV / PBO < 0.5                       (Bailey-Borwein-LdP-Zhu 2017; López de Prado 2018)
  → Harvey–Liu haircut (Bonferroni/Holm/BHY) (Harvey & Liu 2015)
  → surrogate / placebo null               (phase-randomization, block-bootstrap, bracket-on-surrogate, calendar-reanchor, cross-sectional shuffle, panel/marginal seed)
  → consume-once forward holdout           (validation2 — spent on first contact)
```

The statistical primitives are committed in `src/lib/training/statistical-validation.ts`
(`computeDeflatedSharpeRatio` with `trialCount`, `computeProbabilisticSharpeRatio`,
`blockBootstrapConfidenceInterval`, `analyzeThresholdSensitivity`, `estimateCscvPbo`),
plus the forward holdout (`validation2`) and the negative-archive memory
(`robust-selection.ts` / `negative-space.ts`). The path `validateStrategy` is the intended
committed wrapper that chains them; where a named gate is not yet coded (phase-randomization /
IAAFT surrogate, cross-sectional-shuffle null, bracket-on-surrogate, calendar-reanchor,
Harvey–Liu haircut) it is flagged in §6 (Methodology upgrades).

**Same methodology, same criteria, as the 35 already done.** This backlog applies the
identical bar that produced **33 KILL / 2 sub-risk-free carry survivors** out of 35 tested
hypotheses (E1–E3, T1–T10, TA1–TA4, WF-A..D, R2, R3/R4, C1–C4, OC1, NF1–NF3, NA–ND). Every
backlog item that is a variant/refinement of a tested ID is **cross-referenced** so nothing is
re-run blindly.

**KILL is a valid outcome — and usually the high-value one.** The project is a falsification
lab. Because the techniques here are the most-used in the world (head-and-shoulders, RSI/MACD
cousins, Fear & Greed, the halving cycle, Stock-to-Flow, GEX, VPIN, pairs trading, the
"Transformer for crypto"), a clean, honest, public **KILL** of a widely-believed technique is
exactly as valuable as a survive — it is shareable evidence. A handful of items are
genuinely-uncertain or worth-a-shot (residual momentum, PCA stat-arb, the variance risk
premium, cross-venue funding dispersion, token unlocks); those are prioritized in §5.

**Every item carries references** (authors, year, title, venue). Citations the author was not
fully sure of are flagged `~approx`. The consolidated, deduplicated bibliography is §7.

### The recurring kill mechanism

Across the 35 tested, almost every false positive died the same way: an apparently-positive
net Sharpe that is really **long-beta / coincident BTC exposure** (crypto is a one-factor
market — BTC drives ~70–80% of alt variance), or a **selection artifact** from a large config
grid, exposed by the **surrogate** (a structure-destroying null reproduces the "edge") or the
**consume-once holdout** (passes in-sample, dies OOS; e.g. TA4 holdout net annual Sharpe ≈ −1.0;
NF1 binding gate = surrogate; ND placeboP ≈ 0.75, OOS Sharpe −0.017). The per-domain "key
control" column below names the specific blade that separates real conditional edge from these.

---

## 2. Master table (155 hypotheses)

Legend — **$0?**: yes = backfillable from free public sources (Binance/Bybit/OKX public REST,
Coin Metrics Community, DefiLlama, Deribit public, FRED/stooq); partial = free but
history-/quality-/fidelity-limited or forward-collect-only; no = requires paid history.
**Prior**: KILL = KILL-most-likely · WS = worth-a-shot · UNC = genuinely-uncertain · KILL!=
near-certain / definitional / debunked. **Status**: NEW, or *refines* a tested ID.

### D1 — Classic technical indicators (beyond TA4) + price-action / chart patterns

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D1-01 | Ichimoku Cloud (Kumo + TK cross + Chikou) | yes | phase-rand + block-bootstrap | KILL | refines T1/T2/TA2 + TA4 |
| D1-02 | Parabolic SAR stop-and-reverse | yes | bracket-on-surrogate (exit) + phase-rand (entry) | KILL | refines T1/T2 + NF2 |
| D1-03 | Supertrend (ATR-band trend) | yes | vol-preserving (GARCH/IAAFT) surrogate | KILL | refines TA4(BB/Donchian)+T2/TA2 |
| D1-04 | VWAP / anchored-VWAP reversion | yes | intraday block-bootstrap; calendar-reanchor (anchored) | KILL (intraday UNC) | refines TA3 / C4·NA |
| D1-05 | Keltner channel + Bollinger/Keltner squeeze | yes | GARCH-preserving block-bootstrap | KILL (direction) | refines TA4(BB) |
| D1-06 | Commodity Channel Index (CCI) | yes | phase-rand + block-bootstrap | KILL | refines TA4(RSI/Stoch) |
| D1-07 | Williams %R | yes | phase-rand + block-bootstrap | KILL! | refines TA4(Stoch) |
| D1-08 | Stochastic variants (slow/full/StochRSI) | yes | phase-rand + block-bootstrap | KILL | refines TA4(Stoch) |
| D1-09 | Heikin-Ashi smoothed trend | yes | phase-rand, recompute HA on surrogate | KILL | refines TA4(MA)+T1/T2 |
| D1-10 | Renko / range bars | yes | phase-rand + re-Renko-ize; causal-fill control | KILL | refines TA4(Donchian)+NF1/NF2 fill |
| D1-11 | ADX/DMI directional system (+DI/−DI + ADX gate) | yes | phase-rand + recompute DMI | KILL | refines TA4(ADX) |
| D1-12 | Aroon / Vortex / CMF / OBV cousins | yes | joint price-volume block-bootstrap | KILL | refines TA4(Donchian/ADX) |
| D1-13 | Head-and-Shoulders neckline break | yes | phase-rand + **detector-on-surrogate** + calendar placebo | KILL! | NEW (sibling NF1/NF3) |
| D1-14 | Double/Triple tops & bottoms | yes | phase-rand + detector-on-surrogate | KILL! | refines NF1 |
| D1-15 | Triangles / flags / pennants / wedges | yes | GARCH-preserving + detector-on-surrogate | KILL | refines TA4(BB)+D1-05+T1/T2 |
| D1-16 | Candlestick patterns (engulfing/doji/hammer/star) | yes | OHLC block-bootstrap + bar-shuffle + context placebo | KILL (15m-ctx UNC) | refines NF3+TA3 |
| D1-17 | Wyckoff accumulation/distribution (spring/upthrust) | yes | joint price-volume bootstrap + volume-shuffle | KILL (mechanized UNC) | NEW (NF1+OC1+volume) |
| D1-18 | Elliott Wave + Fibonacci wave ratios | yes | phase-rand + **Fibonacci-ratio placebo** | KILL! (non-falsifiable) | NEW (Fib + NF1) |
| D1-19 | Harmonic patterns (Gartley/Bat/Butterfly/Crab) | yes | phase-rand + Fib-ratio placebo | KILL! | NEW (Fib+NF1+NF3) |
| D1-20 | Trendline breaks (auto-constructed) | yes | phase-rand + detector-on-surrogate (causal fit) | KILL! | refines NF1 |
| D1-21 | Automated pattern library (Lo-Mamaysky-Wang kernel) | yes | phase-rand + whole-detector-on-surrogate | UNC (lean KILL) | NEW umbrella (NF3) |

### D2 — Volume-based & market-microstructure / order-flow (refines TA3)

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D2-V1 | On-Balance Volume divergence/trend | yes | phase-rand, regenerate OBV on surrogate | KILL | refines TA4 |
| D2-V2 | VWAP-deviation band reversion | yes | phase-rand + regenerate VWAP/bands | KILL (anchored WS) | refines TA4(BB) |
| D2-V3 | Cumulative Volume Delta trend/divergence | yes | block-bootstrap signed-flow; **h≥1 lag** | UNC (lean KILL) | refines TA3 |
| D2-V4 | Accumulation/Distribution & Chaikin Money Flow | yes | phase-rand reconstruct OHLC + ADL/CMF | KILL | refines TA4 |
| D2-V5 | Money Flow Index (volume-weighted RSI) | yes | phase-rand + regenerate MFI | KILL | refines TA4(RSI) |
| D2-V6 | Volume-confirmed breakouts | yes | phase-rand + return→volume map (preserve mech link) | KILL | refines TA4(Donchian)+TA2 |
| D2-V7 | Volume Profile POC / value-area / naked POC | yes | structure-destroying surrogate (NF1 protocol) | KILL | NEW (NF1 in volume-space) |
| D2-V8 | Klinger / Volume Osc / Ease-of-Movement | yes | phase-rand + regenerate; family-wide N | KILL | refines TA4 |
| D2-M1 | VPIN order-flow toxicity | yes | block-bootstrap bucketed flow; beat realized-vol | UNC (lean KILL) | refines TA3 |
| D2-M2 | Kyle's λ / Amihud illiquidity (timing + premium) | yes | block (timing) / cross-sectional shuffle (premium) | KILL | refines TA3 + R2 |
| D2-M3 | Bid-ask bounce / Roll-measure reversion | yes | block-bootstrap; **cost gate is decisive** | KILL! (taker) | NEW (sibling NF2) |
| D2-M4 | Trade-size clustering / "whale tape" | yes | block-bootstrap size, break size→return | KILL | refines TA3 + D2-V3 |
| D2-M5 | Trade-flow autocorrelation (order-flow long memory) | yes | block-bootstrap, preserve ACF break return | KILL | refines TA3 + D2-V3 |
| D2-M6 | Footprint / delta-divergence / absorption | yes | block-bootstrap signed stream + NF1 level | KILL | refines TA3+NF1+D2-V3 |
| D2-O1 | Order-book imbalance (OBI) | partial (fwd-collect L2) | block-bootstrap (OBI, fwd-ret) | UNC (lean KILL, real-but-sub-cost) | refines TA3 |
| D2-O2 | Order-Flow Imbalance (OFI) | partial (fwd-collect L2) | block-bootstrap; h=0 vs h≥1 | KILL (sub-cost) | refines TA3 / O1 |
| D2-O3 | Depth / liquidity-gradient / book slope | partial (fwd-collect L2) | block-bootstrap; spoof-strip + vol-proxy | KILL | refines TA3+NF1+M2 |
| D2-O4 | Queue-position / micro-price (maker signal) | partial (not $0 as alpha) | block-bootstrap (micro-price, next-mid) | KILL! (maker edge) | refines TA3 (sibling M3) |
| D2-O5 | Spoofing / iceberg detection | partial (fwd-collect L2) | block-bootstrap; pre-register detector | KILL! | refines TA3 (NF3 honest-N) |
| D2-D1 | Liquidation cascades / liq-level magnets | partial (forceOrder live; OI-drop proxy $0) | bracket-on-surrogate + calendar-reanchor + NF1 | UNC (lean KILL) | refines TA3+NF1+T7 |
| D2-D2 | OI×price×funding flow-state matrix | partial (OI shallow ~30d free) | phase/block, lag state h≥1 | KILL | refines T7 + TA3 |
| D2-D3 | Taker buy/sell ratio (free perp CVD) | yes (history-limited) | block-bootstrap; h≥1 lag | KILL | refines T7 + D2-V3 |

### D3 — Volatility-based + Options / Derivatives

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D3-A1 | Bollinger squeeze → vol breakout | yes | IAAFT + GARCH-matched (preserve squeeze) | KILL (direction) | refines TA4 / TA3 (NEW framing) |
| D3-A2 | ATR/Keltner/Chandelier vol breakout | yes | block-bootstrap; decompose vs TSMOM | KILL | refines TA2 + TA4(Donchian) |
| D3-A3 | GARCH/EGARCH vol-forecast timing filter | yes | GARCH-simulated surrogate | WS (Sharpe) / KILL (alpha) | NEW (cf TA1, A8) |
| D3-A4 | Realized-vol regime switching (Markov/threshold) | yes | block + **regime-shuffle placebo** | KILL | refines NC + WF-A..D |
| D3-A5 | Vol-of-vol (DVOL-of-DVOL / RV-of-RV) | yes (DVOL free) | block-bootstrap joint cascade | KILL | NEW (cf A3/A4/B9) |
| D3-A6 | Leverage-effect / vol sign asymmetry (EGARCH) | yes | symmetric vs asymmetric GARCH sim | KILL | NEW (sub-variant A3) |
| D3-A7 | Intraday/weekly vol calendar | yes | calendar-reanchor placebo | KILL (direction) | refines ND (vol not return) |
| D3-A8 | Vol-targeting / Moreira–Muir overlay | yes | GARCH-simulated (mechanical lift) | UNC (lean KILL net) | refines TA1 |
| D3-A9 | NR7 / inside-bar / ATR-compression breakout | yes | IAAFT/GARCH preserve contraction | KILL (direction) | refines A1 + TA4 |
| D3-B1 | Dealer GEX / gamma walls / zero-gamma flip | partial (fwd-record IV) | strike-shuffle + block + label-shuffle | KILL (high-value) | NEW (extends NA + NF1) |
| D3-B2 | Put/Call ratio sentiment | partial (fwd-record) | block + lag-shuffle | KILL | NEW (cf C3, OC1) |
| D3-B3 | 25-delta risk reversal / skew | partial (fwd-record IV) | block + lead-lag placebo | KILL (direction) | NEW (cf B5/B6) |
| D3-B4 | IV term-structure slope timing | partial (fwd-record IV) | block + lead-lag | KILL (spot) | NEW (cf A3/A4/B5) |
| D3-B5 | Variance Risk Premium harvest (DVOL vs RV) | yes (DVOL free) | tail-matched bootstrap; shuffled-VRP placebo | UNC (best options item) | NEW (carry-survivor analogue) |
| D3-B6 | Short-vol selling (straddle/strangle/iron condor) | partial (DVOL-synthetic) | bracket-on-surrogate (GARCH/jump) | KILL (reduces to B5) | NEW (impl of B5; mirrors NF2) |
| D3-B7 | Covered call / "the wheel" | partial (DVOL-synthetic) | GARCH/jump; beta-matched baseline | KILL (beta + capped VRP) | NEW (cf B5/B6, A8) |
| D3-B8 | Delta-hedged VRP (clean vol isolation) | partial (DVOL-synthetic) | jump-matched surrogate | UNC (lean KILL net hedge) | NEW (clean B5/B6) |
| D3-B9 | Deribit DVOL signals (level/mom/revert/DVOL−RV) | yes (DVOL free) | block + lead-lag + calendar-reanchor | KILL (spot); content→B5 | NEW (cf A3, B5) |
| D3-B10 | Max-pain refinement (OI-weighted pin) | partial (fwd-record OI) | strike-shuffle + calendar-reanchor | KILL (sub-cost) | refines NA |
| D3-B11 | Options-implied informed flow ("unusual activity") | partial (incomplete sign) | trade-time/label shuffle | KILL (public data) | NEW (cf B2, TA3) |

### D4 — Momentum/trend refinements + mean-reversion / statistical arbitrage

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D4-M1 | Dual momentum (absolute + relative) | yes | cross-sectional shuffle + phase-rand panel | KILL | refines T1 + TA2/T8 |
| D4-M2 | Residual / idiosyncratic momentum (beta-neutral) | yes | factor-preserving bootstrap + XS shuffle | **UNC (worth real shot)** | refines T1 |
| D4-M3 | 52-week-high (nearness-to-high) | yes | XS shuffle + structure-destroying surrogate | KILL | refines T1 + NF1 |
| D4-M4 | Frog-in-the-pan / information discreteness | yes | XS shuffle + ID-label placebo | KILL | refines T1 |
| D4-M5 | Momentum crashes / vol-scaling (risk-managed) | yes | **scaling-on-surrogate** | KILL | refines TA2 + T1 |
| D4-M6 | Acceleration (2nd-derivative) momentum | yes | phase-rand + XS shuffle | KILL! | refines T1/TA2 |
| D4-M7 | TS×XS momentum combo (Goyal-Jegadeesh) | yes | XS shuffle + phase-rand panel | KILL (diagnostic) | refines T1 + TA2 |
| D4-M8 | Factor momentum (sector/style) | yes (tags soft) | phase-rand factor series + XS shuffle | KILL | refines TA2 + C1–C4 |
| D4-S1 | Ornstein–Uhlenbeck single-name reversion | yes | phase-rand + block + bracket-on-surrogate | KILL | refines T2/T-reversal |
| D4-S2 | Distance pairs (Gatev-Goetzmann-Rouwenhorst) | yes | selection-on-surrogate + bracket-on-surrogate | KILL | refines T3 |
| D4-S3 | Cointegration pairs (Engle-Granger / Johansen) | yes | cointegration-on-surrogate + pair-PBO | KILL | refines T3 / S2 |
| D4-S4 | Kalman dynamic hedge ratio (time-varying β) | yes | Kalman-on-surrogate; anti-lookahead audit | KILL | refines T3 / S3 |
| D4-S5 | Copula pairs (tail dependence) | yes | copula-on-surrogate; family-selection N | KILL! | refines T3 / S2 / S3 |
| D4-S6 | PCA basket stat-arb (Avellaneda-Lee s-score) | yes | panel/marginal seed + XS shuffle + bracket | **UNC (worth real shot)** | refines T3 (sibling M2) |
| D4-S7 | Short-term reversal (1d / weekly) | yes | XS shuffle + skip-day microstructure control | KILL (net) | refines T2/T-reversal |
| D4-S8 | Overnight vs intraday / session decomposition | yes | calendar-reanchor (boundary) | KILL | refines T-reversal + ND |
| D4-S9 | Lead-lag stat-arb (BTC leads alts) | yes | break cross-lag bootstrap + leader-shuffle | KILL | refines C1 + TA3 |
| D4-S10 | Basket vs constituents (index-arb analogue) | yes (synthetic) | panel/marginal seed | KILL! (definitional) | refines T3 / S6 (neg control) |

### D5 — On-chain / crypto-native valuation & flow (beyond OC1 / NB)

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D5-01 | SOPR / aSOPR reset-to-1 | partial (recon; UTXO paid) | phase-rand + price-only control | KILL | NEW (cf OC1) |
| D5-02 | STH-SOPR vs LTH-SOPR divergence | partial (age split paid) | panel seed + **cohort-shuffle** | **UNC (worth a shot)** | NEW |
| D5-03 | MVRV-Z extreme bands | yes | phase-rand + price-only standardized control | KILL (honest-N) | refines OC1 |
| D5-04 | NUPL zones | yes | show NUPL ≡ f(MVRV); shared N | KILL! (re-skin) | refines OC1 / D5-03 |
| D5-05 | Realized price as dynamic S/R | yes | bracket-on-surrogate (NF1 control) | KILL | refines NF1 (on-chain level) |
| D5-06 | NVT ratio extreme | yes | phase-rand + denominator-shuffle | KILL | NEW |
| D5-07 | NVTS & NVT golden cross | yes | MA-crossover-on-surrogate | KILL | refines TA4(MA-cross) |
| O3-NVTS | NVT-signal refinement (strongest causal, free fee-throughput proxy) | proxy-free (canonical TxTfrValAdjUSD/NVTAdj are PAID) | phase-rand surrogate + price-clock + orthog-vs-momentum | KILL [audited-kill: family-wise surrogate] | refines D5-06/07 |
| D5-08 | Exchange netflow / reserve-depletion trend | partial (entity-list dep) | block + detrend-vs-price | KILL | refines NB |
| D5-09 | Puell Multiple (miner-revenue extreme) | yes | phase-rand + Mayer price-only control | KILL | NEW (Mayer cousin) |
| D5-10 | Hash Ribbons (miner capitulation buy) | yes | MA-cross-on-surrogate + price-decompose | KILL (honest-N) | NEW (TA2/TA4 overlap) |
| D5-11 | CDD / Dormancy (old coins move) | partial (CDD paid) | calendar-reanchor + **age-shuffle** | **UNC (worth a shot)** | NEW (orthogonal-to-price) |
| D5-12 | HODL waves / realized-cap HODL waves | partial (fine bands paid) | long-block bootstrap + calendar-reanchor | KILL | NEW |
| D5-13 | Stablecoin Supply Ratio (SSR) & oscillator | yes | phase-rand + denominator-isolation + era control | KILL (flow-var WS) | NEW |
| D5-14 | Stablecoin net mint/burn impulse | yes | calendar-reanchor + lead-lag (no h=0) | KILL (WS impulse) | NEW (impulse var of D5-13) |
| D5-15 | Whale / large-holder accumulation | partial (cohort paid) | block + entity-shuffle; ETF de-confound | KILL | NEW |
| D5-16 | Active-address / Metcalfe valuation | yes | phase-rand residual; freeze exponent OOS | KILL | NEW |
| D5-17 | Stock-to-Flow deviation (debunked, adversarial) | yes | spurious-regression / Granger-Newbold null | KILL! (teaching kill) | NEW (adversarial) |
| D5-18 | Thermocap / Thermocap-multiple floor | yes | phase-rand + price-only control | KILL | NEW (realized-cap sibling) |
| D5-19 | Reserve Risk (conviction vs price) | partial (dormancy paid) | phase-rand + age-shuffle; decompose price term | UNC (lean KILL) | NEW (D5-11 + price) |
| D5-20 | On-chain confluence ("3-of-5 agree") | yes | panel/marginal seed; eigenstructure → 1 factor | KILL! | refines NF3 (on-chain) |

### D6 — Sentiment / alternative data + cross-asset / macro (beyond NC)

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D6-S1 | Crypto Fear & Greed contrarian | yes | block/phase + **AR-matched placebo index** | KILL | NEW (refines NC + T-reversal) |
| D6-S2 | Funding-rate-as-sentiment (contrarian fade) | yes | block + carry-neutralized placebo | WS (structure) / KILL (timing) | refines T-carry/TA1 + survivors |
| D6-S3 | Social volume / sentiment (LunarCrush/Santiment) | partial (premium paid) | block + cross-sectional shuffle | KILL (alt-XS UNC) | refines R2 + C-rotation |
| D6-S4 | Google Trends search-interest | partial (vintage trap) | phase-rand + calendar-reanchor; PIT vintage | KILL | NEW (sibling S3) |
| D6-S5 | News sentiment (GDELT tone / density) | yes (GDELT free) | block + AR-matched tone placebo | KILL (tested 2026-06-01) | DONE — corr(tone_{t-1},fwdRet)=0.00; best net Sh 1.27 < B&H 1.24, fails AR-placebo (p=0.16) + holdout (-1.48) |
| D6-S6 | Options put/call ratio sentiment (Deribit) | yes | block + bracket-on-surrogate | KILL | refines NA |
| D6-S7 | Long/short account ratio (Binance L/S) | yes (history-limited) | block + AR-matched placebo | KILL | NEW (sibling S2) |
| D6-M1 | BTC vs US rates / 2s10s curve | yes (FRED/stooq) | long-block bootstrap + macro-marginal seed | KILL | refines NC / ND |
| D6-M2 | Credit spreads (HY OAS) risk-appetite | yes (FRED) | long-block bootstrap | KILL | refines NC / ND |
| D6-M3 | Global dollar liquidity (WALCL−TGA−RRP) | yes (FRED) | long-block + macro-marginal seed; cycle-count N | KILL (tradability) / UNC (regime) | refines NC / ND |
| D6-M4 | Real yields & gold ("digital gold") | yes (FRED/stooq) | long-block bootstrap + pair shuffle | KILL | NEW (sibling M1/M3) |
| D6-M5 | Spot BTC ETF flows → next-day | partial (~2024+ short) | block + event-study placebo | KILL (lagged) / UNC (short N) | NEW (cf C4) |
| D6-M6 | DXY/SPX correlation-regime trading | yes (stooq/FRED) | joint block preserving cross-corr | KILL | refines NC |
| D6-M7 | Risk-parity / vol-target crypto sleeve | yes | allocation-on-surrogate + macro-marginal seed | KILL (alpha) / WS (risk-shaping) | NEW (parallels carry/stops) |

### D7 — Calendar/seasonality + event-driven flows

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D7.1 | Four-year halving cycle & post-halving drift | yes (PIT-clean) | calendar-reanchor + phase-rand | KILL! (n≈3) | NEW |
| D7.2 | Sell-in-May / Halloween | yes | calendar-reanchor / month-permutation | KILL! | NEW (cf T4/ND) |
| D7.3 | Day-of-week / Monday effect | yes | block + DoW-label permute + phase-rand | KILL (shown by ND) | refines ND |
| D7.4 | Weekend effect / CME-gap interaction | yes (PIT-clean) | bracket-on-surrogate + calendar-reanchor | KILL | refines ND + D7.20; NF2 |
| D7.5 | Turn-of-month (TOM) | yes | calendar-reanchor + monthly block | KILL | refines T6 |
| D7.6 | Monthly/quarterly/index-rebalancing dates | partial (PIT-fragile) | calendar-reanchor + XS shuffle | KILL | NEW (cf C1/C4, D7.16) |
| D7.7 | Options/futures expiry / max-pain | yes (Deribit/CME free) | calendar-reanchor + bracket + placebo-strike | KILL | refines NA |
| D7.8 | US-session vs Asia-session | yes | phase-rand + hour-label permute | KILL (direction) | refines ND |
| D7.9 | Tax-loss selling (Dec dip / Jan effect) | yes | calendar-reanchor + up/down-year stratified block | **WS (real mechanism)** | NEW |
| D7.10 | Token unlocks / vesting cliffs | partial (calendar PIT-fragile) | calendar-reanchor + XS placebo + bracket | **UNC (strongest event)** | NEW |
| D7.11 | Airdrops / post-airdrop dumps | partial (survivorship) | calendar-reanchor + XS placebo + bracket | KILL | NEW (overlaps C4) |
| D7.12 | Exchange listings / delistings | partial (PIT-fragile) | calendar-reanchor + XS placebo | KILL | refines C4 (delist NEW) |
| D7.13 | Governance votes / proposals | yes (Snapshot/Tally PIT) | calendar-reanchor + XS placebo | KILL (UNC, high-value) | NEW |
| D7.14 | Protocol hacks & exploits (post-event drift) | partial (timestamp-fragile) | calendar-reanchor + bracket + XS contagion | KILL! (un-capturable) | NEW |
| D7.15 | ETF approval / launch + flow-following | yes (flows PIT T+1) | calendar-reanchor (n=1) / placebo flow | KILL (approval n=1) / WS-KILL (flow) | NEW |
| D7.16 | Index inclusions | partial (PIT-fragile) | calendar-reanchor + XS placebo | KILL | NEW (≈D7.6) |
| D7.17 | Mainnet launches / network upgrades | yes (PIT-clean) | calendar-reanchor + XS placebo + bracket | KILL (n=1 each) | NEW (cf D7.1) |
| D7.18 | Stablecoin issuance / printing (mint-as-event) | yes (PIT-clean) | block/phase + placebo mint; lead-lag | KILL (WS) | NEW (cf OC1, carry) |
| D7.19 | Funding-rate settlement timing | yes | calendar-reanchor stamps + block | KILL | refines carry/TA1 |
| D7.20 | CME gap fill (standalone) | yes | **random-level placebo** + bracket | KILL! | NEW (cf D7.4, NF1) |
| D7.21 | Crypto pre-FOMC drift / macro events | yes (PIT-clean) | calendar-reanchor + block | **WS (KILL on residual)** | NEW (cf NC) |

### D8 — ML / quant methods + portfolio construction + carry/arb refinements

| ID | Technique / belief | $0? | Right surrogate null | Prior | Status |
|---|---|---|---|---|---|
| D8-A1 | GBDT (XGBoost/LightGBM) on cross-sectional features | yes | **cross-sectional shuffle** + purged CPCV | KILL (WS if carry-fed) | NEW (cf R3/R4, D1-r2) |
| D8-A2 | LSTM/TCN/Transformer price-sequence models | yes | **phase-rand / IAAFT** + block-bootstrap | KILL! | refines R3 + neural probes |
| D8-A3 | RL execution/position agent (DQN/PPO) | yes | block-bootstrap many env paths; random-policy | KILL (alpha) / UNC (execution) | NEW (cf R3/R4) |
| D8-A4 | HMM / regime-switching gate of a base signal | yes | block-bootstrap + calendar-reanchor labels | KILL (alpha) / WS (overlay) | refines NC + TA1 |
| D8-A5 | Change-point detection (CUSUM/BOCPD/PELT) | yes | phase-rand + block (false-alarm rate) | KILL (alpha) / WS (de-risk) | NEW (cf A4, NF2) |
| D8-A6 | Feature-importance signal distillation | yes | cross-sectional shuffle; purged MDA | KILL (methodology) | NEW (layer over A1) |
| D8-A7 | Ensemble stacking of weak signals | yes | block-bootstrap base panel + marginal seed | **UNC (if carry-fed)** | NEW (consumes survivors+T1–T10) |
| D8-B1 | Risk parity (inverse-vol / ERC) | yes | block-bootstrap cov window + XS shuffle | KILL (return) / WS (risk) | NEW (cf C1, B5) |
| D8-B2 | Kelly / fractional-Kelly sizing | yes | block-bootstrap trade sequence; zero-edge book | WS (¼–½) / KILL (full) | NEW (sizing over survivors) |
| D8-B3 | CPPI / portfolio insurance overlay | yes | **bracket/path-on-surrogate** | KILL (return) / WS (floor) | NEW (cf NF2, TA2) |
| D8-B4 | Rebalancing premium / vol harvesting | yes | phase-rand matched-corr + XS shuffle | KILL (crypto corr too high) | NEW (cf B1, C1) |
| D8-B5 | Minimum-variance / GMV + shrinkage | yes | block-bootstrap window + XS shuffle | KILL (return) / WS (variance) | NEW (sibling B1) |
| D8-B6 | Trend-overlay (TSMOM) on a carry book | yes | block joint panel + calendar-reanchor trend | **UNC** | refines TA2 (overlay on survivors) |
| D8-C1 | Cross-venue funding-rate dispersion | yes | **cross-sectional shuffle** venue→funding | **UNC (best Part-C)** | refines D1-r2 + survivors |
| D8-C2 | Triangular arbitrage (single venue) | yes (latency crux) | block snapshot + latency-injection placebo | KILL! | NEW (cf TA3) |
| D8-C3 | Perp-spot basis (cash-and-carry) | yes | block funding series + bracket (liq path) | KILL [audited: perp-spot carry under-earns T-bills on tail-adjusted basis] | refines survivors / T9 |
| D8-C4 | DeFi lending vs perp-funding arb | yes (DefiLlama) | cross-sectional shuffle + block | KILL (risk premium) | NEW (cf C1/C3, OC1) |
| D8-C5 | Liquid-staking basis (stETH/rETH) | yes (DefiLlama/on-chain) | block basis + bracket (queue duration) | WS (yield) / KILL (convergence) | NEW (cf C3/C4) |
| D8-C6 | Cash-and-carry on dated futures | yes | block basis-to-expiry + bracket + XS expiries | PROMISING (unlevered-thin only) [audited: levered headline cut ~2x by financing leak; only a thin ~4.9%/yr unlevered market-neutral excess survives] | refines survivors / C3 |

---

## 3. How to read the per-domain entries

The full per-domain backlog files (with the complete write-ups this table summarizes) live at:

- `output/backlog/d1-classic-ta-and-price-action.md` (D1, 21)
- `output/backlog/d2.md` (D2, 22)
- `output/backlog/D3.md` (D3, 20) *(also mirrored under the repo-root `output/backlog/`)*
- `output/backlog/D4.md` (D4, 18)
- `output/backlog/d5-onchain-crypto-native.md` (D5, 20)
- `output/backlog/d6-sentiment-cross-asset-macro.md` (D6, 14)
- `output/backlog/d7.md` (D7, 21)
- `output/backlog/D8.md` (D8, 19) *(also mirrored under the repo-root `output/backlog/`)*

Each entry there carries: **name & popular belief**, **mechanism** (why it might work or why
it is folklore), **how-to-test** (data + $0 feasibility, the right surrogate null, the honest-N
concern, the key control that separates real edge from long-beta / coincident exposure /
data-mining), **honest prior**, **status** (NEW or refines a tested ID), and **references**.

The per-domain sections below (§4) give the dense, reference-bearing version of every entry,
preserving the references with each item (a hard requirement of this backlog).

---

## 4. Per-domain entries (with references)

> Every entry keeps its references. `~approx` flags a citation the author was not fully sure
> of. Surrogate-null and key-control language is preserved verbatim from the domain work because
> it is load-bearing for *which* null is correct for *this* claim.

---

### Domain D1 — Classic technical indicators (beyond TA4) + price-action / chart patterns

**Data on hand / $0:** `output/funding/*_prices_daily.json` (8 majors, 2023-06..2026-05),
`output/nf1/*_daily_ohlc.json` (8 majors, 2079 days, OHLC), committed BTCUSDT 15m base tape;
free top-ups from Binance/Bybit/OKX public REST. **All D1 items are $0.** Prior is heavily KILL:
D1 techniques are overwhelmingly path-dependent overlays on the same long-beta tape; the value
is high-share public falsification.

**D1-01 Ichimoku Cloud.** *Belief:* price above Kumo + TK cross + Chikou-above = go long.
*Mechanism:* a bundle of moving averages + a forward-shifted midpoint band = TSMOM in disguise;
must be implemented strictly causally. *Test:* NF1 OHLC; phase-rand + block-bootstrap; honest N
counts {Tenkan×Kijun×SenkouB×shift×rules×side} >200 configs; key control = beat buy-&-hold
long-beta. *Prior:* KILL. *Status:* refines T1/T2/TA2 + TA4. *Refs:* Hosoda 1969 *Ichimoku Kinko
Hyo* (~approx yr); Linton 2010 *Cloud Charts* (Updata); Patel 2010 *Trading with Ichimoku
Clouds* (Wiley).

**D1-02 Parabolic SAR.** *Belief:* flip on SAR dot cross, built-in trailing stop. *Mechanism:*
convex trailing stop on a trend-follower; no signal, only an exit schedule. *Test:*
bracket-on-surrogate (NF2 null) for exit + phase-rand for entry; key control = net-of-cost
(high turnover → 4bps taker dominates). *Prior:* KILL. *Status:* refines T1/T2 + NF2. *Refs:*
Wilder 1978 *New Concepts in Technical Trading Systems*; Achelis 2000 *Technical Analysis from A
to Z*, 2e (McGraw-Hill).

**D1-03 Supertrend.** *Belief:* ATR-band flip, "cleanest trend indicator." *Mechanism:*
volatility-scaled trend channel (Keltner/Donchian hybrid). *Test:* **vol-preserving
(GARCH/IAAFT) surrogate** mandatory; key control = beat buy-&-hold and TA4's killed
Bollinger-breakout. *Prior:* KILL (huge retail mindshare → public value). *Status:* refines
TA4(BB/Donchian)+T2/TA2. *Refs:* Seban 2000s (popularizer, ~approx); Wilder 1978 (ATR origin).

**D1-04 VWAP / anchored VWAP.** *Belief:* price reverts to VWAP; reclaim anchored-VWAP from
event. *Mechanism:* execution benchmark real, directional signal = mean-reversion claim. *Test:*
15m BTC for true VWAP; intraday block-bootstrap (revert) / **calendar-reanchor** (anchored,
re-anchor to random dates); honest N includes anchor-selection. *Prior:* KILL (intraday-revert
genuinely-uncertain). *Status:* refines TA3 / C4·NA. *Refs:* Berkowitz, Logue & Noser 1988
"Total Cost of Transactions on the NYSE," *J. Finance* 43(1); Madhavan 2002 "VWAP Strategies"
(~approx); Białkowski, Darolles & Le Fol 2008, *J. Banking & Finance* 32(9).

**D1-05 Keltner channel + squeeze.** *Belief:* trade Keltner breakout; BB-inside-Keltner squeeze
→ big move. *Mechanism:* vol-compression→expansion (real magnitude, folklore direction). *Test:*
**GARCH-preserving block-bootstrap** (squeeze must fire on surrogate), then test directional
breakout beats coin-flip; key control = split magnitude (TRUE) from direction (FALSE). *Prior:*
KILL on direction. *Status:* refines TA4(BB). *Refs:* Keltner 1960 *How to Make Money in
Commodities*; Carter 2005 *Mastering the Trade* (TTM Squeeze); Bollinger 2001 *Bollinger on
Bollinger Bands*.

**D1-06 CCI.** *Belief:* >+100 trend / <−100 reversal. *Mechanism:* z-score of typical price =
normalized oscillator, RSI/Stochastic cousin. *Test:* phase-rand + block-bootstrap; key control
= beat killed RSI/Stoch (TA4). *Prior:* KILL. *Status:* refines TA4(RSI/Stoch). *Refs:* Lambert
1980 "Commodity Channel Index," *Commodities*; Achelis 2000.

**D1-07 Williams %R.** *Belief:* <−80 oversold / >−20 overbought. *Mechanism:* Stochastic %K
inverted/rescaled — algebraically equivalent. *Test:* phase-rand; key control = show corr≈1 with
Stochastic → inherit TA4 kill. *Prior:* KILL! (near-tautological). *Status:* refines TA4(Stoch).
*Refs:* Williams 1979 *How I Made One Million Dollars…*; Williams 2011 *Long-Term Secrets to
Short-Term Trading*, 2e (Wiley).

**D1-08 Stochastic variants (slow/full/StochRSI).** *Belief:* %K×%D cross in OB/OS zones times
reversals. *Mechanism:* extra-smoothed reparameterizations of the killed oscillator. *Test:*
phase-rand; honest N = largest oscillator grid in D1 (hundreds); divergence variant needs
swing-detection honest-N. *Prior:* KILL. *Status:* refines TA4(Stoch). *Refs:* Lane 1984 "Lane's
Stochastics," *TASC* 2; Chande & Kroll 1994 *The New Technical Trader* (Wiley); Murphy 1999
*Technical Analysis of the Financial Markets*.

**D1-09 Heikin-Ashi.** *Belief:* stay long while HA candles green, no lower wick. *Mechanism:*
double-smoothed price = lagged MA; causal-HA enforcement is critical. *Test:* phase-rand,
**recompute HA on each surrogate**; key control = beat equivalently-lagged MA + publish
causal-vs-noncausal gap. *Prior:* KILL. *Status:* refines TA4(MA)+T1/T2. *Refs:* Nison 1991
*Japanese Candlestick Charting Techniques*; Valcu 2004 "Using the Heikin-Ashi Technique," *TASC*
22(2).

**D1-10 Renko / range bars.** *Belief:* bricks remove noise, cleaner trends. *Mechanism:*
path-driven re-sampling — discards info, adds no signal; severe look-ahead/fill trap. *Test:*
15m for honest brick formation; phase-rand + **re-Renko-ize**; **causal-fill control** is the
separator. *Prior:* KILL + strong secondary "edge is a fill/look-ahead artifact." *Status:*
refines TA4(Donchian); links NF1/NF2 fill realism. *Refs:* Nison 1994 *Beyond Candlesticks*
(Wiley); practitioner Renko-bias notes (~approx).

**D1-11 ADX/DMI system.** *Belief:* +DI/−DI cross only when ADX>25. *Mechanism:* trend-strength
gate + direction signal = classic trend-following; TA4 killed lone ADX. *Test:* phase-rand +
recompute DMI; key control = does gating add over lone ADX, or just reduce time-in-market /
beta? *Prior:* KILL. *Status:* refines TA4(ADX). *Refs:* Wilder 1978; Gurrib 2018 ADX
market-timing (~approx).

**D1-12 Aroon / Vortex / CMF / OBV cousins.** *Belief:* crossovers/divergences time trends.
*Mechanism:* Donchian/DMI/volume-momentum re-encodings. *Test:* **joint price-volume
block-bootstrap**; OBV/CMF need **volume-shuffle placebo**. *Prior:* KILL. *Status:* refines
TA4(Donchian/ADX). *Refs:* Botes & Siepman 2010 (Vortex, *TASC*); Granville 1963 *Granville's
New Key to Stock Market Profits* (OBV); Chaikin 1980s (CMF, practitioner).

**D1-13 Head-and-Shoulders.** *Belief:* neckline break projects head-to-neckline target; "most
reliable reversal." *Mechanism:* with free swing-detection params you find H&S in any noise; the
stats come from survivorship + subjective selection. *Test:* deterministic ZigZag detector;
phase-rand + **detector-on-surrogate** (if H&S works on noise, folklore) + calendar placebo;
honest N must enumerate detector params. *Prior:* KILL! (highest-value public KILL). *Status:*
NEW, sibling NF1/NF3. *Refs:* Bulkowski 2005 *Encyclopedia of Chart Patterns*, 2e (Wiley); Lo,
Mamaysky & Wang 2000 "Foundations of Technical Analysis," *J. Finance* 55(4); Chang & Osler 1999
"Methodical Madness," *Economic Journal* (H&S not profitable after costs).

**D1-14 Double/Triple tops & bottoms.** *Belief:* two failed pushes → reversal on pivot break.
*Mechanism:* two-touch S/R reversal = NF1's exact construct. *Test:* phase-rand + detector-on-
surrogate; key control = beat NF1 best config. *Prior:* KILL!. *Status:* refines NF1. *Refs:*
Bulkowski 2005; Edwards & Magee 1948 *Technical Analysis of Stock Trends*; Lo-Mamaysky-Wang 2000.

**D1-15 Triangles / flags / pennants / wedges.** *Belief:* continuation breakout, measured move =
flagpole. *Mechanism:* vol-squeeze + trend-continuation (overlaps D1-05 + TA4-BB);
trendline-fit is look-ahead-prone. *Test:* GARCH-preserving block-bootstrap + detector-on-
surrogate; key control = direction (squeeze=magnitude) + continuation=long-beta. *Prior:* KILL.
*Status:* refines TA4(BB)+D1-05+T1/T2. *Refs:* Bulkowski 2005; Edwards & Magee 1948;
Lo-Mamaysky-Wang 2000.

**D1-16 Candlestick patterns.** *Belief:* engulfing/hammer at support = reversal, etc.
*Mechanism:* deterministic functions of 1–3 candles (fully formalizable); prior lit finds little
edge after costs; 24/7 crypto weakens "daily close." *Test:* **OHLC block-bootstrap** + bar-
shuffle + **context-conditioning placebo** {signal-alone vs filter-alone vs conjunction}; honest
N = ~10 patterns × context × horizon × TF (hundreds). *Prior:* KILL (15m-with-context UNC; cost
likely killer). *Status:* refines NF3+TA3. *Refs:* Nison 1991; Morris 2006 *Candlestick Charting
Explained*, 3e; Marshall, Young & Rose 2006 "Candlestick technical trading strategies," *J.
Banking & Finance* 30(8) (no value after data-snooping); Lu, Shiu & Liu 2012, *Review of
Financial Economics* 21(2) (mixed/positive — for balance).

**D1-17 Wyckoff accumulation/distribution.** *Belief:* spring/upthrust + volume → enter ahead of
markup. *Mechanism:* order-flow footprint story; phase-labelling deeply subjective. *Test:*
joint price-volume bootstrap + detector-on-surrogate; key control = **volume-shuffle placebo**
(if spring works with shuffled volume, narrative folklore → reduces to NF1). *Prior:* KILL
(mechanized spring-with-volume genuinely-uncertain). *Status:* NEW (NF1+OC1+volume). *Refs:*
Wyckoff 1931 *The Richard D. Wyckoff Method…*; Pruden 2007 *The Three Skills of Top Trading*
(Wiley); Williams 2005 *Master the Markets* (VSA).

**D1-18 Elliott Wave + Fibonacci ratios.** *Belief:* 5-3 waves + Fib targets forecast the next
wave. *Mechanism:* rules so flexible any path fits ex-post = non-falsifiable (unbounded N). Only
testable kernel: do Fib targets beat random ratios? *Test:* mechanize ZigZag + Fib only;
phase-rand + **Fibonacci-ratio placebo** (replace 0.382/0.618/1.618 with random ratios). *Prior:*
KILL! (full theory rejected as non-falsifiable). *Status:* NEW (Fib + NF1). *Refs:* Elliott 1938
*The Wave Principle* / 1946 *Nature's Law*; Frost & Prechter 1978 *Elliott Wave Principle*;
Lo-Mamaysky-Wang 2000 (epistemics).

**D1-19 Harmonic patterns (Gartley/Bat/Butterfly/Crab).** *Belief:* XABCD Fib geometry → reverse
at D-point PRZ. *Mechanism:* conjunction of Fib-ratio tolerances on swings; rare patterns →
simultaneous high-N (search) + low-N (samples). *Test:* phase-rand + Fib-ratio placebo; almost
certainly insufficient trades. *Prior:* KILL!. *Status:* NEW (Fib+NF1+NF3). *Refs:* Gartley 1935
*Profits in the Stock Market*; Carney 2010 *Harmonic Trading* (FT Press); Pesavento 1997
*Fibonacci Ratios with Pattern Recognition* (Traders Press).

**D1-20 Trendline breaks.** *Belief:* connect swing lows/highs, close beyond = trend change,
retest confirms. *Mechanism:* sloped S/R = NF1 with a slope; slope-fit adds look-ahead. *Test:*
causal line fit (no future touches); phase-rand + detector-on-surrogate; key control = beat NF1
best config. *Prior:* KILL!. *Status:* refines NF1. *Refs:* Edwards & Magee 1948; Bulkowski 2005;
Lo-Mamaysky-Wang 2000.

**D1-21 Automated pattern library (Lo-Mamaysky-Wang kernel).** *Belief:* systematize ALL chart
patterns into one detector, diversify across patterns for a robust edge. *Mechanism:* LMW (2000)
found statistically-detectable conditional info in US equities 1962–96 — but detectability ≠
tradeable, cost-surviving, OOS; crypto is a different regime; the meta-claim is the ultimate
honest-N hazard. *Test:* implement LMW kernel detector as one portfolio; phase-rand +
**whole-detector-on-surrogate** (reproduces LMW test, adds cost/baseline/holdout LMW lacked);
honest N = union of all detector params (largest in backlog). *Prior:* UNC / lean KILL — the one
Section-B item with peer-reviewed gross support, so it earns an honest run. *Status:* NEW
umbrella for D1-13..20 (sibling NF3). *Refs:* Lo, Mamaysky & Wang 2000, *J. Finance* 55(4);
Jegadeesh 2000 (discussion, *J. Finance* — patterns weak/non-robust); Park & Irwin 2007 "What do
we know about the profitability of technical analysis?," *J. Economic Surveys* 21(4);
Bajgrowicz & Scaillet 2012 "Technical trading revisited," *J. Financial Economics* 106(3).

---

### Domain D2 — Volume-based & market-microstructure / order-flow (refines TA3)

**The $0 split.** *Volume half* (OBV, VWAP, CVD-from-trades, A/D, MFI, Volume Profile,
volume-confirmed breakouts): **fully $0** from OHLCV + free historical `aggTrades` (the
`isBuyerMaker` flag gives taker buy/sell sign free). *Microstructure half* (L2 imbalance, depth
gradient, queue, spoofing/iceberg): **NOT $0-backfillable** — no free historical L2 archive
(Tardis/Kaiko/CoinAPI sell it); forward-collect via free websocket only. *Trade-print
microstructure* (VPIN, Kyle-λ, bid-ask bounce, footprint) IS $0 from aggTrades. Liquidations:
`forceOrder` is ws-live-only; OI-drop proxy is $0.

**D2-V1 OBV divergence/trend.** *Belief:* "volume precedes price"; OBV divergence forecasts
breakout. *Mechanism:* OBV near-monotone in price·sign → tautology on a trending asset. *Test:*
$0 OHLCV; phase-rand **regenerating OBV on the surrogate path**; key control = OBV is collinear
with price-MA trend (must beat the autocorrelation-preserving null). *Prior:* KILL. *Status:*
refines TA4. *Refs:* Granville 1963; Murphy 1999; Lo-Mamaysky-Wang 2000 (~approx for OBV).

**D2-V2 VWAP-deviation reversion.** *Belief:* fade ±k·σ VWAP bands; "institutions defend VWAP."
*Mechanism:* equities-microstructure artifact; 24/7 crypto has no close auction. *Test:* $0
bar-VWAP; phase-rand + regenerate VWAP/bands; key control = separate VWAP-revert from generic
AR(1) reversion + cost on intraday turnover. *Prior:* KILL (anchored-from-event worth-a-shot).
*Status:* refines TA4(BB). *Refs:* Berkowitz, Logue & Noser 1988, *J. Finance* 43(1); Madhavan
2002; Konishi 2002 "Optimal slice of a VWAP trade," *J. Financial Markets* 5(2).

**D2-V3 Cumulative Volume Delta.** *Belief:* CVD trend/divergence ("absorption") leads price.
*Mechanism:* informed taker flow (Easley-O'Hara) vs the contemporaneous tautology (the trades
ARE the move). *Test:* **$0 from free aggTrades**; block-bootstrap signed-volume + **strict h≥1
lag**; KEY control = h=0 vs h≥1 attribution (the decisive flow-domain blade). *Prior:* UNC /
lean KILL — most credible volume hypothesis. *Status:* refines TA3. *Refs:* Hasbrouck 1991
"Measuring the Information Content of Stock Trades," *J. Finance* 46(1); Easley, López de Prado &
O'Hara 2012, *RFS* 25(5); Chordia, Roll & Subrahmanyam 2002, *J. Financial Economics* 65(1).

**D2-V4 ADL / Chaikin Money Flow.** *Belief:* close-in-range × volume = accumulation/distribution;
divergence forecasts reversal. *Mechanism:* ad-hoc within-bar location statistic, no theory.
*Test:* $0; phase-rand reconstruct OHLC + recompute ADL/CMF; key control = beat linear baseline
on (range, volume, return). *Prior:* KILL. *Status:* refines TA4. *Refs:* Chaikin (in Achelis
2001); Marshall, Cahan & Cahan 2008 "Does intraday technical analysis… have value?," *J.
Empirical Finance* 15(2).

**D2-V5 Money Flow Index.** *Belief:* volume-weighted RSI, stronger OB/OS reversals. *Mechanism:*
RSI weighted by volume — RSI already died (TA4). *Test:* phase-rand + regenerate MFI; key control
= head-to-head vs plain RSI. *Prior:* KILL. *Status:* refines TA4(RSI). *Refs:* Quong & Soudack
1989 "Volume-Weighted RSI: Money Flow," *TASC* 7(3); Wilder 1978.

**D2-V6 Volume-confirmed breakouts.** *Belief:* breakout "real" only on volume surge. *Mechanism:*
volume and |return| mechanically correlated → "breakout+high-volume" partly "breakout+big move."
*Test:* phase-rand + reconstruct volume via **fitted return→volume map** (preserve mechanical
link); key control = does the filter beat the unfiltered breakout after the link is held fixed?
*Prior:* KILL. *Status:* refines TA4(Donchian)+TA2. *Refs:* Karpoff 1987 "The Relation Between
Price Changes and Trading Volume," *JFQA* 22(1); Brock, Lakonishok & LeBaron 1992 "Simple
Technical Trading Rules…," *J. Finance* 47(5); Lo & MacKinlay (~approx).

**D2-V7 Volume Profile (POC / value-area / naked POC).** *Belief:* price reverts to POC; VA-edges
= S/R; naked POC is a magnet. *Mechanism:* NF1 in volume-space — POC/VA are price levels.
*Test:* $0 from fine klines/aggTrades; **NF1 protocol** (count construction in N, carve holdout
first, structure-destroying surrogate); naked-POC needs target-on-surrogate (random prior price
hit-rate). *Prior:* KILL. *Status:* NEW (NF1 in volume-space). *Refs:* Steidlmayer & Koy 1986
*Markets and Market Logic*; Dalton, Jones & Dalton 1990/2007 *Mind Over Markets*; CME "Market
Profile" docs.

**D2-V8 Klinger / Volume Osc / Ease-of-Movement.** *Belief:* volume-oscillator divergences lead
price. *Mechanism:* grab-bag of ad-hoc transforms = max data-mining surface. *Test:* phase-rand +
regenerate; **family-wide DSR with full N** (~200+) is the killer. *Prior:* KILL. *Status:*
refines TA4. *Refs:* Klinger 1997 (*TASC*); Arms 1989 *The Arms Index (TRIN)*; Achelis 2001.

**D2-M1 VPIN toxicity.** *Belief:* high VPIN = toxic flow → impending adverse move; spiked before
the Flash Crash. *Mechanism:* adverse-selection — but largely a vol proxy (Andersen-Bondarenko).
*Test:* **$0 from aggTrades**; block-bootstrap bucketed flow; KEY control = **must beat a plain
trailing-realized-vol baseline** + VPIN predicts vol not direction. *Prior:* UNC / lean KILL
(return); worth-a-shot as a vol/regime gate. *Status:* refines TA3. *Refs:* Easley, López de
Prado & O'Hara 2012, *RFS* 25(5); Easley et al. 2011 "Microstructure of the Flash Crash," *J.
Portfolio Management* 37(2); **Andersen & Bondarenko 2014 "VPIN and the Flash Crash," *J.
Financial Markets* 17** (the decisive critique).

**D2-M2 Kyle's λ / Amihud illiquidity.** *Belief:* λ measures depth/fragility; illiquidity
premium. *Mechanism:* foundational microstructure; timing is a vol proxy; crypto premium tangled
with small-cap survivorship (R2). *Test:* $0; block (timing) / **cross-sectional shuffle**
(premium); key control = R2 small-cap/beta control + point-in-time universe. *Prior:* KILL.
*Status:* refines TA3 + R2. *Refs:* Kyle 1985 "Continuous Auctions and Insider Trading,"
*Econometrica* 53(6); Amihud 2002, *J. Financial Markets* 5(1); Hasbrouck 2009, *J. Finance*
64(3); Brauneis et al. 2021 crypto illiquidity (~approx).

**D2-M3 Bid-ask bounce / Roll-measure reversion.** *Belief:* harvest the tick-scale negative
autocorrelation. *Mechanism:* the reversion IS the spread — capturable only by a maker. *Test:*
$0 from aggTrades; KEY control = **the cost gate, not the surrogate** — net-of-cost edge ≤ 0 for
a taker (the NF2 fair-game theorem for microstructure). *Prior:* KILL! (taker). *Status:* NEW
(sibling NF2). *Refs:* Roll 1984 "A Simple Implicit Measure of the Effective Bid-Ask Spread," *J.
Finance* 39(4); Niederhoffer & Osborne 1966, *JASA* 61; Hasbrouck 2007 *Empirical Market
Microstructure* (Oxford UP).

**D2-M4 Trade-size clustering / "whale tape".** *Belief:* large-print clusters reveal informed
whales. *Mechanism:* order-splitting theory says large prints can be uninformed; aggTrade size is
partly a depth artifact. *Test:* $0; block-bootstrap size, break size→return; key control =
separate from depth-artifact + lagged-CVD (likely collinear). *Prior:* KILL. *Status:* refines
TA3 + D2-V3. *Refs:* Easley & O'Hara 1987 "Price, Trade Size, and Information," *J. Financial
Economics* 19(1); Barclay & Warner 1993 "Stealth trading…," *J. Financial Economics* 34(3) (medium
trades move price — undercuts whale claim); Kyle 1985.

**D2-M5 Trade-flow autocorrelation (order-flow long memory).** *Belief:* flow persists → trade
with the flow. *Mechanism:* Lillo-Farmer long memory is real, but efficient-market resolution =
transient impact, so predictable flow ≠ predictable return. *Test:* $0; block-bootstrap preserve
ACF break return; key control = the Lillo-Farmer efficiency control + net-of-cost. *Prior:*
KILL. *Status:* refines TA3 + D2-V3. *Refs:* Lillo & Farmer 2004 "The Long Memory of the
Efficient Market," *Studies in Nonlinear Dynamics & Econometrics* 8(3); Bouchaud, Gefen, Potters
& Wyart 2004, *Quantitative Finance* 4(2); Tóth et al. 2011, *Phys. Rev. X* 1.

**D2-M6 Footprint / delta-divergence / absorption.** *Belief:* per-price signed delta divergence
= reversal; stacked imbalances = S/R. *Mechanism:* CVD at finer resolution + NF1 levels (both
killed). *Test:* **$0 exact per-price delta from aggTrades**; pre-register rule (NF3) +
block-bootstrap signed stream + NF1 level-in-N; remove h=0 leakage. *Prior:* KILL. *Status:*
refines TA3+NF1+D2-V3. *Refs:* Jones, Kaul & Lipson 1994 "Transactions, Volume, and Volatility,"
*RFS* 7(4); Easley & O'Hara 1992 "Time and the Process of Security Price Adjustment," *J. Finance*
47(2); footprint practitioner canon (~practitioner, flagged).

**D2-O1 Order-book imbalance (OBI).** *Belief:* positive OBI predicts next up-tick (the most-
believed HFT signal). *Mechanism:* genuinely supported sub-second (Cont-Stoikov-Talreja); but
latency + spread eat it, book is spoofable. *Test:* **NOT $0-backfillable** — forward-collect
`@depth20@100ms` / `@bookTicker`; block-bootstrap (OBI, fwd-ret); KEY control = net-of-cost at
the executable (second+) horizon. *Prior:* UNC / lean KILL — real but sub-cost residual at retail
latency (highest-value microstructure test). *Status:* refines TA3. *Refs:* Cont, Stoikov &
Talreja 2010 "A Stochastic Model for Order Book Dynamics," *Operations Research* 58(3); Cont,
Kukanov & Stoikov 2014 "The Price Impact of Order Book Events," *J. Financial Econometrics* 12(1);
Cartea, Jaimungal & Penalva 2015 *Algorithmic and High-Frequency Trading* (Cambridge UP).

**D2-O2 Order-Flow Imbalance (OFI).** *Belief:* net book-events, the "right" way to use the book.
*Mechanism:* captures changes (real supply/demand events), linear price-impact with high R² — but
largely contemporaneous. *Test:* NOT $0-backfillable (forward-collect `@depth` diffs); isolate
**lagged OFI (h≥1)** from the contemporaneous identity; sub-cost residual likely. *Prior:* KILL
(sub-cost). *Status:* refines TA3 / O1. *Refs:* Cont, Kukanov & Stoikov 2014, *J. Financial
Econometrics* 12(1); Kolm, Turiel & Westray 2023 "Deep order flow imbalance," *Mathematical
Finance* (~approx).

**D2-O3 Depth / liquidity-gradient / book slope.** *Belief:* thin side = path of least
resistance; walls = S/R. *Mechanism:* state-dependent λ; but walls are spoofed and "thin → vol"
is a vol proxy. *Test:* NOT $0-backfillable (forward-collect `@depth20+`); spoof-strip +
vol-proxy control; wall-as-S/R must beat NF1 surrogate. *Prior:* KILL. *Status:* refines
TA3+NF1+M2. *Refs:* Kyle 1985; Næs & Skjeltorp 2006, *J. Financial Markets* 9(3); Cao, Hansch &
Wang 2009, *J. Futures Markets* 29(1).

**D2-O4 Queue-position / micro-price (maker signal).** *Belief:* read queue + micro-price, post
passively, capture spread. *Mechanism:* real HFT market-making edge — structurally unavailable to
a $0 retail taker; you can't observe your own queue without posting. *Test:* **not $0-fundable as
alpha**; only micro-price-beats-mid is $0-testable on forward-collected book. *Prior:* KILL!
(maker/execution edge, not retail alpha). *Status:* refines TA3 (sibling M3). *Refs:* Stoikov
2018 "The micro-price," *Quantitative Finance* 18(12); Moallemi & Yuan 2016 (queue valuation, WP);
Avellaneda & Stoikov 2008 "High-frequency trading in a limit order book," *Quantitative Finance*
8(3).

**D2-O5 Spoofing / iceberg detection.** *Belief:* detect manipulation, fade the spoof / follow
the iceberg. *Mechanism:* label-free classification, no ground truth, reflexive. *Test:* NOT
$0-backfillable (forward-collect `@depth` diffs, no labels); **pre-register the detector** (NF3),
count every threshold in N (worst honest-N trap, 200+); only validation = OOS return. *Prior:*
KILL!. *Status:* refines TA3 (NF3 honest-N). *Refs:* Cartea, Jaimungal & Wang 2020 "Spoofing and
Price Manipulation in Order-Driven Markets," *Applied Mathematical Finance* 27(1); Lee, Eom &
Park 2013, *J. Financial Markets* 16(2); Cont & Kukanov 2017 (iceberg, ~approx).

**D2-D1 Liquidation cascades / liq-level magnets.** *Belief:* liq-levels are magnets; fade the
cascade; ride then fade. *Mechanism:* real forced deleveraging + reflexive cascade; magnets are
NF1 folklore (you don't see others' leverage). *Test:* **partially $0** — `forceOrder` ws-live;
$0 proxy = OI-drop + funding + price-gap; bracket/target-on-surrogate + calendar-reanchor + NF1
magnet; KEY control = is "fade the liquidation" better than "fade any 3σ candle"? *Prior:* UNC /
lean KILL (near-universal crypto belief → high value). *Status:* refines TA3+NF1+T7. *Refs:*
Brunnermeier & Pedersen 2009 "Market Liquidity and Funding Liquidity," *RFS* 22(6);
crypto-liquidation empirics (~approx).

**D2-D2 OI×price×funding flow-state matrix.** *Belief:* the 2×2 of ΔOI×Δprice (+funding) classifies
continuation vs reversal. *Mechanism:* positioning/flow; but contemporaneous and adjacent to T7
(funding contrarian, KILL). *Test:* **partially $0** (funding deep/free; OI history ~30d free);
phase/block, lag state h≥1; key control = add over T7 + momentum baseline. *Prior:* KILL.
*Status:* refines T7 + TA3. *Refs:* Hong & Yogo 2012, *J. Financial Economics* 105(3);
Bessembinder & Seguin 1993, *JFQA* 28(1).

**D2-D3 Taker buy/sell ratio (free perp CVD).** *Belief:* venue aggressor ratio leads price.
*Mechanism:* perp-CVD via the venue's own classification — same h=0 tautology as spot CVD.
*Test:* **$0** (`futures/data/takerlongshortRatio`, history-limited); block-bootstrap, h≥1 lag;
key control = h=0 vs h≥1 + add over spot CVD + funding. *Prior:* KILL. *Status:* refines T7 +
D2-V3. *Refs:* as D2-V3 (Hasbrouck 1991; Chordia-Roll-Subrahmanyam 2002; Easley et al. 2012);
Binance API docs (~practitioner).

---

### Domain D3 — Volatility-based + Options / Derivatives

**Feasibility gate.** Free at $0: perp/spot OHLCV, funding, OI, **Deribit public** (current
chain, OI, ticker greeks, and crucially the **DVOL index history** endpoint). NOT free / not
point-in-time: historical intraday IV surfaces and per-strike greeks (paid: Laevitas / Amberdata
/ Tardis). So GEX/skew/term-structure/VRP-via-IV need either a forward-recorded point-in-time
panel (honest small-N) or paid history. **DVOL-based items (B5, B9, A5) are the $0-on-history
exceptions and are prioritized.**

**D3-A1 Bollinger squeeze → vol breakout.** *Belief:* squeeze → imminent directional move.
*Mechanism:* vol-expansion is real but **directionless**; the directional overlay is where
selection/trend leakage enters. *Test:* $0; **IAAFT + GARCH-matched** surrogate (preserve
squeeze-then-expand, scramble sign); KEY control = directionless-straddle benchmark + long-beta.
*Prior:* KILL (direction) / WS (directionless). *Status:* refines TA4/TA3 (NEW framing). *Refs:*
Bollinger 2001; Engle 1982 *Econometrica* 50(4); Bollerslev 1986, *J. Econometrics* 31; Carter
TTM Squeeze (~approx).

**D3-A2 ATR/Keltner/Chandelier breakout.** *Belief:* ATR-scaled channel "adapts to vol." *Mechanism:*
TSMOM with a vol-normalized trigger. *Test:* $0; block-bootstrap; decompose vs raw-Donchian /
plain TSMOM on the same surrogate. *Prior:* KILL (cosmetic over TA2/TA4-Donchian). *Status:*
refines TA2 + TA4(Donchian). *Refs:* Moskowitz, Ooi & Pedersen 2012, *J. Financial Economics*
104; Kestner 2003 *Quantitative Trading Strategies*; Wilder 1978; Hurst, Ooi & Pedersen 2017
"A Century of Evidence on Trend-Following," *J. Portfolio Management*.

**D3-A3 GARCH/EGARCH vol-forecast timing.** *Belief:* risk-on in calm, risk-off in turbulence.
*Mechanism:* GARCH forecasts vol well; question is whether vol-timing the long leg = alpha or a
smoother beta. *Test:* $0; **GARCH-simulated surrogate** (same vol dynamics, zero return edge);
KEY control = beat a naive trailing-realized-vol timer and a constant vol-target. *Prior:* WS
(Sharpe) / KILL (alpha). *Status:* NEW (cf TA1, A8). *Refs:* Bollerslev 1986; Nelson 1991 EGARCH,
*Econometrica* 59; Glosten, Jagannathan & Runkle 1993 GJR, *J. Finance* 48; Moreira & Muir 2017,
*J. Finance* 72(4); Andersen, Bollerslev, Diebold & Labys 2003, *Econometrica* 71.

**D3-A4 Realized-vol regime switching.** *Belief:* per-regime strategies (momentum in calm,
reversion in crisis). *Mechanism:* regimes descriptive but labels are look-ahead if smoothed;
multiplies search. *Test:* $0; **filtered (online) regime probabilities only**; block preserving
vol clustering + **regime-shuffle placebo**; key control = beat a single fixed strategy OOS.
*Prior:* KILL. *Status:* refines NC + WF-A..D. *Refs:* Hamilton 1989, *Econometrica* 57; Ang &
Timmermann 2012, *Annual Rev. Financial Economics*; Guidolin & Timmermann 2007, *J. Economic
Dynamics & Control*; Kim & Nelson 1999 *State-Space Models with Regime Switching* (MIT Press).

**D3-A5 Vol-of-vol.** *Belief:* rising vol-of-vol → de-risk. *Mechanism:* real risk factor but
third-order/noisy, mostly redundant with vol. *Test:* RV-of-RV $0; **DVOL-of-DVOL $0 via free
DVOL history**; block-bootstrap joint cascade; key control = partial out vol (A3). *Prior:* KILL.
*Status:* NEW. *Refs:* Baltussen, Van Bekkum & Van der Grient 2018 "Unknown Unknowns: Vol-of-Vol…,"
*Review of Finance*; Huang, Schlag, Shaliastovich & Thimme 2019, *JFQA*; Deribit DVOL docs (~approx).

**D3-A6 Leverage-effect / sign asymmetry.** *Belief:* down moves raise vol more — trade the
asymmetry. *Mechanism:* robust in equities, sign-unstable/inverted in crypto. *Test:* $0;
symmetric vs asymmetric GARCH sim; key control = is the leverage sign even stable across sample
(it flips)? *Prior:* KILL. *Status:* NEW (sub-variant A3). *Refs:* Black 1976 "Studies of Stock
Price Volatility Changes," *Proc. ASA*; Nelson 1991; Bouri, Roubaud et al. 2017–2020 crypto
leverage instability (~approx).

**D3-A7 Intraday/weekly vol calendar.** *Belief:* vol seasonality (opens, weekend, 8h funding).
*Mechanism:* real vol seasonality predicts |move| not sign. *Test:* $0; **calendar-reanchor
placebo** (shift buckets by random offsets); directionless vs directional. *Prior:* KILL
(direction). *Status:* refines ND (vol not return). *Refs:* Andersen & Bollerslev 1997 "Intraday
Periodicity…," *J. Empirical Finance*; Harris 1986, *JFE*.

**D3-A8 Vol-targeting / Moreira–Muir.** *Belief:* scale inverse to forecast vol → higher Sharpe.
*Mechanism:* mechanical de-risking; equity gains fragile OOS (Cederburg). *Test:* $0;
**GARCH-simulated** surrogate (real gain must exceed the mechanical surrogate lift); KEY control
= constant-leverage B&H at matched average exposure + net-of-cost (vol-targeting churns leverage).
*Prior:* UNC / lean KILL net. *Status:* refines TA1. *Refs:* Moreira & Muir 2017, *J. Finance*
72; Cederburg, O'Doherty, Wang & Yan 2020, *JFE* 138; Harvey et al. 2018 "The Impact of Volatility
Targeting," *J. Portfolio Management*; Barroso & Santa-Clara 2015, *JFE*.

**D3-A9 NR7 / inside-bar / ATR-compression.** *Belief:* narrowest range → next bar expands.
*Mechanism:* same as A1 (vol-expansion real, direction folklore). *Test:* IAAFT/GARCH preserve
contraction-then-expansion; directionless vs directional; large honest-N. *Prior:* KILL
(direction). *Status:* refines A1 + TA4. *Refs:* Crabel 1990 *Day Trading with Short Term Price
Patterns and Opening Range Breakout*; Engle 1982; Bollerslev 1986.

**D3-B1 Dealer GEX / gamma walls / zero-gamma flip.** *Belief:* positive net gamma → pinned/mean-
revert, negative → trend; walls = S/R. *Mechanism:* sound in SPX (structured-product short-vol
supply), much weaker in crypto (ambiguous dealer sign); walls = NF1 in options OI. *Test:*
**point-in-time OI+gamma** → forward-record ($0, small-N) or paid; **strike-shuffle placebo**
(wall S/R) + block (gamma-regime) + label-shuffle (flip); KEY control = beat max-pain/OI-max S/R
(NA/NF1) and realized-vol regime (A4); dealer-sign is an unfalsifiable DoF. *Prior:* KILL in
crypto — high public value (one of the most-hyped 2023–25 narratives). *Status:* NEW (extends NA
+ NF1). *Refs:* SqueezeMetrics 2017 GEX white paper (~practitioner, no peer review); Ni, Pearson,
Poteshman & White 2021 "Does Option Trading Have a Pervasive Impact on Underlying Stock Prices?,"
*RFS* 34 (the real anchor); Barbon & Buraschi 2020 "Gamma Fragility" (SSRN, ~approx).

**D3-B2 Put/Call ratio sentiment.** *Belief:* high P/C = fear = contrarian buy. *Mechanism:*
crypto options are a small non-representative slice (leverage is in perps); mixes hedging vs
speculation; coincident. *Test:* current $0 (Deribit OI/volume), history forward-record;
block + lag-shuffle; key control = coincident-vs-predictive (force forward lag) + long-beta.
*Prior:* KILL. *Status:* NEW (cf C3, OC1). *Refs:* Baker & Wurgler 2006 "Investor Sentiment…,"
*J. Finance* 61; Pan & Poteshman 2006 "The Information in Option Volume…," *RFS* 19 (real result
uses signed proprietary volume, not naive P/C); Bandopadhyaya & Jones 2008 (~approx).

**D3-B3 25-delta risk reversal / skew.** *Belief:* put skew = fear, bearish or contrarian bottom.
*Mechanism:* skew prices the risk-neutral crash probability (real risk factor); the contested
claim is direction. *Test:* point-in-time IV-by-delta → **partial $0 (forward-record)**; block +
lead-lag placebo; KEY control = separate risk-premium from directional forecast (skew→returns is
usually a skew risk premium = selling rich tails, B5/B6). *Prior:* KILL (direction). *Status:*
NEW (cf B5/B6). *Refs:* Xing, Zhang & Zhao 2010 "What Does the Individual Option Volatility Smirk
Tell Us…," *JFQA* 45; Bollerslev & Todorov 2011 "Tails, Fears, and Risk Premia," *J. Finance* 66;
Kozhan, Neuberger & Schneider 2013 "The Skew Risk Premium…," *RFS* 26; Bakshi, Kapadia & Madan
2003, *RFS* 16.

**D3-B4 IV term-structure slope.** *Belief:* backwardated vol = stress/risk-off. *Mechanism:* vol
term structure mean-reverts (real); spot-directional mapping is weak/contemporaneous. *Test:*
multi-tenor IV → **partial $0 (forward-record)**; block + lead-lag; key control = coincident-vs-
predictive + does it add over realized-vol (A4)? *Prior:* KILL (spot). *Status:* NEW (cf A3/A4/B5).
*Refs:* Johnson 2017 "Risk Premia and the VIX Term Structure," *JFQA* 52; Mixon 2007, *J.
Empirical Finance*; Eraker & Wu 2017 "Explaining the Negative Returns to VIX Futures and ETNs,"
*JFE*.

**D3-B5 Variance Risk Premium harvest (DVOL vs RV).** *Belief:* implied variance > realized → sell
vol to harvest; "most reliable crypto edge." *Mechanism:* genuinely real (Bollerslev-Tauchen-Zhou;
Carr-Wu) — structurally a carry/insurance-selling premium, the options-world counterpart of the
surviving funding/basis carry; paid for negatively-skewed tail risk. *Test:* **fully $0 on
history** (DVOL² − RV²); the right null is NOT phase-randomization — use a **tail-matched
bootstrap** carrying the same crash frequency + a sell-vol-on-shuffled-VRP placebo; KEY control =
**benchmark against the cost of the tail, not T-bills** (charge realized strangle tail losses +
hedge cost; CVaR/Calmar vs cash). *Prior:* UNC — single best-prior options item; most likely
"real but doesn't beat T-bills net of tail," mirroring the carry survivors. *Status:* NEW (carry-
survivor analogue). *Refs:* Bollerslev, Tauchen & Zhou 2009 "Expected Stock Returns and Variance
Risk Premia," *RFS* 22; Carr & Wu 2009 "Variance Risk Premiums," *RFS* 22; Britten-Jones &
Neuberger 2000 "Option Prices, Implied Price Processes, and Stochastic Volatility," *J. Finance*
55; Alexander et al. 2021–23 crypto VRP/DVOL (~approx).

**D3-B6 Short-vol selling (straddle/strangle/iron condor).** *Belief:* "iron condors win ~70%."
*Mechanism:* implementation of B5 + path-dependent payoff; high win-rate, negative skew — the
inverse of the project's stops lesson. *Test:* DVOL-synthetic $0 (flagged approximation);
**bracket-on-surrogate** (GARCH/jump-matched paths); KEY control = expectancy-vs-win-rate
decomposition + tail-charged net-of-cost on four legs. *Prior:* KILL as a high-win-rate edge
(reduces to B5). *Status:* NEW (impl of B5; mirrors NF2). *Refs:* Coval & Shumway 2001 "Expected
Option Returns," *J. Finance* 56; Broadie, Chernov & Johannes 2009 "Understanding Index Option
Returns," *RFS* 22; Santa-Clara & Saretto 2009 "Option Strategies: Good Deals and Margin Calls,"
*J. Financial Markets*; Israelov & Nielsen 2015 "Covered Calls Uncovered," *FAJ*.

**D3-B7 Covered call / "the wheel".** *Belief:* income + better risk-adjusted than B&H. *Mechanism:*
long beta + short a slice of VRP + capped upside — not free income (Israelov-Nielsen). *Test:*
DVOL-synthetic $0; GARCH/jump surrogate; KEY control = **decompose into beta + short-vol and
benchmark each** (underperforms in a bull tape). *Prior:* KILL as alpha. *Status:* NEW (cf B5/B6,
A8). *Refs:* Israelov & Nielsen 2015, *FAJ* 71; Whaley 2002 "Return and Risk of CBOE Buy-Write
(BXM)," *J. Derivatives*; Hill, Balasubramanian, Gregory & Tierens 2006 "Finding Alpha via Covered
Index Writing," *FAJ*.

**D3-B8 Delta-hedged VRP.** *Belief:* sell + delta-hedge to isolate clean VRP. *Mechanism:*
hedged short-option PnL ≈ ∫(IV²−RV²); crypto hedging cost / discrete-rebalance slippage / perp
funding / gamma losses eat it. *Test:* DVOL-synthetic $0 with explicit hedge-cost model;
jump-matched surrogate; KEY control = **charge realistic discrete-hedging slippage + perp funding**.
*Prior:* UNC / lean KILL net hedge. *Status:* NEW (clean B5/B6). *Refs:* Carr & Wu 2009; Bakshi &
Kapadia 2003 "Delta-Hedged Gains and the Negative Market Volatility Risk Premium," *RFS* 16;
Bondarenko 2014 "Variance Trading and Market Price of Variance Risk," *J. Econometrics*.

**D3-B9 Deribit DVOL signals.** *Belief:* DVOL spikes = buy; DVOL momentum/reversion/DVOL−RV are
spot timing. *Mechanism:* DVOL mean-reverts; DVOL−RV is the VRP (B5); spikes are coincident with
crashes. *Test:* **$0 — DVOL history free**; block + **lead-lag placebo** + calendar-reanchor
spikes; key control = strict forward lag + beat the $0 realized-vol timer (A3). *Prior:* KILL
(spot); content routes to B5. *Status:* NEW (cf A3, B5). *Refs:* Deribit 2021 DVOL methodology
(~approx); Whaley 2009 "Understanding the VIX," *J. Portfolio Management* (equity analogue, non-
predictive for direction); Alexander et al. 2022–23 (~approx).

**D3-B10 Max-pain refinement.** *Belief:* OI-weight + NTM-only + cross-venue confirm the pin.
*Mechanism:* pinning is real but tiny (Ni-Pearson-Poteshman), weakened by cash-settlement.
*Test:* current OI $0, history forward-record; **strike-shuffle + calendar-reanchor** (pin must
localize to true strike on true expiry); KEY control = net-of-cost (the move into max-pain is
usually < round-trip cost). *Prior:* KILL (sub-cost; refinement won't rescue NA). *Status:*
refines NA. *Refs:* Ni, Pearson & Poteshman 2005 "Stock Price Clustering on Option Expiration
Dates," *JFE* 78; Ni, Pearson, Poteshman & White 2021, *RFS* 34; Avellaneda & Lipkin 2003 "A
Market-Induced Mechanism for Stock Pinning," *Quantitative Finance* 3.

**D3-B11 Options-implied informed flow.** *Belief:* "unusual options activity" front-runs informed
bets. *Mechanism:* Pan-Poteshman used signed proprietary initiator data; public feed loses the
sign → noise + hindsight. *Test:* Deribit block/taker-side partially $0, **initiator-signing
incomplete**; trade-time/label shuffle; KEY control = sign/initiator integrity + lag + long-beta.
*Prior:* KILL on public data. *Status:* NEW (cf B2, TA3). *Refs:* Pan & Poteshman 2006, *RFS* 19;
Easley, O'Hara & Srinivas 1998 "Option Volume and Stock Prices," *J. Finance* 53; Augustin,
Brenner & Subrahmanyam 2019 (informed trading in options, ~approx).

---

### Domain D4 — Momentum/trend refinements + mean-reversion / statistical arbitrage

**Prior.** Crypto is a one-factor market; "diversified" momentum/reversal usually collapses to
*timed beta*. Base-case is KILL. The items worth real shots are the few **beta-orthogonal by
construction** (M2 residual momentum, S6 PCA stat-arb) — there the standard surrogate does not
trivially reproduce the signal, so the test carries information and the binding constraint is
transaction cost, not data-mining.

**D4-M1 Dual momentum (absolute + relative).** *Belief:* relative-winner held only if absolute
momentum > cash, else cash (Antonacci). *Mechanism:* under-reaction (relative) + a market-timing
overlay (absolute). *Test:* $0; **cross-sectional shuffle (relative leg) + phase-rand panel
(absolute leg)**; KEY control = beat "hold BTC when BTC absolute momentum > 0 else cash"
(single-asset timing). *Prior:* KILL. *Status:* refines T1 + TA2/T8. *Refs:* Antonacci 2014 *Dual
Momentum Investing* (McGraw-Hill); Antonacci 2017, *J. Portfolio Management*; Moskowitz, Ooi &
Pedersen 2012, *JFE* 104(2); Asness, Moskowitz & Pedersen 2013 "Value and Momentum Everywhere,"
*J. Finance* 68(3).

**D4-M2 Residual / idiosyncratic momentum.** *Belief:* momentum of residual returns ~ doubles
Sharpe by stripping factor exposure (Blitz-Huij-Martens). *Mechanism:* isolates coin-specific
under-reaction drift; beta-neutral so it should not crash with the market. *Test:* $0; rolling
beta to BTC → residuals → rank; **factor-preserving block-bootstrap + cross-sectional shuffle of
the residual ranking** (standard phase-rand of total returns does NOT reproduce it — that is why
this test carries information); KEY control = verify book is actually beta-neutral (regress on
BTC → slope ≈ 0). *Prior:* **UNC — most promising momentum item** (likely killed by cost + short
cross-section, not surrogate). *Status:* refines T1. *Refs:* Blitz, Huij & Martens 2011 "Residual
Momentum," *J. Empirical Finance* 18(3); Gutierrez & Prinsky 2007, *J. Financial Markets* 10(1);
Grundy & Martin 2001, *RFS* 14(1).

**D4-M3 52-week-high (nearness-to-high).** *Belief:* nearness to the 52w high predicts returns
better than past returns (George-Hwang). *Mechanism:* anchoring under-reaction — a level/anchor
claim. *Test:* $0; **cross-sectional shuffle + structure-destroying surrogate** (NF1-style: a
null with no real highs); KEY control = orthogonalize vs 12m momentum + BTC beta. *Prior:* KILL
(collinear with momentum/beta; anchoring weak in 24/7 crypto). *Status:* refines T1 + NF1. *Refs:*
George & Hwang 2004 "The 52-Week High and Momentum Investing," *J. Finance* 59(5); Liu, Liu & Ma
2011, *J. International Money & Finance* 30(1) (~approx).

**D4-M4 Frog-in-the-pan / information discreteness.** *Belief:* momentum stronger when past return
arrived via many small moves (low ID). *Mechanism:* limited attention → gradual info under-reacted.
*Test:* $0; cross-sectional shuffle + **ID-label placebo** (shuffle ID labels across assets); KEY
control = double-sort momentum × volatility (ID proxies vol). *Prior:* KILL (interesting if it
survives the ID-placebo). *Status:* refines T1. *Refs:* Da, Gurun & Warachka 2014 "Frog in the
Pan," *RFS* 27(7); Barberis, Shleifer & Vishny 1998 "A Model of Investor Sentiment," *JFE* 49(3).

**D4-M5 Momentum crashes / vol-scaling.** *Belief:* inverse-vol scaling ~doubles momentum Sharpe
and removes crashes (Barroso-Santa-Clara). *Mechanism:* momentum's conditional vol is forecastable
and highest when expected return is most negative. *Test:* $0; **scaling-on-surrogate** — apply
the identical scaling transform to the surrogate and compare the *lift* (inverse-vol scaling
mechanically lifts the Sharpe of even zero-mean noise — same reshaping as the NF2 bracket lesson);
KEY control = does crypto momentum even have a positive base expectancy to scale (T1/TA2 all
KILLed)? *Prior:* KILL (likely nothing to scale). *Status:* refines TA2 + T1. *Refs:* Daniel &
Moskowitz 2016 "Momentum Crashes," *JFE* 122(2); Barroso & Santa-Clara 2015 "Momentum Has Its
Moments," *JFE* 116(1); Moreira & Muir 2017, *J. Finance* 72(4); Harvey et al. 2018, *J. Portfolio
Management*.

**D4-M6 Acceleration (2nd-derivative) momentum.** *Belief:* accelerating trends persist;
decelerating winners reverse. *Mechanism:* the rate-of-change of drift as a leading indicator.
*Test:* $0; phase-rand (high-pass of returns) + cross-sectional shuffle; honest N huge (which two
windows to difference — over-differencing trap). *Prior:* KILL! (differencing amplifies noise +
raises DSR bar). *Status:* refines T1/TA2. *Refs:* Ardila, Forró & Sornette 2015/16 "The
Acceleration Effect and Gamma Factor in Asset Pricing" (SFI/arXiv, ~approx); ROC-of-ROC
practitioner folklore.

**D4-M7 TS×XS momentum combo.** *Belief:* TS and XS are distinct premia; combining diversifies.
*Mechanism:* Goyal-Jegadeesh — TSMOM = XS-momentum + a time-varying *net-long* beta. *Test:* $0;
cross-sectional shuffle + phase-rand panel; KEY control = the combo's extra return over pure XS IS
the net-long beta (decompose, regress on BTC). *Prior:* KILL (diagnostic — makes the "momentum =
timed beta" kill explanatory). *Status:* refines T1 + TA2. *Refs:* Goyal & Jegadeesh 2018
"Cross-Sectional and Time-Series Tests of Return Predictability," *RFS* 31(5); Moskowitz, Ooi &
Pedersen 2012; Asness, Moskowitz & Pedersen 2013.

**D4-M8 Factor momentum.** *Belief:* recently-winning factors keep winning (Ehsani-Linnainmaa).
*Mechanism:* positive autocorrelation in factor returns. *Test:* $0 (sector tags soft — pre-
register a fixed mapping); phase-rand each factor series + cross-sectional shuffle across factors;
KEY control = strip BTC beta first; if only the BTC-beta factor "trends," it's just TA2.
*Prior:* KILL (crypto's low factor dimensionality). *Status:* refines TA2 + C1–C4. *Refs:* Ehsani
& Linnainmaa 2022 "Factor Momentum and the Momentum Factor," *J. Finance* 77(3); Arnott, Clements,
Kalesnik & Linnainmaa 2021 "Factor Momentum," *RFS* (~approx); Gupta & Kelly 2019 "Factor Momentum
Everywhere," *J. Portfolio Management* 45(3).

**D4-S1 Ornstein–Uhlenbeck single-name reversion.** *Belief:* trade z-band extremes of an OU
de-trended series. *Mechanism:* tradable drift if dX = κ(θ−X)dt + σdW with κ>0. *Test:* $0;
phase-rand (sharp null — preserves AR(1)) + block-bootstrap + **bracket-on-surrogate for the
z-band exits** (band trading is a stopping-time rule that reshapes driftless noise); KEY control
= short-horizon reversion = bid-ask bounce (step bar size up, edge vanishes) + cost. *Prior:*
KILL. *Status:* refines T2/T-reversal. *Refs:* Avellaneda & Lee 2010 "Statistical Arbitrage in the
U.S. Equities Market," *Quantitative Finance* 10(7); Leung & Li 2015 "Optimal Mean Reversion
Trading…," *Int. J. Theoretical & Applied Finance* 18(3); Uhlenbeck & Ornstein 1930, *Physical
Review* 36.

**D4-S2 Distance pairs (Gatev-Goetzmann-Rouwenhorst).** *Belief:* min-distance pairs, fade 2σ
divergence, close at convergence (the canonical stat-arb). *Mechanism:* shared-factor transient
divergence corrects market-neutrally. *Test:* $0; **selection-on-surrogate** (does random pairing
produce the same PnL?) + block-bootstrap spread + bracket-on-surrogate; honest N = full
C(N,2)×window×rule pair search (hundreds–thousands → DSR/PBO); KEY control = crypto "pairs" are
BTC-beta clones (regress spread on BTC) + untouched holdout (GGR profits decayed post-2002).
*Prior:* KILL (one rigorous run — high-value KILL of the canonical technique). *Status:* refines
T3. *Refs:* Gatev, Goetzmann & Rouwenhorst 2006 "Pairs Trading," *RFS* 19(3); Do & Faff 2010
"Does Simple Pairs Trading Still Work?," *FAJ* 66(4); Krauss 2017 "Statistical Arbitrage Pairs
Trading Strategies: Review and Outlook," *J. Economic Surveys* 31(2).

**D4-S3 Cointegration pairs (Engle-Granger / Johansen).** *Belief:* trade the stationary residual
of a cointegrating combo. *Mechanism:* Granger Representation Theorem → mean-reverting spread.
*Test:* $0; block-bootstrap + phase-rand + **cointegration-on-surrogate** (re-run the *selection*
on phase-randomized pairs — spurious cointegration appears at the nominal rate on noise) +
**pair-level PBO** via `estimateCscvPbo`; KEY control = β unstable OOS (require spread stationary
in the holdout). *Prior:* KILL (spurious cointegration + OOS β-breakdown). *Status:* refines T3 /
S2. *Refs:* Engle & Granger 1987 "Co-integration and Error Correction," *Econometrica* 55(2);
Johansen 1991, *Econometrica* 59(6); Vidyamurthy 2004 *Pairs Trading* (Wiley); Krauss 2017.

**D4-S4 Kalman dynamic hedge ratio.** *Belief:* time-varying β keeps the spread stationary longer
(the "professional fix"). *Mechanism:* a Kalman filter tracks drifting β. *Test:* $0;
**Kalman-on-surrogate** (an over-adaptive filter manufactures spurious stationarity on noise);
count the process/observation-noise hyperparameters in N; KEY control = strict causal β (anti-
lookahead audit) + compare to static OLS β. *Prior:* KILL (flexibility raises overfit + DSR bar).
*Status:* refines T3 / S3. *Refs:* Kalman 1960, *J. Basic Engineering* 82(1); Chan 2013
*Algorithmic Trading* (Wiley); Triantafyllopoulos & Montana 2011, *Computational Management
Science* 8 (~approx).

**D4-S5 Copula pairs.** *Belief:* copulas capture tail dependence the linear spread misses.
*Mechanism:* models full joint distribution. *Test:* $0; **copula-on-surrogate** (a flexible
copula finds tradable extremes on noise); copula-family selection is part of the search; KEY
control = beat the simpler distance/cointegration pairs head-to-head AND survive the larger N;
crypto tail dependence ≈ "everything crashes with BTC." *Prior:* KILL! (max flexibility, max N,
no new mechanism). *Status:* refines T3 / S2 / S3. *Refs:* Liew & Wu 2013 "Pairs trading: A copula
approach," *J. Derivatives & Hedge Funds* 19(1); Stübinger, Mangold & Krauss 2018 "Statistical
arbitrage with vine copulas," *Quantitative Finance* 18(11); Krauss 2017.

**D4-S6 PCA basket stat-arb (Avellaneda-Lee s-score).** *Belief:* trade residuals against eigen-
portfolios (the scalable pairs generalization). *Mechanism:* PCA factors capture systematic
co-movement; the idiosyncratic residual s-score is (claimed) stationary. *Test:* $0;
**panel/marginal seed (factor-preserving block-bootstrap) + cross-sectional shuffle of residual
rankings + bracket-on-surrogate** (residuals are beta-orthogonal by construction → the surrogate
is informative, not rigged); KEY control = test OOS residual stationarity + confirm neutral
(regress on BTC + PC1). *Prior:* **UNC — worth a real shot** (likely killed by transaction cost +
short cross-section, not surrogate). *Status:* refines T3 (sibling M2). *Refs:* Avellaneda & Lee
2010, *Quantitative Finance* 10(7); Khandani & Lo 2011 "What Happened to the Quants in August
2007?," *J. Financial Markets*; Yeo & Papanicolaou 2017 (~approx).

**D4-S7 Short-term reversal (1d / weekly).** *Belief:* fade yesterday's cross-sectional winners.
*Mechanism:* liquidity provision / inventory + partly bid-ask bounce. *Test:* $0; cross-sectional
shuffle + block-bootstrap; KEY control = **skip-one-period** (neutralize bounce) + realistic
round-trip cost (trades daily) + R2 small-cap check. *Prior:* KILL net (the textbook "exists
gross, dies net"). *Status:* refines T2/T-reversal. *Refs:* Lehmann 1990 "Fads, Martingales, and
Market Efficiency," *QJE* 105(1); Jegadeesh 1990 "Evidence of Predictable Behavior…," *J. Finance*
45(3); Jegadeesh & Titman 1995, *RFS* 8(4); Nagel 2012 "Evaporating Liquidity," *RFS* 25(7).

**D4-S8 Overnight vs intraday / session decomposition.** *Belief:* one session's move reverses in
the next (different clienteles). *Mechanism:* equities ride a real open/close auction crypto
lacks. *Test:* $0; the session boundary is a pre-registered choice (count in N); **calendar-
reanchor** (shift the cut to random anchors — if the real boundary isn't an outlier it's a fixed-
window mirage). *Prior:* KILL. *Status:* refines T-reversal + ND. *Refs:* Lou, Polk & Skouras
2019 "A Tug of War: Overnight Versus Intraday Expected Returns," *JFE* 134(1); Hendershott, Livdan
& Rösch 2020, *JFE* 138(3); Cooper, Cliff & Gulen 2008 (~approx).

**D4-S9 Lead-lag stat-arb (BTC leads alts).** *Belief:* the leader's move predicts laggards
tomorrow. *Mechanism:* gradual information diffusion / non-synchronous trading. *Test:* $0;
**block-bootstrap that destroys cross-asset lag structure while preserving each asset's own
autocorrelation** + leader-shuffle placebo; KEY control = lag vs contemporaneous beta (include
the contemporaneous leader return; test whether the *lagged* term adds anything) + stale-price/R2
check. *Prior:* KILL (daily = contemporaneous beta + stale prices; true lead-lag is sub-minute
HFT). *Status:* refines C1 + TA3. *Refs:* Lo & MacKinlay 1990 "When Are Contrarian Profits Due to
Stock Market Overreaction?," *RFS* 3(2); Hou 2007, *RFS* 20(4); Chordia & Swaminathan 2000, *J.
Finance* 55(2).

**D4-S10 Basket vs constituents (index-arb analogue).** *Belief:* trade convergence when a basket
diverges from its replicating portfolio. *Mechanism:* a synthetic basket is a deterministic
function of constituents — no genuine mispricing without a real frictioned index product. *Test:*
$0 (synthetic only); panel/marginal seed + block-bootstrap of the basket-minus-constituents
spread; KEY control = the only nonzero spread is rebalancing/discretization noise eaten by cost.
*Prior:* KILL! (definitional — clarifies why genuine index-arb needs a real, costly-to-replicate
product). *Status:* refines T3 / S6 (negative control). *Refs:* Hasbrouck 2003 "Intraday Price
Formation in U.S. Equity Index Markets," *J. Finance* 58(6); Petajisto 2017 "Inefficiencies in
the Pricing of Exchange-Traded Funds," *FAJ* 73(1).

---

### Domain D5 — On-chain / crypto-native valuation & flow (beyond OC1 / NB)

**The D5 reality.** Almost every popular on-chain ratio is a **monotone transform of price**
(price is in the numerator of MVRV, NVT, NUPL, Puell, Thermocap, S2F-deviation). The single most
important D5 control is the **price-monotone-transform null**: replace the on-chain numerator with
the best-fitting smooth function of price+lags; promotion is blocked unless the on-chain version
beats that price-only control OOS. **Free data:** Coin Metrics Community (CC license) for
realized cap/MVRV/NVT/active-addresses/miner revenue/exchange flows; DefiLlama for stablecoins.
**Paid-canonical / degraded-free:** SOPR family, LTH/STH split, CDD/dormancy, fine HODL bands —
flagged per entry via a `dataFidelity` caveat.

**D5-01 SOPR / aSOPR reset-to-1.** *Belief:* aSOPR reclaiming 1 = capitulation done → long.
*Mechanism:* loss-averse holders make 1 a reflexive floor — plausible if not already in price.
*Test:* free aSOPR reconstruction (UTXO-exact is paid); phase-rand + block; KEY control = swap
aSOPR for `price_t/EMA(price)` price-only surrogate + orthogonalize vs OC1 MVRV. *Prior:* KILL
("reclaim 1" ≈ a momentum-reclaim the price-only surrogate replicates). *Status:* NEW (cf OC1).
*Refs:* Shirakashi 2019 "SOPR" (~approx); Glassnode SOPR docs; Bailey & López de Prado 2014 "The
Deflated Sharpe Ratio," *J. Portfolio Management* 40(5); Theiler et al. 1992 "Testing for
nonlinearity in time series: the method of surrogate data," *Physica D* 58.

**D5-02 STH-SOPR vs LTH-SOPR divergence.** *Belief:* LTH-SOPR≫1 while price stalls = top; STH<1 =
bottom. *Mechanism:* cohort behavior (LTH distribution at tops is documented). *Test:* needs the
155d age split — **effectively paid**; free 1yr proxy degraded; panel/marginal seed + **cohort-
shuffle** (reassign outputs to age bands); KEY control = orthogonalize divergence vs MVRV-Z +
price momentum. *Prior:* **UNC — worth a shot** (least price-mechanical SOPR variant; binding
constraint is free-data fidelity). *Status:* NEW. *Refs:* Glassnode LTH/STH-SOPR docs; cohort-
anatomy write-ups (~approx); López de Prado 2018 *Advances in Financial Machine Learning* (Wiley).

**D5-03 MVRV-Z extreme bands.** *Belief:* Z>~7 top, Z<~0.1 bottom. *Mechanism:* market cap ≫ cost
basis = mean-reverting euphoria; Z just standardizes; economic content = OC1's MVRV. *Test:*
fully free; phase-rand + **price-only standardized control** (MVRV-Z is price-dominated); honest
N: std window is a notorious knob + **only ~3–7 independent cycle extremes** → autocorrelation-
honest month-scale bootstrap blocks. *Prior:* KILL on OOS tradability (the canonical "amazing
in-sample, fails honest-N" teaching kill). *Status:* refines OC1. *Refs:* Mahmudov & Puell 2018
MVRV-Z (~approx); Coin Metrics valuation primer (~approx); Harvey & Liu 2015 "Backtesting," *J.
Portfolio Management* 42(1).

**D5-04 NUPL zones.** *Belief:* NUPL<0 = generational buy, >0.75 = sell. *Mechanism:* NUPL =
1 − 1/MVRV — a monotone reparametrization. *Test:* free; phase-rand + price-only; the decisive
control = **show NUPL ≡ f(MVRV)** and run the identical gauntlet on MVRV (OC1) — if verdicts are
indistinguishable, NUPL is not independent and shares OC1's honest-N. *Prior:* KILL! (exposes
"same signal, new costume" as a data-mining vector). *Status:* refines OC1 / D5-03. *Refs:*
Glassnode NUPL docs; Bailey, Borwein, López de Prado & Zhu 2017 "The Probability of Backtest
Overfitting," *J. Computational Finance* 20(4).

**D5-05 Realized price as dynamic S/R.** *Belief:* reclaim realized price = bull; bear bottoms
tag it; ×0.7/×3 bands bracket extremes. *Mechanism:* aggregate cost-basis as behavioral S/R.
*Test:* free; **bracket-on-surrogate** (run reclaim/tag on phase-randomized price with the
realized-price line fixed — the exact NF1 control); KEY control = compare to random-line S/R (the
NF1/Fibonacci kill). *Prior:* KILL (most defensible S/R variant, but likely the same illusion).
*Status:* refines NF1 (on-chain level). *Refs:* Coin Metrics realized-cap intro (~approx); NF1
internal cross-ref; Lo, Mamaysky & Wang 2000, *J. Finance* 55(4).

**D5-06 NVT ratio extreme.** *Belief:* high NVT = overvalued vs usage. *Mechanism:* transfer value
as "earnings"; noisy/entity-inflated; high-NVT persists for years. *Test:* free; phase-rand +
block + **denominator-shuffle** (smoothed/lagged transfer value); KEY control = orthogonalize vs
momentum + NVTS + regime ("overvalued" coincides with bull beta). *Prior:* KILL. *Status:* NEW.
*Refs:* Burniske 2017 / Woo "Bitcoin NVT Ratio" (origin); Kalichkin 2018 "Rethinking NVT Ratio"
(critique).

**D5-07 NVTS & NVT golden cross.** *Belief:* GC > threshold = top, ≪ = bottom. *Mechanism:* a
moving-average crossover on a ratio = directly the killed TA4 MA-cross family. *Test:* free
(`NVTAdj`/`NVTAdj90`); **MA-crossover-on-surrogate**; honest N = short/long MA pair grid (300+);
KEY control = beat a price-MA-cross. *Prior:* KILL. *Status:* refines TA4(MA-cross). *Refs:*
Kalichkin 2018 (NVTS); Woo "NVT Signal" / "NVT Golden Cross" (origin); TA4 internal cross-ref.

**O3-NVTS NVT-signal refinement (strongest causal version).** *Belief:* NVT (market-cap / economic
throughput) flags over/under-valuation; high NVT = price rich vs on-chain usage = mean-revert down.
*Free-data status:* the canonical NVT denominator `TxTfrValAdjUSD` and ready-made `NVTAdj`/`NVTAdj90`
are PAID (not in the 32-metric Coin Metrics Community catalog — verified live). So the canonical NVT
is **DEFERRED**; tested the strongest FREE proxy: **fee-revenue NVTS = MarketCap / SMA(FeeTotNtv·Price)**
(fees = willingness to pay for settlement = real economic throughput), Kalichkin-smoothed, trailing
z-scored, LAGged ≥1d, contrarian band (long cheap / short overvalued). *Why fee and not count:* probe
showed `TxCnt`/`TxTfrCnt` count-NVTs are momentum-in-disguise (top bucket best, positive corr = the
price-clock trap); ONLY the fee proxy has forward-return buckets INVERTED vs a pure price-clock that
SURVIVE orthogonalization vs price momentum (extreme-high fee-NVTS → flat/negative fwd returns even
under strong price momentum). *Result (BTC, pre-committed fee-only contrarian grid, honest N=54):*
net Sharpe **1.33** vs B&H 0.60; PASSES net-of-cost (4bps/side), baselines, **DSR p=0.968@N=54**,
block-bootstrap CI>0, **CPCV/PBO=0.20**, Harvey-Liu adjP=9e-4, **phase-rand surrogate p=0.005 (1000
surr)**, consume-once holdout **+0.59 OOS (2023-12→2026-05) vs B&H 0.45**. Robustness: **10/10
in-sample years positive** (0.22–2.81), neighborhood is a PLATEAU (0.97–1.33, no spike), short-only
overvalued leg standalone +0.38 (genuine — shorting a rising asset on high fee-NVTS still profits).
*Caveats / why confidence is med not high:* (1) DSR clears 0.95 only because N is restricted to the
a-priori fee-only contrarian family (full 4-denominator grid N=312 → DSR 0.894, PROMISING); the
restriction is economically justified by the probe but is a researcher choice; (2) the pre-registered
canonical (90/365) is weak (net 0.74, surrP 0.066) — the SURVIVE rides the selected 30/730 best;
(3) **ETH KILLs** (holdout −0.59, PBO 0.50, haircut fails) — no cross-asset confirmation, so the BTC
result may be BTC-fee-regime-specific. *Prior:* D5-06/D5-07 naive NVT = KILL. *Status:* SURVIVE (BTC,
free fee-proxy) / canonical-NVT DEFERRED (paid). *Refs:* Burniske 2017 / Woo "Bitcoin NVT Ratio";
Kalichkin 2018 "Rethinking NVT Ratio" (NVTS); Theiler 1992 (phase-randomization surrogate). *Artifacts:*
`scripts/edgehunt-onchain2/{load_nvt,probe_nvts,probe_fee_orthog,run_nvts,strengthen_nvts,robust_nvts}.ts`,
`output/edgehunt-onchain2/{cm_tx_*,result_nvts_*,result_nvts_strong_*,strengthen_summary}.json`.

**D5-08 Exchange netflow / reserve-depletion trend.** *Belief:* outflows/declining reserve =
bullish supply leaving; inflows = bearish. *Mechanism:* liquidity/availability; weakened by entity-
clustering, custody migrations, ETF re-plumbing. *Test:* Coin Metrics flows (entity-list
dependent); block + phase-rand + **detrend-vs-price** (a falling reserve over a bull cycle is
mechanically correlated with rising price); KEY control = NB already tested netflow — value is the
reserve-*trend* + detrend control. *Prior:* KILL. *Status:* refines NB. *Refs:* CryptoQuant /
Glassnode exchange-flow docs; Coin Metrics flow methodology (~approx); NB internal cross-ref.

**D5-09 Puell Multiple.** *Belief:* <0.5 = miner-stress bottom, >4 = windfall top. *Mechanism:*
issuance is ~constant in BTC terms → Puell ≈ price/365d-MA(price) up to the halving step (a Mayer-
multiple cousin). *Test:* free; phase-rand + **price-only Mayer control** + halving-step removal;
honest N: single-digit independent events. *Prior:* KILL (relabeled price oscillator; less certain
for fee-dominated chains). *Status:* NEW (Mayer cousin). *Refs:* Puell 2019 "The Puell Multiple"
(~approx); Mayer "Mayer Multiple."

**D5-10 Hash Ribbons.** *Belief:* miner capitulation→recovery = strong long. *Mechanism:* hash-rate
30/60d MA cross; the *price-confirmation* clause does heavy lifting. *Test:* free (`HashRate`);
**MA-cross-on-surrogate** + decompose (price-trigger-only vs hash-only); honest N: ~5–7 historical
buy-events → tiny N, huge haircut; KEY control = the edge (if any) lives in the price-recovery
trigger (a TSMOM entry). *Prior:* KILL on honest-N. *Status:* NEW (TA2/TA4 overlap). *Refs:*
Edwards / Capriole 2019 "Hash Ribbons"; Moskowitz, Ooi & Pedersen 2012, *JFE* 104(2).

**D5-11 CDD / Dormancy.** *Belief:* CDD/dormancy spikes = old whales moving (distribution) → top.
*Mechanism:* age-weighting is genuinely independent of price level. *Test:* CDD effectively paid;
proxy via supply-age bands (degraded, disclose); calendar-reanchor of spike dates + block; KEY
control = **age-shuffle** (reassign destroyed coin-days at random, preserving volume — if age-
blind predicts as well, age carried nothing). *Prior:* **UNC — worth a shot** (one of the few
D5 signals structurally orthogonal to price; the age-shuffle is the make-or-break). *Status:* NEW.
*Refs:* Glassnode CDD/Dormancy/Dormancy-Flow docs; Burger/Glassnode 2019 "Reserve Risk" (~approx);
Theiler et al. 1992.

**D5-12 HODL waves / RHODL.** *Belief:* rising 1y+/2y+ bands = accumulation/bottom; young-band
expansion = top. *Mechanism:* supply maturation; bands roughly price-independent but very low-
frequency. *Test:* Coin Metrics partial age coverage (1y+ proxy free); long-block bootstrap +
calendar-reanchor of "1y+ at new high"; KEY control = **lead-lag causality** (does 1y+ supply lead
price or merely lag it — a lagged echo of the previous cycle?). *Prior:* KILL (lagged echo +
ultra-low independent-N). *Status:* NEW. *Refs:* Unchained Capital 2018 "Bitcoin Data Science:
HODL Waves"; Glassnode RHODL docs.

**D5-13 Stablecoin Supply Ratio (SSR).** *Belief:* low SSR = dry powder → bullish. *Mechanism:*
stablecoins as the buying-power reservoir; but supply is endogenous to price (mints follow
rallies). *Test:* **fully free** (BTC cap + DefiLlama stables); phase-rand + block + denominator-
isolation; KEY control = era/regime control (stablecoin supply grew structurally 2019→22 then
contracted — a one-off, not a repeatable oscillator). *Prior:* KILL (flow-variant worth-a-shot).
*Status:* NEW. *Refs:* Glassnode SSR docs; DefiLlama Stablecoins API (free).

**D5-14 Stablecoin net mint/burn impulse.** *Belief:* big mints precede pumps ("follow the
printer"). *Mechanism:* net new stablecoin = fiat on-ramp; the impulse is more event-like than the
SSR level. *Test:* **free** (DefiLlama daily supply → first-difference, per issuer); calendar-
reanchor + block; KEY control = **lead-lag + same-bar exclusion** (mints often follow price up —
count only mints preceding the move by ≥1 day). *Prior:* KILL (mostly reactive; impulse-with-lag
is the worth-a-shot version). *Status:* NEW (impulse variant of D5-13). *Refs:* DefiLlama
Stablecoins API; Griffin & Shams 2020 "Is Bitcoin Really Untethered?," *J. Finance* 75(4).

**D5-15 Whale / large-holder accumulation.** *Belief:* rising >1k BTC supply = smart money buying.
*Mechanism:* informed large holders front-run — IF cohort clustering tracks true ownership (often
not: exchanges/ETFs/custodians are giant "whales"). *Test:* clean cohort tags largely paid; free
balance-band proxy (entity gaps); block + entity-shuffle; KEY control = **exchange/ETF de-
confounding** ("whale accumulation" is often coins moving into Coinbase/BlackRock custody) + lead-
lag. *Prior:* KILL (ETF era especially confounded). *Status:* NEW. *Refs:* Glassnode supply-
distribution / accumulation-address docs; Makarov & Schoar 2021 "Blockchain Analysis of the
Bitcoin Market," *NBER WP 29396*.

**D5-16 Active-address / Metcalfe valuation.** *Belief:* price < Metcalfe-implied (∝ users²) =
buy. *Mechanism:* network-effect valuation; addresses gameable/spam-inflated; n² fit is curve-fit.
*Test:* free (`AdrActCnt`); phase-rand of the price-vs-Metcalfe residual; the **fit-form (n, n·log
n, n²) is a mining knob — freeze the exponent OOS**; KEY control = causality + de-spam (does
adoption lead price or lag it?). *Prior:* KILL (coincident, gameable, curve-fit). *Status:* NEW.
*Refs:* Metcalfe 2013 "Metcalfe's Law after 40 Years," *IEEE Computer* 46(12); Peterson 2018
"Metcalfe's Law as a Model for Bitcoin's Value," *Ledger* 3; Wheatley et al. 2019 "Are Bitcoin
bubbles predictable?… generalized Metcalfe's law," *Royal Society Open Science* 6(6).

**D5-17 Stock-to-Flow deviation (adversarial).** *Belief:* price ∝ S2F^k, below-model = buy.
*Mechanism:* S2F is a deterministic function of time → predicting price from a clock + a power law
on ~2 halvings = classic **spurious regression** (Granger-Newbold); failed live post-2021. *Test:*
free; the decisive control = a **stationarity/spurious-regression test** (fit S2F's power law on
surrogate price sharing the trend — if surrogates fit equally well, the R² was spurious) + the
post-2021 holdout it already failed. *Prior:* KILL! — near-certain, the **highest-value teaching
kill**. *Status:* NEW (adversarial). *Refs:* PlanB 2019 "Modeling Bitcoin Value with Scarcity"
(origin, cite as belief); Granger & Newbold 1974 "Spurious Regressions in Econometrics," *J.
Econometrics* 2(2); 2021–22 live-failure critiques (~approx).

**D5-18 Thermocap / Thermocap-multiple.** *Belief:* price near Thermocap floor = buy. *Mechanism:*
cumulative miner spend as a "true cost" floor (realized-cap cousin) → mostly-price-driven ratio.
*Test:* free; phase-rand + price-only control; the floor multiplier (×4/×8/×32) is pure curve-fit;
KEY control = demonstrate algebraic kinship to realized-cap/MVRV (don't double-count vs OC1).
*Prior:* KILL. *Status:* NEW (realized-cap sibling). *Refs:* Coin Metrics "Thermocap" (~approx);
OC1 internal cross-ref.

**D5-19 Reserve Risk.** *Belief:* low Reserve Risk = strong-hand conviction high, price low = buy.
*Mechanism:* Price / HODL-bank (cumulative dormancy-value) — embeds the partly price-orthogonal
dormancy. *Test:* dormancy/HODL-bank largely paid (proxy degraded); phase-rand + age-shuffle; KEY
control = decompose price-term vs dormancy-term (if price alone reproduces it, conviction is
decorative). *Prior:* UNC / lean KILL (inherits CDD's data + tiny-N problems). *Status:* NEW
(D5-11 + price). *Refs:* Hauge/Glassnode 2019 "Reserve Risk" docs; D5-11 internal cross-ref.

**D5-20 On-chain confluence ("3-of-5 agree").** *Belief:* agreement filters false positives →
higher-quality signals. *Mechanism:* if constituents are algebraically correlated price transforms
(MVRV≈NUPL≈Thermocap), "confluence" is the same bet voting for itself → inflated significance.
*Test:* free; panel/marginal seed; honest N = worst offender (k × 2^5−1 subsets × each
constituent's params → thousands); KEY control = **effective-independent-signal count** (eigen-
structure collapses to ~1 factor = price → honest-N must reflect 1 bet, not 5). *Prior:* KILL!
(on-chain version of NF3). *Status:* refines NF3 (on-chain). *Refs:* Bailey, Borwein, López de
Prado & Zhu 2017, *JCF* 20(4); Harvey, Liu & Zhu 2016 "…and the Cross-Section of Expected
Returns," *RFS* 29(1); NF3 internal cross-ref.

---

### Domain D6 — Sentiment / alternative data + cross-asset / macro (beyond NC)

**Prior.** Almost every sentiment/macro signal that looks predictive is a **proxy for BTC long-
beta** (coincident or lagging) or a small-slow-panel selection artifact. D6 needs three domain-
specific gates: a **causality/lead-lag gate** (strictly-lagged-only + Granger/transfer-entropy
signal→return), **multi-factor macro-beta neutralization** (orthogonalize PnL vs {BTC, SPX, DXY,
net-liquidity}), and **slow-panel cycle-count honest-N** (DSR/CPCV key off independent macro
cycles, not daily obs).

**D6-S1 Crypto Fear & Greed contrarian.** *Belief:* buy Extreme Fear, sell Extreme Greed.
*Mechanism:* CFGI is constructed largely from price-derived inputs (vol+momentum) → a lagged
transform of price; recent work finds returns Granger-cause the index. *Test:* **$0**
(`api.alternative.me/fng`); block/phase + **AR-matched placebo index** (replace CFGI with an AR(1)
matched to its autocorr/variance — if the rule scores the same, sentiment content is zero); KEY
control = long-beta + lead-lag gate. *Prior:* KILL. *Status:* refines NC + T-reversal. *Refs:*
Baur & Dimpfl 2018 "Asymmetric volatility in cryptocurrencies," *Economics Letters* 173; "Do
Bitcoin returns move sentiment? … Crypto Fear & Greed Index," *Finance Research Letters* (~approx);
Gaies, Nakhli et al. 2023, *Research in International Business and Finance* (~approx).

**D6-S2 Funding-rate-as-sentiment.** *Belief:* very positive funding = crowded longs → fade.
*Mechanism:* funding is a real crowding gauge, but a structural carry edge (the 2 survivors) is
distinct from contrarian timing; fading funding = fading momentum. *Test:* **$0** (Binance/Bybit/
OKX funding history); block + **carry-neutralized placebo** (strip the deterministic funding-
accrual PnL, test only the timing overlay); KEY control = carry baseline + long-beta. *Prior:* WS
on structure / KILL on contrarian timing (the project's cleanest "real-edge-but-wrong-thing"
separation). *Status:* refines T-carry/TA1 + survivors. *Refs:* "Crypto Carry," *BIS Working Paper
1087* (2023); Koijen, Moskowitz, Pedersen & Vrugt 2018 "Carry," *JFE* 127(2); Christin et al.
"The Crypto Carry Trade" (CMU WP).

**D6-S3 Social volume / sentiment.** *Belief:* social spikes precede price, especially for alts.
*Mechanism:* attention is largely a contemporaneous demand proxy. *Test:* Google Trends/Reddit
free-ish, **LunarCrush/Santiment full history largely paid** (NOT fully $0); block +
**cross-sectional shuffle** (alt panel); KEY control = strictly-lagged + Granger + long-beta.
*Prior:* KILL (BTC) / UNC (alt cross-section, echoes R2). *Status:* refines R2 + C-rotation.
*Refs:* Liu & Tsyvinski 2021 "Risks and Returns of Cryptocurrency," *RFS* 34(6); Liu, Tsyvinski &
Wu 2022 "Common Risk Factors in Cryptocurrency," *J. Finance* 77(2); Mai et al. 2018, *J.
Management Information Systems* 35(1); Garcia & Schweitzer 2015, *Royal Society Open Science* 2(9);
Kristoufek 2013 "BitCoin meets Google Trends and Wikipedia," *Scientific Reports* 3.

**D6-S4 Google Trends.** *Belief:* rising search interest precedes rallies. *Mechanism:* Kristoufek
found bidirectional/reinforcing feedback, not a clean lead. *Test:* **$0 but vintage-trap**
(weekly beyond 90d, rescaled, revised); phase-rand + calendar-reanchor; KEY control = **point-in-
time (vintage) Trends** (only the value queryable at decision time) + long-beta. *Prior:* KILL.
*Status:* NEW (sibling S3). *Refs:* Kristoufek 2013, *Scientific Reports* 3:3415; Da, Engelberg &
Gao 2011 "In Search of Attention," *J. Finance* 66(5); Yelowitz & Wilson 2015, *Applied Economics
Letters* 22(13) (~approx).

**D6-S5 News sentiment (GDELT).** *Belief:* aggregate tone predicts next-day returns. *Mechanism:*
financial news is overwhelmingly reactive. *Test:* **GDELT 2.0 free** (BigQuery `gdelt-bq`);
block + **AR-matched placebo tone series**; KEY control = lagged-only + long-beta + de-trend.
*Prior:* KILL. *Status:* NEW (cf ND, event-study). *Refs:* Leetaru & Schrodt 2013 "GDELT," *ISA
Annual Convention*; Tetlock 2007 "Giving Content to Investor Sentiment," *J. Finance* 62(3);
Rognone, Hyde & Zhang 2020 "News sentiment in the cryptocurrency market," *International Review of
Financial Analysis* 69.

**D6-S6 Options put/call ratio sentiment.** *Belief:* high P/C = fear → buy. *Mechanism:* crypto
options thin/dealer-dominated/basis-driven; coincident. *Test:* **$0** (Deribit OI/volume); block
+ bracket-on-surrogate (if bracketed); KEY control = long-beta + basis-neutralization (strip
cash-and-carry/overwriting). *Prior:* KILL. *Status:* refines NA. *Refs:* Alexander & Imeraj 2021
"The Bitcoin VIX and its variance risk premium," *J. Alternative Investments* (~approx); Pan &
Poteshman 2006, *RFS* 19(3).

**D6-S7 Long/short account ratio.** *Belief:* fade the retail crowd / follow top traders.
*Mechanism:* ratios derived from the same venue's flow, reflect current price, gameable, very
short non-stationary history. *Test:* **$0** (Binance `globalLongShortAccountRatio` /
`topLongShortAccountRatio`, ~30d rolling — history-limited); block + AR-matched placebo; KEY
control = long-beta + look-ahead audit (REST timestamping leaks). *Prior:* KILL. *Status:* NEW
(sibling S2). *Refs:* Binance Futures API docs; Kumar & Lee 2006 "Retail Investor Sentiment and
Return Comovements," *J. Finance* 61(5); Barber & Odean 2000 "Trading Is Hazardous to Your
Wealth," *J. Finance* 55(2).

**D6-M1 BTC vs US rates / 2s10s curve.** *Belief:* hawkish Fed bad for BTC; curve regime-shifts
BTC. *Mechanism:* contemporaneous risk-on/off beta, regime-dependent and unstable; rates move
slowly → no tradable lead. *Test:* **$0** (stooq/FRED DGS2/DGS10/T10Y2Y); long-block bootstrap +
macro-marginal seed; honest N = ~2–4 macro regimes (not daily obs); KEY control = macro-beta
neutralization (orthogonalize vs SPX) + out-of-regime holdout. *Prior:* KILL. *Status:* refines NC
/ ND. *Refs:* Liu & Tsyvinski 2021, *RFS* (crypto has little macro-factor exposure); Corbet,
Lucey, Urquhart & Yarovaya 2019, *International Review of Financial Analysis* 62; Conlon, Corbet &
McGee 2021, *Research in International Business and Finance* 54.

**D6-M2 Credit spreads (HY OAS).** *Belief:* widening spreads → risk-off → reduce BTC. *Mechanism:*
HY OAS leads risk assets; for crypto the lead is weak (risk-on/off beta), few credit cycles.
*Test:* **$0** (FRED `BAMLH0A0HYM2`); long-block bootstrap; effective N tiny; KEY control =
risk-on beta neutralization + out-of-cycle holdout. *Prior:* KILL. *Status:* refines NC / ND.
*Refs:* Gilchrist & Zakrajšek 2012 "Credit Spreads and Business Cycle Fluctuations," *American
Economic Review* 102(4); Corbet et al. 2019, *IRFA* 62.

**D6-M3 Global dollar liquidity (WALCL−TGA−RRP).** *Belief:* BTC tracks net liquidity / global M2.
*Mechanism:* BTC has no cash flows → pure liquidity sensitivity (Lyn Alden / Michael Howell) — but
slow, low-frequency, largely coincident. *Test:* **$0** (FRED `WALCL`/`WTREGEN`/`RRPONTSYD`); long-
block + phase-rand + macro-marginal seed; honest N = **worst case in the domain** (~2–3 cycles, not
weeks); KEY control = lead-lag gate + de-trend both series (both share a secular uptrend). *Prior:*
KILL on tradability / UNC on the long-horizon regime descriptor (document the honest-N ceiling).
*Status:* refines NC / ND. *Refs:* Howell 2020 *Capital Wars* (Palgrave); Alden 2023 "Bitcoin: A
Global Liquidity Barometer" (lynalden.com, ~practitioner); Karau 2023 "Monetary policy and
Bitcoin," *J. International Money and Finance*.

**D6-M4 Real yields & gold ("digital gold").** *Belief:* falling 10Y TIPS real yields → buy BTC;
BTC tracks gold. *Mechanism:* weak/unstable gold correlation; inflation-hedge failed in 2021–22.
*Test:* **$0** (FRED `DFII10`, stooq XAU); long-block + pair shuffle (BTC–gold spread); KEY control
= risk-on beta + regime-split holdout. *Prior:* KILL (thesis already failed OOS). *Status:* NEW
(sibling M1/M3). *Refs:* Baur, Hong & Lee 2018 "Bitcoin: Medium of exchange or speculative
assets?," *J. International Financial Markets, Institutions & Money* 54; Conlon, Corbet & McGee
2021, *RIBAF* 54; Smales 2019 "Bitcoin as a safe haven," *Finance Research Letters* 30.

**D6-M5 Spot BTC ETF flows.** *Belief:* inflows → buy, outflows → sell; track daily net flow.
*Mechanism:* AP creation forces real spot buying — but flows largely chase performance (reflexive)
and history is ~2024+ (single regime). *Test:* issuer/Farside flows free but **terms-limited /
short** (NOT fully $0); block + event-study placebo; KEY control = lagged-only flow + **orthogonalize
vs same-day flow** (only same-day mechanical impact may matter) + long-beta. *Prior:* KILL on lagged
signal / UNC but unfundable to a clean verdict (provisional KILL, revisit with more data). *Status:*
NEW (cf C4). *Refs:* Ben-David, Franzoni & Moussawi 2018 "Do ETFs Increase Volatility?," *J.
Finance* 73(6); Brown, Davies & Ringgenberg 2021 "ETF arbitrage, non-fundamental demand, and
return predictability," *Review of Finance* 25(4); Farside daily-flow disclosures (data source).

**D6-M6 DXY/SPX correlation-regime trading.** *Belief:* toggle exposure by correlation regime.
*Mechanism:* a second estimation/overfit layer on an already-coincident relationship. *Test:* **$0**
(stooq SPX/DXY, FRED `DTWEXBGS`); block-bootstrap preserving cross-correlation; KEY control =
fixed-exposure baseline + beta neutralization (the toggle is curve-fit to past correlation breaks).
*Prior:* KILL. *Status:* refines NC. *Refs:* Corbet et al. 2019, *IRFA* 62; Iyer 2022 "Cryptic
Connections," *IMF Global Financial Stability Note* 2022/01; Engle 2002 "Dynamic Conditional
Correlation," *J. Business & Economic Statistics* 20(3).

**D6-M7 Risk-parity / vol-target crypto sleeve.** *Belief:* an inverse-vol BTC sleeve improves
risk-adjusted return + diversifies. *Mechanism:* legitimate construction, but the alpha question is
whether the sleeve adds return beyond its beta after cost; vol-targeting reshapes the path more
than it creates edge. *Test:* **$0** (stooq + Binance + FRED); **allocation-on-surrogate** (same
risk-parity machinery on a vol-matched scrambled BTC series) + macro-marginal seed; KEY control =
vs leverage-matched buy&hold after turnover cost. *Prior:* KILL on alpha / WS on risk-shaping
(parallels the carry/stops findings). *Status:* NEW. *Refs:* Maillard, Roncalli & Teïletche 2010
"The Properties of Equally-Weighted Risk Contribution Portfolios," *J. Portfolio Management* 36(4);
Moreira & Muir 2017, *J. Finance* 72(4); Harvey et al. 2018, *J. Portfolio Management* 45(1).

---

### Domain D7 — Calendar/seasonality + event-driven flows

**Free-data verdict.** Seasonality (D7.1–D7.9) is fully $0 and several are **point-in-time clean**
(halving, expiry, FOMC/CPI dates are deterministic/scheduled). Event-driven flows (D7.10–D7.21)
are where free data breaks: token-unlock schedules, airdrop snapshots, listing announcements, index
changes, hack timelines are **current-state or revised, not as-of vintages** — a fatal look-ahead
source. The correct null for nearly all events is **calendar-reanchor** (re-run on random fake event
dates). Two PIT-clean event sets stand out: governance votes (Snapshot/Tally on-chain timestamps)
and ETF flows (published T+1).

**D7.1 Four-year halving cycle.** *Belief:* deterministic post-halving rally beats B&H. *Mechanism:*
supply-shock narrative (issuance ~1.8%/yr now ≪ turnover) + reflexivity; n=3–4 events. *Test:* $0,
PIT-clean dates; **calendar-reanchor** (random fake halving anchors) + phase-rand; honest N: only
3–4 non-overlapping cycles → DSR fails; KEY control = long-beta (post-halving-year rule inherits
the bull legs). *Prior:* KILL! (n≈3 unfalsifiable-in-favor — high value as the "n=3 cannot clear the
bar" result). *Status:* NEW. *Refs:* Meynkhard 2019, *Investment Management and Financial
Innovations* 16(4); Akyildirim et al. 2024, *J. Risk and Financial Management* 17(6):229; PlanB 2019
(S2F belief).

**D7.2 Sell-in-May / Halloween.** *Belief:* flat May–Oct, long Nov–Apr. *Mechanism:* equity
vacation-liquidity story, no crypto-native mechanism; ~10 effective obs. *Test:* $0; calendar-
reanchor / month-permutation + monthly block-bootstrap; KEY control = exposure/long-beta + demean
secular drift. *Prior:* KILL!. *Status:* NEW (cf T4/ND). *Refs:* Bouman & Jacobsen 2002 "The
Halloween Indicator," *American Economic Review* 92(5); Zhang & Jacobsen 2021, *J. International
Money and Finance*; Caporale & Plastun 2019, *Finance Research Letters* 31.

**D7.3 Day-of-week / Monday effect.** *Belief:* Mondays bullish in BTC. *Mechanism:* weekend-effect
analog; recent bootstrap-corrected work finds it vanishes post-2018 (a daily-bar smearing artifact).
*Test:* $0 (15m, UTC and exchange-local boundaries); block + DoW-label permute + phase-rand; KEY
control = **this is the ND precedent** (ND day-of-week KILL: `deflated_sharpe` + surrogate
placeboP=0.75 + holdout −0.017). *Prior:* KILL (already shown by ND). *Status:* refines ND. *Refs:*
Caporale & Plastun 2019, *FRL* 31:258–269; Aharon & Qadan 2019, *FRL* 31; Kristoufek 2013/2018
(~approx).

**D7.4 Weekend effect / CME-gap interaction.** *Belief:* fade the weekend move; Monday reverts to
Friday CME close. *Mechanism:* liquidity-microstructure folklore; gap-fill is survivorship-biased
pattern-spotting. *Test:* $0 (spot 24/7 + CME calendar/stooq); **bracket-on-surrogate** (path-
dependent gap-fill on vol-matched surrogate weekends) + calendar-reanchor; KEY control = base-rate
(price revisits any nearby level eventually — the random-lines/Fibonacci control). *Prior:* KILL.
*Status:* refines ND + D7.20; NF2. *Refs:* Caporale & Plastun 2019; López de Prado 2018 (triple-
barrier surrogate); Baur, Cahill, Godfrey & Liu 2019 "Bitcoin time-of-day, day-of-week and
month-of-year effects," *FRL* 31.

**D7.5 Turn-of-month (TOM).** *Belief:* returns cluster around month-end/start. *Mechanism:* equity
TOM tied to payroll/401k flows crypto lacks. *Test:* $0; calendar-reanchor (slide the window to
random month-positions) + monthly block; KEY control = long-beta + no double-count with D7.6.
*Prior:* KILL. *Status:* refines T6. *Refs:* Ariel 1987 "A monthly effect in stock returns," *JFE*
18(1); Lakonishok & Smidt 1988, *RFS* 1(4); McConnell & Xu 2008, *FAJ* 64(2).

**D7.6 Monthly/quarterly/index-rebalancing dates.** *Belief:* front-run the rebalance. *Mechanism:*
equity index-effect analog, but crypto index AUM is small relative to turnover; dates diverge
across products. *Test:* spot $0, **rebalance schedules PIT-fragile** (reconstruct from press
releases = look-ahead); calendar-reanchor + cross-sectional shuffle; KEY control = beat B&H of the
added asset (added because it pumped = coincident momentum). *Prior:* KILL. *Status:* NEW (cf
C1/C4, D7.16). *Refs:* Shleifer 1986 "Do demand curves for stocks slope down?," *J. Finance* 41(3);
Harris & Gurel 1986, *J. Finance* 41(4); Petajisto 2011, *J. Empirical Finance* 18(2).

**D7.7 Options/futures expiry / max-pain.** *Belief:* price pins to max-pain into expiry.
*Mechanism:* gamma-pinning real in some equities; in crypto dealers aren't uniformly short gamma,
cash-settlement weakens it; NA already tested. *Test:* $0 (Deribit/CME public); calendar-reanchor +
bracket-on-surrogate + **placebo-strike** (target a random strike); KEY control = endogeneity (max-
pain tracks spot — freeze at t−24h and test forward pin). *Prior:* KILL (consistent with NA).
*Status:* refines NA. *Refs:* Ni, Pearson & Poteshman 2005, *JFE* 78(1); Alexander, Deng, Feng & Wan
2023 "Net buying pressure and the information in bitcoin option trades," *J. Financial Markets*
(~approx).

**D7.8 US-session vs Asia-session.** *Belief:* BTC trends in US hours, chops in Asia. *Mechanism:*
real vol seasonality; directional edge regime-dependent and flips. *Test:* $0 (15m); phase-rand +
hour-label permute (ND used N=28); KEY control = long-beta within session + stability across regimes
(consume-once holdout; ND holdout failed −0.017). *Prior:* KILL (direction); vol-seasonality real-
but-untradeable. *Status:* refines ND. *Refs:* Baur, Cahill, Godfrey & Liu 2019, *FRL* 31; Eross et
al. 2019 "The intraday dynamics of bitcoin," *RIBAF* 49; Admati & Pfleiderer 1988 "A theory of
intraday patterns," *RFS* 1(1).

**D7.9 Tax-loss selling (Dec dip / Jan effect).** *Belief:* short late-Dec / long early-Jan.
*Mechanism:* **genuinely crypto-specific and real** — US wash-sale rule historically didn't apply
to crypto (property), strong incentive to harvest in Dec and rebuy; but US-only, down-years-only,
small-N. *Test:* $0 (price + down-YTD conditioning; optional Coin Metrics realized-loss proxy);
calendar-reanchor + **conditional block-bootstrap stratified by up/down-year** (effect should appear
only in down years — a falsifiable conditional prediction); honest N ≈ 6 down-Decembers; KEY control
= the down-year conditioning is the discriminator. *Prior:* **WS — real mechanism, KILL-likely on
tradeability** (highest-value-to-publish: "real story, not enough events"). *Status:* NEW. *Refs:*
Roll 1983 "Vas ist das? The turn-of-the-year effect…," *J. Portfolio Management* 9(2); Grinblatt &
Moskowitz 2004, *JFE* 71(3); Cong, Landsman, Maydew & Rabetti 2023 "Tax-loss harvesting with
cryptocurrencies," *J. Accounting and Economics* 76(2-3).

**D7.10 Token unlocks / vesting cliffs.** *Belief:* sell into the cliff (Keyrock: ~90% of unlocks
followed by decline, starting ~30d pre-unlock). *Mechanism:* supply-overhang — insiders sell, and
the known date is front-run (a real, calendar-anticipatable flow). *Test:* price $0 but **unlock
calendars are current-state / revised (NOT clean as-of vintages)** — disclose hard; calendar-
reanchor + cross-sectional placebo (tokens without an unlock) + bracket-on-surrogate; KEY control =
small-cap/illiquidity beta (R2 kill — unlock-heavy tokens are small high-beta alts that fell anyway)
+ announcement-vs-execution. *Prior:* **UNC — strongest event candidate** (likely SURVIVE-on-paper-
but-not-net, or KILL-on-data-quality). *Status:* NEW. *Refs:* Keyrock 2024 "Token Unlocks:
Quantifying the Sell Pressure" (industry, cite as belief/effect-size); Cong, Li & Wang 2021
"Tokenomics: Dynamic adoption and valuation," *RFS* 34(3).

**D7.11 Airdrops / post-airdrop dumps.** *Belief:* recipients dump day-1; short the open / buy the
washout. *Mechanism:* mercenary farmers sell free tokens → mechanical TGE sell pressure; heterogeneous,
one-shot. *Test:* **poorly fundable at $0, severe PIT + survivorship** (failed tokens delist and
vanish); calendar-reanchor + cross-sectional placebo + bracket-on-surrogate; KEY control = survivorship
+ listing-microstructure (C4 kill — must beat the C4 listing-day baseline). *Prior:* KILL. *Status:*
NEW (overlaps C4). *Refs:* Makarov & Schoar 2020 "Trading and arbitrage in cryptocurrency markets,"
*JFE* 135(2); Howell, Niessner & Yermack 2020 "Initial coin offerings," *RFS* 33(9).

**D7.12 Exchange listings / delistings.** *Belief:* buy the listing announcement / short the delist
notice. *Mechanism:* listing = liquidity/access/legitimacy shock; the announcement carries the news;
C4 tested listing. *Test:* announcements partially $0 but **historical timestamps not cleanly
archived** (scrape); delisting survivorship total; calendar-reanchor + cross-sectional placebo; KEY
control = coincident momentum (exchanges list winners — pre-announcement momentum-neutralization).
*Prior:* KILL (consistent with C4). *Status:* refines C4 (delist NEW). *Refs:* C4 internal; Makarov
& Schoar 2020 (microstructure backdrop); exchange-listing event studies (~approx).

**D7.13 Governance votes / proposals.** *Belief:* token rallies into a major vote, sells the news.
*Mechanism:* fee-switch/buyback/emissions changes reprice the token; pre-vote accumulation for
voting weight. *Test:* **$0 and PIT-clean** (Snapshot/Tally on-chain timestamps); calendar-reanchor +
cross-sectional placebo; stratify by proposal type; KEY control = token-beta + outcome-endogeneity
(votes pass bullish proposals in bull regimes). *Prior:* KILL-likely but UNC and **high-value-to-
publish** (clean PIT data, real mechanism, tiny N). *Status:* NEW. *Refs:* Fritsch, Müller &
Wattenhofer 2022 "Analyzing voting power in decentralized governance" (arXiv); Barbereau et al.
2022/23 DeFi governance (~approx).

**D7.14 Protocol hacks & exploits.** *Belief:* short the exploit headline; the drop overshoots then
recovers. *Mechanism:* permanent impairment + confidence shock → over/under-reaction; category
contagion. *Test:* Rekt/DefiLlama-hacks dates partially $0 but **timestamps approximate/curated
ex-post**; calendar-reanchor + bracket-on-surrogate + cross-sectional contagion; KEY control =
capturability (can't short faster than the −40% gap; only the post-gap drift is realizable, and
liquidity collapses → cost model understates slippage). *Prior:* KILL! (un-capturable at retail).
*Status:* NEW. *Refs:* Zhou et al. 2023 "SoK: Decentralized Finance (DeFi) attacks," *IEEE S&P*;
Gandal, Hamrick, Moore & Oberman 2018 "Price manipulation in the Bitcoin ecosystem," *J. Monetary
Economics* 95.

**D7.15 ETF approval / launch + flow-following.** *Belief:* buy approval, sell launch; follow daily
flows. *Mechanism:* approval = one-time re-rating (n=1); flow-following is the serious quant claim
but flows chase price (reflexive). *Test:* approval dates deterministic; **daily flows free + PIT-
clean (T+1 lag)**; calendar-reanchor (approval n=1) / placebo flow; KEY control = **flow ≡ price
reflexivity** (orthogonalize flow vs trailing return; test the residual) + lag flows by publication
delay. *Prior:* approval KILL (n=1, untestable); flow-following WS but KILL-likely after
orthogonalization. *Status:* NEW. *Refs:* Ben-David, Franzoni & Moussawi 2018, *J. Finance* 73(6);
Madhavan 2016 *Exchange-Traded Funds and the New Dynamics of Investing* (Oxford).

**D7.16 Index inclusions.** *Belief:* inclusion → passive bid (S&P-500-effect analog). *Mechanism:*
crypto tracking AUM small, methodologies diverge. *Test:* same harness as D7.6 — price $0, inclusion
calendar PIT-fragile; calendar-reanchor + cross-sectional placebo; KEY control = coincident momentum
+ beat B&H of the added asset. *Prior:* KILL. *Status:* NEW (≈D7.6). *Refs:* Harris & Gurel 1986;
Shleifer 1986; Petajisto 2011.

**D7.17 Mainnet launches / network upgrades.** *Belief:* buy the upgrade narrative, sell activation.
*Mechanism:* upgrades can change tokenomics (EIP-1559 burn, the Merge issuance cut) = real shift +
narrative run-up; some dates deterministic. *Test:* **$0, PIT-clean** (block-height/epoch dates;
Coin Metrics issuance/burn); calendar-reanchor + cross-sectional placebo + bracket-on-surrogate; KEY
control = narrative-beta + n=1 fundamentals (the Merge n=1 can't clear DSR). *Prior:* KILL. *Status:*
NEW (cf D7.1). *Refs:* Easley, O'Hara & Basu 2019 "From mining to markets," *JFE* 134(1); Coin
Metrics upgrade analyses (~industry).

**D7.18 Stablecoin issuance / printing (mint-as-event).** *Belief:* USDT/USDC mints precede pumps.
*Mechanism:* dry powder entering, or reverse-causal (mints respond to demand). *Test:* **$0, PIT-
clean** (Coin Metrics/DefiLlama supply); block/phase + placebo mint; KEY control = **reverse
causality / coincident demand** (orthogonalize mints vs trailing return/flow; test the residual; lag
by confirmation delay). *Prior:* KILL-likely (worth-a-shot — widespread "printer = pump" belief).
*Status:* NEW (cf OC1, carry). *Refs:* Griffin & Shams 2020 "Is Bitcoin really untethered?," *J.
Finance* 75(4); Lyons & Viswanath-Natraj 2023 "What keeps stablecoins stable?," *J. International
Money and Finance* 131; Ante, Fiedler & Strehle 2021, *Technological Forecasting and Social Change*
170.

**D7.19 Funding-rate settlement timing.** *Belief:* position around the 8h funding stamp.
*Mechanism:* fixed stamps create predictable micro-flows; the carry edge already survived sub-RF.
*Test:* $0 (Bybit/Binance funding 8h + 15m); calendar-reanchor stamps + block; KEY control =
**must add over the carry survivor net of the extra turnover** (perfect-foresight carry beat
T-bills by <0.55%/yr — settlement timing must clear that thin bar + its churn). *Prior:* KILL.
*Status:* refines carry/TA1. *Refs:* internal carry survivor; Liu & Tsyvinski 2021, *RFS*
34(6):2689–2727; funding-mechanism docs.

**D7.20 CME gap fill (standalone).** *Belief:* an unfilled CME gap is a magnet that fills.
*Mechanism:* diffusion + memory bias — price revisits any nearby level eventually; only filled gaps
are remembered. *Test:* $0 (CME settlement/stooq + 24/7 spot); **random-level placebo** (fill-rate
for random nearby levels vs actual gaps — the Fibonacci/random-lines kill) + bracket-on-surrogate;
KEY control = unconditional revisit base-rate. *Prior:* KILL! (direct NF1/Fibonacci analog).
*Status:* NEW (cf D7.4, NF1). *Refs:* Lo & MacKinlay 1988 "Stock market prices do not follow random
walks," *RFS* 1(1); NF1 internal; Park & Irwin 2007, *J. Economic Surveys* 21(4).

**D7.21 Crypto pre-FOMC drift / macro events.** *Belief:* BTC rallies 24h before FOMC (equity
analog). *Mechanism:* equity pre-FOMC drift (Lucca-Moench) is robust; crypto would inherit it via
risk-asset correlation = inherited equity-beta, not a crypto edge. *Test:* **$0, PIT-clean** (FOMC/CPI
dates scheduled far ahead); calendar-reanchor + block; KEY control = **regress out SPX pre-FOMC
return; test the BTC residual** + condition on macro regime. *Prior:* **WS, KILL-likely on residual**
(clean high-value falsification). *Status:* NEW (cf NC). *Refs:* Lucca & Moench 2015 "The pre-FOMC
announcement drift," *J. Finance* 70(1); Savor & Wilson 2013, *JFQA* 48(2); Corbet, Larkin, Lucey,
Meegan & Yarovaya 2020 "Cryptocurrency reaction to FOMC announcements," *RIBAF* 51.

---

### Domain D8 — ML / quant methods + portfolio construction + carry/arb refinements

**Prior.** Part A (ML) is strong-KILL on standalone price-only ML — R3/R4 (GA-evolved rules) and
the in-repo neural full-history probes (`mlp/tcn/tsmixer_v2_real`, all `destructive_turnover`,
all worse than manual baselines) already demonstrate the overfit trap in *this exact pipeline*.
ML earns worth-a-shot only when fed economically-motivated cross-sectional features
(funding/basis/flow). Part B (portfolio/sizing) items are risk transforms, not alpha sources —
they cannot manufacture edge from a zero-edge book; test them on the carry survivors AND on a
zero-edge book. Part C (carry/arb) is the **highest hit-rate region** (the only survivors).

**D8-A1 GBDT (XGBoost/LightGBM) on cross-sectional features.** *Belief:* tree ensembles on a wide
feature matrix predict cross-sectional returns. *Mechanism:* trees capture interactions a linear
factor misses; folklore risk = fitting label noise + CV leak. *Test:* $0 (Binance + funding + OI +
Coin Metrics + DefiLlama, survivorship-controlled); **cross-sectional shuffle** (permute asset
labels within each date) + purged/embargoed CPCV; honest N = the full grid swept (Harvey–Liu
haircut on the headline); KEY control = residualize vs BTC / equal-weight alt basket / XS-vol
factor (SHAP dominated by trailing-return = re-discovering killed T1/T7). *Prior:* KILL (WS if
features restricted to carry/basis survivors). *Status:* NEW (cf R3/R4, D1-round2). *Refs:* Chen &
Guestrin 2016 "XGBoost," KDD; Ke et al. 2017 "LightGBM," NeurIPS; Gu, Kelly & Xiu 2020 "Empirical
Asset Pricing via Machine Learning," *RFS* 33(5); López de Prado 2018 *AFML* (Wiley); Lundberg &
Lee 2017 "SHAP," NeurIPS.

**D8-A2 LSTM/TCN/Transformer price-sequence models.** *Belief:* deep sequence models learn temporal
dependencies classical TA misses. *Mechanism:* returns near-martingale; the model memorizes
regime-specific noise (the in-repo `temporal_tcn_v2_real` ran −99.65% validation2,
`destructive_turnover`). *Test:* $0 (15m/1h klines + trade aggregates); **phase-randomization /
IAAFT surrogate** (preserves spectrum/autocorr, destroys nonlinear predictability) + block-
bootstrap; honest N = architecture/HPO sweep; KEY control = beat a same-feature logistic baseline +
random-entry at matched turnover, net-of-cost. *Prior:* KILL! (strongest in domain; high-value
public KILL of the ubiquitous "Transformer for crypto"). *Status:* refines R3 + neural probes.
*Refs:* Hochreiter & Schmidhuber 1997 "LSTM," *Neural Computation*; Bai, Kolter & Koltun 2018 "TCN,"
arXiv:1803.01271; Vaswani et al. 2017 "Attention Is All You Need," NeurIPS; Zeng et al. 2023 "Are
Transformers Effective for Time Series Forecasting?," AAAI; Theiler et al. 1992, *Physica D* 58.

**D8-A3 RL execution/position agent (DQN/PPO).** *Belief:* an RL agent learns an optimal policy
from PnL reward. *Mechanism:* RL can learn execution/inventory where the action affects state;
folklore = reward hacking + non-stationarity curve-fit. *Test:* $0 (perp 1m–1h with realistic
cost+slippage+funding env; reward net-of-cost by construction); **block-bootstrap many counterfactual
env paths** + random-policy baseline; honest N includes the **seed sweep** (report median across
seeds, not the best); KEY control = ablate price features (if equal with shuffled prices, the "edge"
is pure inventory/turnover). *Prior:* KILL (alpha) / UNC (execution-cost reduction has real published
edge). *Status:* NEW (cf R3/R4). *Refs:* Schulman et al. 2017 "PPO," arXiv:1707.06347; Mnih et al.
2015 "DQN," *Nature*; Nevmyvaka, Feng & Kearns 2006 "Reinforcement Learning for Optimized Trade
Execution," ICML; Henderson et al. 2018 "Deep Reinforcement Learning that Matters," AAAI.

**D8-A4 HMM / regime-switching gate.** *Belief:* trade the base signal only in the favorable regime.
*Mechanism:* return distributions are regime-dependent, but smoothed states use future data; the
favorable regime is selected post hoc. *Test:* $0; **filtered (causal) state probability only**;
block-bootstrap (fit HMM on bootstrapped series — if gating improves Sharpe on series with no real
regimes, spurious) + calendar-reanchor labels; KEY control = beat a same-information realized-vol
threshold gate (1 parameter). *Prior:* KILL (alpha) / WS (risk overlay on carry). *Status:* refines
NC + TA1. *Refs:* Hamilton 1989, *Econometrica*; Ang & Bekaert 2002, *RFS*; Guidolin & Timmermann
2007, *J. Economic Dynamics & Control*; Rabiner 1989 "A Tutorial on Hidden Markov Models," *Proc.
IEEE*.

**D8-A5 Change-point detection (CUSUM/BOCPD/PELT).** *Belief:* detect structural breaks online and
de-risk/flip. *Mechanism:* real breaks exist, but causal detectors have unavoidable delay — by
confirmation the move is over. *Test:* $0; **strictly online/causal** (BOCPD/sequential CUSUM, not
offline PELT); phase-rand + block (on surrogates with no real breaks the rule should fire at the
false-alarm rate); KEY control = latency-matched baseline (a fixed N-day vol-stop at the same average
delay). *Prior:* KILL (alpha) / WS (tail de-risk). *Status:* NEW (cf A4, NF2). *Refs:* Page 1954
"Continuous Inspection Schemes" (CUSUM), *Biometrika*; Adams & MacKay 2007 "Bayesian Online Changepoint
Detection," arXiv:0710.3742; Killick, Fearnhead & Eckley 2012 "PELT," *JASA*; Aminikhanghahi & Cook
2017 (survey), *Knowledge and Information Systems*.

**D8-A6 Feature-importance signal distillation.** *Belief:* keep top-k features → robust parsimonious
signal. *Mechanism:* importance is in-sample, substitution effects make rankings unstable, top-k on
the test data is a leak. *Test:* $0 (same panel as A1); **cross-sectional shuffle** (important
features must lose importance when the label is permuted) + purged/embargoed MDA; k chosen on an inner
fold only (nested CV); KEY control = beat a random-k signal and the single best feature on the
holdout. *Prior:* KILL as independent edge (methodology tool). *Status:* NEW (layer over A1). *Refs:*
López de Prado 2018 *AFML* Ch.8 (MDI/MDA); Breiman 2001 "Random Forests," *Machine Learning*; Strobl
et al. 2007, *BMC Bioinformatics*; Lundberg et al. 2020, *Nature Machine Intelligence*.

**D8-A7 Ensemble stacking of weak signals.** *Belief:* a meta-learner over weak low-correlation
signals beats any component. *Mechanism:* combining genuinely independent positive-expectancy alphas
raises Sharpe ~√k; folklore = correlated long-beta inputs + meta-fit leak. *Test:* $0 (outputs of
the lab's tested signals — carry survivors + KILLed momentum/reversal as deliberately-weak inputs);
**block-bootstrap of the base-signal return panel** + marginal/panel seed; KEY control = beat naive
inverse-variance and equal-weight (1/k) combination net-of-cost. *Prior:* **UNC — the one Part-A item
with a real prior IF fed the carry survivors** (KILL if all inputs are killed signals). *Status:* NEW
(consumes survivors + T1–T10). *Refs:* Wolpert 1992 "Stacked Generalization," *Neural Networks*;
DeMiguel, Garlappi & Uppal 2009 "Optimal Versus Naive Diversification," *RFS*; Grinold & Kahn 2000
*Active Portfolio Management* (McGraw-Hill); Rapach, Strauss & Zhou 2010, *RFS*.

**D8-B1 Risk parity (inverse-vol / ERC).** *Belief:* equal-risk-contribution beats cap/equal-weight.
*Mechanism:* avoids concentration in high-vol coins (low-vol tilt); but crypto is one-factor → RP
collapses to "underweight volatile alts" + leverage funding cost. *Test:* $0; block-bootstrap cov
window + cross-sectional shuffle; KEY control = residualize vs equal-weight + a low-vol factor;
net-of-rebalancing-cost. *Prior:* KILL (return) / WS (risk). *Status:* NEW (cf C1, B5). *Refs:*
Maillard, Roncalli & Teïletche 2010, *J. Portfolio Management*; Asness, Frazzini & Pedersen 2012
"Leverage Aversion and Risk Parity," *FAJ*; Roncalli 2013 *Introduction to Risk Parity and Budgeting*
(CRC).

**D8-B2 Kelly / fractional-Kelly sizing.** *Belief:* Kelly maximizes long-run growth; fractional
Kelly bounds drawdown. *Mechanism:* growth-optimal given the *true* edge i.i.d.; full Kelly wildly
over-levered under estimation error + fat tails. *Test:* $0 (carry-survivor trade distribution +
synthetic zero-edge book); **block-bootstrap of the trade-return sequence** (Kelly's advantage must
hold across resamples; on the zero-edge book any "outperformance" is pure leverage variance); KEY
control = vs fixed-fractional vol-targeting at matched ex-ante leverage (report growth AND drawdown).
*Prior:* WS (¼–½ Kelly over a confirmed edge) / KILL (full Kelly; any "Kelly creates edge" framing).
*Status:* NEW (sizing over survivors). *Refs:* Kelly 1956 "A New Interpretation of Information Rate,"
*Bell System Technical Journal*; Thorp 2006 "The Kelly Criterion…"; MacLean, Thorp & Ziemba 2010
*The Kelly Capital Growth Investment Criterion* (World Scientific).

**D8-B3 CPPI / portfolio insurance overlay.** *Belief:* cushion×multiplier gives convex drawdown-
bounded participation. *Mechanism:* a trend-following overlay (buys high, sells low) — bleeds via
cash-lock/whipsaw; gap risk in crypto breaches the floor anyway. *Test:* $0 (BTC/ETH daily + intraday
for gaps); **bracket/path-on-surrogate** (run the exact CPPI rule on surrogate paths → null
distribution of breach frequency + cash-lock drag); KEY control = vs static mix at matched exposure
+ vs simple vol-target; control for trend (TA2, killed). *Prior:* KILL (return) / WS (floor with
honest drag). *Status:* NEW (cf NF2, TA2). *Refs:* Black & Jones 1987 "Simplifying Portfolio
Insurance," *J. Portfolio Management*; Perold & Sharpe 1988 "Dynamic Strategies for Asset
Allocation," *FAJ*; Cont & Tankov 2009 "Constant Proportion Portfolio Insurance in the Presence of
Jumps," *Mathematical Finance*.

**D8-B4 Rebalancing premium / volatility harvesting.** *Belief:* fixed-weight rebalancing harvests a
premium ("Shannon's demon"). *Mechanism:* diversification return is real for *low-correlation*
assets; crypto is highly correlated + trending → rebalancing sells the winner that keeps winning →
drag. *Test:* $0; phase-rand/block with **matched (high) crypto correlation** + cross-sectional
shuffle; KEY control = decompose diversification-return vs drift-return (pairwise corr > ~0.7 →
premium structurally near-zero). *Prior:* KILL in crypto (high-value — debunks the marketed
"rebalancing premium" index claim). *Status:* NEW (cf B1, C1). *Refs:* Fernholz & Shay 1982
"Stochastic Portfolio Theory…," *J. Finance*; Booth & Fama 1992 "Diversification Returns and Asset
Contributions," *FAJ*; Willenbrock 2011 "Diversification Return, Portfolio Rebalancing, and the
Commodity Return Puzzle," *FAJ*; Luenberger 1998 *Investment Science* (Oxford).

**D8-B5 Minimum-variance / GMV + shrinkage.** *Belief:* GMV earns the low-vol anomaly without a
return forecast. *Mechanism:* avoids the biggest error source (return forecasts) + low-vol tilt; but
crypto covariance is unstable, GMV concentrates in whatever was recently calm. *Test:* $0 (top-50,
Ledoit-Wolf shrinkage); block-bootstrap window + cross-sectional shuffle; KEY control = residualize
vs equal-weight + low-vol factor; check realized vs predicted variance OOS; long-beta control (GMV in
a one-factor market is beta-reduction). *Prior:* WS (variance) / KILL (return). *Status:* NEW (sibling
B1). *Refs:* Ledoit & Wolf 2004 "Honey, I Shrunk the Sample Covariance Matrix," *J. Portfolio
Management*; Clarke, de Silva & Thorley 2006 "Minimum-Variance Portfolios in the U.S. Equity Market,"
*J. Portfolio Management*; Haugen & Baker 1991, *J. Portfolio Management*; DeMiguel, Garlappi & Uppal
2009, *RFS*.

**D8-B6 Trend-overlay (TSMOM) on a carry book.** *Belief:* carry+trend combine super-additively
(stay in carry when trend agrees, de-risk when it disagrees). *Mechanism:* carry has negative skew
(crash risk); trend has positive skew (long-vol), so a trend overlay can hedge carry unwinds (the
macro/FX carry+trend combination). *Test:* $0 (carry survivors + Binance price for the filter);
**block-bootstrap of the joint (carry, trend) return panel** + calendar-reanchor the trend signal
(confirm the hedge is conditional, not coincident); KEY control = the overlay must improve carry's
**left-tail / crash months specifically** vs simply reducing carry leverage by the same amount.
*Prior:* **UNC — strongest Part-B item** (carry+trend is genuinely evidenced; TA2's KILL of standalone
crypto TSMOM tempers it). *Status:* refines TA2 (overlay on survivors). *Refs:* Moskowitz, Ooi &
Pedersen 2012 "Time Series Momentum," *JFE*; Koijen, Moskowitz, Pedersen & Vrugt 2018 "Carry," *JFE*;
Baltas & Kosowski 2013 (~approx); Hurst, Ooi & Pedersen 2017, *J. Portfolio Management*.

**D8-C1 Cross-venue funding-rate dispersion.** *Belief:* go long the cheap-funding venue / short the
rich, harvest the wedge. *Mechanism:* venue-segmented flows + differing margin/liquidation create
persistent wedges (near market-neutral); folklore = the dispersion reflects real counterparty/
withdrawal risk + dual-venue capital. *Test:* **$0** (Binance+Bybit+OKX funding history);
**cross-sectional shuffle of the venue→funding mapping** (relative-value claim) + block-bootstrap on
the spread; KEY control = net of transfer/withdrawal + dual-venue margin cost + **does dispersion add
anything beyond the funding LEVEL?** *Prior:* **UNC — best-prior Part-C item** (market-neutral, in the
survivor family). *Status:* refines D1-round2 + survivors. *Refs:* Koijen, Moskowitz, Pedersen & Vrugt
2018 "Carry," *JFE*; Brunnermeier, Nagel & Pedersen 2008 "Carry Trades and Currency Crashes," *NBER
Macro Annual*; Makarov & Schoar 2020 "Trading and Arbitrage in Cryptocurrency Markets," *JFE* 135(2).

**D8-C2 Triangular arbitrage (single venue).** *Belief:* A/B×B/C×C/A ≠ 1 → risk-free cycle.
*Mechanism:* transient cross-rate inconsistencies; after 3-leg taker fees + latency virtually all are
non-executable (you race co-located HFT). *Test:* $0 (Binance ticker snapshots) but **latency/depth
realism is the crux**; block snapshot + **latency-injection placebo** (delay execution by realistic
ms); KEY control = full taker fee on all 3 legs + slippage at realized depth + latency. *Prior:* KILL!
(folklore demo; high-value because tutorials sell it). *Status:* NEW (cf TA3). *Refs:* Makarov &
Schoar 2020, *JFE* 135(2); Marshall, Treepongkaruna & Young 2008 (FX triangular arb after costs,
~approx).

**D8-C3 Perp-spot basis (cash-and-carry).** *Belief:* short perp + hold spot to collect funding =
delta-neutral yield. *Mechanism:* genuine crypto carry; funding flips negative in selloffs +
liquidation risk on the short leg → compensation for crash insurance (negative skew), not free.
*Test:* **$0** (funding + spot index); block-bootstrap funding (yield distribution + left tail) +
**bracket-on-surrogate for the liquidation path**; KEY control = **skew/tail accounting** (report
negative-skew + worst funding-flip months; net the cost of the crash insurance you sell). *Prior:* WS
/ likely SURVIVE-with-skew-caveat (the canonical real crypto carry — value = quantifying the
skew-adjusted yield). *Status:* refines survivors / T9. *Refs:* Koijen, Moskowitz, Pedersen & Vrugt
2018, *JFE*; Brunnermeier, Nagel & Pedersen 2008, *NBER Macro Annual*; Alexander & Heck 2020 "Price
discovery in Bitcoin," *J. Financial Stability* (~approx).

**D8-C4 DeFi lending vs perp-funding arb.** *Belief:* borrow cheap on one side to fund the carry on
the rich side. *Mechanism:* DeFi/CeFi rate markets segmented → persistent wedges; but compensation
for smart-contract/oracle/bridge/liquidation risk; gas + bridge + utilization slippage eats it.
*Test:* **$0** (DefiLlama `/yields`+lending, CEX funding); **cross-sectional shuffle** across
protocols + block-bootstrap; KEY control = net of gas+bridge+utilization slippage + a smart-contract/
oracle **risk-cost haircut** (does the wedge persist after charging the risk premium, or IS the
spread that premium?). *Prior:* KILL after honest risk-cost. *Status:* NEW (cf C1/C3, OC1). *Refs:*
Gudgeon, Werner, Perez & Knottenbelt 2020 "DeFi Protocols for Loanable Funds," ACM AFT; Aramonte,
Huang & Schrimpf 2021 "DeFi risks and the decentralisation illusion," *BIS Quarterly Review*; Schär
2021, *Federal Reserve Bank of St. Louis Review*.

**D8-C5 Liquid-staking basis (stETH/rETH).** *Belief:* buy the LST discount, earn yield + convergence
to redemption value. *Mechanism:* post-Shapella stETH is redeemable ~1:1 so discounts mean-revert;
but discounts widen in stress (2022 depeg), redemption queues impose duration risk = a liquidity/
duration risk premium, not arbitrage. *Test:* **$0** (DefiLlama/DEX price, Lido/Rocket Pool APR, queue
length); block-bootstrap basis + **bracket-on-surrogate** (holding-period drawdown); KEY control =
net of redemption-queue duration + stress-widening haircut; **separate yield accrual (a real coupon)
from basis convergence (the risk part)**. *Prior:* WS (yield) / KILL-skew-adjusted (convergence) — a
nuanced partial-survive. *Status:* NEW (cf C3/C4). *Refs:* Gârleanu & Pedersen 2011 "Margin-Based
Asset Pricing and Deviations from the Law of One Price," *RFS*; Duffie 2010 "Asset Price Dynamics
with Slow-Moving Capital," *J. Finance*; Lido/Rocket Pool redemption docs (~$0 canonical).

**D8-C6 Cash-and-carry on dated futures.** *Belief:* short the contango future + hold spot, earn the
annualized basis to expiry (forced convergence). *Mechanism:* dated futures must converge at expiry
→ near-deterministic yield modulo financing/margin; in backwardation it reverses; early-liquidation
risk on the short leg. *Test:* **$0** (OKX/Binance/Bybit dated mark + spot; scaffolded in
`output/dated-futures`); block-bootstrap basis-to-expiry + **bracket-on-surrogate** (early-unwind
tail) + cross-sectional shuffle across expiries; KEY control = net of financing+margin+roll +
**verify distinct from perp-funding (C3)** + charge the early-liquidation tail. *Prior:* WS / likely
partial-SURVIVE (structurally cleanest carry; value = isolating term-structure edge beyond funding
level). *Status:* refines survivors / C3. *Refs:* Hull 2017 *Options, Futures, and Other Derivatives*
10e (cost-of-carry); Koijen, Moskowitz, Pedersen & Vrugt 2018, *JFE*; Szymanowska, de Roon, Nijman &
Van Den Goorbergh 2014 "An Anatomy of Commodity Futures Risk Premia," *J. Finance*; Gorton &
Rouwenhorst 2006 "Facts and Fantasies about Commodity Futures," *FAJ*.

---

## 5. Prioritized — the next 10 to test

Selected for: **most-used by real traders/quants** × **cleanly falsifiable at $0** × **good
public-evidence / shareability** (a KILL or SURVIVE that the world will want to read). Genuinely-
uncertain items that the standard "it's just beta" kill does *not* auto-dispatch are favored,
alongside the highest-value teaching KILLs.

1. **D3-B5 — Variance Risk Premium harvest (DVOL vs RV).** The single highest-value options item:
   a genuinely-real premium, **fully $0 on history** via the free Deribit DVOL index, and the
   options-world counterpart of the surviving funding/basis carry. Honest prior: real but probably
   fails the tail-charged T-bill bar — a citable, nuanced result either way.
2. **D8-C1 — Cross-venue funding-rate dispersion.** Market-neutral by construction, in the survivor
   family, best-prior Part-C item, fully $0. The clean question (does *dispersion* add over funding
   *level* net of dual-venue frictions) is exactly the kind of incremental-edge test the lab should
   run next.
3. **D4-M2 — Residual / idiosyncratic momentum.** Beta-neutral by construction, so the standard
   surrogate kill does NOT auto-dispatch it — the test carries real information. The most promising
   momentum refinement; likely killed by cost, not beta, which is itself the valuable finding.
4. **D4-S6 — PCA basket stat-arb (Avellaneda–Lee s-score).** The other beta-orthogonal-by-
   construction item and the proper professional stat-arb; $0; binding constraint is transaction
   cost on residual reversion, not data-mining. Run it for the cost-vs-edge frontier.
5. **D7.10 — Token unlocks / vesting cliffs.** The strongest event candidate: a real, calendar-
   anticipatable supply-overhang mechanism (Keyrock 16k-event study). Likely SURVIVE-on-paper-but-
   not-net or KILL-on-data-quality — high public value either way; the test also stress-tests the
   new point-in-time gate.
6. **D5-17 — Stock-to-Flow deviation (adversarial).** Near-certain KILL of a famous *debunked*
   model via the spurious-regression null + the post-2021 holdout it already failed. The highest-
   value teaching kill in the whole backlog — confidently asserted, already broken live.
7. **D1-13 — Head-and-Shoulders neckline break.** The most-believed reversal pattern; fully $0;
   the detector-on-surrogate + calendar placebo is the cleanest possible falsification. Highest-
   share public KILL in the price-action domain.
8. **D6-S1 — Crypto Fear & Greed contrarian.** The most-used retail belief; $0 from a free JSON
   feed; the AR-matched-placebo null cleanly shows the index is a price-derived lagging transform.
   Maximally shareable KILL.
9. **D8-A2 — LSTM/TCN/Transformer price-sequence models.** The ubiquitous "Transformer for crypto"
   claim; $0; in-repo neural probes already show `destructive_turnover`, so a phase-randomization-
   surrogate KILL is a strong, honest, public result that closes a loud narrative.
10. **D3-B1 — Dealer GEX / gamma walls / zero-gamma flip.** The most-hyped 2023–2025 retail-quant
    narrative; a clean KILL in crypto (ambiguous dealer sign; collapses into max-pain S/R + regime)
    is maximally shareable. Pairs naturally with the DVOL/VRP work above.

**Honorable mentions** (genuinely-uncertain, run when compute allows): D8-C3 perp-spot basis
(SURVIVE-with-skew-caveat likely), D8-B6 trend-overlay on carry, D2-V3 strictly-lagged CVD,
D2-O1 order-book imbalance (the "real-but-uncapturable" publishable result), D7.9 tax-loss selling.

---

## 6. Methodology upgrades — new gates / nulls the domains flagged

These keep the criteria improving. Each is a concrete gate/null surfaced by ≥1 domain because the
committed stack (built for position-series strategies) is too lenient or wrong-shaped for it.

**A. Surrogate nulls — make them the *right* null for the claim.**

- **Volatility-preserving surrogate (GARCH(1,1)/EGARCH-simulated + IAAFT phase-randomization).**
  Mandatory for the entire ATR/squeeze/Supertrend/Keltner/Bollinger/vol-breakout family (D1-03,
  D1-05, D1-15; D3-A1, A8, A9). Naive phase-randomization or small-block bootstrap *destroys* the
  vol-clustering the indicator keys on → a falsely-easy null where the indicator can't even fire.
  The surrogate must preserve the squeeze-then-expand structure while destroying sign predictability,
  isolating real *directional* edge from real-but-non-tradable *vol-expansion*. (D8 also flags IAAFT
  as not-yet-a-committed-primitive — needed for the sequence-model nulls A2/A5.)
- **Indicator-reconstruction callback in the surrogate harness.** For OBV/VWAP/POC/VPIN/MFI/ADL the
  indicator is a deterministic function of price+volume; the surrogate must *regenerate the indicator
  on the surrogate OHLCV path*, not shuffle the signal series, or the test over-passes (D2 #2).
- **Preserve the mechanical volume–|return| link in volume surrogates.** Reconstruct volume via a
  fitted return→volume map (Karpoff) so volume-confirmation (D2-V6) isn't spuriously informative
  (D2 #3).
- **Cross-sectional-shuffle null** (permute asset→label within each timestamp) is the correct
  surrogate for every relative-value / rotation / dispersion claim (D4 pairs/stat-arb; D8-A1, A6, B4,
  C1, C4; D6-S3 alts). The single most important missing null for Parts A/C of D8 (D8 #2).
- **Bracket / path-on-surrogate** (run the *actual path-dependent logic* on block-bootstrapped /
  phase-randomized paths) for every stopping-time rule: TP/SL (NF2), OU/z-band/s-score exits
  (D4-S1/S6), SAR (D1-02), CPPI (D8-B3), liquidation/cash-lock tails (D2-D1; D8-C3/C5/C6). Bands and
  brackets reshape driftless noise into high-win-rate ~0-expectancy profiles (optional-stopping /
  fair-game) — sample the tail on surrogate paths, don't evaluate on a return series (D8 #3).
- **Calendar-reanchor with an event-count-matched null.** Promote to a first-class surrogate for
  sparse-event claims, preserving event count, inter-event spacing, and regime distribution
  (phase/block surrogates are the wrong shape for events). D7 #2; D5 age-event metrics; D3 expiry/skew
  events.
- **Fibonacci-ratio placebo** (replace {0.382, 0.5, 0.618, 0.786, 1.272, 1.618} with random ratios)
  as a first-class gate to isolate the golden-ratio claim from the level/swing claim (D1-18, D1-19).
- **Detector-on-surrogate + detector-parameter honest-N** for subjective patterns (D1-13/17/19/21):
  swing/ZigZag/trendline tolerances are a search dimension; fold them into N, and auto-flag
  `non_falsifiable` any pattern whose N is effectively unbounded from re-count ambiguity (Elliott
  Wave). D1 #2.
- **Age / cohort-shuffle surrogate** for age-based on-chain metrics (CDD, dormancy, HODL, STH/LTH-
  SOPR, Reserve Risk): reassign destroyed coin-days / cohort labels at random, preserving volume — if
  the age-blind shuffle predicts as well, age carried nothing. Needed to *test* (not just kill) the
  genuinely-orthogonal D5 signals. D5 #4.
- **Regime-shuffle / label-shuffle placebo** for regime-conditioned strategies (D3-A4; D8-A4): if the
  strategy works as well with shuffled regime labels, the regimes aren't informative.
- **AR-matched placebo for exogenous index series** (replace the index with an AR(p) matched to its
  autocorr/variance): the cleanest null for sentiment/news indices (D6-S1/S5/S7) — if the rule scores
  the same on matched noise, the "sentiment content" is provably zero. D6.

**B. Attribution / control gates.**

- **First-class "h=0 leakage" attribution gate.** Flow features (CVD/OFI/footprint/taker-ratio) are
  circular at the same bar — *signed flow at t IS the move at t*. Require a lag-sweep and that the
  strictly-lagged (h≥1) component clear all gates alone. D2 #1.
- **Hard `betaNeutralityGate(returns, factorReturns)`.** Regress on BTC and PC1 before crediting any
  Sharpe for every long/short claim — the one control that separates the genuinely-uncertain neutral-
  by-construction items (D4-M2, S6) from the ~14 that collapse to timed beta. D4 #4.
- **Multi-factor macro-beta neutralization** — upgrade the single buy&hold baseline to orthogonalize
  PnL against {BTC, SPX, DXY, net-liquidity} and score residual alpha/DSR (D6-M1/M2/M4/M6 die here).
  D6 #2.
- **Causality / lead-lag gate** (strictly-lagged-only + Granger / transfer-entropy signal→return vs
  return→signal). Sentiment/macro/flow/adoption signals are coincident-or-lagging; the surrogate
  asks "is there info?" but not "does it lead?" D6 #1; D5 #5 (flows/mints/whales/addresses);
  D7.15/D7.18 (ETF/stablecoin flow reflexivity).
- **Context-conditioning ablation null** {signal-alone vs filter-alone vs conjunction} to
  institutionalize the recurring "is it just long-beta?" kill (D1-14/15/16 candle/pattern-with-trend).
  D1 #4.
- **"Taker-alpha vs maker/execution-edge" classifier** — the NF2 fair-game theorem restated for the
  book: bid-ask bounce / queue / micro-price ARE the spread, capturable only by a maker, so they are
  KILL-for-our-setup, not "no edge." D2 #4.

**C. Honest-N / effective-N gates.**

- **Effective-independent-observations / event-count N.** Count independent *events* not autocorrelated
  *bars*: cycle-scale on-chain (D5-03/09/10/12, ~3–7 extremes), macro cycles (D6-M1/M3, ~2–4), events
  (D7.1 halving n≈3; D7.15/17 n=1). Auto-KILL / auto-flag "unfalsifiable-in-favor" any event/cycle
  hypothesis with effective_n below a floor (~10) *before* spending the rest of the gauntlet. Feed the
  autocorrelation-deflated N into DSR and the Harvey–Liu haircut, and refuse CPCV folds shorter than
  one cycle. D5 #3; D6 #3; D7 #3.
- **Honest-N must count construction / definition freedom**, not just rule parameters: provider/entity-
  list/std-window/age-cut/stablecoin-basket (D5 #2), sector/factor/session-boundary/basket-weight/ID
  definitions (D4 #5), Metcalfe fit-form, dealer-sign / "unusual" / regime-count conventions (D3 #5),
  detection-heuristic thresholds (D2 #5: spoofing/iceberg/divergence at full granularity, label-free →
  return-prediction is the only admissible validation, pre-registration mandatory).
- **Implement the Harvey–Liu haircut.** Named in the pipeline but apparently un-coded; the huge-grid ML
  items (D8-A1/A2/A3/A7) and the multi-pattern libraries (D1-21) especially need it on top of DSR's
  effectiveTrials. D8 #4.

**D. Cost / tail / provenance realism.**

- **Tail-charged (skew-adjusted) promotion hurdle for carry-type premia** (D3-B5/B6/B7/B8; D8-C3/C5/C6):
  cost must include the negatively-skewed max-loss / liquidation / gamma-loss + delta-hedge funding;
  the surrogate must be a jump/tail-matched bootstrap; the comparison vs cash should be CVaR/Calmar-
  adjusted (Pézier–White adjusted-Sharpe or conditional-DSR) — plain Sharpe over-rewards being short a
  crash option. D3 #3; D8 #5.
- **Microstructure cost realism / "is this a taker alpha?"** plus a **latency-injection placebo** for
  arb claims (D8-C2): full taker fee on all legs + slippage at realized depth + realistic round-trip
  latency.
- **Declared risk-cost haircut (bps)** for "arb" claims that are really risk premia (D8-C4/C5):
  smart-contract / bridge / liquidation / peg — "arb survives" only *after* the named risk premium is
  removed. D8 #7.
- **Point-in-time / vintage gate.** The biggest kill-or-fool risk for D7's event half and for D6's
  revised macro/Trends/ETF-flow series: re-run on a calendar deliberately lagged by the realistic
  public-announcement delay; if the edge evaporates it was look-ahead. Enforce an `as_of` ≤ trade-time
  field, and a `forward-recording` provenance flag for options items (D3) and L2 microstructure (D2).
  D7 #1; D6 vintage audit; D3 #4.
- **Causal-fill / no-lookahead-detector reported gate** for re-sampled bars and pattern entries
  (Heikin-Ashi, Renko/range, trendlines): emit the boolean and *publish the non-causal-vs-causal gap*
  as evidence. D1 #5.
- **Growing-holdout protocol for forward-collected-only data** (the L2 microstructure C-section, D2-O1..
  O5; forward-recorded options panels, D3-B1/B3/B4): pre-register on the first block, let the
  consume-once holdout accrue in real time, score once at a pre-committed sample size, and set the DSR
  bar to the genuinely small forward-N. D2 #6.
- **Seed-distribution reporting** for stochastic learners (D8-A2/A3): count seeds as trials, report the
  median across seeds (never the max). D8 #6.
- **`dataFidelity` flag** — refuse a SURVIVE verdict on a degraded free proxy (true UTXO SOPR, LTH/STH
  split, CDD, fine HODL bands) without an explicit "proxy-only, not provider-canonical" caveat. D5 #7.
- **Entity/custody de-confounding** as a first-class step for exchange-reserve / whale-cohort / netflow
  metrics (strip tagged exchange/ETF/custodial clusters before computing the signal). D5 #6.
- **`baseline_strategy` slot** so refinements (D7.19 settlement-timing; D8 overlays) must beat the
  survivor they refine *net of added turnover*, not zero. D7 #4.

> A note on file paths: the task and these backlog docs name `src/lib/validation/strategy-validator.ts
> ::validateStrategy` as the committed gauntlet wrapper. As of writing, the statistical core is
> committed under `src/lib/training/statistical-validation.ts` (and `robust-selection.ts` /
> `negative-space.ts`); `validateStrategy` is the intended single entry point that chains them. Several
> nulls above (IAAFT/phase-randomization, cross-sectional-shuffle, bracket/path-on-surrogate, calendar-
> reanchor, Harvey–Liu haircut) are *named* in the spec but not yet committed primitives — they are the
> concrete build targets this backlog depends on.

---

## 7. Consolidated references / bibliography

Deduplicated across all eight domains, grouped by theme. `~approx` = author/venue/year the
domain author was not fully sure of (verify before citing externally). Practitioner / non-peer-
reviewed sources are marked.

### 7.1 Methodology — multiple testing, deflated Sharpe, surrogates, overfitting

- Bailey, D. & López de Prado, M. (2014). "The Deflated Sharpe Ratio." *J. Portfolio Management* 40(5).
- Bailey, D., Borwein, J., López de Prado, M. & Zhu, Q. (2017). "The Probability of Backtest Overfitting." *J. Computational Finance* 20(4).
- Harvey, C. & Liu, Y. (2015). "Backtesting." *J. Portfolio Management* 42(1).
- Harvey, C., Liu, Y. & Zhu, H. (2016). "…and the Cross-Section of Expected Returns." *Review of Financial Studies* 29(1).
- López de Prado, M. (2018). *Advances in Financial Machine Learning.* Wiley. (purged/CPCV, PBO, MDI/MDA)
- Theiler, J. et al. (1992). "Testing for nonlinearity in time series: the method of surrogate data." *Physica D* 58.
- Bajgrowicz, P. & Scaillet, O. (2012). "Technical trading revisited: False discoveries, persistence tests, and transaction costs." *J. Financial Economics* 106(3).
- Park, C.-H. & Irwin, S. (2007). "What do we know about the profitability of technical analysis?" *J. Economic Surveys* 21(4).
- Granger, C. & Newbold, P. (1974). "Spurious Regressions in Econometrics." *J. Econometrics* 2(2).
- Lo, A. & MacKinlay, A.C. (1988). "Stock market prices do not follow random walks." *Review of Financial Studies* 1(1).

### 7.2 Technical analysis — indicators, patterns, formalization

- Lo, A., Mamaysky, H. & Wang, J. (2000). "Foundations of Technical Analysis." *J. Finance* 55(4). *(anchor for all chart patterns)*
- Jegadeesh, N. (2000). Discussion of Lo-Mamaysky-Wang. *J. Finance.*
- Brock, W., Lakonishok, J. & LeBaron, B. (1992). "Simple Technical Trading Rules and the Stochastic Properties of Stock Returns." *J. Finance* 47(5).
- Wilder, J.W. (1978). *New Concepts in Technical Trading Systems.* Trend Research. (RSI/ADX/ATR/SAR origin)
- Murphy, J. (1999). *Technical Analysis of the Financial Markets.* NYIF.
- Achelis, S. (2000/2001). *Technical Analysis from A to Z.* McGraw-Hill.
- Edwards, R. & Magee, J. (1948+). *Technical Analysis of Stock Trends.*
- Bulkowski, T. (2005). *Encyclopedia of Chart Patterns,* 2e. Wiley.
- Bollinger, J. (2001). *Bollinger on Bollinger Bands.* McGraw-Hill.
- Keltner, C. (1960). *How to Make Money in Commodities.*; Carter, J. (2005). *Mastering the Trade.* McGraw-Hill (TTM Squeeze).
- Lambert, D. (1980). "Commodity Channel Index." *Commodities.*
- Lane, G. (1984). "Lane's Stochastics." *TASC* 2; Chande, T. & Kroll, S. (1994). *The New Technical Trader.* Wiley (StochRSI).
- Williams, L. (1979). *How I Made One Million Dollars…*; (2011). *Long-Term Secrets to Short-Term Trading,* 2e. Wiley (%R).
- Nison, S. (1991). *Japanese Candlestick Charting Techniques.* NYIF; (1994). *Beyond Candlesticks.* Wiley (Renko). Morris, G. (2006). *Candlestick Charting Explained,* 3e.
- Valcu, D. (2004). "Using the Heikin-Ashi Technique." *TASC* 22(2).
- Crabel, T. (1990). *Day Trading with Short Term Price Patterns and Opening Range Breakout.* (NR7)
- Marshall, B., Young, M. & Rose, L. (2006). "Candlestick technical trading strategies: Can they create value for investors?" *J. Banking & Finance* 30(8).
- Lu, T.-H., Shiu, Y.-M. & Liu, T.-C. (2012). "Profitable candlestick trading strategies." *Review of Financial Economics* 21(2).
- Marshall, Cahan & Cahan (2008). "Does intraday technical analysis in the U.S. equity market have value?" *J. Empirical Finance* 15(2).
- Chang, K. & Osler, C. (1999). "Methodical Madness: Technical Analysis and the Irrationality of Exchange-Rate Forecasts." *Economic Journal.*
- Hosoda, G. (1969). *Ichimoku Kinko Hyo* (~approx); Linton, D. (2010). *Cloud Charts.* Updata; Patel, M. (2010). *Trading with Ichimoku Clouds.* Wiley.
- Granville, J. (1963). *Granville's New Key to Stock Market Profits.* (OBV); Botes & Siepman (2010). Vortex, *TASC*; Arms, R. (1989). *The Arms Index (TRIN).*
- Elliott, R. (1938). *The Wave Principle*; Frost & Prechter (1978). *Elliott Wave Principle.* (EW); Gartley, H. (1935). *Profits in the Stock Market*; Carney, S. (2010). *Harmonic Trading.* FT Press; Pesavento, L. (1997). *Fibonacci Ratios with Pattern Recognition.* Traders Press.
- Wyckoff, R. (1931). *The Richard D. Wyckoff Method…*; Pruden, H. (2007). *The Three Skills of Top Trading.* Wiley; Williams, T. (2005). *Master the Markets* (VSA).
- Steidlmayer, P. & Koy, K. (1986). *Markets and Market Logic.*; Dalton, Jones & Dalton (1990/2007). *Mind Over Markets* (Market/Volume Profile).
- Seban, O. (~approx, SuperTrend popularizer); SqueezeMetrics (2017). GEX white paper *(practitioner, no peer review).*

### 7.3 Market microstructure — order flow, liquidity, price impact, VPIN

- Kyle, A. (1985). "Continuous Auctions and Insider Trading." *Econometrica* 53(6).
- Amihud, Y. (2002). "Illiquidity and stock returns." *J. Financial Markets* 5(1).
- Roll, R. (1984). "A Simple Implicit Measure of the Effective Bid-Ask Spread." *J. Finance* 39(4).
- Hasbrouck, J. (1991). "Measuring the Information Content of Stock Trades." *J. Finance* 46(1); (2007). *Empirical Market Microstructure.* Oxford UP; (2009). "Trading Costs and Returns." *J. Finance* 64(3).
- Easley, D. & O'Hara, M. (1987). "Price, Trade Size, and Information." *J. Financial Economics* 19(1); (1992). "Time and the Process of Security Price Adjustment." *J. Finance* 47(2).
- Easley, D., López de Prado, M. & O'Hara, M. (2012). "Flow Toxicity and Liquidity in a High-Frequency World." *RFS* 25(5); (2011). "The Microstructure of the Flash Crash." *J. Portfolio Management* 37(2). (VPIN)
- Andersen, T. & Bondarenko, O. (2014). "VPIN and the Flash Crash." *J. Financial Markets* 17. *(decisive VPIN-is-a-vol-proxy critique)*
- Cont, R., Stoikov, S. & Talreja, R. (2010). "A Stochastic Model for Order Book Dynamics." *Operations Research* 58(3).
- Cont, R., Kukanov, A. & Stoikov, S. (2014). "The Price Impact of Order Book Events." *J. Financial Econometrics* 12(1). (OFI)
- Stoikov, S. (2018). "The micro-price." *Quantitative Finance* 18(12); Avellaneda, M. & Stoikov, S. (2008). "High-frequency trading in a limit order book." *Quantitative Finance* 8(3).
- Cartea, Á., Jaimungal, S. & Penalva, J. (2015). *Algorithmic and High-Frequency Trading.* Cambridge UP; Cartea, Jaimungal & Wang (2020). "Spoofing and Price Manipulation in Order-Driven Markets." *Applied Mathematical Finance* 27(1).
- Lillo, F. & Farmer, J.D. (2004). "The Long Memory of the Efficient Market." *Studies in Nonlinear Dynamics & Econometrics* 8(3); Bouchaud, Gefen, Potters & Wyart (2004). *Quantitative Finance* 4(2); Tóth et al. (2011). *Phys. Rev. X* 1.
- Chordia, T., Roll, R. & Subrahmanyam, A. (2002). "Order imbalance, liquidity, and market returns." *J. Financial Economics* 65(1).
- Karpoff, J. (1987). "The Relation Between Price Changes and Trading Volume." *JFQA* 22(1); Jones, Kaul & Lipson (1994). "Transactions, Volume, and Volatility." *RFS* 7(4).
- Barclay, M. & Warner, J. (1993). "Stealth trading and volatility." *J. Financial Economics* 34(3).
- Brunnermeier, M. & Pedersen, L. (2009). "Market Liquidity and Funding Liquidity." *RFS* 22(6).
- Næs, R. & Skjeltorp, J. (2006). "Order book characteristics and the volume-volatility relation." *J. Financial Markets* 9(3); Cao, Hansch & Wang (2009). *J. Futures Markets* 29(1).
- Lee, Eom & Park (2013). "Microstructure-based manipulation: spoofing." *J. Financial Markets* 16(2); Niederhoffer & Osborne (1966). *JASA* 61.
- Hong, H. & Yogo, M. (2012). "What does futures market interest tell us…?" *J. Financial Economics* 105(3); Bessembinder & Seguin (1993). *JFQA* 28(1).
- Berkowitz, Logue & Noser (1988). "The Total Cost of Transactions on the NYSE." *J. Finance* 43(1); Madhavan (2002). "VWAP Strategies"; Konishi (2002). "Optimal slice of a VWAP trade." *J. Financial Markets* 5(2); Białkowski, Darolles & Le Fol (2008). *J. Banking & Finance* 32(9).

### 7.4 Volatility & options / derivatives

- Engle, R. (1982). "Autoregressive Conditional Heteroskedasticity." *Econometrica* 50(4); Bollerslev, T. (1986). "Generalized ARCH." *J. Econometrics* 31; Nelson, D. (1991). "Conditional Heteroskedasticity in Asset Returns (EGARCH)." *Econometrica* 59; Glosten, Jagannathan & Runkle (1993). GJR. *J. Finance* 48.
- Andersen, Bollerslev, Diebold & Labys (2003). "Modeling and Forecasting Realized Volatility." *Econometrica* 71; Andersen & Bollerslev (1997). "Intraday Periodicity and Volatility Persistence." *J. Empirical Finance.*
- Bollerslev, T., Tauchen, G. & Zhou, H. (2009). "Expected Stock Returns and Variance Risk Premia." *RFS* 22; Carr, P. & Wu, L. (2009). "Variance Risk Premiums." *RFS* 22.
- Bakshi, G. & Kapadia, N. (2003). "Delta-Hedged Gains and the Negative Market Volatility Risk Premium." *RFS* 16; Bakshi, Kapadia & Madan (2003). "Stock Return Characteristics, Skew Laws." *RFS* 16; Britten-Jones & Neuberger (2000). *J. Finance* 55.
- Coval, J. & Shumway, T. (2001). "Expected Option Returns." *J. Finance* 56; Broadie, Chernov & Johannes (2009). "Understanding Index Option Returns." *RFS* 22; Santa-Clara & Saretto (2009). "Option Strategies: Good Deals and Margin Calls." *J. Financial Markets.*
- Israelov, R. & Nielsen, L. (2015). "Covered Calls Uncovered." *Financial Analysts Journal* 71; Whaley, R. (2002). "Return and Risk of CBOE BXM." *J. Derivatives*; Hill et al. (2006). "Finding Alpha via Covered Index Writing." *FAJ.*
- Ni, Pearson & Poteshman (2005). "Stock Price Clustering on Option Expiration Dates." *J. Financial Economics* 78(1); Ni, Pearson, Poteshman & White (2021). "Does Option Trading Have a Pervasive Impact on Underlying Stock Prices?" *RFS* 34; Avellaneda & Lipkin (2003). "A Market-Induced Mechanism for Stock Pinning." *Quantitative Finance* 3.
- Xing, Zhang & Zhao (2010). "Option Volatility Smirk." *JFQA* 45; Bollerslev & Todorov (2011). "Tails, Fears, and Risk Premia." *J. Finance* 66; Kozhan, Neuberger & Schneider (2013). "The Skew Risk Premium." *RFS* 26.
- Pan, J. & Poteshman, A. (2006). "The Information in Option Volume for Future Stock Prices." *RFS* 19; Easley, O'Hara & Srinivas (1998). "Option Volume and Stock Prices." *J. Finance* 53.
- Johnson, T. (2017). "Risk Premia and the VIX Term Structure." *JFQA* 52; Mixon, S. (2007). *J. Empirical Finance*; Eraker & Wu (2017). "Explaining the Negative Returns to VIX Futures and ETNs." *JFE*; Whaley, R. (2009). "Understanding the VIX." *J. Portfolio Management.*
- Bondarenko, O. (2014). "Variance Trading and Market Price of Variance Risk." *J. Econometrics*; Baltussen, Van Bekkum & Van der Grient (2018). "Unknown Unknowns: Vol-of-Vol." *Review of Finance*; Huang, Schlag, Shaliastovich & Thimme (2019). "Volatility-of-Volatility Risk." *JFQA.*
- Black, F. (1976). "Studies of Stock Price Volatility Changes." *Proc. ASA*; Hamilton, J. (1989). "A New Approach to the Economic Analysis of Nonstationary Time Series." *Econometrica* 57; Ang & Timmermann (2012). *Annual Review of Financial Economics*; Guidolin & Timmermann (2007). *J. Economic Dynamics & Control*; Kim & Nelson (1999). *State-Space Models with Regime Switching.* MIT Press.
- Alexander, C. & Imeraj (2021). "The Bitcoin VIX and its variance risk premium." *J. Alternative Investments* (~approx); Alexander et al. (2022–23) crypto DVOL/IV (~approx); Deribit DVOL methodology *(practitioner)*; Barbon & Buraschi (2020). "Gamma Fragility." (SSRN ~approx).

### 7.5 Momentum, carry, factors, mean-reversion / statistical arbitrage

- Moskowitz, T., Ooi, Y. & Pedersen, L. (2012). "Time Series Momentum." *J. Financial Economics* 104(2); Asness, Moskowitz & Pedersen (2013). "Value and Momentum Everywhere." *J. Finance* 68(3); Hurst, Ooi & Pedersen (2017). "A Century of Evidence on Trend-Following." *J. Portfolio Management.*
- Antonacci, G. (2014). *Dual Momentum Investing.* McGraw-Hill; (2017). "Risk Premia Harvesting Through Dual Momentum." *J. Portfolio Management.*
- Blitz, Huij & Martens (2011). "Residual Momentum." *J. Empirical Finance* 18(3); Gutierrez & Prinsky (2007). *J. Financial Markets* 10(1); Grundy & Martin (2001). *RFS* 14(1).
- George, T. & Hwang, C.-Y. (2004). "The 52-Week High and Momentum Investing." *J. Finance* 59(5); Da, Gurun & Warachka (2014). "Frog in the Pan." *RFS* 27(7); Barberis, Shleifer & Vishny (1998). *J. Financial Economics* 49(3).
- Daniel, K. & Moskowitz, T. (2016). "Momentum Crashes." *JFE* 122(2); Barroso, P. & Santa-Clara, P. (2015). "Momentum Has Its Moments." *JFE* 116(1).
- Goyal, A. & Jegadeesh, N. (2018). "Cross-Sectional and Time-Series Tests of Return Predictability." *RFS* 31(5); Ehsani & Linnainmaa (2022). "Factor Momentum and the Momentum Factor." *J. Finance* 77(3); Arnott et al. (2021). "Factor Momentum." *RFS* (~approx); Gupta & Kelly (2019). "Factor Momentum Everywhere." *J. Portfolio Management* 45(3).
- Ardila, Forró & Sornette (2015/16). "The Acceleration Effect and Gamma Factor in Asset Pricing." (SFI/arXiv ~approx).
- Gatev, Goetzmann & Rouwenhorst (2006). "Pairs Trading." *RFS* 19(3); Do & Faff (2010). *FAJ* 66(4); Krauss, C. (2017). "Statistical Arbitrage Pairs Trading Strategies: Review and Outlook." *J. Economic Surveys* 31(2).
- Engle, R. & Granger, C. (1987). "Co-integration and Error Correction." *Econometrica* 55(2); Johansen, S. (1991). *Econometrica* 59(6); Vidyamurthy (2004). *Pairs Trading.* Wiley.
- Avellaneda, M. & Lee, J.-H. (2010). "Statistical Arbitrage in the U.S. Equities Market." *Quantitative Finance* 10(7); Leung & Li (2015). *Int. J. Theoretical & Applied Finance* 18(3); Khandani & Lo (2011). "What Happened to the Quants in August 2007?" *J. Financial Markets.*
- Liew & Wu (2013). "Pairs trading: A copula approach." *J. Derivatives & Hedge Funds* 19(1); Stübinger, Mangold & Krauss (2018). "Statistical arbitrage with vine copulas." *Quantitative Finance* 18(11).
- Kalman, R. (1960). "A New Approach to Linear Filtering and Prediction Problems." *J. Basic Engineering* 82(1); Chan, E. (2013). *Algorithmic Trading.* Wiley; Triantafyllopoulos & Montana (2011). *Computational Management Science* 8 (~approx).
- Lehmann, B. (1990). "Fads, Martingales, and Market Efficiency." *QJE* 105(1); Jegadeesh, N. (1990). "Evidence of Predictable Behavior." *J. Finance* 45(3); Jegadeesh & Titman (1995). *RFS* 8(4); Nagel, S. (2012). "Evaporating Liquidity." *RFS* 25(7).
- Lou, Polk & Skouras (2019). "A Tug of War: Overnight Versus Intraday." *JFE* 134(1); Hendershott, Livdan & Rösch (2020). *JFE* 138(3); Lo, A. & MacKinlay, A.C. (1990). "When Are Contrarian Profits Due to Stock Market Overreaction?" *RFS* 3(2); Hou (2007). *RFS* 20(4); Chordia & Swaminathan (2000). *J. Finance* 55(2); Uhlenbeck & Ornstein (1930). *Physical Review* 36.
- Koijen, Moskowitz, Pedersen & Vrugt (2018). "Carry." *J. Financial Economics* 127(2); Brunnermeier, Nagel & Pedersen (2008). "Carry Trades and Currency Crashes." *NBER Macroeconomics Annual.*

### 7.6 On-chain / crypto-native valuation & flow

- Mahmudov, M. & Puell, D. (2018). "MVRV Z-Score" (~approx); Puell, D. (2019). "The Puell Multiple" (~approx); Mayer, T. "Mayer Multiple."
- Shirakashi, R. (2019). "SOPR" (~approx); Glassnode metric docs (SOPR/aSOPR/LTH-STH/NUPL/RHODL/Reserve-Risk/CDD/Dormancy/SSR).
- Burniske, C. (2017) & Woo, W. "Bitcoin NVT Ratio"; Kalichkin, D. (2018). "Rethinking NVT Ratio" (NVTS); Woo, W. "NVT Golden Cross."
- Edwards, C. / Capriole (2019). "Hash Ribbons"; Unchained Capital (2018). "Bitcoin Data Science: HODL Waves"; Hauge, H. / Glassnode (2019). "Reserve Risk."
- Metcalfe, B. (2013). "Metcalfe's Law after 40 Years." *IEEE Computer* 46(12); Peterson, T. (2018). "Metcalfe's Law as a Model for Bitcoin's Value." *Ledger* 3; Wheatley, S. et al. (2019). "Are Bitcoin bubbles predictable?… generalized Metcalfe's law." *Royal Society Open Science* 6(6).
- PlanB (2019). "Modeling Bitcoin Value with Scarcity" (S2F belief); Coin Metrics — realized cap / Thermocap / valuation primer (~approx).
- Makarov, I. & Schoar, A. (2021). "Blockchain Analysis of the Bitcoin Market." *NBER WP 29396*; (2020). "Trading and Arbitrage in Cryptocurrency Markets." *J. Financial Economics* 135(2).
- Griffin, J. & Shams, A. (2020). "Is Bitcoin Really Untethered?" *J. Finance* 75(4); Cong, Li & Wang (2021). "Tokenomics: Dynamic adoption and valuation." *RFS* 34(3).
- DefiLlama (stablecoins / TVL / yields), Coin Metrics Community (free data sources).

### 7.7 Sentiment / alternative data + cross-asset / macro

- Liu, Y. & Tsyvinski, A. (2021). "Risks and Returns of Cryptocurrency." *RFS* 34(6); Liu, Tsyvinski & Wu (2022). "Common Risk Factors in Cryptocurrency." *J. Finance* 77(2).
- Kristoufek, L. (2013). "BitCoin meets Google Trends and Wikipedia." *Scientific Reports* 3; Da, Engelberg & Gao (2011). "In Search of Attention." *J. Finance* 66(5).
- Tetlock, P. (2007). "Giving Content to Investor Sentiment." *J. Finance* 62(3); Leetaru & Schrodt (2013). "GDELT." *ISA Annual Convention*; Rognone, Hyde & Zhang (2020). "News sentiment in the cryptocurrency market." *International Review of Financial Analysis* 69.
- Baker, M. & Wurgler, J. (2006). "Investor Sentiment and the Cross-Section of Stock Returns." *J. Finance* 61; Kumar & Lee (2006). *J. Finance* 61(5); Barber & Odean (2000). *J. Finance* 55(2); Mai et al. (2018). *J. Management Information Systems* 35(1); Garcia & Schweitzer (2015). *Royal Society Open Science* 2(9); Baur & Dimpfl (2018). *Economics Letters* 173.
- Corbet, Lucey, Urquhart & Yarovaya (2019). "Cryptocurrencies as a financial asset." *IRFA* 62; Conlon, Corbet & McGee (2021). *RIBAF* 54; Baur, Hong & Lee (2018). *J. International Financial Markets, Institutions & Money* 54; Smales (2019). "Bitcoin as a safe haven." *Finance Research Letters* 30.
- Gilchrist, S. & Zakrajšek, E. (2012). "Credit Spreads and Business Cycle Fluctuations." *American Economic Review* 102(4); Howell, M. (2020). *Capital Wars.* Palgrave; Alden, L. (2023). "Bitcoin: A Global Liquidity Barometer" *(practitioner)*; Karau (2023). "Monetary policy and Bitcoin." *J. International Money and Finance.*
- Ben-David, Franzoni & Moussawi (2018). "Do ETFs Increase Volatility?" *J. Finance* 73(6); Brown, Davies & Ringgenberg (2021). "ETF arbitrage, non-fundamental demand, and return predictability." *Review of Finance* 25(4); Madhavan, A. (2016). *Exchange-Traded Funds and the New Dynamics of Investing.* Oxford.
- Iyer, T. (2022). "Cryptic Connections." *IMF Global Financial Stability Note* 2022/01; Engle, R. (2002). "Dynamic Conditional Correlation." *J. Business & Economic Statistics* 20(3); BIS Working Paper 1087 (2023). "Crypto Carry."

### 7.8 Calendar / seasonality + event-driven flows

- Bouman, S. & Jacobsen, B. (2002). "The Halloween Indicator, 'Sell in May and Go Away'." *American Economic Review* 92(5); Zhang & Jacobsen (2021). *J. International Money and Finance.*
- Caporale, G. & Plastun, A. (2019). "The day of the week effect in the cryptocurrency market." *Finance Research Letters* 31; Aharon & Qadan (2019). *FRL* 31; Baur, Cahill, Godfrey & Liu (2019). "Bitcoin time-of-day, day-of-week and month-of-year effects." *FRL* 31; Eross et al. (2019). *RIBAF* 49; Admati & Pfleiderer (1988). "A theory of intraday patterns." *RFS* 1(1).
- Ariel, R. (1987). "A monthly effect in stock returns." *J. Financial Economics* 18(1); Lakonishok & Smidt (1988). *RFS* 1(4); McConnell & Xu (2008). *FAJ* 64(2).
- Shleifer, A. (1986). "Do demand curves for stocks slope down?" *J. Finance* 41(3); Harris & Gurel (1986). *J. Finance* 41(4); Petajisto, A. (2011). "The index premium…" *J. Empirical Finance* 18(2); (2017). "Inefficiencies in the Pricing of ETFs." *FAJ* 73(1).
- Roll, R. (1983). "Vas ist das? The turn-of-the-year effect." *J. Portfolio Management* 9(2); Grinblatt & Moskowitz (2004). *JFE* 71(3); Cong, Landsman, Maydew & Rabetti (2023). "Tax-loss harvesting with cryptocurrencies." *J. Accounting and Economics* 76(2-3).
- Lucca, D. & Moench, E. (2015). "The pre-FOMC announcement drift." *J. Finance* 70(1); Savor & Wilson (2013). *JFQA* 48(2); Corbet, Larkin, Lucey, Meegan & Yarovaya (2020). "Cryptocurrency reaction to FOMC announcements." *RIBAF* 51.
- Meynkhard (2019). *Investment Management and Financial Innovations* 16(4); Akyildirim et al. (2024). *J. Risk and Financial Management* 17(6); Keyrock (2024). "Token Unlocks: Quantifying the Sell Pressure" *(industry)*; Zhou et al. (2023). "SoK: DeFi attacks." *IEEE S&P*; Gandal, Hamrick, Moore & Oberman (2018). "Price manipulation in the Bitcoin ecosystem." *J. Monetary Economics* 95.
- Howell, Niessner & Yermack (2020). "Initial coin offerings." *RFS* 33(9); Fritsch, Müller & Wattenhofer (2022). "Analyzing voting power in decentralized governance" (arXiv); Easley, O'Hara & Basu (2019). "From mining to markets." *JFE* 134(1); Lyons & Viswanath-Natraj (2023). "What keeps stablecoins stable?" *J. International Money and Finance* 131; Ante, Fiedler & Strehle (2021). *Technological Forecasting and Social Change* 170.

### 7.9 ML / quant methods + portfolio construction

- Gu, S., Kelly, B. & Xiu, D. (2020). "Empirical Asset Pricing via Machine Learning." *Review of Financial Studies* 33(5).
- Chen, T. & Guestrin, C. (2016). "XGBoost." KDD; Ke, G. et al. (2017). "LightGBM." NeurIPS; Breiman, L. (2001). "Random Forests." *Machine Learning*; Strobl et al. (2007). *BMC Bioinformatics*; Lundberg & Lee (2017). "SHAP." NeurIPS; Lundberg et al. (2020). *Nature Machine Intelligence.*
- Hochreiter, S. & Schmidhuber, J. (1997). "Long Short-Term Memory." *Neural Computation*; Bai, Kolter & Koltun (2018). "TCN." arXiv:1803.01271; Vaswani et al. (2017). "Attention Is All You Need." NeurIPS; Zeng et al. (2023). "Are Transformers Effective for Time Series Forecasting?" AAAI.
- Schulman et al. (2017). "PPO." arXiv:1707.06347; Mnih et al. (2015). "DQN." *Nature*; Nevmyvaka, Feng & Kearns (2006). "Reinforcement Learning for Optimized Trade Execution." ICML; Henderson et al. (2018). "Deep Reinforcement Learning that Matters." AAAI; Moody & Saffell (2001). "Learning to Trade via Direct Reinforcement." *IEEE Trans. Neural Networks.*
- Page, E. (1954). "Continuous Inspection Schemes." *Biometrika*; Adams & MacKay (2007). "Bayesian Online Changepoint Detection." arXiv:0710.3742; Killick, Fearnhead & Eckley (2012). "PELT." *JASA*; Rabiner (1989). "A Tutorial on Hidden Markov Models." *Proc. IEEE.*
- Wolpert, D. (1992). "Stacked Generalization." *Neural Networks*; Rapach, Strauss & Zhou (2010). "Out-of-Sample Equity Premium Prediction: Combination Forecasts." *RFS*; Grinold & Kahn (2000). *Active Portfolio Management,* 2e. McGraw-Hill.
- Maillard, Roncalli & Teïletche (2010). "The Properties of Equally-Weighted Risk Contribution Portfolios." *J. Portfolio Management* 36(4); Asness, Frazzini & Pedersen (2012). "Leverage Aversion and Risk Parity." *FAJ*; Roncalli (2013). *Introduction to Risk Parity and Budgeting.* CRC.
- DeMiguel, Garlappi & Uppal (2009). "Optimal Versus Naive Diversification." *RFS*; Ledoit & Wolf (2004). "Honey, I Shrunk the Sample Covariance Matrix." *J. Portfolio Management*; Clarke, de Silva & Thorley (2006). "Minimum-Variance Portfolios." *J. Portfolio Management*; Haugen & Baker (1991). *J. Portfolio Management.*
- Kelly, J. (1956). "A New Interpretation of Information Rate." *Bell System Technical Journal*; Thorp, E. (2006). "The Kelly Criterion…"; MacLean, Thorp & Ziemba (2010). *The Kelly Capital Growth Investment Criterion.* World Scientific.
- Black & Jones (1987). "Simplifying Portfolio Insurance." *J. Portfolio Management*; Perold & Sharpe (1988). "Dynamic Strategies for Asset Allocation." *FAJ*; Cont & Tankov (2009). "CPPI in the Presence of Jumps." *Mathematical Finance.*
- Fernholz & Shay (1982). "Stochastic Portfolio Theory and Stock Market Equilibrium." *J. Finance*; Booth & Fama (1992). "Diversification Returns and Asset Contributions." *FAJ*; Willenbrock (2011). "Diversification Return, Portfolio Rebalancing, and the Commodity Return Puzzle." *FAJ*; Luenberger (1998). *Investment Science.* Oxford.
- Moreira, A. & Muir, T. (2017). "Volatility-Managed Portfolios." *J. Finance* 72(4); Cederburg, O'Doherty, Wang & Yan (2020). *JFE* 138; Harvey et al. (2018). "The Impact of Volatility Targeting." *J. Portfolio Management* 45(1).
- Hull, J. (2017). *Options, Futures, and Other Derivatives,* 10e. Pearson; Szymanowska, de Roon, Nijman & Van Den Goorbergh (2014). "An Anatomy of Commodity Futures Risk Premia." *J. Finance*; Gorton & Rouwenhorst (2006). "Facts and Fantasies about Commodity Futures." *FAJ.*
- Gudgeon, Werner, Perez & Knottenbelt (2020). "DeFi Protocols for Loanable Funds." ACM AFT; Aramonte, Huang & Schrimpf (2021). "DeFi risks and the decentralisation illusion." *BIS Quarterly Review*; Schär (2021). *Federal Reserve Bank of St. Louis Review*; Gârleanu & Pedersen (2011). "Margin-Based Asset Pricing and Deviations from the Law of One Price." *RFS*; Duffie (2010). "Asset Price Dynamics with Slow-Moving Capital." *J. Finance.*

---

## 8. Provenance

Compiled 2026-06-01 from the eight per-domain research files in `output/backlog/` (D1–D8, 155
hypotheses total: 21+22+20+18+20+14+21+19). Each domain file retains the full long-form entry and
its references; this document is the deduplicated, prioritized, methodology-aligned master view.
KILL is a valid — and usually the highest-value — outcome. Every hypothesis here is a falsifiable
bet routed through the same gauntlet and the same criteria as the 35 already done.
