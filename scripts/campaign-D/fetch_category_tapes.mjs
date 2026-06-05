// Campaign-D — CR24/CR25: cross-category calibration coverage. Sample resolved binary markets in
// sports/politics/geopolitics/entertainment, pull tapes, tag category, for the calibration gauntlet.
// Usage: node scripts/campaign-D/fetch_category_tapes.mjs [perCat=300] [conc=4]
// Out:   output/campaign-D/category-markets.jsonl (+ shared trades-cache/)
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`; const OUT = `${DIR}/category-markets.jsonl`;
const PER = Number(process.argv[2] ?? 300), CONC = Number(process.argv[3] ?? 4);
mkdirSync(TCACHE, { recursive: true }); writeFileSync(OUT, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pa = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };
async function getJson(url, t = 5) { for (let i = 0; i < t; i++) { try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(500 * (i + 1)); } } return null; }
const CATS = {
  sports: /\b(nba|nfl|mlb|nhl|premier league|champions league|la liga|serie a|bundesliga|world cup|moneyline|vs\.?|defeat|beat the|win the.*(final|cup|title|championship)|super bowl)\b/i,
  politics: /\b(election|president|senate|governo?r|primary|nominee|congress|parliament|prime minister|electoral|cabinet|impeach)\b/i,
  geopolitics: /\b(war|sanction|ceasefire|invasion|nuclear|treaty|conflict|missile|troops|annex|coup|airstrike|hostage)\b/i,
  entertainment: /\b(movie|box office|rotten tomatoes|album|oscar|grammy|emmy|award|gross.*weekend|premiere|tomatometer|billboard)\b/i,
};
const weather = /temperature in .+ be .*°[CF]/i;
const buckets = { sports: [], politics: [], geopolitics: [], entertainment: [] };
for (const l of readFileSync(`${DIR}/resolved-markets.jsonl`, "utf8").split("\n")) {
  if (!l.trim()) continue; const m = JSON.parse(l); const q = m.question || "";
  if (weather.test(q)) continue; // exclude weather (already covered)
  const outs = pa(m.outcomes), ops = pa(m.outcomePrices);
  if (!outs || outs.length !== 2 || !ops || ops.length !== 2) continue;
  const lower = outs.map((o) => String(o).toLowerCase()); if (!(lower.includes("yes") && lower.includes("no"))) continue;
  const yi = lower.indexOf("yes"); const py = Math.round(Number(ops[yi])), pn = Math.round(Number(ops[1 - yi]));
  if (!((py === 1 && pn === 0) || (py === 0 && pn === 1))) continue;
  const vol = Number(m.volumeNum ?? 0); if (vol < 5000) continue;
  const end = Date.parse(m.endDate), st = Date.parse(m.startDate); if (!Number.isFinite(end) || !Number.isFinite(st) || (end - st) < 2 * 86400_000) continue;
  for (const [cat, re] of Object.entries(CATS)) { if (re.test(q)) { buckets[cat].push({ id: m.id, endTs: Math.floor(end / 1000), winnerIndex: py === 1 ? yi : 1 - yi, outcomes: lower, vol, category: cat, negRisk: m.negRisk === true }); break; } }
}
const stride = (a, n) => a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor(i * a.length / n)]);
const selected = Object.values(buckets).flatMap((arr) => stride(arr.sort((a, b) => b.vol - a.vol), PER));
console.error(`[category] ${Object.entries(buckets).map(([k, v]) => `${k}:${v.length}`).join(" ")} -> selected ${selected.length} (per=${PER})`);
async function cid(id) { const j = await getJson(`https://gamma-api.polymarket.com/markets/${id}`); return j?.conditionId ?? (Array.isArray(j) ? j[0]?.conditionId : null); }
async function tape(id, c) { const cf = `${TCACHE}/${id}.json`; if (existsSync(cf)) { try { return JSON.parse(readFileSync(cf, "utf8")); } catch {} } const all = []; for (let off = 0; off < 4000; off += 500) { const b = await getJson(`https://data-api.polymarket.com/trades?market=${c}&limit=500&offset=${off}`); if (!Array.isArray(b) || b.length === 0) break; for (const t of b) all.push({ w: t.proxyWallet, s: t.side, oi: t.outcomeIndex, p: Number(t.price), sz: Number(t.size), ts: t.timestamp }); if (b.length < 500) break; await sleep(80); } writeFileSync(cf, JSON.stringify(all)); return all; }
let idx = 0, n = 0; const t0 = Date.now();
async function worker() { while (idx < selected.length) { const r = selected[idx++]; let tr; const cf = `${TCACHE}/${r.id}.json`; if (existsSync(cf)) { try { tr = JSON.parse(readFileSync(cf, "utf8")); } catch {} } if (!tr) { const c = await cid(r.id); if (c) { await sleep(50); tr = await tape(r.id, c); } } n++; if (tr) appendFileSync(OUT, JSON.stringify({ ...r, nTrades: tr.length }) + "\n"); if (n % 100 === 0) console.error(`  ${n}/${selected.length} (${Math.floor((Date.now() - t0) / 1000)}s)`); } }
await Promise.all(Array.from({ length: CONC }, () => worker()));
console.error(`[category] DONE ${n} markets -> ${OUT}`);
