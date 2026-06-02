/**
 * O3-NVTS — loader + builder for free NVT/NVTS proxies (Coin Metrics Community).
 *
 * Classic NVT = MarketCap / TransferValueUSD. The FREE community catalog (32 metrics) does NOT
 * expose adjusted transfer value in USD (TxTfrValAdjUSD) nor NVTAdj/NVTAdj90 (paid). So we build the
 * strongest FREE proxies for the denominator (economic throughput in USD), each LAGGED >=1 day,
 * smoothed (Kalichkin NVTS = 90d MA of throughput), and z-scored on a trailing window. Strictly
 * causal: feature at close t, traded t->t+1.
 *
 * Free denominators tested (honest N counts all):
 *   - fee   : FeeTotNtv * Price            (fee revenue USD; "demand for blockspace" = real value)
 *   - tx    : TxCnt                         (transactions/day; original count-NVT)
 *   - tfr   : TxTfrCnt                      (transfers/day)
 *   - feeNtv: FeeTotNtv                     (fees in native; price-independent throughput)
 */
import fs from "node:fs";

const ROOT = ".";

export interface NvtPanel {
  asset: string;
  dates: string[];
  price: number[];
  marketCap: number[];
  txCnt: number[];
  txTfrCnt: number[];
  feeNtv: number[];
  supply: number[];
  fwdRet: number[]; // log price[t]->[t+1]; last = NaN
}

function num(v: unknown): number {
  return v != null && v !== "" ? Number(v) : NaN;
}

export function loadNvtPanel(asset: "btc" | "eth"): NvtPanel {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/edgehunt-onchain2/cm_tx_${asset}.json`, "utf8"));
  const rows = j.data
    .map((r: Record<string, unknown>) => ({
      d: (r.time as string).slice(0, 10),
      price: num(r.PriceUSD),
      mc: num(r.CapMrktCurUSD),
      tx: num(r.TxCnt),
      tfr: num(r.TxTfrCnt),
      fee: num(r.FeeTotNtv),
      sply: num(r.SplyCur),
    }))
    .filter((r: { price: number }) => r.price > 0)
    .sort((a: { d: string }, b: { d: string }) => (a.d < b.d ? -1 : 1));

  const P: NvtPanel = {
    asset,
    dates: rows.map((r: { d: string }) => r.d),
    price: rows.map((r: { price: number }) => r.price),
    marketCap: rows.map((r: { mc: number }) => r.mc),
    txCnt: rows.map((r: { tx: number }) => r.tx),
    txTfrCnt: rows.map((r: { tfr: number }) => r.tfr),
    feeNtv: rows.map((r: { fee: number }) => r.fee),
    supply: rows.map((r: { sply: number }) => r.sply),
    fwdRet: [],
  };
  const T = P.price.length;
  for (let t = 0; t < T; t++) P.fwdRet.push(t + 1 < T ? Math.log(P.price[t + 1] / P.price[t]) : NaN);
  return P;
}

// throughput-in-USD proxy for the NVT denominator
export function throughput(P: NvtPanel, kind: string): number[] {
  const T = P.price.length;
  const out = new Array(T).fill(NaN);
  for (let t = 0; t < T; t++) {
    let v = NaN;
    if (kind === "fee") v = P.feeNtv[t] > 0 && P.price[t] > 0 ? P.feeNtv[t] * P.price[t] : NaN;
    else if (kind === "feeNtv") v = P.feeNtv[t] > 0 ? P.feeNtv[t] : NaN;
    else if (kind === "tx") v = P.txCnt[t] > 0 ? P.txCnt[t] : NaN;
    else if (kind === "tfr") v = P.txTfrCnt[t] > 0 ? P.txTfrCnt[t] : NaN;
    out[t] = v;
  }
  return out;
}
