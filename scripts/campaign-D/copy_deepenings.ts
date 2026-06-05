/**
 * Campaign-D — copy-trading credibility deepenings (CR11/CR17/CR18/CR19/CR22). Re-runs the wallet-label-
 * shuffle surrogate + ROI-persistence on STRATIFIED subpopulations: if "no skill persistence" holds in
 * every stratum (human-like vs bot-like activity, volume terciles, sans-insiders, new-wallet-OOS cohort),
 * the KILL is not a confound of coordinated bots / capacity / selection. Each stratum's verdict is the
 * surrogate p (a RELATIVE top-vs-random comparison within that stratum).
 *
 * Run: npx tsx scripts/campaign-D/copy_deepenings.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`; const H = 0.01;
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const tape = (id: string) => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };

type Mk = { id: string; window: "train" | "oos"; winnerIndex: number };
const markets: Mk[] = readFileSync(`${DIR}/copy-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
type W = { tp: number; tv: number; tn: number; oos: { ret: number; day: number; onWin: boolean }[]; mkPnl: Map<string, number>; firstOosOnly: boolean; anyTrain: boolean };
const M = new Map<string, W>(); const g = (w: string) => { let x = M.get(w); if (!x) { x = { tp: 0, tv: 0, tn: 0, oos: [], mkPnl: new Map(), firstOosOnly: false, anyTrain: false }; M.set(w, x); } return x; };
const cret = (s: string, p: number, win: number) => { if (s === "BUY") { const c = Math.min(0.999, p + H); return (win - c) / c; } const c = Math.min(0.999, 1 - p + H); return ((1 - win) - c) / c; };
for (const m of markets) { if (!cached.has(m.id)) continue; for (const t of tape(m.id)) { if (!(t.p > 0 && t.p < 1) || !(t.sz > 0)) continue; const win = t.oi === m.winnerIndex ? 1 : 0; const onWin = (t.s === "BUY") === (t.oi === m.winnerIndex); const pnl = t.s === "BUY" ? t.sz * (win - t.p) : t.sz * (t.p - win); const x = g(t.w); if (m.window === "train") { x.tp += pnl; x.tv += t.sz * t.p; x.tn++; x.anyTrain = true; } else { x.oos.push({ ret: cret(t.s, t.p, win), day: Math.floor(t.ts / 86400), onWin }); x.mkPnl.set(m.id, (x.mkPnl.get(m.id) || 0) + pnl); } } }

const elig = [...M.entries()].filter(([, x]) => x.tn >= 15 && x.oos.length >= 3);
// surrogate p + ROI-persistence on an eligible subset
function evalSubset(sub: [string, W][]) {
  if (sub.length < 40) return { n: sub.length, p: null as number | null, r: null as number | null };
  const daily = (ws: string[]) => { const by = new Map<number, number[]>(); for (const w of ws) for (const c of M.get(w)!.oos) { let a = by.get(c.day); if (!a) { a = []; by.set(c.day, a); } a.push(c.ret); } return [...by.keys()].sort((a, b) => a - b).map((d) => mean(by.get(d)!)); };
  const mf: Record<string, (x: W) => number> = { pnl: (x) => x.tp, roi: (x) => x.tp / Math.max(1, x.tv) };
  const KS = [10, 25, 50, 100].filter((k) => k <= sub.length); const grid: { m: string; k: number }[] = []; for (const mm of ["pnl", "roi"]) for (const k of KS) grid.push({ m: mm, k });
  const top = (mm: string, k: number) => [...sub].sort((a, b) => mf[mm](b[1]) - mf[mm](a[1])).slice(0, k).map(([w]) => w);
  let best = -Infinity; for (const { m: mm, k } of grid) { const s = daily(top(mm, k)); if (s.length >= 10) best = Math.max(best, mean(s)); }
  const pool = sub.map(([w]) => w); const rng = seeded(424242); const pick = (k: number) => { const a = pool.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  let ge = 0; for (let d = 0; d < 1200; d++) { let mx = -Infinity; for (const { k } of grid) { const s = daily(pick(k)); if (s.length >= 10) mx = Math.max(mx, mean(s)); } if (mx >= best) ge++; }
  const xs = sub.map(([, x]) => x.tp / Math.max(1, x.tv)), ys = sub.map(([, x]) => mean(x.oos.map((c) => c.ret)));
  const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { n: sub.length, p: +(ge / 1200).toFixed(3), r: +(sxy / Math.sqrt(Math.max(1e-12, sxx * syy))).toFixed(3) };
}

// strata
const volT = [...elig].map(([w, x]) => [w, x, x.tv] as [string, W, number]).sort((a, b) => a[2] - b[2]);
const tercile = (q0: number, q1: number) => volT.slice(Math.floor(volT.length * q0), Math.floor(volT.length * q1)).map(([w, x]) => [w, x] as [string, W]);
const concentration = (x: W) => { const tot = [...x.mkPnl.values()].reduce((a, b) => a + Math.abs(b), 0); const mx = Math.max(0, ...[...x.mkPnl.values()].map(Math.abs)); return tot > 0 ? mx / tot : 0; };

const strata: Record<string, [string, W][]> = {
  "all-eligible (baseline)": elig,
  "CR17 human-like (15-50 train trades)": elig.filter(([, x]) => x.tn <= 50),
  "CR17 bot-like (>100 train trades)": elig.filter(([, x]) => x.tn > 100),
  "CR22 low-volume tercile": tercile(0, 1 / 3),
  "CR22 high-volume tercile": tercile(2 / 3, 1),
  "CR19 sans-insiders (OOS concentration<0.5)": elig.filter(([, x]) => concentration(x) < 0.5),
  "CR19 insider-like (concentration>=0.5)": elig.filter(([, x]) => concentration(x) >= 0.5),
};
console.log(`\n=== COPY-TRADING stratified surrogate sweep | eligible=${elig.length} ===`);
console.log("stratum                                       n     surrogate_p   ROI-persist_r");
const out: any = {};
for (const [name, sub] of Object.entries(strata)) { const e = evalSubset(sub); out[name] = e; console.log(name.padEnd(45), String(e.n).padStart(5), String(e.p).padStart(12), String(e.r).padStart(13)); }

// CR18 new-wallet-OOS cohort: wallets with NO train history, split OOS in half by day, rank on first half, test second half
const newW = [...M.entries()].filter(([, x]) => !x.anyTrain && x.oos.length >= 6);
if (newW.length >= 40) {
  const dthr = (() => { const days = newW.flatMap(([, x]) => x.oos.map((c) => c.day)).sort((a, b) => a - b); return days[Math.floor(days.length / 2)]; })();
  const split = newW.map(([w, x]) => { const h1 = x.oos.filter((c) => c.day <= dthr).map((c) => c.ret); const h2 = x.oos.filter((c) => c.day > dthr).map((c) => c.ret); return { w, r1: mean(h1), r2: mean(h2), n1: h1.length, n2: h2.length }; }).filter((s) => s.n1 >= 2 && s.n2 >= 2);
  const xs = split.map((s) => s.r1), ys = split.map((s) => s.r2); const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const r = sxy / Math.sqrt(Math.max(1e-12, sxx * syy));
  out["CR18 new-wallet OOS-half1->half2 persistence"] = { n: split.length, r: +r.toFixed(3) };
  console.log(`\nCR18 new-wallet (no-train, selection-bias-free) OOS half1->half2 return-persistence r=${r.toFixed(3)} (n=${split.length}) [~0 => no persistence]`);
}
writeFileSync(`${DIR}/copy_deepenings.json`, JSON.stringify(out, null, 2));
console.log(`\n=> If surrogate_p > 0.05 in EVERY stratum and r ~ 0, the no-persistence KILL is robust across subpopulations.`);
