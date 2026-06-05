/**
 * Campaign-D — CR24/CR25/CR26: cross-category calibration coverage. Runs the favorite-longshot gauntlet
 * per category (sports/politics/geopolitics/entertainment) and reports the favorite-longshot slope, to
 * broaden the "where edge is NOT" map beyond crypto/weather. $0 (tape-derived prices + resolution).
 *
 * Run: npx tsx scripts/campaign-D/cross_category_calib.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { runGauntlet } from "./gauntlet.ts";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`;
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
const tape = (id: string) => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };

type Mk = { id: string; endTs: number; winnerIndex: number; outcomes: string[]; category: string; negRisk: boolean };
const markets: Mk[] = readFileSync(`${DIR}/category-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
type Row = { p: number; resYes: number; endTs: number };
const byCat: Record<string, Row[]> = {};
for (const m of markets) {
  if (!cached.has(m.id) || m.negRisk) continue; const yi = m.outcomes.indexOf("yes"); if (yi < 0) continue;
  const lead = m.endTs - 86400; const yes = tape(m.id).filter((t: any) => t.oi === yi && t.p > 0 && t.p < 1 && t.ts <= lead).sort((a: any, b: any) => a.ts - b.ts);
  if (!yes.length) continue; const p = yes[yes.length - 1].p; if (p <= 0.02 || p >= 0.98) continue;
  (byCat[m.category] ||= []).push({ p, resYes: m.winnerIndex === yi ? 1 : 0, endTs: m.endTs });
}

const hs = (p: number) => Math.max(0.02, 0.15 * Math.min(p, 1 - p));
const BANDS = [0, 0.1, 0.2, 0.3, 0.4];
function gauntletCat(data: Row[]) {
  data.sort((a, b) => a.endTs - b.endTs);
  const buy = (side: "Y" | "N", p: number, oc: number) => { if (side === "Y") { const c = Math.min(0.999, p + hs(p)); return (oc - c) / c; } const c = Math.min(0.999, 1 - p + hs(p)); return ((1 - oc) - c) / c; };
  const cfg = (dir: "fav" | "long", band: number, oc: (r: Row) => number) => data.map((r) => { if (r.p > 0.5 + band) return buy(dir === "fav" ? "Y" : "N", r.p, oc(r)); if (r.p < 0.5 - band) return buy(dir === "fav" ? "N" : "Y", r.p, oc(r)); return null; }).filter((x): x is number => x != null);
  const grid: { dir: "fav" | "long"; band: number }[] = []; for (const dir of ["fav", "long"] as const) for (const band of BANDS) grid.push({ dir, band });
  let best = { mean: -Infinity, returns: [] as number[] };
  for (const { dir, band } of grid) { const rr = cfg(dir, band, (r) => r.resYes); if (rr.length >= 30 && mean(rr) > best.mean) best = { mean: mean(rr), returns: rr }; }
  if (best.returns.length < 30) return { verdict: "DEFERRED", binding: "too-few", n: data.length };
  const rng = seeded(5); const nullMax: number[] = [];
  for (let d = 0; d < 1000; d++) { const synth = new Map<Row, number>(); for (const r of data) synth.set(r, rng() < r.p ? 1 : 0); let mx = -Infinity; for (const { dir, band } of grid) { const rr = cfg(dir, band, (r) => synth.get(r)!); if (rr.length >= 30) mx = Math.max(mx, mean(rr)); } nullMax.push(mx); }
  const folds = (rr: number[]) => { const per = Math.ceil(rr.length / 8); return Array.from({ length: 8 }, (_, k) => rr.slice(k * per, (k + 1) * per)); };
  const gf = grid.map(({ dir, band }) => ({ id: `${dir}-${band}`, folds: folds(cfg(dir, band, (r) => r.resYes)) })).filter((g) => g.folds.every((f) => f.length > 0));
  const cut = Math.floor(data.length * 0.8); const ho = data.slice(cut).map((r) => { /* re-derive best on holdout via same grid winner approx: use favorite band0 */ return null; }).filter((x) => x != null) as number[];
  const o = runGauntlet({ name: "cat", returns: best.returns, honestN: grid.length, baselines: [{ name: "blindNO", mean: mean(data.map((r) => buy("N", r.p, r.resYes))) }], grid: gf, surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: cfg("fav", 0, (r) => r.resYes).slice(cut) });
  return { verdict: o.verdict, binding: o.bindingGate, n: data.length };
}
// CR26: favorite-longshot slope = regress (resYes - p) on p; negative slope => longshot bias
function flSlope(data: Row[]) { const xs = data.map((r) => r.p), ys = data.map((r) => r.resYes - r.p); const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; } return sxx > 0 ? sxy / sxx : 0; }

console.log(`\n=== CROSS-CATEGORY calibration (favorite-longshot gauntlet per category) ===`);
console.log("category        n     verdict     binding          FL-slope (neg=longshot bias)");
const out: any = {};
for (const cat of Object.keys(byCat)) { const data = byCat[cat]; if (data.length < 30) continue; const g = gauntletCat(data); const slope = +flSlope(data).toFixed(3); out[cat] = { ...g, fl_slope: slope }; console.log(cat.padEnd(15), String(g.n).padStart(4), String(g.verdict).padEnd(11), String(g.binding).padEnd(16), String(slope).padStart(6)); }
writeFileSync(`${DIR}/cross_category_calib.json`, JSON.stringify(out, null, 2));
console.log(`\n=> verdict per category broadens the 'where edge is NOT' map; the FL-slope shows the bias direction.`);
