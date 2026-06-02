/**
 * Q6-DVOLTS exploration (NO gauntlet yet): understand the term-structure signal.
 *
 * The short-vol carry leg payoff over a holding period h is proxied (variance-swap analogue) as:
 *   sellVolRet[t] = k * (dvol[t]^2 - rvFwd_h[t]^2) / scale
 * i.e. you SELL a 30d variance swap at dvol^2 and it settles vs realized variance over the holding
 * period. Positive when implied>realized.
 *
 * Term-structure slope proxies (all causal, from the single 30d DVOL via VIX/VXV roll trick):
 *   backProxy = EMA(dvol, spanLong)  (longer-tenor anchor; smoother)
 *   slope = dvol / backProxy   (<1 = contango = front cheap vs back = "rich to sell" classic roll)
 *
 * We test: does CONTANGO (slope<1) predict higher forward short-vol payoff than BACKWARDATION,
 * beyond the unconditional premium? And does it beat the already-killed VRP-level signal (dvol-rv)?
 */
import fs from "node:fs";

const ROOT = ".";
const P = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-quant/dvolts_panel.json`, "utf8"));
const { dvol, rv, rvFwd7, dates } = P as {
  dvol: number[];
  rv: number[];
  rvFwd7: number[];
  dates: string[];
};
const T = dvol.length;

function ema(x: number[], span: number): number[] {
  const a = 2 / (span + 1);
  const out = new Array(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    prev = Number.isFinite(prev) ? a * x[i] + (1 - a) * prev : x[i];
    out[i] = prev;
  }
  return out;
}
function mean(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}
function corr(a: number[], b: number[]) {
  const n = a.length;
  const ma = mean(a),
    mb = mean(b);
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

// short-vol carry payoff over forward 7d, variance-swap analogue, in variance points/1e4 to scale
const sellVol = new Array(T).fill(NaN);
for (let t = 0; t < T; t++) {
  if (Number.isFinite(rvFwd7[t])) {
    sellVol[t] = (dvol[t] * dvol[t] - rvFwd7[t] * rvFwd7[t]) / 1e4;
  }
}

// term-structure proxies
for (const spanLong of [30, 45, 60, 90]) {
  const back = ema(dvol, spanLong);
  const slope: number[] = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) if (Number.isFinite(back[t]) && back[t] > 0) slope[t] = dvol[t] / back[t];

  // align valid rows (need slope and forward payoff; lag slope by 1 day for causality)
  const sv: number[] = [];
  const sl: number[] = [];
  const vrpLevel: number[] = [];
  for (let t = 1; t < T; t++) {
    if (Number.isFinite(slope[t - 1]) && Number.isFinite(sellVol[t]) && Number.isFinite(rv[t - 1])) {
      sv.push(sellVol[t]);
      sl.push(slope[t - 1]);
      vrpLevel.push(dvol[t - 1] - rv[t - 1]);
    }
  }
  // bucket forward short-vol payoff by contango vs backwardation
  const contango = sv.filter((_, i) => sl[i] < 1);
  const backwd = sv.filter((_, i) => sl[i] >= 1);
  const cBack = corr(sl, sv); // negative => more contango (low slope) -> higher payoff
  const cVrp = corr(vrpLevel, sv); // does VRP level predict?
  console.log(
    `spanLong=${spanLong}  n=${sv.length}  contango(n=${contango.length}) meanSV=${(
      mean(contango) * 1e4
    ).toFixed(1)}  backwd(n=${backwd.length}) meanSV=${(mean(backwd) * 1e4).toFixed(
      1,
    )}  corr(slope,fwdSV)=${cBack.toFixed(3)}  corr(VRPlevel,fwdSV)=${cVrp.toFixed(3)}`,
  );
}

// also: unconditional short-vol payoff and how often positive
const allSV = sellVol.filter(Number.isFinite);
const posFrac = allSV.filter((x) => x > 0).length / allSV.length;
console.log(
  `\nunconditional sellVol fwd7: meanSV=${(mean(allSV) * 1e4).toFixed(1)} (var-pts) posFrac=${posFrac.toFixed(
    3,
  )} n=${allSV.length}`,
);

// distribution of slope
const back60 = ema(dvol, 60);
const sl60 = dvol.map((d, t) => (Number.isFinite(back60[t]) && back60[t] > 0 ? d / back60[t] : NaN)).filter(Number.isFinite);
sl60.sort((a, b) => a - b);
console.log(
  `slope(span60) p10=${sl60[Math.floor(sl60.length * 0.1)].toFixed(3)} median=${sl60[
    Math.floor(sl60.length * 0.5)
  ].toFixed(3)} p90=${sl60[Math.floor(sl60.length * 0.9)].toFixed(3)} contangoFrac=${(
    sl60.filter((x) => x < 1).length / sl60.length
  ).toFixed(3)}`,
);
