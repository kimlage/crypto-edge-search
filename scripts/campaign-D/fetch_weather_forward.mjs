// Campaign-D — FORWARD weather-forecast logger (the one non-refuted external-info lead).
// For ACTIVE (unresolved) weather markets resolving in the next days, record NOW: the Open-Meteo
// ENSEMBLE forecast probability P_model (real forecast skill > climatology) + the current market price.
// Look-ahead-free by construction (forecast made now, market resolves later). Append-only; run daily.
// Evaluate later with weather_forward_eval.ts as markets resolve.
//
// Usage: node scripts/campaign-D/fetch_weather_forward.mjs
// Out:   output/campaign-D/weather-forward-log.jsonl (append) + weather-geo.json (cache)

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const DIR = "output/campaign-D"; const LOG = `${DIR}/weather-forward-log.jsonl`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, t = 5) { for (let i = 0; i < t; i++) { try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(600 * (i + 1)); } } return null; }

const PAT = /(highest|lowest) temperature in (.+?) be (?:between )?(\d+)(?:-(\d+))?°(C|F)\s*(or higher|or above|or below|or lower)?/i;

// 1) collect active weather markets resolving in the next ~7 days
const seen = new Set(); const mkts = [];
for (let off = 0; off < 1500; off += 100) {
  const d = await getJson(`https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&offset=${off}&order=volume&ascending=false`);
  if (!Array.isArray(d) || d.length === 0) break;
  for (const m of d) { const q = m.question || ""; if (!PAT.test(q) || seen.has(m.id)) continue; seen.add(m.id); mkts.push(m); }
  await sleep(120);
}
console.error(`[forward] active weather markets found: ${mkts.length}`);

// 2) geocode cache
const geoFile = `${DIR}/weather-geo.json`;
const geo = existsSync(geoFile) ? JSON.parse(readFileSync(geoFile, "utf8")) : {};
async function geocode(city) { if (geo[city]) return geo[city]; const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`); const r = j?.results?.[0]; if (r) { geo[city] = { lat: r.latitude, lon: r.longitude }; writeFileSync(geoFile, JSON.stringify(geo, null, 1)); } await sleep(200); return geo[city]; }

// 3) ensemble forecast P(condition) for the target date
async function forecastP(lat, lon, targetISO, metric, unit, dir, v1, v2) {
  const today = new Date(); const tgt = new Date(targetISO + "T00:00:00Z");
  const days = Math.min(16, Math.max(1, Math.ceil((tgt - today) / 86400000) + 1));
  const daily = metric === "max" ? "temperature_2m_max" : "temperature_2m_min";
  const tu = unit === "F" ? "&temperature_unit=fahrenheit" : "";
  const j = await getJson(`https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&daily=${daily}&models=gfs_seamless&forecast_days=${days}&timezone=auto${tu}`);
  const dy = j?.daily; if (!dy?.time) return null;
  const idx = dy.time.indexOf(targetISO); if (idx < 0) return null;
  const members = Object.keys(dy).filter((k) => k.startsWith(daily));
  const vals = members.map((k) => dy[k][idx]).filter((x) => x != null).map((x) => Math.round(x));
  if (vals.length < 10) return null;
  let hit = 0; for (const t of vals) { if (v2 != null) { if (t >= v1 && t <= v2) hit++; } else if (dir === ">=") { if (t >= v1) hit++; } else if (dir === "<=") { if (t <= v1) hit++; } else { if (t === v1) hit++; } }
  return { p: hit / vals.length, members: vals.length };
}

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
let logged = 0;
for (const m of mkts) {
  const q = m.question || ""; const mt = PAT.exec(q); if (!mt) continue;
  const metric = /highest/i.test(mt[1]) ? "max" : "min"; const city = mt[2].trim().replace(/[?.]+$/, "");
  const v1 = +mt[3], v2 = mt[4] ? +mt[4] : null; const unit = mt[5].toUpperCase();
  const dir = v2 != null ? "range" : /higher|above/i.test(mt[6] || "") ? ">=" : /below|lower/i.test(mt[6] || "") ? "<=" : "exact";
  const g = await geocode(city); if (!g) continue;
  const targetISO = (m.endDate || "").slice(0, 10);
  const fp = await forecastP(g.lat, g.lon, targetISO, metric, unit, dir, v1, v2); if (!fp) continue;
  const bid = num(m.bestBid), ask = num(m.bestAsk);
  const pMkt = bid != null && ask != null ? (bid + ask) / 2 : num(m.lastTradePrice);
  appendFileSync(LOG, JSON.stringify({ logDate: targetISO, id: m.id, conditionId: m.conditionId, city, metric, unit, dir, v1, v2, targetISO, pModel: +fp.p.toFixed(3), members: fp.members, pMarket: pMkt, bestBid: bid, bestAsk: ask }) + "\n");
  logged++; await sleep(200);
}
console.error(`[forward] logged ${logged} markets -> ${LOG} (run DAILY; evaluate with weather_forward_eval.ts as they resolve)`);
