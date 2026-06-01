# Methodology — A Rigorous Anti-Overfitting Gate Stack for Trading-Strategy Validation

> **This is the durable asset of the project.** Over six rounds (plus a follow-up on-chain
> POC) we tested **35 distinct crypto trading hypotheses** on real public data at full rigor
> (cloud spend $0). **33 were killed.** The two "survivors" are structural carry — real edges that have
> decayed **below the risk-free rate** in the current (2025–2026) regime, i.e. a regime
> trade, not a business. The result that generalizes — and the thing worth sharing — is
> **the validation methodology**: an ordered stack of committed statistical and economic
> gates, the surrogate/placebo controls, an honest trial count `N`, and a consume-once
> holdout. This page documents that methodology so a stranger can evaluate it, reuse it,
> or attack it.
>
> **A KILL is a valid, valuable outcome.** Negative results plus a methodology that does
> not lie are a rare and useful contribution in quantitative finance. We do not oversell.
>
> **License:** MIT (see [`../LICENSE`](../LICENSE)).
> **Companion docs:** [`VALIDATION_HARNESS.md`](./VALIDATION_HARNESS.md) (the one-call API),
> [`EDGE_SEARCH_SYNTHESIS.md`](./EDGE_SEARCH_SYNTHESIS.md) (the tally + full bibliography).
> Reference implementation: [`src/lib/validation/strategy-validator.ts`](../src/lib/validation/strategy-validator.ts).

---

## 1. The problem: why an honest-looking backtest is usually a lie

A backtest is a measurement taken **after** you have already searched a space of
strategies and selected the best one. That selection step is the trap. Three named
pathologies make a "good" backtest almost worthless on its own:

- **Backtest overfitting.** If you try enough variations of a strategy on a fixed
  history, one of them will look excellent **by chance**. The more configurations you
  try, the higher the best in-sample Sharpe you will find on data with *no real edge at
  all*. This is selection bias, not skill.

- **The multiple-testing problem.** A single `t > 2` (or `p < 0.05`) is only meaningful
  for **one** pre-registered test. If you ran hundreds of tests, that bar is far too low:
  Harvey, Liu & Zhu (2016) argue that with the number of factors the literature has
  actually tried, the honest bar is closer to `|t| > 3`. Reporting the unadjusted p-value
  of the *winner* is the central sin of strategy backtesting.

- **The False Strategy Theorem** (Bailey & López de Prado). Given `N` strategies with a
  **true** Sharpe of exactly zero, the *expected maximum* of their in-sample Sharpe ratios
  grows with `N`. So "my best of 200 configs has Sharpe 1.3" is not evidence of edge until
  you have deflated it by how hard you looked. The associated **Minimum Backtest Length
  (MinBTL)** bound says: for a given `N`, a backtest shorter than some length cannot
  distinguish a real Sharpe from the luck-of-selection maximum — the result is
  uninterpretable regardless of how pretty it is.

The consequence: **statistical significance of the selected champion is necessary but not
sufficient, and it must be computed against the true search effort.** On top of that,
even a genuinely-significant Sharpe can still be (a) un-tradeable after costs, (b) just
re-labeled market beta, or (c) an artifact of autocorrelation a dumb null reproduces. A
single gate cannot catch all of these. Hence a **stack**.

---

## 2. Design principles

1. **Gates, not knobs.** Each gate is a hard pass/fail. The first failing gate is the
   **binding gate** — the reason the strategy died. You do not tune the gate to let a
   favorite through; you change the *target*. *Change the target, never the gates.*
2. **Cheap economic gates before expensive statistical ones.** A signal that is only
   positive *gross* of cost, or that loses to buy-and-hold, should die immediately and
   cheaply — before we spend compute on Deflated Sharpe or surrogates.
3. **Net of realistic cost, always.** Edge is measured after charging taker fees on
   every position change. A gross-only signal is an automatic KILL.
4. **Honest `N` is mandatory, not optional.** The harness makes the trial count a
   **required** argument so it can never silently default to 1.
5. **Reuse committed, individually-tested gate code.** The validation harness *composes*
   the gates that live in [`src/lib/training/`](../src/lib/training/); it does not
   reimplement them. The only new code is orchestration and the surrogate null generators.
6. **Deterministic and auditable.** Pure functions, seeded randomness, no network, no I/O
   in the gate path. The same inputs always produce the same verdict.

---

## 3. The gate stack (in order)

The gates run in a fixed order. Each one targets a *different* failure mode. The table
below lists what each certifies and its academic anchor; the subsections add detail and
worked numbers. (Full bibliography in
[`EDGE_SEARCH_SYNTHESIS.md` → References](./EDGE_SEARCH_SYNTHESIS.md#references--bibliography).)

| # | Gate (`id`) | What it certifies | Academic source | Committed code reused |
|---|---|---|---|---|
| 1 | `net_of_cost` | Positive **net of realistic cost**; turnover reported. Gross-only ⇒ KILL. | cost realism (Allen & Karjalainen; Sullivan-Timmermann-White) | `summarizeReturnSeries` |
| 2 | `baselines` | Beats **buy-and-hold + equal-weight + random-lottery + one-layer linear**, net of cost. | Chen & Navet 2007 (random lottery); Zeng et al. 2023 (DLinear) | `significance/baselines.ts` |
| 3 | `deflated_sharpe` | Deflated Sharpe probability ≥ bar **at an explicit honest `N`**. | Bailey & López de Prado 2014 (DSR); MinBTL 2014 | `computeDeflatedSharpeRatio` |
| 4 | `cpcv_pbo` | Probability of Backtest Overfitting `< 0.5` over combinatorial splits; flags `<8` folds as degenerate. | Bailey, Borwein, López de Prado & Zhu 2017 (PBO/CSCV) | `estimateCscvPbo` |
| 5 | `haircut` | Sharpe survives the **multiple-testing haircut** (Bonferroni / Holm / BHY). | Harvey & Liu 2015 | `significance/haircut.ts` |
| 6 | `surrogate` | Real edge beats a **phase-randomized + block-bootstrap (+ optional cross-sectional)** null. *The hero.* | Theiler et al. 1992; Politis & Romano 1994; Lo-MacKinlay 1990 | new null generators |
| 7 | `holdout` | Out-of-sample slice scored **exactly once**. | López de Prado 2018 (consume-once holdout) | `significance/holdout.ts` |

### Gate 1 — Net of cost (turnover-aware)

Cost is charged on **every position change**: `|Δposition| × roundTrip`, with
`roundTrip = 2 × takerPerSide`. The default is 4 bps/side on a perp (8 bps round-trip).
Pass a `position` path in `[-1, 1]` for turnover-aware charging; otherwise supply an
explicit `turnover` or accept a round-trip per active period. Turnover is reported in
`netStats.turnover`. **A signal that is only positive gross dies here.**

This is the cheapest possible filter and it kills a surprising amount. Examples from the
edge search: every 15-minute / 30-minute microstructure variant in TA3 died on cost; the
classic-indicator universe in TA4 collapsed once round-trips were charged.

### Gate 2 — Baselines (the first *economic* test)

Statistical significance does not mean *economic edge*. A strategy must beat the dumb
things you could have done instead, **net of cost**:

- **Buy-and-hold** (one round-trip at entry). Most "trend" or "TA" edges in a bull market
  are just filtered long beta. The canonical case is **TA4**: the best Bollinger-breakout
  config passed DSR (p ≈ 0.00025), PBO (0.00) and the haircut, then **lost to
  buy-and-hold** (margin −0.00057), to random-lottery, and to linear — it was long-beta,
  not timing skill. Across 94 classic indicators, **0/94 beat buy-and-hold**.
- **Equal-weight** panel return (for cross-sectional strategies).
- **Random-lottery trader** (Chen & Navet 2007). Without a zero-intelligence pre-test, a
  genetic/heuristic search's "success" is probably luck. We simulate a trader that fires
  the same number of trades at random and check the champion beats its distribution.
- **One-layer linear** baseline (Zeng et al. 2023, "DLinear"). A single linear layer
  matches or beats sophisticated forecasters in most time-series settings — so any
  complex model must beat a trivial linear one. In **C3** (joint market-state overlay)
  the binding gate was exactly this: the overlay **lost to a trivial linear predictor**.

### Gate 3 — Deflated Sharpe at honest `N`

The Deflated Sharpe Ratio (Bailey & López de Prado 2014) deflates an observed Sharpe by
(a) the **true number of trials `N`**, (b) the non-normality (skew/kurtosis) of the return
series, and (c) the sample length. It returns a probability that the *true* Sharpe exceeds
zero given how hard you searched. The harness requires `trialCount` and passes it straight
in. The default bar is `deflatedProbability ≥ 0.95`. See §5.1 for why honest `N` is the
single most load-bearing input here.

### Gate 4 — CPCV / PBO

The Probability of Backtest Overfitting (Bailey, Borwein, López de Prado & Zhu 2017) uses
**combinatorially-symmetric cross-validation (CSCV)**: split the history into many folds,
form all train/test combinations, and estimate how often the in-sample best strategy
**underperforms out-of-sample**. PBO `≥ 0.5` means the selection process is no better than
a coin flip OOS — pure overfitting. The harness flags `foldCount < 8` as degenerate
(too few folds to trust the estimate). In **C1 (rotation)** the PBO was **0.964** — severe
overfitting, a clear flag even before the surrogate killed it.

### Gate 5 — Harvey-Liu haircut

Harvey & Liu (2015) "haircut" the Sharpe ratio by adjusting the champion's p-value for
multiple testing (Bonferroni / Holm / BHY), then back out the Sharpe consistent with the
*adjusted* p-value. A strategy passes only if the haircut Sharpe stays positive. This is a
second, complementary multiple-testing control to the DSR: DSR deflates the *level*; the
haircut adjusts the *p-value* and supports family-wise (Holm) or false-discovery-rate
(BHY) corrections for panels of strategies.

### Gate 6 — Surrogate / placebo (the methodological hero)

See §5.2 — this gets its own section because it is the project's sharpest tool and the
hardest to grasp.

### Gate 7 — Consume-once holdout

A final, most-recent block of history the search **never touches**, scored **exactly
once**. See §5.3.

> **Note on order and "binding gate".** Because gate 1 is cheapest and gate 6/7 are most
> expensive, the *reported* binding gate is whichever fails first in this order. A
> strategy can be doomed by several gates at once (e.g. C1 fails PBO, surrogate, and
> holdout); the binding gate is just the first wall it hit. The full per-gate record is
> always retained.

---

## 4. Surrogate / placebo, explained for a newcomer

This is the idea most people have never seen, and it is the one that did the decisive
killing. Read this section even if you skip the rest.

**The question a surrogate answers.** "My adaptive machine / GA / overlay found an edge.
Is it tracking something *real* in the market, or is it just **good at manufacturing a
pretty backtest out of any series with the same superficial shape**?"

**How you answer it.** Build **placebo datasets** — *surrogates* — that keep the boring,
real statistical properties of the data (its volatility, its autocorrelation) but
**destroy the specific structure your strategy claims to exploit**. Then run the *exact
same* search and scoring on the surrogates. If your machinery finds an **equal-or-better
"edge" on the placebos** — where, by construction, no real edge exists — then the "edge"
on the real data is an **optimization artifact**, not a signal.

It is the trading equivalent of a placebo arm in a drug trial: if the sugar pill does as
well as the drug, the drug does nothing.

We use three surrogate generators, each destroying a different kind of structure:

- **Phase randomization** (Theiler et al. 1992). Take the Fourier transform of the
  series, **randomize the phases** while keeping the amplitude spectrum, invert. The
  surrogate has the *same* variance and the *same* linear autocorrelation as the original,
  but its nonlinear / regime structure is destroyed. This catches strategies that are
  secretly just feeding on autocorrelation.
- **Block bootstrap** (Politis & Romano 1994). Resample contiguous **blocks** of returns.
  Short-range dependence survives; long-range regime structure does not. Catches
  regime-timing claims.
- **Cross-sectional shuffle** (the rotation null; Lo-MacKinlay 1990, Hou 2007). For a
  *panel* of assets, **permute which asset receives which return path**. Every asset's
  marginal distribution is preserved exactly, but genuine cross-asset **lead-lag /
  rotation** is destroyed. This is mandatory for any rotation / relative-value / lead-lag
  hypothesis.

The gate reports the real-vs-surrogate distribution and a **placebo p-value** (`placeboP`
= fraction of surrogates scoring **≥** the real strategy). It passes only when
`placeboP ≤ maxPlaceboP` (default 0.05). A high `placeboP` means the placebos do as well
as the real thing — KILL.

> **Why this is sharper than DSR/PBO/haircut.** Those three certify *"this Sharpe is not
> luck-of-selection."* They say nothing about whether the *structure* is real. The
> surrogate gate directly tests the economic claim by reproducing the search on data
> where the claimed structure is provably absent. It is the only gate that can catch an
> **adaptive** machine fooling itself — and the GA / walk-forward results below show it
> doing exactly that.

---

## 5. The three load-bearing parts (with the concrete kills)

The other gates (DSR, PBO, haircut) only certify that a Sharpe is not luck-of-selection;
they do not test economic edge. **Three controls did the actual killing.** Each subsection
gives the example where that control was the decisive killer.

### 5.1 Honest trial count `N` (gates 3 & 5)

The Deflated Sharpe and the haircut **only deflate if you feed them the true number of
distinct configs you searched**. Feeding `N = 1` (or a per-family bucket length) silently
skips the deflation and lets a data-mined champion sail through. The harness makes
`trialCount` a **required** option for exactly this reason.

Concrete kills:

- **TA3** (microstructure, 224 variants): the survivor config had a pretty in-sample
  Sharpe (search net Sharpe ≈ 1.30 annualized), but deflated at the honest **`N = 224`**
  the DSR probability fell to **0.79 (p = 0.21)** — i.e. noise. It also failed the
  consume-once holdout. (`output/ta-research/ta3-results.json`.)
- **T10** (cointegration pairs): gross +52.8% looked great, but at honest **`N = 420`**
  the DSR probability was **0.029** and the MinBTL bound failed — the backtest was too
  short to interpret a champion chosen from 420 trials.
- **GA over rules (R3):** the genetic program searched **5,613 unique genomes**; deflated
  at that honest `N`, the holdout DSR probability was **≈ 9 × 10⁻¹²**.
  (`output/front-r3/ga-rules-result.json`.)

The discipline: **you must pass the real `N` from your trial ledger.** If you searched
5,613 genomes, `N = 5613` — not 1, not 40.

### 5.2 Surrogate / placebo (gate 6) — the hero

The decisive control in the project, three times over:

- **GA over trading rules (R3): placebo p = 1.000.** A genuine genetic program (population
  160, 40 generations, AND/OR rules over indicators) found a champion with **train net
  Sharpe +0.088**. Run on **pure phase-randomized and block-bootstrap noise**, the *same*
  GA found champions that were **better out-of-sample** (surrogate holdout Sharpe mean
  **+0.032**, max **+0.110**) than the real champion (**−0.097**). Placebo
  **p = 1.000** — *every* noise run did at least as well. The GA is the ultimate
  overfitter; **without the surrogate control this would have looked like an in-sample
  win.** (`output/front-r3/ga-rules-result.json`.)

- **Rotation (C1): the cross-sectional shuffle was decisive.** The rotation "ride the
  relay" strategy had an in-sample net Sharpe of **1.076**. The lead-lag statistic it
  relied on was **fully reproduced by the cross-sectional shuffle** (`p_LeadLag = 1.000`)
  — i.e. permuting which asset gets which path reproduces the entire "lead-lag" signal.
  The shuffle's placebo p-value on the portfolio score was **0.005** in the sense that the
  shuffled panels scored as well as the real one. Combined with **PBO = 0.964** and a
  **−39.9% holdout**, the verdict is unambiguous: the "capital rotation across tiers" was
  really just single-asset momentum plus an aggregate volatility state — **not**
  circulation of capital between tiers. The cross-sectional shuffle is what told the two
  apart. (`output/c1-rotation/rotation-report.json`.) The same shuffle clarified **C3**:
  the leftover timing edge was aggregate vol-state, **not** cross-asset breadth/rotation.

- **Walk-forward adaptation (WF-B / WF-C):** the adaptive machine **manufactured backtest
  dispersion in noise as well as in real data**. In WF-C the real adaptive run scored
  **−0.063** while phase-surrogate and block-surrogate means were **+0.129 / +0.132** and
  **80 surrogates beat the real run** (`placeboP ≈ 0.63`). Without the surrogate, the
  in-sample dispersion would have looked like a regime-tracking win; with it, the run was
  exposed as noise-fitting. (`output/walkforward/wf-c-result.json`.)

The carry demo (`scripts/validation/demo-validate.ts`) shows the gate behaving honestly on
*real* data too: the equal-weight perp-funding carry series in the current regime yields
`placeboP ≈ 0.671` — the surrogates do as well as the real series, independently flagging
that carry has decayed (consistent with the cost gate killing it first). A seeded-Gaussian
noise series gets `placeboP ≈ 0.70` and an AR(1) artifact `≈ 0.77`.

### 5.3 Consume-once holdout (gate 7)

The search may see train and selection data, and may even audit a posterior `test` slice,
but a truly out-of-sample verdict needs a final, most-recent block the search **never
touches** and that is **scored exactly once**. The harness carves it with `planHoldoutSplit`
and consumes it through `FinalHoldoutGuard` — a second attempt **throws**, because
re-tuning against the vault would void the verdict.

This is where the prediction edges died, one after another:

- **TA1** (indicators to time the carry ON/OFF): passed **every gate in-sample**
  (`p = 5.8 × 10⁻⁷`, DSR ≈ 1.0, PBO ≈ 0.075, beat baselines, survived the haircut), then
  in the consume-once holdout the gate went **100% OFF and merely tied the risk-free rate**
  (gated Sharpe = 0, margin vs RF = 0). The decisive number is the **perfect-foresight
  oracle bound of only +0.52%/yr** over RF in that holdout — meaning *no* causal timing
  gate, however good, can extract a meaningful edge in this regime.
  (`output/ta-research/carry-gating-report.json`.)
- Across the prediction/TA hypotheses the holdout was the recurring executioner:
  E1 **−9.59% net**, T1 **−32%**, T9 **−48%**, TA4 holdout net Sharpe **−1.01**, the GA
  structural rule collapsing from **+3.15%/yr in-sample to −0.015%/yr** (flat RF) in the
  holdout, the C4 listing-short going to **−100% compound** when the held-out cohort
  pumped instead of dumping.

> **Change the target, never the gates.** An empty parent pool under this stack means the
> *target* lacks edge net of cost — not that the stack is too strict.

---

## 6. What the stack found (the honest verdict)

| Bucket | Count | Notes |
|---|---|---|
| Hypotheses tested at full rigor | **35** | six rounds + an on-chain POC, all on real public data, cloud spend $0 |
| Killed | **33** | every prediction / TA / relative-value / rotation / on-chain-flow idea, **fixed and adaptive** |
| Structural-carry "survivors" | **2** | perp funding carry (E2) and dated-futures basis (T8) |

The two survivors passed the full-sample gates but are **structural carry, not
prediction** — a limits-to-arbitrage premium (BIS WP 1087). Both have **decayed below the
risk-free rate** in the current regime: the oracle-bound timing edge on carry today is only
**≈ +0.52–0.53%/yr**, and after capital-efficiency and roll costs the incremental edge over
T-bills is **negative** at every capital tier modeled. **Carry is a regime trade — arm it
only when funding is rich (≳ 8–9%) and rising — not an always-on business.** It is *real*;
it is *not profitable now*. Full per-hypothesis detail and the carry economics are in
[`EDGE_SEARCH_SYNTHESIS.md`](./EDGE_SEARCH_SYNTHESIS.md).

The takeaway is not "crypto has no edge." It is: **the edge is not in direction
prediction, classic/microstructure TA, cross-section/relative-value at retail cost,
timing the carry, capital rotation across tiers, or adaptively re-fitting any of these** —
and the gate stack correctly refused to manufacture a survivor where there was none.

---

## 7. Using the methodology — the `validateStrategy()` API

The whole stack is packaged as one deterministic call. (Full usage notes:
[`VALIDATION_HARNESS.md`](./VALIDATION_HARNESS.md).)

```ts
import { validateStrategy } from "@/lib/validation/strategy-validator";

const verdict = validateStrategy(grossPerPeriodReturns, {
  // HONEST N — the TRUE number of distinct configs you searched. REQUIRED.
  trialCount: 224,

  // Statistic for baselines / DSR. "compoundReturn" is the cost-realism default.
  statistic: "compoundReturn",

  // Cost is charged on every position change: |Δposition| × (2 × takerPerSide).
  cost: { takerPerSide: 0.0004, position },        // 4 bps/side perp; pass a [-1,1] path

  // Economic baselines the strategy must beat, net of cost.
  baselines: { marketReturns, equalWeightReturns, linearReturns },

  // Surrogate / placebo null. crossSectional + panel are required for rotation tests.
  surrogate: { iterations: 200, crossSectional: true, panel: { assetReturns } },

  // Consume-once holdout: carved here, scored exactly once.
  holdout: { holdoutFraction: 0.15, testFraction: 0.15 },
});

verdict.verdict;       // "PASS" | "KILL"
verdict.bindingGate;   // the FIRST gate that failed (the binding constraint) | null
verdict.perGate;       // every gate's { id, passed, reason, detail }, in order
verdict.netStats;      // net-of-cost summary incl. turnover + grossSharpe
verdict.trialCount;    // the honest N actually used for DSR / haircut
```

- **Input.** The strategy's **gross** per-period return series (or a `() => number[]` that
  produces one). The harness charges cost itself and runs the gates in order.
- **Output.** A structured `{ verdict, bindingGate, perGate, netStats, trialCount }`. The
  binding gate tells you *why* it died; `perGate` is the full audit trail.
- **`trialCount` is required and must be the honest `N`.** This is the one input you must
  not get wrong (see §5.1). Pass it from your trial ledger.
- **For rotation / lead-lag / relative-value hypotheses**, pass `surrogate.panel` and set
  `surrogate.crossSectional: true` so the cross-sectional shuffle runs — it is the only
  null that distinguishes genuine rotation from single-asset momentum (§5.2, C1).
- **A KILL is the expected, valuable outcome.** The gates do not manufacture survivors.

A smoke run (`scripts/validation/demo-validate.ts`) validates a real carry series, a
seeded-Gaussian noise series, and an AR(1) artifact, asserting the harness runs all seven
gates and KILLs the noise. The harness is pure, deterministic (seeded), with no network or
I/O in the gate path; `npx tsc --noEmit` reports 0 errors.

---

## 8. Reproducibility and provenance

Every quantitative claim on this page traces to a committed machine-readable output:

| Claim | Source of truth |
|---|---|
| GA-over-rules placebo p = 1.000; N = 5,613; DSR ≈ 9e-12 | `output/front-r3/ga-rules-result.json` |
| Rotation: PBO 0.964; lead-lag reproduced by shuffle (`p_LL` = 1.000); holdout −39.9% | `output/c1-rotation/rotation-report.json` |
| WF-C: real −0.063 vs phase +0.129 / block +0.132; `placeboP` ≈ 0.63 | `output/walkforward/wf-c-result.json` |
| TA1: in-sample p = 5.8e-7; holdout ties RF; oracle bound +0.52%/yr | `output/ta-research/carry-gating-report.json` |
| TA3: N = 224; DSR p = 0.21 | `output/ta-research/ta3-results.json` |
| TA4: 0/94 beat buy-and-hold; holdout Sharpe −1.01 | `output/ta-research/ta4-classic-indicators-result.json` |
| Small-caps (R2): placebo p = 0.90; holdout −58.5% | `output/r2-illiquid/smallcap-audit-report.json` |
| GA structural carry (R4): +3.15%/yr → −0.015%/yr holdout; placebo p = 0.721 | `output/front-r4/ga-structural-carry-result.json` |
| C3 overlay loses to linear; cross-sectional shuffle non-significant | `output/front-c3/c3-report.json` |
| C4 listing short: −100% holdout compound | `output/front-c4/listing-event-result.json` |
| Carry economics / decay (regime trade, sub-RF) | `output/carry/*.json`, `EDGE_SEARCH_SYNTHESIS.md` §3 |
| Carry demo placeboP ≈ 0.671; noise / AR(1) KILLed | `output/validation/demo-validate-report.json` |

The chronological lab record (rounds 1–6, with every number) is
`EVOLUTION_TRAINING_LOG.md` (internal lab log — not included in this public release) (internal, Portuguese; not included in this public release — all numbers trace to the machine-readable output/*.json provenance). The
English synthesis and full academic bibliography are in
[`EDGE_SEARCH_SYNTHESIS.md`](./EDGE_SEARCH_SYNTHESIS.md). The committed gate
implementations live in [`src/lib/training/`](../src/lib/training/)
(`statistical-validation.ts`, `significance/{baselines,haircut,holdout,trial-count,spa,cpcv-paths}.ts`);
the harness that composes them is
[`src/lib/validation/strategy-validator.ts`](../src/lib/validation/strategy-validator.ts).

---

### Key references

Anchors for the methodology (full bibliography in
[`EDGE_SEARCH_SYNTHESIS.md`](./EDGE_SEARCH_SYNTHESIS.md#references--bibliography)):

- **Bailey & López de Prado (2014)** — The Deflated Sharpe Ratio. *(gate 3)*
- **Bailey, Borwein, López de Prado & Zhu (2014)** — Pseudo-Mathematics… Minimum Backtest Length; the False Strategy Theorem. *(honest N / MinBTL)*
- **Bailey, Borwein, López de Prado & Zhu (2017)** — The Probability of Backtest Overfitting (PBO/CSCV). *(gate 4)*
- **López de Prado (2018)**, *Advances in Financial Machine Learning* — purged/embargoed CPCV, the False Strategy Theorem, the consume-once holdout. *(gates 4 & 7)*
- **Harvey & Liu (2015)** — Backtesting: the multiple-testing haircut Sharpe. *(gate 5)*
- **Harvey, Liu & Zhu (2016)** — …and the Cross-Section of Expected Returns; the `|t| > 3` bar. *(honest-N rationale)*
- **Theiler et al. (1992)** — surrogate data / phase randomization. *(gate 6)*
- **Politis & Romano (1994)** — the stationary / block bootstrap. *(gate 6)*
- **Lo & MacKinlay (1990); Hou (2007)** — cross-autocorrelation / lead-lag; motivate the cross-sectional-shuffle null. *(gate 6, rotation)*
- **Chen & Navet (2007)** — random / zero-intelligence pre-test for evolved strategies. *(gate 2)*
- **Zeng et al. (2023)** — DLinear: a single linear layer as a strong baseline. *(gate 2)*

---

*License: MIT (see [`../LICENSE`](../LICENSE)). This document is intended to be shared as an
open-source description of the validation methodology.*
