/**
 * edgehunt-D348 / D3-B9 — Deribit DVOL signals as a spot timer.
 *
 * Belief under test (most-hyped vol timer): "DVOL spike = buy"; plus DVOL
 * momentum / reversion / (DVOL - RV) as directional spot timers for BTC.
 *
 * STRONGEST HONEST BUILD (genuinely trying to find edge):
 *   - DVOL daily history from Deribit free endpoint (cached on disk, $0).
 *   - RV from btc_ohlcv_15m.ndjson aggregated to daily realized vol.
 *   - 4 signal families, each with a grid of thresholds/lookbacks:
 *       (1) spike->buy   : z-score of DVOL daily change; spike -> long next day
 *       (2) momentum     : sign of trailing DVOL change -> long/short next day
 *       (3) reversion    : DVOL level z-score (fear extreme) -> long next day
 *       (4) DVOL - RV    : VRP proxy; high (DVOL-RV) -> position next day
 *   - Pick the BEST config per family (this search is counted in honest N).
 *
 * KEY CONTROLS:
 *   - STRICT forward lag: signal computed on data up to and INCLUDING close of
 *     day t; the traded return is day t->t+1 (open-to-... we use close-to-close
 *     of t+1). No coincident-day return is ever used. A "lag-0 / coincident"
 *     diagnostic is reported separately to show how much of the apparent signal
 *     is peeking.
 *   - Beat the $0 realized-vol timer (D3-A3 analogue): identical rules driven by
 *     trailing RV instead of DVOL. DVOL must beat RV to carry information.
 *   - Beat long-only BTC (buy & hold) net of cost.
 *
 * SURROGATE NULLS (the right ones for a vol item):
 *   - Block-bootstrap of BTC returns (preserves vol clustering / autocorr).
 *   - Lead-lag placebo: re-time the SAME signal by random non-zero lags.
 *   - Calendar-reanchor: shift the spike/signal calendar by random offsets so
 *     spikes no longer align with the true return calendar.
 *
 * Judged with committed gauntlet primitives (statistical-validation.ts):
 *   Deflated Sharpe @ honest N, block-bootstrap CI, surrogate p, net-of-cost.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/d3b9-dvol.ts
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

const PPY = 252;
const ann = (s: number) => s * Math.sqrt(PPY);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const mean = (r: number[]) => (r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function blockResample(x: number[], blk: number, r: () => number): number[] {
  const out: number[] = [];
  while (out.length < x.length) {
    const s = Math.floor(r() * x.length);
    for (let o = 0; o < blk && out.length < x.length; o++) out.push(x[(s + o) % x.length]);
  }
  return out;
}
function zlast(x: number[], i: number, look: number): number | null {
  if (i - look < 0) return null;
  const w = x.slice(i - look + 1, i + 1);
  const m = mean(w);
  const sd = Math.sqrt(mean(w.map((v) => (v - m) * (v - m)))) || 1e-9;
  return (x[i] - m) / sd;
}

// ---------------------------------------------------------------------------
// Load DVOL daily (cached free Deribit history) + build daily BTC close & RV.
// ---------------------------------------------------------------------------
type Dvol = { date: string; close: number };
const dvolRaw = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/edgehunt/dvol_btc.json"), "utf8"),
) as { date: string; close: number }[];
const dvolMap = new Map<string, number>(dvolRaw.map((d) => [d.date, d.close]));

async function loadDaily(): Promise<{ date: string; close: number; rv: number }[]> {
  // aggregate 15m bars to daily close + realized vol (sqrt sum of squared 15m
  // log returns), annualized to a comparable IV-like scale (%).
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(ROOT, "output/bigquery/btc_ohlcv_15m.ndjson")),
  });
  const byDay = new Map<string, { closes: number[]; lastClose: number; lastTime: string }>();
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line) as { event_date: string; event_time: string; close: number };
    let d = byDay.get(o.event_date);
    if (!d) {
      d = { closes: [], lastClose: o.close, lastTime: o.event_time };
      byDay.set(o.event_date, d);
    }
    d.closes.push(o.close);
    if (o.event_time >= d.lastTime) {
      d.lastTime = o.event_time;
      d.lastClose = o.close;
    }
  }
  const days = [...byDay.keys()].sort();
  const out: { date: string; close: number; rv: number }[] = [];
  for (const day of days) {
    const c = byDay.get(day)!.closes;
    if (c.length < 20) continue; // skip thin days
    let ss = 0;
    for (let i = 1; i < c.length; i++) {
      const lr = Math.log(c[i] / c[i - 1]);
      ss += lr * lr;
    }
    // realized vol of the day, annualized to % (same units as DVOL)
    const rvDay = Math.sqrt(ss) * Math.sqrt(365) * 100;
    out.push({ date: day, close: byDay.get(day)!.lastClose, rv: rvDay });
  }
  return out;
}

(async () => {
  const dailyAll = await loadDaily();
  // restrict to DVOL-covered window, join DVOL close per day
  const rows = dailyAll
    .filter((d) => dvolMap.has(d.date))
    .map((d) => ({ ...d, dvol: dvolMap.get(d.date)! }));
  // forward log return: ret[i] is close[i]->close[i+1] (the return EARNED by a
  // position opened at close of day i using signal known at close of day i).
  const N = rows.length;
  const fwd: number[] = new Array(N).fill(0);
  for (let i = 0; i < N - 1; i++) fwd[i] = Math.log(rows[i + 1].close / rows[i].close);
  const dvol = rows.map((r) => r.dvol);
  const rv = rows.map((r) => r.rv);
  const dDvol = dvol.map((v, i) => (i === 0 ? 0 : v - dvol[i - 1]));
  // smoothed RV (5d) to reduce 15m noise for the VRP proxy & RV-timer baseline
  const rvS = rv.map((_, i) => mean(rv.slice(Math.max(0, i - 4), i + 1)));

  const COST = 0.0006; // 6 bps round-trip per position change (taker, realistic spot)

  // generic backtester: given a per-day desired position in {-1,0,+1} known at
  // close of day i, earn fwd[i], pay cost on |pos change|. STRICT forward lag.
  function backtest(pos: (number | null)[]): number[] {
    const r: number[] = [];
    let prev = 0;
    for (let i = 0; i < N - 1; i++) {
      const p = pos[i] == null ? 0 : (pos[i] as number);
      let day = p * fwd[i];
      if (p !== prev) day -= COST * Math.abs(p - prev) * 0.5; // cost per unit turnover
      r.push(day);
      prev = p;
    }
    return r;
  }
  // coincident (lag-0 PEEK) version: uses SAME-DAY return fwd[i] but signal that
  // includes day i+1's info is NOT available; here we deliberately let the
  // position react to the contemporaneous move to quantify peeking bias.
  function backtestPeek(posOfNextDay: (i: number) => number | null): number[] {
    const r: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      // peek: decide position for day i using day i+1's dvol change (illegal)
      const p = posOfNextDay(i);
      r.push((p == null ? 0 : p) * fwd[i]);
    }
    return r;
  }

  // ---- baselines ----
  const buyHold = backtest(new Array(N).fill(1));
  const buyHoldSh = ann(sharpe(buyHold));

  // RV-timer baseline (D3-A3 analogue): long when trailing RV z is LOW (calm),
  // flat when high — the classic "risk-on in calm" vol timer. Also test the
  // reversion variant (long when RV high). Take the better as the control bar.
  function rvTimer(look: number, hi: boolean): number[] {
    const pos: (number | null)[] = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      const z = zlast(rvS, i, look);
      if (z == null) continue;
      pos[i] = hi ? (z > 0 ? 1 : 0) : z < 0 ? 1 : 0;
    }
    return backtest(pos);
  }
  let rvBest = { sharpe: -Infinity, look: 0, hi: false };
  for (const look of [10, 20, 40, 60]) for (const hi of [false, true]) {
    const s = ann(sharpe(rvTimer(look, hi)));
    if (s > rvBest.sharpe) rvBest = { sharpe: s, look, hi };
  }
  const rvControl = ann(sharpe(rvTimer(rvBest.look, rvBest.hi)));

  // ---- DVOL signal families ----
  // family 1: spike -> buy.  signal = z of dDvol over `look`; if z>thr -> long next.
  function spikeBuy(look: number, thr: number, holdDays: number): (number | null)[] {
    const pos: (number | null)[] = new Array(N).fill(0);
    let hold = 0;
    for (let i = 0; i < N; i++) {
      const z = zlast(dDvol, i, look);
      if (z != null && z > thr) hold = holdDays;
      pos[i] = hold > 0 ? 1 : 0;
      if (hold > 0) hold--;
    }
    return pos;
  }
  // family 2: DVOL momentum. trailing change sign -> long if DVOL falling (vol
  // coming off = risk-on) OR rising depending on `risingLong`.
  function dvolMom(look: number, risingLong: boolean): (number | null)[] {
    const pos: (number | null)[] = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      if (i - look < 0) continue;
      const ch = dvol[i] - dvol[i - look];
      const up = ch > 0;
      pos[i] = (up === risingLong) ? 1 : -1;
    }
    return pos;
  }
  // family 3: DVOL level reversion. high DVOL level z -> long (buy fear).
  function dvolRevert(look: number, thr: number): (number | null)[] {
    const pos: (number | null)[] = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const z = zlast(dvol, i, look);
      if (z == null) continue;
      pos[i] = z > thr ? 1 : 0;
    }
    return pos;
  }
  // family 4: DVOL - RV (VRP proxy) timer. high vrp z -> long (or short).
  function vrpTimer(look: number, longHigh: boolean): (number | null)[] {
    const vrp = dvol.map((v, i) => v - rvS[i]);
    const pos: (number | null)[] = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      const z = zlast(vrp, i, look);
      if (z == null) continue;
      const hi = z > 0;
      pos[i] = (hi === longHigh) ? 1 : 0;
    }
    return pos;
  }

  // grids (this whole search is counted in honest N)
  type Cfg = { fam: string; tag: string; pos: (number | null)[] };
  const cfgs: Cfg[] = [];
  for (const look of [10, 20, 40]) for (const thr of [1, 1.5, 2]) for (const hold of [1, 3, 5])
    cfgs.push({ fam: "spikeBuy", tag: `spikeBuy(l=${look},thr=${thr},h=${hold})`, pos: spikeBuy(look, thr, hold) });
  for (const look of [3, 5, 10, 20]) for (const rl2 of [false, true])
    cfgs.push({ fam: "dvolMom", tag: `mom(l=${look},risingLong=${rl2})`, pos: dvolMom(look, rl2) });
  for (const look of [20, 40, 60]) for (const thr of [0.5, 1, 1.5])
    cfgs.push({ fam: "dvolRevert", tag: `revert(l=${look},thr=${thr})`, pos: dvolRevert(look, thr) });
  for (const look of [20, 40, 60]) for (const lh of [false, true])
    cfgs.push({ fam: "vrpTimer", tag: `vrp(l=${look},longHigh=${lh})`, pos: vrpTimer(look, lh) });

  const honestN = cfgs.length + 8 /* rv-timer grid */;
  // evaluate every config
  const scored = cfgs.map((c) => {
    const r = backtest(c.pos);
    return { ...c, ret: r, sh: ann(sharpe(r)), m: mean(r) };
  });
  // best per family + global best
  const byFam: Record<string, typeof scored[number]> = {};
  for (const s of scored) if (!byFam[s.fam] || s.sh > byFam[s.fam].sh) byFam[s.fam] = s;
  const globalBest = scored.reduce((a, b) => (b.sh > a.sh ? b : a));

  // ---- surrogate nulls on the GLOBAL BEST config ----
  // We re-derive the position rule and apply it to surrogate data / re-timed signal.
  const best = globalBest;
  const bestRet = best.ret;
  const bestSh = best.sh;

  // (a) block-bootstrap of forward returns (preserves vol clustering): keep the
  // position path fixed, resample the return series in blocks -> destroys the
  // alignment between signal and realized return while preserving return autocorr.
  const rA = rng(101);
  const surA: number[] = [];
  for (let it = 0; it < 1000; it++) {
    const rb = blockResample(fwd.slice(0, N - 1), 10, rA);
    // apply fixed best position path to resampled returns
    let prev = 0;
    const r: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const p = best.pos[i] == null ? 0 : (best.pos[i] as number);
      let day = p * rb[i];
      if (p !== prev) day -= COST * Math.abs(p - prev) * 0.5;
      r.push(day);
      prev = p;
    }
    surA.push(ann(sharpe(r)));
  }
  surA.sort((a, b) => a - b);
  const pBlock = surA.filter((x) => x >= bestSh).length / surA.length;

  // (b) lead-lag placebo: shift the position path by random NON-ZERO lags (both
  // directions). If the true signal carries forward info, lag 0 (true) should
  // dominate the placebo distribution. We exclude shift 0; include the
  // coincident PEEK as a separate diagnostic below.
  const rB = rng(202);
  const surLL: number[] = [];
  const lags = [-10, -7, -5, -3, -2, 2, 3, 5, 7, 10, 15, 20, 25, 30];
  for (let it = 0; it < 1000; it++) {
    const shift = lags[Math.floor(rB() * lags.length)];
    const r: number[] = [];
    let prev = 0;
    for (let i = 0; i < N - 1; i++) {
      const j = i + shift;
      const p = j >= 0 && j < N && best.pos[j] != null ? (best.pos[j] as number) : 0;
      let day = p * fwd[i];
      if (p !== prev) day -= COST * Math.abs(p - prev) * 0.5;
      r.push(day);
      prev = p;
    }
    surLL.push(ann(sharpe(r)));
  }
  surLL.sort((a, b) => a - b);
  const pLeadLag = surLL.filter((x) => x >= bestSh).length / surLL.length;

  // (c) calendar-reanchor: rotate the entire signal calendar by a random offset
  // so spikes land on the wrong days (preserves the marginal spike distribution).
  const rC = rng(303);
  const surCal: number[] = [];
  for (let it = 0; it < 1000; it++) {
    const off = 20 + Math.floor(rC() * (N - 40));
    const r: number[] = [];
    let prev = 0;
    for (let i = 0; i < N - 1; i++) {
      const j = (i + off) % N;
      const p = best.pos[j] == null ? 0 : (best.pos[j] as number);
      let day = p * fwd[i];
      if (p !== prev) day -= COST * Math.abs(p - prev) * 0.5;
      r.push(day);
      prev = p;
    }
    surCal.push(ann(sharpe(r)));
  }
  surCal.sort((a, b) => a - b);
  const pCal = surCal.filter((x) => x >= bestSh).length / surCal.length;

  // ---- coincident PEEK diagnostic for the spike->buy narrative ----
  // "DVOL spike = buy" tested with COINCIDENT same-day return (illegal peeking):
  // position for day i decided by day i's OWN dvol spike but earning day i's
  // same-day return (close[i-1]->close[i]). This quantifies how much of the
  // narrative is just crash-coincidence.
  const sameDayRet: number[] = new Array(N).fill(0);
  for (let i = 1; i < N; i++) sameDayRet[i] = Math.log(rows[i].close / rows[i - 1].close);
  // best spike config refit
  let spikeBest = { sharpe: -Infinity, peek: 0, fwd: 0, tag: "" };
  for (const look of [10, 20, 40]) for (const thr of [1, 1.5, 2]) for (const hold of [1, 3, 5]) {
    const pos = spikeBuy(look, thr, hold);
    // forward (legal)
    const fSh = ann(sharpe(backtest(pos)));
    // peek (coincident): earn same-day return on the spike day
    const pk: number[] = [];
    for (let i = 0; i < N; i++) pk.push((pos[i] || 0) * sameDayRet[i]);
    const pSh = ann(sharpe(pk));
    if (fSh > spikeBest.fwd) spikeBest = { sharpe: fSh, peek: pSh, fwd: fSh, tag: `spike(l=${look},thr=${thr},h=${hold})` };
  }

  // ---- gauntlet on best ----
  const dsr = computeDeflatedSharpeRatio(bestRet, { trialCount: honestN });
  const ci = blockBootstrapConfidenceInterval(bestRet, {
    statistic: "sharpe",
    iterations: 2000,
    blockLength: 10,
    confidenceLevel: 0.95,
  });
  const monthlyPctNet = (Math.exp(mean(bestRet) * (PPY / 12)) - 1) * 100;

  const out = {
    window: { firstDate: rows[0].date, lastDate: rows[N - 1].date, days: N },
    cost_bps_per_turn: COST * 1e4,
    baselines: {
      buyHold_sharpeAnn: buyHoldSh,
      rvTimer_control_sharpeAnn: rvControl,
      rvTimer_bestCfg: rvBest,
    },
    bestPerFamily: Object.fromEntries(
      Object.entries(byFam).map(([k, v]) => [k, { tag: v.tag, sharpeAnn: v.sh, monthlyPctNet: (Math.exp(v.m * (PPY / 12)) - 1) * 100 }]),
    ),
    globalBest: {
      tag: best.tag,
      fam: best.fam,
      netSharpeAnn: bestSh,
      monthlyReturnPctNet: monthlyPctNet,
      sharpeCI95: [ci.lower, ci.upper],
      beatsBuyHold: bestSh > buyHoldSh,
      beatsRvTimer: bestSh > rvControl,
    },
    surrogate_p: {
      blockBootstrap: pBlock,
      leadLagPlacebo: pLeadLag,
      calendarReanchor: pCal,
      worst: Math.max(pBlock, pLeadLag, pCal),
    },
    spikeBuyNarrative: {
      forward_sharpeAnn: spikeBest.fwd,
      coincidentPeek_sharpeAnn: spikeBest.peek,
      tag: spikeBest.tag,
      note: "If forward<<peek, the 'DVOL spike = buy' edge is crash-coincidence, not predictive.",
    },
    deflatedSharpe: {
      honestN,
      dsr_probability: dsr.deflatedProbability,
      expectedMaxSharpe_perPeriod: dsr.expectedMaxSharpe,
      observedSharpe_perPeriod: dsr.sharpe,
    },
  };
  fs.writeFileSync(path.join(OUT, "d3b9-dvol.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
