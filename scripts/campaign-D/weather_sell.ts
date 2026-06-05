/**
 * Campaign-D — validate the "@hightemptation" weather claim through the COMPLETE gauntlet:
 * "buy No at 85-96c on exact-temp markets (longshots), 98% win rate, +$7,600, sell at 99-100c later".
 * This is the SELL-the-longshot / favorite-buy side. We test it directly on the weather markets we have:
 * for markets whose YES price (T-24h, from tape) is a longshot, BUY NO, hold to resolution.
 *
 * Win rate is MECHANICAL (No wins whenever the rare exact temp misses) — the question the gauntlet
 * answers is whether the realized MEAN return is positive net of the (wide) weather spread + the rare
 * catastrophic loss, with significance. Right null: calibrated-Bernoulli family-wise MAX.
 *
 * Run: npx tsx scripts/campaign-D/weather_sell.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import { runGauntlet, printGauntlet } from "./gauntlet.ts";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`;
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
const tape = (id: string) => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };

type Mk = { id: string; endTs: number; winnerIndex: number; outcomes: string[] };
const markets: Mk[] = readFileSync(`${DIR}/weather-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// per market: YES price at T-24h + resolution
type Row = { pYes: number; resYes: number; endTs: number };
const rows: Row[] = [];
for (const m of markets) {
  if (!cached.has(m.id)) continue; const yesIdx = m.outcomes.indexOf("yes"); const lead = m.endTs - 86400;
  const yes = tape(m.id).filter((t: any) => t.oi === yesIdx && t.p > 0 && t.p < 1 && t.ts <= lead).sort((a: any, b: any) => a.ts - b.ts);
  if (!yes.length) continue;
  rows.push({ pYes: yes[yes.length - 1].p, resYes: m.winnerIndex === yesIdx ? 1 : 0, endTs: m.endTs });
}
rows.sort((a, b) => a.endTs - b.endTs);
console.log(`\n=== WEATHER buy-No-on-longshots (the @hightemptation play) | usable=${rows.length} ===`);

// weather-realistic proportional half-spread (wide on longshots)
const hs = (p: number) => Math.max(0.02, 0.2 * Math.min(p, 1 - p));
// BUY NO at the longshot: cost = (1 - pYes) + halfSpread; pays 1 if resYes==0
const buyNoRet = (r: Row) => { const c = Math.min(0.999, 1 - r.pYes + hs(r.pYes)); return ((1 - r.resYes) - c) / c; };

// strategy grid: only enter where YES is a longshot (pYes <= theta) — i.e. No priced high (the claim's 85-96c)
const THETAS = [0.04, 0.06, 0.08, 0.10, 0.15, 0.20];
const cfg = (theta: number, oc: (r: Row) => number) => rows.filter((r) => r.pYes <= theta).map((r) => { const c = Math.min(0.999, 1 - r.pYes + hs(r.pYes)); return ((1 - oc(r)) - c) / c; });
console.log("\ntheta(maxYes)  nTrades  No-winRate  meanRet(net of weather spread)");
let best = { theta: 0, mean: -Infinity, returns: [] as number[] };
for (const th of THETAS) { const sub = rows.filter((r) => r.pYes <= th); const rets = sub.map(buyNoRet); const wr = mean(sub.map((r) => (r.resYes === 0 ? 1 : 0))); console.log(`<= ${th.toFixed(2)}      ${String(rets.length).padStart(7)}    ${wr.toFixed(3)}     ${(mean(rets) >= 0 ? "+" : "") + mean(rets).toFixed(4)}`); if (rets.length >= 30 && mean(rets) > best.mean) best = { theta: th, mean: mean(rets), returns: rets }; }
if (best.returns.length < 30) { console.log("too few longshots"); process.exit(0); }

// right null: calibrated-Bernoulli family-wise MAX (resample resYes ~ Bernoulli(pYes))
const rng = seeded(909); const DRAWS = 1500; const nullMax: number[] = [];
for (let d = 0; d < DRAWS; d++) { const synth = new Map<Row, number>(); for (const r of rows) synth.set(r, rng() < r.pYes ? 1 : 0); let mx = -Infinity; for (const th of THETAS) { const rets = cfg(th, (r) => synth.get(r)!); if (rets.length >= 30) mx = Math.max(mx, mean(rets)); } nullMax.push(mx); }

const FOLDS = 8; const folds = (rets: number[]) => { const per = Math.ceil(rets.length / FOLDS); return Array.from({ length: FOLDS }, (_, k) => rets.slice(k * per, (k + 1) * per)); };
const gridFolds = THETAS.map((th) => ({ id: `theta-${th}`, folds: folds(rows.filter((r) => r.pYes <= th).map(buyNoRet)) })).filter((g) => g.folds.every((f) => f.length > 0));
const sub = rows.filter((r) => r.pYes <= best.theta); const cut = Math.floor(sub.length * 0.8); const ho = sub.slice(cut).map(buyNoRet);

const out = runGauntlet({ name: `weather buy-No longshots theta<=${best.theta} (n=${best.returns.length})`, returns: best.returns, honestN: THETAS.length,
  baselines: [{ name: "buy-No-ALL-weather", mean: mean(rows.map(buyNoRet)) }, { name: "buy-Yes-ALL", mean: mean(rows.map((r) => { const c = Math.min(0.999, r.pYes + hs(r.pYes)); return (r.resYes - c) / c; })) }],
  grid: gridFolds, surrogate: { real: best.mean, nullMaxes: nullMax }, holdoutReturns: ho });
printGauntlet(out);
const wr = mean(best.returns.map((x) => (x > 0 ? 1 : 0)));
console.log(`\nbest config win rate=${wr.toFixed(3)} (matches the marketing "98%"? high win rate is MECHANICAL — the question is the gauntlet verdict above)`);
writeFileSync(`${DIR}/weather_sell.json`, JSON.stringify({ usable: rows.length, best, winRate: wr, verdict: out }, null, 2));
