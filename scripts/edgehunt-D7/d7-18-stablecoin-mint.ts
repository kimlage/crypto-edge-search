/**
 * D7.18 — Stablecoin mint-as-event (USDT/USDC prints precede pumps).
 *
 * Belief: large stablecoin mints ("printer go brrr") precede BTC/ETH pumps —
 * dry powder entering the system. Mechanism could equally be REVERSE causal:
 * mints respond to prior demand / inflows (issuers print AFTER price rises).
 *
 * Strongest-honest build:
 *  - Event = large positive daily change in TOTAL stablecoin supply (DefiLlama,
 *    cached output/edgehunt-D5/stablecoins_total.json). We z-score the daily
 *    log-change against a trailing 30d window and threshold (the "mint size").
 *  - CONFIRMATION DELAY: supply prints are not known intraday; we enter at the
 *    NEXT day's close-to-close (T+1) and also test T+2. Signal at day t uses
 *    only supply up to day t (PIT-clean).
 *  - Rule: on a mint event, go long BTC (or ETH) for the next H days; flat
 *    otherwise. Net of realistic cost.
 *
 * KEY control = REVERSE CAUSALITY / coincident demand. Mints may simply track
 *  trailing returns/flow. We regress the mint log-change on trailing BTC return
 *  (multiple lags) and re-derive the event from the RESIDUAL (orthogonalized)
 *  mint signal. We report the rule on the residual signal — if the edge dies,
 *  it was reverse causality.
 *
 * RIGHT null (event study, PIT):
 *  - PLACEBO MINTS: random fake mint dates, matched count, same horizon rule;
 *    surrogate p = fraction of placebo runs whose net Sharpe >= real.
 *  - Block bootstrap CI on the event-window net compound return.
 *
 * Long-beta trap (the NA/ND killer): a "long sometimes" rule samples BTC's bull
 *  legs. We report in-vs-out mean daily return and fraction of B&H captured, and
 *  judge net Sharpe vs B&H Sharpe.
 *
 * Honest N = every cell in the grid we searched =
 *   |assets| x |stablecoin-change defs| x |thresholds| x |horizons| x |lags|
 *   x {raw, residual}. DSR applied at that honest N.
 *
 * $0. Reuses cached DefiLlama supply + nf1 daily OHLC.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  summarizeReturnSeries,
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  type CscvStrategyFoldReturns,
} from "../../src/lib/training/statistical-validation";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-D7/d7-18-stablecoin-mint.json`;

const dayMs = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const ANNUALIZE = Math.sqrt(365);
const COST_PER_SIDE = 0.0006; // 6 bps per side on long<->flat transitions

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
interface Bar { date: string; close: number; }
function loadBars(sym: string): Bar[] {
  return (JSON.parse(readFileSync(`${ROOT}/output/nf1/${sym}_daily_ohlc.json`, "utf8")) as Bar[])
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => toMs(a.date) - toMs(b.date));
}

interface SupRow { date: string; total: number; }
const supplyRaw: SupRow[] = (
  JSON.parse(readFileSync(`${ROOT}/output/edgehunt-D5/stablecoins_total.json`, "utf8")).data as SupRow[]
).filter((r) => Number.isFinite(r.total) && r.total > 0).sort((a, b) => toMs(a.date) - toMs(b.date));

// Map date -> total supply (USD).
const supplyByDate = new Map<string, number>();
for (const r of supplyRaw) supplyByDate.set(r.date, r.total);

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Build an aligned daily panel for one asset:
//   ret[i]   = log return realized over [i-1, i] (aligned to bar i)
//   mintZ[i] = z-score of stablecoin daily log-change ending at the day of bar i
//   resid[i] = mintZ orthogonalized vs trailing asset returns (reverse-causality control)
// ---------------------------------------------------------------------------
const SUPPLY_TRAIL = 30; // trailing window for z-scoring supply change

interface Panel {
  date: string[];
  ret: number[];      // asset daily log return at i (over [i-1,i])
  mintZ: number[];     // mint z-score known as of day i (uses supply up to day i)
  trailRet: number[][]; // trailing asset returns [lag1..lag5] as of day i (for orthogonalization)
}

function buildPanel(bars: Bar[]): Panel {
  // align: only keep bars whose date has a supply observation (or carry-forward)
  // Build a forward-filled supply series on the bar dates.
  const date: string[] = [];
  const close: number[] = [];
  let lastSup: number | null = null;
  for (const b of bars) {
    const s = supplyByDate.get(b.date);
    if (s !== undefined) lastSup = s;
    if (lastSup === null) continue; // skip until supply coverage starts
    date.push(b.date);
    close.push(b.close);
  }
  // recompute forward-filled supply aligned to kept dates
  const sup: number[] = [];
  lastSup = null;
  for (const d of date) {
    const s = supplyByDate.get(d);
    if (s !== undefined) lastSup = s;
    sup.push(lastSup as number);
  }

  const n = date.length;
  const ret: number[] = new Array(n).fill(0);
  const supChg: number[] = new Array(n).fill(0); // log change of supply ending at i
  for (let i = 1; i < n; i += 1) {
    ret[i] = Math.log(close[i] / close[i - 1]);
    supChg[i] = Math.log(sup[i] / sup[i - 1]);
  }

  // z-score supply change vs trailing SUPPLY_TRAIL window (PIT: uses [i-TRAIL, i-1] for mean/std)
  const mintZ: number[] = new Array(n).fill(0);
  for (let i = SUPPLY_TRAIL + 1; i < n; i += 1) {
    let m = 0; let cnt = 0;
    for (let j = i - SUPPLY_TRAIL; j < i; j += 1) { m += supChg[j]; cnt += 1; }
    m /= cnt;
    let v = 0;
    for (let j = i - SUPPLY_TRAIL; j < i; j += 1) v += (supChg[j] - m) ** 2;
    const sd = Math.sqrt(v / Math.max(1, cnt - 1));
    mintZ[i] = sd > 1e-12 ? (supChg[i] - m) / sd : 0;
  }

  const trailRet: number[][] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const lags: number[] = [];
    for (let L = 1; L <= 5; L += 1) lags.push(i - L >= 0 ? ret[i - L] : 0);
    trailRet[i] = lags;
  }

  return { date, ret, mintZ, trailRet };
}

// OLS multivariate: y on X (with intercept). Returns residuals.
function residualize(y: number[], X: number[][]): number[] {
  const n = y.length;
  const k = X[0].length + 1; // + intercept
  // design with intercept first
  const D: number[][] = X.map((row) => [1, ...row]);
  // normal equations XtX b = Xty
  const XtX: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a < k; a += 1) {
      Xty[a] += D[i][a] * y[i];
      for (let b = 0; b < k; b += 1) XtX[a][b] += D[i][a] * D[i][b];
    }
  }
  // solve via Gaussian elimination
  const A = XtX.map((r, i) => [...r, Xty[i]]);
  for (let col = 0; col < k; col += 1) {
    let piv = col;
    for (let r = col + 1; r < k; r += 1) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let c = col; c <= k; c += 1) A[col][c] /= d;
    for (let r = 0; r < k; r += 1) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = col; c <= k; c += 1) A[r][c] -= f * A[col][c];
    }
  }
  const beta = A.map((r) => r[k]);
  const resid: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let pred = 0;
    for (let a = 0; a < k; a += 1) pred += beta[a] * D[i][a];
    resid[i] = y[i] - pred;
  }
  return resid;
}

// ---------------------------------------------------------------------------
// Rule: on a mint event at day i, hold long for the next H days (i+1..i+H using
// confirmationLag). We build a position series then net returns.
// signal[i] = event indicator known as-of day i. We enter the day AFTER the
// event (confirmation lag = 1 minimum) and hold H days.
// ---------------------------------------------------------------------------
function ruleReturns(
  ret: number[],
  signal: boolean[],
  horizon: number,
  confirmLag: number,
): { net: number[]; gross: number[]; turns: number; inDays: number; pos: number[] } {
  const n = ret.length;
  const wantLong: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    if (!signal[i]) continue;
    const start = i + confirmLag;       // first day we are exposed (return realized at start)
    const end = Math.min(n - 1, start + horizon - 1);
    for (let k = start; k <= end; k += 1) if (k >= 0 && k < n) wantLong[k] = true;
  }
  const net: number[] = []; const gross: number[] = []; const posArr: number[] = [];
  let prev = 0; let turns = 0; let inDays = 0;
  for (let i = 0; i < n; i += 1) {
    const pos = wantLong[i] ? 1 : 0;
    if (pos !== prev) turns += 1;
    if (pos === 1) inDays += 1;
    const g = pos * ret[i];
    const c = pos !== prev ? COST_PER_SIDE : 0;
    gross.push(g); net.push(g - c); posArr.push(pos);
    prev = pos;
  }
  return { net, gross, turns, inDays, pos: posArr };
}

// ---------------------------------------------------------------------------
// Grid search (HONEST N counted) per asset.
// ---------------------------------------------------------------------------
const ASSETS = ["BTC", "ETH"];
const THRESHOLDS = [1.5, 2.0, 2.5, 3.0]; // mint z-score cut
const HORIZONS = [3, 5, 7, 10];
const LAGS = [1, 2];                       // confirmation delay (days after event)
const SIGNALS = ["raw", "residual"] as const;

interface Cell {
  asset: string; signalType: string; threshold: number; horizon: number; lag: number;
  netSharpeAnnual: number; netSharpeDaily: number; netCompound: number;
  bhSharpeAnnual: number; bhCompound: number; events: number; inDays: number;
  inMeanDaily: number; outMeanDaily: number; captureFrac: number;
  net: number[];
}

interface AssetResult {
  asset: string;
  bars: number; start: string; end: string;
  cells: Cell[];
  best: Cell;
}

const assetResults: AssetResult[] = [];
let honestN = 0;

for (const asset of ASSETS) {
  const panel = buildPanel(loadBars(asset));
  const { ret, mintZ, trailRet } = panel;
  const n = ret.length;

  // residualized mint z-score (orthogonalize vs trailing returns) — reverse-causality control.
  // valid rows = those with full trailing window
  const validIdx: number[] = [];
  for (let i = SUPPLY_TRAIL + 6; i < n; i += 1) validIdx.push(i);
  const yArr = validIdx.map((i) => mintZ[i]);
  const Xarr = validIdx.map((i) => trailRet[i]);
  const residVals = residualize(yArr, Xarr);
  const residZFull: number[] = new Array(n).fill(0);
  // re-standardize residual to z-scale (so thresholds are comparable)
  const rm = residVals.reduce((a, b) => a + b, 0) / residVals.length;
  const rsd = Math.sqrt(residVals.reduce((a, b) => a + (b - rm) ** 2, 0) / Math.max(1, residVals.length - 1));
  validIdx.forEach((i, k) => { residZFull[i] = rsd > 1e-12 ? (residVals[k] - rm) / rsd : 0; });

  const bhStats = summarizeReturnSeries(ret);
  const cells: Cell[] = [];

  for (const signalType of SIGNALS) {
    const z = signalType === "raw" ? mintZ : residZFull;
    for (const threshold of THRESHOLDS) {
      const signal = z.map((v) => v >= threshold);
      const eventCount = signal.filter(Boolean).length;
      for (const horizon of HORIZONS) {
        for (const lag of LAGS) {
          honestN += 1;
          const r = ruleReturns(ret, signal, horizon, lag);
          const stats = summarizeReturnSeries(r.net);
          // in vs out (gross, long-beta diagnostic)
          let inSum = 0, inCnt = 0, outSum = 0, outCnt = 0;
          for (let i = 0; i < n; i += 1) {
            if (r.pos[i] === 1) { inSum += ret[i]; inCnt += 1; } else { outSum += ret[i]; outCnt += 1; }
          }
          const inMean = inCnt ? inSum / inCnt : 0;
          const outMean = outCnt ? outSum / outCnt : 0;
          const bhTotal = ret.reduce((s, x) => s + x, 0);
          const inTotal = r.gross.reduce((s, x) => s + x, 0);
          const captureFrac = bhTotal !== 0 ? inTotal / bhTotal : 0;
          cells.push({
            asset, signalType, threshold, horizon, lag,
            netSharpeAnnual: stats.sharpe * ANNUALIZE,
            netSharpeDaily: stats.sharpe,
            netCompound: stats.compoundReturn,
            bhSharpeAnnual: bhStats.sharpe * ANNUALIZE,
            bhCompound: bhStats.compoundReturn,
            events: eventCount, inDays: r.inDays,
            inMeanDaily: inMean, outMeanDaily: outMean, captureFrac,
            net: r.net,
          });
        }
      }
    }
  }
  // best by net Sharpe (this is the data-mining-selected winner)
  const best = cells.reduce((b, c) => (c.netSharpeDaily > b.netSharpeDaily ? c : b));
  assetResults.push({
    asset, bars: n, start: panel.date[0], end: panel.date[n - 1], cells, best,
  });
}

// ---------------------------------------------------------------------------
// Pick the single best cell across all assets (the honest winner) for the
// full gauntlet: placebo null, DSR @ honest N, CSCV/PBO, bootstrap.
// ---------------------------------------------------------------------------
const allCells: { ar: AssetResult; cell: Cell }[] = [];
for (const ar of assetResults) for (const c of ar.cells) allCells.push({ ar, cell: c });
const winner = allCells.reduce((b, x) => (x.cell.netSharpeDaily > b.cell.netSharpeDaily ? x : b));
const W = winner.cell;
const Wpanel = buildPanel(loadBars(W.asset));

// --- RIGHT NULL: placebo mints (random fake mint dates, matched count) ---
// Keep the SAME number of events as the winner, but place them at random days;
// apply the identical horizon/lag rule; score net Sharpe.
const N_PLACEBO = 5000;
const rng = mulberry32(71871);
const nW = Wpanel.ret.length;
const realEvents = W.events;
const placeboSharpes: number[] = [];
let geCount = 0;
for (let s = 0; s < N_PLACEBO; s += 1) {
  const sig: boolean[] = new Array(nW).fill(false);
  let placed = 0; let guard = 0;
  while (placed < realEvents && guard < realEvents * 50) {
    const idx = SUPPLY_TRAIL + 6 + Math.floor(rng() * (nW - SUPPLY_TRAIL - 7));
    if (idx >= 0 && idx < nW && !sig[idx]) { sig[idx] = true; placed += 1; }
    guard += 1;
  }
  const r = ruleReturns(Wpanel.ret, sig, W.horizon, W.lag);
  const sh = summarizeReturnSeries(r.net).sharpe;
  placeboSharpes.push(sh);
  if (sh >= W.netSharpeDaily) geCount += 1;
}
const surrogateP = (geCount + 1) / (placeboSharpes.length + 1);
const placeboMean = placeboSharpes.reduce((a, b) => a + b, 0) / placeboSharpes.length;
placeboSharpes.sort((a, b) => a - b);
const placeboP95 = placeboSharpes[Math.floor(0.95 * placeboSharpes.length)];

// --- DSR at honest N ---
const dsr = computeDeflatedSharpeRatio(W.net, { trialCount: honestN });

// --- Block bootstrap CI on net compound return ---
const bootstrap = blockBootstrapConfidenceInterval(W.net, {
  statistic: "compoundReturn", iterations: 2000, blockLength: 20,
  confidenceLevel: 0.95, seed: "d7-18",
});

// --- CSCV / PBO across the strategy family (all cells for the winner's asset) ---
// Build fold returns for each cell of the winner's asset; 10 contiguous folds.
const FOLDS = 10;
function makeFolds(net: number[]): number[][] {
  const out: number[][] = [];
  const sz = Math.floor(net.length / FOLDS);
  for (let f = 0; f < FOLDS; f += 1) {
    const start = f * sz;
    const end = f === FOLDS - 1 ? net.length : start + sz;
    out.push(net.slice(start, end));
  }
  return out;
}
const winnerAsset = assetResults.find((a) => a.asset === W.asset)!;
const strategies: CscvStrategyFoldReturns[] = winnerAsset.cells.map((c, i) => ({
  id: `${c.signalType}_t${c.threshold}_h${c.horizon}_l${c.lag}_${i}`,
  folds: makeFolds(c.net),
}));
const pbo = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });

// --- Reverse-causality verdict: does the residual (orthogonalized) signal keep
// the edge? Compare best raw vs best residual cell per asset. ---
const reverseCausality = assetResults.map((ar) => {
  const rawBest = ar.cells.filter((c) => c.signalType === "raw").reduce((b, c) => (c.netSharpeDaily > b.netSharpeDaily ? c : b));
  const resBest = ar.cells.filter((c) => c.signalType === "residual").reduce((b, c) => (c.netSharpeDaily > b.netSharpeDaily ? c : b));
  return {
    asset: ar.asset,
    rawBestNetSharpeAnnual: rawBest.netSharpeAnnual,
    residualBestNetSharpeAnnual: resBest.netSharpeAnnual,
    edgeSurvivesOrthogonalization: resBest.netSharpeAnnual > 0 && resBest.netSharpeAnnual >= 0.7 * rawBest.netSharpeAnnual,
  };
});

// --- Monthly P&L @ $100k (only meaningful if it clears) ---
const yearsW = nW / 365;
const monthlyAt100k = (W.netCompound / Math.max(0.1, yearsW)) / 12 * 100000;

const result = {
  hypothesis: "D7.18 stablecoin mint-as-event (large supply prints precede pumps)",
  dataGate: {
    note: "DEFERRED gate (needs cached daily stablecoin supply) is now SATISFIED.",
    supplySource: "DefiLlama total stablecoin market cap (cached output/edgehunt-D5/stablecoins_total.json)",
    supplyRows: supplyRaw.length, supplyStart: supplyRaw[0].date, supplyEnd: supplyRaw[supplyRaw.length - 1].date,
  },
  honestN,
  honestNbreakdown: {
    assets: ASSETS.length, signalDefs: SIGNALS.length, thresholds: THRESHOLDS.length,
    horizons: HORIZONS.length, lags: LAGS.length,
    note: "honestN = assets x signalDefs x thresholds x horizons x lags (every grid cell searched).",
  },
  cost: { perSideBps: COST_PER_SIDE * 1e4, model: "6bps/side on long<->flat transitions" },
  perAsset: assetResults.map((a) => ({
    asset: a.asset, bars: a.bars, start: a.start, end: a.end,
    bestCell: {
      signalType: a.best.signalType, threshold: a.best.threshold, horizon: a.best.horizon, lag: a.best.lag,
      netSharpeAnnual: a.best.netSharpeAnnual, netCompound: a.best.netCompound,
      bhSharpeAnnual: a.best.bhSharpeAnnual, bhCompound: a.best.bhCompound,
      events: a.best.events, inDays: a.best.inDays,
      inMeanDaily: a.best.inMeanDaily, outMeanDaily: a.best.outMeanDaily, captureFrac: a.best.captureFrac,
    },
  })),
  winner: {
    asset: W.asset, signalType: W.signalType, threshold: W.threshold, horizon: W.horizon, lag: W.lag,
    netSharpeAnnual: W.netSharpeAnnual, netSharpeDaily: W.netSharpeDaily, netCompound: W.netCompound,
    bhSharpeAnnual: W.bhSharpeAnnual, bhCompound: W.bhCompound,
    events: W.events, inDays: W.inDays, inWindowFrac: W.inDays / nW,
    longBetaControl: {
      inMeanDaily: W.inMeanDaily, outMeanDaily: W.outMeanDaily, inMinusOut: W.inMeanDaily - W.outMeanDaily,
      fractionOfBHCaptured: W.captureFrac,
      beatsBuyAndHold: W.netSharpeAnnual > W.bhSharpeAnnual,
      note: "If inMinusOut>0 but net Sharpe < B&H Sharpe, the edge is long-beta sampled part-time (NA/ND trap).",
    },
  },
  rightNull_placeboMints: {
    placebos: placeboSharpes.length, realEvents,
    realNetSharpeDaily: W.netSharpeDaily, placeboMeanSharpeDaily: placeboMean, placeboP95SharpeDaily: placeboP95,
    fakeBeatsReal_count: geCount, surrogateP,
  },
  reverseCausalityControl: reverseCausality,
  deflatedSharpe_daily: {
    sharpe: dsr.sharpe, trialCount: dsr.trialCount, expectedMaxSharpe: dsr.expectedMaxSharpe,
    deflatedProbability: dsr.deflatedProbability,
  },
  cscvPbo: { pbo: pbo.pbo, meanLogit: pbo.meanLogit, strategyCount: pbo.strategyCount, foldCount: pbo.foldCount, splitCount: pbo.splitCount },
  bootstrapCompoundCI: { lower: bootstrap.lower, estimate: bootstrap.estimate, upper: bootstrap.upper },
  monthlyAt100k,
};

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
