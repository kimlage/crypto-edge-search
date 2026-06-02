/** D2-LT diagnostic scan: reversal edge vs threshold/horizon, net Sharpe + DSR. */
import { readFileSync } from "node:fs";
import { computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation.ts";
interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; tbb: number; n: number; }
const d = JSON.parse(readFileSync("output/edgehunt-D2/btc_15m_flow.json", "utf8")) as Bar[];
const flow = d.map((b) => 2 * b.tbb - b.v);
const absFlow = flow.map(Math.abs);
const rets: number[] = [];
for (let i = 0; i < d.length - 1; i += 1) rets.push(d[i + 1].c / d[i].c - 1);
const COST = 0.0004;
const PPY = 96 * 365;
function quantile(arr: number[], p: number) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; }
const rollW = 96;
const rollMeanAbs = new Array(flow.length).fill(0);
{ let acc = 0; for (let i = 0; i < flow.length; i += 1) { acc += absFlow[i]; if (i >= rollW) acc -= absFlow[i - rollW]; rollMeanAbs[i] = acc / Math.min(i + 1, rollW); } }
function evToPos(mask: boolean[], h: number, dir: number) {
  const pos = new Array(rets.length).fill(0); const cnt = new Array(rets.length).fill(0);
  for (let j = 0; j < flow.length; j += 1) { if (!mask[j]) continue; const want = dir * Math.sign(flow[j]); for (let k = 0; k < h; k += 1) { const i = j + k; if (i >= 0 && i < rets.length) { pos[i] += want; cnt[i] += 1; } } }
  for (let i = 0; i < rets.length; i += 1) if (cnt[i] > 0) pos[i] = Math.max(-1, Math.min(1, pos[i] / cnt[i]));
  return pos;
}
function net(pos: number[]) { let prev = 0; const out: number[] = []; for (let i = 0; i < rets.length; i += 1) { const dp = Math.abs(pos[i] - prev); out.push(pos[i] * rets[i] - dp * COST); prev = pos[i]; } return out; }
function annS(x: number[]) { const m = x.reduce((a, b) => a + b, 0) / x.length; const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / x.length); return sd > 1e-12 ? (m / sd) * Math.sqrt(PPY) : 0; }

const relLevels = [2, 2.5, 3, 4, 5, 6, 8, 10];
const pctLevels = [0.99, 0.995, 0.999];
const horizons = [1, 2, 3, 4, 6, 8];
const N = (relLevels.length + pctLevels.length) * horizons.length * 2; // full honest grid both dirs
console.log("honest-N for DSR ctx =", N);
console.log("det lvl h dir nEvents netSharpe DSRprob netMeanBp/bar perEventBp(net8) t");
function perEvent(mask: boolean[], h: number, dir: number) {
  const xs: number[] = [];
  for (let j = rollW; j < d.length - h; j += 1) { if (!mask[j]) continue; const f = d[j + h].c / d[j].c - 1; if (!Number.isFinite(f)) continue; xs.push(dir * Math.sign(flow[j]) * f - 2 * COST); }
  const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return { n: xs.length, m, t: sd > 0 ? m / (sd / Math.sqrt(xs.length)) : 0 };
}
for (const [det, levels] of [["rel", relLevels], ["pct", pctLevels]] as [string, number[]][]) {
  for (const lvl of levels) {
    const mask = det === "rel"
      ? absFlow.map((x, i) => i >= rollW && rollMeanAbs[i] > 0 && x / rollMeanAbs[i] >= lvl)
      : absFlow.map((x, i) => i >= rollW && x >= quantile(absFlow, lvl));
    const nev = mask.filter(Boolean).length;
    for (const h of horizons) {
      for (const dir of [-1]) { // reversal (the data-preferred sign)
        const pos = evToPos(mask, h, dir); const nn = net(pos);
        const sh = annS(nn);
        const dsr = computeDeflatedSharpeRatio(nn, { benchmarkSharpe: 0, trialCount: N });
        const mbp = (nn.reduce((a, b) => a + b, 0) / nn.length) * 1e4;
        const pe = perEvent(mask, h, dir);
        console.log(`${det} ${lvl} ${h} ${dir > 0 ? "mom" : "rev"} ${nev} ${sh.toFixed(3)} ${dsr.deflatedProbability.toFixed(3)} ${mbp.toFixed(4)} ${(pe.m * 1e4).toFixed(2)} ${pe.t.toFixed(2)}`);
      }
    }
  }
}
