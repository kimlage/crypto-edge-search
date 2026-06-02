# EdgeHunt D5 — On-chain hypothesis batch (synthesis)

Eight on-chain BTC hypotheses run through the committed gauntlet (`scripts/edgehunt-D5/harness.ts::runGauntlet` against `src/lib/training/statistical-validation.ts`: net-of-cost @ 4bps/side, baselines vs B&H + matched-exposure random lottery, Deflated Sharpe @ honest N, block-bootstrap, CPCV/PBO, Harvey-Liu Bonferroni haircut, time-series phase-randomization surrogate `crossSectional:false`, consume-once forward holdout). On-chain features LAGged >=1d, next-day return, causality enforced. Each hypothesis got a genuine strengthening attempt at its own honest N.

## Verdict table

| ID | Hypothesis | Verdict | Net Sharpe | Binding gate | Honest N | Surrogate p | Holdout | B&H |
|------|-----------|---------|-----------:|--------------|---------:|------------:|--------:|----:|
| D5-08 | Exchange reserve/netflow trend | **PROMISING** | 0.994 | deflated_sharpe | 54 | 0.013 | +0.53 | 0.912 |
| D5-10 | Hash Ribbons | KILL | 1.133 | surrogate | 6 | 0.146 | +1.13 | 0.754 |
| D5-05 | Realized-price cost-basis S/R | KILL | 0.617 | baselines | 18 | 0.841 | +0.67 | 0.928 |
| D5-17 | Stock-to-Flow deviation | KILL | 0.579 | baselines | 16 | 0.399 | +0.73 | 0.765 |
| D5-16 | Metcalfe active-addr residual | KILL | 0.503 | baselines | 36 | 0.140 | -0.27 | 0.765 |
| D5-03 | MVRV-Z extreme bands | KILL | 0.365 | baselines | 72 | 0.399 | -0.02 | 0.646 |
| D5-09 | Puell Multiple | KILL | 0.333 | baselines | 18 | 0.409 | 0.00 | 0.850 |
| D5-13 | Stablecoin Supply Ratio | KILL | 0.148 | baselines | 54 | 0.425 | +0.09 | 1.023 |

## Counts

- **Total: 8** hypotheses
- **KILL: 7** (D5-03, D5-05, D5-09, D5-10, D5-13, D5-16, D5-17)
- **PROMISING: 1** (D5-08)
- **SURVIVE: 0**
- Binding gate distribution: `baselines` 6, `surrogate` 1, `deflated_sharpe` 1
- Surrogate null (phase-randomization): only D5-08 (0.013) and D5-16 (0.140) trend low; 6/8 reproduce their Sharpe under scrambling (p >= 0.15)

## SURVIVE / PROMISING callout

### D5-08 — Exchange reserve/netflow trend (BTC) — PROMISING

Raw native exchange FlowIn-FlowOut, EMA-smoothed, rolling-Z, LAG >=1d, next-day return. Best config `smooth=7, zwin=365, thr=0.5, longflat`.

- **Net Sharpe 0.994** vs B&H 0.912; conditional Sharpe **2.04** on the 27% signal-ON days; turnover 0.13; exposure 0.27.
- **Monthly @ $100k: ~$2,547/mo** (mean daily net 8.49e-4 over 3,118 days). This is the headline of the always-applied book; on the 27%-exposure basis the capital efficiency is the conditional-Sharpe-2.04 sliver.
- PASSES net-of-cost, baselines, block-bootstrap (CI95 [3.0e-4, 1.4e-3]), CPCV/PBO (0.350), surrogate (placeboP **0.013** — flow timing carries real, non-price-beta info; survives even price-orthogonalization in strengthening V3), holdout (+0.53 OOS).
- **Two independent caps keep it PROMISING, not SURVIVE** (both confirmed numerically):
  1. Binding gate `deflated_sharpe` at honest N=54 (DSR p=0.73; Harvey-Liu adjP=0.096). The strength lives in a grid-selected config — exactly what DSR penalizes. At N=1 the grid-best passes everything (DSR 0.998, haircut 0.0018), but the *pre-registered canonical* (smooth14/zwin180/thr1) is only net 0.478 with DSR@N=1=0.92 and surrogate p=0.21, so N cannot honestly shrink to 1.
  2. Does **not** generalize to ETH (net 0.39, exposure-matched random-lottery p=0.171).
- **Three genuine strengthenings, none beat the original:** V1 scale-free netflow ratio (net 0.83, fails baselines, surrogate borderline 0.053 -> KILL); V2 reserve-level trend slope (net 0.77, fails baselines + surrogate 0.186 -> KILL); V3 price-orthogonalized netflow (net 0.93, surrogate still passes 0.050, but holdout drops to 0.31 -> PROMISING but weaker).

**Follow-up:** (1) Pre-register the single canonical netflow-Z config and re-test forward on consume-once data to collapse N->1 honestly; if the pre-registered config (not a grid winner) holds, it can promote to SURVIVE. (2) Investigate why the edge is BTC-specific — exchange-flow attribution coverage may differ across assets; test on a second high-coverage asset before trusting generalization. (3) Size the live book on the 27% signal-ON conditional-Sharpe-2.04 regime rather than the always-on headline.

## Notable near-misses (informative KILLs)

- **D5-10 Hash Ribbons** — highest raw net Sharpe (1.133) and passes 7/8 gates, killed *only* by the hash-only surrogate. Decompose: price-only TSMOM (`price>SMA50`) = 1.217 > combined 1.133; incremental hash edge **-0.084**. The edge is the price-confirmation clause (long-beta), not hash rate. Phase-randomizing the hash series alone reproduces the Sharpe (surr95 1.295 > 1.133).
- **D5-03 MVRV-Z** — a strengthened stateful "hold-while-not-euphoric" variant (N=162) superficially flipped to apparent-PROMISING (net 0.934) but is byte-identical to B&H out-of-sample; all 70 timing days sit in the 2015-2017 in-sample window (band last fired 2017-12-18). Non-causal in-sample artifact.
- **D5-17 S2F** — residual is a price clock (corr 0.78 with expanding price-vs-time residual, 0.75 with 365d price momentum) -> Granger-Newbold spurious regression; causal IC 0.018->0.012 post-2021.
- **D5-13 SSR** — strengthened to 0.789 IS but holdout *inverts* to -0.239; lead-lag corr(SSR-Z, past-30d)=0.50 vs corr(SSR-Z, next-day)=0.02 -> reverse-causality echo (mints lag price).
- **D5-09 Puell** is 93% the Mayer price/365d-MA oscillator (R^2=0.87); **D5-05 realized-price S/R** is a fixed cost-basis line whose phase-randomized surrogate scores *higher* (placeboP 0.841) — same illusion as a random-line S/R; **D5-16 Metcalfe** active-address residual is mean-reverting noise (0/162 strengthened configs cleared surrogate AND held OOS).

## Recommendation

Carry **D5-08** to a pre-registered forward test (single canonical config, consume-once) as the only candidate with a real, price-orthogonal, surrogate-passing signal. Treat the other 7 as closed KILLs — each is a documented teaching case (price clock, long-beta confirmation clause, reverse-causality echo, cost-basis S/R illusion, mean-reverting noise) and none beat buy-and-hold at honest N.

---
Artifacts: `output/edgehunt-D5/result_*.json` (canonical gauntlet per hypothesis), `output/edgehunt-D5/strengthen_*.json` + `result_*_strengthen*.json` (strengthening probes), scripts in `scripts/edgehunt-D5/`.
