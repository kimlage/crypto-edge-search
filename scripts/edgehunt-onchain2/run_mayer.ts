/**
 * O7-MAYER — Mayer Multiple (price / 200d-MA) through the committed gauntlet.
 *
 * BACKLOG (D5-09 sibling): most-used valuation oscillator; belief = buy low-Mayer / lighten high.
 * Probe finding: the belief is BACKWARDS — high Mayer precedes the best forward returns (it is a
 * MA200 trend/momentum proxy), low Mayer precedes flat/negative. So we give the strategy its
 * STRONGEST honest shot by letting the grid pick direction (contrarian AND momentum variants), then
 * judge with the right nulls. Mayer = price/SMA200(price), strictly causal, LAG>=1.
 *
 * Honest N = every config in the grid. Gauntlet: net-of-cost (4bps/side), baselines (B&H /
 * random-lottery), Deflated Sharpe @N, CPCV/PBO, Harvey-Liu, surrogate null, consume-once holdout.
 *
 * TWO nulls reported:
 *   (A) harness default = phase-randomize the Mayer signal (timing-destroying on real price path).
 *   (B) SURROGATE-RECOMPUTE null (the documented price-transform killer) = recompute Mayer on a
 *       spectrum/vol-preserving (phase-rand) and IAAFT surrogate PRICE PATH, run identical rule.
 *       This is wired as buildSurrogatePosition so the harness `surrogate` gate uses it directly.
 */
import fs from "node:fs";
import {
  runGauntlet, printVerdict, type Panel, type GauntletOutput,
} from "../edgehunt-D5/harness.ts";
import { loadPricePanel, type PricePanel } from "./price_panel.ts";
import { phaseSurrogatePrice, iaaftSurrogatePrice } from "./lib_surrogate_price.ts";

const OUT = "output/edgehunt-onchain2";
const LAG = 1;

function sma(x: number[], win: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i++) {
    if (i + 1 < win) continue;
    let s = 0, ok = true;
    for (let k = i - win + 1; k <= i; k++) { if (!Number.isFinite(x[k])) { ok = false; break; } s += x[k]; }
    if (ok) out[i] = s / win;
  }
  return out;
}
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i = k; i < x.length; i++) o[i] = x[i - k]; return o; }

// Mayer multiple from a price path
function mayerFromPrice(price: number[], maWin: number): number[] {
  const ma = sma(price, maWin);
  return price.map((p, t) => Number.isFinite(ma[t]) && ma[t] > 0 ? p / ma[t] : NaN);
}

// minimal Panel for the harness (only price/fwdRet/dates are read by runGauntlet/runPositions)
function toPanel(P: PricePanel): Panel {
  const T = P.price.length;
  const z = new Array(T).fill(NaN);
  return {
    asset: P.asset, dates: P.dates, price: P.price, fwdRet: P.fwdRet,
    mvrv: z, flowInNtv: z, flowOutNtv: z, adr: z, marketCap: z, hashRate: z, supply: z,
    realizedCap: z, realizedPrice: z,
  };
}

/**
 * Position builder for a Mayer config. side: "contrarian" (buy low, flat/short high — the belief)
 * or "momentum" (long while high — what the data favors). Threshold bands lo/hi on the Mayer value.
 *   contrarian-long: long while mayer<=lo, flat otherwise (accumulate cheap)
 *   contrarian-ls:   long mayer<=lo, short mayer>=hi, flat between
 *   momentum-long:   long while mayer>=hi, flat otherwise (ride the strong-trend regime)
 *   momentum-ls:     long mayer>=hi, short mayer<=lo
 */
function buildFromMayer(price: number[], cfg: Record<string, number | string>): number[] {
  const maWin = cfg.maWin as number;
  const mayer = lag(mayerFromPrice(price, maWin), LAG);
  const lo = cfg.lo as number, hi = cfg.hi as number, mode = cfg.mode as string;
  const T = price.length;
  const pos = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    const m = mayer[t];
    if (!Number.isFinite(m)) { pos[t] = NaN; continue; }
    let p = 0;
    if (mode === "contrarian-long") p = m <= lo ? 1 : 0;
    else if (mode === "contrarian-ls") p = m <= lo ? 1 : (m >= hi ? -1 : 0);
    else if (mode === "momentum-long") p = m >= hi ? 1 : 0;
    else if (mode === "momentum-ls") p = m >= hi ? 1 : (m <= lo ? -1 : 0);
    pos[t] = p;
  }
  return pos;
}

function runAsset(asset: "btc" | "eth", surrogateKind: "phase" | "iaaft"): GauntletOutput {
  const PP = loadPricePanel(asset);
  const P = toPanel(PP);
  const realPrice = PP.price;

  // honest grid: 2 MA windows (200 canonical + 210 robustness), lo/hi bands spanning belief & data,
  // 4 modes. Honest N counts EVERY config.
  const maWins = [200, 210];
  const los = [0.7, 0.8, 0.9];
  const his = [1.4, 1.6, 2.0, 2.4];
  const modes = ["contrarian-long", "contrarian-ls", "momentum-long", "momentum-ls"];
  const configs: Record<string, number | string>[] = [];
  for (const w of maWins) for (const lo of los) for (const hi of his) for (const mode of modes) {
    // contrarian-long only uses lo; momentum-long only uses hi -> dedupe degenerate combos
    if (mode === "contrarian-long" && hi !== his[0]) continue;
    if (mode === "momentum-long" && lo !== los[0]) continue;
    configs.push({ maWin: w, lo, hi, mode });
  }

  const surrFn = surrogateKind === "phase" ? phaseSurrogatePrice : iaaftSurrogatePrice;

  return runGauntlet({
    name: `O7-MAYER (${asset.toUpperCase()}) surrogate=${surrogateKind}`,
    P,
    configs,
    canonical: { maWin: 200, lo: 0.8, hi: 2.4, mode: "contrarian-ls" }, // the classic Mayer rule
    buildPosition: (cfg) => buildFromMayer(realPrice, cfg),
    // SURROGATE-RECOMPUTE NULL: rebuild Mayer on a spectrum/vol-preserving surrogate price path,
    // run the identical rule, evaluate on the REAL forward returns (harness does this).
    buildSurrogatePosition: (cfg, rng) => {
      const surPrice = surrFn(realPrice, rng);
      return buildFromMayer(surPrice, cfg);
    },
    startIdx: 230, // > maWin warmup
    nSurr: 300,
  });
}

const results: Record<string, GauntletOutput> = {};
for (const asset of ["btc", "eth"] as const) {
  // primary judgement uses the IAAFT surrogate-recompute null (strongest: spectrum + fat tails)
  const o = runAsset(asset, "iaaft");
  printVerdict(o);
  results[`${asset}_iaaft`] = o;
  // also report the phase-rand surrogate-recompute as a cross-check
  const op = runAsset(asset, "phase");
  console.log(`  [cross-check phase-surrogate] ${asset} surrP=${op.surrogateP.toFixed(4)} bestNetSh=${op.best.netSharpeAnn.toFixed(3)} verdict=${op.verdict}`);
  results[`${asset}_phase`] = op;
}
fs.writeFileSync(`${OUT}/result_mayer.json`, JSON.stringify(results, null, 2));
console.log(`\nwrote ${OUT}/result_mayer.json`);
