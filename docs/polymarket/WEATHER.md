# Campaign-D — Weather-Bot Hypothesis (validated)

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


Validation of the viral claim: a bot firing "Yes @ 9.1¢ / No @ 50¢" across 20+ cities, 74% win rate,
+$3.7K, $366K volume, 955 predictions, "$90→$1,000 Taipei 32°C Yes @ 9.1¢". Data: 700 recent weather
markets, 141,086 trades (`weather_analysis.ts`, `weather.json`).

## Verdict: pattern REAL, profit claim MISLEADING (it's the favorite-longshot bias + cherry-pick)

**(A) The bot pattern exists** — several wallets fire ~9.1¢ repeatedly across cities. But the actual
systematic "buy 9.1¢" wallet (`0xc7d02944…`, 441 trades, 90% buys, 45 @ 9.1¢) is **LOSING**: −$131,
**−7.5% of volume**, win rate 29%, realized mean −0.095 net of 2¢, **DSR@N=1 0.18, mean 95% CI
[−0.28, +0.10]** (includes 0). The 74%+ win rate in the claim belongs to a longshot-**SELLER**
(`0x5a218c…`, 85% WR, mostly sells, +$598 thin) — the same "high win-rate = sell longshots = thin/variance"
signature found campaign-wide. The "$90→$1,000" is **one cherry-picked 11× hit**, not the systematic result.

**(B) Why buying 9.1¢ weather longshots loses — the calibration:**

| YES price bucket | n (BUY-Yes) | mean price | realized YES rate | net return /$ (+2¢) |
|---|---:|---:|---:|---:|
| [0.05, 0.10) | 3,135 | 0.073 | **0.049** | **−0.489** |
| [0.08, 0.10) | 1,249 | 0.087 | **0.072** | **−0.333** |
| [0.10, 0.15) | 2,226 | 0.121 | **0.171** | **+0.210** |
| [0.15, 0.30) | 7,126 | 0.225 | 0.238 | −0.006 |
| [0.30, 0.70) | 10,433 | 0.422 | 0.416 | −0.084 |

Deep weather longshots (<10¢) are **over-priced** (resolve YES well below their price) → buying them is a
guaranteed bleed; the seller harvests it (with tail risk). This is the favorite-longshot bias again.

## The one genuine lead (→ external-information edge)

The **[0.10, 0.15] band is under-priced** (resolves 17.1% vs 12.1% priced, net **+0.21/$** at 2¢ spread).
A free weather forecast (NWS/open-meteo) could plausibly identify *which* of these threshold markets are
under-priced — i.e., a real external-information edge to test through the full gauntlet (wider weather
spreads + honest-N + holdout will be the test). This motivates the `EXTERNAL_INFO_EDGES` exploration.

> Net: the bot claim is survivorship + a cherry-picked 11× hit; systematic 9.1¢-buying loses. But the
> weather market does carry a real favorite-longshot structure, and a free forecast is the natural edge
> source to test next.

## External-information edge — TESTED through the COMPLETE gauntlet → KILL

The lead from above (could a free weather model exploit the temperature markets?) was run through the
full `runGauntlet` (`weather_edge.ts`, `weather_edge.json`). Model = **climatology** from the Open-Meteo
2015-2025 archive (same calendar date ±3d, the market's metric/unit) — **look-ahead-free by construction**
(all markets resolve 2026, archive ends 2025). Strategy: trade toward the model where |P_model − P_mkt(T-24h)|
> band; weather-realistic proportional spread; right null = **model-shuffle** family-wise MAX.

| Metric | Result |
|---|---|
| usable markets | 556 (parsed 700, with-model 637, with-price 556; 50 cities geocoded, Open-Meteo archive) |
| **Brier (lower=better)** | **model 0.1005 vs market 0.0708** → the market is BETTER-calibrated than free climatology |
| best band net return | **−0.26** (negative at every band) |
| gauntlet | **KILL** (binding net_of_cost): DSR 0.003, bootstrap CI [−0.48, −0.01], surrogate p=0.149 (model no better than a random-shuffled probability), holdout −0.41 |

**Verdict: KILL.** A free CLIMATOLOGY model does not beat the crowd — the market already prices climatology
(and the real forecast) better. The earlier "[0.10,0.15] underpriced" band was a small-sample market
calibration quirk, not a free-information edge a climatology model can capture.

**DEFERRED variant:** a genuine 1-2 day *forecast* (more skillful than climatology) might beat the market,
but Open-Meteo serves ≈analysis (≈actuals) for past dates, so a forecast backtest would be **look-ahead**.
The only honest test is a **live FORWARD log** (record current forecasts + market prices for markets
resolving in the next days, wait for resolution) — ~weeks for meaningful N. Deferred, not refuted.

## "@hightemptation" buy-No-on-longshots claim → KILL (the surrogate catches what DSR misses)

A second viral weather claim: "buy No at 85-96¢ on exact-temp markets (longshots), 98% win rate, +$7,600,
50 wins in a row, sell at 99-100¢ later" (`crisp.trade` copy funnel). This is the SELL-the-longshot side.
Tested directly (`weather_sell.ts`, `weather_sell.json`): buy No on weather markets whose YES price is a
longshot, hold to resolution, weather-realistic spread, full `runGauntlet`.

| theta (max YES) | n | No win-rate | mean net |
|---|---:|---:|---:|
| ≤ 0.04 | 335 | **1.000** | **+0.0023** |
| ≤ 0.06 | 368 | 0.995 | −0.0006 |
| ≤ 0.10 | 418 | 0.981 | −0.0079 |
| ≤ 0.20 | 482 | 0.954 | −0.0213 |

**Gauntlet (best, theta≤0.04):** net_of_cost PASS, baselines PASS, **DSR=1.000**, bootstrap CI
[0.0019,0.0027] (excludes 0), CPCV/PBO 0.014 PASS, haircut p=0.0000 PASS — **but surrogate FAILS p=0.128**
(real +0.0023 < calibrated-Bernoulli null95 +0.0044) → **KILL**.

**This is the canonical why-the-full-gauntlet-matters case.** Every classic gate (Sharpe/DSR/CI/winrate)
screams "edge!" because the 100% win rate gives tiny variance → huge Sharpe. The RIGHT NULL — the one gate
that asks *"is this better than a perfectly-calibrated market?"* — says no (p=0.128): the realized mean is
indistinguishable from, and below, what calibration alone yields. The "98% / 50-wins-in-a-row / +$7,600" is
**selling-longshot variance that has not yet met its tail**, and the stated thesis ("No = 80-90% real but
priced 85-96¢") is internally backwards (paying 96¢ for ~90¢). A bespoke harness without the surrogate would
have FALSELY promoted this — exactly the failure the "always run the COMPLETE gauntlet" rule prevents.

## Forward weather-forecast test (LIVE, accruing) — the one non-refuted external-info lead

The DEFERRED "real forecast > climatology" variant is now a running **forward, pre-registered** test (the
strongest credibility a skeptic respects — the signal is frozen before resolution, so zero look-ahead):

- `fetch_weather_forward.mjs` (run DAILY): for active weather markets resolving in the next days, logs NOW
  the Open-Meteo **ensemble forecast** P (31-member GFS, a real probabilistic forecast — not climatology)
  + the current market price, to `weather-forward-log.jsonl` (append-only).
- `weather_forward_eval.ts` (re-run as they resolve): joins to resolution, scores the pre-registered
  strategy (trade toward the forecast where |P_model − P_mkt| > band) through the COMPLETE `runGauntlet`
  (Brier forecast vs market, calibrated-Bernoulli null, holdout).
- **Status:** seeded **116 markets** (e.g. Milan 28°C forecast 0.39 vs market 0.001; Tokyo 14°C forecast
  ~0 vs market 0.09 — real disagreements). 0 resolved yet (settle 2026-06-03..05). Needs daily runs +
  ~40+ resolved for a powered verdict (~1-2 weeks). **No verdict claimed until `runGauntlet` runs on the
  resolved forward set** — per the always-complete-gauntlet rule.
- Caveat: "exact X°C" forecast P is sensitive to ensemble rounding + the market's exact resolution source;
  the ≥/≤ markets are the more robust subset (the eval can split them).

### Forward result (first scoring, 2026-06-05) → KILL (market beats even the real forecast)

33 forward markets resolved (pre-registered 2026-06-03, zero look-ahead). **Brier: forecast 0.0953 vs
market 0.0838 (lower=better) → the market is BETTER-calibrated than the real Open-Meteo ensemble forecast.**
Strategy (trade toward forecast where gap>band): mean −0.23, **KILL** (binding net_of_cost), surrogate p=0.28,
DSR 0.033. So even a genuine 1-2 day ensemble forecast does NOT beat the crowd — the DEFERRED variant is now
*forward-refuted* on the resolved subset (still small N=33; the logger keeps adding markets, so this accrues).
This is the strongest possible evidence (forward, pre-registered) that the weather external-info edge is dead.
