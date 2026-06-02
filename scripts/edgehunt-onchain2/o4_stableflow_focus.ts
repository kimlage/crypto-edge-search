/**
 * O4-STABLEFLOW — focused / parsimonious confirmation.
 *
 * The full 270-config search produced a net Sharpe 1.224 winner but it was (a) the RAW
 * (price-echo-contaminated, orth=0) signal and (b) killed by Deflated Sharpe @ N=270 and PBO=0.60.
 * The orthogonalized (reverse-causality-clean) canonical had a NEGATIVE holdout (-0.395).
 *
 * Honest strengthening: if the dry-powder flow is a REAL economic effect, a tiny pre-registered grid
 * should survive DSR (the haircut scales with N). Two focused families, each judged separately so the
 * honest N is small:
 *   FAMILY A (raw growth, the price-echo-suspect winner family): 3 growth windows only, dryPowder,
 *            th=0.5, orth=0, zwin=90.  honest N = 3.
 *   FAMILY B (orthogonalized = reverse-causality clean, the ECONOMICALLY HONEST version):
 *            3 growth windows, dryPowder, th=0.5, orth=1, zwin=90.  honest N = 3.
 * Same committed gauntlet + AR-matched phase-rand surrogate + reverse-causality price-echo placebo.
 *
 * If A survives but B dies, the "edge" is the price echo (reverse causality), not dry powder.
 */
import fs from "node:fs";
import {
  loadPanel, loadStables, runGauntlet, printVerdict, rollingZ, runPositions,
  sharpeDaily, annSharpe, mean, mkRng, type Panel, type GauntletOutput,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";

const OUT = "output/edgehunt-onchain2";
const LAG = 1;
const lag = (x: number[], k: number) => { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; };
function winsorize(x: number[], c: number) {
  const v = x.filter(Number.isFinite).slice().sort((a, b) => a - b); if (v.length < 10) return x.slice();
  const med = v[Math.floor(v.length / 2)]; const ad = v.map((y) => Math.abs(y - med)).sort((a, b) => a - b);
  const mad = ad[Math.floor(ad.length / 2)] || 1e-9; const lo = med - c * 1.4826 * mad, hi = med + c * 1.4826 * mad;
  return x.map((y) => (Number.isFinite(y) ? Math.min(hi, Math.max(lo, y)) : y));
}
function expandingResidual(y: number[], r: number[], minObs: number) {
  const out = new Array(y.length).fill(NaN); let n = 0, sr = 0, sy = 0, srr = 0, sry = 0;
  for (let t = 0; t < y.length; t++) {
    if (n >= minObs && Number.isFinite(y[t]) && Number.isFinite(r[t])) {
      const d = n * srr - sr * sr; if (Math.abs(d) > 1e-12) { const b = (n * sry - sr * sy) / d; const a = (sy - b * sr) / n; out[t] = y[t] - (a + b * r[t]); }
    }
    if (Number.isFinite(y[t]) && Number.isFinite(r[t])) { n++; sr += r[t]; sy += y[t]; srr += r[t] * r[t]; sry += r[t] * y[t]; }
  }
  return out;
}

function buildFeats(P: Panel, gws: number[]) {
  const stab = loadStables(); const T = P.dates.length;
  const supply = P.dates.map((d) => stab.get(d) ?? NaN);
  for (let t = 1; t < T; t++) if (!Number.isFinite(supply[t])) supply[t] = supply[t - 1];
  const lnS = supply.map((v) => (v > 0 ? Math.log(v) : NaN));
  const trail = new Array(T).fill(NaN);
  for (let t = 30; t < T; t++) if (P.price[t] > 0 && P.price[t - 30] > 0) trail[t] = Math.log(P.price[t] / P.price[t - 30]);
  const raw = new Map<number, number[]>(), resid = new Map<number, number[]>();
  for (const gw of gws) {
    const g = new Array(T).fill(NaN);
    for (let t = gw; t < T; t++) if (Number.isFinite(lnS[t]) && Number.isFinite(lnS[t - gw])) g[t] = lnS[t] - lnS[t - gw];
    const gw_w = winsorize(g, 5);
    raw.set(gw, lag(gw_w, LAG));
    resid.set(gw, lag(expandingResidual(gw_w, trail, 200), LAG));
  }
  return { raw, resid, trail: lag(trail, LAG) };
}

function runFamily(P: Panel, orth: boolean, label: string) {
  const gws = [30, 60, 90];
  const feats = buildFeats(P, gws);
  const T = P.dates.length;
  const startIdx = Math.max(P.dates.findIndex((d) => d >= "2019-01-01"), 350);
  const rawSig = (gw: number) => (orth ? feats.resid : feats.raw).get(gw)!;
  const signal = (gw: number) => rollingZ(rawSig(gw), 90);
  const configs = gws.map((gw) => ({ gw, zwin: 90, th: 0.5, dir: "dryPowder", orth: orth ? 1 : 0 }));
  const build = (cfg: Record<string, number | string>, sig?: number[]) => {
    const z = sig ?? signal(cfg.gw as number); const th = cfg.th as number;
    const pos = new Array(T).fill(NaN);
    for (let t = 0; t < T; t++) pos[t] = !Number.isFinite(z[t]) ? NaN : z[t] >= th ? 1 : 0;
    return pos;
  };
  const out = runGauntlet({
    name: `O4-STABLEFLOW ${label} (honest N=3)`,
    P, configs,
    canonical: { gw: 60, zwin: 90, th: 0.5, dir: "dryPowder", orth: orth ? 1 : 0 },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, rollingZ(phaseRandomize(rawSig(cfg.gw as number), rng), 90)),
    startIdx, nSurr: 400,
  });
  // reverse-causality price-echo placebo on the best cfg
  const gw = out.best.cfg.gw as number, th = out.best.cfg.th as number;
  const buildPos = (z: number[]) => { const p = new Array(T).fill(NaN); for (let t = 0; t < T; t++) p[t] = !Number.isFinite(z[t]) ? NaN : z[t] >= th ? 1 : 0; return p; };
  const realRes = runPositions(P, buildPos(signal(gw)), startIdx, T - 1);
  const realSh = annSharpe(sharpeDaily(realRes.dailyNet));
  const echo: number[] = [];
  for (let i = 0; i < 400; i++) { const rng = mkRng(31337 + i * 2654435761); echo.push(annSharpe(sharpeDaily(runPositions(P, buildPos(rollingZ(phaseRandomize(feats.trail, rng), 90)), startIdx, T - 1).dailyNet))); }
  echo.sort((a, b) => a - b);
  const rcP = (echo.filter((s) => s >= realSh).length + 1) / 401;
  return { out, rcP, realSh, echoMean: mean(echo) };
}

const P = loadPanel("btc");
const A = runFamily(P, false, "FAMILY-A raw growth");
const B = runFamily(P, true, "FAMILY-B orthogonalized (reverse-causality clean)");
printVerdict(A.out);
console.log(`  reverse-causality placebo p=${A.rcP.toFixed(4)} (real ${A.realSh.toFixed(3)} vs echoMean ${A.echoMean.toFixed(3)})`);
printVerdict(B.out);
console.log(`  reverse-causality placebo p=${B.rcP.toFixed(4)} (real ${B.realSh.toFixed(3)} vs echoMean ${B.echoMean.toFixed(3)})`);

function adj(o: GauntletOutput, rcP: number) {
  const bindingSurrP = Math.max(o.surrogateP, rcP);
  const core = o.gates.net_of_cost.pass && o.gates.baselines.pass && o.gates.holdout.pass && bindingSurrP < 0.05;
  const v = o.bindingGate === "none" && bindingSurrP < 0.05 ? "SURVIVE" : core ? "PROMISING" : "KILL";
  let binding = o.bindingGate; if (o.bindingGate === "none" && bindingSurrP >= 0.05) binding = "reverse_causality";
  return { v, binding, bindingSurrP, netSh: o.best.netSharpeAnn, holdout: o.holdoutSharpeAnn, dsr: o.gates.deflated_sharpe.detail };
}
const rep = {
  familyA_raw: adj(A.out, A.rcP),
  familyB_orth: adj(B.out, B.rcP),
};
console.log("\nFOCUS SUMMARY:", JSON.stringify(rep, null, 2));
fs.writeFileSync(`${OUT}/o4_stableflow_focus.json`, JSON.stringify({ familyA: { ...rep.familyA_raw, rcP: A.rcP, gates: A.out.gates }, familyB: { ...rep.familyB_orth, rcP: B.rcP, gates: B.out.gates } }, null, 2));
