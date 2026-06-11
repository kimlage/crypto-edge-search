# edgehunt-kalshi — Kalshi × Polymarket same-event convergence (campaign-E)

> _Evidence published; the runnable harness depends on the internal runGauntlet library and is not part of this public mirror yet._

> **PRE-REGISTRATION.** This README is written and frozen *before* the tape fetch
> completed and *before* any gauntlet result was seen. It declares the
> event-matching rule, the full config grid (and that `honestN = 8` — nothing else
> was searched), the tape-verification rule, the cost model, and the gauntlet
> spec. `RESULTS.md` reports what the frozen design produced.
>
> **Data-only study.** No accounts, no orders, no live execution. Every byte is
> from keyless public endpoints (Kalshi trade-api v2; Polymarket Gamma/data-api;
> Treasury.gov). Live execution is out of scope and would carry jurisdiction
> constraints (Kalshi KYC; Polymarket geo-restriction) — flagged in RESULTS, not
> advised.

## 1. The mechanism under test (PROJECT_REVIEW_2026-06-09 §4.2.2 + §5A.2)

Kalshi and Polymarket are **segmented pools** that can price the **same terminal
value** differently. A binary contract on the same objective fact pays the same
$1/$0 on both venues. So: detect a cross-venue price gap, **buy the cheap side,
hold to resolution.** The exit cost is **zero** (you never sell — the contract
self-liquidates at the fixing), the horizon is **bounded** (the resolution date),
and the terminal payoff is **identical** across venues by construction.

### The kill-judge's binding objection — built into the design

A *persistent* cross-venue gap **adversely selects phantom / stale quotes**: the
cheap side is cheap precisely because nobody will actually trade there. A naive
quote-vs-quote backtest books a gap that you could never have filled.

**Design fix (mandatory): TAPE-VERIFICATION.** A divergence only counts if an
**actual executed trade printed** at-or-worse than the divergent price *on the
venue you would buy*, inside the entry window. The entry price **is that verified
print**, never a quote. Both venues publish their full trade tape for free, so
this is checkable end-to-end. The headline diagnostic of this study is exactly:
**how many raw persistent gaps survive tape-verification.**

## 2. Data window — the honest constraint (verified 2026-06-09)

Kalshi's **keyless** `/markets` and `/markets/trades` endpoints only retain markets
that settled within roughly the last ~60 days. Markets settled before that are
**purged** (`/markets?series_ticker=...` returns `[]`; `/markets/{old}` →
`not_found`; old-ticker `/trades` → `[]`). The S3 regulatory dump
(`kalshi-public-docs.s3.amazonaws.com/reporting/market_data_*.json`) keeps daily
OHLC/volume but **no strikes, results, or prints**, so it cannot support
tape-verified fills.

**Consequence:** the honest dual-tape window is **~2026-04-10 → 2026-05-31**
(matcher `WINDOW_START=2026-04-10T00:00:00Z`, `WINDOW_END=2026-06-01T00:00:00Z`),
NOT "2024-Q2 →" as the mission hoped. The Polymarket side comes from the pinned
campaign-D corpus (`output/campaign-D/resolved-markets.jsonl`, 172,830 rows,
`SNAPSHOT.json`); macro events (Fed/CPI) for Apr–May 2026 fell outside the
corpus's 10k/month cap and are fetched fresh from Gamma by slug and cached.

## 3. Event-matching rule (`match_events.ts`) — conservative by design

A pair is admitted **only** if both markets are **binary** and resolve on the
**same objective fact** with the **same resolution date (±1d)**. Everything that
fails a rule is **counted in a census**, never silently dropped. Where the Kalshi
`result` is available the pair is **cross-validated**: the PM outcome must equal
the Kalshi result (after side-inversion) or the pair is dropped as a *match error*
(reported separately). Three rule families:

| Category | Confidence | Rule |
|---|---|---|
| **fed** | HIGH | FOMC target-range decision after a given meeting; same fact, same source (Federal Reserve statement). PM bin → Kalshi `KXFEDDECISION-26APR-{C26,C25,H0}` in 25 bp quanta. PM "increase ≥25 bps" is **excluded** (Kalshi splits H25/H26 — no single equivalent). |
| **cpi_yoy / cpi_mom** | HIGH | BLS CPI print (one-decimal). Only the **tail bins** are exact logical equivalents: PM "≥ X%" ⇔ Kalshi "Above (X−0.1)%" (same side); PM "≤ Y%" ⇔ NOT Kalshi "Above Y%" (side-inverted). Interior exact bins have no single-market Kalshi equivalent → **excluded** (counted). |
| **crypto** | MEDIUM | "BTC/ETH above $N at instant T". Same fixing instant (PM `endDate` == Kalshi `close_time`, exact), same threshold (\|strike−floor\| ≤ $1, with the Kalshi "greater"/floor 1c convention). MEDIUM because the fixing **index differs**: PM resolves on Binance 1-minute pricing, Kalshi on the CF Benchmarks BRTI 60-second average — they can disagree when the fix lands within a few dollars of the strike. The `universe={all, ex-crypto}` grid axis exists exactly for this risk; result cross-validation empirically bounds the disagreement. One pair per (asset, fixing instant): the highest-PM-volume strike-matched market. |

Low-confidence pairs are **excluded from the primary run**; only HIGH (fed, cpi)
and the cross-validated MEDIUM (crypto) cohorts enter, and the `ex-crypto`
universe axis lets the verdict be read with the index-basis risk removed entirely.

## 4. Declared config grid — `honestN = 8`, nothing else searched

Exactly **8** configurations, declared here before any result was seen:

```
divergence threshold  θ        ∈ {0.05, 0.08}      (dollars per $1 contract)
min time-to-resolution at entry ∈ {2 days, 7 days}
universe                        ∈ {all, ex-crypto}  (crypto = different fixing index)
```

2 × 2 × 2 = **8 configs**. `honestN = 8` is passed to the gauntlet so the
deflated-Sharpe, Bonferroni haircut, and **family-wise MAX** surrogate all charge
the full search. No other thresholds, holding rules, sizing schemes, venues,
categories, or windows were searched. There is no hidden grid.

### Entry rule (fixed across the grid)

1. On a tape-derived **hourly** price grid (each side = last executed print, max
   staleness 24 h — a print older than 24 h is "no price"), find the earliest
   start of a **continuous ≥ 24 h** window in which the **PM-YES-axis gap**
   `|p_PM − p_Kalshi| ≥ θ` with the **same sign** throughout.
2. At the end of that 24 h window, the **cheap venue** is the lower-priced side.
3. **Tape-verification:** scan the cheap venue's actual trade prints *after*
   detection; take the **first** print `q` that still diverges `≥ θ` versus the
   other venue's latest print at that moment. **`q` is the entry price.** No
   verified print ⇒ **no trade** (this is the gap the diagnostic counts as
   "did not survive").
4. Require `(fixing − t_print) ≥ minTTE`. Buy cheap-venue YES (PM-YES axis;
   side-inverted Kalshi pairs handled by the `1−p` transform) at `q`, fixed
   **$100** stake, **one position per matched event**, **hold to resolution**.

## 5. Cost model (charged before gate 1)

- **Kalshi taker fee — published quadratic schedule.** Fee per order =
  `ceil-to-cent( 0.07 × fee_multiplier × C × P × (1−P) )` where `C` = contracts,
  `P` = price in dollars. All target series are `fee_type ∈ {quadratic,
  quadratic_with_maker_fees}` with `fee_multiplier = 1` (verified via
  `GET /series/{ticker}`, cached in `output/kalshi/kalshi-series.json`). Formula
  per Kalshi's published "trading fees" schedule (`kalshi.com/docs`; coefficient
  0.07). We charge the **taker** fee (we cross the book to get the verified fill);
  maker rebates are not claimed. `C = STAKE / q` contracts at price `q`.
- **Polymarket cost.** Gas ≈ 0 (Polygon; the maker/taker fee is currently 0 bp on
  the CLOB). The binding PM charge is the **UMA-tail haircut**: PM resolution is
  adjudicated by the UMA optimistic oracle, which can mis-resolve / void in the
  tail. Campaign-D backlog item **PM12** has **no committed number** ("(to
  build)"), so this study charges the **measured corpus numbers**, conservatively:
  `PM_TAIL_HAIRCUT = max( 0.38% , measured-non-clean-resolution-rate-in-this-cohort )`
  with loss-given-dispute = **100% of stake** (most conservative). The 0.38% floor
  is campaign-D **PM31**: 8 / 2100 disputed on the volume-ranked slice
  (`docs/campaign-D-internal/MONEY_MGMT_AND_ARB.md`). Charged on **PM-side fills
  only**.
- **Cash drag — T-bill opportunity cost.** The stake is locked from entry to
  resolution. We charge the **13-week T-bill coupon-equivalent yield**
  (Treasury.gov daily par-yield CSV, cached
  `output/kalshi/treasury-bill-rates-2026.csv`; mean of the Apr–May 2026 daily
  "13 WEEKS COUPON EQUIVALENT" column) pro-rated over the lock days. Returns are
  therefore **excess of T-bill**, and the **hold-cash baseline = 0**. (FRED DTB3 —
  the same 13-week secondary-market bill — was 504-ing on the run day, so the
  Treasury par CSV is used; same instrument.)

No financing leg is supplied to the gauntlet (the book is **long-only, cash-
secured, unlevered** — you pay the full $1 of notional you can lose, there is no
borrow). `financingCharged=false` is therefore expected and correct here; it is
flagged in the gauntlet output as a matter of record.

## 6. Gauntlet spec — the single canonical 8-gate chain

`runGauntlet` from `src/lib/validation/strategy-validator.ts` (read first), with
nulls from `src/lib/validation/nulls.ts` and the power pre-flight from
`src/lib/validation/power-analysis.ts`. **No bespoke gate subset.**

- **Power pre-flight gate (mission rule).** If matched pairs **< 30**, the run is
  **auto-DEFERRED** — report the census + the recorded-forward path instead of
  forcing a verdict (`preflightPowerCheck` is computed and documented either way).
  A champion book with **< 10 tape-verified fills** in the selection set is also
  deferred as "too few real fills for an honest verdict".
- **Gate chain (binding gate = first failure):**
  `1 net_of_cost → 2 baselines → 3 deflated_sharpe → 4 block_bootstrap →
   5 cpcv_pbo → 6 haircut → 7 surrogate → 8 holdout`.
- **Baselines (gate 2), all must be beaten:** (a) **hold-cash** = 0 (excess-of-
  T-bill convention); (b) **no-tape-verification phantom-quote book** — same
  detection, entry at the detection-time cheap-venue last print (the stale/phantom-
  prone price), same costs, same events — the exact diagnostic the kill-judge
  demanded; (c) **random-side matched-stake** book (2000 seeded coin-flip draws on
  the champion's entries).
- **Surrogate null (gate 7):** **calibrated-Bernoulli-at-the-traded-venue's-price**
  (port of `scripts/campaign-D/gauntlet_control.ts`): under H0 the *other* venue
  adds nothing — resolution ~ Bernoulli(`q`) at the venue's own verified print.
  Because `honestN = 8 > 1`, the null is the **family-wise MAX** statistic across
  all 8 declared configs per draw (shared per-event uniforms preserve cross-config
  correlation), **≥ 1000 draws** (`nullKind: "family_wise_max"` — the gauntlet
  rejects a single-config null at `honestN > 1`).
- **Purged CPCV / PBO (gate 5):** `estimatePurgedCpcvPbo` over the 8-config grid,
  ≥ 8 purged/embargoed folds, on the **shared chronological event panel** (one
  slot per matched pair, 0 = no-trade, so all configs share an equal-length
  series).
- **Consume-once holdout (gate 8):** the **last 20%** of matched events
  (chronological by fixing instant), scored exactly once; rule `n ≥ 5 AND mean > 0
  AND DSR@N=1 ≥ 0.95`. The champion is the best **mean net selection-set return**
  among configs with ≥ 1 selection-set entry; selection set = first 80%.

## 7. Verdict discipline

A verdict is valid **only** from the full 8-gate chain via `runGauntlet`.
`SURVIVE` = all 8 pass; `PROMISING` = core gates (net_of_cost, baselines,
surrogate, holdout) pass but a multiple-testing gate fails; `KILL` = anything
else; `DEFERRED` = the honest test needs data we lack at $0 (power-wall / too few
fills). `RESULTS.md` records the verdict, the **binding gate**, the decisive
numbers, and the headline tape-verification survival rate.

## 8. Files

| File | Role |
|---|---|
| `fetch_kalshi.mjs` | `$0` keyless Kalshi trade-api v2 fetcher (series meta / settled markets / trade tapes). Resumable on-disk cache; ≤ ~3 req/s; exponential backoff. |
| `fetch_pm.mjs` | `$0` Polymarket Gamma (macro event meta) + data-api (trade tapes) fetcher. Resumable cache; ≤ ~3.5 req/s; backoff. |
| `match_events.ts` | Conservative same-event matcher + cross-validation + census → `output/kalshi/matched-pairs.json`, `kalshi-tickers.json`. |
| `convergence_test.ts` | Episode detection + tape-verification + the full 8-gate gauntlet → `output/kalshi/convergence_results.json` + stdout report. |
| `killdb-entry.json` | Proposed `data/kill-db.json` entry (campaign-E) for this study (written here, NOT merged into the DB). |

### Run order (cold start)

```bash
# 1. DATA (resumable; re-runs skip cached artifacts)
node scripts/edgehunt-kalshi/fetch_kalshi.mjs series                         # fee fields
node scripts/edgehunt-kalshi/fetch_kalshi.mjs markets                        # settled markets (target series)
node scripts/edgehunt-kalshi/fetch_pm.mjs   meta                             # macro event meta (Fed/CPI)
# 2. MATCH (no network)
npx tsx scripts/edgehunt-kalshi/match_events.ts                              # → matched-pairs.json, kalshi-tickers.json
# 3. TAPES for matched pairs only
node scripts/edgehunt-kalshi/fetch_kalshi.mjs trades output/kalshi/kalshi-tickers.json
node scripts/edgehunt-kalshi/fetch_pm.mjs   tapes  output/kalshi/matched-pairs.json
# 4. GAUNTLET
npx tsx scripts/edgehunt-kalshi/convergence_test.ts                         # → convergence_results.json + RESULTS.md numbers
```
