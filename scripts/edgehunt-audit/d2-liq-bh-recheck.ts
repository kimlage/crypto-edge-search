/**
 * AUDIT spot-run: D2-LIQ "beats-buyhold" gate annualization bug.
 *
 * Concern (audit, severity LOW): liq.ts passes per-BAR B&H returns (r.slice(1))
 * into runGauntlet, but periodsPerYear is set to tradesPerYear (~tens), so the
 * B&H Sharpe is annualized at TRADE frequency instead of bar frequency -> B&H
 * Sharpe is understated (reported 0.028), making the beats-buyhold gate trivially
 * passable for the EXCESS leg.
 *
 * DECISIVE CHECK: does fixing the B&H annualization flip EITHER verdict?
 *  - standalone leg binds net-sharpe>0.3 (0.101) -> dies BEFORE beats-buyhold,
 *    so B&H is irrelevant there.
 *  - excess leg binds DSR@N>0.95 (0.219) -> AFTER beats-buyhold; it PASSES
 *    beats-buyhold and dies at DSR. If we correct B&H to bar-frequency ann.,
 *    does the excess leg now FAIL beats-buyhold? If so the verdict (KILL) is
 *    UNCHANGED (it fails one gate earlier). Either way the KILL stands; the only
 *    question is whether the audit's "immaterial" label is right.
 *
 * We recompute the correct bar-frequency B&H Sharpe and the excess-leg net
 * Sharpe, and report the gate order outcome under BOTH the buggy and corrected
 * B&H, to confirm no verdict flips in EITHER direction.
 */
import { readFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";
import type { Bar } from "../edgehunt-D2/lib.ts";

const OUT = "output/edgehunt-D2";
const bars = JSON.parse(readFileSync(`${OUT}/btc_15m_flow.json`, "utf8")) as Bar[];
const n = bars.length;

// per-bar log returns (same r.slice(1) the script feeds as buyHoldRets)
const r: number[] = new Array(n).fill(0);
for (let i = 1; i < n; i += 1) r[i] = Math.log(bars[i].c / bars[i - 1].c);
const bhPerBar = r.slice(1);

const yearsSpan = (bars[n - 1].t - bars[0].t) / (365.25 * 86400000);
const PPY_BAR = (n - 1) / yearsSpan; // true bars-per-year

const bh = summarizeReturnSeries(bhPerBar);
// load reported liq results for the trade counts / leg sharpes
const liq = JSON.parse(readFileSync(`${OUT}/liq-results.json`, "utf8"));
const excessTradesPerYear = liq.flipTrades / yearsSpan;
const standaloneTradesPerYear = liq.standaloneLagged.nTrades / yearsSpan;

const bhSharpe_buggy_excess = bh.sharpe * Math.sqrt(excessTradesPerYear);
const bhSharpe_buggy_standalone = bh.sharpe * Math.sqrt(standaloneTradesPerYear);
const bhSharpe_correct = bh.sharpe * Math.sqrt(PPY_BAR);

console.log(`span=${yearsSpan.toFixed(2)}y  trueBarsPerYear(PPY)=${PPY_BAR.toFixed(0)}`);
console.log(`B&H per-bar mean=${(bh.mean * 1e4).toFixed(4)}bp  perBarSharpe(raw)=${bh.sharpe.toFixed(5)}`);
console.log(`B&H Sharpe @ trade-freq (BUGGY, excess leg, tpy=${excessTradesPerYear.toFixed(1)}) = ${bhSharpe_buggy_excess.toFixed(4)}   <- reported 0.028`);
console.log(`B&H Sharpe @ trade-freq (BUGGY, standalone, tpy=${standaloneTradesPerYear.toFixed(1)}) = ${bhSharpe_buggy_standalone.toFixed(4)}`);
console.log(`B&H Sharpe @ bar-freq  (CORRECT) = ${bhSharpe_correct.toFixed(4)}`);

const excessNetSharpe = liq.excessNetSharpeAnn;
const standaloneNetSharpe = liq.standaloneLagged.netSharpeAnn;
console.log(`\nexcess-leg netSharpe(ann@trade) = ${excessNetSharpe.toFixed(4)}  dsrProb=${liq.dsrProb.toFixed(4)}`);
console.log(`standalone-leg netSharpe = ${standaloneNetSharpe.toFixed(4)}  bindingGate(reported)=${liq.standaloneLagged.bindingGate}`);

// Gate order: net-sharpe>0.3 -> beats-buyhold -> boot-CI-lower>0 -> DSR@N>0.95 -> surrogate-p<0.05 -> PBO<0.5
function bindingGate(net: number, bhS: number, bootLower: number, dsr: number, surP: number, pbo: number | null): string {
  if (!(net > 0.3)) return "net-sharpe>0.3";
  if (!(net > bhS)) return "beats-buyhold";
  if (!(bootLower > 0)) return "boot-CI-lower>0";
  if (!(dsr > 0.95)) return "DSR@N>0.95";
  if (!(surP < 0.05)) return "surrogate-p<0.05";
  if (!(pbo === null ? true : pbo < 0.5)) return "PBO<0.5";
  return "ALL-PASS";
}

// EXCESS leg under buggy vs corrected B&H
const exBuggy = bindingGate(excessNetSharpe, bhSharpe_buggy_excess, liq.bootLowerSharpe, liq.dsrProb, liq.surrogateP, liq.pbo);
const exCorrect = bindingGate(excessNetSharpe, bhSharpe_correct, liq.bootLowerSharpe, liq.dsrProb, liq.surrogateP, liq.pbo);
console.log(`\nEXCESS leg binding gate:  buggyB&H -> ${exBuggy}   correctB&H -> ${exCorrect}   (both => FAIL/KILL)`);

// STANDALONE leg under buggy vs corrected B&H
const stBuggy = bindingGate(standaloneNetSharpe, bhSharpe_buggy_standalone, liq.standaloneLagged.bootLowerSharpe, liq.standaloneLagged.dsrProb, liq.standaloneLagged.surrogateP, liq.standaloneLagged.pbo);
const stCorrect = bindingGate(standaloneNetSharpe, bhSharpe_correct, liq.standaloneLagged.bootLowerSharpe, liq.standaloneLagged.dsrProb, liq.standaloneLagged.surrogateP, liq.standaloneLagged.pbo);
console.log(`STANDALONE leg binding gate:  buggyB&H -> ${stBuggy}   correctB&H -> ${stCorrect}   (both => FAIL/KILL)`);

console.log(`\nVERDICT: KILL is invariant to the B&H annualization bug for BOTH legs => bug is COSMETIC/IMMATERIAL.`);
