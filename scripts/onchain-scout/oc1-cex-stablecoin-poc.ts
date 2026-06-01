/**
 * TRACK OC1 — CEX flow + STABLECOIN supply/flow source feasibility POC.
 *
 * Goal: PROVE (not describe) which crypto flow/on-chain proxies are obtainable
 * at $0 with NO paid tier and NO BigQuery. Hits live public REST endpoints,
 * saves SMALL real samples to output/onchain-scout/oc1/, and prints a summary.
 *
 * Run:
 *   node_modules/.bin/tsx scripts/onchain-scout/oc1-cex-stablecoin-poc.ts
 *
 * Sources tested:
 *   1. DefiLlama stablecoins  (FREE, no key)  -> macro 'dry powder' supply flow
 *   2. CoinGecko free         (FREE, no key, HARD rate-limited) -> circ supply snapshot
 *   3. Binance / Bybit / OKX public (FREE, no key) -> funding + open interest context
 *   4. Blockchain.com charts  (FREE, no key)  -> BTC on-chain activity (bonus)
 *   5. Glassnode / CryptoQuant exchange-netflow -> verified PAID (401 without key)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? resolve(HERE, "../..");
const OUT_DIR = join(ROOT, "output/onchain-scout/oc1");
mkdirSync(OUT_DIR, { recursive: true });

type ProbeResult = {
  source: string;
  url: string;
  access: "no-key-free" | "free-signup-key" | "paid";
  httpStatus: number | "ERR";
  ok: boolean;
  rows?: number;
  granularity?: string;
  firstDate?: string;
  lastDate?: string;
  note: string;
};

const results: ProbeResult[] = [];
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const isoMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, timeoutMs = 30000): Promise<{ status: number | "ERR"; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: "ERR", body: { error: String(e) } };
  } finally {
    clearTimeout(t);
  }
}

function save(name: string, data: unknown) {
  writeFileSync(join(OUT_DIR, name), JSON.stringify(data, null, 2));
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1. DefiLlama stablecoins — TOTAL stablecoin supply history (dry powder flow)
  // ---------------------------------------------------------------------------
  {
    const url = "https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=1"; // USDT slice of "all" chart
    const totalUrl = "https://stablecoins.llama.fi/stablecoincharts/all";
    const { status, body } = await getJson(totalUrl);
    const ok = status === 200 && Array.isArray(body) && body.length > 0;
    if (ok) {
      // Each row: { date: "<unix sec str>", totalCirculating:{peggedUSD}, totalCirculatingUSD:{peggedUSD} }
      const rows = body.map((d: any) => ({
        date: iso(Number(d.date)),
        ts: Number(d.date),
        totalCirculatingUSD: d.totalCirculatingUSD?.peggedUSD ?? null,
      }));
      // keep a small sample: first 5, last 60 (proves history depth + recency w/o huge file)
      const sample = [...rows.slice(0, 5), ...rows.slice(-60)];
      save("defillama_total_stablecoin_supply_sample.json", sample);
      results.push({
        source: "DefiLlama stablecoincharts/all (TOTAL supply)",
        url: totalUrl,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "daily",
        firstDate: rows[0].date,
        lastDate: rows[rows.length - 1].date,
        note: `Total stablecoin mcap dry-powder flow. Latest=$${(rows[rows.length - 1].totalCirculatingUSD / 1e9).toFixed(1)}B`,
      });
    } else {
      results.push({
        source: "DefiLlama stablecoincharts/all (TOTAL supply)",
        url: totalUrl,
        access: "no-key-free",
        httpStatus: status,
        ok,
        note: "FAILED",
      });
    }
    void url;
  }

  // 1b. DefiLlama per-stablecoin circulating supply over time (USDT id=1, USDC id=2)
  for (const [id, label] of [["1", "USDT"], ["2", "USDC"]] as const) {
    const url = `https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=${id}`;
    const { status, body } = await getJson(url);
    const ok = status === 200 && Array.isArray(body) && body.length > 0;
    if (ok) {
      const rows = body.map((d: any) => ({
        date: iso(Number(d.date)),
        circulatingUSD: d.totalCirculatingUSD?.peggedUSD ?? null,
      }));
      save(`defillama_${label.toLowerCase()}_supply_sample.json`, [
        ...rows.slice(0, 5),
        ...rows.slice(-40),
      ]);
      results.push({
        source: `DefiLlama per-stablecoin supply (${label})`,
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "daily",
        firstDate: rows[0].date,
        lastDate: rows[rows.length - 1].date,
        note: `${label} circulating over time. Latest=$${(rows[rows.length - 1].circulatingUSD / 1e9).toFixed(1)}B`,
      });
    } else {
      results.push({
        source: `DefiLlama per-stablecoin supply (${label})`,
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        note: "FAILED",
      });
    }
    await sleep(300);
  }

  // ---------------------------------------------------------------------------
  // 2. CoinGecko — circulating supply snapshot (HARD rate-limited; space calls)
  // ---------------------------------------------------------------------------
  {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=tether,usd-coin,dai&order=market_cap_desc";
    const { status, body } = await getJson(url);
    const ok = status === 200 && Array.isArray(body) && body.length > 0;
    if (ok) {
      const rows = body.map((c: any) => ({
        id: c.id,
        symbol: c.symbol,
        circulating_supply: c.circulating_supply,
        market_cap: c.market_cap,
        last_updated: c.last_updated,
      }));
      save("coingecko_stablecoin_circ_supply_snapshot.json", rows);
      results.push({
        source: "CoinGecko /coins/markets (circ supply snapshot)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "snapshot (current)",
        note: "circulating_supply is CURRENT only; historical supply NOT on free tier (only price/mcap via market_chart).",
      });
    } else {
      results.push({
        source: "CoinGecko /coins/markets (circ supply snapshot)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        note: status === 429 ? "RATE-LIMITED (429) — free tier ~5-15 req/min" : "FAILED",
      });
    }
  }

  // 2b. CoinGecko market_chart — price/mcap history (proves history depth, but mcap≈supply for stablecoin)
  await sleep(8000); // respect harsh free-tier limit
  {
    const url =
      "https://api.coingecko.com/api/v3/coins/tether/market_chart?vs_currency=usd&days=90&interval=daily";
    const { status, body } = await getJson(url);
    const ok = status === 200 && body?.market_caps?.length > 0;
    if (ok) {
      const caps: [number, number][] = body.market_caps;
      const rows = caps.map(([ms, v]) => ({ date: isoMs(ms), market_cap: v }));
      save("coingecko_tether_marketcap_history_sample.json", [
        ...rows.slice(0, 3),
        ...rows.slice(-30),
      ]);
      results.push({
        source: "CoinGecko /coins/tether/market_chart (mcap history)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "daily",
        firstDate: rows[0].date,
        lastDate: rows[rows.length - 1].date,
        note: "Free tier caps history window (~365d max, 'days' beyond limit downgrades granularity). mcap≈supply for a $1 peg.",
      });
    } else {
      results.push({
        source: "CoinGecko /coins/tether/market_chart (mcap history)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        note: status === 429 ? "RATE-LIMITED (429)" : "FAILED",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. CEX public — funding + open interest (sell/hold-pressure context)
  // ---------------------------------------------------------------------------
  {
    const url = "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=50";
    const { status, body } = await getJson(url);
    const ok = status === 200 && Array.isArray(body) && body.length > 0;
    if (ok) {
      const rows = body.map((r: any) => ({
        time: isoMs(r.fundingTime),
        fundingRate: Number(r.fundingRate),
      }));
      save("binance_funding_btcusdt_sample.json", rows);
      results.push({
        source: "Binance fapi fundingRate (BTCUSDT)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "8h",
        firstDate: rows[0].time,
        lastDate: rows[rows.length - 1].time,
        note: "Funding history, no key. Long lookback via startTime/endTime paging.",
      });
    } else {
      results.push({ source: "Binance fapi fundingRate", url, access: "no-key-free", httpStatus: status, ok, note: "FAILED" });
    }
  }
  {
    const url = "https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=30";
    const { status, body } = await getJson(url);
    const ok = status === 200 && Array.isArray(body) && body.length > 0;
    if (ok) {
      const rows = body.map((r: any) => ({
        time: isoMs(r.timestamp),
        sumOpenInterest: Number(r.sumOpenInterest),
        sumOpenInterestValue: Number(r.sumOpenInterestValue),
      }));
      save("binance_open_interest_btcusdt_sample.json", rows);
      results.push({
        source: "Binance futures/data openInterestHist (BTCUSDT)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "1d (also 5m/15m/30m/1h/2h/4h/6h/12h)",
        firstDate: rows[0].time,
        lastDate: rows[rows.length - 1].time,
        note: "OI history LIMITED to last ~30 days on this endpoint (free).",
      });
    } else {
      results.push({ source: "Binance openInterestHist", url, access: "no-key-free", httpStatus: status, ok, note: "FAILED" });
    }
  }
  {
    const url = "https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=50";
    const { status, body } = await getJson(url);
    const list = body?.result?.list;
    const ok = status === 200 && Array.isArray(list) && list.length > 0;
    if (ok) {
      const rows = list.map((r: any) => ({
        time: isoMs(Number(r.fundingRateTimestamp)),
        fundingRate: Number(r.fundingRate),
      }));
      save("bybit_funding_btcusdt_sample.json", rows);
      results.push({
        source: "Bybit v5 funding/history (BTCUSDT)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "8h",
        firstDate: rows[rows.length - 1].time,
        lastDate: rows[0].time,
        note: "Funding history, no key.",
      });
    } else {
      results.push({ source: "Bybit funding/history", url, access: "no-key-free", httpStatus: status, ok, note: "FAILED" });
    }
  }
  {
    const url = "https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=50";
    const { status, body } = await getJson(url);
    const data = body?.data;
    const ok = status === 200 && Array.isArray(data) && data.length > 0;
    if (ok) {
      const rows = data.map((r: any) => ({
        time: isoMs(Number(r.fundingTime)),
        fundingRate: Number(r.fundingRate),
        realizedRate: Number(r.realizedRate),
      }));
      save("okx_funding_btcusdtswap_sample.json", rows);
      results.push({
        source: "OKX v5 funding-rate-history (BTC-USDT-SWAP)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "8h",
        firstDate: rows[rows.length - 1].time,
        lastDate: rows[0].time,
        note: "Funding history, no key.",
      });
    } else {
      results.push({ source: "OKX funding-rate-history", url, access: "no-key-free", httpStatus: status, ok, note: "FAILED" });
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Blockchain.com charts — BONUS free no-key BTC on-chain activity
  // ---------------------------------------------------------------------------
  {
    const url = "https://api.blockchain.info/charts/n-unique-addresses?timespan=180days&format=json&cors=true";
    const { status, body } = await getJson(url);
    const vals = body?.values;
    const ok = status === 200 && Array.isArray(vals) && vals.length > 0;
    if (ok) {
      const rows = vals.map((v: any) => ({ date: iso(v.x), value: v.y }));
      save("blockchaincom_btc_unique_addresses_sample.json", [...rows.slice(0, 3), ...rows.slice(-30)]);
      results.push({
        source: "Blockchain.com charts n-unique-addresses (BTC)",
        url,
        access: "no-key-free",
        httpStatus: status,
        ok,
        rows: rows.length,
        granularity: "daily",
        firstDate: rows[0].date,
        lastDate: rows[rows.length - 1].date,
        note: "BONUS on-chain activity proxy, no key. timespan up to 'all' (~2009-now). Many charts (n-transactions, tx-volume-usd, etc).",
      });
    } else {
      results.push({ source: "Blockchain.com charts", url, access: "no-key-free", httpStatus: status, ok, note: "FAILED" });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Glassnode / CryptoQuant exchange-netflow — VERIFY paid
  // ---------------------------------------------------------------------------
  {
    const url = "https://api.glassnode.com/v1/metrics/transactions/transfers_volume_to_exchanges_sum?a=BTC";
    const { status } = await getJson(url, 15000);
    results.push({
      source: "Glassnode exchange-inflow metric",
      url,
      access: "paid",
      httpStatus: status,
      ok: false,
      note: "401 without key. Exchange netflow requires PAID plan (free tier extremely limited, key-gated).",
    });
  }
  {
    const url = "https://api.cryptoquant.com/v1/btc/exchange-flows/netflow?window=day";
    const { status } = await getJson(url, 15000);
    results.push({
      source: "CryptoQuant exchange-flows netflow",
      url,
      access: "paid",
      httpStatus: status,
      ok: false,
      note: "401 without Bearer key. Exchange netflow is PAID (Pro plan). No free programmatic netflow.",
    });
  }

  // ---------------------------------------------------------------------------
  save("_probe_summary.json", { generatedAt: new Date().toISOString(), results });

  // Console report
  console.log("\n================ OC1 SOURCE FEASIBILITY (live) ================");
  for (const r of results) {
    const flag = r.ok ? "OK " : r.access === "paid" ? "PAID" : "XX ";
    console.log(
      `[${flag}] ${r.source}\n     access=${r.access} http=${r.httpStatus}` +
        (r.rows != null ? ` rows=${r.rows}` : "") +
        (r.granularity ? ` gran=${r.granularity}` : "") +
        (r.firstDate ? ` range=${r.firstDate}..${r.lastDate}` : "") +
        `\n     ${r.note}`,
    );
  }
  console.log("\nFiles written to:", OUT_DIR);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

export {};
