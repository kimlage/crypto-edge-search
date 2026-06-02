/**
 * O1-ADRACT exploratory probe (NO holdout consumed).
 *
 * Question: does LAGGED network-activity momentum (AdrActCnt / TxCnt growth) predict NEXT-day BTC/ETH
 * returns as a TIMER — beyond price momentum (reverse-causality echo) and beyond buy&hold?
 *
 * This probe only inspects in-sample correlations / IC and the price-momentum confound. It does NOT
 * touch the consume-once holdout; that is reserved for the committed gauntlet run.
 */
import fs from "node:fs";

const ROOT = ".";

interface Row {
  date: string;
  price: number;
  adr: number;
  tx: number;
}

function loadNet(asset: "btc" | "eth"): Row[] {
  // network activity (AdrActCnt, TxCnt) from the free fetch
  const net = JSON.parse(
    fs.readFileSync(`${ROOT}/output/edgehunt-onchain2/cm_txcnt_${asset}.json`, "utf8"),
  ).data as { time: string; AdrActCnt: string | null; TxCnt: string | null }[];
  const netMap = new Map<string, { adr: number; tx: number }>();
  for (const r of net) {
    const d = r.time.slice(0, 10);
    netMap.set(d, {
      adr: r.AdrActCnt != null ? Number(r.AdrActCnt) : NaN,
      tx: r.TxCnt != null ? Number(r.TxCnt) : NaN,
    });
  }
  // price from POC (2015+) falling back to cm_extra
  const poc = JSON.parse(fs.readFileSync(`${ROOT}/output/onchain-poc/cm_${asset}.json`, "utf8"))
    .data as { time: string; PriceUSD: string | null }[];
  const priceMap = new Map<string, number>();
  for (const r of poc) {
    const d = r.time.slice(0, 10);
    if (r.PriceUSD != null) priceMap.set(d, Number(r.PriceUSD));
  }
  const extra = JSON.parse(
    fs.readFileSync(`${ROOT}/output/edgehunt-D5/cm_extra_${asset}.json`, "utf8"),
  ).data as { time: string; PriceUSD: string | null }[];
  for (const r of extra) {
    const d = r.time.slice(0, 10);
    if (!priceMap.has(d) && r.PriceUSD != null) priceMap.set(d, Number(r.PriceUSD));
  }
  const dates = [...priceMap.keys()].filter((d) => netMap.has(d)).sort();
  const rows: Row[] = [];
  for (const d of dates) {
    const p = priceMap.get(d)!;
    const n = netMap.get(d)!;
    if (p > 0 && n.adr > 0) rows.push({ date: d, price: p, adr: n.adr, tx: n.tx });
  }
  return rows;
}

function ema(x: number[], span: number): number[] {
  const a = 2 / (span + 1);
  const out = new Array(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    prev = Number.isFinite(prev) ? a * v + (1 - a) * prev : v;
    out[i] = prev;
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < a.length; i++)
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  const n = xs.length;
  if (n < 30) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function main() {
  for (const asset of ["btc", "eth"] as const) {
    const rows = loadNet(asset);
    const T = rows.length;
    const price = rows.map((r) => r.price);
    const adr = rows.map((r) => r.adr);
    const tx = rows.map((r) => r.tx);
    const logRet = new Array(T).fill(NaN);
    for (let t = 1; t < T; t++) logRet[t] = Math.log(price[t] / price[t - 1]);
    const fwdRet = new Array(T).fill(NaN);
    for (let t = 0; t < T - 1; t++) fwdRet[t] = Math.log(price[t + 1] / price[t]);

    // network-activity composite (log, smoothed) — average of log AdrActCnt and log TxCnt z-paths
    const logAdr = adr.map((v) => (v > 0 ? Math.log(v) : NaN));
    const logTx = tx.map((v) => (v > 0 ? Math.log(v) : NaN));

    // momentum = fast EMA - slow EMA of the log activity (network-growth momentum)
    function mom(logx: number[], fast: number, slow: number): number[] {
      const ef = ema(logx, fast);
      const es = ema(logx, slow);
      return ef.map((v, i) => v - es[i]);
    }
    // price momentum at the SAME spans (the reverse-causality confound)
    const logPrice = price.map((p) => Math.log(p));

    console.log(`\n=== ${asset.toUpperCase()} (T=${T}, ${rows[0].date}..${rows[T - 1].date}) ===`);
    for (const [fast, slow] of [
      [7, 30],
      [14, 60],
      [30, 90],
      [30, 180],
    ]) {
      const adrMom = mom(logAdr, fast, slow);
      const txMom = mom(logTx, fast, slow);
      const priceMom = mom(logPrice, fast, slow);
      // LAG the on-chain momentum by 1 (causal)
      const adrMomL = [NaN, ...adrMom.slice(0, -1)];
      const txMomL = [NaN, ...txMom.slice(0, -1)];
      const priceMomL = [NaN, ...priceMom.slice(0, -1)];
      const icAdr = pearson(adrMomL, fwdRet);
      const icTx = pearson(txMomL, fwdRet);
      const icPrice = pearson(priceMomL, fwdRet);
      // how much of network momentum is just price momentum?
      const corrAdrPrice = pearson(adrMomL, priceMomL);
      console.log(
        `  span ${fast}/${slow}: IC(adrMom)=${fmt(icAdr)} IC(txMom)=${fmt(icTx)} IC(priceMom)=${fmt(icPrice)} | corr(adrMom,priceMom)=${fmt(corrAdrPrice)}`,
      );
    }
  }
}
function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : "  n/a ";
}
main();
