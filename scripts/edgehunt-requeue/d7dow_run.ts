/** D7-DOW gauntlet run on BTC (primary) with the calendar-reanchor null. */
import { loadDaily, allSignConfigs, runDowGauntlet, printDow } from "./d7dow_harness.ts";

const asset = process.argv[2] ?? "BTC";
const S = loadDaily(asset);
// warmup: none needed (weekday is exogenous). startIdx = 0.
const startIdx = 0;
const configs = allSignConfigs(); // 3^7-1 = 2186 honest configs
// canonical pre-registered: classic "Monday effect" long-Monday-only (the literature claim)
const canonical = [0, 1, 0, 0, 0, 0, 0]; // long Mon only

const o = runDowGauntlet({ name: `D7-DOW ${asset} (3-sign, calendar-reanchor)`, S, configs, canonical, startIdx, nSurr: 500 });
printDow(o);
