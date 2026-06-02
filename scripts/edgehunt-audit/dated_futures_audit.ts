/**
 * AUDIT spot-check for the dated-futures cash-and-carry headline lead.
 * Replicates the primary config minimally and probes:
 *  (1) argmax check: is h0.06_x1_p1 the best of the 16-config grid?
 *  (2) variance-gaming: does the residual (beta<0) inflate the PASSING gates
 *      vs a plain weekly Sharpe t-stat?
 *  (3) financing/borrow leak: how much does a realistic borrow charge on the
 *      FULL notional erode the raw Sharpe 2.27?
 *  (4) regime-window: is the edge a single-period artifact (per-year breakdown)?
 */
import * as fs from "fs";
import * as path from "path";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = process.cwd();
const TAKER = 4 / 10000;
const TRADING_DAYS = 365;

type Row = { date: string; future: number; spot: number; basis: number };
type Contract = { symbol: string; coin: string; deliveryDate: string; rows: Row[] };

function loadContracts(coin: "BTC" | "ETH"): Contract[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/dated-futures/${coin}_quarterly_basis.json`), "utf8"),
  ) as Array<{ symbol: string; deliveryDate: string; rows: Row[] }>;
  return raw.map((c) => ({ ...c, coin }));
}
function perpAnnFundingByDate(coin: "BTC" | "ETH", win = 30): Map<string, number> {
  const fund = JSON.parse(
    fs.readFileSync(path.join(ROOT, `output/funding/${coin}USDT_funding_8h.json`), "utf8"),
  ) as Array<{ fundingTime: number; fundingRate: number }>;
  const pf = new Map<string, number>();
  for (const f of fund) {
    const d = new Date(f.fundingTime).toISOString().slice(0, 10);
    pf.set(d, (pf.get(d) ?? 0) + f.fundingRate);
  }
  const dates = [...pf.keys()].sort();
  const idx = new Map(dates.map((d, i) => [d, i]));
  const out = new Map<string, number>();
  for (const d of dates) {
    const i = idx.get(d)!;
    if (i < win - 1) continue;
    let s = 0;
    for (let k = i - win + 1; k <= i; k++) s += pf.get(dates[k])!;
    out.set(d, (s / win) * TRADING_DAYS);
  }
  return out;
}
function annualizedBasis(basis: number, dte: number): number {
  if (dte <= 0) return 0;
  return basis * (TRADING_DAYS / dte);
}
type Leg = { date: string; ret: number };
// Simplified deterministic sim (NO early-unwind stochastics -> isolate the edge mechanics).
// Optionally apply a borrow/financing charge on the FULL spread notional (annualized -> daily).
function simulate(
  c: Contract, annHurdle: number, exitBackwardation: boolean, purgePerp: boolean,
  perpAnn: Map<string, number>, borrowAnn: number,
): Leg[] {
  const delivery = new Date(c.deliveryDate).getTime();
  const rows = c.rows;
  const out: Leg[] = [];
  let open = false, closed = false;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const dtePrev = Math.max(1, Math.round((delivery - new Date(prev.date).getTime()) / 86400000));
    let annPrev = annualizedBasis(prev.basis, dtePrev);
    if (purgePerp) { const pf = perpAnn.get(prev.date); if (pf !== undefined) annPrev -= pf; }
    if (!open && !closed) {
      if (annPrev > annHurdle) { open = true; out.push({ date: cur.date, ret: -2 * TAKER }); }
    }
    if (!open) continue;
    const spotRet = cur.spot / prev.spot - 1;
    const futRet = cur.future / prev.future - 1;
    let dayRet = spotRet - futRet - borrowAnn / TRADING_DAYS; // borrow on full notional/day
    if (exitBackwardation && cur.basis < 0) { dayRet -= 2 * TAKER; out.push({ date: cur.date, ret: dayRet }); open = false; closed = true; continue; }
    if (i === rows.length - 1) { dayRet -= 2 * TAKER; out.push({ date: cur.date, ret: dayRet }); open = false; continue; }
    out.push({ date: cur.date, ret: dayRet });
  }
  return out;
}
function buildDaily(contracts: Contract[], h: number, x: boolean, p: boolean, perpByCoin: Map<string, Map<string, number>>, borrow: number): Map<string, number> {
  const byDate = new Map<string, number[]>();
  for (const c of contracts) {
    for (const l of simulate(c, h, x, p, perpByCoin.get(c.coin)!, borrow)) {
      const arr = byDate.get(l.date) ?? []; arr.push(l.ret); byDate.set(l.date, arr);
    }
  }
  const map = new Map<string, number>();
  for (const [d, arr] of byDate) map.set(d, arr.reduce((a, b) => a + b, 0) / arr.length);
  return map;
}
function portfolio(btc: Contract[], eth: Contract[], h: number, x: boolean, p: boolean, perp: Map<string, Map<string, number>>, borrow: number): { dates: string[]; daily: number[] } {
  const b = buildDaily(btc, h, x, p, perp, borrow);
  const e = buildDaily(eth, h, x, p, perp, borrow);
  const dates = [...new Set([...b.keys(), ...e.keys()])].sort();
  const daily: number[] = [];
  const keep: string[] = [];
  for (const d of dates) {
    const parts: number[] = [];
    if (b.has(d)) parts.push(b.get(d)!);
    if (e.has(d)) parts.push(e.get(d)!);
    if (parts.length) { daily.push(parts.reduce((a, x) => a + x, 0) / parts.length); keep.push(d); }
  }
  return { dates: keep, daily };
}

const btc = loadContracts("BTC");
const eth = loadContracts("ETH");
const perp = new Map([["BTC", perpAnnFundingByDate("BTC")], ["ETH", perpAnnFundingByDate("ETH")]]);

// (1) argmax check across the 16-config grid (no borrow, deterministic, matches grid spec)
console.log("=== (1) ARGMAX CHECK: grid annualized Sharpe (deterministic, no early-unwind) ===");
const grid: { cfg: string; sharpe: number; n: number }[] = [];
for (const h of [0.0, 0.03, 0.06, 0.09])
  for (const x of [true, false])
    for (const p of [false, true]) {
      const { daily } = portfolio(btc, eth, h, x, p, perp, 0);
      const s = summarizeReturnSeries(daily);
      grid.push({ cfg: `h${h}_x${x ? 1 : 0}_p${p ? 1 : 0}`, sharpe: s.sharpe * Math.sqrt(TRADING_DAYS), n: daily.length });
    }
grid.sort((a, b) => b.sharpe - a.sharpe);
for (const g of grid) console.log(`  ${g.cfg.padEnd(14)} Sharpe=${g.sharpe.toFixed(3)} n=${g.n}${g.cfg === "h0.06_x1_p1" ? "   <-- PRIMARY" : ""}`);
const primaryRank = grid.findIndex((g) => g.cfg === "h0.06_x1_p1") + 1;
console.log(`  PRIMARY rank in grid: ${primaryRank}/16 (1=argmax)`);

// (2) variance-gaming: raw weekly Sharpe vs residualized weekly Sharpe t-stats
console.log("\n=== (2) VARIANCE-GAMING: raw weekly vs residual weekly ===");
const { dates, daily } = portfolio(btc, eth, 0.06, true, true, perp, 0);
function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fd = (firstThu.getUTCDay() + 6) % 7; firstThu.setUTCDate(firstThu.getUTCDate() - fd + 3);
  const wk = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}
const wkAcc = new Map<string, number>();
for (let i = 0; i < dates.length; i++) wkAcc.set(isoWeekKey(dates[i]), (wkAcc.get(isoWeekKey(dates[i])) ?? 0) + daily[i]);
const wkKeys = [...wkAcc.keys()].sort();
const wkRets = wkKeys.map((k) => wkAcc.get(k)!);
const rawW = summarizeReturnSeries(wkRets);
console.log(`  RAW weekly:   Sharpe=${rawW.sharpe.toFixed(4)} mean=${rawW.mean.toExponential(3)} std=${rawW.stdDev.toExponential(3)} n=${wkRets.length}`);
console.log(`  RAW weekly t-stat (Sharpe*sqrt(n)) = ${(rawW.sharpe * Math.sqrt(wkRets.length)).toFixed(2)}`);
console.log(`  RAW weekly Sharpe annualized = ${(rawW.sharpe * Math.sqrt(52)).toFixed(2)}`);
console.log("  (report's residual weekly Sharpe=0.577 -> ann 4.16, t=5.26; raw weekly t above is the honest, non-variance-gamed comparator)");

// (3) financing/borrow leak: erosion under realistic borrow on FULL notional
console.log("\n=== (3) FINANCING/BORROW LEAK: raw Sharpe & annRet vs borrow charge ===");
for (const borrow of [0, 0.02, 0.04, 0.06, 0.08]) {
  const { daily: dd } = portfolio(btc, eth, 0.06, true, true, perp, borrow);
  const s = summarizeReturnSeries(dd);
  console.log(`  borrow=${(borrow * 100).toFixed(0)}%/yr  ann Sharpe=${(s.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(3)}  annRet=${(s.mean * TRADING_DAYS * 100).toFixed(2)}%  monthly$@100k=${(s.mean * 30.4 * 100000).toFixed(0)}`);
}

// (4) regime-window: per-calendar-year raw dated-carry Sharpe & annRet
console.log("\n=== (4) REGIME-WINDOW: per-year raw dated-carry (no borrow) ===");
const byYear = new Map<string, number[]>();
for (let i = 0; i < dates.length; i++) { const y = dates[i].slice(0, 4); const a = byYear.get(y) ?? []; a.push(daily[i]); byYear.set(y, a); }
for (const y of [...byYear.keys()].sort()) {
  const s = summarizeReturnSeries(byYear.get(y)!);
  console.log(`  ${y}: Sharpe=${(s.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(2)}  annRet=${(s.mean * TRADING_DAYS * 100).toFixed(2)}%  n=${byYear.get(y)!.length}`);
}

// (5) DSR on RAW daily (economically meaningful) at honest N=16
const rawAll = summarizeReturnSeries(daily);
const dsr = computeDeflatedSharpeRatio(daily, { trialCount: 16 });
console.log(`\n=== (5) DSR on RAW daily @ N=16: prob=${dsr.deflatedProbability.toFixed(4)} (report claims 0.962) ===`);
console.log(`  raw daily Sharpe=${rawAll.sharpe.toFixed(4)} (ann ${(rawAll.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(2)})`);

fs.writeFileSync(path.join(ROOT, "output/edgehunt-audit/dated_futures_audit.json"), JSON.stringify({ grid, primaryRank, rawWeeklyT: rawW.sharpe * Math.sqrt(wkRets.length), perYear: [...byYear.keys()].sort().map((y) => ({ y, sharpe: summarizeReturnSeries(byYear.get(y)!).sharpe * Math.sqrt(TRADING_DAYS) })) }, null, 2));
