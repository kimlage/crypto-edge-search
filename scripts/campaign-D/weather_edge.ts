/**
 * Campaign-D — weather/Open-Meteo external-information edge, through the COMPLETE gauntlet.
 *
 * Look-ahead-free by construction: the "model" is CLIMATOLOGY from the 2015-2025 Open-Meteo archive
 * (same calendar date ±W, the market's metric/unit), and every market resolves in 2026 — so the model
 * uses only data prior to the event. Strategy: where |P_model - P_market(T-24h)| > band, trade toward
 * the model; hold to resolution. Routed through scripts/campaign-D/gauntlet.ts::runGauntlet.
 *
 * Right null: MODEL-SHUFFLE (assign each market a random OTHER market's P_model) family-wise MAX over
 * the band grid — does the model's per-market probability carry real info, or would any random
 * probability do as well? (plus the standard baselines incl. trading calibration WITHOUT the model).
 *
 * Run: npx tsx scripts/campaign-D/weather_edge.ts
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { runGauntlet, printGauntlet } from "./gauntlet.ts";

const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`;
const WINDOW = 3; // +/- days around the calendar date for climatology
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

const qfull = new Map<string, string>();
for (const l of readFileSync(`${DIR}/resolved-markets.jsonl`, "utf8").split("\n")) { if (!l.trim()) continue; const m = JSON.parse(l); qfull.set(m.id, m.question || ""); }
const geo = JSON.parse(readFileSync(`${DIR}/weather-geo.json`, "utf8"));
const climate = new Map<string, { time: string[]; tmax: number[]; tmin: number[] }>();
for (const f of readdirSync(`${DIR}/weather-climate`)) { const j = JSON.parse(readFileSync(`${DIR}/weather-climate/${f}`, "utf8")); climate.set(j.city, j); }
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
const tape = (id: string) => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };

const PAT = /(highest|lowest) temperature in (.+?) be (?:between )?(\d+)(?:-(\d+))?°(C|F)\s*(or higher|or above|or below|or lower)?/i;

type Mk = { id: string; endTs: number; winnerIndex: number; outcomes: string[] };
const markets: Mk[] = readFileSync(`${DIR}/weather-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

function climProb(city: string, monthDay: [number, number], metric: "max" | "min", unit: "C" | "F", dir: string, v1: number, v2: number | null): number | null {
  const c = climate.get(city); if (!c) return null;
  const arr = metric === "max" ? c.tmax : c.tmin;
  const vals: number[] = [];
  for (let i = 0; i < c.time.length; i++) {
    const d = c.time[i]; const mo = +d.slice(5, 7), da = +d.slice(8, 10);
    // within +/- WINDOW days of the target month-day (ignoring year)
    const tgt = monthDay[0] * 31 + monthDay[1], cur = mo * 31 + da;
    if (Math.abs(cur - tgt) > WINDOW) continue;
    let t = arr[i]; if (t == null) continue; if (unit === "F") t = t * 9 / 5 + 32;
    vals.push(Math.round(t));
  }
  if (vals.length < 20) return null;
  let hit = 0;
  for (const t of vals) {
    if (v2 != null) { if (t >= v1 && t <= v2) hit++; }
    else if (dir === ">=") { if (t >= v1) hit++; }
    else if (dir === "<=") { if (t <= v1) hit++; }
    else { if (t === v1) hit++; } // exact
  }
  return hit / vals.length;
}

// build the dataset: per market -> {P_model, p_mkt, resYes, endTs}
type Row = { pModel: number; pMkt: number; resYes: number; endTs: number };
const rows: Row[] = [];
let parsed = 0, withModel = 0, withPrice = 0;
for (const m of markets) {
  const q = qfull.get(m.id) || ""; const mt = PAT.exec(q); if (!mt) continue; parsed++;
  const metric = /highest/i.test(mt[1]) ? "max" : "min";
  const city = mt[2].trim().replace(/[?.]+$/, "");
  const v1 = +mt[3], v2 = mt[4] ? +mt[4] : null; const unit = mt[5].toUpperCase() as "C" | "F";
  const dir = v2 != null ? "range" : /higher|above/i.test(mt[6] || "") ? ">=" : /below|lower/i.test(mt[6] || "") ? "<=" : "exact";
  const d = new Date(m.endTs * 1000); const md: [number, number] = [d.getUTCMonth() + 1, d.getUTCDate()];
  const pModel = climProb(city, md, metric, unit, dir, v1, v2); if (pModel == null) continue; withModel++;
  if (!cached.has(m.id)) continue;
  const yesIdx = m.outcomes.indexOf("yes"); const lead = m.endTs - 86400;
  const yes = tape(m.id).filter((t: any) => t.oi === yesIdx && t.p > 0 && t.p < 1 && t.ts <= lead).sort((a: any, b: any) => a.ts - b.ts);
  if (!yes.length) continue; const pMkt = yes[yes.length - 1].p; withPrice++;
  rows.push({ pModel, pMkt, resYes: m.winnerIndex === yesIdx ? 1 : 0, endTs: m.endTs });
}
rows.sort((a, b) => a.endTs - b.endTs);
console.log(`\n=== WEATHER-EDGE (climatology vs market) | parsed=${parsed} withModel=${withModel} withPrice=${withPrice} usable=${rows.length} ===`);

// sanity: is the model itself calibrated/informative? (Brier model vs Brier market)
const brier = (p: (r: Row) => number) => mean(rows.map((r) => (p(r) - r.resYes) ** 2));
console.log(`Brier: model=${brier((r) => r.pModel).toFixed(4)} | market=${brier((r) => r.pMkt).toFixed(4)} (lower=better)`);

// cost: weather-realistic proportional half-spread (wide on longshots)
const hs = (p: number) => Math.max(0.02, 0.2 * Math.min(p, 1 - p));
const buyYes = (p: number, oc: number) => { const c = Math.min(0.999, p + hs(p)); return (oc - c) / c; };
const buyNo = (p: number, oc: number) => { const c = Math.min(0.999, 1 - p + hs(p)); return ((1 - oc) - c) / c; };

const BANDS = [0.03, 0.05, 0.07, 0.10, 0.15, 0.20];
const cfg = (band: number, model: (r: Row) => number, oc: (r: Row) => number) =>
  rows.map((r) => { const pm = model(r); if (pm - r.pMkt > band) return buyYes(r.pMkt, oc(r)); if (r.pMkt - pm > band) return buyNo(r.pMkt, oc(r)); return null; }).filter((x): x is number => x != null);

console.log("\nband  nTrades  meanRet  (trade toward climatology where |P_model-P_mkt|>band, net of weather spread)");
let best = { band: 0, mean: -Infinity, returns: [] as number[] };
for (const band of BANDS) { const rets = cfg(band, (r) => r.pModel, (r) => r.resYes); const mm = mean(rets); console.log(`${band.toFixed(2)}  ${String(rets.length).padStart(7)}  ${(mm >= 0 ? "+" : "") + mm.toFixed(4)}`); if (rets.length >= 30 && mm > best.mean) best = { band, mean: mm, returns: rets }; }
if (best.returns.length < 30) { console.log("\nToo few trades at any band — DEFERRED (insufficient model-vs-market disagreement)."); process.exit(0); }

// right null: MODEL-SHUFFLE family-wise MAX (random other market's P_model)
const rng = seeded(31337); const DRAWS = 1500; const nullMax: number[] = [];
for (let d = 0; d < DRAWS; d++) {
  const perm = rows.map((_, i) => i); for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const shuf = (r: Row, i: number) => rows[perm[i]].pModel;
  let mx = -Infinity;
  for (const band of BANDS) { const rets = rows.map((r, i) => { const pm = shuf(r, i); if (pm - r.pMkt > band) return buyYes(r.pMkt, r.resYes); if (r.pMkt - pm > band) return buyNo(r.pMkt, r.resYes); return null; }).filter((x): x is number => x != null); if (rets.length >= 30) mx = Math.max(mx, mean(rets)); }
  nullMax.push(mx);
}

// grid folds for CPCV + consume-once holdout (last 20% by date)
const FOLDS = 8; const folds = (rets: number[]) => { const per = Math.ceil(rets.length / FOLDS); return Array.from({ length: FOLDS }, (_, k) => rets.slice(k * per, (k + 1) * per)); };
const gridFolds = BANDS.map((b) => ({ id: `band-${b}`, folds: folds(cfg(b, (r) => r.pModel, (r) => r.resYes)) })).filter((g) => g.folds.every((f) => f.length > 0));
const cut = Math.floor(rows.length * 0.8);
const hoRows = rows.slice(cut);
const ho = hoRows.map((r) => { const pm = r.pModel; if (pm - r.pMkt > best.band) return buyYes(r.pMkt, r.resYes); if (r.pMkt - pm > best.band) return buyNo(r.pMkt, r.resYes); return null; }).filter((x): x is number => x != null);

// baselines: blind sides + "trade calibration WITHOUT the model" (bet toward 0.5 vs price, same band)
const blindYes = mean(rows.map((r) => buyYes(r.pMkt, r.resYes)));
const blindNo = mean(rows.map((r) => buyNo(r.pMkt, r.resYes)));
const calibNoModel = mean(rows.map((r) => { const pm = 0.5; if (pm - r.pMkt > best.band) return buyYes(r.pMkt, r.resYes); if (r.pMkt - pm > best.band) return buyNo(r.pMkt, r.resYes); return null as any; }).filter((x: any) => x != null));

const out = runGauntlet({
  name: `weather-edge climatology (n=${rows.length})`, returns: best.returns, honestN: BANDS.length,
  baselines: [{ name: "blindYES", mean: blindYes }, { name: "blindNO", mean: blindNo }, { name: "calib-no-model", mean: calibNoModel }],
  grid: gridFolds, surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: ho,
});
printGauntlet(out);
writeFileSync(`${DIR}/weather_edge.json`, JSON.stringify({ usable: rows.length, brier_model: brier((r) => r.pModel), brier_market: brier((r) => r.pMkt), best_band: best.band, verdict: out }, null, 2));
console.log(`\nwrote weather_edge.json`);
