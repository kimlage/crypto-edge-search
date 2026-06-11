# E1 Stage-1 Addendum — XS Donchian killed on the honest panel BEFORE any forward bar (2026-06-09)

> This addendum does NOT modify `PREREGISTRATION.md` (its sha256 in `PREREG_HASHES.json` remains
> valid). It records a material fact that landed after the prereg commit and before the first
> forward observation, per the family's own integrity rules.

**What happened.** The pre-registered design for E1 (and §4.2.1 of `PROJECT_REVIEW_2026-06-09.md`)
declared a stage-1 KILL gate: replay the frozen canonical on a delisted-inclusive point-in-time
panel before trusting any forward result. That replay was executed the same day the family was
frozen (`scripts/edgehunt-donchian-pit/RESULTS.md`):

- Pipeline parity proven first: 9/9 published numbers reproduced to 4 decimals on the survivor panel.
- Honest PIT universe: 161 assets were ever top-30 members (vs 30 in the survivor panel; mean
  monthly overlap 16.8/30); 28 now-dead assets entered, including old-LUNA held through the crash.
- Both pillars of the lead collapse on the honest panel: family-wise XS-shuffle p 0.002 → 0.103
  (the structure claim itself fails the right null) and beta-neutral alpha t 3.22 → 1.60 with BTC
  beta drifting to +0.36 (beta-neutrality was panel-dependent).
- Library gauntlet verdict: **KILL** (binding gate deflated_sharpe, DSR 0.451 canonical / 0.705
  grid-best @ honest N=72); haircut, surrogate and holdout also fail. The survivor panel itself is
  also KILL under the current (stricter) library machinery.

**Consequence for the family.**
- **E1 is resolved KILL at stage 1.** No forward look is consumed; the alpha-spending schedule is
  untouched. The E1 forward watch MAY still be recorded as a falsification watch (data is free),
  but no SURVIVE claim can ever be made from it under this prereg — the underlying backtest claim
  is dead.
- E2 (ensemble) contains a Donchian sleeve. Per the prereg's own rule ("any config edit = a new
  hypothesis"), E2 is NOT edited; its already-weak honest prior (§3 power wall) is now weaker, and
  this is recorded here. The family-wise adjudication stays K=4, Bonferroni 0.05/4.
- E4 (regime-triggered structural carry) is unaffected and remains the family's only candidate
  whose in-regime Sharpe history clears the power wall.

**Program tally after this result: 0 SURVIVE / 1 PROMISING (dated-futures basis, unlevered-thin) /
~110 KILL.** Machine-readable: `data/kill-db.json` (entry `xs-donchian-channel-ls`,
`flipped_from: PROMISING`).
