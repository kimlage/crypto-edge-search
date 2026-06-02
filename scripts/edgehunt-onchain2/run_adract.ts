/**
 * O1-ADRACT — Active-address / tx-count network-activity momentum (timer).
 *
 * Belief: rising on-chain network activity (AdrActCnt + TxCnt growth) signals genuine adoption that
 * LEADS price -> a lagged network-growth momentum timer should out-time buy&hold.
 *
 * Strongest honest version built here:
 *   - Free CM Community metrics ONLY: AdrActCnt, TxCnt (verified community:true), PriceUSD.
 *   - Network-activity composite = mean of log-AdrActCnt-momentum and log-TxCnt-momentum, where
 *     momentum = fastEMA(log activity) - slowEMA(log activity) (network-GROWTH momentum).
 *   - Feature LAGGED >= 1 day (causality; respects on-chain revision/flash risk).
 *   - Position from a rolling-Z threshold rule on the lagged network momentum: long-flat /
 *     long-short / charitable beta-tilt overlay.
 *   - honest N = full config grid (every fast/slow/zwin/threshold/side combination).
 *
 * The decisive controls (documented trap = reverse-causality echo: on-chain activity LAGS price):
 *   1. Must out-Sharpe its OWN buy&hold after deflation (baselines gate).
 *   2. RIGHT surrogate null = phase-randomization of the network-momentum signal (preserve
 *      spectrum/autocorrelation/vol, destroy timing vs the real price path) -> harness surrogate.
 *   3. AR-matched placebo null (extra, reported here): fit an AR(p) to the signal and regenerate
 *      matched surrogates; the strategy's IS Sharpe must beat that distribution too.
 *   4. consume-once forward holdout (last 20%).
 *
 * We run the committed gauntlet (scripts/edgehunt-D5/harness.ts::runGauntlet) for BTC and ETH.
 */
import fs from "node:fs";
import {
  type Panel,
  runPositions,
  sharpeDaily,
  annSharpe,
  mkRng,
  mean,
  std,
  rollingZ,
  ema,
  runGauntlet,
  printVerdict,
  type GauntletInput,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-onchain2`;
const LAG = 1;

// ---- build an extended Panel that ALSO carries TxCnt (and full-history AdrActCnt) ----
interface NetPanel extends Panel {
  tx: number[];
}

function loadNetPanel(asset: "btc" | "eth"): NetPanel {
  const net = JSON.parse(
    fs.readFileSync(`${OUT}/cm_txcnt_${asset}.json`, "utf8"),
  ).data as { time: string; AdrActCnt: string | null; TxCnt: string | null }[];
  const nm = new Map<string, { adr: number; tx: number }>();
  for (const r of net) {
    const d = r.time.slice(0, 10);
    nm.set(d, {
      adr: r.AdrActCnt != null ? Number(r.AdrActCnt) : NaN,
      tx: r.TxCnt != null ? Number(r.TxCnt) : NaN,
    });
  }
  const poc = JSON.parse(fs.readFileSync(`${ROOT}/output/onchain-poc/cm_${asset}.json`, "utf8"))
    .data as { time: string; PriceUSD: string | null }[];
  const pm = new Map<string, number>();
  for (const r of poc) {
    const d = r.time.slice(0, 10);
    if (r.PriceUSD != null) pm.set(d, Number(r.PriceUSD));
  }
  const extra = JSON.parse(
    fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_${asset}.json`, "utf8"),
  ).data as { time: string; PriceUSD: string | null }[];
  for (const r of extra) {
    const d = r.time.slice(0, 10);
    if (!pm.has(d) && r.PriceUSD != null) pm.set(d, Number(r.PriceUSD));
  }
  const dates = [...pm.keys()].filter((d) => nm.has(d)).sort();
  const P: NetPanel = {
    asset,
    dates: [],
    price: [],
    mvrv: [],
    flowInNtv: [],
    flowOutNtv: [],
    adr: [],
    tx: [],
    marketCap: [],
    hashRate: [],
    supply: [],
    realizedCap: [],
    realizedPrice: [],
    fwdRet: [],
  };
  for (const d of dates) {
    const p = pm.get(d)!;
    const n = nm.get(d)!;
    if (!(p > 0) || !(n.adr > 0)) continue;
    P.dates.push(d);
    P.price.push(p);
    P.adr.push(n.adr);
    P.tx.push(n.tx);
    P.mvrv.push(NaN);
    P.flowInNtv.push(NaN);
    P.flowOutNtv.push(NaN);
    P.marketCap.push(NaN);
    P.hashRate.push(NaN);
    P.supply.push(NaN);
    P.realizedCap.push(NaN);
    P.realizedPrice.push(NaN);
  }
  const T = P.price.length;
  for (let t = 0; t < T; t++) P.fwdRet.push(t + 1 < T ? Math.log(P.price[t + 1] / P.price[t]) : NaN);
  return P;
}

function lagArr(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

// network-activity momentum signal = mean of standardized [adrMom, txMom], LAGGED.
// adrMom = EMA_fast(log adr) - EMA_slow(log adr); same for tx.
function netMomSignal(P: NetPanel, fast: number, slow: number): number[] {
  const logAdr = P.adr.map((v) => (v > 0 ? Math.log(v) : NaN));
  const logTx = P.tx.map((v) => (v > 0 ? Math.log(v) : NaN));
  const adrMom = ema(logAdr, fast).map((v, i) => v - ema(logAdr, slow)[i]);
  // recompute slow once (avoid recompute in map closure)
  const adrSlow = ema(logAdr, slow);
  const adrFast = ema(logAdr, fast);
  const txSlow = ema(logTx, slow);
  const txFast = ema(logTx, fast);
  const am = adrFast.map((v, i) => v - adrSlow[i]);
  const tm = txFast.map((v, i) => v - txSlow[i]);
  void adrMom;
  // standardize each by its own trailing std would need rolling; for the composite we just average,
  // both are in log-units of the same activity scale, so a simple mean is fine (z-scored later).
  const comp = am.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(tm[i]) ? (v + tm[i]) / 2 : Number.isFinite(v) ? v : tm[i],
  );
  return lagArr(comp, LAG);
}

type Cfg = {
  fast: number;
  slow: number;
  zwin: number;
  thr: number;
  side: "longflat" | "longshort" | "tilt";
};

function cfgKey(c: Record<string, number | string>): Cfg {
  return c as unknown as Cfg;
}

function buildPositionFromSignal(P: NetPanel, sig: number[], cfg: Cfg): number[] {
  const z = rollingZ(sig, cfg.zwin);
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    if (cfg.side === "tilt") {
      // charitable beta-timer: long unless network momentum is strongly negative
      pos[t] = z[t] <= -cfg.thr ? 0 : 1;
    } else if (z[t] >= cfg.thr) {
      pos[t] = 1; // network momentum strong & rising -> long
    } else if (z[t] <= -cfg.thr) {
      pos[t] = cfg.side === "longshort" ? -1 : 0;
    } else {
      pos[t] = 0;
    }
  }
  return pos;
}

function makeGrid(): Cfg[] {
  const fasts = [7, 14, 30];
  const slows = [30, 60, 90, 180];
  const zwins = [180, 365, 730];
  const thrs = [0, 0.5, 1.0];
  const sides: Cfg["side"][] = ["longflat", "longshort", "tilt"];
  const grid: Cfg[] = [];
  for (const fast of fasts)
    for (const slow of slows) {
      if (slow <= fast) continue;
      for (const zwin of zwins)
        for (const thr of thrs)
          for (const side of sides) grid.push({ fast, slow, zwin, thr, side });
    }
  return grid;
}

// ---- AR-matched placebo: fit AR(p) to the signal, regenerate matched surrogates ----
function arFit(x: number[], p: number): { phi: number[]; mu: number; sigma: number } {
  const v = x.filter((q) => Number.isFinite(q));
  const n = v.length;
  const mu = v.reduce((s, q) => s + q, 0) / n;
  const c = (k: number) => {
    let s = 0;
    for (let i = k; i < n; i++) s += (v[i] - mu) * (v[i - k] - mu);
    return s / n;
  };
  const r = Array.from({ length: p + 1 }, (_, k) => c(k));
  // Yule-Walker via Levinson-Durbin
  const phi = new Array(p).fill(0);
  let e = r[0];
  for (let i = 0; i < p; i++) {
    let acc = r[i + 1];
    for (let j = 0; j < i; j++) acc -= phi[j] * r[i - j];
    const k = e > 1e-12 ? acc / e : 0;
    const prev = phi.slice(0, i);
    phi[i] = k;
    for (let j = 0; j < i; j++) phi[j] = prev[j] - k * prev[i - 1 - j];
    e *= 1 - k * k;
  }
  return { phi, mu, sigma: Math.sqrt(Math.max(0, e)) };
}

function arSurrogate(x: number[], fit: { phi: number[]; mu: number; sigma: number }, rng: () => number): number[] {
  const p = fit.phi.length;
  const T = x.length;
  const out = new Array(T).fill(NaN);
  // find first finite index
  let start = 0;
  while (start < T && !Number.isFinite(x[start])) start++;
  // seed with the real (de-meaned) values for the first p finite points
  const buf: number[] = [];
  for (let t = start; t < T; t++) {
    if (!Number.isFinite(x[t])) {
      out[t] = NaN;
      continue;
    }
    let val: number;
    if (buf.length < p) {
      val = x[t] - fit.mu; // warmup: keep real to preserve initial conditions
    } else {
      let pred = 0;
      for (let j = 0; j < p; j++) pred += fit.phi[j] * buf[buf.length - 1 - j];
      // gaussian innovation
      const u1 = Math.max(1e-12, rng());
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      val = pred + fit.sigma * z;
    }
    buf.push(val);
    out[t] = val + fit.mu;
  }
  return out;
}

function main() {
  const asset = (process.argv[2] as "btc" | "eth") || "btc";
  const P = loadNetPanel(asset);
  const T = P.price.length;
  console.log(`\n##### O1-ADRACT ${asset.toUpperCase()} | T=${T} ${P.dates[0]}..${P.dates[T - 1]} #####`);

  const grid = makeGrid();
  // precompute signals per (fast,slow) to avoid recompute
  const sigCache = new Map<string, number[]>();
  const sigFor = (cfg: Cfg) => {
    const k = `${cfg.fast}-${cfg.slow}`;
    let s = sigCache.get(k);
    if (!s) {
      s = netMomSignal(P, cfg.fast, cfg.slow);
      sigCache.set(k, s);
    }
    return s;
  };

  // warmup start: need slow EMA + zwin to be meaningful. Use 800 to be safe (>= max slow+zwin? zwin
  // is rolling so it self-warms; we just need enough finite history). Use 400.
  const startIdx = 400;

  const input: GauntletInput = {
    name: `O1-ADRACT-${asset}`,
    P,
    buildPosition: (c) => buildPositionFromSignal(P, sigFor(cfgKey(c)), cfgKey(c)),
    buildSurrogatePosition: (c, rng) => {
      const cfg = cfgKey(c);
      const sig = sigFor(cfg);
      const surr = phaseRandomize(sig, rng);
      return buildPositionFromSignal(P, surr, cfg);
    },
    configs: grid as unknown as Record<string, number | string>[],
    canonical: { fast: 14, slow: 60, zwin: 365, thr: 0, side: "longflat" },
    startIdx,
    holdoutFrac: 0.2,
    nSurr: 300,
  };

  const out = runGauntlet(input);
  printVerdict(out);

  // ---- EXTRA: AR-matched placebo null for the IS-best config ----
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * 0.8);
  const bestCfg = cfgKey(out.best.cfg);
  const bestSig = sigFor(bestCfg);
  const bestPos = buildPositionFromSignal(P, bestSig, bestCfg);
  const bestIS = annSharpe(sharpeDaily(runPositions(P, bestPos, startIdx, splitIdx).dailyNet));
  const arFitP = arFit(bestSig, 5);
  const nAr = 300;
  const arSh: number[] = [];
  for (let i = 0; i < nAr; i++) {
    const rng = mkRng(31000 + i * 7919);
    const surr = arSurrogate(bestSig, arFitP, rng);
    const sp = buildPositionFromSignal(P, surr, bestCfg);
    arSh.push(annSharpe(sharpeDaily(runPositions(P, sp, startIdx, splitIdx).dailyNet)));
  }
  arSh.sort((a, b) => a - b);
  const arP = (arSh.filter((s) => s >= bestIS).length + 1) / (nAr + 1);
  console.log(
    `AR-matched placebo (AR(5)): bestIS=${bestIS.toFixed(3)} arMean=${mean(arSh).toFixed(3)} ar95=${arSh[Math.floor(nAr * 0.95)].toFixed(3)} -> AR-placebo p=${arP.toFixed(4)} ${arP < 0.05 ? "PASS" : "FAIL"}`,
  );

  fs.writeFileSync(
    `${OUT}/result_adract_${asset}.json`,
    JSON.stringify({ ...out, arPlaceboP: arP, arBestIS: bestIS }, null, 2),
  );
  return { out, arP };
}

main();
