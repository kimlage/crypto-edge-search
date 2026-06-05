# Polymarket Edge Search (Campaign-D)

*[Wiki home](../INDEX.md) · [Crypto domain](../README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Honest evaluation](EVALUATION.md) · [Unified synthesis](../../SYNTHESIS.md)*

A $0, ground-truth-provable falsification campaign on **Polymarket prediction markets**, opened
2026-06-03 the viral "Claude + copy-trade top wallets = print
money" posts. It inherits the crypto program's committed gauntlet and KILL/PROMISING/SURVIVE/DEFERRED
scheme verbatim ([../METHODOLOGY.md](../METHODOLOGY.md)). The one structural advantage over the BTC price work:
**prediction markets resolve, so every market is a free ground-truth label.**

## The documents

- **[`BACKLOG.md`](BACKLOG.md)** — 35 divergent hypotheses (9 lenses → merge → adversarial critique),
  grouped by family, each with the right null, honest-N concern, likely failure mode, and a $0 kill-shot.
- **[`RESULTS.md`](RESULTS.md)** — the proof phase: copy-trading and calibration through the gauntlet.
- **[`REVERSE_ENGINEERING.md`](REVERSE_ENGINEERING.md)** — first-principles reproduction of the cohort
  mechanism (no follow-copying): 22 mechanisms, 0 survive.
- **[`MONEY_MGMT_AND_ARB.md`](MONEY_MGMT_AND_ARB.md)** — the $0 attack on everything left: live static
  arbitrage (no riskless edge), powered calibration (no cost-survivable favorite-longshot edge), and an
  exhaustive portfolio/risk-management gauntlet (no scheme rescues a ≤0 edge).
- **[`METHODOLOGY.md`](METHODOLOGY.md)** — the Polymarket adaptation of the committed gauntlet (right null
  per claim, ground-truth advantage, price-aware cost model, named failure modes).
- **[`EVALUATION.md`](EVALUATION.md)** — honest self-assessment + the 8-agent adversarial audit, the
  overclaims walked back, and the publication-parity scorecard (~35% → ~70% after hardening).
- **[`REFERENCES.md`](REFERENCES.md)** — academic bibliography (prediction-market + anti-overfitting lit).
- **[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)** — pinned snapshot (sha256 + counts), exact run order, the
  honest-N trial ledger, and the realized train/OOS window.
- **[`VALIDATION_HARNESS.md`](VALIDATION_HARNESS.md)** — the unified `runGauntlet` entry point (gate chain,
  verdict scheme, right-null-per-claim), mirroring the OSS `validateStrategy`.
- **[`CREDIBILITY_BACKLOG.md`](CREDIBILITY_BACKLOG.md)** — 29 additional tests/deepenings to strengthen credibility (positive controls, adversarial nulls, robustness, forward); CR01 positive-control DONE (gauntlet SURVIVES a planted δ=0.08 edge, KILLs δ=0). 
- **[`RE_LEDGER.md`](RE_LEDGER.md)** — committed disposition of all 22 reverse-engineering mechanisms
  (9 tested→KILL, RE10 tested→deferred, 12 formally DEFERRED with the specific $0-blocking data reason).

## Bottom line

**0 deployable edge**, consistent with the 111-hypothesis crypto program — and here we could *prove* it
against resolved outcomes:

1. **"Mirror top wallets" — KILL.** Performance does not persist; top-decile-train-ROI wallets lose
   −$90k OOS in aggregate; copy surrogate p=0.528 (no better than random). Winrate persists (r=0.48) but
   profitability does not (r=−0.001). The "70%+ winrate" metric is the anti-signal (longshot-sellers).
2. **Market is near-perfectly calibrated in aggregate** (price-tied on-winner gap = +0.0001 over 1.36M
   trades) — no population-level forecasting edge.
3. **Favorite-longshot mispricing is REAL** (calibrated-Bernoulli surrogate p=0.012) but **not deployable**:
   every fade/buy child dies on the upset tail + wide longshot spread (holdout −1.0). It is the
   prediction-market analogue of crypto carry — real structure, sub-cost / tail-fragile / capacity-tiny.
4. **No riskless arbitrage.** True negRisk baskets (by `negRiskMarketID`) carry a **+7.3% median overround**
   (median sum(ask)=1.073, arb-free); within-market complete-set is structurally impossible; apparent "arbs"
   are incomplete/stale.
5. **No money-management rescue.** Across flat / fixed-fraction / full-half-quarter Kelly / Martingale /
   anti-Martingale / D'Alembert / vol-target / max-loss-cap, every honest scheme loses on a ≤0 edge;
   honest (market-q) Kelly bets $0; aggressive sizing only accelerates ruin. Expectancy's sign is
   sizing-invariant. (Synthetic +edge control confirms the harness detects profit when it exists.)
6. **DEFERRED (not $0-decidable):** passive market-making / spread capture, LP reward-subsidy capture,
   settlement-source fixing edges — need point-in-time L2 books / live quoting / reward-accrual data.

## Data assets (`output/campaign-D/`, gitignored)

`resolved-markets.jsonl` (172,830 markets 2020-2026) · `copy-markets.jsonl` + `trades-cache/` (500
markets, 1.36M trades) · `calibration.jsonl` (tape-derived prices) · `cohort_profile.json` · backlog/RE
workflow raw artifacts under `backlog-wf/` and `re-wf/`.

**Two $0 data-infra facts:** Gamma offset caps ~10k/window (use month-windowing); **CLOB prices-history
is purged beyond ~the last weeks** (derive pre-resolution prices from the trade tape instead).

## Reproduce

```
node scripts/campaign-D/fetch_resolved.mjs 202001
node scripts/campaign-D/fetch_copy_trades.mjs
npx tsx scripts/campaign-D/copy_trading_gauntlet.ts 0.01 15
npx tsx scripts/campaign-D/cohort_profile.ts 15 0.10
npx tsx scripts/campaign-D/tape_calib.ts && npx tsx scripts/campaign-D/calib_gauntlet.ts p_24h 0.01
```

All free public data, cloud spend **$0**. Gauntlet primitives reused from `src/lib/training/statistical-validation.ts`.
