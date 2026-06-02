/**
 * O2-REALCAP strengthening — the strongest HONEST attempt to find residual on-chain timing after
 * stripping the long-beta that made the base families pure buy&hold.
 *
 * Two beta-orthogonal formulations:
 *   S1. RESIDUAL-MVRV timing: regress (causally, expanding) the MVRV ratio on the Mayer multiple
 *       (price/SMA365) and trade ONLY the residual = the part of realized-cap valuation NOT
 *       explained by a price moving average. If realized cap has independent content, the residual
 *       band should still time. Long when residual<lo (cheaper-than-price-implies), flat/short when
 *       residual>hi. This removes the always-long beta by construction.
 *   S2. MEAN-REVERT on standardized residual with explicit market-neutral overlay: position = sign
 *       of -z(residual) so it is balanced long/short (no structural long bias), the only way a
 *       valuation signal earns is genuine mean reversion of the *residual*, not the asset's drift.
 *
 * Same committed gauntlet + RIGHT surrogate (phase-randomize the residual, rebuild on real price).
 * If even the beta-neutral residual fails baselines/surrogate, realized-cap valuation has no
 * timing content beyond price — the KILL is confirmed at the strongest honest setting.
 */
import fs from "node:fs";
import {
  loadPanel,
  runGauntlet,
  printVerdict,
  sma,
  mean,
  std,
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

function mvrvRatio(P: Panel): number[] {
  const rp = lag(P.realizedPrice, LAG);
  return P.price.map((p, t) => (p > 0 && rp[t] > 0 ? p / rp[t] : NaN));
}
function mayer(P: Panel, win: number): number[] {
  const s = lag(sma(P.price, win), LAG);
  return P.price.map((p, t) => (p > 0 && s[t] > 0 ? p / s[t] : NaN));
}

// CAUSAL expanding-window residual of `y` regressed on `x` (slope+intercept up to t-1 only).
function causalResidual(y: number[], x: number[]): number[] {
  const out = new Array(y.length).fill(NaN);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < y.length; t++) {
    // predict using stats from < t
    if (n >= 60) {
      const mx = sx / n, my = sy / n;
      const cov = sxy / n - mx * my;
      const vx = sxx / n - mx * mx;
      const beta = vx > 1e-12 ? cov / vx : 0;
      const alpha = my - beta * mx;
      if (Number.isFinite(y[t]) && Number.isFinite(x[t])) out[t] = y[t] - (alpha + beta * x[t]);
    }
    // then incorporate t
    if (Number.isFinite(y[t]) && Number.isFinite(x[t])) {
      n++; sx += x[t]; sy += y[t]; sxx += x[t] * x[t]; sxy += x[t] * y[t];
    }
  }
  return out;
}

// causal rolling z of a series (so residual bands are stationary-ish)
function rollZ(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  const buf: number[] = [];
  for (let t = 0; t < x.length; t++) {
    if (Number.isFinite(x[t])) buf.push(x[t]);
    if (buf.length > win) buf.shift();
    if (buf.length >= Math.min(60, win) && Number.isFinite(x[t])) {
      const m = mean(buf), s = std(buf);
      out[t] = s > 1e-9 ? (x[t] - m) / s : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- S1: residual band long/flat+short
function residualBand(P: Panel): GauntletOutput {
  const ratio = mvrvRatio(P);
  const pctrl = mayer(P, 365);
  const resid = causalResidual(ratio, pctrl);
  const zwins = [365, 730];
  const zlos = [-1.0, -0.5];
  const zhis = [0.5, 1.0];
  const sides = ["longshort", "longflat"];
  const configs: Record<string, number | string>[] = [];
  for (const w of zwins) for (const zl of zlos) for (const zh of zhis) for (const sd of sides)
    configs.push({ zwin: w, zlo: zl, zhi: zh, side: sd });
  const build = (c: Record<string, number | string>, base: number[]) => {
    const z = rollZ(base, c.zwin as number);
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) continue;
      if (z[t] <= (c.zlo as number)) pos[t] = 1; // cheaper than price implies -> long
      else if (z[t] >= (c.zhi as number)) pos[t] = c.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  };
  return runGauntlet({
    name: "O2-REALCAP S1 beta-neutral RESIDUAL-MVRV band — BTC",
    P,
    configs,
    canonical: { zwin: 365, zlo: -0.5, zhi: 0.5, side: "longshort" },
    buildPosition: (c) => build(c, resid),
    buildSurrogatePosition: (c, rng) => build(c, phaseRandomize(resid, rng)),
    startIdx: 1800,
  });
}

// ---------------------------------------------------------------- S2: market-neutral mean-revert
function residualMeanRevert(P: Panel): GauntletOutput {
  const ratio = mvrvRatio(P);
  const pctrl = mayer(P, 365);
  const resid = causalResidual(ratio, pctrl);
  const zwins = [180, 365, 730];
  const gains = [0.5, 1.0]; // position cap
  const configs: Record<string, number | string>[] = [];
  for (const w of zwins) for (const g of gains) configs.push({ zwin: w, gain: g });
  const build = (c: Record<string, number | string>, base: number[]) => {
    const z = rollZ(base, c.zwin as number);
    const g = c.gain as number;
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(z[t])) continue;
      // mean-revert: cheap residual -> long, rich -> short, clipped to +-1, scaled by gain
      pos[t] = Math.max(-1, Math.min(1, -g * z[t]));
    }
    return pos;
  };
  return runGauntlet({
    name: "O2-REALCAP S2 market-neutral residual mean-revert — BTC",
    P,
    configs,
    canonical: { zwin: 365, gain: 1.0 },
    buildPosition: (c) => build(c, resid),
    buildSurrogatePosition: (c, rng) => build(c, phaseRandomize(resid, rng)),
    startIdx: 1800,
  });
}

const P = loadPanel("btc");
const results: Record<string, GauntletOutput> = {};
let honestN = 0;
for (const [k, fn] of Object.entries({ residualBand, residualMeanRevert })) {
  const o = fn(P);
  printVerdict(o);
  results[k] = o;
  honestN += o.honestN;
}
console.log("\n==== O2-REALCAP STRENGTHEN (beta-neutral residual) pooled honest N:", honestN, "====");
const anyPromising = Object.values(results).some(
  (o) => o.verdict === "PROMISING" || o.verdict === "SURVIVE",
);
console.log("any beta-neutral residual family PROMISING/SURVIVE?", anyPromising);

fs.writeFileSync(
  `${OUT}/o2_realcap_strengthen.json`,
  JSON.stringify(
    {
      hypothesis: "O2-REALCAP beta-neutral residual timing (realized cap minus price MA)",
      pooledHonestN: honestN,
      families: Object.fromEntries(
        Object.entries(results).map(([k, o]) => [
          k,
          {
            honestN: o.honestN,
            bestNetSharpeAnn: o.best.netSharpeAnn,
            bindingGate: o.bindingGate,
            surrogateP: o.surrogateP,
            holdoutSharpeAnn: o.holdoutSharpeAnn,
            verdict: o.verdict,
            longShare: o.best.longShare,
            exposure: o.best.exposure,
            gates: Object.fromEntries(Object.entries(o.gates).map(([g, r]) => [g, r.pass])),
          },
        ]),
      ),
      anyPromising,
    },
    null,
    2,
  ),
);
console.log(`wrote ${OUT}/o2_realcap_strengthen.json`);
