import { loadPanel, roc, mean, std } from "./d6liq_harness.ts";

const P = loadPanel();
const T = P.dates.length;
// coverage
const finNL = P.netliq.filter((x) => Number.isFinite(x)).length;
const finM2 = P.m2.filter((x) => Number.isFinite(x)).length;
const finSPX = P.spxRet.filter((x) => Number.isFinite(x)).length;
console.log(`T=${T} dates ${P.dates[0]}..${P.dates[T - 1]}`);
console.log(`coverage: netliq=${finNL} m2=${finM2} spxFwd=${finSPX}`);

// find first idx where netliq + 252d ROC available
function corr(a: number[], b: number[]): number {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  const mx = mean(xs), my = mean(ys), sx = std(xs), sy = std(ys);
  let c = 0; for (let i = 0; i < xs.length; i++) c += (xs[i] - mx) * (ys[i] - my);
  return c / ((xs.length - 1) * sx * sy);
}

// correlation of lagged liquidity ROC with NEXT-day BTC fwdRet (the tradable claim)
for (const win of [21, 63, 126, 252]) {
  const r = roc(P.netliq, win);
  console.log(`netliq ROC${win}: corr(signal, fwdRet)=${corr(r, P.fwdRet).toFixed(4)}  frac>0=${(r.filter(x=>x>0).length/r.filter(x=>Number.isFinite(x)).length).toFixed(3)}`);
}
for (const win of [21, 63, 126, 252]) {
  const r = roc(P.m2, win);
  console.log(`m2     ROC${win}: corr(signal, fwdRet)=${corr(r, P.fwdRet).toFixed(4)}  frac>0=${(r.filter(x=>x>0).length/r.filter(x=>Number.isFinite(x)).length).toFixed(3)}`);
}

// directional hit-rate of sign(ROC) -> sign(fwdRet) for net-liq 63d
function hitrate(sig: number[]): { hit: number; n: number; longRet: number; flatBeats: number } {
  let hit = 0, n = 0, longRet = 0, allRet = 0, longN = 0;
  for (let i = 0; i < T; i++) {
    if (!Number.isFinite(sig[i]) || !Number.isFinite(P.fwdRet[i])) continue;
    n++; allRet += P.fwdRet[i];
    const pos = sig[i] > 0 ? 1 : 0;
    if (Math.sign(P.fwdRet[i]) === Math.sign(sig[i] > 0 ? 1 : -1)) hit++;
    if (pos === 1) { longRet += P.fwdRet[i]; longN++; }
  }
  return { hit: hit / n, n, longRet: longRet / Math.max(1, longN), flatBeats: allRet / n };
}
const r63 = roc(P.netliq, 63);
const hr = hitrate(r63);
console.log(`netliq ROC63 sign: hitrate=${hr.hit.toFixed(3)} n=${hr.n} meanRet|long=${hr.longRet.toExponential(2)} meanRet|all=${hr.flatBeats.toExponential(2)}`);

// how many DISTINCT regime crossings (sign flips) of net-liq 63d ROC? = honest macro-cycle count
let flips = 0; let prev = NaN;
for (let i = 0; i < T; i++) { const s = r63[i]; if (!Number.isFinite(s)) continue; const sg = s > 0 ? 1 : -1; if (Number.isFinite(prev) && sg !== prev) flips++; prev = sg; }
console.log(`netliq ROC63 sign-flips (regime crossings) over sample = ${flips}  => honest independent-cycle N ~ ${Math.ceil(flips / 2)}`);
