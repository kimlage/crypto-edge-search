/**
 * AUDIT re-derivation: what is the ECONOMICALLY CORRECT financing charge for the
 * dated-futures cash-and-carry, and does the headline edge survive it?
 *
 * The trade = LONG 1 unit spot + SHORT 1 unit dated future (dollar-neutral, UNLEVERED).
 * Daily P&L = spotRet - futRet  (the production script, line 161). No financing charged.
 *
 * The audit charged a "borrow" of 2/4/6/8%/yr and asserted ~6-8%/yr is "realistic",
 * concluding the edge is "fully consumed". This audit-of-the-audit pins down the RIGHT
 * charge:
 *
 *   - The long-spot leg ties up CASH. Its correct charge is the RISK-FREE opportunity
 *     cost (~4.5%/yr T-bills) IF you fund it with your own cash and post spot as collateral.
 *     (The perp-spot sibling uses exactly RISK_FREE_APR = 0.045.)
 *   - There is NO asset-borrow on the long-spot leg (you OWN the spot). A 6-8% "borrow"
 *     on full notional is the cost of SHORTING spot, which this trade does not do.
 *   - The short-future leg requires margin (a fraction), not full-notional borrow.
 *
 * So the conservative-but-correct charge is RF (4.5%) on the spot notional. A genuinely
 * adversarial charge is RF + a margin/roll spread. We report a sweep and locate where
 * the verdict tips, and compute DSR @ honest N=16 at the RIGHT charge.
 *
 * We ALSO verify the trade is unlevered (gross exposure ~ 1x spot per active leg) so
 * that "full notional" = 1x, not Nx — i.e., this is NOT the (i) lever-N-charge-1 leak.
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
const RF = 0.045; // T-bill opportunity cost, same constant the perp-spot sibling uses

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
type Leg = { date: string; ret: number; held: boolean };
function simulate(
  c: Contract, annHurdle: number, exitBackwardation: boolean, purgePerp: boolean,
  perpAnn: Map<string, number>, financeAnn: number,
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
      if (annPrev > annHurdle) { open = true; out.push({ date: cur.date, ret: -2 * TAKER, held: false }); }
    }
    if (!open) continue;
    const spotRet = cur.spot / prev.spot - 1;
    const futRet = cur.future / prev.future - 1;
    let dayRet = spotRet - futRet - financeAnn / TRADING_DAYS;
    if (exitBackwardation && cur.basis < 0) { dayRet -= 2 * TAKER; out.push({ date: cur.date, ret: dayRet, held: true }); open = false; closed = true; continue; }
    if (i === rows.length - 1) { dayRet -= 2 * TAKER; out.push({ date: cur.date, ret: dayRet, held: true }); open = false; continue; }
    out.push({ date: cur.date, ret: dayRet, held: true });
  }
  return out;
}
function buildDaily(contracts: Contract[], h: number, x: boolean, p: boolean, perp: Map<string, Map<string, number>>, fin: number): { map: Map<string, number>; held: Map<string, number> } {
  const byDate = new Map<string, number[]>();
  const heldCount = new Map<string, number>();
  for (const c of contracts) {
    for (const l of simulate(c, h, x, p, perp.get(c.coin)!, fin)) {
      const arr = byDate.get(l.date) ?? []; arr.push(l.ret); byDate.set(l.date, arr);
      if (l.held) heldCount.set(l.date, (heldCount.get(l.date) ?? 0) + 1);
    }
  }
  const map = new Map<string, number>();
  for (const [d, arr] of byDate) map.set(d, arr.reduce((a, b) => a + b, 0) / arr.length);
  return { map, held: heldCount };
}
function portfolio(btc: Contract[], eth: Contract[], h: number, x: boolean, p: boolean, perp: Map<string, Map<string, number>>, fin: number): { daily: number[]; avgActiveLegs: number } {
  const b = buildDaily(btc, h, x, p, perp, fin);
  const e = buildDaily(eth, h, x, p, perp, fin);
  const dates = [...new Set([...b.map.keys(), ...e.map.keys()])].sort();
  const daily: number[] = [];
  let totalLegs = 0, daysWithLegs = 0;
  for (const d of dates) {
    const parts: number[] = [];
    if (b.map.has(d)) parts.push(b.map.get(d)!);
    if (e.map.has(d)) parts.push(e.map.get(d)!);
    if (parts.length) daily.push(parts.reduce((a, x) => a + x, 0) / parts.length);
    const legs = (b.held.get(d) ?? 0) + (e.held.get(d) ?? 0);
    if (legs > 0) { totalLegs += legs; daysWithLegs++; }
  }
  return { daily, avgActiveLegs: daysWithLegs ? totalLegs / daysWithLegs : 0 };
}

const btc = loadContracts("BTC");
const eth = loadContracts("ETH");
const perp = new Map([["BTC", perpAnnFundingByDate("BTC")], ["ETH", perpAnnFundingByDate("ETH")]]);

// (A) leverage check: how many legs are active per coin per day? The portfolio averages
//     across active legs, so per-coin gross spot exposure is ~1x (NOT Nx). Verify.
const p0 = portfolio(btc, eth, 0.06, true, true, perp, 0);
console.log(`=== (A) LEVERAGE / EXPOSURE CHECK ===`);
console.log(`  avg # active contract-legs on held days = ${p0.avgActiveLegs.toFixed(2)}`);
console.log(`  portfolio = equal-weight across active legs => per-leg notional is 1/(#legs);`);
console.log(`  gross spot exposure per coin ~1x, total book ~1x spot (UNLEVERED cash-and-carry).`);
console.log(`  => 'full notional' financing = 1x spot, NOT the lever-N-charge-1 leak (error class i).`);

// (B) financing sweep, with the ECONOMICALLY CORRECT charge highlighted
console.log(`\n=== (B) FINANCING SWEEP (annualized charge on 1x spot notional) ===`);
const rows: any[] = [];
for (const fin of [0, RF, 0.06, 0.08, 0.10]) {
  const { daily } = portfolio(btc, eth, 0.06, true, true, perp, fin);
  const s = summarizeReturnSeries(daily);
  const dsr = computeDeflatedSharpeRatio(daily, { trialCount: 16 });
  const tag = fin === RF ? "  <== RF opportunity cost (CORRECT charge for unlevered carry)"
    : fin === 0 ? "  (production script: ZERO financing)" : "";
  const row = {
    financeAnnPct: +(fin * 100).toFixed(2),
    annSharpe: +(s.sharpe * Math.sqrt(TRADING_DAYS)).toFixed(3),
    annRetPct: +(s.mean * TRADING_DAYS * 100).toFixed(2),
    monthlyAt100k: +(s.mean * 30.4 * 100000).toFixed(0),
    tStat: +(s.sharpe * Math.sqrt(daily.length)).toFixed(2),
    dsrAtN16: +dsr.deflatedProbability.toFixed(4),
  };
  rows.push(row);
  console.log(`  fin=${(fin * 100).toFixed(1).padStart(5)}%/yr  Sharpe=${row.annSharpe.toFixed(3).padStart(6)}  annRet=${row.annRetPct.toFixed(2).padStart(6)}%  $/mo@100k=${String(row.monthlyAt100k).padStart(5)}  t=${row.tStat.toFixed(2).padStart(5)}  DSR@16=${row.dsrAtN16.toFixed(3)}${tag}`);
}

// (C) where does the verdict tip? find break-even financing for Sharpe and for DSR>=0.95
console.log(`\n=== (C) VERDICT TIPPING POINTS ===`);
let beSharpe = NaN, beDSR = NaN, beRet = NaN;
for (let fin = 0; fin <= 0.12; fin += 0.0025) {
  const { daily } = portfolio(btc, eth, 0.06, true, true, perp, fin);
  const s = summarizeReturnSeries(daily);
  const annS = s.sharpe * Math.sqrt(TRADING_DAYS);
  const dsr = computeDeflatedSharpeRatio(daily, { trialCount: 16 }).deflatedProbability;
  if (isNaN(beRet) && s.mean <= 0) beRet = fin;
  if (isNaN(beSharpe) && annS < 1.0) beSharpe = fin;
  if (isNaN(beDSR) && dsr < 0.95) beDSR = fin;
}
console.log(`  financing where annRet -> 0:        ~${(beRet * 100).toFixed(1)}%/yr`);
console.log(`  financing where ann Sharpe < 1.0:   ~${(beSharpe * 100).toFixed(2)}%/yr`);
console.log(`  financing where DSR@16 drops < 0.95:~${(beDSR * 100).toFixed(2)}%/yr`);

fs.writeFileSync(path.join(ROOT, "output/edgehunt-audit/dated_financing_correct_charge.json"),
  JSON.stringify({ avgActiveLegs: p0.avgActiveLegs, RF, sweep: rows, tippingPoints: { breakEvenRetAnnPct: +(beRet * 100).toFixed(2), sharpeBelow1AnnPct: +(beSharpe * 100).toFixed(2), dsrBelow95AnnPct: +(beDSR * 100).toFixed(2) } }, null, 2));
console.log(`\nwrote output/edgehunt-audit/dated_financing_correct_charge.json`);
