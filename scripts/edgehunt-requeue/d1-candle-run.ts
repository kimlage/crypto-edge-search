import { loadBTC, DETECTOR_NAMES, buildPosition, runPositions, annSharpe, sharpeDaily, runGauntlet, printVerdict, type Cfg } from "./d1-candle-harness.ts";

const b = loadBTC();
const T = b.close.length;
const start = 50; // warmup for trendWin up to 50

// HONEST N: every config we SCORE counts. We pre-register the full grid below.
const patterns = ["all", ...DETECTOR_NAMES]; // 8
const trendWins = [10, 20, 50];
const holds = [1, 2, 3, 5];
const dirs = ["both", "long", "contrarian"];

const configs: Cfg[] = [];
for (const pattern of patterns)
  for (const trendWin of trendWins)
    for (const hold of holds)
      for (const dir of dirs) {
        const cfg: Cfg = { pattern, trendWin, hold, dir };
        // honest-N filter: only keep configs that trade meaningfully over the full sample so the
        // grid isn't padded with degenerate near-zero-signal books. We still COUNT all kept.
        const res = runPositions(b, buildPosition(b, cfg), start, T - 1);
        if (res.nSignalDays < 30) continue;
        configs.push(cfg);
      }

// canonical pre-registered config: the classic textbook claim — engulfing+hammer+star reversal,
// 20-day trend context, 1-day hold, trade BOTH directions in the textbook (reversal) direction.
const canonical: Cfg = { pattern: "all", trendWin: 20, hold: 1, dir: "both" };

console.log(`Honest N (non-degenerate configs scored) = ${configs.length}`);
const out = runGauntlet(b, configs, canonical, start, { holdoutFrac: 0.2, nSurr: 300 });
printVerdict(out);

// extra context: show the best book's exposure profile to expose any long-beta confound
const best = out.best.cfg;
const pos = buildPosition(b, best);
const span = T - 1 - start;
const split = start + Math.floor(span * 0.8);
const inIS = runPositions(b, pos, start, split);
const oos = runPositions(b, pos, split, T - 1);
console.log(`\n[confound check] best=${out.best.label}`);
console.log(`  IS exposure=${inIS.exposure.toFixed(3)} longShare=${inIS.longShare.toFixed(3)} turnover=${inIS.turnover.toFixed(3)}`);
console.log(`  OOS netSharpe=${annSharpe(sharpeDaily(oos.dailyNet)).toFixed(3)} exposure=${oos.exposure.toFixed(3)} longShare=${oos.longShare.toFixed(3)}`);
console.log(`  pPlacebo(base-rate)=${out.pPlacebo.toFixed(4)} pPhase(spectrum)=${out.pPhase.toFixed(4)}`);
