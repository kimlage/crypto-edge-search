/**
 * On-chain distribution-pressure POC — STEP 2+3+4: build the overlay, validate, verdict.
 *
 * Program's 28th hypothesis (docs/ONCHAIN_FEASIBILITY.md §3). It goes through the
 * COMMITTED harness src/lib/validation/strategy-validator.ts (validateStrategy) and
 * the COMMITTED gates in src/lib/training/. NOTHING here reimplements or relaxes a gate.
 *
 * SIGNAL (two-gate distribution-pressure overlay), per asset, daily, CAUSAL:
 *   netflow   = FlowInExNtv - FlowOutExNtv               (native units; + = coins TO exchanges)
 *   netflow_z = z(netflow, trailing 90d)                 (high = distribution pressure)
 *   mvrv      = CapMVRVCur                                (high = holders in profit)
 *   Position(long/flat, vol-targeted):
 *     risk-OFF (flat) when netflow_z >= +zThr  AND  mvrv >= mvrvThr   (agreement: distribution)
 *     risk-ON  (long) otherwise, scaled to a vol target               (hold-beta)
 *   The "agreement rule" variant additionally requires BOTH gates to flip to go flat;
 *   the "either" variant goes flat if EITHER gate fires (looser). Both are counted in N.
 *
 * LOOK-AHEAD CONTROL (mandatory — the #1 false-positive risk here):
 *   CM on-chain metrics are REVISED (flash/reviewed flags; NOT point-in-time). We LAG
 *   every on-chain feature by FEATURE_LAG_DAYS (>=1). The position held over the bar
 *   t -> t+1 (which earns return r_{t+1}) is decided ONLY from on-chain features known
 *   at or before day t-FEATURE_LAG_DAYS. The trailing-90d z-score window also ends at
 *   that lagged day. No same-day on-chain value ever touches the same day's return.
 *   The realized vol used for vol-targeting is built from PAST returns only (shifted).
 *
 * HONEST N: every config actually evaluated is counted (see CONFIGS below) and passed
 * as the explicit trialCount to validateStrategy / DSR. We do NOT pretend N=1.
 *
 * SURROGATE NULL: crossSectional:FALSE (phase-rand + block-bootstrap), seeded with the
 * [BTC,ETH] return marginals, 200 iters, maxPlaceboP 0.05 — the correct TIME-SERIES null
 * (a state predicts the SAME asset's forward return), NOT the cross-sectional rotation
 * shuffle that correctly killed C1/C2.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/onchain-poc/run_poc.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateStrategy,
  type StrategyValidatorVerdict,
} from "../../src/lib/validation/strategy-validator";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT = resolve(ROOT, "output/onchain-poc");
mkdirSync(OUT, { recursive: true });

// ---- LOOK-AHEAD / LAG CONTROL ------------------------------------------------
const FEATURE_LAG_DAYS = 1;   // on-chain features lagged >=1 day (revised, not point-in-time)
const Z_WINDOW = 90;          // trailing window for netflow z-score (one of the swept lookbacks)
const VOL_WINDOW = 30;        // realized-vol window for vol-targeting (PAST returns only)
const VOL_TARGET = 0.02;      // daily vol target (~32% annualized)
const MAX_LEVERAGE = 1.0;     // long/flat spot, no leverage
const TAKER_PER_SIDE = 0.0004; // 4 bps/side taker; round-trip = 8 bps

// ---- DATA --------------------------------------------------------------------
interface CmRow { time: string; netflow: number; mvrv: number; ret: number | null; }

function loadAsset(asset: string): CmRow[] {
  const raw = JSON.parse(readFileSync(`${OUT}/cm_${asset}.json`, "utf8"));
  const rows: any[] = raw.data;
  // CM pages can arrive out of strict order -> sort by time ascending, dedupe.
  const byTime = new Map<string, any>();
  for (const r of rows) byTime.set(r.time, r);
  const sorted = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
  const out: CmRow[] = [];
  let prevPrice: number | null = null;
  for (const r of sorted) {
    const inF = Number(r.FlowInExNtv);
    const outF = Number(r.FlowOutExNtv);
    const mvrv = Number(r.CapMVRVCur);
    const price = Number(r.PriceUSD);
    const netflow = Number.isFinite(inF) && Number.isFinite(outF) ? inF - outF : NaN;
    // simple daily return from CM PriceUSD (return realized over [prev, this] day)
    const ret = prevPrice != null && Number.isFinite(price) && prevPrice > 0
      ? price / prevPrice - 1
      : null;
    out.push({ time: r.time, netflow, mvrv, ret });
    if (Number.isFinite(price)) prevPrice = price;
  }
  return out;
}

// trailing z-score using ONLY values strictly before/at the index (causal)
function trailingZ(values: number[], idx: number, window: number): number {
  const lo = Math.max(0, idx - window + 1);
  const slice: number[] = [];
  for (let i = lo; i <= idx; i += 1) if (Number.isFinite(values[i])) slice.push(values[i]);
  if (slice.length < Math.floor(window / 3)) return NaN; // need enough history
  const m = slice.reduce((s, v) => s + v, 0) / slice.length;
  const sd = Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, slice.length - 1));
  return sd > 1e-12 ? (values[idx] - m) / sd : 0;
}

// trailing realized daily vol from PAST returns only (ends at idx, causal)
function trailingVol(rets: (number | null)[], idx: number, window: number): number {
  const lo = Math.max(0, idx - window + 1);
  const slice: number[] = [];
  for (let i = lo; i <= idx; i += 1) {
    const v = rets[i];
    if (v != null && Number.isFinite(v)) slice.push(v);
  }
  if (slice.length < 5) return NaN;
  const m = slice.reduce((s, v) => s + v, 0) / slice.length;
  const sd = Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, slice.length - 1));
  return sd;
}

interface SignalConfig {
  id: string;
  zLookback: number;   // netflow z window
  mvrvThr: number;     // MVRV "elevated" threshold
  zThr: number;        // netflow_z "high" threshold
  agreement: "both" | "either"; // go flat when BOTH gates fire, or EITHER
}

// Build the causal, LAGGED position + per-bar strategy return for one asset+config.
function buildAssetReturns(rows: CmRow[], cfg: SignalConfig): {
  positions: number[]; returns: number[]; bars: number; trades: number;
} {
  const n = rows.length;
  const netflows = rows.map((r) => r.netflow);
  const mvrvs = rows.map((r) => r.mvrv);
  const rets = rows.map((r) => r.ret);

  const positions: number[] = [];
  const returns: number[] = [];
  let trades = 0;
  let prevPos = 0;

  // We decide the position for the bar t->t+1 (which earns rets[t+1]) using features
  // known at the LAGGED decision day d = t - FEATURE_LAG_DAYS.
  for (let t = 0; t < n - 1; t += 1) {
    const d = t - FEATURE_LAG_DAYS;
    let pos = 0;
    if (d >= cfg.zLookback) {
      const z = trailingZ(netflows, d, cfg.zLookback);
      const mvrv = mvrvs[d];
      const vol = trailingVol(rets, d, VOL_WINDOW); // PAST returns only, ends at d
      if (Number.isFinite(z) && Number.isFinite(mvrv) && Number.isFinite(vol) && vol > 1e-6) {
        const distGate = z >= cfg.zThr;       // coins flowing TO exchanges
        const profitGate = mvrv >= cfg.mvrvThr; // holders in profit
        const goFlat = cfg.agreement === "both"
          ? (distGate && profitGate)
          : (distGate || profitGate);
        if (!goFlat) {
          // risk-ON: long, vol-targeted, capped, long-only (no shorts)
          pos = Math.min(MAX_LEVERAGE, VOL_TARGET / vol);
          pos = Math.max(0, pos);
        }
      }
    }
    const fwd = rets[t + 1];
    if (fwd == null || !Number.isFinite(fwd)) { continue; } // skip bars with no return
    returns.push(pos * fwd);
    positions.push(pos);
    trades += Math.abs(pos - prevPos) > 1e-9 ? 1 : 0;
    prevPos = pos;
  }
  return { positions, returns, bars: returns.length, trades };
}

// ---- the swept configuration grid = HONEST N --------------------------------
// 2 assets x {zLookback in 3} x {mvrvThr in 3} x {agreement in 2} = 36 configs.
const Z_LOOKBACKS = [60, 90, 120];
const MVRV_THRS = [1.5, 2.0, 2.5];
const Z_THRS_FOR_DEFAULT = 1.0; // fixed "high" z threshold; thresholds swept via MVRV + agreement
const AGREEMENTS: SignalConfig["agreement"][] = ["both", "either"];
const ASSETS = ["btc", "eth"] as const;

function enumerateConfigs(): SignalConfig[] {
  const cfgs: SignalConfig[] = [];
  for (const zl of Z_LOOKBACKS)
    for (const mt of MVRV_THRS)
      for (const ag of AGREEMENTS)
        cfgs.push({ id: `z${zl}_m${mt}_${ag}`, zLookback: zl, mvrvThr: mt, zThr: Z_THRS_FOR_DEFAULT, agreement: ag });
  return cfgs; // 3*3*2 = 18 per asset; x2 assets = 36 honest trials
}

function meanArr(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function sharpePer(a: number[]): number {
  if (a.length < 2) return 0;
  const m = meanArr(a);
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  return sd > 1e-12 ? m / sd : 0;
}

function main() {
  const btcRows = loadAsset("btc");
  const ethRows = loadAsset("eth");
  console.log(`Loaded BTC ${btcRows.length} rows (${btcRows[0]?.time?.slice(0,10)} .. ${btcRows[btcRows.length-1]?.time?.slice(0,10)})`);
  console.log(`Loaded ETH ${ethRows.length} rows (${ethRows[0]?.time?.slice(0,10)} .. ${ethRows[ethRows.length-1]?.time?.slice(0,10)})`);

  const configs = enumerateConfigs();
  const HONEST_N = configs.length * ASSETS.length; // 18 * 2 = 36
  console.log(`\nHONEST N (configs x assets) = ${configs.length} x ${ASSETS.length} = ${HONEST_N}`);
  console.log(`LOOK-AHEAD CONTROL: features lagged ${FEATURE_LAG_DAYS}d; z-window ${Z_WINDOW}d ends at lagged day; vol from PAST returns only.`);

  // In-sample selection (search) picks the BEST config by per-period Sharpe of the
  // BTC+ETH equal-weight sleeve. The harness then evaluates that selected sleeve with
  // the honest N=36, so DSR/haircut pay the full multiple-testing tax of the search.
  let best: {
    cfg: SignalConfig; sleeve: number[]; btc: number[]; eth: number[];
    btcPos: number[]; ethPos: number[]; turnover: number; sharpe: number;
  } | null = null;

  const scan: any[] = [];
  for (const cfg of configs) {
    const b = buildAssetReturns(btcRows, cfg);
    const e = buildAssetReturns(ethRows, cfg);
    const len = Math.min(b.returns.length, e.returns.length);
    // align from the END (most-recent), so the holdout slice is the recent common window
    const bTail = b.returns.slice(b.returns.length - len);
    const eTail = e.returns.slice(e.returns.length - len);
    const bPosTail = b.positions.slice(b.positions.length - len);
    const ePosTail = e.positions.slice(e.positions.length - len);
    const sleeve = bTail.map((v, i) => 0.5 * v + 0.5 * (eTail[i] ?? 0));
    const sh = sharpePer(sleeve);
    const turnover = b.trades + e.trades;
    scan.push({ id: cfg.id, sharpe: Number(sh.toFixed(4)), bars: sleeve.length, trades: turnover });
    if (!best || sh > best.sharpe) {
      best = { cfg, sleeve, btc: bTail, eth: eTail, btcPos: bPosTail, ethPos: ePosTail, turnover, sharpe: sh };
    }
  }
  if (!best) throw new Error("no config produced a sleeve");

  console.log(`\nBest in-sample config: ${best.cfg.id}  per-period Sharpe=${best.sharpe.toFixed(4)}  bars=${best.sleeve.length}  trades=${best.turnover}`);

  // sleeve-level position path (avg of the two legs' positions) for turnover/cost.
  const sleevePos = best.btcPos.map((p, i) => 0.5 * p + 0.5 * (best!.ethPos[i] ?? 0));

  // Baselines over the SAME window: buy-and-hold (equal-weight BTC+ETH price returns).
  const minLen = best.sleeve.length;
  const btcRet = btcRows.map((r) => r.ret ?? 0);
  const ethRet = ethRows.map((r) => r.ret ?? 0);
  const btcBH = btcRet.slice(btcRet.length - minLen);
  const ethBH = ethRet.slice(ethRet.length - minLen);
  const bhEqual = btcBH.map((v, i) => 0.5 * v + 0.5 * (ethBH[i] ?? 0));

  // Surrogate panel = the two assets' STRATEGY return marginals (time-series null:
  // does a phase-randomized / block-bootstrapped version of the SAME paths reproduce it?)
  const panel = [best.btc, best.eth];

  const verdict: StrategyValidatorVerdict = validateStrategy(best.sleeve, {
    trialCount: HONEST_N, // 36 — every config x asset actually evaluated
    statistic: "mean",
    cost: { takerPerSide: TAKER_PER_SIDE, position: sleevePos },
    baselines: {
      marketReturns: bhEqual,        // buy-and-hold + (random-lottery derived from it)
      equalWeightReturns: bhEqual,   // equal-weight panel
      linearReturns: undefined,      // no linear forecaster fitted (none claimed)
      roundTripCost: TAKER_PER_SIDE * 2,
    },
    surrogate: {
      iterations: 200,
      crossSectional: false,         // TIME-SERIES null (NOT the rotation shuffle)
      panel: { assetReturns: panel },
      seed: "onchain-distribution-pressure",
    },
    holdout: {
      holdoutFraction: 0.15,         // most-recent slice, scored exactly once
      testFraction: 0.15,
      reason: "onchain-poc-distribution-pressure",
    },
    minDeflatedProbability: 0.95,
    maxPbo: 0.5,
    maxPlaceboP: 0.05,
    seed: "onchain-poc",
  });

  // ---- print the full per-gate verdict + which gate is binding ---------------
  const lines: string[] = [];
  lines.push("\n================ ON-CHAIN DISTRIBUTION-PRESSURE POC — VERDICT ================");
  lines.push(`VERDICT: ${verdict.verdict}   BINDING GATE: ${verdict.bindingGate ?? "none (all passed)"}`);
  lines.push(`Honest N (trialCount): ${verdict.trialCount}`);
  lines.push(
    `net: mean=${verdict.netStats.mean.toExponential(3)} compound=${verdict.netStats.compoundReturn.toFixed(5)} ` +
    `sharpe(per-period)=${verdict.netStats.sharpe.toFixed(4)} sharpe(annualized~)=${(verdict.netStats.sharpe * Math.sqrt(365)).toFixed(3)} ` +
    `grossSharpe=${verdict.netStats.grossSharpe.toFixed(4)} turnover=${verdict.netStats.turnover.toFixed(0)} samples=${verdict.netStats.sampleCount}`,
  );
  lines.push("\nPER-GATE (first failing gate is binding):");
  for (const g of verdict.perGate) {
    lines.push(`  [${g.passed ? "PASS" : "KILL"}] ${g.id} — ${g.label}`);
    lines.push(`        ${g.reason}`);
  }
  const text = lines.join("\n");
  console.log(text);

  writeFileSync(`${OUT}/verdict.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    lookAheadControl: {
      featureLagDays: FEATURE_LAG_DAYS,
      zWindow: best.cfg.zLookback,
      volWindow: VOL_WINDOW,
      note: "On-chain features (netflow, MVRV) decided at day d=t-lag drive the position over bar t->t+1 which earns ret_{t+1}. z-window and vol-window end at the lagged day; vol from past returns only. CM flash/reviewed flags persisted in cache.",
    },
    honestN: HONEST_N,
    bestConfig: best.cfg,
    inSampleSharpe: best.sharpe,
    turnover: verdict.netStats.turnover,
    scan,
    verdict,
  }, null, 2));
  writeFileSync(`${OUT}/verdict.txt`, text + "\n");
  console.log(`\nWrote ${OUT}/verdict.json and verdict.txt`);
}

main();

export {};
