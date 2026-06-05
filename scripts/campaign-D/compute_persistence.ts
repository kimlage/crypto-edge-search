/**
 * Campaign-D — committed, auditable computation of the wallet-skill PERSISTENCE statistics that were
 * previously hand-computed inline (the audit flagged the −$90k figure as unauditable). Emits every
 * number cited in RESULTS.md §2 to output/campaign-D/persistence.json so they are reproducible.
 *
 * Run: npx tsx scripts/campaign-D/compute_persistence.ts [minTrainTrades=15]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const MIN_TRAIN = Number(process.argv[2] ?? 15);
const DIR = "output/campaign-D"; const TCACHE = `${DIR}/trades-cache`;
type Mkt = { id: string; window: "train" | "oos"; winnerIndex: number };
const markets: Mkt[] = readFileSync(`${DIR}/copy-markets.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cached = new Set(readdirSync(TCACHE).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
type T = { w: string; s: "BUY" | "SELL"; oi: number; p: number; sz: number };
const trades = (id: string): T[] => { try { return JSON.parse(readFileSync(`${TCACHE}/${id}.json`, "utf8")); } catch { return []; } };

type W = { tp: number; tv: number; tn: number; tw: number; op: number; on: number; ow: number };
const M = new Map<string, W>();
const g = (w: string) => { let x = M.get(w); if (!x) { x = { tp: 0, tv: 0, tn: 0, tw: 0, op: 0, on: 0, ow: 0 }; M.set(w, x); } return x; };
for (const m of markets) {
  if (!cached.has(m.id)) continue;
  for (const t of trades(m.id)) {
    if (!Number.isFinite(t.p) || !Number.isFinite(t.sz) || t.sz <= 0) continue;
    const win = t.oi === m.winnerIndex ? 1 : 0;
    const onWin = (t.s === "BUY") === (t.oi === m.winnerIndex);
    const pnl = t.s === "BUY" ? t.sz * (win - t.p) : t.sz * (t.p - win);
    const x = g(t.w);
    if (m.window === "train") { x.tp += pnl; x.tv += t.sz * t.p; x.tn++; if (onWin) x.tw++; }
    else { x.op += pnl; x.on++; if (onWin) x.ow++; }
  }
}
const elig = [...M.entries()].filter(([, x]) => x.tn >= MIN_TRAIN && x.on >= 3);
const popPos = elig.filter(([, x]) => x.op > 0).length / elig.length;
const byRoi = [...elig].sort((a, b) => (b[1].tp / Math.max(1, b[1].tv)) - (a[1].tp / Math.max(1, a[1].tv)));
const k = Math.max(1, Math.floor(elig.length / 10));
const top = byRoi.slice(0, k), bot = byRoi.slice(-k);
const posRate = (s: [string, W][]) => s.filter(([, x]) => x.op > 0).length / s.length;
const sumOos = (s: [string, W][]) => s.reduce((a, [, x]) => a + x.op, 0);
const corr = (xs: number[], ys: number[]) => { const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } return sxy / Math.sqrt(Math.max(1e-12, sxx * syy)); };
const wr = corr(elig.map(([, x]) => x.tw / x.tn), elig.map(([, x]) => x.ow / x.on));
const roiC = corr(elig.map(([, x]) => x.tp / Math.max(1, x.tv)), elig.map(([, x]) => x.op / Math.max(1, x.on)));
const out = {
  minTrainTrades: MIN_TRAIN, wallets: M.size, eligible: elig.length,
  population_OOS_positive_rate: +popPos.toFixed(3),
  topDecile: { n: top.length, OOS_positive_rate: +posRate(top).toFixed(3), total_OOS_PnL: +sumOos(top).toFixed(0) },
  bottomDecile: { n: bot.length, OOS_positive_rate: +posRate(bot).toFixed(3), total_OOS_PnL: +sumOos(bot).toFixed(0) },
  topDecile_lift_over_population: +(posRate(top) - popPos).toFixed(3),
  trainWinrate_to_OOSWinrate_corr: +wr.toFixed(3),
  trainROI_to_OOSreturn_corr: +roiC.toFixed(3),
};
writeFileSync(`${DIR}/persistence.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
