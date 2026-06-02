/**
 * D6-M1 push: genuinely try to find an edge that is NOT coincident long-beta.
 *
 * The main harness selected on net Sharpe and that just picked the most long-biased config (rides
 * BTC beta). Here we instead ask the HARD question directly: does ANY rate/curve timer produce a
 * positive SPX-beta-NEUTRALIZED edge that ALSO beats its own AR-matched-rate placebo, in-sample AND
 * out-of-regime? If nothing clears that bar, the thesis is dead for the stated reason (slow rates,
 * coincident beta). We scan the full grid and report the best honest-edge candidate by residual.
 */
import fs from "node:fs";

const ROOT = ".";
const COST = 0.0004;
const ANN = Math.sqrt(365);
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
};
const annSh = (a: number[]) => {
  const s = std(a);
  return s > 1e-12 ? (mean(a) / s) * ANN : 0;
};
function mkRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function loadFred(id: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const ln of fs.readFileSync(`${ROOT}/output/edgehunt-D6/${id}.csv`, "utf8").trim().split("\n").slice(1)) {
    const [d, v] = ln.split(",");
    const x = Number(v);
    if (d && Number.isFinite(x)) m.set(d, x);
  }
  return m;
}
function ffill(dates: string[], src: Map<string, number>): number[] {
  const out = new Array(dates.length).fill(NaN);
  const sd = [...src.keys()].sort();
  let j = 0,
    last = NaN;
  for (let i = 0; i < dates.length; i++) {
    while (j < sd.length && sd[j] <= dates[i]) last = src.get(sd[j++])!;
    out[i] = last;
  }
  return out;
}
const btc = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/BTCUSDT_prices_daily.json`, "utf8"));
const dates: string[] = [];
const close: number[] = [];
for (const r of btc) if (r.spotClose > 0) (dates.push(r.date), close.push(Number(r.spotClose)));
const T = close.length;
const fwd = new Array(T).fill(NaN);
for (let t = 0; t + 1 < T; t++) fwd[t] = Math.log(close[t + 1] / close[t]);
const spx = ffill(dates, loadFred("SP500"));
const spxRet = new Array(T).fill(0);
for (let t = 0; t + 1 < T; t++) spxRet[t] = spx[t] > 0 && spx[t + 1] > 0 ? Math.log(spx[t + 1] / spx[t]) : 0;
const dgs10 = ffill(dates, loadFred("DGS10"));
const dgs2 = ffill(dates, loadFred("DGS2"));
const slope = ffill(dates, loadFred("T10Y2Y"));

const MAXMOM = 126;
const startIdx = MAXMOM + 2;
const tradableEnd = T - 1;
const splitIdx = startIdx + Math.floor((tradableEnd - startIdx) * 0.75);

function smaPrev(x: number[], t: number, w: number) {
  if (t - w + 1 < 0) return NaN;
  let s = 0;
  for (let k = t - w + 1; k <= t; k++) {
    if (!Number.isFinite(x[k])) return NaN;
    s += x[k];
  }
  return s / w;
}
type Sig = "rateChg" | "slopeMom" | "combo" | "rateLevel" | "slopeLevel" | "real2y" | "comboLS";
function pos(sig: Sig, mom: number, mode: string): number[] {
  const flat = mode === "ls" ? -1 : mode === "half" ? 0.5 : 0;
  const out = new Array(T).fill(0);
  for (let t = 1; t < T; t++) {
    const i = t - 1;
    let r: number;
    if (sig === "rateChg") r = i - mom < 0 ? NaN : dgs10[i] - dgs10[i - mom] < 0 ? 1 : -1;
    else if (sig === "real2y") r = i - mom < 0 ? NaN : dgs2[i] - dgs2[i - mom] < 0 ? 1 : -1; // 2y change = policy-rate path
    else if (sig === "rateLevel") {
      const a = smaPrev(dgs10, i, mom);
      r = Number.isFinite(a) ? (dgs10[i] < a ? 1 : -1) : NaN;
    } else if (sig === "slopeMom") r = i - mom < 0 ? NaN : slope[i] - slope[i - mom] > 0 ? 1 : -1;
    else if (sig === "slopeLevel") {
      const a = smaPrev(slope, i, mom);
      r = Number.isFinite(a) ? (slope[i] > a ? 1 : -1) : NaN;
    } else if (sig === "comboLS") {
      // AND-confirmed long/short pure timer: long only if rates falling AND curve steepening
      if (i - mom < 0) r = NaN;
      else {
        const dr = dgs10[i] - dgs10[i - mom],
          ds = slope[i] - slope[i - mom];
        r = dr < 0 && ds > 0 ? 1 : dr > 0 && ds < 0 ? -1 : 0;
      }
    } else {
      if (i - mom < 0) r = NaN;
      else {
        const dr = dgs10[i] - dgs10[i - mom],
          ds = slope[i] - slope[i - mom];
        r = dr < 0 || ds > 0 ? 1 : -1;
      }
    }
    if (!Number.isFinite(r)) {
      out[t] = NaN;
      continue;
    }
    out[t] = r > 0 ? 1 : r < 0 ? flat : 0;
  }
  return out;
}
function run(p: number[], lo: number, hi: number) {
  const net: number[] = [],
    sp: number[] = [];
  let prev = 0;
  for (let t = lo; t < hi; t++) {
    if (!Number.isFinite(fwd[t]) || !Number.isFinite(p[t])) continue;
    net.push(p[t] * fwd[t] - Math.abs(p[t] - prev) * COST);
    sp.push(spxRet[t]);
    prev = p[t];
  }
  const n = net.length;
  const mS = mean(sp),
    mN = mean(net);
  let cov = 0,
    vS = 0;
  for (let k = 0; k < n; k++) {
    cov += (sp[k] - mS) * (net[k] - mN);
    vS += (sp[k] - mS) ** 2;
  }
  const beta = vS > 1e-12 ? cov / vS : 0;
  return { net, resid: net.map((v, k) => v - beta * sp[k]), beta };
}
// AR-matched-rate placebo on the residual
function ar1(x: number[]) {
  const ch: number[] = [];
  for (let t = 1; t < x.length; t++) if (Number.isFinite(x[t]) && Number.isFinite(x[t - 1])) ch.push(x[t] - x[t - 1]);
  const m = mean(ch);
  let num = 0,
    den = 0;
  for (let t = 1; t < ch.length; t++) {
    num += (ch[t] - m) * (ch[t - 1] - m);
    den += (ch[t - 1] - m) ** 2;
  }
  const phi = den > 1e-12 ? num / den : 0;
  const res: number[] = [];
  for (let t = 1; t < ch.length; t++) res.push(ch[t] - m - phi * (ch[t - 1] - m));
  return { phi, sigma: std(res), mu: m, l0: x.find((v) => Number.isFinite(v)) ?? 0 };
}
function sim(f: any, rng: () => number): number[] {
  const g = () => {
    const u1 = Math.max(1e-12, rng()),
      u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const o = new Array(T).fill(0);
  let lvl = f.l0,
    pc = 0;
  o[0] = lvl;
  for (let t = 1; t < T; t++) {
    const c = f.mu + f.phi * (pc - f.mu) + f.sigma * g();
    lvl += c;
    o[t] = lvl;
    pc = c;
  }
  return o;
}
const f10 = ar1(dgs10),
  fS = ar1(slope),
  f2 = ar1(dgs2);

// scan: for each config, in-sample net Sharpe, SPX-neutral residual Sharpe, placebo-p on residual,
// out-of-regime holdout net & residual Sharpe.
const sigs: Sig[] = ["rateChg", "real2y", "rateLevel", "slopeMom", "slopeLevel", "combo", "comboLS"];
const moms = [21, 42, 63, 126];
const modes = ["flat", "half", "ls"];
const rows: any[] = [];
for (const sig of sigs)
  for (const mom of moms)
    for (const mode of modes) {
      const p = pos(sig, mom, mode);
      const isr = run(p, startIdx, splitIdx);
      const oos = run(p, splitIdx, tradableEnd);
      const realResid = annSh(isr.resid);
      // residual placebo: simulate surrogate rate paths, rebuild, measure residual Sharpe
      const sr: number[] = [];
      for (let i = 0; i < 200; i++) {
        const rng = mkRng(555 + i * 7919);
        const sD = sim(f10, rng),
          sS = sim(fS, rng),
          s2 = sim(f2, rng);
        const sp = posFrom(sig, mom, mode, sD, sS, s2);
        sr.push(annSh(run(sp, startIdx, splitIdx).resid));
      }
      const placeboP = (sr.filter((x) => x >= realResid).length + 1) / 201;
      rows.push({
        cfg: `${sig}-${mom}-${mode}`,
        isNet: +annSh(isr.net).toFixed(3),
        isResid: +realResid.toFixed(3),
        residPlaceboP: +placeboP.toFixed(3),
        oosNet: +annSh(oos.net).toFixed(3),
        oosResid: +annSh(oos.resid).toFixed(3),
        beta: +isr.beta.toFixed(3),
      });
    }
function posFrom(sig: Sig, mom: number, mode: string, D: number[], S: number[], R2: number[]): number[] {
  const flat = mode === "ls" ? -1 : mode === "half" ? 0.5 : 0;
  const out = new Array(T).fill(0);
  for (let t = 1; t < T; t++) {
    const i = t - 1;
    let r: number;
    if (sig === "rateChg") r = i - mom < 0 ? NaN : D[i] - D[i - mom] < 0 ? 1 : -1;
    else if (sig === "real2y") r = i - mom < 0 ? NaN : R2[i] - R2[i - mom] < 0 ? 1 : -1;
    else if (sig === "rateLevel") {
      const a = smaPrev(D, i, mom);
      r = Number.isFinite(a) ? (D[i] < a ? 1 : -1) : NaN;
    } else if (sig === "slopeMom") r = i - mom < 0 ? NaN : S[i] - S[i - mom] > 0 ? 1 : -1;
    else if (sig === "slopeLevel") {
      const a = smaPrev(S, i, mom);
      r = Number.isFinite(a) ? (S[i] > a ? 1 : -1) : NaN;
    } else if (sig === "comboLS") {
      if (i - mom < 0) r = NaN;
      else {
        const dr = D[i] - D[i - mom],
          ds = S[i] - S[i - mom];
        r = dr < 0 && ds > 0 ? 1 : dr > 0 && ds < 0 ? -1 : 0;
      }
    } else {
      if (i - mom < 0) r = NaN;
      else {
        const dr = D[i] - D[i - mom],
          ds = S[i] - S[i - mom];
        r = dr < 0 || ds > 0 ? 1 : -1;
      }
    }
    if (!Number.isFinite(r)) {
      out[t] = NaN;
      continue;
    }
    out[t] = r > 0 ? 1 : r < 0 ? flat : 0;
  }
  return out;
}

// best by IN-SAMPLE residual (honest-edge candidate, NOT long-beta)
const byResid = [...rows].sort((a, b) => b.isResid - a.isResid);
// candidates that pass the honest bar in-sample: positive residual AND beats own placebo
const honest = rows.filter((r) => r.isResid > 0 && r.residPlaceboP < 0.05);
// of those, how many ALSO hold up out-of-regime?
const oosHold = honest.filter((r) => r.oosResid > 0);
console.log("=== top 8 by in-sample SPX-neutral residual Sharpe ===");
for (const r of byResid.slice(0, 8)) console.log(JSON.stringify(r));
console.log(`\nconfigs with positive in-sample residual AND residPlaceboP<0.05: ${honest.length}/${rows.length}`);
console.log(`  ...of those that ALSO have positive OUT-OF-REGIME residual: ${oosHold.length}`);
if (honest.length) console.log("  honest in-sample candidates:", honest.map((r) => r.cfg).join(", "));
if (oosHold.length) console.log("  survive OOS too:", JSON.stringify(oosHold));
console.log(`\nB&H in-sample netSh=${annSh(run(new Array(T).fill(1), startIdx, splitIdx).net).toFixed(3)} OOS=${annSh(run(new Array(T).fill(1), splitIdx, tradableEnd).net).toFixed(3)}`);
