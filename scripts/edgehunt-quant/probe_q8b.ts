/**
 * Probe B: gate the STRONGER parent (long/flat TSMOM). For each lookback L, compare ungated
 * long/flat TSMOM vs ER-gated and ADX-gated. Also test combined ER-OR-ADX gate. Key question:
 * does ANY gated config beat its OWN ungated parent net of cost, in-sample?
 * Reports delta vs parent so we see if the gate adds timing or just trims exposure.
 */
import {
  loadDaily,
  efficiencyRatio,
  adx,
  tsmomSignal,
  runPositions,
  annSharpe,
  sharpeDaily,
} from "./lib_q8.ts";

const D = loadDaily();
const T = D.close.length;
const startIdx = 60;
const tradableEnd = T - 1;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.8);

function net(pos: number[]) {
  const r = runPositions(D, pos, startIdx, splitIdx);
  return { net: annSharpe(sharpeDaily(r.dailyNet)), exp: r.exposure };
}

const Ls = [10, 15, 20, 30, 40, 50, 90];
console.log("=== long/flat parent, then best ER / ADX gate over grid ===");
console.log("L  parentNet parentExp | bestER(net,exp,cfg) | bestADX(net,exp,cfg)");
for (const L of Ls) {
  const base = tsmomSignal(D.close, L, false);
  const p = net(base);
  // ER gate grid
  let bestER = { net: -9, exp: 0, cfg: "" };
  for (const w of [10, 14, 20, 30, 40]) {
    const er = efficiencyRatio(D.close, w);
    for (const thr of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
      const pos = base.map((s, t) => (Number.isFinite(er[t]) && er[t] >= thr ? s : 0));
      const r = net(pos);
      if (r.net > bestER.net) bestER = { net: r.net, exp: r.exp, cfg: `w=${w},thr=${thr}` };
    }
  }
  let bestADX = { net: -9, exp: 0, cfg: "" };
  for (const w of [10, 14, 20, 30]) {
    const a = adx(D.high, D.low, D.close, w);
    for (const thr of [15, 18, 20, 22, 25, 30]) {
      const pos = base.map((s, t) => (Number.isFinite(a[t]) && a[t] >= thr ? s : 0));
      const r = net(pos);
      if (r.net > bestADX.net) bestADX = { net: r.net, exp: r.exp, cfg: `w=${w},thr=${thr}` };
    }
  }
  console.log(
    `${L}  ${p.net.toFixed(3)} ${p.exp.toFixed(2)} | ER ${bestER.net.toFixed(3)} exp=${bestER.exp.toFixed(2)} [${bestER.cfg}] dlt=${(bestER.net - p.net).toFixed(3)} | ADX ${bestADX.net.toFixed(3)} exp=${bestADX.exp.toFixed(2)} [${bestADX.cfg}] dlt=${(bestADX.net - p.net).toFixed(3)}`,
  );
}

// Also: does the gate help if we REDEPLOY freed capital? i.e., gate only changes WHICH days we
// trade, not exposure. Compare gated vs an exposure-matched ungated (scale parent down to gate exp).
console.log("\n=== exposure-matched check (L=20 long/flat) ===");
const L = 20;
const base = tsmomSignal(D.close, L, false);
const p = net(base);
const er = efficiencyRatio(D.close, 20);
const thr = 0.3;
const gated = base.map((s, t) => (Number.isFinite(er[t]) && er[t] >= thr ? s : 0));
const g = net(gated);
// scaled parent to same avg exposure
const scale = g.exp / p.exp;
const scaledParent = base.map((s) => s * scale);
const sp = net(scaledParent);
console.log(
  `parent net=${p.net.toFixed(3)} exp=${p.exp.toFixed(2)} | gated net=${g.net.toFixed(3)} exp=${g.exp.toFixed(2)} | scaledParent(sameExp) net=${sp.net.toFixed(3)}`,
);
console.log("(if gated <= scaledParent and <= parent, the gate adds NO timing value)");
