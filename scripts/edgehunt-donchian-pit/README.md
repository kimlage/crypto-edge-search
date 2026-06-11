# W5 — XS Donchian delisted-inclusive point-in-time replay

> _Evidence published; the runnable harness depends on the internal runGauntlet library and is not part of this public mirror yet._

PROJECT_REVIEW_2026-06-09 §5A.1 / §4.2.1: the program's #1 PROMISING lead (D1-LS-DONCH,
cross-sectional Donchian channel-position long/short) was scored on a survivorship-biased
30-coin panel (`output/crossxs/`, coins liquid TODAY — LUNA/FTT absent). This lane rebuilds
the panel point-in-time INCLUDING delisted names from Binance's own data dumps and
re-adjudicates the lead through the full 8-gate library gauntlet.

**Verdict and all decision numbers: see [RESULTS.md](./RESULTS.md).**

## Pipeline

1. **`fetch_panel.mjs`** — enumerates ALL spot USDT pairs ever listed via the
   `data.binance.vision` S3 XML listing (3,615 symbol dirs, 664 USDT pairs, 588 eligible
   after rule-based exclusions), then fetches 1d klines per symbol: REST
   `api.binance.com/api/v3/klines` primary (verified live 2026-06-09: REST still serves
   delisted symbols — SRMUSDT, FTTUSDT, and old-LUNA under the reused LUNAUSDT ticker),
   monthly 1d zips as fallback (0 needed in practice). Polite: concurrency 4, paced,
   exponential backoff, resume-from-cache under `output/donchian-pit/cache/`.
   ```
   node scripts/edgehunt-donchian-pit/fetch_panel.mjs enumerate
   node scripts/edgehunt-donchian-pit/fetch_panel.mjs fetch-all     # ~4 min, ~1600 calls
   ```
2. **`build_panel.ts`** — the PIT universe rule (no hindsight): at each month-end, rank
   all eligible pairs by trailing 90-calendar-day MEDIAN daily quoteVolume (absent days
   count as zero — built-in ~46-day seasoning); top 30 = universe for the NEXT month.
   Gap-split rule: >7 missing calendar days splits a ticker into separate assets (catches
   delist+relist and ticker reuse — old-LUNA's final close $0.00005 on 2022-05-13 vs
   Terra-2.0 LUNA's $8.87 on 2022-05-31 under the SAME ticker). Delisted assets stay
   until their last trading day; a delisting inside a held position exits at the last
   available close. Writes `panel-pit.json`, `universe-by-month.json`, `panel-stats.json`.
   ```
   npx tsx scripts/edgehunt-donchian-pit/build_panel.ts
   ```
3. **`replay.ts`** — signal/weights/costs verbatim from
   `scripts/edgehunt-requeue/donch_ls_final.ts` (72-config grid; canonical = N=120
   zscore-HIGH, gross 2.0, dollar-neutral, min cross-section 6, 4 bps/side on turnover;
   burn-in 250 rows; consume-once last-20% holdout). Verdicts ONLY via the canonical
   library `runGauntlet` (`src/lib/validation/strategy-validator.ts`) with the
   family-wise MAX cross-sectional shuffle null built on `nulls.crossSectionalShuffleNull`
   (300 draws, MAX over the 72-config grid), borrow 10%/yr flat on the full short notional
   (5%/yr sensitivity), and the 28 bps round-trip cost stress per the panel-meta audit
   convention.
   ```
   npx tsx scripts/edgehunt-donchian-pit/replay.ts parity                  # pipeline proof
   npx tsx scripts/edgehunt-donchian-pit/replay.ts gauntlet --panel=survivor
   npx tsx scripts/edgehunt-donchian-pit/replay.ts gauntlet --panel=pit    # + delta table
   ```

## Exclusion rules (documented, hindsight-free)

- **Stable/fiat/pegged bases** (incl. PAXG gold-pegged, consistent with the frozen
  campaign-E recorder list; incl. UST/USTC — conservative: shorting the UST depeg would
  have flattered the strategy): full list in `fetch_panel.mjs` `STABLE_FIAT_BASES`.
- **Wrapped duplicates:** WBTC, WBETH, BETH, WETH.
- **Leveraged tokens:** base ends UP/DOWN/BULL/BEAR and the stripped stem is empty or is
  itself a listed USDT base (so JUP and SYRUP are correctly kept).

## Design decisions that differ from the legacy backtest (gauntlet mode only)

- The legacy `buildW` required TOMORROW's price to be finite for a coin to enter today's
  cross-section — a lookahead that silently sidesteps delistings (harmless on a survivor
  panel, dishonest on a PIT one). Gauntlet mode requires only PIT-universe membership +
  a finite signal; parity mode keeps the legacy rule to reproduce the published study.
- Return series are ALIGNED (one row per panel day after burn-in; 0 on flat days) so all
  72 grid series share one length for purged CPCV.
- The surrogate permutes the membership-masked FORWARD-RETURN panel within each date
  against the fixed real books (equivalent to permuting signal labels for the
  signal-rank families) so ONE permutation per (draw, date) applies consistently across
  all 72 configs — required for a valid family-wise MAX statistic.
- The "survivor" gauntlet run uses the IDENTICAL machinery on the old 30-coin panel, so
  the survivorship delta isolates the PANEL, not pipeline differences. The `parity` mode
  separately proves the pipeline reproduces the published numbers (9/9 checks PASS).

## Artifacts (`output/donchian-pit/`, gitignored)

`cache/symbols.json`, `cache/klines/*.json` (588 symbols, 712,215 rows),
`panel-pit.json`, `universe-by-month.json`, `panel-stats.json`, `replay-parity.json`,
`replay-survivor.json`, `replay-pit.json`, `survivorship-delta.json`, `fetch-all.log`.
