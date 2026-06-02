# EdgeHunt Methodology Audit — Synthesis (9 batches)

Date: 2026-06-01. Branch: `codex/crypto-rebuild-plan`. Scope: two-layer adversarial review (audit + audit-of-audit) of every batch that produced a verdict — `consensus`, `D1`, `D2`, `D5`, `D6`, `D7`, `D348`, `requeue`, `deepen`. All disputed numbers below were re-derived from the committed primitives in `src/lib/training/statistical-validation.ts` and persisted under `output/edgehunt-audit/`.

---

## (1) OVERALL TRUST VERDICT

**The campaign's verdict *directions* are TRUSTWORTHY; its verdict *labels and headline magnitudes* are NOT fully trustworthy and require two corrections before any external sharing.**

Across all 9 batches, no KILL was found to be a false-KILL (no real edge was wrongly discarded — every spot-run of a "survivor candidate" collapsed out-of-sample, on a matched baseline, or on honest-N deflation), and the campaign's deliberately conservative posture ("nothing deployable") is correct. The committed gauntlet — net-of-cost, matched-exposure baselines, Deflated Sharpe at honest N, CPCV/PBO, Harvey–Liu haircut, claim-matched surrogate nulls, consume-once holdouts — is correctly implemented and, in the great majority of cases, correctly applied.

But trust is capped at **MINOR-to-MATERIAL** by a consistent pattern: **the headline framing systematically overstates the strongest leads, and one carried PROMISING does not survive the standard the campaign itself mandates.** Specifically:

- **One verdict must change (D5-08 reserve/netflow): PROMISING → KILL.** The harness ran the phase-randomization surrogate on only the single in-sample-selected grid-best config with no family-wise correction (p=0.013 → PASS). Under the family-wise MAX-statistic surrogate the STANDARD requires for a searched family, the surrogate gate FAILS (p≈0.23–0.27, real best 0.994 < surr95 ≈1.19). That gate is the floor under PROMISING, so the campaign's lone D5 carry should be KILL. This is the **same neighborhood-argmax error class (ii)** the deepening already caught on reserve — the deepening corrected the *economics* (DSR cap) but did not propagate the correction to the *surrogate gate*, where it actually flips the label.
- **Headline magnitudes on the two carries that touch leverage/shorts are inflated by uncharged financing** (error class i), already corrected in prose by the deepening for dated-futures but **persisted incorrectly in the committed artifact**, and not yet reflected for Donchian.

Net: the bottom-line story ("0 SURVIVE, nothing deployable") holds and is if anything *stronger* than reported (the corrected count is 0 SURVIVE, 2 PROMISING, not 3). The defects are overstatement and one mislabel, not fabricated edge.

**Per-batch trust roll-up:**

| Batch | Audit verdict | Verifier verdict | Synthesis |
|---|---|---|---|
| consensus | MINOR-ISSUES | MINOR (load-bearing headline overstatement) | Dated-futures headline must be RF-charged; no verdict flip |
| D1 | TRUSTWORTHY | TRUSTWORTHY (but audit's *reasoning* wrong) | KILLs correct; surrogate-fairness rationale invalid — fix the *why*, not the *what* |
| D2 | TRUSTWORTHY | TRUSTWORTHY | Sound; 3 low nits, no flips |
| D5 | TRUSTWORTHY | **NOT trustworthy — 1 flip** | **D5-08 PROMISING → KILL** under family-wise surrogate |
| D6 | TRUSTWORTHY | TRUSTWORTHY | Sound; lottery-fairness independently re-confirmed |
| D7 | TRUSTWORTHY | TRUSTWORTHY (1 narrative correction) | KILLs correct; audit's DSR-at-low-N claim is inverted |
| D348 | MINOR-ISSUES | MINOR-ISSUES | 2 med doc defects (broken residual-alpha metric; M3 mis-attributed kill); no flips |
| requeue | TRUSTWORTHY (1 med note) | TRUSTWORTHY | Donchian PROMISING overstated by financing; no flip |
| deepen | MINOR-ISSUES | MINOR-ISSUES | Dated correction lives only in prose, not in committed JSON |

---

## (2) CONFIRMED ISSUES vs DISMISSED FALSE-ALARMS

### CONFIRMED (survived audit-of-audit)

| Batch | Hypothesis | Type | Corrected verdict / number |
|---|---|---|---|
| consensus / deepen | Dated-futures cash-and-carry | Financing leak (i) | At the **levered** RF charge (avg lev 2.95×): Sharpe **1.64 → 0.69**, ann ret **12.6% → 5.4%**, **$1062 → $447/mo**, DSR@honestN **0.58 → 0.13**. Stays PROMISING-but-thin (unlevered excess ~4.9%/yr survives). Headline must be re-anchored. |
| consensus | Dated-futures (consensus framing) | Overstated PROMISING (ii) | At minimum-indisputable RF (4.5% on the cash leg) DSR drops **0.970 → 0.395** (FAILS the 0.95 gate it was reported to pass); kill-point is RF itself, not an exotic 6–8% borrow. Argmax-of-16 (ranks 2/16), DSR correctly deflated — low severity. |
| **D5** | **D5-08 reserve / netflow** | **Surrogate = multiple-testing artifact (ii/vii)** | **PROMISING → KILL.** Harness surrogate p=0.013 is single-best-config, no FWER. Family-wise MAX-stat: p≈**0.23–0.27**, real 0.994 < surr95 **1.19**. Surrogate gate FAILS → core gate fails → KILL. Corrected batch: 8 KILL, 0 PROMISING. |
| D348 | D4-M1 / D4-M3 | Broken/tautological metric | `residual_alpha_sharpe = sharpe(OLS residuals)` is ~0 **by construction** (mean exactly 0). The "residual-alpha ≈ 0 → timed beta" narrative is unsupported. Correct beta-hedged alpha is large in-sample (M1 t=3.17, M3 t=3.13). KILLs stand on holdout collapse, not this metric. |
| D348 | D4-M3 (52-wk-high) | Kill mis-attributed | KILL correct but NOT for the stated reasons. Real binding gate = Harvey–Liu haircut → 0 (binds even at lenient N=6) + liquidity decay (1.04→0.51) + survivorship. The cited DSR@N=30 is N-inflated and the NF1 surrogate is actually PASSED. |
| requeue / deepen | D1-LS-DONCH (XS Donchian) | Financing leak (i) | 2×-gross dollar-neutral book holds ~1.0× short notional daily; zero borrow charged. Consume-once holdout **0.53 → 0.35** at 10%/yr borrow, **→ ~0 / negative** at 20–30% (alts: DOGE/AVAX/INJ etc.). Stays PROMISING but OOS Sharpe should be reported as a range ~0.3–0.5, not 0.53. |
| deepen | Dated-futures artifact | Persistence gap | The committed `dated_futures_carry_deepen_report.json` still asserts the **leaked** PROMISING headline (Sharpe 1.639, $1051/mo); the ~2× correction exists only in SUMMARY prose. Self-contradiction proof: report's `excessOfRF annRet 12.61%` > `absolute annRet 8.03%` (impossible unless RF charged on 1 unit vs lev). |

### DISMISSED (flagged but NOT real / correctly handled)

| Batch | Hypothesis | Alleged issue | Why dismissed |
|---|---|---|---|
| consensus | VRP harvest | Surrogate too weak/strong | Shuffled-VRP placebo is the correct sizing-skill null and HAS power (placebo ~1.0–1.26 vs observed 1.36, p=0.14). Correctly read; conservatively PROMISING fails its own gates. |
| D1 | Supertrend / CCI | "Surrogate null confirmed fair" | The audit's fairness *rationale* is wrong (the vol-preserving surrogate IS too powerful, +0.75–1.09 Sharpe of inflated long-beta) — but both KILLs survive on surrogate-INDEPENDENT legs (CCI deflated paired-excess-vs-RSI=0.371; Supertrend negative excess-over-B&H return). Verdicts dismissed-as-correct; reasoning flagged. |
| D2 | LIQ / LT / Amihud | Various gate nits | beats-buyhold annualization bug (~15× B&H understatement) is real but immaterial (leg dies earlier on DSR/net-Sharpe); LT argmax & Amihud regime-artifact correctly overruled by DSR/boot-CI. 8/8 KILLs sound. |
| D6 | M1 / M4 / S5 | Possible false-KILL | Matched-exposure lottery re-tested cost-fair (p95 1.726 > real 1.548) — not an over-powered kill; M4 OOS inversion robust across 50/60/70 splits; no look-ahead. All KILLs correct. |
| D7 | D7.1 / D7.18 / D7.19 | In-sample residualization, DSR framing | D7.18 survives stricter full-128-cell family-wise null (p=0.183); D7.1 long-beta-trap fails independently; residualization biases toward survival yet still KILLs. (Audit's "DSR can't reach 0.95 at N=2" claim is factually inverted — DSR is *easier* at low N — but verdict unaffected.) |
| D5 / D348 | mvrvz short-borrow | Financing leak | Only longshort best has shortShare 2.1% and already fails baselines; charging borrow only deepens KILL. Immaterial. |

---

## (3) VERDICTS THAT SHOULD CHANGE — and the "elsewhere" check

The task asks specifically: the deepening already corrected **dated-futures (financing leak)** and **reserve (neighborhood-argmax)** — do similar issues exist ELSEWHERE? Answer: **yes, both error classes recur, and one recurrence flips a label.**

**A. Verdict that MUST change:**
- **D5-08 reserve/netflow: PROMISING → KILL.** This is the *same* neighborhood-argmax issue the deepening flagged on reserve, but the deepening stopped at the DSR economics cap and never propagated it to the **surrogate gate**. Under the family-wise MAX-stat surrogate the STANDARD mandates for a searched grid, the surrogate gate FAILS (p≈0.23–0.27 vs the harness's un-corrected 0.013). Surrogate is a core gate, so the only D5 carry should be KILL. **Corrected campaign tally: 0 SURVIVE, 2 PROMISING (Donchian, dated-futures-unlevered), ~51 KILL** — down from the "3 PROMISING" currently in the docs.

**B. PROMISING leads to DOWNGRADE in magnitude (not flip):**
- **Dated-futures basis carry** — the financing-leak (class i) recurrence. Levered headline (Sharpe 1.64 / $1062/mo / DSR 0.58) collapses to Sharpe 0.69 / $447/mo / DSR 0.13 at the correct levered RF charge; only a thin **unlevered** market-neutral excess (~4.9%/yr, t=2.41, ~$475/mo) survives, sub-every-multiple-testing-bar. Already corrected in deepen prose — must be propagated to the committed JSON artifact and to the consensus headline.
- **XS Donchian L/S** — the financing-leak (class i) recurrence in a 2×-gross short book. Honest OOS Sharpe is a *range* ~0.3–0.5 (10% borrow) trending to ~0/negative under expensive alt borrow, not the reported point 0.53. Stays PROMISING with a mandatory financing caveat.

**C. NO false-KILL found anywhere.** Every batch's audit-of-audit specifically hunted a real-edge-wrongly-killed and found none: D6 lottery baseline is cost-fair, not over-powered; D1 KILLs hold on surrogate-independent legs; D2/D5/D7 KILLs all fail on autocorr-robust or family-wise gates. The campaign does not discard a live edge.

**Recurrence summary:** financing-leak (i) is **systemic** — it appears in *every* short/levered book in the campaign (dated-futures, Donchian, Bollinger, Ichimoku, mvrvz, GARCH vol-timing). It only changes magnitude on the two PROMISING carries; on all KILLs it deepens the kill. The neighborhood-argmax (ii) recurs on D5-08 and there it flips the label.

---

## (4) AGENTS.md COMPLETENESS / CORRECTNESS REVIEW

Every file-existence claim in the AGENTS.md audit was independently re-verified against disk **and full git history**. The audit's *proposed edits are directionally correct and should be applied*, but two of its stated *justifications are factually wrong* and the edit text is softened accordingly:

- **CORRECTION to the audit's rationale (Issue 1):** `src/lib/validation/strategy-validator.ts` is **NOT** "never committed." `git log --all` shows it on `oss-release`, `feat/significance-consolidation`, and `archive/ga-alpha-engine` (commits `7cc6d1b3`, `7100d4cb`, `ec6fa9a0`). It simply **does not exist on this branch** (`codex/crypto-rebuild-plan`). The correct framing is branch-scoped, which AGENTS.md line 181 already states correctly. Drop any "never committed / git log empty" claim.
- **CORRECTION to the audit's rationale (Issue 2):** `src/lib/training/significance/*` **DOES exist** on other branches (commits `78e6084d`, `8c58feb9`, `7cc6d1b3` are `feat(significance):` work). It is **absent on this branch only**. The audit's "the task brief's premise is itself wrong / does not exist anywhere" is overstated; the accurate statement is "not on this branch."
- **CONFIRMED:** `harness.ts:23` imports only from `../../src/lib/training/statistical-validation.ts`; exports are `summarizeReturnSeries, computeProbabilisticSharpeRatio, computeDeflatedSharpeRatio, blockBootstrapConfidenceInterval, analyzeThresholdSensitivity, estimateCscvPbo`. The gate chain is documented in the harness header (lines 9–12) but NOT in AGENTS.md.
- **CONFIRMED:** `output/backlog/` contains 6 files (`d1-classic-ta-and-price-action.md, d2.md, D4.md, d5-onchain-crypto-native.md, d6-sentiment-cross-asset-macro.md, d7.md`) — no `D3.md`, no `D8.md`.
- **MUST ALSO CHANGE (not in the audit's list):** Issue-3's "0 SURVIVE, **3 PROMISING**, 1 KILL" should become **0 SURVIVE, 2 PROMISING, ~51 KILL** to reflect the D5-08 reserve flip.

### Proposed AGENTS.md edits (verbatim-applyable)

**EDIT 1 (line 180) — replace the stale `strategy-validator.ts` reference:**
- FIND: `to falsify through the committed gauntlet (\`src/lib/validation/strategy-validator.ts → validateStrategy\`), same methodology/criteria`
- REPLACE: `to falsify through the committed gauntlet (gate primitives in \`src/lib/training/statistical-validation.ts\` — \`computeDeflatedSharpeRatio\`, \`estimateCscvPbo\`, \`blockBootstrapConfidenceInterval\`, \`summarizeReturnSeries\` — chained by per-domain \`runGauntlet\` wrappers, e.g. \`scripts/edgehunt-D5/harness.ts\`; the \`src/lib/validation/strategy-validator.ts → validateStrategy\` single-entry wrapper named in \`docs/BACKLOG.md\` exists on the \`oss-release\`/\`feat/significance-consolidation\` branches but is NOT present on this branch), same methodology/criteria`

**EDIT 2 (line 181 NOTE) — correct the `significance/*` path claim:**
- FIND: `the committed gate primitives are in \`src/lib/training/statistical-validation.ts\` + \`src/lib/training/significance/*\`, chained by per-domain \`runGauntlet\` wrappers (e.g. \`scripts/edgehunt-D5/harness.ts\`).`
- REPLACE: `the committed gate primitives are in \`src/lib/training/statistical-validation.ts\` (\`computeDeflatedSharpeRatio\`, \`estimateCscvPbo\`, \`blockBootstrapConfidenceInterval\`, \`summarizeReturnSeries\`), chained by per-domain \`runGauntlet\` wrappers (e.g. \`scripts/edgehunt-D5/harness.ts\` imports them directly at line 23). The \`src/lib/training/significance/*\` directory exists on the \`oss-release\`/\`feat/significance-consolidation\` branches but is NOT present on this branch — references to it here, in \`scripts/edgehunt-quant/q5tod-gauntlet.ts\`, and in \`docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md:302\` are branch-stale.`

**EDIT 3 (line 181) — update to the adversarially-verified final result:**
- FIND: `Result: **0 clean SURVIVE, 4 PROMISING leads, ~50 KILLs.** Leads (all capped by honest-N Deflated Sharpe — curable only by pre-registration — plus a generalization/decay caveat): (1) **BTC exchange reserve-depletion / netflow** — the closest to a survivor: a single PRE-REGISTERED config clears DSR@N=1 on the consume-once forward tail (net Sharpe 1.265, price-orthogonal, ~$1,858/mo@$100k) but inverts on ETH (free flow data only for BTC+ETH ⇒ likely BTC-specific); (2) **XS Donchian channel-position long-short** — beta-neutral (α t=3.56), passes cross-sectional-shuffle null p=0.002 + haircut, ~$4,116/mo canonical, fails DSR@N=72 + OOS decay + survivorship; (3) **dated-futures basis carry** ~$640/mo (term-structure alpha beyond perp funding, survives low-funding regime); (4) **VRP harvest + crash-gate** ~$495/mo. Per-domain detail in \`output/edgehunt-*/SUMMARY.md\`; reserve follow-up in \`output/edgehunt-D5-followup/VERDICT.md\`.`
- REPLACE: `First-pass result: 0 clean SURVIVE, 4 PROMISING leads, ~50 KILLs. **After deepening + a two-layer adversarial audit (2026-06-01, \`output/edgehunt-audit/SUMMARY.md\`, \`output/edgehunt-deepen/SUMMARY.md\`) the FINAL call is: 0 SURVIVE, 2 PROMISING, ~51 KILL — nothing deployable.** Verified leads (both blocked at the PROMISING/SURVIVE boundary by honest-N magnitude-significance on unseen data, and both with a financing caveat): (1) **XS Donchian channel-position long-short** — beta-neutral, structure real (XS-shuffle p=0.009), but the 388-row consume-once holdout magnitude is ~zero (DSR@N=1=0.79, NW t(mean)=0.96) and erodes from ~0.53 toward 0/negative once borrow on the continuous ~1.0× short notional (alts: DOGE/AVAX/INJ…) is charged — OOS Sharpe is a range ~0.3–0.5, not a point; (2) **dated-futures basis carry** — headline cut ~2× by a financing leak (RF charged on 1 unit while the book is ~2.95×-levered; levered DSR 0.13, ~$447/mo); only a thin UNLEVERED market-neutral excess survives (~4.9%/yr, t=2.41, ~$475/mo), sub-every-multiple-testing-bar. DROPPED from the lead list: **BTC exchange reserve-depletion** — the "pre-registered" config is the ARGMAX of a searched ~12-config neighborhood; under the family-wise MAX-stat surrogate the standard requires, the surrogate gate FAILS (p≈0.24 vs surr95 ≈1.19; harness's 0.013 was single-config, no FWER) → **KILL, not PROMISING** (also inverts on ETH); and **VRP harvest + crash-gate** — a 2021 DVOL-onset regime artifact, **KILL**. Per-domain detail in \`output/edgehunt-*/SUMMARY.md\`; reserve follow-up in \`output/edgehunt-D5-followup/VERDICT.md\`; audit round in \`output/edgehunt-audit/SUMMARY.md\`.`

**EDIT 4 (line 180) — fix the phantom `D3.md` / `D8.md` source files:**
- FIND: `Source per-domain files in \`output/backlog/\` (d1-classic-ta-and-price-action.md, d2.md, D3.md, D4.md, d5-onchain-crypto-native.md, d6-sentiment-cross-asset-macro.md, d7.md, D8.md).`
- REPLACE: `Source per-domain files in \`output/backlog/\` (present on this branch: d1-classic-ta-and-price-action.md, d2.md, D4.md, d5-onchain-crypto-native.md, d6-sentiment-cross-asset-macro.md, d7.md — the D3 and D8 per-domain files are referenced by \`docs/BACKLOG.md\` §8 but are NOT committed here; their hypotheses are folded into the master table + \`output/edgehunt-D348/\`).`

**EDIT 5 (insert a new RULES bullet immediately after the line-181 bullet) — codify the campaign-revealed gauntlet rules:**
- INSERT:
`- **Edge-search gauntlet — committed RULES (every hypothesis MUST clear ALL, in this binding order):** the harness chain is \`net_of_cost → baselines → deflated_sharpe → block_bootstrap → cpcv_pbo → haircut → surrogate → holdout\` (see \`scripts/edgehunt-D5/harness.ts::runGauntlet\`); the binding gate is the FIRST failure. SURVIVE = all pass; PROMISING = passes net+baselines+surrogate+holdout but trips a multiple-testing/DSR gate; else KILL.`
`  - **Net-of-cost:** taker ~4 bps/side (\`COST_PER_SIDE=0.0004\`) on EVERY position change; financing/borrow charged on the FULL levered/short notional, NOT 1 unit. (The dated-futures leak: RF on 1 unit while ~2.95×-levered collapsed Sharpe 1.64→0.69, DSR 0.58→0.13; the Donchian leak: borrow on the continuous ~1.0× short notional erodes the OOS holdout 0.53→~0.) This omission recurs in EVERY short/levered book — on a KILL it only deepens the kill, but it inflates the two PROMISING carries.`
`  - **Right baseline per claim:** buy-&-hold AND, for any TIMING/overlay, a MATCHED-EXPOSURE benchmark (exposure-matched random-lottery / matched-leverage) — a low-exposure long/flat overlay structurally cannot out-Sharpe 100%-long B&H, so scoring it only vs B&H is an artifact; for CROSS-SECTIONAL books require BETA-NEUTRALITY (book β≈0, alpha-t on the residual) using an HONEST-OOS hedge beta, never an in-sample-fit over-hedge.`
`  - **Honest N counts EVERY config tried, and the surrogate must be FAMILY-WISE.** A PRE-REGISTERED config must be FROZEN from mechanism BEFORE any neighborhood search and must NOT be the argmax of a searched grid — else honest N = grid size, not 1, AND the surrogate null must use the family-wise MAX-statistic, not the single-best-config p (the D5-08 reserve flip: harness surrogate p=0.013 was single-config; the family-wise MAX-stat is p≈0.24 → FAIL → KILL, not PROMISING). Apply Deflated Sharpe @ honest N, CPCV/PBO<0.5, and the Harvey–Liu haircut — and note the haircut, not the DSR, is often the true binding gate (the 52-wk-high KILL binds on haircut→0 even at lenient N=6).`
`  - **Right surrogate null per claim:** time-series timing → phase-randomization / block-bootstrap; rotation/relative-value → cross-sectional shuffle; path-dependent exits → bracket-on-surrogate; vol-clustering → GARCH-simulated zero-edge; variance-risk-premium → shuffled-VRP placebo; calendar/event → calendar-reanchor + family-wise MAX-statistic. A surrogate PASS proves structure/sign is non-random — it does NOT prove the realized mean is positive-with-significance at honest N on unseen data; that gap is exactly the PROMISING/SURVIVE boundary, and no 2026-06 lead crossed it.`
`  - **Beware the too-powerful vol/spectrum-preserving surrogate:** a structure-preserving surrogate of a long-flat price-transform overlay can INFLATE shared long-beta (Supertrend/CCI surrogates scored +0.75–1.09 Sharpe above their real passive long) — judge such overlays on the long-beta-DIFFERENCED lift (overlay − matched passive in the SAME surrogate world), not the raw surrogate Sharpe.`
`  - **Avoid tautological metrics:** \`sharpe(OLS residuals)\` is ~0 BY CONSTRUCTION (residual mean is exactly 0) and proves nothing about alpha — use \`sharpe(y − β·x)\` for beta-hedged alpha. **h=0 leakage gate:** report the contemporaneous ceiling, then require the strictly-lagged (h≥1) component to clear the gates ALONE. **Consume-once holdout is spent once;** survivorship-biased panels (LUNA/FTT absent) make even the holdout an upper bound — rebuild the universe point-in-time before promotion.`

**Net AGENTS.md assessment:** No prior KILL/PROMISING verdict in the underlying methodology was mis-applied in a way the index hides — the defects are all index staleness/correctness: two branch-stale path references (correct conclusion, wrong "never committed" rationale — softened above), a results section frozen at the pre-verification first pass (now also needing the D5-08 flip), two phantom source files, and the campaign-revealed RULES not yet codified. Apply Edits 1–5 verbatim.
