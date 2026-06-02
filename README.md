# crypto-edge-search — a public falsification lab for crypto trading edge

> **Philosophy.** This is a falsification lab, not a strategy shop. We do not look for a story
> that fits a backtest; we try to **break** every technique with the same committed
> anti-overfitting protocol, and we publish whatever survives **and** whatever dies. A clean
> backtest is a starting point, not evidence. The working hypothesis the data keeps confirming:
> **for an individual at retail cost, speculation behaves far more like a game of chance than a
> consistent way to make money.**

Across the life of this project, **~111 hypotheses** spanning the full retail/quant arsenal were
pushed through one committed statistical gauntlet on **free public data at $0** — direction
prediction, classic and microstructure TA, cross-sectional / relative-value, on-chain, carry,
volatility-risk-premium, sentiment, macro, calendar, and adaptive re-fitting of all of the above.
After deepening and an independent two-layer audit, the audited final state is:

- **0 clean SURVIVE.** Nothing is deployable.
- **2 weak PROMISING** leads, both beta-neutral or structural, both stopped at the
  PROMISING/SURVIVE boundary by honest-N magnitude significance on unseen data, both carrying a
  financing caveat.
- **Everything else KILL** — a large, reproducible body of honest negative evidence.

**The durable deliverable is not a strategy. It is the methodology — a gauntlet that does not lie
— plus an unusually honest record of negative results.**

---

## Headline (audited 2026-06)

| | |
|---|---|
| Hypotheses tested | **~111** across **8 domains** (~35 prior rounds + 58 in the 2026-06 domain campaign + 18 new $0 backlog) |
| Data / cloud cost | **$0** — free public exchange + on-chain + macro APIs only |
| Clean SURVIVE | **0** |
| Weak PROMISING | **2** (XS Donchian L/S; dated-futures basis carry, unlevered-thin) |
| KILL | the rest (~109) |
| Deployed capital | **none** |

The two PROMISING leads are explicitly **not** investable today:

1. **Cross-sectional Donchian channel-position long-short** — genuinely beta-neutral; the
   structure is real (cross-sectional-shuffle null **p=0.009**, positive across every channel
   window and every holdout quarter). But on the 388-row consume-once holdout the **magnitude is
   indistinguishable from zero** (DSR@N=1 = **0.79**, Newey-West t(mean) = **0.96**, block-
   bootstrap mean CI-lower < 0), and once borrow is charged on the continuous ~1.0× short notional
   the out-of-sample Sharpe erodes to a **range ~0.3–0.5**. Held back by honest-N Deflated Sharpe
   at the full searched grid + survivorship-biased panel.
2. **Dated-futures basis carry (unlevered-thin only)** — a thin **real** market-neutral excess
   of **~4.9%/yr (t=2.41)**, which sits **below every multiple-testing bar**. The levered headline
   was a **financing-leak artifact**: the script charged the risk-free rate on 1 unit but borrow on
   a ~2.95×-levered notional; correcting it collapses the levered series (DSR ~0.13). It remains a
   regime-dependent, sub-risk-free carry trade.

---

## Results by domain

Eight domains, each genuinely trying to *find* edge before judging honestly. Per-domain
write-ups (binding gate + the decisive number for every hypothesis) live next to their scripts in
[`output/edgehunt-*/SUMMARY.md`](output/).

| Domain | What was tested | Verdict |
|---|---|---|
| Consensus / carry-arb | funding carry, cross-venue funding dispersion, perp-spot cash-and-carry, dated-futures basis, residual momentum, PCA stat-arb, vol-targeting | all KILL except the thin **unlevered dated-futures basis** (weak PROMISING) |
| D1 — indicators & price action | Supertrend, CCI, candlestick reversals, XS Ichimoku, XS Bollinger %b, **XS Donchian** | all KILL except **XS Donchian L/S** (weak PROMISING) |
| D2 — volume & microstructure | CVD divergence, taker ratio, anchored-VWAP, volume-profile POC, OBV, Amihud, whale prints, liquidation fade | all KILL at h≥1 (edge lives only in the h=0 tautology); L2 family deferred (needs paid data) |
| D5 — on-chain / crypto-native | exchange reserve-depletion / netflow, Hash Ribbons, MVRV-Z, Stock-to-Flow, SSR, Puell, realized-price S/R, Metcalfe residual | all KILL (reserve-depletion was flipped PROMISING → KILL by the audit) |
| D6 — sentiment / cross-asset / macro | rates & 2s10s, real-yield "digital gold", news-tone, Fear & Greed, Google Trends, net-liquidity / M2, put/call | all KILL (the coincident-beta trap) |
| D7 — calendar & event | four-year halving cycle, stablecoin mint-as-event, funding-settlement timing, sell-in-May, day-of-week, turn-of-month, CME gap-fill | all KILL |
| D3 / D4 / D8 remainder | dual momentum, pairs (GGR), short-term reversal, GARCH/EGARCH vol-timing, frog-in-the-pan, squeeze, risk-parity, rebalancing premium | all KILL; dealer-GEX / option-skew deferred (needs paid chains) |
| New $0 backlog (quant + on-chain) | regime timers, acceleration momentum, **Q9 low-vol anomaly**, fee-revenue **O3 NVT**, network-activity, price transforms | all KILL (Q9 and O3 were provisional PROMISINGs the audit flipped to KILL) |

---

## Why a clean backtest is not evidence

Almost everything published in quant trading claims to have found edge, and the
survivorship/overfitting machinery that manufactures those claims is exactly what this project was
built to defeat. A pretty in-sample Sharpe is the *cheapest* thing in markets. In this campaign
the recurring ways a clean-looking backtest turned out to be nothing were:

- **Coincident long-beta in disguise.** A long-flat or long-short overlay on a secularly rising
  asset posts a 1.6–1.8 Sharpe and a real-looking monthly P&L that is just timed BTC (or risk-on)
  exposure — and loses to buy-and-hold once you deflate and match exposure.
- **The h=0 tautology.** Order-flow "signals" whose entire Sharpe lives in the *contemporaneous*
  bar (the trades *are* the move); the strictly-lagged (h≥1) component is ~0.
- **Selection inflation under honest N.** A grid-best that evaporates once Deflated Sharpe and the
  Harvey-Liu haircut count **every** config tried, and/or sign-flips on data the search never saw.

The bar is never "positive standalone." It is **incremental over the right baseline, after
deflation, on unseen data** — and almost nothing clears it.

---

## The gauntlet

Every hypothesis must clear **all** gates, in this binding order (the binding gate is the *first*
failure). Implemented as `runGauntlet()` in
[`scripts/edgehunt-D5/harness.ts`](scripts/edgehunt-D5/harness.ts), composed from the committed
primitives (`computeDeflatedSharpeRatio`, `estimateCscvPbo`, `blockBootstrapConfidenceInterval`,
`summarizeReturnSeries`) in
[`src/lib/training/statistical-validation.ts`](src/lib/training/statistical-validation.ts):

```
net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout
```

- **net_of_cost** — taker ~4 bps/side on every position change; financing/borrow charged on the
  **full** levered/short notional, never 1 unit.
- **baselines** — buy-and-hold **and** a matched-exposure benchmark **and** a random-lottery
  control; for cross-sectional books, beta-neutrality with an honest-OOS hedge.
- **deflated_sharpe @ honest N** — Deflated Sharpe counting every config tried.
- **block_bootstrap CI**, **CPCV / PBO < 0.5**, **Harvey-Liu haircut** (often the true binding
  gate).
- **the right surrogate null per claim** — time-series → phase-randomization / block-bootstrap;
  relative-value → cross-sectional shuffle; vol-clustering → GARCH-simulated; VRP → shuffled-VRP
  placebo; calendar/event → calendar-reanchor; **and for any searched grid, the family-wise
  MAX-statistic, not a single-best-config p**.
- **consume-once holdout** — data the search never saw, spent exactly once.

**SURVIVE** = all pass. **PROMISING** = passes net + baselines + surrogate + holdout but trips a
multiple-testing / Deflated-Sharpe gate. Otherwise **KILL**.

### The family-wise-surrogate lesson

The audit's single most important finding: a two-layer independent review **flipped three earlier
PROMISINGs to KILL** — BTC exchange reserve-depletion, the Q9 cross-sectional low-vol anomaly, and
the O3 fee-revenue NVT signal — all on the **same defect**. Each ran its surrogate null on only
the single in-sample-selected, grid-best config, with **no family-wise correction**. The correct
null for a *searched* family is the **family-wise MAX-statistic** over the whole grid; under it the
surrogate gate fails (e.g. reserve: harness single-config p=0.013 → family-wise **p≈0.24**, real
best 0.994 < surrogate-95 ≈1.19), and each lead also fails honest-N Deflated Sharpe at the full
grid (Q9 0.476 @ N=96; O3 0.894 @ N=312). The audit also caught a **systemic financing leak** —
zero borrow charged on the levered/short notional — that inflated the carry headlines.

**The meta-conclusion:** a right-null surrogate **PASS** proves the *structure/sign* is
non-random — it does **not** prove the realized *mean is positive-with-significance at honest N on
unseen data*. That gap **is** the PROMISING/SURVIVE boundary, and **no lead crossed it.** No
false-KILL was found anywhere; the conservative "nothing deployable" verdict is, if anything,
*stronger* than first reported. The two prior carry "survivors" (perp funding carry,
dated-futures basis) remain sub-risk-free regime trades.

---

## $0 and reproducible

Everything runs at **$0** on free public data — Binance / Bybit / OKX public REST, Coin Metrics
Community (no key), Deribit public DVOL, FRED no-key CSV, alternative.me Fear & Greed, Google
Trends, GDELT. The stack is **TypeScript**, executed with **tsx**. The gates are pure and
deterministic (seeded). Realistic cost (~4 bps/side taker) is charged on every position change,
honest N counts every config tried, and each consume-once holdout is spent exactly once. Inputs
are reused from on-disk caches under `output/`, so every result re-derives without paid
infrastructure.

```bash
./node_modules/.bin/tsx scripts/edgehunt-D5/harness.ts
```

---

## Documentation

| Document | What it is |
|---|---|
| [docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md](docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md) | The audited cross-domain roll-up — the two PROMISING leads in detail, the full KILL ledger by domain, the deepening + two-layer audit, and the methodology lessons. |
| [docs/BACKLOG.md](docs/BACKLOG.md) | The research backlog — testable hypotheses across the 8 domains, each with its right surrogate null, honest-N concern, the control that separates real edge from long-beta, and references. |
| [`output/edgehunt-*/SUMMARY.md`](output/) | Per-domain syntheses: the binding gate and decisive number for every hypothesis, so any verdict can be challenged or revived against the *same* gates. |
| [`output/edgehunt-audit/SUMMARY.md`](output/edgehunt-audit/SUMMARY.md) · [`output/edgehunt-audit-nb/SUMMARY.md`](output/edgehunt-audit-nb/SUMMARY.md) | The independent two-layer methodology audit that flipped three PROMISINGs to KILL. |
| [`scripts/edgehunt-D5/harness.ts`](scripts/edgehunt-D5/harness.ts) · [`src/lib/training/statistical-validation.ts`](src/lib/training/statistical-validation.ts) | The harness `runGauntlet()` wrapper and the committed gate primitives it chains. |

---

## Contributing

Contributions are welcome — especially **falsifications**. A **KILL is a valid, valuable
outcome**: the asset here is the refusal to manufacture a survivor.

To propose or revive a hypothesis, run it through the **same** committed gauntlet
(`runGauntlet()` in [`scripts/edgehunt-D5/harness.ts`](scripts/edgehunt-D5/harness.ts)) and report
the **binding gate + the decisive number**, with the **right surrogate null for the claim** (and a
**family-wise MAX-statistic** if you searched a grid), honest N counting every config, and a
consume-once holdout spent exactly once. Pick the next target from
[docs/BACKLOG.md](docs/BACKLOG.md); match every claim to its surrogate null, baseline, and an
honest prior. To challenge an existing verdict, re-derive its number from the committed primitives
and show which gate it actually binds on.

---

## License

MIT.
