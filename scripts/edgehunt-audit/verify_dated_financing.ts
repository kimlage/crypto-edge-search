/**
 * INDEPENDENT AUDIT RE-DERIVATION — dated-futures cash-and-carry financing charge.
 *
 * Concern under test (MED severity): the committed deepen result charges RF opportunity-cost
 * on 1 unit of capital while the vol-targeted position is ~lev-x levered and the borrow spread
 * IS charged on the full lev notional. Question: is charging RF on 1 unit (vs lev) a real leak?
 *
 * I reconstruct the SAME vol-targeted delta-neutral basis spread the deepen primary config builds
 * (annHurdle=0.06, exitBackwardation, purgePerpAtEntry, chargeEarlyUnwind, volTarget,
 *  chargeFinancing, excessOfRF, seedTag="primary-deepen"), then price the daily return under THREE
 * financing models and report Sharpe / annRet / t / DSR@honestN / monthly@$100k for each:
 *   (A) LEAKED   : borrow on lev, RF on 1 unit          (the committed deepen choice)
 *   (B) CORRECT  : borrow on lev, RF on lev             (audit's claimed correction)
 *   (C) NODOUBLE : financing = borrow-only on lev, no separate RF at all (the "RF already in basis"
 *                  defense taken to its extreme — sanity bound, NOT the claim)
 *
 * Honest N is read from the committed report (meta.honestN). Writes ONLY to output/edgehunt-audit/.
 */
import * as fs from "fs";
import * as path from "path";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt-audit");

const TAKER = 4 / 10000;
const TRADING_DAYS = 365;
const EARLY_UNWIND_DAILY_PROB = 0.004;
const EARLY_UNWIND_SLIP_BPS = 25;
const BORROW_SPREAD_ANN = 0.015;
const VOL_TARGET_ANN = 0.08;
const VOL_WIN = 30;
const VOL_LEV_CAP = 5;

const RF_MONTHLY: Array<[string, number]> = [
  ["2021-09", 0.0005], ["2021-10", 0.0006], ["2021-11", 0.0007], ["2021-12", 0.0008],
  ["2022-01", 0.0010], ["2022-02", 0.0015], ["2022-03", 0.0030], ["2022-04", 0.0050],
  ["2022-05", 0.0080], ["2022-06", 0.0130], ["2022-07", 0.0190], ["2022-08", 0.0240],
  ["2022-09", 0.0290], ["2022-10", 0.0330], ["2022-11", 0.0390], ["2022-12", 0.0430],
  ["2023-01", 0.0460], ["2023-02", 0.0470], ["2023-03", 0.0485], ["2023-04", 0.0500],
  ["2023-05", 0.0510], ["2023-06", 0.0515], ["2023-07", 0.0525], ["2023-08", 0.0530],
  ["2023-09", 0.0530], ["2023-10", 0.0533], ["2023-11", 0.0533], ["2023-12", 0.0533],
  ["2024-01", 0.0533], ["2024-02", 0.0533], ["2024-03", 0.0533], ["2024-04", 0.0533],
  ["2024-05", 0.0533], ["2024-06", 0.0533], ["2024-07", 0.0530], ["2024-08", 0.0525],
  ["2024-09", 0.0500], ["2024-10", 0.0480], ["2024-11", 0.0465], ["2024-12", 0.0445],
  ["2025-01", 0.0440], ["2025-02", 0.0435], ["2025-03", 0.0433], ["2025-04", 0.0433],
  ["2025-05", 0.0430], ["2025-06", 0.0428], ["2025-07", 0.0425], ["2025-08", 0.0423],
  ["2025-09", 0.0420],
];
const RF_MAP = new Map(RF_MONTHLY);
const rfAnnual = (d: string) => RF_MAP.get(d.slice(0, 7)) ?? 0.0425;
const rfDaily = (d: string) => rfAnnual(d) / TRADING_DAYS;

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
const annualizedBasis = (basis: number, dte: number) => (dte <= 0 ? 0 : basis * (TRADING_DAYS / dte));

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

type FinModel = "leaked" | "corrected" | "nodouble";

// returns per-day {date, ret, lev}
function simulateContract(
  c: Contract,
  perpAnn: Map<string, number>,
  rngEarly: () => number,
  fin: FinModel,
): Array<{ date: string; ret: number; lev: number }> {
  const delivery = new Date(c.deliveryDate).getTime();
  const rows = c.rows;
  const out: Array<{ date: string; ret: number; lev: number }> = [];
  let open = false;
  let closed = false;
  const spreadHist: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const dtePrev = Math.max(1, Math.round((delivery - new Date(prev.date).getTime()) / 86400000));
    let annPrev = annualizedBasis(prev.basis, dtePrev);
    const pf = perpAnn.get(prev.date);
    if (pf !== undefined) annPrev = annPrev - pf; // purgePerpAtEntry
    if (!open && !closed) {
      if (annPrev > 0.06) {
        open = true;
        out.push({ date: cur.date, ret: -2 * TAKER, lev: 0 }); // entry cost
      }
    }
    if (!open) continue;

    const spotRet = cur.spot / prev.spot - 1;
    const futRet = cur.future / prev.future - 1;
    const spread = spotRet - futRet;

    let lev = 1;
    if (spreadHist.length >= 10) {
      const w = spreadHist.slice(-VOL_WIN);
      const m = w.reduce((a, b) => a + b, 0) / w.length;
      const v = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1));
      const annVol = v * Math.sqrt(TRADING_DAYS);
      lev = annVol > 1e-9 ? Math.min(VOL_LEV_CAP, VOL_TARGET_ANN / annVol) : VOL_LEV_CAP;
    } else lev = 1;
    spreadHist.push(spread);

    let dayRet = lev * spread;
    // borrow spread always on lev notional (all 3 models agree)
    dayRet -= lev * (BORROW_SPREAD_ANN / TRADING_DAYS);
    // RF opportunity cost — the disputed term
    if (fin === "leaked") dayRet -= rfDaily(cur.date);              // RF on 1 unit
    else if (fin === "corrected") dayRet -= lev * rfDaily(cur.date); // RF on lev
    // "nodouble": no separate RF charge at all

    const levForTrack = lev;

    if (rngEarly() < EARLY_UNWIND_DAILY_PROB) {
      dayRet -= lev * (EARLY_UNWIND_SLIP_BPS / 10000) + 2 * TAKER;
      out.push({ date: cur.date, ret: dayRet, lev: levForTrack });
      open = false; closed = true; continue;
    }
    if (cur.basis < 0) { // exitBackwardation
      dayRet -= 2 * TAKER;
      out.push({ date: cur.date, ret: dayRet, lev: levForTrack });
      open = false; closed = true; continue;
    }
    if (i === rows.length - 1) {
      dayRet -= 2 * TAKER;
      out.push({ date: cur.date, ret: dayRet, lev: levForTrack });
      open = false; continue;
    }
    out.push({ date: cur.date, ret: dayRet, lev: levForTrack });
  }
  return out;
}

function buildPortfolio(coin: "BTC" | "ETH", fin: FinModel): { series: number[]; levs: number[] } {
  const contracts = loadContracts(coin);
  const perpAnn = perpAnnFundingByDate(coin);
  const rngEarly = mulberry32(hash("primary-deepen:early"));
  const byDate = new Map<string, number[]>();
  const levByDate = new Map<string, number[]>();
  for (const c of contracts) {
    const legs = simulateContract(c, perpAnn, rngEarly, fin);
    for (const l of legs) {
      (byDate.get(l.date) ?? byDate.set(l.date, []).get(l.date)!).push(l.ret);
      if (l.lev > 0) (levByDate.get(l.date) ?? levByDate.set(l.date, []).get(l.date)!).push(l.lev);
    }
  }
  const dates = [...byDate.keys()].sort();
  const series = dates.map((d) => {
    const arr = byDate.get(d)!;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  });
  const levs: number[] = [];
  for (const d of dates) {
    const arr = levByDate.get(d);
    if (arr && arr.length) levs.push(arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  return { series, levs };
}

function metricsFor(series: number[], honestN: number) {
  const s = summarizeReturnSeries(series);
  const annF = Math.sqrt(TRADING_DAYS);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / (series.length - 1));
  const dsrN = computeDeflatedSharpeRatio(series, { trialCount: honestN });
  const dsr1 = computeDeflatedSharpeRatio(series, { trialCount: 1 });
  return {
    nDays: series.length,
    sharpeAnnual: s.sharpe * annF,
    annReturnPct: mean * TRADING_DAYS * 100,
    monthlyPctAt100k: mean * (TRADING_DAYS / 12) * 100000,
    meanDaily: mean,
    tStat: (mean / sd) * Math.sqrt(series.length),
    dsrAtHonestN: typeof dsrN === "number" ? dsrN : (dsrN as any).deflatedProbability ?? dsrN,
    dsrAtN1: typeof dsr1 === "number" ? dsr1 : (dsr1 as any).deflatedProbability ?? dsr1,
  };
}

function main() {
  // honest N from the committed report
  const report = JSON.parse(
    fs.readFileSync(path.join(ROOT, "output/edgehunt-deepen/dated_futures_carry_deepen_report.json"), "utf8"),
  );
  const honestN = report.meta.honestN as number;

  // Build BTC+ETH combined portfolio (deepen primary spans both coins per buildDaily over all contracts)
  const out: any = { honestN, models: {} };
  const allLevs: number[] = [];
  for (const fin of ["leaked", "corrected", "nodouble"] as FinModel[]) {
    // pool across coins exactly as deepen buildDaily pools across all contracts
    const byDate = new Map<string, number[]>();
    const levByDate = new Map<string, number[]>();
    for (const coin of ["BTC", "ETH"] as const) {
      const contracts = loadContracts(coin);
      const perpAnn = perpAnnFundingByDate(coin);
      const rngEarly = mulberry32(hash("primary-deepen:early"));
      for (const c of contracts) {
        const legs = simulateContract(c, perpAnn, rngEarly, fin);
        for (const l of legs) {
          if (!byDate.has(l.date)) byDate.set(l.date, []);
          byDate.get(l.date)!.push(l.ret);
          if (l.lev > 0) {
            if (!levByDate.has(l.date)) levByDate.set(l.date, []);
            levByDate.get(l.date)!.push(l.lev);
          }
        }
      }
    }
    const dates = [...byDate.keys()].sort();
    const series = dates.map((d) => {
      const a = byDate.get(d)!;
      return a.reduce((x, y) => x + y, 0) / a.length;
    });
    if (fin === "leaked") {
      for (const d of dates) {
        const a = levByDate.get(d);
        if (a && a.length) allLevs.push(a.reduce((x, y) => x + y, 0) / a.length);
      }
    }
    out.models[fin] = metricsFor(series, honestN);
  }
  out.avgLeverage = allLevs.reduce((a, b) => a + b, 0) / allLevs.length;
  out.maxLeverage = Math.max(...allLevs);
  out.nHeldDays = allLevs.length;
  out.committedReportHeadline = {
    sharpeAnnual: report.primaryExcessOfRF.sharpeAnnual,
    annReturnPct: report.primaryExcessOfRF.annReturnPct,
    monthlyAt100k: report.economics.monthlyAt100k,
    bindingGate: report.bindingGate,
    verdict: report.verdict,
    dsrExcess: report.gates.deflatedSharpe_excess.deflatedProbability,
  };
  out.deltas = {
    sharpe_leaked_to_corrected: [out.models.leaked.sharpeAnnual, out.models.corrected.sharpeAnnual],
    monthly_leaked_to_corrected: [out.models.leaked.monthlyPctAt100k, out.models.corrected.monthlyPctAt100k],
    dsrHonestN_leaked_to_corrected: [out.models.leaked.dsrAtHonestN, out.models.corrected.dsrAtHonestN],
  };
  out.verdict =
    "Charging RF on full levered notional is the economically-correct accounting (own capital opp-cost + " +
    "borrowed-cash interest both scale with lev). 'leaked' under-charges RF by (lev-1)*RF. " +
    "Re-derived independently from raw basis data; compare to committed report headline.";

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "verify_dated_financing.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main();
