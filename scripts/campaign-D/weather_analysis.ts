/**
 * Campaign-D — validate the viral "weather bot" claim (Yes @ 9.1c / No @ 50c across cities;
 * 74% WR, +$3.7K, $366K vol, 955 trades). Two questions:
 *  (A) FORENSIC: does such a wallet exist, and are its stats accurate?
 *  (B) GAUNTLET LENS: is buying ~9c weather longshots a real edge or longshot variance/thin-MM?
 *      - do ~9c BUY-Yes entries resolve YES >= 9% net of spread?
 *      - is the wallet's realized mean return significant (DSR/block-bootstrap), or noise on 955 bets?
 *
 * Run: npx tsx scripts/campaign-D/weather_analysis.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { summarizeReturnSeries, computeDeflatedSharpeRatio, blockBootstrapConfidenceInterval } from "../../src/lib/training/statistical-validation.ts";
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`;
const markets = readFileSync(`${DIR}/weather-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
type T = { w: string; s: "BUY" | "SELL"; oi: number; p: number; sz: number; ts: number };
const tape = (id: string): T[] => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// gather all weather trades with market resolution + YES index
type Tr = T & { mid: string; win: number; yesIdx: number };
const all: Tr[] = [];
for (const m of markets) { if (!cached.has(m.id)) continue; const yesIdx = m.outcomes.indexOf("yes"); for (const t of tape(m.id)) { if (!(t.p > 0 && t.p < 1) || !(t.sz > 0)) continue; all.push({ ...t, mid: m.id, win: t.oi === m.winnerIndex ? 1 : 0, yesIdx }); } }
console.log(`\n=== WEATHER-BOT validation | ${markets.length} markets, ${all.length} trades ===`);

// (A) FORENSIC — find wallets matching the 9.1c-Yes / 50c-No pattern
const tradePnl = (t: Tr) => t.s === "BUY" ? t.sz * (t.win - t.p) : t.sz * (t.p - t.win);
// t.win = 1 iff the traded outcome (oi) won; "on winner" = BUY a winner OR SELL a loser
const onWinner = (t: Tr) => (t.s === "BUY") === (t.win === 1);
type WA = { n: number; vol: number; pnl: number; wins: number; at91: number; at50: number; buys: number };
const W = new Map<string, WA>(); const g = (w: string) => { let x = W.get(w); if (!x) { x = { n: 0, vol: 0, pnl: 0, wins: 0, at91: 0, at50: 0, buys: 0 }; W.set(w, x); } return x; };
for (const t of all) { const x = g(t.w); x.n++; x.vol += t.sz * t.p; x.pnl += tradePnl(t); if (onWinner(t)) x.wins++; if (Math.abs(t.p - 0.091) < 0.006) x.at91++; if (Math.abs(t.p - 0.5) < 0.006) x.at50++; if (t.s === "BUY") x.buys++; }
// rank candidate bots by # of ~9.1c trades
const bots = [...W.entries()].filter(([, x]) => x.at91 >= 10).sort((a, b) => b[1].at91 - a[1].at91).slice(0, 5);
console.log("\n(A) FORENSIC — wallets with the 9.1c pattern (top 5 by #@9.1c):");
console.log("wallet                                      nTrades   vol$     PnL$    winRate  @9.1c  @50c  %buy");
for (const [w, x] of bots) console.log(`${w}  ${String(x.n).padStart(7)} ${x.vol.toFixed(0).padStart(8)} ${x.pnl.toFixed(0).padStart(8)} ${(x.wins / x.n).toFixed(3).padStart(8)} ${String(x.at91).padStart(6)} ${String(x.at50).padStart(5)} ${(x.buys / x.n).toFixed(2).padStart(5)}`);

// (B1) CALIBRATION — do ~9c BUY-Yes entries resolve YES >= 9% (net of spread)?
function bucket(lo: number, hi: number) {
  const tr = all.filter((t) => t.s === "BUY" && t.oi === t.yesIdx && t.p >= lo && t.p < hi);
  const yesRate = mean(tr.map((t) => t.win));
  const grossRet = mean(tr.map((t) => (t.win - t.p) / t.p));            // per $1, gross
  const netRet = mean(tr.map((t) => (t.win - Math.min(0.999, t.p + 0.02)) / Math.min(0.999, t.p + 0.02))); // +2c half-spread
  return { n: tr.length, meanPrice: mean(tr.map((t) => t.p)), yesRate, grossRet, netRet };
}
console.log("\n(B1) CALIBRATION of BUY-Yes weather entries (does the longshot hit >= its price?):");
console.log("priceBucket      n    meanPrice  YESrate   grossRet/$  netRet/$(+2c)");
for (const [lo, hi] of [[0.05, 0.10], [0.08, 0.10], [0.10, 0.15], [0.15, 0.30], [0.30, 0.70]]) {
  const b = bucket(lo, hi);
  if (b.n < 5) continue;
  console.log(`[${lo.toFixed(2)},${hi.toFixed(2)})`.padEnd(15), String(b.n).padStart(5), b.meanPrice.toFixed(3).padStart(10), b.yesRate.toFixed(3).padStart(9), ((b.grossRet >= 0 ? "+" : "") + b.grossRet.toFixed(3)).padStart(11), ((b.netRet >= 0 ? "+" : "") + b.netRet.toFixed(3)).padStart(13));
}

// (B2) SIGNIFICANCE of the top bot's realized edge (is +PnL real or noise on N bets?)
if (bots.length) {
  const [bw] = bots[0]; const bt = all.filter((t) => t.w === bw).sort((a, b) => a.ts - b.ts);
  const rets = bt.map((t) => { const cost = t.s === "BUY" ? t.p : 1 - t.p; const c = Math.min(0.999, cost + 0.02); const payoff = t.s === "BUY" ? t.win : 1 - t.win; return (payoff - c) / c; });
  const s = summarizeReturnSeries(rets); const dsr = computeDeflatedSharpeRatio(rets, { trialCount: 1 });
  const bb = blockBootstrapConfidenceInterval(rets, { statistic: "mean", iterations: 3000, blockLength: 1, seed: "wx" });
  console.log(`\n(B2) TOP BOT ${bw.slice(0, 10)}… realized (net +2c): n=${rets.length} meanRet=${s.mean.toFixed(4)} sharpe=${s.sharpe.toFixed(3)} DSR@N=1=${dsr.deflatedProbability.toFixed(3)} mean95CI=[${bb.lower.toFixed(4)},${bb.upper.toFixed(4)}]`);
  console.log(`   gross PnL (no spread): $${W.get(bw)!.pnl.toFixed(0)} on $${W.get(bw)!.vol.toFixed(0)} vol (${(100 * W.get(bw)!.pnl / Math.max(1, W.get(bw)!.vol)).toFixed(2)}% of volume)`);
}
console.log("\n=== verdict inputs: edge requires YESrate>=meanPrice AND netRet>0 AND DSR/CI significant ===");
writeFileSync(`${DIR}/weather.json`, JSON.stringify({ markets: markets.length, trades: all.length, bots: bots.map(([w, x]) => ({ w, ...x, winRate: +(x.wins / x.n).toFixed(3) })) }, null, 2));
