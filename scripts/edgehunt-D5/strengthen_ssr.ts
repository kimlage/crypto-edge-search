/**
 * D5-13 SSR — strengthening attempt + correct-null diagnosis.
 *
 * GENUINE attempt to extract edge from the Stablecoin Supply Ratio oscillator before judging.
 * SSR = BTC marketCap / total stablecoin circulating supply. Belief: low SSR = dry powder -> bullish.
 *
 * Three strengthening levers over the base run_d5.ts ssr() (which trips `baselines`, net Sh 0.148):
 *   (A) era/regime control — the BACKLOG's KEY control. Stablecoin supply grew structurally
 *       2019->22 then contracted. A rolling-Z over a fixed window already partially detrends, but
 *       the raw SSR also has a deterministic super-cycle. We add a *log-detrended* SSR (subtract an
 *       expanding-causal linear trend in log space) so the oscillator is the true dry-powder cycle,
 *       not the structural regime. If the edge is a one-off regime, detrending should KILL it.
 *   (B) hysteresis/hold — the base config holds only ~19% of the time (deep buy band). We test a
 *       hold-until-exit variant (enter on z<=buy, stay long until z>=exit) to capture more of the
 *       up-move IF the dry-powder signal genuinely leads multi-week rallies.
 *   (C) directional long/short with the detrended oscillator.
 *
 * Honest N = the FULL grid below (every config tried counts). Strict LAG>=1d, next-day return,
 * net-of-cost. Judged by the SAME committed gauntlet (harness.runGauntlet): net-of-cost, baselines
 * (B&H/random-lottery), Deflated Sharpe @ honest N, block-bootstrap, CPCV/PBO, Harvey-Liu haircut,
 * the RIGHT surrogate (phase-randomize SSR-Z, crossSectional:false), consume-once holdout.
 *
 * Also: a clean lead-lag causality check (predictive regression of ret[t+1] on SSR-Z[t]) to expose
 * the reverse-causality artifact (mints follow rallies) flagged in the BACKLOG.
 */
import fs from "node:fs";
import {
  loadPanel,
  loadStables,
  runGauntlet,
  printVerdict,
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

// expanding-causal linear-in-time detrend of a (log) series: residual[t] = y[t] - (a+b*t) fit on <t
function expandingDetrend(y: number[], minObs: number): number[] {
  const out = new Array(y.length).fill(NaN);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < y.length; t++) {
    if (n >= minObs) {
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9 && Number.isFinite(y[t])) {
        const b = (n * sxy - sx * sy) / denom;
        const a = (sy - b * sx) / n;
        out[t] = y[t] - (a + b * t);
      }
    }
    if (Number.isFinite(y[t])) { n++; sx += t; sy += y[t]; sxx += t * t; sxy += t * y[t]; }
  }
  return out;
}

function buildSSR(P: Panel): { ssrL: number[]; ssrDetrendL: number[] } {
  const stab = loadStables();
  const stabArr = P.dates.map((d) => stab.get(d) ?? NaN);
  for (let t = 1; t < stabArr.length; t++) if (!Number.isFinite(stabArr[t])) stabArr[t] = stabArr[t - 1];
  const ssrRaw = P.marketCap.map((mc, t) =>
    Number.isFinite(mc) && stabArr[t] > 0 ? mc / stabArr[t] : NaN,
  );
  const lnSSR = ssrRaw.map((v) => (v > 0 ? Math.log(v) : NaN));
  // era/regime control: remove the deterministic structural trend in log-SSR (causal expanding)
  const lnSSRdet = expandingDetrend(lnSSR, 365);
  return { ssrL: lag(ssrRaw, LAG), ssrDetrendL: lag(lnSSRdet, LAG) };
}

function strengthenedSSR(P: Panel): GauntletOutput {
  const { ssrL, ssrDetrendL } = buildSSR(P);
  // signal: rolling-Z of either the raw SSR or the era-detrended log-SSR
  function signal(zwin: number, detrend: boolean): number[] {
    return rollingZ(detrend ? ssrDetrendL : ssrL, zwin);
  }
  const zwins = [90, 180, 365];
  const buys = [-0.5, -1, -1.5];
  const sells = [1, 1.5, 2];
  const sides = ["longflat", "longshort"];
  const detrends = [false, true]; // era control
  const holds = [false, true]; // hysteresis hold-until-exit
  const configs: Record<string, number | string>[] = [];
  for (const zw of zwins) for (const b of buys) for (const s of sells)
    for (const sd of sides) for (const dt of detrends) for (const h of holds)
      configs.push({ zwin: zw, buy: b, sell: s, side: sd, detrend: dt ? 1 : 0, hold: h ? 1 : 0 });

  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const z = sig ?? signal(cfg.zwin as number, cfg.detrend === 1);
    const buy = cfg.buy as number, sell = cfg.sell as number;
    const longshort = cfg.side === "longshort";
    const hold = cfg.hold === 1;
    const pos = new Array(P.price.length).fill(NaN);
    let cur = 0;
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) { pos[t] = NaN; continue; }
      if (hold) {
        // hysteresis: enter long on z<=buy, exit (to flat/short) on z>=sell, else hold prior state
        if (z[t] <= buy) cur = 1;
        else if (z[t] >= sell) cur = longshort ? -1 : 0;
        pos[t] = cur;
      } else {
        if (z[t] <= buy) pos[t] = 1;
        else if (z[t] >= sell) pos[t] = longshort ? -1 : 0;
        else pos[t] = 0;
      }
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-13 SSR strengthened (era-detrend + hysteresis)",
    P,
    configs,
    canonical: { zwin: 180, buy: -1, sell: 1.5, side: "longflat", detrend: 1, hold: 1 },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg, phaseRandomize(signal(cfg.zwin as number, cfg.detrend === 1), rng)),
    startIdx: 400, // after detrend warmup (365) + z-window
  });
}

// ---- lead-lag causality: does SSR-Z[t] predict ret[t+1], or does it merely lag price? ----
function leadLag(P: Panel): void {
  const { ssrL } = buildSSR(P);
  const z = rollingZ(ssrL, 180);
  const ret = P.fwdRet; // ret[t] = log(price[t+1]/price[t]) -> the NEXT-day return (lead direction)
  const past = P.dates.map((_, t) => (t > 0 ? Math.log(P.price[t] / P.price[t - 1]) : NaN)); // same-day past
  // correlation of z[t] with FUTURE return ret[t] (lead) vs with PAST return past[t] (lag/echo)
  function corr(a: number[], b: number[]): { r: number; n: number } {
    const xs: number[] = [], ys: number[] = [];
    for (let t = 400; t < P.price.length - 1; t++)
      if (Number.isFinite(a[t]) && Number.isFinite(b[t])) { xs.push(a[t]); ys.push(b[t]); }
    const n = xs.length;
    if (n < 30) return { r: 0, n };
    const mx = mean(xs), my = mean(ys), sx = std(xs), sy = std(ys);
    let c = 0;
    for (let i = 0; i < n; i++) c += (xs[i] - mx) * (ys[i] - my);
    return { r: c / ((n - 1) * sx * sy), n };
  }
  const lead = corr(z, ret); // SSR-Z today vs return tomorrow (predictive)
  const echo = corr(z, past); // SSR-Z today vs return today/yesterday (reactive echo)
  // also z vs trailing 30d return (is low-SSR just "price recently fell"?)
  const trail30 = P.dates.map((_, t) =>
    t >= 30 ? Math.log(P.price[t] / P.price[t - 30]) : NaN,
  );
  const echo30 = corr(z, trail30);
  console.log("\n---- lead-lag causality (SSR-Z, win=180) ----");
  console.log(`corr(SSR-Z[t], futureRet[t->t+1])  LEAD = ${lead.r.toFixed(4)}  (n=${lead.n})`);
  console.log(`corr(SSR-Z[t], sameDayRet[t-1->t]) ECHO = ${echo.r.toFixed(4)}  (n=${echo.n})`);
  console.log(`corr(SSR-Z[t], trailing30dRet)     ECHO30 = ${echo30.r.toFixed(4)}  (n=${echo30.n})`);
  console.log(
    `=> SSR-Z is ${Math.abs(echo30.r) > Math.abs(lead.r) * 2 ? "FAR more correlated with PAST price than future" : "comparably lead/lag"} ` +
      `(reverse-causality: low SSR == price recently fell / mints lag rallies)`,
  );
}

const P = loadPanel("btc");
leadLag(P);
const o = strengthenedSSR(P);
printVerdict(o);
fs.writeFileSync(`${OUT}/result_ssr_strengthened.json`, JSON.stringify(o, null, 2));
