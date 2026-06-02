/**
 * D7-CME: isolate whether the path-dependent exit (take-profit AT the fill level) manufactures the
 * Sharpe, vs a genuine directional gap-fill edge.
 *
 * Compare 4 variants on the SAME entries (best config: minGap 2%, maxGap 4%, lag 3h):
 *   A) toward-fill + take-profit-at-fill + week-end exit (the gauntlet "best")
 *   B) toward-fill + FIXED horizon (no take-profit; exit at week-end close) -> pure directional
 *   C) RANDOM direction + take-profit-at-fill (same |dist| target, random sign) -> exit-mech only
 *   D) toward-fill but target = a RANDOM level at same |dist| (direction-preserving surrogate)
 *
 * If A >> B, the edge is in the EXIT, not the direction. If C ~ A, the exit harvests diffusion
 * regardless of the real gap. If A >> D, the SPECIFIC friClose level matters (true magnet).
 */
import { loadBars, buildWeekends, barAtOrBefore, type Bar, type Weekend } from "./d7cme_probe.ts";

const HOUR = 3600 * 1000;
const COST = 0.0004;
const ANN = Math.sqrt(52);
function mean(a: number[]) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a: number[]) { const n = a.length; if (n < 2) return 0; const m = mean(a); return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))); }
function annSh(a: number[]) { const s = std(a); return s > 1e-12 ? (mean(a) / s) * ANN : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function idxAtOrAfter(bars: Bar[], e: number) { let lo = 0, hi = bars.length - 1, ans = bars.length; while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t >= e) { ans = m; hi = m - 1; } else lo = m + 1; } return ans; }

function simTP(bars: Bar[], entryEpoch: number, entryPrice: number, target: number, weekEnd: number, isLong: boolean, takeProfit: boolean): number {
  const startI = idxAtOrAfter(bars, entryEpoch);
  let exitPrice = entryPrice, exited = false;
  if (takeProfit) {
    for (let i = startI; i < bars.length && bars[i].t <= weekEnd; i++) {
      const b = bars[i];
      if (isLong) { if (b.h >= target) { exitPrice = target; exited = true; break; } }
      else { if (b.l <= target) { exitPrice = target; exited = true; break; } }
    }
  }
  if (!exited) { const eb = barAtOrBefore(bars, weekEnd); exitPrice = eb ? eb.c : entryPrice; }
  const g = isLong ? Math.log(exitPrice / entryPrice) : Math.log(entryPrice / exitPrice);
  return g - 2 * COST;
}

const bars = loadBars();
const weekends = buildWeekends(bars);
const cfg = { minGapPct: 0.02, maxGapPct: 0.04, lagHours: 3 };

function entriesOf(w: Weekend) {
  const ag = Math.abs(w.gapPct);
  if (ag < cfg.minGapPct || ag > cfg.maxGapPct) return null;
  const eb = barAtOrBefore(bars, w.sunOpenEpoch + cfg.lagHours * HOUR);
  if (!eb) return null;
  return { entryEpoch: w.sunOpenEpoch + cfg.lagHours * HOUR, entryPrice: eb.c };
}

// A) toward-fill + TP
const A: number[] = [];
for (const w of weekends) { const e = entriesOf(w); if (!e) { A.push(0); continue; } const isLong = e.entryPrice < w.friClose; A.push(simTP(bars, e.entryEpoch, e.entryPrice, w.friClose, w.weekEndEpoch, isLong, true)); }
// B) toward-fill + fixed horizon (no TP)
const B: number[] = [];
for (const w of weekends) { const e = entriesOf(w); if (!e) { B.push(0); continue; } const isLong = e.entryPrice < w.friClose; B.push(simTP(bars, e.entryEpoch, e.entryPrice, w.friClose, w.weekEndEpoch, isLong, false)); }
// C) random direction + TP (distribution)
const cShs: number[] = [];
for (let s = 0; s < 500; s++) { const rng = mkRng(31 + s * 7919); const r: number[] = []; for (const w of weekends) { const e = entriesOf(w); if (!e) { r.push(0); continue; } const dist = Math.abs(w.gapPct); const up = rng() < 0.5; const target = e.entryPrice * (up ? 1 + dist : 1 - dist); r.push(simTP(bars, e.entryEpoch, e.entryPrice, target, w.weekEndEpoch, up, true)); } cShs.push(annSh(r)); }
cShs.sort((a, b) => a - b);
// D) toward-fill direction but random target level at same |dist| (direction-preserving surrogate)
const dShs: number[] = [];
for (let s = 0; s < 500; s++) { const rng = mkRng(53 + s * 7919); const r: number[] = []; for (const w of weekends) { const e = entriesOf(w); if (!e) { r.push(0); continue; } const isLong = e.entryPrice < w.friClose; const dist = Math.abs(w.gapPct); const target = isLong ? e.entryPrice * (1 + dist) : e.entryPrice * (1 - dist); r.push(simTP(bars, e.entryEpoch, e.entryPrice, target, w.weekEndEpoch, isLong, true)); } dShs.push(annSh(r)); }
// D is deterministic given direction (target = friClose by construction when isLong matches gap)
// Actually D == A because target at same |dist| in fill direction == friClose. So compute D as a
// jittered level: random dist near the true |gap| (±50%) keeping direction toward fill.
const dShs2: number[] = [];
for (let s = 0; s < 500; s++) { const rng = mkRng(91 + s * 7919); const r: number[] = []; for (const w of weekends) { const e = entriesOf(w); if (!e) { r.push(0); continue; } const isLong = e.entryPrice < w.friClose; const dist = Math.abs(w.gapPct) * (0.5 + rng()); const target = isLong ? e.entryPrice * (1 + dist) : e.entryPrice * (1 - dist); r.push(simTP(bars, e.entryEpoch, e.entryPrice, target, w.weekEndEpoch, isLong, true)); } dShs2.push(annSh(r)); }
dShs2.sort((a, b) => a - b);

const shA = annSh(A), shB = annSh(B);
console.log(`A) toward-fill + take-profit:     annSh=${shA.toFixed(3)} meanRet=${(mean(A) * 1e4).toFixed(2)}bps`);
console.log(`B) toward-fill + FIXED horizon:   annSh=${shB.toFixed(3)} meanRet=${(mean(B) * 1e4).toFixed(2)}bps  <- pure direction`);
const pC = (cShs.filter((x) => x >= shA).length + 1) / (cShs.length + 1);
console.log(`C) RANDOM-dir + take-profit:      mean=${mean(cShs).toFixed(3)} p95=${cShs[Math.floor(cShs.length * 0.95)].toFixed(3)} p(C>=A)=${pC.toFixed(4)}  <- exit-mech only`);
const pD = (dShs2.filter((x) => x >= shA).length + 1) / (dShs2.length + 1);
console.log(`D) toward-fill + JITTERED level:  mean=${mean(dShs2).toFixed(3)} p95=${dShs2[Math.floor(dShs2.length * 0.95)].toFixed(3)} p(D>=A)=${pD.toFixed(4)}  <- is the EXACT friClose special?`);
console.log(`\nInterpretation: A-B gap = exit-mechanics contribution; if C~A the TP harvests diffusion w/o real gap; if D~A the exact level isn't special.`);
