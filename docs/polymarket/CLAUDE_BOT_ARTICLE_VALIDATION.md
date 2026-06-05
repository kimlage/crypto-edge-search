# Campaign-D — Validation of the "$200 → $14,300 in 27 days" Claude Polymarket-Bot Article

*[Home](../INDEX.md) · [Polymarket](README.md) · [Methodology](METHODOLOGY.md) · [Glossary](../GLOSSARY.md) · [Crypto](../README.md)*


> Adversarial fact-check of a viral article claiming a $200 seed grew to $14,300 in 27 days using a
> Claude-powered Polymarket bot (4 free GitHub repos + Claude + a $5 VPS): 74% win rate, Sharpe 2.47,
> 271 trades; copies 47 wallets with ≥70% win rate; gap>7¢ Claude-vs-market filter; Kelly sizing; a
> 3-agent consensus (arbitrage / convergence / whale-copy); volume-spike exit; category rotation; and a
> "copy my wallet at kreo.app/@trackmind" call-to-action. Every committed number cited below is already
> script-derived in this campaign — this doc maps the article onto those results, does the forensics,
> the arithmetic, and isolates the genuinely-new sub-claims worth a $0 test.

---

## 0. Bottom line

**~90% of the article is recycled-and-already-killed; ~10% is a small set of genuinely-new but low-prior
sub-claims.** Every load-bearing *strategy* in the article maps onto a component this campaign already
falsified on $0 ground-truth data: copy-the-top-wallets (**KILL**, surrogate p=0.528, top-decile −$90,457
OOS), Kelly/money-management (**KILL**, sizing-invariant; honest-q Kelly bets $0; empirical-q Kelly is
look-ahead → ruin OOS), gap>7¢ Claude-edge forecasting (corpus on-winner gap **+0.0001** = market
calibrated in aggregate; the "Claude brain" family is **DEFERRED** on disjointness), and arbitrage
(**KILL**, +7.3% overround, complete-set structurally impossible). The marketing numbers are a recycled
funnel: the "74% / Sharpe 2.x / ~271 trades" tuple and the "$XXX → six-figures in a month" frame are the
**same shape** as the earlier `xuanxuan008` / `0x8dxd` viral posts and the weather-bot "$90 → $1,000"
case, and `kreo.app/@trackmind` is the **same lead-gen copy-trade funnel**. The arithmetic only "works"
under a *true positive edge with no losing-trade variance* — i.e., precisely the assumption the campaign
disproved; under the real ≤0 edge, 71× in 27 days requires a few cherry-picked longshot hits
(survivorship), exactly like the weather case.

---

## 1. Forensic: do the repos exist, and do they match the article?

**All four cited repos exist — but none of them implements the strategy the article attributes to them.**
The article is a *collage*: it names real, popular infrastructure repos and bolts an invented
wallet-ranking / 3-agent-consensus narrative on top.

| Cited repo | Exists? | What it ACTUALLY is (verified) | Matches article's claim? |
|---|---|---|---|
| `warproxxx/poly_data` | **Yes** (2,041★, Python) | A **data retriever** — fetches/structures markets, OrderFilled events, trades via Gamma + Polygon JSON-RPC. No trading, no wallet ranking, no AI. | **No.** It is a data-ETL library, not a "ranks 14,000 wallets by win rate" engine. |
| `Polymarket/polymarket-cli` | **Yes** (2,747★, Rust) | A terminal **CLI / JSON API** to browse markets, view books, place/cancel orders. Explicitly flagged "early, experimental … do not use with large amounts of funds." | **No.** It is an order-entry/browse CLI, not a strategy or consensus engine. |
| `Polymarket/agents` | **Yes** (3,624★, Python) | A **developer framework**: API connectors, RAG, news/web sourcing, LLM prompt tooling. README has **zero** wallet-ranking, copy-trading, multi-agent-consensus, Kelly, gap-filter, volume-exit, or category-rotation. You must write your own `trade.py`. | **No.** Building blocks, not the described bot. |
| `dylanpersonguy/Polymarket-Trading-Bot` | **Listed** (DeepWiki/GitFind cache it) but the **GitHub API now returns null/404** for the repo | Per cached docs: a generic **TypeScript bot harness** (SQLite, LIVE/PAPER modes, `.env`+`config.yaml`, multi-wallet runners). A scaffold for *your* strategies. | **No.** A harness, not the specific 3-agent/copy-47-wallets strategy. The fact it is no longer API-resolvable is itself a red flag (renamed/removed/private since the article). |

**Conclusion:** the "4 free repos" are real and reputable, which lends the article false credibility, but the
described *strategy* (rank-and-copy 47 top wallets, 3-agent arbitrage/convergence/whale-copy consensus,
gap>7¢ Claude filter, Kelly, volume-spike exit, category rotation) is **not in any of them**. The repos are
ETL + CLI + framework + empty harness. Assembling them into the claimed money-printer is left as an
exercise the article never actually demonstrates.

### Recycled marketing numbers + the copy-trade funnel

- **The number tuple is recycled.** "74% win rate / Sharpe ~2.3–2.5 / ~210–271 trades" is the same
  signature as the prior `xuanxuan008` viral post (Sharpe 2.31 / 74% / 214 trades) flagged in
  `RE_LEDGER` provenance, and the dollar frame "$XXX → six figures in ≈1 month" is the same as the widely
  re-blogged **`0x8dxd`** story ("$313 → $438,000, 98% win rate, 6,615 predictions"). Note the headline
  drift across re-tellings: one viral X post (marryevan999) renders it as "$200 → $14,300 … ranks 14,000
  wallets … only makes 10 trades"; the Medium ecosystem renders a sibling as "$1,000 → $14,216 in 48
  hours (1,322%)". **The exact same denominators and win-rates re-appear with different seeds/dates** —
  the tell of a recycled template, not an independent result.
- **The one on-chain-verified case is NOT what the article sells.** `0x8dxd`'s real run was
  **latency arbitrage on 15-minute BTC/ETH/SOL up-down contracts** — reacting faster than Polymarket's
  pricing engine to confirmed Binance/Coinbase spot momentum. It is **not** wallet-copying, **not** a
  3-agent LLM consensus, and **not** reproducible from "4 free repos + Claude on a $5 VPS" (it needs
  co-located low-latency execution). The article borrows that wallet's *aura of legitimacy* while
  describing a completely different, non-latency strategy.
- **Fabricated evidence precedent.** A circulated PDF promoting a "68.4% win rate" Claude-Polymarket bot
  was found (Tribuna, 2026-05-18) to contain **fabricated screenshots** — the genuine figure was ~62%.
  Same genre, same inflation pattern (real-but-mediocre → fabricated-and-impressive).
- **The funnel.** `kreo.app` is a **Telegram copy-trade / whale-tracker product** (mirror a target wallet
  proportionally, "AI matching," paid tiers). "Copy my wallet at kreo.app/@trackmind" is a **lead-gen
  call-to-action**, not a result — the article's economic purpose is to route readers into a paid
  copy-trade funnel, exactly the `kreo.app`-style funnel flagged in the RE provenance. The "$5 VPS / 4
  free repos" framing exists to make the reader feel the edge is free and replicable so they sign up.
- **Base-rate.** Independent analyses cited across the coverage put **~92.4% of Polymarket wallets at a
  loss** — consistent with this campaign's finding that high-win-rate wallets are longshot-sellers whose
  profitability does not persist.

---

## 2. Per-claim verdict table (claim → committed result → verdict)

| # | Article claim / component | Committed result in this campaign | Verdict |
|---|---|---|---|
| 1 | **Copy 47 wallets with ≥70% win rate** | Copy-trading non-persistence: top-decile-train-ROI **−$90,457 OOS**; wallet-label-shuffle surrogate **p=0.528** (no better than random); train-ROI→OOS-return **r≈0.0**; top-decile OOS-positive rate **0.472 < 0.511 population**; the ≥70%-winrate filter is the **anti-signal** (selects longshot-sellers who win often, lose big). `RESULTS.md §2`, `compute_persistence.ts`. | **ALREADY-KILLED** |
| 2 | **Kelly sizing turns the signal into compounding** | Money-management gauntlet: sizing is EV-sign-invariant; only honest sizer (market-q Kelly) **bets $0**; empirical-q Kelly is **look-ahead → ruin OOS** (train-only q → $0); synthetic +12% control proves the harness works. `MONEY_MGMT_AND_ARB.md §3`, `mm_risk_gauntlet.ts`, `mm_oos_check.ts`. | **ALREADY-KILLED** |
| 3 | **gap>7¢ between Claude's probability and market price = edge** | Corpus on-winner gap **+0.0001** over 1.36M trades (market calibrated in aggregate); stratified reliability curve flat; the "Claude brain" base-rate estimator (RE10) is **DEFERRED** because stable templates and the [0.15,0.85] tradeable band are **near-disjoint** (the only stable templates are crypto up-down coinflips, base rate ≈0.50 = zero info). `RE_LEDGER` RE22/RE10, `verify_re22.ts`, `re_verify.ts`. | **ALREADY-KILLED** (forecasting edge) / the specific gap-estimator is **DEFERRED** |
| 4 | **Arbitrage agent (related-market price gaps)** | negRisk baskets carry **+7.3% overround** (median sum(ask)=1.073, arb-free); within-market complete-set (ask_YES+ask_NO<1) is **structurally impossible** (shared CLOB book); apparent "$679k arb" was a stale placeholder. `MONEY_MGMT_AND_ARB.md §1`, `arb_baskets.mjs`, RE03/RE07. | **ALREADY-KILLED** |
| 5 | **Whale-copy agent (mirror big trades, ~60s delay)** | Same non-persistence + survivorship as #1; the persistent-looking cohort just **sells cheap longshots that resolve NO** — survivorship, not skill (cohort on-winner +0.057 = selection). Following at a 60s delay only adds adverse selection + spread cost. `RESULTS.md §4`. | **ALREADY-KILLED** |
| 6 | **Convergence agent (markets misprice & correct fast)** | Not directly tested as a *price-path mean-reversion* claim. Adjacent: RE13 first-print **staleness/momentum** loses net-of-2¢ (mean −0.051) and does NOT beat a random-anchor placebo (p=1.000). | **GENUINELY-NEW** (price-path convergence; see §4a) — low prior given RE13 |
| 7 | **Volume-spike exit (3× volume in 10min = smart money leaving)** | Not tested. No microstructure exit-timing test in the campaign. | **GENUINELY-NEW** (see §4b) |
| 8 | **Category rotation has a mispricing cycle** | Per-category calibration cycling not tested as a *time-varying* signal; aggregate calibration is flat. | **GENUINELY-NEW** (see §4c) — low prior |
| 9 | **2/3-agent consensus kills 40% of losing trades** | Ensemble of components #1–#5, each of which is KILL/DEFERRED. An AND/vote of KILLed signals cannot manufacture EV. | **ALREADY-KILLED (by composition)** — see §4d |
| 10 | **Headline: 74% WR / Sharpe 2.47 / 271 trades → $200→$14,300/27d** | Recycled-number tell; arithmetic only closes under a true edge + no losing-trade variance (§3). | **ALREADY-KILLED + recycled** |
| 11 | **"4 free repos + Claude + $5 VPS reproduce it"** | Repos are ETL/CLI/framework/empty-harness; none implements the strategy (§1). | **Unsubstantiated / collage** |
| 12 | **"Copy my wallet at kreo.app/@trackmind"** | Lead-gen copy-trade funnel; the copy edge itself is KILL (#1). | **Funnel, not result** |

**Tally:** of the 12 components, **8 are already-KILLED**, **1 is already-KILLED/DEFERRED (forecasting)**,
**1 is composition-KILLED**, and the substance reduces to **3 genuinely-new low-prior sub-claims**
(convergence price-path, volume-spike exit, category-rotation cycle). The 3-agent consensus is not new —
it is an ensemble of already-dead parts.

---

## 3. Arithmetic plausibility: is 71× in 27 days consistent with 74% WR + quarter-Kelly, f*∈[0.05,0.15]?

$200 → $14,300 = **71.5×**. Spread over the stated 271 trades / 27 days:

- **+1.588% required *geometric* growth per trade**, every trade, for 271 straight trades.
- **+17.1% per day**, every day, for 27 days (10 trades/day).

What a quarter-Kelly bettor at 74% win rate would *expect* (no-variance / expected-log-growth path),
across plausible Polymarket contract prices `q` (net win-odds `b = (1−q)/q`):

| Buy price q | net odds b | full-Kelly f* | quarter-Kelly f | E[$ final from $200, 271 trades] |
|---|---:|---:|---:|---:|
| 0.50 (even money) | 1.000 | 0.480 | 0.120 | **$181,744,527** (absurd) |
| 0.60 | 0.667 | 0.350 | 0.088 | $27,342 |
| 0.70 | 0.429 | 0.133 | 0.033 | $316 |
| 0.80 | 0.250 | **−0.300** | 0 (no bet) | $200 (Kelly refuses) |

And at the article's stated upper sizing `f=0.15` (expected-log-growth path):

| f=0.15, buy@ | E[$ final from $200] |
|---|---:|
| 0.50 | $3.16 **billion** |
| 0.60 | $425,380 |
| 0.70 | $568 |

**Reading.** The arithmetic does NOT cleanly support $14,300. It either **massively overshoots** (if the
bot truly had a 74%-at-even-money edge, quarter-Kelly would compound to **hundreds of millions**, not
$14k — so $14,300 is *implausibly low* for the stated edge) or **undershoots** (at realistic favorite
prices q≥0.70 where a 74% hit-rate would actually live, quarter-Kelly lands at **$300–600**, nowhere near
$14k). The single combination that lands near $14k (q≈0.60, quarter-Kelly) is a knife-edge cherry-pick,
and it still ignores the decisive flaw:

**Every line in those tables assumes a *real, persistent +EV edge* and the *expected* (variance-free)
path.** That is exactly the premise the campaign falsified. With the **true ≤0 per-bet edge** measured on
ground-truth data (fade-longshots −0.0058/bet, buy-favorites −0.0996/bet, on-winner gap +0.0001), the
growth-optimal bet is **$0**, and any positive-fraction sizing **loses or goes to ruin** (MM gauntlet:
$980→$337; aggressive sizing → 100% ruin even *with* a synthetic edge). A 74% raw win rate is fully
consistent with **negative** EV — it is the longshot-seller signature (win small often, lose big rarely),
which is why high-win-rate wallets lose money OOS.

**Cross-check on the win rate itself:** a *flat* 10%-of-bankroll even-money bettor needs only **60.4%**
wins to hit 71.5× over 271 trades — so the "74%" is not even the binding lever; the binding lever is
*odds × persistence*, and at honest favorite odds the edge is negative.

**Verdict on the arithmetic:** **inconsistent / not self-consistent.** $14,300 is *not* what a
disciplined 74%-WR quarter-Kelly low-leverage strategy produces — that strategy produces either ~$300–600
(realistic odds) or astronomically more (even-money, if the edge were real). A specific $14,300 is the
signature of a **path-dependent, survivorship outcome — a few lucky longshot hits on a tiny seed** — i.e.
the **identical mechanism as the weather "$90 → $1,000" case** (one cherry-picked 11× hit, while the
systematic strategy bled). It is a *realized lucky path reported as if it were the expected edge.*

---

## 4. Genuinely-new sub-claims — $0 test designs + the right null

These four are the only parts not already gauntleted. All are testable from the **committed trade-tape
corpus** (`trades-cache/`, 1.36M trades, train/OOS split) at $0. Priors are low but they are honest gaps.

### (4a) "Convergence: crypto markets misprice and correct fast" — price-path mean-reversion
- **Test ($0).** From the trade tape, reconstruct each market's intra-market price path (VWAP or
  last-trade per Δt). Define a "dislocation" as a price move ≥X¢ over a short window; measure the
  *signed* price change over the next window conditional on the dislocation (mean-reversion = next move
  opposes the dislocation; momentum = continues). Score net of a price-proportional half-spread and only
  on the tradeable [0.15,0.85] band. Walk-forward across the 3 committed windows.
- **Right null.** **Time-reversed / circularly-shifted price-path surrogate** (or AR(1) bootstrap of
  returns): under "no exploitable convergence," the post-dislocation conditional return is indistinguishable
  from the surrogate, family-wise MAX over the X-grid. Also require **beat a stale-price placebo** (RE13's
  random-anchor event-time placebo), since RE13 already showed the de-staling leg loses net-of-2¢ and does
  NOT beat that placebo (p=1.000). **Prior: low** — RE13 is the same family and KILLed.

### (4b) "Volume-spike exit: 3× volume in 10min = smart money leaving" — does a volume spike predict adverse moves?
- **Test ($0).** From the tape, compute rolling 10-min trade volume per market; flag spikes (volume ≥3×
  trailing baseline). Measure the **subsequent signed price move** over the next 10–60 min, conditional on
  the spike, separately for spikes accompanied by net-buy vs net-sell flow. The claim is testable as: does
  a spike predict a move *against* the pre-spike holder? Compare the P&L of "exit-on-spike" vs "hold to
  resolution" on the same entry set.
- **Right null.** **Volume-label shuffle / time-shifted spike placebo** — randomly relocate the spike flags
  in event-time and re-measure the conditional move; under "spikes carry no information," real spikes do
  not beat the shuffled-spike MAX. Control for the mechanical fact that volume and volatility co-move
  (spikes cluster near resolution / news), so also condition within time-to-resolution buckets. **Prior:
  low-medium** — this is the most genuinely-untested mechanism (an *exit-timing* microstructure signal,
  not a directional one), so it is the **highest-value new test**.

### (4c) "Category rotation has a mispricing cycle" — do per-category calibration gaps cycle in time?
- **Test ($0).** From `resolved-markets.jsonl` (172,830 markets, ground-truth) + tape-derived pre-res
  prices, compute the calibration gap (realized YES − priced YES) **per category × per month**. Test
  whether a category's gap in month *t* predicts its gap in month *t+1* (positive autocorrelation = a
  persistent/cyclical mispricing you could rotate into). Trade rule: each month, tilt toward the category
  whose trailing gap was most favorable; score OOS.
- **Right null.** **Category-label shuffle across months** (permute which category each month's gap belongs
  to) + a **calibrated-Bernoulli** resample within category; under "no exploitable cycle," the
  trailing-gap-tilt does not beat the shuffled-label MAX, and per-category gaps are within calibrated-noise.
  **Prior: low** — aggregate calibration is flat (+0.0001) and per-bucket deviations were sign-alternating
  noise, so a *stable* per-category cycle is unlikely; but it is genuinely untested as a *time-series*
  claim.

### (4d) "Consensus of 2/3 agents kills 40% of losing trades" — ensemble of KILLs
- **Test ($0).** Reconstruct the three agent signals from the tape (arbitrage = basket-overround leg;
  convergence = §4a dislocation signal; whale-copy = mirror top-wallet trades), require ≥2 to agree, and
  score the consensus book through the full gauntlet vs each single agent.
- **Right null.** **Signal-label-shuffle / random-2-of-3-mask MAX** — does requiring agreement among the
  *real* signals beat requiring agreement among *shuffled* signals? **Expected result: KILL by
  composition.** Each constituent is already ≤0-EV (arb +7.3% overround against you; whale-copy
  surrogate p=0.528; convergence shares RE13's KILL). A vote/AND of independent ≤0-EV signals is still
  ≤0-EV — a filter can reduce *variance* and trade count ("kills 40% of losing trades") but it cannot turn
  the sign positive; net of the spread you pay on the trades it *does* take, expectancy stays ≤0. The
  "kills 40% of losers" framing is the survivorship illusion of a high-precision/low-recall filter, not an
  edge. **Prior: KILL** (this is really a re-test of composition, not a new mechanism).

**Priority order for any $0 follow-up:** **(4b) volume-spike exit** (most genuinely-untested, an
exit-timing microstructure signal) > **(4a) convergence price-path** (untested as mean-reversion, but
RE13-adjacent) > **(4c) category-rotation cycle** (untested as a time series, low prior) > **(4d)
consensus** (do last; expected KILL-by-composition, mostly a confirmation).

---

## 5. Reproduce / sources

- Committed campaign numbers: `RESULTS.md`, `MONEY_MGMT_AND_ARB.md`, `REVERSE_ENGINEERING.md`,
  `RE_LEDGER.md`, `WEATHER.md`, `EVALUATION.md` (this directory) — all $0, scripts in `scripts/campaign-D/`.
- Repo forensics (GitHub API + READMEs, 2026-06): `warproxxx/poly_data` (2,041★, data ETL),
  `Polymarket/polymarket-cli` (2,747★, Rust CLI), `Polymarket/agents` (3,624★, dev framework),
  `dylanpersonguy/Polymarket-Trading-Bot` (API now null/404; cached as a generic TS harness).
- Recycled-number / funnel sources: `0x8dxd` "$313→$438,000" coverage (finbold/CoinDesk — verified
  on-chain as **latency arbitrage**, not wallet-copy); marryevan999 X post "$200→$14,300 … 14,000 wallets
  … 10 trades"; Medium "$1,000→$14,216 / 48h / 1,322%"; Tribuna 2026-05-18 fabricated-screenshot "68.4%"
  finding; `kreo.app` copy-trade Telegram funnel; ~92.4%-of-wallets-lose base rate.
- Arithmetic: quarter-Kelly / expected-log-growth computation in §3 (reproduced inline).

---

## Committed sub-claim test: "volume-spike exit" → KILL (`volume_spike.ts`, `volume_spike.json`)

The article's one genuinely-untested sub-claim ("3× volume spike in 10min = smart money leaving → exit")
was run through the full `runGauntlet` on 1,867 markets / 541,879 ten-minute bucket-events:

- **Gross (cost=0) informational ceiling:** fade = +0.0028, momentum = −0.0028 — but **identical across the
  2×/3×/5× spike thresholds**, and the "trade every bucket (no spike filter)" baseline (−0.0176) ≈ the spike
  strategy (−0.0172). The spike threshold adds **nothing**; the tiny reversion is a general bucket property.
- **Net of a 2¢ round-trip:** all configs negative; **surrogate p=1.000** (spikes no better than time-shuffled
  random buckets); DSR 0, bootstrap CI negative, holdout −0.016. **KILL** (binding net_of_cost).

A volume spike carries **no tradeable directional information** beyond a market-wide micro-reversion the
spread obliterates. The "kills 40% of losing trades" line is the high-precision-filter survivorship illusion.
(A real intraday round-trip needs PIT L2 fills — DEFERRED — but the informational core is decisively $0-dead.)
