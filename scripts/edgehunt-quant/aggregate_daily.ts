/**
 * Aggregate the committed 15m BTC OHLCV ndjson (306k rows) to DAILY bars (UTC).
 * Daily is the right granularity for a TSMOM trend-strength meta-gate and keeps honest N small.
 * Writes output/edgehunt-quant/btc_daily.json: {date, open, high, low, close, volume}[].
 * $0 — reads on-disk data only.
 */
import fs from "node:fs";
import readline from "node:readline";

const ROOT = ".";
const SRC = `${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`;
const OUT = `${ROOT}/output/edgehunt-quant/btc_daily.json`;

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  n: number;
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
  const days = new Map<string, Bar>();
  let firstTimeByDay = new Map<string, string>();
  let rows = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const date = (r.event_date as string) || (r.event_time as string)?.slice(0, 10);
    if (!date) continue;
    const close = Number(r.close);
    if (!(close > 0)) continue;
    const open = Number(r.open);
    const high = Number(r.high);
    const low = Number(r.low);
    const vol = Number(r.volume) || 0;
    const et = r.event_time as string;
    rows++;
    let b = days.get(date);
    if (!b) {
      b = { date, open, high, low, close, volume: vol, n: 1 };
      days.set(date, b);
      firstTimeByDay.set(date, et);
    } else {
      // open = first bar of day; track by earliest event_time
      if (et < (firstTimeByDay.get(date) as string)) {
        firstTimeByDay.set(date, et);
        b.open = open;
      }
      b.high = Math.max(b.high, high);
      b.low = Math.min(b.low, low);
      b.close = close; // last seen (ndjson is time-ordered ascending) -> daily close
      b.volume += vol;
      b.n++;
    }
  }
  const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  // drop partial first/last day with too few 15m bars (full day = 96)
  const clean = sorted.filter((b) => b.n >= 80);
  fs.writeFileSync(OUT, JSON.stringify(clean));
  console.log(
    `rows=${rows} days=${sorted.length} clean(>=80 bars)=${clean.length} span ${clean[0].date}..${clean[clean.length - 1].date}`,
  );
}
main();
