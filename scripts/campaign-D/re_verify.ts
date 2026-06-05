/**
 * Campaign-D — committed runners for the $0-testable reverse-engineering mechanisms that were NOT
 * already covered by run_all/arb_baskets/verify_re22/mm (closes the audit's "agent-claimed" gap with
 * reproducible verdicts). Routes each through the unified gauntlet (gauntlet.ts).
 *
 *   RE10 — template base-rate estimator (the "Claude probability brain" forecasting family): does a
 *          causal per-template historical resolution rate beat the market mid out-of-sample?
 *   RE13 — first-print staleness / price-path momentum: does the early->late price drift predict
 *          resolution beyond the late price itself?
 *
 * Run: npx tsx scripts/campaign-D/re_verify.ts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { runGauntlet, printGauntlet } from "./gauntlet.ts";

const DIR = "output/campaign-D"; const H = 0.02;
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// id -> slug + startTs from the snapshot
const meta = new Map<string, { slug: string }>();
for (const l of readFileSync(`${DIR}/resolved-markets.jsonl`, "utf8").split("\n")) { if (!l.trim()) continue; const m = JSON.parse(l); meta.set(m.id, { slug: m.slug || "" }); }
const stemOf = (slug: string) => slug.replace(/-\d{4}-\d{2}-\d{2}.*$/, "").replace(/(-\d+)+$/, "").replace(/-\d{4}$/, "");

type Row = { id: string; p_24h: number | null; resYes: number; endTs: number; negRisk?: boolean };
const cal: Row[] = readFileSync(`${DIR}/calibration.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  .filter((r: Row) => r.p_24h != null && r.p_24h > 0.02 && r.p_24h < 0.98 && r.negRisk !== true)
  .sort((a: Row, b: Row) => a.endTs - b.endTs);

const buyYes = (p: number, oc: number) => { const c = Math.min(0.999, p + H); return (oc - c) / c; };
const buyNo = (p: number, oc: number) => { const c = Math.min(0.999, 1 - p + H); return ((1 - oc) - c) / c; };

// ---------- RE10: causal template base-rate estimator ----------
function re10() {
  const MINPRIOR = 20; const BANDS = [0.05, 0.10, 0.15, 0.20, 0.25];
  const histByStem = new Map<string, number[]>(); // resolutions of earlier markets in stem
  const rowsWithStem = cal.map((r) => ({ ...r, stem: stemOf(meta.get(r.id)?.slug || "") }));
  // build causal base-rate as we sweep chronologically
  const baseRate = new Map<string, number>(); // current causal estimate per market id
  for (const r of rowsWithStem) {
    const h = histByStem.get(r.stem) || [];
    baseRate.set(r.id, h.length >= MINPRIOR ? h.reduce((a, b) => a + b, 0) / h.length : NaN);
    histByStem.set(r.stem, [...h, r.resYes]);
  }
  const cfg = (band: number, oc: (r: any) => number) => rowsWithStem.map((r) => { const br = baseRate.get(r.id)!; if (!Number.isFinite(br)) return null; const p = r.p_24h!; if (br - p > band) return buyYes(p, oc(r)); if (p - br > band) return buyNo(p, oc(r)); return null; }).filter((x): x is number => x != null);
  let best = { band: 0, mean: -Infinity, returns: [] as number[] };
  for (const band of BANDS) { const rets = cfg(band, (r) => r.resYes); if (rets.length >= 30 && mean(rets) > best.mean) best = { band, mean: mean(rets), returns: rets }; }
  if (best.returns.length < 30) return runGauntlet({ name: "RE10 template base-rate (forecasting)", returns: [0], honestN: BANDS.length, baselines: [], deferredReason: "too few markets with >=20 causal stem-priors (templates and tradeable band are nearly disjoint)" });
  // calibrated-Bernoulli family-wise MAX null
  const rng = seeded(11); const nullMax: number[] = [];
  for (let d = 0; d < 1000; d++) { const synth = new Map<string, number>(); for (const r of rowsWithStem) synth.set(r.id, rng() < r.p_24h! ? 1 : 0); let mx = -Infinity; for (const band of BANDS) { const rets = cfg(band, (r) => synth.get(r.id)!); if (rets.length >= 30) mx = Math.max(mx, mean(rets)); } nullMax.push(mx); }
  const cut = Math.floor(rowsWithStem.length * 0.8); const ho = cfg(best.band, (r) => r.resYes); // already chronological; holdout = last 20% of trades
  const hoRets = ho.slice(Math.floor(ho.length * 0.8));
  return runGauntlet({ name: "RE10 template base-rate (forecasting)", returns: best.returns, honestN: BANDS.length,
    baselines: [{ name: "blindYES", mean: mean(rowsWithStem.map((r) => buyYes(r.p_24h!, r.resYes))) }, { name: "blindNO", mean: mean(rowsWithStem.map((r) => buyNo(r.p_24h!, r.resYes))) }],
    surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: hoRets, grid: undefined });
}

// ---------- RE13: first-print staleness / price-path momentum ----------
function re13() {
  const TCACHE = `${DIR}/trades-cache`; const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
  // attach p0 (first YES trade) per calibration market
  const mkMeta = new Map<string, { yi: number; endTs: number }>();
  for (const f of ["copy-markets.jsonl", "calib-markets.jsonl"]) { if (!existsSync(`${DIR}/${f}`)) continue; for (const l of readFileSync(`${DIR}/${f}`, "utf8").split("\n")) { if (!l.trim()) continue; const m = JSON.parse(l); mkMeta.set(m.id, { yi: m.outcomes.indexOf("yes"), endTs: m.endTs }); } }
  const rows: { p0: number; pK: number; oc: number }[] = [];
  for (const r of cal) {
    if (!cached.has(r.id)) continue; const mm = mkMeta.get(r.id); if (!mm) continue;
    let tr: any[]; try { tr = JSON.parse(readFileSync(`${TCACHE}/${r.id}.json`, "utf8")); } catch { continue; }
    const yes = tr.filter((t) => t.oi === mm.yi && t.p > 0 && t.p < 1).sort((a, b) => a.ts - b.ts);
    if (yes.length < 5) continue; const p0 = yes[0].p, pK = r.p_24h!;
    if (Math.abs(pK - p0) < 0.02) continue; // need a drift to trade
    rows.push({ p0, pK, oc: r.resYes });
  }
  if (rows.length < 30) return runGauntlet({ name: "RE13 staleness/price-path momentum", returns: [0], honestN: 2, baselines: [], deferredReason: "too few markets with a tradeable early->late drift + tape" });
  // strategy: bet toward the drift direction at pK, held to resolution
  const ret = rows.map((r) => (r.pK > r.p0 ? buyYes(r.pK, r.oc) : buyNo(r.pK, r.oc)));
  // right null: random drift SIGN (shuffle which side momentum points), family-wise over {momentum, anti-momentum}
  const rng = seeded(7); const nullMax: number[] = [];
  for (let d = 0; d < 1500; d++) { let mMom = 0, mAnti = 0; const a: number[] = [], b: number[] = []; for (const r of rows) { const up = rng() < 0.5; a.push(up ? buyYes(r.pK, r.oc) : buyNo(r.pK, r.oc)); b.push(up ? buyNo(r.pK, r.oc) : buyYes(r.pK, r.oc)); } nullMax.push(Math.max(mean(a), mean(b))); }
  const ho = ret.slice(Math.floor(ret.length * 0.8));
  const anti = rows.map((r) => (r.pK > r.p0 ? buyNo(r.pK, r.oc) : buyYes(r.pK, r.oc)));
  return runGauntlet({ name: "RE13 staleness/price-path momentum", returns: ret, honestN: 2,
    baselines: [{ name: "anti-momentum", mean: mean(anti) }, { name: "blindYES@pK", mean: mean(rows.map((r) => buyYes(r.pK, r.oc))) }],
    surrogate: { real: mean(ret), nullMaxes: nullMax }, holdoutReturns: ho });
}

const outs = [re10(), re13()];
for (const o of outs) printGauntlet(o);
writeFileSync(`${DIR}/re_verify.json`, JSON.stringify(outs, null, 2));
console.log("\nwrote re_verify.json");
