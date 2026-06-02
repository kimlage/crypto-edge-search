/**
 * D5-08 DEEPEN part (c) — PROPER PAPER-FORWARD SIM on BTC with realistic execution.
 *
 * Execution model (honest, no look-ahead):
 *   - Signal decided at the Coin-Metrics daily close of day t. Exchange flow is LAGGED >= 1 day.
 *   - Desired position for the gap t->t+1 is computed from the pre-registered band on the netflow-Z.
 *   - The position is FILLED at the Binance BTCUSDT 00:00-UTC OPEN of day t+1 (next-open fill), and
 *     marked OPEN(t+1) -> OPEN(t+2). This removes the close-to-close idealization of the daily panel.
 *   - 4 bps taker each side on every change in |position| (turnover * 0.0004).
 *   - 8h perpetual FUNDING debited on the long leg, pro-rata to time held long (3 funding stamps/day).
 *     Long pays funding when fundingRate>0 (the usual contango regime), receives when <0.
 *
 * We run the pre-registered config (smooth=14,zwin=365,thr=1.0,long/flat) over the FUNDED window
 * (Binance funding starts 2023-06-01), which is essentially the held-out forward tail. Report:
 * net Sharpe (after cost+funding, on next-open fills), monthly %/$ @ $100k, DSR@N=1, block-bootstrap
 * CI, exposure/turnover, and the cost/funding drag decomposition vs the idealized close-to-close.
 */
import fs from "node:fs";
import {
  loadPanel, ema, rollingZ, mean, std, sharpeDaily, annSharpe, mkRng,
  runPositions, type Panel,
} from "../edgehunt-D5/harness.ts";
import {
  computeDeflatedSharpeRatio, blockBootstrapConfidenceInterval,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-deepen`;
const LAG = 1;
const COST = 0.0004; // 4 bps taker per side
const ANN = Math.sqrt(365);
const PREREG = { smooth: 14, zwin: 365, thr: 1.0, side: "longflat" } as const;

// ---- load Binance 00:00-UTC daily OPENs from 15m ndjson ----
function loadDailyOpens(): Map<string, number> {
  const m = new Map<string, number>();
  const txt = fs.readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`, "utf8");
  for (const line of txt.split("\n")) {
    if (!line) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (typeof d.event_time === "string" && d.event_time.endsWith("T00:00:00.000Z")) {
      m.set(d.event_date, Number(d.open));
    }
  }
  return m;
}
// ---- load BTC 8h funding, aggregate to a per-day total funding rate (sum of the day's 3 stamps) ----
function loadDailyFunding(): Map<string, number> {
  const arr = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/BTCUSDT_funding_8h.json`, "utf8"));
  const byDay = new Map<string, number>();
  for (const x of arr) {
    const d = new Date(x.fundingTime);
    const iso = d.toISOString().slice(0, 10);
    byDay.set(iso, (byDay.get(iso) ?? 0) + Number(x.fundingRate));
  }
  return byDay;
}

const lagArr = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
function netZ(P: Panel, s: number, zw: number): number[] {
  const fin = lagArr(P.flowInNtv, LAG), fout = lagArr(P.flowOutNtv, LAG);
  const net = P.price.map((_, t) => Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN);
  return rollingZ(ema(net, s), zw);
}
function posFromZ(P: Panel, z: number[], thr: number, side: string): number[] {
  const p = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    if (z[t] <= -thr) p[t] = 1; else if (z[t] >= thr) p[t] = side === "longshort" ? -1 : 0; else p[t] = 0;
  }
  return p;
}

const BTC = loadPanel("btc");
const opens = loadDailyOpens();
const funding = loadDailyFunding();
const z = netZ(BTC, PREREG.smooth, PREREG.zwin);
const pos = posFromZ(BTC, z, PREREG.thr, PREREG.side);

// build an aligned next-OPEN series for each panel date d: open(d) from Binance.
// For day t (panel index), position[t] (decided at close t) is filled at OPEN of day t+1 and held to
// OPEN of day t+2. So the realized return for position[t] = log(open[t+2]/open[t+1]).
type Row = { date: string; pos: number; openNext: number; openNext2: number; fundNextDay: number };
const rows: Row[] = [];
for (let t = 0; t < BTC.price.length - 2; t++) {
  if (!Number.isFinite(pos[t])) continue;
  const dN = BTC.dates[t + 1], dN2 = BTC.dates[t + 2];
  const oN = opens.get(dN), oN2 = opens.get(dN2);
  if (!(oN! > 0) || !(oN2! > 0)) continue;
  // funding charged over the holding day (day t+1, between the two opens): use day t+1's funding total
  const fund = funding.get(dN) ?? NaN;
  rows.push({ date: dN, pos: pos[t], openNext: oN!, openNext2: oN2!, fundNextDay: fund });
}
// restrict to the FUNDED window (where funding is available) = forward tail
const funded = rows.filter((r) => Number.isFinite(r.fundNextDay));
if (funded.length === 0) throw new Error("no funded rows");
console.log(`funded paper-forward window: ${funded[0].date} -> ${funded[funded.length - 1].date} (${funded.length} days)`);

// realistic next-open backtest with cost + funding
function paperBacktest(useFunding: boolean) {
  const net: number[] = [], gross: number[] = [];
  let prev = 0, turnoverSum = 0, expSum = 0, longCount = 0, fundDragSum = 0, costSum = 0;
  for (const r of funded) {
    const g = r.pos * Math.log(r.openNext2 / r.openNext); // open->open log return
    const turn = Math.abs(r.pos - prev);
    const cost = turn * COST;
    // funding: long pays fundNextDay (sum of 3 stamps) when positive. position fraction * fundingRate.
    const fund = useFunding ? (r.pos > 0 ? r.pos * r.fundNextDay : 0) : 0;
    const n = g - cost - fund;
    gross.push(g); net.push(n);
    turnoverSum += turn; expSum += Math.abs(r.pos); if (r.pos > 0) longCount++;
    fundDragSum += fund; costSum += cost; prev = r.pos;
  }
  const k = net.length;
  return {
    dailyNet: net, dailyGross: gross,
    netSharpeAnn: annSharpe(sharpeDaily(net)), grossSharpeAnn: annSharpe(sharpeDaily(gross)),
    meanDailyNet: mean(net), exposure: expSum / k, turnover: turnoverSum / k, longShare: longCount / k,
    nDays: k, totalCostDrag: costSum, totalFundingDrag: fundDragSum,
    monthlyAt100k: mean(net) * 30 * 100000, monthlyAt10k: mean(net) * 30 * 10000, monthlyPct: mean(net) * 30 * 100,
  };
}

const paper = paperBacktest(true);
const paperNoFund = paperBacktest(false);
const dsr = computeDeflatedSharpeRatio(paper.dailyNet, { trialCount: 1 });
const bb = blockBootstrapConfidenceInterval(paper.dailyNet, { statistic: "mean", iterations: 4000, blockLength: 20, confidenceLevel: 0.95, seed: "paper-fwd-bb" });

// surrogate p on the paper-forward (phase-randomize the Z over the funded window, refill at next open)
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
function paperSurrogateP(realNet: number, seed0: number, nSurr = 500): number {
  const surr: number[] = [];
  // map funded rows back to panel indices for refilling positions from a surrogate z
  const fundedSet = new Set(funded.map((r) => r.date));
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(seed0 + i * 7919);
    const sz = phaseRandomize(z, rng);
    const sp = posFromZ(BTC, sz, PREREG.thr, PREREG.side);
    const net: number[] = [];
    let prev = 0;
    for (let t = 0; t < BTC.price.length - 2; t++) {
      const dN = BTC.dates[t + 1];
      if (!fundedSet.has(dN) || !Number.isFinite(sp[t])) continue;
      const oN = opens.get(dN)!, oN2 = opens.get(BTC.dates[t + 2])!;
      const fund = funding.get(dN) ?? 0;
      const g = sp[t] * Math.log(oN2 / oN);
      const cost = Math.abs(sp[t] - prev) * COST;
      const f = sp[t] > 0 ? sp[t] * fund : 0;
      net.push(g - cost - f); prev = sp[t];
    }
    surr.push(annSharpe(sharpeDaily(net)));
  }
  return (surr.filter((s) => s >= realNet).length + 1) / (nSurr + 1);
}
const paperSurrP = paperSurrogateP(paper.netSharpeAnn, 70000);

// also report the IDEALIZED close-to-close net (panel price) on the SAME funded window, for the drag delta
const idxByDate = new Map(BTC.dates.map((d, i) => [d, i]));
const fundedIdx = funded.map((r) => idxByDate.get(r.date)!).filter((i) => i != null);
const c2cStart = Math.min(...fundedIdx), c2cEnd = Math.max(...fundedIdx) + 1;
const c2c = runPositions(BTC, pos, c2cStart, c2cEnd);
const c2cNet = annSharpe(sharpeDaily(c2c.dailyNet));

const out = {
  config: PREREG,
  execution: "next-open fill (Binance 00:00 UTC open), open->open mark, 4bps/side, 8h funding on long leg",
  fundedWindow: { start: funded[0].date, end: funded[funded.length - 1].date, nDays: funded.length },
  paperForward_withFunding: {
    netSharpeAnn: paper.netSharpeAnn, grossSharpeAnn: paper.grossSharpeAnn,
    dsrAtN1: dsr.deflatedProbability, dsrAtN1_pass: dsr.deflatedProbability > 0.95,
    blockBootstrapCI95: [bb.lower, bb.upper], bb_pass: bb.lower > 0,
    surrogateP: paperSurrP, surrogate_pass: paperSurrP < 0.05,
    exposure: paper.exposure, turnover: paper.turnover, longShare: paper.longShare, nDays: paper.nDays,
    monthlyAt100k: paper.monthlyAt100k, monthlyAt10k: paper.monthlyAt10k, monthlyPct: paper.monthlyPct,
    totalFundingDrag_logret: paper.totalFundingDrag, totalCostDrag_logret: paper.totalCostDrag,
  },
  paperForward_noFunding: {
    netSharpeAnn: paperNoFund.netSharpeAnn, monthlyAt100k: paperNoFund.monthlyAt100k,
  },
  idealized_close2close_sameWindow: { netSharpeAnn: c2cNet, monthlyAt100k: mean(c2c.dailyNet) * 30 * 100000, nDays: c2c.nDays },
  drag_summary: {
    closeToClose_minus_paperWithFunding_sharpe: c2cNet - paper.netSharpeAnn,
    funding_sharpe_cost: paperNoFund.netSharpeAnn - paper.netSharpeAnn,
    nextOpenFill_sharpe_cost: c2cNet - paperNoFund.netSharpeAnn,
  },
};
fs.writeFileSync(`${OUT}/paperforward_result.json`, JSON.stringify(out, null, 2));

console.log("\n=== (c) PAPER-FORWARD SIM (next-open fills, 4bps, funding) — BTC pre-registered config ===");
console.log(`window ${funded[0].date}..${funded[funded.length - 1].date} (${funded.length} days)`);
console.log(`  WITH funding: net Sharpe=${paper.netSharpeAnn.toFixed(3)} gross=${paper.grossSharpeAnn.toFixed(3)} DSR@N1=${dsr.deflatedProbability.toFixed(4)}${dsr.deflatedProbability > 0.95 ? " PASS" : " FAIL"} surrP=${paperSurrP.toFixed(4)}${paperSurrP < 0.05 ? " PASS" : " FAIL"}`);
console.log(`  BB95 mean=[${bb.lower.toExponential(2)},${bb.upper.toExponential(2)}]${bb.lower > 0 ? " PASS" : " FAIL"} exp=${paper.exposure.toFixed(3)} turn=${paper.turnover.toFixed(3)} nDays=${paper.nDays}`);
console.log(`  monthly@$100k=$${Math.round(paper.monthlyAt100k)} @$10k=$${Math.round(paper.monthlyAt10k)} (${paper.monthlyPct.toFixed(3)}%/mo)`);
console.log(`  drag: close2close=${c2cNet.toFixed(3)} -> noFund(next-open)=${paperNoFund.netSharpeAnn.toFixed(3)} -> withFund=${paper.netSharpeAnn.toFixed(3)}`);
console.log(`        nextOpenFill cost=${(c2cNet - paperNoFund.netSharpeAnn).toFixed(3)} Sharpe; funding cost=${(paperNoFund.netSharpeAnn - paper.netSharpeAnn).toFixed(3)} Sharpe`);
console.log(`        total funding drag (logret over window)=${paper.totalFundingDrag.toFixed(5)}; total cost drag=${paper.totalCostDrag.toFixed(5)}`);
console.log(`\nwrote ${OUT}/paperforward_result.json`);
