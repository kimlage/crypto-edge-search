# scripts/fetchers — recommitted cache fetchers

Recommit of the minimal fetchers behind the on-disk data caches, closing the
reproducibility gap flagged in `docs/PROJECT_REVIEW_2026-06-09.md` §2 fix 8 (the original
fetch scripts were no longer in the tree; `docs/REPRODUCIBILITY.md` §1 documents the
sources). Node 18+ (global `fetch`), zero dependencies, all endpoints free / public /
key-less. Each script paces itself at ~1 request/second (override with `FETCH_DELAY_MS`).

## Cache → fetcher → endpoint map

| Cache path | Fetcher command (exact-reproduction args) | API endpoint(s) | Notes |
|---|---|---|---|
| `output/funding/{SYM}_funding_8h.json`, `{SYM}_prices_daily.json`, `manifest.json` | `node scripts/fetchers/fetch-funding-binance.mjs --symbols BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT --start 2023-06-01 --end 2026-05-31 --out output/funding` | `fapi.binance.com/fapi/v1/fundingRate` (1000/page, paginate by advancing `startTime` past the last `fundingTime`; history back to 2019); `api.binance.com/api/v3/klines` + `fapi.binance.com/fapi/v1/klines` (1d closes, joined by UTC date) | Funding rows keep the raw API ms timestamps (a few ms of jitter past the 8h mark is real). Rates/closes stored as JS numbers. Binance weight limits are generous (2400/min on fapi); the built-in 1.1 s pacing is far below them. |
| `output/carry/bybit_{SYM}_funding_8h.json`, `okx_{SYM}_funding_8h.json`, `manifest.json` (also `output/carry/d3/bybit_{SYM}_funding.json` — same Bybit rows, different filename) | `node scripts/fetchers/fetch-funding-bybit-okx.mjs --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT --start 2023-06-01 --end 2026-05-31 --out output/carry` | `api.bybit.com/v5/market/funding/history` (category=linear, 200/page, paginate backwards via `endTime`, full history); `www.okx.com/api/v5/public/funding-rate-history` (100/page, paginate via `after`) | **OKX retains only ~3 months** of funding history on this endpoint — the committed `okx_*` files (2026-02-28 → 2026-05-31, 277 records) cover exactly that window and older OKX history is **not re-fetchable**; the committed cache is the archival record. Bybit reproduces the full 3288-record window. |
| `output/carry/{BTC,ETH}USDT_spot_depth.json`, `{BTC,ETH}USDT_perp_depth.json` | add `--depth` to the command above | `api.binance.com/api/v3/depth?limit=1000`; `fapi.binance.com/fapi/v1/depth?limit=1000` (raw responses saved verbatim) | Depth is a **point-in-time snapshot** — re-running captures "now", it cannot reproduce the committed 2026-05-31 books. |
| `output/dated-futures/BTC_quarterly_basis.json`, `ETH_quarterly_basis.json`, `manifest.json` | `node scripts/fetchers/fetch-dated-futures-basis.mjs --asset BTC --end 2025-10-01 --out output/dated-futures` then same with `--asset ETH` (manifest merges across runs) | `dapi.binance.com/dapi/v1/klines` (COIN-M delivery contracts, 1d; **expired contracts still serve klines when an explicit `startTime` is passed** — verified live against `BTCUSD_220325`); `api.binance.com/api/v3/klines` (spot 1d) | Contracts are auto-discovered: delivery = last Friday of Mar/Jun/Sep/Dec, symbol `{ASSET}USD_{YYMMDD}`; a candidate is kept only if it has klines AND its first kline date ≥ `--start` (default 2021-09-01 — this excludes `*_211231`, which listed 2021-06, matching the cache). `--end 2025-10-01` reproduces the committed 15-contract set (`*_220325` … `*_250926`); omit `--end` to extend through the present. `basis = (futureClose − spotClose) / spotClose` (this exact float expression, bit-identical to the cache; `future/spot − 1` differs in the last ulp). |

## Selftests

Every script has `--selftest`: fetches ONE symbol over ~3 days, writes to
`/tmp/fetchers-selftest/<name>/`, validates the produced JSON against an embedded shape
check (keys, types, monotonic timestamps, `basis == future/spot − 1`), prints PASS/FAIL,
exits non-zero on FAIL.

```sh
node scripts/fetchers/fetch-funding-binance.mjs --selftest
node scripts/fetchers/fetch-funding-bybit-okx.mjs --selftest
node scripts/fetchers/fetch-dated-futures-basis.mjs --selftest
```

## Survivorship note — delisted perps

The `fapi`/REST funding endpoint only serves **currently listed** symbols, so any panel
built from it is survivorship-biased by construction (see the caveat in
`docs/REPRODUCIBILITY.md`). For survivorship-free funding panels, use the Binance public
data dumps instead, which retain **delisted** perps (e.g. `FTTUSDT`):

```
https://data.binance.vision/data/futures/um/monthly/fundingRate/<SYMBOL>/
  e.g. .../fundingRate/FTTUSDT/FTTUSDT-fundingRate-2022-11.zip
```

(monthly CSV zips, no key; same `calc_time/funding_rate` data the REST endpoint serves
for listed symbols). Daily/monthly klines for delisted perps live under
`data.binance.vision/data/futures/um/{daily,monthly}/klines/` likewise.

## Caveats

- These fetchers reproduce the cache **shapes** exactly; live re-fetches of funding and
  dated-futures klines reproduce the committed **values** too (historical data is
  immutable), but the two snapshot-style caches (OKX >3-months-old funding, depth books)
  can only be refreshed, not back-filled.
- `output/carry/d3/fetch-manifest.json` (`source: bybit_v5_public`, per-symbol
  `ok/count/meanRate/...`) was written by the D3 campaign wrapper, not by these fetchers;
  the underlying rows are identical to `output/carry/bybit_*` (verified byte-identical).
- Never run these against `output/` while an analysis is mid-flight; they overwrite the
  cache files they target.
