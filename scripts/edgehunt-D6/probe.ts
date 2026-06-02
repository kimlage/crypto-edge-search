/**
 * D6-M4 grounding probe. Establish the raw relationship between DFII10
 * (10Y TIPS real yield) changes and BTC returns under STRICT t-1 causality.
 *
 * Signal (known at close t-1): change in real yield over a lookback window.
 * Belief: FALLING real yields -> long BTC; RISING -> reduce/short.
 * So position_t = -sign(dYield) (or scaled), realized over t-1 -> t.
 */
import { loadPanel, sharpe, annReturn, ANN } from "./load_data";

const panel = loadPanel();
console.log(
  `panel rows=${panel.length} ${panel[0].date}..${panel[panel.length - 1].date}`,
);
console.log(
  `yield range last=${panel[panel.length - 1].dfii10} first=${panel[0].dfii10}`,
);

const ret = panel.map((r) => r.btcRet);
const bh = sharpe(ret);
console.log(`\nBuy&hold BTC: annSharpe=${bh.toFixed(3)} annRet=${(annReturn(ret) * 100).toFixed(1)}%`);

// Build yield-change signals at various lookbacks. dYield_t = yield[t-1]-yield[t-1-L]
// (strictly known at t-1). Position for return_t.
function dYield(i: number, L: number): number | null {
  // i indexes panel; return_t is panel[i].btcRet. Signal uses yields up to t-1.
  // panel[i-1].dfii10 is the level at close t-1. panel[i-1-L] is L days earlier.
  const a = panel[i - 1]?.dfii10;
  const b = panel[i - 1 - L]?.dfii10;
  if (a == null || b == null) return null;
  return a - b;
}

console.log("\n=== Correlation: dYield(t-1, L) vs btcRet(t) ===");
for (const L of [1, 5, 10, 20, 40, 60]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = L + 1; i < panel.length; i++) {
    const d = dYield(i, L);
    if (d == null) continue;
    xs.push(d);
    ys.push(panel[i].btcRet);
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0,
    vx = 0,
    vy = 0;
  for (let k = 0; k < n; k++) {
    cov += (xs[k] - mx) * (ys[k] - my);
    vx += (xs[k] - mx) ** 2;
    vy += (ys[k] - my) ** 2;
  }
  const corr = cov / Math.sqrt(vx * vy);
  console.log(`  L=${L}: corr(dYield, ret_next)=${corr.toFixed(4)} n=${n}`);
}

// Strategy variants. Position = -sign(dYield) when |dYield|>thr (long-only & long/short)
console.log("\n=== Continuous timer: long when yields falling ===");
for (const L of [5, 10, 20, 40, 60]) {
  // long-only: long when dYield<0 else flat
  const longOnly: number[] = [];
  const longShort: number[] = [];
  for (let i = L + 1; i < panel.length; i++) {
    const d = dYield(i, L);
    if (d == null) continue;
    const r = panel[i].btcRet;
    longOnly.push(d < 0 ? r : 0);
    longShort.push(d < 0 ? r : -r);
  }
  console.log(
    `  L=${L}: longOnly Sharpe=${sharpe(longOnly).toFixed(3)} ret=${(annReturn(longOnly) * 100).toFixed(1)}%  |  longShort Sharpe=${sharpe(longShort).toFixed(3)} ret=${(annReturn(longShort) * 100).toFixed(1)}%`,
  );
}

// Level-based: long when real yield LOW (cheap money). Use rolling median split.
console.log("\n=== Level timer: long when real yield below rolling median ===");
for (const W of [60, 120, 250]) {
  const longOnly: number[] = [];
  for (let i = W + 1; i < panel.length; i++) {
    const hist: number[] = [];
    for (let k = i - W; k < i; k++) {
      const y = panel[k].dfii10;
      if (y != null) hist.push(y);
    }
    const sorted = [...hist].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const yPrev = panel[i - 1].dfii10!;
    const r = panel[i].btcRet;
    longOnly.push(yPrev < med ? r : 0);
  }
  console.log(
    `  W=${W}: belowMedian-long Sharpe=${sharpe(longOnly).toFixed(3)} ret=${(annReturn(longOnly) * 100).toFixed(1)}%`,
  );
}

// Regime breakdown: how many distinct yield up/down regimes? (honest N driver)
console.log("\n=== Regime structure (sign of 20d yield change) ===");
{
  const L = 20;
  let flips = 0;
  let prevSign = 0;
  let regimeDays = 0;
  const regimeLengths: number[] = [];
  for (let i = L + 1; i < panel.length; i++) {
    const d = dYield(i, L);
    if (d == null) continue;
    const s = d < 0 ? -1 : 1;
    if (s !== prevSign) {
      if (prevSign !== 0) regimeLengths.push(regimeDays);
      flips++;
      prevSign = s;
      regimeDays = 0;
    }
    regimeDays++;
  }
  const avgLen =
    regimeLengths.reduce((a, b) => a + b, 0) / Math.max(1, regimeLengths.length);
  console.log(
    `  sign flips=${flips}, distinct regimes~${regimeLengths.length}, avg regime len=${avgLen.toFixed(0)}d`,
  );
}
