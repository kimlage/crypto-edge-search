# `scripts/campaign-D/` — the Polymarket pipeline

*[Wiki home](../../docs/INDEX.md) · [Polymarket docs](../../docs/polymarket/README.md) · [Reproducibility](../../docs/polymarket/REPRODUCIBILITY.md) · [Validation harness](../../docs/polymarket/VALIDATION_HARNESS.md) · [Glossary](../../docs/GLOSSARY.md)*

Every runnable piece of the **Polymarket (Campaign-D)** falsification campaign. All scripts run at **$0** on
the free Polymarket Gamma / CLOB / data-api and the free Open-Meteo archive. TypeScript runs via `tsx`
(`npx tsx <script>.ts`); `.mjs` fetchers run via `node <script>.mjs`. Outputs land in `output/campaign-D/`
(raw `.jsonl` tapes are gitignored — regenerate them with the fetchers; the small result JSONs are committed).

> **The one rule:** every candidate goes through **the complete gauntlet** — `gauntlet.ts::runGauntlet`,
> the full 8-gate binding chain. No partial validation, ever. See [`../../docs/polymarket/METHODOLOGY.md`](../../docs/polymarket/METHODOLOGY.md)
> and the [verdict scheme](../../docs/GLOSSARY.md#kill).

## Run order (cold start → verdicts)

```bash
# 1. DATA — fetch the free corpus (run once; tapes are cached under output/campaign-D/)
node scripts/campaign-D/fetch_resolved.mjs 202001        # resolved markets (Gamma), month-windowed
node scripts/campaign-D/fetch_copy_trades.mjs            # per-market trade tapes (data-api) → trades-cache/
node scripts/campaign-D/tape_calib.ts                    # derive the calibration corpus from the tapes
node scripts/campaign-D/manifest.mjs                     # pin the corpus → SNAPSHOT.json (sha256 + counts)

# 2. PROVE — run every family through the complete gauntlet
npx tsx scripts/campaign-D/run_all.ts                    # calibration + copy-trading @ 3 cost levels → 6/6 KILL
npx tsx scripts/campaign-D/gauntlet_control.ts           # positive control: SURVIVE @ planted δ=0.08, KILL @ δ=0

# 3. DEEPEN — the per-claim committed runners (each emits a JSON under output/campaign-D/)
npx tsx scripts/campaign-D/compute_persistence.ts        # copy-trading non-persistence → persistence.json
npx tsx scripts/campaign-D/walk_forward.ts               # 5 disjoint windows + Stouffer z → walk_forward.json
npx tsx scripts/campaign-D/verify_re22.ts                # RE22 keystone re-derivation → re22.json
node  scripts/campaign-D/arb_baskets.mjs                 # negRisk overround → arb_baskets.json
```

## Script index

### Data fetchers (free APIs, `$0`)
| Script | What it fetches / builds | Output |
|---|---|---|
| `fetch_resolved.mjs` | Resolved markets + resolution via Gamma `outcomePrices` (month-windowed; offset caps ~10k/window) | `resolved-markets.jsonl` |
| `fetch_copy_trades.mjs` | Per-market trade tapes (wallet/side/price/size) via data-api `/trades` | `copy-markets.jsonl`, `trades-cache/` |
| `fetch_calib_tapes.mjs` | Tapes for the calibration corpus | calibration tapes |
| `fetch_category_tapes.mjs` | Category-stratified tapes (for cross-category calibration) | category tapes |
| `fetch_weather.mjs` · `fetch_weather_climate.mjs` · `fetch_weather_forward.mjs` | Open-Meteo ensemble forecast / climatology / daily forward log | weather tapes |
| `price_at_lead.mjs` | Derive a market's price at a fixed lead time from the tape (CLOB history is purged beyond ~weeks) | — |
| `manifest.mjs` | Hash + count the corpus for deterministic re-runs | `SNAPSHOT.json` |

### The gauntlet
| Script | Role | Output |
|---|---|---|
| `gauntlet.ts` | `runGauntlet()` — the full 8-gate binding chain (incl. the in-house Harvey-Liu haircut) | (library) |
| `run_all.ts` | Driver: calibration-family + copy-trading through `runGauntlet` at `flat1`/`prop`/`wide` costs | `unified_gauntlet.json` |
| `gauntlet_control.ts` | Positive control — proves the harness SURVIVEs a planted edge and KILLs a zero edge | (stdout) |

### Copy-trading / wallet-skill
| Script | What it tests | Output |
|---|---|---|
| `copy_trading_gauntlet.ts` | Copy-the-top-wallets through the gauntlet (wallet-label-shuffle null) | (stdout) |
| `compute_persistence.ts` | Does train-ROI persist OOS? (top-decile PnL, ROI-persistence r) | `persistence.json` |
| `cohort_profile.ts` | Profiles the "high win-rate" cohort (the longshot-seller anti-signal) | `cohort_profile.json` |
| `copy_deepenings.ts` | Robustness deepenings of the copy KILL | `copy_deepenings.json` |
| `walk_forward.ts` | 5 disjoint walk-forward windows + Stouffer-z meta-combine | `walk_forward.json` |

### Calibration / favorite-longshot
| Script | What it tests | Output |
|---|---|---|
| `tape_calib.ts` | Builds the tape-derived calibration corpus (tags `negRisk` for de-contamination) | `calibration.jsonl` |
| `calib_gauntlet.ts` | Calibration / favorite-longshot fade through the gauntlet | (stdout) |
| `cross_category_calib.ts` | Per-category favorite-longshot slope (family-wise MAX) | `cross_category_calib.json` |
| `cr_robustness.ts` | Calibration-verdict robustness across knobs / strata | `cr_robustness.json` |

### Arbitrage
| Script | What it tests | Output |
|---|---|---|
| `arb_baskets.mjs` | negRisk basket overround (riskless-arb scan) | `arb_baskets.json` |
| `arb_decomp.mjs` | Decompose the overround (void-avoidance vs upset-tail premium) | `arb_decomp.json` |
| `live_arb_scan.mjs` | Live cross-market gap scan | (stdout) |

### Money-management
| Script | What it tests | Output |
|---|---|---|
| `mm_risk_gauntlet.ts` | Flat / fixed-fraction / Kelly / Martingale / vol-target / max-loss-cap on a ≤0 edge | (stdout) |
| `mm_oos_check.ts` | OOS check of the empirical-q Kelly look-ahead (→ ruin) | (stdout) |

### Reverse-engineering (22 mechanisms)
| Script | What it tests | Output |
|---|---|---|
| `verify_re22.ts` | RE22 keystone — observed on-winner gap vs price-tied Bernoulli null | `re22.json` |
| `re_verify.ts` | Committed runners for RE10 (→ DEFERRED), RE13 (→ KILL), RE02 census | (stdout) |
| `re_workflow.wf.js` | The multi-agent reverse-engineering workflow | (workflow) |

### External-information / weather forward test
| Script | What it tests | Output |
|---|---|---|
| `weather_analysis.ts` · `weather_edge.ts` · `weather_sell.ts` | Open-Meteo forecast vs the market (Brier) — buy / sell sides | `weather_edge.json`, `weather_sell.json` |
| `weather_forward_eval.ts` | Pre-registered **forward** weather test scoring (gold standard) | `weather.json` |
| `volume_spike.ts` | Volume-spike momentum (time-shuffle null) | `volume_spike.json` |

> Scratch/probe helpers (`_probe.ts`) are not part of the pipeline. Every committed result JSON in
> `output/campaign-D/` is indexed in [`output/campaign-D/results-ledger.json`](../../output/campaign-D/results-ledger.json).
