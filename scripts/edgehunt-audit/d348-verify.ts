/**
 * INDEPENDENT audit verification for D348 concerns (built from scratch, reusing only data).
 *
 * Concern A: residual_alpha_sharpe = sharpe(OLS residuals) is tautologically ~0 (mean exactly 0).
 *   - Prove on the M1 headline book (L4_T10_gated) AND the M3 neutral book.
 *   - Report the CORRECT beta-hedged alpha Sharpe = sharpe(y - beta*x) [keeps intercept] + alpha t-stat.
 *
 * Concern B: M3 KILL over-attribution to inflated DSR@N=30.
 *   - Reproduce neutral book (resid, K=8, 10bps), Sharpe, beta, block-bootstrap mean-week CI.
 *   - DSR sensitivity across honest-N choices.
 *   - Liquidity-decay + survivorship are claimed to be the REAL support; we re-check the CI/beta facts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeDeflatedSharpeRatio,
  summarizeReturnSeries,
  blockBootstrapConfidenceInterval,
} from "../../src/lib/training/statistical-validation";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "output/edgehunt-audit");
fs.mkdirSync(OUT, { recursive: true });

const weekly = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/weekly-returns.json"), "utf8"),
) as { weeks: string[]; weeklyRet: Record<string, (number | null)[]> };
const daily = JSON.parse(
  fs.readFileSync(path.join(ROOT, "output/crossxs/daily-closes.json"), "utf8"),
) as { dates: string[]; closes: Record<string, (number | null)[]> };

const COINS = Object.keys(weekly.weeklyRet);
const W = weekly.weeks.length;
const FULL = COINS.filter((c) => weekly.weeklyRet[c].every((v) => v != null && isFinite(v as number)));
const ret = (c: string, i: number) => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : (v as number);
};
const ann = (s: number) => s * Math.sqrt(52);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const COST = 0.001;

function trail(c: string, i: number, look: number): number | null {
  if (i - look < 0) return null;
  let cum = 1;
  for (let k = i - look + 1; k <= i; k++) { const v = ret(c, k); if (v == null) return null; cum *= 1 + v; }
  return cum - 1;
}

// ---- M1 headline book L4_T10_gated (independent reconstruction) ----
function runM1(look: number, top: number, regimeGate: boolean): { port: number[]; btcRet: number[] } {
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
  const resid = y.map((v, i) => v - (alpha + beta * x[i]));   // OLS resid: mean EXACTLY 0
  const betaHedged = y.map((v, i) => v - beta * x[i]);        // correct alpha series: keeps intercept
  let sse = 0; for (const r of resid) sse += r * r;
  const seResid = Math.sqrt(sse / (n - 2));
  const seAlpha = seResid * Math.sqrt(1 / n + (mx * mx) / vx);
  return { alpha, beta, resid, betaHedged, alpha_t: alpha / seAlpha, residMean: resid.reduce((a, b) => a + b, 0) / n };
}

const m1 = runM1(4, 10, true);
const rm1 = regress(m1.port, m1.btcRet);
const m1out = {
  config: "L4_T10_gated",
  bookSharpeAnn: ann(sharpe(m1.port)),
  beta: rm1.beta,
  alpha_ann_pct: rm1.alpha * 52 * 100,
  alpha_tstat: rm1.alpha_t,
  BROKEN_residSharpe_ann: ann(sharpe(rm1.resid)),
  BROKEN_residMean: rm1.residMean,
  CORRECT_betaHedgedSharpe_ann: ann(sharpe(rm1.betaHedged)),
};

// ---- M3 neutral book (independent reconstruction): resid-of-momentum, K=8, 10bps ----
const DATES = daily.dates;
const WEEKS = weekly.weeks;
const WINDOW = 364;
const wret = (c: string, i: number): number | null => {
  const v = weekly.weeklyRet[c]?.[i];
  return v == null || !isFinite(v) ? null : (v as number);
};
const dateIdx = new Map(DATES.map((d, i) => [d, i]));
const WK2DI = WEEKS.map((w) => (dateIdx.has(w) ? dateIdx.get(w)! : -1));

function nearnessAt(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di];
  if (cur == null || !(cur > 0)) return null;
  let hi = -Infinity, valid = 0;
  const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) { const v = close[k]; if (v != null && v > 0) { valid++; if (v > hi) hi = v; } }
  if (valid < WINDOW || hi <= 0) return null;
  return cur / hi;
}
function mom52At(close: (number | null)[], di: number): number | null {
  if (di < 0) return null;
  const cur = close[di];
  const past = close[di - WINDOW + 1];
  if (cur == null || !(cur > 0) || past == null || !(past > 0)) return null;
  let valid = 0;
  const start = Math.max(0, di - WINDOW + 1);
  for (let k = start; k <= di; k++) { const v = close[k]; if (v != null && v > 0) valid++; }
  if (valid < WINDOW) return null;
  return cur / past - 1;
}
function residualizeXS(y: number[], x: number[]): number[] {
  const n = y.length;
  if (n < 3) return y.map(() => 0);
  const mx = x.reduce((a, b) => a + b, 0) / n; const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) * (x[i] - mx); }
  const b = vx > 1e-12 ? cov / vx : 0; const a = my - b * mx;
  return y.map((v, i) => v - (a + b * x[i]));
}
function buildScores(di: number) {
  const out: { c: string; near: number; mom: number }[] = [];
  for (const c of COINS) {
    const cl = daily.closes[c];
    const near = nearnessAt(cl, di); const mom = mom52At(cl, di);
    if (near != null && mom != null) out.push({ c, near, mom });
  }
  return out;
}
function runNeutral(resid: boolean, topK: number, cost: number): number[] {
  const port: number[] = []; let prevL: string[] = [], prevS: string[] = [];
  for (let i = 1; i < W - 1; i++) {
    const di = WK2DI[i];
    if (di < 0) { continue; }
    const allScored = buildScores(di);
    if (allScored.length < 2 * topK + 1) { port.push(0); prevL = []; prevS = []; continue; }
    const vals = resid
      ? residualizeXS(allScored.map((s) => s.near), allScored.map((s) => s.mom))
      : allScored.map((s) => s.near);
    const ranked = allScored.map((s, idx) => ({ c: s.c, v: vals[idx] })).sort((a, b) => b.v - a.v);
    const longs = ranked.slice(0, topK).map((x) => x.c);
    const shorts = ranked.slice(-topK).map((x) => x.c);
    let pr = 0;
    for (const c of longs) { const v = wret(c, i + 1); if (v != null) pr += v; }
    for (const c of shorts) { const v = wret(c, i + 1); if (v != null) pr -= v; }
    pr /= topK;
    const turn = prevL.filter((c) => !longs.includes(c)).length + longs.filter((c) => !prevL.includes(c)).length
      + prevS.filter((c) => !shorts.includes(c)).length + shorts.filter((c) => !prevS.includes(c)).length;
    pr -= (turn / Math.max(1, 2 * topK)) * cost;
    port.push(pr);
    prevL = longs; prevS = shorts;
  }
  return port;
}

// neutral book needs a BTC weekly series aligned to its weeks for beta
const m3port = runNeutral(true, 8, 0.001);
// build aligned BTC weekly returns for the same i range (i from 1..W-2, pushing ret(i+1))
const m3btc: number[] = [];
{
  for (let i = 1; i < W - 1; i++) {
    const di = WK2DI[i];
    const allScored = di < 0 ? [] : buildScores(di);
    if (di < 0) continue; // matches runNeutral 'continue' (no push)
    // runNeutral pushes 0 when too few names; still pushes -> include btc
    m3btc.push(ret("BTC", i + 1) ?? 0);
  }
}
const rm3 = regress(m3port, m3btc.slice(0, m3port.length));
const bb = blockBootstrapConfidenceInterval(m3port, { statistic: "mean", iterations: 2000, blockLength: 7, seed: "d348-audit" });
const m3out: any = {
  config: "residNeutral_K8_10bps",
  nWeeks: m3port.length,
  neutralSharpeAnn: ann(sharpe(m3port)),
  beta: rm3.beta,
  alpha_ann_pct: rm3.alpha * 52 * 100,
  alpha_tstat: rm3.alpha_t,
  BROKEN_residSharpe_ann: ann(sharpe(rm3.resid)),
  BROKEN_residMean: rm3.residMean,
  CORRECT_betaHedgedSharpe_ann: ann(sharpe(rm3.betaHedged)),
  meanWk_CI95: [bb.lower, bb.estimate, bb.upper],
  ciExcludesZero: bb.lower > 0 || bb.upper < 0,
};
for (const N of [1, 6, 12, 30, 60]) {
  const d = computeDeflatedSharpeRatio(m3port, { trialCount: N });
  m3out[`dsr_p_N${N}`] = d.deflatedProbability;
}

const result = { CONCERN_A_brokenMetric: { M1: m1out, M3: m3out }, CONCERN_B_m3_dsr: m3out };
fs.writeFileSync(path.join(OUT, "d348-verify.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
