/**
 * NF2 ATTRIBUTION — is the (gross) real-vs-surrogate gap from the ENTRY or the BRACKET?
 *
 * Diagnostic B found that two brackets (1:3 R:R, trailing) have a GROSS bracket
 * Sharpe on real BTC that exceeds the driftless/phase surrogate null (placeboP<0.05),
 * even though NET of 8bps cost every bracket is negative. The honest follow-up: is
 * that gross structure created by the BRACKET, or is it just the momentum the
 * BREAKOUT ENTRY already carried (which a trailing stop / far target merely lets run)?
 *
 * We answer by running the SAME real-vs-surrogate permutation test on the
 * UN-BRACKETED fixed-horizon hold of the same entry. If the un-bracketed entry is
 * ALSO distinguishable from the surrogate null, the structure lives in the ENTRY
 * (trend persistence), and the bracket only RESHAPES it — confirming the keyInsight.
 */

import { writeFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/statistical-validation";
import { phaseRandomize } from "../../src/lib/validation/strategy-validator";
import {
  loadBars,
  seeded,
  breakoutEntries,
  runFixedHorizon,
  gbmSurrogateBars,
  type Bar,
} from "./bracket-engine";

const DATA = "<repo>";
const OUT = "<repo>";
const ROUND_TRIP = 0.0008;
const WINDOW_BARS = 96 * 365 * 3;
const LOOKBACK = 96;
const DRAWS = 60;

function phaseBars(real: Bar[], rng: () => number): Bar[] {
  const lr: number[] = [];
  for (let i = 1; i < real.length; i += 1) lr.push(Math.log(real[i].close / real[i - 1].close));
  const surr = phaseRandomize(lr, rng);
  const out: Bar[] = [{ ...real[0] }];
  let price = real[0].close;
  for (let i = 0; i < surr.length; i += 1) {
    const open = price;
    const close = open * Math.exp(surr[i]);
    out.push({ t: real[i + 1].t, open, high: Math.max(open, close), low: Math.min(open, close), close });
    price = close;
  }
  return out;
}

function main(): void {
  console.log("=== NF2 ATTRIBUTION — entry momentum vs bracket reshaping (gross, un-bracketed) ===\n");
  const all = loadBars(DATA);
  const bars = all.slice(Math.max(0, all.length - WINDOW_BARS));
  const breakout = breakoutEntries(bars, LOOKBACK);

  const rows: Record<string, unknown>[] = [];
  for (const hold of [24, 48, 96]) {
    const real = runFixedHorizon(bars, breakout, hold);
    const realSharpe = summarizeReturnSeries(real.perTrade).sharpe;
    const realNetSharpe = summarizeReturnSeries(real.perTrade.map((r) => r - ROUND_TRIP)).sharpe;

    const surr: number[] = [];
    for (let d = 0; d < DRAWS; d += 1) {
      const sbars = d % 2 === 0 ? gbmSurrogateBars(bars, seeded(`attr-gbm-${hold}-${d}`)) : phaseBars(bars, seeded(`attr-ph-${hold}-${d}`));
      const sEnt = breakoutEntries(sbars, LOOKBACK);
      const sRun = runFixedHorizon(sbars, sEnt, hold);
      if (sRun.tradeCount >= 30) surr.push(summarizeReturnSeries(sRun.perTrade).sharpe);
    }
    const ge = surr.filter((s) => s >= realSharpe).length;
    const placeboP = surr.length > 0 ? ge / surr.length : 1;
    const surrMean = surr.reduce((s, v) => s + v, 0) / Math.max(1, surr.length);
    console.log(
      `  UN-BRACKETED hold=${String(hold).padStart(3)}bar  grossShrp=${realSharpe.toFixed(4).padStart(8)} ` +
        `surrMean=${surrMean.toFixed(4).padStart(8)} placeboP=${placeboP.toFixed(3)}  ` +
        `NET grossSharpe=${realNetSharpe.toFixed(4)} (n_surr=${surr.length})`,
    );
    rows.push({ hold, grossSharpe: realSharpe, netSharpe: realNetSharpe, surrMean, placeboP, surrN: surr.length });
  }

  const entryHasStructure = rows.some((r) => (r.placeboP as number) < 0.05);
  console.log(
    `\n  The UN-BRACKETED breakout entry is ${entryHasStructure ? "ALSO" : "NOT"} distinguishable from the surrogate null.`,
  );
  console.log(
    entryHasStructure
      ? "  => The gross real-vs-surrogate gap lives in the ENTRY (breakout momentum / trend persistence).\n" +
          "  => Brackets only RESHAPE that pre-existing entry structure (variance/skew); they do not create it.\n" +
          "  => And NET of 8bps cost it is negative either way — not exploitable. keyInsight CONFIRMED."
      : "  => The entry alone is indistinguishable from noise; the gross gap (if any) is bracket-induced.",
  );

  writeFileSync(
    `${OUT}/nf2-attribution.json`,
    JSON.stringify({ track: "NF2-attribution", generatedAt: new Date().toISOString(), rows, entryHasStructure }, null, 2),
  );
  console.log(`\nWrote ${OUT}/nf2-attribution.json`);
}

main();
