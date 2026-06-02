/** Load BTC OHLCV and aggregate to a target bar size. $0 on-disk reuse. */
import fs from "node:fs";

const ROOT = ".";

export interface Bars {
  t: number[]; // epoch ms (bar open)
  close: number[];
  ret: number[]; // log return close[t-1]->close[t]; ret[0]=NaN
}

interface Row {
  event_time: string;
  close: number;
}

/** Aggregate 15m bars into bars of `mult` 15m-bars each (e.g. mult=16 => 4h, mult=96 => daily). */
export function loadBtc(mult: number): Bars {
  const raw = fs.readFileSync(`${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`, "utf8");
  const lines = raw.split("\n");
  const closes: number[] = [];
  const times: number[] = [];
  let count = 0;
  let lastClose = NaN;
  let bucketTime = 0;
  for (const ln of lines) {
    if (!ln) continue;
    let r: Row;
    try {
      r = JSON.parse(ln);
    } catch {
      continue;
    }
    if (!(r.close > 0)) continue;
    if (count === 0) bucketTime = Date.parse(r.event_time);
    lastClose = r.close;
    count++;
    if (count === mult) {
      times.push(bucketTime);
      closes.push(lastClose);
      count = 0;
    }
  }
  const ret: number[] = new Array(closes.length).fill(NaN);
  for (let i = 1; i < closes.length; i++) ret[i] = Math.log(closes[i] / closes[i - 1]);
  return { t: times, close: closes, ret };
}
