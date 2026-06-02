# EdgeHunt D7 — Synthesis

_Generated 2026-06-01. Sample ceiling: free PIT-clean BTC daily in-repo starts 2017-08-17 (Binance listing)._

## Counts

| Bucket | N |
|---|---|
| Hypotheses dispatched | 11 |
| Completed (judged to a verdict) | 3 |
| Did not complete (server rate-limited, no verdict) | 8 |
| **SURVIVE / PROMISING** | **0** |
| **KILL** | **3** |

All hypotheses that reached a judgment were **KILL**. No SURVIVE or PROMISING. The 8 incomplete slots returned `API Error: Server is temporarily limiting requests` — these never ran and carry **no verdict** (re-queue; do not count as KILL).

## Verdict table

| ID | Hypothesis | Verdict | Net Sharpe | vs B&H | Binding gate (failed) | Honest N | Surrogate p | Monthly @ $100k | Conf |
|---|---|---|---|---|---|---|---|---|---|
| D7.1 | Four-year halving cycle / post-halving drift | **KILL** | 0.86 (canonical 365d) / 1.06 (547d strengthened) | B&H 0.48 | DSR@N = 0.943 fails 0.95; + long-beta trap | 2 genuine (3 w/ partial 2016) | 0.0002 (reanchor) | n/a | high |
| D7.18 | Stablecoin mint-as-event (supply prints precede pumps) | **KILL** | 0.89 (selection-inflated) | BTC B&H 0.36 | Deflated Sharpe@N=128 = 0.65 (need <0.05); CSCV/PBO 0.59 | 128 | 0.31 BTC / 0.41 ETH (family-wise MAX; naive per-cell 0.007 is the trap) | n/a (+$1,599 inflated, do not bank) | high |
| D7.19 | Funding settlement-timing micro-flows (refines carry) | **KILL** | -0.073/8h standalone (best of 128); incremental -0.78/8h vs carry | carry baseline ~25 ann | must-add-over-carry-net-of-turnover (incremental Sharpe <0, bootstrap CI entirely <0) | 128 | 1.0 incremental (0.0005 standalone, but real still loses) | -$1,992 if traded | high |
| — | 8 further D7 slots | **NO VERDICT** | — | — | run never executed (rate-limited) | — | — | — | — |

## SURVIVE / PROMISING callouts

**None.** Zero strategies cleared the gates, so there is no monthly %/$ to report on the positive side. For completeness, the only positive-looking standalone number in the batch — D7.18's **$1,599/mo @ $100k** for the BTC winner cell — is **selection-inflated and not real**: it is the best of 128 mined cells, and the honest family-wise MAX-statistic null puts it at p=0.31 (indistinguishable from noise), DSR deflatedProb 0.65, PBO 0.59. Do not bank it.

## Why each KILL (one line)

- **D7.1** — Honest N is hard-capped at **2 genuine in-sample post-halving years** (2020, 2024); the 2012/2016 halvings have no free PIT-clean data. The "strengthened" 547d window reaches N=3 only by swallowing the Aug-2017→Jan-2018 parabolic top (+277% in 142d) — the exact long-beta-sampled-part-time trap (captures **137% of B&H lifetime return while long only 39% of days**, 3.55x leverage). DSR cannot mathematically clear 0.95 at N=2; reanchor null rejects only because BTC bull legs cluster 12-18mo post-halving (real structure != tradable forward edge).
- **D7.18** — Apparent edge is the best of a 128-cell grid on 16-50 events with ~15% single-event fragility. The honest family-wise MAX-stat placebo (re-mines the whole grid on shuffled signals) gives p=0.31/0.41 — real grid-max is below the placebo-max P95. Reverse-causality control (orthogonalize mint vs 5 lags of returns) survives only trivially; mechanism is coincident demand (issuers mint *after* inflows), not a lead.
- **D7.19** — Every one of the 128 overlay cells **loses money standalone** (best -0.073/8h); adding directional intraday risk to a near-deterministic delta-neutral funding stream (carry Sharpe ~25 ann) can only lower it. Incremental Sharpe -0.78/8h, block-bootstrap incremental-mean 95% CI entirely below 0 (upper -4.0e-5), DSR ~ 0, PBO 0, Harvey-Liu haircut -> 0.

## Follow-up

1. **Re-queue the 8 rate-limited slots.** They returned server throttling errors, not verdicts — no signal was tested. These are the only open items in D7.
2. **Stop spending on calendar/halving-cycle claims (D7.1 family).** Structural ceiling: you cannot DSR-clear a 4-event calendar claim with 2 in-sample events. Matches the BACKLOG "n~3 unfalsifiable-in-favor" prior. Revisit only if a free PIT-clean pre-2017 BTC daily source appears (would lift honest N toward 4).
3. **Stablecoin-flow ideas (D7.18 family): always judge with the family-wise MAX-statistic null, never the per-cell placebo.** The per-cell p=0.007 here is the canonical data-mining trap; only the grid-max null is honest at N=128.
4. **Carry refinements (D7.19 family): the bar is "must ADD over the perfect-foresight carry survivor net of turnover," not "is positive standalone."** Any overlay that injects directional variance into the delta-neutral funding stream starts underwater. Screen future carry-micro ideas against the incremental-over-carry bootstrap CI before a full gauntlet.

## Artifacts

- scripts/edgehunt-D7/d7-1-halving-cycle.ts, d7-1-robustness.ts, d7-1-strengthen.ts -> output/edgehunt-D7/d7-1-halving-cycle.json, d7-1-strengthen.json
- scripts/edgehunt-D7/d7-18-stablecoin-mint.ts, d7-18-robustness.ts -> output/edgehunt-D7/d7-18-stablecoin-mint.json
- scripts/edgehunt-D7/d7-19-funding-settlement-timing.ts -> output/edgehunt-D7/d7-19-funding-settlement-timing.json, btc_15m_settle_window.json
