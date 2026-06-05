// Campaign-D — $0 trade-tape fetcher for the COPY-TRADING skill-persistence test.
// Selects liquid, cleanly-resolved binary markets in a TRAIN window and a disjoint OOS
// window, resolves each market's conditionId (free Gamma lookup), and pulls the FULL
// per-market trade tape (free data-api, wallet ids + side + price + size + outcomeIndex).
// Everything cached so reruns are $0. Resolution (ground truth) comes from the snapshot.
//
// Usage: node scripts/campaign-D/fetch_copy_trades.mjs \
//          [trainStart=2025-08-01] [trainEnd=2025-11-01] [oosStart=2025-11-01] [oosEnd=2026-02-01] \
//          [perWindow=250] [minVol=20000] [maxVol=3000000]
// Out:   output/campaign-D/copy-markets.jsonl
//        output/campaign-D/trades-cache/<id>.json

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const DIR = "output/campaign-D";
const TCACHE = `${DIR}/trades-cache`;
const SNAP = `${DIR}/resolved-markets.jsonl`;
const OUT = `${DIR}/copy-markets.jsonl`;

const a = process.argv.slice(2);
const TRAIN_START = a[0] ?? "2025-08-01", TRAIN_END = a[1] ?? "2025-11-01";
const OOS_START = a[2] ?? "2025-11-01", OOS_END = a[3] ?? "2026-02-01";
const PER = Number(a[4] ?? 250), MINV = Number(a[5] ?? 20000), MAXV = Number(a[6] ?? 3000000);
const OUT_OVERRIDE = a[7] ?? OUT;  // walk-forward: write a separate file per window-pair (shared trades-cache)

mkdirSync(TCACHE, { recursive: true });
writeFileSync(OUT_OVERRIDE, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseArr = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };

async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) { await sleep(800 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(600 * (i + 1)); }
  }
  return null;
}

// --- select candidate markets per window ---
function inWin(ts, s, e) { return ts >= Date.parse(s) && ts < Date.parse(e); }
const cand = { train: [], oos: [] };
for (const line of readFileSync(SNAP, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  const outs = parseArr(m.outcomes), ops = parseArr(m.outcomePrices);
  if (!outs || outs.length !== 2 || !ops || ops.length !== 2) continue;
  const lower = outs.map((o) => String(o).toLowerCase());
  if (!(lower.includes("yes") && lower.includes("no"))) continue;
  const p0 = Number(ops[0]), p1 = Number(ops[1]);
  if (!({ 0: 1, 1: 1 }[Math.round(p0)] && Math.round(p0) + Math.round(p1) === 1)) continue; // clean 0/1
  const vol = Number(m.volumeNum ?? 0);
  if (!(vol >= MINV && vol <= MAXV)) continue;
  const end = Date.parse(m.endDate); if (!Number.isFinite(end)) continue;
  const winnerIndex = Math.round(p0) === 1 ? 0 : 1;
  const rec = { id: m.id, endTs: Math.floor(end / 1000), vol, winnerIndex, outcomes: lower };
  if (inWin(end, TRAIN_START, TRAIN_END)) cand.train.push(rec);
  else if (inWin(end, OOS_START, OOS_END)) cand.oos.push(rec);
}
for (const w of ["train", "oos"]) cand[w].sort((x, y) => y.vol - x.vol);
const selected = [
  ...cand.train.slice(0, PER).map((r) => ({ ...r, window: "train" })),
  ...cand.oos.slice(0, PER).map((r) => ({ ...r, window: "oos" })),
];
console.error(`[copy] candidates train=${cand.train.length} oos=${cand.oos.length}; selected ${selected.length} (per=${PER}, vol [$${MINV},$${MAXV}])`);

async function conditionId(id) {
  const j = await getJson(`https://gamma-api.polymarket.com/markets/${id}`);
  return j?.conditionId ?? (Array.isArray(j) ? j[0]?.conditionId : null);
}
async function tradesFor(id, cid) {
  const cf = `${TCACHE}/${id}.json`;
  if (existsSync(cf)) { try { return JSON.parse(readFileSync(cf, "utf8")); } catch {} }
  const all = [];
  for (let off = 0; off < 20000; off += 500) {
    const batch = await getJson(`https://data-api.polymarket.com/trades?market=${cid}&limit=500&offset=${off}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const t of batch) all.push({ w: t.proxyWallet, s: t.side, oi: t.outcomeIndex, p: Number(t.price), sz: Number(t.size), ts: t.timestamp });
    if (batch.length < 500) break;
    await sleep(90);
  }
  writeFileSync(cf, JSON.stringify(all));
  return all;
}

let n = 0, tradesTotal = 0;
const t0 = Date.now();
for (const r of selected) {
  n++;
  const cid = await conditionId(r.id);
  if (!cid) continue;
  await sleep(70);
  const tr = await tradesFor(r.id, cid);
  tradesTotal += tr.length;
  appendFileSync(OUT_OVERRIDE, JSON.stringify({ ...r, conditionId: cid, nTrades: tr.length }) + "\n");
  if (n % 50 === 0) console.error(`  ${n}/${selected.length} markets, ${tradesTotal} trades (${Math.floor((Date.now() - t0) / 1000)}s)`);
}
console.error(`[copy] DONE ${n} markets, ${tradesTotal} trades, ${Math.floor((Date.now() - t0) / 1000)}s -> ${OUT}`);
