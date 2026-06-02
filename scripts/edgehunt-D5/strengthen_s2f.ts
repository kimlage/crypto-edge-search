/**
 * D5-17 — GENUINE strengthening attempt for the Stock-to-Flow deviation strategy.
 *
 * The committed grid (N=16) KILLs on the `baselines` gate (0.579 vs B&H 0.765) and the residual's
 * timing is reproduced by phase-randomized surrogates (placeboP=0.399). Before accepting the KILL,
 * we honestly try to find an edge the canonical grid missed:
 *
 *   (A) Diagnostic: what IS the S2F residual? Correlate it with a pure price clock (ln price minus
 *       its own expanding trend) and with trailing price momentum. If the residual ≈ a price-trend
 *       transform, the "valuation" story is the Granger-Newbold spurious regression.
 *   (B) Predictive content: causal IC of the LAGGED residual (and residual-Z) vs next-day return,
 *       overall and out-of-sample (post-2021, where the model "failed live").
 *   (C) Stronger honest variants (all reported into HONEST N, no cherry-picking):
 *         - continuous/proportional sizing on -residual-Z (mean-reversion, capped),
 *         - long-short ALWAYS-invested (fix the flat-during-bull underperformance vs B&H),
 *         - vol-targeted version,
 *         - a "deep-undervaluation only" version.
 *       We report the best honest net Sharpe across the EXPANDED grid and whether ANY beats B&H
 *       net-of-cost AND beats the phase-randomization surrogate.
 *
 * Strictly causal: on-chain features LAGGED >= 1 day; expanding OLS uses only data < t; position at
 * close t earns NEXT-day return. crossSectional:false surrogate (single-asset timing).
 */
import fs from "node:fs";
import {
  loadPanel,
  runPositions,
  annSharpe,
  sharpeDaily,
  mean,
  std,
  sma,
  rollingZ,
  mkRng,
  COST_PER_SIDE,
  type Panel,
} from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const OUT = "output/edgehunt-D5";
const LAG = 1;
const ANN = Math.sqrt(365);

function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}
function corr(a: number[], b: number[]): { r: number; n: number } {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < a.length; i++)
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  const n = xs.length;
  if (n < 10) return { r: NaN, n };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx*dy; sxx += dx*dx; syy += dy*dy; }
  return { r: sxy / Math.sqrt(sxx * syy), n };
}

const P: Panel = loadPanel("btc");
const T = P.price.length;

// ---- build S2F residual exactly as the committed test ----
const issNtv = P.supply.map((s, t) =>
  t > 0 && Number.isFinite(s) && Number.isFinite(P.supply[t - 1]) ? Math.max(0, s - P.supply[t - 1]) : NaN,
);
const annFlow = sma(issNtv, 365).map((v) => (Number.isFinite(v) ? v * 365 : NaN));
const s2fRaw = P.supply.map((s, t) => (Number.isFinite(s) && annFlow[t] > 0 ? s / annFlow[t] : NaN));
const lnS2F = s2fRaw.map((v) => (v > 0 ? Math.log(v) : NaN));
const lnP = P.price.map((p) => (p > 0 ? Math.log(p) : NaN));

function residualSeries(minObs: number, lnS: number[]): number[] {
  const out = new Array(T).fill(NaN);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < T; t++) {
    if (n >= minObs) {
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9 && Number.isFinite(lnS[t]) && Number.isFinite(lnP[t])) {
        const beta = (n * sxy - sx * sy) / denom;
        const alpha = (sy - beta * sx) / n;
        out[t] = lnP[t] - (alpha + beta * lnS[t]);
      }
    }
    if (Number.isFinite(lnS[t]) && Number.isFinite(lnP[t])) {
      n++; sx += lnS[t]; sy += lnP[t]; sxx += lnS[t]*lnS[t]; sxy += lnS[t]*lnP[t];
    }
  }
  return out;
}
const lnS2FL = lag(lnS2F, LAG);

// =====================================================================================
// (A) DIAGNOSTIC: is the S2F residual just a price clock?
// Build a pure price-trend "residual": ln(price) minus its own expanding-OLS-on-time fit.
// If the S2F residual ≈ this, the regressor (S2F, a deterministic clock) added nothing.
// =====================================================================================
function priceTrendResidual(minObs: number): number[] {
  const out = new Array(T).fill(NaN);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < T; t++) {
    const x = t; // time index = the clock
    if (n >= minObs && Number.isFinite(lnP[t])) {
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9) {
        const beta = (n * sxy - sx * sy) / denom;
        const alpha = (sy - beta * sx) / n;
        out[t] = lnP[t] - (alpha + beta * x);
      }
    }
    if (Number.isFinite(lnP[t])) { n++; sx += x; sy += lnP[t]; sxx += x*x; sxy += x*lnP[t]; }
  }
  return out;
}

const res730 = residualSeries(730, lnS2FL);
const priceClock = lag(priceTrendResidual(730), LAG);
// trailing 365d price momentum (pure price)
const mom365 = P.price.map((p, t) => (t >= 365 && P.price[t - 365] > 0 ? Math.log(p / P.price[t - 365]) : NaN));
const mom365L = lag(mom365, LAG);

const dC = corr(res730, priceClock);
const dM = corr(res730, mom365L);
console.log("=== (A) Diagnostic: what is the S2F residual? ===");
console.log(`corr(S2F-residual, expanding-price-vs-TIME residual) = ${dC.r.toFixed(3)} (n=${dC.n})`);
console.log(`corr(S2F-residual, trailing 365d price momentum)     = ${dM.r.toFixed(3)} (n=${dM.n})`);

// =====================================================================================
// (B) PREDICTIVE CONTENT: causal IC of lagged residual / residual-Z vs next-day return.
// Full-sample and post-2021 ("live failure" window).
// =====================================================================================
const fwd = P.fwdRet;
function icOnWindow(sig: number[], from: number, to: number): { r: number; n: number } {
  return corr(sig.map((v, t) => (t >= from && t < to ? v : NaN)), fwd.map((v, t) => (t >= from && t < to ? v : NaN)));
}
const resZ730 = rollingZ(res730, 365);
const idx2021 = P.dates.findIndex((d) => d >= "2021-01-01");
console.log("\n=== (B) Predictive content (causal IC vs next-day return) ===");
const icFull = corr(resZ730, fwd);
const icPre = icOnWindow(resZ730, 0, idx2021);
const icPost = icOnWindow(resZ730, idx2021, T - 1);
console.log(`IC(residual-Z -> next-day ret) full   = ${icFull.r.toFixed(4)} (n=${icFull.n})`);
console.log(`IC pre-2021                            = ${icPre.r.toFixed(4)} (n=${icPre.n})`);
console.log(`IC post-2021 (live-failure window)     = ${icPost.r.toFixed(4)} (n=${icPost.n})  <- sign flip = curve-fit`);

// =====================================================================================
// (C) STRONGER HONEST VARIANTS — expanded grid, all counted into honest N.
// =====================================================================================
const startIdx = 1100;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * 0.8); // in-sample = first 80%

// B&H benchmark (net-of-cost, same window) — the binding baseline
const bhPos = new Array(T).fill(1);
const bhIS = annSharpe(sharpeDaily(runPositions(P, bhPos, startIdx, splitIdx).dailyNet));
const bhOOS = annSharpe(sharpeDaily(runPositions(P, bhPos, splitIdx, tradableEnd).dailyNet));

type Variant = { name: string; build: () => number[]; surr: (rng: () => number) => number[] };
const variants: Variant[] = [];

// proportional mean-reversion sizing on -residualZ, capped at ±cap, for a few (zwin, cap, side)
for (const zwin of [365, 730]) {
  for (const cap of [1, 2]) {
    for (const longOnly of [true, false]) {
      const mkSig = (res: number[]) => rollingZ(res, zwin);
      const buildFrom = (res: number[]) => {
        const z = mkSig(res);
        const pos = new Array(T).fill(NaN);
        for (let t = 0; t < T; t++) {
          if (!Number.isFinite(z[t])) continue;
          let raw = Math.max(-cap, Math.min(cap, -z[t])) / cap; // undervalued(z<0)->long
          if (longOnly) raw = Math.max(0, raw);
          pos[t] = raw;
        }
        return pos;
      };
      variants.push({
        name: `prop zwin=${zwin} cap=${cap} ${longOnly ? "longflat" : "longshort"}`,
        build: () => buildFrom(res730),
        surr: (rng) => buildFrom(phaseRandomize(res730, rng)),
      });
    }
  }
}
// ALWAYS-invested long/short threshold (fixes flat-during-bull underperformance vs B&H)
for (const zwin of [365, 730]) {
  for (const buy of [-0.5, -1]) {
    const buildFrom = (res: number[]) => {
      const z = rollingZ(res, zwin);
      const pos = new Array(T).fill(NaN);
      for (let t = 0; t < T; t++) {
        if (!Number.isFinite(z[t])) continue;
        pos[t] = z[t] <= buy ? 1 : -1; // never flat
      }
      return pos;
    };
    variants.push({
      name: `alwaysLS zwin=${zwin} buy=${buy}`,
      build: () => buildFrom(res730),
      surr: (rng) => buildFrom(phaseRandomize(res730, rng)),
    });
  }
}
// vol-targeted proportional (scale by inverse trailing vol) long-only
for (const zwin of [365, 730]) {
  const buildFrom = (res: number[]) => {
    const z = rollingZ(res, zwin);
    // trailing 30d realized vol of price returns
    const ret = P.price.map((p, t) => (t > 0 && P.price[t-1] > 0 ? Math.log(p/P.price[t-1]) : NaN));
    const pos = new Array(T).fill(NaN);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(z[t]) || t < 30) continue;
      const w = ret.slice(t-30, t).filter(Number.isFinite);
      const v = std(w) || 1;
      const target = 0.02; // ~2% daily target
      let raw = Math.max(0, Math.min(2, -z[t])); // long-only undervaluation
      pos[t] = raw * Math.min(2, target / v);
    }
    return pos;
  };
  variants.push({
    name: `volTgt zwin=${zwin} longflat`,
    build: () => buildFrom(res730),
    surr: (rng) => buildFrom(phaseRandomize(res730, rng)),
  });
}

console.log("\n=== (C) Stronger honest variants (in-sample net Sharpe, vs B&H) ===");
console.log(`B&H in-sample net Sharpe = ${bhIS.toFixed(3)} | B&H OOS = ${bhOOS.toFixed(3)}`);
const rows = variants.map((v) => {
  const pos = v.build();
  const r = runPositions(P, pos, startIdx, splitIdx);
  const sh = annSharpe(sharpeDaily(r.dailyNet));
  // surrogate p on this variant
  const nSurr = 200;
  let above = 0;
  for (let i = 0; i < nSurr; i++) {
    const rng = mkRng(13000 + i * 7919);
    const sp = v.surr(rng);
    const sr = runPositions(P, sp, startIdx, splitIdx);
    if (annSharpe(sharpeDaily(sr.dailyNet)) >= sh) above++;
  }
  const surrP = (above + 1) / (nSurr + 1);
  const oos = annSharpe(sharpeDaily(runPositions(P, pos, splitIdx, tradableEnd).dailyNet));
  return { name: v.name, sh, surrP, oos, beatsBH: sh > bhIS, turnover: r.turnover };
});
rows.sort((a, b) => b.sh - a.sh);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(34)} netSh=${r.sh.toFixed(3)} surrP=${r.surrP.toFixed(3)} OOS=${r.oos.toFixed(3)} turn=${r.turnover.toFixed(3)} ${r.beatsBH ? "BEATS-BH" : "sub-BH"}`,
  );
}
const best = rows[0];
const anyBeatBHandSurr = rows.find((r) => r.beatsBH && r.surrP < 0.05);
console.log("\n=== SUMMARY ===");
console.log(`expanded honest N (this probe) = ${variants.length} variants`);
console.log(`best variant: ${best.name}  netSh=${best.sh.toFixed(3)} (B&H ${bhIS.toFixed(3)}) surrP=${best.surrP.toFixed(3)}`);
console.log(`ANY variant beats B&H net AND surrogate p<0.05? ${anyBeatBHandSurr ? "YES -> " + anyBeatBHandSurr.name : "NO"}`);

fs.writeFileSync(`${OUT}/strengthen_s2f.json`, JSON.stringify({
  diagnostic: { corr_residual_priceClock: dC.r, corr_residual_mom365: dM.r,
    ic_full: icFull.r, ic_pre2021: icPre.r, ic_post2021: icPost.r },
  bhIS, bhOOS, variants: rows, bestBeatsBHandSurr: !!anyBeatBHandSurr,
}, null, 2));
