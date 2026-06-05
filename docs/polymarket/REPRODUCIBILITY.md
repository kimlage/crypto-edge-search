# Campaign-D — Reproducibility


Every cited number is produced by a committed script under `scripts/campaign-D/`. All data is from FREE
public endpoints (Gamma, CLOB, data-api); cloud spend **$0**. Gauntlet primitives reused verbatim from
`src/lib/training/statistical-validation.ts`.

## Pinned snapshot (the analysis corpus)

**The APIs are live — re-fetching later yields different markets (new resolutions). The analysis is
pinned to this corpus** (`output/campaign-D/SNAPSHOT.json`):

| dataset | rows | sha256[:16] |
|---|---:|---|
| `resolved-markets.jsonl` | 172,830 | `7f496b801fbad9b9` |
| `copy-markets.jsonl` | 500 | (see SNAPSHOT.json) |
| `calib-markets.jsonl` | 1,200 | (see SNAPSHOT.json) |
| `calibration.jsonl` | 1,467 | (see SNAPSHOT.json) |

- Resolved corpus: **82,736 clean-binary Yes/No** markets, base rate **26.2% YES** (longshot-heavy).
- **data-api per-query cap (disclosed):** `data-api/trades` caps both `market=` and `user=` filters at ~3,500 trades/query; 47% of high-volume copy markets are truncated to their most recent ~3,500 trades (the realistic copier's view). weather/calib tapes are complete.
- **Truncation (disclosed):** 11 months (2025-08 … 2026-06) hit the Gamma 10k/month offset cap; because
  the fetch uses `&order=endDate&ascending=true`, the **latest-closing markets within those months are
  dropped** (recency-truncation bias). Volume-ranked downstream selection retains the liquid markets.

## Exact run order

```bash
# 1. data (live; pins to the snapshot above)
node  scripts/campaign-D/fetch_resolved.mjs 202001
node  scripts/campaign-D/fetch_copy_trades.mjs 2025-10-01 2026-01-01 2026-01-01 2026-04-01 250 20000 5000000
node  scripts/campaign-D/fetch_calib_tapes.mjs 400 4
npx tsx scripts/campaign-D/tape_calib.ts
node  scripts/campaign-D/manifest.mjs                     # -> SNAPSHOT.json (hashes + truncation)

# 2. the unified gauntlet (full 8-gate chain, 3 cost levels, clean-binary calibration)
npx tsx scripts/campaign-D/run_all.ts                     # -> unified_gauntlet.json (6 KILLs)

# 3. committed re-derivations of the load-bearing numbers
npx tsx scripts/campaign-D/compute_persistence.ts 15      # -> persistence.json (-$90,457; r=-0.001)
npx tsx scripts/campaign-D/verify_re22.ts                 # -> re22.json (corpus on-winner gap +0.0001)
node  scripts/campaign-D/arb_baskets.mjs                  # -> arb_baskets.json (579 baskets, median 1.073)
npx tsx scripts/campaign-D/mm_risk_gauntlet.ts            # money-management gauntlet
npx tsx scripts/campaign-D/mm_oos_check.ts                # look-ahead proof

# (exploratory, superseded by run_all for the verdict)
npx tsx scripts/campaign-D/copy_trading_gauntlet.ts 0.01 15
npx tsx scripts/campaign-D/calib_gauntlet.ts p_24h 0.01 clean
```

## The actual copy-trading split (was inconsistent across docs — pinned here)

Selected by volume within the fetch windows, the **artifact** spans: **TRAIN 2025-10-01 → 2025-12-07**
(250 markets), **OOS 2026-01-01 → 2026-03-02** (250 markets). Earlier doc text citing
2025-08..11 / 2025-11..2026-02 (script defaults) or 2025-10..2026-01 / 2026-01..2026-04 (fetch args) was
the *requested* window; the line above is the *realized* one and is authoritative.

## Honest-N trial ledger (campaign-wide)

| strategy family | configs searched (N) | how counted |
|---|---:|---|
| Calibration favorite-longshot | 20 | 2 directions × 10 deadbands (single lead p_24h) |
| Copy-trading top-k | 8–12 | {pnl,roi[,winrate]} × {10,25,50,100} |
| Money-management | 14 | sizing/staking schemes × streams |
| Live arbitrage | 2 groupings | event + negRiskMarketID |
| Reverse-engineering | 22 mechanisms (16 NOT independently re-run) | family fan-out; see `EVALUATION.md` |

DSR is deflated at the per-family N. A campaign-wide family-wise deflation (all families pooled) would
only *raise* the bar and is directionally accounted for: no family clears even its own per-family N.

## Determinism

All gate computations are pure + seeded (`createSeededRandom`, fixed Monte-Carlo seeds); same corpus →
same verdict. The only non-determinism is the data fetch (live API), which is why the snapshot is pinned.
