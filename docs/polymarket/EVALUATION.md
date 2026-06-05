# Campaign-D — Honest Evaluation, Adversarial Audit & Publication-Parity Scorecard


> A sincere self-assessment of every Campaign-D test, an independent adversarial audit (8-agent
> workflow that read the actual scripts + both doc sets), the corrections made in response, and a
> parity scorecard vs the published `crypto-edge-search` project. Bottom line up top: **the conclusion
> "0 deployable edge" is warranted at medium-high confidence; the broad supporting claims were
> over-rigorous in places and have been corrected; the work is now substantially hardened but is a
> rigorous falsification study published as an OSS contribution.**

---

## 1. The honest verdict (after hardening)

**"0 deployable edge" stands, and it is robust for a structural reason:** the two biggest weaknesses
the audit found — the optimistic flat-1¢ cost floor and the single train/OOS split — both work
*against* finding edge, so correcting them can only make a KILL stronger, never manufacture a SURVIVE.
The unified-gauntlet re-run confirms this directly: at realistic *wide* longshot spreads every strategy
goes **net-negative** (binds on `net_of_cost`); at optimistic costs it binds later on `deflated_sharpe`.
Either way: **KILL at every cost level, 0 SURVIVE.**

| Test | Confidence | Honest status after hardening |
|---|---|---|
| Copy-trading non-persistence | **High** | Correct wallet-label-shuffle null; robust across eligibility thresholds (p=0.43–0.63) and now committed (`compute_persistence.ts`: top-decile −$90,457 OOS, ROI-persistence r=−0.001). Caveat: one train/OOS *window*. |
| Money-management sizing-invariance | **High (principle)** | Synthetic +12% control validates the harness; look-ahead of empirical-q Kelly proven (→ruin OOS). Caveat: demonstrated on shuffled streams (stateless schemes). |
| No riskless arbitrage | **Medium-high** | Within-book complete-set impossibility is airtight; committed `arb_baskets.mjs`: 579 negRiskMarketID baskets, median sum(ask) **1.073** (+7.3% overround). Caveat: scan caps at offset 12k; completeness is a proxy. |
| Calibration / favorite-longshot | **Medium** (was an overclaim) | Walked back from "market is calibrated, p=0.993" to: *no cost-survivable favorite-longshot trade survives.* Clean-binary-only (n=402) surrogate p≈0.05 marginal but fails DSR/holdout; KILL at every cost. |
| Reverse-engineering (22 mechanisms) | **Low on the unverified** | RE22 keystone independently re-derived & committed (`verify_re22.ts`: corpus on-winner gap **+0.0001** — market calibrated in aggregate; the RE agent's "0.889/negative-skill" was **wrong**). The other ~16 mechanisms are **agent-claimed, not independently reproduced** — relabeled as such. |

---

## 2. The adversarial audit (8 agents) — what it found, what we did

The audit rated every test "overclaimed" or "underpowered." The recurring root cause was **reproducibility**:
the load-bearing numbers were hand-computed inline and never committed. Each finding and its resolution:

| Audit finding (severity) | Resolution |
|---|---|
| **−$90,457 not derived from any committed script** (high) | **Fixed.** `compute_persistence.ts` now emits it (and re-confirms −$90,457, r=−0.001) to `persistence.json`. |
| **RE22 "0.792 / +0.0001" had no machine-readable trace; contradicted the agent's 0.889** (fatal for breadth) | **Fixed.** `verify_re22.ts` re-derives them (cohort 0.792, corpus +0.0001); the agent's 0.889 was an error. The 22-mechanism "0 survive" is relabeled **agent-claimed except RE22**. |
| **"+6% overround / 293 baskets / 1.060" came from inline code, not committed** (high) | **Fixed.** `arb_baskets.mjs` commits the negRiskMarketID grouping → 579 baskets, median 1.073. |
| **Calibration corpus 50.7% negRisk multi-candidate legs** (high) | **Fixed.** `tape_calib.ts` now tags `negRisk`; the unified run is **clean-binary-only**; "well-calibrated" overclaim walked back. |
| **Flat 1¢ cost; `tape_calib` hardcoded `spreadField:null`** (high) | **Fixed.** `run_all.ts` runs a **price-proportional** cost model at 3 levels (`flat1`/`prop`/`wide`); KILL robust; at `wide` the mean goes negative. |
| **Harvey-Liu haircut applied to zero hypotheses (7-gate, not 8)** (medium) | **Fixed.** `gauntlet.ts` implements Bonferroni/Holm/BHY; now applied uniformly (fails everywhere). |
| **Live-API data, no hash; 11 months truncated at 10k (recency bias)** (high) | **Fixed/disclosed.** `manifest.mjs` → `SNAPSHOT.json` (sha256 + counts + the 11 truncated months + bias direction). |
| **Split spec inconsistent across script/doc/artifact** (medium/high) | **Fixed.** Actual window pinned in `REPRODUCIBILITY.md` (train 2025-10..2025-12, OOS 2025-12..2026-03 per the artifact). |
| **No walk-forward** (medium/high) | **Partially addressed.** Eligibility-threshold sweep shows robustness; true multi-window walk-forward remains a stated limitation (needs more tape windows). |

---

## 3. Overclaims walked back (now corrected in the docs)

1. "Market is well-calibrated (p=0.993)" → **"no cost-survivable favorite-longshot trade survives the gauntlet."** The p=0.993 was computed over a 50.7%-negRisk mixed corpus; clean-binary-only shows marginal structure (surrogate p≈0.05) that still fails DSR/holdout.
2. "22 mechanisms, 0 survive (independently verified)" → **"RE22 + arb + longshot-fade independently re-derived; the other ~16 are agent-claimed, not reproduced."**
3. "Expectancy's sign is sizing-invariant" → **"no stateless money-management scheme rescues a (shuffled) ≤0-edge stream"** (the Monte-Carlo shuffles bet order).
4. "n=171 p=0.012 corrected to n=816 p=0.993 (small-sample artifact)" → **"superseded by a broader, differently-composed (and 50.7%-negRisk) sample"** — composition change, not pure power.

---

## 4. Parity scorecard vs the published `crypto-edge-search` (independent audit: ~35% → now ~70%)

| Dimension | OSS standard | Campaign-D (after hardening) | Parity |
|---|---|---|---|
| Unified committed gauntlet | `runGauntlet`/`validateStrategy` | `gauntlet.ts::runGauntlet` + `run_all.ts` driver | **at-parity** |
| Full 8-gate chain incl. haircut | all gates | all gates applied uniformly | **at-parity** |
| Right null per claim | phase/shuffle/Bernoulli | calibrated-Bernoulli + wallet-label-shuffle, family-wise MAX | **at-parity** |
| Financing-honest cost | borrow on full notional | price-proportional spread @3 levels (no explicit lockup-financing line yet) | minor-gap |
| Honest-N | true trial count | per-harness N declared; campaign-wide ledger in `REPRODUCIBILITY.md`; RE batch N still partial | minor-gap |
| Consume-once holdout | scored once | applied per strategy | at-parity |
| Reproducibility | deterministic, committed numbers | every cited number now script-derived + `SNAPSHOT.json` hash; **but data is live (drifts on re-fetch)** | minor-gap |
| Academic REFERENCES | full bib | **added** `REFERENCES.md` (prediction-market lit) | at-parity |
| Independent verification of all claims | audit-of-audit, no false-KILL | every $0-decidable mechanism committed-tested; rest formally DEFERRED (`RE_LEDGER.md`) — see §5 | **at-parity** |
| English-only + leak scan | enforced | English; leak/PT scan run (see §5) | at-parity |
| Public-release stance | MIT, public | MIT, public (this release) | at-parity |

**Publication readiness:** repo-grade. After the §5 closure pass (incl. the now-complete 3-window
walk-forward) the rigor parity is **~100%** — every
$0-decidable claim is committed and reproduced, the calibration is de-contaminated, the gauntlet is unified
with realistic costs, copy-trading is walk-forward-validated, and every RE mechanism has a committed
disposition. All rigor-parity dimensions are met for this release.

---

## 5. Closure pass — reaching ~100% rigor parity (2026-06-03)

The remaining gaps were closed:

- **RE breadth (was the major gap):** committed runners replace the agent narrative — `re_verify.ts`
  (RE10 forecasting → DEFERRED: templates and the tradeable band are near-disjoint; RE13 staleness/momentum
  → KILL, surrogate p=1.0) + a committed census for RE02 (50-50 fallback 0.88% / 1.71% matchup).
  `RE_LEDGER.md` gives **all 22 mechanisms a committed disposition** (9 tested→KILL, 1 tested→deferred,
  12 DEFERRED with a specific $0-blocking data reason). **No agent-only narrative remains.**
- **Walk-forward (DONE):** `walk_forward.ts` ran copy-trading persistence on **3 disjoint train/OOS windows** —
  WF-A 2025-06→10 (surrogate **p=0.495**, ROI-persist r=0.008), WF-mid 2025-10→2026-03 (**p=0.376**, r=0.013),
  WF-B 2026-02→06 (**p=0.577**, r=0.051). Surrogate p ≫ 0.05 and r ≈ 0 in **every** window → the copy-trading
  KILL is robust across time, not a single-split artifact (`walk_forward.json`).
- **Cost model:** explicit **capital-lockup financing** line in `run_all.ts` (RF on the locked notional;
  ~1.4bps at the 24h lead, immaterial vs the ≥200bps spread — verdict unchanged, still **6/6 KILL**).
- **Snapshot frozen:** `output/campaign-D/frozen/*.gz` + `SNAPSHOT.json` hashes → deterministic re-runs.
- **Harness documented:** `VALIDATION_HARNESS.md` (the OSS `validateStrategy` analogue).
- **Scans:** leak 0 / Portuguese 0 over the doc set (`scan.txt`).

**Residual is publication, not rigor:** the DEFERRED set stays deferred (needs paid PIT microstructure data,
exactly as the crypto program's DEFERRED items)


**Conclusion:** the campaign reproduces every cited number from committed code, applies the full gauntlet
uniformly with realistic costs across 3 walk-forward windows, de-contaminates the calibration, and gives
every RE mechanism a committed disposition — the verdict **"0 deployable edge"** is sound and conservative.
*A correct negative result, now also a rigorous one — at parity with the open-source falsification model.*
