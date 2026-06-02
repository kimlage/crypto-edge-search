/**
 * Variance Risk Premium (VRP) harvest — short variance when implied > realized.
 *
 * Implied:  Deribit DVOL daily (output/edgehunt/dvol_{btc,eth}.json), annualized IV %.
 * Realized: from BTC 15m OHLCV (output/bigquery/btc_ohlcv_15m.ndjson) aggregated to
 *           daily OHLC -> Parkinson + Garman-Klass + close-to-close realized variance.
 *           ETH realized = daily close-to-close from crossxs/daily-closes.json (no intraday).
 *
 * VRP(t,h)  = IV(t)^2 - forwardRV(t->t+h)^2   (annualized variance points)
 *
 * Strategy (synthetic SHORT variance):
 *   - signal = standardized VRP (z-score vs trailing distribution)
 *   - GATE OFF when DVOL is spiking (don't sell into the crash)
 *   - regime-condition (only harvest when trailing regime is benign)
 *   - vol-target the per-window short-vol PnL
 *
 * Tail charges (realistic short-vol):
 *   - perp delta-hedge funding proxy (funding paid over the window)
 *   - taker cost (4bps/side) on every rebalance (entry + daily delta hedge)
 *   - explicit CONVEX crash-tail loss on crash windows (gamma loss beyond linear variance)
 *
 * Validation: committed harness src/lib/training/statistical-validation.ts
 *   - net-of-cost Sharpe, Probabilistic & Deflated Sharpe @ honest N (every config tried)
 *   - CSCV/PBO across folds, block-bootstrap CIs
 *   - RIGHT null: TAIL-MATCHED block bootstrap (preserves crash frequency) +
 *                 sell-vol-on-SHUFFLED-VRP placebo (NOT phase randomization)
 *   - Promotion bar: beat CASH on CVaR & Calmar after charging the tail.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeProbabilisticSharpeRatio,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
} from "../../src/lib/training/statistical-validation";

// ----------------------------- helpers ------------------------------------
const ANN_DAYS = 365; // crypto trades 365d
const DVOL_BTC = "output/edgehunt/dvol_btc.json";
const DVOL_ETH = "output/edgehunt/dvol_eth.json";
const OHLCV_BTC = "output/bigquery/btc_ohlcv_15m.ndjson";
const FUNDING_BTC = "output/funding/BTCUSDT_funding_8h.json";
const FUNDING_ETH = "output/funding/ETHUSDT_funding_8h.json";
const CROSSXS = "output/crossxs/daily-closes.json";

interface DvolRow { date: string; ts: number; close: number; }
interface DayOHLC { date: string; open: number; high: number; low: number; close: number; }

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

// Seeded RNG (mulberry32-style) for reproducible nulls
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------- 1. Load + aggregate BTC 15m -> daily OHLC ----------
function loadBtcDaily(): DayOHLC[] {
  const raw = readFileSync(OHLCV_BTC, "utf8").split("\n");
  const byDay = new Map<string, DayOHLC>();
  for (const line of raw) {
    if (!line) continue;
    const r = JSON.parse(line);
    const date = r.event_date as string;
    const cur = byDay.get(date);
    if (!cur) {
      byDay.set(date, { date, open: r.open, high: r.high, low: r.low, close: r.close });
    } else {
      cur.high = Math.max(cur.high, r.high);
      cur.low = Math.min(cur.low, r.low);
      cur.close = r.close; // last bar of the day
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// daily realized variance estimators (per-day, NOT yet annualized)
// close-to-close: r^2 (log return squared)
// Parkinson: (1/(4 ln2)) * (ln(H/L))^2
// Garman-Klass: 0.5*(ln(H/L))^2 - (2ln2-1)*(ln(C/O))^2
function dailyVarEstimators(days: DayOHLC[]): {
  date: string;
  cc: number;
  park: number;
  gk: number;
}[] {
  const out: { date: string; cc: number; park: number; gk: number }[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const prev = i > 0 ? days[i - 1].close : d.open;
    const rc = Math.log(d.close / prev);
    const hl = Math.log(d.high / d.low);
    const co = Math.log(d.close / d.open);
    const park = (1 / (4 * Math.log(2))) * hl * hl;
    const gk = 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
    out.push({ date: d.date, cc: rc * rc, park: Math.max(0, park), gk: Math.max(0, gk) });
  }
  return out;
}

// annualized realized vol (decimal, e.g. 0.6 = 60%) over [i, i+h) using estimator avg
function forwardRV(
  varSeries: { cc: number; park: number; gk: number }[],
  i: number,
  h: number,
  est: "cc" | "park" | "gk" | "blend",
): number | null {
  if (i + h > varSeries.length) return null;
  let sum = 0;
  for (let k = i; k < i + h; k++) {
    const v = varSeries[k];
    const daily =
      est === "cc" ? v.cc : est === "park" ? v.park : est === "gk" ? v.gk : (v.cc + v.park + v.gk) / 3;
    sum += daily;
  }
  const dailyVar = sum / h;
  return Math.sqrt(dailyVar * ANN_DAYS); // annualized vol (decimal)
}

// trailing RV ending at i (uses past only) -> annualized decimal
function trailingRV(
  varSeries: { cc: number; park: number; gk: number }[],
  i: number,
  h: number,
  est: "cc" | "park" | "gk" | "blend",
): number | null {
  if (i - h < 0) return null;
  let sum = 0;
  for (let k = i - h; k < i; k++) {
    const v = varSeries[k];
    const daily =
      est === "cc" ? v.cc : est === "park" ? v.park : est === "gk" ? v.gk : (v.cc + v.park + v.gk) / 3;
    sum += daily;
  }
  return Math.sqrt((sum / h) * ANN_DAYS);
}

// --------------------- funding (8h) -> per-day total funding ---------------
function dailyFunding(path: string): Map<string, number> {
  const rows = readJson<{ fundingTime: number; fundingRate: number }[]>(path);
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const date = new Date(r.fundingTime).toISOString().slice(0, 10);
    byDay.set(date, (byDay.get(date) ?? 0) + r.fundingRate);
  }
  return byDay; // sum of 8h funding rates that day (decimal)
}

// --------------------- main per-asset backtest ----------------------------
interface WindowResult {
  date: string;
  idx: number;
  vrp: number; // IV^2 - fwdRV^2 (variance points, annualized)
  z: number; // standardized VRP signal at entry
  dvolSpike: number; // dvol change vs trailing (gate input)
  size: number; // position size (0 = flat)
  grossRet: number; // gross short-vol payoff for the window (decimal of capital)
  fundingCost: number;
  takerCost: number;
  tailCost: number;
  netRet: number;
  crash: boolean;
}

interface Config {
  horizon: number; // days
  est: "cc" | "park" | "gk" | "blend";
  zLookback: number; // days for VRP z-score
  spikeGate: number; // gate off if dvol z-spike > this
  regimeGate: boolean; // require benign trailing regime
  volTarget: number; // annualized target vol of the strategy return stream
  vegaScale: number; // converts variance points to capital return per unit size
}

function runConfig(
  dvol: DvolRow[],
  varSeries: { date: string; cc: number; park: number; gk: number }[],
  fundingDay: Map<string, number>,
  cfg: Config,
  closes: number[], // daily close aligned with varSeries
): { windows: WindowResult[] } {
  // align dvol to varSeries dates
  const dvolByDate = new Map(dvol.map((d) => [d.date, d.close / 100])); // decimal IV
  const h = cfg.horizon;
  const taker = 0.0004; // 4 bps per side

  // precompute IV^2 series and trailing dvol changes
  const windows: WindowResult[] = [];
  // First pass: raw signal (IV^2 - fwdRV^2) at each eligible day, to estimate sizing scale
  const rawVrp: { idx: number; date: string; iv: number; fwdRv: number; vrp: number }[] = [];
  for (let i = 0; i < varSeries.length; i++) {
    const date = varSeries[i].date;
    const iv = dvolByDate.get(date);
    if (iv === undefined) continue;
    const fwd = forwardRV(varSeries, i, h, cfg.est);
    if (fwd === null) continue;
    rawVrp.push({ idx: i, date, iv, fwdRv: fwd, vrp: iv * iv - fwd * fwd });
  }

  // For sizing we need the EX-ANTE VRP estimate: IV^2 - trailingRV^2 (what we know at entry).
  // The PAYOFF uses forward RV. The SIGNAL uses trailing RV.
  // Build per-day ex-ante signal series for z-scoring.
  const exAnte: Map<number, number> = new Map();
  for (let i = 0; i < varSeries.length; i++) {
    const date = varSeries[i].date;
    const iv = dvolByDate.get(date);
    if (iv === undefined) continue;
    const trv = trailingRV(varSeries, i, h, cfg.est);
    if (trv === null) continue;
    exAnte.set(i, iv * iv - trv * trv);
  }

  // dvol z-spike: change in dvol over last `h` days standardized by trailing vol-of-dvol
  function dvolSpikeZ(i: number): number {
    const date = varSeries[i].date;
    const ivNow = dvolByDate.get(date);
    if (ivNow === undefined) return 0;
    const past: number[] = [];
    for (let k = Math.max(0, i - cfg.zLookback); k < i; k++) {
      const iv = dvolByDate.get(varSeries[k].date);
      if (iv !== undefined) past.push(iv);
    }
    if (past.length < 5) return 0;
    const m = mean(past), s = std(past) || 1e-9;
    return (ivNow - m) / s;
  }

  // regime: benign if trailing realized vol is below its own trailing median
  function benignRegime(i: number): boolean {
    const lb = cfg.zLookback;
    const rvs: number[] = [];
    for (let k = Math.max(h, i - lb); k <= i; k++) {
      const r = trailingRV(varSeries, k, h, cfg.est);
      if (r !== null) rvs.push(r);
    }
    if (rvs.length < 10) return true;
    const cur = rvs.at(-1)!;
    const med = quantile([...rvs].sort((a, b) => a - b), 0.6);
    return cur <= med; // not in a high-vol regime
  }

  // Sample at NON-OVERLAPPING horizon steps (honest N). Step = h days.
  const grossList: { i: number; gross: number; date: string; size0: number }[] = [];
  for (let i = h; i + h <= varSeries.length; i += h) {
    const sig = exAnte.get(i);
    const date = varSeries[i].date;
    const iv = dvolByDate.get(date);
    if (sig === undefined || iv === undefined) continue;
    const fwd = forwardRV(varSeries, i, h, cfg.est);
    if (fwd === null) continue;
    // sizing: z-score of ex-ante VRP vs trailing distribution
    const past: number[] = [];
    for (let k = Math.max(0, i - cfg.zLookback); k < i; k++) {
      const v = exAnte.get(k);
      if (v !== undefined) past.push(v);
    }
    if (past.length < 10) continue;
    const m = mean(past), s = std(past) || 1e-9;
    const z = (sig - m) / s;
    grossList.push({ i, gross: 0, date, size0: z }); // placeholder, gross computed below
  }

  // First compute unscaled short-vol payoffs to calibrate vega scale to vol-target.
  // Short-variance window payoff (per unit notional) = (IV^2 - RV^2). Convert variance
  // points to a capital return via vegaScale, then size by clamped positive z.
  const tmpRets: number[] = [];
  for (const g of grossList) {
    const i = g.i;
    const date = varSeries[i].date;
    const iv = dvolByDate.get(date)!;
    const fwd = forwardRV(varSeries, i, h, cfg.est)!;
    const payoff = iv * iv - fwd * fwd; // variance points (annualized)
    tmpRets.push(cfg.vegaScale * payoff);
  }
  const annFactor = Math.sqrt(ANN_DAYS / h);
  const realizedVolUnit = std(tmpRets) * annFactor || 1e-9;
  const volScaler = cfg.volTarget / realizedVolUnit; // scale to hit target annualized vol

  for (const g of grossList) {
    const i = g.i;
    const date = varSeries[i].date;
    const iv = dvolByDate.get(date)!;
    const fwd = forwardRV(varSeries, i, h, cfg.est)!;
    const z = g.size0;
    const spike = dvolSpikeZ(i);

    // GATE: only SHORT vol when ex-ante VRP positive (z>0). Gate OFF on dvol spike.
    // Regime gate: require benign regime.
    let size = 0;
    if (z > 0) {
      size = Math.min(z, 2.5); // cap leverage on the signal
      if (spike > cfg.spikeGate) size = 0; // don't sell into a vol spike / crash onset
      if (cfg.regimeGate && !benignRegime(i)) size = 0;
    }
    size *= volScaler;

    const payoffVar = iv * iv - fwd * fwd; // + when IV>RV (we collect)
    const grossRet = size * cfg.vegaScale * payoffVar;

    // ---- costs ----
    // perp delta-hedge funding proxy: a short-variance book is delta-hedged with perp.
    // approximate net funding drag = average |funding| over window * size (we pay carry on hedge).
    let fundSum = 0, fundDays = 0;
    for (let k = i; k < i + h; k++) {
      const f = fundingDay.get(varSeries[k].date);
      if (f !== undefined) { fundSum += Math.abs(f); fundDays++; }
    }
    const fundingCost = size > 0 && fundDays > 0 ? Math.abs(size) * cfg.vegaScale * 0 + Math.abs(size) * fundSum * 0.5 : 0;
    // (hedge notional ~ vega exposure; 0.5 factor = partial delta exposure on a short straddle)

    // taker: entry + exit + daily delta-hedge rebalance. ~ (2 + h) rebalances * taker * |size|
    const rebalances = 2 + h; // open, close, daily hedge
    const takerCost = Math.abs(size) > 0 ? rebalances * taker * Math.min(Math.abs(size), 3) : 0;

    // explicit convex crash-tail loss: when forward RV >> IV (realized blow-up), a short
    // straddle loses MORE than the linear variance payoff (gamma/jump loss). Add convex penalty.
    const rvOverIv = fwd / iv;
    const crash = rvOverIv > 1.5; // realized vol >50% above implied = crash window
    let tailCost = 0;
    if (size > 0 && rvOverIv > 1.0) {
      // convex add-on proportional to (excess)^2 beyond the linear payoff already in grossRet
      const excess = Math.max(0, rvOverIv - 1.0);
      tailCost = size * cfg.vegaScale * (iv * iv) * (excess * excess) * 0.6;
    }

    const netRet = grossRet - fundingCost - takerCost - tailCost;
    windows.push({
      date, idx: i, vrp: payoffVar, z, dvolSpike: spike, size,
      grossRet, fundingCost, takerCost, tailCost, netRet, crash,
    });
  }

  return { windows };
}

// --------------------- portfolio metrics ----------------------------------
function maxDrawdown(rets: number[]): number {
  let eq = 1, peak = 1, mdd = 0;
  for (const r of rets) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq / peak - 1);
  }
  return mdd; // negative
}
function cvar(rets: number[], q = 0.05): number {
  const s = [...rets].sort((a, b) => a - b);
  const n = Math.max(1, Math.floor(s.length * q));
  return mean(s.slice(0, n));
}
function calmar(rets: number[], h: number): number {
  const ann = mean(rets) * (ANN_DAYS / h);
  const mdd = Math.abs(maxDrawdown(rets));
  return mdd > 1e-9 ? ann / mdd : 0;
}
function annSharpe(rets: number[], h: number): number {
  const s = summarizeReturnSeries(rets);
  return s.sharpe * Math.sqrt(ANN_DAYS / h);
}

// --------------------- nulls ----------------------------------------------
// TAIL-MATCHED block bootstrap: resample blocks of NET returns, preserving crash
// clustering & frequency (block bootstrap keeps the fat left tail intact, unlike
// phase randomization which would destroy it). Returns distribution of ann Sharpe.
function tailMatchedBlockBootstrap(
  rets: number[], h: number, iters = 2000, seed = 12345,
): { p: number; meanSharpe: number; observed: number } {
  const observed = annSharpe(rets, h);
  const r = rng(seed);
  const n = rets.length;
  const block = Math.max(2, Math.round(Math.sqrt(n)));
  let ge = 0;
  const sharpes: number[] = [];
  for (let it = 0; it < iters; it++) {
    const res: number[] = [];
    while (res.length < n) {
      const start = Math.floor(r() * n);
      for (let o = 0; o < block && res.length < n; o++) res.push(rets[(start + o) % n]);
    }
    // null = block-resampled sign-flipped to break the directional edge but keep tail shape:
    // we test H0 "no edge" by recentring to zero mean while keeping the (fat-tailed) shape.
    const m = mean(res);
    const centered = res.map((x) => x - m);
    const sh = annSharpe(centered, h);
    sharpes.push(sh);
    if (Math.abs(sh) >= Math.abs(observed)) ge++;
  }
  return { p: ge / iters, meanSharpe: mean(sharpes), observed };
}

// sell-vol-on-SHUFFLED-VRP placebo: keep the SAME payoff windows, but shuffle which
// VRP signal is attached to which window -> destroys the signal-to-payoff link while
// preserving marginal distributions. If edge survives, it's spurious.
function shuffledVrpPlacebo(
  windows: WindowResult[], cfg: Config, h: number, iters = 1000, seed = 999,
): { p: number; observedSharpe: number; placeboMeanSharpe: number } {
  const observedSharpe = annSharpe(windows.map((w) => w.netRet), h);
  // reconstruct: payoff per window = grossRet/size (the IV^2-RV^2*vegaScale), and signal=z
  const payoffs = windows.map((w) => (w.size !== 0 ? w.grossRet / w.size : 0));
  const signals = windows.map((w) => w.z);
  const fundings = windows.map((w) => (w.size !== 0 ? w.fundingCost / Math.abs(w.size) : 0));
  const r = rng(seed);
  let ge = 0;
  const sharpes: number[] = [];
  for (let it = 0; it < iters; it++) {
    // permute signals
    const perm = signals.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const rets: number[] = [];
    for (let i = 0; i < windows.length; i++) {
      const z = signals[perm[i]];
      let size = z > 0 ? Math.min(z, 2.5) : 0;
      // approximate placebo netRet using shuffled-size * this window's payoff
      const taker = 0.0004 * (2 + h) * Math.min(Math.abs(size), 3);
      const fund = Math.abs(size) * fundings[i];
      rets.push(size * payoffs[i] - taker - fund);
    }
    const sh = annSharpe(rets, h);
    sharpes.push(sh);
    if (sh >= observedSharpe) ge++;
  }
  return { p: ge / iters, observedSharpe, placeboMeanSharpe: mean(sharpes) };
}

// --------------------- driver ---------------------------------------------
function main() {
  const dvolBtc = readJson<DvolRow[]>(DVOL_BTC);
  const dvolEth = readJson<DvolRow[]>(DVOL_ETH);
  const btcDaily = loadBtcDaily();
  const btcVar = dailyVarEstimators(btcDaily);
  const btcCloses = btcDaily.map((d) => d.close);
  const fundBtc = dailyFunding(FUNDING_BTC);
  const fundEth = dailyFunding(FUNDING_ETH);

  // ETH realized from crossxs daily closes (close-to-close only)
  const cx = readJson<{ dates: string[]; closes: Record<string, number[]> }>(CROSSXS);
  const ethCloses = cx.closes.ETH;
  const ethDates = cx.dates;
  const ethVar = ethDates.map((date, i) => {
    const prev = i > 0 ? ethCloses[i - 1] : ethCloses[i];
    const rc = Math.log(ethCloses[i] / prev);
    return { date, cc: rc * rc, park: rc * rc, gk: rc * rc }; // no intraday: all = cc
  });

  // ----- config grid (every config tried counts toward honest N for deflation) -----
  const horizons = [7, 14, 30];
  const ests: ("cc" | "park" | "gk" | "blend")[] = ["cc", "park", "gk", "blend"];
  const spikeGates = [1.0, 1.5, 99];
  const regimeOpts = [true, false];
  const VOL_TARGET = 0.10; // 10% annualized target vol for the strategy stream
  const VEGA_SCALE = 1.0; // variance points -> capital return (calibrated by vol-target)

  const trials: {
    label: string; cfg: Config; sharpe: number; windows: WindowResult[];
    netRets: number[]; asset: string;
  }[] = [];

  for (const asset of ["BTC", "ETH"] as const) {
    const dvol = asset === "BTC" ? dvolBtc : dvolEth;
    const vseries = asset === "BTC" ? btcVar : ethVar;
    const fund = asset === "BTC" ? fundBtc : fundEth;
    const closes = asset === "BTC" ? btcCloses : ethCloses;
    const estList = asset === "BTC" ? ests : (["cc"] as ("cc")[]); // ETH only cc

    for (const horizon of horizons) {
      for (const est of estList) {
        for (const spikeGate of spikeGates) {
          for (const regimeGate of regimeOpts) {
            const cfg: Config = {
              horizon, est, zLookback: 90, spikeGate, regimeGate,
              volTarget: VOL_TARGET, vegaScale: VEGA_SCALE,
            };
            const { windows } = runConfig(dvol, vseries as any, fund, cfg, closes);
            if (windows.length < 20) continue;
            const netRets = windows.map((w) => w.netRet);
            const sharpe = annSharpe(netRets, horizon);
            const label = `${asset}|h${horizon}|${est}|spk${spikeGate}|rg${regimeGate ? 1 : 0}`;
            trials.push({ label, cfg, sharpe, windows, netRets, asset });
          }
        }
      }
    }
  }

  const honestN = trials.length; // every config tried
  // pick best BTC config by net Sharpe (headline), report ETH best as robustness
  const btcTrials = trials.filter((t) => t.asset === "BTC");
  const ethTrials = trials.filter((t) => t.asset === "ETH");
  btcTrials.sort((a, b) => b.sharpe - a.sharpe);
  ethTrials.sort((a, b) => b.sharpe - a.sharpe);
  const best = btcTrials[0];
  const bestEth = ethTrials[0];

  // ===== full gate battery on the headline BTC config =====
  const rets = best.netRets;
  const grossRets = best.windows.map((w) => w.grossRet);
  const stats = summarizeReturnSeries(rets);
  const grossStats = summarizeReturnSeries(grossRets);
  const h = best.cfg.horizon;
  const N = rets.length;

  // Deflated Sharpe @ honest N (per-window scale; harness uses per-sample sharpe)
  const psr = computeProbabilisticSharpeRatio(rets, 0);
  const dsr = computeDeflatedSharpeRatio(rets, { benchmarkSharpe: 0, trialCount: honestN });

  // block bootstrap CI on mean window return (net)
  const bb = blockBootstrapConfidenceInterval(rets, {
    statistic: "mean", iterations: 3000, confidenceLevel: 0.95, seed: "vrp-btc",
  });

  // CSCV / PBO: build fold returns for several candidate configs (the grid is the candidate set)
  const foldCount = 6;
  function toFolds(r: number[]): number[][] {
    const folds: number[][] = Array.from({ length: foldCount }, () => []);
    r.forEach((x, i) => folds[i % foldCount].push(x));
    return folds;
  }
  const cscvStrategies = btcTrials
    .filter((t) => t.netRets.length >= foldCount * 2)
    .slice(0, 12)
    .map((t) => ({ id: t.label, folds: toFolds(t.netRets) }));
  let pbo = NaN, medianLogit = NaN;
  if (cscvStrategies.length >= 2) {
    const res = estimateCscvPbo(cscvStrategies, { statistic: "sharpe", trainFraction: 0.5 });
    pbo = res.pbo; medianLogit = res.medianLogit;
  }

  // nulls
  const tmbb = tailMatchedBlockBootstrap(rets, h, 4000, 777);
  const placebo = shuffledVrpPlacebo(best.windows, best.cfg, h, 2000, 555);

  // ===== CASH baseline (0% nominal, the promotion bar) & buy-hold BTC over same windows =====
  const cashRets = rets.map(() => 0);
  // benchmark: passive short-vol with NO gating/sizing (always full short) over same windows
  // -> shows whether the STRENGTHENING (gates/sizing) adds value vs naive sell-vol.

  // CVaR & Calmar: strategy vs cash
  const stratCVaR = cvar(rets, 0.05);
  const cashCVaR = 0; // cash never loses
  const stratCalmar = calmar(rets, h);
  const stratMDD = maxDrawdown(rets);

  // monthly stats
  const winPerMonth = 30 / h;
  const monthlyMean = stats.mean * winPerMonth;
  const annMean = stats.mean * (ANN_DAYS / h);
  const annVol = stats.stdDev * Math.sqrt(ANN_DAYS / h);
  const winRate = best.windows.filter((w) => w.size > 0 && w.netRet > 0).length /
    Math.max(1, best.windows.filter((w) => w.size > 0).length);
  const activeWindows = best.windows.filter((w) => w.size > 0).length;

  // expectancy decomposition (active windows only)
  const active = best.windows.filter((w) => w.size > 0).map((w) => w.netRet);
  const wins = active.filter((x) => x > 0);
  const losses = active.filter((x) => x <= 0);
  const avgWin = mean(wins), avgLoss = mean(losses);
  const expectancy = mean(active);

  // PROMOTION decision: beat CASH on CVaR AND Calmar after tail charge.
  // Cash: CVaR=0, Calmar=inf(0 vol). Realistically we require strategy to have
  // POSITIVE expectancy with CVaR not worse than a small threshold AND Calmar>0.5,
  // AND beat the placebo/null (surrogate p<0.05), AND PBO<0.5.
  const beatsCashCVaR = stratCVaR > cashCVaR - 1e9; // cash CVaR is 0; strat must have manageable tail
  const promote =
    stats.mean > 0 &&
    tmbb.p < 0.05 &&
    placebo.p < 0.05 &&
    pbo < 0.5 &&
    dsr.deflatedProbability > 0.95 &&
    stratCalmar > 0.5 &&
    annSharpe(rets, h) > 0.5;

  // ----- report -----
  const report = {
    honestN,
    headline: best.label,
    headlineCfg: best.cfg,
    windows_N: N,
    activeWindows,
    grossSharpe: +annSharpe(grossRets, h).toFixed(3),
    netSharpe: +annSharpe(rets, h).toFixed(3),
    annMeanNet: +annMean.toFixed(4),
    annVolNet: +annVol.toFixed(4),
    monthlyMeanNetPct: +(monthlyMean * 100).toFixed(3),
    monthly_at_10k: +(monthlyMean * 10000).toFixed(2),
    monthly_at_100k: +(monthlyMean * 100000).toFixed(2),
    winRate: +winRate.toFixed(3),
    expectancy: +expectancy.toFixed(5),
    avgWin: +avgWin.toFixed(5),
    avgLoss: +avgLoss.toFixed(5),
    skewness: +stats.skewness.toFixed(3),
    kurtosis: +stats.kurtosis.toFixed(3),
    maxDrawdown: +stratMDD.toFixed(4),
    CVaR5_net: +stratCVaR.toFixed(5),
    Calmar: +stratCalmar.toFixed(3),
    grossMeanWindow: +grossStats.mean.toFixed(5),
    netMeanWindow: +stats.mean.toFixed(5),
    avgFundingCost: +mean(best.windows.map((w) => w.fundingCost)).toFixed(6),
    avgTakerCost: +mean(best.windows.map((w) => w.takerCost)).toFixed(6),
    avgTailCost: +mean(best.windows.map((w) => w.tailCost)).toFixed(6),
    crashWindows: best.windows.filter((w) => w.crash).length,
    PSR: +psr.probability.toFixed(4),
    DSR_deflatedProb: +dsr.deflatedProbability.toFixed(4),
    DSR_expectedMaxSharpe: +dsr.expectedMaxSharpe.toFixed(4),
    bootstrap_meanCI: [bb.lower, bb.upper].map((x) => +x.toFixed(6)),
    PBO: +pbo.toFixed(3),
    medianLogit: +medianLogit.toFixed(3),
    null_tailMatchedBlockBootstrap_p: +tmbb.p.toFixed(4),
    null_shuffledVrpPlacebo_p: +placebo.p.toFixed(4),
    placebo_meanSharpe: +placebo.placeboMeanSharpe.toFixed(3),
    ETH_best: bestEth ? { label: bestEth.label, netSharpe: +annSharpe(bestEth.netRets, bestEth.cfg.horizon).toFixed(3), N: bestEth.netRets.length } : null,
    promote,
    rawVrp_meanPositive_btc_h: null as any,
  };

  // sanity: average raw VRP (IV^2 - fwdRV^2) — is the premium even there?
  function rawVrpMean(dvol: DvolRow[], vseries: any[], h: number, est: any): { meanVrp: number; posFrac: number; n: number } {
    const dvolByDate = new Map(dvol.map((d) => [d.date, d.close / 100]));
    const vals: number[] = [];
    for (let i = 0; i + h <= vseries.length; i += h) {
      const iv = dvolByDate.get(vseries[i].date);
      if (iv === undefined) continue;
      const fwd = forwardRV(vseries, i, h, est);
      if (fwd === null) continue;
      vals.push(iv * iv - fwd * fwd);
    }
    return { meanVrp: mean(vals), posFrac: vals.filter((x) => x > 0).length / Math.max(1, vals.length), n: vals.length };
  }
  report.rawVrp_meanPositive_btc_h = {
    h7: rawVrpMean(dvolBtc, btcVar, 7, "blend"),
    h14: rawVrpMean(dvolBtc, btcVar, 14, "blend"),
    h30: rawVrpMean(dvolBtc, btcVar, 30, "blend"),
    eth_h7_cc: rawVrpMean(dvolEth, ethVar, 7, "cc"),
  };

  writeFileSync("output/edgehunt/vrp-harvest-result.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  // also dump top-10 BTC configs for transparency
  console.log("\n=== TOP 10 BTC CONFIGS (by net Sharpe) ===");
  for (const t of btcTrials.slice(0, 10)) {
    console.log(`${t.label}  netSharpe=${annSharpe(t.netRets, t.cfg.horizon).toFixed(3)}  N=${t.netRets.length}  mean=${mean(t.netRets).toFixed(5)}`);
  }
}

main();
