# Crypto Edge Search — a rigorous, anti-overfitting hunt for tradeable edge

A rigorous, anti-overfitting search for tradeable edge in crypto. **28 hypotheses were
tested at full statistical rigor on real, free public data; 26 were killed; 2 sub-risk-free
carry "survivors" are real but sub-risk-free in the current regime.** The headline numbers (a +6–7%
APR carry, lovely in-sample Sharpes on technical-analysis and cross-sectional ideas) all
collapsed once they faced realistic cost, an honest trial count, surrogate/placebo controls,
and a consume-once holdout. The direction-prediction and technical-analysis priors were never
the edge — and the gates correctly refused to promote noise. **The durable output of this
project is not a strategy; it is the validation methodology** — a reusable gauntlet that does
not lie, and an unusually honest record of negative results.

---

## Key results

- **28 hypotheses tested → 26 KILL, 2 sub-risk-free carry survivors** (perp funding carry and
  dated-futures basis). The survivors passed every full-sample gate but have **decayed below the
  risk-free rate** in the 2025–2026 regime — they paid only in the one-off 2024 funding blowout.
  The 28th test — an on-chain distribution-pressure POC (exchange-flow + MVRV, BTC+ETH, the only
  genuinely new data class) — was the most recent KILL.
- **The edge is NOT in direction prediction or technical analysis.** Every prediction,
  TA/indicator, cross-sectional / relative-value, seasonality, and capital-rotation idea died —
  **fixed and adaptive** (walk-forward re-fitting was tested too, and failed the same way).
- **The two-gate death pattern.** A signal produces a pretty in-sample Sharpe and *passes*
  Deflated Sharpe / PBO / Harvey-Liu haircut — gates that only certify "this Sharpe is not
  luck-of-selection." It then dies at the two gates that test *real economic edge*:
  **baselines** (beat buy-and-hold + random-lottery + a one-layer linear model, net of cost) and
  the **consume-once holdout** (data the search never saw). This is where the prediction edges
  died, one after another.
- **The surrogate / placebo control is the hero.** Phase-randomized and block-bootstrap nulls
  preserve each series' volatility and autocorrelation but destroy genuine regime/cross-asset
  structure. When an adaptive or evolved strategy scores *as well on the surrogate as on real
  data*, it is fitting noise, not tracking edge — and several candidates that looked like
  in-sample wins were exposed exactly this way. A **cross-sectional-shuffle** null (added for the
  capital-rotation round) further proved the apparent "rotation edge" was aggregate volatility
  state, not cross-asset breadth.
- **Cloud spend $0, on free public data.** Every run uses free public exchange APIs
  (Binance / Bybit / OKX public REST); no paid infrastructure, no proprietary data.

---

## What's here

| Document | What it is |
|---|---|
| [docs/RESULTS.md](docs/RESULTS.md) | The honest tally — all 28 hypotheses, their verdicts, and what killed each one. |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | The anti-overfitting gauntlet: the committed gates, the surrogate/placebo controls, honest trial count `N`, and the consume-once holdout. |
| [docs/REFERENCES.md](docs/REFERENCES.md) | Bibliography — every gate and every tested hypothesis mapped to its peer-reviewed (or working-paper) academic source. |
| [docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md) | How to re-run it: data sources, TypeScript/tsx setup, and the scripts behind each result. |
| [docs/EDGE_SEARCH_SYNTHESIS.md](docs/EDGE_SEARCH_SYNTHESIS.md) | The durable synthesis — the map of what the search learned, where the edge is *not*, and why carry is a regime trade rather than a business. |

The reusable harness that composes the gates into one API is documented in
[docs/VALIDATION_HARNESS.md](docs/VALIDATION_HARNESS.md)
(`src/lib/validation/strategy-validator.ts`, with a smoke-run at
`scripts/validation/demo-validate.ts`).

---

## Why this is useful even though it's mostly negative results

Honest, rigorously-controlled negative results are rare in quantitative trading — almost
everything published claims to have found edge, and the survivorship/overfitting machinery that
manufactures those claims is exactly what this project was built to defeat. So there are two
durable contributions here. First, a **clean negative map**: a documented, reproducible record
of which standard academic priors (time-series and cross-sectional momentum, reversal,
volatility-managed trend, classic and microstructure TA, pairs/cointegration, seasonality,
capital rotation, event flow, and *adaptive re-fitting of all of the above*) do **not** survive
realistic cost and out-of-sample testing in crypto — so a future researcher does not re-walk
dead ground. Second, and more important, a **reusable validation harness**: the committed gates
plus surrogate/placebo controls, an honest trial count, and a consume-once holdout, packaged
into a single `validateStrategy(...)` call. It killed lovely in-sample Sharpes that any naive
backtest would have promoted. **A KILL is a valid, valuable outcome** — the asset is the refusal
to manufacture a survivor.

---

## Reproducibility & cost

Everything runs on **free public exchange APIs** (Binance / Bybit / OKX public REST) with **$0
cloud spend**. The stack is **TypeScript**, executed with **tsx** (`npx tsc --noEmit` = 0
errors); the gates are pure, deterministic (seeded), and require no paid infrastructure. See
[docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md) for the exact scripts and data-fetch steps
behind each result.

---

## License

MIT (see [LICENSE](LICENSE)).
