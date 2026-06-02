---
name: reproduce-result
description: Reproduce (or refute) a published verdict from a clean clone at $0. Fetches the free public data, runs the per-domain harness, and compares to the recorded SUMMARY. Use when asked to reproduce, verify, or check a result.
---

# Skill: reproduce-result

Confirm — or refute — any verdict in `output/edgehunt-*/SUMMARY.md` from a clean clone, at $0.

## Procedure
1. **Pick the target.** Find the hypothesis ID and its scripts in `scripts/edgehunt-<domain>/` and its recorded
   verdict in `output/edgehunt-<domain>/SUMMARY.md`.
2. **Regenerate the data.** Raw caches under `output/` are gitignored. Run the domain fetcher (e.g.
   `npx tsx scripts/edgehunt-D2/fetch-data.ts`, `scripts/edgehunt-D5/fetch_extra.ts`) to download the free
   public data (Binance/Bybit/OKX REST, Coin Metrics Community, Deribit, FRED, DefiLlama, …). Some inputs (e.g.
   long 15-minute history) note their source in `docs/REPRODUCIBILITY.md`.
3. **Run the harness.** `npx tsx scripts/edgehunt-<domain>/<script>.ts`. Inspect the printed `VERDICT:` line and
   the JSON it writes under `output/edgehunt-<domain>/`.
4. **Compare.** Does your net Sharpe / binding gate / surrogate p / verdict match the recorded SUMMARY within
   noise? If it **disagrees**, that is exactly what this repo is for — open an issue with your code and numbers.
5. **Sanity-check the gates first.** `npm test` must be green (the gate primitives' own unit tests) before any
   reproduction is trustworthy.

## Notes
- Everything is $0 / free public data; no keys for the core path. If a fetch needs a paid source, the script
  marks the result **DEFERRED** and tests the best free proxy instead — reproduce the proxy, not the paid metric.
- Costs (taker ~4 bps/side, financing on full notional) are baked into the harnesses; do not silently relax them.
