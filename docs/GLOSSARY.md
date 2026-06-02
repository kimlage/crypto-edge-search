# Glossary

The load-bearing terms of the gauntlet, one clear paragraph each. These are the concepts the
rest of the documentation assumes you know. The deep treatment is in
[`METHODOLOGY.md`](./METHODOLOGY.md); the gate-by-gate API is in
[`VALIDATION_HARNESS.md`](./VALIDATION_HARNESS.md); the per-term academic sources are in
[`REFERENCES.md`](./REFERENCES.md).

> **License:** MIT (see [`../LICENSE`](../LICENSE)).

---

### DSR — Deflated Sharpe Ratio

The Deflated Sharpe Ratio (Bailey & López de Prado, 2014) is the probability that an observed
Sharpe ratio is *genuinely* positive **after** correcting for how hard you looked for it. A
plain Sharpe is computed as if you ran exactly one pre-registered test; if you searched many
configurations and kept the best, that single number is inflated by selection. The DSR deflates
it using the **honest trial count `N`**, the higher moments (skew and kurtosis) of the returns,
and the sample length, producing a probability that the *true* Sharpe exceeds zero. In the
gauntlet, the `deflated_sharpe` gate passes only when that deflated probability clears the bar
(default `0.95`) **at the honest N** — never at `N = 1` and never at the argmax.

### PBO / CSCV — Probability of Backtest Overfitting via Combinatorially-Symmetric Cross-Validation

PBO (Bailey, Borwein, López de Prado & Zhu, 2017) estimates how often the configuration that
looked best **in-sample** turns out to be **below median out-of-sample** — i.e. how often your
selection is a coin flip once the data it was tuned on is taken away. CSCV is the machinery that
produces it: it splits the strategies-by-folds matrix into every symmetric train/test
combination, ranks the in-sample winner on each held-out test fold, and measures how frequently
that winner under-performs. A PBO `≥ 0.5` means selection carries no real out-of-sample
information. The `cpcv_pbo` gate requires PBO `< 0.5`; a matrix with fewer than 8 folds is
flagged **degenerate**, and a self-derived candidate-vs-zero matrix is structurally unfailable,
so it is reported as `SKIP`/advisory rather than a confident pass.

### Harvey-Liu haircut

The Harvey-Liu haircut (Harvey & Liu, 2015) adjusts a strategy's reported Sharpe for the
multiple testing that produced it, then reports the **haircut Sharpe** that survives. A lone
`t > 2` is only meaningful for one pre-registered test; if hundreds of factors were tried, the
honest bar is far higher (Harvey, Liu & Zhu argue closer to `|t| > 3`). The haircut takes the
champion's p-value, inflates it for the number of trials (Bonferroni / Holm / BHY), and backs
out the Sharpe consistent with the *adjusted* p-value. The `haircut` gate passes only when that
adjusted Sharpe stays above zero — and in practice it is **frequently the true binding gate**,
killing leads that the Deflated Sharpe alone would have let slip.

### Family-wise MAX-statistic

When you **search a grid** of `N` configs and keep the best, the surrogate p-value of *that
winner* is a lie: it ignores that you took a maximum over `N` draws, and the luckiest of `N`
pure-noise configs will reliably beat its own single-config null at the 5% level. The honest
null is therefore the distribution of the **grid-MAXIMUM** statistic under the surrogate: on each
surrogate panel you rebuild *every* config, take the best of them, and ask whether the real
grid-best beats the 95th percentile (`surr95`) of those surrogate maxima. This is the
family-wise / max-statistic correction (White's Reality Check, 2000; Romano & Wolf, 2005;
Westfall & Young, 1993), and it is mandatory for any searched family — it is the single defect
that flipped three earlier "promising" leads to KILL.

### Surrogate / placebo null

A surrogate (or placebo) null is an artificial dataset that **keeps the boring, real properties**
of the series (its marginal distribution, its variance, often its autocorrelation) while
**destroying the specific structure** the strategy claims to exploit. Scoring the strategy on
many such surrogates builds a null distribution; if the real edge does not beat that null, the
"edge" is an artifact the surrogate could manufacture out of any similarly-shaped noise. The null
must be **matched to the claim** — phase-randomization / block bootstrap for time-series timing,
a cross-sectional shuffle for rotation / relative-value, bracket-on-surrogate for path-dependent
exits, GARCH-simulation for vol-clustering. A surrogate **PASS** proves the structure/sign is
non-random; it does **not** prove the realized magnitude is tradable.

### Honest N

The honest N is the **true number of distinct configurations you searched**, counted *before* the
search — not 1, and not the single argmax you decided to keep. It is the deflation factor for the
Deflated Sharpe, the multiplier for the Harvey-Liu haircut, and the grid size for the family-wise
surrogate, so under-counting it inflates every multiple-testing gate at once. A config legitimately
counts as `N = 1` only when it was **frozen from mechanism before you looked at returns** and is
not the argmax of a neighborhood you explored; otherwise honest N equals the full grid size,
recorded in the trial ledger so the deflation is auditable.

### Consume-once holdout

A consume-once holdout is a most-recent block of history that is **carved off before any
in-sample gate runs** and is scored **exactly once**. Because the search never touches it, scoring
it provides a genuine out-of-sample test of whether the realized magnitude survives on unseen
data. The "once" is the whole point: re-scoring the vault — even to "just check" a second config —
turns it back into in-sample data and **voids the verdict**. A guard enforces the single
consumption, and survivorship-biased panels (delisted names absent) make even a clean holdout an
*upper* bound, not a guarantee.

### Matched-exposure baseline

A matched-exposure baseline is a benchmark that holds the **same average market exposure** as the
strategy, so a timing or overlay edge is measured as the *incremental* lift over equivalent
passive exposure rather than against full long. The trap it closes: a low-exposure long/flat
overlay **structurally cannot** out-Sharpe a 100%-long buy-and-hold, so scoring it only against
B&H makes any de-risking look like skill — an artifact. The `baselines` gate therefore requires a
timing strategy to beat a benchmark carrying its own average exposure, not just buy-and-hold,
equal-weight, the random-lottery control, and a one-layer linear model.

### Beta-neutrality

Beta-neutrality is the requirement that a cross-sectional (long/short) book carry **market beta
≈ 0**, so its return is genuine relative-value alpha and not disguised long (or short) market
exposure. You verify it by regressing the book's returns on the market, confirming the slope is
near zero, and reporting the **alpha-t on the residual** — using an **honest out-of-sample hedge
beta**, never an in-sample over-hedge, which would manufacture fake alpha by fitting the hedge to
the very returns being judged. A book that is only profitable because it is net-long the market
fails this baseline; the residual alpha must stand on its own.

### h=0 leakage

`h` is the lag (in periods) between the information a signal uses and the return it is supposed to
predict. **`h = 0` leakage** is using a feature observed at the *same* time as (or after) the
return — for example trading on a bar's own close-to-close move — which makes the backtest a
tautology that cannot be realized live. The leakage gate forces honesty: report the `h = 0`
**contemporaneous ceiling** as an unrealizable upper bound, then require the **strictly-lagged
`h ≥ 1`** leg to clear every gate **on its own**. An edge that exists only at `h = 0` and
collapses at `h ≥ 1` is not an edge; it is look-ahead.

### Financing-on-full-notional

Financing-on-full-notional means borrow, perp funding, futures financing, and the risk-free carry
are charged on the **entire levered or short notional the book actually holds — never on one
unit**. The motivating bug (the "dated-futures leak") charged the risk-free rate on 1 unit of
capital while the book ran ~2.95× levered, under-charging the carry by that factor and inflating a
true Sharpe of `0.69` to a reported `1.64`; charging financing on the full notional collapsed it
back. The cost model makes leverage and short notional explicit and scales every carry component
by the actual gross exposure, so the `net_of_cost` gate sees the real, fully-financed return — on
a KILL the correction only deepens the kill, and on a carry it deflates an inflated headline.
