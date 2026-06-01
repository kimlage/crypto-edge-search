# Validation Harness — the anti-overfitting gauntlet, one API

> **Purpose.** Package the project's real asset — the methodology — as a single
> reusable call. `validateStrategy(...)` composes the committed, individually-tested
> gates in `src/lib/training/` into one ordered gauntlet so any future hypothesis is
> validated *exactly* the way the 23 edge-search hypotheses were (see
> `docs/EDGE_SEARCH_SYNTHESIS.md`). It **imports and reuses** those gates — it does
> not reimplement any of them. **A KILL is a valid, valuable outcome.**

- **Library:** `src/lib/validation/strategy-validator.ts` → `validateStrategy(returns | fn, opts)`
- **Smoke-run:** `scripts/validation/demo-validate.ts` (real carry series + a noise series)
- **`npx tsc --noEmit` = 0 errors** with these additions. Pure, deterministic (seeded), no I/O, no network.

---

## How to use it

```ts
import { validateStrategy } from "@/lib/validation/strategy-validator";

const verdict = validateStrategy(grossPerPeriodReturns, {
  trialCount: 224,                 // HONEST N — the TRUE number of distinct configs searched
  statistic: "compoundReturn",     // net P&L (cost-realism default)
  cost: { takerPerSide: 0.0004, position },   // 4 bps/side perp; |Δposition| charged on every change
  baselines: { marketReturns, equalWeightReturns, linearReturns },
  surrogate: { iterations: 200, crossSectional: true, panel: { assetReturns } },
  holdout: { holdoutFraction: 0.15, testFraction: 0.15 },
});

verdict.verdict;       // "PASS" | "KILL"
verdict.bindingGate;   // the FIRST gate that failed (the binding constraint) | null
verdict.perGate;       // every gate's {passed, reason, detail}, in order
verdict.netStats;      // net-of-cost summary incl. turnover + grossSharpe
```

The input is the strategy's **gross** per-period return series (or a `() => number[]`
that produces one). The harness charges cost itself and runs the gates in order. The
output is structured: `{ verdict, bindingGate, perGate, netStats, trialCount }`.

Run the smoke-run (the portable form; if your environment pins a bundled Node runtime,
prefix `PATH=/path/to/node/bin:$PATH`):

```bash
npx tsx scripts/validation/demo-validate.ts
```

It validates a **real** series (equal-weight perp funding carry over the 8 majors,
built from `output/funding/`) and a **noise** series (seeded Gaussian), asserts the
harness ran all 7 gates and that the noise was KILLed, and writes
`output/validation/demo-validate-report.{json,txt}`.

---

## The gates (in order) — what each one means

The gates are evaluated in a fixed order; the **first failing gate is the binding
gate**. Cheap economic gates run before expensive statistical ones so a gross-only
or baseline-losing signal dies immediately.

| # | Gate (`id`) | What it certifies | Committed source reused |
|---|---|---|---|
| 1 | `net_of_cost` | Positive **net of realistic cost**; turnover reported. **A gross-only signal is an automatic KILL.** | `summarizeReturnSeries` |
| 2 | `baselines` | Beats **buy-and-hold + equal-weight + random-lottery + one-layer linear**, net of cost. | `significance/baselines.ts` (`evaluateBaselineGate`, `buildRandomLotteryBaseline`, `baselineScoreFromReturns`) |
| 3 | `deflated_sharpe` | Deflated Sharpe probability ≥ bar **at an explicit honest `trialCount` (true N)** — not 1, not per-family length. | `computeDeflatedSharpeRatio` |
| 4 | `cpcv_pbo` | Probability of Backtest Overfitting `< 0.5` over combinatorial splits; flags `<8` folds as degenerate. | `estimateCscvPbo` |
| 5 | `haircut` | Sharpe **survives the Harvey-Liu multiple-testing haircut** (Bonferroni/Holm/BHY). | `significance/haircut.ts` (`haircutSharpe`) |
| 6 | `surrogate` | Real edge **beats a phase-randomized + block-bootstrap (+ optional cross-sectional) null**. *The methodological hero.* | new null generators in this file |
| 7 | `holdout` | Out-of-sample slice scored **exactly once** (consume-once vault). | `significance/holdout.ts` (`planHoldoutSplit`, `FinalHoldoutGuard`) |

### Cost realism (mandatory)
Cost is charged on **every position change**: `|Δposition| × roundTrip`, with
`roundTrip = 2 × takerPerSide` (default 4 bps/side ⇒ 8 bps round-trip perp). Pass a
`position` path in `[-1, 1]` to get turnover-aware charging; otherwise supply an
explicit `turnover` or let the harness charge a round-trip per active period. Turnover
is reported in `netStats.turnover`. **A signal that is only positive gross dies at
gate 1.**

---

## The three load-bearing parts (why these, specifically)

These three controls are what actually killed 21 pretty in-sample Sharpes that would
otherwise have looked like wins. The other gates (DSR, PBO, haircut) only certify
*"this Sharpe is not luck-of-selection"* — they do **not** test economic edge.

### 1. Honest `trialCount` (true N) — gate 3 & 5
The Deflated Sharpe and the haircut only deflate if fed the **true** number of
distinct configs tried. Feeding `N=1` (or a per-family bucket) silently skips the
deflation and lets a data-mined champion through. In the edge search, deflating by the
honest N turned every `p<0.001` champion into noise (TA3 at N=224 → p=0.21; T10 at
N=420 → DSR p=0.029). **You must pass the real N from your trial ledger.** The harness
makes `trialCount` a required option precisely so it can never be forgotten.

### 2. Surrogate / placebo — gate 6 (the hero)
Run the *identical* scoring on **surrogate panels** that preserve each asset's
**volatility and autocorrelation but destroy genuine regime / cross-asset structure**:

- **Phase randomization** (Theiler et al. 1992): FFT the series, randomize the phases
  (keeping the amplitude spectrum ⇒ same autocorrelation & variance), inverse-FFT.
  Destroys nonlinear / regime structure; keeps the linear autocorrelation a
  momentum/regime fitter feeds on.
- **Block bootstrap** (Politis & Romano 1994): resample contiguous blocks; preserves
  short-range autocorrelation, destroys long-range regime structure.
- **Cross-sectional shuffle** (rotation null, mandatory for lead-lag / rotation
  hypotheses): permute *which asset receives which return path* — keeps every marginal
  distribution but destroys real lead-lag / rotation.

If the machinery finds **equal-or-better** "edge" on the surrogates, the signal is an
**optimization artifact**. The gate reports the **real-vs-surrogate distribution** and
a **placebo p-value** (`placeboP` = fraction of surrogates scoring ≥ real); it passes
only when `placeboP ≤ maxPlaceboP` (default 0.05). This single control is what made
WF-B/WF-C conclusive instead of false positives — the adaptive machine manufactured
backtest dispersion in pure noise *as well as* in real data, i.e. it was fitting noise,
not tracking regime.

### 3. Consume-once holdout — gate 7
The search may see train + selection and may audit a posterior `test` slice, but a
truly out-of-sample verdict needs a final, most-recent block the search **never
touches** and that is **scored exactly once**. The harness carves it with
`planHoldoutSplit` and consumes it through `FinalHoldoutGuard` (a second attempt
throws — re-tuning against the vault would void the verdict). This is where 21/21
prediction edges died in the edge search.

> **Change the target, never the gates.** An empty parent pool under this gauntlet
> means the target lacks edge net of cost — not that the gauntlet is too strict.

---

## What the smoke-run demonstrates

`scripts/validation/demo-validate.ts` runs three series:

1. **REAL — perp funding carry (equal-weight 8 majors).** The harness runs all 7
   gates end-to-end on a genuine net-of-cost series. In the *current* regime it KILLs
   (carry has decayed sub-RF — see `EDGE_SEARCH_SYNTHESIS.md` §3); that is the
   **honest, expected** outcome, and the surrogate gate independently flags it
   (`placeboP ≈ 0.67`).
2. **NOISE — seeded Gaussian.** Must KILL. The net-of-cost, baseline, DSR, haircut,
   surrogate and holdout gates all refuse to certify it.
3. **AR(1) artifact.** A series whose only "structure" is autocorrelation a surrogate
   reproduces — demonstrates the surrogate gate catching what cheaper gates miss.

The script exits non-zero if the harness fails to run 7 gates or fails to KILL the
noise. On success it prints `SMOKE PASSED` and writes the reports.

---

### References

Full bibliography (every gate and every tested hypothesis mapped to its academic
source) is in **`docs/EDGE_SEARCH_SYNTHESIS.md` → "References / Bibliography"**. The
load-bearing anchors for this harness: Bailey & López de Prado (Deflated Sharpe / PBO /
CSCV / False Strategy Theorem), Harvey & Liu (multiple-testing haircut), Theiler et al.
(surrogate / phase randomization), Politis & Romano (stationary/block bootstrap), Chen &
Navet (random-lottery pre-test), and López de Prado (MinBTL / consume-once holdout).
