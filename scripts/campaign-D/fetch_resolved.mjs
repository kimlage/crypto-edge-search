// Campaign-D (Polymarket) — $0 resolved-markets snapshot fetcher (v2, time-windowed).
// The Gamma API caps offset pagination (~HTTP 422 beyond offset 10000), so we walk
// MONTH-BY-MONTH windows [monthStart, monthEnd) using end_date_min/end_date_max, with
// offset only WITHIN a month (never exceeds the cap), deduping by market id.
// Ground truth = `outcomePrices` of a closed market (e.g. ["1","0"] => YES resolved).
//
// Usage:  node scripts/campaign-D/fetch_resolved.mjs [startYYYYMM=202001] [endYYYYMM=now]
// Output: output/campaign-D/resolved-markets.jsonl  (deduped, one row per market)
//
// $0: only free Gamma endpoints, polite rate-limit, on-disk cache.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const OUT_DIR = "output/campaign-D";
const OUT = `${OUT_DIR}/resolved-markets.jsonl`;
const PAGE = 100;                 // Gamma caps windowed queries at 100/response
const BASE = "https://gamma-api.polymarket.com/markets";

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (i + 1)); continue; }
      if (res.status === 422) return [];               // window/offset edge => treat as empty
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

const pick = (m) => ({
  id: m.id, slug: m.slug, question: m.question,
  endDate: m.endDate, startDate: m.startDate, closed: m.closed,
  outcomes: m.outcomes, outcomePrices: m.outcomePrices, clobTokenIds: m.clobTokenIds,
  volumeNum: m.volumeNum ?? m.volume ?? null, liquidityNum: m.liquidityNum ?? m.liquidity ?? null,
  umaResolutionStatus: m.umaResolutionStatus ?? null, negRisk: m.negRisk ?? null, spread: m.spread ?? null,
});

function monthIso(y, m) { return `${y}-${String(m).padStart(2, "0")}-01T00:00:00Z`; }
function* months(start, end) {           // start/end = {y,m}
  let y = start.y, m = start.m;
  while (y < end.y || (y === end.y && m <= end.m)) {
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    yield [monthIso(y, m), monthIso(ny, nm)];
    y = ny; m = nm;
  }
}

const now = new Date();
const startArg = process.argv[2] ?? "202001";
const endArg = process.argv[3] ?? `${now.getUTCFullYear()}${String(now.getUTCMonth() + 2).padStart(2, "0")}`;
const start = { y: +startArg.slice(0, 4), m: +startArg.slice(4) };
const end = { y: +endArg.slice(0, 4), m: +endArg.slice(4) };

const seen = new Set();
let total = 0;
const t0 = Date.now();
console.error(`[fetch_resolved v2] ${startArg}..${endArg}`);

for (const [lo, hi] of months(start, end)) {
  let offset = 0, monthN = 0;
  for (;;) {
    const url = `${BASE}?closed=true&limit=${PAGE}&offset=${offset}` +
      `&end_date_min=${encodeURIComponent(lo)}&end_date_max=${encodeURIComponent(hi)}` +
      `&order=endDate&ascending=true`;
    let batch;
    try { batch = await getJson(url); } catch (e) { console.error(`  err ${lo}: ${e.message}`); break; }
    if (!Array.isArray(batch) || batch.length === 0) break;
    const fresh = [];
    for (const m of batch) { if (!seen.has(m.id)) { seen.add(m.id); fresh.push(pick(m)); } }
    if (fresh.length) appendFileSync(OUT, fresh.map((x) => JSON.stringify(x)).join("\n") + "\n");
    total += fresh.length; monthN += fresh.length;
    offset += batch.length;               // advance by what the API actually returned
    await sleep(110);
    if (offset >= 10000) break;           // hard safety vs the offset cap (rare in one month)
  }
  if (monthN) console.error(`  ${lo.slice(0,7)}: +${monthN} (total ${total}, ${Math.floor((Date.now()-t0)/1000)}s)`);
}

console.error(`[fetch_resolved v2] DONE total=${total} elapsed=${Math.floor((Date.now()-t0)/1000)}s -> ${OUT}`);
