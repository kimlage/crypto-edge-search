# Campaign-D — References

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


The academic basis for each Campaign-D claim and gate. The anti-overfitting gauntlet anchors are shared
with the crypto program ([../REFERENCES.md](../REFERENCES.md)); the prediction-market-specific literature is listed first.

## Prediction-market structure, calibration & the favorite-longshot bias
- **Wolfers, J. & Zitzewitz, E. (2004).** "Prediction Markets." *Journal of Economic Perspectives* 18(2).
  — prices as probability forecasts; the basis for treating the YES mid as an implied probability.
- **Manski, C. (2006).** "Interpreting the predictions of prediction markets." *Economics Letters.*
  — a market price is **not** the mean belief; bounds the "price = true probability" assumption our calibrated-Bernoulli null relies on.
- **Page, L. & Clemen, R. (2013).** "Do Prediction Markets Produce Well-Calibrated Probabilities?" *Management Science.*
  — empirical calibration + a documented horizon effect; the reference frame for §2 of `MONEY_MGMT_AND_ARB.md`.
- **Snowberg, E. & Wolfers, J. (2010).** "Explaining the Favorite-Longshot Bias: Is it Risk-Love or Misperceptions?" *Journal of Political Economy.*
  — the favorite-longshot bias the longshot-fade family (PM01/RE16) targets.
- **Thaler, R. & Ziemba, W. (1988).** "Anomalies: Parimutuel Betting Markets." *Journal of Economic Perspectives.*
  — the original favorite-longshot evidence and the lottery/skew-preference mechanism.
- **Restocchi, V. et al. (2019); Ottaviani & Sørensen (2008).** favorite-longshot micro-foundations under heterogeneous beliefs.

## Bankroll / position sizing / risk (the money-management gauntlet, §3)
- **Kelly, J. (1956).** "A New Interpretation of Information Rate." *Bell System Technical Journal.* — the growth-optimal bet fraction; with edge ≤ 0 the optimum is f*=0.
- **MacLean, Thorp & Ziemba (2011).** *The Kelly Capital Growth Investment Criterion.* — fractional Kelly, drawdown control, and why the expectancy SIGN (not the sizing) sets growth.
- **Samuelson, P. (1971).** "The 'Fallacy' of Maximizing the Geometric Mean…" — caution on full Kelly; supports the quarter/half-Kelly variants tested.

## Anti-overfitting gauntlet (shared anchors; see also crypto [../REFERENCES.md](../REFERENCES.md))
- **Bailey & López de Prado (2014).** The Deflated Sharpe Ratio. *(gate `deflated_sharpe`)*
- **Bailey, Borwein, López de Prado & Zhu (2017).** The Probability of Backtest Overfitting (CSCV/PBO). *(gate `cpcv_pbo`)*
- **Harvey & Liu (2015).** "Backtesting" — the multiple-testing haircut Sharpe. *(gate `haircut`; Bonferroni/Holm/BHY)*
- **Harvey, Liu & Zhu (2016).** "…and the Cross-Section of Expected Returns" — the |t|>3 honest-N bar.
- **Benjamini & Yekutieli (2001).** FDR under dependency — the BHY constant in the haircut.
- **López de Prado (2018).** *Advances in Financial Machine Learning* — CPCV, the False Strategy Theorem, the consume-once holdout.
- **Politis & Romano (1994).** The stationary/block bootstrap. *(gate `block_bootstrap`)*
- **Theiler et al. (1992).** Surrogate data / phase randomization — the placebo-null principle behind the calibrated-Bernoulli and wallet-label-shuffle nulls.
- **Chen & Navet (2007).** random / zero-intelligence pre-test for evolved strategies. *(baseline)*

## Market microstructure / adverse selection (DEFERRED market-making family)
- **Glosten & Milgrom (1985); Kyle (1985).** adverse selection in quote-driven markets — why passive "collect the spread" is not free (the DEFERRED MM mechanisms need PIT L2 data to test honestly).
