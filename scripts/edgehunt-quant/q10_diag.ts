/**
 * Q10-CARRYMOM diagnostics: is there a ROBUST version, or is the IS-max a fluke?
 * - Pre-registered CANONICAL config (economically sensible, not IS-tuned): carryLb=14, momLb=30,
 *   skip=7, q=3, rank_avg. Evaluate IS and OOS, combo vs each leg, on the SAME split.
 * - IS vs OOS Sharpe for EVERY config (stability) + how often combo beats both legs OOS.
 * - Pooled full-sample combo vs legs (max power), with the cross-sectional-shuffle p on full sample.
 */
import fs from "node:fs";
const ROOT = ".";
const SYMS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX"];
const N = SYMS.length;
const COST = 0.0004;
const ANN_W = Math.sqrt(52);

function loadPanel() {
  const priceMaps: Map<string, number>[] = [];
  const fundMaps: Map<string, number>[] = [];
  for (const s of SYMS) {
    const p = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/${s}USDT_prices_daily.json`, "utf8"));
    const pm = new Map<string, number>();
    for (const r of p) pm.set(r.date, Number(r.perpClose));
    priceMaps.push(pm);
    const f = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/${s}USDT_funding_8h.json`, "utf8"));
    const fm = new Map<string, number>();
    for (const r of f) {
      const d = new Date(r.fundingTime).toISOString().slice(0, 10);
      fm.set(d, (fm.get(d) ?? 0) + Number(r.fundingRate));
    }
    fundMaps.push(fm);
  }
  let dates = [...priceMaps[0].keys()];
  for (let i = 1; i < N; i++) dates = dates.filter((d) => priceMaps[i].has(d));
  dates.sort();
  const price = SYMS.map(() => [] as number[]);
  const fundDaily = SYMS.map(() => [] as number[]);
  for (const d of dates)
    for (let i = 0; i < N; i++) {
      price[i].push(priceMaps[i].get(d)!);
      fundDaily[i].push(fundMaps[i].get(d) ?? 0);
    }
  return { dates, price, fundDaily };
}
type P = ReturnType<typeof loadPanel>;
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)));
};
const sh = (a: number[]) => (std(a) > 1e-12 ? (mean(a) / std(a)) * ANN_W : 0);
function ranks(x: number[]) {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const r = new Array(x.length);
  for (let k = 0; k < idx.length; k++) r[idx[k]] = k;
  return r;
}
function carry(P: P, t: number, lb: number) {
  return P.fundDaily.map((fd) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, t - lb + 1); k <= t; k++) { s += fd[k]; c++; }
    return c ? -(s / c) : 0;
  });
}
function mom(P: P, t: number, lb: number, skip: number) {
  return P.price.map((pr) => {
    const a = t - skip, b = t - skip - lb;
    return b < 0 ? 0 : Math.log(pr[a] / pr[b]);
  });
}
interface Cfg { carryLb: number; momLb: number; momSkip: number; q: number; combine: string; }
function book(P: P, cfg: Cfg, anchors: number[], override?: (t: number) => number[]) {
  const net: number[] = [];
  let prevW = new Array(N).fill(0);
  for (const t of anchors) {
    const nt = t + 7;
    if (nt >= P.dates.length) break;
    let score: number[];
    if (override) score = override(t);
    else if (cfg.combine === "carry_only") score = carry(P, t, cfg.carryLb);
    else if (cfg.combine === "mom_only") score = mom(P, t, cfg.momLb, cfg.momSkip);
    else if (cfg.combine === "rank_avg") {
      const c = ranks(carry(P, t, cfg.carryLb)), m = ranks(mom(P, t, cfg.momLb, cfg.momSkip));
      score = c.map((v, i) => v + m[i]);
    } else {
      const c = ranks(carry(P, t, cfg.carryLb)), m = ranks(mom(P, t, cfg.momLb, cfg.momSkip));
      score = c.map((v, i) => Math.min(v, m[i]) + 0.001 * (v + m[i]));
    }
    const ord = score.map((_, i) => i).sort((a, b) => score[a] - score[b]);
    const w = new Array(N).fill(0);
    for (const i of ord.slice(N - cfg.q)) w[i] = 1 / cfg.q;
    for (const i of ord.slice(0, cfg.q)) w[i] = -1 / cfg.q;
    let g = 0;
    for (let i = 0; i < N; i++) {
      const pr = Math.log(P.price[i][nt] / P.price[i][t]);
      let fr = 0;
      for (let k = t + 1; k <= nt; k++) fr += P.fundDaily[i][k];
      g += w[i] * pr - w[i] * fr;
    }
    let turn = 0;
    for (let i = 0; i < N; i++) turn += Math.abs(w[i] - prevW[i]);
    net.push(g - turn * COST);
    prevW = w;
  }
  return net;
}

const P = loadPanel();
const T = P.dates.length;
const warmup = 97;
const anchors: number[] = [];
for (let t = warmup; t + 7 < T; t += 7) anchors.push(t);
const split = Math.floor(anchors.length * 0.8);
const IS = anchors.slice(0, split), OOS = anchors.slice(split);

// ---- pre-registered canonical (robust, NOT IS-tuned) ----
for (const combine of ["rank_avg", "double_sort"]) {
  const canon: Cfg = { carryLb: 14, momLb: 30, momSkip: 7, q: 3, combine };
  const cIS = book(P, canon, IS), cOOS = book(P, canon, OOS), cFULL = book(P, canon, anchors);
  const carryIS = book(P, { ...canon, combine: "carry_only" }, IS);
  const carryOOS = book(P, { ...canon, combine: "carry_only" }, OOS);
  const carryFULL = book(P, { ...canon, combine: "carry_only" }, anchors);
  const momIS = book(P, { ...canon, combine: "mom_only" }, IS);
  const momOOS = book(P, { ...canon, combine: "mom_only" }, OOS);
  const momFULL = book(P, { ...canon, combine: "mom_only" }, anchors);
  console.log(`\n[canonical ${combine} cLb14 mLb30 sk7 q3]`);
  console.log(`  combo  IS=${sh(cIS).toFixed(2)}  OOS=${sh(cOOS).toFixed(2)}  FULL=${sh(cFULL).toFixed(2)}`);
  console.log(`  carry  IS=${sh(carryIS).toFixed(2)}  OOS=${sh(carryOOS).toFixed(2)}  FULL=${sh(carryFULL).toFixed(2)}`);
  console.log(`  mom    IS=${sh(momIS).toFixed(2)}  OOS=${sh(momOOS).toFixed(2)}  FULL=${sh(momFULL).toFixed(2)}`);
}

// ---- IS vs OOS for ALL configs; does combo beat both legs OOS, how often? ----
const carryLbs = [7, 14, 30], momLbs = [14, 30, 60, 90], skips = [0, 7], qs = [2, 3];
const combos = ["rank_avg", "double_sort"];
let nConfigs = 0, comboBeatsBothOOS = 0, comboPosOOS = 0;
const rows: { lbl: string; is: number; oos: number; cIs: number; cOos: number; mIs: number; mOos: number }[] = [];
for (const combine of combos)
  for (const carryLb of carryLbs)
    for (const momLb of momLbs)
      for (const momSkip of skips)
        for (const q of qs) {
          const cfg: Cfg = { carryLb, momLb, momSkip, q, combine };
          const cmbIS = sh(book(P, cfg, IS)), cmbOOS = sh(book(P, cfg, OOS));
          const cIS = sh(book(P, { ...cfg, combine: "carry_only" }, IS));
          const cOOS = sh(book(P, { ...cfg, combine: "carry_only" }, OOS));
          const mIS = sh(book(P, { ...cfg, combine: "mom_only" }, IS));
          const mOOS = sh(book(P, { ...cfg, combine: "mom_only" }, OOS));
          nConfigs++;
          if (cmbOOS > cOOS && cmbOOS > mOOS) comboBeatsBothOOS++;
          if (cmbOOS > 0) comboPosOOS++;
          rows.push({ lbl: `${combine}|c${carryLb}|m${momLb}|s${momSkip}|q${q}`, is: cmbIS, oos: cmbOOS, cIs: cIS, cOos: cOOS, mIs: mIS, mOos: mOOS });
        }
console.log(`\nAcross ${nConfigs} configs: combo OOS>0 in ${comboPosOOS}/${nConfigs}; combo beats BOTH legs OOS in ${comboBeatsBothOOS}/${nConfigs}`);
// IS-OOS rank correlation (Spearman-ish via Pearson on ranks)
const isR = ranks(rows.map((r) => r.is)), oosR = ranks(rows.map((r) => r.oos));
const corr = (() => {
  const mi = mean(isR), mo = mean(oosR);
  let cov = 0, vi = 0, vo = 0;
  for (let i = 0; i < isR.length; i++) { cov += (isR[i] - mi) * (oosR[i] - mo); vi += (isR[i] - mi) ** 2; vo += (oosR[i] - mo) ** 2; }
  return cov / Math.sqrt(vi * vo);
})();
console.log(`IS->OOS Sharpe rank-corr across configs = ${corr.toFixed(3)} (>0 => IS picks generalize; <=0 => overfit)`);
// mean combo OOS vs mean leg OOS (pooled effect)
console.log(`mean OOS: combo=${mean(rows.map((r) => r.oos)).toFixed(2)} carry=${mean(rows.map((r) => r.cOos)).toFixed(2)} mom=${mean(rows.map((r) => r.mOos)).toFixed(2)}`);
console.log(`mean IS : combo=${mean(rows.map((r) => r.is)).toFixed(2)} carry=${mean(rows.map((r) => r.cIs)).toFixed(2)} mom=${mean(rows.map((r) => r.mIs)).toFixed(2)}`);

// top-5 IS configs and their OOS
rows.sort((a, b) => b.is - a.is);
console.log(`\ntop-5 by IS -> their OOS:`);
for (const r of rows.slice(0, 5)) console.log(`  ${r.lbl}  IS=${r.is.toFixed(2)} OOS=${r.oos.toFixed(2)}`);

// ---- walk-forward: re-pick best combo config on expanding IS, trade next 13 weeks (no tail bias) ----
function bookCfgList() {
  const out: Cfg[] = [];
  for (const combine of combos)
    for (const carryLb of carryLbs) for (const momLb of momLbs) for (const momSkip of skips) for (const q of qs)
      out.push({ carryLb, momLb, momSkip, q, combine });
  return out;
}
const cfgList = bookCfgList();
const wfNet: number[] = [];
const wfCarryNet: number[] = [];
const step = 13; // ~quarterly re-selection
let start = 40; // need some IS to select
for (let s = start; s + step <= anchors.length; s += step) {
  const trainA = anchors.slice(0, s);
  const testA = anchors.slice(s, s + step);
  // pick best combo config on train
  let bestSh = -Infinity, bestCfg = cfgList[0];
  for (const cfg of cfgList) {
    const v = sh(book(P, cfg, trainA));
    if (v > bestSh) { bestSh = v; bestCfg = cfg; }
  }
  wfNet.push(...book(P, bestCfg, testA));
  // carry-only walk-forward: pick best carry config on train
  let bSh = -Infinity, bCfg = cfgList[0];
  for (const carryLb of carryLbs) for (const q of qs) {
    const cfg: Cfg = { carryLb, momLb: 30, momSkip: 7, q, combine: "carry_only" };
    const v = sh(book(P, cfg, trainA));
    if (v > bSh) { bSh = v; bCfg = cfg; }
  }
  wfCarryNet.push(...book(P, bCfg, testA));
}
console.log(`\nWALK-FORWARD (expanding train, re-select best, trade next ${step}w, ${wfNet.length} test weeks):`);
console.log(`  combo  WF netSharpeAnn=${sh(wfNet).toFixed(3)}  meanWk=${mean(wfNet).toExponential(2)}`);
console.log(`  carry  WF netSharpeAnn=${sh(wfCarryNet).toFixed(3)}  meanWk=${mean(wfCarryNet).toExponential(2)}`);
