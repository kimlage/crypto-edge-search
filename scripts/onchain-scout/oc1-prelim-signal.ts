/**
 * OC1 PRELIMINARY descriptive signal check (NOT an edge test).
 *
 * Mechanism under test: stablecoin TOTAL supply growth = capital entering crypto
 * ("dry powder"). Question: does week-over-week stablecoin supply growth associate
 * with BTC forward returns? This is a quick, honest correlation sanity check on
 * FREE data only — no transaction costs, no train/test split, no significance
 * machinery. Purely to show the join is feasible and whether any signal smell exists.
 *
 * Data (all $0, no key):
 *   - DefiLlama stablecoincharts/all   -> daily total stablecoin USD supply
 *   - Binance spot klines BTCUSDT 1d   -> daily BTC close
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return num / Math.sqrt(da * db);
}

async function main() {
  // 1. Stablecoin total supply (daily) -> map date->supply
  const sc = await getJson("https://stablecoins.llama.fi/stablecoincharts/all");
  const supplyByDate = new Map<string, number>();
  for (const d of sc) {
    const date = new Date(Number(d.date) * 1000).toISOString().slice(0, 10);
    supplyByDate.set(date, d.totalCirculatingUSD?.peggedUSD ?? NaN);
  }

  // 2. BTC daily close from Binance spot — page back ~1000 days (free, no key)
  const closeByDate = new Map<string, number>();
  let endTime = Date.now();
  for (let page = 0; page < 4; page++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000&endTime=${endTime}`;
    const kl = await getJson(url);
    if (!Array.isArray(kl) || kl.length === 0) break;
    for (const k of kl) {
      const date = new Date(k[0]).toISOString().slice(0, 10);
      closeByDate.set(date, Number(k[4]));
    }
    endTime = kl[0][0] - 1; // page older
    await sleep(250);
  }

  // 3. Build aligned daily series where both exist, sorted by date
  const dates = [...closeByDate.keys()].filter((d) => supplyByDate.has(d)).sort();
  const supply = dates.map((d) => supplyByDate.get(d)!);
  const close = dates.map((d) => closeByDate.get(d)!);

  // 4. Weekly (7d) stablecoin supply growth -> BTC forward 7d return.
  const H = 7;
  const x: number[] = []; // stablecoin 7d growth at t
  const y: number[] = []; // BTC return t..t+H
  for (let t = H; t + H < dates.length; t++) {
    const scGrowth = (supply[t] - supply[t - H]) / supply[t - H];
    const fwdRet = (close[t + H] - close[t]) / close[t];
    if (Number.isFinite(scGrowth) && Number.isFinite(fwdRet)) {
      x.push(scGrowth);
      y.push(fwdRet);
    }
  }

  const corr = pearson(x, y);

  // 5. Tercile lens: forward return when supply growth is high vs low
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const terc = Math.floor(idx.length / 3);
  const lowFwd = idx.slice(0, terc).map((i) => y[i]);
  const highFwd = idx.slice(-terc).map((i) => y[i]);
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  console.log("\n===== OC1 PRELIMINARY SIGNAL (descriptive, NOT an edge test) =====");
  console.log(`Aligned daily observations: ${dates.length}  (${dates[0]} .. ${dates[dates.length - 1]})`);
  console.log(`Paired samples (7d sc-growth -> BTC fwd 7d ret): ${x.length}`);
  console.log(`Pearson corr(stablecoin 7d supply growth, BTC fwd 7d return) = ${corr.toFixed(4)}`);
  console.log(`Mean BTC fwd 7d return | LOW supply-growth tercile  = ${(mean(lowFwd) * 100).toFixed(2)}%`);
  console.log(`Mean BTC fwd 7d return | HIGH supply-growth tercile = ${(mean(highFwd) * 100).toFixed(2)}%`);
  console.log(`Spread (HIGH - LOW) = ${((mean(highFwd) - mean(lowFwd)) * 100).toFixed(2)} pct-pts`);
  console.log("\nCaveat: in-sample, no costs, no CV, single horizon. Directional smell only.");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

export {};
