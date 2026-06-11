# Project Review — Full State, New Angles, and the Honest Path Through the Gauntlet (2026-06-09)

> **One-file complete review** of the crypto-edge-search program: where it stands after the audits,
> what the codebase actually implements (and what it only claims to), a quantitative **power analysis**
> the program had never written down, a **63-agent adversarially-judged search for new edge angles**
> (24 candidates, 48 judge verdicts), and the resulting plan: what to run today at $0, what to
> pre-register forward, and the one trade construction that can *legitimately* pass all 8 gates
> with zero recurring cost. English per the public-docs rule; private-first per AGENTS.md.

---

> **UPDATE (2026-06-09, post-W5):** the §5A.1 delisted-inclusive PIT replay was executed the same day
> and **flipped XS Donchian to KILL** — the PROMISING was substantially survivorship (honest panel:
> 161 ever-member assets vs 30, overlap 16.8/30; family-wise XS-shuffle p 0.002→0.103; alpha t
> 3.22→1.60; binding gate deflated_sharpe, DSR 0.451 @ N=72). Parity 9/9 against the published
> numbers was proven before trusting the new panel. **Program tally is now 0 SURVIVE / 1 PROMISING
> (dated-futures basis, unlevered-thin) / ~110 KILL.** Campaign E1's forward watch carries a
> correspondingly weak prior (see `docs/campaign-E/E1-STAGE1-ADDENDUM.md`). Details:
> `scripts/edgehunt-donchian-pit/RESULTS.md`; machine-readable: `output/results-ledger.json`.

## 0. TL;DR

1. **Branch integration done (2026-06-09).** `master` had been parked on the 2022 initial commit while
   all 84 commits lived on `codex/crypto-rebuild-plan`. Master is now fast-forwarded and pushed; the
   four local-only branches (`feat/significance-consolidation`, `oss-release`, `main` [retired
   GA-neural lineage], `archive/ga-alpha-engine`) are backed up on origin. The in-progress X-thread v9
   work and the D3/D8 hypothesis backlogs were committed (`c70f9719`). No work front was lost.
2. **Program state (audited):** ~111 hypotheses, **0 SURVIVE, 2 weak PROMISING** (XS Donchian L/S;
   dated-futures basis carry *unlevered-thin*), everything else KILL. Three earlier PROMISINGs
   (reserve-depletion, Q9 low-vol, O3 fee-NVT) were flipped to KILL by the two-layer family-wise
   audit — all on the same defect. *(Supersedes the older "4 PROMISING leads" framing.)*
3. **New quantitative finding — the power wall (§3).** Passing the gauntlet at honest N=1 on a
   forward window requires an **observed** annualized Sharpe of ~2.8 in 26 weeks, ~1.4 in 2 years,
   ~1.0 in 4 years. At the leads' honest Sharpe range (0.3–0.8), **no current lead — not even an
   ensemble of both — can pass in a practical horizon** (8–16+ years at 80% power). This single table
   reorganizes the entire roadmap: it splits candidates into "can be falsified quickly" (always
   feasible — that is the lab's product) vs "can plausibly SURVIVE" (requires a mechanism with
   in-regime Sharpe ≥ 2 — only structural/contractual carry has ever shown that here).
4. **24 new candidate angles were generated and adversarially judged (§4).** None earned an
   unconditional "advance" from the kill-judge (correct, given the 0/111 base rate). The least-rejected
   cluster is exactly the **pre-registration + forward** family. Two candidates are *executable today*
   at $0 with new, decision-grade information: the **delisted-inclusive XS Donchian replay** (Binance
   data dumps retain LUNA/FTT klines — verified live) and the **Kalshi×Polymarket convergence
   backtest** (~2 years of free overlapping history; new namespace).
5. **The answer to "a trade form that can safely pass the full gauntlet at zero recurring cost" (§5):**
   a three-layer program — (A) two run-today backtests; (B) **Campaign E**: a pre-registered forward
   family (frozen configs, sha256-hashed, declared multiplicity, alpha-spending look schedule, $0
   recorders); and (C) the centerpiece: a **pre-registered regime-triggered structural-carry book**,
   dormant until funding richens, which is the only construction whose in-regime Sharpe history (>2)
   clears the power wall within ~1–2 years of triggered time. No capital deploys before SURVIVE;
   everything is paper-forward; data cost is $0 and there is no hourly/recurring infrastructure cost.
6. **OSS expansion (§6):** consolidate the gauntlet into one tested library entry point (the audit
   found 8 divergent `runGauntlet` copies and a financing-leg gap in the shared core), ship the
   missing named nulls, publish the power calculator, the machine-readable kill DB, the public
   pre-registration registry, and a community "run the gauntlet" CI. The lab's durable moat is the
   methodology — these make it compounding.

---

## 1. Where the program stands

### 1.1 The audited ledger

| Bucket | Count | Notes |
|---|---:|---|
| Hypotheses tested (all $0) | **~111** | ~35 prior rounds + 58 domain campaign 2026-06 + 18 follow-on backlog |
| Clean **SURVIVE** | **0** | nothing cleared all 8 gates on unseen data |
| Weak **PROMISING** | **2** | XS Donchian L/S; dated-futures basis (unlevered-thin) |
| Flipped PROMISING→KILL by audit | 3 | reserve-depletion, Q9 low-vol, O3 fee-NVT — same defect ×3 |
| Campaign-D (Polymarket) | 2 flagship claims KILL | copy-trading (wallet-shuffle p=0.528, top-decile OOS −$90,457); favorite-longshot (powered rerun p=0.993) |

The two PROMISING leads, honestly stated:

- **XS Donchian channel-position L/S** — structure is real (XS-shuffle p=0.002–0.009, beta-neutral,
  alpha t 3.4–3.6, PBO=0.000) but the 388-row consume-once holdout magnitude is statistically zero
  (DSR@N=1 0.79, Newey-West t 0.96) and borrow on the short notional erodes OOS Sharpe to **~0.3–0.5**.
  Survivorship-biased panel (a −90% delisting shock flips the holdout negative in 17% of draws).
- **Dated-futures basis carry, unlevered-thin** — a real market-neutral excess of **~4.9%/yr
  (t=2.41, DSR 0.60)**, sub-every-multiple-testing-bar, regime-fragile (sub-RF in 2023, −37% in the
  2021 cohort). The levered headline was a financing-leak artifact (Sharpe 1.64→0.69 corrected).

The kill taxonomy is now nine named modes (long-beta in disguise; h=0 tautology; selection inflation
under honest N; de-risking masquerading as timing; detection latency; no separable premium over a
killed parent; reverse-causality echo; price-clock spurious regression; systemic financing leak) —
see `EDGE_SEARCH_SYNTHESIS.md §3`. Every new idea in §4 was judged explicitly against these.

### 1.2 Data assets on disk (all $0, all reusable)

- **BTC 15m, 2017→2026** columnar cache (306,297 rows); 30-coin daily/weekly panel 2020→2026
  (survivorship-flagged); 8-major cross-venue 8h funding 2023→2026 (Binance/Bybit/OKX); BTC/ETH
  COIN-M quarterly basis since 2021-09; Coin Metrics Community on-chain panels back to 2012
  (BTC+ETH native exchange flow — the only 2 assets free); DVOL daily 2021-03→2026-06; FRED/stooq
  macro; **667 MB Polymarket corpus** (172,830 resolved markets, 4,663 trade tapes, sha256-pinned).
- **Verified live 2026-06-09 by the feasibility judges:** `data.binance.vision` retains **delisted**
  symbols' klines and funding (LUNAUSDT, FTTUSDT → HTTP 200) — the survivorship-free panel the
  Donchian caveat needs is **free**; Kalshi trade-api v2 is keyless (settled candlesticks + tapes,
  ~2024-Q2 onward); Deribit `get_book_summary_by_currency` serves the full option chain with
  per-strike OI free; DefiLlama `/emissions` is now **paywalled** (402) — unlock history is NOT $0,
  forward-only.
- **Forward logs already accruing:** weather forward log (188 rows since 2026-06-03), CR27/CR28
  (120d)/CR29 (60d) pre-registered, sha256-frozen — **score once on their dates, never re-tune**.
- Known $0 gaps (unchanged): point-in-time IV surfaces/greeks, L2 order-book history, exchange-grade
  multi-asset netflow, SOPR/NUPL/CDD cohorts.

### 1.3 Operational posture

Training loop deliberately OFF since 2026-05-31 (GA-neural retired; cron deleted; `crontab -l` is
empty). All forward loggers are manual daily runs. Publishing flow: private-first → public subset to
`github.com/kimlage/crypto-edge-search`; English-only public docs; X-thread v9 is Grok-critiqued and
ready in `docs/X_THREAD.md` + `docs/x-thread-assets/`.

---

## 2. Harness engineering audit (what the code actually does)

The gates' primitives are solid and tested (5 vitest tests pass; DSR/PSR/bootstrap/CSCV in
`src/lib/training/statistical-validation.ts`). The chain around them has real gaps — each one is a
documented source of the exact defects the 2026-06 audits caught:

| # | Finding | Risk | Fix |
|---|---|---|---|
| 1 | **8 divergent `runGauntlet` copies** under `scripts/` (D5 harness, campaign-D, D2 lib [subset only — missing haircut+CPCV], requeue×3, D6, D7); thresholds differ across copies (e.g. holdout: D5 `OOS Sharpe>0` vs campaign-D `mean>0 AND DSR@N=1≥0.95`) | bespoke harnesses skipping gates — the audit's headline finding | Promote the campaign-D unified `runGauntlet` to **`src/lib/validation/strategy-validator.ts`** (the path the docs already advertise), add unit + parity tests, migrate campaigns to import it |
| 2 | **No financing leg in the shared core** (`runPositions` charges taker 4 bps/side only); borrow on levered/short notional is per-script manual | "error class i" — the systemic leak that inflated both carry headlines | Add `financing: {borrowAprFn, leverageFn}` to the shared core; default-on; test with the dated-futures regression numbers |
| 3 | **Base D5 surrogate gate is single-best-config** — family-wise MAX-statistic exists only in audit scripts and campaign-D (caller-supplied) | reproduces the defect that created 3 false PROMISINGs | Build FW-MAX into the library gate; single-config null allowed *only* when `honestN===1` with a prereg hash |
| 4 | `cpcv_pbo` is **CSCV over 6 contiguous unpurged folds** — no purging/embargo, below the docs' own ≥8-fold bar | overlap leakage understates PBO | Purged/embargoed CPCV, ≥8 folds, in the library version |
| 5 | Haircut gate = Bonferroni on the PSR p (Holm/BHY computed but non-binding) | mislabeled as "Harvey-Liu" | Either implement the HLZ haircut properly or rename the gate honestly |
| 6 | **Named nulls still uncoded as primitives:** crossSectionalShuffleNull ("single most important missing null"), calendar-reanchor, IAAFT, GARCH-sim, bracket-on-surrogate | wrong-null risk for every queued D3/D8 item | Implement as tested library primitives before any new campaign |
| 7 | **Zero tests under `scripts/`**; the only wrapper control is campaign-D's synthetic planted-edge script | silent divergence | Port the planted-δ positive/negative control to the library as a CI test |
| 8 | Original fetchers for `output/carry`, `output/funding`, `output/dated-futures` are no longer in the tree | reproducibility gap vs REPRODUCIBILITY.md | Recommit minimal fetchers next to the caches |

Measured cost of a full run: ~20.6 s per hypothesis (72 configs, 600 surrogates) single-core — the
gauntlet itself is never the bottleneck; data honesty is.

---

## 3. The power wall — the math the program never wrote down

**Question:** what does it take to pass gates 3/4/6/8 at honest N=1 on a pre-registered forward
window? (Normal approximation, daily returns; the DSR's skew/kurt correction moves these numbers
slightly but not materially.)

**Required *observed* annualized Sharpe:**

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

Consequences, stated bluntly:

1. **A 26-week public forward run of any current lead cannot SURVIVE** except on a ~2.8-Sharpe fluke —
   it can only KILL or extend. Any plan that implies otherwise is theater.
2. **The 2-sleeve ensemble** (Donchian ~0.3–0.5 + basis ~0.5–0.6, ρ≈0) reaches portfolio SR ~0.7–0.85
   → **11–16 years** to 80% power. Diversification is the only legitimate power lever that does not
   raise N, but at these sleeve Sharpes it is not enough. Run it as protocol infrastructure, not as
   the thing that will produce a SURVIVE.
3. **Only mechanisms with in-regime true Sharpe ≥ 1.5–2 can pass within 1–3 years.** In ~111
   hypotheses, exactly one family has ever printed that here: **structural carry in a rich-funding
   regime** (dated-basis low-funding-regime Sharpe 2.87; 2024 funding blowout 10.99%/yr). This is
   what §5C builds on.
4. **Fast KILLs remain cheap at any Sharpe** — falsification power is asymmetric. The lab's product
   (honest negative evidence) is unaffected by the wall; only SURVIVE claims are.
5. This table itself is a publishable OSS artifact ("can your strategy even be falsified at your
   sample size?") and becomes a **pre-flight gate**: any proposed forward test must state its powered
   horizon up front or be auto-DEFERRED (the unlock-cliff and gamma-pin candidates in §4 fail exactly
   this check as scoped).

---

## 4. The new-angle search: 24 candidates, 48 adversarial verdicts

**Method.** A 63-agent workflow: 6 parallel readers built the project map (ledger, harness, data, OSS
state, backlogs, legacy); 8 idea generators with distinct lenses (structural carry/plumbing,
cross-sectional, on-chain flows, events/calendar, vol/options-at-$0, prediction markets,
methodology-as-edge, OSS-growth), each constrained by the kill taxonomy, the 155-item queued backlog
(anti-duplication), and $0 data; each of the 24 ideas was then judged by two adversarial judges — a
kill-history skeptic (default-reject) and a data/cost/feasibility auditor who **verified every
load-bearing data claim live**. A completeness critic then audited the whole result; its gaps are
addressed in §7.

### 4.1 Full verdict table

| Idea (lens) | Author p | Kill-judge | Feas-judge | Binding objection |
|---|---:|---|---|---|
| Stablecoin peg-deviation tail carry (carry) | .08 | reject .01 | reject .02 | tail-risk carry without free PIT depth data |
| COIN-M quarterly roll-window spread (carry) | .10 | reject .02 | advance .08 | roll "pressure" is two-sided; no captive payer |
| Inverse-vs-linear same-venue funding gap (carry) | .07 | reject .02 | advance .07 | wedge ≪ costs (D8-C1 class) |
| **Cross-coin funding-rank L/S carry (XS)** | .10 | reject .015 | advance .10 | **judge replayed it on cached data: funding leg +3.3%/yr but price leg −7.6%/yr — crowded longs outrun their bleed 2.3×; net −0.12, holdout −0.87** |
| **XS Donchian delisted-inclusive PIT replay + prereg fwd (XS)** | .12 | **park .04** | **advance .08** | stage-2 26-week window underpowered (needs SR~2.3); **stage-1 replay is decision-grade today** |
| Crypto betting-against-beta rank (XS) | .08 | reject .015 | advance .07 | Q9's sibling; same DSR wall |
| BTC-vs-ETH netflow divergence spread (on-chain) | .08 | reject .02 | advance .06 | built on a flipped-to-KILL parent's two free assets |
| Stablecoin float regime gate (on-chain) | .05 | reject .01 | advance .04 | gate-on-killed-signal; de-risking mode (d) |
| Bridge netflow → gas-token XS tilt (on-chain) | .10 | reject .03 | reject .01 | bridge data not PIT-honest at $0 |
| **Unlock-cliff prereg forward short (events)** | .15 | **park .03** | **park .12** | mechanism + design clean; **needs ~100–140 events ≈ 3+ yrs to power** — run as dataset+event-study first |
| Funding-interval-switch event short (events) | .10 | reject .025 | advance .12 | power wall: ~10–20 effective events, memecoin vol; (judge verified PIT detection works, universe 441/659 symbols) |
| COIN-M roll congestion calendar spread (events) | .07 | reject .005 | advance .06 | duplicate-mechanism of carry version, same objection |
| VRP-inversion long-variance (vol) | .07 | reject .01 | advance .07 | VRP family killed as 2021-onset artifact; inversion inherits N |
| DVOL−RV residual crash-gate (vol) | .04 | reject .005 | advance .03 | de-risking masquerading as timing (mode d) |
| Deribit chain recorder + risk-reversal prereg (vol) | .06 | reject .015 | park .06 | recorder valuable; the RR test itself underpowered |
| **Kalshi×Polymarket convergence spread (PM)** | .13 | reject .04 | **advance .12** | **full gauntlet executable TODAY on ~2y overlap**; kill-judge: ≥24h-persisting gaps = phantom-depth adverse selection — cure: tape-verified fills only |
| negRisk renormalization lag (PM) | .07 | reject .02 | advance .05 | latency race vs bots (H4 class) |
| Large-print impact reversion (PM) | .09 | reject .015 | advance .10 | h=0 risk; maker-fill realism unverifiable at $0 |
| **Two-mechanism prereg ensemble fwd (method)** | .10 | **park .05** | **park .08** | underpowered for SURVIVE (§3) — but ships the prereg protocol; run as infrastructure |
| **Deribit PIT recorder + gamma-pin prereg (method)** | .06 | **park .02** | **park .05** | recorder = the prize (unblocks the whole deferred options family); pin test underpowered at 60 events |
| Q9 alpha-spending forward adjudication (method) | .08 | reject .03 | park .07 | **caught: `q9_canonical.ts` already exists with known Sharpe 0.70 — "external" config is contaminated; prereg void**. Teaching case |
| **XS Donchian public 26-week prereg fwd (OSS)** | .12 | **park .06** | **park .10** | same power wall; reframe as "public forward watch", not a SURVIVE attempt |
| Deribit recorder in public CI (OSS) | .08 | reject .01 | park .07 | merge into the recorder workstream |
| **Unlock-cliff open PIT dataset + event study (OSS)** | .15 | **park .05** | **park .10** | the dataset is the durable artifact; verdict accrues over years |

**Reading the table honestly:** zero "advance" from the kill-judge is the expected outcome of a
well-calibrated skeptic facing a 0/111 base rate. The information is in *which objections bind*:
power-wall objections (curable by time or by a richer regime) vs mechanism objections (fatal). The
park cluster — Donchian PIT, unlock dataset, ensemble protocol, Deribit recorder — all bind on
**power, not mechanism**, which is exactly the profile worth pre-registering cheaply and letting time
do the work. Plus two run-today backtests with decision value either way.

### 4.2 The five that matter, in one paragraph each

1. **XS Donchian delisted-inclusive replay (run today).** `data.binance.vision` retains delisted
   klines (verified: LUNAUSDT zips to 2020-08). Rebuild the 30-coin panel point-in-time with a
   trailing-90d-dollar-volume rule (no hindsight list), re-run the *frozen canonical* config (N=1 by
   construction — config already public in the repo), full gauntlet. This resolves the program's #1
   open caveat **today, at $0**: if the edge was the survivorship bias, the flagship lead dies cleanly
   ("the edge was the dead coins" is a one-line publishable story); if it holds, the lead strengthens
   materially and the forward watch (§5B) starts from a much stronger prior.
2. **Kalshi×Polymarket convergence (run today).** New namespace (zero ledger hits for Kalshi).
   Mechanism is contractual: segmented pools, same terminal value, bounded horizon, zero exit cost
   (hold to resolution). ~2 years of free overlapping history; PM side already cached and pinned. The
   kill-judge's phantom-depth objection is real and becomes the design: **count only divergences with
   actual executed prints at the divergent price** (both venues' tapes are free), charge Kalshi's
   quadratic fee + PM gas/UMA-tail haircut, calibrated-Bernoulli-at-traded-price null (already
   implemented in `gauntlet_control.ts`), FW-MAX over a declared ≤8-config grid. Either verdict is
   high-value public content ("the loudest post-election meme, gauntleted"). *Jurisdiction note:
   verify account eligibility before any paper-execution claims (Kalshi KYC; Polymarket geo-blocks);
   a data-only verdict requires no account at all.*
3. **The pre-registration protocol + ensemble (start today, runs for years).** Frozen configs,
   sha256-hashed in the public repo, append-only $0 recorders, pre-committed alpha-spending look
   schedule. Judges parked it on power — correct — so its role is **infrastructure + content**, with
   the honest power table printed in the prereg doc itself. It also fixes the panel's survivorship
   problem automatically (forward data includes delistings live).
4. **Deribit PIT chain recorder (start today).** One daily snapshot + one at the 08:00 UTC expiry
   print of the free full chain (per-strike OI, mark IV, greeks). Costs seconds/day, $0. It is the
   *only* honest route into the entire deferred options family (GEX, skew, RR, term structure,
   Breeden-Litzenberger) — for this lab and for anyone, which makes it a flagship OSS artifact. The
   gamma-pin trade itself stays DEFERRED until the recorded N supports a powered test.
5. **Unlock-cliff open dataset (start today; verdict in years).** DefiLlama emissions went paid, so
   the honest $0 version is forward-only: sha256-freeze the next-12-month cliff calendar now
   (CryptoRank/Tokenomist free pages, each event verified against the on-chain vesting contract via
   free RPCs), log events as they pass, publish as the first open PIT-honest unlock dataset. The
   short-event-study verdict accrues at ~2–5 events/month toward the ~100–140 needed; the dataset is
   citable long before the verdict.

### 4.3 Empirical bonus already in hand

The kill-judge for the funding-rank idea **ran the replay** on the cached 8-major funding panel
(2023-06→2026-05): the funding leg alone earns +3.27%/yr at Sharpe 3.4, but the price leg loses
−7.64%/yr — crowded-long coins outperform their funding bleed ~2.3×; net Sharpe −0.12, last-12m
−0.87. Formalizing this 20-second result through the full committed gauntlet yields a free,
high-traffic teaching-case KILL of the most-recycled CT claim in the niche ("short the high-funding
coins = free money"). Cheap win for the kill DB.

---

## 5. The answer: what can pass the gauntlet *safely* at $0

"Safely" is defined by the lab's own rules: verdict only via the full 8-gate `runGauntlet`
(no bespoke subsets), honest N declared prospectively, $0 data, no recurring paid infrastructure,
and **no capital at risk before SURVIVE** (paper-forward throughout). Three layers:

### 5A. Run now (decision-grade at $0, this month)
1. Delisted-inclusive Donchian replay (§4.2.1) — resolves the flagship caveat either way.
2. Kalshi×PM convergence backtest with tape-verified fills (§4.2.2) — new namespace, full gauntlet on
   data already free.
3. Formal gauntlet KILL of funding-rank carry (§4.3) — converts a judge replay into a publishable verdict.

### 5B. Campaign E — the pre-registered forward family (commit this month, score on schedule)

One public prereg document, committed and sha256-pinned **before any forward bar**, declaring:

- **The family, prospectively:** K=4 hypotheses — (E1) Donchian canonical forward watch (post-replay
  prior), (E2) two-mechanism ensemble (Donchian + unlevered dated-basis, inverse-vol 50/50, all
  financing charged), (E3) unlock-cliff event study on the frozen calendar, (E4) the regime-triggered
  carry book of §5C. **Adjudication at family-wise honest N=4** (Bonferroni 0.05/4), declared now —
  this answers the critic's "selecting 1 of 24 ideas is itself an argmax" one level up: the *claim*
  family is frozen today; the 24→4 triage was research, not a statistical claim.
- **Look schedule (alpha-spending):** scores computed quarterly, O'Brien-Fleming-style boundaries,
  consume-once per look; no mid-course config edits, ever (any edit = new hypothesis, N increments).
- **Honest horizons printed in the doc** (from §3): E1/E2 are multi-year for SURVIVE and the doc says
  so; their quarterly updates are content and KILL-detection, not survival theater.
- **Recorders:** daily Binance/Deribit/calendar snapshots — local, seconds per day, $0. *Operational
  note: the training-loop OFF decision stands; these data-only recorders are a separate, tiny,
  explicitly opt-in `launchd` job (macOS cron skips sleep) — or stay manual-daily if preferred. No
  cloud, no paid infra, no hourly cost either way.*

### 5C. The centerpiece: pre-registered **regime-triggered structural carry** — the one construction that clears the power wall

**Why this one.** The power wall (§3) says only true-Sharpe-≥1.5–2 mechanisms can SURVIVE within
1–3 years. Across ~111 hypotheses the only family that has ever printed that here is contractual
carry **in a rich-funding regime**: dated-basis earned Sharpe 2.87 even in the *low*-funding regime
test, the 2024 blowout paid 10.99%/yr gross on funding, and the program's own carry verdict is
explicitly "a REGIME trade — turn it on when funding is rich and rising." What was never done is the
honest version of "turn it on": **pre-registering the trigger before the regime arrives**, which is
what makes the eventual track record N=1 instead of hindsight.

**The pre-registered spec (frozen at commit time, all parameters justified from already-published
program numbers, no new search):**

- **Trigger ON:** equal-weight 8-major perp funding > 8%/yr sustained 30 consecutive days
  (the program's own published "rich and rising" threshold), AND BTC quarterly basis annualized > 5%.
- **Book while ON:** delta-neutral, **unlevered**: long spot + short dated quarterly (BTC+ETH,
  hold-to-convergence) + short perp funding receiver on the 8 majors, equal-weight; financing/borrow
  charged on full notional; taker 4 bps/side; weekly mark.
- **Trigger OFF:** funding < 5%/yr for 30 days, or basis < 2% — close at the next roll.
- **Crash-tail control (pre-declared):** the perp-spot carry KILL showed the short-crash-option
  profile (skew −12.9, Nov-2024 −18.9% month). The book therefore caps perp-leg notional at 50% and
  keeps dated-basis (which converges contractually) as the senior sleeve; the tail stress is part of
  the published spec, not a post-hoc excuse.
- **Scoring (the claim):** "triggered windows beat T-bills net of everything, at honest N=1" —
  scored only over ON-windows, cumulative across regimes, calendar-reanchor + regime-placebo null
  (the XS-shuffle is documented as the *wrong* null for directional carry), quarterly looks under the
  Campaign E alpha-spending schedule.
- **Power honesty:** in-regime carry at 2021/2024-richness paid double-digit APR on a delta-neutral
  book → in-regime true Sharpe ≥ 2 → **~1–2 years of cumulative ON-time to 80% power**. If the regime
  never returns, the hypothesis just stays dormant at **zero cost** — the asymmetry is the point.
  2026-YTD funding is −0.05%/yr; the trigger is OFF today and the doc says so.
- **Cost:** $0 data (funding/basis caches + free endpoints), one snapshot/day, no paid infra, no
  hourly cost. **Safety:** delta-neutral, unlevered, dormant by default, paper until SURVIVE.

This is the honest answer to "a way to trade that can pass the whole gauntlet safely":
not a new pattern — a **contractual premium with a pre-registered activation rule**, the only
construction in the program's history whose in-regime Sharpe clears the math in §3, packaged so that
when it fires, the statistics are legitimate at N=1.

---

## 6. OSS expansion roadmap

**Engineering (the moat):**
1. `src/lib/validation/strategy-validator.ts` — promote the unified gauntlet, with the §2 fixes
   (financing leg default-on, FW-MAX surrogate, purged CPCV, honest haircut naming), unit + parity
   tests across the 8 legacy copies, and the planted-δ positive/negative control in CI.
2. The named nulls as tested primitives (crossSectionalShuffleNull, calendar-reanchor, IAAFT,
   GARCH-sim, bracket-on-surrogate).
3. **The power calculator as a public tool + doc** ("can your strategy be falsified at your N?") —
   §3 as code; auto-DEFER any prereg whose powered horizon exceeds its declared window.
4. The pre-registration registry format: sha256-pinned config + scoring script + look schedule, with
   CI that scores on schedule and refuses out-of-schedule looks.

**Content (the audience):**
5. Post X-thread v9 (ready; assets regenerated; per the pre-publish checklist).
6. Machine-readable **kill DB** (one JSON per verdict: claim, binding gate, decisive number, artifact
   path) — the citable product of ~111 verdicts; auto-rendered into the README table.
7. Quarterly public forward report (Campaign E looks + recorder stats + any new kills).

**Community (the flywheel):**
8. "Run the gauntlet" PR flow: a strategy-spec template; CI runs the 8 gates on free data and posts
   the verdict. The kill DB becomes community-extensible under the same standard.
9. Open challenge framing ("your indicator survives the full gauntlet on forward data → we publish it
   with your name on it") — credible *because* the lab's own tally is 0/111.
10. Dataset releases: the sha256-pinned funding/basis/crossxs/PM snapshots + (soon) the Deribit PIT
    chain corpus and the unlock-event dataset — each independently citable.

**30/60/90:** (30) §2 fixes 1–3 + Donchian replay + Kalshi×PM backtest + funding-rank formal KILL +
X-thread posted + Campaign E prereg committed + recorder opt-in decision; (60) recorders accruing,
kill DB + CI gauntlet MVP, score CR28/CR29 exactly on their dates; (90) first Campaign E quarterly
look, community challenge launch, first quarterly report.

---

## 7. Critique-gap disposition & sequencing

The workflow's completeness critic raised 8 gaps; disposition: power analysis → **§3 (done, now a
gate)**; prospective multiplicity → **§5B family-wise N=4 declaration**; zero-recurring-cost audit &
automation conflict → **§5B operational note (opt-in launchd vs manual; training loop stays OFF)**;
jurisdiction → **§4.2.2 note**; judge-disagreement rule → table in §4.1 binds on the *kill-judge*
(feasibility can only park/reject, never rescue); sequencing vs accruing pre-commitments → **CR27/
CR28 (120d)/CR29 (60d) and the weather log are scored once on their dates and are unaffected by
anything here**; harness-fix dependency → §2 fixes 1–3 block any new campaign (run-now items in §5A
use the campaign-D unified gauntlet + audit-grade FW-MAX scripts that already exist); OSS baseline
metrics → add repo-traffic/stars snapshot to the quarterly report (first one sets the baseline).

**Provenance.** Branch integration + dirty-work commit: `c70f9719` (2026-06-09). Analysis: 63-agent
workflow (6 readers, 8 generators, 48 judges, 1 critic; ~3.2M tokens), run 2026-06-09; readers and
judges verified all load-bearing claims against the repo and live endpoints; key live verifications
dated in-line above. Power table: normal-approx, reproducible from §3 formulas. This document
supersedes the "4 PROMISING leads" framing in earlier internal notes (audited: 2).

---

## 8. Development status board (live — update this section as work lands)

> **Closeout (2026-06-10):** 11 of 13 lanes DONE; the 2 open are not codeable now — **W11**
> (publish: X-thread + public push) is gated on the maintainer (outward-facing), **W13** (score
> CR28/CR29 + weather log) is gated on their future resolution dates (score-once, never re-tune).
> Net research result of the run-today lanes: the program's #1 PROMISING (XS Donchian) flipped to
> KILL on the honest delisted-inclusive panel, so the **audited tally is now 0 SURVIVE / 1 PROMISING
> (dated-futures basis, unlevered-thin) / 115 KILL / 18 DEFERRED**. The gauntlet is now a tested
> library (`src/lib/validation/`, 104 tests) and the defect that minted three false PROMISINGs is
> structurally impossible going forward. E4 (regime-triggered carry) remains the only forward
> candidate that clears the §3 power wall, dormant at $0 until funding richens (trigger OFF today).

> Execution tracking for every fix/recommendation above. **Rules for parallel work:** each lane owns
> ONLY the files listed in its "Owns" column — never touch another lane's files; do not commit from
> sub-agents (the coordinator commits after review); scope test runs to your own test files
> (`npx vitest run <file>`), plus `npx tsc --noEmit` before handoff. Update your lane's row
> (status + notes) in the same change that lands the code. Statuses: `TODO` / `IN-PROGRESS` /
> `REVIEW` / `DONE` / `BLOCKED(user)` / `DEFERRED`.

| Lane | Scope (doc ref) | Owns (files) | Depends on | Status | Notes |
|---|---|---|---|---|---|
| **W1** Harness consolidation | §2 fixes 1,2,3,4,5,7 — promote unified `runGauntlet` to the lib, financing leg default-on, FW-MAX surrogate enforcement, purged CPCV ≥8 folds, honest haircut naming, planted-δ control test, parity tests vs legacy copies | `src/lib/validation/strategy-validator.ts`, `src/lib/validation/financing.ts`, `src/lib/validation/purged-cpcv.ts`, `src/lib/validation/*.test.ts` (validator/financing/cpcv/parity/control) | — | DONE | 2026-06-09: 43 lane tests + 104/104 whole-dir green; planted-δ control (δ=0→KILL, δ=0.08 prereg N=1→SURVIVE); parity with campaign-D on shared scenarios; 5 intentional STRICTER divergences asserted in parity.test.ts (single-config null at honestN>1 now fails; N=1 privileges require preregHash; no-grid at N>1 fails cpcv; purged ≥8-fold CPCV; empty baselines fail). Follow-ups: export createSeededRandom from statistical-validation (dedupe); migrate campaign scripts to import the lib (do per-campaign as they are next touched) |
| **W2** Named nulls primitives | §2 fix 6 — crossSectionalShuffleNull, calendar-reanchor, IAAFT, GARCH-sim, bracket-on-surrogate as tested, seeded primitives | `src/lib/validation/nulls.ts`, `src/lib/validation/nulls.test.ts` | — | DONE | 2026-06-09: 33 property tests green (naive-DFT cross-check of the FFT). Decisions: reanchor wraps (count invariant); IAAFT preserves linear ACF by construction (sign-ACF test); GARCH grid skips persistence>0.995, iid-Gaussian fallback <30 samples; bracket fills at observed close (gap-through), stop-before-take |
| **W3** Power calculator | §3 as code + pre-flight gate (OSS #3) | `src/lib/validation/power-analysis.ts`, `src/lib/validation/power-analysis.test.ts`, `scripts/power-check.ts` | — | DONE | 2026-06-09: 28 tests green; reproduces §3 tables ±0.02; CLI `npx tsx scripts/power-check.ts` prints tables / per-window / pre-flight with the auto-DEFER recommendation; Acklam quantile (err <1.2e-9) |
| **W4** Fetcher recommit | §2 fix 8 — reproducibility fetchers for the funding/carry/dated-futures caches | `scripts/fetchers/**` | — | DONE | 2026-06-09: 3 fetchers + README; live selftests PASS with **bit-identical** reproduction vs committed caches (basis formula is `(f−s)/s`, not `f/s−1` — ulp-level catch); OKX retention ~3mo + depth snapshots are PIT-only → committed cache documented as the archival record |
| **W5** Donchian delisted-inclusive PIT replay | §5A.1 — rebuild PIT panel from data.binance.vision (delisted-inclusive), full gauntlet on the frozen canonical | `scripts/edgehunt-donchian-pit/**` | W1 ✓ (uses lib runGauntlet) | DONE | 2026-06-09: **KILL — flagship caveat resolved; the PROMISING was survivorship.** Parity 9/9 first; PIT universe 161 ever-members (28 now-dead incl. old-LUNA through the crash), overlap 16.8/30; FW shuffle p 0.002→0.103, alpha t 3.22→1.60, β→+0.36; binding deflated_sharpe (DSR 0.451 @ N=72); survivor panel under the stricter lib machinery also KILL. Tally → 0/1/~110; kill-db updated (validator invariant now PROMISING==1) |
| **W6** Kalshi×Polymarket convergence | §5A.2 — tape-verified fills, calibrated-Bernoulli null, FW-MAX over ≤8-config declared grid | `scripts/edgehunt-kalshi/**` | W1 ✓ | DONE | 2026-06-09: **DEFERRED (data_deferred).** 70 same-event pairs matched, but Kalshi's keyless API purges settled markets ~60d out → honest dual-tape window only ~7 weeks; just 2 raw ≥24h gaps in 70 pairs (both longshot, both lost, both in holdout) → 0 in-sample fills; power pre-flight infeasible (1.60y ≫ 0.14y). Leading indicator → KILL; honest path = recorded-forward dual-tape log (~12-18mo); `convergence_test.ts` runs unchanged on it. kill-db merged (campaign-E, DEFERRED) |
| **W7** Funding-rank carry formal KILL | §5A.3 / §4.3 — formalize the judge replay through the full committed gauntlet | `scripts/edgehunt-fundingrank/**` | W1 ✓ | DONE | 2026-06-09: **KILL** (binding deflated_sharpe DSR 0.942 @ N=12; also cpcv_pbo 0.643, family-wise XS-shuffle p=0.060). Survivorship-free 155-perp panel. Honest correction to the judge replay: the coupon is large AND the price leg is **positive** (net SR 1.24) — it dies on multiple-testing, not economics. kill-db merged (entry `xs-funding-rank-ls-carry`, domain campaign-E) |
| **W8** Campaign E prereg pack | §5B + §5C — prereg doc (family K=4, Bonferroni 0.05/4, quarterly alpha-spending looks), frozen configs + sha256 manifest, $0 recorder scripts, launchd plist NOT loaded (opt-in) | `docs/campaign-E/**`, `scripts/recorders/**` | — | DONE | 2026-06-09: PREREGISTRATION.md + 4 frozen configs + PREREG_HASHES.json; E1 canonical replicated exactly (net Sharpe 1.4046 vs published 1.405); recorders smoke-run live (market 93s/71 calls, Deribit chain 5.5s/755KB — BTC 958 + ETH 760 strikes w/ OI+IV); E4 trigger confirmed OFF today (funding ≈0.76%/yr, basis 2.0–3.5%). Coordinator-pinned declarations: E1 borrow 10%/yr flat; E2 equal-risk weights 0.0624/0.9376. TODO: unlock-page scrape selectors (JS-rendered); launchd opt-in = user decision |
| **W9** Machine-readable kill DB | OSS #6 — curated JSON of every documented verdict + rendered table | `scripts/kill-db/**`, `data/kill-db.json`, `docs/KILL_DB.md` | — | DONE | 2026-06-09: **132 entries** (113 KILL / 2 PROMISING / 17 DEFERRED), validator enforces tally invariants (PROMISING==2, flips carry flipped_from), deterministic render. Curation notes in JSON `source_note` (e.g. e2 perp-funding-carry recorded KILL with sub-RF nuance in one_line; T8 folded into the campaign dated-futures PROMISING entry) |
| **W10** Community/CI prep | OSS #8–9 — strategy-spec PR template, gauntlet CI workflow, challenge doc (staged privately) | `publish/community/**` (force-tracked — originals, despite the dir-level ignore) | W1 ✓ | DONE | 2026-06-09: 12 files; selftest ran the kill-by-design RSI(2) example through the PUBLIC repo code → KILL @ baselines (multi-gate, as planted); CI workflow SHA-pinned, GITHUB_TOKEN-only, never auto-merges; family-wise PASS labeled survive-candidate (not SURVIVE) pending maintainer reproduction; PORTING.md = 11-command port + 6 verification steps. **Public push = user action (W11)** |
| **W11** Publish: X-thread + public-repo sync | OSS #5 + §6 content | `publish/PUBLICATION_PLAN_2026-06-10.md` (prep only) | — | PREPARED → BLOCKED(user) | 2026-06-10: publication plan written (leak 0 / PT 0 over the publishable subset). **Priority: the public ledger still says 2 PROMISING — stale after the Donchian flip.** Surfaces a maintainer decision: private `runGauntlet` vs public `validateStrategy` (same filename, different design — do NOT clobber). Push order in the plan; posting/pushing is the maintainer's confirmed action |
| **W12** Quarterly report template + OSS baseline metrics | OSS #7 + §7 (critique gap 8) | `docs/reports/**` | — | DONE | 2026-06-09: `docs/reports/QUARTERLY_REPORT_TEMPLATE.md` + `2026-Q2-baseline.md` (baseline: 1 star, 0 forks, 34 views/12 uniques 14d, 316 clones/134 uniques 14d, 0 external PRs — pre-X-thread) |
| **W13** Score accruing pre-commitments | §7 — CR27 / CR28 (120d) / CR29 (60d) / weather log | — (calendar) | dates | TODO | Score once on their dates; never re-tune |
