/**
 * Exploratory probe for Q4-STREV: does the weekly residual-reversal book have ANY gross edge,
 * and is it actually beta-neutral? Scan a small honest grid; report gross/net annualized Sharpe,
 * mean book beta, turnover, names. Weekly => annualization factor sqrt(52).
 */
import {
  loadDailyPanel, rebalanceDays, buildBook, BookConfig, mean, std, sharpePeriod,
} from "./lib_strev.ts";

const COST_PER_SIDE = 0.0004; // 4 bps taker
const ANN = Math.sqrt(52);    // weekly periods

const panel = loadDailyPanel();
console.log(`panel: ${panel.assets.length} assets, ${panel.dates.length} days, ${panel.dates[0]}..${panel.dates[panel.dates.length-1]}`);

const HOLD = 7;
const WARMUP = 200; // need long beta windows + signal lookback
const rebal = rebalanceDays(panel, HOLD, WARMUP);
console.log(`rebalance weeks: ${rebal.length} (${panel.dates[rebal[0]]}..${panel.dates[rebal[rebal.length-1]]})\n`);

const betaWins = [30, 60, 90];
const sigWeeksArr = [1, 2, 4];
const skips = [false, true];
const quantiles = [0.2, 0.3];
const weightings: ("equal" | "rank")[] = ["equal", "rank"];

interface Row { label: string; gross: number; net: number; bookBeta: number; turn: number; names: number; n: number; bn: boolean; }
const rows: Row[] = [];

function run(cfg: BookConfig, tag: string) {
  const r = buildBook(panel, cfg, rebal, COST_PER_SIDE);
  if (r.nRebal < 30) return;
  const gross = ANN * sharpePeriod(r.grossRet);
  const net = ANN * sharpePeriod(r.netRet);
  rows.push({
    label: tag, gross, net,
    bookBeta: mean(r.longShortBeta), turn: r.turnoverPerRebal, names: r.meanNames, n: r.nRebal,
    bn: cfg.betaNeutralize,
  });
}

let nConfigs = 0;
for (const betaNeutralize of [true, false]) {
  for (const betaWin of betaWins) {
    if (!betaNeutralize && betaWin !== betaWins[0]) continue; // beta window irrelevant when not neutralizing
    for (const sigWeeks of sigWeeksArr)
      for (const skip1d of skips)
        for (const quantile of quantiles)
          for (const weighting of weightings) {
            const cfg: BookConfig = { betaWin, sigWeeks, holdDays: HOLD, skip1d, quantile, weighting, betaNeutralize };
            run(cfg, `bn=${betaNeutralize?1:0},bw=${betaWin},L=${sigWeeks},skip=${skip1d?1:0},q=${quantile},w=${weighting}`);
            nConfigs++;
          }
  }
}

rows.sort((a, b) => b.net - a.net);
console.log(`configs evaluated (honest N candidate): ${nConfigs}\n`);
console.log("top 12 by NET ann Sharpe:");
for (const r of rows.slice(0, 12)) {
  console.log(`  net=${r.net.toFixed(3)} gross=${r.gross.toFixed(3)} bookBeta=${r.bookBeta.toFixed(3)} turn=${r.turn.toFixed(2)} names=${r.names.toFixed(1)} n=${r.n} | ${r.label}`);
}
console.log("\nbottom 5 by NET:");
for (const r of rows.slice(-5)) {
  console.log(`  net=${r.net.toFixed(3)} gross=${r.gross.toFixed(3)} bookBeta=${r.bookBeta.toFixed(3)} | ${r.label}`);
}

// neutrality summary: beta-neutralized configs vs raw
const bn = rows.filter(r => r.bn), raw = rows.filter(r => !r.bn);
console.log(`\nbeta-neutral configs: mean|bookBeta|=${mean(bn.map(r=>Math.abs(r.bookBeta))).toFixed(3)} meanGross=${mean(bn.map(r=>r.gross)).toFixed(3)} meanNet=${mean(bn.map(r=>r.net)).toFixed(3)}`);
console.log(`raw (no residualize): mean|bookBeta|=${mean(raw.map(r=>Math.abs(r.bookBeta))).toFixed(3)} meanGross=${mean(raw.map(r=>r.gross)).toFixed(3)} meanNet=${mean(raw.map(r=>r.net)).toFixed(3)}`);
