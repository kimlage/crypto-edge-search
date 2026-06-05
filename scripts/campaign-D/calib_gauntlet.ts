/**
 * Campaign-D / PM-calibration — favorite-longshot bias through the committed gauntlet.
 *
 * Ground truth: every row is a cleanly-resolved binary market (resYes in {0,1}) with the
 * YES mid price at a fixed lead time before resolution. We ask the canonical
 * prediction-market question: are prices CALIBRATED, or is there an exploitable
 * favorite/longshot bias net of the spread?
 *
 * The RIGHT null (per the lab's "right null per claim" rule): the CALIBRATED-BERNOULLI
 * surrogate. Resample every market's outcome ~ Bernoulli(p_mid) keeping prices + strategy
 * fixed; under this null prices are perfect, so any positive mean is noise/cost. Take the
 * MAX statistic over the whole searched (direction x band) grid per draw => family-wise.
 * Beating it ⇒ real outcomes deviate from prices systematically ⇒ genuine miscalibration.
 *
 * Cost realism: Polymarket charges 0% fee but you cross the SPREAD. We charge a half-spread
 * h on entry (per-market quoted spread when present, else a floor). A gross-only signal is
 * an automatic KILL.
 *
 * Run: npx tsx scripts/campaign-D/calib_gauntlet.ts [lead=p_24h] [halfSpread=0.01]
 */
import { readFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation.ts";

const LEAD = (process.argv[2] ?? "p_24h") as "p_7d" | "p_24h" | "p_1h" | "p_close";
const HALF_SPREAD_FLOOR = Number(process.argv[3] ?? 0.01);
const FILTER = (process.argv[4] ?? "all") as "all" | "clean" | "negrisk"; // clean = exclude negRisk multi-candidate legs
const IN = "output/campaign-D/calibration.jsonl";

type Row = { id: string; q: string; endTs: number; vol: number; resYes: number; negRisk?: boolean;
  spreadField: unknown; p_7d: number | null; p_24h: number | null; p_1h: number | null; p_close: number | null };

const rows: Row[] = readFileSync(IN, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// usable: has the chosen lead price strictly inside (0,1)
const data = rows
  .map((r) => ({ ...r, p: r[LEAD] as number | null }))
  .filter((r) => r.p != null && r.p > 0.005 && r.p < 0.995 && Number.isFinite(r.endTs))
  .filter((r) => FILTER === "all" || (FILTER === "clean" ? r.negRisk !== true : r.negRisk === true))
  .sort((a, b) => a.endTs - b.endTs); // chronological for holdout + folds

console.log(`\n=== PM-calibration | lead=${LEAD} | filter=${FILTER} | n=${data.length} markets | halfSpreadFloor=${HALF_SPREAD_FLOOR} ===`);

// --- per-market half-spread (in price units). Gamma 'spread' is a fraction of price; floor it. ---
function halfSpread(r: Row & { p: number }): number {
  const sf = typeof r.spreadField === "number" ? r.spreadField
    : typeof r.spreadField === "string" ? Number(r.spreadField) : NaN;
  const modeled = Number.isFinite(sf) && sf > 0 && sf < 0.5 ? sf / 2 : HALF_SPREAD_FLOOR;
  return Math.max(HALF_SPREAD_FLOOR, modeled);
}

// --- descriptive reliability curve (longshot/favorite bias direction) ---
const BINS = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];
console.log("\nReliability (YES price bucket vs realized YES rate):");
console.log("bucket           n     meanPrice  realizedYES   edge(real-impl)");
for (let i = 0; i < BINS.length - 1; i++) {
  const lo = BINS[i], hi = BINS[i + 1];
  const b = data.filter((r) => r.p! >= lo && r.p! < hi);
  if (!b.length) continue;
  const mp = b.reduce((s, r) => s + r.p!, 0) / b.length;
  const ry = b.reduce((s, r) => s + r.resYes, 0) / b.length;
  console.log(
    `[${lo.toFixed(2)},${hi.toFixed(2)})`.padEnd(14),
    String(b.length).padStart(5),
    mp.toFixed(3).padStart(10), ry.toFixed(3).padStart(11),
    (ry - mp >= 0 ? "+" : "") + (ry - mp).toFixed(3),
  );
}

// --- strategy family: bet toward favorite or toward longshot, with a deadband ---
type Dir = "favorite" | "longshot";
const BANDS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45];
const GRID: { dir: Dir; band: number }[] = [];
for (const dir of ["favorite", "longshot"] as Dir[]) for (const band of BANDS) GRID.push({ dir, band });
const HONEST_N = GRID.length; // every config we searched

// per-market return for a given (dir, band) on a given outcome (real or surrogate)
function tradeReturn(r: Row & { p: number }, dir: Dir, band: number, outcomeYes: number): number | null {
  const p = r.p, h = halfSpread(r);
  let side: "YES" | "NO" | null = null;
  if (p > 0.5 + band) side = dir === "favorite" ? "YES" : "NO";
  else if (p < 0.5 - band) side = dir === "favorite" ? "NO" : "YES";
  else return null; // inside deadband => no trade
  if (side === "YES") { const c = Math.min(0.999, p + h); return (outcomeYes - c) / c; }
  const c = Math.min(0.999, 1 - p + h); return ((1 - outcomeYes) - c) / c;
}

function configReturns(dir: Dir, band: number, outcomeOf: (r: Row & { p: number }) => number) {
  const out: { ts: number; ret: number }[] = [];
  for (const r of data) {
    const ret = tradeReturn(r, dir, band, outcomeOf(r));
    if (ret != null) out.push({ ts: r.endTs, ret });
  }
  return out;
}

const realOutcome = (r: Row & { p: number }) => r.resYes;

// evaluate the grid on REAL data; pick the in-sample best by mean return
let best = { dir: "favorite" as Dir, band: 0, mean: -Infinity, returns: [] as number[], n: 0 };
console.log(`\nGrid search (N=${HONEST_N} configs), real data, net of spread:`);
console.log("dir        band   nTrades   meanRet     sharpe");
for (const { dir, band } of GRID) {
  const tr = configReturns(dir, band, realOutcome);
  const rets = tr.map((t) => t.ret);
  const s = summarizeReturnSeries(rets);
  if (band % 0.1 === 0) // print a subset to keep it readable
    console.log(dir.padEnd(10), band.toFixed(2).padStart(5), String(rets.length).padStart(8),
      (s.mean >= 0 ? "+" : "") + s.mean.toFixed(4), s.sharpe.toFixed(3).padStart(11));
  if (s.mean > best.mean && rets.length >= 30) best = { dir, band, mean: s.mean, returns: rets, n: rets.length };
}
console.log(`\nIn-sample BEST: dir=${best.dir} band=${best.band} nTrades=${best.n} meanRet=${best.mean.toFixed(4)} sharpe=${summarizeReturnSeries(best.returns).sharpe.toFixed(3)}`);

// ---------------- GAUNTLET ----------------
const seeded = (seed: number) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// Gate 1: net_of_cost
const bestStats = summarizeReturnSeries(best.returns);
console.log(`\n[gate net_of_cost] meanRet net of spread = ${bestStats.mean.toFixed(4)}  => ${bestStats.mean > 0 ? "pass" : "FAIL"}`);

// Gate 2: baselines — blind-NO (base-rate/long-NO-beta), blind-YES, random-lottery, matched-exposure
const blindNo = data.map((r) => { const c = Math.min(0.999, 1 - r.p + halfSpread(r)); return ((1 - r.resYes) - c) / c; });
const blindYes = data.map((r) => { const c = Math.min(0.999, r.p + halfSpread(r)); return (r.resYes - c) / c; });
const rng0 = seeded(12345);
const randLottery = data.map((r) => {
  const yes = rng0() < 0.5; const c = Math.min(0.999, (yes ? r.p : 1 - r.p) + halfSpread(r));
  return ((yes ? r.resYes : 1 - r.resYes) - c) / c;
});
console.log(`[gate baselines] strategy mean ${bestStats.mean.toFixed(4)} | blindNO ${summarizeReturnSeries(blindNo).mean.toFixed(4)} | blindYES ${summarizeReturnSeries(blindYes).mean.toFixed(4)} | randomLottery ${summarizeReturnSeries(randLottery).mean.toFixed(4)}`);
const beatsBlind = bestStats.mean > Math.max(summarizeReturnSeries(blindNo).mean, summarizeReturnSeries(blindYes).mean);
console.log(`   beats both blind sides? ${beatsBlind ? "yes" : "NO (=> base-rate/long-NO-beta in disguise, failure mode (a))"}`);

// Gate 3: Deflated Sharpe @ honest N
const dsr = computeDeflatedSharpeRatio(best.returns, { trialCount: HONEST_N });
console.log(`[gate deflated_sharpe] DSR prob @N=${HONEST_N} = ${dsr.deflatedProbability.toFixed(3)}  (sharpe ${dsr.sharpe.toFixed(3)}, expMax ${dsr.expectedMaxSharpe.toFixed(3)})  => ${dsr.deflatedProbability > 0.95 ? "pass" : "FAIL"}`);

// Gate 4: block-bootstrap CI on the mean excludes 0
const bb = blockBootstrapConfidenceInterval(best.returns, { statistic: "mean", iterations: 2000, blockLength: 1, seed: "pm-calib" });
console.log(`[gate block_bootstrap] mean 95% CI = [${bb.lower.toFixed(4)}, ${bb.upper.toFixed(4)}]  => ${bb.lower > 0 ? "pass" : "FAIL"}`);

// Gate 5: CPCV / PBO across time folds (strategy vs the grid)
const FOLDS = 10;
const foldOf = (ts: number, i: number) => i; // index-based folds preserve chronology
const buildFolds = (rets: number[]) => {
  const per = Math.ceil(rets.length / FOLDS);
  return Array.from({ length: FOLDS }, (_, k) => rets.slice(k * per, (k + 1) * per));
};
const cscvStrategies = GRID.map(({ dir, band }) => {
  const rets = configReturns(dir, band, realOutcome).map((t) => t.ret);
  return { id: `${dir}-${band}`, folds: buildFolds(rets) };
}).filter((s) => s.folds.every((f) => f.length > 0));
let pbo = NaN;
try { pbo = estimateCscvPbo(cscvStrategies, { statistic: "sharpe" }).pbo; } catch (e) { pbo = NaN; }
console.log(`[gate cpcv_pbo] PBO = ${Number.isFinite(pbo) ? pbo.toFixed(3) : "n/a"}  => ${Number.isFinite(pbo) && pbo < 0.5 ? "pass" : "FAIL/na"}`);

// Gate 7: the RIGHT null — calibrated-Bernoulli, family-wise MAX over the grid
const DRAWS = 1500;
const rng = seeded(98765);
let ge = 0; const nullMaxes: number[] = [];
for (let d = 0; d < DRAWS; d++) {
  // one shared synthetic-outcome realization per market for THIS draw, applied to every config
  const synth = new Map<string, number>();
  for (const r of data) synth.set(r.id, rng() < r.p ? 1 : 0);
  let mx = -Infinity;
  for (const { dir, band } of GRID) {
    const rets = configReturns(dir, band, (r) => synth.get(r.id)!).map((t) => t.ret);
    if (rets.length >= 30) mx = Math.max(mx, summarizeReturnSeries(rets).mean);
  }
  nullMaxes.push(mx);
  if (mx >= best.mean) ge++;
}
nullMaxes.sort((a, b) => a - b);
const surrP = ge / DRAWS;
const surr95 = nullMaxes[Math.floor(DRAWS * 0.95)];
console.log(`[gate surrogate] calibrated-Bernoulli family-wise MAX: real best mean ${best.mean.toFixed(4)} vs null95 ${surr95.toFixed(4)}, p=${surrP.toFixed(3)}  => ${surrP < 0.05 ? "pass" : "FAIL"}`);

// Gate 8: consume-once holdout — most recent 20% of markets, scored once with the in-sample config
const cut = Math.floor(data.length * 0.8);
const hoData = data.slice(cut);
const hoRets: number[] = [];
for (const r of hoData) { const ret = tradeReturn(r, best.dir, best.band, r.resYes); if (ret != null) hoRets.push(ret); }
const hoStats = summarizeReturnSeries(hoRets);
const hoDsr = computeDeflatedSharpeRatio(hoRets, { trialCount: 1 });
console.log(`[gate holdout] OOS (last 20%, n=${hoRets.length}): meanRet ${hoStats.mean.toFixed(4)}, sharpe ${hoStats.sharpe.toFixed(3)}, DSR@N=1 ${hoDsr.deflatedProbability.toFixed(3)}  => ${hoStats.mean > 0 && hoDsr.deflatedProbability > 0.95 ? "pass" : "FAIL"}`);

console.log("\n=== VERDICT INPUTS — see which gate binds first; KILL is the expected outcome ===");
