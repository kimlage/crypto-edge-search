/**
 * D3-A3 step 1: aggregate output/bigquery/btc_ohlcv_15m.ndjson (306k rows, 15m)
 * to DAILY bars + realized variance, cached to output/edgehunt-D348/btc_daily.json.
 * Aggregate, do NOT stream raw repeatedly. Realized variance = sum of squared 15m
 * log-returns within the UTC day (Andersen-Bollerslev-Diebold-Labys realized vol).
 *
 * Run: PATH=.../node/bin:$PATH ./node_modules/.bin/tsx scripts/edgehunt-D348/a3-aggregate.ts
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ROOT = path.resolve(process.cwd());
const SRC = path.join(ROOT, "output/bigquery/btc_ohlcv_15m.ndjson");
const OUT = path.join(ROOT, "output/edgehunt-D348");
fs.mkdirSync(OUT, { recursive: true });

interface DayAgg {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  prevClose: number | null;
  rv: number; // realized variance from 15m intraday log-returns (within day)
  n15: number; // number of 15m bars
}

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(SRC),
    crlfDelay: Infinity,
  });
  const days = new Map<string, DayAgg>();
  let lastClosePrice: number | null = null;
  let prevBarClose: number | null = null; // for intraday rv we use consecutive 15m closes within same day
  let prevBarDate: string | null = null;
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line) as {
      event_date: string;
      open: number;
      high: number;
      low: number;
      close: number;
    };
    const d = r.event_date;
    let agg = days.get(d);
    if (!agg) {
      agg = {
        date: d,
        open: r.open,
        close: r.close,
        high: r.high,
        low: r.low,
        prevClose: null,
        rv: 0,
        n15: 0,
      };
      days.set(d, agg);
    }
    agg.close = r.close;
    agg.high = Math.max(agg.high, r.high);
    agg.low = Math.min(agg.low, r.low);
    agg.n15 += 1;
    // intraday realized variance: squared 15m log-return, only within same day
    if (prevBarClose != null && prevBarDate === d && prevBarClose > 0 && r.close > 0) {
      const lr = Math.log(r.close / prevBarClose);
      agg.rv += lr * lr;
    }
    prevBarClose = r.close;
    prevBarDate = d;
  }
  // sort by date, attach prevClose (daily close-to-close)
  const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  let prevC: number | null = null;
  for (const d of sorted) {
    d.prevClose = prevC;
    prevC = d.close;
  }
  // drop the very first partial day's leading day with no prevClose stays but flagged
  fs.writeFileSync(
    path.join(OUT, "btc_daily.json"),
    JSON.stringify(
      {
        source: "btc_ohlcv_15m.ndjson aggregated to daily UTC",
        nDays: sorted.length,
        firstDate: sorted[0]?.date,
        lastDate: sorted[sorted.length - 1]?.date,
        days: sorted,
      },
      null,
      0,
    ),
  );
  // quick sanity: median bars/day should be ~96
  const counts = sorted.map((d) => d.n15).sort((a, b) => a - b);
  const med = counts[Math.floor(counts.length / 2)];
  console.log(
    JSON.stringify({
      nDays: sorted.length,
      firstDate: sorted[0]?.date,
      lastDate: sorted[sorted.length - 1]?.date,
      medianBarsPerDay: med,
      fullDays: sorted.filter((d) => d.n15 >= 90).length,
    }),
  );
}

main();
