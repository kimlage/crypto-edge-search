# Research Changelog — audited verdict flips

A dated log of every place the cross-domain adversarial audit overrode a per-domain raw
verdict. The canonical state lives in `output/results-ledger.json` (see
`docs/CANONICAL_STATE.md`); this file records *why* each `auditedVerdict` differs from its
`rawVerdict`.

Each flip below has a matching entry in the ledger whose `auditOverrideReason` carries the
same justification, and is required by the schema/validator precisely because the verdicts
differ.

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

### The two PROMISING survivors (no flip; magnitude caveats only)

- **XS Donchian channel-position long-short (`D1-LS-DONCH`)** — structure real (XS-shuffle
  p=0.009), but the 388-row consume-once holdout magnitude is ~zero (DSR@N=1=0.79) and
  erodes toward 0/negative once borrow on the continuous short notional is charged. Stays
  PROMISING with a financing caveat.
- **Dated-futures basis carry (`D8-C6-DATED`)** — the levered headline was cut ~2× by a
  financing leak (RF charged on 1 unit while the book is ~2.95×-levered; levered DSR 0.13).
  Only a thin **unlevered** market-neutral excess survives (~4.9%/yr, t=2.41, ~$475/mo),
  sub-every-multiple-testing bar. Stays PROMISING as **unlevered-thin only**.
