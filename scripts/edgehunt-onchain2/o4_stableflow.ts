/**
 * O4-STABLEFLOW — Stablecoin supply growth as a lagged dry-powder flow.
 *
 * BACKLOG refs: D5-13 (SSR level, already KILL), D5-14 (net mint/burn impulse), D7.18 (mint-as-event).
 * Belief: rising stablecoin supply = fiat on-ramp / dry powder entering -> bullish for BTC the NEXT
 * period. The documented trap is REVERSE CAUSALITY: mints/redemptions follow price (issuance ramps
 * after rallies, redemptions after drawdowns), so naive "supply growth -> long" is a price echo.
 *
 * STRONGEST HONEST VERSION:
 *   - Metric: FREE DefiLlama total stablecoin circulating supply (output/edgehunt-D5/stablecoins_total.json,
 *     no key). Verified free. (CM Community does not expose per-issuer stable supply without pro.)
 *   - Signal: smoothed log-growth of total supply over window gw, LAGGED >=1d (revision-safe),
 *     WINSORIZED (the 2018 backfill era has discrete-mint artifacts -> tradable window starts 2019).
 *   - Coincident-demand / reverse-causality CONTROL (the binding null per BACKLOG): for orth=1 configs
 *     we orthogonalize the growth signal against trailing BTC return (expanding causal regression) and
 *     trade only the RESIDUAL "mint surprise" -- the part of supply growth NOT explained by recent
 *     price. If the edge is a price echo, the residual edge collapses.
 *   - Direction: dry-powder belief => HIGH growth -> long. We also allow long/short and a contrarian
 *     leg in the grid so the search is honest about which sign actually works (and is penalized by N).
 *
 * GAUNTLET: committed harness.runGauntlet (net-of-cost @4bps/side, baselines B&H/random-lottery,
 * Deflated Sharpe @ HONEST N = full grid, block-bootstrap, CPCV/PBO, Harvey-Liu Bonferroni haircut,
 * consume-once 20% forward holdout).
 *
 * THE RIGHT NULL: two surrogates, we report the STRICTER (max p):
 *   (a) phase-randomization of the growth feature (AR / power-spectrum / vol preserved, timing
 *       destroyed) -> wired into the harness `surrogate` gate. This is the AR-matched null.
 *   (b) reverse-causality placebo: rebuild the SAME position rule on a "fake growth" series that is a
 *       phase-randomized copy of the trailing-BTC-return predictor at matched autocorrelation. If the
 *       real signal cannot beat a price-echo of matched spectrum, it is reverse causality.
 * Both AR-matched. We additionally print a Granger-style lead/lag table (growth vs FUTURE vs PAST ret).
 */
import fs from "node:fs";
import {
  loadPanel,
  loadStables,
  runGauntlet,
  printVerdict,
  rollingZ,
  runPositions,
  sharpeDaily,
  annSharpe,
  mean,
  std,
  mkRng,
  type Panel,
  type GauntletOutput,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-onchain2`;
const LAG = 1;

function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

// winsorize finite values to +/- c MADs around the median (robust to discrete-mint spikes)
function winsorize(x: number[], c: number): number[] {
  const v = x.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length < 10) return x.slice();
  const med = v[Math.floor(v.length / 2)];
  const absdev = v.map((y) => Math.abs(y - med)).sort((a, b) => a - b);
  const mad = absdev[Math.floor(absdev.length / 2)] || 1e-9;
  const lo = med - c * 1.4826 * mad;
  const hi = med + c * 1.4826 * mad;
  return x.map((y) => (Number.isFinite(y) ? Math.min(hi, Math.max(lo, y)) : y));
}

// expanding-causal OLS residual of y on regressor r (intercept+slope fit on data strictly < t)
function expandingResidual(y: number[], r: number[], minObs: number): number[] {
  const out = new Array(y.length).fill(NaN);
  let n = 0, sr = 0, sy = 0, srr = 0, sry = 0;
  for (let t = 0; t < y.length; t++) {
    if (n >= minObs && Number.isFinite(y[t]) && Number.isFinite(r[t])) {
      const denom = n * srr - sr * sr;
      if (Math.abs(denom) > 1e-12) {
        const b = (n * sry - sr * sy) / denom;
        const a = (sy - b * sr) / n;
        out[t] = y[t] - (a + b * r[t]);
      }
    }
    if (Number.isFinite(y[t]) && Number.isFinite(r[t])) {
      n++; sr += r[t]; sy += y[t]; srr += r[t] * r[t]; sry += r[t] * y[t];
    }
  }
  return out;
}

// build the stablecoin total-supply series aligned to panel dates, forward-filled, then log-growth
function buildGrowthFeatures(P: Panel): {
  growthByGw: Map<number, number[]>; // raw smoothed log-growth (winsorized), LAGGED
  residGrowthByGw: Map<number, number[]>; // orthogonalized vs trailing 30d BTC ret, LAGGED
  trailRet: number[]; // trailing 30d BTC log return (the coincident-demand regressor), aligned, LAGGED
} {
  const stab = loadStables();
  const T = P.dates.length;
  const supply = P.dates.map((d) => stab.get(d) ?? NaN);
  for (let t = 1; t < T; t++) if (!Number.isFinite(supply[t])) supply[t] = supply[t - 1];
  const lnS = supply.map((v) => (v > 0 ? Math.log(v) : NaN));

  // trailing 30d BTC log return (coincident demand / reverse-causality regressor)
  const trail = new Array(T).fill(NaN);
  for (let t = 30; t < T; t++) if (P.price[t] > 0 && P.price[t - 30] > 0) trail[t] = Math.log(P.price[t] / P.price[t - 30]);

  const gws = [7, 14, 30, 60, 90];
  const growthByGw = new Map<number, number[]>();
  const residGrowthByGw = new Map<number, number[]>();
  for (const gw of gws) {
    const g = new Array(T).fill(NaN);
    for (let t = gw; t < T; t++) if (Number.isFinite(lnS[t]) && Number.isFinite(lnS[t - gw])) g[t] = lnS[t] - lnS[t - gw];
    const gw_w = winsorize(g, 5); // kill discrete-mint spikes
    // residual vs trailing return (same-bar trailing ret -> coincident demand; expanding causal fit)
    const resid = expandingResidual(gw_w, trail, 200);
    growthByGw.set(gw, lag(gw_w, LAG));
    residGrowthByGw.set(gw, lag(resid, LAG));
  }
  return { growthByGw, residGrowthByGw, trailRet: lag(trail, LAG) };
}

function strategy(P: Panel): { out: GauntletOutput; startIdx: number; feats: ReturnType<typeof buildGrowthFeatures> } {
  const feats = buildGrowthFeatures(P);
  const T = P.dates.length;
  // tradable window starts 2019 (post 2018 backfill artifacts) + warmup for z + orth (200) + gw(90)
  const i2019 = P.dates.findIndex((d) => d >= "2019-01-01");
  const startIdx = Math.max(i2019, 350);

  function rawSignal(gw: number, orth: boolean): number[] {
    return orth ? feats.residGrowthByGw.get(gw)! : feats.growthByGw.get(gw)!;
  }
  function signal(gw: number, orth: boolean, zwin: number): number[] {
    return rollingZ(rawSignal(gw, orth), zwin);
  }

  const gws = [7, 14, 30, 60, 90];
  const zwins = [90, 180, 365];
  const ths = [0.5, 1.0, 1.5];
  const dirs = ["dryPowder", "longshort", "contrarian"]; // dryPowder = high growth long (the belief)
  const orths = [false, true]; // coincident-demand control
  const configs: Record<string, number | string>[] = [];
  for (const gw of gws) for (const zw of zwins) for (const th of ths) for (const dir of dirs) for (const o of orths)
    configs.push({ gw, zwin: zw, th, dir, orth: o ? 1 : 0 });

  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const z = sig ?? signal(cfg.gw as number, cfg.orth === 1, cfg.zwin as number);
    const th = cfg.th as number;
    const dir = cfg.dir as string;
    const pos = new Array(T).fill(NaN);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(z[t])) { pos[t] = NaN; continue; }
      if (dir === "dryPowder") {
        // high growth (z>=+th) = dry powder -> long; else flat
        pos[t] = z[t] >= th ? 1 : 0;
      } else if (dir === "longshort") {
        pos[t] = z[t] >= th ? 1 : z[t] <= -th ? -1 : 0;
      } else {
        // contrarian: low growth -> long (supply contraction often near bottoms)
        pos[t] = z[t] <= -th ? 1 : 0;
      }
    }
    return pos;
  }

  const out = runGauntlet({
    name: "O4-STABLEFLOW stablecoin supply growth (dry-powder flow)",
    P,
    configs,
    canonical: { gw: 30, zwin: 180, th: 1.0, dir: "dryPowder", orth: 1 }, // pre-registered: orthogonalized dry-powder
    buildPosition: (cfg) => build(cfg),
    // RIGHT surrogate (a): phase-randomize the growth feature (AR/spectrum/vol preserved, timing destroyed)
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg, rollingZ(phaseRandomize(rawSignal(cfg.gw as number, cfg.orth === 1), rng), cfg.zwin as number)),
    startIdx,
    nSurr: 400,
  });
  return { out, startIdx, feats };
}

// ---- reverse-causality placebo (b): can a price-echo of matched spectrum reproduce the edge? ----
function reverseCausalityNull(
  P: Panel,
  feats: ReturnType<typeof buildGrowthFeatures>,
  best: GauntletOutput["best"],
  startIdx: number,
  nSurr = 400,
): { p: number; realSh: number; echoMeanSh: number; echo95: number } {
  // The reverse-causality predictor is the trailing-BTC-return (mints lag price). We phase-randomize
  // THAT (matched autocorr) and rebuild the SAME best position rule on it. If the real signal can't
  // out-Sharpe a spectrum-matched price echo, the "edge" is reverse causality.
  const T = P.dates.length;
  const cfg = best.cfg;
  const gw = cfg.gw as number, zwin = cfg.zwin as number, th = cfg.th as number, dir = cfg.dir as string;
  function buildPos(z: number[]): number[] {
    const pos = new Array(T).fill(NaN);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(z[t])) { pos[t] = NaN; continue; }
      if (dir === "dryPowder") pos[t] = z[t] >= th ? 1 : 0;
      else if (dir === "longshort") pos[t] = z[t] >= th ? 1 : z[t] <= -th ? -1 : 0;
      else pos[t] = z[t] <= -th ? 1 : 0;
    }
    return pos;
  }
  const realRaw = (cfg.orth === 1 ? feats.residGrowthByGw : feats.growthByGw).get(gw)!;
  const realRes = runPositions(P, buildPos(rollingZ(realRaw, zwin)), startIdx, T - 1);
  const realSh = annSharpe(sharpeDaily(realRes.dailyNet));
  // base price-echo series = trailing return (already lagged inside feats)
  const echo: number[] = [];
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(31337 + i * 2654435761);
    const fake = phaseRandomize(feats.trailRet, rng);
    const r = runPositions(P, buildPos(rollingZ(fake, zwin)), startIdx, T - 1);
    echo.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  echo.sort((a, b) => a - b);
  const p = (echo.filter((s) => s >= realSh).length + 1) / (nSurr + 1);
  return { p, realSh, echoMeanSh: mean(echo), echo95: echo[Math.floor(nSurr * 0.95)] };
}

// ---- lead/lag causality diagnostic ----
function leadLag(P: Panel, feats: ReturnType<typeof buildGrowthFeatures>, startIdx: number): Record<string, number> {
  const g = feats.growthByGw.get(30)!; // 30d growth, lagged
  const z = rollingZ(g, 180);
  const T = P.dates.length;
  const futureRet = P.fwdRet; // next-day return (lead)
  const pastRet = P.dates.map((_, t) => (t > 0 && P.price[t] > 0 && P.price[t - 1] > 0 ? Math.log(P.price[t] / P.price[t - 1]) : NaN));
  const trail30Fwd = P.dates.map((_, t) => (t + 30 < T && P.price[t] > 0 && P.price[t + 30] > 0 ? Math.log(P.price[t + 30] / P.price[t]) : NaN));
  function corr(a: number[], b: number[]): { r: number; n: number } {
    const xs: number[] = [], ys: number[] = [];
    for (let t = startIdx; t < T - 1; t++) if (Number.isFinite(a[t]) && Number.isFinite(b[t])) { xs.push(a[t]); ys.push(b[t]); }
    const n = xs.length; if (n < 30) return { r: 0, n };
    const mx = mean(xs), my = mean(ys), sx = std(xs), sy = std(ys);
    let c = 0; for (let i = 0; i < n; i++) c += (xs[i] - mx) * (ys[i] - my);
    return { r: c / ((n - 1) * sx * sy), n };
  }
  const lead = corr(z, futureRet);
  const lead30 = corr(z, trail30Fwd);
  const echo = corr(z, P.dates.map((_, t) => feats.trailRet[t])); // growth-z vs trailing-30d ret (lagged)
  return {
    corr_growthZ_nextDayRet_LEAD: +lead.r.toFixed(4),
    corr_growthZ_fwd30dRet_LEAD: +lead30.r.toFixed(4),
    corr_growthZ_trailing30dRet_ECHO: +echo.r.toFixed(4),
    n_lead: lead.n,
  };
}

const P = loadPanel("btc");
const { out, startIdx, feats } = strategy(P);
const rc = reverseCausalityNull(P, feats, out.best, startIdx);
const ll = leadLag(P, feats, startIdx);

printVerdict(out);
console.log("\n---- reverse-causality / coincident-demand placebo (price-echo of matched spectrum) ----");
console.log(`real bestSh(full)=${rc.realSh.toFixed(3)}  echoMeanSh=${rc.echoMeanSh.toFixed(3)}  echo95=${rc.echo95.toFixed(3)}  REVERSE-CAUSALITY p=${rc.p.toFixed(4)}`);
console.log("\n---- lead/lag causality (30d growth-Z) ----");
console.log(JSON.stringify(ll, null, 2));

// The BINDING surrogate p we report = max(harness phase-rand p, reverse-causality p): both must pass.
const bindingSurrP = Math.max(out.surrogateP, rc.p);
const report = {
  hypothesis: "O4-STABLEFLOW",
  metric_free: true,
  source: "DefiLlama total stablecoin supply (free, no key) — output/edgehunt-D5/stablecoins_total.json",
  tradable_start: P.dates[startIdx],
  tradable_end: P.dates[P.dates.length - 2],
  honestN: out.honestN,
  best: out.best,
  canonical: out.canonical,
  gates: out.gates,
  harness_bindingGate: out.bindingGate,
  harness_verdict: out.verdict,
  phaseRand_surrogateP: out.surrogateP,
  reverseCausality: rc,
  binding_surrogateP: bindingSurrP,
  leadLag: ll,
  holdoutSharpeAnn: out.holdoutSharpeAnn,
};
fs.writeFileSync(`${OUT}/o4_stableflow_result.json`, JSON.stringify(report, null, 2));

// Final adjudication that folds in the reverse-causality null as a hard gate.
const corePass =
  out.gates.net_of_cost.pass && out.gates.baselines.pass && out.gates.holdout.pass && bindingSurrP < 0.05;
let finalVerdict: string;
if (out.bindingGate === "none" && bindingSurrP < 0.05) finalVerdict = "SURVIVE";
else if (corePass) finalVerdict = "PROMISING";
else finalVerdict = "KILL";
let binding = out.bindingGate;
if (out.bindingGate === "none" && bindingSurrP >= 0.05) binding = "reverse_causality";
if (rc.p >= 0.05 && out.surrogateP < 0.05 && (out.bindingGate === "surrogate" || out.bindingGate === "none")) binding = "reverse_causality";
console.log(`\nFINAL: verdict=${finalVerdict} bindingSurrP=${bindingSurrP.toFixed(4)} binding=${binding}`);
fs.writeFileSync(`${OUT}/o4_stableflow_final.json`, JSON.stringify({ finalVerdict, binding, bindingSurrP, best: out.best, leadLag: ll, reverseCausality: rc }, null, 2));
