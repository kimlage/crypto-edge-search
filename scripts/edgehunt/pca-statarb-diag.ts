/**
 * Diagnostic / push-harder pass for PCA stat-arb.
 *  - Loosen OU filters & s_in to increase breadth (more names traded/day).
 *  - Separate GROSS (pre-cost) residual-reversion signal from cost drag.
 *  - Test the cost-vs-edge frontier explicitly (vary costBps and s_in).
 *  - Confirm whether a denser book has any pre-cost edge at all.
 * If gross edge is absent, cost is moot and the strategy is dead at the signal level.
 */
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";
import * as fs from "fs";

type Panel = { dates: string[]; coins: string[]; closes: number[][] };
function loadPanel(p: string): Panel {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const coins = Object.keys(raw.closes);
  const T = raw.dates.length;
  const closes: number[][] = [];
  for (let t = 0; t < T; t++) {
    const row: number[] = [];
    for (const c of coins) { const v = raw.closes[c][t]; row.push(v == null || v === 0 ? NaN : v); }
    closes.push(row);
  }
  return { dates: raw.dates, coins, closes };
}
function logReturns(cl: number[][]): number[][] {
  const T = cl.length, N = cl[0].length;
  const ret: number[][] = [new Array(N).fill(NaN)];
  for (let t = 1; t < T; t++) {
    const row: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = cl[t - 1][i], b = cl[t][i];
      row.push(Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 ? Math.log(b / a) : NaN);
    }
    ret.push(row);
  }
  return ret;
}
function jacobiEigen(A: number[][], maxSweeps = 80) {
  const n = A.length; const a = A.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      const app = a[p][p], aqq = a[q][q], apq = a[p][q];
      const phi = 0.5 * Math.atan2(2 * apq, aqq - app), c = Math.cos(phi), s = Math.sin(phi);
      for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const values = a.map((_, i) => a[i][i]);
  const vectors: number[][] = []; for (let i = 0; i < n; i++) vectors.push(V.map((row) => row[i]));
  const idx = values.map((_, i) => i).sort((x, y) => values[y] - values[x]);
  return { values: idx.map((i) => values[i]), vectors: idx.map((i) => vectors[i]) };
}
function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col; for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col]; for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) { if (r === col) continue; const f = M[r][col]; if (f === 0) continue; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j]; }
  }
  return M.map((r) => r.slice(n));
}
function ouFit(X: number[]) {
  const n = X.length; if (n < 20) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0; const cnt = n - 1;
  for (let t = 1; t < n; t++) { const x = X[t - 1], y = X[t]; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = cnt * sxx - sx * sx; if (Math.abs(denom) < 1e-15) return null;
  const b = (cnt * sxy - sx * sy) / denom; const a = (sy - b * sx) / cnt;
  if (!(b > 0 && b < 1)) return null;
  let se = 0; for (let t = 1; t < n; t++) { const e = X[t] - (a + b * X[t - 1]); se += e * e; }
  const varE = se / (cnt - 2); const m = a / (1 - b);
  const sigmaEq = Math.sqrt(Math.max(varE / (1 - b * b), 1e-18));
  const kappa = -Math.log(b); const halflife = Math.log(2) / kappa;
  return { b, m, sigmaEq, kappa, halflife };
}

type Cfg = { lookback: number; k: number; sIn: number; sOut: number; minHistory: number; ouMaxHalflife: number; targetVol: number; maxTurnover: number; costBps: number };

// Returns net & gross daily book returns plus breadth.
function backtest(ret: number[][], cfg: Cfg) {
  const T = ret.length, N = ret[0].length, L = cfg.lookback, ann = Math.sqrt(365);
  const net: number[] = [], gross: number[] = [], breadth: number[] = [], turn: number[] = [];
  let prevW = new Array(N).fill(0);
  for (let t0 = L; t0 < T - 1; t0++) {
    const wStart = t0 - L + 1;
    const valid: number[] = [], series: number[][] = [];
    for (let i = 0; i < N; i++) {
      let ok = true; const s: number[] = [];
      for (let t = wStart; t <= t0; t++) { const v = ret[t][i]; if (!Number.isFinite(v)) { ok = false; break; } s.push(v); }
      if (ok && s.length === L) {
        let hist = 0; for (let t = 1; t <= t0; t++) if (Number.isFinite(ret[t][i])) hist++;
        if (hist >= cfg.minHistory) { valid.push(i); series.push(s); }
      }
    }
    const M = valid.length; if (M < cfg.k + 5) continue;
    const means = series.map((s) => s.reduce((a, b) => a + b, 0) / L);
    const sds = series.map((s, i) => { const m = means[i]; const v = s.reduce((a, b) => a + (b - m) * (b - m), 0) / (L - 1); return Math.sqrt(Math.max(v, 1e-12)); });
    const Z = series.map((s, i) => s.map((x) => (x - means[i]) / sds[i]));
    const C = Array.from({ length: M }, () => new Array(M).fill(0));
    for (let a = 0; a < M; a++) for (let b = a; b < M; b++) { let dot = 0; for (let t = 0; t < L; t++) dot += Z[a][t] * Z[b][t]; const c = dot / (L - 1); C[a][b] = c; C[b][a] = c; }
    const { vectors } = jacobiEigen(C);
    const k = Math.min(cfg.k, M - 1);
    const F: number[][] = [];
    for (let f = 0; f < k; f++) { const ev = vectors[f]; const q = ev.map((val, i) => val / sds[i]); const fr: number[] = []; for (let t = 0; t < L; t++) { let s = 0; for (let i = 0; i < M; i++) s += q[i] * series[i][t]; fr.push(s); } F.push(fr); }
    const fMean = F.map((fr) => fr.reduce((a, b) => a + b, 0) / L);
    const fSd = F.map((fr, f) => { const m = fMean[f]; const v = fr.reduce((a, b) => a + (b - m) * (b - m), 0) / (L - 1); return Math.sqrt(Math.max(v, 1e-12)); });
    const Fz = F.map((fr, f) => fr.map((x) => (x - fMean[f]) / fSd[f]));
    const P = k + 1;
    const X: number[][] = []; for (let t = 0; t < L; t++) { const row = [1]; for (let f = 0; f < k; f++) row.push(Fz[f][t]); X.push(row); }
    const XtX = Array.from({ length: P }, () => new Array(P).fill(0));
    for (let t = 0; t < L; t++) for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) XtX[a][b] += X[t][a] * X[t][b];
    const XtXinv = invertMatrix(XtX); if (!XtXinv) continue;
    const sc: { coin: number; s: number }[] = [];
    for (let ci = 0; ci < M; ci++) {
      const y = series[ci]; const Xty = new Array(P).fill(0);
      for (let t = 0; t < L; t++) for (let a = 0; a < P; a++) Xty[a] += X[t][a] * y[t];
      const beta = new Array(P).fill(0); for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) beta[a] += XtXinv[a][b] * Xty[b];
      const resid: number[] = []; for (let t = 0; t < L; t++) { let pred = 0; for (let a = 0; a < P; a++) pred += X[t][a] * beta[a]; resid.push(y[t] - pred); }
      const Xcum: number[] = []; let acc = 0; for (let t = 0; t < L; t++) { acc += resid[t]; Xcum.push(acc); }
      const ou = ouFit(Xcum); if (!ou) continue;
      if (ou.halflife > cfg.ouMaxHalflife) continue;
      const sRaw = (Xcum[Xcum.length - 1] - ou.m) / ou.sigmaEq;
      if (!Number.isFinite(sRaw)) continue;
      sc.push({ coin: valid[ci], s: sRaw });
    }
    const rawW = new Array(N).fill(0);
    for (const x of sc) {
      if (x.s > cfg.sIn) rawW[x.coin] = -1;
      else if (x.s < -cfg.sIn) rawW[x.coin] = 1;
      else if (Math.abs(x.s) < cfg.sOut) rawW[x.coin] = 0;
      else rawW[x.coin] = Math.sign(prevW[x.coin]) || 0;
    }
    const nL = rawW.filter((w) => w > 0).length, nS = rawW.filter((w) => w < 0).length;
    const wN = new Array(N).fill(0);
    if (nL > 0 && nS > 0) for (let i = 0; i < N; i++) { if (rawW[i] > 0) wN[i] = 1 / nL; else if (rawW[i] < 0) wN[i] = -1 / nS; }
    let bookVar = 0;
    for (let t = 0; t < L; t++) { let r = 0; for (let ci = 0; ci < M; ci++) { const w = wN[valid[ci]]; if (w !== 0) r += w * series[ci][t]; } bookVar += r * r; }
    bookVar /= L; const bvAnn = Math.sqrt(Math.max(bookVar, 1e-12)) * ann;
    let scale = bvAnn > 1e-9 ? cfg.targetVol / bvAnn : 0; scale = Math.min(scale, 5);
    const targetW = wN.map((w) => w * scale);
    let dwSum = 0; for (let i = 0; i < N; i++) dwSum += Math.abs(targetW[i] - prevW[i]);
    let finalW = targetW;
    if (dwSum > cfg.maxTurnover && dwSum > 1e-12) { const alpha = cfg.maxTurnover / dwSum; finalW = targetW.map((w, i) => prevW[i] + alpha * (w - prevW[i])); }
    let to = 0; for (let i = 0; i < N; i++) to += Math.abs(finalW[i] - prevW[i]);
    const cost = (to * cfg.costBps) / 10000;
    const rNext = ret[t0 + 1]; let g = 0;
    for (let i = 0; i < N; i++) if (Number.isFinite(rNext[i]) && finalW[i] !== 0) g += finalW[i] * rNext[i];
    net.push(g - cost); gross.push(g); turn.push(to);
    breadth.push(finalW.filter((w) => Math.abs(w) > 1e-9).length);
    prevW = finalW;
  }
  return { net, gross, turn, breadth };
}
const sh = (r: number[]) => summarizeReturnSeries(r).sharpe * Math.sqrt(365);
const avg = (r: number[]) => r.reduce((a, b) => a + b, 0) / r.length;

function main() {
  const panel = loadPanel("output/crossxs/daily-closes.json");
  const ret = logReturns(panel.closes);

  console.log("=== Breadth & GROSS-signal sweep (loosened OU, denser book) ===");
  console.log("lb  k  sIn  hl | grossSh  netSh@4bps  avgBreadth  avgTurn  netSh@0bps");
  const base = { sOut: 0.5, minHistory: 90, targetVol: 0.10, maxTurnover: 2.0 };
  const rows: any[] = [];
  for (const lb of [30, 45, 60]) for (const k of [2, 3, 5]) for (const sIn of [0.75, 1.0, 1.25]) for (const hl of [15, 30, 60]) {
    const cfg: Cfg = { lookback: lb, k, sIn, ouMaxHalflife: hl, costBps: 4, ...base };
    const r = backtest(ret, cfg);
    if (r.net.length < 100) continue;
    const grossSh = sh(r.gross), netSh = sh(r.net);
    const r0 = backtest(ret, { ...cfg, costBps: 0 });
    const net0 = sh(r0.net);
    rows.push({ lb, k, sIn, hl, grossSh, netSh, net0, breadth: avg(r.breadth), turn: avg(r.turn) });
  }
  // sort by gross sharpe to see if ANY pre-cost edge exists
  rows.sort((a, b) => b.grossSh - a.grossSh);
  for (const x of rows.slice(0, 25)) {
    console.log(`${String(x.lb).padStart(2)} ${x.k}  ${x.sIn.toFixed(2)} ${String(x.hl).padStart(2)} | ${x.grossSh.toFixed(2).padStart(6)}  ${x.netSh.toFixed(2).padStart(6)}     ${x.breadth.toFixed(1).padStart(4)}      ${x.turn.toFixed(2)}    ${x.net0.toFixed(2)}`);
  }
  const bestGross = rows[0];
  console.log(`\nMax GROSS Sharpe across ${rows.length} loosened configs = ${bestGross.grossSh.toFixed(3)} (lb=${bestGross.lb} k=${bestGross.k} sIn=${bestGross.sIn} hl=${bestGross.hl})`);
  console.log(`  -> its net@4bps = ${bestGross.netSh.toFixed(3)}, breadth=${bestGross.breadth.toFixed(1)}, turnover=${bestGross.turn.toFixed(2)}`);
  const posGross = rows.filter((r) => r.grossSh > 0.5).length;
  console.log(`Configs with gross Sharpe > 0.5: ${posGross}/${rows.length}`);
  console.log(`Configs with net@4bps Sharpe > 0.5: ${rows.filter((r) => r.netSh > 0.5).length}/${rows.length}`);

  fs.writeFileSync("output/edgehunt/pca-statarb-diag.json", JSON.stringify({ rows: rows.slice(0, 40), bestGross }, null, 2));
}
main();
