# Campaign-E recorders — $0, append-only, opt-in

Daily point-in-time data recording for the Campaign E pre-registered forward family
(`docs/campaign-E/PREREGISTRATION.md`). Free keyless endpoints only, paced at ≤1 request/second,
append-only NDJSON under `output/recorders/`.

**The lab's training loop remains OFF** (deliberate decision, 2026-05-31; cron deleted). These
scripts are **data-only recording** — they never train, score, or trade — and any automation of
them is **strictly opt-in**: the launchd plist in `launchd/` is shipped **unloaded** and nothing
in this repo loads it.

## Scripts

| Script | What it records | Output (append-only) |
|---|---|---|
| `record-daily-market.mjs` | 8-major Binance 8h funding; BTC/ETH COIN-M quarterly basis (mark vs index, annualized); live top-30-by-90d-dollar-volume spot universe; last closed daily kline per universe symbol | `market-funding.ndjson`, `market-basis.ndjson`, `market-universe.ndjson`, `market-klines.ndjson` |
| `record-deribit-chain.mjs` | Full Deribit BTC+ETH option chain (per-strike OI, mark IV, full book summaries) + latest DVOL | `deribit-chain.ndjson` (one line per currency per run) |
| `record-unlock-calendar.mjs` | sha256-freezes the on-chain-verified unlock-cliff calendar (E3); scrape selectors TODO, freeze/hash logic final | `docs/campaign-E/frozen-calendar-YYYYMMDD.json` + `unlock-freeze-log.ndjson` |
| `prereg-hash.mjs` | sha256 manifest of the prereg doc + configs | `docs/campaign-E/PREREG_HASHES.json` |

Format convention: one NDJSON file per stream, one JSON line per record, every line stamped with
`{recordedAt, dateUTC, runId}`. Re-running on the same day appends a new `runId`; scorers dedupe
by `(stream key, dateUTC)` keeping the **last** runId.

## Manual daily run (the default)

```sh
cd /path/to/crypto-edge-search
node scripts/recorders/record-daily-market.mjs      # ~70-90 s (paced at <=1 req/s)
node scripts/recorders/record-deribit-chain.mjs     # ~5-10 s (4 HTTP calls)
```

## Optional automation — launchd, not cron

**Why launchd and not cron on macOS:** cron fires only if the machine is awake at the scheduled
minute — on a laptop that sleeps, a 06:00 cron entry silently skips days, which corrupts an
append-only forward log with gaps. launchd's `StartCalendarInterval` instead **coalesces a missed
run and fires it on the next wake**, so the daily snapshot survives sleep. (cron on macOS is also
legacy/deprecated in favor of launchd.)

The job is defined in `launchd/com.kimlage.ces-recorders.plist` (daily 06:00 local, both
recorders, logs to `output/recorders/launchd-run.log`). It is **NOT loaded by anything in this
repo**. To opt in, the user must run, themselves:

```sh
cp scripts/recorders/launchd/com.kimlage.ces-recorders.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kimlage.ces-recorders.plist
```

Verify: `launchctl print gui/$(id -u)/com.kimlage.ces-recorders | head`
Opt out: `launchctl bootout gui/$(id -u)/com.kimlage.ces-recorders`

Note: the shipped plist uses the placeholder repo path `/path/to/crypto-edge-search` in its
command and log-path strings — replace it with your own absolute checkout path before loading.
The plist runs `node` through `/bin/zsh -lc` so the user's login PATH (nvm/homebrew node)
applies. If node lives elsewhere for the login shell, edit the plist's command string accordingly.

## Cost & posture

$0 data (Binance spot/USDT-M/COIN-M public REST, Deribit public API, free RPCs for unlock
verification), no API keys, no cloud, no paid infrastructure, no hourly cost. Paper-forward
recording only — no capital, no orders, no training.
