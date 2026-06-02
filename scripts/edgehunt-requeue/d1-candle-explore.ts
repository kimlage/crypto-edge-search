import { loadBTC, DETECTOR_NAMES, buildPosition, runPositions, annSharpe, sharpeDaily, type Cfg } from "./d1-candle-harness.ts";

const b = loadBTC();
const T = b.close.length;
const start = 30; const endIS = Math.floor((T - 1 - start) * 0.8) + start; // in-sample only (avoid peeking holdout)

const patterns = ["all", ...DETECTOR_NAMES];
const trendWins = [10, 20, 50];
const holds = [1, 2, 3, 5];
const dirs = ["both", "long", "contrarian"];

interface Row { label: string; netSh: number; nSig: number; turn: number; }
const rows: Row[] = [];
for (const pattern of patterns)
  for (const trendWin of trendWins)
    for (const hold of holds)
      for (const dir of dirs) {
        const cfg: Cfg = { pattern, trendWin, hold, dir };
        const pos = buildPosition(b, cfg);
        const res = runPositions(b, pos, start, endIS);
        if (res.nSignalDays < 20) continue; // honest: skip degenerate-N configs in the grid
        rows.push({ label: `${pattern}|tw${trendWin}|h${hold}|${dir}`, netSh: annSharpe(sharpeDaily(res.dailyNet)), nSig: res.nSignalDays, turn: res.turnover });
      }

rows.sort((a, c) => c.netSh - a.netSh);
console.log(`Explored ${patterns.length}x${trendWins.length}x${holds.length}x${dirs.length} = ${patterns.length * trendWins.length * holds.length * dirs.length} configs; ${rows.length} non-degenerate (nSig>=20).`);
console.log(`In-sample window [${start},${endIS}) = ${endIS - start} days (${b.dates[start]} -> ${b.dates[endIS]})\n`);
console.log("TOP 15 by in-sample net Sharpe:");
for (const r of rows.slice(0, 15)) console.log(`  ${r.label.padEnd(34)} netSh=${r.netSh.toFixed(3)} nSig=${r.nSig} turn=${r.turn.toFixed(3)}`);
console.log("\nBOTTOM 5:");
for (const r of rows.slice(-5)) console.log(`  ${r.label.padEnd(34)} netSh=${r.netSh.toFixed(3)} nSig=${r.nSig}`);
