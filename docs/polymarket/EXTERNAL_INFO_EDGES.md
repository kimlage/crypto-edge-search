# Campaign-D — External-Information Edges (free-data forecasting leads)

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


Enumeration of the strongest hypotheses for using **FREE external information** as a forecasting edge on
Polymarket. Premise (from `WEATHER.md` / `RE_LEDGER.md`): the market is broadly well-calibrated and
copy-trading does not persist, but the weather `[0.10,0.15]` band is the one *live* lead where a free
forecast (NWS/NOAA/open-meteo) could pick which threshold markets are under-priced. This doc generalizes
that "external-information edge" prototype across categories, finds the specific free data source for each,
and is honest that **most are KILL because the crowd (or a free consensus aggregator) already prices them.**

The decisive bar for every hypothesis (inherited gauntlet, `METHODOLOGY.md`): can the free external model be
proven **better-calibrated than the market mid OUT-OF-SAMPLE** (not merely *different*), and does the residual
edge survive `net_of_cost(+spread) → baselines → DSR@honestN → block-bootstrap → CPCV/PBO → Harvey-Liu →
RIGHT-NULL surrogate → consume-once holdout`? Polymarket's ground-truth resolution makes every market a
labeled example, so all of this is $0 and decidable.

---

## Ranked table

Score 1-5 on `data_freeness` (D), `edge_plausibility` (E), `zero_cost_provability` (P). Rank key = D × E × P.
Prior: **P** = plausible-PROMISING, **W** = worth-testing, **K** = likely-KILL.

| # | Hypothesis (category) | Free source | D | E | P | D×E×P | Prior |
|---|---|---|---:|---:|---:|---:|:--:|
| H1 | **Weather temperature thresholds** (the prototype) | Open-Meteo Ensemble (ECMWF 9km + multi-model) / NWS api.weather.gov | 5 | 4 | 5 | **100** | **P** |
| H2 | **Box-office opening-weekend** (preliminary-vs-resolution lag) | Box Office Mojo / The Numbers daily chart | 5 | 4 | 5 | **100** | **W→P** |
| H3 | **Rotten Tomatoes score** (early-review / embargo-timing leak) | rottentomatoes.com Tomatometer page (scrape) | 4 | 4 | 5 | **80** | **W** |
| H4 | **Crypto daily/hourly up-or-down** (resolution-source = free spot) | Binance klines API (the literal resolution feed) | 5 | 3 | 5 | **75** | **W** |
| H5 | **Crypto end-of-period price targets** (option-implied vs crowd) | Deribit public API options chain + DVOL | 5 | 3 | 5 | **75** | **W** |
| H6 | **Hurricane / named-storm landfall & count** | NHC ATCF a-decks/b-decks + Open-Meteo | 4 | 3 | 4 | **48** | **W** |
| H7 | **Fed rate decision** (futures-implied vs crowd) | 30-day Fed Funds futures (ZQ) → compute FedWatch; CME web tool free | 4 | 2 | 4 | **32** | **K** (crowd tracks it) |
| H8 | **CPI / jobs "above-consensus" releases** | FRED + BLS APIs (free, post-release) | 5 | 1 | 3 | **15** | **K** (data lags) |
| H9 | **SpaceX / Starship launch-count & timing** | RocketLaunch.Live / SpaceX schedule + FAA notices | 3 | 2 | 3 | **18** | **K-lean** |
| H10 | **Earthquake "M≥x in window"** | USGS FDSN GeoJSON feed | 5 | 1 | 4 | **20** | **K** (memoryless) |
| H11 | **Near-Earth-object / asteroid pass** | NASA NeoWs (api.nasa.gov) | 5 | 1 | 4 | **20** | **K** (deterministic→priced) |
| H12 | **Astronomy / eclipse / launch-window deterministic** | NASA + USNO ephemerides | 5 | 1 | 3 | **15** | **K** (fully priced) |
| H13 | **Aviation / flight-status & on-time** | OpenSky Network ADS-B API | 4 | 1 | 2 | **8** | **K** (no such markets / lag) |
| H14 | **Sports game/championship winners** | ESPN hidden JSON / free odds + Elo | 4 | 1 | 4 | **16** | **K** (consensus = efficient) |
| H15 | **Gov-shutdown duration / bill-passage timing** | Congress.gov API + GovInfo | 4 | 2 | 3 | **24** | **K-lean** (news-priced) |
| H16 | **River-flood / NWS hydrologic gauges** | NWS AHPS / USGS Water Services | 4 | 2 | 3 | **24** | **W** (if such markets exist; thin) |

**Read in one line:** the only places a *free* edge plausibly leads the crowd are (a) **high-dimensional
threshold markets where pricing every bucket correctly is hard for humans** (weather H1, box-office H2,
maybe RT H3) and (b) **resolution-source timeliness races** (crypto H4). Everything that resolves on a
deterministic event (H10-H13) or a free consensus aggregator the crowd also reads (H7, H8, H14, H15) is a
structural KILL — the external data doesn't *lead* the price.

---

## Per-hypothesis detail

### H1 — Weather temperature thresholds (the prototype, plausible-PROMISING)
- **market + example:** "Highest temperature in NYC on June 2?" — a grid of mutually-exclusive ~1-2°F
  buckets ("76-77°F", "78-79°F"...). Resolves on **Wunderground LaGuardia (KLGA) daily high, whole °F.**
  Polymarket runs these daily for ~20+ cities (`polymarket.com/weather`).
- **free source:** **Open-Meteo Ensemble API** (`/v1/ensemble`, no key, CC-BY, 10k calls/day) — gives the
  full ECMWF-IFS 9km + NOAA/DWD/CMCC ensemble members, so you get a *probabilistic* daily-high distribution
  for free. Cross-check with **NWS `api.weather.gov`** (no key, User-Agent only) gridpoint forecast.
- **why crowd misprices:** humans cannot mentally price ~10 adjacent narrow buckets calibrated to a real
  forecast PDF; the campaign already measured the `[0.10,0.15]` band resolving 17.1% vs 12.1% priced
  (`WEATHER.md`). An ensemble gives a defensible per-bucket probability the crowd approximates badly,
  especially in the tails/shoulders.
- **timeliness edge:** YES — the ensemble updates 2-4×/day and the market lives for days; you're not racing a
  consensus, you're pricing a distribution the crowd eyeballs. Caveat: must align the forecast to **KLGA
  station specifically** (not "NYC"), and to the whole-°F rounding rule.
- **$0 test:** for each resolved market, pull the *archived* Open-Meteo ensemble issued at T-1 day (Open-Meteo
  has a free historical-forecast/reforecast archive), convert ensemble members → per-bucket P, compare to the
  trade-tape mid at the same timestamp, score both vs resolution with log-loss / Brier. Bet only buckets where
  `P_model − P_mid > spread`. Run the full gauntlet with **weather-realistic spreads (5-20¢ on longshots,
  per the audit)** and honest-N = number of *independent market-days*, not bucket-rows.
- **right null:** calibrated-Bernoulli family-wise MAX — resample each bucket ~ Bernoulli(mid), keep the
  model's bet logic; PASS iff the model's OOS Brier beats the mid's Brier beyond what mid-calibration gives.
  Equivalent honest question: *does the ensemble's log-loss beat the market mid's log-loss out-of-sample?*
- **failure mode:** (i) longshot spread eats the +0.21/$ band (the audit's `wide` cost already flipped weather
  longshot-buying negative); (ii) station/rounding misalignment manufactures fake edge that vanishes on the
  true KLGA series; (iii) honest-N is small (one label per market-day) → DSR haircut bites.
- **scores:** D5 E4 P5. **Prior: plausible-PROMISING** — the single best free-information lead in the campaign.

### H2 — Box-office opening-weekend (worth-testing → plausible)
- **market + example:** ""Mortal Kombat II" opening weekend box office" — bucketed ranges ($35-40M etc.).
  Resolves on the reported **domestic 3-day opening weekend.** ~103 active markets.
- **free source:** **Box Office Mojo** (`boxofficemojo.com/daily/`) and **The Numbers**
  (`the-numbers.com/daily-box-office-chart`) — both publish **Friday actuals + Saturday/Sunday preliminary
  estimates for free**, before the market's official resolution (which waits for reconciled numbers, often
  midweek).
- **why crowd misprices:** two-track. (a) *Forecast track:* pre-release, presales/tracking (Fandango/Atom feed
  into trackers) anchor an estimate the crowd may lag. (b) **Timeliness track (the real edge):** by Saturday
  night the Friday-actual + Sat-estimate makes the 3-day total *nearly deterministic*, but the market doesn't
  resolve until midweek and stale quotes persist over the weekend.
- **timeliness edge:** YES, strongly, on the timeliness track — the free tracker leads the official resolution
  feed by 1-3 days. This is closer to a settlement-timing edge than pure forecasting.
- **$0 test:** snapshot each market's mid Friday-night/Saturday-night from the trade tape; compute the implied
  weekend total from the free daily chart (Friday actual → 3-day multiplier, a stable ~2.6-3.0× by genre);
  compare to mid; backtest bucket bets vs resolution. Separately test the *pre-release* forecast track for an
  honest forecasting (not just timeliness) signal.
- **right null:** for the timeliness track, the surrogate is *"could you have known the bucket from the free
  Saturday chart before the price moved?"* — shuffle the timestamp alignment; real edge survives only if the
  free data genuinely *precedes* the price adjustment. For the forecast track, model-Brier vs mid-Brier OOS.
- **failure mode:** (a) market may already incorporate the Saturday estimate fast (bots watch the same chart);
  (b) thin weekend liquidity / wide spreads on a 2-day-old market; (c) resolution-source ambiguity (which
  tracker, final vs estimate) creates voids; (d) tiny n (few films/week) → DSR bite.
- **scores:** D5 E4 P5. **Prior: worth-testing, leaning PROMISING on the timeliness track.**

### H3 — Rotten Tomatoes score (worth-testing)
- **market + example:** ""Scary Movie" Rotten Tomatoes score?" — bucketed Tomatometer ranges. ~105 markets.
- **free source:** the **public RT Tomatometer page** (scrape; partial score appears as early reviews post)
  + the documented **embargo-timing signal** (late embargo ⇒ lower score, modest but significant).
- **why crowd misprices:** the *early partial* Tomatometer (first 10-20 reviews) is a strong predictor of the
  final score, and **embargo-lift timing** is a free public prior the crowd weights inconsistently. The crowd
  fixates on hype/franchise priors; the early-review sample is more informative.
- **timeliness edge:** PARTIAL — the early-review window leads the locked final score by hours-to-days; but the
  crowd also watches RT, so the lead is thin and shrinking.
- **$0 test:** at each pre-resolution timestamp, take the *then-current* partial Tomatometer + #reviews +
  embargo-lift date; fit a shrinkage model (partial → final) on resolved films; compare model-P-per-bucket to
  mid; score vs resolution. Honest-N = #films.
- **right null:** model-Brier vs mid-Brier OOS, and a "early-Tomatometer-only" baseline (does embargo timing
  add anything beyond the partial score?).
- **failure mode:** (a) crowd already reads RT → no lead; (b) studio-screened critics skew the early sample
  (survivorship in *which* critics post first); (c) very small n; (d) score can swing late for niche films.
- **scores:** D4 E4 P5. **Prior: worth-testing.**

### H4 — Crypto daily / hourly "up or down" (worth-testing; it's a timeliness race, not forecasting)
- **market + example:** "Ethereum Up or Down on June 3?" resolves on **Binance ETH/USDT 1-minute candle close
  at noon ET vs prior noon ET.** Also 5M/15M/hourly variants (Chainlink-oracle resolved).
- **free source:** **the literal resolution feed is free** — Binance public klines API (`/api/v3/klines`,
  no key) for the daily ones; Chainlink price feeds (free on-chain read) for the ultra-short ones.
- **why crowd misprices:** there's no *forecasting* edge (price is a near-martingale, EMH). The only edge is
  **microstructure/timeliness**: in the final seconds the outcome is increasingly determined by the free
  resolution feed while the Polymarket mid lags; documented "last-second" dynamics in the 5M markets.
- **timeliness edge:** YES but it's a latency game, not an information game — you must execute faster than the
  Polymarket book updates to the free Binance/Chainlink price. This is exactly the kind of microstructure edge
  the campaign **DEFERRED** elsewhere (needs PIT books / live quoting), and capacity is tiny.
- **$0 test:** reconstruct, from the trade tape, the Polymarket mid in the final N seconds vs the free Binance
  price; measure whether `sign(Binance move) ` is exploitable at the then-available mid net of spread. This is
  *backtestable at $0* but the live version needs latency infra → likely DEFER for live, KILL/PROMISING for
  the backtest.
- **right null:** martingale surrogate — replace the realized close with a price-tied Bernoulli; any "edge"
  beyond execution-timing must vanish.
- **failure mode:** (a) it's pure latency arbitrage → DEFERRED like RE18/RE21; (b) spread + the crowd's own
  bots already at the resolution feed; (c) on the daily horizon the move is unforecastable (EMH).
- **scores:** D5 E3 P5. **Prior: worth-testing as a *backtest of the timeliness gap*; live = DEFERRED.**

### H5 — Crypto end-of-period price targets (worth-testing; option-implied vs crowd)
- **market + example:** "Bitcoin above $70,000 on June 1?" / "What price will Bitcoin hit in June?" — strike
  ladders over weeks-to-months. Resolves on the spot/Binance reference.
- **free source:** **Deribit public API** (`/api/v2/public/...`, no key) — full BTC/ETH options chain
  (implied vols, Greeks, OI) + the **DVOL** index. Option-implied risk-neutral distribution → free
  "above-strike" probabilities.
- **why crowd misprices:** Deribit options are priced by sophisticated desks; the risk-neutral CDF gives a
  defensible P(spot > K) that a casual Polymarket crowd may not match, especially for **shoulder strikes and
  the skew**. The crowd anchors on round numbers and narrative.
- **timeliness edge:** WEAK — both update continuously and arbitrageurs link them; the edge is *calibration of
  shape* (skew/tails), not speed. Risk-neutral ≠ real-world prob (variance-risk-premium tilt) — must
  de-bias, which is itself a fitted step that can overfit.
- **$0 test:** at each pre-res timestamp, build the Deribit-implied CDF (Breeden-Litzenberger on the free
  chain) → P(>K) per strike; compare to the Polymarket mid; bet where the gap exceeds spread; score vs
  resolution. Honest-N = #independent strike-windows.
- **right null:** model-Brier vs mid-Brier OOS, with a **risk-neutral-only** baseline (does the
  real-world de-bias add OOS skill or just in-sample fit?).
- **failure mode:** (a) the two markets are arbitraged together → no residual; (b) risk-neutral→real-world
  adjustment overfits (look-ahead, like the empirical-q Kelly that ruined OOS in RE20); (c) Deribit strikes
  don't align to Polymarket's exact reference/timing.
- **scores:** D5 E3 P5. **Prior: worth-testing (calibration-of-shape angle); efficiency likely KILLs it.**

### H6 — Hurricane / named-storm landfall & seasonal count (worth-testing)
- **market + example:** "Will [storm] make US landfall as a hurricane?" / named-storm-count markets in season.
- **free source:** **NHC ATCF** a-decks (official forecast) + b-decks (best track), free at
  `ftp.nhc.noaa.gov/atcf/` and NHC GIS/RSS; plus **Open-Meteo** model fields. NHC also publishes the official
  cone/probabilities the resolution effectively tracks.
- **why crowd misprices:** the crowd may lag the official NHC forecast-probability product on rapid
  intensification / track shifts; granular landfall-location buckets are hard to price by hand.
- **timeliness edge:** PARTIAL — NHC updates every 6h and the crowd watches it, so the lead is small; the edge
  is again *bucket calibration* more than speed.
- **$0 test:** align archived NHC forecast probabilities (issued at T) to the market mid at T; backtest bucket
  bets vs the b-deck best-track resolution. Honest-N = #storms × #advisories (correlated → block-bootstrap).
- **right null:** model(=NHC-prob)-Brier vs mid-Brier OOS.
- **failure mode:** (a) crowd already prices the public NHC cone; (b) heavy serial correlation within a storm
  → tiny effective N; (c) seasonal markets resolve on rare tail events.
- **scores:** D4 E3 P4. **Prior: worth-testing; the NHC-leads-crowd claim is the thing to falsify.**

### H7 — Fed rate decision (likely-KILL — the crowd already tracks futures)
- **market + example:** "Fed decision in June?" (No change / 25bp cut / hike). 27 Fed-rate markets live.
- **free source:** **30-day Fed Funds futures (ZQ)** front-month price → standard FedWatch arithmetic
  (the CME web tool is free; only the *API* is $25/mo, so compute it yourself from free futures quotes).
- **why crowd misprices:** it largely doesn't — Polymarket Fed odds visibly track FedWatch (e.g. 98% no-change
  matched the futures). The futures-implied number is the textbook consensus the crowd reads directly.
- **timeliness edge:** NONE — the crowd updates to the same futures in real time. **Downgrade.**
- **$0 test:** compare futures-implied P to Polymarket mid across past meetings; you will almost certainly find
  near-equality (no exploitable gap net of spread).
- **right null:** trivially fails — futures-implied ≈ mid, so no OOS-better-calibration.
- **failure mode:** crowd-efficient by construction; the only residual is the few hours around a surprise
  release, i.e. a latency race, not free-information.
- **scores:** D4 E2 P4. **Prior: likely-KILL (catalogued for completeness — the canonical "already priced").**

### H8 — CPI / jobs "above-consensus" releases (likely-KILL — data lags resolution)
- **market + example:** "Will May CPI come in above 3.5% YoY?" / NFP-beat markets around release dates.
- **free source:** **FRED API** + **BLS API** (both free; BLS no-key up to 25 series). But these publish the
  number *at release*, which is *when the market resolves* — the data does not lead.
- **why crowd misprices:** pre-release, the edge would require a better *nowcast* than consensus; free nowcasts
  (Atlanta Fed GDPNow, Cleveland Fed inflation nowcast) exist but the crowd reads them too.
- **timeliness edge:** NONE pre-release (you can't see the print early); ZERO at release (everyone sees it).
  **Downgrade hard.**
- **$0 test:** compare a free nowcast's pre-release P(beat) to the mid; expect no OOS edge.
- **right null:** nowcast-Brier vs mid-Brier OOS; almost certainly tied.
- **failure mode:** the free authoritative data IS the resolution feed → no lead; nowcasts are public.
- **scores:** D5 E1 P3. **Prior: likely-KILL.**

### H9 — SpaceX / Starship launch-count & timing (likely-KILL-lean)
- **market + example:** "How many SpaceX Starship launches reach space in 2026?" / "Starship launch today?"
- **free source:** **RocketLaunch.Live** free API + the SpaceX/Starbase schedule + **FAA airspace closure /
  TFR notices** and marine warnings (free) which leak imminent launches.
- **why crowd misprices:** narrow timing windows; FAA TFR/road-closure notices can leak an imminent attempt a
  day ahead — a minor timeliness leak the crowd partly ignores.
- **timeliness edge:** WEAK — the launch community (and the crowd) already scrapes TFRs; schedule slips are the
  dominant uncertainty and are not forecastable from free data.
- **$0 test:** align TFR/closure-notice timestamps to "launch today" market mids; test whether the notice leads
  the price. Honest-N tiny (few launches).
- **right null:** notice-leads-price surrogate (timestamp shuffle).
- **failure mode:** (a) slips dominate → unforecastable; (b) crowd watches the same NASASpaceflight feeds; (c)
  microscopic N.
- **scores:** D3 E2 P3. **Prior: likely-KILL-lean (a tiny timeliness leak, not a real edge).**

### H10 — Earthquake "M≥x in a window" (likely-KILL — memoryless)
- **free source:** **USGS FDSN GeoJSON** (`earthquake.usgs.gov/fdsnws/event/1/query`, free, no key) +
  real-time summary feeds.
- **why it fails:** large-quake timing is ~memoryless (Poisson-ish); the base rate is *public and computable
  by anyone*, so the crowd prices it. The free feed only tells you about quakes that **already happened**
  (then it's a settlement race, not a forecast). No skill beats the base rate OOS.
- **$0 test:** base-rate Poisson P vs mid; expect tie.
- **right null:** Poisson-base-rate surrogate.
- **scores:** D5 E1 P4. **Prior: likely-KILL.**

### H11 — Near-Earth-object / asteroid pass (likely-KILL — deterministic)
- **free source:** **NASA NeoWs** (`api.nasa.gov/neo/...`, free key / DEMO_KEY).
- **why it fails:** close-approach geometry is *deterministic orbital mechanics* published months ahead — fully
  knowable, hence fully priced. No crowd error to exploit; any market is a formality.
- **scores:** D5 E1 P4. **Prior: likely-KILL.**

### H12 — Astronomy / eclipse / deterministic launch-window (likely-KILL)
- **free source:** NASA + USNO ephemerides (free).
- **why it fails:** deterministic ⇒ priced at ~0/100. Same as H11. Catalogued for completeness.
- **scores:** D5 E1 P3. **Prior: likely-KILL.**

### H13 — Aviation / flight on-time & status (likely-KILL)
- **free source:** **OpenSky Network** ADS-B API (free, 400 credits/day anon, 4000 with login).
- **why it fails:** Polymarket doesn't meaningfully run per-flight on-time markets; where transport markets
  exist, the ADS-B feed only confirms an outcome in progress (settlement race) rather than forecasting it.
  Rate limits cap any scale.
- **scores:** D4 E1 P2. **Prior: likely-KILL (no addressable market).**

### H14 — Sports game / championship winners (likely-KILL — consensus is efficient)
- **market + example:** "2026 NBA Champion" ($407M traded), per-game lines (Spurs 63.5¢).
- **free source:** **ESPN hidden JSON endpoints** (`site.api.espn.com/...`, free) for scores/odds; build a free
  **Elo / Massey** rating; consensus sportsbook odds via free aggregators.
- **why it fails:** sports betting markets are among the *most* efficient; the consensus line already embeds far
  more than a free Elo. Polymarket prices track the books. A free model will not beat the closing line OOS.
- **timeliness edge:** NONE — books move first; Polymarket follows. **Downgrade.**
- **$0 test:** Elo-P vs closing-line-implied-P vs Polymarket mid; expect the line to dominate Elo and the mid to
  track the line. Classic "crowd/consensus already efficient" KILL.
- **right null:** closing-line-implied baseline (does Elo beat the line OOS? almost never).
- **scores:** D4 E1 P4. **Prior: likely-KILL — the textbook efficient-consensus category.**

### H15 — Gov-shutdown duration / bill-passage timing (likely-KILL-lean)
- **market + example:** "When will the DHS shutdown end?" (635 gov-shutdown markets).
- **free source:** **Congress.gov API** + **GovInfo** (free) for bill text/status/scheduled votes; floor
  schedules.
- **why it fails:** outcome is driven by *negotiation/news* the crowd consumes in real time; the free
  legislative feed lags the political reporting that already moves the price. No structured data lead.
- **timeliness edge:** NONE — news leads both the feed and the crowd.
- **scores:** D4 E2 P3. **Prior: likely-KILL-lean.**

### H16 — River-flood / hydrologic-gauge markets (worth-testing IF such markets exist)
- **free source:** **NWS AHPS** river forecasts + **USGS Water Services** real-time gauge API (both free).
- **why it could work:** flood-stage forecasts are model-driven, granular, and hard to price by hand — same
  shape as the weather prototype. **But** Polymarket's coverage of hydrologic markets is thin/uncertain; treat
  as a contingent extension of H1, not a standalone lead.
- **scores:** D4 E2 P3. **Prior: worth-testing only if a real market exists; otherwise N/A.**

---

## Cross-cutting honest read

1. **A free edge can only lead the crowd in two situations:** (a) **dimensionality** — markets with many
   narrow mutually-exclusive buckets where a free *probabilistic model* (ensemble PDF, option-implied CDF,
   forecast distribution) prices the shape better than humans eyeball it (H1, H2-forecast, H3, H5-skew); and
   (b) **timeliness/settlement lag** — the free resolution feed is *known* before the market resolves and
   quotes go stale (H2-weekend, H4-last-second). Everything else is either deterministic-and-priced
   (H10-H13) or consensus-aggregator-and-priced (H7, H8, H14, H15).
2. **The weather prototype (H1) remains the single best free-information lead** and is consistent with the
   already-committed `[0.10,0.15]` finding. It must still clear weather-realistic spreads (5-20¢) and a small
   honest-N; the audit's `wide` cost is the likely killer, so the honest prior is *plausible-PROMISING, not
   SURVIVE*.
3. **Box-office timeliness (H2)** is the most *novel* lead surfaced here: a free daily tracker leads the
   official resolution by 1-3 days. It's closer to a settlement-timing edge than forecasting and so risks
   landing in the same DEFERRED bucket as the microstructure leads if live execution latency matters — but the
   *backtest* of the lead is fully $0.
4. **Right null for every candidate is identical in spirit:** *is the free external estimator's OOS log-loss /
   Brier strictly better than the market mid's, beyond what mid-calibration alone gives?* If not, it's a KILL
   regardless of how "good" the data looks — exactly the calibrated-Bernoulli MAX discipline from
   `METHODOLOGY.md`. Expect most to tie the mid OOS.
5. **Expected outcome, stated up front:** ~10 of 16 are likely-KILL (crowd/consensus/determinism already
   prices them, or the free data is also the resolution feed and so cannot lead). The campaign's "0 deployable
   edge" thesis is unlikely to be overturned; the value here is a *committed, ranked* list of the few free
   sources worth a gauntlet run (H1 first, then H2, H3, H5/H4), each with its right null pre-declared.

> Net: H1 (Open-Meteo ensemble on temperature thresholds) and H2 (free box-office daily chart vs delayed
> resolution) are the only two worth a full gauntlet next; both face the familiar spread/honest-N/settlement
> killers, so the honest ceiling is **PROMISING**, matching the rest of Campaign-D.

---

## Tested verdicts (committed, full gauntlet) — 2026-06-03

The $0-decidable leads from the ranking above were each run through the complete `runGauntlet`:

| Lead | Script | Verdict | Why |
|---|---|---|---|
| H1 weather — climatology vs market | `weather_edge.ts` | **KILL** | market better-calibrated than free climatology (Brier 0.071 < 0.101); surrogate p=0.149; KILL @ net_of_cost |
| weather — "@hightemptation" buy-No on longshots | `weather_sell.ts` | **KILL** | 100% win-rate is mechanical; DSR=1.0 but **surrogate p=0.128** (mean below the calibrated-Bernoulli null) — the right null catches what DSR misses |
| volume-spike "smart-money exit" | `volume_spike.ts` | **KILL** | spike threshold adds nothing (2×=3×=5×; = every-bucket baseline); surrogate p=1.000; reversion obliterated by spread |
| H1 weather — real 1-2d forecast | — | **DEFERRED** | Open-Meteo serves ≈actuals for past dates (look-ahead); needs a live FORWARD log (~weeks) |
| H2 box-office — settlement-timing | — | **DEFERRED** | no free historical box-office API (scraping); old/low-N sample; latency/timing edge best tested live |

**Meta:** every external-information lead that is decidable at $0 was tested and **KILLed** — the free
data does not lead the crowd where it can be checked. The remaining two are DEFERRED for the same reason
as the crypto program's DEFERRED items: the honest test needs live/point-in-time data, not refutation.
Consistent with the campaign's **0 deployable edge**.
