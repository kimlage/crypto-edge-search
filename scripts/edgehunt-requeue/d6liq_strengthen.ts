/**
 * D6-LIQ strengthening probe. The base gauntlet KILLed on the SPX+long-beta alpha gate (residual
 * alpha ~0 after stripping BTC-long). But orthogonalizing a long/flat TIMER vs contemporaneous
 * BTC-long return is conservative-to-a-fault (a correct timer is positively correlated with up-days
 * by construction). Here we run the FAIRER liquidity-specific tests the BACKLOG actually names:
 *
 *   (A) SPX-ONLY beta control: strip coincident SPX (the macro control), keep BTC directional.
 *       Does the timer beat its OWN long-beta after removing SPX? (alpha vs the coincident control)
 *   (B) EXPOSURE-MATCHED B&H: compare the timer to a buy&hold scaled to the SAME average exposure
 *       (so we are NOT just rewarding lower risk). Must beat exposure-matched B&H net Sharpe.
 *   (C) DE-RISK-ONLY decomposition: does liquidity timing add return, or only reduce drawdown?
 *       Split PnL into (long-beta component) + (timing overlay) and Sharpe-test the overlay alone.
 *   (D) Best NON-canonical net-liq + M2 across the grid, reported with exposure-matched comparison.
 */
import { loadPanel, roc, rollingZ, runPositions, betaResidual, mean, std, annSharpe, sharpeDaily, mkRng } from "./d6liq_harness.ts";

const P = loadPanel();
const T = P.dates.length;
const startIdx = 520;
const tradableEnd = T - 1;

function buildFromLevel(level: number[], cfg: any): number[] {
  const win = Number(cfg.win), thr = Number(cfg.thr), derisk = Number(cfg.derisk), rule = String(cfg.rule);
  let sig: number[];
  if (rule === "rocsign") sig = roc(level, win);
  else sig = rollingZ(roc(level, win), 252);
  const pos = new Array(level.length).fill(NaN);
  for (let i = 0; i < level.length; i++) pos[i] = !Number.isFinite(sig[i]) ? 0 : sig[i] > thr ? 1 : derisk;
  return pos;
}

// exposure-matched buy&hold: scale long position to match the timer's avg exposure, same window.
function exposureMatchedBH(exposure: number): number[] {
  return new Array(T).fill(exposure);
}

function evalCfg(level: number[], cfg: any, label: string) {
  const pos = buildFromLevel(level, cfg);
  const res = runPositions(P, pos, startIdx, tradableEnd);
  const netSh = annSharpe(sharpeDaily(res.dailyNet));
  // exposure-matched B&H over the same traded days
  const emPos = exposureMatchedBH(res.exposure);
  const emRes = runPositions(P, emPos, startIdx, tradableEnd);
  const emSh = annSharpe(sharpeDaily(emRes.dailyNet));
  // (A) SPX-only residual (strip coincident SPX, keep BTC directional)
  const spxOnly = betaResidualSpxOnly(res.dailyNet, res.spxSeries);
  // (B) full SPX+BTC residual (the strict alpha)
  const full = betaResidual(res.dailyNet, res.spxSeries, res.retSeries);
  // (C) timing-overlay decomposition: overlay PnL = timerPnL - exposure*B&H_perDay (the part beyond
  //     holding the same average exposure passively). Sharpe of the overlay alone.
  const overlay: number[] = [];
  for (let i = 0; i < res.dailyNet.length; i++) overlay.push(res.dailyNet[i] - res.exposure * res.retSeries[i]);
  const overlaySh = annSharpe(sharpeDaily(overlay));
  console.log(
    `${label.padEnd(46)} netSh=${netSh.toFixed(3)} exp=${res.exposure.toFixed(2)} | exposureMatchedBH=${emSh.toFixed(3)} beatEM=${netSh > emSh ? "Y" : "n"} | spxOnlyResidSh=${spxOnly.residSharpeAnn.toFixed(3)} | strictAlphaSh=${full.residSharpeAnn.toFixed(3)} betaBTC=${full.betaBtc.toFixed(2)} | timingOverlaySh=${overlaySh.toFixed(3)}`,
  );
  return { netSh, emSh, beatEM: netSh > emSh, spxOnly: spxOnly.residSharpeAnn, strictAlpha: full.residSharpeAnn, overlaySh };
}

function betaResidualSpxOnly(pnl: number[], spx: number[]) {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < pnl.length; i++) if (Number.isFinite(pnl[i]) && Number.isFinite(spx[i])) { xs.push(spx[i]); ys.push(pnl[i]); }
  const n = ys.length;
  if (n < 30) return { residSharpeAnn: annSharpe(sharpeDaily(pnl)), beta: NaN, alpha: mean(pnl) };
  const mx = mean(xs), my = mean(ys);
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; }
  const beta = vx > 0 ? cov / vx : 0;
  const alpha = my - beta * mx;
  const resid = ys.map((y, i) => y - (alpha + beta * xs[i]));
  return { residSharpeAnn: annSharpe(sharpeDaily(resid)), beta, alpha };
}

console.log("=== D6-LIQ strengthening: fairer liquidity-specific alpha tests (FULL sample) ===\n");
console.log("NETLIQ:");
const nlGrid = [
  { rule: "rocsign", win: 21, thr: 0, derisk: 0 },
  { rule: "rocsign", win: 63, thr: 0, derisk: 0 },
  { rule: "rocsign", win: 252, thr: 0, derisk: 0 },
  { rule: "rocz", win: 63, thr: 0, derisk: 0 },
  { rule: "rocz", win: 252, thr: 0, derisk: 0 },
  { rule: "rocsign", win: 63, thr: 0, derisk: -1 },
];
for (const c of nlGrid) evalCfg(P.netliq, c, `netliq ${c.rule} w${c.win} thr${c.thr} dr${c.derisk}`);
console.log("\nM2:");
for (const c of nlGrid) evalCfg(P.m2, c, `m2 ${c.rule} w${c.win} thr${c.thr} dr${c.derisk}`);

// baseline references
const bh = runPositions(P, new Array(T).fill(1), startIdx, tradableEnd);
console.log(`\nreference: full-sample B&H netSh=${annSharpe(sharpeDaily(bh.dailyNet)).toFixed(3)} (long-beta control)`);
