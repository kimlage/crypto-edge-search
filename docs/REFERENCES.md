# References — Annotated Bibliography

> **Purpose.** This is the consolidated, standalone bibliography for the entire
> edge-search program. Every gate in the anti-overfitting harness and every one of the
> **28 tested hypotheses** traces to a peer-reviewed paper or a public working paper.
> The page has two mapped sections: **(A) Gates & Methodology → paper** and
> **(B) Hypotheses → paper**. Each entry is one line — authors, year, title, venue — with
> a `→ used for / tests` note that points back to the exact gate, script, or hypothesis ID
> in this project.
>
> This expands and replaces the "References / Bibliography" section that lived inside
> [`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md); read that file for the tally and
> the verdicts, and [`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md) for the gate order.
> Citation venues here are the verified forms used in
> [`references/REFERENCIAS_CRITICAS_EDGE_ROBUSTO_2026-05-28.md`](references/REFERENCIAS_CRITICAS_EDGE_ROBUSTO_2026-05-28.md)
> (web-verified 2026-05-28). License of this documentation set: **MIT (see [`../LICENSE`](../LICENSE)).**

---

## How to read the mapping

The project's claim is methodological, not predictive: a committed validation gauntlet
killed 26 of 28 hypotheses net of realistic cost, leaving only two structural-carry
"survivors" that are real but **sub-risk-free in the current regime**. The bibliography
below is the audit trail for that claim. Two conventions:

- **Section A** maps each gate of the gauntlet to the paper that defines the statistic or
  control it implements. The gates live in `src/lib/training/` and are composed by
  `src/lib/validation/strategy-validator.ts` (`validateStrategy`).
- **Section B** maps each tested hypothesis (the academic prior it operationalizes) to the
  paper that proposed it, and records how it died (or, for carry, why it is only a regime
  trade). Hypothesis IDs (E1–E3, T1–T10, TA1–TA4, WF-A–D, R2/R3/R4, C1–C4, OC1) match the
  tally in [`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md) §1 and the round-5/round-6
  plus 28th-test entries in `EVOLUTION_TRAINING_LOG.md` (internal lab log — not included in this public release).

> **Honest framing.** This is a *negative-results + rigorous-methodology* contribution.
> The "survivors" (perp funding carry, dated-futures basis) passed the full-sample gates
> but have decayed below the risk-free rate; carry is **not** a profitable business today,
> it is a regime trade. See [`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md) §3.

---

## (A) Gates & Methodology → paper

These are the papers behind the validation gauntlet (the project's durable asset). The
gate `id` in parentheses is the one reported by `validateStrategy(...)`.

### Multiple-testing / Sharpe deflation

- **Bailey & López de Prado (2014), "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-Normality", *Journal of Portfolio Management* 40(5):94–107.** → defines the Deflated Sharpe Ratio: deflate an observed Sharpe by the *true* number of trials `N`, the non-normal moments (skew/kurtosis), and the sample length. **Used for** `computeDeflatedSharpeRatio` (gate `deflated_sharpe`); the honest-`N` deflation that turned TA3 (`N=224 → p=0.21`), T10 (`N=420 → DSR 0.029`), R2-illiquid (`N=1640`), R3-GA-rules (`N=5613 → DSR ≈ 9e-12`) and R4-GA-structural (`N=2823 → DSR p ≈ 1.0`) champions into noise.
- **Bailey, Borwein, López de Prado & Zhu (2014), "Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance", *Notices of the AMS* 61(5):458–471.** → the **False Strategy Theorem** and the **Minimum Backtest Length (MinBTL)** bound: `E[max Sharpe]` of `N` true-zero strategies grows with `N`. **Used for** `expectedMaxStandardNormal` and the MinBTL check (true-`N` / `evaluateMinBtl`); the MinBTL failure is part of the T10 cointegration-pairs KILL.
- **Bailey & López de Prado (2012), "The Sharpe Ratio Efficient Frontier" (Probabilistic Sharpe Ratio), *Journal of Risk* 15(2):3–44.** → the Probabilistic Sharpe Ratio: the probability the true Sharpe exceeds a benchmark, accounting for track-record length and non-normality. **Used for** `computeProbabilisticSharpeRatio` (the un-deflated companion to DSR).
- **Bailey, Borwein, López de Prado & Zhu (2017), "The Probability of Backtest Overfitting", *Journal of Computational Finance* 20(4):39–69.** → PBO via **CSCV** (combinatorially-symmetric cross-validation): estimates the probability the in-sample best underperforms the median out-of-sample. **Used for** `estimateCscvPbo` (gate `cpcv_pbo`), which flags `foldCount < 8` as degenerate; PBO `96.4%` was the severe-overfit flag on C1-rotation and `0.90` on C3-breadth.
- **López de Prado (2018), *Advances in Financial Machine Learning*, Wiley (ch. 7, 8, 11, 12).** → purged/embargoed CPCV, multiple out-of-sample paths, the "False Strategy Theorem" exposition, and the consume-once holdout discipline. **Used for** `cpcv-paths.ts` and `holdout.ts` (gates `cpcv_pbo`, `holdout`); the consume-once vault is where 21/21 prediction edges died.
- **Harvey & Liu (2015), "Backtesting", *Journal of Portfolio Management* 42(1):13–28.** → the multiple-testing **haircut Sharpe**: the Sharpe penalty for `N` trials is *non-linear* (the "cut 50%" rule is wrong; marginal Sharpes are penalized to ≈0). **Used for** `haircutSharpe` / `haircutSharpePanel` (gate `haircut`), with Bonferroni / Holm / BHY p-value adjustment.
- **Harvey, Liu & Zhu (2016), "…and the Cross-Section of Expected Returns", *Review of Financial Studies* 29(1):5–68.** → with hundreds of tested factors, a `|t| > 3.0` (not 2.0) bar is needed; motivates honest-`N` deflation everywhere. **Used for** the trial-count / haircut rationale (`significance/trial-count.ts`).
- **Harvey & Liu (2020), "False (and Missed) Discoveries in Financial Economics", *Journal of Finance* 75(5):2503–2553.** → FDR/FWER control for whole strategy panels. **Used for** `haircutSharpePanel` (Holm / BHY) and the panel logic in `spa.ts`.

### Reality-check / superior-predictive-ability family (`spa.ts`)

- **White (2000), "A Reality Check for Data Snooping", *Econometrica* 68(5):1097–1126.** → the bootstrap Reality Check for the best of many strategies. **Used for** the baseline of `spa.ts` (superseded operationally by Hansen's SPA below).
- **Hansen (2005), "A Test for Superior Predictive Ability", *Journal of Business & Economic Statistics* 23(4):365–380.** → the studentized, recentered (SPAc) improvement on White's Reality Check (more powerful, robust to poor alternatives). **Used for** `superiorPredictiveAbility` in `spa.ts`.
- **Romano & Wolf (2005), "Stepwise Multiple Testing as Formalized Data Snooping", *Econometrica* 73(4):1237–1282.** → stepwise FWER control that identifies *which* strategies are genuinely superior, not just whether any is. **Used for** `romanoWolf` in `spa.ts`.

### Surrogate / placebo controls (gate `surrogate` — the methodological hero)

- **Theiler, Eubank, Longtin, Galdrikian & Farmer (1992), "Testing for nonlinearity in time series: the method of surrogate data", *Physica D* 58(1–4):77–94.** → phase-randomized surrogates: FFT the series, randomize the phases (keeping the amplitude spectrum ⇒ identical autocorrelation and variance), inverse-FFT; this preserves the linear structure a momentum/regime fitter feeds on but destroys nonlinear/regime structure. **Used for** `phaseRandomize` (gate `surrogate`); the decisive control in WF-B, WF-C, R2-illiquid (`placeboP=0.90`), R3-GA (`placeboP=1.000`) and C2 (`placeboP=1.000`).
- **Politis & Romano (1994), "The Stationary Bootstrap", *Journal of the American Statistical Association* 89(428):1303–1313.** → block/stationary bootstrap that resamples contiguous blocks, preserving short-range dependence while destroying long-range regime structure. **Used for** `blockBootstrap`, `blockBootstrapConfidenceInterval`, and the SPA block bootstrap (gate `surrogate`); block-bootstrap reproduced 72% of the C4-listing "edge".

### Economic baselines (gate `baselines`)

- **Chen & Navet (2007), "Failure of genetic-programming-induced trading strategies: distinguishing genuine edge from random search", working note (EvoStar / lecture series).** → without a random / zero-intelligence pre-test, GP/GA "success" is probably luck. **Used for** `buildRandomLotteryBaseline` and the "random-RULE 95th percentile, same machinery" baseline (gate `baselines`); this is exactly what killed R3-GA-rules (the GA found *better* champions out-of-sample in pure phase-randomized / block-bootstrap noise than on real data).
- **Zeng, Chen, Zhang & Xu (2023), "Are Transformers Effective for Time Series Forecasting?" (DLinear), *AAAI* 37(9):11121–11128.** → a single linear layer (DLinear) matches or beats sophisticated forecasters in most settings. **Used for** the one-layer-linear baseline (gate `baselines`); the candidate must beat it net of cost (TA4, C3-breadth and the GA structural rule all lost to or merely tied a trivial linear/RF baseline).

---

## (B) Hypotheses → paper

Each tested hypothesis operationalizes an academic prior. The note records the hypothesis
ID(s) and how the gauntlet killed it (or, for carry, why it is only a regime trade). All
verdicts trace to `output/**` JSON and to [`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md) §1.

### Time-series & cross-sectional momentum / reversal

- **Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", *Journal of Financial Economics* 104(2):228–250.** → time-series momentum (TSMOM) across asset classes. **Tests** E3, T4, T5, TA2, WF-A/WF-C (all KILL net of crypto cost; the canonical 12-month lookback is the *worst* in crypto — TA2 vault Sharpe −0.076).
- **Jegadeesh & Titman (1993), "Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency", *Journal of Finance* 48(1):65–91.** → cross-sectional momentum. **Tests** E1, T2 (KILL: holdout net negative / loses to random-lottery); also the diagnosis that the C2 "rotation edge" is really short-horizon single-asset momentum, not tier rotation.
- **De Bondt & Thaler (1985), "Does the Stock Market Overreact?", *Journal of Finance* 40(3):793–805.** → cross-sectional reversal / overreaction. **Tests** T1 (KILL: holdout −32%).
- **Moreira & Muir (2017), "Volatility-Managed Portfolios", *Journal of Finance* 72(4):1611–1644.** → scale exposure inversely to recent realized variance. **Tests** T3, T4, T5 (vol-target overlay; KILL: holdout net negative).
- **Fieberg, Liedtke, Poddig, Walker & Zaremba (2025), "A Trend Factor for the Cross Section of Cryptocurrency Returns" (CTREND), *Journal of Financial and Quantitative Analysis* (DOI 10.1017/S0022109024000747).** → a machine-learning crypto trend factor that survives costs in large/liquid coins. **Tests** the BTC / diversified trend hypotheses E3, T4 (KILL: in this universe the apparent trend return is long-beta to the bull, not timing skill).

### Pairs / relative-value / cointegration

- **Gatev, Goetzmann & Rouwenhorst (2006), "Pairs Trading: Performance of a Relative-Value Arbitrage Rule", *Review of Financial Studies* 19(3):797–827.** → distance / cointegration pairs trading. **Tests** T9, T10 (KILL: path-fragile; gross +52.8% but `DSR(N=420)=0.029` and MinBTL fails).
- **Engle & Granger (1987), "Co-integration and Error Correction: Representation, Estimation, and Testing", *Econometrica* 55(2):251–276.** → the cointegration / error-correction test underlying the pairs trade. **Tests** the T10 cointegration construction (the spread-stationarity test feeding the pairs signal).

### Technical analysis (classic & microstructure)

- **Lo, Mamaysky & Wang (2000), "Foundations of Technical Analysis: Computational Algorithms, Statistical Inference, and Empirical Implementation", *Journal of Finance* 55(4):1705–1765.** → formal, kernel-smoothed evaluation of classic TA patterns. **Tests** TA4 (94 classic indicators — RSI/MACD/BB/MA/ADX/Donchian/Stoch; **0/94 beat buy-and-hold**, best flips to holdout net Sharpe −1.01).
- **Sullivan, Timmermann & White (1999), "Data-Snooping, Technical Trading Rule Performance, and the Bootstrap", *Journal of Finance* 54(5):1647–1691.** → entire universes of TA rules vanish under data-snooping-robust (Reality Check) testing. **Tests** the TA4 (94 classic) and TA3 (224 microstructure variants) rationale — the honest-`N` + surrogate framing that makes the apparent best rule disappear.
- **Bouchaud, Bonart, Donier & Gould (2018), *Trades, Quotes and Prices: Financial Markets Under the Microscope*, Cambridge University Press.** → market-microstructure / forced-flow mechanics and the cost of trading them. **Tests** TA3 (15-minute / 30-minute forced-flow on BTC, 224 variants; realistic cost kills all 15m/30m, the survivor dies on `DSR(N=224, p=0.21)` and holdout −0.98).

### Limits to arbitrage / carry (the two survivors)

- **Aramonte, Huang & Schrimpf (2023), "Crypto carry", BIS Working Paper No. 1087.** → the perp-funding and dated-basis premium is a limits-to-arbitrage compensation (someone is forced to pay to be long), not a return forecast. **Tests** E2 (perp funding carry) and T8 (dated-futures basis / cash-and-carry) — the two SURVIVORS; both pass the full-sample gates but are sub-risk-free in the current regime ([`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md) §3).
- **Shleifer & Vishny (1997), "The Limits of Arbitrage", *Journal of Finance* 52(1):35–55.** → why structural premia persist and who is forced to trade. **Tests** the carry interpretation and the §5 "structural / event flow" forward guidance (the only non-exhausted prior family).
- **Makarov & Schoar (2020), "Trading and Arbitrage in Cryptocurrency Markets", *Journal of Financial Economics* 135(2):293–319.** → cross-venue price/funding dispersion in crypto and its frictions. **Tests** carry round-2 D1 (Binance↔Bybit funding correlated 0.66–0.87; cross-venue dispersion arb is a mirage at taker cost — fires 0–2× in 3 years).

### Anomaly decay (why the survivors are "known and priced")

- **McLean & Pontiff (2016), "Does Academic Research Destroy Stock Return Predictability?", *Journal of Finance* 71(1):5–32.** → published anomalies decay out of sample (≈26% lower OOS, ≈58% lower post-publication). **Tests** the decay framing of the survivors (§3) and the "carry is known and priced — it is a regime trade" verdict.

### Round-6 lead-lag / rotation null (cross-sectional shuffle)

- **Lo & MacKinlay (1990), "When Are Contrarian Profits Due to Stock Market Overreaction?", *Review of Financial Studies* 3(2):175–205.** → lead-lag cross-autocorrelation among assets. **Tests** C1-rotation; motivates the `crossSectionalShuffle` null that *must* destroy genuine lead-lag — and does reproduce C1's lead-lag statistic (`p_LL = 1.000`), proving the "lead-lag" is an artifact, not real capital rotation.
- **Hou (2007), "Industry Information Diffusion and the Lead-Lag Effect in Stock Returns", *Review of Financial Studies* 20(4):1113–1138.** → information diffusion drives lead-lag, so rotation tests must control for it. **Tests** C1/C3 — the mandatory cross-sectional surrogate (C3 breadth `placeboP=0.244`, not significant ⇒ the residual timing edge is aggregate vol-state, not cross-asset breadth).
- **Moskowitz & Grinblatt (1999), "Do Industries Explain Momentum?", *Journal of Finance* 54(4):1249–1290.** → apparent cross-sectional momentum can be a grouping/rotation artifact. **Tests** why C1/C2 rotation edges are checked against the marginal-preserving cross-sectional shuffle, not just phase/block nulls (C2 dominance-cycle KILL: the "rotation edge" is single-asset momentum in disguise).

### Event studies (round-6 C4 listing / event flow)

- **MacKinlay (1997), "Event Studies in Economics and Finance", *Journal of Economic Literature* 35(1):13–39.** → the canonical cumulative-abnormal-return (CAR) event-study methodology. **Tests** C4 (listing-event study: CAR −5.3% through day 20 is descriptively real).
- **Brown & Warner (1985), "Using Daily Stock Returns: The Case of Event Studies", *Journal of Financial Economics* 14(1):3–31.** → daily-return event-study test statistics and their pitfalls (clustering, non-normality). **Tests** the C4 day-by-day significance testing of the listing "dump".
- **Ritter (1991), "The Long-Run Performance of Initial Public Offerings", *Journal of Finance* 46(1):3–27.** → long-horizon post-event drift and the survivorship/cohort traps in event samples. **Tests** the C4 consume-once holdout design (the 2025–26 listing cohort *pumped* instead of dumping, so the short flipped to −100% compound — a regime/cohort reversal, exactly the Ritter caution).

### On-chain valuation / flow (28th test — OC1 distribution-pressure)

- **The NVT / MVRV on-chain-valuation family** (practitioner and academic on-chain metrics: network-value-to-transactions, market-value-to-realized-value, realized cap, SOPR, exchange in/out flow). These on-chain ratios are widely published as crypto "fundamental" valuation/flow signals, and are correspondingly heavily arbitraged — so the honest prior is null. **Tests** OC1, the on-chain distribution-pressure overlay (exchange in/out flow in native units + MVRV cost-basis). OC1 confirmed the null (**KILL** — binding gate `baselines`; `surrogate` placeboP=0.482), the same way the rotation tests C1/C2 died. The mechanics (look-ahead control via ≥1-day feature lag against Coin Metrics revision flags; native-unit flow to avoid the USD-denomination tautology) are documented in `docs/ONCHAIN_FEASIBILITY.md` and `output/onchain-poc/verdict.json`.

---

## Notes on citation accuracy

- **Fieberg et al.** is cited in earlier drafts of the synthesis as a 2024 working paper "CTREND". The verified published form (web-checked 2026-05-28, recorded in `references/REFERENCIAS_CRITICAS_EDGE_ROBUSTO_2026-05-28.md`) is **Fieberg, Liedtke, Poddig, Walker & Zaremba (2025), *JFQA*, DOI 10.1017/S0022109024000747**; that is the form used above.
- **BIS WP 1087** "Crypto carry" is authored by **Aramonte, Huang & Schrimpf (2023)**.
- The **MacKinlay (1997)**, **Brown & Warner (1985)** and **Ritter (1991)** event-study trio backs the round-6 C4 listing-event hypothesis; they were applied in the C4 script even though they were not in the original synthesis-doc bibliography, so they are added here for completeness.
- All quantitative figures referenced in the `→` notes (honest-`N`, DSR/PBO values, holdout returns, `placeboP`) trace to `output/{r2-illiquid,front-r3,front-r4,c1-rotation,front-c2,front-c3,front-c4,ta-research,walkforward,carry,funding,onchain-poc}/…json` and to `docs/EVOLUTION_TRAINING_LOG.md` (round 1–6 entries plus the 28th-test on-chain POC entry, 2026-05-31).

---

## See also (project documentation set)

- [`EDGE_SEARCH_SYNTHESIS.md`](EDGE_SEARCH_SYNTHESIS.md) — the durable map: 28 hypotheses, 26 KILL, 2 sub-RF carry survivors; where the edge is *not*; the methodology that works.
- [`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md) — the anti-overfitting gauntlet packaged as one reusable `validateStrategy(...)` call, with the gate order.
- `EVOLUTION_TRAINING_LOG.md` (internal lab log — not included in this public release) — the raw chronological lab record with every number (internal provenance; rounds 1–6).
- `references/REFERENCIAS_CRITICAS_EDGE_ROBUSTO_2026-05-28.md` — the prior annotated bibliography (finding + evidence strength + per-paper critique) with verified DOIs/venues.

*License of this documentation set: MIT (see [`../LICENSE`](../LICENSE)).*
