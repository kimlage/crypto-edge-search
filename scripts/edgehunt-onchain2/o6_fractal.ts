/**
 * O6-FRACTAL — Williams fractals / swing-structure breakout (daily BTC).
 *
 * Belief: A 5-bar Williams fractal marks a confirmed swing high/low. Trading breakouts of the
 * most-recent confirmed fractal levels ("trade the fractals", Williams 1995/2011 + Bill Williams'
 * Trading Chaos) captures trend continuation / structure.
 *
 * Mechanism encoded (strictly causal, strictly lagged):
 *   - Up-fractal: high[t-2] is the local max of the 5-bar window high[t-4..t].
 *     A fractal centered at bar k is only CONFIRMED at bar k+2 (you need the two later bars).
 *     => at close of day t we may only use fractals centered at <= t-2 (confirmed at <= t).
 *   - Down-fractal: symmetric on lows.
 *   - State machine (canonical Williams swing breakout):
 *       * track the most-recent confirmed up-fractal high (resistance) and down-fractal low (support)
 *       * go LONG when close[t] > last confirmed up-fractal high
 *       * go FLAT (or SHORT in the long/short variant) when close[t] < last confirmed down-fractal low
 *       * else hold previous position
 *   - Position is set at close t from info known at close t; we earn fwdRet[t] (close t -> t+1).
 *
 * NULL (the right one): "random-level placebo" — keep the EXACT same price path and the same
 * breakout state-machine, but replace the fractal-derived levels with RANDOM horizontal levels
 * drawn from the trailing price range (matched scale/regime). If fractal structure carries no
 * edge beyond an arbitrary horizontal line, the placebo reproduces the Sharpe. We also run a
 * phase-randomized price-path surrogate as a secondary null (vol/structure-preserving).
 *
 * Gauntlet: reuse the COMMITTED runGauntlet() from scripts/edgehunt-D5/harness.ts which wires
 * net-of-cost (4bps/side), baselines (buy&hold / random-lottery), Deflated Sharpe @ honest N,
 * block-bootstrap CI, CPCV/PBO, Harvey-Liu Bonferroni haircut, surrogate placebo, consume-once
 * forward holdout (last 20%).
 */
import fs from "node:fs";
import {
  type Panel,
  runGauntlet,
  printVerdict,
  mkRng,
  annSharpe,
  sharpeDaily,
  runPositions,
  mean,
} from "../edgehunt-D5/harness.ts";

const ROOT = ".";

// ---------------------------------------------------------------- OHLC load
interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
function loadBars(): Bar[] {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8"));
  const bars: Bar[] = j
    .map((r: any) => ({
      date: r.date,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    }))
    .filter((b: Bar) => b.high > 0 && b.low > 0 && b.close > 0 && b.high >= b.low);
  bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return bars;
}

// Build a Panel-compatible object (close = price; fwdRet close->close) plus side OHLC arrays.
interface FractalPanel extends Panel {
  high: number[];
  low: number[];
  open: number[];
}
function buildPanel(bars: Bar[]): FractalPanel {
  const T = bars.length;
  const P: any = {
    asset: "btc",
    dates: bars.map((b) => b.date),
    price: bars.map((b) => b.close),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    open: bars.map((b) => b.open),
    mvrv: new Array(T).fill(NaN),
    flowInNtv: new Array(T).fill(NaN),
    flowOutNtv: new Array(T).fill(NaN),
    adr: new Array(T).fill(NaN),
    marketCap: new Array(T).fill(NaN),
    hashRate: new Array(T).fill(NaN),
    supply: new Array(T).fill(NaN),
    realizedCap: new Array(T).fill(NaN),
    realizedPrice: new Array(T).fill(NaN),
    fwdRet: [] as number[],
  };
  for (let t = 0; t < T; t++) {
    P.fwdRet.push(t + 1 < T ? Math.log(P.price[t + 1] / P.price[t]) : NaN);
  }
  return P as FractalPanel;
}

// ---------------------------------------------------------------- fractal detection
//
// Generic n-bar fractal: half-window h = (n-1)/2. A bar centered at index c is an up-fractal if
// high[c] is strictly the max over [c-h, c+h]; confirmed at bar c+h.  (n=5 => h=2.)
// Returns, for each day t, the level of the MOST-RECENT up-fractal CONFIRMED at or before t,
// and similarly for down-fractals. Strictly causal: confirmedAtUp[t] uses only fractals whose
// confirmation bar c+h <= t.
function fractalLevels(
  high: number[],
  low: number[],
  half: number,
): { upLevel: number[]; dnLevel: number[] } {
  const T = high.length;
  const upLevel = new Array(T).fill(NaN);
  const dnLevel = new Array(T).fill(NaN);
  // precompute up/down fractal centers
  const isUp: boolean[] = new Array(T).fill(false);
  const isDn: boolean[] = new Array(T).fill(false);
  for (let c = half; c < T - half; c++) {
    let up = true;
    let dn = true;
    for (let k = c - half; k <= c + half; k++) {
      if (k === c) continue;
      if (high[k] >= high[c]) up = false;
      if (low[k] <= low[c]) dn = false;
    }
    isUp[c] = up;
    isDn[c] = dn;
  }
  // walk forward; a fractal centered at c is available from confirmation day c+half onward
  let lastUp = NaN;
  let lastDn = NaN;
  for (let t = 0; t < T; t++) {
    // any fractal whose CENTER is c = t - half just got confirmed at day t
    const c = t - half;
    if (c >= 0) {
      if (isUp[c]) lastUp = high[c];
      if (isDn[c]) lastDn = low[c];
    }
    upLevel[t] = lastUp;
    dnLevel[t] = lastDn;
  }
  return { upLevel, dnLevel };
}

// ---------------------------------------------------------------- position builders
//
// cfg fields:
//   n        : fractal bar count (odd) -> half = (n-1)/2
//   mode     : "lf" long/flat, "ls" long/short
//   buf      : breakout buffer in bps (require close to exceed level by buf to reduce whipsaw)
//
// Strictly causal: at day t we use levels confirmed at <= t and close[t] (known at close t).
function buildFractalPosition(P: FractalPanel, cfg: Record<string, number | string>): number[] {
  const half = (Number(cfg.n) - 1) / 2;
  const mode = String(cfg.mode);
  const buf = Number(cfg.buf) / 10000; // bps -> frac
  const { upLevel, dnLevel } = fractalLevels(P.high, P.low, half);
  const T = P.price.length;
  const pos = new Array(T).fill(NaN);
  let cur = 0;
  for (let t = 0; t < T; t++) {
    const c = P.price[t];
    const up = upLevel[t];
    const dn = dnLevel[t];
    if (Number.isFinite(up) && c > up * (1 + buf)) cur = 1;
    else if (Number.isFinite(dn) && c < dn * (1 - buf)) cur = mode === "ls" ? -1 : 0;
    // else hold
    pos[t] = cur;
  }
  return pos;
}

// RIGHT null: random-level placebo. Same price path, same state machine & trade cadence, but the
// breakout levels are RANDOM horizontal lines drawn from the trailing W-day [min,max] price range
// (matched scale/regime), refreshed on the same schedule as fractal confirmations would refresh
// (every `half`+1 bars we may pick a new level). This isolates "does the FRACTAL location matter"
// from "does breaking an arbitrary trailing line on a trending asset matter".
function buildRandomLevelPlacebo(
  P: FractalPanel,
  cfg: Record<string, number | string>,
  rng: () => number,
): number[] {
  const half = (Number(cfg.n) - 1) / 2;
  const mode = String(cfg.mode);
  const buf = Number(cfg.buf) / 10000;
  const T = P.price.length;
  const W = 2 * half + 1; // same look-back window the fractal spans
  // random levels refreshed each bar but drawn from the SAME trailing window the fractal sees,
  // so scale/regime match; only the *location within structure* is randomized.
  const upLevel = new Array(T).fill(NaN);
  const dnLevel = new Array(T).fill(NaN);
  let lastUp = NaN;
  let lastDn = NaN;
  for (let t = 0; t < T; t++) {
    const c = t - half; // confirmation cadence identical to fractals
    if (c >= 0) {
      const lo = Math.max(0, c - half);
      const hi = Math.min(T - 1, c + half);
      let mn = Infinity;
      let mx = -Infinity;
      for (let k = lo; k <= hi; k++) {
        if (P.high[k] > mx) mx = P.high[k];
        if (P.low[k] < mn) mn = P.low[k];
      }
      if (Number.isFinite(mn) && Number.isFinite(mx) && mx > mn) {
        // draw a random horizontal level inside the window for both up & down
        lastUp = mn + (mx - mn) * rng();
        lastDn = mn + (mx - mn) * rng();
      }
    }
    upLevel[t] = lastUp;
    dnLevel[t] = lastDn;
  }
  const pos = new Array(T).fill(NaN);
  let cur = 0;
  for (let t = 0; t < T; t++) {
    const c = P.price[t];
    const up = upLevel[t];
    const dn = dnLevel[t];
    if (Number.isFinite(up) && c > up * (1 + buf)) cur = 1;
    else if (Number.isFinite(dn) && c < dn * (1 - buf)) cur = mode === "ls" ? -1 : 0;
    pos[t] = cur;
  }
  return pos;
}

// ---------------------------------------------------------------- main
function run() {
  const bars = loadBars();
  const P = buildPanel(bars);
  console.log(
    `[O6-FRACTAL] BTC daily bars=${P.price.length} ${P.dates[0]}..${P.dates[P.dates.length - 1]}`,
  );

  // Honest config grid (this IS honest N for DSR/haircut). Williams canonical = 5-bar, no buffer.
  const ns = [5, 7, 9];
  const modes = ["lf", "ls"];
  const bufs = [0, 10, 25, 50]; // bps
  const configs: Record<string, number | string>[] = [];
  for (const n of ns) for (const mode of modes) for (const buf of bufs) configs.push({ n, mode, buf });

  const canonical = { n: 5, mode: "lf", buf: 0 };

  // warmup: need the longest window confirmed + some history for levels to populate
  const startIdx = 30;

  const out = runGauntlet({
    name: "O6-FRACTAL Williams 5-bar swing breakout (BTC daily)",
    P,
    buildPosition: (cfg) => buildFractalPosition(P, cfg),
    configs,
    buildSurrogatePosition: (cfg, rng) => buildRandomLevelPlacebo(P, cfg, rng),
    canonical,
    startIdx,
    holdoutFrac: 0.2,
    nSurr: 500,
  });

  // Extra diagnostics: canonical full-sample net Sharpe & vs its OWN buy&hold on same window,
  // plus the random-level placebo distribution mean for the BEST cfg.
  const bestPos = buildFractalPosition(P, out.best.cfg as any);
  const T = P.price.length;
  const splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8);
  const bestIS = runPositions(P, bestPos, startIdx, splitIdx);
  const bhPos = new Array(T).fill(1);
  const bhIS = runPositions(P, bhPos, startIdx, splitIdx);
  console.log(
    `[diag] best cfg=${JSON.stringify(out.best.cfg)} IS netSh=${annSharpe(sharpeDaily(bestIS.dailyNet)).toFixed(3)} grossSh=${annSharpe(sharpeDaily(bestIS.dailyGross)).toFixed(3)} ownB&H netSh=${annSharpe(sharpeDaily(bhIS.dailyNet)).toFixed(3)} exposure=${bestIS.exposure.toFixed(3)} turnover=${bestIS.turnover.toFixed(4)}`,
  );

  printVerdict(out);

  fs.writeFileSync(
    `${ROOT}/output/edgehunt-onchain2/o6_fractal_result.json`,
    JSON.stringify(out, null, 2),
  );
  return out;
}

run();
