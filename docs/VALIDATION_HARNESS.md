# Validation Harness — the anti-overfitting gauntlet, one API

> **Purpose.** The durable asset of this project is not a strategy — it is the
> *methodology*. This page is the API reference for that methodology: the committed,
> individually-tested gates that every hypothesis in the edge-search lab must clear,
> in a fixed binding order, and the single-entry wrapper that chains them. The same
> gauntlet that produced **0 deployable survivors across ~111 tested hypotheses** (see
> `docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md`) is the one you run on your own idea. **A KILL
> is a valid, valuable outcome — the gates do not manufacture survivors.**

The harness has three layers, lowest to highest:

1. **Primitives** — pure, deterministic statistical functions in
   `src/lib/training/statistical-validation.ts`.
2. **Per-domain `runGauntlet` wrappers** — chain the primitives with cost, baselines,
   and the right surrogate null for one domain (e.g. `scripts/edgehunt-D5/harness.ts`).
3. **`validateStrategy()`** — the published lean-repo single-entry wrapper that composes
   the same gates around an arbitrary return series.

Everything is `$0`, reproducible, seeded, and runs on free public data. Run TypeScript
with the repo's pinned runtime:

```bash
node_modules/.bin/tsx scripts/edgehunt-D5/<file>.ts
```

(If your shell does not have the bundled Node on `PATH`, prefix the invocation with the
runtime's `bin` directory, e.g. `PATH=/path/to/node/bin:$PATH node_modules/.bin/tsx …`.)

---

## Layer 1 — the primitives (`src/lib/training/statistical-validation.ts`)

Four pure functions. No I/O, no network, no global state; all randomness is seeded.
These are the load-bearing math; every wrapper imports them rather than reimplementing.

| Primitive | Signature (abridged) | What it returns |
|---|---|---|
| `summarizeReturnSeries(returns)` | `(number[]) → ReturnSeriesStats` | `sampleCount, mean, stdDev, sharpe, skewness, kurtosis, positiveRate, compoundReturn, min, max`. The honest moments every other gate is built on. |
| `computeDeflatedSharpeRatio(returns, { trialCount, benchmarkSharpe? })` | `→ DeflatedSharpeRatio` | The **Deflated Sharpe** probability after subtracting the expected maximum Sharpe of `trialCount` independent trials (Bailey & López de Prado). `deflatedProbability` is the gate value; pass the **honest N**, not 1. |
| `blockBootstrapConfidenceInterval(returns, { statistic?, iterations?, blockLength?, confidenceLevel?, seed? })` | `→ BlockBootstrapConfidenceInterval` | A stationary/block-bootstrap CI (Politis & Romano) on `mean`, `compoundReturn`, or `sharpe`. Default `blockLength = round(sqrt(n))` preserves short-range autocorrelation. The gate reads `lower`. |
| `estimateCscvPbo(strategies, { statistic?, trainFraction? })` | `→ CscvPboResult` | The **CSCV Probability of Backtest Overfitting** over every combinatorial train/test split. Needs a real strategies×folds matrix (`≥2` strategies, `≥2` folds). The gate reads `pbo`. |

```ts
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "@/lib/training/statistical-validation";

const stats = summarizeReturnSeries(netReturns);                 // sharpe, moments
const dsr   = computeDeflatedSharpeRatio(netReturns, { trialCount: 96 });
const ci    = blockBootstrapConfidenceInterval(netReturns, {
  statistic: "mean", iterations: 2000, blockLength: 20, seed: "my-strategy",
});
const pbo   = estimateCscvPbo(strategiesByFold, { statistic: "sharpe" });
```

> **Why `trialCount` is required everywhere.** The Deflated Sharpe only deflates if it
> knows the **true** number of distinct configurations you searched. Feeding `N=1` (or a
> per-family bucket) silently skips the deflation and lets a data-mined champion through.
> Passing the honest N from your trial ledger is the single most common thing that turns
> a `p<0.001` backtest into noise.

---

## Layer 2 — the per-domain `runGauntlet` wrappers

Each research domain has a thin wrapper that loads its data, builds positions strictly
causally, charges realistic cost, and chains the primitives into one ordered gauntlet.
The canonical reference is `scripts/edgehunt-D5/harness.ts` (on-chain BTC/ETH); a second
fully worked wrapper is `scripts/edgehunt-D348/harness.ts`. Each exports a single
`runGauntlet(input)` that returns the binding gate plus a one-line `VERDICT`.

```ts
// scripts/edgehunt-D5/harness.ts (abridged)
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

export function runGauntlet(input: GauntletInput): GauntletOutput { /* … */ }
```

`runGauntlet` does the work the primitives cannot: it scores **every** config in-sample
(so the Deflated Sharpe has an honest N = `configs.length` to deflate by), runs the
matched-exposure and random-lottery baselines, draws the **right surrogate null** for the
claim, and carves a **consume-once forward holdout** from the tail (default last 20%) that
no in-sample gate ever reads. Its verdict logic:

- **SURVIVE** — every gate passes.
- **PROMISING** — passes `net_of_cost` + `baselines` + `surrogate` + `holdout` but trips a
  multiple-testing / Deflated-Sharpe gate (the structure is real; the honest-N magnitude
  significance is not there).
- **KILL** — anything else. *Most hypotheses end here, and that is the point.*

---

## Layer 3 — `validateStrategy()` (the published single-entry wrapper)

The lean public repo (`github.com/kimlage/crypto-edge-search`) ships a single function
that composes the same committed gates around an arbitrary return series, so you can run
the full gauntlet on your own idea without writing a domain wrapper:

```ts
import { validateStrategy } from "@/lib/validation/strategy-validator";

const verdict = validateStrategy(grossPerPeriodReturns, {
  trialCount: 96,                  // HONEST N — the TRUE number of distinct configs searched
  statistic: "compoundReturn",     // net P&L (cost-realism default)
  cost: { takerPerSide: 0.0004, position },        // 4 bps/side; |Δposition| charged on every change
  baselines: { marketReturns, equalWeightReturns, linearReturns },
  surrogate: { iterations: 200, crossSectional: true, panel: { assetReturns } },
  holdout: { holdoutFraction: 0.15, testFraction: 0.15 },
});

verdict.verdict;       // "PASS" | "KILL"
verdict.bindingGate;   // the FIRST gate that failed (the binding constraint) | null
verdict.perGate;       // every gate's { passed, reason, detail }, in order
verdict.netStats;      // net-of-cost summary incl. turnover + grossSharpe
```

The input is the strategy's **gross** per-period return series (or a `() => number[]`
that produces one). The wrapper charges cost itself, carves the holdout vault **first**
(so gates 1–6 only ever see the in-sample slice), runs the gates in order, and returns a
structured `{ verdict, bindingGate, perGate, netStats, trialCount }`.

> **Repository note (honest provenance).** `validateStrategy()` and its smoke-run live in
> the published lean repo at `src/lib/validation/strategy-validator.ts` and
> `scripts/validation/demo-validate.ts`. On the active development branch the gate
> primitives in `src/lib/training/statistical-validation.ts` are the committed source of
> truth and are chained directly by the per-domain `runGauntlet` wrappers (e.g.
> `scripts/edgehunt-D5/harness.ts` imports them at the top of the file). The two paths run
> the **same gates in the same order**; the wrapper is convenience and verdict aggregation
> on top of the identical primitives.

---

## The gate order (binding)

Gates are evaluated in a **fixed order**; the **first failing gate is the binding gate**.
Cheap economic gates run before expensive statistical ones, so a gross-only or
baseline-losing signal dies immediately and nothing downstream is wasted on it.

```
net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo
            → haircut → surrogate → holdout
```

| # | Gate | What it certifies | Built on |
|---|---|---|---|
| 1 | `net_of_cost` | Positive **net of realistic cost**; turnover reported. **A gross-only signal is an automatic KILL.** | `summarizeReturnSeries` |
| 2 | `baselines` | Beats **buy-and-hold + a matched-exposure benchmark + random-lottery + a one-layer linear** rule, net of cost. | `summarizeReturnSeries` |
| 3 | `deflated_sharpe` | Deflated Sharpe probability ≥ bar **at an explicit honest `trialCount`** — not 1, not per-family length. | `computeDeflatedSharpeRatio` |
| 4 | `block_bootstrap` | Block-bootstrap CI lower bound on the mean **> 0** (autocorrelation-honest). | `blockBootstrapConfidenceInterval` |
| 5 | `cpcv_pbo` | Probability of Backtest Overfitting **< 0.5** over combinatorial splits. | `estimateCscvPbo` |
| 6 | `haircut` | Sharpe **survives the Harvey-Liu multiple-testing haircut** (Bonferroni / Holm / BHY). | derived `p × N` haircut on the PSR |
| 7 | `surrogate` | Real edge **beats the right null** — phase-randomization / block bootstrap / cross-sectional shuffle, **and the family-wise MAX-statistic for searched grids** (see below). *The methodological hero.* | seeded null generators in the wrapper |
| 8 | `holdout` | Out-of-sample slice scored **exactly once** (consume-once vault). | tail split, never read by gates 1–7 |

The published `validateStrategy()` exposes the same gates with seven canonical `id`s
(`net_of_cost, baselines, deflated_sharpe, cpcv_pbo, haircut, surrogate, holdout`); it
folds the block-bootstrap CI into the Deflated-Sharpe / CI evidence and treats a
self-derived candidate-vs-zero PBO as **non-binding** (a candidate-against-zero PBO is
structurally unfailable, so it is never counted as a confident PASS). The per-domain
`runGauntlet` enumerates `block_bootstrap` as its own gate #4 against a genuine
strategies×folds matrix. The **binding order and the standard each gate enforces are
identical**.

### Cost realism (mandatory)

Cost is charged on **every position change**: `|Δposition| × roundTrip`, with
`roundTrip = 2 × takerPerSide` (default 4 bps/side ⇒ 8 bps round-trip). For any
**levered or short** book, **financing/borrow is charged on the full levered/short
notional — not on 1 unit.** This single discipline is non-negotiable: a leaked financing
charge (risk-free rate on 1 unit while the book is multiples-levered) inflated two of the
lab's strongest-looking carries and, once corrected, roughly halved their economics. On a
KILL it only deepens the kill; on a candidate it is the difference between a story and the
truth.

---

## The family-wise surrogate (the 2026-06 addition)

The single most important upgrade from the 2026-06 audit is to the **surrogate gate**.

A naive surrogate test phase-randomizes (or block-bootstraps, or cross-sectionally
shuffles) **only the one in-sample-winning config** and compares its score to the null.
That is a **single-best-config p**, and it is wrong whenever the winning config was
*selected* out of a searched grid: the correct null is the **family-wise MAX-statistic** —
draw a surrogate panel, rebuild **all** configs on it, take the **grid-maximum** score per
surrogate, and compare the real grid-best against that distribution of grid-maxima.

This is not a hypothetical. Applying the right null flipped three earlier PROMISING leads
to KILL on the **same defect**:

| Lead | Harness single-config surrogate p | Family-wise MAX-stat p (searched grid) | Honest-N Deflated Sharpe | Verdict |
|---|---|---|---|---|
| BTC exchange reserve-depletion | 0.013 (PASS) | **≈0.24** (real-best 0.994 < surr95 ≈1.19) | fails at full grid | PROMISING → **KILL** |
| Q9 cross-sectional low-vol anomaly | 0.002 (PASS) | **≈0.06** (borderline, seed-sensitive) | **0.476 @ N=96** | PROMISING → **KILL** |
| O3 fee-revenue NVT (BTC) | 0.005 (PASS) | **0.093 @ N=312** (real-best 1.332 < surr95 1.384) | **0.894 @ N=312** | PROMISING → **KILL** |

The rule that falls out, and that the lab now enforces:

> A right-null surrogate **PASS proves the structure/sign is non-random — it does NOT
> prove the realized mean is positive-with-significance at honest N on unseen data.** That
> gap is exactly the **PROMISING/SURVIVE boundary**, and across the whole program **no
> lead has crossed it.** A pre-registered config must be frozen from the mechanism
> *before* any neighborhood search and must **not** be the grid argmax — otherwise honest
> N = grid size (not 1), **and** the surrogate must use the family-wise MAX-statistic.

Match the surrogate to the claim: time-series timing → phase-randomization / block
bootstrap; rotation / relative-value → cross-sectional shuffle; path-dependent exits →
bracket-on-surrogate; vol-clustering → GARCH-simulated; variance-risk-premium →
shuffled-VRP placebo; calendar / event → calendar-reanchor with an event-count-matched,
family-wise MAX-stat null. And beware the **too-powerful** vol/spectrum-preserving
surrogate: it can inflate shared long-beta for a long-flat price-transform overlay — judge
such overlays on the long-beta-**differenced** lift, not the raw surrogate Sharpe.

---

## How to run it on your own strategy

You bring one thing: a **gross** per-period return series for your candidate, plus the
**honest N** of distinct configs you tried to get there. The harness does the rest.

### Using the published wrapper

```ts
import { validateStrategy } from "@/lib/validation/strategy-validator";

// `gross` = per-period gross returns of your candidate (e.g. daily).
// `position` = your exposure path in [-1, 1], same length as `gross`,
//              so the harness can charge |Δposition| × round-trip cost.
const verdict = validateStrategy(gross, {
  trialCount: 128,                 // ← be honest: every threshold/window/lookback you scanned
  statistic: "compoundReturn",
  cost: { takerPerSide: 0.0004, position },
  baselines: { marketReturns, equalWeightReturns },   // buy-and-hold + matched-exposure
  surrogate: { iterations: 200, crossSectional: true, panel: { assetReturns } },
  holdout: { holdoutFraction: 0.2, testFraction: 0.15 },
});

if (verdict.verdict === "KILL") {
  console.log("binding gate:", verdict.bindingGate);   // where it died — that's the lesson
}
for (const g of verdict.perGate) {
  console.log(`[${g.passed ? "PASS" : "KILL"}] ${g.label}: ${g.reason}`);
}
```

### Using the primitives directly (no wrapper required)

The four primitives are enough to assemble the gauntlet yourself — this is exactly what
the per-domain wrappers do:

```ts
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "@/lib/training/statistical-validation.ts";

const HONEST_N = 128;            // count EVERY config you searched
const net = grossReturns.map((r, t) => r - turnover[t] * 2 * 0.0004); // charge cost first

const stats = summarizeReturnSeries(net);
const dsr   = computeDeflatedSharpeRatio(net, { trialCount: HONEST_N });
const ci    = blockBootstrapConfidenceInterval(net, { statistic: "mean", iterations: 2000, blockLength: 20, seed: "me" });

const passes =
  stats.mean > 0 &&                          // 1. net of cost
  /* beats your baselines, computed the same way */ true &&  // 2. baselines
  dsr.deflatedProbability > 0.95 &&          // 3. deflated Sharpe @ honest N
  ci.lower > 0;                              // 4. block-bootstrap CI lower > 0
// 5. CPCV/PBO via estimateCscvPbo over a real strategies×folds matrix
// 6. Harvey-Liu haircut, 7. family-wise surrogate, 8. consume-once holdout
```

Run it with the pinned runtime, e.g.:

```bash
node_modules/.bin/tsx scripts/edgehunt-D5/<your-file>.ts
```

**Expect a KILL.** Across the lab's ~111 tested hypotheses (≈35 prior rounds + 58 in the
2026-06 domain campaign + 18 newer `$0` backlog ideas, all on free public data, all
through this gauntlet) the final audited count is **0 clean SURVIVE, 2 weak PROMISING, the
rest KILL** — and the two PROMISING leads (a beta-neutral cross-sectional Donchian
channel-position book whose 388-row holdout magnitude is ~0; a dated-futures basis carry
that survives only thin and unlevered at ~4.9%/yr) are **not deployable**. The harness is
honest by construction: if your parent pool is empty under this gauntlet, the **target**
lacks edge net of cost — the gauntlet is not too strict. **Change the target, never the
gates.**

---

## References

The audited results, per-domain detail, and full bibliography are in
`docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md`, with the audit trail in
`output/edgehunt-audit/SUMMARY.md` and `output/edgehunt-audit-nb/SUMMARY.md` and the
deepening in `output/edgehunt-deepen/SUMMARY.md`. The load-bearing academic anchors for
this harness: Bailey & López de Prado (Deflated Sharpe / PBO / CSCV / False Strategy
Theorem), Harvey & Liu (multiple-testing haircut), Theiler et al. (surrogate / phase
randomization), Politis & Romano (stationary/block bootstrap), Chen & Navet (random-lottery
pre-test), and López de Prado (MinBTL / consume-once holdout).
