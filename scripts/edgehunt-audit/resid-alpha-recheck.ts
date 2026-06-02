/**
 * AUDIT: the "residual_alpha_sharpe" metric in m1-harden/m1-rescue/m3-neutral is computed
 * as sharpe(reg.resid) where resid = y - (alpha + beta*x). OLS residuals have mean EXACTLY 0,
 * so this Sharpe is ALWAYS ~0 by construction (a tautology). The correct beta-hedged alpha
 * Sharpe is sharpe(y - beta*x) [KEEP the intercept]. Demonstrate on a synthetic + show the
 * difference on M1's headline book reconstruction.
 */
import fs from "node:fs";
import path from "node:path";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };
const COINS = Object.keys(weekly.weeklyRet);
const W = weekly.weeks.length;
const FULL = COINS.filter((c) => weekly.weeklyRet[c].every((v) => v != null && isFinite(v as number)));
const ret = (c: string, i: number) => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : (v as number);
};
const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
function trail(c: string, i: number, look: number): number | null {
  if (i - look < 0) return null;
  let cum = 1;
  for (let k = i - look + 1; k <= i; k++) { const v = ret(c, k); if (v == null) return null; cum *= 1 + v; }
  return cum - 1;
}
const COST = 0.001;
function run(look: number, top: number, regimeGate: boolean): { port: number[]; btcRet: number[] } {
  const port: number[] = []; const btcRet: number[] = []; let prev: string[] = [];
  for (let i = look; i < W - 1; i++) {
    const btcMom = trail("BTC", i, look);
    const scored = FULL.map((c) => ({ c, m: trail(c, i, look) })).filter((x) => x.m != null) as { c: string; m: number }[];
    scored.sort((a, b) => b.m - a.m);
    const winners = scored.slice(0, top);
    const onReg = !regimeGate || (btcMom != null && btcMom > 0);
    const hold = onReg ? winners.filter((x) => x.m > 0).map((x) => x.c) : [];
    let w = 0, cnt = 0;
    for (const c of hold) { const v = ret(c, i + 1); if (v != null) { w += v; cnt++; } }
    let pr = cnt > 0 ? w / cnt : 0;
    const turn = prev.filter((c) => !hold.includes(c)).length + hold.filter((c) => !prev.includes(c)).length;
    pr -= (turn / Math.max(1, top)) * COST;
    port.push(pr); btcRet.push(ret("BTC", i + 1) ?? 0); prev = hold;
  }
  return { port, btcRet };
}
function regress(y: number[], x: number[]) {
  const n = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / n; const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) * (x[i] - mx); }
  const beta = vx > 0 ? cov / vx : 0; const alpha = my - beta * mx;
  const resid = y.map((v, i) => v - (alpha + beta * x[i]));   // mean EXACTLY 0
  const betaHedged = y.map((v, i) => v - beta * x[i]);        // KEEPS intercept (correct alpha series)
  // alpha t-stat
  let sse = 0; for (const r of resid) sse += r * r;
  const seResid = Math.sqrt(sse / (n - 2));
  const seAlpha = seResid * Math.sqrt(1 / n + (mx * mx) / vx);
  return { alpha, beta, resid, betaHedged, alpha_t: alpha / seAlpha };
}

// M1 headline = L4_T10_gated
const r = run(4, 10, true);
const reg = regress(r.port, r.btcRet);
const out = {
  config: "L4_T10_gated (M1 headline)",
  bookSharpeAnn: ann(sharpe(r.port)),
  beta: reg.beta,
  alpha_ann_pct: reg.alpha * 52 * 100,
  alpha_tstat: reg.alpha_t,
  BROKEN_residSharpe_meanZeroByConstruction: ann(sharpe(reg.resid)),
  CORRECT_betaHedgedSharpe_keepsIntercept: ann(sharpe(reg.betaHedged)),
  note: "BROKEN = sharpe(y-alpha-beta*x) is ~0 by OLS construction (mean exactly 0). CORRECT = sharpe(y-beta*x).",
};
console.log(JSON.stringify(out, null, 2));
