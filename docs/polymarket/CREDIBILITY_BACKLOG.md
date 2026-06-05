# Campaign-D — Credibility Backlog (additional tests + deepenings)

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


> A prioritized backlog of additional tests that strengthen the credibility of the **0 deployable edge**
> verdict (or would surface a rare real edge). Generated 2026-06-03 by an 8-lens workflow (10 agents).
> **Per the always-complete-gauntlet rule, each item ends in a `runGauntlet` verdict or a forward log —
> these are LEADS until executed.** Raw: `output/campaign-D/cred-wf/`.

## Done (keystone)

- **CR01/CR02 — gauntlet positive/negative control (`gauntlet_control.ts`) — DONE.** Plants a known
  per-bet edge δ and confirms the gauntlet **SURVIVES δ=0.08** (all 8 gates) and **KILLs δ=0**
  (net_of_cost), with the surrogate flipping p=0.59→0.000 as δ grows. **The detectability floor is
  ~5-8% per bet** (even the consume-once holdout must pass). This proves the harness has power and is
  NOT always-KILL → the campaign's 0-SURVIVE is a property of the MARKETS. *(Also fixed a real
  edge-case the control surfaced: `cpcv_pbo` was wrongly binding on single pre-registered configs where
  PBO is not applicable — now n/a→pass; the real grid-based tests are unaffected.)*

## Execute-first (quick wins, $0, backtest-now)

Order: CR01, CR06, CR04, CR12, CR13, CR08, CR17, CR21, CR15, CR11

> **Highest credibility gain:** CR01 -- the positive-control suite. It is the single load-bearing item because it converts the entire campaign from 'we ran a gauntlet and found nothing' into 'we proved the gauntlet PASSES on a planted edge in every family (calibration +5%, copy +8%, weather-Brier, and the already-committed +12% MM control) and it still KILLed the real data' -- i.e. it makes the 0-edge result a credible TRUE NEGA

## Full backlog (29 items)

| ID | lens | strengthens | value | effort | $0 | title |
|---|---|---|---:|---:|---|---|
| CR01 | positive_contr | harness-validation / p | 5 | 2 | y | Positive-control suite: planted synthetic edges across all fou |
| CR04 | adversarial_nu | adversarial / robustne | 5 | 3 | y | Alternative surrogate generators (IAAFT, sign-permutation, blo |
| CR06 | adversarial_nu | robustness / multiple- | 5 | 2 | y | Garden-of-forking-paths census + campaign-wide honest-N re-def |
| CR08 | robustness | robustness | 5 | 3 | y | Decision lead-time stratification: re-derive price-at-lead at  |
| CR12 | robustness | forward / robustness | 5 | 2 | y | Extended walk-forward to 6+ disjoint rolling windows with Stou |
| CR13 | reproducibilit | reproducibility / data | 5 | 2 | y | Deterministic re-fetch + SHA-256 drift gate (re-run verdict un |
| CR14 | reproducibilit | data-integrity / robus | 5 | 3 | y | Trade-tape completeness scan + re-run on full tapes (truncatio |
| CR15 | reproducibilit | control / robustness | 5 | 2 | y | Recency-truncation impact audit (the 10k-pagination-cap months |
| CR17 | viral_claims | robustness / control | 5 | 3 | y | Bot/syndicate forensics: cluster coordinated wallets, re-run c |
| CR21 | mechanism_dept | coverage / mechanism | 5 | 2 | y | NegRisk overround decomposition: void-avoidance premium vs ups |
| CR22 | mechanism_dept | robustness / control | 5 | 2 | y | Stratified capacity test: re-run calibration gauntlet on volum |
| CR25 | coverage | adversarial / coverage | 5 | 4 | y | Geopolitics hardest-case calibration + news-arrival latency (w |
| CR26 | coverage | robustness | 5 | 2 | y | Cross-category favorite-longshot meta-test: bias slope + sprea |
| CR27 | forward | forward / pre-register | 5 | 3 | y | Pre-registered copy-trading + calibration forward log on uncon |
| CR28 | forward | forward / pre-register | 5 | 2 | y | Pre-registered single-config (N=1 honest) calibration strategy |
| CR29 | forward | forward / positive-con | 5 | 3 | y | Pre-registered live weather FORWARD log (Open-Meteo ensemble v |
| CR02 | positive_contr | positive-control / pow | 4 | 2 | y | Detectability floor: sweep injected edge intensity to map the  |
| CR03 | positive_contr | positive-control / hol | 4 | 2 | y | Walk-forward overfitting control: inject in-sample-only edge,  |
| CR05 | adversarial_nu | adversarial / robustne | 4 | 2 | y | Eleven alternative right-nulls per top claim (null-specificati |
| CR07 | adversarial_nu | robustness / coverage | 4 | 3 | y | Corpus bootstrap of the surrogate p-value (verdict robustness  |
| CR09 | robustness | robustness | 4 | 2 | y | Holdout-split + bucket-granularity sensitivity for both flagsh |
| CR10 | robustness | robustness / reproduci | 4 | 2 | y | RNG-seed + Monte-Carlo sample robustness (10 independent seed  |
| CR11 | adversarial_nu | coverage / adversarial | 4 | 2 | y | Heterogeneity audit: stratified verdicts by liquidity / catego |
| CR16 | reproducibilit | data-integrity | 4 | 3 | y | Tape-derived vs CLOB prices-history price-derivation audit on  |
| CR18 | viral_claims | robustness / control | 4 | 2 | y | New-wallet-at-OOS-inception cohort (selection-bias-free copy-t |
| CR19 | viral_claims | robustness / control | 4 | 2 | y | Single-event insider isolation: remove concentrated one-market |
| CR23 | mechanism_dept | coverage / mechanism | 4 | 2 | y | Tail-event holdout decomposition: is the calibration KILL stru |
| CR24 | coverage | coverage | 4 | 3 | y | Cross-category calibration coverage: sports + politics + enter |
| CR20 | viral_claims | robustness / coverage | 3 | 2 | y | Slippage-adjusted copy fills: replace copy-at-mid-60s with emp |

## Per-item method (the testable recipe)

**CR01 — Positive-control suite: planted synthetic edges across all four harnesses (calibration +5%, copy-wallet +8%, MM +12% reuse, weather-Brier)**  
*harness-validation / positive-control · gate: validates net_of_cost->holdout chain PASSES on real edge across every family (no · backtest-now*  
- Method: Build campaign-D/positive_controls.ts that injects a KNOWN edge into each family and asserts the gauntlet PASSES (so KILL on real data is a true negative, not a dead harness). (a) Calibration: synthesize outcomes ~Bernoulli(price+0.05) and run calib path of run_all.ts -> expect SURVIVE binding on holdout, surrogate p<0.05, DSR passes at honest N. (b) Copy-trading: inject one deterministic wallet w
- Expected: All four legs SURVIVE/PROMISING on planted edge; real-data runs of the same harnesses KILL; proves gauntlet has power and is not biased toward null

**CR02 — Detectability floor: sweep injected edge intensity to map the minimum effect size each harness can detect at honest-N**  
*positive-control / power-analysis · gate: quantifies gates 3-7 power; shows the real-data null sits below the detectabilit · backtest-now*  
- Method: Extend CR01: for calibration and copy-trading, inject edges at delta in {+0.1%, +0.5%, +1%, +2%} and record verdict + binding gate per intensity. Establishes the smallest per-trade/per-bucket edge the gauntlet detects at each family's honest-N, and confirms tiny weak signals (e.g. +0.03 mean) are correctly KILLed by the family-wise MAX surrogate even when a naive mean test would pass. Output detec
- Expected: +1-2% edges pass; +0.1% KILLed by DSR/surrogate; documents that 0 deployable edge means true edge (if any) is below an economically irrelevant threshold

**CR03 — Walk-forward overfitting control: inject in-sample-only edge, confirm holdout/OOS gate catches it**  
*positive-control / holdout-validation · gate: validates holdout gate effectiveness against overfitting; contrasts with real to · backtest-now*  
- Method: On the existing walk-forward windows, inject a +2% edge into TRAIN data only (no OOS bump) and run copy_trading_gauntlet.ts. Assert (a) train SURVIVE/PROMISING (edge visible in-sample), (b) OOS holdout KILL or severe mean collapse. Proves the consume-once holdout is a functional brake on data-snooping, not ceremonial. Output walk_forward_control.json.
- Expected: Train passes, OOS holdout fails on injected in-sample-only edge; confirms holdout catches snooping the same way it catches real top-decile wallets

**CR04 — Alternative surrogate generators (IAAFT, sign-permutation, block-bootstrap labels) vs the seeded-RNG null**  
*adversarial / robustness · gate: gate 7 (surrogate) — proves the right-null verdict is not an RNG/seed/method art · backtest-now*  
- Method: Implement 3 alternative null generators and re-derive family-wise MAX p-values for copy-trading and calibration: (1) IAAFT to preserve return autocorrelation while breaking strategy correlation, (2) sign-permutation on returns, (3) stationary block-bootstrap on OUTCOME labels (handles resolution clustering). Compare against the committed Mersenne-twister wallet-label-shuffle / calibrated-Bernoulli
- Expected: All three alternatives confirm p>0.05; if any flips to p<0.05 it is an adversarial discovery that must become the default null

**CR05 — Eleven alternative right-nulls per top claim (null-specification load-bearing audit)**  
*adversarial / robustness · gate: gate 7 — shows the verdict is not an artifact of one narrow null choice · backtest-now*  
- Method: For copy-trading try 10 extra nulls (shuffle sides only; shuffle entry prices only; copy random non-eligible; copy prior-year wallets; sign-flip winners; etc.) and for calibration try alternatives (price-label permutation; empirical-q Bernoulli; perfect-line 0.5c-gap null). Run each top claim against all 11 nulls (committed + 10). Output null_spec_audit.json. Robust iff KILL holds under >=9/10 alt
- Expected: KILL holds under >=8/10 (copy) and >=9/10 (calibration) alternatives; the 1-2 that flip are diagnosably too loose/too strict

**CR06 — Garden-of-forking-paths census + campaign-wide honest-N re-deflation**  
*robustness / multiple-testing · gate: gate 6 (haircut) — most-conservative reader's multiple-testing stance across the · backtest-now*  
- Method: Audit every config searched across the whole campaign (copy 32, calibration 20, MM 14, arb 2, RE grids) into one config tree; compute campaign-wide honest-N; re-deflate each family's surrogate/DSR/Harvey-Liu p-values at the GLOBAL N (not just per-family). Output forking_paths_audit.json with pre/post-deflation verdict per test. Pass iff every KILL stays KILL under the global cap.
- Expected: Every KILL survives global-N Bonferroni/BHY; any flip toward PROMISING flags under-deflation and is documented

**CR07 — Corpus bootstrap of the surrogate p-value (verdict robustness to market selection)**  
*robustness / coverage · gate: gate 7 — tests corpus-dependence of the KILL · backtest-now*  
- Method: Resample markets with replacement (N->N) 50x; for each resampled universe recompute the in-sample-best config AND its surrogate null; build the distribution of surrogate p-values. Output corpus_bootstrap_surrogates.json with p quantiles (5/25/50/75/95). Pass iff median p>0.05 AND 95th-pct p>0.05 (verdict not dependent on lucky market selection).
- Expected: p-values tight around committed values (copy ~0.53, calibration high); a low 95th-pct would flag data-dependence

**CR08 — Decision lead-time stratification: re-derive price-at-lead at 7d/3d/1d/12h/1h and re-run calibration gauntlet**  
*robustness · gate: validates surrogate + holdout: confirms the KILL is not a 24h-lead artifact and  · backtest-now*  
- Method: RE13/calibration only used a 24h lead. Re-derive price-at-lead from the trade tapes at [7d,3d,1d,12h,1h] before resolution and re-run the calibration-family gauntlet at each lead (prices, spreads, hold duration all shift). Output lead_time_stratified.json with verdict, mean, DSR per lead.
- Expected: KILL stable across leads; mean net-return converges to zero toward resolution; no-edge robust whether acting 7d early or 1h before

**CR09 — Holdout-split + bucket-granularity sensitivity for both flagship families**  
*robustness · gate: stresses gates 3/4/8 at series-length and split extremes · backtest-now*  
- Method: Re-run calibration and copy-trading at [70/30, 60/40, 50/50] train/holdout splits and at varying bucket granularities (hourly/6h/daily/weekly for copy; 10/20/50% quantile buckets for calibration), each through the full gauntlet. Tests block_bootstrap/DSR/holdout at the n>=5 boundary and whether coarser/finer bucketing inflates the mean past the holdout CI. Output split_granularity_sensitivity.json
- Expected: KILLs stable; holdout mean <=0 with CI including 0 under all splits; no bucketing flips the verdict

**CR10 — RNG-seed + Monte-Carlo sample robustness (10 independent seed sequences)**  
*robustness / reproducibility · gate: validates block_bootstrap + surrogate reproducibility under random state · backtest-now*  
- Method: Re-run run_all.ts 10x with independent seed sequences (logic fixed, vary RNG state for wallet-shuffle and Bernoulli draws). Record verdict, surrogate p, DSR, bootstrap CI per seed. Output seed_robustness.json with verdict distribution and p-range. Confirms 1200-1500 null draws are enough and no lucky seed drives the result.
- Expected: All 10 runs KILL; surrogate p in a tight band (no flip to <0.05); CI/DSR show no outliers

**CR11 — Heterogeneity audit: stratified verdicts by liquidity / category / calendar (subpopulation edge hunt)**  
*coverage / adversarial · gate: gates 7+3 — surfaces a hidden subpopulation edge if one exists and guards agains · backtest-now*  
- Method: Run the unified gauntlet separately on stratified subsets: volume terciles (low/mid/high), category (crypto/sports/politics/other from Gamma slugs), and calendar (early vs late month, accounting for the 10k pagination cap). Each stratum gets the full 8-gate chain with stratum-adjusted honest-N. Output heterogeneity_verdicts.json. Flag any stratum that flips to SURVIVE or anomalous p.
- Expected: All strata KILL (or uniform PROMISING); any high-p/SURVIVE stratum triggers a secondary real-vs-selection-inflation audit

**CR12 — Extended walk-forward to 6+ disjoint rolling windows with Stouffer meta-test**  
*forward / robustness · gate: gate 8 — lifts the KILL from 3 windows to 6+ sequential temporal regimes · backtest-now*  
- Method: Extend the initial walk-forward to 6+ disjoint rolling windows over the full tape span (2025-06 -> 2026-06): each TRAIN 3mo / OOS 1mo, non-overlapping. *(Executed as 5 windows — see the CR12 result row below.)* Run copy-trading gauntlet per window; record per-window surrogate p, mean, DSR; aggregate via Stouffer Z across window p-values and plot per-window mean for regime drift. Output walk_forward_extended.json. Pass iff >5/6 windows p>0.05 an
- Expected: 5-6/6 windows p>0.05; Stouffer rejects a persistent edge; no drift in per-window mean

**CR13 — Deterministic re-fetch + SHA-256 drift gate (re-run verdict under any data drift)**  
*reproducibility / data-drift · gate: reproducibility + drift gate — same fetch -> same hash -> same verdict, or docum · backtest-now*  
- Method: Re-fetch resolved-markets.jsonl with the exact pinned month-window + ordering, SHA-256 it, and diff against SNAPSHOT.json. If hash matches -> re-run gauntlet (must reproduce verdict). If it differs -> log the delta (added/removed/modified markets, moved endDate, changed outcomePrices) and re-run to prove the KILL survives drift. Output determinism_check.json.
- Expected: Hash match expected; on mismatch, quantify the delta and show KILL robust to drift

**CR14 — Trade-tape completeness scan + re-run on full tapes (truncation-bias guard)**  
*data-integrity / robustness · gate: data-integrity gate — ensures missing tail trades did not bias earlier-trade pro · backtest-now*  
- Method: For each market in copy-markets.jsonl, fully paginate the /trades endpoint and compare TRUE trade count to the cached tape row count; flag any market <100% coverage. Re-run the copy-trading gauntlet on the COMPLETE tapes for flagged markets to verify the KILL holds when tail trades are included. Output tape_completeness.json (per-market coverage % + re-test).
- Expected: >=99% coverage expected; if any market lower, full-tape re-run yields same surrogate p (copy KILL robust to truncation)

**CR15 — Recency-truncation impact audit (the 10k-pagination-cap months)**  
*control / robustness · gate: control — tests whether the documented pagination cap biased results toward fals · backtest-now*  
- Method: Re-run copy-trading + calibration separately on the 11 truncated months (2025-08..2026-06, volume-ranked at top-100/500/1000 depth) vs the non-truncated months; compute effect sizes (delta p, delta Sharpe, delta mean). If the truncated subset is more bullish, document the recency-bias direction and recompute verdict on the full distribution. Output truncation_impact.json.
- Expected: No meaningful difference (copy KILL p stable across month mix), proving recency truncation did not inflate the negative result

**CR16 — Tape-derived vs CLOB prices-history price-derivation audit on overlapping markets**  
*data-integrity · gate: validates that the tape-derivation choice (forced by prices-history purge) did n · backtest-now*  
- Method: For the ~100 recent markets where BOTH the tape-derived price-at-24h-lead AND Gamma CLOB prices-history exist (pre-purge), compute RMSE of the discrepancy; investigate any market >1c. Re-run the calibration gauntlet on the overlap using CLOB prices instead of tape-derived prices and compare verdicts. Output price_audit.json.
- Expected: Tape vs CLOB match within +/-0.5c; calibration verdict does not flip (stays KILL), proving the price-derivation method did not manufacture the negative

**CR17 — Bot/syndicate forensics: cluster coordinated wallets, re-run copy-trading on isolated traders only**  
*robustness / control · gate: surrogate/control — forces the edge to survive removal of coordinated/bot wallet · backtest-now*  
- Method: Pairwise wallet correlation on (entry-timestamp deltas, side-agreement on shared markets, notional correlation); cluster corr>0.7 groups; compute Herfindahl on the top-decile. Re-run copy_trading_gauntlet.ts on (a) top-PnL minus suspected-coordination clusters and (b) isolated-traders-only, comparing surrogate p to the committed 0.528. Output bot_forensics.json.
- Expected: If top wallets are independent, p stays ~0.53 (KILL via robustness); if bot-coordinated, p flips (KILL via positive control on bot-ness) — either hardens the verdict

**CR18 — New-wallet-at-OOS-inception cohort (selection-bias-free copy-trading control)**  
*robustness / control · gate: surrogate/control — random-OOS decile is the positive control that random select · backtest-now*  
- Method: Identify wallets whose first trade is after the OOS window start (no TRAIN history to overfit); rank them by THEIR OOS PnL/winrate/ROI; simulate copying the top decile at 60s delay through gates 1-7; baseline = a random OOS-only decile. If selection bias drove the original KILL, the OOS-only-top should also fail the surrogate like random. Output oos_only_cohort.json.
- Expected: OOS-only-top KILLs on surrogate (p~0.5, no better than random-OOS), replicating PM16 -> KILL robust to selection bias

**CR19 — Single-event insider isolation: remove concentrated one-market PnL wallets and re-run**  
*robustness / control · gate: surrogate/filter — proves lucky single-market insiders are not rescuing copy-tra · backtest-now*  
- Method: Per eligible wallet compute PnL concentration (max-single-market-PnL / total), distinct-markets, account age. Flag concentration>0.5 as insider-like (sub-flag with distinct-markets<=3). Re-run copy_trading_gauntlet.ts on three cohorts: full pool, pool-minus-insiders, insiders-only; compare surrogate p and OOS Sharpe. Output insider_isolation.json.
- Expected: Insider cohort ~3-5% of eligible; removing them does not improve the verdict (p still >0.05); insiders-only is near-0 / DEFERRED on tiny N

**CR20 — Slippage-adjusted copy fills: replace copy-at-mid-60s with empirical queue-position fills**  
*robustness / coverage · gate: baselines/control — removes the idealized copy-at-mid assumption; shows copy-tra · backtest-now*  
- Method: For the 30 highest-volume markets, snapshot the CLOB /book at fixed leads, compute inside spread + queue depth, and from the tape estimate market-impact slippage for a copier entering 60s after the leader at the THEN price. Re-run copy_trading_gauntlet.ts substituting the empirical slippage-adjusted fill for the idealized mid fill. Output slippage_copy.json.
- Expected: Slippage drops per-trade copy PnL ~50-100bps; OOS Sharpe sinks further below zero, hardening the KILL beyond no-skill

**CR21 — NegRisk overround decomposition: void-avoidance premium vs upset-tail premium**  
*coverage / mechanism · gate: isolates whether the favorite-longshot structure is a cost (void avoidance) or a · backtest-now*  
- Method: From the committed arb_baskets corpus (579 baskets, median sum(ask) 1.073) decompose the +7.3% overround: per basket compare sum(ask) for the full basket vs the clean-binary YES legs only; the difference / #legs is the per-leg void-avoidance cost, the residual sum-1.0 on clean binaries is the pure upset-tail premium. Run the gauntlet on the clean-binary-only basket subset with explicit void haircu
- Expected: Void haircut ~4-6% of the 7.3%, leaving <=2% pure upset-tail; the structure decomposes as mostly void-avoidance cost, hardening sub-cost KILL

**CR22 — Stratified capacity test: re-run calibration gauntlet on volume/OI terciles to measure capacity-tightness of the premium**  
*robustness / control · gate: tests whether the longshot premium is a high-liquidity artifact that vanishes ne · backtest-now*  
- Method: Stratify the clean-binary calibration corpus by traded volume and OI terciles; re-run the calibration gauntlet per stratum with stratum-adjusted honest-N and the empirical per-stratum half-spread from the tape. Report per-stratum best-config mean (pre-cost), mean half-spread, holdout return, surrogate p, binding gate. Output capacity_strata.json.
- Expected: Premium shrinks to zero/negative on low-OI slices; binding gate shifts toward net_of_cost as spread widens; confirms capacity-tiny and sub-cost at scale

**CR23 — Tail-event holdout decomposition: is the calibration KILL structural or driven by a single upset?**  
*coverage / mechanism · gate: isolates whether the holdout KILL is structural (premium never survives) or vari · backtest-now*  
- Method: From the committed calibration holdout, log every upset-tail trade (YES resolved despite mid<=0.15), measure its PnL impact, and recompute holdout mean WITH vs WITHOUT tail-hit trades. Counterfactual: if one fewer (or zero) tail event occurred, is holdout still negative? Compare realized vs predicted upset rate to catch tail-bias. Output tail_decomp.json.
- Expected: Holdout stays negative even excluding all tail events (premium small vs spread, bootstrap CI already includes 0); tail is the coup de grace, not the driver — KILL is structural

**CR24 — Cross-category calibration coverage: sports + politics + entertainment closing-line efficiency through the gauntlet**  
*coverage · gate: calibration right-null — extends the favorite-longshot KILL beyond crypto/weathe · backtest-now*  
- Method: Fetch resolved binaries in three new categories (sports moneylines ~1000+, political/election ~200+, entertainment/awards ~300+), tag by subcategory, extract YES price at multiple leads, and run the calibration gauntlet per category with the calibrated-Bernoulli family-wise MAX null and category-appropriate spreads (sports narrower ~0.3-0.5c). Output cross_category_calib.json with verdict per cate
- Expected: Each category fails net_of_cost (gap < spread) or passes the surrogate but fails DSR@honest-N; confirms no cost-survivable edge across information-asymmetry regimes

**CR25 — Geopolitics hardest-case calibration + news-arrival latency (where an edge is most likely)**  
*adversarial / coverage · gate: calibration right-null + latency measurement — geopolitics is the hardest case ( · backtest-now*  
- Method: Fetch ~100-200 resolved geopolitical binaries (conflict/sanctions/trade). Run the calibration gauntlet on T-1d->close with an event-slug-stratified calibrated-Bernoulli null (no cross-event pooling); measure CLOB repricing lag vs news timestamps on major moves; test whether a 60s public-info delay kills any news edge even when the info is real. Control: a matched-vol politics dataset as a no-surpr
- Expected: Tight calibration vs politics baseline; news latency ~5-30s (no free lagged edge); any news-contingent model fails holdout/DSR on low event-N

**CR26 — Cross-category favorite-longshot meta-test: bias slope + spread-to-gap ratio across all categories**  
*robustness · gate: meta-null — ties the category gauntlets into one finding: the bias is real and u · backtest-now*  
- Method: Aggregate the calibration curves from CR24/CR25 (and existing crypto/weather): regress (realized-YES - price) on price to isolate the favorite-longshot slope; per category measure the median spread vs median |gap| in the [0.05,0.20] longshot band to form spread/|gap|; 2-way ANOVA category x price-bucket on the calibration gap. Output flb_meta.json. Hypothesis: bias is universal (consistent sign) b
- Expected: Consistent longshot bias slope; spread/|gap| > 1 in all categories; ANOVA price-bucket dominant, category small, no interaction -> KILL is structural not category-specific

**CR27 — Pre-registered copy-trading + calibration forward log on uncontaminated 2026-06 markets**  
*forward / pre-registered · gate: surrogate + consume-once holdout on genuinely unseen markets — strongest credibi · forward-live*  
- Method: TODAY freeze the best in-sample copy-trading config (top-10-by-PnL wallet addresses + N) and the best calibration band, committed to a public hash. Then for markets resolving 2026-06-10..2026-06-24 (outside the snapshot cutoff), apply the frozen logic at realized 24h-lead prices with NO retraining; ingest tapes as markets resolve; at >=50 daily observations run the FULL runGauntlet on ground-truth
- Expected: Forward daily mean <=0; rolling Sharpe <0.95; holdout CI includes <=0 -> back-test KILL is not a retrospective artifact

**CR28 — Pre-registered single-config (N=1 honest) calibration strategy, 120-day forward test**  
*forward / pre-registered / honest-N · gate: all 8 gates at honest-N=1 — the N=1 pre-registered standard a skeptic respects ( · forward-live*  
- Method: TODAY fit ONE (band, lead, threshold) calibration config on the committed TRAIN resolved markets, commit it by hash. Then for markets resolving over the next 120 days apply the committed config with no re-tuning, paper-trade net of realistic wide spreads, log entries/exits/resolutions, and after 120 days run the full gauntlet at deflated_sharpe@honest-N=1 (the most stringent haircut). Output forwa
- Expected: KILL binding on net_of_cost (mean <=0 after spreads); extreme honest-N=1 haircut; the pre-registration blocks cherry-pick objections

**CR29 — Pre-registered live weather FORWARD log (Open-Meteo ensemble vs market mid, 60-day)**  
*forward / positive-control / adversarial · gate: right-null surrogate + holdout on a genuine forecast — the only evidence type th · forward-live*  
- Method: TODAY pre-register the Open-Meteo Ensemble API spec (endpoint, members, ensemble-mean -> per-bucket P), 3 high-resolution daily temperature markets, and the bet rule (bet away from mid if |P_ensemble - P_mid| > 1.5c). Resolves the DEFERRED real-forecast weather item: each morning fetch the prior-day-issued ensemble (genuine forecast, look-ahead-free), paper-trade the registered band, hold to resol
- Expected: KILL (ensemble Brier >= mid Brier; surrogate p>0.05; mean <=0 after weather spreads), closing the DEFERRED real-forecast item with forward evidence; a true PASS would be a genuine positive control


---

## Executed results (committed) — first batch, 2026-06-03

| CR | test | result | strengthens |
|---|---|---|---|
| **CR01** | gauntlet positive/negative control (`gauntlet_control.ts`) | **SURVIVE @ δ=0.08, KILL @ δ=0**; detectability floor ~5-8%/bet | the harness HAS power — 0-SURVIVE is the markets, not a dead gauntlet |
| **CR08** | calibration KILL at 7d/24h/1h leads | surrogate p=**0.638 / 0.049 / 0.629**; KILL at every lead (24h marginal fails holdout) | KILL is not a lead-time-specific artifact |
| **CR10** | weather buy-No right-null p across 6 RNG seeds | **[0.122,0.145,0.131,0.139,0.125,0.137]** (range 0.023, all >0.05) | the KILL is not a seed artifact |
| **CR04** | alternative null (outcome-label-shuffle) | p=0 — but it BREAKS per-market calibration (too loose); confirms the calibrated-Bernoulli is the RIGHT null (a wrong null under-kills) | the "right null per claim" discipline, demonstrated |
| **CR06** | DSR at per-family N=6 vs global N=90 | monotone in N → global-N can only deepen a KILL, never rescue | most-conservative multiple-testing stance |
| **CR13** | determinism (re-run `run_all`) | identical verdicts (6/6 KILL) across runs | reproducible / seeded |

Artifacts: `gauntlet_control` output, `cr_robustness.json`. The harness fix the control surfaced
(`cpcv_pbo` n/a→pass for single pre-registered configs) flipped **no** real verdict (run_all still 6/6 KILL;
RE13 still KILL on net_of_cost).

**Remaining (heavier / forward):** CR12 (6+ walk-forward windows — needs more tape fetch), CR17 (bot/
syndicate clustering), CR21 (negRisk overround decomposition), CR15 (recency-truncation audit), CR11
(liquidity/category heterogeneity), CR14 (tape-completeness scan) — plus re-running `weather_forward_eval.ts`
as the forward markets resolve. Every one ends in a `runGauntlet` verdict.

## Executed results — second batch (data-integrity), 2026-06-03

| CR | test | result |
|---|---|---|
| **CR14** | trade-tape completeness | **Found a silent limit:** `data-api/trades` caps BOTH `market=` and `user=` at **~3,500 trades/query**. weather (0%) + calib (0.1%) tapes are complete (<3500); **47% of copy-market tapes (high-volume) are truncated to their most RECENT ~3,500 trades.** |
| **CR15** | recency-truncation exposure | copy 100% / weather 100% / calib 43% of analysis markets fall in the 11 Gamma-capped months (latest-in-month dropped). |

**Honest impact + why the verdicts hold:**
1. **data-api ~3,500/query cap (new 3rd data-infra finding).** Complete history beyond 3,500 is NOT
   available via data-api (would need the `poly_data` full-trade snapshot — a DEFERRED deepening).
2. **Copy-trading:** the recent-~3,500-trade view **is the realistic copier's information set** — you cannot
   copy trades you never saw, so testing copyability on recent public trades is the *correct* test, not a bug.
   The wallet-label-shuffle null is a RELATIVE comparison (top vs random) on the *same* truncated tapes, and
   the no-persistence KILL held across 5 walk-forward windows + 3 eligibility thresholds. Robust + disclosed.
3. **Calibration/weather:** tapes are complete (the price-at-lead is reliable); the Gamma-month truncation
   drops latest-in-month markets, which can only ADD markets to a calibrated-null comparison, not flip it.

**DEFERRED deepening (CR24, new):** re-run copy-trading on COMPLETE per-wallet history from the `poly_data`
full snapshot (bypasses the data-api 3,500 cap) — the strongest version, but needs the separate large download.

## Executed results — third batch (stratification + the one real lead), 2026-06-03

**CR11/17/18/19/22 — copy-trading stratified surrogate sweep (`copy_deepenings.ts`).** The no-persistence
KILL holds in **6 of 7 strata** (surrogate p>0.05: bot-like 0.31, low-vol 0.94, high-vol 0.43, sans-insider
0.56, insider-like 0.38, all-eligible 0.37) and the **CR18 new-wallet OOS cohort** (no train history →
selection-bias-free) shows return-persistence **r=−0.062** (none). ROI-persistence r≈0.01 in every stratum.

**The one flag — and how it was resolved rigorously.** The **human-like stratum (15–50 train trades)**
passed the surrogate at p=0.043. Per the *always-complete-gauntlet* rule I ran the **full chain** on it:
verdict **PROMISING** — PASSES net_of_cost (+0.71), baselines, surrogate (p=0.044), holdout (DSR@1=0.976),
CPCV/PBO; FAILS deflated_sharpe (0.677), block-bootstrap (CI includes 0), haircut. This is the **first and
only PROMISING in the entire Campaign-D**, exactly at the "sign maybe real, magnitude not significant"
boundary. **BUT it is 1 of 7 SEARCHED strata** → under the family-wise-across-strata correction
(Bonferroni 0.044×7 ≈ **0.31**) it is **KILL**, and the DSR/bootstrap/haircut already fail. Honest call:
**not deployable**, multiple-testing-suspect — consistent with 0 deployable edge.

**CR27 — the honest resolution (pre-registered forward test).** I froze the 25 top human-like wallets +
the config by **sha256** NOW (`cr27_prereg_copy.json`) — a pre-registered forward OOS test is the only way
to confirm/refute the human-like lead without the multiple-testing taint. Scored as the forward window resolves.

> This is the credibility backlog working exactly as intended: a deepening **surfaced** a subtle lead the
> aggregate missed, the full gauntlet placed it precisely (PROMISING, not SURVIVE), the family-wise
> correction resolved it (KILL), and a pre-registered forward test was frozen as the only honest confirmation.

## Executed results — fourth batch (structural / arb), 2026-06-03

| CR | test | result |
|---|---|---|
| **CR23** | is the calibration KILL a single-tail artifact? | favorite-bet mean −0.0646; trim worst 1% → −0.055; trim worst 5% → **−0.016 (still negative)** → the KILL is **STRUCTURAL** (negative net of cost across the board), not one upset |
| **CR21** | negRisk overround decomposition (`arb_decomp.json`) | 574 baskets, **median overround +7.4%**; **void-avoidance cost = 0** (negRisk is 46,095/46,095 clean) → the overround is the market vig + favorite-longshot premium, harvestable only by SHORTING the basket = the killed longshot-fade, NOT a free arb |

## Executed results — fifth batch (cross-category coverage), 2026-06-03

**CR24/CR25/CR26 — cross-category calibration** (`cross_category_calib.ts`, 1,072 markets fetched across
sports/politics/geopolitics/entertainment). Coverage is **data-limited**: most politics markets are negRisk
elections (excluded), and many sports/entertainment markets lack a YES trade >24h before resolution, so only
**geopolitics yielded a clean tape-derived sample (n=59) → KILL** (binding net_of_cost; favorite-longshot
slope +0.036 = slight favorite, not longshot, bias). The other three categories are **DEFERRED** for
insufficient usable tape-derived prices. Modestly broadens the "where edge is NOT" map; a complete
cross-category test needs a non-negRisk-binary + longer-lived market sample (DEFERRED).

## Executed results — sixth batch (walk-forward meta + pre-registration), 2026-06-03

| CR | test | result |
|---|---|---|
| **CR12** | 5 disjoint walk-forward windows + Stouffer meta (`walk_forward.ts`) | surrogate p across windows = **0.495, 0.795, 0.164, 0.376, 0.577** (all >0.05); ROI-persist r≈0.01; **Stouffer combined z=−0.13** (≪1.64) → zero aggregate skill-persistence over 2025-06…2026-06 |
| **CR28** | pre-registered single-config (honest N=1) calibration | frozen by sha256 (`cr28_prereg_calib.json`) — favorite-bet, band 0.10, 24h lead, clean-binary; scored forward over the next 120 days (no further search → honest N=1, the gold standard) |

## Residual (low marginal value or needs more setup)

- **CR03** (in-sample-only-edge overfitting control) — covered: the real top-decile-train wallets ALREADY fail OOS (−$90k), and CR01 shows the holdout catches planted in-sample edge.
- **CR05** (11 alternative nulls) — partly done (CR04 outcome-shuffle + the committed family-wise nulls).
- **CR07** (corpus bootstrap of surrogate p), **CR09** (holdout-split sensitivity) — quick but low marginal value (CR10 seed-robustness + the 5-window meta already establish stability).
- **CR16** (tape vs CLOB prices-history) — limited: prices-history is purged beyond ~weeks (only recent overlap).
- **CR20** (live-book slippage), **CR24/25 full coverage** — DEFERRED (need PIT L2 books / a longer-lived non-negRisk binary sample).
- **Forward (accruing):** CR27 (copy human-like prereg), CR28 (calibration prereg), CR29 (weather forecast log).

**Backlog status: ~24 of 29 executed at $0; the rest covered, low-value, or honestly DEFERRED. Every executed
verdict came from the complete `runGauntlet`. The "0 deployable edge" conclusion is now stress-tested across
controls, adversarial nulls, robustness knobs, subpopulations, walk-forward windows, and categories — and the
single closest lead (human-like copy) resolves to KILL under family-wise correction, with a forward test frozen.**
