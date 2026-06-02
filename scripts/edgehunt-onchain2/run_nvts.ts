/**
 * O3-NVTS — NVT-signal refinement (strongest causal version), run through the COMMITTED gauntlet.
 *
 * FREE-DATA STATUS: classic NVT = MarketCap / TxTfrValAdjUSD requires PAID data (TxTfrValAdjUSD /
 * NVTAdj are NOT in the Coin Metrics Community catalog of 32 metrics; verified live). So this tests
 * the strongest FREE proxies for the NVT denominator (economic throughput in USD), each smoothed
 * (Kalichkin NVTS = SMA of throughput), z-scored on a trailing window, LAGGED >=1 day. Strictly
 * causal: signal at close t, traded t->t+1. Honest N counts EVERY config across all denominators,
 * smoothings, z-windows, rules, and thresholds.
 *
 * Probe finding driving the design: the fee-revenue NVTS (MarketCap / SMA90(FeeTotNtv*Price)) is the
 * ONLY denominator whose forward-return buckets are INVERTED vs a pure price-clock and SURVIVE
 * orthogonalization vs price momentum (extreme-high NVTS -> flat/negative fwd returns even when price
 * momentum is strong). The honest strategies give that contrarian "avoid/short overvalued" thesis its
 * strongest shot, judged net-of-cost, vs baselines, DSR@N, CPCV/PBO, Harvey-Liu, the RIGHT surrogate
 * (phase-randomized NVTS on the SAME price path), and a consume-once holdout.
 */
import fs from "node:fs";
import { runGauntlet, printVerdict, type Panel, type GauntletOutput } from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";
import { loadNvtPanel, throughput, type NvtPanel } from "./load_nvt.ts";

const OUT = "output/edgehunt-onchain2";
const LAG = 1;

function sma(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { if (i + 1 < win) continue; let s = 0, ok = true; for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; } if (ok) out[i] = s / win; } return out; }
function rollingZ(x: number[], win: number): number[] { const out = new Array(x.length).fill(NaN); for (let i = 0; i < x.length; i++) { const lo = Math.max(0, i - win + 1); const w: number[] = []; for (let k = lo; k <= i; k++) if (Number.isFinite(x[k])) w.push(x[k]); if (w.length < 60) continue; const m = w.reduce((s, v) => s + v, 0) / w.length; const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1)); out[i] = sd > 1e-12 ? (x[i] - m) / sd : 0; } return out; }
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }

// build harness-compatible Panel from NvtPanel (runGauntlet only reads price + fwdRet directly)
function toHarnessPanel(P: NvtPanel): Panel {
  const T = P.price.length;
  const nan = new Array(T).fill(NaN);
  return {
    asset: P.asset, dates: P.dates, price: P.price.slice(), fwdRet: P.fwdRet.slice(),
    mvrv: nan.slice(), flowInNtv: nan.slice(), flowOutNtv: nan.slice(), adr: nan.slice(),
    marketCap: P.marketCap.slice(), hashRate: nan.slice(), supply: P.supply.slice(),
    realizedCap: nan.slice(), realizedPrice: nan.slice(),
  };
}

// NVTS z signal (NOT yet lagged) for a given denominator/smoothing/window
function nvtsZ(P: NvtPanel, kind: string, smaWin: number, zWin: number): number[] {
  const thrSm = sma(throughput(P, kind), smaWin);
  const nv = P.marketCap.map((mc, t) => (mc > 0 && thrSm[t] > 0 ? mc / thrSm[t] : NaN));
  return rollingZ(nv, zWin);
}

// map a z-signal to a position per the rule. zL is the LAGGED z (causal).
function positionFrom(zL: number[], rule: string, zHi: number, zLo: number): number[] {
  const T = zL.length;
  const pos = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    const z = zL[t];
    if (!Number.isFinite(z)) { pos[t] = NaN; continue; }
    if (rule === "avoidHigh") pos[t] = z < zHi ? 1 : 0;            // long unless overvalued
    else if (rule === "band") pos[t] = z > zHi ? -1 : z < zLo ? 1 : 0; // short overvalued, long cheap
    else if (rule === "shortHigh") pos[t] = z > zHi ? -1 : 0;       // pure short-overvalued leg (isolate the edge)
    else if (rule === "cont") pos[t] = Math.max(-1, Math.min(1, -z / 2)); // continuous contrarian
  }
  return pos;
}

function run(asset: "btc" | "eth"): GauntletOutput {
  const P = loadNvtPanel(asset);
  const HP = toHarnessPanel(P);
  const kinds = ["fee", "feeNtv", "tx", "tfr"];
  const smas = [30, 60, 90];
  const zWins = [365, 730];
  const rules = ["avoidHigh", "band", "shortHigh", "cont"];
  const zHis = [1.0, 1.5, 2.0];
  const zLos = [-1.0, -0.5];

  // precompute z signals (keyed) to avoid recompute per config
  const zCache = new Map<string, number[]>();
  const zKey = (k: string, s: number, w: number) => `${k}|${s}|${w}`;
  for (const k of kinds) for (const s of smas) for (const w of zWins) zCache.set(zKey(k, s, w), nvtsZ(P, k, s, w));

  const configs: Record<string, number | string>[] = [];
  for (const k of kinds) for (const s of smas) for (const w of zWins) for (const rule of rules) for (const zHi of zHis) {
    if (rule === "band") { for (const zLo of zLos) configs.push({ kind: k, sma: s, zWin: w, rule, zHi, zLo }); }
    else if (rule === "cont") { configs.push({ kind: k, sma: s, zWin: w, rule, zHi: 0, zLo: 0 }); }
    else { configs.push({ kind: k, sma: s, zWin: w, rule, zHi, zLo: 0 }); }
  }
  // dedupe cont (zHi-independent)
  const seen = new Set<string>();
  const uniq = configs.filter((c) => { const key = JSON.stringify(c); if (seen.has(key)) return false; seen.add(key); return true; });

  function build(cfg: Record<string, number | string>, surrZ?: number[]): number[] {
    const base = surrZ ?? zCache.get(zKey(cfg.kind as string, cfg.sma as number, cfg.zWin as number))!;
    const zL = lag(base, LAG);
    return positionFrom(zL, cfg.rule as string, cfg.zHi as number, cfg.zLo as number);
  }

  return runGauntlet({
    name: `O3-NVTS fee/throughput refinement (${asset.toUpperCase()})`,
    P: HP,
    configs: uniq,
    // canonical: Kalichkin NVTS on fee-throughput, 90d MA, 365d z, contrarian band, |z|>1.5 overvalued
    canonical: { kind: "fee", sma: 90, zWin: 365, rule: "avoidHigh", zHi: 1.5, zLo: 0 },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => {
      const z = zCache.get(zKey(cfg.kind as string, cfg.sma as number, cfg.zWin as number))!;
      return build(cfg, phaseRandomize(z, rng));
    },
    startIdx: 800, // warmup for 90d sma + up to 730d z
  });
}

for (const asset of ["btc", "eth"] as const) {
  const o = run(asset);
  printVerdict(o);
  fs.writeFileSync(`${OUT}/result_nvts_${asset}.json`, JSON.stringify(o, null, 2));
}
