/**
 * D2-VP diagnostic: scan the full config landscape on DEV to see whether the
 * volume-profile distance-to-POC / VA-edge carries ANY linear predictive sign
 * (reversion OR continuation), before committing to a single config. We report
 * gross & net Sharpe for every config and BOTH signal signs, plus the raw
 * correlation between (price-POC)/width at i-1 and next-bar return. This is the
 * honest "is there anything here" probe; no gates, no holdout consumed.
 */
import {
  load15m,
  backtestNet,
  type Bar,
} from "./lib.ts";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";

const PPY = 96 * 365;

interface Profile { poc: number; vah: number; val: number; binW: number }
function buildProfile(bars: Bar[], start: number, end: number, nBins: number, va: number): Profile | null {
  if (end < start) return null;
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i <= end; i += 1) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
  if (!(hi > lo)) return null;
  const binW = (hi - lo) / nBins;
  const hist = new Float64Array(nBins);
  for (let i = start; i <= end; i += 1) {
    const b = bars[i];
    const blo = Math.max(0, Math.floor((b.l - lo) / binW));
    const bhi = Math.min(nBins - 1, Math.floor((b.h - lo) / binW));
    const span = bhi - blo + 1; const vPer = b.v / span;
    for (let k = blo; k <= bhi; k += 1) hist[k] += vPer;
  }
  let pocBin = 0, pocV = -1;
  for (let k = 0; k < nBins; k += 1) if (hist[k] > pocV) { pocV = hist[k]; pocBin = k; }
  let total = 0; for (let k = 0; k < nBins; k += 1) total += hist[k];
  let loB = pocBin, hiB = pocBin, cum = hist[pocBin]; const target = va * total;
  while (cum < target && (loB > 0 || hiB < nBins - 1)) {
    const below = loB > 0 ? hist[loB - 1] : -1; const above = hiB < nBins - 1 ? hist[hiB + 1] : -1;
    if (above >= below) { hiB += 1; cum += hist[hiB]; } else { loB -= 1; cum += hist[loB]; }
  }
  const bc = (k: number) => lo + (k + 0.5) * binW;
  return { poc: bc(pocBin), vah: bc(hiB), val: bc(loB), binW };
}
function rets(c: number[]): number[] { const r: number[] = []; for (let i = 1; i < c.length; i += 1) r.push(c[i] / c[i - 1] - 1); return r; }
function sh(net: number[]): number { const s = summarizeReturnSeries(net); return s.stdDev > 1e-12 ? s.sharpe * Math.sqrt(PPY) : 0; }
function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0; for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i += 1) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

const all = load15m();
const cut = Math.floor(all.length * 0.7);
const dev = all.slice(0, cut);
const dRets = rets(dev.map((b) => b.c));
const step = 8;

console.log("config                          | grossSh(rev) netSh(rev) | grossSh(cont) | corr(d,next)");
for (const win of [96, 192, 384, 480]) {
  for (const nBins of [50, 80]) {
    const va = 0.7;
    // build distance-to-POC feature d[i] = (price_{i-1} - POC)/width (lagged)
    const dist = new Float64Array(dev.length).fill(0);
    let prof: Profile | null = null; let last = -1;
    for (let i = win; i < dev.length; i += 1) {
      if (prof === null || i - last >= step) { prof = buildProfile(dev, i - win, i - 1, nBins, va); last = i; }
      if (!prof) continue;
      const width = (prof.vah - prof.val) / 2 || prof.binW * nBins * 0.1;
      dist[i] = (dev[i - 1].c - prof.poc) / (width || 1);
    }
    // reversion position = -clamp(dist); continuation = +clamp(dist)
    const posRev = Array.from(dist, (d) => Math.max(-1, Math.min(1, -d)));
    const posCont = Array.from(dist, (d) => Math.max(-1, Math.min(1, d)));
    const btR = backtestNet(posRev.slice(0, dRets.length), dRets);
    const btC = backtestNet(posCont.slice(0, dRets.length), dRets);
    // raw predictive corr: dist[i] (known at i-1) vs next-bar return dRets[i]
    const dd: number[] = []; const rr: number[] = [];
    for (let i = win; i < dRets.length; i += 1) { dd.push(dist[i]); rr.push(dRets[i]); }
    const c = corr(dd, rr);
    console.log(
      `w${win}_b${nBins}`.padEnd(32) +
      `| ${sh(btR.gross).toFixed(2).padStart(6)} ${sh(btR.net).toFixed(2).padStart(6)}     | ${sh(btC.gross).toFixed(2).padStart(6)}       | ${c.toFixed(4)}`,
    );
  }
}
