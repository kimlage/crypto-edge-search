# Reproducibility — how a stranger re-runs this

> **Purpose.** This document lets anyone reproduce the edge-search program from scratch:
> the data, the environment, a worked validation example, and an index of every audit
> script. The program tested **28 crypto trading hypotheses** through an anti-overfitting
> validation harness; **26 were KILLED** and **2 structural-carry "survivors"** are real
> but **sub-risk-free in the current regime** (see `docs/EDGE_SEARCH_SYNTHESIS.md` for the
> tally and `docs/EVOLUTION_TRAINING_LOG.md` for the chronological lab record). The
> durable asset is the **methodology** — committed gates + surrogate/placebo controls +
> an honest trial count `N` + a consume-once holdout — packaged as
> `validateStrategy()` in `src/lib/validation/strategy-validator.ts` and documented in
> `docs/VALIDATION_HARNESS.md`.
>
> **License: MIT (see [`../LICENSE`](../LICENSE)).**

---

## 1. Data — every source is free and public (cloud spend $0)

Every number in this program comes from **free, public** market data. **No paid feeds,
no API keys, no authentication, and no cloud compute were required** — all fetches hit
unauthenticated public REST endpoints, and the cloud bill for the entire edge search was
**$0**. The fetched panels are committed under `output/` so the analysis is reproducible
even without re-fetching.

### Public REST endpoints used

| Domain | Host(s) | What was pulled | Used by |
|---|---|---|---|
| Binance spot/USDⓈ-M | `api.binance.com`, `fapi.binance.com`, `dapi.binance.com`, `data-api.binance.vision` | Daily klines (prices), 8h perpetual funding rates, dated-futures (quarterly) basis, `exchangeInfo` `onboardDate` (listing events), daily quote-volume, order-book depth, open interest | E1–E3, T1–T10, TA1–TA4, WF-A–D, R2–R4, C1–C4, carry D1–D4 |
| Bybit | `api.bybit.com` | 8h perpetual funding rates (multi-venue cross-check) | Carry round 2 (D1) |
| OKX | `www.okx.com` | 8h perpetual funding rates (multi-venue cross-check) | Carry round 2 (D1) |

The Binance/Bybit/OKX endpoints above are the data sources behind verdicts **E1–C4**. The
**28th test (OC1)** additionally uses **Coin Metrics Community** (`community-api.coinmetrics.io`,
no key, daily, full history) for BTC+ETH exchange in/out flow (native units) and MVRV; this is
free and unauthenticated, so cloud spend stays **$0**. (The earlier `scripts/onchain-scout/`
probes reference several other vendor hosts — CoinGecko, DefiLlama, Glassnode, Messari, Dune,
Etherscan, The Graph, etc. — but those were preliminary on-chain *feasibility probes*; most of
those vendors gate the useful series behind a paid key, which is exactly why both the core edge
search and the OC1 POC stayed on free, no-key data.)

### Committed panels (so you do not have to re-fetch)

| Path | Contents | Provenance |
|---|---|---|
| `output/funding/` | 8 majors: 8h funding (`*_funding_8h.json`, 3288 rows each ≈ 3y) + daily prices (`*_prices_daily.json`) + `manifest.json` | Binance public REST, fetched 2026-05-31, window 2023-06-01 → 2026-05-31 |
| `output/carry/` | Multi-venue funding (`bybit_*`, `okx_*`), depth snapshots, OI, `market-structure.json`, plus the round-2 cost/capacity/tail reports | Binance + Bybit + OKX public REST |
| `output/dated-futures/` | Quarterly futures basis panel | Binance dated-futures (`dapi`) public REST |
| `output/crossxs/`, `output/r2-illiquid/`, `output/c1-rotation/`, `output/front-c2/`, `output/front-c3/` | 30-coin / small-cap / volume panels for the cross-sectional and rotation rounds | Binance public REST |
| `output/front-c4/` | Listing-event panel (~644 dated USDT-perp listings via `onboardDate`, **including delisted/settling symbols**) | Binance Futures `exchangeInfo` + first-60-day klines |

> Each fetched panel carries a `manifest.json` (or an equivalent header) recording the
> source string (e.g. `"source": "binance_public_rest"`), the fetch timestamp, the
> requested window, and per-symbol row counts. Read it to confirm provenance.

### Survivorship caveat (read this before trusting any in-sample number)

The cross-sectional universes (30-coin, small-cap, rotation tiers) are **the coins that
are liquid *today***. Coins that delisted or died are not in the daily-close panels, so
every cross-sectional/relative-value in-sample result is an **upper bound** —
survivorship inflates it. The verdicts already account for this: the survivorship-biased
in-sample numbers were all **killed out-of-sample** anyway, and the synthesis flags the
universes as upper bounds. The one place where delisted names *were* deliberately
retained is the **C4 listing event study** (the `onboardDate` panel keeps SETTLING /
delisted symbols), so the listing-event result has **no survivorship bias on the event
itself** — and it was still a KILL.

---

## 2. Environment

- **Language:** TypeScript. The committed gates live in `src/lib/training/` (the
  individually-tested anti-overfitting primitives) and the composed harness lives in
  `src/lib/validation/strategy-validator.ts`. Validation/audit scripts are TypeScript
  (`.ts`) or Node ESM (`.mjs`).
- **Runtime:** Node.js, with TypeScript scripts run directly via
  [`tsx`](https://github.com/privatenumber/tsx) (no build step). `tsx` is a dev
  dependency (`package.json` → `"tsx": "^4.x"`); after `npm install` it is at
  `node_modules/.bin/tsx`.
- **Type check:** the whole program type-checks clean — `npx tsc --noEmit` reports
  **0 errors**.

### Install

```bash
npm install
```

### Exact invocation pattern (how every audit/validation script is run)

TypeScript scripts are executed with `tsx` from the **repo root**. If your environment
pins a bundled Node runtime, put its `bin/` directory on `PATH` first so `tsx` finds a
consistent Node:

```bash
PATH=/path/to/node/bin:$PATH \
  ./node_modules/.bin/tsx <script-path>
```

If you have a normal Node on your `PATH` already (Node 18+), the prefix is unnecessary
and the portable invocation is simply:

```bash
npx tsx scripts/validation/demo-validate.ts        # or any scripts/.../*.ts
node scripts/fetch-funding-rates.mjs               # the .mjs fetchers run on plain Node
```

`.mjs` fetch scripts (e.g. `scripts/fetch-funding-rates.mjs`) run under plain `node`.
Scripts write their machine-readable results into the matching `output/<round>/`
directory.

### Tests

```bash
npm test        # vitest run — unit tests for the gates and reorientation cores
```

---

## 3. How to validate a strategy — worked example

`validateStrategy()` (in `src/lib/validation/strategy-validator.ts`) composes the seven
committed gates into one ordered gauntlet and returns a structured verdict. You feed it a
**gross per-period return series** (or a `() => number[]` producing one); the harness
charges realistic cost itself, runs the gates in order, and reports the **first failing
gate as the binding constraint**. A `KILL` is a valid, valuable outcome — the gates do
not manufacture survivors.

```ts
import { validateStrategy } from "@/lib/validation/strategy-validator";

// grossReturns: the strategy's GROSS per-period return series (cost is applied inside).
// position:     per-period exposure in [-1, 1], same length — turnover is derived from it.
const verdict = validateStrategy(grossReturns, {
  // HONEST N — the TRUE number of distinct configs you searched (from your trial ledger).
  // This is REQUIRED and ≥ 1; feeding N=1 silently skips the deflation. Pass the real N.
  trialCount: 224,

  statistic: "compoundReturn",                 // net P&L (the cost-realism default)

  // Cost: 4 bps/side perp ⇒ 8 bps round-trip, charged on |Δposition| every change.
  cost: { takerPerSide: 0.0004, position },

  // Baselines the edge must beat NET of cost (buy-and-hold + equal-weight + linear;
  // a random-lottery baseline is generated internally from marketReturns + turnover).
  baselines: { marketReturns, equalWeightReturns, linearReturns },

  // Surrogate / placebo null (the methodological hero): phase-randomized + block-
  // bootstrap, plus an optional cross-sectional shuffle for rotation/lead-lag tests.
  surrogate: { iterations: 200, crossSectional: true, panel: { assetReturns } },

  // Consume-once holdout: a final most-recent slice, scored EXACTLY once.
  holdout: { holdoutFraction: 0.15, testFraction: 0.15 },
});

verdict.verdict;       // "PASS" | "KILL"
verdict.bindingGate;   // the first gate that failed (the binding constraint) | null
verdict.perGate;       // every gate's { id, passed, reason, detail }, in order
verdict.netStats;      // net-of-cost summary incl. turnover + grossSharpe
verdict.trialCount;    // the honest N actually used for DSR / haircut
```

**Gate order** (the first failing gate binds):

1. `net_of_cost` — turnover-aware net return; a gross-only signal is an automatic KILL.
2. `baselines` — beat buy-and-hold + equal-weight + random-lottery + one-layer linear.
3. `deflated_sharpe` — Deflated Sharpe probability ≥ bar **at the honest `trialCount`**.
4. `cpcv_pbo` — Probability of Backtest Overfitting `< 0.5` (flags `<8` folds degenerate).
5. `haircut` — Sharpe survives the Harvey-Liu multiple-testing haircut.
6. `surrogate` — real edge must beat the phase + block (+ optional cross-sectional) null.
7. `holdout` — out-of-sample slice scored exactly once.

### Runnable demo

A self-contained smoke-run is committed at **`scripts/validation/demo-validate.ts`**. It
runs `validateStrategy()` on three series and writes
`output/validation/demo-validate-report.{json,txt}`:

1. **REAL** — equal-weight perp funding carry over the 8 majors, built from
   `output/funding/`. In the current regime this **KILLs** (carry has decayed sub-RF) —
   the honest, expected outcome.
2. **NOISE** — a seeded Gaussian series. Must **KILL** (the surrogate/holdout/baseline
   gates refuse to certify noise).
3. **AR(1) artifact** — a series whose only "structure" is autocorrelation a surrogate
   reproduces; demonstrates the surrogate gate catching what the cheaper gates miss.

Run it:

```bash
npx tsx scripts/validation/demo-validate.ts
```

It exits non-zero if the harness fails to run all 7 gates or fails to KILL the noise; on
success it prints `SMOKE PASSED`.

---

## 4. Scripts index — audit scripts by round

Each row is one audit/run script, what it tests, and the machine-readable JSON it writes
under `output/`. Hypothesis IDs (E*, T*, TA*, WF-*, R*, C*) map to the tally in
`docs/EDGE_SEARCH_SYNTHESIS.md` §1 and the chronological detail in
`docs/EVOLUTION_TRAINING_LOG.md` (the `2026-05-31` entries).

### Round 1 — reorientation: prediction vs structural carry (E1–E3) — `scripts/`

| Hypothesis | Script | Tests | Output |
|---|---|---|---|
| E1 | `build-crossxs-panel.mjs`, `audit-crossxs-momentum.ts`, `holdout-crossxs-momentum.ts` | Cross-section weekly momentum (30 coins) | `output/crossxs/*` |
| E2 | `fetch-funding-rates.mjs`, `audit-funding-carry-feasibility.ts` | **Perp funding carry, delta-neutral** (survivor) | `output/funding/*` |
| E3 | `audit-btc-tsmomentum.ts` | BTC time-series trend (daily/weekly) | (console / `output/funding/*`) |
| legacy | `audit-population-significance.ts` | Retired BTC-15m direction GA target (true-negative) | — |

### Round 1 (cont.) — broad 10-target battery (T1–T10) — `scripts/`

| Hypothesis | Script | Tests | Output |
|---|---|---|---|
| T1 | `audit-crossxs-reversal.ts` | Cross-section reversal | `output/crossxs/*` |
| T2 | `audit-crossxs-neutral.ts` | CS momentum, market-neutral + vol-target | `output/crossxs/*` |
| T3 | `audit-vol-targeted-btc.ts` | Vol-target BTC (Moreira–Muir) | (console) |
| T4/T5 | `audit-tsmom-panel.ts`, `audit-regime-gated-trend.ts` | Diversified TSMOM + vol-target; regime-gated trend | (console) |
| T6 | `audit-crypto-seasonality.ts`, `calendar-seasonality.ts` | Seasonality / turn-of-month | (console) |
| T7 | `audit-funding-contrarian.ts` | Funding as a contrarian predictor | `output/funding/*` |
| T8 | `fetch-dated-futures-basis.mjs`, `audit-dated-futures-basis.ts` | **Dated-futures basis / cash-and-carry** (survivor) | `output/dated-futures/*` |
| T9 | `audit-ethbtc-relvalue.ts` | ETH/BTC relative value | (console) |
| T10 | `audit-cointegration-pairs.ts` | Cointegration pairs | (console) |

### Round 2 — carry deep-dive feasibility (D1–D4) — `scripts/carry/`

| Sub | Script | Tests | Output |
|---|---|---|---|
| D1 | `fetch-multivenue-funding.mjs`, `analyze-multivenue-carry.ts`, `fetch-market-structure.mjs` | Multi-venue surface + cross-venue dispersion arb | `output/carry/d1-report.json`, `market-structure.json` |
| D2 | `d2_full_cost_model.ts`, `d2_sensitivity.ts` | Full cost/capital model; sensitivity grid | `output/carry/d2_full_cost_model.json`, `d2_sensitivity.json` |
| D3 | `d3-fetch-survival-data.mjs`, `d3-survival-tail-risk.ts` | Tail/survival (counterparty gap, P(ruin)) | `output/carry/d3/d3-tail-survival-results.json` |
| D4 | `audit-capacity-decay.ts` | Capacity + funding decay over time | `output/carry/capacity-decay-report.{json,txt}` |

### Round 3 — technical analysis / indicators (TA1–TA4) — `scripts/ta-research/`

| Hypothesis | Script | Tests | Output |
|---|---|---|---|
| TA1 | `carry-gating.ts` (`carry-gating-diagnose.ts`) | Indicators to TIME the carry (ON/OFF), incl. oracle bound | `output/ta-research/carry-gating-report.json` |
| TA2 | `ta2-slow-tsmom.ts` | Slow vol-targeted TSMOM (Moskowitz–Ooi–Pedersen) | `output/ta-research/ta2-slow-tsmom-summary.json` |
| TA3 | `ta3-microstructure.ts` | Microstructure / forced-flow 15m BTC (224 variants) | `output/ta-research/ta3-results.json` |
| TA4 | `ta4-classic-indicators.ts` | Classic indicators (RSI/MACD/BB/MA/ADX/Donchian/Stoch), N=94 | `output/ta-research/ta4-classic-indicators-result.json` |

### Round 4 — adaptive / walk-forward (WF-A–D) — `scripts/walkforward/`

| Hypothesis | Script | Tests | Output |
|---|---|---|---|
| WF-A | `premise-test.ts` | Adaptive WF premise test (daily, 5 families) | `output/walkforward/premise-test-result.json` |
| WF-B | `run-wf-b.ts` | Adaptive WF on majors (N=27) — surrogate fails | `output/walkforward/wf-b-result.json` |
| WF-C | `run-wf-c.ts` | Adaptive WF on 15m BTC (306k bars) — surrogate decisive | `output/walkforward/wf-c-result.json` |
| WF-D | `wf-d-adaptive-carry.ts` | Adaptivity on the real edge (carry threshold) | `output/walkforward/wf-d-adaptive-carry-report.json` |
| (engine) | `engine.ts`, `run-wf-c.ts` helpers, `verify-fast-path.ts`, `wf-lib.ts`, `lib.ts` | Walk-forward engine + fast-path verification | — |

### Round 5 — GA-over-rules + small-caps (R2–R4) — `scripts/{r2-illiquid,front-r3,front-r4}/`

| Hypothesis | Script | Tests | Output |
|---|---|---|---|
| R2 | `r2-illiquid/fetch-smallcap-panel.ts`, `r2-illiquid/audit-smallcap-edge.ts` | Illiquid / small-cap TA / momentum / reversal at real small-cap cost | `output/r2-illiquid/smallcap-audit-report.json` |
| R3 | `front-r3/run-ga-rules.ts` (`lib-ga-rules.ts`) | GA that EVOLVES trading rules (genetic programming) + surrogate control | `output/front-r3/ga-rules-result.json` |
| R4 | `front-r4/ga-structural-carry.ts` | GA over STRUCTURAL + technical carry rules | `output/front-r4/ga-structural-carry-result.json` |

### Round 6 — rotation / cycles + event flow + methodology (C1–C4) — `scripts/{c1-rotation,front-c2,front-c3,front-c4}/`

| Hypothesis | Script | Tests | Output |
|---|---|---|---|
| C1 | `c1-rotation/fetch-volume-panel.ts`, `c1-rotation/rotation-analysis.ts` | Capital rotation as lead-lag flow ("ride the relay") | `output/c1-rotation/rotation-report.json` |
| C2 | `front-c2/fetch-volume.mjs`, `front-c2/run-dominance-cycle.ts` (`sweep-robustness.ts`) | Dominance CYCLE / periodicity | `output/front-c2/dominance-cycle-result.json` |
| C3 | `front-c3/fetch-volume-panel.ts`, `front-c3/run-c3.ts` (`lib-c3.ts`) | JOINT market-state / breadth overlay | `output/front-c3/c3-report.json` |
| C4 | `front-c4/fetch-listing-events.ts`, `front-c4/run-listing-event-study.ts` | Event / forced-flow LISTING study (~644 dated events, incl. delisted) | `output/front-c4/listing-event-result.json` |
| C5 | `validation/demo-validate.ts` | Methodology package: smoke-run for `validateStrategy()` | `output/validation/demo-validate-report.{json,txt}` |

### Round 7 — on-chain distribution-pressure POC (OC1, the 28th test) — `scripts/onchain-poc/`

| Hypothesis | Script | Tests | Output |
|---|---|---|---|
| OC1 | `onchain-poc/fetch_cm.ts`, `onchain-poc/run_poc.ts` | On-chain distribution-pressure overlay (BTC+ETH exchange-flow native units + MVRV), honest N=36, via `validateStrategy` | `output/onchain-poc/verdict.{json,txt}` (+ `cm_btc.json`, `cm_eth.json`) |

> The committed gates these scripts call are in `src/lib/training/` —
> `statistical-validation.ts` (Deflated Sharpe with the true N, CPCV/PBO),
> `significance/{baselines,haircut,holdout,trial-count,spa,cpcv-paths}.ts` — and the
> reusable composition is `src/lib/validation/strategy-validator.ts`. **Do not relax the
> gates; change the target.** The pure reorientation cores are in
> `src/lib/training/reorientation/`.

---

## 5. A note on re-running the fetchers

The committed `output/` panels are a frozen snapshot (Binance/Bybit/OKX public REST,
fetched 2026-05-31). **If you re-run the `fetch-*` scripts, they hit the live public
APIs**, which return data up to the moment you call them — so the panels will extend by
the elapsed time, recent funding/price/volume values will differ, and any newly-listed or
newly-delisted symbols will change the universes. As a result the **exact quantitative
numbers can drift slightly** between a fresh fetch and the committed snapshot. The
**verdicts are robust** to this drift (they were already confirmed out-of-sample and
against surrogate nulls), but if you want to reproduce a published number to the decimal,
analyze the committed `output/` files rather than re-fetching. Endpoint availability,
rate limits, and per-symbol history depth are also subject to the venues' own policies and
may change over time.

---

### See also

- `docs/EDGE_SEARCH_SYNTHESIS.md` — the durable tally of all 28 hypotheses + full academic bibliography.
- `docs/VALIDATION_HARNESS.md` — the `validateStrategy()` harness, gate-by-gate.
- `docs/EVOLUTION_TRAINING_LOG.md` — the chronological lab record (raw provenance; in Portuguese).
