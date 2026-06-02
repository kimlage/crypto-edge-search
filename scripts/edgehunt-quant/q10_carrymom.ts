/**
 * Q10-CARRYMOM — Carry + momentum double-sort combo (cross-sectional, dollar-neutral perp book).
 *
 * Question: does a double-sort of funding-carry × XS price-momentum beat each leg ALONE,
 * net of cost, at honest N? Null = cross-sectional shuffle.
 *
 * Panel: 8 Binance perps with real 8h funding (BTC ETH BNB SOL XRP DOGE ADA AVAX),
 *        daily 2023-06-01 .. 2026-05-31 (1096 days). On-disk $0 data: output/funding/*.
 *
 * Economics (perp dollar-neutral book, weekly rebalance):
 *  - We rank coins each Friday-close by a signal; long the top tercile, short the bottom tercile,
 *    equal-weight within each leg, dollar-neutral (sum weights = 0, gross = 1).
 *  - Weekly return of a leg = price log-return of the perp over the week + funding earned/paid.
 *      A SHORT perp earns +funding (positive funding => longs pay shorts); a LONG perp pays it.
 *      fundingPnL_i over the week = -weight_i * sum(fundingRate over the week)  (short => +fr).
 *  - Cost: 4 bps taker per side on every unit of weight turned over (committed COST_PER_SIDE).
 *
 * Gauntlet (committed primitives, panel-correct):
 *  - net-of-cost (taker 4bps/side)
 *  - baselines / matched-exposure controls: carry-ONLY leg, momentum-ONLY leg, equal-weight long
 *    book, random dollar-neutral lottery (95th pct), beta-neutrality (regress on EW market).
 *  - Deflated Sharpe @ HONEST N (= every config scored in-sample)
 *  - CSCV / PBO across all configs
 *  - Harvey-Liu (Bonferroni) haircut
 *  - RIGHT surrogate null = CROSS-SECTIONAL SHUFFLE (permute signal->asset map each rebalance;
 *    preserves the return panel + cross-correlations, destroys only the cross-sectional ranking)
 *  - consume-once forward holdout (last 20%)
 *
 * The headline test is the COMBO vs each leg alone (super-additivity), all net & at honest N.
 */
import fs from "node:fs";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const COST_PER_SIDE = 0.0004; // 4 bps taker per side
const SYMS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];
const N = SYMS.length;
const ANN_W = Math.sqrt(52); // weekly -> annual

// ----------------------------------------------------------------- load panel
interface PanelData {
  dates: string[]; // daily ISO, aligned across coins
  price: number[][]; // [coin][day] perp close
  fundDaily: number[][]; // [coin][day] sum of 8h funding rates that fell on that UTC date
}

function loadPanel(): PanelData {
  // intersect daily dates across all coins
  const priceMaps: Map<string, number>[] = [];
  const fundMaps: Map<string, number>[] = [];
  for (const s of SYMS) {
    const p = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/${s}USDT_prices_daily.json`, "utf8"));
    const pm = new Map<string, number>();
    for (const r of p) pm.set(r.date, Number(r.perpClose)); // perp price (book is on perps)
    priceMaps.push(pm);
    const f = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/${s}USDT_funding_8h.json`, "utf8"));
    const fm = new Map<string, number>();
    for (const r of f) {
      const d = new Date(r.fundingTime).toISOString().slice(0, 10);
      fm.set(d, (fm.get(d) ?? 0) + Number(r.fundingRate));
    }
    fundMaps.push(fm);
  }
  let dates = [...priceMaps[0].keys()];
  for (let i = 1; i < N; i++) dates = dates.filter((d) => priceMaps[i].has(d));
  dates.sort();
  const price: number[][] = SYMS.map(() => []);
  const fundDaily: number[][] = SYMS.map(() => []);
  for (const d of dates) {
    for (let i = 0; i < N; i++) {
      price[i].push(priceMaps[i].get(d)!);
      fundDaily[i].push(fundMaps[i].get(d) ?? 0);
    }
  }
  return { dates, price, fundDaily };
}

// ----------------------------------------------------------------- math utils
function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
}
function sharpe(a: number[]): number {
  const s = std(a);
  return s > 1e-12 ? mean(a) / s : 0;
}
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// rank -> centered z in [-1,1]-ish via demeaned rank fraction
function ranks(x: number[]): number[] {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const r = new Array(x.length);
  for (let k = 0; k < idx.length; k++) r[idx[k]] = k;
  return r; // 0..n-1
}

// ----------------------------------------------------------------- weekly grid
// Build weekly rebalance indices (every 7 days) on the daily date axis.
function weeklyAnchors(nDays: number, step = 7, warmup = 0): number[] {
  const out: number[] = [];
  for (let t = warmup; t + step < nDays; t += step) out.push(t);
  return out;
}

// ----------------------------------------------------------------- book builder
type Combine = "rank_avg" | "double_sort" | "carry_only" | "mom_only";
interface Cfg {
  carryLb: number; // funding lookback in DAYS for carry signal
  momLb: number; // momentum lookback in DAYS
  momSkip: number; // skip-recent days (avoid 1d reversal)
  q: number; // tercile-ish leg size (# coins per leg)
  combine: Combine;
  step: number; // rebalance step (days)
  [k: string]: number | string;
}

// Signal at anchor day t (causal: uses data up to and INCLUDING close t).
function carrySignal(P: PanelData, t: number, lb: number): number[] {
  // mean daily funding over trailing lb days (proxy for funding-carry level).
  // High funding => expensive to be long => we SHORT it (short earns funding). So the carry
  // ALPHA score = -funding (rank high => long). i.e. long low/negative funding, short high funding.
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, t - lb + 1); k <= t; k++) {
      s += P.fundDaily[i][k];
      c++;
    }
    out.push(c ? -(s / c) : 0);
  }
  return out;
}
function momSignal(P: PanelData, t: number, lb: number, skip: number): number[] {
  // trailing log return from (t-lb-skip) to (t-skip); long winners.
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = t - skip;
    const b = t - skip - lb;
    if (b < 0) {
      out.push(0);
      continue;
    }
    out.push(Math.log(P.price[i][a] / P.price[i][b]));
  }
  return out;
}

// Build weekly NET return series for a config. `signalOverride` lets the surrogate inject a
// shuffled ranking each rebalance.
function buildWeekly(
  P: PanelData,
  cfg: Cfg,
  anchors: number[],
  signalOverride?: (t: number) => number[],
): { net: number[]; gross: number[]; mkt: number[]; beta: number } {
  const net: number[] = [];
  const gross: number[] = [];
  const mkt: number[] = []; // equal-weight market weekly return (for beta-neutrality)
  let prevW = new Array(N).fill(0);
  for (const t of anchors) {
    const nextT = t + cfg.step;
    if (nextT >= P.dates.length) break;
    // --- target weights from signal ---
    let score: number[];
    if (signalOverride) {
      score = signalOverride(t);
    } else if (cfg.combine === "carry_only") {
      score = carrySignal(P, t, cfg.carryLb);
    } else if (cfg.combine === "mom_only") {
      score = momSignal(P, t, cfg.momLb, cfg.momSkip);
    } else if (cfg.combine === "rank_avg") {
      const cR = ranks(carrySignal(P, t, cfg.carryLb));
      const mR = ranks(momSignal(P, t, cfg.momLb, cfg.momSkip));
      score = cR.map((c, i) => c + mR[i]); // avg of ranks (sum, monotone equiv)
    } else {
      // double_sort (conditional intersection): a coin is a strong LONG only if it ranks high on
      // BOTH carry and momentum -> use the MIN of the two ranks as the long-score (must clear both
      // hurdles). Symmetrically the lowest min-ranks are the strong shorts. Tie-break by rank-sum.
      const cR = ranks(carrySignal(P, t, cfg.carryLb));
      const mR = ranks(momSignal(P, t, cfg.momLb, cfg.momSkip));
      score = cR.map((c, i) => Math.min(c, mR[i]) + 0.001 * (c + mR[i]));
    }
    // pick legs
    const order = score.map((_, i) => i).sort((a, b) => score[a] - score[b]);
    const q = cfg.q;
    const longs = new Set(order.slice(N - q));
    const shorts = new Set(order.slice(0, q));
    const w = new Array(N).fill(0);
    for (const i of longs) w[i] = 1 / q;
    for (const i of shorts) w[i] = -1 / q;
    // --- realize PnL over [t, nextT] ---
    let g = 0;
    let mk = 0;
    for (let i = 0; i < N; i++) {
      const pr = Math.log(P.price[i][nextT] / P.price[i][t]);
      // funding earned over the holding week: short leg (w<0) earns +funding.
      let fr = 0;
      for (let k = t + 1; k <= nextT; k++) fr += P.fundDaily[i][k];
      const legRet = w[i] * pr + -w[i] * fr; // price + funding(short receives)
      g += legRet;
      mk += (1 / N) * pr; // EW market (price only)
    }
    // turnover cost: sum |w_i - prevW_i| * costPerSide
    let turn = 0;
    for (let i = 0; i < N; i++) turn += Math.abs(w[i] - prevW[i]);
    const cost = turn * COST_PER_SIDE;
    gross.push(g);
    net.push(g - cost);
    mkt.push(mk);
    prevW = w;
  }
  // beta of net book to EW market
  const mm = mean(mkt);
  const mn = mean(net);
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < net.length; i++) {
    cov += (net[i] - mn) * (mkt[i] - mm);
    varM += (mkt[i] - mm) ** 2;
  }
  const beta = varM > 1e-12 ? cov / varM : 0;
  return { net, gross, mkt, beta };
}

// ----------------------------------------------------------------- gauntlet
function annSh(weekly: number[]): number {
  return sharpe(weekly) * ANN_W;
}

function main() {
  const P = loadPanel();
  const T = P.dates.length;
  console.log(`panel: ${N} coins, ${T} days ${P.dates[0]}..${P.dates[T - 1]}`);

  // ---------- honest config grid (count EVERY config) ----------
  const carryLbs = [7, 14, 30];
  const momLbs = [14, 30, 60, 90];
  const momSkips = [0, 7];
  const qs = [2, 3];
  const steps = [7];
  const combines: Combine[] = ["rank_avg", "double_sort"];
  const warmup = 90 + 7; // enough for the longest mom lookback+skip
  const cfgs: Cfg[] = [];
  for (const combine of combines)
    for (const carryLb of carryLbs)
      for (const momLb of momLbs)
        for (const momSkip of momSkips)
          for (const q of qs)
            for (const step of steps)
              cfgs.push({ carryLb, momLb, momSkip, q, combine, step });
  const HONEST_N = cfgs.length;

  const anchorsAll = weeklyAnchors(T, 7, warmup);
  // in-sample / holdout split on the ANCHOR axis (consume-once last 20%)
  const splitA = Math.floor(anchorsAll.length * 0.8);
  const anchorsIS = anchorsAll.slice(0, splitA);
  const anchorsOOS = anchorsAll.slice(splitA);

  // score every combo config in-sample
  const scored = cfgs.map((cfg) => {
    const r = buildWeekly(P, cfg, anchorsIS);
    return { cfg, r, netSh: annSh(r.net), label: `${cfg.combine}|cLb${cfg.carryLb}|mLb${cfg.momLb}|sk${cfg.momSkip}|q${cfg.q}` };
  });
  scored.sort((a, b) => b.netSh - a.netSh);
  const best = scored[0];

  // ---------- leg-alone controls (matched construction) ----------
  // carry-only and mom-only at the BEST config's lookbacks & q (matched exposure & turnover style)
  const carryOnlyCfg: Cfg = { ...best.cfg, combine: "carry_only" };
  const momOnlyCfg: Cfg = { ...best.cfg, combine: "mom_only" };
  const carryOnly = buildWeekly(P, carryOnlyCfg, anchorsIS);
  const momOnly = buildWeekly(P, momOnlyCfg, anchorsIS);
  const carrySh = annSh(carryOnly.net);
  const momSh = annSh(momOnly.net);
  // also best carry-only and best mom-only across their own grids (fairest "each alone")
  let bestCarryOnly = -Infinity;
  let bestMomOnly = -Infinity;
  for (const carryLb of carryLbs)
    for (const q of qs) {
      const r = buildWeekly(P, { ...best.cfg, combine: "carry_only", carryLb, q }, anchorsIS);
      bestCarryOnly = Math.max(bestCarryOnly, annSh(r.net));
    }
  for (const momLb of momLbs)
    for (const momSkip of momSkips)
      for (const q of qs) {
        const r = buildWeekly(P, { ...best.cfg, combine: "mom_only", momLb, momSkip, q }, anchorsIS);
        bestMomOnly = Math.max(bestMomOnly, annSh(r.net));
      }

  // equal-weight long market book (gross 1, long-only) net of weekly rebal cost ~0 (static)
  const ewNet: number[] = [];
  for (const t of anchorsIS) {
    const nextT = t + 7;
    if (nextT >= T) break;
    let g = 0;
    for (let i = 0; i < N; i++) g += (1 / N) * Math.log(P.price[i][nextT] / P.price[i][t]);
    ewNet.push(g);
  }
  const ewSh = annSh(ewNet);

  // random dollar-neutral lottery (matched leg size q), 95th pct
  const rl: number[] = [];
  for (let s = 0; s < 200; s++) {
    const rng = mkRng(13 + s * 2654435761);
    const r = buildWeekly(P, best.cfg, anchorsIS, (_t) => Array.from({ length: N }, () => rng()));
    rl.push(annSh(r.net));
  }
  rl.sort((a, b) => a - b);
  const rl95 = rl[Math.floor(rl.length * 0.95)];

  // ---------- the SUPER-ADDITIVITY test: combo must beat BOTH legs alone ----------
  const beatsCarry = best.netSh > bestCarryOnly + 1e-9;
  const beatsMom = best.netSh > bestMomOnly + 1e-9;
  const baselinesPass =
    best.netSh > 0 && best.netSh > ewSh && best.netSh > rl95 && beatsCarry && beatsMom;

  // ---------- Deflated Sharpe @ honest N (per-period series) ----------
  const dsr = computeDeflatedSharpeRatio(best.r.net, { trialCount: HONEST_N });
  const dsrPass = dsr.deflatedProbability > 0.95;

  // ---------- block bootstrap CI on mean weekly net ----------
  const bb = blockBootstrapConfidenceInterval(best.r.net, {
    statistic: "mean",
    iterations: 2000,
    blockLength: 6,
    confidenceLevel: 0.95,
    seed: "q10-carrymom-bb",
  });
  const bbPass = bb.lower > 0;

  // ---------- CSCV / PBO across all configs ----------
  const NFOLDS = 6;
  const toFolds = (series: number[]) => {
    const folds: number[][] = [];
    const sz = Math.floor(series.length / NFOLDS);
    for (let f = 0; f < NFOLDS; f++) {
      const lo = f * sz;
      const hi = f === NFOLDS - 1 ? series.length : lo + sz;
      folds.push(series.slice(lo, hi));
    }
    return folds;
  };
  let pbo = { pbo: 1, medianLogit: 0 };
  try {
    const r = estimateCscvPbo(
      scored.map((s) => ({ id: s.label, folds: toFolds(s.r.net) })),
      { statistic: "sharpe", trainFraction: 0.5 },
    );
    pbo = { pbo: r.pbo, medianLogit: r.medianLogit };
  } catch (e) {
    pbo = { pbo: 1, medianLogit: 0 };
  }
  const pboPass = pbo.pbo < 0.5;

  // ---------- Harvey-Liu (Bonferroni) haircut ----------
  const psr = computeProbSharpe(best.r.net);
  const adjP = Math.min(1, psr * HONEST_N);
  const haircutPass = adjP < 0.05;

  // ---------- RIGHT surrogate: CROSS-SECTIONAL SHUFFLE ----------
  // permute the signal->asset mapping each rebalance: destroys cross-sectional ranking but keeps
  // the realized return panel + cross-correlation + the marginal funding distribution intact.
  const nSurr = 500;
  const surr: number[] = [];
  for (let s = 0; s < nSurr; s++) {
    const rng = mkRng(900000 + s * 7919);
    const r = buildWeekly(P, best.cfg, anchorsIS, (t) => {
      // real combined score, then shuffle which asset gets which score (Fisher-Yates)
      let real: number[];
      if (best.cfg.combine === "double_sort") {
        const cR = ranks(carrySignal(P, t, best.cfg.carryLb));
        const mR = ranks(momSignal(P, t, best.cfg.momLb, best.cfg.momSkip));
        real = cR.map((c, i) => Math.min(c, mR[i]) + 0.001 * (c + mR[i]));
      } else {
        const cR = ranks(carrySignal(P, t, best.cfg.carryLb));
        const mR = ranks(momSignal(P, t, best.cfg.momLb, best.cfg.momSkip));
        real = cR.map((c, i) => c + mR[i]);
      }
      const perm = real.slice();
      for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      return perm;
    });
    surr.push(annSh(r.net));
  }
  surr.sort((a, b) => a - b);
  const surrAbove = surr.filter((x) => x >= best.netSh).length;
  const surrP = (surrAbove + 1) / (nSurr + 1);
  const surrPass = surrP < 0.05;

  // ---------- consume-once forward holdout (best cfg, OOS) ----------
  const hold = buildWeekly(P, best.cfg, anchorsOOS);
  const holdSh = annSh(hold.net);
  const holdoutPass = holdSh > 0;

  // ---------- beta neutrality ----------
  const betaOK = Math.abs(best.r.beta) < 0.25;

  // ---------- assemble ----------
  const meanWeeklyNet = mean(best.r.net);
  const monthly100k = (meanWeeklyNet / 7) * 30 * 100000; // weekly mean -> per-day -> month
  const gates: Record<string, { pass: boolean; detail: string }> = {
    net_of_cost: {
      pass: meanWeeklyNet > 0,
      detail: `meanWeeklyNet=${meanWeeklyNet.toExponential(3)} grossSh=${annSh(best.r.gross).toFixed(3)} turnoverFrac~`,
    },
    baselines_legs: {
      pass: baselinesPass,
      detail: `comboNetSh=${best.netSh.toFixed(3)} | bestCarryOnly=${bestCarryOnly.toFixed(3)} bestMomOnly=${bestMomOnly.toFixed(3)} EW=${ewSh.toFixed(3)} randDN95=${rl95.toFixed(3)} | beatsCarry=${beatsCarry} beatsMom=${beatsMom}`,
    },
    beta_neutral: { pass: betaOK, detail: `beta(book,EWmkt)=${best.r.beta.toFixed(3)}` },
    deflated_sharpe: {
      pass: dsrPass,
      detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N}`,
    },
    block_bootstrap: {
      pass: bbPass,
      detail: `meanWk CI95=[${bb.lower.toExponential(3)},${bb.upper.toExponential(3)}]`,
    },
    cpcv_pbo: { pass: pboPass, detail: `PBO=${pbo.pbo.toFixed(3)} medLogit=${pbo.medianLogit.toFixed(3)}` },
    haircut: { pass: haircutPass, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psr=${psr.toExponential(3)}*N=${HONEST_N})` },
    surrogate_xshuffle: {
      pass: surrPass,
      detail: `xs-shuffle p=${surrP.toFixed(4)} real=${best.netSh.toFixed(3)} surrMean=${mean(surr).toFixed(3)} surr95=${surr[Math.floor(nSurr * 0.95)].toFixed(3)}`,
    },
    holdout: { pass: holdoutPass, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${hold.net.length} weeks` },
  };
  const order = [
    "net_of_cost",
    "baselines_legs",
    "beta_neutral",
    "deflated_sharpe",
    "block_bootstrap",
    "cpcv_pbo",
    "haircut",
    "surrogate_xshuffle",
    "holdout",
  ];
  let binding = "none";
  for (const g of order)
    if (!gates[g].pass) {
      binding = g;
      break;
    }
  const allPass = binding === "none";
  const coreOK = gates.net_of_cost.pass && gates.baselines_legs.pass && gates.surrogate_xshuffle.pass && gates.holdout.pass && gates.beta_neutral.pass;
  const verdict = allPass ? "SURVIVE" : coreOK ? "PROMISING" : "KILL";

  console.log(`\n================ Q10-CARRYMOM ================`);
  console.log(`honestN=${HONEST_N}  ISanchors=${anchorsIS.length} OOSanchors=${anchorsOOS.length}`);
  console.log(`best=${best.label}  comboNetSharpeAnn=${best.netSh.toFixed(3)}`);
  console.log(`legs alone: bestCarryOnly=${bestCarryOnly.toFixed(3)} bestMomOnly=${bestMomOnly.toFixed(3)}`);
  for (const g of order) console.log(`  [${gates[g].pass ? "PASS" : "KILL"}] ${g} — ${gates[g].detail}`);
  console.log(`monthly@$100k=${binding === "none" ? "$" + Math.round(monthly100k) : "n/a (failed gate)"}  (info: $${Math.round(monthly100k)})`);
  console.log(
    `VERDICT: ${verdict} | net Sharpe ${best.netSh.toFixed(3)} | binding gate ${binding} | honest N ${HONEST_N} | surrogate p ${surrP.toFixed(3)} | monthly@$100k ${binding === "none" ? "$" + Math.round(monthly100k) : "n/a"} | holdoutSharpe ${holdSh.toFixed(3)}`,
  );

  // dump JSON for record
  fs.writeFileSync(
    `${ROOT}/output/edgehunt-quant/q10_carrymom.json`,
    JSON.stringify(
      {
        honestN: HONEST_N,
        best: { label: best.label, cfg: best.cfg, netSharpeAnn: best.netSh, beta: best.r.beta, meanWeeklyNet, monthly100k },
        legs: { bestCarryOnly, bestMomOnly, carrySh, momSh, ewSh, rl95 },
        gates,
        binding,
        verdict,
        surrP,
        holdSh,
      },
      null,
      2,
    ),
  );
}

// PSR p (one-sided p that Sharpe<=0), skew/kurt adjusted
function computeProbSharpe(returns: number[]): number {
  const s = summarizeReturnSeries(returns);
  if (s.sampleCount < 3 || s.stdDev <= 0) return 1;
  const sh = s.sharpe;
  const denom = Math.sqrt(Math.max(1e-9, 1 - s.skewness * sh + ((s.kurtosis - 1) / 4) * sh * sh));
  const z = (sh * Math.sqrt(s.sampleCount - 1)) / denom;
  return 1 - normalCdf(z);
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

main();
