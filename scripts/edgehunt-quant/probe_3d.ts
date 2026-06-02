/**
 * The reversal lives at the SHORT forward horizon (3d), strongest for a 1-week lookback.
 * Build the book at hold=3d (rebalance every 3 days) and check net economics + neutrality.
 * Also try the gentler hold=5d. Annualization uses the actual #periods/year.
 */
import { loadDailyPanel, rebalanceDays, buildBook, BookConfig, mean, sharpePeriod } from "./lib_strev.ts";

const COST = 0.0004;
const panel = loadDailyPanel();

function annFactor(holdDays: number) { return Math.sqrt(365 / holdDays); }

const holds = [3, 5, 7];
const sigWeeksArr = [1, 2];       // lookback in weeks (7d units)
const betaWins = [60];
const quants = [0.2, 0.3];
const weightings: ("equal"|"rank")[] = ["equal", "rank"];
const skips = [false, true];

interface Row { label:string; gross:number; net:number; bb:number; turn:number; n:number; hold:number; }
const rows: Row[] = [];
let nCfg = 0;
for (const hold of holds) {
  const rebal = rebalanceDays(panel, hold, 200);
  const ann = annFactor(hold);
  for (const sigWeeks of sigWeeksArr)
   for (const betaWin of betaWins)
    for (const quantile of quants)
     for (const weighting of weightings)
      for (const skip1d of skips) {
        const cfg: BookConfig = { betaWin, sigWeeks, holdDays: hold, skip1d, quantile, weighting, betaNeutralize: true };
        const r = buildBook(panel, cfg, rebal, COST);
        nCfg++;
        if (r.nRebal < 40) continue;
        rows.push({
          label:`hold=${hold},L=${sigWeeks},q=${quantile},w=${weighting},skip=${skip1d?1:0}`,
          gross: ann*sharpePeriod(r.grossRet), net: ann*sharpePeriod(r.netRet),
          bb: mean(r.longShortBeta), turn: r.turnoverPerRebal, n: r.nRebal, hold,
        });
      }
}
rows.sort((a,b)=>b.net-a.net);
console.log(`configs: ${nCfg}\ntop 15 by NET ann Sharpe (beta-neutral residual reversal):`);
for (const r of rows.slice(0,15))
  console.log(`  net=${r.net.toFixed(3)} gross=${r.gross.toFixed(3)} bookBeta=${r.bb.toFixed(3)} turn=${r.turn.toFixed(2)} n=${r.n} | ${r.label}`);

// best gross to see ceiling
rows.sort((a,b)=>b.gross-a.gross);
console.log(`\ntop 5 by GROSS (ceiling if cost were 0):`);
for (const r of rows.slice(0,5))
  console.log(`  gross=${r.gross.toFixed(3)} net=${r.net.toFixed(3)} turn=${r.turn.toFixed(2)} | ${r.label}`);
