/**
 * Campaign-D — derive the calibration dataset from TRADE TAPES (not prices-history).
 *
 * Why: CLOB /prices-history is PURGED for all but the most recent ~weeks of resolved markets, so it
 * cannot price the historical bulk. data-api /trades retains the FULL tape, so we read the YES price
 * at a fixed lead time from the last YES-outcome trade before that time. Reuses the tapes already
 * pulled for the copy-trading test (output/campaign-D/trades-cache/) — zero extra fetching.
 *
 * Caveat (documented): the tape sample is the copy-trading market sample (volume-ranked, recent
 * windows), so it is liquidity/favorite-skewed and under-covers the deep-longshot tail. A broader
 * stratified tape pull is the follow-up for full-spectrum calibration.
 *
 * Run: npx tsx scripts/campaign-D/tape_calib.ts   ->  output/campaign-D/calibration.jsonl
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";

const DIR = "output/campaign-D";
const TCACHE = `${DIR}/trades-cache`;
const OUT = `${DIR}/calibration.jsonl`;

type Mkt = { id: string; window: string; winnerIndex: number; endTs: number; vol: number; outcomes: string[]; negRisk?: unknown };
function load(f: string): Mkt[] { try { return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return []; } }
// merge the copy-trade sample + the stratified calibration sample, dedupe by id
const byId = new Map<string, Mkt>();
for (const m of [...load(`${DIR}/copy-markets.jsonl`), ...load(`${DIR}/calib-markets.jsonl`)]) if (!byId.has(m.id)) byId.set(m.id, m);
const markets: Mkt[] = [...byId.values()];
type Trade = { w: string; s: string; oi: number; p: number; sz: number; ts: number };

function priceAtOrBefore(yesTrades: Trade[], targetTs: number): number | null {
  let best: number | null = null;
  for (const t of yesTrades) { if (t.ts <= targetTs) best = t.p; else break; }
  return best;
}

let n = 0, written = 0;
writeFileSync(OUT, "");
for (const m of markets) {
  const cf = `${TCACHE}/${m.id}.json`;
  if (!existsSync(cf)) continue;
  let trades: Trade[]; try { trades = JSON.parse(readFileSync(cf, "utf8")); } catch { continue; }
  const yesIdx = m.outcomes.indexOf("yes");
  if (yesIdx < 0) continue;
  // YES price path = prices of trades on the YES outcome, sorted by time
  const yesTrades = trades.filter((t) => t.oi === yesIdx && Number.isFinite(t.p)).sort((a, b) => a.ts - b.ts);
  if (yesTrades.length < 5) continue;
  const resYes = m.winnerIndex === yesIdx ? 1 : 0;
  const row = {
    id: m.id, q: m.id, endTs: m.endTs, vol: m.vol, resYes, negRisk: m.negRisk === true, spreadField: null, nPoints: yesTrades.length,
    p_7d: priceAtOrBefore(yesTrades, m.endTs - 7 * 86400),
    p_24h: priceAtOrBefore(yesTrades, m.endTs - 86400),
    p_1h: priceAtOrBefore(yesTrades, m.endTs - 3600),
    p_close: yesTrades[yesTrades.length - 1].p,
    firstTs: yesTrades[0].ts, lastTs: yesTrades[yesTrades.length - 1].ts,
  };
  const line = JSON.stringify(row); n++;
  // only keep markets with a usable 24h-lead price strictly inside (0,1)
  if (row.p_24h != null && row.p_24h > 0 && row.p_24h < 1) { writeFileSync(OUT, line + "\n", { flag: "a" }); written++; }
}
console.log(`[tape_calib] markets=${markets.length} withTape&YES=${n} usable(p_24h in (0,1))=${written} -> ${OUT}`);
