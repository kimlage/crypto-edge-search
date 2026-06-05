# Campaign-D — Validation Harness (`runGauntlet`)

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


The single entry point that packages the committed gate chain, mirroring the OSS project's
`validateStrategy()`. Source: [`scripts/campaign-D/gauntlet.ts`](../../scripts/campaign-D/gauntlet.ts).
Driven uniformly by [`run_all.ts`](../../scripts/campaign-D/run_all.ts) (every strategy × cost level) and
reused by [`re_verify.ts`](../../scripts/campaign-D/re_verify.ts).

## Signature

```ts
runGauntlet(input: {
  name: string;
  returns: number[];          // chronological net (cost+financing-charged) returns of the in-sample-best config
  honestN: number;            // TRUE total configs searched (never 1 unless pre-registered, never the argmax)
  baselines: { name, mean }[];// strategy mean must exceed EACH
  grid?:  { id, folds[][] }[];// the searched grid, for CPCV/PBO
  surrogate?: { real, nullMaxes[] };  // family-wise MAX null of the claim statistic
  holdoutReturns?: number[];  // consume-once OOS, scored exactly once
  deferredReason?: string;    // set => DEFERRED (honest $0 test needs unavailable data)
}): { name, gates[], bindingGate, verdict }
```

## The gate chain (fixed binding order; first failure = binding gate)

| # | gate | pass condition | primitive |
|---|---|---|---|
| 1 | `net_of_cost` | mean net of spread+financing > 0 | `summarizeReturnSeries` (committed) |
| 2 | `baselines` | strategy mean > every baseline (buy&hold / blind-side / crowd / random) | — |
| 3 | `deflated_sharpe` | DSR ≥ 0.95 at **honest N** | `computeDeflatedSharpeRatio` (committed) |
| 4 | `block_bootstrap` | mean 95% CI lower bound > 0 | `blockBootstrapConfidenceInterval` (committed) |
| 5 | `cpcv_pbo` | PBO < 0.5 over combinatorial splits | `estimateCscvPbo` (committed) |
| 6 | `haircut` | Harvey-Liu Bonferroni-adjusted p < 0.05 (Holm/BHY reported) | in-harness (no committed primitive on this branch) |
| 7 | `surrogate` | real statistic beats the **family-wise MAX** right-null (p < 0.05) | per-claim null generator |
| 8 | `holdout` | consume-once OOS mean > 0 AND DSR@N=1 ≥ 0.95 | `computeDeflatedSharpeRatio` |

## Verdict scheme

- **SURVIVE** — every gate passes.
- **PROMISING** — passes the core economic gates (`net_of_cost`, `baselines`, `surrogate`, `holdout`) but
  trips a multiple-testing/DSR gate (3,4,5,6): the sign/structure is real, the magnitude is not significant
  at honest N on unseen data.
- **KILL** — fails a core economic gate.
- **DEFERRED** — `deferredReason` set: the only honest test needs data unavailable at $0 (PIT L2 books,
  live quoting, external fixing feeds, reward-accrual). A coverage verdict, not an edge verdict.

## Right null per claim (gate 7) — non-negotiable

The surrogate must destroy the *specific* structure the strategy claims while preserving everything else,
and for a searched grid it must be the **family-wise MAX statistic** (per draw, rebuild every config, take
the grid-max; compare the real grid-best). See `METHODOLOGY.md` for the per-claim mapping (calibrated-
Bernoulli for calibration; wallet-label-shuffle for copy-trading; price-tied Bernoulli for forecasting;
structural for static arb).

## Determinism

Pure functions + seeded RNG; no network or I/O in the gate path. Same corpus (pinned via `SNAPSHOT.json`)
→ same verdict. `npx tsc --noEmit` clean over `src/`; the `scripts/campaign-D/*` run under `tsx`.
