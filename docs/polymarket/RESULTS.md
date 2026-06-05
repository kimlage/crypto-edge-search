# Campaign-D — Polymarket: Proof-Phase Results

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


> **Scope.** This page records the *proof phase*: the two flagship, most-provable claims from the
> 35-hypothesis backlog (`BACKLOG.md`), run through the committed gauntlet on $0 ground-truth data.
> The reverse-engineering phase (independent reproduction of the skilled-cohort *mechanism*) is in
> `REVERSE_ENGINEERING.md`. Verdict scheme inherited verbatim: **KILL / PROMISING / SURVIVE / DEFERRED**.

---

## 0. Headline

| Claim (from the viral posts) | Verdict | The number that decides it |
|---|---|---|
| "Mirror the top wallets (70%+ winrate, high PnL) and print money" | **KILL** | Top-decile-train-ROI wallets **lose −$90k OOS in aggregate**; copy surrogate **p=0.528** (no better than random) |
| "Find the favorite-longshot edge / fade longshots" | **KILL** | Mispricing structure is **real** (surrogate p=0.012) but the book **blows up out-of-sample** (holdout mean −1.0; bootstrap CI includes 0) |
| Is there *any* genuinely-skilled, copyable, persistent cohort? | **No (not detectable)** | train-ROI→OOS-ROI **r=−0.001**; top-decile OOS-positive rate **0.472 < 0.511 population** (anti-persistence) |

Both flagship claims fall, and they tell **one coherent story**: the "best traders" are mostly
**survivorship + longshot-premium harvesting** — high win-rate, small steady wins, rare ruinous tail —
and that is neither persistent nor copyable nor deployable. This is the *same* lesson as the
111-hypothesis crypto program, now confirmed in a market structure where we have **ground-truth labels**.

---

## 1. Data assets (all $0, free public endpoints)

| Asset | Source | Coverage |
|---|---|---|
| `resolved-markets.jsonl` | Gamma API, month-windowed | **172,830 markets** 2020-2026; ground-truth resolution via `outcomePrices` |
| `copy-markets.jsonl` + `trades-cache/` | data-api `/trades?market=` | **500 markets / 1,355,837 trades** (train 2025-10..2026-01, OOS 2026-01..2026-04), wallet/side/price/size/outcome |
| `calibration.jsonl` | derived from the trade tapes | YES price-at-lead vs resolution for 448 markets (171 with a clean 24h-lead price in (0,1)) |

**Two documented data-infrastructure findings (no silent caps):**
1. **Gamma offset pagination caps ~10k**; the 10 highest-volume months (2025-09..2026-06) hit the
   10k/month cap, so some later-in-month markets there are absent (volume-ranked selection retains the liquid ones).
2. **CLOB `prices-history` is PURGED beyond ~the last few weeks** — only ~June-2026 markets return a
   series; everything older returns empty for all params. So historical calibration **cannot** use
   prices-history; we derive pre-resolution prices from the **trade tape** instead (works for all history).
   The calibration sample is therefore the volume-skewed tape subsample — **underpowered (n=171)** and a
   stated limitation.

---

## 2. Copy-trading / wallet-skill persistence (PM16–PM21) — **KILL**

**Setup.** 264,103 wallets seen; **1,764 eligible** (≥15 train trades AND active OOS). Each (wallet,trade)
PnL is settled at resolution. Rank wallets by TRAIN skill (PnL / ROI / winrate × k∈{10,25,50,100}, honest
**N=12**); copy the top-k in the OOS window at a 1¢ half-spread, hold to resolution; aggregate to a
**daily-portfolio** return series. **Right null = wallet-label shuffle** (copy *random* eligible wallets),
family-wise MAX over the grid.

**Grid (OOS daily-portfolio):**

| rank metric | k | perTradeMean | daily Sharpe | OOS-winrate |
|---|---:|---:|---:|---:|
| pnl | 10 | +0.191 | 0.146 | 0.733 |
| pnl | 100 | +0.336 | 0.018 | 0.721 |
| roi | 10 | +1.563 | 0.003 | 0.425 |
| winrate | 10 | **−0.118** | −0.437 | **0.847** |
| winrate | 100 | +0.080 | −0.144 | **0.933** |

**Gauntlet (best in-sample config = copy top-10 by PnL):**

| Gate | Result | Pass? |
|---|---|---|
| net_of_cost | daily mean +0.118 | pass |
| baselines | crowd (all eligible) daily mean −0.141 | — |
| **surrogate (wallet-label shuffle, FW-MAX)** | real best 0.118 vs **null95 0.585**, **p=0.528** | **FAIL** |
| deflated_sharpe @N=12 | 0.562 | FAIL |
| block_bootstrap (mean) | CI [−0.067, 0.324] | FAIL |
| holdout (last-half OOS days) | mean +0.093 | pass |

**Binding gate = surrogate.** Selecting the *top* wallets is **no better than selecting random** eligible
wallets — random-best-of-grid (0.585) routinely beats the real top (0.118). The positive per-trade mean is
**longshot lottery variance** (daily Sharpe ≈ 0.1), not skill.

**Winrate vs profit (PM18 confirmed).** Top-winrate wallets (OOS-winrate 0.85–0.93) **lose money** — the
"70%+ winrate" marketing metric is the *anti*-signal: it identifies longshot-sellers who win often and lose big.

**Persistence is negative, not zero:**

| | value |
|---|---|
| train-winrate → OOS-winrate correlation | **r=0.479** (winrate persists…) |
| train-ROI → OOS-return correlation | **r=−0.001** (…but profitability does NOT) |
| population OOS-positive rate | 0.511 |
| **top-decile-train-ROI OOS-positive rate** | **0.472** (below population) |
| bottom-decile-train-ROI OOS-positive rate | 0.398 |
| **top-decile total OOS PnL** | **−$90,457** |
| bottom-decile total OOS PnL | +$36,496 |

Ranking by past performance has **negative** predictive value here (mean-reversion). Failure mode: **(c)
selection inflation / survivorship** + variance.

---

## 3. Calibration / favorite-longshot (PM01–PM05) — **KILL** (structure real, edge not)

> **SUPERSEDED by the powered run — see [`MONEY_MGMT_AND_ARB.md`](MONEY_MGMT_AND_ARB.md) §2.** This
> section is the underpowered n=171 result (weak surrogate pass p=0.012). With a stratified n=816
> full-spectrum sample the reliability curve is **flat (market well-calibrated)**, every config is
> negative, and the surrogate **flips to p=0.993** — the "structure was real" caveat was a small-sample
> artifact. The corrected verdict is a **clean KILL with no residual structure.** Kept below for the record.

**Setup.** 171 markets with a clean YES price 24h before resolution (tape-derived). Strategy family =
"bet toward favorite" vs "bet toward longshot" × deadband (honest **N=20**), $1/contract net of a 1¢
half-spread, hold to resolution. **Right null = calibrated-Bernoulli family-wise MAX** (resample each
outcome ~ Bernoulli(price); under perfect calibration any profit is pure cost/noise).

**Reliability (noisy, small n):** longshots [0,0.05) priced 0.020 resolved YES 0.078; the mid/high buckets
are within-noise; no clean monotone bias on this volume-skewed sample.

**Gauntlet (best = fade-longshots, band 0.45, n=56):**

| Gate | Result | Pass? |
|---|---|---|
| net_of_cost | mean +1.45 | pass |
| baselines | beats blind-NO (−0.05), blind-YES (+0.54), random-lottery (+0.17) | pass |
| **surrogate (calibrated-Bernoulli, FW-MAX)** | real 1.45 vs null95 0.84, **p=0.012** | **pass** |
| cpcv_pbo | 0.444 | pass |
| deflated_sharpe @N=20 | 0.376 | FAIL |
| block_bootstrap (mean) | CI [−0.64, 4.22] | FAIL |
| **holdout (last 20%, n=14)** | **mean −1.00** | **FAIL** |

**Binding gate = holdout.** The surrogate **passes** — longshot mispricing *structure* is real (this is the
"sign is real" half of the crypto program's PROMISING/SURVIVE boundary) — but the realized book **is not a
deployable edge**: a single longshot hit in the holdout wipes it (−1.0), the bootstrap CI includes 0, and
DSR fails at honest N. Failure mode: **(i) tail/variance** (selling lottery tickets) + small underpowered sample.

> This is the cleanest possible illustration of the lab's core meta-lesson: **a right-null surrogate PASS
> proves the structure/sign is non-random — it does NOT prove a positive realized mean at honest N on
> unseen data.** No lead crossed that line in crypto; the longshot lead does not cross it here either.

---

## 4. The skilled-cohort fingerprint (the lead for reverse-engineering)

Even though performance-ranking doesn't persist, the *survivorship slice* that stayed OOS-positive has a
coherent **behavioural** fingerprint (cohort=97 vs population=2,198 eligible):

| feature | cohort | population | Δ (cohort − pop) |
|---|---:|---:|---:|
| mean entry price | **0.159** | 0.589 | **−0.43** (trades cheap outcomes) |
| % BUY | **0.19** | 0.733 | **−0.54** (mostly **SELLS**) |
| % on eventual winner | **0.849** | 0.623 | +0.23 |
| median hrs before resolution | 48.3 | 55.6 | −7.3 |
| scalp rate | 0.257 | 0.401 | −0.14 |

**Reading:** the persistent-looking cohort **sells cheap longshots that resolve NO** — they *fade the
favorite-longshot bias*. That mechanism is exactly PM01, which **§3 already killed on tail risk**. The
reverse-engineering phase (`REVERSE_ENGINEERING.md`) takes this and the other mechanism families and tests
**independent, market-state reproductions** (no wallet-following), each through the gauntlet.

---

## 5. Reproduce every number

```
node scripts/campaign-D/fetch_resolved.mjs 202001           # 172k resolved-markets snapshot
node scripts/campaign-D/fetch_copy_trades.mjs               # 500-market / 1.36M-trade tape corpus
npx tsx scripts/campaign-D/copy_trading_gauntlet.ts 0.01 15 # §2 copy-trading KILL
npx tsx scripts/campaign-D/cohort_profile.ts 15 0.10        # §4 fingerprint
npx tsx scripts/campaign-D/tape_calib.ts                    # build calibration.jsonl from tapes
npx tsx scripts/campaign-D/calib_gauntlet.ts p_24h 0.01     # §3 calibration KILL
```

All on free public data, cloud spend **$0**. Gauntlet primitives reused verbatim from
`src/lib/training/statistical-validation.ts`.
