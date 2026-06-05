/**
 * Campaign-D / PM-cohort-profile — identify the PROVEN-skilled wallet cohort and profile its
 * behaviour, to ground the first-principles reverse-engineering (reproduce the edge WITHOUT
 * following). "Proven skilled" = real TRAIN track record AND skill that PERSISTS into OOS
 * (positive OOS PnL), i.e. not a one-window survivorship artifact.
 *
 * Output: a behavioural fingerprint of the cohort vs the overall population — entry-price regime,
 * timing-to-resolution, sizing, scalp-vs-hold, directional/side bias, PnL concentration — written
 * to output/campaign-D/cohort_profile.json for the RE workflow to consume.
 *
 * Run: npx tsx scripts/campaign-D/cohort_profile.ts [minTrainTrades=15] [topDecile=0.10]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const MIN_TRAIN = Number(process.argv[2] ?? 15);
const TOPQ = Number(process.argv[3] ?? 0.10);
const DIR = "output/campaign-D";
const TCACHE = `${DIR}/trades-cache`;

type Mkt = { id: string; window: "train" | "oos"; winnerIndex: number; endTs: number; vol: number };
const markets: Mkt[] = readFileSync(`${DIR}/copy-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
type Trade = { w: string; s: "BUY" | "SELL"; oi: number; p: number; sz: number; ts: number };
const tradesOf = (id: string): Trade[] => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };
const pnl = (t: Trade, win: number) => (t.s === "BUY" ? t.sz * (win - t.p) : t.sz * (t.p - win));

type Rec = { trainPnl: number; trainVol: number; trainN: number; trainWins: number;
  oosPnl: number; oosN: number; trades: { p: number; sz: number; ts: number; s: string; onWinner: boolean; hrsBefore: number; mkt: string }[];
  marketsSet: Set<string>; scalpMarkets: Set<string> };
const W = new Map<string, Rec>();
const get = (w: string): Rec => { let x = W.get(w); if (!x) { x = { trainPnl: 0, trainVol: 0, trainN: 0, trainWins: 0, oosPnl: 0, oosN: 0, trades: [], marketsSet: new Set(), scalpMarkets: new Set() }; W.set(w, x); } return x; };

// track BUY/SELL presence per (wallet,market) to detect scalping
const sides = new Map<string, Set<string>>();
for (const m of markets) {
  if (!cached.has(m.id)) continue;
  for (const t of tradesOf(m.id)) {
    if (!Number.isFinite(t.p) || !Number.isFinite(t.sz) || t.sz <= 0) continue;
    const x = get(t.w);
    const win = t.oi === m.winnerIndex ? 1 : 0;
    const onWinner = (t.s === "BUY") === (t.oi === m.winnerIndex);
    x.marketsSet.add(m.id);
    const key = `${t.w}|${m.id}`; let ss = sides.get(key); if (!ss) { ss = new Set(); sides.set(key, ss); } ss.add(t.s);
    x.trades.push({ p: t.p, sz: t.sz, ts: t.ts, s: t.s, onWinner, hrsBefore: (m.endTs - t.ts) / 3600, mkt: m.id });
    if (m.window === "train") { x.trainPnl += pnl(t, win); x.trainVol += t.sz * t.p; x.trainN++; if (onWinner) x.trainWins++; }
    else { x.oosPnl += pnl(t, win); x.oosN++; }
  }
}
for (const [key, ss] of sides) if (ss.size === 2) { const w = key.split("|")[0]; W.get(w)?.scalpMarkets.add(key.split("|")[1]); }

// --- cohort = real train record, top-decile train ROI, AND positive OOS PnL (persistence) ---
const eligible = [...W.entries()].filter(([, x]) => x.trainN >= MIN_TRAIN && x.oosN >= 1);
const byRoi = [...eligible].sort((a, b) => (b[1].trainPnl / Math.max(1, b[1].trainVol)) - (a[1].trainPnl / Math.max(1, a[1].trainVol)));
const topCut = Math.max(1, Math.floor(byRoi.length * TOPQ));
const topByTrain = byRoi.slice(0, topCut);
const cohort = topByTrain.filter(([, x]) => x.oosPnl > 0);             // persistence filter
const persistenceRate = cohort.length / Math.max(1, topByTrain.length);

console.log(`\n=== PM-cohort-profile ===`);
console.log(`wallets=${W.size}  eligible(>=${MIN_TRAIN} train & OOS-active)=${eligible.length}`);
console.log(`top-decile train ROI=${topByTrain.length}  -> of those, OOS-positive (persistent)=${cohort.length}  (persistence rate ${(persistenceRate * 100).toFixed(1)}%)`);

// helper feature extractors over a wallet subset
function profile(group: [string, Rec][]) {
  const tr = group.flatMap(([, x]) => x.trades);
  const n = tr.length || 1;
  const priceBuckets = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0];
  const pb = priceBuckets.slice(0, -1).map((lo, i) => {
    const hi = priceBuckets[i + 1]; const c = tr.filter((t) => t.p >= lo && t.p < hi).length;
    return { range: `[${lo},${hi})`, share: +(c / n).toFixed(3) };
  });
  const med = (arr: number[]) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const scalpPairs = group.reduce((s, [, x]) => s + x.scalpMarkets.size, 0);
  const totalPairs = group.reduce((s, [, x]) => s + x.marketsSet.size, 0) || 1;
  return {
    wallets: group.length,
    trades: tr.length,
    avgTradesPerWallet: +(tr.length / (group.length || 1)).toFixed(1),
    medianSizeShares: +med(tr.map((t) => t.sz)).toFixed(1),
    meanEntryPrice: +(tr.reduce((s, t) => s + t.p, 0) / n).toFixed(3),
    entryPriceBuckets: pb,
    medianHrsBeforeResolution: +med(tr.map((t) => t.hrsBefore)).toFixed(1),
    pctBuy: +(tr.filter((t) => t.s === "BUY").length / n).toFixed(3),
    pctOnEventualWinner: +(tr.filter((t) => t.onWinner).length / n).toFixed(3),
    scalpRate: +(scalpPairs / totalPairs).toFixed(3),
  };
}

const cohortProf = profile(cohort);
const popProf = profile(eligible);
console.log("\n-- cohort (proven-skilled) --"); console.log(JSON.stringify(cohortProf, null, 1));
console.log("\n-- population (all eligible) --"); console.log(JSON.stringify(popProf, null, 1));

// what distinguishes the cohort (cheap deltas)
const delta = {
  meanEntryPrice: +(cohortProf.meanEntryPrice - popProf.meanEntryPrice).toFixed(3),
  medianHrsBeforeResolution: +(cohortProf.medianHrsBeforeResolution - popProf.medianHrsBeforeResolution).toFixed(1),
  pctOnEventualWinner: +(cohortProf.pctOnEventualWinner - popProf.pctOnEventualWinner).toFixed(3),
  scalpRate: +(cohortProf.scalpRate - popProf.scalpRate).toFixed(3),
  pctBuy: +(cohortProf.pctBuy - popProf.pctBuy).toFixed(3),
};
console.log("\n-- cohort MINUS population (behavioural fingerprint) --"); console.log(JSON.stringify(delta, null, 1));

const out = {
  generatedFor: "first-principles reverse-engineering",
  params: { MIN_TRAIN, TOPQ },
  counts: { wallets: W.size, eligible: eligible.length, topByTrain: topByTrain.length, cohort: cohort.length, persistenceRate: +persistenceRate.toFixed(3) },
  cohortProfile: cohortProf, populationProfile: popProf, fingerprintDelta: delta,
  cohortWallets: cohort.map(([w, x]) => ({ w, trainPnl: +x.trainPnl.toFixed(0), oosPnl: +x.oosPnl.toFixed(0), trainN: x.trainN, oosN: x.oosN, markets: x.marketsSet.size })),
};
writeFileSync(`${DIR}/cohort_profile.json`, JSON.stringify(out, null, 2));
console.log(`\nWrote ${DIR}/cohort_profile.json (cohort=${cohort.length} wallets)`);
