/**
 * D2-VP robustness at DAILY cadence. The 15m test rebuilds a volume profile and
 * trades the distance-to-POC / VA-edge at 15m resolution. Classic Market Profile
 * is a *daily*-decision idea (yesterday's profile -> today's POC magnet). Here we
 * aggregate the 84,760 15m bars into daily bars (preserving each day's H/L range
 * and total volume), build a ROLLING multi-day volume profile from the prior N
 * days' 15m volume, and trade the distance-to-POC once per day (h>=1: profile
 * ends at yesterday's close; position held over today's return). Cost 4bps/side.
 *
 * This is the lower-turnover, mechanism-native cadence — the most generous setting
 * for the hypothesis. If it still doesn't clear net-of-cost vs the phase-rand null,
 * the KILL is cadence-robust.
 */
import { load15m, backtestNet, runGauntlet, rng, printResult, type Bar } from "./lib.ts";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation.ts";

const PPY = 365;
const SUR = 400;

interface Profile { poc: number; vah: number; val: number; binW: number }
function buildProfile(bars: Bar[], start: number, end: number, nBins: number, va: number): Profile | null {
  if (end < start) return null;
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i <= end; i += 1) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
  if (!(hi > lo)) return null;
  const binW = (hi - lo) / nBins; const hist = new Float64Array(nBins);
  for (let i = start; i <= end; i += 1) {
    const b = bars[i];
    const blo = Math.max(0, Math.floor((b.l - lo) / binW));
    const bhi = Math.min(nBins - 1, Math.floor((b.h - lo) / binW));
    const span = bhi - blo + 1; const vPer = b.v / span;
    for (let k = blo; k <= bhi; k += 1) hist[k] += vPer;
  }
  let pocBin = 0, pocV = -1; for (let k = 0; k < nBins; k += 1) if (hist[k] > pocV) { pocV = hist[k]; pocBin = k; }
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
function shp(net: number[]): number { const s = summarizeReturnSeries(net); return s.stdDev > 1e-12 ? s.sharpe * Math.sqrt(PPY) : 0; }

// aggregate 15m -> daily
function toDaily(b15: Bar[]): Bar[] {
  const days = new Map<string, Bar>();
  const order: string[] = [];
  for (const b of b15) {
    const key = new Date(b.t).toISOString().slice(0, 10);
    let d = days.get(key);
    if (!d) { d = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, tbb: 0, n: 0 }; days.set(key, d); order.push(key); }
    d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; d.v += b.v; d.tbb += b.tbb; d.n += b.n;
  }
  return order.map((k) => days.get(k)!);
}

// build a rolling multi-day profile from the underlying 15m bars in [day-win, day-1]
function vpDailyPositions(daily: Bar[], dayIdx: number[][], all15: Bar[], win: number, nBins: number, va: number, kind: "poc" | "va", dir: "rev" | "cont", band: number, deadband: number): number[] {
  const n = daily.length; const pos = new Float64Array(n).fill(0);
  for (let d = win; d < n; d += 1) {
    // 15m bars covering the prior `win` days (strictly before day d)
    const lo15 = dayIdx[d - win][0];
    const hi15 = dayIdx[d - 1][dayIdx[d - 1].length - 1];
    const prof = buildProfile(all15, lo15, hi15, nBins, va);
    if (!prof) continue;
    const p = daily[d - 1].c; // yesterday's close (known)
    const width = (prof.vah - prof.val) / 2 || prof.binW * nBins * 0.1;
    const sgn = dir === "rev" ? -1 : 1; let raw = 0;
    if (kind === "poc") { raw = sgn * -((p - prof.poc) / (band * width || 1)); }
    else {
      if (p > prof.vah) raw = sgn * -((p - prof.vah) / (band * width || 1));
      else if (p < prof.val) raw = sgn * ((prof.val - p) / (band * width || 1));
    }
    let q = Math.max(-1, Math.min(1, raw)); if (Math.abs(q) < deadband) q = 0; pos[d] = q;
  }
  return Array.from(pos);
}

const all = load15m();
const daily = toDaily(all);
// map each daily index -> list of 15m indices
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const keyToDay = new Map(daily.map((d, i) => [dayKey(d.t), i]));
const dayIdx: number[][] = daily.map(() => []);
all.forEach((b, i) => { const di = keyToDay.get(dayKey(b.t)); if (di !== undefined) dayIdx[di].push(i); });

const cut = Math.floor(daily.length * 0.7);
const dev = daily.slice(0, cut); const hold = daily.slice(cut);
const dRets = rets(dev.map((b) => b.c)); const hRets = rets(hold.map((b) => b.c));
console.log(`[D2-VP-daily] daily bars=${daily.length} dev=${dev.length} hold=${hold.length}`);

const wins = [3, 5, 10, 20]; const binsArr = [40, 80]; const kinds: ("poc"|"va")[] = ["poc","va"];
const dirs: ("rev"|"cont")[] = ["rev","cont"]; const bands = [1,2]; const dbs = [0,0.3];
interface C { id: string; win: number; nBins: number; kind: "poc"|"va"; dir: "rev"|"cont"; band: number; db: number }
const cfgs: C[] = [];
for (const win of wins) for (const nBins of binsArr) for (const kind of kinds) for (const dir of dirs) for (const band of bands) for (const db of dbs)
  cfgs.push({ id: `w${win}_b${nBins}_${kind}_${dir}_band${band}_db${db}`, win, nBins, kind, dir, band, db });
const honestN = cfgs.length;

// build positions on the FULL daily series once, then split (profile uses 15m
// indices from the full set; selection uses dev slice only)
let best: C | null = null; let bestS = -Infinity;
const devFolds: { id: string; folds: number[][] }[] = [];
const posCache = new Map<string, number[]>();
for (const c of cfgs) {
  const posFull = vpDailyPositions(daily, dayIdx, all, c.win, c.nBins, 0.7, c.kind, c.dir, c.band, c.db);
  posCache.set(c.id, posFull);
  const posDev = posFull.slice(0, dev.length);
  const bt = backtestNet(posDev.slice(0, dRets.length), dRets);
  const sh = shp(bt.net); if (sh > bestS) { bestS = sh; best = c; }
  const k = Math.floor(bt.net.length / 5);
  devFolds.push({ id: c.id, folds: [0,1,2,3,4].map((f) => bt.net.slice(f*k,(f+1)*k)) });
}
if (!best) throw new Error("none");
console.log(`[D2-VP-daily] best dev = ${best.id} devNetSharpe=${bestS.toFixed(3)}`);

const posHoldFull = posCache.get(best.id)!.slice(dev.length);
const btH = backtestNet(posHoldFull.slice(0, hRets.length), hRets);
const observed = shp(btH.net);
const holdFolds: { id: string; folds: number[][] }[] = [];
for (const c of cfgs) {
  const ph = posCache.get(c.id)!.slice(dev.length);
  const bt = backtestNet(ph.slice(0, hRets.length), hRets);
  const k = Math.floor(bt.net.length / 5);
  holdFolds.push({ id: c.id, folds: [0,1,2,3,4].map((f) => bt.net.slice(f*k,(f+1)*k)) });
}

// phase-rand surrogate on holdout daily closes; rebuild synthetic daily bars and
// re-derive the daily profile from the same-day-aggregated synthetic 15m proxy.
// Here the profile is built from DAILY bars' H/L range (the daily test already
// aggregates), so we phase-rand the daily log-returns and rebuild daily bars.
function fft(re: Float64Array, im: Float64Array, inv: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = (2*Math.PI)/len/(inv?-1:1); const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len/2; k += 1) { const ur = re[i+k], ui = im[i+k]; const vr = re[i+k+len/2]*cr - im[i+k+len/2]*ci; const vi = re[i+k+len/2]*ci + im[i+k+len/2]*cr; re[i+k]=ur+vr; im[i+k]=ui+vi; re[i+k+len/2]=ur-vr; im[i+k+len/2]=ui-vi; const ncr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = ncr; } } }
  if (inv) for (let i = 0; i < n; i += 1) (re[i] /= n), (im[i] /= n);
}
function phaseRand(lr: number[], rand: () => number): number[] {
  const n = lr.length; const mean = lr.reduce((a,b)=>a+b,0)/n; let N=1; while(N<n) N<<=1;
  const re = new Float64Array(N), im = new Float64Array(N); for (let i=0;i<n;i+=1) re[i]=lr[i]-mean;
  fft(re, im, false); const half = N>>1;
  for (let k=1;k<half;k+=1){ const mag=Math.hypot(re[k],im[k]); const ph=2*Math.PI*rand(); re[k]=mag*Math.cos(ph); im[k]=mag*Math.sin(ph); re[N-k]=re[k]; im[N-k]=-im[k]; }
  im[0]=0; if (half<N) im[half]=0; fft(re,im,true);
  const out: number[] = new Array(n); for (let i=0;i<n;i+=1) out[i]=re[i]+mean;
  const so=[...lr].sort((a,b)=>a-b); const ord=out.map((v,i)=>[v,i] as [number,number]).sort((a,b)=>a[0]-b[0]); const m=new Array(n);
  for (let r=0;r<n;r+=1) m[ord[r][1]]=so[r]; return m;
}
const holdLog: number[] = []; for (let i = 1; i < hold.length; i += 1) holdLog.push(Math.log(hold[i].c / hold[i-1].c));
// daily-cadence surrogate: rebuild a daily profile directly from synthetic daily bars
function vpFromDailyBars(bars: Bar[], win: number, nBins: number, kind: "poc"|"va", dir: "rev"|"cont", band: number, db: number): number[] {
  const n = bars.length; const pos = new Float64Array(n).fill(0);
  for (let d = win; d < n; d += 1) {
    const prof = buildProfile(bars, d - win, d - 1, nBins, 0.7); if (!prof) continue;
    const p = bars[d - 1].c; const width = (prof.vah - prof.val)/2 || prof.binW*nBins*0.1;
    const sgn = dir === "rev" ? -1 : 1; let raw = 0;
    if (kind === "poc") raw = sgn * -((p - prof.poc)/(band*width||1));
    else { if (p > prof.vah) raw = sgn * -((p-prof.vah)/(band*width||1)); else if (p < prof.val) raw = sgn * ((prof.val-p)/(band*width||1)); }
    let q = Math.max(-1,Math.min(1,raw)); if (Math.abs(q)<db) q=0; pos[d]=q;
  }
  return Array.from(pos);
}
const surS: number[] = [];
for (let s = 0; s < SUR; s += 1) {
  const rand = rng(9000 + s); const sl = phaseRand(holdLog, rand);
  const sc: number[] = new Array(hold.length); sc[0] = hold[0].c;
  for (let i = 1; i < hold.length; i += 1) sc[i] = sc[i-1]*Math.exp(sl[i-1]);
  const sBars: Bar[] = hold.map((b,i)=>{ const c=sc[i]; const hr=(b.h-b.l)/2; return { t:b.t, o:i>0?sc[i-1]:c, h:c+hr, l:Math.max(1e-6,c-hr), c, v:b.v, tbb:b.tbb, n:b.n }; });
  const sr = rets(sc);
  const pos = vpFromDailyBars(sBars, best.win, best.nBins, best.kind, best.dir, best.band, best.db);
  const bt = backtestNet(pos.slice(0, sr.length), sr); surS.push(shp(bt.net));
}

const r = runGauntlet({ name: "D2-VP daily POC/VA reversion (h>=1, holdout)", config: best.id, net: btH.net, gross: btH.gross, turnover: btH.turnover, honestN, surrogateSharpes: surS, observedSharpe: observed, buyHoldRets: hRets, pboStrategies: holdFolds, periodsPerYear: PPY });
console.log(`[D2-VP-daily] holdout netSharpe=${observed.toFixed(3)} grossSharpe=${shp(btH.gross).toFixed(3)} surP=${r.surrogateP.toFixed(4)} surMean=${r.surrogateMeanSharpe.toFixed(3)}`);
printResult(r);
