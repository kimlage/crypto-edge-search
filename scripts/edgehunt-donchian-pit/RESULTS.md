# RESULTS — XS Donchian L/S on the delisted-inclusive point-in-time panel

**Date:** 2026-06-09 · **Lane:** W5 (PROJECT_REVIEW_2026-06-09 §5A.1 / §4.2.1) ·
**Verdict authority:** full 8-gate `runGauntlet` from `src/lib/validation/strategy-validator.ts`
(no bespoke gate subsets) · **Data cost:** $0 (Binance REST + data.binance.vision, keyless).

## TL;DR — the flagship caveat is resolved: the lead does NOT survive the honest panel

> **The cross-sectional structure claim itself fails the right null on the
> survivorship-free panel.** On the survivor panel the family-wise MAX cross-sectional
> shuffle p was < 0.0033 (the gate that made D1-LS-DONCH "PROMISING"). On the
> delisted-inclusive PIT panel the same gate reads **p = 0.100 (champion) / 0.106
> (canonical)** — not significant. Canonical full-sample net Sharpe drops **1.405 → 1.135**
> (−0.27), IS Sharpe **1.556 → 1.208**, static-hedged holdout **0.32 → 0.09**, full-sample
> alpha t **3.22 → 1.60** (with the "beta-neutral" book now loading +0.36 on BTC).
> Library-gauntlet verdict on the PIT panel: **KILL** for both the grid champion and the
> frozen canonical, with FOUR failing gates (deflated_sharpe, haircut, surrogate, holdout).
> The published edge was substantially a property of the hindsight-selected universe.

## 1. Panel composition (the honesty check)

Universe rule: top-30 by trailing 90d median daily dollar volume at each month-end,
applied to the NEXT month; 588 eligible symbols (of 664 USDT pairs ever listed; 76
excluded by documented stable/wrapped/leveraged rules); gap>7d splits tickers into
separate assets (590 segments). Window 2020-06-02..2026-05-31 — the survivor panel's
exact date axis, so burn-in and the 80/20 holdout split land on identical dates.

| Stat | Value |
|---|---|
| Panel assets ever in the PIT top-30 | **161** (vs 30 in the survivor panel) |
| Now-dead assets that entered the universe | **28** (9.1% of all member-months: 196/2160) |
| Months (of 72) with ≥1 now-dead member | **58** |
| Mean overlap with the survivor 30, per month | **16.8 / 30** (min 10, max 21) |
| Old-LUNA (`LUNAUSDT~2020-08-21`) | member **2021-04..2022-05** — held through the crash |
| FTT | member 2021-11..2021-12 |
| SRM | member 2020-11 |
| Other dead entrants (sample) | MATIC (42 mo), FTM (33 mo), EOS (22 mo), SXP, RNDR, WAVES, XMR, OMG, BTTC, LEND, ERD, YFII, … |

The mean-overlap number is the headline: the hindsight universe and the honest universe
disagree on ~13 of 30 names in an average month. "Survivorship bias" here is not two
missing tickers — it is a different panel.

## 2. Parity check — pipeline proven before trusting the new numbers

`replay.ts parity` replicates `donch_ls_final.ts` (legacy eligibility incl. its
fwd-lookahead) on the ORIGINAL survivor panel: **9/9 PASS**.

| Published number | Replayed | Tolerance |
|---|---|---|
| Grid-best config N=20 zscore HIGH | same | exact |
| Grid-best IS net Sharpe 1.6903 | 1.6903 | ±0.005 |
| Grid-best IS turnover 1.0059 | 1.0059 | ±0.002 |
| Grid-best holdout net Sharpe 0.5303 | 0.5303 | ±0.005 |
| Grid-best holdout hedged Sharpe 0.4655 | 0.4655 | ±0.005 |
| Holdout rows 387 | 387 | exact |
| Canonical full-sample net Sharpe 1.4046 | 1.4046 | ±0.005 |
| Canonical turnover 0.3853 | 0.3853 | ±0.002 |
| Canonical holdout DSR@N=1 0.79 | 0.7925 | ±0.01 |

## 3. Library gauntlet, gate by gate (borrow 10%/yr on full short notional, 4 bps/side)

honestN = 72 for BOTH objects — the "canonical" N=120 zscore-HIGH was selected after
seeing this grid's results, so on a backtest replay it carries the family's full
multiplicity. Its single-config shuffle p is a diagnostic ONLY (the canonical saw
history; a single-config null cannot mint a verdict here — that privilege requires a
pre-registered config scored on unseen data, which is Campaign E1's job, not this replay's).

### PIT panel (delisted-inclusive) — the binding adjudication

| Gate | Champion `N=10,invvol(0.33),HIGH` | Canonical `N=120,zscore,HIGH` |
|---|---|---|
| 1 net_of_cost | PASS mean 1.58e-3 n=1551 (financing charged) | PASS mean 1.50e-3 |
| 2 baselines | PASS vs bh_btc 6.3e-4, ew −1.39e-3, rand95 −3.6e-4 | PASS |
| 3 deflated_sharpe | **FAIL** DSR 0.705 @N=72 | **FAIL** DSR 0.451 @N=72 |
| 4 block_bootstrap | PASS CI [5.3e-4, 2.7e-3] | PASS CI [1.0e-4, 3.2e-3] |
| 5 cpcv_pbo (purged, 8 folds) | PASS PBO 0.000 | PASS PBO 0.000 |
| 6 haircut (Bonferroni@72) | **FAIL** p 0.384 | **FAIL** p 1.000 |
| 7 surrogate (FW-MAX XS-shuffle, 300) | **FAIL** p 0.100 (real 1.86e-3 < null95 2.47e-3) | **FAIL** p 0.103 |
| 8 holdout (consume-once, n=388) | **FAIL** mean>0 but DSR@1 0.744 | **FAIL** DSR@1 0.730 |
| **Verdict** | **KILL** (binding: deflated_sharpe) | **KILL** (binding: deflated_sharpe) |

Diagnostic only: canonical single-config shuffle p = 0.0033 (its own structure still
beats its own-config null) — but the family-wise bar is the valid test for a searched
grid, and it fails. Note the grid champion CHANGES FAMILY on the honest panel (invvol
tails, not zscore) — the IS ranking itself was panel-dependent, classic selection noise.

### Survivor panel, identical machinery (for the apples-to-apples delta)

Both objects: **KILL**, binding deflated_sharpe; gates 3/6/8 fail; surrogate PASSES
(p < 0.0033, real 2.3e-3 vs null95 1.1e-3). Re-adjudication note: the 2026-06-01
"PROMISING" used the legacy holdout rule (OOS Sharpe > 0); under the W1 library's
stricter unified holdout (mean>0 AND DSR@1 ≥ 0.95, campaign-D rule) the survivor-panel
lead is already KILL — but it kept its surrogate pass. The PIT panel removes that too.

### Sensitivities (verdicts unchanged everywhere)

| Variant | Champion (PIT) | Canonical (PIT) |
|---|---|---|
| Borrow 5%/yr | KILL (deflated_sharpe) | KILL (deflated_sharpe) |
| 28 bps RT cost stress (panel-meta convention) | KILL (**binding net_of_cost**; IS Sharpe 0.23, holdout −0.88) | full Sharpe 0.87, holdout 0.54 (low-turnover config survives the cost but the verdict gates above already bind) |

## 4. Survivorship delta (PIT minus survivor, identical pipeline)

| Metric | Survivor | PIT | Delta |
|---|---:|---:|---:|
| Canonical full-sample net Sharpe (4 bps) | 1.405 | 1.135 | **−0.270** |
| Canonical full net Sharpe + borrow 10% | 1.208 | 0.945 | −0.263 |
| Canonical IS net Sharpe | 1.556 | 1.208 | −0.348 |
| Canonical holdout net Sharpe | 0.790 | 0.809 | +0.019 |
| Canonical holdout + borrow 10% | 0.592 | 0.601 | +0.009 |
| Canonical holdout hedged (static, in-window) | 0.318 | 0.089 | **−0.229** |
| Canonical holdout hedged (rolling 90d honest-OOS) | 0.666 | 0.419 | −0.247 |
| Canonical full-sample alpha t (vs BTC+EW) | 3.22 | 1.60 | — |
| Canonical betas [BTC, EW] | [−0.01, −0.00] | [+0.36, −0.35] | beta-neutrality is panel-dependent |
| Grid champion IS net Sharpe | 1.687 | 1.586* | −0.101* |
| Grid champion holdout net Sharpe | 0.528 | 0.972* | +0.444* |

\* different champion configs (N=20 zscore vs N=10 invvol) — IS selection is itself
panel-dependent; compare canonical rows for the like-for-like delta.

Reading: the survivorship damage is concentrated in the IS years (2021–2022, when dead
coins populated the top-30); the 2025–2026 holdout window has few delistings, so PIT ≈
live universe there and the holdout deltas are ~0. The published full-sample 1.405 was
~0.27 Sharpe of survivorship; the "beta-neutral, alpha-t 3.4–3.6" characterization
does not transfer to the honest panel (alpha t 1.60, BTC beta +0.36).

## 5. The LUNA mechanism, traced (why "the edge was partly the dead coins" is literal)

Canonical book through the May-2022 crash (old-LUNA segment, PIT panel): LONG LUNA at
w ≈ +0.25 of equity from 2022-04-25 (cp 0.72, near highs), bleeding −16.9% of equity by
2022-05-08 (incl. a −0.75 log-day at w +0.11); cp hits 0 on 05-09, the book flips short
and the log-return convention books **+0.63 of equity** on the −94%/−99.97% continuation
days, netting **+0.46** for the episode. See §6.3 — that windfall is overstated by the
study's own conventions, and the PIT panel kills the lead even WITH it.

## 6. Limitations (honest scope of this adjudication)

1. **This is a robustness adjudication of a PROMISING, not a SURVIVE/KILL mint on new
   information about the future.** The canonical saw history; nothing here scores
   forward data. Campaign E1's pre-registered forward watch is unaffected in design —
   but its prior is now materially weaker, and its prereg doc cites the survivor-panel
   numbers as the pre-commit reference.
2. **Universe rule is one defensible choice** (90d median quoteVolume, monthly refresh,
   absent-day=0 seasoning). The published lead's panel was hindsight top-30; ours is the
   honest analogue, but other PIT rules (mean volume, top-40, weekly refresh) would give
   slightly different panels. The mean-overlap stat (16.8/30 vs the survivor panel) says
   the conclusion is about the panel, not the tiebreaks.
3. **The log-return convention (inherited verbatim for parity) FLATTERS the strategy on
   crash days.** w·log-return overstates short-side profits on collapse days: LUNA
   2022-05-11 (log −8.12) books +29% of equity on a 3.6% short whose arithmetic ceiling
   is +3.6%. A real book also could not borrow LUNA at 10%/yr flat during the collapse,
   and Binance margin had halted it. Both biases are PRO-strategy; the honest panel
   kills the lead anyway, so fixing them could only darken the picture.
4. **Renames/redenominations** (MATIC→POL, FTM→S, EOS→A, BTT redenomination) appear as
   dead segments + later fresh entrants. Exit-at-last-close realizes them at market
   price, which is economically neutral for conversions; no claim is made about
   conversion mechanics.
5. **quoteVolume is exchange-reported** and includes any wash component; it is the same
   measure the live campaign-E recorder uses, so the PIT rule and the forward rule match.
6. **Surrogate scope:** the within-date permutation tests cross-sectional assignment
   exchangeability against fixed books; for the invvol family the weight magnitudes stay
   tied to the asset (slightly conservative). Statistic = mean daily net (pre-financing;
   the borrow drag is config-constant across draws, so p is invariant).

## 7. What this means for the lead

- **D1-LS-DONCH's PROMISING status should be downgraded.** Its two pillars were
  (a) XS-shuffle p ≈ 0.002 and (b) beta-neutral alpha t ≈ 3.5. On the survivorship-free
  panel: (a) becomes p ≈ 0.10 family-wise and (b) becomes alpha t 1.60 with +0.36 BTC
  beta. The full-sample headline keeps only ~1.1 net Sharpe of in-sample, multiplicity-
  unadjusted performance that fails DSR, haircut, surrogate, and holdout.
- **Campaign E1 (forward watch)** remains the only honest path for any residual claim —
  forward data is survivorship-free by construction. Its kill-condition logic now has a
  much weaker prior behind it; expectation should be set accordingly.
- **Publishable one-liner:** the program's last flagship backtest lead was substantially
  an artifact of scoring a 2026 universe on 2021 history; rebuilt point-in-time with the
  dead coins back in (free, from Binance's own dumps), it fails the family-wise shuffle
  null and the full gauntlet. 0/111 → effectively 0/112 holds.

## Reproduction

```
node scripts/edgehunt-donchian-pit/fetch_panel.mjs enumerate     # ~30 s
node scripts/edgehunt-donchian-pit/fetch_panel.mjs fetch-all     # ~4 min (resumable cache)
npx tsx scripts/edgehunt-donchian-pit/build_panel.ts             # ~5 s
npx tsx scripts/edgehunt-donchian-pit/replay.ts parity           # 0.6 s — must print 9/9 PASS
npx tsx scripts/edgehunt-donchian-pit/replay.ts gauntlet --panel=survivor   # ~8 s
npx tsx scripts/edgehunt-donchian-pit/replay.ts gauntlet --panel=pit        # ~9 s + delta
```

Total runtime ~5 minutes end-to-end (255 s of it the polite 1,607-call fetch);
artifacts under `output/donchian-pit/` (gitignored; cache makes re-runs seconds).
