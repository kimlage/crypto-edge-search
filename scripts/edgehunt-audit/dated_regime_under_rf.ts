/**
 * AUDIT: does the SUMMARY's decisive claim -- "dated carry SURVIVES at Sharpe ~2.87 when
 * perp funding <5%/yr, proving a term-structure edge BEYOND perp funding" -- survive the
 * correct RF financing charge? The whole PROMISING case rests on this regime test.
 *
 * We recompute the low-perp / high-perp regime split WITH the RF (4.5%/yr) financing charge
 * on the 1x spot notional, exactly as the perp-spot sibling charges it.
 */
import * as fs from "fs";
import * as path from "path";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";

const ROOT = process.cwd();
const TAKER = 4 / 10000;
const TRADING_DAYS = 365;
const RF = 0.045;

type Row = { date: string; future: number; spot: number; basis: number };
type Contract = { symbol: string; coin: string; deliveryDate: string; rows: Row[] };
function loadContracts(coin: "BTC" | "ETH"): Contract[] {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, `output/dated-futures/${coin}_quarterly_basis.json`), "utf8")) as Array<{ symbol: string; deliveryDate: string; rows: Row[] }>;
  return raw.map((c) => ({ ...c, coin }));
}
function perpAnnFundingByDate(coin: "BTC" | "ETH", win = 30): Map<string, number> {
  const fund = JSON.parse(fs.readFileSync(path.join(ROOT, `output/funding/${coin}USDT_funding_8h.json`), "utf8")) as Array<{ fundingTime: number; fundingRate: number }>;
  const pf = new Map<string, number>();
  for (const f of fund) { const d = new Date(f.fundingTime).toISOString().slice(0, 10); pf.set(d, (pf.get(d) ?? 0) + f.fundingRate); }
  const dates = [...pf.keys()].sort();
  const idx = new Map(dates.map((d, i) => [d, i]));
  const out = new Map<string, number>();
  for (const d of dates) { const i = idx.get(d)!; if (i < win - 1) continue; let s = 0; for (let k = i - win + 1; k <= i; k++) s += pf.get(dates[k])!; out.set(d, (s / win) * TRADING_DAYS); }
  return out;
}
const annB = (basis: number, dte: number) => (dte <= 0 ? 0 : basis * (TRADING_DAYS / dte));
function simulate(c: Contract, h: number, x: boolean, p: boolean, perpAnn: Map<string, number>, fin: number) {
  const delivery = new Date(c.deliveryDate).getTime();
  const rows = c.rows; const out: { date: string; ret: number }[] = [];
  let open = false, closed = false;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const dtePrev = Math.max(1, Math.round((delivery - new Date(prev.date).getTime()) / 86400000));
    let annPrev = annB(prev.basis, dtePrev);
    if (p) { const pf = perpAnn.get(prev.date); if (pf !== undefined) annPrev -= pf; }
    if (!open && !closed) { if (annPrev > h) { open = true; out.push({ date: cur.date, ret: -2 * TAKER }); } }
    if (!open) continue;
    let dayRet = (cur.spot / prev.spot - 1) - (cur.future / prev.future - 1) - fin / TRADING_DAYS;
    if (x && cur.basis < 0) { dayRet -= 2 * TAKER; out.push({ date: cur.date, ret: dayRet }); open = false; closed = true; continue; }
    if (i === rows.length - 1) { dayRet -= 2 * TAKER; out.push({ date: cur.date, ret: dayRet }); open = false; continue; }
    out.push({ date: cur.date, ret: dayRet });
  }
  return out;
}
function buildDaily(cs: Contract[], perp: Map<string, Map<string, number>>, fin: number) {
  const byDate = new Map<string, number[]>();
  for (const c of cs) for (const l of simulate(c, 0.06, true, true, perp.get(c.coin)!, fin)) { const a = byDate.get(l.date) ?? []; a.push(l.ret); byDate.set(l.date, a); }
  const map = new Map<string, number>();
  for (const [d, arr] of byDate) map.set(d, arr.reduce((a, b) => a + b, 0) / arr.length);
  return map;
}
const btc = loadContracts("BTC"), eth = loadContracts("ETH");
const perp = new Map([["BTC", perpAnnFundingByDate("BTC")], ["ETH", perpAnnFundingByDate("ETH")]]);
const perpAnnComb = new Map<string, number>();
for (const d of new Set([...perp.get("BTC")!.keys(), ...perp.get("ETH")!.keys()])) {
  const a: number[] = []; if (perp.get("BTC")!.has(d)) a.push(perp.get("BTC")!.get(d)!); if (perp.get("ETH")!.has(d)) a.push(perp.get("ETH")!.get(d)!);
  if (a.length) perpAnnComb.set(d, a.reduce((x, y) => x + y, 0) / a.length);
}

function regimeSplit(fin: number) {
  const b = buildDaily(btc, perp, fin), e = buildDaily(eth, perp, fin);
  const dates = [...new Set([...b.keys(), ...e.keys()])].sort();
  const map = new Map<string, number>();
  for (const d of dates) { const parts: number[] = []; if (b.has(d)) parts.push(b.get(d)!); if (e.has(d)) parts.push(e.get(d)!); if (parts.length) map.set(d, parts.reduce((a, x) => a + x, 0) / parts.length); }
  const lo: number[] = [], hi: number[] = [];
  for (const d of [...map.keys()].sort()) { const pf = perpAnnComb.get(d); if (pf === undefined) continue; (pf < 0.05 ? lo : hi).push(map.get(d)!); }
  return { lo: summarizeReturnSeries(lo), hi: summarizeReturnSeries(hi), nLo: lo.length, nHi: hi.length };
}

console.log("=== REGIME (low-perp <5%/yr vs high-perp) under financing charges ===");
const out: any[] = [];
for (const fin of [0, RF]) {
  const r = regimeSplit(fin);
  const row = {
    financeAnnPct: fin * 100,
    lowPerp_annRetPct: +(r.lo.mean * TRADING_DAYS * 100).toFixed(2),
    lowPerp_sharpe: +(r.lo.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(2),
    lowPerp_nDays: r.nLo,
    highPerp_annRetPct: +(r.hi.mean * TRADING_DAYS * 100).toFixed(2),
    highPerp_sharpe: +(r.hi.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(2),
    highPerp_nDays: r.nHi,
  };
  out.push(row);
  console.log(`  fin=${(fin*100).toFixed(1)}%/yr  LOW-perp: annRet=${row.lowPerp_annRetPct}%  Sharpe=${row.lowPerp_sharpe}  (n=${row.lowPerp_nDays})   HIGH-perp: annRet=${row.highPerp_annRetPct}%  Sharpe=${row.highPerp_sharpe}  (n=${row.highPerp_nDays})`);
}
console.log("\nInterpretation: if the low-perp Sharpe stays well above the high-perp one's");
console.log("decay, the term-structure-beyond-perp claim is intact in DIRECTION; but the");
console.log("MAGNITUDE/investability still hinges on the RF-charged headline above.");
fs.writeFileSync(path.join(ROOT, "output/edgehunt-audit/dated_regime_under_rf.json"), JSON.stringify(out, null, 2));
