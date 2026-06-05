# Glossary

*[Home](INDEX.md) · [Methodology](METHODOLOGY.md) · [Crypto results](RESULTS.md) · [Polymarket](polymarket/README.md) · [Unified synthesis](../SYNTHESIS.md)*

The load-bearing terms of the gauntlet, one clear paragraph each — shared by **both domains** (crypto +
Polymarket). These are the concepts the rest of the documentation assumes you know. The deep treatment is in
[`METHODOLOGY.md`](./METHODOLOGY.md); the gate-by-gate API is in
[`VALIDATION_HARNESS.md`](./VALIDATION_HARNESS.md); the per-term academic sources are in
[`REFERENCES.md`](./REFERENCES.md). The **gate terms** come first, then the **verdict scheme**, then the
**prediction-market-specific** nulls and concepts.

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

---

## The verdict scheme

Every hypothesis exits the gauntlet with exactly one of four labels. They are **not** "pass / fail /
maybe" — each is a precise statement about *which* gate decided and *why*.

### KILL

A **KILL** means the hypothesis fails a **core economic gate** — most often `net_of_cost` (it loses money
once realistic costs and financing are charged) or `baselines` (it cannot beat a matched-exposure or
random control). This is the expected, valuable outcome and the overwhelming majority verdict: ~111 crypto
hypotheses and the bulk of the 73 Polymarket mechanisms land here. A KILL is **conservative** — the two
biggest data caveats in this lab (an optimistic cost floor, a single split) both bias *toward* finding
edge, so correcting them can only deepen a KILL, never manufacture a survivor.

### PROMISING

A **PROMISING** hypothesis clears the **core economic gates** (it makes money net of cost and beats its
baselines) but **trips a multiple-testing or Deflated-Sharpe gate** — the *sign* of the edge is real, but
its *realized mean is not significant at [honest N](#honest-n) on unseen data*. It is a real structural
fingerprint that is too small, too rare, or too searched-for to bank. The two crypto leads that reached
PROMISING (a beta-neutral cross-sectional Donchian breakout; a thin unlevered dated-futures basis) are the
canonical examples; the Polymarket favorite-longshot structure is a third.

### SURVIVE

A **SURVIVE** means **every gate passes**, including the [consume-once holdout](#consume-once-holdout). It
is the only verdict that would license deployment. **Clean SURVIVE count across both domains: 0.** The
[positive control](#positive-control) proves this is a property of the *markets*, not a broken gauntlet:
the same harness *does* return SURVIVE on a planted +8% synthetic edge.

### DEFERRED

A **DEFERRED** hypothesis is one whose only honest test **needs data the lab does not have at $0** —
point-in-time L2 order books, paid options chains, live two-sided quoting, or per-second microstructure.
It is neither alive nor dead; it is *undecidable at $0* and is logged with the specific blocking data
requirement (see [`polymarket/RE_LEDGER.md`](polymarket/RE_LEDGER.md) for the 12 deferred reverse-engineering
mechanisms). DEFERRED is an honesty mechanism: it refuses to issue a verdict the evidence cannot support.

---

## Prediction-market terms

These appear in the **Polymarket** domain. The gate terms above apply unchanged; these are the
domain-specific nulls and structures the [`polymarket/`](polymarket/README.md) pages assume.

<a id="calibrated-bernoulli"></a>
### Calibrated-Bernoulli null

The calibrated-Bernoulli null is the **right null for a prediction-market calibration / favorite-longshot
claim**: instead of asking "did the trader win more than 50%?", it asks "did outcomes resolve YES *more
often than the market price said they would*?" Under the null, each market at price `p` resolves YES with
probability exactly `p` (a Bernoulli draw at the *market-implied* rate), so a perfectly-calibrated market
generates **zero** edge by construction. The test scores a candidate fade/follow strategy against thousands
of such price-tied Bernoulli panels; only a genuine, systematic **miscalibration** (prices that are
biased, not merely noisy) beats it. This is what walked back the "market is well-calibrated, p=0.993"
claim to "no cost-survivable favorite-longshot trade survives" — see [`polymarket/RESULTS.md`](polymarket/RESULTS.md).

<a id="wallet-label-shuffle"></a>
### Wallet-label-shuffle null

The wallet-label-shuffle null is the **right null for a copy-trading / wallet-skill claim**. The observed
fact — "the top-decile wallets made money in-sample" — is guaranteed by *selection*: rank any population by
past PnL and the top decile is rich by definition. The null destroys exactly that structure: it **shuffles
the wallet identity labels** across the trade tape, breaking any persistent skill→wallet link while keeping
the trade sizes, prices, and timing intact, then re-computes the out-of-sample PnL of the "top" cohort. If
real skill persists, the true cohort beats the shuffled distribution; here it did not (top-decile −$90,457
OOS, ROI-persistence r≈−0.001, surrogate p=0.43–0.63, [Stouffer z](#stouffer-z)=−0.13 across 5 windows).
See [`polymarket/RESULTS.md`](polymarket/RESULTS.md).

<a id="favorite-longshot"></a>
### Favorite-longshot bias

The favorite-longshot bias is the well-documented tendency (Thaler & Ziemba, 1988; Snowberg & Wolfers,
2010) for **longshots to be over-bet and favorites under-bet** — i.e. low-probability outcomes priced
*higher* than they resolve, high-probability outcomes priced *lower*. If it exists net of cost, the trade
is "fade the longshot / back the favorite." In this lab the structure shows a **marginal** surrogate
signal on clean binaries (p≈0.05, n=402) but **fails [DSR](#dsr--deflated-sharpe-ratio) and the holdout**,
and is **sub-cost / tail-fragile** — a real fingerprint that is not a tradable edge. Contrast with the
[calibrated-Bernoulli null](#calibrated-bernoulli) that scores it.

<a id="overround"></a>
### Overround / negRisk basket

**Overround** (a.k.a. the vig or the book's built-in margin) is the amount by which the prices of a
mutually-exclusive set of outcomes **sum to more than 100%** — the structural edge the *house* holds and
the thing a static-arbitrage hypothesis tries to harvest in reverse (find a basket summing to *less* than
100% and buy it whole for a riskless profit). A **negRisk basket** is Polymarket's mutually-exclusive
multi-outcome market (exactly one leg resolves YES), which settles cleanly and is the natural unit for the
arbitrage scan. The lab found the opposite of free money: 579 negRisk baskets with a **median ask-sum of
1.073 (+7.3% overround)** — you *pay* the vig, you don't collect it. See
[`polymarket/MONEY_MGMT_AND_ARB.md`](polymarket/MONEY_MGMT_AND_ARB.md).

<a id="carry"></a>
### Carry

**Carry** is the return you earn for *holding* a position while nothing changes — the basis between a
dated future and spot that converges to zero at expiry, or the funding a perp pays. It is the one real,
repeatable structure the crypto domain found, but it is a **sub-risk-free regime trade**, not a business:
the realized premium is thin, levered carry must be [financed on full notional](#financing-on-full-notional)
(which is what collapsed the dated-futures lead from a reported 1.64 to a true 0.69 Sharpe), and it
disappears in exactly the risk-off regimes when you would most want it. See [`RESULTS.md`](RESULTS.md).

<a id="stouffer-z"></a>
### Stouffer z

The **Stouffer z** is the standard way to **combine the p-values of several independent tests into one**
meta-statistic: convert each window's p-value to a z-score (via the inverse-normal), sum them, and divide
by `√k`. It answers "taken *together*, do these `k` windows show a signal?" — catching an edge too weak to
clear significance in any single window but consistent across all. The copy-trading walk-forward combines
its **5 disjoint windows** to **Stouffer z = −0.13** (p ≫ 0.05): no signal individually *and* none in
aggregate, which is why the KILL is called robust across time rather than a single-split artifact.

<a id="positive-control"></a>
### Positive control (planted edge)

A **positive control** is a test run on **synthetic data with a *known* edge deliberately planted in it**,
used to prove the gauntlet has the *power* to detect a real edge — that "0 SURVIVE" reflects the markets,
not an always-KILL bug. The lab plants a +8% per-bet edge into an otherwise-random betting stream and
confirms the harness returns **SURVIVE**; it plants a 0% edge and confirms **KILL**; the detection floor is
~5–8%. Every negative result in this repo is therefore *falsifiable* — the same machinery would have
flipped to SURVIVE had a real edge been present. See [`polymarket/EVALUATION.md`](polymarket/EVALUATION.md) §1.
