/**
 * Campaign-D — evaluate the FORWARD weather-forecast log as markets resolve (the live lead).
 * Joins each logged {pModel (ensemble forecast), pMarket (price at log time)} to the market's RESOLUTION
 * (fetched fresh), and scores the pre-registered strategy (trade toward the forecast where |pModel-pMkt|
 * > band, hold to resolution, net of weather spread) through the COMPLETE runGauntlet. Pre-registration:
 * the forecast + price were frozen BEFORE resolution => honest forward OOS, the strongest credibility.
 *
 * Run: npx tsx scripts/campaign-D/weather_forward_eval.ts   (re-run as more markets resolve)
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { runGauntlet, printGauntlet } from "./gauntlet.ts";
const DIR = "output/campaign-D"; const LOG = `${DIR}/weather-forward-log.jsonl`;
const RESCACHE = `${DIR}/weather-forward-resolution.json`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) campaign-D-research";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
async function getJson(url: string, t = 4) { for (let i = 0; i < t; i++) { try { const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } }); if (r.status === 429 || r.status >= 500) { await sleep(700 * (i + 1)); continue; } if (!r.ok) return null; return await r.json(); } catch { await sleep(500 * (i + 1)); } } return null; }

type LogRow = { id: string; city: string; dir: string; v1: number; pModel: number; pMarket: number | null; targetISO: string };
const rows: LogRow[] = readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
// dedupe by id (keep the earliest log = most pre-resolution)
const byId = new Map<string, LogRow>(); for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
const log = [...byId.values()].filter((r) => r.pMarket != null && r.pMarket > 0.005 && r.pMarket < 0.995);

// resolution cache (fetch fresh for not-yet-known ids)
const resol: Record<string, number | null> = existsSync(RESCACHE) ? JSON.parse(readFileSync(RESCACHE, "utf8")) : {};
let fetched = 0;
for (const r of log) {
  if (resol[r.id] !== undefined && resol[r.id] !== null) continue;
  const j = await getJson(`https://gamma-api.polymarket.com/markets/${r.id}`);
  const m = Array.isArray(j) ? j[0] : j;
  if (m?.closed === true && m?.outcomePrices) { const ops = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; const outs = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes; const yi = outs.map((o: string) => o.toLowerCase()).indexOf("yes"); const py = Math.round(Number(ops[yi])), pn = Math.round(Number(ops[1 - yi])); if ((py === 1 && pn === 0) || (py === 0 && pn === 1)) resol[r.id] = py; else resol[r.id] = null; }
  else resol[r.id] = null;
  fetched++; await sleep(120);
}
writeFileSync(RESCACHE, JSON.stringify(resol));
const resolved = log.filter((r) => resol[r.id] === 0 || resol[r.id] === 1).map((r) => ({ ...r, resYes: resol[r.id] as number }));
console.log(`\n=== FORWARD weather-forecast eval | logged=${log.length} resolved=${resolved.length} (fetched ${fetched} this run) ===`);
if (resolved.length < 20) { console.log(`Only ${resolved.length} resolved — forward test still accruing. Re-run as markets settle (verdict needs >=~40 for power).`); process.exit(0); }

// pre-registered strategy: trade toward forecast where |pModel - pMkt| > band; weather spread; hold to resolution
const hs = (p: number) => Math.max(0.02, 0.2 * Math.min(p, 1 - p));
const buyYes = (p: number, oc: number) => { const c = Math.min(0.999, p + hs(p)); return (oc - c) / c; };
const buyNo = (p: number, oc: number) => { const c = Math.min(0.999, 1 - p + hs(p)); return ((1 - oc) - c) / c; };
const BANDS = [0.05, 0.10, 0.15, 0.20];
const cfg = (band: number, oc: (r: any) => number) => resolved.map((r) => { if (r.pModel - r.pMarket! > band) return buyYes(r.pMarket!, oc(r)); if (r.pMarket! - r.pModel > band) return buyNo(r.pMarket!, oc(r)); return null; }).filter((x): x is number => x != null);
console.log(`Brier: forecast=${mean(resolved.map((r) => (r.pModel - r.resYes) ** 2)).toFixed(4)} market=${mean(resolved.map((r) => (r.pMarket! - r.resYes) ** 2)).toFixed(4)} (lower=better)`);
let best = { band: 0, mean: -Infinity, returns: [] as number[] };
for (const b of BANDS) { const rr = cfg(b, (r) => r.resYes); if (rr.length >= 15 && mean(rr) > best.mean) best = { band: b, mean: mean(rr), returns: rr }; }
if (best.returns.length < 15) { console.log("too few model-vs-market disagreements yet"); process.exit(0); }
// calibrated-Bernoulli null
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rng = seeded(77); const nullMax: number[] = [];
for (let d = 0; d < 1500; d++) { const synth = new Map<any, number>(); for (const r of resolved) synth.set(r, rng() < r.pMarket! ? 1 : 0); let mx = -Infinity; for (const b of BANDS) { const rr = cfg(b, (r) => synth.get(r)!); if (rr.length >= 15) mx = Math.max(mx, mean(rr)); } nullMax.push(mx); }
const cut = Math.floor(resolved.length * 0.7); const ho = cfg(best.band, (r) => r.resYes).slice(cut);
const out = runGauntlet({ name: `weather FORWARD forecast (resolved=${resolved.length})`, returns: best.returns, honestN: BANDS.length,
  baselines: [{ name: "blindNO", mean: mean(resolved.map((r) => buyNo(r.pMarket!, r.resYes))) }], surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: ho });
printGauntlet(out);
writeFileSync(`${DIR}/weather_forward_eval.json`, JSON.stringify({ logged: log.length, resolved: resolved.length, verdict: out }, null, 2));
