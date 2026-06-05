// Campaign-D — $0 price-at-lead-time extractor for calibration / efficiency tests (concurrent).
// For each cleanly-resolved MULTI-DAY binary (Yes/No) market above a volume floor, fetch the FREE
// CLOB prices-history for the YES token and extract the YES price at fixed lead times before
// resolution (7d, 24h, 1h, last point). Pair with ground-truth resolution. Per-token raw history
// is cached so reruns are $0. Ultra-short (5m/hourly recurring) markets are excluded — no price path.
//
// Usage:  node scripts/campaign-D/price_at_lead.mjs [minVol=3000] [maxMarkets=8000] [minLifeDays=2] [conc=8]
// In:     output/campaign-D/resolved-markets.jsonl
// Out:    output/campaign-D/calibration.jsonl + price-cache/<token>.json

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const DIR = "output/campaign-D";
const CACHE = `${DIR}/price-cache`;
const IN = `${DIR}/resolved-markets.jsonl`;
const OUT = `${DIR}/calibration.jsonl`;
const MIN_VOL = Number(process.argv[2] ?? 3000);
const MAX_MK = Number(process.argv[3] ?? 8000);
const MIN_LIFE_DAYS = Number(process.argv[4] ?? 2);
const CONC = Number(process.argv[5] ?? 8);

mkdirSync(CACHE, { recursive: true });
writeFileSync(OUT, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseArr = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };

let rateLimited = false;
async function getJson(url, tries = 7) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) { rateLimited = true; await sleep(1000 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}
async function history(token) {
  const cf = `${CACHE}/${token}.json`;
  if (existsSync(cf)) { try { return JSON.parse(readFileSync(cf, "utf8")); } catch {} }
  await sleep(180 + Math.floor(Math.random() * 120));   // per-request rate-limit (jittered)
  const j = await getJson(`https://clob.polymarket.com/prices-history?market=${token}&interval=max&fidelity=60`);
  const h = j?.history ?? [];
  if (h.length > 0) writeFileSync(cf, JSON.stringify(h));  // NEVER cache empties (would poison on a 429)
  return h;
}
function priceAtOrBefore(hist, targetTs) {
  let best = null;
  for (const pt of hist) { if (pt.t <= targetTs) best = pt; else break; }
  return best ? best.p : null;
}

// --- candidate selection ---
const rows = [];
for (const line of readFileSync(IN, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  const outs = parseArr(m.outcomes), ops = parseArr(m.outcomePrices), toks = parseArr(m.clobTokenIds);
  if (!outs || outs.length !== 2 || !ops || !toks || toks.length !== 2) continue;
  const lower = outs.map((o) => String(o).toLowerCase());
  if (!(lower.includes("yes") && lower.includes("no"))) continue;
  const yi = lower.indexOf("yes");
  const py = Number(ops[yi]), pn = Number(ops[1 - yi]);
  if (!((Math.round(py) === 1 && Math.round(pn) === 0) || (Math.round(py) === 0 && Math.round(pn) === 1))) continue;
  const vol = Number(m.volumeNum ?? 0); if (!(vol >= MIN_VOL)) continue;
  const end = Date.parse(m.endDate), st = Date.parse(m.startDate); if (!Number.isFinite(end)) continue;
  if (Number.isFinite(st) && (end - st) < MIN_LIFE_DAYS * 86400_000) continue;
  rows.push({ id: m.id, q: m.question, endTs: Math.floor(end / 1000), yesTok: toks[yi], vol, resYes: Math.round(py), spread: m.spread });
}
rows.sort((a, b) => b.vol - a.vol);
const work = rows.slice(0, MAX_MK);
console.error(`[price_at_lead] candidates=${rows.length} fetching top ${work.length} (minVol=$${MIN_VOL}, minLife=${MIN_LIFE_DAYS}d, conc=${CONC})`);

// --- concurrent worker pool ---
let idx = 0, ok = 0, done = 0;
const t0 = Date.now();
async function worker() {
  while (idx < work.length) {
    const r = work[idx++];
    const h = await history(r.yesTok);
    done++;
    if (h && h.length >= 3) {
      const row = { id: r.id, q: r.q, endTs: r.endTs, vol: r.vol, resYes: r.resYes, spreadField: r.spread, nPoints: h.length,
        p_7d: priceAtOrBefore(h, r.endTs - 7 * 86400), p_24h: priceAtOrBefore(h, r.endTs - 86400),
        p_1h: priceAtOrBefore(h, r.endTs - 3600), p_close: h[h.length - 1].p, firstTs: h[0].t, lastTs: h[h.length - 1].t };
      appendFileSync(OUT, JSON.stringify(row) + "\n");
      ok++;
    }
    if (done % 400 === 0) console.error(`  ${done}/${work.length} (usable ${ok}, ${Math.floor((Date.now() - t0) / 1000)}s)`);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
console.error(`[price_at_lead] DONE usable=${ok}/${work.length} elapsed=${Math.floor((Date.now() - t0) / 1000)}s -> ${OUT}`);
