/**
 * Campaign-D — is the "empirical-q Kelly profit" real, or in-sample look-ahead?
 * Fit the empirical calibration curve on a TRAIN split (earliest 60% by resolution time), then size
 * Kelly on the UNSEEN TEST split (latest 40%). If the profit vanishes OOS, it was look-ahead.
 * Run: npx tsx scripts/campaign-D/mm_oos_check.ts
 */
import { readFileSync } from "node:fs";
const H = 0.01, B0 = 1000;
type Row = { resYes: number; p_24h: number | null; endTs: number };
const rows: Row[] = readFileSync("output/campaign-D/calibration.jsonl", "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const data = rows.filter((r) => r.p_24h != null && r.p_24h > 0.005 && r.p_24h < 0.995).sort((a, b) => a.endTs - b.endTs);
const cut = Math.floor(data.length * 0.6);
const train = data.slice(0, cut), test = data.slice(cut);

const edges = [0, .02, .05, .1, .15, .2, .3, .4, .5, .6, .7, .8, .9, .95, 1.01];
function fitEmp(rs: Row[]) { const c = edges.slice(0, -1).map(() => ({ n: 0, y: 0 })); for (const r of rs) { const i = edges.findIndex((e, k) => r.p_24h! >= e && r.p_24h! < edges[k + 1]); if (i >= 0) { c[i].n++; c[i].y += r.resYes; } } return (p: number) => { const i = edges.findIndex((e, k) => p >= e && p < edges[k + 1]); return c[i] && c[i].n >= 8 ? c[i].y / c[i].n : p; }; }
const empTrain = fitEmp(train), empAll = fitEmp(data);

const rWin = (c: number) => (1 - c) / c;
function kellyGrow(bets: { c: number; win: number; q: number }[], frac: number) {
  let B = B0; for (const bet of bets) { const b = rWin(bet.c); const fk = Math.max(0, (b * bet.q - (1 - bet.q)) / b) * frac; B *= (1 + Math.min(0.99, fk) * (bet.win ? rWin(bet.c) : -1)); } return B;
}
// "bet the favorite" stream on the TEST split, q from train-fit vs all-fit (look-ahead)
function favStream(rs: Row[], emp: (p: number) => number) {
  return rs.map((r) => { const fav = r.p_24h! >= 0.5; const c = Math.min(0.999, (fav ? r.p_24h! : 1 - r.p_24h!) + H); return { c, win: fav ? r.resYes : 1 - r.resYes, q: fav ? emp(r.p_24h!) : 1 - emp(r.p_24h!) }; });
}
console.log(`=== OOS look-ahead check | train=${train.length} test=${test.length} bets ===`);
console.log(`Bet-the-favorite, full Kelly:`);
console.log(`  q = ALL-data empirical (LOOK-AHEAD)        -> terminal $${kellyGrow(favStream(test, empAll), 1).toFixed(0)}`);
console.log(`  q = TRAIN-only empirical (honest OOS)      -> terminal $${kellyGrow(favStream(test, empTrain), 1).toFixed(0)}`);
console.log(`  q = market price (calibrated, honest)      -> terminal $${kellyGrow(test.map((r) => { const fav = r.p_24h! >= 0.5; const c = Math.min(0.999, (fav ? r.p_24h! : 1 - r.p_24h!) + H); return { c, win: fav ? r.resYes : 1 - r.resYes, q: fav ? r.p_24h! : 1 - r.p_24h! }; }), 1).toFixed(0)}`);
console.log(`(start $${B0}. If TRAIN-only and market-q do NOT beat $${B0}, the all-data 'profit' was look-ahead.)`);
