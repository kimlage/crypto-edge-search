import {
  loadBars15m,
  dailyCloseFrom15m,
  renkoDirections,
  trailingAtrBrick,
  fixedPctBrick,
} from "./renko_lib.ts";

const bars = loadBars15m();
console.log("bars", bars.length, bars[0].date, "->", bars[bars.length - 1].date);
const close15 = bars.map((b) => b.close);
const { dates, idxLastBarOfDay } = dailyCloseFrom15m(bars);
console.log("days", dates.length, dates[0], "->", dates[dates.length - 1]);

// daily close from last bar of each day
const dailyClose = idxLastBarOfDay.map((i) => close15[i]);
console.log("daily close first", dailyClose[0], "last", dailyClose[dailyClose.length - 1]);

// build a couple of Renko configs on 15m and project to daily direction
for (const cfg of [
  { type: "pct", val: 1.0, rev: 1 },
  { type: "pct", val: 2.0, rev: 1 },
  { type: "atr", win: 96, k: 2, rev: 1 },
  { type: "atr", win: 96, k: 3, rev: 2 },
]) {
  const brick =
    cfg.type === "pct"
      ? fixedPctBrick(close15, cfg.val!)
      : trailingAtrBrick(close15, cfg.win!, cfg.k!);
  const st = renkoDirections(close15, brick, cfg.rev);
  // daily direction at last bar of each day
  let nLong = 0,
    nFlat = 0,
    flips = 0,
    prevDir = 0;
  const dirDaily: number[] = [];
  for (let d = 0; d < dates.length; d++) {
    const dir = st.dirAtBar[idxLastBarOfDay[d]];
    dirDaily.push(dir);
    if (dir > 0) nLong++;
    else nFlat++;
    if (dir !== prevDir) flips++;
    prevDir = dir;
  }
  console.log(
    `cfg ${JSON.stringify(cfg)} bricksUp=${st.nBricksUp} bricksDown=${st.nBricksDown} | dailyLongShare=${(nLong / dates.length).toFixed(3)} flips=${flips}`,
  );
}
