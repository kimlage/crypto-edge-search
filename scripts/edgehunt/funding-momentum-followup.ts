#!/usr/bin/env tsx
/**
 * FOLLOW-UP: the FADE direction lost everywhere; the MOMENTUM direction (trade
 * WITH the funding signal) was positive. Before celebrating, we must rule out
 * the obvious confound: positive funding clusters in bull regimes, so a LONG
 * spot bet just harvests market BETA/DRIFT, not a funding-specific TIMING edge.
 *
 * We test the momentum direction with full rigor AND a drift control:
 *   (1) DEMEAN each coin's spot return by its own full-sample mean daily drift,
 *       so the overlay can ONLY profit from funding-conditional TIMING, not from
 *       the unconditional upward drift of crypto. (This is the honest analogue
 *       of "strip the carry": here we strip the BETA/DRIFT.)
 *   (2) Same-coin lead-lag placebo (shuffle), block-bootstrap, deflated Sharpe
 *       at honest N (24 configs, both directions), CSCV/PBO.
 *
 * If the funding-momentum overlay survives drift-demeaning + placebo + DSR, it
 * is a genuine funding-timing edge. If it collapses once drift is removed, it
 * was just long beta and is a KILL.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  computeProbabilisticSharpeRatio,
  blockBootstrapConfidenceInterval,
} from "../../src/lib/training/statistical-validation.ts";

const COINS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];
const DATA_DIR = path.resolve("output/funding");
const OUT_DIR = path.resolve("output/edgehunt");
const COST_PER_SIDE = 4 / 10_000;
const ROLL_WINDOW = 60;
const ANNUALIZE = Math.sqrt(365);
const Z_ENTER_GRID = [1.0, 1.5, 2.0, 2.5];
const HORIZON_GRID = [1, 3, 5];
const HONEST_N = 24; // both directions x 4 zEnter x 3 horizon, same as primary script

interface FundingPoint { fundingTime: number; fundingRate: number; }
interface PricePoint { date: string; spotClose: number; perpClose: number; }

function loadCoin(coin: string) {
  const funding: FundingPoint[] = JSON.parse(
    readFileSync(path.join(DATA_DIR, `${coin}USDT_funding_8h.json`), "utf8"),
  );
  const prices: PricePoint[] = JSON.parse(
    readFileSync(path.join(DATA_DIR, `${coin}USDT_prices_daily.json`), "utf8"),
  );
  const fundingByDate = new Map<string, number>();
  for (const fp of funding) {
    const d = new Date(fp.fundingTime).toISOString().slice(0, 10);
    fundingByDate.set(d, (fundingByDate.get(d) ?? 0) + fp.fundingRate);
  }
  const dates: string[] = [], spot: number[] = [], fundingDaily: number[] = [];
  for (const p of prices) {
    if (!Number.isFinite(p.spotClose) || p.spotClose <= 0) continue;
    dates.push(p.date); spot.push(p.spotClose);
    fundingDaily.push(fundingByDate.get(p.date) ?? 0);
  }
  return { dates, spot, fundingDaily };
}

type SignalFn = (z: number, zEnter: number) => -1 | 0 | 1;
const MOMENTUM: SignalFn = (z, zEnter) =>
  z >= zEnter ? 1 : z <= -zEnter ? -1 : 0;

interface OverlayResult { dates: string[]; net: number[]; trades: number; }

// demeanDrift: if true, subtract each coin's full-sample mean daily return from
// the spot return BEFORE forming overlay P&L -> removes unconditional drift/beta.
function runOverlay(
  coin: ReturnType<typeof loadCoin>,
  zEnter: number, horizon: number, signalFn: SignalFn, demeanDrift: boolean,
): OverlayResult {
  const { dates, spot, fundingDaily } = coin;
  const n = spot.length;
  const ret: number[] = new Array(n).fill(0);
  for (let t = 1; t < n; t++) ret[t] = spot[t] / spot[t - 1] - 1;
  if (demeanDrift) {
    let s = 0, c = 0;
    for (let t = 1; t < n; t++) { s += ret[t]; c++; }
    const mu = s / c;
    for (let t = 1; t < n; t++) ret[t] -= mu;
  }
  const z: number[] = new Array(n).fill(NaN);
  for (let t = 0; t < n; t++) {
    const lo = t - ROLL_WINDOW;
    if (lo < 0) continue;
    let sum = 0, cnt = 0;
    for (let k = lo; k < t; k++) { sum += fundingDaily[k]; cnt++; }
    if (cnt < ROLL_WINDOW) continue;
    const mean = sum / cnt;
    let v = 0;
    for (let k = lo; k < t; k++) v += (fundingDaily[k] - mean) ** 2;
    const sd = Math.sqrt(v / (cnt - 1));
    if (sd <= 1e-12) continue;
    z[t] = (fundingDaily[t] - mean) / sd;
  }
  const targetPos: number[] = new Array(n).fill(0);
  for (let t = 0; t < n; t++) if (Number.isFinite(z[t])) targetPos[t] = signalFn(z[t], zEnter);
  const heldWeight: number[] = new Array(n).fill(0);
  for (let sIdx = 0; sIdx < n; sIdx++) {
    let w = 0;
    for (let j = 1; j <= horizon; j++) { const t = sIdx - j; if (t >= 0) w += targetPos[t]; }
    heldWeight[sIdx] = w / horizon;
  }
  const net: number[] = [], outDates: string[] = [];
  let trades = 0, prevW = 0;
  const first = ROLL_WINDOW + 1;
  for (let sIdx = first; sIdx < n; sIdx++) {
    const w = heldWeight[sIdx];
    const turnover = Math.abs(w - prevW);
    net.push(w * ret[sIdx] - turnover * COST_PER_SIDE);
    outDates.push(dates[sIdx]);
    if (turnover > 1e-9) trades++;
    prevW = w;
  }
  return { dates: outDates, net, trades };
}

function poolAcrossCoins(perCoin: { res: OverlayResult }[]) {
  const dateSet = new Set<string>();
  for (const { res } of perCoin) for (const d of res.dates) dateSet.add(d);
  const dates = [...dateSet].sort();
  const idx = new Map<string, number>(); dates.forEach((d, i) => idx.set(d, i));
  const netSum = new Array(dates.length).fill(0);
  const activeCnt = new Array(dates.length).fill(0);
  for (const { res } of perCoin) {
    for (let i = 0; i < res.dates.length; i++) {
      const di = idx.get(res.dates[i])!;
      netSum[di] += res.net[i];
      if (res.net[i] !== 0) activeCnt[di] += 1;
    }
  }
  const net: number[] = [];
  for (let i = 0; i < dates.length; i++) net.push(activeCnt[i] > 0 ? netSum[i] / activeCnt[i] : 0);
  return { dates, net };
}

function rotate(arr: number[], shift: number): number[] {
  const n = arr.length; const s = ((shift % n) + n) % n;
  const out = new Array(n); for (let i = 0; i < n; i++) out[i] = arr[(i + s) % n];
  return out;
}
function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function placebo(coins: { data: ReturnType<typeof loadCoin> }[], zEnter: number, horizon: number,
  demean: boolean, nSh: number, seed: number): number[] {
  const rng = mulberry32(seed); const out: number[] = [];
  for (let s = 0; s < nSh; s++) {
    const perCoin = coins.map(({ data }) => {
      const n = data.fundingDaily.length; const minShift = ROLL_WINDOW + horizon + 2;
      const shift = minShift + Math.floor(rng() * Math.max(1, n - 2 * minShift));
      const fake = { ...data, fundingDaily: rotate(data.fundingDaily, shift) };
      return { res: runOverlay(fake, zEnter, horizon, MOMENTUM, demean) };
    });
    out.push(summarizeReturnSeries(poolAcrossCoins(perCoin).net).sharpe);
  }
  return out;
}

function fmt(x: number, d = 4) { return Number.isFinite(x) ? x.toFixed(d) : "NaN"; }

function evaluate(demean: boolean, label: string) {
  const loaded = COINS.map((c) => ({ coin: c, data: loadCoin(c) }));
  const configs: { id: string; z: number; h: number; net: number[]; sharpe: number; trades: number }[] = [];
  for (const z of Z_ENTER_GRID) for (const h of HORIZON_GRID) {
    const perCoin = loaded.map(({ data }) => ({ res: runOverlay(data, z, h, MOMENTUM, demean) }));
    const pooled = poolAcrossCoins(perCoin);
    const st = summarizeReturnSeries(pooled.net);
    const trades = loaded.reduce((a, { data }) => a + runOverlay(data, z, h, MOMENTUM, demean).trades, 0);
    configs.push({ id: `mom|z${z}|h${h}`, z, h, net: pooled.net, sharpe: st.sharpe, trades });
  }
  const primary = configs.reduce((b, r) => (r.sharpe > b.sharpe ? r : b));
  const st = summarizeReturnSeries(primary.net);
  const dsr = computeDeflatedSharpeRatio(primary.net, { trialCount: HONEST_N });
  const psr = computeProbabilisticSharpeRatio(primary.net, 0);
  const boot = blockBootstrapConfidenceInterval(primary.net, {
    statistic: "sharpe", iterations: 2000, blockLength: 10, confidenceLevel: 0.95, seed: `mom-${label}` });
  const pl = placebo(loaded, primary.z, primary.h, demean, 1000, 999).sort((a, b) => a - b);
  const ge = pl.filter((s) => s >= primary.sharpe).length;
  const surrogateP = (ge + 1) / (pl.length + 1);
  const plMean = pl.reduce((a, b) => a + b, 0) / pl.length;
  const plSd = Math.sqrt(pl.reduce((a, b) => a + (b - plMean) ** 2, 0) / pl.length);

  // per-coin
  const perCoin = loaded.map(({ coin, data }) => {
    const r = runOverlay(data, primary.z, primary.h, MOMENTUM, demean);
    const s = summarizeReturnSeries(r.net);
    return { coin, sharpe: s.sharpe, ann: s.sharpe * ANNUALIZE };
  });
  const pos = perCoin.filter((c) => c.sharpe > 0).length;

  console.log(`\n========== MOMENTUM, demeanDrift=${demean} (${label}) ==========`);
  console.log(`PRIMARY ${primary.id}: net Sharpe daily=${fmt(primary.sharpe)} ann=${fmt(primary.sharpe * ANNUALIZE, 3)} monthly=${fmt(st.mean * 30 * 100, 3)}%`);
  console.log(`  DSR@N=${HONEST_N}: expMax=${fmt(dsr.expectedMaxSharpe)} obs=${fmt(dsr.sharpe)} deflatedProb=${fmt(dsr.deflatedProbability)} PSR=${fmt(psr.probability)}`);
  console.log(`  bootstrap Sharpe 95% CI = [${fmt(boot.lower)}, ${fmt(boot.upper)}]`);
  console.log(`  placebo: mean=${fmt(plMean)} sd=${fmt(plSd)} q95=${fmt(pl[Math.floor(0.95 * pl.length)])} -> surrogate p=${fmt(surrogateP)}`);
  console.log(`  per-coin positive: ${pos}/${COINS.length}`);
  for (const c of perCoin) console.log(`    ${c.coin.padEnd(5)} sharpe=${fmt(c.sharpe).padStart(8)} ann=${fmt(c.ann, 2).padStart(7)}`);
  console.log(`  all configs:`);
  for (const c of configs) console.log(`    ${c.id.padEnd(12)} ann=${fmt(c.sharpe * ANNUALIZE, 3).padStart(8)} monthly=${fmt(summarizeReturnSeries(c.net).mean * 30 * 100, 3).padStart(8)}%`);
  return { label, demean, primary: primary.id, netSharpe: primary.sharpe, netSharpeAnn: primary.sharpe * ANNUALIZE,
    monthlyPct: st.mean * 30, deflatedProb: dsr.deflatedProbability, psr: psr.probability,
    bootLower: boot.lower, bootUpper: boot.upper, surrogateP, perCoinPositive: pos,
    monthly100k: st.mean * 30 * 100_000 };
}

function main() {
  const raw = evaluate(false, "raw-with-drift");
  const demeaned = evaluate(true, "drift-stripped");
  writeFileSync(path.join(OUT_DIR, "funding-momentum-followup.json"),
    JSON.stringify({ raw, demeaned, honestN: HONEST_N }, null, 2));
  console.log(`\nWrote output/edgehunt/funding-momentum-followup.json`);
  console.log(`\n>>> KEY: drift-stripped surrogate p=${fmt(demeaned.surrogateP)}, deflatedProb=${fmt(demeaned.deflatedProb)}, ann Sharpe=${fmt(demeaned.netSharpeAnn, 3)}, coins+=${demeaned.perCoinPositive}/8`);
}
main();
