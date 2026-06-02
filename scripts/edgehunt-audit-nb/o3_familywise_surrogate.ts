/**
 * O3-NVTS INDEPENDENT AUDIT — FAMILY-WISE MAX-STATISTIC SURROGATE over the FULL searched grid.
 *
 * The committed harness (runGauntlet) runs the phase-randomization surrogate ONLY for the single
 * argmax config (best.cfg): it phase-scrambles that one signal nSurr times and compares the real
 * best Sharpe to that one config's surrogate distribution. That is a SINGLE-CONFIG placebo p. For a
 * SEARCHED grid the right null is the FAMILY-WISE MAX statistic: under each surrogate draw, rebuild
 * EVERY config on the phase-randomized signal, take the grid-MAX in-sample net Sharpe, and build the
 * null distribution of those per-surrogate maxima. The real grid-best must beat the 95th percentile
 * of that max-distribution to clear the gate. This is the exact correction the main audit applied to
 * the BTC reserve lead.
 *
 * We replicate the harness's in-sample window EXACTLY (startIdx=800, holdoutFrac=0.2, 4bps/side,
 * net Sharpe annualized sqrt(365)) so the surrogate Sharpes are directly comparable to the reported
 * real grid-best (1.3316).
 *
 * Two grids audited:
 *   - FULL broad grid  (N=312): the actually-searched neighborhood from run_nvts.ts.
 *   - RESTRICTED grid  (N=54):  the a-priori fee-only carve-out from strengthen_nvts.ts.
 * If real-best < surr95(max) on the grid where the win was found, the surrogate gate FAILS -> KILL.
 */
import fs from "node:fs";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import { loadNvtPanel, throughput, type NvtPanel } from "../edgehunt-onchain2/load_nvt.ts";

const OUT = "output/edgehunt-audit-nb";
const LAG = 1;
const COST = 0.0004;
const ANN = Math.sqrt(365);
const START_IDX = 800;
const HOLDOUT_FRAC = 0.2;
const N_SURR = 1000; // match the robustness 1000-surrogate run

function sma(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; let s = 0, ok = true; for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; } if (ok) out[i] = s / win; } return out; }
function rollingZ(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { const lo = Math.max(0, i - win + 1); const w: number[] = []; for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length < 60) continue; const m = w.reduce((s, v) => s + v, 0) / w.length; const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1)); out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0; } return out; }
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }

function mkRng(seed: number): () => number { let s = seed >>> 0; return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// nvts z from a (possibly surrogate) throughput-NV ratio path. We surrogate the *z-signal* exactly
// as the harness does: zCache holds the real z; surrogate = phaseRandomize(thatZ). So we mirror that.
function nvtsZreal(P: NvtPanel, kind: string, smaWin: number, zWin: number): number[] {
  const thrSm = sma(throughput(P, kind), smaWin);
  const nv = P.marketCap.map((mc, t) => (mc > 0 && thrSm[t] > 0 ? mc / thrSm[t] : NaN));
  return rollingZ(nv, zWin);
}

function positionFrom(zL: number[], rule: string, zHi: number, zLo: number): number[] {
  const T = zL.length; const pos = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) { const z = zL[t]; if (!Number.isFinite(z)) { pos[t] = NaN; continue; }
    if (rule === "avoidHigh") pos[t] = z < zHi ? 1 : 0;
    else if (rule === "band") pos[t] = z > zHi ? -1 : z < zLo ? 1 : 0;
    else if (rule === "shortHigh") pos[t] = z > zHi ? -1 : 0;
    else if (rule === "cont") pos[t] = Math.max(-1, Math.min(1, -z / 2)); }
  return pos;
}

// in-sample net Sharpe over [START_IDX, splitIdx), 4bps/side, ann sqrt(365). Mirrors runPositions.
function inSampleNetSharpe(P: NvtPanel, pos: number[], splitIdx: number): number {
  const r: number[] = []; let prev = 0;
  for (let t = START_IDX; t < splitIdx; t++) {
    const fr = P.fwdRet[t]; const p = pos[t];
    if (!Number.isFinite(fr) || !Number.isFinite(p)) continue;
    r.push(p * fr - Math.abs(p - prev) * COST); prev = p;
  }
  if (r.length < 3) return -99;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return sd > 1e-12 ? (m / sd) * ANN : 0;
}

type Cfg = { kind: string; sma: number; zWin: number; rule: string; zHi: number; zLo: number };

function buildBroadGrid(): Cfg[] {
  const kinds = ["fee", "feeNtv", "tx", "tfr"]; const smas = [30, 60, 90]; const zWins = [365, 730];
  const rules = ["avoidHigh", "band", "shortHigh", "cont"]; const zHis = [1.0, 1.5, 2.0]; const zLos = [-1.0, -0.5];
  const configs: Cfg[] = [];
  for (const k of kinds) for (const s of smas) for (const w of zWins) for (const rule of rules) for (const zHi of zHis) {
    if (rule === "band") { for (const zLo of zLos) configs.push({ kind: k, sma: s, zWin: w, rule, zHi, zLo }); }
    else if (rule === "cont") { configs.push({ kind: k, sma: s, zWin: w, rule, zHi: 0, zLo: 0 }); }
    else { configs.push({ kind: k, sma: s, zWin: w, rule, zHi, zLo: 0 }); }
  }
  const seen = new Set<string>();
  return configs.filter((c) => { const key = JSON.stringify(c); if (seen.has(key)) return false; seen.add(key); return true; });
}

function buildRestrictedGrid(): Cfg[] {
  const smas = [30, 60, 90]; const zWins = [365, 730]; const zHis = [1.0, 1.5, 2.0]; const zLos = [-1.0, -0.5];
  const configs: Cfg[] = [];
  for (const s of smas) for (const w of zWins) for (const zHi of zHis) {
    for (const zLo of zLos) configs.push({ kind: "fee", sma: s, zWin: w, rule: "band", zHi, zLo });
    configs.push({ kind: "fee", sma: s, zWin: w, rule: "shortHigh", zHi, zLo: 0 });
  }
  return configs;
}

function zKey(k: string, s: number, w: number) { return `${k}|${s}|${w}`; }

function audit(asset: "btc" | "eth", grid: Cfg[], gridName: string) {
  const P = loadNvtPanel(asset);
  const T = P.price.length;
  const tradableEnd = T - 1;
  const span = tradableEnd - START_IDX;
  const splitIdx = START_IDX + Math.floor(span * (1 - HOLDOUT_FRAC));

  // real z cache
  const zCacheReal = new Map<string, number[]>();
  for (const c of grid) { const key = zKey(c.kind, c.sma, c.zWin); if (!zCacheReal.has(key)) zCacheReal.set(key, nvtsZreal(P, c.kind, c.sma, c.zWin)); }

  // REAL grid-best in-sample
  let realBest = -99; let realBestCfg: Cfg | null = null;
  for (const c of grid) {
    const zL = lag(zCacheReal.get(zKey(c.kind, c.sma, c.zWin))!, LAG);
    const pos = positionFrom(zL, c.rule, c.zHi, c.zLo);
    const sh = inSampleNetSharpe(P, pos, splitIdx);
    if (sh > realBest) { realBest = sh; realBestCfg = c; }
  }

  // unique z-signal keys for surrogating
  const zKeys = [...zCacheReal.keys()];

  // FAMILY-WISE MAX: per surrogate draw, phase-randomize each unique z-signal ONCE, rebuild ALL
  // configs on the scrambled signals, take grid-MAX. (matches harness's surrogate of the z-signal.)
  const surrMax: number[] = [];
  // ALSO single-config null for the real argmax (replicate the harness gate) for apples-to-apples.
  const surrSingle: number[] = [];
  const argmaxKey = zKey(realBestCfg!.kind, realBestCfg!.sma, realBestCfg!.zWin);
  for (let i = 0; i < N_SURR; i++) {
    const rng = mkRng(7000 + i * 7919);
    const zSurr = new Map<string, number[]>();
    for (const key of zKeys) zSurr.set(key, phaseRandomize(zCacheReal.get(key)!, rng));
    let mx = -99;
    for (const c of grid) {
      const zL = lag(zSurr.get(zKey(c.kind, c.sma, c.zWin))!, LAG);
      const pos = positionFrom(zL, c.rule, c.zHi, c.zLo);
      const sh = inSampleNetSharpe(P, pos, splitIdx);
      if (sh > mx) mx = sh;
    }
    surrMax.push(mx);
    // single-config: scramble only argmax signal with an independent stream (harness uses best.cfg)
    const rng2 = mkRng(7000 + i * 7919);
    const zS = phaseRandomize(zCacheReal.get(argmaxKey)!, rng2);
    const zL = lag(zS, LAG);
    const pos = positionFrom(zL, realBestCfg!.rule, realBestCfg!.zHi, realBestCfg!.zLo);
    surrSingle.push(inSampleNetSharpe(P, pos, splitIdx));
  }
  surrMax.sort((a, b) => a - b);
  surrSingle.sort((a, b) => a - b);
  const pct = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  const surr95max = pct(surrMax, 0.95);
  const surr99max = pct(surrMax, 0.99);
  const surr95single = pct(surrSingle, 0.95);
  const pFamilywise = (surrMax.filter((s) => s >= realBest).length + 1) / (N_SURR + 1);
  const pSingle = (surrSingle.filter((s) => s >= realBest).length + 1) / (N_SURR + 1);

  return {
    asset, gridName, honestN: grid.length, nSurr: N_SURR,
    realBest, realBestCfg,
    surrMax_mean: surrMax.reduce((a, b) => a + b, 0) / surrMax.length,
    surr95max, surr99max, surrMax_max: surrMax[surrMax.length - 1],
    surr95single,
    p_familywise_max: pFamilywise,
    p_single_config: pSingle,
    familywise_gate_pass: realBest > surr95max,
  };
}

const results: Record<string, unknown> = {};
for (const [name, grid] of [["BROAD_N312", buildBroadGrid()], ["RESTRICTED_N54", buildRestrictedGrid()]] as const) {
  const r = audit("btc", grid, name);
  results[name] = r;
  console.log(`\n==== O3-NVTS BTC ${name} (honestN=${r.honestN}, surr=${r.nSurr}) ====`);
  console.log(`  real grid-best in-sample net Sharpe = ${r.realBest.toFixed(4)}  cfg=${JSON.stringify(r.realBestCfg)}`);
  console.log(`  FAMILY-WISE MAX null: surrMean=${r.surrMax_mean.toFixed(4)} surr95(max)=${r.surr95max.toFixed(4)} surr99(max)=${r.surr99max.toFixed(4)} surrMaxMax=${r.surrMax_max.toFixed(4)}`);
  console.log(`  single-config null (harness gate): surr95=${r.surr95single.toFixed(4)}`);
  console.log(`  family-wise MAX p = ${r.p_familywise_max.toFixed(4)}   single-config p = ${r.p_single_config.toFixed(4)}`);
  console.log(`  family-wise gate (realBest > surr95max): ${r.familywise_gate_pass ? "PASS" : "FAIL -> KILL"}`);
}
fs.writeFileSync(`${OUT}/o3_familywise_surrogate.json`, JSON.stringify(results, null, 2));
console.log(`\nwrote ${OUT}/o3_familywise_surrogate.json`);
