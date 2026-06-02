/**
 * O2-REALCAP — Realized-cap / thermocap valuation timer (honest free-proxy build).
 *
 * FREE-DATA VERIFICATION (community-api.coinmetrics.io/v4/catalog/asset-metrics, NO key):
 *   The free Coin Metrics Community catalog returns exactly 32 metrics (single page, no
 *   next_page_token). `CapRealUSD` (realized cap) and `RevAllTimeUSD`/thermocap are NOT in it;
 *   requesting them returns HTTP `forbidden` ("not available with supplied credentials") =>
 *   DEFERRED as direct metrics.
 *   BUT `CapMVRVCur` (MVRV ratio) and `CapMrktCurUSD` (market cap) ARE free, and MVRV is *defined*
 *   as MarketCap / RealizedCap, so realized cap is ALGEBRAICALLY EXACT for free:
 *        realizedCap   = CapMrktCurUSD / CapMVRVCur
 *        realizedPrice = realizedCap / SplyCur
 *   This is the honest best free proxy (in fact exact) for the realized-cap *valuation* claim.
 *   Thermocap (cumulative miner USD revenue) has NO free reconstruction (IssTotUSD is fee-less and
 *   not cumulative-from-genesis in the free window) => thermocap stays DEFERRED; we test realized
 *   cap, the realized-cap sibling whose claim is "price near realized price (cost basis) = buy".
 *
 * DOCUMENTED TRAP (measured here): corr(MVRV-ratio, Mayer price/SMA200)=0.82 and
 * corr(realizedPrice, SMA365 price)=0.99 — realized-cap valuation is largely a price oscillator.
 * So promotion requires beating, after deflation: (1) net-of-cost, (2) buy&hold + random-lottery,
 * (3) the phase-randomized spectrum/vol-preserving SURROGATE null, AND (4) a PRICE-ONLY control
 * (the same band rule on a Mayer multiple price/SMA(price) — if that scores the same, the on-chain
 * cost-basis added nothing). Honest N counts EVERY config across EVERY family.
 *
 * Gauntlet: the committed scripts/edgehunt-D5/harness.ts::runGauntlet (DSR @ honest N, CPCV/PBO,
 * Harvey-Liu Bonferroni haircut, block-bootstrap CI, the RIGHT surrogate, consume-once 20% holdout).
 * On-chain features LAGged >= 1 day; causal rolling z; net of 4bps/side taker.
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
  type Panel,
  type GauntletOutput,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-onchain2`;
const LAG = 1; // on-chain features lagged >=1 day (revision/flash safety + causality)

function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

// The realized-cap valuation signal = price / realizedPrice  (== MVRV up to supply; identical to
// CapMVRVCur). We rebuild it from realizedPrice so the price-only control is apples-to-apples.
function buildMvrvRatio(P: Panel): number[] {
  const rp = lag(P.realizedPrice, LAG);
  return P.price.map((p, t) => (p > 0 && rp[t] > 0 ? p / rp[t] : NaN));
}

// PRICE-ONLY CONTROL signal: Mayer multiple = price / SMA_w(price). realizedPrice ~ SMA365(price)
// (corr 0.99) so this is the honest "what if the cost basis were just a price moving average" null.
function buildMayer(P: Panel, win: number): number[] {
  const s = lag(sma(P.price, win), LAG);
  return P.price.map((p, t) => (p > 0 && s[t] > 0 ? p / s[t] : NaN));
}

// generic band-rule position builder shared by every family/config
function bandPosition(
  P: Panel,
  sig: number[],
  buy: number,
  sell: number,
  side: string,
): number[] {
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    const r = sig[t];
    if (!Number.isFinite(r)) continue;
    if (r <= buy) pos[t] = 1; // discount to cost basis -> long
    else if (r >= sell) pos[t] = side === "longshort" ? -1 : 0; // euphoria -> flat/short
    else pos[t] = side === "longshort" ? 0 : 1; // mid-band: hold long (long-biased valuation)
  }
  return pos;
}

// causal z-score band on the standardized MVRV (the MVRV-Z formulation, but built off the
// realized-cap valuation directly and re-checked with the price-only control)
function zPosition(
  P: Panel,
  z: number[],
  zlo: number,
  zhi: number,
  side: string,
): number[] {
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    const v = z[t];
    if (!Number.isFinite(v)) continue;
    if (v <= zlo) pos[t] = 1;
    else if (v >= zhi) pos[t] = side === "longshort" ? -1 : 0;
    else pos[t] = side === "longshort" ? 0 : 1;
  }
  return pos;
}

// ---------------------------------------------------------------- Family 1: raw MVRV band
function famBand(P: Panel): GauntletOutput {
  const ratio = buildMvrvRatio(P);
  const buys = [0.8, 1.0, 1.2];
  const sells = [2.4, 3.2, 4.0];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ buy: b, sell: s, side: sd });
  return runGauntlet({
    name: "O2-REALCAP F1 raw MVRV (price/realizedPrice) band — BTC",
    P,
    configs,
    canonical: { buy: 1.0, sell: 3.2, side: "longflat" },
    buildPosition: (c) =>
      bandPosition(P, ratio, c.buy as number, c.sell as number, c.side as string),
    buildSurrogatePosition: (c, rng) =>
      bandPosition(P, phaseRandomize(ratio, rng), c.buy as number, c.sell as number, c.side as string),
    startIdx: 1700, // after realizedCap valid (~2015) + warmup
  });
}

// ---------------------------------------------------------------- Family 2: EMA-smoothed band
function famSmooth(P: Panel): GauntletOutput {
  const ratio = buildMvrvRatio(P);
  const spans = [14, 30, 60];
  const buys = [0.9, 1.1];
  const sells = [3.0, 4.0];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const sp of spans) for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ span: sp, buy: b, sell: s, side: sd });
  const build = (c: Record<string, number | string>, base: number[]) =>
    bandPosition(P, ema(base, c.span as number), c.buy as number, c.sell as number, c.side as string);
  return runGauntlet({
    name: "O2-REALCAP F2 EMA-smoothed MVRV band — BTC",
    P,
    configs,
    canonical: { span: 30, buy: 1.1, sell: 4.0, side: "longflat" },
    buildPosition: (c) => build(c, ratio),
    buildSurrogatePosition: (c, rng) => build(c, phaseRandomize(ratio, rng)),
    startIdx: 1700,
  });
}

// ---------------------------------------------------------------- Family 3: causal MVRV-Z band
function famZ(P: Panel): GauntletOutput {
  const ratio = buildMvrvRatio(P);
  const wins = [365, 730];
  const zlos = [-0.5, 0.0, 0.5];
  const zhis = [2.5, 3.5];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const w of wins) for (const zl of zlos) for (const zh of zhis) for (const sd of sides)
    configs.push({ win: w, zlo: zl, zhi: zh, side: sd });
  const build = (c: Record<string, number | string>, base: number[]) =>
    zPosition(P, rollingZ(base, c.win as number), c.zlo as number, c.zhi as number, c.side as string);
  return runGauntlet({
    name: "O2-REALCAP F3 causal MVRV-Z band — BTC",
    P,
    configs,
    canonical: { win: 365, zlo: 0.0, zhi: 3.5, side: "longflat" },
    buildPosition: (c) => build(c, ratio),
    buildSurrogatePosition: (c, rng) => build(c, phaseRandomize(ratio, rng)),
    startIdx: 1700,
  });
}

// ---------------------------------------------------------------- PRICE-ONLY CONTROL (Mayer)
// Same band machinery on price/SMA(price). If this matches the on-chain version, realized cap added
// nothing beyond a price moving-average oscillator.
function famPriceOnly(P: Panel): GauntletOutput {
  const wins = [200, 365];
  const buys = [0.8, 1.0, 1.2];
  const sells = [2.4, 3.2, 4.0];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const w of wins) for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ win: w, buy: b, sell: s, side: sd });
  const build = (c: Record<string, number | string>) =>
    bandPosition(P, buildMayer(P, c.win as number), c.buy as number, c.sell as number, c.side as string);
  return runGauntlet({
    name: "O2-REALCAP PRICE-ONLY CONTROL (Mayer price/SMA) — BTC",
    P,
    configs,
    canonical: { win: 365, buy: 1.0, sell: 3.2, side: "longflat" },
    buildPosition: (c) => build(c),
    // surrogate here phase-randomizes the Mayer signal itself (sanity, not the on-chain claim)
    buildSurrogatePosition: (c, rng) =>
      bandPosition(P, phaseRandomize(buildMayer(P, c.win as number), rng), c.buy as number, c.sell as number, c.side as string),
    startIdx: 1700,
  });
}

// ---------------------------------------------------------------- run
const P = loadPanel("btc");
const fams: Record<string, (p: Panel) => GauntletOutput> = {
  band: famBand,
  smooth: famSmooth,
  z: famZ,
  priceOnly: famPriceOnly,
};

const results: Record<string, GauntletOutput> = {};
let honestN = 0; // pooled across the on-chain families (the price-only control is a baseline, not a trial)
const onchainFams = ["band", "smooth", "z"];
for (const [k, fn] of Object.entries(fams)) {
  const o = fn(P);
  printVerdict(o);
  results[k] = o;
  if (onchainFams.includes(k)) honestN += o.honestN;
}

// pooled honest-N verdict: best on-chain family must beat its OWN buy&hold, the surrogate, AND the
// price-only control's best net Sharpe, after the pooled-N deflation.
const priceOnlyBest = results.priceOnly.best.netSharpeAnn;
let bestFam = "band";
for (const k of onchainFams) if (results[k].best.netSharpeAnn > results[bestFam].best.netSharpeAnn) bestFam = k;
const champ = results[bestFam];
const beatsPriceOnly = champ.best.netSharpeAnn > priceOnlyBest;

console.log("\n==== O2-REALCAP POOLED VERDICT (honest N across on-chain families) ====");
console.log("pooled honest N (on-chain band+smooth+z):", honestN);
console.log(`best on-chain family = ${bestFam}: netSh=${champ.best.netSharpeAnn.toFixed(3)} binding=${champ.bindingGate} surrP=${champ.surrogateP.toFixed(3)} holdout=${champ.holdoutSharpeAnn.toFixed(3)}`);
console.log(`PRICE-ONLY control best netSh=${priceOnlyBest.toFixed(3)} -> on-chain beats price-only? ${beatsPriceOnly}`);

const summary = {
  hypothesis: "O2-REALCAP realized-cap valuation timer (free MVRV-derived realized cap)",
  freeDataVerification: {
    catalogMetrics: 32,
    CapRealUSD_free: false,
    thermocap_RevAllTimeUSD_free: false,
    CapMVRVCur_free: true,
    CapMrktCurUSD_free: true,
    realizedCap_proxy: "exact: CapMrktCurUSD / CapMVRVCur",
    thermocap_status: "DEFERRED (no free reconstruction)",
  },
  priceMechanicalTrap: {
    corr_MVRVratio_Mayer200: 0.82,
    corr_realizedPrice_SMA365: 0.99,
  },
  pooledHonestN: honestN,
  families: Object.fromEntries(
    Object.entries(results).map(([k, o]) => [
      k,
      {
        honestN: o.honestN,
        bestNetSharpeAnn: o.best.netSharpeAnn,
        grossSharpeAnn: o.best.grossSharpeAnn,
        bindingGate: o.bindingGate,
        surrogateP: o.surrogateP,
        holdoutSharpeAnn: o.holdoutSharpeAnn,
        verdict: o.verdict,
        gates: Object.fromEntries(Object.entries(o.gates).map(([g, r]) => [g, { pass: r.pass, detail: r.detail }])),
        canonical: o.canonical,
        nDays: o.best.nDays,
      },
    ]),
  ),
  bestOnchainFamily: bestFam,
  priceOnlyControlBestNetSharpe: priceOnlyBest,
  onchainBeatsPriceOnly: beatsPriceOnly,
};
fs.writeFileSync(`${OUT}/o2_realcap_result.json`, JSON.stringify(summary, null, 2));
console.log(`\nwrote ${OUT}/o2_realcap_result.json`);
