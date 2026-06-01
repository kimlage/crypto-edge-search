/**
 * OC2 — PRELIMINARY descriptive signal check (NOT an edge test).
 * Fetches BTC daily PriceUSD + CapMVRVCur + AdrActCnt (free Coin Metrics Community)
 * 2014-01-01 .. 2024-12-31, and checks whether simple on-chain signals
 * line up with forward 30d returns. Honest, descriptive, in-sample only.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cm(metrics: string, start: string, end: string) {
  const rows: any[] = [];
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=${metrics}&frequency=1d&start_time=${start}&end_time=${end}&page_size=10000`;
  let p = 0;
  while (url && p < 20) {
    const res = await fetch(url);
    const j: any = await res.json();
    if (!j?.data) break;
    rows.push(...j.data);
    url = j.next_page_url ?? "";
    p++;
    if (url) await sleep(200);
  }
  return rows;
}

function pearson(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const xa = a[i] - ma, xb = b[i] - mb; num += xa * xb; da += xa * xa; db += xb * xb; }
  return num / Math.sqrt(da * db);
}

async function main() {
  const rows = await cm("PriceUSD,CapMVRVCur,AdrActCnt", "2014-01-01", "2024-12-31");
  console.log("fetched rows:", rows.length, "first:", rows[0]?.time?.slice(0, 10), "last:", rows[rows.length - 1]?.time?.slice(0, 10));
  const clean = rows
    .map((r) => ({ t: r.time.slice(0, 10), p: +r.PriceUSD, mvrv: +r.CapMVRVCur, adr: +r.AdrActCnt }))
    .filter((r) => isFinite(r.p) && isFinite(r.mvrv) && isFinite(r.adr) && r.p > 0);
  console.log("clean rows:", clean.length);

  const H = 30;
  const fwd: number[] = [], mvrv: number[] = [], adrZ: number[] = [];
  // 90d rolling z-score of active addresses
  for (let i = 90; i + H < clean.length; i++) {
    const win = clean.slice(i - 90, i).map((r) => r.adr);
    const m = win.reduce((s, x) => s + x, 0) / win.length;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / win.length);
    const z = sd > 0 ? (clean[i].adr - m) / sd : 0;
    const r = clean[i + H].p / clean[i].p - 1;
    fwd.push(r); mvrv.push(clean[i].mvrv); adrZ.push(z);
  }
  console.log("\nsample pairs:", fwd.length);
  console.log("corr( MVRV , fwd30d ret )      =", pearson(mvrv, fwd).toFixed(4));
  console.log("corr( AdrAct 90d z , fwd30d ret)=", pearson(adrZ, fwd).toFixed(4));

  // Quintile of MVRV -> mean forward return (classic cost-basis view)
  const idx = mvrv.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const q = Math.floor(idx.length / 5);
  console.log("\nMVRV quintile -> mean fwd 30d return:");
  for (let k = 0; k < 5; k++) {
    const seg = idx.slice(k * q, k === 4 ? idx.length : (k + 1) * q);
    const mean = seg.reduce((s, [, i]) => s + fwd[i], 0) / seg.length;
    console.log(`  Q${k + 1} (MVRV ${seg[0][0].toFixed(2)}..${seg[seg.length - 1][0].toFixed(2)}): mean=${(mean * 100).toFixed(2)}%  n=${seg.length}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

export {};
