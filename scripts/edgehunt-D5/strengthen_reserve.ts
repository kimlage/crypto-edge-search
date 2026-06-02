/**
 * D5-08 STRENGTHENING — genuinely try to lift the exchange reserve-depletion / netflow-trend edge
 * above the binding DSR/haircut gate while keeping HONEST N and strict causality.
 *
 * Baseline (run_d5.ts `reserve`): best net Sharpe 0.994 (vs B&H 0.912), surrogate p=0.013 PASS,
 * but binding gate = deflated_sharpe (DSR p=0.73 @ N=54) and haircut (adjP=0.096). PROMISING.
 *
 * The edge is REAL per the phase-randomization surrogate (the flow TIMING carries info), but the
 * EXCESS over long-beta is thin and the N=54 multiple-testing penalty sinks DSR. Honest levers that
 * do NOT cheat the null:
 *   V1 netflow RATIO  = (FlowIn-FlowOut)/(FlowIn+FlowOut) — scale-free / stationary vs raw native
 *                        counts that grow with adoption (a cleaner, less price-coupled oscillator).
 *   V2 reserve TREND  = slope of cumulative netflow (the literal "reserve depletion" balance proxy).
 *   V3 price-ORTHOG   = netflow-Z residualized on trailing return (directly bakes in the detrend-
 *                        vs-price control instead of leaning on the surrogate to remove it).
 *   V4 combine        = best ratio long-leg + asymmetric inflow short, exposure-aware.
 *
 * Each variant is judged by the SAME committed gauntlet (runGauntlet) with its OWN honest N (every
 * config in its grid). All features LAGGED >= LAG days; next-day return; phase-randomization
 * surrogate (crossSectional:false). We report which, if any, clears DSR/haircut at honest N, and a
 * pre-registered CANONICAL (N=1) for each so the registered-bet DSR is visible.
 */
import fs from "node:fs";
import {
  loadPanel,
  runGauntlet,
  printVerdict,
  ema,
  sma,
  rollingZ,
  mean,
  std,
  type Panel,
  type GauntletOutput,
} from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const LAG = 1;
const OUT = "output/edgehunt-D5";

function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

// position from a z-signal: strong OUTflow (z<=-thr) -> long; strong INflow (z>=thr) -> short/flat
function bandPos(P: Panel, z: number[], thr: number, side: string): number[] {
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    if (z[t] <= -thr) pos[t] = 1;
    else if (z[t] >= thr) pos[t] = side === "longshort" ? -1 : 0;
    else pos[t] = 0;
  }
  return pos;
}

// ---------------------------------------------------------------- V1: netflow RATIO oscillator
function v1_ratio(P: Panel): GauntletOutput {
  const fin = lag(P.flowInNtv, LAG);
  const fout = lag(P.flowOutNtv, LAG);
  // scale-free net pressure in [-1,1]; positive = net IN (bearish)
  const ratio = P.price.map((_, t) => {
    const a = fin[t], b = fout[t];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    const den = a + b;
    return den > 0 ? (a - b) / den : NaN;
  });
  const signal = (smooth: number, zwin: number) => rollingZ(ema(ratio, smooth), zwin);
  const smooths = [7, 14, 30];
  const zwins = [90, 180, 365];
  const thr = [0.5, 1, 1.5];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const s of smooths) for (const zw of zwins) for (const th of thr) for (const sd of sides)
    configs.push({ smooth: s, zwin: zw, thr: th, side: sd });
  const build = (cfg: Record<string, number | string>, sig?: number[]) =>
    bandPos(P, sig ?? signal(cfg.smooth as number, cfg.zwin as number), cfg.thr as number, cfg.side as string);
  return runGauntlet({
    name: "D5-08v1 netflow-RATIO oscillator (BTC)",
    P, configs,
    canonical: { smooth: 14, zwin: 180, thr: 1, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg, phaseRandomize(signal(cfg.smooth as number, cfg.zwin as number), rng)),
    startIdx: 700,
  });
}

// ---------------------------------------------------------------- V2: reserve-LEVEL trend
function v2_reserveTrend(P: Panel): GauntletOutput {
  const fin = lag(P.flowInNtv, LAG);
  const fout = lag(P.flowOutNtv, LAG);
  // reserve balance PROXY = cumulative net inflow (rising = coins piling on exchanges = bearish).
  // Only an anchored proxy of the *change*; we trade its trend (slope), so the arbitrary anchor is
  // irrelevant. Slope < 0 over `win` = reserves depleting = bullish.
  const cum = new Array(P.price.length).fill(NaN);
  let acc = 0, started = false;
  for (let t = 0; t < P.price.length; t++) {
    if (Number.isFinite(fin[t]) && Number.isFinite(fout[t])) {
      acc += fin[t] - fout[t];
      started = true;
    }
    if (started) cum[t] = acc;
  }
  // normalize the slope by trailing supply scale -> fractional reserve change per day
  const slope = (win: number) => {
    const out = new Array(P.price.length).fill(NaN);
    for (let t = win - 1; t < P.price.length; t++) {
      // OLS slope of cum over [t-win+1, t]
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = t - win + 1; k <= t; k++) {
        if (!Number.isFinite(cum[k])) { n = 0; break; }
        const x = k - (t - win + 1);
        n++; sx += x; sy += cum[k]; sxx += x * x; sxy += x * cum[k];
      }
      if (n < win) continue;
      const den = n * sxx - sx * sx;
      if (Math.abs(den) < 1e-9) continue;
      const b = (n * sxy - sx * sy) / den;
      const sc = P.supply[t] > 0 ? P.supply[t] : 1;
      out[t] = b / sc; // fractional reserve change/day
    }
    return out;
  };
  const signal = (win: number, zwin: number) => rollingZ(slope(win), zwin);
  const wins = [14, 30, 60];
  const zwins = [90, 180, 365];
  const thr = [0.5, 1, 1.5];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const w of wins) for (const zw of zwins) for (const th of thr) for (const sd of sides)
    configs.push({ win: w, zwin: zw, thr: th, side: sd });
  const build = (cfg: Record<string, number | string>, sig?: number[]) =>
    bandPos(P, sig ?? signal(cfg.win as number, cfg.zwin as number), cfg.thr as number, cfg.side as string);
  return runGauntlet({
    name: "D5-08v2 reserve-LEVEL trend slope (BTC)",
    P, configs,
    canonical: { win: 30, zwin: 180, thr: 1, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg, phaseRandomize(signal(cfg.win as number, cfg.zwin as number), rng)),
    startIdx: 700,
  });
}

// ---------------------------------------------------------------- V3: price-ORTHOGONALIZED netflow
function v3_orthog(P: Panel): GauntletOutput {
  const fin = lag(P.flowInNtv, LAG);
  const fout = lag(P.flowOutNtv, LAG);
  const netInflow = P.price.map((_, t) =>
    Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN);
  // trailing return (already realized, causal) the flow gets residualized against
  const retL = P.price.map((p, t) => (t > LAG && P.price[t - LAG] > 0 ? Math.log(P.price[t - LAG] / P.price[t - LAG - 1]) : NaN));
  // residualize smoothed netflow on a causal expanding OLS vs trailing return, then z-score residual
  const signal = (smooth: number, zwin: number) => {
    const sm = ema(netInflow, smooth);
    const res = new Array(P.price.length).fill(NaN);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let t = 0; t < P.price.length; t++) {
      if (n >= 200 && Number.isFinite(sm[t]) && Number.isFinite(retL[t])) {
        const den = n * sxx - sx * sx;
        if (Math.abs(den) > 1e-9) {
          const b = (n * sxy - sx * sy) / den;
          const a = (sy - b * sx) / n;
          res[t] = sm[t] - (a + b * retL[t]); // netflow with the price-coupled part removed
        }
      }
      if (Number.isFinite(sm[t]) && Number.isFinite(retL[t])) {
        n++; sx += retL[t]; sy += sm[t]; sxx += retL[t] * retL[t]; sxy += retL[t] * sm[t];
      }
    }
    return rollingZ(res, zwin);
  };
  const smooths = [7, 14, 30];
  const zwins = [90, 180, 365];
  const thr = [0.5, 1, 1.5];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const s of smooths) for (const zw of zwins) for (const th of thr) for (const sd of sides)
    configs.push({ smooth: s, zwin: zw, thr: th, side: sd });
  const build = (cfg: Record<string, number | string>, sig?: number[]) =>
    bandPos(P, sig ?? signal(cfg.smooth as number, cfg.zwin as number), cfg.thr as number, cfg.side as string);
  return runGauntlet({
    name: "D5-08v3 price-ORTHOGONALIZED netflow (BTC)",
    P, configs,
    canonical: { smooth: 14, zwin: 180, thr: 1, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg, phaseRandomize(signal(cfg.smooth as number, cfg.zwin as number), rng)),
    startIdx: 900,
  });
}

const REG: Record<string, (P: Panel) => GauntletOutput> = {
  v1_ratio,
  v2_reserveTrend,
  v3_orthog,
};

const P = loadPanel("btc");
const summary: Record<string, unknown> = {};
const arg = process.argv[2] ?? "all";
const ids = arg === "all" ? Object.keys(REG) : [arg];
for (const id of ids) {
  const o = REG[id](P);
  printVerdict(o);
  fs.writeFileSync(`${OUT}/strengthen_${id}.json`, JSON.stringify(o, null, 2));
  summary[id] = {
    verdict: o.verdict, netSharpe: o.best.netSharpeAnn, binding: o.bindingGate,
    honestN: o.honestN, surrP: o.surrogateP, holdout: o.holdoutSharpeAnn,
    dsr: o.gates.deflated_sharpe.detail, haircut: o.gates.haircut.detail,
    canonNet: o.canonical.netSharpeAnn, canonSurrP: o.canonical.surrogateP,
  };
}
fs.writeFileSync(`${OUT}/strengthen_summary.json`, JSON.stringify(summary, null, 2));
console.log("\n==== STRENGTHEN SUMMARY ====");
console.log(JSON.stringify(summary, null, 2));
