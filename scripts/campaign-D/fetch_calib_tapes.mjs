// Campaign-D — stratified tape pull for a POWERED, full-spectrum calibration.
// The proof-phase calibration was n=171 (volume-skewed). Here we sample binary cleanly-resolved
// markets across volume tiers and time (excluding mega markets whose tapes are huge and which are
// favorite/negRisk-skewed), to cover the longshot..favorite spectrum. Reuses cached tapes ($0).
//
// Usage: node scripts/campaign-D/fetch_calib_tapes.mjs [perTier=400] [conc=4]
// Out:   output/campaign-D/calib-markets.jsonl  (+ shared trades-cache/)

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const DIR = "output/campaign-D";
const TCACHE = `${DIR}/trades-cache`;
const SNAP = `${DIR}/resolved-markets.jsonl`;
const OUT = `${DIR}/calib-markets.jsonl`;
const PER = Number(process.argv[2] ?? 400);
const CONC = Number(process.argv[3] ?? 4);

mkdirSync(TCACHE, { recursive: true });
writeFileSync(OUT, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseArr = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };
async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (i + 1)); continue; }
      if (!r.ok) return null; return await r.json();
    } catch { await sleep(500 * (i + 1)); } }
  return null;
}
async function conditionId(id) { const j = await getJson(`https://gamma-api.polymarket.com/markets/${id}`); return j?.conditionId ?? (Array.isArray(j) ? j[0]?.conditionId : null); }
async function tapeFor(id, cid) {
  const cf = `${TCACHE}/${id}.json`;
  if (existsSync(cf)) { try { return JSON.parse(readFileSync(cf, "utf8")); } catch {} }
  const all = [];
  for (let off = 0; off < 12000; off += 500) {
    const b = await getJson(`https://data-api.polymarket.com/trades?market=${cid}&limit=500&offset=${off}`);
    if (!Array.isArray(b) || b.length === 0) break;
    for (const t of b) all.push({ w: t.proxyWallet, s: t.side, oi: t.outcomeIndex, p: Number(t.price), sz: Number(t.size), ts: t.timestamp });
    if (b.length < 500) break; await sleep(80);
  }
  writeFileSync(cf, JSON.stringify(all)); return all;
}

// stratified selection by volume tier (exclude mega >$200k: huge tapes, favorite/negRisk skew)
const tiers = { lo: [], mid: [], hi: [] };
for (const line of readFileSync(SNAP, "utf8").split("\n")) {
  if (!line.trim()) continue; const m = JSON.parse(line);
  const outs = parseArr(m.outcomes), ops = parseArr(m.outcomePrices);
  if (!outs || outs.length !== 2 || !ops || ops.length !== 2) continue;
  const lower = outs.map((o) => String(o).toLowerCase());
  if (!(lower.includes("yes") && lower.includes("no"))) continue;
  if ({ 0: 1, 1: 1 }[Math.round(Number(ops[0]))] === undefined || Math.round(Number(ops[0])) + Math.round(Number(ops[1])) !== 1) continue;
  const vol = Number(m.volumeNum ?? 0); const end = Date.parse(m.endDate), st = Date.parse(m.startDate);
  if (!Number.isFinite(end) || !Number.isFinite(st) || (end - st) < 2 * 86400_000) continue;
  const yi = lower.indexOf("yes");
  const rec = { id: m.id, endTs: Math.floor(end / 1000), vol, winnerIndex: Math.round(Number(ops[yi])) === 1 ? yi : 1 - yi, outcomes: lower, negRisk: m.negRisk, window: "calib" };
  if (vol >= 2000 && vol < 10000) tiers.lo.push(rec);
  else if (vol >= 10000 && vol < 50000) tiers.mid.push(rec);
  else if (vol >= 50000 && vol < 200000) tiers.hi.push(rec);
}
// deterministic stride sample per tier (spread across the list = across time)
function sample(arr, n) { if (arr.length <= n) return arr; const step = arr.length / n; return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]); }
const selected = [...sample(tiers.lo, PER), ...sample(tiers.mid, PER), ...sample(tiers.hi, PER)];
console.error(`[calib-tapes] tiers lo=${tiers.lo.length} mid=${tiers.mid.length} hi=${tiers.hi.length}; selected ${selected.length} (per=${PER}, conc=${CONC})`);

let idx = 0, n = 0, tot = 0; const t0 = Date.now();
async function worker() {
  while (idx < selected.length) {
    const r = selected[idx++];
    let trades;
    const cf = `${TCACHE}/${r.id}.json`;
    if (existsSync(cf)) { try { trades = JSON.parse(readFileSync(cf, "utf8")); } catch {} }
    if (!trades) { const cid = await conditionId(r.id); if (cid) { await sleep(60); trades = await tapeFor(r.id, cid); } }
    n++; if (trades) { tot += trades.length; appendFileSync(OUT, JSON.stringify({ ...r, nTrades: trades.length }) + "\n"); }
    if (n % 100 === 0) console.error(`  ${n}/${selected.length} (${tot} trades, ${Math.floor((Date.now() - t0) / 1000)}s)`);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
console.error(`[calib-tapes] DONE ${n} markets, ${tot} trades, ${Math.floor((Date.now() - t0) / 1000)}s -> ${OUT}`);
