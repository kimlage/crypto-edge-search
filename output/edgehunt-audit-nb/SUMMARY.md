# Family-Wise Audit-of-Audit — Final Verdict (Q9-LOWVOL, O3-NVTS)

**Date:** 2026-06-01
**Auditor:** independent methodology audit (`edgehunt-audit-nb`), with a second-pass audit-of-audit on each.
**Question:** Apply the SAME scrutiny that flipped the BTC reserve lead (D5-08 reserve/netflow) PROMISING→KILL — its surrogate p was a single-best-config p with no family-wise correction, and under the family-wise MAX-statistic surrogate (the correct null for a *searched* grid) it failed. Do these two provisional PROMISINGs survive?

## Plain answer

**Neither survives. Both flip to KILL — exactly like the BTC reserve lead.** The corrected count is **0 PROMISING, 2 KILL** for this batch.

Both provisional PROMISINGs rested entirely on a **single-best-config surrogate p** (Q9: harness p=0.002; O3: harness p=0.005/0.006). Under the correct **family-wise MAX-statistic null over the actually-searched grid**, both surrogate gates degrade, and both leads independently fail **honest-N Deflated Sharpe** at the full searched grid — the same failure mode (neighborhood-argmax + un-corrected surrogate) that killed reserve.

| Lead | Verdict | Family-wise surrogate p (searched grid) | Harness single-config p | Honest-N DSR (full grid N) | Financing-corrected net Sharpe |
|---|---|---|---|---|---|
| **Q9-LOWVOL** | **KILL** | **~0.06** (corrected, coherent null; the audit's 0.397 was an inflated independent-per-config null) | 0.002 | **0.476** @ N=96 (Harvey-Liu adjP 0.673) | **0.877** (20%/yr borrow) |
| **O3-NVTS** | **KILL** | **0.093** @ broad N=312 (real-best 1.332 < surr95-max 1.384) | 0.005 / 0.006 | **0.894** @ N=312 (vs 0.968 only on the post-hoc N=54 carve-out) | **~1.31** (6% borrow, not binding) |

---

## Q9-LOWVOL — KILL (verdict CONFIRMED; headline surrogate number corrected down)

**Reproduced to the digit** (audit and audit-of-audit agree): real grid-best net Sharpe **1.1229** (`vw90_bw90_hd14_fr0.2_bn1`, the argmax of a 96-config grid); honest-N DSR @ N=96 p=**0.4763** (daily Sharpe 0.0588 < expected-max 0.0602) → FAIL; Harvey-Liu Bonferroni adjP **0.6727** → FAIL; financing on the realized 0.349 short notional at 20%/yr → net Sharpe **0.877** and DSR@96 0.273; OOS holdout +2.078 inside a survivorship-biased all-alive 30-coin panel (LUNA/FTT/UST absent).

**Material correction to the audit's headline surrogate.** The first audit claimed a decisive family-wise **p=0.397** (real-best 1.123 < surr95-max **1.422**), framed as "indistinguishable from chance — the same correction that flipped BTC reserve." The audit-of-audit found this is **mis-derived**: that null gave each of the 96 configs an effectively-independent permutation stream (RNG consumed at different rates by different rebalance cadences), and a MAX over 96 near-independent nulls is extreme-value **inflated**. The reproduction of that inflated construction (p=0.457, surr95=1.424) confirms the audit used it.

Rebuilt the **precedent-faithful coherent null** (one shared per-day coin-permutation realization applied to all 96 configs, then grid-MAX — the method in `scripts/edgehunt-audit/d5_08_familywise_surrogate_v2.ts` and `d7-18-fullfamily-maxstat.ts`): surrMean **0.594**, surr95 **~1.13–1.19**, family-wise **p ≈ 0.06** (0.052 / 0.074 / 0.066 across 3 seeds) → **borderline FAIL, seed-sensitive**, NOT a 0.40 knockout. Calibration check: coherent surrMean/real = **0.53** here vs **0.89** in D5-08 — so the real best sits **above** the coherent noise ceiling, unlike reserve where the ceiling genuinely reached the real best. The surrogate is therefore a **secondary, borderline contributor** for Q9, not the decisive flip.

**What actually kills Q9 (robust, surrogate-independent):** honest-N DSR **0.476** and Harvey-Liu **0.673** fail by wide, fully-reproducible margins; financing only deepens it; the +2.08 holdout cannot rescue a strategy failing honest-N DSR inside a survivorship-biased panel; the "pre-registered N=1" escape (DSR@1=0.993) is unavailable because the canonical config IS the argmax of the 96-grid, so N=96 binds. **KILL on these gates alone.**

Artifacts: `scripts/edgehunt-audit-nb/q9_familywise_surrogate.ts`, `q9_familywise_verify.ts`, `q9_familywise_coherent.ts`; `output/edgehunt-audit-nb/q9_familywise_surrogate.json`, `q9_familywise_coherent.json`, `q9_audit_of_audit.json`.

## O3-NVTS — KILL (verdict CONFIRMED; all numbers reproduced to the digit)

**Reproduced to the digit** (audit and audit-of-audit agree, and the committed harness `result_nvts_btc.json` independently corroborates honestN=312, verdict PROMISING bound by DSR): real grid-best net Sharpe **1.3316** (`fee, sma=30, zWin=730, band` — the argmax CORNER: shortest sma, longest zWin).

**Family-wise surrogate over the actually-searched grid.** The harness gate (p=0.005/0.006) phase-randomizes **only the one winning signal** — a single-config placebo, the identical flaw that flipped reserve. Under the correct MAX-statistic null (scramble every signal, rebuild ALL configs, take per-surrogate grid-MAX, 1000 surrogates):
- **BROAD N=312 (actually-searched space): real-best 1.332 < surr95-max 1.384 → family-wise p = 0.093 → surrogate gate FAILS.**
- Restricted N=54: surr95-max 1.312, p=0.041 → only a marginal pass, and only on the post-hoc carve-out.

**Honest-N.** DSR @ N=54 = 0.968 (pass) but @ **N=312 = 0.894 (FAIL)**. The N=54 fee-only restriction was applied *after* the broad grid produced PROMISING and DSR failed — a post-hoc carve-out riding an argmax, not a frozen mechanism. The winner sits far from the documented Kalichkin 90d-MA mechanism, which gives only 1.032 (band) / 0.74 (pre-registered `avoidHigh`, surrP=0.066). Honest trial count = **312**.

**Financing** (short leg ~19.7% of days): borrow barely moves it — net 1.33 → ~1.31 at 6%, 1.26 at 20%; DSR@312 stays ~0.88 (FAIL) at every level. **Not binding.** **Cross-asset:** ETH KILLs (holdout −0.585, PBO 0.500) — no confirmation; BTC-only free fee-proxy NVT.

Artifacts: `scripts/edgehunt-audit-nb/o3_familywise_surrogate.ts`, `o3_honestN_financing.ts`, `o3_argmax_check.ts`; `output/edgehunt-audit-nb/o3_familywise_surrogate.json`, `O3-NVTS_AUDIT.json`.

---

## Corrected count

**This batch: 0 PROMISING, 2 KILL.** Both Q9-LOWVOL and O3-NVTS flip PROMISING→KILL, the same way the BTC reserve lead did: a single-best-config surrogate p masking a searched grid, plus an honest-N Deflated Sharpe failure at the full grid size. Neither survives as PROMISING.

(For Q9 specifically, the audit's decisive family-wise surrogate p was over-stated — corrected from 0.397 to ~0.06 — but this does not change the verdict: Q9 is killed robustly by honest-N DSR 0.476 and Harvey-Liu 0.673, with the surrogate only a borderline secondary contributor. For O3, the family-wise surrogate p=0.093 is the decisive, fully-reproduced flip.)

VERDICT: KILL | family-wise surrogate p Q9 ~0.06 (corrected coherent null; audit's 0.397 was an inflated independent-per-config null) and O3 0.093 (broad N=312) vs harness single-config p 0.002 / 0.005 | honest-N DSR Q9 0.476 @N=96, O3 0.894 @N=312 | financing-corrected net Sharpe Q9 0.877 (20%/yr), O3 ~1.31 (6%) | both provisional PROMISINGs rested on single-best-config surrogate p's masking searched grids and both fail honest-N DSR at the full grid — same failure mode as the killed BTC reserve lead, so both flip to KILL; corrected batch count 0 PROMISING, 2 KILL.
