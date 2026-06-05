# Campaign-D — Money-Management, Risk & Arbitrage ($0 attack on everything left)

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


> After the proof phase and reverse-engineering both returned 0 edge, the owner asked to attack
> *everything* that costs nothing — including **all portfolio/risk-management schemes** — to be sure
> none of it turns into profit. This page records three $0 attacks: live static arbitrage, a powered
> full-spectrum calibration, and an exhaustive money-management/risk gauntlet. **All KILL.**

---

## 1. Live static arbitrage — NO riskless edge

negRisk events are mutually-exclusive + exhaustive (exactly one member resolves YES), so YES asks
across a true basket must sum to ≥ 1 (arb-free). Scanned all live baskets two ways:

| Grouping | result |
|---|---|
| by event (8,000 live events → 1,955 negRisk baskets) | apparent sub-1 "arbs" are **truncated/incomplete leg lists + stale near-zero quotes** (a "$679k arb" was a 0.001-priced placeholder with phantom size) |
| **by `negRiskMarketID` (true basket id; committed `arb_baskets.mjs`, 579 baskets ≥3 legs)** | **median basket sum(ask) = 1.073** — a +7.3% **overround** (buying a guaranteed $1 costs $1.073) [live data; re-runs drift] |

- **Within-market complete-set** (ask_YES + ask_NO < 1) is **structurally impossible** — YES/NO share one
  CLOB book, so the sum is always 1 + spread.
- After requiring liquid two-sided quotes + a completeness proxy, buy-side candidates collapsed from
  "$679k" to **sub-$10, incompleteness-contaminated** micro-cases that don't survive gas + capital lockup.
- The pervasive **positive overround IS the favorite-longshot premium** — harvestable only by *shorting*
  the whole basket (buy NO on every leg), which needs collateral + the negRisk convert mechanism and is
  the same longshot-fade we kill in §3.

**Verdict: KILL.** The convert mechanism + bot competition keep the buy-side arb-free; no riskless profit.

---

## 2. Powered calibration — NO cost-survivable favorite-longshot edge (overclaim walked back)

> **Correction (per audit + `EVALUATION.md`):** the original headline here — "market is well-calibrated,
> surrogate p=0.993" — was an **overclaim**: that p=0.993 was computed over a corpus that is **50.7%
> negRisk multi-candidate legs** mixed with clean binaries (different price-generating processes).
> De-contaminated (clean-binary only, n≈402, `run_all.ts`): the surrogate is **marginal (p≈0.05)** —
> some favorite-longshot structure exists — but it **fails DSR / bootstrap / PBO / holdout at every cost
> level**, and at realistic wide spreads the mean goes net-negative. Honest claim: *no cost-survivable
> favorite-longshot trade survives the gauntlet*; surrogate rules out a TRADEABLE edge, it does not PROVE
> perfect calibration. The original n=816 mixed-sample table below is retained for the record.

The proof-phase calibration was n=171 (volume-skewed) and weakly passed the surrogate (p=0.012). A
stratified tape pull (1,200 extra markets across volume tiers/time) lifted it to **n=816 full-spectrum**:

**Reliability is essentially flat — the market is calibrated:**

| YES price bucket | n | mean price | realized YES | edge |
|---|---:|---:|---:|---:|
| [0.00,0.05) | 211 | 0.020 | 0.024 | +0.004 |
| [0.05,0.10) | 74 | 0.072 | 0.081 | +0.009 |
| [0.20,0.30) | 94 | 0.251 | 0.330 | +0.079 |
| [0.50,0.60) | 55 | 0.540 | 0.364 | −0.176 |
| [0.95,1.00) | 32 | 0.978 | 0.969 | −0.010 |

(deviations are small and sign-alternating = noise, not a systematic favorite-longshot bias.)

**Gauntlet — KILL on every gate**, and the surrogate now **flips**: every strategy config is negative,
**surrogate p=0.993** (worse than the calibrated-Bernoulli null), DSR 0.000, PBO 0.909, holdout −0.042.
**The n=171 "p=0.012 structure was real" was a small-sample artifact** — with power, there is **no
favorite-longshot edge at all.** This independently confirms the RE22 keystone (corpus on-winner gap +0.0001).

---

## 3. Money-management / risk gauntlet — NO scheme turns a ≤0 edge into profit

Tested every standard portfolio/risk scheme on the real ≤0-edge bet streams (1,500 Monte-Carlo
bet-order permutations, start $1,000), with a **synthetic +12% control** to prove the harness can detect
profit. Model: `B *= (1 + f·r)`.

**Control (synthetic +12% edge) — harness works:** fixed-frac 10% → median $44,971 (100% profit); full
Kelly → $36,725; over-betting (25%) → **100% ruin**; Martingale → 33% ruin even *with* an edge.

**Real streams (per-bet mean net return ≤ 0):**

| stream | per-bet mean | every honest scheme | over-betting |
|---|---:|---|---|
| Fade longshots (sell YES ≤0.15) | −0.0058 | all lose ($980 → $337) | vol-target/anti-Martingale bleed out |
| Buy favorites (YES ≥0.85) | −0.0996 | all lose ($933 → $122) | — |
| Bet-the-favorite (all) | −0.0406 | all lose ($710 → ruin) | fixed-10%→67% ruin, fixed-25%/vol-target/anti-Martingale→**100% ruin** |

Schemes tested: flat, fixed-fraction (1–25%), full/half/quarter Kelly, volatility-targeting,
Martingale, anti-Martingale, D'Alembert, max-loss-cap.

**Two decisive facts:**
1. **The only honest edge-aware sizer — Kelly with the market-implied probability — bets exactly $0 and
   holds bankroll at $1,000.** It correctly detects there is no edge and refuses to bet.
2. **"Kelly with the empirical calibration curve" looked profitable ($3,035) but is LOOK-AHEAD.** Train/test
   split (fit curve on earliest 60%, size on unseen 40%): all-data q → $4,261 (fake); **train-only q → $0
   (ruin); market q → $1,000.** Sizing on in-sample noise goes to ruin out-of-sample.

> **Verdict: KILL.** No **stateless** money-management scheme rescues a (Monte-Carlo–shuffled) ≤0-edge
> stream — sizing changes only the variance,
> the path, and the speed of ruin — it never creates an edge. With a ≤0 per-bet edge, the growth-optimal
> bet size is **zero**, and every scheme that bets a positive fraction loses; aggressive sizing (Kelly on
> noise, Martingale, vol-target) merely **accelerates ruin**. The synthetic control proves this is a real
> null, not a harness failure.

---

## Reproduce

```
node scripts/campaign-D/live_arb_scan.mjs            # §1 live arbitrage
node scripts/campaign-D/fetch_calib_tapes.mjs 400 4  # §2 stratified tapes
npx tsx scripts/campaign-D/tape_calib.ts && npx tsx scripts/campaign-D/calib_gauntlet.ts p_24h 0.01
npx tsx scripts/campaign-D/mm_risk_gauntlet.ts       # §3 money-management gauntlet
npx tsx scripts/campaign-D/mm_oos_check.ts           # §3 look-ahead proof
```

All free public data, **$0**. **Final campaign verdict: 0 deployable edge** — no direction, no
calibration, no copyable skill, no riskless arb, and no money-management scheme that rescues any of it.
