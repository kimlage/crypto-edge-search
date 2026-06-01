# crypto-edge-search

## Philosophy

This project is a **public scientific laboratory for trading techniques.** Its purpose is to
**test — and aggregate falsifiable, reproducible evidence for or against — the methods people
actually use to look for an edge in financial markets**: technical analysis, indicators, support
and resistance, momentum and mean-reversion, pattern-based and "robust professional" setups,
carry, capital rotation, on-chain flow, and the rest. Each one is run through a single fixed,
uncompromising standard of proof, and the result is published — whatever it is.

It is also, deliberately, a **falsification alert.** An entire industry sells the promise of easy,
fast profit from speculation and trading. The evidence collected here points the other way: once
you account for realistic cost, the *true* number of strategies you tried, and a single honest
out-of-sample test, the overwhelming majority of these techniques are **statistically
indistinguishable from noise.** What survives is not prediction skill — it is a thin, decaying
structural premium that, in the current regime, does not even beat a risk-free Treasury bill.

The uncomfortable conclusion the data keeps repeating: for an individual trading liquid markets at
retail cost, speculation behaves **far more like a game of chance than like a consistent method of
making money.** That is not cynicism — it is the output of running every popular technique through
the same harsh, pre-registered gauntlet and reporting the kills honestly. **A KILL is the most
valuable thing this project produces:** it is one less false promise, backed by evidence anyone can
re-run for $0.

> *If a technique cannot beat buy-and-hold, a random trader, and a coin-flip's worth of
> luck-adjusted significance on data it has never seen — it is not an edge. It is a story.*

---

**A rigorous, anti-overfitting search for a tradeable edge in crypto.** 28 distinct
hypotheses were tested at full statistical rigor on real, free, public market data
(cloud spend **$0**). **26 were killed.** The **2 survivors** are structural-carry
strategies that pass the full-sample gates but are **sub-risk-free in the current
(2025–2026) regime** — regime trades, not a business.

> **This is a negative-results + methodology contribution, and that is the point.**
> The durable asset is **not** a profitable strategy — it is the **methodology**: a
> committed anti-overfitting gauntlet (honest trial-count `N`, surrogate/placebo
> controls, and a consume-once holdout) that refused to promote 26 pretty in-sample
> Sharpes that would otherwise have looked like wins. Honest negative results, fully
> reproducible at $0, are rare in quant — that refusal **is** the result.
>
> Nothing here is investment advice.

**License:** MIT (see [`LICENSE`](LICENSE), © 2026 Kim Lage).

---

## Key results

- **28 hypotheses tested → 26 KILL, 2 sub-risk-free carry survivors** (perp funding carry, dated-futures basis).
- **The edge is NOT in** direction prediction, technical analysis, cross-section / relative value, capital rotation, event flow, on-chain flow, **or** adaptively re-fitting any of them — *fixed, adaptive, AND genetically evolved*.
- **The two-gate death pattern:** signals produce pretty in-sample Sharpes that *pass* DSR / PBO / haircut (which only certify "not luck-of-selection"), then **die at the two gates that test real edge** — beating buy-and-hold/baselines, and a consume-once holdout.
- **The surrogate/placebo control is the hero.** By preserving each asset's volatility and autocorrelation while destroying genuine structure, it answers *"is this edge just dispersion the machine would manufacture in noise?"* — and repeatedly, the answer was yes (a genetic program evolves an *equally good rule on pure noise*; placebo p = 1.000).
- **The one survivor — structural carry — has decayed below the risk-free rate.** A perfect-foresight oracle earns only **+0.51–0.53%/yr** over T-bills in the current regime (proven three independent ways).
- Everything runs on **free public APIs** (Binance / Bybit / OKX / DefiLlama / Coin Metrics Community), **cloud $0**, TypeScript + `tsx`.

---

## The full results — all 28 hypotheses

Columns: **ID** · **Name** · **Class** · **Data** · **Honest N** (the true number of distinct
configs searched, fed to the Deflated-Sharpe and haircut gates) · **Binding KILL gate** (the
first gate that failed) or **SURVIVOR\*** · **Key out-of-sample number** (consume-once holdout,
or for survivors the full-sample net APR).

| ID | Name | Class | Data | Honest N | Binding gate (or SURVIVOR\*) | Key out-of-sample number |
|---|---|---|---|---|---|---|
| **E1** | Cross-section weekly momentum | prediction | 30 USDT pairs, daily 2020–2026 | 32 | KILL — holdout + baselines | holdout **−9.59% net**; DSR 0.041 |
| **E2** | **Perp funding carry** (delta-neutral) | **carry** | 8 majors, 8h funding, 3y | — | **SURVIVOR\*** | full-sample **net ~5.84% APR**; sub-RF today |
| **E3** | BTC time-series trend (daily/weekly) | prediction | BTC full history | 36 | KILL — Deflated Sharpe + baselines | DSR **0.886/0.593** < 0.95; returns = long-beta |
| **T1** | Cross-section reversal | prediction | 30-coin panel | — | KILL — holdout | holdout **−32%** |
| **T2** | CS momentum, neutral + vol-target | prediction | 30-coin panel | 4 | KILL — Deflated Sharpe | +27.9% in-sample but DSR(N=4) loses to random-lottery |
| **T3** | Vol-target BTC (Moreira–Muir) | prediction | BTC history | — | KILL — holdout | holdout **net −11%** |
| **T4** | Diversified TSMOM + vol-target | prediction | multi-asset panel | — | KILL — holdout | holdout **−18%**; gross only +2.8%/2y |
| **T5** | Regime-gated trend | prediction | BTC / majors | — | KILL — holdout | holdout **+1.3%** vs buy-and-hold **+15.3%** |
| **T6** | Seasonality / turn-of-month | prediction | majors daily | — | KILL — holdout (data-mining) | holdout **−32%** |
| **T7** | Funding as contrarian predictor | prediction | funding panel | — | KILL — dead in-sample | holdout **APR −28%** |
| **T8** | **Dated-futures basis / cash-and-carry** | **carry** | quarterly delivery futures | 30 | **SURVIVOR\*** | holdout **net APR +14.6% → +7.31%** post-haircut; sub-RF |
| **T9** | ETH/BTC relative value | prediction | ETH, BTC | — | KILL — holdout | holdout **−48%** |
| **T10** | Cointegration pairs | prediction | majors panel | 420 | KILL — Deflated Sharpe + MinBTL | gross +52.8% but **DSR(N=420)=0.029**, MinBTL fails |
| **TA1** | Indicators to TIME the carry (ON/OFF) | TA-timing | funding/premium/basis, 3y | 69 | KILL — holdout (oracle ceiling) | passes all gates in-sample (p=5.8e-7); holdout ties RF; **oracle only +0.52%/yr** |
| **TA2** | Slow vol-targeted TSMOM (Moskowitz–Ooi–Pedersen) | prediction | 30-coin, monthly | 24 | KILL — net-of-cost / holdout | vault Sharpe **−0.076**; 12m lookback worst in crypto |
| **TA3** | Microstructure / forced-flow 15m BTC (224 variants) | prediction | BTC 15m, 306k bars, 8.75y | 224 | KILL — Deflated Sharpe + holdout | cost kills all 15m/30m; survivor dies **DSR(N=224, p=0.21)** + holdout −0.98 |
| **TA4** | Classic indicators (RSI/MACD/BB/MA/ADX/Donchian/Stoch) | prediction | 8 majors daily | 94 | KILL — baselines + holdout | **0/94 beat buy-and-hold**; best flips to holdout Sharpe **−1.01** |
| **WF-A** | Adaptive walk-forward, premise test | adaptive | BTC/ETH/SOL/BNB daily | meta-grid | KILL — net-of-cost (surrogate clean) | trailing-best beats random next window only **50.7%** |
| **WF-B** | Adaptive WF on majors | adaptive | majors daily | 27 | KILL — **surrogate** | real 0.0050 ≤ surrogate 0.0085, placeboP=0.59 (artifact) |
| **WF-C** | Adaptive WF on 15m BTC | adaptive | BTC 15m, 306k bars | meta-grid | KILL — **surrogate (decisive)** | 80 surrogates beat real (−0.063 vs +0.13); placeboP=0.63 |
| **WF-D** | Adaptivity ON THE REAL EDGE (carry threshold) | adaptive-carry | funding, 3y | meta-grid | KILL — edge-vs-RF (oracle) | tracks perfectly (autocorr 0.97) but **oracle only +0.53%/yr** left |
| **R2** | Illiquid corners / small-caps | prediction | 20 non-top-20 names, 6y, real small-cap cost | 1640 | KILL — **surrogate** | champion **worse than noise** (placeboP=0.90); holdout **−58.5%** |
| **R3** | GA evolves trading RULES (genetic programming) | prediction | 6 majors daily, 3y | 5613 | KILL — **surrogate (placeboP=1.000)** | train +0.088 → holdout **−0.097**; GA on pure noise beats real champion |
| **R4** | GA on STRUCTURAL+technical carry rules | structural | funding/premium/basis, 3y | 2823 | KILL — edge-vs-RF + surrogate | in-sample +3.15%/yr → holdout **−0.015%/yr**; oracle **+0.51%/yr** |
| **C1** | Capital rotation as lead-lag flow | rotation | 43-coin tiered panel + volume, 6y | 108 | KILL — **surrogate (x-sectional shuffle)** | holdout **−39.9%**; PBO **96.4%**; lead-lag reproduced by shuffle (p=1.000) |
| **C2** | Dominance cycle (is there a rotation period?) | rotation | 30 coins, weekly, 6y | 16 | KILL — Deflated Sharpe | persistent not cyclic; vault **−52.7%**, placeboP=1.000 |
| **C3** | Joint market-state / breadth overlay | rotation | 30-coin panel + volume, 6y | 32 | KILL — baselines (loses to linear) | holdout **−19.56%**; residual edge is *aggregate vol*, not breadth |
| **C4** | Event / listing forced-flow | event | 641 real listing events (incl. delisted), 2019–2026 | 32 | KILL — **surrogate** | real "listing dump" (CAR −5.3%/20d) but holdout short **−100% compound** |
| **OC1** | On-chain distribution-pressure (exchange-flow + MVRV) | on-chain / flow | Coin Metrics exchange flow + MVRV, BTC+ETH daily | 36 | KILL — **baselines** + **surrogate (placeboP=0.482)** | loses to B&H + random-lottery + equal-weight; holdout flat (Sharpe 0.003) |
| **—** | BTC-15m direction (retired legacy GA target) | prediction | BTC 15m | 659 evals | KILL (retired as alpha generator) | best **+2.2%** < luck-of-N **+11.76%**; mean negative |

**\*** The two survivors are **structural carry** (a limits-to-arbitrage premium), not prediction.
Both passed the full gauntlet on the 3-year sample but have **decayed below the risk-free rate**
in the current regime (see below). A dash (`—`) in *Honest N* means a single pre-specified rule
(no grid searched), so deflation is by construction and the holdout governs.

**Canonical totals: 28 hypotheses · 26 KILL · 2 sub-risk-free carry survivors.** The full
per-round narrative, with every number traced to its machine-readable `output/…json`, is in
[`docs/RESULTS.md`](docs/RESULTS.md).

---

## The two survivors — real, but a regime trade, sub-RF now

Both survivors are **structural carry** (cash-and-carry / basis convergence, a limits-to-arbitrage
premium), not prediction. Both pass the gauntlet on the 3-year sample. **Neither beats the
risk-free rate in the current regime.**

| Survivor | Full-sample headline | Why it is sub-RF *now* |
|---|---|---|
| **E2 — perp funding carry** (delta-neutral, long spot / short perp) | net ~**5.84% APR** (3y, 8 majors, all legs net-positive, max DD 5.37%) | trailing-12m gross collapsed to **~3.35%** < RF 4.5%; incremental edge vs T-bills **−2% to −3.3%/yr**; minimum viable capital: none up to $5M |
| **T8 — dated-futures basis** (long spot / short quarterly future) | holdout net APR **+14.6% → +7.31%** post-haircut (cross-contract Sharpe 9.17, 0.00% DD at delivery) | also compresses; quarterly-lumpy; same counterparty tail; ~7% historical and falling |

**The deepest finding** is the *oracle proof*, which appears **three independent times** (TA1,
WF-D, R4): a gate or rule with **perfect foresight** earns only **+0.51–0.53%/yr** over the
risk-free rate in the current holdout, because realized carry there is ≈0.36%/yr. **The
structural edge has decayed below the cost of harvesting it — not even a clairvoyant timer
can extract it now.** Carry is a **regime trade** — arm it only when funding is rich (>~8–9%)
and rising, as in 2024 — not an always-on business. (US persons are also geo-blocked from the
deep venues, making the economics strictly worse.)

---

## The methodology — the durable asset

Every hypothesis runs through the same fixed-order gauntlet, packaged as one reusable API
(`validateStrategy(returns | fn, opts)` in [`src/lib/validation/strategy-validator.ts`](src/lib/validation/strategy-validator.ts)).
The **first failing gate is the binding gate**. Cheap economic gates run first, so a gross-only
or baseline-losing signal dies immediately:

| # | Gate | What it certifies | Source |
|---|---|---|---|
| 1 | `net_of_cost` | positive *net* of realistic cost (taker ≈ 4 bps/side ⇒ 8 bps round-trip, on every position change) | — |
| 2 | `baselines` | beats buy-and-hold + equal-weight + random-lottery + a one-layer linear model | Chen–Navet; Zeng et al. (DLinear) |
| 3 | `deflated_sharpe` | Deflated Sharpe ≥ 0.95 **at the honest `N`** (the true config count, not 1) | Bailey & López de Prado |
| 4 | `cpcv_pbo` | Probability of Backtest Overfitting < 0.5 (combinatorial purged CV) | Bailey et al. |
| 5 | `haircut` | survives the Harvey–Liu multiple-testing haircut | Harvey & Liu |
| 6 | `surrogate` | beats a phase-randomized + block-bootstrap (+ cross-sectional shuffle) null | Theiler et al.; Politis & Romano |
| 7 | `holdout` | out-of-sample slice scored **exactly once** (consume-once vault) | López de Prado |

The three **load-bearing** parts are the honest `N`, the surrogate/placebo control, and the
consume-once holdout. Full methodology in [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md); the
academic bibliography (every gate and every hypothesis mapped to its source) in
[`docs/REFERENCES.md`](docs/REFERENCES.md).

> **The one rule that makes the rest trustworthy: change the target, never the gates.** An empty
> parent pool under this gauntlet means the target lacks edge net of cost — not that the gauntlet
> is too strict.

---

## Two patterns that recur in every round

**Pattern A — the "two-gate" death.** A signal produces a pretty in-sample Sharpe and passes
DSR / PBO / haircut — which only certify *"this Sharpe is not luck-of-selection,"* **not** that it
beats passive holding. It then dies at **baselines** (beat buy-and-hold/random-lottery/linear, net
of cost) and the **consume-once holdout**. The canonical example is **TA4**: its best Bollinger
config passes DSR (p=0.00025), PBO (0.00) and the haircut, then loses to buy-and-hold, random-lottery
and linear, and the holdout flips to Sharpe **−1.01**. The "edge" is filtered long-beta in a bull,
not timing skill. Honest `N` is what makes this bite: deflating by the *true* trial count turned
every "p<0.001" champion into noise (TA3 at N=224 → p=0.21; T10 at N=420 → DSR 0.029; **R3 at
N=5613 → DSR ≈ 9e-12**).

**Pattern B — "true descriptive kernel, no tradeable edge."** Round after round, the underlying
intuition contained a *genuinely true descriptive fact* that still produced **no tradeable,
cost-surviving, out-of-sample edge**: adaptive drift is real (optimal-config autocorr 0.39–0.97)
but not *predictive*; correlation→1 in risk-off is real but the residual timing is *aggregate vol*,
not breadth; dominance is *persistent, not cyclic*; the listing-dump is real but the next cohort
pumped. The **surrogate/placebo control is the hero** — without it, the in-sample WF-B / WF-C / R3
results would have looked like wins.

The full synthesis and academic bibliography are in
[`docs/EDGE_SEARCH_SYNTHESIS.md`](docs/EDGE_SEARCH_SYNTHESIS.md).

---

## Reproduce it yourself (cloud $0)

All data is free and public — Binance / Bybit / OKX public REST (prices, funding, open interest,
basis, depth, listing dates), plus DefiLlama and Coin Metrics Community for the on-chain test.
**No paid feeds, no API keys.** (Universes are coins liquid *today*, so any measured edge is an
upper bound — and it still dies.)

```bash
npm install
npm run typecheck      # tsc --noEmit  → 0 errors
npm test               # vitest run    → the committed gates + harness, all green

# validate any return series / strategy through the full 7-gate gauntlet:
npx tsx scripts/validation/demo-validate.ts   # KILLs a noise series AND the (sub-RF) real carry
```

Validate your own hypothesis with the harness:

```ts
import { validateStrategy } from "./src/lib/validation/strategy-validator";

const result = await validateStrategy(grossReturns, {
  trialCount,                 // the HONEST number of configs you searched — not 1
  cost: { roundTripBps: 8 },  // charged on every position change
  surrogate: { iterations: 200, crossSectional: false },
});
console.log(result.verdict, result.bindingGate);   // "KILL" | "SURVIVE", and which gate decided
```

See [`docs/REPRODUCIBILITY.md`](docs/REPRODUCIBILITY.md) for the per-round script index, and
[`docs/VALIDATION_HARNESS.md`](docs/VALIDATION_HARNESS.md) for the harness API.

---

## Repository map

| Path | What's there |
|---|---|
| [`docs/`](docs/) | The full documentation set — start at [`docs/README.md`](docs/README.md) |
| `docs/RESULTS.md` | Canonical record of all 28 hypotheses (master table + per-round narrative) |
| `docs/METHODOLOGY.md` | The 7-gate anti-overfitting gauntlet, explained |
| `docs/EDGE_SEARCH_SYNTHESIS.md` | The synthesis + full academic bibliography |
| `docs/REFERENCES.md` · `docs/REPRODUCIBILITY.md` | Bibliography · reproduce-it guide |
| `docs/ONCHAIN_FEASIBILITY.md` | The $0 on-chain data feasibility scout (→ test OC1) |
| `docs/VALIDATION_HARNESS.md` | The reusable `validateStrategy()` API |
| `src/lib/validation/` | The harness — `validateStrategy()` |
| `src/lib/significance/`, `src/lib/statistical-validation.ts` | The committed gates (DSR, CPCV/PBO, haircut, SPA, holdout, baselines) |
| `src/lib/reorientation/` | The hypothesis building blocks (momentum, carry, regime, multi-timeframe) |
| `scripts/` | The edge-search audits, one per round/hypothesis |

---

## License

MIT — see [`LICENSE`](LICENSE). Copyright © 2026 Kim Lage.

*A negative-results map and a reusable anti-overfitting validation harness. Change the target,
never the gates.*
