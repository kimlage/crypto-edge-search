// Campaign-E — daily $0 Deribit PIT option-chain recorder (append-only).
//
// Records, once per day, from the free keyless Deribit public API:
//   - the FULL BTC + ETH option chain via public/get_book_summary_by_currency
//     (per-strike open_interest, mark_iv, mark_price, bid/ask, underlying, volume — full fidelity)
//   - the latest DVOL print via public/get_volatility_index_data
// -> output/recorders/deribit-chain.ndjson
//
// FORMAT DECISION: one append-only NDJSON file; ONE line per currency per run, with the entire
// chain embedded as an array (typically a few hundred KB/line). Rationale: the chain is consumed
// as a daily point-in-time snapshot, so one line == one snapshot keeps PIT semantics trivial;
// per-instrument lines would shred a single observation across ~1500 rows. Dedupe by
// (currency, dateUTC) keeping the LAST runId.
//
// This recorder is the honest $0 route into the deferred options family (GEX, skew, RR, term
// structure, gamma-pin) — PROJECT_REVIEW_2026-06-09.md section 4.2.4. Snapshots only accrue
// forward; no backfill exists at $0.
//
// $0, keyless, 4 HTTP calls/run, paced <=1 req/sec. Usage: node scripts/recorders/record-deribit-chain.mjs

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "output/recorders");
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, "deribit-chain.ndjson");

const UA = "campaign-E-recorder (research; $0 keyless)";
const SLEEP_MS = Math.max(350, Number(process.env.SLEEP_MS ?? 1000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let httpCalls = 0;
async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      httpCalls++;
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(1000 * (i + 1)); }
  }
  return null;
}

const t0 = Date.now();
const recordedAt = new Date().toISOString();
const dateUTC = recordedAt.slice(0, 10);
const runId = `${dateUTC}T${recordedAt.slice(11, 19).replace(/:/g, "")}Z`;

let lines = 0;
for (const currency of ["BTC", "ETH"]) {
  const book = await getJson(
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`,
  );
  await sleep(SLEEP_MS);
  const now = Date.now();
  const dv = await getJson(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${now - 3 * 86400000}&end_timestamp=${now}&resolution=1D`,
  );
  await sleep(SLEEP_MS);
  const chain = Array.isArray(book?.result) ? book.result : null;
  if (!chain) { console.error(`[deribit] chain MISS ${currency}`); continue; }
  // DVOL candles: [timestamp, open, high, low, close]
  const dvolData = dv?.result?.data ?? [];
  const lastDvol = dvolData.length ? dvolData[dvolData.length - 1] : null;
  appendFileSync(
    LOG,
    JSON.stringify({
      recordedAt, dateUTC, runId, currency,
      instrumentCount: chain.length,
      dvol: lastDvol ? { timestamp: lastDvol[0], open: lastDvol[1], high: lastDvol[2], low: lastDvol[3], close: lastDvol[4] } : null,
      chain, // full book summaries, untrimmed (per-strike OI, mark_iv, mark_price, bid/ask, underlying_price, volume, ...)
    }) + "\n",
  );
  lines++;
  console.error(`[deribit] ${currency}: ${chain.length} instruments, dvol=${lastDvol ? lastDvol[4] : "n/a"}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.error(`[deribit] ${dateUTC} runId=${runId} httpCalls=${httpCalls} lines=${lines} in ${secs}s -> ${LOG}`);
