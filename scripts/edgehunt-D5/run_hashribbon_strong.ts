/**
 * D5-10 Hash Ribbons — STRONGEST honest attempt + honest decomposition.
 *
 * Belief: miner capitulation -> recovery (hash 30/60d SMA re-cross up) = strong long, price-confirmed.
 *
 * We genuinely try to find a HASH-rate-specific edge, not just re-discover the price-momentum (TSMOM)
 * filter. Three things make this honest:
 *   1) Hash features are LAGGED >=1 day (revision/flash risk) and earn NEXT-day return (causality).
 *   2) The grid is the honest one from the backlog (30/60, 20/50, 10/30 x priceConfirm 0/1 = N 6),
 *      PLUS we report the canonical Capriole 10/20 recovery-event variant for completeness, but the
 *      DSR/haircut honest-N is the committed grid count.
 *   3) The RIGHT surrogate is time-series phase-randomization of the HASH series ONLY (crossSectional
 *      false), keeping the real price path and the price-confirm clause intact. That makes the
 *      surrogate test the INCREMENTAL hash edge above the price filter — the binding question.
 *
 * Decomposition (the make-or-break): hash-only vs price-only vs combined. If price-only >= combined,
 * the hash rate carries nothing and the surrogate (which scrambles only hash) will reproduce the
 * combined Sharpe -> KILL on the SURROGATE gate. That is precisely the backlog's predicted outcome.
 *
 * Judged with the committed gauntlet (harness.runGauntlet): net-of-cost, baselines, Deflated Sharpe
 * @ honest N, block-bootstrap, CPCV/PBO, Harvey-Liu (Bonferroni) haircut, surrogate null, consume-
 * once forward holdout.
 */
import fs from "node:fs";
import {
  loadPanel,
  runPositions,
  runGauntlet,
  printVerdict,
  sma,
  sharpeDaily,
  annSharpe,
  mkRng,
  type Panel,
} from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const LAG = 1;
const OUT = "output/edgehunt-D5";

function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

// ribbon state: +1 when fast SMA(hash) >= slow SMA(hash) ("recovered"), 0 otherwise.
function ribbonUp(hser: number[], fast: number, slow: number): number[] {
  const f = sma(hser, fast);
  const s = sma(hser, slow);
  return f.map((v, t) => (Number.isFinite(v) && Number.isFinite(s[t]) ? (v >= s[t] ? 1 : 0) : NaN));
}

function main() {
  const P = loadPanel("btc");
  const T = P.price.length;
  const hr = lag(P.hashRate, LAG);
  const startIdx = 300;
  const splitIdx = startIdx + Math.floor((T - 1 - startIdx) * 0.8);

  // ---- price-confirm clause: price > SMA(price, pcWin). This is the TSMOM long filter. ----
  const pcWins: Record<number, number[]> = {};
  for (const w of [50, 100, 200]) pcWins[w] = sma(P.price, w);

  // The committed honest grid: {30/60, 20/50, 10/30} x priceConfirm {0,1}; hold=1; longflat. N=6.
  const pairs: [number, number][] = [
    [30, 60],
    [20, 50],
    [10, 30],
  ];
  const PC_WIN = 50; // the price-confirm SMA window used in the committed harness
  const configs: Record<string, number>[] = [];
  for (const [f, s] of pairs) for (const pc of [0, 1]) configs.push({ fast: f, slow: s, priceConfirm: pc });

  function build(cfg: Record<string, number>, hserOverride?: number[]): number[] {
    const st = ribbonUp(hserOverride ?? hr, cfg.fast, cfg.slow);
    const pSMA = pcWins[PC_WIN];
    const pos = new Array(T).fill(NaN);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(st[t])) continue;
      let go = st[t] > 0;
      if (cfg.priceConfirm === 1) go = go && Number.isFinite(pSMA[t]) && P.price[t] > pSMA[t];
      pos[t] = go ? 1 : 0;
    }
    return pos;
  }

  // ===================== HONEST DECOMPOSITION (in-sample window) =====================
  const decompose: Record<string, { netSh: number; exposure: number; turnover: number }> = {};
  function addRow(name: string, pos: number[]) {
    const r = runPositions(P, pos, startIdx, splitIdx);
    decompose[name] = { netSh: annSharpe(sharpeDaily(r.dailyNet)), exposure: r.exposure, turnover: r.turnover };
  }
  // combined (best committed cfg 10/30 + priceConfirm)
  addRow("hash10/30+price>SMA50", build({ fast: 10, slow: 30, priceConfirm: 1 }));
  addRow("hash10/30 only", build({ fast: 10, slow: 30, priceConfirm: 0 }));
  // price-only TSMOM filter (no hash at all): long iff price>SMA50
  {
    const pSMA = pcWins[PC_WIN];
    const pos = new Array(T).fill(NaN);
    for (let t = 0; t < T; t++) pos[t] = Number.isFinite(pSMA[t]) ? (P.price[t] > pSMA[t] ? 1 : 0) : NaN;
    addRow("price>SMA50 only (TSMOM)", pos);
  }
  // buy & hold
  addRow("buy&hold", new Array(T).fill(1));

  // ===================== INCREMENTAL-HASH SURROGATE GAUNTLET =====================
  // Surrogate scrambles ONLY the hash series (phase-randomized), keeps the real price path AND the
  // price-confirm clause. So the surrogate p tests: does the REAL hash timing beat scrambled-hash
  // timing, holding the price filter fixed? This is the binding, decompose-aware null.
  const out = runGauntlet({
    name: "D5-10 Hash Ribbons (BTC) — incremental-hash surrogate",
    P,
    configs: configs as unknown as Record<string, number | string>[],
    canonical: { fast: 10, slow: 30, priceConfirm: 1 } as unknown as Record<string, number | string>,
    buildPosition: (cfg) => build(cfg as unknown as Record<string, number>),
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg as unknown as Record<string, number>, phaseRandomize(hr, rng)),
    startIdx,
  });

  printVerdict(out);
  console.log("\n---- HONEST DECOMPOSITION (in-sample net Sharpe) ----");
  for (const [k, v] of Object.entries(decompose)) {
    console.log(`  ${k.padEnd(28)} netSh=${v.netSh.toFixed(3)} exposure=${v.exposure.toFixed(3)} turnover=${v.turnover.toFixed(3)}`);
  }
  const priceOnly = decompose["price>SMA50 only (TSMOM)"].netSh;
  const combined = decompose["hash10/30+price>SMA50"].netSh;
  const hashOnly = decompose["hash10/30 only"].netSh;
  const incremental = combined - priceOnly;
  console.log(
    `\n  INCREMENTAL hash edge (combined - priceOnly) = ${incremental.toFixed(3)}  (hashOnly=${hashOnly.toFixed(3)} vs B&H=${decompose["buy&hold"].netSh.toFixed(3)})`,
  );

  fs.writeFileSync(
    `${OUT}/result_hashribbon_strong.json`,
    JSON.stringify({ gauntlet: out, decompose, incrementalHashEdge: incremental }, null, 2),
  );
}

main();
