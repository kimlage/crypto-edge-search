// Campaign-D — free Open-Meteo climatology for the weather-edge gauntlet test (NO look-ahead:
// climatology is built from prior years only). Geocodes the cities in the weather market set and
// pulls 2015-2025 daily max/min temps per city. All $0, no API key.
// Usage: node scripts/campaign-D/fetch_weather_climate.mjs
// Out:   output/campaign-D/weather-geo.json + weather-climate/<city>.json

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const DIR = "output/campaign-D"; const CDIR = `${DIR}/weather-climate`;
mkdirSync(CDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, t = 5) { for (let i = 0; i < t; i++) { try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); if (r.status === 429 || r.status >= 500) { await sleep(1000 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(700 * (i + 1)); } } return null; }

// distinct cities from the weather market questions (full text from snapshot)
const qfull = new Map();
for (const l of readFileSync(`${DIR}/resolved-markets.jsonl`, "utf8").split("\n")) { if (!l.trim()) continue; const m = JSON.parse(l); qfull.set(m.id, m.question || ""); }
const pat = /(highest|lowest) temperature in (.+?) be (?:between )?(\d+)(?:-(\d+))?°(C|F)/i;
const cities = new Set();
for (const l of readFileSync(`${DIR}/weather-markets.jsonl`, "utf8").split("\n")) { if (!l.trim()) continue; const r = JSON.parse(l); const q = qfull.get(r.id) || r.q; const mt = pat.exec(q); if (mt) cities.add(mt[2].trim().replace(/[?.]+$/, "")); }
console.error(`[climate] ${cities.size} distinct cities`);

// geocode (cache)
const geoFile = `${DIR}/weather-geo.json`;
const geo = existsSync(geoFile) ? JSON.parse(readFileSync(geoFile, "utf8")) : {};
for (const city of cities) {
  if (geo[city]) continue;
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`);
  const r = j?.results?.[0];
  if (r) { geo[city] = { lat: r.latitude, lon: r.longitude }; console.error(`  geocoded ${city} -> ${r.latitude},${r.longitude}`); }
  else console.error(`  !! could not geocode ${city}`);
  await sleep(250);
}
writeFileSync(geoFile, JSON.stringify(geo, null, 1));

// archive climatology per city (2015-2025 daily max/min, °C), cache
let n = 0;
for (const city of cities) {
  const cf = `${CDIR}/${city.replace(/[^a-z0-9]/gi, "_")}.json`;
  if (existsSync(cf)) { n++; continue; }
  const g = geo[city]; if (!g) continue;
  const j = await getJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${g.lat}&longitude=${g.lon}&start_date=2015-01-01&end_date=2025-12-31&daily=temperature_2m_max,temperature_2m_min&timezone=auto`);
  if (j?.daily?.time) { writeFileSync(cf, JSON.stringify({ city, lat: g.lat, lon: g.lon, time: j.daily.time, tmax: j.daily.temperature_2m_max, tmin: j.daily.temperature_2m_min })); n++; console.error(`  archived ${city} (${j.daily.time.length} days)`); }
  await sleep(300);
}
console.error(`[climate] DONE geo=${Object.keys(geo).length} archived=${n}/${cities.size}`);
