# AGENTS.md — operating guide for crypto-edge-search

> **This repo is agent-ready.** It is a public **falsification lab**: a $0, reproducible body of
> evidence about which crypto trading techniques actually survive an honest anti-overfitting gauntlet
> (so far, across ~111 hypotheses, **none** clear it to a deployable edge). The durable asset is the
> **methodology**, not a strategy. This file tells a human or an AI agent how the repo is laid out, how
> the validation framework works, and the **non-negotiable rules** for using it. Read it before
> proposing, testing, or "reviving" any strategy.

## The one rule

> **Change the target, never the gates.** A strategy is promoted only if it passes the *full* gauntlet
> on data it never saw. If you think a gate is wrong, make it **stricter** and re-run everything — never
> looser. Loosening a gate to manufacture a "SURVIVE" defeats the entire purpose of the project.

## Conventions

- **English only.** Everything in this repository is in English — documentation, code, comments,
  identifiers, commit messages, issues, and pull requests. This is a public, shareable project; keep it
  English so anyone can read it, run it, and contribute.
- **$0 / free public data only.** No paid feeds, no API keys on the core path, no cloud spend. If a
  hypothesis genuinely needs paid data, mark the result `DEFERRED` and test the best free proxy.
- **Honest both ways.** Report a KILL as loudly as a SURVIVE, and never manufacture either. A well-run
  KILL is a contribution.

## Quick start

```bash
npm install
npm test          # the committed gates + their unit tests — must be green before you start
npm run typecheck # tsc --noEmit over src/ (the gates); the scripts/edgehunt-* run under tsx
npx tsx scripts/edgehunt-D5/harness.ts   # a per-domain gauntlet harness (the canonical reference)
```

All work runs at **$0** on free public data (Binance / Bybit / OKX public REST, Coin Metrics Community
no-key, Deribit public DVOL, DefiLlama, FRED no-key CSV, stooq, alternative.me, Google Trends, GDELT).
No paid data, no cloud spend, no API keys for the core path.

## Repository layout

| Path | What it is |
|---|---|
| `src/lib/statistical-validation.ts` | The self-contained **gate primitives** — `computeDeflatedSharpeRatio`, `estimateCscvPbo`, `blockBootstrapConfidenceInterval`, `summarizeReturnSeries`, `computeProbabilisticSharpeRatio`. |
| `src/lib/significance/*` | The composable gates: `trial-count`, `holdout`, `spa`, `haircut`, `baselines`, `cpcv-paths`, `promotion-evaluator`. |
| `src/lib/validation/strategy-validator.ts` | **`validateStrategy()`** — the single-call wrapper that composes every gate. The convenience public API. |
| `src/lib/training/statistical-validation.ts` | A re-export shim of the primitives (the path the 2026-06 edge-search scripts import). |
| `src/lib/reorientation/*` | Strategy building blocks used by the prior-round audits (funding carry, TS/XS momentum, regime, turnover). |
| `scripts/audit-*.ts` | The prior-round hypothesis audits (TA, momentum, pairs, carry, seasonality, …). |
| `scripts/edgehunt-*/` | The **2026-06 domain campaign** — per-domain harnesses (`runGauntlet`), data fetchers, and one script per hypothesis test, plus the two-layer audit. |
| `output/edgehunt-*/SUMMARY.md` | The per-domain **result ledgers** (the evidence). Large raw data caches are gitignored and regenerable via the fetchers. |
| `docs/` | The wiki — see **Documentation** below. |
| `.claude/skills/` | **Operating skills** (agent-invokable procedures): `test-hypothesis`, `audit-result`, `reproduce-result`. |

## The validation framework (the gauntlet)

Every hypothesis is judged by the **same committed gauntlet, in this binding order** (the *binding gate*
is the first failure):

```
net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout
```

- **SURVIVE** = passes all gates on data it never saw.
- **PROMISING** = passes net-of-cost + baselines + surrogate + holdout, but trips a multiple-testing / Deflated-Sharpe gate.
- **KILL** = fails a gate.
- **DEFERRED** = needs paid data; test the best free proxy and mark it.

Call it directly with the primitives + a per-domain `runGauntlet` wrapper (see `scripts/edgehunt-D5/harness.ts`),
or with the one-call `validateStrategy()` in `src/lib/validation/strategy-validator.ts`.

## The committed RULES (read before testing anything)

These were learned the hard way across the campaign; violating them is how a mirage passes:

1. **Net-of-cost is mandatory.** Charge taker ~4 bps/side on **every** position change. Charge
   financing/borrow on the **FULL levered/short notional, not 1 unit** — an uncharged-borrow leak
   collapsed a "Sharpe 1.64" carry to 0.69 and is the single most common inflation in any short/levered book.
2. **Use the right baseline.** Buy-&-hold **and**, for any timing/overlay strategy, a **matched-exposure**
   benchmark (a low-exposure long/flat overlay cannot out-Sharpe 100%-long B&H, so scoring it only vs B&H is
   an artifact). For cross-sectional books, require **beta-neutrality** (book β≈0, alpha-t on the residual)
   using an **honest out-of-sample** hedge beta, never an in-sample over-hedge.
3. **Honest N counts every config you tried.** A "pre-registered" config must be **frozen from mechanism
   BEFORE any neighborhood search** — never the argmax of a searched grid. Apply Deflated Sharpe @ honest N,
   CPCV/PBO < 0.5, and the Harvey–Liu haircut (often the true binding gate).
4. **The surrogate must be FAMILY-WISE.** For a searched grid, use the **family-wise MAX-statistic** null
   (re-run the whole grid on each surrogate, take the grid-max), **not** the single-best-config p. A
   single-config surrogate p over a searched grid is the recurring trap that masqueraded as an edge in three
   separate leads — each flipped to KILL under the family-wise null.
5. **A surrogate PASS proves structure, not magnitude.** It shows the structure/sign is non-random — it does
   **not** show the realized mean is positive-with-significance at honest N on unseen data. That gap is exactly
   the PROMISING/SURVIVE boundary, and no lead has crossed it.
6. **Pick the null for the claim:** time-series timing → phase-randomization / block bootstrap; rotation /
   relative-value → cross-sectional shuffle; path-dependent exits (TP/SL) → bracket-on-surrogate; vol-clustering
   → GARCH-simulated zero-edge; variance-risk-premium → shuffled-VRP placebo; calendar/event → calendar-reanchor
   + family-wise MAX-stat; macro/sentiment → AR(1)-matched placebo.
7. **Beware the too-powerful surrogate.** A vol/spectrum-preserving surrogate of a long-flat price-transform
   overlay can *inflate* shared long-beta — judge such overlays on the long-beta-**differenced** lift, not the
   raw surrogate Sharpe.
8. **No tautological metrics.** `sharpe(OLS residuals)` is ~0 *by construction* — use `sharpe(y − β·x)` for
   beta-hedged alpha. Enforce the **h=0 leakage gate**: report the contemporaneous ceiling, then require the
   strictly-lagged (h≥1) leg to clear the gates **alone**.
9. **Consume-once holdout, once.** Survivorship-biased panels (delisted names absent) make even the holdout an
   upper bound — rebuild the universe point-in-time before any promotion.

## Testing a new hypothesis (the procedure)

Genuinely try to make it work, then judge it honestly. Use the `test-hypothesis` skill, or by hand:

1. State the academic prior + the mechanism. Pick the **right null** (Rule 6).
2. Build the **strongest honest** version (sound causal signal, sensible params). Lag features h≥1.
3. If it shows promise, strengthen it (regime conditioning, vol-target, better exits) — then **count every
   config in honest N**.
4. Run the full gauntlet (`runGauntlet` / `validateStrategy`) with realistic cost (Rule 1) and the right null.
5. Report a one-line verdict: `VERDICT: <SURVIVE|PROMISING|KILL|DEFERRED> | net Sharpe | binding gate | honest N | surrogate p | monthly@$100k | confidence`.
6. If it looks PROMISING, **adversarially audit it** (`audit-result` skill): re-run the family-wise surrogate,
   re-charge financing on the full notional, check the "pre-registered" config is not the grid argmax. Most
   apparent edges die here.

## Reproducing a result

Raw data caches under `output/` are gitignored (regenerable). Use the `reproduce-result` skill, or: run the
per-domain fetcher (e.g. `scripts/edgehunt-D2/fetch-data.ts`) to download the $0 data, then run the harness
(`scripts/edgehunt-*/...`). The per-domain `output/edgehunt-*/SUMMARY.md` is the verdict to reproduce or refute.

## Documentation

- [`docs/README.md`](docs/README.md) — docs index + reading order.
- [`docs/RESULTS.md`](docs/RESULTS.md) — the full ~111-hypothesis ledger (the centerpiece).
- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — the gauntlet + the right-null-per-claim table + the RULES.
- [`docs/EDGE_SEARCH_SYNTHESIS.md`](docs/EDGE_SEARCH_SYNTHESIS.md) — the narrative map: where the edge is *not*.
- [`docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md`](docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md) — the 2026-06 campaign roll-up + the two-layer audit.
- [`docs/REFERENCES.md`](docs/REFERENCES.md) — annotated bibliography (every gate and hypothesis → paper).
- [`docs/REPRODUCIBILITY.md`](docs/REPRODUCIBILITY.md) — $0 data sources + the fetch→run flow.
- [`docs/VALIDATION_HARNESS.md`](docs/VALIDATION_HARNESS.md) — the gates API.
- [`docs/ONCHAIN_FEASIBILITY.md`](docs/ONCHAIN_FEASIBILITY.md) — on-chain $0 feasibility + results.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — 155 referenced hypotheses for future tests.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute (a well-run KILL is a contribution).

## Honest framing

For an individual at retail cost, speculation behaves far more like a game of chance than a consistent way to
make money. This repo is the evidence — and a standing invitation to break it. If your setup truly survives the
*full* gauntlet on unseen data, open a PR; that would be a real finding.

*License: MIT (see [`LICENSE`](LICENSE)).*
