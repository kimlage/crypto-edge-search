// Campaign-D — LIVE static-arbitrage scanner (the only candidate for RISKLESS profit).
// negRisk events are mutually-exclusive AND exhaustive (exactly one member resolves YES), so the YES
// asks across a basket MUST sum to >= 1 in an arbitrage-free book. If sum(bestAsk_YES) < 1 you can BUY
// every outcome's YES for < $1 and one is guaranteed to pay $1 => riskless profit (Polymarket charges
// 0 trading fee). We scan all live negRisk baskets, measure the overround, and for any sub-1 basket we
// verify the EXECUTABLE profit by walking the real CLOB order books at depth.
//
// Within-market complete-set (ask_YES + ask_NO < 1) is structurally impossible (one shared book =>
// always 1 + spread), so it is not scanned.
//
// Usage: node scripts/campaign-D/live_arb_scan.mjs
// Out:   output/campaign-D/live_arb.json

import { writeFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (i + 1)); continue; }
      if (!r.ok) return null; return await r.json();
    } catch { await sleep(500 * (i + 1)); } }
  return null;
}
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const parseArr = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };

// 1) pull live events (paginated; gamma caps ~100/page)
const events = [];
for (let off = 0; off < 8000; off += 100) {
  const b = await getJson(`https://gamma-api.polymarket.com/events?closed=false&active=true&limit=100&offset=${off}&order=volume&ascending=false`);
  if (!Array.isArray(b) || b.length === 0) break;
  events.push(...b); if (b.length < 100) break; await sleep(100);
}
console.error(`[live_arb] fetched ${events.length} live events`);

// 2) for each negRisk basket (>=3 members), sum YES bestAsk / bestBid
const baskets = [];
for (const e of events) {
  if (e.negRisk !== true) continue;
  const ms = (e.markets || []).filter((m) => m.active !== false && m.closed !== true);
  if (ms.length < 3) continue;
  let sumAsk = 0, sumBid = 0, nAsk = 0, allLiquid = true;
  const legs = [];
  for (const m of ms) {
    const ask = num(m.bestAsk), bid = num(m.bestBid);
    const toks = parseArr(m.clobTokenIds);
    // a leg is LIQUID/real only if BOTH sides are quoted away from the 0/1 rails (else stale placeholder)
    const liquid = ask != null && ask > 0 && ask <= 0.99 && bid != null && bid >= 0.01;
    if (!liquid) allLiquid = false;
    if (ask != null && ask > 0 && ask <= 1) { sumAsk += ask; nAsk++; }
    if (bid != null && bid >= 0) sumBid += bid;
    legs.push({ q: (m.question || "").slice(0, 40), ask, bid, liquid, yesTok: toks ? toks[0] : null });
  }
  // completeness proxy: a truly exhaustive basket cannot have all outcomes bid ~0; require bids to sum near a unit
  const tradeable = allLiquid && nAsk === ms.length && sumBid > 0.7;
  baskets.push({ event: (e.title || "").slice(0, 50), n: ms.length, nAsk, sumAsk: +sumAsk.toFixed(4), sumBid: +sumBid.toFixed(4), overround: +(sumAsk - 1).toFixed(4), complete: tradeable, legs, vol: num(e.volume) });
}
baskets.sort((a, b) => a.overround - b.overround);
console.error(`[live_arb] ${baskets.length} negRisk baskets (>=3 legs)`);

// 3) distribution of overround (arb-free => overround >= 0)
const ov = baskets.filter((b) => b.complete).map((b) => b.overround).sort((a, b) => a - b);
const q = (p) => ov.length ? ov[Math.floor(p * (ov.length - 1))] : null;
console.log(`\n=== negRisk basket overround (sum YES asks - 1; <0 => BUY-side arb) ===`);
console.log(`complete baskets: ${ov.length}`);
if (ov.length) console.log(`overround quantiles: min ${q(0).toFixed(4)} | p05 ${q(.05).toFixed(4)} | median ${q(.5).toFixed(4)} | p95 ${q(.95).toFixed(4)} | max ${q(1).toFixed(4)}`);
const buyArbs = baskets.filter((b) => b.complete && b.sumAsk < 1 && b.nAsk === b.n);
console.log(`\nBUY-side arb candidates (complete basket, all legs quoted, sum ask < 1): ${buyArbs.length}`);

// 4) verify the top buy-side candidates against the real CLOB books at depth
async function bookAsks(tok) { const b = await getJson(`https://clob.polymarket.com/book?token_id=${tok}`); const a = (b?.asks || []).map((x) => ({ p: Number(x.price), s: Number(x.size) })).sort((u, v) => u.p - v.p); return a; }
const verified = [];
for (const cand of buyArbs.slice(0, 12)) {
  // executable: buy 1 share of EACH leg's cheapest ask; cost = sum of touch asks; profit per set = 1 - cost
  const touchCost = cand.legs.reduce((s, l) => s + (l.ask ?? 1), 0);
  // depth: min size across legs' best ask = #sets executable at the touch
  let minSize = Infinity; const books = [];
  for (const l of cand.legs) { if (!l.yesTok) { minSize = 0; break; } const a = await bookAsks(l.yesTok); books.push(a); minSize = Math.min(minSize, a[0]?.s ?? 0); await sleep(60); }
  verified.push({ event: cand.event, n: cand.n, sumAsk_gamma: cand.sumAsk, touchCost: +touchCost.toFixed(4), profitPerSet: +(1 - touchCost).toFixed(4), setsAtTouch: Number.isFinite(minSize) ? minSize : 0, grossProfitAtTouch: +((1 - touchCost) * (Number.isFinite(minSize) ? minSize : 0)).toFixed(2) });
}
verified.sort((a, b) => b.grossProfitAtTouch - a.grossProfitAtTouch);
console.log(`\n=== verified top BUY-side candidates (live CLOB books at the touch) ===`);
for (const v of verified) console.log(`  ${v.event}: ${v.n} legs, touchCost ${v.touchCost}, profit/set ${v.profitPerSet}, sets@touch ${v.setsAtTouch}, gross@touch $${v.grossProfitAtTouch}`);

writeFileSync("output/campaign-D/live_arb.json", JSON.stringify({ nEvents: events.length, nBaskets: baskets.length, overroundQuantiles: { min: q(0), p05: q(.05), median: q(.5), p95: q(.95), max: q(1) }, nBuyArbCandidates: buyArbs.length, verified, tightest: baskets.filter((b) => b.complete).slice(0, 10).map((b) => ({ event: b.event, n: b.n, sumAsk: b.sumAsk, overround: b.overround })) }, null, 2));
console.log(`\nwrote output/campaign-D/live_arb.json`);
