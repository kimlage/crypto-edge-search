/**
 * Q5-TOD — Overnight vs intraday / time-of-day — FULL COMMITTED GAUNTLET.
 *
 * Strategy family: long (or short) a contiguous UTC-hour block each day, one entry / one exit
 * (cost = 2 sides * 4bps). Honest N = every (dir x h0 x len) config in the search = 576.
 *
 * Imports the committed primitives directly (strategy-validator.ts / significance/* do not exist
 * in this branch):
 *   computeDeflatedSharpeRatio, estimateCscvPbo, blockBootstrapConfidenceInterval, summarizeReturnSeries.
 *
 * Gates (binding order, mirrors scripts/edgehunt-D5/harness.ts):
 *   net_of_cost -> baselines -> matched_exposure_control -> deflated_sharpe -> block_bootstrap
 *   -> cpcv_pbo -> haircut -> calendar_reanchor (the RIGHT surrogate for a timing/calendar rule)
 *   -> hour_label_permute -> holdout (consume-once, last 20% forward).
 *
 * The RIGHT null for a SESSION/CALENDAR rule (per docs/BACKLOG.md D4-S8/D7.8):
 *   (1) CALENDAR-REANCHOR: slide the session boundary to a RANDOM hour anchor (same block length,
 *       same direction). If the real boundary isn't an outlier vs random anchors, it's a
 *       fixed-window mirage.
 *   (2) HOUR-LABEL PERMUTE: randomly permute the 24 hour labels, recompute the block. Destroys the
 *       hour->return mapping while preserving the marginal return distribution & intraday count.
 * The matched-exposure control (the documented timing trap): a random in/out long-beta book with
 *   the SAME daily in-market fraction must NOT match the session Sharpe.
 */
import fs from "node:fs";
import readline from "node:readline";
import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation.ts";

const ROOT = ".";
const FILE = `${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`;
const COST_PER_SIDE = 0.0004;
const ANN_D = Math.sqrt(365);

interface Bar { t: number; close: number; hourUTC: number; dayKey: string; dayIdx: number; }

async function loadBars(): Promise<Bar[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  const raw: { t: number; close: number; hourUTC: number; dayKey: string }[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const d = new Date(r.event_time);
    raw.push({ t: d.getTime(), close: Number(r.close), hourUTC: d.getUTCHours(), dayKey: r.event_time.slice(0, 10) });
  }
  raw.sort((a, b) => a.t - b.t);
  const dayKeys = [...new Set(raw.map((b) => b.dayKey))].sort();
  const dayIdxOf = new Map(dayKeys.map((k, i) => [k, i]));
  return raw.map((b) => ({ ...b, dayIdx: dayIdxOf.get(b.dayKey)! }));
}

function mean(a: number[]) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function std(a: number[]) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function sharpeAnn(a: number[]) { return std(a) > 0 ? (mean(a) / std(a)) * ANN_D : 0; }
function mkRng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function normalCdf(z: number) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x: number) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

async function main() {
  const bars = await loadBars();
  const T = bars.length;
  const fwd: number[] = new Array(T).fill(NaN);
  for (let i = 0; i < T - 1; i++) {
    if (bars[i + 1].t - bars[i].t === 15 * 60 * 1000 && bars[i].close > 0 && bars[i + 1].close > 0)
      fwd[i] = Math.log(bars[i + 1].close / bars[i].close);
  }

  let nDays = 0;
  for (const b of bars) if (b.dayIdx + 1 > nDays) nDays = b.dayIdx + 1;
  // Precompute, for each day, the per-hour summed fwd return (24 slots), and whether each hour had data.
  const dayHour: Float64Array = new Float64Array(nDays * 24);
  const dayHourHas: Uint8Array = new Uint8Array(nDays * 24);
  for (let i = 0; i < T - 1; i++) {
    if (!Number.isFinite(fwd[i])) continue;
    const idx = bars[i].dayIdx * 24 + bars[i].hourUTC;
    dayHour[idx] += fwd[i];
    dayHourHas[idx] = 1;
  }
  // full-day gross (B&H) per day
  const dayFull: number[] = new Array(nDays).fill(0);
  const dayFullHas: number[] = new Array(nDays).fill(0);
  for (let d = 0; d < nDays; d++) {
    let g = 0, has = 0;
    for (let h = 0; h < 24; h++) { const idx = d * 24 + h; if (dayHourHas[idx]) { g += dayHour[idx]; has = 1; } }
    dayFull[d] = g; dayFullHas[d] = has;
  }

  // Build daily NET return series for a block under a HOUR-LABEL MAP (identity by default).
  // hourMap[h] = which underlying hour's return feeds logical hour h (for label-permute null).
  function blockDailyNet(h0: number, len: number, dir: 1 | -1, hourMap?: Int32Array): number[] {
    const out: number[] = [];
    for (let d = 0; d < nDays; d++) {
      let g = 0, any = 0;
      for (let k = 0; k < len; k++) {
        const hLogical = (h0 + k) % 24;
        const hSrc = hourMap ? hourMap[hLogical] : hLogical;
        const idx = d * 24 + hSrc;
        if (dayHourHas[idx]) { g += dayHour[idx]; any = 1; }
      }
      if (any) out.push(dir * g - 2 * COST_PER_SIDE);
    }
    return out;
  }
  // exposure (fraction of the 24h day held) for a block of length len
  const blockExposure = (len: number) => len / 24;

  // ---- honest search universe (every config) ----
  const dirs: (1 | -1)[] = [1, -1];
  const configs: { dir: 1 | -1; h0: number; len: number }[] = [];
  for (const dir of dirs) for (let h0 = 0; h0 < 24; h0++) for (let len = 1; len <= 12; len++) configs.push({ dir, h0, len });
  const HONEST_N = configs.length;

  // train/holdout split by DAY index (consume-once forward holdout = last 20%)
  const splitDay = Math.floor(nDays * 0.8);
  // helper: restrict a per-day series to [0,splitDay) or [splitDay,nDays)
  function blockNetWindow(h0: number, len: number, dir: 1 | -1, lo: number, hi: number, hourMap?: Int32Array): number[] {
    const out: number[] = [];
    for (let d = lo; d < hi; d++) {
      let g = 0, any = 0;
      for (let k = 0; k < len; k++) { const hL = (h0 + k) % 24; const hS = hourMap ? hourMap[hL] : hL; const idx = d * 24 + hS; if (dayHourHas[idx]) { g += dayHour[idx]; any = 1; } }
      if (any) out.push(dir * g - 2 * COST_PER_SIDE);
    }
    return out;
  }

  // score every config IN-SAMPLE (train window) by net ann Sharpe
  const scoredClean = configs.map((c) => {
    const series = blockNetWindow(c.h0, c.len, c.dir, 0, splitDay);
    return { c, series, netSh: sharpeAnn(series) };
  });
  scoredClean.sort((a, b) => b.netSh - a.netSh);
  const best = scoredClean[0];
  const bestNet = best.series;
  const { dir: bDir, h0: bH0, len: bLen } = best.c;

  // ---- canonical pre-registered config (N=1): the literature "US session long", 13-22 UTC long ----
  const canon = { dir: 1 as 1, h0: 13, len: 9 };
  const canonSeries = blockNetWindow(canon.h0, canon.len, canon.dir, 0, splitDay);

  // ======================= GATES =======================
  const gates: Record<string, { pass: boolean; detail: string }> = {};

  // 1) net of cost
  gates.net_of_cost = { pass: mean(bestNet) > 0, detail: `netMeanDaily=${(mean(bestNet) * 1e4).toFixed(3)}bps nDays=${bestNet.length}` };

  // 2) baselines: B&H (full hold) + random-lottery 95th pct (matched exposure) + must be >0
  const bhTrain = [];
  for (let d = 0; d < splitDay; d++) if (dayFullHas[d]) bhTrain.push(dayFull[d]); // B&H ~ 0 cost (hold forever)
  const bhSh = sharpeAnn(bhTrain);
  const exposure = blockExposure(bLen);
  // random-lottery: random in/out LONG-BETA book matched to the session's in-market fraction & per-day round trip
  const rlSh: number[] = [];
  for (let i = 0; i < 400; i++) {
    const rng = mkRng(424242 + i * 2654435761);
    const series: number[] = [];
    for (let d = 0; d < splitDay; d++) {
      if (!dayFullHas[d]) continue;
      // hold a random `len`-hour contiguous block long, one round trip => same cost & exposure
      const rh0 = Math.floor(rng() * 24);
      let g = 0, any = 0;
      for (let k = 0; k < bLen; k++) { const idx = d * 24 + ((rh0 + k) % 24); if (dayHourHas[idx]) { g += dayHour[idx]; any = 1; } }
      if (any) series.push(g - 2 * COST_PER_SIDE);
    }
    rlSh.push(sharpeAnn(series));
  }
  rlSh.sort((a, b) => a - b);
  const rl95 = rlSh[Math.floor(rlSh.length * 0.95)];
  gates.baselines = {
    pass: best.netSh > bhSh && best.netSh > rl95 && best.netSh > 0,
    detail: `bestNetSh=${best.netSh.toFixed(3)} vs B&H=${bhSh.toFixed(3)} randomBlockLottery95=${rl95.toFixed(3)}`,
  };

  // 3) MATCHED-EXPOSURE CONTROL (the documented timing trap):
  //    a long-beta book in the market the SAME fraction of each day but at RANDOM hours must not
  //    match. We already have random-block above; the matched control here is the *mean* random
  //    block Sharpe vs best, plus a beta-scaled full-hold scaled to same exposure.
  const rlMean = mean(rlSh);
  // beta-matched: scale full-day B&H to the block's exposure (same expected market participation)
  const betaScaled = bhTrain.map((x) => x * exposure);
  const betaScaledSh = sharpeAnn(betaScaled); // scaling doesn't change Sharpe; this captures "just hold less"
  gates.matched_exposure_control = {
    pass: best.netSh > rlMean && best.netSh > betaScaledSh,
    detail: `bestNetSh=${best.netSh.toFixed(3)} vs randomBlockMean=${rlMean.toFixed(3)} betaScaledFullHold=${betaScaledSh.toFixed(3)} (exposure=${exposure.toFixed(3)})`,
  };

  // 4) Deflated Sharpe @ honest N (uses PER-BAR... here per-DAY net series)
  const dsr = computeDeflatedSharpeRatio(bestNet, { trialCount: HONEST_N });
  gates.deflated_sharpe = { pass: dsr.deflatedProbability > 0.95, detail: `DSR p=${dsr.deflatedProbability.toFixed(4)} @N=${HONEST_N} expMaxSh(daily)=${dsr.expectedMaxSharpe.toFixed(4)} sharpe(daily)=${dsr.sharpe.toFixed(4)}` };

  // 5) block bootstrap CI on mean daily net
  const bb = blockBootstrapConfidenceInterval(bestNet, { statistic: "mean", iterations: 2000, blockLength: 20, confidenceLevel: 0.95, seed: "q5tod-bb" });
  gates.block_bootstrap = { pass: bb.lower > 0, detail: `meanDailyNet CI95=[${(bb.lower * 1e4).toFixed(3)},${(bb.upper * 1e4).toFixed(3)}]bps` };

  // 6) CPCV / PBO across all configs (6 folds over the train window)
  const NFOLDS = 6;
  function toFolds(series: number[], n: number) { const f: number[][] = []; const sz = Math.floor(series.length / n); for (let k = 0; k < n; k++) { const lo = k * sz; const hi = k === n - 1 ? series.length : lo + sz; f.push(series.slice(lo, hi)); } return f; }
  const cscv = scoredClean.map((s) => ({ id: `${s.c.dir}_${s.c.h0}_${s.c.len}`, folds: toFolds(s.series, NFOLDS) }));
  let pboRes = { pbo: 1, medianLogit: 0 };
  try { const r = estimateCscvPbo(cscv, { statistic: "sharpe", trainFraction: 0.5 }); pboRes = { pbo: r.pbo, medianLogit: r.medianLogit }; } catch (e) { pboRes = { pbo: 1, medianLogit: 0 }; }
  gates.cpcv_pbo = { pass: pboRes.pbo < 0.5, detail: `PBO=${pboRes.pbo.toFixed(3)} medianLogit=${pboRes.medianLogit.toFixed(3)}` };

  // 7) Harvey-Liu (Bonferroni) haircut on PSR p-value
  const st = summarizeReturnSeries(bestNet);
  const seSh = Math.sqrt((1 - st.skewness * st.sharpe + ((st.kurtosis - 1) / 4) * st.sharpe * st.sharpe) / Math.max(1, st.sampleCount - 1));
  const zSh = seSh > 0 ? st.sharpe / seSh : 0;
  const psrP = 1 - normalCdf(zSh);
  const adjP = Math.min(1, psrP * HONEST_N);
  gates.haircut = { pass: adjP < 0.05, detail: `Bonferroni adjP=${adjP.toExponential(3)} (psrP=${psrP.toExponential(3)} *N=${HONEST_N})` };

  // 8) CALENDAR-REANCHOR null (the RIGHT surrogate): random hour anchor, same len & dir
  const N_SURR = 1000;
  const reanchor: number[] = [];
  for (let i = 0; i < N_SURR; i++) {
    const rng = mkRng(7000 + i * 7919);
    const rh0 = Math.floor(rng() * 24);
    const series = blockNetWindow(rh0, bLen, bDir, 0, splitDay);
    reanchor.push(sharpeAnn(series));
  }
  reanchor.sort((a, b) => a - b);
  const reanchorP = (reanchor.filter((s) => s >= best.netSh).length + 1) / (N_SURR + 1);
  gates.calendar_reanchor = { pass: reanchorP < 0.05, detail: `reanchorP=${reanchorP.toFixed(4)} real=${best.netSh.toFixed(3)} reanchorMean=${mean(reanchor).toFixed(3)} reanchor95=${reanchor[Math.floor(N_SURR * 0.95)].toFixed(3)}` };

  // 9) HOUR-LABEL PERMUTE null: permute the 24->24 hour map, recompute the SAME block window
  const permute: number[] = [];
  for (let i = 0; i < N_SURR; i++) {
    const rng = mkRng(99000 + i * 6271);
    const map = new Int32Array(24); for (let h = 0; h < 24; h++) map[h] = h;
    for (let h = 23; h > 0; h--) { const j = Math.floor(rng() * (h + 1)); const tmp = map[h]; map[h] = map[j]; map[j] = tmp; }
    const series = blockNetWindow(bH0, bLen, bDir, 0, splitDay, map);
    permute.push(sharpeAnn(series));
  }
  permute.sort((a, b) => a - b);
  const permuteP = (permute.filter((s) => s >= best.netSh).length + 1) / (N_SURR + 1);
  gates.hour_label_permute = { pass: permuteP < 0.05, detail: `permuteP=${permuteP.toFixed(4)} real=${best.netSh.toFixed(3)} permMean=${mean(permute).toFixed(3)}` };

  // 10) consume-once forward holdout (best cfg only, OOS last 20%)
  const holdSeries = blockNetWindow(bH0, bLen, bDir, splitDay, nDays);
  const holdSh = sharpeAnn(holdSeries);
  gates.holdout = { pass: holdSh > 0, detail: `OOS netSharpeAnn=${holdSh.toFixed(3)} over ${holdSeries.length} days meanBps=${(mean(holdSeries) * 1e4).toFixed(3)}` };

  // canonical diagnostics (N=1 pre-registered US-session)
  const canonSh = sharpeAnn(canonSeries);
  const canonReanchor: number[] = [];
  for (let i = 0; i < N_SURR; i++) { const rng = mkRng(31000 + i * 7919); const rh0 = Math.floor(rng() * 24); canonReanchor.push(sharpeAnn(blockNetWindow(rh0, canon.len, canon.dir, 0, splitDay))); }
  canonReanchor.sort((a, b) => a - b);
  const canonReanchorP = (canonReanchor.filter((s) => s >= canonSh).length + 1) / (N_SURR + 1);
  const canonHold = sharpeAnn(blockNetWindow(canon.h0, canon.len, canon.dir, splitDay, nDays));

  // ---- binding gate ----
  const order = ["net_of_cost", "baselines", "matched_exposure_control", "deflated_sharpe", "block_bootstrap", "cpcv_pbo", "haircut", "calendar_reanchor", "hour_label_permute", "holdout"];
  let binding = "none";
  for (const g of order) if (!gates[g].pass) { binding = g; break; }
  const allPass = binding === "none";
  const survivesCore = gates.net_of_cost.pass && gates.baselines.pass && gates.matched_exposure_control.pass && gates.calendar_reanchor.pass && gates.holdout.pass;
  let verdict: "SURVIVE" | "PROMISING" | "KILL";
  if (allPass) verdict = "SURVIVE"; else if (survivesCore) verdict = "PROMISING"; else verdict = "KILL";

  const monthlyAt100k = mean(bestNet) * 30 * 100000;

  // ---- report ----
  console.log("================= Q5-TOD GAUNTLET =================");
  console.log(`data: ${new Date(bars[0].t).toISOString()} .. ${new Date(bars.at(-1)!.t).toISOString()}  days=${nDays}`);
  console.log(`honest N = ${HONEST_N} (dir x h0 x len)`);
  console.log(`BEST in-sample: ${bDir === 1 ? "LONG" : "SHORT"} block h0=${bH0} len=${bLen}  netSh=${best.netSh.toFixed(3)} gross capture per day`);
  console.log(`exposure=${exposure.toFixed(3)}  meanNetBps/day=${(mean(bestNet) * 1e4).toFixed(3)}  monthly@$100k=$${monthlyAt100k.toFixed(0)}`);
  console.log(`canonical (US 13-22 long, N=1): inSampleSh=${canonSh.toFixed(3)} reanchorP=${canonReanchorP.toFixed(3)} holdoutSh=${canonHold.toFixed(3)}`);
  console.log("\n-- gates --");
  for (const g of order) console.log(`${gates[g].pass ? "PASS" : "FAIL"}  ${g.padEnd(26)} ${gates[g].detail}`);
  console.log(`\nbinding gate = ${binding}`);
  console.log(`VERDICT_INTERNAL = ${verdict}`);

  const out = { honestN: HONEST_N, best: { dir: bDir, h0: bH0, len: bLen, netSh: best.netSh, meanNetBps: mean(bestNet) * 1e4, exposure, monthlyAt100k }, bhSh, gates, binding, verdict, holdSh, reanchorP, permuteP, canon: { netSh: canonSh, reanchorP: canonReanchorP, holdSh: canonHold } };
  fs.writeFileSync(`${ROOT}/output/edgehunt-quant/q5tod-gauntlet.json`, JSON.stringify(out, null, 2));
  console.log(`\nwrote output/edgehunt-quant/q5tod-gauntlet.json`);
}
main();
