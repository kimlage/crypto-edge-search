# On-Chain $0 Feasibility Report

> **STATUS UPDATE (the test was run).** This was a *design-time* feasibility report; its
> "25/27 KILL" figures describe the program's prior *before* the on-chain test existed. The
> recommended test below was subsequently executed as the program's **28th hypothesis** (OC1,
> on-chain distribution-pressure) and the verdict was **KILL** — binding gate **baselines**,
> with the **surrogate** also failing (placeboP=0.482), at honest N=36 on free Coin Metrics
> Community data (cloud $0). The running tally is therefore now **31 tested / 29 KILL / 2
> sub-RF carry survivors**. See `RESULTS.md` §1 + §3 (Round 7) and `output/onchain-poc/verdict.json`.
> The design notes below are preserved as written (they remain a faithful record of how the
> test was specified and de-risked before it was run).

**Scope:** Can we run a rigorous, anti-overfitting on-chain edge test for **$0 / no paid keys**, through the committed `validateStrategy` harness (`src/lib/validation/strategy-validator.ts`)?
**Verdict:** **YES — fully fundable at $0.** Four independent scout tracks (OC1–OC4) hit every candidate source **live** (HTTP statuses are real responses, not memory). The $0 backbone is **Coin Metrics Community + DefiLlama** (both no-key, daily, full-history), with CEX REST (Binance/Bybit/OKX), Blockchain.com charts, mempool.space, and Santiment (2 open metrics) as supporting no-key sources.
**Honest expectation:** This is a *new data source*, not a new law of markets. NVT/MVRV/SOPR/active-address/exchange-flow signals are heavily published and arbitraged; the design-time prior was **25/27 hypotheses KILLed** (before this test existed; the tally is now 26/28 — see the status banner), including **both** rotation tests (C1, C2) that this data class most resembles. Worth exactly **one** rigorous test, designed below, with null results budgeted as the base case — which is exactly what the subsequent KILL delivered.

---

## 1) THE $0 DATA PLAN — every source that genuinely works at $0

All rows below were **hit live** in the POCs (statuses are real). Sources are grouped by access tier. "Paid" sources are listed only to record that they were probed and **excluded**.

### Tier A — NO-KEY FREE (use these; verified live, HTTP 200, real rows)

| Source (endpoint) | Data / metrics | History depth (verified) | Granularity | Key req. | Rate limit (observed) |
|---|---|---|---|---|---|
| **DefiLlama stablecoins** (`stablecoins.llama.fi/stablecoincharts/all`, `/stablecoinchains`) | Total stablecoin USD supply; per-stablecoin (USDT, USDC, all pegged); per-chain stablecoin $ | Total **2017-11-29 → 2026-05-31 (3106 daily)**; USDT 3106; USDC **2018-09-11→now (2820)** | daily | **none** | Generous; 6/6 rapid OK, 0×429 |
| **DefiLlama TVL** (`api.llama.fi/v2/chains`, `/v2/historicalChainTvl/{chain}`, `/overview/dexs`, `/protocols`) | TVL by chain over time → **chain TVL-share = direct capital-rotation signal**; total DeFi TVL; DEX $ volume; per-protocol TVL | ETH **2018-02-12 (3169d)**; Tron 2250; Polygon 2061; BSC 2039; Avalanche 1944; Solana 1901; Arbitrum 1762; Base 1082 — all → 2026-05-31 | daily | **none** | 30 rapid → 30×200, 0×429 |
| **DefiLlama prices/yields** (`coins.llama.fi/chart/{cg:id}`, `yields.llama.fi/pools`) | Native-token daily price; pool APY/TVL | prices back to ~2021-01 | daily | **none** | ~500-pt span cap → page in 400d windows |
| **Coin Metrics Community** (`community-api.coinmetrics.io/v4`) | **The gold mine.** BTC+ETH (100+ assets) 31 free daily metrics: AdrActCnt, TxCnt, FeeTotNtv, HashRate, SplyCur, CapMrktCurUSD, **CapMVRVCur (MVRV)**, **FlowInExNtv/USD + FlowOutExNtv/USD (exchange flows!)**, SplyExNtv, PriceUSD, ROI30d/1yr | BTC **2009-01-03 (genesis) → 2026-05-30**; ETH 2015-07-30→now; exchange flows from 2011-04-24 (BTC); 4,018-row uninterrupted pull verified | daily | **none** | `x-ratelimit-limit 6000 / 20s` sliding; 12 rapid → 12×200 |
| **Binance** (`fapi/v1/fundingRate`, `futures/data/openInterestHist`, spot `klines`) | Perp funding 8h; open interest; BTC spot OHLCV | Funding: multi-year via paging; **OI: ~last 30d only (free)**; klines: full multi-year | 8h / daily | **none** | weight-based, ≫ POC usage |
| **Bybit v5** (`/v5/market/funding/history`) | Perp funding | paginated multi-year | 8h | **none** | fine at POC scale |
| **OKX v5** (`/funding-rate-history`) | Perp funding | paginated | 8h | **none** | fine at POC scale |
| **Blockchain.com Charts** (`api.blockchain.info/charts`) | BTC n-unique-addresses, n-transactions, est-tx-volume-USD, hash-rate, miners-revenue, market-price | `timespan=all` → **2009-01-03 → now** | daily | **none** | no limit hit (~400ms spacing) |
| **mempool.space** (`/api`) | BTC hashrate/difficulty, tip height, recommended fees, mempool stats | **recent-window (~3y, 2023-06→now)**, NOT deep history | daily/live | **none** | fast, none hit |
| **Santiment GraphQL** (`api.santiment.net/graphql`) | **Only 2 open metrics:** `daily_active_addresses`, `dev_activity` (btc/ethereum) | **full 2017 → now** for the 2 open metrics | daily | **none** | small queries clean; throttles under load |

### Tier B — FREE-SIGNUP-KEY (a *free* key exists, but requires a registration we did not do → currently UNUSABLE under the no-signup constraint)

| Source | Status (live) | Note |
|---|---|---|
| **Etherscan V2** | `status:0 "Missing/Invalid API Key"` | Free key, but **required on ALL endpoints**; V1 deprecated/dead. Substitute **CM ETH metrics**. |
| **The Graph (decentralized gateway)** | 200 body `"auth error: missing authorization header"` | Free ~100k q/mo then pay in GRT. **Not needed** — DefiLlama covers rotation. |
| **Dune Analytics** | `401 "invalid API Key"` | Free plan + limited credits, key mandatory. **Not needed.** |
| **Bitquery** (graphql + streaming) | `401 "use Authorization or X-API-KEY"` | Free-signup key. **Not needed.** |
| **Messari** (`api.messari.io/marketdata/v1`) | `403 "invalid auth mechanism"` | New API needs key; **old no-key host retired (404)**. Substitute CM/DefiLlama. |

### Tier C — PAID (probed, confirmed gated → EXCLUDED)

| Source | Status (live) | The cost |
|---|---|---|
| **Glassnode** (`api.glassnode.com/v1/metrics`) | **401 Authorization Required** | "free tier" still needs a registered key; full netflow is paid. |
| **CryptoQuant** (`api.cryptoquant.com`) | **401 "Token does not exist…use Bearer API_KEY"** | Paid Bearer key. |
| **CoinGecko** (note) | 200 but **HARD-throttled** | Works no-key but **429 after 2 rapid calls** (~5–15 req/min) and gives **only current** circulating supply + ~365d window. Snapshot-only; **not** a backfill source — use DefiLlama/Binance instead. |

**CM Community quota gaps (free tier):** the *strict* realized cap (`CapRealUSD`), adjusted transfer value (`TxTfrValAdjUSD`), and `NVTAdj` are **Pro/paid** (confirmed 403). The free **`CapMVRVCur`** embeds realized-cap cost-basis info, so the mechanism is still testable — but the raw realized-cap series is not free.

---

## 2) WHAT WE CAN ACTUALLY TEST at $0

Concrete on-chain signals obtainable with **no key**, all **daily**:

| Signal family | Built from (no-key) | Assets / chains | Depth | Notes |
|---|---|---|---|---|
| **Stablecoin "dry-powder" flow** | DefiLlama total + per-coin + per-chain supply growth | market-wide → BTC/ETH | 2017→now (3106d) | Slow, low-frequency series; few independent obs. |
| **Exchange net-flow PROXY** | CM `FlowInExNtv − FlowOutExNtv` | **BTC, ETH** | BTC 2011→now, ETH 2015→now | **Best free flow series.** NOT exchange-grade (Glassnode/CryptoQuant netflow is paid); carries `flash/reviewed` revision flags. |
| **Active-address / network usage / NVT** | CM AdrActCnt, TxCnt, CapMrktCurUSD; Santiment DAA (cross-check); Blockchain.com | BTC, ETH | genesis→now | NVT = mcap / on-chain tx-value proxy. |
| **Realized-cap cost-basis (MVRV)** | CM `CapMVRVCur` | BTC, ETH | 2010→now (BTC) | Proxy for raw realized cap (which is paid). |
| **TVL chain-rotation** | DefiLlama chain TVL-share over time | 8 major L1/L2 (ETH, SOL, BSC, ARB, BASE, TRON, POLY, AVAX) | 5–8y daily | TVL-share is a **direct** capital-stock flow signal. |
| **Leverage / positioning** | Binance/Bybit/OKX funding (8h), Binance OI (**30d only**) | BTC/ETH/alts | funding multi-year; OI shallow | Funding deep; OI cannot be backfilled free. |
| **Mining / fees / hashrate** | CM, Blockchain.com, mempool.space | BTC | genesis→now (CM/BC) | Supplementary fundamentals. |

**What we CANNOT get at $0:** true exchange **netflow** (Glassnode/CryptoQuant, paid), raw **realized cap / NVTAdj** (CM Pro), deep **open interest** history (Binance free = 30d), **intraday/hourly** on-chain (all free tiers are daily), and ETH-specific Etherscan endpoints (free-signup key).

---

## 3) RECOMMENDED POC EDGE-TEST DESIGN — the single most promising next test

> **Honest prior (read first).** *(Design-time prior — at the time this was written the project had run **27 hypotheses; 25 KILLed; 2 sub-risk-free carry survivors**. The test below was then run as the 28th hypothesis and was a **KILL**, exactly as the prior predicted — see the status banner at the top.)* The two tests *closest* to this data class both died decisively on the surrogate gate: **C1** (capital-rotation lead-lag) — holdout **−39.9%**, **cross-sectional shuffle p=1.000** (the rotation statistic is fully reproduced by a shuffle → artifact); **C2** (dominance cycle) — **placeboP=1.000**, vault **−1.53 (−52.7%)**. **T7** (funding contrarian) and the rotation cluster (C1–C4) all died. On-chain metrics (NVT/MVRV/SOPR/active-addr/flows) are themselves heavily studied and arbitraged. **Base-case expectation: KILL.** The **exchange net-flow proxy + MVRV cost-basis** mechanism was the genuinely new data source, and it got **one** rigorous shot.

### The test: **BTC+ETH exchange-net-flow + MVRV cost-basis "distribution-pressure" overlay**

- **Signal (the feature).** For each of BTC and ETH, daily:
  `netflow_z = z(FlowInExNtv − FlowOutExNtv, trailing ~90d)` and `mvrv = CapMVRVCur`.
  Take a position only when the two **agree** (the project's hard-won lesson: single-gate signals overfit; require a *two-gate* confirmation): e.g. **risk-OFF / reduce** when coins are flowing **TO** exchanges (netflow_z high, supply leaving cold storage → distribution pressure) **AND** MVRV is elevated (holders in profit → incentive to sell); **risk-ON / hold-beta** when netflow is negative (accumulation) **AND** MVRV is not stretched. Trade the **spot asset** (long/flat, vol-targeted), daily rebalance.
- **Mechanism (why it could be real, not just a pattern).** Coins moving onto exchanges is a *leading* logistical step before selling; MVRV says *whether holders are in profit enough to want to*. This is a **flow + cost-basis** story, not a price-pattern story — a category the harness has **not** yet tested. It is also **not** a cross-sectional rotation story, so it is not the C1/C2 failure mode.
- **Assets.** **BTC and ETH only** (the two assets with full free exchange-flow history). Two assets keeps the honest trial count low and avoids small-cap survivorship.
- **Depth / honest N.** Usable overlap ~**2015-07 → 2026-05** (~3,900 daily obs/asset, ETH-limited). After the 90d warm-up: ~**3,800 daily samples × 2 assets**. Honest **`trialCount`** must count *every* config actually tried: 2 assets × {netflow lookback ∈ 3} × {MVRV threshold ∈ 3} × {agreement rule ∈ 2} ≈ **N ≈ 36** — set `trialCount: 36` (do NOT pretend N=1; that is exactly what DSR/Harvey-Liu punish).
- **Costs.** Daily spot rebalance, vol-targeted → low turnover; charge round-trip taker on every position change. Gross-only ⇒ auto-KILL at gate 1, by design.

### The right surrogate null (the control that should do the killing)

Run through `validateStrategy(grossReturns, options)` with the full gauntlet. The **binding control** here is **gate 6 (surrogate / placebo)** with:

- **`surrogate.crossSectional: false`** — this is the key difference from C1/C2. A cross-sectional shuffle is the right null for *rotation* (it destroys lead-lag between assets) and it **annihilated** C1 (p=1.000). But this test is **not** rotation; its claim is *time-series* (a flow/cost-basis state predicts the *same asset's* forward return). So the correct null is **phase-randomization + stationary/block-bootstrap** of each asset's own return path (the harness defaults), which **preserves the marginal distribution and autocorrelation but destroys the specific timing alignment** between the on-chain feature and forward returns. If a phase-randomized null with the same spectrum reproduces the edge, the "signal" was just exploiting BTC's autocorrelation/vol-clustering, not the on-chain feature → KILL.
- Seed the surrogate **panel** with the **[BTC, ETH] return marginals** (`surrogate.panel.assetReturns`), `iterations: 200`, `maxPlaceboP: 0.05`.
- Keep the full stack: net-of-cost (gate 1), beat buy-&-hold + equal-weight + random-lottery + linear (gate 2), **DSR at N=36** (gate 3), CPCV/PBO<0.5 (gate 4), Harvey-Liu haircut (gate 5), surrogate (gate 6), **consume-once holdout** on the most-recent slice scored exactly once (gate 7).

### Expected outcome (be honest)

- **Most likely: KILL**, with the binding gate being **holdout** (the two-gate death pattern: passes in-sample, dies OOS) **or the surrogate** (phase-randomized BTC reproduces it). On-chain flow/MVRV signals are widely published; the live preliminary sniffs were weak: OC1 corr(stablecoin-growth, fwd-7d BTC)=**−0.06** (tercile smell +1.38pp, in-sample, no CV); OC2 corr(MVRV, fwd-30d)=**+0.12**, non-monotonic quintiles; OC4 **leading** weekly correlations **~0 everywhere** (active-addr ≈+0.09, netflow ≈0), with large contemporaneous values being *mechanical USD-denomination tautologies*.
- **The valuable win even in a KILL:** it tests a *genuinely new data source* (on-chain flow + cost-basis) that the prior 27 hypotheses never touched, and a clean KILL here lets the project state "we also checked free on-chain data, under the same rigor, and it did not survive." That is a real result, not a wasted run.
- **If it somehow PASSES all 7 gates:** treat with extreme suspicion — re-run with `crossSectional: true` as a secondary null and re-pull CM flows (the `flash` revision flag means today's values may differ from point-in-time), because **look-ahead from revised on-chain metrics** is the most likely false-positive source here.

---

## 4) COMPLETENESS CRITIC

**Major free sources the scouts MISSED or under-used (no signup):**
1. **DefiLlama `/bridges` and `/bridgevolume`** — cross-chain **bridge flows** are arguably a *cleaner* direct capital-rotation signal than TVL-share (which is USD-denominated and partly mechanical). No-key, same host family as the sources already proven. Not probed. **Worth adding** as a rotation feature if the rotation thesis is ever revisited.
2. **Blockchain.com `mvrv`, `nvt`, `nvts`** chart slugs — Blockchain.com publishes BTC MVRV/NVT directly (no key), giving an **independent cross-check** of CM's `CapMVRVCur` (revision/definition sanity check). Only `n-unique-addresses` and a few slugs were pulled.
3. **Coinpaprika / CoinCap** free no-key price/mcap APIs — redundant given Binance/DefiLlama, but useful as a third price cross-check; not evaluated.
4. **DefiLlama `/fees` and `/revenue` overviews** — protocol/chain **fee revenue** (a fundamentals signal distinct from TVL); no-key, not probed.
5. **Mempool.space deeper BTC mempool/fee-pressure** beyond the 3y hashrate window was only lightly used; fine, low priority.

**OVERCLAIMS to correct (a "free" source that is not truly free / not what it seems):**
- **Glassnode "free tier" is NOT free without a key** — live 401. It is **Tier B/C**, not a no-key source. Do not list it as free.
- **CoinGecko is "free" but functionally not a backfill source** — 429 after 2 calls, current-supply-only, ~365d window. Treat as snapshot-only; it cannot supply the stablecoin/price history (DefiLlama/Binance do).
- **Etherscan "free" requires a free-signup key on every endpoint** (V1 dead). Under the no-signup constraint it is **unusable**; OC2 correctly flagged this. Use CM ETH metrics instead — do not assume Etherscan is available.
- **Santiment is "free" but only for 2 open metrics** — its on-chain/valuation/exchange metrics (mvrv_usd, exchange_balance, network_growth) are **gated to a rolling ~1y window with a ~30d holdback** on SANAPI FREE (live error confirmed). Do **not** plan a backtest on Santiment's gated metrics; use them only for the 2 open ones (DAA, dev_activity).
- **The Graph "hosted service free"** — fully **sunset (June 2024)**; the decentralized gateway needs a key. Listing "The Graph" as a free data source is wrong.

**DATA-QUALITY TRAPS (must be controlled in any real test):**
1. **Look-ahead from REVISED on-chain metrics.** CM exchange-flow and some MVRV rows carry `status: flash / reviewed` (provisional, restated later). DefiLlama TVL and stablecoin supply are oracle-priced/methodology-dependent and **restated retroactively**. Today's series is **not point-in-time** → a naive backtest leaks future revisions. *Control:* lag features, treat as proxy, and if it passes, re-pull and confirm stability.
2. **USD-denomination tautology.** OC4 proved ETH-TVL-momentum vs same-week ETH return r=**0.87** is **mechanical** — USD-denominated TVL moves *with* price. **Never use a USD-denominated stock as a contemporaneous predictor.** Use native-unit flows (CM `…Ntv`) or strictly-lagged ratios.
3. **Survivorship in token/chain lists.** DefiLlama's "current top chains/protocols" excludes dead chains and delisted tokens; OC3's Polygon native price already broke (matic→POL rebrand returned 0 months). A cross-chain test on *today's* surviving chains is **survivorship-biased** → use point-in-time chain membership, or restrict to BTC/ETH (the recommended design does this).
4. **Slow-series / low-N illusion.** Stablecoin supply is a slow daily macro series; "3106 rows" overstates independent information (high autocorrelation). DSR/PBO at the **honest N** is what catches this — do not inflate the effective sample.
5. **Definition mismatches across sources.** Blockchain.com `n-unique-addresses` ≠ CM `AdrActCnt` (different definitions); CM exchange-flow coverage ≠ Glassnode netflow. Cross-source "confirmation" can be spurious if definitions differ — cross-check values, not just names.

**UNVERIFIED claims (flagged):** None of the *working* Tier-A sources are unverified — all were hit live (HTTP 200, real rows, statuses in `_probe_summary.json` / `source-probe-results.json` / `oc3-keyed-probe.json`). The MISSED sources in this section (DefiLlama bridges/fees, Blockchain.com mvrv/nvt slugs, Coinpaprika/CoinCap) are **UNVERIFIED — not hit live** in any POC; they are strong candidates by API family but must be probed before being relied on.

---

## Executive Summary

- **$0 feasibility: confirmed and proven live.** The no-key backbone is **Coin Metrics Community** (genesis-depth BTC/ETH: active addresses, tx, fees, supply, mcap, **MVRV**, **exchange in/out flows**) + **DefiLlama** (stablecoin supply 2017→now, chain TVL-share rotation 5–8y, DEX volume), with Binance/Bybit/OKX funding, Blockchain.com, mempool.space, and Santiment (2 open metrics) as no-key support. All daily.
- **The cleanest signals are PROXIES, not the premium metric.** True exchange **netflow** (Glassnode/CryptoQuant) and **raw realized cap/NVTAdj** (CM Pro) are **paid (401/403)**. At $0 we test flow *proxies*: CM native-unit exchange flows, MVRV, stablecoin dry-powder, TVL-share.
- **Dead-ends correctly excluded:** Glassnode, CryptoQuant (paid); Etherscan, Dune, The Graph (decentralized), Bitquery, Messari (free-signup key required, no signup); CoinGecko (works but throttled/snapshot-only — not a backfill source).
- **Recommended test (since RUN as the 28th hypothesis — KILL):** a **BTC+ETH exchange-net-flow + MVRV two-gate "distribution-pressure" overlay**, vol-targeted spot, ~3,800 daily obs/asset, **honest N=36**, run through `validateStrategy`. The correct null is **phase-randomization + block-bootstrap** (`crossSectional: false`) — *not* the cross-sectional shuffle that rightly killed the rotation tests (C1 p=1.000). It was a **genuinely new data source** the prior 27 hypotheses never tested. **Outcome: KILL** (binding gate baselines; surrogate placeboP=0.482) — see `RESULTS.md` §3 (Round 7) and `output/onchain-poc/verdict.json`.
- **Honest expectation was KILL, and KILL is what happened** (design-time prior = 25/27 KILL; on-chain metrics are heavily arbitraged; live sniffs showed ~0 leading signal). The win is methodological: a clean, rigorous KILL on free on-chain flow data closed a real gap. The guarded false-positive risks — **look-ahead from revised (`flash`) on-chain values** and the **USD-denomination tautology** — were both handled (≥1-day lag against CM revision flags; native-unit flow).
