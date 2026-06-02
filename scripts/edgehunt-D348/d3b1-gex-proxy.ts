/**
 * D3-B1 — Dealer GEX / gamma walls / zero-gamma flip.
 *
 * CANONICAL TEST requires point-in-time per-strike OI + per-strike gamma history
 * (Laevitas/Amberdata/Tardis, PAID; or Deribit forward-record, small-N). NONE of
 * that exists on disk: there is ZERO per-strike OI and ZERO per-strike gamma data
 * (current or historical). So the three real claims are NOT directly testable at $0:
 *   (1) net dealer-gamma sign -> pin/mean-revert (positive) vs trend (negative)
 *   (2) walls = S/R   (needs per-strike OI to LOCATE the wall — this is NF1/NA, KILLed)
 *   (3) zero-gamma flip (needs the full per-strike gamma curve to LOCATE the flip)
 *
 * What IS $0: Deribit DVOL daily history (BTC, 2021-03..2026-06) + BTC OHLC.
 * The ONLY honest $0 angle on the *directional core* of claim (1) is a degraded
 * "dealer-gamma-regime" PROXY: use DVOL dynamics as a crude long-gamma vs short-gamma
 * supply proxy, map positive-gamma->fade next move / negative-gamma->follow, and ask
 * the decision-relevant question:
 *
 *   Does ANY such proxy add value net-of-cost, AND does it beat the right nulls —
 *   (a) a pure realized-vol regime control [A4], (b) a label-shuffle, (c) a
 *   vol-preserving block surrogate? If even this degraded proxy shows nothing, the
 *   case for buying the paid per-strike panel collapses. If it shows something, that
 *   is the PROMISING signal that justifies forward-recording the real GEX panel.
 *
 * dataFidelity: PROXY-ONLY. No walls, no flip point, no per-strike OI/gamma. A SURVIVE
 * here would NOT be provider-canonical. The dealer-sign is an unfalsifiable DoF; this
 * proxy fixes ONE sign convention and label-shuffles to expose it.
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/d3b1-gex-proxy.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  blockBootstrapConfidenceInterval,
  estimateCscvPbo,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

const annualize = (sharpePerDay: number) => sharpePerDay * Math.sqrt(365);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function blockResample(x: number[], blk: number, r: () => number): number[] {
  const out: number[] = [];
  while (out.length < x.length) {
    const s = Math.floor(r() * x.length);
    for (let o = 0; o < blk && out.length < x.length; o++) out.push(x[(s + o) % x.length]);
  }
  return out.slice(0, x.length);
}

// ---------------------------------------------------------------------------
// Load DVOL (daily) and build a clean BTC daily close + realized vol from 15m.
// ---------------------------------------------------------------------------
type Dvol = { date: string; close: number };
const dvolRaw = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/edgehunt/dvol_btc.json"), "utf8"),
) as { date: string; close: number }[];
const dvol = new Map<string, number>(dvolRaw.map((d) => [d.date, d.close]));

// daily close from 15m ndjson (last bar of each event_date)
const closeByDate = new Map<string, number>();
const dvByDate = new Map<string, number>(); // crude intraday realized range proxy not needed; use close-to-close
{
  const lines = fs
    .readFileSync(path.join(ROOT, "output/bigquery/btc_ohlcv_15m.ndjson"), "utf8")
    .trim()
    .split("\n");
  for (const ln of lines) {
    const o = JSON.parse(ln) as { event_date: string; close: number; event_time: string };
    closeByDate.set(o.event_date, o.close); // later bars overwrite -> last close of day
  }
}

// Build aligned daily panel where DVOL exists.
const dates = [...dvol.keys()].sort();
type Row = { date: string; close: number; dvol: number };
const rows: Row[] = [];
for (const d of dates) {
  const c = closeByDate.get(d);
  const v = dvol.get(d);
  if (c != null && isFinite(c) && v != null && isFinite(v)) rows.push({ date: d, close: c, dvol: v });
}
// daily log returns and trailing realized vol (annualized, %, to match DVOL units ~%)
const N = rows.length;
const logret: number[] = new Array(N).fill(0);
for (let i = 1; i < N; i++) logret[i] = Math.log(rows[i].close / rows[i - 1].close);

function trailingRVann(i: number, win: number): number {
  if (i < win) return NaN;
  let s = 0,
    s2 = 0;
  for (let k = i - win + 1; k <= i; k++) {
    s += logret[k];
    s2 += logret[k] * logret[k];
  }
  const m = s / win;
  const varr = s2 / win - m * m;
  return Math.sqrt(Math.max(0, varr) * 365) * 100; // annualized %, DVOL-comparable
}

// next-day return (the label) and forward 1d signed move
const fwd: number[] = new Array(N).fill(NaN);
for (let i = 0; i < N - 1; i++) fwd[i] = logret[i + 1];

// realistic round-trip cost on a daily directional BTC position (perp taker 4bps/side)
const RT_COST = 0.0008;

// ---------------------------------------------------------------------------
// Proxy gamma-regime signals (all use ONLY info available at close of day i).
//   sign convention (fixed; the unfalsifiable DoF — label-shuffled below):
//     "long-gamma / positive-gamma regime" => dealers suppress vol => FADE today's move
//     "short-gamma / negative-gamma regime" => dealers amplify => FOLLOW today's move
//   regime proxies (each a candidate way to call the gamma sign at $0):
//     P1 VRP sign:  DVOL > trailing RV  => long-gamma (insurance richly supplied) => fade
//     P2 DVOL level z: low DVOL z => calm/pinned (long-gamma) => fade; high z => follow
//     P3 DVOL momentum: falling DVOL => long-gamma building => fade; rising => follow
//   "today's move" = sign(logret[i]); position for day i+1.
// ---------------------------------------------------------------------------

const RV_WIN = [10, 20, 30];
const Z_WIN = [30, 60];

type Cfg = { id: string; pos: (i: number) => number };
const configs: Cfg[] = [];

// helper: trailing DVOL z-score
function dvolZ(i: number, win: number): number {
  if (i < win) return NaN;
  let s = 0,
    s2 = 0;
  for (let k = i - win + 1; k <= i; k++) {
    s += rows[k].dvol;
    s2 += rows[k].dvol * rows[k].dvol;
  }
  const m = s / win;
  const sd = Math.sqrt(Math.max(1e-12, s2 / win - m * m));
  return (rows[i].dvol - m) / sd;
}

for (const rw of RV_WIN) {
  // P1: VRP-sign regime
  configs.push({
    id: `P1_vrp_rv${rw}`,
    pos: (i) => {
      const rv = trailingRVann(i, rw);
      if (!isFinite(rv)) return NaN;
      const longGamma = rows[i].dvol > rv; // implied rich => supply of gamma
      const move = Math.sign(logret[i]);
      if (move === 0) return 0;
      return longGamma ? -move : move; // fade in long-gamma, follow in short-gamma
    },
  });
}
for (const zw of Z_WIN) {
  // P2: DVOL level z regime
  configs.push({
    id: `P2_dvolz_w${zw}`,
    pos: (i) => {
      const z = dvolZ(i, zw);
      if (!isFinite(z)) return NaN;
      const longGamma = z < 0; // calm => pinned/long-gamma
      const move = Math.sign(logret[i]);
      if (move === 0) return 0;
      return longGamma ? -move : move;
    },
  });
  // P3: DVOL momentum regime (5d change)
  configs.push({
    id: `P3_dvolmom_w${zw}`,
    pos: (i) => {
      if (i < 5) return NaN;
      const dm = rows[i].dvol - rows[i - 5].dvol;
      const move = Math.sign(logret[i]);
      if (move === 0) return 0;
      const longGamma = dm < 0; // DVOL falling => long-gamma building
      return longGamma ? -move : move;
    },
  });
}

// ---------------------------------------------------------------------------
// Backtest each config: daily PnL = pos[i] * fwd[i] - cost on position change.
// ---------------------------------------------------------------------------
function backtest(cfg: Cfg): { ret: number[]; turnover: number } {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < N - 1; i++) {
    const p = cfg.pos(i);
    if (!isFinite(p) || !isFinite(fwd[i])) {
      continue;
    }
    const cost = Math.abs(p - prev) * (RT_COST / 2); // per-side on change
    out.push(p * fwd[i] - cost);
    prev = p;
  }
  const turnover = out.length ? out.length : 0;
  return { ret: out, turnover };
}

// honest N = every config tried (3 P1 + 2 P2 + 2 P3 = 7) PLUS the 2 sign conventions
// we *could* have flipped = treat as 7 distinct configs under one fixed sign; but the
// sign flip is an extra DoF, so honest trial count = configs * 2 sign-conventions = 14.
const HONEST_N = configs.length * 2;

type Res = {
  id: string;
  n: number;
  grossSharpeAnn: number;
  netSharpeAnn: number;
  monthlyPctNet: number;
  ret: number[];
};
const allRes: Res[] = [];
for (const cfg of configs) {
  const { ret } = backtest(cfg);
  const net = sharpe(ret);
  // gross = same but no cost
  let prev = 0;
  const gross: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    const p = cfg.pos(i);
    if (!isFinite(p) || !isFinite(fwd[i])) continue;
    gross.push(p * fwd[i]);
    prev = p;
  }
  const meanNet = summarizeReturnSeries(ret).mean;
  allRes.push({
    id: cfg.id,
    n: ret.length,
    grossSharpeAnn: annualize(sharpe(gross)),
    netSharpeAnn: annualize(net),
    monthlyPctNet: meanNet * 21 * 100,
    ret,
  });
}
allRes.sort((a, b) => b.netSharpeAnn - a.netSharpeAnn);
const best = allRes[0];

// ---------------------------------------------------------------------------
// CONTROL A4: pure realized-vol regime (no DVOL/gamma at all). High-RV => follow,
// low-RV => fade — the same structural idea WITHOUT any options/gamma input. If the
// gamma proxy can't beat this, the "gamma" content is just a vol regime.
// ---------------------------------------------------------------------------
function rvRegimePos(i: number, win: number, thresh: number): number {
  const rv = trailingRVann(i, win);
  if (!isFinite(rv)) return NaN;
  const move = Math.sign(logret[i]);
  if (move === 0) return 0;
  const calm = rv < thresh; // low realized vol => fade (mean-revert)
  return calm ? -move : move;
}
// pick the best RV-only regime (its own small search; same family)
let bestRV = { id: "", s: -Infinity, ret: [] as number[] };
for (const w of RV_WIN) {
  // threshold = trailing median of RV over sample (use global median as a fair, non-peeking-ish proxy)
  const rvs = [];
  for (let i = 0; i < N; i++) {
    const v = trailingRVann(i, w);
    if (isFinite(v)) rvs.push(v);
  }
  const med = rvs.slice().sort((a, b) => a - b)[Math.floor(rvs.length / 2)];
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < N - 1; i++) {
    const p = rvRegimePos(i, w, med);
    if (!isFinite(p) || !isFinite(fwd[i])) continue;
    out.push(p * fwd[i] - Math.abs(p - prev) * (RT_COST / 2));
    prev = p;
  }
  const s = annualize(sharpe(out));
  if (s > bestRV.s) bestRV = { id: `RVregime_w${w}`, s, ret: out };
}

// ---------------------------------------------------------------------------
// NULLS for the best gamma-proxy config:
//   (1) label-shuffle: shuffle fwd[] (destroys any real predictive link; exposes the
//       fixed-sign DoF — if shuffled mean >= real, the sign convention is the only "edge")
//   (2) vol-preserving block surrogate: block-bootstrap the (pos, fwd) PAIRS' returns to
//       preserve autocorr/vol clustering while destroying the specific timing.
// ---------------------------------------------------------------------------
const r = rng(0xD3B1);
const ITER = 2000;

// reconstruct best config's (pos, fwd) aligned arrays
const bestCfg = configs.find((c) => c.id === best.id)!;
const posArr: number[] = [];
const fwdArr: number[] = [];
for (let i = 0; i < N - 1; i++) {
  const p = bestCfg.pos(i);
  if (!isFinite(p) || !isFinite(fwd[i])) continue;
  posArr.push(p);
  fwdArr.push(fwd[i]);
}
const realRet = posArr.map((p, k) => p * fwdArr[k]);
const realSharpe = sharpe(realRet);

// (1) label-shuffle
let geLabel = 0;
for (let it = 0; it < ITER; it++) {
  const sh = fwdArr.slice();
  for (let i = sh.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [sh[i], sh[j]] = [sh[j], sh[i]];
  }
  const s = sharpe(posArr.map((p, k) => p * sh[k]));
  if (s >= realSharpe) geLabel++;
}
const pLabel = (geLabel + 1) / (ITER + 1);

// (2) vol-preserving block surrogate (block-bootstrap the realized strategy returns)
const blk = Math.max(5, Math.round(Math.sqrt(realRet.length)));
let geBlock = 0;
let blockMean = 0;
for (let it = 0; it < ITER; it++) {
  const bs = blockResample(realRet, blk, r);
  const s = sharpe(bs);
  blockMean += s;
  if (s >= realSharpe) geBlock++;
}
blockMean /= ITER;
const pBlock = (geBlock + 1) / (ITER + 1);

// ---------------------------------------------------------------------------
// DSR @ honest N, block-bootstrap CI, CSCV/PBO across the proxy configs.
// ---------------------------------------------------------------------------
const dsr = computeDeflatedSharpeRatio(best.ret, { trialCount: HONEST_N });
const ci = blockBootstrapConfidenceInterval(best.ret, {
  statistic: "sharpe",
  iterations: 2000,
  seed: "d3b1",
});

// PBO: split each config's returns into 8 contiguous folds
const FOLDS = 8;
const pboInput = allRes.map((res) => {
  const folds: number[][] = [];
  const fl = Math.floor(res.ret.length / FOLDS);
  for (let f = 0; f < FOLDS; f++) {
    folds.push(res.ret.slice(f * fl, f === FOLDS - 1 ? res.ret.length : (f + 1) * fl));
  }
  return { id: res.id, folds };
});
const pbo = estimateCscvPbo(pboInput, { statistic: "sharpe" });

// does best gamma-proxy beat the RV-only regime control?
const beatsRV = best.netSharpeAnn > bestRV.s;

const summary = {
  test: "D3-B1 Dealer GEX / gamma walls / zero-gamma flip",
  dataFidelity:
    "PROXY-ONLY. No per-strike OI, no per-strike gamma, no walls, no flip point. " +
    "Uses Deribit DVOL daily history as a degraded long/short-gamma regime proxy on the " +
    "directional core of claim (1) ONLY. NOT provider-canonical; cannot SURVIVE here.",
  sample: { n: N, from: rows[0]?.date, to: rows[N - 1]?.date },
  honestN: HONEST_N,
  realisticCostRoundTrip: RT_COST,
  bestProxy: {
    id: best.id,
    grossSharpeAnn: best.grossSharpeAnn,
    netSharpeAnn: best.netSharpeAnn,
    monthlyPctNet: best.monthlyPctNet,
  },
  allConfigsNetSharpeAnn: allRes.map((r) => ({ id: r.id, net: r.netSharpeAnn })),
  controls: {
    rvOnlyRegime_A4: { id: bestRV.id, netSharpeAnn: bestRV.s },
    beatsRVonlyRegime: beatsRV,
  },
  nulls: {
    labelShuffle_p: pLabel,
    blockSurrogate_p: pBlock,
    blockSurrogateMeanSharpe: annualize(blockMean),
    realSharpeAnn: annualize(realSharpe),
  },
  gauntlet: {
    dsr_p_at_honestN: dsr.probability,
    dsr_expectedMaxSharpe: dsr.expectedMaxSharpe,
    pbo: pbo.pbo,
    blockBootstrapSharpeCI: { lower: ci.lower, upper: ci.upper },
  },
};

fs.writeFileSync(path.join(OUT, "d3b1-gex-proxy.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
