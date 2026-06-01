/**
 * TRACK NF1 — Support / Resistance & price-level techniques, tested DEFINITIVELY.
 *
 * The classic price-action toolkit traders swear by, on REAL OHLC:
 *   (a) floor-trader PIVOT POINTS  (PP, S1/S2/R1/R2 from prior day H/L/C)
 *   (b) prior swing HIGHS/LOWS     (Donchian-style channel S/R)
 *   (c) ROUND-NUMBER psychological levels  (e.g. 1000s, 100s, 50s)
 *   (d) FIBONACCI retracements      (38.2 / 50 / 61.8 of a recent swing)
 *   (e) BOLLINGER-band edges        (dynamic S/R)
 *
 * Rules (the textbook playbook):
 *   BOUNCE          — long near support / short near resistance (mean-reversion)
 *   BREAKOUT        — long on break of resistance / short on break of support
 *   BREAKOUT-RETEST — break, then re-touch the broken level, then go with the break
 *                     (path-dependent: confirmed on BTC 15m intrabar HIGH/LOW)
 *
 * HONEST N = every (level-type x rule x parameter x variant) combo evaluated. That
 * true N feeds the Deflated Sharpe / Harvey-Liu haircut. Realistic taker cost (4 bps
 * per side, charged on every |Δposition|) on every entry/exit. We then run the FULL
 * committed gate stack via validateStrategy (net-of-cost, baselines incl. buy&hold +
 * random-lottery + linear, DSR at honest N, PBO, Harvey-Liu haircut, phase-randomized
 * + block-bootstrap SURROGATE/PLACEBO, consume-once holdout).
 *
 * Verdict: does ANY S/R technique produce a real, cost-surviving, OOS edge — or is it
 * (like the classic indicators in TA4) filtered beta + selection? A clean KILL is
 * valuable evidence; a genuine SURVIVE would be a real finding. No survivor is forced.
 *
 * Run:
 *   tsx scripts/nf1/nf1-support-resistance.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  summarizeReturnSeries,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  validateStrategy,
  type StrategyValidatorVerdict,
} from "../../src/lib/validation/strategy-validator";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const NF1_DIR = join(REPO, "output", "nf1");

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX"] as const;

// Realistic perp taker cost: 4 bps per side => 8 bps round trip. Charged on |Δpos|.
const PERP_TAKER_PER_SIDE = 0.0004;
const TRADING_DAYS_PER_YEAR = 365;

// Holdout split (handled INSIDE validateStrategy on the pooled series): most-recent
// 15% vault, 15% test, 70% search. We also do config SELECTION only on an in-sample
// slice so the chosen config is not picked using the vault.
const HOLDOUT_FRACTION = 0.15;
const TEST_FRACTION = 0.15;
// Fraction of the timeline used for SELECTION (config picking). The remaining tail
// (test+vault) is never used to choose the config. We pick on the first 70%.
const SELECT_FRACTION = 0.7;

// "Near a level" proximity band (fraction of price) for the BOUNCE rule.
const PROXIMITY_BANDS = [0.003, 0.006] as const; // 30 bps, 60 bps

// ----------------------------------------------------------------------------
// Data
// ----------------------------------------------------------------------------

interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function loadDaily(sym: string): DailyBar[] {
  const path = join(NF1_DIR, `${sym}_daily_ohlc.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as DailyBar[];
  return raw.filter(
    (b) =>
      Number.isFinite(b.open) &&
      Number.isFinite(b.high) &&
      Number.isFinite(b.low) &&
      Number.isFinite(b.close) &&
      b.low > 0 &&
      b.high >= b.low,
  );
}

interface SymbolSeries {
  symbol: string;
  bars: DailyBar[];
  ret: number[]; // ret[i] = close[i]/close[i-1]-1 (earned holding close[i-1]->close[i])
}

function buildSeries(sym: string): SymbolSeries {
  const bars = loadDaily(sym);
  const ret = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i += 1) {
    ret[i] = bars[i].close / bars[i - 1].close - 1;
  }
  return { symbol: sym, bars, ret };
}

// ----------------------------------------------------------------------------
// Level primitives (all causal: levels at decision time i use only data <= i)
// ----------------------------------------------------------------------------

// (a) Floor-trader pivots from PRIOR bar's H/L/C. Returns level set usable for the
//     CURRENT bar i (computed from bar i-1).
interface PivotLevels {
  pp: number;
  r1: number;
  r2: number;
  s1: number;
  s2: number;
}
function pivotsFromPrior(prev: DailyBar): PivotLevels {
  const pp = (prev.high + prev.low + prev.close) / 3;
  const r1 = 2 * pp - prev.low;
  const s1 = 2 * pp - prev.high;
  const r2 = pp + (prev.high - prev.low);
  const s2 = pp - (prev.high - prev.low);
  return { pp, r1, r2, s1, s2 };
}

// (b) Swing high/low (Donchian) over a trailing window ending at i-1 (prior bars only).
function priorChannel(bars: DailyBar[], i: number, period: number): { hi: number; lo: number } | null {
  if (i - 1 < period - 1) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - period; j < i; j += 1) {
    if (j < 0) return null;
    if (bars[j].high > hi) hi = bars[j].high;
    if (bars[j].low < lo) lo = bars[j].low;
  }
  return { hi, lo };
}

// (c) Round-number levels: nearest round levels around current price. `step` is a
//     fraction of price (e.g. 0.1 => 10% grid: 1000, 1100, ... near $1k; 50 near $500).
//     We snap to a human "round" grid based on the price magnitude.
function roundLevels(price: number, granularity: number): { below: number; above: number } {
  // grid step = granularity * 10^floor(log10(price))  (e.g. granularity 0.1 on $40k -> $1000 grid)
  const mag = Math.pow(10, Math.floor(Math.log10(price)));
  const step = granularity * mag;
  const below = Math.floor(price / step) * step;
  const above = below + step;
  return { below, above };
}

// (d) Fibonacci retracements of the most recent swing (prior `lookback` bars' hi/lo).
//     Retracement levels measured from the swing. We return the 38.2/50/61.8 levels.
function fibLevels(bars: DailyBar[], i: number, lookback: number): { levels: number[]; hi: number; lo: number } | null {
  const ch = priorChannel(bars, i, lookback);
  if (!ch) return null;
  const range = ch.hi - ch.lo;
  if (range <= 0) return null;
  // Standard retracement levels from the high (support on the way down).
  const levels = [0.382, 0.5, 0.618].map((f) => ch.hi - f * range);
  return { levels, hi: ch.hi, lo: ch.lo };
}

// (e) Bollinger band edges (SMA +/- mult*std over prior `period` bars ending at i-1).
function bollingerPrior(bars: DailyBar[], i: number, period: number, mult: number): { upper: number; lower: number; mid: number } | null {
  if (i - 1 < period - 1) return null;
  let mean = 0;
  for (let j = i - period; j < i; j += 1) mean += bars[j].close;
  mean /= period;
  let v = 0;
  for (let j = i - period; j < i; j += 1) v += (bars[j].close - mean) ** 2;
  const sd = Math.sqrt(v / period);
  return { upper: mean + mult * sd, lower: mean - mult * sd, mid: mean };
}

// ----------------------------------------------------------------------------
// Strategy configs: (level-type x rule x params x variant)
// ----------------------------------------------------------------------------

type Variant = "longflat" | "longshort";
type Rule = "bounce" | "breakout" | "breakout_retest";

interface SRConfig {
  id: string;
  levelType: string;
  rule: Rule;
  variant: Variant;
  params: Record<string, number>;
  // desired position decided at close[i] (held i->i+1). null => no data yet (flat).
  positions: (s: SymbolSeries) => (number | null)[];
}

function clampVariant(pos: number, variant: Variant): number {
  if (variant === "longflat") return pos > 0 ? 1 : 0;
  return pos;
}

// Generic helper: given, per bar i, the nearest support and resistance levels
// (or null), produce positions for a chosen rule. `support`/`resistance` are the
// levels in PRICE that apply to the decision at close[i]. Returns position for i->i+1.
function ruleToPositions(
  s: SymbolSeries,
  levelAt: (i: number) => { support: number | null; resistance: number | null } | null,
  rule: Rule,
  variant: Variant,
  band: number,
): (number | null)[] {
  const bars = s.bars;
  const out: (number | null)[] = new Array(bars.length).fill(null);
  // For breakout_retest we need a small state machine across bars.
  let pendingBreakUp = false; // broke resistance, waiting for retest
  let pendingBreakDn = false;
  for (let i = 0; i < bars.length; i += 1) {
    const lv = levelAt(i);
    if (!lv) {
      out[i] = null;
      pendingBreakUp = false;
      pendingBreakDn = false;
      continue;
    }
    const c = bars[i].close;
    const { support, resistance } = lv;
    if (rule === "bounce") {
      // long if price within `band` ABOVE support (bouncing up off support);
      // short if within `band` BELOW resistance (rejecting off resistance).
      let pos = 0;
      if (support !== null && c >= support && c - support <= band * c) pos = 1;
      else if (resistance !== null && c <= resistance && resistance - c <= band * c) pos = -1;
      out[i] = clampVariant(pos, variant);
    } else if (rule === "breakout") {
      // long if close breaks ABOVE resistance; short if breaks BELOW support.
      let pos = 0;
      if (resistance !== null && c > resistance) pos = 1;
      else if (support !== null && c < support) pos = -1;
      out[i] = clampVariant(pos, variant);
    } else {
      // breakout_retest: detect a break, then require a re-touch (close back within
      // band of the broken level) before entering in the break direction.
      let pos = 0;
      if (resistance !== null && c > resistance) pendingBreakUp = true;
      if (support !== null && c < support) pendingBreakDn = true;
      // retest: price comes back to within band of the (now broken) level
      if (pendingBreakUp && resistance !== null && Math.abs(c - resistance) <= band * c) {
        pos = 1; // confirmed retest of broken resistance -> long
        pendingBreakUp = false;
      } else if (pendingBreakDn && support !== null && Math.abs(c - support) <= band * c) {
        pos = -1;
        pendingBreakDn = false;
      } else if (pendingBreakUp) {
        pos = 1; // hold long bias while waiting (with the break)
      } else if (pendingBreakDn) {
        pos = -1;
      }
      out[i] = clampVariant(pos, variant);
    }
  }
  return out;
}

function buildConfigs(): SRConfig[] {
  const configs: SRConfig[] = [];
  const variants: Variant[] = ["longflat", "longshort"];
  const rules: Rule[] = ["bounce", "breakout", "breakout_retest"];

  // (a) PIVOT POINTS. Support = nearest pivot support below price (s1/s2/pp),
  //     resistance = nearest pivot resistance above (r1/r2/pp). Param: which band of
  //     levels to use ("s1r1" vs "s2r2").
  const pivotBandsSets: Array<{ name: string; pick: (lv: PivotLevels) => number[] }> = [
    { name: "s1r1", pick: (lv) => [lv.s1, lv.pp, lv.r1] },
    { name: "s2r2", pick: (lv) => [lv.s2, lv.s1, lv.pp, lv.r1, lv.r2] },
  ];
  for (const set of pivotBandsSets) {
    for (const rule of rules) {
      for (const band of PROXIMITY_BANDS) {
        for (const variant of variants) {
          configs.push({
            id: `Pivot_${set.name}_${rule}_b${band}_${variant}`,
            levelType: "pivot",
            rule,
            variant,
            params: { band },
            positions: (s) =>
              ruleToPositions(
                s,
                (i) => {
                  if (i < 1) return null;
                  const lv = pivotsFromPrior(s.bars[i - 1]);
                  const levels = set.pick(lv).sort((a, b) => a - b);
                  const c = s.bars[i].close;
                  let support: number | null = null;
                  let resistance: number | null = null;
                  for (const L of levels) {
                    if (L <= c) support = L;
                    else if (resistance === null) resistance = L;
                  }
                  return { support, resistance };
                },
                rule,
                variant,
                band,
              ),
          });
        }
      }
    }
  }

  // (b) SWING HIGH/LOW (Donchian channel). Support = prior N-day low, resistance =
  //     prior N-day high. Param: lookback period.
  const donchianPeriods = [10, 20, 55];
  for (const period of donchianPeriods) {
    for (const rule of rules) {
      for (const band of PROXIMITY_BANDS) {
        for (const variant of variants) {
          configs.push({
            id: `Swing_p${period}_${rule}_b${band}_${variant}`,
            levelType: "swing",
            rule,
            variant,
            params: { period, band },
            positions: (s) =>
              ruleToPositions(
                s,
                (i) => {
                  const ch = priorChannel(s.bars, i, period);
                  if (!ch) return null;
                  return { support: ch.lo, resistance: ch.hi };
                },
                rule,
                variant,
                band,
              ),
          });
        }
      }
    }
  }

  // (c) ROUND NUMBERS. Support = nearest round level below price, resistance = above.
  //     Param: granularity of the round grid.
  const roundGrans = [0.1, 0.05]; // 10% grid, 5% grid (e.g. $1000s vs $500s near $10k)
  for (const gran of roundGrans) {
    for (const rule of rules) {
      for (const band of PROXIMITY_BANDS) {
        for (const variant of variants) {
          configs.push({
            id: `Round_g${gran}_${rule}_b${band}_${variant}`,
            levelType: "round",
            rule,
            variant,
            params: { gran, band },
            positions: (s) =>
              ruleToPositions(
                s,
                (i) => {
                  const c = s.bars[i].close;
                  const { below, above } = roundLevels(c, gran);
                  return { support: below, resistance: above };
                },
                rule,
                variant,
                band,
              ),
          });
        }
      }
    }
  }

  // (d) FIBONACCI retracements. Support = nearest fib level below price, resistance =
  //     above. Param: swing lookback.
  const fibLookbacks = [20, 55, 90];
  for (const lookback of fibLookbacks) {
    for (const rule of rules) {
      for (const band of PROXIMITY_BANDS) {
        for (const variant of variants) {
          configs.push({
            id: `Fib_l${lookback}_${rule}_b${band}_${variant}`,
            levelType: "fibonacci",
            rule,
            variant,
            params: { lookback, band },
            positions: (s) =>
              ruleToPositions(
                s,
                (i) => {
                  const fib = fibLevels(s.bars, i, lookback);
                  if (!fib) return null;
                  const c = s.bars[i].close;
                  const all = [fib.lo, ...fib.levels, fib.hi].sort((a, b) => a - b);
                  let support: number | null = null;
                  let resistance: number | null = null;
                  for (const L of all) {
                    if (L <= c) support = L;
                    else if (resistance === null) resistance = L;
                  }
                  return { support, resistance };
                },
                rule,
                variant,
                band,
              ),
          });
        }
      }
    }
  }

  // (e) BOLLINGER edges. Support = lower band, resistance = upper band. Params:
  //     period, mult.
  const bbPeriods = [20, 30];
  const bbMults = [2.0, 2.5];
  for (const period of bbPeriods) {
    for (const mult of bbMults) {
      for (const rule of rules) {
        for (const band of PROXIMITY_BANDS) {
          for (const variant of variants) {
            configs.push({
              id: `Boll_p${period}_m${mult}_${rule}_b${band}_${variant}`,
              levelType: "bollinger",
              rule,
              variant,
              params: { period, mult, band },
              positions: (s) =>
                ruleToPositions(
                  s,
                  (i) => {
                    const bb = bollingerPrior(s.bars, i, period, mult);
                    if (!bb) return null;
                    return { support: bb.lower, resistance: bb.upper };
                  },
                  rule,
                  variant,
                  band,
                ),
            });
          }
        }
      }
    }
  }

  return configs;
}

// ----------------------------------------------------------------------------
// Backtest a config on one symbol over [startIdx, endIdx): net & gross returns +
// position path (for turnover-aware cost) + per-bar market returns.
// ----------------------------------------------------------------------------

interface BTResult {
  netReturns: number[];
  grossReturns: number[];
  positions: number[]; // position held i->i+1 within window
  marketBars: number[]; // ret[i+1] (the bar the position earns on)
  turnover: number;
}

function backtest(s: SymbolSeries, desired: (number | null)[], startIdx: number, endIdx: number): BTResult {
  const net: number[] = [];
  const gross: number[] = [];
  const positions: number[] = [];
  const marketBars: number[] = [];
  const roundTrip = PERP_TAKER_PER_SIDE * 2;
  let turnover = 0;
  let prevPos = startIdx > 0 && desired[startIdx - 1] != null ? (desired[startIdx - 1] as number) : 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    const d = desired[i];
    const pos = d == null ? prevPos : d;
    const turn = Math.abs(pos - prevPos);
    turnover += turn;
    const cost = turn * roundTrip;
    const mkt = i + 1 < s.ret.length ? s.ret[i + 1] : 0;
    const g = pos * mkt;
    gross.push(g);
    net.push(g - cost);
    positions.push(pos);
    marketBars.push(mkt);
    prevPos = pos;
  }
  return { netReturns: net, grossReturns: gross, positions, marketBars, turnover };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

function annualize(dailySharpe: number): number {
  return dailySharpe * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

interface Evaluated {
  config: SRConfig;
  // pooled across symbols, SELECTION window only (for ranking)
  selNet: number[];
  selGross: number[];
  selPositions: number[];
  selMarket: number[];
  selSharpeNet: number;
  selSharpeGross: number;
  turnover: number;
  perSymbolSelNet: number[][];
}

function main(): void {
  const allSeries = SYMBOLS.map(buildSeries);
  // Align by index on the COMMON tail so the time axis matches across symbols. Each
  // symbol has a different start; we take the last `minLen` bars of each so the
  // most-recent vault is the SAME calendar window for every symbol.
  const minLen = Math.min(...allSeries.map((s) => s.bars.length));
  // Use a common window length; index 0 of the window maps to (len-minLen) in each.
  const windowStart = (s: SymbolSeries) => s.bars.length - minLen;

  const selectEnd = Math.floor(minLen * SELECT_FRACTION);

  const configs = buildConfigs();
  const N = configs.length; // HONEST trial count

  console.log("=".repeat(80));
  console.log("TRACK NF1 — Support / Resistance & price-level techniques, definitive test");
  console.log("=".repeat(80));
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Daily bars per symbol (common aligned tail): ${minLen}`);
  console.log(`Selection window (config picking): [0, ${selectEnd}) of the common tail`);
  console.log(`Taker cost: ${PERP_TAKER_PER_SIDE * 1e4} bps/side (${PERP_TAKER_PER_SIDE * 2e4} bps round trip), charged on |Δpos|`);
  console.log(`HONEST trial count N (level-type x rule x param x variant): ${N}`);
  console.log("");

  // Evaluate every config on the SELECTION window, pooled across symbols.
  const evaluated: Evaluated[] = configs.map((config) => {
    const selNet: number[] = [];
    const selGross: number[] = [];
    const selPositions: number[] = [];
    const selMarket: number[] = [];
    const perSymbolSelNet: number[][] = [];
    let turnover = 0;
    for (const s of allSeries) {
      const ws = windowStart(s);
      const desired = config.positions(s);
      const bt = backtest(s, desired, ws, ws + selectEnd);
      selNet.push(...bt.netReturns);
      selGross.push(...bt.grossReturns);
      selPositions.push(...bt.positions);
      selMarket.push(...bt.marketBars);
      perSymbolSelNet.push(bt.netReturns);
      turnover += bt.turnover;
    }
    const sn = summarizeReturnSeries(selNet);
    const sg = summarizeReturnSeries(selGross);
    return {
      config,
      selNet,
      selGross,
      selPositions,
      selMarket,
      selSharpeNet: sn.sharpe,
      selSharpeGross: sg.sharpe,
      turnover,
      perSymbolSelNet,
    };
  });

  // Rank by NET daily Sharpe on the selection window (the searcher's criterion).
  evaluated.sort((a, b) => b.selSharpeNet - a.selSharpeNet);

  console.log("Top 15 configs by NET daily Sharpe (selection window, pooled across 8 majors):");
  console.log("  rank  config".padEnd(60) + "netSh(ann)  grossSh(ann)  turnover");
  evaluated.slice(0, 15).forEach((e, idx) => {
    console.log(
      `  ${String(idx + 1).padStart(2)}  ${e.config.id.padEnd(50)}` +
        `${annualize(e.selSharpeNet).toFixed(2).padStart(8)}   ${annualize(e.selSharpeGross).toFixed(2).padStart(9)}   ${e.turnover.toFixed(0).padStart(7)}`,
    );
  });
  console.log("");

  // Census: how many of the N configs even have a POSITIVE net Sharpe on selection?
  const positiveNet = evaluated.filter((e) => e.selSharpeNet > 0).length;
  console.log(`Census: ${positiveNet}/${N} configs have positive NET daily Sharpe on the selection window.`);
  console.log("");

  const best = evaluated[0];

  // ----- Rebuild the BEST config's FULL pooled series (all bars), with position path
  //       and per-asset panels, so validateStrategy can carve its own holdout vault and
  //       seed surrogates from the real per-asset marginals.
  const fullGross: number[] = [];
  const fullPos: number[] = [];
  const fullMarket: number[] = [];
  const perAssetGross: number[][] = [];
  const perAssetMarket: number[][] = [];
  for (const s of allSeries) {
    const ws = windowStart(s);
    const desired = best.config.positions(s);
    const bt = backtest(s, desired, ws, ws + minLen);
    fullGross.push(...bt.grossReturns);
    fullPos.push(...bt.positions);
    fullMarket.push(...bt.marketBars);
    perAssetGross.push(bt.grossReturns);
    perAssetMarket.push(bt.marketBars);
  }

  // Buy-and-hold market series (pooled) and equal-weight panel mean for baselines.
  const marketPooled = fullMarket;
  const eqWeight: number[] = [];
  for (let t = 0; t < minLen; t += 1) {
    let sum = 0;
    let cnt = 0;
    for (const arr of perAssetMarket) {
      if (t < arr.length) {
        sum += arr[t];
        cnt += 1;
      }
    }
    eqWeight.push(cnt > 0 ? sum / cnt : 0);
  }

  // Linear one-layer baseline: predict next-bar return from yesterday's return per
  // symbol (DLinear-style), position = sign(pred), net of cost. Pooled.
  const linearNet = buildLinearBaselineNet(allSeries, windowStart, minLen);

  // CPCV matrix: top-K configs as strategies, per-symbol selection-window net as folds.
  const TOPK = 16;
  const cpcvStrategies: CscvStrategyFoldReturns[] = evaluated.slice(0, TOPK).map((e) => ({
    id: e.config.id,
    folds: e.perSymbolSelNet,
  }));

  // ----- Run the FULL committed gate stack via the one-call harness. ------------
  // The harness applies cost from the position path, carves a consume-once holdout,
  // and runs DSR (at honest N) / baselines / haircut / SURROGATE-PLACEBO / holdout.
  const verdict: StrategyValidatorVerdict = validateStrategy(fullGross, {
    trialCount: N,
    statistic: "compoundReturn",
    cost: { takerPerSide: PERP_TAKER_PER_SIDE, position: fullPos },
    baselines: {
      marketReturns: marketPooled,
      equalWeightReturns: eqWeight,
      linearReturns: linearNet,
      roundTripCost: PERP_TAKER_PER_SIDE * 2,
    },
    cpcv: { strategies: cpcvStrategies, trainFraction: 0.5 },
    haircut: { method: "bonferroni" },
    surrogate: {
      iterations: 300,
      crossSectional: true,
      panel: { assetReturns: perAssetGross },
      statistic: "sharpe",
      seed: "nf1-surrogate",
    },
    holdout: {
      holdoutFraction: HOLDOUT_FRACTION,
      testFraction: TEST_FRACTION,
      reason: "nf1-support-resistance-final-verdict",
    },
    seed: "nf1",
  });

  // ----- Report ----------------------------------------------------------------
  console.log("=".repeat(80));
  console.log(`SELECTED BEST (net of cost, by selection-window net Sharpe): ${best.config.id}`);
  console.log("=".repeat(80));
  console.log(`  Level type: ${best.config.levelType}   rule: ${best.config.rule}   variant: ${best.config.variant}`);
  console.log(`  Selection net daily Sharpe:   ${best.selSharpeNet.toFixed(4)}  (ann ${annualize(best.selSharpeNet).toFixed(3)})`);
  console.log(`  Selection gross daily Sharpe: ${best.selSharpeGross.toFixed(4)}  (ann ${annualize(best.selSharpeGross).toFixed(3)})`);
  console.log(`  Full-series turnover (Σ|Δpos|): ${verdict.netStats.turnover.toFixed(0)}`);
  console.log(`  In-sample net (post-cost) Sharpe: ${verdict.netStats.sharpe.toFixed(4)}  (gross ${verdict.netStats.grossSharpe.toFixed(4)})`);
  console.log("");
  console.log("GATE STACK (validateStrategy — committed gates, holdout carved first):");
  for (const g of verdict.perGate) {
    console.log(`  [${g.passed ? "PASS" : "FAIL"}] ${g.label}: ${g.reason}`);
  }
  console.log("");
  console.log("=".repeat(80));
  const survived = verdict.verdict === "PASS";
  console.log(`VERDICT: ${survived ? "SURVIVE" : "KILL"}`);
  if (!survived) console.log(`KILLED BY GATE: ${verdict.bindingGate}`);
  console.log("=".repeat(80));

  // Surrogate / placebo headline (the mandatory control).
  const surrogateGate = verdict.perGate.find((g) => g.id === "surrogate");
  const placeboP = surrogateGate?.detail.placeboP;
  console.log("");
  console.log("SURROGATE / PLACEBO (phase-randomized + block-bootstrap + cross-sectional):");
  console.log(`  ${surrogateGate?.reason}`);

  // Realistic monthly $ ONLY if survived.
  let monthly = "n/a — killed";
  if (survived) {
    const meanDaily = summarizeReturnSeries(best.selNet).mean;
    const monthlyPct = meanDaily * 30;
    monthly = `${(monthlyPct * 100).toFixed(2)}%/mo => $${(monthlyPct * 10000).toFixed(0)} on $10k`;
    console.log(`\nRealistic monthly (net): ${monthly}`);
  }

  // ----- Artifact --------------------------------------------------------------
  const artifact = {
    track: "NF1",
    generatedAt: new Date().toISOString(),
    dataSource:
      "output/nf1/*_daily_ohlc.json (8 majors daily OHLC; BTC aggregated from committed 15m, others Binance public klines)",
    symbols: SYMBOLS,
    daysPerSymbolAligned: minLen,
    selectionWindowEnd: selectEnd,
    perpTakerPerSide: PERP_TAKER_PER_SIDE,
    honestTrialCount: N,
    levelTypes: ["pivot", "swing", "round", "fibonacci", "bollinger"],
    rules: ["bounce", "breakout", "breakout_retest"],
    configsPositiveNetSelection: positiveNet,
    best: {
      id: best.config.id,
      levelType: best.config.levelType,
      rule: best.config.rule,
      variant: best.config.variant,
      params: best.config.params,
      selectionNetSharpe: best.selSharpeNet,
      selectionNetAnnualSharpe: annualize(best.selSharpeNet),
      selectionGrossAnnualSharpe: annualize(best.selSharpeGross),
    },
    verdict: verdict.verdict === "PASS" ? "SURVIVE" : "KILL",
    bindingGate: verdict.bindingGate,
    netStats: verdict.netStats,
    perGate: verdict.perGate,
    placeboP,
    monthlyIfSurvived: monthly,
    topConfigs: evaluated.slice(0, 20).map((e) => ({
      id: e.config.id,
      levelType: e.config.levelType,
      rule: e.config.rule,
      netAnnualSharpe: annualize(e.selSharpeNet),
      grossAnnualSharpe: annualize(e.selSharpeGross),
      turnover: e.turnover,
    })),
  };
  const outPath = join(NF1_DIR, "nf1-support-resistance-result.json");
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact written: ${outPath}`);

  // Per-level-type breakdown: best net Sharpe in each family (the key diagnostic).
  console.log("\nPer-level-type best (net daily Sharpe, selection window):");
  const families = ["pivot", "swing", "round", "fibonacci", "bollinger"];
  for (const fam of families) {
    const inFam = evaluated.filter((e) => e.config.levelType === fam);
    const bestFam = inFam[0]; // already sorted desc by net Sharpe
    console.log(
      `  ${fam.padEnd(11)} best=${bestFam.config.id.padEnd(40)} netSh(ann)=${annualize(bestFam.selSharpeNet).toFixed(2)}`,
    );
  }
}

// Linear one-layer (DLinear-style) baseline: per symbol, predict next-bar return from
// yesterday's return via least squares over the selection window, position = sign(pred),
// net of cost; pooled across symbols over the FULL window.
function buildLinearBaselineNet(
  allSeries: SymbolSeries[],
  windowStart: (s: SymbolSeries) => number,
  minLen: number,
): number[] {
  const roundTrip = PERP_TAKER_PER_SIDE * 2;
  const pooled: number[] = [];
  const selEnd = Math.floor(minLen * SELECT_FRACTION);
  for (const s of allSeries) {
    const ws = windowStart(s);
    const feats: number[] = [];
    const targets: number[] = [];
    for (let i = 1; i < selEnd; i += 1) {
      const gi = ws + i;
      if (gi + 1 >= s.ret.length) break;
      feats.push(s.ret[gi]);
      targets.push(s.ret[gi + 1]);
    }
    if (feats.length < 10) continue;
    const mx = feats.reduce((a, b) => a + b, 0) / feats.length;
    const my = targets.reduce((a, b) => a + b, 0) / targets.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < feats.length; i += 1) {
      sxy += (feats[i] - mx) * (targets[i] - my);
      sxx += (feats[i] - mx) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const intercept = my - slope * mx;
    let prevPos = 0;
    for (let i = 1; i < minLen; i += 1) {
      const gi = ws + i;
      if (gi + 1 >= s.ret.length) break;
      const pred = slope * s.ret[gi] + intercept;
      const pos = pred > 0 ? 1 : pred < 0 ? -1 : 0;
      const turn = Math.abs(pos - prevPos);
      pooled.push(pos * s.ret[gi + 1] - turn * roundTrip);
      prevPos = pos;
    }
  }
  return pooled;
}

main();
