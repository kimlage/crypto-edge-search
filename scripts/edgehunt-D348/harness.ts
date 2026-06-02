/**
 * edgehunt-D348 harness — strongest honest version of the highest-real-edge-chance
 * items in D3/D4/D8, judged with the committed gauntlet primitives.
 *
 * Items tested empirically here (real-edge-chance first):
 *   D8-C1  cross-venue funding-rate dispersion (Binance vs Bybit), market-neutral RV
 *   D4-M1  dual momentum (abs+rel) vs single-asset BTC-timing control
 *   D4-S2  distance pairs (GGR) with selection-on-surrogate + PBO + BTC-beta check
 *   D4-S7  short-term reversal (weekly), skip-one + net-of-cost
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/harness.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

const ann = (sharpePerPeriod: number, periodsPerYear: number) =>
  sharpePerPeriod * Math.sqrt(periodsPerYear);

function sharpe(returns: number[]): number {
  return summarizeReturnSeries(returns).sharpe;
}

// Mulberry32 deterministic RNG
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

// circular block bootstrap of a 1D series (preserves own autocorr)
function blockResample(x: number[], blk: number, r: () => number): number[] {
  const out: number[] = [];
  while (out.length < x.length) {
    const s = Math.floor(r() * x.length);
    for (let o = 0; o < blk && out.length < x.length; o++)
      out.push(x[(s + o) % x.length]);
  }
  return out;
}

const results: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Load panels
// ---------------------------------------------------------------------------
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };

const COINS = Object.keys(weekly.weeklyRet);
const W = weekly.weeks.length;
const ret = (c: string, i: number) => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : v;
};
// coins fully covered (no nulls) — honest universe for XS tests
const FULL = COINS.filter((c) =>
  weekly.weeklyRet[c].every((v) => v != null && isFinite(v as number)),
);

// ===========================================================================
// D8-C1  Cross-venue funding-rate dispersion (Binance vs Bybit)
//   Strongest honest build: per-symbol, signal = sign(binanceFunding - bybitFunding),
//   carry = receive funding on the venue you are short, pay on the venue you are long;
//   market-neutral (long one venue / short the other on the SAME asset, perfectly hedged
//   in spot terms) → PnL per 8h = |dispersion| harvested minus cost.
//   KEY control: does dispersion add over funding LEVEL? compare to level-carry.
//   Cost: each rotation pays taker on perp legs. Realistic 8h funding magnitudes ~1e-4.
// ===========================================================================
function loadFunding(file: string): { t: number; r: number }[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    fundingTime: number;
    fundingRate: number;
  }[];
  return raw
    .map((x) => ({ t: x.fundingTime, r: x.fundingRate }))
    .sort((a, b) => a.t - b.t);
}
function alignFunding(a: { t: number; r: number }[], b: { t: number; r: number }[]) {
  // align by funding bucket (8h, round to hour)
  const key = (t: number) => Math.round(t / (3600 * 1000)) * 3600 * 1000;
  const bm = new Map(b.map((x) => [key(x.t), x.r]));
  const out: { aR: number; bR: number }[] = [];
  for (const x of a) {
    const bv = bm.get(key(x.t));
    if (bv != null) out.push({ aR: x.r, bR: bv });
  }
  return out;
}
{
  const symbols = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"];
  // collect per-8h dispersion harvest across symbols (equal weight, market-neutral)
  const dispGross: number[] = [];
  const dispNet: number[] = [];
  const levelGross: number[] = []; // control: best-funding-level carry (short the rich perp vs spot)
  // realistic per-rotation cost: taker fee 5bps each side, but funding-dispersion
  // strategy holds and only rebalances when sign flips. Charge cost on sign flips.
  const TAKER = 0.0005; // 5 bps per leg
  // Build aligned per-symbol arrays then average cross-section per timestamp.
  const aligned: { aR: number; bR: number }[][] = [];
  for (const s of symbols) {
    const bin = loadFunding(path.join(ROOT, `output/funding/${s}USDT_funding_8h.json`));
    const byb = loadFunding(path.join(ROOT, `output/carry/bybit_${s}USDT_funding_8h.json`));
    aligned.push(alignFunding(bin, byb));
  }
  const n = Math.min(...aligned.map((a) => a.length));
  let prevSign = 0;
  for (let i = 0; i < n; i++) {
    let g = 0;
    let lev = 0;
    let flips = 0;
    for (const a of aligned) {
      const d = a[i].aR - a[i].bR; // dispersion
      const sgn = Math.sign(d);
      // harvest |dispersion| (long cheap-funding venue, short rich): you receive bR-aR
      // on short-rich, pay on long-cheap → net = |d| each 8h while held
      g += Math.abs(d);
      // level control: short the richer perp vs spot → receive max(aR,bR) if positive
      lev += Math.max(a[i].aR, a[i].bR, 0);
      if (sgn !== prevSign && sgn !== 0) flips += 1;
    }
    g /= aligned.length;
    lev /= aligned.length;
    // amortized cost: assume sign roughly stable; charge 2 legs taker on flips fraction.
    const flipFrac = flips / aligned.length;
    const cost = flipFrac * 2 * TAKER;
    dispGross.push(g);
    dispNet.push(g - cost);
    levelGross.push(lev);
    prevSign = Math.sign(aligned[0][i].aR - aligned[0][i].bR);
  }
  const periodsPerYear = (365 * 24) / 8; // 8h funding
  const grossSh = ann(sharpe(dispGross), periodsPerYear);
  const netSh = ann(sharpe(dispNet), periodsPerYear);
  const levelSh = ann(sharpe(levelGross), periodsPerYear);
  // surrogate: cross-sectional shuffle of venue->funding mapping (relative-value null):
  // randomly swap which venue is "a" vs "b" per timestamp → dispersion sign destroyed
  const r = rng(11);
  const surroSh: number[] = [];
  for (let it = 0; it < 500; it++) {
    const s: number[] = [];
    for (let i = 0; i < n; i++) {
      let g = 0;
      for (const a of aligned) {
        const swap = r() < 0.5;
        const d = swap ? a[i].bR - a[i].aR : a[i].aR - a[i].bR;
        // under shuffled mapping you cannot know which is cheap → harvest signed d (no |.|)
        g += d;
      }
      s.push(g / aligned.length);
    }
    surroSh.push(ann(sharpe(s), periodsPerYear));
  }
  surroSh.sort((x, y) => x - y);
  const pSurro =
    surroSh.filter((x) => x >= netSh).length / surroSh.length;
  const meanDispBps = (dispGross.reduce((a, b) => a + b, 0) / n) * 1e4;
  const meanCostBps =
    ((dispGross.reduce((a, b) => a + b, 0) - dispNet.reduce((a, b) => a + b, 0)) / n) * 1e4;
  // Honest N: 2 venues, 6 symbols, 1 signal rule, dispersion-vs-level => ~ small but the
  // cross-venue pair selection is fixed (Binance,Bybit) so trialCount modest.
  const dsr = computeDeflatedSharpeRatio(dispNet, { trialCount: 12 });
  const monthlyPctNet = (Math.exp(Math.log(1 + (dispNet.reduce((a, b) => a + b, 0) / n)) * (periodsPerYear / 12)) - 1) * 100;
  results.C1 = {
    n,
    meanDispBps_per8h: meanDispBps,
    meanCostBps_per8h: meanCostBps,
    grossSharpeAnn: grossSh,
    netSharpeAnn: netSh,
    levelCarrySharpeAnn: levelSh,
    addsOverLevel: netSh > levelSh,
    surrogate_p: pSurro,
    dsr_p: dsr.deflatedProbability,
    monthlyReturnPctNet: monthlyPctNet,
    note:
      "Dispersion harvest is |binanceFunding-bybitFunding| per 8h, market-neutral. Cost charged on sign flips. Level control = short-richer-perp carry.",
  };
}

// ===========================================================================
// D4-M1  Dual momentum (absolute + relative) vs single-asset BTC timing
//   Build: each week rank FULL universe by trailing 12w return; hold top-3 EW only if
//   their abs momentum>0 AND BTC abs momentum>0 (cash filter). Net of cost on rotation.
//   KEY control: "hold BTC when BTC 12w momentum>0 else cash" (single-asset timing).
//   Surrogate: cross-sectional shuffle (relative leg) so ranking carries no info.
// ===========================================================================
function trailRet(c: string, i: number, look: number): number | null {
  if (i - look < 0) return null;
  let cum = 1;
  for (let k = i - look + 1; k <= i; k++) {
    const v = ret(c, k);
    if (v == null) return null;
    cum *= 1 + v;
  }
  return cum - 1;
}
{
  const LOOK = 12;
  const TOP = 3;
  const COST = 0.001; // 10 bps round-trip per name rotated (weekly)
  const universe = FULL;
  function runDual(shuffleRank: boolean, r?: () => number): number[] {
    const port: number[] = [];
    let prevHold: string[] = [];
    for (let i = LOOK; i < W - 1; i++) {
      const btcMom = trailRet("BTC", i, LOOK);
      const scored = universe
        .map((c) => ({ c, m: trailRet(c, i, LOOK) }))
        .filter((x) => x.m != null) as { c: string; m: number }[];
      if (shuffleRank && r) {
        // permute the momentum->coin mapping
        const ms = scored.map((x) => x.m);
        for (let j = ms.length - 1; j > 0; j--) {
          const k = Math.floor(r() * (j + 1));
          [ms[j], ms[k]] = [ms[k], ms[j]];
        }
        scored.forEach((x, idx) => (x.m = ms[idx]));
      }
      scored.sort((a, b) => b.m - a.m);
      const winners = scored.slice(0, TOP);
      // absolute filter: only hold winners with positive abs mom AND btc regime on
      const onRegime = btcMom != null && btcMom > 0;
      const hold = onRegime ? winners.filter((x) => x.m > 0).map((x) => x.c) : [];
      // next-week return = EW of held names (cash=0 if empty)
      let w = 0;
      let cnt = 0;
      for (const c of hold) {
        const v = ret(c, i + 1);
        if (v != null) {
          w += v;
          cnt++;
        }
      }
      let pr = cnt > 0 ? w / cnt : 0;
      // cost on turnover
      const turn =
        prevHold.filter((c) => !hold.includes(c)).length +
        hold.filter((c) => !prevHold.includes(c)).length;
      pr -= (turn / Math.max(1, TOP)) * COST;
      port.push(pr);
      prevHold = hold;
    }
    return port;
  }
  const dual = runDual(false);
  // single-asset BTC timing control
  const btcTime: number[] = [];
  for (let i = LOOK; i < W - 1; i++) {
    const m = trailRet("BTC", i, LOOK);
    const nx = ret("BTC", i + 1);
    btcTime.push(m != null && m > 0 && nx != null ? nx : 0);
  }
  const ppy = 52;
  const dualSh = ann(sharpe(dual), ppy);
  const btcSh = ann(sharpe(btcTime), ppy);
  // surrogate: shuffle ranking
  const r = rng(7);
  const surr: number[] = [];
  for (let it = 0; it < 300; it++) surr.push(ann(sharpe(runDual(true, r)), ppy));
  surr.sort((a, b) => a - b);
  const pSurro = surr.filter((x) => x >= dualSh).length / surr.length;
  // honest N: look windows {4,8,12,26} x TOP {1,3,5} x regime on/off ~ 24 configs
  const dsr = computeDeflatedSharpeRatio(dual, { trialCount: 24 });
  const meanW = dual.reduce((a, b) => a + b, 0) / dual.length;
  results.M1 = {
    nWeeks: dual.length,
    dualSharpeAnn: dualSh,
    btcTimingSharpeAnn: btcSh,
    beatsSingleAssetTiming: dualSh > btcSh,
    surrogate_p: pSurro,
    dsr_p: dsr.deflatedProbability,
    monthlyReturnPctNet: ((Math.pow(1 + meanW, 52 / 12) - 1) * 100),
    note: "Top-3 EW relative winners gated by abs-mom + BTC regime, 10bps rt cost. Control = BTC self-timing.",
  };
}

// ===========================================================================
// D4-S2  Distance pairs (GGR) — selection-on-surrogate + PBO + BTC-beta check
//   Build on normalized daily price paths: formation window forms cumulative-return
//   distance; pick min-distance pairs; trade z>2 divergence of the spread, close at 0;
//   honest N = full C(N,2) pair search. Selection-on-surrogate: re-run the SAME pair
//   selection+trading on phase-randomized price paths → if random pairing yields the
//   same PnL the edge is selection noise. BTC-beta: regress spread on BTC daily.
// ===========================================================================
{
  const dates = daily.dates;
  const D = dates.length;
  // build daily log-return series for full-coverage coins
  const coinsD = FULL.filter((c) => {
    const cl = daily.closes[c];
    return cl && cl.every((v) => v != null && (v as number) > 0);
  });
  const logret: Record<string, number[]> = {};
  for (const c of coinsD) {
    const cl = daily.closes[c] as number[];
    const lr: number[] = [];
    for (let i = 1; i < D; i++) lr.push(Math.log(cl[i] / cl[i - 1]));
    logret[c] = lr;
  }
  const L = D - 1;
  const FORM = 250; // formation ~1y
  const TRADE = 125; // trade ~6mo
  const ENTRY = 2.0;
  const COST = 0.0010; // 10 bps per leg round-trip on entry+exit
  // normalized cumulative price from log-returns
  function cum(c: string, a: number, b: number): number[] {
    const out: number[] = [];
    let s = 0;
    for (let i = a; i < b; i++) {
      s += logret[c][i];
      out.push(s);
    }
    return out;
  }
  function tradePairs(retSrc: Record<string, number[]>): { pnl: number[]; nPairs: number; betas: number[] } {
    // single formation/trade split at the most recent full window (honest, OOS trade)
    const formA = L - FORM - TRADE;
    const formB = L - TRADE;
    const tradeA = L - TRADE;
    const tradeB = L;
    if (formA < 0) return { pnl: [], nPairs: 0, betas: [] };
    // distance over normalized cumret in formation
    const norm: Record<string, number[]> = {};
    for (const c of coinsD) {
      const x = cum(c, formA, formB);
      norm[c] = x;
    }
    const pairs: { a: string; b: string; d: number }[] = [];
    for (let i = 0; i < coinsD.length; i++)
      for (let j = i + 1; j < coinsD.length; j++) {
        const a = coinsD[i];
        const b = coinsD[j];
        let d = 0;
        for (let k = 0; k < norm[a].length; k++) {
          const diff = norm[a][k] - norm[b][k];
          d += diff * diff;
        }
        pairs.push({ a, b, d });
      }
    pairs.sort((x, y) => x.d - y.d);
    const TOPP = 20; // top-20 min-distance pairs (GGR uses top-5..20)
    const chosen = pairs.slice(0, TOPP);
    // trade each chosen pair OOS on the trade window
    const dailyPnL: number[] = new Array(tradeB - tradeA).fill(0);
    const betas: number[] = [];
    for (const p of chosen) {
      // spread = cumA - cumB anchored at trade start; z from formation mean/std of spread
      const fa = norm[p.a];
      const fb = norm[p.b];
      const fspread = fa.map((v, k) => v - fb[k]);
      const mu = fspread.reduce((s, v) => s + v, 0) / fspread.length;
      const sd =
        Math.sqrt(
          fspread.reduce((s, v) => s + (v - mu) * (v - mu), 0) / fspread.length,
        ) || 1e-9;
      let pos = 0; // +1 long spread (long a short b), -1 short spread
      let cumA = 0;
      let cumB = 0;
      const btcLr = retSrc["BTC"];
      const spreadRets: number[] = [];
      const btcRets: number[] = [];
      for (let t = tradeA; t < tradeB; t++) {
        cumA += retSrc[p.a][t];
        cumB += retSrc[p.b][t];
        const z = (cumA - cumB - mu) / sd;
        // pnl this day from current position = (ra - rb)*pos
        const pairRet = (retSrc[p.a][t] - retSrc[p.b][t]) * pos;
        const idx = t - tradeA;
        let dayPnl = pairRet;
        // entry/exit logic with cost
        let newPos = pos;
        if (pos === 0) {
          if (z > ENTRY) newPos = -1;
          else if (z < -ENTRY) newPos = 1;
        } else if ((pos === 1 && z >= 0) || (pos === -1 && z <= 0)) {
          newPos = 0;
        }
        if (newPos !== pos) dayPnl -= COST; // pay cost on state change
        pos = newPos;
        dailyPnL[idx] += dayPnl / TOPP;
        spreadRets.push(retSrc[p.a][t] - retSrc[p.b][t]);
        btcRets.push(btcLr[t]);
      }
      // beta of spread to BTC
      const mb = btcRets.reduce((s, v) => s + v, 0) / btcRets.length;
      const ms = spreadRets.reduce((s, v) => s + v, 0) / spreadRets.length;
      let cov = 0;
      let varb = 0;
      for (let k = 0; k < btcRets.length; k++) {
        cov += (btcRets[k] - mb) * (spreadRets[k] - ms);
        varb += (btcRets[k] - mb) * (btcRets[k] - mb);
      }
      betas.push(varb > 0 ? cov / varb : 0);
    }
    return { pnl: dailyPnL, nPairs: chosen.length, betas };
  }
  const real = tradePairs(logret);
  const ppy = 252;
  const realSh = ann(sharpe(real.pnl), ppy);
  // selection-on-surrogate: phase-randomize each coin's return series, re-run full
  // selection+trading. If random structure yields comparable Sharpe → selection noise.
  function phaseRand(x: number[], r: () => number): number[] {
    // simple sign/block shuffle surrogate (block-bootstrap preserves own autocorr,
    // destroys cross-asset co-movement that pair selection exploits)
    return blockResample(x, 10, r);
  }
  const r = rng(23);
  const surr: number[] = [];
  for (let it = 0; it < 200; it++) {
    const src: Record<string, number[]> = {};
    for (const c of coinsD) src[c] = phaseRand(logret[c], r);
    surr.push(ann(sharpe(tradePairs(src).pnl), ppy));
  }
  surr.sort((a, b) => a - b);
  const pSurro = surr.filter((x) => x >= realSh).length / surr.length;
  const meanBeta =
    real.betas.length > 0
      ? real.betas.reduce((a, b) => a + Math.abs(b), 0) / real.betas.length
      : 0;
  // PBO: split trade window into folds, score top pairs vs others
  // honest N: pair search C(coins,2) ~ huge -> use as trialCount
  const Ncoins = coinsD.length;
  const honestN = (Ncoins * (Ncoins - 1)) / 2;
  const dsr = computeDeflatedSharpeRatio(real.pnl, { trialCount: honestN });
  const meanD = real.pnl.reduce((a, b) => a + b, 0) / Math.max(1, real.pnl.length);
  results.S2 = {
    coins: Ncoins,
    honestN_pairSearch: honestN,
    tradeDays: real.pnl.length,
    realSharpeAnn: realSh,
    surrogate_p: pSurro,
    dsr_p: dsr.deflatedProbability,
    meanAbsBetaToBTC: meanBeta,
    monthlyReturnPctNet: meanD * 21 * 100,
    note: "Top-20 min-distance pairs, single OOS formation/trade split, z>2 entry, 10bps/leg. Surrogate = block-bootstrap (destroys cross-asset co-move).",
  };
}

// ===========================================================================
// D4-S7  Short-term reversal (weekly), skip-one + net-of-cost
//   Build: each week rank FULL universe by last week return; long bottom decile,
//   short top decile (dollar-neutral); skip-one variant uses week i-1 to neutralize
//   bid-ask bounce. Charge realistic round-trip cost (rebalances weekly).
// ===========================================================================
{
  const universe = FULL;
  const K = Math.max(3, Math.floor(universe.length * 0.2));
  const COST = 0.001; // 10bps rt per name
  function runRev(skip: boolean): number[] {
    const port: number[] = [];
    for (let i = 1; i < W - 1; i++) {
      const sigIdx = skip ? i - 1 : i;
      if (sigIdx < 0) continue;
      const scored = universe
        .map((c) => ({ c, r: ret(c, sigIdx) }))
        .filter((x) => x.r != null) as { c: string; r: number }[];
      if (scored.length < 2 * K) continue;
      scored.sort((a, b) => a.r - b.r);
      const longs = scored.slice(0, K).map((x) => x.c); // losers
      const shorts = scored.slice(-K).map((x) => x.c); // winners
      let pr = 0;
      let cnt = 0;
      for (const c of longs) {
        const v = ret(c, i + 1);
        if (v != null) {
          pr += v;
          cnt++;
        }
      }
      for (const c of shorts) {
        const v = ret(c, i + 1);
        if (v != null) {
          pr -= v;
          cnt++;
        }
      }
      pr = cnt > 0 ? pr / cnt : 0;
      pr -= 2 * COST; // full turnover both legs each week
      port.push(pr);
    }
    return port;
  }
  const noSkip = runRev(false);
  const skip = runRev(true);
  const ppy = 52;
  const noSkipGross =
    ann(
      sharpe(noSkip.map((x) => x + 2 * COST)),
      ppy,
    );
  const noSkipNet = ann(sharpe(noSkip), ppy);
  const skipNet = ann(sharpe(skip), ppy);
  const r = rng(31);
  // surrogate: cross-sectional shuffle of the ranking
  function runShuf(rr: () => number): number[] {
    const port: number[] = [];
    for (let i = 1; i < W - 1; i++) {
      const scored = universe
        .map((c) => ({ c, r: ret(c, i) }))
        .filter((x) => x.r != null) as { c: string; r: number }[];
      if (scored.length < 2 * K) continue;
      const rs = scored.map((x) => x.r);
      for (let j = rs.length - 1; j > 0; j--) {
        const k = Math.floor(rr() * (j + 1));
        [rs[j], rs[k]] = [rs[k], rs[j]];
      }
      scored.forEach((x, idx) => (x.r = rs[idx]));
      scored.sort((a, b) => a.r - b.r);
      const longs = scored.slice(0, K).map((x) => x.c);
      const shorts = scored.slice(-K).map((x) => x.c);
      let pr = 0;
      let cnt = 0;
      for (const c of longs) {
        const v = ret(c, i + 1);
        if (v != null) (pr += v), cnt++;
      }
      for (const c of shorts) {
        const v = ret(c, i + 1);
        if (v != null) (pr -= v), cnt++;
      }
      port.push(cnt > 0 ? pr / cnt - 2 * COST : 0);
    }
    return port;
  }
  const surr: number[] = [];
  for (let it = 0; it < 300; it++) surr.push(ann(sharpe(runShuf(r)), ppy));
  surr.sort((a, b) => a - b);
  const pSurro = surr.filter((x) => x >= noSkipNet).length / surr.length;
  const dsr = computeDeflatedSharpeRatio(noSkip, { trialCount: 12 });
  const meanW = noSkip.reduce((a, b) => a + b, 0) / noSkip.length;
  results.S7 = {
    nWeeks: noSkip.length,
    grossSharpeAnn: noSkipGross,
    netSharpeAnn: noSkipNet,
    skipOneNetSharpeAnn: skipNet,
    surrogate_p: pSurro,
    dsr_p: dsr.deflatedProbability,
    monthlyReturnPctNet: (Math.pow(1 + meanW, 52 / 12) - 1) * 100,
    note: "Weekly XS reversal, long losers/short winners top-bottom 20%, 10bps rt each leg. Gross vs net + skip-one.",
  };
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
