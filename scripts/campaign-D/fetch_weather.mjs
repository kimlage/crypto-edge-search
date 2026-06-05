// Campaign-D — weather-bot hypothesis: pull tapes for recent temperature markets to (a) find the
// "Yes @ 9.1c / No @ 50c" wallet and (b) test whether ~9c weather longshots are fairly priced.
// Usage: node scripts/campaign-D/fetch_weather.mjs [maxMarkets=600] [conc=3] [sinceISO=2026-04-01]
// Out: output/campaign-D/weather-markets.jsonl (+ shared trades-cache/)

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`; const OUT = `${DIR}/weather-markets.jsonl`;
const MAX = Number(process.argv[2] ?? 600), CONC = Number(process.argv[3] ?? 3), SINCE = process.argv[4] ?? "2026-04-01";
mkdirSync(TCACHE, { recursive: true }); writeFileSync(OUT, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pa = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };
async function getJson(url, t = 5) { for (let i = 0; i < t; i++) { try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(500 * (i + 1)); } } return null; }
const wre = /temperature|°c|degrees|high temp|low temp|warmer|hotter|lowest temp|highest temp/i;

const sel = [];
for (const l of readFileSync(`${DIR}/resolved-markets.jsonl`, "utf8").split("\n")) {
  if (!l.trim()) continue; const m = JSON.parse(l); const q = m.question || "";
  if (!wre.test(q)) continue; if ((m.endDate || "") < SINCE) continue;
  const outs = pa(m.outcomes), ops = pa(m.outcomePrices);
  if (!outs || outs.length !== 2 || !ops || ops.length !== 2) continue;
  const lower = outs.map((o) => String(o).toLowerCase()); if (!(lower.includes("yes") && lower.includes("no"))) continue;
  const yi = lower.indexOf("yes"); const py = Math.round(Number(ops[yi])), pn = Math.round(Number(ops[1 - yi]));
  if (!((py === 1 && pn === 0) || (py === 0 && pn === 1))) continue;
  sel.push({ id: m.id, endTs: Math.floor(Date.parse(m.endDate) / 1000), winnerIndex: py === 1 ? yi : 1 - yi, outcomes: lower, q: q.slice(0, 60) });
}
sel.sort((a, b) => b.endTs - a.endTs);
const work = sel.slice(0, MAX);
console.error(`[weather] candidates=${sel.length} fetching ${work.length} (since ${SINCE}, conc=${CONC})`);

async function cid(id) { const j = await getJson(`https://gamma-api.polymarket.com/markets/${id}`); return j?.conditionId ?? (Array.isArray(j) ? j[0]?.conditionId : null); }
async function tape(id, c) { const cf = `${TCACHE}/${id}.json`; if (existsSync(cf)) { try { return JSON.parse(readFileSync(cf, "utf8")); } catch {} } const all = []; for (let off = 0; off < 6000; off += 500) { const b = await getJson(`https://data-api.polymarket.com/trades?market=${c}&limit=500&offset=${off}`); if (!Array.isArray(b) || b.length === 0) break; for (const t of b) all.push({ w: t.proxyWallet, s: t.side, oi: t.outcomeIndex, p: Number(t.price), sz: Number(t.size), ts: t.timestamp }); if (b.length < 500) break; await sleep(70); } writeFileSync(cf, JSON.stringify(all)); return all; }

let idx = 0, n = 0, tot = 0; const t0 = Date.now();
async function worker() { while (idx < work.length) { const r = work[idx++]; let tr; const cf = `${TCACHE}/${r.id}.json`; if (existsSync(cf)) { try { tr = JSON.parse(readFileSync(cf, "utf8")); } catch {} } if (!tr) { const c = await cid(r.id); if (c) { await sleep(50); tr = await tape(r.id, c); } } n++; if (tr) { tot += tr.length; appendFileSync(OUT, JSON.stringify({ ...r, nTrades: tr.length }) + "\n"); } if (n % 100 === 0) console.error(`  ${n}/${work.length} (${tot} trades, ${Math.floor((Date.now() - t0) / 1000)}s)`); } }
await Promise.all(Array.from({ length: CONC }, () => worker()));
console.error(`[weather] DONE ${n} markets, ${tot} trades, ${Math.floor((Date.now() - t0) / 1000)}s -> ${OUT}`);
