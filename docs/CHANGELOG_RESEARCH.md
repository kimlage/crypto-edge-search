# Research Changelog — audited verdict flips

*[Home](INDEX.md) · [Crypto](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](GLOSSARY.md) · [Polymarket](polymarket/README.md)*

A dated log of every place the cross-domain adversarial audit overrode a per-domain raw
verdict. The canonical state lives in `output/results-ledger.json` (see
`docs/CANONICAL_STATE.md`); this file records *why* each `auditedVerdict` differs from its
`rawVerdict`.

Each flip below has a matching entry in the ledger whose `auditOverrideReason` carries the
same justification, and is required by the schema/validator precisely because the verdicts
differ.

---

## 2026-06-09 — XS Donchian flipped PROMISING → KILL (survivorship)

The program's last cross-sectional PROMISING lead was rebuilt on a **delisted-inclusive
point-in-time panel** and downgraded. Its sole open caveat had always been survivorship (the
30-name panel had LUNA / FTT absent); resolving that caveat with the honest universe killed
the lead. The audited headline is now **0 SURVIVE, 1 PROMISING (dated-futures-unlevered-thin),
rest KILL/DEFERRED** — down from the 2 PROMISING that held from 2026-06-01.

| # | ID | Lead | Raw → Audited | Reason |
|---|----|------|---------------|--------|
| 5 | `D1-LS-DONCH` | Cross-sectional Donchian channel-position L/S (β-neutral) | PROMISING → **KILL** | Substantially survivorship. Rebuilt on the honest 161-ever-member point-in-time universe (vs 30 in the survivor panel; mean overlap 16.8/30; old-LUNA held through its crash), the family-wise cross-sectional-shuffle p moved 0.002 → 0.103 and beta-neutral alpha t 3.22 → 1.60 (BTC beta → +0.36); the library `runGauntlet` binds on deflated_sharpe (DSR 0.451 @N=72). Pipeline parity 9/9 vs the published numbers proven first. (`scripts/edgehunt-donchian-pit/RESULTS.md`) |

**Net effect on the count:** audited 2 PROMISING → **1 PROMISING**; total flips PROMISING →
KILL now **5** (the 4 from 2026-06-01 plus this one). No flip ran in the other direction.

Two **campaign-E** hypotheses were also recorded in the ledger on this date (no flip — their
raw and audited verdicts agree):

- **`E2-XS-FUNDRANK`** — cross-sectional funding-rank L/S carry → **KILL** (binding
  deflated_sharpe, DSR 0.942 @N=12; also fails cpcv_pbo 0.643 and family-wise XS-shuffle
  p=0.060). The coupon is real and the price leg is positive on the survivorship-free
  155-perp panel, but it dies on multiple-testing. (`scripts/edgehunt-fundingrank/RESULTS.md`)
- **`E3-KALSHI-PM`** — Kalshi × Polymarket same-event convergence → **DEFERRED** (binding
  data_deferred: free Kalshi tape is only ~7 weeks; 2 fillable gaps in 70 same-event pairs,
  both longshot losers; recorded-forward path documented). (`scripts/edgehunt-kalshi/RESULTS.md`)

---

## 2026-06-01 — two-layer adversarial audit: 4 leads flipped PROMISING → KILL

The first-pass per-domain runs surfaced six PROMISING leads. A two-layer audit
(`output/edgehunt-audit/SUMMARY.md`, `output/edgehunt-audit-nb/SUMMARY.md`,
`output/edgehunt-deepen/SUMMARY.md`) re-derived the disputed numbers from the committed
primitives and flipped four of them to KILL. The audited headline is **0 SURVIVE, 2
PROMISING (XS Donchian + dated-futures-unlevered-thin), rest KILL/DEFERRED** — down from
the "3 PROMISING" (or "4 leads") in the pre-audit docs.

The recurring failure mode for three of the four (D5-08, Q9, O3) is identical: the harness
surrogate p-value was a **single-best-config p over a SEARCHED grid**. Under the
**family-wise MAX-statistic null** — the correct surrogate for a searched family — the
surrogate gate degrades, and each independently fails **honest-N Deflated Sharpe at the
full grid size**. The fourth (VRP) is a single-regime artifact.

| # | ID | Lead | Raw → Audited | Reason |
|---|----|------|---------------|--------|
| 1 | `D5-08` | BTC exchange reserve-depletion / netflow | PROMISING → **KILL** | Harness surrogate p=0.013 was single-best-config over a searched grid; family-wise MAX-stat p≈0.24 (real-best 0.994 < surr95 1.19), and it fails honest-N DSR at the full grid. Also inverts on ETH. |
| 2 | `Q9-LOWVOL` | Cross-sectional low-volatility anomaly (β-neutral L/S) | PROMISING → **KILL** | Single-best-config surrogate p=0.002 masked a searched 96-config grid; family-wise MAX-stat p≈0.06 (seed-sensitive) and it fails honest-N DSR 0.476 @N=96 + Harvey-Liu adjP 0.673. |
| 3 | `O3-NVTS` | Fee-revenue NVT signal (free proxy, causal contrarian) | PROMISING → **KILL** | Harness surrogate p=0.005 phase-randomized only the one winning signal; family-wise MAX-stat over the actually-searched N=312 grid gives p=0.093 (real-best 1.332 < surr95-max 1.384) and DSR @N=312 = 0.894 fails. The N=54 carve-out was a post-hoc argmax. |
| 4 | `VRP-HARVEST` | VRP harvest + crash-gate (BTC/ETH options) | PROMISING → **KILL** | A 2021 DVOL-onset regime artifact: leave-2021-out Sharpe 1.257 → 0.560, post-2021 DSR@N=1 only 0.842; the favorable consume-once holdout was lucky split-placement. Already fails DSR 0.389 @N=90 + PBO 0.50. |

**Net effect on the count:** raw 6 PROMISING → audited 2 PROMISING; the four flips move to
KILL. No KILL was found to be a false-KILL anywhere in the audit (no real edge was wrongly
discarded), so no flip ran in the other direction.

### The two PROMISING survivors *as of 2026-06-01* (magnitude caveats only)

> **Superseded:** the XS Donchian survivor below was later flipped to KILL on 2026-06-09 once
> its survivorship caveat was resolved on the honest point-in-time panel (see the section at
> the top of this changelog). The dated-futures carry is now the **sole** PROMISING.

- **XS Donchian channel-position long-short (`D1-LS-DONCH`)** — structure real on the survivor
  panel (XS-shuffle p=0.009), but the 388-row consume-once holdout magnitude is ~zero
  (DSR@N=1=0.79) and erodes toward 0/negative once borrow on the continuous short notional is
  charged. Held PROMISING with a survivorship + financing caveat until 2026-06-09, then
  flipped to KILL (survivorship).
- **Dated-futures basis carry (`D8-C6-DATED`)** — the levered headline was cut ~2× by a
  financing leak (RF charged on 1 unit while the book is ~2.95×-levered; levered DSR 0.13).
  Only a thin **unlevered** market-neutral excess survives (~4.9%/yr, t=2.41, ~$475/mo),
  sub-every-multiple-testing bar. Stays PROMISING as **unlevered-thin only** — now the sole lead.
