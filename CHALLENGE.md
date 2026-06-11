# The open challenge: run the gauntlet

> **Submit your strategy. If it clears the full 8-gate gauntlet on data it has
> never seen, we publish it — with your name on it.**

Up front, the base rate: this lab has tested **~111 hypotheses** — the whole
retail and quant playbook — through the same fixed protocol. **Zero survived
clean.** Two limped through as PROMISING, too weak to trade. The rest are dead,
each with the gate and the number that killed it
([docs/RESULTS.md](docs/RESULTS.md)).

That tally is exactly why this offer is credible. We are not a strategy shop
defending a P&L; we are a falsification lab whose own scoreboard reads **0 for
~111**. If your rule survives the same gates that killed everything else, that
is a *finding*, and we will say so publicly. And if it dies, your KILL gets
published too — the kill database is the product, and a well-run KILL with your
name on it is a real contribution.

**The one rule: change the target, never the gates.** Test anything you like.
Weaken nothing. Gates only ever move toward *more* rigorous.

---

## The deal, precisely

| You bring | We run | Everyone gets |
|---|---|---|
| One falsifiable claim + a mechanism | The committed 8-gate gauntlet, unmodified | The gate-by-gate verdict, published either way |
| $0 public data (exact endpoints declared) | `validateStrategy` / `validateStrategyFamily` — the same tested primitives behind every verdict in the ledger | A KILL entry in the kill DB, or |
| Your honest N — **every** config you tried | The right null for your claim (family-wise MAX-statistic for any searched grid) | a SURVIVE write-up with your name on it |

The chain, in its fixed binding order — **all of it, every time; no subsets**:

```
net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout
```

A submission that proposes "just the surrogate test" or "skip the haircut" is
returned unread. The first failing gate is the binding gate; the verdict
vocabulary is the lab's: **KILL / PROMISING / SURVIVE / DEFERRED /
INDETERMINATE**, with SURVIVE meaning *all eight*, on data the search never
saw, exactly once.

## The rules

1. **$0 public data only.** Free, public, key-less sources (Binance / Bybit /
   OKX public REST, data.binance.vision, Coin Metrics Community, Deribit
   public, FRED, etc.). Declare the exact endpoints and the known biases of the
   data in `submission.json`. Paid or keyed data disqualifies — anyone must be
   able to reproduce your run for nothing.
2. **The full chain, no gate subsets.** Every submission goes through the whole
   gauntlet via the committed CLI. You do not get to pick your gates.
3. **Honest N — every config you tried, declared.** Not 1-because-you-kept-one.
   A searched grid's N is the grid product (checked against your strategy
   spec); a claimed N=1 is only honest with a **pre-registration lock**: the
   sha256 of your frozen config (`crypto-edge prereg`), reproduced by the
   runner from the spec you submitted. Hash mismatch ⇒ the N=1 claim is void
   and the run is refused.
4. **The right null, named.** Match the surrogate to the claim — temporal
   timing → phase/block; rotation / relative value → cross-sectional shuffle;
   **any searched grid → the family-wise MAX-statistic** (the gate that flipped
   three of our own "winners" back to KILL). The finer taxonomy
   (calendar-reanchor, IAAFT, GARCH-sim, bracket-on-surrogate, shuffled-VRP) is
   welcome in `declared.namedNull`.
5. **KILLs are published too.** Every verdict — kill, promising, survive —
   lands in the public record with the binding gate and the decisive number.
   You are credited either way. If you cannot stomach a public KILL, do not
   submit.
6. **Forward claims must pass the power pre-flight** (next section). An
   underpowered forward window can falsify but cannot certify: a
   SURVIVE/PROMISING outcome on one is capped at **DEFERRED**, by math, not by
   mood.
7. **Maintainer-run, no secrets.** CI runs on submission data only — submitters
   never add executable code, no token beyond the default `GITHUB_TOKEN`
   exists, and **nothing auto-merges**. A `gauntlet:survive-candidate` label is
   an invitation for maintainer review and *independent reproduction*, never a
   result by itself. The published verdict is the maintainer's reproduced run.

## The power wall (read this before any forward claim)

Passing the certification gates needs an **observed** Sharpe your window can
actually produce. This is arithmetic, not pessimism:

**Required *observed* annualized Sharpe (honest N=1, daily returns):**

| Forward window | DSR ≥ 0.95 | bootstrap-CI / haircut (t ≥ 1.96) |
|---|---:|---:|
| 26 weeks | 2.34 | 2.78 |
| 1 year | 1.65 | 1.96 |
| 18 months | 1.34 | 1.60 |
| 2 years | 1.16 | 1.39 |
| 3 years | 0.95 | 1.13 |
| 4 years | 0.82 | 0.98 |
| 5 years | 0.74 | 0.88 |

**Years of forward data for 80% power, by *true* Sharpe:**

| True SR | 0.3 | 0.5 | 0.7 | 0.85 | 1.0 | 1.2 | 1.5 | 2.0 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Years | 87 | 31 | 16 | 11 | 7.8 | 5.5 | 3.5 | **2.0** |

Read it bluntly: a 26-week forward run of a true-Sharpe-1 strategy **cannot
SURVIVE** except on a ~2.8-Sharpe fluke — it can only KILL or extend. Only
mechanisms with true Sharpe ≥ 1.5–2 can certify within 1–3 years. Fast KILLs
stay cheap at any Sharpe — falsification power is asymmetric, which is why the
kill DB grows and the survivor column doesn't.

So every forward claim declares `claim.forward.windowYears` and
`claim.forward.expectedTrueSharpe`, and the runner computes the powered horizon
(≈ `((1.96 + 0.84) / SR)²` years). Powered horizon > declared window ⇒ the
submission is auto-flagged **underpowered**: it still runs (it can still die),
but it cannot certify inside that window.

## The pre-registration path (forward claims)

For a claim about the *future* rather than a backtest:

1. Freeze your config: `npx tsx src/cli/crypto-edge.ts prereg your-hypothesis.yaml --json`
   — the printed `configHash` (sha256) locks it.
2. Submit with `declared.preregHash` set. The runner re-derives the hash from
   your spec on every run; the config can never be quietly re-pointed.
3. Declare the look schedule (`claim.forward.lookSchedule`, typically
   **quarterly**). The window is scored on schedule, exactly on its dates,
   never early, never re-tuned — and the outcome is published each look,
   including the boring ones.

## How to submit (the mechanics)

1. **Pre-register** with a [New hypothesis issue](.github/ISSUE_TEMPLATE/new-hypothesis.md)
   — it fixes your honest N and your null before the search can bias them.
2. **Copy the worked example** at
   [`submissions/rsi2-overlay-example/`](submissions/rsi2-overlay-example/) — a
   complete, deliberately-dead submission (it KILLs by design; that is the
   planted-negative control). Fill in your own
   `submission.json` (schema: [`schemas/submission.schema.json`](schemas/submission.schema.json)),
   spec(s), `returns.csv` (gross returns + position column) and `panel.csv`.
3. **Run it yourself first** — the same command CI runs:
   ```bash
   node scripts/community/community-runner.mjs run submissions/<your-id>
   ```
4. **Open a PR** touching only `submissions/<your-id>/` (data files only). CI
   validates the schema and the locks, runs the full chain, posts the
   gate-by-gate verdict as a PR comment, and labels the PR
   `gauntlet:kill` / `gauntlet:promising` / `gauntlet:survive-candidate`.
5. **If it's a survive-candidate:** the maintainer reproduces it independently
   from your declared $0 sources before anything is recorded as SURVIVE. Then
   we publish it, with your name on it. Standing offer.

Expect to die at one of the usual gates — coincident long-beta, the h=0
tautology, selection inflation at honest N, luckiest-of-N, carry sub-risk-free,
holdout magnitude ([CONTRIBUTING_QUANT.md](CONTRIBUTING_QUANT.md) names them
all). Naming your expected failure mode up front
(`claim.expectedFailureMode`) is good science, not pessimism.

---

*This is a falsification lab. We are not here to be right; we are here to find
out. If your idea died, you did the job. MIT license; nothing here is
investment advice — the lab's own conclusion is that nothing it tested is
deployable.*
