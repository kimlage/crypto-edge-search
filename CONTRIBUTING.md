# Contributing

This is a **public falsification lab** — and it gets better the more people try to break it.
Contributions are very welcome. The goal is not to find a winning strategy; it is to build an
honest, reproducible body of evidence about what does and does not work. A well-run **KILL is a
contribution.**

## Ways to contribute

1. **Test a new hypothesis.** Have a technique you believe has edge? Run it through the gauntlet.
   Add a `scripts/<your-test>/` audit that calls `validateStrategy(...)` with an **honest trial
   count**, realistic cost, a surrogate null, and a consume-once holdout. Open a PR with the
   verdict — KILL or SURVIVE, both are valuable.
2. **Try to revive a KILL.** Think one of the 33 kills was unfair? Challenge it — but you must beat
   the *same* gates (cost, baselines, honest `N`, surrogate, consume-once holdout). If you can make
   a dead strategy genuinely pass, that is a real finding.
3. **Attack the gates.** Find a bug, an edge case, or a way the gauntlet could be fooled — a
   surrogate that doesn't destroy the right structure, an `N` that's understated, a look-ahead, a
   leak. The credibility of every result rests on the gates being correct, so **adversarial review
   of the harness is the highest-value contribution there is.**
4. **Add a surrogate null.** Different claims need different nulls (we have phase-randomization,
   block-bootstrap, and the cross-sectional shuffle). New trade *forms* may need new ones — e.g.
   the bracket-on-surrogate control for path-dependent stop-loss / take-profit exits.
5. **Port the harness.** `validateStrategy(...)` is market-agnostic. Run it on equities, FX, or
   commodities and report whether the same techniques die there too.
6. **Reproduce a result.** Re-run any test from a clean clone (`$0`, free public data) and confirm
   — or refute — a number. Disagreements, with code, are exactly what this repo is for.

## The one rule

> **Change the target, never the gates.**

A strategy is promoted only if it passes the **full** gauntlet on data it never saw. Loosening a
gate to manufacture a "SURVIVE" defeats the entire purpose of the project. If you believe a gate is
*wrong*, make it **more** rigorous and re-run everything — never weaker.

## How to start

```bash
git clone https://github.com/kimlage/crypto-edge-search
cd crypto-edge-search
npm install
npm test                                       # the committed gates + harness, all green
npm run typecheck                              # tsc --noEmit, 0 errors
npx tsx scripts/validation/demo-validate.ts    # watch the gauntlet KILL noise AND the (sub-RF) real carry
```

Then **open an issue** to propose a hypothesis or report a gate bug, or a **pull request** with your
test (a new `scripts/<name>/` + the `validateStrategy` verdict, ideally with the result JSON under
`output/<name>/`). Please keep it reproducible and `$0` — free public data only.

— and remember: *if a technique cannot beat buy-and-hold, a random trader, and luck-adjusted
significance on data it has never seen, it is not an edge. It is a story.*
