# Quarterly Public Report — TEMPLATE (copy to `YYYY-QN.md`)

> Cadence per `PROJECT_REVIEW_2026-06-09.md` §6 item 7 / §7. One report per quarter, aligned with the
> Campaign E look schedule. Everything here must be script-derived or doc-traceable — no hand numbers.

## 1. Verdict ledger delta
- New hypotheses tested this quarter (full 8-gate gauntlet only): N — list with binding gate + decisive number.
- Audited tally restated: SURVIVE / PROMISING / KILL totals (cross-check `data/kill-db.json` validation output).
- Any audit corrections or walk-backs (honesty section — defects found in our own work go here, prominently).

## 2. Campaign E look (pre-registered; consume-once)
- Look number K of the declared schedule; alpha-spending boundary for this look (from `docs/campaign-E/PREREGISTRATION.md`).
- Per-hypothesis (E1–E4): observed net Sharpe / boundary / decision (continue | KILL | SURVIVE-claim).
- E4 regime-trigger state: ON/OFF, days triggered this quarter, funding/basis readings.
- Statement: configs unchanged since prereg hash `<sha256>` (verify with `scripts/recorders/prereg-hash.mjs --verify`).

## 3. Recorders & data health
- Recorder uptime (days with snapshots / days in quarter), gaps and whether they are recoverable from exchange history.
- Corpus sizes + sha256 manifest deltas.

## 4. Accruing pre-commitments
- CR27 / CR28 / CR29 / weather-forward status; any that resolved this quarter get their once-only score here.

## 5. OSS metrics (vs baseline in `2026-Q2-baseline.md`)
| Metric | Baseline (2026-06-09) | This quarter | Δ |
|---|---:|---:|---:|
| Stars | 1 | | |
| Forks | 0 | | |
| Views (14d window at snapshot) | 34 (12 uniques) | | |
| Clones (14d window at snapshot) | 316 (134 uniques) | | |
| External PRs / issues | 0 / 0 | | |
| Community gauntlet runs | 0 | | |

Collection command: `gh api repos/kimlage/crypto-edge-search --jq '{stars:.stargazers_count,forks:.forks_count}'` + `/traffic/views` + `/traffic/clones` (14-day windows — snapshot the same week each quarter).

## 6. Next quarter
- Planned tests (must cite power pre-flight: `npx tsx scripts/power-check.ts --true-sharpe S --window-years Y`).
- Methodology/infra changes (versioned; never mid-look).
