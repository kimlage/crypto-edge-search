/**
 * Long daily PRICE panel for BTC/ETH (Mayer Multiple is a pure price transform).
 *
 * The Mayer Multiple = price / SMA200(price) needs ONLY price. Coin Metrics Community `PriceUSD`
 * is the free metric the committed POC already uses; here we union the POC price (2015->) with the
 * free `cm_extra_*` PriceUSD (2010->) to get the LONGEST honest free history (16y for BTC).
 *
 * Causality: position[t] is computed from info at close t (features LAGged >=1 day) and earns the
 * NEXT-day log return fwdRet[t] = log(price[t+1]/price[t]). fwdRet[last] = NaN.
 */
import fs from "node:fs";

const ROOT = ".";

export interface PricePanel {
  asset: string;
  dates: string[];
  price: number[];
  ret: number[]; // log return price[t-1]->price[t]; ret[0]=NaN  (for surrogate-recompute null)
  fwdRet: number[]; // log return price[t]->price[t+1]; last=NaN
}

function readPrice(file: string, field: string): Map<string, number> {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const m = new Map<string, number>();
  for (const r of j.data) {
    const d = r.time.slice(0, 10);
    const v = r[field] != null ? Number(r[field]) : NaN;
    if (v > 0) m.set(d, v);
  }
  return m;
}

export function loadPricePanel(asset: "btc" | "eth"): PricePanel {
  const poc = readPrice(`${ROOT}/output/onchain-poc/cm_${asset}.json`, "PriceUSD");
  const extra = readPrice(`${ROOT}/output/edgehunt-D5/cm_extra_${asset}.json`, "PriceUSD");
  const dates = [...new Set([...poc.keys(), ...extra.keys()])].sort();
  const P: PricePanel = { asset, dates: [], price: [], ret: [], fwdRet: [] };
  for (const d of dates) {
    // prefer extra (longer, same source) then POC; both are CM Community PriceUSD
    const px = extra.get(d) ?? poc.get(d) ?? NaN;
    if (!(px > 0)) continue;
    P.dates.push(d);
    P.price.push(px);
  }
  const T = P.price.length;
  for (let t = 0; t < T; t++) {
    P.ret.push(t > 0 ? Math.log(P.price[t] / P.price[t - 1]) : NaN);
    P.fwdRet.push(t + 1 < T ? Math.log(P.price[t + 1] / P.price[t]) : NaN);
  }
  return P;
}
