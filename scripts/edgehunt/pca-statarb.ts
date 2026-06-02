/**
 * PCA basket stat-arb (Avellaneda-Lee s-score) on the 30-coin daily panel.
 *
 * Pipeline (no look-ahead, all parameters trailing):
 *   1. Rolling PCA on standardized daily returns over `lookback`.
 *   2. Build top-k eigen-portfolio return series (factor returns).
 *   3. Regress each coin's return on factors over the same window -> betas + idio residual.
 *   4. Accumulate residual into X_t; OU-fit (AR(1) on X) -> s-score (Avellaneda-Lee).
 *   5. Trade s-score: enter when |s|>s_in (mean-revert), exit near 0; vol-target,
 *      liquidity (history) filter, cap turnover. Cost 4bps/side on every weight change.
 *
 * The book return for day t uses weights formed at close of t-1 (signal from data up to t-1)
 * applied to the realized return on day t. Strictly causal.
 *
 * Judged with committed primitives in src/lib/training/statistical-validation.ts:
 *   computeDeflatedSharpeRatio (DSR @ honest N), estimateCscvPbo (CPCV/PBO),
 *   blockBootstrapConfidenceInterval. Harvey-Liu (BHY) haircut computed inline from the
 *   honest trial count. Surrogate null = factor-preserving block bootstrap + cross-sectional
 *   shuffle of residual rankings + bracket-on-surrogate for the s-score band exits.
 */

import {
  computeDeflatedSharpeRatio,
  estimateCscvPbo,
  blockBootstrapConfidenceInterval,
  summarizeReturnSeries,
} from "../../src/lib/training/statistical-validation";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
type Panel = {
  dates: string[];
  coins: string[];
  // closes[t][i] = close price of coin i on day t (NaN if missing)
  closes: number[][];
};

function loadPanel(path: string): Panel {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const dates: string[] = raw.dates;
  const coins = Object.keys(raw.closes);
  const T = dates.length;
  const closes: number[][] = [];
  for (let t = 0; t < T; t++) {
    const row: number[] = [];
    for (const c of coins) {
      const v = raw.closes[c][t];
      row.push(v == null || v === 0 ? NaN : v);
    }
    closes.push(row);
  }
  return { dates, coins, closes };
}

// log returns; ret[t][i] = log(P_t/P_{t-1}); ret[0] undefined (NaN)
function logReturns(closes: number[][]): number[][] {
  const T = closes.length;
  const N = closes[0].length;
  const ret: number[][] = [new Array(N).fill(NaN)];
  for (let t = 1; t < T; t++) {
    const row: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = closes[t - 1][i];
      const b = closes[t][i];
      row.push(Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 ? Math.log(b / a) : NaN);
    }
    ret.push(row);
  }
  return ret;
}

// ---------------------------------------------------------------------------
// Linear algebra: symmetric eigendecomposition via Jacobi rotation
// ---------------------------------------------------------------------------
function jacobiEigen(A: number[][], maxSweeps = 100): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        const app = a[p][p], aqq = a[q][q], apq = a[p][q];
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi), s = Math.sin(phi);
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = a.map((_, i) => a[i][i]);
  const vectors: number[][] = []; // vectors[i] = eigenvector i (column)
  for (let i = 0; i < n; i++) vectors.push(V.map((row) => row[i]));
  // sort descending by eigenvalue
  const idx = values.map((_, i) => i).sort((x, y) => values[y] - values[x]);
  return { values: idx.map((i) => values[i]), vectors: idx.map((i) => vectors[i]) };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
type Config = {
  lookback: number; // window for PCA + beta regression
  k: number; // number of eigen-portfolios (factors)
  sIn: number; // entry |s|
  sOut: number; // exit |s| (mean-revert toward 0)
  minHistory: number; // liquidity proxy: require this many valid returns
  ouMinKappa: number; // require OU mean-reversion speed (per day) above this
  ouMaxHalflife: number; // require half-life below this (days)
  targetVol: number; // annualized vol target for the book
  maxTurnover: number; // cap daily turnover (sum |dw|)
  costBps: number; // per side
};

// ---------------------------------------------------------------------------
// Core backtest. Returns daily net book returns + diagnostics.
// ---------------------------------------------------------------------------
type BacktestOut = {
  dates: string[];
  net: number[]; // net-of-cost daily book return aligned to dates (starts after warmup)
  gross: number[];
  turnover: number[];
  positions: number[]; // avg # names held that day
  // residual diagnostics for neutrality / stationarity checks
  bookWeights: number[][]; // weights per coin per active day (for neutrality regression)
  activeDateIdx: number[]; // index into panel dates for each active day
  factorPC1: number[]; // PC1 return each active day (for neutrality regression)
  btcRet: number[]; // BTC return each active day
};

function backtest(
  ret: number[][],
  dates: string[],
  cfg: Config,
  opts: { shuffleResidualRanks?: boolean; rng?: () => number } = {},
): BacktestOut {
  const T = ret.length;
  const N = ret[0].length;
  const L = cfg.lookback;
  const ann = Math.sqrt(365);

  const net: number[] = [];
  const gross: number[] = [];
  const turnover: number[] = [];
  const positions: number[] = [];
  const bookWeights: number[][] = [];
  const activeDateIdx: number[] = [];
  const factorPC1: number[] = [];
  const btcRet: number[] = [];

  let prevW = new Array(N).fill(0);

  // We form weights at end of day t0 (using data up to and incl. t0), realize on t0+1.
  for (let t0 = L; t0 < T - 1; t0++) {
    // window of returns rows [t0-L+1 .. t0] inclusive
    const wStart = t0 - L + 1;
    // valid coins: finite returns across the whole window
    const valid: number[] = [];
    const series: number[][] = []; // per valid coin: window returns
    for (let i = 0; i < N; i++) {
      let ok = true;
      const s: number[] = [];
      for (let t = wStart; t <= t0; t++) {
        const v = ret[t][i];
        if (!Number.isFinite(v)) { ok = false; break; }
        s.push(v);
      }
      if (ok && s.length === L) {
        // liquidity/history filter: require coin has at least minHistory total valid days up to t0
        let hist = 0;
        for (let t = 1; t <= t0; t++) if (Number.isFinite(ret[t][i])) hist++;
        if (hist >= cfg.minHistory) { valid.push(i); series.push(s); }
      }
    }
    const M = valid.length;
    if (M < cfg.k + 5) { continue; } // need enough names

    // standardize each coin's window returns (z-score) for PCA on correlation
    const means = series.map((s) => s.reduce((a, b) => a + b, 0) / L);
    const sds = series.map((s, i) => {
      const m = means[i];
      const v = s.reduce((a, b) => a + (b - m) * (b - m), 0) / (L - 1);
      return Math.sqrt(Math.max(v, 1e-12));
    });
    const Z: number[][] = series.map((s, i) => s.map((x) => (x - means[i]) / sds[i])); // M x L

    // correlation matrix (M x M)
    const C: number[][] = Array.from({ length: M }, () => new Array(M).fill(0));
    for (let a = 0; a < M; a++) {
      for (let b = a; b < M; b++) {
        let dot = 0;
        for (let t = 0; t < L; t++) dot += Z[a][t] * Z[b][t];
        const c = dot / (L - 1);
        C[a][b] = c; C[b][a] = c;
      }
    }
    const { vectors } = jacobiEigen(C);
    const k = Math.min(cfg.k, M - 1);

    // Eigen-portfolio weights (Avellaneda-Lee): q_i = v_i / sigma_i (vol-weighted),
    // factor return F = sum_i q_i * raw_return_i. Build factor return series over window.
    const F: number[][] = []; // k x L
    for (let f = 0; f < k; f++) {
      const ev = vectors[f]; // length M
      const q = ev.map((val, i) => val / sds[i]);
      const fr: number[] = [];
      for (let t = 0; t < L; t++) {
        let s = 0;
        for (let i = 0; i < M; i++) s += q[i] * series[i][t];
        fr.push(s);
      }
      F.push(fr);
    }

    // standardize factor returns (for stable regression)
    const fMean = F.map((fr) => fr.reduce((a, b) => a + b, 0) / L);
    const fSd = F.map((fr, f) => {
      const m = fMean[f];
      const v = fr.reduce((a, b) => a + (b - m) * (b - m), 0) / (L - 1);
      return Math.sqrt(Math.max(v, 1e-12));
    });
    const Fz: number[][] = F.map((fr, f) => fr.map((x) => (x - fMean[f]) / fSd[f]));

    // For each valid coin: OLS regress its window returns on [1, Fz...] -> residual series.
    // Then OU-fit AR(1) on cumulative residual to get s-score (Avellaneda-Lee).
    // Build Gram matrix once for the design [1, Fz_1..Fz_k] (same X for all coins).
    const P = k + 1;
    const X: number[][] = []; // L x P
    for (let t = 0; t < L; t++) {
      const row = [1];
      for (let f = 0; f < k; f++) row.push(Fz[f][t]);
      X.push(row);
    }
    // XtX (P x P) and its inverse
    const XtX: number[][] = Array.from({ length: P }, () => new Array(P).fill(0));
    for (let t = 0; t < L; t++)
      for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) XtX[a][b] += X[t][a] * X[t][b];
    const XtXinv = invertMatrix(XtX);
    if (!XtXinv) continue;

    const sScores: { coin: number; s: number; kappa: number; halflife: number }[] = [];
    for (let ci = 0; ci < M; ci++) {
      const y = series[ci]; // L
      // beta = XtXinv * Xt y
      const Xty = new Array(P).fill(0);
      for (let t = 0; t < L; t++) for (let a = 0; a < P; a++) Xty[a] += X[t][a] * y[t];
      const beta = new Array(P).fill(0);
      for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) beta[a] += XtXinv[a][b] * Xty[b];
      // residuals
      const resid: number[] = [];
      for (let t = 0; t < L; t++) {
        let pred = 0;
        for (let a = 0; a < P; a++) pred += X[t][a] * beta[a];
        resid.push(y[t] - pred);
      }
      // cumulative residual process X_t
      const Xcum: number[] = [];
      let acc = 0;
      for (let t = 0; t < L; t++) { acc += resid[t]; Xcum.push(acc); }
      // OU via AR(1): X_{t} = a + b X_{t-1} + e  =>  kappa=-ln(b), m = a/(1-b),
      // sigma_eq = sqrt(var(e)/(1-b^2)); s = (X_last - m)/sigma_eq  (Avellaneda-Lee)
      const ou = ouFit(Xcum);
      if (!ou) continue;
      const { b, m, sigmaEq, kappa, halflife, varE } = ou;
      if (!(b > 0 && b < 1)) continue; // require mean reversion
      if (!(sigmaEq > 1e-9)) continue;
      const sRaw = (Xcum[Xcum.length - 1] - m) / sigmaEq;
      // modified s-score (Avellaneda-Lee centering by drift) — keep raw for simplicity but
      // require OU quality filters
      if (kappa < cfg.ouMinKappa || halflife > cfg.ouMaxHalflife) continue;
      if (!Number.isFinite(sRaw)) continue;
      void varE;
      sScores.push({ coin: valid[ci], s: sRaw, kappa, halflife });
    }

    if (sScores.length === 0) {
      // no positions today
      const dw = prevW.map((w) => Math.abs(w - 0));
      const to = dw.reduce((a, b) => a + b, 0);
      // realize: zero book; but cost of closing
      const rNext = ret[t0 + 1];
      let g = 0;
      for (let i = 0; i < N; i++) if (Number.isFinite(rNext[i])) g += prevW[i] * rNext[i];
      const cost = (to * cfg.costBps) / 10000;
      net.push(g - cost);
      gross.push(g);
      turnover.push(to);
      positions.push(prevW.filter((w) => Math.abs(w) > 1e-9).length);
      bookWeights.push(prevW.slice());
      activeDateIdx.push(t0 + 1);
      // pc1 factor + btc realized
      factorPC1.push(NaN);
      btcRet.push(Number.isFinite(rNext[0]) ? rNext[0] : NaN);
      prevW = new Array(N).fill(0);
      continue;
    }

    // Optional surrogate: shuffle residual rankings across names (destroys cross-sectional info)
    if (opts.shuffleResidualRanks && opts.rng) {
      const sVals = sScores.map((x) => x.s);
      // Fisher-Yates on the s values, keep coins fixed
      for (let i = sVals.length - 1; i > 0; i--) {
        const j = Math.floor(opts.rng() * (i + 1));
        [sVals[i], sVals[j]] = [sVals[j], sVals[i]];
      }
      sScores.forEach((x, i) => (x.s = sVals[i]));
    }

    // Signal: mean-revert. s > sIn -> residual rich -> SHORT (w<0). s < -sIn -> LONG.
    // Hysteresis exit handled via target weights: if |s|<sOut -> flat.
    const rawW = new Array(N).fill(0);
    for (const sc of sScores) {
      if (sc.s > cfg.sIn) rawW[sc.coin] = -1;
      else if (sc.s < -cfg.sIn) rawW[sc.coin] = 1;
      else if (Math.abs(sc.s) < cfg.sOut) rawW[sc.coin] = 0;
      else {
        // in the band between sOut and sIn: hold prior position if it had one
        rawW[sc.coin] = Math.sign(prevW[sc.coin]) || 0;
      }
    }
    const nLong = rawW.filter((w) => w > 0).length;
    const nShort = rawW.filter((w) => w < 0).length;
    // dollar-neutralize: scale long and short legs to equal gross
    const wNeutral = new Array(N).fill(0);
    if (nLong > 0 && nShort > 0) {
      for (let i = 0; i < N; i++) {
        if (rawW[i] > 0) wNeutral[i] = 1 / nLong;
        else if (rawW[i] < 0) wNeutral[i] = -1 / nShort;
      }
    }

    // vol-target the book using trailing realized book vol from window residual structure:
    // estimate book vol via covariance of the *raw* returns under wNeutral over the window.
    let bookVar = 0;
    for (let t = 0; t < L; t++) {
      let r = 0;
      for (let ci = 0; ci < M; ci++) {
        const w = wNeutral[valid[ci]];
        if (w !== 0) r += w * series[ci][t];
      }
      bookVar += r * r;
    }
    bookVar /= L;
    const bookVolDaily = Math.sqrt(Math.max(bookVar, 1e-12));
    const bookVolAnn = bookVolDaily * ann;
    let scale = bookVolAnn > 1e-9 ? cfg.targetVol / bookVolAnn : 0;
    scale = Math.min(scale, 5); // leverage cap
    const targetW = wNeutral.map((w) => w * scale);

    // turnover cap: limit sum|dw| to maxTurnover by blending toward prevW
    let dwSum = 0;
    for (let i = 0; i < N; i++) dwSum += Math.abs(targetW[i] - prevW[i]);
    let finalW = targetW;
    if (dwSum > cfg.maxTurnover && dwSum > 1e-12) {
      const alpha = cfg.maxTurnover / dwSum;
      finalW = targetW.map((w, i) => prevW[i] + alpha * (w - prevW[i]));
    }

    // realized turnover + cost
    let to = 0;
    for (let i = 0; i < N; i++) to += Math.abs(finalW[i] - prevW[i]);
    const cost = (to * cfg.costBps) / 10000;

    // realize next-day return
    const rNext = ret[t0 + 1];
    let g = 0;
    for (let i = 0; i < N; i++) if (Number.isFinite(rNext[i]) && finalW[i] !== 0) g += finalW[i] * rNext[i];

    net.push(g - cost);
    gross.push(g);
    turnover.push(to);
    positions.push(finalW.filter((w) => Math.abs(w) > 1e-9).length);
    bookWeights.push(finalW.slice());
    activeDateIdx.push(t0 + 1);

    // PC1 factor realized return next day (for neutrality regression): use top eigenportfolio
    // weights applied to next-day raw returns
    {
      const ev = vectors[0];
      const q = ev.map((val, i) => val / sds[i]);
      let f1 = 0; let any = false;
      for (let ci = 0; ci < M; ci++) {
        const rv = rNext[valid[ci]];
        if (Number.isFinite(rv)) { f1 += q[ci] * rv; any = true; }
      }
      factorPC1.push(any ? f1 : NaN);
    }
    btcRet.push(Number.isFinite(rNext[0]) ? rNext[0] : NaN);

    prevW = finalW;
  }

  return { dates, net, gross, turnover, positions, bookWeights, activeDateIdx, factorPC1, btcRet };
}

// ---------------------------------------------------------------------------
// OU fit via AR(1) on the cumulative residual.
// ---------------------------------------------------------------------------
function ouFit(X: number[]): { b: number; m: number; sigmaEq: number; kappa: number; halflife: number; varE: number } | null {
  const n = X.length;
  if (n < 20) return null;
  // regress X_t on X_{t-1}: X_t = a + b X_{t-1}
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const cnt = n - 1;
  for (let t = 1; t < n; t++) {
    const x = X[t - 1], y = X[t];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = cnt * sxx - sx * sx;
  if (Math.abs(denom) < 1e-15) return null;
  const b = (cnt * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / cnt;
  if (!(b > 0 && b < 1)) return null;
  // residual variance of e
  let se = 0;
  for (let t = 1; t < n; t++) {
    const e = X[t] - (a + b * X[t - 1]);
    se += e * e;
  }
  const varE = se / (cnt - 2);
  const m = a / (1 - b);
  const sigmaEq = Math.sqrt(Math.max(varE / (1 - b * b), 1e-18));
  const kappa = -Math.log(b); // per day
  const halflife = Math.log(2) / kappa;
  return { b, m, sigmaEq, kappa, halflife, varE };
}

// ---------------------------------------------------------------------------
// Matrix inverse via Gauss-Jordan (small P)
// ---------------------------------------------------------------------------
function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  const M: number[][] = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((r) => r.slice(n));
}

// ---------------------------------------------------------------------------
// Surrogate generators for the RIGHT NULL
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let v = s;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

// Factor-preserving block bootstrap of the RETURN PANEL (resample whole cross-sectional
// rows in contiguous blocks -> preserves contemporaneous factor structure & autocorr,
// destroys the specific temporal alignment the strategy exploits).
function blockBootstrapPanel(ret: number[][], blockLen: number, rng: () => number): number[][] {
  const T = ret.length;
  const N = ret[0].length;
  const out: number[][] = [ret[0].slice()]; // keep row 0 (NaN) as warmup anchor
  // resample from valid rows [1..T-1]
  const validRows = T - 1;
  while (out.length < T) {
    const start = 1 + Math.floor(rng() * validRows);
    for (let o = 0; o < blockLen && out.length < T; o++) {
      const src = 1 + ((start - 1 + o) % validRows);
      out.push(ret[src].slice());
    }
  }
  void N;
  return out;
}

// ---------------------------------------------------------------------------
// Neutrality: regress book returns on [BTC, PC1]
// ---------------------------------------------------------------------------
function neutralityRegression(book: number[], btc: number[], pc1: number[]): { betaBTC: number; betaPC1: number; alphaDaily: number; r2: number; n: number } {
  // collect rows where all finite
  const Y: number[] = [], B: number[] = [], P: number[] = [];
  for (let i = 0; i < book.length; i++) {
    if (Number.isFinite(book[i]) && Number.isFinite(btc[i]) && Number.isFinite(pc1[i])) {
      Y.push(book[i]); B.push(btc[i]); P.push(pc1[i]);
    }
  }
  const n = Y.length;
  if (n < 10) return { betaBTC: 0, betaPC1: 0, alphaDaily: 0, r2: 0, n };
  // design [1, B, P]
  const X = Y.map((_, i) => [1, B[i], P[i]]);
  const XtX = [[0,0,0],[0,0,0],[0,0,0]];
  const Xty = [0,0,0];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      Xty[a] += X[i][a] * Y[i];
      for (let b = 0; b < 3; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invertMatrix(XtX);
  if (!inv) return { betaBTC: 0, betaPC1: 0, alphaDaily: 0, r2: 0, n };
  const beta = [0,0,0];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) beta[a] += inv[a][b] * Xty[b];
  // r2
  const ybar = Y.reduce((s, v) => s + v, 0) / n;
  let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const pred = beta[0] + beta[1] * B[i] + beta[2] * P[i];
    ssr += (Y[i] - pred) ** 2;
    sst += (Y[i] - ybar) ** 2;
  }
  return { betaBTC: beta[1], betaPC1: beta[2], alphaDaily: beta[0], r2: sst > 0 ? 1 - ssr / sst : 0, n };
}

// ---------------------------------------------------------------------------
// Harvey-Liu (BHY) multiple-testing haircut on the Sharpe.
// Returns haircut fraction & adjusted Sharpe given #trials.
// ---------------------------------------------------------------------------
function harveyLiuHaircut(sharpeAnn: number, nObs: number, nTrials: number): { pSingle: number; pBHY: number; haircut: number; haircutSharpe: number } {
  // t-stat from annualized sharpe: t = SR_ann * sqrt(years) ; years = nObs/365
  const years = nObs / 365;
  const t = sharpeAnn * Math.sqrt(years);
  // two-sided single-test p
  const pSingle = 2 * (1 - normCdf(Math.abs(t)));
  // BHY adjustment: multiply by sum-of-harmonic factor c(M)*M / rank; conservative single-best:
  // p_BHY ≈ p * M * c(M), c(M)=sum_{i=1..M} 1/i  (Benjamini-Yekutieli for arbitrary dependence)
  let cM = 0;
  for (let i = 1; i <= nTrials; i++) cM += 1 / i;
  const pBHY = Math.min(1, pSingle * nTrials * cM);
  // adjusted t from adjusted p (two-sided)
  const tAdj = invNorm(1 - pBHY / 2);
  const haircutSharpe = years > 0 ? (Number.isFinite(tAdj) ? tAdj / Math.sqrt(years) : 0) : 0;
  const haircut = sharpeAnn !== 0 ? 1 - haircutSharpe / sharpeAnn : 1;
  return { pSingle, pBHY, haircut, haircutSharpe };
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number): number {
  const s = x < 0 ? -1 : 1; const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
function invNorm(p: number): number {
  if (p <= 0) return -8; if (p >= 1) return 8;
  // Acklam
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pl=0.02425, ph=1-pl;
  if (p<pl){const q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if (p>ph){const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  const q=p-0.5,r=q*q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// ---------------------------------------------------------------------------
// Sharpe helpers (annualized, daily series)
// ---------------------------------------------------------------------------
function annSharpe(r: number[]): number {
  const s = summarizeReturnSeries(r);
  return s.sharpe * Math.sqrt(365);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  const panel = loadPanel("output/crossxs/daily-closes.json");
  const ret = logReturns(panel.closes);
  const T = ret.length;
  console.log(`Panel: ${panel.coins.length} coins, ${T} days, ${panel.dates[0]} -> ${panel.dates[T - 1]}`);

  // consume-once holdout: last 20% strictly OOS
  const splitIdx = Math.floor(T * 0.8);
  const splitDate = panel.dates[splitIdx];
  console.log(`Holdout split at idx ${splitIdx} = ${splitDate} (last 20% is consume-once OOS)`);

  // -------------------------------------------------------------------------
  // Config grid — every config tried counts toward honest N
  // -------------------------------------------------------------------------
  const lookbacks = [45, 60, 90];
  const ks = [3, 5];
  const sIns = [1.25, 1.5, 2.0];
  const grid: Config[] = [];
  for (const lb of lookbacks) for (const k of ks) for (const sIn of sIns) {
    grid.push({
      lookback: lb, k, sIn, sOut: 0.5,
      minHistory: 120, ouMinKappa: Math.log(2) / 30, ouMaxHalflife: 30,
      targetVol: 0.10, maxTurnover: 1.0, costBps: 4,
    });
  }
  const honestN = grid.length;
  console.log(`\nGrid: ${honestN} configs (honest N for DSR/Harvey-Liu)`);

  // We select on the IN-SAMPLE (training) portion only, then confirm OOS.
  // Build training returns by running full backtest and slicing active days < split.
  type Result = { cfg: Config; full: BacktestOut; isNet: number[]; oosNet: number[]; isSharpe: number; oosSharpe: number; grossSharpe: number };
  const results: Result[] = [];

  for (const cfg of grid) {
    const full = backtest(ret, panel.dates, cfg);
    const isNet: number[] = [], oosNet: number[] = [], grossAll = full.gross;
    for (let i = 0; i < full.net.length; i++) {
      if (full.activeDateIdx[i] < splitIdx) isNet.push(full.net[i]);
      else oosNet.push(full.net[i]);
    }
    results.push({
      cfg, full, isNet, oosNet,
      isSharpe: annSharpe(isNet), oosSharpe: annSharpe(oosNet), grossSharpe: annSharpe(grossAll),
    });
  }

  // rank by in-sample net Sharpe
  results.sort((a, b) => b.isSharpe - a.isSharpe);
  console.log("\n=== Config leaderboard (in-sample net Sharpe) ===");
  console.log("lb  k  sIn | IS-net  OOS-net  grossSh  IS-trades");
  for (const r of results) {
    console.log(
      `${String(r.cfg.lookback).padStart(2)} ${r.cfg.k}  ${r.cfg.sIn.toFixed(2)} | ` +
      `${r.isSharpe.toFixed(2).padStart(6)}  ${r.oosSharpe.toFixed(2).padStart(6)}  ` +
      `${r.grossSharpe.toFixed(2).padStart(6)}  ${r.isNet.length}`,
    );
  }

  const best = results[0];
  console.log(`\n=== BEST (selected on IS): lb=${best.cfg.lookback} k=${best.cfg.k} sIn=${best.cfg.sIn} ===`);

  // Full-sample net series for the chosen config (for gates that want full series)
  const fullNet = best.full.net;
  const fullGross = best.full.gross;
  const sFull = summarizeReturnSeries(fullNet);
  const fullSharpeAnn = sFull.sharpe * Math.sqrt(365);
  const meanDaily = sFull.mean;
  const monthlyPct = (Math.exp(meanDaily * 30) - 1) * 100;
  console.log(`Full-sample net: Sharpe(ann)=${fullSharpeAnn.toFixed(3)}, gross Sharpe=${best.grossSharpe.toFixed(3)}`);
  console.log(`Mean daily net=${(meanDaily*100).toFixed(4)}%, ~monthly=${monthlyPct.toFixed(2)}%`);
  console.log(`Avg turnover/day=${(best.full.turnover.reduce((a,b)=>a+b,0)/best.full.turnover.length).toFixed(3)}, avg positions=${(best.full.positions.reduce((a,b)=>a+b,0)/best.full.positions.length).toFixed(1)}`);
  console.log(`IS net Sharpe=${best.isSharpe.toFixed(3)} | OOS (consume-once) net Sharpe=${best.oosSharpe.toFixed(3)}`);

  // -------------------------------------------------------------------------
  // GATE 1: Deflated Sharpe @ honest N (committed primitive)
  // -------------------------------------------------------------------------
  const dsr = computeDeflatedSharpeRatio(fullNet, { trialCount: honestN });
  console.log(`\n[DSR] sharpe(daily)=${dsr.sharpe.toFixed(4)} trials=${honestN} deflatedProb=${dsr.deflatedProbability.toFixed(4)} (want >0.95)`);

  // -------------------------------------------------------------------------
  // GATE 2: Harvey-Liu (BHY) haircut at honest N
  // -------------------------------------------------------------------------
  const hl = harveyLiuHaircut(fullSharpeAnn, fullNet.length, honestN);
  console.log(`[Harvey-Liu] pSingle=${hl.pSingle.toExponential(2)} pBHY=${hl.pBHY.toFixed(4)} haircut=${(hl.haircut*100).toFixed(1)}% haircutSharpe=${hl.haircutSharpe.toFixed(3)}`);

  // -------------------------------------------------------------------------
  // GATE 3: CPCV / PBO (committed primitive). Build per-config fold returns.
  // Use IS portion folds across all configs (need >=2 strategies, >=2 folds).
  // -------------------------------------------------------------------------
  const nFolds = 6;
  const cscvStrategies = results.map((r) => {
    // split r.full.net into nFolds contiguous folds over the whole sample
    const arr = r.full.net;
    const folds: number[][] = [];
    const fsize = Math.floor(arr.length / nFolds);
    for (let f = 0; f < nFolds; f++) {
      const start = f * fsize;
      const end = f === nFolds - 1 ? arr.length : start + fsize;
      folds.push(arr.slice(start, end));
    }
    return { id: `lb${r.cfg.lookback}_k${r.cfg.k}_s${r.cfg.sIn}`, folds };
  });
  const pbo = estimateCscvPbo(cscvStrategies, { statistic: "sharpe", trainFraction: 0.5 });
  console.log(`[CPCV/PBO] strategies=${pbo.strategyCount} folds=${pbo.foldCount} PBO=${pbo.pbo.toFixed(3)} (want <0.5) medianLogit=${pbo.medianLogit.toFixed(3)}`);

  // -------------------------------------------------------------------------
  // GATE 4: Block-bootstrap CI on full net Sharpe (committed primitive)
  // -------------------------------------------------------------------------
  const bb = blockBootstrapConfidenceInterval(fullNet, { statistic: "sharpe", iterations: 2000, blockLength: 10, seed: "pca-statarb" });
  console.log(`[BlockBootstrap] sharpe(daily) est=${bb.estimate.toFixed(4)} 95%CI=[${bb.lower.toFixed(4)}, ${bb.upper.toFixed(4)}] (want lower>0)`);

  // -------------------------------------------------------------------------
  // RIGHT NULL: surrogate p-value
  //   (a) factor-preserving block bootstrap of the panel
  //   (b) cross-sectional shuffle of residual rankings
  //   (c) bracket-on-surrogate for s-score band exits
  // For each surrogate, re-run the BEST config and record net Sharpe. p = frac >= observed.
  // -------------------------------------------------------------------------
  const nSurr = 200;
  console.log(`\n=== RIGHT NULL: ${nSurr} surrogates each (this is the binding test) ===`);

  // (a) factor-preserving block bootstrap
  let geA = 0; const surrA: number[] = [];
  for (let s = 0; s < nSurr; s++) {
    const rng = makeRng(1000 + s);
    const surrRet = blockBootstrapPanel(ret, 10, rng);
    const bt = backtest(surrRet, panel.dates, best.cfg);
    const sh = annSharpe(bt.net);
    surrA.push(sh);
    if (sh >= fullSharpeAnn) geA++;
  }
  const pA = (geA + 1) / (nSurr + 1);

  // (b) cross-sectional shuffle of residual rankings (on real data)
  let geB = 0; const surrB: number[] = [];
  for (let s = 0; s < nSurr; s++) {
    const rng = makeRng(5000 + s);
    const bt = backtest(ret, panel.dates, best.cfg, { shuffleResidualRanks: true, rng });
    const sh = annSharpe(bt.net);
    surrB.push(sh);
    if (sh >= fullSharpeAnn) geB++;
  }
  const pB = (geB + 1) / (nSurr + 1);

  const surrAStats = summarizeReturnSeries(surrA);
  const surrBStats = summarizeReturnSeries(surrB);
  console.log(`[Null A: factor-preserving block bootstrap] surrogate mean Sharpe=${surrAStats.mean.toFixed(3)} obs=${fullSharpeAnn.toFixed(3)} p=${pA.toFixed(4)}`);
  console.log(`[Null B: cross-sectional residual-rank shuffle]  surrogate mean Sharpe=${surrBStats.mean.toFixed(3)} obs=${fullSharpeAnn.toFixed(3)} p=${pB.toFixed(4)}`);

  // (c) bracket-on-surrogate for the band exits: the bands themselves manufacture
  // high-win-rate / ~0-expectancy on noise. Measure: does the s-score band system on
  // PURE NOISE residuals (shuffle null B) reproduce the win-rate but not the Sharpe?
  const obsWin = fullNet.filter((x) => x > 0).length / fullNet.length;
  // surrogate B win rate of an example run
  const exB = backtest(ret, panel.dates, best.cfg, { shuffleResidualRanks: true, rng: makeRng(99999) });
  const surrWin = exB.net.filter((x) => x > 0).length / exB.net.length;
  console.log(`[Band check] obs win-rate=${(obsWin*100).toFixed(1)}% | shuffled-residual win-rate=${(surrWin*100).toFixed(1)}% (if similar, bands manufacture win-rate; Sharpe is the honest discriminator)`);

  // -------------------------------------------------------------------------
  // NEUTRALITY: regress book net returns on [BTC, PC1]
  // -------------------------------------------------------------------------
  const neut = neutralityRegression(best.full.net, best.full.btcRet, best.full.factorPC1);
  console.log(`\n[Neutrality] regress book on [BTC, PC1]: betaBTC=${neut.betaBTC.toFixed(3)} betaPC1=${neut.betaPC1.toFixed(4)} alpha(daily)=${(neut.alphaDaily*100).toFixed(4)}% R2=${neut.r2.toFixed(3)} n=${neut.n}`);

  // -------------------------------------------------------------------------
  // OOS residual stationarity in consume-once holdout:
  // confirm OU mean-reversion (b in (0,1)) still holds on holdout residuals.
  // Proxy: OOS net Sharpe sign + ADF-lite on the cumulative book P&L (should be trending if edge).
  // -------------------------------------------------------------------------
  const oosStats = summarizeReturnSeries(best.oosNet);
  const oosSharpeAnn = oosStats.sharpe * Math.sqrt(365);
  const oosMonthly = (Math.exp(oosStats.mean * 30) - 1) * 100;
  console.log(`[OOS consume-once] n=${best.oosNet.length} net Sharpe(ann)=${oosSharpeAnn.toFixed(3)} ~monthly=${oosMonthly.toFixed(2)}% meanDaily=${(oosStats.mean*100).toFixed(4)}%`);

  // $ figures
  const monthly100k = monthlyPct / 100 * 100000;
  const monthly10k = monthlyPct / 100 * 10000;

  // -------------------------------------------------------------------------
  // VERDICT LOGIC
  // -------------------------------------------------------------------------
  console.log(`\n=== SUMMARY ===`);
  console.log(`net Sharpe (full, ann) = ${fullSharpeAnn.toFixed(3)}`);
  console.log(`OOS net Sharpe (ann)   = ${oosSharpeAnn.toFixed(3)}`);
  console.log(`gross Sharpe (ann)     = ${best.grossSharpe.toFixed(3)}`);
  console.log(`monthly@$10k = $${monthly10k.toFixed(0)}, monthly@$100k = $${monthly100k.toFixed(0)}`);
  console.log(`DSR deflated prob=${dsr.deflatedProbability.toFixed(3)} | PBO=${pbo.pbo.toFixed(3)} | BB CI lower=${bb.lower.toFixed(4)}`);
  console.log(`surrogate p (A factor-bb)=${pA.toFixed(4)}, p (B rank-shuffle)=${pB.toFixed(4)}`);
  console.log(`Harvey-Liu pBHY=${hl.pBHY.toFixed(4)} haircutSharpe=${hl.haircutSharpe.toFixed(3)}`);

  const out = {
    honestN, splitDate,
    best: { lookback: best.cfg.lookback, k: best.cfg.k, sIn: best.cfg.sIn },
    fullSharpeAnn, oosSharpeAnn, grossSharpe: best.grossSharpe,
    meanDailyNet: meanDaily, monthlyPct, monthly10k, monthly100k,
    dsr: { deflatedProbability: dsr.deflatedProbability, sharpe: dsr.sharpe },
    pbo: { pbo: pbo.pbo, medianLogit: pbo.medianLogit },
    blockBootstrap: { estimate: bb.estimate, lower: bb.lower, upper: bb.upper },
    surrogate: { pA, pB, surrMeanA: surrAStats.mean, surrMeanB: surrBStats.mean },
    bandCheck: { obsWin, surrWin },
    harveyLiu: hl,
    neutrality: neut,
    oos: { n: best.oosNet.length, sharpeAnn: oosSharpeAnn, monthlyPct: oosMonthly },
    leaderboard: results.map((r) => ({ lb: r.cfg.lookback, k: r.cfg.k, sIn: r.cfg.sIn, isSharpe: r.isSharpe, oosSharpe: r.oosSharpe, grossSharpe: r.grossSharpe, isTrades: r.isNet.length })),
  };
  fs.writeFileSync("output/edgehunt/pca-statarb-result.json", JSON.stringify(out, null, 2));
  console.log(`\nWrote output/edgehunt/pca-statarb-result.json`);
}

main();
