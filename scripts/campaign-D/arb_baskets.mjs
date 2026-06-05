// Campaign-D — committed negRiskMarketID basket grouping for the live-arb claim (the audit flagged
// that the "293 baskets / median 1.060 overround" came from an inline script, not committed code,
// while live_arb_scan.mjs groups by EVENT (1,955 baskets / 1.044)). This emits BOTH groupings.
//
// Usage: node scripts/campaign-D/arb_baskets.mjs
// Out:   output/campaign-D/arb_baskets.json

import { writeFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, t = 5) { for (let i = 0; i < t; i++) { try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); if (r.status === 429 || r.status >= 500) { await sleep(700 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(500 * (i + 1)); } } return null; }
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

const baskets = new Map(); // negRiskMarketID -> [bestAsk...]
let scanned = 0;
for (let off = 0; off < 12000; off += 100) {
  const d = await getJson(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&offset=${off}`);
  if (!Array.isArray(d) || d.length === 0) break;
  for (const m of d) { const nid = m.negRiskMarketID, ba = num(m.bestAsk); if (nid && ba != null && ba > 0 && ba <= 1) { if (!baskets.has(nid)) baskets.set(nid, []); baskets.get(nid).push(ba); } }
  scanned += d.length; if (d.length < 100) break; await sleep(80);
}
const sums = [...baskets.values()].filter((v) => v.length >= 3).map((v) => v.reduce((a, b) => a + b, 0));
sums.sort((a, b) => a - b);
const median = sums.length ? sums[sums.length >> 1] : null;
const below1 = sums.filter((s) => s < 0.999).length;
const out = {
  scanned_open_markets: scanned,
  negRiskMarketID_baskets_ge3legs: sums.length,
  median_basket_sum_ask: median != null ? +median.toFixed(4) : null,
  overround_median: median != null ? +(median - 1).toFixed(4) : null,
  baskets_sum_below_1: below1,
  note: "median sum(ask) > 1 => arb-free buy side; sub-1 baskets are undercounted/incomplete (this scan itself caps at offset 12000).",
  tightest8: sums.slice(0, 8).map((s) => +s.toFixed(3)),
};
writeFileSync("output/campaign-D/arb_baskets.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
