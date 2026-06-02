/**
 * Fetch Deribit public DVOL (implied vol index) daily history for BTC + ETH.
 * No API key. Pages backward via `continuation` token (max 1000 rows/request).
 * Caches to output/edgehunt/dvol_{btc,eth}.json so we never re-fetch.
 *
 * DVOL row format: [timestamp_ms, open, high, low, close]  (annualized IV in %)
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import https from "node:https";

interface DvolRow {
  date: string; // YYYY-MM-DD (UTC day of timestamp)
  ts: number; // ms
  open: number;
  high: number;
  low: number;
  close: number; // DVOL close (annualized IV %)
}

function get(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchCurrency(currency: "BTC" | "ETH"): Promise<DvolRow[]> {
  const out = new Map<number, DvolRow>();
  // page backward from now until we reach the start of DVOL history
  let endTs = Date.now();
  const hardStart = new Date("2020-01-01").getTime();
  for (let page = 0; page < 30; page++) {
    const startTs = hardStart;
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${startTs}&end_timestamp=${endTs}&resolution=86400`;
    const j = await get(url);
    const result = j?.result;
    if (!result?.data?.length) break;
    for (const r of result.data as number[][]) {
      const ts = r[0];
      out.set(ts, {
        date: new Date(ts).toISOString().slice(0, 10),
        ts,
        open: r[1],
        high: r[2],
        low: r[3],
        close: r[4],
      });
    }
    const cont = result.continuation;
    if (!cont || cont <= hardStart) break;
    endTs = cont; // page further back
    await sleep(250);
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

async function main() {
  for (const cur of ["BTC", "ETH"] as const) {
    const path = `output/edgehunt/dvol_${cur.toLowerCase()}.json`;
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, "utf8")) as DvolRow[];
      console.log(`${cur}: cached ${cached.length} rows ${cached[0]?.date}..${cached.at(-1)?.date}`);
      continue;
    }
    const rows = await fetchCurrency(cur);
    writeFileSync(path, JSON.stringify(rows));
    console.log(`${cur}: fetched ${rows.length} rows ${rows[0]?.date}..${rows.at(-1)?.date} -> ${path}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
