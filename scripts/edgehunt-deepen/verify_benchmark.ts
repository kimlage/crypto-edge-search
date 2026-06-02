/**
 * ADVERSARIAL VERIFY for D5-08 paper-forward (c).
 *
 * The decisive question the deepening flagged but did not GATE on:
 *   Is net Sharpe 1.19 on 2023-06..2026-05 a SIGNAL-TIMING edge, or just selective long-beta
 *   exposure during a strong BTC up-regime?
 *
 * Two nulls, both on the EXACT funded window + EXACT next-open execution model:
 *   (A) RANDOM LONG OVERLAY matched on exposure & turnover (long-beta-in-disguise test):
 *       place random long-blocks with the same long-share and similar #entries as the real signal,
 *       on the same price path + same cost/funding. If random same-exposure overlays reproduce the
 *       Sharpe, the edge is "be long ~15% of a bull market", not the netflow timing.
 *   (B) ALWAYS-LONG scaled to 14.79% (constant fractional exposure) over the same window — the
 *       honest passive benchmark for a 15%-exposure long-only overlay.
 *
 * Also: re-run the surrogate p with the SAME seed to confirm reproducibility, and report the
 * incremental Sharpe of the signal over the random-overlay distribution (the real benchmark).
 */
import fs from "node:fs";
import {
  loadPanel, ema, rollingZ, mean, std, sharpeDaily, annSharpe, mkRng, type Panel,
} from "../edgehunt-D5/harness.ts";

const ROOT = ".";
const LAG = 1, COST = 0.0004;
const PREREG = { smooth: 14, zwin: 365, thr: 1.0 } as const;

function loadDailyOpens(): Map<string, number> {
  const m = new Map<string, number>();
  const txt = fs.readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`, "utf8");
  for (const line of txt.split("\n")) {
    if (!line) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (typeof d.event_time === "string" && d.event_time.endsWith("T00:00:00.000Z")) m.set(d.event_date, Number(d.open));
  }
  return m;
}
function loadDailyFunding(): Map<string, number> {
  const arr = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/BTCUSDT_funding_8h.json`, "utf8"));
  const byDay = new Map<string, number>();
  for (const x of arr) { const iso = new Date(x.fundingTime).toISOString().slice(0, 10); byDay.set(iso, (byDay.get(iso) ?? 0) + Number(x.fundingRate)); }
  return byDay;
}
const lagArr = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
function netZ(P: Panel, s: number, zw: number): number[] {
  const fin = lagArr(P.flowInNtv, LAG), fout = lagArr(P.flowOutNtv, LAG);
  const net = P.price.map((_, t) => Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN);
  return rollingZ(ema(net, s), zw);
}

const BTC = loadPanel("btc");
const opens = loadDailyOpens();
const funding = loadDailyFunding();
const z = netZ(BTC, PREREG.smooth, PREREG.zwin);
const realPos = new Array(BTC.price.length).fill(NaN);
for (let t = 0; t < BTC.price.length; t++) { if (Number.isFinite(z[t])) realPos[t] = z[t] <= -PREREG.thr ? 1 : 0; }

// build funded rows exactly like paperforward.ts
type Row = { t: number; date: string; oN: number; oN2: number; fund: number };
const rows: Row[] = [];
for (let t = 0; t < BTC.price.length - 2; t++) {
  if (!Number.isFinite(realPos[t])) continue;
  const dN = BTC.dates[t + 1], dN2 = BTC.dates[t + 2];
  const oN = opens.get(dN), oN2 = opens.get(dN2), fund = funding.get(dN);
  if (!(oN! > 0) || !(oN2! > 0) || !Number.isFinite(fund)) continue;
  rows.push({ t, date: dN, oN: oN!, oN2: oN2!, fund: fund! });
}
const K = rows.length;

// net daily series for an arbitrary position array indexed by row order
function netSeries(posByRow: number[]): { sharpe: number; meanDaily: number } {
  const net: number[] = []; let prev = 0;
  for (let i = 0; i < K; i++) {
    const r = rows[i], p = posByRow[i];
    const g = p * Math.log(r.oN2 / r.oN);
    const cost = Math.abs(p - prev) * COST;
    const fund = p > 0 ? p * r.fund : 0;
    net.push(g - cost - fund); prev = p;
  }
  return { sharpe: annSharpe(sharpeDaily(net)), meanDaily: mean(net) };
}

const realPosByRow = rows.map((r) => realPos[r.t]);
const real = netSeries(realPosByRow);
const longShare = realPosByRow.filter((p) => p > 0).length / K;
// count entries (0->1 transitions) for turnover matching
let entries = 0; { let prev = 0; for (const p of realPosByRow) { if (p > 0 && prev === 0) entries++; prev = p > 0 ? 1 : 0; } }

// ---- NULL A: random long overlay matched on long-share (preserve block structure via #entries) ----
// place `entries` contiguous long-blocks whose total length == round(longShare*K), randomly positioned.
function randomOverlay(rng: () => number): number[] {
  const totalLong = Math.round(longShare * K);
  const pos = new Array(K).fill(0);
  // distribute totalLong days into `entries` blocks of random length, placed at random non-overlapping starts
  const nb = Math.max(1, entries);
  // random block lengths summing to totalLong
  const lens: number[] = [];
  let rem = totalLong;
  for (let b = 0; b < nb; b++) { const avg = rem / (nb - b); const L = Math.max(1, Math.round(avg * (0.5 + rng()))); lens.push(Math.min(L, rem)); rem -= lens[b]; if (rem <= 0) break; }
  if (rem > 0 && lens.length) lens[lens.length - 1] += rem;
  // place blocks greedily at random free positions
  for (const L of lens) {
    for (let tries = 0; tries < 50; tries++) {
      const start = Math.floor(rng() * Math.max(1, K - L));
      let free = true;
      for (let i = start; i < start + L && i < K; i++) if (pos[i] === 1) { free = false; break; }
      if (free) { for (let i = start; i < start + L && i < K; i++) pos[i] = 1; break; }
    }
  }
  return pos;
}
const NRAND = 2000;
const randSharpes: number[] = [];
for (let i = 0; i < NRAND; i++) { const s = netSeries(randomOverlay(mkRng(13337 + i * 104729))).sharpe; randSharpes.push(s); }
randSharpes.sort((a, b) => a - b);
const pVsRandom = (randSharpes.filter((s) => s >= real.sharpe).length + 1) / (NRAND + 1);
const randMean = mean(randSharpes), randStd = std(randSharpes);
const randMedian = randSharpes[Math.floor(NRAND / 2)];
const randP95 = randSharpes[Math.floor(NRAND * 0.95)];

// ---- NULL B: constant fractional always-long at longShare exposure ----
const alwaysLongFrac = rows.map(() => longShare);
const alB = netSeries(alwaysLongFrac);

// full-exposure always-long (B&H proxy on next-open) for the same window
const bhFull = netSeries(rows.map(() => 1));

const out = {
  window: { start: rows[0].date, end: rows[K - 1].date, K },
  realSignal: { netSharpe: real.sharpe, meanDaily: real.meanDaily, longShare, entries },
  nullA_randomLongOverlay_matchedExposure: {
    n: NRAND, mean: randMean, std: randStd, median: randMedian, p95: randP95,
    p_real_ge_random: pVsRandom,
    pass_signal_beats_random: pVsRandom < 0.05,
    read: "If p>=0.05, a same-exposure RANDOM long overlay reproduces the Sharpe => edge is selective beta, not timing.",
  },
  nullB_constantFracAlwaysLong: { netSharpe: alB.sharpe, meanDaily: alB.meanDaily, exposure: longShare },
  bh_fullExposure_sameWindow: { netSharpe: bhFull.sharpe, meanDaily: bhFull.meanDaily },
  incremental: {
    real_minus_alwaysLongFrac_sharpe: real.sharpe - alB.sharpe,
    real_zscore_vs_randomDist: (real.sharpe - randMean) / (randStd || 1e-9),
  },
};
fs.writeFileSync(`${ROOT}/output/edgehunt-deepen/verify_benchmark_result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
