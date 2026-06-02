# Contributing to crypto-edge-search

Thanks for being here. This is a **falsification lab**, not a strategy shop. The product is an
honest, reproducible record of what does **not** survive realistic testing in crypto — plus the
anti-overfitting gauntlet that produced that record. To date the lab has pushed **~111 hypotheses**
across 8 domains through that gauntlet, all at **$0** on free public data, and found **0 clean
survivors**. That is the result, and it is the contribution.

So before anything else, please internalize the spirit of the place:

> **A well-run KILL is a contribution.** If you take a plausible idea, test it honestly, and it dies
> — and you write down *why* — you have added real value. You have saved the next person from
> re-walking dead ground. Negative results are the whole point. There is no pressure here to
> manufacture a survivor, and we will never publish one we cannot defend.

We would much rather merge ten honest KILLs than one flattering, fragile "edge."

---

## The one rule

There is exactly **one** rule, and it is non-negotiable:

> ## Change the target, never the gates.
> You may test any hypothesis you like — any signal, market, data source, or strategy. But you may
> **not** weaken the gauntlet to let your idea through. The gates only ever move in **one**
> direction: **more rigorous.**

Tightening a gate, adding a stricter null, charging a cost we were missing, or counting a trial we
were not counting — all welcome, all the time. **Loosening** a gate to promote a candidate — never.
If your idea only survives because you relaxed a control, your idea is dead and the control was
doing its job. PRs that soften a gate to manufacture a pass will be closed.

The gauntlet is the asset. Protect it.

---

## Ways to contribute

All of these are first-class. None requires a positive result.

1. **Test a new hypothesis.** Pick something off `docs/BACKLOG.md` (155 testable ideas across 8
   domains) or bring your own. Run it through the full gauntlet and report the verdict honestly —
   SURVIVE, PROMISING, or KILL. Most will KILL. That is expected and welcome.

2. **Try to revive a KILL.** Think one of our buried hypotheses deserved better — a cleaner data
   source, a fixed bug in the signal, a fairer baseline, a market we did not have? Resurrect it and
   re-run it. If it still dies, you have *hardened* the KILL. If it genuinely survives the full
   gauntlet (unchanged gates), that is a real finding and we will celebrate it loudly.

3. **Attack the gates.** Try to **break** the gauntlet itself: find a strategy that passes every
   gate but should not, or a null that is too weak, or a baseline that lets an artifact through.
   This is the highest-value work in the lab. A successful attack on a gate that ends in a *stricter*
   gate is a major contribution. (See the campaign lessons below — every one of them came from an
   attack on our own gates that succeeded.)

4. **Add a surrogate null.** The right null per claim is non-negotiable, and we keep finding we need
   new ones. Phase-randomization and block-bootstrap for timing; cross-sectional shuffle for
   rotation/relative-value; bracket-on-surrogate for path-dependent exits; GARCH-simulated for
   vol-clustering; shuffled-VRP placebo for variance premia; calendar-reanchor for seasonality; and
   the **family-wise MAX-statistic** surrogate for any *searched* grid. If you have a claim type our
   current nulls do not cover, contributing the correct null — with a calibration check — is a real
   methodological win.

5. **Port the harness to another market.** The gauntlet is market-agnostic. Port it to equities,
   FX, futures, or another asset class and re-run a hypothesis family there. Cross-market replication
   (or cross-market failure) of a result is exactly the kind of evidence this lab exists to produce.

6. **Reproduce a result.** Re-run one of our published verdicts from scratch and confirm (or
   challenge) the numbers. Independent reproduction is the bedrock of the whole project. If your
   numbers disagree with ours, open an issue — we want to know.

---

## The gauntlet (the gates you must clear, in binding order)

Every hypothesis runs through this chain. The **binding gate is the first failure.** SURVIVE = all
pass. PROMISING = clears net-of-cost, baselines, the right surrogate null, and the consume-once
holdout, but trips a multiple-testing / Deflated-Sharpe gate. Everything else is a KILL.

```
net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout
```

| Gate | What it asks |
|---|---|
| **net_of_cost** | Survive realistic cost: taker ~4 bps/side on **every** position change, and financing/borrow charged on the **FULL** levered/short notional — not on 1 unit. |
| **baselines** | Beat buy-and-hold **and** a matched-exposure benchmark; for cross-sectional books, prove **beta-neutrality** (book β≈0, alpha-t on the residual) using an honest-OOS hedge beta, never an in-sample over-hedge. Also beat a random-lottery control. |
| **deflated_sharpe** | Clear the Deflated Sharpe Ratio **at honest N** — where honest N counts **every** config you tried, not just the winner. |
| **block_bootstrap** | Block-bootstrap confidence interval on the mean strictly clear of zero. |
| **cpcv_pbo** | Combinatorially-purged CV with PBO < 0.5. |
| **haircut** | Harvey–Liu multiple-testing haircut (often the true binding gate). |
| **surrogate** | The **right surrogate null per claim** (see contribution #4). For any **searched grid**, the null must be the **family-wise MAX-statistic**, not the single-best-config p. |
| **holdout** | A **consume-once** holdout, spent exactly once, on data the search never saw. |

The committed gate primitives live in **`src/lib/training/statistical-validation.ts`**
(`computeDeflatedSharpeRatio`, `estimateCscvPbo`, `blockBootstrapConfidenceInterval`,
`summarizeReturnSeries`), chained by per-domain `runGauntlet` wrappers — the canonical reference
implementation is **`scripts/edgehunt-D5/harness.ts`**. The published lean repo also exposes a single
**`validateStrategy()`** entry point (`src/lib/validation/strategy-validator.ts`, with a smoke-run at
`scripts/validation/demo-validate.ts`) that composes the same gates into one call.

> A surrogate **PASS** proves the structure/sign is non-random. It does **not** prove the realized
> mean is positive-with-significance at honest N on unseen data. That gap is the PROMISING/SURVIVE
> boundary — and in ~111 hypotheses, **no lead has crossed it.** Keep that distinction sharp.

---

## Campaign lessons (please fold these into your work)

These are not theory. Each was discovered by an audit attacking our own results, and each one
**flipped a lead from PROMISING to KILL.** If your contribution touches a searched grid, a
short/levered book, or a "pre-registered" config, you must respect all three — they are the most
common ways an honest-looking edge turns out to be an artifact.

- **Use the FAMILY-WISE MAX-statistic surrogate for any searched grid.** A surrogate p computed on
  the single in-sample-best config silently ignores every other config you tried. The correct null
  for a searched family is the family-wise MAX-statistic: build all configs on each surrogate, take
  the per-surrogate grid maximum, and compare your real best against that distribution.
  *This single defect flipped three earlier leads to KILL* — BTC exchange reserve-depletion (harness
  single-config p=0.013 → family-wise p≈0.24, real best 0.994 < surr95 ≈1.19), the Q9
  cross-sectional low-vol anomaly, and the O3 fee-revenue NVT signal (single-config p=0.005 →
  family-wise p=0.093 @ N=312). All three had also failed honest-N Deflated Sharpe at the full grid.

- **Charge financing on the FULL notional.** A systemic leak in the campaign charged the risk-free
  rate on 1 unit while the book ran levered or short. Charge borrow/financing on the actual levered
  or short notional, every bar. *Correcting this halved the carries:* dated-futures basis at the
  honest ~2.95× levered charge collapsed from Sharpe 1.64 → 0.69 and DSR 0.58 → 0.13, and the XS
  Donchian short-side borrow eroded its OOS holdout from ~0.53 toward 0. On a KILL the leak only
  deepens the kill; on a carry it inflates the headline — so it must be corrected everywhere.

- **Pre-register the config BEFORE the neighborhood search.** Pre-registration is the *only* honest
  way to collapse honest N → 1 — but only if the config is frozen from mechanism **before** you look
  at returns, and is **not** the grid argmax. If your "pre-registered" config is actually the argmax
  of a neighborhood you searched, then honest N = grid size, the family-wise surrogate applies, and
  the Deflated-Sharpe penalty stands. (This is precisely how the reserve lead, which looked like a
  clean DSR@N=1 = 0.988 forward result, turned out to be argmax of a ~12-config neighborhood.)

A few more blades worth knowing: avoid tautological metrics (`sharpe(OLS residuals)` is ~0 by
construction — use `sharpe(y − β·x)` for hedged alpha); apply the **h=0 leakage gate** (report the
contemporaneous ceiling, then require the strictly-lagged h≥1 leg to clear the gates *alone*); and
remember the consume-once holdout is spent once, and survivorship-biased panels (LUNA/FTT absent)
make even the holdout an upper bound.

---

## Setup

Everything runs on **free public data** (Binance / Bybit / OKX public REST, Coin Metrics Community
no-key, Deribit public DVOL, FRED no-key CSV, and similar) at **$0 cloud spend**. The stack is
TypeScript executed with `tsx`; the gates are pure, deterministic, and seeded.

```bash
# 1. Clone
git clone https://github.com/kimlage/crypto-edge-search.git
cd crypto-edge-search

# 2. Install
npm install

# 3. Run the test suite (vitest) — should be green before you start
npm test

# 4. Run a per-domain gauntlet/harness script (example)
npx tsx scripts/edgehunt-D5/harness.ts
```

A real hypothesis run drives a per-domain harness directly — for example the canonical reference
chain:

```bash
npx tsx scripts/edgehunt-D5/harness.ts
```

Type-check with `npm run typecheck` (`tsc --noEmit`): the committed gates under `src/` are clean; the per-domain `scripts/edgehunt-*` audit files run under `tsx` and are not part of the `src/` type-check surface. Lint with `npm run lint`.

---

## Submitting your work

1. Open an issue describing the hypothesis (or the gate attack, or the port) and its **right null**
   *before* you search — pre-registration is part of the methodology, not bureaucracy.
2. Put your harness/script under the appropriate `scripts/` directory, importing the committed gate
   primitives — do not re-implement the gates.
3. Report the **verdict and the binding gate**, with the numbers that produced it. A KILL writeup
   should say exactly which gate killed it and why.
4. In your PR, confirm you did **not** weaken any gate. If you *strengthened* one, say so — that is a
   headline feature, not a footnote.

Be welcoming and be honest. We are not here to be right; we are here to find out. If your idea dies,
you have done the job.

---

## License

MIT — Copyright (c) 2026 Kim Lage. See [LICENSE](LICENSE).
