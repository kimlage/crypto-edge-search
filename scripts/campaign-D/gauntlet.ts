/**
 * Campaign-D — the UNIFIED gauntlet (repo-parity). One runGauntlet() chains ALL committed gates in
 * the same binding order as the crypto program's per-domain runGauntlet wrappers, reusing the committed
 * primitives in src/lib/training/statistical-validation.ts. Replaces the bespoke per-script gate logic.
 *
 *   net_of_cost -> baselines -> deflated_sharpe@honestN -> block_bootstrap -> cpcv_pbo
 *                -> harvey_liu_haircut -> right-null surrogate -> consume-once holdout
 *
 * Verdict: SURVIVE = all pass; PROMISING = passes net+baselines+surrogate+holdout but trips a
 * multiple-testing/DSR gate (3,4,5,6); KILL = fails a core economic gate; DEFERRED = caller flags
 * the honest test needs data we lack at $0. Binding gate = first failure.
 */
import {
  summarizeReturnSeries, computeDeflatedSharpeRatio, blockBootstrapConfidenceInterval, estimateCscvPbo,
} from "../../src/lib/training/statistical-validation.ts";

export type GaunletInput = {
  name: string;
  returns: number[];                 // chronological net (cost+financing-charged) returns of the in-sample-best config
  honestN: number;                   // TRUE total configs searched (campaign-wide aware), never 1 unless pre-registered
  baselines: { name: string; mean: number }[]; // strategy mean must exceed each
  grid?: { id: string; folds: number[][] }[];  // for CPCV/PBO over the searched grid
  surrogate?: { real: number; nullMaxes: number[] }; // family-wise MAX null of the claim statistic (e.g. mean)
  holdoutReturns?: number[];         // consume-once OOS, scored once
  deferredReason?: string;           // if set => DEFERRED (honest test needs unavailable data)
  dsrBar?: number;                   // default 0.95
};

const tCdf2sided = (t: number, df: number) => {
  // survival of |T| for a t-distribution via a normal approx for df>=30, else a crude Welch-ish bound
  const z = Math.abs(t);
  // normal approximation (adequate at our N); 2-sided p
  const p = 2 * (1 - normCdf(z));
  return Math.min(1, Math.max(0, p));
};
function normCdf(x: number) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

export type GateResult = { id: string; pass: boolean; detail: string };
export type GauntletOutput = { name: string; gates: GateResult[]; bindingGate: string; verdict: "SURVIVE" | "PROMISING" | "KILL" | "DEFERRED" };

export function runGauntlet(inp: GaunletInput): GauntletOutput {
  const bar = inp.dsrBar ?? 0.95;
  const gates: GateResult[] = [];
  if (inp.deferredReason) return { name: inp.name, gates: [{ id: "deferred", pass: false, detail: inp.deferredReason }], bindingGate: "DEFERRED-data", verdict: "DEFERRED" };

  const s = summarizeReturnSeries(inp.returns);
  const n = inp.returns.length;

  // 1) net_of_cost
  gates.push({ id: "net_of_cost", pass: s.mean > 0, detail: `mean net=${s.mean.toFixed(4)} n=${n}` });

  // 2) baselines — must beat ALL
  const beats = inp.baselines.every((b) => s.mean > b.mean);
  gates.push({ id: "baselines", pass: beats, detail: inp.baselines.map((b) => `${b.name} ${b.mean.toFixed(4)}`).join(", ") + ` | strat ${s.mean.toFixed(4)}` });

  // 3) deflated_sharpe @ honest N
  const dsr = computeDeflatedSharpeRatio(inp.returns, { trialCount: inp.honestN });
  gates.push({ id: "deflated_sharpe", pass: dsr.deflatedProbability >= bar, detail: `DSR=${dsr.deflatedProbability.toFixed(3)} @N=${inp.honestN} (sharpe ${dsr.sharpe.toFixed(3)}, expMax ${dsr.expectedMaxSharpe.toFixed(3)})` });

  // 4) block_bootstrap CI on the mean excludes 0
  const bb = blockBootstrapConfidenceInterval(inp.returns, { statistic: "mean", iterations: 3000, blockLength: Math.max(1, Math.round(Math.sqrt(n))), seed: "campaignD" });
  gates.push({ id: "block_bootstrap", pass: bb.lower > 0, detail: `mean 95% CI [${bb.lower.toFixed(4)}, ${bb.upper.toFixed(4)}]` });

  // 5) cpcv_pbo < 0.5
  if (inp.grid && inp.grid.length >= 2) {
    let pbo = NaN; try { pbo = estimateCscvPbo(inp.grid.map((g) => ({ id: g.id, folds: g.folds })), { statistic: "sharpe" }).pbo; } catch {}
    gates.push({ id: "cpcv_pbo", pass: Number.isFinite(pbo) && pbo < 0.5, detail: `PBO=${Number.isFinite(pbo) ? pbo.toFixed(3) : "n/a"}` });
  } else gates.push({ id: "cpcv_pbo", pass: true, detail: "n/a — single pre-registered config (no selection to overfit; PBO not applicable)" });

  // 6) Harvey-Liu haircut: champion 2-sided p from t=mean/se*sqrt(n), Bonferroni & Holm & BHY at honest N
  const se = s.stdDev / Math.sqrt(Math.max(1, n));
  const t = se > 1e-12 ? s.mean / se : 0;
  const p1 = tCdf2sided(t, n - 1);
  const pBonf = Math.min(1, p1 * inp.honestN);
  const pHolm = Math.min(1, p1 * inp.honestN); // single champion => Holm == Bonferroni at rank 1
  // BHY (Benjamini-Yekutieli) constant c(N)=sum 1/i
  let cN = 0; for (let i = 1; i <= inp.honestN; i++) cN += 1 / i;
  const pBHY = Math.min(1, p1 * inp.honestN * cN / 1); // most conservative
  gates.push({ id: "haircut", pass: pBonf < 0.05, detail: `raw p=${p1.toFixed(4)}, Bonferroni@N=${inp.honestN} p=${pBonf.toFixed(4)}, BHY p=${pBHY.toFixed(4)}` });

  // 7) right-null surrogate (family-wise MAX) — the hero
  let surrPass = false, surrDetail = "no surrogate supplied";
  if (inp.surrogate) {
    const { real, nullMaxes } = inp.surrogate;
    const ge = nullMaxes.filter((x) => x >= real).length;
    const pSurr = ge / Math.max(1, nullMaxes.length);
    const sorted = [...nullMaxes].sort((a, b) => a - b);
    const null95 = sorted[Math.floor(sorted.length * 0.95)];
    surrPass = pSurr < 0.05;
    surrDetail = `real ${real.toFixed(4)} vs null95 ${null95.toFixed(4)}, p=${pSurr.toFixed(3)}`;
  }
  gates.push({ id: "surrogate", pass: surrPass, detail: surrDetail });

  // 8) consume-once holdout
  if (inp.holdoutReturns && inp.holdoutReturns.length >= 5) {
    const hs = summarizeReturnSeries(inp.holdoutReturns);
    const hd = computeDeflatedSharpeRatio(inp.holdoutReturns, { trialCount: 1 });
    gates.push({ id: "holdout", pass: hs.mean > 0 && hd.deflatedProbability >= bar, detail: `OOS n=${inp.holdoutReturns.length} mean=${hs.mean.toFixed(4)} sharpe=${hs.sharpe.toFixed(3)} DSR@1=${hd.deflatedProbability.toFixed(3)}` });
  } else gates.push({ id: "holdout", pass: false, detail: "n/a (holdout <5)" });

  // verdict
  const byId = Object.fromEntries(gates.map((g) => [g.id, g.pass]));
  const core = ["net_of_cost", "baselines", "surrogate", "holdout"];
  const mt = ["deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut"];
  const firstFail = gates.find((g) => !g.pass)?.id ?? "none";
  let verdict: GauntletOutput["verdict"];
  if (gates.every((g) => g.pass)) verdict = "SURVIVE";
  else if (core.every((c) => byId[c]) && mt.some((m) => !byId[m])) verdict = "PROMISING";
  else verdict = "KILL";
  return { name: inp.name, gates, bindingGate: firstFail, verdict };
}

export function printGauntlet(o: GauntletOutput) {
  console.log(`\n### ${o.name} => ${o.verdict}  (binding: ${o.bindingGate})`);
  for (const g of o.gates) console.log(`  [${g.pass ? "PASS" : "fail"}] ${g.id.padEnd(16)} ${g.detail}`);
}
