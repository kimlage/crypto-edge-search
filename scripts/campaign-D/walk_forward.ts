/**
 * Campaign-D — WALK-FORWARD copy-trading persistence (closes the audit's "single split" gap).
 * Runs the wallet-label-shuffle surrogate + ROI-persistence + top-decile OOS lift on THREE disjoint
 * train/OOS windows. If skill does not persist in any window, the no-skill KILL is robust across time.
 *
 * Run: npx tsx scripts/campaign-D/walk_forward.ts   (needs copy-markets[-wfA/-wfB].jsonl + tapes)
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`; const H = 0.01;
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const trades = (id: string) => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };

function analyze(file: string, label: string) {
  if (!existsSync(file)) { console.log(`${label}: (missing ${file})`); return null; }
  const markets = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  type W = { tp: number; tv: number; tn: number; oos: { ret: number; day: number; onWin: boolean }[]; tw: number };
  const M = new Map<string, W>(); const g = (w: string) => { let x = M.get(w); if (!x) { x = { tp: 0, tv: 0, tn: 0, oos: [], tw: 0 }; M.set(w, x); } return x; };
  const cret = (s: string, p: number, win: number) => { if (s === "BUY") { const c = Math.min(0.999, p + H); return (win - c) / c; } const c = Math.min(0.999, 1 - p + H); return ((1 - win) - c) / c; };
  for (const m of markets) { if (!cached.has(m.id)) continue; for (const t of trades(m.id)) { if (!(t.p > 0 && t.p < 1) || !(t.sz > 0)) continue; const win = t.oi === m.winnerIndex ? 1 : 0; const onWin = (t.s === "BUY") === (t.oi === m.winnerIndex); const x = g(t.w); if (m.window === "train") { x.tp += t.s === "BUY" ? t.sz * (win - t.p) : t.sz * (t.p - win); x.tv += t.sz * t.p; x.tn++; if (onWin) x.tw++; } else x.oos.push({ ret: cret(t.s, t.p, win), day: Math.floor(t.ts / 86400), onWin }); } }
  const elig = [...M.entries()].filter(([, x]) => x.tn >= 15 && x.oos.length >= 3);
  if (elig.length < 40) { console.log(`${label}: too few eligible (${elig.length})`); return { label, eligible: elig.length, surrogate_p: null, roi_persist_r: null }; }
  const daily = (ws: string[]) => { const by = new Map<number, number[]>(); for (const w of ws) for (const c of M.get(w)!.oos) { let a = by.get(c.day); if (!a) { a = []; by.set(c.day, a); } a.push(c.ret); } return [...by.keys()].sort((a, b) => a - b).map((d) => mean(by.get(d)!)); };
  const metricFns: Record<string, (x: W) => number> = { pnl: (x) => x.tp, roi: (x) => x.tp / Math.max(1, x.tv) };
  const KS = [10, 25, 50, 100]; const grid: { m: string; k: number }[] = []; for (const m of ["pnl", "roi"]) for (const k of KS) grid.push({ m, k });
  const top = (m: string, k: number) => [...elig].sort((a, b) => metricFns[m](b[1]) - metricFns[m](a[1])).slice(0, k).map(([w]) => w);
  let best = -Infinity; for (const { m, k } of grid) { const s = daily(top(m, k)); if (s.length >= 10) best = Math.max(best, mean(s)); }
  const pool = elig.map(([w]) => w); const rng = seeded(424242); const pick = (k: number) => { const a = pool.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
  let ge = 0; for (let d = 0; d < 1500; d++) { let mx = -Infinity; for (const { k } of grid) { const s = daily(pick(k)); if (s.length >= 10) mx = Math.max(mx, mean(s)); } if (mx >= best) ge++; }
  const surrP = ge / 1500;
  const xs = elig.map(([, x]) => x.tp / Math.max(1, x.tv)), ys = elig.map(([, x]) => mean(x.oos.map((c) => c.ret)));
  const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } const r = sxy / Math.sqrt(Math.max(1e-12, sxx * syy));
  const byRoi = [...elig].sort((a, b) => (b[1].tp / Math.max(1, b[1].tv)) - (a[1].tp / Math.max(1, a[1].tv)));
  const kd = Math.max(1, Math.floor(elig.length / 10));
  const popPos = elig.filter(([, x]) => mean(x.oos.map((c) => c.ret)) > 0).length / elig.length;
  const topPos = byRoi.slice(0, kd).filter(([, x]) => mean(x.oos.map((c) => c.ret)) > 0).length / kd;
  return { label, eligible: elig.length, surrogate_p: +surrP.toFixed(3), roi_persist_r: +r.toFixed(3), topDecile_OOSpos_lift: +(topPos - popPos).toFixed(3) };
}

const splits = [
  analyze(`${DIR}/copy-markets-wfA.jsonl`, "WF-A 2025-06..08/08..10"),
  analyze(`${DIR}/copy-markets-wfC.jsonl`, "WF-C 2025-07..10/10..11"),
  analyze(`${DIR}/copy-markets-wfE.jsonl`, "WF-E 2025-09..12/12..01"),
  analyze(`${DIR}/copy-markets.jsonl`, "WF-mid 2025-10..12/2026-01..03"),
  analyze(`${DIR}/copy-markets-wfB.jsonl`, "WF-B 2026-02..04/04..06"),
].filter(Boolean);
// CR12 Stouffer meta: combine per-split surrogate p into one z (independence is approximate — disjoint OOS months)
const ps = (splits as any[]).map((s) => s.surrogate_p).filter((p) => p != null && p > 0 && p < 1);
if (ps.length >= 3) { const invPhi = (p: number) => { const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]; const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]; const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]; const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]; const pl = 0.02425; let q, r, x; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } else if (p <= 1 - pl) { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); } else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } return x; };
  const z = ps.reduce((s, p) => s + invPhi(p), 0) / Math.sqrt(ps.length); console.log(`\n[CR12 Stouffer meta] combined surrogate z=${z.toFixed(2)} across ${ps.length} disjoint-OOS windows (z<<1.64 => no aggregate skill-persistence signal)`); }
console.log("\n=== WALK-FORWARD copy-trading persistence (3 disjoint splits) ===");
console.log("split                          eligible  surrogate_p  ROI-persist_r  topDecile_OOSpos_lift");
for (const s of splits as any[]) console.log(s.label.padEnd(31), String(s.eligible).padStart(8), String(s.surrogate_p).padStart(12), String(s.roi_persist_r).padStart(14), String(s.topDecile_OOSpos_lift).padStart(20));
console.log("\n(surrogate_p > 0.05 in every split => skill-selection never beats random; KILL is robust across time)");
writeFileSync(`${DIR}/walk_forward.json`, JSON.stringify(splits, null, 2));
