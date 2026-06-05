/**
 * Campaign-D / PM-copytrading — does wallet skill PERSIST and is it COPYABLE? (the viral claim)
 *
 * Ground truth: every sampled market resolves, so each (wallet,trade) has a settled PnL.
 *   BUY  outcome oi @ p  ->  pnl = size*(win - p)      (win = oi resolved YES)
 *   SELL outcome oi @ p  ->  pnl = size*(p - win)
 * Rank wallets by TRAIN-window skill; COPY the top-k in the disjoint OOS window with a half-spread
 * cost, hold to resolution. To get an HONEST risk-adjusted number (and to keep arrays sane for the
 * committed primitives) we aggregate copied trades into a DAILY PORTFOLIO return series (equal-weight
 * within a resolution-day, then across days) and run the gauntlet on that. The RIGHT null is the
 * WALLET-LABEL SHUFFLE — copy RANDOM wallets from the same eligible pool, family-wise MAX over the
 * (metric x k) grid. Honest N = grid size. If top-by-skill ~ random OOS, the "mirror top wallets" thesis fails.
 *
 * Run: npx tsx scripts/campaign-D/copy_trading_gauntlet.ts [halfSpread=0.01] [minTrainTrades=15]
 */
import { readFileSync, readdirSync } from "node:fs";
import { summarizeReturnSeries, computeDeflatedSharpeRatio, blockBootstrapConfidenceInterval } from "../../src/lib/training/statistical-validation.ts";

const H = Number(process.argv[2] ?? 0.01);
const MIN_TRAIN = Number(process.argv[3] ?? 15);
const DIR = "output/campaign-D";
const TCACHE = `${DIR}/trades-cache`;

type Mkt = { id: string; window: "train" | "oos"; winnerIndex: number; endTs: number; vol: number };
const markets: Mkt[] = readFileSync(`${DIR}/copy-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
type Trade = { w: string; s: "BUY" | "SELL"; oi: number; p: number; sz: number; ts: number };
const tradesOf = (id: string): Trade[] => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };
const tradePnl = (t: Trade, win: number) => (t.s === "BUY" ? t.sz * (win - t.p) : t.sz * (t.p - win));
function copyReturn(t: Trade, win: number): number { // $1 directional copy at half-spread cost
  if (t.s === "BUY") { const c = Math.min(0.999, t.p + H); return (win - c) / c; }
  const c = Math.min(0.999, 1 - t.p + H); return ((1 - win) - c) / c;
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0); // no Math.min spread (huge arrays)

// --- aggregate per-wallet TRAIN skill; store OOS copies as {ret, day, onWinner} ---
type OosCopy = { ret: number; day: number; onWinner: boolean };
type WStat = { trainPnl: number; trainVol: number; trainN: number; trainWins: number; oos: OosCopy[] };
const W = new Map<string, WStat>();
const get = (w: string) => { let x = W.get(w); if (!x) { x = { trainPnl: 0, trainVol: 0, trainN: 0, trainWins: 0, oos: [] }; W.set(w, x); } return x; };

let nTrain = 0, nOos = 0;
for (const m of markets) {
  if (!cached.has(m.id)) continue;
  for (const t of tradesOf(m.id)) {
    if (!Number.isFinite(t.p) || !Number.isFinite(t.sz) || t.sz <= 0) continue;
    const x = get(t.w);
    const win = t.oi === m.winnerIndex ? 1 : 0;
    const onWinner = (t.s === "BUY") === (t.oi === m.winnerIndex);
    if (m.window === "train") { x.trainPnl += tradePnl(t, win); x.trainVol += t.sz * t.p; x.trainN++; if (onWinner) x.trainWins++; nTrain++; }
    else { x.oos.push({ ret: copyReturn(t, win), day: Math.floor(t.ts / 86400), onWinner }); nOos++; } // bucket by ENTRY day (resolutions cluster)
  }
}
console.log(`\n=== PM-copytrading | trainTrades=${nTrain} oosTrades=${nOos} | wallets=${W.size} | halfSpread=${H} ===`);

const elig = [...W.entries()].filter(([, x]) => x.trainN >= MIN_TRAIN && x.oos.length >= 3);
console.log(`eligible wallets (>=${MIN_TRAIN} train trades & active OOS): ${elig.length}`);

const metricFns: Record<string, (x: WStat) => number> = {
  pnl: (x) => x.trainPnl, roi: (x) => x.trainPnl / Math.max(1, x.trainVol), winrate: (x) => x.trainWins / Math.max(1, x.trainN),
};
const METRICS = ["pnl", "roi", "winrate"];
const KS = [10, 25, 50, 100].filter((k) => k <= elig.length);
const GRID: { metric: string; k: number }[] = [];
for (const metric of METRICS) for (const k of KS) GRID.push({ metric, k });
const HONEST_N = GRID.length;
const topWalletsBy = (metric: string, k: number) =>
  [...elig].sort((a, b) => metricFns[metric](b[1]) - metricFns[metric](a[1])).slice(0, k).map(([w]) => w);

// daily-portfolio return series for a wallet set (equal-weight within day, across days)
function dailySeries(wallets: string[]): { series: number[]; nTrades: number; perTradeMean: number; winrate: number } {
  const byDay = new Map<number, number[]>(); let nTrades = 0, wins = 0; const allRet: number[] = [];
  for (const w of wallets) for (const c of W.get(w)!.oos) {
    let a = byDay.get(c.day); if (!a) { a = []; byDay.set(c.day, a); } a.push(c.ret);
    nTrades++; if (c.onWinner) wins++; allRet.push(c.ret);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const series = days.map((d) => mean(byDay.get(d)!));
  return { series, nTrades, perTradeMean: mean(allRet), winrate: nTrades ? wins / nTrades : 0 };
}

console.log(`\nGrid (N=${HONEST_N}) — copy top-k by TRAIN metric, OOS daily-portfolio:`);
console.log("metric    k    nTrades  perTradeMean  dailySharpe  OOS-winrate  nDays");
let best = { metric: "", k: 0, dmean: -Infinity, series: [] as number[], wallets: [] as string[] };
for (const { metric, k } of GRID) {
  const ws = topWalletsBy(metric, k);
  const d = dailySeries(ws);
  const s = summarizeReturnSeries(d.series);
  console.log(metric.padEnd(9), String(k).padStart(4), String(d.nTrades).padStart(8),
    ((d.perTradeMean >= 0 ? "+" : "") + d.perTradeMean.toFixed(4)).padStart(13), s.sharpe.toFixed(3).padStart(12),
    d.winrate.toFixed(3).padStart(12), String(d.series.length).padStart(7));
  if (s.mean > best.dmean && d.series.length >= 10) best = { metric, k, dmean: s.mean, series: d.series, wallets: ws };
}
const bestD = dailySeries(best.wallets);
console.log(`\nIn-sample BEST (by daily mean): metric=${best.metric} k=${best.k} nDays=${best.series.length} perTradeMean=${bestD.perTradeMean.toFixed(4)} dailySharpe=${summarizeReturnSeries(best.series).sharpe.toFixed(3)}`);

// ---------------- GAUNTLET (on the daily-portfolio series) ----------------
const seeded = (seed: number) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const bstat = summarizeReturnSeries(best.series);

console.log(`\n[gate net_of_cost] best daily mean net of spread = ${bstat.mean.toFixed(4)} (perTradeMean ${bestD.perTradeMean.toFixed(4)}) => ${bstat.mean > 0 ? "pass" : "FAIL"}`);

const crowd = summarizeReturnSeries(dailySeries(elig.map(([w]) => w)).series);
console.log(`[gate baselines] best daily mean ${bstat.mean.toFixed(4)} | copy-ALL-eligible(crowd) daily mean ${crowd.mean.toFixed(4)}, sharpe ${crowd.sharpe.toFixed(3)}`);

// the hero: wallet-label-shuffle, family-wise MAX over the grid (on daily means)
const pool = elig.map(([w]) => w);
const DRAWS = 2000; const rng = seeded(424242);
const pickRandom = (k: number) => { const a = pool.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
let ge = 0; const nullMax: number[] = [];
for (let dd = 0; dd < DRAWS; dd++) {
  let mx = -Infinity;
  for (const { k } of GRID) { const s = dailySeries(pickRandom(k)).series; if (s.length >= 10) mx = Math.max(mx, summarizeReturnSeries(s).mean); }
  nullMax.push(mx); if (mx >= best.dmean) ge++;
}
nullMax.sort((a, b) => a - b);
const surrP = ge / DRAWS, surr95 = nullMax[Math.floor(DRAWS * 0.95)];
console.log(`[gate surrogate] wallet-label-shuffle family-wise MAX: real best ${best.dmean.toFixed(4)} vs null95 ${surr95.toFixed(4)}, p=${surrP.toFixed(3)} => ${surrP < 0.05 ? "pass" : "FAIL (skill no better than random selection)"}`);

const dsr = computeDeflatedSharpeRatio(best.series, { trialCount: HONEST_N });
console.log(`[gate deflated_sharpe] DSR @N=${HONEST_N} = ${dsr.deflatedProbability.toFixed(3)} (dailySharpe ${dsr.sharpe.toFixed(3)}) => ${dsr.deflatedProbability > 0.95 ? "pass" : "FAIL"}`);
const bb = blockBootstrapConfidenceInterval(best.series, { statistic: "mean", iterations: 3000, blockLength: 3, seed: "pm-copy" });
console.log(`[gate block_bootstrap] daily-mean 95% CI = [${bb.lower.toFixed(4)}, ${bb.upper.toFixed(4)}] => ${bb.lower > 0 ? "pass" : "FAIL"}`);

// holdout: pick top in TRAIN, score on the LAST HALF of OOS days once
const sortedDays = best.series; const cut = Math.floor(sortedDays.length / 2);
const ho = sortedDays.slice(cut); const hs = summarizeReturnSeries(ho);
console.log(`[gate holdout] last-half-OOS-days (n=${ho.length}): daily mean ${hs.mean.toFixed(4)}, sharpe ${hs.sharpe.toFixed(3)} => ${hs.mean > 0 ? "pass" : "FAIL"}`);

// descriptive: train->OOS winrate persistence correlation
const xs = elig.map(([, x]) => x.trainWins / Math.max(1, x.trainN));
const ys = elig.map(([, x]) => x.oos.filter((c) => c.onWinner).length / Math.max(1, x.oos.length));
const corr = (() => { const n = xs.length, mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } return sxy / Math.sqrt(Math.max(1e-9, sxx * syy)); })();
// train PnL -> OOS per-trade-return persistence
const xp = elig.map(([, x]) => x.trainPnl / Math.max(1, x.trainVol));
const yp = elig.map(([, x]) => mean(x.oos.map((c) => c.ret)));
const corrP = (() => { const n = xp.length, mx = mean(xp), my = mean(yp); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xp[i] - mx) * (yp[i] - my); sxx += (xp[i] - mx) ** 2; syy += (yp[i] - my) ** 2; } return sxy / Math.sqrt(Math.max(1e-9, sxx * syy)); })();
console.log(`\n[descriptive] persistence across ${elig.length} eligible wallets: train-winrate->OOS-winrate r=${corr.toFixed(3)} | train-ROI->OOS-return r=${corrP.toFixed(3)}  [~0 => no persistence]`);
console.log("\n=== VERDICT INPUTS — KILL is the expected outcome ===");
