/**
 * D2 edge-hunt $0 data fetcher.
 *
 * Binance klines array index 9 = takerBuyBaseVolume. This decomposition is
 * FREE and FULL-HISTORY (built server-side from aggTrades). It gives signed
 * taker flow (CVD) at $0 without fetching years of raw aggTrades.
 *
 *   takerBuyBase  = aggressor-buy volume in the bar
 *   takerSellBase = totalVolume - takerBuyBase
 *   signedFlow    = takerBuyBase - takerSellBase   (the "volume delta")
 *
 * We pull:
 *   - daily BTC klines 2017->now (spot)  -> output/edgehunt-D2/btc_daily_flow.json
 *   - 15m  BTC klines for a recent ~2yr window (for finer-grain VPIN/intrabar
 *     flow), then we will aggregate to daily before any gate (>100k guard).
 */
import { writeFileSync } from "node:fs";

const OUT = "output/edgehunt-D2";

interface Bar {
  t: number; // open time ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
  tbb: number; // taker buy base volume
  n: number; // trade count
}

async function fetchKlines(
  symbol: string,
  interval: string,
  startMs: number,
  base = "https://api.binance.com/api/v3/klines",
): Promise<Bar[]> {
  const out: Bar[] = [];
  let cursor = startMs;
  for (let page = 0; page < 5000; page += 1) {
    const url = `${base}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
        tbb: Number(r[9]),
        n: Number(r[8]),
      });
    }
    const last = Number(rows[rows.length - 1][0]);
    if (rows.length < 1000) break;
    cursor = last + 1;
    await new Promise((res) => setTimeout(res, 120));
  }
  // dedupe by open time
  const seen = new Set<number>();
  return out.filter((b) => (seen.has(b.t) ? false : (seen.add(b.t), true)));
}

async function main() {
  const start2017 = Date.UTC(2017, 7, 17);
  console.log("fetching daily BTC flow...");
  const daily = await fetchKlines("BTCUSDT", "1d", start2017);
  writeFileSync(`${OUT}/btc_daily_flow.json`, JSON.stringify(daily));
  console.log(
    `daily: ${daily.length} bars ${new Date(daily[0].t).toISOString().slice(0, 10)} -> ${new Date(daily[daily.length - 1].t).toISOString().slice(0, 10)}`,
  );

  // 15m for last ~2.2yr (≈ 77k bars < 100k) for VPIN / intrabar location flow.
  const start15 = Date.UTC(2024, 0, 1);
  console.log("fetching 15m BTC flow (2024->now)...");
  const m15 = await fetchKlines("BTCUSDT", "15m", start15);
  writeFileSync(`${OUT}/btc_15m_flow.json`, JSON.stringify(m15));
  console.log(`15m: ${m15.length} bars`);

  // Also grab ETH/SOL/BNB daily flow for any cross-asset robustness check.
  for (const sym of ["ETHUSDT", "SOLUSDT", "BNBUSDT"]) {
    const d = await fetchKlines(sym, "1d", start2017);
    writeFileSync(`${OUT}/${sym}_daily_flow.json`, JSON.stringify(d));
    console.log(`${sym}: ${d.length} daily bars`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
