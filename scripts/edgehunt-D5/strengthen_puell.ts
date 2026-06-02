/**
 * D5-09 Puell — STRONGEST honest strengthening attempt, judged by the committed gauntlet.
 *
 * The probe showed: (a) the canonical "short high Puell" leg is value-destroying (high Puell precedes
 * GAINS, not losses — bull momentum); (b) low-Puell forward returns are non-monotone (Puell<=0.6 is
 * NEGATIVE); only the tiny n=57 Puell<=0.4 bucket looks good (early-data fluke). (c) Puell is 93%
 * correlated with the Mayer multiple. So the honest strengthening is NOT to add shorts — it is to
 * give the bottom-buy thesis its best, least-degenerate shot and hold longer:
 *
 *   - "buy-and-hold-the-recovery": go long when Puell crosses up through a low band (miner stress
 *     ending) and HOLD for H days (so the book is not a 1-day empty lottery), flat otherwise.
 *   - also re-test a wider buy grid + a "low-Puell -> long, high-Puell -> flat" persistent regime.
 *
 * Honest N counts EVERY config here. We run it through the same runGauntlet (net-of-cost, baselines,
 * DSR@N, CPCV/PBO, Harvey-Liu, phase-randomized surrogate = Mayer price-only control, holdout).
 */
import fs from "node:fs";
import { loadPanel, runGauntlet, printVerdict, ema, sma, type Panel, type GauntletOutput } from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const LAG = 1;
const OUT = "output/edgehunt-D5";
function lag(x: number[], k: number): number[] { const o = new Array(x.length).fill(NaN); for (let i=k;i<x.length;i++) o[i]=x[i-k]; return o; }

function buildPuell(P: Panel): number[] {
  const issNtv = P.supply.map((s, t) => t>0 && Number.isFinite(s) && Number.isFinite(P.supply[t-1]) ? Math.max(0, s-P.supply[t-1]) : NaN);
  const issUSD = issNtv.map((v, t) => Number.isFinite(v) && P.price[t]>0 ? v*P.price[t] : NaN);
  const issUSDsm = ema(issUSD, 7);
  const ma365 = sma(issUSDsm, 365);
  return issUSDsm.map((v, t) => Number.isFinite(v) && Number.isFinite(ma365[t]) && ma365[t]>0 ? v/ma365[t] : NaN);
}

function puellStrong(P: Panel): GauntletOutput {
  const puellL = lag(buildPuell(P), LAG);
  // Strengthened honest grid:
  //   buy band in {0.5,0.6,0.7,0.8}  (avoid the n=57 0.4 fluke; give a tradable sample)
  //   hold H in {5,20,60} days after a long trigger (recovery-hold, not 1-day lottery)
  //   regime variant: persistent long while Puell<=buy (accumulation zone) vs trigger-and-hold
  //   side stays LONG-ONLY (probe proved shorting high Puell is value-destroying)
  const buys = [0.5, 0.6, 0.7, 0.8];
  const holds = [5, 20, 60];
  const modes = ["holdN", "persist"]; // holdN: long for H days after entering band; persist: long while in band
  const configs: Record<string, number | string>[] = [];
  for (const b of buys) for (const h of holds) for (const m of modes) configs.push({ buy: b, hold: h, mode: m });

  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const pu = sig ?? puellL;
    const b = cfg.buy as number, h = cfg.hold as number, mode = cfg.mode as string;
    const pos = new Array(P.price.length).fill(NaN);
    let hold = 0;
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(pu[t])) { pos[t] = NaN; continue; }
      if (mode === "persist") {
        pos[t] = pu[t] <= b ? 1 : 0;
      } else {
        // holdN: when in the low band, (re)arm a H-day long hold
        if (pu[t] <= b) hold = h;
        pos[t] = hold > 0 ? 1 : 0;
        if (hold > 0) hold--;
      }
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-09 Puell STRENGTHENED long-only recovery (BTC)",
    P,
    configs,
    canonical: { buy: 0.6, hold: 20, mode: "holdN" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(puellL, rng)),
    startIdx: 800,
  });
}

const P = loadPanel("btc");
const o = puellStrong(P);
printVerdict(o);
fs.writeFileSync(`${OUT}/result_puell_strong.json`, JSON.stringify(o, null, 2));
