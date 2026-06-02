---
name: test-hypothesis
description: Genuinely test a crypto trading hypothesis through the committed anti-overfitting gauntlet and return an honest SURVIVE/PROMISING/KILL/DEFERRED verdict. Use when asked to test, validate, or "revive" any trading technique, indicator, signal, or strategy.
---

# Skill: test-hypothesis

Test one trading hypothesis the way this lab does — try hard to make it work, then judge it honestly.
**Change the target, never the gates.**

## Procedure

1. **Frame it.** Write the academic prior + the causal mechanism. Choose the **right null** for the claim
   (see `AGENTS.md` Rule 6 / `docs/METHODOLOGY.md`): time-series→phase/block; rotation→cross-sectional
   shuffle; path-exits→bracket-on-surrogate; vol-clustering→GARCH; VRP→shuffled-VRP; calendar→reanchor +
   family-wise MAX-stat; macro/sentiment→AR-matched.

2. **Build the strongest honest version.** Sound signal, sensible params, **features lagged h≥1**. If it
   shows early promise, strengthen it (regime conditioning, vol-target, better exits) — but **count every
   config you try in the honest N**. Reuse a per-domain harness as a template: `scripts/edgehunt-D5/harness.ts`
   (`runGauntlet`). Data is $0 — fetch with the relevant `scripts/edgehunt-*/fetch*.ts`.

3. **Charge realistic cost.** Taker ~4 bps/side on every position change; financing/borrow on the **full
   levered/short notional, not 1 unit**.

4. **Run the full gauntlet** via `runGauntlet` (or `validateStrategy()` in
   `src/lib/validation/strategy-validator.ts`): net_of_cost → baselines (B&H **and** matched-exposure;
   beta-neutrality for cross-sectional) → Deflated Sharpe @ honest N → block-bootstrap CI → CPCV/PBO →
   Harvey–Liu haircut → the right surrogate null → consume-once holdout.

5. **Decide honestly.** A surrogate PASS proves structure, not magnitude-significance at honest N on unseen
   data. End with exactly one line:
   `VERDICT: <SURVIVE|PROMISING|KILL|DEFERRED> | net Sharpe <x> | binding gate <g> | honest N <n> | surrogate p <p> | monthly@$100k <$|n/a> | confidence <low/med/high + why>`

6. **If PROMISING, hand it to the `audit-result` skill** before believing it — the family-wise surrogate +
   financing recharge kill most apparent edges.

## Guardrails
- Never loosen a gate to get a SURVIVE. If you think a gate is wrong, make it stricter and re-run everything.
- A clean KILL is a valuable, publishable result — do not manufacture a survivor.
- Write scripts under `scripts/<your-test>/` and the result/verdict under `output/<your-test>/`.
