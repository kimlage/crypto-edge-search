# edgehunt-kalshi — RESULTS (campaign-E, Kalshi × Polymarket convergence)

> Pre-registration in [`README.md`](./README.md) (written and frozen **before**
> the tape fetch and **before** any result was seen). `honestN = 8`; nothing else
> was searched. **Data-only study — no accounts, no orders.** Run date 2026-06-09→10.

## TL;DR

**Verdict: DEFERRED** (binding gate `data_deferred`). Over the only window the
free Kalshi tape supports (**~2026-04-10 → 2026-05-31**, ~7 weeks, ~0.14 y), the
**70 conservatively-matched same-event pairs produced just 2 raw ≥24h-persistent
divergences at θ=0.05** (1 at θ=0.08), and **both fell in the consume-once
holdout** — leaving **0 tape-verified fills in the selection set**. With 0
in-sample fills there is no champion to run the gauntlet on, and the power
pre-flight independently AUTO-FLAGS the window (powered horizon 1.60 y ≫ the
0.14 y available; a SURVIVE would require an observed Sharpe ≥ 4.40 — a fluke).
The honest test needs the **recorded-forward path**, not a forced verdict.

The one thing the data *does* say loudly: **the same-event divergence the
mechanism needs barely exists.** 2 gaps in 70 pairs over 7 weeks, both on
deep-longshot CPI tails (entry q = 0.04 and 0.023), is not a tradeable
opportunity stream — it is two stray cents on near-zero-probability outcomes.

## 1. Matched-pair census (by category)

`match_events.ts` → `output/kalshi/matched-pairs.json`. A pair is admitted only if
both sides are binary, resolve on the same objective fact, same date ±1d, and
(where a Kalshi result exists) **cross-validate** PM-outcome == Kalshi-result
after side-inversion. **0 match errors** dropped.

| Category | Confidence | Matched pairs | Notes |
|---|---|---:|---|
| crypto (BTC/ETH "above $N" at instant T) | MEDIUM | **59** | one pair per (asset, fixing instant); strike \|Δ\|≤$1; PM=Binance vs Kalshi=CF BRTI index |
| cpi_yoy (BLS annual CPI tail bin) | HIGH | **4** | PM "≥X%" ⇔ Kalshi "Above (X−0.1)%"; tails only |
| cpi_mom (BLS monthly CPI tail bin) | HIGH | **4** | same tail rule; side-inverted "≤Y%" handled |
| fed (FOMC Apr-2026 decision bin) | HIGH | **3** | C26 / C25 / H0 in 25 bp quanta |
| **TOTAL** | | **70** | **≥ 30** ⇒ clears the matched-pair count gate |

Conservative exclusions (counted, not hidden): crypto `pm_no_strike_match` 238,
`dedup_dropped_same_instant` 307, `pm_in_window` 604 candidates collapsed to 59
deduped pairs; CPI interior (non-tail) bins excluded 16 (yoy) + 11 (mom); fed
"increase ≥25 bps" excluded 1 (Kalshi splits H25/H26 — no single equivalent).

Tape coverage of the 70 pairs (`fetch_kalshi.mjs trades` + `fetch_pm.mjs tapes`,
15,486 Kalshi prints + 22k PM prints fetched, fully cached/resumable):

| Category | pairs | both tapes non-empty | Kalshi tape empty |
|---|---:|---:|---:|
| crypto | 59 | 34 | **25** |
| cpi_mom | 4 | 4 | 0 |
| cpi_yoy | 4 | 4 | 0 |
| fed | 3 | 3 | 0 |
| **TOTAL** | 70 | **45** | **25** |

The 25 crypto pairs whose Kalshi side **never printed a trade** are themselves the
phantom-quote story in miniature: the cheapest hourly crypto markets are cheap
because nobody trades them. The episode detector requires both tapes non-empty,
so these correctly contribute **zero** fillable gaps.

## 2. THE headline diagnostic — raw gaps vs tape-verified fills

The kill-judge's objection operationalized: a divergence counts only if an actual
executed print on the buy venue confirms it (entry = that print, never a quote).

| θ | raw ≥24h-persistent gaps (≥1 fresh-both-sides) | tape-verified | survival |
|---:|---:|---:|---:|
| 0.05 | **2** | **2** | 100% |
| 0.08 | **1** | **1** | 100% |

Survival is 100% — but that statistic is **uninformative at n=2**: the binding
fact is the **numerator**. Across **70 same-event pairs over 7 weeks** the entry
rule found only **2** gaps that both (a) persisted ≥24h on fresh-both-sides hourly
tape and (b) had a confirming executed print on the cheap venue. A mechanism that
fires twice per ~250 pair-weeks is not a strategy you can power-test on this
window. (The naive quote-vs-quote book the design replaces would have counted many
more "gaps" — almost all on the 25 never-traded crypto markets — which is exactly
why tape-verification is mandatory; here it removes nearly the entire phantom set
by construction, because those markets have no tape at all.)

### The 2 verified episodes (both HIGH-confidence CPI tails, both in holdout)

| pair | fixing | cheap venue | gap (PM-YES axis) | entry q | TTE at entry | outcome |
|---|---|---|---:|---:|---:|---|
| `cpi_mom KXCPI-26APR-T0.3` (PM "≤0.3%" ⇔ NOT Kalshi "Above 0.3%", inverted) | 2026-05-12 | PM | −0.150 | 0.040 | 30.6 d | NO (lost) |
| `cpi_yoy KXCPIYOY-26APR-T4.0` (PM "≥4.1%" ⇔ Kalshi "Above 4.0%") | 2026-05-12 | PM | −0.071 | 0.023 | 29.1 d | NO (lost) |

Both are deep-longshot bins where PM priced the tail *even cheaper* than Kalshi.
Both **resolved NO** — i.e. both putative "buy the cheap side" trades would have
**lost the full longshot stake**. (Anecdotal at n=2, but it cuts against the
mechanism, not for it.) Pairs are ordered chronologically by fixing instant; the
April-2026 CPI prints (12 May) resolve last, so both land in the **last-20%
holdout**, leaving the selection (first-80%) set with **0 fills**.

## 3. Power pre-flight (`preflightPowerCheck`)

```
declaredWindowYears   = 0.14   (2026-04-10 .. 2026-06-01)
assumedTrueSharpeAnnual = 2.22 (0.10 stake-unit per-event edge × √event-rate)
=> poweredYears        = 1.60   > 0.14  →  feasible = FALSE  (AUTO-FLAG)
required observed SR    ≥ 4.40 (DSR≥0.95) / ≥ 5.19 (t-test) to SURVIVE on this window
```

Even granting a generous true edge, the available window is **~11× too short** to
detect it. Per the lab rule (§3 of the review), a forward test whose powered
horizon exceeds its window is auto-flagged: this window **can only KILL or
extend** — it cannot legitimately produce a SURVIVE. Combined with 0 in-sample
fills, the only honest output is **DEFER**.

## 4. Full gate-by-gate verdict

`runGauntlet` was invoked with `deferredReason` set (mission rule: champion book
has 0 verified selection-set fills < the 10-fill minimum, AND matched-pair power
is infeasible). Per the canonical chain, a set `deferredReason` short-circuits to:

```
### KalshixPM convergence (tape-verified) — champion n/a @ honestN=8  =>  DEFERRED  (binding: DEFERRED-data)
  [WARN] financingCharged=false   (correct: long-only, cash-secured, unlevered — no borrow leg)
  [deferred]  tape-verified entries in champion book = 0 < 10
              (matched pairs 70; raw≥24h gaps @θ=0.05: 2, tape-verified: 2)
              power pre-flight: AUTO-FLAG (powered 1.60y ≫ 0.14y window)
```

Gates 1–8 (`net_of_cost … holdout`) are **not scored**: with 0 in-sample fills
there is no champion return series to score them on. The 8-config grid, the
FW-MAX calibrated-Bernoulli null (`nullKind:"family_wise_max"`, 1500 draws),
purged-CPCV folds, the phantom-quote / random-side baselines, and the 20% holdout
are all **built and wired** (`convergence_test.ts` → `convergence_results.json`)
so the run is **turn-key the moment a powered fill set exists** — but firing them
on an empty selection set would manufacture a fake verdict, which the gauntlet
correctly refuses.

**Binding gate: `data_deferred`.** Decisive numbers: matched pairs **70** (≥30 OK),
tape-verified selection-set fills **0** (< 10), raw persistent gaps **2** in 70
pairs / 7 weeks, powered horizon **1.60 y ≫ 0.14 y** window.

## 5. Cost model as charged (for the record)

- **Kalshi quadratic taker fee:** `ceil-to-cent(0.07 × C × P × (1−P))`,
  `fee_multiplier = 1` for all 5 target series (verified, cached
  `kalshi-series.json`). Charged on Kalshi-side fills.
- **PM UMA-tail haircut:** `max(0.38% floor, measured-non-clean-rate)` = **0.38%**
  (measured non-clean resolution in this cohort = 0.00%, so the PM31 floor binds),
  loss-given-dispute 100% of stake, on PM-side fills.
- **Cash drag:** 13-week T-bill coupon-equivalent, Apr–May 2026 mean = **3.68%/yr**,
  pro-rated over lock days; returns are excess-of-T-bill (hold-cash baseline = 0).

These were applied inside `netReturn`; they did not bind because no in-sample book
was scored. They are pre-registered so a forward run charges them unchanged.

## 6. Jurisdiction note (flag, do not advise)

This is a **data-only** study. Any *live* version of this trade would require
**Kalshi KYC / a funded US account** on the Kalshi side and would face
**Polymarket geo-restriction** (Polymarket is not available to US persons) on the
other side — i.e. one operator legally holding both legs simultaneously is itself
a jurisdictional question. This is **flagged, not advised**; nothing here is a
recommendation to open accounts or place orders.

## 7. Limitations

1. **Window length is the dominant limitation.** Kalshi's keyless API purges
   settled-market data ~60 days out, capping the honest dual-tape window at ~7
   weeks. The S3 regulatory dump has OHLC/volume but no strikes/results/prints, so
   it cannot substitute for tape-verified fills. A longer dual-tape history would
   need paid/archival Kalshi data or a recorded-forward log.
2. **Crypto index basis (MEDIUM confidence).** Crypto pairs fix on different
   indices (Binance vs CF BRTI); they can disagree near the strike. The
   `ex-crypto` universe axis isolates this, but with 0 fills the axis was never
   exercised. The 3 HIGH-confidence macro families (fed, cpi) carry the few
   signals that exist.
3. **n=2 verified gaps** is too small for any distributional claim; the 100%
   survival rate and the 0/2 win rate are both anecdotal.
4. **One window, one campaign-D corpus snapshot.** Re-fetching later yields
   different (newer) Kalshi retention and different PM resolutions.

## 8. Recommended forward path (the honest way to power this)

Stand up a **recorded-forward dual-tape log**: poll both venues' tapes for the
matched live event families (crypto hourly/daily, CPI tail bins, FOMC, and 2026
election binaries as they list), append-only, ≤4 req/s, and **freeze the entry
decision in real time** (so there is no look-ahead). After ~12–18 months the
accumulated fills clear the 1.60 y powered horizon and `convergence_test.ts` runs
unchanged to a real SURVIVE/KILL. Until then this is **DEFERRED on data, not
killed** — but the leading indicator (2 gaps in 70 pairs / 7 weeks, both
longshot, both lost) suggests the forward run is far more likely to KILL than to
SURVIVE.

---

**Reproduce:** see [`README.md` §8](./README.md). Artifacts:
`output/kalshi/matched-pairs.json`, `output/kalshi/convergence_results.json`.
