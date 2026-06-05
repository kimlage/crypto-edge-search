/**
 * Campaign-D — UNIFIED driver: run every real strategy through the single gauntlet.ts runGauntlet
 * with the FULL 8-gate chain (incl. Harvey-Liu haircut), a REALISTIC price-proportional cost model at
 * multiple levels, clean-binary-only calibration (de-contaminated), and the right null per claim.
 * Emits a uniform gate table + verdict per strategy + cost level. Addresses the audit's parity gaps:
 * bespoke->unified, missing haircut, flat-1c cost, negRisk contamination, no uniform binding-gate ledger.
 *
 * Run: npx tsx scripts/campaign-D/run_all.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { runGauntlet, printGauntlet } from "./gauntlet.ts";

const DIR = "output/campaign-D";
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// realistic cost: half-spread is price-proportional for longshots (audit: ~150% of a <=10c price),
// floored. level 'liquid'=1c flat, 'prop'=max(1c, 0.15*min(p,1-p)), 'wide'=max(3c, 0.25*min(p,1-p)).
function halfSpread(p: number, level: "flat1" | "prop" | "wide"): number {
  const m = Math.min(p, 1 - p);
  if (level === "flat1") return 0.01;
  if (level === "prop") return Math.max(0.01, 0.15 * m);
  return Math.max(0.03, 0.25 * m);
}
// EXPLICIT capital-lockup financing (audit gap): RF charged on the locked $1 notional over the hold.
// At the 24h decision lead the lock is ~1 day => ~1.4bps, immaterial vs the >=200bps spread; a multi-week
// carry hold scales to ~10-40bps, still spread-dominated. Charged on every bet's return.
const RF_PER_DAY = 0.05 / 365;
const HOLD_DAYS = 1;                 // 24h-lead decision; lock from entry to resolution
const FIN = RF_PER_DAY * HOLD_DAYS;  // financing fraction of notional

// ---------- CALIBRATION-FAMILY strategies (clean binaries only) ----------
type CRow = { resYes: number; p_24h: number | null; endTs: number; negRisk?: boolean };
const crows: CRow[] = readFileSync(`${DIR}/calibration.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cdata = crows.filter((r) => r.p_24h != null && r.p_24h! > 0.005 && r.p_24h! < 0.995 && r.negRisk !== true && Number.isFinite(r.endTs)).sort((a, b) => a.endTs - b.endTs);

type Dir = "favorite" | "longshot";
const BANDS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45];
function calRet(r: CRow, dir: Dir, band: number, outcomeYes: number, lvl: "flat1" | "prop" | "wide"): number | null {
  const p = r.p_24h!, h = halfSpread(p, lvl);
  let side: "YES" | "NO" | null = null;
  if (p > 0.5 + band) side = dir === "favorite" ? "YES" : "NO";
  else if (p < 0.5 - band) side = dir === "favorite" ? "NO" : "YES";
  else return null;
  if (side === "YES") { const c = Math.min(0.999, p + h); return (outcomeYes - c) / c - FIN; }
  const c = Math.min(0.999, 1 - p + h); return ((1 - outcomeYes) - c) / c - FIN;
}
function calibrationFamily(lvl: "flat1" | "prop" | "wide") {
  const grid: { dir: Dir; band: number }[] = [];
  for (const dir of ["favorite", "longshot"] as Dir[]) for (const band of BANDS) grid.push({ dir, band });
  const N = grid.length;
  // in-sample best by mean
  let best = { dir: "favorite" as Dir, band: 0, mean: -Infinity, returns: [] as number[] };
  const cfgReturns = (dir: Dir, band: number, oc: (r: CRow) => number) => cdata.map((r) => calRet(r, dir, band, oc(r), lvl)).filter((x): x is number => x != null);
  for (const { dir, band } of grid) { const rets = cfgReturns(dir, band, (r) => r.resYes); const m = mean(rets); if (rets.length >= 30 && m > best.mean) best = { dir, band, mean: m, returns: rets }; }
  // baselines
  const blindNo = cdata.map((r) => { const c = Math.min(0.999, 1 - r.p_24h! + halfSpread(r.p_24h!, lvl)); return ((1 - r.resYes) - c) / c; });
  const blindYes = cdata.map((r) => { const c = Math.min(0.999, r.p_24h! + halfSpread(r.p_24h!, lvl)); return (r.resYes - c) / c; });
  // calibrated-Bernoulli family-wise MAX null
  const rng = seeded(98765); const DRAWS = 1200; const nullMax: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    const synth = new Map<CRow, number>(); for (const r of cdata) synth.set(r, rng() < r.p_24h! ? 1 : 0);
    let mx = -Infinity; for (const { dir, band } of grid) { const rets = cfgReturns(dir, band, (r) => synth.get(r)!); if (rets.length >= 30) mx = Math.max(mx, mean(rets)); }
    nullMax.push(mx);
  }
  // grid folds for CPCV
  const FOLDS = 10; const folds = (rets: number[]) => { const per = Math.ceil(rets.length / FOLDS); return Array.from({ length: FOLDS }, (_, k) => rets.slice(k * per, (k + 1) * per)); };
  const gridFolds = grid.map(({ dir, band }) => ({ id: `${dir}-${band}`, folds: folds(cfgReturns(dir, band, (r) => r.resYes)) })).filter((g) => g.folds.every((f) => f.length > 0));
  // consume-once holdout (last 20%)
  const cut = Math.floor(cdata.length * 0.8);
  const ho = cdata.slice(cut).map((r) => calRet(r, best.dir, best.band, r.resYes, lvl)).filter((x): x is number => x != null);
  return runGauntlet({ name: `calibration-family (clean binary, cost=${lvl}, n=${cdata.length})`, returns: best.returns, honestN: N,
    baselines: [{ name: "blindNO", mean: mean(blindNo) }, { name: "blindYES", mean: mean(blindYes) }],
    grid: gridFolds, surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: ho });
}

// ---------- COPY-TRADING through the unified gauntlet ----------
function copyFamily(lvl: "flat1" | "prop" | "wide") {
  const markets = readFileSync(`${DIR}/copy-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const TCACHE = `${DIR}/trades-cache`; const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
  const trades = (id: string) => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };
  type W = { tp: number; tv: number; tn: number; oos: { ret: number; day: number }[] };
  const M = new Map<string, W>(); const g = (w: string) => { let x = M.get(w); if (!x) { x = { tp: 0, tv: 0, tn: 0, oos: [] }; M.set(w, x); } return x; };
  const copyRet = (s: string, p: number, win: number) => { if (s === "BUY") { const c = Math.min(0.999, p + halfSpread(p, lvl)); return (win - c) / c - FIN; } const c = Math.min(0.999, 1 - p + halfSpread(p, lvl)); return ((1 - win) - c) / c - FIN; };
  for (const m of markets) { if (!cached.has(m.id)) continue; for (const t of trades(m.id)) { if (!(t.p > 0 && t.p < 1) || !(t.sz > 0)) continue; const win = t.oi === m.winnerIndex ? 1 : 0; const x = g(t.w); if (m.window === "train") { x.tp += t.s === "BUY" ? t.sz * (win - t.p) : t.sz * (t.p - win); x.tv += t.sz * t.p; x.tn++; } else x.oos.push({ ret: copyRet(t.s, t.p, win), day: Math.floor(t.ts / 86400) }); } }
  const elig = [...M.entries()].filter(([, x]) => x.tn >= 15 && x.oos.length >= 3);
  const metricFns: Record<string, (x: W) => number> = { pnl: (x) => x.tp, roi: (x) => x.tp / Math.max(1, x.tv) };
  const KS = [10, 25, 50, 100]; const grid: { metric: string; k: number }[] = []; for (const metric of ["pnl", "roi"]) for (const k of KS) grid.push({ metric, k });
  const top = (metric: string, k: number) => [...elig].sort((a, b) => metricFns[metric](b[1]) - metricFns[metric](a[1])).slice(0, k).map(([w]) => w);
  const daily = (ws: string[]) => { const by = new Map<number, number[]>(); for (const w of ws) for (const c of M.get(w)!.oos) { let a = by.get(c.day); if (!a) { a = []; by.set(c.day, a); } a.push(c.ret); } return [...by.keys()].sort((a, b) => a - b).map((d) => mean(by.get(d)!)); };
  let best = { mean: -Infinity, series: [] as number[], wallets: [] as string[] };
  for (const { metric, k } of grid) { const s = daily(top(metric, k)); const mm = mean(s); if (s.length >= 10 && mm > best.mean) best = { mean: mm, series: s, wallets: top(metric, k) }; }
  // wallet-label-shuffle family-wise MAX null
  const pool = elig.map(([w]) => w); const rng = seeded(424242); const DRAWS = 1500; const nullMax: number[] = [];
  const pick = (k: number) => { const a = pool.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  for (let d = 0; d < DRAWS; d++) { let mx = -Infinity; for (const { k } of grid) { const s = daily(pick(k)); if (s.length >= 10) mx = Math.max(mx, mean(s)); } nullMax.push(mx); }
  const FOLDS = 8; const folds = (s: number[]) => { const per = Math.ceil(s.length / FOLDS); return Array.from({ length: FOLDS }, (_, k) => s.slice(k * per, (k + 1) * per)); };
  const gridFolds = grid.map(({ metric, k }) => ({ id: `${metric}-${k}`, folds: folds(daily(top(metric, k))) })).filter((g) => g.folds.every((f) => f.length > 0));
  const ho = best.series.slice(Math.floor(best.series.length / 2));
  return runGauntlet({ name: `copy-trading top-k (cost=${lvl}, eligible=${elig.length})`, returns: best.series, honestN: grid.length,
    baselines: [{ name: "copy-all-crowd", mean: mean(daily(pool)) }], grid: gridFolds,
    surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: ho });
}

const outs: any[] = [];
console.log("================ UNIFIED GAUNTLET — all strategies, all cost levels ================");
for (const lvl of ["flat1", "prop", "wide"] as const) {
  const a = calibrationFamily(lvl); printGauntlet(a); outs.push(a);
  const b = copyFamily(lvl); printGauntlet(b); outs.push(b);
}
writeFileSync(`${DIR}/unified_gauntlet.json`, JSON.stringify(outs, null, 2));
console.log(`\nwrote ${DIR}/unified_gauntlet.json — ${outs.length} (strategy x cost) runs`);
console.log("Verdicts:", outs.map((o) => `${o.name.split(" (")[0]}/${o.name.match(/cost=(\w+)/)?.[1]}=${o.verdict}`).join("  "));
