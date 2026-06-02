/**
 * Q7 robustness deep-dive: is the calm-gated-TSMOM edge a broad regime effect or a few lucky
 * configs? And does the gate add timing alpha OVER the matched-exposure control PER CONFIG (not just
 * for the single best)? Honest answer needs: (a) family-level distribution of gate-vs-matched-exp
 * delta, (b) holdout behavior of the whole family, (c) regime decomposition (is "calm" just lower
 * vol = mechanical Sharpe lift, or real conditional-return alpha?).
 */
import {
  loadDailyBTC,
  realizedVol,
  trailingPctRank,
  tsmomSignal,
  rsi,
  runPositions,
  annSharpe,
  sharpeDaily,
  mean,
  std,
  mkRng,
  type DailyBars,
} from "./q7_lib.ts";

const ANN = Math.sqrt(365);
const B = loadDailyBTC();
const T = B.close.length;
const START = 400;
const tradableEnd = T - 1;
const span = tradableEnd - START;
const splitIdx = START + Math.floor(span * 0.8);

type Cfg = { sig: "tsmom" | "rsi"; L: number; side: "long" | "ls"; volWin: number; rankWin: number; gate: "calm" | "storm" | "none"; thresh: number };

function rawPosition(B: DailyBars, c: Cfg): number[] {
  const T = B.close.length;
  const out = new Array(T).fill(NaN);
  if (c.sig === "tsmom") {
    const sig = tsmomSignal(B.close, c.L);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(sig[t])) continue;
      const s = Math.sign(sig[t]);
      out[t] = c.side === "long" ? (s > 0 ? 1 : 0) : s;
    }
  } else {
    const ind = rsi(B.close, c.L);
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(ind[t])) continue;
      const long = ind[t] < 30 ? 1 : 0;
      const short = ind[t] > 70 ? -1 : 0;
      out[t] = c.side === "long" ? long : long + short;
    }
  }
  return out;
}
function gateMask(B: DailyBars, c: Cfg): number[] {
  const T = B.close.length;
  if (c.gate === "none") return new Array(T).fill(1);
  const rv = realizedVol(B.ret, c.volWin);
  const rank = trailingPctRank(rv, c.rankWin);
  const out = new Array(T).fill(0);
  for (let t = 0; t < T; t++) {
    if (!Number.isFinite(rank[t])) continue;
    if (c.gate === "calm") out[t] = rank[t] <= c.thresh ? 1 : 0;
    else out[t] = rank[t] >= c.thresh ? 1 : 0;
  }
  return out;
}
function gated(B: DailyBars, c: Cfg): number[] {
  const raw = rawPosition(B, c);
  const mask = gateMask(B, c);
  return raw.map((p, t) => (Number.isFinite(p) ? p * mask[t] : NaN));
}

// matched-exposure control: ungated signal thinned to gated exposure, averaged over draws
function matchedExpSharpe(B: DailyBars, c: Cfg, lo: number, hi: number, targetExp: number): { mean: number; p95: number } {
  const base: Cfg = { ...c, gate: "none", thresh: 0 };
  const raw = rawPosition(B, base);
  let ung = 0, n = 0;
  for (let t = lo; t < hi; t++) if (Number.isFinite(raw[t])) { ung += Math.abs(raw[t]); n++; }
  const ungExp = n ? ung / n : 0;
  const keep = ungExp > 0 ? Math.min(1, targetExp / ungExp) : 0;
  const arr: number[] = [];
  for (let i = 0; i < 200; i++) {
    const rng = mkRng(555 + i * 7919);
    const pos = new Array(B.close.length).fill(NaN);
    for (let t = lo; t < hi; t++) {
      if (!Number.isFinite(raw[t])) continue;
      pos[t] = rng() < keep ? raw[t] : 0;
    }
    const r = runPositions(B, pos, lo, hi);
    arr.push(annSharpe(sharpeDaily(r.dailyNet)));
  }
  arr.sort((a, b) => a - b);
  return { mean: mean(arr), p95: arr[Math.floor(arr.length * 0.95)] };
}

// Build the calm-gated TSMOM family (all TSMOM configs with gate=calm)
const family: Cfg[] = [];
for (const L of [20, 50, 100])
  for (const side of ["long", "ls"] as const)
    for (const volWin of [10, 20, 40])
      for (const rankWin of [180, 365])
        for (const thresh of [0.3, 0.4, 0.5, 0.6, 0.7])
          family.push({ sig: "tsmom", L, side, volWin, rankWin, gate: "calm", thresh });

let nBeatME = 0, nPosHold = 0;
const deltas: number[] = [];
const holdShs: number[] = [];
const isShs: number[] = [];
for (const c of family) {
  const pos = gated(B, c);
  const isR = runPositions(B, pos, START, splitIdx);
  const isSh = annSharpe(sharpeDaily(isR.dailyNet));
  const me = matchedExpSharpe(B, c, START, splitIdx, isR.exposure);
  const delta = isSh - me.mean; // gate alpha over matched-exposure de-risking
  deltas.push(delta);
  isShs.push(isSh);
  if (isSh > me.p95) nBeatME++;
  const hold = runPositions(B, pos, splitIdx, tradableEnd);
  const holdSh = annSharpe(sharpeDaily(hold.dailyNet));
  holdShs.push(holdSh);
  if (holdSh > 0) nPosHold++;
}
console.log(`calm-gated TSMOM family: ${family.length} configs`);
console.log(`  IS netSharpe: mean=${mean(isShs).toFixed(3)} std=${std(isShs).toFixed(3)} max=${Math.max(...isShs).toFixed(3)} min=${Math.min(...isShs).toFixed(3)}`);
console.log(`  gate-vs-matchedExp delta: mean=${mean(deltas).toFixed(3)} std=${std(deltas).toFixed(3)} frac>0=${(deltas.filter(d=>d>0).length/deltas.length).toFixed(2)}`);
console.log(`  #configs beating matchedExp p95: ${nBeatME}/${family.length}`);
console.log(`  holdout netSharpe: mean=${mean(holdShs).toFixed(3)} frac>0=${(nPosHold/family.length).toFixed(2)} max=${Math.max(...holdShs).toFixed(3)} min=${Math.min(...holdShs).toFixed(3)}`);

// REGIME DECOMPOSITION: is the calm gate exploiting CONDITIONAL RETURN (alpha) or just lower vol?
// Compare mean fwdRet of the SAME long signal in calm vs storm regimes (unconditional on cost).
const rv = realizedVol(B.ret, 20);
const rank = trailingPctRank(rv, 365);
const sig = tsmomSignal(B.close, 50);
const calmRets: number[] = [], stormRets: number[] = [], calmVol: number[] = [], stormVol: number[] = [];
for (let t = START; t < tradableEnd; t++) {
  if (!Number.isFinite(rank[t]) || !Number.isFinite(sig[t]) || !Number.isFinite(B.fwdRet[t])) continue;
  if (Math.sign(sig[t]) <= 0) continue; // only long-signal days
  if (rank[t] <= 0.5) { calmRets.push(B.fwdRet[t]); calmVol.push(Math.abs(B.fwdRet[t])); }
  else { stormRets.push(B.fwdRet[t]); stormVol.push(Math.abs(B.fwdRet[t])); }
}
console.log(`\nregime decomposition (TSMOM50-long days):`);
console.log(`  CALM:  n=${calmRets.length} meanFwdRet=${(mean(calmRets)*365).toFixed(3)}/yr dailySharpe=${(mean(calmRets)/std(calmRets)).toFixed(4)} annSh=${(mean(calmRets)/std(calmRets)*ANN).toFixed(3)}`);
console.log(`  STORM: n=${stormRets.length} meanFwdRet=${(mean(stormRets)*365).toFixed(3)}/yr dailySharpe=${(mean(stormRets)/std(stormRets)).toFixed(4)} annSh=${(mean(stormRets)/std(stormRets)*ANN).toFixed(3)}`);
// Key question: is calm's edge driven by HIGHER mean return (alpha) or LOWER vol (mechanical)?
console.log(`  calm meanRet ${mean(calmRets) > mean(stormRets) ? ">" : "<="} storm meanRet ; calm vol ${std(calmRets) < std(stormRets) ? "<" : ">="} storm vol`);
