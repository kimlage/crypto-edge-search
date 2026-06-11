# Example submission — `rsi2-overlay-example` (KILLS BY DESIGN)

This directory is the worked example for the community gauntlet, and it is a
**planted-negative control**: an RSI(2) long/flat overlay on a *seeded synthetic
noise panel*. An oscillator overlay on noise has no edge by construction, so the
expected — and intended — verdict is **KILL**.

That is not a bug. Two things this example exists to prove:

1. **The format.** Every file a real submission needs is here, filled in
   honestly: `submission.json` (the declarations), `hypothesis.yaml` (the
   pre-registered claim, `loadHypothesisSpec`-valid), `returns.csv` (gross
   per-period returns **with the position column**, so turnover cost is charged
   on every position change), `panel.csv` (the baselines panel), and the prereg
   lock (`prereg.manifest.json`, whose `configHash` is pinned in
   `submission.json` and re-verified by the runner on every run).
2. **The control.** The runner's `--selftest` asserts this example KILLs. If it
   ever stops KILLing, either the data drifted or a gate got weaker — both are
   bugs worth alarming on. A validation stack you cannot plant a negative into
   is a validation stack you cannot trust.

## Reproducing the data ($0, offline, deterministic)

```bash
node generate-stub.mjs   # rewrites panel.csv + returns.csv, byte-identical (seed 1337)
```

The panel is 600 daily rows x 6 assets of seeded Gaussian noise with a mild
common drift (so buy-and-hold is a real bar to clear). The returns series is
the RSI(2) < 10 long/flat overlay on the first column: signal at close *t*,
position held over bar *t+1* — no look-ahead, warmup flat.

## Last verified run (through the committed gauntlet)

- Scientific verdict: **KILL**, binding gate **`baselines`**
  (loses to equal-weight), with `deflated_sharpe`, `block_bootstrap` and
  `surrogate` also failing — a textbook multi-gate kill.
- Prereg lock `sha256:0a04b9a6...` reproduces from `hypothesis.yaml`.

## Using this as your template

Copy the directory, then for a **real** submission:

- Replace the data with **free, public, key-less** sources and document the
  exact endpoints in `submission.json` (`data.sources`) — paid or keyed data
  disqualifies.
- Declare **every config you tried** in `declared.honestN`. An N=1 claim is
  only honest with a prereg hash frozen *before* you looked at returns.
- Match the **null to your claim** (`declared.null`); any searched grid must
  use `family_max` and go through `validate-family`.
- Keep `notes` honest. A KILL with your name on it is a contribution — the kill
  database *is* the product.
