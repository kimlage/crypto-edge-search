# edgehunt-fundingrank — cross-sectional funding-rank L/S carry, formal full-gauntlet verdict

> _Evidence published; the runnable harness depends on the internal runGauntlet library and is not part of this public mirror yet._

**Lane W7 of PROJECT_REVIEW_2026-06-09.md §4.3 + §5A.3.** Formalizes the most-recycled
crypto-Twitter claim — *"short the high-funding coins, long the low-funding ones = free
money"* — into a publishable verdict through the full committed 8-gate chain
(`runGauntlet` from `src/lib/validation/strategy-validator.ts`, nulls from
`src/lib/validation/nulls.ts`). An adversarial judge already replayed the idea informally
on the cached 8-major panel (funding leg +3.27%/yr Sharpe 3.4, price leg −7.64%/yr, net
Sharpe −0.12, last-12m −0.87). This lane (a) reproduces that replay on the same cached
panel and (b) runs the honest survivorship-free wide-panel test.

**THIS README WAS WRITTEN AND COMMITTED-TO BEFORE ANY RESULT WAS COMPUTED.** Everything
below the "Declared design" line is frozen pre-registration; `RESULTS.md` reports what
came out. honestN = exactly the 12 configs declared here — no other knob was searched.

---

## Declared design (pre-registered, before running)

### Panel (survivorship-free)

- **Symbol enumeration:** ALL `*USDT` UM perpetuals that ever existed, enumerated from the
  `data.binance.vision` S3 listing of `data/futures/um/monthly/fundingRate/` (733 symbols
  at fetch time, retains delisted perps — FTTUSDT verified). This kills the survivorship
  objection at the enumeration level: a symbol cannot escape the panel by dying.
- **Data per symbol:** daily perp klines (close + quote-asset dollar volume) and 8h funding
  stamps. Source: Binance REST first (`fapi/v1/klines`, `fapi/v1/fundingRate` — verified
  live to serve DELISTED symbols when an explicit `startTime` is passed: FTTUSDT, SRMUSDT,
  LUNAUSDT, BTSUSDT, SCUSDT all serve full history; this supersedes the "REST only serves
  listed symbols" caveat in `scripts/fetchers/README.md`), monthly zip dumps from
  `data.binance.vision/data/futures/um/monthly/{klines,fundingRate}/` as fallback for the
  symbols REST refuses (e.g. BTCSTUSDT klines → `-1122 Invalid symbol status`).
  Keyless, paced, resumable cache under `output/fundingrank/cache/`.
- **Universe rule (PIT, monthly):** at each calendar month-end (last panel date of the
  month), eligible = USDT perps with ≥60 daily volume observations in the trailing 90
  calendar days AND a close on the formation date AND a computable funding signal. Rank by
  **median daily quote volume over the trailing 90 days**; take the **top 30** (all
  eligible if fewer). The universe formed at month-end M is traded throughout month M+1.
  No hindsight list — formation uses only data through the formation close.
- **Window:** trading 2021-01-01 → 2026-05-31 (universe/signal data from 2020-10-01). If
  the first formation dates have <20 eligible names the start is moved to the first month
  with ≥20 and documented in RESULTS.md.
- **Reproduction panel:** the cached 8-major panel `output/funding/` (2023-06 → 2026-05,
  BTC/ETH/BNB/SOL/XRP/DOGE/ADA/AVAX, perp closes), same engine, same 12 configs — the
  judge-replay reproduction.

### Strategy + declared config grid (honestN = 12, exactly)

Signal at formation close t: **mean daily funding** over the trailing lookback window
(sum of 8h funding stamps in (t − L, t] divided by L; interval-agnostic so 4h-funding
symbols are treated consistently; requires stamps covering ≥ half the window's days).
SHORT the highest-funding leg, LONG the lowest-funding leg (the CT claim verbatim).

Grid = 3 × 2 × 2 = **12 configs**, declared here and nothing else:

| Knob | Values |
|---|---|
| Funding lookback L | 20d, 30d, 45d |
| Legs | quintile (K = floor(n/5) per leg), tercile (K = floor(n/3) per leg) |
| Rebalance | weekly (Monday close UTC), monthly (month-end close) |

- **Weights:** equal-dollar within each leg, $1 long / $1 short per $1 equity
  (dollar-neutral, gross 2.0). Positions drift with prices between rebalances.
- **Cashflows (the point of the test):** daily P&L = price leg + ACTUAL funding cashflows
  on both legs, signed correctly — a short RECEIVES positive funding, a long PAYS positive
  funding; stamps are credited on their UTC date, positions entered at close of day D
  collect from the 00:00 UTC stamp of D+1.
- **Costs:** taker 4 bps per side on traded notional (4e-4 × Σ|Δposition|) at every
  rebalance and forced exit.
- **Financing:** NO extra borrow charge — perpetual funding IS the financing of a perp
  position and it is charged explicitly as cashflows above. Declared to `runGauntlet` as
  `financing: { borrowAprAnnual: 0, periodsPerYear: 365, avgLeverage: 2 }` so the
  financing leg is explicit (rate 0, documented) rather than silently absent.
- **Delisting handling:** a name whose price data ends while held is force-exited at its
  last available close (taker cost charged); proceeds idle until the next rebalance.

### Pre-registered binding diagnostic

Per-config decomposition: **funding-leg P&L vs price-leg P&L, reported separately.** The
claim's mechanism is "the funding coupon is free money"; the claim DIES if the funding
coupon cannot cover the price-leg bleed net of costs (i.e. the decomposition, not just the
headline Sharpe, is the teaching case either way).

### Gauntlet (full committed 8-gate chain, no subset)

Champion = best train-window Sharpe among the 12 configs. Train = 2021-01-01 →
2025-04-30; **holdout = last 20% chronological (2025-05-01 → 2026-05-31), consume-once.**

1. `net_of_cost` — mean net daily return > 0 (funding cashflows + taker costs included).
2. `baselines` — must beat ALL of: (a) B&H BTC mean daily return, (b) equal-weight long
   panel (the same monthly top-30 universe, equal-dollar long, monthly rebalanced, same
   costs), (c) 95th percentile of **200 exposure-matched random dollar-neutral books**
   (same rebalance dates, leg sizes, weights, and costs as the champion; random name
   assignment; seeded).
3. `deflated_sharpe` — DSR @ honestN = 12, bar 0.95.
4. `block_bootstrap` — 95% CI on the mean must exclude 0.
5. `cpcv_pbo` — purged CPCV PBO over the 12-config grid (8 folds), must be < 0.5.
6. `haircut` — Bonferroni-style multiple-testing haircut at N = 12, p < 0.05.
7. `surrogate` — **family-wise MAX cross-sectional shuffle**: per draw, permute the
   funding-signal-to-asset assignment within each rebalance date's universe
   (`crossSectionalShuffleNull` semantics; one permutation per (frequency, date), shared
   across lookbacks within the draw), recompute ALL 12 configs on the train window, take
   the MAX mean net return; ≥300 draws; `nullKind: "family_wise_max"`.
8. `holdout` — consume-once; n ≥ 5 AND mean > 0 AND DSR@N=1 ≥ 0.95.

Verdict discipline: SURVIVE / PROMISING / KILL exactly as `runGauntlet` rules them;
binding gate = first failure.

### Diagnostics (reported, non-gating)

- **Power pre-flight:** `preflightPowerCheck` for the realized window (KILLs need no
  power; a surprise positive does — printed in RESULTS.md either way).
- **BTC beta with honest-OOS hedge:** beta estimated on train only, hedge applied to the
  holdout; both raw and hedged holdout stats reported.
- **Momentum-factor loading:** regress champion daily net returns on a simple 90d
  cross-sectional momentum factor built from the SAME panel (weekly, tercile legs, long
  winners / short losers, costless factor) — the short-high-funding leg is implicitly
  short-momentum and the loading quantifies it.
- **8-major reproduction:** the same 12 configs on `output/funding/` with the
  judge-replay headline numbers (funding +3.27%/yr, price −7.64%/yr, net −0.12, last-12m
  −0.87) as the comparison target.

### Namespace note

This is the **cross-sectional funding RANK** claim — distinct from D8-C1 cross-venue
funding dispersion (KILL: wedge ≪ costs) and from E2 funding-LEVEL time-series carry
(`docs/EDGE_SEARCH_DOMAIN_CAMPAIGN.md`). Zero prior ledger entry occupies this namespace.

---

## Files

| File | What |
|---|---|
| `build_panel.mjs` | Survivorship-free panel builder (S3 enumeration → REST-first/dump-fallback klines + funding → `output/fundingrank/panel/`). Resumable; polite pacing; `--selftest`. |
| `fundingrank_test.ts` | The 12-config backtest engine + decomposition + full `runGauntlet` chain + diagnostics + 8-major reproduction. Writes `output/fundingrank/*.json` and prints the gate-by-gate verdict. |
| `RESULTS.md` | Results (written AFTER this README; reproduction, decomposition table, gate-by-gate verdict, teaching case). |
| `killdb-entry.json` | Proposed `data/kill-db.json` entry for the coordinator to merge (this lane does not touch the kill DB). |

Run:

```sh
node scripts/edgehunt-fundingrank/build_panel.mjs            # builds output/fundingrank/panel (resumable)
npx tsx scripts/edgehunt-fundingrank/fundingrank_test.ts     # full gauntlet + artifacts
```
