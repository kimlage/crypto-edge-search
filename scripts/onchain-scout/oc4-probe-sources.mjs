/**
 * OC4 — Aggregator free-tier LIVE probe.
 * Hits each source's live endpoint at $0 (no key) and records the raw HTTP result
 * so we can PROVE (not describe) what is genuinely free right now.
 *
 * Run:
 *   node scripts/onchain-scout/oc4-probe-sources.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('output/onchain-scout/oc4');
fs.mkdirSync(OUT, { recursive: true });

const TIMEOUT_MS = 25000;

async function probe(name, { url, method = 'GET', headers = {}, body = null }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    clearTimeout(t);
    const text = await res.text();
    const rateHeaders = {};
    for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'x-ratelimit-plan']) {
      const v = res.headers.get(h);
      if (v) rateHeaders[h] = v;
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-json */ }
    const hasData = parsed && (parsed.data || parsed.result || Array.isArray(parsed));
    const hasErr = parsed && (parsed.error || parsed.errors);
    return {
      source: name, url, method, http: res.status, ok: res.ok,
      ms: Date.now() - started,
      rateHeaders,
      sample: text.slice(0, 700),
      verdict: res.ok && hasData && !hasErr ? 'FREE_NO_KEY'
             : (res.status === 401 || res.status === 403) ? 'NEEDS_KEY'
             : (hasErr ? 'ERROR_RESPONSE' : `HTTP_${res.status}`),
    };
  } catch (e) {
    clearTimeout(t);
    return { source: name, url, method, http: 0, ok: false, ms: Date.now() - started, error: String(e), verdict: 'NETWORK_FAIL' };
  }
}

const probes = [
  ['CoinMetrics-community', { url: 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=AdrActCnt,FlowInExNtv,FlowOutExNtv,PriceUSD&frequency=1d&start_time=2024-01-01&end_time=2024-01-05&page_size=5' }],
  ['DefiLlama-chainTVL', { url: 'https://api.llama.fi/v2/historicalChainTvl/Ethereum' }],
  ['DefiLlama-stablecoins', { url: 'https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=1' }],
  ['Santiment-free-DAA', { url: 'https://api.santiment.net/graphql', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ getMetric(metric:"daily_active_addresses"){ timeseriesData(slug:"bitcoin" from:"2024-01-01T00:00:00Z" to:"2024-01-05T00:00:00Z" interval:"1d"){ datetime value }}}' }) }],
  ['Santiment-gated-MVRV', { url: 'https://api.santiment.net/graphql', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ getMetric(metric:"mvrv_usd"){ timeseriesData(slug:"bitcoin" from:"2020-01-01T00:00:00Z" to:"2020-01-05T00:00:00Z" interval:"1d"){ datetime value }}}' }) }],
  ['Messari-legacy-data.messari.io', { url: 'https://data.messari.io/api/v1/assets/bitcoin/metrics' }],
  ['Messari-api.messari.io', { url: 'https://api.messari.io/marketdata/v1/assets/metrics' }],
  ['Bitquery-graphql.bitquery.io', { url: 'https://graphql.bitquery.io', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ ethereum(network: ethereum) { blocks(options: {limit: 2}) { height } } }' }) }],
  ['Bitquery-streaming', { url: 'https://streaming.bitquery.io/graphql', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ EVM(network: eth) { Blocks(limit: {count: 2}) { Block { Number } } } }' }) }],
  ['Glassnode-public', { url: 'https://api.glassnode.com/v1/metrics/addresses/active_count?a=BTC&i=24h' }],
  ['CryptoQuant', { url: 'https://api.cryptoquant.com/v1/btc/exchange-flows/inflow?window=day&limit=3' }],
];

const results = [];
for (const [name, cfg] of probes) {
  const r = await probe(name, cfg);
  results.push(r);
  console.log(`${r.verdict.padEnd(14)} [${String(r.http).padStart(3)}] ${name} (${r.ms}ms)`);
}

fs.writeFileSync(path.join(OUT, 'source-probe-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`\nSaved ${results.length} probe results to ${path.join(OUT, 'source-probe-results.json')}`);
