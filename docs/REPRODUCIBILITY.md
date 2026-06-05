# Reproducibility — how a stranger re-runs this at $0

*[Home](INDEX.md) · [Crypto](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](GLOSSARY.md) · [Polymarket](polymarket/README.md)*

> **Purpose.** This document lets anyone reproduce the edge-search lab from scratch — the
> free public data, the environment, the committed validation harness, the exact run
> command, the verdict scheme, the script families, and the on-disk caches — at a hard
> **$0 data cost** and within a **US$100 cloud ceiling** that was, in practice, never
> touched (every fetch hits unauthenticated public endpoints; the campaign's cloud bill is
> **$0**).
>
> This is a falsification lab. We do not hunt for a story that fits a backtest; we try to
> *break* every technique with the same anti-overfitting gauntlet, and we publish whatever
> survives **and** whatever dies. The program tested **~111 hypotheses across 8 domains**
> (~35 prior rounds + 58 in the 2026-06 domain campaign + 18 in two later $0 backlog
> batches), all on free public data, all through the committed gauntlet. **Final audited
> tally: 0 clean SURVIVE, 2 weak/caveated PROMISING, everything else KILL — nothing
> deployable.** The durable deliverable is the **methodology** + the body of negative
> evidence (see `docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md` for the cross-domain roll-up and the
> per-domain `output/edgehunt-*/SUMMARY.md` files for the detail).
>
> **License: MIT (see [`../LICENSE`](../LICENSE)).**

---

## 1. Data — every source is free, public, and key-less (cloud spend $0)

Every number in this program comes from **free, public** data. **No paid feeds, no API
keys, no authentication, and no cloud compute were required** — all fetches hit
unauthenticated public REST endpoints or no-key CSV downloads, and the cloud bill for the
entire edge search is **$0**. The fetched panels are committed under `output/` so the
analysis is reproducible even without re-fetching.

### Public data sources used (all free, all no-key)

| Source | Host / access | What it provides | Used by |
|---|---|---|---|
| **Binance** spot + USDⓈ-M + COIN-M | `api.binance.com`, `fapi.binance.com`, `dapi.binance.com`, `data-api.binance.vision` | Daily/15m klines, 8h perpetual funding, dated-futures (quarterly) basis, `exchangeInfo` listing dates, quote-volume, order-book depth, open interest | most price/funding/basis/microstructure domains |
| **Bybit** | `api.bybit.com` | 8h perpetual funding (multi-venue cross-check) | carry / cross-venue dispersion |
| **OKX** | `www.okx.com` | 8h perpetual funding (multi-venue cross-check) | carry / cross-venue dispersion |
| **Coin Metrics Community** | `community-api.coinmetrics.io` (no key) | ~32 free daily metrics, full history — BTC+ETH exchange FlowIn/FlowOut (native units), MVRV, realized cap, active addresses, NVT, fee revenue, PriceUSD | on-chain (D5), on-chain-2, reserve-depletion lead |
| **Deribit** | public DVOL endpoint | BTC/ETH DVOL implied-vol index (history since 2021-03) | variance-risk-premium (VRP) |
| **DefiLlama** | `stablecoins.llama.fi` (no key) | Stablecoin circulating-supply aggregate | stablecoin-supply / SSR signals |
| **FRED** | no-key CSV download | DFII10 (10Y TIPS real yield), DGS10/DGS2, T10Y2Y (2s10s), SP500 | macro / cross-asset (D6) |
| **stooq** | no-key CSV | Equity-index reference series (SP500 cross-check) | macro / cross-asset (D6) |
| **alternative.me** | public Fear & Greed API | Crypto Fear & Greed index history | sentiment (D6) |
| **Google Trends** | public | Search-interest series | sentiment (D6) |
| **GDELT** | public | Global news-tone series | sentiment (D6) |

> Where a series is offered by more than one of these (e.g. an equity index via both FRED
> and stooq), both were used as a reliability cross-check; see
> `output/edgehunt-D6/_data_reliability_notes.json`.

### On-disk data caches (so you do not have to re-fetch)

The fetched panels are committed under `output/`. The analysis reads these caches directly;
re-running a `fetch_*` script only refreshes them against the live public APIs.

| Path | Contents |
|---|---|
| `output/funding/` | 8 majors: 8h funding (~3y) + daily prices + `manifest.json` (Binance public REST) |
| `output/carry/` | Multi-venue funding (Bybit/OKX), depth, OI, `market-structure.json`, cost/capacity/tail reports |
| `output/dated-futures/` | Quarterly futures basis panel (Binance COIN-M) |
| `output/crossxs/`, `output/nf1/` | Cross-sectional / daily-OHLC panels for the 30-coin and 8-major cross-sections |
| `output/onchain-poc/` | Coin Metrics Community BTC+ETH panels (`cm_btc.json`, `cm_eth.json`) + verdict |
| `output/bigquery/btc_ohlcv_15m.ndjson` | ~100 MB committed 15m BTCUSDT OHLCV (the intraday microstructure base) |
| `output/edgehunt/` | Consensus/carry batch: dated-futures carry report, DVOL panels, VRP, PCA stat-arb, etc. |
| `output/edgehunt-D1` … `output/edgehunt-D7`, `-D348` | Per-domain panels + `SUMMARY.md` (D6 also holds the FRED/stooq CSVs, `fng_history.json`, `gdelt_tone.json`) |
| `output/edgehunt-quant/`, `output/edgehunt-onchain2/` | The two later $0 backlog batches |
| `output/edgehunt-requeue/`, `output/edgehunt-D5-followup/` | Low-concurrency re-queue + the reserve pre-registration follow-up |
| `output/edgehunt-deepen/`, `output/edgehunt-audit/`, `output/edgehunt-audit-nb/` | Deepening + the two-layer independent audit |

### Survivorship caveat (read before trusting any in-sample number)

The cross-sectional universes (30-coin panels) are **the coins that are liquid today**
(LUNA / FTT / UST are absent), so every cross-sectional in-sample number is an **upper
bound** — survivorship inflates it. The verdicts already account for this: even the
consume-once holdouts on these panels are treated as upper bounds, and the two leads that
ride a 30-coin panel are flagged as survivorship-biased (a −90% delisting shock flips the
Donchian holdout negative in ~17% of draws). The listing-event study deliberately keeps
delisted/settling symbols, so it carries no survivorship bias on the event itself — and was
still a KILL.

---

## 2. Environment

- **Language:** TypeScript, run directly via [`tsx`](https://github.com/privatenumber/tsx)
  (no build step). `tsx` is a dev dependency; after `npm install` it lives at
  `node_modules/.bin/tsx`. A few fetchers are plain Node ESM (`.mjs`).
- **Committed gates:** `src/lib/training/statistical-validation.ts` exposes the
  anti-overfitting primitives; the per-domain `runGauntlet` wrappers (e.g.
  `scripts/edgehunt-D5/harness.ts`) chain them with the claim-appropriate null.
- **Type check:** `npx tsc --noEmit` is clean over `src/` (the committed gates); the `scripts/edgehunt-*` campaign files run under `tsx`.

### Install

```bash
npm install
```

### Exact run command (how every audit/validation script is run)

TypeScript scripts are executed with `tsx` from the **repo root**. If your environment pins
a bundled Node runtime, put its `bin/` on `PATH` first so `tsx` finds a consistent Node:

```bash
PATH=/path/to/node/bin:$PATH \
  ./node_modules/.bin/tsx <script-path>
```

If you already have Node 18+ on `PATH`, the prefix is unnecessary:

```bash
npx tsx scripts/edgehunt-D5/run_d5.ts        # any scripts/.../*.ts
node scripts/edgehunt-D5/fetch_extra.ts      # plain-Node .mjs fetchers run under node
```

Scripts write machine-readable results into the matching `output/<batch>/` directory.

### Tests

```bash
npm test        # vitest run — unit tests for the gate primitives
```

---

## 3. The validation harness — committed gates + per-domain `runGauntlet`

The composed gauntlet is the methodological hero. Each hypothesis must clear **every** gate,
**in this binding order** — and the **first failing gate is the binding constraint**:

```
net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout
```

1. **`net_of_cost`** — turnover-aware net return; taker ~4 bps/side charged on every
   position change, and **financing/borrow charged on the full levered/short notional, not
   1 unit**. (A systemic financing leak — RF charged on 1 unit while ~2.95×-levered —
   collapsed the dated-futures carry from Sharpe 1.64→0.69; the same uncharged ~1.0× short
   borrow eroded the Donchian OOS holdout from ~0.53 toward 0.) A gross-only signal is an
   automatic KILL.
2. **`baselines`** — beat buy-and-hold **and** a matched-exposure benchmark **and** a
   random-lottery null; cross-sectional books must be **beta-neutral** (book β≈0, alpha-t
   on the residual) using an honest **OOS** hedge beta, never an in-sample over-hedge.
3. **`deflated_sharpe`** — Deflated Sharpe at **honest N** (every config tried counts).
4. **`block_bootstrap`** — block-bootstrap confidence interval on the mean.
5. **`cpcv_pbo`** — CPCV / Probability of Backtest Overfitting `< 0.5`.
6. **`haircut`** — Harvey–Liu multiple-testing haircut (often the true binding gate).
7. **`surrogate`** — the **right** null per claim, and for any *searched* grid the
   **family-wise MAX-statistic** null, not a single-best-config p.
8. **`holdout`** — a consume-once out-of-sample slice, scored **exactly once**.

**The right null per claim is non-negotiable:** time-series timing → phase-randomization /
block bootstrap; rotation / relative-value → cross-sectional shuffle; path-dependent exits →
bracket-on-surrogate; vol-clustering → GARCH-simulated zero-edge; variance-risk-premium →
shuffled-VRP placebo; calendar / event → calendar-reanchor + family-wise MAX-statistic;
macro / sentiment → AR(1)-matched placebo.

### Primitives and wiring

The committed primitives live in **`src/lib/training/statistical-validation.ts`**:

| Export | Role |
|---|---|
| `summarizeReturnSeries` | net-of-cost summary stats (Sharpe, turnover, drawdown) |
| `computeDeflatedSharpeRatio` | Deflated Sharpe at the honest trial count `N` |
| `blockBootstrapConfidenceInterval` | block-bootstrap CI on the mean |
| `estimateCscvPbo` | CPCV / PBO overfitting probability |

Each domain has a thin **`runGauntlet`** wrapper that loads its panel, lags features
causally, charges realistic cost, and chains the primitives with the claim-appropriate null
and a consume-once holdout. The canonical reference wrapper is
**`scripts/edgehunt-D5/harness.ts`** (`runGauntlet()` at line 332; it imports the four
primitives directly at line 23). **Do not relax the gates; change the target. A KILL is a
valid, valuable outcome — the gates do not manufacture survivors.**

> Note on branches: this branch (`codex/crypto-rebuild-plan`) ships the raw primitives +
> per-domain `runGauntlet` wrappers. A single `validateStrategy()` convenience wrapper and a
> `src/lib/training/significance/*` tree exist on the lean public-release branch but are
> **not** present here; cite the primitives + `runGauntlet` when reproducing on this branch.

---

## 4. Verdict scheme

Every hypothesis lands in one of three buckets, decided only by the gauntlet:

- **SURVIVE** — clears **all** gates on data it had never seen. *(Final count across the
  whole program: **0**.)*
- **PROMISING** — clears net-of-cost + baselines + the right surrogate + the holdout (the
  structure/sign is non-random) but trips a multiple-testing / Deflated-Sharpe gate at
  honest N. *(Final count: **2**, both weak and caveated — see below.)*
- **KILL** — fails an earlier gate; binding gate + the decisive number are recorded so the
  verdict can be challenged or revived against the *same* gates. *(Everything else.)*

**The PROMISING / SURVIVE boundary is the whole point.** A right-null surrogate **PASS**
proves the structure/sign is non-random — it does **not** prove the realized *mean is
positive with significance at honest N on unseen data*. That gap is exactly the
PROMISING/SURVIVE line, and **no lead crossed it**.

### The two surviving PROMISINGs (both weak, both caveated)

1. **XS Donchian channel-position long-short** — beta-neutral cross-sectional breakout.
   Structure is real (cross-sectional-shuffle null **p=0.009**, positive at every N∈[20,200]
   and every holdout quarter), but on the **388-row consume-once holdout the magnitude is
   indistinguishable from zero**: DSR@N=1 **0.79**, Newey-West t(mean) **0.96**,
   block-bootstrap CI-lower < 0. Charging borrow on the continuous ~1.0× short notional
   erodes the OOS Sharpe to a range **~0.3–0.5**. Survivorship-biased panel.
2. **Dated-futures basis carry** — structural carry, **unlevered-thin only**: ~**4.9%/yr,
   t=2.41**, sub-every-multiple-testing-bar and regime-fragile. The levered headline was a
   **financing-leak artifact** (RF charged on 1 unit while ~2.95×-levered; correcting it
   collapses the levered series to DSR 0.13, ~$447/mo).

### What the audit flipped (and why it matters)

A two-layer independent audit (`output/edgehunt-audit/SUMMARY.md` +
`output/edgehunt-audit-nb/SUMMARY.md`) re-derived every disputed number from the committed
primitives. It found **no false-KILL anywhere** (the conservative "nothing deployable" call
held and got *stronger*), and flipped **three** earlier PROMISINGs to KILL on the **same
defect** — a single-best-config surrogate p masking a **searched grid**, where the correct
null is the **family-wise MAX-statistic**, plus honest-N Deflated-Sharpe failure at the full
grid:

- **BTC exchange reserve-depletion** — harness surrogate p=0.013 was single-config; under
  the family-wise MAX-stat null p≈0.24 (real best 0.994 < surr95 ≈1.19) → **KILL**. The
  "pre-registered" config was the argmax of a ~12-config neighborhood, so honest N≠1; also
  inverts on ETH.
- **Q9 cross-sectional low-vol anomaly** — DSR 0.476 @ N=96, Harvey-Liu adjP 0.673, family-
  wise surrogate borderline ~0.06 → **KILL**.
- **O3 fee-revenue NVT (BTC)** — DSR 0.894 @ honest N=312, family-wise surrogate p=0.093 →
  **KILL** (the N=54 pass was a post-hoc carve-out riding the argmax).

The audit also confirmed a **systemic financing leak** (zero borrow charged on the
levered/short notional) that inflated both carries; on KILLs it only deepens the kill.

---

## 5. Script families — the `edgehunt-*` campaign

The 2026-06 campaign ran as a fan-out of per-domain workflows, each genuinely trying to
*find* edge, then judging honestly. Each family has its scripts under `scripts/edgehunt-*/`
and its synthesis at `output/edgehunt-*/SUMMARY.md`.

| Family | Domain | Per-domain synthesis |
|---|---|---|
| `scripts/edgehunt/` | Consensus / carry-arb (dated-futures carry, VRP, PCA stat-arb, vol-targeting, funding fade) | `output/edgehunt/SUMMARY.md` |
| `scripts/edgehunt-D1/` | Classic TA & price action | `output/edgehunt-D1/SUMMARY.md` |
| `scripts/edgehunt-D2/` | Volume & microstructure (the free-tier order-flow belief set; all KILL at h≥1) | `output/edgehunt-D2/SUMMARY.md` |
| `scripts/edgehunt-D348/` | D3/D4/D8 remainder (pairs, dual-momentum, GARCH vol-timing, risk-parity, …) | `output/edgehunt-D348/SUMMARY.json` |
| `scripts/edgehunt-D5/` | On-chain / crypto-native (the reserve lead lives here) | `output/edgehunt-D5/SUMMARY.md` |
| `scripts/edgehunt-D5-followup/` | Reserve pre-registration follow-up | `output/edgehunt-D5-followup/VERDICT.md` |
| `scripts/edgehunt-D6/` | Sentiment & cross-asset / macro (FRED, stooq, F&G, Google Trends, GDELT) | `output/edgehunt-D6/SUMMARY.md` |
| `scripts/edgehunt-D7/` | Calendar & event (halving cycle, seasonality, stablecoin-mint) | `output/edgehunt-D7/SUMMARY.md` |
| `scripts/edgehunt-quant/` | Quant / regime / vol / momentum ($0 backlog batch; Q9 here) | `output/edgehunt-quant/SUMMARY.md` |
| `scripts/edgehunt-onchain2/` | On-chain (free Coin Metrics) + price-action ($0 backlog batch; O3 here) | `output/edgehunt-onchain2/SUMMARY.md` |
| `scripts/edgehunt-requeue/` | Low-concurrency re-queue (the Donchian lead's canonical run is here) | `output/edgehunt-requeue/SUMMARY.md` |
| `scripts/edgehunt-deepen/` | Pre-registered consume-once + adversarial-skeptic deepening | `output/edgehunt-deepen/SUMMARY.md` |
| `scripts/edgehunt-audit/` | Independent two-layer methodology audit (9 batches) | `output/edgehunt-audit/SUMMARY.md` |
| `scripts/edgehunt-audit-nb/` | Family-wise audit-of-audit on the two backlog PROMISINGs (Q9, O3) | `output/edgehunt-audit-nb/SUMMARY.md` |

Naming conventions inside a family: a `fetch_*` / `load_*` script refreshes the cache, a
`probe_*` / `_diag` explores, a `harness.ts` defines `runGauntlet`, a `run_*` executes the
batch, and `strengthen_*` / `_followup` / `confirm_*` carry a lead into a stricter test. The
family-wise audit reconstructions are e.g.
`scripts/edgehunt-audit/d5_08_familywise_surrogate_v2.ts`,
`scripts/edgehunt-audit/d7-18-fullfamily-maxstat.ts`, and
`scripts/edgehunt-audit-nb/q9_familywise_surrogate.ts`.

### Run a domain end to end

```bash
# 1. (optional) refresh a cache against the live public API
npx tsx scripts/edgehunt-D5/fetch_extra.ts

# 2. run the domain gauntlet — reads output/ caches, writes output/edgehunt-D5/
npx tsx scripts/edgehunt-D5/run_d5.ts

# 3. read the verdict
cat output/edgehunt-D5/SUMMARY.md
```

(Prefix with `PATH=/path/to/node/bin:$PATH ./node_modules/.bin/tsx …` if you pin a bundled
Node runtime, per §2.)

---

## 6. Re-running the fetchers (drift note)

The committed `output/` caches are a frozen snapshot. **If you re-run a `fetch_*` script it
hits the live public API**, which returns data up to the moment you call it — so the panels
extend, recent values differ, and newly-listed / newly-delisted symbols change the
universes. The **exact quantitative numbers can drift slightly** between a fresh fetch and
the snapshot; the **verdicts are robust** to this drift (they were confirmed out-of-sample
and against surrogate nulls). To reproduce a published number to the decimal, analyze the
committed caches rather than re-fetching. Endpoint availability, rate limits, and history
depth are subject to each venue's policies.

> **Operational honesty:** running seven heavy domain workflows simultaneously saturated the
> API rate limit — D1 and D7 each lost ~8–9 of 11 dispatches to throttling. Those returned
> server errors, **not** verdicts, and were re-queued at low concurrency
> (`scripts/edgehunt-requeue/`), never counted as KILLs. Fan-out width must be matched to the
> rate budget.

---

## 7. The $0 + US$100-cloud-ceiling constraint

This whole program is **bounded by design**:

- **$0 data cost.** Every source in §1 is free, public, and key-less. No paid feeds, no
  authenticated APIs, no subscription gates. Where a useful series sits behind a paid vendor
  (point-in-time L2 order books, multi-asset exchange flow beyond BTC+ETH, paid NVT, longer
  implied-vol history), the hypothesis is marked **DEFERRED**, not silently approximated.
- **US$100 cloud ceiling.** A hard cap on any cloud spend for this lab; in practice the
  edge-search campaign's cloud bill is **$0** — all compute is local, all data is fetched
  over free public endpoints, and the on-disk caches make re-analysis offline.

The combination is the point: a stranger with a laptop, Node, and an internet connection can
reproduce the **entire** falsification program — the data, the gauntlet, every verdict — for
**nothing**.

---

### See also

- `docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md` — the cross-domain roll-up of the 2026-06 campaign
  (the audited final tally, the two PROMISINGs, the KILL ledger by domain, methodology
  notes, and the bibliography).
- `docs/BACKLOG.md` — the research backlog (155 testable hypotheses across 8 domains).
- `output/edgehunt-*/SUMMARY.md` — per-domain syntheses;
  `output/edgehunt-audit/SUMMARY.md` + `output/edgehunt-audit-nb/SUMMARY.md` — the
  independent audits.

> **Bottom line.** Of ~111 hypotheses spanning the full retail/quant arsenal, **none cleared
> the full gauntlet on data it had never seen.** Two weak, caveated leads survive at
> PROMISING; everything else is a documented KILL. No capital is deployed. The asset is the
> **methodology + the negative evidence** — and you can reproduce all of it at $0.

---

*License: MIT — see [`../LICENSE`](../LICENSE).*
