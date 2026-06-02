/**
 * O1-ADRACT strengthening — genuinely try to extract an adoption-LEADS-price edge before judging.
 *
 * The probe showed network-activity momentum is ~0.55-0.73 correlated with PRICE momentum (the
 * documented reverse-causality echo). After orthogonalizing to price momentum the residual IC
 * collapses to ~0.01-0.02. So the strongest honest version of the hypothesis is the ORTHOGONALIZED
 * network-momentum timer: the part of on-chain activity growth that is NOT explained by recent
 * price momentum. If adoption truly leads price, THAT residual should still time forward returns.
 *
 * We test, with honest N counting every config:
 *   (A) raw network-momentum timer (echo-laden) — for reference,
 *   (B) price-momentum-orthogonalized network-momentum timer (the clean adoption signal),
 * each with a strict EXPANDING (causal, no-lookahead) orthogonalization, LAG>=1, rolling-Z gate.
 *
 * Decisive judgments (per config): IS net Sharpe, phase-rand surrogate p, AR(5)-matched placebo p,
 * consume-once holdout Sharpe, and vs B&H. Robust = clears BOTH nulls AND holds OOS AND beats B&H.
 * If the orthogonalized (adoption-only) signal cannot do that, the echo IS the signal -> KILL.
 */
import fs from "node:fs";
import {
  type Panel,
  runPositions,
  sharpeDaily,
  annSharpe,
  mkRng,
  mean,
  rollingZ,
  ema,
} from "../edgehunt-D5/harness.ts";
import { phaseRandomize } from "../edgehunt-D5/lib_signal.ts";

const ROOT = ".";
const OUT = `${ROOT}/output/edgehunt-onchain2`;
const LAG = 1;

interface NetPanel extends Panel {
  tx: number[];
}
function loadNetPanel(asset: "btc" | "eth"): NetPanel {
  const net = JSON.parse(fs.readFileSync(`${OUT}/cm_txcnt_${asset}.json`, "utf8")).data as {
    time: string;
    AdrActCnt: string | null;
    TxCnt: string | null;
  }[];
  const nm = new Map<string, { adr: number; tx: number }>();
  for (const r of net) {
    const d = r.time.slice(0, 10);
    nm.set(d, { adr: r.AdrActCnt != null ? +r.AdrActCnt : NaN, tx: r.TxCnt != null ? +r.TxCnt : NaN });
  }
  const poc = JSON.parse(fs.readFileSync(`${ROOT}/output/onchain-poc/cm_${asset}.json`, "utf8"))
    .data as { time: string; PriceUSD: string | null }[];
  const pm = new Map<string, number>();
  for (const r of poc) if (r.PriceUSD != null) pm.set(r.time.slice(0, 10), +r.PriceUSD);
  const extra = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_${asset}.json`, "utf8"))
    .data as { time: string; PriceUSD: string | null }[];
  for (const r of extra) {
    const d = r.time.slice(0, 10);
    if (!pm.has(d) && r.PriceUSD != null) pm.set(d, +r.PriceUSD);
  }
  const dates = [...pm.keys()].filter((d) => nm.has(d)).sort();
  const P: NetPanel = {
    asset, dates: [], price: [], mvrv: [], flowInNtv: [], flowOutNtv: [], adr: [], tx: [],
    marketCap: [], hashRate: [], supply: [], realizedCap: [], realizedPrice: [], fwdRet: [],
  };
  for (const d of dates) {
    const p = pm.get(d)!;
    const n = nm.get(d)!;
    if (!(p > 0) || !(n.adr > 0)) continue;
    P.dates.push(d); P.price.push(p); P.adr.push(n.adr); P.tx.push(n.tx);
    P.mvrv.push(NaN); P.flowInNtv.push(NaN); P.flowOutNtv.push(NaN);
    P.marketCap.push(NaN); P.hashRate.push(NaN); P.supply.push(NaN);
    P.realizedCap.push(NaN); P.realizedPrice.push(NaN);
  }
  const T = P.price.length;
  for (let t = 0; t < T; t++) P.fwdRet.push(t + 1 < T ? Math.log(P.price[t + 1] / P.price[t]) : NaN);
  return P;
}
function lagArr(x: number[], k: number) {
  const o = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) o[i] = x[i - k];
  return o;
}
function momOf(logx: number[], fast: number, slow: number) {
  const ef = ema(logx, fast), es = ema(logx, slow);
  return ef.map((v, i) => v - es[i]);
}
// EXPANDING (causal) orthogonalization of `a` against `b`: at each t, regress a~b using data up to
// t-1 only, residual_t = a_t - (alpha_{t-1} + beta_{t-1} b_t). Strictly no-lookahead.
function expandingOrthog(a: number[], b: number[], minObs: number): number[] {
  const T = a.length;
  const out = new Array(T).fill(NaN);
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < T; t++) {
    if (n >= minObs && Number.isFinite(a[t]) && Number.isFinite(b[t])) {
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9) {
        const beta = (n * sxy - sx * sy) / denom;
        const alpha = (sy - beta * sx) / n;
        out[t] = a[t] - (alpha + beta * b[t]);
      }
    }
    if (Number.isFinite(a[t]) && Number.isFinite(b[t])) {
      n++; sx += b[t]; sy += a[t]; sxx += b[t] * b[t]; sxy += b[t] * a[t];
    }
  }
  return out;
}

type Cfg = { fast: number; slow: number; zwin: number; thr: number; side: "longflat" | "longshort" | "tilt"; orth: boolean };

function signalFor(P: NetPanel, cfg: Cfg): number[] {
  const logAdr = P.adr.map((v) => (v > 0 ? Math.log(v) : NaN));
  const logTx = P.tx.map((v) => (v > 0 ? Math.log(v) : NaN));
  const logP = P.price.map((p) => Math.log(p));
  const am = momOf(logAdr, cfg.fast, cfg.slow);
  const tm = momOf(logTx, cfg.fast, cfg.slow);
  const comp = am.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(tm[i]) ? (v + tm[i]) / 2 : Number.isFinite(v) ? v : tm[i],
  );
  let sig = comp;
  if (cfg.orth) {
    const pm = momOf(logP, cfg.fast, cfg.slow);
    sig = expandingOrthog(comp, pm, 365); // remove price-momentum component, causally
  }
  return lagArr(sig, LAG);
}
function posFromSignal(P: NetPanel, sig: number[], cfg: Cfg): number[] {
  const z = rollingZ(sig, cfg.zwin);
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    if (cfg.side === "tilt") pos[t] = z[t] <= -cfg.thr ? 0 : 1;
    else if (z[t] >= cfg.thr) pos[t] = 1;
    else if (z[t] <= -cfg.thr) pos[t] = cfg.side === "longshort" ? -1 : 0;
    else pos[t] = 0;
  }
  return pos;
}

// AR(p) fit + surrogate (Levinson-Durbin Yule-Walker)
function arFit(x: number[], p: number) {
  const v = x.filter((q) => Number.isFinite(q));
  const n = v.length;
  const mu = v.reduce((s, q) => s + q, 0) / n;
  const c = (k: number) => {
    let s = 0;
    for (let i = k; i < n; i++) s += (v[i] - mu) * (v[i - k] - mu);
    return s / n;
  };
  const r = Array.from({ length: p + 1 }, (_, k) => c(k));
  const phi = new Array(p).fill(0);
  let e = r[0];
  for (let i = 0; i < p; i++) {
    let acc = r[i + 1];
    for (let j = 0; j < i; j++) acc -= phi[j] * r[i - j];
    const k = e > 1e-12 ? acc / e : 0;
    const prev = phi.slice(0, i);
    phi[i] = k;
    for (let j = 0; j < i; j++) phi[j] = prev[j] - k * prev[i - 1 - j];
    e *= 1 - k * k;
  }
  return { phi, mu, sigma: Math.sqrt(Math.max(0, e)) };
}
function arSurr(x: number[], fit: { phi: number[]; mu: number; sigma: number }, rng: () => number) {
  const p = fit.phi.length, T = x.length;
  const out = new Array(T).fill(NaN);
  const buf: number[] = [];
  for (let t = 0; t < T; t++) {
    if (!Number.isFinite(x[t])) { out[t] = NaN; continue; }
    let val: number;
    if (buf.length < p) val = x[t] - fit.mu;
    else {
      let pred = 0;
      for (let j = 0; j < p; j++) pred += fit.phi[j] * buf[buf.length - 1 - j];
      const u1 = Math.max(1e-12, rng()), u2 = rng();
      val = pred + fit.sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    buf.push(val);
    out[t] = val + fit.mu;
  }
  return out;
}

// STAGE 1 (cheap): IS/OOS Sharpe only, no surrogates.
function evalCheap(P: NetPanel, cfg: Cfg, startIdx: number, splitIdx: number, tradableEnd: number) {
  const sig = signalFor(P, cfg);
  const pos = posFromSignal(P, sig, cfg);
  const isR = runPositions(P, pos, startIdx, splitIdx);
  const oosR = runPositions(P, pos, splitIdx, tradableEnd);
  return {
    isSh: annSharpe(sharpeDaily(isR.dailyNet)),
    oosSh: annSharpe(sharpeDaily(oosR.dailyNet)),
    exposure: isR.exposure, turnover: isR.turnover, meanDailyNet: mean(isR.dailyNet), sig,
  };
}
// STAGE 2 (expensive): dual surrogate nulls — run only on selected candidates.
function evalNulls(P: NetPanel, cfg: Cfg, sig: number[], isSh: number, startIdx: number, splitIdx: number, nSurr = 200) {
  const ph: number[] = [], ar: number[] = [];
  const fit = arFit(sig, 5);
  for (let i = 0; i < nSurr; i++) {
    const r1 = mkRng(15000 + i * 7919);
    ph.push(annSharpe(sharpeDaily(runPositions(P, posFromSignal(P, phaseRandomize(sig, r1), cfg), startIdx, splitIdx).dailyNet)));
    const r2 = mkRng(45000 + i * 7919);
    ar.push(annSharpe(sharpeDaily(runPositions(P, posFromSignal(P, arSurr(sig, fit, r2), cfg), startIdx, splitIdx).dailyNet)));
  }
  return {
    phP: (ph.filter((s) => s >= isSh).length + 1) / (nSurr + 1),
    arP: (ar.filter((s) => s >= isSh).length + 1) / (nSurr + 1),
  };
}

function makeGrid(orthVals: boolean[]): Cfg[] {
  const fasts = [7, 14, 30], slows = [30, 60, 90, 180], zwins = [180, 365, 730], thrs = [0, 0.5, 1.0];
  const sides: Cfg["side"][] = ["longflat", "longshort", "tilt"];
  const g: Cfg[] = [];
  for (const orth of orthVals)
    for (const fast of fasts)
      for (const slow of slows) {
        if (slow <= fast) continue;
        for (const zwin of zwins) for (const thr of thrs) for (const side of sides) g.push({ fast, slow, zwin, thr, side, orth });
      }
  return g;
}

function main() {
  for (const asset of ["btc", "eth"] as const) {
    const P = loadNetPanel(asset);
    const T = P.price.length;
    const startIdx = 500;
    const tradableEnd = T - 1;
    const span = tradableEnd - startIdx;
    const splitIdx = startIdx + Math.floor(span * 0.8);
    const bhIS = annSharpe(sharpeDaily(runPositions(P, new Array(T).fill(1), startIdx, splitIdx).dailyNet));
    const bhOOS = annSharpe(sharpeDaily(runPositions(P, new Array(T).fill(1), splitIdx, tradableEnd).dailyNet));

    // honest N spans BOTH raw and orthogonalized families (we searched both)
    const grid = makeGrid([false, true]);
    const HONEST_N = grid.length;
    // STAGE 1 — cheap pass over all configs
    const cheap = grid.map((cfg) => ({ cfg, ...evalCheap(P, cfg, startIdx, splitIdx, tradableEnd) }));
    // STAGE 2 — run dual nulls only on candidates that already (a) beat bhIS and (b) hold OOS>0,
    // plus the IS-best of each family regardless (so we always report the headline winner's nulls).
    const want = new Set<typeof cheap[number]>();
    for (const fam of [false, true]) {
      const fr = cheap.filter((r) => r.cfg.orth === fam);
      fr.sort((a, b) => b.isSh - a.isSh);
      want.add(fr[0]); // family IS-best
      for (const r of fr) if (r.isSh > bhIS && r.oosSh > 0) want.add(r);
    }
    const nullsMap = new Map<typeof cheap[number], { phP: number; arP: number }>();
    for (const r of want) nullsMap.set(r, evalNulls(P, r.cfg, r.sig, r.isSh, startIdx, splitIdx, 200));
    const rows = cheap.map((r) => ({ ...r, phP: nullsMap.get(r)?.phP ?? NaN, arP: nullsMap.get(r)?.arP ?? NaN }));

    const orthRows = rows.filter((r) => r.cfg.orth);
    const rawRows = rows.filter((r) => !r.cfg.orth);
    // robust = clears BOTH nulls (p<.05) AND holds OOS (>0) AND beats B&H IS
    const robust = (rs: typeof rows) => rs.filter((r) => r.phP < 0.05 && r.arP < 0.05 && r.oosSh > 0 && r.isSh > bhIS);

    console.log(`\n========= ${asset.toUpperCase()} | T=${T} honestN(both families)=${HONEST_N} bhIS=${bhIS.toFixed(3)} bhOOS=${bhOOS.toFixed(3)} =========`);
    const show = (tag: string, rs: typeof rows) => {
      const byIS = [...rs].sort((a, b) => b.isSh - a.isSh);
      console.log(`\n--- ${tag}: top 5 by IS net Sharpe ---`);
      for (const r of byIS.slice(0, 5)) {
        const c = r.cfg;
        const ph = Number.isFinite(r.phP) ? r.phP.toFixed(3) : " n/a ";
        const ar = Number.isFinite(r.arP) ? r.arP.toFixed(3) : " n/a ";
        console.log(`  f${c.fast}/s${c.slow}/z${c.zwin}/t${c.thr}/${c.side}  IS=${r.isSh.toFixed(3)} OOS=${r.oosSh.toFixed(3)} phP=${ph} arP=${ar} expo=${r.exposure.toFixed(2)}`);
      }
      const rob = robust(rs);
      console.log(`  robust (both nulls<.05 AND OOS>0 AND >bhIS): ${rob.length}/${rs.length}`);
      for (const r of rob.slice(0, 8)) {
        const c = r.cfg;
        console.log(`    ROBUST f${c.fast}/s${c.slow}/z${c.zwin}/t${c.thr}/${c.side} IS=${r.isSh.toFixed(3)} OOS=${r.oosSh.toFixed(3)} phP=${r.phP.toFixed(3)} arP=${r.arP.toFixed(3)} vs bhOOS=${bhOOS.toFixed(3)}`);
      }
    };
    show("RAW (echo-laden) network momentum", rawRows);
    show("ORTHOGONALIZED (adoption-only) network momentum", orthRows);

    const strip = (r: typeof rows[number]) => ({ cfg: r.cfg, isSh: r.isSh, oosSh: r.oosSh, phP: r.phP, arP: r.arP, exposure: r.exposure, turnover: r.turnover });
    fs.writeFileSync(`${OUT}/strengthen_adract_${asset}.json`, JSON.stringify({
      asset, T, honestN: HONEST_N, bhIS, bhOOS,
      rawRobust: robust(rawRows).length, orthRobust: robust(orthRows).length,
      rawTopIS: [...rawRows].sort((a, b) => b.isSh - a.isSh).slice(0, 5).map(strip),
      orthTopIS: [...orthRows].sort((a, b) => b.isSh - a.isSh).slice(0, 5).map(strip),
    }, null, 2));
  }
}
main();
