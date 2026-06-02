# References — Annotated Bibliography

> **Purpose.** This is the consolidated, standalone bibliography for the entire
> edge-search program — a $0, reproducible, honest crypto trading-strategy *falsification lab*.
> Every gate in the anti-overfitting gauntlet and every one of the **~111 tested hypotheses**
> traces to a peer-reviewed paper or a public working paper. The page has two mapped sections:
> **(A) Gates & Methodology → paper** and **(B) Hypotheses → paper**. Each entry is one line —
> authors, year, title, venue, and a **resolving DOI / canonical URL** — with a `→ used for / tests`
> note that points back to the exact gate, script, or hypothesis family in this project.
>
> The verdict log behind these notes lives in
> [`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md) (the cross-domain roll-up of the
> 2026-06 campaign), in the per-domain syntheses under `output/edgehunt-*/SUMMARY.md`, and in the
> deduplicated 155-item bibliography in [`BACKLOG.md`](BACKLOG.md) §7.
>
> **Links web-verified 2026-06-01.** Every DOI / canonical URL below was confirmed to resolve on
> 2026-06-01 (a prior pass verified citation forms 2026-05-28). Any citation whose author/venue/DOI
> could **not** be fully verified is flagged inline with **`[UNVERIFIED]`**. One prior-version
> attribution error is corrected and flagged below (BIS WP 1087, "Crypto carry").
>
> License of this documentation set: **MIT (see [`../LICENSE`](../LICENSE)).**

---

## How to read the mapping

The project's claim is **methodological, not predictive**: a committed validation gauntlet, run at
$0 on free public data, pushed **~111 hypotheses across eight domains** (≈35 prior rounds + 58 in the
2026-06 parallelized domain campaign + 18 from the new $0 backlog) through the same anti-overfitting
protocol. **Final audited state: 0 clean SURVIVE; 2 weak PROMISING; everything else KILL.** The
bibliography below is the audit trail for that claim. Two conventions:

- **Section A** maps each gate of the gauntlet to the paper that defines the statistic or control it
  implements. The committed gate primitives live in
  [`src/lib/training/statistical-validation.ts`](../src/lib/training/statistical-validation.ts)
  (`computeDeflatedSharpeRatio`, `estimateCscvPbo`, `blockBootstrapConfidenceInterval`,
  `summarizeReturnSeries`) and are chained by per-domain `runGauntlet` wrappers, e.g.
  [`scripts/edgehunt-D5/harness.ts`](../scripts/edgehunt-D5/harness.ts). *(A single-entry
  `validateStrategy()` wrapper is exposed by the published lean repo on the `oss-release` branch; it
  is not present on this working branch, where the per-domain `runGauntlet` wrappers are the entry
  point.)*
- **Section B** maps each tested hypothesis (the academic prior it operationalizes) to the paper that
  proposed it, and records how it died — or, for the two carries, why it is only a sub-risk-free
  regime trade.

> **Honest framing.** This is a *negative-results + rigorous-methodology* contribution. **Nothing is
> deployable.** The two weak PROMISING leads are held back from SURVIVE by the *same* boundary: a
> right-null surrogate **pass proves the structure/sign is non-random — it does not prove the realized
> mean is positive-with-significance at honest N on unseen data.** No lead crossed that gap. The two
> historical "carry survivors" (perpetual-funding carry, dated-futures basis) are real but sub-risk-free
> regime trades, and a systemic financing-leak correction (zero borrow charged on levered/short
> notional) halved their headline economics. The durable deliverable is the **methodology + the body of
> negative evidence.** See [`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md).

---

## The audited final state (one paragraph)

~111 hypotheses, all at $0 on free public data, all through the committed gauntlet:
**0 clean SURVIVE; 2 weak PROMISING** —
**(1)** XS Donchian channel-position long-short (beta-neutral; cross-sectional-shuffle null p=0.009;
but the 388-row consume-once holdout magnitude is ~0 — DSR@N=1 0.79, Newey-West t 0.96 — and financing
on the ~1.0× short notional erodes OOS to a range ~0.3–0.5);
**(2)** dated-futures basis carry, **unlevered-thin only** (~4.9%/yr, t=2.41, sub-every-multiple-testing
bar; the levered headline was a financing-leak artifact).
A two-layer independent audit flipped **three** earlier PROMISINGs to KILL — BTC exchange
reserve-depletion (netflow), Q9 cross-sectional low-volatility anomaly, and O3 fee-revenue NVT — all on
the **same defect**: a single-best-config surrogate `p` masking a *searched* grid (the correct null is
the **family-wise MAX-statistic**), plus honest-N Deflated Sharpe failure at the full grid. The audit
also confirmed a **systemic financing leak** that had inflated the carries. Everything else is a
documented KILL. (`output/edgehunt-audit/SUMMARY.md`, `output/edgehunt-audit-nb/SUMMARY.md`,
`output/edgehunt-deepen/SUMMARY.md`.)

---

## (A) Gates & Methodology → paper

The committed gauntlet in **binding order**:
`net_of_cost → baselines (buy&hold + matched-exposure + random-lottery + linear-1-layer) →
deflated_sharpe @ honest N → block_bootstrap CI → cpcv_pbo → haircut → surrogate (right null;
family-wise MAX-stat for searched grids) → consume-once holdout`. The binding gate is the first
failure. SURVIVE = all pass; PROMISING = passes net+baselines+surrogate+holdout but trips a
multiple-testing/DSR gate; else KILL.

### Multiple-testing / Sharpe deflation

- **Bailey & López de Prado (2014), "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-Normality", *Journal of Portfolio Management* 40(5):94–107.** → [doi:10.3905/jpm.2014.40.5.094](https://doi.org/10.3905/jpm.2014.40.5.094). Deflate an observed Sharpe by the *true* number of trials `N`, the non-normal moments (skew/kurtosis), and the sample length. **Used for** `computeDeflatedSharpeRatio` (gate `deflated_sharpe`); it is the binding gate on **both** surviving PROMISING leads and on the three audit-flipped KILLs (reserve, Q9 DSR 0.476 @ N=96, O3 DSR 0.894 @ N=312) once honest N counts the searched grid.
- **Bailey, Borwein, López de Prado & Zhu (2014), "Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance", *Notices of the AMS* 61(5):458–471.** → [doi:10.1090/noti1105](https://doi.org/10.1090/noti1105). The **False Strategy Theorem** and the **Minimum Backtest Length (MinBTL)** bound: `E[max Sharpe]` of `N` true-zero strategies grows with `N`. **Used for** the expected-max-Sharpe and MinBTL checks; underpins the family-wise MAX-statistic surrogate that flipped reserve/Q9/O3.
- **Bailey & López de Prado (2012), "The Sharpe Ratio Efficient Frontier" (Probabilistic Sharpe Ratio), *Journal of Risk* 15(2):3–44.** → [SSRN 1821643](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1821643). The Probabilistic Sharpe Ratio: the probability the true Sharpe exceeds a benchmark, given track-record length and non-normality. **Used for** `computeProbabilisticSharpeRatio` (the un-deflated companion to DSR).
- **Bailey, Borwein, López de Prado & Zhu (2017), "The Probability of Backtest Overfitting", *Journal of Computational Finance* 20(4):39–69.** → [doi:10.21314/JCF.2016.322](https://doi.org/10.21314/JCF.2016.322). PBO via **CSCV** (combinatorially-symmetric cross-validation). **Used for** `estimateCscvPbo` (gate `cpcv_pbo`), which flags `foldCount < 8` as degenerate.
- **López de Prado (2018), *Advances in Financial Machine Learning*, Wiley (ch. 7, 8, 11, 12).** → [Wiley, ISBN 978-1119482086](https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086). Purged/embargoed CPCV, multiple out-of-sample paths, the False-Strategy-Theorem exposition, and the consume-once holdout discipline. **Used for** the CPCV/holdout discipline (gates `cpcv_pbo`, `holdout`); the consume-once holdout is where every prediction edge died.
- **Harvey & Liu (2015), "Backtesting", *Journal of Portfolio Management* 42(1):13–28.** → [doi:10.3905/jpm.2015.42.1.013](https://doi.org/10.3905/jpm.2015.42.1.013). The multiple-testing **haircut Sharpe**: the Sharpe penalty for `N` trials is *non-linear* (the "cut 50%" rule is wrong; marginal Sharpes are penalized toward ≈0). **Used for** the haircut gate (`haircut`), with Bonferroni / Holm / BHY p-value adjustment; this is often the *true* binding gate (e.g. the 52-week-high KILL binds on the haircut → 0, not on DSR).
- **Harvey, Liu & Zhu (2016), "…and the Cross-Section of Expected Returns", *Review of Financial Studies* 29(1):5–68.** → [doi:10.1093/rfs/hhv059](https://doi.org/10.1093/rfs/hhv059). With hundreds of tested factors, a `|t| > 3.0` (not 2.0) bar is needed; motivates honest-N deflation everywhere. **Used for** the trial-count / haircut rationale and the `|t|>3` reading of the carries.
- **Harvey & Liu (2020), "False (and Missed) Discoveries in Financial Economics", *Journal of Finance* 75(5):2503–2553.** → [doi:10.1111/jofi.12951](https://doi.org/10.1111/jofi.12951). FDR/FWER control for whole strategy panels. **Used for** the panel haircut logic (Holm / BHY).

### Reality-check / superior-predictive-ability family

- **White (2000), "A Reality Check for Data Snooping", *Econometrica* 68(5):1097–1126.** → [doi:10.1111/1468-0262.00152](https://doi.org/10.1111/1468-0262.00152). The bootstrap Reality Check for the best of many strategies. **Used for** the data-snooping baseline (superseded operationally by Hansen's SPA).
- **Hansen (2005), "A Test for Superior Predictive Ability", *Journal of Business & Economic Statistics* 23(4):365–380.** → [doi:10.1198/073500105000000063](https://doi.org/10.1198/073500105000000063). The studentized, recentered (SPAc) improvement on White's Reality Check. **Used for** the superior-predictive-ability framing of "best of many configs".
- **Romano & Wolf (2005), "Stepwise Multiple Testing as Formalized Data Snooping", *Econometrica* 73(4):1237–1282.** → [doi:10.1111/j.1468-0262.2005.00615.x](https://doi.org/10.1111/j.1468-0262.2005.00615.x). Stepwise FWER control that identifies *which* strategies are genuinely superior. **Used for** the stepwise reasoning behind the family-wise MAX-statistic surrogate.

### Surrogate / placebo controls (the methodological hero — and the audit's pivot)

- **Theiler, Eubank, Longtin, Galdrikian & Farmer (1992), "Testing for nonlinearity in time series: the method of surrogate data", *Physica D* 58(1–4):77–94.** → [doi:10.1016/0167-2789(92)90102-S](https://doi.org/10.1016/0167-2789(92)90102-S). Phase-randomized surrogates: FFT the series, randomize the phases (preserving the amplitude spectrum ⇒ identical autocorrelation/variance), inverse-FFT; this preserves the linear structure a momentum/regime fitter feeds on but destroys the nonlinear/regime structure. **Used for** the phase-randomization null (gate `surrogate`) for *time-series timing* claims. **Key 2026-06 lesson:** running the phase-randomization surrogate on only the *single in-sample-selected grid-best* config (no family-wise correction) is the defect that produced three false PROMISINGs — the correct null for a *searched* family is the **family-wise MAX-statistic** over the actually-searched grid (reserve harness p=0.013 single-config → family-wise p≈0.24 → KILL; Q9 p=0.002 → ~0.06; O3 p=0.005 → 0.093).
- **Politis & Romano (1994), "The Stationary Bootstrap", *Journal of the American Statistical Association* 89(428):1303–1313.** → [doi:10.1080/01621459.1994.10476870](https://doi.org/10.1080/01621459.1994.10476870). Block/stationary bootstrap that resamples contiguous blocks, preserving short-range dependence while destroying long-range regime structure. **Used for** `blockBootstrapConfidenceInterval` (the block-bootstrap CI gate); the CI-lower-bound test sank the Donchian holdout magnitude (CI-lower < 0).

### Economic baselines (gate `baselines`)

- **Chen & Navet (2007), "Failure of genetic-programming-induced trading strategies: distinguishing genuine edge from random search", working note (EvoStar / lecture series).** → [author landing page](https://www.iis.sinica.edu.tw/~chchen/) **`[UNVERIFIED — informal working note; no DOI / stable canonical URL located]`**. Without a random / zero-intelligence pre-test, GP/GA "success" is probably luck. **Used for** the random-lottery / "same-machinery 95th-percentile" baseline (gate `baselines`); this is what killed the GA-rule champions.
- **Zeng, Chen, Zhang & Xu (2023), "Are Transformers Effective for Time Series Forecasting?" (DLinear), *AAAI* 37(9):11121–11128.** → [doi:10.1609/aaai.v37i9.26317](https://doi.org/10.1609/aaai.v37i9.26317). A single linear layer (DLinear) matches or beats sophisticated forecasters in most settings. **Used for** the one-layer-linear baseline (gate `baselines`); a candidate must beat it net of cost.

### Cost / financing (the systemic-leak correction)

- **Frazzini, Israel & Moskowitz (2018), "Trading Costs", working paper / AQR.** → [SSRN 3229719](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3229719) **`[UNVERIFIED venue — circulated working paper / AQR white paper; no journal DOI]`**. Realistic, size-aware live trading costs. **Used for** the net-of-cost charge (taker ~4 bps/side on every position change) and the discipline that **financing/borrow must be charged on the FULL levered/short notional, not 1 unit** — the omission the 2026-06 audit found systemic (it collapsed dated-futures Sharpe 1.64→0.69, DSR 0.58→0.13, and eroded Donchian's OOS holdout 0.53→~0).

---

## (B) Hypotheses → paper

Each tested hypothesis operationalizes an academic prior. The note records how the gauntlet killed it
(or, for the two carries, why it is only a thin regime trade). Verdicts trace to `output/edgehunt-*/`
and [`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md).

### Time-series & cross-sectional momentum / reversal

- **Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", *Journal of Financial Economics* 104(2):228–250.** → [doi:10.1016/j.jfineco.2011.11.003](https://doi.org/10.1016/j.jfineco.2011.11.003). Time-series momentum (TSMOM) across asset classes. **Tests** the trend/TSMOM family (all KILL net of crypto cost; the canonical 12-month lookback is the *worst* in crypto; the apparent trend return is long-beta to the bull, not timing skill — Supertrend/CCI surrogates score *above* the live overlay).
- **Jegadeesh & Titman (1993), "Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency", *Journal of Finance* 48(1):65–91.** → [doi:10.1111/j.1540-6261.1993.tb04702.x](https://doi.org/10.1111/j.1540-6261.1993.tb04702.x). Cross-sectional momentum. **Tests** the XS-momentum family (KILL: holdout net negative / loses to random-lottery); also the diagnosis that "rotation edges" are short-horizon single-asset momentum in disguise.
- **De Bondt & Thaler (1985), "Does the Stock Market Overreact?", *Journal of Finance* 40(3):793–805.** → [doi:10.1111/j.1540-6261.1985.tb05004.x](https://doi.org/10.1111/j.1540-6261.1985.tb05004.x). Cross-sectional reversal / overreaction. **Tests** the reversal / Bollinger-%b-reversion family (KILL: these majors trend daily, not revert — wrong-signed in every calendar year).
- **Blitz, Huij & Martens (2011), "Residual Momentum", *Journal of Empirical Finance* 18(3):506–521.** → [doi:10.1016/j.jempfin.2011.01.003](https://doi.org/10.1016/j.jempfin.2011.01.003). Rank on *residual* (idiosyncratic, factor-stripped) returns rather than total returns. **Tests** the residual / idiosyncratic-momentum lead (signal is **real** — beta-neutral, surrogate p=0.0033 — but **KILL** at Deflated Sharpe @ N=192 (0.18); the binding constraint is the 30-coin cross-section, not the surrogate — it needs a 60–100+ name universe). *[2026-06 campaign — D348.]*
- **Da, Gurun & Warachka (2014), "Frog in the Pan: Continuous Information and Momentum", *Review of Financial Studies* 27(7):2171–2218.** → [doi:10.1093/rfs/hhu003](https://doi.org/10.1093/rfs/hhu003). Information discreteness: gradual ("continuous") information induces stronger, non-reversing momentum than discrete jumps (the "frog in the pan"). **Tests** the frog-in-the-pan / information-discreteness overlay (**KILL** — zero incremental over plain momentum; the apparent edge is *more* timed BTC beta, β=1.26, that reverses OOS). *[2026-06 campaign — D348.]*
- **Moreira & Muir (2017), "Volatility-Managed Portfolios", *Journal of Finance* 72(4):1611–1644.** → [doi:10.1111/jofi.12513](https://doi.org/10.1111/jofi.12513). Scale exposure inversely to recent realized variance. **Tests** the vol-target / vol-managed family (**KILL**: lift flips negative OOS −0.17; fails the GARCH-simulated zero-edge surrogate p=0.386; PBO=0.95 — confirms the Cederburg-et-al. OOS-fragility critique).
- **Fieberg, Liedtke, Poddig, Walker & Zaremba (2025), "A Trend Factor for the Cross Section of Cryptocurrency Returns" (CTREND), *Journal of Financial and Quantitative Analysis* 60(7).** → [doi:10.1017/S0022109024000747](https://doi.org/10.1017/S0022109024000747). A machine-learning crypto trend factor that survives costs in large/liquid coins. **Tests** the BTC / diversified-trend hypotheses (KILL: in this universe the apparent trend return is long-beta to the bull, not timing skill).

### Low-volatility / idiosyncratic-vol anomaly (Q9 — audit-flipped)

- **Ang, Hodrick, Xing & Zhang (2006), "The Cross-Section of Volatility and Expected Returns", *Journal of Finance* 61(1):259–299.** → [doi:10.1111/j.1540-6261.2006.00836.x](https://doi.org/10.1111/j.1540-6261.2006.00836.x). High idiosyncratic-volatility stocks earn abnormally *low* returns (the idiosyncratic-vol puzzle). **Tests** the **Q9 cross-sectional low-volatility anomaly** (beta-neutral L/S; β-neutralization doubles Sharpe to 0.78; XS-shuffle p=0.002; consume-once holdout +2.08). *Provisional PROMISING → **KILL** under the family-wise audit:* single-best-config surrogate masking a searched grid (coherent family-wise p≈0.06, seed-sensitive) **and** honest-N DSR 0.476 @ N=96 with Harvey-Liu adjP 0.673; survivorship-biased panel. *[2026-06 — `output/edgehunt-quant/`, `output/edgehunt-audit-nb/SUMMARY.md`.]*
- **Frazzini & Pedersen (2014), "Betting Against Beta", *Journal of Financial Economics* 111(1):1–25.** → [doi:10.1016/j.jfineco.2013.10.005](https://doi.org/10.1016/j.jfineco.2013.10.005). Leverage-constrained investors bid up high-beta assets; a betting-against-beta (BAB) factor (long levered low-beta, short high-beta) earns positive risk-adjusted returns. **Tests** the low-vol / BAB interpretation of Q9 (the leverage-aversion mechanism behind the low-volatility tilt) — same KILL profile.

### Pairs / relative-value / statistical arbitrage / cointegration

- **Gatev, Goetzmann & Rouwenhorst (2006), "Pairs Trading: Performance of a Relative-Value Arbitrage Rule", *Review of Financial Studies* 19(3):797–827.** → [doi:10.1093/rfs/hhj020](https://doi.org/10.1093/rfs/hhj020). Distance / relative-value pairs trading. **Tests** the cointegration/pairs family (KILL: path-fragile; gross +52.8% but DSR(N=420)=0.029 and MinBTL fails; **random pairing reproduces it, p=0.50** — the "pairs edge" is a selection artifact).
- **Engle & Granger (1987), "Co-integration and Error Correction: Representation, Estimation, and Testing", *Econometrica* 55(2):251–276.** → [doi:10.2307/1913236](https://doi.org/10.2307/1913236). The cointegration / error-correction test underlying the spread-stationarity signal. **Tests** the cointegration construction feeding the pairs trade.
- **Avellaneda & Lee (2010), "Statistical Arbitrage in the U.S. Equities Market", *Quantitative Finance* 10(7):761–782.** → [doi:10.1080/14697680903124632](https://doi.org/10.1080/14697680903124632). PCA-residual mean-reversion with an **s-score** entry/exit on factor residuals. **Tests** the **PCA basket stat-arb (s-score)** hypothesis (**KILL**: at proper breadth the *gross* residual-reversion Sharpe is *negative*, max −0.146 / 81 configs — daily-frequency crypto residuals do not revert; the equity-style reversion lives intraday where costs dominate). *[2026-06 campaign — consensus batch.]*

### Technical analysis (classic & microstructure)

- **Lo, Mamaysky & Wang (2000), "Foundations of Technical Analysis: Computational Algorithms, Statistical Inference, and Empirical Implementation", *Journal of Finance* 55(4):1705–1765.** → [doi:10.1111/0022-1082.00265](https://doi.org/10.1111/0022-1082.00265). Formal, kernel-smoothed evaluation of classic TA patterns. **Tests** the classic-indicator universe (RSI/MACD/BB/MA/ADX/Donchian/Stoch/candlesticks — **0/94 beat buy-and-hold**; best flips to holdout net negative).
- **Sullivan, Timmermann & White (1999), "Data-Snooping, Technical Trading Rule Performance, and the Bootstrap", *Journal of Finance* 54(5):1647–1691.** → [doi:10.1111/0022-1082.00163](https://doi.org/10.1111/0022-1082.00163). Entire universes of TA rules vanish under data-snooping-robust (Reality Check) testing. **Tests** the honest-N + surrogate framing that makes the apparent best rule disappear across the classic and microstructure TA grids.
- **Bouchaud, Bonart, Donier & Gould (2018), *Trades, Quotes and Prices: Financial Markets Under the Microscope*, Cambridge University Press.** → [doi:10.1017/9781316659335](https://doi.org/10.1017/9781316659335). Market-microstructure / forced-flow mechanics and the cost of trading them. **Tests** the forced-flow / microstructure-overlay family (realistic cost kills all 15m/30m variants; the survivor dies on honest-N DSR and holdout).

### Microstructure / order-flow (D2 — the h=0 vs h≥1 blade)

> The whole free-tier order-flow belief set is **dead at h≥1**: any Sharpe lives in the **h=0
> contemporaneous / look-ahead** bar (the trades *are* the move). The L2 family (VPIN, Kyle's λ,
> microprice, book imbalance) is **DEFERRED**, not killed — it needs paid point-in-time order-book
> history — but each *free proxy* the belief was meant to capture is dead.

- **Kyle (1985), "Continuous Auctions and Insider Trading", *Econometrica* 53(6):1315–1335.** → [doi:10.2307/1913210](https://doi.org/10.2307/1913210). The price-impact coefficient **λ** (lambda): informed order flow moves price linearly. **Tests** the price-impact / order-flow-imbalance hypotheses; motivates the h=0-vs-h≥1 leakage gate (the λ relationship is contemporaneous — the strictly-lagged leg is ~0). *[D2 — DEFERRED at L2; the free proxy is KILL.]*
- **Hasbrouck (1991), "Measuring the Information Content of Stock Trades", *Journal of Finance* 46(1):179–207.** → [doi:10.1111/j.1540-6261.1991.tb03749.x](https://doi.org/10.1111/j.1540-6261.1991.tb03749.x). A VAR of trades and quote revisions measures a trade's permanent (information) price impact. **Tests** the trade-informativeness / CVD-divergence / taker-ratio hypotheses (lagged IC ≈ 0; the edge is the contemporaneous "trades are the move" tautology).
- **Hasbrouck (1995), "One Security, Many Markets: Determining the Contributions to Price Discovery", *Journal of Finance* 50(4):1175–1199.** → [doi:10.1111/j.1540-6261.1995.tb04054.x](https://doi.org/10.1111/j.1540-6261.1995.tb04054.x). **Information shares**: the proportional contribution of each venue's innovations to the common efficient price. **Tests** the cross-venue price-discovery / lead-lag flow hypotheses (cross-venue dispersion arb is a mirage at taker cost — fires 0–2× in 3 years).
- **Easley, López de Prado & O'Hara (2012), "Flow Toxicity and Liquidity in a High-Frequency World", *Review of Financial Studies* 25(5):1457–1493.** → [doi:10.1093/rfs/hhr144](https://doi.org/10.1093/rfs/hhr144). **VPIN** — volume-synchronized probability of informed trading — a volume-time order-flow-toxicity metric. **Tests** the VPIN / flow-toxicity timing hypothesis (**DEFERRED** — needs paid point-in-time order-book data; and note the Andersen–Bondarenko critique that VPIN is largely a volatility proxy). *[D2.]*

### Limits to arbitrage / carry (the two historical "survivors", now thin regime trades)

- **Schmeling, Schrimpf & Todorov (2023), "Crypto carry", BIS Working Paper No. 1087.** → [bis.org/publ/work1087](https://www.bis.org/publ/work1087.htm). The perp-funding and dated-basis premium is a limits-to-arbitrage compensation (trend-chasing leveraged demand meets scarce arbitrage capital), not a return forecast. **Tests** the perp-funding carry and dated-futures basis cash-and-carry — the two historical SURVIVORS. **Both pass the full-sample gates but are sub-risk-free regime trades; the dated-futures *levered* headline was a financing-leak artifact** (correcting the borrow charge collapses Sharpe 1.64→0.69, DSR 0.58→0.13; only a **thin unlevered ~4.9%/yr excess survives**, t=2.41, sub-every-multiple-testing bar). **`[CORRECTED]` Authorship:** prior versions of this bibliography (and `BACKLOG.md` §7.5) attributed BIS WP 1087 to "Aramonte, Huang & Schrimpf" — that is **wrong**. BIS WP 1087 "Crypto carry" (4 Apr 2023, rev. Oct 2025) is by **Maik Schmeling, Andreas Schrimpf & Karamfil Todorov** (web-verified 2026-06-01). *(Aramonte, Huang & Schrimpf is a separate 2021 BIS Quarterly Review piece, "DeFi risks and the decentralisation illusion".)*
- **Shleifer & Vishny (1997), "The Limits of Arbitrage", *Journal of Finance* 52(1):35–55.** → [doi:10.1111/j.1540-6261.1997.tb03807.x](https://doi.org/10.1111/j.1540-6261.1997.tb03807.x). Why structural premia persist and who is forced to trade. **Tests** the carry interpretation and the structural / event-flow forward guidance.
- **Makarov & Schoar (2020), "Trading and Arbitrage in Cryptocurrency Markets", *Journal of Financial Economics* 135(2):293–319.** → [doi:10.1016/j.jfineco.2019.07.001](https://doi.org/10.1016/j.jfineco.2019.07.001). Cross-venue price/funding dispersion in crypto and its frictions. **Tests** cross-venue funding-dispersion arb (Binance↔Bybit funding correlated 0.66–0.87; wedge ~0.5 bps/8h is ~30× smaller than its 16 bps round-trip cost — KILL).

### Anomaly decay (why the survivors are "known and priced")

- **McLean & Pontiff (2016), "Does Academic Research Destroy Stock Return Predictability?", *Journal of Finance* 71(1):5–32.** → [doi:10.1111/jofi.12365](https://doi.org/10.1111/jofi.12365). Published anomalies decay out of sample (≈26% lower OOS, ≈58% lower post-publication). **Tests** the decay framing of the carries and the crowded-cross-sectional-momentum decay of the Donchian lead (full-history net ~1.4 → consume-once holdout 0.30–0.79).

### Rotation / lead-lag null (cross-sectional shuffle — the right null for relative value)

- **Lo & MacKinlay (1990), "When Are Contrarian Profits Due to Stock Market Overreaction?", *Review of Financial Studies* 3(2):175–205.** → [doi:10.1093/rfs/3.2.175](https://doi.org/10.1093/rfs/3.2.175). Lead-lag cross-autocorrelation among assets. **Tests** the rotation hypotheses; motivates the `crossSectionalShuffle` null that *must* destroy genuine lead-lag — and does reproduce the "lead-lag" statistic (p_LL = 1.000), proving it is an artifact. **This is the right null behind the XS Donchian PROMISING (shuffle p=0.009) and the audit-flipped Q9.**
- **Hou (2007), "Industry Information Diffusion and the Lead-Lag Effect in Stock Returns", *Review of Financial Studies* 20(4):1113–1138.** → [doi:10.1093/rfs/hhm003](https://doi.org/10.1093/rfs/hhm003). Information diffusion drives lead-lag, so rotation tests must control for it. **Tests** the breadth / rotation hypotheses (the residual timing edge is aggregate vol-state, not cross-asset breadth).
- **Moskowitz & Grinblatt (1999), "Do Industries Explain Momentum?", *Journal of Finance* 54(4):1249–1290.** → [doi:10.1111/0022-1082.00146](https://doi.org/10.1111/0022-1082.00146). Apparent cross-sectional momentum can be a grouping/rotation artifact. **Tests** why rotation edges are checked against the marginal-preserving cross-sectional shuffle (the dominance-cycle KILL: the "rotation edge" is single-asset momentum in disguise).

### Event studies (listing / event flow)

- **MacKinlay (1997), "Event Studies in Economics and Finance", *Journal of Economic Literature* 35(1):13–39.** → [JSTOR 2729691](https://www.jstor.org/stable/2729691). The canonical cumulative-abnormal-return (CAR) event-study methodology. **Tests** the listing-event study (CAR −5.3% through day 20 is descriptively real).
- **Brown & Warner (1985), "Using Daily Stock Returns: The Case of Event Studies", *Journal of Financial Economics* 14(1):3–31.** → [doi:10.1016/0304-405X(85)90042-X](https://doi.org/10.1016/0304-405X(85)90042-X). Daily-return event-study test statistics and their pitfalls (clustering, non-normality). **Tests** the day-by-day significance testing of the listing "dump".
- **Ritter (1991), "The Long-Run Performance of Initial Public Offerings", *Journal of Finance* 46(1):3–27.** → [doi:10.1111/j.1540-6261.1991.tb03743.x](https://doi.org/10.1111/j.1540-6261.1991.tb03743.x). Long-horizon post-event drift and survivorship/cohort traps. **Tests** the consume-once holdout design (the 2025–26 listing cohort *pumped* instead of dumping, flipping the short to −100% compound — a regime/cohort reversal, exactly the Ritter caution).

### Calendar / seasonality (D7 — calendar-reanchor + family-wise null)

- **Bouman & Jacobsen (2002), "The Halloween Indicator, 'Sell in May and Go Away': Another Puzzle", *American Economic Review* 92(5):1618–1635.** → [doi:10.1257/000282802762024683](https://doi.org/10.1257/000282802762024683). The Sell-in-May / Halloween seasonal. **Tests** the month-seasonality and turn-of-month hypotheses (**KILL**, calendar-reanchor p=1.000; turn-of-month holdout sign-flips −0.93 — equity-flow effects crypto structurally lacks).
- **Caporale & Plastun (2019), "The day of the week effect in the cryptocurrency market", *Finance Research Letters* 31.** → [doi:10.1016/j.frl.2018.11.012](https://doi.org/10.1016/j.frl.2018.11.012). Day-of-week effects in crypto. **Tests** the day-of-week hypothesis (**KILL**: ~0 drift-removed; tail-driven by shared crash Wednesdays).

### On-chain valuation / flow (D5 / on-chain backlog — three audit-flipped or debunked)

> The NVT / MVRV / SOPR / Stock-to-Flow on-chain-valuation family is widely published as crypto
> "fundamental" valuation/flow signals and is correspondingly heavily arbitraged, so the honest prior
> is null. Look-ahead is controlled with a ≥1-day feature lag against revision flags, and native-unit
> flow avoids the USD-denomination tautology.

- **PlanB (2019), "Modeling Bitcoin's Value with Scarcity" (Stock-to-Flow), practitioner article (Medium).** → [medium.com/@100trillionUSD](https://medium.com/@100trillionUSD/modeling-bitcoins-value-with-scarcity-91fa0fc03e25) **`[practitioner, non-peer-reviewed]`**. The scarcity (stock-to-flow) price model. **Tests** the Stock-to-Flow hypothesis — **KILL, and statistically debunked**: the S2F residual is a *price clock* (corr 0.78 with price-vs-time, 0.75 with 365d momentum) → spurious regression; causal IC decays to 0.012 post-2021. **Critiques web-verified 2026-06-01:** the model is a misspecified tautology ("market value = stock × price" regressed on "stock / flow", i.e. stock as a function of stock) and its central forecast failed (no $100k by end-2021); see the Bitcoin Magazine ["Why The Bitcoin Stock-to-Flow Model Is Not Useful"](https://bitcoinmagazine.com/markets/why-bitcoin-stock-to-flow-is-not-useful) and the Mises Institute ["A Critique of the Bitcoin Stock-to-Flow Model"](https://mises.org/mises-wire/critique-bitcoin-stock-flow-model).
- **Granger & Newbold (1974), "Spurious Regressions in Econometrics", *Journal of Econometrics* 2(2):111–120.** → [doi:10.1016/0304-4076(74)90034-7](https://doi.org/10.1016/0304-4076(74)90034-7). Regressing one trending series on another yields spuriously significant fits. **Used for** the S2F / MVRV / "price-clock" KILLs — the formal basis for rejecting any "fundamental" on-chain regression whose residual is just a time/price trend.
- **The NVT / MVRV / SOPR practitioner family** (network-value-to-transactions, market-value-to-realized-value, realized cap, SOPR, exchange in/out flow) — see [`BACKLOG.md`](BACKLOG.md) §7.6 for the practitioner provenance (Woo, Kalichkin, Mahmudov & Puell, Shirakashi, Glassnode docs) **`[practitioner metrics; mixed/no peer review]`**. **Tests** the on-chain distribution-pressure / NVT overlays:
  - **O3 — fee-revenue NVT (BTC)** (causal contrarian, net Sharpe 1.33, phase-rand p=0.005, holdout +0.59). *Provisional PROMISING → **KILL** under the family-wise audit:* single-config surrogate masking a searched grid (family-wise p=0.093 @ N=312, real-best 1.332 < surr95-max 1.384) **and** honest-N DSR 0.894 @ N=312 (the N=54 pass was a post-hoc carve-out); no ETH confirmation; a *free proxy* for the paid canonical `NVTAdj90` (DEFERRED). *[`output/edgehunt-onchain2/`, `output/edgehunt-audit-nb/SUMMARY.md`.]*
  - **BTC exchange reserve-depletion / netflow** (the closest to a survivor: pre-registered config forward Sharpe 1.265, price-orthogonal). *PROMISING → **KILL** under the family-wise audit:* the "pre-registered" config was the **argmax of a searched ~12-config neighborhood**, so honest N≠1; under the family-wise MAX-statistic surrogate the gate **fails** (p≈0.24, real 0.994 < surr95 ≈1.19; the harness 0.013 was single-config, no FWER); it also inverts on ETH (forward −0.85). *[`output/edgehunt-D5/`, `output/edgehunt-D5-followup/`, `output/edgehunt-audit/SUMMARY.md`.]*
- **Metcalfe (2013), "Metcalfe's Law after 40 Years of Ethernet", *IEEE Computer* 46(12):26–31.** → [doi:10.1109/MC.2013.374](https://doi.org/10.1109/MC.2013.374). Network value scales with the square of active users. **Tests** the Metcalfe active-address residual (**KILL**: mean-reverting noise; 0/162 configs cleared surrogate AND held OOS).

### Regime detection / change-point (quant backlog — KILL)

- **Hamilton (1989), "A New Approach to the Economic Analysis of Nonstationary Time Series and the Business Cycle", *Econometrica* 57(2):357–384.** → [doi:10.2307/1912559](https://doi.org/10.2307/1912559). The Markov regime-switching (hidden-Markov) model: AR parameters are governed by a latent discrete state. **Tests** the **HMM / regime-switching timer** (KILL: de-risking masquerading as timing — exposed by the matched-exposure control — plus detection latency; no separable premium over the already-killed parent). *[`output/edgehunt-quant/`.]*
- **Adams & MacKay (2007), "Bayesian Online Changepoint Detection", arXiv:0710.3742.** → [arXiv:0710.3742](https://arxiv.org/abs/0710.3742). Online (causal) exact inference of the most recent change-point via a run-length message-passing recursion. **Tests** the **BOCPD regime timer** (KILL: same de-risking-not-timing mechanism, with change-point detection latency adding lag). *[`output/edgehunt-quant/`.]*

### Variance risk premium (consensus / options — KILL after deepening)

- **Carr & Wu (2009), "Variance Risk Premiums", *Review of Financial Studies* 22(3):1311–1341.** → [doi:10.1093/rfs/hhn038](https://doi.org/10.1093/rfs/hhn038). The variance risk premium: implied variance exceeds realized variance on average (sellers of variance are paid). **Tests** the **VRP harvest + crash-gate** lead (BTC IV²−RV² ≈ +0.065, positive 76% of weeks). *Provisional PROMISING → **KILL** (downgraded):* it is a 2021 DVOL-onset regime artifact (leave-2021-out Sharpe 1.257→0.560; post-2021 DSR@N=1 only 0.842) and fails the shuffled-VRP placebo (p=0.14) at the achievable N. *[2026-06 campaign — `output/edgehunt-deepen/SUMMARY.md`.]*

---

## Notes on citation accuracy (web-verified 2026-06-01)

- **`[CORRECTED]` BIS WP 1087 "Crypto carry"** is by **Schmeling, Schrimpf & Todorov (2023)** — *not* "Aramonte, Huang & Schrimpf" as stated in the prior published version and in `BACKLOG.md` §7.5. Verified at [bis.org/publ/work1087](https://www.bis.org/publ/work1087.htm). (Aramonte, Huang & Schrimpf 2021, "DeFi risks and the decentralisation illusion", *BIS Quarterly Review*, is a different, real paper.)
- **Blitz, Huij & Martens (2011)** "Residual Momentum" is *Journal of Empirical Finance* **18(3):506–521** (verified [doi:10.1016/j.jempfin.2011.01.003](https://doi.org/10.1016/j.jempfin.2011.01.003)) — earlier drafts cited "18(3)" without page range.
- **Easley, López de Prado & O'Hara (2012)** VPIN paper is *RFS* **25(5):1457–1493**, [doi:10.1093/rfs/hhr144](https://doi.org/10.1093/rfs/hhr144).
- **Fieberg et al.** "CTREND" is the **2025** published *JFQA* **60(7)** article, [doi:10.1017/S0022109024000747](https://doi.org/10.1017/S0022109024000747) (not the earlier "2024 working paper" form).
- **Flagged `[UNVERIFIED]`** (no resolving DOI / stable canonical URL located): **Chen & Navet (2007)** (informal EvoStar/lecture working note) and the **Frazzini, Israel & Moskowitz "Trading Costs"** working paper (circulated / AQR white paper, no journal DOI). These back baseline/cost discipline, not a headline verdict.
- **Practitioner / non-peer-reviewed** (marked inline): **PlanB Stock-to-Flow** (2019, Medium) and the **NVT/MVRV/SOPR** practitioner metric family. The S2F *critiques* cited (Bitcoin Magazine, Mises) are likewise non-academic commentary; the formal rejection rests on **Granger & Newbold (1974)**.
- The full, deduplicated per-domain bibliography (155 hypotheses across 8 domains, with `~approx`
  flags on citations the domain author was unsure of) is [`BACKLOG.md`](BACKLOG.md) §7.

---

## See also (project documentation set)

- [`EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](EDGE_SEARCH_DOMAIN_CAMPAIGN.md) — the 2026-06 cross-domain roll-up: ~58 campaign hypotheses + the deepening + the two-layer audit; the corrected tally **0 SURVIVE, 2 PROMISING, the rest KILL**; the four-leads detail and the per-domain KILL ledger.
- [`BACKLOG.md`](BACKLOG.md) — the research backlog (155 testable hypotheses across 8 domains) with the right surrogate null, honest-N concern, the key long-beta-separating control, and references per item (§4 dense entries, §7 deduplicated bibliography).
- `output/edgehunt-*/SUMMARY.md` — per-domain syntheses with every number; `output/edgehunt-audit/SUMMARY.md` + `output/edgehunt-audit-nb/SUMMARY.md` + `output/edgehunt-deepen/SUMMARY.md` — the deepening and two-layer audit.
- [`src/lib/training/statistical-validation.ts`](../src/lib/training/statistical-validation.ts) — the committed gate primitives; chained by per-domain `runGauntlet` wrappers, e.g. [`scripts/edgehunt-D5/harness.ts`](../scripts/edgehunt-D5/harness.ts). *(The single-entry `validateStrategy()` wrapper is on the `oss-release` branch, not this one.)*

---

*This is a falsification lab: KILL is a valid — and usually the highest-value — outcome. The durable
deliverable is the methodology and the body of negative evidence; no capital is deployed.*

*License of this documentation set: MIT (see [`../LICENSE`](../LICENSE)).*
