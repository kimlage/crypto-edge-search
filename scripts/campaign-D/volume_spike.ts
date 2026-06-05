/**
 * Campaign-D — "volume-spike exit" signal through the COMPLETE gauntlet (the $14,300-article claim:
 * "volume tripling in 10min = smart money leaving"). Informational core: does a 3x volume spike predict
 * the NEXT 10-min YES-price move (fade=mean-reversion or momentum=continuation)?
 *
 * From cached tapes (copy+weather+calib markets): 10-min buckets of (volume, YES price). At a spike
 * bucket, take a directional position for the next bucket; return = position*(priceNext-priceNow) - cost.
 * honest N = thresholds {2,3,5}x x {fade,momentum}. Right null: TIME-SHUFFLE (same rule at RANDOM buckets).
 * Reports GROSS (cost=0, the informational ceiling) and NET of an intraday round-trip spread.
 *
 * NOTE: a tradeable intraday round-trip needs the point-in-time L2 book for honest fills — that part is
 * DEFERRED; this tests the informational signal (does the spike predict the move?) which is $0-decidable.
 *
 * Run: npx tsx scripts/campaign-D/volume_spike.ts [roundTripCost=0.02]
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { runGauntlet, printGauntlet } from "./gauntlet.ts";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`;
const COST = Number(process.argv[2] ?? 0.02);
const BUCKET = 600; // 10 min
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// market index: id -> yesIdx
const yesIdx = new Map<string, number>();
for (const f of ["copy-markets.jsonl", "weather-markets.jsonl", "calib-markets.jsonl"]) {
  if (!existsSync(`${DIR}/${f}`)) continue;
  for (const l of readFileSync(`${DIR}/${f}`, "utf8").split("\n")) { if (!l.trim()) continue; const m = JSON.parse(l); if (!yesIdx.has(m.id)) yesIdx.set(m.id, (m.outcomes || []).indexOf("yes")); }
}
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));

// per market: build 10-min buckets {vol, yesPrice@end}; collect (spikeFlag at thr, priorMove, nextMove)
type Ev = { thrHit: Record<number, boolean>; prior: number; next: number };
const events: Ev[] = []; const allBuckets: { prior: number; next: number }[] = [];
const THRS = [2, 3, 5];
let nMk = 0;
for (const [id, yi] of yesIdx) {
  if (yi < 0 || !cached.has(id)) continue;
  let tr: any[]; try { tr = JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { continue; }
  if (tr.length < 60) continue;
  tr.sort((a, b) => a.ts - b.ts);
  // bucketize
  const b0 = Math.floor(tr[0].ts / BUCKET);
  const buckets = new Map<number, { vol: number; lastP: number }>();
  for (const t of tr) { if (!(t.p > 0 && t.p < 1) || !(t.sz > 0)) continue; const yp = t.oi === yi ? t.p : 1 - t.p; const k = Math.floor(t.ts / BUCKET); let b = buckets.get(k); if (!b) { b = { vol: 0, lastP: yp }; buckets.set(k, b); } b.vol += t.sz; b.lastP = yp; }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  if (keys.length < 10) continue; nMk++;
  for (let i = 6; i < keys.length - 1; i++) {
    const k = keys[i]; const cur = buckets.get(k)!;
    const trail = mean(keys.slice(i - 6, i).map((kk) => buckets.get(kk)!.vol));
    const prior = cur.lastP - buckets.get(keys[i - 1])!.lastP;
    const next = buckets.get(keys[i + 1])!.lastP - cur.lastP;
    const thrHit: Record<number, boolean> = {}; for (const th of THRS) thrHit[th] = trail > 0 && cur.vol >= th * trail;
    events.push({ thrHit, prior, next });
    allBuckets.push({ prior, next });
  }
}
console.log(`\n=== VOLUME-SPIKE signal | markets=${nMk} bucket-events=${events.length} | roundTripCost=${COST} ===`);

// strategy return at a spike: dir=+1 momentum (follow prior), -1 fade (reverse prior). position = dir*sign(prior).
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
function rets(thr: number, dir: 1 | -1, cost: number, pool: Ev[]) {
  const out: number[] = [];
  for (const e of pool) { if (!e.thrHit[thr]) continue; const pos = dir * sgn(e.prior); if (pos === 0) continue; out.push(pos * e.next - cost); }
  return out;
}
const GRID: { thr: number; dir: 1 | -1 }[] = []; for (const thr of THRS) for (const dir of [1, -1] as const) GRID.push({ thr, dir });

// gross informational ceiling (cost=0)
console.log("\nthr  dir       nSpikes  grossMean  netMean(@cost)");
let best = { thr: 0, dir: 1 as 1 | -1, mean: -Infinity, returns: [] as number[] };
for (const { thr, dir } of GRID) { const g = rets(thr, dir, 0, events); const n = rets(thr, dir, COST, events); console.log(`${thr}x  ${dir === 1 ? "momentum" : "fade    "}  ${String(g.length).padStart(7)}  ${(mean(g) >= 0 ? "+" : "") + mean(g).toFixed(5)}  ${(mean(n) >= 0 ? "+" : "") + mean(n).toFixed(5)}`); if (n.length >= 30 && mean(n) > best.mean) best = { thr, dir, mean: mean(n), returns: n }; }
if (best.returns.length < 30) { console.log("too few spike events"); process.exit(0); }

// right null: TIME-SHUFFLE — same rule applied at RANDOM buckets (not spikes), matched count, family-wise MAX
const rng = seeded(2024); const DRAWS = 1500; const nullMax: number[] = [];
for (let d = 0; d < DRAWS; d++) {
  let mx = -Infinity;
  for (const { thr, dir } of GRID) {
    const nSpk = events.filter((e) => e.thrHit[thr]).length; if (nSpk < 30) continue;
    // sample nSpk random buckets, apply the rule
    const acc: number[] = []; for (let j = 0; j < nSpk; j++) { const e = allBuckets[Math.floor(rng() * allBuckets.length)]; const pos = dir * sgn(e.prior); if (pos !== 0) acc.push(pos * e.next - COST); }
    if (acc.length >= 30) mx = Math.max(mx, mean(acc));
  }
  nullMax.push(mx);
}
// grid folds + holdout
const FOLDS = 8; const folds = (r: number[]) => { const per = Math.ceil(r.length / FOLDS); return Array.from({ length: FOLDS }, (_, k) => r.slice(k * per, (k + 1) * per)); };
const gridFolds = GRID.map(({ thr, dir }) => ({ id: `${thr}x-${dir}`, folds: folds(rets(thr, dir, COST, events)) })).filter((g) => g.folds.every((f) => f.length > 0));
const half = Math.floor(events.length / 2); const hoPool = events.slice(half);
const ho = rets(best.thr, best.dir, COST, hoPool);
// baseline: trade EVERY bucket with the same rule (no spike filter) — does the spike filter add anything?
const everyBucket = mean(allBuckets.map((e) => best.dir * sgn(e.prior) * e.next - COST).filter((x) => Number.isFinite(x)));

const out = runGauntlet({ name: `volume-spike ${best.thr}x ${best.dir === 1 ? "momentum" : "fade"} (n=${best.returns.length}, cost=${COST})`, returns: best.returns, honestN: GRID.length,
  baselines: [{ name: "every-bucket-same-rule", mean: everyBucket }], grid: gridFolds, surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: ho });
printGauntlet(out);
console.log(`\nNOTE: net-of-cost uses a fixed ${COST} round-trip; a real intraday fill needs the PIT L2 book (DEFERRED). The GROSS column is the informational ceiling — if even GROSS ~0 / fails the time-shuffle null, the spike carries no tradeable directional info.`);
writeFileSync(`${DIR}/volume_spike.json`, JSON.stringify({ markets: nMk, events: events.length, best, verdict: out }, null, 2));
