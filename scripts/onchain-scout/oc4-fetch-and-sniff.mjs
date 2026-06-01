/**
 * OC4 — POC fetch + descriptive correlation sniff (NOT a gated edge test).
 *
 * Fetches, at $0 / no key:
 *   - Coin Metrics community: BTC & ETH daily AdrActCnt, FlowInExNtv, FlowOutExNtv, PriceUSD
 *   - DefiLlama: Ethereum chain TVL (daily), total stablecoin circulating USD (daily)
 *   - Santiment free GraphQL: BTC & ETH daily_active_addresses (cross-check vs CM)
 *
 * Then computes weekly (W-MON) returns and asks, descriptively:
 *   Does on-chain feature momentum (Δlog over trailing window) show contemporaneous
 *   or LEADING (feature_t -> return_{t+1week}) correlation with forward BTC/ETH returns?
 *
 * Honest sizing only. Pearson + Spearman, lead/lag, n reported. No p-hacking,
 * no train/test split (that's the real edge test, not this).
 *
 * Run:
 *   node scripts/onchain-scout/oc4-fetch-and-sniff.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('output/onchain-scout/oc4');
fs.mkdirSync(OUT, { recursive: true });

const START = '2021-01-01';
const END = '2024-12-31'; // 4 calendar years of daily data — small, ~1460 rows/series
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

// ---- Coin Metrics community (paged) ----
async function cmSeries(asset, metrics) {
  const rows = [];
  let nextUrl = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}&metrics=${metrics.join(',')}&frequency=1d&start_time=${START}&end_time=${END}&page_size=1000`;
  let pages = 0;
  while (nextUrl && pages < 6) {
    const j = await getJSON(nextUrl);
    for (const d of j.data || []) rows.push(d);
    nextUrl = j.next_page_url || null;
    pages++;
    if (nextUrl) await sleep(120);
  }
  return rows;
}

// ---- DefiLlama ----
async function defillamaEthTVL() {
  const j = await getJSON('https://api.llama.fi/v2/historicalChainTvl/Ethereum');
  return j.map((d) => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), tvl: d.tvl }));
}
async function defillamaStables() {
  const j = await getJSON('https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=1');
  return j.map((d) => ({ date: new Date(Number(d.date) * 1000).toISOString().slice(0, 10), usd: d.totalCirculatingUSD?.peggedUSD ?? null }));
}

// ---- Santiment free ----
async function santimentDAA(slug) {
  const q = `{ getMetric(metric:"daily_active_addresses"){ timeseriesData(slug:"${slug}" from:"${START}T00:00:00Z" to:"${END}T00:00:00Z" interval:"1d"){ datetime value }}}`;
  const j = await getJSON('https://api.santiment.net/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
  });
  return (j.data?.getMetric?.timeseriesData || []).map((d) => ({ date: d.datetime.slice(0, 10), value: d.value }));
}

// ===================== stats helpers =====================
function pearson(a, b) {
  const n = a.length; if (n < 3) return NaN;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const xa = a[i] - ma, xb = b[i] - mb; num += xa * xb; da += xa * xa; db += xb * xb; }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}
function rank(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) r[idx[k][1]] = avg;
    i = j;
  }
  return r;
}
function spearman(a, b) { return pearson(rank(a), rank(b)); }

// weekly resample: take last obs of each ISO-week (W-MON style via Mon anchor)
function toWeekly(series /* [{date, value}] sorted */) {
  const byWeek = new Map();
  for (const { date, value } of series) {
    if (value == null || !isFinite(value)) continue;
    const d = new Date(date + 'T00:00:00Z');
    const day = d.getUTCDay(); // 0 Sun..6 Sat
    const diffToMon = (day + 6) % 7;
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - diffToMon);
    const key = monday.toISOString().slice(0, 10);
    byWeek.set(key, value); // last obs in week wins (iterating ascending)
  }
  return [...byWeek.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([week, value]) => ({ week, value }));
}

function joinWeekly(featWeekly, priceWeekly) {
  const pMap = new Map(priceWeekly.map((r) => [r.week, r.value]));
  const out = [];
  for (const f of featWeekly) {
    if (pMap.has(f.week)) out.push({ week: f.week, feat: f.value, price: pMap.get(f.week) });
  }
  return out;
}

// ===================== main =====================
(async () => {
  const meta = { generatedAt: new Date().toISOString(), window: { START, END }, fetched: {} };

  console.log('Fetching Coin Metrics community (btc, eth)...');
  const cmBtc = await cmSeries('btc', ['AdrActCnt', 'FlowInExNtv', 'FlowOutExNtv', 'PriceUSD']);
  await sleep(150);
  const cmEth = await cmSeries('eth', ['AdrActCnt', 'FlowInExNtv', 'FlowOutExNtv', 'PriceUSD']);
  meta.fetched.cmBtcRows = cmBtc.length; meta.fetched.cmEthRows = cmEth.length;

  console.log('Fetching DefiLlama TVL + stablecoins...');
  const ethTvl = await defillamaEthTVL();
  const stables = await defillamaStables();
  meta.fetched.ethTvlRows = ethTvl.length; meta.fetched.stablesRows = stables.length;

  console.log('Fetching Santiment free DAA (btc, eth)...');
  let sanBtc = [], sanEth = [];
  try { sanBtc = await santimentDAA('bitcoin'); await sleep(150); sanEth = await santimentDAA('ethereum'); }
  catch (e) { console.log('  Santiment fetch warning:', String(e).slice(0, 120)); }
  meta.fetched.sanBtcRows = sanBtc.length; meta.fetched.sanEthRows = sanEth.length;

  // persist raw POC (small samples + counts)
  fs.writeFileSync(path.join(OUT, 'cm-btc-daily.json'), JSON.stringify(cmBtc, null, 0));
  fs.writeFileSync(path.join(OUT, 'cm-eth-daily.json'), JSON.stringify(cmEth, null, 0));
  fs.writeFileSync(path.join(OUT, 'defillama-eth-tvl.json'), JSON.stringify(ethTvl, null, 0));
  fs.writeFileSync(path.join(OUT, 'defillama-stablecoins.json'), JSON.stringify(stables, null, 0));
  fs.writeFileSync(path.join(OUT, 'santiment-daa.json'), JSON.stringify({ btc: sanBtc, eth: sanEth }, null, 0));

  // ---- assemble daily feature frames ----
  const num = (x) => (x == null ? null : Number(x));
  const cmToDaily = (rows) => rows.map((r) => ({
    date: r.time.slice(0, 10),
    AdrActCnt: num(r.AdrActCnt),
    netFlow: (num(r.FlowInExNtv) != null && num(r.FlowOutExNtv) != null) ? num(r.FlowInExNtv) - num(r.FlowOutExNtv) : null, // +ve = net INFLOW to exchanges (bearish proxy)
    PriceUSD: num(r.PriceUSD),
  }));
  const btc = cmToDaily(cmBtc), eth = cmToDaily(cmEth);

  // weekly price series (last obs of week)
  const btcPriceW = toWeekly(btc.map((d) => ({ date: d.date, value: d.PriceUSD })));
  const ethPriceW = toWeekly(eth.map((d) => ({ date: d.date, value: d.PriceUSD })));

  // forward weekly log returns: ret_{t} = log(P_{t+1}/P_t) aligned at week t (so feature at t -> return realized t->t+1)
  function fwdReturns(priceW) {
    const out = [];
    for (let i = 0; i < priceW.length - 1; i++) {
      out.push({ week: priceW[i].week, fwdRet: Math.log(priceW[i + 1].value / priceW[i].value) });
    }
    return out;
  }
  const btcFwd = fwdReturns(btcPriceW), ethFwd = fwdReturns(ethPriceW);

  // build feature weeklies: use trailing 1-week Δlog (momentum) of each feature
  function featMomentumWeekly(daily, key) {
    const w = toWeekly(daily.map((d) => ({ date: d.date, value: d[key] })));
    const out = [];
    for (let i = 1; i < w.length; i++) {
      const prev = w[i - 1].value, cur = w[i].value;
      if (prev > 0 && cur > 0) out.push({ week: w[i].week, value: Math.log(cur / prev) });
    }
    return out;
  }
  // net exchange flow level (signed, native units) weekly-averaged
  function netFlowWeekly(daily) {
    return toWeekly(daily.map((d) => ({ date: d.date, value: d.netFlow })));
  }

  const stablesGrowthW = featMomentumWeekly(stables.map((s) => ({ date: s.date, usd: s.usd })), 'usd');
  const ethTvlMomW = featMomentumWeekly(ethTvl.map((t) => ({ date: t.date, tvl: t.tvl })), 'tvl');

  const features = {
    btc: {
      activeAddrMom: featMomentumWeekly(btc, 'AdrActCnt'),
      exchNetFlow: netFlowWeekly(btc),
    },
    eth: {
      activeAddrMom: featMomentumWeekly(eth, 'AdrActCnt'),
      exchNetFlow: netFlowWeekly(eth),
    },
    macro: {
      stablecoinSupplyGrowth: stablesGrowthW,
      ethTvlMomentum: ethTvlMomW,
    },
  };

  // ---- correlation sniff: feature_t vs fwdRet_t (lead) AND vs same-week return (contemporaneous) ----
  function corrAt(featWeekly, fwd, lag) {
    // lag=0 -> feature at week t vs fwdRet realized t->t+1 (LEADING by construction)
    // lag=-1 -> feature shifted so it's contemporaneous with the realized return week
    const fwdMap = new Map(fwd.map((r) => [r.week, r.fwdRet]));
    const weeks = featWeekly.map((f) => f.week);
    const a = [], b = [];
    for (const f of featWeekly) {
      // shift feature week by `lag` weeks (7*lag days) to test lead/lag
      const d = new Date(f.week + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * lag);
      const wk = d.toISOString().slice(0, 10);
      if (fwdMap.has(wk)) { a.push(f.value); b.push(fwdMap.get(wk)); }
    }
    if (a.length < 10) return { n: a.length, pearson: NaN, spearman: NaN };
    return { n: a.length, pearson: +pearson(a, b).toFixed(4), spearman: +spearman(a, b).toFixed(4) };
  }

  const sniff = [];
  const tests = [
    ['BTC activeAddr momentum -> BTC fwd wk ret', features.btc.activeAddrMom, btcFwd],
    ['BTC exch netFlow(level) -> BTC fwd wk ret', features.btc.exchNetFlow, btcFwd],
    ['ETH activeAddr momentum -> ETH fwd wk ret', features.eth.activeAddrMom, ethFwd],
    ['ETH exch netFlow(level) -> ETH fwd wk ret', features.eth.exchNetFlow, ethFwd],
    ['Stablecoin supply growth -> BTC fwd wk ret', features.macro.stablecoinSupplyGrowth, btcFwd],
    ['Stablecoin supply growth -> ETH fwd wk ret', features.macro.stablecoinSupplyGrowth, ethFwd],
    ['ETH TVL momentum -> ETH fwd wk ret', features.macro.ethTvlMomentum, ethFwd],
    ['ETH TVL momentum -> BTC fwd wk ret', features.macro.ethTvlMomentum, btcFwd],
  ];
  for (const [label, feat, fwd] of tests) {
    sniff.push({
      test: label,
      lead_t_to_tp1: corrAt(feat, fwd, 0),        // feature at t vs return t->t+1 (genuine lead)
      contemporaneous: corrAt(feat, fwd, -1),     // feature at t vs return (t-1)->t (same realized week)
      lead_2wk: corrAt(feat, fwd, 1),             // feature at t vs return t+1->t+2 (2-wk lead)
    });
  }

  const report = { ...meta, weeklyCounts: { btcFwd: btcFwd.length, ethFwd: ethFwd.length }, sniff };
  fs.writeFileSync(path.join(OUT, 'sniff-results.json'), JSON.stringify(report, null, 2));

  console.log('\n========== DESCRIPTIVE CORRELATION SNIFF (honest, preliminary) ==========');
  console.log('Convention: "lead_t_to_tp1" = feature at week t vs return realized t -> t+1 (genuine 1wk LEAD).');
  console.log('Pearson | Spearman | n\n');
  for (const s of sniff) {
    const L = s.lead_t_to_tp1, C = s.contemporaneous, L2 = s.lead_2wk;
    console.log(s.test);
    console.log(`   lead 1wk:   r=${String(L.pearson).padStart(7)}  rho=${String(L.spearman).padStart(7)}  n=${L.n}`);
    console.log(`   contemp:    r=${String(C.pearson).padStart(7)}  rho=${String(C.spearman).padStart(7)}  n=${C.n}`);
    console.log(`   lead 2wk:   r=${String(L2.pearson).padStart(7)}  rho=${String(L2.spearman).padStart(7)}  n=${L2.n}`);
  }
  console.log(`\nSaved sniff-results.json + raw POC series to ${OUT}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
