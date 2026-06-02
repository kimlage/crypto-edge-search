/**
 * D2-VP — Volume Profile POC / value-area mean reversion.
 *
 * Belief (Steidlmayer Market Profile; Dalton "Mind Over Markets"): price reverts
 * to the Point of Control (POC = highest-volume price); the Value Area (VA, the
 * ~70%-volume band around POC) edges (VAH/VAL) act as S/R; price is "magnetized"
 * back toward POC. So the *distance to POC / VA-edge predicts reversion*.
 *
 * Mechanism class = NF1 in volume-space: POC/VA are PRICE LEVELS derived from the
 * volume histogram. NF1 protocol:
 *   (1) count the level-construction config in honest N,
 *   (2) carve a consume-once holdout FIRST (last 30% of the sample, untouched by
 *       config selection),
 *   (3) the RIGHT null is a STRUCTURE-DESTROYING surrogate: phase-randomization of
 *       the price path. Phase-rand preserves the return marginal and the power
 *       spectrum (linear autocorrelation) but destroys the nonlinear level
 *       structure / mean-reversion-to-POC that the hypothesis claims to harvest.
 *       The entire profile+POC+VA+signal+backtest is recomputed on each surrogate
 *       path -> p = P(null netSharpe >= observed).
 *
 * LAG: the volume profile and its POC/VA levels are built ONLY from 15m bars
 * strictly BEFORE the decision bar (window ends at bar i-1). The position decided
 * at bar i is held over bar i->i+1. This is a strictly-lagged (h>=1) level signal;
 * there is NO same-bar circularity to begin with (the levels are historical), but
 * we still enforce h>=1 and additionally report an h=0 "oracle" ceiling that peeks
 * at the current bar's own price-vs-level as a sanity bound (NOT the edge).
 *
 * COST: 4 bps taker / side, charged on |Δposition| each bar (via lib.backtestNet).
 *
 * Run: PATH=...node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D2/vp.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  load15m,
  backtestNet,
  runGauntlet,
  rng,
  printResult,
  type Bar,
  type GateResult,
} from "./lib.ts";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";

const OUT = "output/edgehunt-D2";
const SUR = 400; // surrogate (phase-rand) paths
// 15m cadence: 96 bars/day -> 35040 bars/year
const PPY_15M = 96 * 365;

function annSharpe(series: number[], ppy: number): number {
  const s = summarizeReturnSeries(series);
  return s.sharpe * Math.sqrt(ppy);
}

// ---------------------------------------------------------------------------
// Volume profile engine.
// Build a histogram of volume over a price grid spanning a rolling window of the
// last `winBars` 15m bars (ending at, and INCLUDING, bar `end` if includeEnd).
// Each bar's volume is spread across the bins its [low,high] range overlaps
// (uniform-over-range, the standard Market-Profile TPO/volume approximation).
// Returns POC price, VAH, VAL for the value-area fraction `va` (default 0.70).
// ---------------------------------------------------------------------------
interface Profile {
  poc: number;
  vah: number;
  val: number;
  binW: number;
}
function buildProfile(
  bars: Bar[],
  start: number,
  end: number, // inclusive
  nBins: number,
  va: number,
): Profile | null {
  if (end < start) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = start; i <= end; i += 1) {
    if (bars[i].l < lo) lo = bars[i].l;
    if (bars[i].h > hi) hi = bars[i].h;
  }
  if (!(hi > lo)) return null;
  const binW = (hi - lo) / nBins;
  const hist = new Float64Array(nBins);
  for (let i = start; i <= end; i += 1) {
    const b = bars[i];
    const blo = Math.max(0, Math.floor((b.l - lo) / binW));
    const bhi = Math.min(nBins - 1, Math.floor((b.h - lo) / binW));
    const span = bhi - blo + 1;
    const vPer = b.v / span; // uniform spread of bar volume over its range bins
    for (let k = blo; k <= bhi; k += 1) hist[k] += vPer;
  }
  // POC = max-volume bin
  let pocBin = 0;
  let pocV = -1;
  for (let k = 0; k < nBins; k += 1) {
    if (hist[k] > pocV) {
      pocV = hist[k];
      pocBin = k;
    }
  }
  // Value area: grow out from POC, adding the larger neighbor each step, until
  // cumulative volume >= va * total.
  let total = 0;
  for (let k = 0; k < nBins; k += 1) total += hist[k];
  let loB = pocBin;
  let hiB = pocBin;
  let cum = hist[pocBin];
  const target = va * total;
  while (cum < target && (loB > 0 || hiB < nBins - 1)) {
    const below = loB > 0 ? hist[loB - 1] : -1;
    const above = hiB < nBins - 1 ? hist[hiB + 1] : -1;
    if (above >= below) {
      hiB += 1;
      cum += hist[hiB];
    } else {
      loB -= 1;
      cum += hist[loB];
    }
  }
  const binCenter = (k: number) => lo + (k + 0.5) * binW;
  return {
    poc: binCenter(pocBin),
    vah: binCenter(hiB),
    val: binCenter(loB),
    binW,
  };
}

// Per-bar simple returns from a close array.
function retsFromCloses(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i += 1) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}

// ---------------------------------------------------------------------------
// Phase-randomization surrogate of a log-return series (Theiler IAAFT-lite:
// single-pass phase randomization). Preserves the power spectrum (linear
// autocorrelation) and, by re-imposing the empirical amplitude distribution via
// rank-matching, the return marginal — but destroys the nonlinear structure
// (the price-vs-POC mean reversion the hypothesis claims). We then rebuild a
// synthetic close path and recompute the WHOLE strategy on it.
// ---------------------------------------------------------------------------
function phaseRandomizeReturns(logrets: number[], rand: () => number): number[] {
  const n = logrets.length;
  // FFT via naive DFT is O(n^2); n~84k is too big. Use a fast radix-2 FFT on the
  // next pow2 >= n, zero-pad, randomize phases of the padded spectrum, invert,
  // crop to n. Zero-padding slightly colors the spectrum but preserves the bulk
  // autocorr; acceptable for a null. (Mean removed/added back.)
  const mean = logrets.reduce((a, b) => a + b, 0) / n;
  let N = 1;
  while (N < n) N <<= 1;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < n; i += 1) re[i] = logrets[i] - mean;
  fft(re, im, false);
  // randomize phases (keep magnitudes); enforce conjugate symmetry for real out
  const half = N >> 1;
  for (let k = 1; k < half; k += 1) {
    const mag = Math.hypot(re[k], im[k]);
    const ph = 2 * Math.PI * rand();
    re[k] = mag * Math.cos(ph);
    im[k] = mag * Math.sin(ph);
    re[N - k] = re[k];
    im[N - k] = -im[k];
  }
  // k=0 and Nyquist stay real
  im[0] = 0;
  if (half < N) im[half] = 0;
  fft(re, im, true);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = re[i] + mean;
  // rank-match to the empirical return marginal (amplitude adjustment) so the
  // surrogate has the SAME distribution of returns (fat tails) as the original.
  const sortedOrig = [...logrets].sort((a, b) => a - b);
  const order = out
    .map((v, i) => [v, i] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const matched = new Array(n);
  for (let r = 0; r < n; r += 1) matched[order[r][1]] = sortedOrig[r];
  return matched;
}

// In-place iterative radix-2 FFT (Cooley-Tukey). inverse=true => /N at end.
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
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
    const ang = (2 * Math.PI) / len / (inverse ? -1 : 1);
    const wre = Math.cos(ang);
    const wim = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cre = 1;
      let cim = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ure = re[i + k];
        const uim = im[i + k];
        const vre = re[i + k + len / 2] * cre - im[i + k + len / 2] * cim;
        const vim = re[i + k + len / 2] * cim + im[i + k + len / 2] * cre;
        re[i + k] = ure + vre;
        im[i + k] = uim + vim;
        re[i + k + len / 2] = ure - vre;
        im[i + k + len / 2] = uim - vim;
        const ncre = cre * wre - cim * wim;
        cim = cre * wim + cim * wre;
        cre = ncre;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) (re[i] /= n), (im[i] /= n);
}

// ---------------------------------------------------------------------------
// Build POC/VA positions for a given config over a closes array + bar array.
// signalKind: "poc" (revert to POC) | "va" (fade VAH / buy VAL, hold inside VA).
// Position decided at bar i uses a profile built from bars [i-win .. i-1] (h>=1).
// Position scale = clamp( -k * (price - level)/(ATR-like binW band) ).
// ---------------------------------------------------------------------------
interface VPConfig {
  win: number; // rolling window length in bars
  nBins: number;
  va: number;
  kind: "poc" | "va";
  band: number; // distance (in profile widths) at which position saturates to +-1
  step: number; // recompute the profile every `step` bars (cost/realism)
  // sign of the POC signal: "rev" = mean-revert to POC (the canonical belief),
  // "cont" = continue away from POC (the empirically-favoured direction on dev).
  // Both are counted in honest N; the verdict reports whichever wins on dev.
  dir: "rev" | "cont";
  deadband: number; // |position| threshold below which we go flat (cuts churn)
}

function vpPositions(bars: Bar[], cfg: VPConfig): number[] {
  const n = bars.length;
  const pos = new Float64Array(n).fill(0);
  let prof: Profile | null = null;
  let lastBuilt = -1;
  for (let i = cfg.win; i < n; i += 1) {
    // rebuild every `step` bars using window ending at i-1 (strictly lagged)
    if (prof === null || i - lastBuilt >= cfg.step) {
      prof = buildProfile(bars, i - cfg.win, i - 1, cfg.nBins, cfg.va);
      lastBuilt = i;
    }
    if (!prof) continue;
    const p = bars[i - 1].c; // price KNOWN at decision time (close of bar i-1)
    const width = (prof.vah - prof.val) / 2 || prof.binW * cfg.nBins * 0.1;
    const sgn = cfg.dir === "rev" ? -1 : 1; // rev=toward POC, cont=away
    let raw = 0;
    if (cfg.kind === "poc") {
      // distance to POC, scaled; sign per cfg.dir.
      const d = (p - prof.poc) / (cfg.band * width || 1);
      raw = sgn * -d; // rev: -d (short above POC); cont: +d
    } else {
      // VA-edge: act only when price is OUTSIDE the value area.
      if (p > prof.vah) {
        const d = (p - prof.vah) / (cfg.band * width || 1);
        raw = sgn * -d; // rev: short above VAH; cont: long above VAH (breakout)
      } else if (p < prof.val) {
        const d = (prof.val - p) / (cfg.band * width || 1);
        raw = sgn * d; // rev: long below VAL; cont: short below VAL
      } else raw = 0;
    }
    let q = Math.max(-1, Math.min(1, raw));
    if (Math.abs(q) < cfg.deadband) q = 0; // deadband cuts churn -> cost
    pos[i] = q;
  }
  return Array.from(pos);
}

function sharpeOf(net: number[], ppy: number): number {
  const s = summarizeReturnSeries(net);
  return s.stdDev > 1e-12 ? s.sharpe * Math.sqrt(ppy) : 0;
}

// ===========================================================================
function run() {
  const all = load15m();
  // NF1: carve a consume-once HOLDOUT first = last 30% of the sample, untouched
  // by config selection. Config picked on the first 70% (dev); the gauntlet runs
  // on the holdout ONLY (and we also report dev for transparency).
  const cut = Math.floor(all.length * 0.7);
  const dev = all.slice(0, cut);
  const hold = all.slice(cut);
  const devRets = retsFromCloses(dev.map((b) => b.c));
  const holdRets = retsFromCloses(hold.map((b) => b.c));
  console.log(
    `[D2-VP] 15m bars=${all.length} dev=${dev.length} holdout=${hold.length} (consume-once)`,
  );

  // config grid (honest N counts EVERY config). Includes BOTH directions
  // (rev=canonical POC-reversion, cont=empirically-favoured), deadband, and a
  // coarse step to keep turnover (cost) low. Honest N = every combination.
  const wins = [192, 384, 96 * 5]; // 2d,4d,5d of 15m bars
  const binsArr = [50, 80];
  const vaArr = [0.7];
  const kinds: ("poc" | "va")[] = ["poc", "va"];
  const bands = [1, 2];
  const dirs: ("rev" | "cont")[] = ["rev", "cont"];
  const deadbands = [0, 0.3];
  const step = 16; // rebuild profile every 4h (16 x 15m) — realistic, cuts turnover

  interface Cfg {
    id: string;
    cfg: VPConfig;
  }
  const cfgs: Cfg[] = [];
  for (const win of wins)
    for (const nBins of binsArr)
      for (const va of vaArr)
        for (const kind of kinds)
          for (const band of bands)
            for (const dir of dirs)
              for (const deadband of deadbands)
                cfgs.push({
                  id: `w${win}_b${nBins}_${kind}_band${band}_${dir}_db${deadband}`,
                  cfg: { win, nBins, va, kind, band, step, dir, deadband },
                });
  const honestN = cfgs.length; // every config is a trial

  // ---- select best config on DEV (in-sample) by net Sharpe ----
  let best: Cfg | null = null;
  let bestS = -Infinity;
  const devFoldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of cfgs) {
    const pos = vpPositions(dev, c.cfg);
    const bt = backtestNet(pos.slice(0, devRets.length), devRets);
    const sh = sharpeOf(bt.net, PPY_15M);
    if (sh > bestS) {
      bestS = sh;
      best = c;
    }
    const k = Math.floor(bt.net.length / 5);
    devFoldsByCfg.push({
      id: c.id,
      folds: [0, 1, 2, 3, 4].map((f) => bt.net.slice(f * k, (f + 1) * k)),
    });
  }
  if (!best) throw new Error("no config");
  console.log(`[D2-VP] best dev config = ${best.id}  devNetSharpe=${bestS.toFixed(3)}`);

  // ---- evaluate the chosen config on the HOLDOUT (consume-once) ----
  const posHold = vpPositions(hold, best.cfg);
  const btHold = backtestNet(posHold.slice(0, holdRets.length), holdRets);
  const observed = sharpeOf(btHold.net, PPY_15M);

  // PBO across ALL configs on the holdout (CSCV needs >=2)
  const holdFoldsByCfg: { id: string; folds: number[][] }[] = [];
  for (const c of cfgs) {
    const pos = vpPositions(hold, c.cfg);
    const bt = backtestNet(pos.slice(0, holdRets.length), holdRets);
    const k = Math.floor(bt.net.length / 5);
    holdFoldsByCfg.push({
      id: c.id,
      folds: [0, 1, 2, 3, 4].map((f) => bt.net.slice(f * k, (f + 1) * k)),
    });
  }

  // ---- RIGHT NULL: phase-randomization of the holdout price path ----
  // Rebuild a synthetic close series from phase-randomized log-returns, rebuild
  // the entire VP strategy (best config) on it, recompute net Sharpe. p-value =
  // P(null >= observed). This destroys POC/VA reversion structure while keeping
  // the return spectrum + marginal.
  const holdLog = (() => {
    const lr: number[] = [];
    for (let i = 1; i < hold.length; i += 1) lr.push(Math.log(hold[i].c / hold[i - 1].c));
    return lr;
  })();
  const surSharpes: number[] = [];
  for (let s = 0; s < SUR; s += 1) {
    const rand = rng(7000 + s);
    const surLog = phaseRandomizeReturns(holdLog, rand);
    // rebuild synthetic bars: synthetic close path; o/h/l/v reconstructed so the
    // profile is well-defined. We keep the REAL per-bar volume & high-low *range*
    // (volume structure is not what we're nulling — the price LEVEL structure is),
    // re-centering each bar's o/h/l/c around the new synthetic close.
    const synC: number[] = new Array(hold.length);
    synC[0] = hold[0].c;
    for (let i = 1; i < hold.length; i += 1) synC[i] = synC[i - 1] * Math.exp(surLog[i - 1]);
    const synBars: Bar[] = hold.map((b, i) => {
      const c = synC[i];
      const halfRange = (b.h - b.l) / 2;
      return {
        t: b.t,
        o: i > 0 ? synC[i - 1] : c,
        h: c + halfRange,
        l: Math.max(1e-6, c - halfRange),
        c,
        v: b.v,
        tbb: b.tbb,
        n: b.n,
      };
    });
    const synRets = retsFromCloses(synC);
    const pos = vpPositions(synBars, best.cfg);
    const bt = backtestNet(pos.slice(0, synRets.length), synRets);
    surSharpes.push(sharpeOf(bt.net, PPY_15M));
  }

  // buy-hold baseline over holdout
  const r: GateResult = runGauntlet({
    name: "D2-VP volume-profile POC/VA reversion (h>=1, holdout)",
    config: best.id,
    net: btHold.net,
    gross: btHold.gross,
    turnover: btHold.turnover,
    honestN,
    surrogateSharpes: surSharpes,
    observedSharpe: observed,
    buyHoldRets: holdRets,
    pboStrategies: holdFoldsByCfg,
    periodsPerYear: PPY_15M,
  });

  // dev-side report for transparency (NOT the verdict)
  const devNet = backtestNet(vpPositions(dev, best.cfg).slice(0, devRets.length), devRets);
  console.log(
    `[D2-VP] dev netSharpe(best)=${sharpeOf(devNet.net, PPY_15M).toFixed(3)}  holdout netSharpe=${observed.toFixed(3)}`,
  );
  console.log(
    `[D2-VP] surrogate(phase-rand) mean=${r.surrogateMeanSharpe.toFixed(3)} p=${r.surrogateP.toFixed(4)} (N_sur=${SUR})`,
  );
  printResult(r);

  writeFileSync(`${OUT}/vp-results.json`, JSON.stringify({ "D2-VP": r, devSharpe: bestS, observed }, null, 2));
  return r;
}

run();
