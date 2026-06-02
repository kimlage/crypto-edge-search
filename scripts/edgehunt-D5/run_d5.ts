/**
 * D5 edgehunt — strongest-honest tests of on-chain valuation/flow hypotheses, run through the
 * committed gauntlet (harness.ts). Each strategy:
 *   - builds a STRICTLY causal position from on-chain features LAGGED >= LAG days (revision/flash
 *     risk: the POC flags 8336 flash-status flows; lagging >=1d is mandatory).
 *   - earns NEXT-day return (no contemporaneous bar) — verifies causality.
 *   - is judged net-of-cost vs baselines, DSR @ honest N (= grid size), CPCV/PBO, Harvey-Liu
 *     haircut, the RIGHT surrogate (time-series phase-randomization, crossSectional:false), and a
 *     consume-once forward holdout.
 *
 * Run a single hypothesis:  tsx run_d5.ts <id>     (id in {mvrvz, metcalfe, reserve, puell,
 *                                                    hashribbon, ssr, s2f, realprice, nvtproxy})
 * Run all: tsx run_d5.ts all
 */
import fs from "node:fs";
import {
  loadPanel,
  loadStables,
  runGauntlet,
  printVerdict,
  ema,
  sma,
  rollingZ,
  mkRng,
  type Panel,
  type GauntletOutput,
} from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const LAG = 1; // on-chain features lagged >=1 day (revision/flash risk + causality)
const OUT = "output/edgehunt-D5";

// lag a series by k days (feature value used at day t is from day t-k)
function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

// ----------------------------------------------------------------------------------------------
// D5-03 — MVRV-Z extreme bands. Long when MVRV-Z below buy band; flat/short when above sell band.
// Long-only "buy cheap valuation" is the canonical use. We test long/flat and long/short variants.
// KEY control: price-only standardized surrogate is handled by phase-randomizing the MVRV-Z series.
// ----------------------------------------------------------------------------------------------
function mvrvz(P: Panel): GauntletOutput {
  const mvrvL = lag(P.mvrv, LAG);
  // MVRV-Z proxy: standardize MVRV over a trailing window (canonical uses (MC-RC)/std(MC); MVRV is
  // monotone in that; rolling-Z of MVRV is the free, causal standardization).
  function signal(win: number): number[] {
    return rollingZ(mvrvL, win);
  }
  const wins = [365, 730, 1460];
  const buys = [-0.5, 0, 0.5, 1];
  const sells = [1.5, 2, 3];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const w of wins) for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ win: w, buy: b, sell: s, side: sd });
  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const z = sig ?? signal(cfg.win as number);
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) continue;
      if (z[t] <= (cfg.buy as number)) pos[t] = 1;
      else if (z[t] >= (cfg.sell as number)) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-03 MVRV-Z extreme bands (BTC)",
    P,
    configs,
    canonical: { win: 1460, buy: 0, sell: 3, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => {
      const surr = phaseRandomize(rollingZ(mvrvL, cfg.win as number), rng);
      return build(cfg, surr);
    },
    startIdx: 1500, // after the longest z-window warmup
  });
}

// ----------------------------------------------------------------------------------------------
// D5-16 — Active-address / Metcalfe valuation residual. price vs Metcalfe-implied (a*adr^k).
// Fit log(price) ~ a + k*log(adr) on a TRAILING expanding window (frozen, no lookahead); long when
// price is below model (undervalued), short/flat when above. KEY control: causality (does adr lead
// price?) + phase-randomization of the residual.
// ----------------------------------------------------------------------------------------------
function metcalfe(P: Panel): GauntletOutput {
  const adrL = lag(P.adr, LAG);
  const logP = P.price.map((p) => (p > 0 ? Math.log(p) : NaN));
  const logA = adrL.map((a) => (a > 0 ? Math.log(a) : NaN));
  // expanding causal OLS of logP on logA up to t-1, evaluate residual at t
  function residualSeries(minObs: number): number[] {
    const out = new Array(P.price.length).fill(NaN);
    let n = 0,
      sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0;
    for (let t = 0; t < P.price.length; t++) {
      // predict residual at t using params from < t
      if (n >= minObs) {
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) > 1e-9 && Number.isFinite(logA[t]) && Number.isFinite(logP[t])) {
          const beta = (n * sxy - sx * sy) / denom;
          const alpha = (sy - beta * sx) / n;
          const pred = alpha + beta * logA[t];
          out[t] = logP[t] - pred; // >0 overvalued, <0 undervalued
        }
      }
      // then ingest t into the fit for future predictions
      if (Number.isFinite(logA[t]) && Number.isFinite(logP[t])) {
        n++;
        sx += logA[t];
        sy += logP[t];
        sxx += logA[t] * logA[t];
        sxy += logA[t] * logP[t];
      }
    }
    return out;
  }
  const minObs = [365, 730];
  const zwins = [180, 365, 730];
  const buys = [-1, -1.5, -2];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const m of minObs) for (const zw of zwins) for (const b of buys) for (const sd of sides)
    configs.push({ minObs: m, zwin: zw, buy: b, side: sd });
  function build(cfg: Record<string, number | string>, resOverride?: number[]): number[] {
    const res = resOverride ?? residualSeries(cfg.minObs as number);
    const z = rollingZ(res, cfg.zwin as number);
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) continue;
      if (z[t] <= (cfg.buy as number)) pos[t] = 1; // deeply undervalued vs Metcalfe -> buy
      else if (z[t] >= -(cfg.buy as number)) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-16 Metcalfe active-address residual (BTC)",
    P,
    configs,
    canonical: { minObs: 730, zwin: 365, buy: -1.5, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => {
      const res = phaseRandomize(residualSeries(cfg.minObs as number), rng);
      return build(cfg, res);
    },
    startIdx: 1100,
  });
}

// ----------------------------------------------------------------------------------------------
// D5-08 — Exchange reserve-depletion / netflow trend. Net native flow = FlowIn - FlowOut (BTC
// moving ONTO exchanges = bearish supply, OFF = bullish). Use a smoothed netflow-Z; long when
// sustained outflows (reserve depletion), short/flat on inflows. Strict LAG + next-day return =
// no contemporaneous bar (the reverse-causality control). KEY control: detrend-vs-price via the
// phase-randomization surrogate (a falling reserve in a bull market is mechanically price-coupled).
// ----------------------------------------------------------------------------------------------
function reserve(P: Panel): GauntletOutput {
  const fin = lag(P.flowInNtv, LAG);
  const fout = lag(P.flowOutNtv, LAG);
  // net inflow (positive = coins arriving on exchanges = bearish). Normalize by supply for scale.
  const netInflow = P.price.map((_, t) =>
    Number.isFinite(fin[t]) && Number.isFinite(fout[t]) ? fin[t] - fout[t] : NaN,
  );
  function signal(smooth: number, zwin: number): number[] {
    const sm = ema(netInflow, smooth);
    return rollingZ(sm, zwin);
  }
  const smooths = [7, 14, 30];
  const zwins = [90, 180, 365];
  const thr = [0.5, 1, 1.5];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const s of smooths) for (const zw of zwins) for (const th of thr) for (const sd of sides)
    configs.push({ smooth: s, zwin: zw, thr: th, side: sd });
  function build(cfg: Record<string, number | string>, sigOverride?: number[]): number[] {
    const z = sigOverride ?? signal(cfg.smooth as number, cfg.zwin as number);
    const th = cfg.thr as number;
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) continue;
      // strong OUTflow (z <= -th, reserves depleting) -> long; strong INflow (z >= th) -> short/flat
      if (z[t] <= -th) pos[t] = 1;
      else if (z[t] >= th) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-08 Exchange reserve/netflow trend (BTC)",
    P,
    configs,
    canonical: { smooth: 14, zwin: 180, thr: 1, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => {
      const surr = phaseRandomize(signal(cfg.smooth as number, cfg.zwin as number), rng);
      return build(cfg, surr);
    },
    startIdx: 700,
  });
}

// ----------------------------------------------------------------------------------------------
// D5-09 — Puell Multiple. Daily issuance value (USD) / 365d-MA of itself. Issuance reconstructed
// from supply deltas (free SplyCur). Low Puell = miner stress = buy; high = windfall = sell.
// KEY control: Mayer price-only control via phase-randomizing the Puell series (issuance ~ const
// in BTC terms between halvings, so Puell ~ price/365d-MA(price)).
// ----------------------------------------------------------------------------------------------
function puell(P: Panel): GauntletOutput {
  // daily issuance in native = supply[t]-supply[t-1] (free), * price = USD issuance value
  const issNtv = P.supply.map((s, t) =>
    t > 0 && Number.isFinite(s) && Number.isFinite(P.supply[t - 1])
      ? Math.max(0, s - P.supply[t - 1])
      : NaN,
  );
  const issUSD = issNtv.map((v, t) => (Number.isFinite(v) && P.price[t] > 0 ? v * P.price[t] : NaN));
  const issUSDsm = ema(issUSD, 7); // de-noise daily issuance lumpiness
  const ma365 = sma(issUSDsm, 365);
  const puellRaw = issUSDsm.map((v, t) =>
    Number.isFinite(v) && Number.isFinite(ma365[t]) && ma365[t] > 0 ? v / ma365[t] : NaN,
  );
  const puellL = lag(puellRaw, LAG);
  const buys = [0.4, 0.5, 0.6];
  const sells = [2, 3, 4];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ buy: b, sell: s, side: sd });
  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const pu = sig ?? puellL;
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(pu[t])) continue;
      if (pu[t] <= (cfg.buy as number)) pos[t] = 1;
      else if (pu[t] >= (cfg.sell as number)) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-09 Puell Multiple (BTC)",
    P,
    configs,
    canonical: { buy: 0.5, sell: 4, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(puellL, rng)),
    startIdx: 800,
  });
}

// ----------------------------------------------------------------------------------------------
// D5-10 — Hash Ribbons. 30d-MA vs 60d-MA of hash rate; buy on recovery (30 re-crosses above 60)
// with a price-momentum confirm. KEY control: decompose — run hash-only and price-only; phase-
// randomize the hash-rate series to show the crossover fires the same on surrogate hash.
// ----------------------------------------------------------------------------------------------
function hashribbon(P: Panel): GauntletOutput {
  const hr = lag(P.hashRate, LAG);
  function ribbonState(fast: number, slow: number, hser: number[]): number[] {
    const f = sma(hser, fast);
    const s = sma(hser, slow);
    // state +1 when fast>slow (recovered), -1 when fast<slow (capitulation)
    return f.map((v, t) => (Number.isFinite(v) && Number.isFinite(s[t]) ? (v >= s[t] ? 1 : -1) : NaN));
  }
  const pairs = [
    [30, 60],
    [20, 50],
    [10, 30],
  ];
  const priceConfirm = [0, 1]; // require price>SMA(price,window) too
  const holds = [1]; // hold long while recovered
  const sides = ["longflat"]; // hash ribbons is a long-only buy signal
  const configs: Record<string, number | string>[] = [];
  for (const [f, s] of pairs) for (const pc of priceConfirm) for (const h of holds) for (const sd of sides)
    configs.push({ fast: f, slow: s, priceConfirm: pc, hold: h, side: sd });
  const priceSMA200 = sma(P.price, 50);
  function build(cfg: Record<string, number | string>, hserOverride?: number[]): number[] {
    const st = ribbonState(cfg.fast as number, cfg.slow as number, hserOverride ?? hr);
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(st[t])) continue;
      let go = st[t] > 0; // recovered / above
      if (cfg.priceConfirm === 1) go = go && Number.isFinite(priceSMA200[t]) && P.price[t] > priceSMA200[t];
      pos[t] = go ? 1 : 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-10 Hash Ribbons (BTC)",
    P,
    configs,
    canonical: { fast: 30, slow: 60, priceConfirm: 1, hold: 1, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(hr, rng)),
    startIdx: 300,
  });
}

// ----------------------------------------------------------------------------------------------
// D5-13 — Stablecoin Supply Ratio (SSR). SSR = BTC MarketCap / stablecoin total supply. Low SSR =
// dry powder -> bullish. SSR-oscillator = rolling-Z. KEY control: era/regime + denominator-
// isolation handled by phase-randomizing the SSR-Z series.
// ----------------------------------------------------------------------------------------------
function ssr(P: Panel): GauntletOutput {
  const stab = loadStables();
  const stabArr = P.dates.map((d) => stab.get(d) ?? NaN);
  // forward-fill stablecoin supply (DefiLlama is daily but may have gaps)
  for (let t = 1; t < stabArr.length; t++) if (!Number.isFinite(stabArr[t])) stabArr[t] = stabArr[t - 1];
  const ssrRaw = P.marketCap.map((mc, t) =>
    Number.isFinite(mc) && stabArr[t] > 0 ? mc / stabArr[t] : NaN,
  );
  const ssrL = lag(ssrRaw, LAG);
  function signal(zwin: number): number[] {
    return rollingZ(ssrL, zwin);
  }
  const zwins = [90, 180, 365];
  const buys = [-0.5, -1, -1.5];
  const sells = [1, 1.5, 2];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const zw of zwins) for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ zwin: zw, buy: b, sell: s, side: sd });
  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const z = sig ?? signal(cfg.zwin as number);
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) continue;
      if (z[t] <= (cfg.buy as number)) pos[t] = 1; // low SSR -> dry powder -> long
      else if (z[t] >= (cfg.sell as number)) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-13 Stablecoin Supply Ratio (BTC)",
    P,
    configs,
    canonical: { zwin: 180, buy: -1, sell: 1.5, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(signal(cfg.zwin as number), rng)),
    startIdx: 0, // stables start 2017-11; startIdx resolved by warmup inside (first finite z)
  });
}

// ----------------------------------------------------------------------------------------------
// D5-17 — Stock-to-Flow deviation (adversarial / high-value KILL). S2F = stock/annual-flow; model
// price = exp(a + k*ln(S2F)). Fit causally (expanding), long when price below model line. The
// known-debunked claim. KEY control: phase-randomize the deviation; Granger-Newbold spurious-
// regression intuition (S2F is a deterministic clock).
// ----------------------------------------------------------------------------------------------
function s2f(P: Panel): GauntletOutput {
  // S2F = supply / annual flow; annual flow = 365 * daily issuance (native). Use 365d-summed issuance.
  const issNtv = P.supply.map((s, t) =>
    t > 0 && Number.isFinite(s) && Number.isFinite(P.supply[t - 1]) ? Math.max(0, s - P.supply[t - 1]) : NaN,
  );
  const annFlow = sma(issNtv, 365).map((v) => (Number.isFinite(v) ? v * 365 : NaN));
  const s2fRaw = P.supply.map((s, t) =>
    Number.isFinite(s) && annFlow[t] > 0 ? s / annFlow[t] : NaN,
  );
  const lnS2F = s2fRaw.map((v) => (v > 0 ? Math.log(v) : NaN));
  const lnP = P.price.map((p) => (p > 0 ? Math.log(p) : NaN));
  function residualSeries(minObs: number, lnS: number[]): number[] {
    const out = new Array(P.price.length).fill(NaN);
    let n = 0,
      sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0;
    for (let t = 0; t < P.price.length; t++) {
      if (n >= minObs) {
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) > 1e-9 && Number.isFinite(lnS[t]) && Number.isFinite(lnP[t])) {
          const beta = (n * sxy - sx * sy) / denom;
          const alpha = (sy - beta * sx) / n;
          out[t] = lnP[t] - (alpha + beta * lnS[t]); // >0 above S2F line (overvalued)
        }
      }
      if (Number.isFinite(lnS[t]) && Number.isFinite(lnP[t])) {
        n++;
        sx += lnS[t];
        sy += lnP[t];
        sxx += lnS[t] * lnS[t];
        sxy += lnS[t] * lnP[t];
      }
    }
    return out;
  }
  const lnS2FL = lag(lnS2F, LAG);
  const minObs = [365, 730];
  const zwins = [365, 730];
  const buys = [-0.5, -1];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const m of minObs) for (const zw of zwins) for (const b of buys) for (const sd of sides)
    configs.push({ minObs: m, zwin: zw, buy: b, side: sd });
  function build(cfg: Record<string, number | string>, resOverride?: number[]): number[] {
    const res = resOverride ?? residualSeries(cfg.minObs as number, lnS2FL);
    const z = rollingZ(res, cfg.zwin as number);
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) continue;
      if (z[t] <= (cfg.buy as number)) pos[t] = 1; // below S2F line -> "undervalued" -> buy
      else if (z[t] >= -(cfg.buy as number)) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-17 Stock-to-Flow deviation (BTC, adversarial)",
    P,
    configs,
    canonical: { minObs: 730, zwin: 365, buy: -1, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg, phaseRandomize(residualSeries(cfg.minObs as number, lnS2FL), rng)),
    startIdx: 1100,
  });
}

// ----------------------------------------------------------------------------------------------
// D5-05 — Realized price as dynamic support/cost-basis. price/realizedPrice = "MVRV-like" but as a
// level reclaim. Long when price reclaims realized price from below; bands at multiples. KEY
// control: bracket-on-surrogate (the NF1 control) via phase-randomizing the price/realizedPrice.
// ----------------------------------------------------------------------------------------------
function realprice(P: Panel): GauntletOutput {
  const rp = lag(P.realizedPrice, LAG);
  const ratioRaw = P.price.map((p, t) => (p > 0 && rp[t] > 0 ? p / rp[t] : NaN));
  const buys = [0.8, 1.0, 1.2]; // reclaim multiple
  const sells = [2, 2.5, 3];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ buy: b, sell: s, side: sd });
  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const r = sig ?? ratioRaw;
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(r[t])) continue;
      if (r[t] >= (cfg.buy as number) && r[t] < (cfg.sell as number)) pos[t] = 1; // above cost basis, not euphoric
      else if (r[t] >= (cfg.sell as number)) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0; // below cost basis -> bear
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-05 Realized-price cost-basis S/R (BTC)",
    P,
    configs,
    canonical: { buy: 1.0, sell: 3, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(ratioRaw, rng)),
    startIdx: 200,
  });
}

// ----------------------------------------------------------------------------------------------
// runner
// ----------------------------------------------------------------------------------------------
const REGISTRY: Record<string, (P: Panel) => GauntletOutput> = {
  mvrvz,
  metcalfe,
  reserve,
  puell,
  hashribbon,
  ssr,
  s2f,
  realprice,
};

function run(id: string): GauntletOutput {
  const P = loadPanel("btc");
  const o = REGISTRY[id](P);
  printVerdict(o);
  fs.writeFileSync(`${OUT}/result_${id}.json`, JSON.stringify(o, null, 2));
  return o;
}

const arg = process.argv[2] ?? "all";
if (arg === "all") {
  const summary: Record<string, unknown> = {};
  for (const id of Object.keys(REGISTRY)) {
    const o = run(id);
    summary[id] = {
      verdict: o.verdict,
      netSharpe: o.best.netSharpeAnn,
      binding: o.bindingGate,
      honestN: o.honestN,
      surrP: o.surrogateP,
      holdout: o.holdoutSharpeAnn,
    };
  }
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  console.log("\n==== SUMMARY ====");
  console.log(JSON.stringify(summary, null, 2));
} else {
  run(arg);
}
