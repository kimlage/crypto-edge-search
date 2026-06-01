/**
 * FRONT R2 — Illiquid / small-cap edge audit.
 *
 * HYPOTHESIS: TA/momentum/reversal may survive in LESS-ARBITRAGED, lower-liquidity
 * names where the limits-to-arbitrage premium is highest — the opposite end from the
 * over-arbitraged majors. We test the three angles most likely to survive there:
 *   (A) SHORT-TERM cross-sectional REVERSAL  (illiquidity-driven overreaction fades),
 *   (B) cross-sectional MOMENTUM in the small-cap tier,
 *   (C) a LOW-TURNOVER trend filter (slow time-series trend, dollar-neutral long-only).
 *
 * Long/short, dollar-neutral, equal-weight within each leg, rebalanced at a chosen
 * cadence. The cross-section is ranked each rebalance on a lookback signal; we go long
 * the bottom/top quantile and short the opposite, holding for `holdPeriods`.
 *
 * ===================== REALISTIC SMALL-CAP COST (mandatory) =====================
 * Majors pay ~4 bps/side. Small-caps DON'T. We charge a PER-NAME per-side cost:
 *     perSide = takerFee + halfSpread + depthSlippage(tradeNotional, depth)
 *   takerFee     = 4 bps (Binance taker)
 *   halfSpread   = 0.5 * observed quoted spread (bps), floored at 5 bps
 *   depthSlippage= linear impact: tradeNotional crossing the ±50bps depth book.
 * Charged on EVERY position change (turnover). A gross-only signal is a KILL.
 * We sweep deployable size $5k / $25k so slippage scales with how much we push.
 *
 * ===================== GATE STACK (committed gates only) =====================
 *  DSR (computeDeflatedSharpeRatio, honest N) -> CPCV/PBO (estimateCscvPbo) ->
 *  baselines (beat B&H equal-weight + random-lottery + linear) -> Harvey-Liu haircut
 *  -> consume-once holdout (planHoldoutSplit + FinalHoldoutGuard).
 *
 * ===================== SURROGATE / PLACEBO CONTROL =====================
 * The IDENTICAL search runs on (1) phase-randomized and (2) block-bootstrap surrogate
 * panels that preserve vol + short autocorrelation but DESTROY genuine cross-sectional
 * structure. Placebo p = fraction of surrogate champions >= the real champion's best
 * search Sharpe. If surrogates match the real edge, the champion is a search artifact.
 *
 * SURVIVORSHIP: the panel is small-caps liquid TODAY; the small-cap graveyard is gone.
 * Any edge is a STRONG UPPER BOUND; a marginal pass = a FAIL.
 *
 * Run: PATH=<codex-node-bin>:$PATH tsx scripts/r2-illiquid/audit-smallcap-edge.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/statistical-validation";
import {
  buildBuyAndHoldBaseline,
  buildRandomLotteryBaseline,
  baselineScoreFromReturns,
  evaluateBaselineGate,
  type BaselineScore,
} from "../../src/lib/significance/baselines";
import { haircutSharpe } from "../../src/lib/significance/haircut";
import {
  planHoldoutSplit,
  assertSearchDoesNotTouchHoldout,
  FinalHoldoutGuard,
} from "../../src/lib/significance/holdout";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "output", "r2-illiquid");
mkdirSync(OUT_DIR, { recursive: true });

// ---------- Cost constants ----------
const TAKER_BPS = 4; // Binance taker per side
const SPREAD_FLOOR_BPS = 5; // small-caps: never assume tighter than 5bps half-cross floor on quoted spread
const SIZES_USD = [5_000, 25_000]; // deployable capital sweep

// ---------- Gate thresholds ----------
const DSR_THRESHOLD = 0.95; // deflated prob the Sharpe beats expected-max-of-N
const PBO_THRESHOLD = 0.5; // probability of backtest overfit must be < 0.5
const SHARPE_PERIODS_PER_YEAR_BASE = 365; // adjusted per cadence below

// ====================================================================
// Panel
// ====================================================================
interface Panel {
  symbols: string[];
  dates: string[];
  // closes[symbolIndex][dateIndex] -> number | null
  closes: (number | null)[][];
  spreadBps: number[]; // per symbol
  depthUsd50bps: number[]; // per symbol
  quoteVol24h: number[];
}

function loadPanel(): Panel {
  const raw = JSON.parse(
    readFileSync(join(OUT_DIR, "smallcap-daily-closes.json"), "utf8"),
  ) as { dates: string[]; closes: Record<string, Record<string, number | null>> };
  const meta = JSON.parse(
    readFileSync(join(OUT_DIR, "smallcap-meta.json"), "utf8"),
  ) as {
    universe: string[];
    liquidity: { symbol: string; quoteVol24hUsd: number; spreadBps: number; depthUsd50bps: number }[];
  };
  const symbols = meta.universe;
  const dates = raw.dates;
  const closes = symbols.map((s) => dates.map((d) => raw.closes[s]?.[d] ?? null));
  const liqBy = new Map(meta.liquidity.map((l) => [l.symbol, l]));
  const spreadBps = symbols.map((s) => {
    const v = liqBy.get(s)?.spreadBps;
    return Number.isFinite(v) ? (v as number) : 30; // missing depth probe => assume wide
  });
  const depthUsd50bps = symbols.map((s) => {
    const v = liqBy.get(s)?.depthUsd50bps;
    return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 20_000; // thin default
  });
  const quoteVol24h = symbols.map((s) => liqBy.get(s)?.quoteVol24hUsd ?? 0);
  return { symbols, dates, closes, spreadBps, depthUsd50bps, quoteVol24h };
}

// ====================================================================
// Per-name realistic cost (fraction, per side) at a given trade notional.
// halfSpread = 0.5*max(spread,floor). depthSlippage = linear book-walk:
//   crossing the ±50bps depth book costs ~50bps of slippage when tradeNotional
//   == depthUsd50bps; scales linearly (a fraction of the book moves price a
//   proportional fraction of 50bps). Capped at 200bps for pathological thinness.
// ====================================================================
function perSideCostFraction(
  spreadBps: number,
  depthUsd50bps: number,
  tradeNotionalUsd: number,
): number {
  const taker = TAKER_BPS / 1e4;
  const halfSpread = (Math.max(spreadBps, SPREAD_FLOOR_BPS) / 2) / 1e4;
  const fillFraction = depthUsd50bps > 0 ? tradeNotionalUsd / depthUsd50bps : 10;
  const slippageBps = Math.min(200, 50 * fillFraction); // 50bps to clear the ±50bps book
  const slippage = slippageBps / 1e4;
  return taker + halfSpread + slippage;
}

// ====================================================================
// Rebalance-frequency aggregation + cross-sectional backtest engine
// ====================================================================
interface StratConfig {
  id: string;
  angle: "reversal" | "momentum" | "trend";
  cadenceDays: number; // rebalance every N days
  lookbackPeriods: number; // periods of cadence for the ranking signal
  holdPeriods: number; // hold each rebalance position for this many periods (overlap allowed)
  quantile: number; // fraction in each leg (e.g. 0.25 => top/bottom 25%)
  longOnly: boolean; // trend filter variant: long-only dollar-neutral vs market? we use long-top minus equal-weight
}

interface BacktestResult {
  periodNet: number[]; // net-of-cost portfolio returns per rebalance period
  periodGross: number[];
  periodCost: number[];
  periodTurnover: number[]; // one-way turnover per rebalance (sum |Δw|)
  periodDates: string[]; // date index at the END of each period (when return realized)
  periodEndIdx: number[]; // date index when each period return is realized
}

/**
 * Build period boundaries on the daily axis at `cadenceDays`. Returns array of
 * date indexes that mark period ends.
 */
function periodBoundaries(nDates: number, cadenceDays: number): number[] {
  const ends: number[] = [];
  for (let i = cadenceDays - 1; i < nDates; i += cadenceDays) ends.push(i);
  return ends;
}

/** Simple return between two close prices; null if either missing. */
function ret(a: number | null, b: number | null): number | null {
  if (a == null || b == null || a <= 0 || b <= 0) return null;
  return b / a - 1;
}

/**
 * Run the cross-sectional strategy. At each rebalance end-index e (a period
 * boundary), rank symbols PRESENT at e by the lookback signal computed using data
 * up to e (no look-ahead). Form target weights. The position is held for
 * `holdPeriods` boundaries; the realized return is the equal-weighted leg return
 * over the NEXT period. Cost = turnover (|Δw| vs previous target) * perSideCost.
 *
 * `sizeUsd` sets the per-name trade notional for depth-driven slippage.
 */
function backtest(panel: Panel, cfg: StratConfig, sizeUsd: number): BacktestResult {
  const { closes, dates, spreadBps, depthUsd50bps } = panel;
  const nSym = closes.length;
  const bounds = periodBoundaries(dates.length, cfg.cadenceDays);

  const periodNet: number[] = [];
  const periodGross: number[] = [];
  const periodCost: number[] = [];
  const periodTurnover: number[] = [];
  const periodDates: string[] = [];
  const periodEndIdx: number[] = [];

  let prevWeights = new Array<number>(nSym).fill(0);

  for (let p = 0; p + 1 < bounds.length; p += 1) {
    const e = bounds[p]; // signal computed using closes up to e
    const next = bounds[p + 1]; // return realized from e -> next

    // --- Signal: lookback return over cfg.lookbackPeriods periods ending at e ---
    const lookEnd = e;
    const lookStartBound = p - cfg.lookbackPeriods;
    const lookStart = lookStartBound >= 0 ? bounds[lookStartBound] : 0;
    const signals: { i: number; sig: number }[] = [];
    for (let i = 0; i < nSym; i += 1) {
      const r = ret(closes[i][lookStart], closes[i][lookEnd]);
      // require present at both look ends AND at e+next for forward return
      if (r == null) continue;
      if (closes[i][e] == null || closes[i][next] == null) continue;
      signals.push({ i, sig: r });
    }
    if (signals.length < 6) {
      // too few names this period: hold flat, no cost
      periodNet.push(0);
      periodGross.push(0);
      periodCost.push(0);
      periodTurnover.push(0);
      periodDates.push(dates[next]);
      periodEndIdx.push(next);
      prevWeights = new Array<number>(nSym).fill(0);
      continue;
    }

    // --- Rank & form target weights ---
    const sorted = [...signals].sort((a, b) => a.sig - b.sig); // ascending
    const k = Math.max(1, Math.floor(signals.length * cfg.quantile));
    const targetWeights = new Array<number>(nSym).fill(0);

    if (cfg.angle === "trend") {
      // Long-only dollar-neutral vs equal-weight: long top-k momentum, financed by
      // shorting the equal-weight basket (so it's the trend-tilt vs holding all).
      const top = sorted.slice(sorted.length - k); // highest momentum
      const wLong = 1 / top.length;
      for (const { i } of top) targetWeights[i] += wLong;
      // short equal-weight of all present names
      const wShort = 1 / signals.length;
      for (const { i } of signals) targetWeights[i] -= wShort;
    } else {
      const bottom = sorted.slice(0, k); // lowest signal
      const top = sorted.slice(sorted.length - k); // highest signal
      // reversal: long losers (bottom), short winners (top)
      // momentum: long winners (top), short losers (bottom)
      const longLeg = cfg.angle === "reversal" ? bottom : top;
      const shortLeg = cfg.angle === "reversal" ? top : bottom;
      const wl = 1 / longLeg.length;
      const ws = 1 / shortLeg.length;
      for (const { i } of longLeg) targetWeights[i] += wl;
      for (const { i } of shortLeg) targetWeights[i] -= ws;
    }

    // --- Realized gross return e -> next ---
    let gross = 0;
    for (let i = 0; i < nSym; i += 1) {
      if (targetWeights[i] === 0) continue;
      const r = ret(closes[i][e], closes[i][next]);
      if (r == null) continue;
      gross += targetWeights[i] * r;
    }

    // --- Turnover & cost ---
    let turnover = 0;
    let cost = 0;
    for (let i = 0; i < nSym; i += 1) {
      const dw = Math.abs(targetWeights[i] - prevWeights[i]);
      if (dw <= 0) continue;
      turnover += dw;
      const notional = dw * sizeUsd;
      cost += dw * perSideCostFraction(spreadBps[i], depthUsd50bps[i], notional);
    }

    periodGross.push(gross);
    periodCost.push(cost);
    periodNet.push(gross - cost);
    periodTurnover.push(turnover);
    periodDates.push(dates[next]);
    periodEndIdx.push(next);
    prevWeights = targetWeights;
  }

  return { periodNet, periodGross, periodCost, periodTurnover, periodDates, periodEndIdx };
}

// ====================================================================
// Config grid (the HONEST N is every config x both surrogate runs included)
// ====================================================================
function buildConfigs(): StratConfig[] {
  const configs: StratConfig[] = [];
  const cadences = [3, 7, 14]; // short-term to medium
  const lookbacks = [1, 2, 4];
  const quantiles = [0.2, 0.33];
  for (const cadenceDays of cadences) {
    for (const lookbackPeriods of lookbacks) {
      for (const quantile of quantiles) {
        // (A) reversal
        configs.push({
          id: `rev_c${cadenceDays}_l${lookbackPeriods}_q${Math.round(quantile * 100)}`,
          angle: "reversal",
          cadenceDays,
          lookbackPeriods,
          holdPeriods: 1,
          quantile,
          longOnly: false,
        });
        // (B) momentum
        configs.push({
          id: `mom_c${cadenceDays}_l${lookbackPeriods}_q${Math.round(quantile * 100)}`,
          angle: "momentum",
          cadenceDays,
          lookbackPeriods,
          holdPeriods: 1,
          quantile,
          longOnly: false,
        });
      }
    }
  }
  // (C) low-turnover trend filter: slow cadence, long lookback
  for (const cadenceDays of [14, 30]) {
    for (const lookbackPeriods of [3, 6]) {
      configs.push({
        id: `trend_c${cadenceDays}_l${lookbackPeriods}`,
        angle: "trend",
        cadenceDays,
        lookbackPeriods,
        holdPeriods: 1,
        quantile: 0.33,
        longOnly: true,
      });
    }
  }
  return configs;
}

// ====================================================================
// Surrogate panels (phase-randomized & block-bootstrap) — destroy cross-section
// ====================================================================
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build daily log-return series per symbol from closes (null-aware, contiguous runs). */
function dailyLogReturns(panel: Panel): (number | null)[][] {
  return panel.closes.map((series) => {
    const out: (number | null)[] = [null];
    for (let t = 1; t < series.length; t += 1) {
      const a = series[t - 1];
      const b = series[t];
      out.push(a != null && b != null && a > 0 && b > 0 ? Math.log(b / a) : null);
    }
    return out;
  });
}

/** Reconstruct a close panel from per-symbol daily log-returns, keeping the same
 * presence mask (null where original was null) and the same first valid price. */
function rebuildCloses(
  panel: Panel,
  logRets: (number | null)[][],
): (number | null)[][] {
  return panel.closes.map((orig, i) => {
    const out: (number | null)[] = new Array(orig.length).fill(null);
    // find first valid index
    let firstValid = orig.findIndex((v) => v != null);
    if (firstValid < 0) return out;
    let price = orig[firstValid] as number;
    out[firstValid] = price;
    for (let t = firstValid + 1; t < orig.length; t += 1) {
      if (orig[t] == null) {
        out[t] = null;
        continue;
      }
      const lr = logRets[i][t];
      if (lr != null && Number.isFinite(lr)) price = price * Math.exp(lr);
      out[t] = price;
    }
    return out;
  });
}

/** In-place iterative radix-2 FFT (Cooley-Tukey). re/im length must be power of 2.
 * dir = -1 forward, +1 inverse (inverse divides by n at the call site). */
function fft(re: Float64Array, im: Float64Array, dir: number): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (dir * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const bI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + len / 2] = aR - bR;
        im[i + k + len / 2] = aI - bI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

/** Phase-randomization surrogate (FFT-based, O(n log n)): randomize Fourier phases
 * of each symbol's daily log-return series independently => preserves the power
 * spectrum (vol + autocorr) but destroys cross-sectional alignment / genuine
 * structure. Series is zero-padded to the next power of 2, transformed, phases of
 * the positive frequencies are randomized with conjugate symmetry (real output),
 * inverse-transformed, then the first n samples are taken. */
function phaseRandomizeSurrogate(panel: Panel, seed: number): Panel {
  const rng = mulberry32(seed);
  const logRets = dailyLogReturns(panel);
  const surr = logRets.map((series) => {
    const idx: number[] = [];
    const vals: number[] = [];
    series.forEach((v, t) => {
      if (v != null && Number.isFinite(v)) {
        idx.push(t);
        vals.push(v);
      }
    });
    const n = vals.length;
    if (n < 8) return series;
    let m = 1;
    while (m < n) m <<= 1;
    const re = new Float64Array(m);
    const im = new Float64Array(m);
    for (let t = 0; t < n; t += 1) re[t] = vals[t];
    fft(re, im, -1);
    // randomize phases keeping magnitudes, enforce conjugate symmetry
    const mag = new Float64Array(m);
    for (let k = 0; k < m; k += 1) mag[k] = Math.hypot(re[k], im[k]);
    const half = m >> 1;
    const ph = new Float64Array(m);
    for (let k = 1; k < half; k += 1) {
      const a = (rng() * 2 - 1) * Math.PI;
      ph[k] = a;
      ph[m - k] = -a;
    }
    // DC (k=0) and Nyquist (k=half) keep zero phase to stay real
    for (let k = 0; k < m; k += 1) {
      re[k] = mag[k] * Math.cos(ph[k]);
      im[k] = mag[k] * Math.sin(ph[k]);
    }
    fft(re, im, 1);
    const res = series.slice();
    idx.forEach((t, j) => {
      res[t] = re[j] / m;
    });
    return res;
  });
  return { ...panel, closes: rebuildCloses(panel, surr) };
}

/** Block-bootstrap surrogate: resample each symbol's daily log-returns in blocks of
 * length L (preserves short-range autocorrelation & vol clustering), independently
 * per symbol => destroys cross-sectional co-movement / regime structure. */
function blockBootstrapSurrogate(panel: Panel, seed: number, blockLen = 10): Panel {
  const rng = mulberry32(seed);
  const logRets = dailyLogReturns(panel);
  const surr = logRets.map((series) => {
    const idx: number[] = [];
    const vals: number[] = [];
    series.forEach((v, t) => {
      if (v != null && Number.isFinite(v)) {
        idx.push(t);
        vals.push(v);
      }
    });
    const n = vals.length;
    if (n < blockLen + 1) return series;
    const resampled: number[] = [];
    while (resampled.length < n) {
      const start = Math.floor(rng() * n);
      for (let o = 0; o < blockLen && resampled.length < n; o += 1) {
        resampled.push(vals[(start + o) % n]);
      }
    }
    const res = series.slice();
    idx.forEach((t, j) => {
      res[t] = resampled[j];
    });
    return res;
  });
  return { ...panel, closes: rebuildCloses(panel, surr) };
}

// ====================================================================
// Search: pick best config by SEARCH-WINDOW net Sharpe (annualized)
// ====================================================================
interface SearchEval {
  cfg: StratConfig;
  searchSharpeAnnual: number;
  searchNet: number[]; // period net returns within search window
  periodsPerYear: number;
}

function annualizeSharpe(perPeriodSharpe: number, periodsPerYear: number): number {
  return perPeriodSharpe * Math.sqrt(periodsPerYear);
}

/** Evaluate all configs on the SEARCH window only; return per-config eval. */
function evaluateConfigs(
  panel: Panel,
  configs: StratConfig[],
  sizeUsd: number,
  searchEndPeriodFrac: number,
): SearchEval[] {
  return configs.map((cfg) => {
    const bt = backtest(panel, cfg, sizeUsd);
    const m = bt.periodNet.length;
    const searchEnd = Math.floor(m * searchEndPeriodFrac);
    const searchNet = bt.periodNet.slice(0, searchEnd);
    const stats = summarizeReturnSeries(searchNet);
    const periodsPerYear = SHARPE_PERIODS_PER_YEAR_BASE / cfg.cadenceDays;
    return {
      cfg,
      searchSharpeAnnual: annualizeSharpe(stats.sharpe, periodsPerYear),
      searchNet,
      periodsPerYear,
    };
  });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

// ====================================================================
// MAIN
// ====================================================================
function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: HERE }).toString().trim();
  } catch {
    return "unknown";
  }
}

function main(): void {
  const panel = loadPanel();
  const configs = buildConfigs();
  const nConfigs = configs.length;

  // Honest N = configs evaluated on REAL data + configs on each surrogate run.
  const N_SURROGATE_RUNS = 40; // 20 phase-random + 20 block-bootstrap
  const TRUE_N = nConfigs * (1 + N_SURROGATE_RUNS);

  console.log("=".repeat(78));
  console.log("FRONT R2 — ILLIQUID / SMALL-CAP EDGE AUDIT");
  console.log("=".repeat(78));
  console.log(`panel  : ${panel.symbols.length} small-caps, ${panel.dates.length} days ` +
    `(${panel.dates[0]}..${panel.dates.at(-1)})`);
  console.log(`names  : ${panel.symbols.join(", ")}`);
  const medDepth = [...panel.depthUsd50bps].sort((a, b) => a - b)[panel.depthUsd50bps.length >> 1];
  const medSpread = [...panel.spreadBps].sort((a, b) => a - b)[panel.spreadBps.length >> 1];
  console.log(`liquid : median spread=${medSpread.toFixed(1)}bps, median depth±50bps=$${(medDepth / 1e3).toFixed(0)}k`);
  console.log(`configs: ${nConfigs} (reversal/momentum/trend grid)`);
  console.log(`HONEST N (multiple-testing): ${nConfigs} real x (1 + ${N_SURROGATE_RUNS} surrogate runs) = ${TRUE_N}`);
  console.log(`cost   : taker ${TAKER_BPS}bps/side + half-spread(>=${SPREAD_FLOOR_BPS}bps floor) + depth slippage; size sweep $${SIZES_USD.join("/$")}`);
  console.log(`gates  : DSR>=${DSR_THRESHOLD}, PBO<${PBO_THRESHOLD}, beat B&H+lottery+linear, Harvey-Liu haircut, consume-once holdout`);
  console.log(
    "\nSURVIVORSHIP: panel = small-caps liquid TODAY; the small-cap graveyard is gone.\n" +
      "             Any edge is a STRONG UPPER BOUND. A marginal pass = a FAIL.\n",
  );

  const report: Record<string, unknown> = {
    experiment: "r2-illiquid-smallcap-audit",
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    panel: {
      symbols: panel.symbols,
      days: panel.dates.length,
      firstDate: panel.dates[0],
      lastDate: panel.dates.at(-1),
      medianSpreadBps: medSpread,
      medianDepthUsd50bps: medDepth,
    },
    honestN: TRUE_N,
    nConfigs,
    nSurrogateRuns: N_SURROGATE_RUNS,
    sizes: SIZES_USD,
  };

  // We do the full audit at the SMALLER size ($5k) as the primary (least slippage =>
  // most generous to the hypothesis); then report $25k degradation for capacity.
  const sizeResults: Record<string, unknown>[] = [];

  for (const sizeUsd of SIZES_USD) {
    console.log("=".repeat(78));
    console.log(`SIZE = $${sizeUsd.toLocaleString()}`);
    console.log("=".repeat(78));

    // ---- Holdout plan on PERIODS. We define the search window as the first ~70%
    // of the longest config's periods; the vault is the most-recent ~30%. Because
    // cadence varies, we plan per-config on its own period count but keep the SAME
    // time fraction so the vault is the same calendar block for all configs. ----
    const SEARCH_FRAC = 0.7;

    // ---- Evaluate all configs on the SEARCH window (real data) ----
    const evals = evaluateConfigs(panel, configs, sizeUsd, SEARCH_FRAC);
    const ranked = [...evals].sort((a, b) => b.searchSharpeAnnual - a.searchSharpeAnnual);
    const champ = ranked[0];
    console.log(`\nTop 5 configs by SEARCH-window net annualized Sharpe (size $${sizeUsd}):`);
    for (const e of ranked.slice(0, 5)) {
      console.log(
        `  ${e.cfg.id.padEnd(20)} ${e.cfg.angle.padEnd(9)} ` +
          `cad=${e.cfg.cadenceDays}d look=${e.cfg.lookbackPeriods} q=${e.cfg.quantile}  ` +
          `searchSharpe(ann)=${e.searchSharpeAnnual.toFixed(3)}  n=${e.searchNet.length}`,
      );
    }
    const realBestSearchSharpe = champ.searchSharpeAnnual;

    // ================= SURROGATE / PLACEBO CONTROL =================
    // Run the IDENTICAL search machinery on surrogate panels; record the BEST
    // search Sharpe each surrogate produces. Placebo p = P(surrogate best >= real best).
    console.log(`\n-- Surrogate / placebo control (${N_SURROGATE_RUNS} runs, identical search) --`);
    const surrogateBests: number[] = [];
    const halfRuns = N_SURROGATE_RUNS / 2;
    for (let r = 0; r < N_SURROGATE_RUNS; r += 1) {
      const sp =
        r < halfRuns
          ? phaseRandomizeSurrogate(panel, 7919 + r * 101)
          : blockBootstrapSurrogate(panel, 104729 + r * 211, 10);
      const sevals = evaluateConfigs(sp, configs, sizeUsd, SEARCH_FRAC);
      const best = Math.max(...sevals.map((e) => e.searchSharpeAnnual));
      surrogateBests.push(best);
    }
    surrogateBests.sort((a, b) => a - b);
    const nGE = surrogateBests.filter((s) => s >= realBestSearchSharpe - 1e-9).length;
    const placeboP = (nGE + 1) / (N_SURROGATE_RUNS + 1); // +1 smoothing
    const surrMean = surrogateBests.reduce((a, b) => a + b, 0) / surrogateBests.length;
    const surrMax = surrogateBests.at(-1)!;
    const surrMedian = surrogateBests[surrogateBests.length >> 1];
    console.log(`   real champion search Sharpe(ann) = ${realBestSearchSharpe.toFixed(3)}`);
    console.log(
      `   surrogate best Sharpe: mean=${surrMean.toFixed(3)} median=${surrMedian.toFixed(3)} max=${surrMax.toFixed(3)}`,
    );
    console.log(`   placebo p (surrogate best >= real best) = ${placeboP.toFixed(4)}  [n>=real = ${nGE}/${N_SURROGATE_RUNS}]`);
    const placeboPass = placeboP <= 0.05;
    console.log(`   placebo verdict: ${placeboPass ? "PASS (real > surrogates)" : "FAIL (search artifact — surrogates match real)"}`);

    // ================= GATE A: DSR on champion FULL series with honest N =========
    const champBt = backtest(panel, champ.cfg, sizeUsd);
    const champStats = summarizeReturnSeries(champBt.periodNet);
    const dsr = computeDeflatedSharpeRatio(champBt.periodNet, { trialCount: TRUE_N });
    const dsrPass = dsr.deflatedProbability >= DSR_THRESHOLD;
    console.log(`\n[GATE A] DSR (champion ${champ.cfg.id}, full series, honest N=${TRUE_N}):`);
    console.log(
      `   per-period sharpe=${champStats.sharpe.toFixed(4)}  deflatedProb=${dsr.deflatedProbability.toFixed(4)}  ` +
        `expMaxSharpe=${dsr.expectedMaxSharpe.toFixed(4)}  -> ${dsrPass ? "PASS" : "FAIL"}`,
    );

    // ================= GATE B: CPCV / PBO across all configs =====================
    // Build fold returns per config; need equal fold counts. Use the config with the
    // FEWEST periods to set a common fold structure; resample each config's period-net
    // to K folds by contiguous splitting on its own series (period-aligned in time
    // fraction). To keep folds comparable we use the SAME number of folds K and split
    // each config's series into K contiguous equal blocks.
    const K = 6;
    const allBt = configs.map((cfg) => ({ cfg, bt: backtest(panel, cfg, sizeUsd) }));
    const strategies: CscvStrategyFoldReturns[] = allBt
      .filter(({ bt }) => bt.periodNet.length >= K * 3)
      .map(({ cfg, bt }) => {
        const series = bt.periodNet;
        const folds: number[][] = [];
        const foldSize = Math.floor(series.length / K);
        for (let f = 0; f < K; f += 1) {
          const start = f * foldSize;
          const end = f === K - 1 ? series.length : start + foldSize;
          folds.push(series.slice(start, end));
        }
        return { id: cfg.id, folds };
      });
    let pboRes: ReturnType<typeof estimateCscvPbo> | null = null;
    let pboPass = false;
    try {
      pboRes = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });
      pboPass = pboRes.pbo < PBO_THRESHOLD;
      console.log(`\n[GATE B] CPCV/PBO (${strategies.length} strategies, ${K} folds, statistic=sharpe):`);
      console.log(
        `   PBO=${pboRes.pbo.toFixed(3)}  medianLogit=${pboRes.medianLogit.toFixed(3)}  -> ${pboPass ? "PASS" : "FAIL"}`,
      );
    } catch (e) {
      console.log(`\n[GATE B] CPCV/PBO error: ${(e as Error).message}`);
    }

    // ================= GATE C: consume-once HOLDOUT =============================
    // Re-plan holdout on the champion's own period series; vault = most recent 30%.
    const M = champBt.periodNet.length;
    const hp = planHoldoutSplit({ totalRows: M, holdoutFraction: 0.3, testFraction: 0.0 });
    const searchEnd = hp.search.end;
    const vaultStart = hp.finalHoldout.start;
    const vaultEnd = hp.finalHoldout.end;
    assertSearchDoesNotTouchHoldout({ searchMaxIndexExclusive: searchEnd, holdoutStartIndex: vaultStart });
    const vaultNet = champBt.periodNet.slice(vaultStart, vaultEnd);
    const vaultStats = summarizeReturnSeries(vaultNet);
    const guard = new FinalHoldoutGuard();
    guard.consume({
      reason: `r2-smallcap-${champ.cfg.id}-size${sizeUsd}`,
      gitSha: report.gitSha as string,
      trialCount: TRUE_N,
      nowIso: new Date().toISOString(),
    });
    const vaultPeriodsPerYear = SHARPE_PERIODS_PER_YEAR_BASE / champ.cfg.cadenceDays;
    const vaultSharpeAnnual = annualizeSharpe(vaultStats.sharpe, vaultPeriodsPerYear);
    const vaultTurnover = champBt.periodTurnover.slice(vaultStart, vaultEnd);
    const vaultCost = champBt.periodCost.slice(vaultStart, vaultEnd);
    const avgTurnover = vaultTurnover.reduce((a, b) => a + b, 0) / Math.max(1, vaultTurnover.length);
    const totalCostDrag = vaultCost.reduce((a, b) => a + b, 0);
    const holdoutPositive = vaultStats.sharpe > 0 && vaultStats.compoundReturn > 0;
    console.log(`\n[GATE C] Consume-once HOLDOUT (vault = most-recent ${vaultNet.length} periods):`);
    console.log(
      `   vault per-period sharpe=${vaultStats.sharpe.toFixed(4)} (ann ${vaultSharpeAnnual.toFixed(3)})  ` +
        `compoundRet=${pct(vaultStats.compoundReturn)}  avgTurnover=${avgTurnover.toFixed(2)}  ` +
        `costDrag=${pct(totalCostDrag)}  -> ${holdoutPositive ? "PASS" : "FAIL"}`,
    );

    // ================= GATE D: baselines on the SAME vault window ===============
    // Equal-weight small-cap basket daily returns => aggregate to champion cadence
    // for the buy&hold / linear baselines over the vault calendar block.
    const vaultStartIdx = champBt.periodEndIdx[vaultStart] ?? 0;
    const vaultEndIdx = champBt.periodEndIdx[vaultEnd - 1] ?? panel.dates.length - 1;
    // equal-weight basket per-period return over the vault, net of one round-trip cost
    const basketPeriod: number[] = [];
    for (let p = vaultStart; p + 1 <= vaultEnd - 1 && p + 1 < champBt.periodEndIdx.length; p += 1) {
      const a = champBt.periodEndIdx[p];
      const b = champBt.periodEndIdx[p + 1];
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < panel.closes.length; i += 1) {
        const r = ret(panel.closes[i][a], panel.closes[i][b]);
        if (r != null) {
          sum += r;
          cnt += 1;
        }
      }
      if (cnt > 0) basketPeriod.push(sum / cnt);
    }
    const champRoundTripCost = perSideCostFraction(medSpread, medDepth, sizeUsd * 0.4) * 2;
    const bah = buildBuyAndHoldBaseline({
      barReturns: basketPeriod,
      roundTripCost: champRoundTripCost,
      statistic: "compoundReturn",
    });
    const lottery = buildRandomLotteryBaseline({
      barReturns: basketPeriod,
      tradeCount: Math.max(1, Math.round(avgTurnover * vaultNet.length)),
      averageHoldingBars: 1,
      roundTripCost: champRoundTripCost,
      iterations: 1024,
      quantile: 0.95,
      allowShort: true,
      statistic: "compoundReturn",
      seed: `r2-${champ.cfg.id}`,
    });
    const linear = baselineScoreFromReturns(
      "linear_one_layer",
      "Small-cap equal-weight (linear)",
      basketPeriod,
      { statistic: "compoundReturn", source: "equal_weight_basket" },
    );
    const baseGate = evaluateBaselineGate({
      candidateReturns: vaultNet,
      baselines: [bah, lottery, linear],
      statistic: "compoundReturn",
      minMargin: 0,
      requirePositive: true,
    });
    console.log(`\n[GATE D] Baselines (vault window, compoundReturn, net of cost):`);
    console.log(`   candidate=${pct(baseGate.candidateScore)}`);
    for (const c of baseGate.comparisons) {
      console.log(`   vs ${c.id.padEnd(16)} base=${pct(c.baselineScore)} margin=${pct(c.margin)} ${c.beaten ? "beat" : "LOSE"}`);
    }
    console.log(`   -> ${baseGate.passed ? "PASS" : "FAIL"} (${baseGate.reasons.join(",") || "ok"})`);

    // ================= GATE E: Harvey-Liu haircut ==============================
    const hc = haircutSharpe({
      observedSharpe: vaultStats.sharpe,
      sampleCount: vaultNet.length,
      trialCount: TRUE_N,
      method: "bhy",
    });
    const hcBonf = haircutSharpe({
      observedSharpe: vaultStats.sharpe,
      sampleCount: vaultNet.length,
      trialCount: TRUE_N,
      method: "bonferroni",
    });
    const haircutOk = hc.haircutSharpe > 0 && hc.adjustedPValue <= 0.05;
    console.log(`\n[GATE E] Harvey-Liu haircut (N=${TRUE_N}, vault per-period sharpe=${hc.observedSharpe.toFixed(4)}):`);
    console.log(`   BHY:        p=${hc.pValue.toFixed(4)} adjP=${hc.adjustedPValue.toFixed(4)} haircutSharpe=${hc.haircutSharpe.toFixed(4)} -> ${haircutOk ? "PASS" : "FAIL"}`);
    console.log(`   Bonferroni: p=${hcBonf.pValue.toFixed(4)} adjP=${hcBonf.adjustedPValue.toFixed(4)} haircutSharpe=${hcBonf.haircutSharpe.toFixed(4)}`);

    // ================= Capacity ceiling ========================================
    // Deployable capital is capped by depth: trading more than ~10% of the ±50bps
    // book per name per rebalance blows up slippage. With ~2*quantile*N names traded
    // and avgTurnover weight churn, max prudent per-name notional ~= 10% of depth.
    const tradedNames = Math.max(1, Math.round(panel.symbols.length * champ.cfg.quantile * 2));
    const minDepth = Math.min(...panel.depthUsd50bps);
    const capacityPerName = 0.1 * medDepth; // 10% of median book per name per rebalance
    const capacityCeiling = capacityPerName * tradedNames; // gross deployable
    console.log(`\n[CAPACITY] traded names~=${tradedNames}, median depth±50bps=$${(medDepth / 1e3).toFixed(0)}k, min depth=$${(minDepth / 1e3).toFixed(0)}k`);
    console.log(`   prudent per-name notional (10% of book) ~= $${(capacityPerName / 1e3).toFixed(1)}k`);
    console.log(`   => CAPACITY CEILING ~= $${(capacityCeiling / 1e3).toFixed(0)}k gross deployable before slippage dominates`);

    // ---- Net monthly $ at this size if it survived ----
    const monthlyReturnEst = vaultStats.mean * (SHARPE_PERIODS_PER_YEAR_BASE / champ.cfg.cadenceDays) / 12;
    const monthlyDollar = monthlyReturnEst * sizeUsd;
    console.log(`\n[MONTHLY $] est net monthly return=${pct(monthlyReturnEst)} on $${sizeUsd} => $${monthlyDollar.toFixed(0)}/mo (IF survived)`);

    // ---- Overall verdict for this size ----
    const gates = {
      placebo: placeboPass,
      dsr: dsrPass,
      pbo: pboPass,
      holdout: holdoutPositive,
      baselines: baseGate.passed,
      haircut: haircutOk,
    };
    const firstFail = Object.entries(gates).find(([, v]) => !v)?.[0] ?? null;
    const allPass = Object.values(gates).every(Boolean);
    console.log(`\nGATES: ${JSON.stringify(gates)}`);
    console.log(`VERDICT (size $${sizeUsd}): ${allPass ? "SURVIVE" : "KILL"}${firstFail ? ` — first gate to kill: ${firstFail}` : ""}`);

    sizeResults.push({
      sizeUsd,
      champion: champ.cfg,
      realBestSearchSharpe,
      placebo: { p: placeboP, surrMean, surrMedian, surrMax, nGE, pass: placeboPass },
      dsr: { deflatedProbability: dsr.deflatedProbability, perPeriodSharpe: champStats.sharpe, expectedMaxSharpe: dsr.expectedMaxSharpe, pass: dsrPass },
      pbo: pboRes ? { pbo: pboRes.pbo, medianLogit: pboRes.medianLogit, pass: pboPass } : null,
      holdout: { vaultPeriods: vaultNet.length, perPeriodSharpe: vaultStats.sharpe, annualSharpe: vaultSharpeAnnual, compoundReturn: vaultStats.compoundReturn, avgTurnover, costDrag: totalCostDrag, pass: holdoutPositive },
      baselines: { candidate: baseGate.candidateScore, comparisons: baseGate.comparisons, pass: baseGate.passed },
      haircut: { bhyAdjP: hc.adjustedPValue, bhyHaircutSharpe: hc.haircutSharpe, bonfAdjP: hcBonf.adjustedPValue, pass: haircutOk },
      capacity: { tradedNames, medianDepthUsd50bps: medDepth, minDepthUsd50bps: minDepth, capacityCeilingUsd: capacityCeiling },
      monthly: { netMonthlyReturn: monthlyReturnEst, netMonthlyDollar: monthlyDollar },
      gates,
      verdict: allPass ? "SURVIVE" : "KILL",
      firstGateToKill: firstFail,
    });
  }

  report.sizeResults = sizeResults;
  // Overall verdict: must SURVIVE at BOTH sizes (or at least the smallest) to count.
  const primary = sizeResults[0] as Record<string, unknown>; // $5k
  report.overallVerdict = primary.verdict;
  report.overallFirstGateToKill = primary.firstGateToKill;

  writeFileSync(join(OUT_DIR, "smallcap-audit-report.json"), JSON.stringify(report, null, 2));

  console.log("\n" + "=".repeat(78));
  console.log(`OVERALL VERDICT (primary $${SIZES_USD[0]} size): ${primary.verdict}` +
    (primary.firstGateToKill ? ` — killed by: ${primary.firstGateToKill}` : ""));
  console.log("Report written to output/r2-illiquid/smallcap-audit-report.json");
  console.log("=".repeat(78));
}

main();
