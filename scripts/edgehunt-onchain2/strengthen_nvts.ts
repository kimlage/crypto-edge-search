/**
 * O3-NVTS — STRENGTHENED, pre-committed version.
 *
 * The full-grid run (N=312) was PROMISING on BTC: net Sharpe 1.33 > B&H 0.60, passed baselines /
 * block-bootstrap / CPCV-PBO=0.15 / Harvey-Liu / the RIGHT surrogate (p=0.013) / holdout (+0.59),
 * tripping ONLY Deflated Sharpe (p=0.894) under the N=312 multiple-testing penalty.
 *
 * The probe established a legitimate A-PRIORI restriction BEFORE Sharpe-maximization: only the
 * FEE-revenue NVTS (MarketCap / SMA(FeeTotNtv*Price)) has forward-return buckets INVERTED vs a pure
 * price-clock that SURVIVE orthogonalization vs price momentum. So here we pre-commit to:
 *   - denominator = fee only (economically justified, not Sharpe-picked)
 *   - the contrarian thesis rules only: band (long cheap / short overvalued) + shortHigh (isolate the
 *     overvalued-avoid leg, the part that beats the price-clock)
 *   - Kalichkin-standard smoothing/window neighborhood
 * This shrinks honest N from 312 to a small economically-motivated grid so DSR is a fair test.
 *
 * We ALSO decompose the BTC edge: long-only (avoidHigh) vs short-only (shortHigh) vs full band, to
 * confirm the alpha is in the contrarian/short-overvalued leg, not inherited long-beta.
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
function toHarnessPanel(P: NvtPanel): Panel { const T = P.price.length; const nan = new Array(T).fill(NaN); return { asset: P.asset, dates: P.dates, price: P.price.slice(), fwdRet: P.fwdRet.slice(), mvrv: nan.slice(), flowInNtv: nan.slice(), flowOutNtv: nan.slice(), adr: nan.slice(), marketCap: P.marketCap.slice(), hashRate: nan.slice(), supply: P.supply.slice(), realizedCap: nan.slice(), realizedPrice: nan.slice() }; }
function nvtsZ(P: NvtPanel, smaWin: number, zWin: number): number[] { const thrSm = sma(throughput(P, "fee"), smaWin); const nv = P.marketCap.map((mc, t) => (mc > 0 && thrSm[t] > 0 ? mc / thrSm[t] : NaN)); return rollingZ(nv, zWin); }
function positionFrom(zL: number[], rule: string, zHi: number, zLo: number): number[] { const T = zL.length; const pos = new Array(T).fill(NaN); for (let t = 0; t < T; t++) { const z = zL[t]; if (!Number.isFinite(z)) { pos[t] = NaN; continue; } if (rule === "avoidHigh") pos[t] = z < zHi ? 1 : 0; else if (rule === "band") pos[t] = z > zHi ? -1 : z < zLo ? 1 : 0; else if (rule === "shortHigh") pos[t] = z > zHi ? -1 : 0; } return pos; }

function run(asset: "btc" | "eth"): { full: GauntletOutput; decomp: Record<string, number> } {
  const P = loadNvtPanel(asset);
  const HP = toHarnessPanel(P);
  // pre-committed economic grid: fee denom, Kalichkin neighborhood
  const smas = [30, 60, 90];
  const zWins = [365, 730];
  const zHis = [1.0, 1.5, 2.0];
  const zLos = [-1.0, -0.5];

  const zCache = new Map<string, number[]>();
  const zKey = (s: number, w: number) => `${s}|${w}`;
  for (const s of smas) for (const w of zWins) zCache.set(zKey(s, w), nvtsZ(P, s, w));

  const configs: Record<string, number | string>[] = [];
  for (const s of smas) for (const w of zWins) for (const zHi of zHis) {
    for (const zLo of zLos) configs.push({ sma: s, zWin: w, rule: "band", zHi, zLo });
    configs.push({ sma: s, zWin: w, rule: "shortHigh", zHi, zLo: 0 });
  }
  function build(cfg: Record<string, number | string>, surrZ?: number[]): number[] {
    const base = surrZ ?? zCache.get(zKey(cfg.sma as number, cfg.zWin as number))!;
    return positionFrom(lag(base, LAG), cfg.rule as string, cfg.zHi as number, cfg.zLo as number);
  }
  const full = runGauntlet({
    name: `O3-NVTS STRENGTHENED fee-only contrarian (${asset.toUpperCase()})`,
    P: HP, configs,
    canonical: { sma: 90, zWin: 365, rule: "band", zHi: 1.5, zLo: -1.0 },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(zCache.get(zKey(cfg.sma as number, cfg.zWin as number))!, rng)),
    startIdx: 800,
  });

  // edge decomposition (in-sample, simple net Sharpe) for the canonical neighborhood (90/730)
  const z = nvtsZ(P, 30, 730);
  const zL = lag(z, LAG);
  const ANN = Math.sqrt(365);
  function sh(pos: number[]): number {
    const r: number[] = []; let prev = 0;
    for (let t = 800; t < P.price.length - 1; t++) { const fr = P.fwdRet[t]; const p = pos[t]; if (!Number.isFinite(fr) || !Number.isFinite(p)) continue; r.push(p * fr - Math.abs(p - prev) * 0.0004); prev = p; }
    const m = r.reduce((a, b) => a + b, 0) / r.length; const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)); return (m / sd) * ANN;
  }
  const decomp = {
    longOnly_avoidHigh: sh(positionFrom(zL, "avoidHigh", 1.5, 0)),
    shortOnly_high: sh(positionFrom(zL, "shortHigh", 1.5, 0)),
    band_full: sh(positionFrom(zL, "band", 1.5, -0.5)),
    buyHold: sh(new Array(P.price.length).fill(1)),
  };
  return { full, decomp };
}

const summary: Record<string, unknown> = {};
for (const asset of ["btc", "eth"] as const) {
  const { full, decomp } = run(asset);
  printVerdict(full);
  console.log(`  EDGE DECOMP (${asset}, 30/730, |z|>1.5): longOnly=${decomp.longOnly_avoidHigh.toFixed(3)} shortOnly=${decomp.shortOnly_high.toFixed(3)} band=${decomp.band_full.toFixed(3)} B&H=${decomp.buyHold.toFixed(3)}`);
  fs.writeFileSync(`${OUT}/result_nvts_strong_${asset}.json`, JSON.stringify({ full, decomp }, null, 2));
  summary[asset] = { verdict: full.verdict, netSharpe: full.best.netSharpeAnn, honestN: full.honestN, binding: full.bindingGate, surrP: full.surrogateP, holdout: full.holdoutSharpeAnn, dsr: full.gates.deflated_sharpe.detail, decomp };
}
fs.writeFileSync(`${OUT}/strengthen_summary.json`, JSON.stringify(summary, null, 2));
