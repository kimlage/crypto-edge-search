import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadBars,
  positionsFor,
  runStrategy,
  evalWindow,
  sharpeOf,
  type Family,
} from "./lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const bars = loadBars(resolve(ROOT, "output/bigquery/btc_ohlcv_15m.ndjson"));
const closes = bars.map((b) => b.close);
const cost = 0.0004;

// Verify fast evalWindow == slow positionsFor+runStrategy on several windows.
const families: Family[] = ["donchian", "bollinger", "rsi"];
const params: Record<Family, number> = { donchian: 48, bollinger: 64, rsi: 16 };

let maxErr = 0;
let maxSharpeErr = 0;
for (const fam of families) {
  const p = params[fam];
  // a few windows across the series
  for (const [tradeStart, tradeEnd] of [
    [5000, 9000],
    [120000, 124000],
    [250000, 254000],
  ] as [number, number][]) {
    // slow path: positions over WHOLE series, then runStrategy over the window
    const slowPos = positionsFor(fam, closes, p);
    const slow = runStrategy(closes, slowPos, cost, tradeStart, tradeEnd);
    // fast path
    const fast = evalWindow(fam, closes, p, tradeStart, tradeEnd, cost, true);
    // compare arrays
    if (slow.netReturns.length !== fast.netReturns.length) {
      console.log(`LENGTH MISMATCH ${fam} [${tradeStart},${tradeEnd}): slow=${slow.netReturns.length} fast=${fast.netReturns.length}`);
      continue;
    }
    let err = 0;
    for (let i = 0; i < slow.netReturns.length; i += 1) {
      err = Math.max(err, Math.abs(slow.netReturns[i] - fast.netReturns[i]));
    }
    const sErr = Math.abs(sharpeOf(slow.netReturns) - sharpeOf(fast.netReturns));
    maxErr = Math.max(maxErr, err);
    maxSharpeErr = Math.max(maxSharpeErr, sErr);
    console.log(
      `${fam.padEnd(10)} [${tradeStart},${tradeEnd}) maxAbsErr=${err.toExponential(2)} ` +
        `sharpeErr=${sErr.toExponential(2)} changeEvents slow=${slow.changeEvents} fast=${fast.changeEvents}`,
    );
  }
}
console.log(`\nGLOBAL maxAbsErr=${maxErr.toExponential(3)} maxSharpeErr=${maxSharpeErr.toExponential(3)}`);
console.log(maxErr < 1e-9 && maxSharpeErr < 1e-9 ? "PASS (breakouts exact)" : "RSI seed differs (expected small); check magnitude");

// timing of one full WF config with fast path
import { runWalkForward, pickBest } from "./engine";
import { mulberry32 } from "./lib";
const searchEnd = Math.floor(closes.length * 0.82);
const t1 = Date.now();
const wf = runWalkForward(closes, { family: "donchian", trainBars: 4000, oosBars: 1000 }, 0, searchEnd, cost, pickBest, mulberry32(1));
console.log(`\nFAST one donchian WF: ${Date.now() - t1}ms, oosBars=${wf.netReturns.length}, steps=${wf.stepBars.length}, changeEvents=${wf.changeEvents}`);
