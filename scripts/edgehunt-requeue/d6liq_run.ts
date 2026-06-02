/**
 * D6-LIQ runner. Build the strongest honest liquidity timer, run the committed gauntlet with the
 * RIGHT null (AR-matched surrogate + SPX/long-beta alpha control). Honest N = every config.
 *
 * Timer family (all strictly causal; signal derives ONLY from the lagged liquidity LEVEL passed in,
 * so the AR-matched surrogate can swap the level and re-derive the identical rule):
 *   - proxy in {netliq, m2}
 *   - rule in {roc-sign, roc-z}: long when liquidity momentum > thr, else {flat | short}
 *   - win in {21,63,126,252} days, thr, deRisk in {0 (flat), -1 (short)}
 */
import fs from "node:fs";
import { loadPanel, roc, rollingZ, runGauntlet, printVerdict } from "./d6liq_harness.ts";

const P = loadPanel();
const T = P.dates.length;

// first tradable idx: need the longest ROC window + z-window warmup available. Longest win=252,
// z-window=252 => warmup ~504. Use a fixed conservative startIdx so every config shares the window.
const WARMUP = 520;
const startIdx = WARMUP;

// position builder from a LEVEL series (netliq or m2). cfg keys: rule, win, thr, derisk.
function buildFromLevel(level: number[], cfg: Record<string, number | string>): number[] {
  const win = Number(cfg.win);
  const thr = Number(cfg.thr);
  const derisk = Number(cfg.derisk); // 0 = flat when contracting, -1 = short
  const rule = String(cfg.rule);
  let sig: number[];
  if (rule === "rocsign") {
    sig = roc(level, win); // long if sig > thr
  } else {
    // roc-z: z-score of the ROC over a 252d window (de-trends the secular drift -> the KEY control)
    const r = roc(level, win);
    sig = rollingZ(r, 252);
  }
  const pos = new Array(level.length).fill(NaN);
  for (let i = 0; i < level.length; i++) {
    if (!Number.isFinite(sig[i])) {
      pos[i] = 0;
      continue;
    }
    pos[i] = sig[i] > thr ? 1 : derisk;
  }
  return pos;
}

// --- config grid (honest N = every config tested across BOTH proxies) ---
function gridFor(): { netliq: Record<string, number | string>[]; m2: Record<string, number | string>[] } {
  const wins = [21, 63, 126, 252];
  const rules = ["rocsign", "rocz"];
  const derisks = [0, -1];
  const mk = () => {
    const cfgs: Record<string, number | string>[] = [];
    for (const rule of rules)
      for (const win of wins)
        for (const derisk of derisks) {
          const thrs = rule === "rocsign" ? [0] : [-0.5, 0, 0.5];
          for (const thr of thrs) cfgs.push({ rule, win, thr, derisk });
        }
    return cfgs;
  };
  return { netliq: mk(), m2: mk() };
}

const grid = gridFor();

// canonical pre-registered = the literal thesis: long when 252d net-liquidity ROC rising, else flat
const canonNetliq = { rule: "rocsign", win: 252, thr: 0, derisk: 0 };
const canonM2 = { rule: "rocsign", win: 252, thr: 0, derisk: 0 };

// HONEST N: count every config we evaluated across BOTH proxies (and both rules/derisk variants).
const HONEST_N = grid.netliq.length + grid.m2.length;

// Independent macro-cycle count (slow panel): over 2017-08..2026-05 net liquidity had ~3 major
// expansion/contraction regimes (2018-19 QT, 2020-21 QE, 2022-23 QT, 2024+ ease) => honestCycles ~3-4.
const HONEST_CYCLES = 4;

function run(proxy: "netliq" | "m2") {
  const source = proxy === "netliq" ? P.netliq : P.m2;
  const configs = grid[proxy];
  // inject HONEST_N into the DSR/haircut by padding the config list count: we pass the combined N
  // via a wrapper — but runGauntlet uses configs.length. To honour the COMBINED honest N we replicate
  // the count by tagging: simplest honest approach = run each proxy but report DSR at COMBINED N.
  const o = runGauntlet({
    name: `D6-LIQ-${proxy}`,
    P,
    source,
    buildPositionFromLevel: buildFromLevel,
    configs,
    canonical: proxy === "netliq" ? canonNetliq : canonM2,
    startIdx,
    holdoutFrac: 0.2,
    nSurr: 400,
    honestNCycles: HONEST_CYCLES,
    honestNOverride: HONEST_N, // count EVERY config across both proxies (honest multiple-testing)
  });
  return o;
}

const results = [run("netliq"), run("m2")];
for (const o of results) printVerdict(o);

// combined honest-N DSR re-check on the GLOBAL best (count every config across both proxies)
import { computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation.ts";
const globalBest = results.slice().sort((a, b) => b.best.netSharpeAnn - a.best.netSharpeAnn)[0];
console.log(`\n=== COMBINED honest-N audit (count every config across BOTH proxies) ===`);
console.log(`global best = ${globalBest.name} ${globalBest.best.label} netSh=${globalBest.best.netSharpeAnn.toFixed(3)}`);
console.log(`COMBINED honest N = ${HONEST_N} configs`);
console.log(`honest independent-cycle N ~ ${HONEST_CYCLES} (slow macro panel)`);

const out = {
  hypothesis: "D6-LIQ Global liquidity / net-liquidity (M2/WALCL) regime timer",
  dataRange: `${P.dates[0]}..${P.dates[T - 1]}`,
  combinedHonestN: HONEST_N,
  honestCycles: HONEST_CYCLES,
  cost_bps_per_side: 4,
  results: results.map((o) => ({
    name: o.name,
    verdict: o.verdict,
    bindingGate: o.bindingGate,
    bestNetSharpe: o.best.netSharpeAnn,
    grossSharpe: o.best.grossSharpeAnn,
    bhLongBetaSharpe: o.bhSharpe,
    surrogateP_AR: o.surrogateP,
    holdoutSharpe: o.holdoutSharpeAnn,
    betaControl: o.betaControl,
    monthlyAt100k: o.bindingGate === "none" ? o.best.monthlyAt100k : null,
    gates: Object.fromEntries(Object.entries(o.gates).map(([k, v]) => [k, { pass: v.pass, detail: v.detail }])),
    canonical: o.canonical,
    bestCfg: o.best.cfg,
  })),
};
fs.writeFileSync(
  "output/edgehunt-requeue/d6liq_results.json",
  JSON.stringify(out, null, 2),
);
console.log(`\nwrote output/edgehunt-requeue/d6liq_results.json`);
